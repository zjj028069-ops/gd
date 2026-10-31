import { useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Pagination, Select, Table } from 'antd';
import { TableOutlined } from '@ant-design/icons';
import { ColumnConfigModal } from '../../../dialogs';
import { columnStorageKey, loadJson, mergeColumnPrefs, saveJson } from '../../../storage';
import type { ColumnPrefs } from '../../../storage';
import { Hint, useList, useR10 } from '../shared';
import { layouts, moduleKinds } from './modules';
import { mesAbsPath } from '../../../../mesBase';

type ScreenRow = { id: string; menu_name: string; layout: string; module_kind: string; description: string; access_password: string; preset?: string; version?: number };

const columnDefs = [
  { key: 'seq', label: '序号' },
  { key: 'menu_name', label: '菜单名' },
  { key: 'layout', label: '布局' },
  { key: 'module_kind', label: '功能模块' },
  { key: 'description', label: '描述' },
  { key: 'access_password', label: '访问密码' },
  { key: 'actions', label: '操作' },
];

export function screenLink(row: { id: string; access_password?: string }) {
  const pwd = row.access_password ? `?pwd=${encodeURIComponent(row.access_password)}` : '';
  return `${window.location.origin}${mesAbsPath(`/_screen/pd/${row.id}`)}${pwd}`;
}

export function ScreenManagementList() {
  const r10 = useR10();
  const remote = useList<ScreenRow>('/api/data-screens');
  const rows = remote.data?.items ?? [];
  const [edit, setEdit] = useState<ScreenRow | 'new' | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const storageKey = columnStorageKey(String(r10.session.user.id), 'screen-management');
  const defaults = useMemo<ColumnPrefs>(() => ({ order: columnDefs.map((item) => item.key), visible: columnDefs.map((item) => item.key), locked: [] }), []);
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => mergeColumnPrefs(loadJson<ColumnPrefs | null>(storageKey, null), defaults, defaults.order));
  const [columnOpen, setColumnOpen] = useState(false);

  async function copyLink(row: ScreenRow) {
    try { await navigator.clipboard.writeText(screenLink(row)); r10.message.success('链接已复制'); }
    catch { r10.message.error('复制失败，请手动复制：' + screenLink(row)); }
  }

  const all = {
    seq: { title: '序号', width: 70, render: (_: unknown, __: ScreenRow, index: number) => (page - 1) * pageSize + index + 1 },
    menu_name: { title: '菜单名', dataIndex: 'menu_name' },
    layout: { title: '布局', dataIndex: 'layout' },
    module_kind: { title: '功能模块', dataIndex: 'module_kind' },
    description: { title: '描述', render: (_: unknown, row: ScreenRow) => row.description || '-' },
    access_password: { title: '访问密码', render: (_: unknown, row: ScreenRow) => row.access_password || '-' },
    actions: { title: '操作', fixed: 'right' as const, width: 380, render: (_: unknown, row: ScreenRow) => <>
      <Button type="link" size="small" onClick={() => window.open(screenLink(row), '_blank', 'noopener')}>查看大屏</Button>
      <Button type="link" size="small" onClick={() => void copyLink(row)}>复制大屏链接</Button>
      <Button type="link" size="small" onClick={() => window.open(mesAbsPath(`/_screen/editpd/${row.id}`), '_blank', 'noopener')}>设计</Button>
      <Button type="link" size="small" onClick={() => setEdit(row)}>修改</Button>
      <Button type="link" size="small" danger onClick={() => r10.confirmDelete('删除大屏', () => r10.act(`/api/data-screens/${row.id}`, {}, 'DELETE', '已删除'), `确定删除「${row.menu_name}」？删除后菜单中的入口也会去掉。`)}>删除</Button>
    </> },
  } as const;
  const columns = prefs.order.filter((key) => prefs.visible.includes(key)).map((key) => ({ key, ...all[key as keyof typeof all] }));

  return <div className="kgd-card">
    <div className="kgd-toolbar" style={{ justifyContent: 'space-between' }}>
      <Button type="primary" onClick={() => setEdit('new')}>+ 新增</Button>
      <Button type="primary" icon={<TableOutlined />} onClick={() => setColumnOpen(true)}>列配置</Button>
    </div>
    {(remote.error || r10.error) && <div className="kgd-banner">{remote.error || r10.error}</div>}
    <Table size="small" rowKey="id" loading={remote.loading} pagination={false} dataSource={rows.slice((page - 1) * pageSize, page * pageSize)} columns={columns} scroll={{ x: 'max-content' }} />
    <div className="kgd-foot"><span /><Pagination current={page} pageSize={pageSize} total={rows.length} showSizeChanger pageSizeOptions={[10, 20, 30, 50]} showTotal={(count) => `共${count}条数据`} onChange={(next, size) => { setPage(next); setPageSize(size); }} /></div>
    {edit && <ScreenModal row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    <ColumnConfigModal open={columnOpen} columns={columnDefs} value={prefs} onCancel={() => setColumnOpen(false)} onOk={(next) => { setPrefs(next); saveJson(storageKey, next); setColumnOpen(false); }} />
  </div>;
}

function ScreenModal({ row, onClose }: { row: ScreenRow | null; onClose: () => void }) {
  const r10 = useR10();
  const [form, setForm] = useState({ menu_name: row?.menu_name ?? '', layout: row?.layout ?? '默认', module_kind: row?.module_kind ?? '', description: row?.description && row.description !== '-' ? row.description : '', access_password: row?.access_password ?? '' });
  const [nameErr, setNameErr] = useState('');
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function save() {
    if (!form.menu_name.trim()) { setNameErr('请填写菜单名'); r10.message.error('请填写菜单名'); return; }
    setNameErr('');
    if (!form.layout) { r10.message.error('请选择布局'); return; }
    if (!form.module_kind) { r10.message.error('请选择功能模块'); return; }
    if (form.access_password.length > 16) { r10.message.warning('访问密码最多16位'); return; }
    const body = { menu_name: form.menu_name.trim(), layout: form.layout, module_kind: form.module_kind, description: form.description, access_password: form.access_password };
    const result = await r10.act(row ? `/api/data-screens/${row.id}` : '/api/data-screens', body, row ? 'PATCH' : 'POST');
    if (result) onClose();
  }
  return <Modal title={row ? '修改大屏' : '新增大屏'} open onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={r10.busy} destroyOnHidden>
    <Form layout="vertical">
      <Form.Item label={<span>菜单名<Hint text="大屏名称，同时作为左侧「数据大屏」菜单下的入口名" /></span>} required validateStatus={nameErr ? 'error' : undefined} help={nameErr || undefined}><Input className={nameErr ? 'kgd-field-error' : undefined} maxLength={30} value={form.menu_name} onChange={(event) => { setNameErr(''); set('menu_name', event.target.value); }} /></Form.Item>
      <Form.Item label="布局" required><Select value={form.layout} options={layouts.map((value) => ({ value, label: value }))} onChange={(value) => set('layout', value)} /></Form.Item>
      <Form.Item label="功能模块" required><Select placeholder="请选择" value={form.module_kind || undefined} options={moduleKinds.map((value) => ({ value, label: value }))} onChange={(value) => set('module_kind', value)} /></Form.Item>
      <Form.Item label="描述"><Input.TextArea maxLength={255} showCount rows={3} value={form.description} onChange={(event) => set('description', event.target.value)} /></Form.Item>
      <Form.Item label="访问密码"><Input maxLength={16} placeholder="不填写默认不需要密码登录" value={form.access_password} onChange={(event) => set('access_password', event.target.value)} /></Form.Item>
    </Form>
  </Modal>;
}
