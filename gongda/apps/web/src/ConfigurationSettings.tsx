import { useState } from 'react';
import type { FormEvent } from 'react';
import { hasPermission } from './api';
import type { UserRole } from './api';
import { useRemote } from './masterTools';
import { EmptyState, Loading, Notice, StatusBadge, formatDate } from './shared';
import { SettingsTabs, WriteFeedback, useSettingsWrite } from './settingsTools';
import type { SettingsProps } from './settingsTools';
import { ViewSettings } from './ViewSettings';
import { EventSettings } from './EventSettings';
import { requestKey as createRequestKey } from './requestKey';

export type ExtensionField = { key: string; label: string; type: 'text' | 'number' | 'select' | 'date' | 'boolean' | 'formula'; required: boolean; options?: string[]; expression?: string; variables?: { name: string; unit?: string }[]; read_roles?: UserRole[]; write_roles?: UserRole[] };
export type FieldSchema = { id: string; entity: 'product'; active: boolean; version: number; current_version_id: string | null; current_revision: number };
export type FieldVersion = { id: string; schema_id: string; revision: number; state: 'draft' | 'published'; fields: ExtensionField[]; created_at: string; published_at: string | null };
type NumberRule = { id: string; entity: string; prefix: string; date_pattern: string; reset_period: string; padding: number; start: string; active: boolean; version: number };
const entityLabels: Record<string, string> = { unit: '计量单位', product: '产品', process: '工序', route: '工艺路线', bom: 'BOM' };
const dateLabels: Record<string, string> = { none: '无日期', yyyyMMdd: '年月日 YYYYMMDD', yyyyMM: '年月 YYYYMM', yyyy: '年 YYYY' };
const resetLabels: Record<string, string> = { never: '持续递增', day: '每日', month: '每月', year: '每年' };
const fieldTypes: Record<ExtensionField['type'], string> = { text: '文本', number: '数值', select: '单选', date: '日期', boolean: '开关', formula: '计算公式' };
export function ConfigurationSettings(props: SettingsProps) {
  const manageable = hasPermission(props.session, 'configuration.manage');
  const [tab, setTab] = useState(manageable ? 'numbers' : 'views');
  const effectiveTab = manageable ? tab : 'views';
  if (!hasPermission(props.session, 'configuration.read')) return <Notice kind="info">当前账号没有配置读取权限。</Notice>;
  return <><div className="page-heading"><div><div className="eyebrow">平台 / 企业配置</div><h1>字段与界面配置</h1><p>编号、产品扩展表单、公式及列卡配置保存到当前企业。</p></div><span className="badge badge-teal">版本与审计</span></div><SettingsTabs items={[...(manageable ? [{ key: 'numbers', label: '编号规则' }, { key: 'fields', label: '产品扩展表单' }, ...(hasPermission(props.session, 'master.write') ? [{ key: 'formula', label: '公式试算' }] : []), { key: 'events', label: '站内事件' }] : []), { key: 'views', label: '列表与手机卡片' }]} active={effectiveTab} onChange={setTab} />{effectiveTab === 'numbers' && <NumberSettings {...props} />}{effectiveTab === 'fields' && <FieldSettings {...props} />}{effectiveTab === 'views' && <ViewSettings {...props} />}{effectiveTab === 'formula' && <FormulaSettings {...props} />}{effectiveTab === 'events' && <EventSettings {...props} />}</>;
}
function NumberSettings(props: SettingsProps) {
  const remote = useRemote<{ items: NumberRule[] }>('/api/configuration/number-rules', props.revision, props.onExpired);
  const [editing, setEditing] = useState<NumberRule | null>(null);
  const [entity, setEntity] = useState('product'); const [prefix, setPrefix] = useState('PD');
  const [date, setDate] = useState('none'); const [reset, setReset] = useState('never');
  const [padding, setPadding] = useState('5'); const [start, setStart] = useState('1'); const [active, setActive] = useState(true);
  const [allocation, setAllocation] = useState<{ number: string; sequence: string; period: string; rule_version: number; replayed: boolean } | null>(null);
  const [allocationRule, setAllocationRule] = useState('');
  const [requestKey, setRequestKey] = useState(() => createRequestKey());
  const mutation = useSettingsWrite(props);
  function edit(rule: NumberRule | null) { mutation.reset(); setEditing(rule); setEntity(rule?.entity ?? 'product'); setPrefix(rule?.prefix ?? 'PD'); setDate(rule?.date_pattern ?? 'none'); setReset(rule?.reset_period ?? 'never'); setPadding(String(rule?.padding ?? 5)); setStart(String(rule?.start ?? 1)); setActive(rule?.active ?? true); }
  async function submit(event: FormEvent) {
    event.preventDefault(); const values = { prefix: prefix.trim(), date_pattern: date, reset_period: reset, padding: Number(padding), start: Number(start) };
    const result = await mutation.write(editing ? `/api/configuration/number-rules/${editing.id}` : '/api/configuration/number-rules', editing ? { ...values, version: editing.version, active } : { ...values, entity }, editing ? 'PATCH' : 'POST');
    if (result) { edit(null); mutation.setSuccess('编号规则已保存；新规则不会改写历史编号。'); }
  }
  async function allocate() {
    if (!allocationRule) { mutation.setError('请选择编号规则。'); return; }
    const result = await mutation.write<{ allocation: { number: string; sequence: string; period: string; rule_version: number }; replayed: boolean }>(`/api/configuration/number-rules/${allocationRule}/allocate`, { request_key: requestKey });
    if (result) { setAllocation({ ...result.allocation, replayed: result.replayed }); mutation.setSuccess('编号已持久分配；同一请求标识重试返回同一个编号。'); }
  }
  return <><WriteFeedback mutation={mutation} onReload={() => { remote.reload(); setEditing(null); }} />{remote.error && <Notice>{remote.error}</Notice>}<div className="settings-grid"><section className="panel"><div className="panel-heading"><h2>{editing ? '编辑编号规则' : '新增编号规则'}</h2>{editing && <button className="text-button" onClick={() => edit(null)}>改为新增</button>}</div><form onSubmit={submit}><div className="form-grid"><label className="form-field"><span>编号对象</span><select disabled={!!editing} value={entity} onChange={event => setEntity(event.target.value)}>{Object.entries(entityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="form-field"><span>前缀</span><input value={prefix} maxLength={32} onChange={event => setPrefix(event.target.value)} /></label><label className="form-field"><span>日期格式</span><select value={date} onChange={event => setDate(event.target.value)}><option value="none">无日期</option><option value="yyyyMMdd">年月日 YYYYMMDD</option><option value="yyyyMM">年月 YYYYMM</option><option value="yyyy">年 YYYY</option></select></label><label className="form-field"><span>流水重置周期</span><select value={reset} onChange={event => setReset(event.target.value)}><option value="never">持续递增</option><option value="day">每日</option><option value="month">每月</option><option value="year">每年</option></select></label><label className="form-field"><span>流水位数</span><input required type="number" min="1" max="12" step="1" value={padding} onChange={event => setPadding(event.target.value)} /></label><label className="form-field"><span>起始流水</span><input required type="number" min="1" step="1" value={start} onChange={event => setStart(event.target.value)} /></label></div>{editing && <label className="checkbox-field"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />启用规则</label>}<div className="settings-actions"><button className="button button-primary" disabled={mutation.saving || mutation.conflict}>保存编号规则</button></div></form></section><section className="panel"><div className="panel-heading"><h2>分配编号</h2></div><label className="form-field"><span>启用规则</span><select value={allocationRule} onChange={event => { setAllocationRule(event.target.value); setAllocation(null); setRequestKey(createRequestKey()); mutation.reset(); }}><option value="">请选择规则</option>{remote.data?.items.filter(row => row.active).map(row => <option value={row.id} key={row.id}>{entityLabels[row.entity]} · {row.prefix}</option>)}</select></label><p className="muted small">分配会消耗流水，产品表单可以申请编号后使用。分配与产品保存分开；取消表单会留下断号。已分配编号和关联请求标识保留；不会因重试或改规则回收。</p><div className="settings-actions"><button className="button button-primary" disabled={!allocationRule || mutation.saving || mutation.conflict || !hasPermission(props.session, 'master.write')} onClick={() => void allocate()}>分配 / 重试本次编号</button><button className="button button-secondary" disabled={mutation.saving} onClick={() => { setRequestKey(createRequestKey()); setAllocation(null); mutation.reset(); }}>开始下一次分配</button></div>{allocation && <div className="settings-result"><strong className="monospace">{allocation.number}</strong><p>规则v{allocation.rule_version} · 流水{allocation.sequence} · {allocation.replayed ? '返回原分配' : '首次分配'}</p></div>}</section></div><section className="panel table-panel settings-section">{remote.loading ? <Loading /> : !remote.data?.items.length ? <EmptyState title="企业尚未配置编号规则" description="当前主数据仍可手填唯一编号。" /> : <div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>对象</th><th>前缀 / 日期</th><th>周期 / 位数</th><th>状态</th><th>版本</th><th>操作</th></tr></thead><tbody>{remote.data.items.map(row => <tr key={row.id}><td>{entityLabels[row.entity]}</td><td>{row.prefix} / {dateLabels[row.date_pattern] ?? row.date_pattern}</td><td>{resetLabels[row.reset_period] ?? row.reset_period} / {row.padding}</td><td><StatusBadge active={row.active} /></td><td>v{row.version}</td><td><button className="text-button" onClick={() => edit(row)}>编辑</button></td></tr>)}</tbody></table></div>}</section></>;
}
function initialField(): ExtensionField { return { key: '', label: '', type: 'text', required: false, read_roles: ['admin', 'planner', 'worker'], write_roles: ['admin', 'planner'] }; }
function FieldSettings(props: SettingsProps) {
  const list = useRemote<{ items: FieldSchema[] }>('/api/configuration/field-schemas', props.revision, props.onExpired);
  const [schemaId, setSchemaId] = useState('');
  const detail = useRemote<{ schema: FieldSchema; versions: FieldVersion[] }>(schemaId ? `/api/configuration/field-schemas/${schemaId}` : null, props.revision, props.onExpired);
  const [fields, setFields] = useState<ExtensionField[]>([initialField()]);
  const [selectedVersion, setSelectedVersion] = useState('');
  const mutation = useSettingsWrite(props);
  function patch(index: number, value: Partial<ExtensionField>) { setFields(current => current.map((field, i) => i === index ? { ...field, ...value } : field)); }
  function schemaChange(id: string) { setSchemaId(id); setSelectedVersion(''); setFields([initialField()]); mutation.reset(); }
  function versionChange(id: string) { const version = detail.data?.versions.find(row => row.id === id); setSelectedVersion(id); if (version) setFields(structuredClone(version.fields)); mutation.reset(); }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const values = fields.map(field => {
      const base = { key: field.key.trim(), label: field.label.trim(), type: field.type, required: field.required, read_roles: field.read_roles, ...(field.type !== 'formula' ? { write_roles: field.write_roles } : {}) };
      return field.type === 'select' ? { ...base, options: (field.options ?? []).map(option => option.trim()).filter(Boolean) } : field.type === 'formula' ? { ...base, expression: field.expression?.trim() ?? '', variables: fields.filter(row => row.type === 'number').map(row => ({ name: row.key.trim(), unit: '自定义数值' })) } : base;
    });
    const result = await mutation.write<{ schema: FieldSchema; version: FieldVersion }>(schemaId ? `/api/configuration/field-schemas/${schemaId}/versions` : '/api/configuration/field-schemas', schemaId ? { expected_version: detail.data?.schema.version, fields: values } : { entity: 'product', fields: values });
    if (result) { setSchemaId(result.schema.id); setSelectedVersion(result.version.id); mutation.setSuccess(`草稿v${result.version.revision}已保存。发布后才作用于产品表单。`); }
  }
  async function publish() {
    if (!detail.data || !selectedVersion) { mutation.setError('请选择要发布的草稿。'); return; }
    const response = await mutation.write(`/api/configuration/field-schemas/${schemaId}/publish`, { expected_version: detail.data.schema.version, version_id: selectedVersion });
    if (response) mutation.setSuccess('扩展表单已发布；服务端将按此版本校验新保存的产品。');
  }
  async function toggle() {
    if (!detail.data) return;
    const response = await mutation.write(`/api/configuration/field-schemas/${schemaId}`, { version: detail.data.schema.version, active: !detail.data.schema.active }, 'PATCH');
    if (response) mutation.setSuccess('表单启用状态已更新；历史产品扩展值保留。');
  }
  const selected = detail.data?.versions.find(row => row.id === selectedVersion);
  return <><Notice kind="info">本轮真实接入产品：文本、数值、单选、日期、开关与计算公式。多选、附件字段及其他业务对象后续实现。已保存产品保留原字段版本；新版必填不会伪造历史值。</Notice><WriteFeedback mutation={mutation} onReload={() => { list.reload(); detail.reload(); }} />{list.error && <Notice>{list.error}</Notice>}{detail.error && <Notice>{detail.error}</Notice>}<section className="panel settings-section"><div className="form-grid"><label className="form-field"><span>产品表单</span><select value={schemaId} onChange={event => schemaChange(event.target.value)}><option value="">新增产品扩展表单</option>{list.data?.items.map(row => <option key={row.id} value={row.id}>产品表单 · 当前发布v{row.current_revision} · {row.active ? '启用' : '停用'}</option>)}</select></label>{schemaId && <label className="form-field"><span>加载字段版本</span><select value={selectedVersion} onChange={event => versionChange(event.target.value)}><option value="">选择版本后编辑或发布</option>{detail.data?.versions.map(row => <option key={row.id} value={row.id}>v{row.revision} · {row.state === 'published' ? '已发布' : '草稿'}</option>)}</select></label>}</div>{schemaId && <p className="muted small">表单管理版本v{detail.data?.schema.version ?? '…'}。修改字段保存为新草稿，不改写旧版本。</p>}{detail.loading && <Loading label="正在读取字段版本…" />}</section><section className="panel"><form onSubmit={saveDraft}><div className="panel-heading"><h2>字段定义</h2><button type="button" className="button button-secondary" disabled={fields.length >= 30} onClick={() => setFields(current => [...current, initialField()])}>＋ 增加字段</button></div>{fields.map((field, index) => <div className="settings-field-row" key={index}><div className="subsection-heading"><strong>字段 {index + 1}</strong><button type="button" className="text-button danger-text" disabled={fields.length === 1} onClick={() => setFields(current => current.filter((_, i) => i !== index))}>移除此草稿字段</button></div><div className="form-grid"><label className="form-field"><span>字段标识 *</span><input required pattern="[A-Za-z][A-Za-z0-9_]{0,31}" value={field.key} onChange={event => patch(index, { key: event.target.value })} placeholder="例如 package_qty" /><small>字母开头，后续可用数字和下划线。</small></label><label className="form-field"><span>显示名称 *</span><input required value={field.label} onChange={event => patch(index, { label: event.target.value })} /></label><label className="form-field"><span>字段类型</span><select value={field.type} onChange={event => patch(index, { type: event.target.value as ExtensionField['type'] })}>{Object.entries(fieldTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="checkbox-field"><input type="checkbox" checked={field.required} onChange={event => patch(index, { required: event.target.checked })} />{field.type === 'formula' ? '必须产生计算结果' : '必须填写'}</label>{field.type === 'select' && <label className="form-field form-field-wide"><span>可选项（每行一项）</span><textarea required rows={3} value={(field.options ?? []).join('\n')} onChange={event => patch(index, { options: event.target.value.split('\n') })} /></label>}{field.type === 'formula' && <label className="form-field form-field-wide"><span>计算表达式 *</span><input required value={field.expression ?? ''} onChange={event => patch(index, { expression: event.target.value })} placeholder="例如 weight * price" /><small>变量引用同表的数值字段标识，服务端计算；不接受手工填写结果。</small></label>}</div><div className="settings-role-grid"><RoleChecks label="可读取" values={field.read_roles ?? ['admin', 'planner', 'worker']} onChange={value => patch(index, { read_roles: value })} /><RoleChecks label="可填写" values={field.type === 'formula' ? [] : field.write_roles ?? ['admin', 'planner']} disabled={field.type === 'formula'} onChange={value => patch(index, { write_roles: value })} /></div></div>)}<div className="settings-actions"><button className="button button-primary" disabled={mutation.saving || mutation.conflict || (schemaId !== '' && !detail.data)}>保存新草稿</button>{schemaId && <><button type="button" className="button button-secondary" disabled={mutation.saving || mutation.conflict || !selected || selected.state !== 'draft'} onClick={() => void publish()}>发布所选草稿</button><button type="button" className="button button-quiet" disabled={mutation.saving || mutation.conflict || !detail.data} onClick={() => void toggle()}>{detail.data?.schema.active ? '停用表单' : '启用表单'}</button></>}</div></form></section>{selected && <p className="muted small">所选字段v{selected.revision}创建于{formatDate(selected.created_at)}；产品页面应用当前发布版本。</p>}</>;
}
function RoleChecks({ label, values, disabled = false, onChange }: { label: string; values: UserRole[]; disabled?: boolean; onChange: (roles: UserRole[]) => void }) { return <fieldset className="settings-role-checks"><legend>{label}</legend>{(['admin', 'planner', 'worker'] as const).map(role => <label className="checkbox-field" key={role}><input type="checkbox" disabled={disabled} checked={values.includes(role)} onChange={event => onChange(event.target.checked ? [...values, role] : values.filter(value => value !== role))} />{{ admin: '管理员', planner: '计划员', worker: '员工' }[role]}</label>)}</fieldset>; }
function FormulaSettings(props: SettingsProps) {
  const [expression, setExpression] = useState('quantity * rate');
  const [variables, setVariables] = useState([{ name: 'quantity', unit: '件', value: '50' }, { name: 'rate', unit: '元/件', value: '0.5' }]);
  const [result, setResult] = useState<{ engine_version: string; result: string; exact_result: unknown; explanation: unknown } | null>(null);
  const mutation = useSettingsWrite(props);
  async function submit(event: FormEvent) {
    event.preventDefault(); setResult(null);
    const response = await mutation.write<typeof result>('/api/configuration/formula-preview', { expression, variables: variables.map(({ name, unit }) => ({ name: name.trim(), unit })), values: Object.fromEntries(variables.map(row => [row.name.trim(), row.value])) });
    if (response) setResult(response);
  }
  return <section className="panel"><div className="panel-heading"><h2>十进制公式试算</h2><span className="badge badge-amber">不计薪、不落账</span></div><p className="panel-copy">此入口验证表达式与输入结果。正式工资规则快照、审批、结算及重算将在业务阶段实现。</p><WriteFeedback mutation={mutation} onReload={() => { setResult(null); }} /><form onSubmit={submit}><label className="form-field"><span>表达式</span><input required value={expression} onChange={event => { setExpression(event.target.value); setResult(null); }} /></label><div className="subsection"><div className="subsection-heading"><h3>变量与输入</h3><button className="button button-secondary" type="button" disabled={variables.length >= 20} onClick={() => setVariables(current => [...current, { name: '', unit: '', value: '0' }])}>增加变量</button></div>{variables.map((row, index) => <div className="settings-variable" key={index}>{(['name', 'unit', 'value'] as const).map(key => <label className="form-field" key={key}><span>{{ name: '变量标识', unit: '单位说明', value: '十进制文本' }[key]}</span><input required={key !== 'unit'} value={row[key]} onChange={event => { setVariables(current => current.map((item, i) => i === index ? { ...item, [key]: event.target.value } : item)); setResult(null); }} /></label>)}<button type="button" className="text-button danger-text" disabled={variables.length === 1} onClick={() => { setVariables(current => current.filter((_, i) => i !== index)); setResult(null); }}>移除</button></div>)}</div><div className="settings-actions"><button className="button button-primary" disabled={mutation.saving || mutation.conflict}>{mutation.saving ? '正在试算…' : '服务端试算'}</button></div></form>{result && <div className="settings-result"><strong>{result.result}</strong><p>计算引擎 {result.engine_version}</p><details><summary>输入与运算解释</summary><pre>{JSON.stringify({ exact_result: result.exact_result, explanation: result.explanation }, null, 2)}</pre></details></div>}</section>;
}








