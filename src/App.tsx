import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Check, ChevronDown, CircleHelp, Clock3, Copy, Gauge, Layers3, LoaderCircle, Monitor, Moon, Plus, Radio, RotateCcw, Settings2, Square, Sun, Terminal, X, Zap } from 'lucide-react';
import { startBenchmark } from './lib/benchmark';
import { endpointName } from './lib/endpoint';
import { browserDecode, duration, endpointMetrics, outputCount, serverDecode, stats, ttft } from './lib/metrics';
import { autoContext, estimateTokens, generatePrompt } from './lib/prompt';
import { connectionError, discoverModels, endpointUrl, inspectModel } from './lib/protocol';
import type { BenchmarkConfig, EndpointConfig, RequestResult, RunState, Source } from './lib/types';
import TokenRace from './TokenRace';

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
      };
    });
    return { config, endpoints, compare: stored.compare === true };
  } catch { return { config: { ...defaultConfig }, endpoints: defaultEndpoints.map(e => ({ ...e })), compare: false }; }
}

const sourceLabels: Record<Source, string> = { reported: '端点报告', measured: '浏览器测量', estimated: '估算' };
const n = (value: number | null | undefined, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const time = (value: number | null | undefined) => value == null ? '—' : value >= 1000 ? `${n(value / 1000, 2)} s` : `${n(value, 0)} ms`;

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

function EndpointCard({ endpoint, onChange, config }: { endpoint: EndpointConfig; onChange: (patch: Partial<EndpointConfig>) => void; config: BenchmarkConfig }) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);
  const revision = useRef(0);
  useEffect(() => { revision.current++; setModels([]); setMessage(''); setConnected(false); setLoading(false); }, [endpoint.baseUrl, endpoint.protocol, endpoint.apiKey, endpoint.model]);
  async function connect() {
    const current = ++revision.current;
    setLoading(true); setMessage(''); setConnected(false);
    try {
      const list = await discoverModels(endpoint);
      if (current !== revision.current) return;
      setModels(list);
      if (endpoint.protocol === 'ollama' && endpoint.model) {
        const info = await inspectModel(endpoint);
        if (current !== revision.current) return;
        onChange({ modelContextLimit: info.context });
        setMessage(`${list.length} 个模型 · ${info.thinking ? '支持思考' : '未声明思考能力'}${info.context ? ` · 上下文 ${info.context.toLocaleString()}` : ''}`);
      } else setMessage(`${list.length} 个模型 · 连接成功`);
      setConnected(true);
    } catch (error) { if (current === revision.current) setMessage(connectionError(error)); }
    finally { if (current === revision.current) setLoading(false); }
  }
  const context = endpoint.contextLength ?? autoContext(config.inputTokens, config.outputTokens);
  let address = endpoint.baseUrl.trim() || '未设置地址';
  try { address = new URL(endpoint.baseUrl).host; } catch { /* An incomplete address remains editable. */ }
  return <details className={`endpoint-disclosure endpoint-${endpoint.id}`} aria-label={`端点 ${endpoint.id} 配置`}>
    <summary aria-label={`编辑端点 ${endpoint.id}`}>
      <span className="endpoint-marker">{endpoint.id}</span>
      <span className="endpoint-summary"><strong title={endpointName(endpoint, endpoint.model.trim() || '未设置模型')}>{endpointName(endpoint, endpoint.model.trim() || '未设置模型')}</strong><span>{endpoint.protocol === 'ollama' ? 'Ollama' : 'OpenAI 兼容'} · {address}</span></span>
      <span className="endpoint-edit-label">修改<ChevronDown size={15} /></span>
    </summary>
    <div className="endpoint-editor">
    <div className="segmented protocol-switch" aria-label={`端点 ${endpoint.id} 协议`}>
      <button className={endpoint.protocol === 'ollama' ? 'selected' : ''} onClick={() => onChange({ protocol: 'ollama', baseUrl: endpoint.baseUrl.replace(/\/v1\/?$/, ''), modelContextLimit: undefined })}>Ollama</button>
      <button className={endpoint.protocol === 'openai' ? 'selected' : ''} onClick={() => onChange({ protocol: 'openai', baseUrl: endpoint.protocol === 'ollama' ? endpoint.baseUrl.replace(/\/$/, '') + '/v1' : endpoint.baseUrl, modelContextLimit: undefined })}>OpenAI 兼容</button>
    </div>
    <label>别名 <span className="optional">可选 · 用于显示</span><input aria-label={`端点 ${endpoint.id} 别名`} value={endpoint.alias ?? ''} onChange={e => onChange({ alias: e.target.value })} placeholder="例如：本地 Qwen" maxLength={64} autoComplete="off" /></label>
    <label>端点地址<input aria-label={`端点 ${endpoint.id} 地址`} value={endpoint.baseUrl} onChange={e => onChange({ baseUrl: e.target.value, modelContextLimit: undefined })} placeholder="https://example.com/v1" spellCheck={false} /></label>
    <label>模型<div className="input-with-action"><input aria-label={`端点 ${endpoint.id} 模型`} value={endpoint.model} onChange={e => onChange({ model: e.target.value, modelContextLimit: undefined })} list={`models-${endpoint.id}`} placeholder="填写模型名称" spellCheck={false} /><button className="icon-button" title="连接并获取模型" aria-label={`连接端点 ${endpoint.id} 并获取模型`} onClick={connect} disabled={loading}><Radio size={17} className={loading ? 'spin' : ''} /></button></div></label>
    <datalist id={`models-${endpoint.id}`}>{models.map(model => <option key={model} value={model} />)}</datalist>
    {message && <p role="status" className={`connection-message ${connected ? 'connected' : 'error-text'}`}>{connected && <Check size={14} />}{message}</p>}
    <label>API Key <span className="optional">可选 · 仅存于当前页面</span><input aria-label={`端点 ${endpoint.id} API Key`} type="password" value={endpoint.apiKey} onChange={e => onChange({ apiKey: e.target.value })} placeholder="无需认证时留空" autoComplete="off" /></label>
    <details className="advanced"><summary><Settings2 size={15} />兼容与上下文设置<ChevronDown size={14} /></summary><div className="advanced-content">
      {endpoint.protocol === 'openai' ? <>
        <label>输出上限字段<select value={endpoint.maxTokensField} onChange={e => onChange({ maxTokensField: e.target.value as EndpointConfig['maxTokensField'] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
        <label>思考控制格式<select value={endpoint.thinkingFormat} onChange={e => onChange({ thinkingFormat: e.target.value as EndpointConfig['thinkingFormat'] })}><option value="reasoning_effort">reasoning_effort</option><option value="qwen">Qwen 模板参数</option></select></label>
        <label className="checkbox-label"><input type="checkbox" checked={endpoint.includeUsage} onChange={e => onChange({ includeUsage: e.target.checked })} />请求流式 usage</label>
        <p className="hint">思考参数须由服务支持；拒绝参数时可调整后重新测试。</p>
      </> : <>
        <label>上下文长度<NumberInput aria-label={`端点 ${endpoint.id} 上下文长度`} min={1024} max={1048576} step={1024} value={endpoint.contextLength} nullable placeholder={`自动 · ${context.toLocaleString()}`} onValue={v => onChange({ contextLength: v === null ? null : Math.round(v) })} /></label>
        <p className="hint">自动值包含输入估算、输出预算与 512 token 余量。较长上下文会增加内存需求。</p>
      </>}
    </div></details>
    </div>
  </details>;
}

function Slider({ label, value, min, max, unit, onChange, log = false, icon }: { label: string; value: number; min: number; max: number; unit: string; onChange: (n: number) => void; log?: boolean; icon: React.ReactNode }) {
  const position = log ? Math.log2(value / min) : value;
  const end = log ? Math.log2(max / min) : max;
  const start = log ? 0 : min;
  const percent = (position - start) / (end - start) * 100;
  return <div className="parameter"><div className="parameter-heading"><span>{icon}{label}</span><span className="parameter-unit">{unit}</span></div><div className="parameter-value"><NumberInput aria-label={`${label}数值`} min={min} max={max} value={value} onValue={v => onChange(Math.round(v ?? min))} /></div><input className="range" aria-label={`${label}滑块`} type="range" min={start} max={end} step={log ? 0.125 : 1} value={position} style={{ '--range-fill': `${percent}%` } as React.CSSProperties} onChange={e => onChange(log ? Math.min(max, Math.round(min * 2 ** Number(e.target.value))) : Number(e.target.value))} /><div className="range-bounds"><span>{min.toLocaleString()}</span><span>{max.toLocaleString()}</span></div></div>;
}

function SpeedGauge({ value, complete = false, accent = 'A' }: { value: number | null; complete?: boolean; accent?: 'A' | 'B' }) {
  const max = Math.max(100, Math.ceil((value ?? 0) / 100) * 100);
  const progress = Math.min(1, (value ?? 0) / max);
  const displayValue = n(value, 1);
  return <div className={`speed-gauge gauge-${accent}`} style={{ '--gauge-characters': displayValue.length } as React.CSSProperties}><svg viewBox="0 -16 320 226" aria-hidden="true"><path className="gauge-track" d="M 36 171 A 132 132 0 1 1 284 171" pathLength="100" /><path className="gauge-fill" d="M 36 171 A 132 132 0 1 1 284 171" pathLength="100" strokeDasharray={`${progress * 100} 100`} />{Array.from({ length: 25 }, (_, i) => { const angle = (160 + i * 220 / 24) * Math.PI / 180; return <line key={i} className="gauge-tick" x1={160 + Math.cos(angle) * 113} y1={126 + Math.sin(angle) * 113} x2={160 + Math.cos(angle) * (i % 6 === 0 ? 103 : 108)} y2={126 + Math.sin(angle) * (i % 6 === 0 ? 103 : 108)} />; })}</svg><div className="gauge-number"><span className="gauge-caption">{complete ? '整轮吞吐' : '实时吞吐'}</span><strong title={`${displayValue} tokens / sec`}>{displayValue}</strong><span className="gauge-unit">tokens / sec</span></div><span className="gauge-min">0</span><span className="gauge-max">{max}</span></div>;
}

function TrendChart({ run, endpoint, note }: { run: RunState; endpoint: EndpointConfig; note: string }) {
  const id = endpoint.id;
  const data = run.history;
  const max = Math.max(10, ...data.map(point => point[id]));
  const end = Math.max(1, (run.now - run.startedAt) / 1000);
  // At most 300 chart points, regardless of the length of a run.
  const step = Math.max(1, Math.ceil(data.length / 300));
  const points = data.filter((_, index) => index % step === 0 || index === data.length - 1).map(point => `${point.at / end * 600},${90 - point[id] / max * 74}`).join(' ');
  return <div className={`trend trend-${id}`}><div className="trend-label"><span><Activity size={14} />吞吐趋势 <span className="muted">· 估算</span></span><span>{n(max, 0)} tok/s</span></div><svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label={`${endpointName(endpoint, `端点 ${id}`)} 吞吐趋势`}><line className="chart-grid" x1="0" y1="16" x2="600" y2="16" /><line className="chart-grid" x1="0" y1="53" x2="600" y2="53" /><line className="chart-grid" x1="0" y1="90" x2="600" y2="90" />{points && <><polygon className="chart-area" points={`0,100 ${points} 600,100`} /><polyline className="chart-line" points={points} /></>}</svg><div className="chart-time"><span>0 s</span><span className="gauge-source">{note}</span><span>{n(end, 1)} s</span></div></div>;
}

function MetricCard({ label, value, unit, source = 'measured', icon }: { label: string; value: string; unit?: string; source?: Source; icon?: React.ReactNode }) {
  return <div className="metric-card"><div className="metric-label">{icon}{label}</div><div className="metric-number">{value}{unit && <span>{unit}</span>}</div><span className={`source source-${source}`}>{sourceLabels[source]}</span></div>;
}

const statusLabels = { pending: '等待开始', running: '接收中', success: '已完成', error: '失败', cancelled: '已停止' };
function OutputWindow({ request, now }: { request: RequestResult; now: number }) {
  const outputRef = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => { const node = outputRef.current; if (node && follow.current) node.scrollTop = node.scrollHeight; }, [request.text]);
  return <article className={`output-window status-${request.status}`}><header><span><Terminal size={14} />请求 {String(request.index).padStart(2, '0')}</span><span className="request-status">{request.status === 'running' && <span className="live-dot" />}{statusLabels[request.status]}</span></header><pre ref={outputRef} tabIndex={0} aria-label={`请求 ${request.id} 输出`} onScroll={() => { const node = outputRef.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; }}>{request.text || <span className="output-placeholder">{request.status === 'running' ? '等待模型的第一个输出…' : request.status === 'success' ? '模型未返回可见文本。' : '尚未收到文本。'}</span>}</pre>{request.error && <div className="request-error" role="alert">{request.error}</div>}<footer><span title={`首字延迟 ${time(ttft(request))}`}>首字 {time(ttft(request))}</span><span title={`${n(outputCount(request).value, 0)} token · ${sourceLabels[outputCount(request).source]}`}>{n(outputCount(request).value, 0)} token{outputCount(request).source === 'estimated' ? ' ≈' : ''}</span><span title={`总耗时 ${time(duration(request, now))}`}>{time(duration(request, now))}</span></footer></article>;
}

function EndpointMonitor({ run, endpoint }: { run: RunState; endpoint: EndpointConfig }) {
  const metric = endpointMetrics(run, endpoint.id);
  const complete = run.phase === 'complete';
  const currentTTFT = stats(metric.requests.map(ttft)).mean;
  const columns = run.config.concurrency > 9 ? 4 : run.config.concurrency > 4 ? 3 : run.config.concurrency > 1 ? 2 : 1;
  return <section className={`monitor panel endpoint-${endpoint.id}`}><div className="monitor-heading"><span className="endpoint-marker">{endpoint.id}</span><div><h2 title={endpointName(endpoint)}>{endpointName(endpoint)}</h2><p title={`${endpoint.model} · ${endpoint.baseUrl}`}>{endpoint.protocol === 'ollama' ? 'Ollama' : 'OpenAI 兼容'} · {new URL(endpoint.baseUrl).host}</p></div><span className="monitor-count">{complete ? `${metric.successful.length}/${metric.requests.length} 成功` : `${metric.active} 请求进行中`}</span></div>
    <div className="monitor-overview">
      <div className="monitor-speed">
        <SpeedGauge value={complete ? metric.overall.value : metric.live} complete={complete} accent={endpoint.id} />
      </div>
      <div className="monitor-telemetry">
        <div className="metric-grid"><MetricCard label="首字延迟" value={time(complete ? metric.ttft.mean : currentTTFT)} icon={<Zap size={14} />} /><MetricCard label="浏览器 decode" value={n(complete ? metric.decode.mean : stats(metric.requests.map(browserDecode)).mean)} unit="tok/s" source="estimated" /><MetricCard label={complete ? '平均总耗时' : '本轮已用时'} value={time(complete ? metric.duration.mean : metric.elapsed)} icon={<Clock3 size={14} />} /></div>
        <TrendChart run={run} endpoint={endpoint} note={complete ? `${sourceLabels[metric.overall.source]} · 含首字等待的端到端吞吐` : '估算 · 思考与正文合并统计'} />
      </div>
    </div>
    <div className={`output-grid ${run.config.concurrency > 1 ? 'multiple' : ''}`} aria-label={`${endpointName(endpoint, `端点 ${endpoint.id}`)} 输出`} data-dense={run.config.concurrency > 9 || undefined} style={{ '--output-columns': columns, '--output-rows': Math.ceil(run.config.concurrency / columns), '--last-span': columns - (run.config.concurrency - 1) % columns } as React.CSSProperties}>{metric.requests.map(request => <OutputWindow key={request.id} request={request} now={run.now} />)}</div>
  </section>;
}

function BenchmarkDashboard({ run }: { run: RunState }) {
  return <div className={`monitors benchmark-dashboard ${run.endpoints.length > 1 ? 'comparison' : ''}`}>{run.endpoints.map(endpoint => <EndpointMonitor key={endpoint.id} run={run} endpoint={endpoint} />)}</div>;
}

function Results({ run }: { run: RunState }) {
  const metrics = run.endpoints.map(e => ({ endpoint: e, ...endpointMetrics(run, e.id) }));
  const a = metrics[0], b = metrics[1];
  const aName = endpointName(a.endpoint, a.endpoint.id);
  const bName = b ? endpointName(b.endpoint, b.endpoint.id) : '';
  function difference(av: number | null, bv: number | null, lower = false) {
    if (av == null || bv == null || av <= 0) return '—';
    const delta = (bv - av) / av * 100;
    return `${delta >= 0 ? '+' : ''}${n(delta, 1)}%${Math.abs(delta) < 0.05 ? '' : ` · ${(lower ? delta < 0 : delta > 0) ? bName : aName} 更优`}`;
  }
  const rows = [
    ['首字延迟', ...metrics.map(m => time(m.ttft.mean)), b ? difference(a.ttft.mean, b.ttft.mean, true) : ''],
    ['浏览器 decode · 估算', ...metrics.map(m => `${n(m.decode.mean)} tok/s`), b ? difference(a.decode.mean, b.decode.mean) : ''],
    ['整轮吞吐', ...metrics.map(m => `${n(m.overall.value)} tok/s · ${sourceLabels[m.overall.source]}`), b && a.overall.source === b.overall.source ? difference(a.overall.value, b.overall.value) : '口径不同或数据不足'],
    ['平均总耗时', ...metrics.map(m => time(m.duration.mean)), b ? difference(a.duration.mean, b.duration.mean, true) : ''],
    ['服务端 decode · 端点报告', ...metrics.map(m => `${n(m.serverDecode.mean)} tok/s`), b && a.endpoint.protocol === 'ollama' && b.endpoint.protocol === 'ollama' ? difference(a.serverDecode.mean, b.serverDecode.mean) : '—'],
    ['服务端 prefill · 端点报告', ...metrics.map(m => `${n(m.prefill.mean)} tok/s`), b && a.endpoint.protocol === 'ollama' && b.endpoint.protocol === 'ollama' ? difference(a.prefill.mean, b.prefill.mean) : '—'],
    ['模型加载 · 端点报告', ...metrics.map(m => time(m.load.mean)), b ? difference(a.load.mean, b.load.mean, true) : ''],
    ['成功 / 失败 / 停止', ...metrics.map(m => `${m.successful.length} / ${m.failed} / ${m.cancelled}`), '—'],
  ];
  return <section className="panel results-panel" aria-label="本轮结果"><div className="panel-title"><Layers3 size={18} /><h2>本轮结果</h2><span className="optional">成功请求的性能统计</span></div><div className="table-scroll summary-table"><table><thead><tr><th>指标</th>{metrics.map(m => <th key={m.endpoint.id}><span className="result-endpoint-name" title={endpointName(m.endpoint, `端点 ${m.endpoint.id}`)}>{endpointName(m.endpoint, `端点 ${m.endpoint.id}`)}</span></th>)}{b && <th><span className="result-endpoint-name" title={`${bName} 相对 ${aName}`}>{bName} 相对 {aName}</span></th>}</tr></thead><tbody>{rows.map(row => <tr key={row[0]}><td>{row[0]}</td>{metrics.map((m, i) => <td key={m.endpoint.id}>{row[i + 1]}</td>)}{b && <td className="comparison-cell"><span className="comparison-value" title={row[row.length - 1]}>{row[row.length - 1]}</span></td>}</tr>)}</tbody></table></div>
    <div className="stat-ranges">{metrics.map(m => <div key={m.endpoint.id} aria-label={`${endpointName(m.endpoint, `端点 ${m.endpoint.id}`)} 指标范围`}><span className="endpoint-marker" title={endpointName(m.endpoint)}>{m.endpoint.id}</span><div className="range-values"><span>首字范围 {time(m.ttft.min)} – {time(m.ttft.max)}</span><span>decode 范围 {n(m.decode.min)} – {n(m.decode.max)} tok/s ≈</span><span>成功率 {n(m.successful.length / m.requests.length * 100, 0)}%</span></div></div>)}</div>
    <div className="result-disclosures">
    <details className="request-details"><summary>查看逐请求用量与服务数据<ChevronDown size={16} /></summary><div className="table-scroll"><table><thead><tr><th>请求</th><th>状态</th><th>首字</th><th>输入 token</th><th>输出 token</th><th>缓存输入</th><th>推理 token</th><th>服务端 decode</th><th>结束原因</th></tr></thead><tbody>{run.requests.map(r => {
      const endpoint = run.endpoints.find(e => e.id === r.endpointId)!;
      const name = endpoint.alias?.trim() ? `${endpointName(endpoint)} · ${r.index}` : r.id;
      return <tr key={r.id}><td><span className="result-endpoint-name" title={`${name} (${r.id})`}>{name}</span></td><td>{statusLabels[r.status]}</td><td>{time(ttft(r))}</td><td>{n(r.usage?.input ?? estimateTokens(run.prompt), 0)}{r.usage?.input === undefined && ' ≈'}</td><td>{n(outputCount(r).value, 0)}{outputCount(r).source === 'estimated' && ' ≈'}</td><td>{n(r.usage?.cachedInput, 0)}</td><td>{n(r.usage?.reasoning, 0)}</td><td>{n(serverDecode(r))} tok/s</td><td>{r.finishReason ?? '—'}</td></tr>;
    })}</tbody></table></div></details>
    <details className="output-details"><summary aria-label="查看输出详情">查看输出与性能曲线<ChevronDown size={16} /></summary><BenchmarkDashboard run={run} /></details>
    </div>
    <p className="hint result-note">首字包括第一段思考或正文。输出上限不保证生成满额；浏览器与服务端 decode 使用不同口径。模型驻留、提示缓存及共享硬件会影响重复测试与 A/B 结果。</p>
  </section>;
}

export default function App() {
  const initial = useMemo(restore, []);
  const [config, setConfig] = useState(initial.config);
  const [endpoints, setEndpoints] = useState(initial.endpoints);
  const [compare, setCompare] = useState(initial.compare);
  const [theme, setTheme] = useState<Theme>(() => { try { const t = localStorage.getItem('llm-speedtest-theme'); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } });
  const [run, setRun] = useState<RunState | null>(null);
  const [resultsVisible, setResultsVisible] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const controller = useRef<ReturnType<typeof startBenchmark> | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const prompt = useMemo(() => generatePrompt(config.inputTokens), [config.inputTokens]);
  const phase = run ? resultsVisible ? 2 : 1 : 0;
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('llm-speedtest-theme', theme); } catch { /* Storage is optional. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { try { localStorage.setItem('llm-speedtest-config', JSON.stringify({ version: 1, config, endpoints: endpoints.map(({ apiKey: _key, modelContextLimit: _limit, ...endpoint }) => { let baseUrl = ''; try { endpointUrl({ ...endpoint, apiKey: '' }, 'chat'); baseUrl = endpoint.baseUrl; } catch { /* Invalid URLs may contain credentials. */ } return { ...endpoint, baseUrl }; }), compare })); } catch { /* Storage is optional. */ } }, [config, endpoints, compare]);
  useEffect(() => () => controller.current?.cancel(), []);
  useEffect(() => {
    if (run?.phase !== 'complete') return;
    const timer = setTimeout(() => setResultsVisible(true), 1000);
    return () => clearTimeout(timer);
  }, [run?.phase]);
  useEffect(() => { if (phase > 0) titleRef.current?.focus({ preventScroll: true }); }, [phase]);
  const updateConfig = (patch: Partial<BenchmarkConfig>) => setConfig(c => ({ ...c, ...patch }));
  const updateEndpoint = (id: EndpointConfig['id'], patch: Partial<EndpointConfig>) => setEndpoints(all => all.map(e => e.id === id ? { ...e, ...patch } : e));
  function begin() {
    setError('');
    const active = endpoints.slice(0, compare ? 2 : 1).map(e => ({ ...e }));
    try {
      for (const endpoint of active) {
        endpointUrl(endpoint, 'chat');
        if (!endpoint.model.trim()) throw new Error(`请填写端点 ${endpoint.id} 的模型名称。`);
        if (endpoint.protocol === 'ollama') {
          const context = endpoint.contextLength ?? autoContext(config.inputTokens, config.outputTokens);
          if (context < config.inputTokens + config.outputTokens + 512) throw new Error(`端点 ${endpoint.id} 的上下文不足以容纳估算输入、输出预算和模板余量，请增加上下文长度或减少测试长度。`);
          if (endpoint.modelContextLimit && context > endpoint.modelContextLimit) throw new Error(`端点 ${endpoint.id} 的上下文超过模型报告的上限 ${endpoint.modelContextLimit.toLocaleString()}。`);
        }
      }
      setResultsVisible(false);
      controller.current = startBenchmark({ ...config }, active, prompt, setRun);
    } catch (err) { setError(connectionError(err)); }
  }
  async function copyPrompt() { try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setError('无法访问剪贴板，请从预览中选择并复制文本。'); } }
  return <div className={`app-shell viewport-shell ${phase === 0 ? 'configuration-shell' : phase === 1 ? 'running-shell' : 'results-shell'} ${phase === 1 && run?.endpoints.length === 2 ? 'race-comparison' : ''}`}>
    <header className="site-header">
      <a className="brand" href="/" aria-label="LLM Speedtest 首页"><span className="brand-icon"><Gauge size={25} strokeWidth={1.8} /></span><span>LLM <strong>SPEEDTEST</strong></span></a>
      <div className="header-tools">
        <button className={`help-button ${help ? 'active' : ''}`} onClick={() => setHelp(!help)} aria-expanded={help}><CircleHelp size={17} /><span>连接指南</span></button>
        <div className="segmented theme-switch" aria-label="主题">
          <button title="浅色" aria-label="浅色主题" className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}><Sun size={16} /></button>
          <button title="跟随系统" aria-label="跟随系统主题" className={theme === 'system' ? 'selected' : ''} onClick={() => setTheme('system')}><Monitor size={16} /></button>
          <button title="深色" aria-label="深色主题" className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}><Moon size={16} /></button>
        </div>
      </div>
    </header>
    {help && <aside className="connection-guide panel"><div className="panel-title"><CircleHelp size={18} /><h2>浏览器直连指南</h2><button className="icon-button" aria-label="关闭连接指南" onClick={() => setHelp(false)}><X size={17} /></button></div><div className="guide-grid"><div><h3>本地 Ollama</h3><p>地址填写 <code>http://localhost:11434</code>。从部署网站访问时，将网站的完整来源加入 <code>OLLAMA_ORIGINS</code> 后重启 Ollama，并允许浏览器的本地网络访问。</p></div><div><h3>OpenAI 兼容服务</h3><p>填写带 <code>/v1</code> 的 API 基址或完整 Chat Completions 地址。服务必须允许当前网站跨域访问，以及 <code>Content-Type</code> 和需要时的 <code>Authorization</code> 请求头。</p></div><div><h3>遇到连接失败</h3><p>检查服务状态、端口、CORS 与 HTTPS 限制。浏览器可能隐藏具体原因；可在本机运行网站后测试。所有推理请求从当前浏览器发出。</p></div></div></aside>}
    <nav className="phase-nav" aria-label="测试阶段">{['配置测试', '实时测速', '测试结果'].map((label, i) => <span key={label} className={phase === i ? 'current' : phase > i ? 'passed' : ''} aria-current={phase === i ? 'step' : undefined}><b>{phase > i ? <Check size={12} /> : `0${i + 1}`}</b>{label}</span>)}</nav>
    <main className="main-content" key={run ? 'run' : 'config'}>
      <div className={`page-heading ${run ? '' : 'configuration-heading'}`}>
        <div>
          <h1 ref={titleRef} tabIndex={-1}>{phase === 0 ? '测量你的 LLM' : phase === 1 ? '实时测速' : '测试结果'}</h1>
        </div>
        {phase === 1 && run?.endpoints.length === 2 && <TokenRace run={run} />}
        {run && <button className={phase === 1 ? 'stop-button' : 'primary-button'} disabled={phase === 1 && run.phase === 'complete'} onClick={() => { if (phase === 1) controller.current?.cancel(); else { setRun(null); setResultsVisible(false); controller.current = null; } }}>{phase === 1 ? run.phase === 'complete' ? <Check size={15} /> : <Square size={15} /> : <RotateCcw size={17} />}{phase === 1 ? run.phase === 'complete' ? '测试结束' : '停止测试' : '再次测试'}</button>}
      </div>
      {!run ? <>
        <div className="configuration-workspace">
          <section className="preview-panel" aria-label="输入预览">
            <div className="panel-title"><h2>输入预览</h2><span className="preview-token-count">≈ {estimateTokens(prompt).toLocaleString()} tokens</span><button className="icon-button" aria-label="复制输入" title="复制输入" onClick={copyPrompt}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
            <pre className="prompt-preview" data-testid="prompt-preview">{prompt}</pre>
            <div className="preview-footer"><span>实际发送的完整输入</span><span>{prompt.length.toLocaleString()} 字符</span></div>
          </section>
          <div className="launch-area">
            <button className="go-button" aria-label="开始测试" onClick={begin}><span>GO</span><small>开始测试</small></button>
            <span className="launch-summary">{compare ? 2 * config.concurrency : config.concurrency} 个请求 · {compare ? 'A/B 对比' : '单端点'}</span>
            {error && <p className="error-text launch-error" role="alert">{error}</p>}
          </div>
          <section className="parameters-panel" aria-label="测试参数">
            <div className="panel-title"><h2>测试参数</h2></div>
            <div className="parameter-grid">
              <Slider label="输入长度" value={config.inputTokens} min={128} max={32768} unit="token ≈" onChange={value => updateConfig({ inputTokens: value })} log icon={<Terminal size={15} />} />
              <Slider label="输出上限" value={config.outputTokens} min={32} max={8192} unit="token" onChange={value => updateConfig({ outputTokens: value })} log icon={<Zap size={15} />} />
              <Slider label="并发请求" value={config.concurrency} min={1} max={16} unit="/ 端点" onChange={value => updateConfig({ concurrency: value })} icon={<Layers3 size={15} />} />
            </div>
            <details className="parameter-options">
              <summary>更多参数<ChevronDown size={14} /></summary>
              <div className="secondary-parameters">
                <label>思考模式<select aria-label="思考模式" value={config.thinking} onChange={e => updateConfig({ thinking: e.target.value as BenchmarkConfig['thinking'] })}><option value="default">服务默认</option><option value="on">开启思考</option><option value="off">关闭思考</option></select></label>
                <label>Temperature<NumberInput aria-label="Temperature" min={0} max={2} step={0.1} value={config.temperature} nullable placeholder="服务默认" onValue={v => updateConfig({ temperature: v })} /></label>
                <label>超时 / 秒<NumberInput aria-label="请求超时" min={30} max={1800} value={config.timeoutSeconds} onValue={v => updateConfig({ timeoutSeconds: Math.round(v ?? 30) })} /></label>
              </div>
            </details>
          </section>
        </div>
        <section className="endpoint-settings" aria-label="测试端点">
          <div className="endpoint-settings-heading"><h2>测试端点</h2><button className={`compare-toggle ${compare ? 'enabled' : ''}`} aria-pressed={compare} onClick={() => setCompare(!compare)}>{compare ? <Check size={14} /> : <Plus size={14} />}A/B 对比</button></div>
          <div className={`endpoint-stack ${compare ? 'two-endpoints' : ''}`}>{endpoints.slice(0, compare ? 2 : 1).map(endpoint => <EndpointCard key={endpoint.id} endpoint={endpoint} config={config} onChange={patch => updateEndpoint(endpoint.id, patch)} />)}</div>
        </section>
      </> : <>
        <div className="run-config-strip"><span><Terminal size={14} />输入 ≈ {run.config.inputTokens.toLocaleString()}</span><span><Zap size={14} />输出上限 {run.config.outputTokens.toLocaleString()}</span><span><Layers3 size={14} />并发 {run.config.concurrency} / 端点</span><span>思考 {run.config.thinking === 'default' ? '服务默认' : run.config.thinking === 'on' ? '开启' : '关闭'}</span>{phase === 1 && <span className="run-timer">{run.phase === 'running' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{time(run.now - run.startedAt)}</span>}</div>
        {phase === 2 ? <Results run={run} /> : <BenchmarkDashboard run={run} />}
      </>}
    </main>
    <footer className="site-footer"><span><Activity size={13} />LLM SPEEDTEST<span className="footer-separator">/</span>浏览器实测</span><span>OpenAI compatible<span className="footer-dot">·</span>Ollama</span></footer>
  </div>;
}
