import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultMediaSettings, resolutions, restoreMediaSettings, serializeMediaSettings, validateMediaConfig } from '../../src/lib/media-config';
import { aspectRatio, fetchMediaAsset, imageBody, imageAssets, mediaUrl, videoBody, videoProgress } from '../../src/lib/media-protocol';
import { mediaMetrics, startMediaBenchmark, videoRtf } from '../../src/lib/media-benchmark';
import type { MediaRun } from '../../src/lib/media-types';

const defaults = defaultMediaSettings('image', 'test prompt');
const config = defaults.config;
const endpoint = { ...defaults.endpoints[0], model: 'fixture', apiKey: 'memory-only' };
const video = defaultMediaSettings('video', 'test prompt').config;
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
  it('sends single-image requests with matching seed sequences; video uses FormData without frame conflicts', () => {
    expect(imageBody({ ...config, seed: 0 }, endpoint)).toEqual({ model: 'fixture', prompt: 'test prompt', n: 1, size: '1024x576', num_inference_steps: 20, seed: 0, response_format: 'b64_json' });
    expect(imageBody({ ...config, batchSize: 16 }, endpoint).n).toBe(1);
    expect(imageBody({ ...config, seed: 42 }, endpoint, 2).seed).toBe(44);
    expect(imageBody({ ...config, seed: 2147483647 }, endpoint, 1).seed).toBe(0);
    expect(imageBody(config, endpoint, 2)).not.toHaveProperty('seed');
    expect(Object.fromEntries(videoBody(video, endpoint))).toEqual({ model: 'fixture', prompt: 'test prompt', size: '1280x720', seconds: '5', fps: '24', num_inference_steps: '20', extra_params: JSON.stringify({ aspect_ratio: '16:9' }) });
  });
  it.each([[1280, 720, '16:9'], [720, 1280, '9:16'], [640, 480, '4:3'], [1024, 1024, '1:1'], [896, 512, '7:4']] as const)('derives aspect ratio from %s × %s', (width, height, ratio) => {
    expect(aspectRatio(width, height)).toBe(ratio);
    expect(JSON.parse(String(videoBody({ ...video, width, height }, endpoint).get('extra_params')))).toEqual({ aspect_ratio: ratio });
  });
  it('uses only valid server percentages and treats completed jobs as 100 percent', () => {
    for (const progress of [0, .5, 37, 100]) expect(videoProgress({ status: 'in_progress', progress })).toBe(progress);
    for (const progress of [undefined, null, '50', -1, 101, NaN, Infinity, {}]) expect(videoProgress({ status: 'in_progress', progress })).toBeUndefined();
    expect(videoProgress({ status: 'completed' })).toBe(100);
    expect(videoProgress({ status: 'completed', progress: 0 })).toBe(100);
  });
  it('validates Base64 and URL assets', () => {
    expect(imageAssets(image, endpoint.baseUrl)[0].base64).toBe(image.data[0].b64_json);
    expect(imageAssets({ data: [image.data[0], { url: '/output.png' }] }, endpoint.baseUrl)).toEqual([
      { base64: image.data[0].b64_json, mime: 'image/png' }, { url: 'http://localhost:8000/output.png', mime: 'image/png' },
    ]);
    for (const body of [{ data: [] }, { data: {} }, { data: [{ b64_json: '!!!' }] }, { data: [image.data[0], { url: 'javascript:alert(1)' }] }]) expect(() => imageAssets(body, endpoint.baseUrl)).toThrow();
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
  it('launches one request per endpoint with identical inputs, ignoring legacy concurrency', async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return response(image); });
    const legacyConfig = { ...config, concurrency: 16 };
    const run = startMediaBenchmark(legacyConfig, [endpoint, { ...endpoint, id: 'B' }], () => {}, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const result = await run.finished;
    expect(result.requests.map(r => r.status)).toEqual(['success', 'success']);
    expect(new Set(bodies.map(body => JSON.stringify(body))).size).toBe(1);
    expect(result.endpoints.every(e => !e.apiKey)).toBe(true);
  });
  it('publishes each completed image immediately, including out-of-order responses, and measures individual latency', async () => {
    let now = 0;
    let latest!: MediaRun;
    const callbacks: ((value: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { callbacks.push(resolve); }));
    const run = startMediaBenchmark({ ...config, batchSize: 3 }, [endpoint], state => { latest = state; }, { fetcher, clock: () => now });
    expect(fetcher).toHaveBeenCalledTimes(3);
    now = 1000; callbacks[1](response({ data: [{ url: '/second.png' }] }));
    await vi.waitFor(() => expect(latest.requests[1].status).toBe('success'));
    expect(latest.phase).toBe('running');
    expect(latest.requests.map(r => r.status)).toEqual(['running', 'success', 'running']);
    expect(latest.requests[1]).toMatchObject({ id: 'A-2', assets: [{ url: 'http://localhost:8000/second.png' }] });
    expect(mediaMetrics(latest, 'A')).toMatchObject({ count: 3, success: 1, throughput: 1, mean: 1000 });
    const firstPreview = latest.requests[1].assets;
    now = 2000; callbacks[0](response(image));
    await vi.waitFor(() => expect(latest.requests[0].status).toBe('success'));
    expect(latest.requests[1].assets).toBe(firstPreview);
    now = 4000; callbacks[2](response(image));
    const result = await run.finished;
    expect(mediaMetrics(result, 'A')).toMatchObject({ count: 3, success: 3, successRate: 100, mean: 7000 / 3, min: 1000, max: 4000, throughput: .75 });
  });
  it('launches 16 single-image requests per endpoint and uses identical A/B seed sequences', async () => {
    const bodies: ReturnType<typeof imageBody>[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return response(image); });
    const result = await startMediaBenchmark({ ...config, batchSize: 16, seed: 2147483640 }, [endpoint, { ...endpoint, id: 'B' }], () => {}, { fetcher }).finished;
    expect(fetcher).toHaveBeenCalledTimes(32);
    expect(result.requests).toHaveLength(32);
    expect(result.requests.every(r => r.status === 'success')).toBe(true);
    expect(bodies.every(body => body.n === 1)).toBe(true);
    expect(bodies.slice(0, 16)).toEqual(bodies.slice(16));
    expect(new Set(bodies.slice(0, 16).map(body => body.seed)).size).toBe(16);
    expect(bodies[8].seed).toBe(0);
  });
  it('retains completed images when another image fails and remaining generation is cancelled', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(image)).mockResolvedValueOnce(response({ detail: 'overloaded' }, 503))
      .mockImplementationOnce((_url: any, init: any) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    let latest!: MediaRun;
    const run = startMediaBenchmark({ ...config, batchSize: 3 }, [endpoint], state => { latest = state; }, { fetcher });
    await vi.waitFor(() => expect(latest.requests.map(r => r.status)).toEqual(['success', 'error', 'running']));
    run.cancel();
    const result = await run.finished;
    expect(result.requests.map(r => r.status)).toEqual(['success', 'error', 'cancelled']);
    expect(result.requests[0].assets?.[0].base64).toBe(image.data[0].b64_json);
    expect(result.requests[1].error?.params?.detail).toBe('overloaded');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(mediaMetrics(result, 'A')).toMatchObject({ success: 1, failed: 1, cancelled: 1, count: 3 });
  });
  it('polls queue and running states, stopping measurement before content download', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const progressUpdates: (number | undefined)[] = [];
    let now = 0;
    const fetcher = vi.fn().mockResolvedValueOnce(response({ id: 'job', status: 'queued', progress: 0 }))
      .mockResolvedValueOnce(response({ id: 'job', status: 'in_progress', progress: 35 }))
      .mockImplementationOnce(async () => { now = 2500; return response({ id: 'job', status: 'completed', inference_time_s: 1.2 }); });
    const run = startMediaBenchmark(video, [endpoint], state => { states.push(state.requests[0].jobStatus ?? ''); progressUpdates.push(state.requests[0].progress); }, { fetcher, clock: () => now });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await run.finished;
    expect(states).toContain('queued'); expect(states).toContain('in_progress');
    expect(progressUpdates).toContain(0); expect(progressUpdates).toContain(35); expect(progressUpdates.at(-1)).toBe(100);
    expect(result.requests[0]).toMatchObject({ status: 'success', endedAt: 2500, inferenceSeconds: 1.2, asset: { url: 'http://localhost:8000/v1/videos/job/content' } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps polling when progress reaches 100 but the job is still running', async () => {
    vi.useFakeTimers();
    let latest!: MediaRun;
    const fetcher = vi.fn().mockResolvedValueOnce(response({ id: 'job', status: 'in_progress', progress: 100 }))
      .mockResolvedValueOnce(response({ id: 'job', status: 'in_progress' }))
      .mockResolvedValueOnce(response({ id: 'job', status: 'completed' }));
    const run = startMediaBenchmark(video, [endpoint], state => { latest = state; }, { fetcher });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest.phase).toBe('running'); expect(latest.requests[0].progress).toBe(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(latest.phase).toBe('running'); expect(latest.requests[0].progress).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await run.finished).requests[0]).toMatchObject({ status: 'success', progress: 100 });
  });
  it('isolates failed requests without retrying generation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ detail: 'bad dimensions' }, 422)).mockResolvedValueOnce(response(image));
    const result = await startMediaBenchmark(config, [endpoint, { ...endpoint, id: 'B' }], () => {}, { fetcher }).finished;
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
  it('measures each endpoint independently and calculates video RTF', async () => {
    let now = 0;
    const callbacks: ((value: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { callbacks.push(resolve); }));
    let latest!: MediaRun;
    const run = startMediaBenchmark(video, [endpoint, { ...endpoint, id: 'B' }], state => { latest = state; }, { fetcher, clock: () => now });
    now = 2000; callbacks[0](response({ id: 'done', status: 'completed' }));
    await vi.waitFor(() => expect(latest.requests[0].status).toBe('success'));
    expect(latest.phase).toBe('running');
    expect(latest.requests[1].status).toBe('running');
    now = 4000; callbacks[1](response({ detail: 'overloaded' }, 503));
    const result = await run.finished;
    expect(mediaMetrics(result, 'A')).toMatchObject({ success: 1, failed: 0, successRate: 100, mean: 2000, min: 2000, max: 2000, throughput: 30 });
    expect(mediaMetrics(result, 'B')).toMatchObject({ success: 0, failed: 1, successRate: 0, mean: null, throughput: 0 });
    expect(videoRtf(result, 'A', {})).toEqual({ value: .4, estimated: true, mixed: false });
    expect(videoRtf(result, 'A', { 'A-1': { duration: 2 } })).toEqual({ value: 1, estimated: false, mixed: false });
    expect(videoRtf(result, 'A', { 'A-1': { duration: NaN } })).toMatchObject({ value: .4, estimated: true });
    const mixedRun = { ...result, requests: [...result.requests, { ...result.requests[0], id: 'A-3' }] };
    expect(videoRtf(mixedRun, 'A', { 'A-1': { duration: 2 } })).toMatchObject({ estimated: true, mixed: true });
  });
});

describe('media configuration', () => {
  it('restores old settings with batch size 1 and persists a chosen batch size', () => {
    const old = JSON.stringify({ version: 2, config: { steps: 32 } });
    expect(restoreMediaSettings('image', 'default', old).config).toMatchObject({ batchSize: 1, steps: 32 });
    const settings = { ...defaults, config: { ...config, batchSize: 16 } };
    expect(restoreMediaSettings('image', 'default', serializeMediaSettings(settings)).config.batchSize).toBe(16);
    expect(() => validateMediaConfig(settings.config)).not.toThrow();
  });
  it.each([0, 17, 1.5, NaN])('rejects invalid batch size %s and restores the default from invalid storage', batchSize => {
    expect(() => validateMediaConfig({ ...config, batchSize })).toThrow();
    expect(restoreMediaSettings('image', 'default', JSON.stringify({ version: 2, config: { batchSize } })).config.batchSize).toBe(1);
  });
  it('uses only exact 16:9 presets and migrates the old image default', () => {
    for (const mode of ['image', 'video'] as const) {
      for (const [width, height] of resolutions[mode]) expect(width * 9).toBe(height * 16);
      const { config } = defaultMediaSettings(mode, 'prompt');
      expect(resolutions[mode]).toContainEqual([config.width, config.height]);
    }
    const old = { version: 1, config: { width: 1024, height: 1024, prompt: 'saved image' } };
    expect(restoreMediaSettings('image', 'default', JSON.stringify(old)).config).toMatchObject({ width: 1024, height: 576, prompt: 'saved image' });
    expect(restoreMediaSettings('image', 'default', JSON.stringify({ ...old, version: 2 })).config).toMatchObject({ width: 1024, height: 1024 });
  });
  it('migrates old video defaults and drops stale concurrency without resetting custom settings', () => {
    const old = { version: 1, config: { ...video, width: 832, height: 480, fps: 16, concurrency: 8, prompt: 'saved', steps: 32 }, endpoints: [endpoint], compare: true };
    const restored = restoreMediaSettings('video', 'default', JSON.stringify(old));
    expect(restored.config).toMatchObject({ width: 1280, height: 720, fps: 24, prompt: 'saved', steps: 32 });
    expect(restored.config).not.toHaveProperty('concurrency');
    expect(restored.endpoints[0].model).toBe('fixture');
    expect(restored.compare).toBe(true);
    expect(JSON.parse(serializeMediaSettings(restored)).version).toBe(2);
    const custom = { ...old, config: { ...old.config, width: 720, height: 1280, fps: 30 } };
    expect(restoreMediaSettings('video', 'default', JSON.stringify(custom)).config).toMatchObject({ width: 720, height: 1280, fps: 30 });
    const explicitOldValues = { ...old, version: 2 };
    expect(restoreMediaSettings('video', 'default', JSON.stringify(explicitOldValues)).config).toMatchObject({ width: 832, height: 480, fps: 16 });
    expect(restoreMediaSettings('image', 'default', JSON.stringify(old)).config).not.toHaveProperty('concurrency');
  });
  it('stores each mode separately and strips credentials and untrusted fields on restoration', () => {
    const saved = serializeMediaSettings({ config, compare: true, endpoints: [endpoint] });
    expect(saved).not.toContain('memory-only');
    const restored = restoreMediaSettings('image', 'default', saved);
    expect(restored.config).toEqual(config); expect(restored.compare).toBe(true);
    expect(restored.endpoints[0].apiKey).toBe('');
    const unsafe = JSON.stringify({ version: 1, config: { mode: 'image', concurrency: 100, seed: -1, prompt: 'custom' }, endpoints: [{ baseUrl: 'https://key:secret@example.com', apiKey: 'bad', protocol: 'ollama' }] });
    const safe = restoreMediaSettings('video', 'default', unsafe);
    expect(safe.config).toMatchObject({ mode: 'video', seed: null, prompt: 'custom' });
    expect(safe.endpoints[0]).toMatchObject({ protocol: 'openai', apiKey: '', baseUrl: 'http://localhost:8091/v1' });
    expect(restoreMediaSettings('video', 'default', '{').config.timeoutSeconds).toBe(1800);
  });
});
