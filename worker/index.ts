import { RECORD_VERSION, RecordParseError, parseRunRecord } from '../shared/run-record';
import { recordingAvailability, saveRun } from './db';
import type { Env } from './d1';
import { canonicalIp } from './source-ip';

const MAX_BODY = 32 * 1024;

const json = (status: number, body: unknown, extra: HeadersInit = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return origin !== null && origin === new URL(request.url).origin;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request: Request, env: Env, now: () => number = Date.now): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/status' && url.pathname !== '/api/runs') return env.ASSETS.fetch(request);
  if (request.headers.has('Origin') && !sameOrigin(request)) return json(403, { error: 'origin_rejected' });
  if (url.pathname === '/api/status') {
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
    const availability = await recordingAvailability(env.DB);
    return json(200, { recording: availability.ok, recordVersion: RECORD_VERSION, ...(availability.ok ? {} : { reason: availability.reason }) });
  }
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  if (!sameOrigin(request)) return json(403, { error: 'origin_rejected' });
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return json(415, { error: 'unsupported_media_type' });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return json(413, { error: 'payload_too_large' });
  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: 'payload_too_large' });
  const availability = await recordingAvailability(env.DB);
  if (!availability.ok || !env.DB) return json(503, { error: availability.ok ? 'database_unavailable' : availability.reason });
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return json(400, { error: 'invalid_json' }); }
  try {
    const record = parseRunRecord(payload);
    const clock = now();
    if (record.startedAt > clock + 86_400_000) return json(400, { error: 'invalid_record', message: '开始时间无效。' });
    const saved = await saveRun(env.DB, record, canonicalIp(request.headers.get('CF-Connecting-IP')), clock);
    return json(saved.duplicate ? 200 : 201, saved);
  } catch (error) {
    if (error instanceof RecordParseError) return json(400, { error: 'invalid_record', message: error.message });
    console.error(error instanceof Error ? error.message : 'store failed');
    return json(500, { error: 'store_failed' });
  }
}
