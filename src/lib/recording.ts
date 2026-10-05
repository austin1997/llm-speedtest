import { FALLBACK_LOCALE } from '../i18n/locales';
import { renderMessage } from '../i18n/translate';
import { endpointMetrics } from './metrics';
import type { EndpointConfig, RunState, Source } from './types';
import { RECORD_SCHEMA, RECORD_VERSION, type EndpointOptions, type EndpointRecord, type RunRecord } from '../../shared/run-record';

export type { RunRecord };
export { RECORD_VERSION };

export interface RecordingStatus { recording: boolean; recordVersion: number }

const finite = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? null : value;

export function createRunId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function hashPrompt(prompt: string): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch { return null; }
}

function options(endpoint: EndpointConfig): EndpointOptions {
  const batch = endpoint.tokenBatchSize;
  return {
    includeUsage: endpoint.includeUsage,
    maxTokensField: endpoint.maxTokensField,
    thinkingFormat: endpoint.thinkingFormat,
    contextLength: endpoint.contextLength,
    useTokenApi: endpoint.protocol === 'openai' && endpoint.useTokenApi !== false,
    tokenBatchSize: Number.isInteger(batch) ? Math.max(8, Math.min(512, batch!)) : null,
    tokenCounter: endpoint.tokenCounter?.kind ?? null,
  };
}

const sampleError = (error: RunState['requests'][number]['error']) => error ? renderMessage(FALLBACK_LOCALE, error).slice(0, 256) : null;

function endpointRecord(run: RunState, endpoint: EndpointConfig): EndpointRecord {
  const metric = endpointMetrics(run, endpoint.id);
  const source: Source = metric.overall.source;
  return {
    slot: endpoint.id,
    protocol: endpoint.protocol,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model.trim(),
    alias: endpoint.alias?.trim() || null,
    apiKey: endpoint.apiKey.trim() || null,
    options: options(endpoint),
    result: {
      requestCount: metric.requests.length,
      successCount: metric.successful.length,
      failureCount: metric.failed,
      cancelledCount: metric.cancelled,
      elapsedMs: finite(metric.elapsed),
      outputTokens: finite(metric.tokens),
      outputSource: source,
      overallTps: finite(metric.overall.value),
      ttftMeanMs: finite(metric.ttft.mean),
      ttftMinMs: finite(metric.ttft.min),
      ttftMaxMs: finite(metric.ttft.max),
      decodeMean: finite(metric.decode.mean),
      decodeMin: finite(metric.decode.min),
      decodeMax: finite(metric.decode.max),
      decodeSource: metric.decode.source,
      decodeMixed: metric.decode.mixed,
      durationMeanMs: finite(metric.duration.mean),
      serverDecodeMean: finite(metric.serverDecode.mean),
      serverPrefillMean: finite(metric.prefill.mean),
      loadMeanMs: finite(metric.load.mean),
      // Stored data stays in one language regardless of the interface language of the submitting browser.
      errorSample: sampleError(metric.requests.find(request => request.error)?.error),
    },
  };
}

export async function buildRunRecord(input: { run: RunState; endpoints: EndpointConfig[]; runId: string; startedAt: number; appVersion: string | null; prompt: string }): Promise<RunRecord> {
  return {
    schema: RECORD_SCHEMA,
    recordVersion: RECORD_VERSION,
    runId: input.runId,
    appVersion: input.appVersion,
    startedAt: input.startedAt,
    durationMs: Math.max(0, Math.min(86_400_000, Math.round(input.run.now - input.run.startedAt))),
    promptHash: await hashPrompt(input.prompt),
    config: {
      inputTokens: input.run.config.inputTokens,
      outputTokens: input.run.config.outputTokens,
      concurrency: input.run.config.concurrency,
      temperature: input.run.config.temperature,
      thinking: input.run.config.thinking,
      timeoutSeconds: input.run.config.timeoutSeconds,
    },
    endpoints: input.endpoints.map(endpoint => endpointRecord(input.run, endpoint)),
  };
}

export async function fetchRecordingStatus(): Promise<RecordingStatus> {
  try {
    const response = await fetch('/api/status');
    const data = await response.json() as Partial<RecordingStatus>;
    if (!response.ok || typeof data.recording !== 'boolean') return { recording: false, recordVersion: RECORD_VERSION };
    return { recording: data.recording, recordVersion: typeof data.recordVersion === 'number' ? data.recordVersion : RECORD_VERSION };
  } catch { return { recording: false, recordVersion: RECORD_VERSION }; }
}

export async function submitRunRecord(record: RunRecord): Promise<{ ok: true; id: number; duplicate: boolean } | { ok: false }> {
  try {
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record), keepalive: true });
    const data = await response.json() as { id?: unknown; duplicate?: unknown };
    if (!response.ok || typeof data.id !== 'number') return { ok: false };
    return { ok: true, id: data.id, duplicate: data.duplicate === true };
  } catch { return { ok: false }; }
}
