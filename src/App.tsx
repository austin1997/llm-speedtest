import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Check, ChevronDown, CircleHelp, Clock3, Copy, Gauge, Layers3, LoaderCircle, Monitor, Moon, Plus, Radio, RotateCcw, Settings2, Square, Sun, Terminal, X, Zap } from 'lucide-react';
import { startBenchmark } from './lib/benchmark';
import { endpointName } from './lib/endpoint';
import { browserDecode, browserDecodeMetric, browserOutputDuration, duration, endpointMetrics, outputCount, serverDecode, serverPrefill, stats, ttft } from './lib/metrics';
import { autoContext, estimateTokens, generatePrompt } from './lib/prompt';
import { discoverModels, endpointUrl, inspectModel } from './lib/protocol';
import { counterLabelKey, detectTokenCounter } from './lib/token-counter';
import { quantityKey, sourceKey } from './lib/provenance';
import { buildRunRecord, createRunId, fetchRecordingStatus, submitRunRecord, type RunRecord } from './lib/recording';
import type { BenchmarkConfig, EndpointConfig, RequestResult, RunState, Source } from './lib/types';
import TokenRace from './TokenRace';
import { useI18n } from './i18n/I18nProvider';
import LanguageSwitcher from './i18n/LanguageSwitcher';
import { describeError, LocalizedError, msg } from './i18n/message';
import type { Msg, Translate } from './i18n/types';

type Theme = 'dark' | 'light' | 'system';
const defaultConfig: BenchmarkConfig = { inputTokens: 1024, outputTokens: 512, concurrency: 1, temperature: null, thinking: 'default', timeoutSeconds: 300 };
const defaultEndpoints: EndpointConfig[] = [
  { id: 'A', alias: '', protocol: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3.6:latest', apiKey: '', includeUsage: true, maxTokensField: 'max_tokens', thinkingFormat: 'reasoning_effort', contextLength: null },
  { id: 'B', alias: '', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.6:latest', apiKey: '', includeUsage: true, maxTokensField: 'max_tokens', thinkingFormat: 'reasoning_effort', contextLength: null },
];

function restore(): { config: BenchmarkConfig; endpoints: EndpointConfig[]; compare: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem('llm-speedtest-config') ?? 'null');
    if (!stored || stored.version !== 1) throw new Error();
    const c = stored.config;
    const config = { ...defaultConfig };
    for (const [key, min, max] of [['inputTokens', 128, 32768], ['outputTokens', 32, 8192], ['concurrency', 1, 16], ['timeoutSeconds', 30, 1800]] as const) {
      if (Number.isFinite(c?.[key])) config[key] = Math.round(Math.max(min, Math.min(max, c[key])));
    }
    if (['default', 'on', 'off'].includes(c?.thinking)) config.thinking = c.thinking;
    if (c?.temperature !== null && Number.isFinite(c?.temperature)) config.temperature = Math.max(0, Math.min(2, c.temperature));
    const endpoints = defaultEndpoints.map((e, i) => {
      const saved = stored.endpoints?.[i];
      if (!saved) return { ...e };
      return { ...e, protocol: saved.protocol === 'openai' ? 'openai' as const : 'ollama' as const,
        alias: typeof saved.alias === 'string' ? saved.alias.slice(0, 64) : '',
        baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : e.baseUrl,
        model: typeof saved.model === 'string' ? saved.model : e.model,
        includeUsage: saved.includeUsage !== false,
        maxTokensField: saved.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' as const : 'max_tokens' as const,
        thinkingFormat: saved.thinkingFormat === 'qwen' ? 'qwen' as const : 'reasoning_effort' as const,
        contextLength: Number.isInteger(saved.contextLength) && saved.contextLength >= 1024 ? saved.contextLength : null, apiKey: '',
        useTokenApi: saved.useTokenApi !== false,
        tokenBatchSize: Number.isInteger(saved.tokenBatchSize) ? Math.max(8, Math.min(512, saved.tokenBatchSize)) : 32,
      };
    });
    return { config, endpoints, compare: stored.compare === true };
  } catch { return { config: { ...defaultConfig }, endpoints: defaultEndpoints.map(e => ({ ...e })), compare: false }; }
}

function NumberInput({ value, onValue, min, max, nullable = false, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max'> & { value: number | null; onValue: (value: number | null) => void; min: number; max: number; nullable?: boolean }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  function commit(raw: string) {
    if (nullable && raw === '') { onValue(null); return; }
    const number = Number(raw);
    if (Number.isFinite(number) && number >= min && number <= max) onValue(number);
  }
  return <input {...props} type="number" min={min} max={max} value={draft} onChange={event => { setDraft(event.target.value); commit(event.target.value); }} onBlur={() => {
    const next = nullable && draft === '' ? null : Math.max(min, Math.min(max, Number(draft) || min));
    setDraft(next === null ? '' : String(next)); onValue(next);
  }} />;
}

function EndpointCard({ endpoint, onChange: commit, config }: { endpoint: EndpointConfig; onChange: (patch: Partial<EndpointConfig>) => void; config: BenchmarkConfig }) {
  const { t, tMsg } = useI18n();
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Msg[]>([]);
  const [connected, setConnected] = useState(false);
  const [checkingTokens, setCheckingTokens] = useState(false);
  const tokenCheck = useRef<AbortController | null>(null);
  function onChange(patch: Partial<EndpointConfig>) {
    if (['baseUrl', 'model', 'protocol', 'apiKey', 'useTokenApi'].some(key => key in patch)) {
      tokenCheck.current?.abort(); setCheckingTokens(false);
    }
    commit(patch);
  }
  const revision = useRef(0);
  useEffect(() => { revision.current++; setModels([]); setMessage([]); setConnected(false); setLoading(false); }, [endpoint.baseUrl, endpoint.protocol, endpoint.apiKey, endpoint.model]);
  useEffect(() => () => tokenCheck.current?.abort(), []);
  async function checkTokens() {
    tokenCheck.current?.abort(); const controller = new AbortController(); tokenCheck.current = controller;
    setCheckingTokens(true);
    try {
      const tokenCounter = await detectTokenCounter(endpoint, controller.signal);
      if (!controller.signal.aborted) onChange({ tokenCounter });
    } catch (error) { if (!controller.signal.aborted) setMessage([describeError(error)]); }
    finally { if (!controller.signal.aborted) setCheckingTokens(false); }
  }
  async function connect() {
    const current = ++revision.current;
    setLoading(true); setMessage([]); setConnected(false);
    try {
      const list = await discoverModels(endpoint);
      if (current !== revision.current) return;
      setModels(list);
      if (endpoint.protocol === 'ollama' && endpoint.model) {
        const info = await inspectModel(endpoint);
        if (current !== revision.current) return;
        onChange({ modelContextLimit: info.context });
        setMessage([msg('connect.modelCount', { count: list.length }), msg(info.thinking ? 'connect.thinking.yes' : 'connect.thinking.no'), ...(info.context ? [msg('connect.context', { count: info.context })] : [])]);
      } else setMessage([msg('connect.modelCount', { count: list.length }), msg('connect.ok')]);
      setConnected(true);
    } catch (error) { if (current === revision.current) setMessage([describeError(error)]); }
    finally { if (current === revision.current) setLoading(false); }
  }
  const context = endpoint.contextLength ?? autoContext(config.inputTokens, config.outputTokens);
  let address = endpoint.baseUrl.trim() || t('endpoint.addressUnset');
  try { address = new URL(endpoint.baseUrl).host; } catch { /* An incomplete address remains editable. */ }
  const displayName = endpointName(endpoint, endpoint.model.trim() || t('endpoint.modelUnset'));
  return <details className={`endpoint-disclosure endpoint-${endpoint.id}`} aria-label={t('endpoint.cardAria', { id: endpoint.id })}>
    <summary aria-label={t('endpoint.editAria', { id: endpoint.id })}>
      <span className="endpoint-marker">{endpoint.id}</span>
      <span className="endpoint-summary"><strong title={displayName}>{displayName}</strong><span>{t(`protocol.${endpoint.protocol}`)} · {address}</span></span>
      <span className="endpoint-edit-label">{t('endpoint.edit')}<ChevronDown size={15} /></span>
    </summary>
    <div className="endpoint-editor">
    <div className="segmented protocol-switch" aria-label={t('endpoint.protocolAria', { id: endpoint.id })}>
      <button className={endpoint.protocol === 'ollama' ? 'selected' : ''} onClick={() => onChange({ protocol: 'ollama', baseUrl: endpoint.baseUrl.replace(/\/v1\/?$/, ''), modelContextLimit: undefined })}>{t('protocol.ollama')}</button>
      <button className={endpoint.protocol === 'openai' ? 'selected' : ''} onClick={() => onChange({ protocol: 'openai', baseUrl: endpoint.protocol === 'ollama' ? endpoint.baseUrl.replace(/\/$/, '') + '/v1' : endpoint.baseUrl, modelContextLimit: undefined })}>{t('protocol.openai')}</button>
    </div>
    <label>{t('endpoint.alias')} <span className="optional">{t('endpoint.aliasHint')}</span><input aria-label={t('endpoint.aliasAria', { id: endpoint.id })} value={endpoint.alias ?? ''} onChange={e => onChange({ alias: e.target.value })} placeholder={t('endpoint.aliasPlaceholder')} maxLength={64} autoComplete="off" /></label>
    <label>{t('endpoint.address')}<input aria-label={t('endpoint.addressAria', { id: endpoint.id })} value={endpoint.baseUrl} onChange={e => onChange({ baseUrl: e.target.value, modelContextLimit: undefined })} placeholder="https://example.com/v1" spellCheck={false} /></label>
    <label>{t('endpoint.model')}<div className="input-with-action"><input aria-label={t('endpoint.modelAria', { id: endpoint.id })} value={endpoint.model} onChange={e => onChange({ model: e.target.value, modelContextLimit: undefined })} list={`models-${endpoint.id}`} placeholder={t('endpoint.modelPlaceholder')} spellCheck={false} /><button className="icon-button" title={t('endpoint.connect')} aria-label={t('endpoint.connectAria', { id: endpoint.id })} onClick={connect} disabled={loading}><Radio size={17} className={loading ? 'spin' : ''} /></button></div></label>
    <datalist id={`models-${endpoint.id}`}>{models.map(model => <option key={model} value={model} />)}</datalist>
    {message.length > 0 && <p role="status" className={`connection-message ${connected ? 'connected' : 'error-text'}`}>{connected && <Check size={14} />}{message.map(tMsg).join(' · ')}</p>}
    <label>API Key <span className="optional">{t('endpoint.apiKeyHint')}</span><input aria-label={t('endpoint.apiKeyAria', { id: endpoint.id })} type="password" value={endpoint.apiKey} onChange={e => onChange({ apiKey: e.target.value })} placeholder={t('endpoint.apiKeyPlaceholder')} autoComplete="off" /></label>
    <details className="advanced"><summary><Settings2 size={15} />{t('advanced.title')}<ChevronDown size={14} /></summary><div className="advanced-content">
      {endpoint.protocol === 'openai' ? <>
        <label className="checkbox-label"><input aria-label={t('tokenApi.useAria', { id: endpoint.id })} type="checkbox" checked={endpoint.useTokenApi !== false} onChange={e => onChange({ useTokenApi: e.target.checked })} />{t('tokenApi.use')}</label>
        <label>{t('tokenApi.interval')}<NumberInput aria-label={t('tokenApi.intervalAria', { id: endpoint.id })} min={8} max={512} value={endpoint.tokenBatchSize ?? 32} disabled={endpoint.useTokenApi === false} onValue={value => onChange({ tokenBatchSize: Math.round(value ?? 32) })} /></label>
        <div className="token-counter-setting"><span role="status">{checkingTokens ? t('tokenApi.checking') : endpoint.useTokenApi === false ? t('tokenApi.disabled') : endpoint.tokenCounter ? t(counterLabelKey(endpoint.tokenCounter)) : endpoint.tokenCounter === null ? t('tokenApi.none') : t('tokenApi.pending')}</span><button className="icon-button" aria-label={t('tokenApi.recheckAria', { id: endpoint.id })} title={t('tokenApi.recheck')} disabled={checkingTokens || endpoint.useTokenApi === false} onClick={checkTokens}><Radio size={15} className={checkingTokens ? 'spin' : ''} /></button></div>
        <p className="hint">{t('tokenApi.hint')}</p>
        <label>{t('advanced.maxTokensField')}<select value={endpoint.maxTokensField} onChange={e => onChange({ maxTokensField: e.target.value as EndpointConfig['maxTokensField'] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
        <label>{t('advanced.thinkingFormat')}<select value={endpoint.thinkingFormat} onChange={e => onChange({ thinkingFormat: e.target.value as EndpointConfig['thinkingFormat'] })}><option value="reasoning_effort">reasoning_effort</option><option value="qwen">{t('advanced.qwenTemplate')}</option></select></label>
        <label className="checkbox-label"><input type="checkbox" checked={endpoint.includeUsage} onChange={e => onChange({ includeUsage: e.target.checked })} />{t('advanced.includeUsage')}</label>
        <p className="hint">{t('advanced.thinkingHint')}</p>
      </> : <>
        <label>{t('advanced.context')}<NumberInput aria-label={t('advanced.contextAria', { id: endpoint.id })} min={1024} max={1048576} step={1024} value={endpoint.contextLength} nullable placeholder={t('advanced.contextPlaceholder', { count: context })} onValue={v => onChange({ contextLength: v === null ? null : Math.round(v) })} /></label>
        <p className="hint">{t('advanced.contextHint')}</p>
      </>}
    </div></details>
    </div>
  </details>;
}

function Slider({ label, value, min, max, unit, onChange, log = false, icon }: { label: string; value: number; min: number; max: number; unit: string; onChange: (n: number) => void; log?: boolean; icon: React.ReactNode }) {
  const { t, int } = useI18n();
  const position = log ? Math.log2(value / min) : value;
  const end = log ? Math.log2(max / min) : max;
  const start = log ? 0 : min;
  const percent = (position - start) / (end - start) * 100;
  return <div className="parameter"><div className="parameter-heading"><span>{icon}{label}</span><span className="parameter-unit">{unit}</span></div><div className="parameter-value"><NumberInput aria-label={t('params.valueAria', { label })} min={min} max={max} value={value} onValue={v => onChange(Math.round(v ?? min))} /></div><input className="range" aria-label={t('params.sliderAria', { label })} type="range" min={start} max={end} step={log ? 0.125 : 1} value={position} style={{ '--range-fill': `${percent}%` } as React.CSSProperties} onChange={e => onChange(log ? Math.min(max, Math.round(min * 2 ** Number(e.target.value))) : Number(e.target.value))} /><div className="range-bounds"><span>{int(min)}</span><span>{int(max)}</span></div></div>;
}

function SpeedGauge({ value, complete = false, accent = 'A', source = 'estimated' }: { value: number | null; complete?: boolean; accent?: 'A' | 'B'; source?: Source }) {
  const { t, n } = useI18n();
  const max = Math.max(100, Math.ceil((value ?? 0) / 100) * 100);
  const progress = Math.min(1, (value ?? 0) / max);
  const displayValue = n(value, 1);
  return <div className={`speed-gauge gauge-${accent}`} data-source={source} style={{ '--gauge-characters': displayValue.length } as React.CSSProperties}><svg viewBox="0 -16 320 226" aria-hidden="true"><path className="gauge-track" d="M 36 171 A 132 132 0 1 1 284 171" pathLength="100" /><path className="gauge-fill" d="M 36 171 A 132 132 0 1 1 284 171" pathLength="100" strokeDasharray={`${progress * 100} 100`} />{Array.from({ length: 25 }, (_, i) => { const angle = (160 + i * 220 / 24) * Math.PI / 180; return <line key={i} className="gauge-tick" x1={160 + Math.cos(angle) * 113} y1={126 + Math.sin(angle) * 113} x2={160 + Math.cos(angle) * (i % 6 === 0 ? 103 : 108)} y2={126 + Math.sin(angle) * (i % 6 === 0 ? 103 : 108)} />; })}</svg><div className="gauge-number"><span className="gauge-caption" title={t(sourceKey(source))}>{complete ? t('metric.overall') : t('gauge.live')}</span><strong title={`${displayValue} tokens / sec`}>{displayValue}</strong><span className="gauge-unit">tokens / sec</span></div><span className="gauge-min">0</span><span className="gauge-max">{max}</span></div>;
}

function TrendChart({ run, endpoint, note, source }: { run: RunState; endpoint: EndpointConfig; note: string; source: Source }) {
  const { t, n } = useI18n();
  const id = endpoint.id;
  const data = run.history;
  const max = Math.max(10, ...data.map(point => point[id]));
  const end = Math.max(1, (run.now - run.startedAt) / 1000);
  // At most 300 chart points, regardless of the length of a run.
  const step = Math.max(1, Math.ceil(data.length / 300));
  const points = data.filter((_, index) => index % step === 0 || index === data.length - 1).map(point => `${point.at / end * 600},${90 - point[id] / max * 74}`).join(' ');
  return <div className={`trend trend-${id}`}><div className="trend-label"><span><Activity size={14} />{t('trend.title')} <span className="muted">· {source === 'calibrated' ? t('trend.calibrated') : t('trend.estimated')}</span></span><span>{n(max, 0)} tok/s</span></div><svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label={t('trend.aria', { name: endpointName(endpoint, t('endpoint.fallbackName', { id })) })}><line className="chart-grid" x1="0" y1="16" x2="600" y2="16" /><line className="chart-grid" x1="0" y1="53" x2="600" y2="53" /><line className="chart-grid" x1="0" y1="90" x2="600" y2="90" />{points && <><polygon className="chart-area" points={`0,100 ${points} 600,100`} /><polyline className="chart-line" points={points} /></>}</svg><div className="chart-time"><span>0 s</span><span className="gauge-source" title={note}>{note}</span><span>{n(end, 1)} s</span></div></div>;
}

function MetricCard({ label, value, unit, source = 'measured', icon, title }: { label: string; value: string; unit?: string; source?: Source; icon?: React.ReactNode; title?: string }) {
  const { t } = useI18n();
  return <div className="metric-card" title={title}><div className="metric-label">{icon}{label}</div><div className="metric-number">{value}{unit && <span>{unit}</span>}</div><span className={`source source-${source}`}>{t(sourceKey(source))}</span></div>;
}

const overallSource = (t: Translate, source: Source) => t('trend.overallSource', { quantity: t(quantityKey(source)) });

function OutputWindow({ request, now }: { request: RequestResult; now: number }) {
  const { t, tMsg, n, time } = useI18n();
  const outputRef = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const count = outputCount(request);
  const approximate = count.source === 'estimated' || count.source === 'calibrated';
  useEffect(() => { const node = outputRef.current; if (node && follow.current) node.scrollTop = node.scrollHeight; }, [request.text]);
  return <article className={`output-window status-${request.status}`} data-token-source={count.source} data-counted-tokens={request.countedTokens} data-counted-chars={request.countedChars} data-text-chars={request.text.length}><header><span><Terminal size={14} />{t('request.title', { index: String(request.index).padStart(2, '0') })}</span><span className="request-status">{request.status === 'running' && <span className="live-dot" />}{t(`status.${request.status}`)}</span></header><pre ref={outputRef} tabIndex={0} aria-label={t('request.outputAria', { id: request.id })} onScroll={() => { const node = outputRef.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; }}>{request.text || <span className="output-placeholder">{request.status === 'running' ? t('output.waiting') : request.status === 'success' ? t('output.empty') : t('output.none')}</span>}</pre>{request.error && <div className="request-error" role="alert">{tMsg(request.error)}</div>}<footer title={request.tokenCountError ? tMsg(request.tokenCountError) : undefined}><span title={t('output.ttftTitle', { time: time(ttft(request)) })}>{t('output.ttft', { time: time(ttft(request)) })}</span><span title={t('output.tokensTitle', { count: n(count.value, 0), source: t(sourceKey(count.source)) })}>{count.source === 'counted' && !approximate ? t('output.tokensCounted', { count: n(count.value, 0) }) : t('output.tokens', { count: n(count.value, 0) })}{approximate && ' ≈'}</span><span title={t('output.durationTitle', { time: time(duration(request, now)) })}>{time(duration(request, now))}</span></footer></article>;
}

function EndpointMonitor({ run, endpoint }: { run: RunState; endpoint: EndpointConfig }) {
  const { t, n, time } = useI18n();
  const metric = endpointMetrics(run, endpoint.id);
  const complete = run.phase === 'complete';
  const currentTTFT = stats(metric.requests.map(ttft)).mean;
  const columns = run.config.concurrency > 9 ? 4 : run.config.concurrency > 4 ? 3 : run.config.concurrency > 1 ? 2 : 1;
  return <section className={`monitor panel endpoint-${endpoint.id}`}><div className="monitor-heading"><span className="endpoint-marker">{endpoint.id}</span><div><h2 title={endpointName(endpoint)}>{endpointName(endpoint)}</h2><p title={`${endpoint.model} · ${endpoint.baseUrl}`}>{t(`protocol.${endpoint.protocol}`)} · {new URL(endpoint.baseUrl).host}</p></div><span className="monitor-count">{complete ? t('monitor.succeeded', { ok: metric.successful.length, total: metric.requests.length }) : metric.finalizingTokens && metric.active === 0 ? t('monitor.finalizing') : t('monitor.active', { count: metric.active })}</span></div>
    <div className="monitor-overview">
      <div className="monitor-speed">
        <SpeedGauge value={complete ? metric.overall.value : metric.live} complete={complete} accent={endpoint.id} source={complete ? metric.overall.source : metric.liveSource} />
      </div>
      <div className="monitor-telemetry">
        <div className="metric-grid"><MetricCard label={t('metric.ttft')} value={time(complete ? metric.ttft.mean : currentTTFT)} icon={<Zap size={14} />} /><MetricCard label={t('metric.browserDecode')} value={n(complete ? metric.decode.mean : metric.liveDecode.mean)} unit="tok/s" source={complete ? metric.decode.source : metric.liveDecode.source} title={t('note.browserDecode')} /><MetricCard label={complete ? t('metric.duration') : t('metric.elapsed')} value={time(complete ? metric.duration.mean : metric.elapsed)} icon={<Clock3 size={14} />} /></div>
        <TrendChart run={run} endpoint={endpoint} source={endpoint.tokenCounter && !metric.tokenWarnings.length ? 'calibrated' : 'estimated'} note={metric.tokenWarnings.length ? t('trend.fallback') : complete ? t('trend.complete', { source: overallSource(t, metric.overall.source) }) : t('trend.live', { source: t(sourceKey(metric.liveSource)) })} />
      </div>
    </div>
    <div className={`output-grid ${run.config.concurrency > 1 ? 'multiple' : ''}`} aria-label={t('output.gridAria', { name: endpointName(endpoint, t('endpoint.fallbackName', { id: endpoint.id })) })} data-dense={run.config.concurrency > 9 || undefined} style={{ '--output-columns': columns, '--output-rows': Math.ceil(run.config.concurrency / columns), '--last-span': columns - (run.config.concurrency - 1) % columns } as React.CSSProperties}>{metric.requests.map(request => <OutputWindow key={request.id} request={request} now={run.now} />)}</div>
  </section>;
}

function BenchmarkDashboard({ run }: { run: RunState }) {
  return <div className={`monitors benchmark-dashboard ${run.endpoints.length > 1 ? 'comparison' : ''}`}>{run.endpoints.map(endpoint => <EndpointMonitor key={endpoint.id} run={run} endpoint={endpoint} />)}</div>;
}

function Results({ run }: { run: RunState }) {
  const { t, n, time } = useI18n();
  const metrics = run.endpoints.map(e => ({ endpoint: e, ...endpointMetrics(run, e.id) }));
  const a = metrics[0], b = metrics[1];
  const aName = endpointName(a.endpoint, a.endpoint.id);
  const bName = b ? endpointName(b.endpoint, b.endpoint.id) : '';
  function difference(av: number | null, bv: number | null, lower = false) {
    if (av == null || bv == null || av <= 0) return '—';
    const delta = (bv - av) / av * 100;
    return `${delta >= 0 ? '+' : ''}${n(delta, 1)}%${Math.abs(delta) < 0.05 ? '' : ` · ${t('result.better', { name: (lower ? delta < 0 : delta > 0) ? bName : aName })}`}`;
  }
  const mismatch = t('result.basisMismatch');
  const rows = [
    { id: 'ttft', label: t('metric.ttft'), cells: metrics.map(m => time(m.ttft.mean)), compare: b ? difference(a.ttft.mean, b.ttft.mean, true) : '' },
    { id: 'browserDecode', label: t('metric.browserDecodeMean'), cells: metrics.map(m => `${n(m.decode.mean)} tok/s · ${m.decode.source === 'measured' ? t('result.decodeMeasured') : m.decode.mixed ? t('result.decodeMixed') : t(sourceKey(m.decode.source))}`), compare: b && a.decode.source === b.decode.source && !a.decode.mixed && !b.decode.mixed ? difference(a.decode.mean, b.decode.mean) : mismatch },
    { id: 'overall', label: t('metric.overall'), cells: metrics.map(m => `${n(m.overall.value)} tok/s · ${overallSource(t, m.overall.source)}`), compare: b && a.overall.source === b.overall.source ? difference(a.overall.value, b.overall.value) : mismatch },
    { id: 'duration', label: t('metric.duration'), cells: metrics.map(m => time(m.duration.mean)), compare: b ? difference(a.duration.mean, b.duration.mean, true) : '' },
    { id: 'serverDecode', label: t('metric.serverDecodeMean'), cells: metrics.map(m => `${n(m.serverDecode.mean)} tok/s`), compare: b && a.endpoint.protocol === 'ollama' && b.endpoint.protocol === 'ollama' ? difference(a.serverDecode.mean, b.serverDecode.mean) : '—' },
    { id: 'serverPrefill', label: t('metric.serverPrefillMean'), cells: metrics.map(m => `${n(m.prefill.mean)} tok/s`), compare: b && a.endpoint.protocol === 'ollama' && b.endpoint.protocol === 'ollama' ? difference(a.prefill.mean, b.prefill.mean) : '—' },
    { id: 'load', label: t('metric.load'), cells: metrics.map(m => time(m.load.mean)), compare: b ? difference(a.load.mean, b.load.mean, true) : '' },
    { id: 'counts', label: t('metric.counts'), cells: metrics.map(m => `${m.successful.length} / ${m.failed} / ${m.cancelled}`), compare: '—' },
  ];
  function calculation(id: string, metric: typeof a) {
    if (id === 'browserDecode') return t('calc.browserDecodeMean', { note: t('note.browserDecode') });
    if (id === 'overall') return t('calc.overall', { tokens: n(metric.tokens, 0), elapsed: time(metric.elapsed) });
    if (id === 'serverDecode') return t('calc.serverDecode');
    if (id === 'serverPrefill') return t('calc.serverPrefill');
    return undefined;
  }
  const fallbackName = (endpoint: EndpointConfig) => t('endpoint.fallbackName', { id: endpoint.id });
  return <section className="panel results-panel" aria-label={t('result.title')}><div className="panel-title"><Layers3 size={18} /><h2>{t('result.title')}</h2><span className="optional">{t('result.subtitle')}</span></div><div className="table-scroll summary-table"><table><thead><tr><th>{t('result.metric')}</th>{metrics.map(m => <th key={m.endpoint.id}><span className="result-endpoint-name" title={endpointName(m.endpoint, fallbackName(m.endpoint))}>{endpointName(m.endpoint, fallbackName(m.endpoint))}</span></th>)}{b && <th><span className="result-endpoint-name" title={t('result.relative', { b: bName, a: aName })}>{t('result.relative', { b: bName, a: aName })}</span></th>}</tr></thead><tbody>{rows.map(row => <tr key={row.id}><td title={calculation(row.id, a)}>{row.label}</td>{metrics.map((m, i) => <td key={m.endpoint.id} title={calculation(row.id, m)}>{row.cells[i]}</td>)}{b && <td className="comparison-cell"><span className="comparison-value" title={row.compare}>{row.compare}</span></td>}</tr>)}</tbody></table></div>
    <div className="stat-ranges">{metrics.map(m => <div key={m.endpoint.id} aria-label={t('range.aria', { name: endpointName(m.endpoint, fallbackName(m.endpoint)) })}><span className="endpoint-marker" title={endpointName(m.endpoint)}>{m.endpoint.id}</span><div className="range-values"><span>{t('range.ttft', { min: time(m.ttft.min), max: time(m.ttft.max) })}</span><span>{t('range.decode', { min: n(m.decode.min), max: n(m.decode.max) })}{(m.decode.source === 'estimated' || m.decode.source === 'calibrated') && ' ≈'}</span><span>{t('range.success', { rate: n(m.successful.length / m.requests.length * 100, 0) })}</span></div></div>)}</div>
    <div className="result-disclosures">
    <details className="request-details"><summary>{t('details.requests')}<ChevronDown size={16} /></summary><div className="table-scroll"><table><thead><tr><th>{t('table.request')}</th><th>{t('table.status')}</th><th>{t('table.ttft')}</th><th>{t('table.inputTokens')}</th><th>{t('table.outputTokens')}</th><th>{t('table.cachedInput')}</th><th>{t('table.reasoningTokens')}</th><th>{t('table.browserDecode')}</th><th>{t('table.outputDuration')}</th><th>{t('table.serverDecode')}</th><th>{t('table.serverDecodeTime')}</th><th>{t('table.serverPrefill')}</th><th>{t('table.serverPrefillTime')}</th><th>{t('table.serverTotal')}</th><th>{t('table.requestTotal')}</th><th>{t('table.finishReason')}</th></tr></thead><tbody>{run.requests.map(r => {
      const endpoint = run.endpoints.find(e => e.id === r.endpointId)!;
      const name = endpoint.alias?.trim() ? `${endpointName(endpoint)} · ${r.index}` : r.id;
      const decode = browserDecodeMetric(r);
      const count = outputCount(r);
      return <tr key={r.id}><td><span className="result-endpoint-name" title={`${name} (${r.id})`}>{name}</span></td><td>{t(`status.${r.status}`)}</td><td>{time(ttft(r))}</td><td>{n(r.usage?.input ?? estimateTokens(run.prompt), 0)}{r.usage?.input === undefined && ' ≈'}</td><td title={t(sourceKey(count.source))}>{n(count.value, 0)}{(count.source === 'estimated' || count.source === 'calibrated') && ' ≈'}</td><td>{n(r.usage?.cachedInput, 0)}</td><td>{n(r.usage?.reasoning, 0)}</td><td title={t('table.decodeTitle', { note: t('note.browserDecode'), source: t(sourceKey(decode.source)) })}>{n(browserDecode(r))} tok/s{(decode.source === 'estimated' || decode.source === 'calibrated') && ' ≈'}</td><td>{time(browserOutputDuration(r))}</td><td title="eval_count / eval_duration × 10⁹">{n(serverDecode(r))} tok/s</td><td title={`eval_duration = ${n(r.timing?.decodeNs, 0)} ns`}>{time(r.timing?.decodeNs === undefined ? null : r.timing.decodeNs / 1e6)}</td><td title="(prompt_eval_count − prompt_eval_cached_count) / prompt_eval_duration × 10⁹">{n(serverPrefill(r))} tok/s</td><td title={`prompt_eval_duration = ${n(r.timing?.prefillNs, 0)} ns`}>{time(r.timing?.prefillNs === undefined ? null : r.timing.prefillNs / 1e6)}</td><td title={`total_duration = ${n(r.timing?.totalNs, 0)} ns`}>{time(r.timing?.totalNs === undefined ? null : r.timing.totalNs / 1e6)}</td><td>{time(duration(r, run.now))}</td><td>{r.finishReason ?? '—'}</td></tr>;
    })}</tbody></table></div></details>
    <details className="output-details"><summary aria-label={t('details.outputAria')}>{t('details.output')}<ChevronDown size={16} /></summary><BenchmarkDashboard run={run} /></details>
    </div>
    <p className="hint result-note">{t('result.note')}</p>
  </section>;
}

export default function App() {
  const { t, tMsg, time, rich } = useI18n();
  const initial = useMemo(restore, []);
  const [config, setConfig] = useState(initial.config);
  const [endpoints, setEndpoints] = useState(initial.endpoints);
  const [compare, setCompare] = useState(initial.compare);
  const [theme, setTheme] = useState<Theme>(() => { try { const t = localStorage.getItem('llm-speedtest-theme'); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } });
  const [run, setRun] = useState<RunState | null>(null);
  const [resultsReady, setResultsReady] = useState(false);
  const [raceAnimating, setRaceAnimating] = useState(false);
  const [error, setError] = useState<Msg | null>(null);
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [recordingAvailable, setRecordingAvailable] = useState(false);
  const [recordResults, setRecordResults] = useState(() => { try { return localStorage.getItem('llm-speedtest-record') !== '0'; } catch { return true; } });
  const [recordState, setRecordState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const preparation = useRef<AbortController | null>(null);
  const controller = useRef<ReturnType<typeof startBenchmark> | null>(null);
  const recordingStatus = useRef<Promise<{ recording: boolean }> | null>(null);
  const recordPayload = useRef<RunRecord | null>(null);
  const recordGeneration = useRef(0);
  const recordResultsRef = useRef(recordResults);
  recordResultsRef.current = recordResults;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const prompt = useMemo(() => generatePrompt(config.inputTokens), [config.inputTokens]);
  const phase = run ? resultsReady && !raceAnimating ? 2 : 1 : 0;
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('llm-speedtest-theme', theme); } catch { /* Storage is optional. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { try { localStorage.setItem('llm-speedtest-config', JSON.stringify({ version: 1, config, endpoints: endpoints.map(({ apiKey: _key, modelContextLimit: _limit, tokenCounter: _counter, ...endpoint }) => { let baseUrl = ''; try { endpointUrl({ ...endpoint, apiKey: '' }, 'chat'); baseUrl = endpoint.baseUrl; } catch { /* Invalid URLs may contain credentials. */ } return { ...endpoint, baseUrl }; }), compare })); } catch { /* Storage is optional. */ } }, [config, endpoints, compare]);
  useEffect(() => () => { preparation.current?.abort(); controller.current?.cancel(); }, []);
  function loadRecordingStatus() {
    recordingStatus.current ??= fetchRecordingStatus();
    return recordingStatus.current;
  }
  useEffect(() => {
    let cancelled = false;
    void loadRecordingStatus().then(status => { if (!cancelled) setRecordingAvailable(status.recording); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { try { localStorage.setItem('llm-speedtest-record', recordResults ? '1' : '0'); } catch { /* Storage is optional. */ } }, [recordResults]);
  useEffect(() => {
    if (run?.phase !== 'complete') return;
    const timer = setTimeout(() => setResultsReady(true), 1000);
    return () => clearTimeout(timer);
  }, [run?.phase]);
  useEffect(() => { if (phase > 0) titleRef.current?.focus({ preventScroll: true }); }, [phase]);
  const updateConfig = (patch: Partial<BenchmarkConfig>) => { preparation.current?.abort(); setConfig(c => ({ ...c, ...patch })); };
  const updateEndpoint = (id: EndpointConfig['id'], patch: Partial<EndpointConfig>) => {
    if (Object.keys(patch).some(key => key !== 'tokenCounter')) preparation.current?.abort();
    const invalidate = ['baseUrl', 'model', 'protocol', 'apiKey', 'useTokenApi'].some(key => key in patch);
    setEndpoints(all => all.map(e => e.id === id ? { ...e, ...patch, ...(invalidate ? { tokenCounter: undefined } : {}) } : e));
  };
  async function begin() {
    if (preparing) { preparation.current?.abort(); return; }
    setError(null);
    const active = endpoints.slice(0, compare ? 2 : 1).map(e => ({ ...e }));
    const settings = { ...config }, input = prompt;
    const preflight = new AbortController(); preparation.current = preflight;
    try {
      for (const endpoint of active) {
        endpointUrl(endpoint, 'chat');
        if (!endpoint.model.trim()) throw new LocalizedError('error.modelRequired', { id: endpoint.id });
        if (endpoint.protocol === 'ollama') {
          const context = endpoint.contextLength ?? autoContext(config.inputTokens, config.outputTokens);
          if (context < config.inputTokens + config.outputTokens + 512) throw new LocalizedError('error.contextTooSmall', { id: endpoint.id });
          if (endpoint.modelContextLimit && context > endpoint.modelContextLimit) throw new LocalizedError('error.contextOverLimit', { id: endpoint.id, limit: endpoint.modelContextLimit });
        }
      }
      setPreparing(true);
      const tested = await Promise.all(active.map(async endpoint => {
        const tokenCounter = endpoint.protocol !== 'openai' || endpoint.useTokenApi === false ? null : endpoint.tokenCounter === undefined ? await detectTokenCounter(endpoint, preflight.signal) : endpoint.tokenCounter;
        return { ...endpoint, tokenCounter };
      }));
      if (preflight.signal.aborted) return;
      setEndpoints(all => all.map(endpoint => {
        const testedEndpoint = tested.find(e => e.id === endpoint.id);
        return testedEndpoint ? { ...endpoint, tokenCounter: testedEndpoint.tokenCounter } : endpoint;
      }));
      setResultsReady(false); setRaceAnimating(false);
      const status = await loadRecordingStatus();
      if (preflight.signal.aborted) return;
      const benchmark = startBenchmark(settings, tested, input, setRun);
      controller.current = benchmark;
      if (status.recording && recordResultsRef.current) {
        const generation = ++recordGeneration.current;
        const runId = createRunId();
        const startedAt = Date.now();
        setRecordState('saving');
        void benchmark.finished.then(async state => {
          if (recordGeneration.current !== generation) return;
          try {
            const payload = await buildRunRecord({ run: state, endpoints: tested, runId, startedAt, appVersion: __APP_VERSION__, prompt: input });
            if (recordGeneration.current !== generation) return;
            recordPayload.current = payload;
            const saved = await submitRunRecord(payload);
            if (recordGeneration.current !== generation) return;
            setRecordState(saved.ok ? 'saved' : 'failed');
          } catch { if (recordGeneration.current === generation) setRecordState('failed'); }
        });
      } else { recordGeneration.current += 1; recordPayload.current = null; setRecordState('idle'); }
    } catch (err) { if (!preflight.signal.aborted) setError(describeError(err)); }
    finally { if (preparation.current === preflight) { preparation.current = null; setPreparing(false); } }
  }
  async function retryRecord() {
    const payload = recordPayload.current;
    const generation = recordGeneration.current;
    if (!payload) return;
    setRecordState('saving');
    const saved = await submitRunRecord(payload);
    if (recordGeneration.current === generation) setRecordState(saved.ok ? 'saved' : 'failed');
  }
  async function copyPrompt() { try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setError(msg('error.clipboard')); } }
  return <div className={`app-shell viewport-shell ${phase === 0 ? 'configuration-shell' : phase === 1 ? 'running-shell' : 'results-shell'} ${phase === 1 && run?.endpoints.length === 2 ? 'race-comparison' : ''}`}>
    <header className="site-header">
      <a className="brand" href="/" aria-label={t('brand.homeAria')}><span className="brand-icon"><Gauge size={25} strokeWidth={1.8} /></span><span>LLM <strong>SPEEDTEST</strong></span></a>
      <div className="header-tools">
        <button className={`help-button ${help ? 'active' : ''}`} onClick={() => setHelp(!help)} aria-expanded={help}><CircleHelp size={17} /><span>{t('header.guide')}</span></button>
        <LanguageSwitcher />
        <div className="segmented theme-switch" aria-label={t('theme.group')}>
          <button title={t('theme.light')} aria-label={t('theme.lightAria')} className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}><Sun size={16} /></button>
          <button title={t('theme.system')} aria-label={t('theme.systemAria')} className={theme === 'system' ? 'selected' : ''} onClick={() => setTheme('system')}><Monitor size={16} /></button>
          <button title={t('theme.dark')} aria-label={t('theme.darkAria')} className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}><Moon size={16} /></button>
        </div>
      </div>
    </header>
    {help && <aside className="connection-guide panel"><div className="panel-title"><CircleHelp size={18} /><h2>{t('guide.title')}</h2><button className="icon-button" aria-label={t('guide.close')} onClick={() => setHelp(false)}><X size={17} /></button></div><div className="guide-grid"><div><h3>{t('guide.ollama.title')}</h3><p>{rich('guide.ollama.body', { address: <code>http://localhost:11434</code>, origins: <code>OLLAMA_ORIGINS</code> })}</p></div><div><h3>{t('guide.openai.title')}</h3><p>{rich('guide.openai.body', { v1: <code>/v1</code>, contentType: <code>Content-Type</code>, authorization: <code>Authorization</code> })}</p></div><div><h3>{t('guide.failure.title')}</h3><p>{t('guide.failure.body')}</p></div></div></aside>}
    <nav className="phase-nav" aria-label={t('phase.group')}>{(['phase.config', 'phase.live', 'phase.results'] as const).map((label, i) => <span key={label} className={phase === i ? 'current' : phase > i ? 'passed' : ''} aria-current={phase === i ? 'step' : undefined}><b>{phase > i ? <Check size={12} /> : `0${i + 1}`}</b>{t(label)}</span>)}</nav>
    <main className="main-content" key={run ? 'run' : 'config'}>
      <div className={`page-heading ${run ? '' : 'configuration-heading'}`}>
        <div>
          <h1 ref={titleRef} tabIndex={-1}>{phase === 0 ? t('heading.config') : phase === 1 ? t('phase.live') : t('phase.results')}</h1>
        </div>
        {phase === 1 && run?.endpoints.length === 2 && <TokenRace run={run} onAnimationChange={setRaceAnimating} />}
        {run && <button className={phase === 1 ? 'stop-button' : 'primary-button'} disabled={phase === 1 && run.phase === 'complete'} onClick={() => { if (phase === 1) controller.current?.cancel(); else { recordGeneration.current += 1; setRecordState('idle'); setRun(null); setResultsReady(false); setRaceAnimating(false); controller.current = null; } }}>{phase === 1 ? run.phase === 'complete' ? <Check size={15} /> : <Square size={15} /> : <RotateCcw size={17} />}{phase === 1 ? run.phase === 'complete' ? t('run.finished') : t('run.stop') : t('run.again')}</button>}
      </div>
      {!run ? <>
        <div className="configuration-workspace">
          <section className="preview-panel" aria-label={t('preview.title')}>
            <div className="panel-title"><h2>{t('preview.title')}</h2><span className="preview-token-count">{t('preview.tokens', { count: estimateTokens(prompt) })}</span><button className="icon-button" aria-label={t('preview.copy')} title={t('preview.copy')} onClick={copyPrompt}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
            <pre className="prompt-preview" data-testid="prompt-preview">{prompt}</pre>
            <div className="preview-footer"><span>{t('preview.footer')}</span><span>{t('preview.chars', { count: prompt.length })}</span></div>
          </section>
          <div className="launch-area">
            <button className="go-button" aria-label={preparing ? t('launch.cancelAria') : t('launch.start')} onClick={begin}>{preparing ? <LoaderCircle size={54} className="spin" /> : <span>GO</span>}<small>{preparing ? t('launch.detecting') : t('launch.start')}</small></button>
            <span className="launch-summary">{compare ? t('launch.compare', { count: 2 * config.concurrency }) : t('launch.single', { count: config.concurrency })}</span>
            {recordingAvailable && <label className="record-toggle"><input type="checkbox" checked={recordResults} onChange={event => setRecordResults(event.target.checked)} />{t('record.label')}<small>{t('record.detail')}</small></label>}
            {error && <p className="error-text launch-error" role="alert">{tMsg(error)}</p>}
          </div>
          <section className="parameters-panel" aria-label={t('params.title')}>
            <div className="panel-title"><h2>{t('params.title')}</h2></div>
            <div className="parameter-grid">
              <Slider label={t('params.input')} value={config.inputTokens} min={128} max={32768} unit={t('unit.tokenApprox')} onChange={value => updateConfig({ inputTokens: value })} log icon={<Terminal size={15} />} />
              <Slider label={t('params.output')} value={config.outputTokens} min={32} max={8192} unit={t('unit.token')} onChange={value => updateConfig({ outputTokens: value })} log icon={<Zap size={15} />} />
              <Slider label={t('params.concurrency')} value={config.concurrency} min={1} max={16} unit={t('unit.perEndpoint')} onChange={value => updateConfig({ concurrency: value })} icon={<Layers3 size={15} />} />
            </div>
            <details className="parameter-options">
              <summary>{t('params.more')}<ChevronDown size={14} /></summary>
              <div className="secondary-parameters">
                <label>{t('params.thinking')}<select aria-label={t('params.thinking')} value={config.thinking} onChange={e => updateConfig({ thinking: e.target.value as BenchmarkConfig['thinking'] })}><option value="default">{t('common.serverDefault')}</option><option value="on">{t('thinking.on')}</option><option value="off">{t('thinking.off')}</option></select></label>
                <label>{t('params.temperature')}<NumberInput aria-label={t('params.temperature')} min={0} max={2} step={0.1} value={config.temperature} nullable placeholder={t('common.serverDefault')} onValue={v => updateConfig({ temperature: v })} /></label>
                <label>{t('params.timeout')}<NumberInput aria-label={t('params.timeoutAria')} min={30} max={1800} value={config.timeoutSeconds} onValue={v => updateConfig({ timeoutSeconds: Math.round(v ?? 30) })} /></label>
              </div>
            </details>
          </section>
        </div>
        <section className="endpoint-settings" aria-label={t('endpoints.title')}>
          <div className="endpoint-settings-heading"><h2>{t('endpoints.title')}</h2><button className={`compare-toggle ${compare ? 'enabled' : ''}`} aria-pressed={compare} onClick={() => { preparation.current?.abort(); setCompare(!compare); }}>{compare ? <Check size={14} /> : <Plus size={14} />}{t('compare.label')}</button></div>
          <div className={`endpoint-stack ${compare ? 'two-endpoints' : ''}`}>{endpoints.slice(0, compare ? 2 : 1).map(endpoint => <EndpointCard key={endpoint.id} endpoint={endpoint} config={config} onChange={patch => updateEndpoint(endpoint.id, patch)} />)}</div>
        </section>
      </> : <>
        <div className="run-config-strip"><span><Terminal size={14} />{t('strip.input', { count: run.config.inputTokens })}</span><span><Zap size={14} />{t('strip.output', { count: run.config.outputTokens })}</span><span><Layers3 size={14} />{t('strip.concurrency', { count: run.config.concurrency })}</span><span>{t(`strip.thinking.${run.config.thinking}`)}</span>{recordState !== 'idle' && <span className="record-status" data-testid="record-status">{recordState === 'saving' ? t('record.saving') : recordState === 'saved' ? t('record.saved') : <>{t('record.failed')}<button type="button" onClick={retryRecord}>{t('record.retry')}</button></>}</span>}{phase === 1 && <span className="run-timer">{run.phase === 'running' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{time(run.now - run.startedAt)}</span>}</div>
        {phase === 2 ? <Results run={run} /> : <BenchmarkDashboard run={run} />}
      </>}
    </main>
    <footer className="site-footer"><span><Activity size={13} />LLM SPEEDTEST<span className="footer-separator">/</span>{t('footer.tagline')}</span><span>OpenAI compatible<span className="footer-dot">·</span>Ollama</span></footer>
  </div>;
}
