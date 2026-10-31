import { useEffect, useMemo, useRef, useState } from 'react';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { ApiError, apiRequest, errorMessage } from './api';
import type { Product } from './api';
import type { Bom, BomVersion, Explosion, MasterProps, Process, Route, RouteVersion, TeamMember, VersionInfo } from './masterTypes';
import { useRemote } from './masterTools';
import { Loading, Notice } from './shared';
import { exactQuantity, moneyText, previewMoney, quantityText, requirePreview } from './previewMath';
import type { PreviewResult } from './previewMath';

const steps = ['销售单', '生产工单', '用料清单', '生产报工', '成品入库', '分批发货'];
type List<T> = { items: T[]; total?: number; limit?: number };
type Sales = { product: Product; customer: string; quantity: string; price: string; due: string; amount: string };
type WorkOrder = { quantity: string; route: Route; routeVersion: RouteVersion; bom: Bom; bomVersion: BomVersion; state: string };
type Report = { id: number; sequence: number; processName: string; memberName: string; good: string; bad: string; start: string; end: string; note: string; state: string };
type Shipment = { id: number; quantity: string; amount: string };

export function BusinessDocuments({ session, revision, onExpired }: MasterProps) {
  const products = useRemote<List<Product>>('/api/products?page_size=100', revision, onExpired);
  const routes = useRemote<List<Route>>('/api/routes', revision, onExpired);
  const boms = useRemote<List<Bom>>('/api/boms', revision, onExpired);
  const processes = useRemote<List<Process>>('/api/processes', revision, onExpired);
  const members = useRemote<List<TeamMember>>('/api/team-members', revision, onExpired);
  const [stage, setStage] = useState(0);
  const [productId, setProductId] = useState('');
  const [customer, setCustomer] = useState('S2 本地验收客户');
  const [orderQty, setOrderQty] = useState('50');
  const [price, setPrice] = useState('40');
  const [due, setDue] = useState('2026-10-20');
  const [sale, setSale] = useState<Sales | null>(null);
  const [planQty, setPlanQty] = useState('50');
  const [routeId, setRouteId] = useState('');
  const [routeVersionId, setRouteVersionId] = useState('');
  const [bomId, setBomId] = useState('');
  const [bomVersionId, setBomVersionId] = useState('');
  const [work, setWork] = useState<WorkOrder | null>(null);
  const [explosion, setExplosion] = useState<Explosion | null>(null);
  const [materialsReady, setMaterialsReady] = useState(false);
  const [reportSequence, setReportSequence] = useState('');
  const [reporterId, setReporterId] = useState('');
  const [good, setGood] = useState('50');
  const [bad, setBad] = useState('0');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [reports, setReports] = useState<Report[]>([]);
  const [qualityPassed, setQualityPassed] = useState(false);
  const [inboundQty, setInboundQty] = useState('50');
  const [received, setReceived] = useState('0');
  const [shipQty, setShipQty] = useState('20');
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [closed, setClosed] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const activeProducts = products.data?.items.filter(p => p.active && p.attribute === 'manufactured') ?? [];
  const selectedProduct = activeProducts.find(p => String(p.id) === productId);
  const availableBoms = boms.data?.items.filter(b => b.parent_product_id === productId) ?? [];
  const activeRoutes = routes.data?.items.filter(r => r.active) ?? [];
  const selectedRoute = activeRoutes.find(r => String(r.id) === routeId);
  const selectedBom = availableBoms.find(b => String(b.id) === bomId);
  const routeDetail = useRemote<{ route: Route; versions: VersionInfo[] }>(routeId ? `/api/routes/${routeId}` : null, revision, onExpired);
  const bomDetail = useRemote<{ bom: Bom; versions: VersionInfo[] }>(bomId ? `/api/boms/${bomId}` : null, revision, onExpired);
  const routeVersion = useRemote<RouteVersion>(routeVersionId ? `/api/route-versions/${routeVersionId}` : null, revision, onExpired);
  const bomVersion = useRemote<BomVersion>(bomVersionId ? `/api/bom-versions/${bomVersionId}` : null, revision, onExpired);
  const allErrors = [products.error, routes.error, boms.error, processes.error, members.error, routeDetail.error, bomDetail.error, routeVersion.error, bomVersion.error].filter(Boolean);
  const initialLoading = products.loading || routes.loading || boms.loading || processes.loading || members.loading;

  useEffect(() => {
    if (!productId && activeProducts.length) setProductId(String((activeProducts.find(p => p.code === 'S2-FG') ?? activeProducts[0]).id));
  }, [products.data, productId]);
  useEffect(() => {
    if (!routeId && activeRoutes.length) setRouteId(String((activeRoutes.find(r => r.code === 'S2-ROUTE') ?? activeRoutes[0]).id));
  }, [routes.data, routeId]);
  useEffect(() => {
    if (!bomId && availableBoms.length) setBomId(String(availableBoms[0].id));
  }, [boms.data, productId, bomId]);
  useEffect(() => { setRouteVersionId(selectedRoute?.current_version_id ?? ''); }, [routeId, selectedRoute?.current_version_id]);
  useEffect(() => { setBomVersionId(selectedBom?.current_version_id ?? ''); }, [bomId, selectedBom?.current_version_id]);

  const selectedStep = work?.routeVersion.steps.find(s => String(s.sequence) === reportSequence);
  const currentProcess = processes.data?.items.find(p => String(p.id) === selectedStep?.process_id && p.active);
  const permittedMembers = members.data?.items.filter(m => currentProcess?.reporter_ids.includes(String(m.id))) ?? [];
  const finalStep = work?.routeVersion.steps.at(-1);
  const approvedGood = (sequence: number) => reports.filter(r => r.sequence === sequence && r.state === 'approved').reduce((sum, r) => sum + exactQuantity(r.good), 0n);
  const finalGood = finalStep ? approvedGood(finalStep.sequence) : 0n;
  const shipped = shipments.reduce((sum, row) => sum + exactQuantity(row.quantity), 0n);
  const shippedAmount = shipments.reduce((sum, row) => sum + BigInt(row.amount.replace('.', '')), 0n);
  const simulatedStock = exactQuantity(received) - shipped;
  const orderRemaining = (sale ? exactQuantity(sale.quantity) : 0n) - shipped;
  const allStepsApproved = !!work && work.routeVersion.steps.every(s => reports.some(r => r.sequence === s.sequence && r.state === 'approved'));
  const pendingReports = reports.some(r => r.state === 'pending');
  const orderAmount = useMemo(() => {
    try { return moneyText(previewMoney(exactQuantity(orderQty, '订单数量'), exactQuantity(price, '单价'))); }
    catch { return '—'; }
  }, [orderQty, price]);

  function clearResult() { setResult(null); setError(''); }
  function clearFromWork() {
    setWork(null); setExplosion(null); setMaterialsReady(false); setReports([]); setReportSequence(''); setReporterId(''); setQualityPassed(false); setReceived('0'); setShipments([]); setClosed(false); clearResult();
  }
  function changeSale() { setSale(null); clearFromWork(); }
  function changeWork() { clearFromWork(); }
  function reset() { setStage(0); setSale(null); clearFromWork(); setPlanQty(orderQty); setGood(orderQty); setBad('0'); setStart(''); setEnd(''); setNote(''); setShipQty('20'); }
  async function transition(domain: string, state: string, action: string, facts: Record<string, unknown>) {
    return requirePreview(await apiRequest<PreviewResult>('/api/design-preview/transition', { method: 'POST', csrfToken: session.csrf_token, body: { domain, state, action, facts } }));
  }
  async function run(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); clearResult();
    try { await operation(); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(errorMessage(failure));
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function approveSale() {
    if (!selectedProduct) throw new Error('请先选择本企业启用的制造产品。');
    const amount = exactQuantity(orderQty, '订单数量', true), unitPrice = exactQuantity(price, '单价');
    if (!customer.trim() || !due) throw new Error('请填写客户名称与交期。');
    const response = await transition('sales', 'draft', 'approve', { line_count: 1, quantity_valid: true, ordered_qty: quantityText(amount), shipped_qty: '0', has_downstream: false });
    setResult(response);
    if (response.allowed) { setSale({ product: selectedProduct, customer: customer.trim(), quantity: quantityText(amount), price: quantityText(unitPrice), due, amount: moneyText(previewMoney(amount, unitPrice)) }); setPlanQty(quantityText(amount, true)); setGood(quantityText(amount, true)); }
  }
  async function freezeWork() {
    if (!sale) throw new Error('请先完成销售审核预检。');
    const amount = exactQuantity(planQty, '工单计划数量', true);
    if (amount > exactQuantity(sale.quantity)) throw new Error('本次单工单示例的计划数量不能超过源订单数量；拆合与超量规则待后续实现。');
    if (!selectedRoute || !routeVersion.data || routeVersion.data.version.id !== routeVersionId || !selectedBom || !bomVersion.data || bomVersion.data.version.id !== bomVersionId) throw new Error('请选择并等待读取真实路线和BOM版本。');
    if (!routeVersion.data.steps.length) throw new Error('所选路线版本没有工序。');
    const boundRoute = bomVersion.data.version.route_version_id;
    if (boundRoute && boundRoute !== routeVersionId) throw new Error('所选BOM绑定了另一条路线版本，请选择一致的冻结版本。');
    setWork({ quantity: quantityText(amount), route: selectedRoute, routeVersion: routeVersion.data, bom: selectedBom, bomVersion: bomVersion.data, state: 'planned' });
    setReportSequence(String(routeVersion.data.steps[0].sequence)); setReporterId(''); setGood(quantityText(amount, true)); setBad('0'); setInboundQty(quantityText(amount, true));
  }
  async function calculateMaterials() {
    if (!work) throw new Error('请先冻结本次模拟工单的版本。');
    const query = new URLSearchParams({ quantity: work.quantity, version_id: work.bomVersion.version.id });
    const response = await apiRequest<Explosion>(`/api/boms/${work.bom.id}/explosion?${query}`);
    if (response.version_id !== work.bomVersion.version.id) throw new Error('算料版本与本次冻结版本不一致。');
    setExplosion(response); setMaterialsReady(false);
  }
  async function startWork() {
    if (!work || !explosion) throw new Error('请先读取冻结BOM的用料清单。');
    const response = await transition('work_order', work.state, 'start', { materials_ready: materialsReady, pending_reports: false, plan_qty: work.quantity, good_qty: '0', quality_passed: false, has_downstream: false });
    setResult(response);
    if (response.allowed) setWork({ ...work, state: response.next_state });
  }
  async function submitReport() {
    if (!work || work.state !== 'running' || !selectedStep) throw new Error('请先完成开工预检，并选择冻结路线中的工序。');
    const reporter = permittedMembers.find(m => String(m.id) === reporterId);
    if (!currentProcess || !reporter) throw new Error('请从当前工序的本企业启用报工名单中选择人员。');
    const goodValue = exactQuantity(good, '良品数量'), badValue = exactQuantity(bad, '不良数量');
    if ((start && !end) || (!start && end)) throw new Error('起止时间请成对填写，或同时留空。');
    if (start && end && new Date(end).getTime() <= new Date(start).getTime()) throw new Error('结束时间须晚于开始时间。');
    const response = await transition('report', 'draft', 'submit', { good_qty: quantityText(goodValue), bad_qty: quantityText(badValue), has_reverse_dependencies: false });
    setResult(response);
    if (response.allowed) setReports(old => [...old, { id: old.length + 1, sequence: selectedStep.sequence, processName: selectedStep.process_name, memberName: reporter.display_name, good: quantityText(goodValue), bad: quantityText(badValue), start, end, note, state: response.next_state }]);
  }
  async function approveReport(row: Report) {
    const response = await transition('report', row.state, 'approve', { good_qty: row.good, bad_qty: row.bad, has_reverse_dependencies: false });
    setResult(response);
    if (response.allowed) {
      setReports(old => old.map(r => r.id === row.id ? { ...r, state: response.next_state } : r));
      const next = work?.routeVersion.steps.find(s => s.sequence > row.sequence && !reports.some(r => r.sequence === s.sequence && r.state === 'approved'));
      if (next) { setReportSequence(String(next.sequence)); setReporterId(''); setBad('0'); setStart(''); setEnd(''); setNote(''); }
    }
  }
  async function completeWork() {
    if (!work) throw new Error('本次模拟工单尚未准备。');
    if (!allStepsApproved) throw new Error('本次合成路线尚有工序没有已审核的模拟报工。');
    const response = await transition('work_order', work.state, 'complete', { materials_ready: true, pending_reports: pendingReports, plan_qty: work.quantity, good_qty: quantityText(finalGood), quality_passed: qualityPassed, has_downstream: true });
    setResult(response);
    if (response.allowed) { setWork({ ...work, state: response.next_state }); setInboundQty(quantityText(finalGood, true)); }
  }
  async function inbound() {
    if (!work || work.state !== 'completed') throw new Error('请先完成工单完工预检。');
    const amount = exactQuantity(inboundQty, '本次入库数量', true);
    if (amount > finalGood) throw new Error('本次入库预览不能超过末道已审核模拟良品数量。');
    const response = await transition('stock_movement', 'pending', 'approve', { movement_kind: 'in', available_qty: '0', requested_qty: quantityText(amount), quality_required: true, quality_passed: qualityPassed, has_reverse_dependencies: false });
    setResult(response);
    if (response.allowed) { setReceived(quantityText(amount)); setShipQty(quantityText(amount < 20_000_000n ? amount : 20_000_000n, true)); }
  }
  async function ship() {
    if (!sale || exactQuantity(received) === 0n) throw new Error('请先完成合成入库预检。');
    const amount = exactQuantity(shipQty, '本批发货数量', true);
    if (amount > orderRemaining) throw new Error('本次示例不能超发源订单剩余量；退货、超发授权待后续实现。');
    const response = await transition('stock_movement', 'pending', 'approve', { movement_kind: 'out', available_qty: quantityText(simulatedStock), requested_qty: quantityText(amount), quality_required: false, quality_passed: false, has_reverse_dependencies: false });
    setResult(response);
    if (response.allowed) {
      const batchAmount = previewMoney(shipped + amount, exactQuantity(sale.price)) - shippedAmount;
      setShipments(old => [...old, { id: old.length + 1, quantity: quantityText(amount), amount: moneyText(batchAmount) }]);
      const remaining = simulatedStock - amount;
      setShipQty(quantityText(remaining > 0n ? remaining : 0n, true));
    }
  }
  async function closeSale() {
    if (!sale) throw new Error('缺少模拟销售单。');
    const response = await transition('sales', 'approved', 'close', { line_count: 1, quantity_valid: true, ordered_qty: sale.quantity, shipped_qty: quantityText(shipped), has_downstream: true });
    setResult(response); if (response.allowed) setClosed(true);
  }
  const accessible = [true, !!sale, !!work, work?.state === 'running' || work?.state === 'completed', work?.state === 'completed', exactQuantity(received) > 0n];
  const allowedManager = session.role !== 'worker';

  return <>
    <div className="page-heading"><div><div className="eyebrow">第二步 / 单据与来源设计</div><h1>业务单据原型</h1><p>对照已见字段走本次合成流程；切换页面或刷新将清空模拟单据。</p></div><button className="button button-secondary" disabled={busy} onClick={reset}>重置本次模拟</button></div>
    <Notice kind="info">本页仍是预检，不生成业务单据。真实销售、加工、报工、库存和发货在“生产主线”菜单。这里的按钮只调用规则预检或只读算料，不扣库存、不计薪、不形成应收。</Notice>
    {!allowedManager && <Notice kind="info">当前员工身份可以查看合成链及报工预检；销售审核、开工、审核报工与库存审核需管理角色，服务会返回权限原因。手机原型可直接做报工数量预检。</Notice>}
    {allErrors.map((message, index) => <Notice key={index}>{message}</Notice>)}
    {((products.data?.total ?? 0) > 100 || [routes.data, boms.data, processes.data].some(data => data && (data.total ?? 0) > (data.limit ?? 200))) && <Notice kind="info">本原型读取前100个产品、前200条其他主数据，当前企业超出范围的资料未全部列入选择。本次合成验收请使用已列出的S2资料。</Notice>}
    {initialLoading ? <Loading label="正在读取本企业主数据…" /> : <>
      <ol className="document-steps" aria-label="本次模拟流程">{steps.map((label, index) => <li key={label}><button disabled={busy || !accessible[index]} className={stage === index ? 'document-step-active' : ''} onClick={() => { setStage(index); clearResult(); }} aria-current={stage === index ? 'step' : undefined}><span>{index + 1}</span>{label}</button></li>)}</ol>
      <div className="document-layout"><section className="panel document-editor"><div className="panel-heading"><h2>{steps[stage]}</h2><span className="badge badge-amber">仅本次模拟</span></div>
        {stage === 0 && <><dl className="detail-list"><div><dt>模拟单号</dt><dd>S2-SALES-LOCAL</dd></div><div><dt>生命周期 / 发货进度</dt><dd>{sale ? '模拟已审核' : '模拟草稿'} / {quantityText(shipped, true)}</dd></div></dl><div className="form-grid subsection">
          <label className="form-field form-field-wide"><span>制造产品</span><select value={productId} disabled={busy} onChange={e => { setProductId(e.target.value); setBomId(''); changeSale(); }}><option value="">选择本企业产品</option>{activeProducts.map(p => <option key={p.id} value={String(p.id)}>{p.code} · {p.name}</option>)}</select><small>单位从真实产品档案读取：{selectedProduct?.unit_name ?? '请先选产品'}</small></label>
          <label className="form-field"><span>客户名称（合成文本）</span><input value={customer} disabled={busy} onChange={e => { setCustomer(e.target.value); changeSale(); }} maxLength={200} /></label><label className="form-field"><span>交期</span><DatePicker value={due ? dayjs(due) : null} disabled={busy} onChange={(v) => { setDue(v ? v.format('YYYY-MM-DD') : ''); changeSale(); }} /></label>
          <label className="form-field"><span>订单数量</span><input inputMode="decimal" value={orderQty} disabled={busy} onChange={e => { setOrderQty(e.target.value); changeSale(); }} /></label><label className="form-field"><span>单价（合成，元/产品单位）</span><input inputMode="decimal" value={price} disabled={busy} onChange={e => { setPrice(e.target.value); changeSale(); }} /></label>
        </div><div className="document-amount"><span>合成订单金额</span><strong>¥ {orderAmount}</strong></div><p className="muted small">50×40=2000.00为本项目合成金额；本例税、折扣和费用均为0，不是原系统已验证的价格规则。改单会清空下游模拟。</p><div className="document-actions"><button className="button button-primary" disabled={busy || !selectedProduct} onClick={() => void run(approveSale)}>审核预检</button><button className="button button-secondary" disabled={busy || !sale} onClick={() => { setStage(1); clearResult(); }}>继续：工单设计</button></div></>}
        {stage === 1 && <>{sale && <dl className="detail-list"><div><dt>模拟来源销售单</dt><dd>S2-SALES-LOCAL · {sale.product.code}</dd></div><div><dt>源订单数量 / 交期</dt><dd>{quantityText(exactQuantity(sale.quantity), true)} {sale.product.unit_name} / {sale.due}</dd></div></dl>}<div className="form-grid subsection">
          <label className="form-field form-field-wide"><span>工单计划数量</span><input inputMode="decimal" value={planQty} disabled={busy} onChange={e => { setPlanQty(e.target.value); changeWork(); }} /></label>
          <label className="form-field"><span>工艺路线</span><select value={routeId} disabled={busy} onChange={e => { setRouteId(e.target.value); changeWork(); }}><option value="">选择启用路线</option>{activeRoutes.map(r => <option key={r.id} value={String(r.id)}>{r.code} · {r.name}</option>)}</select></label><label className="form-field"><span>冻结路线版本</span><select value={routeVersionId} disabled={busy || routeDetail.loading || !routeId} onChange={e => { setRouteVersionId(e.target.value); changeWork(); }}><option value="">选择版本</option>{routeDetail.data?.versions.map(v => <option key={v.id} value={v.id}>v{v.revision} · {v.description || '无说明'}</option>)}</select></label>
          <label className="form-field"><span>本产品 BOM</span><select value={bomId} disabled={busy} onChange={e => { setBomId(e.target.value); changeWork(); }}><option value="">选择本产品 BOM</option>{availableBoms.map(b => <option key={b.id} value={String(b.id)}>{b.parent_code} · {b.parent_name}</option>)}</select></label><label className="form-field"><span>冻结 BOM 版本</span><select value={bomVersionId} disabled={busy || bomDetail.loading || !bomId} onChange={e => { setBomVersionId(e.target.value); changeWork(); }}><option value="">选择版本</option>{bomDetail.data?.versions.map(v => <option key={v.id} value={v.id}>v{v.revision} · {v.description || '无说明'}</option>)}</select></label>
        </div>{routeVersion.data && <div className="route-preview-strip">{routeVersion.data.steps.map(s => <span key={s.sequence}>{s.sequence}. {s.process_name}</span>)}</div>}<p className="muted small">冻结是本项目的版本设计。参考网页出现同名四道/五道路线，不将名称当作相同版本；BOM绑定路线时本原型要求版本一致。</p><div className="document-actions"><button className="button button-primary" disabled={busy || !sale || !routeVersion.data || !bomVersion.data || !!work} onClick={() => void run(freezeWork)}>{work ? '本次版本已冻结' : '冻结本次工单版本'}</button><button className="button button-secondary" disabled={busy || !work} onClick={() => { setStage(2); clearResult(); }}>继续：用料预览</button></div></>}
        {stage === 2 && <><SourceCard sale={sale} work={work} /><button className="button button-primary preview-submit" disabled={busy || !work || work.state !== 'planned'} onClick={() => void run(calculateMaterials)}>读取冻结 BOM 算料</button>{explosion && <><div className="table-scroll subsection"><table className="data-table compact-table"><thead><tr><th>物料</th><th>冻结用量需求</th><th>来源路径</th></tr></thead><tbody>{explosion.requirements.map(row => <tr key={row.product_id}><td>{row.code}<span className="cell-subtitle">{row.name}</span></td><td>{quantityText(exactQuantity(row.quantity), true)} {row.unit_name}</td><td>{row.paths.join('；')}</td></tr>)}</tbody></table></div><p className="muted small">S2 的1.03米是单位用量，loss=0。50件应显示51.5米、100个、50张；读取算料没有领料、占用或扣库。</p><label className="checkbox-field"><input type="checkbox" checked={materialsReady} disabled={busy || work?.state !== 'planned'} onChange={e => { setMaterialsReady(e.target.checked); clearResult(); }} />仅在本次模拟中假设必要领料条件已满足</label></>}<div className="document-actions"><button className="button button-primary" disabled={busy || !explosion || work?.state !== 'planned'} onClick={() => void run(startWork)}>开工预检</button><button className="button button-secondary" disabled={busy || work?.state !== 'running'} onClick={() => { setStage(3); clearResult(); }}>继续：报工设计</button></div></>}
        {stage === 3 && <><SourceCard sale={sale} work={work} /><div className="form-grid subsection"><label className="form-field"><span>冻结路线中的工序</span><select value={reportSequence} disabled={busy || work?.state !== 'running'} onChange={e => { setReportSequence(e.target.value); setReporterId(''); clearResult(); }}><option value="">选择工序</option>{work?.routeVersion.steps.map(s => <option key={s.sequence} value={String(s.sequence)}>{s.sequence}. {s.process_code} · {s.process_name}</option>)}</select></label><label className="form-field"><span>当前工序报工名单</span><select value={reporterId} disabled={busy || !selectedStep || !permittedMembers.length || work?.state !== 'running'} onChange={e => { setReporterId(e.target.value); clearResult(); }}><option value="">选择本企业启用人员</option>{permittedMembers.map(m => <option key={m.id} value={String(m.id)}>{m.display_name}</option>)}</select></label><label className="form-field"><span>良品数量</span><input inputMode="decimal" value={good} disabled={busy || work?.state !== 'running'} onChange={e => { setGood(e.target.value); clearResult(); }} /></label><label className="form-field"><span>不良数量</span><input inputMode="decimal" value={bad} disabled={busy || work?.state !== 'running'} onChange={e => { setBad(e.target.value); clearResult(); }} /></label><label className="form-field"><span>开始时间（可选）</span><input type="datetime-local" value={start} disabled={busy || work?.state !== 'running'} onChange={e => { setStart(e.target.value); clearResult(); }} /></label><label className="form-field"><span>结束时间（可选）</span><input type="datetime-local" value={end} disabled={busy || work?.state !== 'running'} onChange={e => { setEnd(e.target.value); clearResult(); }} /></label><label className="form-field form-field-wide"><span>备注</span><textarea rows={2} value={note} disabled={busy || work?.state !== 'running'} maxLength={1000} onChange={e => { setNote(e.target.value); clearResult(); }} /></label></div>
          {selectedStep && !currentProcess && <Notice>此工序当前已停用或未在已读取范围，请选择有当前启用配置的工序。</Notice>}{selectedStep && currentProcess && !permittedMembers.length && <Notice>当前工序没有可选的本企业启用报工人员。</Notice>}<p className="muted small">报工名单选择是界面依赖预览，服务仅预检数量与动作角色；真实工序鉴权、派工、超量、工资和起止工时计算尚未验收。良0/坏10可提交预检，良0/坏0会拒绝。</p><button className="button button-primary" disabled={busy || !selectedStep || !reporterId || work?.state !== 'running'} onClick={() => void run(submitReport)}>提交报工预检</button>
          {reports.length > 0 && <div className="table-scroll subsection"><table className="data-table compact-table"><thead><tr><th>模拟报工</th><th>工序 / 人员</th><th>良 / 不良</th><th>模拟状态</th><th>动作</th></tr></thead><tbody>{reports.map(row => <tr key={row.id}><td>S2-REPORT-{row.id}</td><td>{row.processName}<span className="cell-subtitle">{row.memberName}</span></td><td>{quantityText(exactQuantity(row.good), true)} / {quantityText(exactQuantity(row.bad), true)}</td><td>{row.state === 'approved' ? '模拟已审核' : '模拟待审核'}</td><td><button className="text-button" disabled={busy || row.state !== 'pending' || !allowedManager} onClick={() => void run(() => approveReport(row))}>审核预检</button></td></tr>)}</tbody></table></div>}
          <label className="checkbox-field"><input type="checkbox" checked={qualityPassed} disabled={busy || work?.state !== 'running'} onChange={e => { setQualityPassed(e.target.checked); clearResult(); }} />仅在本次模拟中假设完工质检已通过</label><p className="muted small">本次合成门禁：每道工序至少有一条已审核模拟报工、没有待审报工、末道良品达到工单计划及检验通过。它不是原系统未确认的完工算法。</p><div className="document-actions"><button className="button button-primary" disabled={busy || work?.state !== 'running'} onClick={() => void run(completeWork)}>工单完工预检</button><button className="button button-secondary" disabled={busy || work?.state !== 'completed'} onClick={() => { setStage(4); clearResult(); }}>继续：成品入库</button></div></>}
        {stage === 4 && <><SourceCard sale={sale} work={work} /><dl className="detail-list subsection"><div><dt>模拟末道已审核良品</dt><dd>{quantityText(finalGood, true)} {sale?.product.unit_name}</dd></div><div><dt>本次已模拟入库</dt><dd>{quantityText(exactQuantity(received), true)}</dd></div></dl><label className="form-field subsection"><span>成品入库数量</span><input inputMode="decimal" value={inboundQty} disabled={busy || exactQuantity(received) > 0n} onChange={e => { setInboundQty(e.target.value); clearResult(); }} /></label><p className="muted small">末道良品作为本原型的可入库量，逐工序自动入库开关不代表重复增加同一成品。这里未触发自动单据、计算真实成本或更新库存。</p><div className="document-actions"><button className="button button-primary" disabled={busy || work?.state !== 'completed' || exactQuantity(received) > 0n} onClick={() => void run(inbound)}>入库审核预检</button><button className="button button-secondary" disabled={busy || exactQuantity(received) === 0n} onClick={() => { setStage(5); clearResult(); }}>继续：分批发货</button></div></>}
        {stage === 5 && <><SourceCard sale={sale} work={work} /><div className="document-metrics"><div><span>模拟成品可用</span><strong>{quantityText(simulatedStock, true)}</strong></div><div><span>订单未发数量</span><strong>{quantityText(orderRemaining, true)}</strong></div><div><span>累计模拟发货金额</span><strong>¥ {moneyText(shippedAmount)}</strong></div></div><label className="form-field"><span>本批发货数量</span><input inputMode="decimal" value={shipQty} disabled={busy || closed || simulatedStock === 0n} onChange={e => { setShipQty(e.target.value); clearResult(); }} /></label><p className="muted small">50件、40元/件时先20件=800.00，再30件=1200.00，库存与未发量归零。数量来自本页模拟；没有形成真实出库、应收或收款。金额按累计数量四舍五入到分取差额，是本原型暂定尾差规则。</p><div className="document-actions"><button className="button button-primary" disabled={busy || closed || simulatedStock === 0n} onClick={() => void run(ship)}>本批发货审核预检</button><button className="button button-secondary" disabled={busy || closed} onClick={() => void run(closeSale)}>{closed ? '模拟订单已关闭' : '销售履约关闭预检'}</button></div>{shipments.length > 0 && <div className="table-scroll subsection"><table className="data-table compact-table"><thead><tr><th>模拟发货单</th><th>数量</th><th>本批金额</th><th>来源</th></tr></thead><tbody>{shipments.map(row => <tr key={row.id}><td>S2-SHIP-{row.id}</td><td>{quantityText(exactQuantity(row.quantity), true)}</td><td>¥ {row.amount}</td><td>S2-SALES-LOCAL</td></tr>)}</tbody></table></div>}<div className="subsection"><h3>工资与费用范围</h3><p className="muted small">此链未匹配工价、冻结工资、计薪或费用分摊。文档的四工序×50良×1元=200元是另一组明确的合成算例，不能套用当前五工序路线，也不能视为本页已计薪结果。</p></div></>}
      </section><aside className="panel document-summary"><div className="panel-heading"><h2>来源与预检结果</h2><span className="badge badge-gray">不保存业务</span></div><dl className="detail-list"><div><dt>本次源销售单</dt><dd>{sale ? 'S2-SALES-LOCAL' : '尚未审核预检'}</dd></div><div><dt>本次模拟工单</dt><dd>{work ? 'S2-WO-LOCAL' : '尚未冻结版本'}</dd></div><div><dt>冻结路线 / BOM</dt><dd>{work ? `v${work.routeVersion.version.revision} / v${work.bomVersion.version.revision}` : '—'}</dd></div><div><dt>报工件次 / 末道成品</dt><dd>{reports.filter(r => r.state === 'approved').reduce((sum, r) => sum + exactQuantity(r.good) + exactQuantity(r.bad), 0n) === 0n ? '0' : quantityText(reports.filter(r => r.state === 'approved').reduce((sum, r) => sum + exactQuantity(r.good) + exactQuantity(r.bad), 0n), true)} / {quantityText(finalGood, true)}</dd></div><div><dt>实际库存改变</dt><dd>无</dd></div></dl><p className="muted small">跨工序报工件次不能直接相加当成成品数量。当前状态、来源和金额均为本次模拟投影。</p>{error && <Notice>{error}</Notice>}{busy && <Loading label="正在执行只读算料或规则预检…" />}{result && <PreviewResultCard result={result} />}{!result && !busy && !error && <p className="muted small">完成当前动作后显示服务返回的通过/拒绝及原因。前置条件未完成时，后续步骤不可进入。</p>}<div className="subsection"><h3>与参考资料的对应</h3><p className="muted small">销售/工单来源与字段、工单→工序→人员依赖、1.03/2/1用量及起止时间来自实操/视频记录。审核时点、冻结、门禁与金额尾差是本项目暂定设计，尚不代表原系统隐藏规则已完全一致。</p></div></aside></div>
    </>}
  </>;
}
function SourceCard({ sale, work }: { sale: Sales | null; work: WorkOrder | null }) {
  return <div className="document-source"><span className="badge badge-outline">S2-SALES-LOCAL</span><span aria-hidden="true">→</span><span className="badge badge-teal">S2-WO-LOCAL</span><p>{sale?.product.code} · {sale?.product.name} · {work ? quantityText(exactQuantity(work.quantity), true) : '—'} {sale?.product.unit_name} · 路线 v{work?.routeVersion.version.revision ?? '—'} / BOM v{work?.bomVersion.version.revision ?? '—'}</p></div>;
}
export function PreviewResultCard({ result }: { result: PreviewResult }) {
  return <div className="subsection" aria-live="polite"><Notice kind={result.allowed ? 'info' : 'error'}>{result.allowed ? '模拟预检通过；没有实际提交业务。' : '模拟预检拒绝；没有实际提交业务。'}</Notice><p className="muted small">模型下一状态：{result.next_state} · posted=false</p>{result.errors.map((item, index) => <p className="preview-error" key={`${item.code}-${index}`}>{item.code} · {item.message}</p>)}{result.effects.map((effect, index) => <p className="muted small" key={index}>{effect}</p>)}</div>;
}

