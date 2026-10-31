import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), admin = randomUUID();
const password = 'Customer-Ext-Field-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login;
let seq = 1;
const headers = (write = false) => ({ cookie: a.cookie, ...(write ? { 'x-csrf-token': a.csrf } : {}) });

const TYPES = ['单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间', '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '关联对象', '关联属性'];

function optionsOf(type: string) {
  if (type === '单选下拉框' || type === '多选下拉框') return { choices_text: '甲,乙' };
  if (type === '关联对象') return { biz_object: '客户', display_field: '名称' };
  if (type === '关联属性') return { rel_object: '商品', rel_field: '编号' };
  if (type === '单行文本') return { input_modes: ['手动输入'] };
  return {};
}

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
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'cust-ext-a', '客户扩展']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'custext.admin', '客户扩展管理员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
  });
  app = await createApp(db, { localEventsWorker: false });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.' + (seq++), payload: { tenant_slug: 'cust-ext-a', username: 'custext.admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  a = { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, csrf: response.json().csrf_token };
});
after(async () => { await app?.close(); await db?.close(); });

test('客户扩展字段 16 种中文类型可落库再删除，公式与英文类型拒绝', async () => {
  assert.deepEqual((await call('GET', '/api/entity-ext-fields?entity=customer')).items, []);

  const ids: string[] = [];
  for (const type of TYPES) {
    const item = (await call('POST', '/api/entity-ext-fields', {
      entity: 'customer', name: `客扩${type}`, required: type === '单行文本', field_type: type, options: optionsOf(type),
    }, 201)).item;
    assert.equal(item.field_type, type);
    assert.equal(item.name, `客扩${type}`);
    assert.equal(item.required, type === '单行文本');
    assert.equal(item.required_text, type === '单行文本' ? '是' : '否');
    ids.push(item.id);
  }

  const listed = (await call('GET', '/api/entity-ext-fields?entity=customer')).items;
  assert.deepEqual(listed.map((item: { field_type: string }) => item.field_type), TYPES);

  const stored = await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => (
    await sql.query<{ name: string; field_type: string; required: boolean }>('SELECT name, field_type, required FROM entity_ext_fields WHERE entity=$1 ORDER BY sort_no, created_at, id', ['customer'])
  ).rows);
  assert.deepEqual(stored.map((row) => row.field_type), TYPES);
  assert.equal(stored[0]?.name, '客扩单行文本');
  assert.equal(stored[0]?.required, true);

  await call('POST', '/api/entity-ext-fields', { entity: 'customer', name: '公式列', required: false, field_type: '公式', options: { formula: '1+1' } }, 422);
  await call('POST', '/api/entity-ext-fields', { entity: 'customer', name: '英文键', field_type: 'text' }, 422);

  for (const id of ids) await call('DELETE', `/api/entity-ext-fields/${id}`);
  assert.deepEqual((await call('GET', '/api/entity-ext-fields?entity=customer')).items, []);
  const left = await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => (
    await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM entity_ext_fields WHERE entity=$1', ['customer'])
  ).rows);
  assert.equal(left[0]?.n, 0);
});
