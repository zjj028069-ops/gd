/**
 * UAT P1：未引用供应商可删除；采购列表勾选非首行后付款记到该行。
 * 前置：npm run dev:setup && npm run dev
 * 只走 Playwright，不改断言去凑结果。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const shotDir = process.env.UAT_P1_SHOTS ?? '/opt/cursor/artifacts';
mkdirSync(shotDir, { recursive: true });

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

async function api(session, method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${urlPath} ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([{
    name: raw.slice(0, eq),
    value: raw.slice(eq + 1),
    url: WEB,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

function rowByText(page, text) {
  return page.locator('.ant-table-tbody tr.ant-table-row', { hasText: text });
}
function nameRe(name) {
  return new RegExp(`^${[...name].map((ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch)).join('\\s*')}$`);
}
function buttonNamed(root, name) {
  return root.getByRole('button', { name: nameRe(name) });
}

const pass = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!pass) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local 密码');
const admin = await login('admin.local', pass);
const stamp = Date.now().toString().slice(-6);
const supplierName = `P1可删${stamp}`;
const created = await api(admin, 'POST', '/api/money/suppliers', { name: supplierName, contact_name: '验收' });
const supplierId = created.supplier.id;

const units = await api(admin, 'GET', '/api/units');
const unit = units.items.find((item) => item.code === 'EA') ?? units.items[0];
if (!unit) throw new Error('没有可用单位');
const product = (await api(admin, 'POST', '/api/products', { code: `P1${stamp}`, name: `P1付款件${stamp}`, unit_id: unit.id, attribute: 'purchased' })).product;
const paySupplier = (await api(admin, 'POST', '/api/money/suppliers', { name: `P1付款供${stamp}`, contact_name: '付款' })).supplier;
const warehouse = (await api(admin, 'POST', '/api/warehouses', { request_key: randomUUID(), code: `P1${stamp}`, name: `P1仓${stamp}` })).warehouse;

async function orderWithDebt(note, quantity) {
  const order = (await api(admin, 'POST', '/api/money/purchase-orders', {
    supplier_id: paySupplier.id,
    note,
    lines: [{ product_id: product.id, quantity, unit_price: '100' }],
  })).purchase_order;
  const receipt = (await api(admin, 'POST', '/api/purchase-receipts', {
    request_key: randomUUID(),
    order_id: order.id,
    warehouse_id: warehouse.id,
    lines: [{ purchase_line_id: order.lines[0].id, quantity }],
  })).purchase_receipt;
  await api(admin, 'POST', `/api/purchase-receipts/${receipt.id}/actions`, { request_key: randomUUID(), action: 'approve', version: receipt.version });
  return (await api(admin, 'GET', `/api/money/purchase-orders/${order.id}`)).purchase_order;
}

const older = await orderWithDebt(`较早${stamp}`, '2');
const newer = await orderWithDebt(`较新${stamp}`, '3');
if (older.debt !== '200' || newer.debt !== '300') throw new Error(`欠款不符合预期 ${older.debt} / ${newer.debt}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await asUser(page, admin);
  await page.goto(`${WEB}/supplier/list`, { waitUntil: 'domcontentloaded' });
  await buttonNamed(page, '新增').first().waitFor({ timeout: 30000 });
  await page.getByPlaceholder('供应商名称').fill(supplierName);
  await buttonNamed(page, '查询').click();
  const supplierRow = rowByText(page, supplierName);
  await supplierRow.waitFor({ timeout: 15000 });
  await supplierRow.getByRole('button', { name: '删除', exact: true }).click();
  const deleting = page.waitForResponse((res) => res.request().method() === 'DELETE' && res.url().includes(`/api/money/suppliers/${supplierId}`));
  await page.locator('.ant-modal-confirm').getByRole('button', { name: nameRe('确定') }).click();
  const deleted = await deleting;
  if (deleted.status() !== 200) throw new Error(`删除供应商失败 ${deleted.status()} ${await deleted.text()}`);
  await supplierRow.waitFor({ state: 'detached', timeout: 15000 });
  const left = await api(admin, 'GET', '/api/money/suppliers');
  if (left.items.some((item) => item.id === supplierId)) throw new Error('接口仍能查到已删除供应商');
  await page.screenshot({ path: path.join(shotDir, 'supplier_deleted.png') });

  await page.goto(`${WEB}/purchase_order/list`, { waitUntil: 'domcontentloaded' });
  await buttonNamed(page, '新增').first().waitFor({ timeout: 30000 });
  await rowByText(page, newer.code).waitFor({ timeout: 15000 });
  const codes = await page.locator('.ant-table-tbody tr.ant-table-row').evaluateAll((rows) => rows.map((row) => row.innerText));
  if (!codes[0]?.includes(newer.code)) throw new Error(`列表第一行不是较新采购单。首行：${codes[0]?.slice(0, 80)}`);
  if (!codes.some((text) => text.includes(older.code))) throw new Error('较早采购单不在当前页');
  const toolbar = page.locator('.kgd-toolbar').filter({ has: buttonNamed(page, '新增') });
  await buttonNamed(toolbar, '付款').click();
  await page.getByText('请先勾选采购单').waitFor({ timeout: 5000 });
  if (await page.getByRole('dialog', { name: '新增采购付款' }).count()) throw new Error('未勾选时仍打开了付款弹窗');

  const targetRow = rowByText(page, older.code);
  await targetRow.locator('.ant-checkbox').click();
  if (!(await targetRow.locator('.ant-checkbox-checked').count())) throw new Error('较早采购单未勾选');
  await buttonNamed(toolbar, '付款').click();
  const dialog = page.getByRole('dialog', { name: '新增采购付款' });
  await dialog.waitFor();
  const debt = await dialog.locator('.ant-form-item', { hasText: '待付款' }).locator('input').inputValue();
  if (debt !== older.debt) throw new Error(`付款弹窗待付款是 ${debt}，期望勾选行 ${older.debt}，不是第一行 ${newer.debt}`);
  await page.screenshot({ path: path.join(shotDir, 'pay_selected_row.png') });
  await dialog.locator('.ant-form-item', { hasText: '付款金额' }).locator('input').fill('40');
  await dialog.locator('textarea').fill(`勾选${older.code}`);
  const paying = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/pay'));
  await buttonNamed(dialog, '提交').click();
  const paidRes = await paying;
  const paidUrl = paidRes.url();
  if (!paidUrl.includes(older.id)) throw new Error(`付款请求没有带上勾选行 ${older.id}：${paidUrl}`);
  if (paidUrl.includes(newer.id)) throw new Error(`付款请求落到了第一行 ${newer.id}`);
  if (paidRes.status() !== 200) throw new Error(`付款失败 ${paidRes.status()} ${await paidRes.text()}`);
  const body = paidRes.request().postDataJSON();
  if (body.order_id !== older.id) throw new Error(`请求体 order_id=${body.order_id}，期望 ${older.id}`);
  await page.locator('.ant-message').getByText('已付款', { exact: true }).waitFor({ timeout: 10000 });

  const olderAfter = (await api(admin, 'GET', `/api/money/purchase-orders/${older.id}`)).purchase_order;
  const newerAfter = (await api(admin, 'GET', `/api/money/purchase-orders/${newer.id}`)).purchase_order;
  if (olderAfter.paid !== '40') throw new Error(`勾选行已付款 ${olderAfter.paid}，期望 40`);
  if (newerAfter.paid !== '0') throw new Error(`第一行被误付款，已付款 ${newerAfter.paid}`);
  const records = await api(admin, 'GET', '/api/money/purchase-payments');
  const hit = records.items.find((item) => item.order_id === older.id);
  if (!hit || hit.order_code !== older.code) throw new Error('付款记录没有保留勾选采购单号');
  if (records.items.some((item) => item.order_id === newer.id)) throw new Error('第一行出现了付款记录');

  await page.goto(`${WEB}/purchase_pay_record/list`, { waitUntil: 'domcontentloaded' });
  await rowByText(page, older.code).waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(shotDir, 'pay_record_linked.png') });
  console.log(`通过\t删除供应商 ${supplierName}\t付款记在 ${older.code}，第一行 ${newer.code} 未付款`);
} finally {
  await browser.close();
}
