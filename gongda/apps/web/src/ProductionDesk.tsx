import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, apiRequest, errorMessage, hasPermission } from './api';
import type { Product, Session } from './api';
import { useRemote } from './masterTools';
import { EmptyState, Loading, Notice } from './shared';
import { CommandKeys } from './commandKeys';
import type { BomVersion } from './masterTypes';
import { customerCreatePayload, deskReportPayload, documentActionPayload, fgReceiptPayload, inspectionCompletePayload, inspectionCreatePayload, legacyAddQty, legacyRemaining, materialIssuePayload, salesOrderCreatePayload, shipmentPayload, stockAdjustmentPayload, taskActionPayload, workOrderCreatePayload } from './domain/payloads';

type DeskProps = { session: Session; revision: number; onExpired: () => void; onChanged: () => void };
type List<T> = { items: T[] };
type Customer = { id: string; code: string; name: string; active: boolean; version: number };
type Warehouse = { id: string; code: string; name: string; active: boolean };
type RouteRow = { id: string; code: string; name: string; active: boolean; current_version_id: string };
type BomRow = { id: string; parent_product_id: string; parent_code: string; parent_name: string; active: boolean; current_version_id: string };
type SalesLine = { id: string; product_id: string; product_code: string; product_name: string; unit_name: string; quantity: string; unit_price: string; extended_amount: string; scheduled_qty: string; shipped_qty: string };
type SalesOrder = { id: string; code: string; customer_name: string; lifecycle: string; approval: string; version: number; effective: boolean; lines: SalesLine[]; close_reason: string };
type Material = { id: string; product_id: string; product_code: string; product_name: string; unit_name: string; required_qty: string; issued_qty: string };
type Task = { id: string; sequence: number; process_name: string; plan_qty: string; unit_ratio: string; is_output: boolean; execution: string; pause_source: string; approved_good: string; approved_defect: string; version: number };
type WorkOrder = { id: string; code: string; plan_qty: string; execution: string; order_paused: boolean; version: number; product_snapshot: { name?: string; code?: string }; tasks: Task[]; materials: Material[]; output_qty: string; received_qty: string; wage_status: string; cost_status: string; requires_fg_inspection: boolean; warehouse_id: string };
type Report = { id: string; code: string; task_id: string; good_qty: string; defect_qty: string; approval: string; version: number; posted: boolean; wage_status: string; estimated_wage: string|null };
type Issue = { id: string; code: string; approval: string; version: number; posted: boolean };
type Receipt = { id: string; code: string; quantity: string; approval: string; version: number; posted: boolean };
type Inspection = { id: string; code: string; state: string; conclusion: string; accepted_qty: string; version: number };
type Adjustment = { id: string; code: string; product_id: string; direction: 'in' | 'out'; quantity: string; reason: string; approval: string; version: number; posted: boolean; warehouse_id: string };
type Shipment = { id: string; code: string; sales_order_id: string; approval: string; version: number; posted: boolean; lines: { quantity: string; sales_line_id: string }[] };
type Balance = { warehouse_id: string; warehouse_code: string; product_code: string; product_name: string; unit_name: string; on_hand: string; held_qty:string; blocked_qty:string; reserved_qty:string; available_qty:string };
type Ledger = { id: string; direction: string; quantity: string; source_type: string; event_key: string; posted_at: string; product_id: string };

const lifecycleText: Record<string, string> = { draft: '草稿', open: '执行中', closed: '已关闭', cancelled: '已取消' };
const approvalText: Record<string, string> = { unsubmitted: '未提交', pending: '待审核', approved: '已审核', rejected: '已驳回', withdrawn: '已撤回', reversed: '已冲销' };
const executionText: Record<string, string> = { not_started: '未开始', running: '执行中', paused: '已暂停', completed: '已完工', cancelled: '已取消' };
const sourceText: Record<string, string> = { adjustment: '库存调整', material_issue: '领料出库', fg_receipt: '成品入库', shipment: '销售发货',purchase_receipt:'采购收货',supplement_issue:'补产领料' };

function label(map: Record<string, string>, value: string) { return map[value] ?? value; }
const reviewText: Record<string, string> = { approve: '审核', reject: '驳回', reverse: '冲销' };
function ReviewActions({ approval, canReview, disabled, reason, onAction, approveLabel = '审核', canReverse = true }: { approval: string; canReview: boolean; disabled: boolean; reason: string; onAction: (action: string) => void; approveLabel?: string; canReverse?: boolean }) {
  if (!canReview) return null;
  return <>{(approval === 'pending' ? ['approve','reject'] : approval === 'approved' && canReverse ? ['reverse'] : []).map((action) => <button key={action} type="button" className={`button ${action === 'approve' ? 'button-primary' : 'button-secondary'}`} disabled={disabled || (action !== 'approve' && !reason.trim())} onClick={() => onAction(action)}>{action === 'approve' ? approveLabel : reviewText[action]}</button>)}</>;
}
const remaining = legacyRemaining;

function useDesk(session: Session, onExpired: () => void, onChanged: () => void) {
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const commandKeys = useRef(new CommandKeys());
  async function run(work: () => Promise<string | void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setInfo('');
    try {
      const message = await work();
      if (message) setInfo(message);
      onChanged();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(errorMessage(failure));
    } finally { lock.current = false; setBusy(false); }
  }
  async function send<T>(path: string, body: unknown) {
    const prepared = body && typeof body === 'object' && !Array.isArray(body) ? commandKeys.current.prepare(path, body as Record<string, unknown>) : body;
    const result = await apiRequest<T>(path, { method: 'POST', csrfToken: session.csrf_token, body: prepared });
    if (prepared && typeof prepared === 'object' && !Array.isArray(prepared)) commandKeys.current.complete(path, prepared as Record<string, unknown>);
    return result;
  }
  function review(path: string, item: { code: string; version: number }, action: string, reason: string) {
    return run(async () => { await send(path, documentActionPayload(action, item.version, reason)); return `${item.code} 已${reviewText[action] ?? action}`; });
  }
  return { error, info, busy, run, send, review };
}

export function ProductionDesk({ mode, session, revision, onExpired, onChanged }: DeskProps & { mode: 'sales' | 'production' | 'stock' }) {
  if (mode === 'sales') return <SalesPage session={session} revision={revision} onExpired={onExpired} onChanged={onChanged} />;
  if (mode === 'production') return <ProductionPage session={session} revision={revision} onExpired={onExpired} onChanged={onChanged} />;
  return <StockPage session={session} revision={revision} onExpired={onExpired} onChanged={onChanged} />;
}

function SalesPage({ session, revision, onExpired, onChanged }: DeskProps) {
  const orders = useRemote<List<SalesOrder>>('/api/sales-orders', revision, onExpired);
  const customers = useRemote<List<Customer>>('/api/customers', revision, onExpired);
  const products = useRemote<{ items: Product[] }>('/api/products?page_size=100', revision, onExpired);
  const desk = useDesk(session, onExpired, onChanged);
  const [customerId, setCustomerId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('50');
  const [price, setPrice] = useState('40');
  const [customerCode, setCustomerCode] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [reason, setReason] = useState('');
  const canWrite = hasPermission(session, 'sales.write');
  const canApprove = hasPermission(session, 'sales.approve');
  const activeCustomers = customers.data?.items.filter((item) => item.active) ?? [];
  const activeProducts = products.data?.items.filter((item) => item.active) ?? [];

  async function createCustomer(event: FormEvent) {
    event.preventDefault();
    await desk.run(async () => {
      const created = await desk.send<{ customer: Customer }>('/api/customers', customerCreatePayload(customerCode, customerName));
      setCustomerId(created.customer.id); setCustomerCode(''); setCustomerName('');
      return `已保存客户 ${created.customer.name}`;
    });
  }
  async function createOrder(event: FormEvent) {
    event.preventDefault();
    await desk.run(async () => {
      const created = await desk.send<{ order: SalesOrder }>('/api/sales-orders', salesOrderCreatePayload({ customer_id: customerId, lines: [{ product_id: productId, quantity: quantity.trim(), unit_price: price.trim() }] }));
      return `已保存销售订单 ${created.order.code}，尚未审核，不占用库存`;
    });
  }
  function act(order: SalesOrder, action: string) {
    return () => void desk.run(async () => {
      const updated = await desk.send<{ order: SalesOrder }>(`/api/sales-orders/${order.id}/actions`, documentActionPayload(action, order.version, reason));
      return `${updated.order.code} 已执行${label({ submit: '提交', approve: '审核', reject: '驳回', withdraw: '撤回', cancel: '取消', close: '关闭', force_close: '强制关闭' }, action)}`;
    });
  }

  return <>
    <div className="page-heading"><div><div className="eyebrow">生产主线 / 销售</div><h1>销售订单</h1><p>订单会写入当前企业。审核后才可下达加工单和发货，草稿不产生库存流水。</p></div><span className="badge badge-teal">已落库</span></div>
    {desk.error && <Notice>{desk.error}</Notice>}{desk.info && <Notice kind="success">{desk.info}</Notice>}
    {[orders.error, customers.error, products.error].filter(Boolean).map((message) => <Notice key={message}>{message}</Notice>)}
    {canWrite && <section className="panel"><div className="panel-heading"><h2>新建</h2></div>
      <form className="form-grid" onSubmit={createCustomer}><label className="form-field"><span>客户编号</span><input value={customerCode} onChange={(event) => setCustomerCode(event.target.value)} required disabled={desk.busy} /></label><label className="form-field"><span>客户名称</span><input value={customerName} onChange={(event) => setCustomerName(event.target.value)} required disabled={desk.busy} /></label><div className="document-actions"><button className="button button-secondary" disabled={desk.busy}>保存客户</button></div></form>
      <form className="form-grid subsection" onSubmit={createOrder}><label className="form-field"><span>客户</span><select value={customerId} onChange={(event) => setCustomerId(event.target.value)} required disabled={desk.busy}><option value="">选择客户</option>{activeCustomers.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label className="form-field"><span>产品</span><select value={productId} onChange={(event) => setProductId(event.target.value)} required disabled={desk.busy}><option value="">选择产品</option>{activeProducts.map((item) => <option key={item.id} value={String(item.id)}>{item.code} · {item.name}</option>)}</select></label><label className="form-field"><span>数量</span><input value={quantity} onChange={(event) => setQuantity(event.target.value)} required disabled={desk.busy} inputMode="decimal" /></label><label className="form-field"><span>单价</span><input value={price} onChange={(event) => setPrice(event.target.value)} required disabled={desk.busy} inputMode="decimal" /></label><div className="document-actions"><button className="button button-primary" disabled={desk.busy}>保存草稿订单</button></div></form>
    </section>}
    <section className="panel subsection"><div className="panel-heading"><h2>本企业订单</h2><span className="badge badge-gray">最多 200 条</span></div>
      <label className="form-field"><span>驳回、取消或强制关闭时填写原因</span><input value={reason} onChange={(event) => setReason(event.target.value)} disabled={desk.busy} /></label>
      {orders.loading ? <Loading /> : !orders.data?.items.length ? <EmptyState title="还没有销售订单" description="保存草稿后可以提交审核。审核通过才会变成可排产的开放订单。" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>单号</th><th>客户</th><th>状态</th><th>明细</th><th>操作</th></tr></thead><tbody>{orders.data.items.map((order) => <tr key={order.id}><td className="monospace">{order.code}</td><td>{order.customer_name}</td><td>{label(lifecycleText, order.lifecycle)} / {label(approvalText, order.approval)}</td><td>{order.lines.map((line) => <div key={line.id}>{line.product_code} {line.quantity}{line.unit_name} × {line.unit_price} = {line.extended_amount}<span className="cell-subtitle">已排 {line.scheduled_qty} · 已发 {line.shipped_qty}</span></div>)}</td><td className="document-actions">{canWrite && order.lifecycle === 'draft' && ['unsubmitted', 'rejected', 'withdrawn'].includes(order.approval) && <button className="button button-secondary" disabled={desk.busy} onClick={act(order, 'submit')}>提交</button>}{canApprove && order.approval === 'pending' && <button className="button button-primary" disabled={desk.busy} onClick={act(order, 'approve')}>审核</button>}{canApprove && order.approval === 'pending' && <button className="button button-secondary" disabled={desk.busy} onClick={act(order, 'reject')}>驳回</button>}{canWrite && order.approval === 'pending' && <button className="button button-quiet" disabled={desk.busy} onClick={act(order, 'withdraw')}>撤回</button>}{canApprove && order.lifecycle === 'open' && <button className="button button-secondary" disabled={desk.busy} onClick={act(order, 'close')}>履约关闭</button>}{canApprove && order.lifecycle === 'open' && <button className="button button-quiet" disabled={desk.busy} onClick={act(order, 'force_close')}>强制关闭</button>}{canApprove && ['draft', 'open'].includes(order.lifecycle) && <button className="button button-quiet" disabled={desk.busy} onClick={act(order, 'cancel')}>取消</button>}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}

function ProductionPage({ session, revision, onExpired, onChanged }: DeskProps) {
  const orders = useRemote<List<WorkOrder>>('/api/work-orders', revision, onExpired);
  const sales = useRemote<List<SalesOrder>>(hasPermission(session, 'sales.read') ? '/api/sales-orders' : null, revision, onExpired);
  const routes = useRemote<List<RouteRow>>(hasPermission(session, 'master.read') ? '/api/routes' : null, revision, onExpired);
  const boms = useRemote<List<BomRow>>(hasPermission(session, 'master.read') ? '/api/boms' : null, revision, onExpired);
  const warehouses = useRemote<List<Warehouse>>(hasPermission(session, 'inventory.read') ? '/api/warehouses' : null, revision, onExpired);
  const [selected, setSelected] = useState('');
  const detail = useRemote<{ work_order: WorkOrder }>(selected ? `/api/work-orders/${selected}` : null, revision, onExpired);
  const reports = useRemote<List<Report>>(selected && hasPermission(session, 'production.read') ? `/api/production-reports?work_order_id=${selected}` : null, revision, onExpired);
  const issues = useRemote<List<Issue>>(selected && hasPermission(session, 'inventory.read') ? `/api/material-issues?work_order_id=${selected}` : null, revision, onExpired);
  const receipts = useRemote<List<Receipt>>(selected && hasPermission(session, 'inventory.read') ? `/api/fg-receipts?work_order_id=${selected}` : null, revision, onExpired);
  const inspections = useRemote<List<Inspection>>(selected && hasPermission(session, 'quality.read') ? `/api/inspections?work_order_id=${selected}` : null, revision, onExpired);
  const desk = useDesk(session, onExpired, onChanged);
  const wo = detail.data?.work_order;
  const [lineId, setLineId] = useState('');
  const [planQty, setPlanQty] = useState('50');
  const [routeId, setRouteId] = useState('');
  const [bomId, setBomId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [inspect, setInspect] = useState(false);
  const [reason, setReason] = useState('');
  const [good, setGood] = useState('1');
  const [effectiveSeconds,setEffectiveSeconds]=useState('0');
  const [defect, setDefect] = useState('0');
  const [rework, setRework] = useState('0');
  const [scrap, setScrap] = useState('0');
  const [defectNote, setDefectNote] = useState('');
  const [issueQty, setIssueQty] = useState<Record<string, string>>({});
  const [fgQty, setFgQty] = useState('1');
  const [qcGood, setQcGood] = useState('1');
  const [qcDefect, setQcDefect] = useState('0');
  const openLines = (sales.data?.items ?? []).filter((order) => order.lifecycle === 'open' && order.approval === 'approved').flatMap((order) => order.lines.map((line) => ({ ...line, orderCode: order.code })));
  const chosen = openLines.find((line) => line.id === lineId);
  const bomChoices = (boms.data?.items ?? []).filter((item) => item.active && (!chosen || item.parent_product_id === chosen.product_id));
  const selectedBom = bomChoices.find((item) => item.id === bomId);
  const frozenBom = useRemote<BomVersion>(selectedBom ? `/api/bom-versions/${selectedBom.current_version_id}` : null, revision, onExpired);
  const boundRouteId = frozenBom.data?.version.route_version_id;
  const boundRoute = useRemote<{ version: { route_id: string; revision: number; name_snapshot: string } }>(boundRouteId ? `/api/route-versions/${boundRouteId}` : null, revision, onExpired);
  const running = wo?.tasks.find((task) => task.execution === 'running');
  useEffect(() => { if (!wo) return; setIssueQty(Object.fromEntries(wo.materials.map((item) => [item.id, remaining(item.required_qty, item.issued_qty)]))); setFgQty(wo.output_qty === '0.000000' ? wo.plan_qty : remaining(wo.output_qty, wo.received_qty)); }, [wo?.id, wo?.version]);

  async function createOrder(event: FormEvent) {
    event.preventDefault();
    const route = routes.data?.items.find((item) => item.id === (boundRoute.data?.version.route_id ?? routeId));
    const bom = boms.data?.items.find((item) => item.id === bomId);
    if (!route?.current_version_id || !bom?.current_version_id || !frozenBom.data || (boundRouteId && !boundRoute.data)) return;
    await desk.run(async () => {
      const created = await desk.send<{ work_order: WorkOrder }>('/api/work-orders', workOrderCreatePayload({ sales_line_id: lineId, quantity: planQty.trim(), route_version_id: boundRouteId ?? route.current_version_id, bom_version_id: bom.current_version_id, warehouse_id: warehouseId, requires_fg_inspection: inspect, require_cost: true }));
      setSelected(created.work_order.id);
      return `已下达加工单 ${created.work_order.code}，路线和 BOM 已冻结`;
    });
  }
  function orderAction(action: string) {
    if (!wo) return;
    void desk.run(async () => {
      const updated = await desk.send<{ work_order: WorkOrder }>(`/api/work-orders/${wo.id}/actions`, documentActionPayload(action, wo.version, reason));
      return `${updated.work_order.code} 当前为${label(executionText, updated.work_order.execution)}`;
    });
  }
  function taskAction(task: Task, action: string) {
    if (!wo) return;
    void desk.run(async () => {
      await desk.send(`/api/work-orders/${wo.id}/tasks/${task.id}/actions`, taskActionPayload(action, task.version, reason));
      return action === 'pause' ? '任务已手工暂停' : '任务已恢复';
    });
  }

  return <>
    <div className="page-heading"><div><div className="eyebrow">生产主线 / 执行</div><h1>加工单与报工</h1><p>下达时冻结产品、路线版本和 BOM 展开。报工审核后才计入任务进度；工资按提交时的规则冻结，成本沿采购、领料和入库来源结转。</p></div><span className="badge badge-teal">已落库</span></div>
    {desk.error && <Notice>{desk.error}</Notice>}{desk.info && <Notice kind="success">{desk.info}</Notice>}
    {[orders.error, sales.error, detail.error, reports.error, issues.error, receipts.error, inspections.error, frozenBom.error, boundRoute.error].filter(Boolean).map((message) => <Notice key={message}>{message}</Notice>)}
    {hasPermission(session, 'production.write') && <section className="panel"><div className="panel-heading"><h2>从销售行下达</h2></div><form className="form-grid" onSubmit={createOrder}><label className="form-field"><span>已审核销售行</span><select value={lineId} required disabled={desk.busy} onChange={(event) => setLineId(event.target.value)}><option value="">选择销售行</option>{openLines.map((line) => <option key={line.id} value={line.id}>{line.orderCode} · {line.product_code} 订单 {line.quantity} · 已排 {line.scheduled_qty} · 已发 {line.shipped_qty}</option>)}</select></label><label className="form-field"><span>计划数量</span><input value={planQty} required disabled={desk.busy} inputMode="decimal" onChange={(event) => setPlanQty(event.target.value)} /></label><label className="form-field"><span>路线</span><select value={boundRoute.data?.version.route_id ?? routeId} required disabled={desk.busy || !!boundRouteId} onChange={(event) => setRouteId(event.target.value)}><option value="">选择路线</option>{(routes.data?.items ?? []).filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label className="form-field"><span>BOM</span><select value={bomId} required disabled={desk.busy} onChange={(event) => setBomId(event.target.value)}><option value="">选择与产品一致的 BOM</option>{bomChoices.map((item) => <option key={item.id} value={item.id}>{item.parent_code} · {item.parent_name}</option>)}</select></label><label className="form-field"><span>仓库</span><select value={warehouseId} required disabled={desk.busy} onChange={(event) => setWarehouseId(event.target.value)}><option value="">选择仓库</option>{(warehouses.data?.items ?? []).filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label className="checkbox-field"><input type="checkbox" checked={inspect} disabled={desk.busy} onChange={(event) => setInspect(event.target.checked)} />成品入库前必须检验放行</label><div className="document-actions"><button className="button button-primary" disabled={desk.busy || !warehouses.data || !frozenBom.data || (!!boundRouteId && !boundRoute.data)}>下达加工单</button></div></form>{boundRoute.data && <p className="muted small">按 BOM 绑定的路线版本执行：{boundRoute.data.version.name_snapshot} · v{boundRoute.data.version.revision}。路线主档的新版本不会替换这个引用。</p>}{!hasPermission(session, 'inventory.read') && <p className="muted small">下达加工单需要能读取仓库。当前账号没有库存读取权限。</p>}</section>}
    <section className="panel subsection"><div className="panel-heading"><h2>加工单</h2></div>{orders.loading ? <Loading /> : !orders.data?.items.length ? <EmptyState title="还没有加工单" description="对已审核的销售行下达后，这里会显示冻结的任务和物料。" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>单号</th><th>产品</th><th>计划</th><th>执行</th><th></th></tr></thead><tbody>{orders.data.items.map((item) => <tr key={item.id}><td className="monospace">{item.code}</td><td>{item.product_snapshot.name}</td><td>{item.plan_qty}</td><td>{label(executionText, item.execution)}{item.order_paused ? ' · 工单暂停' : ''}</td><td><button className="button button-secondary" onClick={() => setSelected(item.id)}>打开</button></td></tr>)}</tbody></table></div>}</section>
    {detail.loading && <Loading label="正在读取加工单…" />}
    {wo && <section className="panel subsection"><div className="panel-heading"><h2>{wo.code}</h2><span className="badge badge-amber">工资 {wo.wage_status === 'priced' ? '已计价' : '未计价'} · 成本 {wo.cost_status === 'priced' ? '已计价' : '未计价'}</span></div>
      <dl className="detail-list"><div><dt>产品</dt><dd>{wo.product_snapshot.code} {wo.product_snapshot.name}</dd></div><div><dt>产出 / 已入库</dt><dd>{wo.output_qty} / {wo.received_qty}</dd></div><div><dt>执行</dt><dd>{label(executionText, wo.execution)}</dd></div></dl>
      <label className="form-field subsection"><span>暂停、取消、驳回或冲销原因</span><input value={reason} disabled={desk.busy} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="document-actions">{hasPermission(session, 'production.write') && wo.execution === 'not_started' && <button className="button button-primary" disabled={desk.busy} onClick={() => orderAction('start')}>开工</button>}{hasPermission(session, 'production.write') && ['running', 'paused'].includes(wo.execution) && !wo.order_paused && <button className="button button-secondary" disabled={desk.busy} onClick={() => orderAction('pause')}>工单暂停</button>}{hasPermission(session, 'production.write') && wo.order_paused && <button className="button button-secondary" disabled={desk.busy} onClick={() => orderAction('resume')}>解除工单暂停</button>}{hasPermission(session, 'production.write') && ['running', 'paused'].includes(wo.execution) && <button className="button button-primary" disabled={desk.busy} onClick={() => orderAction('complete')}>完工</button>}{hasPermission(session, 'production.write') && !['completed', 'cancelled'].includes(wo.execution) && <button className="button button-quiet" disabled={desk.busy} onClick={() => orderAction('cancel')}>取消加工单</button>}</div>
      <h3 className="subsection">工序任务</h3><div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>序</th><th>工序</th><th>计划</th><th>良品 / 不良</th><th>状态</th><th></th></tr></thead><tbody>{wo.tasks.map((task) => <tr key={task.id}><td>{task.sequence}{task.is_output ? ' 产出' : ''}</td><td>{task.process_name}</td><td>{task.plan_qty}<span className="cell-subtitle">单位关系 {task.unit_ratio}</span></td><td>{task.approved_good} / {task.approved_defect}</td><td>{label(executionText, task.execution)}{task.pause_source === 'manual' ? ' · 手工暂停' : ''}{task.pause_source === 'order' ? ' · 工单暂停' : ''}</td><td>{hasPermission(session, 'production.write') && task.execution === 'running' && <button className="button button-quiet" disabled={desk.busy} onClick={() => taskAction(task, 'pause')}>暂停</button>}{hasPermission(session, 'production.write') && task.pause_source === 'manual' && <button className="button button-quiet" disabled={desk.busy} onClick={() => taskAction(task, 'resume')}>恢复</button>}</td></tr>)}</tbody></table></div>
      {hasPermission(session, 'production.report') && !hasPermission(session, 'production.approve') && running && <form className="form-grid subsection" onSubmit={(event) => { event.preventDefault(); void desk.run(async () => { const created = await desk.send<{ report: Report }>('/api/production-reports', deskReportPayload({ task_id: running.id, effective_seconds: Number(effectiveSeconds), good_qty: good, defect_qty: defect, rework_qty: rework, scrap_qty: scrap, defect_note: defectNote })); return `报工 ${created.report.code} 已提交，预计工资 ${created.report.estimated_wage??'未计价'}`; }); }}><label className="form-field"><span>当前工序良品</span><input value={good} disabled={desk.busy} inputMode="decimal" onChange={(event) => setGood(event.target.value)} /></label><label className="form-field"><span>不良</span><input value={defect} disabled={desk.busy} inputMode="decimal" onChange={(event) => setDefect(event.target.value)} /></label><label className="form-field"><span>有效工时（秒）</span><input type="number" min="0" max="2678400" step="1" required value={effectiveSeconds} disabled={desk.busy} onChange={event=>setEffectiveSeconds(event.target.value)}/></label><label className="form-field"><span>返工处置</span><input value={rework} disabled={desk.busy} inputMode="decimal" onChange={(event) => setRework(event.target.value)} /></label><label className="form-field"><span>报废处置</span><input value={scrap} disabled={desk.busy} inputMode="decimal" onChange={(event) => setScrap(event.target.value)} /></label><label className="form-field form-field-wide"><span>不良说明</span><input value={defectNote} disabled={desk.busy} onChange={(event) => setDefectNote(event.target.value)} /></label><div className="document-actions"><button className="button button-primary" disabled={desk.busy}>提交报工</button></div><p className="muted small">这里以当前登录人作为操作者，并且要求该工序当前报工名单包含此人。</p></form>}
      {hasPermission(session, 'production.approve') && running && <p className="muted small subsection">当前工序可以报工。代报请打开“手机报工”，指定名单内的实际操作者。</p>}
      {!!reports.data?.items.length && <div className="table-scroll subsection"><table className="data-table compact-table"><thead><tr><th>报工</th><th>数量</th><th>审核</th><th>操作</th></tr></thead><tbody>{reports.data.items.map((report) => <tr key={report.id}><td className="monospace">{report.code}</td><td>良 {report.good_qty} / 不良 {report.defect_qty}</td><td>{label(approvalText, report.approval)}{report.posted ? ' · 已计入' : ''}</td><td className="document-actions"><ReviewActions approval={report.approval} canReview={hasPermission(session, 'production.approve')} disabled={desk.busy || ['completed','cancelled'].includes(wo.execution)} reason={reason} onAction={(action) => void desk.review(`/api/production-reports/${report.id}/actions`, report, action, reason)} approveLabel="审核报工" /></td></tr>)}</tbody></table></div>}
      <h3 className="subsection">冻结物料</h3><div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>物料</th><th>需求</th><th>已领</th><th>本次</th></tr></thead><tbody>{wo.materials.map((item) => <tr key={item.id}><td>{item.product_code}<span className="cell-subtitle">{item.product_name}</span></td><td>{item.required_qty} {item.unit_name}</td><td>{item.issued_qty}</td><td>{hasPermission(session, 'inventory.write') && <input value={issueQty[item.id] ?? ''} disabled={desk.busy} onChange={(event) => setIssueQty((prev) => ({ ...prev, [item.id]: event.target.value }))} />}</td></tr>)}</tbody></table></div>
      {hasPermission(session, 'inventory.write') && !['completed', 'cancelled'].includes(wo.execution) && <div className="document-actions"><button className="button button-secondary" disabled={desk.busy} onClick={() => void desk.run(async () => { const lines = wo.materials.filter((item) => (issueQty[item.id] ?? '').trim() && issueQty[item.id] !== '0').map((item) => ({ material_id: item.id, quantity: issueQty[item.id]!.trim() })); const created = await desk.send<{ material_issue: Issue }>('/api/material-issues', materialIssuePayload(wo.id, wo.warehouse_id, lines)); return `领料单 ${created.material_issue.code} 已开立，审核后才扣库存`; })}>开立领料</button></div>}
      {!!issues.data?.items.length && <div className="table-scroll subsection"><table className="data-table compact-table"><thead><tr><th>领料</th><th>状态</th><th>操作</th></tr></thead><tbody>{issues.data.items.map((item) => <tr key={item.id}><td className="monospace">{item.code}</td><td>{label(approvalText, item.approval)}{item.posted ? ' · 已过账' : ''}</td><td className="document-actions"><ReviewActions approval={item.approval} canReview={hasPermission(session, 'inventory.approve')} disabled={desk.busy} reason={reason} canReverse={wo.execution === 'not_started'} onAction={(action) => void desk.review(`/api/material-issues/${item.id}/actions`, item, action, reason)} approveLabel="审核出库" /></td></tr>)}</tbody></table></div>}
      {hasPermission(session, 'inventory.write') && wo.execution !== 'cancelled' && <form className="form-grid subsection" onSubmit={(event) => { event.preventDefault(); void desk.run(async () => { const created = await desk.send<{ fg_receipt: Receipt }>('/api/fg-receipts', fgReceiptPayload(wo.id, fgQty)); return `成品入库 ${created.fg_receipt.code} 已开立`; }); }}><label className="form-field"><span>成品入库数量</span><input value={fgQty} disabled={desk.busy} inputMode="decimal" onChange={(event) => setFgQty(event.target.value)} /></label><div className="document-actions"><button className="button button-secondary" disabled={desk.busy}>开立成品入库</button></div><p className="muted small">只按末道已审核产出入库。路线上的自动入库开关不会重复过账。</p></form>}
      {!!receipts.data?.items.length && <div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>入库</th><th>数量</th><th>状态</th><th>操作</th></tr></thead><tbody>{receipts.data.items.map((item) => <tr key={item.id}><td className="monospace">{item.code}</td><td>{item.quantity}</td><td>{label(approvalText, item.approval)}</td><td className="document-actions"><ReviewActions approval={item.approval} canReview={hasPermission(session, 'inventory.approve')} disabled={desk.busy} reason={reason} onAction={(action) => void desk.review(`/api/fg-receipts/${item.id}/actions`, item, action, reason)} approveLabel="审核入库" /></td></tr>)}</tbody></table></div>}
      {hasPermission(session, 'quality.write') && wo.execution !== 'cancelled' && <form className="form-grid subsection" onSubmit={(event) => { event.preventDefault(); void desk.run(async () => { const created = await desk.send<{ inspection: Inspection }>('/api/inspections', inspectionCreatePayload(wo.id, legacyAddQty(qcGood, qcDefect), qcGood, qcDefect)); return `检验 ${created.inspection.code} 已送检`; }); }}><label className="form-field"><span>检验合格</span><input value={qcGood} disabled={desk.busy} inputMode="decimal" onChange={(event) => setQcGood(event.target.value)} /></label><label className="form-field"><span>检验不合格</span><input value={qcDefect} disabled={desk.busy} inputMode="decimal" onChange={(event) => setQcDefect(event.target.value)} /></label><div className="document-actions"><button className="button button-secondary" disabled={desk.busy}>送检</button></div></form>}
      {!!inspections.data?.items.length && <div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>检验</th><th>结论</th><th>放行</th><th></th></tr></thead><tbody>{inspections.data.items.map((item) => <tr key={item.id}><td className="monospace">{item.code}</td><td>{item.state === 'pending' ? '待判定' : item.state==='reversed'?'已冲销':item.state==='cancelled'?'已取消':item.conclusion === 'pass' ? '合格' : '不合格'}</td><td>{item.accepted_qty}</td><td>{hasPermission(session, 'quality.write') && item.state === 'pending' && <><button className="button button-primary" disabled={desk.busy} onClick={() => void desk.run(async () => { await desk.send(`/api/inspections/${item.id}/actions`, inspectionCompletePayload(item.version, 'pass')); return `${item.code} 已放行`; })}>放行</button><button className="button button-secondary" disabled={desk.busy} onClick={() => void desk.run(async () => { await desk.send(`/api/inspections/${item.id}/actions`, inspectionCompletePayload(item.version, 'fail')); return `${item.code} 判定不合格`; })}>不合格</button></>}{hasPermission(session, 'quality.write')&&['pending','completed'].includes(item.state)&&<button className="button button-quiet" disabled={desk.busy||!reason.trim()} onClick={()=>void desk.review('/api/inspections/'+item.id+'/actions',item,item.state==='pending'?'cancel':'reverse',reason)}>{item.state==='pending'?'取消送检':'冲销检验'}</button>}</td></tr>)}</tbody></table></div>}
    </section>}
  </>;
}

function StockPage({ session, revision, onExpired, onChanged }: DeskProps) {
  const [reviewReason, setReviewReason] = useState('');
  const balances = useRemote<{ items: Balance[]; negative_stock_allowed: boolean }>('/api/stock/balances', revision, onExpired);
  const ledger = useRemote<{ items: Ledger[]; append_only: boolean }>('/api/stock/ledger', revision, onExpired);
  const warehouses = useRemote<List<Warehouse>>('/api/warehouses', revision, onExpired);
  const products = useRemote<{ items: Product[] }>('/api/products?page_size=100', revision, onExpired);
  const adjustments = useRemote<List<Adjustment>>('/api/stock-adjustments', revision, onExpired);
  const sales = useRemote<List<SalesOrder>>(hasPermission(session, 'sales.read') ? '/api/sales-orders' : null, revision, onExpired);
  const shipments = useRemote<List<Shipment>>('/api/shipments', revision, onExpired);
  const desk = useDesk(session, onExpired, onChanged);
  const [warehouseId, setWarehouseId] = useState('');
  const [productId, setProductId] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('期初入库');
  const [salesId, setSalesId] = useState('');
  const [lineId, setLineId] = useState('');
  const [shipQty, setShipQty] = useState('1');
  const [shipWarehouse, setShipWarehouse] = useState('');
  const canWrite = hasPermission(session, 'inventory.write');
  const canApprove = hasPermission(session, 'inventory.approve');
  const chosen = sales.data?.items.find((item) => item.id === salesId);

  return <>
    <div className="page-heading"><div><div className="eyebrow">生产主线 / 库存</div><h1>库存与发货</h1><p>审核后写入只追加的库存流水，并更新当前库存。现存量不足时拒绝出库。</p></div><span className="badge badge-teal">{balances.data?.negative_stock_allowed === false ? '不允许负库存' : '已落库'}</span></div>
    {desk.error && <Notice>{desk.error}</Notice>}{desk.info && <Notice kind="success">{desk.info}</Notice>}
    {[balances.error, ledger.error, warehouses.error, products.error, adjustments.error, shipments.error].filter(Boolean).map((message) => <Notice key={message}>{message}</Notice>)}
    {canWrite && <section className="panel"><div className="panel-heading"><h2>库存调整</h2><span className="badge badge-amber">不是采购入库</span></div><form className="form-grid" onSubmit={(event) => { event.preventDefault(); void desk.run(async () => { const created = await desk.send<{ stock_adjustment: Adjustment }>('/api/stock-adjustments', stockAdjustmentPayload({ warehouse_id: warehouseId, product_id: productId, direction, quantity, reason })); return `调整单 ${created.stock_adjustment.code} 已开立`; }); }}><label className="form-field"><span>仓库</span><select value={warehouseId} required disabled={desk.busy} onChange={(event) => setWarehouseId(event.target.value)}><option value="">选择仓库</option>{(warehouses.data?.items ?? []).filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label className="form-field"><span>产品</span><select value={productId} required disabled={desk.busy} onChange={(event) => setProductId(event.target.value)}><option value="">选择产品</option>{(products.data?.items ?? []).filter((item) => item.active).map((item) => <option key={item.id} value={String(item.id)}>{item.code} · {item.name}</option>)}</select></label><label className="form-field"><span>方向</span><select value={direction} disabled={desk.busy} onChange={(event) => setDirection(event.target.value as 'in' | 'out')}><option value="in">入库</option><option value="out">出库</option></select></label><label className="form-field"><span>数量</span><input value={quantity} required disabled={desk.busy} inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} /></label><label className="form-field form-field-wide"><span>原因</span><input value={reason} required disabled={desk.busy} onChange={(event) => setReason(event.target.value)} /></label><div className="document-actions"><button className="button button-primary" disabled={desk.busy}>开立调整</button></div></form></section>}
    {canApprove && <section className="panel subsection"><label className="form-field"><span>驳回或冲销原因</span><input value={reviewReason} maxLength={500} disabled={desk.busy} onChange={(event) => setReviewReason(event.target.value)} /></label><p className="muted small">审核才生效；冲销保留原流水与反向流水，已有下游依赖时会拒绝。</p></section>}
    <section className="panel subsection"><div className="panel-heading"><h2>调整单</h2></div>{adjustments.loading ? <Loading /> : <div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>单号</th><th>方向</th><th>数量</th><th>原因</th><th>状态</th><th>操作</th></tr></thead><tbody>{(adjustments.data?.items ?? []).map((item) => <tr key={item.id}><td className="monospace">{item.code}</td><td>{item.direction === 'in' ? '入库' : '出库'}</td><td>{item.quantity}</td><td>{item.reason}</td><td>{label(approvalText, item.approval)}</td><td className="document-actions"><ReviewActions approval={item.approval} canReview={canApprove} disabled={desk.busy} reason={reviewReason} onAction={(action) => void desk.review(`/api/stock-adjustments/${item.id}/actions`, item, action, reviewReason)} approveLabel="审核过账" /></td></tr>)}</tbody></table></div>}</section>
    {canWrite && hasPermission(session, 'sales.read') && <section className="panel subsection"><div className="panel-heading"><h2>分批发货</h2></div><form className="form-grid" onSubmit={(event) => { event.preventDefault(); void desk.run(async () => { const created = await desk.send<{ shipment: Shipment }>('/api/shipments', shipmentPayload(salesId, shipWarehouse, [{ sales_line_id: lineId, quantity: shipQty.trim() }])); return `发货单 ${created.shipment.code} 已开立`; }); }}><label className="form-field"><span>开放订单</span><select value={salesId} required disabled={desk.busy} onChange={(event) => { setSalesId(event.target.value); setLineId(''); }}><option value="">选择订单</option>{(sales.data?.items ?? []).filter((item) => item.lifecycle === 'open').map((item) => <option key={item.id} value={item.id}>{item.code} · {item.customer_name}</option>)}</select></label><label className="form-field"><span>销售行</span><select value={lineId} required disabled={desk.busy} onChange={(event) => setLineId(event.target.value)}><option value="">选择明细</option>{(chosen?.lines ?? []).map((line) => <option key={line.id} value={line.id}>{line.product_code} 未发参考 {line.quantity}，已发 {line.shipped_qty}</option>)}</select></label><label className="form-field"><span>仓库</span><select value={shipWarehouse} required disabled={desk.busy} onChange={(event) => setShipWarehouse(event.target.value)}><option value="">选择仓库</option>{(warehouses.data?.items ?? []).filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.code}</option>)}</select></label><label className="form-field"><span>本批数量</span><input value={shipQty} required disabled={desk.busy} inputMode="decimal" onChange={(event) => setShipQty(event.target.value)} /></label><div className="document-actions"><button className="button button-primary" disabled={desk.busy}>开立发货</button></div></form></section>}
    <section className="panel subsection"><div className="panel-heading"><h2>发货单</h2></div><div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>单号</th><th>状态</th><th>操作</th></tr></thead><tbody>{(shipments.data?.items ?? []).map((item) => <tr key={item.id}><td className="monospace">{item.code}</td><td>{label(approvalText, item.approval)}{item.posted ? ' · 已过账' : ''}</td><td className="document-actions"><ReviewActions approval={item.approval} canReview={canApprove} disabled={desk.busy} reason={reviewReason} canReverse={(sales.data?.items.find((order) => order.id === item.sales_order_id)?.lifecycle ?? 'open') === 'open'} onAction={(action) => void desk.review(`/api/shipments/${item.id}/actions`, item, action, reviewReason)} approveLabel="审核出库" /></td></tr>)}</tbody></table></div></section>
    <section className="panel subsection"><div className="panel-heading"><h2>当前库存</h2></div>{balances.loading ? <Loading /> : !balances.data?.items.length ? <EmptyState title="还没有库存余额" description="库存调整、领料、成品入库或发货审核通过后，这里显示当前现存量。" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>仓库</th><th>产品</th><th>现存量</th><th>待检 / 冻结 / 预占</th><th>可用量</th></tr></thead><tbody>{balances.data.items.map((item) => <tr key={`${item.warehouse_id}-${item.product_code}`}><td>{item.warehouse_code}</td><td>{item.product_code} · {item.product_name}</td><td>{item.on_hand} {item.unit_name}</td><td>{item.held_qty} / {item.blocked_qty} / {item.reserved_qty}</td><td>{item.available_qty}</td></tr>)}</tbody></table></div>}</section>
    <section className="panel subsection"><div className="panel-heading"><h2>库存流水</h2><span className="badge badge-gray">{ledger.data?.append_only ? '只追加' : '读取中'}</span></div>{ledger.loading ? <Loading /> : <div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>时间</th><th>方向</th><th>数量</th><th>来源</th><th>事件</th></tr></thead><tbody>{(ledger.data?.items ?? []).map((item) => <tr key={item.id}><td>{new Date(item.posted_at).toLocaleString('zh-CN', { hour12: false })}</td><td>{item.direction === 'in' ? '入' : '出'}</td><td>{item.quantity}</td><td>{label(sourceText, item.source_type)}</td><td className="monospace">{item.event_key}</td></tr>)}</tbody></table></div>}</section>
  </>;
}
