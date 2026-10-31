import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { App, Button, Form, Input, Select } from 'antd';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import { useQueryState } from '../../kit';
import { PermissionTree } from './PermissionTree';

type UserRow = { id: string; username: string; display_name: string; phone: string; role_name: string; department_id?: string | null; department_path: string; team_names: string; team_ids?: string[]; status_text: string; active: boolean; custom_role_id: string | null; version: number; user_points: string[] | null; user_scopes: Record<string, 'self' | 'team' | 'all'>; user_type?: string; seat_text?: string; created_text?: string };
type Role = { id: string; name: string; points: string[]; scopes: Record<string, 'self' | 'team' | 'all'> };
type Catalog = { modules: { key: string; name: string; groups: { name: string; points: { code: string; name: string; scopes?: ('self' | 'team' | 'all')[] }[] }[] }[] };
const ignoreExpired = () => undefined;

export function UserPages() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/user/add') || pathname.includes('/user/edit')) return <UserForm key={pathname} />;
  return <UserList />;
}

function UserList() {
  const navigate = useNavigate();
  const { revision, onExpired, session, onChanged } = useKgd();
  const { message } = App.useApp();
  const list = useQueryState();
  const remote = useRemote<{ items: UserRow[] }>('/api/system/users', revision, onExpired);
  async function disable(row: UserRow) {
    try {
      await apiRequest(`/api/system/users/${row.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body: { active: !row.active } });
      message.success(row.active ? '已停用' : '已启用');
      onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  }
  const rows = remote.data?.items ?? [];
  return <ListFrame pageKey="users" rows={rows} loading={remote.loading} error={remote.error}
    queryFields={[{ key: 'name', label: '用户名/姓名' }, { key: 'team', label: '团队' }, { key: 'dept', label: '部门' }, { key: 'phone', label: '手机号' }, { key: 'role', label: '角色' }, { key: 'type', label: '用户类型' }, { key: 'seat', label: '席位' }, { key: 'created_from', label: '创建时间起', kind: 'date' }, { key: 'created_to', label: '创建时间止', kind: 'date' }]}
    queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
    toolbar={<Button type="primary" onClick={() => navigate('/user/add')}>新增</Button>}
    columns={[
      { key: 'name', title: '姓名', render: (row) => row.display_name },
      { key: 'username', title: '用户名', render: (row) => row.username },
      { key: 'seat', title: '席位', render: (row) => row.seat_text || '生产' },
      { key: 'type', title: '用户类型', render: (row) => row.user_type || '普通用户' },
      { key: 'face', title: '人脸头像', render: () => '-' },
      { key: 'team', title: '团队', render: (row) => row.team_names || '-' },
      { key: 'dept', title: '部门', render: (row) => row.department_path || '-' },
      { key: 'phone', title: '手机号', render: (row) => row.phone || '-' },
      { key: 'role', title: '角色', render: (row) => row.role_name || '-' },
      { key: 'status', title: '启用/禁用', render: (row) => row.status_text },
      { key: 'created', title: '创建时间', render: (row) => row.created_text || '-' },
      { key: 'actions', title: '操作', render: (row) => <><Button type="link" onClick={() => navigate(`/user/edit/${row.id}`)}>修改</Button><Button type="link" onClick={() => void disable(row)}>{row.active ? '禁用' : '启用'}</Button></> },
    ]} />;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const sameScopes = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? '') === (b[k] ?? ''));
};

function UserForm() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const editId = pathname.includes('/user/edit/') ? decodeURIComponent(pathname.split('/user/edit/')[1]?.split(/[/?#]/)[0] ?? '') : '';
  const editing = Boolean(editId);
  const { revision, onExpired, session, onChanged } = useKgd();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [, setFailed] = useState(false);
  const [filled, setFilled] = useState(!editing);
  const users = useRemote<{ items: UserRow[] }>(editing ? '/api/system/users' : null, revision, onExpired);
  const roles = useRemote<{ items: Role[] }>('/api/system/roles', 0, ignoreExpired);
  const deps = useRemote<{ items: { id: string; path: string }[] }>('/api/system/departments', 0, ignoreExpired);
  const teams = useRemote<{ items: { id: string; name: string }[] }>('/api/system/teams', 0, ignoreExpired);
  const seats = useRemote<{ seat_label: string }>('/api/system/users', editing ? 0 : revision, ignoreExpired);
  const catalog = useRemote<Catalog>('/api/system/permission-catalog', 0, ignoreExpired);
  const [points, setPoints] = useState<string[] | null>(null);
  const [scopes, setScopes] = useState<Record<string, 'self' | 'team' | 'all'>>({});
  useEffect(() => {
    if (!editing || filled) return;
    const row = users.data?.items.find((item) => item.id === editId);
    if (!row || !roles.data) return;
    form.setFieldsValue({
      username: row.username,
      display_name: row.display_name === '-' ? '' : row.display_name,
      phone: row.phone === '-' ? '' : row.phone,
      custom_role_id: row.custom_role_id ?? undefined,
      department_id: row.department_id ?? undefined,
      team_ids: row.team_ids ?? [],
      seat: 'produce',
    });
    const role = roles.data.items.find((item) => item.id === row.custom_role_id);
    setPoints(row.user_points ?? role?.points ?? []);
    setScopes(row.user_points ? row.user_scopes ?? {} : role?.scopes ?? {});
    setFilled(true);
  }, [editId, editing, filled, form, roles.data, users.data]);
  async function submit() {
    try {
      if (editing && !filled) { message.error('正在读取用户'); return; }
      const values = await form.validateFields();
      setFailed(false);
      // 勾选的权限和角色自带的完全一样时记为「跟随角色」，以后改角色权限会自动同步到这个人
      const role = roles.data?.items.find((item) => item.id === values.custom_role_id);
      const sameAsRole = !!role && !!points && sameList(points, role.points ?? []) && sameScopes(scopes, role.scopes ?? {});
      const followRole = points === null || sameAsRole;
      const body = { ...values, seat: 'produce', user_points: followRole ? null : points, user_scopes: followRole ? {} : scopes, follow_role: followRole };
      if (editing) {
        if (!body.password) delete body.password;
        await apiRequest(`/api/system/users/${editId}`, { method: 'PATCH', csrfToken: session.csrf_token, body });
      } else {
        await apiRequest('/api/system/users', { method: 'POST', csrfToken: session.csrf_token, body });
      }
      message.success('已保存');
      onChanged();
      navigate('/user/list');
    } catch (error) {
      setFailed(true);
      if (error instanceof Error && !String(error.message).includes('validate')) message.error(error.message);
    }
  }
  return <div className="kgd-card">
    <Form form={form} layout="vertical" onFinish={() => void submit()}>
      <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请填写用户名' }, { min: 3, message: '账号至少3个字符（中文按字计算）' }, { max: 80, message: '账号不能超过80字' }]}><Input disabled={editing} placeholder="至少3个字符，可用中文" /></Form.Item>
      <Form.Item name="display_name" label="姓名" rules={[{ required: true, message: '请填写姓名' }]}><Input /></Form.Item>
      <Form.Item name="phone" label="手机号" rules={[{ required: true, message: '请填写手机号' }]}><Input /></Form.Item>
      {!editing && <Form.Item name="password" label="密码" rules={[{ required: true, message: '请填写密码' }, { min: 6, message: '密码至少6位' }]}><Input.Password /></Form.Item>}
      {editing && <Form.Item name="password" label="新密码" extra="不修改请留空；修改后该账号已登录的地方会全部下线" rules={[{ min: 6, message: '密码至少6位' }, { max: 128, message: '密码不能超过128位' }]}><Input.Password autoComplete="new-password" placeholder="不修改请留空" /></Form.Item>}
      <Form.Item name="custom_role_id" label="角色" rules={[{ required: true, message: '请选择角色' }]}><Select showSearch optionFilterProp="label" options={(roles.data?.items ?? []).map((role) => ({ value: role.id, label: role.name }))} onChange={(id) => { const role = roles.data?.items.find((item) => item.id === id); setPoints(role?.points ?? []); setScopes(role?.scopes ?? {}); }} /></Form.Item>
      <Form.Item name="department_id" label="部门"><Select showSearch optionFilterProp="label" allowClear options={(deps.data?.items ?? []).map((item) => ({ value: item.id, label: item.path }))} /></Form.Item>
      <Form.Item name="team_ids" label="团队" rules={[{ required: true, message: '请选择团队' }]}><Select showSearch optionFilterProp="label" mode="multiple" options={(teams.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} /></Form.Item>
      <Form.Item name="seat" label="所属席位" rules={[{ required: true, message: '请选择所属席位' }]} initialValue="produce">
        <Select options={[{ value: 'produce', label: seats.data?.seat_label ?? '生产席位 剩余：-' }]} />
      </Form.Item>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <Button type="primary" htmlType="submit">确定</Button>
        <Button onClick={() => navigate('/user/list')}>取消</Button>
      </div>
    </Form>
    {catalog.data && points && <PermissionTree modules={catalog.data.modules} points={points} scopes={scopes} onChange={(next, nextScopes) => { setPoints(next); setScopes(nextScopes); }} />}
  </div>;
}
