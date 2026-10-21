import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultMediaSettings, restoreMediaSettings, serializeMediaSettings } from '../../src/lib/media-config';
import { fetchMediaAsset, imageBody, imageAsset, mediaUrl, videoBody } from '../../src/lib/media-protocol';
import { mediaMetrics, startMediaBenchmark, videoRtf } from '../../src/lib/media-benchmark';
import type { MediaRun } from '../../src/lib/media-types';

const defaults = defaultMediaSettings('image', 'test prompt');
const config = defaults.config;
const endpoint = { ...defaults.endpoints[0], model: 'fixture', apiKey: 'memory-only' };
const video = { ...config, mode: 'video' as const };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const image = { data: [{ b64_json: btoa('fixture bytes') }], inference_time_s: 1.5 };
afterEach(() => vi.useRealTimers());

describe('media protocol', () => {
  it.each([
    ['http://localhost:8000', 'http://localhost:8000/v1/videos'],
    ['https://host/prefix/v1/', 'https://host/prefix/v1/videos'],
    ['https://host/prefix/images/generations', 'https://host/prefix/videos'],
    ['https://host/v1/videos/sync', 'https://host/v1/videos'],
  ])('normalizes %s', (base, expected) => expect(mediaUrl(base, 'videos')).toBe(expected));
  it('rejects credentials and unsafe URLs, and encodes task identifiers', () => {
    for (const base of ['ftp://host', 'https://user:secret@host', 'https://host?key=secret', 'broken']) expect(() => mediaUrl(base, 'videos')).toThrow();
    expect(mediaUrl(endpoint.baseUrl, 'videos', 'a/b', true)).toBe('http://localhost:8000/v1/videos/a%2Fb/content');
  });
  it('sends one image and top-level diffusion parameters; video uses FormData without frame conflicts', () => {
    expect(imageBody({ ...config, seed: 0 }, endpoint)).toEqual({ model: 'fixture', prompt: 'test prompt', n: 1, size: '1024x1024', num_inference_steps: 20, seed: 0, response_format: 'b64_json' });
    expect(Object.fromEntries(videoBody(video, endpoint))).toEqual({ model: 'fixture', prompt: 'test prompt', size: '1024x1024', seconds: '5', fps: '16', num_inference_steps: '20' });
  });
  it('validates Base64 and URL assets', () => {
    expect(imageAsset(image, endpoint.baseUrl).base64).toBe(image.data[0].b64_json);
    expect(imageAsset({ data: [{ url: '/output.png' }] }, endpoint.baseUrl).url).toBe('http://localhost:8000/output.png');
    for (const body of [{ data: [] }, { data: [{ b64_json: '!!!' }] }, { data: [{ url: 'javascript:alert(1)' }] }]) expect(() => imageAsset(body, endpoint.baseUrl)).toThrow();
  });
  it('keeps authorization off third-party downloads, preserves it for protected video content', async () => {
    const calls: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => { calls.push(init); return new Response('asset', { headers: { 'Content-Type': 'image/png' } }); });
    const signal = new AbortController().signal;
    await fetchMediaAsset({ url: 'https://storage.example/img.png', mime: 'image/png' }, endpoint, signal, fetcher);
    await fetchMediaAsset({ url: 'http://localhost:8000/img.png', mime: 'image/png' }, endpoint, signal, fetcher);
    expect(calls[0].headers).toEqual({});
    expect(calls[1].headers).toEqual({ Authorization: 'Bearer memory-only' });
    expect(calls[1].redirect).toBe('error');
    await expect(fetchMediaAsset({ url: 'http://localhost:8000/file', mime: 'image/png' }, endpoint, signal, async () => new Response('html'))).rejects.toThrow();
  });
});

describe('media execution', () => {
  it('launches A/B concurrency together with identical inputs, sanitizing result keys', async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return response(image); });
    const run = startMediaBenchmark({ ...config, concurrency: 2 }, [endpoint, { ...endpoint, id: 'B' }], () => {}, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const result = await run.finished;
    expect(result.requests.map(r => r.status)).toEqual(['success', 'success', 'success', 'success']);
    expect(new Set(bodies.map(body => JSON.stringify(body))).size).toBe(1);
    expect(result.endpoints.every(e => !e.apiKey)).toBe(true);
  });
  it('polls queue and running states, stopping measurement before content download', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    let now = 0;
    const fetcher = vi.fn().mockResolvedValueOnce(response({ id: 'job', status: 'queued' }))
      .mockResolvedValueOnce(response({ id: 'job', status: 'in_progress' }))
      .mockImplementationOnce(async () => { now = 2500; return response({ id: 'job', status: 'completed', inference_time_s: 1.2 }); });
    const run = startMediaBenchmark(video, [endpoint], state => { states.push(state.requests[0].jobStatus ?? ''); }, { fetcher, clock: () => now });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await run.finished;
    expect(states).toContain('queued'); expect(states).toContain('in_progress');
    expect(result.requests[0]).toMatchObject({ status: 'success', endedAt: 2500, inferenceSeconds: 1.2, asset: { url: 'http://localhost:8000/v1/videos/job/content' } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('isolates failed requests without retrying generation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ detail: 'bad dimensions' }, 422)).mockResolvedValueOnce(response(image));
    const result = await startMediaBenchmark({ ...config, concurrency: 2 }, [endpoint], () => {}, { fetcher }).finished;
    expect(result.requests.map(r => r.status)).toEqual(['error', 'success']);
    expect(result.requests[0].error?.params?.detail).toBe('bad dimensions');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{ id: 'job', status: 'failed', error: { message: 'out of memory' } }, { id: 'job', status: 'unknown' }, { status: 'completed' }])('rejects failed or malformed jobs', async body => {
    const fetcher = vi.fn(async () => response(body));
    const result = await startMediaBenchmark(video, [endpoint], () => {}, { fetcher }).finished;
    expect(result.requests[0].status).toBe('error'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels an existing job and does not poll or fetch output afterward', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => response({ id: 'job', status: 'queued' }));
    const run = startMediaBenchmark(video, [endpoint], () => {}, { fetcher });
    await vi.advanceTimersByTimeAsync(0);
    run.cancel();
    expect((await run.finished).requests[0].status).toBe('cancelled');
    expect(fetcher.mock.calls).toHaveLength(2);
    expect((fetcher.mock.calls as unknown as [string, RequestInit][])[1][1].method).toBe('DELETE');
    await vi.advanceTimersByTimeAsync(5000); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('cleans up late create responses after cancellation without declaring success', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; })).mockResolvedValue(response({}));
    const run = startMediaBenchmark(video, [endpoint], () => {}, { fetcher });
    run.cancel(); resolve(response({ id: 'late-job', status: 'completed' }));
    const result = await run.finished;
    expect(result.requests[0].status).toBe('cancelled'); expect(result.requests[0].asset).toBeUndefined();
    expect(fetcher.mock.calls[1][1].method).toBe('DELETE');
  });
  it('times out polling jobs and attempts server cancellation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => response({ id: 'queued-job', status: 'queued' }));
    const run = startMediaBenchmark({ ...video, timeoutSeconds: 30 }, [endpoint], () => {}, { fetcher });
    await vi.advanceTimersByTimeAsync(30000);
    const result = await run.finished;
    expect(result.requests[0]).toMatchObject({ status: 'error', error: { key: 'error.timeout' } });
    expect((fetcher.mock.calls as unknown as [string, RequestInit][]).at(-1)![1].method).toBe('DELETE');
  });
  it('counts timeout as failure and aborts the fetch', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: any, init: any) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    const run = startMediaBenchmark({ ...config, timeoutSeconds: 30 }, [endpoint], () => {}, { fetcher });
    await vi.advanceTimersByTimeAsync(30000);
    expect((await run.finished).requests[0]).toMatchObject({ status: 'error', error: { key: 'error.timeout' } });
  });
  it('measures successful latency while including failed requests in round throughput', async () => {
    let now = 0;
    const callbacks: ((value: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { callbacks.push(resolve); }));
    let latest!: MediaRun;
    const run = startMediaBenchmark({ ...video, concurrency: 2 }, [endpoint], state => { latest = state; }, { fetcher, clock: () => now });
    now = 2000; callbacks[0](response({ id: 'done', status: 'completed' }));
    await vi.waitFor(() => expect(latest.requests[0].status).toBe('success'));
    now = 4000; callbacks[1](response({ detail: 'overloaded' }, 503));
    const result = await run.finished;
    expect(mediaMetrics(result, 'A')).toMatchObject({ success: 1, failed: 1, successRate: 50, mean: 2000, min: 2000, max: 2000, throughput: 15 });
    expect(videoRtf(result, 'A', {})).toEqual({ value: .4, estimated: true, mixed: false });
    expect(videoRtf(result, 'A', { 'A-1': { duration: 2 } })).toEqual({ value: 1, estimated: false, mixed: false });
    expect(videoRtf(result, 'A', { 'A-1': { duration: NaN } })).toMatchObject({ value: .4, estimated: true });
    const mixedRun = { ...result, requests: [...result.requests, { ...result.requests[0], id: 'A-3' }] };
    expect(videoRtf(mixedRun, 'A', { 'A-1': { duration: 2 } })).toMatchObject({ estimated: true, mixed: true });
  });
});

describe('media configuration', () => {
  it('stores each mode separately and strips credentials and untrusted fields on restoration', () => {
    const saved = serializeMediaSettings({ config, compare: true, endpoints: [endpoint] });
    expect(saved).not.toContain('memory-only');
    const restored = restoreMediaSettings('image', 'default', saved);
    expect(restored.config).toEqual(config); expect(restored.compare).toBe(true);
    expect(restored.endpoints[0].apiKey).toBe('');
    const unsafe = JSON.stringify({ version: 1, config: { mode: 'image', concurrency: 100, seed: -1, prompt: 'custom' }, endpoints: [{ baseUrl: 'https://key:secret@example.com', apiKey: 'bad', protocol: 'ollama' }] });
    const safe = restoreMediaSettings('video', 'default', unsafe);
    expect(safe.config).toMatchObject({ mode: 'video', concurrency: 1, seed: null, prompt: 'custom' });
    expect(safe.endpoints[0]).toMatchObject({ protocol: 'openai', apiKey: '', baseUrl: 'http://localhost:8091/v1' });
    expect(restoreMediaSettings('video', 'default', '{').config.timeoutSeconds).toBe(1800);
  });
});
