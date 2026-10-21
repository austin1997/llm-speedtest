import type { Msg } from '../i18n/types';
import type { EndpointConfig, Status } from './types';

export type BenchmarkMode = 'language' | 'image' | 'video';
export type MediaMode = Exclude<BenchmarkMode, 'language'>;
export interface MediaConfig {
  mode: MediaMode;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seconds: number;
  fps: number;
  seed: number | null;
  timeoutSeconds: number;
}
export interface MediaSettings { config: MediaConfig; endpoints: EndpointConfig[]; compare: boolean }
export interface MediaAsset { base64?: string; url?: string; mime: string }
export interface MediaRequest {
  id: string;
  endpointId: 'A' | 'B';
  status: Status;
  jobStatus?: 'queued' | 'in_progress';
  jobId?: string;
  startedAt: number | null;
  endedAt: number | null;
  asset?: MediaAsset;
  inferenceSeconds?: number;
  error?: Msg;
}
export interface MediaRun {
  config: MediaConfig;
  endpoints: EndpointConfig[];
  phase: 'running' | 'complete';
  startedAt: number;
  now: number;
  requests: MediaRequest[];
  history: { at: number; A: number; B: number }[];
}
