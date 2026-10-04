import { afterEach, describe, expect, it, vi } from 'vitest';
import { countText, detectTokenCounter, LiveTokenCounter, TokenCountPool, tokenCounterUrls } from '../../src/lib/token-counter';
import type { CountSnapshot } from '../../src/lib/token-counter';
import type { TokenCounterCapability } from '../../src/lib/types';
import { endpoint } from './fixtures';

const openai = { ...endpoint, protocol: 'openai' as const, baseUrl: 'https://example.com/prefix/v1', apiKey: 'test-memory-key' };
const raw: TokenCounterCapability = { kind: 'vllm', url: 'https://example.com/prefix/tokenize', baseline: 0 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const snapshot = (text: string, estimated: number, at = estimated * 100, scale = 1): CountSnapshot => ({ text, estimated, at, scale });
afterEach(() => vi.useRealTimers());

describe('token count adapters', () => {
  it('keeps custom prefixes for root, versioned and full Chat Completions addresses', () => {
    expect(tokenCounterUrls({ ...openai, baseUrl: openai.baseUrl + '/chat/completions/' })).toEqual({ tokenize: ['https://example.com/prefix/tokenize', 'https://example.com/prefix/v1/tokenize'], responses: 'https://example.com/prefix/v1/responses/input_tokens' });
  });
  it('prefers raw vLLM tokenization, disables special tokens and uses the endpoint credentials', async () => {
    const bodies: Record<string, any>[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body);
      expect(init.headers.Authorization).toBe('Bearer test-memory-key');
      return typeof body.prompt === 'string' ? json({ count: body.prompt.length }) : json({ input_tokens: 8 + body.input[0].content.length });
    }) as unknown as typeof fetch;
    const found = await detectTokenCounter(openai, new AbortController().signal, fetcher);
    expect(found).toEqual(raw);
    expect(bodies.filter(body => 'prompt' in body).every(body => body.add_special_tokens === false && body.model === 'test')).toBe(true);
  });
  it('supports llama.cpp token arrays and never accepts an ignored prompt as a successful probe', async () => {
    const fetcher = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (typeof body.content !== 'string') return json({ tokens: [] });
      expect(body.add_special).toBe(false); expect(body.parse_special).toBe(false);
      return json({ tokens: Array.from(body.content).map((_, i) => i) });
    }) as unknown as typeof fetch;
    const found = await detectTokenCounter(openai, new AbortController().signal, fetcher);
    expect(found?.kind).toBe('llama');
    expect(await countText(openai, found!, '中文🚗', new AbortController().signal, fetcher)).toBe(3);
  });
  it('subtracts a Responses message baseline instead of counting framing on every prefix', async () => {
    const fetcher = vi.fn(async (url: any, init: any) => {
      if (!String(url).endsWith('/responses/input_tokens')) return json({}, 404);
      const body = JSON.parse(init.body);
      expect(body.input[0].role).toBe('assistant');
      return json({ object: 'response.input_tokens', input_tokens: 7 + Array.from(body.input[0].content).length });
    }) as unknown as typeof fetch;
    const found = await detectTokenCounter(openai, new AbortController().signal, fetcher);
    expect(found).toMatchObject({ kind: 'responses', baseline: 7 });
    expect(await countText(openai, found!, '中文', new AbortController().signal, fetcher)).toBe(2);
  });
  it('rejects invalid counters, framing on raw endpoints and cross-origin credentials', async () => {
    expect(await detectTokenCounter(openai, new AbortController().signal, (async () => json({}, 404)) as typeof fetch)).toBeNull();
    expect(await detectTokenCounter(openai, new AbortController().signal, (async () => json({ count: 1 })) as typeof fetch)).toBeNull();
    await expect(countText(openai, raw, 'x', new AbortController().signal, (async () => json({ count: -1 })) as typeof fetch)).rejects.toThrow('有效 token');
    const fetcher = vi.fn();
    await expect(countText(openai, { ...raw, url: 'https://different.example/tokenize' }, 'x', new AbortController().signal, fetcher as unknown as typeof fetch)).rejects.toThrow('同源');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('times out auxiliary requests and propagates cancellation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: any, init: any) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) as unknown as typeof fetch;
    const timeout = expect(countText(openai, raw, 'x', new AbortController().signal, fetcher)).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(1200); await timeout;
    const controller = new AbortController();
    const cancelled = expect(countText(openai, raw, 'x', controller.signal, fetcher)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await cancelled;
  });
});

describe('batched live counting', () => {
  it('queries full prefixes only after enough new tokens, including a final short batch', async () => {
    vi.useFakeTimers();
    const queried: string[] = [], counts: number[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => {
      const text = JSON.parse(init.body).prompt; queried.push(text);
      return json({ count: text === 'hello' ? 1 : text === 'hello world' ? 2 : 3 });
    }) as unknown as typeof fetch;
    const counter = new LiveTokenCounter(new TokenCountPool(openai, raw, fetcher), new AbortController().signal, count => counts.push(count), error => { throw error; }, 8);
    counter.observe(snapshot('he', 4)); await vi.advanceTimersByTimeAsync(1);
    expect(queried).toEqual([]);
    counter.observe(snapshot('hello', 8)); await vi.advanceTimersByTimeAsync(1);
    counter.observe(snapshot('hello wor', 12)); await vi.advanceTimersByTimeAsync(1);
    expect(queried).toEqual(['hello']);
    counter.observe(snapshot('hello world', 16)); await vi.advanceTimersByTimeAsync(1);
    expect(queried).toEqual(['hello', 'hello world']);
    expect(counts).toEqual([1, 2]); // Tokenizing "he" and "llo" separately would overcount.
    expect(await counter.finish(snapshot('hello world!', 17))).toBe(true);
    expect(queried.at(-1)).toBe('hello world!');
  });
  it('bounds endpoint counting concurrency, caches results and aborts queued work', async () => {
    vi.useFakeTimers();
    let active = 0, maximum = 0;
    const fetcher = vi.fn((_url: any, init: any) => new Promise<Response>((resolve, reject) => {
      active++; maximum = Math.max(maximum, active);
      const timer = setTimeout(() => { active--; resolve(json({ count: 3 })); }, 100);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); active--; reject(new DOMException('Aborted', 'AbortError')); });
    })) as unknown as typeof fetch;
    const pool = new TokenCountPool(openai, raw, fetcher);
    const signal = new AbortController().signal;
    const completed = Promise.all(['one', 'two', 'three', 'four'].map(text => pool.count(text, signal)));
    await vi.advanceTimersByTimeAsync(250); await completed;
    expect(maximum).toBe(2);
    await pool.count('one', signal); expect(fetcher).toHaveBeenCalledTimes(4);
    const controller = new AbortController();
    const cancelled = Promise.allSettled(['five', 'six', 'seven'].map(text => pool.count(text, controller.signal)));
    controller.abort(); await cancelled;
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('does not update counters from late responses after stop', async () => {
    vi.useFakeTimers();
    const onCount = vi.fn();
    const fetcher = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return json({ count: 9 }); }) as unknown as typeof fetch;
    const counter = new LiveTokenCounter(new TokenCountPool(openai, raw, fetcher), new AbortController().signal, onCount, vi.fn(), 8);
    counter.observe(snapshot('abcdefgh', 8)); await vi.advanceTimersByTimeAsync(1);
    counter.stop(); await vi.advanceTimersByTimeAsync(200);
    expect(onCount).not.toHaveBeenCalled();
  });
});
