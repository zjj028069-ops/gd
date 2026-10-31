import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { canWriteProducts } from './api';
import type { Product } from './api';
import { Loading, Notice } from './shared';
import type { Bom, BomVersion, Route, RouteStep, RouteVersion, VersionInfo } from './masterTypes';
import { idText } from './masterTypes';
import { EditorShell, useMutation, useRemote } from './masterTools';
import type { VersionFormProps } from './VersionForms';
import { bomSavePayload, validateBomDraft } from './domain/payloads';
import { requestKey } from './requestKey';

type ProductOption = { id: string; code: string; name: string; unit_name: string };
type BomDraft = { key: string; component_product_id: string; quantity: string; loss_rate: string; feeding_process_id: string; auto_issue: boolean; child_mode: 'auto' | 'leaf' | 'version'; child_version_id: string };
const newLine = (): BomDraft => ({ key: requestKey(), component_product_id: '', quantity: '1', loss_rate: '0', feeding_process_id: '', auto_issue: false, child_mode: 'auto', child_version_id: '' });

export function BomEditor({ record, source, session, revision, onExpired, onClose, onSaved }: VersionFormProps) {
  const bom = record as Bom | undefined;
  const original = source as BomVersion | undefined;
  const [parent, setParent] = useState(bom?.parent_product_id ?? '');
  const [description, setDescription] = useState(original?.version.description ?? '');
  const [lines, setLines] = useState<BomDraft[]>(original?.items.map((item) => ({ key: requestKey(), component_product_id: item.component_product_id, quantity: item.quantity, loss_rate: item.loss_rate, feeding_process_id: item.feeding_process_id ?? '', auto_issue: item.auto_issue, child_mode: item.component_bom_version_id ? 'version' : 'leaf', child_version_id: item.component_bom_version_id ?? '' })) ?? [newLine()]);
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const products = useRemote<{ items: Product[]; total: number }>(`/api/products?${new URLSearchParams({ q: query, page: '1', page_size: '100' })}`, revision, onExpired);
  const boms = useRemote<{ items: Bom[]; total: number; limit: number }>('/api/boms', revision, onExpired);
  const routes = useRemote<{ items: Route[]; total: number; limit: number }>('/api/routes', revision, onExpired);
  const [routeId, setRouteId] = useState(original?.version.route_version_id ? '__bound' : '');
  const [routeVersionId, setRouteVersionId] = useState(original?.version.route_version_id ?? '');
  const routeDetail = useRemote<{ route: Route; versions: VersionInfo[] }>(routeId && routeId !== '__bound' ? `/api/routes/${encodeURIComponent(routeId)}` : null, revision, onExpired);
  const routeVersion = useRemote<RouteVersion>(routeVersionId ? `/api/route-versions/${encodeURIComponent(routeVersionId)}` : null, revision, onExpired);
  const [cache, setCache] = useState<Record<string, ProductOption>>(() => {
    const result: Record<string, ProductOption> = {};
    if (bom) result[bom.parent_product_id] = { id: bom.parent_product_id, code: bom.parent_code, name: bom.parent_name, unit_name: '' };
    original?.items.forEach((item) => { result[item.component_product_id] = { id: item.component_product_id, code: item.component_code, name: item.component_name, unit_name: item.unit_name }; });
    return result;
  });
  useEffect(() => {
    if (!products.data) return;
    setCache((current) => { const result = { ...current }; products.data?.items.forEach((item) => { result[idText(item.id)] = { id: idText(item.id), code: item.code, name: item.name, unit_name: item.unit_name ?? '' }; }); return result; });
  }, [products.data]);
  useEffect(() => { if (routeDetail.data) setRouteVersionId(routeDetail.data.route.current_version_id); }, [routeDetail.data]);
  const mutation = useMutation(session, !!bom, onExpired, onSaved);
  const writable = canWriteProducts(session);
  const disabled = !writable || mutation.saving;
  const productRows: ProductOption[] = (products.data?.items ?? []).filter((item) => item.active).map((item) => ({ id: idText(item.id), code: item.code, name: item.name, unit_name: item.unit_name ?? '' }));
  function choices(selectedId: string) { return selectedId && !productRows.some((item) => item.id === selectedId) && cache[selectedId] ? [cache[selectedId], ...productRows] : productRows; }
  function changeRoute(value: string) {
    setRouteId(value); setRouteVersionId(value === '__bound' ? original?.version.route_version_id ?? '' : '');
    setLines((current) => current.map((line) => ({ ...line, feeding_process_id: '', auto_issue: false })));
  }
  function changeRouteVersion(value: string) {
    setRouteVersionId(value);
    setLines((current) => current.map((line) => ({ ...line, feeding_process_id: '', auto_issue: false })));
  }
  function patchLine(key: string, update: Partial<BomDraft>) { setLines((current) => current.map((line) => line.key === key ? { ...line, ...update } : line)); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!writable) return;
    const steps = routeVersion.data?.steps ?? [];
    const invalid = validateBomDraft({ parent, lines, routeVersionId, steps });
    if (invalid) { mutation.setError(invalid); return; }
    void mutation.save(bom ? `/api/boms/${encodeURIComponent(idText(bom.id))}/versions` : '/api/boms', bomSavePayload({ existing: !!bom, parent, description, routeVersionId, lines, expected_version: bom?.version }));
  }
  return <EditorShell title={bom ? 'BOM · 新修订' : '新增产品BOM'} tenant={session.tenant.name} wide onClose={onClose} saving={mutation.saving} error={mutation.error} conflict={mutation.conflict} onSubmit={writable ? submit : undefined} submitLabel={bom ? '保存为新版本' : '创建BOM'} submitDisabled={products.loading || !!products.error || routes.loading || !!routes.error || routeDetail.loading || !!routeDetail.error || routeVersion.loading || !!routeVersion.error || (!!routeId && !routeVersionId)}>
    <Notice kind="info">历史BOM及子版本保持只读。用量与损耗率分别填写：用量1.03就是1.03个单位，不解释为损耗。自动扣料这里只保存配置。</Notice>
    <div className="product-picker-search"><label className="form-field"><span>检索可选产品</span><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="输入编号或名称缩小范围" disabled={disabled} /></label><button type="button" className="button button-secondary" disabled={products.loading || disabled} onClick={() => { setQuery(searchText.trim()); products.reload(); }}>搜索产品</button></div>
    {products.error && <Notice>{products.error}</Notice>}{products.data && <p className="muted small">本次返回 {products.data.items.length} / 匹配 {products.data.total} 个产品{products.data.total > products.data.items.length ? '。最多取100条，请通过编号或名称搜索缩小范围，未返回产品没有被纳入当前选项。' : '。'}</p>}
    <div className="form-grid"><label className="form-field"><span>母件产品 *</span><select required value={parent} disabled={disabled || !!bom || products.loading} onChange={(event) => setParent(event.target.value)}><option value="">请选择母件</option>{choices(parent).map((item) => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label><label className="form-field"><span>版本说明</span><input value={description} onChange={(event) => setDescription(event.target.value)} disabled={disabled} /></label><label className="form-field"><span>投料路线</span><select value={routeId} disabled={disabled || routes.loading} onChange={(event) => changeRoute(event.target.value)}><option value="">不绑定路线</option>{original?.version.route_version_id && <option value="__bound">保持原冻结路线版本</option>}{routes.data?.items.filter((route) => route.active).map((route) => <option value={idText(route.id)} key={route.id}>{route.code} · {route.name}</option>)}</select></label><label className="form-field"><span>冻结路线版本</span><select value={routeVersionId} disabled={disabled || !routeId || routeDetail.loading} onChange={(event) => changeRouteVersion(event.target.value)}><option value="">未绑定</option>{routeId === '__bound' && original?.version.route_version_id && <option value={original.version.route_version_id}>原冻结版本 · {original.version.route_version_id}</option>}{routeDetail.data?.versions.map((version) => <option value={version.id} key={version.id}>R{version.revision} · {version.description || '无说明'}</option>)}</select></label></div>
    <p className="muted small">切换路线或路线版本会清空本表单中的投料工序与自动扣料选择，提交前请重新核对。</p>{routes.error && <Notice>{routes.error}</Notice>}{routeDetail.error && <Notice>{routeDetail.error}</Notice>}{routeVersion.error && <Notice>{routeVersion.error}</Notice>}{boms.error && <Notice>{boms.error}</Notice>}{boms.data && boms.data.total > boms.data.items.length && <Notice kind="info">子BOM本次{boms.data.items.length}条 / 总{boms.data.total}条，上限{boms.data.limit}；自动冻结由服务查找，固定历史版本选项需先核对完整目录。</Notice>}{routes.data && routes.data.total > routes.data.items.length && <Notice kind="info">路线本次{routes.data.items.length}条 / 总{routes.data.total}条，上限{routes.data.limit}，本次选择列表并非全量。</Notice>}
    <section className="subsection"><div className="subsection-heading"><h3>组件用量与展开</h3><button type="button" className="button button-secondary" disabled={disabled} onClick={() => setLines((current) => [...current, newLine()])}>＋ 添加组件</button></div>{products.loading && <Loading label="正在读取产品选项…" />}{lines.map((line, index) => <BomLine key={line.key} line={line} index={index} options={choices(line.component_product_id)} boms={boms.data?.items ?? []} steps={routeVersion.data?.steps ?? []} hasRoute={!!routeVersionId} disabled={disabled} revision={revision} onExpired={onExpired} onChange={(update) => patchLine(line.key, update)} onRemove={() => setLines((current) => current.filter((item) => item.key !== line.key))} />)}</section>
    {bom && <p className="muted small">基于R{original?.version.revision}；档案并发版本 v{bom.version}。保存后产生新的修订。</p>}
  </EditorShell>;
}

function BomLine({ line, index, options, boms, steps, hasRoute, disabled, revision, onExpired, onChange, onRemove }: { line: BomDraft; index: number; options: ProductOption[]; boms: Bom[]; steps: RouteStep[]; hasRoute: boolean; disabled: boolean; revision: number; onExpired: () => void; onChange: (update: Partial<BomDraft>) => void; onRemove: () => void }) {
  const childBom = boms.find((item) => item.parent_product_id === line.component_product_id);
  const childDetail = useRemote<{ bom: Bom; versions: VersionInfo[] }>(line.child_mode === 'version' && childBom ? `/api/boms/${encodeURIComponent(idText(childBom.id))}` : null, revision, onExpired);
  return <div className="bom-line"><div className="subsection-heading"><strong>组件 {index + 1}</strong><button type="button" className="text-button danger-text" disabled={disabled} onClick={onRemove}>移除</button></div><div className="bom-line-grid">
    <label className="form-field"><span>组件产品 *</span><select required value={line.component_product_id} disabled={disabled} onChange={(event) => onChange({ component_product_id: event.target.value, child_mode: 'auto', child_version_id: '' })}><option value="">请选择组件</option>{options.map((item) => <option value={item.id} key={item.id}>{item.code} · {item.name}{item.unit_name ? ` / ${item.unit_name}` : ''}</option>)}</select></label>
    <label className="form-field"><span>单位用量 *</span><input required inputMode="decimal" value={line.quantity} disabled={disabled} onChange={(event) => onChange({ quantity: event.target.value })} /></label><label className="form-field"><span>损耗率（0–1）</span><input required inputMode="decimal" value={line.loss_rate} disabled={disabled} onChange={(event) => onChange({ loss_rate: event.target.value })} /></label>
    <label className="form-field"><span>投料工序</span><select value={line.feeding_process_id} disabled={disabled || !hasRoute} onChange={(event) => onChange({ feeding_process_id: event.target.value, auto_issue: event.target.value ? line.auto_issue : false })}><option value="">未指定</option>{line.feeding_process_id && !steps.some((step) => step.process_id === line.feeding_process_id) && <option value={line.feeding_process_id}>待核对原工序 · {line.feeding_process_id}</option>}{steps.map((step) => <option value={step.process_id} key={step.sequence}>{step.sequence}. {step.process_code} · {step.process_name}</option>)}</select></label>
    <label className="form-field"><span>子件展开策略</span><select value={line.child_mode} disabled={disabled} onChange={(event) => onChange({ child_mode: event.target.value as BomDraft['child_mode'], child_version_id: event.target.value === 'version' ? line.child_version_id : '' })}><option value="auto">自动冻结最新子BOM</option><option value="leaf">作为叶子，不再展开</option><option value="version">固定历史子版本</option></select></label>
    <label className="form-field"><span>历史子BOM版本</span><select value={line.child_version_id} disabled={disabled || line.child_mode !== 'version' || childDetail.loading} onChange={(event) => onChange({ child_version_id: event.target.value })}><option value="">请选择版本</option>{line.child_version_id && !childDetail.data?.versions.some((version) => version.id === line.child_version_id) && <option value={line.child_version_id}>当前冻结版本 · {line.child_version_id}</option>}{childDetail.data?.versions.map((version) => <option value={version.id} key={version.id}>R{version.revision} · {version.description || '无说明'}</option>)}</select></label>
  </div><label className="checkbox-field"><input type="checkbox" checked={line.auto_issue} disabled={disabled || !hasRoute || !line.feeding_process_id} onChange={(event) => onChange({ auto_issue: event.target.checked })} />自动扣料配置（需绑定路线内投料工序）</label>{childDetail.error && <Notice>{childDetail.error}</Notice>}{line.child_mode === 'version' && !childBom && !line.child_version_id && <p className="muted small">本次子BOM目录中未找到该组件，请核对目录，或选择自动冻结/叶子不展开。</p>}</div>;
}
