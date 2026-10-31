import { useState } from 'react';
import { App, Button, Input, Modal, Radio, Select, Switch } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import type { ListColumn } from '../../ListFrame';
import { showError, useCommand, useQueryState } from '../../kit';
import { dash, StatusTag } from '../round8/kit';

type Rec = Record<string, string> & { id: string; enabled?: boolean; parent_id?: string | null };

export function MachineList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/machines', revision, onExpired);
  const categories = useRemote<{ items: Rec[] }>('/api/machines/categories', revision, onExpired);
  const shops = useRemote<{ items: Rec[] }>('/api/machines/shops', revision, onExpired);
  const lines = useRemote<{ items: Rec[] }>('/api/machines/lines', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [spec, setSpec] = useState('');
  const [status, setStatus] = useState('正常');
  const [category, setCategory] = useState('');
  const [sync, setSync] = useState('否');
  const [shop, setShop] = useState('');
  const [line, setLine] = useState('');
  const columns: ListColumn<Rec>[] = [
    { key: 'code', title: '机台编号', render: (row) => row.code },
    { key: 'name', title: '机台名称', render: (row) => row.name },
    { key: 'spec', title: '机台规格', render: (row) => dash(row.spec) },
    { key: 'status', title: '机台状态', render: (row) => <StatusTag text={row.status} /> },
    { key: 'category', title: '机台类别', render: (row) => dash(row.category_name) },
    { key: 'hours', title: '单日运行时长', render: (row) => dash(row.hours_text) },
    { key: 'eff', title: '标准效率', render: (row) => dash(row.efficiency_text) },
    { key: 'shop', title: '车间', render: (row) => dash(row.shop_name) },
    { key: 'line', title: '产线', render: (row) => dash(row.line_name) },
    { key: 'enabled', title: '启用/禁用', render: (row) => <Switch checked={row.enabled !== false && row.enabled_text !== '禁用'} onChange={(checked) => void command.send(`/api/machines/${row.id}`, { enabled: checked }, 'PATCH').catch((error) => message.error(showError(error)))} /> },
    { key: 'actions', title: '操作', render: (row) => <Button type="link" onClick={() => void command.send(`/api/machines/${row.id}`, {}, 'DELETE').then(() => message.success('已删除')).catch((error) => message.error(showError(error)))}>删除</Button> },
  ];
  return <>
    <ListFrame pageKey="machines" showMobileCard columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'code', label: '机台编号' }, { key: 'name', label: '机台名称' }, { key: 'status', label: '机台状态' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>} />
    <Modal title="新增机台" open={open} okText="确定" cancelText="取消" confirmLoading={command.busy} onCancel={() => setOpen(false)}     onOk={() => {
        if (!name.trim()) { command.setFieldError('name', '请填写机台名称'); return; }
        void command.send('/api/machines', { code, name, spec, status, category_id: category, sync_device: sync, shop_id: shop, line_id: line }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)));
      }}>
      <div className="kgd-form">
        <span>机台编号</span><Input placeholder="请填写，忽略将自动生成" value={code} onChange={(event) => setCode(event.target.value)} />
        <span className={command.fieldErrors.name ? 'kgd-field-error-label' : undefined}>机台名称 *</span><div className={command.fieldErrors.name ? 'kgd-field-error' : undefined}><Input value={name} onChange={(event) => setName(event.target.value)} />{command.fieldErrors.name ? <div className="kgd-field-help">{command.fieldErrors.name}</div> : null}</div>
        <span>机台规格</span><Input value={spec} onChange={(event) => setSpec(event.target.value)} />
        <span>机台状态 *</span><Select value={status} onChange={setStatus} options={['正常', '维修中', '运行中'].map((item) => ({ value: item, label: item }))} />
        <span>机台类别 *</span><Select value={category || undefined} onChange={setCategory} options={(categories.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
        <span>同步创建设备 *</span><Radio.Group value={sync} onChange={(event) => setSync(event.target.value)} options={[{ value: '否', label: '否' }, { value: '是', label: '是' }]} />
        <span>车间</span><Select allowClear value={shop || undefined} onChange={(value) => setShop(value ?? '')} options={(shops.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
        <span>产线</span><Select allowClear value={line || undefined} onChange={(value) => setLine(value ?? '')} options={(lines.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
      </div>
    </Modal>
  </>;
}

function TreeEditor({ title, path }: { title: string; path: string }) {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const remote = useRemote<{ items: Rec[] }>(path, revision, onExpired);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  return <section style={{ marginBottom: 16 }}>
    <h3>{title}</h3>
    <div className="kgd-toolbar"><Input placeholder="分类名称" value={name} onChange={(event) => setName(event.target.value)} /><Select allowClear placeholder="上级" style={{ width: 160 }} value={parent || undefined} onChange={(value) => setParent(value ?? '')} options={(remote.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} /><Button onClick={() => void command.send(path, { name, parent_id: parent }).then(() => { setName(''); message.success('已添加'); }).catch((error) => message.error(showError(error)))}>新增</Button></div>
    {(remote.data?.items ?? []).map((item) => <div key={item.id} style={{ display: 'flex', gap: 8, padding: '4px 0' }}><span>{item.parent_id ? '└ ' : ''}{item.name}</span><Button type="link" onClick={() => void command.send(`${path}/${item.id}`, {}, 'DELETE').catch((error) => message.error(showError(error)))}>删除</Button></div>)}
  </section>;
}

const produceSettingItems = [
  ['auto_start_wo', '创建加工单后是否自动开始'],
  ['auto_start_on_plan', '加工单到计划开始日期自动开始'],
  ['auto_priority', '加工单优先级自动变更'],
  ['auto_complete_wo', '所有工序完成后，工单自动完成'],
  ['multi_timer', '单员工同时计时多工序'],
  ['mini_by_line', '小程序按照产线展示加工单的工序列表'],
  ['auto_fill_child_wo', '加工单子单自动填写'],
  ['open_all_reporters', '工序未设置生产人员，视生产人员为所有人'],
  ['report_qty_mode', '工序报工数量'],
  ['group_report_default', '小组报工默认值设置'],
  ['report_by_set', '按照套数报工'],
  ['process_order', '工序生产顺序'],
  ['process_price_formula', '工序单价公式设置'],
  ['report_qty_default', '报工数量默认值'],
  ['auto_complete_process', '自动完成生产工序'],
  ['use_trace_code', '使用赛德瑞科溯源码'],
  ['near_done_remind', '加工单即将完工提醒'],
  ['qr_show_trace', '扫产品二维码查看产品详情是否显示生产溯源信息'],
  ['produce_remind', '加工单生产提醒'],
] as const;

export function ProduceDictionary() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const lines = useRemote<{ items: Rec[] }>('/api/machines/lines', revision, onExpired);
  const statuses = useRemote<{ items: Rec[] }>('/api/machines/statuses', revision, onExpired);
  const settingsRemote = useRemote<{ settings: Record<string, boolean> }>('/api/produce/settings', revision, onExpired);
  const [settings, setSettings] = useState<Record<string, boolean>>({});
  const [line, setLine] = useState('');
  const merged = { ...settingsRemote.data?.settings, ...settings };
  return <div className="kgd-card">
    <h2>基础配置</h2>
    <section style={{ marginBottom: 20 }}>
      {produceSettingItems.map(([key, label]) => <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f5f5f5' }}>
        <span>{label}{key === 'process_price_formula' ? '（且绩效工资无法生效）' : ''}</span>
        <Switch checked={!!merged[key]} onChange={(checked) => setSettings((current) => ({ ...current, [key]: checked }))} />
      </div>)}
      <Button type="primary" style={{ marginTop: 12 }} onClick={() => void command.send('/api/produce/settings', { ...merged }, 'PUT').then(() => message.success('已保存')).catch((error) => message.error(showError(error)))}>保 存</Button>
    </section>
    <TreeEditor title="车间信息" path="/api/machines/shops" />
    <section>
      <h3>工序产线</h3>
      <div className="kgd-toolbar"><Input placeholder="名称" value={line} onChange={(event) => setLine(event.target.value)} /><Button onClick={() => void command.send('/api/machines/lines', { name: line }).then(() => { setLine(''); message.success('已添加'); }).catch((error) => message.error(showError(error)))}>添加</Button></div>
      {(lines.data?.items ?? []).map((item) => <div key={item.id}>{item.name} <Button type="link" onClick={() => void command.send(`/api/machines/lines/${item.id}`, {}, 'DELETE')}>删除</Button></div>)}
    </section>
    <TreeEditor title="机台类别" path="/api/machines/categories" />
    <section>
      <h3>机台状态</h3>
      {(statuses.data?.items ?? []).map((item) => <div key={item.id}>{item.name} / {item.kind}</div>)}
    </section>
  </div>;
}

export function StationSetting() {
  const { revision, onExpired, session } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const settings = useRemote<{ enterprise_code: string; password: string }>('/api/stations/settings', revision, onExpired);
  const stations = useRemote<{ items: Rec[] }>('/api/stations', revision, onExpired);
  const shops = useRemote<{ items: Rec[] }>('/api/machines/shops', revision, onExpired);
  const lines = useRemote<{ items: Rec[] }>('/api/machines/lines', revision, onExpired);
  const members = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', revision, onExpired);
  const devicesRemote = useRemote<{ items: Rec[] }>('/api/equip/devices', revision, onExpired);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shop, setShop] = useState('');
  const [line, setLine] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [devices, setDevices] = useState<string[]>([]);
  const columns: ListColumn<Rec>[] = [
    { key: 'name', title: '工作站名称', render: (row) => row.name },
    { key: 'shop', title: '车间', render: (row) => dash(row.shop_name) },
    { key: 'line', title: '产线', render: (row) => dash(row.line_name) },
    { key: 'workers', title: '生产人员', render: (row) => dash(row.workers) },
    { key: 'devices', title: '维保设备', render: (row) => dash(row.devices) },
    { key: 'actions', title: '操作', render: (row) => <Button type="link" onClick={() => void command.send(`/api/stations/${row.id}`, {}, 'DELETE').then(() => message.success('已删除')).catch((error) => message.error(showError(error)))}>删除</Button> },
  ];
  return <div className="kgd-card">
    <h2>工作站管理配置</h2>
    <h3>工作站激活密码设置</h3>
    <div className="kgd-toolbar">
      <Input placeholder="企业编号" value={code || settings.data?.enterprise_code || ''} onChange={(event) => setCode(event.target.value)} />
      <Input placeholder="激活密码" value={password || settings.data?.password || ''} onChange={(event) => setPassword(event.target.value)} />
      <Button onClick={() => void command.send('/api/stations/settings', { enterprise_code: code || settings.data?.enterprise_code, password: password || settings.data?.password }, 'PUT').then(() => message.success('已保存')).catch((error) => message.error(showError(error)))}>保存</Button>
    </div>
    <ListFrame pageKey="stations" columns={columns} rows={stations.data?.items ?? []} loading={stations.loading} error={stations.error} queryFields={[{ key: 'name', label: '工作站名称' }, { key: 'shop', label: '车间' }, { key: 'line', label: '产线' }, { key: 'worker', label: '工作人员' }]} queryValue={{}} onQuery={() => undefined} onSearch={() => undefined} onClear={() => undefined} page={1} pageSize={20} total={stations.data?.items.length ?? 0} onPage={() => undefined} toolbar={<Button type="primary" onClick={() => { setUsers([String(session.user.id)]); setDevices([]); setOpen(true); }}>新增</Button>} />
    <Modal title="新增工作站" open={open} okText="确定" cancelText="取消" onCancel={() => setOpen(false)} confirmLoading={command.busy} onOk={() => void command.send('/api/stations', { name, shop_id: shop, line_id: line, user_ids: users, device_ids: devices }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <div className="kgd-form">
        <span>工作站名称 *</span><Input value={name} onChange={(event) => setName(event.target.value)} />
        <span>车间</span><Select allowClear value={shop || undefined} onChange={(value) => setShop(value ?? '')} options={(shops.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
        <span>产线</span><Select allowClear value={line || undefined} onChange={(value) => setLine(value ?? '')} options={(lines.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
        <span>工作人员 *</span><Select mode="multiple" value={users} onChange={setUsers} options={(members.data?.items ?? []).map((item) => ({ value: item.id, label: item.display_name }))} />
        <span>维保设备</span><Select mode="multiple" allowClear placeholder="点击选择设备" value={devices} onChange={setDevices} options={(devicesRemote.data?.items ?? []).map((item) => ({ value: item.id, label: String(item.name ?? item.code ?? item.id) }))} />
      </div>
    </Modal>
  </div>;
}
