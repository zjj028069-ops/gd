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
const password = 'Meeting-Agenda-Field-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login;
let seq = 1;
const headers = (write = false) => ({ cookie: a.cookie, ...(write ? { 'x-csrf-token': a.csrf } : {}) });

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
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'agenda-a', '议程字段']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'agenda.admin', '议程管理员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
  });
  app = await createApp(db, { localEventsWorker: false });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.' + (seq++), payload: { tenant_slug: 'agenda-a', username: 'agenda.admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  a = { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, csrf: response.json().csrf_token };
});
after(async () => { await app?.close(); await db?.close(); });

test('会议议程字段可新增、修改、排序、删除，空表不报错', async () => {
  const empty = await call('GET', '/api/entity-ext-fields?entity=meeting_agenda');
  assert.deepEqual(empty.items, []);
  const extEmpty = await call('GET', '/api/entity-ext-fields?entity=lean_meeting');
  assert.deepEqual(extEmpty.items, []);

  const first = (await call('POST', '/api/entity-ext-fields', { entity: 'meeting_agenda', name: '议题说明', required: true, field_type: '单行文本' }, 201)).item;
  assert.equal(first.name, '议题说明');
  assert.equal(first.field_type, '单行文本');
  assert.equal(first.required_text, '是');
  assert.ok(first.createdAt);

  const second = (await call('POST', '/api/entity-ext-fields', { entity: 'meeting_agenda', name: '完成期限', required: false, field_type: '日期' }, 201)).item;
  await call('POST', '/api/entity-ext-fields', { entity: 'meeting_agenda', name: '议题说明', required: false, field_type: '多行文本' }, 409);
  await call('POST', '/api/entity-ext-fields', { entity: 'meeting_agenda', name: '公式列', required: false, field_type: '公式', options: { formula: '1+1' } }, 422);
  await call('POST', '/api/entity-ext-fields', { entity: 'meeting_agenda', name: '坏类型', field_type: '超链接' }, 422);

  const sameNameOnMeeting = (await call('POST', '/api/entity-ext-fields', { entity: 'lean_meeting', name: '议题说明', required: false, field_type: '多行文本' }, 201)).item;
  assert.equal(sameNameOnMeeting.entity, 'lean_meeting');

  const edited = (await call('PUT', `/api/entity-ext-fields/${first.id}`, { name: '议题说明改', required: false, field_type: '多行文本' })).item;
  assert.equal(edited.name, '议题说明改');
  assert.equal(edited.field_type, '多行文本');
  assert.equal(edited.required, false);

  const reordered = await call('PUT', '/api/entity-ext-fields/reorder', { entity: 'meeting_agenda', ids: [second.id, first.id] });
  assert.deepEqual(reordered.items.map((item: { name: string }) => item.name), ['完成期限', '议题说明改']);

  const stored = await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => (
    await sql.query<{ name: string; sort_no: number }>('SELECT name, sort_no FROM entity_ext_fields WHERE entity=$1 ORDER BY sort_no', ['meeting_agenda'])
  ).rows);
  assert.deepEqual(stored.map((row) => row.name), ['完成期限', '议题说明改']);

  await call('DELETE', `/api/entity-ext-fields/${first.id}`);
  await call('DELETE', `/api/entity-ext-fields/${second.id}`);
  await call('DELETE', `/api/entity-ext-fields/${sameNameOnMeeting.id}`);
  assert.deepEqual((await call('GET', '/api/entity-ext-fields?entity=meeting_agenda')).items, []);
  assert.deepEqual((await call('GET', '/api/entity-ext-fields?entity=lean_meeting')).items, []);
});
