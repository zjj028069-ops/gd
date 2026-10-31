import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { App, Button, Input, Modal, Select, Switch, Table } from 'antd';
import dayjs from 'dayjs';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { ExtFieldInputs } from '../../extensions/ExtFieldInputs';
import { useExtForm } from '../../extensions/bind';
import { putEntityExtValues } from '../../extensions/useEntityExtensions';
import type { ExtValues } from '../../extensions/useEntityExtensions';
import { showError } from '../../kit';
import { cmpQty, mulQty, qty, qtyForSets, subQty } from '../../qty';
import { codePlaceholder, DayField, MemberSelect, ProductPicker, searchPlaceholder } from '../money/shared';
import { ProgressCell } from './shared';
import { useWarehouseApi } from './useWarehouseApi';
import type { WhRec } from './useWarehouseApi';
import { requestKey } from '../../../requestKey';

type WoRow = WhRec & { code: string; product_name?: string; plan_qty?: string; output_qty?: string; received_qty?: string; received_fg_qty?: string; fg_progress?: string; warehouse_id?: string; materials?: { id: string; product_name: string; product_id?: string; required_qty: string; issued_qty: string }[] };
type StockLine = { key: string; product_id: string; product_name: string; quantity: string; on_hand?: string; sale_price?: string; unit_price?: string };

function useActiveWarehouses() {
  const api = useWarehouseApi();
  const remote = useRemote<{ items: WhRec[] }>('/api/warehouse/warehouses', api.revision, api.onExpired);
  const options = useMemo(() => (remote.data?.items ?? []).filter((w) => w.active !== false).map((w) => ({ value: String(w.id), label: String(w.name) })), [remote.data]);
  return { options, api };
}

function woOptionLabel(row: WoRow) {
  const code = String(row.code ?? '');
  const name = String(row.product_name ?? '').trim();
  return name ? `${code} ${name}` : code;
}

function useWorkOrders(opts?: { forFg?: boolean }) {
  const api = useWarehouseApi();
  const remote = useRemote<{ items: WoRow[] }>(opts?.forFg ? '/api/warehouse/work-orders?for=fg' : '/api/warehouse/work-orders', api.revision, api.onExpired);
  return { items: remote.data?.items ?? [], api };
}

function useBomLines(workOrderId: string | '') {
  const api = useWarehouseApi();
  const remote = useRemote<{ items: { id: string; material_id: string; product_id: string; product_name: string; required_qty: string; issued_qty: string }[] }>(
    workOrderId ? `/api/warehouse/work-orders/${workOrderId}/bom-lines` : null,
    api.revision,
    api.onExpired,
  );
  return remote.data?.items ?? [];
}

type LinePick = { purchase_line_id: string; quantity: string; product_name?: string; order_qty?: string; progress?: string; on_hand?: string };

export function PurchaseReceiptModal({ onClose, seed, orderId }: { onClose: () => void; seed?: Record<string, unknown>; orderId?: string }) {
  const { message } = App.useApp();
  const api = useWarehouseApi();
  const warehouses = useRemote<{ items: WhRec[] }>('/api/warehouse/warehouses', api.revision, api.onExpired);
  const settings = useRemote<{ io_types: WhRec[] }>('/api/warehouse/settings', api.revision, api.onExpired);
  const [warehouseId, setWarehouseId] = useState('');
  const [inboundType, setInboundType] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [receiverId, setReceiverId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LinePick[]>([]);
  const [lineValues, setLineValues] = useState<Record<string, ExtValues>>({});
  const [picker, setPicker] = useState(false);
  const headExt = useExtForm('purchase_stock_in');
  const lineExt = useExtForm('purchase_stock_in_line');
  const inboundTypes = (settings.data?.io_types ?? []).filter((t) => t.direction === 'in');
  async function save() {
    if (!warehouseId) { message.error('请选择入库仓库'); return; }
    if (!date) { message.error('请选择入库日期'); return; }
    if (!receiverId) { message.error('请选择收货人'); return; }
    const filled = lines.filter((l) => Number(l.quantity) > 0);
    if (!filled.length) { message.error('请至少填写一条入库数量大于0的明细'); return; }
    const headErr = headExt.error();
    if (headErr) { message.error(headErr); return; }
    for (const line of filled) {
      const lineErr = lineExt.error(lineValues[line.purchase_line_id] ?? {});
      if (lineErr) { message.error(lineErr); return; }
    }
    try {
      const saved = await api.send<{ purchase_receipt?: { id?: string; lines?: { id: string; purchase_line_id: string }[] } }>('/api/warehouse/purchase-receipts', {
        request_key: requestKey(),
        order_id: orderId ?? seed?.order_id,
        warehouse_id: warehouseId,
        receipt_date: date,
        inbound_type: inboundType,
        receiver_id: receiverId,
        note,
        lines: filled.map((line) => ({ purchase_line_id: line.purchase_line_id, quantity: line.quantity })),
      });
      const receipt = saved?.purchase_receipt;
      if (receipt?.id) {
        await headExt.persist(api.session.csrf_token, receipt.id);
        for (const savedLine of receipt.lines ?? []) {
          const values = lineValues[savedLine.purchase_line_id];
          if (savedLine.id && lineExt.fields.length && values) await putEntityExtValues(api.session.csrf_token, 'purchase_stock_in_line', savedLine.id, values);
        }
      }
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal className="wh-bill-modal" title="新增采购入库单" open width={980} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="kgd-form wh-bill-modal">
      <span>采购入库单号</span><Input placeholder={codePlaceholder} disabled />
      <span>入库仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={(warehouses.data?.items ?? []).filter((w) => w.active !== false).map((w) => ({ value: String(w.id), label: String(w.name) }))} />
      <span>入库类型</span><Select allowClear value={inboundType || undefined} onChange={setInboundType} options={inboundTypes.map((t) => ({ value: String(t.name), label: String(t.name) }))} />
      <span>入库日期 *</span><DayField value={date} onChange={setDate} />
      <span>收货人 *</span><MemberSelect revision={api.revision} value={receiverId} onChange={setReceiverId} />
      <span>备注</span><Input.TextArea maxLength={255} showCount value={note} onChange={(e) => setNote(e.target.value)} />
      {headExt.node}
    </div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setPicker(true)}>+ 选择采购入库商品</Button><Button danger disabled={!lines.length} onClick={() => setLines([])}>清空</Button></div>
    <Table size="small" rowKey="purchase_line_id" pagination={false} dataSource={lines} columns={[
      { title: '序号', render: (_, __, i) => i + 1 },
      { title: '采购单号', dataIndex: 'order_code' },
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.purchase_line_id === row.purchase_line_id ? { ...l, quantity: e.target.value } : l))} /> },
      { title: '入库进度', render: (_, row) => <ProgressCell progress={row.progress && row.progress !== 'undefined' ? row.progress : '0% (0/0)'} /> },
      { title: '扩展字段', render: (_, row) => lineExt.fields.length ? <div className="ext-line-fields" data-line={row.purchase_line_id}><ExtFieldInputs fields={lineExt.fields} values={lineValues[row.purchase_line_id] ?? {}} onChange={(next) => setLineValues((cur) => ({ ...cur, [row.purchase_line_id]: next }))} /></div> : null },
      { title: '操作', render: (_, row) => <button type="button" className="kgd-link" onClick={() => setLines((cur) => cur.filter((l) => l.purchase_line_id !== row.purchase_line_id))}>删除</button> },
    ]} />
    {picker && <PurchaseLinePicker onClose={() => setPicker(false)} onPick={(picked) => { setLines(picked); setPicker(false); }} />}
  </Modal>;
}

function PurchaseLinePicker({ onClose, onPick }: { onClose: () => void; onPick: (lines: LinePick[]) => void }) {
  const api = useWarehouseApi();
  const remote = useRemote<{ items: WhRec[] }>('/api/money/purchase-orders?q=', api.revision, api.onExpired);
  const [selected, setSelected] = useState<string[]>([]);
  const rows = useMemo(() => (remote.data?.items ?? []).flatMap((order) => ((order.lines as WhRec[] | undefined) ?? []).map((line) => ({
    id: String(line.id),
    order_code: order.code,
    product_name: line.product_name,
    quantity: line.quantity,
    progress: line.inbound_progress,
    purchase_line_id: String(line.id),
  }))), [remote.data]);
  return <Modal title="选择采购单商品" open width={920} onCancel={onClose} onOk={(event) => { event.stopPropagation(); onPick(rows.filter((r) => selected.includes(String(r.id))).map((r) => ({ purchase_line_id: r.purchase_line_id, quantity: '0', product_name: String(r.product_name), progress: String(r.progress ?? '0% (0/0)') }))); }} okText="确 定" cancelText="取 消">
    <Table size="small" rowKey={(row) => String(row.id)} rowSelection={{ preserveSelectedRowKeys: true, selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)) }} dataSource={rows} columns={[
      { title: '采购单号', dataIndex: 'order_code' },
      { title: '商品名', dataIndex: 'product_name' },
      { title: '数量', dataIndex: 'quantity' },
      { title: '入库进度', render: (_, row) => <ProgressCell progress={String(row.progress ?? '0% (0/0)')} /> },
    ]} />
  </Modal>;
}

export function PurchaseReturnModal({ onClose, orderId, orderLabel, supplierName }: { onClose: () => void; orderId?: string; orderLabel?: string; supplierName?: string }) {
  const { message } = App.useApp();
  const api = useWarehouseApi();
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [order, setOrder] = useState(orderId ?? '');
  const [lines, setLines] = useState<LinePick[]>([]);
  const [picker, setPicker] = useState(false);
  const extForm = useExtForm('purchase_return');
  const warehouses = useRemote<{ items: WhRec[] }>('/api/warehouse/warehouses', api.revision, api.onExpired);
  const purchases = useRemote<{ items: WhRec[] }>(orderId ? null : '/api/money/purchase-orders?q=', api.revision, api.onExpired);
  const orderDetail = useRemote<{ purchase_order: WhRec }>(order ? `/api/money/purchase-orders/${order}` : null, api.revision, api.onExpired);
  const lockedOrder = orderLabel ?? purchases.data?.items.find((p) => p.id === order)?.code ?? orderDetail.data?.purchase_order?.code;
  const supplier = supplierName ?? purchases.data?.items.find((p) => p.id === order)?.supplier_name ?? orderDetail.data?.purchase_order?.supplier_name;
  async function save() {
    if (!warehouseId) { message.error('请选择仓库'); return; }
    if (!order) { message.error('请选择采购单号'); return; }
    if (!date) { message.error('请选择退货日期'); return; }
    if (!lines.length) { message.error('请至少选择一条退货商品'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ purchase_return?: { id?: string } }>('/api/warehouse/purchase-returns', {
        request_key: requestKey(),
        order_id: order,
        warehouse_id: warehouseId,
        return_date: date,
        lines: lines.map((line) => ({ purchase_line_id: line.purchase_line_id, quantity: line.quantity })),
      });
      if (saved?.purchase_return?.id) await extForm.persist(api.session.csrf_token, saved.purchase_return.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增采购退货单" open width={900} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="wh-form-tip">商品退货数量超出当前库存数量背景为红色，仓库不存在该商品为灰色。</div>
    <div className="kgd-form wh-bill-modal">
      <span>采购退货单号</span><Input placeholder={codePlaceholder} disabled />
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={(warehouses.data?.items ?? []).map((w) => ({ value: String(w.id), label: String(w.name) }))} />
      <span>采购单号 *</span>{orderId ? <Input disabled value={String(lockedOrder ?? '')} /> : <Select showSearch placeholder={searchPlaceholder} value={order || undefined} onChange={setOrder} options={(purchases.data?.items ?? []).map((p) => ({ value: String(p.id), label: String(p.code) }))} />}
      <span>供应商</span><Input disabled value={String(supplier ?? '')} />
      <span>退货日期 *</span><DayField value={date} onChange={setDate} />
      {extForm.node}
    </div>
    <div className="kgd-toolbar"><Button type="primary" disabled={!order} onClick={() => setPicker(true)}>+ 选择退货商品</Button></div>
    <Table size="small" rowKey="purchase_line_id" pagination={false} dataSource={lines} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '采购数量', dataIndex: 'order_qty' },
      { title: '退货数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.purchase_line_id === row.purchase_line_id ? { ...l, quantity: e.target.value } : l))} /> },
    ]} />
    {picker && <Modal title="选择退货商品" open onCancel={() => setPicker(false)} onOk={() => setPicker(false)} okText="确 定" cancelText="取 消" width={800}>
      <Table size="small" rowKey="id" pagination={false} dataSource={((orderDetail.data?.purchase_order?.lines as WhRec[] | undefined) ?? []).map((line) => ({
        id: String(line.id),
        product_name: line.product_name,
        quantity: line.quantity,
        purchase_line_id: String(line.id),
      }))} rowSelection={{ type: 'checkbox', onChange: (_, picked) => setLines(picked.map((row) => ({
        purchase_line_id: String(row.purchase_line_id),
        product_name: String(row.product_name),
        order_qty: String(row.quantity),
        quantity: '0',
      }))) }} columns={[
        { title: '商品名称', dataIndex: 'product_name' },
        { title: '采购数量', dataIndex: 'quantity' },
      ]} />
    </Modal>}
  </Modal>;
}

function contractShipQty(line: WhRec) {
  const total = String(line.quantity ?? '0');
  if (line.shipped_qty != null && line.shipped_qty !== '') return subQty(total, String(line.shipped_qty));
  const progress = line.outbound_progress ?? line.ship_progress;
  if (progress != null && progress !== '') {
    const matched = String(progress).match(/\(([^/]+)\/([^)]+)\)/);
    if (matched) return subQty(matched[2]!, matched[1]!);
  }
  return total;
}

export function ShipmentModal({ onClose, seed, contractId }: { onClose: () => void; seed?: Record<string, unknown>; contractId?: string }) {
  const { message } = App.useApp();
  const api = useWarehouseApi();
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [contract, setContract] = useState(contractId ?? String(seed?.contract_id ?? ''));
  const [lines, setLines] = useState<{ contract_line_id: string; quantity: string; product_name?: string }[]>([]);
  const warehouses = useRemote<{ items: WhRec[] }>('/api/warehouse/warehouses', api.revision, api.onExpired);
  const contracts = useRemote<{ items: WhRec[] }>(contractId ? null : '/api/money/contracts?q=', api.revision, api.onExpired);
  const detail = useRemote<WhRec>(contract ? `/api/money/contracts/${contract}` : null, api.revision, api.onExpired);
  const customer = detail.data?.contract as WhRec | undefined;
  const extForm = useExtForm('sale_stock_out');
  async function save() {
    if (!warehouseId) { message.error('请选择仓库'); return; }
    if (!contract) { message.error('请选择合同单号'); return; }
    if (!date) { message.error('请选择出库日期'); return; }
    const filled = lines.filter((l) => Number(l.quantity) > 0);
    if (!filled.length) { message.error('请至少填写一条出库数量大于0的明细'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ shipment?: { id?: string } }>('/api/warehouse/shipments', {
        request_key: requestKey(),
        contract_id: contract,
        warehouse_id: warehouseId,
        ship_date: date,
        outbound_mode: '合同出库',
        contact_name: customer?.contact_name,
        contact_phone: customer?.contact_phone,
        ship_address: customer?.address,
        lines: filled.map((line) => ({ contract_line_id: line.contract_line_id, quantity: line.quantity })),
      });
      if (saved?.shipment?.id) await extForm.persist(api.session.csrf_token, saved.shipment.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增销售出库单" open width={980} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="wh-form-tip">注：商品出库数量超出可用库存数量背景为红色。</div>
    <div className="kgd-form wh-bill-modal">
      <span>销售出库单号</span><Input placeholder={codePlaceholder} disabled />
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={(warehouses.data?.items ?? []).filter((w) => w.active !== false).map((w) => ({ value: String(w.id), label: String(w.name) }))} />
      <span>出库日期 *</span><DayField value={date} onChange={setDate} />
      <span>客户</span><Input disabled value={customer ? `${customer.customer_code}/${customer.customer_name}` : ''} />
      <span>联系人</span><Input disabled value={customer ? `${customer.contact_name}/${customer.contact_phone}` : ''} />
      <span>地址</span><Input disabled value={String(customer?.address ?? '')} />
      {!contractId && <><span>合同单号 *</span><Select showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={contract || undefined} onChange={(id) => { setContract(id); setLines([]); }} options={(contracts.data?.items ?? []).map((c) => ({ value: String(c.id), label: `${String(c.code ?? '')} ${String(c.customer_name ?? '')}` }))} /></>}
      {extForm.node}
    </div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => {
      if (!contract) { message.error('请先选择合同'); return; }
      if (detail.error) { message.error(detail.error || '合同详情加载失败，请重试'); return; }
      if (detail.loading) { message.warning('合同详情加载中，请稍候'); return; }
      const src = ((customer?.lines as WhRec[] | undefined) ?? []);
      if (!src.length) { message.warning('该合同暂无商品明细'); return; }
      setLines(src.map((line) => ({ contract_line_id: String(line.id), quantity: contractShipQty(line), product_name: String(line.product_name) })));
    }}>+ 选择合同商品</Button></div>
    {contract && detail.error ? <div className="wh-form-tip" style={{ color: '#cf1322' }}>合同详情加载失败：{detail.error}</div> : null}
    <Table size="small" rowKey="contract_line_id" pagination={false} dataSource={lines} columns={[
      { title: '商品名', dataIndex: 'product_name' },
      { title: '出库数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.contract_line_id === row.contract_line_id ? { ...l, quantity: e.target.value } : l))} /> },
    ]} />
  </Modal>;
}

export function FgReceiptModal({ onClose, workOrderId: initialOrder }: { onClose: () => void; workOrderId?: string }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const { items: workOrders } = useWorkOrders({ forFg: true });
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [workOrderId, setWorkOrderId] = useState(initialOrder ?? '');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const headExt = useExtForm('fg_receipt');
  const lineExt = useExtForm('fg_receipt_line');
  const wo = workOrders.find((row) => row.id === workOrderId);
  useEffect(() => {
    if (initialOrder && wo && !qty) setQty(subQty(String(wo.plan_qty ?? '0'), String(wo.received_fg_qty ?? '0')));
  }, [initialOrder, wo, qty]);
  const progress = wo ? String(wo.fg_progress ?? `${wo.received_fg_qty ?? '0'}/${wo.plan_qty ?? '0'}`) : '0/0';
  async function save() {
    if (!workOrderId) { message.error('请选择加工单'); return; }
    if (!qty.trim()) { message.error('请填写入库数量'); return; }
    if (!date) { message.error('请选择入库日期'); return; }
    const headErr = headExt.error();
    if (headErr) { message.error(headErr); return; }
    const lineErr = lineExt.error();
    if (lineErr) { message.error(lineErr); return; }
    try {
      const saved = await api.send<{ fg_receipt?: { id?: string } }>('/api/warehouse/fg-receipts', { request_key: requestKey(), work_order_id: workOrderId, quantity: qty, warehouse_id: warehouseId || wo?.warehouse_id, receipt_date: date });
      const id = saved?.fg_receipt?.id ?? '';
      if (id) {
        await headExt.persist(api.session.csrf_token, id);
        await lineExt.persist(api.session.csrf_token, id);
      }
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal className="wh-bill-modal" title="新增成品入库单" open width={920} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="kgd-form wh-bill-modal">
      <span>成品入库单号</span><Input placeholder={codePlaceholder} disabled />
      <span>入库日期 *</span><DayField value={date} onChange={setDate} />
      <span>入库仓库 *</span><Select value={warehouseId || wo?.warehouse_id || undefined} onChange={setWarehouseId} options={options} />
      <span>加工单 *</span><Select showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={workOrderId || undefined} onChange={(id) => { setWorkOrderId(id); const found = workOrders.find((row) => row.id === id); if (found) setQty(subQty(String(found.plan_qty ?? '0'), String(found.received_fg_qty ?? '0'))); }} options={workOrders.map((row) => ({ value: String(row.id), label: woOptionLabel(row) }))} />
      <span>入库数量 *</span><Input value={qty} onChange={(e) => setQty(e.target.value)} />
      <span>入库进度</span><ProgressCell progress={String(wo?.fg_progress ?? progress)} />
      <span>备注</span><Input.TextArea maxLength={255} showCount value={note} onChange={(e) => setNote(e.target.value)} />
      {headExt.node}
      {lineExt.node}
    </div>
  </Modal>;
}

export function MaterialIssueModal({ onClose, workOrderId: initialOrder }: { onClose: () => void; workOrderId?: string }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const { items: workOrders } = useWorkOrders();
  const settings = useRemote<{ io_types: WhRec[] }>('/api/warehouse/settings', api.revision, api.onExpired);
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [workOrderId, setWorkOrderId] = useState(initialOrder ?? '');
  const [sets, setSets] = useState('1');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [lineQty, setLineQty] = useState<Record<string, string>>({});
  const bom = useBomLines(workOrderId);
  const extForm = useExtForm('material_issue');
  const wo = workOrders.find((row) => row.id === workOrderId);
  const planQty = String(wo?.plan_qty ?? '0');
  const outboundTypes = (settings.data?.io_types ?? []).filter((t) => t.direction === 'out');
  useEffect(() => {
    if (wo?.warehouse_id) setWarehouseId(String(wo.warehouse_id));
  }, [workOrderId, wo?.warehouse_id]);
  useEffect(() => {
    if (!bom.length) { setLineQty({}); return; }
    const next: Record<string, string> = {};
    bom.forEach((mat) => {
      const open = subQty(mat.required_qty, mat.issued_qty);
      next[mat.material_id] = sets && planQty !== '0' ? qtyForSets(mat.required_qty, sets, planQty) : open;
    });
    setLineQty(next);
  }, [workOrderId, sets, planQty, bom.map((m) => `${m.material_id}:${m.required_qty}:${m.issued_qty}`).join(',')]);
  const rows = bom.filter((mat) => !onlyOpen || cmpOpen(mat)).map((mat) => ({ ...mat, id: mat.material_id, quantity: lineQty[mat.material_id] ?? '' }));
  function cmpOpen(mat: { required_qty: string; issued_qty: string }) {
    return Number(subQty(mat.required_qty, mat.issued_qty)) > 0;
  }
  async function save() {
    if (!warehouseId) { message.error('请选择仓库'); return; }
    if (!date) { message.error('请选择出库日期'); return; }
    if (!workOrderId) { message.error('请选择加工单'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ material_issue?: { id?: string } }>('/api/warehouse/material-issues', { request_key: requestKey(), work_order_id: workOrderId, warehouse_id: warehouseId, issue_date: date, sets, incomplete_only: onlyOpen });
      if (saved?.material_issue?.id) await extForm.persist(api.session.csrf_token, saved.material_issue.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal className="wh-bill-modal" title="新增生产出库单" open width={980} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="wh-form-tip">注：商品出库数量超出可用库存数量背景为红色，仓库不存在该商品为灰色。</div>
    <div className="kgd-form wh-bill-modal">
      <span>生产出库单号</span><Input placeholder={codePlaceholder} disabled />
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>出库类型</span><Select allowClear options={outboundTypes.map((t) => ({ value: String(t.name), label: String(t.name) }))} />
      <span>出库日期 *</span><DayField value={date} onChange={setDate} />
      <span>加工单号 *</span><Select showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={workOrderId || undefined} onChange={setWorkOrderId} options={workOrders.map((row) => ({ value: String(row.id), label: woOptionLabel(row) }))} />
      <span>出库套数</span><Input value={sets} onChange={(e) => setSets(e.target.value)} />
      <span>备注</span><Input.TextArea maxLength={255} showCount />
      {extForm.node}
    </div>
    <div className="kgd-toolbar"><label><Switch checked={onlyOpen} onChange={setOnlyOpen} /> 仅显示出库未完成</label></div>
    <Table size="small" rowKey="id" pagination={false} dataSource={rows} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '出库数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLineQty((cur) => ({ ...cur, [row.id]: e.target.value }))} /> },
      { title: '出库进度', render: (_, row) => <ProgressCell progress={`0% (${row.issued_qty}/${row.required_qty})`} /> },
    ]} />
  </Modal>;
}

function WoBomModal({ title, extra, onClose, onSave }: { title: string; extra?: ReactNode; onClose: () => void; onSave: (payload: { warehouseId: string; workOrderId: string; date?: string; lines: { product_id: string; quantity: string; product_name: string; material_id?: string }[] }) => Promise<void> }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const { items: workOrders } = useWorkOrders();
  const [warehouseId, setWarehouseId] = useState('');
  const [workOrderId, setWorkOrderId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [lines, setLines] = useState<{ material_id?: string; product_id: string; product_name: string; quantity: string }[]>([]);
  const bom = useBomLines(workOrderId);
  useEffect(() => {
    if (!bom.length) { setLines([]); return; }
    setLines(bom.map((mat) => ({ material_id: mat.material_id, product_id: String(mat.product_id), product_name: mat.product_name, quantity: '0' })));
  }, [workOrderId, bom.map((m) => m.material_id).join(',')]);
  async function save() {
    if (!warehouseId) { message.error('请选择仓库'); return; }
    if (!workOrderId) { message.error('请选择加工单'); return; }
    if (!date) { message.error('请选择日期'); return; }
    const valid = lines.filter((line) => line.quantity && Number(line.quantity) > 0);
    if (!valid.length) { message.error('请至少填写一条数量大于0的明细'); return; }
    try {
      await onSave({ warehouseId, workOrderId, lines: valid, date });
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal className="wh-bill-modal" title={title} open width={900} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="kgd-form wh-bill-modal">
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>加工单 *</span><Select showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={workOrderId || undefined} onChange={setWorkOrderId} options={workOrders.map((row) => ({ value: String(row.id), label: woOptionLabel(row) }))} />
      <span>日期 *</span><DayField value={date} onChange={setDate} />
      {extra}
    </div>
    <Table size="small" pagination={false} dataSource={lines} rowKey="product_id" columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.product_id === row.product_id ? { ...l, quantity: e.target.value } : l))} /> },
    ]} />
  </Modal>;
}

export function SemiFgModal({ onClose }: { onClose: () => void }) {
  const api = useWarehouseApi();
  const extForm = useExtForm('semi_fg');
  return <WoBomModal title="新增半成品入库单" extra={extForm.node} onClose={onClose} onSave={async (payload) => {
    const extErr = extForm.error();
    if (extErr) throw new Error(extErr);
    const saved = await api.send<{ misc_bill?: { id?: string } }>('/api/warehouse/misc-bills', {
      request_key: requestKey(),
      bill_kind: 'semi_fg_in',
      warehouse_id: payload.warehouseId,
      work_order_id: payload.workOrderId,
      bill_date: payload.date,
      lines: payload.lines.map((line) => ({ product_id: line.product_id, quantity: line.quantity })),
    });
    if (saved?.misc_bill?.id) await extForm.persist(api.session.csrf_token, saved.misc_bill.id);
  }} />;
}

export function ProdReturnModal({ onClose }: { onClose: () => void }) {
  const api = useWarehouseApi();
  const extForm = useExtForm('prod_return');
  return <WoBomModal title="新增生产退料单" extra={extForm.node} onClose={onClose} onSave={async (payload) => {
    const extErr = extForm.error();
    if (extErr) throw new Error(extErr);
    const saved = await api.send<{ misc_bill?: { id?: string } }>('/api/warehouse/material-returns', {
      request_key: requestKey(),
      warehouse_id: payload.warehouseId,
      work_order_id: payload.workOrderId,
      return_date: payload.date,
      lines: payload.lines.map((line) => ({ material_id: line.material_id ?? line.product_id, quantity: line.quantity })),
    });
    if (saved?.misc_bill?.id) await extForm.persist(api.session.csrf_token, saved.misc_bill.id);
  }} />;
}

export function SalesReturnModal({ onClose, mode }: { onClose: () => void; mode?: string }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [contractId, setContractId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const contracts = useRemote<{ items: WhRec[] }>('/api/money/contracts?q=', api.revision, api.onExpired);
  const detail = useRemote<WhRec>(contractId ? `/api/money/contracts/${contractId}` : null, api.revision, api.onExpired);
  const [lines, setLines] = useState<{ contract_line_id: string; product_id: string; product_name: string; quantity: string }[]>([]);
  const extForm = useExtForm('sales_return');
  async function save() {
    if (!warehouseId) { message.error('请选择仓库'); return; }
    if (!contractId) { message.error('请选择合同单号'); return; }
    if (!date) { message.error('请选择退货日期'); return; }
    const filled = lines.filter((l) => l.quantity && l.quantity !== '0');
    if (!filled.length) { message.error('请至少填写一条退货数量'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ misc_bill?: { id?: string } }>('/api/warehouse/misc-bills', {
        request_key: requestKey(),
        bill_kind: 'sales_return',
        warehouse_id: warehouseId,
        contract_id: contractId,
        bill_date: date,
        note: mode ?? '',
        lines: filled.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
      });
      if (saved?.misc_bill?.id) await extForm.persist(api.session.csrf_token, saved.misc_bill.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增销售退货单" open width={920} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="kgd-form wh-bill-modal">
      <span>销售退货单号</span><Input placeholder={codePlaceholder} disabled />
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>合同单号 *</span><Select showSearch placeholder={searchPlaceholder} value={contractId || undefined} onChange={(id) => { setContractId(id); setLines([]); }} options={(contracts.data?.items ?? []).map((c) => ({ value: String(c.id), label: String(c.code) }))} />
      <span>退货日期 *</span><DayField value={date} onChange={setDate} />
      {extForm.node}
    </div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setLines(((detail.data?.contract?.lines as WhRec[] | undefined) ?? (detail.data?.lines as WhRec[] | undefined) ?? []).map((line) => ({ contract_line_id: String(line.id), product_id: String(line.product_id), product_name: String(line.product_name), quantity: '0' })))}>+ 选择合同商品</Button></div>
    <Table size="small" rowKey="contract_line_id" pagination={false} dataSource={lines} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '退货数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.contract_line_id === row.contract_line_id ? { ...l, quantity: e.target.value } : l))} /> },
    ]} />
  </Modal>;
}

export function ElseInModal({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [lines, setLines] = useState<StockLine[]>([]);
  const [picker, setPicker] = useState(false);
  const extForm = useExtForm('else_stock_in');
  async function save() {
    if (!warehouseId) { message.error('请选择入库仓库'); return; }
    if (!date) { message.error('请选择入库日期'); return; }
    const filledIn = lines.filter((l) => l.quantity && l.quantity !== '0');
    if (!filledIn.length) { message.error('请至少选择一个商品'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ misc_bill?: { id?: string } }>('/api/warehouse/misc-bills', {
        request_key: requestKey(),
        bill_kind: 'else_in',
        warehouse_id: warehouseId,
        bill_date: date,
        lines: filledIn.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_price: l.sale_price ?? '0' })),
      });
      if (saved?.misc_bill?.id) await extForm.persist(api.session.csrf_token, saved.misc_bill.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增其他入库单" open width={960} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="kgd-form wh-bill-modal">
      <span>其他入库单号</span><Input placeholder={codePlaceholder} disabled />
      <span>入库仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>入库日期 *</span><DayField value={date} onChange={setDate} />
      {extForm.node}
    </div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setPicker(true)}>+ 选择入库商品</Button></div>
    <Table size="small" rowKey="key" pagination={false} dataSource={lines} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.key === row.key ? { ...l, quantity: e.target.value } : l))} /> },
      { title: '销售单价(元)', render: (_, row) => <Input value={row.sale_price ?? ''} onChange={(e) => setLines((cur) => cur.map((l) => l.key === row.key ? { ...l, sale_price: e.target.value } : l))} /> },
    ]} />
    <ProductPicker open={picker} onClose={() => setPicker(false)} onPick={(rows) => setLines((cur) => [...cur, ...rows.map((p) => ({ key: String(p.id), product_id: String(p.id), product_name: String(p.name), quantity: '0', sale_price: String(p.sale_price ?? '') }))])} />
  </Modal>;
}

export function ElseOutModal({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const { items: workOrders } = useWorkOrders();
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [lines, setLines] = useState<StockLine[]>([]);
  const [picker, setPicker] = useState(false);
  const [bomPicker, setBomPicker] = useState(false);
  const [bomWo, setBomWo] = useState('');
  const extForm = useExtForm('else_stock_out');
  const bomLines = useBomLines(bomWo);
  function copyRow(row: StockLine) {
    setLines((cur) => [...cur, { ...row, key: `${row.product_id}-${Date.now()}` }]);
  }
  async function save() {
    if (!warehouseId) { message.error('请选择仓库'); return; }
    if (!date) { message.error('请选择出库日期'); return; }
    const filledOut = lines.filter((l) => l.quantity && l.quantity !== '0');
    if (!filledOut.length) { message.error('请至少选择一个商品'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ misc_bill?: { id?: string } }>('/api/warehouse/misc-bills', {
        request_key: requestKey(),
        bill_kind: 'else_out',
        warehouse_id: warehouseId,
        bill_date: date,
        lines: filledOut.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
      });
      if (saved?.misc_bill?.id) await extForm.persist(api.session.csrf_token, saved.misc_bill.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增其他出库单" open width={960} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="wh-form-tip">注：商品出库数量超出可用库存数量背景为红色。</div>
    <div className="kgd-form wh-bill-modal">
      <span>其他出库单号</span><Input placeholder={codePlaceholder} disabled />
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>出库日期 *</span><DayField value={date} onChange={setDate} />
      {extForm.node}
    </div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setPicker(true)}>+ 选择出库商品</Button><Button onClick={() => setBomPicker(true)}>+ 按BOM选择商品</Button></div>
    <Table size="small" rowKey="key" pagination={false} dataSource={lines} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.key === row.key ? { ...l, quantity: e.target.value } : l))} /> },
      { title: '操作', render: (_, row) => <button type="button" className="kgd-link" onClick={() => copyRow(row)}>复制</button> },
    ]} />
    <ProductPicker open={picker} onClose={() => setPicker(false)} onPick={(rows) => setLines((cur) => [...cur, ...rows.map((p) => ({ key: String(p.id), product_id: String(p.id), product_name: String(p.name), quantity: '0' }))])} />
    {bomPicker && <Modal title="按BOM选择商品" open onCancel={() => setBomPicker(false)} onOk={() => {
      setLines((cur) => [...cur, ...bomLines.map((m) => ({ key: `${m.product_id}-${Date.now()}`, product_id: m.product_id, product_name: m.product_name, quantity: subQty(m.required_qty, m.issued_qty) }))]);
      setBomPicker(false);
    }} width={720}>
      <Select showSearch optionFilterProp="label" placeholder="选择加工单" style={{ width: '100%', marginBottom: 12 }} value={bomWo || undefined} onChange={setBomWo} options={workOrders.map((row) => ({ value: String(row.id), label: woOptionLabel(row) }))} />
      <Table size="small" rowKey="material_id" pagination={false} dataSource={bomLines} columns={[
        { title: '商品', dataIndex: 'product_name' },
        { title: '需求', dataIndex: 'required_qty' },
        { title: '已领', dataIndex: 'issued_qty' },
      ]} />
    </Modal>}
  </Modal>;
}

export function TransferModal({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [lines, setLines] = useState<StockLine[]>([]);
  const [picker, setPicker] = useState(false);
  const [bomPicker, setBomPicker] = useState(false);
  const [bomId, setBomId] = useState('');
  const [bomSets, setBomSets] = useState('1');
  const extForm = useExtForm('stock_allocate');
  const balances = useRemote<{ items: WhRec[] }>(fromId ? `/api/warehouse/stock/balances?view=warehouse&only_positive=false` : null, api.revision, api.onExpired);
  const boms = useRemote<{ items: WhRec[] }>('/api/boms', api.revision, api.onExpired);
  function onHand(productId: string) {
    const hit = (balances.data?.items ?? []).find((row) => String(row.warehouse_id) === fromId && String(row.product_id) === productId);
    return String(hit?.on_hand ?? '0');
  }
  function overStock(row: StockLine) {
    try { return cmpQty(row.quantity || '0', onHand(row.product_id)) > 0; } catch { return false; }
  }
  async function applyBom() {
    if (!fromId) { message.error('请先选择发出仓库'); return; }
    const bom = (boms.data?.items ?? []).find((item) => String(item.id) === bomId);
    if (!bom?.current_version_id) { message.error('请选择BOM'); return; }
    const sets = bomSets.trim();
    try {
      if (qty(sets) <= 0n) throw new Error('套数须大于零');
      const detail = await apiRequest<{ items?: { component_product_id: string; component_name: string; quantity: string }[] }>(`/api/bom-versions/${bom.current_version_id}`);
      const items = detail.items ?? [];
      if (!items.length) { message.error('该BOM没有第一层物料'); return; }
      const stamp = Date.now();
      setLines((cur) => [...cur, ...items.map((item, index) => ({
        key: `${item.component_product_id}-${stamp}-${index}`,
        product_id: item.component_product_id,
        product_name: item.component_name,
        quantity: mulQty(item.quantity, sets),
      }))]);
      setBomPicker(false);
    } catch (error) { message.error(showError(error)); }
  }
  async function save() {
    if (!fromId) { message.error('请选择发出仓库'); return; }
    if (!toId) { message.error('请选择收入仓库'); return; }
    if (!date) { message.error('请选择调拨日期'); return; }
    if (!lines.length) { message.error('请至少选择一个商品'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ transfer_bill?: { id?: string } }>('/api/warehouse/transfer-bills', {
        request_key: requestKey(),
        from_warehouse_id: fromId,
        to_warehouse_id: toId,
        transfer_date: date,
        lines: lines.map((line) => ({ product_id: line.product_id, quantity: line.quantity })),
      });
      if (saved?.transfer_bill?.id) await extForm.persist(api.session.csrf_token, saved.transfer_bill.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增库存调拨单" open width={960} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="kgd-form wh-bill-modal">
      <span>调拨单号</span><Input placeholder={codePlaceholder} disabled />
      <span>发出仓库 *</span><Select value={fromId || undefined} onChange={setFromId} options={options} />
      <span>收入仓库 *</span><Select value={toId || undefined} onChange={setToId} options={options} />
      <span>调拨日期 *</span><DayField value={date} onChange={setDate} />
      <span>调拨人</span><Input placeholder="调拨人" />
      <span>成本总额</span><Input disabled value="0" />
      <span>销售总额</span><Input disabled value="0" />
      <span>备注</span><Input.TextArea placeholder="备注" />
      {extForm.node}
    </div>
    <div className="wh-form-tip" style={{ color: '#f5222d' }}>注：商品出库数量超出库存数量背景为红色。</div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setPicker(true)} disabled={!fromId}>+ 选择库存商品</Button><Button disabled={!fromId} onClick={() => setBomPicker(true)}>+ 按BOM选择商品</Button></div>
    <Table size="small" rowKey="key" pagination={false} dataSource={lines} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '数量', onCell: (row) => ({ className: overStock(row) ? 'wh-qty-over' : undefined }), render: (_, row) => <Input className={overStock(row) ? 'wh-qty-over' : undefined} value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.key === row.key ? { ...l, quantity: e.target.value } : l))} /> },
    ]} />
    {picker && <Modal title="选择库存商品" open onCancel={() => setPicker(false)} onOk={() => setPicker(false)} width={720}>
      <Table size="small" rowKey="id" pagination={false} dataSource={(balances.data?.items ?? []).filter((row) => String(row.warehouse_id) === fromId)} rowSelection={{ type: 'checkbox', onChange: (_, picked) => setLines(picked.map((row) => ({ key: String(row.product_id), product_id: String(row.product_id), product_name: String(row.product_name), quantity: String(row.on_hand ?? '0') }))) }} columns={[
        { title: '商品', dataIndex: 'product_name' },
        { title: '库存', render: (_, row) => row.on_hand },
      ]} />
    </Modal>}
    {bomPicker && <Modal title="按BOM选择商品" open onCancel={() => setBomPicker(false)} onOk={() => void applyBom()} okText="确定" cancelText="取消">
      <Select showSearch optionFilterProp="label" placeholder="选择BOM" style={{ width: '100%', marginBottom: 12 }} value={bomId || undefined} onChange={setBomId} options={(boms.data?.items ?? []).map((item) => ({ value: String(item.id), label: `${item.code || item.parent_code || ''} ${item.name || item.parent_name || ''}`.trim() }))} />
      <Input addonBefore="套数" value={bomSets} onChange={(e) => setBomSets(e.target.value)} />
    </Modal>}
  </Modal>;
}

export function StockTakingModal({ onClose, mode }: { onClose: () => void; mode: 'custom' | 'full' }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [takerId, setTakerId] = useState('');
  const [lines, setLines] = useState<{ product_id: string; product_name: string; book_qty: string; actual_qty: string }[]>([]);
  const [picker, setPicker] = useState(false);
  const extForm = useExtForm('stock_taking');
  const balances = useRemote<{ items: WhRec[] }>(warehouseId ? `/api/warehouse/stock/balances?view=warehouse&only_positive=false` : null, api.revision, api.onExpired);
  useEffect(() => {
    if (mode !== 'full' || !warehouseId) return;
    setLines((balances.data?.items ?? []).filter((row) => String(row.warehouse_id) === warehouseId).map((row) => ({
      product_id: String(row.product_id),
      product_name: String(row.product_name),
      book_qty: String(row.on_hand ?? '0'),
      actual_qty: String(row.on_hand ?? '0'),
    })));
  }, [mode, warehouseId, balances.data]);
  const diffTotal = lines.reduce((n, line) => n + (Number(line.actual_qty) - Number(line.book_qty)), 0);
  async function save(confirm: boolean) {
    if (!warehouseId) { message.error('请选择盘点仓库'); return; }
    if (!takerId) { message.error('请选择盘点人'); return; }
    if (!date) { message.error('请选择盘点日期'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ stock_taking?: { id?: string } }>('/api/warehouse/stock-taking-bills', {
        request_key: requestKey(),
        warehouse_id: warehouseId,
        taking_date: date,
        taker_id: takerId,
        mode,
        confirm,
        lines: lines.map((line) => ({ product_id: line.product_id, actual_qty: line.actual_qty })),
      });
      if (saved?.stock_taking?.id) await extForm.persist(api.session.csrf_token, saved.stock_taking.id);
      message.success(confirm ? '已确定盘点' : '已存为草稿');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title={mode === 'full' ? '一键盘库' : '自定义盘库'} open width={980} onCancel={onClose} footer={[
    <Button key="cancel" onClick={onClose}>取 消</Button>,
    <Button key="draft" onClick={() => void save(false)} loading={api.busy}>存为草稿</Button>,
    <Button key="ok" type="primary" onClick={() => void save(true)} loading={api.busy}>确 定</Button>,
  ]}>
    <div className="kgd-form wh-bill-modal">
      <span>盘点日期 *</span><DayField value={date} onChange={setDate} />
      <span>盘点人 *</span><MemberSelect revision={api.revision} value={takerId} onChange={setTakerId} />
      <span>盘点仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>差异总数</span><Input disabled value={String(diffTotal)} />
      {extForm.node}
    </div>
    {mode === 'custom' && <div className="kgd-toolbar"><Button type="primary" disabled={!warehouseId} onClick={() => setPicker(true)}>+ 选择库存商品</Button></div>}
    <Table size="small" rowKey="product_id" pagination={false} dataSource={lines} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '盘点前数量', dataIndex: 'book_qty' },
      { title: '已盘点数量', render: (_, row) => <Input value={row.actual_qty} onChange={(e) => setLines((cur) => cur.map((l) => l.product_id === row.product_id ? { ...l, actual_qty: e.target.value } : l))} /> },
      { title: '差异数量', render: (_, row) => String(Number(row.actual_qty) - Number(row.book_qty)) },
    ]} />
    {picker && <Modal title="选择库存商品" open onCancel={() => setPicker(false)} onOk={() => setPicker(false)} width={720}>
      <Table size="small" rowKey="id" pagination={false} dataSource={(balances.data?.items ?? []).filter((row) => String(row.warehouse_id) === warehouseId)} rowSelection={{ type: 'checkbox', onChange: (_, picked) => setLines(picked.map((row) => ({ product_id: String(row.product_id), product_name: String(row.product_name), book_qty: String(row.on_hand ?? '0'), actual_qty: String(row.on_hand ?? '0') }))) }} columns={[
        { title: '商品', dataIndex: 'product_name' },
        { title: '库存', render: (_, row) => row.on_hand },
      ]} />
    </Modal>}
  </Modal>;
}

export function DirectShipmentModal({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const customers = useRemote<{ items: WhRec[] }>('/api/money/customers?q=', api.revision, api.onExpired);
  const [warehouseId, setWarehouseId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<StockLine[]>([]);
  const [picker, setPicker] = useState(false);
  const customer = (customers.data?.items ?? []).find((row) => String(row.id) === customerId);
  const extForm = useExtForm('sale_stock_out');
  async function save() {
    const filled = lines.filter((l) => l.quantity && l.quantity !== '0');
    if (!warehouseId || !filled.length) { message.error('请选择仓库并填写出库数量'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ shipment?: { id?: string } }>('/api/warehouse/shipments', {
        request_key: requestKey(),
        outbound_mode: '直接出库',
        customer_id: customerId || undefined,
        warehouse_id: warehouseId,
        ship_date: date,
        contact_name: customer?.contact_name,
        contact_phone: customer?.contact_phone,
        ship_address: customer?.address,
        note,
        lines: filled.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_price: l.sale_price || '0' })),
      });
      if (saved?.shipment?.id) await extForm.persist(api.session.csrf_token, saved.shipment.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增销售出库单（直接出库）" open width={980} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="wh-form-tip">注：商品出库数量超出可用库存数量背景为红色。</div>
    <div className="kgd-form wh-bill-modal">
      <span>销售出库单号</span><Input placeholder={codePlaceholder} disabled />
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>出库日期 *</span><DayField value={date} onChange={setDate} />
      <span>客户</span><Select allowClear showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={customerId || undefined} onChange={(value) => setCustomerId(value ?? '')} options={(customers.data?.items ?? []).map((c) => ({ value: String(c.id), label: `${String(c.code ?? '')} ${String(c.name ?? '')}` }))} />
      <span>备注</span><Input.TextArea maxLength={255} showCount value={note} onChange={(e) => setNote(e.target.value)} />
      {extForm.node}
    </div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setPicker(true)}>+ 选择出库商品</Button><Button danger disabled={!lines.length} onClick={() => setLines([])}>清空</Button></div>
    <Table size="small" rowKey="key" pagination={false} dataSource={lines} columns={[
      { title: '商品名', dataIndex: 'product_name' },
      { title: '出库数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.key === row.key ? { ...l, quantity: e.target.value } : l))} /> },
      { title: '销售单价(元)', render: (_, row) => <Input value={row.sale_price ?? ''} onChange={(e) => setLines((cur) => cur.map((l) => l.key === row.key ? { ...l, sale_price: e.target.value } : l))} /> },
      { title: '操作', render: (_, row) => <button type="button" className="kgd-link" onClick={() => setLines((cur) => cur.filter((l) => l.key !== row.key))}>删除</button> },
    ]} />
    <ProductPicker open={picker} onClose={() => setPicker(false)} onPick={(rows) => setLines((cur) => [...cur, ...rows.map((p) => ({ key: `${String(p.id)}-${Date.now()}`, product_id: String(p.id), product_name: String(p.name), quantity: '0', sale_price: String(p.sale_price ?? '') }))])} />
  </Modal>;
}

export function ShipmentReturnModal({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const shipments = useRemote<{ items: WhRec[] }>('/api/warehouse/shipments', api.revision, api.onExpired);
  const [warehouseId, setWarehouseId] = useState('');
  const [shipmentId, setShipmentId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [lines, setLines] = useState<{ key: string; product_id: string; product_name: string; shipped: string; quantity: string }[]>([]);
  const shipment = (shipments.data?.items ?? []).find((row) => String(row.id) === shipmentId);
  const extForm = useExtForm('sales_return');
  function pick(id: string) {
    setShipmentId(id);
    const row = (shipments.data?.items ?? []).find((item) => String(item.id) === id);
    if (row?.warehouse_id && !warehouseId) setWarehouseId(String(row.warehouse_id));
    setLines(((row?.lines as WhRec[] | undefined) ?? []).map((line, index) => ({ key: String(line.id ?? index), product_id: String(line.product_id), product_name: String(line.product_name ?? ''), shipped: String(line.quantity ?? '0'), quantity: '0' })));
  }
  async function save() {
    const filled = lines.filter((l) => l.quantity && l.quantity !== '0');
    if (!warehouseId || !shipment || !filled.length) { message.error('请选择出库单并填写退货数量'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await api.send<{ misc_bill?: { id?: string } }>('/api/warehouse/misc-bills', {
        request_key: requestKey(),
        bill_kind: 'sales_return',
        warehouse_id: warehouseId,
        ...(shipment.contract_id ? { contract_id: String(shipment.contract_id) } : {}),
        note: `按出库退货 ${String(shipment.code ?? '')}`,
        lines: filled.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
      });
      if (saved?.misc_bill?.id) await extForm.persist(api.session.csrf_token, saved.misc_bill.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增销售退货单（按出库退货）" open width={920} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="kgd-form wh-bill-modal">
      <span>销售退货单号</span><Input placeholder={codePlaceholder} disabled />
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>销售出库单 *</span><Select showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={shipmentId || undefined} onChange={pick} options={(shipments.data?.items ?? []).filter((row) => String(row.approval ?? '') !== 'reversed').map((row) => ({ value: String(row.id), label: `${String(row.code ?? '')} ${String(row.customer_name ?? '')}` }))} />
      <span>退货日期 *</span><DayField value={date} onChange={setDate} />
      {extForm.node}
    </div>
    <Table size="small" rowKey="key" pagination={false} dataSource={lines} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '出库数量', dataIndex: 'shipped' },
      { title: '退货数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.key === row.key ? { ...l, quantity: e.target.value } : l))} /> },
    ]} />
  </Modal>;
}

const outsourceTitle = { in: '新增外协工单入库单', out: '新增外协工单出库单', return: '新增外协工单退料单' } as const;

export function OutsourceBillModal({ kind, orderId: initialOrder, onClose }: { kind: 'in' | 'out' | 'return'; orderId?: string; onClose: () => void }) {
  const { message } = App.useApp();
  const { options, api } = useActiveWarehouses();
  const orders = useRemote<{ items: WhRec[] }>('/api/outsource/orders', api.revision, api.onExpired);
  const [warehouseId, setWarehouseId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ key: string; product_id?: string; material_id?: string; product_name: string; need: string; quantity: string }[]>([]);
  const order = (orders.data?.items ?? []).find((row) => String(row.id) === orderId);
  useEffect(() => {
    if (initialOrder && !orderId && orders.data) pick(initialOrder);
  }, [initialOrder, orders.data]);
  function pick(id: string) {
    setOrderId(id);
    const row = (orders.data?.items ?? []).find((item) => String(item.id) === id);
    if (!row) { setLines([]); return; }
    if (kind === 'in') { setLines([{ key: 'product', product_id: String(row.product_id), product_name: String(row.product_name ?? ''), need: String(row.plan_qty ?? '0'), quantity: '0' }]); return; }
    setLines(((row.materials as WhRec[] | undefined) ?? []).map((m) => ({ key: String(m.id), material_id: String(m.id), product_name: String(m.product_name ?? ''), need: String(Number(m.unit_qty ?? 0) * Number(row.plan_qty ?? 0)), quantity: '0' })));
  }
  async function save() {
    const filled = lines.filter((l) => l.quantity && l.quantity !== '0');
    if (!warehouseId || !orderId || !filled.length) { message.error('请选择仓库、外协工单并填写数量'); return; }
    try {
      await api.send('/api/warehouse/outsource-bills', {
        request_key: requestKey(), kind, order_id: orderId, warehouse_id: warehouseId, bill_date: date, note,
        lines: filled.map((l) => ({ ...(l.product_id ? { product_id: l.product_id } : {}), ...(l.material_id ? { material_id: l.material_id } : {}), quantity: l.quantity })),
      });
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title={outsourceTitle[kind]} open width={920} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <div className="kgd-form wh-bill-modal">
      <span>单号</span><Input placeholder={codePlaceholder} disabled />
      <span>仓库 *</span><Select value={warehouseId || undefined} onChange={setWarehouseId} options={options} />
      <span>外协工单 *</span><Select showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={orderId || undefined} onChange={pick} options={(orders.data?.items ?? []).filter((row) => !['已取消'].includes(String(row.status ?? ''))).map((row) => ({ value: String(row.id), label: `${String(row.code ?? '')} ${String(row.product_name ?? '')}` }))} />
      <span>供应商</span><Input disabled value={String(order?.supplier_name ?? '')} />
      <span>日期 *</span><DayField value={date} onChange={setDate} />
      <span>备注</span><Input.TextArea maxLength={255} showCount value={note} onChange={(e) => setNote(e.target.value)} />
    </div>
    {kind !== 'in' && orderId && !lines.length && <div className="wh-form-tip">该外协工单没有用料清单，请先在外协工单详情里新增用料清单。</div>}
    <Table size="small" rowKey="key" pagination={false} dataSource={lines} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: kind === 'in' ? '计划数' : '需求数量', dataIndex: 'need' },
      { title: kind === 'in' ? '入库数量' : kind === 'out' ? '出库数量' : '退料数量', render: (_, row) => <Input value={row.quantity} onChange={(e) => setLines((cur) => cur.map((l) => l.key === row.key ? { ...l, quantity: e.target.value } : l))} /> },
    ]} />
  </Modal>;
}
