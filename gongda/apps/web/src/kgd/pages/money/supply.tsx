import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Dropdown, Form, Input, Modal, Select, Table, Tabs } from 'antd';
import { App } from 'antd';
import dayjs from 'dayjs';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { ListFrame } from '../../ListFrame';
import { useExtForm, useExtList } from '../../extensions/bind';
import { printDoc, printDocs, recordDoc, type PrintDoc } from '../../print';
import { PurchaseInboundDialog, PurchaseInboundLink, PurchaseReturnLink } from '../warehouse/router';
import { confirmText, showError, StatusTag, useQueryState, beijingTime } from '../../kit';
import { AuditDetailModal } from '../audit/AuditDetailModal';
import { BatchAuditModal } from '../audit/BatchAuditModal';
import { auditChipOptions, useAuditCounts } from '../audit/auditChips';
import { blankLine, codePlaceholder, DayField, type DraftLine, FileDrop, LineTable, MemberSelect, openAudit, type Rec, RegionSelect, searchPlaceholder, SummaryBar, toPayload, useMoney } from './shared';
import { sumMoney } from './math';
import { requestKey } from '../../../requestKey';

export function SupplierList() {
  const { message } = App.useApp();
  const money = useMoney();
  const query = useQueryState();
  const [open, setOpen] = useState<Rec | true | null>(null);
  const [goods, setGoods] = useState<Rec | null>(null);
  const extList = useExtList('supplier');
  const remote = useRemote<{ items: Rec[] }>(`/api/money/suppliers?q=${encodeURIComponent(query.query.q ?? '')}`, money.revision, money.onExpired);
  const rows = (remote.data?.items ?? []).filter((row) => {
    const q = query.query;
    if (q.code && !String(row.code).includes(q.code)) return false;
    if (q.name && !String(row.name).includes(q.name)) return false;
    if (q.company && !String(row.company_name).includes(q.company)) return false;
    return true;
  });
  return <>
    <ListFrame pageKey="supplier-list" showMobileCard rows={rows} loading={remote.loading} error={remote.error} page={query.page} pageSize={query.pageSize} total={rows.length} onPage={query.onPage}
      {...extList.props}
      queryFields={[{ key: 'code', label: '供应商编号' }, { key: 'name', label: '供应商名称' }, { key: 'company', label: '企业名称' }, { key: 'q', label: '联系人' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
      toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>}
      rowSelection={{ selected: [], onChange: () => undefined }}
      columns={[
        { key: 'code', title: '供应商编号', render: (row) => row.code },
        { key: 'name', title: '供应商名称', render: (row) => row.name },
        { key: 'company', title: '企业名称', render: (row) => row.company_name },
        { key: 'credit', title: '统一社会信用代码', render: (row) => row.credit_code },
        { key: 'contact', title: '联系人', render: (row) => row.contact_name },
        { key: 'phone', title: '联系人电话', render: (row) => row.contact_phone },
        { key: 'owner', title: '负责人', render: (row) => row.owner_name },
        { key: 'address', title: '地址', render: (row) => [row.region, row.address].filter(Boolean).join(' ') },
        { key: 'tags', title: '供应商标签', render: (row) => (row.tags ?? []).join('、') },
        { key: 'level', title: '级别', render: (row) => row.level },
        { key: 'note', title: '备注', render: (row) => row.remark },
        { key: 'creator', title: '创建人', render: (row) => row.creator_name },
        { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at ?? '', '') },
        { key: 'actions', title: '操作', render: (row) => <span><button className="kgd-link" onClick={() => setOpen(row)}>修改</button> <button className="kgd-link" onClick={() => setGoods(row)}>关联采购商品</button> <button className="kgd-link" onClick={() => confirmText('删除供应商', '确定删除该供应商？', () => void money.send(`/api/money/suppliers/${row.id}`, {}, 'DELETE').catch((error) => message.error(showError(error))))}>删除</button></span> },
      ]} />
    {open && <SupplierModal row={open === true ? null : open} onClose={() => setOpen(null)} />}
    {extList.dialog}
    {goods && <SupplierGoods row={goods} onClose={() => setGoods(null)} />}
  </>;
}

function SupplierModal({ row, onClose }: { row: Rec | null; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const tags = useRemote<{ supplier_tags: Rec[] }>('/api/money/settings', money.revision, money.onExpired);
  const extForm = useExtForm('supplier', row?.id);
  const [form, setForm] = useState<Rec>({ id: row?.id ?? '', code: '', name: '', company_name: '', credit_code: '', owner_id: money.session.user.id, contact_name: '', contact_phone: '', region: '', address: '', tags: [], level: '', remark: '', ...row });
  function set(key: string, value: unknown) { setForm({ ...form, [key]: value }); }
  const [phoneError, setPhoneError] = useState('');
  async function save() {
    if (!String(form.name ?? '').trim()) { message.error('请填写供应商名称'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    setPhoneError('');
    try {
      const saved = await money.send<{ supplier?: { id?: string } }>(row ? `/api/money/suppliers/${row.id}` : '/api/money/suppliers', { request_key: requestKey(), ...form }, row ? 'PATCH' : 'POST');
      const recordId = row?.id ?? saved?.supplier?.id ?? '';
      if (recordId) await extForm.persist(money.session.csrf_token, recordId);
      message.success('已保存');
      onClose();
    } catch (error) {
      const text = showError(error);
      message.error(text);
      if (text.includes('供应商手机号已存在')) setPhoneError(text);
      // 理由：拒绝关闭弹窗，并让 form help / message 保留「供应商手机号已存在」给验收定位
      return Promise.reject(error);
    }
  }
  return <Modal title={row ? '修改供应商' : '新增供应商'} open width={720} onCancel={onClose} onOk={save} okText="确定" cancelText="取消" confirmLoading={money.busy}>
    <Form layout="vertical">
      <Form.Item label="供应商编号"><Input value={form.code} placeholder={codePlaceholder} onChange={(event) => set('code', event.target.value)} /></Form.Item>
      <Form.Item label="供应商名称" required><Input value={form.name} onChange={(event) => set('name', event.target.value)} /></Form.Item>
      <Form.Item label="企业名称"><Input value={form.company_name} onChange={(event) => set('company_name', event.target.value)} /></Form.Item>
      <Form.Item label="统一社会信用代码"><Input value={form.credit_code} onChange={(event) => set('credit_code', event.target.value)} /></Form.Item>
      <Form.Item label="负责人"><MemberSelect value={form.owner_id} revision={money.revision} onChange={(id) => set('owner_id', id)} /></Form.Item>
      <Form.Item label="联系人"><Input value={form.contact_name} onChange={(event) => set('contact_name', event.target.value)} /></Form.Item>
      <Form.Item label="联系人电话" validateStatus={phoneError ? 'error' : undefined} help={phoneError || undefined}>
        <Input value={form.contact_phone} onChange={(event) => { setPhoneError(''); set('contact_phone', event.target.value); }} />
      </Form.Item>
      <Form.Item label="地区"><RegionSelect value={form.region} onChange={(value) => set('region', value)} /></Form.Item>
      <Form.Item label="详细地址"><Input value={form.address} onChange={(event) => set('address', event.target.value)} /></Form.Item>
      <Form.Item label="供应商标签"><Select mode="multiple" value={form.tags} options={(tags.data?.supplier_tags ?? []).map((tag) => ({ value: tag.name, label: tag.name }))} onChange={(value) => set('tags', value)} /></Form.Item>
      <Form.Item label="级别"><Select allowClear placeholder="暂无数据" notFoundContent="暂无数据" options={[]} /></Form.Item>
      <Form.Item label="附件"><FileDrop value="" onChange={() => undefined} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea value={form.remark} onChange={(event) => set('remark', event.target.value)} /></Form.Item>
      {extForm.node}
    </Form>
  </Modal>;
}
function SupplierGoods({ row, onClose }: { row: Rec; onClose: () => void }) {
  const money = useMoney();
  const remote = useRemote<{ items: Rec[] }>(`/api/money/suppliers/${row.id}/products`, money.revision, money.onExpired);
  return <Modal title={`关联采购商品【${row.name}】`} open width={720} footer={<Button onClick={onClose}>关闭</Button>} onCancel={onClose}><Table size="small" rowKey="id" locale={{ emptyText: '暂无数据' }} dataSource={remote.data?.items ?? []} columns={[{ title: '商品编号', dataIndex: 'code' }, { title: '商品名', dataIndex: 'name' }, { title: '规格', dataIndex: 'specification' }, { title: '来源', dataIndex: 'source' }]} /></Modal>;
}

export function PlanList() {
  const { message } = App.useApp();
  const money = useMoney();
  const query = useQueryState();
  const [open, setOpen] = useState<Rec | true | null>(null);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('add')) setOpen(true); }, []);
  const extList = useExtList('purchase_plan');
  const remote = useRemote<{ items: Rec[] }>('/api/money/purchase-plans', money.revision, money.onExpired);
  const rows = (remote.data?.items ?? []).filter((row) => !query.query.q || `${row.code}${row.name}${row.supplier_name}`.includes(query.query.q));
  return <>
    <ListFrame pageKey="plan-list" showMobileCard rows={rows} loading={remote.loading} error={remote.error} page={query.page} pageSize={query.pageSize} total={rows.length} onPage={query.onPage}
      {...extList.props}
      queryFields={[{ key: 'q', label: '计划编号' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
      toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>}
      columns={[
        { key: 'code', title: '计划编号', render: (row) => <span>{row.code}{row.overdue_days > 0 && <b className="kgd-overdue-mark">逾{row.overdue_days}天</b>}</span> },
        { key: 'name', title: '计划名称', render: (row) => row.name },
        { key: 'amount', title: '金额', render: (row) => row.amount },
        { key: 'qty', title: '采购数量', render: (row) => row.qty },
        { key: 'supplier', title: '供应商', render: (row) => row.supplier_name },
        { key: 'progress', title: '采购进度', render: (row) => row.purchase_progress },
        { key: 'delivery', title: '交货日期', render: (row) => row.delivery_date },
        { key: 'approval', title: '审核状态', render: (row) => <StatusTag text={row.approval_text} /> },
        { key: 'audit', title: '审核详情', render: () => <button className="kgd-link" onClick={() => openAudit([])}>查看</button> },
        { key: 'note', title: '备注', render: (row) => row.note },
        { key: 'creator', title: '创建人', render: (row) => row.creator_name },
        { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at ?? '', '') },
        { key: 'actions', title: '操作', render: (row) => <span><button className="kgd-link" onClick={() => setOpen(row)}>采购明细</button> <button className="kgd-link" onClick={() => printDoc(recordDoc('采购计划', row, [['计划编号', 'code'], ['计划名称', 'name'], ['供应商', 'supplier_name'], ['金额', 'amount'], ['采购数量', 'qty'], ['交货日期', 'delivery_date'], ['审核状态', 'approval_text'], ['创建人', 'creator_name'], ['备注', 'note']], { key: 'lines', columns: [['商品编号', 'product_code'], ['商品名', 'product_name'], ['规格', 'specification'], ['单位', 'unit_name'], ['单价', 'unit_price'], ['数量', 'quantity'], ['备注', 'note']] }))}>打印</button> <button className="kgd-link" onClick={() => setOpen(row)}>修改</button> <button className="kgd-link" onClick={() => confirmText('删除计划', '确定删除该采购计划？', () => void money.send(`/api/money/purchase-plans/${row.id}`, {}, 'DELETE').catch((error) => message.error(showError(error))))}>删除</button></span> },
      ]} />
    {open && <PlanModal row={open === true ? null : open} onClose={() => setOpen(null)} />}
    {extList.dialog}
  </>;
}

function PlanModal({ row, onClose }: { row: Rec | null; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const suppliers = useRemote<{ items: Rec[] }>('/api/money/suppliers', money.revision, money.onExpired);
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [supplierId, setSupplierId] = useState(row?.supplier_id ?? '');
  const [delivery, setDelivery] = useState(row?.delivery_date ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [lines, setLines] = useState<DraftLine[]>(() => (row?.lines ?? []).map((line: Rec) => blankLine({ ...(line as Record<string, unknown>), product_name: line.product_name, product_id: line.product_id })));
  const [bomOpen, setBomOpen] = useState(false);
  const extForm = useExtForm('purchase_plan', row?.id);
  async function save() {
    if (!name.trim()) { message.error('请填写计划名称'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await money.send<{ plan?: { id?: string } }>(row ? `/api/money/purchase-plans/${row.id}` : '/api/money/purchase-plans', { request_key: requestKey(), code, name, supplier_id: supplierId || null, delivery_date: delivery, note, lines: toPayload(lines), version: row?.version }, row ? 'PATCH' : 'POST');
      const recordId = row?.id ?? saved?.plan?.id ?? '';
      if (recordId) await extForm.persist(money.session.csrf_token, recordId);
      message.success('已保存');
      onClose();
    }
    catch (error) { message.error(showError(error)); }
  }
  return <Modal title={row ? '修改采购计划' : '新增采购计划'} open width={980} onCancel={onClose} onOk={save} okText="确定" cancelText="取消">
    <Form layout="vertical">
      <Form.Item label="计划编号"><Input value={code} placeholder={codePlaceholder} onChange={(event) => setCode(event.target.value)} /></Form.Item>
      <Form.Item label="计划名称" required><Input value={name} onChange={(event) => setName(event.target.value)} /></Form.Item>
      <Form.Item label="供应商"><Select showSearch allowClear optionFilterProp="label" placeholder={searchPlaceholder} value={supplierId || undefined} options={(suppliers.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setSupplierId(value ?? '')} /></Form.Item>
      <Form.Item label="金额"><Input disabled value={sumMoney(lines.map((line) => line.quantity && line.unit_price ? String(Number(line.quantity) * Number(line.unit_price)) : '0'))} /></Form.Item>
      <Form.Item label="交货日期"><DayField value={delivery} onChange={setDelivery} /></Form.Item>
      <Form.Item label="采购数量"><Input disabled value={sumMoney(lines.map((line) => line.quantity || '0'))} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
      {extForm.node}
    </Form>
    <LineTable mode="plan" lines={lines} onChange={setLines} formula="${合同明细.单价}*${合同明细.销售数量}" scale={8} tip="单价*数量" extra={<Button onClick={() => setBomOpen(true)}>+ 按BOM选择商品</Button>} />
    {bomOpen && <BomPick onClose={() => setBomOpen(false)} onPick={(next) => setLines([...lines, ...next])} />}
  </Modal>;
}

export function BomPick({ onClose, onPick }: { onClose: () => void; onPick: (lines: DraftLine[]) => void }) {
  const money = useMoney();
  const remote = useRemote<{ items: Rec[] }>('/api/boms', money.revision, money.onExpired);
  const [id, setId] = useState('');
  async function ok() {
    const bom = remote.data?.items.find((item) => item.id === id);
    if (!bom) return;
    const result = await import('../../../api').then(({ apiRequest }) => apiRequest<{ requirements: Rec[] }>(`/api/boms/${id}/explosion?quantity=1`));
    onPick((result.requirements ?? []).map((item) => blankLine({ product_id: item.product_id, product_name: item.name, product_code: item.code, unit_name: item.unit_name, quantity: String(item.quantity) })));
    onClose();
  }
  return <Modal title="按BOM选择商品" open onCancel={onClose} onOk={ok} okText="确定" cancelText="取消"><Select style={{ width: '100%' }} placeholder="选择BOM" options={(remote.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.product_code ?? item.code ?? ''} ${item.product_name ?? item.name ?? ''}` }))} onChange={setId} /></Modal>;
}

export function PurchaseList() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const money = useMoney();
  const query = useQueryState();
  const [open, setOpen] = useState<Rec | true | null>(null);
  const addSearch = useLocation().search;
  useEffect(() => { if (new URLSearchParams(addSearch).get('add')) setOpen(true); }, [addSearch]);
  const [pay, setPay] = useState<Rec | null>(null);
  const [batch, setBatch] = useState<Rec[] | null>(null);
  const [batchInvoice, setBatchInvoice] = useState<Rec[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [auditId, setAuditId] = useState('');
  const [auditBatch, setAuditBatch] = useState(false);
  const counts = useAuditCounts('purchase_order', money.revision, money.onExpired);
  const approver = useRemote<{ approver: boolean }>('/api/audit/approver?object_type=purchase_order', money.revision, money.onExpired);
  const extList = useExtList('purchase_order');
  const remote = useRemote<{ items: Rec[]; summary: Rec }>(`/api/money/purchase-orders?code=${encodeURIComponent(query.query.code ?? '')}&supplier=${encodeURIComponent(query.query.supplier ?? '')}&q=${encodeURIComponent(query.query.q ?? '')}&overdue=${query.chips.overdue ?? 'all'}&approval=${query.chips.approval ?? 'all'}`, money.revision, money.onExpired);
  const rows = remote.data?.items ?? [];
  const picked = rows.filter((row) => selected.includes(row.id));
  return <>
    <ListFrame pageKey="purchase-list" showMobileCard rows={rows} loading={remote.loading} error={remote.error} page={query.page} pageSize={query.pageSize} total={rows.length} onPage={query.onPage}
      {...extList.props}
      queryFields={[{ key: 'q', label: '商品', placeholder: '商品名/简拼/编号/规格' }, { key: 'code', label: '采购单号' }, { key: 'supplier', label: '供应商' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
      chips={[{ key: 'approval', label: '审核状态', options: auditChipOptions(counts.data) }, { key: 'overdue', label: '是否逾期', options: [{ value: 'all', label: '全部' }, { value: 'yes', label: '逾期' }, { value: 'no', label: '未逾期' }] }]} chipValue={query.chips} onChip={query.onChip}
      summary={<SummaryBar parts={[['采购总数', remote.data?.summary.qty ?? '0'], ['采购金额', remote.data?.summary.amount ?? '0'], ['入库金额', remote.data?.summary.inbound ?? '0'], ['退货金额', remote.data?.summary.returned ?? '0'], ['欠款', remote.data?.summary.debt ?? '0']]} />}
      rowSelection={{ selected, onChange: setSelected }}
      toolbar={<>
        <Button type="primary" onClick={() => setOpen(true)}>新增</Button>
        <Button onClick={() => {
          const target = rows.find((row) => selected.includes(row.id));
          if (!target) { message.warning('请先勾选采购单'); return; }
          setPay(target);
        }}>付款</Button>
        <Dropdown disabled={!picked.length} menu={{ items: [
          ...(approver.data?.approver ? [{ key: 'audit', label: '批量审核', onClick: () => setAuditBatch(true) }] : []),
          { key: 'pay', label: '批量付款', onClick: () => setBatch(picked) },
          { key: 'invoice', label: '批量开票', onClick: () => setBatchInvoice(picked) },
          { key: 'delete', label: '批量删除', onClick: () => confirmText('批量删除', '确定删除所选采购单？', () => void Promise.all(picked.map((row) => money.send(`/api/money/purchase-orders/${row.id}/actions`, { action: 'delete' }))).catch((error) => message.error(showError(error)))) },
          { key: 'print', label: '批量打印采购单', onClick: () => printDocs(picked.map(purchaseDoc), '采购单') },
        ] }}><Button disabled={!picked.length}>批量操作 ▾</Button></Dropdown>
      </>}
      columns={[
        { key: 'code', title: '采购单号', render: (row) => <button className="kgd-link" onClick={() => navigate(`/purchase_order/detail/${row.id}`)}>{row.code}{row.overdue_days > 0 && <b className="kgd-overdue-mark">逾{row.overdue_days}天</b>}</button> },
        { key: 'plan', title: '生产计划编号', render: (row) => row.lines?.[0]?.plan_code },
        { key: 'planName', title: '生产计划名', render: (row) => row.lines?.[0]?.plan_name },
        { key: 'supplier', title: '供应商', render: (row) => row.supplier_name },
        { key: 'amount', title: '金额', render: (row) => row.amount },
        { key: 'qty', title: '采购数量', render: (row) => row.qty },
        { key: 'inbound', title: '入库金额(元)', render: (row) => row.inbound_amount },
        { key: 'returned', title: '退货金额(元)', render: (row) => row.return_amount },
        { key: 'paid', title: '已付款(元)', render: (row) => row.paid },
        { key: 'debt', title: '欠款(元)', render: (row) => row.debt },
        { key: 'inProgress', title: '入库进度', render: (row) => row.inbound_progress },
        { key: 'payProgress', title: '付款进度', render: (row) => row.pay_progress },
        { key: 'invoiceProgress', title: '开票进度', render: (row) => row.invoice_progress },
        { key: 'due', title: '交货日期', render: (row) => row.due_date },
        { key: 'approval', title: '审核状态', render: (row) => <StatusTag text={row.approval_text} /> },
        { key: 'audit', title: '审核详情', render: (row) => <button className="kgd-link" onClick={() => setAuditId(String(row.id))}>查看</button> },
        { key: 'note', title: '备注', render: (row) => row.note },
        { key: 'returns', title: '采购退货', render: (row) => <PurchaseReturnLink orderId={String(row.id)} count={Number(row.return_count ?? 0)} /> },
        { key: 'receipts', title: '采购入库', render: (row) => <PurchaseInboundLink orderId={String(row.id)} count={Number(row.receipt_count ?? 0)} /> },
        { key: 'creator', title: '创建人', render: (row) => row.creator_name },
        { key: 'buyer', title: '采购人', render: (row) => row.buyer_name },
        { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at ?? '', '') },
        { key: 'actions', title: '操作', width: 220, render: (row) => <span>
          <button className="kgd-link" onClick={() => navigate(`/purchase_order/detail/${row.id}`)}>采购明细</button>
          <button className="kgd-link" onClick={() => setPay(row)}>付款</button>
          <button className="kgd-link" onClick={() => printDoc(purchaseDoc(row))}>打印</button>
          <button className="kgd-link" onClick={() => setOpen(row)}>修改</button>
          <button className="kgd-link" onClick={() => void money.send(`/api/money/purchase-orders/${row.id}/actions`, { action: 'copy' }).then(() => message.success('已复制')).catch((error) => message.error(showError(error)))}>复制</button>
          <button className="kgd-link" onClick={() => confirmText('删除采购单', '确定删除该采购单？', () => void money.send(`/api/money/purchase-orders/${row.id}/actions`, { action: 'delete' }).catch((error) => message.error(showError(error))))}>删除</button>
        </span> },
      ]} />
    {open && <PurchaseModal row={open === true ? null : open} analysisId={open === true ? new URLSearchParams(addSearch).get('plan_analysis_id') ?? '' : ''} onClose={() => setOpen(null)} />}
    {extList.dialog}
    {pay && <PayModal row={pay} onClose={() => setPay(null)} />}
    {batch && <BatchPay rows={batch} onClose={() => setBatch(null)} />}
    {batchInvoice && <BatchInvoice rows={batchInvoice} onClose={() => setBatchInvoice(null)} />}
    {auditId && <AuditDetailModal objectType="purchase_order" objectId={auditId} onClose={() => setAuditId('')} />}
    {auditBatch && <BatchAuditModal objectType="purchase_order" ids={picked.map((item) => String(item.id))} onClose={() => setAuditBatch(false)} />}
  </>;
}

function purchaseDoc(row: Rec): PrintDoc {
  const lines = (row.lines ?? []) as Rec[];
  return {
    title: '采购单',
    fields: [['采购单号', row.code], ['供应商', row.supplier_name], ['采购人', row.buyer_name], ['交货日期', row.due_date], ['金额', row.amount], ['采购数量', row.qty], ['审核状态', row.approval_text], ['创建人', row.creator_name], ['备注', row.note]].map(([label, value]) => [String(label), String(value ?? '')] as [string, string]),
    columns: ['序号', '商品编号', '商品名', '规格', '单位', '单价', '数量', '金额', '备注'],
    rows: lines.map((line, index) => [String(index + 1), line.product_code, line.product_name, line.specification, line.unit_name, line.unit_price, line.quantity, line.amount ?? line.net_amount, line.note].map((value) => String(value ?? ''))),
  };
}

function PurchaseModal({ row, analysisId = '', onClose }: { row: Rec | null; analysisId?: string; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const suppliers = useRemote<{ items: Rec[] }>('/api/money/suppliers', money.revision, money.onExpired);
  const plans = useRemote<{ items: Rec[] }>('/api/money/purchase-plans', money.revision, money.onExpired);
  const contracts = useRemote<{ items: Rec[] }>('/api/money/contracts', money.revision, money.onExpired);
  const [supplierId, setSupplierId] = useState(row?.supplier_id ?? '');
  const [buyer, setBuyer] = useState(row?.buyer_id ?? '');
  const [delivery, setDelivery] = useState(row?.due_date ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [code, setCode] = useState(row ? '' : '');
  const [lines, setLines] = useState<DraftLine[]>(() => (row?.lines ?? []).map((line: Rec) => blankLine(line as Record<string, unknown>)));
  const [pick, setPick] = useState<'plan' | 'contract' | null>(null);
  const [lineErr, setLineErr] = useState(false);
  const extForm = useExtForm('purchase_order', row?.id);
  async function save() {
    if (!toPayload(lines).length) { setLineErr(true); message.error('请至少添加一条明细'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    setLineErr(false);
    const body = { request_key: requestKey(), code: row ? row.code : code, supplier_id: supplierId, buyer_id: buyer || null, delivery_date: delivery, note, lines: toPayload(lines), version: row?.version };
    try {
      if (row) {
        await money.send(`/api/money/purchase-orders/${row.id}/actions`, { action: 'update', ...body });
        await extForm.persist(money.session.csrf_token, row.id);
      }
      else {
        const created = await money.send<{ purchase_order?: { id?: string } }>('/api/money/purchase-orders', body);
        if (created?.purchase_order?.id) await extForm.persist(money.session.csrf_token, created.purchase_order.id);
        const orderId = created?.purchase_order?.id;
        if (analysisId && orderId) {
          try { await apiRequest(`/api/material-analysis/${analysisId}/link`, { method: 'POST', csrfToken: money.session.csrf_token, body: { kind: 'purchase', order_id: orderId } }); }
          catch (error) { message.warning(`采购单已保存，但关联物料分析失败：${showError(error)}`); }
        }
      }
      message.success('已保存'); onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title={row ? '修改采购单' : '新增采购单'} open width={1080} onCancel={onClose} onOk={save} okText="保存" cancelText="取消" confirmLoading={money.busy}>
    <Form layout="vertical">
      <Form.Item label="采购单号"><Input value={row ? row.code : code} placeholder={codePlaceholder} disabled={!!row} onChange={(event) => setCode(event.target.value)} /></Form.Item>
      <Form.Item label="供应商"><Select showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={supplierId || undefined} options={(suppliers.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} onChange={setSupplierId} /></Form.Item>
      <Form.Item label="商品金额"><Input disabled value={sumMoney(lines.map((line) => line.unit_price && line.quantity ? String(Number(line.unit_price) * Number(line.quantity)) : '0'))} /></Form.Item>
      <Form.Item label="采购数量"><Input disabled value={sumMoney(lines.map((line) => line.quantity || '0'))} /></Form.Item>
      <Form.Item label="采购人"><MemberSelect value={buyer} revision={money.revision} onChange={setBuyer} /></Form.Item>
      <Form.Item label="交货日期"><DayField value={delivery} onChange={setDelivery} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
      {extForm.node}
    </Form>
    <div className={lineErr ? 'kgd-field-error' : undefined}>{lineErr ? <div className="kgd-field-help">请至少添加一条明细</div> : null}
    <LineTable mode="purchase" lines={lines} onChange={setLines} formula="${合同明细.单价}*${合同明细.销售数量}" scale={8} tip="单价*数量" extra={<><Button onClick={() => setPick('plan')}>+ 选择采购计划商品</Button><Button onClick={() => setPick('contract')}>+ 选择合同商品</Button></>} />
    </div>
    <Modal title={pick === 'plan' ? '选择采购计划商品' : '选择合同商品'} open={!!pick} onCancel={() => setPick(null)} footer={null} width={720}>
      {pick === 'plan' && (plans.data?.items ?? []).map((plan) => <div key={plan.id}><b>{plan.code} {plan.name}</b>{(plan.lines ?? []).map((line: Rec) => <div key={line.id}><button className="kgd-link" onClick={() => { setLines([...lines, blankLine({ ...line, plan_code: plan.code, plan_name: plan.name })]); setPick(null); }}>{line.product_name} × {line.quantity}</button></div>)}</div>)}
      {pick === 'contract' && (contracts.data?.items ?? []).map((item) => <div key={item.id}><b>{item.code}</b>{(item.lines ?? []).map((line: Rec) => <div key={line.id}><button className="kgd-link" onClick={() => { setLines([...lines, blankLine({ ...line, contract_id: item.id, contract_code: item.code })]); setPick(null); }}>{line.product_name} × {line.quantity}</button></div>)}</div>)}
    </Modal>
  </Modal>;
}

function PayModal({ row, onClose }: { row: Rec; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [note, setNote] = useState('');
  const [file, setFile] = useState('');
  const [amountErr, setAmountErr] = useState('');
  async function save() {
    if (!row.id) { message.error('请先勾选采购单'); return; }
    if (!amount.trim()) { setAmountErr('请填写付款金额'); message.error('请填写付款金额'); return; }
    setAmountErr('');
    if (!date) { message.error('请选择付款日期'); return; }
    try { await money.send(`/api/money/purchase-orders/${row.id}/pay`, { order_id: row.id, amount, pay_date: date, note, attachment: file }); message.success('已付款'); onClose(); }
    catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增采购付款" open onCancel={onClose} footer={<><Button onClick={onClose}>关闭</Button><Button onClick={save}>确 定</Button><Button type="primary" onClick={save}>提交</Button></>}>
    {amountErr ? <div className="kgd-banner kgd-field-error">{amountErr}</div> : null}
    <Form layout="vertical">
      <Form.Item label="待付款(元)"><Input disabled value={row.debt} /></Form.Item>
      <Form.Item label="供应商"><Input disabled value={row.supplier_name} /></Form.Item>
      <Form.Item label="付款金额" required validateStatus={amountErr ? 'error' : undefined} help={amountErr || undefined}><Input className={amountErr ? 'kgd-field-error' : undefined} value={amount} onChange={(event) => { setAmountErr(''); setAmount(event.target.value); }} /></Form.Item>
      <Form.Item label="付款日期" required><DayField value={date} onChange={setDate} /></Form.Item>
      <Form.Item label="附件"><FileDrop value={file} onChange={setFile} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea placeholder="备注" maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
    </Form>
  </Modal>;
}
function BatchPay({ rows, onClose }: { rows: Rec[]; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  async function save() {
    try { await money.send('/api/money/purchase-orders/batch-pay', { pay_date: date, lines: rows.map((row) => ({ id: row.id, amount: amounts[row.id] || '0' })) }); message.success('已付款'); onClose(); }
    catch (error) { message.error(showError(error)); }
  }
  return <Modal title="批量付款" open width={720} onCancel={onClose} onOk={save} okText="提交" cancelText="关闭"><DayField value={date} onChange={setDate} /><Table size="small" rowKey="id" dataSource={rows} columns={[{ title: '采购单号', dataIndex: 'code' }, { title: '待付款', dataIndex: 'debt' }, { title: '付款金额', render: (_: unknown, row: Rec) => <Input value={amounts[row.id] ?? ''} onChange={(event) => setAmounts({ ...amounts, [row.id]: event.target.value })} /> }]} /></Modal>;
}
function BatchInvoice({ rows, onClose }: { rows: Rec[]; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  async function save() {
    try { await money.send('/api/money/purchase-orders/batch-invoice', { lines: rows.map((row) => ({ id: row.id, amount: amounts[row.id] || '0', invoice_date: date })) }); message.success('已开票'); onClose(); }
    catch (error) { message.error(showError(error)); }
  }
  return <Modal title="批量开票" open width={720} onCancel={onClose} onOk={save} okText="提交" cancelText="关闭"><DayField value={date} onChange={setDate} /><Table size="small" rowKey="id" dataSource={rows} columns={[{ title: '采购单号', dataIndex: 'code' }, { title: '发票金额', render: (_: unknown, row: Rec) => <Input value={amounts[row.id] ?? ''} onChange={(event) => setAmounts({ ...amounts, [row.id]: event.target.value })} /> }]} /></Modal>;
}

export function PurchaseDetail() {
  const { pathname } = useLocation();
  const id = pathname.split('/detail/')[1]?.split(/[/?#]/)[0] ?? '';
  const navigate = useNavigate();
  const money = useMoney();
  const remote = useRemote<Rec>(id ? `/api/money/purchase-orders/${id}` : null, money.revision, money.onExpired);
  const receipts = useRemote<{ items: Rec[] }>(id ? `/api/warehouse/purchase-receipts?order_id=${id}` : null, money.revision, money.onExpired);
  const returns = useRemote<{ items: Rec[] }>(id ? `/api/warehouse/purchase-returns?order_id=${id}` : null, money.revision, money.onExpired);
  const order = remote.data?.purchase_order as Rec | undefined;
  const logs = (remote.data?.logs ?? []) as Rec[];
  const [pay, setPay] = useState(false);
  const [invoice, setInvoice] = useState(false);
  const [edit, setEdit] = useState(false);
  const [inboundOpen, setInboundOpen] = useState(false);
  if (!order) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : remote.error || '暂无数据'}</div>;
  return <div className="kgd-card">
    <div className="kgd-toolbar"><Button onClick={() => navigate('/purchase_order/list')}>返回</Button><Button onClick={() => setEdit(true)}>修改</Button><Button onClick={() => confirmText('删除', '确定删除该采购单？', () => void money.send(`/api/money/purchase-orders/${order.id}/actions`, { action: 'delete' }).then(() => navigate('/purchase_order/list')))}>删除</Button><span style={{ flex: 1 }} /><Button onClick={() => printDoc(purchaseDoc(order))}>打印采购单</Button></div>
    <h3>采购单({order.code})</h3>
    <dl className="kgd-detail-grid">
      {[['金额', order.amount], ['采购数量', order.qty], ['入库金额(元)', order.inbound_amount], ['退货金额(元)', order.return_amount], ['已付款(元)', order.paid], ['欠款(元)', order.debt], ['审核状态', order.approval_text], ['付款进度', order.pay_progress], ['开票进度', order.invoice_progress], ['入库进度', order.inbound_progress], ['供应商', order.supplier_name], ['交货日期', order.due_date], ['备注', order.note], ['采购人', order.buyer_name], ['创建人', order.creator_name]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <Tabs items={[
      { key: 'lines', label: '采购明细', children: <Table size="small" rowKey="id" dataSource={order.lines} locale={{ emptyText: '暂无数据' }} columns={['序号:line_no', '采购计划编号:plan_code', '采购计划名称:plan_name', '合同编号:contract_code', '商品名称:product_name', '商品编号:product_code', '商品规格:specification', '数量:quantity', '单价:unit_price', '金额:amount', '折扣:discount', '优惠金额:concession', '优惠后金额:net_amount', '供应商:supplier_name', '备注:note'].map(pair)} /> },
      { key: 'pay', label: '付款明细', children: <><Button type="primary" onClick={() => setPay(true)}>付款</Button><Table size="small" rowKey="id" dataSource={remote.data?.payments ?? []} locale={{ emptyText: '暂无数据' }} columns={[{ title: '供应商', dataIndex: 'supplier_name' }, { title: '金额', dataIndex: 'amount' }, { title: '备注', dataIndex: 'note' }, { title: '审核状态', dataIndex: 'approval_text' }, { title: '付款日期', dataIndex: 'pay_date' }, { title: '创建人', dataIndex: 'creator_name' }]} /></> },
      { key: 'invoice', label: '发票管理', children: <><Button onClick={() => setInvoice(true)}>开票</Button><Table size="small" rowKey="id" dataSource={remote.data?.invoices ?? []} locale={{ emptyText: '暂无数据' }} columns={[{ title: '供应商', dataIndex: 'supplier_name' }, { title: '发票金额(元)', dataIndex: 'amount' }, { title: '开票日期', dataIndex: 'invoice_date' }, { title: '备注', dataIndex: 'note' }, { title: '审核状态', dataIndex: 'approval_text' }]} /></> },
      { key: 'inbound', label: '采购入库', children: <>
        <div className="kgd-toolbar">
          <Button type="primary" onClick={() => setInboundOpen(true)}>+ 新增入库</Button>
          <Button onClick={() => navigate(`/purchase_stock_in_bill/list?order_id=${order.id}`)}>查看入库单</Button>
        </div>
        <Table size="small" rowKey="id" dataSource={receipts.data?.items ?? []} locale={{ emptyText: '暂无数据' }} columns={[
          { title: '采购入库单号', render: (_, row) => <button type="button" className="kgd-link" onClick={() => navigate(`/purchase_stock_in_bill/detail/${row.id}`)}>{row.code}</button> },
          { title: '入库日期', dataIndex: 'receipt_date' },
          { title: '审核状态', dataIndex: 'audit_status' },
          { title: '仓库', dataIndex: 'warehouse_name' },
        ]} />
        {inboundOpen && <PurchaseInboundDialog orderId={String(order.id)} onClose={() => setInboundOpen(false)} />}
      </> },
      { key: 'returnWh', label: '采购退货', children: <Table size="small" rowKey="id" dataSource={returns.data?.items ?? []} locale={{ emptyText: '暂无数据' }} columns={[{ title: '采购退货单号', dataIndex: 'code' }, { title: '退货日期', dataIndex: 'return_date' }, { title: '审核状态', dataIndex: 'audit_status' }, { title: '仓库', dataIndex: 'warehouse_id' }]} /> },
      { key: 'log', label: '日志', children: logs.length ? logs.map((row) => <div key={row.id}>{beijingTime(row.created_at, '')} {row.message}</div>) : <div>暂无数据</div> },
    ]} />
    {pay && <PayModal row={order} onClose={() => setPay(false)} />}
    {invoice && <InvoiceOnce row={order} onClose={() => setInvoice(false)} />}
    {edit && <PurchaseModal row={order} onClose={() => setEdit(false)} />}
  </div>;
}
function InvoiceOnce({ row, onClose }: { row: Rec; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  async function save() { if (!amount.trim()) { message.error('请填写发票金额'); return; } try { await money.send(`/api/money/purchase-orders/${row.id}/invoice`, { amount, invoice_date: date }); message.success('已开票'); onClose(); } catch (error) { message.error(showError(error)); } }
  return <Modal title="开票" open onCancel={onClose} onOk={save} okText="确定" cancelText="取消"><Form layout="vertical"><Form.Item label="发票金额" required><Input value={amount} onChange={(event) => setAmount(event.target.value)} /></Form.Item><Form.Item label="开票日期"><DayField value={date} onChange={setDate} /></Form.Item></Form></Modal>;
}
function pair(text: string) { const [title, dataIndex] = text.split(':'); return { title, dataIndex }; }

export function PayRecordList() {
  const money = useMoney();
  const query = useQueryState();
  const remote = useRemote<{ items: Rec[]; summary: { amount: string } }>(`/api/money/purchase-payments?q=${encodeURIComponent(query.query.q ?? '')}`, money.revision, money.onExpired);
  return <ListFrame pageKey="pay-record" rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} page={query.page} pageSize={query.pageSize} total={remote.data?.items.length ?? 0} onPage={query.onPage}
    chips={[{ key: 'approval', label: '审核状态', options: [{ value: 'all', label: '全部' }, { value: 'exempt', label: '不需审核' }] }]} chipValue={query.chips} onChip={query.onChip}
    queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
    summary={<SummaryBar parts={[['累计付款', remote.data?.summary.amount ?? '0']]} />}
    columns={[
      { key: 'supplier', title: '供应商', render: (row) => row.supplier_name },
      { key: 'order', title: '采购单号', render: (row) => row.order_code },
      { key: 'amount', title: '付款金额(元)', render: (row) => row.amount },
      { key: 'note', title: '备注', render: (row) => row.note },
      { key: 'approval', title: '审核状态', render: (row) => <StatusTag text={row.approval_text} /> },
      { key: 'date', title: '付款日期', render: (row) => row.pay_date },
      { key: 'creator', title: '创建人', render: (row) => row.creator_name },
      { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at ?? '', '') },
      { key: 'actions', title: '操作', render: (row) => <button className="kgd-link" onClick={() => confirmText('删除付款', '确定删除该付款记录？', () => void money.send(`/api/money/purchase-payments/${row.id}/actions`, { action: 'delete' }))}>删除</button> },
    ]} />;
}

export function PurchaseInvoiceList() {
  const { message } = App.useApp();
  const money = useMoney();
  const query = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/money/purchase-invoices', money.revision, money.onExpired);
  const rows = (remote.data?.items ?? []).filter((row) => !query.query.q || `${row.order_code}${row.supplier_name}`.includes(query.query.q));
  return <ListFrame pageKey="purchase-invoice" showMobileCard rows={rows} loading={remote.loading} error={remote.error} page={query.page} pageSize={query.pageSize} total={rows.length} onPage={query.onPage}
    queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
    columns={[
      { key: 'order', title: '采购单号', render: (row) => row.order_code },
      { key: 'supplier', title: '供应商', render: (row) => row.supplier_name },
      { key: 'amount', title: '发票金额(元)', render: (row) => row.amount },
      { key: 'date', title: '开票日期', render: (row) => row.invoice_date },
      { key: 'note', title: '备注', render: (row) => row.note },
      { key: 'approval', title: '审核状态', render: (row) => <StatusTag text={row.approval_text} /> },
      { key: 'creator', title: '创建人', render: (row) => row.creator_name },
      { key: 'actions', title: '操作', render: (row) => <button className="kgd-link" onClick={() => confirmText('删除发票', '确定删除？', () => void money.send(`/api/money/purchase-invoices/${row.id}/actions`, { action: 'delete' }).catch((error) => message.error(showError(error))))}>删除</button> },
    ]} />;
}
