import { useEffect, useState } from 'react';
import { ApiError, apiRequest, errorMessage } from './api';
import { Loading, Notice } from './shared';
import type { MasterProps } from './masterTypes';
import { useRemote } from './masterTools';

type Fact = { key: string; label: string; type: 'boolean' | 'decimal' | 'integer' | 'enum'; default: unknown; options?: string[] };
type Definition = { domain: string; label: string; initial_state: string; states: { value: string; label: string }[]; actions: { value: string; label: string; from: string[]; to: string; roles: string[] }[]; facts: Fact[]; provisional: true };
type Result = { allowed: boolean; next_state: string; effects: string[]; errors: { code: string; message: string }[]; posted: false; provisional: true };

export function DesignPreview({ mode, session, revision, onExpired }: MasterProps & { mode: 'business' | 'mobile' }) {
  const resource = useRemote<{ definitions: Definition[]; posted: false }>('/api/design-preview/definitions', revision, onExpired);
  const [domain, setDomain] = useState(mode === 'mobile' ? 'report' : 'sales');
  const [state, setState] = useState('');
  const [action, setAction] = useState('');
  const [facts, setFacts] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const definitions = resource.data?.definitions.filter((item) => mode !== 'mobile' || item.domain === 'report') ?? [];
  const definition = definitions.find((item) => item.domain === domain);
  useEffect(() => {
    if (!definition) return;
    setState(definition.initial_state);
    setAction(definition.actions.find((item) => item.from.includes(definition.initial_state))?.value ?? definition.actions[0]?.value ?? '');
    setFacts(Object.fromEntries(definition.facts.map((fact) => [fact.key, fact.default])));
    setResult(null); setError('');
  }, [definition]);
  function changeState(value: string) {
    setState(value); setResult(null);
    const next = definition?.actions.find((item) => item.from.includes(value));
    if (next) setAction(next.value);
  }
  async function inspect() {
    if (!definition || busy) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const values = Object.fromEntries(definition.facts.map((fact) => {
        const value = facts[fact.key];
        if (fact.type === 'integer') {
          if (!/^-?\d+$/.test(String(value))) throw new Error(`${fact.label}应为整数。`);
          const number = Number(value);
          if (!Number.isSafeInteger(number)) throw new Error(`${fact.label}超出安全整数范围。`);
          return [fact.key, number];
        }
        return [fact.key, fact.type === 'boolean' ? Boolean(value) : String(value ?? '')];
      }));
      const response = await apiRequest<Result>('/api/design-preview/transition', { method: 'POST', csrfToken: session.csrf_token, body: { domain, state, action, facts: values } });
      if (response.posted !== false || response.provisional !== true) throw new Error('返回结果缺少预检标记，未将其作为预检结果展示。');
      setResult(response);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(errorMessage(failure));
    } finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow">设计验证 / 暂定规则</div><h1>{mode === 'mobile' ? '手机报工原型 · 预检' : '业务流程原型 · 预检'}</h1><p>校验模型中的条件与状态，不形成销售、工单、报工或库存记录。</p></div><span className="badge badge-amber">原型 · 不落账</span></div>
    <Notice kind="info">本页是暂定业务规则的预检工具。预检通过仅表示模型允许该动作，真实订单、报工、审批、库存台账和手机扫码仍未开放。</Notice>
    {resource.error && <Notice>{resource.error}</Notice>}{resource.loading ? <Loading label="正在读取真实预检定义…" /> : <div className={`preview-layout ${mode === 'mobile' ? 'preview-mobile' : ''}`}>
      <section className={`panel ${mode === 'mobile' ? 'phone-prototype' : ''}`}><div className="panel-heading"><h2>{mode === 'mobile' ? '报工字段预检' : '选择模型与条件'}</h2><span className="badge badge-teal">暂定规则</span></div><div className="form-grid"><label className="form-field"><span>模型</span><select value={domain} disabled={busy || mode === 'mobile'} onChange={(event) => setDomain(event.target.value)}>{definitions.map((item) => <option value={item.domain} key={item.domain}>{item.label}</option>)}</select></label><label className="form-field"><span>当前模型状态</span><select value={state} disabled={busy} onChange={(event) => changeState(event.target.value)}>{definition?.states.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><label className="form-field form-field-wide"><span>待预检动作</span><select value={action} disabled={busy} onChange={(event) => { setAction(event.target.value); setResult(null); }}>{definition?.actions.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label></div>
        <section className="subsection"><h3>事实条件</h3><div className="form-grid">{definition?.facts.map((fact) => <label className={`form-field ${fact.type === 'boolean' ? 'boolean-fact' : ''}`} key={fact.key}><span>{fact.label}</span>{fact.type === 'boolean' ? <span className="checkbox-field"><input type="checkbox" checked={Boolean(facts[fact.key])} disabled={busy} onChange={(event) => { setFacts((current) => ({ ...current, [fact.key]: event.target.checked })); setResult(null); }} />是</span> : fact.type === 'enum' ? <select value={String(facts[fact.key] ?? '')} disabled={busy} onChange={(event) => { setFacts((current) => ({ ...current, [fact.key]: event.target.value })); setResult(null); }}>{fact.options?.map((value) => <option value={value} key={value}>{value}</option>)}</select> : <input inputMode={fact.type === 'integer' ? 'numeric' : 'decimal'} value={String(facts[fact.key] ?? '')} disabled={busy} onChange={(event) => { setFacts((current) => ({ ...current, [fact.key]: event.target.value })); setResult(null); }} />}</label>)}</div></section>
        {mode === 'mobile' && <p className="muted small">可输入良品0、不良10检查全不良场景；本页不要求良品数必须大于0，是否允许由服务预检规则判断。</p>}
        <button className="button button-primary preview-submit" disabled={busy || !definition || !state || !action} onClick={() => void inspect()}>{busy ? '正在预检…' : '执行预检（不落账）'}</button>
      </section>
      <section className="panel"><div className="panel-heading"><h2>预检结果</h2><span className="badge badge-gray">未生成业务记录</span></div>{error && <Notice>{error}</Notice>}{!result ? <p className="muted small">选择事实条件并执行预检后，在此查看服务返回的允许/拒绝结果。</p> : <><Notice kind={result.allowed ? 'info' : 'error'}>{result.allowed ? '模型允许此动作；这是预检通过，没有实际提交业务。' : '模型拒绝此动作；没有实际提交业务。'}</Notice><dl className="detail-list"><div><dt>预检下一状态</dt><dd>{definition?.states.find((item) => item.value === result.next_state)?.label ?? result.next_state}</dd></div><div><dt>是否落账</dt><dd>{String(result.posted)}</dd></div><div><dt>规则性质</dt><dd>暂定原型规则</dd></div></dl>{result.errors.length > 0 && <section className="subsection"><h3>拒绝原因</h3>{result.errors.map((item, index) => <p className="muted small" key={`${item.code}-${index}`}>{item.code} · {item.message}</p>)}</section>}<section className="subsection"><h3>拟产生的效果（未执行）</h3>{result.effects.length ? result.effects.map((effect, index) => <p className="muted small" key={index}>{effect}</p>) : <p className="muted small">未返回拟执行效果。</p>}</section>{result.allowed && <button className="button button-secondary" onClick={() => changeState(result.next_state)}>仅采用模型状态继续预检</button>}</>}
      </section>
    </div>}
  </>;
}