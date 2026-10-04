import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBenchmark } from '../../src/lib/benchmark';
import { config, endpoint } from './fixtures';

afterEach(() => vi.useRealTimers());
describe('single-round execution', () => {
  it('launches every endpoint and concurrency request with the same frozen prompt', async () => {
    const bodies: any[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response('{"message":{"thinking":"thinking", "content":"answer"}}\n{"done":true,"eval_count":6}\n');
    }) as unknown as typeof fetch;
    const input = { ...config, concurrency: 2 };
    const run = startBenchmark(input, [endpoint, { ...endpoint, id: 'B', apiKey: 'not-in-results' }], 'the preview', () => {}, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(4);
    input.concurrency = 9;
    const result = await run.finished;
    expect(result.requests.every(r => r.status === 'success' && r.text === 'thinkinganswer')).toBe(true);
    expect(result.config.concurrency).toBe(2);
    expect(bodies.every(b => b.messages[0].content === 'the preview')).toBe(true);
    expect(result.endpoints[1].apiKey).toBe('');
  });
  it('keeps other requests running when one upstream fails, without retries', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => ++calls === 1 ? new Response('{"error":"overloaded"}', { status: 503 }) : new Response('{"done":true,"eval_count":0}\n')) as unknown as typeof fetch;
    const result = await startBenchmark({ ...config, concurrency: 2 }, [endpoint], 'x', () => {}, { fetcher }).finished;
    expect(result.requests.map(r => r.status)).toEqual(['error', 'success']);
    expect(result.requests[0].error).toContain('503');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('aborts all active requests when cancelled', async () => {
    const fetcher = vi.fn((_url: any, init: any) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) as unknown as typeof fetch;
    const run = startBenchmark({ ...config, concurrency: 2 }, [endpoint], 'x', () => {}, { fetcher });
    run.cancel();
    const result = await run.finished;
    expect(result.requests.every(r => r.status === 'cancelled')).toBe(true);
  });
  it('distinguishes timeout from user cancellation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: any, init: any) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) as unknown as typeof fetch;
    const run = startBenchmark({ ...config, timeoutSeconds: 30 }, [endpoint], 'x', () => {}, { fetcher });
    await vi.advanceTimersByTimeAsync(30000);
    const result = await run.finished;
    expect(result.requests[0].status).toBe('error');
    expect(result.requests[0].error).toContain('30 秒');
  });
  it('preserves partial output after a truncated stream', async () => {
    const fetcher = vi.fn(async () => new Response('{"message":{"content":"partial"}}\n')) as unknown as typeof fetch;
    const result = await startBenchmark(config, [endpoint], 'x', () => {}, { fetcher }).finished;
    expect(result.requests[0]).toMatchObject({ status: 'error', text: 'partial' });
  });
});
