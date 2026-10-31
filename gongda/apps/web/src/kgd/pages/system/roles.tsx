import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { App, Button, Input } from 'antd';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import { useQueryState } from '../../kit';
import { PermissionTree } from './PermissionTree';

type Role = { id: string; name: string; version: number; points: string[]; scopes: Record<string, 'self' | 'team' | 'all'>; user_count?: number; created_text?: string };
type Catalog = { modules: Parameters<typeof PermissionTree>[0]['modules'] };
const ignoreExpired = () => undefined;

export function RolePages() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/role/add') || pathname.startsWith('/role/edit')) return <RoleForm />;
  return <RoleList />;
}

function RoleList() {
  const navigate = useNavigate();
  const { revision, onExpired, session, onChanged } = useKgd();
  const { message } = App.useApp();
  const list = useQueryState();
  const remote = useRemote<{ items: Role[] }>('/api/system/roles', revision, onExpired);
  const rows = remote.data?.items ?? [];
  return <ListFrame pageKey="roles" rows={rows} loading={remote.loading} error={remote.error}
    queryFields={[{ key: 'name', label: '角色名' }, { key: 'created_from', label: '创建时间起', kind: 'date' }, { key: 'created_to', label: '创建时间止', kind: 'date' }]}
    queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
    toolbar={<Button type="primary" onClick={() => navigate('/role/add')}>新增</Button>}
    columns={[
      { key: 'name', title: '角色名', render: (row) => row.name },
      { key: 'users', title: '用户', render: (row) => row.user_count ?? 0 },
      { key: 'created', title: '创建时间', render: (row) => row.created_text || '-' },
      { key: 'actions', title: '操作', render: (row) => <>
        <Button type="link" onClick={() => navigate(`/role/edit/${row.id}`)}>修改</Button>
        <Button type="link" danger onClick={() => void apiRequest(`/api/system/roles/${row.id}`, { method: 'DELETE', csrfToken: session.csrf_token }).then(() => { message.success('已删除'); onChanged(); }).catch((error) => message.error(error instanceof Error ? error.message : '删除失败'))}>删除</Button>
      </> },
    ]} />;
}

function RoleForm() {
  const { pathname } = useLocation();
  const id = pathname.split('/').pop();
  const editing = pathname.startsWith('/role/edit');
  const navigate = useNavigate();
  const { session, onChanged } = useKgd();
  const { message } = App.useApp();
  const catalog = useRemote<Catalog>('/api/system/permission-catalog', 0, ignoreExpired);
  const current = useRemote<{ items: Role[] }>(editing ? '/api/system/roles' : '', 0, ignoreExpired);
  const role = current.data?.items.find((item) => item.id === id);
  const [name, setName] = useState('');
  const [nameErr, setNameErr] = useState('');
  const [points, setPoints] = useState<string[]>([]);
  const [scopes, setScopes] = useState<Record<string, 'self' | 'team' | 'all'>>({});
  const [ready, setReady] = useState(!editing);
  if (role && !ready) { setName(role.name); setPoints(role.points); setScopes(role.scopes); setReady(true); }
  async function save() {
    if (!name.trim()) { setNameErr('请填写角色名称'); message.error('请填写角色名称'); return; }
    setNameErr('');
    const body = { name, points, scopes, version: role?.version };
    try {
      if (editing && role) await apiRequest(`/api/system/roles/${role.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body });
      else await apiRequest('/api/system/roles', { method: 'POST', csrfToken: session.csrf_token, body });
      message.success('已保存');
      onChanged();
      navigate('/role/list');
    } catch (error) { message.error(error instanceof Error ? error.message : '保存失败'); }
  }
  return <div className="kgd-card">
    {nameErr ? <div className="kgd-banner kgd-field-error">{nameErr}</div> : null}
    <div style={{ marginBottom: 12 }}><span className={nameErr ? 'kgd-field-error-label' : undefined}>角色名称*</span> <Input className={nameErr ? 'kgd-field-error' : undefined} style={{ width: 240 }} value={name} onChange={(event) => { setNameErr(''); setName(event.target.value); }} /></div>
    {catalog.data && <PermissionTree modules={catalog.data.modules} points={points} scopes={scopes} onChange={(next, nextScopes) => { setPoints(next); setScopes(nextScopes); }} />}
    <div className="kgd-actions"><Button onClick={() => navigate('/role/list')}>返回</Button><Button type="primary" onClick={() => void save()}>确定</Button><Button type="primary" onClick={() => void save()}>提交</Button></div>
  </div>;
}
