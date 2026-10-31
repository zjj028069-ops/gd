import type { CSSProperties, ReactNode } from 'react';
import { EChart } from '../../progress/echarts';
import { KpiBoard, PeopleCards, ScreenPanel, StatusLabel, hBarOption, pieOption } from '../../progress/screenChrome';
import '../../progress/progress.css';

export const layouts = ['默认', '四模块', '单模块', '左右双模块'] as const;
export const moduleKinds = ['生产模块', '设备维保模块', '仓库模块'] as const;

export const layoutSlots: Record<string, number> = { 默认: 6, 四模块: 4, 单模块: 1, 左右双模块: 2 };

export type ScreenDesign = {
  title?: string;
  slots?: string[] | { slot: number; module: string }[];
};

export const moduleLibrary: Record<string, { key: string; label: string }[]> = {
  生产模块: [
    { key: 'process_daily', label: '工序报工分析' },
    { key: 'employee_rank', label: '员工报工排行' },
    { key: 'cards', label: '指标卡' },
    { key: 'recent_reports', label: '实时报工数据' },
    { key: 'defect_analysis', label: '不良品分析' },
    { key: 'defect_items', label: '不良品项分布' },
    { key: 'work_orders', label: '工单执行进度' },
    { key: 'task_progress', label: '任务执行进度' },
    { key: 'employee_trend', label: '员工产能趋势' },
    { key: 'employee_defect', label: '人员不良品率' },
    { key: 'people_stats', label: '人员生产统计' },
    { key: 'machines', label: '机台状态详情' },
  ],
  设备维保模块: [
    { key: 'maint_completion', label: '维保任务完成率' },
    { key: 'repair_status', label: '维修工单状态分布' },
    { key: 'device_status', label: '设备状态分布' },
    { key: 'device_live', label: '设备实时状态表' },
  ],
  仓库模块: [
    { key: 'stock_warning', label: '库存预警' },
    { key: 'stock_trend', label: '近30天出入库趋势' },
    { key: 'warehouse_share', label: '仓库库存占比' },
  ],
};

export const allModules = Object.values(moduleLibrary).flat();

export function moduleLabel(key: string) {
  return allModules.find((item) => item.key === key)?.label ?? '未选择模块';
}

const defaults: Record<string, string[]> = {
  生产模块: ['process_daily', 'cards', 'employee_rank', 'recent_reports', 'defect_items', 'work_orders'],
  设备维保模块: ['maint_completion', 'device_status', 'repair_status', 'device_live', 'maint_completion', 'device_status'],
  仓库模块: ['stock_warning', 'stock_trend', 'warehouse_share', 'stock_warning', 'stock_trend', 'warehouse_share'],
};

export function defaultDesign(kind: string, layout: string, title = '数字化生产监控平台'): { title: string; slots: string[] } {
  const count = layoutSlots[layout] ?? 6;
  return { title, slots: (defaults[kind] ?? defaults['生产模块']!).slice(0, count) };
}

export function normalizeDesign(design: ScreenDesign | null | undefined, kind: string, layout: string, fallbackTitle: string): { title: string; slots: string[] } {
  const base = defaultDesign(kind, layout, fallbackTitle);
  const count = layoutSlots[layout] ?? 6;
  const slots = Array.from({ length: count }, (_, index) => base.slots[index] ?? '');
  const raw = design?.slots ?? [];
  const objectSlots = raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && 'module' in (raw[0] as object);
  if (objectSlots) {
    for (const entry of raw as { slot?: number; module?: string }[]) {
      const index = Number(entry.slot ?? 0) - 1;
      if (index >= 0 && index < count && entry.module) slots[index] = entry.module;
    }
  } else {
    (raw as string[]).forEach((entry, index) => {
      if (typeof entry === 'string' && entry && index < count) slots[index] = entry;
    });
  }
  return { title: design?.title?.trim() || base.title, slots };
}

type Payload = Record<string, unknown>;

function rowsOf(data: Payload, key: string) {
  return (data[key] ?? []) as Record<string, any>[];
}

function Table({ columns, rows }: { columns: [string, string][]; rows: Record<string, any>[] }) {
  return <div className="kgd-screen-scroll">
    <table className="kgd-screen-table">
      <thead><tr>{columns.map(([, title]) => <th key={title}>{title}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{columns.map(([key]) => <td key={key}>{row[key] ?? '-'}</td>)}</tr>) : <tr><td colSpan={columns.length} className="kgd-screen-empty">暂无数据</td></tr>}</tbody>
    </table>
  </div>;
}

function chart(option: object) {
  return <div className="kgd-screen-chart-host"><EChart theme="dark" className="kgd-screen-chart" style={{ minHeight: 0, height: '100%' }} option={option as never} /></div>;
}

export function ScreenModule({ moduleKey, data }: { moduleKey: string; data: Payload }): ReactNode {
  const cards = (data.cards ?? {}) as Record<string, string | number>;
  const key = moduleKey === 'process_report' ? 'process_daily'
    : moduleKey === 'metrics' ? 'cards'
    : moduleKey === 'maint_task_rate' ? 'maint_completion'
    : moduleKey === 'stock_alerts' ? 'stock_warning'
    : moduleKey;
  switch (key) {
    case 'process_daily': {
      const daily = rowsOf(data, 'process_daily');
      return chart({ backgroundColor: 'transparent', tooltip: {}, xAxis: { type: 'category', data: daily.map((row) => row.day) }, yAxis: { name: '报工数量', type: 'value' }, series: [{ type: 'line', areaStyle: {}, name: '报工数量', data: daily.map((row) => Number(row.qty)) }] });
    }
    case 'employee_rank': {
      const rank = rowsOf(data, 'employee_rank');
      return chart(hBarOption(rank.map((row) => ({ name: String(row.name ?? ''), value: Number(row.qty ?? 0) })), 'rank'));
    }
    case 'cards': {
      const list = [
        { label: '待生产工单数', value: String(cards.pending_orders ?? 0), tone: 'gold' },
        { label: '进行中工单数', value: String(cards.running_orders ?? 0), tone: 'cyan' },
        { label: '今日完成工单数', value: String(cards.completed_today ?? 0), tone: 'green' },
        { label: '今日报工数', value: String(cards.today_reports ?? 0), tone: 'plain' },
        { label: '今日不良品数', value: String(cards.today_defects ?? 0), tone: 'red' },
        { label: '今日不良品率', value: String(cards.today_defect_rate ?? 0), tone: 'red' },
        { label: '七天内待交货工单', value: String(cards.due_week ?? 0), tone: 'cyan' },
        { label: '逾期工单数', value: String(cards.overdue_orders ?? 0), tone: 'orange' },
        { label: '逾期任务数', value: String(cards.overdue_tasks ?? 0), tone: 'orange' },
      ];
      return <KpiBoard cards={list} />;
    }
    case 'recent_reports':
      return <Table columns={[['time', '时间'], ['operator_name', '报工人'], ['process_name', '工序'], ['product_name', '产品'], ['product_code', '编号'], ['good_qty', '良品数'], ['defect_qty', '不良品数']]} rows={rowsOf(data, 'recent_reports')} />;
    case 'defect_analysis': {
      const rows = rowsOf(data, 'defect_items');
      return chart({ backgroundColor: 'transparent', tooltip: {}, xAxis: { type: 'category', data: rows.map((row) => row.name) }, yAxis: { type: 'value', name: '不良品数' }, series: [{ type: 'bar', data: rows.map((row) => Number(row.qty ?? row.value ?? 0)) }] });
    }
    case 'defect_items':
      return chart(pieOption(rowsOf(data, 'defect_items').map((row) => ({ name: String(row.name ?? ''), value: Number(row.value ?? row.qty ?? 0) }))));
    case 'work_orders':
      return <Table columns={[['code', '工单编号'], ['product_name', '产品'], ['product_code', '产品编号'], ['plan_qty', '计划数'], ['progress', '工序进度']]} rows={rowsOf(data, 'work_orders').map((row) => {
        const snap = (row.product_snapshot ?? {}) as Record<string, string>;
        const tasks = (row.tasks ?? []) as Record<string, string>[];
        return { code: row.code, product_name: row.product_name ?? snap.name, product_code: row.product_code ?? snap.code, plan_qty: row.plan_qty, progress: tasks.map((task) => `${task.name}${task.good ?? 0}/${task.plan ?? 0}`).join(' → ') || '-' };
      })} />;
    case 'task_progress':
      return <Table columns={[['work_order_code', '工单编号'], ['process_name', '工序'], ['operator_name', '生产人员'], ['task_qty', '任务数'], ['good_qty', '良品数'], ['defect_qty', '不良品数'], ['pending_qty', '未完成数']]} rows={rowsOf(data, 'task_progress')} />;
    case 'employee_trend': {
      const rows = rowsOf(data, 'employee_trend');
      const days = [...new Set(rows.map((row) => String(row.day)))];
      const names = [...new Set(rows.map((row) => String(row.name)))];
      return chart({ backgroundColor: 'transparent', tooltip: { trigger: 'axis' }, legend: { top: 0, data: names }, xAxis: { type: 'category', data: days }, yAxis: { type: 'value' }, series: names.map((name) => ({ type: 'line', name, data: days.map((day) => Number(rows.find((row) => row.name === name && row.day === day)?.qty ?? 0)) })) });
    }
    case 'employee_defect':
      return chart(hBarOption(rowsOf(data, 'employee_defect').map((row) => ({ name: String(row.name ?? ''), value: Number(row.rate ?? 0) })), 'defect'));
    case 'people_stats':
      return <PeopleCards rows={rowsOf(data, 'people_stats').map((row) => ({ name: String(row.姓名 ?? row.name ?? ''), today: String(row.今日报工数 ?? row.today_qty ?? '0'), week: String(row.本周不良品数 ?? row.week_defect ?? '0'), month: String(row.本月不良品数 ?? row.month_defect ?? '0') }))} />;
    case 'machines':
      return <Table columns={[['code', '机台编号'], ['name', '机台名称'], ['specification', '机台规格'], ['status', '机台状态'], ['workshop', '车间'], ['good_qty', '良品数'], ['good_rate', '良品率(%)']]} rows={rowsOf(data, 'machines').map((row) => ({ ...row, status: <StatusLabel status={String(row.status ?? row.机台状态 ?? '')} />, specification: row.specification ?? row.机台规格 ?? '-', workshop: row.workshop ?? row.车间 ?? '-' }))} />;
    case 'maint_completion': {
      const rate = (data.maint_completion ?? data.maint_task_rate ?? {}) as { done?: number; total?: number; rate?: string };
      const done = Number(rate.done ?? 0);
      const total = Number(rate.total ?? 0);
      return <div>
        <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 700 }}>{rate.rate ?? (total ? `${Math.round((done * 100) / total)}%` : '0%')}<span style={{ fontSize: 13, opacity: 0.7, marginLeft: 8 }}>已完成 {done} / 共 {total}</span></div>
        {chart({ backgroundColor: 'transparent', tooltip: { trigger: 'item' }, series: [{ type: 'pie', radius: ['55%', '70%'], label: { show: false }, data: [{ name: '已完成', value: done }, { name: '未完成', value: Math.max(0, total - done) }] }] })}
      </div>;
    }
    case 'repair_status':
      return chart(pieOption(rowsOf(data, 'repair_status').map((row) => ({ name: String(row.name ?? ''), value: Number(row.value ?? 0) }))));
    case 'device_status':
      return chart(pieOption(rowsOf(data, 'device_status').map((row) => ({ name: String(row.name ?? ''), value: Number(row.value ?? 0) }))));
    case 'device_live':
      return <Table columns={[['name', '设备名称'], ['code', '设备编号'], ['category', '设备类别'], ['status', '设备状态'], ['location', '位置']]} rows={rowsOf(data, 'device_live')} />;
    case 'stock_warning':
      return <Table columns={[['name', '商品名'], ['code', '商品编号'], ['on_hand', '库存'], ['state', '状态']]} rows={rowsOf(data, 'stock_warning')} />;
    case 'stock_trend': {
      const rows = rowsOf(data, 'stock_trend');
      return chart({ backgroundColor: 'transparent', tooltip: { trigger: 'axis' }, legend: { data: ['入库', '出库'] }, xAxis: { type: 'category', data: rows.map((row) => row.day) }, yAxis: { type: 'value' }, series: [{ type: 'line', name: '入库', data: rows.map((row) => Number(row.inbound ?? row.in_qty ?? 0)) }, { type: 'line', name: '出库', data: rows.map((row) => Number(row.outbound ?? row.out_qty ?? 0)) }] });
    }
    case 'warehouse_share':
      return chart(pieOption(rowsOf(data, 'warehouse_share').map((row) => ({ name: String(row.name ?? ''), value: Number(row.value ?? row.qty ?? 0) }))));
    default:
      return <div style={{ opacity: 0.6, textAlign: 'center', padding: 40 }}>点击选择模块</div>;
  }
}

export function slotGrid(layout: string): Record<string, string> {
  if (layout === '单模块') return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
  if (layout === '左右双模块') return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' };
  if (layout === '四模块') return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' };
  return { gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr' };
}

export function DesignedScreenBody({ design, layout, data }: { design: { title: string; slots: string[] }; layout: string; data: Payload }) {
  return <div className="kgd-screen-designer-grid" data-layout={layout} style={slotGrid(layout) as CSSProperties}>
    {design.slots.map((key, index) => <ScreenPanel key={`${key}-${index}`} title={moduleLabel(key)} module={moduleLabel(key)} chart={['process_daily', 'employee_rank', 'employee_trend', 'defect_items', 'employee_defect', 'defect_analysis', 'repair_status', 'device_status', 'stock_trend', 'warehouse_share'].includes(key)}>
      <ScreenModule moduleKey={key} data={data} />
    </ScreenPanel>)}
  </div>;
}
