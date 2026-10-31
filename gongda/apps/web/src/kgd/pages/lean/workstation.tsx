import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, App, Button, Cascader, DatePicker, Empty, Input, Modal, Pagination, Select, Table, Upload } from 'antd';
import type { UploadFile } from 'antd/es/upload/interface';
import { BarChartOutlined, CustomerServiceOutlined, ExportOutlined, FileSearchOutlined, FlagOutlined, HighlightOutlined, InboxOutlined, PlusOutlined, SafetyCertificateOutlined, SearchOutlined, SettingOutlined, SyncOutlined, TeamOutlined, ToolOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { EChartsCoreOption } from 'echarts/core';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ColumnConfigModal } from '../../dialogs';
import { beijingTime, showError, useCommand } from '../../kit';
import type { ColumnPrefs } from '../../storage';
import { downloadCsv } from '../../wage';
import { EChart } from '../progress/echarts';
import { dash, StatusTag } from '../round8/kit';
import { requestKey } from '../../../requestKey';

type Rec = Record<string, string> & { id: string };
type Dept = { id: string; name: string; parent_id: string | null };
type Named = { id: string; name: string; code?: string; display_name?: string; customer_id?: string; phone?: string };
type Lookups = { customers: Named[]; contacts: Named[]; products: Named[]; members: Named[] };
type Bucket = { key: string; label: string };
type Series = { name: string; points: number[] };
type Board = { name: string; items: { name: string; count: number }[] };
type Payload = {
  quality: Rec[];
  patrols: Rec[];
  complaints: Rec[];
  aftersales: Rec[];
  designs: Rec[];
  materials: Rec[];
  meetings: Rec[];
  trend: { buckets: Bucket[]; series: Series[] };
  boards: Board[];
};
type Col = {
  key: string;
  title: string;
  width?: number;
  ellipsis?: boolean;
  fixed?: 'right';
  sorter?: (a: Rec, b: Rec) => number;
  render: (row: Rec) => ReactNode;
  text?: (row: Rec) => string;
};
type DeptNode = { value: string; label: string; children?: DeptNode[] };

const PERIODS = ['昨天', '今天', '本周', '本月', '本季度', '本年'] as const;
const GRAINS = ['每天', '每周', '每月'] as const;
const GRAIN_OPTIONS = GRAINS.map((item) => ({ value: item, label: item }));
const TREND = ['现场巡查', '生产质检', '售后反馈', '客户投诉', '设计问题', '物料问题'] as const;
const TREND_COLORS = ['#5B8FF9', '#5AD8A6', '#F6BD16', '#E86452', '#6DC8EC', '#1E9493'];
const emptyRows: Rec[] = [];

function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function shiftIso(iso: string, days: number) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function periodRange(period: string) {
  const today = shanghaiToday();
  const [year, month] = today.split('-').map(Number);
  if (period === '昨天') { const day = shiftIso(today, -1); return { from: day, to: day }; }
  if (period === '今天') return { from: today, to: today };
  if (period === '本周') {
    const weekday = new Date(`${today}T12:00:00+08:00`).getUTCDay();
    return { from: shiftIso(today, -((weekday + 6) % 7)), to: today };
  }
  if (period === '本季度') {
    const quarter = Math.floor((month! - 1) / 3) * 3 + 1;
    return { from: `${year}-${String(quarter).padStart(2, '0')}-01`, to: today };
  }
  if (period === '本年') return { from: `${year}-01-01`, to: today };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

function deptTree(rows: Dept[]) {
  const nodes = new Map<string, DeptNode>(rows.map((row) => [row.id, { value: row.id, label: row.name, children: [] }]));
  const roots: DeptNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) if (!node.children?.length) delete node.children;
  return roots;
}

function defaultDept(rows: Dept[]) {
  const parent = rows.find((row) => row.name === '生产管理部');
  const child = rows.find((row) => row.name === '生产一部' && (!parent || row.parent_id === parent.id));
  if (parent && child) return [parent.id, child.id];
  if (child) return [child.id];
  if (parent) return [parent.id];
  return [] as string[];
}

function deptName(rows: Dept[], path: string[]) {
  const id = path.at(-1);
  return rows.find((row) => row.id === id)?.name ?? '';
}

function prefsOf(columns: Col[]): ColumnPrefs {
  const order = columns.map((column) => column.key);
  return { order, visible: order, locked: [] };
}

function trendOption(buckets: Bucket[], series: Series[]): EChartsCoreOption {
  const hasData = series.some((item) => item.points.some((value) => value > 0));
  return {
    animation: false,
    color: TREND_COLORS,
    tooltip: { trigger: 'axis' },
    legend: { show: false },
    grid: { left: 8, right: 18, top: 28, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: buckets.map((bucket) => bucket.label),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#d9d9d9' } },
      axisLabel: { color: '#8c8c8c' },
    },
    yAxis: {
      type: 'value',
      name: '次数',
      nameTextStyle: { color: '#8c8c8c', padding: [0, 28, 0, 0] },
      min: 0,
      max: hasData ? undefined : 5,
      minInterval: 1,
      axisLabel: { color: '#8c8c8c' },
      splitLine: { lineStyle: { type: 'dashed', color: '#e8e8e8' } },
    },
    series: series.map((item) => ({
      name: item.name,
      type: 'line',
      showSymbol: true,
      symbol: 'circle',
      symbolSize: 6,
      data: item.points,
    })),
  };
}

function textCol(key: string, title: string, width?: number, extra?: Partial<Col>): Col {
  return { key, title, width, render: (row) => dash(row[key]), text: (row) => row[key] ?? '', ...extra };
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return <>
    <span>{required ? <em className="kgd-req">*</em> : null}<span>{label}</span></span>
    {children}
  </>;
}

function PhotoField({ files, onChange }: { files: UploadFile[]; onChange: (files: UploadFile[]) => void }) {
  return <div onPaste={(event) => {
    const pasted = [...event.clipboardData.files];
    if (!pasted.length) return;
    event.preventDefault();
    const next = [...files, ...pasted.map((file) => ({ uid: requestKey(), name: file.name } as UploadFile))].slice(0, 6);
    onChange(next);
  }}>
    <Upload.Dragger aria-label="现场照片" multiple maxCount={6} fileList={files} beforeUpload={() => false} onChange={({ fileList }) => onChange(fileList.slice(0, 6))}>
      <p>选择文件 Ctrl+v 粘贴或拖拽文件到此处</p>
    </Upload.Dragger>
  </div>;
}

function photoText(files: UploadFile[]) {
  return files.map((file) => file.name).filter(Boolean).join('、');
}

function IssueCard({ title, icon, color, extra, rows, columns, loading, filename, narrow, scrollX }: {
  title: string;
  icon: ReactNode;
  color: string;
  extra?: ReactNode;
  rows: Rec[];
  columns: Col[];
  loading: boolean;
  filename: string;
  narrow?: boolean;
  scrollX?: number;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize) || 1));
  const start = (current - 1) * pageSize;
  function exportPage() {
    const fields = columns.filter((column) => column.text);
    downloadCsv(filename, fields.map((column) => column.title), rows.slice(start, start + pageSize).map((row) => fields.map((column) => column.text!(row))));
  }
  return <section className={`lean-ws-card${narrow ? ' lean-ws-narrow' : ''}`} aria-label={title}>
    <header className="lean-ws-card-hd">
      <h3><i className="lean-ws-ico" style={{ background: color }} aria-hidden="true">{icon}</i>{title}</h3>
      <div className="tools">
        {extra}
        <Button type="primary" autoInsertSpace={false} icon={<ExportOutlined aria-hidden />} onClick={exportPage}>导出</Button>
      </div>
    </header>
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      dataSource={rows.slice((current - 1) * pageSize, current * pageSize)}
      scroll={{ x: scrollX ?? 'max-content' }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" /> }}
      pagination={false}
      columns={columns.map((column) => ({
        key: column.key,
        title: column.title,
        width: column.width,
        ellipsis: column.ellipsis,
        fixed: column.fixed,
        sorter: column.sorter,
        render: (_value: unknown, row: Rec) => column.render(row),
      }))}
    />
    <Pagination size="small" current={current} pageSize={pageSize} total={rows.length} showSizeChanger pageSizeOptions={[5, 10, 20, 30, 50]} showTotal={(total) => `共${total}条数据`} onChange={(next, size) => { setPage(next); setPageSize(size); }} />
  </section>;
}

export function LeanWorkstation() {
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const { message, modal } = App.useApp();
  const command = useCommand();
  const settings = useRemote<{ departments: Dept[]; processes: { id: string; name: string }[] }>('/api/lean/settings', revision, onExpired);
  const initial = periodRange('今天');
  const [period, setPeriod] = useState('今天');
  const [draftFrom, setDraftFrom] = useState(initial.from);
  const [draftTo, setDraftTo] = useState(initial.to);
  const [deptPath, setDeptPath] = useState<string[]>([]);
  const [grain, setGrain] = useState<(typeof GRAINS)[number]>('每天');
  const [applied, setApplied] = useState({ from: initial.from, to: initial.to, departmentId: '' });
  const [booted, setBooted] = useState(false);
  const [land, setLand] = useState('全部');
  const [complaintOpen, setComplaintOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [detail, setDetail] = useState<{ title: string; pairs: [string, string][]; removePath?: string } | null>(null);
  const [designPrefs, setDesignPrefs] = useState<ColumnPrefs | null>(null);
  const [materialPrefs, setMaterialPrefs] = useState<ColumnPrefs | null>(null);
  const [designGear, setDesignGear] = useState(false);
  const [materialGear, setMaterialGear] = useState(false);
  const [meetingPage, setMeetingPage] = useState(1);
  const [meetingPageSize, setMeetingPageSize] = useState(5);

  useEffect(() => {
    if (booted) return;
    if (!settings.data) {
      if (settings.error) setBooted(true);
      return;
    }
    const path = defaultDept(settings.data.departments);
    setDeptPath(path);
    setApplied((current) => ({ ...current, departmentId: path.at(-1) ?? '' }));
    setBooted(true);
  }, [booted, settings.data, settings.error]);

  const query = useMemo(() => {
    if (!booted) return null;
    const params = new URLSearchParams();
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (applied.departmentId) params.set('department_id', applied.departmentId);
    params.set('grain', grain);
    return `/api/lean/workstation?${params}`;
  }, [booted, applied, grain]);
  const remote = useRemote<Payload>(query, revision, onExpired);
  const lookups = useRemote<Lookups>(booted ? '/api/lean/lookups' : null, revision, onExpired);
  const departments = settings.data?.departments ?? [];
  const tree = useMemo(() => deptTree(departments), [departments]);
  const data = remote.data;
  const buckets = data?.trend.buckets ?? [];
  const series = data?.trend.series ?? TREND.map((name) => ({ name, points: [] as number[] }));
  const option = useMemo(() => trendOption(buckets, series), [buckets, series]);
  const meetings = (data?.meetings ?? emptyRows).filter((row) => land === '全部' || row.landed === land);
  const meetingCurrent = Math.min(meetingPage, Math.max(1, Math.ceil(meetings.length / meetingPageSize) || 1));

  function applyPeriod(name: string) {
    const range = periodRange(name);
    setPeriod(name);
    setDraftFrom(range.from);
    setDraftTo(range.to);
    setApplied((current) => ({ ...current, from: range.from, to: range.to }));
  }

  function applyQuery() {
    let from = draftFrom;
    let to = draftTo;
    if (from && to && from > to) { const swap = from; from = to; to = swap; }
    setDraftFrom(from);
    setDraftTo(to);
    const matched = PERIODS.find((name) => { const range = periodRange(name); return range.from === from && range.to === to; });
    setPeriod(matched ?? '');
    setApplied({ from, to, departmentId: deptPath.at(-1) ?? '' });
  }

  function reset() {
    const range = periodRange('今天');
    const path = defaultDept(departments);
    setPeriod('今天');
    setDraftFrom(range.from);
    setDraftTo(range.to);
    setDeptPath(path);
    setGrain('每天');
    setLand('全部');
    setApplied({ from: range.from, to: range.to, departmentId: path.at(-1) ?? '' });
  }

  function removeRow(path: string) {
    modal.confirm({
      title: '删除',
      content: '确定删除这条记录？',
      okText: '确定',
      cancelText: '取消',
      okButtonProps: { autoInsertSpace: false },
      cancelButtonProps: { autoInsertSpace: false },
      onOk: () => command.send(path, {}, 'DELETE').then(() => { setDetail(null); message.success('已删除'); }).catch((error) => message.error(showError(error))),
    });
  }

  function view(title: string, pairs: [string, string][], removePath?: string) {
    setDetail({ title, pairs, removePath });
  }

  const qualityColumns: Col[] = [
    textCol('work_order_code', '加工单', 120),
    textCol('process_name', '工序名', 100),
    textCol('owner_name', '责任人', 90),
    textCol('defect_qty', '不良品数', 90),
    textCol('status', '状态', 80, { render: (row) => <StatusTag text={row.status} /> }),
    textCol('quality_note', '质检备注', 140),
  ];
  const patrolColumns: Col[] = [
    textCol('department_name', '责任部门', 110),
    textCol('owner_names', '责任人', 90),
    textCol('category', '问题分类', 100),
    textCol('status', '状态', 80, { render: (row) => <StatusTag text={row.status} /> }),
    textCol('description', '问题描述', 160),
  ];
  const complaintColumns: Col[] = [
    textCol('owner_names', '责任人', 90),
    textCol('department_name', '责任部门', 110),
    textCol('product_name', '产品', 100),
    textCol('content', '投诉内容', 140),
    textCol('photos', '现场照片', 110),
    textCol('analysis', '问题分析', 120),
    textCol('customer_name', '客户', 100),
    textCol('contact_name', '联系人', 90),
    textCol('phone', '联系电话', 120),
    textCol('status', '状态', 80, { render: (row) => <StatusTag text={row.status} /> }),
    textCol('created_at', '创建时间', 160, { render: (row) => beijingTime(row.created_at, ''), text: (row) => beijingTime(row.created_at, ''), sorter: (a, b) => String(a.created_at).localeCompare(String(b.created_at)) }),
    { key: 'actions', title: '操作', width: 72, fixed: 'right', render: (row) => <Button type="link" onClick={() => view('客户投诉', [['责任人', row.owner_names], ['责任部门', row.department_name], ['产品', row.product_name], ['投诉内容', row.content], ['现场照片', row.photos], ['问题分析', row.analysis], ['客户', row.customer_name], ['联系人', row.contact_name], ['联系电话', row.phone], ['状态', row.status], ['创建时间', beijingTime(row.created_at, '')]], `/api/lean/complaints/${row.id}`)}>查看</Button> },
  ];
  const afterColumns: Col[] = [
    textCol('work_order_code', '工单号', 120),
    textCol('fault_type', '故障类别', 100),
    textCol('process_name', '生产工序', 100),
    textCol('status', '状态', 80, { render: (row) => <StatusTag text={row.status} /> }),
    textCol('owner_name', '责任人', 90),
  ];
  const designColumnsDef: Col[] = [
    textCol('product_name', '产品', 100),
    textCol('description', '问题描述', 72, { ellipsis: true }),
    textCol('photos', '现场照片', 100),
    textCol('association', '问题关联', 100),
    textCol('status', '处理状态', 90, { render: (row) => <StatusTag text={row.status} /> }),
    textCol('handler_name', '处理人', 90),
    { key: 'manage', title: '管理', width: 110, render: (row) => <>
      <Button type="link" onClick={() => view('设计问题', [['产品', row.product_name], ['问题描述', row.description], ['现场照片', row.photos], ['问题关联', row.association], ['处理状态', row.status], ['处理人', row.handler_name]], `/api/lean/designs/${row.id}`)}>查看</Button>
      <Button type="link" onClick={() => removeRow(`/api/lean/designs/${row.id}`)}>删除</Button>
    </> },
  ];
  const materialColumnsDef: Col[] = [
    textCol('product_name', '商品', 100),
    textCol('description', '问题描述', 72, { ellipsis: true }),
    textCol('photos', '现场照片', 100),
    textCol('association', '问题关联', 100),
    textCol('status', '处理状态', 90, { render: (row) => <StatusTag text={row.status} /> }),
    textCol('handler_name', '处理人', 90),
    { key: 'manage', title: '管理', width: 110, render: (row) => <>
      <Button type="link" onClick={() => view('物料问题', [['商品', row.product_name], ['问题描述', row.description], ['现场照片', row.photos], ['问题关联', row.association], ['处理状态', row.status], ['处理人', row.handler_name]], `/api/lean/materials/${row.id}`)}>查看</Button>
      <Button type="link" onClick={() => removeRow(`/api/lean/materials/${row.id}`)}>删除</Button>
    </> },
  ];
  const meetingColumns: Col[] = [
    textCol('title', '会议主题', 140),
    textCol('meet_at', '会议时间', 160, { render: (row) => beijingTime(row.meet_at, ''), text: (row) => beijingTime(row.meet_at, '') }),
    textCol('form', '会议形式', 90),
    textCol('member_names', '参会人员', 120),
    textCol('place', '参会地点', 120),
    textCol('progress', '落实进度', 110),
    { key: 'actions', title: '操作', width: 72, render: (row) => <Button type="link" onClick={() => navigate(`/meeting/detail/${row.id}`)}>详情</Button> },
  ];

  const designShown = applyPrefs(designColumnsDef, designPrefs);
  const materialShown = applyPrefs(materialColumnsDef, materialPrefs);

  return <div className="lean-ws">
    <section className="lean-ws-filter" aria-label="统计筛选">
      <span className="lean-ws-label">统计周期</span>
      <div className="lean-ws-periods" role="group" aria-label="统计周期">
        {PERIODS.map((name) => <button key={name} type="button" className={period === name ? 'on' : ''} aria-pressed={period === name} onClick={() => applyPeriod(name)}>{name}</button>)}
      </div>
      <DatePicker aria-label="开始日期" allowClear={false} value={draftFrom ? dayjs(draftFrom) : null} onChange={(value) => { setDraftFrom(value ? value.format('YYYY-MM-DD') : ''); setPeriod(''); }} />
      <DatePicker aria-label="结束日期" allowClear={false} value={draftTo ? dayjs(draftTo) : null} onChange={(value) => { setDraftTo(value ? value.format('YYYY-MM-DD') : ''); setPeriod(''); }} />
      <span className="lean-ws-label">部门</span>
      <Cascader aria-label="部门" allowClear changeOnSelect showSearch style={{ width: 220 }} options={tree} value={deptPath.length ? deptPath : undefined} placeholder="请选择部门" onChange={(value) => { setDeptPath((value ?? []).map(String)); }} />
      <div className="lean-ws-actions">
        <Button type="primary" autoInsertSpace={false} icon={<SearchOutlined aria-hidden />} onClick={applyQuery}>查询</Button>
        <button type="button" className="lean-ws-reset" aria-label="重置" onClick={reset}><SyncOutlined /></button>
      </div>
    </section>
    {remote.error && <Alert type="error" showIcon message={remote.error} />}
    <section className="lean-ws-card" aria-label="质量趋势图">
      <header className="lean-ws-card-hd">
        <h3><BarChartOutlined aria-hidden style={{ color: '#4184F4' }} />质量趋势图</h3>
        <div className="tools">
          <Select aria-label="粒度" virtual={false} value={grain} style={{ width: 96 }} options={GRAIN_OPTIONS} onChange={setGrain} />
        </div>
      </header>
      <div className="lean-ws-plot" data-grain={grain}>
        <EChart option={option} style={{ height: '100%', minHeight: 280 }} />
      </div>
      <ul className="lean-ws-legend">
        {TREND.map((name, index) => <li key={name}><i style={{ background: TREND_COLORS[index] }} />{name}</li>)}
      </ul>
    </section>
    <div className="lean-ws-grid">
      <IssueCard title="质检问题" icon={<FileSearchOutlined />} color="#fa8c16" rows={data?.quality ?? emptyRows} columns={qualityColumns} loading={remote.loading} filename="质检问题.csv" />
      <IssueCard title="巡查问题" icon={<SafetyCertificateOutlined />} color="#52c41a" rows={data?.patrols ?? emptyRows} columns={patrolColumns} loading={remote.loading} filename="巡查问题.csv" />
      <IssueCard title="客户投诉问题" icon={<CustomerServiceOutlined />} color="#fa8c16" rows={data?.complaints ?? emptyRows} columns={complaintColumns} loading={remote.loading} filename="客户投诉问题.csv" scrollX={1400} extra={<Button type="primary" autoInsertSpace={false} icon={<PlusOutlined aria-hidden />} onClick={() => setComplaintOpen(true)}>新建投诉</Button>} />
      <IssueCard title="售后反馈问题" icon={<ToolOutlined />} color="#fa8c16" rows={data?.aftersales ?? emptyRows} columns={afterColumns} loading={remote.loading} filename="售后反馈问题.csv" />
    </div>
    <div className="lean-ws-grid">
      <IssueCard title="设计问题" icon={<HighlightOutlined />} color="#722ed1" narrow rows={data?.designs ?? emptyRows} columns={designShown} loading={remote.loading} filename="设计问题.csv" extra={<>
        <Button type="primary" autoInsertSpace={false} icon={<PlusOutlined aria-hidden />} onClick={() => setDesignOpen(true)}>新增</Button>
        <Button type="text" aria-label="列配置" icon={<SettingOutlined />} onClick={() => { if (!designPrefs) setDesignPrefs(prefsOf(designColumnsDef)); setDesignGear(true); }} />
      </>} />
      <IssueCard title="物料问题" icon={<InboxOutlined />} color="#13c2c2" narrow rows={data?.materials ?? emptyRows} columns={materialShown} loading={remote.loading} filename="物料问题.csv" extra={<>
        <Button type="primary" autoInsertSpace={false} icon={<PlusOutlined aria-hidden />} onClick={() => setMaterialOpen(true)}>新增</Button>
        <Button type="text" aria-label="列配置" icon={<SettingOutlined />} onClick={() => { if (!materialPrefs) setMaterialPrefs(prefsOf(materialColumnsDef)); setMaterialGear(true); }} />
      </>} />
    </div>
    <section className="lean-ws-card" aria-label="质量黑榜">
      <header className="lean-ws-card-hd">
        <h3><i className="lean-ws-ico" style={{ background: '#722ed1' }} aria-hidden="true"><FlagOutlined /></i>质量黑榜</h3>
        <div className="tools"><Button type="text" aria-label="黑榜设置" icon={<SettingOutlined />} onClick={() => setBoardOpen(true)} /></div>
      </header>
      <div className="lean-ws-boards">
        {(data?.boards ?? [{ name: '质量黑榜', items: [] }, ...['热处理', '焊接', '硬化处理', '机械加工', '防腐处理', '铸造/锻造'].map((name) => ({ name: `${name}黑榜`, items: [] }))]).map((board) => <article key={board.name} className="lean-ws-board" aria-label={board.name}>
          <h4>{board.name}</h4>
          {board.items.length ? <ul>{board.items.map((item) => <li key={item.name}><span>{item.name}</span><b>{item.count}</b></li>)}</ul> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />}
        </article>)}
      </div>
    </section>
    <section className="lean-ws-card" aria-label="精益生产会议">
      <header className="lean-ws-card-hd">
        <h3><i className="lean-ws-ico" style={{ background: '#fa8c16' }} aria-hidden="true"><TeamOutlined /></i>精益生产会议</h3>
        <div className="tools"><Button type="primary" autoInsertSpace={false} onClick={() => setMeetingOpen(true)}>发起会议</Button></div>
      </header>
      <div className="lean-ws-chips" role="group" aria-label="落实进度">
        {['全部', '未落地', '已落地'].map((name) => <button key={name} type="button" className={land === name ? 'on' : ''} aria-pressed={land === name} onClick={() => { setLand(name); setMeetingPage(1); }}>{name}</button>)}
      </div>
      <Table
        size="small"
        rowKey="id"
        style={{ marginTop: 8 }}
        loading={remote.loading}
        dataSource={meetings.slice((meetingCurrent - 1) * meetingPageSize, meetingCurrent * meetingPageSize)}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" /> }}
        pagination={false}
        columns={meetingColumns.map((column) => ({ key: column.key, title: column.title, width: column.width, render: (_value: unknown, row: Rec) => column.render(row) }))}
      />
      <Pagination size="small" current={meetingCurrent} pageSize={meetingPageSize} total={meetings.length} showSizeChanger pageSizeOptions={[5, 10, 20, 30, 50]} showTotal={(total) => `共${total}条数据`} onChange={(next, size) => { setMeetingPage(next); setMeetingPageSize(size); }} />
    </section>
    <ComplaintDialog open={complaintOpen} departments={departments} tree={tree} defaultPath={deptPath} lookups={lookups.data} onClose={() => setComplaintOpen(false)} />
    <DesignDialog open={designOpen} products={lookups.data?.products ?? []} onClose={() => setDesignOpen(false)} />
    <MaterialDialog open={materialOpen} products={lookups.data?.products ?? []} onClose={() => setMaterialOpen(false)} />
    <MeetingDialog open={meetingOpen} members={lookups.data?.members ?? []} onClose={() => setMeetingOpen(false)} />
    <Modal title="黑榜设置" open={boardOpen} onCancel={() => setBoardOpen(false)} footer={<Button autoInsertSpace={false} onClick={() => setBoardOpen(false)}>关闭</Button>}>
      <p>黑榜工序跟随精益生产设置。未选择工序时，工序榜只保留名称，不展示数据。</p>
      <p>当前展示：{(data?.boards ?? []).map((board) => board.name).join('、') || '质量黑榜'}</p>
      <Button type="primary" autoInsertSpace={false} onClick={() => navigate('/setting/lean_production')}>前往精益生产设置</Button>
    </Modal>
    <Modal title={detail?.title} open={!!detail} onCancel={() => setDetail(null)} footer={[
      detail?.removePath ? <Button key="delete" danger autoInsertSpace={false} onClick={() => detail.removePath && removeRow(detail.removePath)}>删除</Button> : null,
      <Button key="cancel" autoInsertSpace={false} onClick={() => setDetail(null)}>取消</Button>,
      <Button key="ok" type="primary" autoInsertSpace={false} onClick={() => setDetail(null)}>确定</Button>,
    ]}>
      <dl className="kgd-detail-grid">{detail?.pairs.map(([label, value]) => <span key={label}><dt>{label}</dt><dd>{dash(value)}</dd></span>)}</dl>
    </Modal>
    {designPrefs && <ColumnConfigModal open={designGear} columns={designColumnsDef.map((column) => ({ key: column.key, label: column.title }))} value={designPrefs} onCancel={() => setDesignGear(false)} onOk={(value) => { setDesignPrefs(value); setDesignGear(false); }} />}
    {materialPrefs && <ColumnConfigModal open={materialGear} columns={materialColumnsDef.map((column) => ({ key: column.key, label: column.title }))} value={materialPrefs} onCancel={() => setMaterialGear(false)} onOk={(value) => { setMaterialPrefs(value); setMaterialGear(false); }} />}
  </div>;
}

function applyPrefs(columns: Col[], prefs: ColumnPrefs | null) {
  if (!prefs) return columns;
  return columns.filter((column) => prefs.visible.includes(column.key)).sort((a, b) => prefs.order.indexOf(a.key) - prefs.order.indexOf(b.key));
}

function ComplaintDialog({ open, departments, tree, defaultPath, lookups, onClose }: {
  open: boolean;
  departments: Dept[];
  tree: DeptNode[];
  defaultPath: string[];
  lookups: Lookups | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const command = useCommand();
  const [productId, setProductId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [contactId, setContactId] = useState('');
  const [phone, setPhone] = useState('');
  const [content, setContent] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [dept, setDept] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerContact, setCustomerContact] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [newContact, setNewContact] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [extras, setExtras] = useState<{ customers: Named[]; contacts: Named[] }>({ customers: [], contacts: [] });
  const customers = [...extras.customers, ...(lookups?.customers ?? [])];
  const contacts = [...extras.contacts, ...(lookups?.contacts ?? [])].filter((item) => item.customer_id === customerId);
  const products = lookups?.products ?? [];
  const members = lookups?.members ?? [];

  useEffect(() => {
    if (!open) return;
    setProductId('');
    setCustomerId('');
    setContactId('');
    setPhone('');
    setContent('');
    setAnalysis('');
    setDept(defaultPath);
    setOwners([]);
    setFiles([]);
  }, [open, defaultPath]);

  function pickContact(id: string) {
    setContactId(id);
    const contact = contacts.find((item) => item.id === id);
    if (contact?.phone) setPhone(contact.phone);
  }

  async function save() {
    const customer = customers.find((item) => item.id === customerId);
    const contact = contacts.find((item) => item.id === contactId);
    if (!customer) { message.warning('请选择客户'); return; }
    if (!contact) { message.warning('请选择联系人'); return; }
    if (!phone.trim()) { message.warning('请填写联系人电话'); return; }
    if (!content.trim()) { message.warning('请填写投诉内容'); return; }
    try {
      await command.send('/api/lean/complaints', {
        customer_name: customer.name,
        contact_name: contact?.name || '',
        phone: phone.trim(),
        content: content.trim(),
        analysis: analysis.trim(),
        department_name: deptName(departments, dept),
        owner_names: owners.join('、'),
        product_name: products.find((item) => item.id === productId)?.name ?? '',
        photos: photoText(files),
      });
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }

  return <>
    <Modal title="新建客户投诉" open={open} width={640} okText="确定" cancelText="取消" confirmLoading={command.busy} okButtonProps={{ autoInsertSpace: false }} cancelButtonProps={{ autoInsertSpace: false }} onCancel={onClose} onOk={() => void save()}>
      <div className="kgd-form">
        <Field label="产品"><Select aria-label="产品" allowClear showSearch optionFilterProp="label" placeholder="请选择" value={productId || undefined} options={products.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setProductId(value ?? '')} /></Field>
        <Field label="客户" required><div className="lean-ws-inline">
          <Select aria-label="客户" showSearch optionFilterProp="label" placeholder="输入关键词，在查询结果中选中" value={customerId || undefined} options={customers.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => { setCustomerId(value ?? ''); setContactId(''); setPhone(''); }} />
          <Button autoInsertSpace={false} onClick={() => { setCustomerName(''); setCustomerContact(''); setCustomerPhone(''); setCustomerOpen(true); }}>新增</Button>
        </div></Field>
        <Field label="联系人" required><div className="lean-ws-inline">
          <Select aria-label="联系人" showSearch optionFilterProp="label" placeholder="请选择" value={contactId || undefined} options={contacts.map((item) => ({ value: item.id, label: item.name }))} onChange={pickContact} />
          <Button autoInsertSpace={false} onClick={() => { if (!customerId) { message.warning('请选择客户'); return; } setNewContact(''); setNewPhone(''); setContactOpen(true); }}>新增</Button>
        </div></Field>
        <Field label="联系人电话" required><Input aria-label="联系人电话" value={phone} onChange={(event) => setPhone(event.target.value)} /></Field>
        <Field label="投诉内容" required><Input.TextArea aria-label="投诉内容" maxLength={1000} showCount value={content} onChange={(event) => setContent(event.target.value)} /></Field>
        <Field label="现场照片"><PhotoField files={files} onChange={setFiles} /></Field>
        <Field label="问题分析"><Input.TextArea aria-label="问题分析" maxLength={1000} showCount value={analysis} onChange={(event) => setAnalysis(event.target.value)} /></Field>
        <Field label="责任部门"><Cascader aria-label="责任部门" allowClear changeOnSelect options={tree} value={dept.length ? dept : undefined} onChange={(value) => setDept((value ?? []).map(String))} /></Field>
        <Field label="责任人"><Select aria-label="责任人" mode="tags" allowClear optionFilterProp="label" placeholder="请选择" value={owners} options={members.map((item) => ({ value: item.display_name || item.name, label: item.display_name || item.name }))} onChange={setOwners} /></Field>
      </div>
    </Modal>
    <Modal title="新增客户" open={customerOpen} okText="确定" cancelText="取消" confirmLoading={command.busy} okButtonProps={{ autoInsertSpace: false }} cancelButtonProps={{ autoInsertSpace: false }} onCancel={() => setCustomerOpen(false)} onOk={() => {
      if (!customerName.trim() || !customerContact.trim()) { message.warning('请填写客户和联系人'); return; }
      void command.send<{ customer: Named }>('/api/money/customers', { request_key: requestKey(), name: customerName.trim(), contact_name: customerContact.trim(), contact_phone: customerPhone.trim() }).then((result) => {
        const customer = result?.customer;
        if (customer?.id) {
          const contactKey = requestKey();
          setExtras((current) => ({ ...current, customers: [{ id: customer.id, name: customer.name || customerName.trim() }, ...current.customers], contacts: [{ id: contactKey, customer_id: customer.id, name: customerContact.trim(), phone: customerPhone.trim() }, ...current.contacts] }));
          setCustomerId(String(customer.id));
          setContactId(contactKey);
          setPhone(customerPhone.trim());
        }
        setCustomerOpen(false);
        message.success('已保存');
      }).catch((error) => message.error(showError(error)));
    }}>
      <div className="kgd-form">
        <Field label="客户名称" required><Input aria-label="客户名称" value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></Field>
        <Field label="联系人" required><Input aria-label="新客户联系人" value={customerContact} onChange={(event) => setCustomerContact(event.target.value)} /></Field>
        <Field label="联系人电话"><Input aria-label="新客户电话" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} /></Field>
      </div>
    </Modal>
    <Modal title="新增联系人" open={contactOpen} okText="确定" cancelText="取消" confirmLoading={command.busy} okButtonProps={{ autoInsertSpace: false }} cancelButtonProps={{ autoInsertSpace: false }} onCancel={() => setContactOpen(false)} onOk={() => {
      if (!newContact.trim()) { message.warning('请填写联系人'); return; }
      void command.send<{ id: string }>('/api/crm/contacts', { customer_id: customerId, name: newContact.trim(), phone: newPhone.trim() }).then((result) => {
        const id = result?.id || requestKey();
        setExtras((current) => ({ ...current, contacts: [{ id, customer_id: customerId, name: newContact.trim(), phone: newPhone.trim() }, ...current.contacts] }));
        setContactId(id);
        setPhone(newPhone.trim());
        setContactOpen(false);
        message.success('已保存');
      }).catch((error) => message.error(showError(error)));
    }}>
      <div className="kgd-form">
        <Field label="联系人" required><Input aria-label="新联系人" value={newContact} onChange={(event) => setNewContact(event.target.value)} /></Field>
        <Field label="联系人电话"><Input aria-label="新联系人电话" value={newPhone} onChange={(event) => setNewPhone(event.target.value)} /></Field>
      </div>
    </Modal>
  </>;
}

function DesignDialog({ open, products, onClose }: { open: boolean; products: Named[]; onClose: () => void }) {
  const { message } = App.useApp();
  const command = useCommand();
  const [productId, setProductId] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<UploadFile[]>([]);
  useEffect(() => { if (open) { setProductId(''); setDescription(''); setFiles([]); } }, [open]);
  return <Modal title="新增设计问题" open={open} okText="确定" cancelText="取消" confirmLoading={command.busy} okButtonProps={{ autoInsertSpace: false }} cancelButtonProps={{ autoInsertSpace: false }} onCancel={onClose} onOk={() => {
    if (!description.trim()) { message.warning('请填写问题描述'); return; }
    void command.send('/api/lean/designs', { product_name: products.find((item) => item.id === productId)?.name ?? '', description: description.trim(), photos: photoText(files) }).then(() => { message.success('已保存'); onClose(); }).catch((error) => message.error(showError(error)));
  }}>
    <div className="kgd-form">
      <Field label="产品"><Select aria-label="设计产品" allowClear showSearch optionFilterProp="label" placeholder="请选择" value={productId || undefined} options={products.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setProductId(value ?? '')} /></Field>
      <Field label="问题描述" required><Input.TextArea aria-label="设计问题描述" maxLength={1000} showCount placeholder="请填写" value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
      <Field label="现场照片"><PhotoField files={files} onChange={setFiles} /></Field>
    </div>
  </Modal>;
}

function MaterialDialog({ open, products, onClose }: { open: boolean; products: Named[]; onClose: () => void }) {
  const { message } = App.useApp();
  const command = useCommand();
  const [productId, setProductId] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [extra, setExtra] = useState<Named[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const options = [...extra, ...products];
  useEffect(() => { if (open) { setProductId(''); setDescription(''); setFiles([]); } }, [open]);
  return <>
    <Modal title="新增物料问题" open={open} okText="确定" cancelText="取消" confirmLoading={command.busy} okButtonProps={{ autoInsertSpace: false }} cancelButtonProps={{ autoInsertSpace: false }} onCancel={onClose} onOk={() => {
      if (!description.trim()) { message.warning('请填写问题描述'); return; }
      void command.send('/api/lean/materials', { product_name: options.find((item) => item.id === productId)?.name ?? '', description: description.trim(), photos: photoText(files) }).then(() => { message.success('已保存'); onClose(); }).catch((error) => message.error(showError(error)));
    }}>
      <div className="kgd-form">
        <Field label="商品"><div className="lean-ws-inline">
          <Select aria-label="商品" allowClear showSearch optionFilterProp="label" placeholder="请选择" value={productId || undefined} options={options.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setProductId(value ?? '')} />
          <Button aria-label="新增商品" icon={<PlusOutlined />} onClick={() => { setName(''); setCode(''); setAddOpen(true); }} />
        </div></Field>
        <Field label="问题描述" required><Input.TextArea aria-label="物料问题描述" maxLength={1000} showCount value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="现场照片"><PhotoField files={files} onChange={setFiles} /></Field>
      </div>
    </Modal>
    <Modal title="新增商品" open={addOpen} okText="确定" cancelText="取消" confirmLoading={command.busy} okButtonProps={{ autoInsertSpace: false }} cancelButtonProps={{ autoInsertSpace: false }} onCancel={() => setAddOpen(false)} onOk={() => {
      if (!name.trim()) { message.warning('请填写商品名称'); return; }
      void command.send<{ product: Named }>('/api/products', { name: name.trim(), code: code.trim() }).then((result) => {
        const product = result?.product;
        if (product?.id) {
          setExtra((current) => [{ id: String(product.id), name: String(product.name || name.trim()) }, ...current]);
          setProductId(String(product.id));
        }
        setAddOpen(false);
        message.success('已保存');
      }).catch((error) => message.error(showError(error)));
    }}>
      <div className="kgd-form">
        <Field label="商品名称" required><Input aria-label="商品名称" value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="商品编号"><Input aria-label="商品编号" placeholder="忽略则自动生成" value={code} onChange={(event) => setCode(event.target.value)} /></Field>
      </div>
    </Modal>
  </>;
}

function MeetingDialog({ open, members, onClose }: { open: boolean; members: Named[]; onClose: () => void }) {
  const { message } = App.useApp();
  const command = useCommand();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [time, setTime] = useState('');
  const [form, setForm] = useState('线下会议');
  const [people, setPeople] = useState<string[]>([]);
  const [place, setPlace] = useState('');
  const [related, setRelated] = useState('');
  useEffect(() => { if (open) { setTitle(''); setContent(''); setTime(''); setForm('线下会议'); setPeople([]); setPlace(''); setRelated(''); } }, [open]);
  return <Modal title="新增会议" open={open} okText="确定" cancelText="取消" confirmLoading={command.busy} okButtonProps={{ autoInsertSpace: false }} cancelButtonProps={{ autoInsertSpace: false }} onCancel={onClose} onOk={() => {
    if (!title.trim() || !time || !people.length) { message.warning('请填写会议主题、会议时间和参会人员'); return; }
    void command.send('/api/lean/meetings', { title: title.trim(), content: content.trim(), meet_at: time, form, member_names: people.join('、'), place: place.trim(), related: related.trim() }).then(() => { message.success('已保存'); onClose(); }).catch((error) => message.error(showError(error)));
  }}>
    <div className="kgd-form">
      <Field label="会议主题" required><Input aria-label="会议主题" maxLength={255} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
      <Field label="会议内容"><Input.TextArea aria-label="会议内容" maxLength={1000} showCount value={content} onChange={(event) => setContent(event.target.value)} /></Field>
      <Field label="会议时间" required><Input aria-label="会议时间" type="datetime-local" value={time} onChange={(event) => setTime(event.target.value)} /></Field>
      <Field label="会议形式" required><Select aria-label="会议形式" value={form} onChange={setForm} options={['线下会议', '线上会议'].map((item) => ({ value: item, label: item }))} /></Field>
      <Field label="参会人员" required><Select aria-label="参会人员" mode="tags" optionFilterProp="label" placeholder="请选择" value={people} options={members.map((item) => ({ value: item.display_name || item.name, label: item.display_name || item.name }))} onChange={setPeople} /></Field>
      <Field label="会议地点"><Input aria-label="会议地点" maxLength={255} value={place} onChange={(event) => setPlace(event.target.value)} /></Field>
      <Field label="关联问题"><Input aria-label="关联问题" value={related} onChange={(event) => setRelated(event.target.value)} /></Field>
    </div>
  </Modal>;
}
