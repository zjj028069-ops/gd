import { useMemo, useState, type ReactNode } from 'react';
import { Button, Checkbox, Modal, Select } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import type { ListColumn, QueryField } from '../../ListFrame';
import { useCommand, useQueryState, showError } from '../../kit';
import { priorityText } from '../../wage';
import { qtyText } from '../../qty';

const timeChips = ['昨天', '今天', '本周', '本月', '本季度', '本年'];

type ReportPrefs = { output_metrics: string[]; wip_metrics: string[]; wip_process_ids: string[]; version?: number };
const defaultPrefs: ReportPrefs = { output_metrics: ['good_qty', 'defect_qty'], wip_metrics: ['plan_qty', 'good_qty', 'defect_qty', 'pending_qty'], wip_process_ids: [] };
const outputMetrics: { key: string; suffix: string; label: string }[] = [
  { key: 'good_qty', suffix: 'good', label: '良品数' },
  { key: 'defect_qty', suffix: 'defect', label: '不良品数' },
  { key: 'report_qty', suffix: 'report', label: '报工数' },
  { key: 'good_rate', suffix: 'rate', label: '良品率(%)' },
];
const wipMetrics: { key: string; label: string }[] = [
  { key: 'plan_qty', label: '计划数' },
  { key: 'good_qty', label: '良品数' },
  { key: 'pending_qty', label: '待生产数' },
  { key: 'defect_qty', label: '不良品数' },
];

function useReportPrefs() {
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const remote = useRemote<Partial<ReportPrefs>>('/api/report-prefs', revision, onExpired);
  const prefs: ReportPrefs = {
    output_metrics: remote.data?.output_metrics ?? defaultPrefs.output_metrics,
    wip_metrics: remote.data?.wip_metrics ?? defaultPrefs.wip_metrics,
    wip_process_ids: remote.data?.wip_process_ids ?? defaultPrefs.wip_process_ids,
    version: remote.data?.version,
  };
  async function save(patch: Partial<ReportPrefs>) {
    try {
      await command.send('/api/report-prefs', { ...patch, version: prefs.version }, 'PUT');
      return true;
    } catch (failure) {
      command.setError(showError(failure));
      return false;
    }
  }
  return { prefs, save, error: remote.error || command.error, busy: command.busy };
}

function MetricModal({ title, options, value, onCancel, onOk }: { title: string; options: { key: string; label: string }[]; value: string[]; onCancel: () => void; onOk: (keys: string[]) => void }) {
  const [draft, setDraft] = useState(value);
  return <Modal title={title} open onCancel={onCancel} onOk={() => onOk(options.map((item) => item.key).filter((key) => draft.includes(key)))} okText="确定" cancelText="取消" okButtonProps={{ disabled: !draft.length }}>
    <Checkbox.Group style={{ display: 'grid', gap: 8 }} value={draft} onChange={(keys) => setDraft(keys as string[])} options={options.map((item) => ({ value: item.key, label: item.label }))} />
  </Modal>;
}

function TimeChips({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactNode {
  return <div className="kgd-chips" style={{ marginBottom: 8 }}><b>{label}</b>{timeChips.map((item) => <button key={item} type="button" className={`kgd-chip ${value === item ? 'on' : ''}`} onClick={() => onChange(item)}>{item}</button>)}</div>;
}

export function OutputReportPage() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const report = useReportPrefs();
  const [chip, setChip] = useState('本月');
  const [granularity, setGranularity] = useState('month');
  const [dimension, setDimension] = useState('product');
  const [metricOpen, setMetricOpen] = useState(false);
  const path = useMemo(() => {
    const params = new URLSearchParams({ period: chip, granularity, dimension });
    Object.entries(list.query).forEach(([key, value]) => { if (value.trim()) params.set(key, value.trim()); });
    return `/api/progress/reports/output?${params}`;
  }, [chip, dimension, granularity, list.query]);
  const remote = useRemote<{ items: Record<string, string>[]; columns: string[]; totals: Record<string, string> }>(path, revision, onExpired);
  const rows = remote.data?.items ?? [];
  const dynamicCols = remote.data?.columns ?? [];
  const metrics = outputMetrics.filter((item) => report.prefs.output_metrics.includes(item.key));
  const dash = (value: unknown) => (value === null || value === undefined || value === '' ? '-' : String(value));
  const queryFields: QueryField[] = [
    { key: 'product', label: '商品' }, { key: 'product_code', label: '商品编号' },
    { key: 'spec', label: '商品规格' }, { key: 'source', label: '商品来源' },
    { key: 'category', label: '商品类别' }, { key: 'work_order_code', label: '加工单号' },
    { key: 'status', label: '工单状态' }, { key: 'process', label: '工序名' },
    { key: 'process_code', label: '工序编号' }, { key: 'operator', label: '生产人员' },
    { key: 'pricing_mode', label: '计价方式' }, { key: 'inspector', label: '质检人员' },
    { key: 'quality_status', label: '质检状态' },
  ];
  const cell = (row: Record<string, string>, key: string, suffix: string) => suffix === 'rate' ? (row[key] ?? '0') : qtyText(row[key] ?? '0');
  const columns: ListColumn<Record<string, string> & { id: string }>[] = [
    { key: 'product_name', title: '商品名', render: (row) => dash(row.product_name) },
    { key: 'product_code', title: '编号', render: (row) => dash(row.product_code) },
    { key: 'spec', title: '规格', render: (row) => dash(row.specification) },
    { key: 'unit', title: '单位', render: (row) => dash(row.unit_name) },
    { key: 'source', title: '商品来源', render: (row) => dash(row.source || '自产') },
    { key: 'image', title: '商品图片', render: (row) => dash(row.image_url || row.product_image) },
    { key: 'category', title: '商品类别', render: (row) => dash(row.category || '无') },
    { key: 'note', title: '商品备注', render: (row) => dash(row.note || '无') },
    { key: 'stock', title: '商品库存', render: (row) => dash(row.stock) },
    ...dynamicCols.flatMap((col) => metrics.map((metric) => ({ key: `${col}_${metric.suffix}`, title: `${col} ${metric.label}`, render: (row: Record<string, string>) => cell(row, `${col}_${metric.suffix}`, metric.suffix) }))),
    ...metrics.map((metric) => ({ key: `total_${metric.suffix}`, title: `合计 ${metric.label}`, render: (row: Record<string, string>) => cell(row, `total_${metric.suffix}`, metric.suffix) })),
  ];
  return <>
    <ListFrame
      pageKey="report-output"
      exportName="产量报表"
      columns={columns}
      rows={rows.map((row, index) => ({ ...row, id: row.id ?? String(index) }))}
      loading={remote.loading}
      error={remote.error || report.error}
      queryFields={queryFields}
      defaultQueryKeys={['product', 'product_code']}
      queryValue={list.draft}
      onQuery={list.onQuery}
      onSearch={list.onSearch}
      onClear={list.onClear}
      onApplyQuery={list.onApplyQuery}
      beforeTools={<>
        <TimeChips label="报工时间" value={chip} onChange={setChip} />
        <Select style={{ width: 120, marginRight: 8 }} value={granularity} onChange={setGranularity} options={[{ value: 'day', label: '每天' }, { value: 'month', label: '每月' }]} />
        <div className="kgd-chips"><b>汇总维度</b>{[
          ['product', '商品'], ['product_process', '商品 + 工序'], ['product_work_order', '商品 + 加工单'], ['product_work_order_process', '商品 + 加工单 + 工序'],
        ].map(([value, label]) => <button key={value} type="button" className={`kgd-chip ${dimension === value ? 'on' : ''}`} onClick={() => setDimension(value)}>{label}</button>)}</div>
      </>}
      toolbar={<>
        <Button onClick={() => setMetricOpen(true)}>指标配置</Button>
      </>}
      page={list.page}
      pageSize={list.pageSize}
      total={rows.length}
      onPage={list.onPage}
    />
    {metricOpen && <MetricModal title="指标配置" options={outputMetrics} value={report.prefs.output_metrics} onCancel={() => setMetricOpen(false)} onOk={(keys) => void report.save({ output_metrics: keys }).then((ok) => { if (ok) setMetricOpen(false); })} />}
  </>;
}

export function WipReportPage() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const report = useReportPrefs();
  const [chip, setChip] = useState('本年');
  const [metricOpen, setMetricOpen] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const processIds = report.prefs.wip_process_ids;
  const path = useMemo(() => {
    const params = new URLSearchParams({ period: chip });
    Object.entries(list.query).forEach(([key, value]) => { if (value.trim()) params.set(key, value.trim()); });
    if (processIds.length) params.set('process_ids', processIds.join(','));
    return `/api/progress/reports/wip?${params}`;
  }, [chip, list.query, processIds]);
  const remote = useRemote<{ items: Record<string, string>[]; summary: Record<string, string> }>(path, revision, onExpired);
  const processes = useRemote<{ items: { id: string; name: string; code?: string }[] }>(processOpen ? '/api/processes' : null, revision, onExpired);
  const rows = remote.data?.items ?? [];
  const summary = remote.data?.summary;
  const shown = wipMetrics.filter((item) => report.prefs.wip_metrics.includes(item.key));
  const dash = (value: unknown) => (value === null || value === undefined || value === '' ? '-' : String(value));
  const columns: ListColumn<Record<string, string> & { id: string }>[] = [
    { key: 'code', title: '加工单号', render: (row) => dash(row.code || row.work_order_code) },
    { key: 'status', title: '工单状态', render: (row) => dash(({ not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' } as Record<string, string>)[row.execution] ?? row.status_text) },
    { key: 'product', title: '商品名', render: (row) => dash(row.product_name) },
    { key: 'product_code', title: '编号', render: (row) => dash(row.product_code) },
    { key: 'spec', title: '规格', render: (row) => dash(row.specification || '无') },
    { key: 'priority', title: '优先级', render: (row) => dash(row.priority_text || priorityText(row.priority) || '无') },
    { key: 'image', title: '商品图片', render: (row) => dash(row.image_url || row.product_image) },
    ...shown.map((metric) => ({ key: metric.key, title: metric.label, render: (row: Record<string, string>) => qtyText(row[metric.key]) })),
  ];
  return <>
    <ListFrame
      pageKey="report-wip"
      exportName="在制品报表"
      columns={columns}
      rows={rows.map((row, index) => ({ ...row, id: row.id ?? String(index) }))}
      loading={remote.loading}
      error={remote.error || report.error}
      queryFields={[
        { key: 'product', label: '商品' }, { key: 'product_code', label: '商品编号' },
        { key: 'spec', label: '商品规格' }, { key: 'source', label: '商品来源' },
        { key: 'category', label: '商品类别' }, { key: 'work_order_code', label: '加工单号' },
        { key: 'creator', label: '创建人' }, { key: 'status', label: '工单状态' },
        { key: 'priority', label: '优先级' },
      ]}
      defaultQueryKeys={['product', 'product_code']}
      queryValue={list.draft}
      onQuery={list.onQuery}
      onSearch={list.onSearch}
      onClear={list.onClear}
      onApplyQuery={list.onApplyQuery}
      beforeTools={<TimeChips label="创建时间" value={chip} onChange={setChip} />}
      toolbar={<>
        <Button type="primary" style={{ background: '#4184F4' }} onClick={() => setProcessOpen(true)}>工序配置{processIds.length ? `（${processIds.length}）` : ''}</Button>
        <span className="kgd-summary">{['plan_qty', 'good_qty', 'defect_qty', 'pending_qty'].map((key) => {
          const label = ({ plan_qty: '计划数', good_qty: '良品数', defect_qty: '不良品数', pending_qty: '待生产数' } as Record<string, string>)[key];
          return `【${label}】${qtyText(summary?.[key])}`;
        }).join('')}</span>
        <Button onClick={() => setMetricOpen(true)}>指标配置</Button>
      </>}
      page={list.page}
      pageSize={list.pageSize}
      total={rows.length}
      onPage={list.onPage}
    />
    {metricOpen && <MetricModal title="指标配置" options={wipMetrics} value={report.prefs.wip_metrics} onCancel={() => setMetricOpen(false)} onOk={(keys) => void report.save({ wip_metrics: keys }).then((ok) => { if (ok) setMetricOpen(false); })} />}
    {processOpen && <ProcessConfigModal options={processes.data?.items ?? []} value={processIds} onCancel={() => setProcessOpen(false)} onOk={(ids) => void report.save({ wip_process_ids: ids }).then((ok) => { if (ok) setProcessOpen(false); })} />}
  </>;
}

function ProcessConfigModal({ options, value, onCancel, onOk }: { options: { id: string; name: string; code?: string }[]; value: string[]; onCancel: () => void; onOk: (ids: string[]) => void }) {
  const [draft, setDraft] = useState(value);
  return <Modal title="工序配置" open onCancel={onCancel} onOk={() => onOk(draft)} okText="确定" cancelText="取消">
    <p className="kgd-muted">选择需要统计在制品的工序，不选则统计全部工序。</p>
    <Select mode="multiple" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="请选择工序" value={draft} onChange={setDraft} options={options.map((item) => ({ value: item.id, label: item.code ? `${item.code} ${item.name}` : item.name }))} />
  </Modal>;
}

export function ClockReportPage() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const path = useMemo(() => {
    const params = new URLSearchParams({ page: String(list.page), page_size: String(list.pageSize) });
    Object.entries(list.query).forEach(([key, value]) => { if (value.trim()) params.set(key, value.trim()); });
    return `/api/progress/reports/clock?${params}`;
  }, [list.page, list.pageSize, list.query]);
  const remote = useRemote<{ items: Record<string, string>[]; total?: number; total_duration?: string }>(path, revision, onExpired);
  const rows = remote.data?.items ?? [];
  const titles: [string, string][] = [
    ['member_name', '姓名'], ['department_name', '部门'], ['product_name', '商品名'], ['product_code', '商品编号'], ['specification', '商品规格'], ['work_order_code', '加工单号'],
    ['project_code', '项目编号'], ['project_name', '项目名称'], ['plan_code', '计划编号'], ['plan_name', '计划名称'], ['process_name', '工序名'], ['clock_text', '打卡时间'],
    ['next_clock_text', '下次打卡时间'], ['clock_type', '打卡类型'], ['next_clock_type', '下次打卡类型'], ['range_type', '区间类型'], ['duration_text', '区间时长'],
  ];
  const columns: ListColumn<Record<string, string> & { id: string }>[] = titles.map(([key, title]) => ({ key, title, render: (row) => row[key] || '-' }));
  return <ListFrame
    pageKey="report-clock"
    exportName="工序打卡计时"
    columns={columns}
    rows={rows.map((row, index) => ({ ...row, id: row.id ?? String(index) }))}
    loading={remote.loading}
    error={remote.error}
    queryFields={[
      { key: 'member', label: '姓名' }, { key: 'department', label: '部门' },
      { key: 'product', label: '商品名' }, { key: 'product_code', label: '商品编号' },
      { key: 'spec', label: '商品规格' }, { key: 'work_order_code', label: '加工单号' },
      { key: 'project_code', label: '项目编号' }, { key: 'project_name', label: '项目名称' },
      { key: 'plan_code', label: '计划编号' }, { key: 'plan_name', label: '计划名称' },
      { key: 'process', label: '工序名' },
      { key: 'clock_from', label: '打卡时间起', kind: 'date' }, { key: 'clock_to', label: '打卡时间止', kind: 'date' },
      { key: 'clock_type', label: '打卡类型' },
    ]}
    defaultQueryKeys={['member', 'department']}
    queryValue={list.draft}
    onQuery={list.onQuery}
    onSearch={list.onSearch}
    onClear={list.onClear}
    onApplyQuery={list.onApplyQuery}
    toolbar={<span className="kgd-summary">【时长汇总】{remote.data?.total_duration ?? '0'}</span>}
    page={list.page}
    pageSize={list.pageSize}
    total={Number(remote.data?.total ?? rows.length)}
    onPage={list.onPage}
    clientPaging={false}
  />;
}
