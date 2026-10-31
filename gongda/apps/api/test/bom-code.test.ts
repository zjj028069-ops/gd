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
const tenantA = randomUUID();
const tenantB = randomUUID();
const admin = randomUUID();
const password = 'BomCode-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login;
let b: Login;

function shanghaiDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)!.value;
  return read('year') + read('month') + read('day');
}

const headers = (session: Login, write = false) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });

async function login(slug: string): Promise<Login> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: slug, username: 'bom.admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  const cookie = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(cookie);
  return { cookie: cookie.split(';')[0]!, csrf: response.json().csrf_token };
}

async function post(url: string, payload: unknown, session = a, expected = 201) {
  const response = await app.inject({ method: 'POST', url, headers: headers(session, true), payload });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

async function put(url: string, payload: unknown, session = a, expected = 200) {
  const response = await app.inject({ method: 'PUT', url, headers: headers(session, true), payload });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

async function get(url: string, session = a) {
  const response = await app.inject({ url, headers: headers(session) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO users(id,username,display_name,password_hash,active) VALUES($1,$2,$3,$4,true)', [admin, 'bom.admin', 'bom.admin', hash]);
    for (const [id, slug] of [[tenantA, 'bom-a'], [tenantB, 'bom-b']] as const) {
      await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [id, slug, slug]);
      await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [id, admin, 'admin']);
      await sql.query('INSERT INTO units(tenant_id,code,name) VALUES($1,$2,$3)', [id, 'EA', '个']);
    }
  });
  app = await createApp(db);
  a = await login('bom-a');
  b = await login('bom-b');
});

after(async () => {
  await app?.close();
  await db?.close();
});

test('空 BOM 编号保存成功并按 BOM+年月日+4 位流水发号，手填编号原样保留', async () => {
  const part = (await post('/api/products', { code: 'PART-' + randomUUID().slice(0, 8), name: '防寒面料', unit_id: (await get('/api/units')).items[0].id, attribute: 'purchased' })).product;
  const day = shanghaiDay();
  async function createBom(name: string) {
    return (await post('/api/boms', {
      name,
      description: '',
      items: [{ component_product_id: part.id, quantity: '1', loss_rate: '0' }],
    })).bom as { id: string; code: string; name: string; version: number };
  }
  const extras = (code: string | null, name: string) => ({ code, name, category: null, is_default: false, note: null });

  const first = await createBom('BOM男式防寒上衣');
  assert.equal(first.code, '');
  const saved = await put('/api/boms/' + first.id + '/extras', extras(null, 'BOM男式防寒上衣'));
  assert.equal(saved.ok, true);
  assert.equal(saved.code, `BOM${day}0001`);
  assert.equal(JSON.stringify(saved).includes('编号格式不正确'), false);

  const blank = await createBom('空白字符串编号');
  const blankSaved = await put('/api/boms/' + blank.id + '/extras', extras('   ', '空白字符串编号'));
  assert.equal(blankSaved.code, `BOM${day}0002`);

  const detail = await get('/api/boms/' + first.id);
  assert.equal(detail.bom.code, `BOM${day}0001`);
  assert.equal(detail.bom.name, 'BOM男式防寒上衣');
  const listed = (await get('/api/boms')).items.find((row: { id: string }) => row.id === first.id);
  assert.equal(listed.code, `BOM${day}0001`);

  const kept = await put('/api/boms/' + first.id + '/extras', { ...extras(`BOM${day}0001`, 'BOM男式防寒上衣'), note: '保持原号' });
  assert.equal(kept.code, `BOM${day}0001`);
  assert.equal((await get('/api/boms/' + first.id)).bom.note, '保持原号');

  const manual = await createBom('手填编号');
  const manualSaved = await put('/api/boms/' + manual.id + '/extras', extras('男式防寒-01', '手填编号'));
  assert.equal(manualSaved.code, '男式防寒-01');
  assert.equal((await get('/api/boms/' + manual.id)).bom.code, '男式防寒-01');

  const duplicate = await createBom('重复手填');
  const rejected = await put('/api/boms/' + duplicate.id + '/extras', extras('男式防寒-01', '重复手填'), a, 409);
  assert.equal(rejected.error.code, 'DUPLICATE_CODE');
  assert.equal(rejected.error.message, 'BOM编号已存在');
  assert.notEqual(rejected.error.message, '编号格式不正确');
  assert.equal((await get('/api/boms/' + duplicate.id)).bom.code, '');

  const otherTenant = (await post('/api/boms', {
    name: '企业B同号',
    description: '',
    items: [{ component_product_id: (await post('/api/products', { code: 'PARTB-' + randomUUID().slice(0, 8), name: '企业B面料', unit_id: (await get('/api/units', b)).items[0].id, attribute: 'purchased' }, b)).product.id, quantity: '1', loss_rate: '0' }],
  }, b)).bom;
  const otherSaved = await put('/api/boms/' + otherTenant.id + '/extras', extras('男式防寒-01', '企业B同号'), b);
  assert.equal(otherSaved.code, '男式防寒-01');
  const otherAuto = (await post('/api/boms', {
    name: '企业B自动',
    description: '',
    items: [{ component_product_id: (await get('/api/products?page=1&page_size=20', b)).items[0].id, quantity: '1', loss_rate: '0' }],
  }, b)).bom;
  assert.equal((await put('/api/boms/' + otherAuto.id + '/extras', extras(null, '企业B自动'), b)).code, `BOM${day}0001`);

  const tooLong = await put('/api/boms/' + duplicate.id + '/extras', extras('B'.repeat(65), '重复手填'), a, 400);
  assert.equal(tooLong.error.message, '编号超出长度限制');
  const wrongType = await put('/api/boms/' + duplicate.id + '/extras', { ...extras(null, '重复手填'), code: 12 }, a, 400);
  assert.equal(wrongType.error.message, '编号格式不正确');

  const cleared = await put('/api/boms/' + manual.id + '/extras', extras(null, '手填编号'));
  assert.equal(cleared.code, `BOM${day}0003`);
  const omitted = await put('/api/boms/' + manual.id + '/extras', { note: '不改编号' });
  assert.equal(omitted.code, `BOM${day}0003`);
});
