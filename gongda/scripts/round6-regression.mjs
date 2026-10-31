/**
 * 合并主线后重截工资 750 与合同欠款 9000。
 * 前置：npm run dev
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/round6');
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];

async function loginApi() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!json.csrf_token) throw new Error(`login failed ${JSON.stringify(json).slice(0, 300)}`);
  return { csrf: json.csrf_token, cookie, userId: json.user?.id };
}
async function api(session, method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: session.cookie, ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${urlPath} ${res.status}: ${text.slice(0, 600)}`);
  return json;
}
function byBtn(scope, label) {
  return scope.getByRole('button', { name: new RegExp(`^\\s*${label.split('').join('\\s*')}\\s*$`) });
}

async function main() {
  const session = await loginApi();
  const me = await api(session, 'GET', '/api/auth/me');
  const userId = me.user?.id ?? session.userId;
  const products = await api(session, 'GET', '/api/products?page=1&page_size=100');
  // 理由：activeProduct 要求 products JOIN units 且双方 active；attribute 为空且无 unit_id 的表单商品（如 SP*）
  // 会命中旧条件 `!item.attribute` 却在建加工单时 422「产品不存在」。只认 attribute==='manufactured' 且有 unit。
  const usable = (item) => item.active !== false && item.attribute === 'manufactured' && item.unit_id;
  let product = (products.items ?? []).find(usable);
  const units = await api(session, 'GET', '/api/units');
  const unitId = (units.items ?? []).find((u) => u.active !== false)?.id ?? units.items?.[0]?.id;
  if (!product && unitId) {
    product = (await api(session, 'POST', '/api/products', {
      code: `R6RG-${Date.now().toString().slice(-6)}`, name: 'R6回归产品', unit_id: unitId, attribute: 'manufactured',
    })).product;
  }
  if (!product?.id) throw new Error('没有可用自产商品（需 active + manufactured + unit_id）');
  const warehouses = await api(session, 'GET', '/api/warehouses');
  const warehouse = warehouses.items?.find((item) => item.code === 'WH01') ?? warehouses.items?.[0];
  if (!warehouse) throw new Error('没有仓库');

  const heat = (await api(session, 'POST', '/api/processes', {
    code: `GXW${String(Date.now()).slice(-6)}`,
    name: '热处理',
    standard_minutes: '1',
    reporter_ids: [userId],
    pricing_mode: 'piece',
    wage_rate: '10',
    inspection_scheme: 'none',
  })).process;
  const created = await api(session, 'POST', '/api/work-orders', {
    request_key: crypto.randomUUID(),
    product_id: product.id,
    quantity: '80',
    warehouse_id: warehouse.id,
    priority: 'normal',
    due_date: '2026-10-12',
    tasks: [{ process_id: heat.id, pricing_mode: 'piece', wage_rate: '10' }],
  });
  let order = created.work_order;
  order = (await api(session, 'POST', `/api/work-orders/${order.id}/actions`, { action: 'start', version: order.version })).work_order;
  let task = order.tasks[0];
  if (task.execution === 'not_started') {
    await api(session, 'POST', `/api/work-orders/${order.id}/tasks/${task.id}/actions`, { action: 'start', version: task.version });
    order = (await api(session, 'GET', `/api/work-orders/${order.id}`)).work_order;
    task = order.tasks[0];
  }
  console.log('wage order', order.code, task.process_name, task.execution, task.wage_rate);

  const customers = await api(session, 'GET', '/api/customers');
  let customer = customers.items?.[0];
  if (!customer) {
    customer = (await api(session, 'POST', '/api/customers', { request_key: crypto.randomUUID(), code: 'KH-R6', name: '演示客户' })).customer;
  }
  let contract = (await api(session, 'POST', '/api/money/contracts', {
    request_key: crypto.randomUUID(),
    customer_id: customer.id,
    prepay: '1000',
    amount: '10000',
    submit: true,
    lines: [{ product_id: product.id, quantity: '1', unit_price: '10000', discount: '10', concession: '0' }],
  })).contract;
  if (contract.approval === 'pending') {
    contract = (await api(session, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version, opinion: '通过' })).contract;
  }
  console.log('contract', contract.code, contract.approval, 'amount', contract.amount, 'received', contract.received, 'debt', contract.debt);
  if (!String(contract.debt).includes('9000')) throw new Error(`欠款不是 9000：${contract.debt}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${WEB}/login`);
  await page.waitForTimeout(600);
  if (page.url().includes('/login')) {
    const inputs = page.locator('input');
    await inputs.nth(0).fill('demo-a');
    await inputs.nth(1).fill('admin.local');
    await inputs.nth(2).fill(pass);
    await page.getByRole('button', { name: /登\s*录\s*工\s*作\s*空\s*间/ }).click();
    await page.waitForTimeout(1500);
  }
  await page.goto(`${WEB}/work_report_workbench`);
  await page.getByText('快速报工').waitFor();
  const right = page.locator('.kgd-workbench-right');
  const orderSelect = right.locator('.ant-select').nth(0);
  await orderSelect.click();
  await orderSelect.locator('input').fill(order.code);
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: order.code }).first().click();
  await page.waitForTimeout(400);
  await right.locator('.ant-select').nth(1).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: '热处理' }).last().click();
  await page.waitForTimeout(400);
  await right.locator('.kgd-form span', { hasText: /^良品数$/ }).locator('xpath=following-sibling::span[1]//input').first().fill('75');
  await right.locator('.kgd-form span', { hasText: '不良品数' }).locator('xpath=following-sibling::span[1]//input').first().fill('5');
  await page.waitForFunction(() => document.body.innerText.includes('750'), null, { timeout: 5000 });
  await page.screenshot({ path: path.join(outDir, 'r01-wage-750-regression.png') });
  console.log('saved r01');
  await byBtn(right, '报工').click();
  await page.waitForTimeout(800);
  const reports = await api(session, 'GET', `/api/production-reports?work_order_id=${order.id}&page=1&page_size=20`);
  const wageRow = (reports.items ?? []).find((item) => String(item.good_qty).startsWith('75'));
  console.log('report wage', wageRow?.estimated_wage, wageRow?.good_qty, wageRow?.defect_qty);

  await page.goto(`${WEB}/customer_contract/list`);
  await page.waitForTimeout(1200);
  const codeBox = page.getByPlaceholder('合同编号');
  if (await codeBox.count()) {
    await codeBox.fill(contract.code);
    await byBtn(page, '查询').click();
    await page.waitForTimeout(800);
  }
  await page.waitForFunction((needle) => document.body.innerText.includes(needle), '9000', { timeout: 8000 });
  const table = page.locator('.ant-table-content, .ant-table-body').first();
  if (await table.count()) {
    await table.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: path.join(outDir, 'r02-contract-debt-9000.png') });
  console.log('saved r02');
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
