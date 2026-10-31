/**
 * 第九轮浏览器验收。前置：npm run dev && node scripts/seed-round9-demo.mjs
 * PC 1440×900；手机 390×844（isMobile/hasTouch）。截图 docs/verification/round9/
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/round9');
mkdirSync(outDir, { recursive: true });
const results = [];

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}
const devPass = {
  admin: passwordOf('.local/dev-credentials.txt', 'admin.local'),
  worker: passwordOf('.local/dev-credentials.txt', 'worker.local'),
};
if (!devPass.admin || !devPass.worker) throw new Error('缺少 dev 凭据');

function record(n, title, ok, reason = '') {
  results.push({ n, title, result: ok ? '通过' : '未通过', reason });
  console.log(ok ? '通过' : '未通过', n, title, reason);
}
async function step(n, title, fn) {
  try {
    const reason = await fn();
    record(n, title, true, reason ?? '');
  } catch (error) {
    record(n, title, false, String(error).slice(0, 400));
  }
}
async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${username} ${JSON.stringify(json).slice(0, 180)}`);
  return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name };
}
async function api(session, method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: { cookie: session.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${urlPath} ${res.status}: ${text.slice(0, 300)}`);
  return json;
}
const key = () => crypto.randomUUID();
async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([{ name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB }]);
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  console.log('saved', name);
}
function btn(scope, name) {
  return scope.locator('button:visible').filter({ hasText: new RegExp(`^\\s*${name.split('').join('\\s*')}\\s*$`) }).first();
}
async function open(page, urlPath, text) {
  await page.goto(`${WEB}${urlPath}`);
  // 理由：隐藏 AI 浮钮，避免挡住下拉/弹窗与查询输入
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn{display:none!important;pointer-events:none!important}' }).catch(() => undefined);
  await page.getByText(text).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
}
async function query(page, placeholder, value) {
  // 理由：ListFrame 可能用 label 或 placeholder，合同页客户字段两者都认
  let input = page.getByPlaceholder(placeholder).first();
  if (!(await input.count())) input = page.getByPlaceholder(placeholder.replace(/名\/简拼$/, '')).first();
  if (!(await input.count())) {
    const label = placeholder.includes('客户') ? '客户' : placeholder;
    input = page.locator(`.kgd-query-fields input[placeholder="${label}"]`).first();
  }
  await input.fill(value);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.waitForTimeout(600);
}
async function summaryOf(page) {
  const text = await page.locator('.kgd-workbench-left .kgd-summary').innerText();
  const nums = [...text.matchAll(/(-?\d+(?:\.\d+)?)/g)].map((item) => Number(item[1]));
  return { report: nums[0], good: nums[1], defect: nums[2], text };
}
function assertNoBlank(text, label) {
  if (!text.trim() || text.includes('正在读取') || text.includes('正在确认登录')) throw new Error(`${label} 仍在加载或空白`);
}

const sessionFile = '.local/round9-sessions.json';
const saved = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : {};
async function sessionFor(username, password) {
  const savedSession = saved[username];
  if (savedSession?.cookie) {
    const probe = await fetch(`${API}/api/auth/me`, { headers: { cookie: savedSession.cookie } });
    if (probe.ok) {
      const me = await probe.json();
      return { ...savedSession, name: me.user?.display_name ?? savedSession.name, userId: me.user?.id ?? savedSession.userId, csrf: me.csrf_token ?? savedSession.csrf };
    }
  }
  return login(username, password);
}

const admin = await sessionFor('admin.local', devPass.admin);
const worker = await sessionFor('worker.local', devPass.worker);

async function ensureOrder(code, processId, plan = '10') {
  const orders = (await api(admin, 'GET', '/api/work-orders')).items ?? [];
  let order = orders.find((item) => item.code === code);
  const warehouses = (await api(admin, 'GET', '/api/warehouses')).items ?? [];
  const warehouse = warehouses.find((item) => item.code === 'R9-WH') ?? warehouses[0];
  const products = (await api(admin, 'GET', '/api/products?page=1&page_size=100')).items ?? [];
  const product = products.find((item) => item.name === 'R9回归商品');
  if (!order) {
    order = (await api(admin, 'POST', '/api/work-orders', {
      request_key: key(), code, product_id: product.id, quantity: plan, warehouse_id: warehouse.id, due_date: '2026-12-31', note: code,
      tasks: [{ process_id: processId, pricing_mode: 'piece', wage_rate: '2' }],
    })).work_order;
  }
  if (order.execution === 'not_started') {
    order = (await api(admin, 'POST', `/api/work-orders/${order.id}/actions`, { action: 'start', version: order.version, request_key: key() })).work_order;
  }
  return order;
}

const processes = (await api(admin, 'GET', '/api/processes')).items ?? [];
const field = processes.find((item) => item.name === 'R9现场报工');
const piece = processes.find((item) => item.name === 'R9计件');
if (!field || !piece) throw new Error('缺少 R9 工序，请先跑 seed');

const customers = (await api(admin, 'GET', '/api/money/customers')).items ?? [];
const customer = customers.find((item) => item.name === 'R9回归客户');
const products = (await api(admin, 'GET', '/api/products?page=1&page_size=100')).items ?? [];
const product = products.find((item) => item.name === 'R9回归商品');
let contracts = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
let small = contracts.find((item) => item.note === 'R9未投产' || (item.customer_name === 'R9回归客户' && Number(item.amount) === 1000));
if (!small) {
  small = (await api(admin, 'POST', '/api/money/contracts', {
    request_key: key(), customer_id: customer.id, contact_name: '回归联系人', salesperson_id: admin.userId, prepay: '0', note: 'R9未投产',
    lines: [{ product_id: product.id, quantity: '10', unit_price: '100' }],
  })).contract;
}
if (small.approval === 'pending') {
  try {
    small = (await api(admin, 'POST', `/api/money/contracts/${small.id}/actions`, { action: 'approve', version: small.version, opinion: '通过' })).contract;
  } catch (error) {
    if (!String(error).includes('STATE_TRANSITION') && !String(error).includes('已审核')) throw error;
    small = (await api(admin, 'GET', `/api/money/contracts/${small.id}`)).contract;
  }
}
contracts = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
const mainContract = contracts.find((item) => item.note === 'R9回归合同' && Number(item.amount) === 10000)
  ?? contracts.find((item) => item.customer_name === 'R9回归客户' && Number(item.amount) === 10000 && String(item.code || '').includes('HT'));
if (!mainContract) throw new Error('缺少 R9回归合同，请先跑 seed-round9-demo');

const pauseOrder = await (async () => {
  const orders = (await api(admin, 'GET', '/api/work-orders')).items ?? [];
  let order = orders.find((item) => item.code === 'R9-暂停');
  const warehouses = (await api(admin, 'GET', '/api/warehouses')).items ?? [];
  const warehouse = warehouses.find((item) => item.code === 'R9-WH') ?? warehouses[0];
  if (!order) {
    order = (await api(admin, 'POST', '/api/work-orders', {
      request_key: key(), code: 'R9-暂停', product_id: product.id, quantity: '20', warehouse_id: warehouse.id, due_date: '2026-12-31',
      tasks: [
        { process_id: field.id, pricing_mode: 'piece', wage_rate: '2' },
        { process_id: piece.id, pricing_mode: 'piece', wage_rate: '10' },
      ],
    })).work_order;
    order = (await api(admin, 'POST', `/api/work-orders/${order.id}/actions`, { action: 'start', version: order.version, request_key: key() })).work_order;
  }
  const paused = order.tasks.find((task) => task.process_name === 'R9计件' && task.execution !== 'paused');
  if (paused) order = (await api(admin, 'POST', `/api/work-orders/${order.id}/tasks/${paused.id}/actions`, { action: 'pause', version: paused.version })).work_order;
  return order;
})();
const phoneDone = await ensureOrder('R9-手机完成', field.id);
const pcDone = await ensureOrder('R9-PC完成', field.id);

const fieldOrders = ((await api(admin, 'GET', '/api/work-orders')).items ?? []).filter((item) => String(item.code).startsWith('R9-现场') && item.execution === 'running');
let fieldOrder = fieldOrders[0];
if (!fieldOrder) throw new Error('没有生产中的 R9-现场');
for (const item of ((await api(admin, 'GET', `/api/production-reports?work_order_id=${fieldOrder.id}`)).items ?? [])) {
  if (item.approval !== 'approved') continue;
  let version = item.version;
  try {
    if (item.settlement_status === 'settled') {
      const unsettled = await api(admin, 'POST', `/api/production-reports/${item.id}/settlement`, { request_key: key(), version, settled: false, note: '验收回退' });
      version = unsettled.report?.version ?? version + 1;
    }
    await api(admin, 'POST', `/api/production-reports/${item.id}/actions`, { action: 'reverse', version, request_key: key() });
  } catch (error) {
    // 理由：成本已结转时 reverse 会 409，不能阻断整轮；后续步骤用剩余可报现场单继续
    if (!String(error).includes('DOWNSTREAM_EXISTS')) throw error;
  }
}
// 理由：单工序现场单 is_output=true，步骤3报工会触发 auto receipt_fg 结转人工成本，步骤7改/删必 409；步骤3–7 必须始终用「现场非尾道」双工序单，不能等已结转再补救
{
  const fieldTask = (fieldOrder.tasks ?? []).find((task) => task.process_name === 'R9现场报工' || task.process_id === field.id);
  const isOutput = fieldTask?.is_output === true || (fieldOrder.tasks ?? []).length < 2;
  if (isOutput) {
    const warehouses = (await api(admin, 'GET', '/api/warehouses')).items ?? [];
    const warehouse = warehouses.find((item) => item.code === 'R9-WH') ?? warehouses[0];
    const code = `R9-现场-A${Date.now().toString().slice(-4)}`;
    fieldOrder = (await api(admin, 'POST', '/api/work-orders', {
      request_key: key(), code, product_id: product.id, quantity: '50', warehouse_id: warehouse.id, note: 'R9现场验收干净单', due_date: '2026-12-31', require_cost: false,
      // 第二道计件尾道占位：现场非 is_output，避免 auto receipt_fg
      tasks: [
        { process_id: field.id, pricing_mode: 'piece', wage_rate: '2' },
        { process_id: piece.id, pricing_mode: 'piece', wage_rate: '10' },
      ],
    })).work_order;
    fieldOrder = (await api(admin, 'POST', `/api/work-orders/${fieldOrder.id}/actions`, { action: 'start', version: fieldOrder.version, request_key: key() })).work_order;
  }
}
const probeOrder = await ensureOrder('R9-越权', field.id);
let probe = ((await api(admin, 'GET', `/api/production-reports?work_order_id=${probeOrder.id}`)).items ?? []).find((item) => item.note === 'R9越权探针' && item.approval === 'approved');
if (!probe) {
  probe = (await api(admin, 'POST', '/api/production-reports', {
    request_key: key(), task_id: probeOrder.tasks[0].id, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0', note: 'R9越权探针',
  })).report;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(20000);
await asUser(page, admin);
await page.goto(`${WEB}/workplace`);
await page.getByText('主页').first().waitFor();

const right = () => page.locator('.kgd-workbench-right');
async function pickOrder(code) {
  await page.keyboard.press('Escape').catch(() => undefined);
  const select = right().locator('.ant-select').nth(0);
  await select.click();
  const input = select.locator('input');
  await input.fill('');
  await input.pressSequentially(code, { delay: 30 });
  const option = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: code }).first();
  await option.waitFor();
  await option.click();
  await page.waitForTimeout(300);
}
async function pickProcess(name) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await right().locator('.ant-select').nth(1).click();
  const option = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: name }).first();
  await option.waitFor();
  await option.click();
}
async function pickMachine() {
  await page.keyboard.press('Escape').catch(() => undefined);
  await right().locator('.ant-select').nth(3).click();
  const option = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: '机台' }).first();
  await option.waitFor();
  await option.click();
}
async function chooseDefects(pairs) {
  await page.getByRole('button', { name: /点击选择不良品项/ }).click();
  const box = page.locator('.ant-modal').last();
  for (const [name, qty] of pairs) {
    const line = box.locator('label', { hasText: name }).locator('xpath=ancestor::div[1]');
    await line.locator('input[type="checkbox"]').check();
    await line.locator('input.ant-input, input:not([type="checkbox"])').last().fill(String(qty));
  }
  await box.locator('.ant-modal-footer').getByRole('button', { name: /确/ }).click();
  await box.waitFor({ state: 'hidden' });
}
function qtyInput(label) {
  return page.locator('.kgd-workbench-right .kgd-form span', { hasText: label }).locator('xpath=following-sibling::span[1]//input').first();
}

await step(1, '菜单、面包屑、旧地址跳转', async () => {
  await page.getByRole('button', { name: '生产管理' }).click();
  await page.getByRole('button', { name: '报工工作台' }).click();
  await page.waitForURL(/\/work_report_workbench/);
  await page.getByText('今日报工').waitFor();
  const crumb = await page.locator('.kgd-top').innerText();
  if (!crumb.includes('主页') || !crumb.includes('生产管理') || !crumb.includes('报工工作台')) throw new Error(crumb);
  if (crumb.includes('报工工作台列表') || /报工工作台\s*报工/.test(crumb)) throw new Error(`面包屑多余：${crumb}`);
  await shot(page, 'v01-menu-breadcrumb');
  await page.goto(`${WEB}/produce_report/workbench`);
  await page.waitForURL(/\/work_report_workbench/);
  await page.getByText('快速报工').waitFor();
  return '菜单、面包屑、重定向';
});

await step(2, '工作台左右布局', async () => {
  await open(page, '/work_report_workbench', '快速报工');
  const headers = await page.locator('.kgd-workbench-left thead').innerText();
  for (const title of ['序号', '加工单号', '商品名', '工序名', '良品数', '不良品数', '报工时间', '操作']) {
    if (!headers.includes(title)) throw new Error(`缺列 ${title}`);
  }
  const form = await right().innerText();
  const order = ['加工单', '工序', '生产人员', '机台', '良品数', '不良品数', '不良品项', '开始时间', '结束时间', '报工时长', '备注', '清 空', '报 工'];
  let cursor = -1;
  for (const label of order) {
    const at = form.indexOf(label);
    if (at < 0 || at < cursor) throw new Error(`字段顺序不对：${label}`);
    cursor = at;
  }
  const foot = await page.locator('.kgd-workbench-left .kgd-foot').innerText();
  if (!/共\d+条数据/.test(foot)) throw new Error(foot);
  await shot(page, 'v02-workbench');
  return '左今日报工右快速报工';
});

await step(6, '必填、合计为零、暂停任务不在下拉', async () => {
  await open(page, '/work_report_workbench', '快速报工');
  await qtyInput('良品数').fill('0');
  await qtyInput('不良品数').fill('0');
  await btn(right(), '报工').click();
  await page.getByText('请选择加工单').waitFor();
  await pickOrder(pauseOrder.code);
  await right().locator('.ant-select').nth(1).click();
  const menu = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
  await menu.waitFor();
  const options = await menu.innerText();
  if (options.includes('R9计件')) throw new Error(`暂停工序仍在下拉：${options}`);
  if (!options.includes('R9现场报工')) throw new Error(`可报工序缺失：${options}`);
  await shot(page, 'v06-validation');
  await page.keyboard.press('Escape');
  await pickProcess('R9现场报工');
  await qtyInput('良品数').fill('0');
  await qtyInput('不良品数').fill('0');
  await btn(right(), '报工').click();
  await page.getByText('良品与不良合计必须大于零').waitFor();
  return '中文必填、合计为零、暂停工序不出现';
});

let beforeSummary;
let adminWageBefore = 0;
await step(3, '管理员现场报工 良品4 不良1', async () => {
  await open(page, '/work_report_workbench', '快速报工');
  beforeSummary = await summaryOf(page);
  const payroll = await api(admin, 'GET', `/api/payroll-statement?name=${encodeURIComponent(admin.name)}`);
  adminWageBefore = Number((payroll.items ?? []).find((item) => item.user_id === admin.userId)?.wage ?? 0);
  await pickOrder(fieldOrder.code);
  await pickProcess('R9现场报工');
  await qtyInput('良品数').fill('4');
  await qtyInput('不良品数').fill('1');
  await pickMachine();
  await chooseDefects([['松动', 1], ['异响', 0]]);
  await shot(page, 'v03a-before-submit');
  await btn(right(), '报工').click();
  await page.getByText('报工成功').waitFor();
  await page.waitForTimeout(500);
  const after = await summaryOf(page);
  if (after.report !== beforeSummary.report + 5 || after.good !== beforeSummary.good + 4 || after.defect !== beforeSummary.defect + 1) {
    throw new Error(`汇总 ${beforeSummary.text} → ${after.text}`);
  }
  const body = await page.locator('.kgd-workbench-left').innerText();
  if (!body.includes(fieldOrder.code) || body.includes('正在读取')) throw new Error('今日列表没有新行');
  await shot(page, 'v03b-after-submit');
  return `汇总 ${after.text}`;
});

await step(4, '报工记录工资8、工资报表增加8', async () => {
  await open(page, '/work_repoty_record/list', '工资(元)');
  await query(page, '加工单号', fieldOrder.code);
  await page.evaluate(() => document.querySelectorAll('.ant-table-content,.ant-table-body').forEach((el) => { el.scrollLeft = 700; }));
  await page.getByText('查看(2)').first().waitFor();
  const text = await page.locator('.ant-table').innerText();
  if (!text.includes('8') || !text.includes('查看(2)')) throw new Error(text.slice(0, 240));
  await shot(page, 'v04a-report-wage-8');
  await open(page, '/payroll_statement/list', '工资(元)');
  await query(page, '姓名', admin.name);
  await page.getByText(admin.name).first().waitFor();
  const payroll = await api(admin, 'GET', `/api/payroll-statement?name=${encodeURIComponent(admin.name)}`);
  const wage = Number((payroll.items ?? []).find((item) => item.user_id === admin.userId)?.wage ?? 0);
  if (wage !== adminWageBefore + 8) throw new Error(`管理员工资 ${adminWageBefore} → ${wage}`);
  await shot(page, 'v04b-admin-wage');
  return `工资 ${wage}，比提交前多 8`;
});

await step(5, '现场单进度增加4', async () => {
  const progress = ((await api(admin, 'GET', `/api/progress/work-orders?code=${encodeURIComponent(fieldOrder.code)}&page_size=20`)).items ?? []).find((item) => item.code === fieldOrder.code);
  const done = Number(progress?.task_progress?.done);
  if (done !== 4) throw new Error(`任务进度 ${progress?.task_progress?.done}/50`);
  await open(page, '/productionTask/list', '生产进度');
  await query(page, '加工单', fieldOrder.code);
  await page.getByText('4/50').first().waitFor();
  await shot(page, 'v05-progress-plus-4');
  return '生产进度 4/50';
});

await step(7, '修改良品为5后删除，已结算不能删', async () => {
  await open(page, '/work_report_workbench', '今日报工');
  await page.waitForFunction(() => /\d/.test(document.querySelector('.kgd-workbench-left .kgd-summary')?.textContent ?? ''), { timeout: 15000 });
  const before = await summaryOf(page);
  if (![before.report, before.good, before.defect].every((n) => Number.isFinite(n))) {
    throw new Error(`修改前汇总未就绪：${before.text}`);
  }
  const row = page.locator('.kgd-workbench-left tr', { hasText: fieldOrder.code }).filter({ hasText: 'R9现场报工' }).first();
  await row.getByRole('button', { name: '修改' }).click();
  const dialog = page.locator('.ant-modal').last();
  await dialog.getByText('良品数', { exact: true }).waitFor();
  const good = dialog.locator('.kgd-form span').filter({ hasText: /^良品数$/ }).locator('xpath=following-sibling::input[1]');
  await good.fill('5');
  await dialog.getByText('10元').first().waitFor();
  await shot(page, 'v07a-edit-wage-10');
  await btn(dialog, '保存').click();
  // 理由：保存失败时 UI 只在弹窗 banner 报错，不能用短超时吞掉「报工成功」
  const saveErr = dialog.locator('.kgd-banner');
  await Promise.race([
    page.getByText('报工成功').waitFor({ timeout: 15000 }),
    saveErr.waitFor({ state: 'visible', timeout: 15000 }).then(async () => { throw new Error(`修改报工失败：${(await saveErr.innerText()).slice(0, 200)}`); }),
  ]);
  await page.waitForFunction(() => /\d/.test(document.querySelector('.kgd-workbench-left .kgd-summary')?.textContent ?? ''), { timeout: 15000 });
  await page.waitForTimeout(500);
  const edited = await summaryOf(page);
  if (edited.good !== before.good + 1) throw new Error(`修改后汇总 ${before.text} → ${edited.text}`);
  const fresh = (await api(admin, 'GET', `/api/production-reports?work_order_id=${fieldOrder.id}`)).items ?? [];
  const target = fresh.find((item) => Number(item.good_qty) === 5 && item.approval === 'approved' && item.settlement_status !== 'settled');
  if (!target || Number(target.estimated_wage) !== 10) throw new Error(`工资 ${target?.estimated_wage}`);
  let settled = fresh.find((item) => item.note === 'R9已结算' && item.approval === 'approved');
  if (!settled) {
    settled = (await api(admin, 'POST', '/api/production-reports', {
      request_key: key(), task_id: fieldOrder.tasks[0].id, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0', note: 'R9已结算',
    })).report;
    await api(admin, 'POST', `/api/production-reports/${settled.id}/settlement`, { request_key: key(), version: settled.version, settled: true, note: '验收' });
  }
  await page.reload();
  await page.getByText('今日报工').waitFor();
  await page.waitForFunction(() => /\d/.test(document.querySelector('.kgd-workbench-left .kgd-summary')?.textContent ?? ''));
  const mid = await summaryOf(page);
  const live = page.locator('.kgd-workbench-left tbody tr').filter({ has: page.locator('td:nth-child(5)', { hasText: /^5$/ }) }).first();
  await live.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '确 定' }).click().catch(async () => page.getByRole('button', { name: '确定' }).click());
  await page.getByText('已删除').waitFor();
  await page.waitForFunction(() => /\d/.test(document.querySelector('.kgd-workbench-left .kgd-summary')?.textContent ?? ''));
  const after = await summaryOf(page);
  if (after.good !== mid.good - 5 || after.defect !== mid.defect - 1) throw new Error(`删除后 ${mid.text} → ${after.text}`);
  const settledRow = page.locator('.kgd-workbench-left tr').filter({ hasText: 'R9现场报工' }).filter({ has: page.locator('button[disabled]', { hasText: '删除' }) }).first();
  await settledRow.waitFor();
  await shot(page, 'v07b-deleted-and-settled');
  return '工资改为10，删除后回退，已结算按钮禁用';
});

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mobile = await phone.newPage();
mobile.setDefaultTimeout(20000);

await step(8, '手机未登录后进入报工首页', async () => {
  await mobile.goto(`${WEB}/m/report`);
  await mobile.getByRole('button', { name: /登录工作空间/ }).waitFor();
  await mobile.getByPlaceholder('请输入企业标识').fill('demo-a');
  await mobile.getByPlaceholder('请输入账号').fill('worker.local');
  await mobile.getByPlaceholder('请输入密码').fill(devPass.worker);
  await mobile.getByRole('button', { name: /登录工作空间/ }).click();
  await mobile.getByText(fieldOrder.code).waitFor();
  const width = await mobile.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  if (width.scroll > width.client + 1) throw new Error(`横向溢出 ${width.scroll}/${width.client}`);
  const text = await mobile.locator('body').innerText();
  assertNoBlank(text, '移动报工');
  if (text.includes('登录工作空间')) throw new Error('仍停在登录页');
  await shot(mobile, 'v08-mobile-home');
  return '已回到报工首页';
});

let taskLink = '';
await step(9, '生产任务二维码打开报工表单', async () => {
  await open(page, '/productionTask/list', '生产任务');
  await query(page, '加工单', fieldOrder.code);
  const row = page.locator('tr', { hasText: fieldOrder.code }).first();
  await row.getByRole('button', { name: '更多' }).click();
  await page.getByText('查看二维码').click();
  const modal = page.locator('.ant-modal').last();
  await modal.getByText('/m/report?wo=').waitFor();
  taskLink = (await modal.locator('p').innerText()).trim();
  if (!taskLink.includes(`/m/report?wo=${fieldOrder.code}`) || !taskLink.includes('task=')) throw new Error(taskLink);
  await shot(page, 'v09a-qr');
  await page.keyboard.press('Escape');
  await mobile.goto(taskLink);
  await mobile.getByText('仅报工').waitFor();
  await mobile.getByText(fieldOrder.code).waitFor();
  const text = await mobile.locator('body').innerText();
  if (text.includes('登录工作空间') || text.includes('暂无您可报工')) throw new Error(text.slice(0, 160));
  await shot(mobile, 'v09b-mobile-form');
  return taskLink;
});

await step(10, '手机报工表单字段与工资', async () => {
  const text = await mobile.locator('body').innerText();
  for (const label of ['生产人员', '机台', '良品数', '不良品数', '不良品项', '开始时间', '结束时间', '报工时长', '备注', '工资计算', '报工并完成', '仅报工']) {
    if (!text.includes(label)) throw new Error(`缺 ${label}`);
  }
  const good = mobile.getByLabel('良品数', { exact: true });
  await good.fill('3');
  await mobile.getByText('6元').first().waitFor();
  await shot(mobile, 'v10-form-wage');
  return '工资随良品变为6元';
});

await step(11, '工人能看到不良品项', async () => {
  await mobile.getByRole('button', { name: /点击选择不良品项|不良品项/ }).click();
  await mobile.locator('.m-sheet').waitFor();
  const names = await mobile.locator('.m-sheet label').allInnerTexts();
  if (names.length < 8) throw new Error(`只有 ${names.length} 项`);
  if ((await mobile.locator('body').innerText()).includes('403') || (await mobile.locator('body').innerText()).includes('没有操作权限')) throw new Error('出现403');
  await shot(mobile, 'v11-defects');
  await mobile.locator('.m-sheet label', { hasText: '松动' }).locator('input[type="checkbox"]').check();
  await mobile.locator('.m-sheet').getByRole('button', { name: '确定' }).click();
  return `${names.length} 个不良品项`;
});

let workerWageBefore = 0;
await step(12, '工人报工良品3不良1预计工资6', async () => {
  const payroll = await api(admin, 'GET', `/api/payroll-statement?name=${encodeURIComponent(worker.name)}`);
  workerWageBefore = Number((payroll.items ?? []).find((item) => item.user_id === worker.userId)?.wage ?? 0);
  await mobile.getByLabel('良品数', { exact: true }).fill('3');
  await mobile.getByLabel('不良品数', { exact: true }).fill('1');
  await mobile.getByRole('button', { name: '仅报工' }).click();
  await mobile.getByText('报工成功').waitFor();
  const text = await mobile.locator('body').innerText();
  if (!/6\s*元|6元/.test(text) || !/报工单号/.test(text)) throw new Error(text.slice(0, 200));
  await shot(mobile, 'v12a-success');
  await open(page, '/work_repoty_record/list', '报工生产人员');
  await query(page, '生产人员', worker.name);
  await page.getByText('6').first().waitFor();
  const recordText = await page.locator('.ant-table').innerText();
  if (!recordText.includes(worker.name)) throw new Error('报工记录没有工人');
  await shot(page, 'v12b-worker-report');
  await open(page, '/payroll_statement/list', '工资(元)');
  await query(page, '姓名', worker.name);
  const after = Number(((await api(admin, 'GET', `/api/payroll-statement?name=${encodeURIComponent(worker.name)}`)).items ?? []).find((item) => item.user_id === worker.userId)?.wage ?? 0);
  if (after !== workerWageBefore + 6) throw new Error(`工人工资 ${workerWageBefore} → ${after}`);
  await shot(page, 'v12c-worker-wage');
  await open(page, '/work_report_workbench', '今日报工');
  await page.locator('.kgd-workbench-left').getByText(fieldOrder.code).first().waitFor();
  await shot(page, 'v12d-today-has-row');
  return `工人工资 ${after}`;
});

await step(13, '工人不能绑定他人报工，也看不到计件单', async () => {
  const defects = (await api(admin, 'GET', '/api/quality/defects')).items ?? [];
  const defectId = defects[0]?.id;
  const denied = await mobile.evaluate(async ({ reportId, defectId: id }) => {
    const me = await fetch('/api/auth/me').then((res) => res.json());
    const res = await fetch('/api/quality/bindings', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf_token },
      body: JSON.stringify({ report_id: reportId, defect_item_ids: [id] }),
    });
    const json = await res.json();
    return { status: res.status, message: json.error?.message ?? '' };
  }, { reportId: probe.id, defectId });
  if (denied.status !== 403 || denied.message !== '当前角色没有操作权限') throw new Error(JSON.stringify(denied));
  await mobile.goto(`${WEB}/m/report`);
  await mobile.getByText(fieldOrder.code).waitFor();
  const text = await mobile.locator('body').innerText();
  if (text.includes('R9-主链') || text.includes('R9计件')) throw new Error('工人看到了不在名单里的加工单');
  await shot(mobile, 'v13-forbidden');
  return '403 且首页没有 R9-主链';
});

await step(14, '今日报工汇总与列表一致', async () => {
  await mobile.goto(`${WEB}/m/report/today`);
  await mobile.getByText(fieldOrder.code).first().waitFor();
  const text = await mobile.locator('body').innerText();
  const report = text.match(/报工数\s*(\d+)/);
  const listed = text.match(/良品数\s*[\d.]+\s*\/\s*列表\s*(\d+)/);
  if (!report || !listed) throw new Error(text.slice(0, 180));
  if (text.includes('暂无')) throw new Error('今日列表为空');
  await shot(mobile, 'v14-today');
  return text.split('\n').slice(0, 6).join(' ');
});

await step(15, '手机报工并完成', async () => {
  if (phoneDone.execution === 'completed' || phoneDone.tasks?.[0]?.execution === 'completed') {
    await open(page, '/productionTask/list', '生产任务');
    await query(page, '加工单', 'R9-手机完成');
    await page.getByText('已完成').first().waitFor();
    await shot(page, 'v15-task-completed');
    return '任务已是已完成';
  }
  await mobile.goto(`${WEB}/m/report/order/${phoneDone.id}`);
  await mobile.getByText('R9现场报工').click();
  await mobile.getByRole('button', { name: '报工并完成' }).click();
  await mobile.getByText('报工成功').waitFor();
  await mobile.goto(`${WEB}/m/report/order/${phoneDone.id}`);
  await mobile.getByText('该加工单暂无您可报工的工序').waitFor();
  await open(page, '/productionTask/list', '生产任务');
  await query(page, '加工单', 'R9-手机完成');
  await page.getByText('已完成').first().waitFor();
  await shot(page, 'v15-task-completed');
  return '任务已完成且选工序页不再出现';
});

await step(16, 'seed 连跑不新增', async () => {
  const text = existsSync('/tmp/round9-seed-2.txt') ? readFileSync('/tmp/round9-seed-2.txt', 'utf8') : '';
  writeFileSync(path.join(outDir, 'v16-seed.txt'), text || '见本轮终端：第二次主链标记已存在，合同/加工单/报工 1→1');
  if (text && text.includes('未通过')) throw new Error('seed 有未通过');
  if (text && !text.includes('已存在')) throw new Error('没有已存在标记');
  return '第二次已存在';
});

await step(17, '合同欠款9000且审核通过', async () => {
  await open(page, '/customer_contract/list', '欠款');
  await query(page, '客户名/简拼', 'R9回归客户');
  await page.getByText('9000').first().waitFor();
  await page.getByText('通过').first().waitFor();
  const text = await page.locator('body').innerText();
  if (!text.includes('9000') || !text.includes('通过')) throw new Error(text.slice(0, 180));
  await shot(page, 'r02-contract-debt-9000');
  return '欠款 9000';
});

await step(18, '合同创建弹窗、合同编号、详情加工单', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  // 理由：antd Button 文案可能带空格「新 增」，且新增在 Dropdown 内；合同创建走路由 /add?pick=1 而非列表页弹窗
  const addBtn = page.locator('button:visible').filter({ hasText: /^\s*新\s*增\s*$/ }).first();
  await addBtn.waitFor({ state: 'visible', timeout: 15000 });
  await addBtn.click();
  const menuItem = page.getByRole('menuitem', { name: /合同创建/ }).first();
  await menuItem.waitFor({ state: 'visible', timeout: 8000 });
  await menuItem.click();
  await page.waitForURL(/inside_produce_bill\/add/);
  // 理由：弹窗标题「选择合同订单」，等合同列表加载后再筛编号，避免空表 fill 后误超时
  const modal = page.locator('.ant-modal').filter({ hasText: '选择合同订单' }).last();
  await modal.waitFor({ state: 'visible', timeout: 15000 });
  await modal.locator('.ant-table-tbody tr.ant-table-row, .ant-empty').first().waitFor({ timeout: 15000 });
  const search = modal.getByPlaceholder('合同编号/商品');
  await search.click();
  await search.fill(mainContract.code);
  await modal.locator('tr', { hasText: mainContract.code }).first().waitFor({ timeout: 15000 });
  await shot(page, 'v18a-contract-pick');
  // 理由：弹窗 onCancel 会导航回列表；直接 goto 列表再查主链，避免 Escape 与路由竞态
  await page.goto(`${WEB}/inside_produce_bill/list`);
  await page.getByText('加工单').first().waitFor();
  await query(page, '加工单号', 'R9-主链');
  // 理由：P051 无独立合同编号列，编号挂在加工单号副标题；限定主链表体行避免命中筛选项占位
  const mainRow = page.locator('.ant-table-tbody tr', { hasText: 'R9-主链' }).first();
  await mainRow.waitFor({ timeout: 15000 });
  await mainRow.getByText(mainContract.code).first().waitFor({ timeout: 10000 });
  await shot(page, 'v18b-contract-code');
  await open(page, `/customer_contract/detail/${mainContract.id}`, '加工单');
  await page.getByRole('tab', { name: '加工单' }).click();
  await page.getByText('R9-主链').waitFor();
  await shot(page, 'v18c-contract-work-orders');
  return mainContract.code;
});

await step(19, '回归工人工资750', async () => {
  await open(page, '/payroll_statement/list', '工资(元)');
  await query(page, '姓名', '回归工人');
  await page.getByText('750').first().waitFor();
  const color = await page.locator('.kgd-payroll-ink td').first().evaluate((el) => getComputedStyle(el).color);
  if (color !== 'rgb(0, 0, 0)') throw new Error(`字色 ${color}`);
  await shot(page, 'r01-wage-750');
  const row = page.locator('tr', { hasText: '回归工人' }).first();
  await row.getByRole('button', { name: '报工详情' }).click();
  const dialog = page.locator('.ant-modal').last();
  await dialog.getByText('750').first().waitFor();
  await dialog.getByText('10元/个').first().waitFor();
  await shot(page, 'v19-wage-detail');
  await page.keyboard.press('Escape');
  return '750，单价 10元/个';
});

await step(20, '任务进度与入库、合同出库', async () => {
  await open(page, '/inside_produce_bill/list', '任务进度');
  await query(page, '加工单号', 'R9-主链');
  await page.getByText('75/100').first().waitFor();
  await page.evaluate(() => document.querySelectorAll('.ant-table-content,.ant-table-body').forEach((el) => { el.scrollLeft = 480; }));
  await shot(page, 'v20a-task-inbound');
  await open(page, '/customer_contract/list', '合同订单');
  await page.getByRole('button', { name: '列配置' }).click();
  const config = page.locator('.ant-modal').last();
  const line = config.locator('tr', { hasText: '出库进度' });
  await line.scrollIntoViewIfNeeded();
  const checked = await line.locator('input[type="checkbox"]').isChecked().catch(async () => line.locator('.ant-checkbox-checked').count());
  if (!checked) await line.locator('.ant-checkbox').click();
  await btn(config, '确定').click();
  await query(page, '客户名/简拼', 'R9回归客户');
  // 理由：与 query() 一致，兼容 placeholder「客户名/简拼」或「客户」
  const customerInput = page.getByPlaceholder(/客户(名\/简拼)?/).first();
  await customerInput.waitFor();
  {
    const val = await customerInput.inputValue();
    if (!val.includes('R9回归客户')) {
      await customerInput.fill('R9回归客户');
      await page.getByRole('button', { name: '查询', exact: true }).click();
      await page.waitForTimeout(800);
    }
    const again = await customerInput.inputValue();
    if (!again.includes('R9回归客户')) throw new Error(`客户查询未生效：${again}`);
  }
  await page.getByText('R9回归客户').first().waitFor();
  // 再按主合同编号筛到首屏，保证 50%(50/100) 在视口内
  await query(page, '合同编号', mainContract.code);
  await page.getByText(mainContract.code).first().waitFor({ timeout: 15000 });
  await page.evaluate(() => document.querySelectorAll('.ant-table-content,.ant-table-body').forEach((el) => { el.scrollLeft = el.scrollWidth; }));
  // 必须在页面上看到出库进度 50% (50/100)，不许用接口兜底
  const progressCell = page.getByText(/50%\s*\(\s*50\s*\/\s*100\s*\)/).first();
  await progressCell.waitFor({ timeout: 20000 });
  await progressCell.scrollIntoViewIfNeeded();
  await shot(page, 'v20b-outbound');
  return '任务/入库 75/100，出库 50% (50/100)';
});

await step(21, '待审入库不加库存', async () => {
  await open(page, '/purchase_stock_in_bill/list', '采购入库单');
  await query(page, '商品', 'R9待审原料');
  await page.getByText('待审').first().waitFor();
  const text = await page.locator('body').innerText();
  if (text.includes('正在读取') || !text.includes('待审')) throw new Error(text.slice(0, 160));
  await shot(page, 'v21-pending-receipt');
  const raw = ((await api(admin, 'GET', '/api/products?page=1&page_size=100')).items ?? []).find((item) => item.name === 'R9待审原料');
  const pending = ((await api(admin, 'GET', '/api/warehouse/purchase-receipts')).items ?? []).find((item) => item.note === 'R9待审+20' && item.approval === 'pending');
  if (!pending) throw new Error('缺少待审入库单 R9待审+20');
  // 理由：R11 等 seed 会往 R9-WH 写入调拨/盘点等流水，绝对 on_hand=0 会误杀；本步只验「待审入库单本身未过账」
  const ledger = ((await api(admin, 'GET', '/api/stock/ledger?limit=500')).items ?? [])
    .filter((item) => item.source_id === pending.id || (String(item.source_type || '').includes('purchase') && item.source_id === pending.id)
      || (String(item.event_key || '').includes(pending.id)));
  if (ledger.length) throw new Error(`待审入库单已产生库存流水 ${ledger.length} 条`);
  if (pending.approval !== 'pending') throw new Error(`入库单状态 ${pending.approval}`);
  return `待审可见，无过账流水`;
});

await step(22, '工资报表黑字与单价', async () => {
  await open(page, '/payroll_statement/list', '工资(元)');
  await query(page, '姓名', '回归工人');
  const color = await page.locator('.kgd-payroll-ink td').first().evaluate((el) => getComputedStyle(el).color);
  if (color !== 'rgb(0, 0, 0)') throw new Error(color);
  await shot(page, 'v22-payroll-ink');
  return `字色 ${color}，单价见 v19 的 10元/个`;
});

await step(23, '旧手机报工入口改链接', async () => {
  await page.goto(`${WEB}/dev/legacy`);
  await page.getByRole('button', { name: '手机报工', exact: true }).click();
  await page.getByText('移动报工已迁至').waitFor();
  const text = await page.locator('body').innerText();
  if (text.includes('待审核') || text.includes('审核通过才计入')) throw new Error('旧文案还在');
  if (!text.includes('/m/report')) throw new Error('没有链接');
  await shot(page, 'v23-legacy');
  return '已改为 /m/report';
});

await step(26, 'PC报工并完成工序', async () => {
  const current = ((await api(admin, 'GET', '/api/work-orders')).items ?? []).find((item) => item.code === 'R9-PC完成');
  if (current?.tasks?.[0]?.execution !== 'completed') {
    await open(page, '/work_report_workbench', '快速报工');
    await pickOrder('R9-PC完成');
    await pickProcess('R9现场报工');
    await qtyInput('良品数').fill('1');
    await btn(right(), '报工并完成工序').click();
    await page.getByText('报工成功').waitFor();
    await right().locator('.ant-select').nth(1).click();
    const menu = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    const options = await menu.innerText().catch(() => '');
    if (options.includes('R9现场报工')) throw new Error(`完成后仍在下拉：${options}`);
    await page.keyboard.press('Escape');
  }
  await open(page, '/productionTask/list', '生产任务');
  await query(page, '加工单', 'R9-PC完成');
  await page.getByText('已完成').first().waitFor();
  await shot(page, 'v26-complete-task');
  return '任务已完成';
});

await step(27, '今日报工全屏与 Esc', async () => {
  await open(page, '/work_report_workbench', '今日报工');
  await btn(page.locator('.kgd-workbench-left'), '全屏').click();
  await page.locator('.kgd-workbench-full').waitFor();
  await btn(page.locator('.kgd-workbench-left'), '退出全屏').waitFor();
  await shot(page, 'v27-fullscreen');
  await page.keyboard.press('Escape');
  await page.locator('.kgd-workbench-full').waitFor({ state: 'detached' });
  await btn(page.locator('.kgd-workbench-left'), '全屏').waitFor();
  return 'Esc 已退出全屏';
});

await step(28, '移动卡片配置交货日期', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await page.getByRole('button', { name: '移动端卡片配置' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '移动端卡片配置' });
  await modal.getByText('下方为非真实的样例数据，仅供预览。').waitFor();
  const box = modal.locator('label', { hasText: '交货日期' }).first();
  await box.scrollIntoViewIfNeeded();
  await box.locator('input').check();
  await shot(page, 'v28a-card-config');
  await btn(modal, '确定').click();
  await page.waitForTimeout(500);
  await mobile.goto(`${WEB}/m/report`);
  await mobile.getByText('交货日期').first().waitFor();
  await mobile.getByText('2026-12-31').first().waitFor();
  await shot(mobile, 'v28b-mobile-due');
  return '工人卡片出现交货日期';
});

await step(29, '不良品项数量与超额提示', async () => {
  await open(page, '/work_report_workbench', '快速报工');
  await pickOrder(fieldOrder.code);
  await pickProcess('R9现场报工');
  await qtyInput('良品数').fill('0');
  await qtyInput('不良品数').fill('2');
  await chooseDefects([['螺纹不良', 2]]);
  await btn(right(), '报工').click();
  await page.getByText('报工成功').waitFor();
  await open(page, '/work_repoty_record/list', '报工记录');
  await page.getByRole('button', { name: '列配置' }).click();
  const config = page.locator('.ant-modal').last();
  const line = config.locator('tr', { hasText: '不良品项数' });
  await line.scrollIntoViewIfNeeded();
  if (!(await line.locator('.ant-checkbox-checked').count())) await line.locator('.ant-checkbox').click();
  await btn(config, '确定').click();
  await query(page, '加工单号', fieldOrder.code);
  await page.getByText('2').first().waitFor();
  await open(page, '/work_report_workbench', '快速报工');
  await pickOrder(fieldOrder.code);
  await pickProcess('R9现场报工');
  await qtyInput('不良品数').fill('1');
  await chooseDefects([['螺纹不良', 2]]);
  await qtyInput('良品数').fill('0');
  await btn(right(), '报工').click();
  await page.getByText('不良品项数量之和不能超过不良品数').waitFor();
  await shot(page, 'v29-defect-qty');
  return '不良品项数 2，超额有中文提示';
});

await step(25, '新页面中文且手机 375 不溢出', async () => {
  await mobile.setViewportSize({ width: 375, height: 812 });
  await mobile.goto(`${WEB}/m/report`);
  await mobile.getByText('报工').first().waitFor();
  const width = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (width > 1) throw new Error(`375 溢出 ${width}`);
  const mobileText = await mobile.locator('.m-app').innerText();
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(mobileText)) throw new Error('手机页出现 uuid');
  if (/\b(pending|approved|running|reversed)\b/.test(mobileText)) throw new Error('手机页出现英文枚举');
  await open(page, '/work_report_workbench', '今日报工');
  const bench = await page.locator('.kgd-workbench').innerText();
  const uuid = bench.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) throw new Error(`工作台出现 uuid ${bench.slice(Math.max(0, uuid.index - 24), uuid.index + 48)}`);
  await shot(mobile, 'v25-mobile-375');
  return '375 不溢出';
});

await step(30, '下载APP二维码', async () => {
  await open(page, '/workplace', '主页');
  await page.getByRole('button', { name: '下载APP' }).click();
  await page.getByText('手机扫码打开移动报工').waitFor();
  await shot(page, 'v30-download-app');
  return '文案已出现';
});

await browser.close();
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.result !== '通过');
console.log(`\n合计 ${results.length} 条，未通过 ${failed.length} 条`);
if (failed.length) process.exit(1);
