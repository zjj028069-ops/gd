import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Dropdown, Input, Modal, Radio } from 'antd';
import { hasPermission } from '../../api';
import { documentActionPayload, reportBatchSettlementPayload, reportSettlementPayload, taskActionPayload, taskBatchPayload } from '../../domain/payloads';
import { useRemote } from '../../masterTools';
import { formatDate } from '../../shared';
import { useKgd } from '../context';
import { ListFrame } from '../ListFrame';
import type { ListColumn } from '../ListFrame';
import { confirmText, durationText, showError, StatusTag, useCommand, useQueryState, when } from '../kit';
import { qtyText, sumQty } from '../qty';
import { ProgressCell } from './progress/ProgressCell';
import { downloadCsv, inspectionText, modeText, qualityText, rateLabel, settlementText, WAGE_FORMULA, yuanLabel } from '../wage';
import { ReportDialog } from './reportForm';
import { AsyncQr } from '../qr';
import { mobileOrigin } from './mobile/device';
import type { EditableReport, ReportTarget } from './reportForm';
import { BatchReportDialog, BatchReportFormDialog, DispatchDialog } from './batchReport';
import { printDocs, type PrintDoc } from '../print';
import { PrintPickModal } from '../print/templates';

type TaskItem = {
  id: string; work_order_id: string; work_order_code: string; work_order_execution: string; order_paused: boolean; due_date: string | null; priority: string;
  product_snapshot: { name?: string; code?: string; specification?: string }; process_id: string;
  process_snapshot: { code?: string; name?: string; standard_minutes?: string; reporter_ids?: string[] };
  execution: string; plan_qty: string; approved_good: string; approved_defect: string; pricing_mode: string; wage_rate: string | null;
  inspection_scheme: string; unit_ratio: string; version: number; started_at: string | null; completed_at: string | null; overdue_days: number;
  task_type?: string; dispatch_operator_ids?: string[];
};
type TaskPayload = { items: TaskItem[]; total: number; counts: Record<string, number>; totals: { effective_seconds: number; plan_qty: string; actual_qty: string } };
type Report = {
  id: string; code: string; work_order_id: string; task_id: string; operator_id: string; good_qty: string; defect_qty: string; rework_qty: string; scrap_qty: string;
  defect_note: string; note?: string; approval: string; version: number; created_at: string; effective_seconds?: number; estimated_wage?: string | null;
  wage_snapshot?: { mode?: string; rate?: string } | null; started_at?: string | null; ended_at?: string | null; quality_status?: string;
  settlement_status?: string; settled_by?: string | null; settled_at?: string | null; settlement_note?: string; report_type?: string;
};
type ReportPayload = { items: Report[]; total: number; counts: Record<string, number>; summary: { wage_amount: string; report_qty: string; defect_qty: string; effective_seconds: number } };
type Order = { id: string; code: string; execution: string; product_snapshot: { name?: string; code?: string; unit_name?: string }; tasks: { id: string; process_name: string; version: number }[] };
const taskText: Record<string, string> = { not_started: '未开始', running: '进行中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
const orderText: Record<string, string> = { not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
const typeText: Record<string, string> = { production: '生产任务', rework: '返工任务', outsource: '外协任务' };

function taskDoc(row: TaskItem, nameOf: (id: string) => string): PrintDoc {
  return {
    title: '生产任务',
    fields: [
      ['加工单', row.work_order_code], ['任务类型', typeText[row.task_type ?? 'production'] ?? '生产任务'], ['工序', row.process_snapshot.name ?? ''], ['工序编号', row.process_snapshot.code ?? ''],
      ['商品名', row.product_snapshot.name ?? ''], ['商品编号', row.product_snapshot.code ?? ''], ['商品规格', row.product_snapshot.specification ?? ''],
      ['生产数量', qtyText(row.plan_qty)], ['良品数', qtyText(row.approved_good)], ['不良品数', qtyText(row.approved_defect)], ['任务状态', taskText[row.execution] ?? row.execution],
      ['计价方式', modeText(row.pricing_mode)], ['工资单价', rateLabel(row.wage_rate)], ['检验方案', inspectionText(row.inspection_scheme)],
      ['生产人员', (row.process_snapshot.reporter_ids ?? []).map(nameOf).join('、')], ['生产派工', (row.dispatch_operator_ids ?? []).map(nameOf).join('、')],
      ['交货日期', row.due_date ?? ''], ['任务开始时间', when(row.started_at)], ['任务结束时间', when(row.completed_at)],
    ],
  };
}

export function TaskList() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const list = useQueryState();
  const [view, setView] = useState('produce');
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [dialog, setDialog] = useState<'report' | 'dispatch' | null>(null);
  const members = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', revision, onExpired);
  const memberName = (id: string) => members.data?.items.find((item) => String(item.id) === String(id))?.display_name ?? '';
  const status = list.chips.status ?? 'all';
  const late = list.chips.overdue ?? 'all';
  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (view === 'outsource' || view === 'rework' || view === 'produce') params.set('task_type', view === 'produce' ? 'production' : view);
    if (late === 'yes') params.set('overdue', '1');
    if (late === 'no') params.set('overdue', '0');
    if (list.query.code) params.set('work_order_code', list.query.code);
    if (list.query.process) params.set('process', list.query.process);
    if (list.query.product) params.set('product', list.query.product);
    params.set('page', String(list.page));
    params.set('page_size', String(list.pageSize));
    return `/api/production-tasks?${params}`;
  }, [late, list.page, list.pageSize, list.query.code, list.query.process, list.query.product, status, view]);
  const remote = useRemote<TaskPayload>(path, revision, onExpired);
  const counts = remote.data?.counts;
  const rows = remote.data?.items ?? [];
  async function taskAct(row: TaskItem, action: string) {
    try { await command.send(`/api/work-orders/${row.work_order_id}/tasks/${row.id}/actions`, taskActionPayload(action, row.version)); }
    catch (failure) { command.setError(showError(failure)); }
  }
  async function batch(action: 'start' | 'pause' | 'complete') {
    if (!selected.length) return;
    try {
      const body = await command.send<{ succeeded: number; skipped: number; results: { ok: boolean; message: string; task_id: string }[] }>('/api/production-tasks/batch-actions', taskBatchPayload(action, selected));
      if (!body) return;
      message.success(`成功 ${body.succeeded} 条，跳过 ${body.skipped} 条`);
      const failed = body.results.filter((item) => !item.ok && item.message);
      if (failed.length) Modal.info({ title: `成功 ${body.succeeded} 条，跳过 ${body.skipped} 条`, content: failed.map((item) => item.message).join('；') });
      setSelected([]);
    } catch (failure) { command.setError(showError(failure)); }
  }
  const columns: ListColumn<TaskItem>[] = [
    { key: 'process', title: '工序', render: (row) => <span>{row.process_snapshot.name ?? ''}{row.overdue_days > 0 && <span className="kgd-late">逾{row.overdue_days}天</span>}</span> },
    { key: 'product', title: '商品名', render: (row) => row.product_snapshot.name ?? '' },
    { key: 'productCode', title: '商品编号', render: (row) => row.product_snapshot.code ?? '' },
    { key: 'spec', title: '商品规格', render: (row) => row.product_snapshot.specification ?? '' },
    { key: 'category', title: '商品类别', missing: true },
    { key: 'code', title: '加工单', render: (row) => <button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.work_order_id}`)}>{row.work_order_code}</button> },
    { key: 'type', title: '任务类型', render: (row) => typeText[row.task_type ?? 'production'] ?? '生产任务' },
    { key: 'processCode', title: '工序编号', render: (row) => row.process_snapshot.code ?? '' },
    { key: 'planStart', title: '工序计划开始', missing: true }, { key: 'planEnd', title: '工序计划结束', missing: true },
    { key: 'plan', title: '生产数量', render: (row) => qtyText(row.plan_qty) },
    { key: 'progress', title: '生产进度', render: (row) => <ProgressCell done={row.approved_good} total={row.plan_qty} /> },
    { key: 'accept', title: '验收进度', missing: true }, { key: 'outAccept', title: '外协验收', missing: true },
    { key: 'status', title: '任务状态', render: (row) => <StatusTag text={taskText[row.execution] ?? row.execution} /> },
    { key: 'pause', title: '任务暂停原因', missing: true },
    { key: 'workshop', title: '车间', missing: true }, { key: 'line', title: '产线', missing: true },
    { key: 'mode', title: '计价方式', render: (row) => modeText(row.pricing_mode) },
    { key: 'rate', title: '工资单价', render: (row) => rateLabel(row.wage_rate) },
    { key: 'minutes', title: '标准工时', render: (row) => row.process_snapshot.standard_minutes ? `${row.process_snapshot.standard_minutes} 分钟` : '' },
    { key: 'totalMinutes', title: '标准总工时', missing: true },
    { key: 'started', title: '任务开始时间', render: (row) => when(row.started_at) },
    { key: 'ended', title: '任务结束时间', render: (row) => when(row.completed_at) },
    { key: 'used', title: '用时', missing: true },
    { key: 'machine', title: '机台', missing: true },
    { key: 'reporters', title: '生产人员', render: (row) => (row.process_snapshot.reporter_ids ?? []).map(memberName).filter(Boolean).join('、') || (row.process_snapshot.reporter_ids?.length ? `${row.process_snapshot.reporter_ids.length}人` : '') },
    { key: 'dispatch', title: '生产派工', render: (row) => (row.dispatch_operator_ids ?? []).map(memberName).join('、') }, { key: 'qcPeople', title: '质检人员', missing: true }, { key: 'qcDispatch', title: '质检派工', missing: true },
    { key: 'defects', title: '不良品项', missing: true }, { key: 'unit', title: '报工单位', missing: true },
    { key: 'scheme', title: '检验方案', render: (row) => inspectionText(row.inspection_scheme) },
    { key: 'ratio', title: '单位关系', render: (row) => row.unit_ratio },
    { key: 'orderStatus', title: '加工单状态', render: (row) => orderText[row.work_order_execution] ?? row.work_order_execution },
    { key: 'actions', title: '操作', width: 220, render: (row) => {
      const locked = row.order_paused || ['completed', 'cancelled'].includes(row.work_order_execution);
      return <span onClick={(event) => event.stopPropagation()}>
        <Button type="link" onClick={() => navigate(`/inside_produce_bill/detail/${row.work_order_id}`)}>详情</Button>
        {row.execution === 'running' && !locked && <Button type="link" onClick={() => setTarget({ taskId: row.id, processName: row.process_snapshot.name ?? '', pricingMode: row.pricing_mode, wageRate: row.wage_rate, planQty: row.plan_qty, workOrderCode: row.work_order_code })}>报工</Button>}
        {!(row.execution === 'running' && !locked) && <Button type="link" onClick={() => setTarget({ taskId: row.id, processName: row.process_snapshot.name ?? '', pricingMode: row.pricing_mode, wageRate: row.wage_rate, planQty: row.plan_qty, workOrderCode: row.work_order_code })}>报工</Button>}
        <Button type="link" onClick={() => navigate(`/production_out_of_storage/list?add=wo&work_order_id=${row.work_order_id}`)}>出库</Button>
        <Dropdown menu={{ items: [
          { key: 'reset', label: '未开始', disabled: locked, onClick: () => void taskAct(row, 'reset') },
          { key: 'run', label: '进行中', disabled: locked, onClick: () => void taskAct(row, row.execution === 'paused' ? 'resume' : 'start') },
          { key: 'done', label: '已完成', disabled: locked, onClick: () => void taskAct(row, 'complete') },
          { key: 'pause', label: '暂停', disabled: locked, onClick: () => void taskAct(row, 'pause') },
          { key: 'print', label: '打印', onClick: () => printTasks([row]) },
          { key: 'qr', label: '查看二维码', onClick: () => { const path = `/m/report?wo=${encodeURIComponent(row.work_order_code)}&task=${row.id}`; Modal.info({ title: '查看二维码', icon: null, okText: '关闭', content: <div style={{ textAlign: 'center' }}><AsyncQr make={async () => `${await mobileOrigin()}${path}`} showText /></div> }); } },
        ] }}><Button type="link">更多</Button></Dropdown>
      </span>;
    } },
  ];
  const chip = (value: string, label: string, count?: number) => ({ value, label: count === undefined ? label : `${label}(${count})` });
  const picked = rows.filter((row) => selected.includes(row.id));
  function printTasks(targets: TaskItem[]) {
    if (!targets.length) return;
    if (!printDocs(targets.map((row) => taskDoc(row, memberName)), '生产任务')) message.warning('浏览器拦截了打印窗口，请允许弹出窗口后重试。');
  }
  return <>
    <ListFrame pageKey="tasks" columns={columns} rows={rows} loading={remote.loading || command.busy} error={remote.error || command.error}
      viewTabs={[{ key: 'all', label: '全部视图' }, { key: 'produce', label: '生产任务视图' }, { key: 'outsource', label: '外协任务视图' }, { key: 'rework', label: '返工任务视图' }]} activeView={view} onView={(key) => { setView(key); setSelected([]); }}
      chips={[
        { key: 'status', label: '任务状态', options: [chip('all', '全部', counts?.all), chip('not_started', '未开始', counts?.not_started), chip('running', '进行中', counts?.running), chip('completed', '已完成', counts?.completed), chip('paused', '已暂停', counts?.paused)] },
        { key: 'type', label: '任务类型', options: [chip('all', '全部', counts?.all), chip('produce', '生产任务', counts?.production), chip('rework', '返工任务', counts?.rework), chip('outsource', '外协任务', counts?.outsource)] },
        { key: 'overdue', label: '是否逾期', options: [chip('all', '全部', counts?.all), chip('yes', '已逾期', counts?.overdue), chip('no', '未逾期', counts?.on_time)] },
      ]}
      chipValue={{ status, type: view === 'outsource' || view === 'rework' || view === 'produce' ? view : 'all', overdue: late }}
      onChip={(key, value) => { if (key === 'type') { setView(value === 'outsource' || value === 'rework' || value === 'produce' ? value : 'all'); setSelected([]); } else list.onChip(key, value); }}
      queryFields={[{ key: 'process', label: '工序' }, { key: 'code', label: '加工单' }, { key: 'product', label: '商品' }, { key: 'workshop', label: '车间', missing: true }, { key: 'line', label: '产线', missing: true }, { key: 'machine', label: '机台', missing: true }]}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      toolbar={<><Dropdown disabled={!selected.length} menu={{ items: [
        { key: 'start', label: '批量开始/继续', onClick: () => void batch('start') },
        { key: 'pause', label: '批量暂停', onClick: () => void batch('pause') },
        { key: 'complete', label: '批量完成', onClick: () => void batch('complete') },
        { key: 'report', label: '批量报工', onClick: () => setDialog('report') },
        { key: 'dispatch', label: '批量派工', onClick: () => setDialog('dispatch') },
        { key: 'print', label: '批量打印生产任务', onClick: () => printTasks(picked) },
      ] }}><Button disabled={!selected.length}>批量操作 ▾</Button></Dropdown>
        <Button disabled={!selected.length} onClick={() => setDialog('report')}>批量报工</Button>
        <span className="kgd-summary">【总工时统计】{durationText(remote.data?.totals.effective_seconds ?? 0) || '0'} 【生产总数】{qtyText(remote.data?.totals.plan_qty)} 【实际生产数】{qtyText(remote.data?.totals.actual_qty)}</span></>}
      page={list.page} pageSize={list.pageSize} total={remote.data?.total ?? 0} onPage={list.onPage} clientPaging={false} rowSelection={{ selected, onChange: setSelected }} showExtension={false}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={{ list: columns.filter((column) => column.key !== 'actions').map((column) => ({ key: column.key, label: column.title, missing: column.missing })) }}
      defaultQueryKeys={['code', 'process', 'product']}
      defaultVisible={['process', 'product', 'code', 'plan', 'progress', 'status', 'mode', 'rate', 'actions']} />
    <ReportDialog open={!!target} target={target} onClose={() => setTarget(null)} />
    {dialog === 'report' && <BatchReportDialog tasks={picked} onClose={() => { setDialog(null); setSelected([]); }} />}
    {dialog === 'dispatch' && <DispatchDialog tasks={picked} onClose={() => { setDialog(null); setSelected([]); }} />}
  </>;
}

export function ReportList() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { revision, onExpired, session } = useKgd();
  const command = useCommand();
  const list = useQueryState();
  const [selected, setSelected] = useState<string[]>([]);
  const [settleRow, setSettleRow] = useState<Report | null>(null);
  const [editing, setEditing] = useState<EditableReport | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<string[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [filesOf, setFilesOf] = useState<Report | null>(null);
  const [pickReport, setPickReport] = useState(false);
  const [pickErr, setPickErr] = useState('');
  const [printJob, setPrintJob] = useState<PrintDoc[] | null>(null);
  const kind = list.chips.kind ?? 'all';
  const qc = list.chips.qc ?? 'all';
  const settle = list.chips.settle ?? 'all';
  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (kind === 'rework' || kind === 'production') params.set('report_type', kind);
    if (qc !== 'all') params.set('quality_status', qc);
    if (settle !== 'all') params.set('settlement_status', settle);
    params.set('page', String(list.page));
    params.set('page_size', String(list.pageSize));
    return `/api/production-reports?${params}`;
  }, [kind, list.page, list.pageSize, qc, settle]);
  const reports = useRemote<ReportPayload>(path, revision, onExpired);
  const extras = useRemote<{ items: { report_id: string; machine_name: string; defect_qty_sum: string; defect_count: number }[] }>('/api/report-workbench/extras', revision, onExpired);
  const extraOf = (id: string) => extras.data?.items.find((item) => item.report_id === id);
  const orders = useRemote<{ items: Order[] }>('/api/work-orders', revision, onExpired);
  const members = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', revision, onExpired);
  const nameOf = (id: string) => members.data?.items.find((item) => String(item.id) === id)?.display_name ?? '';
  const orderOf = (id: string) => orders.data?.items.find((item) => item.id === id);
  const rows = (reports.data?.items ?? []).filter((row) => row.approval !== 'reversed').filter((row) => {
    const order = orderOf(row.work_order_id);
    if ((list.query.code ?? '') && !(order?.code ?? '').includes(list.query.code ?? '')) return false;
    const task = order?.tasks.find((item) => item.id === row.task_id);
    if ((list.query.process ?? '') && !(task?.process_name ?? '').includes(list.query.process ?? '')) return false;
    if ((list.query.operator ?? '') && !nameOf(row.operator_id).includes(list.query.operator ?? '')) return false;
    return true;
  });
  const counts = reports.data?.counts;
  const summary = reports.data?.summary;
  const canSettle = hasPermission(session, 'payroll.approve');
  async function remove(row: Report) {
    try { await command.send(`/api/production-reports/${row.id}/actions`, documentActionPayload('reverse', row.version)); }
    catch (failure) { command.setError(showError(failure)); }
  }
  function batchSettle() {
    Modal.confirm({
      title: '请确认',
      content: '已经结算完成的报工记录不再进行结算，仅结算未结算的报工记录，点击确定开始进行批量结算！',
      okText: '确 认',
      cancelText: '取 消',
      onOk: async () => {
        const body = await command.send<{ settled: number; skipped: number }>('/api/production-reports/batch-settlement', reportBatchSettlementPayload(selected));
        if (body) message.success(`已结算 ${body.settled} 条，跳过 ${body.skipped} 条`);
      },
    });
  }
  const columns: ListColumn<Report>[] = [
    { key: 'productName', title: '商品名', render: (row) => orderOf(row.work_order_id)?.product_snapshot.name ?? '' },
    { key: 'productCode', title: '商品编号', render: (row) => orderOf(row.work_order_id)?.product_snapshot.code ?? '' },
    { key: 'spec', title: '商品规格', missing: true },
    { key: 'process', title: '工序名', render: (row) => orderOf(row.work_order_id)?.tasks.find((task) => task.id === row.task_id)?.process_name ?? '' },
    { key: 'workshop', title: '车间', missing: true }, { key: 'line', title: '产线', missing: true },
    { key: 'mode', title: '计价方式', render: (row) => modeText(row.wage_snapshot?.mode) },
    { key: 'settle', title: '结算状态', render: (row) => {
      // pages.json P057 无「操作」列；行内动作挂在结算状态旁，避免 exact 对齐后丢按钮
      const settled = row.settlement_status === 'settled';
      return <span onClick={(event) => event.stopPropagation()}>
        {settlementText(row.settlement_status)}
        <Button type="link" onClick={() => setSettleRow(row)}>结算</Button>
        <Button type="link" disabled={settled} onClick={() => setEditing({ id: row.id, version: row.version, processName: orderOf(row.work_order_id)?.tasks.find((task) => task.id === row.task_id)?.process_name ?? '', pricingMode: row.wage_snapshot?.mode ?? 'piece', wageRate: row.wage_snapshot?.rate ?? null, operatorId: row.operator_id, goodQty: row.good_qty, defectQty: row.defect_qty, defectNote: row.defect_note, note: row.note ?? '', effectiveSeconds: row.effective_seconds ?? 0, startedAt: row.started_at ?? null, endedAt: row.ended_at ?? null })}>修改</Button>
        <Button type="link" onClick={() => printReports([row])}>打印</Button>
        <Button type="link" onClick={() => setFilesOf(row)}>附件</Button>
        <Button type="link" disabled={settled} onClick={() => confirmText('删除', '将冲销该报工及其工资', () => void remove(row))}>删除</Button>
      </span>;
    } },
    { key: 'settler', title: '结算人', render: (row) => row.settled_by ? nameOf(row.settled_by) : '' },
    { key: 'settledAt', title: '结算时间', render: (row) => when(row.settled_at) },
    { key: 'order', title: '加工单号', render: (row) => orderOf(row.work_order_id)?.code ?? '' },
    { key: 'orderStatus', title: '加工单状态', render: (row) => orderText[orderOf(row.work_order_id)?.execution ?? ''] ?? '' },
    { key: 'kind', title: '报工类型', render: (row) => row.report_type === 'rework' ? '返工报工' : '生产报工' },
    { key: 'machine', title: '机台', render: (row) => extraOf(row.id)?.machine_name || '-' },
    { key: 'rate', title: '工资单价', render: (row) => rateLabel(row.wage_snapshot?.rate, orderOf(row.work_order_id)?.product_snapshot.unit_name) },
    { key: 'operator', title: '报工生产人员', render: (row) => nameOf(row.operator_id) },
    { key: 'qty', title: '报工数量', render: (row) => sumQty([row.good_qty, row.defect_qty]) },
    { key: 'good', title: '良品数', render: (row) => qtyText(row.good_qty) },
    { key: 'defect', title: '不良品数', render: (row) => qtyText(row.defect_qty) },
    { key: 'defectItem', title: '不良品项', render: (row) => { const count = extraOf(row.id)?.defect_count ?? 0; return count ? `查看(${count})` : (row.defect_note || '-'); } },
    { key: 'defectQtySum', title: '不良品项数', render: (row) => extraOf(row.id)?.defect_qty_sum || '0' },
    { key: 'unit', title: '报工单位', render: (row) => orderOf(row.work_order_id)?.product_snapshot.unit_name ?? '' },
    { key: 'wage', title: '工资(元)', render: (row) => row.estimated_wage ?? '' },
    { key: 'start', title: '报工开始时间', render: (row) => when(row.started_at) },
    { key: 'end', title: '报工结束时间', render: (row) => when(row.ended_at) },
    { key: 'duration', title: '报工时长', render: (row) => durationText(row.effective_seconds ?? 0) },
    { key: 'remark', title: '报工备注', render: (row) => row.note ?? '' },
    { key: 'reporter', title: '报工人', render: (row) => nameOf(row.operator_id) },
    { key: 'rework', title: '返工数', render: (row) => qtyText(row.rework_qty) },
    { key: 'scrap', title: '报废数', render: (row) => qtyText(row.scrap_qty) },
    { key: 'qc', title: '质检状态', render: (row) => qualityText(row.quality_status) },
    { key: 'created', title: '报工时间', render: (row) => when(row.created_at) || formatDate(row.created_at) },
  ];
  const chip = (value: string, label: string, count?: number) => ({ value, label: count === undefined ? label : `${label}(${count})` });
  function reportDoc(row: Report): PrintDoc {
    const order = orderOf(row.work_order_id);
    return {
      title: '报工记录',
      fields: [
        ['报工单号', row.code], ['加工单号', order?.code ?? ''], ['商品名', order?.product_snapshot.name ?? ''], ['商品编号', order?.product_snapshot.code ?? ''],
        ['工序名', order?.tasks.find((task) => task.id === row.task_id)?.process_name ?? ''], ['报工类型', row.report_type === 'rework' ? '返工报工' : '生产报工'],
        ['报工生产人员', nameOf(row.operator_id)], ['机台', extraOf(row.id)?.machine_name ?? ''], ['报工数量', sumQty([row.good_qty, row.defect_qty])],
        ['良品数', qtyText(row.good_qty)], ['不良品数', qtyText(row.defect_qty)], ['不良品项', row.defect_note], ['计价方式', modeText(row.wage_snapshot?.mode)],
        ['工资单价', rateLabel(row.wage_snapshot?.rate, order?.product_snapshot.unit_name)], ['工资(元)', row.estimated_wage ?? ''],
        ['报工开始时间', when(row.started_at)], ['报工结束时间', when(row.ended_at)], ['报工时长', durationText(row.effective_seconds ?? 0)],
        ['质检状态', qualityText(row.quality_status)], ['结算状态', settlementText(row.settlement_status)], ['报工时间', when(row.created_at)], ['报工备注', row.note ?? ''],
      ],
    };
  }
  function printReports(targets: Report[]) {
    if (!targets.length) return;
    setPrintJob(targets.map(reportDoc));
  }
  function exportRows(keys: string[]) {
    const chosen = columns.filter((column) => keys.includes(column.key) && column.key !== 'actions');
    downloadCsv('报工记录.csv', chosen.map((column) => column.title), rows.map((row) => chosen.map((column) => cellText(column, row))));
  }
  return <>
    <ListFrame pageKey="reports" columns={columns} rows={rows} loading={reports.loading || command.busy} error={reports.error || command.error} onVisibleKeys={setVisibleKeys}
      summary={<div className="kgd-summary"><span>【总工资】{summary?.wage_amount ?? ''}</span><span>【报工数量】{qtyText(summary?.report_qty)}</span><span>【不良品数】{qtyText(summary?.defect_qty)}</span><span>【总报工时长】{durationText(summary?.effective_seconds ?? 0) || '0'}</span></div>}
      chips={[
        { key: 'kind', label: '报工类型', options: [chip('all', '全部', counts?.all), chip('production', '生产报工', counts?.production), chip('rework', '返工报工', counts?.rework)] },
        { key: 'qc', label: '质检状态', options: [chip('all', '全部', counts?.all), chip('pending', '待质检', counts?.quality_pending), chip('done', '已质检', counts?.quality_done), chip('none', '不需质检', counts?.quality_none)] },
        { key: 'settle', label: '结算状态', options: [chip('all', '全部', counts?.all), chip('unsettled', '未结算', counts?.unsettled), chip('settled', '已结算', counts?.settled)] },
      ]}
      chipValue={{ kind, qc, settle }} onChip={list.onChip}
      queryFields={[{ key: 'rate', label: '工资单价' }, { key: 'defect_qty', label: '不良品数' }, { key: 'code', label: '加工单号' }, { key: 'process', label: '工序' }, { key: 'operator', label: '生产人员' }, { key: 'customer', label: '客户', missing: true }, { key: 'settler', label: '结算人', missing: true }, { key: 'time', label: '报工时间起/止', missing: true }]}
      defaultQueryKeys={['rate', 'defect_qty']}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      toolbar={<><Button type="primary" onClick={() => { setPickErr(''); setPickReport(true); }}>报工</Button><Dropdown disabled={!selected.length} menu={{ items: [
        { key: 'print', label: '批量打印报工记录', onClick: () => printReports(rows.filter((row) => selected.includes(row.id))) },
        ...(canSettle ? [{ key: 'settle', label: '批量结算', disabled: !selected.length, onClick: batchSettle }] : []),
        { key: 'delete', label: '批量删除', disabled: !selected.length, onClick: () => confirmText('批量删除', '将冲销未结算的报工', () => { selected.forEach((id) => { const row = rows.find((item) => item.id === id); if (row && row.settlement_status !== 'settled') void remove(row); }); }) },
      ] }}><Button disabled={!selected.length}>批量操作 ▾</Button></Dropdown><Button onClick={() => setFormOpen(true)}>批量报工设置</Button></>}
      moreItems={[{ key: 'all', label: '导出(所有列)', onClick: () => exportRows(columns.map((column) => column.key)) }, { key: 'shown', label: '导出(显示列)', onClick: () => exportRows(visibleKeys.length ? visibleKeys : columns.map((column) => column.key)) }]}
      page={list.page} pageSize={list.pageSize} total={reports.data?.total ?? 0} onPage={list.onPage} clientPaging={false} rowSelection={{ selected, onChange: setSelected }} showExtension={false}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={{ list: columns.filter((column) => column.key !== 'actions').map((column) => ({ key: column.key, label: column.title, missing: column.missing })) }}
      defaultVisible={['order', 'productName', 'process', 'operator', 'qty', 'good', 'defect', 'defectItem', 'machine', 'mode', 'rate', 'wage', 'qc', 'settle', 'settler', 'settledAt', 'duration', 'created']} />
    <SettleDialog row={settleRow} order={settleRow ? orderOf(settleRow.work_order_id) : undefined} operator={settleRow ? nameOf(settleRow.operator_id) : ''} onClose={() => setSettleRow(null)} />
    <ReportDialog open={!!editing} editing={editing} onClose={() => setEditing(null)} />
    {formOpen && <BatchReportFormDialog onClose={() => setFormOpen(false)} />}
    {filesOf && <ReportFiles report={filesOf} onClose={() => setFilesOf(null)} />}
    <PrintPickModal objectKey="work_report" title="打印报工记录" docs={printJob} onClose={() => setPrintJob(null)} />
    <Modal title="报工" open={pickReport} onCancel={() => setPickReport(false)} okText="确 定" cancelText="取 消" onOk={() => {
      if (!pickErr && true) {
        setPickErr('请选择加工单');
        return;
      }
      navigate('/productionTask/list');
    }}>
      {pickErr ? <div className="kgd-banner kgd-field-error">{pickErr}</div> : null}
      <div className={pickErr ? 'kgd-field-error' : undefined}>
        <span className={pickErr ? 'kgd-field-error-label' : undefined}>加工单</span>
        <Input placeholder="请选择加工单" readOnly />
      </div>
    </Modal>
  </>;
}

function cellText<T>(column: ListColumn<T>, row: T) {
  const node = column.render?.(row);
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return '';
}

function SettleDialog({ row, order, operator, onClose }: { row: Report | null; order?: Order; operator: string; onClose: () => void }) {
  const command = useCommand();
  const [settled, setSettled] = useState(false);
  const [note, setNote] = useState('');
  const taskName = order?.tasks.find((task) => task.id === row?.task_id)?.process_name ?? '';
  const open = !!row;
  useEffect(() => {
    if (!row) return;
    setSettled(row.settlement_status === 'settled');
    setNote(row.settlement_note ?? '');
  }, [row]);
  return <Modal title="工资结算" open={open} destroyOnHidden onCancel={onClose} confirmLoading={command.busy} okText="确 定" cancelText="取 消" onOk={() => {
    if (!row) return;
    void command.send(`/api/production-reports/${row.id}/settlement`, reportSettlementPayload(row.version, settled, note)).then(() => onClose()).catch((failure: unknown) => command.setError(showError(failure)));
  }}>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <div className="kgd-form">
      <span>加工单号</span><span>{order?.code ?? ''}</span>
      <span>商品名</span><span>{order?.product_snapshot.name ?? ''}</span>
      <span>工序名</span><span>{taskName}</span>
      <span>车间</span><span />
      <span>产线</span><span>无</span>
      <span>机台</span><span>无</span>
      <span>生产人员</span><span>{operator}</span>
      <span>报工数量</span><span>{row ? sumQty([row.good_qty, row.defect_qty]) : ''}</span>
      <span>良品数</span><span>{row ? qtyText(row.good_qty) : ''}</span>
      <span>不良品数</span><span>{row ? qtyText(row.defect_qty) : ''}</span>
      <span>计价方式</span><span>{modeText(row?.wage_snapshot?.mode)}</span>
      <span>开始时间</span><span>{when(row?.started_at)}</span>
      <span>结束时间</span><span>{when(row?.ended_at)}</span>
      <span>报工时长</span><span>{durationText(row?.effective_seconds ?? 0) || '无'}</span>
      <span>工资单价</span><span>{rateLabel(row?.wage_snapshot?.rate, order?.product_snapshot.unit_name)}</span>
      <span>工资</span><span>{yuanLabel(row?.estimated_wage)}</span>
      <span>参数1</span><span>-</span><span>参数2</span><span>-</span><span>参数3</span><span>-</span><span>参数4</span><span>-</span><span>参数5</span><span>-</span>
      <span>结算 *</span><Radio.Group value={settled} onChange={(event) => setSettled(event.target.value)} options={[{ value: false, label: '未结算' }, { value: true, label: '已结算' }]} />
      <span>备注</span><Input value={note} maxLength={255} suffix={`${note.length}/255`} onChange={(event) => setNote(event.target.value)} />
      <span className="wide">工资计算公式</span><span className="wide">{WAGE_FORMULA}</span>
    </div>
  </Modal>;
}

function ReportFiles({ report, onClose }: { report: Report; onClose: () => void }) {
  const { revision, onExpired } = useKgd();
  const files = useRemote<{ items: { id: string; filename: string; byte_size: number }[] }>(`/api/attachments?resource_type=production_report&resource_id=${encodeURIComponent(report.id)}`, revision, onExpired);
  return <Modal title={`报工附件 ${report.code}`} open onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    {files.error && <div className="kgd-banner">{files.error}</div>}
    {(files.data?.items ?? []).length ? (files.data?.items ?? []).map((file) => <div key={file.id}><a href={`/api/attachments/${file.id}/content`} target="_blank" rel="noreferrer">{file.filename}</a></div>) : <p className="kgd-muted">暂无附件</p>}
  </Modal>;
}
