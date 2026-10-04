import { describe, expect, it } from 'vitest';
import { startBenchmark } from '../../src/lib/benchmark';
import { generatePrompt } from '../../src/lib/prompt';
import { endpointMetrics } from '../../src/lib/metrics';
import type { BenchmarkConfig, EndpointConfig } from '../../src/lib/types';

const config: BenchmarkConfig = { inputTokens: 128, outputTokens: 64, concurrency: 1, temperature: null, thinking: 'off', timeoutSeconds: 240 };
const endpoint: EndpointConfig = { id: 'A', protocol: 'ollama', baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434', model: 'qwen3.6:latest', apiKey: '', includeUsage: true, maxTokensField: 'max_tokens', thinkingFormat: 'reasoning_effort', contextLength: null };
describe.sequential('local Ollama integration (explicit opt-in)', () => {
  for (const model of ['qwen3.6:latest', 'qwen3:30b-a3b-q4_K_M']) {
    for (const thinking of ['off', 'on'] as const) {
      it(`${model}: thinking ${thinking}`, async () => {
        const result = await startBenchmark({ ...config, thinking }, [{ ...endpoint, model }], generatePrompt(128), () => {}).finished;
        const r = result.requests[0];
        console.log(JSON.stringify({ model, thinking, status: r.status, output: r.usage?.output, error: r.error }));
        expect(r.error).toBeUndefined(); expect(r.status).toBe('success');
        expect(r.text.length).toBeGreaterThan(0); expect(r.firstAt).not.toBeNull(); expect(r.usage?.output).toBeGreaterThan(0);
      });
    }
  }
  it('runs Ollama and OpenAI adapters simultaneously at concurrency 2', async () => {
    const openai: EndpointConfig = { ...endpoint, id: 'B', protocol: 'openai', baseUrl: endpoint.baseUrl + '/v1' };
    const result = await startBenchmark({ ...config, concurrency: 2 }, [endpoint, openai], generatePrompt(128), () => {}).finished;
    console.log(JSON.stringify(result.requests.map(r => ({ id: r.id, status: r.status, output: r.usage?.output, error: r.error }))));
    expect(result.requests).toHaveLength(4);
    expect(result.requests.every(r => r.status === 'success')).toBe(true);
    expect(endpointMetrics(result, 'A').serverDecode.mean).toBeGreaterThan(0);
    expect(endpointMetrics(result, 'B').overall.source).toBe('reported');
  });
});
