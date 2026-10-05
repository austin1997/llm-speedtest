import { describe, expect, it } from 'vitest';
import { RECORD_VERSION, type RunRecord } from '../../shared/run-record';
import { MIN_SCHEMA_VERSION } from '../../worker/db';
import { handleRequest } from '../../worker/index';
import { canonicalIp } from '../../worker/source-ip';
import type { D1Database, Env } from '../../worker/d1';
import { openTestDatabase, SqliteD1 } from './d1-sqlite';
import { DatabaseSync } from 'node:sqlite';

const assets = { fetch: async () => new Response('asset') };
const envOf = (db?: D1Database): Env => ({ DB: db, ASSETS: assets });
const now = 1_800_000_000_000;

function record(patch: Partial<RunRecord> = {}, endpointPatch: Record<string, unknown> = {}): RunRecord {
  return {
    schema: 1, recordVersion: RECORD_VERSION, runId: '11111111-1111-4111-8111-111111111111', appVersion: 'test', startedAt: now - 2000, durationMs: 2000, promptHash: '0123456789abcdef',
    config: { inputTokens: 1024, outputTokens: 512, concurrency: 1, temperature: null, thinking: 'default', timeoutSeconds: 300 },
    endpoints: [{
      slot: 'A', protocol: 'ollama', baseUrl: 'http://localhost:11434/api/chat', model: 'qwen', alias: '本地', apiKey: 'plain-key',
      options: { includeUsage: true, maxTokensField: 'max_tokens', thinkingFormat: 'reasoning_effort', contextLength: null, useTokenApi: false, tokenBatchSize: null, tokenCounter: null },
      result: { requestCount: 1, successCount: 1, failureCount: 0, cancelledCount: 0, elapsedMs: 2000, outputTokens: 15, outputSource: 'reported', overallTps: 7.5, ttftMeanMs: 500, ttftMinMs: 500, ttftMaxMs: 500, decodeMean: 10, decodeMin: 10, decodeMax: 10, decodeSource: 'measured', decodeMixed: false, durationMeanMs: 2000, serverDecodeMean: 15, serverPrefillMean: 8, loadMeanMs: 3, errorSample: null },
      ...endpointPatch,
    }],
    ...patch,
  } as RunRecord;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1/api/runs', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const count = async (db: D1Database, table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const ips = async (db: D1Database) => (await db.prepare('SELECT ip FROM source_ips ORDER BY ip').all<{ ip: string }>()).results.map(row => row.ip);

describe('source addresses', () => {
  it('canonicalizes public addresses and rejects anything else', () => {
    expect(canonicalIp(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(canonicalIp('2001:DB8::1')).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(canonicalIp('2001:0db8:0:0:0:0:0:1')).toBe(canonicalIp('2001:db8::1'));
    expect(canonicalIp('999.1.1.1')).toBeNull();
    expect(canonicalIp('203.0.113.7, 198.51.100.1')).toBeNull();
    expect(canonicalIp(null)).toBeNull();
  });
});

describe('recording worker', () => {
  it('stores one run, deduplicates dimensions, and ignores a client-supplied address', async () => {
    const db = openTestDatabase();
    expect(MIN_SCHEMA_VERSION).toBe(1);
    expect((await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first<{ value: string }>())!.value).toBe('1');
    const first = await handleRequest(post({ ...record(), sourceIp: '198.51.100.9' }, { 'CF-Connecting-IP': '203.0.113.7' }), envOf(db), () => now);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ duplicate: false });
    expect(await count(db, 'runs')).toBe(1);
    expect(await count(db, 'endpoints')).toBe(1);
    expect(await count(db, 'models')).toBe(1);
    expect(await count(db, 'api_keys')).toBe(1);
    expect(await ips(db)).toEqual(['203.0.113.7']);
    const view = (await db.prepare('SELECT source_ip, base_url, api_key, api_key_fingerprint FROM v_run_results').all<{ source_ip: string; base_url: string; api_key: string; api_key_fingerprint: string }>()).results[0];
    expect(view).toMatchObject({ source_ip: '203.0.113.7', base_url: 'http://localhost:11434', api_key: 'plain-key' });
    expect(view.api_key_fingerprint).toHaveLength(64);

    const second = await handleRequest(post(record({ runId: '22222222-2222-4222-8222-222222222222' }), { 'CF-Connecting-IP': '203.0.113.7' }), envOf(db), () => now);
    expect(second.status).toBe(201);
    expect(await count(db, 'runs')).toBe(2);
    expect(await count(db, 'endpoints')).toBe(1);
    expect(await count(db, 'models')).toBe(1);
    expect(await count(db, 'api_keys')).toBe(1);
    expect(await count(db, 'source_ips')).toBe(1);

    const again = await handleRequest(post(record(), { 'CF-Connecting-IP': '198.51.100.20' }), envOf(db), () => now);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(await count(db, 'runs')).toBe(2);
    expect(await ips(db)).toEqual(['203.0.113.7']);
  });

  it('shares a model across endpoints and canonicalizes IPv6', async () => {
    const db = openTestDatabase();
    const body = record();
    body.endpoints.push({ ...body.endpoints[0], slot: 'B', protocol: 'openai', baseUrl: 'https://Example.com/v1/chat/completions', apiKey: null, alias: null });
    const response = await handleRequest(post(body, { 'CF-Connecting-IP': '2001:DB8::1' }), envOf(db), () => now);
    expect(response.status).toBe(201);
    expect(await count(db, 'models')).toBe(1);
    expect(await count(db, 'endpoints')).toBe(2);
    expect(await count(db, 'run_endpoints')).toBe(2);
    expect(await count(db, 'api_keys')).toBe(1);
    expect(await ips(db)).toEqual(['2001:0db8:0000:0000:0000:0000:0000:0001']);
    const missing = (await db.prepare(`SELECT api_key_id FROM run_endpoints WHERE slot = 'B'`).first<{ api_key_id: number | null }>())!;
    expect(missing.api_key_id).toBeNull();
  });

  it('stores null when the connecting address is absent or not an IP', async () => {
    const db = openTestDatabase();
    expect((await handleRequest(post(record()), envOf(db), () => now)).status).toBe(201);
    expect((await handleRequest(post(record({ runId: '22222222-2222-4222-8222-222222222222' }), { 'CF-Connecting-IP': 'not-an-ip' }), envOf(db), () => now)).status).toBe(201);
    const rows = (await db.prepare('SELECT source_ip_id FROM runs').all<{ source_ip_id: number | null }>()).results;
    expect(rows.map(row => row.source_ip_id)).toEqual([null, null]);
    expect(await count(db, 'source_ips')).toBe(0);
  });

  it('rejects bad requests and pauses recording when the schema is not ready', async () => {
    const db = openTestDatabase();
    expect((await handleRequest(new Request('http://127.0.0.1/api/status'), envOf(db))).status).toBe(200);
    expect(await (await handleRequest(post('not-json'), envOf(db))).json()).toMatchObject({ error: 'invalid_json' });
    expect((await handleRequest(post(record(), { origin: 'https://evil.example' }), envOf(db))).status).toBe(403);
    expect((await handleRequest(post(record(), { 'content-type': 'text/plain' }), envOf(db))).status).toBe(415);
    expect((await handleRequest(post(record(), { 'content-length': '99999' }), envOf(db))).status).toBe(413);
    expect((await handleRequest(post({ schema: 2 }), envOf(db))).status).toBe(400);
    expect((await handleRequest(new Request('http://127.0.0.1/'), envOf(db))).status).toBe(200);

    await db.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`).run();
    const status = await handleRequest(new Request('http://127.0.0.1/api/status'), envOf(db));
    expect(await status.json()).toMatchObject({ recording: false, reason: 'schema_outdated' });
    expect((await handleRequest(post(record()), envOf(db))).status).toBe(503);
    await db.prepare(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`).run();
    expect((await handleRequest(post(record()), envOf(db), () => now)).status).toBe(201);
    expect(await (await handleRequest(new Request('http://127.0.0.1/api/status'), envOf())).json()).toMatchObject({ recording: false, reason: 'database_unavailable' });
  });

  it('rolls back a run when a row violates a foreign key', async () => {
    const db = openTestDatabase();
    await expect(db.batch([
      db.prepare(`INSERT INTO runs (client_run_id, record_version, app_version, created_at, started_at, duration_ms, prompt_hash, input_tokens, output_tokens, concurrency, temperature, thinking, timeout_seconds) VALUES ('11111111-1111-4111-8111-111111111111', 1, NULL, 1, 1, 1, NULL, 128, 32, 1, NULL, 'default', 30)`),
      db.prepare(`INSERT INTO run_endpoints (run_id, slot, endpoint_id, model_id, options, request_count, success_count, failure_count, cancelled_count, decode_mixed) VALUES (1, 'A', 99, 1, '{}', 1, 1, 0, 0, 0)`),
    ])).rejects.toThrow();
    expect(await count(db, 'runs')).toBe(0);
    const empty = new SqliteD1(new DatabaseSync(':memory:'));
    expect(await (await handleRequest(new Request('http://127.0.0.1/api/status'), envOf(empty))).json()).toMatchObject({ reason: 'database_unavailable' });
  });
});
