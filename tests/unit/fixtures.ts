import type { BenchmarkConfig, EndpointConfig } from '../../src/lib/types';

export const endpoint: EndpointConfig = { id: 'A', protocol: 'ollama', baseUrl: 'http://localhost:11434', model: 'test', apiKey: '', includeUsage: true, maxTokensField: 'max_tokens', thinkingFormat: 'reasoning_effort', contextLength: null };
export const config: BenchmarkConfig = { inputTokens: 1024, outputTokens: 512, concurrency: 1, temperature: null, thinking: 'default', timeoutSeconds: 300 };
