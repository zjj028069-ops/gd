import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Dropdown, Form, Input, Modal, Select, Switch, Table, Tabs } from 'antd';
import { App } from 'antd';
import { apiRequest, hasPoint } from '../../../api';
import { useRemote } from '../../../masterTools';
import { ContractOutboundLink } from '../warehouse/router';
import { ProgressCell } from '../progress/ProgressCell';
import { ListFrame, type ListColumn } from '../../ListFrame';
import { useExtForm, useExtList } from '../../extensions/bind';
import { confirmText, showError, StatusTag, useQueryState, beijingTime } from '../../kit';
import { useKgd } from '../../context';
import { AuditDetailModal } from '../audit/AuditDetailModal';
import { BatchAuditModal } from '../audit/BatchAuditModal';
import { auditChipOptions, useAuditCounts } from '../audit/auditChips';
import { allocateSequential, cmpMoney, subMoney, sumMoney } from './math';
import { BomPick } from './supply';
import { printDoc, printDocs } from '../../print';
import { blankLine, codePlaceholder, contractAmountTip, contractDoc, DayField, type DraftLine, FileDrop, LineTable, MemberSelect, priced, type Rec, searchPlaceholder, SummaryBar, toPayload, useMoney } from './shared';
import { requestKey } from '../../../requestKey';

const heads = new Set(['code', 'customer', 'customerCode', 'contact', 'project', 'address', 'fee', 'approval', 'life', 'approvedAt', 'amount', 'qty', 'prepay', 'received', 'progress', 'spent', 'invoiced', 'debt', 'delivery', 'receipt', 'tax', 'note', 'returns', 'ships', 'audit', 'sales', 'creator', 'shipDone', 'doneAt', 'created', 'actions']);

export function ContractList() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const money = useMoney();
  const { session } = useKgd();
  const query = useQueryState();
  const [form, setForm] = useState<'direct' | 'quote' | null>(() => new URLSearchParams(window.location.search).get('add') ? 'direct' : null);
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditId, setAuditId] = useState('');
  const [cash, setCash] = useState<Rec | null>(null);
  const [extValueMap, setExtValueMap] = useState<Record<string, Record<string, unknown>>>({});
  const counts = useAuditCounts('contract', money.revision, money.onExpired);
  const approver = useRemote<{ approver: boolean }>('/api/audit/approver?object_type=contract', money.revision, money.onExpired);
  const extList = useExtList('customer_contract');
  const presenceFilters = useMemo(() => {
    return (extList.ext.fields ?? [])
      .map((field) => {
        const lf = field.options?.list_filter;
        if (!lf || lf.kind !== 'presence') return null;
        return { fieldId: field.id, ...lf };
      })
      .filter(Boolean) as Array<{ fieldId: string; kind: 'presence'; chip_key: string; label: string; has_label: string; none_label: string }>;
  }, [extList.ext.fields]);
  useEffect(() => {
    if (!presenceFilters.length) { setExtValueMap({}); return; }
    let cancelled = false;
    void apiRequest<{ items: Array<{ record_id: string; values: Record<string, unknown> }> }>('/api/entity-ext-values/batch?entity=customer_contract')
      .then((data) => {
        if (cancelled) return;
        const map: Record<string, Record<string, unknown>> = {};
        for (const item of data.items ?? []) map[String(item.record_id)] = item.values ?? {};
        setExtValueMap(map);
      })
      .catch(() => { if (!cancelled) setExtValueMap({}); });
    return () => { cancelled = true; };
  }, [presenceFilters.length, money.revision]);
  const remote = useRemote<{ items: Rec[]; summary: Rec }>(`/api/money/contracts?q=${encodeURIComponent(query.query.q ?? '')}&code=${encodeURIComponent(query.query.code ?? '')}&customer=${encodeURIComponent(query.query.customer ?? '')}&approval=${query.chips.approval ?? 'all'}&lifecycle=${query.chips.lifecycle ?? 'all'}`, money.revision, money.onExpired);
  const items = useMemo(() => {
    const raw = remote.data?.items ?? [];
    if (!presenceFilters.length) return raw;
    return raw.filter((item) => {
      const values = extValueMap[String(item.id)] ?? {};
      for (const filter of presenceFilters) {
        const chip = query.chips[filter.chip_key] ?? 'all';
        if (chip === 'all') continue;
        const rawVal = values[filter.fieldId];
        const has = !(rawVal == null || rawVal === '' || (Array.isArray(rawVal) && !rawVal.length));
        if (chip === 'has' && !has) return false;
        if (chip === 'none' && has) return false;
      }
      return true;
    });
  }, [remote.data?.items, presenceFilters, extValueMap, query.chips]);
  const flat = useMemo(() => items.flatMap((item) => {
    const lines = item.lines?.length ? item.lines as Rec[] : [{}];
    return lines.map((line, index) => ({ ...line, id: `${item.id}:${index}`, _span: index === 0 ? lines.length : 0, _doc: item }));
  }), [items]);
  const picked = items.filter((item) => selected.some((key) => key.startsWith(item.id)));
  async function act(row: Rec, action: string, extra: Record<string, unknown> = {}) {
    try { await money.send(`/api/money/contracts/${row.id}/actions`, { action, version: row.version, ...extra }); message.success('已保存'); }
    catch (error) { message.error(showError(error)); }
  }
  const span = (row: Rec) => ({ rowSpan: Number(row._span) });
  const cell = (key: string, title: string, render: (row: Rec) => ReactNode): ListColumn<Rec> => ({ key, title, render: (row) => row._span || !heads.has(key) ? render(row) : '', onCell: heads.has(key) ? span : undefined });
  const columns: ListColumn<Rec>[] = [
    cell('code', '合同编号', (row) => <button className="kgd-link" onClick={() => navigate(`/customer_contract/detail/${row._doc.id}`)}>{row._doc.code}</button>),
    cell('customer', '客户', (row) => row._doc.customer_name),
    cell('customerCode', '客户编号', (row) => row._doc.customer_code),
    cell('contact', '联系人', (row) => row._doc.contact_name),
    cell('project', '关联项目', () => ''),
    cell('address', '客户地址', (row) => row._doc.address),
    cell('fee', '销售费用(元)', (row) => row._doc.sales_fee),
    cell('approval', '审核状态', (row) => <StatusTag text={row._doc.approval_text} />),
    cell('life', '业务状态', (row) => <StatusTag text={row._doc.lifecycle_text} />),
    cell('approvedAt', '审核通过时间', (row) => beijingTime(row._doc.approved_at ?? '', '')),
    { key: 'product', title: '商品名', render: (row) => row.product_name },
    { key: 'pcode', title: '商品编号', render: (row) => row.product_code },
    { key: 'spec', title: '商品规格', render: (row) => row.specification },
    { key: 'image', title: '商品图片', render: () => '' },
    { key: 'category', title: '商品类别', render: () => '' },
    { key: 'price', title: '单价', render: (row) => row.unit_price },
    { key: 'lineAmount', title: '金额', render: (row) => row.amount },
    { key: 'unit', title: '单位', render: (row) => row.unit_name },
    { key: 'quantity', title: '销售数量', render: (row) => row.quantity },
    { key: 'stock', title: '库存', render: () => '' },
    { key: 'discount', title: '折扣', render: (row) => row.discount_text },
    { key: 'concession', title: '优惠金额', render: (row) => row.concession },
    { key: 'net', title: '折后金额', render: (row) => row.net_amount },
    { key: 'produce', title: '投产进度', render: (row) => {
      const raw = String(row.produce_progress ?? '');
      if (!raw) return '';
      const matched = raw.match(/^([\d.]+)%/);
      const pct = matched ? Number(matched[1]) : 0;
      return <ProgressCell progress={raw} complete={pct >= 100} />;
    } },
    { key: 'analyse', title: '分析进度', render: () => '' },
    { key: 'shipProgress', title: '出库进度', render: (row) => {
      if (!row._span) return '';
      const raw = String(row._doc?.outbound_progress ?? '0% (0/0)');
      const m = raw.match(/^([\d.]+)%/);
      const pct = m ? Number(m[1]) : 0;
      return <ProgressCell progress={raw} complete={pct >= 100} />;
    }, onCell: span },
    { key: 'buyProgress', title: '采购进度', render: () => '' },
    { key: 'lineNote', title: '商品备注', render: (row) => row.note },
    { key: 'lineFile', title: '商品附件', render: () => '' },
    ...(hasPoint(session, 'customer.contract.amount') ? [cell('amount', '合同金额', (row) => row._doc.amount)] : []),
    cell('qty', '销售总数', (row) => row._doc.qty),
    cell('prepay', '预付款', (row) => row._doc.prepay),
    cell('received', '累计收款', (row) => row._doc.received),
    cell('progress', '收款进度', (row) => row._doc.receive_progress),
    cell('spent', '累计支出', (row) => row._doc.spent),
    cell('invoiced', '已开票金额', (row) => row._doc.invoiced),
    cell('debt', '欠款', (row) => row._doc.debt),
    cell('delivery', '交货日期', (row) => row._doc.delivery_date),
    cell('receipt', '收款日期', (row) => row._doc.receipt_date),
    cell('tax', '是否含税', (row) => row._doc.tax_included ? '是' : '否'),
    cell('note', '备注', (row) => row._doc.note),
    cell('returns', '销售退货', () => '退货 (0)'),
    cell('ships', '销售出库', (row) => <ContractOutboundLink contractId={String(row._doc.id)} count={Number(row._doc.shipment_count ?? 0)} />),
    cell('audit', '审核详情', (row) => <button className="kgd-link" onClick={() => setAuditId(String(row._doc.id))}>查看</button>),
    cell('sales', '业务员', (row) => row._doc.salesperson_name),
    cell('creator', '创建人', (row) => row._doc.creator_name),
    cell('shipDone', '出库完成日期', (row) => String(row._doc.outbound_complete_date ?? '').slice(0, 10)),
    cell('doneAt', '完成时间', (row) => beijingTime(row._doc.completed_at ?? '', '')),
    cell('created', '创建时间', (row) => beijingTime(row._doc.created_at ?? '', '')),
    cell('actions', '操作', (row) => <span onClick={(event) => event.stopPropagation()}>
      <button className="kgd-link" onClick={() => setCash({ ...row._doc, direction: 'in' })}>收款</button>
      <button className="kgd-link" onClick={() => setCash({ ...row._doc, direction: 'out' })}>支出</button>
      {row._doc.lifecycle === 'performing' && <button className="kgd-link" onClick={() => act(row._doc, 'complete')}>完成</button>}
      {row._doc.lifecycle === 'performing' && <button className="kgd-link" onClick={() => setCash({ ...row._doc, direction: 'end' })}>终止</button>}
      <Dropdown menu={{ items: [
        { key: 'copy', label: '复制', onClick: () => void act(row._doc, 'copy') },
        ...(row._doc.can_withdraw ? [{ key: 'withdraw', label: '撤回', onClick: () => void money.send('/api/audit/decide', { object_type: 'contract', object_id: row._doc.id, action: '撤回' }).then(() => message.success('已撤回')).catch((error) => message.error(showError(error))) }] : []),
        ...(row._doc.approval === 'rejected' || row._doc.approval === 'withdrawn' ? [{ key: 'revise', label: '修改', onClick: () => void act(row._doc, 'revise') }] : []),
        { key: 'print', label: '打印', onClick: () => printDoc(contractDoc(row._doc)) },
        { key: 'delete', label: '删除', onClick: () => confirmText('删除合同', '确定删除该合同？', () => void act(row._doc, 'delete')) },
      ] }}><button className="kgd-link">更多</button></Dropdown>
    </span>),
  ];
  return <>
    {/* applySpecColumns=false：pageSpec 含「合同金额」，align 会 stub 回填，冲掉 customer.contract.amount 权限隐藏 */}
    <ListFrame pageKey="contract-list" showMobileCard applySpecColumns={false} rows={flat} columns={columns} loading={remote.loading} error={remote.error || money.error} clientPaging={false} page={1} pageSize={Math.max(flat.length, 1)} total={items.length} onPage={() => undefined}
      defaultVisible={['code', 'customer', 'approval', 'audit', 'life', 'amount', 'prepay', 'debt', 'produce', 'shipProgress', 'actions']}
      defaultQueryKeys={['code', 'customer', 'q']}
      chips={[{ key: 'approval', label: '审核状态', options: auditChipOptions(counts.data, true) }, { key: 'lifecycle', label: '业务状态', options: opts('全部:all,未生效:inactive,履约中:performing,已完成:done,已终止:terminated') }, ...presenceFilters.map((filter) => ({ key: filter.chip_key, label: filter.label, options: [{ label: '全部', value: 'all' }, { label: filter.has_label, value: 'has' }, { label: filter.none_label, value: 'none' }] }))]}
      chipValue={query.chips} onChip={query.onChip}
      queryFields={[{ key: 'code', label: '合同编号' }, { key: 'customer', label: '客户', placeholder: '客户名/简拼' }, { key: 'q', label: '备注' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
      summary={remote.data ? <SummaryBar parts={[['合同金额', remote.data.summary.amount], ['预付款', remote.data.summary.prepay], ['累计收款', remote.data.summary.received], ['累计支出', remote.data.summary.spent], ['欠款', remote.data.summary.debt], ['销售费用', remote.data.summary.sales_fee]]} /> : undefined}
      rowSelection={{ selected, onChange: setSelected }}
      toolbar={<>
        <Dropdown menu={{ items: [{ key: 'direct', label: '直接创建', onClick: () => setForm('direct') }, { key: 'quote', label: '报价单创建', onClick: () => setForm('quote') }] }}><Button type="primary">新增</Button></Dropdown>
        <Dropdown disabled={!picked.length} menu={{ items: [
          ...(approver.data?.approver ? [{ key: 'audit', label: '批量审核', onClick: () => setAuditOpen(true) }] : []),
          { key: 'print', label: '批量打印', onClick: () => printDocs(picked.map(contractDoc), '合同订单') },
          { key: 'delete', label: '批量删除', onClick: () => confirmText('批量删除', '确定删除所选合同？', () => void money.send('/api/money/contracts/batch', { action: 'delete', ids: picked.map((item) => item.id) }).catch((error) => message.error(showError(error)))) },
          { key: 'cash', label: '批量收款', onClick: () => setBatch(true) },
        ] }}><Button disabled={!picked.length}>批量操作 ▾</Button></Dropdown>
      </>}
      {...extList.props} />
    {extList.dialog}
    {form === 'direct' && <ContractModal onClose={() => setForm(null)} />}
    {form === 'quote' && <QuotePick onClose={() => setForm(null)} onPicked={() => { setForm(null); message.success('已生成合同草稿'); }} />}
    {cash && cash.direction !== 'end' && <CashModal row={cash} onClose={() => setCash(null)} />}
    {cash?.direction === 'end' && <EndModal row={cash} onClose={() => setCash(null)} />}
    {batch && <BatchCash rows={picked} onClose={() => setBatch(false)} />}
    {auditId && <AuditDetailModal objectType="contract" objectId={auditId} onClose={() => setAuditId('')} />}
    {auditOpen && <BatchAuditModal objectType="contract" ids={picked.map((item) => String(item.id))} onClose={() => setAuditOpen(false)} />}
  </>;
}

function opts(text: string) { return text.split(',').map((item) => { const [label, value] = item.split(':'); return { label: label!, value: value! }; }); }

function ContractModal({ onClose, preset }: { onClose: () => void; preset?: Rec }) {
  const { message } = App.useApp();
  const money = useMoney();
  const customers = useRemote<{ items: Rec[] }>('/api/money/customers', money.revision, money.onExpired);
  const settings = useRemote<{ settings: Rec }>('/api/money/settings', money.revision, money.onExpired);
  const [code, setCode] = useState('');
  const [customerId, setCustomerId] = useState(preset?.customer_id ?? '');
  const [contact, setContact] = useState(preset?.contact_name ?? '');
  const [phone, setPhone] = useState(preset?.contact_phone ?? '');
  const [address, setAddress] = useState(preset?.address ?? '');
  const [prepay, setPrepay] = useState('0');
  const [delivery, setDelivery] = useState(preset?.delivery_date ?? '');
  const [receipt, setReceipt] = useState('');
  const [sales, setSales] = useState(preset?.salesperson_id ?? '');
  const [tax, setTax] = useState(false);
  const [note, setNote] = useState(preset?.note ?? '');
  const [manualAmount, setManualAmount] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(() => (preset?.lines ?? []).map((line: Rec) => blankLine(line as Record<string, unknown>)));
  const [bomOpen, setBomOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const extForm = useExtForm('customer_contract');
  const customer = customers.data?.items.find((item) => item.id === customerId);
  const auto = settings.data?.settings.auto_calc !== false;
  const formula = String(settings.data?.settings.contract_formula ?? '${合同明细.单价}*${合同明细.销售数量}');
  const scale = Number(settings.data?.settings.contract_scale ?? 8);
  const headerAmount = sumMoney(lines.map((line) => priced(line, formula, scale).net));
  async function save(submit: boolean) {
    setTried(true);
    if (!customerId) { message.error('请选择客户'); return; }
    if (!sales) { message.error('请选择业务员'); return; }
    if (!lines.length) { message.error('请至少添加一个商品'); return; }
    if (!auto && !manualAmount.trim()) { message.error('请填写合同金额'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await money.send<{ contract?: { id?: string } }>('/api/money/contracts', { request_key: requestKey(), code, customer_id: customerId, contact_name: contact, contact_phone: phone, address, prepay, amount: auto ? headerAmount : manualAmount, delivery_date: delivery, receipt_date: receipt, salesperson_id: sales, tax_included: tax, note, lines: toPayload(lines), submit, quotation_id: preset?.id });
      if (saved?.contract?.id) await extForm.persist(money.session.csrf_token, saved.contract.id);
      message.success(submit ? '已提交审核' : '已存为草稿');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增合同" open width={1080} onCancel={onClose} footer={<><Button onClick={onClose}>关 闭</Button><Button onClick={() => save(false)} loading={money.busy}>保存</Button><Button onClick={() => save(false)} loading={money.busy}>存为草稿</Button><Button type="primary" onClick={() => save(true)} loading={money.busy}>提交审核</Button></>}>
    <Form layout="vertical">
      <Form.Item label="合同编号"><Input value={code} placeholder={codePlaceholder} onChange={(event) => setCode(event.target.value)} /></Form.Item>
      <Form.Item label="客户" required validateStatus={tried && !customerId ? 'error' : undefined} help={tried && !customerId ? '请选择客户' : undefined}><Select showSearch optionFilterProp="label" status={tried && !customerId ? 'error' : undefined} placeholder={searchPlaceholder} value={customerId || undefined} options={(customers.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} onChange={(id) => { const found = customers.data?.items.find((item) => item.id === id); setCustomerId(id); setContact(found?.contact_name ?? ''); setPhone(found?.contact_phone ?? ''); setAddress([found?.region, found?.address].filter(Boolean).join(' ')); }} /></Form.Item>
      <Form.Item label="联系人"><Select disabled={!customer} value={contact || undefined} options={(customer?.contacts ?? []).map((item: Rec) => ({ value: item.name, label: item.name }))} onChange={setContact} /></Form.Item>
      <Form.Item label="客户地址"><Select disabled={!customer} value={address || undefined} options={(customer?.addresses ?? []).map((item: Rec) => ({ value: item.detail, label: `${item.region}${item.detail}` }))} onChange={setAddress} /></Form.Item>
      <Form.Item label="预付款"><Input style={{ textAlign: 'right' }} value={prepay} onChange={(event) => setPrepay(event.target.value)} /></Form.Item>
      <Form.Item label="销售总数"><Input disabled value={sumMoney(lines.map((line) => line.quantity || '0'))} /></Form.Item>
      <Form.Item label="合同金额" required><Input disabled={auto} value={auto ? headerAmount : manualAmount} placeholder="请填写合同金额" onChange={(event) => setManualAmount(event.target.value)} /></Form.Item>
      <Form.Item label="交货日期"><DayField value={delivery} onChange={setDelivery} /></Form.Item>
      <Form.Item label="收款日期"><DayField value={receipt} onChange={setReceipt} /></Form.Item>
      <Form.Item label="业务员" required><MemberSelect value={sales} revision={money.revision} onChange={setSales} /></Form.Item>
      <Form.Item label="是否含税"><Switch checked={tax} onChange={setTax} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea maxLength={500} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
      {extForm.node}
    </Form>
    <LineTable mode="sale" lines={lines} onChange={setLines} formula={formula} scale={scale} tip={contractAmountTip} extra={<Button onClick={() => setBomOpen(true)}>+ 按BOM选择商品</Button>} />
    {bomOpen && <BomPick onClose={() => setBomOpen(false)} onPick={(next) => setLines([...lines, ...next])} />}
  </Modal>;
}

function QuotePick({ onClose, onPicked }: { onClose: () => void; onPicked: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const remote = useRemote<{ items: Rec[] }>('/api/money/quotations?approval=all&contract=open', money.revision, money.onExpired);
  const rows = (remote.data?.items ?? []).filter((item) => item.approval === 'approved' || item.approval === 'exempt');
  const [id, setId] = useState('');
  async function ok() {
    try { await money.send(`/api/money/quotations/${id}/to-contract`, {}); onPicked(); }
    catch (error) { message.error(showError(error)); }
  }
  return <Modal title="选择报价单" open width={960} okText="确 定" cancelText="取 消" okButtonProps={{ disabled: !id }} onCancel={onClose} onOk={ok}>
    <div className="kgd-banner">此处显示系统中所有已审核通过或不需审核且未创建合同的报价单。</div>
    <Table size="small" rowKey={(row) => String(row.id)} pagination={{ pageSize: 10 }} onRow={(row) => ({ onClick: () => setId(String(row.id)) })} rowSelection={{ type: 'radio', selectedRowKeys: id ? [id] : [], onChange: (keys) => setId(String(keys[0] ?? '')) }} dataSource={rows.map((row) => ({ ...row, id: String(row.id) }))} columns={[
      { title: '报价单号', dataIndex: 'code' }, { title: '客户', dataIndex: 'customer_name' }, { title: '联系人', dataIndex: 'contact_name' }, { title: '联系人电话', dataIndex: 'contact_phone' }, { title: '地址', dataIndex: 'address' }, { title: '报价金额', dataIndex: 'amount' }, { title: '商品总数', dataIndex: 'qty' }, { title: '交货日期', dataIndex: 'delivery_date' }, { title: '业务员', dataIndex: 'salesperson_name' }, { title: '备注', dataIndex: 'note' }, { title: '创建人', dataIndex: 'creator_name' }, { title: '创建时间', dataIndex: 'created_at' },
    ]} />
  </Modal>;
}

function CashModal({ row, onClose }: { row: Rec; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState('');
  const [amountErr, setAmountErr] = useState('');
  const incoming = row.direction !== 'out';
  async function save() {
    if (!amount.trim()) { setAmountErr('请填写金额'); message.error('请填写金额'); return; }
    setAmountErr('');
    try {
      await money.send(`/api/money/contracts/${row.id}/cash`, { direction: incoming ? 'in' : 'out', amount, note, attachment: file });
      message.success('已提交审核');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title={`${incoming ? '合同收款' : '合同支出'}【${row.customer_name}】${row.code}`} open onCancel={onClose} footer={<><Button onClick={onClose}>关 闭</Button><Button onClick={save}>确 定</Button><Button type="primary" onClick={save} loading={money.busy}>提交审核</Button></>}>
    {amountErr ? <div className="kgd-banner kgd-field-error">{amountErr}</div> : null}
    {incoming && <div style={{ marginBottom: 8 }}>欠款(元)　{row.debt}</div>}
    <Form layout="vertical">
      <Form.Item label="金额" required validateStatus={amountErr ? 'error' : undefined} help={amountErr || undefined}><Input placeholder="金额" className={amountErr ? 'kgd-field-error' : undefined} value={amount} onChange={(event) => { setAmountErr(''); setAmount(event.target.value); }} /></Form.Item>
      <Form.Item label="附件"><FileDrop value={file} onChange={setFile} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea placeholder="备注" maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
    </Form>
  </Modal>;
}

function EndModal({ row, onClose }: { row: Rec; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const reasons = useRemote<{ items: Rec[] }>('/api/money/end-reasons', money.revision, money.onExpired);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  async function save() {
    try { await money.send(`/api/money/contracts/${row.id}/actions`, { action: 'terminate', version: row.version, reason_id: reason, note }); message.success('已终止'); onClose(); }
    catch (error) { message.error(showError(error)); }
  }
  return <Modal title={`合同终止【${row.customer_name}】${row.code}`} open onCancel={onClose} onOk={save} okText="确定" cancelText="关闭">
    <Form layout="vertical">
      <Form.Item label="终止原因" required><Select placeholder="请选择终止原因" options={(reasons.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} onChange={setReason} /></Form.Item>
      <Form.Item label="终止说明"><Input.TextArea value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
    </Form>
  </Modal>;
}

function BatchCash({ rows, onClose }: { rows: Rec[]; onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const payable = rows.filter((row) => cmpMoney(row.debt, '0') > 0);
  const cap = sumMoney(payable.map((row) => row.debt));
  const [total, setTotal] = useState(cap);
  const [mode, setMode] = useState('auto');
  const [note, setNote] = useState('');
  const [amounts, setAmounts] = useState<string[]>(() => allocateSequential(payable.map((row) => row.debt), cap));
  function apply(nextTotal: string, nextMode: string) {
    setTotal(nextTotal); setMode(nextMode);
    if (nextMode === 'clear') setAmounts(payable.map((row) => row.debt));
    else if (nextMode === 'auto') { try { setAmounts(allocateSequential(payable.map((row) => row.debt), nextTotal || '0')); } catch (error) { message.error(showError(error)); } }
  }
  const used = sumMoney(amounts);
  async function save() {
    if (!total.trim()) { message.error('请填写本次收款总额'); return; }
    try {
      await money.send('/api/money/contracts/batch-cash', { ids: payable.map((row) => row.id), mode: mode === 'manual' ? 'manual' : mode === 'clear' ? 'clear' : 'auto', total, note, lines: payable.map((row, index) => ({ id: row.id, amount: amounts[index] })) });
      message.success('已提交批量收款');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title="批量收款" open width={980} onCancel={onClose} onOk={save} okText="确认批量收款" cancelText="取消" confirmLoading={money.busy}>
    <div>已选合同 {payable.length} 个　合同总金额 {sumMoney(payable.map((row) => row.amount))}　已收款金额 {sumMoney(payable.map((row) => row.received))}　<span style={{ color: '#f5222d' }}>总欠款 {cap}</span></div>
    <Form layout="vertical" style={{ marginTop: 8 }}>
      <Form.Item label="本次收款总额" required extra={`不可大于所选合同总欠款 ${cap} 元`}><Input value={total} onChange={(event) => apply(event.target.value, mode === 'clear' ? 'auto' : mode)} /></Form.Item>
      <div>已分配 {used} / 待分配 {subMoney(total || '0', used)}</div>
      <Form.Item label="分配方式" extra="按总额自动分配：输入总额后，系统按当前表格顺序依次分配，您仍可逐条调整。">
        <Select value={mode} options={[{ value: 'clear', label: '全部收清' }, { value: 'auto', label: '按总额自动分配' }, { value: 'manual', label: '手动分配' }]} onChange={(value) => apply(total, value)} />
      </Form.Item>
      <Form.Item label="备注"><Input.TextArea maxLength={255} showCount placeholder="填写本次收款说明，如银行流水号、付款方信息等" value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
    </Form>
    <div className="kgd-toolbar">合同收款明细（已自动过滤不需收款的合同） <Button onClick={() => setAmounts(payable.map(() => '0'))}>清空</Button></div>
    <Table size="small" rowKey="id" pagination={false} dataSource={payable} columns={[
      { title: '合同编号', dataIndex: 'code' }, { title: '客户', dataIndex: 'customer_name' }, { title: '合同金额(元)', dataIndex: 'amount' }, { title: '已收款(元)', dataIndex: 'received' }, { title: '欠款(元)', dataIndex: 'debt' },
      { title: '本次收款(元)', render: (_value: unknown, _row: Rec, index: number) => <Input value={amounts[index]} onChange={(event) => { const next = amounts.slice(); next[index] = event.target.value; setAmounts(next); setMode('manual'); }} /> },
      { title: '收款后欠款(元)', render: (_: unknown, row: Rec, index: number) => { try { return subMoney(row.debt, amounts[index] || '0'); } catch { return ''; } } },
      { title: '操作', render: (_: unknown, row: Rec, index: number) => <><button className="kgd-link" onClick={() => { const next = amounts.slice(); next[index] = row.debt; setAmounts(next); setMode('manual'); }}>收清</button> <button className="kgd-link" onClick={() => { const next = amounts.slice(); next[index] = '0'; setAmounts(next); setMode('manual'); }}>清空</button></> },
    ]} />
  </Modal>;
}

export function ContractDetail() {
  const { pathname } = useLocation();
  const id = pathname.split('/detail/')[1]?.split(/[/?#]/)[0] ?? '';
  const navigate = useNavigate();
  const { message } = App.useApp();
  const money = useMoney();
  const remote = useRemote<Rec>(id ? `/api/money/contracts/${id}` : null, money.revision, money.onExpired);
  const outbound = useRemote<Rec>(id ? `/api/warehouse/contracts/${id}/outbound-summary` : null, money.revision, money.onExpired);
  const shipments = useRemote<{ items: Rec[] }>(id ? `/api/warehouse/shipments?contract_id=${id}` : null, money.revision, money.onExpired);
  const detail = remote.data;
  const contract = detail?.contract as Rec | undefined;
  const logs = (detail?.logs ?? []) as Rec[];
  const [cash, setCash] = useState<Rec | null>(null);
  if (!contract) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : remote.error || '暂无数据'}</div>;
  async function act(action: string, extra: Record<string, unknown> = {}) {
    try { await money.send(`/api/money/contracts/${contract!.id}/actions`, { action, version: contract!.version, ...extra }); message.success('已保存'); }
    catch (error) { message.error(showError(error)); }
  }
  return <div className="kgd-card">
    <div className="kgd-toolbar"><Button onClick={() => navigate('/customer_contract/list')}>返回</Button><span style={{ flex: 1 }} /><Button onClick={() => act('complete')}>完 成</Button><Button onClick={() => setCash({ ...contract, direction: 'end' })}>终 止</Button></div>
    <div className="kgd-split">
      <div>
        <h3>合同订单({contract.code})</h3>
        <dl className="kgd-detail-grid">
          <div><dt>客户</dt><dd>{contract.customer_name}</dd></div>
          <div><dt>联系人</dt><dd>{contract.contact_name}{contract.contact_phone ? `(${contract.contact_phone})` : ''}</dd></div>
          <div><dt>客户地址</dt><dd>{contract.address}</dd></div>
          <div><dt>销售总数</dt><dd>{contract.qty}</dd></div>
          <div><dt>预付款</dt><dd>{contract.prepay}</dd></div>
          <div><dt>合同金额</dt><dd>{contract.amount}</dd></div>
          <div><dt>累计收款</dt><dd>{contract.received}</dd></div>
          <div><dt>收款进度</dt><dd>{contract.receive_progress}</dd></div>
          <div><dt>累计支出</dt><dd>{contract.spent}</dd></div>
          <div><dt>欠款</dt><dd>{contract.debt}</dd></div>
          <div><dt>已开票金额</dt><dd>{contract.invoiced}</dd></div>
          <div><dt>审核状态</dt><dd><StatusTag text={contract.approval_text} /></dd></div>
          <div><dt>审核通过时间</dt><dd>{beijingTime(contract.approved_at ?? '', '')}</dd></div>
          <div><dt>业务状态</dt><dd>{contract.lifecycle_text}</dd></div>
          <div><dt>合同完成时间</dt><dd>{beijingTime(contract.completed_at ?? '', '')}</dd></div>
          <div><dt>交货日期</dt><dd>{contract.delivery_date}</dd></div>
          <div><dt>收款日期</dt><dd>{contract.receipt_date}</dd></div>
          <div><dt>出库完成日期</dt><dd>{String(outbound.data?.outbound_complete_date ?? '').slice(0, 10)}</dd></div>
          <div><dt>是否含税</dt><dd>{contract.tax_included ? '是' : '否'}</dd></div>
          <div><dt>备注</dt><dd>{contract.note}</dd></div>
          <div><dt>业务员</dt><dd>{contract.salesperson_name}</dd></div>
          <div><dt>创建人</dt><dd>{contract.creator_name}</dd></div>
          <div><dt>创建时间</dt><dd>{beijingTime(contract.created_at ?? '', '')}</dd></div>
        </dl>
      </div>
      <Tabs destroyOnHidden items={[
        { key: 'lines', label: '合同商品', children: <Table size="small" rowKey="id" pagination={{ pageSize: 30 }} dataSource={contract.lines} locale={{ emptyText: '暂无数据' }} scroll={{ x: 'max-content' }} columns={[
          { title: '商品名称', dataIndex: 'product_name' }, { title: '商品编号', dataIndex: 'product_code' }, { title: '规格', dataIndex: 'specification' },
          { title: '商品图片', render: () => '-' }, { title: '类别', render: () => '-' }, { title: '单价', dataIndex: 'unit_price' },
          { title: '销售数量', dataIndex: 'quantity' }, { title: '库存', render: () => '-' }, { title: '单位', dataIndex: 'unit_name' },
          { title: '金额', dataIndex: 'amount' }, { title: '折扣', dataIndex: 'discount_text' }, { title: '优惠金额', dataIndex: 'concession' },
          { title: '折后金额', dataIndex: 'net_amount' }, { title: '投产进度', render: (_: unknown, line: Rec) => line.produce_progress ? <ProgressCell progress={String(line.produce_progress)} /> : '-' }, { title: '出库进度', render: () => contract.outbound_progress ? <ProgressCell progress={String(contract.outbound_progress)} /> : '-' },
          { title: '计划进度', render: () => '-' }, { title: '采购进度', render: () => '-' }, { title: '备注', dataIndex: 'note' }, { title: '附件', render: () => '-' },
        ]} /> },
        { key: 'cash', label: '收支记录', children: <><div className="kgd-toolbar"><Button style={{ background: '#52c41a', color: '#fff' }} onClick={() => setCash({ ...contract, direction: 'in' })}>收 款</Button><Button danger onClick={() => setCash({ ...contract, direction: 'out' })}>支 出</Button></div><Table<Rec> size="small" rowKey="id" dataSource={(detail?.cash ?? []) as Rec[]} locale={{ emptyText: '暂无数据' }} scroll={{ x: 'max-content' }} columns={[{ title: '收/支', dataIndex: 'direction_text' }, { title: '金额', dataIndex: 'amount' }, { title: '附件', render: () => '-' }, { title: '备注', dataIndex: 'note' }, { title: '审核状态', dataIndex: 'approval_text' }, { title: '审核详情', render: () => '-' }, { title: '创建人', dataIndex: 'creator_name' }, { title: '创建时间', dataIndex: 'created_at', render: (value: string) => beijingTime(value ?? '', '') }, { title: '操作', render: () => '-' }]} /></> },
        { key: 'work', label: '加工单', children: <Table<Rec> size="small" rowKey="id" dataSource={(Array.isArray(detail?.work_orders) ? detail.work_orders : []) as Rec[]} locale={{ emptyText: '暂无数据' }} columns={[{ title: '加工单号', dataIndex: 'code' }, { title: '商品', dataIndex: 'product_name' }, { title: '商品编号', dataIndex: 'product_code' }, { title: '计划数', dataIndex: 'plan_qty' }, { title: '状态', render: (_, row) => ({ not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' } as Record<string, string>)[String(row.execution)] ?? '-' }]} /> },
        { key: 'invoice', label: '发票管理', children: <Table size="small" rowKey="id" dataSource={detail?.invoices ?? []} locale={{ emptyText: '暂无数据' }} columns={[{ title: '开票金额', dataIndex: 'amount' }, { title: '申请备注', dataIndex: 'apply_note' }, { title: '开票状态', dataIndex: 'status_text' }, { title: '开票备注', dataIndex: 'invoice_note' }, { title: '开票人', dataIndex: 'invoicer_name' }, { title: '申请人', dataIndex: 'applicant_name' }]} /> },
        { key: 'fee', label: '销售费用', children: <Table size="small" rowKey="id" dataSource={detail?.expenses ?? []} locale={{ emptyText: '暂无数据' }} columns={[{ title: '支出日期', dataIndex: 'spent_on' }, { title: '支出类别', dataIndex: 'category' }, { title: '金额', dataIndex: 'amount' }, { title: '审核', dataIndex: 'approval_text' }, { title: '结算', dataIndex: 'settled_text' }]} /> },
        { key: 'ship', label: '销售出库', children: <Table size="small" rowKey="id" dataSource={shipments.data?.items ?? []} locale={{ emptyText: '暂无数据' }} columns={[{ title: '销售出库单号', dataIndex: 'code' }, { title: '出库日期', dataIndex: 'ship_date' }, { title: '审核状态', dataIndex: 'audit_status' }, { title: '仓库', dataIndex: 'warehouse_id' }]} /> },
        { key: 'return', label: '销售退货', children: <div>暂无数据</div> },
        { key: 'po', label: '采购单', children: <Table size="small" rowKey="id" dataSource={detail?.purchase_orders ?? []} locale={{ emptyText: '暂无数据' }} columns={[{ title: '采购单号', dataIndex: 'code' }, { title: '供应商', dataIndex: 'supplier_name' }, { title: '审核状态', dataIndex: 'approval' }]} /> },
        { key: 'project', label: '关联项目', children: <Table size="small" rowKey="id" dataSource={detail?.projects ?? []} locale={{ emptyText: '暂无数据' }} scroll={{ x: 'max-content' }} columns={[{ title: '项目编号', dataIndex: 'code' }, { title: '项目名称', dataIndex: 'name' }, { title: '工单数', render: () => '-' }, { title: '已完成工单', render: () => '-' }, { title: '计划数', render: () => '-' }, { title: '生产进度', render: () => '-' }, { title: '项目进度', render: () => '-' }, { title: '创建时间', render: () => '-' }, { title: '更新时间', render: () => '-' }, { title: '创建人', render: () => '-' }, { title: '更新人', render: () => '-' }]} /> },
        { key: 'end', label: '合同终止', children: <Table size="small" rowKey="id" dataSource={detail?.terminations ?? []} locale={{ emptyText: '暂无数据' }} columns={[{ title: '终止原因', dataIndex: 'reason_name' }, { title: '终止说明', dataIndex: 'note' }, { title: '终止前状态', dataIndex: 'before_status' }, { title: '已收款金额（元）', dataIndex: 'received_amount' }, { title: '剩余欠款（元）', dataIndex: 'debt_amount' }, { title: '操作人', dataIndex: 'operator_name' }, { title: '终止时间', dataIndex: 'created_at', render: (value: string) => beijingTime(value ?? '', '') }]} /> },
        { key: 'log', label: '日志', children: logs.length ? <div>{logs.map((row) => <div key={row.id}>{beijingTime(row.created_at, '')} {row.actor_name} {row.message}</div>)}</div> : <div>暂无数据</div> },
      ]} />
    </div>
    {cash && cash.direction !== 'end' && <CashModal row={cash} onClose={() => setCash(null)} />}
    {cash?.direction === 'end' && <EndModal row={cash} onClose={() => setCash(null)} />}
  </div>;
}
