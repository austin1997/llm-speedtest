import { describe, expect, it } from 'vitest';
import { endpointUrl, parseStream, requestBody } from '../../src/lib/protocol';
import type { EndpointConfig } from '../../src/lib/types';
import { config, endpoint } from './fixtures';

function fragmented(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size)); controller.close(); } });
}
async function events(protocol: EndpointConfig['protocol'], text: string, size = 1) {
  const result = []; for await (const event of parseStream(protocol, fragmented(text, size))) result.push(event); return result;
}

describe('protocol adapters', () => {
  it('decodes split Chinese bytes, empty chunks, thinking and final Ollama usage', async () => {
    const result = await events('ollama', '\n' + [
      { message: { content: '' }, done: false },
      { message: { thinking: '思考中', content: '正文' }, done: false },
      { done: true, done_reason: 'length', prompt_eval_count: 12, eval_count: 9, eval_duration: 1000000000 },
    ].map(o => JSON.stringify(o)).join('\r\n'));
    expect(result).toEqual([
      { type: 'text', text: '思考中正文' },
      { type: 'usage', usage: { input: 12, output: 9, cachedInput: undefined }, timing: { loadNs: undefined, prefillNs: undefined, decodeNs: 1000000000, totalNs: undefined } },
      { type: 'done', reason: 'length' },
    ]);
  });
  it('handles SSE comments, CRLF, multiline data, usage after finish_reason and DONE', async () => {
    const raw = ': ping\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant","content":""}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"推理", "content":"回答"}}],\r\ndata: "usage":null}\r\n\r\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":8,"completion_tokens_details":{"reasoning_tokens":3}}}\n\n' +
      'data: [DONE]\n\n';
    const result = await events('openai', raw, 3);
    expect(result[0]).toEqual({ type: 'text', text: '推理回答' });
    expect(result[1]).toMatchObject({ type: 'usage', usage: { input: 10, output: 8, reasoning: 3 } });
    expect(result[2]).toEqual({ type: 'done', reason: 'stop' });
  });
  it('uses one reasoning alias and does not duplicate reported output counts', async () => {
    const result = await events('openai', 'data: {"choices":[{"delta":{"reasoning":"X","reasoning_content":"X","content":"Y"},"finish_reason":"stop"}],"usage":{"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":8}}}\n\n');
    expect(result[0]).toEqual({ type: 'text', text: 'XY' });
    expect(result[1]).toMatchObject({ usage: { output: 12, reasoning: 8 } });
  });
  it('rejects truncated streams, malformed JSON and upstream errors', async () => {
    await expect(events('ollama', '{"message":{"content":"partial"}}\n')).rejects.toThrow('意外结束');
    await expect(events('openai', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')).rejects.toThrow('意外结束');
    await expect(events('openai', 'data: not-json\n\n')).rejects.toThrow('JSON');
    await expect(events('ollama', '{"error":"model not found"}\n')).rejects.toThrow('model not found');
  });
  it('maps limits, temperature, context and thinking only as configured', () => {
    expect(requestBody(endpoint, config, 'the exact preview')).toEqual({ model: 'test', messages: [{ role: 'user', content: 'the exact preview' }], stream: true, options: { num_predict: 512, num_ctx: 4096 } });
    expect(requestBody(endpoint, { ...config, thinking: 'on', inputTokens: 8192 }, 'x')).toMatchObject({ think: true, options: { num_ctx: 9216 } });
    const openai = { ...endpoint, protocol: 'openai' as const, includeUsage: false, maxTokensField: 'max_completion_tokens' as const, thinkingFormat: 'qwen' as const };
    const body = requestBody(openai, { ...config, thinking: 'off', temperature: 0 }, 'x');
    expect(body).toMatchObject({ max_completion_tokens: 512, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    expect(body).not.toHaveProperty('stream_options');
    expect(body).not.toHaveProperty('max_tokens');
  });
  it('normalizes base and full endpoint URLs and rejects ambiguous credentials', () => {
    expect(endpointUrl({ ...endpoint, baseUrl: 'http://localhost:11434/api/chat' }, 'models')).toBe('http://localhost:11434/api/tags');
    expect(endpointUrl({ ...endpoint, protocol: 'openai', baseUrl: 'https://example.com/prefix/v1/chat/completions/' }, 'models')).toBe('https://example.com/prefix/v1/models');
    expect(() => endpointUrl({ ...endpoint, baseUrl: 'https://secret@example.com/v1' }, 'chat')).toThrow('用户名');
  });
});
