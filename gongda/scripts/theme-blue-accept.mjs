/**
 * 主色绿→蓝验收：壳层选中态 + 主按钮为 #4184F4。
 * Playwright only。前置：API 3001 与 WEB 5173 已启动，.local/dev-credentials.txt 可用。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const PRIMARY_RGB = 'rgb(65, 132, 244)';
const OLD_GREEN_RGB = 'rgb(5, 166, 122)';
const artifactDir = path.join(process.cwd(), 'artifacts/theme-blue');
const optDir = '/opt/cursor/artifacts/theme-blue';
const docDir = path.join(process.cwd(), 'docs/verification/theme-blue');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(optDir, { recursive: true });
mkdirSync(docDir, { recursive: true });

const shots = [];

function must(ok, message) {
  if (!ok) throw new Error(message);
}

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token || !cookie) throw new Error(`登录失败 ${username} ${JSON.stringify(json).slice(0, 240)}`);
  return { csrf: json.csrf_token, cookie };
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
  await page.addInitScript((token) => { window.sessionStorage.setItem('kgd-csrf', token); }, session.csrf);
}

async function shot(page, name, locator) {
  await page.mouse.move(8, 8);
  const file = path.join(artifactDir, `${name}.png`);
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
  const bytes = readFileSync(file);
  writeFileSync(path.join(optDir, `${name}.png`), bytes);
  writeFileSync(path.join(docDir, `${name}.png`), bytes);
  const md5 = createHash('md5').update(bytes).digest('hex');
  shots.push({ name, md5 });
  return md5;
}

const pass = passwordOf('.local/dev-credentials.txt', 'admin.local');
must(pass, '缺少 .local/dev-credentials.txt 中 admin.local 密码');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  const session = await login('admin.local', pass);
  await asUser(page, session);
  await page.goto(`${WEB}/workplace`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('.kgd-sub button.kgd-sub-item.active, .kgd-sub .kgd-sub-item.active').first().waitFor({ timeout: 30000 });

  const activeNav = page.locator('.kgd-sub button.kgd-sub-item.active, .kgd-sub .kgd-sub-item.active').first();
  const navBg = await activeNav.evaluate((node) => getComputedStyle(node).backgroundColor);
  must(navBg === PRIMARY_RGB, `壳层选中态背景应为 ${PRIMARY_RGB}，实际 ${navBg}`);
  must(navBg !== OLD_GREEN_RGB, `壳层选中态仍为旧绿 ${navBg}`);
  await shot(page, '01-shell-active-nav', page.locator('.kgd-shell, .kgd-layout, body').first().locator('.kgd-sub').first());
  await shot(page, '01b-shell-viewport');

  // 主按钮：工作台或任意页上的 antd primary
  let primaryBtn = page.locator('.ant-btn-primary').filter({ hasNot: page.locator('.ant-btn-dangerous') }).first();
  if (await primaryBtn.count() === 0) {
    await page.goto(`${WEB}/customer`, { waitUntil: 'networkidle', timeout: 60000 });
    primaryBtn = page.locator('.ant-btn-primary').first();
  }
  await primaryBtn.waitFor({ timeout: 20000 });
  const btnBg = await primaryBtn.evaluate((node) => getComputedStyle(node).backgroundColor);
  must(btnBg === PRIMARY_RGB, `主按钮背景应为 ${PRIMARY_RGB}，实际 ${btnBg}`);
  must(btnBg !== OLD_GREEN_RGB, `主按钮仍为旧绿 ${btnBg}`);
  await shot(page, '02-primary-button', primaryBtn);
  await shot(page, '02b-primary-context');

  const railActive = page.locator('.kgd-rail button.active').first();
  await railActive.waitFor({ timeout: 10000 });
  const railColor = await railActive.evaluate((node) => getComputedStyle(node).color);
  must(railColor === PRIMARY_RGB || railColor === 'rgb(65, 132, 244)', `一级栏选中文字应为蓝，实际 ${railColor}`);
  // color may be reported as rgb; also reject old rail green #05C98A
  must(railColor !== 'rgb(5, 201, 138)', `一级栏选中仍为旧绿 ${railColor}`);
  await shot(page, '03-rail-active', page.locator('.kgd-rail').first());

  const logoBg = await page.locator('.kgd-logo i').first().evaluate((node) => getComputedStyle(node).backgroundColor);
  must(logoBg === PRIMARY_RGB, `Logo 块背景应为 ${PRIMARY_RGB}，实际 ${logoBg}`);

  const themeColor = await page.locator('meta[name="theme-color"]').getAttribute('content');
  must(themeColor?.toUpperCase() === '#4184F4', `theme-color 应为 #4184F4，实际 ${themeColor}`);

  const record = [
    '# 主色绿→蓝验收',
    '',
    `- 壳层选中态：${navBg}`,
    `- 主按钮：${btnBg}`,
    `- Logo：${logoBg}`,
    `- theme-color：${themeColor}`,
    '',
    ...shots.map((item) => `- ${item.name}.png ${item.md5}`),
    '',
  ].join('\n');
  writeFileSync(path.join(docDir, '验收记录.md'), record);
  writeFileSync(path.join(optDir, '验收记录.md'), record);
  writeFileSync(path.join(artifactDir, '验收记录.md'), record);
  console.log(record);
} finally {
  await browser.close();
}
