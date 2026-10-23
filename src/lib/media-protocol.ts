import { LocalizedError } from '../i18n/message';
import type { EndpointConfig } from './types';
import type { MediaAsset, MediaConfig } from './media-types';

export function mediaUrl(base: string, resource: 'models' | 'images/generations' | 'videos', id?: string, content = false): string {
  let url: URL;
  try { url = new URL(base.trim()); } catch { throw new LocalizedError('error.endpointUrl'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new LocalizedError('error.endpointUrl');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:images\/generations|videos(?:\/sync)?|chat\/completions|models)$/, '');
  if (!path) path = '/v1';
  url.pathname = `${path}/${resource}${id ? `/${encodeURIComponent(id)}` : ''}${content ? '/content' : ''}`;
  return url.toString();
}
export function mediaHeaders(endpoint: EndpointConfig): Record<string, string> {
  return endpoint.apiKey.trim() ? { Authorization: `Bearer ${endpoint.apiKey.trim()}` } : {};
}
export function imageBody(config: MediaConfig, endpoint: EndpointConfig, imageIndex = 0) {
  // Each image can return independently; matching A/B positions use the same seed.
  return { model: endpoint.model.trim(), prompt: config.prompt, size: `${config.width}x${config.height}`, n: 1,
    num_inference_steps: config.steps, response_format: 'b64_json', ...(config.seed !== null ? { seed: (config.seed + imageIndex) % 2147483648 } : {}) };
}
export function aspectRatio(width: number, height: number): string {
  let a = width, b = height;
  while (b !== 0) { const remainder = a % b; a = b; b = remainder; }
  return `${width / a}:${height / a}`;
}
export function videoBody(config: MediaConfig, endpoint: EndpointConfig): FormData {
  const form = new FormData();
  const fields = { model: endpoint.model.trim(), prompt: config.prompt, size: `${config.width}x${config.height}`, seconds: config.seconds,
    fps: config.fps, num_inference_steps: config.steps,
    extra_params: JSON.stringify({ aspect_ratio: aspectRatio(config.width, config.height) }),
    ...(config.seed !== null ? { seed: config.seed } : {}) };
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  return form;
}
export async function assertMediaResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const raw = (await response.text()).slice(0, 1000);
  let detail = raw;
  try { const body = JSON.parse(raw); detail = errorDetail(body); } catch { /* Plain-text response. */ }
  throw new LocalizedError('error.http', { status: response.status, detail });
}
export function errorDetail(body: Record<string, any>): string {
  const value = body.error?.message ?? body.error ?? body.detail ?? body.message;
  return typeof value === 'string' ? value : value ? JSON.stringify(value).slice(0, 1000) : '';
}
export async function mediaJson(response: Response): Promise<Record<string, any>> {
  await assertMediaResponse(response);
  let body;
  try { body = await response.json(); } catch { throw new LocalizedError('media.invalidResponse'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LocalizedError('media.invalidResponse');
  if (body.error) throw new LocalizedError('error.raw', { text: errorDetail(body) });
  return body;
}
export function imageAssets(body: Record<string, any>, base: string): MediaAsset[] {
  if (!Array.isArray(body.data) || !body.data.length) throw new LocalizedError('media.invalidResponse');
  return body.data.map((item: any): MediaAsset => {
    if (typeof item?.b64_json === 'string' && item.b64_json.length) {
      try { if (!atob(item.b64_json).length) throw new Error(); } catch { throw new LocalizedError('media.invalidResponse'); }
      return { base64: item.b64_json, mime: 'image/png' };
    }
    if (typeof item?.url === 'string' && item.url) return { url: safeAssetUrl(item.url, base), mime: 'image/png' };
    throw new LocalizedError('media.invalidResponse');
  });
}
export function safeAssetUrl(value: string, base: string): string {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new LocalizedError('media.invalidResponse'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new LocalizedError('media.invalidResponse');
  return url.toString();
}
export function inferenceSeconds(body: Record<string, any>): number | undefined {
  const value = body.inference_time_s;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
/** Videos API reports a percentage, not a fraction or a client-side estimate. */
export function videoProgress(body: Record<string, unknown>): number | undefined {
  if (body.status === 'completed') return 100;
  const value = body.progress;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}
export async function fetchMediaAsset(asset: MediaAsset, endpoint: EndpointConfig, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
  if (asset.base64) {
    const bytes = Uint8Array.from(atob(asset.base64), character => character.charCodeAt(0));
    return new Blob([bytes], { type: asset.mime });
  }
  if (!asset.url) throw new LocalizedError('media.invalidResponse');
  const url = safeAssetUrl(asset.url, endpoint.baseUrl);
  // Do not send Endpoint credentials to third-party image storage.
  const sameOrigin = new URL(url).origin === new URL(endpoint.baseUrl).origin;
  const response = await fetcher(url, { signal, headers: sameOrigin ? mediaHeaders(endpoint) : {}, credentials: 'omit', redirect: sameOrigin && endpoint.apiKey.trim() ? 'error' : 'follow' });
  await assertMediaResponse(response);
  const blob = await response.blob();
  if (!blob.size || !blob.type.startsWith(asset.mime.split('/')[0] + '/')) throw new LocalizedError('media.invalidResponse');
  return blob;
}
