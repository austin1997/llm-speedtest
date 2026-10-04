import { describe, expect, it } from 'vitest';
import { browserDecode, browserDecodeMetric, browserOutputDuration, endpointMetrics, estimatedBrowserDecode, liveRate, outputCount, raceProgress, serverDecode, serverPrefill, ttft } from '../../src/lib/metrics';
import { estimateTokens, generatePrompt } from '../../src/lib/prompt';
import type { RequestResult, RunState } from '../../src/lib/types';
import { config, endpoint } from './fixtures';

function request(patch: Partial<RequestResult> = {}): RequestResult {
  return { id: 'A-1', endpointId: 'A', index: 1, status: 'success', text: 'example', startedAt: 0, firstAt: 500, lastTextAt: 1500, endedAt: patch.status === 'running' || patch.status === 'pending' ? null : 2000, firstTokens: 2, estimatedTokens: 12, samples: [], usage: { input: 20, output: 15, cachedInput: 4, reasoning: 5 }, timing: { decodeNs: 1e9, prefillNs: 2e9 }, ...patch };
}
describe('measurement semantics', () => {
  it('generates monotonic deterministic previews with the requested ASCII estimate', () => {
    const a = generatePrompt(128), b = generatePrompt(129);
    expect(b.startsWith(a)).toBe(true);
    expect(estimateTokens(a)).toBe(128);
    expect(estimateTokens(generatePrompt(32768))).toBe(32768);
    expect(generatePrompt(1024)).toBe(generatePrompt(1024));
  });
  it('supports a zero origin time and excludes the first fragment from decode', () => {
    expect(ttft(request())).toBe(500);
    expect(estimatedBrowserDecode(request())).toBe(10);
    expect(browserDecode(request({ lastTextAt: 500 }))).toBeNull();
    expect(ttft(request({ firstAt: null }))).toBeNull();
  });
  it('uses final real output tokens and browser output-stage duration instead of a character estimate', () => {
    const r = request({ firstAt: 0, lastTextAt: 1000, endedAt: 1200, firstTokens: 100, estimatedTokens: 500, usage: { output: 64, reasoning: 20 } });
    expect(browserOutputDuration(r)).toBe(1200);
    expect(browserDecodeMetric(r)).toEqual({ value: 64 / 1.2, source: 'measured' });
    expect(estimatedBrowserDecode(r)).toBe(400);
    expect(browserDecodeMetric({ ...r, usage: undefined })).toEqual({ value: 400, source: 'estimated' });
    expect(browserDecodeMetric({ ...r, endedAt: null })).toEqual({ value: 400, source: 'estimated' });
  });
  it('does not invent a decode window for one fragment or a zero duration', () => {
    expect(browserDecodeMetric(request({ firstAt: 500, lastTextAt: 500, endedAt: 501 }))).toEqual({ value: null, source: 'measured' });
    expect(browserDecodeMetric(request({ firstAt: 500, endedAt: 500 }))).toEqual({ value: null, source: 'measured' });
    expect(browserDecodeMetric(request({ firstAt: null }))).toEqual({ value: null, source: 'measured' });
  });
  it('preserves usage provenance and keeps service metrics independent', () => {
    expect(outputCount(request())).toEqual({ value: 15, source: 'reported' });
    expect(outputCount(request({ usage: undefined }))).toEqual({ value: 12, source: 'estimated' });
    expect(serverDecode(request())).toBeCloseTo(15);
    expect(serverPrefill(request())).toBeCloseTo(8);
    expect(serverDecode(request({ timing: { decodeNs: 0 } }))).toBeNull();
  });
  it('uses a one-second rolling throughput window and zero after completion', () => {
    const r = request({ status: 'running', samples: [{ at: 900, tokens: 5 }, { at: 1500, tokens: 7 }, { at: 1900, tokens: 3 }] });
    expect(liveRate(r, 2000)).toBe(10);
    expect(liveRate({ ...r, status: 'success' }, 2000)).toBe(0);
  });
  it('excludes cancelled/error output from successful totals but includes their elapsed time', () => {
    const state: RunState = { phase: 'complete', config, endpoints: [endpoint], prompt: 'x', startedAt: 0, now: 9000, history: [], raceDistance: { A: 0, B: 0 }, requests: [request(), request({ id: 'A-2', status: 'error', endedAt: 3000 }), request({ id: 'A-3', status: 'cancelled', endedAt: 4000 })] };
    const result = endpointMetrics(state, 'A');
    expect(result.overall).toEqual({ value: 3.75, source: 'reported' });
    expect(result.ttft).toMatchObject({ mean: 500, min: 500, max: 500, count: 1 });
    expect(result.failed).toBe(1); expect(result.cancelled).toBe(1);
    const mixed = endpointMetrics({ ...state, requests: [request({ usage: undefined })] }, 'A');
    expect(mixed.overall.source).toBe('estimated');
  });
  it('keeps a final mean with mixed real and estimated usage marked as mixed', () => {
    const state: RunState = { phase: 'complete', config, endpoints: [endpoint], prompt: 'x', startedAt: 0, now: 4000, history: [], raceDistance: { A: 0, B: 0 }, requests: [request(), request({ id: 'A-2', usage: undefined })] };
    expect(endpointMetrics(state, 'A').decode).toMatchObject({ source: 'estimated', mixed: true });
    expect(endpointMetrics({ ...state, requests: [request()] }, 'A').decode).toMatchObject({ source: 'measured', mixed: false });
  });
  it('distinguishes faster round completion from faster decode or prefill stages at concurrency two', () => {
    const a = request({ firstAt: 22000, lastTextAt: 23900, endedAt: 24000, usage: { output: 64, input: 40, cachedInput: 0 }, timing: { decodeNs: 2e9, prefillNs: .1e9 } });
    const b = request({ endpointId: 'B', firstAt: 1000, lastTextAt: 4900, endedAt: 5000, usage: { output: 64, input: 40, cachedInput: 0 }, timing: { decodeNs: 4e9, prefillNs: .5e9 } });
    const state: RunState = { phase: 'complete', config: { ...config, concurrency: 2 }, endpoints: [endpoint, { ...endpoint, id: 'B' }], prompt: 'x', startedAt: 0, now: 24000, history: [], raceDistance: { A: 128, B: 128 }, requests: [a, { ...a, id: 'A-2' }, { ...b, id: 'B-1' }, { ...b, id: 'B-2' }] };
    const am = endpointMetrics(state, 'A'), bm = endpointMetrics(state, 'B');
    expect(bm.elapsed).toBeLessThan(am.elapsed);
    expect(bm.overall.value).toBeGreaterThan(am.overall.value!);
    expect(am.serverDecode.mean).toBe(32); expect(bm.serverDecode.mean).toBe(16);
    expect(am.decode.mean).toBe(32); expect(bm.decode.mean).toBe(16);
    expect(am.prefill.mean).toBe(400); expect(bm.prefill.mean).toBe(80);
  });
});

describe('token race measurements', () => {
  function run(requests: RequestResult[], patch: Partial<RunState> = {}): RunState {
    const raceDistance = { A: Math.min(512, requests.filter(r => r.endpointId === 'A').reduce((sum, r) => sum + r.estimatedTokens, 0)), B: Math.min(512, requests.filter(r => r.endpointId === 'B').reduce((sum, r) => sum + r.estimatedTokens, 0)) };
    return { phase: 'running', config: { ...config, outputTokens: 256, concurrency: 2 }, endpoints: [endpoint, { ...endpoint, id: 'B' }], prompt: 'x', startedAt: 0, now: 2000, history: [], raceDistance, requests, ...patch };
  }
  it('aggregates each endpoint and uses output limit times concurrency as its track budget', () => {
    const state = run([
      request({ status: 'running', estimatedTokens: 128, samples: [{ at: 1500, tokens: 20 }] }),
      request({ id: 'A-2', status: 'running', estimatedTokens: 64, samples: [{ at: 1900, tokens: 10 }] }),
      request({ id: 'B-1', endpointId: 'B', status: 'running', estimatedTokens: 80, samples: [{ at: 1900, tokens: 40 }] }),
    ]);
    expect(raceProgress(state, 'A')).toMatchObject({ budget: 512, generated: 192, speed: 30, fraction: .375, state: 'driving' });
    expect(raceProgress(state, 'B')).toMatchObject({ generated: 80, speed: 40, fraction: 80 / 512 });
  });
  it('stays at the start before output arrives', () => {
    const progress = raceProgress(run([request({ status: 'running', estimatedTokens: 0, firstAt: null, samples: [] })]), 'A');
    expect(progress).toMatchObject({ generated: 0, speed: 0, fraction: 0, state: 'waiting' });
  });
  it('calibrates final token digits while leaving the car at its streaming position', () => {
    const state = run([request({ estimatedTokens: 100, usage: { output: 20 } })], { phase: 'complete' });
    expect(raceProgress(state, 'A')).toMatchObject({ generated: 100, output: { value: 20, source: 'reported' }, fraction: 100 / 512, speed: 0, active: false, state: 'early' });
    expect(outputCount(state.requests[0])).toEqual({ value: 20, source: 'reported' });
  });
  it('calibrates each finished request while other concurrent requests keep streaming', () => {
    const completed = request({ estimatedTokens: 100, usage: { output: 20 } });
    const streaming = request({ id: 'A-2', status: 'running', endedAt: null, estimatedTokens: 60, usage: { output: 99 } });
    expect(raceProgress(run([completed, streaming]), 'A')).toMatchObject({ generated: 160, fraction: 160 / 512, output: { value: 80, source: 'estimated' } });
    expect(raceProgress(run([completed, { ...streaming, status: 'success', endedAt: 2000, usage: { output: 30 } }]), 'A')).toMatchObject({ generated: 160, fraction: 160 / 512, output: { value: 50, source: 'reported' } });
  });
  it('keeps missing usage marked as estimated and trusts a reported zero', () => {
    expect(raceProgress(run([request({ estimatedTokens: 100, usage: { output: 20 } }), request({ id: 'A-2', estimatedTokens: 60, usage: undefined })]), 'A').output).toEqual({ value: 80, source: 'estimated' });
    expect(raceProgress(run([request({ usage: { output: 0 } })]), 'A').output).toEqual({ value: 0, source: 'reported' });
  });
  it('pauses a car after a downward correction until the corrected total catches up', () => {
    const completed = request({ estimatedTokens: 100, usage: { output: 20 } });
    const streaming = request({ id: 'A-2', status: 'running', endedAt: null, estimatedTokens: 40, usage: undefined });
    const patch = { raceDistance: { A: 100, B: 0 } };
    expect(raceProgress(run([completed, streaming], patch), 'A')).toMatchObject({ distance: 100, fraction: 100 / 512, output: { value: 60, source: 'estimated' }, waitingForCalibration: true, state: 'catchup' });
    expect(raceProgress(run([completed, { ...streaming, estimatedTokens: 80 }], patch), 'A')).toMatchObject({ distance: 100, output: { value: 100 }, waitingForCalibration: false, state: 'driving' });
    expect(raceProgress(run([completed, { ...streaming, estimatedTokens: 90 }], patch), 'A')).toMatchObject({ distance: 110, fraction: 110 / 512, waitingForCalibration: false });
  });
  it('retains partial progress on failure/cancellation and clamps movement to the finish line', () => {
    expect(raceProgress(run([request({ status: 'error', estimatedTokens: 32 })]), 'A')).toMatchObject({ generated: 32, speed: 0, state: 'error' });
    expect(raceProgress(run([request({ status: 'cancelled', estimatedTokens: 64 })]), 'A')).toMatchObject({ generated: 64, speed: 0, state: 'cancelled' });
    expect(raceProgress(run([request({ estimatedTokens: 600 })]), 'A')).toMatchObject({ generated: 600, fraction: 1, state: 'finished' });
  });
});
