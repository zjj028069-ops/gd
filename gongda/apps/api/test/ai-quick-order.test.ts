import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { guessOrderMapping, resetQuickOrderForTests } from '../src/ai/quick-order.js';

test('表头规则映射：订单列名', () => {
  const mapping = guessOrderMapping(['客户编码', '客户名称', '商品编码', '商品名称', '数量', '单价', '交货日期']);
  assert.equal(mapping.customer_code, '客户编码');
  assert.equal(mapping.customer_name, '客户名称');
  assert.equal(mapping.product_code, '商品编码');
  assert.equal(mapping.quantity, '数量');
  assert.equal(mapping.unit_price, '单价');
});

let db: Database;
let app: FastifyInstance;
type Login = { cookie: string; csrf: string };
let login: Login;
const password = 'LocalTestOnly-AiQuickOrder-Admin!';
const tenantId = randomUUID();
const userId = randomUUID();
let unitId = '';
let productId = '';
let customerId = '';
let processId = '';
let warehouseId = '';

async function doLogin(): Promise<Login> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { tenant_slug: 'ai-qo-demo', username: 'qo.ai', password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(value);
  return { cookie: value.split(';')[0]!, csrf: response.json().csrf_token };
}

function headers(write = false) {
  return { cookie: login.cookie, ...(write ? { 'x-csrf-token': login.csrf } : {}) };
}

async function countTable(table: 'work_orders' | 'sales_orders') {
  return db.admin(async (sql) => {
    const row = (await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE tenant_id=$1`, [tenantId])).rows[0];
    return Number(row?.n ?? '0');
  });
}

function multipart(csv: string, filename = 'order-sample.csv') {
  const boundary = '----AiQoBoundary7MA4YWxk';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csv}\r\n` +
    `--${boundary}--\r\n`;
  return {
    payload: body,
    headers: {
      ...headers(true),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

before(async () => {
  resetQuickOrderForTests();
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenantId, 'ai-qo-demo', 'AI极速下单演示']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      userId, 'qo.ai', '极速下单员', hash,
    ]);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenantId, userId, 'admin']);
  });
  app = await createApp(db);
  login = await doLogin();

  const unitRes = await app.inject({
    method: 'POST',
    url: '/api/units',
    headers: headers(true),
    payload: { code: 'EA', name: '个' },
  });
  assert.equal(unitRes.statusCode, 201, unitRes.body);
  unitId = unitRes.json().unit.id;

  const productRes = await app.inject({
    method: 'POST',
    url: '/api/products',
    headers: headers(true),
    payload: { code: 'QO-FG-1', name: '极速成品甲', unit_id: unitId, attribute: 'manufactured' },
  });
  assert.equal(productRes.statusCode, 201, productRes.body);
  productId = productRes.json().product.id;

  const custRes = await app.inject({
    method: 'POST',
    url: '/api/customers',
    headers: headers(true),
    payload: { request_key: `qo-cust-${randomUUID()}`, code: 'QO-C-1', name: '极速客户甲' },
  });
  assert.equal(custRes.statusCode, 201, custRes.body);
  customerId = custRes.json().customer.id;

  const whRes = await app.inject({
    method: 'POST',
    url: '/api/warehouses',
    headers: headers(true),
    payload: { request_key: `qo-wh-${randomUUID()}`, code: 'QO-WH', name: '极速仓' },
  });
  assert.equal(whRes.statusCode, 201, whRes.body);
  warehouseId = whRes.json().warehouse.id;

  const procRes = await app.inject({
    method: 'POST',
    url: '/api/processes',
    headers: headers(true),
    payload: { code: 'QO-GX', name: '极速工序', description: 'AI4', standard_minutes: '1', reporter_ids: [] },
  });
  assert.equal(procRes.statusCode, 201, procRes.body);
  processId = procRes.json().process.id;
  void warehouseId;
  void processId;
  void productId;
  void customerId;
});

after(async () => {
  await app?.close();
  await db?.close();
});

test('parse 返回预览且不写加工单/销售单', async () => {
  const beforeWo = await countTable('work_orders');
  const beforeSo = await countTable('sales_orders');
  const csv = '客户编码,客户名称,商品编码,商品名称,数量,单价\nQO-C-1,极速客户甲,QO-FG-1,极速成品甲,3,12.5\n';
  const res = await app.inject({ method: 'POST', url: '/api/ai/quick-order/parse', ...multipart(csv) });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.preview_id);
  assert.ok(Array.isArray(body.line_rows));
  assert.equal(body.line_rows.length, 1);
  assert.equal(body.line_rows[0].match, 'matched');
  assert.equal(body.line_rows[0].product_code, 'QO-FG-1');
  assert.ok(body.quota);
  assert.equal(await countTable('work_orders'), beforeWo);
  assert.equal(await countTable('sales_orders'), beforeSo);
});

test('confirm 默认生成加工单，quota 递增，并记 ai_action_log', async () => {
  const beforeWo = await countTable('work_orders');
  const beforeSo = await countTable('sales_orders');
  const quotaBefore = await app.inject({ url: '/api/ai/quick-order/quota', headers: headers() });
  assert.equal(quotaBefore.statusCode, 200);
  const usedBefore = quotaBefore.json().used as number;

  const csv = '商品编码,数量\nQO-FG-1,2\n';
  const parsed = await app.inject({ method: 'POST', url: '/api/ai/quick-order/parse', ...multipart(csv, 'wo.csv') });
  assert.equal(parsed.statusCode, 200, parsed.body);
  const previewId = parsed.json().preview_id as string;
  assert.equal(await countTable('work_orders'), beforeWo);

  const confirm = await app.inject({
    method: 'POST',
    url: '/api/ai/quick-order/confirm',
    headers: headers(true),
    payload: { preview_id: previewId, target: 'work_order' },
  });
  assert.equal(confirm.statusCode, 201, confirm.body);
  const body = confirm.json();
  assert.equal(body.target, 'work_order');
  assert.ok(body.document_id || body.id);
  assert.equal(await countTable('work_orders'), beforeWo + 1);
  assert.equal(await countTable('sales_orders'), beforeSo);
  assert.equal(body.quota.used, usedBefore + 1);

  const log = await db.admin(async (sql) => {
    return (await sql.query<{ action: string; meta: { document_id?: string; target?: string } }>(
      `SELECT action, meta FROM ai_action_log WHERE tenant_id=$1 AND action='quick_order_confirm' ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )).rows[0];
  });
  assert.ok(log);
  assert.equal(log!.meta.target, 'work_order');
  assert.equal(log!.meta.document_id, body.document_id ?? body.id);
});

test('confirm 可生成销售单', async () => {
  const beforeSo = await countTable('sales_orders');
  const csv = '客户编码,商品编码,数量,单价\nQO-C-1,QO-FG-1,5,10\n';
  const parsed = await app.inject({ method: 'POST', url: '/api/ai/quick-order/parse', ...multipart(csv, 'so.csv') });
  assert.equal(parsed.statusCode, 200, parsed.body);
  const previewId = parsed.json().preview_id as string;

  const confirm = await app.inject({
    method: 'POST',
    url: '/api/ai/quick-order/confirm',
    headers: headers(true),
    payload: { preview_id: previewId, target: 'sales_order' },
  });
  assert.equal(confirm.statusCode, 201, confirm.body);
  assert.equal(confirm.json().target, 'sales_order');
  assert.equal(await countTable('sales_orders'), beforeSo + 1);
});

test('cancel 后再 confirm 失败，且不落库', async () => {
  const beforeWo = await countTable('work_orders');
  const csv = '商品编码,数量\nQO-FG-1,1\n';
  const parsed = await app.inject({ method: 'POST', url: '/api/ai/quick-order/parse', ...multipart(csv, 'cancel.csv') });
  assert.equal(parsed.statusCode, 200, parsed.body);
  const previewId = parsed.json().preview_id as string;

  const cancel = await app.inject({
    method: 'POST',
    url: '/api/ai/quick-order/cancel',
    headers: headers(true),
    payload: { preview_id: previewId },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().ok, true);

  const confirm = await app.inject({
    method: 'POST',
    url: '/api/ai/quick-order/confirm',
    headers: headers(true),
    payload: { preview_id: previewId, target: 'work_order' },
  });
  assert.equal(confirm.statusCode, 404, confirm.body);
  assert.equal(confirm.json().error?.code, 'PREVIEW_NOT_FOUND');
  assert.equal(await countTable('work_orders'), beforeWo);
});

test('图片上传返回可编辑空壳，不落库', async () => {
  const beforeWo = await countTable('work_orders');
  const boundary = '----AiQoImgBoundary';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="slip.png"\r\n` +
    `Content-Type: image/png\r\n\r\n`;
  const payload = Buffer.concat([Buffer.from(body, 'utf8'), png, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/ai/quick-order/parse',
    headers: {
      ...headers(true),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  const json = res.json();
  assert.equal(json.doc_type, 'image');
  assert.ok(json.warnings?.some((w: string) => /手录|粘贴/.test(w)));
  assert.equal(await countTable('work_orders'), beforeWo);
});
