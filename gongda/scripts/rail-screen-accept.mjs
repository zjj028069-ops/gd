#!/usr/bin/env node
/**
 * 一级轨四字 + 数据大屏五项预置。只使用 Playwright。
 * 前置：npm run dev:setup && npm run dev（不要删库、不要改开发账号密码）。
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = path.join(process.cwd(), 'artifacts/rail-screen');
const optDir = '/opt/cursor/artifacts/rail-screen';
mkdirSync(artifactDir, { recursive: true });
mkdirSync(optDir, { recursive: true });

const names = ['生产中控大屏', '车间大屏', '机台实时状态', '不良品统计大屏', '加工单生产进度'];
const layouts = {
  生产中控大屏: 'three-rows',
  车间大屏: 'quad',
  机台实时状态: 'single',
  不良品统计大屏: 'split',
  加工单生产进度: 'single',
};
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
if (!pass) {
  console.error('未读到 admin.local 密码');
  process.exit(1);
}

const shots = [];

function must(ok, message) {
  if (!ok) throw new Error(message);
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token || !cookie) throw new Error(`登录失败 ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return { csrf: json.csrf_token, cookie };
}

async function api(session, pathName) {
  const res = await fetch(`${API}${pathName}`, { headers: { cookie: session.cookie } });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`GET ${pathName} ${res.status} ${text.slice(0, 240)}`);
  return json;
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
}

async function shot(page, name, locator) {
  await page.mouse.move(8, 8);
  const file = path.join(artifactDir, `${name}.png`);
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
  writeFileSync(path.join(optDir, `${name}.png`), readFileSync(file));
  const md5 = createHash('md5').update(readFileSync(file)).digest('hex');
  shots.push({ name, file: `artifacts/rail-screen/${name}.png`, md5 });
  return md5;
}

async function main() {
  const session = await login();
  const listed = await api(session, '/api/data-screens');
  const items = listed.items ?? [];
  for (const name of names) must(items.some((item) => item.menu_name === name), `接口缺少 ${name}`);
  must(!items.some((item) => String(item.menu_name).trim() === '大屏幕'), '接口仍有大屏幕');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await asUser(page, session);
  await page.goto(`${WEB}/screen_management/list`, { waitUntil: 'domcontentloaded' });
  const railLabel = page.locator('.kgd-rail button[data-primary="screen"] .kgd-rail-label');
  await railLabel.waitFor({ timeout: 20000 });
  const railText = (await railLabel.innerText()).trim();
  must(railText === '数据大屏', `一级轨文字不是数据大屏：${railText}`);
  const metrics = await railLabel.evaluate((node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return {
      display: style.display,
      visibility: style.visibility,
      width: box.width,
      height: box.height,
      scroll: node.scrollWidth,
      client: node.clientWidth,
    };
  });
  must(metrics.display !== 'none' && metrics.visibility !== 'hidden' && metrics.width >= 40 && metrics.height >= 10, `数据大屏四字不可见 ${JSON.stringify(metrics)}`);
  must(metrics.scroll <= metrics.client + 1, `数据大屏文字被裁切 ${JSON.stringify(metrics)}`);
  const others = ['工作台', '报表中心', '客户管理'];
  for (const label of others) {
    const text = (await page.locator('.kgd-rail .kgd-rail-label', { hasText: label }).first().innerText()).trim();
    must(text === label, `一级轨缺少 ${label}`);
  }
  const clipped = await page.locator('.kgd-rail .kgd-rail-label').evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
  must(clipped.length === 0, `一级轨文字被裁切：${clipped.join(',')}`);
  await shot(page, '01-一级轨四字', page.locator('.kgd-rail'));
  await page.locator('.kgd-rail button[data-primary="screen"]').click();
  await page.locator('[data-label="生产中控大屏"]').waitFor({ timeout: 20000 });
  for (const label of ['大屏管理', ...names]) {
    must(await page.locator(`[data-label="${label}"]`).count() >= 1, `侧栏缺少 ${label}`);
  }
  must(await page.locator('[data-label="大屏幕"]').count() === 0, '侧栏仍有大屏幕');
  await shot(page, '02-数据大屏侧栏', page.locator('.kgd-app'));
  for (const name of names) {
    const row = items.find((item) => item.menu_name === name);
    await page.goto(`${WEB}/_screen/pd/${row.id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.kgd-screen-title').waitFor({ timeout: 20000 });
    const title = (await page.locator('.kgd-screen-title').innerText()).trim();
    must(title.length > 0, `${name} 大屏标题为空`);
    const layout = await page.locator('[data-layout]').first().getAttribute('data-layout');
    must(layout === layouts[name], `${name} 布局 ${layout} ≠ ${layouts[name]}`);
    must(await page.locator('.kgd-screen-pwd-gate').count() === 0, `${name} 被密码挡住`);
  }
  await shot(page, '03-加工单生产进度', page);
  const popupPromise = page.waitForEvent('popup', { timeout: 15000 });
  await page.goto(`${WEB}/screen_management/list`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-label="机台实时状态"]').click();
  const popup = await popupPromise;
  await popup.locator('.kgd-screen-title').waitFor({ timeout: 20000 });
  must((await popup.locator('.kgd-screen-title').innerText()).trim().length > 0, '侧栏打开机台实时状态没有标题');
  await popup.close();
  const hashes = new Set(shots.map((item) => item.md5));
  must(hashes.size === shots.length, '截图 MD5 重复');
  writeFileSync(path.join(artifactDir, 'md5.json'), JSON.stringify(shots, null, 2));
  writeFileSync(path.join(optDir, 'md5.json'), JSON.stringify(shots, null, 2));
  console.log(shots.map((item) => `${item.md5}  ${item.file}`).join('\n'));
  await browser.close();
  console.log('一级轨与五项预置验收通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
