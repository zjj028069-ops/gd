import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Breadcrumb, Dropdown, Modal } from 'antd';
import { DashboardOutlined, DesktopOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';

import { hasPermission, roleName } from '../api';
import { apiRequest } from '../api';
import { useRemote } from '../masterTools';
import { useKgd } from './context';
import { MessageBell } from './MessageBell';
import { filterSidebarMenus, findMenuByPath, primaryMenus, screenMenuNodes } from './menu';
import type { MenuNode, PrimaryMenu, ScreenMenuRow } from './menu';
import { specForPath } from './pageSpec';
import { moduleHidden, setHiddenModules } from './pages/system/modules';
import { AsyncQr } from './qr';
import { mobileHomeUrl } from './pages/mobile/device';
import { AiShell } from '../modules/ai/AiShell';
import { ModeSwitch, useDockMode } from '../modules/sbot/opMode';
import { DemoDock } from '../modules/sbot/DemoDock';
import { mesAbsPath } from '../mesBase';
import { AppearanceSwitcher, applyStoredAppearance } from './appearance';

function PrimaryIcon({ name }: { name: string }) {
  const props = { className: 'kgd-sidebar-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  switch (name) {
    case 'appstore':
      return <svg {...props}><rect x="3.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.2" /></svg>;
    case 'dashboard':
      return <svg {...props}><rect x="3" y="4" width="18" height="12" rx="1.4" /><path d="M9 20h6M12 16v4" /></svg>;
    case 'bar':
      return <svg {...props}><path d="M4 19.5h16" /><path d="M7 19.5V12M12 19.5V7M17 19.5V14" /></svg>;
    case 'team':
      return <svg {...props}><circle cx="12" cy="8" r="3" /><path d="M5.5 19.2c.9-3.1 3.1-4.6 6.5-4.6s5.6 1.5 6.5 4.6" /></svg>;
    case 'thunder':
      return <svg {...props}><path d="M13 2.8 5.8 13.2h5.2L9.6 21.2 18.2 10.2h-5.4L13 2.8z" /></svg>;
    case 'tool':
      return <svg {...props}><path d="M14.6 6.4a3.4 3.4 0 0 0-4.6 4L4.2 16.2 7.8 19.8l5.8-5.8a3.4 3.4 0 0 0 4-4.6L15 12.2 11.8 9l2.8-2.6z" /></svg>;
    case 'setting':
      return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M12 3.2v2.3M12 18.5V20.8M3.2 12h2.3M18.5 12h2.3M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6" /></svg>;
    case 'shopping':
      return <svg {...props}><circle cx="9" cy="19" r="1.2" fill="currentColor" stroke="none" /><circle cx="17" cy="19" r="1.2" fill="currentColor" stroke="none" /><path d="M3.8 5h2.2l1.5 9.1a1.4 1.4 0 0 0 1.4 1.2h8.2a1.4 1.4 0 0 0 1.4-1.1L20.2 8H7" /></svg>;
    case 'inbox':
      return <svg {...props}><path d="M4 9.2 6.4 4.8h11.2L20 9.2V19.2H4V9.2z" /><path d="M4 9.2h4.2l1.2 2.3h5.2l1.2-2.3H20" /></svg>;
    case 'api':
      return <svg {...props}><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M12 3.2V7M12 17v3.8M3.2 12H7M17 12h3.8" /></svg>;
    case 'gold':
      return <svg {...props}><path d="M12 3.2 20 7.8v8.4L12 20.8 4 16.2V7.8L12 3.2z" /><path d="M12 12 4 7.8M12 12l8-4.2M12 12v8.8" /></svg>;
    case 'robot':
      return <svg {...props}><rect x="5" y="8" width="14" height="10" rx="2" /><path d="M12 8V4.2M9.2 12.2h.01M14.8 12.2h.01M9 15.6h6" /></svg>;
    case 'bell':
      return <svg {...props}><path d="M6 16.2V11a6 6 0 1 1 12 0v5.2l1.6 1.6H4.4L6 16.2z" /><path d="M10 18.6a2 2 0 0 0 4 0" /></svg>;
    case 'notice':
      return <svg {...props}><path d="M7 3.5h8l4 4V20.5H7v-17z" /><path d="M15 3.5V8h4M9.5 12h6M9.5 15.5h6" /></svg>;
    case 'control':
      return <svg {...props}><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="1.7" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.7" fill="currentColor" stroke="none" /><circle cx="8" cy="17" r="1.7" fill="currentColor" stroke="none" /></svg>;
    default:
      return <svg {...props}><rect x="5" y="5" width="14" height="14" rx="2" /></svg>;
  }
}

function SubItemIcon({ name }: { name?: string }) {
  const props = { className: 'kgd-sidebar-sub-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  if (name === 'gauge') return <DashboardOutlined className="kgd-sidebar-sub-ico ant" />;
  if (name === 'screen') return <DesktopOutlined className="kgd-sidebar-sub-ico ant" />;
  switch (name) {
    case 'box':
      return <svg {...props}><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7z" /><path d="M12 12 4 8.5M12 12l8-3.5M12 12v8" /></svg>;
    case 'gear':
      return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" /></svg>;
    case 'list':
      return <svg {...props}><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" /></svg>;
    case 'route':
      return <svg {...props}><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M8 7.5c4 0 4 9 8 9" /></svg>;
    default:
      return <svg {...props}><rect x="5" y="5" width="14" height="14" rx="2.5" /><path d="M9 12h6" /></svg>;
  }
}

function subIconFor(node: MenuNode): string | undefined {
  if (node.iconName) return node.iconName;
  const k = node.key;
  if (k.includes('bom') || k.includes('goods-list') || k.includes('list')) return 'list';
  if (k.includes('setting') || k.includes('base')) return 'gear';
  if (k.includes('route') || k.includes('process') || k.includes('工序')) return 'route';
  if (k.includes('goods') || k.includes('stock') || k.includes('warehouse')) return 'box';
  return undefined;
}

const menuPoint: Record<string, string> = {
  customer: 'customer.', quote: 'customer.quote.view', contract: 'customer.contract.view', cash: 'customer.cash.view', invoice: 'customer.invoice.view', 'sales-fee': 'customer.expense.view', follow: 'customer.list.follow', 'customer-list': 'customer.list.view', 'customer-setting': 'customer.setting.', 'customer-base': 'customer.setting.base', 'customer-audit': 'customer.setting.audit',
  report: 'menu.report.view', screen: 'menu.screen.view', lean: 'menu.lean.view', produce: 'menu.produce.view', device: 'menu.device.view', supply: 'menu.supply.view', warehouse: 'menu.warehouse.view', iot: 'menu.device-smart.view', goods: 'menu.goods.view', ai: 'menu.ai.view', info: 'info.message.view', system: 'system.',
};

function matchPoint(points: string[], point: string) {
  if (point.endsWith('.')) return points.some((item) => item.startsWith(point));
  return points.includes(point);
}

function permissionFallback(node: { permission?: string | string[] }, session: ReturnType<typeof useKgd>['session']) {
  if (!node.permission) return false;
  const list = Array.isArray(node.permission) ? node.permission : [node.permission];
  return list.some((item) => hasPermission(session, item));
}

/** points 模式下无显式 point 时，回退到 permission 或父模块 menu.*.view，避免叶子被一律裁秃 */
function pointsFallback(node: { key?: string; permission?: string | string[] }, session: ReturnType<typeof useKgd>['session']) {
  if (permissionFallback(node, session)) return true;
  const key = node.key ?? '';
  const moduleView: Record<string, string> = {
    customer: 'menu.customer.view', report: 'menu.report.view', screen: 'menu.screen.view', lean: 'menu.lean.view',
    produce: 'menu.produce.view', device: 'menu.device.view', supply: 'menu.supply.view', warehouse: 'menu.warehouse.view',
    iot: 'menu.device-smart.view', goods: 'menu.goods.view', ai: 'menu.ai.view', info: 'info.message.view', system: 'system.',
  };
  // 子 key 常见前缀 → 模块 view（报工记录已改 key，不再撞 report）
  const prefixMap: [string, string][] = [
    ['customer', 'customer.'], ['report-', 'menu.report.view'], ['screen', 'menu.screen.view'], ['lean', 'menu.lean.view'],
    ['produce', 'menu.produce.view'], ['device', 'menu.device.view'], ['purchase', 'menu.supply.view'], ['supplier', 'menu.supply.view'],
    ['mt-', 'menu.supply.view'], ['os-', 'menu.produce.view'], ['qc-', 'menu.produce.view'], ['in-', 'menu.warehouse.view'],
    ['out-', 'menu.warehouse.view'], ['goods', 'menu.goods.view'], ['stock', 'menu.warehouse.view'], ['transfer', 'menu.warehouse.view'],
    ['ai', 'menu.ai.view'], ['system', 'system.'], ['message', 'info.message.view'], ['knowledge', 'info.message.view'], ['notice', 'info.message.view'],
  ];
  for (const [prefix, point] of prefixMap) {
    if (key === prefix || key.startsWith(prefix) || key.startsWith(prefix + '-')) {
      if (matchPoint(session.points!, point)) return true;
    }
  }
  for (const [mod, point] of Object.entries(moduleView)) {
    if (key === mod || key.startsWith(mod + '-')) {
      if (matchPoint(session.points!, point)) return true;
    }
  }
  return false;
}

function allowed(node: { key?: string; permission?: string | string[]; allScope?: boolean; point?: string }, session: ReturnType<typeof useKgd>['session']) {
  const key = node.key ?? '';
  if (moduleHidden(key)) return false;
  if (key === 'workplace' || key === 'workplace-home') return true;
  if (key.startsWith('screen-') && key !== 'screen-manage') return true;
  const point = node.point || menuPoint[key];
  if (point && !point.endsWith('.') && !Array.isArray(session.points) && session.role !== 'admin' && point.startsWith('system.')) {
    const need = point === 'system.log' ? 'audit.read' : 'organization.manage';
    if (!hasPermission(session, need)) return false;
  }
  if (Array.isArray(session.points)) {
    if (key === 'personal') return true;
    if (point) return matchPoint(session.points, point);
    // 无 point：回退 permission / 父模块 menu.*.view，勿一律隐藏
    return pointsFallback(node, session);
  }
  if (key === 'customer') return hasPermission(session, 'sales.read') || hasPermission(session, 'finance.read');
  if (node.allScope && session.data_scope !== 'all') return false;
  if (!node.permission) return true;
  return permissionFallback(node, session);
}

function menuVisible(node: { key?: string; path?: string; permission?: string | string[]; allScope?: boolean; point?: string; children?: MenuNode[] }, session: ReturnType<typeof useKgd>['session']): boolean {
  if (!allowed(node, session)) return false;
  const children = node.children ?? [];
  if (!children.length || node.path) return true;
  return children.some((child) => menuVisible(child, session));
}

function SubTree({ nodes, depth = 0 }: { nodes: MenuNode[]; depth?: number }) {
  const { session } = useKgd();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const match = findMenuByPath(location.pathname);
  useEffect(() => {
    const next: Record<string, boolean> = {};
    findMenuByPath(location.pathname)?.chain.forEach((node) => { next[node.key] = true; });
    setOpen((current) => ({ ...next, ...current }));
  }, [location.pathname]);
  return <>{nodes.map((node) => {
    const ok = menuVisible(node, session);
    if (!ok) return null;
    const active = match?.chain.some((item) => item.key === node.key);
    if (node.children?.length) {
      return <div key={node.key} className="kgd-sidebar-group">
        <button type="button" className={`kgd-sidebar-item kgd-sidebar-branch depth-${Math.min(depth, 3)} ${active ? 'active' : ''}`} disabled={!ok} title={ok ? undefined : '当前角色没有查看权限'} onClick={() => setOpen((current) => ({ ...current, [node.key]: !current[node.key] }))}>
          <SubItemIcon name={subIconFor(node)} />
          <span className="kgd-sidebar-label">{node.label}</span>
          <span className="kgd-sidebar-chevron">{open[node.key] ? '▾' : '▸'}</span>
        </button>
        {open[node.key] && ok && <div className="kgd-sidebar-nest"><SubTree nodes={node.children} depth={depth + 1} /></div>}
      </div>;
    }
    return <button key={node.key} type="button" data-label={node.label} className={`kgd-sidebar-item depth-${Math.min(depth, 3)} ${active ? 'active' : ''}`} disabled={!ok} title={ok ? undefined : '当前角色没有查看权限'} onClick={() => {
      if (!ok) return;
      if (node.screenId) window.open(mesAbsPath(`/_screen/pd/${node.screenId}`), '_blank', 'noopener');
      else if (node.path) navigate(node.path);
    }}>
      <SubItemIcon name={subIconFor(node)} />
      <span className="kgd-sidebar-label">{node.label}</span>
    </button>;
  })}</>;
}

export function Shell() {
  const { session, onLogout, logoutBusy, revision, onExpired } = useKgd();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [primary, setPrimary] = useState('produce');
  /** 一级内联展开（与选中高亮解耦，便于 ▾ 单独收起） */
  const [expandedPrimary, setExpandedPrimary] = useState<string | null>(null);
  /** 用户点三角手动收起的一级；路由仍在该模块时尊重收起，换模块或再点展开后清除 */
  const manualCollapsedPrimary = useRef<string | null>(null);
  const [brand, setBrand] = useState('赛德瑞科');
  const [logo, setLogo] = useState('');
  const [appQr, setAppQr] = useState(false);
  /** 仅嵌入聊天壳 iframe 时显示「返回聊天」；嵌入时顶栏用户入口改由聊天壳左下角承接 */
  const [inChatShell, setInChatShell] = useState(false);
  const dockMode = useDockMode();
  const [wpFullscreen, setWpFullscreen] = useState(false);
  const [extMenus, setExtMenus] = useState<MenuNode[]>([]);
  const isWorkplace = location.pathname === '/staging/area' || location.pathname.startsWith('/staging/area/');
  useEffect(() => {
    let embedded = false;
    try {
      embedded = typeof window !== 'undefined' && window.parent !== window;
      setInChatShell(embedded);
    } catch {
      embedded = true;
      setInChatShell(true);
    }
    // v1.0.53：告诉聊天壳 MES React 壳已就绪，可揭显 iframe
    if (embedded) {
      const notify = () => {
        try {
          window.parent.postMessage({ type: 'sedric-mes-ready' }, window.location.origin);
        } catch {
          try { window.parent.postMessage({ type: 'sedric-mes-ready' }, '*'); } catch { /* ignore */ }
        }
      };
      notify();
      const t1 = window.setTimeout(notify, 300);
      const t2 = window.setTimeout(notify, 1200);
      return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
    }
  }, []);
  useEffect(() => {
    applyStoredAppearance();
  }, []);
  useEffect(() => {
    const onFs = () => setWpFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  /** 聊天壳 postMessage 导航（个人中心 / 企业设置） */
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      try {
        if (ev.origin && ev.origin !== window.location.origin) return;
        const data = ev.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'sedric-mes-navigate' && typeof data.path === 'string' && data.path) {
          navigate(data.path.startsWith('/') ? data.path : `/${data.path}`);
        }
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);
  function emitWorkplaceAction(action: 'fullscreen' | 'refresh' | 'configure') {
    try {
      window.dispatchEvent(new CustomEvent('sedric-workplace-action', { detail: { action } }));
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    void apiRequest<{ items: { id: string; menu_label: string; menu_path: string; status: string; menu_visible?: boolean }[] }>('/api/ai/ext-apps?status=enabled')
      .then((result) => {
        setExtMenus((result.items ?? [])
          .filter((item) => item.menu_label && item.menu_path && item.menu_visible !== false)
          .map((item) => ({
            key: `ext-app-${item.id}`,
            label: item.menu_label,
            path: item.menu_path,
            status: 'rebuild' as const,
            point: 'menu.produce.view',
            permission: 'production.read',
            allScope: true,
          })));
      })
      .catch(() => setExtMenus([]));
  }, [session.user.id, revision]);
  useEffect(() => {
    void apiRequest<{ enterprise: { name?: string; logo?: string; produce_module?: boolean; device_module?: boolean; aftersales_module?: boolean } }>('/api/system/enterprise').then((result) => {
      setHiddenModules(result.enterprise);
      setBrand(result.enterprise.name || '赛德瑞科');
      setLogo(result.enterprise.logo || '');
    }).catch(() => { setBrand('赛德瑞科'); setLogo(''); });
  }, [session.user.id, revision]);
  const current = useMemo(() => findMenuByPath(location.pathname), [location.pathname]);
  useEffect(() => {
    if (!current) return;
    const key = current.primary.key;
    setPrimary(key);
    if (manualCollapsedPrimary.current === key) {
      setExpandedPrimary(null);
      return;
    }
    manualCollapsedPrimary.current = null;
    setExpandedPrimary(key);
  }, [current]);
  const screenAllowed = allowed(primaryMenus.find((item) => item.key === 'screen') ?? { key: 'screen' }, session);
  const screens = useRemote<{ items: ScreenMenuRow[] }>(screenAllowed ? '/api/data-screens' : null, revision, onExpired);
  const deviceOn = !moduleHidden('device');
  const screenRows = (screens.data?.items ?? []).filter((row) => deviceOn || row.module_kind !== '设备维保模块');
  function childrenFor(item: PrimaryMenu): MenuNode[] {
    const base = item.children ?? [];
    if (item.key === 'screen') return [...base, ...screenMenuNodes(screenRows)];
    if (item.key === 'produce') return [...base, ...extMenus];
    return base;
  }
  function openPrimary(item: PrimaryMenu) {
    if (!menuVisible(item, session)) return;
    const kids = filterSidebarMenus(childrenFor(item));
    const hasKids = kids.length > 0;
    /* 已展开且再点同一一级文案区 → 收起；未展开则展开并导航 */
    if (hasKids && expandedPrimary === item.key) {
      togglePrimaryExpand(item);
      return;
    }
    manualCollapsedPrimary.current = null;
    setPrimary(item.key);
    setExpandedPrimary(item.key);
    setCollapsed(false);
    if (item.path) navigate(item.path);
    else {
      const first = firstVisiblePath(kids, session);
      if (first) navigate(first);
    }
  }
  function togglePrimaryExpand(item: PrimaryMenu) {
    if (!menuVisible(item, session)) return;
    setExpandedPrimary((prev) => {
      if (prev === item.key) {
        manualCollapsedPrimary.current = item.key;
        return null;
      }
      manualCollapsedPrimary.current = null;
      return item.key;
    });
  }
  const crumb = ['主页', current?.primary.label, ...(current?.chain.filter((node, index) => index > 0 || node.label !== current.primary.label || current.primary.key === 'workplace').map((node) => node.label) ?? [])].filter((item): item is string => !!item);
  const specTail = specForPath(location.pathname)?.breadcrumb_tail;
  const tail = specTail ?? crumbTail(location.pathname, current?.primary.key);
  if (tail && crumb[crumb.length - 1] !== tail) crumb.push(tail);
  return <div className="kgd-app">
    <aside className={`kgd-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="主导航">
      <div className="kgd-sidebar-brand" title={brand}>
        {logo ? <img src={logo} alt="" /> : <i>赛</i>}
        {!collapsed && <span className="kgd-sidebar-brand-text">{brand}</span>}
      </div>
      <nav className="kgd-sidebar-nav">
        {primaryMenus.map((item) => {
          const ok = menuVisible(item, session);
          if (!ok) return null;
          const isActive = item.key === primary;
          const kids = filterSidebarMenus(childrenFor(item));
          const hasKids = kids.length > 0;
          const isExpanded = !collapsed && expandedPrimary === item.key && hasKids;
          return <div key={item.key} className={`kgd-sidebar-primary-block ${isActive ? 'is-active' : ''} ${isExpanded ? 'is-expanded' : ''}`}>
            <button type="button" data-primary={item.key} className={`kgd-sidebar-primary ${isActive ? 'active' : ''}`} aria-label={item.label} aria-expanded={isExpanded} onClick={() => openPrimary(item)}>
              <PrimaryIcon name={item.icon} />
              {!collapsed && <span className="kgd-sidebar-label">{item.label}</span>}
              {!collapsed && hasKids && (
                <span
                  className="kgd-sidebar-chevron"
                  role="button"
                  tabIndex={-1}
                  aria-label={isExpanded ? `收起${item.label}` : `展开${item.label}`}
                  data-caret={item.key}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    togglePrimaryExpand(item);
                  }}
                >
                  {isExpanded ? '▾' : '▸'}
                </span>
              )}
            </button>
            {isExpanded && (
              <div className="kgd-sidebar-children">
                <SubTree nodes={kids} />
              </div>
            )}
          </div>;
        })}
      </nav>
    </aside>
    <div className="kgd-main">
      <header className="kgd-top">
        <div className="kgd-top-left">
          <button className="kgd-link" aria-label="折叠菜单" onClick={() => setCollapsed((value) => !value)}>{collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}</button>
          <Breadcrumb items={crumb.map((item, index) => ({ title: index === 0 ? <Link to="/staging/area">主页</Link> : item }))} />
          {/\/(add|edit|detail)(\/|$)|\/edit$|_edit\/edit$|\/split\//.test(location.pathname) && <button className="kgd-link" onClick={() => navigate(-1)}>返回</button>}
        </div>
        <div className="kgd-top-right">
          <button className="kgd-hide-sm" hidden onClick={() => setAppQr(true)}>下载APP</button>
          <span hidden>0.5.0-dev.1</span>
          {!inChatShell && <ModeSwitch />}
          <AppearanceSwitcher />
          {isWorkplace && (
            <>
              <button type="button" className="kgd-top-action" onClick={() => emitWorkplaceAction('fullscreen')}>{wpFullscreen ? '退出全屏' : '全屏'}</button>
              <button type="button" className="kgd-top-action" onClick={() => emitWorkplaceAction('refresh')}>刷新</button>
              <button type="button" className="kgd-top-action" onClick={() => emitWorkplaceAction('configure')}>配置工作台</button>
            </>
          )}
          <MessageBell />
          {!inChatShell && (
            <Dropdown menu={{ items: [
              { key: 'name', label: `${session.user.display_name} · ${roleName(session.role)}`, disabled: true },
              { key: 'tenant', label: session.tenant.name, disabled: true },
              { key: 'account', label: '个人中心', onClick: () => navigate('/account') },
              { key: 'enterprise', label: '企业设置', onClick: () => navigate('/setting/enterprise/setting') },
              ...(import.meta.env.DEV && session.role === 'admin' ? [{ key: 'legacy', label: '旧验收台', onClick: () => navigate('/dev/legacy') }] : []),
              { key: 'logout', label: logoutBusy ? '正在退出…' : '退出登录', disabled: logoutBusy, onClick: onLogout },
            ] }}><button aria-label="头像"><span className="avatar">{Array.from(session.user.display_name)[0] || '用'}</span></button></Dropdown>
          )}
          {inChatShell && (
            <button
              type="button"
              className="kgd-back-chat"
              onClick={() => {
                try {
                  window.parent.postMessage({ type: 'sedric-close-mes' }, window.location.origin);
                } catch {
                  try {
                    window.parent.postMessage({ type: 'sedric-close-mes' }, '*');
                  } catch {
                    /* ignore */
                  }
                }
              }}
            >
              ← 返回聊天
            </button>
          )}
        </div>
      </header>
      <main className="kgd-content"><Outlet /></main>
    </div>
    <AiShell />
    {dockMode === 'demo' && !inChatShell && <DemoDock />}
    <Modal title="下载APP" open={appQr} footer={null} onCancel={() => setAppQr(false)}>
      <div style={{ textAlign: 'center' }}>
        <AsyncQr make={() => mobileHomeUrl(session.tenant.slug)} showText />
        <p>手机扫码打开手机版（报工、加工单）</p>
        <p className="kgd-muted">手机要和电脑连同一个 WiFi</p>
      </div>
    </Modal>
  </div>;
}

function firstVisiblePath(nodes: MenuNode[], session: ReturnType<typeof useKgd>['session']): string | undefined {
  for (const node of nodes) {
    if (!allowed(node, session)) continue;
    if (node.path) return node.path;
    const child = node.children ? firstVisiblePath(node.children, session) : undefined;
    if (child) return child;
  }
  return undefined;
}

const noListTail = new Set(['/work_report_workbench', '/personal/center', '/account', '/userLog', '/staging/area', '/digitalEmployees/manager/setting']);

function crumbTail(pathname: string, primaryKey: string | undefined) {
  if (pathname.startsWith('/inside_produce_bill/add')) return '创建加工单';
  if (pathname.startsWith('/OutWorkOrder/detail/')) return '外协工单详情';
  if (pathname === '/user/add') return '用户添加';
  if (pathname === '/role/add') return '添加';
  if (/\/add(\/|$)/.test(pathname) || /_edit\/edit$/.test(pathname) || /\/edit$/.test(pathname)) return '新增';
  if (pathname.includes('/edit/')) return '修改';
  if (pathname.includes('/detail/')) return '详情';
  if (pathname.endsWith('/workbench')) return '报工';
  if (noListTail.has(pathname)) return '';
  if (primaryKey === 'report') return pathname.includes('/list') || pathname === '/ai_inventory/list' || pathname === '/smart/form_core_list' ? '列表' : (pathname.endsWith('/list') ? '列表' : '');
  if (pathname.includes('/setting') || pathname.startsWith('/setting')) return '';
  return '列表';
}
