/**
 * 证明 round7 第 4 步不是空断言：
 * 往 .kgd-rail 注入 aria-label=客户管理 的按钮 → countRailCustomerMenu 必须 ≠0（第4步会 FAIL）；
 * 移除后必须 ===0（PASS）。不改 DB 权限。
 * 用法：node scripts/_prove-round7-step4.mjs（需 npm run dev）
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { countRailCustomerMenu } from './round7-step4-rail.mjs';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`login ${username} ${res.status}`);
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  return { cookie, csrf: json.csrf_token };
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([{ name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB }]);
}

const worker = await login('worker.local', passwordOf('.local/dev-credentials.txt', 'worker.local'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await asUser(page, worker);
await page.goto(`${WEB}/staging/area`);

const baseline = await countRailCustomerMenu(page);
if (baseline !== 0) {
  await browser.close();
  throw new Error(`基线失败：工人侧栏已有客户管理 count=${baseline}`);
}
console.log('PASS baseline: customerMenuCount === 0');

await page.evaluate(() => {
  const rail = document.querySelector('.kgd-rail');
  if (!rail) throw new Error('no .kgd-rail');
  const btn = document.createElement('button');
  btn.setAttribute('aria-label', '客户管理');
  btn.textContent = '';
  btn.id = '__prove_customer_menu__';
  rail.appendChild(btn);
});

const injected = await countRailCustomerMenu(page);
if (injected === 0) {
  await browser.close();
  throw new Error('注入后仍检测不到客户管理——断言无效');
}
console.log(`FAIL-as-expected when injected: customerMenuCount=${injected} (step4 would fail)`);

await page.evaluate(() => document.getElementById('__prove_customer_menu__')?.remove());
const restored = await countRailCustomerMenu(page);
if (restored !== 0) {
  await browser.close();
  throw new Error(`恢复后仍有客户管理 count=${restored}`);
}
console.log('PASS after restore: customerMenuCount === 0');
await browser.close();
console.log(JSON.stringify({
  method: 'page.evaluate inject aria-label=客户管理 into .kgd-rail',
  baseline,
  injected,
  wouldFailStep4: injected !== 0,
  restored,
  ALL_PROVE_PASS: true,
}));
