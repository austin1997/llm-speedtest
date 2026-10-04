import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBenchmark } from '../../src/lib/benchmark';
import { config, endpoint } from './fixtures';
import type { RunState } from '../../src/lib/types';

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
  it('awards the first fully completed endpoint rather than a finish-line estimate or individual request', async () => {
    vi.useFakeTimers();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }))) as unknown as typeof fetch;
    let now = 0;
    let latest!: RunState;
    const run = startBenchmark({ ...config, concurrency: 2, outputTokens: 128 }, [endpoint, { ...endpoint, id: 'B' }], 'x', state => { latest = state; }, { fetcher, clock: () => now });
    const emit = (index: number, object: unknown) => streams[index].enqueue(new TextEncoder().encode(JSON.stringify(object) + '\n'));
    now = 10;
    emit(0, { message: { content: 'a'.repeat(2048) } });
    await vi.advanceTimersByTimeAsync(100);
    expect(latest.requests[0].estimatedTokens).toBeGreaterThanOrEqual(256);
    expect(latest.raceWinner).toBeUndefined();
    async function finish(index: number, at: number) {
      now = at;
      emit(index, { done: true, eval_count: 24 }); streams[index].close();
      await vi.advanceTimersByTimeAsync(100);
    }
    await finish(0, 20); // A finishes one request first, but A-2 is still active.
    expect(latest.raceWinner).toBeUndefined();
    await finish(2, 30);
    expect(latest.raceWinner).toBeUndefined();
    const beforeWinner = latest;
    await finish(3, 40);
    expect(latest.raceWinner).toEqual({ endpointId: 'B', at: 40 });
    expect(beforeWinner.raceWinner).toBeUndefined();
    await finish(1, 50);
    expect((await run.finished).raceWinner).toEqual({ endpointId: 'B', at: 40 });
  });
  it('does not award an endpoint with a failed request or a cancelled round', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => ++calls === 1 ? new Response('overloaded', { status: 503 }) : new Response('{"done":true,"eval_count":0}\n')) as unknown as typeof fetch;
    const completed = await startBenchmark({ ...config, concurrency: 2 }, [endpoint, { ...endpoint, id: 'B' }], 'x', () => {}, { fetcher }).finished;
    expect(completed.raceWinner?.endpointId).toBe('B');
    const waiting = vi.fn((_url: any, init: any) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) as unknown as typeof fetch;
    const cancelled = startBenchmark({ ...config, concurrency: 2 }, [endpoint, { ...endpoint, id: 'B' }], 'x', () => {}, { fetcher: waiting });
    cancelled.cancel();
    expect((await cancelled.finished).raceWinner).toBeUndefined();
  });
  it('holds the greatest corrected distance during calibration and resumes only after catching up', async () => {
    vi.useFakeTimers();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }))) as unknown as typeof fetch;
    let latest!: RunState;
    const run = startBenchmark({ ...config, concurrency: 2, outputTokens: 128 }, [endpoint], 'x', state => { latest = state; }, { fetcher });
    async function emit(index: number, object: unknown) {
      streams[index].enqueue(new TextEncoder().encode(JSON.stringify(object) + '\n'));
      await vi.advanceTimersByTimeAsync(100);
    }
    await emit(0, { message: { content: 'abcd'.repeat(100) } });
    await emit(1, { message: { content: 'abcd'.repeat(5) } });
    const beforeCorrection = latest;
    expect(latest.raceDistance.A).toBe(105);
    await emit(0, { done: true, eval_count: 20 });
    expect(latest.raceDistance.A).toBe(105);
    await emit(1, { message: { content: 'abcd'.repeat(40) } });
    expect(latest.raceDistance.A).toBe(105);
    await emit(1, { message: { content: 'abcd'.repeat(40) } });
    expect(latest.raceDistance.A).toBe(105);
    await emit(1, { message: { content: 'abcd' } });
    expect(latest.raceDistance.A).toBe(106);
    await emit(1, { done: true, eval_count: 100 });
    expect((await run.finished).raceDistance.A).toBe(120);
    expect(beforeCorrection.raceDistance.A).toBe(105);
  });
});
