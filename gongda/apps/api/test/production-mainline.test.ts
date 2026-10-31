import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { frozenRouteVersionId, reusableSales, reusableWorkOrder } from '../../../scripts/sample-mainline.mjs';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database, app: FastifyInstance;
const ta = randomUUID(), tb = randomUUID();
const admin = randomUUID(), planner = randomUUID(), worker = randomUUID();
const unit = randomUUID();
const password = 'Mainline-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login, b: Login, p: Login, w: Login;
let loginSequence = 1;
const headers = (s: Login, write = false) => ({ cookie: s.cookie, ...(write ? { 'x-csrf-token': s.csrf } : {}) });
const code = (prefix: string) => prefix + '-' + randomUUID().slice(0, 8);
const key = () => randomUUID();

async function login(slug: string, name = 'line.admin') {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.' + (loginSequence++ % 200), payload: { tenant_slug: slug, username: name, password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  assert.ok(raw);
  return { cookie: (Array.isArray(raw) ? raw[0]! : raw).split(';')[0]!, csrf: response.json().csrf_token };
}
async function get(url: string, s = a, expected = 200) {
  const response = await app.inject({ url, headers: headers(s) });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function post(url: string, body: unknown, s = a, expected = 201) {
  const response = await app.inject({ method: 'POST', url, headers: headers(s, true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function patch(url: string, body: unknown, s = a, expected = 200) {
  const response = await app.inject({ method: 'PATCH', url, headers: headers(s, true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function act(url: string, body: unknown, s = a, expected = 200) {
  return post(url, body, s, expected);
}

let fg: { id: string; code: string; name: string }, steel: { id: string }, caster: { id: string }, board: { id: string };
let routeVersionId = '', bomVersionId = '', bomId = '', customerId = '', firstProcess = '';

async function warehouse() {
  return (await post('/api/warehouses', { request_key: key(), code: code('WH'), name: '测试仓' })).warehouse as { id: string };
}
async function customer() {
  return (await post('/api/customers', { request_key: key(), code: code('CU'), name: '测试客户' })).customer as { id: string; version: number };
}
async function openSales(quantity: string, price = '40') {
  const created = await post('/api/sales-orders', { request_key: key(), customer_id: customerId, lines: [{ product_id: fg.id, quantity, unit_price: price }] });
  const submitted = await act('/api/sales-orders/' + created.order.id + '/actions', { action: 'submit', version: created.order.version });
  return (await act('/api/sales-orders/' + created.order.id + '/actions', { action: 'approve', version: submitted.order.version })).order;
}
async function makeWo(lineId: string, quantity: string, wh: string, extra: Record<string, unknown> = {}) {
  return (await post('/api/work-orders', { request_key: key(), sales_line_id: lineId, quantity, route_version_id: routeVersionId, bom_version_id: bomVersionId, warehouse_id: wh, ...extra })).work_order;
}
async function stockIn(wh: string, productId: string, quantity: string, reason = '期初入库，不是采购收货') {
  const created = await post('/api/stock-adjustments', { request_key: key(), warehouse_id: wh, product_id: productId, direction: 'in', quantity, reason });
  return (await act('/api/stock-adjustments/' + created.stock_adjustment.id + '/actions', { action: 'approve', version: created.stock_adjustment.version, request_key: key() })).stock_adjustment;
}
async function issue(wo: { id: string; warehouse_id: string; materials: { id: string; required_qty: string }[] }, lines?: { material_id: string; quantity: string }[]) {
  const created = await post('/api/material-issues', { request_key: key(), work_order_id: wo.id, warehouse_id: wo.warehouse_id, lines: lines ?? wo.materials.map((row) => ({ material_id: row.id, quantity: row.required_qty })) });
  return created.material_issue as { id: string; version: number; approval: string; posted: boolean };
}
async function approveIssue(row: { id: string; version: number }) {
  return (await act('/api/material-issues/' + row.id + '/actions', { action: 'approve', version: row.version, request_key: key() })).material_issue;
}
async function onHand(wh: string, productId: string) {
  const found = (await get('/api/stock/balances')).items.find((row: { warehouse_id: string; product_id: string; on_hand: string }) => row.warehouse_id === wh && row.product_id === productId);
  return found?.on_hand ?? '0.000000';
}
async function reload(id: string) {
  return (await get('/api/work-orders/' + id)).work_order;
}
async function reportGood(taskId: string, quantity: string, session = a, extra: Record<string, unknown> = {}) {
  const body = { request_key: key(), task_id: taskId, good_qty: quantity, defect_qty: '0', rework_qty: '0', scrap_qty: '0', ...extra };
  if (session === a && body.operator_id === undefined) body.operator_id = worker;
  return post('/api/production-reports', body, session);
}
async function approveReport(id: string, version = 1) {
  return (await act('/api/production-reports/' + id + '/actions', { action: 'approve', version, request_key: key() })).report;
}
async function member(id: string) {
  return (await get('/api/platform/members')).items.find((row: { id: string }) => row.id === id);
}
async function updateMember(id: string, extra: Record<string, unknown>) {
  const old = await member(id);
  return patch('/api/platform/members/' + id, { version: old.version, display_name: old.display_name, role: old.role, active: old.active, department_id: old.department_id, custom_role_id: old.custom_role_id, ...extra });
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    for (const [id, slug] of [[ta, 'line-a'], [tb, 'line-b']]) await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [id, slug, slug]);
    for (const [id, name] of [[admin, 'line.admin'], [planner, 'line.planner'], [worker, 'line.worker']]) await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [id, name, name, hash]);
    for (const tenant of [ta, tb]) await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'planner')", [ta, planner]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')", [ta, worker]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','个')", [unit, ta]);
  });
  app = await createApp(db, { localEventsWorker: false });
  a = await login('line-a'); b = await login('line-b'); p = await login('line-a', 'line.planner'); w = await login('line-a', 'line.worker');
  fg = (await post('/api/products', { code: code('FG'), name: '机架成品', unit_id: unit, attribute: 'manufactured' })).product;
  steel = (await post('/api/products', { code: code('ST'), name: '钢板', unit_id: unit, attribute: 'purchased' })).product;
  caster = (await post('/api/products', { code: code('CA'), name: '脚轮', unit_id: unit, attribute: 'purchased' })).product;
  board = (await post('/api/products', { code: code('BD'), name: '板材', unit_id: unit, attribute: 'purchased' })).product;
  const processes = [];
  for (const name of ['下料', '焊接', '打磨', '总检']) processes.push((await post('/api/processes', { code: code('GX'), name, description: '主线测试', standard_minutes: '2.5', reporter_ids: [worker] })).process);
  firstProcess = processes[0].id;
  const route = (await post('/api/routes', { code: code('RT'), name: '四序主线', description: '串行', steps: processes.map((row) => ({ process_id: row.id, auto_inbound: row.id === processes[3].id })) })).route;
  routeVersionId = route.current_version_id;
  const bom = (await post('/api/boms', { parent_product_id: fg.id, description: '50件样例', route_version_id: routeVersionId, items: [
    { component_product_id: steel.id, quantity: '1.03', loss_rate: '0', feeding_process_id: firstProcess },
    { component_product_id: caster.id, quantity: '2', loss_rate: '0' },
    { component_product_id: board.id, quantity: '1', loss_rate: '0' },
  ] })).bom;
  bomId = bom.id; bomVersionId = bom.current_version_id;
  customerId = (await customer()).id;
});
after(async () => { await app?.close(); await db?.close(); });

test('未开工加工单不能通过暂停再恢复绕过备料与显式开工', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('1');
  const wo = await makeWo(sales.lines[0].id, '1', wh);
  const result = await act(`/api/work-orders/${wo.id}/actions`, { action: 'pause', version: wo.version, reason: '尝试绕开开工门禁' }, a, 409);
  assert.equal(result.error.code, 'STATE_TRANSITION');
  const unchanged = await reload(wo.id);
  assert.equal(unchanged.execution, 'not_started');
  assert.ok(unchanged.materials.every((row: { issued_qty: string }) => row.issued_qty === '0.000000'));
});

test('任务手工暂停期间不能报工，恢复后足量报工立即完成且不自动开始下一道', async () => {
  const { wo } = await readyWork();
  const task = wo.tasks[0];
  await act(`/api/work-orders/${wo.id}/tasks/${task.id}/actions`, { action: 'pause', version: task.version, reason: '等待确认' });
  const blocked = await post('/api/production-reports', { request_key: key(), task_id: task.id, operator_id: worker, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0' }, a, 409);
  assert.equal(blocked.error.code, 'STATE_TRANSITION');
  const paused = await reload(wo.id);
  assert.equal(paused.tasks[0].execution, 'paused');
  const resumed = (await act(`/api/work-orders/${wo.id}/tasks/${task.id}/actions`, { action: 'resume', version: paused.tasks[0].version })).work_order;
  assert.equal(resumed.tasks[0].execution, 'running');
  await reportGood(task.id, '1');
  const done = await reload(wo.id);
  assert.equal(done.tasks[0].execution, 'completed');
  assert.equal(done.tasks[1].execution, 'not_started');
});

test('整单暂停期间审核足量报工，恢复后不会卡在已足量的运行任务', async () => {
  const { wo } = await readyWork();
  const submitted = await reportGood(wo.tasks[0].id, '1');
  await act(`/api/work-orders/${wo.id}/actions`, { action: 'pause', version: (await reload(wo.id)).version, reason: '等待确认' });
  await approveReport(submitted.report.id, submitted.report.version);
  const paused = await reload(wo.id);
  const resumed = (await act(`/api/work-orders/${wo.id}/actions`, { action: 'resume', version: paused.version })).work_order;
  assert.equal(resumed.tasks[0].execution, 'completed');
  assert.equal(resumed.tasks[1].execution, 'not_started');
});

test('发货草稿建立后订单强制关闭，审核重新检查来源且不扣库存', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('2');
  await stockIn(wh, fg.id, '2');
  const shipment = (await post('/api/shipments', { request_key: key(), sales_order_id: sales.id, warehouse_id: wh, lines: [{ sales_line_id: sales.lines[0].id, quantity: '1' }] })).shipment;
  await act(`/api/sales-orders/${sales.id}/actions`, { action: 'force_close', version: sales.version, reason: '客户终止剩余履约' });
  const result = await act(`/api/shipments/${shipment.id}/actions`, { action: 'approve', version: shipment.version }, a, 409);
  assert.equal(result.error.code, 'SALES_ORDER_NOT_OPEN');
  assert.equal(await onHand(wh, fg.id), '2.000000');
  assert.equal((await get(`/api/sales-orders/${sales.id}`)).order.lines[0].shipped_qty, '0.000000');
});

test('已履约关闭的销售订单不能直接冲销发货造成关闭状态和未发数量矛盾', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('1');
  await stockIn(wh, fg.id, '1');
  const shipment = (await post('/api/shipments', { request_key: key(), sales_order_id: sales.id, warehouse_id: wh, lines: [{ sales_line_id: sales.lines[0].id, quantity: '1' }] })).shipment;
  const approved = (await act(`/api/shipments/${shipment.id}/actions`, { action: 'approve', version: shipment.version })).shipment;
  const current = (await get(`/api/sales-orders/${sales.id}`)).order;
  await act(`/api/sales-orders/${sales.id}/actions`, { action: 'close', version: current.version });
  const result = await act(`/api/shipments/${shipment.id}/actions`, { action: 'reverse', version: approved.version, reason: '需先处理关闭来源' }, a, 409);
  assert.equal(result.error.code, 'DOWNSTREAM_EXISTS');
  assert.equal(await onHand(wh, fg.id), '0.000000');
});

test('加工单已开工且已有待审或已审报工，领料不能冲销返库制造无料产出', async () => {
  const { wo, wh, materialIssue } = await readyWork();
  const submitted = await reportGood(wo.tasks[0].id, '1');
  for (const state of ['pending', 'approved']) {
    if (state === 'approved') await approveReport(submitted.report.id, submitted.report.version);
    const result = await act(`/api/material-issues/${materialIssue.id}/actions`, { action: 'reverse', version: materialIssue.version, reason: '材料已经使用' }, a, 409);
    assert.equal(result.error.code, 'DOWNSTREAM_EXISTS');
    assert.equal(await onHand(wh, steel.id), '0.000000');
  }
});

test('未开工领料可带原因冲销，反向流水关联原流水且重试不重复返库', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('1');
  const wo = await makeWo(sales.lines[0].id, '1', wh);
  for (const row of wo.materials) await stockIn(wh, row.product_id, row.required_qty);
  const materialIssue = await approveIssue(await issue(wo));
  const command = { action: 'reverse', version: materialIssue.version, reason: '开工前纠正领料', request_key: key() };
  await act(`/api/material-issues/${materialIssue.id}/actions`, command);
  assert.equal((await act(`/api/material-issues/${materialIssue.id}/actions`, command)).replayed, true);
  assert.equal(await onHand(wh, steel.id), '1.030000');
  const ledger = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ id: string; direction: string; reversal_of: string | null }>('SELECT id,direction,reversal_of FROM stock_ledger WHERE source_type=$1 AND source_id=$2 AND product_id=$3', ['material_issue', materialIssue.id, steel.id]));
  assert.equal(ledger.rows.length, 2);
  assert.equal(ledger.rows.find((row) => row.direction === 'in')!.reversal_of, ledger.rows.find((row) => row.direction === 'out')!.id);
});

test('没有末道审核产出的加工单不能凭手填数创建真实成品检验', async () => {
  const { wo } = await readyWork();
  const result = await post('/api/inspections', { request_key: key(), work_order_id: wo.id, inspected_qty: '1', good_qty: '1', defect_qty: '0' }, a, 422);
  assert.equal(result.error.code, 'OVER_INSPECTION');
});

test('待检与已完成检验共同占用实际产出，不能重复送检累加放行', async () => {
  const { wo } = await readyWork('3', true);
  await finishReports(wo);
  const inspection = (await post('/api/inspections', { request_key: key(), work_order_id: wo.id, inspected_qty: '2', good_qty: '2', defect_qty: '0' })).inspection;
  const duplicate = { request_key: key(), work_order_id: wo.id, inspected_qty: '2', good_qty: '2', defect_qty: '0' };
  assert.equal((await post('/api/inspections', duplicate, a, 422)).error.code, 'OVER_INSPECTION');
  await act(`/api/inspections/${inspection.id}/actions`, { action: 'complete', version: inspection.version, conclusion: 'pass' });
  assert.equal((await post('/api/inspections', { ...duplicate, request_key: key() }, a, 422)).error.code, 'OVER_INSPECTION');
  const receipt = (await post('/api/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '3' })).fg_receipt;
  assert.equal((await act(`/api/fg-receipts/${receipt.id}/actions`, { action: 'approve', version: receipt.version }, a, 422)).error.code, 'QUALITY_REQUIRED');
});

test('成品检验已有来源数量时不能冲销末道报工留下无来源的放行', async () => {
  const { wo } = await readyWork('1', true);
  await finishReports(wo);
  const reports = (await get(`/api/production-reports?work_order_id=${wo.id}`)).items;
  const last = reports.find((row: { task_id: string }) => row.task_id === wo.tasks[3].id);
  await post('/api/inspections', { request_key: key(), work_order_id: wo.id, inspected_qty: '1', good_qty: '1', defect_qty: '0' });
  const result = await act(`/api/production-reports/${last.id}/actions`, { action: 'reverse', version: last.version, reason: '先处理成品检验' }, a, 409);
  assert.equal(result.error.code, 'DOWNSTREAM_EXISTS');
  assert.equal((await reload(wo.id)).output_qty, '1.000000');
});

test('超计划报工直接生效，引用不存在的追加投入仍然拒绝', async () => {
  const { wo } = await readyWork();
  const missing = await post('/api/production-reports', { request_key: key(), task_id: wo.tasks[0].id, operator_id: worker, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0', supplement_id: '00000000-0000-4000-8000-000000000099' }, a, 422);
  assert.equal(missing.error.code, 'SUPPLEMENT_SOURCE_REQUIRED');
  const over = await post('/api/production-reports', { request_key: key(), task_id: wo.tasks[0].id, operator_id: worker, good_qty: '2', defect_qty: '0', rework_qty: '0', scrap_qty: '0', supplement: true });
  assert.equal(over.report.approval, 'approved');
  assert.equal(over.report.good_qty, '2.000000');
  assert.equal((await reload(wo.id)).tasks[0].approved_good, '2.000000');
});

test('单位关系重复序号不能静默取最后一条，也不能占用销售已排数量', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('1');
  const result = await post('/api/work-orders', { request_key: key(), sales_line_id: sales.lines[0].id, quantity: '1', route_version_id: routeVersionId, bom_version_id: bomVersionId, warehouse_id: wh, unit_ratios: [{ sequence: 1, unit_ratio: '1' }, { sequence: 1, unit_ratio: '2' }] }, a, 422);
  assert.equal(result.error.code, 'DUPLICATE_UNIT_RATIO');
  assert.equal((await get(`/api/sales-orders/${sales.id}`)).order.lines[0].scheduled_qty, '0.000000');
});

test('库存冲销必须说明原因，反向流水保留原事件引用', async () => {
  const wh = (await warehouse()).id;
  const adjustment = await stockIn(wh, fg.id, '1');
  const url = `/api/stock-adjustments/${adjustment.id}/actions`;
  assert.equal((await act(url, { action: 'reverse', version: adjustment.version }, a, 422)).error.code, 'REASON_REQUIRED');
  await act(url, { action: 'reverse', version: adjustment.version, reason: '纠正期初录入' });
  const ledger = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ id: string; direction: string; reversal_of: string | null }>('SELECT id,direction,reversal_of FROM stock_ledger WHERE source_id=$1', [adjustment.id]));
  assert.equal(ledger.rows.find((row) => row.direction === 'out')!.reversal_of, ledger.rows.find((row) => row.direction === 'in')!.id);
});

test('已审计库存流水或命令幂等记录被放宽为可改列时启动安全检查拒绝', async () => {
  for (const table of ['stock_ledger', 'command_replays']) {
    const column = table === 'stock_ledger' ? 'event_key' : 'payload_hash';
    await db.admin((sql) => sql.exec(`GRANT UPDATE (${column}) ON ${table} TO gd_tenant`));
    try { await assert.rejects(() => db.assertSecurityConfiguration(), /只追加/); }
    finally { await db.admin((sql) => sql.exec(`REVOKE UPDATE (${column}) ON ${table} FROM gd_tenant`)); }
  }
  await db.assertSecurityConfiguration();
});

async function readyWork(quantity = '1', inspection = false) {
  const wh = (await warehouse()).id;
  const sales = await openSales(quantity);
  const wo = await makeWo(sales.lines[0].id, quantity, wh, { requires_fg_inspection: inspection });
  for (const row of wo.materials) await stockIn(wh, row.product_id, row.required_qty);
  const materialIssue = await approveIssue(await issue(wo));
  const started = (await act(`/api/work-orders/${wo.id}/actions`, { action: 'start', version: (await reload(wo.id)).version })).work_order;
  return { wh, sales, wo: started, materialIssue };
}

for (const fixture of [{ label: 'BOM', table: 'bom_definitions', id: () => bomId }, { label: '路线', table: 'process_routes', id: async () => (await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ route_id: string }>('SELECT route_id FROM route_versions WHERE id=$1', [routeVersionId]))).rows[0]!.route_id }, { label: '工序', table: 'processes', id: () => firstProcess }]) {
  test(`停用${fixture.label}拒绝新加工单，但已有冻结加工单仍可读取`, async () => {
    const wh = (await warehouse()).id;
    const sales = await openSales('2');
    const old = await makeWo(sales.lines[0].id, '1', wh);
    const resourceId = await fixture.id();
    await db.admin((sql) => sql.query(`UPDATE ${fixture.table} SET active=false WHERE id=$1`, [resourceId]));
    try {
      const result = await post('/api/work-orders', { request_key: key(), sales_line_id: sales.lines[0].id, quantity: '1', route_version_id: routeVersionId, bom_version_id: bomVersionId, warehouse_id: wh }, a, 422);
      assert.equal(result.error.code, 'INACTIVE_REFERENCE');
      assert.equal((await reload(old.id)).route_version_id, routeVersionId);
      assert.equal((await get(`/api/sales-orders/${sales.id}`)).order.lines[0].scheduled_qty, '1.000000');
    } finally { await db.admin((sql) => sql.query(`UPDATE ${fixture.table} SET active=true WHERE id=$1`, [resourceId])); }
  });
}
async function finishReports(wo: { id: string }, quantities?: string[]) {
  let current = await reload(wo.id);
  let index = 0;
  while (current.tasks.some((task: { execution: string }) => !['completed', 'cancelled'].includes(task.execution))) {
    let task = current.tasks.find((row: { execution: string }) => row.execution === 'running');
    if (!task) {
      const next = current.tasks.find((row: { execution: string }) => row.execution === 'not_started');
      if (!next) break;
      current = (await act(`/api/work-orders/${current.id}/tasks/${next.id}/actions`, { action: 'start', version: next.version })).work_order;
      task = current.tasks.find((row: { id: string }) => row.id === next.id);
    }
    const submitted = await reportGood(task.id, quantities?.[index] ?? task.plan_qty);
    index += 1;
    await approveReport(submitted.report.id, submitted.report.version);
    current = await reload(wo.id);
  }
  return current;
}

test('发货与成品入库按反向顺序冲销，保留来源关联、原因与幂等且恢复数量', async () => {
  const { wo, wh, sales } = await readyWork();
  await finishReports(wo);
  const draft = (await post('/api/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '1' })).fg_receipt;
  const receipt = (await act(`/api/fg-receipts/${draft.id}/actions`, { action: 'approve', version: draft.version })).fg_receipt;
  const shipping = (await post('/api/shipments', { request_key: key(), sales_order_id: sales.id, warehouse_id: wh, lines: [{ sales_line_id: sales.lines[0].id, quantity: '1' }] })).shipment;
  const shipment = (await act(`/api/shipments/${shipping.id}/actions`, { action: 'approve', version: shipping.version })).shipment;
  const receiptUrl = `/api/fg-receipts/${receipt.id}/actions`;
  const shipmentUrl = `/api/shipments/${shipment.id}/actions`;
  assert.equal((await act(receiptUrl, { action: 'reverse', version: receipt.version }, a, 422)).error.code, 'REASON_REQUIRED');
  assert.equal((await act(shipmentUrl, { action: 'reverse', version: shipment.version }, a, 422)).error.code, 'REASON_REQUIRED');
  assert.equal((await act(receiptUrl, { action: 'reverse', version: receipt.version, reason: '成品已发出，必须先退回' }, a, 409)).error.code, 'INSUFFICIENT_STOCK');
  const reverseShipment = { action: 'reverse', version: shipment.version, reason: '发货录入更正', request_key: key() };
  await act(shipmentUrl, reverseShipment);
  assert.equal((await act(shipmentUrl, reverseShipment)).replayed, true);
  assert.equal(await onHand(wh, fg.id), '1.000000');
  assert.equal((await get(`/api/sales-orders/${sales.id}`)).order.lines[0].shipped_qty, '0.000000');
  const reverseReceipt = { action: 'reverse', version: receipt.version, reason: '更正原成品入库', request_key: key() };
  await act(receiptUrl, reverseReceipt);
  assert.equal((await act(receiptUrl, reverseReceipt)).replayed, true);
  assert.equal(await onHand(wh, fg.id), '0.000000');
  for (const [type, sourceId, originalDirection, reason] of [['shipment', shipment.id, 'out', reverseShipment.reason], ['fg_receipt', receipt.id, 'in', reverseReceipt.reason]]) {
    const ledger = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ id: string; direction: string; reversal_of: string | null }>('SELECT id,direction,reversal_of FROM stock_ledger WHERE source_type=$1 AND source_id=$2', [type, sourceId]));
    assert.equal(ledger.rows.length, 2);
    assert.equal(ledger.rows.find((row) => row.direction !== originalDirection)!.reversal_of, ledger.rows.find((row) => row.direction === originalDirection)!.id);
    const audit = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ after_data: { action_reason: string } }>('SELECT after_data FROM audit_events WHERE entity_id=$1 AND action=$2', [sourceId, `${type}.reverse`]));
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]!.after_data.action_reason, reason);
  }
});

test('50件主线从销售冻结到领料报工入库分批发货，快照不随后续主数据变化', async () => {
  const wh = (await warehouse()).id;
  await stockIn(wh, steel.id, '51.5'); await stockIn(wh, caster.id, '100'); await stockIn(wh, board.id, '50');
  const draft = await post('/api/sales-orders', { request_key: key(), customer_id: customerId, promised_date: '2026-10-31', lines: [{ product_id: fg.id, quantity: '50', unit_price: '40' }] });
  assert.equal(draft.order.lifecycle, 'draft'); assert.equal(draft.order.approval, 'unsubmitted'); assert.equal(draft.order.effective, false); assert.equal(draft.order.persisted, true);
  assert.equal(draft.order.lines[0].extended_amount, '2000.00'); assert.equal(draft.order.lines[0].product_name, '机架成品');
  const submitted = await act('/api/sales-orders/' + draft.order.id + '/actions', { action: 'submit', version: draft.order.version });
  assert.equal(submitted.order.lifecycle, 'draft'); assert.equal(submitted.order.approval, 'pending');
  const sales = (await act('/api/sales-orders/' + draft.order.id + '/actions', { action: 'approve', version: submitted.order.version, request_key: key() })).order;
  assert.equal(sales.lifecycle, 'open'); assert.equal(sales.approval, 'approved'); assert.equal(sales.effective, true);
  const wo = await makeWo(sales.lines[0].id, '50', wh);
  assert.equal(wo.execution, 'not_started'); assert.equal(wo.wage_status, 'unpriced'); assert.equal(wo.cost_status, 'unpriced'); assert.equal(wo.auto_inbound_executed, false);
  assert.equal(wo.product_snapshot.name, '机架成品'); assert.equal(wo.bom_version_id, bomVersionId); assert.equal(wo.route_version_id, routeVersionId);
  const byProduct = Object.fromEntries(wo.materials.map((row: { product_id: string; required_qty: string; feeding_task_id: string | null }) => [row.product_id, row]));
  assert.equal(byProduct[steel.id].required_qty, '51.500000'); assert.equal(byProduct[caster.id].required_qty, '100.000000'); assert.equal(byProduct[board.id].required_qty, '50.000000');
  assert.equal(byProduct[steel.id].feeding_task_id, wo.tasks[0].id); assert.equal(wo.tasks.length, 4); assert.equal(wo.tasks[3].is_output, true); assert.equal(wo.tasks[0].plan_qty, '50.000000');
  const started = await act('/api/work-orders/' + wo.id + '/actions', { action: 'start', version: wo.version });
  assert.equal(started.work_order.execution, 'running'); assert.equal(started.work_order.tasks[0].execution, 'running'); assert.equal(started.work_order.tasks[1].execution, 'not_started');
  const postedIssue = await approveIssue(await issue(wo));
  assert.equal(postedIssue.posted, true); assert.equal(await onHand(wh, steel.id), '0.000000'); assert.equal(await onHand(wh, caster.id), '0.000000'); assert.equal(await onHand(wh, board.id), '0.000000');
  let current = started.work_order;
  for (let index = 0; index < 4; index++) {
    if (current.tasks[index].execution === 'not_started') current = (await act(`/api/work-orders/${wo.id}/tasks/${current.tasks[index].id}/actions`, { action: 'start', version: current.tasks[index].version })).work_order;
    const task = current.tasks[index];
    assert.equal(task.execution, 'running');
    const submittedReport = await reportGood(task.id, '50');
    assert.equal(submittedReport.report.posted, true); assert.equal(submittedReport.report.estimated_wage, null); assert.equal(submittedReport.report.wage_status, 'unpriced');
    const approved = await approveReport(submittedReport.report.id, submittedReport.report.version);
    assert.equal(approved.posted, true); assert.equal(approved.operator_id, worker); assert.notEqual(approved.reporter_id, worker);
    current = await reload(wo.id);
    assert.equal(current.tasks[index].execution, 'completed'); assert.equal(current.tasks[index].approved_good, '50.000000');
  }
  assert.equal(current.execution, 'completed'); assert.equal(current.output_qty, '50.000000'); assert.equal(current.received_qty, '0.000000');
  const receipt = await post('/api/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '50' });
  const postedReceipt = await act('/api/fg-receipts/' + receipt.fg_receipt.id + '/actions', { action: 'approve', version: receipt.fg_receipt.version, request_key: key() });
  assert.equal(postedReceipt.fg_receipt.posted, true); assert.equal(await onHand(wh, fg.id), '50.000000');
  const extra = await post('/api/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '1' });
  const over = await act('/api/fg-receipts/' + extra.fg_receipt.id + '/actions', { action: 'approve', version: extra.fg_receipt.version }, a, 422);
  assert.equal(over.error.code, 'OVER_RECEIPT'); assert.equal(await onHand(wh, fg.id), '50.000000');
  const firstShip = await post('/api/shipments', { request_key: key(), sales_order_id: sales.id, warehouse_id: wh, lines: [{ sales_line_id: sales.lines[0].id, quantity: '20' }] });
  await act('/api/shipments/' + firstShip.shipment.id + '/actions', { action: 'approve', version: firstShip.shipment.version, request_key: key() });
  assert.equal(await onHand(wh, fg.id), '30.000000');
  const secondShip = await post('/api/shipments', { request_key: key(), sales_order_id: sales.id, warehouse_id: wh, lines: [{ sales_line_id: sales.lines[0].id, quantity: '30' }] });
  await act('/api/shipments/' + secondShip.shipment.id + '/actions', { action: 'approve', version: secondShip.shipment.version, request_key: key() });
  assert.equal(await onHand(wh, fg.id), '0.000000');
  const overShip = await post('/api/shipments', { request_key: key(), sales_order_id: sales.id, warehouse_id: wh, lines: [{ sales_line_id: sales.lines[0].id, quantity: '1' }] }, a, 422);
  assert.equal(overShip.error.code, 'OVER_SHIP');
  const freshSales = await get('/api/sales-orders/' + sales.id);
  const closed = await act('/api/sales-orders/' + sales.id + '/actions', { action: 'close', version: freshSales.order.version });
  assert.equal(closed.order.lifecycle, 'closed'); assert.equal(closed.order.lines[0].shipped_qty, '50.000000');
  const ledger = await get('/api/stock/ledger');
  assert.equal(ledger.append_only, true);
  const mine = ledger.items.filter((row: { warehouse_id: string }) => row.warehouse_id === wh);
  assert.equal(mine.filter((row: { source_type: string; direction: string }) => row.source_type === 'adjustment' && row.direction === 'in').length, 3);
  assert.equal(mine.filter((row: { source_type: string; direction: string }) => row.source_type === 'material_issue' && row.direction === 'out').length, 3);
  assert.equal(mine.filter((row: { source_type: string }) => row.source_type === 'fg_receipt').length, 1);
  assert.equal(mine.filter((row: { source_type: string }) => row.source_type === 'shipment').length, 2);
  await patch('/api/products/' + fg.id, { version: fg.version ?? 1, name: '改名后的成品', specification: '', unit_id: unit, attribute: 'manufactured', active: true });
  await post('/api/boms/' + bomId + '/versions', { expected_version: 1, description: '新用量', route_version_id: routeVersionId, items: [
    { component_product_id: steel.id, quantity: '1.10', loss_rate: '0', feeding_process_id: firstProcess },
    { component_product_id: caster.id, quantity: '2', loss_rate: '0' },
    { component_product_id: board.id, quantity: '1', loss_rate: '0' },
  ] });
  const frozen = await reload(wo.id);
  assert.equal(frozen.product_snapshot.name, '机架成品');
  assert.equal(frozen.materials.find((row: { product_id: string }) => row.product_id === steel.id).required_qty, '51.500000');
  const salesAfter = await get('/api/sales-orders/' + sales.id);
  assert.equal(salesAfter.order.lines[0].product_name, '机架成品');
  const balances = await get('/api/stock/balances');
  assert.equal(balances.negative_stock_allowed, false);
  fg = { ...fg, name: '改名后的成品', version: 2 };
});

test('同一请求标识重复提交只落一单，内容不同则冲突；审核重复只过账一次', async () => {
  const body = { request_key: key(), customer_id: customerId, lines: [{ product_id: fg.id, quantity: '3', unit_price: '10' }] };
  const first = await post('/api/sales-orders', body);
  const second = await post('/api/sales-orders', body, a, 200);
  const third = await post('/api/sales-orders', body, a, 200);
  assert.equal(second.replayed, true); assert.equal(third.replayed, true); assert.equal(second.order.id, first.order.id); assert.equal(third.order.id, first.order.id);
  const conflict = await post('/api/sales-orders', { ...body, lines: [{ product_id: fg.id, quantity: '4', unit_price: '10' }] }, a, 409);
  assert.equal(conflict.error.code, 'REQUEST_KEY_CONFLICT');
  const rows = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ n: string }>('SELECT count(*)::text AS n FROM sales_orders WHERE id=$1', [first.order.id]));
  assert.equal(rows.rows[0]!.n, '1');
  const wh = (await warehouse()).id;
  const created = await post('/api/stock-adjustments', { request_key: key(), warehouse_id: wh, product_id: steel.id, direction: 'in', quantity: '5', reason: '幂等过账' });
  const approveKey = key();
  const approved = await act('/api/stock-adjustments/' + created.stock_adjustment.id + '/actions', { action: 'approve', version: 1, request_key: approveKey });
  const replay = await act('/api/stock-adjustments/' + created.stock_adjustment.id + '/actions', { action: 'approve', version: 1, request_key: approveKey });
  await act('/api/stock-adjustments/' + created.stock_adjustment.id + '/actions', { action: 'approve', version: 1, request_key: approveKey });
  assert.equal(approved.replayed, false); assert.equal(replay.replayed, true); assert.equal(await onHand(wh, steel.id), '5.000000');
  const ledger = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ n: string }>('SELECT count(*)::text AS n FROM stock_ledger WHERE event_key=$1', ['adjustment:' + created.stock_adjustment.id]));
  assert.equal(ledger.rows[0]!.n, '1');
});

test('客户并发修改只有一次成功，失败方得到版本冲突', async () => {
  const row = await customer();
  const results = await Promise.all([1, 2].map((n) => app.inject({ method: 'PATCH', url: '/api/customers/' + row.id, headers: headers(a, true), payload: { version: 1, name: '并发客户' + n, active: true } })));
  assert.deepEqual(results.map((item) => item.statusCode).sort(), [200, 409]);
  const failed = results.find((item) => item.statusCode === 409)!;
  assert.equal(failed.json().error.code, 'VERSION_CONFLICT');
  const events = (await get('/api/audit-events')).items.filter((event: { entity_id: string; action: string }) => event.entity_id === row.id && event.action === 'customer.updated');
  assert.equal(events.length, 1);
});

test('跨企业不能读改销售单，流水不可改，库存余额不能写成负数', async () => {
  const sales = await openSales('2', '8');
  assert.equal((await get('/api/sales-orders/' + sales.id, b, 404)).error.code, 'SALES_ORDER_NOT_FOUND');
  const hidden = await db.tenant({ tenantId: tb, userId: admin }, (sql) => sql.query('SELECT id FROM sales_orders WHERE id=$1', [sales.id]));
  assert.equal(hidden.rows.length, 0);
  const untouched = await db.tenant({ tenantId: tb, userId: admin }, (sql) => sql.query("UPDATE sales_orders SET note='越权' WHERE id=$1 RETURNING id", [sales.id]));
  assert.equal(untouched.rows.length, 0);
  await assert.rejects(db.tenant({ tenantId: tb, userId: admin }, (sql) => sql.query('INSERT INTO sales_orders(tenant_id,code,customer_id,created_by) VALUES($1,$2,$3,$4)', [ta, code('SO'), customerId, admin])), /row-level security/i);
  await assert.rejects(db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query('UPDATE stock_ledger SET quantity=1')), /permission denied/i);
  await assert.rejects(db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query('DELETE FROM stock_ledger')), /permission denied/i);
  const wh = (await warehouse()).id;
  await stockIn(wh, board.id, '1');
  await assert.rejects(db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query('UPDATE stock_balances SET on_hand=-1 WHERE warehouse_id=$1 AND product_id=$2', [wh, board.id])), /check constraint|on_hand/i);
  assert.equal(await onHand(wh, board.id), '1.000000');
});

test('员工不能开销售或过账库存，计划员不能冒充报工，代报和补产受权限约束，部门范围不能进业务接口', async () => {
  const deniedSales = await post('/api/sales-orders', { request_key: key(), customer_id: customerId, lines: [{ product_id: fg.id, quantity: '1', unit_price: '1' }] }, w, 403);
  assert.equal(deniedSales.error.code, 'FORBIDDEN');
  const wh = (await warehouse()).id;
  const adjustment = await post('/api/stock-adjustments', { request_key: key(), warehouse_id: wh, product_id: board.id, direction: 'in', quantity: '1', reason: '权限探针' });
  const deniedPost = await act('/api/stock-adjustments/' + adjustment.stock_adjustment.id + '/actions', { action: 'approve', version: 1 }, w, 403);
  assert.equal(deniedPost.error.code, 'FORBIDDEN');
  await act('/api/stock-adjustments/' + adjustment.stock_adjustment.id + '/actions', { action: 'reject', version: 1 });
  const sales = await openSales('6');
  const wo = await makeWo(sales.lines[0].id, '6', wh);
  for (const row of wo.materials) await stockIn(wh, row.product_id, row.required_qty);
  await approveIssue(await issue(wo));
  const started = await act('/api/work-orders/' + wo.id + '/actions', { action: 'start', version: (await reload(wo.id)).version });
  const taskId = started.work_order.tasks[0].id;
  const plannerReport = await post('/api/production-reports', { request_key: key(), task_id: taskId, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0' }, p, 403);
  assert.equal(plannerReport.error.code, 'PROCESS_QUALIFICATION');
  const adminSelf = await post('/api/production-reports', { request_key: key(), task_id: taskId, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0' }, a, 403);
  assert.equal(adminSelf.error.code, 'PROCESS_QUALIFICATION');
  const own = await post('/api/production-reports', { request_key: key(), task_id: taskId, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0' }, w);
  assert.equal(own.report.operator_id, worker); assert.equal(own.report.reporter_id, worker);
  const proxy = await reportGood(taskId, '1');
  assert.equal(proxy.report.operator_id, worker); assert.equal(proxy.report.reporter_id, admin);
  const supplement = await post('/api/production-reports', { request_key: key(), task_id: taskId, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0', supplement: true }, w, 403);
  assert.equal(supplement.error.code, 'SUPPLEMENT_FORBIDDEN');
  const mismatch = await post('/api/platform/roles', { code: code('ROLE'), name: '部门销售', permissions: ['sales.read'], data_scope: 'department' }, a, 422);
  assert.equal(mismatch.error.code, 'SCOPE_PERMISSION_MISMATCH');
  const department = (await post('/api/platform/departments', { code: code('DEP'), name: '范围部门' })).department;
  const scoped = (await post('/api/platform/roles', { code: code('ROLE'), name: '仅产品', permissions: ['master.read', 'configuration.read'], data_scope: 'department' })).role;
  try {
    await updateMember(worker, { custom_role_id: scoped.id, department_id: department.id });
    w = await login('line-a', 'line.worker');
    const blocked = await get('/api/sales-orders', w, 403);
    assert.equal(blocked.error.code, 'DATA_SCOPE_UNSUPPORTED');
    await get('/api/work-orders', w, 403);
  } finally {
    await updateMember(worker, { custom_role_id: null, department_id: null });
    w = await login('line-a', 'line.worker');
  }
});

test('两张领料同时过账时库存不会被扣成负数', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('20');
  const wo = await makeWo(sales.lines[0].id, '20', wh);
  const material = wo.materials.find((row: { product_id: string }) => row.product_id === steel.id);
  assert.equal(material.required_qty, '20.600000');
  await stockIn(wh, steel.id, '10');
  const first = await issue(wo, [{ material_id: material.id, quantity: '8' }]);
  const second = await issue(wo, [{ material_id: material.id, quantity: '8' }]);
  const results = await Promise.all([first, second].map((row) => app.inject({ method: 'POST', url: '/api/material-issues/' + row.id + '/actions', headers: headers(a, true), payload: { action: 'approve', version: row.version, request_key: key() } })));
  assert.deepEqual(results.map((item) => item.statusCode).sort(), [200, 409]);
  assert.equal(results.find((item) => item.statusCode === 409)!.json().error.code, 'INSUFFICIENT_STOCK');
  assert.equal(await onHand(wh, steel.id), '2.000000');
  const approvals = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ approval: string }>('SELECT approval FROM material_issues WHERE id=ANY($1::uuid[]) ORDER BY approval', [[first.id, second.id]]));
  assert.deepEqual(approvals.rows.map((row) => row.approval), ['approved', 'pending']);
  const ledger = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ n: string }>("SELECT count(*)::text AS n FROM stock_ledger WHERE warehouse_id=$1 AND product_id=$2 AND source_type='material_issue'", [wh, steel.id]));
  assert.equal(ledger.rows[0]!.n, '1');
});

test('报工数量守恒：空报工、超不良处置、超计划和未审核都不增加已审良品', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('10');
  const wo = await makeWo(sales.lines[0].id, '10', wh);
  for (const row of wo.materials) await stockIn(wh, row.product_id, row.required_qty);
  await approveIssue(await issue(wo));
  const started = await act('/api/work-orders/' + wo.id + '/actions', { action: 'start', version: (await reload(wo.id)).version });
  const taskId = started.work_order.tasks[0].id;
  assert.equal((await post('/api/production-reports', { request_key: key(), task_id: taskId, operator_id: worker, good_qty: '0', defect_qty: '0', rework_qty: '0', scrap_qty: '0' }, a, 422)).error.code, 'EMPTY_REPORT');
  assert.equal((await post('/api/production-reports', { request_key: key(), task_id: taskId, operator_id: worker, good_qty: '0', defect_qty: '2', rework_qty: '2', scrap_qty: '1' }, a, 422)).error.code, 'DISPOSITION_EXCEEDS_DEFECT');
  const defect = await post('/api/production-reports', { request_key: key(), task_id: taskId, operator_id: worker, good_qty: '0', defect_qty: '4', rework_qty: '1', scrap_qty: '1', defect_note: '焊缝不良' });
  let current = await reload(wo.id);
  assert.equal(defect.report.posted, true); assert.equal(defect.report.disposition_pending, '2.000000');
  assert.equal(current.tasks[0].approved_good, '0.000000'); assert.equal(current.tasks[0].approved_defect, '4.000000'); assert.equal(current.tasks[0].execution, 'running');
  const noted = await post('/api/production-reports', { request_key: key(), task_id: taskId, operator_id: worker, good_qty: '0', defect_qty: '1', rework_qty: '0', scrap_qty: '0' });
  assert.equal(noted.report.approval, 'approved'); assert.equal(noted.report.defect_note, '');
  const pending = await reportGood(taskId, '3');
  current = await reload(wo.id);
  assert.equal(pending.report.posted, true); assert.equal(current.tasks[0].approved_good, '3.000000');
  const overPlan = await post('/api/production-reports', { request_key: key(), task_id: taskId, operator_id: worker, good_qty: '11', defect_qty: '0', rework_qty: '0', scrap_qty: '0' });
  assert.equal(overPlan.report.approval, 'approved'); assert.equal(overPlan.report.good_qty, '11.000000');
  current = await reload(wo.id);
  assert.equal(current.tasks[0].execution, 'completed');
});

test('末道单位关系把任务数量换算回成品数量，只有末道能入库', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('2', '15');
  const wo = await makeWo(sales.lines[0].id, '2', wh, { unit_ratios: [{ sequence: 4, unit_ratio: '2' }] });
  assert.equal(wo.tasks[3].plan_qty, '4.000000'); assert.equal(wo.tasks[3].unit_ratio, '2.000000'); assert.equal(wo.tasks[0].plan_qty, '2.000000');
  for (const row of wo.materials) await stockIn(wh, row.product_id, row.required_qty);
  await approveIssue(await issue(wo));
  let current = (await act('/api/work-orders/' + wo.id + '/actions', { action: 'start', version: (await reload(wo.id)).version })).work_order;
  current = await finishReports(current, ['2', '2', '2', '4']);
  assert.equal(current.output_qty, '2.000000'); assert.equal(current.tasks[3].approved_good, '4.000000');
  const receipt = await post('/api/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '2' });
  await act('/api/fg-receipts/' + receipt.fg_receipt.id + '/actions', { action: 'approve', version: receipt.fg_receipt.version, request_key: key() });
  assert.equal(await onHand(wh, fg.id), '2.000000');
  assert.equal((await reload(wo.id)).received_qty, '2.000000');
});

test('要求成品检验时，未放行不能入库', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('1', '9');
  const wo = await makeWo(sales.lines[0].id, '1', wh, { requires_fg_inspection: true });
  for (const row of wo.materials) await stockIn(wh, row.product_id, row.required_qty);
  await approveIssue(await issue(wo));
  let current = (await act('/api/work-orders/' + wo.id + '/actions', { action: 'start', version: (await reload(wo.id)).version })).work_order;
  current = await finishReports(current);
  const receipt = await post('/api/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '1' });
  const blocked = await act('/api/fg-receipts/' + receipt.fg_receipt.id + '/actions', { action: 'approve', version: receipt.fg_receipt.version }, a, 422);
  assert.equal(blocked.error.code, 'QUALITY_REQUIRED'); assert.equal(await onHand(wh, fg.id), '0.000000');
  const inspection = await post('/api/inspections', { request_key: key(), work_order_id: wo.id, inspected_qty: '1', good_qty: '1', defect_qty: '0', note: '成品放行' });
  assert.equal(inspection.inspection.state, 'pending'); assert.match(inspection.inspection.sampling, /未实现/);
  const passed = await act('/api/inspections/' + inspection.inspection.id + '/actions', { action: 'complete', version: inspection.inspection.version, conclusion: 'pass' });
  assert.equal(passed.inspection.state, 'completed'); assert.equal(passed.inspection.accepted_qty, '1.000000');
  await act('/api/fg-receipts/' + receipt.fg_receipt.id + '/actions', { action: 'approve', version: receipt.fg_receipt.version, request_key: key() });
  assert.equal(await onHand(wh, fg.id), '1.000000');
});

test('手工暂停不被工单暂停覆盖，恢复工单后手工暂停仍然有效', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('1', '6');
  const wo = await makeWo(sales.lines[0].id, '1', wh);
  for (const row of wo.materials) await stockIn(wh, row.product_id, row.required_qty);
  await approveIssue(await issue(wo));
  let current = (await act('/api/work-orders/' + wo.id + '/actions', { action: 'start', version: (await reload(wo.id)).version })).work_order;
  const task = current.tasks[0];
  current = (await act('/api/work-orders/' + wo.id + '/tasks/' + task.id + '/actions', { action: 'pause', version: task.version, reason: '设备故障' })).work_order;
  assert.equal(current.execution, 'paused'); assert.equal(current.order_paused, false); assert.equal(current.tasks[0].pause_source, 'manual');
  current = (await act('/api/work-orders/' + wo.id + '/actions', { action: 'pause', version: current.version, reason: '整单待料' })).work_order;
  assert.equal(current.order_paused, true); assert.equal(current.tasks[0].pause_source, 'manual'); assert.equal(current.tasks[1].pause_source, 'order'); assert.equal(current.tasks[1].execution, 'paused');
  current = (await act('/api/work-orders/' + wo.id + '/actions', { action: 'resume', version: current.version })).work_order;
  assert.equal(current.order_paused, false); assert.equal(current.execution, 'paused'); assert.equal(current.tasks[0].pause_source, 'manual'); assert.equal(current.tasks[0].execution, 'paused'); assert.equal(current.tasks[1].pause_source, 'none'); assert.equal(current.tasks[1].execution, 'not_started');
  current = (await act('/api/work-orders/' + wo.id + '/tasks/' + task.id + '/actions', { action: 'resume', version: current.tasks[0].version })).work_order;
  assert.equal(current.tasks[0].execution, 'running'); assert.equal(current.tasks[0].pause_source, 'none'); assert.equal(current.execution, 'running');
});

test('有下游单据不能取消加工单，干净取消会释放已排数量', async () => {
  const wh = (await warehouse()).id;
  const sales = await openSales('4', '5');
  const blockedWo = await makeWo(sales.lines[0].id, '1', wh);
  await issue(blockedWo);
  const blocked = await act('/api/work-orders/' + blockedWo.id + '/actions', { action: 'cancel', version: blockedWo.version, reason: '想取消' }, a, 409);
  assert.equal(blocked.error.code, 'DOWNSTREAM_EXISTS');
  const clean = await makeWo(sales.lines[0].id, '2', wh);
  const cancelled = await act('/api/work-orders/' + clean.id + '/actions', { action: 'cancel', version: clean.version, reason: '下错' });
  assert.equal(cancelled.work_order.execution, 'cancelled');
  const line = (await get('/api/sales-orders/' + sales.id)).order.lines[0];
  assert.equal(line.scheduled_qty, '1.000000');
  const again = await makeWo(sales.lines[0].id, '3', wh);
  assert.equal(again.plan_qty, '3.000000');
});

test('总览进入生产主线，出库超过现存量会被拒绝且不写流水', async () => {
  const overview = await get('/api/overview');
  assert.equal(overview.stage, 'production_mainline'); assert.ok(overview.work_orders >= 1);
  const wh = (await warehouse()).id;
  const created = await post('/api/stock-adjustments', { request_key: key(), warehouse_id: wh, product_id: caster.id, direction: 'out', quantity: '1', reason: '没有现存量' });
  const refused = await act('/api/stock-adjustments/' + created.stock_adjustment.id + '/actions', { action: 'approve', version: 1 }, a, 409);
  assert.equal(refused.error.code, 'INSUFFICIENT_STOCK');
  const ledger = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query<{ n: string }>('SELECT count(*)::text AS n FROM stock_ledger WHERE source_id=$1', [created.stock_adjustment.id]));
  assert.equal(ledger.rows[0]!.n, '0');
  const still = await get('/api/stock/balances');
  assert.equal(still.items.find((row: { warehouse_id: string; product_id: string }) => row.warehouse_id === wh && row.product_id === caster.id), undefined);
});

test('客户写入在审计失败时连同幂等记录回滚', async () => {
  const marker = code('CU');
  await db.admin((sql) => sql.exec("CREATE FUNCTION reject_customer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='customer.created' THEN RAISE EXCEPTION 'injected customer audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_customer_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_customer_audit()"));
  const requestKey = key();
  try { await post('/api/customers', { request_key: requestKey, code: marker, name: '必须回滚' }, a, 500); }
  finally { await db.admin((sql) => sql.exec('DROP TRIGGER reject_customer_audit ON audit_events; DROP FUNCTION reject_customer_audit()')); }
  const gone = await db.tenant({ tenantId: ta, userId: admin }, (sql) => sql.query('SELECT id FROM customers WHERE code=$1', [marker]));
  assert.equal(gone.rows.length, 0);
  const created = await post('/api/customers', { request_key: requestKey, code: marker, name: '必须回滚' });
  assert.equal(created.replayed, false); assert.equal(created.customer.code, marker);
});

test('已有 BOM 绑定旧路线版本时，样例冻结该版本并复用 SO000001 / WO000001', async () => {
  assert.equal(frozenRouteVersionId({ route_version_id: 'bound' }, 'current'), 'bound');
  assert.equal(frozenRouteVersionId({ route_version_id: null }, 'current'), 'current');
  assert.throws(() => frozenRouteVersionId({}, undefined), /没有可冻结的路线版本/);
  const productId = 'parent-1', otherId = 'parent-2', lineId = 'line-1';
  assert.equal(reusableSales([{ code: 'SO000001', lines: [{ product_id: otherId }] }, { code: 'SO000002', lines: [{ product_id: productId }] }], productId), undefined);
  assert.equal(reusableSales([{ code: 'SO000001', id: 'sales', lines: [{ product_id: productId }] }], productId).id, 'sales');
  assert.equal(reusableWorkOrder([{ code: 'WO000001', id: 'old', sales_line_id: lineId, execution: 'cancelled' }, { code: 'WO000002', id: 'live', sales_line_id: lineId, execution: 'running' }], lineId).id, 'live');
  assert.equal(reusableWorkOrder([{ code: 'WO000001', id: 'demo', sales_line_id: lineId, execution: 'not_started' }], lineId).id, 'demo');
  assert.equal(reusableWorkOrder([{ code: 'WO000001', id: 'other', sales_line_id: 'line-9', execution: 'running' }], lineId), undefined);
  const seed = readFileSync(new URL('../../../scripts/seed-stage2.mjs', import.meta.url), 'utf8');
  assert.match(seed, /frozenRouteVersionId\(bomVersion,route\.current_version_id\)/);
  assert.match(seed, /reusableSales\(/);
  assert.match(seed, /reusableWorkOrder\(/);

  const product = (await post('/api/products', { code: code('FG2'), name: '绑定旧路线的成品', unit_id: unit, attribute: 'manufactured' })).product;
  const createdRoute = (await post('/api/routes', { code: code('RT2'), name: '绑定时的路线', steps: [{ process_id: firstProcess, auto_inbound: false }] })).route;
  const boundId = createdRoute.current_version_id as string;
  const bom = (await post('/api/boms', { parent_product_id: product.id, description: '已有第二步数据', route_version_id: boundId, items: [{ component_product_id: steel.id, quantity: '1', loss_rate: '0' }] })).bom;
  const revised = (await post('/api/routes/' + createdRoute.id + '/versions', { expected_version: createdRoute.version, name: '后来的当前路线', steps: [{ process_id: firstProcess, auto_inbound: false }] })).route;
  assert.notEqual(revised.current_version_id, boundId);
  const bomVersion = (await get('/api/bom-versions/' + bom.current_version_id)).version;
  const frozen = frozenRouteVersionId(bomVersion, revised.current_version_id);
  assert.equal(frozen, boundId);
  const draft = await post('/api/sales-orders', { request_key: key(), customer_id: customerId, lines: [{ product_id: product.id, quantity: '1', unit_price: '1' }] });
  const submitted = await act('/api/sales-orders/' + draft.order.id + '/actions', { action: 'submit', version: draft.order.version });
  const sales = (await act('/api/sales-orders/' + draft.order.id + '/actions', { action: 'approve', version: submitted.order.version, request_key: key() })).order;
  const wh = (await warehouse()).id;
  const mismatch = await post('/api/work-orders', { request_key: key(), sales_line_id: sales.lines[0].id, quantity: '1', route_version_id: revised.current_version_id, bom_version_id: bom.current_version_id, warehouse_id: wh }, a, 422);
  assert.equal(mismatch.error.code, 'ROUTE_BOM_MISMATCH');
  const body = { request_key: key(), sales_line_id: sales.lines[0].id, quantity: '1', route_version_id: frozen, bom_version_id: bom.current_version_id, warehouse_id: wh };
  const created = await post('/api/work-orders', body);
  assert.equal(created.work_order.route_version_id, boundId);
  assert.equal(created.work_order.bom_version_id, bom.current_version_id);
  const listed = (await get('/api/work-orders')).items;
  assert.equal(reusableWorkOrder(listed, sales.lines[0].id).id, created.work_order.id);
  const replay = await post('/api/work-orders', body, a, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.work_order.id, created.work_order.id);
  assert.equal((await get('/api/work-orders')).items.filter((item: { sales_line_id: string; execution: string }) => item.sales_line_id === sales.lines[0].id && item.execution !== 'cancelled').length, 1);
});

test('直接创建加工单号留空时按 JG+日期+流水生成，不传编号仍用 WO；校验失败提示中文字段', async () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  const stamp = value('year').slice(2) + value('month') + value('day');
  const wh = (await warehouse()).id;
  const sales = await openSales('10');
  const lineId = sales.lines[0].id;
  await makeWo(lineId, '1', wh, { code: 'JG' + stamp + '-8' });
  const blank = await makeWo(lineId, '1', wh, { code: '' });
  const next = await makeWo(lineId, '1', wh, { code: '' });
  assert.equal(blank.code, 'JG' + stamp + '-9');
  assert.equal(next.code, 'JG' + stamp + '-10');
  const parallel = await Promise.all([1, 2, 3, 4].map(() => makeWo(lineId, '1', wh, { code: '' })));
  assert.deepEqual(parallel.map((row) => row.code).slice().sort(), ['11', '12', '13', '14'].map((suffix) => 'JG' + stamp + '-' + suffix));
  const omitted = await makeWo(lineId, '1', wh);
  assert.match(omitted.code, /^WO\d{6}$/);
  const custom = await makeWo(lineId, '1', wh, { code: 'HAND-0008' });
  assert.equal(custom.code, 'HAND-0008');
  const duplicate = await post('/api/work-orders', { request_key: key(), code: 'HAND-0008', sales_line_id: lineId, quantity: '1', route_version_id: routeVersionId, bom_version_id: bomVersionId, warehouse_id: wh }, a, 409);
  assert.equal(duplicate.error.code, 'DUPLICATE');
  // WHY: Round11 intentional — omitting warehouse_id auto-picks earliest active warehouse (production.ts). Not relaxing JG numbering; Chinese field validation asserted via missing quantity instead.
  const autoWh = await post('/api/work-orders', { request_key: key(), code: '', sales_line_id: lineId, quantity: '1', route_version_id: routeVersionId, bom_version_id: bomVersionId }, a, 201);
  assert.ok(autoWh.work_order.warehouse_id);
  const missingQty = await post('/api/work-orders', { request_key: key(), code: '', sales_line_id: lineId, route_version_id: routeVersionId, bom_version_id: bomVersionId, warehouse_id: wh }, a, 400);
  assert.equal(missingQty.error.code, 'VALIDATION_ERROR');
  assert.equal(missingQty.error.message, '请填写计划数');
  const noUnit = await post('/api/products', { code: code('FREE'), name: '可无单位', attribute: 'manufactured' }, a, 201);
  assert.equal(noUnit.product.unit_id, null);
});
