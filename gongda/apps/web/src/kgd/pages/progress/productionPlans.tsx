import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { App, Button, Dropdown, Input, Modal, Select, Table, Tabs } from 'antd';
import { DayField } from '../money/shared';
import { useRemote } from '../../../masterTools';
import { formatDate } from '../../../shared';
import { apiRequest } from '../../../api';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import type { ListColumn, QueryField } from '../../ListFrame';
import { useExtForm, useExtList } from '../../extensions/bind';
import { confirmText, showError, useCommand, useQueryState } from '../../kit';
import { printDocs } from '../../print';
import type { PrintDoc } from '../../print';
import { qtyText } from '../../qty';
import { ProgressCell } from './ProgressCell';
import { workOrderListColumns, type ProgressWorkOrderRow } from './workOrderColumns';
import { requestKey } from '../../../requestKey';

type PlanRow = {
  id: string;
  code: string;
  name: string;
  analysis_status: 'pending' | 'analyzed' | 'void';
  process_progress: { done: string; total: string };
  outsource_progress: { done: string; total: string };
  purchase_progress: { done: string; total: string };
  delivery_date: string | null;
  creator_name: string;
  created_at: string;
  note?: string;
  version?: number;
};

type PlanLine = {
  id: string;
  sequence: number;
  product_id: string;
  product_name: string;
  product_code: string;
  specification: string;
  contract_code: string;
  customer_name: string;
  source: string;
  image_url: string;
  plan_qty: string;
  bom_label: string;
  unit_name: string;
  note: string;
};

type AnalysisLine = {
  id: string;
  plan_line_id?: string;
  plan_code: string;
  plan_name: string;
  status: string;
  process_qty: string;
  outsource_qty: string;
  purchase_qty: string;
  note: string;
  analyst_name: string;
  analyzed_at: string;
  voided?: boolean;
};

type LinkedRow = Record<string, string | null | undefined> & { id: string };

type PlanDetail = PlanRow & {
  lines: PlanLine[];
  analysis_lines: AnalysisLine[];
  work_orders: ProgressWorkOrderRow[];
  outsource_orders?: LinkedRow[];
  purchase_orders?: LinkedRow[];
};

const analysisText: Record<PlanRow['analysis_status'], string> = { analyzed: '已分析', pending: '未分析', void: '未分析' };

function planPrintDoc(plan: PlanDetail): PrintDoc {
  return {
    title: '生产计划',
    fields: [['计划编号', plan.code], ['计划名称', plan.name], ['物料分析状态', analysisText[plan.analysis_status] ?? '未分析'], ['交货日期', plan.delivery_date?.slice(0, 10) || '-'], ['创建人', plan.creator_name || '-'], ['创建时间', formatDate(plan.created_at)], ['备注', plan.note?.trim() || '无']],
    columns: ['序号', '商品名', '编号', '规格', '合同编号', '客户名', '商品来源', '计划数量', '单位', '备注'],
    rows: (plan.lines ?? []).map((line, index) => [String(index + 1), line.product_name, line.product_code, line.specification || '-', line.contract_code || '-', line.customer_name || '-', line.source || '-', qtyText(line.plan_qty), line.unit_name || '-', line.note || '-']),
  };
}

async function printPlans(ids: string[]) {
  const docs: PrintDoc[] = [];
  for (const id of ids) docs.push(planPrintDoc((await apiRequest<{ plan: PlanDetail }>(`/api/production-plans/${id}`)).plan));
  printDocs(docs, '生产计划');
}

const queryFields: QueryField[] = [
  { key: 'code', label: '计划编号' },
  { key: 'name', label: '计划名称' },
  { key: 'creator', label: '创建人' },
  { key: 'analysis', label: '物料分析状态', kind: 'select', options: [{ value: '', label: '全部' }, { value: 'analyzed', label: '已分析' }, { value: 'pending', label: '未分析' }] },
  { key: 'created_from', label: '创建时间起', kind: 'date' },
  { key: 'created_to', label: '创建时间止', kind: 'date' },
];

function analysisTag(status: PlanRow['analysis_status']) {
  if (status === 'analyzed') return <span className="kgd-plan-tag-analyzed">已分析</span>;
  return <span className="kgd-plan-tag-pending">未分析</span>;
}

export function ProductionPlanList() {
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const list = useQueryState();
  const path = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(list.query).forEach(([key, value]) => { if (value.trim()) params.set(key, value.trim()); });
    params.set('page', String(list.page));
    params.set('page_size', '30');
    return `/api/production-plans?${params}`;
  }, [list.page, list.pageSize, list.query]);
  const remote = useRemote<{ items: PlanRow[]; total: number }>(path, revision, onExpired);
  const rows = remote.data?.items ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const chosen = rows.filter((row) => selected.includes(row.id));
  const extList = useExtList('production_plan');

  async function print(ids: string[]) {
    try { await printPlans(ids); } catch (failure) { command.setError(showError(failure)); }
  }
  async function batch(action: string) {
    if (!chosen.length) { command.setError('请先勾选生产计划'); return; }
    if (action === 'print') { await print(chosen.map((row) => row.id)); return; }
    if (action === 'analyze') {
      for (const row of chosen.filter((item) => item.analysis_status !== 'analyzed')) await analyze(row);
      setSelected([]);
      return;
    }
    confirmText('批量删除', `确定删除选中的${chosen.length}个生产计划？已有加工单的计划不能删除。`, () => void (async () => {
      for (const row of chosen) await remove(row);
      setSelected([]);
    })());
  }

  async function analyze(row: PlanRow) {
    try {
      await command.send(`/api/production-plans/${row.id}/analyze`, {});
    } catch (failure) { command.setError(showError(failure)); }
  }
  async function remove(row: PlanRow) {
    try {
      await command.send(`/api/production-plans/${row.id}`, {}, 'DELETE');
    } catch (failure) { command.setError(showError(failure)); }
  }

  const columns: ListColumn<PlanRow>[] = [
    { key: 'code', title: '计划编号', render: (row) => <button className="kgd-link" onClick={() => navigate(`/ProductionPlan/detail/${row.id}`)}>{row.code}</button> },
    { key: 'name', title: '计划名称', render: (row) => row.name },
    { key: 'analysis', title: '物料分析状态', render: (row) => analysisTag(row.analysis_status) },
    { key: 'process', title: '加工投产进度', render: (row) => <ProgressCell done={row.process_progress.done} total={row.process_progress.total} /> },
    { key: 'outsource', title: '外协投产进度', render: (row) => <ProgressCell done={row.outsource_progress.done} total={row.outsource_progress.total} /> },
    { key: 'purchase', title: '采购进度', render: (row) => <ProgressCell done={row.purchase_progress.done} total={row.purchase_progress.total} /> },
    { key: 'delivery', title: '交货日期', render: (row) => row.delivery_date?.slice(0, 10) ?? '' },
    { key: 'creator', title: '创建人', render: (row) => row.creator_name },
    { key: 'created', title: '创建时间', render: (row) => formatDate(row.created_at) },
    {
      key: 'actions', title: '操作', width: 260,
      render: (row) => row.analysis_status === 'analyzed'
        ? <Button type="link" onClick={() => void print([row.id])}>打印</Button>
        : <span onClick={(event) => event.stopPropagation()}>
          <Button type="link" onClick={() => void print([row.id])}>打印</Button>
          <Button type="link" onClick={() => void analyze(row)}>物料分析</Button>
          <Button type="link" onClick={() => navigate(`/ProductionPlan/add?id=${row.id}`)}>修改</Button>
          <Button type="link" danger onClick={() => confirmText('删除生产计划', '确定删除该生产计划？已有加工单的计划不能删除。', () => void remove(row))}>删除</Button>
        </span>,
    },
  ];

  return (
    <>
    <ListFrame
      pageKey="production-plans"
      showMobileCard={false}
      {...extList.props}
      columns={columns}
      rows={rows}
      loading={remote.loading || command.busy}
      error={remote.error || command.error}
      queryFields={queryFields}
      defaultQueryKeys={['code', 'name']}
      queryValue={list.draft}
      onQuery={list.onQuery}
      onSearch={list.onSearch}
      onClear={list.onClear}
      toolbar={<>
        <Button type="primary" onClick={() => navigate('/ProductionPlan/add')}>新增</Button>
        <Dropdown menu={{ items: [{ key: 'analyze', label: '批量物料分析' }, { key: 'print', label: '批量打印' }, { key: 'delete', label: '批量删除', danger: true }], onClick: ({ key }) => void batch(key) }}><Button>批量操作{selected.length ? `（${selected.length}）` : ''}</Button></Dropdown>
      </>}
      rowSelection={{ selected, onChange: setSelected }}
      page={list.page}
      pageSize={30}
      total={remote.data?.total ?? 0}
      onPage={list.onPage}
      clientPaging={false}
      defaultVisible={['code', 'name', 'analysis', 'process', 'outsource', 'purchase', 'delivery', 'creator', 'created', 'actions']}
    />
    {extList.dialog}
    </>
  );
}

export function ProductionPlanEditor() {
  const navigate = useNavigate();
  const location = useLocation();
  const editId = new URLSearchParams(location.search).get('id');
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const { message } = App.useApp();
  const detail = useRemote<{ plan: PlanDetail }>(editId ? `/api/production-plans/${editId}` : null, revision, onExpired);
  const products = useRemote<{ items: { id: string; code: string; name: string; specification?: string; unit_name?: string }[] }>('/api/products?page=1&page_size=100', revision, onExpired);
  const contracts = useRemote<{ items: { id: string; code: string; customer_name: string; lines: { id: string; product_id: string; product_code: string; product_name: string; quantity: string; unit_name: string }[] }[] }>('/api/sales-orders', revision, onExpired);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [delivery, setDelivery] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<PlanLine[]>([]);
  const [pickProduct, setPickProduct] = useState('');
  const [contractOpen, setContractOpen] = useState(false);
  const extForm = useExtForm('production_plan', editId ?? undefined);

  useEffect(() => {
    const plan = detail.data?.plan;
    if (!plan) return;
    setCode(plan.code);
    setName(plan.name);
    setDelivery(plan.delivery_date?.slice(0, 10) ?? '');
    setNote(plan.note ?? '');
    setLines((plan.lines ?? []).map((line) => ({ ...line, plan_qty: qtyText(line.plan_qty), specification: line.specification || '无' })));
  }, [detail.data]);

  function addProduct() {
    const product = products.data?.items.find((item) => item.id === pickProduct);
    if (!product) { message.warning('请选择商品'); return; }
    setLines((current) => [...current, {
      id: requestKey(),
      sequence: current.length + 1,
      product_id: product.id,
      product_name: product.name,
      product_code: product.code,
      specification: product.specification ?? '',
      contract_code: '',
      customer_name: '',
      source: '自产',
      image_url: '',
      plan_qty: '',
      bom_label: '',
      unit_name: product.unit_name ?? '',
      note: '',
    }]);
    setPickProduct('');
  }

  async function save() {
    if (!name.trim()) { command.setError('请填写计划名称'); return; }
    const emptyQty = lines.find((line) => !String(line.plan_qty ?? '').trim());
    if (emptyQty) { command.setError('请填写计划数'); return; }
    const extErr = extForm.error();
    if (extErr) { command.setError(extErr); return; }
    const payload = {
      code: code.trim() || undefined,
      name: name.trim(),
      delivery_date: delivery || null,
      note,
      lines: lines.map((line, index) => ({
        product_id: line.product_id,
        plan_qty: line.plan_qty,
        contract_code: line.contract_code,
        customer_name: line.customer_name,
        source: line.source,
        note: line.note,
        sequence: index + 1,
      })),
    };
    try {
      if (editId) {
        await command.send(`/api/production-plans/${editId}`, payload, 'PATCH');
        await extForm.persist(command.session.csrf_token, editId);
        navigate(`/ProductionPlan/detail/${editId}`);
        return;
      }
      const body = await command.send<{ plan: { id: string } }>('/api/production-plans', payload);
      if (body?.plan.id) {
        await extForm.persist(command.session.csrf_token, body.plan.id);
        navigate(`/ProductionPlan/detail/${body.plan.id}`);
      } else navigate('/ProductionPlan/list');
    } catch (failure) { command.setError(showError(failure)); }
  }

  return (
    <div className="kgd-card">
      <div className="kgd-actions"><Button onClick={() => navigate(editId ? `/ProductionPlan/detail/${editId}` : '/ProductionPlan/list')}>返回</Button></div>
      <h2>{editId ? '修改生产计划' : '创建生产计划'}</h2>
      {command.error && <div className="kgd-banner">{command.error}</div>}
      <div className="kgd-form">
        <span>计划编号</span><Input value={code} placeholder="请填写，忽略将自动生成" onChange={(event) => setCode(event.target.value)} />
        <span className={command.fieldErrors.name || command.error === '请填写计划名称' ? 'kgd-field-error-label' : undefined}>计划名称 *</span><Input className={command.error === '请填写计划名称' ? 'kgd-field-error' : undefined} value={name} onChange={(event) => setName(event.target.value)} />
        <span>交货日期</span><DayField value={delivery} onChange={setDelivery} />
        <span>备注</span><Input value={note} maxLength={255} onChange={(event) => setNote(event.target.value)} suffix={`${note.length}/255`} />
        {extForm.node}
      </div>
      <div className="kgd-toolbar">
        <Select showSearch optionFilterProp="label" style={{ minWidth: 220 }} placeholder="选择商品" value={pickProduct || undefined} onChange={setPickProduct} options={(products.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
        <Button type="primary" onClick={addProduct}>+ 添加商品</Button>
        <Button onClick={() => setContractOpen(true)}>+ 从合同商品中添加</Button>
        <span className="spacer" />
        <Button danger onClick={() => setLines([])}>清空</Button>
      </div>
      <Table size="small" rowKey="id" pagination={false} locale={{ emptyText: '暂无数据' }} dataSource={lines} scroll={{ x: 'max-content' }} columns={[
        { title: '序号', width: 60, render: (_, __, index) => index + 1 },
        { title: '商品名', dataIndex: 'product_name' },
        { title: '编号', dataIndex: 'product_code' },
        { title: '规格', dataIndex: 'specification' },
        { title: '合同编号', dataIndex: 'contract_code' },
        { title: '客户名', dataIndex: 'customer_name' },
        { title: '商品来源', dataIndex: 'source' },
        { title: '商品图片', render: () => '' },
        { title: '计划数量', render: (_, row) => <Input value={row.plan_qty} onChange={(event) => setLines((current) => current.map((item) => item.id === row.id ? { ...item, plan_qty: event.target.value } : item))} /> },
        { title: '商品BOM', dataIndex: 'bom_label' },
        { title: '单位', dataIndex: 'unit_name' },
        { title: '备注', render: (_, row) => <Input value={row.note} onChange={(event) => setLines((current) => current.map((item) => item.id === row.id ? { ...item, note: event.target.value } : item))} /> },
        { title: '操作', render: (_, row) => <Button type="link" onClick={() => setLines((current) => current.filter((item) => item.id !== row.id))}>删除</Button> },
      ]} />
      <div className="kgd-actions" style={{ justifyContent: 'center' }}>
        <Button type="primary" loading={command.busy} onClick={() => void save()}>{editId ? '确定' : '保存'}</Button>
        <Button type="primary" loading={command.busy} onClick={() => void save()}>{editId ? '确定' : '创建生产计划'}</Button>
      </div>
      <Modal title="从合同商品中添加" open={contractOpen} onCancel={() => setContractOpen(false)} footer={null} width={720}>
        <Table size="small" rowKey="id" pagination={false} dataSource={(contracts.data?.items ?? []).flatMap((order) => order.lines.map((line) => ({ ...line, order })))} columns={[
          { title: '合同编号', render: (_, row) => row.order.code },
          { title: '客户名', render: (_, row) => row.order.customer_name },
          { title: '商品', dataIndex: 'product_name' },
          { title: '数量', dataIndex: 'quantity', render: (value: string) => qtyText(value) },
          { title: '操作', render: (_, row) => <Button type="link" onClick={() => {
            setLines((current) => [...current, {
              id: requestKey(),
              sequence: current.length + 1,
              product_id: row.product_id,
              product_name: row.product_name,
              product_code: row.product_code,
              specification: '',
              contract_code: row.order.code,
              customer_name: row.order.customer_name,
              source: '自产',
              image_url: '',
              plan_qty: row.quantity,
              bom_label: '',
              unit_name: row.unit_name,
              note: '',
            }]);
            setContractOpen(false);
          }}>添加</Button> },
        ]} />
      </Modal>
    </div>
  );
}

function LinkedTable({ rows, columns }: { rows: LinkedRow[]; columns: [string, string][] }) {
  return <Table size="small" rowKey="id" pagination={{ pageSize: 30, showTotal: (count) => `共${count}条数据` }} locale={{ emptyText: '暂无数据' }} dataSource={rows} scroll={{ x: 'max-content' }} columns={columns.map(([key, title]) => ({ key, title, render: (_: unknown, row: LinkedRow) => row[key] ?? '-' }))} />;
}

export function ProductionPlanDetail() {
  const navigate = useNavigate();
  const id = useLocation().pathname.split('/detail/')[1]?.split(/[/?]/)[0] ?? '';
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const remote = useRemote<{ plan: PlanDetail }>(`/api/production-plans/${id}`, revision, onExpired);
  const linked = useRemote<{ outsource_orders: LinkedRow[]; purchase_orders: LinkedRow[] }>(id ? `/api/production-plans/${id}/linked-orders` : null, revision, onExpired);
  const [params, setParams] = useSearchParams();
  const plan = remote.data?.plan;
  const woColumns = useMemo(() => workOrderListColumns({ navigate, compact: true }), [navigate]);

  async function voidAnalysis(line: AnalysisLine) {
    try {
      await command.send(`/api/production-plans/${id}/analysis-lines/${line.id}/void`, {});
    } catch (failure) { command.setError(showError(failure)); }
  }

  if (!plan && remote.loading) return <div className="kgd-card">正在读取数据…</div>;
  if (!plan) return <div className="kgd-card">{remote.error || '生产计划不存在'}</div>;

  const infoRows: [string, ReactNode][] = [
    ['计划编号', plan.code],
    ['物料分析状态', analysisTag(plan.analysis_status)],
    ['加工单投产进度', <ProgressCell done={plan.process_progress.done} total={plan.process_progress.total} />],
    ['外协工单投产进度', <ProgressCell done={plan.outsource_progress.done} total={plan.outsource_progress.total} />],
    ['采购进度', <ProgressCell done={plan.purchase_progress.done} total={plan.purchase_progress.total} />],
    ['交货日期', plan.delivery_date?.slice(0, 10) ?? ''],
    ['备注', plan.note?.trim() ? plan.note : '无'],
    ['创建人', plan.creator_name],
    ['创建时间', formatDate(plan.created_at)],
  ];

  return (
    <div className="kgd-card">
      <div className="kgd-actions">
        <Button onClick={() => navigate('/ProductionPlan/list')}>返回</Button>
        <span className="spacer" />
        <Button onClick={() => printDocs([planPrintDoc(plan)], '生产计划')}>打印生产计划</Button>
      </div>
      {command.error && <div className="kgd-banner">{command.error}</div>}
      <div className="plan-detail">
        <div className="plan-detail-side">
          <h2 className="plan-detail-title">{plan.name}</h2>
          <div className="plan-kv">{infoRows.map(([label, value]) => (
            <span key={label} style={{ display: 'contents' }}><b>{label}</b><span>{value}</span></span>
          ))}</div>
        </div>
        <div className="plan-detail-main">
      <Tabs destroyOnHidden activeKey={params.get('tab') || 'lines'} onChange={(key) => setParams({ tab: key }, { replace: true })} items={[
        {
          key: 'lines', label: '商品明细', children: <>
            <Table size="small" rowKey="id" pagination={{ pageSize: 30 }} dataSource={plan.lines} scroll={{ x: 'max-content' }} columns={[
              { title: '序号', render: (_, __, index) => index + 1 },
              { title: '商品名', dataIndex: 'product_name' },
              { title: '编号', dataIndex: 'product_code' },
              { title: '规格', dataIndex: 'specification' },
              { title: '合同编号', dataIndex: 'contract_code' },
              { title: '客户名', dataIndex: 'customer_name' },
              { title: '商品来源', dataIndex: 'source' },
              { title: '商品图片', render: () => '无' },
              { title: '计划数量', render: (_, row) => qtyText(row.plan_qty) },
              { title: '商品BOM', dataIndex: 'bom_label' },
              { title: '单位', dataIndex: 'unit_name' },
              { title: '备注', dataIndex: 'note' },
            ]} />
          </>,
        },
        {
          key: 'analysis', label: '物料分析', children: <>
            <Table size="small" rowKey="id" pagination={{ pageSize: 30 }} dataSource={plan.analysis_lines} scroll={{ x: 'max-content' }} columns={[
              { title: '计划编号', dataIndex: 'plan_code' },
              { title: '计划名称', dataIndex: 'plan_name' },
              { title: '分析状态', dataIndex: 'status' },
              { title: '加工单', dataIndex: 'process_qty', render: (value: string) => qtyText(value) },
              { title: '外协工单', dataIndex: 'outsource_qty', render: (value: string) => qtyText(value) },
              { title: '采购单', dataIndex: 'purchase_qty', render: (value: string) => qtyText(value) },
              { title: '备注', dataIndex: 'note' },
              { title: '分析人', dataIndex: 'analyst_name' },
              { title: '分析时间', dataIndex: 'analyzed_at', render: (value: string) => formatDate(value) },
              {
                title: '操作', width: 360, render: (_, row) => <>
                  <Button type="link" disabled={!row.plan_line_id} onClick={() => navigate(`/inside_produce_bill/add?mode=direct&production_plan_line_id=${row.plan_line_id}`)}>创建加工单</Button>
                  <Button type="link" onClick={() => { const line = plan.lines.find((item) => item.id === row.plan_line_id); navigate(`/OutWorkOrder/add?plan_analysis_id=${row.id}${line ? `&product_id=${line.product_id}` : ''}&qty=${encodeURIComponent(qtyText(row.outsource_qty))}`); }}>创建外协工单</Button>
                  <Button type="link" onClick={() => navigate(`/purchase_order/list?add=1&plan_analysis_id=${row.id}`)}>创建采购单</Button>
                  <Button type="link" onClick={() => Modal.info({ title: '需求数', content: `加工 ${qtyText(row.process_qty)}；外协 ${qtyText(row.outsource_qty)}；采购 ${qtyText(row.purchase_qty)}` })}>详情</Button>
                  <Button type="link" danger onClick={() => confirmText('作废分析记录', '作废后计划将回到未分析。已有加工单下达的不能作废。', () => void voidAnalysis(row))}>作废</Button>
                </>,
              },
            ]} />
          </>,
        },
        {
          key: 'workOrders', label: '加工单', children: <>
            <Table size="small" rowKey="id" pagination={{ pageSize: 10 }} dataSource={plan.work_orders ?? []} scroll={{ x: 'max-content' }} columns={woColumns.map((column) => ({
              title: column.title,
              key: column.key,
              render: column.render ? (_: unknown, row: ProgressWorkOrderRow, index: number) => column.render!(row, index) : undefined,
            }))} />
          </>,
        },
        { key: 'outsource', label: '外协工单', children: <LinkedTable rows={linked.data?.outsource_orders ?? plan.outsource_orders ?? []} columns={[
          ['code', '外协工单号'], ['plan_qty', '计划数'], ['status', '状态'], ['product_name', '商品'], ['product_code', '商品编号'], ['product_image', '商品图片'], ['specification', '商品规格'],
          ['supplier_name', '供应商'], ['contact_name', '联系人'], ['address', '地址'], ['unit_price', '外协单价(元)'], ['due_date', '交货日期'], ['priority', '优先级'],
          ['drawing', '图纸'], ['plan_start', '计划开始'], ['plan_end', '计划结束'], ['fg_qty', '成品入库'], ['return_qty', '生产退料'], ['note', '备注'],
          ['accept_progress', '验收进度'], ['inbound_progress', '入库进度'], ['cancel_reason', '取消原因'], ['pause_reason', '暂停原因'],
          ['started_at', '开始时间'], ['completed_at', '完成时间'], ['creator_name', '创建人'], ['created_text', '创建时间'],
        ]} /> },
        { key: 'purchase', label: '采购单', children: <LinkedTable rows={linked.data?.purchase_orders ?? plan.purchase_orders ?? []} columns={[
          ['code', '采购单号'], ['plan_code', '生产计划编号'], ['plan_name', '生产计划名'], ['supplier_name', '供应商'], ['amount', '金额'],
          ['qty', '采购数量'], ['inbound_progress', '入库进度'], ['pay_progress', '付款进度'], ['approval_text', '审核状态'], ['audit_detail', '审核详情'],
          ['note', '备注'], ['due_date', '交货日期'], ['creator_name', '创建人'], ['buyer_name', '采购人'], ['created_text', '创建时间'],
        ]} /> },
      ]} />
        </div>
      </div>
    </div>
  );
}
