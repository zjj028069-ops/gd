#!/usr/bin/env node
/**
 * 工作台按原版 18 项重对齐验收（只使用 Playwright）。
 * 前置：npm run dev:setup && npm run dev
 * 本脚本先跑 scripts/seed-wp-realign.mjs。
 * 禁止 force、禁止条件跳过、禁止没数据就改选第一项。
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = path.join(process.cwd(), 'artifacts/wp-realign');
const docDir = path.join(process.cwd(), 'docs/verification/wp-realign');
const optDir = '/opt/cursor/artifacts/wp-realign';
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });
mkdirSync(optDir, { recursive: true });

const seeded = spawnSync('node', ['scripts/seed-wp-realign.mjs'], { stdio: 'inherit', cwd: process.cwd() });
if (seeded.status !== 0) {
  console.error('造数失败，验收中止');
  process.exit(seeded.status ?? 1);
}

const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const shots = [];

const EXPECTED_NAMES = [
  '快捷入口', '3天快速落地教程', '待办事项', '功能上新', '公告', '未读消息',
  '当月维保任务执行概况', '设备概况', '当月不良品分布', '库存预警', '服务工单走势',
  '当月销售业绩排行', '当月跟单排行', '当月产品产量', '呆滞预警', '生产状况统计',
  '工单执行进度', '本月备料建议',
];
const WRONG_NAMES = ['今日报工概况', '工序进度', '合同概况', '跟单提醒', '维保提醒', '报工排行', '设备稼动'];
const CATEGORY_COUNTS = { 全部: 18, 通用: 4, 工作效率: 2, 智能报表: 12 };

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
  shots.push({ name, file: `artifacts/wp-realign/${name}.png`, md5 });
  return md5;
}

function must(ok, message) {
  if (!ok) throw new Error(message);
}

async function openWorkplace(page) {
  await page.goto(`${WEB}/staging/area`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid=wp-root]').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '配置工作台' }).waitFor({ timeout: 15000 });
}

async function main() {
  const session = await login();
  const cfg = await api(session, '/api/workplace/config');
  const catalog = cfg.card_catalog ?? [];
  must(catalog.length === 18, `API catalog ${catalog.length} ≠ 18`);
  const apiNames = catalog.map((item) => item.name);
  for (const name of EXPECTED_NAMES) must(apiNames.includes(name), `API 缺少 ${name}`);
  for (const name of WRONG_NAMES) must(!apiNames.includes(name), `API 仍有错名 ${name}`);
  must(catalog.filter((item) => item.category === '通用').length === 4, 'API 通用 ≠ 4');
  must(catalog.filter((item) => item.category === '工作效率').length === 2, 'API 工作效率 ≠ 2');
  must(catalog.filter((item) => item.category === '智能报表').length === 12, 'API 智能报表 ≠ 12');

  const summary = await api(session, '/api/workplace/summary');
  const widgets = summary.widgets ?? {};
  for (const wrongKey of ['today_report', 'process_progress', 'contract_overview', 'follow_remind', 'maint_remind', 'report_rank', 'device_oee']) {
    must(widgets[wrongKey] === undefined, `summary.widgets 仍有错名 key ${wrongKey}`);
  }
  must(Number(widgets.stock_alert?.lower) >= 1, `库存低于下限 ${widgets.stock_alert?.lower}`);
  must(Number(widgets.stock_alert?.upper) >= 1, `库存高于上限 ${widgets.stock_alert?.upper}`);
  must((widgets.wo_progress?.items ?? []).length >= 1 || Number(widgets.production_stats?.total) >= 1, '工单执行进度/生产状况无数据');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await asUser(page, session);

  await openWorkplace(page);
  const boardText = await page.locator('[data-testid=wp-board]').innerText();
  for (const name of WRONG_NAMES) must(!boardText.includes(name), `看板残留错名 ${name}`);
  must(boardText.includes('设备概况'), '默认布局缺少设备概况');
  must(boardText.includes('库存预警'), '默认布局缺少库存预警');
  must(boardText.includes('工单执行进度'), '默认布局缺少工单执行进度');
  await page.locator('[data-testid=wp-widget-stock_alert]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => {
    const upper = document.querySelector('[data-testid="wp-widget-stock_alert"] [data-metric="upper"] b');
    const lower = document.querySelector('[data-testid="wp-widget-stock_alert"] [data-metric="lower"] b');
    return Number((upper?.textContent ?? '').replace(/[^\d.]/g, '')) >= 1
      && Number((lower?.textContent ?? '').replace(/[^\d.]/g, '')) >= 1;
  }, null, { timeout: 15000 });
  must((await page.locator('[data-testid=wp-widget-stock_alert] .ant-empty').count()) === 0, '库存预警仍是 Empty 占位');
  must(!(await page.locator('[data-testid=wp-widget-stock_alert]').innerText()).includes('占位组件'), '库存预警写着占位组件');
  await shot(page, '01-工作台整页');

  await page.getByRole('button', { name: '配置工作台' }).click();
  await page.locator('.wp-editing').waitFor({ timeout: 10000 });
  await page.locator('.wp-toolbar').getByRole('button', { name: '添加组件' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '添加组件' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });

  for (const [tab, count] of Object.entries(CATEGORY_COUNTS)) {
    const tabNode = modal.locator(`[data-testid=wp-tab-${tab}]`);
    await tabNode.waitFor({ state: 'visible', timeout: 5000 });
    const label = (await tabNode.innerText()).replace(/\s+/g, '');
    must(label === `${tab}·${count}`, `Tab ${tab} 文案「${label}」≠「${tab}·${count}」`);
  }

  await modal.locator('[data-testid=wp-tab-全部]').click();
  const cards = modal.locator('[data-testid=wp-widget-card]');
  must(await cards.count() === 18, `添加组件卡片 ${await cards.count()} ≠ 18`);
  must(await modal.locator('[data-testid=wp-picker-grid]').getAttribute('data-widget-count') === '18', 'data-widget-count ≠ 18');

  const uiNames = [];
  for (let i = 0; i < 18; i += 1) {
    const name = await cards.nth(i).getAttribute('data-name');
    uiNames.push(name);
  }
  must(JSON.stringify(uiNames) === JSON.stringify(EXPECTED_NAMES), `弹窗顺序/名称不符：${uiNames.join(',')}`);
  for (const name of WRONG_NAMES) must(!uiNames.includes(name), `弹窗仍有错名 ${name}`);

  for (const [category, count] of Object.entries({ 通用: 4, 工作效率: 2, 智能报表: 12 })) {
    await modal.locator(`[data-testid=wp-tab-${category}]`).click();
    const visible = modal.locator('[data-testid=wp-widget-card]:visible');
    must(await visible.count() === count, `${category} 可见 ${await visible.count()} ≠ ${count}`);
    const cats = await visible.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-category')));
    must(cats.every((item) => item === category), `${category} Tab 混入其他分类`);
  }

  await modal.locator('[data-testid=wp-tab-全部]').click();
  await shot(page, '02-添加组件弹窗');

  async function confirmAdd(modalRoot, key) {
    const card = modalRoot.locator(`[data-testid=wp-widget-card][data-key=${key}]`);
    await card.waitFor({ state: 'visible', timeout: 5000 });
    must(!(await card.evaluate((el) => el.classList.contains('is-disabled') || el.disabled)), `${key} 已被标记为已添加，无法再测添加`);
    await card.click();
    await page.waitForFunction((k) => {
      const el = document.querySelector(`[data-testid="wp-widget-card"][data-key="${k}"]`);
      return Boolean(el && el.classList.contains('is-selected'));
    }, key, { timeout: 5000 });
    await modalRoot.locator('.ant-modal-footer').getByRole('button', { name: /^确\s*定$/ }).click();
    await modalRoot.waitFor({ state: 'hidden', timeout: 10000 });
    await page.locator(`[data-testid=wp-widget-${key}]`).waitFor({ state: 'visible', timeout: 8000 });
  }

  async function clickSave() {
    await page.locator('[data-testid=wp-root].wp-editing').waitFor({ state: 'visible', timeout: 5000 });
    const save = page.locator('.wp-toolbar').getByRole('button', { name: /^保\s*存$/ });
    await save.waitFor({ state: 'visible', timeout: 10000 });
    await save.click();
    await page.locator('[data-testid=wp-root].wp-editing').waitFor({ state: 'detached', timeout: 15000 });
  }

  // 添加「当月跟单排行」，保存，再移除，再加回
  await confirmAdd(modal, 'follow_rank');
  await clickSave();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid=wp-widget-follow_rank]').waitFor({ state: 'visible', timeout: 20000 });
  must((await page.locator('[data-testid=wp-widget-follow_rank]').innerText()).includes('当月跟单排行'), '保存后跟单排行标题丢失');
  await page.locator('[data-testid=wp-widget-follow_rank]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '03-已添加跟单排行');

  await page.getByRole('button', { name: '配置工作台' }).click();
  await page.locator('[data-testid=wp-root].wp-editing').waitFor({ timeout: 10000 });
  await page.locator('[data-testid=wp-widget-follow_rank] [aria-label=移除]').click();
  must(await page.locator('[data-testid=wp-widget-follow_rank]').count() === 0, '移除后草稿仍见跟单排行');
  await clickSave();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid=wp-root]').waitFor({ timeout: 20000 });
  must(await page.locator('[data-testid=wp-widget-follow_rank]').count() === 0, '移除保存后跟单排行仍在');

  await page.getByRole('button', { name: '配置工作台' }).click();
  await page.locator('[data-testid=wp-root].wp-editing').waitFor({ timeout: 10000 });
  await page.locator('.wp-toolbar').getByRole('button', { name: '添加组件' }).click();
  const modal2 = page.locator('.ant-modal').filter({ hasText: '添加组件' }).last();
  await modal2.waitFor({ state: 'visible', timeout: 10000 });
  await modal2.locator('[data-testid=wp-tab-智能报表]').click();
  const stockCard = modal2.locator('[data-testid=wp-widget-card][data-key=stock_alert]');
  await stockCard.waitFor({ state: 'visible', timeout: 5000 });
  must((await stockCard.innerText()).includes('库存预警'), '智能报表 Tab 无库存预警');
  must((await stockCard.innerText()).includes('库存数量超出报警线范围的商品种类数量'), '库存预警描述不符');
  await shot(page, '04-库存预警目录卡');
  await modal2.locator('.ant-modal-footer').getByRole('button', { name: /^取\s*消$/ }).click();
  await modal2.waitFor({ state: 'hidden', timeout: 10000 });

  // 再加回跟单排行证明可添加
  await page.locator('.wp-toolbar').getByRole('button', { name: '添加组件' }).click();
  const modal3 = page.locator('.ant-modal').filter({ hasText: '添加组件' }).last();
  await modal3.waitFor({ state: 'visible', timeout: 10000 });
  await modal3.locator('[data-testid=wp-tab-全部]').click();
  await confirmAdd(modal3, 'follow_rank');
  await clickSave();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid=wp-widget-follow_rank]').waitFor({ state: 'visible', timeout: 20000 });
  await shot(page, '05-移除再添加跟单排行');

  await browser.close();

  const md5s = new Set(shots.map((item) => item.md5));
  must(md5s.size === shots.length, `截图 MD5 有重复：${shots.map((item) => item.md5).join(',')}`);
  must(shots.length >= 4, `截图不足 ${shots.length}`);

  writeFileSync(path.join(artifactDir, 'md5.json'), `${JSON.stringify(shots, null, 2)}\n`);
  writeFileSync(path.join(docDir, 'md5.json'), `${JSON.stringify(shots, null, 2)}\n`);
  writeFileSync(path.join(docDir, '说明.md'), `# wp-realign 截图说明

本目录是 \`node scripts/wp-realign-accept.mjs\` 的 Playwright 截图与 \`md5.json\`。
验收结论见 \`docs/工作台18项重对齐验收记录.md\`。
`);

  console.log('通过\t工作台 18 项重对齐验收');
  for (const item of shots) console.log(`截图\t${item.file}\t${item.md5}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
