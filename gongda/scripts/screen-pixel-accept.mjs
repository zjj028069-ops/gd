#!/usr/bin/env node
/**
 * 数据大屏像素验收（只使用 Playwright）。
 * 前置：npm run dev:setup && npm run dev
 * 本脚本先跑 scripts/seed-screen-pixel.mjs（正式接口造数）。
 * 禁止 force、禁止条件跳过、禁止没数据就改选第一项。
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = path.join(process.cwd(), 'artifacts/screen-pixel');
const optDir = '/opt/cursor/artifacts/screen-pixel';
mkdirSync(artifactDir, { recursive: true });
mkdirSync(optDir, { recursive: true });

const seeded = spawnSync('node', ['scripts/seed-screen-pixel.mjs'], { stdio: 'inherit', cwd: process.cwd() });
if (seeded.status !== 0) {
  console.error('造数失败，验收中止');
  process.exit(seeded.status ?? 1);
}

const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const shots = [];

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${res.status}`);
  return { csrf: json.csrf_token, cookie };
}

async function api(session, pathName, method = 'GET', body) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(body ? { 'content-type': 'application/json', 'x-csrf-token': session.csrf } : {}),
      ...(method !== 'GET' && !body ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status} ${text.slice(0, 240)}`);
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

async function shot(page, name) {
  await page.mouse.move(12, 12);
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  writeFileSync(path.join(optDir, `${name}.png`), readFileSync(file));
  const md5 = createHash('md5').update(readFileSync(file)).digest('hex');
  shots.push({ name, file: `artifacts/screen-pixel/${name}.png`, md5 });
  return md5;
}

function must(ok, message) {
  if (!ok) throw new Error(message);
}

async function openScreen(page, id) {
  await page.goto(`${WEB}/_screen/pd/${id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.kgd-screen-title').waitFor({ timeout: 20000 });
  await page.locator('.kgd-screen-chart canvas, .kgd-screen-table tbody tr').first().waitFor({ timeout: 20000 });
}

const titles = ['不良品项分布', '员工产能趋势', '人员不良品率', '实时报工数据', '人员生产统计', '工单执行进度', '机台状态详情'];

async function main() {
  const session = await login();
  const screens = (await api(session, '/api/data-screens')).items ?? [];
  const byName = (name) => {
    const row = screens.find((item) => item.menu_name === name);
    if (!row) throw new Error(`缺少大屏 ${name}`);
    return row;
  };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await asUser(page, session);

  const control = byName('生产中控大屏');
  await openScreen(page, control.id);
  const layout = await page.locator('.kgd-screen-control').getAttribute('data-layout');
  must(layout === 'three-rows', `中控布局不是三行：${layout}`);
  const columns = await page.locator('.kgd-screen-control').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length);
  must(columns === 3, `中控列数 ${columns}，不是三列骨架`);
  for (const title of titles) {
    must(await page.locator(`[data-module="${title}"]`).count() === 1, `缺少模块 ${title}`);
  }
  must(await page.locator('[data-panel="kpi"] .value').count() >= 9, 'KPI 区不足 9 个数字');
  must(await page.locator('[data-module="人员不良品率"] canvas').count() >= 1, '人员不良品率不是图表');
  must(await page.locator('[data-module="人员不良品率"] table').count() === 0, '人员不良品率仍是表格');
  must(await page.locator('.kgd-people-card').count() >= 1, '人员生产统计没有头像卡');
  must(await page.locator('[data-module="人员生产统计"] table').count() === 0, '人员生产统计仍是表格');
  const iconText = await page.locator('.s-icon').allInnerTexts();
  must(iconText.every((text) => !String(text ?? '').includes('屏')), `模块图标仍有屏字 ${iconText.join(',')}`);
  const fullText = await page.getByRole('button', { name: '全屏' }).innerText();
  must(!fullText.includes('全屏') && !fullText.includes('退出'), `全屏按钮仍是文字：${fullText}`);
  const clock = await page.locator('.kgd-screen-time').innerText();
  must(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(clock.trim()), `时钟格式不对 ${clock}`);
  await shot(page, '01-生产中控大屏');

  const pages = [
    ['车间大屏', 'quad', '02-车间大屏'],
    ['不良品统计大屏', 'split', '03-不良品统计大屏'],
    ['加工单生产进度', 'single', '04-加工单生产进度'],
    ['机台实时状态', 'single', '05-机台实时状态'],
  ];
  for (const [name, expectLayout, file] of pages) {
    await openScreen(page, byName(name).id);
    const got = await page.locator('[data-layout]').first().getAttribute('data-layout');
    must(got === expectLayout, `${name} 布局 ${got} ≠ ${expectLayout}`);
    await shot(page, file);
  }
  const machineRows = await page.locator('[data-module="机台状态详情"] tbody tr').count();
  const machineText = await page.locator('[data-module="机台状态详情"] tbody').innerText();
  must(machineRows >= 1 && !machineText.includes('暂无数据'), `机台实时状态没有数据行 ${machineRows}`);

  await page.goto(`${WEB}/screen_management/list`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-label="生产中控大屏"]').waitFor({ timeout: 20000 });
  for (const label of ['大屏管理', '生产中控大屏', '车间大屏', '机台实时状态', '不良品统计大屏', '加工单生产进度']) {
    must(await page.locator(`[data-label="${label}"]`).count() >= 1, `侧栏缺少 ${label}`);
  }
  const railColor = await page.locator('[data-primary="screen"]').evaluate((node) => getComputedStyle(node).color);
  must(railColor !== 'rgb(255, 255, 255)', `数据大屏选中态不是绿色图标 ${railColor}`);
  const manageBg = await page.locator('[data-label="大屏管理"]').evaluate((node) => getComputedStyle(node).backgroundColor);
  must(manageBg !== 'rgba(0, 0, 0, 0)' && manageBg !== 'transparent', `大屏管理选中底不是绿色 ${manageBg}`);
  await shot(page, '06-大屏管理侧栏');

  const created = await api(session, '/api/data-screens', 'POST', { menu_name: '像素验收设计屏', layout: '左右双模块', module_kind: '生产模块', description: '临时', access_password: '' });
  const designerId = created.id;
  if (!designerId) throw new Error('临时设计屏没有 id');
  let designerError = null;
  try {
    await page.goto(`${WEB}/_screen/editpd/${designerId}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-module="employee_defect"]').waitFor({ timeout: 20000 });
    await page.locator('[data-slot="1"]').waitFor();
    await page.locator('[data-module="employee_defect"]').dragTo(page.locator('[data-slot="1"]'), { targetPosition: { x: 40, y: 24 } });
    await page.locator('[data-slot="1"]').getByText('人员不良品率').waitFor({ timeout: 8000 });
    const saved = page.waitForResponse((response) => response.url().includes('/design') && response.request().method() === 'PUT', { timeout: 15000 });
    await page.getByRole('button', { name: '保存' }).click();
    const savedResponse = await saved;
    must(savedResponse.ok(), `设计保存失败 ${savedResponse.status()}`);
    await page.getByText('已保存').waitFor({ timeout: 8000 });
    await shot(page, '07-设计器');
    await openScreen(page, designerId);
    must(await page.locator('[data-module="人员不良品率"]').count() >= 1, '保存后查看没有人员不良品率');
    await shot(page, '08-设计保存后');
  } catch (error) {
    designerError = error;
  }
  await api(session, `/api/data-screens/${designerId}`, 'DELETE');
  const after = (await api(session, '/api/data-screens')).items ?? [];
  if (after.some((item) => item.menu_name === '像素验收设计屏' || item.id === designerId)) {
    throw new Error('像素验收设计屏删除后仍在列表');
  }
  if (designerError) throw designerError;

  const hashes = new Set(shots.map((item) => item.md5));
  must(hashes.size === shots.length, `截图 MD5 重复 ${shots.map((item) => item.md5).join(',')}`);
  writeFileSync(path.join(artifactDir, 'md5.json'), JSON.stringify(shots, null, 2));
  writeFileSync(path.join(optDir, 'md5.json'), JSON.stringify(shots, null, 2));
  console.log(shots.map((item) => `${item.md5}  ${item.file}`).join('\n'));
  await browser.close();
  console.log('像素大屏验收通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
