import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Clock3, Download, Image, LoaderCircle, Plus, RotateCcw, Square, Video, Zap } from 'lucide-react';
import { EndpointCard, NumberInput, Slider } from './components/BenchmarkControls';
import { useI18n } from './i18n/I18nProvider';
import { describeError, msg } from './i18n/message';
import type { Msg } from './i18n/types';
import { endpointName } from './lib/endpoint';
import { mediaStorageKey, resolutions, restoreMediaSettings, serializeMediaSettings } from './lib/media-config';
import { mediaMetrics, startMediaBenchmark, videoRtf } from './lib/media-benchmark';
import { aspectRatio, fetchMediaAsset } from './lib/media-protocol';
import type { MediaConfig, MediaMode, MediaRequest, MediaRun } from './lib/media-types';
import type { EndpointConfig } from './lib/types';

type PreviewInfo = { duration?: number; downloadMs?: number };

function VideoLoading({ request, busy, failed }: { request: MediaRequest; busy: boolean; failed: boolean }) {
  const { t, n } = useI18n();
  return <div className={`video-loading ${busy ? 'video-loading-active' : ''}`} data-testid="video-loading">
    <div className="video-loading-icon" aria-hidden="true"><Video size={34} />{busy && <LoaderCircle className="spin" size={64} />}</div>
    <p role="status">{busy ? t(request.asset ? 'media.videoFetching' : 'media.videoLoading') : t(failed ? 'media.previewFailed' : `status.${request.status}`)}</p>
    {busy && <div className="video-progress">
      <div><span>{t('media.progress')}</span><strong>{request.progress === undefined ? '—' : `${n(request.progress, 0)}%`}</strong></div>
      <progress aria-label={t('media.progress')} max={100} value={request.progress} />
      <small>{t(request.progress === undefined ? 'media.progressPending' : 'source.reported')}</small>
    </div>}
  </div>;
}

function MediaOutput({ request, endpoint, mode, now, onInfo, ratio }: {
  request: MediaRequest; endpoint: EndpointConfig; mode: MediaMode; now: number; ratio: number;
  onInfo: (id: string, info: PreviewInfo) => void;
}) {
  const { t, tMsg, time, n } = useI18n();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<Msg | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [downloadMs, setDownloadMs] = useState<number>();
  const [extension, setExtension] = useState(mode === 'image' ? 'png' : 'mp4');
  useEffect(() => {
    if (!request.asset) return;
    const controller = new AbortController();
    let objectUrl = '';
    let timedOut = false;
    setUrl(''); setError(null); onInfo(request.id, {});
    const start = performance.now();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
    void fetchMediaAsset(request.asset, endpoint, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      setExtension(({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' } as Record<string, string>)[blob.type] ?? (mode === 'image' ? 'png' : 'mp4'));
      const elapsed = performance.now() - start;
      setDownloadMs(elapsed); onInfo(request.id, { downloadMs: elapsed });
    }).catch(reason => {
      if (timedOut) setError(msg('error.timeout', { seconds: 120 }));
      else if (!controller.signal.aborted) setError(describeError(reason));
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [request.asset, request.id, endpoint, attempt, onInfo, mode]);
  const busy = !error && (request.status === 'pending' || request.status === 'running' || (request.status === 'success' && !url));
  const status = mode === 'video' && busy ? t('media.videoLoading') : request.status === 'running' ? t('media.generating') : t(`status.${request.status}`);
  return <article className={`media-output ${mode === 'video' ? 'video-output' : ''} status-${request.status}`} data-testid="media-output">
    <header><strong>{request.id}</strong><span>{status}{mode === 'video' && busy && request.progress !== undefined ? ` · ${n(request.progress, 0)}%` : ''}</span><span>{request.startedAt === null ? '—' : time((request.endedAt ?? now) - request.startedAt)}</span></header>
    {mode === 'video' ? <div className="video-frame" style={{ aspectRatio: ratio }}>
      {url ? <video src={url} controls preload="metadata" onError={() => setError(msg('media.playbackError'))} onLoadedMetadata={event => {
        const duration = event.currentTarget.duration;
        if (Number.isFinite(duration) && duration > 0) onInfo(request.id, { duration, downloadMs });
      }} /> : <VideoLoading request={request} busy={busy} failed={!!error} />}
    </div> : url ? <img src={url} alt={t('media.output')} onError={() => setError(msg('media.invalidResponse'))} /> : request.asset && !error ? <p className="media-placeholder"><LoaderCircle className="spin" size={18} />{t('media.loading')}</p> : request.status === 'running' ? <p className="media-placeholder"><LoaderCircle className="spin" size={18} />{status}</p> : null}
    {(url || mode === 'video') && <footer>
      <span>{t('media.downloadTime')}: {time(url ? downloadMs ?? null : null)}</span>
      {url && <a className="primary-button" href={url} download={`${mode}-${request.id}.${extension}`}><Download size={14} />{t('media.download')}</a>}
    </footer>}
    {request.error && <p className="request-error">{tMsg(request.error)}</p>}
    {error && <div className="request-error" role="alert">{tMsg(error)}{!url && <button className="primary-button" onClick={() => setAttempt(value => value + 1)}>{t('media.retryDownload')}</button>}</div>}
  </article>;
}

function ImageResults({ run }: { run: MediaRun }) {
  const { t, tMsg, n, time } = useI18n();
  const metrics = run.endpoints.map(endpoint => mediaMetrics(run, endpoint.id));
  const throughputUnit = t('media.imagesPerSecond');
  const rows = [
    { label: t('media.latency'), values: metrics.map(m => m.mean), format: time, lower: true },
    { label: t('media.minLatency'), values: metrics.map(m => m.min), format: time, lower: true },
    { label: t('media.maxLatency'), values: metrics.map(m => m.max), format: time, lower: true },
    { label: t('media.throughput'), values: metrics.map(m => m.throughput), format: (value: number | null) => `${n(value, 3)} ${throughputUnit}`, lower: false },
    { label: t('media.successRate'), values: metrics.map(m => m.successRate), format: (value: number | null) => `${n(value, 1)}%`, lower: false },
    { label: t('media.serverTime'), values: metrics.map(m => m.serverMean === null ? null : m.serverMean * 1000), format: time, lower: true },
  ];
  function difference(values: (number | null)[], lower: boolean) {
    const [a, b] = values;
    if (a === null || b === null || a <= 0) return t('result.basisMismatch');
    const delta = (b - a) / a * 100;
    const better = run.endpoints[(lower ? b < a : b > a) ? 1 : 0];
    return `${delta >= 0 ? '+' : ''}${n(delta, 1)}%${Math.abs(delta) < .05 ? '' : ` · ${t('result.better', { name: endpointName(better) })}`}`;
  }
  return <section className="panel media-results" aria-label={t('result.title')}>
    <h2>{t('result.title')}</h2>
    <div className="table-scroll"><table><thead><tr><th>{t('result.metric')}</th>{run.endpoints.map(e => <th key={e.id}>{e.id} · {endpointName(e)}</th>)}{run.endpoints.length === 2 && <th>{t('result.relative', { a: 'A', b: 'B' })}</th>}</tr></thead><tbody>
      {rows.map(row => <tr key={row.label}><th>{row.label}</th>{row.values.map((value, i) => <td key={i}>{row.format(value)}</td>)}{run.endpoints.length === 2 && <td>{difference(row.values, row.lower)}</td>}</tr>)}
      <tr><th>{t('media.counts')}</th>{metrics.map((m, i) => <td key={i}>{m.success} / {m.failed} / {m.cancelled}</td>)}{run.endpoints.length === 2 && <td>—</td>}</tr>
    </tbody></table></div>
    <details className="output-details"><summary>{t('media.requests')}<ChevronDown size={14} /></summary><div className="table-scroll"><table><thead><tr><th>ID</th><th>{t('media.state')}</th><th>{t('media.requestLatency')}</th><th>{t('media.error')}</th></tr></thead><tbody>
      {run.requests.map(request => <tr key={request.id}><td>{request.id}</td><td>{t(`status.${request.status}`)}</td><td>{request.startedAt !== null && request.endedAt !== null ? time(request.endedAt - request.startedAt) : '—'}</td><td>{request.error ? tMsg(request.error) : '—'}</td></tr>)}
    </tbody></table></div></details>
  </section>;
}

function MediaTrend({ run, id }: { run: MediaRun; id: 'A' | 'B' }) {
  const { t } = useI18n();
  const last = Math.max(1, run.history.at(-1)?.at ?? 1);
  const max = Math.max(.01, ...run.history.map(point => point[id]));
  const points = run.history.map(point => `${point.at / last * 300},${60 - point[id] / max * 55}`).join(' ');
  return <svg className="media-trend" viewBox="0 0 300 64" role="img" aria-label={t('media.trend')} preserveAspectRatio="none"><path d="M0 60H300" stroke="var(--border)" /><polyline points={points} fill="none" stroke={id === 'A' ? 'var(--accent)' : 'var(--accent-b)'} strokeWidth="2" /></svg>;
}

export default function MediaBenchmark({ mode, active, onPhase }: { mode: MediaMode; active: boolean; onPhase: (phase: number) => void }) {
  const { t, tMsg, n, time } = useI18n();
  const [settings, setSettings] = useState(() => {
    let saved = null;
    try { saved = localStorage.getItem(mediaStorageKey(mode)); } catch { /* Storage is optional. */ }
    return restoreMediaSettings(mode, t(`media.prompt.${mode}`), saved);
  });
  const { config, endpoints, compare } = settings;
  const [run, setRun] = useState<MediaRun | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewInfo>>({});
  const [error, setError] = useState<Msg | null>(null);
  const controller = useRef<ReturnType<typeof startMediaBenchmark> | null>(null);
  const targets = useRef<EndpointConfig[]>([]);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const phase = run ? run.phase === 'complete' ? 2 : 1 : 0;
  useEffect(() => { if (active) { onPhase(phase); if (phase) heading.current?.focus({ preventScroll: true }); } }, [active, phase, onPhase]);
  useEffect(() => { if (!active) { generation.current++; controller.current?.cancel(); controller.current = null; targets.current = []; setRun(null); setPreviews({}); } }, [active]);
  useEffect(() => () => { generation.current++; controller.current?.cancel(); }, []);
  useEffect(() => { try { localStorage.setItem(mediaStorageKey(mode), serializeMediaSettings(settings)); } catch { /* Storage is optional. */ } }, [settings, mode]);
  const onInfo = useCallback((id: string, info: PreviewInfo) => setPreviews(current => ({ ...current, [id]: info })), []);
  if (!active) return null;
  const change = (patch: Partial<MediaConfig>) => setSettings(current => ({ ...current, config: { ...current.config, ...patch } }));
  const preset = resolutions[mode].findIndex(([width, height]) => width === config.width && height === config.height);
  function begin() {
    setError(null); setPreviews({});
    const revision = ++generation.current;
    targets.current = endpoints.slice(0, compare ? 2 : 1).map(endpoint => ({ ...endpoint }));
    try { controller.current = startMediaBenchmark(config, targets.current, state => { if (generation.current === revision) setRun(state); }); }
    catch (reason) { setError(describeError(reason)); }
  }
  return <>
    <div className={`page-heading ${run ? '' : 'configuration-heading'}`}><h1 ref={heading} tabIndex={-1}>{t(phase === 0 ? 'phase.config' : phase === 1 ? 'phase.live' : 'phase.results')} · {t(`media.mode.${mode}`)}</h1>{run && <button className={phase === 1 ? 'stop-button' : 'primary-button'} onClick={() => {
      if (phase === 1) controller.current?.cancel(); else { generation.current++; controller.current = null; setRun(null); setPreviews({}); targets.current = []; }
    }}>{phase === 1 ? <Square size={15} /> : <RotateCcw size={16} />}{t(phase === 1 ? 'run.stop' : 'run.again')}</button>}</div>
    {!run ? <>
      <div className="configuration-workspace media-workspace">
        <section className="preview-panel"><div className="panel-title">{mode === 'image' ? <Image size={18} /> : <Video size={18} />}<h2>{t('media.prompt')}</h2></div>
          <textarea className="media-prompt" aria-label={t('media.prompt')} maxLength={10000} value={config.prompt} onChange={event => change({ prompt: event.target.value })} />
          <div className="preview-footer"><span>{t('media.sharedPrompt')}</span><span>{t('preview.chars', { count: config.prompt.length })}</span></div>
        </section>
        <div className="launch-area"><button className="go-button" aria-label={t('launch.start')} onClick={begin}><span>GO</span><small>{t('launch.start')}</small></button><span className="launch-summary">{compare ? t('launch.compare', { count: 2 }) : t('launch.single', { count: 1 })}</span><p className="hint">{t('media.sessionOnly')}</p>{error && <p role="alert" className="error-text">{tMsg(error)}</p>}</div>
        <section className="parameters-panel" aria-label={t('params.title')}><div className="panel-title"><h2>{t('params.title')}</h2></div>
          <div className="media-resolution"><label>{t('media.resolution')}<strong>{config.width} × {config.height} · {aspectRatio(config.width, config.height)}{preset === -1 ? ` · ${t('media.custom')}` : ''}</strong><input type="range" className="range" aria-label={t('media.resolution')} min={0} max={resolutions[mode].length - 1} value={Math.max(0, preset)} style={{ '--range-fill': `${Math.max(0, preset) / (resolutions[mode].length - 1) * 100}%` } as React.CSSProperties} onChange={event => { const [width, height] = resolutions[mode][Number(event.target.value)]; change({ width, height }); }} /></label>
          <div className="media-dimensions"><label>{t('media.width')}<NumberInput min={64} max={4096} step={1} value={config.width} onValue={value => change({ width: Math.round(value ?? 64) })} /></label><label>{t('media.height')}<NumberInput min={64} max={4096} step={1} value={config.height} onValue={value => change({ height: Math.round(value ?? 64) })} /></label></div></div>
          <div className="parameter-grid">
            {mode === 'video' && <Slider label={t('media.seconds')} value={config.seconds} min={1} max={30} unit="s" icon={<Clock3 size={15} />} onChange={seconds => change({ seconds })} />}
            <Slider label={t('media.steps')} value={config.steps} min={1} max={100} unit="" icon={<Zap size={15} />} onChange={steps => change({ steps })} />
          </div>
          <details className="parameter-options"><summary>{t('params.more')}<ChevronDown size={14} /></summary><div className="secondary-parameters">
            <label>{t('media.seed')}<NumberInput min={0} max={2147483647} value={config.seed} nullable placeholder={t('common.serverDefault')} onValue={seed => change({ seed: seed === null ? null : Math.round(seed) })} /></label>
            {mode === 'video' && <label>FPS<NumberInput min={1} max={60} value={config.fps} onValue={fps => change({ fps: Math.round(fps ?? 24) })} /></label>}
            <label>{t('params.timeout')}<NumberInput aria-label={t('params.timeoutAria')} min={30} max={1800} value={config.timeoutSeconds} onValue={value => change({ timeoutSeconds: Math.round(value ?? 300) })} /></label>
          </div></details>
        </section>
      </div>
      <section className="endpoint-settings"><div className="endpoint-settings-heading"><h2>{t('endpoints.title')} · OpenAI Compatible (vLLM-Omni)</h2><button className={`compare-toggle ${compare ? 'enabled' : ''}`} aria-pressed={compare} onClick={() => setSettings(current => ({ ...current, compare: !current.compare }))}>{compare ? <Check size={14} /> : <Plus size={14} />}{t('compare.label')}</button></div><div className={`endpoint-stack ${compare ? 'two-endpoints' : ''}`}>{endpoints.slice(0, compare ? 2 : 1).map(endpoint => <EndpointCard media key={endpoint.id} endpoint={endpoint} onChange={patch => setSettings(current => ({ ...current, endpoints: current.endpoints.map(e => e.id === endpoint.id ? { ...e, ...patch } : e) }))} />)}</div></section>
    </> : <>
      <div className="run-config-strip"><span>{run.config.width} × {run.config.height}</span><span>{t('media.steps')}: {run.config.steps}</span>{mode === 'video' && <span>{run.config.seconds}s · {run.config.fps} FPS · {aspectRatio(run.config.width, run.config.height)}</span>}{run.config.seed !== null && <span>{t('media.seed')}: {run.config.seed}</span>}<span>{t('media.sessionOnly')}</span><span>{time(run.now - run.startedAt)}</span></div>
      <div className="media-run-content">
        {mode === 'image' && phase === 2 && <ImageResults run={run} />}
        <div className={`media-monitors ${run.endpoints.length === 2 ? 'comparison' : ''}`}>
          {run.endpoints.map(endpoint => {
            const metrics = mediaMetrics(run, endpoint.id);
            const rtf = videoRtf(run, endpoint.id, previews);
            return <section className={`panel media-monitor endpoint-${endpoint.id}`} key={endpoint.id}><div className="panel-title"><span className="endpoint-marker">{endpoint.id}</span><h2>{endpointName(endpoint)}</h2></div>
              <div className="media-stats"><div><span>{t('media.throughput')}</span><strong>{n(metrics.throughput, 3)}</strong><small>{t(mode === 'image' ? 'media.imagesPerSecond' : 'media.videosPerMinute')}</small></div><div><span>{t('media.successRate')}</span><strong>{n(metrics.successRate, 1)}%</strong><small>{metrics.success} / {metrics.count}</small></div><div><span>{t('media.latency')}</span><strong>{time(metrics.mean)}</strong><small>{t('source.measured')}</small></div>{mode === 'video' && <><div><span>RTF</span><strong>{n(rtf.value, 3)}</strong><small>{rtf.value === null ? '—' : t(rtf.estimated ? 'source.estimated' : 'source.measured')}</small></div><div><span>{t('media.serverTime')}</span><strong>{time(metrics.serverMean === null ? null : metrics.serverMean * 1000)}</strong><small>{t('source.reported')}</small></div></>}</div>
              <p className="hint">{t('media.trend')}</p><MediaTrend run={run} id={endpoint.id} />
              <div className="media-outputs">{run.requests.filter(request => request.endpointId === endpoint.id).map(request => <MediaOutput key={request.id} request={request} endpoint={targets.current.find(e => e.id === endpoint.id)!} mode={mode} ratio={run.config.width / run.config.height} now={run.now} onInfo={onInfo} />)}</div>
            </section>;
          })}
        </div>
        <p className="hint media-note">{t(mode === 'image' ? 'media.imageNote' : 'media.videoNote')}</p><p className="hint media-note">{t('media.throughputNote')}</p>
        <details className="output-details"><summary>{t('media.prompt')}<ChevronDown size={14} /></summary><pre className="media-prompt-summary">{run.config.prompt}</pre></details>
      </div>
    </>}
  </>;
}
