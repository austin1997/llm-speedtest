import type { Msg } from '../i18n/types';

export type Protocol = 'ollama' | 'openai';
export type Thinking = 'default' | 'on' | 'off';
export type Source = 'reported' | 'measured' | 'estimated' | 'counted' | 'calibrated';
export type Status = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export interface EndpointConfig {
  id: 'A' | 'B';
  alias?: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  includeUsage: boolean;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  thinkingFormat: 'reasoning_effort' | 'qwen';
  contextLength: number | null;
  modelContextLimit?: number;
  useTokenApi?: boolean;
  tokenBatchSize?: number;
  tokenCounter?: TokenCounterCapability | null;
}

export interface TokenCounterCapability {
  kind: 'vllm' | 'llama' | 'responses';
  url: string;
  baseline: number;
}

export interface BenchmarkConfig {
  inputTokens: number;
  outputTokens: number;
  concurrency: number;
  temperature: number | null;
  thinking: Thinking;
  timeoutSeconds: number;
}

export interface Usage { input?: number; output?: number; cachedInput?: number; reasoning?: number }
export interface ServerTiming { loadNs?: number; prefillNs?: number; decodeNs?: number; totalNs?: number }
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Usage; timing?: ServerTiming }
  | { type: 'done'; reason?: string };

export interface RequestResult {
  id: string;
  endpointId: 'A' | 'B';
  index: number;
  status: Status;
  text: string;
  startedAt: number | null;
  firstAt: number | null;
  lastTextAt: number | null;
  endedAt: number | null;
  firstTokens: number;
  estimatedTokens: number;
  samples: { at: number; tokens: number; estimate?: number; chars?: number }[];
  tokenSource?: 'counted' | 'calibrated' | 'estimated';
  countedTokens?: number;
  countedChars?: number;
  countedAt?: number;
  countedEstimate?: number;
  tokenScale?: number;
  tokenCounting?: 'active' | 'finalizing' | 'done' | 'failed';
  tokenCountError?: Msg;
  usage?: Usage;
  timing?: ServerTiming;
  finishReason?: string;
  error?: Msg;
}

export interface RunState {
  phase: 'running' | 'complete';
  config: BenchmarkConfig;
  endpoints: EndpointConfig[];
  prompt: string;
  startedAt: number;
  now: number;
  requests: RequestResult[];
  raceDistance: Record<EndpointConfig['id'], number>;
  raceWinner?: { endpointId: EndpointConfig['id']; at: number };
  history: { at: number; A: number; B: number }[];
}

export interface Metric { value: number | null; source: Source }
