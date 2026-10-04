import type { Source } from './types';

export const sourceLabels: Record<Source, string> = {
  reported: '端点报告', measured: '浏览器测量', estimated: '估算',
  counted: '端点分词', calibrated: 'API 校准（含估算）',
};
export const tokenQuantityLabel = (source: Source) => source === 'reported' || source === 'measured' ? '实际' : source === 'counted' ? '分词' : source === 'calibrated' ? '校准' : '估算';
