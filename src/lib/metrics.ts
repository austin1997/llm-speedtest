import type { Metric, RequestResult, RunState } from './types';

export function ttft(request: RequestResult): number | null {
  return request.firstAt !== null && request.startedAt !== null ? request.firstAt - request.startedAt : null;
}
export function duration(request: RequestResult, now: number): number | null {
  return request.startedAt !== null ? (request.endedAt ?? now) - request.startedAt : null;
}
export function browserDecode(request: RequestResult): number | null {
  if (request.firstAt === null || request.lastTextAt === null || request.lastTextAt <= request.firstAt) return null;
  return Math.max(0, request.estimatedTokens - request.firstTokens) * 1000 / (request.lastTextAt - request.firstAt);
}
export function liveRate(request: RequestResult, now: number): number {
  if (request.firstAt === null || request.status !== 'running') return 0;
  return request.samples.filter(s => s.at > now - 1000 && s.at <= now).reduce((sum, s) => sum + s.tokens, 0);
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
  return request.usage?.output !== undefined ? { value: request.usage.output, source: 'reported' } : { value: request.estimatedTokens, source: 'estimated' };
}
export function stats(values: (number | null)[]) {
  const valid = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return { mean: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null, min: valid.length ? Math.min(...valid) : null, max: valid.length ? Math.max(...valid) : null, count: valid.length };
}
export function endpointMetrics(run: RunState, id: 'A' | 'B') {
  const requests = run.requests.filter(r => r.endpointId === id);
  const successful = requests.filter(r => r.status === 'success');
  const starts = requests.flatMap(r => r.startedAt === null ? [] : [r.startedAt]);
  const ended = requests.every(r => r.endedAt !== null);
  const end = ended ? Math.max(...requests.map(r => r.endedAt!)) : run.now;
  const elapsed = starts.length ? end - Math.min(...starts) : 0;
  const tokens = successful.reduce((sum, r) => sum + outputCount(r).value!, 0);
  const source = successful.every(r => outputCount(r).source === 'reported') ? 'reported' as const : 'estimated' as const;
  return {
    requests, successful, elapsed,
    failed: requests.filter(r => r.status === 'error').length,
    cancelled: requests.filter(r => r.status === 'cancelled').length,
    active: requests.filter(r => r.status === 'running' || r.status === 'pending').length,
    live: requests.reduce((sum, r) => sum + liveRate(r, run.now), 0),
    ttft: stats(successful.map(ttft)), decode: stats(successful.map(browserDecode)),
    serverDecode: stats(successful.map(serverDecode)), prefill: stats(successful.map(serverPrefill)),
    load: stats(successful.map(r => r.timing?.loadNs === undefined ? null : r.timing.loadNs / 1e6)),
    duration: stats(successful.map(r => duration(r, run.now))),
    overall: { value: successful.length && elapsed > 0 ? tokens * 1000 / elapsed : null, source },
    tokens,
  };
}
