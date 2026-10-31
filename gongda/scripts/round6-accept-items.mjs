/**
 * 第六轮补验收：浏览器逐条操作并截图。
 * 前置：npm run dev && node scripts/seed-round6-demo-a.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/round6');
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const key = () => crypto.randomUUID();
const log = {};
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

async function loginApi() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!json.csrf_token) throw new Error(`login failed ${JSON.stringify(json).slice(0, 200)}`);
  return { csrf: json.csrf_token, cookie };
}
async function api(session, method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: session.cookie, ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${urlPath} ${res.status}: ${text.slice(0, 500)}`);
  return json;
}
async function focusWo(page, code) {
  await page.goto(`${WEB}/inside_produce_bill/list`);
  await page.waitForTimeout(500);
  const box = page.getByPlaceholder('加工单号');
  await box.fill(code);
  await byBtn(page, '查询').click();
  await page.waitForTimeout(700);
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  console.log('saved', name);
}
async function loginWeb(page) {
  await page.goto(`${WEB}/login`);
  await page.waitForTimeout(600);
  if (!page.url().includes('/login')) return;
  await page.waitForSelector('input');
  const inputs = page.locator('input');
  await inputs.nth(0).fill('demo-a');
  await inputs.nth(1).fill('admin.local');
  await inputs.nth(2).fill(pass);
  await page.getByRole('button', { name: /登\s*录\s*工\s*作\s*空\s*间/ }).click();
  await page.waitForTimeout(1500);
}
async function fillReport(page, good, defect, note) {
  const dialog = page.locator('.ant-modal').last();
  await dialog.waitFor({ state: 'visible' });
  // 理由：报工表单含开始/结束 datetime-local，nth(2) 会误填时间框；按标签定位良品/不良/备注
  const field = (label) => dialog.locator('.kgd-form span').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::input[1]');
  await field('良品数').fill(String(good));
  if (defect != null) await field('不良品数').fill(String(defect));
  if (note != null && note !== '') await field('备注').fill(String(note));
  await byBtn(dialog, '仅报工').click();
  await page.waitForTimeout(600);
  if (await dialog.isVisible()) {
    const err = await dialog.locator('.kgd-banner').textContent().catch(() => '');
    if (err?.trim()) throw new Error(`报工失败：${err.trim()}`);
  }
  await dialog.waitFor({ state: 'hidden', timeout: 10000 });
}
function byBtn(scope, label) {
  return scope.getByRole('button', { name: new RegExp(`^\\s*${label.split('').join('\\s*')}\\s*$`) });
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const session = await loginApi();
  const flows = await api(session, 'GET', '/api/warehouse/audit-flows');
  for (const flow of flows.items ?? []) {
    if (flow.object_type === 'fg_receipt' && flow.enabled) {
      await api(session, 'PATCH', `/api/warehouse/audit-flows/${flow.id}`, { enabled: false });
    }
  }
  const products = await api(session, 'GET', '/api/products?page=1&page_size=100');
  const product = products.items.find((item) => item.code === 'CSFM-A');
  if (!product) throw new Error('缺少商品 CSFM-A，请先跑 seed');
  const me = await api(session, 'GET', '/api/auth/me');
  const processItems = (await api(session, 'GET', '/api/processes')).items;
  const processes = ['下料', '焊接', '喷涂'].map((name) => processItems.find((item) => item.name === name)).filter(Boolean);
  for (const proc of processes) {
    const ids = (proc.reporter_ids ?? []).map(String);
    if (!ids.includes(String(me.user.id))) {
      await api(session, 'PATCH', `/api/processes/${proc.id}`, {
        version: proc.version, name: proc.name, description: proc.description ?? '', standard_minutes: String(proc.standard_minutes),
        reporter_ids: [...ids, me.user.id], active: proc.active !== false, pricing_mode: proc.pricing_mode ?? 'piece', wage_rate: proc.wage_rate, inspection_scheme: proc.inspection_scheme ?? 'none',
      });
    }
  }
  if (processes.length < 3) throw new Error('缺少下料/焊接/喷涂');
  const wh = (await api(session, 'GET', '/api/warehouses')).items[0];
  const tasks = processes.map((item) => ({ process_id: item.id, unit_ratio: '1', wage_rate: '0' }));
  const monthStart = `${day(0).slice(0, 8)}01`;
  const planName = `阀门投产验收${day(0).replace(/-/g, '')}${Date.now().toString().slice(-4)}`;
  const plan = (await api(session, 'POST', '/api/production-plans', { request_key: key(), name: planName })).plan;
  await api(session, 'PATCH', `/api/production-plans/${plan.id}`, {
    lines: [{ product_id: product.id, plan_qty: '100', contract_code: 'HT-DEMO', customer_name: '演示客户' }],
  });

  async function makeWo(code, qty, extra = {}) {
    const body = await api(session, 'POST', '/api/work-orders', {
      request_key: key(), product_id: product.id, quantity: qty, warehouse_id: wh.id, code,
      tasks, planned_start: monthStart, planned_end: day(10), priority: 'normal', ...extra,
    });
    return body.work_order;
  }
  const flowCode = `JG-FLOW-${Date.now().toString().slice(-6)}`;
  const lateCode = `JG-LATE-${Date.now().toString().slice(-6)}`;
  const flow = await makeWo(flowCode, '100');
  const late = await makeWo(lateCode, '50', { planned_end: day(-1), due_date: day(1), priority: 'normal' });
  log.flow = flowCode;
  log.late = lateCode;
  log.plan = planName;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await loginWeb(page);

  await page.goto(`${WEB}/ProductionPlan/list`);
  await page.getByPlaceholder('计划名称').fill(planName);
  await byBtn(page, '查询').click();
  await page.waitForTimeout(800);
  const planRow = page.locator('tr', { hasText: planName }).first();
  await byBtn(planRow, '物料分析').click();
  await page.waitForTimeout(1000);
  await shot(page, 'v03a-analyzed');

  await page.goto(`${WEB}/ProductionPlan/detail/${plan.id}`);
  await page.waitForTimeout(800);
  for (const [label, file] of [['商品明细', 'v02a-lines'], ['物料分析', 'v02b-analysis'], ['加工单', 'v02c-workorders'], ['外协工单', 'v02d-outsource'], ['采购单', 'v02e-purchase']]) {
    await page.getByRole('tab', { name: label }).click();
    await page.waitForTimeout(400);
    await shot(page, file);
  }
  await page.goto(`${WEB}/ProductionPlan/add?id=${plan.id}`);
  await page.waitForTimeout(800);
  await shot(page, 'v02f-edit-plan');

  async function release(qty) {
    await page.goto(`${WEB}/ProductionPlan/detail/${plan.id}`);
    await page.waitForTimeout(600);
    await page.getByRole('tab', { name: '物料分析' }).click();
    await byBtn(page, '创建加工单').click();
    await page.waitForTimeout(800);
    const qtyInput = page.locator('.kgd-form span', { hasText: '计划数' }).locator('xpath=following-sibling::input[1]');
    await qtyInput.fill(String(qty));
    await page.getByRole('tab', { name: '生产任务' }).click();
    await byBtn(page, '从工序中添加').click();
    const modal = page.locator('.ant-modal').last();
    for (const name of ['下料', '焊接', '喷涂']) {
      await modal.locator('tr', { hasText: name }).locator('.ant-checkbox').click();
    }
    await byBtn(modal, '确定').click();
    await page.waitForTimeout(300);
    await byBtn(page, '创建加工单').last().click();
    await page.waitForTimeout(1200);
    const banner = page.locator('.kgd-banner');
    if (await banner.count()) {
      const text = await banner.first().textContent();
      if (text?.trim()) throw new Error(`创建加工单失败：${text.trim()}`);
    }
  }
  await release(60);
  await page.goto(`${WEB}/ProductionPlan/list`);
  await page.getByPlaceholder('计划名称').fill(planName);
  await byBtn(page, '查询').click();
  await page.waitForTimeout(800);
  await shot(page, 'v03b-progress-60');
  await release(40);
  await page.goto(`${WEB}/ProductionPlan/list`);
  await page.getByPlaceholder('计划名称').fill(planName);
  await byBtn(page, '查询').click();
  await page.waitForTimeout(800);
  await shot(page, 'v03c-progress-100');

  await focusWo(page, flowCode);
  const flowRow = page.locator('tr', { hasText: flowCode }).first();
  await flowRow.scrollIntoViewIfNeeded();
  await flowRow.locator('.kgd-ring-node').first().hover();
  await page.waitForTimeout(500);
  await shot(page, 'v04-rings-zero');
  await byBtn(flowRow, '更多').click();
  // 理由：更多菜单文案为「开始」（非「开始生产」），与 WorkOrderExtras moreMenuItems 对齐
  await page.getByRole('menuitem', { name: /^\s*开\s*始\s*$/ }).click();
  await page.waitForTimeout(800);

  // 理由：第十轮起 data-screens 以 menu_name 标识，不再写 preset=control；按中文名匹配并 HTTP 补种缺失大屏
  const screenSpecs = [
    ['control', '生产中控大屏', '默认', '生产模块'],
    ['workshop', '车间大屏', '四模块', '生产模块'],
    ['wo-progress', '加工单生产进度', '单模块', '生产模块'],
    ['defect', '不良品统计大屏', '左右双模块', '生产模块'],
    ['machine', '机台实时状态', '单模块', '生产模块'],
  ];
  let screens = (await api(session, 'GET', '/api/data-screens')).items ?? [];
  const findScreen = (preset, menuName) => screens.find((item) => item.preset === preset || item.preset_key === preset || item.menu_name === menuName || item.name === menuName);
  for (const [preset, menuName, layout, module_kind] of screenSpecs) {
    if (!findScreen(preset, menuName)) {
      await api(session, 'POST', '/api/data-screens', { menu_name: menuName, layout, module_kind, description: '-', access_password: '' });
      screens = (await api(session, 'GET', '/api/data-screens')).items ?? [];
    }
  }
  const control = findScreen('control', '生产中控大屏');
  if (!control) throw new Error('缺少生产中控大屏，请先 seed data-screens');
  const screen = await context.newPage();
  await loginWeb(screen);
  const before = await api(session, 'GET', `/api/progress/screen-data/${control.id}?pwd=${control.access_password ?? ''}`);
  log.screenBefore100 = before.cards;
  await screen.goto(`${WEB}/_screen/pd/${control.id}?pwd=${control.access_password ?? ''}`);
  await screen.waitForTimeout(1500);
  await shot(screen, 'v05-screen-before');

  await page.goto(`${WEB}/inside_produce_bill/detail/${flow.id}`);
  await page.waitForTimeout(800);
  await byBtn(page, '报工').first().click();
  await fillReport(page, 100, '0', '');
  await focusWo(page, flowCode);
  await shot(page, 'v05-after-report-33');
  await page.locator('tr', { hasText: flowCode }).locator('.kgd-ring-node').first().hover();
  await page.waitForTimeout(400);
  await shot(page, 'v05-hover-100');

  const expected100 = String(Number(String(before.cards.today_reports).replace(/[^\d.]/g, '')) + 100);
  await screen.waitForFunction((needle) => document.body.innerText.includes(needle), expected100, { timeout: 45000 });
  await screen.waitForTimeout(500);
  await shot(screen, 'v05-screen-after-100');
  const mid = await api(session, 'GET', `/api/progress/screen-data/${control.id}?pwd=${control.access_password ?? ''}`);
  log.screenAfter100 = mid.cards;

  let view = (await api(session, 'GET', `/api/work-orders/${flow.id}`)).work_order;
  const weld = view.tasks.find((task) => task.process_name === '焊接');
  await api(session, 'POST', `/api/work-orders/${flow.id}/tasks/${weld.id}/actions`, { action: 'start', version: weld.version });
  await page.goto(`${WEB}/inside_produce_bill/detail/${flow.id}`);
  await page.waitForTimeout(800);
  await byBtn(page.locator('tr', { hasText: '焊接' }), '报工').click();
  await fillReport(page, 50, 5, '焊接不良');
  await focusWo(page, flowCode);
  await shot(page, 'v06-weld-defect');
  const afterDefect = await api(session, 'GET', `/api/progress/screen-data/${control.id}?pwd=${control.access_password ?? ''}`);
  log.screenAfterDefect = afterDefect.cards;
  await screen.reload();
  await screen.waitForTimeout(1500);
  await shot(screen, 'v06-screen-defect-rate');

  view = (await api(session, 'GET', `/api/work-orders/${flow.id}`)).work_order;
  const weld3 = view.tasks.find((task) => task.process_name === '焊接');
  if (weld3.execution !== 'completed') {
    await api(session, 'POST', '/api/production-reports', { request_key: key(), task_id: weld3.id, good_qty: '50', defect_qty: '0', rework_qty: '0', scrap_qty: '0' });
  }
  view = (await api(session, 'GET', `/api/work-orders/${flow.id}`)).work_order;
  const paint = view.tasks.find((task) => task.process_name === '喷涂');
  if (paint.execution !== 'running' && paint.execution !== 'completed') {
    await api(session, 'POST', `/api/work-orders/${flow.id}/tasks/${paint.id}/actions`, { action: 'start', version: paint.version });
  }
  view = (await api(session, 'GET', `/api/work-orders/${flow.id}`)).work_order;
  const paint2 = view.tasks.find((task) => task.process_name === '喷涂');
  await api(session, 'POST', '/api/production-reports', { request_key: key(), task_id: paint2.id, good_qty: '100', defect_qty: '0', rework_qty: '0', scrap_qty: '0' });
  await api(session, 'POST', '/api/warehouse/fg-receipts', { request_key: key(), work_order_id: flow.id, quantity: '70' });
  await focusWo(page, flowCode);
  await shot(page, 'v07a-inbound-70');
  await api(session, 'POST', '/api/warehouse/fg-receipts', { request_key: key(), work_order_id: flow.id, quantity: '30' });
  await focusWo(page, flowCode);
  await shot(page, 'v07b-inbound-100');
  await screen.reload();
  await screen.waitForTimeout(1200);
  await shot(screen, 'v07c-completed-today');

  await page.getByPlaceholder('加工单号').fill(lateCode);
  await byBtn(page, '查询').click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /已逾期/ }).click();
  await page.waitForTimeout(700);
  await shot(page, 'v09a-overdue-orders');
  await page.goto(`${WEB}/productionTask/list`);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /已逾期/ }).click();
  await page.waitForTimeout(700);
  await shot(page, 'v09b-overdue-tasks');
  await page.goto(`${WEB}/ProductionScheduling/list`);
  await page.waitForTimeout(1200);
  await shot(page, 'v09c-scheduling-overdue');
  await screen.reload();
  await screen.waitForTimeout(1200);
  await shot(screen, 'v09d-screen-overdue');

  await focusWo(page, lateCode);
  await shot(page, 'v10a-countdown-before');
  await page.goto(`${WEB}/inside_produce_bill/detail/${late.id}`);
  await page.waitForTimeout(700);
  await byBtn(page, '修改').first().click();
  const edit = page.locator('.ant-modal').last();
  await edit.getByText('修改').waitFor();
  await edit.locator('.ant-select').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: '加急' }).first().click();
  // 理由：交货日期是 ant DatePicker，无 native input[type=date]；按标签填 YYYY-MM-DD
  const dueInput = edit.locator('.kgd-form span').filter({ hasText: /^交货日期$/ }).locator('xpath=following-sibling::*[1]//input');
  await dueInput.click();
  await dueInput.fill(day(20));
  await page.keyboard.press('Enter');
  await shot(page, 'v10b-priority-edit');
  await byBtn(edit, '确定').click();
  await page.waitForTimeout(800);
  await focusWo(page, lateCode);
  await page.getByRole('button', { name: /加急/ }).click();
  await page.waitForTimeout(500);
  await shot(page, 'v10c-urgent-countdown');

  await page.goto(`${WEB}/inside_produce_bill/detail/${late.id}`);
  await page.waitForTimeout(600);
  await byBtn(page, '修改').first().click();
  const edit2 = page.locator('.ant-modal').last();
  await edit2.getByText('修改').waitFor();
  const dueInput2 = edit2.locator('.kgd-form span').filter({ hasText: /^交货日期$/ }).locator('xpath=following-sibling::*[1]//input');
  await dueInput2.click();
  await dueInput2.fill(day(1));
  await page.keyboard.press('Enter');
  await byBtn(edit2, '确定').click();
  await page.waitForTimeout(700);
  await page.goto(`${WEB}/inside_produce_bill/list`);
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /已逾期/ }).click();
  await page.waitForTimeout(600);
  await shot(page, 'v09e-overdue-restored');

  await page.goto(`${WEB}/inside_produce_bill/detail/${flow.id}`);
  await page.waitForTimeout(900);
  await shot(page, 'v11-detail-progress');

  await page.getByRole('button', { name: '报表中心' }).click();
  await page.waitForTimeout(600);
  for (const label of ['生产管理', '质量管理', '维保管理', '经营报表', '人力薪酬']) {
    const btn = page.locator('.kgd-sub').getByRole('button', { name: label });
    if (await btn.count()) await btn.click();
  }
  await page.waitForTimeout(300);
  await shot(page, 'v16-menu');
  await page.goto(`${WEB}/drilling_crew_statement/list`);
  await page.waitForTimeout(600);
  await shot(page, 'v16a-machine-report');
  await page.goto(`${WEB}/clock_in_report`);
  await page.waitForTimeout(600);
  await shot(page, 'v16b-clock-report');
  await page.goto(`${WEB}/waste_analysis`);
  await page.waitForTimeout(500);
  await shot(page, 'v16c-quality-later');
  await page.goto(`${WEB}/payroll_statement/list`);
  await page.waitForTimeout(800);
  await shot(page, 'v16d-wage-report');

  const before10 = await api(session, 'GET', `/api/progress/screen-data/${control.id}?pwd=${control.access_password ?? ''}`);
  log.screenBefore10 = before10.cards;
  await shot(screen, 'v18a-control-before');
  view = (await api(session, 'GET', `/api/work-orders/${late.id}`)).work_order;
  if (view.execution === 'not_started') view = (await api(session, 'POST', `/api/work-orders/${late.id}/actions`, { action: 'start', version: view.version })).work_order;
  const lateTask = view.tasks[0];
  if (lateTask.execution !== 'running' && lateTask.execution !== 'completed') {
    await api(session, 'POST', `/api/work-orders/${late.id}/tasks/${lateTask.id}/actions`, { action: 'start', version: lateTask.version });
  }
  view = (await api(session, 'GET', `/api/work-orders/${late.id}`)).work_order;
  const lateRunning = view.tasks.find((task) => task.execution === 'running') ?? view.tasks[0];
  await api(session, 'POST', '/api/production-reports', { request_key: key(), task_id: lateRunning.id, good_qty: '10', defect_qty: '0', rework_qty: '0', scrap_qty: '0' });
  const expected10 = String(Number(String(before10.cards.today_reports).replace(/[^\d.]/g, '')) + 10);
  await screen.waitForFunction((needle) => document.body.innerText.includes(needle), expected10, { timeout: 45000 });
  await screen.waitForTimeout(400);
  await shot(screen, 'v18b-control-after-30s');
  const after10 = await api(session, 'GET', `/api/progress/screen-data/${control.id}?pwd=${control.access_password ?? ''}`);
  log.screenAfter10 = after10.cards;
  log.expected10 = expected10;
  log.expected100 = expected100;

  for (const [preset, file] of [['workshop', 'v19a-workshop'], ['wo-progress', 'v19b-wo-progress'], ['defect', 'v19c-defect'], ['machine', 'v19d-machine']]) {
    const menuName = screenSpecs.find((row) => row[0] === preset)?.[1];
    const row = findScreen(preset, menuName);
    if (!row) throw new Error(`缺少大屏 ${preset}/${menuName}`);
    await screen.goto(`${WEB}/_screen/pd/${row.id}?pwd=${row.access_password ?? ''}`);
    await screen.waitForTimeout(1200);
    await shot(screen, file);
  }
  const woProgress = findScreen('wo-progress', '加工单生产进度');
  await screen.goto(`${WEB}/_screen/pd/${woProgress.id}?pwd=${woProgress.access_password ?? ''}`);
  await screen.waitForTimeout(800);
  await screen.getByPlaceholder('请输入工单编号/产品名/编号/规格').fill(lateCode);
  await screen.waitForTimeout(400);
  await shot(screen, 'v19b-search-late');

  await page.goto(`${WEB}/work_repoty_record/list`);
  await page.waitForTimeout(1000);
  await shot(page, 'r01-wage-750-regression');
  await page.goto(`${WEB}/customer_contract/list`);
  await page.waitForTimeout(1000);
  await shot(page, 'r02-contract-debt-9000');
  await page.getByRole('button', { name: '供应/采购' }).click().catch(() => {});
  await page.goto(`${WEB}/produce_plan/list`);
  await page.waitForTimeout(800);
  await shot(page, 'v20-purchase-plan-menu');

  writeFileSync(path.join(outDir, 'accept-log.json'), JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log, null, 2));
  await browser.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
