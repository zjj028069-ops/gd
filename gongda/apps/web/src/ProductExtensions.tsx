import { useEffect, useState } from 'react';
import type { Product, Session } from './api';
import { useRemote } from './masterTools';
import { Loading, Notice } from './shared';
import type { ExtensionField, FieldVersion } from './ConfigurationSettings';

export type ExtensionDraft = { schema_version_id: string; values: Record<string, unknown> } | null;
export function ProductExtensions({ product, session, writable, saving, onExpired, onDraft, onLoading }: { product?: Product; session: Session; writable: boolean; saving: boolean; onExpired: () => void; onDraft: (draft: ExtensionDraft) => void; onLoading: (loading: boolean) => void }) {
  const current = useRemote<{ version: FieldVersion | null }>('/api/configuration/field-schemas/current?entity=product', 0, onExpired);
  const oldId = product?.extension?.schema_version_id;
  const historical = useRemote<{ version: FieldVersion }>(oldId && (!writable || oldId !== current.data?.version?.id) ? `/api/configuration/field-versions/${oldId}` : null, 0, onExpired);
  const version = writable ? current.data?.version : historical.data?.version ?? current.data?.version;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const loading = current.loading || (!!oldId && historical.loading);
  function draftValues(input: Record<string, unknown>) {
    return Object.fromEntries((version?.fields ?? []).filter(field => field.type !== 'formula' && (field.write_roles ?? ['admin', 'planner']).includes(session.role) && (input[field.key] !== '' || field.required)).map(field => [field.key, input[field.key]]));
  }
  useEffect(() => { onLoading(loading || !!current.error || !!historical.error); }, [loading, current.error, historical.error, onLoading]);
  useEffect(() => {
    if (loading || current.error || historical.error) return;
    const initial = Object.fromEntries((version?.fields ?? []).filter(field => field.type !== 'formula').map(field => [field.key, product?.extension?.values[field.key] ?? (field.type === 'boolean' ? false : '')]));
    setValues(initial); onDraft(version ? { schema_version_id: version.id, values: draftValues(initial) } : null);
  }, [version?.id, loading, current.error, historical.error, product?.id, onDraft]);
  function change(key: string, value: unknown) {
    const next = { ...values, [key]: value }; setValues(next);
    if (version) onDraft({ schema_version_id: version.id, values: draftValues(next) });
  }
  if (loading) return <div className="subsection"><Loading label="正在读取产品扩展表单…" /></div>;
  if (current.error || historical.error) return <div className="subsection"><Notice>扩展表单读取未完成：{current.error || historical.error}。请关闭并重读，以免遗漏已发布的必填字段。</Notice></div>;
  if (!version) return null;
  return <div className="subsection"><h3>产品扩展信息 <span className="muted">字段v{version.revision}</span></h3>{writable && oldId && oldId !== version.id && <Notice kind="info">此产品原字段v{historical.data?.version.revision ?? '历史版'}，本次保存将按已发布v{version.revision}校验。旧值不会被自动伪造。</Notice>}<div className="form-grid">{version.fields.map(field => {
    const allowed = writable && field.type !== 'formula' && (field.write_roles ?? ['admin', 'planner']).includes(session.role);
    const value = field.type === 'formula' ? product?.extension?.values[field.key] : values[field.key];
    return <ExtensionInput key={field.key} field={field} value={value} disabled={!allowed || saving} onChange={value => change(field.key, value)} />;
  })}</div><p className="muted small">数值以十进制文本保存；计算字段由服务端生成。未授权字段不会由产品接口返回。</p></div>;
}
function ExtensionInput({ field, value, disabled, onChange }: { field: ExtensionField; value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  if (field.type === 'boolean') return <label className="checkbox-field"><input type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)} />{field.label}{field.required && <i> *</i>}</label>;
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return <label className="form-field"><span>{field.label}{field.required && field.type !== 'formula' ? ' *' : ''}</span>{field.type === 'select' ? <select required={field.required && !disabled} disabled={disabled} value={text} onChange={event => onChange(event.target.value)}><option value="">请选择</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select> : field.type === 'text' ? <input maxLength={2000} required={field.required && !disabled} value={text} disabled={disabled} onChange={event => onChange(event.target.value)} /> : <input type={field.type === 'date' ? 'date' : 'text'} inputMode={field.type === 'number' ? 'decimal' : undefined} required={field.required && !disabled} value={text} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder={field.type === 'formula' ? '保存后由服务端计算' : undefined} />}{field.type === 'formula' && <small>表达式：{field.expression}；编辑后保存会生成新结果。</small>}</label>;
}


