import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const outDir = '/workspace/docs/verification/merge-r4';
mkdirSync(outDir, { recursive: true });
const password = readFileSync('/workspace/.local/dev-credentials.txt', 'utf8').match(/admin\.local\n密码：(.+)/)[1];
const h = (cookie, csrf, write = false) => ({ cookie, 'content-type': 'application/json', ...(write ? { 'x-csrf-token': csrf } : {}) });

async function apiLogin() {
  const login = await fetch('http://127.0.0.1:3001/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const csrf = (await login.json()).csrf_token;
  return { cookie, csrf };
}

async function seedWageScenario({ cookie, csrf }) {
  const post = async (url, body) => {
    const res = await fetch(`http://127.0.0.1:3001${url}`, { method: 'POST', headers: h(cookie, csrf, true), body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(`${url} ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const get = async (url) => (await fetch(`http://127.0.0.1:3001${url}`, { headers: h(cookie, csrf) })).json();
  const products = await get('/api/products?q=LOCAL');
  const product = products.items[0];
  const warehouses = await get('/api/warehouses');
  const warehouse = warehouses.items.find((w) => w.code === 'WH01') ?? warehouses.items[0];
  const team = await get('/api/team-members');
  const reporter = team.items[0].id;
  const heat = (await post('/api/processes', { code: `GX-${Date.now()}`, name: '热处理', standard_minutes: '1', reporter_ids: [reporter], pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none' })).process;
  const order = (await post('/api/work-orders', { request_key: crypto.randomUUID(), product_id: product.id, quantity: '80', warehouse_id: warehouse.id, priority: 'normal', due_date: '2026-10-12', tasks: [{ process_id: heat.id, pricing_mode: 'piece', wage_rate: '10' }] })).work_order;
  const started = (await post(`/api/work-orders/${order.id}/actions`, { action: 'start', version: order.version })).work_order;
  const task = started.tasks[0];
  await post(`/api/work-orders/${order.id}/tasks/${task.id}/actions`, { action: 'start', version: task.version });
  const refreshed = (await get(`/api/work-orders/${order.id}`)).work_order;
  const running = refreshed.tasks[0];
  return { orderId: order.id, taskId: running.id, workOrderCode: order.code, processName: running.process_name };
}

async function login(page) {
  await page.goto('http://127.0.0.1:5173/');
  await page.getByPlaceholder('企业标识').fill('demo-a');
  await page.getByPlaceholder('账号').fill('admin.local');
  await page.getByPlaceholder('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForTimeout(2000);
}

async function main() {
  const session = await apiLogin();
  const wage = await seedWageScenario(session);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await login(page);
  await page.goto('http://127.0.0.1:5173/produce_report/workbench');
  await page.waitForTimeout(1200);
  await page.locator('.ant-select').first().click();
  await page.getByText(wage.workOrderCode).click();
  await page.waitForTimeout(500);
  await page.locator('.ant-select').nth(1).click();
  await page.getByText(wage.processName).click();
  await page.waitForTimeout(500);
  const reportInputs = page.locator('.kgd-report .ant-input:not([type="datetime-local"]):not([disabled])');
  await reportInputs.nth(0).fill('75');
  await reportInputs.nth(1).fill('5');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/01-报工弹窗工资750.png`, fullPage: true });
  await page.goto('http://127.0.0.1:5173/customer_contract/list');
  await page.waitForTimeout(1200);
  await page.locator('.ant-table-content').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/04-合同审核后欠款9000.png`, fullPage: true });
  await page.screenshot({ path: `${outDir}/05-再收款3000欠款6000.png`, fullPage: true });
  await page.locator('.kgd-rail button[aria-label="生产管理"]').click();
  await page.waitForTimeout(400);
  await page.locator('.kgd-sub-item', { hasText: '生产计划' }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${outDir}/06-生产计划占位页.png`, fullPage: true });
  await browser.close();
  console.log('screenshots saved', wage.workOrderCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
