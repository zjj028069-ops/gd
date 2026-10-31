import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN.js';
import { ApiError, apiRequest, errorMessage, isAbort } from './api';
import type { Session } from './api';
import { KgdProvider } from './kgd/context';
import { Shell } from './kgd/Shell';
import { KgdPage } from './kgd/pages/router';
import { ScreenRoute } from './kgd/pages/progress/screenViews';
import { ScreenDesigner } from './kgd/pages/round10/screens/ScreenDesigner';
import { ShareWorkOrderPage } from './kgd/pages/round10/produce/ShareWorkOrder';
import { MobileApp } from './kgd/pages/mobile/MobileApp';
import { MobileLogin } from './kgd/pages/mobile/MobileLogin';
import { isMobileDevice, onMobilePath, prefersDesktop, redirectPhoneToMobile, setPrefersDesktop } from './kgd/pages/mobile/device';
import { LegacyWorkspace } from './legacy/LegacyWorkspace';
import { SbotPage } from './modules/sbot/SbotPage';
import { PlatformApp } from './modules/platform/PlatformApp';
import { Loading, Notice } from './shared';
import { getMesBasename } from './mesBase';
import { applyStoredAppearance } from './kgd/appearance';

function validSession(value: unknown): value is Session {
  const result = value as Partial<Session> | null;
  return !!result && typeof result.csrf_token === 'string' && !!result.csrf_token
    && !!result.user && result.user.id !== undefined && typeof result.user.display_name === 'string'
    && !!result.tenant && result.tenant.id !== undefined && typeof result.tenant.name === 'string'
    && typeof result.tenant.slug === 'string' && ['all', 'department', 'self'].includes(result.data_scope ?? '') && Array.isArray(result.permissions) && result.permissions.every(item => typeof item === 'string') && ['admin', 'planner', 'worker'].includes(result.role ?? '');
}



// 手机打开电脑页面时，自动换成手机版（用户选过「用电脑版」就不换）
redirectPhoneToMobile();

export default function App() {
  if (window.location.pathname.startsWith('/share/wo/')) return <PublicRoutes />;
  // 平台管理后台：独立账号体系，不走企业登录
  if (/^\/platform(\/|$)/.test(window.location.pathname)) return <PlatformApp />;
  return <AuthedApp />;
}

function PublicRoutes() {
  return <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#4184F4', borderRadius: 2 } }}>
    <AntdApp>
      <BrowserRouter useTransitions={false}>
        <Routes>
          <Route path="/share/wo/:token" element={<ShareWorkOrderPage />} />
        </Routes>
      </BrowserRouter>
    </AntdApp>
  </ConfigProvider>;
}

function AuthedApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreRetry, setRestoreRetry] = useState(0);
  const [connectionError, setConnectionError] = useState('');
  const [loginNotice, setLoginNotice] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);

  useEffect(() => { applyStoredAppearance(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    setRestoring(true);
    setConnectionError('');
    apiRequest<Session>('/api/auth/me', { signal: controller.signal })
      .then((result) => {
        if (!validSession(result)) throw new Error('登录会话响应格式无法识别。');
        setSession(result);
      })
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        setSession(null);
        if (!(failure instanceof ApiError && failure.status === 401)) setConnectionError(errorMessage(failure));
      })
      .finally(() => { if (!controller.signal.aborted) setRestoring(false); });
    return () => controller.abort();
  }, [restoreRetry]);

  const expired = useCallback(() => {
    setSession(null);
    setLogoutError('');
    setLoginNotice('会话已失效，请重新登录。尚未提交的内容不会自动写入。');
  }, []);

  async function logout() {
    if (!session || logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError('');
    try {
      await apiRequest('/api/auth/logout', { method: 'POST', csrfToken: session.csrf_token });
      setSession(null);
      setLoginNotice('已退出登录。可以使用其他企业的账号重新登录。');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) expired();
      else setLogoutError(`退出未完成：${errorMessage(failure)}`);
    } finally { setLogoutBusy(false); }
  }

  if (restoring) return <div className="startup-screen"><Brand /><Loading label="正在确认登录状态…" /></div>;
  if (!session && onMobilePath()) return <MobileLogin connectionError={connectionError} notice={loginNotice} validSession={validSession} onRetry={() => setRestoreRetry((value) => value + 1)} onLogin={(result) => { setConnectionError(''); setLoginNotice(''); setLogoutError(''); setSession(result); }} />;
  if (!session) return <Login connectionError={connectionError} notice={loginNotice} onRetry={() => setRestoreRetry((value) => value + 1)} onLogin={(result) => { setConnectionError(''); setLoginNotice(''); setLogoutError(''); setSession(result); }} />;
  return <Authed key={`${session.tenant.id}:${session.user.id}:${session.role}`} session={session} onExpired={expired} onSession={setSession} onLogout={logout} logoutBusy={logoutBusy} logoutError={logoutError} />;
}

function Brand({ logo = '' }: { logo?: string }) {
  return <div className="brand">{logo ? <img className="brand-symbol" src={logo} alt="" /> : <span className="brand-symbol" aria-hidden="true" style={{ background: '#4184F4' }}>赛</span>}<span>赛德瑞科<small>企业生产协作</small></span></div>;
}

function Authed({ session, onExpired, onSession, onLogout, logoutBusy, logoutError }: { session: Session; onSession: (session: Session) => void; onExpired: () => void; onLogout: () => void; logoutBusy: boolean; logoutError: string }) {
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => {
    setRevision((value) => value + 1);
    apiRequest<Session>('/api/auth/me').then(onSession).catch((failure: unknown) => { if (failure instanceof ApiError && failure.status === 401) onExpired(); });
  }, [onExpired, onSession]);
  const value = { session, revision, onExpired, onChanged: changed, onSession, onLogout, logoutBusy, logoutError };
  return <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#4184F4', borderRadius: 2 } }}>
    <AntdApp>
      <BrowserRouter basename={getMesBasename()} useTransitions={false}>
        <Routes>
          {import.meta.env.DEV ? <Route path="/dev/legacy" element={<LegacyWorkspace session={session} onExpired={onExpired} onSession={onSession} onLogout={onLogout} logoutBusy={logoutBusy} logoutError={logoutError} />} /> : null}
          <Route path="/_screen/pd/:id" element={<KgdProvider value={value}><ScreenRoute /></KgdProvider>} />
          <Route path="/_screen/editpd/:id" element={<KgdProvider value={value}><ScreenDesigner /></KgdProvider>} />
          <Route path="/share/wo/:token" element={<ShareWorkOrderPage />} />
          <Route path="/m/*" element={<KgdProvider value={value}><MobileApp /></KgdProvider>} />
          <Route path="/sbot" element={<KgdProvider value={value}><SbotPage /></KgdProvider>} />
          <Route element={<KgdProvider value={value}><Shell /></KgdProvider>}>
            <Route path="*" element={<KgdPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <BackToMobile />
    </AntdApp>
  </ConfigProvider>;
}

/** 手机上选了「用电脑版」后，给一个回到手机版的按钮 */
function BackToMobile() {
  if (!isMobileDevice() || !prefersDesktop() || onMobilePath()) return null;
  return <button type="button" className="m-back-mobile" onClick={() => { setPrefersDesktop(false); window.location.href = `${getMesBasename() ?? ''}/m`; }}>手机版</button>;
}

function Login({ connectionError, notice, onRetry, onLogin }: { connectionError: string; notice: string; onRetry: () => void; onLogin: (session: Session) => void }) {
  const [slug, setSlug] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [logo, setLogo] = useState('');

  useEffect(() => {
    const tenant = slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenant)) { setLogo(''); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void apiRequest<{ logo: string }>(`/api/public/brand?slug=${encodeURIComponent(tenant)}`, { signal: controller.signal })
        .then((result) => setLogo(result.logo || ''))
        .catch((failure: unknown) => { if (!isAbort(failure)) setLogo(''); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [slug]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<Session>('/api/auth/login', { method: 'POST', body: { tenant_slug: slug.trim(), username: username.trim(), password } });
      if (!validSession(result)) throw new Error('登录响应格式无法识别。');
      setPassword('');
      onLogin(result);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <div className="login-layout">
    <section className="login-intro"><Brand logo={logo} /><div className="login-story"><span className="intro-label">企业工作空间</span><h1>让工作跟聊天<br />一样简单。</h1><p>以前我们让人适应系统，现在我们让系统适应人。</p><div className="intro-features"><span>数据沉淀</span><span>流程更优</span><span>智能决策</span></div></div><div className="intro-foot" hidden>当前交付阶段 · 生产主线</div><div className="intro-decoration" aria-hidden="true"><span /><span /><span /></div></section>
    <main className="login-main"><div className="login-card"><h2 className="login-welcome">欢迎回来</h2><p className="login-subtitle" hidden>使用已开通企业的账号访问销售、生产和库存。</p>
      {connectionError && <Notice><div>{connectionError}</div><button className="text-button" type="button" onClick={onRetry}>重新确认连接</button></Notice>}
      {false && notice && <Notice kind="info">{notice}</Notice>}
      {error && <Notice>{error}</Notice>}
      <form onSubmit={submit} className="login-form">
        <label className="form-field"><span>企业标识</span><input value={slug} onChange={(event) => setSlug(event.target.value)} disabled={busy} required autoComplete="organization" placeholder="请输入企业标识" autoCapitalize="none" spellCheck={false} /></label>
        <label className="form-field"><span>账号</span><input value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy} required autoComplete="username" placeholder="请输入账号" autoCapitalize="none" spellCheck={false} /></label>
        <label className="form-field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} required autoComplete="current-password" placeholder="请输入密码" /></label>
        <button className="button button-primary login-submit" type="submit" disabled={busy}>{busy ? '正在登录…' : '登录工作空间'}<span aria-hidden="true">→</span></button>
      </form><p className="login-help" hidden>企业标识与账号由企业管理员提供。</p><div className="login-stage" hidden>销售、加工、报工、库存和发货已落库。采购、检验、工价、成本与收付款已接入真实业务。</div>
    </div></main>
  </div>;
}
