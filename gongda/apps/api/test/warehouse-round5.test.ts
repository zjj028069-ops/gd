import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { evalWarehouseAmount, mapChineseFormula, purchaseStockSummary, contractOutbound, resolveLedgerKind } from '../src/warehouse-stock.js';
import { evaluateFormula } from '../src/formula.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), admin = randomUUID(), unit = randomUUID();
const password = 'Warehouse-R5-TestPassword!';
let session: { cookie: string; csrf: string };
const headers = (write = false) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });
const key = () => randomUUID();

async function login() {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: 'wh-r5', username: 'wh.admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  session = { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0], csrf: response.json().csrf_token };
}
async function post(url: string, body: unknown, expected = 201) {
  const response = await app.inject({ method: 'POST', url, headers: headers(true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function put(url: string, body: unknown, expected = 200) {
  const response = await app.inject({ method: 'PUT', url, headers: headers(true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function get(url: string, expected = 200) {
  const response = await app.inject({ method: 'GET', url, headers: headers() });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

let part = '';

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'wh-r5', '仓库R5']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'wh.admin', '仓库管理员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
    await sql.query('INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [unit, tenant, 'EA', '个']);
  });
  app = await createApp(db, { localEventsWorker: false });
  await login();
  part = (await post('/api/products', { code: 'WH-P', name: '采购件', unit_id: unit, attribute: 'purchased' })).product.id;
});
after(async () => { await app.close(); await db.close(); });

test('仓库公式中文变量映射与默认公式', () => {
  const mapped = mapChineseFormula('${明细.采购单价}*${明细.采购数量}', 'purchase_in');
  assert.equal(mapped, 'unit_price*quantity');
  assert.equal(evalWarehouseAmount('purchase_in', '${明细.采购单价}*${明细.采购数量}', '90', '110', 8), '9900');
  assert.equal(evalWarehouseAmount('sale_return', '${明细.销售单价}*${明细.退货数量}', '90', '110', 8), '9900');
  assert.equal(evalWarehouseAmount('sale_return', '${明细.销售单价}*${明细.退货数量}', '155', '90', 8), '13950');
  assert.equal(evalWarehouseAmount('purchase_in', '${明细.采购单价}*${明细.采购数量}', '90', '110', 8), evalWarehouseAmount('purchase_in', mapped, '90', '110', 8));
  assert.throws(() => evaluateFormula('bad*1', [{ name: 'good' }], { good: '1' }), /未声明变量/);
});

test('postStock 写入结余且同仓同品流水相接', async () => {
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '结余仓', province: '渝', city: '重庆', district: '渝北', address: '测试路1号' })).warehouse;
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-W', name: '结余供应商' })).supplier;
  const order = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-01-01', lines: [{ product_id: part, quantity: '100', unit_price: '10' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '30' }] });
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '20' }] });
  const ledger = await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => sql.query<{ balance_after: string; direction: string }>(
    "SELECT balance_after::text,direction FROM stock_ledger WHERE warehouse_id=$1 AND product_id=$2 ORDER BY posted_at,id",
    [wh.id, part],
  ));
  assert.equal(ledger.rows.length, 2);
  assert.equal(ledger.rows[0].balance_after, '30.000000');
  assert.equal(ledger.rows[1].balance_after, '50.000000');
});

test('purchaseStockSummary 与采购单汇总一致', async () => {
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '汇总仓', province: '渝', city: '重庆', district: '渝北', address: '测试路2号' })).warehouse;
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-S', name: '汇总供应商' })).supplier;
  const order = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-01-02', lines: [{ product_id: part, quantity: '70', unit_price: '10' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '30' }] });
  const summary = await db.tenant({ tenantId: tenant, userId: admin }, (sql) => purchaseStockSummary(sql, order.id));
  assert.equal(summary.receipt_count, 1);
  assert.equal(summary.lines[0].progress, '42.85% (30/70)');
  const detail = (await app.inject({ url: `/api/money/purchase-orders/${order.id}`, headers: headers() })).json().purchase_order;
  assert.equal(detail.inbound_amount, summary.inbound_amount);
  assert.equal(detail.receipt_count, summary.receipt_count);
});

test('合同出库进度与数量限制', async () => {
  const customer = (await post('/api/money/customers', { request_key: key(), name: '出库客户', contact_name: '出库客户', contact_phone: '13900000001' })).customer;
  let approved = (await post('/api/money/contracts', {
    request_key: key(), customer_id: customer.id, contact_name: '出库客户', salesperson_id: admin,
    lines: [{ product_id: part, quantity: '100', unit_price: '50' }],
  })).contract;
  if (approved.approval === 'pending') {
    approved = (await post(`/api/money/contracts/${approved.id}/actions`, { action: 'approve', version: approved.version, opinion: 'ok' }, 200)).contract;
  }
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '出库仓', province: '渝', city: '重庆', district: '渝北', address: '测试路3号' })).warehouse;
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-O', name: '出库供应商' })).supplier;
  const order = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-01-05', lines: [{ product_id: part, quantity: '100', unit_price: '10' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '100' }] });
  await post('/api/warehouse/shipments', { request_key: key(), contract_id: approved.id, warehouse_id: wh.id, lines: [{ contract_line_id: approved.lines[0].id, quantity: '30' }] });
  const outbound = await db.tenant({ tenantId: tenant, userId: admin }, (sql) => contractOutbound(sql, approved.id));
  assert.equal(outbound.shipment_count, 1);
  assert.equal(outbound.lines[0].progress, '30% (30/100)');
  let settings = (await app.inject({ url: '/api/warehouse/settings', headers: headers() })).json().settings;
  await put('/api/warehouse/settings', { ...settings, limit_contract_out: true });
  const over = await post('/api/warehouse/shipments', { request_key: key(), contract_id: approved.id, warehouse_id: wh.id, lines: [{ contract_line_id: approved.lines[0].id, quantity: '80' }] }, 422);
  assert.match(over.error.message, /出库数量超过合同销售数量/);
  settings = (await app.inject({ url: '/api/warehouse/settings', headers: headers() })).json().settings;
  await put('/api/warehouse/settings', { ...settings, limit_contract_out: false });
  await post('/api/warehouse/shipments', { request_key: key(), contract_id: approved.id, warehouse_id: wh.id, lines: [{ contract_line_id: approved.lines[0].id, quantity: '70' }] });
});

test('采购退货单回写汇总且 money returns 返回 410', async () => {
  const blocked = await post('/api/money/purchase-orders/00000000-0000-0000-0000-000000000099/returns', { amount: '1' }, 410);
  assert.equal(blocked.error.code, 'GONE');
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '退货仓', province: '渝', city: '重庆', district: '渝北', address: '测试路4号' })).warehouse;
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-R', name: '退货供应商' })).supplier;
  const order = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-01-06', lines: [{ product_id: part, quantity: '20', unit_price: '10' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '20' }] });
  await post('/api/warehouse/purchase-returns', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '10' }] });
  const summary = await db.tenant({ tenantId: tenant, userId: admin }, (sql) => purchaseStockSummary(sql, order.id));
  assert.equal(summary.return_count, 1);
  const detail = (await app.inject({ url: `/api/money/purchase-orders/${order.id}`, headers: headers() })).json().purchase_order;
  assert.equal(detail.return_amount, summary.return_amount);
});

test('调拨单一步完成两仓 ±20', async () => {
  const whA = (await post('/api/warehouse/warehouses', { request_key: key(), name: '调拨A', province: '渝', city: '重庆', district: '渝北', address: 'A' })).warehouse;
  const whB = (await post('/api/warehouse/warehouses', { request_key: key(), name: '调拨B', province: '渝', city: '重庆', district: '渝北', address: 'B' })).warehouse;
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-T', name: '调拨供应商' })).supplier;
  const order = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-02-01', lines: [{ product_id: part, quantity: '50', unit_price: '10' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: whA.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '50' }] });
  await post('/api/warehouse/transfer-bills', { request_key: key(), from_warehouse_id: whA.id, to_warehouse_id: whB.id, lines: [{ product_id: part, quantity: '20' }] });
  const balances = await get(`/api/warehouse/stock/balances?view=warehouse&only_positive=false`);
  const a = balances.items.find((r: { warehouse_id: string; product_id: string }) => r.warehouse_id === whA.id && r.product_id === part);
  const b = balances.items.find((r: { warehouse_id: string; product_id: string }) => r.warehouse_id === whB.id && r.product_id === part);
  assert.equal(a?.on_hand, '30.000000');
  assert.equal(b?.on_hand, '20.000000');
});

test('盘点草稿不过账，确认后写流水', async () => {
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '盘点仓', province: '渝', city: '重庆', district: '渝北', address: '盘' })).warehouse;
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-C', name: '盘点供应商' })).supplier;
  const order = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-02-02', lines: [{ product_id: part, quantity: '10', unit_price: '10' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '10' }] });
  // WHY: Round11 API requires taker_id（请选择盘点人）; pass admin as taker — adapts to required field, does not weaken draft/confirm ledger assertions.
  const draft = (await post('/api/warehouse/stock-taking-bills', { request_key: key(), warehouse_id: wh.id, taker_id: admin, confirm: false, lines: [{ product_id: part, actual_qty: '8' }] })).stock_taking;
  assert.equal(draft.state, 'draft');
  const before = await db.tenant({ tenantId: tenant, userId: admin }, (sql) => sql.query('SELECT count(*)::text AS n FROM stock_ledger WHERE source_type=$1', ['stock_count']));
  assert.equal(before.rows[0]!.n, '0');
  await post(`/api/warehouse/stock-taking-bills/${draft.id}/confirm`, { request_key: key(), version: draft.version }, 200);
  const after = await db.tenant({ tenantId: tenant, userId: admin }, (sql) => sql.query('SELECT count(*)::text AS n FROM stock_ledger WHERE source_type=$1 AND source_id=$2', ['stock_count', draft.id]));
  assert.equal(after.rows[0]!.n, '1');
});

test('其他入库销售金额按公式', async () => {
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '其他入', province: '渝', city: '重庆', district: '渝北', address: '入' })).warehouse;
  const bill = (await post('/api/warehouse/misc-bills?kind=else_in', { request_key: key(), kind: 'else_in', warehouse_id: wh.id, lines: [{ product_id: part, quantity: '110', unit_price: '90' }] })).misc_bill;
  assert.equal(bill.lines[0].amount_cents, '990000');
});

test('成品入库计划数量限制开/关', async () => {
  const fg = (await post('/api/products', { code: 'WH-FG', name: '成品件', unit_id: unit, attribute: 'manufactured' })).product;
  const proc = (await post('/api/processes', { code: 'GX-WH', name: '装配', description: '测', standard_minutes: '1', reporter_ids: [admin] })).process;
  const route = (await post('/api/routes', { code: 'RT-WH', name: '路线', description: '测', steps: [{ process_id: proc.id, auto_inbound: true }] })).route;
  const bom = (await post('/api/boms', { parent_product_id: fg.id, description: '测', route_version_id: route.current_version_id, items: [{ component_product_id: part, quantity: '1', loss_rate: '0' }] })).bom;
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '成品仓', province: '渝', city: '重庆', district: '渝北', address: '成' })).warehouse;
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-FG', name: '成品供' })).supplier;
  const po = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-02-03', lines: [{ product_id: part, quantity: '100', unit_price: '1' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: po.id, warehouse_id: wh.id, lines: [{ purchase_line_id: po.lines[0].id, quantity: '100' }] });
  const wo = (await post('/api/work-orders', { request_key: key(), product_id: fg.id, quantity: '10', route_version_id: route.current_version_id, bom_version_id: bom.current_version_id, warehouse_id: wh.id })).work_order;
  let settings = (await get('/api/warehouse/settings')).settings;
  await put('/api/warehouse/settings', { ...settings, limit_fg_in: false });
  await post('/api/warehouse/material-issues', { request_key: key(), work_order_id: wo.id, sets: '10' });
  await post('/api/warehouse/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '6' });
  const blocked = await post('/api/warehouse/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '5' }, 422);
  assert.match(blocked.error.message, /计划数量/);
  settings = (await get('/api/warehouse/settings')).settings;
  await put('/api/warehouse/settings', { ...settings, limit_fg_in: true });
  await post('/api/warehouse/fg-receipts', { request_key: key(), work_order_id: wo.id, quantity: '5' });
});

test('库存下限报警写入站内通知', async () => {
  const alertPart = (await post('/api/products', { code: 'WH-ALERT', name: '报警件', unit_id: unit, attribute: 'purchased', stock_lower_warn: '50' })).product;
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '报警仓', province: '渝', city: '重庆', district: '渝北', address: '警' })).warehouse;
  const settings = (await get('/api/warehouse/settings')).settings;
  await put('/api/warehouse/settings', { ...settings, alert_user_ids: [admin] });
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-A', name: '报警供' })).supplier;
  const order = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-02-04', lines: [{ product_id: alertPart.id, quantity: '30', unit_price: '10' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '30' }] });
  await get('/api/warehouse/stock/balances?view=product&only_positive=true');
  const notes = await db.tenant({ tenantId: tenant, userId: admin }, (sql) => sql.query('SELECT title,message FROM user_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5', [admin]));
  assert.ok(notes.rows.some((r) => r.title === '库存下限报警' && String(r.message).includes('WH-ALERT')));
});

test('出入库流水单据类型与主线英文 source_type 映射', () => {
  assert.equal(resolveLedgerKind('material_issue', 'out', null), '生产出库');
  assert.equal(resolveLedgerKind('adjustment', 'in', null), '其他入库');
  assert.equal(resolveLedgerKind('adjustment', 'out', null), '其他出库');
  assert.equal(resolveLedgerKind('purchase_receipt', 'in', '采购入库'), '采购入库');
});

test('销售退货 110×90 提交成功并回写出库与欠款', async () => {
  const customer = (await post('/api/money/customers', { request_key: key(), name: '退货客户', contact_name: '退货客户', contact_phone: '13900000009' })).customer;
  let contract = (await post('/api/money/contracts', {
    request_key: key(), customer_id: customer.id, contact_name: '退货客户', salesperson_id: admin, prepay: '0',
    lines: [{ product_id: part, quantity: '200', unit_price: '90' }],
  })).contract;
  if (contract.approval === 'pending') {
    contract = (await post(`/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version, opinion: 'ok' }, 200)).contract;
  }
  const before = (await get(`/api/money/contracts/${contract.id}`)).contract;
  const wh = (await post('/api/warehouse/warehouses', { request_key: key(), name: '退货仓', province: '渝', city: '重庆', district: '渝北', address: '测试路9号' })).warehouse;
  const supplier = (await post('/api/money/suppliers', { code: 'GYS-TH', name: '退货供应商' })).supplier;
  const order = (await post('/api/money/purchase-orders', { supplier_id: supplier.id, order_date: '2026-03-01', lines: [{ product_id: part, quantity: '200', unit_price: '10' }] })).purchase_order;
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: wh.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '120' }] });
  await post('/api/warehouse/shipments', { request_key: key(), contract_id: contract.id, warehouse_id: wh.id, lines: [{ contract_line_id: contract.lines[0].id, quantity: '120' }] });
  const created = await post('/api/warehouse/misc-bills', {
    request_key: key(), bill_kind: 'sales_return', warehouse_id: wh.id, contract_id: contract.id,
    lines: [{ product_id: part, quantity: '110' }],
  });
  assert.equal(created.misc_bill.lines[0].amount_cents, '990000');
  const list = await get('/api/warehouse/misc-bills?kind=sales_return');
  assert.ok(list.items.some((item: { id: string }) => item.id === created.misc_bill.id));
  const after = (await get(`/api/money/contracts/${contract.id}`)).contract;
  assert.ok(Number(after.debt) < Number(before.debt));
  const outbound = await db.tenant({ tenantId: tenant, userId: admin }, (sql) => contractOutbound(sql, contract.id));
  assert.equal(outbound.lines[0].shipped_qty, '10.000000');
  const ledger = await get('/api/warehouse/stock/ledger?source_type=sales_return');
  const row = ledger.items.find((item: { source_id: string }) => item.source_id === created.misc_bill.id);
  assert.equal(row.direction, 'in');
  assert.equal(row.doc_type, '销售退货');
});
