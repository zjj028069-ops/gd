// 平台管理后台（/platform）：管理所有企业。独立的平台账号，与企业账号完全分开。
// 界面完全沿用原系统的外壳和列表/详情结构（kgd.css 的 class），看起来和 MES 一致。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { App as AntdApp, Breadcrumb, Button, ConfigProvider, DatePicker, Dropdown, Form, Input, InputNumber, Modal, Pagination, Popconfirm, Select, Space, Table, Tabs, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AuditOutlined, ClearOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ShopOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN.js';
import dayjs from 'dayjs';
import { ApiError, apiRequest, errorMessage } from '../../api';
import { applyStoredAppearance } from '../../kgd/appearance';
import './platform.css';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Call = <T>(path: string, method?: Method, body?: unknown) => Promise<T>;
type Me = { operator: { username: string; display_name: string }; csrf_token: string };
type Tenant = {
  id: string; slug: string; name: string; active: boolean; created_at: string; members: number; admins: string[];
  state: 'active' | 'read_only' | 'expired'; effective_state: 'active' | 'read_only' | 'expired'; expires_at: string | null;
  seat_limit: number; seat_used: number; product_limit: number; product_used: number; storage_limit_mb: number; storage_used_mb: number;
};
type Member = { id: string; username: string; display_name: string; role: 'admin' | 'planner' | 'worker'; active: boolean; user_active: boolean; tenant_count: number };
type Log = { id: string; operator_name: string; action: string; tenant_id: string | null; tenant_name: string | null; detail: Record<string, unknown>; created_at: string };
type Secret = { title: string; username: string; password: string; note?: string };
type View = { kind: 'tenants' } | { kind: 'tenant'; id: string } | { kind: 'audit' };

const ROLE: Record<string, string> = { admin: '管理员', planner: '计划员', worker: '工人' };
const STATE: Record<string, { text: string; color: string }> = { active: { text: '正常', color: 'green' }, read_only: { text: '只读', color: 'orange' }, expired: { text: '已到期', color: 'red' } };
const ACTION: Record<string, string> = {
  login: '登录平台', 'tenant.create': '新建企业', 'tenant.enable': '启用企业', 'tenant.disable': '停用企业', 'tenant.limits': '修改服务与配额',
  'member.create': '添加账号', 'member.reset_password': '重置密码', 'member.disable': '停用账号', 'member.enable': '启用账号', 'member.role': '修改角色',
};
const fmt = (s?: string | null) => (s ? dayjs(s).format('YYYY-MM-DD HH:mm') : '-');
const daysLeft = (d: string | null) => (d ? dayjs(d).endOf('day').diff(dayjs(), 'day') : null);
const PAGE_SIZES = [10, 20, 30, 50];

function viewFromUrl(): View {
  const path = window.location.pathname;
  const tenant = path.match(/^\/platform\/tenants\/([0-9a-fA-F-]{36})\/?$/);
  if (tenant) return { kind: 'tenant', id: tenant[1]! };
  if (/^\/platform\/audit\/?$/.test(path)) return { kind: 'audit' };
  return { kind: 'tenants' };
}
const urlOfView = (v: View) => (v.kind === 'tenant' ? `/platform/tenants/${v.id}` : v.kind === 'audit' ? '/platform/audit' : '/platform');

export function PlatformApp() {
  useEffect(() => { applyStoredAppearance(); document.title = '赛德瑞科 · 平台管理'; }, []);
  return <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#4184F4', borderRadius: 2 } }}>
    <AntdApp><PlatformRoot /></AntdApp>
  </ConfigProvider>;
}

function PlatformRoot() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    apiRequest<Me>('/api/platform-admin/me').then(setMe).catch(() => setMe(null)).finally(() => setChecking(false));
  }, []);
  if (checking) return <div className="startup-screen"><Brand /><p className="plat-muted">正在确认登录状态…</p></div>;
  if (!me) return <Login notice={notice} onLogin={(m) => { setNotice(''); setMe(m); }} />;
  return <Console me={me} onLogout={(msg) => { setNotice(msg); setMe(null); }} />;
}

function Brand() {
  return <div className="brand"><span className="brand-symbol" aria-hidden="true" style={{ background: '#4184F4' }}>赛</span><span>赛德瑞科<small>平台管理后台</small></span></div>;
}

/** 与原系统登录页同样的布局 */
function Login({ notice, onLogin }: { notice: string; onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { onLogin(await apiRequest<Me>('/api/platform-admin/login', { method: 'POST', body: { username: username.trim(), password } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="login-layout">
    <section className="login-intro"><Brand /><div className="login-story"><span className="intro-label">平台运营</span><h1>开通企业<br />管理服务。</h1><p>在这里新建企业、开管理员账号、设置服务期限与配额。企业的业务数据彼此隔离，平台也看不到。</p><div className="intro-features"><span>企业开通</span><span>账号管理</span><span>服务配额</span></div></div><div className="intro-decoration" aria-hidden="true"><span /><span /><span /></div></section>
    <main className="login-main"><div className="login-card"><h2 className="login-welcome">平台管理登录</h2>
      {notice ? <p className="plat-notice">{notice}</p> : null}
      {error ? <p className="plat-error" role="alert">{error}</p> : null}
      <form onSubmit={submit} className="login-form">
        <label className="form-field"><span>平台账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} required autoComplete="username" placeholder="请输入平台账号" autoCapitalize="none" spellCheck={false} autoFocus /></label>
        <label className="form-field"><span>密码</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} required autoComplete="current-password" placeholder="请输入密码" /></label>
        <button className="button button-primary login-submit" type="submit" disabled={busy}>{busy ? '正在登录…' : '登录平台'}<span aria-hidden="true">→</span></button>
      </form>
      <p className="plat-hint">这里是平台运营方的后台。企业员工请回到<a href="/">首页</a>，用企业标识登录。</p>
    </div></main>
  </div>;
}

function Console({ me, onLogout }: { me: Me; onLogout: (notice: string) => void }) {
  const { message } = AntdApp.useApp();
  const csrf = me.csrf_token;
  // 页面和网址同步：/platform（企业列表）、/platform/tenants/<id>（企业详情）、/platform/audit（日志）
  // 这样浏览器的后退、刷新、收藏都和原系统一样可用
  const [view, setViewState] = useState<View>(viewFromUrl);
  const setView = useCallback((v: View) => {
    const path = urlOfView(v);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setViewState(v);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const onPop = () => setViewState(viewFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 900); // 窄屏默认收起侧栏
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);

  const call: Call = useCallback(async <T,>(path: string, method: Method = 'GET', body?: unknown): Promise<T> => {
    try { return await apiRequest<T>(path, { method, body, csrfToken: csrf }); }
    catch (e) { if (e instanceof ApiError && e.status === 401) onLogout('平台登录已失效，请重新登录。'); throw e; }
  }, [csrf, onLogout]);

  const load = useCallback(async () => {
    try { setTenants((await call<{ items: Tenant[] }>('/api/platform-admin/tenants')).items); }
    catch (e) { message.error(errorMessage(e)); setTenants((t) => t ?? []); }
  }, [call, message]);
  useEffect(() => { void load(); }, [load]);

  const current = view.kind === 'tenant' ? (tenants ?? []).find((t) => t.id === view.id) : undefined;
  const crumb: ReactNode[] = view.kind === 'audit' ? ['平台操作日志', '列表'] : view.kind === 'tenant' ? ['企业管理', <a key="l" onClick={() => setView({ kind: 'tenants' })}>列表</a>, current?.name ?? '详情'] : ['企业管理', '列表'];
  const menus = [
    { key: 'tenants', label: '企业管理', icon: <ShopOutlined />, active: view.kind !== 'audit' },
    { key: 'audit', label: '平台操作日志', icon: <AuditOutlined />, active: view.kind === 'audit' },
  ];

  return <div className="kgd-app plat-app">
    <aside className={`kgd-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="主导航">
      <div className="kgd-sidebar-brand" title="赛德瑞科 · 平台管理"><i>赛</i>{!collapsed && <span className="kgd-sidebar-brand-text">平台管理</span>}</div>
      <nav className="kgd-sidebar-nav">
        {menus.map((m) => <div key={m.key} className={`kgd-sidebar-primary-block ${m.active ? 'is-active' : ''}`}>
          <button type="button" className={`kgd-sidebar-primary ${m.active ? 'active' : ''}`} aria-label={m.label} onClick={() => setView(m.key === 'audit' ? { kind: 'audit' } : { kind: 'tenants' })}>
            <span className="plat-menu-ico">{m.icon}</span>{!collapsed && <span className="kgd-sidebar-label">{m.label}</span>}
          </button>
        </div>)}
      </nav>
    </aside>
    <div className="kgd-main">
      <header className="kgd-top">
        <div className="kgd-top-left">
          <button className="kgd-link" aria-label="折叠菜单" onClick={() => setCollapsed((v) => !v)}>{collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}</button>
          <Breadcrumb items={[{ title: '主页' }, ...crumb.map((title) => ({ title }))]} />
          {view.kind === 'tenant' ? <button className="kgd-link" onClick={() => setView({ kind: 'tenants' })}>返回</button> : null}
        </div>
        <div className="kgd-top-right">
          <Dropdown menu={{ items: [
            { key: 'name', label: `${me.operator.display_name} · 平台管理员`, disabled: true },
            { key: 'account', label: `账号：${me.operator.username}`, disabled: true },
            { key: 'logout', label: '退出登录', onClick: async () => { try { await call('/api/platform-admin/logout', 'POST'); } catch { /* 已失效也退出 */ } onLogout('已退出平台管理后台。'); } },
          ] }}><button aria-label="头像"><span className="avatar">{Array.from(me.operator.display_name)[0] || '平'}</span></button></Dropdown>
        </div>
      </header>
      <main className="kgd-content">
        {view.kind === 'tenants' ? <TenantList tenants={tenants} call={call} onOpen={(id) => setView({ kind: 'tenant', id })} onChanged={load} onSecret={setSecret} /> : null}
        {view.kind === 'tenant' ? (current ? <TenantDetail tenant={current} call={call} onBack={() => setView({ kind: 'tenants' })} onChanged={load} onSecret={setSecret} />
          : <div className="kgd-card">{tenants === null ? '加载中…' : '企业不存在'}</div>) : null}
        {view.kind === 'audit' ? <div className="kgd-card"><h2 className="kgd-detail-title">平台操作日志</h2><AuditList call={call} /></div> : null}
      </main>
    </div>
    <SecretModal secret={secret} onClose={() => setSecret(null)} />
  </div>;
}

// ── 企业列表（与原系统列表页同样的结构：筛选药丸 + 查询格子 + 工具栏 + 表格 + 分页） ──

type Filter = 'all' | 'active' | 'soon' | 'expired' | 'disabled';

function TenantList({ tenants, call, onOpen, onChanged, onSecret }: { tenants: Tenant[] | null; call: Call; onOpen: (id: string) => void; onChanged: () => Promise<void>; onSecret: (s: Secret) => void }) {
  const { message } = AntdApp.useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [draft, setDraft] = useState({ name: '', slug: '', admin: '' });
  const [query, setQuery] = useState({ name: '', slug: '', admin: '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [creating, setCreating] = useState(false);

  const list = tenants ?? [];
  const match: Record<Filter, (t: Tenant) => boolean> = {
    all: () => true,
    active: (t) => t.active && t.effective_state === 'active',
    soon: (t) => t.active && t.effective_state === 'active' && (daysLeft(t.expires_at) ?? 9999) <= 30,
    expired: (t) => t.effective_state === 'expired',
    disabled: (t) => !t.active,
  };
  const shown = useMemo(() => list.filter(match[filter]).filter((t) =>
    (!query.name || t.name.includes(query.name)) && (!query.slug || t.slug.includes(query.slug.toLowerCase())) && (!query.admin || t.admins.some((a) => a.includes(query.admin)))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [list, filter, query]);
  const paged = shown.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { if ((page - 1) * pageSize >= shown.length && page > 1) setPage(1); }, [shown.length, page, pageSize]);

  async function toggle(t: Tenant) {
    try { await call(`/api/platform-admin/tenants/${t.id}`, 'PATCH', { active: !t.active }); message.success(t.active ? `已停用「${t.name}」，该企业所有人已下线` : `已启用「${t.name}」`); await onChanged(); }
    catch (e) { message.error(errorMessage(e)); }
  }

  const chips: [Filter, string][] = [['all', '全部'], ['active', '正常'], ['soon', '30天内到期'], ['expired', '已到期'], ['disabled', '已停用']];
  const columns: ColumnsType<Tenant> = [
    { title: '企业名称', key: 'name', render: (_, t) => <a className="kgd-link" onClick={() => onOpen(t.id)}>{t.name}</a> },
    { title: '企业标识', dataIndex: 'slug', width: 130 },
    { title: '状态', key: 'state', width: 140, render: (_, t) => <Space size={4} wrap>{t.active ? null : <Tag>已停用</Tag>}<Tag color={STATE[t.effective_state].color}>{STATE[t.effective_state].text}</Tag></Space> },
    { title: '到期时间', key: 'exp', width: 130, render: (_, t) => { const d = daysLeft(t.expires_at); return t.expires_at ? <span>{t.expires_at}{d !== null && d <= 30 ? <span className="plat-warn">（{d < 0 ? '已过期' : `剩${d}天`}）</span> : null}</span> : '不限'; } },
    { title: '管理员', key: 'admins', render: (_, t) => t.admins.length ? t.admins.join('、') : <span className="plat-warn">无</span> },
    { title: '账号数', key: 'seat', width: 90, render: (_, t) => <Usage used={t.seat_used} limit={t.seat_limit} /> },
    { title: '商品数', key: 'prod', width: 100, render: (_, t) => <Usage used={t.product_used} limit={t.product_limit} /> },
    { title: '开通时间', key: 'created', width: 140, render: (_, t) => fmt(t.created_at) },
    { title: '操作', key: 'op', width: 110, render: (_, t) => <Space size={10}>
      <a className="kgd-link" onClick={() => onOpen(t.id)}>详情</a>
      <Popconfirm title={t.active ? `停用「${t.name}」？该企业所有人会立刻下线，数据保留。` : `启用「${t.name}」？`} onConfirm={() => void toggle(t)}>
        <a className={t.active ? 'plat-danger' : 'kgd-link'}>{t.active ? '停用' : '启用'}</a>
      </Popconfirm>
    </Space> },
  ];

  const field = (key: keyof typeof draft, label: string) => <div className="kgd-q-cell" key={key}>
    <span className="kgd-q-lbl" title={label}>{label}</span>
    <Input variant="borderless" className="kgd-q-ctl" placeholder="请输入" allowClear value={draft[key]}
      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} onPressEnter={() => { setQuery({ ...draft, [key]: (draft[key] ?? '').trim() }); setPage(1); }} />
  </div>;

  return <div className="kgd-card">
    <div className="kgd-views"><span className="kgd-view-pair"><button className="kgd-view on">全部企业</button></span><span className="spacer" /></div>
    <div className="kgd-query">
      <div className="kgd-query-wrap">
        <div className="kgd-query-main">
          <div className="kgd-chips"><b>状态</b>{chips.map(([key, label]) => <button key={key} className={`kgd-chip ${filter === key ? 'on' : ''}`} onClick={() => { setFilter(key); setPage(1); }}>{label}({list.filter(match[key]).length})</button>)}</div>
          <div className="kgd-q-group"><div className="kgd-query-fields kgd-query-fields--macos">{field('name', '企业名称')}{field('slug', '企业标识')}{field('admin', '管理员账号')}</div></div>
        </div>
        <div className="kgd-q-side">
          <Button type="primary" onClick={() => { setQuery({ name: draft.name.trim(), slug: draft.slug.trim(), admin: draft.admin.trim() }); setPage(1); }}>查 询</Button>
          <Button aria-label="清除查询条件" icon={<ClearOutlined />} onClick={() => { setDraft({ name: '', slug: '', admin: '' }); setQuery({ name: '', slug: '', admin: '' }); setFilter('all'); setPage(1); }} />
        </div>
      </div>
    </div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setCreating(true)}>新 增</Button><Button onClick={() => void onChanged()}>刷 新</Button></div>
    <Table rowKey="id" columns={columns} dataSource={paged} loading={tenants === null} pagination={false} scroll={{ x: 'max-content' }}
      locale={{ emptyText: <div className="plat-empty">暂无数据<br /><span>{list.length ? '没有符合条件的企业' : '还没有企业，点「新增」开通第一个'}</span></div> }} />
    <div className="kgd-foot"><span /><Pagination size="small" current={page} pageSize={pageSize} total={shown.length} showTotal={(n) => `共${n}条数据`} showSizeChanger pageSizeOptions={PAGE_SIZES}
      onChange={(p, s) => { setPage(s !== pageSize ? 1 : p); setPageSize(s); }} /></div>
    <CreateTenant open={creating} onClose={() => setCreating(false)} call={call} onCreated={async (s, id) => { setCreating(false); onSecret(s); await onChanged(); onOpen(id); }} />
  </div>;
}

function Usage({ used, limit }: { used: number; limit: number }) {
  return <span className={limit > 0 && used >= limit ? 'plat-warn' : ''}>{used}/{limit}</span>;
}

const limitFields = <>
  <Form.Item name="expires_at" label="到期时间" extra="到这天结束后自动变为已到期；不填表示不限期"><DatePicker style={{ width: '100%' }} allowClear /></Form.Item>
  <Form.Item name="seat_limit" label="账号数上限" rules={[{ required: true, message: '请填写' }]}><InputNumber min={1} max={100000} precision={0} style={{ width: '100%' }} /></Form.Item>
  <Form.Item name="product_limit" label="商品数上限" rules={[{ required: true, message: '请填写' }]}><InputNumber min={0} max={10000000} precision={0} style={{ width: '100%' }} /></Form.Item>
  <Form.Item name="storage_limit_mb" label="附件存储上限（MB）" rules={[{ required: true, message: '请填写' }]}><InputNumber min={0} max={1048576} precision={0} style={{ width: '100%' }} /></Form.Item>
</>;

function CreateTenant({ open, onClose, call, onCreated }: { open: boolean; onClose: () => void; call: Call; onCreated: (s: Secret, id: string) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  return <Modal title="新增企业" open={open} onCancel={onClose} onOk={() => form.submit()} okText="确 定" cancelText="取 消" confirmLoading={busy} forceRender width={560}>
    <Form form={form} layout="vertical" initialValues={{ seat_limit: 50, product_limit: 10000, storage_limit_mb: 1024, expires_at: dayjs().add(1, 'year') }}
      onValuesChange={(changed) => { if (changed.slug !== undefined && !form.isFieldTouched('admin_username')) form.setFieldValue('admin_username', changed.slug ? `${changed.slug}.admin` : ''); }}
      onFinish={async (v) => {
        setBusy(true);
        try {
          const r = await call<{ tenant: { id: string; name: string; slug: string }; admin: { username: string; password: string } }>('/api/platform-admin/tenants', 'POST', {
            name: v.name.trim(), slug: v.slug, admin_username: v.admin_username.trim(), admin_name: v.admin_name.trim(),
            expires_at: v.expires_at ? dayjs(v.expires_at).format('YYYY-MM-DD') : null, seat_limit: v.seat_limit, product_limit: v.product_limit, storage_limit_mb: v.storage_limit_mb,
          });
          form.resetFields();
          onCreated({ title: `企业「${r.tenant.name}」已开通`, username: r.admin.username, password: r.admin.password, note: `登录时企业标识填「${r.tenant.slug}」。请把账号和初始密码交给企业管理员，并提醒他登录后在「个人中心」修改密码。` }, r.tenant.id);
        } catch (e) { message.error(errorMessage(e)); } finally { setBusy(false); }
      }}>
      <Form.Item name="name" label="企业名称" rules={[{ required: true, whitespace: true, message: '请输入企业名称' }, { max: 100 }]}><Input placeholder="如：华东精密制造有限公司" /></Form.Item>
      <Form.Item name="slug" label="企业标识" extra="员工登录时填写；小写字母、数字和短横线，创建后不能修改" normalize={(v: string) => (v ?? '').toLowerCase().trim()} rules={[{ required: true, message: '请输入企业标识' }, { pattern: /^[a-z0-9][a-z0-9-]{1,62}$/, message: '小写字母或数字开头，只能有小写字母、数字、短横线，至少 2 位' }]}><Input placeholder="如：huadong" /></Form.Item>
      <div className="plat-grid">
        <Form.Item name="admin_username" label="管理员账号" rules={[{ required: true, message: '请输入管理员账号' }, { pattern: /^[a-zA-Z0-9_.@-]{3,80}$/, message: '3 位以上字母、数字或 ._@-' }]}><Input placeholder="如：huadong.admin" /></Form.Item>
        <Form.Item name="admin_name" label="管理员姓名" rules={[{ required: true, whitespace: true, message: '请输入管理员姓名' }, { max: 100 }]}><Input placeholder="如：张经理" /></Form.Item>
      </div>
      <div className="plat-section">服务与配额（以后可以随时修改）</div>
      <div className="plat-grid">{limitFields}</div>
    </Form>
  </Modal>;
}

// ── 企业详情（与原系统详情页同样的结构：按钮行 + 标题 + 字段网格 + 页签） ──

function TenantDetail({ tenant, call, onBack, onChanged, onSecret }: { tenant: Tenant; call: Call; onBack: () => void; onChanged: () => Promise<void>; onSecret: (s: Secret) => void }) {
  const { message } = AntdApp.useApp();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();

  async function saveLimits(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try { await call(`/api/platform-admin/tenants/${tenant.id}/limits`, 'PUT', body); message.success(ok); setEditing(false); await onChanged(); }
    catch (e) { message.error(errorMessage(e)); } finally { setBusy(false); }
  }
  const base = { state: tenant.state, expires_at: tenant.expires_at, seat_limit: tenant.seat_limit, product_limit: tenant.product_limit, storage_limit_mb: tenant.storage_limit_mb };
  const renewFrom = tenant.expires_at && dayjs(tenant.expires_at).isAfter(dayjs()) ? dayjs(tenant.expires_at) : dayjs();
  const d = daysLeft(tenant.expires_at);

  const fields: [string, ReactNode][] = [
    ['企业名称', tenant.name], ['企业标识', tenant.slug],
    ['账号状态', tenant.active ? <Tag color="green">启用</Tag> : <Tag>已停用（无法登录）</Tag>],
    ['服务状态', <Tag key="s" color={STATE[tenant.effective_state].color}>{STATE[tenant.effective_state].text}</Tag>],
    ['到期时间', tenant.expires_at ? `${tenant.expires_at}${d !== null ? (d < 0 ? '（已过期）' : `（剩 ${d} 天）`) : ''}` : '不限期'],
    ['管理员', tenant.admins.join('、') || '无'],
    ['账号数', <Usage key="a" used={tenant.seat_used} limit={tenant.seat_limit} />],
    ['商品数', <Usage key="p" used={tenant.product_used} limit={tenant.product_limit} />],
    ['附件存储', `${tenant.storage_used_mb} / ${tenant.storage_limit_mb} MB`],
    ['开通时间', fmt(tenant.created_at)],
  ];

  return <div className="kgd-card">
    <div className="kgd-actions">
      <Button onClick={onBack}>返回</Button>
      <Button onClick={() => { form.setFieldsValue({ ...base, expires_at: tenant.expires_at ? dayjs(tenant.expires_at) : null }); setEditing(true); }}>修改服务与配额</Button>
      <Popconfirm title={`续期到 ${renewFrom.add(1, 'year').format('YYYY-MM-DD')}，并恢复为正常状态？`} onConfirm={() => void saveLimits({ ...base, state: 'active', expires_at: renewFrom.add(1, 'year').format('YYYY-MM-DD') }, '已续期一年')}><Button>续期一年</Button></Popconfirm>
      <Popconfirm title={tenant.active ? `停用「${tenant.name}」？该企业所有人会立刻下线，数据保留。` : `启用「${tenant.name}」？`}
        onConfirm={() => void (async () => { try { await call(`/api/platform-admin/tenants/${tenant.id}`, 'PATCH', { active: !tenant.active }); message.success(tenant.active ? '已停用，该企业所有人已下线' : '已启用'); await onChanged(); } catch (e) { message.error(errorMessage(e)); } })()}>
        <Button danger={tenant.active}>{tenant.active ? '停用企业' : '启用企业'}</Button>
      </Popconfirm>
    </div>
    <h2 className="kgd-detail-title">企业({tenant.name})</h2>
    <dl className="kgd-detail-grid">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <Tabs destroyOnHidden items={[
      { key: 'members', label: '账号', children: <MembersTab tenant={tenant} call={call} onChanged={onChanged} onSecret={onSecret} /> },
      { key: 'audit', label: '操作记录', children: <AuditList key={`${tenant.active}-${tenant.state}-${tenant.expires_at}-${tenant.seat_limit}-${tenant.seat_used}`} call={call} tenantId={tenant.id} /> },
    ]} />
    <Modal title="修改服务与配额" open={editing} onCancel={() => setEditing(false)} onOk={() => form.submit()} okText="确 定" cancelText="取 消" confirmLoading={busy} forceRender width={560}>
      <Form form={form} layout="vertical" onFinish={(v) => void saveLimits({ state: v.state, expires_at: v.expires_at ? dayjs(v.expires_at).format('YYYY-MM-DD') : null, seat_limit: v.seat_limit, product_limit: v.product_limit, storage_limit_mb: v.storage_limit_mb }, '已保存')}>
        <Form.Item name="state" label="服务状态" extra="只读、已到期时，企业资料仍能查看，但不能新增和修改"><Select options={[{ value: 'active', label: '正常' }, { value: 'read_only', label: '只读（暂停修改）' }, { value: 'expired', label: '已到期' }]} /></Form.Item>
        <div className="plat-grid">{limitFields}</div>
      </Form>
    </Modal>
  </div>;
}

function MembersTab({ tenant, call, onChanged, onSecret }: { tenant: Tenant; call: Call; onChanged: () => Promise<void>; onSecret: (s: Secret) => void }) {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<Member[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const load = useCallback(async () => { try { setItems((await call<{ items: Member[] }>(`/api/platform-admin/tenants/${tenant.id}/members`)).items); } catch (e) { message.error(errorMessage(e)); setItems([]); } }, [call, message, tenant.id]);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); message.success(ok); await load(); await onChanged(); } catch (e) { message.error(errorMessage(e)); } };
  const activeAdmins = (items ?? []).filter((m) => m.role === 'admin' && m.active && m.user_active).length;

  const columns: ColumnsType<Member> = [
    { title: '账号', dataIndex: 'username' },
    { title: '姓名', dataIndex: 'display_name' },
    { title: '角色', key: 'r', width: 130, render: (_, m) => <Select size="small" value={m.role} style={{ width: 100 }} options={Object.entries(ROLE).map(([value, label]) => ({ value, label }))}
      onChange={(role) => { if (m.role === 'admin' && role !== 'admin' && activeAdmins <= 1) { message.warning('这是唯一的管理员，先再添加一个管理员'); return; } void act(() => call(`/api/platform-admin/tenants/${tenant.id}/members/${m.id}`, 'PATCH', { role }), '角色已修改，该账号需要重新登录'); }} /> },
    { title: '状态', key: 's', width: 160, render: (_, m) => <Space size={4} wrap>{m.active && m.user_active ? <Tag color="green">正常</Tag> : <Tag>已停用</Tag>}{m.tenant_count > 1 ? <Tag color="blue">多企业账号</Tag> : null}</Space> },
    { title: '操作', key: 'op', width: 150, render: (_, m) => <Space size={10}>
      {m.tenant_count > 1 ? <span className="plat-muted" title="这个账号同时属于其他企业，为避免影响其他企业，不能在这里重置密码">重置密码</span>
        : <Popconfirm title={`重置「${m.username}」的密码？旧密码和已登录的会话立刻失效。`}
          onConfirm={() => void (async () => { try { const r = await call<{ username: string; password: string }>(`/api/platform-admin/tenants/${tenant.id}/members/${m.id}/reset-password`, 'POST'); onSecret({ title: '密码已重置', username: r.username, password: r.password, note: `企业标识：${tenant.slug}。旧密码和已登录的会话都已失效。` }); await load(); } catch (e) { message.error(errorMessage(e)); } })()}>
          <a className="kgd-link">重置密码</a>
        </Popconfirm>}
      <Popconfirm title={m.active ? `停用「${m.username}」？会立刻下线。` : `启用「${m.username}」？`}
        onConfirm={() => { if (m.active && m.role === 'admin' && activeAdmins <= 1) { message.warning('这是唯一的管理员，停用后企业里没人能管理了。先再添加一个管理员'); return; } void act(() => call(`/api/platform-admin/tenants/${tenant.id}/members/${m.id}`, 'PATCH', { active: !m.active }), m.active ? '已停用' : '已启用'); }}>
        <a className={m.active ? 'plat-danger' : 'kgd-link'}>{m.active ? '停用' : '启用'}</a>
      </Popconfirm>
    </Space> },
  ];
  return <div>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setAdding(true)}>新增账号</Button><span className="plat-muted">平台只管登录账号；部门、角色权限等由企业管理员在系统里自己设置。</span></div>
    <Table rowKey="id" size="small" columns={columns} dataSource={items ?? []} loading={items === null} pagination={false} />
    <Modal title="新增账号" open={adding} onCancel={() => setAdding(false)} onOk={() => form.submit()} okText="确 定" cancelText="取 消" confirmLoading={busy} forceRender>
      <Form form={form} layout="vertical" initialValues={{ role: 'admin' }} onFinish={async (v) => {
        setBusy(true);
        try {
          const r = await call<{ username: string; password: string }>(`/api/platform-admin/tenants/${tenant.id}/members`, 'POST', { username: v.username.trim(), display_name: v.display_name.trim(), role: v.role });
          setAdding(false); form.resetFields(); await load(); await onChanged();
          onSecret({ title: '账号已添加', username: r.username, password: r.password, note: `企业标识：${tenant.slug}。` });
        } catch (e) { message.error(errorMessage(e)); } finally { setBusy(false); }
      }}>
        <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }, { pattern: /^[a-zA-Z0-9_.@-]{3,80}$/, message: '3 位以上字母、数字或 ._@-' }]}><Input placeholder={`如：${tenant.slug}.admin2`} /></Form.Item>
        <Form.Item name="display_name" label="姓名" rules={[{ required: true, whitespace: true, message: '请输入姓名' }, { max: 100 }]}><Input /></Form.Item>
        <Form.Item name="role" label="角色"><Select options={Object.entries(ROLE).map(([value, label]) => ({ value, label }))} /></Form.Item>
      </Form>
    </Modal>
  </div>;
}

function AuditList({ call, tenantId }: { call: Call; tenantId?: string }) {
  const [items, setItems] = useState<Log[] | null>(null);
  useEffect(() => { call<{ items: Log[] }>(`/api/platform-admin/audit${tenantId ? `?tenant_id=${tenantId}` : ''}`).then((d) => setItems(d.items)).catch(() => setItems([])); }, [call, tenantId]);
  const detail = (l: Log): ReactNode => {
    const d = l.detail ?? {};
    if (l.action === 'tenant.limits') { const a = (d.after ?? {}) as Record<string, unknown>; return `状态 ${STATE[String(a.state)]?.text ?? a.state}，到期 ${a.expires_at ?? '不限'}，账号 ${a.seat_limit}，商品 ${a.product_limit}，存储 ${a.storage_limit_mb}MB`; }
    if (d.username) return `账号 ${d.username}${d.role ? `，角色 ${ROLE[String(d.role)] ?? d.role}` : ''}`;
    if (d.admin_username) return `管理员 ${d.admin_username}`;
    return '';
  };
  return <Table rowKey="id" size="small" loading={items === null} dataSource={items ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true, showTotal: (n) => `共${n}条数据` }}
    columns={[
      { title: '时间', key: 't', width: 150, render: (_, l) => fmt(l.created_at) },
      { title: '操作人', dataIndex: 'operator_name', width: 110 },
      { title: '操作', key: 'a', width: 140, render: (_, l) => ACTION[l.action] ?? l.action },
      ...(tenantId ? [] : [{ title: '企业', key: 'tn', width: 160, render: (_: unknown, l: Log) => l.tenant_name ?? '-' }]),
      { title: '内容', key: 'd', render: (_, l) => detail(l) },
    ]} />;
}

/** 复制文字：优先用剪贴板接口；非 HTTPS（如 http://IP）时浏览器不给用，退回旧的复制命令 */
async function copyText(text: string) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* 退回旧办法 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function SecretModal({ secret, onClose }: { secret: Secret | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  if (!secret) return null;
  const text = `账号：${secret.username}\n密码：${secret.password}`;
  return <Modal open title={secret.title} onCancel={onClose} closable={false} mask={{ closable: false }} keyboard={false}
    footer={<Space><Button onClick={() => { void copyText(text).then((ok) => (ok ? message.success('已复制') : message.warning('复制失败，请手动选中复制'))); }}>复制账号和密码</Button><Button type="primary" onClick={onClose}>我已记下</Button></Space>}>
    <dl className="kgd-detail-grid plat-secret"><div><dt>账号</dt><dd><code>{secret.username}</code></dd></div><div><dt>密码</dt><dd><code>{secret.password}</code></dd></div></dl>
    <p className="plat-warn">密码只显示这一次，关闭后无法再查看（忘了可以再重置）。</p>
    {secret.note ? <p className="plat-muted">{secret.note}</p> : null}
  </Modal>;
}
