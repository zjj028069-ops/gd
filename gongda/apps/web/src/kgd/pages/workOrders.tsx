import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Dropdown, Input, Modal, Select, Switch, Table, Tabs } from 'antd';
import type { TableProps } from 'antd';
import { apiRequest, errorMessage } from '../../api';
import { printDocs, type PrintDoc } from '../print';
import { PrintTemplateButton } from '../print/templates';
import { documentActionPayload, taskActionPayload, taskPricePayload, workOrderCreatePayload } from '../../domain/payloads';
import { useRemote } from '../../masterTools';
import type { Process } from '../../masterTypes';
import { idText } from '../../masterTypes';
import { useKgd } from '../context';
import { ListFrame } from '../ListFrame';
import type { ListColumn, QueryField } from '../ListFrame';
import { askReason, beijingTime, countdown, durationText, showError, StatusTag, sumYuan, useCommand, useQueryState, when } from '../kit';
import { DayField } from './money/shared';
import { cmpQty, qtyText, subQty, sumQty } from '../qty';
import { downloadCsv, inspectionText, modeText, mulCeilText, priorityText, qualityText, rateLabel, settlementText, yuanLabel } from '../wage';
import { ReportDialog } from './reportForm';
import { AsyncQr } from '../qr';
import { workOrderMobileUrl } from './mobile/device';
import { ColumnConfigModal, ExtensionAddDialog } from '../dialogs';
import { columnStorageKey, loadJson, saveJson, type ColumnPrefs } from '../storage';
import { ProgressCell } from './progress/ProgressCell';
import { ProcessRings } from './progress/ProcessRings';
import type { ProgressWorkOrderRow } from './progress/workOrderColumns';
import { moreMenuItems, ShareProgressModal, WorkOrderGanttModal, WorkOrderPickModal, WorkOrderScheduleModal } from './round11/produce/WorkOrderExtras';
import { ExtFieldInputs } from '../extensions/ExtFieldInputs';
import { useEntityExtensions } from '../extensions/useEntityExtensions';
import { requestKey } from '../../requestKey';

type Snap = { code?: string; name?: string; specification?: string; unit_name?: string };
type Task = { id: string; sequence: number; process_name: string; process_code?: string; process_id: string; plan_qty: string; unit_ratio: string; execution: string; pause_source: string; approved_good: string; approved_defect: string; approved_rework: string; approved_scrap: string; version: number; pricing_mode?: string; wage_rate?: string | null; inspection_scheme?: string; started_at?: string | null; completed_at?: string | null; planned_start?: string | null; planned_end?: string | null; pause_reason?: string; process_snapshot?: { code?: string; name?: string; standard_minutes?: string; reporter_ids?: string[] } };
type Material = { id: string; product_id: string; product_code: string; product_name: string; unit_name: string; required_qty: string; issued_qty: string };
type WorkOrder = {
  id: string; code: string; plan_qty: string; execution: string; order_paused: boolean; version: number; product_id: string; product_snapshot: Snap;
  tasks: Task[]; materials: Material[]; output_qty: string; received_qty: string; warehouse_id: string; sales_order_id: string | null; sales_line_id: string | null; contract_code?: string; contract_id?: string | null;
  bom_revision: number | null; close_reason: string; started_at: string | null; completed_at: string | null; created_at: string; requires_fg_inspection?: boolean;
  priority?: string; due_date?: string | null; planned_start?: string | null; planned_end?: string | null; note?: string;
  production_plan_id?: string | null; production_plan_code?: string; production_plan_name?: string;
  production_plan_line_id?: string | null;
};
type ProgressListPayload = {
  items: ProgressWorkOrderRow[];
  total: number;
  counts: Record<string, number>;
  summary: { plan_qty: string; output_qty: string };
};
type Sales = { id: string; code: string; promised_date: string | null; lifecycle: string; approval: string; lines: { id: string; product_id: string; product_code: string; product_name: string; quantity: string; scheduled_qty: string; unit_name: string }[] };
type Balance = { product_id: string; on_hand: string };
type ReportRow = { id: string; code: string; work_order_id: string; task_id: string; operator_id: string; good_qty: string; defect_qty: string; approval: string; created_at: string; note?: string; estimated_wage?: string | null; wage_snapshot?: { mode?: string; rate?: string } | null; quality_status?: string; settlement_status?: string; effective_seconds?: number };
type Draft = { key: string; process_id: string; code: string; name: string; pricing_mode: 'piece' | 'time'; wage_rate: string; standard_minutes: string; reporters: string; reporter_ids: string[]; inspection: string; unit_ratio: string; planned_start: string; planned_end: string; dispatch: string[] };
type Step = { process_id: string; process_code: string; process_name: string; standard_minutes: string; reporter_ids?: string[] };
const execText: Record<string, string> = { not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
const taskText: Record<string, string> = { not_started: '未开始', running: '进行中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
const priorities = [{ value: 'none', label: '无' }, { value: 'urgent', label: '加急' }, { value: 'normal', label: '正常' }, { value: 'delayed', label: '延期' }];

function issueStatus(materials: Material[]) {
  if (!materials.length) return '—';
  if (materials.every((item) => cmpQty(item.issued_qty, '0') === 0)) return '未领料';
  if (materials.every((item) => cmpQty(item.issued_qty, item.required_qty) >= 0)) return '已领料';
  return '部分领料';
}
function currentTask(order: WorkOrder) {
  return order.tasks.find((task) => task.execution !== 'completed' && task.execution !== 'cancelled');
}
function usedText(start?: string | null, end?: string | null) {
  if (!start || !end) return '';
  const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  return durationText(seconds);
}

type Linked = { project_id?: string | null; project_code?: string; project_name?: string; parent_id?: string | null };

function workOrderDoc(order: WorkOrder & Linked): PrintDoc {
  return {
    title: '加工单',
    fields: [
      ['加工单号', order.code], ['商品编号', order.product_snapshot.code ?? ''], ['商品名称', order.product_snapshot.name ?? ''], ['规格', order.product_snapshot.specification ?? ''],
      ['计划数', qtyText(order.plan_qty)], ['实际生产数', qtyText(order.output_qty)], ['状态', execText[order.execution] ?? order.execution], ['优先级', priorityText(order.priority)],
      ['交货日期', order.due_date?.slice(0, 10) ?? ''], ['计划开始', order.planned_start?.slice(0, 10) ?? ''], ['计划结束', order.planned_end?.slice(0, 10) ?? ''],
      ['合同编号', order.contract_code ?? ''], ['生产计划', order.production_plan_code ?? ''], ['项目', order.project_name ?? ''], ['备注', order.note?.trim() || '无'],
    ],
    columns: ['序号', '工序', '工序编号', '计价方式', '生产数量', '良品数', '不良品数', '状态'],
    rows: order.tasks.map((task, index) => [String(index + 1), task.process_name, task.process_code || task.process_snapshot?.code || '', modeText(task.pricing_mode), qtyText(task.plan_qty), qtyText(task.approved_good), qtyText(task.approved_defect), taskText[task.execution] ?? task.execution]),
  };
}

async function printWorkOrders(ids: string[]) {
  const docs: PrintDoc[] = [];
  for (const id of ids) docs.push(workOrderDoc((await apiRequest<{ work_order: WorkOrder }>(`/api/work-orders/${id}`)).work_order));
  if (!printDocs(docs, '加工单')) throw new Error('浏览器拦截了打印窗口，请允许弹出窗口后重试');
}

const queryFields: QueryField[] = [
  { key: 'code', label: '加工单号' }, { key: 'contract', label: '合同编号' }, { key: 'plan', label: '生产计划', placeholder: '生产计划编号/名称' },
  { key: 'projectCode', label: '项目编号' }, { key: 'projectName', label: '项目名称' }, { key: 'seller', label: '业务员' },
  { key: 'productCode', label: '商品编号' }, { key: 'product', label: '商品' }, { key: 'bom', label: 'BOM' }, { key: 'category', label: '商品类别' },
  { key: 'current', label: '当前工序' }, { key: 'pause', label: '暂停原因' }, { key: 'priority', label: '优先级' },
  { key: 'issue', label: '领料状态' }, { key: 'planQty', label: '计划数' }, { key: 'output', label: '实际生产数' },
  { key: 'planStartFrom', label: '计划开始起', kind: 'date' }, { key: 'planStartTo', label: '计划开始止', kind: 'date' },
  { key: 'planEndFrom', label: '计划结束起', kind: 'date' }, { key: 'planEndTo', label: '计划结束止', kind: 'date' },
  { key: 'creator', label: '创建人' }, { key: 'cancel', label: '取消原因' },
  { key: 'createdFrom', label: '创建时间起', kind: 'date' }, { key: 'createdTo', label: '创建时间止', kind: 'date' },
  { key: 'startedFrom', label: '开始时间起', kind: 'date' }, { key: 'startedTo', label: '开始时间止', kind: 'date' },
  { key: 'finishedFrom', label: '完成时间起', kind: 'date' }, { key: 'finishedTo', label: '完成时间止', kind: 'date' },
  { key: 'dueFrom', label: '交货日期起', kind: 'date' }, { key: 'dueTo', label: '交货日期止', kind: 'date' },
  { key: 'note', label: '备注' },
];

export function WorkOrderList() {
  const navigate = useNavigate();
  const { revision, onExpired, session, onChanged } = useKgd();
  const command = useCommand();
  const list = useQueryState(10);
  const [chosen, setChosen] = useState<string[]>([]);
  const [gantt, setGantt] = useState<ProgressWorkOrderRow | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [pick, setPick] = useState<{ mode: 'parent' | 'children'; id: string } | null>(null);
  const [expandKids, setExpandKids] = useState(false);
  const [addExt, setAddExt] = useState(false);
  const ext = useEntityExtensions('work_order');
  const status = list.chips.status ?? 'all';
  const late = list.chips.overdue ?? 'all';
  const priority = list.chips.priority ?? 'all';
  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (late === 'yes') params.set('overdue', '1');
    if (late === 'no') params.set('overdue', '0');
    if (priority !== 'all') params.set('priority', priority);
    Object.entries(list.query).forEach(([key, value]) => { if (value.trim()) params.set(key, value.trim()); });
    params.set('page', String(list.page));
    params.set('page_size', String(list.pageSize));
    return `/api/progress/work-orders?${params}`;
  }, [late, list.page, list.pageSize, list.query, priority, status]);
  const remote = useRemote<ProgressListPayload>(path, revision, onExpired);
  const counts = remote.data?.counts;
  const allRows = remote.data?.items ?? [];
  const rows = expandKids ? allRows : allRows.filter((row) => !row.parent_id);
  async function act(order: ProgressWorkOrderRow, action: string, reason = '') {
    try { await command.send(`/api/work-orders/${order.id}/actions`, documentActionPayload(action, order.version ?? 0, reason)); }
    catch (failure) { command.setError(showError(failure)); }
  }
  async function print(ids: string[]) {
    if (!ids.length) { command.setError('请先勾选加工单'); return; }
    try { await printWorkOrders(ids); } catch (failure) { command.setError(showError(failure)); }
  }
  async function batchStart() {
    const picked = rows.filter((row) => chosen.includes(row.id));
    if (!picked.length) { command.setError('请先勾选加工单'); return; }
    const results: string[] = [];
    for (const row of picked) {
      if (row.execution !== 'not_started') { results.push(`${row.code}：当前状态为「${execText[row.execution] ?? row.execution}」，只有未开始的加工单可以开始`); continue; }
      try {
        await apiRequest(`/api/work-orders/${row.id}/actions`, { method: 'POST', csrfToken: session.csrf_token, body: documentActionPayload('start', row.version ?? 0, '') });
        results.push(`${row.code}：已开始生产`);
      } catch (failure) { results.push(`${row.code}：${errorMessage(failure)}`); }
    }
    setChosen([]);
    onChanged();
    Modal.info({ title: '批量开始结果', content: <div>{results.map((line) => <p key={line}>{line}</p>)}</div>, okText: '知道了' });
  }
  const chip = (value: string, label: string, count?: number) => ({ value, label: count === undefined ? label : `${label}(${count})` });
  const dash = (value: unknown) => {
    const text = String(value ?? '').trim();
    return text || '-';
  };
  const baseColumns: ListColumn<ProgressWorkOrderRow>[] = [
    { key: 'seq', title: '排单序号', render: (row) => row.schedule_no && row.schedule_no > 0 ? String(row.schedule_no) : '-' },
    // 合同编号按 pages.json P051 不单独成列；编号挂在加工单号下供 round9 截图/断言可见
    { key: 'code', title: '加工单号', render: (row) => <span><button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.id}`)}>{row.code}</button>{row.contract_code?.trim() ? <div className="cell-subtitle">{row.contract_code}</div> : null}</span> },
    { key: 'product', title: '商品', render: (row) => row.product_snapshot.name ?? '' },
    { key: 'plan', title: '计划数', render: (row) => qtyText(row.plan_qty) },
    { key: 'stock', title: '库存', render: (row) => row.stock_qty?.trim() ? row.stock_qty : '无' },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={execText[row.execution] ?? row.execution} /> },
    { key: 'priority', title: '优先级', render: (row) => <span className="kgd-dot">● {priorityText(row.priority)}</span> },
    { key: 'progressDetail', title: '工序进度详情', render: (row) => <ProcessRings tasks={row.ring_tasks ?? []} workOrderCode={row.code} /> },
    { key: 'productCode', title: '商品编号', render: (row) => row.product_snapshot.code ?? '' },
    { key: 'category', title: '商品类别', render: (row) => dash(row.category_name) },
    { key: 'image', title: '商品图片', render: () => '-' },
    { key: 'spec', title: '商品规格', render: (row) => row.product_snapshot.specification ?? '' },
    { key: 'output', title: '实际生产数', render: (row) => qtyText(row.output_qty) },
    { key: 'issue', title: '领料状态', render: (row) => row.issue_status ?? '—' },
    { key: 'due', title: '交货日期', render: (row) => row.due_date?.slice(0, 10) ?? '' },
    { key: 'countdown', title: '交货倒计时', render: (row) => countdown(row.due_date) },
    { key: 'current', title: '当前工序', render: (row) => row.current_process ?? '' },
    { key: 'progress', title: '工序进度', render: (row) => <ProgressCell variant="circle" done={row.process_progress?.done} total={row.process_progress?.total} /> },
    { key: 'hours', title: '加工单总工时', render: (row) => row.hours_text || '-' },
    { key: 'taskProgress', title: '任务进度', render: (row) => <ProgressCell variant="circle" done={row.task_progress?.done} total={row.task_progress?.total} /> },
    { key: 'flow', title: '工序流程', render: (row) => (row.ring_tasks ?? []).map((task) => task.process_name).join('→') },
    { key: 'drawing', title: '图纸', render: () => '-' },
    { key: 'planStart', title: '计划开始', render: (row) => row.planned_start?.slice(0, 10) ?? '' },
    { key: 'planEnd', title: '计划结束', render: (row) => row.planned_end?.slice(0, 10) ?? '' },
    { key: 'started', title: '开始时间', render: (row) => row.started_at ? beijingTime(row.started_at) : '-' },
    { key: 'finished', title: '完成时间', render: (row) => row.completed_at ? beijingTime(row.completed_at) : '-' },
    { key: 'pause', title: '暂停原因', render: (row) => dash(row.pause_reason) },
    { key: 'cancel', title: '取消原因', render: (row) => dash(row.cancel_reason) },
    { key: 'issued', title: '生产出库', render: (row) => dash(row.issued_qty) },
    { key: 'received', title: '成品入库', render: (row) => dash(row.fg_qty ?? row.received_qty) },
    { key: 'semi', title: '半成品入库', render: (row) => dash(row.semi_qty) },
    { key: 'returned', title: '生产退料', render: (row) => dash(row.return_qty) },
    { key: 'note', title: '备注', render: (row) => dash(row.note) },
    { key: 'inbound', title: '入库进度', render: (row) => <ProgressCell done={row.inbound_progress?.done} total={row.inbound_progress?.total} /> },
    { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
    { key: 'created', title: '创建时间', render: (row) => row.created_at ? beijingTime(row.created_at) : '' },
    { key: 'actions', title: '操作', width: 180, render: (row) => <span onClick={(event) => event.stopPropagation()}>
      <button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.id}?tab=wages`)}>工资单</button>
      <button className="kgd-link" onClick={() => void print([row.id])}>打印</button>
      <Dropdown menu={{ items: moreMenuItems(row, (item, action, reason) => void act(item, action, reason), navigate, {
        onParent: () => setPick({ mode: 'parent', id: row.id }),
        onChildren: () => setPick({ mode: 'children', id: row.id }),
        onGantt: () => setGantt(row),
        onEdit: () => navigate(`/inside_produce_bill/detail/${row.id}`),
        onCopy: () => navigate(row.contract_id ? '/inside_produce_bill/add' : '/inside_produce_bill/add?mode=direct'),
        onDelete: () => Modal.confirm({
          title: '确定删除该加工单吗？', content: '删除后不可恢复。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
          onOk: () => void act(row, 'delete'),
        }),
      }) }}><Button type="link">更多</Button></Dropdown>
    </span> },
  ];
  const columns: ListColumn<ProgressWorkOrderRow>[] = [
    ...baseColumns.slice(0, -1),
    ...ext.fields.map((field) => ({ key: `ext:${field.id}`, title: field.name, render: () => '' })),
    baseColumns[baseColumns.length - 1]!,
  ];
  const cardFields = Object.fromEntries(['list', 'detail', 'task', 'share'].map((key) => [key, columns.filter((column) => column.key !== 'actions').map((column) => ({ key: column.key, label: column.title }))]));
  const summaryNode = (
    <div className="kgd-summary">
      【总计划数】<b className="kgd-overdue-mark">{qtyText(remote.data?.summary.plan_qty)}</b>
      【实际生产数】<b className="kgd-overdue-mark">{qtyText(remote.data?.summary.output_qty)}</b>
    </div>
  );
  return <>
    <ListFrame pageKey="work-orders" columns={columns} rows={rows} loading={remote.loading || command.busy} error={remote.error || command.error} chips={[
      { key: 'status', label: '工单状态', options: [chip('all', '全部', counts?.all), chip('not_started', '未开始', counts?.not_started), chip('running', '生产中', counts?.running), chip('completed', '已完成', counts?.completed), chip('cancelled', '已取消', counts?.cancelled), chip('paused', '已暂停', counts?.paused)] },
      { key: 'overdue', label: '是否逾期', options: [chip('all', '全部', counts?.all), chip('yes', '已逾期', counts?.overdue), chip('no', '未逾期', counts?.on_time)] },
      { key: 'priority', label: '优先级', options: [chip('all', '全部', counts?.all), chip('urgent', '加急', counts?.urgent), chip('normal', '正常', counts?.normal), chip('delayed', '延期', counts?.delayed)] },
    ]} chipValue={list.chips} onChip={list.onChip} queryFields={queryFields} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      toolbar={<>
        <Dropdown menu={{ items: [{ key: 'direct', label: '直接创建', onClick: () => navigate('/inside_produce_bill/add?mode=direct') }, { key: 'contract', label: '合同创建', onClick: () => navigate('/inside_produce_bill/add?pick=1') }] }}><Button type="primary">新增</Button></Dropdown>
        <Dropdown menu={{ items: [{ key: 'start', label: '批量开始', onClick: () => void batchStart() }, { key: 'print', label: '批量打印', onClick: () => void print(chosen) }] }}><Button>批量操作{chosen.length ? `(${chosen.length})` : ''}</Button></Dropdown>
        <Button onClick={() => setExpandKids((current) => !current)}>{expandKids ? '收起子单' : '展开子单'}</Button>
        <Button aria-label="排单" onClick={() => setScheduleOpen(true)}>排单</Button>
      </>}
      moreItems={[
        { key: 'import', label: '导入加工单' },
        { key: 'export', label: '导出' },
        { key: 'export-log', label: '导出记录' },
        { key: 'upload', label: '批量上传文件' },
      ]}
      rowSelection={{ selected: chosen, onChange: setChosen }}
      summary={summaryNode}
      page={list.page} pageSize={list.pageSize} total={remote.data?.total ?? 0} onPage={list.onPage} clientPaging={false}
      rowClassName={(row) => row.overdue ? 'kgd-overdue' : ''}
      extensionObject="加工单" extensionRows={ext.extensionRows} extensionCanAdd
      onExtensionAdd={() => setAddExt(true)}
      onExtensionReorder={(ids) => void ext.reorder(ids).catch((failure) => command.setError(showError(failure)))}
      onExtensionDelete={(id) => void ext.deleteField(id).catch((failure) => command.setError(showError(failure)))}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }, { key: 'detail', label: '详情卡片' }, { key: 'task', label: '任务卡片' }, { key: 'share', label: '进度分享' }]} mobileFields={cardFields}
      onMobileCards={(next) => { Object.entries(next).forEach(([tab, fields]) => { void command.send('/api/mobile-cards', { page_key: 'work-orders', tab_key: tab, fields }, 'PUT'); }); }}
      defaultQueryKeys={['code', 'contract', 'product']}
      defaultVisible={columns.map((column) => column.key)} defaultLocked={['code']} />
    <WorkOrderGanttModal row={gantt} onClose={() => setGantt(null)} />
    <WorkOrderScheduleModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
    <WorkOrderPickModal open={!!pick} mode={pick?.mode ?? 'parent'} currentId={pick?.id ?? ''} onClose={() => setPick(null)} onOk={(ids) => {
      if (!pick) return;
      void apiRequest(`/api/work-order-links/${pick.id}`, { method: 'PUT', csrfToken: session.csrf_token, body: pick.mode === 'parent' ? { parent_id: ids[0] } : { child_ids: ids } }).then(() => onChanged()).finally(() => setPick(null));
    }} />
    <ExtensionAddDialog open={addExt} mode="work_order" onCancel={() => setAddExt(false)} onOk={(value) => {
      void ext.createField({
        name: value.label, required: value.required, field_type: value.type,
        options: {
          choices_text: value.options,
          formula: value.formula,
          autofill: value.autofill,
          input_modes: value.input_modes,
          decimals: value.decimals,
          biz_object: value.biz_object,
          display_field: value.display_field,
          rel_object: value.rel_object,
          rel_field: value.rel_field,
        },
      }).then(() => setAddExt(false)).catch((failure) => command.setError(showError(failure)));
    }} />
  </>;
}

function draftOf(process: Process | undefined, step?: Step): Draft {
  const mode = process?.pricing_mode === 'time' ? 'time' : 'piece';
  return {
    key: requestKey(),
    process_id: process ? idText(process.id) : step?.process_id ?? '',
    code: process?.code || step?.process_code || '',
    name: process?.name || step?.process_name || '',
    pricing_mode: mode,
    wage_rate: (process?.wage_rate ?? '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''),
    standard_minutes: process?.standard_minutes || step?.standard_minutes || '',
    reporters: process ? `${process.reporter_ids.length}人` : step?.reporter_ids?.length ? `${step.reporter_ids.length}人` : '',
    reporter_ids: process ? process.reporter_ids.map(idText) : (step?.reporter_ids ?? []).map(String),
    inspection: inspectionText(process?.inspection_scheme ?? 'none'),
    unit_ratio: '1',
    planned_start: '',
    planned_end: '',
    dispatch: [],
  };
}

export function WorkOrderAdd() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const direct = params.get('mode') === 'direct';
  const productionPlanLineId = params.get('production_plan_line_id');
  const preset = (location.state ?? {}) as { sales_line_id?: string; quantity?: string; bom_id?: string; warehouse_id?: string };
  const { revision, onExpired, session, onChanged } = useKgd();
  const planPrefill = useRemote<{ product_id: string; remaining_qty: string; bom_id: string | null; bom_version_id: string | null }>(
    productionPlanLineId ? `/api/production-plan-lines/${productionPlanLineId}/prefill` : null,
    revision,
    onExpired,
  );
  const command = useCommand();
  const contracts = useRemote<{ items: { id: string; code: string; approval: string; customer_name: string; lines: { id: string; product_id: string; product_code: string; product_name: string; quantity: string }[] }[] }>(direct ? null : '/api/money/contracts', revision, onExpired);
  const scheduled = useRemote<{ items: { contract_line_id?: string | null; execution: string; plan_qty: string }[] }>(direct ? null : '/api/progress/work-orders?page=1&page_size=200', revision, onExpired);
  const products = useRemote<{ items: { id: string; code: string; name: string; active?: boolean; source?: string | null; attribute?: string | null }[] }>('/api/products?page=1&page_size=100', revision, onExpired);
  const projects = useRemote<{ items: { id: string; code: string; name: string; status: string }[] }>('/api/production-projects?page=1&page_size=200', revision, onExpired);
  const stockBalances = useRemote<{ items: Balance[] }>('/api/stock/balances', revision, onExpired);
  const processes = useRemote<{ items: Process[] }>('/api/processes', revision, onExpired);
  const boms = useRemote<{ items: { id: string; parent_product_id: string; parent_name: string; current_version_id: string; current_revision: number; active: boolean }[] }>('/api/boms', revision, onExpired);
  const routes = useRemote<{ items: { id: string; name: string; current_version_id: string; active: boolean }[] }>('/api/routes', revision, onExpired);
  const warehouses = useRemote<{ items: { id: string; code: string; name: string; active: boolean }[] }>('/api/warehouses', revision, onExpired);
  const [lineId, setLineId] = useState(preset.sales_line_id || params.get('sales_line_id') || '');
  const [picking, setPicking] = useState(!direct && params.get('pick') === '1' && !preset.sales_line_id && !params.get('sales_line_id'));
  const [productId, setProductId] = useState('');
  const usedQty = (id: string) => (scheduled.data?.items ?? []).filter((row) => row.contract_line_id === id && row.execution !== 'cancelled').reduce((sum, row) => sum + Number(row.plan_qty || 0), 0);
  const contractLines = (contracts.data?.items ?? []).filter((order) => order.approval === 'approved' || order.approval === 'exempt').flatMap((order) => order.lines.map((item) => ({ ...item, scheduled_qty: String(usedQty(item.id)), order: { code: order.code, promised_date: null as string | null } })));
  const line = contractLines.find((item) => item.id === lineId);
  const chosenProduct = direct ? productId : (line?.product_id ?? '');
  const [bomId, setBomId] = useState(preset.bom_id ?? '');
  const bom = boms.data?.items.find((item) => item.id === bomId);
  const version = useRemote<{ version: { route_version_id: string | null } }>(bom ? `/api/bom-versions/${bom.current_version_id}` : null, revision, onExpired);
  const bound = version.data?.version.route_version_id ?? '';
  const [routeVersionId, setRouteVersionId] = useState('');
  const frozenRoute = bound || routeVersionId;
  const routeVersion = useRemote<{ steps: Step[] }>(frozenRoute ? `/api/route-versions/${frozenRoute}` : null, revision, onExpired);
  const [plan, setPlan] = useState(preset.quantity || (line ? '' : ''));
  const [code, setCode] = useState('');
  const [priority, setPriority] = useState('none');
  const [due, setDue] = useState('');
  const [planStart, setPlanStart] = useState('');
  const [planEnd, setPlanEnd] = useState('');
  const [note, setNote] = useState('');
  const [warehouseId, setWarehouseId] = useState(preset.warehouse_id ?? '');
  const [inspect, setInspect] = useState(false);
  const [cost, setCost] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [manual, setManual] = useState(false);
  const [tab, setTab] = useState('base');
  const [pickOpen, setPickOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [projectId, setProjectId] = useState(params.get('project_id') ?? '');
  const [draftKeys, setDraftKeys] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const emptyBatch = { pricing_mode: '', wage_rate: '', unit_ratio: '', planned_start: '', planned_end: '', dispatch: [] as string[] };
  const [batchDraft, setBatchDraft] = useState(emptyBatch);
  const ext = useEntityExtensions('work_order');
  const [extValues, setExtValues] = useState<Record<string, unknown>>({});
  const teamMembers = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', revision, onExpired);
  const reporterOptions = (ids: string[]) => (teamMembers.data?.items ?? []).filter((item) => ids.includes(String(item.id))).map((item) => ({ value: String(item.id), label: item.display_name }));
  const taskColumnKey = columnStorageKey(String(session.user.id), 'work-order-add-tasks');
  const [taskPrefs, setTaskPrefs] = useState<ColumnPrefs | null>(() => loadJson<ColumnPrefs | null>(taskColumnKey, null));
  const [taskColumnsOpen, setTaskColumnsOpen] = useState(false);
  const taskTitles = useRef<string[]>([]);
  function arrangeTasks(columns: TableProps<Draft>['columns'] & object) {
    const titles = columns.map((column) => String(column.title));
    taskTitles.current = titles;
    if (!taskPrefs) return columns;
    const order = [...taskPrefs.order.filter((key) => titles.includes(key)), ...titles.filter((key) => !taskPrefs.order.includes(key))];
    return order.filter((key) => key === '操作' || taskPrefs.visible.includes(key) || !taskPrefs.order.includes(key)).map((key) => columns[titles.indexOf(key)]!);
  }
  const batchReporters = [...new Set(drafts.filter((item) => draftKeys.includes(item.key)).flatMap((item) => item.reporter_ids))];
  const [childKeys, setChildKeys] = useState<string[]>([]);
  const [selfOnly, setSelfOnly] = useState(true);
  const explosion = useRemote<{ requirements: { product_id: string; code: string; name: string; unit_name: string; quantity: string }[] }>(bom && plan ? `/api/boms/${bom.id}/explosion?quantity=${encodeURIComponent(plan)}` : null, revision, onExpired);
  const sourceOf = (id: string) => {
    const product = products.data?.items.find((item) => item.id === id);
    return product?.source || (product?.attribute === 'purchased' ? '外购' : product?.attribute === 'outsourced' ? '外协加工' : product ? '自产' : '-');
  };
  const childRows = (explosion.data?.requirements ?? []).map((item) => ({
    ...item,
    source: sourceOf(item.product_id),
    stock: sumQty((stockBalances.data?.items ?? []).filter((row) => row.product_id === item.product_id).map((row) => row.on_hand)),
    bom: (boms.data?.items ?? []).find((row) => row.parent_product_id === item.product_id && row.active),
  })).filter((item) => !selfOnly || item.source === '自产');
  function applyBatch() {
    setManual(true);
    setDrafts((current) => current.map((item) => draftKeys.includes(item.key) ? {
      ...item,
      ...(batchDraft.pricing_mode ? { pricing_mode: batchDraft.pricing_mode as Draft['pricing_mode'] } : {}),
      ...(batchDraft.wage_rate.trim() ? { wage_rate: batchDraft.wage_rate.trim() } : {}),
      ...(batchDraft.unit_ratio.trim() ? { unit_ratio: batchDraft.unit_ratio.trim() } : {}),
      ...(batchDraft.planned_start ? { planned_start: batchDraft.planned_start } : {}),
      ...(batchDraft.planned_end ? { planned_end: batchDraft.planned_end } : {}),
      ...(batchDraft.dispatch.length ? { dispatch: batchDraft.dispatch.filter((id) => item.reporter_ids.includes(id)) } : {}),
    } : item));
    setBatchOpen(false);
  }
  async function createChildren(parentId: string) {
    const results: string[] = [];
    const chosenChildren = childRows.filter((item) => childKeys.includes(item.product_id));
    for (const child of chosenChildren) {
      try {
        if (!child.bom) { results.push(`${child.name}：未设置BOM与商品工序，未创建子单`); continue; }
        const detail = await apiRequest<{ version: { route_version_id: string | null } }>(`/api/bom-versions/${child.bom.current_version_id}`);
        if (!detail.version.route_version_id) { results.push(`${child.name}：未设置商品工序，未创建子单`); continue; }
        const steps = (await apiRequest<{ steps: Step[] }>(`/api/route-versions/${detail.version.route_version_id}`)).steps;
        const childTasks = steps.map((step) => draftOf(processes.data?.items.find((item) => idText(item.id) === step.process_id), step));
        const created = await apiRequest<{ work_order: { id: string; code?: string } }>('/api/work-orders', { method: 'POST', csrfToken: session.csrf_token, body: workOrderCreatePayload({
          product_id: child.product_id, code: '', quantity: child.quantity, warehouse_id: warehouseId, requires_fg_inspection: false, require_cost: cost,
          route_version_id: detail.version.route_version_id, bom_version_id: child.bom.current_version_id,
          priority, planned_start: planStart || null, planned_end: planEnd || null, due_date: due || null, note: '',
          tasks: childTasks.map((row) => ({ process_id: row.process_id, unit_ratio: row.unit_ratio || '1', pricing_mode: row.pricing_mode, wage_rate: row.wage_rate.trim() ? row.wage_rate.trim() : null })),
        }) });
        await apiRequest(`/api/work-order-links/${created.work_order.id}`, { method: 'PUT', csrfToken: session.csrf_token, body: { parent_id: parentId, ...(projectId ? { project_id: projectId } : {}) } });
      } catch (failure) { results.push(`${child.name}：${errorMessage(failure)}`); }
    }
    return results;
  }
  const [contractKeyword, setContractKeyword] = useState('');
  const needle = contractKeyword.trim().toLowerCase();
  const choices = contractLines
    .filter((item) => {
      const remain = cmpQty(item.quantity, item.scheduled_qty) > 0;
      if (!needle) return remain;
      const hay = `${item.order.code} ${item.product_name} ${item.product_code}`.toLowerCase();
      return hay.includes(needle);
    })
    .sort((a, b) => {
      const aOpen = cmpQty(a.quantity, a.scheduled_qty) > 0 ? 0 : 1;
      const bOpen = cmpQty(b.quantity, b.scheduled_qty) > 0 ? 0 : 1;
      return aOpen - bOpen || a.order.code.localeCompare(b.order.code);
    });
  useEffect(() => {
    if (direct || preset.quantity || !line || plan) return;
    setPlan(subQty(line.quantity, line.scheduled_qty));
  }, [direct, line, plan, preset.quantity]);
  useEffect(() => {
    if (warehouseId || !warehouses.data) return;
    const first = warehouses.data.items.find((item) => item.active);
    if (first) setWarehouseId(first.id);
  }, [warehouseId, warehouses.data]);
  useEffect(() => {
    if (!planPrefill.data || !direct) return;
    setProductId(planPrefill.data.product_id);
    setPlan(planPrefill.data.remaining_qty);
    if (planPrefill.data.bom_id) setBomId(planPrefill.data.bom_id);
  }, [direct, planPrefill.data]);
  useEffect(() => {
    if (direct || manual || !routeVersion.data) return;
    setDrafts(routeVersion.data.steps.map((step) => draftOf(processes.data?.items.find((item) => idText(item.id) === step.process_id), step)));
  }, [direct, manual, processes.data, routeVersion.data]);
  useEffect(() => {
    if (!chosenProduct && !lineId) return;
    const contract = (contracts.data?.items ?? []).find((order) => order.lines.some((item) => item.id === lineId));
    void ext.previewAutofill({
      product_id: chosenProduct || undefined,
      contract_id: contract?.id,
      contract_line_id: lineId || undefined,
    }).then((filled) => setExtValues((current) => ({ ...current, ...filled }))).catch(() => undefined);
  }, [chosenProduct, lineId]); // eslint-disable-line react-hooks/exhaustive-deps
  function appendProcesses(ids: string[]) {
    const next = ids.map((id) => processes.data?.items.find((item) => idText(item.id) === id)).filter((item): item is Process => !!item).map((item) => draftOf(item));
    setManual(true);
    setDrafts((current) => [...current, ...next]);
  }
  async function addRoute(versionId: string) {
    if (bound && versionId !== bound) { command.setError('所选BOM已绑定工艺路线，请使用同一条路线'); return; }
    const body = await apiRequest<{ steps: Step[] }>(`/api/route-versions/${versionId}`);
    setRouteVersionId(versionId);
    setManual(true);
    setDrafts(body.steps.map((step) => draftOf(processes.data?.items.find((item) => idText(item.id) === step.process_id), step)));
  }
  async function addProductRoute() {
    if (!chosenProduct) { command.setError('请先选择商品'); return; }
    const matched = (boms.data?.items ?? []).find((item) => item.parent_product_id === chosenProduct && item.active);
    if (!matched) { command.setError('该商品未设置商品工序'); return; }
    const detail = await apiRequest<{ version: { route_version_id: string | null } }>(`/api/bom-versions/${matched.current_version_id}`);
    if (!detail.version.route_version_id) { command.setError('该商品未设置商品工序'); return; }
    setBomId(matched.id);
    await addRoute(detail.version.route_version_id);
  }
  async function save() {
    command.clearFieldErrors();
    if (direct ? !chosenProduct : !line) { command.setFieldError('product_id', '请选择商品'); return; }
    if (!plan.trim()) { command.setFieldError('quantity', '请填写计划数'); return; }
    if (!drafts.length) { command.setFieldError('tasks', '请至少添加一道工序'); return; }
    const extErr = ext.validateRequired(extValues);
    if (extErr) { command.setError(extErr); return; }
    try {
      const created = await command.send<{ work_order: { id: string } }>('/api/work-orders', workOrderCreatePayload({
        ...(direct ? { product_id: chosenProduct, code } : { contract_line_id: line!.id }),
        ...(productionPlanLineId ? { production_plan_line_id: productionPlanLineId } : {}),
        quantity: plan, warehouse_id: warehouseId, requires_fg_inspection: inspect, require_cost: cost,
        due_date: (due || (!direct ? line?.order.promised_date?.slice(0, 10) ?? '' : '')) || null,
        ...(frozenRoute ? { route_version_id: frozenRoute } : {}),
        ...(bom ? { bom_version_id: bom.current_version_id } : {}),
        priority, planned_start: planStart || null, planned_end: planEnd || null, note,
        tasks: drafts.map((row) => ({ process_id: row.process_id, unit_ratio: row.unit_ratio || '1', pricing_mode: row.pricing_mode, wage_rate: row.wage_rate.trim() ? row.wage_rate.trim() : null })),
      }));
      const parentId = created?.work_order.id;
      if (!parentId) return;
      const problems: string[] = [];
      if (ext.fields.length) {
        try {
          const contract = (contracts.data?.items ?? []).find((order) => order.lines.some((item) => item.id === lineId));
          await apiRequest('/api/entity-ext-values', {
            method: 'PUT', csrfToken: session.csrf_token,
            body: {
              entity: 'work_order', record_id: parentId, values: extValues,
              product_id: chosenProduct || undefined,
              contract_id: contract?.id,
              contract_line_id: lineId || undefined,
            },
          });
        } catch (failure) { problems.push(`扩展字段未保存：${errorMessage(failure)}`); }
      }
      if (projectId) {
        try { await apiRequest(`/api/work-order-links/${parentId}`, { method: 'PUT', csrfToken: session.csrf_token, body: { project_id: projectId } }); }
        catch (failure) { problems.push(`关联项目失败：${errorMessage(failure)}`); }
      }
      if (drafts.some((row) => row.planned_start || row.planned_end || row.dispatch.length)) {
        try {
          await apiRequest(`/api/work-orders/${parentId}/task-plans`, { method: 'PUT', csrfToken: session.csrf_token, body: { items: drafts.map((row, index) => ({ sequence: index + 1, planned_start: row.planned_start || null, planned_end: row.planned_end || null, dispatch_operator_ids: row.dispatch })) } });
        } catch (failure) { problems.push(`工序计划时间/生产派工未保存：${errorMessage(failure)}`); }
      }
      if (childKeys.length) problems.push(...await createChildren(parentId));
      onChanged();
      if (problems.length) Modal.warning({ title: '加工单已创建，以下内容未完成', content: <div>{problems.map((line) => <p key={line}>{line}</p>)}</div>, okText: '知道了' });
      navigate(`/inside_produce_bill/detail/${parentId}`);
    } catch (failure) { command.setError(showError(failure)); }
  }
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => navigate('/inside_produce_bill/list')}>返回</Button></div>
    <h2>创建加工单</h2>
    <div className="kgd-anchors">{[['base', '基本信息'], ['tasks', '生产任务'], ['materials', '用料清单'], ['children', '子加工单']].map(([key, label]) => <button key={key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <Tabs activeKey={tab} onChange={setTab} items={[
      { key: 'base', label: '基本信息', children: <div className="kgd-form">
        <span>加工单号</span><Input value={direct ? code : ''} disabled={!direct} placeholder="请填写，忽略将自动生成" onChange={(event) => setCode(event.target.value)} />
        <span>商品 *</span>{direct ? <span><Select showSearch optionFilterProp="label" style={{ minWidth: 280 }} value={productId || undefined} placeholder="选择商品" onChange={setProductId} options={(products.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} /></span> : <span><Input readOnly value={line ? `${line.product_code} ${line.product_name}` : ''} style={{ width: 240 }} /><Button onClick={() => setPicking(true)}>选择合同订单</Button></span>}
        <span>BOM</span><Select allowClear value={bomId || undefined} placeholder="选择 BOM" onChange={(value) => setBomId(value ?? '')} options={(boms.data?.items ?? []).filter((item) => item.parent_product_id === chosenProduct && item.active).map((item) => ({ value: item.id, label: `${item.parent_name} r${item.current_revision}` }))} />
        <span>计划数 *</span><Input value={plan} onChange={(event) => setPlan(event.target.value)} />
        <span>交货日期</span><DayField value={due || (!direct ? line?.order.promised_date?.slice(0, 10) ?? '' : '')} onChange={setDue} />
        <span>优先级</span><Select value={priority} onChange={setPriority} options={priorities} />
        <span>计划开始</span><DayField value={planStart} onChange={setPlanStart} />
        <span>计划结束</span><DayField value={planEnd} onChange={setPlanEnd} />
        <span>项目</span><Select allowClear showSearch optionFilterProp="label" value={projectId || undefined} placeholder="选择项目" onChange={(value) => setProjectId(value ?? '')} options={(projects.data?.items ?? []).filter((item) => item.status !== '已取消').map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
        <span>备注</span><Input value={note} maxLength={255} onChange={(event) => setNote(event.target.value)} suffix={`${note.length}/255`} />
        <span>成品仓库</span><Select allowClear value={warehouseId || undefined} onChange={(value) => setWarehouseId(value ?? '')} options={(warehouses.data?.items ?? []).filter((item) => item.active).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
        <span>需要成品检验</span><Switch checked={inspect} onChange={setInspect} />
        <span>需要成本</span><Switch checked={cost} onChange={setCost} />
        <div data-testid="sedric-wo-ext-fields"><ExtFieldInputs fields={ext.fields} values={extValues} onChange={setExtValues} /></div>
      </div> },
      { key: 'tasks', label: '生产任务', children: <>
        <div className="kgd-toolbar">
          <Button onClick={() => { setPicked([]); setPickOpen(true); }}>从工序中添加</Button>
          <Select style={{ minWidth: 180 }} placeholder="从工艺路线中添加" value={undefined} onChange={(value) => void addRoute(routes.data?.items.find((item) => item.id === value)?.current_version_id ?? '')} options={(routes.data?.items ?? []).filter((item) => item.active).map((item) => ({ value: item.id, label: item.name }))} />
          <Button onClick={() => void addProductRoute()}>从商品工序中添加</Button>
          <Button onClick={() => { if (!draftKeys.length) { command.setError('请先勾选要修改的工序'); return; } setBatchDraft(emptyBatch); setBatchOpen(true); }}>批量修改</Button>
          <Button onClick={() => setTaskColumnsOpen(true)}>列配置</Button>
          <Button onClick={() => { setManual(true); setDrafts([]); setDraftKeys([]); }}>清空</Button>
        </div>
        <Table size="small" pagination={false} rowKey="key" scroll={{ x: 'max-content' }} dataSource={drafts} rowSelection={{ selectedRowKeys: draftKeys, onChange: (keys) => setDraftKeys(keys.map(String)) }} columns={arrangeTasks([
          { title: '工序', dataIndex: 'name' }, { title: '工序编号', dataIndex: 'code' },
          { title: '计划开始', render: (_, row) => <DayField value={row.planned_start} onChange={(value) => setDrafts((current) => current.map((item) => item.key === row.key ? { ...item, planned_start: value } : item))} /> },
          { title: '计划结束', render: (_, row) => <DayField value={row.planned_end} onChange={(value) => setDrafts((current) => current.map((item) => item.key === row.key ? { ...item, planned_end: value } : item))} /> },
          { title: '车间', render: () => '' }, { title: '产线', render: () => '' },
          { title: '计价方式', render: (_, row) => <Select value={row.pricing_mode} style={{ width: 88 }} onChange={(value) => setDrafts((current) => current.map((item) => item.key === row.key ? { ...item, pricing_mode: value } : item))} options={[{ value: 'piece', label: '计件' }, { value: 'time', label: '计时' }]} /> },
          { title: '工资单价', render: (_, row) => <Input value={row.wage_rate} onChange={(event) => setDrafts((current) => current.map((item) => item.key === row.key ? { ...item, wage_rate: event.target.value } : item))} /> },
          { title: '标准工时', dataIndex: 'standard_minutes' }, { title: '机台', render: () => '' }, { title: '生产人员', dataIndex: 'reporters' },
          { title: '生产派工', render: (_, row) => <Select mode="multiple" style={{ minWidth: 140 }} placeholder="生产人员中选择" value={row.dispatch} onChange={(value) => setDrafts((current) => current.map((item) => item.key === row.key ? { ...item, dispatch: value } : item))} options={reporterOptions(row.reporter_ids)} /> }, { title: '质检派工', render: () => '' }, { title: '质检人员', render: () => '' }, { title: '不良品项', render: () => '' }, { title: '报工单位', render: () => '' },
          { title: '生产数量', render: (_, row) => plan ? mulCeilText(plan, row.unit_ratio || '1') : '' },
          { title: '单位关系', render: (_, row) => <Input value={row.unit_ratio} onChange={(event) => setDrafts((current) => current.map((item) => item.key === row.key ? { ...item, unit_ratio: event.target.value } : item))} /> },
          { title: '任务生产计时', render: () => '' }, { title: '检验方案', dataIndex: 'inspection' },
          { title: '需返工/报废', render: () => '' }, { title: '需外协', render: () => '' }, { title: '物料清单', render: () => '' },
          { title: '报工附加组件', render: () => '' }, { title: '质检附加组件', render: () => '' }, { title: '附件', render: () => '' }, { title: '备注', render: () => '' },
          { title: '操作', render: (_, row) => <Button type="link" onClick={() => { setManual(true); setDrafts((current) => current.filter((item) => item.key !== row.key)); }}>删除</Button> },
        ])} />
      </> },
      { key: 'materials', label: '用料清单', children: <Table size="small" pagination={false} rowKey="product_id" dataSource={explosion.data?.requirements ?? []} columns={[
        { title: '商品名', dataIndex: 'name' }, { title: '编号', dataIndex: 'code' }, { title: '单位', dataIndex: 'unit_name' }, { title: '生产用量', dataIndex: 'quantity', render: (value: string) => qtyText(value) },
        { title: '规格', render: () => '' }, { title: '备注', render: () => '' },
      ]} /> },
      { key: 'children', label: '子加工单', children: <>
        <div className="kgd-toolbar">
          <span>只看自产 <Switch checked={selfOnly} onChange={setSelfOnly} /></span>
          <span className="kgd-muted">{bom ? '勾选的物料会在保存加工单时一并创建为子加工单' : '请先在基本信息中选择 BOM 并填写计划数'}</span>
        </div>
        <Table size="small" pagination={false} rowKey="product_id" dataSource={childRows} rowSelection={{ selectedRowKeys: childKeys, onChange: (keys) => setChildKeys(keys.map(String)) }} locale={{ emptyText: '暂无可创建子单的物料' }} columns={[
          { title: '物料名称', dataIndex: 'name' }, { title: '物料编号', dataIndex: 'code' }, { title: '物料来源', dataIndex: 'source' },
          { title: '计划数', dataIndex: 'quantity', render: (value: string) => qtyText(value) }, { title: '库存', dataIndex: 'stock' },
          { title: 'BOM', render: (_, row) => row.bom ? `${row.bom.parent_name} r${row.bom.current_revision}` : '无' }, { title: '单位', dataIndex: 'unit_name' },
        ]} />
      </> },
    ]} />
    <div className="kgd-actions"><Button onClick={() => navigate('/inside_produce_bill/list')}>取 消</Button><Button type="primary" loading={command.busy} onClick={() => void save()}>创建加工单</Button></div>
    <Modal title="选择合同订单" open={!direct && picking} onCancel={() => navigate('/inside_produce_bill/list')} footer={null} width={720}>
      <div className="kgd-toolbar" style={{ marginBottom: 8 }}>
        <Input allowClear placeholder="合同编号/商品" value={contractKeyword} onChange={(event) => setContractKeyword(event.target.value)} style={{ width: 260 }} />
      </div>
      <Table size="small" rowKey="id" pagination={false} dataSource={choices} columns={[
        { title: '合同编号', render: (_, row) => row.order.code }, { title: '商品', dataIndex: 'product_name' }, { title: '未投产', render: (_, row) => subQty(row.quantity, row.scheduled_qty) },
        { title: '操作', render: (_, row) => {
          const remain = cmpQty(row.quantity, row.scheduled_qty) > 0;
          return <Button type="link" disabled={!remain} onClick={() => { setLineId(row.id); setPlan(subQty(row.quantity, row.scheduled_qty)); setPicking(false); setManual(false); }}>{remain ? '选择' : '已投满'}</Button>;
        } },
      ]} locale={{ emptyText: needle ? '没有匹配的已审核合同行' : '没有未投产的已审核合同行' }} />
    </Modal>
    <ColumnConfigModal open={taskColumnsOpen} columns={taskTitles.current.filter((title) => title !== '操作').map((title) => ({ key: title, label: title }))}
      value={taskPrefs ?? { order: taskTitles.current, visible: taskTitles.current, locked: [] }} onCancel={() => setTaskColumnsOpen(false)}
      onOk={(next) => { setTaskPrefs(next); saveJson(taskColumnKey, next); setTaskColumnsOpen(false); }} />
    <Modal title="批量修改" open={batchOpen} onCancel={() => setBatchOpen(false)} onOk={applyBatch} okText="确定" cancelText="取消">
      <p className="kgd-muted">已勾选 {draftKeys.length} 道工序，留空的项不修改。</p>
      <div className="kgd-form">
        <span>计价方式</span><Select allowClear value={batchDraft.pricing_mode || undefined} placeholder="不修改" onChange={(value) => setBatchDraft({ ...batchDraft, pricing_mode: value ?? '' })} options={[{ value: 'piece', label: '计件' }, { value: 'time', label: '计时' }]} />
        <span>工资单价</span><Input value={batchDraft.wage_rate} placeholder="不修改" onChange={(event) => setBatchDraft({ ...batchDraft, wage_rate: event.target.value })} />
        <span>单位关系</span><Input value={batchDraft.unit_ratio} placeholder="不修改" onChange={(event) => setBatchDraft({ ...batchDraft, unit_ratio: event.target.value })} />
        <span>计划开始</span><DayField value={batchDraft.planned_start} onChange={(value) => setBatchDraft({ ...batchDraft, planned_start: value })} />
        <span>计划结束</span><DayField value={batchDraft.planned_end} onChange={(value) => setBatchDraft({ ...batchDraft, planned_end: value })} />
        <span>生产派工</span><Select mode="multiple" placeholder="不修改" value={batchDraft.dispatch} onChange={(value) => setBatchDraft({ ...batchDraft, dispatch: value })} options={reporterOptions(batchReporters)} />
      </div>
    </Modal>
    <Modal title="从工序中添加" open={pickOpen} onCancel={() => setPickOpen(false)} onOk={(event) => { event.stopPropagation(); appendProcesses(picked); setPickOpen(false); }} okText="确定" cancelText="取消" width={640}>
      <Table size="small" rowKey={(row) => idText(row.id)} pagination={false} dataSource={(processes.data?.items ?? []).filter((item) => item.active)} rowSelection={{ preserveSelectedRowKeys: true, selectedRowKeys: picked, onChange: (keys) => setPicked(keys.map((key) => String(key))) }} columns={[{ title: '工序', dataIndex: 'name' }, { title: '工序编号', dataIndex: 'code' }, { title: '计价方式', render: (_, row) => modeText(row.pricing_mode) }, { title: '工资单价', render: (_, row) => rateLabel(row.wage_rate) }]} />
    </Modal>
  </div>;
}

export function WorkOrderDetail() {
  const { pathname } = useLocation();
  const id = pathname.split('/detail/')[1]?.split(/[/?]/)[0] ?? '';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { revision, onExpired, session } = useKgd();
  const command = useCommand();
  const ext = useEntityExtensions('work_order', id || null);
  const remote = useRemote<{ work_order: WorkOrder }>(`/api/work-orders/${id}`, revision, onExpired);
  const sales = useRemote<{ items: Sales[] }>('/api/sales-orders', revision, onExpired);
  const stock = useRemote<{ items: Balance[] }>('/api/stock/balances', revision, onExpired);
  const members = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', revision, onExpired);
  const reports = useRemote<{ items: ReportRow[] }>(`/api/production-reports?work_order_id=${id}`, revision, onExpired);
  const rework = useRemote<{ items: { id: string; code: string; work_order_id: string; good_qty: string; approval: string }[] }>('/api/rework-reports', revision, onExpired);
  const audit = useRemote<{ items: { id: string; action: string; entity_id: string | null; created_at: string; actor_name: string | null }[] }>('/api/audit-events', revision, onExpired);
  const order = remote.data?.work_order;
  const sale = order?.sales_order_id ? sales.data?.items.find((item) => item.id === order.sales_order_id) : undefined;
  const [reportTask, setReportTask] = useState<Task | null>(null);
  const [pricing, setPricing] = useState<Task | null>(null);
  const [mode, setMode] = useState('piece');
  const [rate, setRate] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const [planDraft, setPlanDraft] = useState({ planned_start: '', planned_end: '', due_date: '', priority: 'none', note: '' });
  const tree = useRemote<{ tree: TreeNode }>(id ? `/api/work-order-links/${id}/tree` : null, revision, onExpired);
  const projects = useRemote<{ items: { id: string; code: string; name: string }[] }>('/api/production-projects?page=1&page_size=200', revision, onExpired);
  const [shareOpen, setShareOpen] = useState(false);
  const [pick, setPick] = useState<{ mode: 'parent' | 'children' } | null>(null);
  const self = tree.data ? findNode(tree.data.tree, id) : undefined;
  const project = self?.project_id ? projects.data?.items.find((item) => item.id === self.project_id) : undefined;
  async function act(action: string, reason = '') {
    if (!order) return;
    try { await command.send(`/api/work-orders/${order.id}/actions`, documentActionPayload(action, order.version, reason)); }
    catch (failure) { command.setError(showError(failure)); }
  }
  async function taskAct(task: Task, action: string) {
    if (!order) return;
    try { await command.send(`/api/work-orders/${order.id}/tasks/${task.id}/actions`, taskActionPayload(action, task.version)); }
    catch (failure) { command.setError(showError(failure)); }
  }
  async function savePrice() {
    if (!order || !pricing) return;
    try {
      await command.send(`/api/work-orders/${order.id}/tasks/${pricing.id}`, taskPricePayload(pricing.version, mode, rate), 'PATCH');
      setPricing(null);
    } catch (failure) { command.setError(showError(failure)); }
  }
  function removeOrder() {
    if (!order) return;
    Modal.confirm({
      title: '确定删除该加工单吗？', content: '只有未开始、没有报工/领料/入库记录的加工单可以删除，删除后不可恢复。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try { await command.send(`/api/work-orders/${order.id}`, { version: order.version }, 'DELETE'); navigate('/inside_produce_bill/list'); }
        catch (failure) { command.setError(showError(failure)); }
      },
    });
  }
  async function savePick(ids: string[]) {
    if (!pick || !ids.length) return;
    try {
      await command.send(`/api/work-order-links/${id}`, pick.mode === 'parent' ? { parent_id: ids[0] } : { child_ids: ids }, 'PUT');
      setPick(null);
    } catch (failure) { command.setError(showError(failure)); }
  }
  if (!order && remote.loading) return <div className="kgd-card">正在读取数据…</div>;
  if (!order) return <div className="kgd-card">{remote.error || '加工单不存在'}</div>;
  const wo = order;
  const processDone = wo.tasks.filter((task) => task.execution === 'completed').length;
  const done = wo.execution === 'completed' || wo.execution === 'cancelled';
  const locked = done || wo.order_paused;
  const nameOf = (userId: string) => members.data?.items.find((item) => String(item.id) === userId)?.display_name ?? '';
  const sheet = (reports.data?.items ?? []).filter((item) => item.work_order_id === wo.id && item.approval !== 'reversed');
  const personTotal = (userId: string) => sumYuan(sheet.filter((item) => item.operator_id === userId).map((item) => item.estimated_wage));
  const none = (value: unknown) => {
    const text = String(value ?? '').trim();
    return text && text !== '0' ? text : '无';
  };
  const fields: [string, ReactNode][] = [
    ['加工单二维码', <AsyncQr key={wo.code} make={() => workOrderMobileUrl(wo.code, session.tenant.slug)} size={160} />],
    ['商品图片', '无'], ['商品编号', none(wo.product_snapshot.code)], ['商品', none(wo.product_snapshot.name)], ['商品规格', none(wo.product_snapshot.specification)], ['商品类别', '无'],
    ['BOM', wo.bom_revision == null ? '无' : `BOM 版本 r${wo.bom_revision}`],
    ['生产计划编号', wo.production_plan_code ? <button className="kgd-link" onClick={() => navigate(`/ProductionPlan/detail/${wo.production_plan_id}`)}>{wo.production_plan_code}</button> : '无'],
    ['生产计划名称', wo.production_plan_name ? <button className="kgd-link" onClick={() => navigate(`/ProductionPlan/detail/${wo.production_plan_id}`)}>{wo.production_plan_name}</button> : '无'],
    ['项目编号', project ? <button className="kgd-link" onClick={() => navigate(`/production_project/detail/${project.id}`)}>{project.code}</button> : '无'], ['项目名称', none(project?.name)],
    ['计划数', qtyText(wo.plan_qty)], ['库存', none(sumQty((stock.data?.items ?? []).filter((item) => item.product_id === wo.product_id).map((item) => item.on_hand)))],
    ['实际生产数', qtyText(wo.output_qty) === '0' ? '无' : qtyText(wo.output_qty)], ['状态', execText[wo.execution] ?? wo.execution], ['交货日期', (wo.due_date || sale?.promised_date || '').slice(0, 10) || '无'], ['优先级', priorityText(wo.priority)],
    ['当前工序', currentTask(wo)?.process_name || '无'], ['工序进度', <ProgressCell variant="circle" done={processDone} total={wo.tasks?.length ?? 0} />],
    ['任务进度', <ProgressCell done={sumQty(wo.tasks.map((task) => task.approved_good))} total={sumQty(wo.tasks.map((task) => task.plan_qty))} />],
    ['生产出库', <>{none(sumQty(wo.materials.map((item) => item.issued_qty)))} <button className="kgd-link" onClick={() => navigate(`/production_out_of_storage/list?work_order_id=${wo.id}`)}>出库</button></>],
    ['成品入库', <>{none(qtyText(wo.received_qty))} <button className="kgd-link" onClick={() => navigate(`/produce_stock_in_bill/list?work_order_id=${wo.id}&add=1`)}>入库</button></>],
    ['半成品入库', <>无 <button className="kgd-link" onClick={() => navigate(`/produce_put_storage_semi/list?work_order_id=${wo.id}`)}>入库</button></>],
    ['生产退料', <>无 <button className="kgd-link" onClick={() => navigate(`/produce_return_materiel/list?work_order_id=${wo.id}`)}>退料</button></>],
    ['备注', wo.note?.trim() ? wo.note : '无'], ['图纸', '无'],
    ['计划开始', wo.planned_start?.slice(0, 10) || '无'], ['计划结束', wo.planned_end?.slice(0, 10) || '无'], ['领料状态', issueStatus(wo.materials) || '无'], ['入库进度', <ProgressCell done={wo.received_qty} total={wo.plan_qty} />],
    ['创建人', '无'], ['创建时间', beijingTime(wo.created_at, '无')],
    ...ext.fields.map((field): [string, ReactNode] => {
      const raw = ext.values[field.id];
      const text = Array.isArray(raw) ? raw.join('、') : String(raw ?? '').trim();
      return [field.name, text || '无'];
    }),
  ];
  async function savePlanFields() {
    try {
      await command.send(`/api/work-orders/${wo.id}/plan-fields`, {
        version: wo.version,
        planned_start: planDraft.planned_start || null,
        planned_end: planDraft.planned_end || null,
        due_date: planDraft.due_date || null,
        priority: planDraft.priority,
        note: planDraft.note,
      }, 'PATCH');
      setPlanOpen(false);
    } catch (failure) { command.setError(showError(failure)); }
  }
  return <div className="kgd-card">
    <h2 className="kgd-detail-title">加工单({wo.code})</h2>
    <div className="kgd-actions">
      <Button onClick={() => navigate('/inside_produce_bill/list')}>返回</Button>
      <Button onClick={() => { setPlanDraft({ planned_start: wo.planned_start?.slice(0, 10) ?? '', planned_end: wo.planned_end?.slice(0, 10) ?? '', due_date: (wo.due_date || sale?.promised_date || '').slice(0, 10), priority: wo.priority || 'none', note: wo.note ?? '' }); setPlanOpen(true); }}>修改</Button>
      <Button onClick={() => navigate(wo.sales_line_id ? '/inside_produce_bill/add' : '/inside_produce_bill/add?mode=direct', { state: { sales_line_id: wo.sales_line_id ?? undefined, quantity: wo.plan_qty, warehouse_id: wo.warehouse_id } })}>复制</Button>
      <Button disabled={command.busy || wo.execution !== 'not_started'} onClick={removeOrder}>删除</Button>
      <Button onClick={() => setShareOpen(true)}>分享加工单进度</Button>
      <Button disabled={done} onClick={() => navigate(`/inside_produce_bill/split/${order.id}`)}>拆单</Button>
      <Button onClick={() => setPick({ mode: 'parent' })}>选父单</Button>
      <Button onClick={() => setPick({ mode: 'children' })}>选子单</Button>
      {wo.execution === 'not_started' && <>
        <Button disabled={command.busy} onClick={() => void act('start')}>开始</Button>
        <Button disabled={command.busy} onClick={() => void act('complete')}>完成</Button>
        <Button disabled={command.busy} onClick={() => askReason('取消加工单必须填写原因', (reason) => void act('cancel', reason))}>取消</Button>
      </>}
      {wo.execution === 'running' && <>
        <Button disabled={command.busy} onClick={() => void act('withdraw')}>撤回</Button>
        <Button disabled={command.busy} onClick={() => void act('complete')}>完成</Button>
        <Button disabled={command.busy} onClick={() => askReason('取消加工单必须填写原因', (reason) => void act('cancel', reason))}>取消</Button>
        <Button disabled={command.busy} onClick={() => askReason('暂停必须填写原因', (reason) => void act('pause', reason))}>暂停</Button>
      </>}
      {wo.execution === 'completed' && <>
        <Button disabled={command.busy} onClick={() => void act('withdraw')}>撤回</Button>
        <Button disabled={command.busy} onClick={() => askReason('取消加工单必须填写原因', (reason) => void act('cancel', reason))}>取消</Button>
      </>}
      {wo.execution === 'paused' && <>
        <Button disabled={command.busy} onClick={() => askReason('取消加工单必须填写原因', (reason) => void act('cancel', reason))}>取消</Button>
        <Button disabled={command.busy} onClick={() => void act('resume')}>继续</Button>
      </>}
      <Button onClick={() => { if (!printDocs([workOrderDoc({ ...wo, project_name: project?.name })], '加工单')) command.setError('浏览器拦截了打印窗口，请允许弹出窗口后重试'); }}>打印加工单</Button>
    </div>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <ShareProgressModal open={shareOpen} code={wo.code} onClose={() => setShareOpen(false)} />
    <dl className="kgd-detail-grid">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <Tabs className="kgd-tabs" destroyOnHidden activeKey={params.get('tab') || 'flow'} onChange={(key) => setParams({ tab: key })} items={[
      { key: 'flow', label: '工序流程', children: <Table size="small" rowKey="id" pagination={false} scroll={{ x: 'max-content' }} dataSource={wo.tasks} columns={[
        { title: '排序', render: (_, __, index) => index + 1 },
        { title: '工序', dataIndex: 'process_name' }, { title: '工序编号', render: (_, task) => task.process_code || task.process_snapshot?.code || '-' },
        { title: '计划开始', render: (_, task) => <span>{task.planned_start?.slice(0, 10) || '-'} ✎</span> }, { title: '计划结束', render: (_, task) => <span>{task.planned_end?.slice(0, 10) || '-'} ✎</span> },
        { title: '生产进度', render: (_, task) => <ProgressCell done={task.approved_good} total={task.plan_qty} /> },
        { title: '状态', render: (_, task) => taskText[task.execution] ?? task.execution },
        { title: '暂停原因', render: (_, task) => task.pause_reason || '-' },
        { title: '车间', render: () => '-' }, { title: '产线', render: () => '-' },
        { title: '计价方式', render: (_, task) => modeText(task.pricing_mode) },
        { title: '工资单价', render: (_, task) => rateLabel(task.wage_rate, wo.product_snapshot.unit_name) },
        { title: '标准工时', render: (_, task) => task.process_snapshot?.standard_minutes || '-' },
        { title: '机台', render: () => '-' },
        { title: '开始时间', render: (_, task) => when(task.started_at) || '-' },
        { title: '结束时间', render: (_, task) => when(task.completed_at) || '-' },
        { title: '用时', render: (_, task) => usedText(task.started_at, task.completed_at) || '-' },
        { title: '生产人员', render: () => '-' }, { title: '生产派工', render: () => '-' }, { title: '质检人员', render: () => '-' }, { title: '质检派工', render: () => '-' },
        { title: '不良品项', render: () => '-' }, { title: '报工单位', render: () => '-' },
        { title: '生产数量', render: (_, task) => qtyText(task.plan_qty) },
        { title: '单位关系', dataIndex: 'unit_ratio', render: (value: string) => qtyText(value) },
        { title: '生产任务计时', render: () => '-' }, { title: '检验方案', render: (_, task) => inspectionText(task.inspection_scheme ?? 'none') },
        { title: '需返工 / 报废', render: () => '-' }, { title: '需外协', render: () => '-' }, { title: '物料清单', render: () => '-' }, { title: '附件', render: () => '-' },
        { title: '报工附加组件', render: () => '-' }, { title: '质检附加组件', render: () => '-' }, { title: '备注', render: () => '-' },
        { title: '操作', width: 220, render: (_, task) => <>
          {task.execution === 'not_started' && <Button type="link" disabled={locked || command.busy} onClick={() => void taskAct(task, 'start')}>开始工序</Button>}
          {task.execution === 'running' && <Button type="link" disabled={locked} onClick={() => setReportTask(task)}>报工</Button>}
          <Button type="link" onClick={() => navigate(`/production_out_of_storage/list?add=wo&work_order_id=${wo.id}`)}>出库</Button>
          <Dropdown menu={{ items: [
            { key: 'reset', label: '未开始', disabled: locked, onClick: () => void taskAct(task, 'reset') },
            { key: 'run', label: '进行中', disabled: locked, onClick: () => void taskAct(task, task.execution === 'paused' ? 'resume' : 'start') },
            { key: 'done', label: '已完成', disabled: locked, onClick: () => void taskAct(task, 'complete') },
            { key: 'pause', label: '暂停', disabled: locked, onClick: () => void taskAct(task, 'pause') },
            { key: 'edit', label: '修改', onClick: () => { setPricing(task); setMode(task.pricing_mode === 'time' ? 'time' : 'piece'); setRate(task.wage_rate ?? ''); } },
          ] }}><Button type="link">更多</Button></Dropdown>
        </> },
      ]} /> },
      { key: 'tree', label: '父子单', children: <Table<TreeNode> size="small" rowKey="id" pagination={false} loading={tree.loading} scroll={{ x: 'max-content' }} expandable={{ defaultExpandAllRows: true }} dataSource={tree.data ? [pruneTree(tree.data.tree)] : []} rowClassName={(row) => row.current ? 'kgd-row-current' : ''} locale={{ emptyText: tree.error || '暂无父子单' }} columns={[
        { title: '加工单号', render: (_, row) => row.current ? <b>{row.code}</b> : <button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.id}`)}>{row.code}</button> },
        { title: '商品', dataIndex: 'product_name' }, { title: 'BOM', render: () => '-' }, { title: '商品编号', render: () => '-' }, { title: '商品类别', render: () => '-' }, { title: '商品图片', render: () => '-' }, { title: '商品规格', render: () => '-' },
        { title: '计划数', dataIndex: 'plan_qty' }, { title: '库存', render: () => '-' }, { title: '实际生产数', render: () => '-' },
        { title: '状态', dataIndex: 'execution_text' }, { title: '领料状态', render: () => '-' }, { title: '交货日期', render: () => '-' }, { title: '交货倒计时', render: () => '-' }, { title: '优先级', render: () => '-' },
        { title: '当前工序', render: () => '-' }, { title: '工序进度', dataIndex: 'process_progress' }, { title: '工序进度详情', render: () => '-' }, { title: '加工单总工时', render: () => '-' }, { title: '任务进度', render: () => '-' }, { title: '工序流程', render: () => '-' },
        { title: '图纸', render: () => '-' }, { title: '计划开始', render: () => '-' }, { title: '计划结束', render: () => '-' }, { title: '开始时间', render: () => '-' }, { title: '完成时间', render: () => '-' },
        { title: '暂停原因', render: () => '-' }, { title: '取消原因', render: () => '-' }, { title: '生产出库', render: () => '-' }, { title: '成品入库', render: () => '-' }, { title: '半成品入库', render: () => '-' }, { title: '生产退料', render: () => '-' },
        { title: '备注', render: () => '-' }, { title: '入库进度', render: () => '-' }, { title: '创建人', render: () => '-' }, { title: '创建时间', render: () => '-' },
        { title: '操作', render: (_, row) => row.current ? '-' : <><button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.id}`)}>查看</button><button className="kgd-link" onClick={() => void command.send(`/api/work-order-links/${id}`, { parent_id: null }, 'PUT')}>解除关联</button></> },
      ]} /> },
      { key: 'wages', label: '工资单', children: <>
        <div className="kgd-toolbar">
          <Button onClick={() => downloadCsv(`${wo.code}-工资单.csv`, ['报工人', '工序', '单价', '良品数', '不良品数', '报工数', '工资(元)', '报工时间', '报工备注', '小计'], sheet.map((row) => [nameOf(row.operator_id), wo.tasks.find((task) => task.id === row.task_id)?.process_name ?? '', rateLabel(row.wage_snapshot?.rate), qtyText(row.good_qty), qtyText(row.defect_qty), sumQty([row.good_qty, row.defect_qty]), row.estimated_wage ?? '', when(row.created_at), row.note ?? '', personTotal(row.operator_id)]))}>导出</Button>
          <PrintTemplateButton objectKey="wage_slip" label="管理工资单打印模板" />
          <Button onClick={() => { if (!printDocs([{
            title: '工资单',
            fields: [['加工单号', wo.code], ['商品名称', wo.product_snapshot.name ?? ''], ['计划数', qtyText(wo.plan_qty)]],
            columns: ['报工人', '工序', '单价', '良品数', '不良品数', '报工数', '工资(元)', '报工时间', '报工备注'],
            rows: sheet.map((row) => [nameOf(row.operator_id), wo.tasks.find((task) => task.id === row.task_id)?.process_name ?? '', rateLabel(row.wage_snapshot?.rate, wo.product_snapshot.unit_name), qtyText(row.good_qty), qtyText(row.defect_qty), sumQty([row.good_qty, row.defect_qty]), row.estimated_wage ?? '', when(row.created_at), row.note ?? '']),
            footer: [['工资合计(元)', sumYuan(sheet.map((row) => row.estimated_wage))]],
          }], '工资单')) command.setError('浏览器拦截了打印窗口，请允许弹出窗口后重试'); }}>打印工资单</Button>
        </div>
        <Table size="small" rowKey="id" pagination={false} dataSource={sheet} summary={() => <Table.Summary.Row><Table.Summary.Cell index={0} colSpan={6}>合计</Table.Summary.Cell><Table.Summary.Cell index={6}>{sumYuan(sheet.map((row) => row.estimated_wage))}</Table.Summary.Cell><Table.Summary.Cell index={7} colSpan={3} /></Table.Summary.Row>} columns={[
          { title: '报工人', render: (_, row) => nameOf(row.operator_id) },
          { title: '工序', render: (_, row) => wo.tasks.find((task) => task.id === row.task_id)?.process_name ?? '' },
          { title: '单价', render: (_, row) => rateLabel(row.wage_snapshot?.rate, wo.product_snapshot.unit_name) },
          { title: '良品数', render: (_, row) => qtyText(row.good_qty) },
          { title: '不良品数', render: (_, row) => qtyText(row.defect_qty) },
          { title: '报工数', render: (_, row) => sumQty([row.good_qty, row.defect_qty]) },
          { title: '工资(元)', render: (_, row) => yuanLabel(row.estimated_wage).replace('元', '') || row.estimated_wage || '' },
          { title: '报工时间', render: (_, row) => when(row.created_at) },
          { title: '报工备注', render: (_, row) => row.note ?? '' },
          { title: '小计', render: (_, row) => personTotal(row.operator_id) },
        ]} />
      </> },
      { key: 'reports', label: '报工记录', children: <Table size="small" rowKey="id" pagination={{ pageSize: 30, showTotal: (n) => `共${n}条数据` }} scroll={{ x: 'max-content' }} dataSource={sheet} columns={[
        { title: '商品名', render: () => wo.product_snapshot.name ?? '-' }, { title: '商品编号', render: () => wo.product_snapshot.code ?? '-' }, { title: '商品规格', render: () => wo.product_snapshot.specification ?? '-' },
        { title: '工序计划开始', render: () => '-' }, { title: '工序计划结束', render: () => '-' },
        { title: '工序名', render: (_, row) => wo.tasks.find((task) => task.id === row.task_id)?.process_name ?? '-' },
        { title: '车间', render: () => '-' }, { title: '产线', render: () => '-' }, { title: '计价方式', render: (_, row) => modeText(row.wage_snapshot?.mode) },
        { title: '结算状态', render: (_, row) => settlementText(row.settlement_status) }, { title: '结算人', render: () => '-' }, { title: '结算时间', render: () => '-' }, { title: '报工附加组件', render: () => '-' },
        { title: '加工单号', render: () => wo.code }, { title: '加工单状态', render: () => execText[wo.execution] ?? wo.execution },
        { title: '溯源码编号', render: () => '-' }, { title: '溯源码数量', render: () => '-' }, { title: '报工类型', render: () => '-' }, { title: '机台', render: () => '-' },
        { title: '工资单价', render: (_, row) => rateLabel(row.wage_snapshot?.rate) }, { title: '报工生产人员', render: (_, row) => nameOf(row.operator_id) },
        { title: '报工数量', render: (_, row) => sumQty([row.good_qty, row.defect_qty]) }, { title: '良品数', render: (_, row) => qtyText(row.good_qty) },
        { title: '标准效率', render: () => '-' }, { title: '实际效率', render: () => '-' }, { title: '达标率', render: () => '-' },
        { title: '不良品数', render: (_, row) => qtyText(row.defect_qty) }, { title: '不良品项', render: () => '-' }, { title: '不良品项数', render: () => '-' }, { title: '报工单位', render: () => '-' },
        { title: '工资(元)', render: (_, row) => row.estimated_wage ?? '-' }, { title: '报工开始时间', render: () => '-' }, { title: '报工结束时间', render: () => '-' }, { title: '报工时长', render: () => '-' },
        { title: '报工备注', render: (_, row) => row.note ?? '-' }, { title: '附件', render: () => '-' }, { title: '报工质检人', render: () => '-' }, { title: '报工人', render: (_, row) => nameOf(row.operator_id) },
        { title: '返工数', render: () => '-' }, { title: '报废数', render: () => '-' }, { title: '返工任务', render: () => '-' },
        { title: '质检状态', render: (_, row) => qualityText(row.quality_status) }, { title: '质检时间', render: () => '-' }, { title: '质检附加组件', render: () => '-' }, { title: '质检备注', render: () => '-' },
        { title: '报工时间', render: (_, row) => when(row.created_at) }, { title: '操作', render: () => '-' },
      ]} /> },
      { key: 'rework', label: '返工任务', children: <Table size="small" rowKey="id" pagination={false} rowSelection={{}} scroll={{ x: 'max-content' }} dataSource={(rework.data?.items ?? []).filter((item) => item.work_order_id === wo.id)} columns={[
        { title: '工序', render: () => '-' }, { title: '商品名', render: () => wo.product_snapshot.name ?? '-' }, { title: '商品编号', render: () => wo.product_snapshot.code ?? '-' }, { title: '商品规格', render: () => wo.product_snapshot.specification ?? '-' }, { title: '商品类别', render: () => '-' },
        { title: '加工单', render: () => wo.code }, { title: '任务类型', render: () => '返工' }, { title: '工序编号', render: () => '-' }, { title: '工序计划开始', render: () => '-' }, { title: '工序计划结束', render: () => '-' },
        { title: '生产数量', dataIndex: 'good_qty' }, { title: '生产进度', render: () => '-' }, { title: '验收进度', render: () => '-' }, { title: '外协验收', render: () => '-' },
        { title: '任务状态', render: (_, row) => ({ pending: '待审核', approved: '已通过', rejected: '已驳回' } as Record<string, string>)[row.approval] ?? '无' },
        { title: '任务暂停原因', render: () => '-' }, { title: '车间', render: () => '-' }, { title: '产线', render: () => '-' }, { title: '计价方式', render: () => '-' }, { title: '工资单价', render: () => '-' },
        { title: '标准工时', render: () => '-' }, { title: '标准总工时', render: () => '-' }, { title: '任务开始时间', render: () => '-' }, { title: '任务结束时间', render: () => '-' }, { title: '用时', render: () => '-' },
        { title: '机台', render: () => '-' }, { title: '生产人员', render: () => '-' }, { title: '生产派工', render: () => '-' }, { title: '质检人员', render: () => '-' }, { title: '质检派工', render: () => '-' },
        { title: '不良品项', render: () => '-' }, { title: '报工单位', render: () => '-' }, { title: '报工附加组件', render: () => '-' }, { title: '质检附加组件', render: () => '-' }, { title: '单位关系', render: () => '-' },
        { title: '生产任务计时', render: () => '-' }, { title: '检验方案', render: () => '-' }, { title: '物料清单', render: () => '-' }, { title: '任务附件', render: () => '-' }, { title: '任务备注', render: () => '-' },
        { title: '供应商', render: () => '-' }, { title: '联系人', render: () => '-' }, { title: '地址', render: () => '-' }, { title: '操作', render: () => '-' },
      ]} /> },
      { key: 'materials', label: '用料清单', children: <Table size="small" rowKey="id" pagination={false} scroll={{ x: 'max-content' }} dataSource={wo.materials} columns={[
        { title: '序号', render: (_, __, index) => index + 1 }, { title: '商品名', dataIndex: 'product_name' }, { title: '编号', dataIndex: 'product_code' }, { title: '规格', render: () => '-' },
        { title: '商品来源', render: () => '-' }, { title: '投料工序', render: () => '-' }, { title: '入库工序', render: () => '-' }, { title: '图片', render: () => '-' },
        { title: '单位用量', render: () => '-' }, { title: '成本单价(元)', render: () => '-' }, { title: '成本金额(元)', render: () => '-' }, { title: '单位', dataIndex: 'unit_name' },
        { title: '引用BOM', render: () => '-' }, { title: '备注', render: () => '-' }, { title: '生产用量', dataIndex: 'required_qty', render: (value: string) => qtyText(value) },
        { title: '领料数量', dataIndex: 'issued_qty', render: (value: string) => qtyText(value) }, { title: '退料数量', render: () => '-' }, { title: '操作', render: () => '-' },
      ]} /> },
      { key: 'log', label: '日志', children: (() => {
        const rows = (audit.data?.items ?? []).filter((item) => item.entity_id === wo.id || wo.tasks.some((task) => task.id === item.entity_id));
        return <div>
          {rows.map((row) => <div key={row.id} className="kgd-log-line">{beijingTime(row.created_at)} {row.actor_name} {row.action}</div>)}
          <div className="kgd-foot">共{rows.length}条数据 30 条/页</div>
        </div>;
      })() },
    ]} />
    <ReportDialog open={!!reportTask} target={reportTask ? { taskId: reportTask.id, processName: reportTask.process_name, pricingMode: reportTask.pricing_mode ?? 'piece', wageRate: reportTask.wage_rate ?? null, planQty: reportTask.plan_qty, workOrderCode: wo.code } : null} onClose={() => setReportTask(null)} />
    <Modal title="修改" open={!!pricing} onCancel={() => setPricing(null)} onOk={() => void savePrice()} confirmLoading={command.busy} okText="确定" cancelText="取消">
      <div className="kgd-form"><span>计价方式</span><Select value={mode} onChange={setMode} options={[{ value: 'piece', label: '计件' }, { value: 'time', label: '计时' }]} /><span>工资单价</span><Input value={rate} onChange={(event) => setRate(event.target.value)} /></div>
    </Modal>
    <Modal title="修改" open={planOpen} onCancel={() => setPlanOpen(false)} onOk={() => void savePlanFields()} confirmLoading={command.busy} okText="确定" cancelText="取消">
      <div className="kgd-form">
        <span>计划开始</span><DayField value={planDraft.planned_start} onChange={(value) => setPlanDraft({ ...planDraft, planned_start: value })} />
        <span>计划结束</span><DayField value={planDraft.planned_end} onChange={(value) => setPlanDraft({ ...planDraft, planned_end: value })} />
        <span>交货日期</span><DayField value={planDraft.due_date} onChange={(value) => setPlanDraft({ ...planDraft, due_date: value })} />
        <span>优先级</span><Select value={planDraft.priority} onChange={(value) => setPlanDraft({ ...planDraft, priority: value })} options={priorities} />
        <span>备注</span><Input value={planDraft.note} maxLength={255} onChange={(event) => setPlanDraft({ ...planDraft, note: event.target.value })} />
      </div>
    </Modal>
    <WorkOrderPickModal open={!!pick} mode={pick?.mode ?? 'parent'} currentId={id} onClose={() => setPick(null)} onOk={(ids) => void savePick(ids)} />
  </div>;
}

type TreeNode = { id: string; code: string; product_name: string; plan_qty: string; execution_text: string; process_progress: string; parent_id: string | null; project_id: string | null; current?: boolean; children?: TreeNode[] };

function findNode(node: TreeNode, id: string): TreeNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function pruneTree(node: TreeNode): TreeNode {
  const children = (node.children ?? []).map(pruneTree);
  return children.length ? { ...node, children } : { ...node, children: undefined };
}
