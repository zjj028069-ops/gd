import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Popover, Select, Table } from 'antd';
import { DownOutlined, FilterOutlined, SearchOutlined, UpOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { EChartsCoreOption } from 'echarts/core';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { downloadCsv } from '../../wage';
import { EChart } from '../progress/echarts';

type Interval = '每小时' | '每天' | '每周' | '每月';
type ChartKind = 'line' | 'area' | 'percent';
type Bucket = { key: string; label: string };
type Series = { id: string; name: string; points: number[]; qty: string; rate: string };
type TrendPayload = {
  from: string;
  to: string;
  interval: Interval;
  buckets: Bucket[];
  series: Series[];
  summary?: string;
  total?: string;
};

const PERIODS = ['昨天', '今天', '本周', '本月', '本季度', '本年'] as const;
const INTERVALS: Interval[] = ['每小时', '每天', '每周', '每月'];
const CHARTS: { key: ChartKind; label: string }[] = [
  { key: 'line', label: '折线图' },
  { key: 'area', label: '面积图' },
  { key: 'percent', label: '百分比面积图' },
];
const COLORS = ['#3AA0FF', '#F04864', '#2FC25B', '#F6BD16', '#8543E0', '#13C2C2', '#FA8C16', '#A0D911'];
const emptyBuckets: Bucket[] = [];
const emptySeries: Series[] = [];

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

function intervalFor(period: string): Interval {
  if (period === '今天' || period === '昨天') return '每小时';
  if (period === '本年') return '每月';
  return '每天';
}

function qtyText(value: number) {
  if (!Number.isFinite(value) || value === 0) return '';
  return String(Math.round(value * 1e6) / 1e6);
}

function chartOption(buckets: Bucket[], series: Series[], kind: ChartKind): EChartsCoreOption {
  const percent = kind === 'percent';
  const sums = buckets.map((_, index) => series.reduce((sum, item) => sum + (Number(item.points[index]) || 0), 0));
  const hasData = series.some((item) => item.points.some((value) => value > 0));
  return {
    animation: false,
    color: COLORS,
    tooltip: { trigger: 'axis' },
    legend: series.length ? { type: 'scroll', bottom: 0 } : { show: false },
    grid: { left: 12, right: 18, top: 24, bottom: series.length ? 42 : 16, containLabel: true },
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
      min: 0,
      max: percent ? 100 : hasData ? undefined : 20,
      interval: percent ? 20 : hasData ? undefined : 5,
      axisLabel: { color: '#8c8c8c', formatter: percent ? '{value}%' : '{value}' },
      splitLine: { lineStyle: { color: '#e8e8e8' } },
    },
    series: series.map((item) => ({
      name: item.name,
      type: 'line',
      smooth: false,
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 6,
      stack: percent ? 'percent' : undefined,
      areaStyle: kind === 'line' ? undefined : { opacity: percent ? 0.85 : 0.22 },
      data: item.points.map((value, index) => {
        if (!percent) return value;
        return sums[index] ? Math.round((value / sums[index]) * 10000) / 100 : 0;
      }),
    })),
  };
}

export function DefectTrendPage() {
  const { revision, onExpired } = useKgd();
  const initial = periodRange('本月');
  const [period, setPeriod] = useState('本月');
  const [draftFrom, setDraftFrom] = useState(initial.from);
  const [draftTo, setDraftTo] = useState(initial.to);
  const [draftInterval, setDraftInterval] = useState<Interval>('每天');
  const [draftItems, setDraftItems] = useState<string[]>([]);
  const [applied, setApplied] = useState({ from: initial.from, to: initial.to, interval: '每天' as Interval, itemIds: [] as string[] });
  const [chart, setChart] = useState<ChartKind>('line');
  const [collapsed, setCollapsed] = useState(false);
  const defects = useRemote<{ items: { id: string; name: string }[] }>('/api/quality/defects', revision, onExpired);
  const query = new URLSearchParams({ from: applied.from, to: applied.to, interval: applied.interval });
  if (applied.itemIds.length) query.set('defect_ids', applied.itemIds.join(','));
  const remote = useRemote<TrendPayload>(`/api/quality/reports/trend?${query}`, revision, onExpired);
  const buckets = remote.data?.buckets ?? emptyBuckets;
  const series = remote.data?.series ?? emptySeries
  const option = useMemo(() => chartOption(buckets, series, chart), [buckets, series, chart]);
  const picked = (defects.data?.items ?? []).filter((item) => draftItems.includes(item.id));

  function applyPeriod(name: string) {
    const range = periodRange(name);
    const interval = intervalFor(name);
    setPeriod(name);
    setDraftFrom(range.from);
    setDraftTo(range.to);
    setDraftInterval(interval);
    setApplied((current) => ({ ...current, from: range.from, to: range.to, interval }));
  }

  function applyQuery() {
    let from = draftFrom;
    let to = draftTo;
    if (from && to && from > to) { const swap = from; from = to; to = swap; }
    setDraftFrom(from);
    setDraftTo(to);
    const matched = PERIODS.find((name) => { const range = periodRange(name); return range.from === from && range.to === to; });
    setPeriod(matched && intervalFor(matched) === draftInterval ? matched : '');
    setApplied({ from, to, interval: draftInterval, itemIds: [...draftItems] });
  }

  function exportDetail() {
    const headers = ['不良品项', '占比', '合计', ...buckets.map((bucket) => bucket.key)];
    const rows = series.map((item) => [item.name, item.rate, item.qty, ...item.points.map((value) => qtyText(value))]);
    downloadCsv('不良品趋势分析.csv', headers, rows);
  }

  return <div className="kgd-trend">
    <div className="kgd-trend-filter">
      <div className="kgd-trend-line">
        <span className="kgd-trend-label">报工时间</span>
        {PERIODS.map((name) => <button key={name} type="button" className={`kgd-chip ${period === name ? 'on' : ''}`} onClick={() => applyPeriod(name)}>{name}</button>)}
        <DatePicker aria-label="开始日期" allowClear={false} value={draftFrom ? dayjs(draftFrom) : null} onChange={(value) => { setDraftFrom(value ? value.format('YYYY-MM-DD') : ''); setPeriod(''); }} />
        <span className="kgd-trend-sep">—</span>
        <DatePicker aria-label="结束日期" allowClear={false} value={draftTo ? dayjs(draftTo) : null} onChange={(value) => { setDraftTo(value ? value.format('YYYY-MM-DD') : ''); setPeriod(''); }} />
        <Select aria-label="时间间隔" value={draftInterval} style={{ width: 96 }} options={INTERVALS.map((item) => ({ value: item, label: item }))} onChange={(value) => { setDraftInterval(value); setPeriod(''); }} />
        <Button type="primary" autoInsertSpace={false} icon={<SearchOutlined aria-hidden />} onClick={applyQuery}>查询</Button>
      </div>
      <div className="kgd-trend-line">
        <span className="kgd-trend-label">不良品项</span>
        <Popover trigger="click" placement="bottomLeft" content={<div className="kgd-trend-picks">
          {(defects.data?.items ?? []).map((item) => <Checkbox key={item.id} checked={draftItems.includes(item.id)} onChange={(event) => setDraftItems((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))}>{item.name}</Checkbox>)}
          {!(defects.data?.items ?? []).length && <span className="kgd-muted">{defects.loading ? '加载中' : '暂无不良品项'}</span>}
        </div>}>
          <button type="button" className="kgd-trend-pick" aria-label="选择不良品项"><FilterOutlined /></button>
        </Popover>
        {picked.length > 0 && <span>{picked.map((item) => item.name).join('、')}</span>}
      </div>
    </div>
    {remote.error && <Alert style={{ marginBottom: 10 }} type="error" showIcon message={remote.error} />}
    <section className="kgd-trend-card" aria-label="不良品趋势分析">
      <header className="kgd-trend-card-hd">
        <h3>不良品趋势分析</h3>
        <button type="button" className="kgd-trend-fold" aria-label={collapsed ? '展开图表' : '收起图表'} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <DownOutlined /> : <UpOutlined />}</button>
      </header>
      {!collapsed && <>
        <div className="kgd-trend-switch" role="group" aria-label="图表类型">
          {CHARTS.map((item) => <button key={item.key} type="button" className={chart === item.key ? 'on' : ''} aria-pressed={chart === item.key} onClick={() => setChart(item.key)}>{item.label}</button>)}
        </div>
        <div className="kgd-trend-plot" data-chart={chart}>
          <EChart option={option} style={{ height: '100%', minHeight: 320 }} />
        </div>
      </>}
    </section>
    <section className="kgd-trend-block">
      <h3>智能分析报告</h3>
      <p>{remote.data?.summary || (remote.loading ? '正在统计…' : '当前周期没有不良品')}</p>
    </section>
    <section className="kgd-trend-block">
      <div className="kgd-trend-block-hd">
        <h3>数据明细</h3>
        <Button autoInsertSpace={false} onClick={exportDetail}>导出</Button>
      </div>
      <Table
        size="small"
        pagination={false}
        rowKey={(row) => row.id || row.name}
        dataSource={series}
        locale={{ emptyText: '当前周期没有不良品' }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '不良品项', dataIndex: 'name', fixed: 'left', width: 120 },
          { title: '占比', dataIndex: 'rate', width: 96 },
          { title: '合计', dataIndex: 'qty', width: 80 },
          ...buckets.map((bucket, index) => ({
            title: bucket.key,
            key: bucket.key,
            width: 116,
            render: (_value: unknown, row: Series) => qtyText(row.points[index] ?? 0),
          })),
        ]}
      />
    </section>
  </div>;
}
