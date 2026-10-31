import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { allocateCents } from '../src/produce-extra.js';
import { bestAnswer } from '../src/ai-train.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), other = randomUUID(), admin = randomUUID(), worker = randomUUID(), unit = randomUUID();
const password = 'Round10-Fill-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string; userId: string };
let a: Login, w: Login;
const key = () => randomUUID();

async function call(who: Login, method: string, url: string, body?: unknown, expected = 200) {
  const response = await app.inject({ method, url, headers: { cookie: who.cookie, ...(method !== 'GET' ? { 'x-csrf-token': who.csrf } : {}) }, payload: body as never });
  assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
  return response.json();
}

function monthStart(offset: number) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-10 12:00:00+08`;
}

let warehouseId = '', processId = '';
async function workOrder(code: string, qty: string) {
  const product = (await call(a, 'POST', '/api/products', { code: `P-${code}`, name: `商品${code}`, unit_id: unit, attribute: 'manufactured' }, 201)).product;
  return (await call(a, 'POST', '/api/work-orders', { request_key: key(), code, product_id: product.id, quantity: qty, warehouse_id: warehouseId, tasks: [{ process_id: processId }] }, 201)).work_order as { id: string; code: string };
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  await db.assertSecurityConfiguration();
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3),($4,$5,$6)', [tenant, 'round10', '第十轮', other, 'round10-other', '别家']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [admin, 'round10.admin', '第十轮管理员', hash, worker, 'round10.worker', '十轮工人']);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'worker')", [tenant, admin, worker]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'GE','个')", [unit, tenant]);
  });
  app = await createApp(db, { localEventsWorker: false });
  async function login(username: string, userId: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.10', payload: { tenant_slug: 'round10', username, password } });
    assert.equal(response.statusCode, 200, response.body);
    const raw = response.headers['set-cookie'];
    return { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, csrf: response.json().csrf_token as string, userId };
  }
  a = await login('round10.admin', admin);
  w = await login('round10.worker', worker);
  warehouseId = (await call(a, 'POST', '/api/warehouses', { request_key: key(), code: 'R10-WH', name: '十轮仓' }, 201)).warehouse.id;
  processId = (await call(a, 'POST', '/api/processes', { code: 'R10-GX', name: 'R10工序', standard_minutes: '1', reporter_ids: [w.userId, a.userId], pricing_mode: 'piece', wage_rate: '1', inspection_scheme: 'none' }, 201)).process.id;
});
after(async () => { await app?.close(); await db?.close(); });

test('新页面接口都能打开', async () => {
  for (const url of ['/api/workplace/summary', '/api/workplace/config', '/api/customer-follows', '/api/knowledge/categories', '/api/knowledge/articles', '/api/notices', '/api/notices/scope-options',
    '/api/purchase/settings', '/api/purchase/supplier-settings', '/api/purchase/price-rules', '/api/purchase/price-rule-mode', '/api/system/basics', '/api/work-statuses', '/api/system/sms',
    '/api/reports/purchase-statement', '/api/reports/ai-inventory', '/api/smart-reports', '/api/smart-reports/brief/sales', '/api/smart-reports/brief/production', '/api/smart-reports/push-settings', '/api/report-prefs',
    '/api/report-extra/purchase-tests', '/api/report-extra/spot-checks?dimension=operator_process', '/api/report-extra/scrap-rework?dimension=inspector', '/api/report-extra/sales', '/api/report-extra/contracts', '/api/report-extra/inventory', '/api/report-extra/cost',
    '/api/production-projects', '/api/cost-shares', '/api/posts', '/api/process-components', '/api/trace-codes', '/api/material-analysis', '/api/list-views?page_key=goods', '/api/ai-train/intro', '/api/ai-train/documents', '/api/ai-train/qa', '/api/data-screens']) {
    await call(a, 'GET', url);
  }
  const statement = await call(a, 'GET', '/api/reports/purchase-statement');
  assert.equal(statement.message, '您没有可以查看的视图，请联系管理配置。');
});

test('客户跟单增删改，提醒只发一次，别家企业看不到', async () => {
  const customer = (await call(a, 'POST', '/api/money/customers', { request_key: key(), name: 'R10客户', contact_name: '张三', contact_phone: '13900001010' }, 201)).customer;
  const contacts = await call(a, 'GET', `/api/customer-follows/contacts?customer_id=${customer.id}`);
  const contact = (contacts.items ?? contacts)[0];
  assert.ok(contact?.id);
  const created = await call(a, 'POST', '/api/customer-follows', { customer_id: customer.id, contact_id: contact.id, follow_type: '电话', content: '回访报价', next_at: '2030-01-01 10:00' }, 201);
  const list = await call(a, 'GET', '/api/customer-follows?follow_type=电话');
  assert.equal(list.items.length, 1);
  assert.equal((await call(a, 'GET', '/api/customer-follows?follow_type=上门')).items.length, 0);
  await db.admin(async (sql) => { await sql.query("UPDATE customer_follows SET remind_at=now()-interval '1 minute' WHERE id=$1", [created.id]); });
  await call(a, 'GET', '/api/system/messages');
  await call(a, 'GET', '/api/system/messages');
  const count = await db.admin(async (sql) => (await sql.query<{ n: string }>("SELECT count(*)::text AS n FROM kgd_messages WHERE kind='follow' AND object_id=$1", [created.id])).rows[0]!.n);
  assert.equal(count, '1');
  const hidden = await db.tenant({ tenantId: other, userId: admin }, async (sql) => (await sql.query('SELECT id FROM customer_follows')).rows.length);
  assert.equal(hidden, 0);
  const row = list.items[0];
  await call(a, 'PUT', `/api/customer-follows/${created.id}`, { customer_id: customer.id, contact_id: contact.id, follow_type: '上门', content: '上门拜访', next_at: '2030-02-01 10:00', version: row.version });
  assert.equal((await call(a, 'GET', '/api/customer-follows?follow_type=上门')).items.length, 1);
  await call(a, 'DELETE', `/api/customer-follows/${created.id}`);
  assert.equal((await call(a, 'GET', '/api/customer-follows')).items.length, 0);
});

test('通知公告已读未读按人区分', async () => {
  const notice = await call(a, 'POST', '/api/notices', { title: 'R10公告', body_html: '<p>内容</p><script>alert(1)</script>', user_ids: [a.userId, w.userId] }, 201);
  assert.equal((await call(w, 'GET', '/api/notices?tab=unread')).items.length, 1);
  const detail = await call(w, 'GET', `/api/notices/${notice.id}`);
  assert.ok(!JSON.stringify(detail).includes('<script>'));
  assert.equal((await call(w, 'GET', '/api/notices?tab=unread')).items.length, 0);
  assert.equal((await call(w, 'GET', '/api/notices?tab=read')).items.length, 1);
  assert.equal((await call(a, 'GET', '/api/notices?tab=unread')).items.length, 1);
});

test('供应商手机号重复校验', async () => {
  await call(a, 'POST', '/api/money/suppliers', { name: 'R10供应商甲', contact_phone: '13800001010' }, 201);
  await call(a, 'POST', '/api/money/suppliers', { name: 'R10供应商乙', contact_phone: '13800001010' }, 409);
});

test('AI库存监控按3:2:1预测并批量建采购单', async () => {
  const supplier = (await call(a, 'POST', '/api/money/suppliers', { name: 'R10AI供应商', contact_phone: '13800002020' }, 201)).supplier;
  const product = (await call(a, 'POST', '/api/products', { code: 'R10-AI', name: 'AI监控商品', unit_id: unit, attribute: 'purchased', default_supplier_id: supplier.id, stock_lower_warn: '100', stock_upper_warn: '500' }, 201)).product;
  await db.admin(async (sql) => {
    const insert = (direction: string, qty: string, at: string) => sql.query(`INSERT INTO stock_ledger(tenant_id,warehouse_id,product_id,unit_id,direction,quantity,source_type,source_id,event_key,posted_at,created_by) VALUES($1,$2,$3,$4,$5,$6,'adjustment',gen_random_uuid(),$7,$8::timestamptz,$9)`, [tenant, warehouseId, product.id, unit, direction, qty, key(), at, admin]);
    await insert('in', '200', monthStart(-4));
    await insert('out', '10', monthStart(-3));
    await insert('out', '20', monthStart(-2));
    await insert('out', '30', monthStart(-1));
  });
  const result = await call(a, 'GET', '/api/reports/ai-inventory?code=R10-AI');
  const item = result.items[0];
  assert.equal(item.opening_qty, '140');
  assert.equal(item.forecast_out_qty, '23.333333');
  assert.equal(item.forecast_qty, '116.666667');
  assert.ok(item.flags.includes('rising'));
  assert.ok(!item.flags.includes('low'));
  assert.equal(result.summary.rising_count >= 1, true);
  await call(a, 'POST', '/api/reports/ai-inventory/purchase-orders', { product_ids: [product.id] }, 422);
  await call(a, 'PUT', '/api/purchase/settings', { refill_basis: 'upper', refill_percent: '50' });
  const advised = (await call(a, 'GET', '/api/reports/ai-inventory?code=R10-AI')).items[0];
  assert.ok(Number(advised.advice_qty) > 0);
  const created = await call(a, 'POST', '/api/reports/ai-inventory/purchase-orders', { product_ids: [product.id] }, 201);
  assert.equal(created.orders.length, 1);
  const after = (await call(a, 'GET', '/api/reports/ai-inventory?code=R10-AI')).items[0];
  assert.equal(after.purchase_order_code, created.orders[0].code);
  await call(a, 'POST', '/api/reports/ai-inventory/purchase-orders', { product_ids: [product.id] }, 409);
});

test('成本分摊尾差放最后一行，分摊后进成本报表', async () => {
  assert.deepEqual(allocateCents(10000n, [1n, 1n, 1n]), [3333n, 3333n, 3334n]);
  const orders = [await workOrder('R10-CS1', '1'), await workOrder('R10-CS2', '1'), await workOrder('R10-CS3', '1')];
  const share = await call(a, 'POST', '/api/cost-shares', { name: '水电', expense_type: '水电费', amount: '100', period_start: '2026-01-01', period_end: '2026-12-31', method: '按计划数', work_order_ids: orders.map((o) => o.id) }, 201);
  assert.deepEqual(share.lines.map((line: { amount: string }) => line.amount), ['33.33', '33.33', '33.34']);
  await call(a, 'POST', `/api/cost-shares/${share.id}/share`);
  const cost = await call(a, 'GET', '/api/report-extra/cost?code=R10-CS');
  assert.equal(cost.items.length, 3);
  assert.equal(cost.summary.cost_share, '100');
});

test('父子单不能成环', async () => {
  const parent = await workOrder('R10-PA', '2');
  const child = await workOrder('R10-CH', '2');
  await call(a, 'PUT', `/api/work-order-links/${child.id}`, { parent_id: parent.id });
  await call(a, 'PUT', `/api/work-order-links/${parent.id}`, { parent_id: child.id }, 409);
});

test('溯源码连续唯一，分享撤销后404', async () => {
  const order = await workOrder('R10-TR', '5');
  const first = await call(a, 'POST', '/api/trace-codes/batch', { work_order_id: order.id, count: 3 }, 201);
  const second = await call(a, 'POST', '/api/trace-codes/batch', { work_order_id: order.id, count: 2 }, 201);
  const codes = [...first.codes, ...second.codes].map(Number);
  assert.deepEqual(codes, [1000000, 1000001, 1000002, 1000003, 1000004]);
  const share = await call(a, 'POST', '/api/work-order-shares', { work_order_id: order.id }, 201);
  const open = await app.inject({ method: 'GET', url: `/api/public/share/wo/${share.token}` });
  assert.equal(open.statusCode, 200, open.body);
  assert.equal(open.json().work_order.code, 'R10-TR');
  await call(a, 'DELETE', `/api/work-order-shares/${share.id}`);
  assert.equal((await app.inject({ method: 'GET', url: `/api/public/share/wo/${share.token}` })).statusCode, 404);
});

test('大屏密码为空直接可看，设计可保存', async () => {
  const screen = await call(a, 'POST', '/api/data-screens', { menu_name: 'R10测试大屏', module_kind: '生产模块', access_password: '' }, 201);
  await call(a, 'GET', `/api/progress/screen-data/${screen.id}`);
  const detail = await call(a, 'GET', `/api/data-screens/${screen.id}`);
  assert.ok(detail);
  await call(a, 'DELETE', `/api/data-screens/${screen.id}`);
  await call(a, 'GET', `/api/progress/screen-data/${screen.id}`, undefined, 404);
});

test('智能报表增删改与运行，报表查询参数生效', async () => {
  const created = await call(a, 'POST', '/api/smart-reports', { name: 'R10自定义', source: 'production_reports', dimension: 'process', metric: 'good_qty', period: '本周' }, 201);
  const run = await call(a, 'GET', `/api/smart-reports/${created.id}/run`);
  assert.equal(run.dimension_text, '工序');
  assert.equal(run.metric_text, '良品数');
  await call(a, 'POST', '/api/smart-reports', { name: 'R10坏', source: 'production_reports', dimension: 'customer', metric: 'good_qty' }, 422);
  const push = await call(a, 'GET', '/api/smart-reports/push-settings');
  await call(a, 'PUT', '/api/smart-reports/push-settings', { version: push.version, items: [{ kind: 'sales', enabled: true, time: '08:30', receiver_ids: [a.userId] }] });
  assert.equal((await call(a, 'GET', '/api/smart-reports/push-settings')).items.find((row: { kind: string }) => row.kind === 'sales').time, '08:30');
  await call(a, 'DELETE', `/api/smart-reports/${created.id}`);
  const all = await call(a, 'GET', '/api/report-extra/inventory?only_flow=0');
  const filtered = await call(a, 'GET', '/api/report-extra/inventory?only_flow=0&code=R10-AI');
  assert.ok(all.total > filtered.total);
  assert.equal(filtered.total, 1);
});

test('训练中心按关键词匹配问答集', async () => {
  assert.equal(bestAnswer('怎么新增加工单', [{ id: '1', question: '如何新增加工单', answer: '点新增' }, { id: '2', question: '怎么开票', answer: '去开票' }])?.id, '1');
  await call(a, 'POST', '/api/ai-train/qa', { question: '如何新增加工单', answer: '在加工单列表点新增' }, 201);
  const reply = await call(a, 'POST', '/api/ai-train/chat', { question: '新增加工单怎么做' });
  assert.ok(JSON.stringify(reply).includes('在加工单列表点新增'));
});
