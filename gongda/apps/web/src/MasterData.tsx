import { useState } from 'react';
import type { FormEvent } from 'react';
import { canWriteProducts } from './api';
import { EmptyState, Loading, Notice, StatusBadge } from './shared';
import type { MasterPage, MasterProps, MasterUnit, Process, TeamMember } from './masterTypes';
import { decimalPattern, idText } from './masterTypes';
import { processFields } from './domain/payloads';
import { EditorShell, useMutation, useRemote } from './masterTools';
import { VersionedData } from './VersionedData';

type SimpleKind = 'units' | 'processes';
type SimpleRow = MasterUnit | Process;
export function MasterData({ kind, ...props }: MasterProps & { kind: MasterPage }) {
  return kind === 'routes' || kind === 'boms' ? <VersionedData key={kind} kind={kind} {...props} /> : <SimpleData key={kind} kind={kind} {...props} />;
}

function SimpleData({ kind, session, revision, onExpired, onChanged }: MasterProps & { kind: SimpleKind }) {
  const resource = useRemote<{ items: SimpleRow[]; total?: number; limit?: number }>(`/api/${kind}`, revision, onExpired);
  const members = useRemote<{ items: TeamMember[] }>(kind === 'processes' ? '/api/team-members' : null, revision, onExpired);
  const [editor, setEditor] = useState<{ row?: SimpleRow } | null>(null);
  const [saved, setSaved] = useState(false);
  const [filter, setFilter] = useState('');
  const title = kind === 'units' ? '计量单位' : '生产工序';
  const rows = resource.data?.items ?? [];
  const total = resource.data?.total; const limit = resource.data?.limit ?? 200;
  const filtered = rows.filter((row) => `${row.code} ${row.name}`.toLowerCase().includes(filter.toLowerCase()));
  const writable = canWriteProducts(session);
  const memberName = (id: string) => members.data?.items.find((member) => idText(member.id) === id)?.display_name ?? id;
  return <>
    <div className="page-heading"><div><div className="eyebrow">基础档案 / {title}</div><h1>{title}</h1><p>{kind === 'units' ? '维护企业的计量单位；产品引用单位后保留关联。' : '配置工序标准分钟数与明确的报工人员名单。'}</p></div>{writable ? <button className="button button-primary" onClick={() => { setSaved(false); setEditor({}); }}>＋ 新增{kind === 'units' ? '单位' : '工序'}</button> : <span className="badge badge-gray">当前角色只读</span>}</div>
    {resource.error && <Notice>{resource.error}</Notice>}{saved && <Notice kind="success">档案已保存，列表已重新读取。</Notice>}
    {((total !== undefined && total > rows.length) || (total === undefined && rows.length >= limit)) && <Notice kind="info">本轮最多返回{limit}条，本次{rows.length}条{total !== undefined ? ` / 总${total}条` : ''}；完整目录分页将在后续阶段补齐，当前列表不能视为全量。</Notice>}
    <section className="panel table-panel"><div className="table-toolbar"><label className="search-form"><span className="sr-only">筛选当前列表</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选本次返回的编号或名称" /></label><div className="toolbar-end"><span className="muted small">本次返回 {rows.length} 条{total !== undefined ? ` / 总${total}条（上限${limit}）` : ''}</span><button className="button button-secondary" onClick={resource.reload} disabled={resource.loading}>刷新</button></div></div>
      {resource.loading ? <Loading /> : !filtered.length ? <EmptyState title={resource.error ? '读取未完成' : '当前没有匹配的档案'} description="页面只显示本企业真实记录；可刷新或调整筛选。" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>编号</th><th>名称</th>{kind === 'processes' && <><th>标准分钟</th><th>报工人员</th></>}<th>状态</th><th>版本</th><th>操作</th></tr></thead><tbody>{filtered.map((row) => <tr key={row.id}><td className="monospace">{row.code}</td><td><strong>{row.name}</strong>{kind === 'processes' && <span className="cell-subtitle">{(row as Process).description || '—'}</span>}</td>{kind === 'processes' && <><td>{(row as Process).standard_minutes}</td><td>{(row as Process).reporter_ids.map(memberName).join('、') || '未配置'}</td></>}<td><StatusBadge active={row.active} /></td><td>v{row.version}</td><td><button className="text-button" onClick={() => setEditor({ row })}>{writable ? '编辑' : '查看'}</button></td></tr>)}</tbody></table></div>}
    </section>
    {editor && <SimpleEditor kind={kind} row={editor.row} members={members.data?.items ?? []} membersLoading={members.loading} membersError={members.error} session={session} revision={revision} onExpired={onExpired} onChanged={onChanged} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setSaved(true); onChanged(); }} />}
  </>;
}

function SimpleEditor({ kind, row, members, membersLoading, membersError, session, onExpired, onClose, onSaved }: MasterProps & { kind: SimpleKind; row?: SimpleRow; members: TeamMember[]; membersLoading: boolean; membersError: string; onClose: () => void; onSaved: () => void }) {
  const process = kind === 'processes' ? row as Process | undefined : undefined;
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [description, setDescription] = useState(process?.description ?? '');
  const [minutes, setMinutes] = useState(process?.standard_minutes ?? '0');
  const [reporters, setReporters] = useState<string[]>(process?.reporter_ids ?? []);
  const [active, setActive] = useState(row?.active ?? true);
  const mutation = useMutation(session, !!row, onExpired, onSaved);
  const writable = canWriteProducts(session);
  const disabled = !writable || mutation.saving;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || (!row && !code.trim())) { mutation.setError('请填写编号与名称。'); return; }
    if (kind === 'processes' && (!decimalPattern.test(minutes) || !reporters.length)) { mutation.setError('标准分钟需为最多6位小数的非负数，并至少选择一名报工人员。'); return; }
    const fields = kind === 'units' ? { name: name.trim() } : processFields(name, description, minutes, reporters);
    void mutation.save(row ? `/api/${kind}/${encodeURIComponent(idText(row.id))}` : `/api/${kind}`, row ? { ...fields, version: row.version, active } : { ...fields, code: code.trim() }, row ? 'PATCH' : 'POST');
  }
  return <EditorShell title={`${row ? writable ? '编辑' : '查看' : '新增'}${kind === 'units' ? '单位' : '工序'}`} tenant={session.tenant.name} onClose={onClose} saving={mutation.saving} error={mutation.error} conflict={mutation.conflict} onSubmit={writable ? submit : undefined} submitDisabled={kind === 'processes' && (membersLoading || !!membersError)}>
    <div className="form-grid"><label className="form-field"><span>编号 *</span><input required value={code} onChange={(event) => setCode(event.target.value)} disabled={disabled || !!row} /></label><label className="form-field"><span>名称 *</span><input required value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} /></label>{kind === 'processes' && <><label className="form-field"><span>标准分钟 *</span><input required inputMode="decimal" value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={disabled} /><small>0表示尚未设置标准时长；最多6位小数。</small></label><label className="form-field"><span>说明</span><input value={description} onChange={(event) => setDescription(event.target.value)} disabled={disabled} /></label></>}</div>
    {kind === 'processes' && <div className="subsection"><h3>报工人员 * <span className="muted">已选 {reporters.length} 人</span></h3>{membersError && <Notice>{membersError}</Notice>}{membersLoading ? <Loading label="正在读取企业人员…" /> : <div className="member-grid">{members.map((member) => <label className="checkbox-field" key={member.id}><input type="checkbox" checked={reporters.includes(idText(member.id))} disabled={disabled} onChange={(event) => setReporters((current) => event.target.checked ? [...current, idText(member.id)] : current.filter((id) => id !== idText(member.id)))} /><span>{member.display_name}</span></label>)}</div>}<p className="muted small">必须明确授权至少一人；后续报工将在此名单基础上校验。</p></div>}
    {row && <><label className="checkbox-field"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={disabled} />启用档案</label><p className="muted small">当前版本 v{row.version}；保存会校验版本，避免覆盖他人修改。</p></>}
  </EditorShell>;
}
