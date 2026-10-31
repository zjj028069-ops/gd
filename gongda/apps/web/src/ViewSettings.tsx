import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { hasPermission } from './api';
import { useRemote } from './masterTools';
import { EmptyState, Loading, Notice, formatDate } from './shared';
import { WriteFeedback, useSettingsWrite } from './settingsTools';
import type { SettingsProps } from './settingsTools';
import type { ExtensionField, FieldVersion } from './ConfigurationSettings';

export type ProductView = { id: string; version: number; user_id: string | null; scope: 'personal' | 'tenant'; history_id: string; configuration: { columns: string[]; frozen_count: number; sort: { field: string; direction: 'asc' | 'desc' }[]; card_fields: string[] } };
export type ViewResponse = { personal: ProductView | null; tenant: ProductView | null; effective: ProductView | null };
export const baseColumns: Record<string, string> = { code: '产品编号', name: '产品名称', specification: '规格说明', unit_name: '单位', attribute: '属性', active: '状态', version: '版本' };
export const defaultColumns = ['code', 'name', 'unit_name', 'attribute', 'active', 'version'];
export function ViewSettings(props: SettingsProps) {
  const [device, setDevice] = useState<'pc' | 'mobile'>('pc');
  const [scope, setScope] = useState<'personal' | 'tenant'>('personal');
  const remote = useRemote<ViewResponse>(`/api/configuration/views/product/${device}`, props.revision, props.onExpired);
  const schema = useRemote<{ version: FieldVersion | null }>('/api/configuration/field-schemas/current?entity=product', props.revision, props.onExpired);
  const current = scope === 'personal' ? remote.data?.personal : remote.data?.tenant;
  const [columns, setColumns] = useState<string[]>(defaultColumns);
  const [cards, setCards] = useState<string[]>(['code', 'name', 'unit_name']);
  const [frozen, setFrozen] = useState('0'); const [sortField, setSortField] = useState(''); const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [targets, setTargets] = useState<string[]>([]); const [strategy, setStrategy] = useState('fill_missing');
  const mutation = useSettingsWrite(props);
  const members = useRemote<{ items: { id: string; display_name: string }[] }>(hasPermission(props.session, 'configuration.manage') ? '/api/team-members' : null, props.revision, props.onExpired);
  const history = useRemote<{ items: { id: string; created_at: string; revision?: number; configuration?: unknown }[] }>(current ? `/api/configuration/views/${current.id}/history` : null, props.revision, props.onExpired);
  const options = { ...baseColumns, ...Object.fromEntries((schema.data?.version?.fields ?? []).map((field: ExtensionField) => [`ext:${field.key}`, `${field.label}（扩展）`])) };
  useEffect(() => {
    if (remote.loading) return;
    setColumns(current?.configuration.columns ?? defaultColumns); setCards(current?.configuration.card_fields ?? ['code', 'name', 'unit_name']); setFrozen(String(current?.configuration.frozen_count ?? 0)); setSortField(current?.configuration.sort[0]?.field ?? ''); setSortDirection(current?.configuration.sort[0]?.direction ?? 'asc');
  }, [current, remote.loading]);
  function changeDevice(value: typeof device) { setDevice(value); mutation.reset(); setTargets([]); }
  function changeScope(value: typeof scope) { setScope(value); mutation.reset(); setTargets([]); }
  function toggle(values: string[], key: string, checked: boolean) { return checked ? [...values, key] : values.filter(value => value !== key); }
  function move(index: number, delta: number) { setColumns(prior => { const next = [...prior]; const dest = index + delta; if (dest < 0 || dest >= next.length) return prior; [next[index], next[dest]] = [next[dest], next[index]]; return next; }); }
  async function save(event: FormEvent) {
    event.preventDefault();
    const response = await mutation.write(`/api/configuration/views/product/${device}`, { scope, expected_version: current?.version ?? 0, columns, card_fields: cards, frozen_count: Number(frozen), sort: sortField ? [{ field: sortField, direction: sortDirection }] : [] }, 'PUT');
    if (response) mutation.setSuccess('列与卡片配置已保存，将应用到产品页面。');
  }
  async function apply() {
    if (!current || !targets.length) { mutation.setError('请先保存视图，并选择要应用的有效成员。'); return; }
    const response = await mutation.write<{ applied: string[]; skipped: string[] }>('/api/configuration/views/apply', { view_id: current.id, target_user_ids: targets, strategy });
    if (response) mutation.setSuccess(`已应用${response.applied.length}人；保留已有配置${response.skipped.length}人。`);
  }
  async function restore(id: string) {
    if (!current) return;
    const response = await mutation.write(`/api/configuration/views/${current.id}/restore`, { expected_version: current.version, history_id: id });
    if (response) mutation.setSuccess('历史配置已恢复为新的视图版本。');
  }
  return <><Notice kind="info">个人配置优先于企业默认。列隐藏不改变数据权限，产品API和配置API仍按字段授权过滤。手机卡片在产品页面窄屏使用。</Notice><WriteFeedback mutation={mutation} onReload={() => { remote.reload(); history.reload(); }} />{remote.error && <Notice>{remote.error}</Notice>}{schema.error && <Notice>{schema.error}</Notice>}<section className="panel"><div className="form-grid"><label className="form-field"><span>显示设备</span><select value={device} onChange={event => changeDevice(event.target.value as typeof device)}><option value="pc">PC列表</option><option value="mobile">手机卡片</option></select></label><label className="form-field"><span>保存范围</span><select value={scope} onChange={event => changeScope(event.target.value as typeof scope)}><option value="personal">当前账号</option>{hasPermission(props.session, 'configuration.manage') && <option value="tenant">企业默认</option>}</select></label></div>{remote.loading ? <Loading /> : <form onSubmit={save}><div className="settings-grid settings-section"><div><h3>列表显示列</h3><div className="settings-column-list">{Object.entries(options).map(([key, label]) => <label className="checkbox-field" key={key}><input type="checkbox" checked={columns.includes(key)} onChange={event => setColumns(toggle(columns, key, event.target.checked))} />{label}</label>)}</div><h3>已选列顺序</h3>{columns.map((key, index) => <div className="settings-ordered-row" key={key}><span>{options[key] ?? key}</span><button type="button" className="text-button" disabled={index === 0} onClick={() => move(index, -1)}>上移</button><button type="button" className="text-button" disabled={index === columns.length - 1} onClick={() => move(index, 1)}>下移</button></div>)}</div><div><h3>手机卡片字段</h3><p className="muted small">最多15个字段，按勾选顺序展示。</p><div className="settings-column-list">{Object.entries(options).map(([key, label]) => <label className="checkbox-field" key={key}><input type="checkbox" checked={cards.includes(key)} disabled={!cards.includes(key) && cards.length >= 15} onChange={event => setCards(toggle(cards, key, event.target.checked))} />{label}</label>)}</div><div className="form-grid settings-section"><label className="form-field"><span>冻结前几列</span><input type="number" min="0" max={Math.min(5, columns.length)} step="1" value={frozen} onChange={event => setFrozen(event.target.value)} /></label><label className="form-field"><span>本页排序字段</span><select value={sortField} onChange={event => setSortField(event.target.value)}><option value="">默认顺序</option>{Object.entries(options).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label className="form-field"><span>排序方向</span><select value={sortDirection} onChange={event => setSortDirection(event.target.value as typeof sortDirection)}><option value="asc">升序</option><option value="desc">降序</option></select></label></div></div></div><p className="muted small">配置版本v{current?.version ?? 0}。本轮排序应用于本次产品页返回的记录，完整查询排序在后续完善。</p><div className="settings-actions"><button className="button button-primary" disabled={mutation.saving || mutation.conflict || columns.length === 0 || cards.length === 0}>保存显示配置</button></div></form>}</section>{current && hasPermission(props.session, 'configuration.manage') && <section className="panel settings-section"><div className="panel-heading"><h2>应用到指定成员</h2></div>{members.error && <Notice>{members.error}</Notice>}<div className="member-grid">{members.data?.items.map(member => <label className="checkbox-field" key={member.id}><input type="checkbox" checked={targets.includes(member.id)} onChange={event => setTargets(event.target.checked ? [...targets, member.id] : targets.filter(id => id !== member.id))} />{member.display_name}</label>)}</div><label className="form-field settings-section"><span>覆盖策略</span><select value={strategy} onChange={event => setStrategy(event.target.value)}><option value="fill_missing">仅补充无个人配置的成员</option><option value="replace">替换所选成员配置（保留历史）</option></select></label><div className="settings-actions"><button className="button button-secondary" disabled={!targets.length || mutation.saving || mutation.conflict} onClick={() => void apply()}>应用到所选成员</button></div></section>}{current && <section className="panel settings-section"><div className="panel-heading"><h2>配置历史与恢复</h2></div>{history.error && <Notice>{history.error}</Notice>}{history.loading ? <Loading /> : !history.data?.items.length ? <EmptyState title="暂无历史配置" description="配置保存后在这里查询可恢复记录。" /> : <div className="settings-history">{history.data.items.map(row => <div key={row.id}><span>{formatDate(row.created_at)}{row.revision !== undefined ? ` · v${row.revision}` : ''}</span><button className="text-button" disabled={mutation.saving || mutation.conflict} onClick={() => void restore(row.id)}>恢复此配置</button></div>)}</div>}</section>}</>;
}



