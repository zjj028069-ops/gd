#!/usr/bin/env node
/**
 * 补残差与工作台组件验收（只使用 Playwright）。
 * 前置：npm run dev:setup && npm run dev
 * 本脚本先跑 scripts/seed-screen-wp.mjs（正式接口造数）。
 * 禁止 force、禁止条件跳过、禁止没数据就改选第一项。
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = path.join(process.cwd(), 'artifacts/screen-wp');
const docDir = path.join(process.cwd(), 'docs/verification/screen-wp');
const optDir = '/opt/cursor/artifacts/screen-wp';
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });
mkdirSync(optDir, { recursive: true });

const seeded = spawnSync('node', ['scripts/seed-screen-wp.mjs'], { stdio: 'inherit', cwd: process.cwd() });
if (seeded.status !== 0) {
  console.error('造数失败，验收中止');
  process.exit(seeded.status ?? 1);
}

const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const shots = [];
const widgetKeys = ['today_report', 'process_progress', 'contract_overview', 'follow_remind', 'maint_remind', 'stock_alert', 'report_rank', 'device_oee'];

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
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
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
  writeFileSync(path.join(docDir, `${name}.png`), readFileSync(file));
  const md5 = createHash('md5').update(readFileSync(file)).digest('hex');
  shots.push({ name, file: `artifacts/screen-wp/${name}.png`, md5 });
  return md5;
}

function must(ok, message) {
  if (!ok) throw new Error(message);
}

async function openScreen(page, id) {
  await page.goto(`${WEB}/_screen/pd/${id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.kgd-screen-title').waitFor({ timeout: 20000 });
  await page.locator('.kgd-people-card').first().waitFor({ timeout: 20000 });
}

async function addWidget(page, key) {
  await page.locator('.wp-toolbar').getByRole('button', { name: '添加组件' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '添加组件' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  await modal.getByRole('tab', { name: '工作效率' }).click();
  const card = modal.locator(`[data-testid=wp-widget-card][data-key=${key}]`);
  await card.waitFor({ state: 'visible', timeout: 8000 });
  must((await card.innerText()).includes('原版未采到'), `${key} 添加卡没有原版未采到`);
  must(!(await card.innerText()).includes('占位组件'), `${key} 添加卡仍写占位组件`);
  await card.click();
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  await page.locator(`[data-testid=wp-widget-${key}]`).waitFor({ state: 'visible', timeout: 8000 });
}

async function main() {
  const session = await login();
  const screens = (await api(session, '/api/data-screens')).items ?? [];
  must(!screens.some((item) => item.menu_name === '像素验收设计屏'), 'seed 后仍有像素验收设计屏');
  must(!screens.some((item) => item.menu_name === '临时设计验收'), 'seed 后仍有临时设计验收');
  const control = screens.find((item) => item.menu_name === '生产中控大屏');
  if (!control) throw new Error('缺少生产中控大屏');
  const controlData = await api(session, `/api/progress/screen-data/${control.id}`);
  const trendDays = [...new Set((controlData.employee_trend ?? []).map((row) => String(row.day)))];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await asUser(page, session);

  await page.goto(`${WEB}/screen_management/list`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-label="生产中控大屏"]').waitFor({ timeout: 20000 });
  const sideText = await page.locator('body').innerText();
  must(!sideText.includes('像素验收设计屏'), '侧栏或列表仍有像素验收设计屏');
  must(!sideText.includes('临时设计验收'), '侧栏或列表仍有临时设计验收');
  await shot(page, '01-大屏管理无残留设计屏');

  await openScreen(page, control.id);
  must(await page.locator('[data-module="人员生产统计"] .kgd-people-card').count() >= 1, '人员生产统计没有头像卡');
  must(await page.locator('[data-module="人员生产统计"] table').count() === 0, '人员生产统计倒回了表格');
  must(await page.locator('[data-module="人员生产统计"] img').count() === 0, '人员生产统计出现了图片');
  const avatar = page.locator('[data-module="人员生产统计"] .kgd-avatar[data-avatar="initial"]').first();
  const shape = await avatar.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      text: (el.textContent ?? '').trim(),
      radius: Number.parseFloat(style.borderRadius),
      width: Number.parseFloat(style.width),
    };
  });
  must([...shape.text].length === 1, `首字色块不是单字：${shape.text}`);
  must(shape.width > 0 && shape.radius >= shape.width / 2 - 1, `首字色块不是圆形：半径 ${shape.radius} 宽 ${shape.width}`);
  await shot(page, '02-人员生产统计首字色块');

  const created = await api(session, '/api/data-screens', 'POST', {
    menu_name: '临时设计验收', layout: '左右双模块', module_kind: '生产模块', description: '临时', access_password: '',
  });
  if (!created.id) throw new Error('临时设计屏没有 id');
  let designerError = null;
  try {
    await page.goto(`${WEB}/_screen/editpd/${created.id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-module="employee_defect"]').waitFor({ timeout: 20000 });
    await page.locator('[data-slot="1"]').waitFor();
    await page.locator('[data-module="employee_defect"]').dragTo(page.locator('[data-slot="1"]'), { targetPosition: { x: 40, y: 24 } });
    await page.locator('[data-slot="1"]').getByText('人员不良品率').waitFor({ timeout: 8000 });
    const saved = page.waitForResponse((response) => response.url().includes('/design') && response.request().method() === 'PUT', { timeout: 15000 });
    await page.getByRole('button', { name: '保存' }).click();
    const savedResponse = await saved;
    must(savedResponse.ok(), `设计保存失败 ${savedResponse.status()}`);
    await page.getByText('已保存').waitFor({ timeout: 8000 });
    await shot(page, '03-设计器拖入');
    await page.goto(`${WEB}/_screen/pd/${created.id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-module="人员不良品率"]').waitFor({ timeout: 20000 });
    must(await page.locator('[data-module="人员不良品率"]').count() >= 1, '保存后查看没有人员不良品率');
    await shot(page, '04-设计保存后查看');
  } catch (error) {
    designerError = error;
  }
  await api(session, `/api/data-screens/${created.id}`, 'DELETE');
  const afterScreens = (await api(session, '/api/data-screens')).items ?? [];
  if (afterScreens.some((item) => item.id === created.id || item.menu_name === '临时设计验收' || item.menu_name === '像素验收设计屏')) {
    throw new Error('临时设计屏删除后仍在列表');
  }
  if (designerError) throw designerError;

  const beforeConfig = await api(session, '/api/workplace/config');
  await api(session, '/api/workplace/config', 'PUT', {
    cards: ['banner', 'shortcuts', 'todos', 'notices', 'messages', 'devices'].map((key) => ({ key, visible: true })),
    layout: [],
    shortcuts: beforeConfig.shortcuts,
    todo_prefs: beforeConfig.todo_prefs,
    version: beforeConfig.version,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/staging/area`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '配置工作台' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '配置工作台' }).click();
  await page.locator('.wp-toolbar').getByRole('button', { name: '添加组件' }).click();
  const picker = page.locator('.ant-modal').filter({ hasText: '添加组件' }).last();
  await picker.waitFor();
  const pickerText = await picker.innerText();
  must(!pickerText.includes('占位组件'), '添加组件弹窗仍有占位组件');
  must((pickerText.match(/原版未采到/g) ?? []).length >= 8, '添加组件弹窗原版未采到不足 8');
  await shot(page, '05-添加组件无占位');
  await picker.getByRole('button', { name: /取\s*消/ }).click();

  for (const key of widgetKeys) await addWidget(page, key);
  await page.locator('.wp-toolbar').getByRole('button', { name: /保\s*存/ }).click();
  await page.getByRole('button', { name: '配置工作台' }).waitFor({ timeout: 15000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '配置工作台' }).waitFor({ timeout: 20000 });

  const expectations = {
    today_report: async (card) => {
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="wp-widget-today_report"] [data-metric="report_count"] b')?.textContent) >= 1, null, { timeout: 15000 });
      must((await card.innerText()).includes('良品数'), '今日报工概况没有良品数');
    },
    process_progress: async (card) => {
      await card.locator('[data-testid=wp-lines] [data-line]').first().waitFor({ timeout: 15000 });
      must(await card.locator('[data-testid=wp-lines] [data-line]').count() >= 1, '工序进度没有明细');
      must((await card.innerText()).includes('%'), '工序进度没有百分比');
    },
    contract_overview: async (card) => {
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="wp-widget-contract_overview"] [data-metric="total"] b')?.textContent) >= 1, null, { timeout: 15000 });
      await card.getByText('像素跟单客户').waitFor({ timeout: 15000 });
    },
    follow_remind: async (card) => {
      await card.getByText('像素跟单回访').waitFor({ timeout: 15000 });
    },
    maint_remind: async (card) => {
      await card.getByText('像素维保计划').waitFor({ timeout: 15000 });
      await card.getByText('未开始').waitFor({ timeout: 15000 });
    },
    stock_alert: async (card) => {
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="wp-widget-stock_alert"] [data-metric="lower"] b')?.textContent) >= 1, null, { timeout: 15000 });
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="wp-widget-stock_alert"] [data-metric="upper"] b')?.textContent) >= 1, null, { timeout: 15000 });
      const text = await card.innerText();
      must(text.includes('低于下限') && text.includes('高于上限'), '库存预警缺少上下限');
    },
    report_rank: async (card) => {
      await card.locator('[data-testid=wp-lines] [data-line]').first().waitFor({ timeout: 15000 });
      const qty = await card.locator('[data-testid=wp-lines] b').first().innerText();
      must(Number(qty) >= 1, `报工排行数量不对 ${qty}`);
    },
    device_oee: async (card) => {
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="wp-widget-device_oee"] [data-metric="运行中"] b')?.textContent) >= 1, null, { timeout: 15000 });
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="wp-widget-device_oee"] [data-metric="维修中"] b')?.textContent) >= 1, null, { timeout: 15000 });
    },
  };
  for (const key of widgetKeys) {
    const card = page.locator(`[data-testid=wp-widget-${key}]`);
    await card.scrollIntoViewIfNeeded();
    const text = await card.innerText();
    must(text.includes('原版未采到'), `${key} 卡片没有原版未采到`);
    must(!text.includes('占位组件'), `${key} 卡片仍写占位组件`);
    must(await card.locator('.ant-empty').count() === 0, `${key} 仍是 Empty 占位`);
    await expectations[key](card);
  }
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.locator('[data-testid=wp-widget-today_report]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, '06-工作台八卡');

  await page.getByRole('button', { name: '配置工作台' }).click();
  await page.locator('[data-testid=wp-widget-device_oee] [aria-label=移除]').click();
  await page.locator('.wp-toolbar').getByRole('button', { name: /保\s*存/ }).click();
  await page.getByRole('button', { name: '配置工作台' }).waitFor({ timeout: 15000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '配置工作台' }).waitFor({ timeout: 20000 });
  must(await page.locator('[data-testid=wp-widget-device_oee]').count() === 0, '移除设备稼动后刷新仍在');
  await page.getByRole('button', { name: '配置工作台' }).click();
  await addWidget(page, 'device_oee');
  await page.locator('.wp-toolbar').getByRole('button', { name: /保\s*存/ }).click();
  await page.getByRole('button', { name: '配置工作台' }).waitFor({ timeout: 15000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid=wp-widget-device_oee]').waitFor({ timeout: 20000 });
  must((await page.locator('[data-testid=wp-widget-device_oee]').innerText()).includes('原版未采到'), '加回后设备稼动丢了未采到标');
  await page.locator('[data-testid=wp-widget-device_oee]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '07-移除后再加回');

  const hashes = new Set(shots.map((item) => item.md5));
  must(hashes.size === shots.length, `截图 MD5 重复 ${shots.map((item) => `${item.name}:${item.md5}`).join(',')}`);
  const report = { shots, trend_days: trendDays, trend_cross_day: trendDays.length >= 2 };
  writeFileSync(path.join(artifactDir, 'md5.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(docDir, 'md5.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(optDir, 'md5.json'), JSON.stringify(report, null, 2));
  console.log(shots.map((item) => `${item.md5}  ${item.file}`).join('\n'));
  console.log(`产能折线天数 ${trendDays.length} ${trendDays.join(',')}`);
  await browser.close();
  console.log('补残差与工作台组件验收通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
