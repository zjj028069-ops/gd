import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database;
let app: FastifyInstance;
const tenant = randomUUID();
const admin = randomUUID();
const unit = randomUUID();
const password = 'GoodsAlign-TestOnly-LongPassword!';
let session: { cookie: string; csrf: string };

function today() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const read = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${read('year')}${read('month')}${read('day')}`;
}
function headers(write = false) {
  return { cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) };
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'goods-align', '商品对齐']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash,active) VALUES($1,$2,$3,$4,true)', [admin, 'goods.admin', '商品管理员', hash]);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenant, admin, 'admin']);
    await sql.query('INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [unit, tenant, 'EA', '个']);
  });
  app = await createApp(db);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: 'goods-align', username: 'goods.admin', password } });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers['set-cookie'];
  const cookie = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(cookie);
  session = { cookie: cookie.split(';')[0]!, csrf: login.json().csrf_token };
});
after(async () => { await app?.close(); await db?.close(); });

test('商品自动编号、重名检查与旧来源迁移', async () => {
  const date = today();
  const first = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '对齐甲' } });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().product.code, `SP${date}0001`);
  const second = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '对齐乙' } });
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().product.code, `SP${date}0002`);

  const manual = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '手填商品', code: 'ABC-1', unit_id: unit, attribute: 'purchased' } });
  assert.equal(manual.statusCode, 201, manual.body);
  assert.equal(manual.json().product.code, 'ABC-1');
  assert.equal(manual.json().product.source, '外购');
  const duplicated = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '另一个手填', code: 'ABC-1' } });
  assert.equal(duplicated.statusCode, 409, duplicated.body);
  assert.equal(duplicated.json().error.message, '商品编号已存在');

  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: `并发${index}` } })));
  concurrent.forEach((response) => assert.equal(response.statusCode, 201, response.body));
  const codes = concurrent.map((response) => response.json().product.code as string);
  assert.equal(new Set(codes).size, 20);
  codes.forEach((code) => assert.match(code, new RegExp(`^SP${date}\\d{4}$`)));

  const sameName = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '对齐甲', code: 'DUP-NAME' } });
  assert.equal(sameName.statusCode, 409, sameName.body);
  assert.equal(sameName.json().error.message, '商品名已存在');
  const turnedOff = await app.inject({ method: 'PUT', url: '/api/products/settings', headers: headers(true), payload: { duplicate_name_check: false, auto_fill_code: true, qr_login_required: false } });
  assert.equal(turnedOff.statusCode, 200, turnedOff.body);
  const allowed = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '对齐甲', code: 'DUP-NAME-OK' } });
  assert.equal(allowed.statusCode, 201, allowed.body);
  const restoreName = await app.inject({ method: 'PUT', url: '/api/products/settings', headers: headers(true), payload: { duplicate_name_check: true, auto_fill_code: false, qr_login_required: false } });
  assert.equal(restoreName.statusCode, 200, restoreName.body);
  const missingCode = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '没有编号' } });
  assert.equal(missingCode.statusCode, 422, missingCode.body);
  assert.equal(missingCode.json().error.message, '请填写商品编号');
  const missingName = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '   ' } });
  assert.equal(missingName.statusCode, 422, missingName.body);
  assert.equal(missingName.json().error.message, '请填写商品名');
  await app.inject({ method: 'PUT', url: '/api/products/settings', headers: headers(true), payload: { duplicate_name_check: true, auto_fill_code: true, qr_login_required: false } });

  const rules = await app.inject({ url: '/api/configuration/custom-code-rules', headers: headers() });
  assert.equal(rules.statusCode, 200, rules.body);
  const rule = rules.json().items.find((item: { name: string }) => item.name === '商品编号');
  assert.ok(rule);
  const config = { ...rule.config, seq_digits: 3, seq_start: 1, elements: rule.config.elements.map((element: { type: string }, index: number) => index === 0 ? { ...element, type: 'fixed', text: 'CP' } : element) };
  const patched = await app.inject({ method: 'PATCH', url: `/api/configuration/custom-code-rules/${rule.id}`, headers: headers(true), payload: { version: rule.version, config } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().rule.preview, `CP${date}001`);
  const followed = await app.inject({ method: 'POST', url: '/api/products', headers: headers(true), payload: { name: '规则新品' } });
  assert.equal(followed.statusCode, 201, followed.body);
  assert.equal(followed.json().product.code, patched.json().rule.preview);

  const migrated = randomUUID();
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO products(id,tenant_id,code,name,attribute) VALUES($1,$2,$3,$4,$5)', [migrated, tenant, 'MIG-1', '迁移商品', 'purchased']);
    const row = (await sql.query<{ source: string }>('SELECT source FROM products WHERE id=$1', [migrated])).rows[0];
    assert.equal(row?.source, '外购');
    const mapped = (await sql.query<{ source: string }>("SELECT product_source_from_attribute('manufactured') AS source")).rows[0];
    assert.equal(mapped?.source, '自产');
  });
});

test('同租户单位名不可重复，重复时提示该单位已存在且不入库', async () => {
  const before = await app.inject({ url: '/api/units', headers: headers() });
  assert.equal(before.statusCode, 200, before.body);
  const names = before.json().items.map((item: { name: string }) => item.name);
  assert.ok(names.includes('个'));
  const duplicated = await app.inject({ method: 'POST', url: '/api/units', headers: headers(true), payload: { code: 'EA-DUP', name: '个' } });
  assert.equal(duplicated.statusCode, 409, duplicated.body);
  assert.equal(duplicated.json().error.code, 'DUPLICATE_UNIT');
  assert.equal(duplicated.json().error.message, '该单位已存在');
  const created = await app.inject({ method: 'POST', url: '/api/units', headers: headers(true), payload: { code: 'BOX-ALIGN', name: '箱' } });
  assert.equal(created.statusCode, 201, created.body);
  const renamed = await app.inject({ method: 'PATCH', url: '/api/units/' + created.json().unit.id, headers: headers(true), payload: { version: 1, name: '个', active: true } });
  assert.equal(renamed.statusCode, 409, renamed.body);
  assert.equal(renamed.json().error.message, '该单位已存在');
  const kept = await app.inject({ method: 'PATCH', url: '/api/units/' + created.json().unit.id, headers: headers(true), payload: { version: 1, name: '箱', active: true } });
  assert.equal(kept.statusCode, 200, kept.body);
  const after = await app.inject({ url: '/api/units', headers: headers() });
  const ge = after.json().items.filter((item: { name: string }) => item.name === '个');
  assert.equal(ge.length, 1);
});
