import { describeError, LocalizedError, msg } from '../i18n/message';
import { errorDetail, imageAsset, imageBody, inferenceSeconds, mediaHeaders, mediaJson, mediaUrl, videoBody } from './media-protocol';
import { validateMediaConfig } from './media-config';
import type { EndpointConfig } from './types';
import type { MediaConfig, MediaRequest, MediaRun } from './media-types';

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function startMediaBenchmark(config: MediaConfig, endpoints: EndpointConfig[], onUpdate: (run: MediaRun) => void,
  dependencies: { clock?: () => number; fetcher?: typeof fetch; pollMs?: number } = {}) {
  config = { ...config };
  validateMediaConfig(config);
  const targets = endpoints.map(endpoint => ({ ...endpoint }));
  for (const endpoint of targets) {
    mediaUrl(endpoint.baseUrl, 'models');
    if (!endpoint.model.trim()) throw new LocalizedError('error.modelRequired', { id: endpoint.id });
  }
  const clock = dependencies.clock ?? (() => performance.now());
  const fetcher = dependencies.fetcher ?? fetch;
  const state: MediaRun = { config: { ...config }, endpoints: targets.map(e => ({ ...e, apiKey: '' })), startedAt: clock(), now: clock(), phase: 'running', history: [],
    requests: targets.flatMap(e => Array.from({ length: config.concurrency }, (_, i): MediaRequest => ({ id: `${e.id}-${i + 1}`, endpointId: e.id, status: 'pending', startedAt: null, endedAt: null }))) };
  const controllers = state.requests.map(() => new AbortController());
  let cancelled = false;
  const publish = () => {
    state.now = state.phase === 'complete' ? Math.max(state.startedAt, ...state.requests.map(r => r.endedAt ?? state.startedAt)) : clock();
    const sample = { at: (state.now - state.startedAt) / 1000, A: mediaMetrics(state, 'A').throughput ?? 0, B: mediaMetrics(state, 'B').throughput ?? 0 };
    if (!state.history.length || sample.at - state.history[state.history.length - 1].at >= .5 || state.phase === 'complete') state.history.push(sample);
    onUpdate({ ...state, requests: state.requests.map(r => ({ ...r })), history: [...state.history] });
  };
  const ticker = setInterval(publish, 200);
  const finished = Promise.all(state.requests.map(async (request, index) => {
    const endpoint = targets.find(e => e.id === request.endpointId)!;
    const controller = controllers[index];
    const signal = controller.signal;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutSeconds * 1000);
    request.status = 'running'; request.startedAt = clock();
    try {
      if (config.mode === 'image') {
        const body = await mediaJson(await fetcher(mediaUrl(endpoint.baseUrl, 'images/generations'), {
          method: 'POST', headers: { ...mediaHeaders(endpoint), 'Content-Type': 'application/json' }, body: JSON.stringify(imageBody(config, endpoint)), signal,
        }));
        signal.throwIfAborted();
        request.asset = imageAsset(body, endpoint.baseUrl);
        request.inferenceSeconds = inferenceSeconds(body);
      } else {
        let body = await mediaJson(await fetcher(mediaUrl(endpoint.baseUrl, 'videos'), {
          method: 'POST', headers: mediaHeaders(endpoint), body: videoBody(config, endpoint), signal,
        }));
        // Retain an id returned by a late create response so cancellation can still clean it up.
        if (typeof body.id !== 'string' || !body.id.trim()) throw new LocalizedError('media.invalidResponse');
        request.jobId = body.id;
        while (true) {
          signal.throwIfAborted();
          if (body.status === 'completed') {
            request.asset = { url: mediaUrl(endpoint.baseUrl, 'videos', request.jobId, true), mime: 'video/mp4' };
            request.inferenceSeconds = inferenceSeconds(body);
            break;
          }
          if (body.status === 'failed') {
            const detail = errorDetail(body);
            throw detail ? new LocalizedError('error.raw', { text: detail }) : new LocalizedError('media.failed');
          }
          if (body.status !== 'queued' && body.status !== 'in_progress') throw new LocalizedError('media.invalidResponse');
          request.jobStatus = body.status;
          publish();
          await delay(dependencies.pollMs ?? 1000, signal);
          body = await mediaJson(await fetcher(mediaUrl(endpoint.baseUrl, 'videos', request.jobId), { signal, headers: mediaHeaders(endpoint), cache: 'no-store' }));
        }
      }
      signal.throwIfAborted();
      request.status = 'success';
    } catch (error) {
      if (timedOut) { request.status = 'error'; request.error = msg('error.timeout', { seconds: config.timeoutSeconds }); }
      else if (cancelled) request.status = 'cancelled';
      else { request.status = 'error'; request.error = describeError(error); }
      if (signal.aborted && request.jobId) {
        const cleanup = new AbortController();
        const limit = setTimeout(() => cleanup.abort(), 5000);
        void fetcher(mediaUrl(endpoint.baseUrl, 'videos', request.jobId), { method: 'DELETE', headers: mediaHeaders(endpoint), signal: cleanup.signal }).catch(() => {}).finally(() => clearTimeout(limit));
      }
    } finally {
      clearTimeout(timeout); request.endedAt = clock(); publish();
    }
  })).then(() => { clearInterval(ticker); state.phase = 'complete'; publish(); return state; });
  publish();
  return { finished, cancel: () => { cancelled = true; controllers.forEach(controller => controller.abort()); } };
}

export function mediaMetrics(run: MediaRun, id: EndpointConfig['id']) {
  const requests = run.requests.filter(r => r.endpointId === id);
  const successful = requests.filter(r => r.status === 'success');
  const durations = successful.map(r => r.endedAt! - r.startedAt!);
  const starts = requests.flatMap(r => r.startedAt === null ? [] : [r.startedAt]);
  const end = requests.every(r => r.endedAt !== null) ? Math.max(...requests.map(r => r.endedAt!)) : run.now;
  const elapsed = starts.length ? Math.max(0, end - Math.min(...starts)) : 0;
  const server = successful.flatMap(r => r.inferenceSeconds === undefined ? [] : [r.inferenceSeconds]);
  return { count: requests.length, success: successful.length, failed: requests.filter(r => r.status === 'error').length,
    cancelled: requests.filter(r => r.status === 'cancelled').length,
    successRate: requests.length ? successful.length / requests.length * 100 : null,
    mean: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    min: durations.length ? Math.min(...durations) : null, max: durations.length ? Math.max(...durations) : null,
    throughput: elapsed > 0 ? successful.length / elapsed * (run.config.mode === 'image' ? 1000 : 60000) : null,
    serverMean: server.length ? server.reduce((a, b) => a + b, 0) / server.length : null,
  };
}

export function videoRtf(run: MediaRun, id: EndpointConfig['id'], previews: Record<string, { duration?: number }>) {
  const success = run.requests.filter(r => r.endpointId === id && r.status === 'success');
  const actualCount = success.filter(r => Number.isFinite(previews[r.id]?.duration) && previews[r.id].duration! > 0).length;
  const estimated = actualCount < success.length;
  const mixed = actualCount > 0 && estimated;
  const values = success.map(r => (r.endedAt! - r.startedAt!) / 1000 / (Number.isFinite(previews[r.id]?.duration) && previews[r.id].duration! > 0 ? previews[r.id].duration! : run.config.seconds));
  return { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, estimated, mixed };
}
