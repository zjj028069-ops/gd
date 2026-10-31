import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), other = randomUUID();
const admin = randomUUID(), worker = randomUUID();
const unit = randomUUID();
const password = 'Wage-Line-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login, w: Login;
let seq = 1;
const headers = (s: Login, write = false) => ({ cookie: s.cookie, ...(write ? { 'x-csrf-token': s.csrf } : {}) });
const key = () => randomUUID();
async function login(slug: string, name: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.' + (seq++ % 200), payload: { tenant_slug: slug, username: name, password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  return { cookie: (Array.isArray(raw) ? raw![0]! : raw!).split(';')[0]!, csrf: response.json().csrf_token };
}
async function post(url: string, body: unknown, expected = 201, s = a) {
  const response = await app.inject({ method: 'POST', url, headers: headers(s, true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function patch(url: string, body: unknown, expected = 200) {
  const response = await app.inject({ method: 'PATCH', url, headers: headers(a, true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function get(url: string, s = a, expected = 200) {
  const response = await app.inject({ url, headers: headers(s) });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function act(url: string, body: unknown, expected = 200) {
  return post(url, body, expected);
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'wage-a', '工资甲']);
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [other, 'wage-b', '工资乙']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'wage.admin', '工资管理员', hash]);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [worker, 'wage.worker', '工资工人', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')", [tenant, worker]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','台')", [unit, tenant]);
  });
  app = await createApp(db, { localEventsWorker: false });
  a = await login('wage-a', 'wage.admin');
  w = await login('wage-a', 'wage.worker');
});
after(async () => { await app?.close(); await db?.close(); });

test('计件按良品、计时按秒、分位四舍五入，任务单价快照，报工即未结算', async () => {
  const product = (await post('/api/products', { code: 'FG-WAGE', name: '样例成品', unit_id: unit, attribute: 'manufactured' })).product;
  const heat = (await post('/api/processes', { code: 'GX-HEAT', name: '热处理', standard_minutes: '1', reporter_ids: [admin, worker], pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none' })).process;
  const polish = (await post('/api/processes', { code: 'GX-POLISH', name: '抛光', standard_minutes: '1', reporter_ids: [admin], pricing_mode: 'time', wage_rate: '36' })).process;
  const warehouse = (await post('/api/warehouses', { request_key: key(), code: 'WH-W', name: '成品仓' })).warehouse;
  const order = (await post('/api/work-orders', { request_key: key(), code: '', product_id: product.id, quantity: '80', warehouse_id: warehouse.id, priority: 'normal', due_date: '2026-10-12', tasks: [{ process_id: heat.id, pricing_mode: 'piece', wage_rate: '10' }, { process_id: polish.id, pricing_mode: 'time', wage_rate: '36' }] })).work_order;
  assert.match(order.code, /^JG\d{6}-\d+$/);
  assert.equal(order.sales_line_id, null);
  assert.equal(order.tasks[0].wage_rate, '10.0000000');
  assert.equal(order.tasks[1].pricing_mode, 'time');
  await patch('/api/processes/' + heat.id, { version: heat.version, name: '热处理', description: '', standard_minutes: '1', reporter_ids: [admin, worker], active: true, pricing_mode: 'piece', wage_rate: '12', inspection_scheme: 'none' });
  const unchanged = (await get('/api/work-orders/' + order.id)).work_order;
  assert.equal(unchanged.tasks[0].wage_rate, '10.0000000');
  await act('/api/work-orders/' + order.id + '/tasks/' + unchanged.tasks[1].id + '/actions', { action: 'start', version: unchanged.tasks[1].version });
  const started = (await get('/api/work-orders/' + order.id)).work_order;
  assert.equal(started.execution, 'running');
  assert.equal(started.tasks[0].execution, 'not_started');
  await act('/api/work-orders/' + order.id + '/tasks/' + started.tasks[0].id + '/actions', { action: 'start', version: started.tasks[0].version });
  const piece = (await post('/api/production-reports', { request_key: key(), task_id: started.tasks[0].id, good_qty: '75', defect_qty: '5', rework_qty: '0', scrap_qty: '0', defect_note: '氧化' })).report;
  assert.equal(piece.approval, 'approved');
  assert.equal(piece.settlement_status, 'unsettled');
  assert.equal(piece.estimated_wage, '750.00');
  assert.equal(piece.quality_status, 'none');
  const timed = (await post('/api/production-reports', { request_key: key(), task_id: started.tasks[1].id, good_qty: '0', defect_qty: '0', rework_qty: '0', scrap_qty: '0', effective_seconds: 5400, complete_task: true })).report;
  assert.equal(timed.estimated_wage, '54.00');
  const edited = (await patch('/api/production-reports/' + timed.id, { version: timed.version, good_qty: '0', defect_qty: '0', effective_seconds: 7200 })).report;
  assert.equal(edited.estimated_wage, '72.00');
  await patch('/api/work-orders/' + order.id + '/tasks/' + started.tasks[0].id, { version: (await get('/api/work-orders/' + order.id)).work_order.tasks[0].version, pricing_mode: 'piece', wage_rate: '99' });
  const again = (await get('/api/production-reports?task_id=' + started.tasks[0].id)).items.find((row: { id: string }) => row.id === piece.id);
  assert.equal(again.estimated_wage, '750.00');
  const settled = (await post('/api/production-reports/' + piece.id + '/settlement', { request_key: key(), version: piece.version, settled: true, note: '10月工资' }, 200)).report;
  assert.equal(settled.settlement_status, 'settled');
  assert.equal(settled.settled_by, admin);
  assert.ok(settled.settled_at);
  assert.equal(settled.settlement_note, '10月工资');
  const blocked = await patch('/api/production-reports/' + piece.id, { version: settled.version, good_qty: '1', defect_qty: '0' }, 409);
  assert.equal(blocked.error.message, '已结算的报工记录不能修改或删除，请先改为未结算');
  const batch = await post('/api/production-reports/batch-settlement', { request_key: key(), report_ids: [piece.id, edited.id] }, 200);
  assert.equal(batch.settled, 1);
  assert.equal(batch.skipped, 1);
  const cleared = (await post('/api/production-reports/' + edited.id + '/settlement', { request_key: key(), version: (await get('/api/production-reports?task_id=' + started.tasks[1].id)).items.find((row: { id: string }) => row.id === edited.id).version, settled: false }, 200)).report;
  assert.equal(cleared.settlement_status, 'unsettled');
  assert.equal(cleared.settled_by, null);
  const payroll = await get('/api/payroll-statement');
  const row = payroll.items.find((item: { user_id: string }) => item.user_id === admin);
  assert.equal(row.settled_piece, '750.00');
  assert.equal(row.unsettled_time, '72.00');
  const monthly = await get('/api/payroll-statement/' + admin + '/monthly');
  assert.ok(monthly.items.some((item: { settled_piece: string; unsettled_time: string }) => item.settled_piece === '750.00' && item.unsettled_time === '72.00'));
  const hidden = await get('/api/payroll-statement', w);
  assert.equal(hidden.items.length, 0);
  assert.equal((await get('/api/payroll-statement/' + admin + '/monthly', w, 403)).error.code, 'FORBIDDEN');
  const tiny = (await post('/api/processes', { code: 'GX-TINY', name: '分位', standard_minutes: '1', reporter_ids: [admin], pricing_mode: 'piece', wage_rate: '0.005' })).process;
  const tinyOrder = (await post('/api/work-orders', { request_key: key(), code: '', product_id: product.id, quantity: '1', warehouse_id: warehouse.id, tasks: [{ process_id: tiny.id }] })).work_order;
  await act('/api/work-orders/' + tinyOrder.id + '/tasks/' + tinyOrder.tasks[0].id + '/actions', { action: 'start', version: tinyOrder.tasks[0].version });
  const cent = (await post('/api/production-reports', { request_key: key(), task_id: tinyOrder.tasks[0].id, good_qty: '1', defect_qty: '0', rework_qty: '0', scrap_qty: '0' })).report;
  assert.equal(cent.estimated_wage, '0.01');
  const hour = (await post('/api/processes', { code: 'GX-HOUR', name: '时分', standard_minutes: '1', reporter_ids: [admin], pricing_mode: 'time', wage_rate: '0.01' })).process;
  const hourOrder = (await post('/api/work-orders', { request_key: key(), code: '', product_id: product.id, quantity: '1', warehouse_id: warehouse.id, tasks: [{ process_id: hour.id }] })).work_order;
  await act('/api/work-orders/' + hourOrder.id + '/tasks/' + hourOrder.tasks[0].id + '/actions', { action: 'start', version: hourOrder.tasks[0].version });
  const second = (await post('/api/production-reports', { request_key: key(), task_id: hourOrder.tasks[0].id, good_qty: '0', defect_qty: '0', rework_qty: '0', scrap_qty: '0', effective_seconds: 1800 })).report;
  assert.equal(second.estimated_wage, '0.01');
});
