import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, DatePicker, Dropdown, Form, Input, Modal, Select } from 'antd';
import { App } from 'antd';
import dayjs from 'dayjs';
import { hasPoint } from '../../../api';
import { useRemote } from '../../../masterTools';
import { ListFrame, type ListColumn } from '../../ListFrame';
import { useExtForm, useExtList } from '../../extensions/bind';
import { confirmText, showError, StatusTag, useQueryState, beijingTime } from '../../kit';
import { useKgd } from '../../context';
import { AuditDetailModal } from '../audit/AuditDetailModal';
import { BatchAuditModal } from '../audit/BatchAuditModal';
import { auditChipOptions, useAuditCounts } from '../audit/auditChips';
import { sumMoney } from './math';
import { printDoc, printDocs } from '../../print';
import { blankLine, DayField, type DraftLine, LineTable, MemberSelect, priced, quoteAmountTip, quoteDoc, type Rec, searchPlaceholder, SummaryBar, toPayload, useMoney } from './shared';
import { requestKey } from '../../../requestKey';

const heads = new Set(['code', 'customer', 'contact', 'phone', 'address', 'approval', 'audit', 'status', 'signed', 'contract', 'amount', 'qty', 'delivery', 'quoteDate', 'sales', 'note', 'creator', 'created', 'actions']);

export function QuotationList() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const money = useMoney();
  const { session } = useKgd();
  const query = useQueryState();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [auditId, setAuditId] = useState('');
  const [batch, setBatch] = useState(false);
  const counts = useAuditCounts('quotation', money.revision, money.onExpired);
  const approver = useRemote<{ approver: boolean }>('/api/audit/approver?object_type=quotation', money.revision, money.onExpired);
  const extList = useExtList('contract_quotation');
  const remote = useRemote<{ items: Rec[]; summary: { amount: string; qty: string } }>(`/api/money/quotations?approval=${query.chips.approval ?? 'all'}&contract=${query.chips.contract ?? 'all'}&quote_status=${query.chips.quote_status ?? 'all'}&signed=${query.chips.signed ?? 'all'}&q=${encodeURIComponent(query.query.q ?? '')}`, money.revision, money.onExpired);
  const flat = useMemo(() => (remote.data?.items ?? []).flatMap((item) => {
    const lines = item.lines?.length ? item.lines as Rec[] : [{}];
    return lines.map((line, index) => ({ ...item, ...line, id: `${item.id}:${index}`, _span: index === 0 ? lines.length : 0, _doc: item }));
  }), [remote.data]);
  const pickedDocs = (remote.data?.items ?? []).filter((item) => selected.some((key) => key.split(':')[0] === item.id));
  async function act(row: Rec, action: string, extra: Record<string, unknown> = {}) {
    try { await money.send(`/api/money/quotations/${row.id}/actions`, { action, version: row.version, ...extra }); message.success('已保存'); }
    catch (error) { message.error(showError(error)); }
  }
  async function toContract(row: Rec) {
    try {
      const result = await money.send<{ contract: Rec }>(`/api/money/quotations/${row.id}/to-contract`, {});
      message.success('已生成合同');
      if (result?.contract.id) navigate(`/customer_contract/detail/${result.contract.id}`);
    } catch (error) { message.error(showError(error)); }
  }
  async function copy(row: Rec) {
    try { await money.send(`/api/money/quotations/${row.id}/copy`, { request_key: requestKey() }); message.success('已复制'); }
    catch (error) { message.error(showError(error)); }
  }
  const span = (row: Rec) => ({ rowSpan: Number(row._span) });
  const cell = (key: string, title: string, render: (row: Rec) => ReactNode): ListColumn<Rec> => ({ key, title, render, onCell: heads.has(key) ? span : undefined });
  const columns: ListColumn<Rec>[] = [
    cell('code', '报价单号', (row) => row._span ? row.code : ''),
    cell('customer', '客户', (row) => row.customer_name),
    cell('contact', '联系人', (row) => row.contact_name),
    cell('phone', '联系人电话', (row) => row.contact_phone),
    cell('address', '地址', (row) => row.address),
    cell('approval', '审核状态', (row) => <StatusTag text={String(row.approval_text ?? '')} />),
    cell('audit', '审核详情', (row) => <button className="kgd-link" onClick={() => setAuditId(String(row._doc?.id ?? row.id).split(':')[0])}>查看</button>),
    cell('status', '报价状态', (row) => row.quote_status_text),
    cell('signed', '客户签字', (row) => row.signed_text),
    cell('contract', '合同订单', (row) => row.contract_text),
    ...(hasPoint(session, 'customer.quote.amount') ? [cell('amount', '报价金额', (row) => row._doc?.amount)] : []),
    cell('qty', '商品总数', (row) => row._doc?.qty),
    cell('delivery', '交货日期', (row) => row._doc?.delivery_date),
    cell('quoteDate', '报价日期', (row) => row._doc?.quote_date),
    cell('sales', '业务员', (row) => row.salesperson_name),
    cell('note', '备注', (row) => row._doc?.note),
    { key: 'product', title: '商品名', render: (row) => row.product_name },
    { key: 'pcode', title: '商品编号', render: (row) => row.product_code },
    { key: 'spec', title: '商品规格', render: (row) => row.specification },
    { key: 'category', title: '商品类别', render: () => '' },
    { key: 'image', title: '商品图片', render: () => '' },
    { key: 'price', title: '销售单价', render: (row) => row.unit_price },
    { key: 'quantity', title: '销售数量', render: (row) => row.quantity },
    { key: 'stock', title: '库存', render: () => '' },
    { key: 'discount', title: '折扣', render: (row) => row.discount_text },
    { key: 'concession', title: '优惠金额', render: (row) => row.concession },
    { key: 'net', title: '折后金额', render: (row) => row.net_amount },
    { key: 'lineNote', title: '商品备注', render: (row) => row.note },
    { key: 'attach', title: '商品附件', render: () => '' },
    cell('creator', '创建人', (row) => row.creator_name),
    cell('created', '创建时间', (row) => beijingTime(row.created_at ?? '', '')),
    cell('actions', '操作', (row) => row._span ? <span onClick={(event) => event.stopPropagation()}>
      {(row.approval === 'approved' || row.approval === 'exempt') && !row.contract_id ? <button className="kgd-link" onClick={() => toContract(row._doc)}>生成合同</button> : null}
      <button className="kgd-link" onClick={() => copy(row._doc)}>复制</button>
      <button className="kgd-link" onClick={() => navigator.clipboard.writeText(`${location.origin}/contract_quotation_bill/list`).then(() => message.success('已复制分享链接'))}>分享</button>
      <Dropdown menu={{ items: [
        ...(row._doc?.can_withdraw ? [{ key: 'withdraw', label: '撤回', onClick: () => void money.send('/api/audit/decide', { object_type: 'quotation', object_id: row._doc.id, action: '撤回' }).then(() => message.success('已撤回')).catch((error) => message.error(showError(error))) }] : []),
        { key: 'print', label: '打印', onClick: () => printDoc(quoteDoc(row._doc)) },
        { key: 'delete', label: '删除', onClick: () => confirmText('删除报价单', '确定删除该报价单？', () => void act(row._doc, 'delete')) },
      ] }}><button className="kgd-link">更多</button></Dropdown>
    </span> : ''),
  ];
  return <>
    {/* applySpecColumns=false：pageSpec 含「报价金额」，align 会 stub 回填，冲掉 customer.quote.amount 权限隐藏 */}
    <ListFrame pageKey="quote-list" showMobileCard applySpecColumns={false} rows={flat} columns={columns} loading={remote.loading} error={remote.error || money.error} clientPaging={false} page={1} pageSize={Math.max(flat.length, 1)} total={remote.data?.items.length ?? 0} onPage={() => undefined}
      chips={[
        { key: 'approval', label: '审核状态', options: auditChipOptions(counts.data) },
        { key: 'contract', label: '合同订单', options: opts('全部:all,已创建:created,未创建:open') },
        { key: 'quote_status', label: '报价状态', options: opts('全部:all,报价中:quoting,报价成功:success,报价失败:failed') },
        { key: 'signed', label: '客户签字', options: opts('全部:all,已签字:yes,未签字:no') },
      ]} chipValue={query.chips} onChip={query.onChip}
      queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
      summary={<SummaryBar parts={[['报价总金额', remote.data?.summary.amount ?? '0'], ['商品总数量', remote.data?.summary.qty ?? '0']]} />}
      rowSelection={{ selected, onChange: setSelected }}
      toolbar={<><Button type="primary" onClick={() => setOpen(true)}>新增</Button>
        <Dropdown disabled={!selected.length} menu={{ items: [
          ...(approver.data?.approver ? [{ key: 'audit', label: '批量审核', onClick: () => setBatch(true) }] : []),
          { key: 'print', label: '批量打印', onClick: () => printDocs(pickedDocs.map(quoteDoc), '报价单') },
          { key: 'delete', label: '批量删除', onClick: () => confirmText('批量删除', `确定删除所选${pickedDocs.length}张报价单？`, () => void (async () => { for (const doc of pickedDocs) await act(doc, 'delete'); setSelected([]); })()) },
        ] }}><Button disabled={!selected.length}>批量操作</Button></Dropdown></>}
      {...extList.props} />
    {extList.dialog}
    {open && <QuoteModal onClose={() => setOpen(false)} />}
    {auditId && <AuditDetailModal objectType="quotation" objectId={auditId} onClose={() => setAuditId('')} />}
    {batch && <BatchAuditModal objectType="quotation" ids={[...new Set(selected.map((item) => item.split(':')[0]!))]} onClose={() => setBatch(false)} />}
  </>;
}

function opts(text: string) {
  return text.split(',').map((item) => { const [label, value] = item.split(':'); return { label: label!, value: value! }; });
}

function QuoteModal({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const customers = useRemote<{ items: Rec[] }>('/api/money/customers', money.revision, money.onExpired);
  const settings = useRemote<{ settings: Rec }>('/api/money/settings', money.revision, money.onExpired);
  const [customerId, setCustomerId] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [sales, setSales] = useState(() => String(money.session.user.id));
  const [delivery, setDelivery] = useState('');
  const [quoteDate, setQuoteDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [note, setNote] = useState('');
  const [code, setCode] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [tried, setTried] = useState(false);
  const extForm = useExtForm('contract_quotation');
  const customer = customers.data?.items.find((item) => item.id === customerId);
  const formula = String(settings.data?.settings.quote_formula ?? '${合同报价明细.单价}*${合同报价明细.销售数量}');
  const scale = Number(settings.data?.settings.quote_scale ?? 8);
  const auto = settings.data?.settings.auto_calc !== false;
  const [manualAmount, setManualAmount] = useState('');
  const headerAmount = sumMoney(lines.map((line) => priced(line, formula, scale).net));
  async function save() {
    setTried(true);
    if (!customerId) { message.error('请选择客户'); return; }
    if (!contact.trim()) { message.error('请填写联系人'); return; }
    if (!sales) { message.error('请选择业务员'); return; }
    if (!lines.length) { message.error('请至少添加一个商品'); return; }
    if (!auto && !manualAmount.trim()) { message.error('请填写报价金额'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await money.send<{ quotation?: { id?: string } }>('/api/money/quotations', { request_key: requestKey(), code, customer_id: customerId, contact_name: contact, contact_phone: phone, address, salesperson_id: sales, delivery_date: delivery, quote_date: quoteDate, note, amount: auto ? headerAmount : manualAmount, lines: toPayload(lines) });
      if (saved?.quotation?.id) await extForm.persist(money.session.csrf_token, saved.quotation.id);
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增合同报价单" open width={1080} onCancel={onClose} onOk={save} okText="保存" cancelText="取消" confirmLoading={money.busy}>
    <Form layout="vertical">
      <Form.Item label="报价单号"><Input value={code} placeholder="请填写，忽略将自动生成" onChange={(event) => setCode(event.target.value)} /></Form.Item>
      <Form.Item label="客户" required validateStatus={tried && !customerId ? 'error' : undefined} help={tried && !customerId ? '请选择客户' : undefined}><Select showSearch optionFilterProp="label" status={tried && !customerId ? 'error' : undefined} placeholder={searchPlaceholder} options={(customers.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} onChange={(id) => { const found = customers.data?.items.find((item) => item.id === id); setCustomerId(id); setContact(found?.contact_name ?? ''); setPhone(found?.contact_phone ?? ''); setAddress([found?.region, found?.address].filter(Boolean).join(' ')); }} /></Form.Item>
      <Form.Item label="联系人" required><Select disabled={!customer} value={contact || undefined} options={(customer?.contacts ?? []).map((item: Rec) => ({ value: item.name, label: item.name }))} onChange={setContact} /></Form.Item>
      <Form.Item label="客户地址"><Select disabled={!customer} value={address || undefined} options={(customer?.addresses ?? []).map((item: Rec) => ({ value: `${item.region}${item.detail}`, label: `${item.region}${item.detail}` }))} onChange={setAddress} /></Form.Item>
      <Form.Item label="交货日期"><DayField value={delivery} onChange={setDelivery} /></Form.Item>
      <Form.Item label="报价日期"><DatePicker style={{ width: '100%' }} value={dayjs(quoteDate)} onChange={(_, text) => setQuoteDate(typeof text === 'string' ? text : quoteDate)} /></Form.Item>
      <Form.Item label="业务员" required><MemberSelect value={sales} revision={money.revision} onChange={setSales} /></Form.Item>
      <Form.Item label="报价金额" required><Input disabled={auto} value={auto ? headerAmount : manualAmount} onChange={(event) => setManualAmount(event.target.value)} /></Form.Item>
      <Form.Item label="商品总数"><Input disabled value={String(lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0))} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea maxLength={500} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
      {extForm.node}
    </Form>
    <LineTable mode="sale" addLabel="+ 选择报价单商品" lines={lines} onChange={setLines} formula={formula} scale={scale} tip={quoteAmountTip} />
  </Modal>;
}

export function quoteLines(lines: Rec[]) {
  return lines.map((line) => blankLine(line as Record<string, unknown>));
}
