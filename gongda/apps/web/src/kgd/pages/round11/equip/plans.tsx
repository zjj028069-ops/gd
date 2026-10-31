import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, DatePicker, Input, InputNumber, Modal, Radio, Select, Steps, Switch, Table, Tag, TimePicker } from 'antd';
import { type Dayjs } from 'dayjs';
import { emptyVal, idFromLocation, mobileFieldsFrom, redBorder, useEquipApi, useQueryState, useRemote, ListFrame, dash, type Rec } from './shared';

const planFilters = [
  { key: 'title', label: '计划名称' }, { key: 'category', label: '计划分类' }, { key: 'device', label: '维保设备' },
  { key: 'device_code', label: '维保设备编号' }, { key: 'executor', label: '执行人/执行团队' },
  { key: 'team', label: '团队' }, { key: 'start_from', label: '开始时间起', kind: 'date' as const }, { key: 'start_to', label: '开始时间止', kind: 'date' as const },
  { key: 'exec_time', label: '执行时间' }, { key: 'created_from', label: '创建时间起', kind: 'date' as const }, { key: 'created_to', label: '创建时间止', kind: 'date' as const },
];

export function MaintPlanList() {
  const api = useEquipApi();
  const list = useQueryState();
  const navigate = useNavigate();
  const remote = useRemote<{ items: Rec[] }>('/api/equip/plans', api.revision, api.onExpired);
  const [view, setView] = useState('device');
  const [deviceModal, setDeviceModal] = useState<{ title: string; devices: { id: string; name: string; code: string }[] } | null>(null);
  const [kw, setKw] = useState('');
  const [postpone, setPostpone] = useState<Rec | null>(null);
  const [endDate, setEndDate] = useState<Dayjs | null>(null);
  const rows = useMemo(() => {
    if (view !== 'device') return [] as Rec[];
    const q = list.query;
    return (remote.data?.items ?? []).filter((row) => {
      if (q.title && !String(row.title ?? '').includes(q.title)) return false;
      if (q.category && !String(row.category ?? '').includes(q.category)) return false;
      if (q.executor && !String(row.executor_name ?? '').includes(q.executor)) return false;
      if (q.team && !String(row.team_name ?? '').includes(q.team)) return false;
      if (q.device && !String(row.device_text ?? '').includes(q.device) && !(row.devices as { name: string }[] | undefined)?.some((d) => d.name.includes(q.device))) return false;
      if (q.device_code && !(row.devices as { code: string }[] | undefined)?.some((d) => d.code.includes(q.device_code))) return false;
      return true;
    });
  }, [remote.data, list.query, view]);
  const cols = [
    { key: 'title', title: '计划名称', render: (row: Rec) => <button className="kgd-link" onClick={() => navigate(`/inspection_plan/detail/${row.id}`)}>{String(row.title)}</button> },
    { key: 'category', title: '计划分类', render: (row: Rec) => dash(row.category) },
    { key: 'device', title: '设备', render: (row: Rec) => {
      const devices = (row.devices as { id: string; name: string; code: string }[] | undefined) ?? [];
      if (devices.length <= 1) return dash(devices[0]?.name || row.device_text);
      return <button className="kgd-link" onClick={() => setDeviceModal({ title: String(row.title), devices })}>查看({devices.length})</button>;
    } },
    { key: 'device_count', title: '设备数量', render: (row: Rec) => String(row.device_count ?? 0) },
    { key: 'period', title: '计划周期', render: (row: Rec) => dash(row.period_text) },
    { key: 'remain', title: '计划剩余天数', render: (row: Rec) => dash(row.remain_days) },
    { key: 'cycle', title: '循环周期', render: (row: Rec) => dash(row.cycle_text) },
    { key: 'exec_time', title: '执行时间', render: (row: Rec) => dash(row.exec_time_text) },
    { key: 'note', title: '备注', render: (row: Rec) => dash(row.note) },
    { key: 'executor', title: '执行人/执行团队', render: (row: Rec) => dash(row.executor_name) },
    { key: 'team', title: '团队', render: (row: Rec) => dash(row.team_name) },
    { key: 'month', title: '月执行概况', render: (row: Rec) => dash(row.month_overview) },
    { key: 'enabled', title: '启用/禁用', render: (row: Rec) => <Switch checked={Boolean(row.enabled)} onChange={(v) => void api.act(`/api/equip/plans/${row.id}`, { enabled: v }, 'PATCH')} /> },
    { key: 'created', title: '创建时间', render: (row: Rec) => dash(row.created_at_text || row.created_at) },
    { key: 'actions', title: '操作', width: 160, render: (row: Rec) => <>
      <button className="kgd-link" onClick={() => navigate(`/inspection_plan/add/1?id=${row.id}`)}>修改</button>{' '}
      <button className="kgd-link" onClick={() => { setPostpone(row); setEndDate(null); }}>延期</button>{' '}
      <button className="kgd-link" onClick={() => api.modal.confirm({ title: '确定删除该维保计划？', onOk: () => api.act(`/api/equip/plans/${row.id}`, {}, 'DELETE') })}>删除</button>
    </> },
  ];
  const filteredDevices = (deviceModal?.devices ?? []).filter((d) => !kw || d.name.includes(kw) || d.code.includes(kw));
  return <>
    <ListFrame pageKey="inspection_plan" rows={rows} loading={remote.loading} error={remote.error}
      viewTabs={[{ key: 'device', label: '设备维保视图' }, { key: 'product', label: '产品维保视图' }]} activeView={view} onView={setView}
      queryFields={planFilters} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      defaultQueryKeys={['title', 'category', 'device', 'device_code', 'executor']}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => navigate('/inspection_plan/add/1')}>新增</Button>}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={mobileFieldsFrom(cols)}
      moreItems={[{ key: 'export_all', label: '导出(所有列)' }, { key: 'export_visible', label: '导出(显示列)' }]}
      columns={cols} />
    <Modal title="维保计划设备" open={!!deviceModal} onCancel={() => setDeviceModal(null)} footer={null} width={640}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Input placeholder="输入关键字查询" value={kw} onChange={(e) => setKw(e.target.value)} style={{ width: 240 }} />
      </div>
      <Table size="small" rowKey="id" pagination={{ pageSize: 10, showTotal: (n) => `共${n}条数据` }}
        dataSource={filteredDevices} columns={[{ title: '设备名', dataIndex: 'name' }, { title: '编号', dataIndex: 'code' }]} />
    </Modal>
    <Modal title="延期" open={!!postpone} okText="确定" cancelText="取消" onCancel={() => setPostpone(null)}
      onOk={() => { if (!endDate) return; void api.act(`/api/equip/plans/${postpone!.id}`, { postpone_end: endDate.format('YYYY-MM-DD') }, 'PATCH').then(() => setPostpone(null)); }}>
      <div className="kgd-form"><span>*计划结束时间</span><DatePicker style={{ width: '100%' }} value={endDate} onChange={setEndDate} /></div>
    </Modal>
  </>;
}

type DeviceLine = { id: string; code: string; name: string; category_name: string; content_id: string; content_title: string; content_count: number };

export function MaintPlanAdd() {
  const api = useEquipApi();
  const navigate = useNavigate();
  const devicesRemote = useRemote<{ items: Rec[] }>('/api/equip/devices', api.revision, api.onExpired);
  const contentsRemote = useRemote<{ items: Rec[] }>('/api/equip/contents', api.revision, api.onExpired);
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [team, setTeam] = useState('默认团队');
  const [execType, setExecType] = useState('个人执行');
  const [executor, setExecutor] = useState<string[]>([]);
  const [period, setPeriod] = useState<[Dayjs | null, Dayjs | null]>([null, null]);
  const [cycleRule, setCycleRule] = useState('每几天执行');
  const [cycleDays, setCycleDays] = useState(1);
  const [execMode, setExecMode] = useState('当天执行');
  const [timeSpans, setTimeSpans] = useState<{ start?: Dayjs | null; end?: Dayjs | null }[]>([{ start: null, end: null }]);
  const [remindMode, setRemindMode] = useState('当天提醒');
  const [remindMinutes, setRemindMinutes] = useState(5);
  const [remindPeople] = useState(['执行人/执行团队']);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DeviceLine[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [sign, setSign] = useState('关闭');
  const [scan, setScan] = useState('关闭');
  const [early, setEarly] = useState('开启');
  const [repeat, setRepeat] = useState('开启');
  const [pub, setPub] = useState('开启');
  const [pickDevice, setPickDevice] = useState(false);
  const [pickContent, setPickContent] = useState<'batch' | string | null>(null);
  const [pickSel, setPickSel] = useState<string[]>([]);
  const [contentKw, setContentKw] = useState('');
  const [devFilter, setDevFilter] = useState({ name: '', code: '', status: '' });

  function step1Ok() {
    const ok = Boolean(title.trim()) && Boolean(team) && Boolean(execType) && (execType !== '个人执行' || executor.length > 0) && Boolean(period[0] && period[1]) && Boolean(cycleRule) && Boolean(remindMode) && remindPeople.length > 0;
    return ok;
  }

  async function create() {
    const contentIds = [...new Set(lines.map((l) => l.content_id).filter(Boolean))];
    const deviceContents = Object.fromEntries(lines.map((l) => [l.id, l.content_id]));
    const body = {
      title, category, team_name: team, exec_type: execType, executor_name: executor.join('、') || '团队',
      period_start: period[0]?.format('YYYY-MM-DD'), period_end: period[1]?.format('YYYY-MM-DD'),
      cycle_rule: cycleRule, cycle_text: cycleRule === '每几天执行' ? `每${cycleDays}天执行一次` : cycleRule, cycle_days: cycleDays,
      exec_mode: execMode, time_spans: timeSpans.map((s) => ({ start: s.start?.format('HH:mm') || '', end: s.end?.format('HH:mm') || '' })),
      remind_mode: remindMode, remind_minutes: remindMinutes, remind_people: remindPeople, note,
      device_ids: lines.map((l) => l.id), content_ids: contentIds, device_contents: deviceContents,
      sign_confirm: sign, scan_verify: scan, early_exec: early, repeat_exec: repeat, public_show: pub,
    };
    const result = await api.act<{ id: string }>('/api/equip/plans', body);
    if (result) navigate('/inspection_plan/list');
  }

  const err = (cond: boolean) => tried && !cond;

  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => navigate('/inspection_plan/list')}>返回</Button></div>
    <Steps current={step} items={[{ title: '设置基础信息' }, { title: '设置维保设备和内容' }, { title: '高级设置' }]} style={{ marginBottom: 24 }} />
    {step === 0 && <div className="kgd-form" style={{ maxWidth: 720, display: 'grid', gap: 12 }}>
      <label><span style={{ color: '#ff4d4f' }}>* </span>计划名称<br /><Input style={redBorder(err(Boolean(title.trim())))} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>计划分类<br /><Select style={{ width: '100%' }} allowClear value={category || undefined} onChange={(v) => setCategory(v ?? '')} options={['车床维保', '阀门维保', '叉车检查'].map((v) => ({ value: v, label: v }))} /></label>
      <label><span style={{ color: '#ff4d4f' }}>* </span>团队<br /><Select style={{ width: '100%', ...redBorder(err(Boolean(team))) }} value={team} onChange={setTeam} options={[{ value: '默认团队', label: '默认团队' }]} /></label>
      <label><span style={{ color: '#ff4d4f' }}>* </span>执行类型<br /><Select style={{ width: '100%', ...redBorder(err(Boolean(execType))) }} value={execType} onChange={setExecType} options={[{ value: '个人执行', label: '个人执行' }, { value: '团队执行', label: '团队执行' }]} /></label>
      {execType === '个人执行' && <label><span style={{ color: '#ff4d4f' }}>* </span>执行人<br /><Select mode="multiple" style={{ width: '100%', ...redBorder(err(executor.length > 0)) }} placeholder="姓名/简拼" value={executor} onChange={setExecutor} options={['本地管理员', '维保员'].map((v) => ({ value: v, label: v }))} /></label>}
      <label><span style={{ color: '#ff4d4f' }}>* </span>计划周期<br /><DatePicker.RangePicker style={{ width: '100%', ...redBorder(err(Boolean(period[0] && period[1]))) }} placeholder={['开始时间', '结束时间']} value={period} onChange={(v) => setPeriod(v as [Dayjs | null, Dayjs | null] ?? [null, null])} /></label>
      <label><span style={{ color: '#ff4d4f' }}>* </span>循环周期<br /><Select style={{ width: '100%', ...redBorder(err(Boolean(cycleRule))) }} value={cycleRule} onChange={setCycleRule} options={['每几天执行', '每周几执行', '每月的几号执行'].map((v) => ({ value: v, label: v }))} />
        {cycleRule === '每几天执行' && <div style={{ marginTop: 8 }}>每 <InputNumber min={1} value={cycleDays} onChange={(v) => setCycleDays(Number(v) || 1)} /> 天执行一次</div>}
        {cycleRule === '每周几执行' && <div style={{ marginTop: 8 }}>每周 <Select mode="multiple" style={{ minWidth: 220 }} placeholder="请选择星期" options={['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((v) => ({ value: v, label: v }))} /></div>}
        {cycleRule === '每月的几号执行' && <div style={{ marginTop: 8 }}>每月 <InputNumber min={1} max={31} placeholder="几号" /> 号执行</div>}
      </label>
      <label>执行时间:<br />
        <Radio.Group value={execMode} onChange={(e) => setExecMode(e.target.value)} options={[{ value: '当天执行', label: '当天执行' }, { value: '跨天执行', label: '跨天执行' }]} />
        {timeSpans.map((span, i) => <div key={i} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <TimePicker placeholder="请选择开始时间" value={span.start} onChange={(v) => setTimeSpans((cur) => cur.map((s, idx) => idx === i ? { ...s, start: v } : s))} />
          <span>~</span>
          <TimePicker placeholder="请选择结束时间" value={span.end} onChange={(v) => setTimeSpans((cur) => cur.map((s, idx) => idx === i ? { ...s, end: v } : s))} />
        </div>)}
        <Button type="link" onClick={() => setTimeSpans((cur) => [...cur, { start: null, end: null }])}>+ 添加时段</Button>
      </label>
      <label><span style={{ color: '#ff4d4f' }}>* </span>提醒时间<br />
        <Radio.Group value={remindMode} onChange={(e) => setRemindMode(e.target.value)} options={[{ value: '当天提醒', label: '当天提醒' }, { value: '提前提醒', label: '提前提醒' }]} />
        {remindMode === '提前提醒' && <div style={{ marginTop: 8 }}>每 <InputNumber min={5} value={remindMinutes} onChange={(v) => setRemindMinutes(Number(v) || 5)} placeholder="请输入分钟数（大于等于5）" /> 分钟提醒一次，最多提醒10次</div>}
      </label>
      <label><span style={{ color: '#ff4d4f' }}>* </span>提醒人<br /><div className="kgd-muted">到达提醒时间后，会提醒下方人员：</div>
        <Tag closable>{remindPeople[0]}</Tag>
      </label>
      <label>备注<br /><Input.TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div><Button type="primary" onClick={() => { setTried(true); if (step1Ok()) setStep(1); }}>下一步</Button></div>
    </div>}
    {step === 1 && <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button type="primary" onClick={() => { setPickDevice(true); setPickSel([]); }}>+ 选择设备</Button>
        <Button disabled={!selected.length} onClick={() => setPickContent('batch')}>+ 批量设置维保内容</Button>
      </div>
      <Table size="small" rowKey="id" locale={{ emptyText: '暂无数据' }} rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)) }}
        dataSource={lines} pagination={false}
        columns={[
          { title: '设备编号', dataIndex: 'code' }, { title: '设备名称', dataIndex: 'name' }, { title: '设备类别', dataIndex: 'category_name' },
          { title: '维保内容', render: (_, row) => row.content_title ? `${row.content_title}(${row.content_count || 0})` : '-' },
          { title: '操作', render: (_, row) => <><button className="kgd-link" onClick={() => setPickContent(row.id)}>设置维保内容</button>{' '}<button className="kgd-link" onClick={() => setLines((cur) => cur.filter((l) => l.id !== row.id))}>删除</button></> },
        ]} />
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button onClick={() => setStep(0)}>上一步</Button>
        <Button type="primary" onClick={() => {
          if (!lines.length) { api.message.error('请选择维保设备'); return; }
          if (lines.some((l) => !l.content_id)) { api.message.error('请为每台设备设置维保内容'); return; }
          setStep(2);
        }}>下一步</Button>
      </div>
    </div>}
    {step === 2 && <div className="kgd-form" style={{ maxWidth: 640, display: 'grid', gap: 16 }}>
      {([['签字确认', sign, setSign, '关闭'], ['扫码验证', scan, setScan, '关闭'], ['提前执行', early, setEarly, '开启'], ['重复执行', repeat, setRepeat, '开启'], ['对外展示维保数据', pub, setPub, '开启']] as const).map(([label, value, setter]) => (
        <label key={label}><span style={{ color: '#ff4d4f' }}>* </span>{label} <span title="提示">?</span><br />
          <Radio.Group value={value} onChange={(e) => setter(e.target.value)} options={[{ value: '开启', label: '开启' }, { value: '关闭', label: '关闭' }]} />
        </label>
      ))}
      <div style={{ display: 'flex', gap: 8 }}><Button onClick={() => setStep(1)}>上一步</Button><Button type="primary" onClick={() => void create()}>创建维保计划</Button></div>
    </div>}
    <Modal title="选择设备" open={pickDevice} width={900} onCancel={() => setPickDevice(false)}
      onOk={() => {
        const map = new Map(lines.map((l) => [l.id, l]));
        for (const d of devicesRemote.data?.items ?? []) {
          if (!pickSel.includes(String(d.id))) continue;
          if (!map.has(String(d.id))) map.set(String(d.id), { id: String(d.id), code: String(d.code), name: String(d.name), category_name: String(d.category_name || ''), content_id: '', content_title: '', content_count: 0 });
        }
        setLines([...map.values()]); setPickDevice(false);
      }} okText="确定" cancelText="取消">
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <Input placeholder="设备名称" style={{ width: 140 }} value={devFilter.name} onChange={(e) => setDevFilter({ ...devFilter, name: e.target.value })} />
        <Input placeholder="设备编号" style={{ width: 140 }} value={devFilter.code} onChange={(e) => setDevFilter({ ...devFilter, code: e.target.value })} />
        <Select allowClear placeholder="设备状态" style={{ width: 140 }} value={devFilter.status || undefined} onChange={(v) => setDevFilter({ ...devFilter, status: v ?? '' })} options={['正常', '维修中', '运行中'].map((v) => ({ value: v, label: v }))} />
        <Select allowClear placeholder="设备类别" style={{ width: 140 }} options={[]} />
        <Select allowClear placeholder="车间" style={{ width: 140 }} options={[]} />
        <Select allowClear placeholder="产线" style={{ width: 140 }} options={[]} />
      </div>
      <Table size="small" rowKey="id" pagination={{ pageSize: 10, showTotal: (n) => `共${n}条数据` }}
        rowSelection={{ selectedRowKeys: pickSel, onChange: (keys) => setPickSel(keys.map(String)) }}
        dataSource={(devicesRemote.data?.items ?? []).filter((d) => (!devFilter.name || String(d.name).includes(devFilter.name)) && (!devFilter.code || String(d.code).includes(devFilter.code)) && (!devFilter.status || d.status === devFilter.status))}
        columns={['设备编号', '设备名称', '设备规格', '设备状态', '设备类别', '车间', '产线', '负责人', '团队', '创建时间'].map((title, i) => {
          const keys = ['code', 'name', 'spec', 'status', 'category_name', 'shop_name', 'line_name', 'owner_name', 'team_name', 'created_at_text'];
          return { title, dataIndex: keys[i] };
        })} />
    </Modal>
    <Modal title="选择维保内容" open={!!pickContent} width={800} footer={null} onCancel={() => setPickContent(null)}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}><Input placeholder="标题" style={{ width: 200 }} value={contentKw} onChange={(e) => setContentKw(e.target.value)} /></div>
      <Table size="small" rowKey="id" pagination={{ pageSize: 10, showTotal: (n) => `共${n}条数据` }}
        dataSource={(contentsRemote.data?.items ?? []).filter((c) => !contentKw || String(c.title).includes(contentKw))}
        onRow={(row) => ({ onClick: () => {
          const apply = (line: DeviceLine) => ({ ...line, content_id: String(row.id), content_title: String(row.title), content_count: Number(row.item_count || 0) });
          if (pickContent === 'batch') setLines((cur) => cur.map((l) => selected.includes(l.id) ? apply(l) : l));
          else setLines((cur) => cur.map((l) => l.id === pickContent ? apply(l) : l));
          setPickContent(null);
        } })}
        columns={[
          { title: '标题', dataIndex: 'title' },
          { title: '检查项', render: (_, row) => String(Number(row.item_count || 0)) },
          { title: '备注', dataIndex: 'note' }, { title: '创建人', dataIndex: 'creator_name' },
        ]} />
    </Modal>
  </div>;
}

export function MaintPlanDetail() {
  const id = idFromLocation('/inspection_plan/detail/');
  const api = useEquipApi();
  const navigate = useNavigate();
  const remote = useRemote<{ plan: Rec; devices: Rec[]; tasks: Rec[]; records: Rec[] }>(id ? `/api/equip/plans/${id}` : null, api.revision, api.onExpired);
  const [tab, setTab] = useState('维保设备');
  const plan = remote.data?.plan;
  if (!plan && remote.loading) return <div className="kgd-card">加载中</div>;
  if (!plan) return <div className="kgd-card">{remote.error || '维保计划不存在'}</div>;
  const info: [string, ReactNode][] = [
    ['维保类型', <Tag color="orange">内部设备维保</Tag>],
    ['执行团队', emptyVal(plan.executor_name)],
    ['团队', emptyVal(plan.team_name)],
    ['计划分类', emptyVal(plan.category)],
    ['状态', <Switch checked={Boolean(plan.enabled)} onChange={(v) => void api.act(`/api/equip/plans/${id}`, { enabled: v }, 'PATCH')} />],
    ['备注', emptyVal(plan.note)],
    ['计划周期', <>{emptyVal(plan.period_text)}{plan.remain_days !== '' && plan.remain_days !== undefined ? <Tag color="green" style={{ marginLeft: 8 }}>剩余{String(plan.remain_days)}天</Tag> : null}</>],
    ['循环周期', emptyVal(plan.cycle_text)],
    ['执行时间', emptyVal(plan.exec_time_text)],
    ['提醒周期', emptyVal(plan.remind_cycle)],
    ['提醒时间', emptyVal((plan.advanced as { remind_mode?: string } | undefined)?.remind_mode)],
    ['提醒人', emptyVal(plan.remind_people_text)],
    ['已完成任务数', emptyVal(plan.done_task_count)],
    ['上次完成任务时间', emptyVal(plan.last_done_at)],
    ['创建时间', emptyVal(plan.created_at_text)],
  ];
  return <div className="kgd-card">
    <div className="kgd-actions">
      <Button onClick={() => navigate('/inspection_plan/list')}>返回</Button>
      <Button onClick={() => navigate(`/inspection_plan/add/1?id=${id}`)}>修改</Button>
      <Button danger onClick={() => api.modal.confirm({ title: '确定删除该维保计划？', onOk: () => api.act(`/api/equip/plans/${id}`, {}, 'DELETE').then(() => navigate('/inspection_plan/list')) })}>删除</Button>
    </div>
    <h2>{String(plan.title)}</h2>
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
      <dl className="kgd-detail-grid">{info.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {['维保设备', '维保任务', '维保记录', '维保月历'].map((t) => <button key={t} className={`kgd-view ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        {tab === '维保设备' && <Table size="small" rowKey="id" dataSource={remote.data?.devices ?? []} pagination={false}
          columns={[
            { title: '设备编号', dataIndex: 'code' },
            { title: '设备名称', render: (_, row) => <button className="kgd-link" onClick={() => navigate(`/device/detail/${row.id}`)}>{String(row.name)}</button> },
            { title: '设备规格', dataIndex: 'spec', render: (v) => dash(v) },
            { title: '设备类别', dataIndex: 'category_name', render: (v) => dash(v) },
            { title: '维保内容', render: (_, row) => row.content_title ? <span className="kgd-link">{String(row.content_title)}({Number(row.content_count || 0)})</span> : '无' },
            { title: '维保记录', render: (_, row) => <span className="kgd-link">查看({Number(row.record_count || 0)})</span> },
          ]} />}
        {tab === '维保任务' && <Table size="small" rowKey="id" dataSource={remote.data?.tasks ?? []} columns={[{ title: '任务日期', dataIndex: 'task_date' }, { title: '状态', dataIndex: 'status' }, { title: '执行人', dataIndex: 'executor_name' }]} />}
        {tab === '维保记录' && <Table size="small" rowKey="id" dataSource={remote.data?.records ?? []} columns={[
          { title: '维保计划名称', render: () => String(plan.title) }, { title: '执行时间', dataIndex: 'executed_at' }, { title: '设备', dataIndex: 'device_name' },
          { title: '正常数', dataIndex: 'normal_count' }, { title: '异常数', dataIndex: 'abnormal_count' }, { title: '维保内容', dataIndex: 'content_title' },
          { title: '检查项', dataIndex: 'item_name' }, { title: '可选值', dataIndex: 'options' }, { title: '巡检值', dataIndex: 'value' }, { title: '是否正常', dataIndex: 'result' },
        ]} />}
        {tab === '维保月历' && <div>{['日', '一', '二', '三', '四', '五', '六'].map((d) => <span key={d} style={{ display: 'inline-block', width: 40, textAlign: 'center' }}>{d}</span>)}<div className="kgd-muted">暂无数据</div></div>}
      </div>
    </div>
  </div>;
}
