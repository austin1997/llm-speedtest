import type { Protocol, Source, Thinking } from '../src/lib/types';

export const RECORD_SCHEMA = 1;
export const RECORD_VERSION = 1;

const sources = ['reported', 'measured', 'estimated', 'counted', 'calibrated'] as const;
const slots = ['A', 'B'] as const;
const tokenCounters = ['vllm', 'llama', 'responses'] as const;

export interface EndpointOptions {
  includeUsage: boolean;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  thinkingFormat: 'reasoning_effort' | 'qwen';
  contextLength: number | null;
  useTokenApi: boolean;
  tokenBatchSize: number | null;
  tokenCounter: (typeof tokenCounters)[number] | null;
}

export interface EndpointResult {
  requestCount: number;
  successCount: number;
  failureCount: number;
  cancelledCount: number;
  elapsedMs: number | null;
  outputTokens: number | null;
  outputSource: Source;
  overallTps: number | null;
  ttftMeanMs: number | null;
  ttftMinMs: number | null;
  ttftMaxMs: number | null;
  decodeMean: number | null;
  decodeMin: number | null;
  decodeMax: number | null;
  decodeSource: Source;
  decodeMixed: boolean;
  durationMeanMs: number | null;
  serverDecodeMean: number | null;
  serverPrefillMean: number | null;
  loadMeanMs: number | null;
  errorSample: string | null;
}

export interface EndpointRecord {
  slot: 'A' | 'B';
  protocol: Protocol;
  baseUrl: string;
  model: string;
  alias: string | null;
  apiKey: string | null;
  options: EndpointOptions;
  result: EndpointResult;
}

export interface RunRecord {
  schema: typeof RECORD_SCHEMA;
  recordVersion: typeof RECORD_VERSION;
  runId: string;
  appVersion: string | null;
  startedAt: number;
  durationMs: number;
  promptHash: string | null;
  config: {
    inputTokens: number;
    outputTokens: number;
    concurrency: number;
    temperature: number | null;
    thinking: Thinking;
    timeoutSeconds: number;
  };
  endpoints: EndpointRecord[];
}

export class RecordParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordParseError';
  }
}

function fail(message: string): never { throw new RecordParseError(message); }
const boolean = (value: unknown, label: string) => typeof value === 'boolean' ? value : fail(`${label}无效。`);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function plainText(value: unknown): string | null {
  return typeof value === 'string' && !/[\u0000-\u001f]/.test(value) ? value : null;
}
const integer = (value: unknown, min: number, max: number, label: string) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`${label}无效。`);
  return value;
};
const metric = (value: unknown, label: string) => {
  if (value === null) return null;
  if (typeof value !== 'number') fail(`${label}无效。`);
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) > 1e12) fail(`${label}无效。`);
  return value;
};
const source = (value: unknown): Source => sources.includes(value as Source) ? value as Source : fail('指标来源无效。');

/** Canonical origin plus the path prefix actually used to build a chat request. */
export function canonicalBaseUrl(input: string, protocol: Protocol): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { fail('端点地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('端点地址须为 HTTP(S) 地址，不含用户名、密码、查询参数或片段。');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (protocol === 'ollama') path = path.replace(/\/api\/(chat|tags|show)$/, '').replace(/\/api$/, '');
  else {
    path = path.replace(/\/(chat\/completions|models)$/, '');
    if (!path) path = '/v1';
  }
  const base = !path || path === '/' ? url.origin : `${url.origin}${path}`;
  if (base.length > 2048) fail('端点地址过长。');
  return base;
}

function options(value: unknown): EndpointOptions {
  if (!isObject(value)) fail('端点选项无效。');
  const batch = value.tokenBatchSize;
  return {
    includeUsage: boolean(value.includeUsage, '流式 usage'),
    maxTokensField: value.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : value.maxTokensField === 'max_tokens' ? 'max_tokens' : fail('输出上限字段无效。'),
    thinkingFormat: value.thinkingFormat === 'qwen' ? 'qwen' : value.thinkingFormat === 'reasoning_effort' ? 'reasoning_effort' : fail('思考格式无效。'),
    contextLength: value.contextLength === null ? null : integer(value.contextLength, 1024, 1048576, '上下文长度'),
    useTokenApi: boolean(value.useTokenApi, 'token API'),
    tokenBatchSize: batch === null ? null : integer(batch, 8, 512, '校准间隔'),
    tokenCounter: value.tokenCounter === null ? null : tokenCounters.includes(value.tokenCounter as typeof tokenCounters[number]) ? value.tokenCounter as EndpointOptions['tokenCounter'] : fail('计数接口无效。'),
  };
}

function result(value: unknown): EndpointResult {
  if (!isObject(value)) fail('端点结果无效。');
  const requestCount = integer(value.requestCount, 0, 16, '请求数');
  const successCount = integer(value.successCount, 0, 16, '成功数');
  const failureCount = integer(value.failureCount, 0, 16, '失败数');
  const cancelledCount = integer(value.cancelledCount, 0, 16, '停止数');
  if (successCount + failureCount + cancelledCount !== requestCount) fail('请求计数不一致。');
  const errorText = value.errorSample === null ? null : plainText(value.errorSample);
  if (value.errorSample !== null && errorText === null) fail('错误摘要无效。');
  const errorSample = errorText?.slice(0, 256) ?? null;
  return {
    requestCount, successCount, failureCount, cancelledCount, errorSample,
    elapsedMs: metric(value.elapsedMs, '整轮耗时'),
    outputTokens: metric(value.outputTokens, '输出 token'),
    outputSource: source(value.outputSource),
    overallTps: metric(value.overallTps, '整轮吞吐'),
    ttftMeanMs: metric(value.ttftMeanMs, '首字延迟'),
    ttftMinMs: metric(value.ttftMinMs, '首字延迟'),
    ttftMaxMs: metric(value.ttftMaxMs, '首字延迟'),
    decodeMean: metric(value.decodeMean, '浏览器 decode'),
    decodeMin: metric(value.decodeMin, '浏览器 decode'),
    decodeMax: metric(value.decodeMax, '浏览器 decode'),
    decodeSource: source(value.decodeSource),
    decodeMixed: boolean(value.decodeMixed, 'decode 口径'),
    durationMeanMs: metric(value.durationMeanMs, '总耗时'),
    serverDecodeMean: metric(value.serverDecodeMean, '服务端 decode'),
    serverPrefillMean: metric(value.serverPrefillMean, '服务端 prefill'),
    loadMeanMs: metric(value.loadMeanMs, '模型加载'),
  };
}

function endpoint(value: unknown): EndpointRecord {
  if (!isObject(value)) fail('端点记录无效。');
  const protocol: Protocol = value.protocol === 'openai' ? 'openai' : value.protocol === 'ollama' ? 'ollama' : fail('协议无效。');
  const slot = slots.includes(value.slot as 'A' | 'B') ? value.slot as 'A' | 'B' : fail('端点编号无效。');
  const modelText = plainText(value.model);
  if (!modelText) fail('模型名称无效。');
  const model = modelText.trim();
  if (!model || model.length > 256) fail('模型名称无效。');
  const aliasText = value.alias === null ? '' : plainText(value.alias);
  if (value.alias !== null && aliasText === null) fail('别名无效。');
  const alias = aliasText?.trim() || null;
  if (alias && alias.length > 64) fail('别名过长。');
  const keyText = value.apiKey === null ? '' : plainText(value.apiKey);
  if (value.apiKey !== null && keyText === null) fail('API Key 无效。');
  const apiKey = keyText?.trim() || null;
  if (apiKey && apiKey.length > 4096) fail('API Key 过长。');
  return { slot, protocol, baseUrl: canonicalBaseUrl(typeof value.baseUrl === 'string' ? value.baseUrl : fail('端点地址无效。'), protocol), model, alias, apiKey, options: options(value.options), result: result(value.result) };
}

/** Drop unknown fields, including any client-supplied IP, and return a canonical record. */
export function parseRunRecord(input: unknown): RunRecord {
  if (!isObject(input)) fail('请求体须为 JSON 对象。');
  if (input.schema !== RECORD_SCHEMA || input.recordVersion !== RECORD_VERSION) fail('不支持的记录格式。');
  if (typeof input.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.runId)) fail('测速编号无效。');
  const versionText = input.appVersion === null ? '' : plainText(input.appVersion);
  if (input.appVersion !== null && versionText === null) fail('版本号无效。');
  const appVersion = versionText?.trim().slice(0, 64) || null;
  const promptHash = input.promptHash === null ? null : typeof input.promptHash === 'string' && /^[0-9a-f]{16}$/.test(input.promptHash) ? input.promptHash : fail('输入摘要无效。');
  if (!isObject(input.config)) fail('测试参数无效。');
  const thinking: Thinking = input.config.thinking === 'on' || input.config.thinking === 'off' || input.config.thinking === 'default' ? input.config.thinking : fail('思考模式无效。');
  const temperature = input.config.temperature === null ? null : typeof input.config.temperature === 'number' && Number.isFinite(input.config.temperature) && input.config.temperature >= 0 && input.config.temperature <= 2 ? input.config.temperature : fail('Temperature 无效。');
  if (!Array.isArray(input.endpoints) || input.endpoints.length < 1 || input.endpoints.length > 2) fail('端点数量无效。');
  const endpoints = input.endpoints.map(endpoint);
  if (new Set(endpoints.map(item => item.slot)).size !== endpoints.length) fail('端点编号重复。');
  return {
    schema: RECORD_SCHEMA,
    recordVersion: RECORD_VERSION,
    runId: input.runId.toLowerCase(),
    appVersion,
    startedAt: integer(input.startedAt, 1, 10_000_000_000_000, '开始时间'),
    durationMs: integer(input.durationMs, 0, 86_400_000, '测速耗时'),
    promptHash,
    config: {
      inputTokens: integer(input.config.inputTokens, 128, 32768, '输入长度'),
      outputTokens: integer(input.config.outputTokens, 32, 8192, '输出上限'),
      concurrency: integer(input.config.concurrency, 1, 16, '并发'),
      temperature,
      thinking,
      timeoutSeconds: integer(input.config.timeoutSeconds, 30, 1800, '超时'),
    },
    endpoints,
  };
}
