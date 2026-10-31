import { useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, canWriteProducts, errorMessage, isAbort } from './api';
import type { EntityId } from './api';
import { EmptyState, Loading, Notice, StatusBadge, formatDate } from './shared';
import type { Bom, BomVersion, Explosion, MasterProps, Route, RouteVersion, VersionInfo } from './masterTypes';
import { decimalPattern, idText } from './masterTypes';
import { EditorShell, useRemote } from './masterTools';
import { VersionForm } from './VersionForms';

type Kind = 'routes' | 'boms';
type Row = Route | Bom;
export function VersionedData({ kind, session, revision, onExpired, onChanged }: MasterProps & { kind: Kind }) {
  const resource = useRemote<{ items: Row[]; total: number; limit: number }>(`/api/${kind}`, revision, onExpired);
  const [selected, setSelected] = useState<EntityId | null>(null);
  const [versionId, setVersionId] = useState('');
  const [editor, setEditor] = useState<{ record?: Row; source?: RouteVersion | BomVersion } | null>(null);
  const [saved, setSaved] = useState(false);
  const [filter, setFilter] = useState('');
  const detail = useRemote<{ route?: Route; bom?: Bom; versions: VersionInfo[] }>(selected === null ? null : `/api/${kind}/${encodeURIComponent(idText(selected))}`, revision, onExpired);
  const version = useRemote<RouteVersion | BomVersion>(versionId ? `/api/${kind === 'routes' ? 'route' : 'bom'}-versions/${encodeURIComponent(versionId)}` : null, revision, onExpired);
  const [quantity, setQuantity] = useState('50');
  const [explosion, setExplosion] = useState<Explosion | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewController = useRef<AbortController | null>(null);
  const record = detail.data?.route ?? detail.data?.bom;
  useEffect(() => { if (record) setVersionId(record.current_version_id); }, [record]);
  useEffect(() => { previewController.current?.abort(); setExplosion(null); setPreviewError(''); setPreviewLoading(false); return () => previewController.current?.abort(); }, [versionId]);
  const writable = canWriteProducts(session);
  const rows = resource.data?.items ?? [];
  const title = kind === 'routes' ? '工艺路线' : '产品 BOM';
  const filtered = rows.filter((row) => (kind === 'routes' ? `${(row as Route).code} ${(row as Route).name}` : `${(row as Bom).parent_code} ${(row as Bom).parent_name}`).toLowerCase().includes(filter.toLowerCase()));
  function open(id: EntityId) { setVersionId(''); setSelected(id); }
  function editVersion() { if (!record || !version.data) return; setEditor({ record, source: version.data }); setSelected(null); setVersionId(''); }
  async function preview() {
    if (!decimalPattern.test(quantity) || Number(quantity) <= 0) { setPreviewError('预览数量需为大于0、最多6位小数的数量。'); return; }
    if (selected === null || !versionId) return;
    previewController.current?.abort();
    const controller = new AbortController(); previewController.current = controller;
    setPreviewLoading(true); setPreviewError(''); setExplosion(null);
    const params = new URLSearchParams({ quantity, version_id: versionId });
    try {
      const result = await apiRequest<Explosion>(`/api/boms/${encodeURIComponent(idText(selected))}/explosion?${params}`, { signal: controller.signal });
      if (!controller.signal.aborted) setExplosion(result);
    } catch (failure) { if (!isAbort(failure) && !controller.signal.aborted) { if (failure instanceof ApiError && failure.status === 401) onExpired(); else setPreviewError(errorMessage(failure)); } }
    finally { if (!controller.signal.aborted) setPreviewLoading(false); }
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow">基础档案 / {title}</div><h1>{title}</h1><p>历史版本只读；调整配置时生成新版本，保留旧版本内容。</p></div>{writable ? <button className="button button-primary" onClick={() => { setSaved(false); setEditor({}); }}>＋ 新增{kind === 'routes' ? '路线' : 'BOM'}</button> : <span className="badge badge-gray">当前角色只读</span>}</div>
    {resource.error && <Notice>{resource.error}</Notice>}{saved && <Notice kind="success">配置已保存，新版本和列表已重新读取。</Notice>}{resource.data && resource.data.total > rows.length && <Notice kind="info">本轮最多返回{resource.data.limit}条，本次{rows.length}条 / 总{resource.data.total}条；完整目录分页将在后续阶段补齐，当前列表不能视为全量。</Notice>}
    <section className="panel table-panel"><div className="table-toolbar"><label className="search-form"><span className="sr-only">筛选当前列表</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选本次返回的编号或名称" /></label><div className="toolbar-end"><span className="muted small">本次返回 {rows.length} 条{resource.data ? ` / 总${resource.data.total}条（上限${resource.data.limit}）` : ''}</span><button className="button button-secondary" onClick={resource.reload} disabled={resource.loading}>刷新</button></div></div>{resource.loading ? <Loading /> : !filtered.length ? <EmptyState title={resource.error ? '读取未完成' : '当前没有匹配的档案'} description="创建并成功提交后，真实版本记录将在此显示。" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>{kind === 'routes' ? '路线编号' : '母件编号'}</th><th>{kind === 'routes' ? '路线名称' : '母件名称'}</th><th>{kind === 'routes' ? '工序数' : '组件数'}</th><th>当前修订</th><th>档案版本</th>{kind === 'routes' && <th>状态</th>}<th>操作</th></tr></thead><tbody>{filtered.map((row) => <tr key={row.id}><td className="monospace">{kind === 'routes' ? (row as Route).code : (row as Bom).parent_code}</td><td>{kind === 'routes' ? (row as Route).name : (row as Bom).parent_name}</td><td>{kind === 'routes' ? (row as Route).steps_count : (row as Bom).items_count}</td><td>R{row.current_revision}</td><td>v{row.version}</td>{kind === 'routes' && <td><StatusBadge active={(row as Route).active} /></td>}<td><button className="text-button" onClick={() => open(row.id)}>{kind === 'routes' ? '查看版本' : '版本 / 需求预览'}</button></td></tr>)}</tbody></table></div>}</section>
    {selected !== null && <EditorShell title={title + ' · 历史版本'} tenant={session.tenant.name} wide onClose={() => { setSelected(null); setVersionId(''); }}>
      {detail.error && <Notice>{detail.error}</Notice>}{detail.loading ? <Loading /> : record && <><div className="version-toolbar"><label className="form-field"><span>选择只读版本</span><select value={versionId} onChange={(event) => setVersionId(event.target.value)}>{detail.data?.versions.map((item) => <option value={item.id} key={item.id}>R{item.revision} · {formatDate(item.created_at)}</option>)}</select></label>{writable && <button type="button" className="button button-primary" disabled={version.loading || !version.data} onClick={editVersion}>基于此版本新增修订</button>}</div>{version.error && <Notice>{version.error}</Notice>}{version.loading ? <Loading /> : version.data && <><p className="muted small">说明：{version.data.version.description || '—'}<br />版本标识：{version.data.version.id}</p>{kind === 'routes' ? <div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>顺序</th><th>工序</th><th>自动入库配置</th><th>标准分钟</th><th>授权人数</th></tr></thead><tbody>{(version.data as RouteVersion).steps.map((step) => <tr key={step.sequence}><td>{step.sequence}</td><td>{step.process_code} · {step.process_name}</td><td>{step.auto_inbound ? '开启' : '关闭'}</td><td>{step.standard_minutes}</td><td>{step.reporter_ids.length}</td></tr>)}</tbody></table></div> : <><div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>组件</th><th>单位用量</th><th>损耗率</th><th>投料工序</th><th>自动扣料配置</th><th>冻结子BOM</th></tr></thead><tbody>{(version.data as BomVersion).items.map((item) => <tr key={item.id}><td>{item.component_code} · {item.component_name}<span className="cell-subtitle">{item.unit_name}</span></td><td>{item.quantity}</td><td>{item.loss_rate}</td><td>{item.feeding_process_name || '—'}</td><td>{item.auto_issue ? '开启' : '关闭'}</td><td className="monospace">{item.component_bom_version_id || '未指定'}</td></tr>)}</tbody></table></div><section className="subsection"><h3>BOM需求预览 <span className="badge badge-teal">不落账</span></h3><p className="muted small">按所选冻结版本展开数量，不占用库存，不生成采购或生产订单。</p><div className="preview-toolbar"><label className="form-field"><span>母件数量</span><input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><button type="button" className="button button-primary" disabled={previewLoading} onClick={() => void preview()}>{previewLoading ? '正在预览…' : '计算需求预览'}</button></div>{previewError && <Notice>{previewError}</Notice>}{explosion && <><p className="muted small">本次预览母件数量：{explosion.quantity}；版本：{explosion.version_id}</p>{explosion.warnings.map((warning, index) => <Notice kind="info" key={index}>{warning}</Notice>)}<div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>物料</th><th>需求量</th><th>单位</th><th>展开路径</th></tr></thead><tbody>{explosion.requirements.map((item) => <tr key={item.product_id}><td>{item.code} · {item.name}</td><td className="monospace">{item.quantity}</td><td>{item.unit_name}</td><td>{item.paths.join('；')}</td></tr>)}</tbody></table></div></>}</section></>}</>}</>}
    </EditorShell>}
    {editor && <VersionForm kind={kind} record={editor.record} source={editor.source} session={session} revision={revision} onExpired={onExpired} onChanged={onChanged} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setSaved(true); onChanged(); }} />}
  </>;
}
