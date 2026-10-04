import { estimateTokens, tokenWeight } from './prompt';
import { connectionError, streamCompletion } from './protocol';
import { liveRate } from './metrics';
import type { BenchmarkConfig, EndpointConfig, RequestResult, RunState } from './types';

export function startBenchmark(
  config: BenchmarkConfig, endpoints: EndpointConfig[], prompt: string,
  onUpdate: (state: RunState) => void,
  dependencies: { clock?: () => number; fetcher?: typeof fetch } = {},
): { cancel: () => void; finished: Promise<RunState> } {
  const clock = dependencies.clock ?? (() => performance.now());
  const targets = endpoints.map(endpoint => ({ ...endpoint }));
  const settings = { ...config };
  const controllers: AbortController[] = [];
  let cancelling = false;
  const state: RunState = {
    phase: 'running', config: settings, endpoints: targets.map(e => ({ ...e, apiKey: '' })), prompt,
    startedAt: clock(), now: clock(), history: [],
    requests: targets.flatMap(e => Array.from({ length: settings.concurrency }, (_, i): RequestResult => ({
      id: `${e.id}-${i + 1}`, endpointId: e.id, index: i + 1, status: 'pending', text: '',
      startedAt: null, firstAt: null, lastTextAt: null, endedAt: null, firstTokens: 0, estimatedTokens: 0, samples: [],
    }))),
  };
  const snapshot = (): RunState => ({ ...state, history: [...state.history], requests: state.requests.map(r => ({ ...r, samples: [...r.samples] })) });
  const publish = () => { state.now = clock(); onUpdate(snapshot()); };
  let lastHistory = -Infinity;
  const ticker = setInterval(() => {
    const now = clock();
    if (now - lastHistory >= 250) {
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
    let weight = 0;
    try {
      for await (const event of streamCompletion(endpoint, state.config, prompt, controller.signal, dependencies.fetcher)) {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (event.type === 'text') {
          const now = clock();
          const before = request.estimatedTokens;
          weight += tokenWeight(event.text);
          request.text += event.text;
          request.estimatedTokens = Math.ceil(weight);
          if (request.firstAt === null) { request.firstAt = now; request.firstTokens = estimateTokens(event.text); }
          request.lastTextAt = now;
          request.samples.push({ at: now, tokens: request.estimatedTokens - before });
          request.samples = request.samples.filter(s => s.at > now - 1200);
        } else if (event.type === 'usage') {
          request.usage = { ...request.usage, ...event.usage };
          request.timing = event.timing;
        } else {
          request.status = 'success';
          request.finishReason = event.reason;
        }
      }
      if (request.status !== 'success') throw new Error('响应未正常完成。');
    } catch (error) {
      if (timedOut) { request.status = 'error'; request.error = `请求超过 ${settings.timeoutSeconds} 秒，已终止。`; }
      else if (cancelling && controller.signal.aborted) request.status = 'cancelled';
      else { request.status = 'error'; request.error = connectionError(error); }
    } finally {
      clearTimeout(timeout);
      request.endedAt = clock();
    }
  })).then(() => {
    clearInterval(ticker);
    state.phase = 'complete';
    publish();
    return snapshot();
  });
  return { finished, cancel: () => { cancelling = true; controllers.forEach(c => c.abort()); } };
}
