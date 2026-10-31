/**
 * 第十一轮比对脚本公共库。
 * 参考包只放仓库外：ROUND11_REFS 或 /tmp/round11-work/round11。
 * 登录账号按正式凭据文件用 admin.local（不是 admin）。
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
export const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
export const REFS = process.env.ROUND11_REFS
  || (existsSync('/tmp/round11-work/round11/pages.json') ? '/tmp/round11-work/round11' : path.join(process.cwd(), 'docs/kgd-reference/round11'));
export const OUT = path.join(process.cwd(), 'docs/verification/round11');
mkdirSync(OUT, { recursive: true });

export function norm(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/：/g, ':');
}

export function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}\\s*\\n密码：(\\S+)`));
  return matched?.[1] ?? '';
}

export async function loginUser(username = 'admin.local') {
  const password = passwordOf('.local/dev-credentials.txt', username);
  if (!password) throw new Error(`找不到凭据 ${username}`);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
    });
    const json = await res.json();
    if (res.ok && json.csrf_token) {
      const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
      return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name, username, password };
    }
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 160);
    if (res.status === 429 || /限流|RATE_LIMIT/i.test(msg)) {
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * attempt)));
      continue;
    }
    throw new Error(`登录失败 ${username}: ${res.status} ${msg}`);
  }
  throw new Error(`登录失败 ${username}: RATE_LIMITED 重试耗尽`);
}

export async function loginAdmin() {
  return loginUser('admin.local');
}

export async function api(session, method, pathName, body) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

export function fillUrl(url, ids) {
  const byPath = [
    ['/contract_project/detail/', 'contract_project_id'],
    ['/inspection_plan/detail/', 'plan_id'],
    ['/device_order/detail/', 'repair_id'],
    ['/device/detail/', 'device_id'],
    ['/inside_produce_bill/', 'work_order_id'],
    ['/customer_contract/detail/', 'contract_id'],
    ['/ProductionPlan/detail/', 'production_plan_id'],
    ['/meeting/detail/', 'meeting_id'],
    ['/OutWorkOrder/', 'outsource_id'],
    ['/purchase_order/detail/', 'purchase_id'],
    ['/goods/detail/', 'product_id'],
  ];
  let out = String(url);
  for (const [prefix, key] of byPath) {
    if (out.includes(prefix) && ids[key]) out = out.replace(/:id/, ids[key]);
  }
  return out.replace(/\{([^}]+)\}|:([A-Za-z_]+)/g, (_, a, b) => {
    const key = a || b;
    return ids[key] || ids[key.replace(/No$/, '_no')] || ids.id || '';
  });
}

export async function openPage() {
  const session = await loginAdmin();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const eq = session.cookie.indexOf('=');
  await page.context().addCookies([{
    name: session.cookie.slice(0, eq),
    value: session.cookie.slice(eq + 1),
    url: WEB,
  }]);
  return { browser, page, session };
}

export async function waitReady(page) {
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), { timeout: 20000 });
  // 侧栏一级图标 tooltip 会挡住二级菜单点击；脚本关掉命中，不断言放松。
  // .kgd-ai 右下角助手按钮会挡住弹窗确定；关掉命中，不断言放松。
  await page.addStyleTag({ content: '.ant-tooltip { pointer-events: none !important; } .ant-float-btn, .ant-back-top, [class*="float-btn"], .kgd-ai, button.kgd-ai { pointer-events: none !important; visibility: hidden !important; }' }).catch(() => undefined);
}

export async function shot(page, filePath) {
  const box = await page.locator('.kgd-content, .kgd-main, body').first().boundingBox();
  if (box && box.width > 20 && box.height > 20) {
    await page.mouse.move(box.x + Math.min(48, box.width / 2), box.y + Math.min(64, box.height / 2));
  }
  await page.waitForTimeout(200);
  await page.waitForFunction(() => {
    const tips = [...document.querySelectorAll('.ant-tooltip')];
    return tips.every((node) => node.classList.contains('ant-tooltip-hidden') || getComputedStyle(node).visibility === 'hidden' || getComputedStyle(node).opacity === '0' || getComputedStyle(node).display === 'none');
  }, undefined, { timeout: 4000 });
  mkdirSync(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath, fullPage: false });
}

export function writeReport(name, diffs, warnings = []) {
  mkdirSync(OUT, { recursive: true });
  const lines = [
    `${name} ${new Date().toISOString()}`,
    diffs.length ? '未通过' : '通过',
    ...diffs.map((d) => `差异 ${d}`),
    ...warnings.map((d) => `警告 ${d}`),
  ];
  writeFileSync(path.join(OUT, `${name}.txt`), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

export function loadIds() {
  const file = '.local/round11-ids.json';
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadJson(rel) {
  const fromRefs = path.join(REFS, rel);
  if (existsSync(fromRefs)) return JSON.parse(readFileSync(fromRefs, 'utf8'));
  const local = path.join(process.cwd(), 'docs/kgd-reference/round11', rel);
  return JSON.parse(readFileSync(local, 'utf8'));
}
