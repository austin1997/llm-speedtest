import { describeError, LocalizedError, msg } from '../i18n/message';
import { estimateTokens, tokenWeight } from './prompt';
import { streamCompletion } from './protocol';
import { liveRate, outputCount, streamTokenCount } from './metrics';
import { counterSource, LiveTokenCounter, TokenCountPool } from './token-counter';
import type { BenchmarkConfig, EndpointConfig, RequestResult, RunState } from './types';

export function startBenchmark(
  config: BenchmarkConfig, endpoints: EndpointConfig[], prompt: string,
  onUpdate: (state: RunState) => void,
  dependencies: { clock?: () => number; fetcher?: typeof fetch } = {},
): { cancel: () => void; finished: Promise<RunState> } {
  const clock = dependencies.clock ?? (() => performance.now());
  const targets = endpoints.map(endpoint => ({ ...endpoint }));
  const settings = { ...config };
  const raceOutput = { A: 0, B: 0 };
  const raceBudget = settings.outputTokens * settings.concurrency;
  const contributions = new Map<string, number>();
  const pools = new Map(targets.flatMap(endpoint => endpoint.protocol === 'openai' && endpoint.useTokenApi !== false && endpoint.tokenCounter ? [[endpoint.id, new TokenCountPool(endpoint, endpoint.tokenCounter, dependencies.fetcher)] as const] : []));
  const controllers: AbortController[] = [];
  let cancelling = false;
  const state: RunState = {
    phase: 'running', config: settings, endpoints: targets.map(e => ({ ...e, apiKey: '' })), prompt,
    startedAt: clock(), now: clock(), history: [], raceDistance: { A: 0, B: 0 },
    requests: targets.flatMap(e => Array.from({ length: settings.concurrency }, (_, i): RequestResult => ({
      id: `${e.id}-${i + 1}`, endpointId: e.id, index: i + 1, status: 'pending', text: '',
      startedAt: null, firstAt: null, lastTextAt: null, endedAt: null, firstTokens: 0, estimatedTokens: 0, samples: [],
    }))),
  };
  const snapshot = (): RunState => ({ ...state, raceDistance: { ...state.raceDistance }, history: [...state.history], requests: state.requests.map(r => ({ ...r, samples: r.samples.map(sample => ({ ...sample })) })) });
  const advanceCar = (request: RequestResult) => {
    const id = request.endpointId;
    const tokens = (request.endedAt === null ? streamTokenCount(request) : outputCount(request)).value!;
    raceOutput[id] += tokens - (contributions.get(request.id) ?? 0);
    contributions.set(request.id, tokens);
    state.raceDistance[id] = Math.min(raceBudget, Math.max(state.raceDistance[id], raceOutput[id]));
  };
  const finishRace = (endpointId: EndpointConfig['id'], at: number) => {
    if (targets.length === 2 && !state.raceWinner) state.raceWinner = { endpointId, at };
  };
  const publish = () => { state.now = state.requests.length > 0 && state.requests.every(r => r.endedAt !== null) ? Math.max(...state.requests.map(r => r.endedAt!)) : clock(); onUpdate(snapshot()); };
  let lastHistory = -Infinity;
  const ticker = setInterval(() => {
    const now = clock();
    if (state.requests.some(r => r.endedAt === null) && now - lastHistory >= 250) {
      lastHistory = now;
      state.history.push({ at: (now - state.startedAt) / 1000, A: state.requests.filter(r => r.endpointId === 'A').reduce((sum, r) => sum + liveRate(r, now), 0), B: state.requests.filter(r => r.endpointId === 'B').reduce((sum, r) => sum + liveRate(r, now), 0) });
    }
    publish();
  }, 100);
  publish();
  const finished = Promise.all(state.requests.map(async request => {
    const endpoint = targets.find(e => e.id === request.endpointId)!;
    const controller = new AbortController();
    controllers.push(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutSeconds * 1000);
    request.status = 'running';
    request.startedAt = clock();
    const pool = pools.get(endpoint.id);
    const failCounter = (error: unknown) => {
      request.tokenSource = 'estimated'; request.tokenCounting = 'failed';
      request.tokenCountError = msg('error.counter.fallback', { reason: describeError(error) });
    };
    let counter: LiveTokenCounter | null = null;
    if (pool && endpoint.tokenCounter) {
      request.tokenSource = counterSource(endpoint.tokenCounter); request.tokenCounting = 'active';
      request.countedTokens = 0; request.countedChars = 0; request.countedEstimate = 0; request.tokenScale = 1;
      counter = new LiveTokenCounter(pool, controller.signal, (tokens, snapshot) => {
        const previousChars = request.countedChars ?? 0;
        const estimatedDelta = snapshot.estimated - (request.countedEstimate ?? 0);
        const actualDelta = tokens - (request.countedTokens ?? 0);
        const batchScale = estimatedDelta > 0 ? Math.max(0, actualDelta) / estimatedDelta : 1;
        const nextScale = estimatedDelta > 0 && actualDelta > 0 ? batchScale : request.tokenScale ?? 1;
        request.samples = request.samples.map(sample => sample.chars !== undefined && sample.estimate !== undefined && sample.chars > previousChars ? { ...sample, tokens: sample.estimate * (sample.chars <= snapshot.text.length ? batchScale : nextScale) } : sample);
        request.countedTokens = tokens; request.countedChars = snapshot.text.length;
        request.countedAt = snapshot.at; request.countedEstimate = snapshot.estimated; request.tokenScale = nextScale;
        advanceCar(request);
      }, failCounter, endpoint.tokenBatchSize ?? 32);
    }
    let weight = 0;
    try {
      for await (const event of streamCompletion(endpoint, state.config, prompt, controller.signal, dependencies.fetcher)) {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (event.type === 'text') {
          const now = clock();
          const before = request.estimatedTokens;
          const beforeCount = streamTokenCount(request).value!;
          weight += tokenWeight(event.text);
          request.text += event.text;
          request.estimatedTokens = Math.ceil(weight);
          advanceCar(request);
          if (request.firstAt === null) { request.firstAt = now; request.firstTokens = estimateTokens(event.text); }
          request.lastTextAt = now;
          request.samples.push({ at: now, tokens: streamTokenCount(request).value! - beforeCount, estimate: request.estimatedTokens - before, chars: request.text.length });
          request.samples = request.samples.filter(s => s.at > now - 1200);
          counter?.observe({ text: request.text, at: now, estimated: request.estimatedTokens, scale: request.tokenScale ?? 1 });
        } else if (event.type === 'usage') {
          request.usage = { ...request.usage, ...event.usage };
          request.timing = event.timing;
        } else {
          request.status = 'success';
          request.finishReason = event.reason;
        }
      }
      if (request.status !== 'success') throw new LocalizedError('error.incomplete');
    } catch (error) {
      if (timedOut) { request.status = 'error'; request.error = msg('error.timeout', { seconds: settings.timeoutSeconds }); }
      else if (cancelling && controller.signal.aborted) request.status = 'cancelled';
      else { request.status = 'error'; request.error = describeError(error); }
    } finally {
      clearTimeout(timeout);
      request.endedAt = clock();
      advanceCar(request);
      if (state.requests.filter(r => r.endpointId === endpoint.id).every(r => r.status === 'success' && r.endedAt !== null)) finishRace(endpoint.id, request.endedAt);
      if (counter) {
        if (request.status === 'success' && request.usage?.output === undefined && !controller.signal.aborted && request.tokenCounting !== 'failed') {
          request.tokenCounting = 'finalizing';
          const complete = await counter.finish({ text: request.text, at: request.lastTextAt ?? request.endedAt, estimated: request.estimatedTokens, scale: request.tokenScale ?? 1 });
          if (!complete && !request.tokenCountError) failCounter(new LocalizedError('error.counter.finalIncomplete'));
        } else counter.stop();
        if (request.tokenCounting !== 'failed') request.tokenCounting = 'done';
        advanceCar(request);
      }
    }
  })).then(() => {
    clearInterval(ticker);
    state.phase = 'complete';
    publish();
    return snapshot();
  });
  return { finished, cancel: () => { cancelling = true; controllers.forEach(c => c.abort()); } };
}
