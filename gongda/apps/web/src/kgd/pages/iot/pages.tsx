import { useState } from 'react';
import { App, Button, Input, Modal, Switch } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import type { ListColumn } from '../../ListFrame';
import { showError, useCommand, useQueryState } from '../../kit';
import { dash, StatusTag } from '../round8/kit';

type Rec = Record<string, string> & { id: string; demo?: boolean; updated_at?: string; alarm_level?: string };

export function IotScenes() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const [hideDemo, setHideDemo] = useState(false);
  const remote = useRemote<{ items: Rec[]; counts: Record<string, number>; demo_count?: number }>(`/api/iot/scenes?hide_demo=${hideDemo ? '1' : '0'}`, revision, onExpired);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const rows = remote.data?.items ?? [];
  const columns: ListColumn<Rec>[] = [
    { key: 'name', title: '场景名', render: (row) => row.name },
    { key: 'device', title: '关联设备', render: (row) => dash(row.device_name) },
    { key: 'shop', title: '车间', render: (row) => dash(row.shop_name) },
    { key: 'line', title: '产线', render: (row) => dash(row.line_name) },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={row.status} /> },
    { key: 'actions', title: '操作', render: (row) => row.status === '报警中' ? <Button type="link" onClick={() => void command.send(`/api/iot/scenes/${row.id}/clear-alarm`, {}).then(() => message.success('已消警')).catch((error) => message.error(showError(error)))}>消警</Button> : '-' },
  ];
  return <>
    <div className="kgd-toolbar" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
      <Button type="link" onClick={() => setHideDemo((value) => !value)}>{hideDemo ? '显示演示数据' : '隐藏演示数据'}</Button>
      <span style={{ marginLeft: 8 }}><Switch checked={hideDemo} onChange={setHideDemo} /> 隐藏演示</span>
    </div>
    <div className="kgd-iot-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
      {rows.map((row) => (
        <div key={row.id} className="kgd-card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <strong>{row.name}</strong>
            <StatusTag text={row.status} />
          </div>
          {row.demo ? <div className="kgd-muted">演示</div> : null}
          {row.alarm_level ? <div>{row.alarm_level}</div> : null}
          <div>车间：{dash(row.shop_name)}</div>
          <div className="kgd-muted">最后更新: {row.updated_at ? new Date(row.updated_at).toLocaleString('zh-CN', { hour12: false }) : '-'}</div>
          {row.status === '报警中' ? <Button type="link" onClick={() => void command.send(`/api/iot/scenes/${row.id}/clear-alarm`, {}).then(() => message.success('已消警')).catch((error) => message.error(showError(error)))}>消警</Button> : null}
        </div>
      ))}
      {!rows.length && !remote.loading ? <div className="kgd-muted">暂无场景</div> : null}
    </div>
    <ListFrame pageKey="iot-scenes" columns={columns} rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'code', label: '设备编号' }, { key: 'name', label: '设备名' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      toolbar={<><span>全部 {remote.data?.counts['全部'] ?? 0}</span><span>报警中 {remote.data?.counts['报警中'] ?? 0}</span><Button type="primary" onClick={() => setOpen(true)}>新增</Button></>} />
    <Modal title="新增物联场景" open={open} okText="确定" cancelText="取消" onCancel={() => setOpen(false)} onOk={() => void command.send('/api/iot/scenes', { name, device_name: device }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <div className="kgd-form"><span>场景名 *</span><Input value={name} onChange={(event) => setName(event.target.value)} /><span>关联设备</span><Input placeholder="关联设备" value={device} onChange={(event) => setDevice(event.target.value)} /><span>车间</span><Input /><span>产线</span><Input /><span>上传图片</span><Input type="file" /></div>
    </Modal>
  </>;
}

export function SensorList() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/iot/sensors', revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    { key: 'kind', title: '传感器类型', render: (row) => dash(row.kind) },
    { key: 'code', title: '编号', render: (row) => dash(row.code) },
    { key: 'gateway', title: '网关', render: (row) => dash(row.gateway) },
    { key: 'bind', title: '绑定状态', render: (row) => <StatusTag text={row.bind_status} /> },
    { key: 'point', title: '点位名称', render: (row) => dash(row.point_name) },
    { key: 'interval', title: '采集间隔', render: (row) => dash(row.interval_text) },
    { key: 'scene', title: '场景', render: (row) => dash(row.scene_name) },
  ];
  return <ListFrame pageKey="sensors" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'code', label: '编号' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} />;
}

export function AlarmList() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/iot/alarms', revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    { key: 'scene', title: '场景', render: (row) => dash(row.scene_name) },
    { key: 'shop', title: '车间', render: (row) => dash(row.shop_name) },
    { key: 'line', title: '产线', render: (row) => dash(row.line_name) },
    { key: 'level', title: '报警级别', render: (row) => dash(row.level) },
    { key: 'value', title: '传感器值', render: (row) => dash(row.sensor_value) },
    { key: 'result', title: '处理结果', render: (row) => <StatusTag text={row.result || '待处理'} /> },
    { key: 'time', title: '报警时间', render: (row) => dash(row.alarmed_at) },
  ];
  return <ListFrame pageKey="alarms" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'scene', label: '场景' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} />;
}

export function IotSetting() {
  const { revision, onExpired } = useKgd();
  const shops = useRemote<{ items: Rec[] }>('/api/machines/shops', revision, onExpired);
  const lines = useRemote<{ items: Rec[] }>('/api/machines/lines', revision, onExpired);
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => history.back()}>返回</Button></div>
    <h2>基础设置</h2>
    <h3>车间</h3>
    {(shops.data?.items ?? []).map((item) => <div key={item.id}>{item.name}</div>)}
    {!shops.data?.items.length && <p>-</p>}
    <h3>产线</h3>
    {(lines.data?.items ?? []).map((item) => <div key={item.id}>{item.name}</div>)}
  </div>;
}
