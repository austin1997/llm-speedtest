import { describe, expect, it } from 'vitest';
import { browserDecode, endpointMetrics, liveRate, outputCount, serverDecode, serverPrefill, ttft } from '../../src/lib/metrics';
import { estimateTokens, generatePrompt } from '../../src/lib/prompt';
import type { RequestResult, RunState } from '../../src/lib/types';
import { config, endpoint } from './fixtures';

function request(patch: Partial<RequestResult> = {}): RequestResult {
  return { id: 'A-1', endpointId: 'A', index: 1, status: 'success', text: 'example', startedAt: 0, firstAt: 500, lastTextAt: 1500, endedAt: 2000, firstTokens: 2, estimatedTokens: 12, samples: [], usage: { input: 20, output: 15, cachedInput: 4, reasoning: 5 }, timing: { decodeNs: 1e9, prefillNs: 2e9 }, ...patch };
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
    expect(browserDecode(request())).toBe(10);
    expect(browserDecode(request({ lastTextAt: 500 }))).toBeNull();
    expect(ttft(request({ firstAt: null }))).toBeNull();
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
    const state: RunState = { phase: 'complete', config, endpoints: [endpoint], prompt: 'x', startedAt: 0, now: 9000, history: [], requests: [request(), request({ id: 'A-2', status: 'error', endedAt: 3000 }), request({ id: 'A-3', status: 'cancelled', endedAt: 4000 })] };
    const result = endpointMetrics(state, 'A');
    expect(result.overall).toEqual({ value: 3.75, source: 'reported' });
    expect(result.ttft).toMatchObject({ mean: 500, min: 500, max: 500, count: 1 });
    expect(result.failed).toBe(1); expect(result.cancelled).toBe(1);
    const mixed = endpointMetrics({ ...state, requests: [request({ usage: undefined })] }, 'A');
    expect(mixed.overall.source).toBe('estimated');
  });
});
