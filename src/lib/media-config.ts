import { LocalizedError } from '../i18n/message';
import { mediaUrl } from './media-protocol';
import type { MediaConfig, MediaMode, MediaSettings } from './media-types';

export const resolutions = {
  image: [[512, 512], [768, 768], [1024, 1024], [1280, 720], [720, 1280]],
  video: [[640, 480], [832, 480], [1280, 720], [720, 1280]],
} as const;
export const mediaStorageKey = (mode: MediaMode) => `llm-speedtest-${mode}-config`;
export function defaultMediaSettings(mode: MediaMode, prompt: string): MediaSettings {
  return {
    config: { mode, prompt, width: mode === 'image' ? 1024 : 832, height: mode === 'image' ? 1024 : 480,
      steps: 20, seconds: 5, fps: 16, seed: null, concurrency: 1, timeoutSeconds: mode === 'image' ? 300 : 1800 },
    endpoints: (['A', 'B'] as const).map(id => ({ id, alias: '', protocol: 'openai', baseUrl: `http://localhost:${mode === 'image' ? 8000 : 8091}/v1`,
      model: '', apiKey: '', includeUsage: false, maxTokensField: 'max_tokens', thinkingFormat: 'reasoning_effort', contextLength: null })),
    compare: false,
  };
}
export const mediaBounds = { width: [64, 4096], height: [64, 4096], steps: [1, 100], seconds: [1, 30], fps: [1, 60], concurrency: [1, 16], timeoutSeconds: [30, 1800] } as const;
export function validateMediaConfig(config: MediaConfig): void {
  if (!config.prompt.trim() || config.prompt.length > 10000) throw new LocalizedError('media.invalidPrompt');
  for (const [key, [min, max]] of Object.entries(mediaBounds)) {
    const value = config[key as keyof typeof mediaBounds];
    if (!Number.isInteger(value) || value < min || value > max) throw new LocalizedError('media.invalidConfig');
  }
  if (config.seed !== null && (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 2147483647)) throw new LocalizedError('media.invalidConfig');
}
export function restoreMediaSettings(mode: MediaMode, prompt: string, raw: string | null): MediaSettings {
  const defaults = defaultMediaSettings(mode, prompt);
  try {
    const saved = JSON.parse(raw ?? 'null');
    if (saved?.version !== 1) return defaults;
    const config = { ...defaults.config };
    for (const [key, [min, max]] of Object.entries(mediaBounds)) {
      const value = saved.config?.[key];
      if (Number.isInteger(value) && value >= min && value <= max) config[key as keyof typeof mediaBounds] = value;
    }
    if (typeof saved.config?.prompt === 'string') config.prompt = saved.config.prompt.slice(0, 10000);
    if (Number.isInteger(saved.config?.seed) && saved.config.seed >= 0 && saved.config.seed <= 2147483647) config.seed = saved.config.seed;
    return { config, compare: saved.compare === true, endpoints: defaults.endpoints.map((endpoint, i) => {
      const stored = saved.endpoints?.[i];
      if (!stored) return endpoint;
      let baseUrl = endpoint.baseUrl;
      if (typeof stored.baseUrl === 'string') { try { mediaUrl(stored.baseUrl, 'models'); baseUrl = stored.baseUrl; } catch { /* Reject credentials embedded in URLs. */ } }
      return { ...endpoint, baseUrl, model: typeof stored.model === 'string' ? stored.model.slice(0, 256) : '', alias: typeof stored.alias === 'string' ? stored.alias.slice(0, 64) : '' };
    }) };
  } catch { return defaults; }
}
export function serializeMediaSettings(settings: MediaSettings): string {
  return JSON.stringify({ version: 1, config: settings.config, compare: settings.compare, endpoints: settings.endpoints.map(endpoint => {
    let baseUrl = '';
    try { mediaUrl(endpoint.baseUrl, 'models'); baseUrl = endpoint.baseUrl; } catch { /* Never persist URL credentials. */ }
    return { alias: endpoint.alias, model: endpoint.model, baseUrl };
  }) });
}
