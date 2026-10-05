import { describe, expect, it } from 'vitest';
import { canonicalBaseUrl, parseRunRecord, RecordParseError } from '../../shared/run-record';
import { buildRunRecord } from '../../src/lib/recording';
import type { RequestResult, RunState } from '../../src/lib/types';
import { config, endpoint } from './fixtures';

function request(patch: Partial<RequestResult> = {}): RequestResult {
  return { id: 'A-1', endpointId: 'A', index: 1, status: 'success', text: 'example', startedAt: 0, firstAt: 500, lastTextAt: 1500, endedAt: 2000, firstTokens: 2, estimatedTokens: 12, samples: [], usage: { input: 20, output: 15 }, timing: { decodeNs: 1e9, prefillNs: 2e9, loadNs: 3e6 }, ...patch };
}
const state = (requests: RequestResult[]): RunState => ({ phase: 'complete', config, endpoints: [{ ...endpoint, apiKey: '' }], prompt: 'prompt text', startedAt: 0, now: 2000, history: [], raceDistance: { A: 0, B: 0 }, requests });

describe('run records', () => {
  it('canonicalizes endpoint addresses the same way requests are built', () => {
    expect(canonicalBaseUrl('http://localhost:11434/api/chat/', 'ollama')).toBe('http://localhost:11434');
    expect(canonicalBaseUrl('http://LOCALHOST:11434/v1/chat/completions', 'openai')).toBe('http://localhost:11434/v1');
    expect(canonicalBaseUrl('https://example.com/gateway/v1/', 'openai')).toBe('https://example.com/gateway/v1');
    expect(canonicalBaseUrl('http://example.com', 'openai')).toBe('http://example.com/v1');
    expect(() => canonicalBaseUrl('http://user:secret@example.com/v1', 'openai')).toThrow(RecordParseError);
    expect(() => canonicalBaseUrl('https://example.com/v1?token=1', 'openai')).toThrow(RecordParseError);
  });

  it('builds the same summary the results view calculates and drops non-finite metrics', async () => {
    const run = state([request({ timing: { decodeNs: Number.MIN_VALUE, prefillNs: 2e9, loadNs: Number.POSITIVE_INFINITY } })]);
    const record = await buildRunRecord({ run, endpoints: [{ ...endpoint, alias: ' 本地 ', apiKey: ' secret ', baseUrl: 'http://localhost:11434/api/chat' }], runId: '11111111-1111-4111-8111-111111111111', startedAt: 1_700_000_000_000, appVersion: 'test', prompt: 'prompt text' });
    expect(record.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(record.durationMs).toBe(2000);
    expect(record.endpoints[0]).toMatchObject({ alias: '本地', apiKey: 'secret', baseUrl: 'http://localhost:11434/api/chat', result: { successCount: 1, failureCount: 0, outputTokens: 15, outputSource: 'reported', overallTps: 7.5, serverDecodeMean: null, loadMeanMs: null } });
    const parsed = parseRunRecord({ ...record, sourceIp: '203.0.113.9', extra: true });
    expect(parsed.endpoints[0].baseUrl).toBe('http://localhost:11434');
    expect(parsed.endpoints[0].alias).toBe('本地');
    expect(JSON.stringify(parsed)).not.toContain('sourceIp');
    expect(parseRunRecord({ ...record, endpoints: [{ ...record.endpoints[0], result: { ...record.endpoints[0].result, overallTps: Number.POSITIVE_INFINITY } }] }).endpoints[0].result.overallTps).toBeNull();
  });

  it('rejects a record whose shape or schema version is not supported', () => {
    expect(() => parseRunRecord({ schema: 2 })).toThrow(RecordParseError);
    expect(() => parseRunRecord([])).toThrow(RecordParseError);
  });
});
