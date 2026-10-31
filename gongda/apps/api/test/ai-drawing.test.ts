import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { resetDrawingForTests } from '../src/ai/drawing.js';

let db: Database;
let app: FastifyInstance;
type Login = { cookie: string; csrf: string };
let login: Login;
const password = 'LocalTestOnly-AiDrawing-Admin!';
const tenantId = randomUUID();
const userId = randomUUID();

async function doLogin(): Promise<Login> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { tenant_slug: 'ai-draw-demo', username: 'draw.ai', password },
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

async function countRoutes() {
  return db.admin(async (sql) => {
    const row = (await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM process_routes WHERE tenant_id=$1', [tenantId])).rows[0];
    return Number(row?.n ?? '0');
  });
}

async function countProcesses() {
  return db.admin(async (sql) => {
    const row = (await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM processes WHERE tenant_id=$1', [tenantId])).rows[0];
    return Number(row?.n ?? '0');
  });
}

function multipartPng(filename = 'drawing.png', note = '') {
  const boundary = '----AiDrawBoundary7MA4YWxk';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const chunks: Buffer[] = [];
  if (note) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="note"\r\n\r\n` +
      `${note}\r\n`,
      'utf8',
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: image/png\r\n\r\n`,
    'utf8',
  ));
  chunks.push(png);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(chunks),
    headers: {
      ...headers(true),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

before(async () => {
  resetDrawingForTests();
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenantId, 'ai-draw-demo', 'AI图纸拆单演示']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      userId, 'draw.ai', '图纸拆单员', hash,
    ]);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenantId, userId, 'admin']);
  });
  app = await createApp(db);
  login = await doLogin();
});

after(async () => {
  await app?.close();
  await db?.close();
});

test('parse 返回工序预览且不写工艺/工序表', async () => {
  const beforeRoutes = await countRoutes();
  const beforeProc = await countProcesses();
  const res = await app.inject({ method: 'POST', url: '/api/ai/drawing/parse', ...multipartPng('garment.png', '女装成衣') });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.preview_id);
  assert.ok(Array.isArray(body.steps));
  assert.ok(body.steps.length >= 3);
  assert.ok(body.steps.some((s: { name: string }) => s.name === '裁剪' || s.name === '缝制'));
  assert.ok(body.warnings?.some((w: string) => /核对/.test(w)));
  assert.equal(await countRoutes(), beforeRoutes);
  assert.equal(await countProcesses(), beforeProc);
});

test('机加说明起稿机加模板', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/ai/drawing/parse', ...multipartPng('shaft.png', '机加轴件精加工') });
  assert.equal(res.statusCode, 200, res.body);
  const names = (res.json().steps as { name: string }[]).map((s) => s.name);
  assert.ok(names.includes('下料') || names.includes('粗加工'));
});

test('confirm 写工艺路线草案并记 ai_action_log', async () => {
  const beforeRoutes = await countRoutes();
  const parsed = await app.inject({ method: 'POST', url: '/api/ai/drawing/parse', ...multipartPng('confirm.png') });
  assert.equal(parsed.statusCode, 200, parsed.body);
  const previewId = parsed.json().preview_id as string;
  assert.equal(await countRoutes(), beforeRoutes);

  const confirm = await app.inject({
    method: 'POST',
    url: '/api/ai/drawing/confirm',
    headers: headers(true),
    payload: {
      preview_id: previewId,
      mode: 'process_route_draft',
      route_name: 'AI测试路线甲',
      steps: [
        { name: '裁剪', note: '', standard_minutes: '2', auto_inbound: false },
        { name: '缝制', note: '', standard_minutes: '5', auto_inbound: false },
        { name: '包装', note: '', standard_minutes: '1', auto_inbound: true },
      ],
    },
  });
  assert.equal(confirm.statusCode, 201, confirm.body);
  const body = confirm.json();
  assert.equal(body.mode, 'process_route_draft');
  assert.ok(body.route?.id);
  assert.ok(body.route_version_id);
  assert.equal(await countRoutes(), beforeRoutes + 1);

  const log = await db.admin(async (sql) => {
    return (await sql.query<{ action: string; meta: { route_id?: string; mode?: string } }>(
      `SELECT action, meta FROM ai_action_log WHERE tenant_id=$1 AND action='drawing_split_confirm' ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )).rows[0];
  });
  assert.ok(log);
  assert.equal(log!.meta.mode, 'process_route_draft');
  assert.equal(log!.meta.route_id, body.route.id);
});

test('cancel 后再 confirm 失败，且不落库', async () => {
  const beforeRoutes = await countRoutes();
  const parsed = await app.inject({ method: 'POST', url: '/api/ai/drawing/parse', ...multipartPng('cancel.png') });
  assert.equal(parsed.statusCode, 200, parsed.body);
  const previewId = parsed.json().preview_id as string;

  const cancel = await app.inject({
    method: 'POST',
    url: '/api/ai/drawing/cancel',
    headers: headers(true),
    payload: { preview_id: previewId },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().ok, true);

  const confirm = await app.inject({
    method: 'POST',
    url: '/api/ai/drawing/confirm',
    headers: headers(true),
    payload: { preview_id: previewId, mode: 'process_route_draft' },
  });
  assert.equal(confirm.statusCode, 404, confirm.body);
  assert.equal(confirm.json().error?.code, 'PREVIEW_NOT_FOUND');
  assert.equal(await countRoutes(), beforeRoutes);
});

test('无预览直接 confirm 失败', async () => {
  const beforeRoutes = await countRoutes();
  const confirm = await app.inject({
    method: 'POST',
    url: '/api/ai/drawing/confirm',
    headers: headers(true),
    payload: { preview_id: randomUUID(), mode: 'process_route_draft' },
  });
  assert.equal(confirm.statusCode, 404);
  assert.equal(await countRoutes(), beforeRoutes);
});
