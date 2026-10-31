import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, DatePicker, Form, Input, InputNumber, Modal, Select, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { useRemote } from '../../../../masterTools';
import { ListFrame } from '../../../ListFrame';
import type { QueryField } from '../../../ListFrame';
import { useQueryState } from '../../../kit';
import { printDocs } from '../../../print';
import { ProgressCell } from '../../progress/ProgressCell';
import { dash, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';
import { blank, idFromPath } from './common';

export const expenseTypes = ['水电费', '房租', '折旧', '管理费用', '其他', '水费', '电费', '人工费用', '物料费用'];
export const shareMethods = ['按计划数', '按实际生产数', '按报工工时', '手工'];
const methodOptions = [
  { value: '按计划数', label: '按计划数分摊' },
  { value: '按报工工时', label: '按生产时长分摊' },
  { value: '按实际生产数', label: '按实际生产数分摊' },
];
const categoryOptions = ['水费', '电费', '人工费用', '物料费用'];

type Line = { work_order_id: string; work_order_code: string; product_name: string; basis: string; ratio: string; amount: string };

const queryFields: QueryField[] = [
  { key: 'keyword', label: '分摊单号' },
  { key: 'date_from', label: '分摊日期起', kind: 'date' },
  { key: 'date_to', label: '分摊日期止', kind: 'date' },
  { key: 'expense_type', label: '分摊类别', kind: 'select', options: [{ value: '', label: '全部' }, ...categoryOptions.map((value) => ({ value, label: value }))] },
  { key: 'status', label: '审核状态', kind: 'select', options: [{ value: '', label: '全部' }, { value: '草稿', label: '待审核' }, { value: '已分摊', label: '已审核' }] },
  { key: 'created_from', label: '创建时间起', kind: 'date' },
  { key: 'created_to', label: '创建时间止', kind: 'date' },
];

/** 按依据值把总金额按分拆开，尾差放最后一行，保证合计等于总金额（与后端算法一致，仅用于预览）。 */
export function allocate(total: string, bases: number[]) {
  const cents = Math.round(Number(total || 0) * 100);
  const sum = bases.reduce((acc, value) => acc + value, 0);
  if (!bases.length || cents <= 0 || sum <= 0) return bases.map(() => ({ ratio: 0, cents: 0 }));
  const ratios = bases.map((value) => value / sum);
  const parts = ratios.map((ratio) => Math.floor(cents * ratio));
  parts[parts.length - 1]! += cents - parts.reduce((acc, value) => acc + value, 0);
  return ratios.map((ratio, index) => ({ ratio, cents: parts[index]! }));
}

const money = (cents: number) => (cents / 100).toFixed(2);

export function CostShareList() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/apportioned_cost/add')) return <CostShareEditor id="" />;
  const editId = idFromPath(pathname, '/apportioned_cost/edit/');
  if (editId) return <CostShareEditor id={editId} />;
  const detailId = idFromPath(pathname, '/apportioned_cost/detail/');
  if (detailId) return <CostShareDetail id={detailId} />;
  return <CostShareTable />;
}

function CostShareTable() {
  const r10 = useR10();
  const navigate = useNavigate();
  const list = useQueryState();
  const [createOpen, setCreateOpen] = useState(false);
  const remote = useList<Row>(`/api/cost-shares${qs({
    keyword: list.query.keyword,
    expense_type: list.query.expense_type,
    status: list.query.status,
    period_from: list.query.date_from,
    period_to: list.query.date_to,
    page: list.page,
    page_size: list.pageSize,
  })}`);
  const rows = remote.data?.items ?? [];
  const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2);
  return <>
    <ListFrame<Row> pageKey="cost_share" exportName="成本分摊" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={queryFields} defaultQueryKeys={['keyword', 'date_from', 'date_to', 'expense_type', 'status']} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} onApplyQuery={list.onApplyQuery}
      page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage} clientPaging={false}
      toolbar={<Button type="primary" onClick={() => setCreateOpen(true)}>新增</Button>}
      summary={<div className="kgd-summary">【分摊总金额】<b className="kgd-overdue-mark">{totalAmount}</b></div>}
      columns={[
        { key: 'code', title: '分摊单号', render: (row) => <button className="kgd-link" onClick={() => navigate(`/apportioned_cost/detail/${row.id}`)}>{row.code}</button> },
        { key: 'share_date', title: '分摊日期', render: (row) => dash(row.period_start) },
        { key: 'amount', title: '分摊金额(元)', render: (row) => dash(row.amount) },
        { key: 'method', title: '分摊方案', render: (row) => methodOptions.find((item) => item.value === row.method)?.label ?? dash(row.method) },
        { key: 'type', title: '分摊类别', render: (row) => dash(row.expense_type) },
        { key: 'status', title: '审核状态', render: (row) => row.status === '已分摊' ? <Tag color="green">已审核</Tag> : <Tag>待审核</Tag> },
        { key: 'audit_note', title: '审核备注', render: () => '-' },
        { key: 'note', title: '备注', render: (row) => dash(row.note) },
        { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
        { key: 'created', title: '创建时间', width: 160, render: (row) => dash(row.created_text) },
        { key: 'actions', title: '操作', width: 200, render: (row) => <>
          <button className="kgd-link" onClick={() => navigate(`/apportioned_cost/detail/${row.id}`)}>详情</button>{' '}
          {row.status !== '已分摊' && <>
            <button className="kgd-link" onClick={() => navigate(`/apportioned_cost/edit/${row.id}`)}>修改</button>{' '}
            <button className="kgd-link" onClick={() => r10.confirmDelete('确认分摊', () => r10.act(`/api/cost-shares/${row.id}/share`, { version: row.version }, 'POST', '已分摊'), '分摊后将锁定，成本报表的成本分摊金额随之变化，确定分摊？')}>分摊</button>{' '}
            <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除成本分摊', () => r10.act(`/api/cost-shares/${row.id}`, {}, 'DELETE', '已删除'))}>删除</button>
          </>}
        </> },
      ]} />
    <CostShareCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
  </>;
}

function CostShareCreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const r10 = useR10();
  const [code, setCode] = useState('');
  const [shareDate, setShareDate] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('按计划数');
  const [category, setCategory] = useState('水费');
  const [note, setNote] = useState('');
  const [pickOpen, setPickOpen] = useState(false);
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const periodStart = shareDate || dayjs().startOf('month').format('YYYY-MM-DD');
  const periodEnd = shareDate || dayjs().endOf('month').format('YYYY-MM-DD');
  const candidates = useList<Row>(open ? `/api/cost-shares/candidates${qs({ method, period_start: periodStart, period_end: periodEnd })}` : null);
  const pool = candidates.data?.items ?? [];
  const lines = orderIds.map((id, index) => {
    const row = pool.find((item) => String(item.id) === id);
    return {
      key: id,
      seq: index + 1,
      code: blank(row?.code),
      product_name: blank(row?.product_name),
      product_code: blank(row?.product_code),
      spec: blank(row?.specification),
      unit: blank(row?.unit_name),
      plan_qty: blank(row?.plan_qty),
      hours: blank(row?.hours_text),
      output: blank(row?.output_qty),
      progress: String(row?.process_progress ?? '0% (0/0)'),
      amount: '',
      note: blank(row?.note),
    };
  });
  async function save() {
    if (!shareDate) { r10.message.error('请选择日期'); return; }
    if (!(Number(amount) > 0)) { r10.message.error('请输入分摊金额'); return; }
    if (!orderIds.length) { r10.message.warning('请选择加工单'); return; }
    const result = await r10.act('/api/cost-shares', {
      name: `成本分摊 ${shareDate}`,
      expense_type: category,
      amount,
      period_start: shareDate,
      period_end: shareDate,
      method,
      note,
      work_order_ids: orderIds,
    }, 'POST');
    if (result) onClose();
  }
  return <>
    <Modal title="新增成本分摊" open={open} onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" width={1100} destroyOnHidden>
      <Form layout="vertical">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Form.Item label="分摊单号"><Input value={code} placeholder="请填写，忽略将自动生成" onChange={(event) => setCode(event.target.value)} /></Form.Item>
          <Form.Item label="分摊日期" required><DatePicker style={{ width: '100%' }} placeholder="请选择日期" value={shareDate ? dayjs(shareDate) : null} onChange={(value) => setShareDate(value ? value.format('YYYY-MM-DD') : '')} /></Form.Item>
          <Form.Item label="分摊金额(元)" required><InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} placeholder="请输入分摊金额" value={amount} onChange={(value) => setAmount(value ?? '')} /></Form.Item>
          <Form.Item label="分摊方案"><Select value={method} options={methodOptions} onChange={setMethod} /></Form.Item>
          <Form.Item label="分摊类别"><Select value={category} options={categoryOptions.map((value) => ({ value, label: value }))} onChange={setCategory} /></Form.Item>
          <Form.Item label="备注"><Input.TextArea maxLength={255} value={note} onChange={(event) => setNote(event.target.value)} placeholder={`0/255`} /></Form.Item>
        </div>
      </Form>
      <div className="kgd-toolbar">
        <Button type="primary" onClick={() => { setPicked(orderIds); setPickOpen(true); }}>+ 选择加工单</Button>
        <Button onClick={() => setOrderIds([])}>清空</Button>
      </div>
      <Table size="small" rowKey="key" pagination={false} dataSource={lines} locale={{ emptyText: '暂无数据' }} scroll={{ x: 'max-content' }}
        columns={[
          { title: '序号', dataIndex: 'seq', width: 60 },
          { title: '加工单号', dataIndex: 'code' },
          { title: '商品名称', dataIndex: 'product_name' },
          { title: '商品编号', dataIndex: 'product_code' },
          { title: '商品规格', dataIndex: 'spec' },
          { title: '单位', dataIndex: 'unit' },
          { title: '计划数量', dataIndex: 'plan_qty' },
          { title: '生产时长', dataIndex: 'hours' },
          { title: '实际生产数', dataIndex: 'output' },
          { title: '工序进度', render: (_, row) => <ProgressCell progress={row.progress} /> },
          { title: '分摊金额(元)', dataIndex: 'amount' },
          { title: '备注', dataIndex: 'note' },
          { title: '操作', render: (_, row) => <button className="kgd-link" onClick={() => setOrderIds((current) => current.filter((id) => id !== row.key))}>删除</button> },
        ]} />
    </Modal>
    <Modal title="选择加工单" open={pickOpen} onCancel={() => setPickOpen(false)} onOk={() => { setOrderIds(picked); setPickOpen(false); }} okText="确 定" cancelText="取 消" width={960}>
      <Table size="small" rowKey="id" pagination={{ pageSize: 10, showTotal: (n) => `共${n}条数据` }} dataSource={pool} locale={{ emptyText: '暂无数据' }}
        rowSelection={{ selectedRowKeys: picked, onChange: (keys) => setPicked(keys.map(String)) }}
        columns={[
          { title: '加工单号', dataIndex: 'code' },
          { title: '商品名称', dataIndex: 'product_name' },
          { title: '商品编号', dataIndex: 'product_code' },
          { title: '商品规格', render: (_, row) => dash(row.specification) },
          { title: '商品图片', render: () => '-' },
          { title: '计划数量', dataIndex: 'plan_qty' },
          { title: '工序进度', render: (_, row) => <ProgressCell progress={String(row.process_progress ?? '0% (0/0)')} /> },
          { title: '加工单备注', render: (_, row) => dash(row.note) },
          { title: '图纸', render: () => '-' },
        ]} />
    </Modal>
  </>;
}

function CostShareEditor({ id }: { id: string }) {
  const r10 = useR10();
  const navigate = useNavigate();
  const current = useRemote<{ share?: Row; lines?: Row[] }>(id ? `/api/cost-shares/${id}` : null, r10.revision, r10.onExpired);
  const [loaded, setLoaded] = useState(!id);
  const [name, setName] = useState('');
  const [type, setType] = useState('水电费');
  const [amount, setAmount] = useState('');
  const [start, setStart] = useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [end, setEnd] = useState(dayjs().endOf('month').format('YYYY-MM-DD'));
  const [method, setMethod] = useState('按计划数');
  const [note, setNote] = useState('');
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const [manual, setManual] = useState<Record<string, string>>({});
  useEffect(() => {
    const share = current.data?.share;
    if (!share || loaded) return;
    setName(blank(share.name)); setType(share.expense_type ?? '水电费'); setAmount(blank(share.amount));
    setStart(blank(share.period_start)); setEnd(blank(share.period_end)); setMethod(share.method ?? '按计划数'); setNote(blank(share.note));
    const lines = current.data?.lines ?? [];
    setOrderIds(lines.map((line) => String(line.work_order_id)));
    setManual(Object.fromEntries(lines.map((line) => [String(line.work_order_id), blank(line.amount)])));
    setLoaded(true);
  }, [current.data, loaded]);
  const candidates = useList<Row>(start && end && start <= end ? `/api/cost-shares/candidates${qs({ method: method === '手工' ? '按计划数' : method, period_start: start, period_end: end })}` : null);
  const pool = candidates.data?.items ?? [];
  const lines: Line[] = useMemo(() => {
    const items = orderIds.map((orderId) => pool.find((item) => String(item.id) === orderId) ?? { id: orderId, code: '', product_name: '', basis: '0' });
    if (method === '手工') {
      const total = Number(amount || 0);
      return items.map((item) => { const value = manual[String(item.id)] ?? ''; return { work_order_id: String(item.id), work_order_code: blank(item.code), product_name: blank(item.product_name), basis: '-', ratio: total > 0 ? `${((Number(value || 0) / total) * 100).toFixed(2)}%` : '-', amount: value }; });
    }
    const parts = allocate(amount, items.map((item) => Number(item.basis ?? 0)));
    return items.map((item, index) => ({ work_order_id: String(item.id), work_order_code: blank(item.code), product_name: blank(item.product_name), basis: String(item.basis ?? '0'), ratio: `${(parts[index]!.ratio * 100).toFixed(2)}%`, amount: money(parts[index]!.cents) }));
  }, [amount, pool, manual, method, orderIds]);
  const lineTotal = lines.reduce((acc, line) => acc + Math.round(Number(line.amount || 0) * 100), 0);
  async function save() {
    if (!name.trim()) { r10.message.warning('请填写分摊名称'); return; }
    if (!(Number(amount) > 0)) { r10.message.warning('请填写分摊金额'); return; }
    if (!start || !end || start > end) { r10.message.warning('请选择正确的分摊期间'); return; }
    if (!orderIds.length) { r10.message.warning('请勾选参与分摊的加工单'); return; }
    if (method === '手工' && lineTotal !== Math.round(Number(amount) * 100)) { r10.message.warning(`明细金额合计 ${money(lineTotal)} 与分摊金额不一致`); return; }
    const body = {
      name: name.trim(), expense_type: type, amount, period_start: start, period_end: end, method, note,
      ...(method === '手工' ? { lines: lines.map((line) => ({ work_order_id: line.work_order_id, amount: line.amount })) } : { work_order_ids: orderIds }),
      ...(id ? { version: current.data?.share?.version } : {}),
    };
    const result = await r10.act<{ id?: string }>(id ? `/api/cost-shares/${id}` : '/api/cost-shares', body, id ? 'PUT' : 'POST');
    if (result) navigate(`/apportioned_cost/detail/${id || result.id}`);
  }
  if (!loaded) return <div className="kgd-card">{current.error || '正在读取数据…'}</div>;
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => navigate(-1)}>返回</Button></div>
    <h2>{id ? '修改成本分摊' : '新增成本分摊'}</h2>
    <Form layout="vertical" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', columnGap: 16 }}>
      <Form.Item label="分摊单号"><Input value={id ? blank(current.data?.share?.code) : ''} disabled placeholder="保存后自动生成" /></Form.Item>
      <Form.Item label="分摊名称" required><Input maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></Form.Item>
      <Form.Item label="费用类型" required><Select value={type} options={expenseTypes.map((value) => ({ value, label: value }))} onChange={setType} /></Form.Item>
      <Form.Item label="分摊金额" required><InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} value={amount} onChange={(value) => setAmount(value ?? '')} /></Form.Item>
      <Form.Item label="分摊期间" required><DatePicker.RangePicker style={{ width: '100%' }} value={start && end ? [dayjs(start), dayjs(end)] : null} onChange={(range) => { setStart(range?.[0]?.format('YYYY-MM-DD') ?? ''); setEnd(range?.[1]?.format('YYYY-MM-DD') ?? ''); }} /></Form.Item>
      <Form.Item label="分摊方式" required><Select value={method} options={shareMethods.map((value) => ({ value, label: value }))} onChange={setMethod} /></Form.Item>
      <Form.Item label="备注" style={{ gridColumn: 'span 3' }}><Input maxLength={255} value={note} onChange={(event) => setNote(event.target.value)} suffix={`${note.length}/255`} /></Form.Item>
    </Form>
    <div className="kgd-toolbar"><b>选择加工单</b><span className="kgd-muted">列出分摊期间内创建、报工或计划生产的加工单，勾选参与分摊的加工单</span></div>
    {candidates.error && <div className="kgd-banner">{candidates.error}</div>}
    <Table<Row> size="small" rowKey="id" loading={candidates.loading} pagination={{ pageSize: 10 }} dataSource={pool} scroll={{ x: 'max-content' }} locale={{ emptyText: '该期间内没有加工单' }}
      rowSelection={{ selectedRowKeys: orderIds, onChange: (keys) => setOrderIds(keys.map(String)) }}
      columns={[
        { title: '加工单号', render: (_, row) => row.code }, { title: '商品', render: (_, row) => dash(row.product_name) }, { title: '计划数', render: (_, row) => dash(row.plan_qty) },
        { title: '状态', render: (_, row) => dash(row.execution_text) }, { title: '工序进度', width: 160, render: (_, row) => <ProgressCell progress={String(row.process_progress ?? '0% (0/0)')} /> },
        { title: method === '手工' ? '分摊依据' : method.replace('按', ''), render: (_, row) => method === '手工' ? '-' : dash(row.basis) },
      ]} />
    <div className="kgd-toolbar" style={{ marginTop: 16 }}><b>分摊明细</b>{method !== '手工' && <span className="kgd-muted">金额为预览，保存时按后端计算结果为准</span>}</div>
    <Table size="small" rowKey="work_order_id" pagination={false} dataSource={lines} locale={{ emptyText: '请勾选加工单' }} columns={[
      { title: '序号', width: 60, render: (_, __, index) => index + 1 },
      { title: '加工单号', dataIndex: 'work_order_code' },
      { title: '商品', dataIndex: 'product_name' },
      { title: '分摊依据', dataIndex: 'basis' },
      { title: '比例', dataIndex: 'ratio' },
      { title: '金额', render: (_, line) => method === '手工' ? <InputNumber<string> stringMode min="0" precision={2} value={line.amount} onChange={(value) => setManual((current) => ({ ...current, [line.work_order_id]: value ?? '' }))} /> : line.amount },
      { title: '操作', width: 80, render: (_, line) => <button className="kgd-link" onClick={() => setOrderIds((current) => current.filter((item) => item !== line.work_order_id))}>移除</button> },
    ]} summary={() => <Table.Summary.Row><Table.Summary.Cell index={0} colSpan={5}>合计</Table.Summary.Cell><Table.Summary.Cell index={1}>{money(lineTotal)}</Table.Summary.Cell><Table.Summary.Cell index={2} /></Table.Summary.Row>} />
    <div className="kgd-actions" style={{ justifyContent: 'center', marginTop: 16 }}><Button type="primary" loading={r10.busy} onClick={() => void save()}>保存</Button></div>
  </div>;
}

function CostShareDetail({ id }: { id: string }) {
  const r10 = useR10();
  const navigate = useNavigate();
  const remote = useRemote<{ share?: Row; lines?: Row[] }>(`/api/cost-shares/${id}`, r10.revision, r10.onExpired);
  const share = remote.data?.share;
  if (!share) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : remote.error || '成本分摊不存在'}</div>;
  const lines = remote.data?.lines ?? [];
  const print = () => printDocs([{
    title: '成本分摊单',
    fields: [['分摊单号', share.code], ['分摊名称', share.name], ['费用类型', share.expense_type], ['分摊金额', String(share.amount)], ['分摊期间', `${dash(share.period_start)} ~ ${dash(share.period_end)}`], ['分摊方式', share.method], ['状态', share.status], ['备注', share.note || '-']],
    columns: ['序号', '加工单号', '商品', '计划数', '分摊依据', '比例', '金额'],
    rows: lines.map((line, index) => [String(index + 1), blank(line.work_order_code), blank(line.product_name), blank(line.plan_qty), blank(line.basis), blank(line.ratio), blank(line.amount)]),
    footer: [['合计', String(share.amount)]],
  }], '成本分摊单');
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => navigate('/apportioned_cost/list')}>返回</Button><span className="spacer" />
      <Button onClick={print}>打印</Button>
      {share.status !== '已分摊' && <><Button onClick={() => navigate(`/apportioned_cost/edit/${id}`)}>修改</Button><Button type="primary" onClick={() => r10.confirmDelete('确认分摊', () => r10.act(`/api/cost-shares/${id}/share`, { version: share.version }, 'POST', '已分摊'), '分摊后将锁定，确定分摊？')}>分摊</Button></>}
    </div>
    <h2>{share.name}</h2>
    <dl className="kgd-detail-grid">
      <div><dt>分摊单号</dt><dd>{share.code}</dd></div>
      <div><dt>费用类型</dt><dd>{share.expense_type}</dd></div>
      <div><dt>分摊金额</dt><dd>{share.amount}</dd></div>
      <div><dt>分摊期间</dt><dd>{dash(share.period_start)} ~ {dash(share.period_end)}</dd></div>
      <div><dt>分摊方式</dt><dd>{share.method}</dd></div>
      <div><dt>状态</dt><dd>{share.status === '已分摊' ? <Tag color="green">已分摊</Tag> : <Tag>草稿</Tag>}</dd></div>
      <div><dt>备注</dt><dd>{dash(share.note)}</dd></div>
      <div><dt>创建人</dt><dd>{dash(share.creator_name)}</dd></div>
      <div><dt>创建时间</dt><dd>{dash(share.created_text)}</dd></div>
    </dl>
    <Table size="small" rowKey="id" pagination={false} dataSource={lines} locale={{ emptyText: '暂无数据' }} columns={[
      { title: '序号', width: 60, render: (_, __, index) => index + 1 },
      { title: '加工单号', render: (_, line) => <button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${line.work_order_id}`)}>{line.work_order_code}</button> },
      { title: '商品', render: (_, line) => dash(line.product_name) },
      { title: '计划数', render: (_, line) => dash(line.plan_qty) },
      { title: '分摊依据', render: (_, line) => dash(line.basis) },
      { title: '比例', render: (_, line) => dash(line.ratio) },
      { title: '金额', render: (_, line) => dash(line.amount) },
    ]} />
  </div>;
}
