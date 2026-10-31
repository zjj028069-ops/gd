import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, DatePicker, Input, Modal, Select } from 'antd';
import dayjs from 'dayjs';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import type { ListColumn } from '../../ListFrame';
import { showError, useCommand, useQueryState, beijingTime } from '../../kit';
import { printDocs } from '../../print';
import { dash, RedSummary, StatusTag } from '../round8/kit';

type Rec = Record<string, string> & { id: string; materials?: { id: string; product_name: string; product_code: string; unit_qty: string }[] };

export function OutContentList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/outsource/contents', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [items, setItems] = useState([{ name: '', field_type: '文本', required: true, description: '' }]);
  const columns: ListColumn<Rec>[] = [
    { key: 'title', title: '标题', render: (row) => row.title },
    { key: 'items', title: '检查项', render: (row) => dash(row.item_count) },
    { key: 'note', title: '备注', render: (row) => dash(row.note) },
    { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
    { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at, '') },
    { key: 'actions', title: '操作', render: (row) => <Button type="link" onClick={() => void command.send(`/api/outsource/contents/${row.id}`, {}, 'DELETE').then(() => message.success('已删除')).catch((error) => message.error(showError(error)))}>删除</Button> },
  ];
  return <>
    <ListFrame pageKey="os-content" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'title', label: '标题' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>} />
    <Modal title="新增验收内容" open={open} width={760} okText="确定" cancelText="取消" confirmLoading={command.busy} onCancel={() => setOpen(false)} onOk={() => void command.send('/api/outsource/contents', { title, note, items: items.filter((item) => item.name.trim()) }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <div className="kgd-form"><span>标题 *</span><Input value={title} onChange={(event) => setTitle(event.target.value)} /><span>备注</span><Input placeholder="备注" value={note} onChange={(event) => setNote(event.target.value)} /></div>
      <p>删除检查项，将删除验收记录中对应字段的数据。</p>
      <Button onClick={() => setItems([...items, { name: '', field_type: '文本', required: false, description: '' }])}>新增检查项</Button>
      {items.map((item, index) => <div key={index} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Input placeholder="检查项" value={item.name} onChange={(event) => setItems(items.map((current, i) => i === index ? { ...current, name: event.target.value } : current))} />
        <Select style={{ width: 100 }} value={item.field_type} onChange={(value) => setItems(items.map((current, i) => i === index ? { ...current, field_type: value } : current))} options={['文本', '数字', '是否', '单选'].map((value) => ({ value, label: value }))} />
      </div>)}
    </Modal>
  </>;
}

export function OutOrderList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const navigate = useNavigate();
  const remote = useRemote<{ items: Rec[]; summary: { plan_qty: string } }>('/api/outsource/orders', revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    { key: 'code', title: '外协工单号', render: (row) => <Button type="link" onClick={() => navigate(`/OutWorkOrder/detail/${row.id}`)}>{row.code}</Button> },
    { key: 'plan', title: '计划数', render: (row) => dash(row.plan_qty) },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={row.status} /> },
    { key: 'product', title: '商品', render: (row) => dash(row.product_name) },
    { key: 'product_code', title: '商品编号', render: (row) => dash(row.product_code) },
    { key: 'spec', title: '商品规格', render: (row) => dash(row.product_spec) },
    { key: 'supplier', title: '供应商', render: (row) => dash(row.supplier_name) },
    { key: 'contact', title: '联系人', render: (row) => dash(row.contact_name) },
    { key: 'price', title: '外协单价(元)', render: (row) => dash(row.unit_price) },
    { key: 'due', title: '交货日期', render: (row) => dash(row.due_date) },
    { key: 'priority', title: '优先级', render: (row) => dash(row.priority) },
    { key: 'issue', title: '生产出库', render: (row) => <Button type="link" onClick={() => navigate(`/production_out_of_storage/list?add=outsource&order_id=${row.id}`)}>出库</Button> },
    { key: 'in', title: '成品入库', render: (row) => <Button type="link" onClick={() => navigate(`/produce_stock_in_bill/list?add=outsource&order_id=${row.id}`)}>入库</Button> },
    { key: 'ret', title: '生产退料', render: (row) => <Button type="link" onClick={() => navigate(`/produce_return_materiel_bill/list?add=outsource&order_id=${row.id}`)}>退料</Button> },
    { key: 'progress', title: '验收进度', render: (row) => dash(row.accept_progress) },
    { key: 'actions', title: '操作', width: 220, render: (row) =>     <span onClick={(event) => event.stopPropagation()}>
      <Button type="link" onClick={() => void command.send(`/api/outsource/orders/${row.id}/actions`, { action: '开始' }).then(() => message.success('已开始')).catch((error) => message.error(showError(error)))}>开始</Button>
      {row.status === '生产中' && <Button type="link" onClick={() => void command.send(`/api/outsource/orders/${row.id}/actions`, { action: '完成' }).then(() => message.success('已完成')).catch((error) => message.error(showError(error)))}>完成</Button>}
      <Button type="link" onClick={() => navigate(`/OutWorkOrder/edit/${row.id}`)}>修改</Button>
      <Button type="link" onClick={() => void command.send(`/api/outsource/orders/${row.id}/actions`, { action: '复制' }).then(() => message.success('已复制')).catch((error) => message.error(showError(error)))}>复制</Button>
      <Button type="link" onClick={() => { if (!printDocs([{ title: '外协工单', fields: [['外协工单号', row.code], ['商品', row.product_name], ['计划数', row.plan_qty], ['状态', row.status], ['供应商', row.supplier_name]] }])) message.error('无法打开打印窗口'); }}>打印</Button>
    </span> },
  ];
  return <ListFrame pageKey="os-order" showMobileCard columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'code', label: '外协工单号' }, { key: 'product', label: '商品' }, { key: 'supplier', label: '供应商' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage}
    toolbar={<Button type="primary" onClick={() => navigate('/OutWorkOrder/add')}>新增</Button>}
    summary={<RedSummary parts={[['总计划数', remote.data?.summary.plan_qty ?? '0']]} />} />;
}

export function OutOrderForm({ id }: { id?: string }) {
  const { revision, onExpired, session } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const navigate = useNavigate();
  const current = useRemote<{ order: Rec }>(id ? `/api/outsource/orders/${id}` : null, revision, onExpired);
  const products = useRemote<{ items: { id: string; code: string; name: string }[] }>('/api/products', revision, onExpired);
  const suppliers = useRemote<{ items: { id: string; name: string; code: string }[] }>('/api/money/suppliers', revision, onExpired);
  const order = current.data?.order;
  const prefill = new URLSearchParams(window.location.search);
  const planAnalysisId = id ? '' : prefill.get('plan_analysis_id') ?? '';
  const [code, setCode] = useState('');
  const [productId, setProductId] = useState(id ? '' : prefill.get('product_id') ?? '');
  const [plan, setPlan] = useState(id ? '1' : prefill.get('qty') || '1');
  const [supplierId, setSupplierId] = useState('');
  const [contact, setContact] = useState('');
  const [address, setAddress] = useState('');
  const [price, setPrice] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState('正常');
  const [note, setNote] = useState('');
  const ready = !id || !!order;
  const value = (local: string, remote: string | undefined) => (id && local === '' && remote ? remote : local);
  async function save() {
    if (!value(productId, order?.product_id)) { message.error('请选择商品'); return; }
    if (!String(value(plan, order?.plan_qty) || plan).trim()) { message.error('请填写计划数'); return; }
    const body = { code: value(code, order?.code), product_id: value(productId, order?.product_id), plan_qty: value(plan, order?.plan_qty) || plan, supplier_id: value(supplierId, order?.supplier_id), contact_name: value(contact, order?.contact_name), address: value(address, order?.address), unit_price: value(price, order?.unit_price), due_date: value(due, order?.due_date), priority: value(priority, order?.priority) || '正常', note: value(note, order?.note) };
    try {
      const saved = id ? await command.send<{ order: Rec }>(`/api/outsource/orders/${id}`, body, 'PATCH') : await command.send<{ order: Rec }>('/api/outsource/orders', body);
      if (planAnalysisId && saved?.order.id) {
        try { await apiRequest(`/api/material-analysis/${planAnalysisId}/link`, { method: 'POST', csrfToken: session.csrf_token, body: { kind: 'outsource', order_id: saved.order.id } }); }
        catch (failure) { message.warning(`外协工单已保存，但关联物料分析失败：${showError(failure)}`); }
      }
      message.success('已保存');
      navigate(`/OutWorkOrder/detail/${saved?.order.id ?? id}`);
    } catch (error) { message.error(showError(error)); }
  }
  return <div className="kgd-card">
    <h2>{id ? '修改外协工单' : '新增外协工单'}</h2>
    {!ready ? <p>加载中</p> : <div className="kgd-form">
      <span>外协工单号</span><Input placeholder="请填写，忽略将自动生成" value={value(code, order?.code)} onChange={(event) => setCode(event.target.value)} disabled={!!id} />
      <span>商品 *</span><Select showSearch optionFilterProp="label" placeholder="选择商品" value={value(productId, order?.product_id) || undefined} onChange={setProductId} options={(products.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
      <span>计划数 *</span><Input value={value(plan, order?.plan_qty)} onChange={(event) => setPlan(event.target.value)} />
      <span>供应商</span><Select allowClear showSearch optionFilterProp="label" value={value(supplierId, order?.supplier_id) || undefined} onChange={(value) => setSupplierId(value ?? '')} options={(suppliers.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.code}-${item.name}` }))} />
      <span>联系人</span><Input value={value(contact, order?.contact_name)} onChange={(event) => setContact(event.target.value)} />
      <span>供应商地址</span><Input value={value(address, order?.address)} onChange={(event) => setAddress(event.target.value)} />
      <span>外协单价</span><Input value={value(price, order?.unit_price)} onChange={(event) => setPrice(event.target.value)} />
      <span>交货日期</span><DatePicker style={{ width: '100%' }} value={(() => { const text = String(value(due, order?.due_date) ?? '').slice(0, 10); return text ? dayjs(text) : null; })()} onChange={(next) => setDue(next ? next.format('YYYY-MM-DD') : '')} />
      <span>优先级</span><Select value={value(priority, order?.priority) || '正常'} onChange={setPriority} options={['加急', '正常', '延期'].map((item) => ({ value: item, label: item }))} />
      <span>备注</span><Input maxLength={255} value={value(note, order?.note)} onChange={(event) => setNote(event.target.value)} />
    </div>}
    <div className="kgd-actions"><Button onClick={() => navigate('/OutWorkOrder/list')}>取消</Button><Button type="primary" loading={command.busy} onClick={() => void save()}>保存</Button></div>
  </div>;
}

export function OutOrderDetail({ id }: { id: string }) {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const navigate = useNavigate();
  const remote = useRemote<{ order: Rec }>(`/api/outsource/orders/${id}`, revision, onExpired);
  const products = useRemote<{ items: { id: string; name: string }[] }>('/api/products', revision, onExpired);
  const order = remote.data?.order;
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  if (remote.loading || !order) return <div className="kgd-card"><p>{remote.error || '加载中'}</p></div>;
  const fields: [string, string][] = [['商品编号', order.product_code], ['商品', order.product_name], ['商品规格', order.product_spec], ['计划数', order.plan_qty], ['状态', order.status], ['供应商', order.supplier_name], ['联系人', order.contact_name], ['地址', order.address], ['外协单价(元)', order.unit_price], ['交货日期', order.due_date], ['优先级', order.priority], ['验收进度', order.accept_progress], ['备注', order.note]];
  return <div className="kgd-card">
    <div className="kgd-toolbar">
      <Button onClick={() => navigate('/OutWorkOrder/list')}>返回</Button>
      <Button onClick={() => navigate(`/OutWorkOrder/edit/${id}`)}>修改</Button>
      <Button onClick={() => void command.send(`/api/outsource/orders/${id}/actions`, { action: '复制' }).then((result) => navigate(`/OutWorkOrder/detail/${(result as { order: Rec }).order.id}`)).catch((error) => message.error(showError(error)))}>复制</Button>
      <Button onClick={() => { setCancelReason(''); setCancelOpen(true); }}>取消</Button>
      <Button onClick={() => {
        const ok = printDocs([{
          title: '外协工单',
          fields: [['外协工单号', order.code], ['商品编号', order.product_code], ['商品', order.product_name], ['商品规格', order.product_spec], ['计划数', order.plan_qty], ['状态', order.status], ['供应商', order.supplier_name], ['联系人', order.contact_name], ['外协单价(元)', order.unit_price], ['交货日期', order.due_date], ['优先级', order.priority], ['备注', order.note]],
          columns: ['商品名', '编号', '单位用量'],
          rows: (order.materials ?? []).map((item) => [item.product_name, item.product_code, item.unit_qty]),
        }]);
        if (!ok) message.error('无法打开打印窗口');
      }}>打印外协工单</Button>
    </div>
    <h2>外协工单详情</h2>
    <div className="kgd-form">{fields.map(([label, value]) => <span key={label}>{label}：{dash(value)}</span>)}
      <span>生产出库</span><Button type="link" onClick={() => navigate(`/production_out_of_storage/list?add=outsource&order_id=${id}`)}>出库</Button>
      <span>成品入库</span><Button type="link" onClick={() => navigate(`/produce_stock_in_bill/list?add=outsource&order_id=${id}`)}>入库</Button>
      <span>生产退料</span><Button type="link" onClick={() => navigate(`/produce_return_materiel_bill/list?add=outsource&order_id=${id}`)}>退料</Button>
    </div>
    <h3>用料清单</h3>
    <div className="kgd-toolbar">
      <Select style={{ width: 220 }} placeholder="商品" value={productId || undefined} onChange={setProductId} options={(products.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
      <Input style={{ width: 120 }} value={qty} onChange={(event) => setQty(event.target.value)} />
      <Button onClick={() => void command.send(`/api/outsource/orders/${id}/materials`, { product_id: productId, unit_qty: qty }).then(() => message.success('已添加')).catch((error) => message.error(showError(error)))}>新增用料清单</Button>
    </div>
    <Modal title="取消外协工单" open={cancelOpen} okText="确定" cancelText="取消" confirmLoading={command.busy} onCancel={() => setCancelOpen(false)} onOk={() => {
      if (!cancelReason.trim()) { message.error('请填写取消原因'); return; }
      void command.send(`/api/outsource/orders/${id}/actions`, { action: '取消', reason: cancelReason.trim() }).then(() => { setCancelOpen(false); message.success('已取消'); }).catch((error) => message.error(showError(error)));
    }}>
      <div className="kgd-form"><span>取消原因 *</span><Input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} /></div>
    </Modal>
    <ListFrame pageKey="os-materials" columns={[
      { key: 'seq', title: '序号', render: (_row, index) => (index ?? 0) + 1 },
      { key: 'name', title: '商品名', render: (row) => dash(row.product_name) },
      { key: 'code', title: '编号', render: (row) => dash(row.product_code) },
      { key: 'spec', title: '规格', render: () => '-' },
      { key: 'source', title: '商品来源', render: () => '-' },
      { key: 'in_process', title: '入库工序', render: () => '-' },
      { key: 'image', title: '图片', render: () => '-' },
      { key: 'qty', title: '单位用量', render: (row) => dash(row.unit_qty) },
      { key: 'cost', title: '成本单价(元)', render: () => '-' },
      { key: 'amount', title: '成本金额(元)', render: () => '-' },
      { key: 'unit', title: '单位', render: () => '-' },
      { key: 'bom', title: '引用BOM', render: () => '-' },
      { key: 'note', title: '备注', render: () => '-' },
      { key: 'prod_qty', title: '生产用量', render: () => '-' },
      { key: 'actions', title: '操作', render: () => '-' },
    ]} rows={order.materials ?? []} queryFields={[{ key: 'q', label: '商品' }]} queryValue={{}} onQuery={() => undefined} onSearch={() => undefined} onClear={() => undefined} page={1} pageSize={20} total={order.materials?.length ?? 0} onPage={() => undefined} />
  </div>;
}

export function OutReceiptList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/outsource/receipts', revision, onExpired);
  const orders = useRemote<{ items: Rec[] }>('/api/outsource/orders', revision, onExpired);
  const contents = useRemote<{ items: Rec[] }>('/api/outsource/contents', revision, onExpired);
  const [pick, setPick] = useState(false);
  const [order, setOrder] = useState<Rec | null>(null);
  const [pass, setPass] = useState('');
  const [fail, setFail] = useState('0');
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const columns: ListColumn<Rec>[] = [
    { key: 'order', title: '加工单/外协工单', render: (row) => dash(row.order_code) },
    { key: 'kind', title: '外协类型', render: (row) => dash(row.kind) },
    { key: 'settle', title: '结算状态', render: (row) => <StatusTag text={row.settle_status} /> },
    { key: 'product', title: '商品', render: (row) => dash(row.product_name) },
    { key: 'supplier', title: '供应商', render: (row) => dash(row.supplier_name) },
    { key: 'accept', title: '验收数量', render: (row) => dash(row.accept_qty) },
    { key: 'pass', title: '合格数量', render: (row) => dash(row.pass_qty) },
    { key: 'fail', title: '不合格数量', render: (row) => dash(row.fail_qty) },
    { key: 'content', title: '验收内容', render: (row) => dash(row.content_title) },
    { key: 'inspector', title: '验收人', render: (row) => dash(row.inspector_name) },
    { key: 'actions', title: '操作', render: (row) => row.settle_status === '已结算' ? null : <Button type="link" onClick={() => void command.send(`/api/outsource/receipts/${row.id}`, {}, 'DELETE').then(() => message.success('已删除')).catch((error) => message.error(showError(error)))}>删除</Button> },
  ];
  return <>
    <ListFrame pageKey="os-receipt" showMobileCard columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'order', label: '加工单/外协工单' }, { key: 'product', label: '商品' }, { key: 'supplier', label: '供应商' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => setPick(true)}>外协工单验收</Button>} />
    <Modal title="选择外协工单" open={pick} footer={null} onCancel={() => setPick(false)} width={720}>
      <p>双击选中行数据！</p>
      {(orders.data?.items ?? []).filter((item) => item.status === '生产中' || item.status === '已完成').map((item) => <div key={item.id} style={{ padding: 8, cursor: 'pointer' }} onDoubleClick={() => { setOrder(item); setPick(false); }}>{item.code} {item.product_name} {item.accept_progress}</div>)}
    </Modal>
    <Modal title="验收" open={!!order} onCancel={() => setOrder(null)} okText="确定" cancelText="取消" confirmLoading={command.busy} onOk={() => void command.send('/api/outsource/receipts', { order_id: order?.id, pass_qty: pass, fail_qty: fail || '0', content_id: content, note }).then(() => { setOrder(null); message.success('已验收'); }).catch((error) => message.error(showError(error)))}>
      <div className="kgd-form">
        <span>外协工单 *</span><Input disabled value={order?.code} />
        <span>供应商</span><Input disabled value={dash(order?.supplier_name)} />
        <span>合格数量 *</span><Input value={pass} onChange={(event) => setPass(event.target.value)} />
        <span>不合格数量 *</span><Input value={fail} onChange={(event) => setFail(event.target.value)} />
        <span>选择验收内容</span><Select allowClear placeholder="请选择验收内容" value={content || undefined} onChange={setContent} options={(contents.data?.items ?? []).map((item) => ({ value: item.id, label: item.title }))} />
        <span>备注</span><Input maxLength={255} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
    </Modal>
  </>;
}

export function OutSettlementList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const status = list.chips.status || '全部';
  const remote = useRemote<{ items: Rec[]; cards: { unsettled_count: number; unsettled_amount: string; recent_count: number; recent_amount: string }; summary: { accept: string; pass: string; fail: string } }>('/api/outsource/receipts', revision, onExpired);
  const rows = (remote.data?.items ?? []).filter((row) => status === '全部' || row.settle_status === status);
  const cards = remote.data?.cards;
  const columns: ListColumn<Rec>[] = [
    { key: 'supplier', title: '供应商', render: (row) => dash(row.supplier_name) },
    { key: 'kind', title: '外协类型', render: (row) => dash(row.kind) },
    { key: 'settle', title: '结算状态', render: (row) => <StatusTag text={row.settle_status} /> },
    { key: 'order', title: '加工单号/外协工单号', render: (row) => dash(row.order_code) },
    { key: 'product', title: '商品', render: (row) => dash(row.product_name) },
    { key: 'accept', title: '验收数量', render: (row) => dash(row.accept_qty) },
    { key: 'pass', title: '合格数量', render: (row) => dash(row.pass_qty) },
    { key: 'fail', title: '不合格数量', render: (row) => dash(row.fail_qty) },
    { key: 'price', title: '单价', render: (row) => dash(row.unit_price) },
    { key: 'amount', title: '结算金额', render: (row) => dash(row.settle_amount) },
    { key: 'actions', title: '操作', render: (row) => row.settle_status === '已结算' ? null : <Button type="link" onClick={() => void command.send(`/api/outsource/receipts/${row.id}/settle`, { amount: String(Number(row.pass_qty) * Number(row.unit_price) || 0) }).then(() => message.success('已结算')).catch((error) => message.error(showError(error)))}>结算</Button> },
  ];
  return <div>
    <div className="kgd-toolbar">
      <span>未结算数量 {cards?.unsettled_count ?? 0}</span>
      <span>未结算费用 {cards?.unsettled_amount ?? '0'}</span>
      <span>近30天已结算数量 {cards?.recent_count ?? 0}</span>
      <span>近30天已结算费用 {cards?.recent_amount ?? '0'}</span>
    </div>
    <p>外协工单/外协任务验收完成后，在此页面进行进行结算。</p>
    <ListFrame pageKey="os-settle" columns={columns} rows={rows} loading={remote.loading} error={remote.error}
      chips={[{ key: 'status', label: '结算状态', options: ['全部', '已结算', '未结算'].map((item) => ({ value: item, label: item })) }, { key: 'kind', label: '外协类型', options: [{ value: '全部', label: '全部' }, { value: '工单外协', label: '工单外协' }, { value: '任务外协', label: '任务外协' }] }]}
      chipValue={{ status, kind: '工单外协' }} onChip={list.onChip}
      queryFields={[{ key: 'supplier', label: '供应商' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      summary={<RedSummary parts={[['验收总数', remote.data?.summary.accept ?? '0'], ['合格总数', remote.data?.summary.pass ?? '0'], ['不合格总数', remote.data?.summary.fail ?? '0']]} />} />
  </div>;
}
