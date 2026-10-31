#!/usr/bin/env node
/**
 * Bug1–11 关键路径验收。
 * 前置：npm run dev:setup && API 3001 与 WEB 5173 已启动。
 * 仅 Playwright。断言失败即退出，不改断言。
 * 页面脚本里去掉 crypto.randomUUID，用来模拟内测站非安全上下文。
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/bugfix-b1-11';
mkdirSync(artifactDir, { recursive: true });

function passwordOf(username) {
  const text = readFileSync('.local/dev-credentials.txt', 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  if (!matched) throw new Error(`找不到账号 ${username} 的密码`);
  return matched[1];
}

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
  });
  const json = await res.json().catch(() => ({}));
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token || !cookie) throw new Error(`登录失败 ${username}: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return { csrf: json.csrf_token, cookie };
}

async function api(session, method, urlPath, body, { allowConflict = false } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (allowConflict && res.status === 409) return json;
  if (!res.ok) throw new Error(`${method} ${urlPath} ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
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
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('截图', file);
}

async function confirmDialog(page, title, text) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.waitFor({ state: 'visible' });
  const row = text ? dialog.locator('.ant-table-tbody .ant-table-row').filter({ hasText: text }).first() : dialog.locator('.ant-table-tbody .ant-table-row').first();
  await row.waitFor({ state: 'visible' });
  await row.locator('.ant-checkbox-input').click();
  await dialog.getByRole('button', { name: /确\s*定/ }).click();
  await dialog.waitFor({ state: 'hidden' });
}

const pageErrors = [];
const password = passwordOf('admin.local');
const session = await login('admin.local', password);
const products = await api(session, 'GET', '/api/products?page=1&page_size=20');
const product = (products.items ?? []).find((item) => item.attribute === 'manufactured') ?? products.items?.[0];
if (!product?.name) throw new Error('没有可用于选品的商品');
const units = await api(session, 'GET', '/api/units');
const unitId = units.items?.[0]?.id;
if (!unitId) throw new Error('没有单位');
await api(session, 'POST', '/api/products', { name: '子件样例', attribute: 'purchased', source: '外购', unit_id: unitId }, { allowConflict: true });
await api(session, 'POST', '/api/processes', { name: '验收工序', standard_minutes: '1' }, { allowConflict: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj) return;
  Object.defineProperty(cryptoObj, 'randomUUID', { configurable: true, value: undefined });
});
const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(String(error)));
await asUser(page, session);

await page.goto(`${WEB}/bom/list`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /新\s*增/ }).click();
await page.waitForURL(/\/bom\/add/);
if (await page.getByText('新增BOM（独立页）').count()) throw new Error('BOM 新增仍是空壳弹窗');
await shot(page, 'bom-add');
await page.locator('.kgd-form span').filter({ hasText: /^BOM名称/ }).locator('xpath=following-sibling::*[1]//input').fill('验收BOM');
await page.locator('.kgd-form span').filter({ hasText: /^商品$/ }).locator('xpath=following-sibling::*[1]').click();
await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText(product.name, { exact: true }).click();
await page.getByRole('button', { name: '选择商品', exact: true }).click();
await confirmDialog(page, '选择商品', '子件样例');
await page.getByRole('table').getByText('子件样例', { exact: true }).waitFor({ state: 'visible' });
await shot(page, 'bom-picked');
await page.getByRole('button', { name: /保\s*存/ }).click();
await page.waitForURL(/\/bom\/list/, { timeout: 15000 });
await page.getByText('验收BOM').first().waitFor({ state: 'visible' });
await shot(page, 'bom-saved');

await page.goto(`${WEB}/inside_produce_bill/add?mode=direct`, { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: '生产任务' }).click();
await page.getByRole('button', { name: '从工序中添加' }).click();
await confirmDialog(page, '从工序中添加');
await page.getByRole('table').getByText('验收工序', { exact: true }).waitFor({ state: 'visible' });
await shot(page, 'process-picked');

await page.goto(`${WEB}/produce_plan/list`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /新\s*增/ }).first().click();
await page.getByRole('button', { name: '+ 选择采购商品' }).click();
await confirmDialog(page, '选择商品');
const plan = page.getByRole('dialog', { name: '新增采购计划' });
await plan.getByRole('button', { name: '删除' }).first().waitFor({ state: 'visible' });
await shot(page, 'plan-picked');

await page.goto(`${WEB}/contract_quotation_bill/list`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /新\s*增/ }).first().click();
await page.getByRole('button', { name: '+ 选择报价单商品' }).click();
await confirmDialog(page, '选择商品');
const quote = page.getByRole('dialog', { name: '新增合同报价单' });
await quote.getByRole('button', { name: '删除' }).first().waitFor({ state: 'visible' });
await shot(page, 'quote-picked');

await page.goto(`${WEB}/customer_invoice/list`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: '申请开票' }).click();
const invoice = page.getByRole('dialog', { name: '申请开票' });
const file = invoice.locator('input[type="file"]');
if (await file.count() !== 1) throw new Error('申请开票没有附件选择');
if (await file.isDisabled()) throw new Error('申请开票附件仍是禁用空壳');
await shot(page, 'invoice-file');

await page.goto(`${WEB}/customer_financier/list`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: '批量操作' }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '+收款' }).click();
const receipt = page.getByRole('dialog', { name: '新增收款' });
await receipt.getByRole('button', { name: '+ 选择发货明细' }).waitFor({ state: 'visible' });
const receiptFile = receipt.locator('input[type="file"]');
if (await receiptFile.count() !== 1 || await receiptFile.isDisabled()) throw new Error('新增收款附件未接上');
await shot(page, 'cash-receipt');

await page.goto(`${WEB}/ware/list`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /新\s*增/ }).click();
const ware = page.getByRole('dialog', { name: '新增仓库' });
const address = ware.locator('.ant-form-item').filter({ hasText: '详细地址' });
if (await address.locator('.ant-form-item-required').count()) throw new Error('详细地址仍是必填');
await shot(page, 'warehouse-address');

await page.goto(`${WEB}/user/list`, { waitUntil: 'networkidle' });
const gap = await page.locator('.ant-btn-link').nth(1).evaluate((node) => getComputedStyle(node).marginInlineStart);
if (gap !== '8px') throw new Error(`连续链接间距是 ${gap}，期望 8px`);
await page.getByRole('button', { name: /修\s*改/ }).first().click();
await page.waitForURL(/\/user\/edit\//);
const username = page.locator('.ant-form-item').filter({ hasText: '用户名' }).locator('input');
await username.waitFor({ state: 'visible' });
let filled = '';
for (let i = 0; i < 40; i += 1) {
  filled = await username.inputValue();
  if (filled) break;
  await page.waitForTimeout(250);
}
if (filled !== 'admin.local') throw new Error(`修改用户未回填用户名，当前「${filled}」`);
const display = await page.locator('.ant-form-item').filter({ hasText: '姓名' }).locator('input').inputValue();
if (!display || display === '-') throw new Error(`修改用户未回填姓名，当前「${display}」`);
if (await page.getByLabel('密码').count()) throw new Error('修改用户仍要求填写密码');
await shot(page, 'user-edit');

await page.goto(`${WEB}/goods/detail/${product.id}`, { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: '商品BOM' }).click();
await page.getByRole('button', { name: '新建BOM' }).waitFor({ state: 'visible' });
await page.getByText('验收BOM').first().waitFor({ state: 'visible' });
await shot(page, 'goods-bom');

const uuidErrors = pageErrors.filter((item) => item.includes('randomUUID'));
if (uuidErrors.length) throw new Error(`页面仍直接调用 randomUUID：${uuidErrors.join(' | ')}`);

await browser.close();
console.log('验收通过');
