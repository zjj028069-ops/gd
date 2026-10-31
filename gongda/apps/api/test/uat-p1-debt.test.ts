import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), admin = randomUUID(), unit = randomUUID();
const password = 'UatP1-TestOnly-LongPassword!';
let session: { cookie: string; csrf: string };
const headers = (write = false) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });
const key = () => randomUUID();

async function call(method: string, url: string, body?: unknown, expected = 200) {
  const response = await app.inject({ method, url, headers: headers(method !== 'GET'), payload: body as never });
  assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
  return response.json();
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'p1-a', 'P1验收']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'p1.admin', 'P1管理员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','个')", [unit, tenant]);
  });
  app = await createApp(db, { localEventsWorker: false });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: 'p1-a', username: 'p1.admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  session = { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0], csrf: response.json().csrf_token };
});
after(async () => { await app.close(); await db.close(); });

test('未引用的供应商可以删除，gd_tenant 具备 DELETE', async () => {
  const privilege = await db.admin(async (sql) => (await sql.query<{ ok: boolean }>('SELECT has_table_privilege(\'gd_tenant\', \'suppliers\', \'DELETE\') AS ok')).rows[0]!.ok);
  assert.equal(privilege, true);
  const supplier = (await call('POST', '/api/money/suppliers', { request_key: key(), name: '可删供应商', contact_name: '甲' }, 201)).supplier;
  const removed = await call('DELETE', `/api/money/suppliers/${supplier.id}`, {});
  assert.equal(removed.ok, true);
  const left = await call('GET', '/api/money/suppliers');
  assert.equal(left.items.some((item: { id: string }) => item.id === supplier.id), false);
  await call('DELETE', `/api/money/suppliers/${supplier.id}`, {}, 404);
});

test('已有采购单或价格规则的供应商返回 409，不是 500', async () => {
  const blocked = (await call('POST', '/api/money/suppliers', { request_key: key(), name: '占用供应商', contact_name: '乙' }, 201)).supplier;
  const product = (await call('POST', '/api/products', { code: 'P1-PART', name: 'P1零件', unit_id: unit, attribute: 'purchased' }, 201)).product;
  await call('POST', '/api/money/purchase-orders', { request_key: key(), supplier_id: blocked.id, lines: [{ product_id: product.id, quantity: '1', unit_price: '10' }] }, 201);
  const denied = await call('DELETE', `/api/money/suppliers/${blocked.id}`, {}, 409);
  assert.equal(denied.error.code, 'SUPPLIER_USED');
  assert.match(denied.error.message, /采购单/);
  const still = await call('GET', '/api/money/suppliers');
  assert.equal(still.items.some((item: { id: string }) => item.id === blocked.id), true);

  const priced = (await call('POST', '/api/money/suppliers', { request_key: key(), name: '价格供应商', contact_name: '丙' }, 201)).supplier;
  const rule = await call('POST', '/api/purchase/price-rules', { supplier_id: priced.id, product_id: product.id, unit_price: '8' }, 201);
  const priceDenied = await call('DELETE', `/api/money/suppliers/${priced.id}`, {}, 409);
  assert.equal(priceDenied.error.code, 'SUPPLIER_USED');
  await call('DELETE', `/api/purchase/price-rules/${rule.id}`);
  const gone = await call('DELETE', `/api/money/suppliers/${priced.id}`);
  assert.equal(gone.ok, true);

  const linked = (await call('POST', '/api/money/suppliers', { request_key: key(), name: '默认供应商', contact_name: '戊' }, 201)).supplier;
  await call('POST', '/api/products', { code: 'P1-DEF', name: '带默认供应商', unit_id: unit, attribute: 'purchased', default_supplier_id: linked.id }, 201);
  const productDenied = await call('DELETE', `/api/money/suppliers/${linked.id}`, {}, 409);
  assert.equal(productDenied.error.code, 'SUPPLIER_USED');
  assert.match(productDenied.error.message, /默认供应商/);
});

test('付款记在指定采购单上，另一张单的已付款不变', async () => {
  const supplier = (await call('POST', '/api/money/suppliers', { request_key: key(), name: '付款供应商', contact_name: '丁' }, 201)).supplier;
  const product = (await call('POST', '/api/products', { code: 'P1-PAY', name: 'P1付款件', unit_id: unit, attribute: 'purchased' }, 201)).product;
  const warehouse = (await call('POST', '/api/warehouses', { request_key: key(), code: 'WH-P1', name: 'P1仓' }, 201)).warehouse;
  const older = (await call('POST', '/api/money/purchase-orders', { request_key: key(), supplier_id: supplier.id, note: '较早一张', lines: [{ product_id: product.id, quantity: '2', unit_price: '100' }] }, 201)).purchase_order;
  const newer = (await call('POST', '/api/money/purchase-orders', { request_key: key(), supplier_id: supplier.id, note: '较新一张', lines: [{ product_id: product.id, quantity: '3', unit_price: '100' }] }, 201)).purchase_order;
  for (const order of [older, newer]) {
    const receipt = (await call('POST', '/api/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: warehouse.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: order.qty }] }, 201)).purchase_receipt;
    await call('POST', `/api/purchase-receipts/${receipt.id}/actions`, { request_key: key(), action: 'approve', version: receipt.version });
  }
  const listed = await call('GET', '/api/money/purchase-orders');
  assert.equal(listed.items[0].id, newer.id);
  const mismatched = await call('POST', `/api/money/purchase-orders/${older.id}/pay`, { order_id: newer.id, amount: '40', pay_date: '2026-10-14' }, 422);
  assert.equal(mismatched.error.code, 'ORDER_MISMATCH');
  const paid = await call('POST', `/api/money/purchase-orders/${older.id}/pay`, { order_id: older.id, amount: '40', pay_date: '2026-10-14', note: '勾选较早一张' });
  assert.equal(paid.payment.order_id, older.id);
  assert.equal(paid.payment.order_code, older.code);
  assert.equal(paid.purchase_order.paid, '40');
  const untouched = (await call('GET', `/api/money/purchase-orders/${newer.id}`)).purchase_order;
  assert.equal(untouched.paid, '0');
  const records = await call('GET', '/api/money/purchase-payments');
  const hit = records.items.find((item: { order_id: string }) => item.order_id === older.id);
  assert.equal(hit.order_code, older.code);
  assert.equal(records.items.some((item: { order_id: string }) => item.order_id === newer.id), false);

  const batch = await call('POST', '/api/money/purchase-orders/batch-pay', { pay_date: '2026-10-14', lines: [{ id: older.id, amount: '10' }, { id: newer.id, amount: '30' }] });
  assert.equal(batch.ids.length, 2);
  const olderAfter = (await call('GET', `/api/money/purchase-orders/${older.id}`)).purchase_order;
  const newerAfter = (await call('GET', `/api/money/purchase-orders/${newer.id}`)).purchase_order;
  assert.equal(olderAfter.paid, '50');
  assert.equal(newerAfter.paid, '30');
  const again = await call('GET', '/api/money/purchase-payments');
  const olderPays = again.items.filter((item: { order_id: string }) => item.order_id === older.id);
  const newerPays = again.items.filter((item: { order_id: string }) => item.order_id === newer.id);
  assert.equal(olderPays.length, 2);
  assert.equal(newerPays.length, 1);
  assert.equal(newerPays[0].order_code, newer.code);
});
