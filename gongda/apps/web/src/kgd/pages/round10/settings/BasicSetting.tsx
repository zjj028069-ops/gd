import { useEffect, useState } from 'react';
import { Button, ColorPicker, Input, Modal, Table } from 'antd';
import { HolderOutlined } from '@ant-design/icons';
import { useRemote } from '../../../../masterTools';
import { MemberPick, SettingFrame, SettingItem, SettingSection, SwitchItem, useList, useR10 } from '../shared';
import type { Row } from '../shared';

type BasicSettings = { product_qr_repair: boolean; device_qr_repair: boolean; device_qr_patrol: boolean; map_hidden_user_ids: string[]; photo_watermark: boolean; version?: number };
const basicDefaults: BasicSettings = { product_qr_repair: true, device_qr_repair: true, device_qr_patrol: true, map_hidden_user_ids: [], photo_watermark: false };

export function BasicSetting() {
  const r10 = useR10();
  const remote = useRemote<{ settings?: Partial<BasicSettings> }>('/api/system/basics', r10.revision, r10.onExpired);
  const [draft, setDraft] = useState<BasicSettings>(basicDefaults);
  useEffect(() => { if (remote.data?.settings) setDraft({ ...basicDefaults, ...remote.data.settings }); }, [remote.data]);
  const set = <K extends keyof BasicSettings>(key: K, value: BasicSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <SettingFrame onSave={() => void r10.act('/api/system/basics', { ...draft }, 'PUT')} saving={r10.busy}>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <SettingSection title="基础设置">
      <SwitchItem label="是否显示产品二维码界面的维修记录" value={draft.product_qr_repair} onChange={(value) => set('product_qr_repair', value)} />
      <SwitchItem label="是否显示设备二维码界面中的维修记录" value={draft.device_qr_repair} onChange={(value) => set('device_qr_repair', value)} />
      <SwitchItem label="是否显示设备二维码界面中的巡检历史" value={draft.device_qr_patrol} onChange={(value) => set('device_qr_patrol', value)} />
      <SettingItem label="地图设置" desc="被选择的用户在派单地图、所有派单选择人员、报表中心-人员地图中都不展示"><MemberPick multiple value={draft.map_hidden_user_ids} onChange={(value) => set('map_hidden_user_ids', value)} placeholder="请选择人员" style={{ maxWidth: 480 }} /></SettingItem>
      <SwitchItem label="拍照水印" desc="拍照时添加水印" value={draft.photo_watermark} onChange={(value) => set('photo_watermark', value)} />
    </SettingSection>
    <SettingSection title="单位"><SortableTable kind="unit" /></SettingSection>
    <SettingSection title="工作状态"><SortableTable kind="status" /></SettingSection>
  </SettingFrame>;
}

function SortableTable({ kind }: { kind: 'unit' | 'status' }) {
  const r10 = useR10();
  const base = kind === 'unit' ? '/api/units' : '/api/work-statuses';
  const remote = useList<Row>(base);
  const rows = [...(remote.data?.items ?? [])].filter((row) => row.active !== false).sort((a, b) => Number(a.sort ?? a.sort_no ?? 0) - Number(b.sort ?? b.sort_no ?? 0));
  const [drag, setDrag] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id?: string; name: string; color: string; version?: number } | null>(null);
  async function reorder(to: number) {
    if (drag === null || drag === to) return;
    const next = [...rows];
    const [moved] = next.splice(drag, 1);
    next.splice(to, 0, moved!);
    setDrag(null);
    await r10.act(`${base}/reorder`, { ids: next.map((row) => row.id) }, 'POST', false);
  }
  async function save() {
    if (!editing?.name.trim()) { r10.message.warning('请填写名称'); return; }
    const name = editing.name.trim();
    const body = kind === 'unit'
      ? (editing.id ? { name, version: editing.version, active: true } : { code: `U${Date.now().toString(36).toUpperCase()}`, name })
      : { name, color: editing.color };
    const result = await r10.act(editing.id ? `${base}/${editing.id}` : base, body, editing.id ? (kind === 'unit' ? 'PATCH' : 'PUT') : 'POST');
    if (result) setEditing(null);
  }
  return <>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setEditing({ name: '', color: '#4184F4' })}>添加</Button></div>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <Table size="small" rowKey="id" loading={remote.loading} pagination={false} dataSource={rows} style={{ maxWidth: 640 }} onRow={(_, index) => ({ draggable: true, onDragStart: () => setDrag(index ?? null), onDragOver: (event) => event.preventDefault(), onDrop: () => void reorder(index ?? 0) })} columns={[
      { title: '排序', width: 70, render: () => <HolderOutlined style={{ cursor: 'grab' }} /> },
      { title: '名称', dataIndex: 'name' },
      ...(kind === 'status' ? [{ title: '颜色', render: (_: unknown, row: Row) => <span style={{ display: 'inline-block', width: 40, height: 16, background: row.color || '#ccc', borderRadius: 2 }} /> }] : []),
      { title: '操作', width: 140, render: (_: unknown, row: Row) => <>
        <button className="kgd-link" onClick={() => setEditing({ id: row.id, name: row.name, color: row.color ?? '#4184F4', version: row.version })}>修改</button>{' '}
        <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete(kind === 'unit' ? '删除单位' : '删除工作状态', () => r10.act(`${base}/${row.id}`, {}, 'DELETE', '已删除'))}>删除</button>
      </> },
    ]} />
    <Modal title={editing?.id ? '修改' : '添加'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => void save()} okText="确定" cancelText="取消" destroyOnHidden>
      <div style={{ display: 'grid', gap: 8 }}>
        <span>*名称</span>
        <Input maxLength={20} value={editing?.name ?? ''} onChange={(event) => setEditing((current) => current ? { ...current, name: event.target.value } : current)} />
        {kind === 'status' && <><span>颜色</span><ColorPicker value={editing?.color} onChange={(value) => setEditing((current) => current ? { ...current, color: value.toHexString() } : current)} showText /></>}
      </div>
    </Modal>
  </>;
}
