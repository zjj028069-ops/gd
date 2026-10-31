import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Input } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { qtyText } from '../../qty';
import { ProcessRings, type RingTask } from './ProcessRings';
import { EChart } from './echarts';
import { DesignedScreenBody, normalizeDesign } from '../round10/screens/modules';
import type { ScreenDesign } from '../round10/screens/modules';
import { KpiBoard, PeopleCards, PriorityPill, ScreenPanel, StatusLabel, Wings, hBarOption, pieOption } from './screenChrome';
import './progress.css';

type ScreenRow = { id: string; menu_name: string; preset: string; access_password: string; layout: string; module_kind?: string; design?: ScreenDesign };

const presetViews = new Set(['control', 'workshop', 'machine', 'defect', 'progress', 'wo-progress']);
/** 第十轮起新建大屏 preset_key 常为空；按菜单名回落到固定预置视图，避免只渲染空 design 槽 */
const menuPreset: Record<string, string> = {
  生产中控大屏: 'control',
  车间大屏: 'workshop',
  机台实时状态: 'machine',
  不良品统计大屏: 'defect',
  加工单生产进度: 'wo-progress',
};

function pad(value: string) {
  return value.padStart(2, '0');
}

function shanghaiClock() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = pick('hour') === '24' ? '00' : pad(pick('hour'));
  return `${pick('year')}-${pad(pick('month'))}-${pad(pick('day'))} ${hour}:${pad(pick('minute'))}:${pad(pick('second'))}`;
}

function FullscreenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M2 6V2h4M12 2h4v4M16 12v4h-4M6 16H2v-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 2v6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5.2 4.6a6 6 0 1 0 7.6 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ScreenFrame({ title, children, onExit }: { title: string; children: ReactNode; onExit: () => void }) {
  const [clock, setClock] = useState(shanghaiClock());
  const [full, setFull] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(shanghaiClock()), 1000);
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);
  return (
    <div className="kgd-screen-root">
      <header className="kgd-screen-header">
        <div className="kgd-screen-time">{clock}</div>
        <div className="kgd-screen-title-wrap">
          <Wings />
          <h1 className="kgd-screen-title">{title}</h1>
          <span className="kgd-screen-wing is-right" aria-hidden="true"><i /><i /><i /><i /></span>
        </div>
        <div className="kgd-screen-actions">
          <button type="button" aria-label={full ? '退出全屏' : '全屏'} onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }}><FullscreenIcon /></button>
          <button type="button" aria-label="退出" onClick={onExit}><PowerIcon /></button>
        </div>
      </header>
      <div className="kgd-screen-body">{children}</div>
    </div>
  );
}

function cellText(value: string | number | undefined) {
  return value == null ? '' : String(value);
}

function ScreenTable({ columns, rows, tones }: { columns: string[]; rows: Record<string, ReactNode>[]; tones?: Record<string, string> }) {
  return (
    <div className="kgd-screen-scroll">
      <table className="kgd-screen-table">
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {rows.length ? rows.map((row, index) => (
            <tr key={index}>{columns.map((column) => <td key={column} className={tones?.[column]}>{row[column] ?? ''}</td>)}</tr>
          )) : <tr><td colSpan={columns.length} className="kgd-screen-empty">暂无数据</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const priorityText: Record<string, string> = { urgent: '加急', normal: '正常', delayed: '延期', none: '无' };

function defectSlices(raw: unknown) {
  const rows = (raw ?? []) as { name?: string; value?: number; qty?: string }[];
  return rows.map((row) => ({ name: row.name ?? '', value: row.value ?? Number(row.qty ?? 0) }));
}

function asWorkOrder(row: Record<string, unknown>) {
  const snap = (row.product_snapshot ?? {}) as { name?: string; code?: string; specification?: string };
  const tasks = (row.ring_tasks ?? row.tasks ?? []) as Record<string, unknown>[];
  const ring_tasks: RingTask[] = tasks.map((task, index) => {
    const plan = String(task.plan_qty ?? task.plan ?? '0');
    const good = String(task.approved_good ?? task.good ?? '0');
    const planN = Number(plan) || 0;
    const goodN = Number(good) || 0;
    return {
      id: String(task.id ?? index),
      process_name: String(task.process_name ?? task.name ?? ''),
      execution: String(task.execution ?? 'not_started'),
      plan_qty: qtyText(plan),
      approved_good: qtyText(good),
      approved_defect: String(task.approved_defect ?? '0'),
      ring_percent: planN <= 0 ? 0 : Math.min(100, Math.floor((goodN * 100) / planN)),
    };
  });
  return {
    code: String(row.code ?? ''),
    product_name: String(row.product_name ?? snap.name ?? ''),
    product_code: String(row.product_code ?? snap.code ?? ''),
    specification: String(row.specification ?? snap.specification ?? '') || '无',
    plan_qty: qtyText(String(row.plan_qty ?? '0')),
    priority: priorityText[String(row.priority ?? '')] ?? String(row.priority ?? '无'),
    ring_tasks,
  };
}

function compare(today: string | number | undefined, yesterday: string | number | undefined) {
  const left = Number(String(today ?? '0').replace(/[^\d.-]/g, '')) || 0;
  const right = Number(String(yesterday ?? '0').replace(/[^\d.-]/g, '')) || 0;
  if (left === right) return '';
  return left > right ? '↑' : '↓';
}

function chartBox(option: object) {
  return <EChart theme="dark" className="kgd-screen-chart" style={{ minHeight: 0, height: '100%' }} option={option as never} />;
}

function machineRows(raw: unknown) {
  return ((raw ?? []) as Record<string, string>[]).map((row) => ({
    code: row.code ?? row.机台编号 ?? '',
    name: row.name ?? row.机台名称 ?? '',
    specification: row.specification ?? row.spec ?? row.机台规格 ?? '',
    status: row.status ?? row.机台状态 ?? '',
    workshop: row.workshop ?? row.shop_name ?? row.车间 ?? '',
    good: cellText(row.good_qty ?? row.良品数),
    rate: cellText(row.good_rate ?? row['良品率(%)']),
  }));
}

function reportRows(raw: unknown, chinese = false) {
  return ((raw ?? []) as Record<string, string>[]).map((row) => ({
    时间: String(row.时间 ?? row.time ?? '').replace(/^\d{4}-/, '').slice(0, 11),
    报工人: row.报工人 ?? row.operator_name ?? '',
    工序: row.工序 ?? row.process_name ?? '',
    产品: row.产品 ?? row.product_name ?? '',
    编号: row.编号 ?? row.product_code ?? '',
    良品数: row.良品数 ?? row.good_qty ?? '',
    不良品数: row.不良品数 ?? row.defect_qty ?? '',
    chinese,
  }));
}

function ReportTable({ rows }: { rows: ReturnType<typeof reportRows> }) {
  return (
    <ScreenTable
      columns={['时间', '报工人', '工序', '产品', '编号', '良品数', '不良品数']}
      tones={{ 良品数: 'is-good', 不良品数: 'is-bad' }}
      rows={rows.map((row) => ({
        时间: row.时间,
        报工人: row.报工人,
        工序: row.工序,
        产品: row.产品,
        编号: row.编号,
        良品数: <span className="is-good">{row.良品数}</span>,
        不良品数: <span className="is-bad">{row.不良品数}</span>,
      }))}
    />
  );
}

function ControlScreen({ data }: { data: Record<string, unknown> }) {
  const metrics = (data.cards ?? data.metrics ?? {}) as Record<string, string | number>;
  const yReport = compare(metrics.today_reports, metrics.yesterday_reports);
  const yDefect = compare(metrics.today_defects, metrics.yesterday_defects);
  const yRate = compare(metrics.today_defect_rate, metrics.yesterday_defect_rate);
  const cards = [
    { label: '待生产工单数', value: String(metrics.pending_orders ?? 0), tone: 'gold' },
    { label: '进行中工单数', value: String(metrics.running_orders ?? 0), tone: 'cyan' },
    { label: '今日完成工单数', value: String(metrics.completed_today ?? 0), tone: 'green' },
    { label: '今日报工数', value: String(metrics.today_reports ?? 0), extra: metrics.yesterday_reports != null ? `较昨日 ${metrics.yesterday_reports}${yReport}` : '', tone: 'plain' },
    { label: '今日不良品数', value: String(metrics.today_defects ?? 0), extra: metrics.yesterday_defects != null ? `较昨日 ${metrics.yesterday_defects}${yDefect}` : '', tone: 'red' },
    { label: '今日不良品率', value: String(metrics.today_defect_rate ?? '0 %'), extra: metrics.yesterday_defect_rate != null ? `较昨日 ${metrics.yesterday_defect_rate}${yRate}` : (metrics.yesterday_defects != null ? '较昨日' : ''), tone: 'red' },
    { label: '七天内待交货工单', value: String(metrics.due_week ?? 0), tone: 'cyan' },
    { label: '逾期工单数', value: String(metrics.overdue_orders ?? 0), tone: 'orange' },
    { label: '逾期任务数', value: String(metrics.overdue_tasks ?? 0), tone: 'orange' },
  ];
  const people = ((data.employee_defect ?? data.people_defect_rate ?? []) as { name?: string; rate?: string | number }[])
    .map((row) => ({ name: String(row.name ?? ''), value: Number(row.rate ?? 0) }));
  const stats = ((data.people_stats ?? []) as Record<string, string>[]).map((row) => ({
    name: row.姓名 ?? row.name ?? '',
    today: String(row.今日报工数 ?? row.today_qty ?? '0'),
    week: String(row.本周不良品数 ?? row.week_defect ?? '0'),
    month: String(row.本月不良品数 ?? row.month_defect ?? '0'),
  }));
  const workOrders = ((data.work_orders ?? []) as Record<string, unknown>[]).map(asWorkOrder);
  const [q, setQ] = useState('');
  const filtered = workOrders.filter((row) => !q.trim() || `${row.code}${row.product_name}${row.product_code}${row.specification}`.includes(q.trim()));
  const machines = machineRows(data.machines);
  return (
    <div className="kgd-screen-control" data-layout="three-rows">
      <ScreenPanel title="不良品项分布" module="不良品项分布" range chart><div className="kgd-screen-chart-host">{chartBox(pieOption(defectSlices(data.defect_items)))}</div></ScreenPanel>
      <KpiBoard cards={cards} />
      <ScreenPanel title="员工产能趋势" module="员工产能趋势" range chart><div className="kgd-screen-chart-host">{chartBox(capacityOption(data))}</div></ScreenPanel>
      <ScreenPanel title="人员不良品率" module="人员不良品率" range chart><div className="kgd-screen-chart-host">{chartBox(hBarOption(people, 'defect'))}</div></ScreenPanel>
      <ScreenPanel title="实时报工数据" module="实时报工数据"><ReportTable rows={reportRows(data.recent_reports ?? data.reports)} /></ScreenPanel>
      <ScreenPanel title="人员生产统计" module="人员生产统计"><PeopleCards rows={stats} /></ScreenPanel>
      <ScreenPanel title="工单执行进度" module="工单执行进度">
        <label className="kgd-screen-search">
          <input placeholder="请输入工单编号/产品名/编号/规格" value={q} onChange={(event) => setQ(event.target.value)} />
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M9.2 9.2 12 12" stroke="currentColor" strokeWidth="1.4" /></svg>
        </label>
        <ScreenTable
          columns={['工单编号', '产品', '产品编号', '产品规格', '计划数', '优先级', '工序进度']}
          rows={filtered.map((row) => ({
            工单编号: row.code,
            产品: row.product_name,
            产品编号: row.product_code,
            产品规格: row.specification,
            计划数: row.plan_qty,
            优先级: <PriorityPill text={row.priority} />,
            工序进度: <ProcessRings tasks={row.ring_tasks ?? []} workOrderCode={row.code} />,
          }))}
        />
      </ScreenPanel>
      <ScreenPanel title="机台状态详情" module="机台状态详情">
        <ScreenTable
          columns={['机台名称', '机台状态', '良品数', '良品率(%)']}
          tones={{ 良品数: 'is-good' }}
          rows={machines.map((row) => ({
            机台名称: row.name,
            机台状态: <StatusLabel status={row.status} />,
            良品数: <span className="is-good">{row.good || '-'}</span>,
            '良品率(%)': row.rate || '-',
          }))}
        />
      </ScreenPanel>
    </div>
  );
}

function capacityOption(data: Record<string, unknown>) {
  const rows = (data.employee_trend ?? []) as { name: string; day: string; qty: string }[];
  const days = [...new Set(rows.map((row) => row.day))];
  const names = [...new Set(rows.map((row) => row.name))];
  return {
    backgroundColor: 'transparent',
    color: pieOption([]).color,
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll', textStyle: { color: '#cfe3ff', fontSize: 11 }, data: names },
    grid: { left: 36, right: 12, top: 28, bottom: 22 },
    xAxis: { type: 'category', data: days.map((day) => day.slice(5)), axisLabel: { color: '#9fb6d4', fontSize: 10 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, axisLabel: { color: '#9fb6d4' } },
    series: names.map((name) => ({ type: 'line', name, smooth: true, symbol: 'circle', symbolSize: 6, data: days.map((day) => Number(rows.find((row) => row.name === name && row.day === day)?.qty ?? 0)) })),
  };
}

function WorkshopScreen({ data }: { data: Record<string, unknown> }) {
  const rank = ((data.employee_rank ?? data.rank ?? []) as { name?: string; qty?: string; value?: number }[])
    .map((item) => ({ name: String(item.name ?? ''), value: Number(item.qty ?? item.value ?? 0) }));
  const daily = (data.process_daily ?? []) as { day: string; qty: string }[];
  const tasks = ((data.task_progress ?? data.tasks ?? []) as Record<string, string>[]).map((row) => ({
    工单编号: row.work_order_code ?? row.工单编号 ?? '',
    工序: row.process_name ?? row.工序 ?? '',
    生产人员: row.operator_name ?? row.生产人员 ?? '',
    任务数: row.task_qty ?? row.任务数 ?? '',
    良品数: <span className="is-good">{row.good_qty ?? row.良品数 ?? ''}</span>,
    不良品数: <span className="is-bad">{row.defect_qty ?? row.不良品数 ?? ''}</span>,
    未完成数: row.pending_qty ?? row.未完成数 ?? '',
  }));
  return (
    <div className="kgd-screen-workshop" data-layout="quad">
      <ScreenPanel title="员工报工排行" module="员工报工排行" range chart><div className="kgd-screen-chart-host">{chartBox(hBarOption(rank, 'rank'))}</div></ScreenPanel>
      <ScreenPanel title="工序报工分析" module="工序报工分析" range chart>
        <div className="kgd-screen-chart-host">{chartBox({
          backgroundColor: 'transparent',
          color: ['#3dce7c'],
          tooltip: { trigger: 'axis' },
          legend: { data: ['报工数量'], textStyle: { color: '#cfe3ff' }, top: 0 },
          grid: { left: 48, right: 16, top: 32, bottom: 24 },
          xAxis: { type: 'category', data: daily.map((row) => String(row.day).slice(5)), axisLabel: { color: '#9fb6d4' } },
          yAxis: { name: '报工数量', nameTextStyle: { color: '#9fb6d4' }, type: 'value', axisLabel: { color: '#9fb6d4' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } } },
          series: [{ type: 'line', smooth: true, symbol: 'circle', symbolSize: 7, areaStyle: { color: 'rgba(61,206,124,0.18)' }, name: '报工数量', data: daily.map((row) => Number(row.qty)) }],
        })}</div>
      </ScreenPanel>
      <ScreenPanel title="任务执行进度" module="任务执行进度">
        <ScreenTable columns={['工单编号', '工序', '生产人员', '任务数', '良品数', '不良品数', '未完成数']} rows={tasks} />
      </ScreenPanel>
      <ScreenPanel title="实时报工数据" module="实时报工数据"><ReportTable rows={reportRows(data.recent_reports ?? data.reports)} /></ScreenPanel>
    </div>
  );
}

function ProgressScreen({ data }: { data: Record<string, unknown> }) {
  const workOrders = ((data.work_orders ?? []) as Record<string, unknown>[]).map(asWorkOrder);
  const [q, setQ] = useState('');
  const filtered = workOrders.filter((row) => !q.trim() || `${row.code}${row.product_name}${row.product_code}${row.specification}`.includes(q.trim()));
  return (
    <div className="kgd-screen-single" data-layout="single">
      <ScreenPanel title="工单执行进度" module="工单执行进度">
        <label className="kgd-screen-search">
          <input placeholder="请输入工单编号/产品名/编号/规格" value={q} onChange={(event) => setQ(event.target.value)} />
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M9.2 9.2 12 12" stroke="currentColor" strokeWidth="1.4" /></svg>
        </label>
        <ScreenTable
          columns={['工单编号', '产品', '编号', '规格', '计划数', '优先级', '工序进度']}
          rows={filtered.map((row) => ({
            工单编号: row.code,
            产品: row.product_name,
            编号: row.product_code,
            规格: row.specification,
            计划数: row.plan_qty,
            优先级: <PriorityPill text={row.priority} />,
            工序进度: <ProcessRings tasks={row.ring_tasks} workOrderCode={row.code} mode="qty" />,
          }))}
        />
      </ScreenPanel>
    </div>
  );
}

function DefectScreen({ data }: { data: Record<string, unknown> }) {
  const people = ((data.employee_defect ?? []) as { name?: string; rate?: string | number }[])
    .map((row) => ({ name: String(row.name ?? ''), value: Number(row.rate ?? 0) }));
  return (
    <div className="kgd-screen-defect" data-layout="split">
      <ScreenPanel title="人员不良品率" module="人员不良品率" range chart><div className="kgd-screen-chart-host">{chartBox(hBarOption(people, 'defect'))}</div></ScreenPanel>
      <ScreenPanel title="不良品项分布" module="不良品项分布" range chart><div className="kgd-screen-chart-host">{chartBox(pieOption(defectSlices(data.defect_items)))}</div></ScreenPanel>
    </div>
  );
}

function MachineScreen({ data }: { data: Record<string, unknown> }) {
  const rows = machineRows(data.machines);
  return (
    <div className="kgd-screen-single" data-layout="single">
      <ScreenPanel title="机台状态详情" module="机台状态详情">
        <ScreenTable
          columns={['机台编号', '机台名称', '机台规格', '机台状态', '车间', '良品数', '良品率(%)']}
          rows={rows.map((row) => ({
            机台编号: row.code,
            机台名称: row.name,
            机台规格: row.specification || '-',
            机台状态: <StatusLabel status={row.status} />,
            车间: row.workshop || '-',
            良品数: <span className="is-good">{row.good || '-'}</span>,
            '良品率(%)': row.rate || '-',
          }))}
        />
      </ScreenPanel>
    </div>
  );
}

function ScreenBody({ preset, data }: { preset: string; data: Record<string, unknown> }) {
  if (preset === 'workshop') return <WorkshopScreen data={data} />;
  if (preset === 'progress' || preset === 'wo-progress') return <ProgressScreen data={data} />;
  if (preset === 'defect') return <DefectScreen data={data} />;
  if (preset === 'machine') return <MachineScreen data={data} />;
  return <ControlScreen data={data} />;
}

export function ScreenRoute() {
  const { revision, onExpired } = useKgd();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const pwdParam = params.get('pwd') ?? '';
  const [pwdInput, setPwdInput] = useState('');
  const screens = useRemote<{ items: ScreenRow[] }>('/api/data-screens', revision, onExpired);
  const meta = useMemo(() => {
    const items = screens.data?.items ?? [];
    return items.find((item) => item.id === id || item.preset === id);
  }, [id, screens.data]);
  const preset = (meta?.preset && presetViews.has(meta.preset) ? meta.preset : '')
    || menuPreset[meta?.menu_name ?? '']
    || (id === 'control' ? 'control' : id);
  const designed = !!meta && (!!meta.design?.slots?.length || !presetViews.has(preset));
  const pwd = pwdParam || pwdInput;
  const authed = !!meta && (!meta.access_password || meta.access_password === pwd);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!authed) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, [authed]);
  const dataPath = authed ? `/api/progress/screen-data/${meta!.id}?pwd=${encodeURIComponent(pwd)}&tick=${tick}` : null;
  const payload = useRemote<Record<string, unknown>>(dataPath, revision, onExpired);

  if (!meta && screens.loading) return <div className="kgd-screen-pwd-gate">正在加载大屏…</div>;
  if (!meta) return <div className="kgd-screen-pwd-gate">大屏不存在</div>;
  if (!authed) {
    return (
      <div className="kgd-screen-pwd-gate">
        <div className="kgd-screen-pwd-card">
          <h2>{meta.menu_name}</h2>
          <p>请输入访问密码</p>
          <Input value={pwdInput} onChange={(event) => setPwdInput(event.target.value)} style={{ width: 240, marginBottom: 12 }} />
          <Button type="primary" onClick={() => setParams({ pwd: pwdInput })}>进入</Button>
        </div>
      </div>
    );
  }

  return (
    designed ? (() => {
      const design = normalizeDesign(meta.design, meta.module_kind ?? '生产模块', meta.layout, meta.menu_name);
      return <ScreenFrame title={design.title} onExit={() => { window.close(); navigate('/screen_management/list'); }}>
        <DesignedScreenBody design={design} layout={meta.layout} data={payload.data ?? {}} />
      </ScreenFrame>;
    })() : <ScreenFrame title={meta.menu_name} onExit={() => { window.close(); navigate('/screen_management/list'); }}>
      <ScreenBody preset={preset} data={payload.data ?? {}} />
    </ScreenFrame>
  );
}
