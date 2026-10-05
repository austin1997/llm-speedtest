-- Schema version 1. The Worker refuses to record when meta.schema_version is lower.
-- Timestamps are Unix epoch milliseconds. Expand this schema before depending on new columns.

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE endpoints (
  id INTEGER PRIMARY KEY,
  protocol TEXT NOT NULL CHECK (protocol IN ('ollama', 'openai')),
  base_url TEXT NOT NULL CHECK (length(base_url) BETWEEN 1 AND 2048),
  first_seen_at INTEGER NOT NULL,
  UNIQUE (protocol, base_url)
);

CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  first_seen_at INTEGER NOT NULL,
  UNIQUE (name)
);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  secret TEXT NOT NULL CHECK (length(secret) BETWEEN 1 AND 4096),
  secret_format TEXT NOT NULL DEFAULT 'plain' CHECK (secret_format IN ('plain')),
  first_seen_at INTEGER NOT NULL,
  UNIQUE (fingerprint)
);

CREATE TABLE source_ips (
  id INTEGER PRIMARY KEY,
  ip TEXT NOT NULL CHECK (length(ip) BETWEEN 1 AND 64),
  first_seen_at INTEGER NOT NULL,
  UNIQUE (ip)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  client_run_id TEXT NOT NULL CHECK (length(client_run_id) = 36),
  record_version INTEGER NOT NULL,
  app_version TEXT CHECK (app_version IS NULL OR length(app_version) <= 64),
  created_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  source_ip_id INTEGER REFERENCES source_ips (id),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 86400000),
  prompt_hash TEXT CHECK (prompt_hash IS NULL OR length(prompt_hash) = 16),
  input_tokens INTEGER NOT NULL CHECK (input_tokens BETWEEN 128 AND 32768),
  output_tokens INTEGER NOT NULL CHECK (output_tokens BETWEEN 32 AND 8192),
  concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 16),
  temperature REAL CHECK (temperature IS NULL OR (temperature >= 0 AND temperature <= 2)),
  thinking TEXT NOT NULL CHECK (thinking IN ('default', 'on', 'off')),
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 30 AND 1800),
  UNIQUE (client_run_id)
);

-- source_ip_id is intentionally unindexed: an index would add a write on every run.
CREATE INDEX runs_started_at ON runs (started_at);

CREATE TABLE run_endpoints (
  run_id INTEGER NOT NULL REFERENCES runs (id),
  slot TEXT NOT NULL CHECK (slot IN ('A', 'B')),
  endpoint_id INTEGER NOT NULL REFERENCES endpoints (id),
  model_id INTEGER NOT NULL REFERENCES models (id),
  api_key_id INTEGER REFERENCES api_keys (id),
  alias TEXT CHECK (alias IS NULL OR length(alias) <= 64),
  options TEXT NOT NULL CHECK (json_valid(options) AND length(options) <= 2048),
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 0 AND 16),
  success_count INTEGER NOT NULL CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
  cancelled_count INTEGER NOT NULL CHECK (cancelled_count >= 0),
  elapsed_ms REAL,
  output_tokens REAL,
  output_source TEXT CHECK (output_source IN ('reported', 'measured', 'estimated', 'counted', 'calibrated')),
  overall_tps REAL,
  ttft_mean_ms REAL,
  ttft_min_ms REAL,
  ttft_max_ms REAL,
  decode_mean REAL,
  decode_min REAL,
  decode_max REAL,
  decode_source TEXT CHECK (decode_source IN ('reported', 'measured', 'estimated', 'counted', 'calibrated')),
  decode_mixed INTEGER NOT NULL CHECK (decode_mixed IN (0, 1)),
  duration_mean_ms REAL,
  server_decode_mean REAL,
  server_prefill_mean REAL,
  load_mean_ms REAL,
  error_sample TEXT CHECK (error_sample IS NULL OR length(error_sample) <= 256),
  PRIMARY KEY (run_id, slot),
  CHECK (success_count + failure_count + cancelled_count = request_count)
) WITHOUT ROWID;

CREATE INDEX run_endpoints_endpoint ON run_endpoints (endpoint_id, run_id);

CREATE VIEW v_run_results AS
SELECT
  r.id AS run_id,
  r.client_run_id,
  r.record_version,
  r.app_version,
  r.created_at,
  r.started_at,
  r.duration_ms,
  r.prompt_hash,
  r.input_tokens,
  r.output_tokens,
  r.concurrency,
  r.temperature,
  r.thinking,
  r.timeout_seconds,
  s.ip AS source_ip,
  re.slot,
  e.protocol,
  e.base_url,
  m.name AS model,
  re.alias,
  k.secret AS api_key,
  k.fingerprint AS api_key_fingerprint,
  re.options,
  re.request_count,
  re.success_count,
  re.failure_count,
  re.cancelled_count,
  re.elapsed_ms,
  re.output_tokens AS result_output_tokens,
  re.output_source,
  re.overall_tps,
  re.ttft_mean_ms,
  re.ttft_min_ms,
  re.ttft_max_ms,
  re.decode_mean,
  re.decode_min,
  re.decode_max,
  re.decode_source,
  re.decode_mixed,
  re.duration_mean_ms,
  re.server_decode_mean,
  re.server_prefill_mean,
  re.load_mean_ms,
  re.error_sample
FROM runs r
LEFT JOIN source_ips s ON s.id = r.source_ip_id
JOIN run_endpoints re ON re.run_id = r.id
JOIN endpoints e ON e.id = re.endpoint_id
JOIN models m ON m.id = re.model_id
LEFT JOIN api_keys k ON k.id = re.api_key_id;

INSERT INTO meta (key, value) VALUES ('schema_version', '1');
