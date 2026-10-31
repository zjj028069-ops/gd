import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

const names = ['生产中控大屏', '车间大屏', '机台实时状态', '不良品统计大屏', '加工单生产进度'];
const keys = ['control', 'workshop', 'machine', 'defect', 'wo-progress'];
const password = 'Screen-Preset-TestOnly-LongPassword!';

let db: Database;
let app: FastifyInstance;
const tenant = randomUUID();
const other = randomUUID();
const admin = randomUUID();

async function namesOf(tenantId: string) {
  return db.admin(async (sql) => (await sql.query<{ menu_name: string; preset_key: string }>('SELECT menu_name, preset_key FROM data_screens WHERE tenant_id=$1 ORDER BY sort_no, menu_name', [tenantId])).rows);
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  await db.assertSecurityConfiguration();
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3),($4,$5,$6)', [tenant, 'screen-a', '大屏甲', other, 'screen-b', '大屏乙']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'screen.admin', '大屏管理员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin'),($3,$2,'admin')", [tenant, admin, other]);
  });
  app = await createApp(db, { localEventsWorker: false });
});

after(async () => {
  await app?.close();
  await db?.close();
});

test('新租户插入后就有五项预置，别家看不到', async () => {
  const rows = await namesOf(tenant);
  assert.deepEqual(rows.map((row) => row.menu_name), names);
  assert.deepEqual(rows.map((row) => row.preset_key), keys);
  const hidden = await db.tenant({ tenantId: other, userId: admin }, async (sql) => (await sql.query('SELECT menu_name FROM data_screens')).rows.map((row) => row.menu_name));
  assert.deepEqual(hidden, names);
  const crossed = await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => (await sql.query('SELECT count(*)::int AS n FROM data_screens WHERE tenant_id=$1', [other])).rows[0]!.n);
  assert.equal(crossed, 0);
});

test('只剩大屏幕时重跑回填函数会补五项并清掉垃圾名', async () => {
  await db.admin(async (sql) => {
    await sql.query('DELETE FROM data_screens WHERE tenant_id=$1', [tenant]);
    await sql.query("INSERT INTO data_screens(tenant_id,menu_name,layout,module_kind,description,access_password,sort_no,preset_key) VALUES($1,'大屏幕','默认','生产模块','-','',9,'')", [tenant]);
    await sql.query("INSERT INTO data_screens(tenant_id,menu_name,layout,module_kind,description,access_password,sort_no,preset_key) VALUES($1,'生产中控大屏','默认','生产模块','-','',1,'')", [tenant]);
    await sql.query('SELECT ensure_data_screen_presets($1)', [tenant]);
    const who = (await sql.query<{ current_user: string }>('SELECT current_user')).rows[0]!.current_user;
    assert.notEqual(who, 'gd_tenant');
  });
  const rows = await namesOf(tenant);
  assert.deepEqual(rows.map((row) => row.menu_name), names);
  assert.equal(rows.filter((row) => row.menu_name === '大屏幕').length, 0);
  assert.equal(rows.filter((row) => row.preset_key === 'control').length, 1);
  await db.admin(async (sql) => { await sql.query('SELECT ensure_data_screen_presets($1)', [tenant]); });
  const again = await namesOf(tenant);
  assert.equal(again.length, names.length);
});

test('接口列出五项且没有大屏幕，新建企业同样带五项', async () => {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.21', payload: { tenant_slug: 'screen-a', username: 'screen.admin', password } });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  const csrf = login.json().csrf_token as string;
  const listed = await app.inject({ method: 'GET', url: '/api/data-screens', headers: { cookie } });
  assert.equal(listed.statusCode, 200, listed.body);
  const items = listed.json().items as { menu_name: string; preset_key: string }[];
  for (const name of names) assert.ok(items.some((item) => item.menu_name === name), name);
  assert.equal(items.some((item) => item.menu_name === '大屏幕'), false);
  assert.deepEqual(keys.every((key) => items.some((item) => item.preset_key === key)), true);
  const created = await app.inject({
    method: 'POST', url: '/api/platform/tenants',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { slug: 'screen-c', name: '大屏丙', request_key: randomUUID() },
  });
  assert.equal(created.statusCode, 201, created.body);
  const fresh = await db.admin(async (sql) => (await sql.query<{ menu_name: string }>('SELECT menu_name FROM data_screens WHERE tenant_id=$1 ORDER BY sort_no', [created.json().tenant.id])).rows.map((row) => row.menu_name));
  assert.deepEqual(fresh, names);
});
