import { Car } from 'lucide-react';
import { raceProgress } from './lib/metrics';
import type { RunState } from './lib/types';

const labels = { waiting: '等待输出', driving: '输出中', budget: '达到预算（估算）', error: '有请求失败', cancelled: '已停止', finished: '达到预算（估算）', early: '提前结束' };
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function TokenRace({ run }: { run: RunState }) {
  return <section className="token-race" aria-label="双端点输出竞速" title="赛道长度 = 每请求输出上限 × 并发数；车速与距离使用实时 token 估算，提前结束时停车。">
    {run.endpoints.map(endpoint => {
      const progress = raceProgress(run, endpoint.id);
      return <div key={endpoint.id} className={`race-row race-${endpoint.id}`} data-state={progress.state} data-generated={progress.generated} data-budget={progress.budget} data-speed={progress.speed} data-progress={progress.fraction} title={`${endpoint.id} · ${endpoint.model} · ${labels[progress.state]} · 输出 ≈ ${number(progress.generated)} / ${number(progress.budget)} tokens · ${number(progress.speed)} tok/s`}>
        <span className="race-identity">{endpoint.id}</span>
        <div className="race-track" role="progressbar" aria-label={`端点 ${endpoint.id} 输出进度（估算）`} aria-valuemin={0} aria-valuemax={progress.budget} aria-valuenow={Math.min(progress.generated, progress.budget)} aria-valuetext={`${labels[progress.state]}，估算 ${number(progress.generated)} / ${number(progress.budget)} tokens`}>
          <span className="race-distance" style={{ width: `${progress.fraction * 100}%` }} />
          <span className="race-drive-range"><span className="race-car" data-moving={progress.speed > 0 && progress.active || undefined} style={{ left: `${progress.fraction * 100}%`, '--drive-duration': `${Math.max(.12, Math.min(1.2, 8 / Math.max(progress.speed, 1)))}s` } as React.CSSProperties}><Car viewBox="0 4 24 17" strokeWidth={1.7} aria-hidden="true" /></span></span>
          <span className="race-finish" aria-hidden="true" />
        </div>
        <span className="race-readout"><span>≈ {number(progress.generated)} / {number(progress.budget)}</span><strong>{number(progress.speed)} <small>tok/s</small></strong></span>
      </div>;
    })}
  </section>;
}
