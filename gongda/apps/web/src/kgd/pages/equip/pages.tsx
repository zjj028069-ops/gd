import { useState, type ReactNode } from 'react';
import { App, Button, Input, Modal, Select, Switch } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import type { ListColumn } from '../../ListFrame';
import { showError, useCommand, useQueryState } from '../../kit';
import { dash, StatusTag } from '../round8/kit';

type Rec = Record<string, string | number | boolean | null> & { id: string };

function cols(spec: [string, string][]): ListColumn<Rec>[] {
  return spec.map(([key, title]) => ({ key, title, render: (row: Rec) => key === 'status' || key === 'result' ? <StatusTag text={String(row[key] ?? '-')} /> : dash(row[key]) }));
}

export function EquipList({ path, title, columns, extra }: { path: string; title: string; columns: [string, string][]; extra?: ReactNode }) {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>(path, revision, onExpired);
  return <div>
    {extra}
    <ListFrame pageKey={title} columns={cols(columns)} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'q', label: '关键字' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} toolbar={<span>{title}</span>} />
  </div>;
}

export function BreakdownList() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const contents = useRemote<{ items: { id: string; title: string }[] }>('/api/equip/contents', revision, onExpired);
  const search = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const options = (contents.data?.items ?? []).map((item) => ({ value: item.id, label: item.title }));
  const contentId = list.query.content || search?.get('content') || '';
  const shown = options.some((item) => item.value === contentId) ? contentId : (options.some((item) => item.value === list.draft.content) ? list.draft.content : '');
  const remote = useRemote<{ items: Rec[]; hint: string }>(contentId ? `/api/equip/breakdowns?content_id=${contentId}` : null, revision, onExpired);
  const columns = cols([['plan_title', '维保计划'], ['category_name', '设备类别'], ['device_name', '设备'], ['device_code', '设备编号'], ['device_spec', '设备规格'], ['executor_name', '执行人'], ['team_name', '团队'], ['executed_at', '执行时间'], ['item_name', '项目'], ['result', '结果']]);
  return <ListFrame pageKey="maint-break" columns={columns} rows={contentId ? (remote.data?.items ?? []) : []} loading={remote.loading} error={remote.error}
    emptyDescription={contentId ? '暂无数据' : '请选择维保内容以查看明细数据'}
    queryFields={[{ key: 'content', label: '维保内容', kind: 'select', options }]}
    queryValue={{ ...list.draft, ...(shown && !list.draft.content ? { content: shown } : {}) }}
    onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize}
    total={contentId ? (remote.data?.items.length ?? 0) : 0} onPage={list.onPage} />;
}

export function DeviceList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/equip/devices', revision, onExpired);
  const categories = useRemote<{ items: Rec[] }>('/api/equip/categories', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [owner, setOwner] = useState('');
  const [category, setCategory] = useState('');
  const columns = cols([['code', '设备编号'], ['name', '设备名称'], ['spec', '规格'], ['status', '状态'], ['category_name', '设备类别'], ['shop_name', '车间'], ['line_name', '产线'], ['owner_name', '负责人']]);
  return <>
    <ListFrame pageKey="devices" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'name', label: '设备名称' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>} />
    <Modal title="新增设备" open={open} okText="确定" cancelText="取消" onCancel={() => setOpen(false)} onOk={() => void command.send('/api/equip/devices', { name, spec, owner_name: owner, category_id: category, status: '正常' }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <Input placeholder="设备名称" value={name} onChange={(event) => setName(event.target.value)} style={{ marginBottom: 8 }} />
      <Input placeholder="设备负责人" value={owner} onChange={(event) => setOwner(event.target.value)} style={{ marginBottom: 8 }} />
      <Input placeholder="规格" value={spec} onChange={(event) => setSpec(event.target.value)} style={{ marginBottom: 8 }} />
      <Select style={{ width: '100%' }} placeholder="设备类别" value={category || undefined} onChange={setCategory} options={(categories.data?.items ?? []).map((item) => ({ value: String(item.id), label: String(item.name) }))} />
    </Modal>
  </>;
}

export function QrList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/equip/qrcodes', revision, onExpired);
  function download(code: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 240, 240);
    ctx.fillStyle = '#111'; ctx.font = '16px sans-serif'; ctx.fillText(code, 20, 120);
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `${code}.png`;
    link.click();
  }
  const columns: ListColumn<Rec>[] = [...cols([['code', '二维码'], ['device_name', '设备名称'], ['device_code', '设备编号'], ['device_spec', '规格']]), { key: 'actions', title: '操作', render: (row) => <Button type="link" onClick={() => download(String(row.code))}>下载PNG</Button> }];
  return <ListFrame pageKey="qrcodes" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'code', label: '二维码' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage}
    toolbar={<Button type="primary" onClick={() => void command.send('/api/equip/qrcodes', { count: 1 }).then(() => message.success('已生成')).catch((error) => message.error(showError(error)))}>生成</Button>} />;
}

export function RepairList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const status = list.chips.status || '全部';
  const remote = useRemote<{ items: Rec[]; counts: Record<string, number> }>(`/api/equip/repairs?status=${encodeURIComponent(status)}`, revision, onExpired);
  const devices = useRemote<{ items: Rec[] }>('/api/equip/devices', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState('');
  const [handler, setHandler] = useState('');
  const [desc, setDesc] = useState('');
  const columns: ListColumn<Rec>[] = [...cols([['code', '工单编号'], ['device_name', '设备'], ['handler_name', '处理人'], ['fault_type', '故障类别'], ['description', '故障描述'], ['status', '状态'], ['reporter_name', '报修人']]), {
    key: 'actions', title: '操作', render: (row) => <span>
      {row.status === '待接单' && <Button type="link" onClick={() => void command.send(`/api/equip/repairs/${row.id}/actions`, { action: '接单' }).catch((error) => message.error(showError(error)))}>接单</Button>}
      {row.status === '处理中' && <Button type="link" onClick={() => void command.send(`/api/equip/repairs/${row.id}/actions`, { action: '完成' }).catch((error) => message.error(showError(error)))}>完成</Button>}
    </span>,
  }];
  return <>
    <ListFrame pageKey="repairs" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error}
      chips={[{ key: 'status', label: '状态', options: ['全部', '待接单', '处理中', '已完成', '暂停', '取消'].map((item) => ({ value: item, label: item === '全部' ? item : `${item}(${remote.data?.counts?.[item] ?? 0})` })) }]}
      chipValue={{ status }} onChip={list.onChip}
      queryFields={[{ key: 'code', label: '工单编号' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>} />
    <Modal title="新增维修工单" open={open} okText="确定" cancelText="取消" onCancel={() => setOpen(false)} onOk={() => void command.send('/api/equip/repairs', { device_id: device, handler_name: handler, description: desc, fault_type: '机械故障' }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <Select style={{ width: '100%', marginBottom: 8 }} placeholder="维修设备" value={device || undefined} onChange={setDevice} options={(devices.data?.items ?? []).map((item) => ({ value: String(item.id), label: String(item.name) }))} />
      <Input placeholder="处理人" value={handler} onChange={(event) => setHandler(event.target.value)} style={{ marginBottom: 8 }} />
      <Input.TextArea placeholder="故障描述" value={desc} onChange={(event) => setDesc(event.target.value)} />
    </Modal>
  </>;
}

export function EquipSetting() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const remote = useRemote<{ settings: Record<string, unknown> }>('/api/equip/settings', revision, onExpired);
  const saved = remote.data?.settings;
  const [scan, setScan] = useState<boolean | null>(null);
  if (!saved) return <div className="kgd-card"><p>{remote.error || '加载中'}</p></div>;
  return <div className="kgd-card">
    <h2>维保基础设置</h2>
    <p>扫码登录 <Switch checked={scan ?? Boolean(saved.scan_login)} onChange={setScan} /></p>
    <p>默认结果 {dash(saved.default_result)}</p>
    <Button type="primary" onClick={() => void command.send('/api/equip/settings', { ...saved, scan_login: scan ?? Boolean(saved.scan_login) }, 'PUT').then(() => message.success('已保存')).catch((error) => message.error(showError(error)))}>保存</Button>
  </div>;
}

export function MaintReport({ kind }: { kind: 'repair' | 'workload' | 'plans' }) {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const path = { repair: '/api/equip/reports/repair', workload: '/api/equip/reports/workload', plans: '/api/equip/reports/plans' }[kind];
  const remote = useRemote<{ items: Rec[] }>(path, revision, onExpired);
  const rows = (remote.data?.items ?? []).map((row, index) => ({ ...row, id: String(row.id ?? index) }));
  const repairCols: ListColumn<Rec>[] = [
    { key: 'team_name', title: '团队', render: (row) => dash(row.team_name) },
    { key: 'devices', title: '总台数', render: (row) => dash(row.devices ?? row.device_count) },
    { key: 'fault_devices', title: '故障台数', render: (row) => dash(row.fault_devices) },
    { key: 'times', title: '总维修次数', render: (row) => dash(row.times ?? row.repair_times) },
    { key: 'fault_rate', title: '故障率', render: (row) => dash(row.fault_rate) },
    { key: 'downtime', title: '总停机时长', render: (row) => dash(row.downtime) },
    { key: 'cost', title: '总维修费用', render: (row) => dash(row.cost ?? row.total_cost) },
  ];
  const workloadCols: ListColumn<Rec>[] = [
    { key: 'team_name', title: '团队', render: (row) => dash(row.team_name) },
    { key: 'people', title: '人员数量', render: (row) => dash(row.people ?? row.people_count) },
    { key: 'done', title: '完成工单数', render: (row) => dash(row.done ?? row.done_count) },
    { key: 'overdue', title: '超时工单数', render: (row) => dash(row.overdue ?? row.overdue_count) },
    { key: 'hours', title: '累计维修时间(h)', render: (row) => dash(row.hours ?? row.total_hours) },
    { key: 'avg_hours', title: '人均工时(h)', render: (row) => dash(row.avg_hours) },
    { key: 'cost', title: '总维修费用', render: (row) => dash(row.cost ?? row.total_cost) },
    { key: 'avg_cost', title: '人均费用', render: (row) => dash(row.avg_cost) },
  ];
  const planCols: ListColumn<Rec>[] = [
    { key: 'title', title: '计划名称', render: (row) => dash(row.title ?? row.plan_name) },
    { key: 'category', title: '计划分类', render: (row) => dash(row.category ?? row.category_name) },
    { key: 'cycle_text', title: '计划周期', render: (row) => dash(row.cycle_text ?? row.plan_cycle) },
    { key: 'loop_cycle', title: '循环周期', render: (row) => dash(row.loop_cycle) },
    { key: 'executor_name', title: '执行人/执行团队', render: (row) => dash(row.executor_name || row.team_name) },
    { key: 'device_count', title: '设备数量', render: (row) => dash(row.device_count) },
    { key: 'rate', title: '计划完成率(%)', render: (row) => dash(row.rate ?? row.complete_rate) },
    { key: 'should_times', title: '应执行次数', render: (row) => dash(row.should_times) },
    { key: 'done_times', title: '实际执行次数', render: (row) => dash(row.done_times ?? row.actual_times) },
    { key: 'miss_times', title: '漏执行次数', render: (row) => dash(row.miss_times) },
  ];
  const columns = kind === 'plans' ? planCols : kind === 'workload' ? workloadCols : repairCols;
  const queryFields = kind === 'plans'
    ? [{ key: 'team', label: '团队' }, { key: 'executor', label: '执行人' }]
    : [{ key: 'team', label: '团队' }];
  const exportName = { repair: '设备维修分析', workload: '维修工作量统计', plans: '维保计划统计' }[kind];
  return <ListFrame
    pageKey={`maint-${kind}`}
    exportName={exportName}
    columns={columns}
    rows={rows}
    loading={remote.loading}
    error={remote.error}
    queryFields={queryFields}
    queryValue={list.draft}
    onQuery={list.onQuery}
    onSearch={list.onSearch}
    onClear={list.onClear}
    page={list.page}
    pageSize={list.pageSize}
    total={rows.length}
    onPage={list.onPage}
  />;
}
