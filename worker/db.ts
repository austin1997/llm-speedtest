import type { RunRecord } from '../shared/run-record';
import type { D1Database, D1PreparedStatement } from './d1';

export const MIN_SCHEMA_VERSION = 1;

export type RecordingBlock = 'database_unavailable' | 'schema_outdated';

async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function recordingAvailability(db: D1Database | undefined): Promise<{ ok: true } | { ok: false; reason: RecordingBlock }> {
  if (!db) return { ok: false, reason: 'database_unavailable' };
  try {
    const row = await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first<{ value: string }>();
    const version = Number(row?.value);
    if (!row || !Number.isInteger(version) || version < MIN_SCHEMA_VERSION) return { ok: false, reason: 'schema_outdated' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'database_unavailable' };
  }
}

export async function saveRun(db: D1Database, record: RunRecord, sourceIp: string | null, now: number): Promise<{ id: number; duplicate: boolean }> {
  const existing = await db.prepare('SELECT id FROM runs WHERE client_run_id = ?').bind(record.runId).first<{ id: number }>();
  if (existing) return { id: Number(existing.id), duplicate: true };

  const statements: D1PreparedStatement[] = [];
  if (sourceIp) statements.push(db.prepare('INSERT INTO source_ips (ip, first_seen_at) VALUES (?, ?) ON CONFLICT(ip) DO NOTHING').bind(sourceIp, now));
  const fingerprints = new Map<string, string>();
  for (const endpoint of record.endpoints) {
    statements.push(db.prepare('INSERT INTO endpoints (protocol, base_url, first_seen_at) VALUES (?, ?, ?) ON CONFLICT(protocol, base_url) DO NOTHING').bind(endpoint.protocol, endpoint.baseUrl, now));
    statements.push(db.prepare('INSERT INTO models (name, first_seen_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').bind(endpoint.model, now));
    if (endpoint.apiKey) {
      const digest = fingerprints.get(endpoint.apiKey) ?? await fingerprint(endpoint.apiKey);
      fingerprints.set(endpoint.apiKey, digest);
      statements.push(db.prepare(`INSERT INTO api_keys (fingerprint, secret, secret_format, first_seen_at) VALUES (?, ?, 'plain', ?) ON CONFLICT(fingerprint) DO NOTHING`).bind(digest, endpoint.apiKey, now));
    }
  }
  const runIndex = statements.length;
  statements.push(db.prepare(`INSERT INTO runs (
    client_run_id, record_version, app_version, created_at, started_at, source_ip_id, duration_ms, prompt_hash,
    input_tokens, output_tokens, concurrency, temperature, thinking, timeout_seconds
  ) VALUES (?, ?, ?, ?, ?, (SELECT id FROM source_ips WHERE ip = ?), ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(client_run_id) DO NOTHING`).bind(
    record.runId, record.recordVersion, record.appVersion, now, record.startedAt, sourceIp, record.durationMs, record.promptHash,
    record.config.inputTokens, record.config.outputTokens, record.config.concurrency, record.config.temperature, record.config.thinking, record.config.timeoutSeconds,
  ));
  for (const endpoint of record.endpoints) {
    const digest = endpoint.apiKey ? fingerprints.get(endpoint.apiKey)! : null;
    const metric = endpoint.result;
    statements.push(db.prepare(`INSERT INTO run_endpoints (
      run_id, slot, endpoint_id, model_id, api_key_id, alias, options,
      request_count, success_count, failure_count, cancelled_count,
      elapsed_ms, output_tokens, output_source, overall_tps,
      ttft_mean_ms, ttft_min_ms, ttft_max_ms,
      decode_mean, decode_min, decode_max, decode_source, decode_mixed,
      duration_mean_ms, server_decode_mean, server_prefill_mean, load_mean_ms, error_sample
    )
    SELECT r.id, ?, e.id, m.id, k.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM runs r
    JOIN endpoints e ON e.protocol = ? AND e.base_url = ?
    JOIN models m ON m.name = ?
    LEFT JOIN api_keys k ON ? IS NOT NULL AND k.fingerprint = ?
    WHERE r.client_run_id = ?
      AND NOT EXISTS (SELECT 1 FROM run_endpoints existing WHERE existing.run_id = r.id AND existing.slot = ?)`).bind(
      endpoint.slot, endpoint.alias, JSON.stringify(endpoint.options),
      metric.requestCount, metric.successCount, metric.failureCount, metric.cancelledCount,
      metric.elapsedMs, metric.outputTokens, metric.outputSource, metric.overallTps,
      metric.ttftMeanMs, metric.ttftMinMs, metric.ttftMaxMs,
      metric.decodeMean, metric.decodeMin, metric.decodeMax, metric.decodeSource, metric.decodeMixed ? 1 : 0,
      metric.durationMeanMs, metric.serverDecodeMean, metric.serverPrefillMean, metric.loadMeanMs, metric.errorSample,
      endpoint.protocol, endpoint.baseUrl, endpoint.model, digest, digest, record.runId, endpoint.slot,
    ));
  }
  const results = await db.batch(statements);
  const stored = await db.prepare('SELECT id FROM runs WHERE client_run_id = ?').bind(record.runId).first<{ id: number }>();
  if (!stored) throw new Error('测速记录未能写入。');
  return { id: Number(stored.id), duplicate: results[runIndex]?.meta.changes !== 1 };
}
