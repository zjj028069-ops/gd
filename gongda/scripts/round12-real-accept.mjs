/**
 * 第十二轮浏览器验收。前置：npm run dev && node scripts/seed-round12-real.mjs
 * 截图 artifacts/round12-real/。表单保存走页面点选。数字用 ===。
 *
 * R12B 浏览器链（与 seed 主链数字分开）：
 * 数量 10、单价 100、金额 1000、预付 0、欠款 1000、良品 2、工资 20.00。
 * seed 主链仍断言：欠款 8500、出库 50% (50/100)、投产 100% (100/100)、工资 750.00。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'artifacts/round12-real');
mkdirSync(outDir, { recursive: true });

const R12B_QTY = '10';
const R12B_PRICE = '100';
const R12B_AMOUNT = '1000';
const R12B_DEBT = '1000';
const R12B_GOOD = '2';
const R12B_WAGE = '20.00';
const R12B_WAGE_LABEL = '20';
const R12B_PLAN = '10';
const R12B_SHIP = '1';
const R12B_OUTBOUND = '10% (1/10)';
const SEED_DEBT = '8500';
const SEED_RECEIVED = '1500';
const SEED_PROGRESS = '15% (1500/10000)';
const SEED_OUTBOUND = '50% (50/100)';
const SEED_PRODUCE = '100% (100/100)';
const SEED_WAGE = '750.00';
const SEED_WAGE_LABEL = '750';
const SEED_PO_PAID = '30';
const SEED_PO_DEBT = '50';
const NOTE = 'R12B浏览器合同';
const WO_NOTE = 'R12B浏览器加工单';

const checks = [];
function eq(actual, expected, name) {
  const ok = actual === expected;
  checks.push({ name, result: ok ? '通过' : '未通过', actual: String(actual), expected: String(expected) });
  console.log(`${ok ? '通过' : '未通过'}\t${name}\t${actual}`);
  if (!ok) throw new Error(`${name}：期望 ${expected}，实际 ${actual}`);
}
function eqNumber(actual, expected, name) {
  const text = String(actual ?? '').trim();
  const ok = /^-?\d+(\.\d+)?$/.test(text) && Number(text) === Number(expected);
  eq(ok ? String(expected) : text, String(expected), name);
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
  if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${username} ${JSON.stringify(json).slice(0, 240)}`);
  return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name };
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
  if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${urlPath} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

const devPass = {
  admin: passwordOf('.local/dev-credentials.txt', 'admin.local'),
  planner: passwordOf('.local/dev-credentials.txt', 'planner.local'),
  worker: passwordOf('.local/dev-credentials.txt', 'worker.local'),
};
const r12Pass = passwordOf('.local/round12-credentials.txt', 'r12.worker');
const r12bPass = passwordOf('.local/round12-credentials.txt', 'r12b.worker');
if (!devPass.admin || !devPass.planner || !devPass.worker || !r12Pass || !r12bPass) throw new Error('缺少 dev 或 round12 凭据');

const admin = await login('admin.local', devPass.admin);
const planner = await login('planner.local', devPass.planner);
const worker = await login('worker.local', devPass.worker);
const r12 = await login('r12.worker', r12Pass);
const r12b = await login('r12b.worker', r12bPass);

const priorReports = (await api(admin, 'GET', `/api/production-reports?operator_id=${r12b.userId}`)).items ?? [];
for (const item of priorReports) {
  if (item.approval !== 'approved' || item.estimated_wage !== R12B_WAGE || item.operator_id !== r12b.userId) continue;
  let version = item.version;
  if (item.settlement_status === 'settled') {
    const unsettled = await api(admin, 'POST', `/api/production-reports/${item.id}/settlement`, {
      request_key: crypto.randomUUID(), version, settled: false, note: 'R12B验收重跑改回未结算',
    });
    version = unsettled.report.version;
  }
  await api(admin, 'POST', `/api/production-reports/${item.id}/actions`, {
    action: 'reverse', version, reason: 'R12B验收重跑冲销上一笔浏览器报工', request_key: crypto.randomUUID(),
  });
}

const browser = await chromium.launch({ headless: true });
const shots = [];

async function openPage(session) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const raw = session.cookie.split(';')[0];
  const eqAt = raw.indexOf('=');
  await context.addCookies([{ name: raw.slice(0, eqAt), value: raw.slice(eqAt + 1), url: WEB }]);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  return { context, page };
}
async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(name);
  console.log('截图', name);
}
function btn(scope, name) {
  const body = [...name].map((ch) => (/[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch)).join('\\s*');
  return scope.locator('button:visible').filter({ hasText: new RegExp(`^\\s*${body}`) }).first();
}
async function goto(page, urlPath) {
  await page.goto(`${WEB}${urlPath}`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn{display:none!important;pointer-events:none!important}' });
  await page.getByText('快工单', { exact: true }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
}
async function search(page, placeholder, value) {
  const input = page.getByPlaceholder(placeholder, { exact: true }).first();
  await input.click();
  await input.fill(value);
  await btn(page, '查询').click();
  await page.waitForTimeout(700);
}
async function pickOption(page, scope, label, optionText) {
  const labelNode = scope.locator('.ant-form-item-label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
  const item = labelNode.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-form-item ")][1]');
  await item.locator('.ant-select').click();
  const option = page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: optionText }).first();
  await option.waitFor({ timeout: 10000 });
  await option.click();
}
async function siblingInput(scope, label) {
  const span = scope.locator('span').filter({ hasText: new RegExp(`^\\s*${label}\\s*\\*?\\s*$`) }).first();
  const box = span.locator('xpath=following-sibling::*[1]');
  const tag = await box.evaluate((el) => el.tagName);
  if (tag === 'INPUT' || tag === 'TEXTAREA') return box;
  return box.locator('input,textarea').first();
}
async function pickSiblingSelect(page, scope, label, optionText) {
  const span = scope.locator('span').filter({ hasText: new RegExp(`^\\s*${label}\\s*\\*?\\s*$`) }).first();
  const box = span.locator('xpath=following-sibling::*[1]');
  const klass = (await box.getAttribute('class')) ?? '';
  const select = klass.split(/\s+/).includes('ant-select') ? box : box.locator('.ant-select').first();
  await select.click();
  const option = page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: optionText }).first();
  await option.waitFor({ timeout: 10000 });
  await option.click();
}
function modalByTitle(page, title) {
  return page.getByRole('dialog', { name: title });
}

const adminUi = await openPage(admin);
const page = adminUi.page;

const seedContracts = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
const seedContract = seedContracts.find((item) => item.note === 'R12回归合同');
if (!seedContract) throw new Error('找不到 R12回归合同，请先跑 seed');
const seedOrders = (await api(admin, 'GET', '/api/work-orders')).items ?? [];
const seedOrder = seedOrders.find((item) => item.code === 'R12-主链');
if (!seedOrder) throw new Error('找不到 R12-主链');
const purchases = (await api(admin, 'GET', '/api/money/purchase-orders')).items ?? [];
const payOrder = purchases.find((item) => item.note === 'R12采购付款');
if (!payOrder) throw new Error('找不到 R12采购付款');

await goto(page, '/customer_contract/list');
await search(page, '备注', 'R12回归合同');
await page.getByText(SEED_DEBT, { exact: true }).first().waitFor();
await shot(page, '01-合同列表欠款');
const debtCell = (await page.locator('tr', { hasText: 'R12回归合同' }).first().getByText(SEED_DEBT, { exact: true }).innerText()).trim();
eq(debtCell, SEED_DEBT, 'B9 合同列表欠款8500');
const receivedCell = (await page.locator('tr', { hasText: 'R12回归合同' }).first().getByText(SEED_RECEIVED, { exact: true }).innerText()).trim();
eq(receivedCell, SEED_RECEIVED, 'B9 合同列表累计收款1500');
const outboundCell = (await page.locator('tr', { hasText: 'R12回归合同' }).first().getByText(SEED_OUTBOUND, { exact: true }).innerText()).trim();
eq(outboundCell, SEED_OUTBOUND, 'B9 合同列表出库进度50/100');
const produceCell = (await page.locator('tr', { hasText: 'R12回归合同' }).first().getByText(SEED_PRODUCE, { exact: true }).innerText()).trim();
eq(produceCell, SEED_PRODUCE, 'B9 合同列表投产进度100/100');

await goto(page, `/customer_contract/detail/${seedContract.id}`);
await page.getByText(SEED_DEBT, { exact: true }).first().waitFor();
await shot(page, '02-合同详情进度');
const detailDebt = (await page.locator('dd').filter({ hasText: new RegExp(`^${SEED_DEBT}$`) }).first().innerText()).trim();
eq(detailDebt, SEED_DEBT, '合同详情欠款8500');
const detailProduce = (await page.getByText(SEED_PRODUCE, { exact: true }).first().innerText()).trim();
eq(detailProduce, SEED_PRODUCE, '合同详情投产进度100/100');
const detailOut = (await page.getByText(SEED_OUTBOUND, { exact: true }).first().innerText()).trim();
eq(detailOut, SEED_OUTBOUND, '合同详情出库进度50/100');
const detailRecv = (await page.getByText(SEED_PROGRESS, { exact: true }).first().innerText()).trim();
eq(detailRecv, SEED_PROGRESS, '合同详情收款进度15%');

await goto(page, `/inside_produce_bill/detail/${seedOrder.id}?tab=wages`);
await page.getByRole('tab', { name: '工资单' }).click();
await page.getByText(SEED_WAGE, { exact: true }).first().waitFor();
await shot(page, '03-加工单工资单750');
const wageCell = (await page.getByText(SEED_WAGE, { exact: true }).first().innerText()).trim();
eq(wageCell, SEED_WAGE, '加工单工资单750.00');

await goto(page, '/payroll_statement/list');
await search(page, '姓名', 'R12回归工人');
await page.locator('tr', { hasText: 'R12回归工人' }).first().waitFor();
await shot(page, '04-生产工资报表750');
const payrollWage = (await page.locator('tr', { hasText: 'R12回归工人' }).first().getByText(SEED_WAGE_LABEL, { exact: true }).first().innerText()).trim();
eq(payrollWage, SEED_WAGE_LABEL, 'B7 生产工资报表750');

await goto(page, `/purchase_order/detail/${payOrder.id}`);
await shot(page, '05-采购已付应付');
const paidText = (await page.locator('dd').filter({ hasText: new RegExp(`^${SEED_PO_PAID}$`) }).first().innerText()).trim();
eq(paidText, SEED_PO_PAID, '采购详情已付30');
const poDebt = (await page.locator('dd').filter({ hasText: new RegExp(`^${SEED_PO_DEBT}$`) }).first().innerText()).trim();
eq(poDebt, SEED_PO_DEBT, '采购详情应付50');

await goto(page, '/customer_contract/list');
await btn(page, '新增').click();
await page.getByRole('menuitem', { name: '直接创建' }).click();
const contractModal = modalByTitle(page, '新增合同');
await contractModal.waitFor();
await shot(page, '06-合同新增打开态');
await pickOption(page, contractModal, '客户', 'R12回归客户');
await pickOption(page, contractModal, '业务员', admin.name);
await contractModal.getByPlaceholder('请填写，忽略将自动生成').fill('');
const noteBox = contractModal.locator('textarea').first();
await noteBox.fill(NOTE);
await contractModal.getByRole('button', { name: '+ 选择合同商品' }).click();
const picker = modalByTitle(page, '选择商品');
await picker.getByPlaceholder('商品', { exact: true }).fill('R12回归商品');
await picker.locator('tr', { hasText: 'R12回归商品' }).first().locator('input[type=checkbox]').check();
await picker.getByRole('button', { name: '确 定' }).click();
await picker.waitFor({ state: 'hidden' });
const line = contractModal.locator('tr', { hasText: 'R12回归商品' }).first();
const lineInputs = line.locator('input');
await lineInputs.nth(0).fill(R12B_PRICE);
await lineInputs.nth(1).fill(R12B_QTY);
await shot(page, '07-合同新增已填写');
await contractModal.getByRole('button', { name: '提交审核' }).click();
await page.getByText('已提交审核', { exact: true }).waitFor();
await shot(page, '08-合同提交后列表');
await search(page, '备注', NOTE);
await page.locator('tr', { hasText: NOTE }).first().waitFor();
const pendingText = (await page.locator('tr', { hasText: NOTE }).first().getByText('待审', { exact: true }).innerText()).trim();
eq(pendingText, '待审', 'B1 新合同待审');
const browserContracts = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
const browserContract = browserContracts.find((item) => item.note === NOTE);
if (!browserContract) throw new Error('页面保存后接口找不到 R12B 合同');
eq(String(browserContract.amount), R12B_AMOUNT, 'B1 合同金额1000');
eq(String(browserContract.approval), 'pending', 'B1 合同审核状态pending');
const contractCode = String(browserContract.code);

const plannerUi = await openPage(planner);
const plannerPage = plannerUi.page;
await goto(plannerPage, '/customer_contract/list');
await search(plannerPage, '备注', NOTE);
const planRow = plannerPage.locator('tr', { hasText: contractCode }).first();
await planRow.waitFor();
await planRow.locator('input[type=checkbox]').first().check();
await btn(plannerPage, '批量操作').click();
await plannerPage.getByRole('menuitem', { name: '批量审核' }).click();
const auditModal = modalByTitle(plannerPage, '批量审核');
await auditModal.waitFor();
await shot(plannerPage, '09-合同审核打开态');
await btn(auditModal, '确定').click();
await auditModal.waitFor({ state: 'hidden' });
await plannerPage.waitForTimeout(800);
await search(plannerPage, '备注', NOTE);
await plannerPage.locator('tr', { hasText: contractCode }).first().getByText('履约中', { exact: true }).waitFor();
await shot(plannerPage, '10-合同审核通过');
const lifeText = (await plannerPage.locator('tr', { hasText: contractCode }).first().getByText('履约中', { exact: true }).innerText()).trim();
eq(lifeText, '履约中', 'B2 合同履约中');
const approved = await api(admin, 'GET', `/api/money/contracts/${browserContract.id}`);
eq(String(approved.contract.debt), R12B_DEBT, 'B2 审核后欠款1000');
eq(String(approved.contract.lifecycle), 'performing', 'B2 业务状态performing');

await goto(plannerPage, '/inside_produce_bill/add?pick=1');
const pickContract = modalByTitle(plannerPage, '选择合同订单');
await pickContract.waitFor();
await shot(plannerPage, '11-加工单选择合同打开态');
await pickContract.getByPlaceholder('合同编号/商品').fill(contractCode);
await btn(pickContract.locator('tr', { hasText: contractCode }).first(), '选择').click();
await pickContract.waitFor({ state: 'hidden' });
const woNote = await siblingInput(plannerPage.locator('.kgd-form').first(), '备注');
await woNote.fill(WO_NOTE);
await pickSiblingSelect(plannerPage, plannerPage.locator('.kgd-form').first(), '成品仓库', 'R12回归仓');
await plannerPage.getByRole('tab', { name: '生产任务' }).click();
await plannerPage.getByRole('button', { name: '从工序中添加' }).click();
const processModal = modalByTitle(plannerPage, '从工序中添加');
await processModal.locator('tr', { hasText: 'R12B计件' }).first().locator('input[type=checkbox]').check();
await shot(plannerPage, '12-加工单填写打开态');
await btn(processModal, '确定').click();
await processModal.waitFor({ state: 'hidden' });
await plannerPage.getByRole('button', { name: '创建加工单' }).click();
await plannerPage.waitForURL(/\/inside_produce_bill\/detail\//);
await plannerPage.getByText(WO_NOTE, { exact: true }).waitFor();
await shot(plannerPage, '13-加工单创建结果');
const woId = plannerPage.url().split('/detail/')[1]?.split(/[/?]/)[0] ?? '';
const createdWo = await api(admin, 'GET', `/api/work-orders/${woId}`);
eq(String(createdWo.work_order.contract_code), contractCode, 'B3 加工单带合同编号');
eq(String(createdWo.work_order.note), WO_NOTE, 'B3 加工单备注');
const planShown = (await plannerPage.getByText(R12B_PLAN, { exact: true }).first().innerText()).trim();
eq(planShown, R12B_PLAN, 'B3 计划数10');
await plannerPage.getByRole('button', { name: '开始工序', exact: true }).click();
await plannerPage.getByText('进行中', { exact: true }).first().waitFor();
await shot(plannerPage, '14-开始工序结果');
const started = await api(admin, 'GET', `/api/work-orders/${woId}`);
eq(String(started.work_order.tasks[0].execution), 'running', 'B4 任务进行中');

const workerUi = await openPage(r12b);
const workerPage = workerUi.page;
await goto(workerPage, `/inside_produce_bill/detail/${woId}?tab=flow`);
const taskRow = workerPage.locator('tr', { hasText: 'R12B计件' }).first();
await taskRow.waitFor();
await btn(taskRow, '报工').click();
const reportModal = modalByTitle(workerPage, '报工');
await reportModal.waitFor();
await shot(workerPage, '15-报工弹窗打开态');
const goodBox = await siblingInput(reportModal, '良品数');
await goodBox.fill(R12B_GOOD);
const defectBox = await siblingInput(reportModal, '不良品数');
await defectBox.fill('0');
await reportModal.getByText('20元', { exact: true }).waitFor();
const previewWage = (await reportModal.getByText('20元', { exact: true }).innerText()).trim();
eq(previewWage, '20元', 'B5 报工弹窗工资20元');
await reportModal.getByRole('button', { name: '仅报工' }).click();
await workerPage.getByText('报工成功', { exact: true }).waitFor();
await shot(workerPage, '16-报工成功');
const reports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${woId}`)).items ?? [];
const browserReport = reports.find((item) => item.operator_id === r12b.userId && item.estimated_wage === R12B_WAGE);
if (!browserReport) throw new Error(`找不到工资 ${R12B_WAGE} 的浏览器报工`);
eq(browserReport.estimated_wage, R12B_WAGE, 'B5 报工工资20.00');
eqNumber(browserReport.good_qty, R12B_GOOD, 'B5 良品2');

await goto(page, '/work_repoty_record/list');
await search(page, '加工单号', createdWo.work_order.code);
const reportRow = page.locator('tr', { hasText: createdWo.work_order.code }).first();
await reportRow.waitFor();
await reportRow.getByRole('button', { name: '结算', exact: true }).click();
const settleModal = modalByTitle(page, '工资结算');
await settleModal.waitFor();
await shot(page, '17-结算弹窗打开态');
const settleWage = (await settleModal.getByText('20元', { exact: true }).innerText()).trim();
eq(settleWage, '20元', 'B6 结算弹窗工资20元');
await settleModal.getByText('已结算', { exact: true }).click();
await settleModal.getByRole('button', { name: '确 定' }).click();
await settleModal.waitFor({ state: 'hidden' });
await page.waitForTimeout(600);
await shot(page, '18-结算结果');
const settled = (await api(admin, 'GET', `/api/production-reports?work_order_id=${woId}`)).items.find((item) => item.id === browserReport.id);
eq(settled.settlement_status, 'settled', 'B6 报工已结算');
eq(settled.estimated_wage, R12B_WAGE, 'B6 结算后工资仍为20.00');

await goto(page, '/payroll_statement/list');
await search(page, '姓名', 'R12B工人');
await page.locator('tr', { hasText: 'R12B工人' }).first().waitFor();
await shot(page, '19-R12B工资报表');
const bWage = (await page.locator('tr', { hasText: 'R12B工人' }).first().getByText(R12B_WAGE_LABEL, { exact: true }).first().innerText()).trim();
eq(bWage, R12B_WAGE_LABEL, 'B7 R12B工人工资20');

const ownUi = await openPage(r12);
const ownPage = ownUi.page;
await goto(ownPage, '/payroll_statement/list');
await ownPage.locator('tr', { hasText: 'R12回归工人' }).first().waitFor();
await shot(ownPage, '20-回归工人只看自己');
const ownWage = (await ownPage.locator('tr', { hasText: 'R12回归工人' }).first().getByText(SEED_WAGE_LABEL, { exact: true }).first().innerText()).trim();
eq(ownWage, SEED_WAGE_LABEL, 'B8 回归工人看到自己的750');
eq(String(await ownPage.locator('tr', { hasText: 'R12B工人' }).count()), '0', 'B8 回归工人看不到R12B工人');

const otherUi = await openPage(worker);
const otherPage = otherUi.page;
await goto(otherPage, '/payroll_statement/list');
await otherPage.waitForTimeout(800);
await shot(otherPage, '21-普通工人看不到他人工资');
eq(String(await otherPage.locator('tr', { hasText: 'R12回归工人' }).count()), '0', 'B8 普通工人看不到回归工人');
eq(String(await otherPage.locator('tr', { hasText: 'R12B工人' }).count()), '0', 'B8 普通工人看不到R12B工人');
eq(String(await otherPage.getByText(SEED_WAGE, { exact: true }).count()), '0', 'B8 普通工人页面没有750.00');

await goto(page, '/sale_stock_out_bill/list');
await btn(page, '+ 新增').click();
await page.getByRole('menuitem', { name: '合同出库' }).click();
const shipModal = modalByTitle(page, '新增销售出库单');
await shipModal.waitFor();
await shot(page, '22-销售出库打开态');
await pickSiblingSelect(page, shipModal, '仓库', 'R12回归仓');
await pickSiblingSelect(page, shipModal, '合同单号', contractCode);
await shipModal.getByRole('button', { name: '+ 选择合同商品' }).click();
await shipModal.locator('tr', { hasText: 'R12回归商品' }).first().locator('input').fill(R12B_SHIP);
await shot(page, '23-销售出库已填写');
await shipModal.getByRole('button', { name: '确 定' }).click();
await page.getByText('已保存', { exact: true }).waitFor();
await shot(page, '24-销售出库保存结果');
const shipments = (await api(admin, 'GET', `/api/warehouse/shipments?contract_id=${browserContract.id}`)).items ?? [];
const browserShip = shipments.find((item) => (item.lines ?? []).some((line) => /^-?\d+(\.\d+)?$/.test(String(line.quantity).trim()) && Number(line.quantity) === Number(R12B_SHIP)));
if (!browserShip) throw new Error('页面保存后找不到 R12B 出库单');
if (browserShip.approval === 'pending' || browserShip.audit_status === 'pending') {
  await api(admin, 'POST', '/api/audit/decide', { object_type: 'sale_shipment', object_id: browserShip.id, action: '通过', remark: '通过' });
}
const afterShip = await api(admin, 'GET', `/api/money/contracts/${browserContract.id}`);
eq(String(afterShip.contract.outbound_progress), R12B_OUTBOUND, 'B10 出库进度10% (1/10)');
const seedAfter = await api(admin, 'GET', `/api/money/contracts/${seedContract.id}`);
eq(String(seedAfter.contract.debt), SEED_DEBT, '出库R12B后主链欠款仍为8500');
eq(String(seedAfter.contract.outbound_progress), SEED_OUTBOUND, '出库R12B后主链出库仍为50/100');

await goto(page, '/produce_stock_in_bill/list');
await btn(page, '+ 新增').click();
await page.getByRole('menuitem', { name: '加工单入库' }).click();
const fgModal = modalByTitle(page, '新增成品入库单');
await fgModal.waitFor();
await shot(page, '25-成品入库打开态');
await fgModal.getByRole('button', { name: '取 消' }).click();

const pngs = readdirSync(outDir).filter((name) => name.endsWith('.png'));
eq(String(pngs.length >= 12), 'true', `截图不少于12张（实际${pngs.length}）`);
eq(String(checks.length >= 20), 'true', `验收不少于20条（实际${checks.length}）`);
const hashes = pngs.map((name) => createHash('md5').update(readFileSync(path.join(outDir, name))).digest('hex'));
eq(String(new Set(hashes).size), String(hashes.length), '截图MD5互异');

writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ checks, shots, pngs }, null, 2));
console.log(`\n验收 ${checks.length} 条，截图 ${pngs.length} 张`);
await browser.close();
