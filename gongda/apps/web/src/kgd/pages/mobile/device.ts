// 手机端：识别手机、记住「用电脑版」、生成给手机扫的网址。
import { getMesBasename } from '../../../mesBase';

const DESKTOP_KEY = 'kgd.preferDesktop';
const SLUG_KEY = 'kgd.mobile.lastTenant';

export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPod|HarmonyOS|Mobile|MicroMessenger|DingTalk/i.test(ua) && !/iPad|Tablet/i.test(ua)) return true;
  // iPadOS 伪装成 Mac：不当作手机
  return false;
}

export function prefersDesktop() {
  try { return localStorage.getItem(DESKTOP_KEY) === '1'; } catch { return false; }
}

export function setPrefersDesktop(on: boolean) {
  try { if (on) localStorage.setItem(DESKTOP_KEY, '1'); else localStorage.removeItem(DESKTOP_KEY); } catch { /* 无痕模式等 */ }
}

export function rememberTenant(slug: string) {
  try { if (slug) localStorage.setItem(SLUG_KEY, slug); } catch { /* ignore */ }
}

export function lastTenant() {
  try { return localStorage.getItem(SLUG_KEY) || ''; } catch { return ''; }
}

const base = () => getMesBasename() ?? '';

/** 当前地址（去掉 basename 后）是不是手机端页面 */
export function onMobilePath(pathname = window.location.pathname) {
  const path = pathname.slice(base().length) || '/';
  return path === '/m' || path.startsWith('/m/');
}

/** 手机打开电脑页面时，换到手机端对应页面（只在没选「用电脑版」时） */
export function redirectPhoneToMobile() {
  if (typeof window === 'undefined' || !isMobileDevice() || prefersDesktop()) return;
  const path = window.location.pathname.slice(base().length) || '/';
  if (path === '/m' || path.startsWith('/m/') || path.startsWith('/share/') || path.startsWith('/_screen/') || path.startsWith('/platform')) return;
  window.history.replaceState(null, '', `${base()}/m${window.location.search}`);
}

let cachedBase: Promise<string> | null = null;
/** 手机能打开的网址前缀：服务器配置了局域网地址就用它，否则用当前地址 */
export function mobileOrigin(): Promise<string> {
  if (!cachedBase) {
    cachedBase = fetch('/api/mobile/config', { credentials: 'same-origin' })
      .then((res) => res.ok ? res.json() : null)
      .then((data: { base?: string | null } | null) => data?.base || window.location.origin)
      .catch(() => window.location.origin);
  }
  return cachedBase;
}

/** 给加工单二维码用的网址：扫码后直接打开这张单（带上企业标识，登录时自动填好） */
export async function workOrderMobileUrl(code: string, tenantSlug?: string) {
  const origin = await mobileOrigin();
  const query = tenantSlug ? `?t=${encodeURIComponent(tenantSlug)}` : '';
  return `${origin}${base()}/m/wo/${encodeURIComponent(code)}${query}`;
}

export async function mobileHomeUrl(tenantSlug?: string) {
  const origin = await mobileOrigin();
  return `${origin}${base()}/m${tenantSlug ? `?t=${encodeURIComponent(tenantSlug)}` : ''}`;
}
