import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Radio, Settings2 } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { describeError, msg } from '../i18n/message';
import type { Msg } from '../i18n/types';
import { autoContext } from '../lib/prompt';
import { endpointName } from '../lib/endpoint';
import { discoverModels, inspectModel } from '../lib/protocol';
import { mediaUrl } from '../lib/media-protocol';
import { counterLabelKey, detectTokenCounter } from '../lib/token-counter';
import type { EndpointConfig, BenchmarkConfig } from '../lib/types';

export function NumberInput({ value, onValue, min, max, nullable = false, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max'> & { value: number | null; onValue: (value: number | null) => void; min: number; max: number; nullable?: boolean }) {
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

export function EndpointCard({ endpoint, onChange: commit, config, media = false }: { endpoint: EndpointConfig; onChange: (patch: Partial<EndpointConfig>) => void; config?: BenchmarkConfig; media?: boolean }) {
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
      const list = await discoverModels(media ? { ...endpoint, baseUrl: mediaUrl(endpoint.baseUrl, 'models') } : endpoint);
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
  const context = endpoint.contextLength ?? autoContext(config?.inputTokens ?? 1024, config?.outputTokens ?? 512);
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
    {!media && <div className="segmented protocol-switch" aria-label={t('endpoint.protocolAria', { id: endpoint.id })}>
      <button className={endpoint.protocol === 'ollama' ? 'selected' : ''} onClick={() => onChange({ protocol: 'ollama', baseUrl: endpoint.baseUrl.replace(/\/v1\/?$/, ''), modelContextLimit: undefined })}>{t('protocol.ollama')}</button>
      <button className={endpoint.protocol === 'openai' ? 'selected' : ''} onClick={() => onChange({ protocol: 'openai', baseUrl: endpoint.protocol === 'ollama' ? endpoint.baseUrl.replace(/\/$/, '') + '/v1' : endpoint.baseUrl, modelContextLimit: undefined })}>{t('protocol.openai')}</button>
    </div>}
    <label>{t('endpoint.alias')} <span className="optional">{t('endpoint.aliasHint')}</span><input aria-label={t('endpoint.aliasAria', { id: endpoint.id })} value={endpoint.alias ?? ''} onChange={e => onChange({ alias: e.target.value })} placeholder={t('endpoint.aliasPlaceholder')} maxLength={64} autoComplete="off" /></label>
    <label>{t('endpoint.address')}<input aria-label={t('endpoint.addressAria', { id: endpoint.id })} value={endpoint.baseUrl} onChange={e => onChange({ baseUrl: e.target.value, modelContextLimit: undefined })} placeholder="https://example.com/v1" spellCheck={false} /></label>
    <label>{t('endpoint.model')}<div className="input-with-action"><input aria-label={t('endpoint.modelAria', { id: endpoint.id })} value={endpoint.model} onChange={e => onChange({ model: e.target.value, modelContextLimit: undefined })} list={`models-${endpoint.id}`} placeholder={t('endpoint.modelPlaceholder')} spellCheck={false} /><button className="icon-button" title={t('endpoint.connect')} aria-label={t('endpoint.connectAria', { id: endpoint.id })} onClick={connect} disabled={loading}><Radio size={17} className={loading ? 'spin' : ''} /></button></div></label>
    <datalist id={`models-${endpoint.id}`}>{models.map(model => <option key={model} value={model} />)}</datalist>
    {message.length > 0 && <p role="status" className={`connection-message ${connected ? 'connected' : 'error-text'}`}>{connected && <Check size={14} />}{message.map(tMsg).join(' · ')}</p>}
    <label>API Key <span className="optional">{t('endpoint.apiKeyHint')}</span><input aria-label={t('endpoint.apiKeyAria', { id: endpoint.id })} type="password" value={endpoint.apiKey} onChange={e => onChange({ apiKey: e.target.value })} placeholder={t('endpoint.apiKeyPlaceholder')} autoComplete="off" /></label>
    {!media && <details className="advanced"><summary><Settings2 size={15} />{t('advanced.title')}<ChevronDown size={14} /></summary><div className="advanced-content">
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
    </div></details>}
    </div>
  </details>;
}

export function Slider({ label, value, min, max, unit, onChange, log = false, icon }: { label: string; value: number; min: number; max: number; unit: string; onChange: (n: number) => void; log?: boolean; icon: React.ReactNode }) {
  const { t, int } = useI18n();
  const position = log ? Math.log2(value / min) : value;
  const end = log ? Math.log2(max / min) : max;
  const start = log ? 0 : min;
  const percent = (position - start) / (end - start) * 100;
  return <div className="parameter"><div className="parameter-heading"><span>{icon}{label}</span><span className="parameter-unit">{unit}</span></div><div className="parameter-value"><NumberInput aria-label={t('params.valueAria', { label })} min={min} max={max} value={value} onValue={v => onChange(Math.round(v ?? min))} /></div><input className="range" aria-label={t('params.sliderAria', { label })} type="range" min={start} max={end} step={log ? 0.125 : 1} value={position} style={{ '--range-fill': `${percent}%` } as React.CSSProperties} onChange={e => onChange(log ? Math.min(max, Math.round(min * 2 ** Number(e.target.value))) : Number(e.target.value))} /><div className="range-bounds"><span>{int(min)}</span><span>{int(max)}</span></div></div>;
}
