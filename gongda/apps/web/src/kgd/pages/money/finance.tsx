import { useEffect, useState } from 'react';
import { Button, Dropdown, Form, Input, Modal, Select, Switch, Table, Tooltip } from 'antd';
import { App } from 'antd';
import dayjs from 'dayjs';
import { useRemote } from '../../../masterTools';
import { ListFrame } from '../../ListFrame';
import { useExtForm, useExtList } from '../../extensions/bind';
import { confirmText, showError, StatusTag, useQueryState, beijingTime } from '../../kit';
import { printDoc } from '../../print';
import { FlowModal } from '../audit/FlowModal';
import { sumMoney } from './math';
import { DayField, expenseDoc, FileDrop, type Rec, searchPlaceholder, shipmentTip, SummaryBar, useMoney } from './shared';
import { requestKey } from '../../../requestKey';

export function CashList() {
  const { message } = App.useApp();
  const money = useMoney();
  const query = useQueryState();
  const [open, setOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [edit, setEdit] = useState<Rec | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const extList = useExtList('customer_financier');
  const remote = useRemote<{ items: Rec[]; summary: { income: string; spend: string } }>(`/api/money/cash?approval=${query.chips.approval ?? 'all'}&q=${encodeURIComponent(query.query.q ?? '')}`, money.revision, money.onExpired);
  async function batchDelete() {
    const rows = (remote.data?.items ?? []).filter((row) => selected.includes(String(row.id)));
    const failed: string[] = [];
    for (const row of rows) {
      try { await money.send(`/api/money/cash/${row.id}/actions`, { action: 'delete' }); }
      catch (error) { failed.push(`${String(row.customer_name ?? row.id)}：${showError(error)}`); }
    }
    setSelected([]);
    if (failed.length) message.warning(`未删除 ${failed.length} 条：${failed.join('；')}`);
    else message.success('已删除');
  }
  return <>
    <ListFrame pageKey="cash-list" showMobileCard {...extList.props} rows={(remote.data?.items ?? []).map((row): Rec => ({ ...row, id: String(row.id) }))} loading={remote.loading} error={remote.error} page={query.page} pageSize={query.pageSize} total={remote.data?.items.length ?? 0} onPage={query.onPage}
      rowSelection={{ selected, onChange: setSelected }}
      chips={[{ key: 'approval', label: '审核状态', options: opts('全部:all,通过:approved,退回:rejected,待审:pending,撤回:withdrawn,不需审核:exempt') }]} chipValue={query.chips} onChip={query.onChip}
      queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
      summary={<SummaryBar parts={[['累计收入', remote.data?.summary.income ?? '0'], ['累计支出', remote.data?.summary.spend ?? '0']]} />}
      toolbar={<><Button type="primary" onClick={() => setOpen(true)}>新增</Button><Button type="primary" onClick={() => setOpen(true)}>+收款</Button>
        <Dropdown disabled={!selected.length} menu={{ items: [{ key: 'delete', label: '批量删除', danger: true, onClick: () => confirmText('批量删除', `确定删除所选 ${selected.length} 条收支？已生效的记录会跳过。`, () => void batchDelete()) }] }}><Button disabled={!selected.length}>批量操作</Button></Dropdown>
        <Button onClick={() => setAuditOpen(true)}>审核流程</Button></>}
      columns={[
        { key: 'customer', title: '客户', render: (row) => row.customer_name },
        { key: 'contract', title: '合同编号', render: (row) => row.contract_code },
        { key: 'direction', title: '收/支', render: (row) => <StatusTag text={row.direction_text} /> },
        { key: 'amount', title: '金额', render: (row) => row.amount },
        { key: 'note', title: '备注', render: (row) => row.note },
        { key: 'approval', title: '审核状态', render: (row) => <StatusTag text={row.approval_text} /> },
        { key: 'creator', title: '创建人', render: (row) => row.creator_name },
        { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at ?? '', '') },
        // 原版 money-07：仅退回显示「修改」，通过 / 待审 / 撤回 / 不需审核留空。
        { key: 'actions', title: '操作', width: 120, render: (row) => {
          const returned = row.can_edit === true || row.approval === 'rejected' || row.approval_text === '退回';
          if (!returned) return null;
          return <button type="button" className="kgd-link" onClick={() => setEdit(row)}>修改</button>;
        } },
      ]} />
    {extList.dialog}
    {open && <ShipmentReceipt onClose={() => setOpen(false)} />}
    {edit && <ShipmentReceipt row={edit} onClose={() => setEdit(null)} />}
    {auditOpen && <FlowModal module="customer" flow={null} onClose={() => setAuditOpen(false)} />}
  </>;
}

function allocationAmounts(row?: Rec | null) {
  const raw = row?.allocations;
  const list = Array.isArray(raw) ? raw as Rec[] : [];
  const amounts: Record<string, string> = {};
  for (const item of list) {
    const id = String(item.shipment_line_id ?? '');
    if (id) amounts[id] = String(item.amount ?? '');
  }
  return amounts;
}

function ShipmentReceipt({ row, onClose }: { row?: Rec | null; onClose: () => void }) {
  const editing = !!row;
  const { message } = App.useApp();
  const money = useMoney();
  const customers = useRemote<{ items: Rec[] }>('/api/money/customers', money.revision, money.onExpired);
  const [customerId, setCustomerId] = useState(row?.customer_id ? String(row.customer_id) : '');
  const lines = useRemote<{ items: Rec[]; shipped: string; received: string; debt: string }>(customerId ? `/api/money/shipment-lines?customer_id=${customerId}` : null, money.revision, money.onExpired);
  const [chosen, setChosen] = useState<Rec[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>(() => allocationAmounts(row));
  const [seeded, setSeeded] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickKeys, setPickKeys] = useState<string[]>([]);
  const [note, setNote] = useState(String(row?.note ?? ''));
  const [file, setFile] = useState(String(row?.attachment ?? ''));
  const [manualAmount, setManualAmount] = useState(String(row?.amount ?? ''));
  const extForm = useExtForm('customer_financier', row?.id ? String(row.id) : undefined);
  const receivedSum = sumMoney(chosen.map((item) => amounts[String(item.id)] || '0'));
  useEffect(() => {
    if (!row || seeded || !lines.data) return;
    const ids = new Set(Object.keys(allocationAmounts(row)));
    const matched = (lines.data.items ?? []).filter((item) => ids.has(String(item.id)));
    if (matched.length) setChosen(matched);
    setSeeded(true);
  }, [row, seeded, lines.data]);
  async function save() {
    if (!customerId) { message.error('请选择客户'); return; }
    const body = chosen.map((item) => ({ shipment_line_id: String(item.id), amount: amounts[String(item.id)] || '' })).filter((line) => line.amount);
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      if (editing && row) {
        const amount = chosen.length ? receivedSum : manualAmount.trim();
        if (!amount) { message.error('请填写金额'); return; }
        await money.send(`/api/money/cash/${row.id}`, { amount, note, attachment: file }, 'PATCH');
        await extForm.persist(money.session.csrf_token, String(row.id));
        message.success('已保存');
      } else {
        if (!body.length) { message.error('请选择发货明细并填写收款金额'); return; }
        const saved = await money.send<{ cash?: { id?: string } }>('/api/money/cash', { request_key: requestKey(), customer_id: customerId, lines: body, note, attachment: file });
        if (saved?.cash?.id) await extForm.persist(money.session.csrf_token, saved.cash.id);
        message.success('已提交');
      }
      onClose();
    }
    catch (error) { message.error(showError(error)); }
  }
  function takeLines() {
    const have = new Set(chosen.map((row) => String(row.id)));
    const next = (lines.data?.items ?? []).filter((row) => pickKeys.includes(String(row.id)) && !have.has(String(row.id)));
    setChosen([...chosen, ...next]);
    setPickOpen(false);
    setPickKeys([]);
  }
  return <Modal title={editing ? '修改收款' : '新增收款'} open width={1080} onCancel={onClose} onOk={save} okText="确 定" cancelText="取 消">
    <div className="kgd-banner">{shipmentTip}</div>
    <Form layout="vertical">
      <Form.Item label="客户" required><Select disabled={editing} showSearch optionFilterProp="label" placeholder={searchPlaceholder} value={customerId || undefined} options={(customers.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => { setCustomerId(value); setChosen([]); setAmounts({}); }} /></Form.Item>
      <Form.Item label="已发货(元)"><Input disabled value={lines.data?.shipped ?? '-'} /></Form.Item>
      <Form.Item label="已收款(元)"><Input disabled value={lines.data?.received ?? '-'} /></Form.Item>
      <Form.Item label="待收款(元)"><Input disabled value={lines.data?.debt ?? '-'} /></Form.Item>
      <Form.Item label="收款" required><Input disabled={!!chosen.length || !editing} value={chosen.length ? receivedSum : (editing ? manualAmount : '')} onChange={(event) => setManualAmount(event.target.value)} /></Form.Item>
      <Form.Item label="附件"><FileDrop value={file} onChange={setFile} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea placeholder="备注" maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
      {extForm.node}
    </Form>
    <div className="kgd-toolbar">
      <Tooltip title={shipmentTip}><Button type="primary" disabled={!customerId} onClick={() => { setPickKeys([]); setPickOpen(true); }}>+ 选择发货明细</Button></Tooltip>
    </div>
    <Table size="small" rowKey="id" pagination={false} dataSource={chosen} locale={{ emptyText: '暂无数据' }} columns={[
      { title: '序号', render: (_: unknown, __: Rec, index: number) => index + 1 },
      { title: '销售出库单号', dataIndex: 'shipment_code' },
      { title: '出库日期', dataIndex: 'shipped_at' },
      { title: '商品名', dataIndex: 'product_name' },
      { title: '商品编号', dataIndex: 'product_code' },
      { title: '商品规格', dataIndex: 'specification' },
      { title: '数量', dataIndex: 'quantity' },
      { title: '单位', dataIndex: 'unit_name' },
      { title: '销售单价(元)', dataIndex: 'unit_price' },
      { title: '销售金额(元)', dataIndex: 'amount' },
      { title: '欠款(元)', dataIndex: 'debt' },
      { title: '收款金额(元)', render: (_: unknown, row: Rec) => <Input value={amounts[String(row.id)] ?? ''} onChange={(event) => setAmounts({ ...amounts, [String(row.id)]: event.target.value })} /> },
      { title: '操作', render: (_: unknown, row: Rec) => <button className="kgd-link" onClick={() => setChosen(chosen.filter((item) => String(item.id) !== String(row.id)))}>删除</button> },
    ]} />
    <Modal title="选择发货明细" open={pickOpen} width={860} okText="确 定" cancelText="取 消" onCancel={() => setPickOpen(false)} onOk={(event) => { event.stopPropagation(); takeLines(); }}>
      <Table size="small" rowKey={(row) => String(row.id)} pagination={{ pageSize: 10 }} dataSource={lines.data?.items ?? []} locale={{ emptyText: '暂无数据' }} rowSelection={{ preserveSelectedRowKeys: true, selectedRowKeys: pickKeys, onChange: (keys) => setPickKeys(keys.map(String)) }} columns={[
        { title: '销售出库单号', dataIndex: 'shipment_code' }, { title: '商品名', dataIndex: 'product_name' }, { title: '商品编号', dataIndex: 'product_code' }, { title: '数量', dataIndex: 'quantity' }, { title: '欠款(元)', dataIndex: 'debt' },
      ]} />
    </Modal>
  </Modal>;
}

export function InvoiceList() {
  const { message } = App.useApp();
  const money = useMoney();
  const query = useQueryState();
  const [open, setOpen] = useState(() => !!new URLSearchParams(window.location.search).get('add'));
  const extList = useExtList('customer_invoice');
  const remote = useRemote<{ items: Rec[] }>(`/api/money/invoices?status=${query.chips.status ?? 'all'}&q=${encodeURIComponent(query.query.q ?? '')}`, money.revision, money.onExpired);
  return <>
    <ListFrame pageKey="invoice-list" showMobileCard {...extList.props} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} page={query.page} pageSize={query.pageSize} total={remote.data?.items.length ?? 0} onPage={query.onPage}
      chips={[{ key: 'status', label: '开票状态', options: opts('全部:all,待开票:pending,开票完毕:done') }]} chipValue={query.chips} onChip={query.onChip}
      queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
      toolbar={<><Button type="primary" onClick={() => setOpen(true)}>新增</Button><Button type="primary" onClick={() => setOpen(true)}>申请开票</Button></>}
      columns={[
        { key: 'customer', title: '客户', render: (row) => row.customer_name },
        { key: 'contract', title: '合同编号', render: (row) => row.contract_code },
        { key: 'contractAmount', title: '合同金额', render: (row) => row.contract_amount },
        { key: 'invoiced', title: '已开票金额', render: (row) => row.invoiced_amount },
        { key: 'amount', title: '开票金额', render: (row) => row.amount },
        { key: 'status', title: '开票状态', render: (row) => row.status_text },
        { key: 'apply', title: '申请备注', render: (row) => row.apply_note },
        { key: 'note', title: '开票备注', render: (row) => row.invoice_note },
        { key: 'who', title: '开票人', render: (row) => row.invoicer_name },
        { key: 'when', title: '开票时间', render: (row) => beijingTime(row.invoiced_at ?? '', '') },
        { key: 'actions', title: '操作', render: (row) => row.status === 'pending' ? <span><button className="kgd-link" onClick={() => Modal.info({ title: '发票详情', content: `${row.customer_name} ${row.contract_code} 申请 ${row.amount}` })}>详情</button> <button className="kgd-link" onClick={() => finish(row)}>开票完毕</button></span> : '' },
      ]} />
    {extList.dialog}
    {open && <ApplyInvoice onClose={() => setOpen(false)} />}
  </>;
  function finish(row: Rec) {
    let note = '';
    Modal.confirm({ title: '开票完毕', content: <Input.TextArea placeholder="开票备注" onChange={(event) => { note = event.target.value; }} />, okText: '确定', cancelText: '取消', onOk: async () => { await money.send(`/api/money/invoices/${row.id}/actions`, { action: 'finish', invoice_note: note }); message.success('已开票完毕'); } });
  }
}

function ApplyInvoice({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const contracts = useRemote<{ items: Rec[] }>('/api/money/contracts', money.revision, money.onExpired);
  const [contractId, setContractId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState('');
  const [err, setErr] = useState('');
  const contract = contracts.data?.items.find((item) => item.id === contractId);
  const extForm = useExtForm('customer_invoice');
  async function save() {
    if (!contractId) { setErr('请选择合同'); message.error('请选择合同'); return; }
    if (!amount.trim()) { setErr('请填写开票金额'); message.error('请填写开票金额'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    setErr('');
    try {
      const saved = await money.send<{ invoice?: { id?: string } }>('/api/money/invoices', { request_key: requestKey(), contract_id: contractId, amount, apply_note: note, attachment: file });
      if (saved?.invoice?.id) await extForm.persist(money.session.csrf_token, saved.invoice.id);
      message.success('已申请');
      onClose();
    }
    catch (error) { message.error(showError(error)); }
  }
  return <Modal title="申请开票" open onCancel={onClose} footer={<><Button onClick={onClose}>关 闭</Button><Button type="primary" onClick={() => void save()}>提交申请</Button></>}>
    {err ? <div className="kgd-banner kgd-field-error">{err}</div> : null}
    <Form layout="vertical">
      <Form.Item label="合同" required validateStatus={err === '请选择合同' ? 'error' : undefined}><Select showSearch optionFilterProp="label" placeholder="点击选择合同" options={(contracts.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.customer_name}` }))} onChange={(value) => { setErr(''); setContractId(value); }} /></Form.Item>
      <Form.Item label="合同金额 (元)"><Input disabled value={contract?.amount ?? ''} /></Form.Item>
      <Form.Item label="已开票金额"><Input disabled value={contract?.invoiced ?? ''} /></Form.Item>
      <Form.Item label="开票金额 (元)" required validateStatus={err === '请填写开票金额' ? 'error' : undefined}><Input value={amount} onChange={(event) => { setErr(''); setAmount(event.target.value); }} /></Form.Item>
      <Form.Item label="附件"><FileDrop value={file} onChange={setFile} /></Form.Item>
      <Form.Item label="申请备注"><Input.TextArea value={note} maxLength={200} placeholder="申请备注" onChange={(event) => setNote(event.target.value)} /></Form.Item>
      {extForm.node}
    </Form>
  </Modal>;
}

export function ExpenseList() {
  const { message } = App.useApp();
  const money = useMoney();
  const query = useQueryState();
  const [open, setOpen] = useState(false);
  const extList = useExtList('selling_expense');
  const remote = useRemote<{ items: Rec[]; cards: Rec }>(`/api/money/expenses?approval=${query.chips.approval ?? 'all'}&settled=${query.chips.settled ?? 'all'}&q=${encodeURIComponent(query.query.q ?? '')}`, money.revision, money.onExpired);
  const cards = remote.data?.cards;
  async function act(row: Rec, action: string, extra: Record<string, unknown> = {}) {
    try { await money.send(`/api/money/expenses/${row.id}/actions`, { action, ...extra }); message.success('已保存'); }
    catch (error) { message.error(showError(error)); }
  }
  return <>
    <div className="kgd-cards">
      <div className="kgd-stat c1"><span>总金额</span><b>{cards?.total ?? '0'}</b></div>
      <div className="kgd-stat c2"><span>待审金额</span><b>{cards?.pending ?? '0'}</b></div>
      <div className="kgd-stat c3"><span>已审金额</span><b>{cards?.approved ?? '0'}</b></div>
      <div className="kgd-stat c4"><span>待结算金额</span><b>{cards?.unsettled ?? '0'}</b></div>
      <div className="kgd-stat c5"><span>已结算金额</span><b>{cards?.settled ?? '0'}</b></div>
    </div>
    <ListFrame pageKey="expense-list" showMobileCard {...extList.props} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} page={query.page} pageSize={query.pageSize} total={remote.data?.items.length ?? 0} onPage={query.onPage}
      chips={[{ key: 'approval', label: '审核', options: opts('全部:all,待审:pending,退回:rejected,通过:approved,撤回:withdrawn,不需审核:exempt') }, { key: 'settled', label: '结算', options: opts('全部:all,待结算:no,已结算:yes') }]} chipValue={query.chips} onChip={query.onChip}
      queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear}
      toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>}
      columns={[
        { key: 'customer', title: '客户', render: (row) => row.customer_name },
        { key: 'contract', title: '合同编号', render: (row) => row.contract_code },
        { key: 'date', title: '支出日期', render: (row) => row.spent_on },
        { key: 'category', title: '支出类别', render: (row) => row.category },
        { key: 'amount', title: '金额', render: (row) => row.amount },
        { key: 'note', title: '备注', render: (row) => row.note },
        { key: 'creator', title: '创建人', render: (row) => row.creator_name },
        { key: 'approval', title: '审核', render: (row) => <StatusTag text={row.approval_text} /> },
        { key: 'settled', title: '结算', render: (row) => row.settled_text },
        { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at ?? '', '') },
        { key: 'actions', title: '操作', render: (row) => <span>
          <button className="kgd-link" onClick={() => printDoc(expenseDoc(row))}>打印</button>
          {row.approval === 'pending' && <button className="kgd-link" onClick={() => act(row, 'approve', { opinion: '同意' })}>审核</button>}
          {(row.approval === 'approved' || row.approval === 'exempt') && !row.settled && <button className="kgd-link" onClick={() => act(row, 'settle')}>结算</button>}
          {row.approval === 'pending' && <button className="kgd-link" onClick={() => confirmText('删除', '确定删除该费用？', () => void act(row, 'delete'))}>删除</button>}
        </span> },
      ]} />
    {open && <ExpenseModal onClose={() => setOpen(false)} />}
    {extList.dialog}
  </>;
}

function ExpenseModal({ onClose }: { onClose: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const customers = useRemote<{ items: Rec[] }>('/api/money/customers', money.revision, money.onExpired);
  const contracts = useRemote<{ items: Rec[] }>('/api/money/contracts', money.revision, money.onExpired);
  const [customerId, setCustomerId] = useState('');
  const [contractId, setContractId] = useState('');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState('');
  const extForm = useExtForm('selling_expense');
  async function save() {
    if (!customerId) { message.error('请选择客户'); return; }
    if (!date) { message.error('请选择支出日期'); return; }
    if (!category) { message.error('请选择支出类别'); return; }
    if (!amount.trim()) { message.error('请填写金额'); return; }
    const extErr = extForm.error();
    if (extErr) { message.error(extErr); return; }
    try {
      const saved = await money.send<{ expense?: { id?: string } }>('/api/money/expenses', { request_key: requestKey(), customer_id: customerId, contract_id: contractId || null, spent_on: date, category, amount, note, attachment: file });
      if (saved?.expense?.id) await extForm.persist(money.session.csrf_token, saved.expense.id);
      message.success('已保存');
      onClose();
    }
    catch (error) { message.error(showError(error)); }
  }
  return <Modal title="新增销售费用" open onCancel={onClose} onOk={save} okText="确 定" cancelText="取 消">
    <Form layout="vertical">
      <Form.Item label="客户" required><Select showSearch optionFilterProp="label" placeholder={searchPlaceholder} options={(customers.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} onChange={setCustomerId} /></Form.Item>
      <Form.Item label="合同"><Select allowClear placeholder="点击选择合同" options={(contracts.data?.items ?? []).filter((item) => !customerId || item.customer_id === customerId).map((item) => ({ value: item.id, label: item.code }))} onChange={(value) => setContractId(value ?? '')} /></Form.Item>
      <Form.Item label="支出日期" required><DayField value={date} onChange={setDate} /></Form.Item>
      <Form.Item label="支出类别" required><Select placeholder="请选择" options={['差旅费', '招待', '赠礼', '回扣'].map((item) => ({ value: item, label: item }))} onChange={setCategory} /></Form.Item>
      <Form.Item label="金额" required><Input value={amount} onChange={(event) => setAmount(event.target.value)} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
      <Form.Item label="附件"><FileDrop value={file} onChange={setFile} /></Form.Item>
      {extForm.node}
    </Form>
  </Modal>;
}

export function BaseSetting() {
  const { message } = App.useApp();
  const money = useMoney();
  const remote = useRemote<{ settings: Rec; tags: Rec[]; end_reasons: Rec[] }>('/api/money/settings', money.revision, money.onExpired);
  const settings = remote.data?.settings;
  const [form, setForm] = useState<Rec | null>(null);
  const current = form ?? settings;
  if (!current) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : remote.error}</div>;
  function set(key: string, value: unknown) {
    const base = form ?? settings;
    if (!base) return;
    setForm({ ...base, [key]: value });
  }
  async function save() {
    const body = form ?? settings;
    if (!body) return;
    try { await money.send('/api/money/settings', body, 'PUT'); message.success('已保存'); setForm(null); }
    catch (error) { message.error(showError(error)); }
  }
  return <div className="kgd-card"><div className="kgd-split">
    <div>
      <SwitchRow label="客户重名检查" help="开启后，重名客户将无法录入到系统" checked={!!current.duplicate_name} onChange={(value) => set('duplicate_name', value)} />
      <SwitchRow label="客户手机号不允许重复" help="开启后，重复的手机号码将无法录入到系统" checked={!!current.unique_phone} onChange={(value) => set('unique_phone', value)} />
      <SwitchRow label="报价单/合同订单支持自动计算" help="开启后，报价金额/合同金额不支持手动填写，系统将自动计算商品的折后金额进行填充" checked={!!current.auto_calc} onChange={(value) => set('auto_calc', value)} />
      <Formula label="合同明细金额计算公式" formula={current.contract_formula} scale={current.contract_scale} onFormula={(value) => set('contract_formula', value)} onScale={(value) => set('contract_scale', value)} />
      <Formula label="合同报价单明细金额计算公式" formula={current.quote_formula} scale={current.quote_scale} onFormula={(value) => set('quote_formula', value)} onScale={(value) => set('quote_scale', value)} />
      <SwitchRow label="手机号码全文检索" help="开启后将无法按照手机号码模糊搜索客户，只能通过手机号码全文搜索客户" checked={!!current.phone_exact} onChange={(value) => set('phone_exact', value)} />
      <SwitchRow label="合同收款设置" help="开启后，合同收款总金额不能超过合同金额；关闭后，收款总金额不做限制。" checked={!!current.receipt_cap} onChange={(value) => set('receipt_cap', value)} />
      <div>合同订单交货即将逾期提醒　到合同订单交货日期前 <Input style={{ width: 64 }} value={current.delivery_remind_days} onChange={(event) => set('delivery_remind_days', Number(event.target.value || 0))} /> 天提醒下方人员（每天早上9点提醒，值为0时当天提醒）　人员：创建人</div>
      <div style={{ margin: '8px 0 12px' }}>合同订单收款即将逾期提醒　到合同订单收款日期前 <Input style={{ width: 64 }} value={current.receipt_remind_days} onChange={(event) => set('receipt_remind_days', Number(event.target.value || 0))} /> 天提醒下方人员（每天早上9点提醒，值为0时当天提醒）　人员：创建人</div>
      <Button type="primary" onClick={save} loading={money.busy}>保存</Button>
    </div>
    <div>
      <TagTable title="客户标签" kind="customer" rows={remote.data?.tags ?? []} />
      <ReasonTable rows={remote.data?.end_reasons ?? []} />
    </div>
  </div></div>;
}

function SwitchRow({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div style={{ marginBottom: 12 }}><b>{label}</b><div className="kgd-muted">{help}</div><Switch checked={checked} onChange={onChange} /></div>;
}
function Formula({ label, formula, scale, onFormula, onScale }: { label: string; formula: string; scale: number; onFormula: (value: string) => void; onScale: (value: number) => void }) {
  return <div style={{ marginBottom: 12 }}><b>{label}</b><Input value={formula} onChange={(event) => onFormula(event.target.value)} /><div>小数位数 <Input style={{ width: 64 }} value={scale} onChange={(event) => onScale(Number(event.target.value || 0))} /></div></div>;
}
function TagTable({ title, kind, rows }: { title: string; kind: string; rows: Rec[] }) {
  const { message } = App.useApp();
  const money = useMoney();
  const [name, setName] = useState('');
  async function add() { try { await money.send('/api/money/tags', { kind, name, sort: rows.length + 1 }); setName(''); } catch (error) { message.error(showError(error)); } }
  return <div style={{ marginBottom: 16 }}><h4>{title}</h4><div className="kgd-toolbar"><Input value={name} placeholder="名称" onChange={(event) => setName(event.target.value)} /><Button onClick={add}>+新增</Button></div><Table size="small" rowKey="id" pagination={false} dataSource={rows} columns={[{ title: '排序', dataIndex: 'sort' }, { title: '名称', dataIndex: 'name' }, { title: '操作', render: (_: unknown, row: Rec) => <button className="kgd-link" onClick={() => confirmText('删除标签', '确定删除？', () => void money.send(`/api/money/tags/${row.id}`, {}, 'DELETE'))}>删除</button> }]} /></div>;
}
function ReasonTable({ rows }: { rows: Rec[] }) {
  const { message } = App.useApp();
  const money = useMoney();
  const [name, setName] = useState('');
  return <div><h4>合同终止原因</h4><div className="kgd-toolbar"><Input value={name} placeholder="名称" onChange={(event) => setName(event.target.value)} /><Button onClick={() => money.send('/api/money/end-reasons', { name, sort: rows.length + 1 }).then(() => setName('')).catch((error) => message.error(showError(error)))}>+新增</Button></div><Table size="small" rowKey="id" pagination={false} locale={{ emptyText: '暂无数据' }} dataSource={rows} columns={[{ title: '排序', dataIndex: 'sort' }, { title: '名称', dataIndex: 'name' }, { title: '操作', render: (_: unknown, row: Rec) => <button className="kgd-link" onClick={() => void money.send(`/api/money/end-reasons/${row.id}`, {}, 'DELETE')}>删除</button> }]} /></div>;
}

function opts(text: string) { return text.split(',').map((item) => { const [label, value] = item.split(':'); return { label: label!, value: value! }; }); }

export { AuditSettingPage as MoneyAuditSetting } from '../audit/AuditSettingPage';
