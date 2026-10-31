import { useState } from 'react';
import { Button, Form, Input, Modal, Select, Switch, Table, Tabs, TimePicker } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useRemote } from '../../../../masterTools';
import { EChart } from '../../progress/echarts';
import { exportRows, MemberPick, useR10 } from '../shared';
import type { Row } from '../shared';

type BriefKind = 'sales' | 'production';
type Option = { value: string; label: string };
type Source = { key: string; label: string; dimensions: Option[]; metrics: Option[] };
type PushItem = { kind: string; title: string; enabled: boolean; time: string; receiver_ids: string[] };
type RunResult = { range?: { from: string; to: string }; columns?: string[]; items?: { label: string; value: string }[]; dimension_text?: string; metric_text?: string; source_text?: string };
type ListPayload = { items: Row[]; total?: number; sources?: Source[]; periods?: string[] };

const briefs: { key: BriefKind; title: string; desc: string }[] = [
  { key: 'sales', title: '销售简报', desc: '多维度展示销售统计数据。销售人员业绩、客户新增、跟单情况等数据一目了然' },
  { key: 'production', title: '生产简报', desc: '多角度展示车间生产情况。加工单状态、工人生产效率、工序不良品等情况直观展示' },
];
const fallbackPeriods = ['今天', '昨天', '本周', '本月', '本季度', '本年'];
const cardStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', minHeight: 120, padding: 16, border: '1px solid #e5e6eb', borderRadius: 6, background: '#fff', cursor: 'pointer' };

function barOption(items: { label: string; value: string }[], name: string) {
  return { tooltip: { trigger: 'axis' }, grid: { left: 48, right: 16, top: 24, bottom: 48 }, xAxis: { type: 'category', data: items.map((item) => item.label) }, yAxis: { type: 'value' }, series: [{ type: 'bar', name, data: items.map((item) => Number(item.value)), itemStyle: { color: '#4184F4' } }] };
}

export function SmartReportPage() {
  const r10 = useR10();
  const [tab, setTab] = useState<'pc' | 'mini' | 'push'>('pc');
  const [view, setView] = useState<{ kind: 'brief'; key: BriefKind } | { kind: 'custom'; row: Row } | null>(null);
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const reports = useRemote<ListPayload>('/api/smart-reports', r10.revision, r10.onExpired);
  const sources = reports.data?.sources ?? [];
  const periods = reports.data?.periods ?? fallbackPeriods;
  const modal = edit && <CustomModal row={edit === 'new' ? null : edit} sources={sources} periods={periods} onClose={() => setEdit(null)} />;
  if (view?.kind === 'brief') return <BriefView kind={view.key} periods={periods} onBack={() => setView(null)} />;
  if (view?.kind === 'custom') return <>{<CustomView row={view.row} periods={periods} onBack={() => setView(null)} onEdit={() => setEdit(view.row)} />}{modal}</>;
  if (tab === 'push') return <PushSettings onBack={() => setTab('pc')} />;
  const custom = reports.data?.items ?? [];
  const cardGrid = (includeCustom: boolean) => <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
    {briefs.map((item) => <button type="button" key={item.key} onClick={() => setView({ kind: 'brief', key: item.key })} style={cardStyle}>
      <b style={{ fontSize: 15 }}>{item.title}</b>
      <span className="kgd-muted" style={{ marginTop: 8, lineHeight: 1.6 }}>{item.desc}</span>
    </button>)}
    {includeCustom && custom.map((item) => <div key={item.id} style={cardStyle} onClick={() => setView({ kind: 'custom', row: item })}>
      <b style={{ fontSize: 15 }}>{item.name}</b>
      <span className="kgd-muted" style={{ marginTop: 8 }}>{item.source_text} · 按{item.dimension_text}统计{item.metric_text} · {item.period}</span>
      <span style={{ marginTop: 'auto', display: 'flex', gap: 12 }} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="kgd-link" onClick={() => setEdit(item)}>修改</button>
        <button type="button" className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除智能报表', () => r10.act(`/api/smart-reports/${item.id}`, {}, 'DELETE', '已删除'))}>删除</button>
      </span>
    </div>)}
    {includeCustom && <button type="button" data-testid="smart-custom-card" onClick={() => setEdit('new')} style={{ ...cardStyle, border: '1px dashed #c9cdd4', alignItems: 'center', justifyContent: 'center', color: '#4184F4' }}><PlusOutlined /> <span style={{ marginTop: 8 }}>自定义智能报表</span></button>}
  </div>;
  return <div className="kgd-card">
    <Tabs activeKey={tab} onChange={(key) => setTab(key as 'pc' | 'mini' | 'push')} items={[
      { key: 'pc', label: '电脑端报表', children: <>{reports.error && <div className="kgd-banner">{reports.error}</div>}{cardGrid(true)}</> },
      { key: 'mini', label: '小程序报表', children: cardGrid(true) },
      { key: 'push', label: '推送设置', children: null },
    ]} />
    {modal}
  </div>;
}

function BriefView({ kind, periods, onBack }: { kind: BriefKind; periods: string[]; onBack: () => void }) {
  const r10 = useR10();
  const [period, setPeriod] = useState('本月');
  const remote = useRemote<{ title?: string; range?: { from: string; to: string }; metrics?: { key: string; label: string; value: string }[]; chart?: RunResult }>(`/api/smart-reports/brief/${kind}?period=${encodeURIComponent(period)}`, r10.revision, r10.onExpired);
  const metrics = remote.data?.metrics ?? [];
  const chart = remote.data?.chart;
  const title = briefs.find((item) => item.key === kind)?.title ?? '';
  return <div className="kgd-card">
    <div className="kgd-toolbar"><b style={{ fontSize: 16 }}>{title}</b>{remote.data?.range && <span className="kgd-muted">{remote.data.range.from} ~ {remote.data.range.to}</span>}<span style={{ flex: 1 }} />
      <Select style={{ width: 120 }} value={period} options={periods.map((value) => ({ value, label: value }))} onChange={setPeriod} />
      <Button onClick={onBack}>返回</Button>
    </div>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
      {metrics.map((item) => <div key={item.key} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 16 }}>
        <div className="kgd-muted">{item.label}</div>
        <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6 }}>{item.value}</div>
      </div>)}
      {!metrics.length && !remote.loading && <span className="kgd-muted">暂无数据</span>}
    </div>
    {chart && <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 12, marginTop: 16 }}>
      <b>按{chart.dimension_text}统计{chart.metric_text}</b>
      {(chart.items ?? []).length ? <EChart style={{ height: 300 }} option={barOption(chart.items ?? [], chart.metric_text ?? '')} /> : <p className="kgd-muted">暂无数据</p>}
    </div>}
  </div>;
}

function CustomView({ row, periods, onBack, onEdit }: { row: Row; periods: string[]; onBack: () => void; onEdit: () => void }) {
  const r10 = useR10();
  const [period, setPeriod] = useState<string>(String(row.period ?? '本月'));
  const remote = useRemote<RunResult>(`/api/smart-reports/${row.id}/run?period=${encodeURIComponent(period)}`, r10.revision, r10.onExpired);
  const items = remote.data?.items ?? [];
  const dimension = remote.data?.dimension_text ?? String(row.dimension_text ?? '维度');
  const metric = remote.data?.metric_text ?? String(row.metric_text ?? '指标');
  return <div className="kgd-card">
    <div className="kgd-toolbar"><b style={{ fontSize: 16 }}>{row.name}</b><span className="kgd-muted">{row.source_text}{remote.data?.range ? ` · ${remote.data.range.from} ~ ${remote.data.range.to}` : ''}</span><span style={{ flex: 1 }} />
      <Select style={{ width: 120 }} value={period} options={periods.map((value) => ({ value, label: value }))} onChange={setPeriod} />
      <Button onClick={() => exportRows(`${row.name}.csv`, [{ title: dimension, text: (item: { label: string }) => item.label }, { title: metric, text: (item: { value: string }) => item.value }], items)}>导出</Button>
      <Button onClick={onEdit}>修改</Button>
      <Button onClick={onBack}>返回</Button>
    </div>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    {items.length > 0 && <EChart style={{ height: 320 }} option={barOption(items, metric)} />}
    <Table size="small" rowKey="label" loading={remote.loading} dataSource={items} pagination={false} locale={{ emptyText: '暂无数据' }} columns={[
      { title: dimension, dataIndex: 'label' },
      { title: metric, dataIndex: 'value' },
    ]} />
  </div>;
}

function CustomModal({ row, sources, periods, onClose }: { row: Row | null; sources: Source[]; periods: string[]; onClose: () => void }) {
  const r10 = useR10();
  const [name, setName] = useState<string>(row?.name ?? '');
  const [source, setSource] = useState<string>(row?.source ?? sources[0]?.key ?? 'work_orders');
  const [dimension, setDimension] = useState<string>(row?.dimension ?? '');
  const [metric, setMetric] = useState<string>(row?.metric ?? '');
  const [period, setPeriod] = useState<string>(row?.period ?? '本月');
  const [preview, setPreview] = useState<RunResult | null>(null);
  const meta = sources.find((item) => item.key === source);
  const body = () => ({ name: name.trim(), source, dimension, metric, period });
  function check() {
    if (!name.trim()) { r10.message.warning('请填写报表名称'); return false; }
    if (!dimension) { r10.message.warning('请选择统计维度'); return false; }
    if (!metric) { r10.message.warning('请选择统计指标'); return false; }
    return true;
  }
  async function save() {
    if (!check()) return;
    const result = await r10.act(row ? `/api/smart-reports/${row.id}` : '/api/smart-reports', { ...body(), ...(row ? { version: row.version } : {}) }, row ? 'PUT' : 'POST');
    if (result) onClose();
  }
  async function runPreview() {
    if (!check()) return;
    const result = await r10.act<RunResult>('/api/smart-reports/preview', body(), 'POST', false);
    if (result) setPreview(result);
  }
  return <Modal title={row ? '修改智能报表' : '自定义智能报表'} open onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消" confirmLoading={r10.busy} destroyOnHidden width={640}
    footer={(_, { OkBtn, CancelBtn }) => <><Button onClick={() => void runPreview()}>预览</Button><CancelBtn /><OkBtn /></>}>
    <Form layout="vertical">
      <Form.Item label="报表名称" required><Input maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="请输入报表名称" /></Form.Item>
      <Form.Item label="数据来源" required><Select value={source} options={sources.map((item) => ({ value: item.key, label: item.label }))} onChange={(value) => { setSource(value); setDimension(''); setMetric(''); setPreview(null); }} /></Form.Item>
      <Form.Item label="统计维度" required><Select placeholder="请选择" value={dimension || undefined} options={meta?.dimensions ?? []} onChange={(value) => { setDimension(value); setPreview(null); }} /></Form.Item>
      <Form.Item label="统计指标" required><Select placeholder="请选择" value={metric || undefined} options={meta?.metrics ?? []} onChange={(value) => { setMetric(value); setPreview(null); }} /></Form.Item>
      <Form.Item label="统计时间" required><Select value={period} options={periods.map((value) => ({ value, label: value }))} onChange={(value) => { setPeriod(value); setPreview(null); }} /></Form.Item>
    </Form>
    {preview && <>
      {(preview.items ?? []).length ? <EChart style={{ height: 220 }} option={barOption(preview.items ?? [], preview.metric_text ?? '')} /> : <p className="kgd-muted">预览结果暂无数据</p>}
    </>}
  </Modal>;
}

function PushSettings({ onBack }: { onBack: () => void }) {
  const r10 = useR10();
  const remote = useRemote<{ items?: PushItem[]; version?: number; note?: string }>('/api/smart-reports/push-settings', r10.revision, r10.onExpired);
  const [draft, setDraft] = useState<PushItem[] | null>(null);
  const items: PushItem[] = draft ?? remote.data?.items ?? [];
  const patch = (kind: string, next: Partial<PushItem>) => setDraft(items.map((item) => item.kind === kind ? { ...item, ...next } : item));
  async function save() {
    const result = await r10.act('/api/smart-reports/push-settings', { items: items.map(({ kind, enabled, time, receiver_ids }) => ({ kind, enabled, time, receiver_ids })), version: remote.data?.version }, 'PUT');
    if (result) setDraft(null);
  }
  return <div className="kgd-card">
    <div className="kgd-toolbar"><b style={{ fontSize: 16 }}>推送设置</b>{remote.data?.note && <span className="kgd-muted">{remote.data.note}</span>}<span style={{ flex: 1 }} /><Button onClick={onBack}>返回</Button><Button type="primary" loading={r10.busy} onClick={() => void save()}>保存</Button></div>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <Table size="small" rowKey="kind" loading={remote.loading} pagination={false} dataSource={items} columns={[
      { title: '报表', dataIndex: 'title' },
      { title: '是否推送', width: 100, render: (_, item) => <Switch checked={item.enabled} onChange={(value) => patch(item.kind, { enabled: value })} /> },
      { title: '推送时间', width: 140, render: (_, item) => <TimePicker format="HH:mm" value={dayjs(`2000-01-01 ${item.time || '09:00'}`)} onChange={(value) => patch(item.kind, { time: value ? value.format('HH:mm') : '09:00' })} allowClear={false} /> },
      { title: '接收人', render: (_, item) => <MemberPick multiple value={item.receiver_ids} onChange={(value: string[]) => patch(item.kind, { receiver_ids: value })} placeholder="请选择接收人" /> },
    ]} />
  </div>;
}
