// 手机登录页：扫码打开时企业标识已经带在网址里（?t=），工人只填账号密码。
import { useState, type FormEvent } from 'react';
import { apiRequest, errorMessage, type Session } from '../../../api';
import { lastTenant, rememberTenant, setPrefersDesktop } from './device';
import './mobile.css';

export function MobileLogin({ notice, connectionError, onRetry, onLogin, validSession }: {
  notice?: string; connectionError?: string; onRetry: () => void;
  onLogin: (session: Session) => void; validSession: (value: unknown) => value is Session;
}) {
  const fromLink = new URLSearchParams(window.location.search).get('t') || '';
  const [slug, setSlug] = useState(fromLink || lastTenant());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSlug, setShowSlug] = useState(!(fromLink || lastTenant()));
  const scanned = /\/m\/(wo|progress)\//.test(window.location.pathname);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await apiRequest<Session>('/api/auth/login', { method: 'POST', body: { tenant_slug: slug.trim(), username: username.trim(), password } });
      if (!validSession(result)) throw new Error('登录响应格式无法识别。');
      rememberTenant(slug.trim());
      setPassword('');
      onLogin(result);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <div className="m-app m-login">
    <div className="m-login-brand">
      <span className="m-logo">赛</span>
      <div><b>赛德瑞科</b><small>{scanned ? '登录后打开扫到的加工单' : '手机报工 · 加工单'}</small></div>
    </div>
    <form className="m-login-card" onSubmit={submit}>
      {connectionError && <div className="m-alert">{connectionError}<button type="button" className="m-link" onClick={onRetry}>重试</button></div>}
      {!connectionError && notice && <div className="m-alert info">{notice}</div>}
      {error && <div className="m-alert">{error}</div>}
      {showSlug
        ? <label className="m-field"><span>企业标识</span><input value={slug} onChange={(e) => setSlug(e.target.value)} disabled={busy} required autoCapitalize="none" autoComplete="organization" spellCheck={false} placeholder="向管理员要" /></label>
        : <div className="m-tenant">企业：<b>{slug}</b><button type="button" className="m-link" onClick={() => setShowSlug(true)}>换企业</button></div>}
      <label className="m-field"><span>账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} required autoCapitalize="none" autoComplete="username" spellCheck={false} placeholder="请输入账号" /></label>
      <label className="m-field"><span>密码</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} required autoComplete="current-password" placeholder="请输入密码" /></label>
      <button className="m-btn primary block" type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
    </form>
    <button type="button" className="m-link m-desktop" onClick={() => { setPrefersDesktop(true); window.location.href = '/'; }}>用电脑版</button>
  </div>;
}
