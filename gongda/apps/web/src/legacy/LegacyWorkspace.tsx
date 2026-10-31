import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError, errorMessage, hasPermission, isAbort, roleName } from '../api';
import type { Session, Unit } from '../api';
import { Audit } from '../Audit';
import { PlatformSettings, TenantSwitcher } from '../PlatformSettings';
import { ConfigurationSettings } from '../ConfigurationSettings';
import { AssetSettings } from '../AssetSettings';
import { Notifications } from '../EventSettings';
import { Overview } from '../Overview';
import { Products } from '../Products';
import { MasterData } from '../MasterData';
import { DesignPreview } from '../DesignPreview';
import { BusinessDocuments } from '../BusinessDocuments';
import { MobileReportPrototype } from '../MobileReportPrototype';
import { MobileReport } from '../MobileReport';
import { ProductionCorrections } from '../ProductionCorrections';
import { BusinessCompletion } from '../BusinessCompletion';
import { ProductionDesk } from '../ProductionDesk';
import { Loading, Notice } from '../shared';

const ExpensesReports = lazy(() => import('../ExpensesReports').then((module) => ({ default: module.ExpensesReports })));
const WarehouseOperations = lazy(() => import('../WarehouseOperations').then((module) => ({ default: module.WarehouseOperations })));

type Page = 'overview' | 'products' | 'audit' | 'planned' | 'units' | 'processes' | 'routes' | 'boms' | 'workflow_preview' | 'mobile_preview' | 'document_preview' | 'platform' | 'configuration' | 'assets' | 'notifications' | 'sales' | 'production' | 'stock' | 'mobile_report' | 'business_completion' | 'expenses_reports' | 'warehouse_operations' | 'corrections';
const plannedModules = [
  { name: '质量扩展', icon: '◇', description: '自动抽样方案、不良目录与委外质检仍在规划' },
  { name: '计划与排程', icon: '▦', description: '甘特排程、父子工单与多工厂协同仍在规划' },
];

function Brand() {
  return <div className="brand"><span className="brand-symbol" aria-hidden="true">工</span><span>工单协作平台<small>企业生产协作</small></span></div>;
}

export function LegacyWorkspace({ session, onExpired, onSession, onLogout, logoutBusy, logoutError }: { session: Session; onSession: (session: Session) => void; onExpired: () => void; onLogout: () => void; logoutBusy: boolean; logoutError: string }) {
  const [page, setPage] = useState<Page>('overview');
  const [planned, setPlanned] = useState(plannedModules[0].name);
  const [revision, setRevision] = useState(0);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitsLoading, setUnitsLoading] = useState(true);
  const [unitsError, setUnitsError] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const allowed = hasPermission(session, 'audit.read');
  const masterReadable = hasPermission(session, 'master.read');
  const allScope = session.data_scope === 'all';
  const salesOk = hasPermission(session, 'sales.read') && allScope;
  const productionOk = hasPermission(session, 'production.read') && allScope;
  const stockOk = hasPermission(session, 'inventory.read') && allScope;
  const reportOk = hasPermission(session, 'production.report') && allScope;

  useEffect(() => {
    if (!masterReadable || !allScope) { setUnits([]); setUnitsLoading(false); setUnitsError(''); return; }
    const controller = new AbortController();
    setUnitsLoading(true); setUnitsError('');
    apiRequest<{ items: Unit[] }>('/api/units', { signal: controller.signal })
      .then((result) => {
        if (!Array.isArray(result.items)) throw new Error('计量单位数据格式无法识别。');
        setUnits(result.items.filter((item) => item.active !== false));
      })
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        if (failure instanceof ApiError && failure.status === 401) onExpired();
        else setUnitsError(errorMessage(failure));
      })
      .finally(() => { if (!controller.signal.aborted) setUnitsLoading(false); });
    return () => controller.abort();
  }, [onExpired, revision, masterReadable, allScope]);

  function navigate(next: Page) { setPage(next); setMobileMenu(false); }
  const changed = useCallback(() => {
    setRevision((value) => value + 1);
    apiRequest<Session>('/api/auth/me').then(onSession).catch((failure: unknown) => { if (failure instanceof ApiError && failure.status === 401) onExpired(); });
  }, [onSession, onExpired]);
  return <div className="app-layout">
    {mobileMenu && <button className="sidebar-shade" aria-label="关闭导航" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}><Brand /><div className="workspace-chip"><span className="workspace-dot" /><span>{session.tenant.name}<small>{session.tenant.slug}</small></span></div>
      <nav aria-label="主导航"><div className="nav-label">工作空间</div><NavButton active={page === 'overview'} icon="▦" label="企业概览" onClick={() => navigate('overview')} /><NavButton active={page === 'products'} icon="▣" label="产品档案" disabled={!masterReadable} onClick={() => navigate('products')} /><NavButton active={page === 'audit'} icon="≡" label="操作审计" disabled={!allowed} onClick={() => navigate('audit')} />
        <NavButton active={page === 'notifications'} icon="✉" label="站内消息" onClick={() => navigate('notifications')} /><div className="nav-label nav-label-gap">基础规则</div><NavButton active={page === 'units'} icon="◈" label="计量单位" disabled={!masterReadable || !allScope} onClick={() => navigate('units')} /><NavButton active={page === 'processes'} icon="≋" label="生产工序" disabled={!masterReadable || !allScope} onClick={() => navigate('processes')} /><NavButton active={page === 'routes'} icon="⇢" label="工艺路线" disabled={!masterReadable || !allScope} onClick={() => navigate('routes')} /><NavButton active={page === 'boms'} icon="⊞" label="产品 BOM" disabled={!masterReadable || !allScope} onClick={() => navigate('boms')} /><div className="nav-label nav-label-gap">平台配置</div><NavButton active={page === 'platform'} icon="◉" label="企业组织与权限" onClick={() => navigate('platform')} /><NavButton active={page === 'configuration'} icon="⚙" label="字段与界面配置" disabled={!hasPermission(session, 'configuration.read')} onClick={() => navigate('configuration')} /><NavButton active={page === 'assets'} icon="⌕" label="附件与服务额度" disabled={!hasPermission(session, 'attachments.read')} onClick={() => navigate('assets')} /><div className="nav-label nav-label-gap">生产主线</div><NavButton active={page === 'sales'} icon="⇄" label="销售订单" disabled={!salesOk} onClick={() => navigate('sales')} /><NavButton active={page === 'production'} icon="▤" label="加工与报工" disabled={!productionOk} onClick={() => navigate('production')} /><NavButton active={page === 'stock'} icon="▣" label="库存与发货" disabled={!stockOk} onClick={() => navigate('stock')} /><NavButton active={page === 'mobile_report'} icon="▯" label="手机报工" disabled={!reportOk} onClick={() => navigate('mobile_report')} /><NavButton active={page === 'corrections'} icon="◇" label="返工与报工更正" disabled={!productionOk} onClick={() => navigate('corrections')} /><NavButton active={page === 'business_completion'} icon="¥" label="采购、算料与财务" disabled={!allScope || !['procurement.read','quality.read','planning.read','payroll.read','finance.read'].some(x=>hasPermission(session,x))} onClick={() => navigate('business_completion')} /><NavButton active={page === 'expenses_reports'} icon="◴" label="费用与期间报表" disabled={!allScope || !['production.read','inventory.read','payroll.read','finance.read'].some(x=>hasPermission(session,x))} onClick={() => navigate('expenses_reports')} /><NavButton active={page === 'warehouse_operations'} icon="⇆" label="调拨与盘点" disabled={!allScope || !hasPermission(session,'inventory.read')} onClick={() => navigate('warehouse_operations')} /><div className="nav-label nav-label-gap">预检原型</div><NavButton active={page === 'document_preview'} icon="▤" label="业务单据原型" disabled={!masterReadable || !allScope} preview onClick={() => navigate('document_preview')} /><NavButton active={page === 'workflow_preview'} icon="◇" label="状态规则预检" disabled={!masterReadable || !allScope} preview onClick={() => navigate('workflow_preview')} /><NavButton active={page === 'mobile_preview'} icon="▯" label="手机报工原型" disabled={!masterReadable || !allScope} preview onClick={() => navigate('mobile_preview')} /><div className="nav-label nav-label-gap">后续业务模块</div>{plannedModules.map((module) => <NavButton key={module.name} active={page === 'planned' && planned === module.name} icon={module.icon} label={module.name} planned onClick={() => { setPlanned(module.name); navigate('planned'); }} />)}
      </nav><div className="sidebar-foot"><span className="badge badge-stage">生产主线</span><p>费用报表与调拨盘点已接入</p></div>
    </aside>
    <div className="workspace-content"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu-button" aria-label="展开导航" aria-expanded={mobileMenu} onClick={() => setMobileMenu((value) => !value)}>☰</button><span className="topbar-company">{session.tenant.name}</span><span className="topbar-divider" /><span className="topbar-stage">阶段五 · 生产主线</span></div><div className="topbar-user"><TenantSwitcher session={session} onExpired={onExpired} onSession={onSession} /><span className="avatar" aria-hidden="true">{Array.from(session.user.display_name)[0] || '用'}</span><div><strong>{session.user.display_name}</strong><small>{roleName(session.role)}</small></div><button className="button button-quiet logout-button" disabled={logoutBusy} onClick={onLogout}>{logoutBusy ? '正在退出…' : '退出登录'}</button></div></header>
      <main className="page-content">{logoutError && <Notice>{logoutError}</Notice>}{page === 'overview' && <Overview session={session} revision={revision} onExpired={onExpired} />}{page === 'products' && <Products session={session} units={units} unitsLoading={unitsLoading} unitsError={unitsError} revision={revision} onExpired={onExpired} onChanged={changed} />}{(page === 'units' || page === 'processes' || page === 'routes' || page === 'boms') && <MasterData kind={page} session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'sales' && <ProductionDesk mode="sales" session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'production' && <ProductionDesk mode="production" session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'stock' && <ProductionDesk mode="stock" session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'corrections' && <ProductionCorrections session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'business_completion' && <BusinessCompletion session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'expenses_reports' && <Suspense fallback={<Loading />}><ExpensesReports session={session} revision={revision} onExpired={onExpired} onChanged={changed} /></Suspense>}{page === 'warehouse_operations' && <Suspense fallback={<Loading />}><WarehouseOperations session={session} revision={revision} onExpired={onExpired} onChanged={changed} /></Suspense>}{page === 'mobile_report' && <MobileReport session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'document_preview' && <BusinessDocuments session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'workflow_preview' && <DesignPreview mode='business' session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'mobile_preview' && <MobileReportPrototype session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'audit' && <Audit session={session} revision={revision} onExpired={onExpired} />}{page === 'platform' && <PlatformSettings session={session} revision={revision} onExpired={onExpired} onChanged={changed} onSession={onSession} />}{page === 'configuration' && <ConfigurationSettings session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'assets' && <AssetSettings session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'notifications' && <Notifications session={session} revision={revision} onExpired={onExpired} onChanged={changed} />}{page === 'planned' && <Planned title={planned} onProducts={() => navigate('products')} />}</main>
      <footer className="workspace-footer">工单协作平台 <span>当前企业：{session.tenant.name}</span></footer>
    </div>
  </div>;
}

function NavButton({ active, icon, label, onClick, disabled = false, planned = false, preview = false }: { active: boolean; icon: string; label: string; onClick: () => void; disabled?: boolean; planned?: boolean; preview?: boolean }) {
  return <button className={`nav-button ${active ? 'nav-button-active' : ''}`} onClick={onClick} disabled={disabled} aria-current={active ? 'page' : undefined} title={disabled ? '当前角色没有查看权限' : undefined}><span className="nav-icon" aria-hidden="true">{icon}</span><span>{label}</span>{planned && <small>规划中</small>}{preview && <small>预检</small>}</button>;
}

function Planned({ title, onProducts }: { title: string; onProducts: () => void }) {
  return <><div className="page-heading"><div><div className="eyebrow">业务模块</div><h1>{title}</h1><p>此模块请从侧栏进入已交付页面。</p></div><span className="badge badge-amber">请使用已交付模块</span></div><section className="panel roadmap-panel"><div className="roadmap-icon" aria-hidden="true">◇</div><h2>先建立可靠的数据基础</h2><p>销售、加工单、报工、领料、成品入库和分批发货已经落库。这里列出的是尚待补齐的质量扩展和排程功能。</p><button className="button button-primary" onClick={onProducts}>查看产品档案</button><div className="roadmap-grid">{plannedModules.map((module) => <div key={module.name}><strong>{module.name}</strong><span>规划</span><p>{module.description}</p></div>)}</div></section></>;
}
