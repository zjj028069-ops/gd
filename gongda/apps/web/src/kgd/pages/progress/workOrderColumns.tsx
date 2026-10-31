import type { NavigateFunction } from 'react-router-dom';
import type { ListColumn } from '../../ListFrame';
import { countdown, StatusTag } from '../../kit';
import { qtyText } from '../../qty';
import { priorityText } from '../../wage';
import { ProgressCell } from './ProgressCell';
import { ProcessRings, type RingTask } from './ProcessRings';

export type ProgressWorkOrderRow = {
  id: string;
  code: string;
  plan_qty: string;
  output_qty: string;
  received_qty: string;
  execution: string;
  priority?: string;
  due_date?: string | null;
  planned_start?: string | null;
  planned_end?: string | null;
  product_snapshot: { name?: string; code?: string; specification?: string };
  production_plan_id?: string | null;
  production_plan_code?: string;
  production_plan_name?: string;
  process_progress?: { done: number; total: number } | null;
  task_progress?: { done: string; total: string } | null;
  inbound_progress?: { done: string; total: string } | null;
  ring_tasks?: RingTask[] | null;
  current_process?: string;
  issue_status?: string;
  stock_qty?: string;
  created_at?: string;
  version?: number;
  overdue?: boolean;
  order_paused?: boolean;
  schedule_no?: number;
  parent_id?: string | null;
  project_id?: string | null;
  contract_id?: string | null;
  contract_code?: string;
  project_code?: string;
  project_name?: string;
  pause_reason?: string;
  cancel_reason?: string;
  note?: string;
  creator_name?: string;
  hours_text?: string;
  issued_qty?: string;
  fg_qty?: string;
  semi_qty?: string;
  return_qty?: string;
  category_name?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

const execText: Record<string, string> = { not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };

export function workOrderListColumns({ navigate, compact }: { navigate: NavigateFunction; compact?: boolean }): ListColumn<ProgressWorkOrderRow>[] {
  const base: ListColumn<ProgressWorkOrderRow>[] = [
    { key: 'seq', title: '排单序号', render: (row) => row.schedule_no && row.schedule_no > 0 ? String(row.schedule_no) : '-' },
    { key: 'code', title: '加工单号', render: (row) => <button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.id}`)}>{row.code}</button> },
    { key: 'contract', title: '合同编号', render: (row) => row.contract_code?.trim() ? row.contract_code : '-' },
    { key: 'product', title: '商品', render: (row) => row.product_snapshot.name ?? '' },
    { key: 'plan', title: '计划数', render: (row) => qtyText(row.plan_qty) },
    { key: 'stock', title: '库存', render: (row) => row.stock_qty ?? '' },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={execText[row.execution] ?? row.execution} /> },
    { key: 'priority', title: '优先级', render: (row) => <span className="kgd-dot">● {priorityText(row.priority)}</span> },
    { key: 'progressDetail', title: '工序进度详情', render: (row) => <ProcessRings tasks={row.ring_tasks ?? []} workOrderCode={row.code} /> },
    { key: 'productCode', title: '商品编号', render: (row) => row.product_snapshot.code ?? '' },
    { key: 'spec', title: '商品规格', render: (row) => row.product_snapshot.specification ?? '' },
    { key: 'output', title: '实际生产数', render: (row) => qtyText(row.output_qty) },
    { key: 'issue', title: '领料状态', render: (row) => row.issue_status ?? '—' },
    { key: 'due', title: '交货日期', render: (row) => row.due_date?.slice(0, 10) ?? '' },
    { key: 'countdown', title: '交货倒计时', render: (row) => countdown(row.due_date) },
    { key: 'current', title: '当前工序', render: (row) => row.current_process ?? '' },
    { key: 'progress', title: '工序进度', render: (row) => <ProgressCell variant="circle" done={row.process_progress?.done} total={row.process_progress?.total} /> },
    { key: 'taskProgress', title: '任务进度', render: (row) => <ProgressCell variant="circle" done={row.task_progress?.done} total={row.task_progress?.total} /> },
    { key: 'inbound', title: '入库进度', render: (row) => <ProgressCell done={row.inbound_progress?.done} total={row.inbound_progress?.total} /> },
    { key: 'planCode', title: '生产计划编号', render: (row) => row.production_plan_code ? <button className="kgd-link" onClick={() => navigate(`/ProductionPlan/detail/${row.production_plan_id}`)}>{row.production_plan_code}</button> : '' },
    { key: 'planName', title: '生产计划名称', render: (row) => row.production_plan_name ?? '' },
    { key: 'planStart', title: '计划开始', render: (row) => row.planned_start?.slice(0, 10) ?? '' },
    { key: 'planEnd', title: '计划结束', render: (row) => row.planned_end?.slice(0, 10) ?? '' },
  ];
  if (compact) return base.filter((column) => !['seq', 'planCode', 'planName'].includes(column.key));
  return base;
}
