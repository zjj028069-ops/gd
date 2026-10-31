import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Select, Table } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { durationText, useQueryState, beijingTime } from '../../kit';
import { priorityText } from '../../wage';
import { EChart } from './echarts';
import './progress.css';

type ScheduleRow = {
  id: string;
  code: string;
  planned_start: string | null;
  planned_end: string | null;
  priority: string;
  product_name: string;
  product_code: string;
  specification: string;
  current_process: string;
  elapsed_seconds: number;
  task_progress_pct: number;
  execution: string;
};

type SchedulePayload = {
  items: ScheduleRow[];
  total: number;
  cards: Record<string, number>;
  charts: {
    status_pie: { name: string; value: number }[];
    bar: { plan_qty: string; output_qty: string; received_qty: string };
    quality_pie: { good_rate: number; defect_rate: number };
  };
  range: { start: string; end: string };
};

const periodOptions = [
  { value: 'prev_month', label: '上月' },
  { value: 'month', label: '本月' },
  { value: 'next_month', label: '下月' },
  { value: 'quarter', label: '本季度' },
  { value: 'year', label: '本年' },
];

const scaleOptions = ['日', '周', '月', '季', '年'];

export function ProductionSchedulingPage() {
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const [period, setPeriod] = useState('month');
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState({ period: 'month', keyword: '' });
  const [queryTick, setQueryTick] = useState(0);
  const [scale, setScale] = useState('日');
  const [advanced, setAdvanced] = useState(false);
  const path = useMemo(() => {
    const params = new URLSearchParams();
    params.set('period', applied.period);
    if (applied.keyword.trim()) params.set('keyword', applied.keyword.trim());
    params.set('page', String(list.page));
    params.set('page_size', '10');
    Object.entries(list.query).forEach(([key, value]) => { if (value.trim()) params.set(key, value.trim()); });
    return `/api/progress/scheduling?${params}`;
  }, [applied.keyword, applied.period, list.page, list.query]);
  const remote = useRemote<SchedulePayload>(path, revision + queryTick, onExpired);
  function runQuery() {
    setApplied({ period, keyword: keyword.trim() });
    list.onSearch();
    setQueryTick((tick) => tick + 1);
  }
  const rows = remote.data?.items ?? [];
  const cards = remote.data?.cards ?? {};

  const statusPie = remote.data?.charts.status_pie ?? [];
  const bar = remote.data?.charts.bar;
  const quality = remote.data?.charts.quality_pie;

  return (
    <div className="kgd-card">
      <div className="kgd-views"><button className="kgd-view on">全部视图</button></div>
      <div className="kgd-query">
        <div className="kgd-query-main">
          <div className="kgd-chips"><b>计划工期</b>{periodOptions.map((item) => <button key={item.value} type="button" className={`kgd-chip ${period === item.value ? 'on' : ''}`} onClick={() => setPeriod(item.value)}>{item.label}</button>)}</div>
          <Input style={{ width: 360 }} readOnly value={remote.data ? `${remote.data.range.start} ~ ${remote.data.range.end}` : ''} />
          <Input style={{ width: 220 }} placeholder="输入关键字查询" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
        </div>
        <div className="kgd-toolbar" style={{ margin: 0 }}>
          <Button type="primary" aria-label="查询" onClick={runQuery}>查询</Button>
          <Button onClick={() => { setKeyword(''); setApplied((current) => ({ ...current, keyword: '' })); list.onClear(); setQueryTick((tick) => tick + 1); }}>清空</Button>
          <Button onClick={() => setAdvanced((value) => !value)}>{advanced ? '收起' : '高级查询'}</Button>
        </div>
      </div>
      {advanced && <div className="kgd-query-fields" style={{ marginBottom: 12 }}>
        <Input placeholder="加工单号" value={list.draft.code ?? ''} onChange={(event) => list.onQuery('code', event.target.value)} />
        <Input placeholder="商品" value={list.draft.product ?? ''} onChange={(event) => list.onQuery('product', event.target.value)} />
      </div>}
      <div className="kgd-schedule-cards">
        {[['not_started', '未开始'], ['running', '生产中'], ['completed', '已完成'], ['overdue', '已逾期'], ['paused', '已暂停'], ['cancelled', '已取消']].map(([key, label]) => (
          <div key={key} className="kgd-schedule-card"><span>{label}</span><b>{cards[key] ?? 0}</b></div>
        ))}
      </div>
      <div className="kgd-schedule-charts">
        <EChart className="kgd-schedule-chart" option={{
          tooltip: { trigger: 'item' },
          legend: { bottom: 0, type: 'scroll' },
          series: [{ type: 'pie', radius: ['42%', '62%'], data: statusPie.length ? statusPie : [{ name: '暂无', value: 1 }] }],
        }} />
        <EChart className="kgd-schedule-chart" option={{
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: ['计划数', '实际生产数', '成品入库数'] },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [Number(bar?.plan_qty ?? 0), Number(bar?.output_qty ?? 0), Number(bar?.received_qty ?? 0)], itemStyle: { color: '#fa8c16' }, label: { show: true, position: 'top' } }],
        }} />
        <EChart className="kgd-schedule-chart" option={{
          tooltip: { trigger: 'item' },
          series: [{ type: 'pie', radius: '60%', data: [
            { name: '良品率', value: quality?.good_rate ?? 0 },
            { name: '不良品率', value: quality?.defect_rate ?? 0 },
          ] }],
        }} />
      </div>
      <div className="kgd-gantt-tools">
        <span className="spacer" />
        <Select value={scale} style={{ width: 88 }} onChange={setScale} options={scaleOptions.map((item) => ({ value: item, label: item }))} />
        <Button onClick={() => document.documentElement.requestFullscreen?.()}>全屏</Button>
      </div>
      <div className="kgd-gantt-wrap">
        <div className="kgd-gantt-left">
          <Table size="small" rowKey="id" pagination={false} dataSource={rows} scroll={{ x: 'max-content' }} columns={[
            { title: '序号', width: 48, render: (_, __, index) => (list.page - 1) * 10 + index + 1 },
            { title: '加工单号', render: (_, row) => <button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.id}`)}>{row.code}</button> },
            { title: '计划开始', render: (_, row) => beijingTime(row.planned_start, '') ?? '' },
            { title: '计划结束', render: (_, row) => beijingTime(row.planned_end, '') ?? '' },
            { title: '优先级', render: (_, row) => priorityText(row.priority) },
            { title: '商品名', dataIndex: 'product_name' },
            { title: '商品编号', dataIndex: 'product_code' },
            { title: '商品规格', dataIndex: 'specification' },
            { title: '当前工序', dataIndex: 'current_process' },
            { title: '已开工时间', render: (_, row) => durationText(row.elapsed_seconds) || '0' },
          ]} />
        </div>
        <div className="kgd-gantt-right">
          {rows.map((row) => (
            <div key={row.id} style={{ position: 'relative', height: 48, borderBottom: '1px solid #f0f0f0' }}>
              <div className="kgd-gantt-bar" style={{ left: '8%', width: '60%' }}>{row.task_progress_pct}%</div>
              <span style={{ position: 'absolute', right: 8, top: 14 }}>&gt;</span>
            </div>
          ))}
        </div>
      </div>
      <div className="kgd-foot"><span /><span>共 {remote.data?.total ?? 0} 条数据，10 条/页</span></div>
    </div>
  );
}
