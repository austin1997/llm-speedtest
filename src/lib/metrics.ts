import type { Metric, RequestResult, RunState, Source } from './types';

export function ttft(request: RequestResult): number | null {
  return request.firstAt !== null && request.startedAt !== null ? request.firstAt - request.startedAt : null;
}
export function duration(request: RequestResult, now: number): number | null {
  return request.startedAt !== null ? (request.endedAt ?? now) - request.startedAt : null;
}
export function estimatedBrowserDecode(request: RequestResult): number | null {
  if (request.firstAt === null || request.lastTextAt === null || request.lastTextAt <= request.firstAt) return null;
  return Math.max(0, request.estimatedTokens - request.firstTokens) * 1000 / (request.lastTextAt - request.firstAt);
}
export function streamTokenCount(request: RequestResult): Metric {
  if (request.countedTokens !== undefined) {
    const pending = Math.max(0, request.estimatedTokens - (request.countedEstimate ?? 0));
    const source = request.tokenSource === 'estimated' ? 'estimated' : request.tokenSource === 'calibrated' || request.countedChars !== request.text.length ? 'calibrated' : 'counted';
    return { value: request.countedTokens + Math.ceil(pending * (request.tokenScale ?? 1)), source };
  }
  return { value: request.estimatedTokens, source: 'estimated' };
}
export function liveDecodeMetric(request: RequestResult): Metric {
  const count = streamTokenCount(request);
  if (request.countedTokens !== undefined) {
    const elapsed = request.firstAt !== null && request.lastTextAt !== null ? request.lastTextAt - request.firstAt : 0;
    return { value: elapsed > 0 ? count.value! * 1000 / elapsed : null, source: count.source };
  }
  return { value: estimatedBrowserDecode(request), source: 'estimated' };
}
export function browserOutputDuration(request: RequestResult): number | null {
  return request.firstAt !== null && request.endedAt !== null && request.endedAt > request.firstAt ? request.endedAt - request.firstAt : null;
}
export function browserDecodeMetric(request: RequestResult): Metric {
  if (request.endedAt !== null && (request.usage?.output !== undefined || request.countedTokens !== undefined)) {
    const elapsed = browserOutputDuration(request);
    const count = outputCount(request);
    // Final usage describes the entire output, not the tokens in the first chunk.
    const hasWindow = request.firstAt !== null && request.lastTextAt !== null && request.lastTextAt > request.firstAt;
    return { value: elapsed !== null && hasWindow ? count.value! * 1000 / elapsed : null, source: count.source === 'reported' ? 'measured' : count.source };
  }
  return { value: estimatedBrowserDecode(request), source: 'estimated' };
}
export function browserDecode(request: RequestResult): number | null {
  return browserDecodeMetric(request).value;
}
export function liveRate(request: RequestResult, now: number): number {
  if (request.firstAt === null || request.status !== 'running') return 0;
  return Math.max(0, request.samples.filter(s => s.at > now - 1000 && s.at <= now).reduce((sum, s) => sum + s.tokens, 0));
}
export function serverDecode(request: RequestResult): number | null {
  const ns = request.timing?.decodeNs;
  return ns && request.usage?.output !== undefined ? request.usage.output / ns * 1e9 : null;
}
export function serverPrefill(request: RequestResult): number | null {
  const ns = request.timing?.prefillNs;
  const input = request.usage?.input;
  return ns && input !== undefined ? Math.max(0, input - (request.usage?.cachedInput ?? 0)) / ns * 1e9 : null;
}
export function outputCount(request: RequestResult): Metric {
  return request.usage?.output !== undefined ? { value: request.usage.output, source: 'reported' } : streamTokenCount(request);
}
export function stats(values: (number | null)[]) {
  const valid = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return { mean: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null, min: valid.length ? Math.min(...valid) : null, max: valid.length ? Math.max(...valid) : null, count: valid.length };
}
const combinedSource = (metrics: Metric[]): Source => {
  const sources = new Set(metrics.map(metric => metric.source));
  return sources.size === 1 ? metrics[0].source : 'estimated';
};
export function endpointMetrics(run: RunState, id: 'A' | 'B') {
  const requests = run.requests.filter(r => r.endpointId === id);
  const successful = requests.filter(r => r.status === 'success');
  const starts = requests.flatMap(r => r.startedAt === null ? [] : [r.startedAt]);
  const ended = requests.every(r => r.endedAt !== null);
  const end = ended ? Math.max(...requests.map(r => r.endedAt!)) : run.now;
  const elapsed = starts.length ? end - Math.min(...starts) : 0;
  const tokens = successful.reduce((sum, r) => sum + outputCount(r).value!, 0);
  const source = combinedSource(successful.map(outputCount));
  const decoded = successful.map(browserDecodeMetric);
  const decodeSource = combinedSource(decoded);
  const mixedDecode = new Set(decoded.map(metric => metric.source)).size > 1;
  const activeRequests = requests.filter(request => request.status === 'running' || request.status === 'pending');
  const liveDecoded = requests.map(liveDecodeMetric);
  return {
    requests, successful, elapsed,
    failed: requests.filter(r => r.status === 'error').length,
    cancelled: requests.filter(r => r.status === 'cancelled').length,
    active: requests.filter(r => r.status === 'running' || r.status === 'pending').length,
    live: requests.reduce((sum, r) => sum + liveRate(r, run.now), 0),
    liveSource: combinedSource((activeRequests.length ? activeRequests : requests).map(request => ({ value: 0, source: request.countedTokens !== undefined && request.tokenSource !== 'estimated' ? 'calibrated' : 'estimated' }))),
    tokenWarnings: [...new Map(requests.flatMap(r => r.tokenCountError ? [[JSON.stringify(r.tokenCountError), r.tokenCountError] as const] : [])).values()],
    finalizingTokens: requests.some(r => r.tokenCounting === 'finalizing'),
    ttft: stats(successful.map(ttft)), decode: { ...stats(decoded.map(metric => metric.value)), source: decodeSource, mixed: mixedDecode },
    liveDecode: { ...stats(liveDecoded.map(metric => metric.value)), source: combinedSource(liveDecoded) },
    serverDecode: stats(successful.map(serverDecode)), prefill: stats(successful.map(serverPrefill)),
    load: stats(successful.map(r => r.timing?.loadNs === undefined ? null : r.timing.loadNs / 1e6)),
    duration: stats(successful.map(r => duration(r, run.now))),
    overall: { value: successful.length && elapsed > 0 ? tokens * 1000 / elapsed : null, source },
    tokens,
  };
}

export type RaceState = 'waiting' | 'driving' | 'catchup' | 'budget' | 'error' | 'cancelled' | 'finished' | 'early';

/** Calibration may lower the count; the car waits at its greatest displayed distance. */
export function raceProgress(run: RunState, id: 'A' | 'B') {
  const requests = run.requests.filter(request => request.endpointId === id);
  const budget = run.config.outputTokens * run.config.concurrency;
  const generated = requests.reduce((sum, request) => sum + request.estimatedTokens, 0);
  const output: Metric = {
    value: requests.reduce((sum, request) => sum + (request.endedAt === null ? streamTokenCount(request).value! : outputCount(request).value!), 0),
    source: combinedSource(requests.map(request => request.endedAt === null ? streamTokenCount(request) : outputCount(request))),
  };
  const speed = requests.reduce((sum, request) => sum + liveRate(request, run.now), 0);
  const distance = Math.max(0, Math.min(budget, Math.max(run.raceDistance[id], output.value!)));
  const fraction = distance / budget;
  const active = requests.some(request => request.status === 'pending' || request.status === 'running');
  const waitingForCalibration = active && output.value! < distance;
  const state: RaceState = active ? distance === 0 ? 'waiting' : waitingForCalibration ? 'catchup' : fraction >= 1 ? 'budget' : 'driving'
    : requests.some(request => request.status === 'error') ? 'error'
    : requests.some(request => request.status === 'cancelled') ? 'cancelled'
    : fraction >= 1 ? 'finished' : 'early';
  return { budget, generated, distance, output, speed, fraction, active, waitingForCalibration, state };
}
