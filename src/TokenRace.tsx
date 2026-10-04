import { useLayoutEffect, useRef } from 'react';
import { Car } from 'lucide-react';
import { endpointName } from './lib/endpoint';
import { raceProgress } from './lib/metrics';
import { sourceLabels } from './lib/provenance';
import type { RunState } from './lib/types';

const labels = { waiting: '等待输出', driving: '输出中', catchup: '校准后等待输出追平', budget: '达到预算（估算）', error: '有请求失败', cancelled: '已停止', finished: '达到预算（估算）', early: '提前结束' };
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function TokenRace({ run, onAnimationChange }: { run: RunState; onAnimationChange: (active: boolean) => void }) {
  const winnerRef = useRef<HTMLSpanElement>(null);
  const winnerId = run.raceWinner?.endpointId;
  useLayoutEffect(() => {
    const badge = winnerRef.current;
    let current = true;
    let generation = 0;
    const watch = () => {
      const animations = badge?.getAnimations().filter(animation => animation.playState !== 'finished') ?? [];
      const revision = ++generation;
      onAnimationChange(animations.length > 0);
      // CSS cancellation (narrow layout or reduced motion) also releases the hold.
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => { if (current && revision === generation) onAnimationChange(false); });
    };
    watch();
    // A newly visible race can start the animation after a viewport resize.
    badge?.addEventListener('animationstart', watch);
    return () => { current = false; badge?.removeEventListener('animationstart', watch); onAnimationChange(false); };
  }, [winnerId, run.startedAt, onAnimationChange]);
  return <section className={`token-race ${run.endpoints.some(endpoint => endpoint.alias?.trim()) ? 'has-alias' : ''}`} aria-label="双端点输出竞速" title="赛道长度 = 每请求输出上限 × 并发数；使用当前文本计数，校准后不回退，提前结束时停车。">
    {run.endpoints.map(endpoint => {
      const progress = raceProgress(run, endpoint.id);
      const name = endpointName(endpoint, endpoint.id);
      const output = `${progress.output.source === 'estimated' || progress.output.source === 'calibrated' ? '≈ ' : ''}${number(progress.output.value!)} / ${number(progress.budget)}`;
      const source = sourceLabels[progress.output.source];
      return <div key={endpoint.id} className={`race-row race-${endpoint.id}`} data-state={progress.state} data-generated={progress.generated} data-distance={progress.distance} data-tokens={progress.output.value} data-source={progress.output.source} data-budget={progress.budget} data-speed={progress.speed} data-progress={progress.fraction} title={`${name} · ${endpoint.model} · ${labels[progress.state]} · 输出 ${output} tokens（${source}） · ${number(progress.speed)} tok/s`}>
        <span className="race-identity" title={name}>{name}</span>
        <div className="race-track" role="progressbar" aria-label={`${endpointName(endpoint, `端点 ${endpoint.id}`)} 输出进度（估算）`} aria-valuemin={0} aria-valuemax={progress.budget} aria-valuenow={progress.distance} aria-valuetext={`${labels[progress.state]}，行驶距离 ${number(progress.distance)} / ${number(progress.budget)} tokens，输出 ${output} tokens（${source}）`}>
          <span className="race-distance" style={{ width: `${progress.fraction * 100}%` }} />
          <span className="race-drive-range"><span className="race-car" data-moving={progress.speed > 0 && progress.active && !progress.waitingForCalibration && progress.fraction < 1 || undefined} style={{ left: `${progress.fraction * 100}%`, '--drive-duration': `${Math.max(.12, Math.min(1.2, 8 / Math.max(progress.speed, 1)))}s` } as React.CSSProperties}><Car viewBox="0 4 24 17" strokeWidth={1.7} aria-hidden="true" /></span></span>
          <span className="race-finish" aria-hidden="true" />
        </div>
        <span className="race-readout"><span className="race-count-and-place"><span className="race-token-count" title={`输出 ${output} tokens · ${source}`}>{output}</span><span className="race-place-slot">{winnerId === endpoint.id && <span ref={winnerRef} className="race-winner" role="status" aria-label={`${name} 第一名`}>1st</span>}</span></span><strong>{number(progress.speed)} <small>tok/s</small></strong></span>
      </div>;
    })}
  </section>;
}
