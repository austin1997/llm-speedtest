import { endpointUrl } from './protocol';
import type { EndpointConfig, TokenCounterCapability } from './types';

const aborted = () => new DOMException('Aborted', 'AbortError');
export const counterSource = (counter: TokenCounterCapability) => counter.kind === 'responses' ? 'calibrated' as const : 'counted' as const;
export const counterLabel = (counter: TokenCounterCapability) => counter.kind === 'responses' ? '输入 API 差值校准' : '端点原文本分词';

export function tokenCounterUrls(endpoint: EndpointConfig) {
  const base = new URL(endpointUrl(endpoint, 'chat'));
  base.pathname = base.pathname.replace(/\/chat\/completions$/, '');
  const rooted = new URL(base); rooted.pathname = rooted.pathname.replace(/\/v1$/, '') + '/tokenize';
  const versioned = new URL(base); versioned.pathname += '/tokenize';
  const responses = new URL(base); responses.pathname += '/responses/input_tokens';
  return { tokenize: [...new Set([rooted.toString(), versioned.toString()])], responses: responses.toString() };
}

export async function countText(endpoint: EndpointConfig, counter: TokenCounterCapability, text: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<number> {
  if (signal.aborted) throw aborted();
  if (new URL(counter.url).origin !== new URL(endpointUrl(endpoint, 'chat')).origin) throw new Error('计数接口必须与推理端点同源。');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 1200);
  const body = counter.kind === 'vllm' ? { model: endpoint.model.trim(), prompt: text, add_special_tokens: false }
    : counter.kind === 'llama' ? { content: text, add_special: false, parse_special: false }
    : { model: endpoint.model.trim(), input: [{ role: 'assistant', content: text }] };
  try {
    const response = await fetcher(counter.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(endpoint.apiKey.trim() ? { Authorization: `Bearer ${endpoint.apiKey.trim()}` } : {}) }, body: JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`计数 API HTTP ${response.status}`);
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('计数 API 响应格式不正确。');
    const count = counter.kind === 'responses' ? data.input_tokens : data.count ?? (Array.isArray(data.tokens) ? data.tokens.length : undefined);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('计数 API 未返回有效 token 数。');
    return Math.max(0, count - counter.baseline);
  } catch (error) {
    if (timedOut) throw new Error('计数 API 超时，已回退估算。');
    throw error;
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}

/** Configuration-only probes; never included in inference start/end timestamps. */
export async function detectTokenCounter(endpoint: EndpointConfig, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<TokenCounterCapability | null> {
  if (endpoint.protocol !== 'openai' || endpoint.useTokenApi === false) return null;
  const urls = tokenCounterUrls(endpoint);
  const probe = async (kind: TokenCounterCapability['kind'], url: string) => {
    const candidate: TokenCounterCapability = { kind, url, baseline: 0 };
    try {
      const positive = await countText(endpoint, candidate, 'LLM Speedtest 中文 token probe.', signal, fetcher);
      if (positive === 0) return null;
      const baseline = await countText(endpoint, candidate, '', signal, fetcher);
      if (positive <= baseline || kind !== 'responses' && baseline !== 0) return null;
      return { ...candidate, baseline };
    } catch (error) { if (signal.aborted) throw error; return null; }
  };
  const raw = urls.tokenize.map(async url => await probe('vllm', url) ?? await probe('llama', url));
  const found = await Promise.all([...raw, probe('responses', urls.responses)]);
  if (signal.aborted) throw aborted();
  return found.find(counter => counter !== null) ?? null;
}

/** Bound auxiliary load per endpoint; cache small identical prefixes across requests. */
export class TokenCountPool {
  private active = 0;
  private queue: (() => void)[] = [];
  private cache = new Map<string, number>();
  constructor(private endpoint: EndpointConfig, private capability: TokenCounterCapability, private fetcher: typeof fetch = fetch) {}
  count(text: string, signal: AbortSignal): Promise<number> {
    if (signal.aborted) return Promise.reject(aborted());
    const cached = this.cache.get(text);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      let started = false;
      const cancel = () => { if (!started) reject(aborted()); };
      signal.addEventListener('abort', cancel, { once: true });
      this.queue.push(() => {
        started = true; signal.removeEventListener('abort', cancel);
        if (signal.aborted) { reject(aborted()); return; }
        this.active++;
        void countText(this.endpoint, this.capability, text, signal, this.fetcher).then(count => {
          if (text.length <= 65536) {
            this.cache.set(text, count);
            if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
          }
          resolve(count);
        }, reject).finally(() => { this.active--; this.drain(); });
      });
      this.drain();
    });
  }
  private drain() { while (this.active < 2 && this.queue.length) this.queue.shift()!(); }
}

export interface CountSnapshot { text: string; at: number; estimated: number; scale: number }

/** Coalesce prefixes without awaiting a tokenizer in the inference stream reader. */
export class LiveTokenCounter {
  private controller = new AbortController();
  private desired: CountSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private operation: Promise<void> | null = null;
  private closed = false;
  private finishing = false;
  private countedText = '';
  private requestedEstimate = 0;
  private cancel = () => this.stop();
  constructor(private pool: TokenCountPool, private parent: AbortSignal, private onCount: (tokens: number, snapshot: CountSnapshot) => void, private onError: (error: unknown) => void, private batchSize = 32) {
    parent.addEventListener('abort', this.cancel, { once: true });
    if (parent.aborted) this.stop();
  }
  observe(snapshot: CountSnapshot) {
    if (this.closed) return;
    if (!this.desired && (snapshot.estimated - this.requestedEstimate) * snapshot.scale < this.batchSize) return;
    this.desired = snapshot;
    if (!this.operation && this.timer === null) this.schedule(0);
  }
  private schedule(delay: number) {
    this.timer = setTimeout(() => { this.timer = null; if (!this.closed && this.desired) this.operation = this.execute(); }, delay);
  }
  private async execute() {
    const snapshot = this.desired!; this.desired = null;
    this.requestedEstimate = snapshot.estimated;
    try {
      const tokens = await this.pool.count(snapshot.text, this.controller.signal);
      if (!this.closed) { this.countedText = snapshot.text; this.onCount(tokens, snapshot); }
    } catch (error) {
      if (!this.closed && !this.parent.aborted) this.onError(error);
      this.stop();
    } finally {
      this.operation = null;
      if (!this.closed && !this.finishing && this.desired) this.schedule(250);
    }
  }
  async finish(snapshot: CountSnapshot): Promise<boolean> {
    if (this.closed) return this.countedText === snapshot.text;
    this.finishing = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (snapshot.text !== this.countedText) this.desired = snapshot;
    let expired = false;
    const timeout = setTimeout(() => { expired = true; this.onError(new Error('最终文本计数超时，已回退估算。')); this.stop(); }, 1500);
    try {
      while (!this.closed && (this.operation || this.desired)) {
        if (!this.operation) this.operation = this.execute();
        await this.operation;
      }
      return !expired && this.countedText === snapshot.text;
    } finally { clearTimeout(timeout); this.stop(); }
  }
  stop() {
    this.closed = true; this.desired = null;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.controller.abort(); this.parent.removeEventListener('abort', this.cancel);
  }
}
