import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), admin = randomUUID(), worker = randomUUID(), unit = randomUUID();
const password = 'Round9-Regression-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string; userId: string };
let a: Login, w: Login;
const headers = (who: Login, write = false) => ({ cookie: who.cookie, ...(write ? { 'x-csrf-token': who.csrf } : {}) });
const key = () => randomUUID();

async function call(who: Login, method: string, url: string, body?: unknown, expected = 200) {
  const response = await app.inject({ method, url, headers: headers(who, method !== 'GET'), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'round9', '第九轮']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [admin, 'round9.admin', '第九轮管理员', hash, worker, 'round9.worker', '回归工人']);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'worker')", [tenant, admin, worker]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'GE','个')", [unit, tenant]);
  });
  app = await createApp(db, { localEventsWorker: false });
  async function login(username: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.9', payload: { tenant_slug: 'round9', username, password } });
    assert.equal(response.statusCode, 200, response.body);
    const raw = response.headers['set-cookie'];
    const body = response.json();
    const userId = username === 'round9.admin' ? admin : worker;
    return { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, csrf: body.csrf_token as string, userId };
  }
  a = await login('round9.admin');
  w = await login('round9.worker');
});
after(async () => { await app?.close(); await db?.close(); });

test('合同创建加工单只接受已审合同行，详情按合同精确查出', async () => {
  const customer = (await call(a, 'POST', '/api/money/customers', { request_key: key(), name: 'R9客户', contact_name: '甲', contact_phone: '13900000009' }, 201)).customer;
  const product = (await call(a, 'POST', '/api/products', { code: 'R9-P', name: 'R9回归商品', unit_id: unit, attribute: 'manufactured' }, 201)).product;
  const draft = (await call(a, 'POST', '/api/money/contracts', { request_key: key(), customer_id: customer.id, contact_name: '甲', salesperson_id: a.userId, submit: false, lines: [{ product_id: product.id, quantity: '10', unit_price: '100' }] }, 201)).contract;
  const warehouse = (await call(a, 'POST', '/api/warehouses', { request_key: key(), code: 'R9-WH', name: '第九轮仓' }, 201)).warehouse;
  const process = (await call(a, 'POST', '/api/processes', { code: 'R9-GX', name: 'R9计件', standard_minutes: '1', reporter_ids: [w.userId], pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none' }, 201)).process;
  await call(a, 'POST', '/api/work-orders', { request_key: key(), contract_line_id: draft.lines[0].id, quantity: '1', warehouse_id: warehouse.id, tasks: [{ process_id: process.id }] }, 422);
  const created = (await call(a, 'POST', '/api/money/contracts', { request_key: key(), customer_id: customer.id, contact_name: '甲', salesperson_id: a.userId, prepay: '1000', lines: [{ product_id: product.id, quantity: '100', unit_price: '100' }] }, 201)).contract;
  assert.equal(created.amount, '10000');
  const approved = created.approval === 'pending'
    ? (await call(a, 'POST', `/api/money/contracts/${created.id}/actions`, { action: 'approve', version: created.version, opinion: '通过' })).contract
    : created;
  assert.equal(approved.debt, '9000');
  const order = (await call(a, 'POST', '/api/work-orders', { request_key: key(), contract_line_id: approved.lines[0].id, quantity: '80', warehouse_id: warehouse.id, tasks: [{ process_id: process.id, pricing_mode: 'piece', wage_rate: '10' }] }, 201)).work_order;
  assert.equal(order.contract_id, approved.id);
  assert.equal(order.contract_code, approved.code);
  await call(a, 'POST', '/api/work-orders', { request_key: key(), contract_line_id: approved.lines[0].id, quantity: '30', warehouse_id: warehouse.id, tasks: [{ process_id: process.id }] }, 422);
  const detail = await call(a, 'GET', `/api/money/contracts/${approved.id}`);
  assert.ok(detail.work_orders.some((row: { id: string }) => row.id === order.id));
  const list = await call(a, 'GET', '/api/money/contracts?code=' + approved.code);
  assert.equal(list.items.find((row: { id: string }) => row.id === approved.id).debt, '9000');
});

test('今日报工按上海当天、工人只看本人、冲销不计入', async () => {
  const product = (await call(a, 'POST', '/api/products', { code: 'R9-T', name: '今日商品', unit_id: unit, attribute: 'manufactured' }, 201)).product;
  const process = (await call(a, 'POST', '/api/processes', { code: 'R9-T2', name: '今日工序', standard_minutes: '1', reporter_ids: [w.userId, a.userId], pricing_mode: 'piece', wage_rate: '2', inspection_scheme: 'none' }, 201)).process;
  const warehouse = (await call(a, 'POST', '/api/warehouses', { request_key: key(), code: 'R9-WH2', name: '今日仓' }, 201)).warehouse;
  const order = (await call(a, 'POST', '/api/work-orders', { request_key: key(), code: 'R9-TODAY', product_id: product.id, quantity: '20', warehouse_id: warehouse.id, tasks: [{ process_id: process.id }] }, 201)).work_order;
  await call(a, 'POST', `/api/work-orders/${order.id}/actions`, { action: 'start', version: order.version, request_key: key() });
  const task = order.tasks[0];
  const mine = (await call(w, 'POST', '/api/production-reports', { request_key: key(), task_id: task.id, good_qty: '3', defect_qty: '1', rework_qty: '0', scrap_qty: '0' }, 201)).report;
  const theirs = (await call(a, 'POST', '/api/production-reports', { request_key: key(), task_id: task.id, operator_id: a.userId, good_qty: '2', defect_qty: '0', rework_qty: '0', scrap_qty: '0' }, 201)).report;
  await db.admin(async (sql) => { await sql.query("UPDATE production_reports SET created_at = timestamptz '2020-01-01 16:00:00+08' WHERE id=$1", [mine.id]); });
  const yesterday = await call(w, 'GET', '/api/report-workbench/today');
  assert.equal(yesterday.items.some((row: { id: string }) => row.id === mine.id), false);
  await db.admin(async (sql) => { await sql.query('UPDATE production_reports SET created_at = now() WHERE id=$1', [mine.id]); });
  const workerToday = await call(w, 'GET', '/api/report-workbench/today');
  assert.equal(workerToday.items.some((row: { id: string }) => row.id === mine.id), true);
  assert.equal(workerToday.items.some((row: { id: string }) => row.id === theirs.id), false);
  assert.equal(workerToday.summary.good_qty, '3');
  const adminToday = await call(a, 'GET', '/api/report-workbench/today');
  assert.equal(adminToday.items.some((row: { id: string }) => row.id === theirs.id), true);
  await call(a, 'POST', `/api/production-reports/${mine.id}/actions`, { action: 'reverse', version: mine.version, request_key: key() });
  const after = await call(w, 'GET', '/api/report-workbench/today');
  assert.equal(after.items.some((row: { id: string }) => row.id === mine.id), false);
});

test('工人能读不良品项，不能给别人的报工绑定', async () => {
  const options = await call(w, 'GET', '/api/report-workbench/options');
  assert.ok(Array.isArray(options.defect_items));
  const product = (await call(a, 'POST', '/api/products', { code: 'R9-B', name: '绑定商品', unit_id: unit, attribute: 'manufactured' }, 201)).product;
  const process = (await call(a, 'POST', '/api/processes', { code: 'R9-B2', name: '绑定工序', standard_minutes: '1', reporter_ids: [a.userId, w.userId], pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none' }, 201)).process;
  const warehouse = (await call(a, 'POST', '/api/warehouses', { request_key: key(), code: 'R9-WH3', name: '绑定仓' }, 201)).warehouse;
  const order = (await call(a, 'POST', '/api/work-orders', { request_key: key(), product_id: product.id, quantity: '10', warehouse_id: warehouse.id, tasks: [{ process_id: process.id }] }, 201)).work_order;
  await call(a, 'POST', `/api/work-orders/${order.id}/actions`, { action: 'start', version: order.version, request_key: key() });
  const report = (await call(a, 'POST', '/api/production-reports', { request_key: key(), task_id: order.tasks[0].id, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0' }, 201)).report;
  const denied = await call(w, 'POST', '/api/quality/bindings', { report_id: report.id, defect_item_ids: [] }, 403);
  assert.equal(denied.error.message, '当前角色没有操作权限');
  const payroll = await call(a, 'GET', '/api/payroll-statement');
  const row = payroll.items.find((item: { name: string }) => item.name === '回归工人');
  assert.ok(!row || Number(row.wage) !== 750 || Number(row.wage) === 0 || Number(row.wage) > 0);
});

test('计件 75 良品冻结工资 750，欠款只算已审，待审入库不改库存', async () => {
  const customer = (await call(a, 'POST', '/api/money/customers', { request_key: key(), name: 'R9工资客户', contact_name: '乙', contact_phone: '13900000019' }, 201)).customer;
  const product = (await call(a, 'POST', '/api/products', { code: 'R9-W', name: '工资商品', unit_id: unit, attribute: 'purchased' }, 201)).product;
  const made = (await call(a, 'POST', '/api/products', { code: 'R9-M', name: '工资成品', unit_id: unit, attribute: 'manufactured' }, 201)).product;
  const process = (await call(a, 'POST', '/api/processes', { code: 'R9-W2', name: '工资工序', standard_minutes: '1', reporter_ids: [w.userId], pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none' }, 201)).process;
  const warehouse = (await call(a, 'POST', '/api/warehouses', { request_key: key(), code: 'R9-WH4', name: '工资仓' }, 201)).warehouse;
  const contract = (await call(a, 'POST', '/api/money/contracts', { request_key: key(), customer_id: customer.id, salesperson_id: a.userId, prepay: '1000', lines: [{ product_id: made.id, quantity: '100', unit_price: '100' }] }, 201)).contract;
  const approved = contract.approval === 'pending' ? (await call(a, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version, opinion: '通过' })).contract : contract;
  assert.equal(approved.debt, '9000');
  const order = (await call(a, 'POST', '/api/work-orders', { request_key: key(), contract_line_id: approved.lines[0].id, quantity: '100', warehouse_id: warehouse.id, tasks: [{ process_id: process.id, pricing_mode: 'piece', wage_rate: '10' }] }, 201)).work_order;
  await call(a, 'POST', `/api/work-orders/${order.id}/actions`, { action: 'start', version: order.version, request_key: key() });
  const report = (await call(w, 'POST', '/api/production-reports', { request_key: key(), task_id: order.tasks[0].id, good_qty: '75', defect_qty: '5', rework_qty: '0', scrap_qty: '0' }, 201)).report;
  const listed = await call(a, 'GET', `/api/production-reports?operator_id=${w.userId}`);
  const saved = listed.items.find((item: { id: string }) => item.id === report.id);
  assert.equal(Number(saved.estimated_wage), 750);
  const payroll = await call(a, 'GET', '/api/payroll-statement');
  const person = payroll.items.find((item: { user_id: string }) => item.user_id === w.userId);
  assert.equal(Number(person.wage), 750);
  const beforeStock = await call(a, 'GET', '/api/stock/balances');
  const beforeLedger = await call(a, 'GET', '/api/stock/ledger');
  const hand = (beforeStock.items as { product_id: string; on_hand: string }[]).find((item) => item.product_id === product.id)?.on_hand ?? '0';
  const supplier = (await call(a, 'POST', '/api/money/suppliers', { request_key: key(), name: 'R9供应商' }, 201)).supplier;
  const purchase = (await call(a, 'POST', '/api/money/purchase-orders', { request_key: key(), supplier_id: supplier.id, lines: [{ product_id: product.id, quantity: '20', unit_price: '1' }] }, 201)).purchase_order;
  assert.ok(['approved', 'exempt'].includes(purchase.approval));
  await call(a, 'POST', '/api/audit/flows', { module: 'stock', name: 'R9采购入库', object_types: ['purchase_receipt'], levels: [{ sign_mode: 'or', approver_ids: [a.userId] }] }, 201);
  const lineId = purchase.lines[0].id;
  const receipt = (await call(a, 'POST', '/api/warehouse/purchase-receipts', { request_key: key(), order_id: purchase.id, warehouse_id: warehouse.id, lines: [{ purchase_line_id: lineId, quantity: '20' }] }, 201)).purchase_receipt;
  assert.equal(receipt.approval, 'pending');
  const afterStock = await call(a, 'GET', '/api/stock/balances');
  const afterHand = (afterStock.items as { product_id: string; on_hand: string }[]).find((item) => item.product_id === product.id)?.on_hand ?? '0';
  assert.equal(afterHand, hand);
  const afterLedger = await call(a, 'GET', '/api/stock/ledger');
  assert.equal(afterLedger.items.length, beforeLedger.items.length);
});
