import { LocalizedError } from '../i18n/message';
import { autoContext } from './prompt';
import type { BenchmarkConfig, EndpointConfig, StreamEvent } from './types';

export function endpointUrl(endpoint: EndpointConfig, resource: 'chat' | 'models' | 'show'): string {
  const url = new URL(endpoint.baseUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LocalizedError('error.endpointUrl');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (endpoint.protocol === 'ollama') {
    path = path.replace(/\/api\/(chat|tags|show)$/, '').replace(/\/api$/, '');
    url.pathname = `${path}/api/${resource === 'models' ? 'tags' : resource}`;
  } else {
    path = path.replace(/\/(chat\/completions|models)$/, '');
    if (!path) path = '/v1';
    url.pathname = `${path}/${resource === 'chat' ? 'chat/completions' : 'models'}`;
  }
  return url.toString();
}

export function requestBody(endpoint: EndpointConfig, config: BenchmarkConfig, prompt: string): Record<string, unknown> {
  const body: Record<string, unknown> = { model: endpoint.model.trim(), messages: [{ role: 'user', content: prompt }], stream: true };
  if (endpoint.protocol === 'ollama') {
    const options: Record<string, number> = { num_predict: config.outputTokens, num_ctx: endpoint.contextLength ?? autoContext(config.inputTokens, config.outputTokens) };
    if (config.temperature !== null) options.temperature = config.temperature;
    body.options = options;
    if (config.thinking !== 'default') body.think = config.thinking === 'on';
  } else {
    body[endpoint.maxTokensField] = config.outputTokens;
    if (endpoint.includeUsage) body.stream_options = { include_usage: true };
    if (config.temperature !== null) body.temperature = config.temperature;
    if (config.thinking !== 'default') {
      if (endpoint.thinkingFormat === 'qwen') body.chat_template_kwargs = { enable_thinking: config.thinking === 'on' };
      else body.reasoning_effort = config.thinking === 'on' ? 'medium' : 'none';
    }
  }
  return body;
}

function headers(endpoint: EndpointConfig): HeadersInit {
  return { 'Content-Type': 'application/json', ...(endpoint.apiKey.trim() ? { Authorization: `Bearer ${endpoint.apiKey.trim()}` } : {}) };
}

async function assertResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const text = (await response.text()).slice(0, 1000);
  let detail: string = text;
  try { const data = JSON.parse(text); detail = String(typeof data.error === 'string' ? data.error : data.error?.message ?? data.message ?? text); } catch { /* Plain-text upstream error. */ }
  throw detail ? new LocalizedError('error.http', { status: response.status, detail }) : new LocalizedError('error.httpBare', { status: response.status });
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let pos: number;
      while ((pos = buffer.indexOf('\n')) !== -1) {
        yield buffer.slice(0, pos).replace(/\r$/, '');
        buffer = buffer.slice(pos + 1);
      }
      if (buffer.length > 2_000_000) throw new LocalizedError('error.streamChunkTooLarge');
      if (done) break;
    }
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of lines(body)) {
    if (line === '') { if (data.length) yield data.join('\n'); data = []; }
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) yield data.join('\n');
}

function parseObject(raw: string): Record<string, any> {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new LocalizedError('error.streamInvalidJson'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LocalizedError('error.streamBadFormat');
  const object = data as Record<string, any>;
  if (object.error) throw typeof object.error === 'string' ? new Error(object.error) : object.error.message ? new Error(object.error.message) : new LocalizedError('error.endpointError');
  return object;
}

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const textValue = (value: unknown): string => typeof value === 'string' ? value : '';

export async function* parseStream(protocol: EndpointConfig['protocol'], body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  let reason: string | undefined;
  if (protocol === 'openai') {
    for await (const raw of sseData(body)) {
      if (raw.trim() === '[DONE]') { yield { type: 'done', reason }; return; }
      const data = parseObject(raw);
      const choice = data.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const text = textValue(delta.reasoning ?? delta.reasoning_content) + textValue(delta.content);
        if (text) yield { type: 'text', text };
      }
      if (data.usage) yield { type: 'usage', usage: {
        input: count(data.usage.prompt_tokens), output: count(data.usage.completion_tokens),
        cachedInput: count(data.usage.prompt_tokens_details?.cached_tokens), reasoning: count(data.usage.completion_tokens_details?.reasoning_tokens),
      } };
      if (choice?.finish_reason != null) reason = String(choice.finish_reason);
    }
    // Some compatible servers finish with finish_reason and omit the sentinel.
    if (reason) { yield { type: 'done', reason }; return; }
  } else {
    for await (const line of lines(body)) {
      if (!line.trim()) continue;
      const data = parseObject(line);
      const text = textValue(data.message?.thinking) + textValue(data.message?.content);
      if (text) yield { type: 'text', text };
      if (data.done === true) {
        yield { type: 'usage', usage: { input: count(data.prompt_eval_count), output: count(data.eval_count), cachedInput: count(data.prompt_eval_cached_count) }, timing: {
          loadNs: count(data.load_duration), prefillNs: count(data.prompt_eval_duration), decodeNs: count(data.eval_duration), totalNs: count(data.total_duration),
        } };
        yield { type: 'done', reason: data.done_reason };
        return;
      }
    }
  }
  throw new LocalizedError('error.streamEnded');
}

export async function* streamCompletion(endpoint: EndpointConfig, config: BenchmarkConfig, prompt: string, signal: AbortSignal, fetcher: typeof fetch = fetch): AsyncGenerator<StreamEvent> {
  const response = await fetcher(endpointUrl(endpoint, 'chat'), {
    method: 'POST', headers: headers(endpoint), body: JSON.stringify(requestBody(endpoint, config, prompt)), signal, cache: 'no-store',
  });
  await assertResponse(response);
  if (!response.body) throw new LocalizedError('error.noStream');
  yield* parseStream(endpoint.protocol, response.body);
}

export async function discoverModels(endpoint: EndpointConfig): Promise<string[]> {
  const response = await fetch(endpointUrl(endpoint, 'models'), { headers: endpoint.apiKey.trim() ? { Authorization: `Bearer ${endpoint.apiKey.trim()}` } : {}, signal: AbortSignal.timeout(15000), cache: 'no-store' });
  await assertResponse(response);
  const data = await response.json();
  const list = endpoint.protocol === 'ollama' ? data.models?.map((m: any) => m.name) : data.data?.map((m: any) => m.id);
  if (!Array.isArray(list)) throw new LocalizedError('error.modelListFormat');
  return list.filter((model): model is string => typeof model === 'string');
}

export async function inspectModel(endpoint: EndpointConfig): Promise<{ context?: number; thinking: boolean; thinkingValues?: (boolean | string)[] }> {
  const response = await fetch(endpointUrl(endpoint, 'show'), { method: 'POST', headers: headers(endpoint), body: JSON.stringify({ model: endpoint.model }), signal: AbortSignal.timeout(15000), cache: 'no-store' });
  await assertResponse(response);
  const data = await response.json();
  const context = Object.entries(data.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1];
  return { context: count(context), thinking: data.capabilities?.includes('thinking') ?? false, thinkingValues: data.thinking?.values };
}
