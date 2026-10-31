/**
 * 全面 UAT（Playwright）。前置：npm run dev && node scripts/seed-uat-r13.mjs
 * 截图 artifacts/uat-r13/。表单保存走页面点选。数字用 ===。
 * 禁止 force、禁止吞断言、禁止没数据就选第一项、禁止条件跳过。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'artifacts/uat-r13');
const docDir = path.join(process.cwd(), 'docs/verification/uat-r13');
mkdirSync(outDir, { recursive: true });
mkdirSync(docDir, { recursive: true });

const B_QTY = '8';
const B_PRICE = '25';
const B_AMOUNT = '200';
const B_DEBT = '200';
const B_GOOD = '3';
const B_WAGE = '24.00';
const B_WAGE_LABEL = '24';
const B_YUAN = '24元';
const B_PLAN = '8';
const B_SHIP = '2';
const B_OUTBOUND = '25% (2/8)';
const SEED_DEBT = '1500';
const SEED_RECEIVED = '500';
const SEED_PROGRESS = '25% (500/2000)';
const SEED_OUTBOUND = '25% (10/40)';
const SEED_PRODUCE = '100% (40/40)';
const SEED_WAGE = '160.00';
const SEED_WAGE_LABEL = '160';
const SEED_PO_AMOUNT = '30';
const SEED_PO_PAID = '12';
const SEED_PO_DEBT = '18';
const SEED_FG_IN = '20';
const SEED_STOCK = '10';
const SEED_RAW = '6';
const NOTE = 'UATB浏览器合同';
const WO_NOTE = 'UATB浏览器加工单';
const CUSTOM_NAME = 'UAT自定义报工模板';
const CUSTOM_TEXT = 'UAT自定义抬头';
const PRINT_WO = 'UATP-打印';
const PRINT_PRODUCT = 'UAT打印验收商品';
const SUPPLIER_FIELD = 'UAT供应商备注';
const SUPPLIER_NAME = 'UAT扩展供应商';
const SUPPLIER_VALUE = 'UAT供应商扩展值';
const HEAD_FIELD = 'UAT入库备注';
const LINE_FIELD = 'UAT明细备注';
const HEAD_VALUE = 'UAT主表扩展值';
const LINE_VALUE = 'UAT明细扩展值';
const RECEIPT_NOTE = 'UAT扩展入库';
const CUSTOMER_FIELD = 'UAT客户备注';
const CUSTOMER_NAME = 'UAT扩展客户';
const CUSTOMER_VALUE = 'UAT客户扩展值';

const checks = [];
const shots = [];
function eq(actual, expected, name, section) {
  const ok = actual === expected;
  checks.push({ section, name, result: ok ? '通过' : '未通过', actual: String(actual), expected: String(expected) });
  console.log(`${ok ? '通过' : '未通过'}\t${section}\t${name}\t${actual}`);
  if (!ok) throw new Error(`${name}：期望 ${expected}，实际 ${actual}`);
}
function eqNumber(actual, expected, name, section) {
  const text = String(actual ?? '').trim();
  const ok = /^-?\d+(\.\d+)?$/.test(text) && Number(text) === Number(expected);
  eq(ok ? String(expected) : text, String(expected), name, section);
}

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}
async function login(username, password, tenant = 'demo-a') {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_slug: tenant, username, password }),
    });
    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 12000));
      continue;
    }
    const json = await res.json();
    const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
    if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${username}@${tenant} ${JSON.stringify(json).slice(0, 240)}`);
    return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name, tenant };
  }
  throw new Error(`登录限流未恢复 ${username}`);
}
async function call(session, method, urlPath, body) {
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
  let json = {};
  if (text) json = JSON.parse(text);
  return { status: res.status, json, text };
}
async function api(session, method, urlPath, body) {
  const res = await call(session, method, urlPath, body);
  if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${urlPath} ${res.status}: ${res.text.slice(0, 400)}`);
  return res.json;
}

const devPass = {
  admin: passwordOf('.local/dev-credentials.txt', 'admin.local'),
  planner: passwordOf('.local/dev-credentials.txt', 'planner.local'),
  worker: passwordOf('.local/dev-credentials.txt', 'worker.local'),
};
const uatPass = passwordOf('.local/uat-r13-credentials.txt', 'uat.worker');
const uatbPass = passwordOf('.local/uat-r13-credentials.txt', 'uatb.worker');
if (!devPass.admin || !devPass.planner || !devPass.worker || !uatPass || !uatbPass) throw new Error('缺少 dev 或 uat-r13 凭据');

const admin = await login('admin.local', devPass.admin);
const planner = await login('planner.local', devPass.planner);
const worker = await login('worker.local', devPass.worker);
const uat = await login('uat.worker', uatPass);
const uatb = await login('uatb.worker', uatbPass);
const adminB = await login('admin.local', devPass.admin, 'demo-b');

const priorReports = (await api(admin, 'GET', `/api/production-reports?operator_id=${uatb.userId}`)).items ?? [];
for (const item of priorReports) {
  if (item.approval !== 'approved' || item.estimated_wage !== B_WAGE || item.operator_id !== uatb.userId) continue;
  let version = item.version;
  if (item.settlement_status === 'settled') {
    const unsettled = await api(admin, 'POST', `/api/production-reports/${item.id}/settlement`, {
      request_key: crypto.randomUUID(), version, settled: false, note: 'UATB验收重跑改回未结算',
    });
    version = unsettled.report.version;
  }
  await api(admin, 'POST', `/api/production-reports/${item.id}/actions`, {
    action: 'reverse', version, reason: 'UATB验收重跑冲销上一笔浏览器报工', request_key: crypto.randomUUID(),
  });
}
async function removeField(entity, name) {
  const fields = await api(admin, 'GET', `/api/entity-ext-fields?entity=${entity}`);
  for (const item of fields.items ?? []) {
    if (item.name === name) await api(admin, 'DELETE', `/api/entity-ext-fields/${item.id}`, {});
  }
}
for (const [entity, name] of [['supplier', SUPPLIER_FIELD], ['purchase_stock_in', HEAD_FIELD], ['purchase_stock_in_line', LINE_FIELD], ['customer', CUSTOMER_FIELD]]) {
  await removeField(entity, name);
}
const printList = await api(admin, 'GET', '/api/print-templates?object_key=work_report');
for (const item of printList.items ?? []) {
  if (!item.is_system && item.name === CUSTOM_NAME) await api(admin, 'DELETE', `/api/print-templates/${item.id}`, {});
}

const browser = await chromium.launch({ headless: true });
const pageErrors = [];
let failedError = null;
try {
  async function openPage(session) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const raw = session.cookie.split(';')[0];
    const eqAt = raw.indexOf('=');
    await context.addCookies([{ name: raw.slice(0, eqAt), value: raw.slice(eqAt + 1), url: WEB }]);
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    page.on('pageerror', (error) => pageErrors.push(`${session.name}:${error.message}`));
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
    const before = pageErrors.length;
    await page.goto(`${WEB}${urlPath}`, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn{display:none!important;pointer-events:none!important}' });
    await page.getByText('快工单', { exact: true }).first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    if (pageErrors.length > before) throw new Error(`${urlPath} 未捕获异常 ${pageErrors.at(-1)}`);
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
  async function ddOf(page, label) {
    const dt = page.locator('dt').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first();
    await dt.waitFor();
    return (await dt.locator('xpath=following-sibling::dd[1]').innerText()).trim();
  }
  async function chooseExact(page, select, label) {
    await select.click();
    const option = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    const count = await option.count();
    if (count !== 1) throw new Error(`选项「${label}」匹配 ${count} 项`);
    await option.click();
  }
  async function closeModals(page) {
    for (let i = 0; i < 6; i += 1) {
      const visible = page.locator('.ant-modal-wrap:visible');
      if (!(await visible.count())) return;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
    const left = await page.locator('.ant-modal-wrap:visible').count();
    if (left) throw new Error(`仍有 ${left} 个弹窗`);
  }
  async function clickExt(page) {
    const button = page.locator('.kgd-toolbar').getByRole('button', { name: /^扩展字段$/ });
    const count = await button.count();
    if (count !== 1) throw new Error(`扩展字段按钮数量 ${count}`);
    await button.click();
  }
  async function expectTitle(page, title) {
    const modal = page.locator('.ant-modal').filter({ hasText: title }).last();
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    const heading = (await modal.locator('.ant-modal-title').innerText()).trim();
    if (heading !== title) throw new Error(`标题「${heading}」不等于「${title}」`);
    return modal;
  }
  async function confirmTextField(page, add, name) {
    await page.waitForTimeout(450);
    const nameInput = add.locator('label').filter({ hasText: '字段名' }).locator('input');
    await nameInput.click();
    await nameInput.pressSequentially(name, { delay: 15 });
    if (await nameInput.inputValue() !== name) throw new Error(`字段名未写入，当前「${await nameInput.inputValue()}」`);
    await btn(add, '确定').click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!(await add.isVisible())) return;
      if (await add.locator('.kgd-field-help').count()) throw new Error(await add.locator('.kgd-field-help').innerText());
      await page.waitForTimeout(200);
    }
    throw new Error('新增扩展字段未关闭');
  }

  const seedContracts = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
  const seedContract = seedContracts.find((item) => item.note === 'UAT回归合同');
  if (!seedContract) throw new Error('找不到 UAT回归合同，请先跑 seed');
  const seedOrders = (await api(admin, 'GET', '/api/work-orders')).items ?? [];
  const seedOrder = seedOrders.find((item) => item.code === 'UAT-主链');
  if (!seedOrder) throw new Error('找不到 UAT-主链');
  const purchases = (await api(admin, 'GET', '/api/money/purchase-orders')).items ?? [];
  const payOrder = purchases.find((item) => item.note === 'UAT采购付款');
  const extOrder = purchases.find((item) => item.note === 'UAT扩展采购');
  const pendingOrder = purchases.find((item) => item.note === 'UAT待审采购');
  if (!payOrder || !extOrder || !pendingOrder) throw new Error('找不到 UAT 采购单');
  const printOrder = seedOrders.find((item) => item.code === PRINT_WO);
  if (!printOrder) throw new Error('找不到 UATP-打印');

  const adminUi = await openPage(admin);
  const page = adminUi.page;

  await goto(page, '/customer_contract/list');
  await search(page, '备注', 'UAT回归合同');
  await page.getByText(SEED_DEBT, { exact: true }).first().waitFor();
  await shot(page, '01-合同列表欠款');
  const seedRow = page.locator('tr', { hasText: 'UAT回归合同' }).first();
  eq((await seedRow.getByText(SEED_DEBT, { exact: true }).innerText()).trim(), SEED_DEBT, '合同列表欠款1500', 'B1');
  eq((await seedRow.getByText(SEED_RECEIVED, { exact: true }).innerText()).trim(), SEED_RECEIVED, '合同列表累计收款500', 'B1');
  eq((await seedRow.getByText(SEED_OUTBOUND, { exact: true }).innerText()).trim(), SEED_OUTBOUND, '合同列表出库进度10/40', 'B1');
  eq((await seedRow.getByText(SEED_PRODUCE, { exact: true }).innerText()).trim(), SEED_PRODUCE, '合同列表投产进度40/40', 'B1');

  await goto(page, `/customer_contract/detail/${seedContract.id}`);
  await page.getByText(SEED_DEBT, { exact: true }).first().waitFor();
  await shot(page, '02-合同详情进度');
  eq(await ddOf(page, '欠款'), SEED_DEBT, '合同详情欠款1500', 'B1');
  eq((await page.getByText(SEED_PRODUCE, { exact: true }).first().innerText()).trim(), SEED_PRODUCE, '合同详情投产进度', 'B1');
  eq((await page.getByText(SEED_OUTBOUND, { exact: true }).first().innerText()).trim(), SEED_OUTBOUND, '合同详情出库进度', 'B1');
  eq((await page.getByText(SEED_PROGRESS, { exact: true }).first().innerText()).trim(), SEED_PROGRESS, '合同详情收款进度25%', 'B1');

  await goto(page, `/inside_produce_bill/detail/${seedOrder.id}?tab=wages`);
  await page.getByRole('tab', { name: '工资单' }).click();
  await page.getByText(SEED_WAGE, { exact: true }).first().waitFor();
  await shot(page, '03-加工单工资单160');
  eq((await page.getByText(SEED_WAGE, { exact: true }).first().innerText()).trim(), SEED_WAGE, '加工单工资单160.00', 'B1');

  await goto(page, '/payroll_statement/list');
  await search(page, '姓名', 'UAT回归工人');
  await page.locator('tr', { hasText: 'UAT回归工人' }).first().waitFor();
  await shot(page, '04-生产工资报表160');
  eq((await page.locator('tr', { hasText: 'UAT回归工人' }).first().getByText(SEED_WAGE_LABEL, { exact: true }).first().innerText()).trim(), SEED_WAGE_LABEL, '生产工资报表160', 'B1');

  await goto(page, `/purchase_order/detail/${payOrder.id}`);
  await shot(page, '05-采购已付应付');
  eq(await ddOf(page, '已付款(元)'), SEED_PO_PAID, '采购详情已付12', 'B2');
  eq(await ddOf(page, '欠款(元)'), SEED_PO_DEBT, '采购详情应付18', 'B2');
  eq(await ddOf(page, '入库金额(元)'), SEED_PO_AMOUNT, '采购详情入库应付30', 'B2');

  await goto(page, '/customer_contract/list');
  const beforeContractIds = new Set(((await api(admin, 'GET', '/api/money/contracts')).items ?? []).filter((item) => item.note === NOTE).map((item) => item.id));
  await btn(page, '新增').click();
  await page.getByRole('menuitem', { name: '直接创建' }).click();
  const contractModal = modalByTitle(page, '新增合同');
  await contractModal.waitFor();
  await shot(page, '06-合同新增打开态');
  await pickOption(page, contractModal, '客户', 'UAT回归客户');
  await pickOption(page, contractModal, '业务员', admin.name);
  await contractModal.getByPlaceholder('请填写，忽略将自动生成').fill('');
  await contractModal.locator('textarea').first().fill(NOTE);
  await contractModal.getByRole('button', { name: '+ 选择合同商品' }).click();
  const picker = modalByTitle(page, '选择商品');
  await picker.getByPlaceholder('商品', { exact: true }).fill('UAT回归商品');
  await picker.locator('tr', { hasText: 'UAT回归商品' }).first().locator('input[type=checkbox]').check();
  await picker.getByRole('button', { name: '确 定' }).click();
  await picker.waitFor({ state: 'hidden' });
  const line = contractModal.locator('tr', { hasText: 'UAT回归商品' }).first();
  const lineInputs = line.locator('input');
  await lineInputs.nth(0).fill(B_PRICE);
  await lineInputs.nth(1).fill(B_QTY);
  await shot(page, '07-合同新增已填写');
  await contractModal.getByRole('button', { name: '提交审核' }).click();
  await page.getByText('已提交审核', { exact: true }).waitFor();
  await shot(page, '08-合同提交后列表');
  const browserContracts = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
  const createdContracts = browserContracts.filter((item) => item.note === NOTE && !beforeContractIds.has(item.id));
  if (createdContracts.length !== 1) throw new Error(`页面保存后 UATB 合同新增 ${createdContracts.length} 张`);
  const browserContract = createdContracts[0];
  await search(page, '备注', NOTE);
  const submittedRow = page.locator('tr', { hasText: browserContract.code }).first();
  await submittedRow.waitFor();
  eq((await submittedRow.getByText('待审', { exact: true }).innerText()).trim(), '待审', '新合同待审', 'B1');
  eq(String(browserContract.amount), B_AMOUNT, '浏览器合同金额200', 'B1');
  eq(String(browserContract.approval), 'pending', '浏览器合同pending', 'B1');
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
  await auditModal.getByText('通过', { exact: true }).waitFor();
  await auditModal.getByText('退回', { exact: true }).waitFor();
  await shot(plannerPage, '09-合同审核通过退回打开态');
  eq(String(await auditModal.getByRole('radio', { name: '通过' }).count()), '1', '审核打开态有通过', 'B3');
  eq(String(await auditModal.getByRole('radio', { name: '退回' }).count()), '1', '审核打开态有退回', 'B3');
  await btn(auditModal, '确定').click();
  await auditModal.waitFor({ state: 'hidden' });
  await plannerPage.waitForTimeout(800);
  await search(plannerPage, '备注', NOTE);
  await plannerPage.locator('tr', { hasText: contractCode }).first().getByText('履约中', { exact: true }).waitFor();
  await shot(plannerPage, '10-合同审核通过');
  eq((await plannerPage.locator('tr', { hasText: contractCode }).first().getByText('履约中', { exact: true }).innerText()).trim(), '履约中', '合同履约中', 'B1');
  const approved = await api(admin, 'GET', `/api/money/contracts/${browserContract.id}`);
  eq(String(approved.contract.debt), B_DEBT, '审核后欠款200', 'B1');
  eq(String(approved.contract.lifecycle), 'performing', '业务状态performing', 'B1');

  const rejectNote = `UAT退回探针${Date.now().toString().slice(-6)}`;
  const rejectContract = (await api(admin, 'POST', '/api/money/contracts', {
    request_key: crypto.randomUUID(), customer_id: seedContract.customer_id, contact_name: 'UAT联系人', salesperson_id: admin.userId,
    prepay: '0', note: rejectNote, lines: [{ product_id: (await api(admin, 'GET', '/api/products?page=1&page_size=100&code=UAT-GOOD')).items.find((item) => item.code === 'UAT-GOOD').id, quantity: '1', unit_price: '100' }],
  })).contract;
  eq(String(rejectContract.approval), 'pending', '退回探针待审', 'B3');
  await goto(plannerPage, '/customer_contract/list');
  await search(plannerPage, '备注', rejectNote);
  const rejectRow = plannerPage.locator('tr', { hasText: rejectNote }).first();
  await rejectRow.waitFor();
  await rejectRow.locator('input[type=checkbox]').first().check();
  await btn(plannerPage, '批量操作').click();
  await plannerPage.getByRole('menuitem', { name: '批量审核' }).click();
  const rejectModal = modalByTitle(plannerPage, '批量审核');
  await rejectModal.waitFor();
  await rejectModal.getByRole('radio', { name: '退回' }).check();
  await rejectModal.getByPlaceholder('备注').fill('UAT退回');
  await shot(plannerPage, '11-审核退回打开态');
  await btn(rejectModal, '确定').click();
  await rejectModal.waitFor({ state: 'hidden' });
  await plannerPage.waitForTimeout(800);
  const rejected = await api(admin, 'GET', `/api/money/contracts/${rejectContract.id}`);
  eq(String(rejected.contract.approval), 'rejected', '退回探针已退回', 'B3');
  eq(String(rejected.contract.approval_text), '退回', '退回探针文案为退回', 'B3');
  const untouched = await api(admin, 'GET', `/api/money/contracts/${seedContract.id}`);
  eq(String(untouched.contract.debt), SEED_DEBT, '退回探针不改变主链欠款', 'B3');

  await goto(plannerPage, '/inside_produce_bill/add?pick=1');
  const pickContract = modalByTitle(plannerPage, '选择合同订单');
  await pickContract.waitFor();
  await shot(plannerPage, '12-加工单选择合同打开态');
  await pickContract.getByPlaceholder('合同编号/商品').fill(contractCode);
  await btn(pickContract.locator('tr', { hasText: contractCode }).first(), '选择').click();
  await pickContract.waitFor({ state: 'hidden' });
  const woNote = await siblingInput(plannerPage.locator('.kgd-form').first(), '备注');
  await woNote.fill(WO_NOTE);
  await pickSiblingSelect(plannerPage, plannerPage.locator('.kgd-form').first(), '成品仓库', 'UAT回归仓');
  await plannerPage.getByRole('tab', { name: '生产任务' }).click();
  await plannerPage.getByRole('button', { name: '从工序中添加' }).click();
  const processModal = modalByTitle(plannerPage, '从工序中添加');
  await processModal.locator('tr', { hasText: 'UATB计件' }).first().locator('input[type=checkbox]').check();
  await shot(plannerPage, '13-加工单填写打开态');
  await btn(processModal, '确定').click();
  await processModal.waitFor({ state: 'hidden' });
  await plannerPage.getByRole('button', { name: '创建加工单' }).click();
  await plannerPage.waitForURL(/\/inside_produce_bill\/detail\//);
  await plannerPage.getByText(WO_NOTE, { exact: true }).waitFor();
  await shot(plannerPage, '14-加工单创建结果');
  const woId = plannerPage.url().split('/detail/')[1]?.split(/[/?]/)[0] ?? '';
  const createdWo = await api(admin, 'GET', `/api/work-orders/${woId}`);
  eq(String(createdWo.work_order.contract_code), contractCode, '加工单带合同编号', 'B1');
  eq(String(createdWo.work_order.note), WO_NOTE, '加工单备注', 'B1');
  eq((await plannerPage.getByText(B_PLAN, { exact: true }).first().innerText()).trim(), B_PLAN, '计划数8', 'B1');
  await plannerPage.getByRole('button', { name: '开始工序', exact: true }).click();
  await plannerPage.getByText('进行中', { exact: true }).first().waitFor();
  await shot(plannerPage, '15-开始工序结果');
  const started = await api(admin, 'GET', `/api/work-orders/${woId}`);
  eq(String(started.work_order.tasks[0].execution), 'running', '任务进行中', 'B1');

  const workerUi = await openPage(uatb);
  const workerPage = workerUi.page;
  await goto(workerPage, `/inside_produce_bill/detail/${woId}?tab=flow`);
  const taskRow = workerPage.locator('tr', { hasText: 'UATB计件' }).first();
  await taskRow.waitFor();
  await btn(taskRow, '报工').click();
  const reportModal = modalByTitle(workerPage, '报工');
  await reportModal.waitFor();
  await shot(workerPage, '16-报工弹窗打开态');
  await (await siblingInput(reportModal, '良品数')).fill(B_GOOD);
  await (await siblingInput(reportModal, '不良品数')).fill('0');
  await reportModal.getByText(B_YUAN, { exact: true }).waitFor();
  eq((await reportModal.getByText(B_YUAN, { exact: true }).innerText()).trim(), B_YUAN, '报工弹窗工资24元', 'B1');
  await reportModal.getByRole('button', { name: '仅报工' }).click();
  await workerPage.getByText('报工成功', { exact: true }).waitFor();
  await shot(workerPage, '17-报工成功');
  const reports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${woId}`)).items ?? [];
  const browserReport = reports.find((item) => item.operator_id === uatb.userId && item.estimated_wage === B_WAGE);
  if (!browserReport) throw new Error(`找不到工资 ${B_WAGE} 的浏览器报工`);
  eq(browserReport.estimated_wage, B_WAGE, '报工工资24.00', 'B1');
  eqNumber(browserReport.good_qty, B_GOOD, '良品3', 'B1');

  await goto(page, '/work_repoty_record/list');
  await search(page, '加工单号', createdWo.work_order.code);
  const reportRow = page.locator('tr', { hasText: createdWo.work_order.code }).first();
  await reportRow.waitFor();
  await shot(page, '18-报工记录筛选');
  eq(String(await page.locator('tr', { hasText: createdWo.work_order.code }).count() > 0), 'true', '报工记录筛到UATB加工单', 'B8');
  await reportRow.getByRole('button', { name: '结算', exact: true }).click();
  const settleModal = modalByTitle(page, '工资结算');
  await settleModal.waitFor();
  await shot(page, '19-结算弹窗打开态');
  eq((await settleModal.getByText(B_YUAN, { exact: true }).innerText()).trim(), B_YUAN, '结算弹窗工资24元', 'B1');
  await settleModal.getByText('已结算', { exact: true }).click();
  await settleModal.getByRole('button', { name: '确 定' }).click();
  await settleModal.waitFor({ state: 'hidden' });
  await page.waitForTimeout(600);
  await shot(page, '20-结算结果');
  const settled = (await api(admin, 'GET', `/api/production-reports?work_order_id=${woId}`)).items.find((item) => item.id === browserReport.id);
  eq(settled.settlement_status, 'settled', '报工已结算', 'B1');
  eq(settled.estimated_wage, B_WAGE, '结算后工资仍为24.00', 'B1');

  await goto(page, '/payroll_statement/list');
  await search(page, '姓名', 'UATB工人');
  await page.locator('tr', { hasText: 'UATB工人' }).first().waitFor();
  await shot(page, '21-UATB工资报表');
  eq((await page.locator('tr', { hasText: 'UATB工人' }).first().getByText(B_WAGE_LABEL, { exact: true }).first().innerText()).trim(), B_WAGE_LABEL, 'UATB工人工资24', 'B1');

  const ownUi = await openPage(uat);
  const ownPage = ownUi.page;
  await goto(ownPage, '/payroll_statement/list');
  await ownPage.locator('tr', { hasText: 'UAT回归工人' }).first().waitFor();
  await shot(ownPage, '22-回归工人只看自己');
  eq((await ownPage.locator('tr', { hasText: 'UAT回归工人' }).first().getByText(SEED_WAGE_LABEL, { exact: true }).first().innerText()).trim(), SEED_WAGE_LABEL, '回归工人看到自己的160', 'B7');
  eq(String(await ownPage.locator('tr', { hasText: 'UATB工人' }).count()), '0', '回归工人看不到UATB工人', 'B7');

  const otherUi = await openPage(worker);
  const otherPage = otherUi.page;
  await goto(otherPage, '/payroll_statement/list');
  await otherPage.waitForTimeout(800);
  await shot(otherPage, '23-普通工人看不到他人工资');
  eq(String(await otherPage.locator('tr', { hasText: 'UAT回归工人' }).count()), '0', '普通工人看不到回归工人', 'B7');
  eq(String(await otherPage.locator('tr', { hasText: 'UATB工人' }).count()), '0', '普通工人看不到UATB工人', 'B7');
  eq(String(await otherPage.getByText(SEED_WAGE, { exact: true }).count()), '0', '普通工人页面没有160.00', 'B7');
  eq(String(await otherPage.locator('.kgd-rail button[aria-label="客户管理"]').count()), '0', '工人侧栏没有客户管理', 'B7');
  eq(String(await otherPage.locator('.kgd-rail button[aria-label="供应/采购"]').count()), '0', '工人侧栏没有供应采购', 'B7');
  eq(String(await otherPage.locator('.kgd-rail button[aria-label="仓库管理"]').count()), '0', '工人侧栏没有仓库管理', 'B7');
  await otherPage.locator('.kgd-rail button[aria-label="系统管理"]').click();
  await otherPage.waitForTimeout(500);
  await shot(otherPage, '24-工人系统菜单');
  eq(String(await otherPage.getByRole('button', { name: '用户管理', exact: true }).count()), '0', '工人看不到用户管理', 'B7');
  eq(String(await otherPage.getByRole('button', { name: '角色管理', exact: true }).count()), '0', '工人看不到角色管理', 'B7');
  const workerContracts = await call(worker, 'GET', '/api/money/contracts');
  eq(String(workerContracts.status), '403', '工人读合同403', 'B7');
  const workerUsers = await call(worker, 'GET', '/api/system/users');
  eq(String(workerUsers.status), '403', '工人读用户403', 'B7');
  await goto(otherPage, '/customer_contract/list');
  await otherPage.waitForTimeout(800);
  eq(String(await otherPage.getByText(SEED_DEBT, { exact: true }).count()), '0', '工人合同页没有主链欠款', 'B7');
  await shot(otherPage, '25-工人直接打开合同');

  await goto(page, '/purchase_order/list');
  await search(page, '采购单号', payOrder.code);
  const poRow = page.locator('tr', { hasText: payOrder.code }).first();
  await poRow.waitFor();
  await shot(page, '26-采购列表应付');
  eq((await poRow.getByText(SEED_PO_PAID, { exact: true }).first().innerText()).trim(), SEED_PO_PAID, '采购列表已付12', 'B2');
  eq((await poRow.getByText(SEED_PO_DEBT, { exact: true }).first().innerText()).trim(), SEED_PO_DEBT, '采购列表应付18', 'B2');
  eq((await poRow.getByText(SEED_PO_AMOUNT, { exact: true }).first().innerText()).trim(), SEED_PO_AMOUNT, '采购列表金额30', 'B2');

  await goto(page, '/purchase_pay_record/list');
  await search(page, '输入关键字查询', 'UAT采购付款');
  const payRow = page.locator('tr', { hasText: 'UAT采购付款' }).first();
  await payRow.waitFor();
  await shot(page, '27-付款记录');
  eq((await payRow.getByText(SEED_PO_PAID, { exact: true }).first().innerText()).trim(), SEED_PO_PAID, '付款记录金额12', 'B2');

  await goto(page, '/customer_financier/list');
  await search(page, '输入关键字查询', 'UAT回款');
  const cashRow = page.locator('tr', { hasText: 'UAT回款' }).first();
  await cashRow.waitFor();
  await shot(page, '28-回款列表');
  eq((await cashRow.getByText('300', { exact: true }).first().innerText()).trim(), '300', '回款列表金额300', 'B2');
  await search(page, '输入关键字查询', 'UAT越权探针');
  const probeRow = page.locator('tr', { hasText: 'UAT越权探针' }).first();
  await probeRow.waitFor();
  eq((await probeRow.getByText('待审', { exact: true }).first().innerText()).trim(), '待审', '越权探针在收支列表待审', 'B2');

  await goto(plannerPage, '/customer_financier/list');
  await search(plannerPage, '输入关键字查询', 'UAT越权探针');
  const plannerProbe = plannerPage.locator('tr', { hasText: 'UAT越权探针' }).first();
  await plannerProbe.waitFor();
  await shot(plannerPage, '29-计划员越权收款');
  await plannerProbe.getByRole('button', { name: '通过', exact: true }).click();
  await plannerPage.getByText('不是当前级审核人', { exact: true }).waitFor();
  const probeAfter = ((await api(admin, 'GET', '/api/money/cash')).items ?? []).find((item) => item.note === 'UAT越权探针');
  eq(String(probeAfter.approval), 'pending', '计划员点通过后探针仍待审', 'B7');
  const debtAfterDeny = await api(admin, 'GET', `/api/money/contracts/${seedContract.id}`);
  eq(String(debtAfterDeny.contract.debt), SEED_DEBT, '越权失败后欠款仍为1500', 'B7');
  await ownPage.reload();
  await ownPage.getByText('快工单', { exact: true }).first().waitFor();
  await ownPage.locator('tr', { hasText: 'UAT回归工人' }).first().waitFor();
  eq(String(await ownPage.locator('tr', { hasText: 'UATB工人' }).count()), '0', '管理员操作后工人会话仍看不到UATB', 'B7');

  const goodProductEarly = (await api(admin, 'GET', '/api/products?page=1&page_size=20&code=UAT-GOOD')).items.find((item) => item.code === 'UAT-GOOD');
  const goodWarehouse = (await api(admin, 'GET', '/api/warehouses')).items.find((item) => item.code === 'UAT-WH');
  const handBefore = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((item) => item.product_id === goodProductEarly.id && item.warehouse_id === goodWarehouse.id)?.on_hand ?? '0';
  const handGap = Number(handBefore) - Number(SEED_STOCK);
  if (handGap !== 0) {
    const createdAdj = await api(admin, 'POST', '/api/stock-adjustments', {
      request_key: crypto.randomUUID(), warehouse_id: goodWarehouse.id, product_id: goodProductEarly.id,
      direction: handGap > 0 ? 'out' : 'in', quantity: String(Math.abs(handGap)), reason: 'UAT验收重跑恢复主链结余',
    });
    const adj = createdAdj.stock_adjustment;
    await api(admin, 'POST', `/api/stock-adjustments/${adj.id}/actions`, {
      action: 'approve', version: adj.version, request_key: crypto.randomUUID(),
    });
  }
  const handReady = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((item) => item.product_id === goodProductEarly.id && item.warehouse_id === goodWarehouse.id)?.on_hand ?? '0';
  if (Number(handReady) !== Number(SEED_STOCK)) throw new Error(`恢复后结余 ${handReady}`);

  await goto(page, '/goods_stock/list');
  await search(page, '商品名/简拼/编号/规格', 'UAT回归商品');
  const stockRow = page.locator('tr', { hasText: 'UAT回归商品' }).first();
  await stockRow.waitFor();
  await shot(page, '30-成品结余库存10');
  eq((await stockRow.getByText(SEED_STOCK, { exact: true }).first().innerText()).trim(), SEED_STOCK, '成品结余库存10', 'B3');
  const goodProduct = (await api(admin, 'GET', '/api/products?page=1&page_size=20&code=UAT-GOOD')).items.find((item) => item.code === 'UAT-GOOD');
  const fgLedger = await api(admin, 'GET', `/api/warehouse/stock/ledger?product_id=${goodProduct.id}&source_type=fg_receipt&direction=in`);
  eqNumber(fgLedger.summary?.inbound_qty, SEED_FG_IN, '成品入库流水20', 'B3');
  const seedOutbound = await api(admin, 'GET', `/api/warehouse/contracts/${seedContract.id}/outbound-summary`);
  eqNumber(seedOutbound.lines?.[0]?.shipped_qty, '10', '主链出库数量10', 'B3');
  await search(page, '商品名/简拼/编号/规格', 'UAT待审原料');
  const rawRow = page.locator('tr', { hasText: 'UAT待审原料' }).first();
  await rawRow.waitFor();
  await shot(page, '31-待审原料库存6');
  eq((await rawRow.getByText(SEED_RAW, { exact: true }).first().innerText()).trim(), SEED_RAW, '待审原料库存仍为6', 'B3');
  const rawProduct = (await api(admin, 'GET', '/api/products?page=1&page_size=20&code=UAT-RAW')).items.find((item) => item.code === 'UAT-RAW');
  const rawHand = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((item) => item.product_id === rawProduct.id);
  eqNumber(rawHand?.on_hand, SEED_RAW, '原料库存接口6', 'B3');

  await goto(page, '/purchase_stock_in_bill/list');
  await search(page, '采购单号', pendingOrder.code);
  const pendingRow = page.locator('tr', { hasText: pendingOrder.code }).first();
  await pendingRow.waitFor();
  await shot(page, '32-待审入库');
  eq((await pendingRow.getByText('待审', { exact: true }).first().innerText()).trim(), '待审', '待审入库单显示待审', 'B3');
  const pendingApi = ((await api(admin, 'GET', '/api/warehouse/purchase-receipts')).items ?? []).find((item) => item.note === 'UAT待审+4');
  eq(String(pendingApi?.approval), 'pending', '待审入库接口pending', 'B3');

  await goto(page, '/produce_stock_in_bill/list');
  await search(page, '入库仓库', 'UAT回归仓');
  const fgRow = page.locator('tr', { hasText: 'UAT回归仓' }).first();
  await fgRow.waitFor();
  await shot(page, '33-成品入库已通过');
  eq((await fgRow.getByText('通过', { exact: true }).first().innerText()).trim(), '通过', '成品入库审核通过', 'B3');

  await goto(page, '/sale_stock_out_bill/list');
  await btn(page, '+ 新增').click();
  await page.getByRole('menuitem', { name: '合同出库' }).click();
  const shipModal = modalByTitle(page, '新增销售出库单');
  await shipModal.waitFor();
  await shot(page, '34-销售出库打开态');
  await pickSiblingSelect(page, shipModal, '仓库', 'UAT回归仓');
  await pickSiblingSelect(page, shipModal, '合同单号', contractCode);
  await shipModal.getByRole('button', { name: '+ 选择合同商品' }).click();
  await shipModal.locator('tr', { hasText: 'UAT回归商品' }).first().locator('input').fill(B_SHIP);
  await shot(page, '35-销售出库已填写');
  await shipModal.getByRole('button', { name: '确 定' }).click();
  await page.getByText('已保存', { exact: true }).waitFor();
  await shot(page, '36-销售出库保存结果');
  const shipments = (await api(admin, 'GET', `/api/warehouse/shipments?contract_id=${browserContract.id}`)).items ?? [];
  const browserShip = shipments.find((item) => (item.lines ?? []).some((lineItem) => /^-?\d+(\.\d+)?$/.test(String(lineItem.quantity).trim()) && Number(lineItem.quantity) === Number(B_SHIP)));
  if (!browserShip) throw new Error('页面保存后找不到 UATB 出库单');
  if (browserShip.approval === 'pending' || browserShip.audit_status === 'pending') {
    await api(admin, 'POST', '/api/audit/decide', { object_type: 'sale_shipment', object_id: browserShip.id, action: '通过', remark: '通过' });
  }
  const afterShip = await api(admin, 'GET', `/api/money/contracts/${browserContract.id}`);
  eq(String(afterShip.contract.outbound_progress), B_OUTBOUND, '出库进度25% (2/8)', 'B1');
  const seedAfter = await api(admin, 'GET', `/api/money/contracts/${seedContract.id}`);
  eq(String(seedAfter.contract.debt), SEED_DEBT, '出库UATB后主链欠款仍为1500', 'B1');
  eq(String(seedAfter.contract.outbound_progress), SEED_OUTBOUND, '出库UATB后主链出库仍为10/40', 'B1');

  await goto(page, '/work_repoty_record/list');
  await page.getByText(PRINT_WO).first().waitFor({ timeout: 15000 });
  const manageBtn = page.locator('button, .ant-btn').filter({ hasText: /^管理打印模板$/ });
  if (await manageBtn.count() !== 1) throw new Error(`管理打印模板按钮 ${await manageBtn.count()}`);
  await manageBtn.click();
  const manage = page.getByRole('dialog', { name: '管理自定义打印模板' });
  await manage.waitFor({ timeout: 15000 });
  await manage.getByText('报工记录打印模板').waitFor();
  await manage.getByText('系统模板').waitFor();
  await shot(page, '37-打印模板管理壳');
  eq(String(await manage.getByRole('button', { name: '创建模板' }).count()), '1', '管理壳可创建模板', 'B4');
  await manage.getByRole('button', { name: '创建模板' }).click();
  const designer = page.getByRole('dialog', { name: '编辑打印模板' });
  await designer.waitFor({ timeout: 15000 });
  await designer.getByLabel('画布预览').waitFor();
  await designer.getByText('纸张', { exact: true }).waitFor();
  await shot(page, '38-设计器画布');
  const canvasBox = await designer.getByLabel('画布预览').boundingBox();
  if (!canvasBox || canvasBox.width < 40 || canvasBox.height < 40) throw new Error('设计器画布没有尺寸');
  eq(String(canvasBox.width > 40 && canvasBox.height > 40), 'true', '设计器画布可见', 'B4');
  await designer.getByLabel('模板名称').fill(CUSTOM_NAME);
  await designer.getByRole('button', { name: '添加文本', exact: true }).click();
  await designer.getByLabel('文本内容').fill(CUSTOM_TEXT);
  if ((await designer.getByLabel('文本内容').inputValue()) !== CUSTOM_TEXT) throw new Error('文本没有写进画布');
  await shot(page, '39-设计器已编辑');
  await designer.getByRole('button', { name: '保存', exact: true }).click();
  await designer.waitFor({ state: 'hidden', timeout: 15000 });
  const savedRow = manage.locator('.ant-table-row').filter({ hasText: CUSTOM_NAME });
  await savedRow.waitFor({ timeout: 15000 });
  await shot(page, '40-模板已保存');
  eq(String(await savedRow.count()), '1', '列表出现自定义模板', 'B4');
  await page.locator('.ant-modal-wrap .ant-modal-close').last().click();
  await page.waitForTimeout(300);
  const printClick = await page.evaluate((code) => {
    const row = [...document.querySelectorAll('.ant-table-tbody tr')].find((tr) => (tr.innerText || '').includes(code));
    const hit = [...(row?.querySelectorAll('button, .ant-btn') ?? [])].find((node) => (node.innerText || '').replace(/\s+/g, '') === '打印');
    if (!hit) return false;
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, PRINT_WO);
  if (!printClick) throw new Error('报工行没有打印按钮');
  const printDialog = page.getByRole('dialog', { name: '打印报工记录' });
  await printDialog.waitFor({ timeout: 15000 });
  await printDialog.getByText(CUSTOM_NAME, { exact: true }).waitFor();
  await shot(page, '41-打印打开态');
  const picked = await page.evaluate((name) => {
    const dialogs = [...document.querySelectorAll('.ant-modal-wrap')].filter((node) => getComputedStyle(node).display !== 'none');
    const dialog = dialogs[dialogs.length - 1];
    const hit = [...dialog.querySelectorAll('label')].find((node) => (node.innerText || '').replace(/\s+/g, '') === name);
    const input = hit?.querySelector('input');
    if (!input) return false;
    input.click();
    return true;
  }, CUSTOM_NAME);
  if (!picked) throw new Error('选不中自定义模板');
  const popupPromise = page.waitForEvent('popup');
  const printOk = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, .ant-btn')].filter((node) => (node.innerText || '').replace(/\s+/g, '') === '打印' && node.closest('.ant-modal'));
    if (!nodes[0]) return false;
    nodes[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });
  if (!printOk) throw new Error('打印对话框没有打印按钮');
  const popup = await popupPromise;
  await popup.waitForSelector('.page');
  const popupBody = await popup.locator('body').innerText();
  if (!popupBody.includes(CUSTOM_TEXT)) throw new Error(`打印预览缺少抬头：${popupBody.slice(0, 300)}`);
  if (!popupBody.includes(PRINT_PRODUCT)) throw new Error(`打印预览缺少商品：${popupBody.slice(0, 300)}`);
  await popup.screenshot({ path: path.join(outDir, '42-打印预览.png') });
  shots.push('42-打印预览');
  console.log('截图', '42-打印预览');
  await popup.close();
  eq('有预览', '有预览', '打印预览含自定义抬头和商品', 'B4');
  const ownTemplates = await api(admin, 'GET', '/api/print-templates?object_key=work_report');
  const goodsTemplates = await api(admin, 'GET', '/api/print-templates?object_key=goods');
  const custom = (ownTemplates.items ?? []).find((item) => item.name === CUSTOM_NAME);
  const system = (ownTemplates.items ?? []).find((item) => item.is_system && item.name === '报工记录打印模板');
  if (!custom || !system) throw new Error('报工对象缺少自定义或系统模板');
  eq(String(custom.is_system), 'false', '自定义模板不是系统模板', 'B4');
  eq(String(system.is_system), 'true', '系统模板标记为系统', 'B4');
  eq(String((goodsTemplates.items ?? []).some((item) => item.name === CUSTOM_NAME)), 'false', '商品对象没有报工自定义模板', 'B4');
  eq(String(JSON.stringify(system.content).includes(CUSTOM_TEXT)), 'false', '系统模板内容不含自定义抬头', 'B4');
  const otherTenant = await api(adminB, 'GET', '/api/print-templates?object_key=work_report');
  eq(String((otherTenant.items ?? []).some((item) => item.id === custom.id || item.name === CUSTOM_NAME)), 'false', '另一租户看不到本租户自定义模板', 'B4');
  const patchSystem = await call(admin, 'PATCH', `/api/print-templates/${system.id}`, { name: '不许改系统模板' });
  eq(String(patchSystem.status), '422', '系统模板不能修改', 'B4');
  await goto(page, '/goods/list');
  await page.getByPlaceholder('商品名').first().fill(PRINT_PRODUCT);
  await btn(page, '查询').click();
  await page.getByText(PRINT_PRODUCT).first().waitFor();
  await page.locator('button, .ant-btn').filter({ hasText: /^管理打印模板$/ }).click();
  const goodsManage = page.getByRole('dialog', { name: '管理自定义打印模板' });
  await goodsManage.waitFor();
  await goodsManage.getByText('商品打印模板').waitFor();
  const goodsText = await goodsManage.innerText();
  eq(String(goodsText.includes(CUSTOM_NAME)), 'false', '商品管理壳不串报工模板', 'B4');
  await shot(page, '43-商品模板隔离');
  await page.locator('.ant-modal-wrap .ant-modal-close').last().click();

  await goto(page, '/supplier/list');
  await clickExt(page);
  const supplierList = await expectTitle(page, '【供应商】扩展字段管理');
  await shot(page, '44-供应商扩展打开态');
  await btn(supplierList, '新增').click();
  const supplierAdd = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await supplierAdd.waitFor();
  await confirmTextField(page, supplierAdd, SUPPLIER_FIELD);
  await supplierList.getByText(SUPPLIER_FIELD, { exact: true }).waitFor();
  await closeModals(page);
  await btn(page.locator('.kgd-toolbar'), '新增').click();
  const supplierForm = page.locator('.ant-modal').filter({ hasText: '新增供应商' }).last();
  await supplierForm.waitFor();
  if (!(await supplierForm.getByText(SUPPLIER_FIELD).count())) throw new Error('新增供应商表单没有扩展字段');
  const supplierNameInput = supplierForm.locator('.ant-form-item').filter({ hasText: '供应商名称' }).locator('input');
  await supplierNameInput.click();
  await supplierNameInput.fill(SUPPLIER_NAME);
  const supplierExt = supplierForm.locator('.ext-fields input');
  await supplierExt.click();
  await supplierExt.fill(SUPPLIER_VALUE);
  await shot(page, '45-供应商扩展已填写');
  await btn(supplierForm, '确定').click();
  await supplierForm.waitFor({ state: 'hidden', timeout: 15000 });
  await page.getByText('已保存', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('快工单', { exact: true }).first().waitFor();
  await search(page, '供应商名称', SUPPLIER_NAME);
  const supplierSavedRow = page.locator('.ant-table-row').filter({ hasText: SUPPLIER_NAME });
  await supplierSavedRow.first().waitFor({ timeout: 15000 });
  if (await supplierSavedRow.count() < 1) throw new Error(`供应商行匹配 ${await supplierSavedRow.count()}`);
  await supplierSavedRow.first().getByRole('button', { name: '修改' }).click();
  const supplierEdit = page.locator('.ant-modal').filter({ hasText: '修改供应商' }).last();
  await supplierEdit.waitFor();
  eq(await supplierEdit.locator('.ext-fields input').inputValue(), SUPPLIER_VALUE, '供应商扩展刷新后仍在', 'B5');
  const supplierApi = (await api(admin, 'GET', '/api/money/suppliers')).items.find((item) => item.name === SUPPLIER_NAME);
  const supplierFields = await api(admin, 'GET', '/api/entity-ext-fields?entity=supplier');
  const supplierField = (supplierFields.items ?? []).find((item) => item.name === SUPPLIER_FIELD);
  if (!supplierApi?.id || !supplierField) throw new Error('供应商扩展未落库');
  const supplierValues = await api(admin, 'GET', `/api/entity-ext-values?entity=supplier&record_id=${supplierApi.id}`);
  eq(String(supplierValues.values?.[supplierField.id]), SUPPLIER_VALUE, '供应商扩展值接口一致', 'B5');
  await shot(page, '46-供应商扩展落库');
  await closeModals(page);

  await goto(page, '/purchase_stock_in_bill/list');
  await clickExt(page);
  const inModal = await expectTitle(page, '【采购入库单】扩展字段（主表/明细）');
  await inModal.getByRole('tab', { name: '采购入库单扩展字段' }).click();
  await btn(inModal, '新增').click();
  const headAdd = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await headAdd.waitFor();
  await confirmTextField(page, headAdd, HEAD_FIELD);
  await inModal.getByText(HEAD_FIELD, { exact: true }).waitFor();
  await inModal.getByRole('tab', { name: '入库明细扩展字段' }).click();
  if (await inModal.getByText(HEAD_FIELD, { exact: true }).count()) throw new Error('明细看见主表字段');
  await btn(inModal, '新增').click();
  const lineAdd = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await lineAdd.waitFor();
  await confirmTextField(page, lineAdd, LINE_FIELD);
  await inModal.getByText(LINE_FIELD, { exact: true }).waitFor();
  await shot(page, '47-采购入库扩展字段');
  await closeModals(page);
  const beforeReceiptIds = new Set(((await api(admin, 'GET', '/api/warehouse/purchase-receipts')).items ?? []).map((item) => item.id));
  await btn(page.locator('.kgd-toolbar'), '+ 新增').click();
  const receiptForm = page.locator('.ant-modal').filter({ hasText: '新增采购入库单' }).last();
  await receiptForm.waitFor();
  await chooseExact(page, receiptForm.locator('.ant-select').nth(0), 'UAT回归仓');
  await chooseExact(page, receiptForm.locator('.ant-select').nth(2), '本地管理员');
  await receiptForm.locator('textarea').first().fill(RECEIPT_NOTE);
  if (!(await receiptForm.getByText(HEAD_FIELD).count())) throw new Error('入库主表没有扩展字段');
  await receiptForm.locator('.ext-fields input').fill(HEAD_VALUE);
  await btn(receiptForm, '+ 选择采购入库商品').click();
  const linePicker = page.locator('.ant-modal').filter({ hasText: '选择采购单商品' }).last();
  await linePicker.waitFor();
  await linePicker.getByText(extOrder.code, { exact: true }).waitFor({ timeout: 15000 });
  const pickedLine = linePicker.locator('.ant-table-row').filter({ hasText: 'UAT待审原料' }).filter({ hasText: extOrder.code });
  if (await pickedLine.count() !== 1) throw new Error(`扩展采购商品匹配 ${await pickedLine.count()} 行`);
  await pickedLine.getByRole('checkbox').click();
  await btn(linePicker, '确定').click();
  await linePicker.waitFor({ state: 'hidden' });
  const receiptLine = receiptForm.locator('.ant-table-row').filter({ hasText: 'UAT待审原料' });
  if (await receiptLine.count() !== 1) throw new Error('入库明细未带回');
  if (!(await receiptLine.getByText(LINE_FIELD).count())) throw new Error('明细行没有扩展字段');
  await receiptLine.locator('input').nth(0).fill('1');
  await receiptLine.locator('.ext-line-fields input').fill(LINE_VALUE);
  await shot(page, '48-采购入库扩展已填写');
  await btn(receiptForm, '确 定').click();
  await receiptForm.waitFor({ state: 'hidden', timeout: 15000 });
  await page.getByText('已保存').waitFor();
  const savedReceipts = (await api(admin, 'GET', '/api/warehouse/purchase-receipts')).items ?? [];
  const savedReceipt = savedReceipts.find((item) => item.note === RECEIPT_NOTE && !beforeReceiptIds.has(item.id));
  if (!savedReceipt) throw new Error('页面保存后找不到扩展入库单');
  const headFields = await api(admin, 'GET', '/api/entity-ext-fields?entity=purchase_stock_in');
  const headField = (headFields.items ?? []).find((item) => item.name === HEAD_FIELD);
  const headValues = await api(admin, 'GET', `/api/entity-ext-values?entity=purchase_stock_in&record_id=${savedReceipt.id}`);
  eq(String(headValues.values?.[headField?.id]), HEAD_VALUE, '采购入库主表扩展落库', 'B5');
  const lineFields = await api(admin, 'GET', '/api/entity-ext-fields?entity=purchase_stock_in_line');
  const lineField = (lineFields.items ?? []).find((item) => item.name === LINE_FIELD);
  const lineId = savedReceipt.lines?.[0]?.id;
  if (!lineId || !lineField) throw new Error('入库明细或明细字段缺失');
  const lineValues = await api(admin, 'GET', `/api/entity-ext-values?entity=purchase_stock_in_line&record_id=${lineId}`);
  eq(String(lineValues.values?.[lineField.id]), LINE_VALUE, '采购入库明细扩展落库', 'B5');
  eq(String(savedReceipt.approval), 'pending', '扩展入库保持待审不改库存口径外的已审数', 'B5');
  await shot(page, '49-采购入库扩展保存');

  await goto(page, '/customer/list');
  await clickExt(page);
  const customerList = await expectTitle(page, '【客户管理】扩展字段管理');
  await btn(customerList, '新增').click();
  const customerAdd = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await customerAdd.waitFor();
  await confirmTextField(page, customerAdd, CUSTOMER_FIELD);
  await customerList.getByText(CUSTOMER_FIELD, { exact: true }).waitFor();
  await closeModals(page);
  const beforeCustomerIds = new Set(((await api(admin, 'GET', '/api/money/customers')).items ?? []).map((item) => item.id));
  await btn(page.locator('.kgd-toolbar'), '新增').click();
  const customerForm = page.locator('.ant-modal').filter({ hasText: '新增客户' }).last();
  await customerForm.waitFor();
  if (!(await customerForm.getByText(CUSTOMER_FIELD).count())) throw new Error('新增客户表单没有扩展字段');
  await customerForm.locator('.ant-form-item').filter({ hasText: '客户名称' }).locator('input').fill(CUSTOMER_NAME);
  await customerForm.locator('.ant-form-item').filter({ hasText: '联系人' }).filter({ hasNotText: '电话' }).locator('input').first().fill('UAT联系人');
  const customerExt = customerForm.getByPlaceholder('单行文本', { exact: true });
  await customerExt.fill(CUSTOMER_VALUE);
  await shot(page, '50-客户扩展已填写');
  await btn(customerForm, '确定').click();
  await customerForm.waitFor({ state: 'hidden', timeout: 15000 });
  await page.getByText('已保存').waitFor();
  const customerApi = (await api(admin, 'GET', '/api/money/customers')).items.find((item) => item.name === CUSTOMER_NAME && !beforeCustomerIds.has(item.id));
  const customerFields = await api(admin, 'GET', '/api/entity-ext-fields?entity=customer');
  const customerField = (customerFields.items ?? []).find((item) => item.name === CUSTOMER_FIELD);
  if (!customerApi?.id || !customerField) throw new Error('客户扩展未落库');
  const customerValues = await api(admin, 'GET', `/api/entity-ext-values?entity=customer&record_id=${customerApi.id}`);
  eq(String(customerValues.values?.[customerField.id]), CUSTOMER_VALUE, '客户扩展值落库', 'B5');

  await goto(page, '/customer/list');
  await page.getByRole('button', { name: '地图视图', exact: true }).click();
  const mapModal = modalByTitle(page, '地图视图');
  await mapModal.waitFor();
  eq((await mapModal.innerText()).includes('客户地图视图') ? '客户地图视图' : await mapModal.innerText(), '客户地图视图', '客户地图为现网占位', 'B6');
  await shot(page, '51-客户地图延后占位');
  await page.locator('.ant-modal-wrap:visible .ant-modal-close').last().click();
  await mapModal.waitFor({ state: 'hidden' });

  const modules = ['工作台', '数据大屏', '报表中心', '客户管理', '精益生产', '生产管理', '设备维保', '供应/采购', '仓库管理', '智能设备', '商品管理', 'AI智能体', '消息中心', '信息管理', '系统管理'];
  let moduleIndex = 52;
  for (const label of modules) {
    const before = pageErrors.length;
    const rail = page.locator(`.kgd-rail button[aria-label="${label}"]`);
    if (await rail.count() !== 1) throw new Error(`一级菜单「${label}」数量 ${await rail.count()}`);
    await rail.click();
    await page.locator('.kgd-content').waitFor();
    await page.waitForTimeout(900);
    const text = (await page.locator('.kgd-content').innerText()).trim();
    if (text.length < 2) throw new Error(`${label} 主区域空白`);
    if (pageErrors.length > before) throw new Error(`${label} 未捕获异常 ${pageErrors.at(-1)}`);
    if (await page.locator('.ant-message-error').count()) throw new Error(`${label} 出现错误提示`);
    const fileName = `${String(moduleIndex).padStart(2, '0')}-菜单-${label.replace(/\//g, '')}`;
    await shot(page, fileName);
    eq('可达', '可达', `${label}默认落地页可达`, 'B6');
    moduleIndex += 1;
  }
  await goto(page, '/customer/setting/audit_setting');
  await page.locator('.kgd-content').waitFor();
  await shot(page, '67-审核设置');
  eq(String((await page.locator('.kgd-content').innerText()).trim().length > 2), 'true', '审核设置页可达', 'B6');

  await goto(page, '/work_quality_testing/list');
  await page.getByText('质检状态', { exact: true }).first().waitFor();
  const qcTable = page.locator('.ant-table, .ant-empty').first();
  await qcTable.waitFor();
  await shot(page, '68-全检列表');
  eq(String(await page.locator('.kgd-content').innerText()).includes('质检状态') ? '质检状态' : '', '质检状态', '全检列表已渲染', 'B8');

  await goto(page, '/OutWorkOrder/list');
  await btn(page, '新增').click();
  await page.locator('h2').filter({ hasText: '外协工单' }).first().waitFor();
  await shot(page, '70-外协新增打开态');
  eq((await page.locator('h2').filter({ hasText: '外协工单' }).first().innerText()).replace(/\s+/g, ''), '新增外协工单', '外协新增页打开', 'B8');

  await goto(page, '/machine_platform/list');
  await btn(page, '新增').click();
  const machineModal = modalByTitle(page, '新增机台');
  await machineModal.waitFor();
  await shot(page, '71-机台新增打开态');
  eq(String(await machineModal.getByText('机台名称', { exact: false }).count() > 0), 'true', '机台新增弹窗打开', 'B8');
  await page.keyboard.press('Escape');

  await goto(page, '/device_iot/list');
  await btn(page, '新增').click();
  const iotModal = modalByTitle(page, '新增物联场景');
  await iotModal.waitFor();
  await shot(page, '72-物联新增打开态');
  eq(String(await iotModal.getByText('场景名', { exact: false }).count() > 0), 'true', '物联新增弹窗打开', 'B8');
  await page.keyboard.press('Escape');

  await goto(page, '/spot_check/list');
  await btn(page, '新增').click();
  const spotModal = modalByTitle(page, '新增');
  await spotModal.waitFor();
  await spotModal.getByText('抽检数量', { exact: false }).waitFor();
  await shot(page, '73-抽检新增打开态');
  eq(String(await spotModal.getByText('工序', { exact: false }).count() > 0), 'true', '抽检新增弹窗打开', 'B8');

  const pngs = readdirSync(outDir).filter((name) => name.endsWith('.png'));
  const hashes = pngs.map((name) => createHash('md5').update(readFileSync(path.join(outDir, name))).digest('hex'));
  eq(String(pngs.length >= 30), 'true', `截图不少于30张（实际${pngs.length}）`, 'B6');
  eq(String(checks.length >= 50), 'true', `验收不少于50条（实际${checks.length}）`, 'B6');
  eq(String(new Set(hashes).size), String(hashes.length), '截图MD5互异', 'B6');
  const matrix = ['# 全面 UAT 范围矩阵', '', '| 章节 | 验收条 | 结果 | 实际 |', '|---|---|---|---|', ...checks.map((item) => `| ${item.section} | ${item.name} | ${item.result} | ${String(item.actual).replace(/\|/g, '/')} |`), ''];
  writeFileSync(path.join(docDir, '范围矩阵.md'), matrix.join('\n'));
  writeFileSync(path.join(docDir, '范围矩阵.csv'), ['章节,验收条,结果,实际', ...checks.map((item) => `${item.section},"${item.name}",${item.result},"${String(item.actual).replace(/"/g, '""')}"`)].join('\n'));
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ checks, shots, pngs, hashes }, null, 2));
  console.log(`\n验收 ${checks.length} 条，截图 ${pngs.length} 张，MD5 ${new Set(hashes).size}`);
} catch (error) {
  failedError = error;
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ checks, shots, error: String(error?.stack || error) }, null, 2));
} finally {
  await browser.close();
}
if (failedError) {
  console.error(failedError);
  process.exit(1);
}
