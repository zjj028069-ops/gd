import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { guessMapping, parseSpreadsheet, resetBomPreviewsForTests } from '../src/ai/bom.js';

test('表头规则映射：中英列名', () => {
  const mapping = guessMapping(['物料编码', '物料名称', '规格', '单位', '用量', '备注']);
  assert.equal(mapping.code, '物料编码');
  assert.equal(mapping.name, '物料名称');
  assert.equal(mapping.spec, '规格');
  assert.equal(mapping.unit, '单位');
  assert.equal(mapping.quantity, '用量');

  const en = guessMapping(['Item_Code', 'Name', 'Qty', 'Unit']);
  assert.ok(en.code || en.quantity);
});

test('CSV 解析出列与行，不依赖业务库', () => {
  const csv = '物料编码,物料名称,用量\nMAT-A,钢板,2\nMAT-B,螺丝,10\n';
  const parsed = parseSpreadsheet(Buffer.from(csv, 'utf8'), 'sample.csv');
  assert.deepEqual(parsed.columns, ['物料编码', '物料名称', '用量']);
  assert.equal(parsed.matrix.length, 2);
  assert.equal(parsed.matrix[0]![0], 'MAT-A');
});

let db: Database;
let app: FastifyInstance;
type Login = { cookie: string; csrf: string };
let login: Login;
const password = 'LocalTestOnly-AiBom-Admin!';
const tenantId = randomUUID();
const userId = randomUUID();
let unitId = '';
let parentId = '';
let partA = '';
let partB = '';

async function doLogin(): Promise<Login> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { tenant_slug: 'ai-bom-demo', username: 'bom.ai', password },
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

async function bomCount() {
  return db.admin(async (sql) => {
    const row = (await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM bom_definitions WHERE tenant_id=$1', [tenantId])).rows[0];
    return Number(row?.n ?? '0');
  });
}

function multipart(csv: string, filename = 'bom-sample.csv') {
  const boundary = '----AiBomBoundary7MA4YWxk';
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
  resetBomPreviewsForTests();
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenantId, 'ai-bom-demo', 'AI BOM演示']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      userId, 'bom.ai', 'BOM导入员', hash,
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

  async function product(code: string, name: string, attribute: 'manufactured' | 'purchased') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: headers(true),
      payload: { code, name, unit_id: unitId, attribute },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().product.id as string;
  }

  parentId = await product('PARENT-AI-BOM', '成品壳', 'manufactured');
  partA = await product('MAT-AI-A', '钢板A', 'purchased');
  partB = await product('MAT-AI-B', '螺丝B', 'purchased');
  void partA;
  void partB;
});

after(async () => {
  await app?.close();
  await db?.close();
});

test('parse 返回预览且不写 BOM 表', async () => {
  const before = await bomCount();
  const csv = '物料编码,物料名称,规格,单位,用量\nMAT-AI-A,钢板A,3mm,个,2\nMAT-AI-B,螺丝B,M4,个,8\n';
  const { payload, headers: hdrs } = multipart(csv);
  const res = await app.inject({ method: 'POST', url: '/api/ai/bom/parse', headers: hdrs, payload });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.preview_id);
  assert.ok(Array.isArray(body.rows));
  assert.equal(body.rows.length, 2);
  assert.equal(body.rows[0].match, 'matched');
  assert.equal(body.mapping.code, '物料编码');
  assert.equal(body.mapping.quantity, '用量');
  const after = await bomCount();
  assert.equal(after, before, 'parse 不得写入 bom_definitions');
});

test('confirm 写入 BOM，并记 ai_action_log', async () => {
  const before = await bomCount();
  const csv = '物料编码,物料名称,用量\nMAT-AI-A,钢板A,1.5\nMAT-AI-B,螺丝B,4\n';
  const parsed = await app.inject({ method: 'POST', url: '/api/ai/bom/parse', ...multipart(csv, 'confirm.csv') });
  assert.equal(parsed.statusCode, 200, parsed.body);
  const previewId = parsed.json().preview_id as string;
  assert.equal(await bomCount(), before);

  const confirm = await app.inject({
    method: 'POST',
    url: '/api/ai/bom/confirm',
    headers: headers(true),
    payload: { preview_id: previewId, product_id: parentId, name: 'AI导入测试BOM' },
  });
  assert.equal(confirm.statusCode, 201, confirm.body);
  const body = confirm.json();
  assert.ok(body.bom?.id);
  assert.ok(body.bom_version_id);
  assert.equal(body.items_count, 2);
  assert.equal(await bomCount(), before + 1);

  const log = await db.admin(async (sql) => {
    const row = (await sql.query<{ action: string; meta: { bom_id?: string; bom_version_id?: string } }>(
      `SELECT action, meta FROM ai_action_log WHERE tenant_id=$1 AND action='bom_import_confirm' ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )).rows[0];
    return row;
  });
  assert.ok(log);
  assert.equal(log!.action, 'bom_import_confirm');
  assert.equal(log!.meta.bom_id, body.bom.id);
  assert.equal(log!.meta.bom_version_id, body.bom_version_id);
});

test('cancel 后 confirm 失败，且不落库', async () => {
  const before = await bomCount();
  const csv = '物料编码,用量\nMAT-AI-A,3\n';
  const parsed = await app.inject({ method: 'POST', url: '/api/ai/bom/parse', ...multipart(csv, 'cancel.csv') });
  assert.equal(parsed.statusCode, 200, parsed.body);
  const previewId = parsed.json().preview_id as string;

  const cancel = await app.inject({
    method: 'POST',
    url: '/api/ai/bom/cancel',
    headers: headers(true),
    payload: { preview_id: previewId },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().ok, true);

  const confirm = await app.inject({
    method: 'POST',
    url: '/api/ai/bom/confirm',
    headers: headers(true),
    payload: { preview_id: previewId, product_id: parentId },
  });
  assert.equal(confirm.statusCode, 404, confirm.body);
  assert.equal(confirm.json().error?.code, 'PREVIEW_NOT_FOUND');
  assert.equal(await bomCount(), before);
});

test('可保存映射方案', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/ai/bom/schemes',
    headers: headers(true),
    payload: { name: '默认中文表头', mapping: { code: '物料编码', quantity: '用量' } },
  });
  assert.equal(res.statusCode, 201, res.body);
  const list = await app.inject({ url: '/api/ai/bom/schemes', headers: headers() });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().items.some((item: { name: string }) => item.name === '默认中文表头'));
});
