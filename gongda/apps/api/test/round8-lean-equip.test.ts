import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), admin = randomUUID(), unit = randomUUID();
const password = 'Round8-Lean-Equip-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login;
let seq = 1;
const headers = (write = false) => ({ cookie: a.cookie, ...(write ? { 'x-csrf-token': a.csrf } : {}) });
const key = () => randomUUID();
async function call(method: string, url: string, body?: unknown, expected = 200) {
  const response = await app.inject({ method, url, headers: headers(method !== 'GET'), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'round8-a', '第八轮']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'round8.admin', '第八轮管理员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','台')", [unit, tenant]);
  });
  app = await createApp(db, { localEventsWorker: false });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.' + (seq++), payload: { tenant_slug: 'round8-a', username: 'round8.admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  a = { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, csrf: response.json().csrf_token };
});
after(async () => { await app?.close(); await db?.close(); });

test('不良品项编号可空且名称唯一', async () => {
  const created = await call('POST', '/api/quality/defects', { name: '松动' }, 201);
  assert.match(created.item.code, /^BL\d+$/);
  await call('POST', '/api/quality/defects', { name: '松动' }, 409);
  await call('POST', '/api/quality/defects', { name: '' }, 422);
});

test('全检从待质检到已质检，返工数不能超过不良品数', async () => {
  const product = (await call('POST', '/api/products', { code: 'R8-FG', name: '第八轮成品', unit_id: unit, attribute: 'manufactured' }, 201)).product;
  const process = (await call('POST', '/api/processes', { code: 'R8-GX', name: '第八轮工序', standard_minutes: '1', reporter_ids: [admin], pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'full' }, 201)).process;
  const warehouse = (await call('POST', '/api/warehouses', { request_key: key(), code: 'R8-WH', name: '第八轮仓' }, 201)).warehouse;
  const order = (await call('POST', '/api/work-orders', { request_key: key(), code: '', product_id: product.id, quantity: '10', warehouse_id: warehouse.id, priority: 'normal', tasks: [{ process_id: process.id }] }, 201)).work_order;
  const task = order.tasks[0];
  await call('POST', `/api/work-orders/${order.id}/tasks/${task.id}/actions`, { action: 'start', version: task.version });
  const report = (await call('POST', '/api/production-reports', { request_key: key(), task_id: task.id, good_qty: '8', defect_qty: '2', rework_qty: '0', scrap_qty: '0', defect_note: '松动' }, 201)).report;
  const pending = await call('GET', '/api/quality/inspections?status=待质检');
  assert.ok(pending.items.some((item: { id: string; quality_text: string }) => item.id === report.id && item.quality_text === '待质检'));
  const defect = (await call('POST', '/api/quality/defects', { name: '异响' }, 201)).item;
  await call('POST', `/api/quality/inspections/${report.id}`, { quality_status: '已质检', quality_note: '复检', defect_qty: '2', rework_qty: '3', scrap_qty: '0', defect_item_ids: [defect.id] }, 422);
  const done = await call('POST', `/api/quality/inspections/${report.id}`, { quality_status: '已质检', quality_note: '复检', defect_qty: '2', rework_qty: '1', scrap_qty: '0', defect_item_ids: [defect.id] });
  assert.equal(done.quality_text, '已质检');
  assert.match(done.rework_task_code, /^FG/);
  assert.equal(done.defect_names, '异响');
});

test('外协结算金额等于合格数乘单价', async () => {
  const product = (await call('POST', '/api/products', { code: 'R8-OS', name: '外协件', unit_id: unit, attribute: 'manufactured' }, 201)).product;
  const order = (await call('POST', '/api/outsource/orders', { product_id: product.id, plan_qty: '5', unit_price: '10', priority: '正常' }, 201)).order;
  assert.equal(order.status, '未开始');
  await call('POST', `/api/outsource/orders/${order.id}/actions`, { action: '开始' });
  const receipt = await call('POST', '/api/outsource/receipts', { order_id: order.id, pass_qty: '2', fail_qty: '0' }, 201);
  const settled = await call('POST', `/api/outsource/receipts/${receipt.id}/settle`, {});
  assert.equal(settled.settle_status, '已结算');
  assert.equal(settled.settle_amount, '20');
  const cost = await call('GET', '/api/biz-reports/cost');
  assert.ok(cost.items.some((item: { id: string; outsource: string }) => item.id === order.id && Number(item.outsource) === 20));
});

test('机台状态只能是中文枚举', async () => {
  const category = await call('POST', '/api/machines/categories', { name: '数控车床' }, 201);
  await call('POST', '/api/machines', { name: '一号机', status: '报废', category_id: category.id }, 422);
  const machine = await call('POST', '/api/machines', { name: '一号机', status: '运行中', category_id: category.id }, 201);
  assert.equal(machine.status, '运行中');
  const list = await call('GET', '/api/machines');
  assert.equal(list.items.find((item: { id: string }) => item.id === machine.id).status, '运行中');
});

test('整改中心关联显示中文来源或可读标题，不返回 uuid', async () => {
  const created = await call('POST', '/api/lean/patrols', { department_name: '生产管理部', category: '生产问题', description: '关联不露编号' }, 201);
  const patrols = await call('GET', `/api/lean/rectify?source=${encodeURIComponent('现场巡查')}`);
  const fresh = patrols.items.find((item: { description: string }) => item.description === '关联不露编号');
  assert.ok(fresh);
  assert.equal(fresh.ref_code, '现场巡查');
  assert.notEqual(fresh.ref_code, created.id);
  const legacy = randomUUID();
  await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => {
    await sql.query("INSERT INTO r8_rectify(tenant_id,source,description,status,ref_code) VALUES($1,'客户投诉','历史投诉','待处理',$2)", [tenant, legacy]);
    await sql.query("INSERT INTO r8_rectify(tenant_id,source,description,status,ref_code) VALUES($1,'生产质检','返工标题','待处理','FG0009')", [tenant]);
    await sql.query("INSERT INTO r8_rectify(tenant_id,source,description,status,ref_code) VALUES($1,'物料问题','没有关联','待处理','')", [tenant]);
  });
  const complaints = await call('GET', `/api/lean/rectify?source=${encodeURIComponent('客户投诉')}`);
  assert.equal(complaints.items.find((item: { description: string }) => item.description === '历史投诉').ref_code, '客户投诉');
  const quality = await call('GET', `/api/lean/rectify?source=${encodeURIComponent('生产质检')}`);
  assert.equal(quality.items.find((item: { description: string }) => item.description === '返工标题').ref_code, 'FG0009');
  const materials = await call('GET', `/api/lean/rectify?source=${encodeURIComponent('物料问题')}`);
  assert.equal(materials.items.find((item: { description: string }) => item.description === '没有关联').ref_code, '');
});

test('销售对账单只汇总已审合同欠款', async () => {
  const customer = randomUUID();
  const draft = randomUUID();
  const approved = randomUUID();
  await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => {
    await sql.query('INSERT INTO customers(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [customer, tenant, 'KH-R8', '欠款客户']);
    await sql.query('INSERT INTO money_contracts(id,tenant_id,code,customer_id,amount,qty,salesperson_id,approval,created_by) VALUES($1,$2,$3,$4,1000,1,$5,$6,$5)', [draft, tenant, 'HT-DRAFT', customer, admin, 'draft']);
    await sql.query('INSERT INTO money_contracts(id,tenant_id,code,customer_id,amount,qty,prepay,salesperson_id,approval,created_by) VALUES($1,$2,$3,$4,10000,1,1000,$5,$6,$5)', [approved, tenant, 'HT-OK', customer, admin, 'approved']);
    await sql.query("INSERT INTO money_cash(tenant_id,contract_id,customer_id,direction,amount,approval,created_by) VALUES($1,$2,$3,'in',1000,'approved',$4)", [tenant, approved, customer, admin]);
  });
  const report = await call('GET', '/api/biz-reports/sales?period=本年&debt=有欠款');
  const row = report.items.find((item: { customer_name: string }) => item.customer_name === '欠款客户');
  assert.ok(row);
  assert.equal(row.contract_count, 1);
  assert.equal(Number(row.amount), 10000);
  assert.equal(Number(row.debt), 9000);
});

test('销售对账单行出库与退货明细按已审合同出数', async () => {
  const customer = randomUUID();
  const contract = randomUUID();
  const line = randomUUID();
  const warehouse = randomUUID();
  const product = randomUUID();
  const shipment = randomUUID();
  const shipmentLine = randomUUID();
  const bill = randomUUID();
  const billLine = randomUUID();
  await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => {
    await sql.query('INSERT INTO customers(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [customer, tenant, 'KH-STMT', '对账明细客户']);
    await sql.query('INSERT INTO warehouses(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [warehouse, tenant, 'WH-STMT', '对账仓']);
    await sql.query("INSERT INTO products(id,tenant_id,code,name,specification,unit_id,attribute) VALUES($1,$2,$3,$4,$5,$6,'purchased')", [product, tenant, 'SP-STMT', '对账喷嘴', 'Φ20', unit]);
    await sql.query("INSERT INTO money_contracts(id,tenant_id,code,customer_id,amount,qty,salesperson_id,approval,created_by) VALUES($1,$2,$3,$4,100,10,$5,'approved',$5)", [contract, tenant, 'HT-STMT', customer, admin]);
    await sql.query('INSERT INTO money_contract_lines(id,tenant_id,contract_id,line_no,product_id,product_name,product_code,specification,unit_name,unit_price,quantity,amount,net_amount,note) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,10,10,100,100,$9)', [line, tenant, contract, product, '对账喷嘴', 'SP-STMT', 'Φ20', '台', '行备注']);
    await sql.query("INSERT INTO shipments(id,tenant_id,code,warehouse_id,customer_id,contract_id,ship_date,approval,audit_status,created_by) VALUES($1,$2,$3,$4,$5,$6,current_date,'approved','exempt',$7)", [shipment, tenant, 'HTCK-STMT', warehouse, customer, contract, admin]);
    await sql.query('INSERT INTO shipment_lines(id,tenant_id,shipment_id,contract_line_id,product_id,unit_id,quantity,unit_price,amount_cents) VALUES($1,$2,$3,$4,$5,$6,2,10,2000)', [shipmentLine, tenant, shipment, line, product, unit]);
    await sql.query("INSERT INTO warehouse_misc_bills(id,tenant_id,bill_kind,code,warehouse_id,contract_id,note,approval,audit_status,created_by) VALUES($1,$2,'sales_return',$3,$4,$5,$6,'approved','exempt',$7)", [bill, tenant, 'XSTH-STMT', warehouse, contract, '退货备注', admin]);
    await sql.query('INSERT INTO warehouse_misc_bill_lines(id,tenant_id,bill_id,product_id,unit_id,quantity,unit_price,amount_cents) VALUES($1,$2,$3,$4,$5,1,10,1000)', [billLine, tenant, bill, product, unit]);
  });
  const outbound = await call('GET', `/api/biz-reports/sales/${customer}/outbound?period=本年`);
  assert.equal(outbound.summary.qty, '2');
  assert.equal(outbound.summary.amount, '20');
  assert.equal(outbound.items.length, 1);
  assert.equal(outbound.items[0].shipment_code, 'HTCK-STMT');
  assert.equal(outbound.items[0].warehouse_name, '对账仓');
  assert.equal(outbound.items[0].contract_code, 'HT-STMT');
  assert.equal(outbound.items[0].audit_status, 'exempt');
  assert.equal(outbound.items[0].product_name, '对账喷嘴');
  assert.equal(outbound.items[0].product_code, 'SP-STMT');
  assert.equal(outbound.items[0].specification, 'Φ20');
  assert.equal(outbound.items[0].note, '行备注');
  assert.equal(outbound.items[0].color_desc, '');
  const returns = await call('GET', `/api/biz-reports/sales/${customer}/returns?period=本年`);
  assert.equal(returns.summary.qty, '1');
  assert.equal(returns.summary.amount, '10');
  assert.equal(returns.items[0].return_code, 'XSTH-STMT');
  assert.equal(returns.items[0].shipment_code, '');
  assert.equal(returns.items[0].product_name, '对账喷嘴');
  assert.equal(returns.items[0].note, '行备注');
  const yesterday = await call('GET', `/api/biz-reports/sales/${customer}/outbound?period=昨天`);
  assert.equal(yesterday.items.length, 0);
  const missing = await call('GET', '/api/biz-reports/sales/not-a-uuid/outbound?period=本年');
  assert.deepEqual(missing.items, []);
  assert.equal(missing.summary.qty, '0');
  assert.equal(missing.summary.amount, '0');
});
