import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { renderCode } from '../src/code-rules.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID();
const admin = randomUUID();
const worker = randomUUID();
const planner = randomUUID();
const password = 'Round7-TestOnly-LongPassword!';
let adminSession: { cookie: string; csrf: string };
let workerSession: { cookie: string; csrf: string };
let plannerSession: { cookie: string; csrf: string };
let product = '';

const headers = (session: { cookie: string; csrf: string }, write = false) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });

async function login(username: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: 'r7', username, password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!, csrf: response.json().csrf_token as string };
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'r7', '第七轮']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'r7.admin', '本地管理员', hash]);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [worker, 'r7.worker', '本地员工', hash]);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [planner, 'r7.planner', '本地计划员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')", [tenant, worker]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'planner')", [tenant, planner]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','个')", [randomUUID(), tenant]);
  });
  app = await createApp(db, { localEventsWorker: false });
  adminSession = await login('r7.admin');
  workerSession = await login('r7.worker');
  plannerSession = await login('r7.planner');
  const units = await app.inject({ url: '/api/units', headers: headers(adminSession) });
  const unitId = units.json().items?.[0]?.id ?? units.json().units?.[0]?.id;
  const created = await app.inject({ method: 'POST', url: '/api/products', headers: headers(adminSession, true), payload: { code: 'R7-BOLT', name: 'R7测试螺栓', unit_id: unitId, attribute: 'purchased' } });
  assert.equal(created.statusCode, 201, created.body);
  product = created.json().product.id;
});

after(async () => { await app.close(); await db.close(); });

test('报价单号预览 BJ-2610-0001、显示简写和元素4分隔符', () => {
  const config = {
    elements: [
      { type: 'fixed' as const, text: 'BJ', separator: '-' as const },
      { type: 'date' as const, date_format: 'ym' as const, short_year: true, separator: '' as const },
      { type: 'empty' as const, separator: '' as const },
      { type: 'empty' as const, separator: '-' as const },
    ],
    seq_digits: 4,
    seq_start: 1,
    show_abbrev: false,
  };
  const now = new Date('2026-10-05T04:00:00Z');
  assert.equal(renderCode(config, 1, now), 'BJ-2610-0001');
  assert.equal(renderCode(config, 2, now), 'BJ-2610-0002');
  assert.equal(renderCode({ ...config, show_abbrev: true }, 3, now), 'BJ-2610-3');
});

test('一个对象只能挂一个流程，复制后对象为空且禁用', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/audit/flows', headers: headers(adminSession, true), payload: { module: 'customer', name: '合同报价单审核流程', object_types: ['quotation'], allow_withdraw: false, enabled: true, levels: [{ sign_mode: 'or', approver_ids: [admin] }] } });
  assert.equal(created.statusCode, 201, created.body);
  const again = await app.inject({ method: 'POST', url: '/api/audit/flows', headers: headers(adminSession, true), payload: { module: 'customer', name: '另一条', object_types: ['quotation'], levels: [{ sign_mode: 'and', approver_ids: [admin] }] } });
  assert.equal(again.statusCode, 422, again.body);
  const copied = await app.inject({ method: 'POST', url: `/api/audit/flows/${created.json().flow.id}/copy`, headers: headers(adminSession, true), payload: {} });
  assert.equal(copied.statusCode, 200, copied.body);
  assert.equal(copied.json().flow.name, '合同报价单审核流程 副本');
  assert.equal(copied.json().flow.enabled, false);
  assert.deepEqual(copied.json().flow.object_types, []);
});

test('或签一人通过，会签要全过，非当前级审核人 403', async () => {
  const flow = await app.inject({ method: 'POST', url: '/api/audit/flows', headers: headers(adminSession, true), payload: { module: 'customer', name: '合同审核流程', object_types: ['contract'], allow_withdraw: false, enabled: true, levels: [{ sign_mode: 'or', approver_ids: [planner, admin] }, { sign_mode: 'and', approver_ids: [admin, planner] }] } });
  assert.equal(flow.statusCode, 201, flow.body);
  const settings = await app.inject({ url: '/api/money/settings', headers: headers(adminSession) });
  const current = settings.json().settings;
  const saved = await app.inject({ method: 'PUT', url: '/api/money/settings', headers: headers(adminSession, true), payload: { ...current, auto_calc: false, version: current.version } });
  assert.equal(saved.statusCode, 200, saved.body);
  const customer = await app.inject({ method: 'POST', url: '/api/money/customers', headers: headers(adminSession, true), payload: { name: 'R7客户甲', contact_name: '甲', request_key: randomUUID() } });
  assert.equal(customer.statusCode, 201, customer.body);
  const contract = await app.inject({ method: 'POST', url: '/api/money/contracts', headers: headers(adminSession, true), payload: { customer_id: customer.json().customer.id, amount: '10000', prepay: '1000', salesperson_id: admin, contact_name: '甲', lines: [{ product_id: product, quantity: '1', unit_price: '10000' }], request_key: randomUUID() } });
  assert.equal(contract.statusCode, 201, contract.body);
  const id = contract.json().contract.id as string;
  assert.equal(contract.json().contract.approval, 'pending');
  const early = await app.inject({ method: 'POST', url: '/api/audit/decide', headers: headers(workerSession, true), payload: { object_type: 'contract', object_id: id, action: '通过' } });
  assert.equal(early.statusCode, 403, early.body);
  assert.match(early.json().error.message, /当前角色没有操作权限/);
  const batch = await app.inject({ method: 'POST', url: '/api/audit/batch', headers: headers(workerSession, true), payload: { object_type: 'contract', ids: [id], action: '通过' } });
  assert.equal(batch.statusCode, 403, batch.body);
  const wrong = await app.inject({ method: 'POST', url: '/api/audit/decide', headers: headers(plannerSession, true), payload: { object_type: 'contract', object_id: id, action: '通过', remark: '同意' } });
  assert.equal(wrong.statusCode, 200, wrong.body);
  const still = await app.inject({ method: 'POST', url: '/api/audit/decide', headers: headers(adminSession, true), payload: { object_type: 'contract', object_id: id, action: '通过', remark: '二级' } });
  assert.equal(still.statusCode, 200, still.body);
  const view = await app.inject({ url: `/api/money/contracts/${id}`, headers: headers(adminSession) });
  assert.equal(view.json().contract.approval, 'pending');
  const done = await app.inject({ method: 'POST', url: '/api/audit/decide', headers: headers(plannerSession, true), payload: { object_type: 'contract', object_id: id, action: '通过' } });
  assert.equal(done.statusCode, 200, done.body);
  const passed = await app.inject({ url: `/api/money/contracts/${id}`, headers: headers(adminSession) });
  assert.equal(passed.json().contract.approval, 'approved');
  const list = await app.inject({ url: '/api/money/contracts', headers: headers(adminSession) });
  assert.equal(list.json().summary.debt, '9000');
});

test('改流程不影响已提交单据的快照', async () => {
  const customers = await app.inject({ url: '/api/money/customers', headers: headers(adminSession) });
  const customerId = customers.json().items[0].id as string;
  const contract = await app.inject({ method: 'POST', url: '/api/money/contracts', headers: headers(adminSession, true), payload: { customer_id: customerId, amount: '5000', prepay: '0', salesperson_id: admin, contact_name: '甲', lines: [{ product_id: product, quantity: '1', unit_price: '5000' }], request_key: randomUUID() } });
  assert.equal(contract.statusCode, 201, contract.body);
  const id = contract.json().contract.id as string;
  const before = await app.inject({ url: `/api/audit/detail?object_type=contract&object_id=${id}`, headers: headers(adminSession) });
  const flows = await app.inject({ url: '/api/audit/flows?module=customer', headers: headers(adminSession) });
  const flow = flows.json().items.find((item: { name: string }) => item.name === '合同审核流程');
  const patched = await app.inject({ method: 'PATCH', url: `/api/audit/flows/${flow.id}`, headers: headers(adminSession, true), payload: { name: flow.name, allow_withdraw: true, enabled: true, object_types: ['contract'], levels: [{ sign_mode: 'or', approver_ids: [worker] }] } });
  assert.equal(patched.statusCode, 200, patched.body);
  const after = await app.inject({ url: `/api/audit/detail?object_type=contract&object_id=${id}`, headers: headers(adminSession) });
  assert.equal(after.json().levels[0].approvers.length, before.json().levels[0].approvers.length);
  assert.equal(after.json().levels.length, before.json().levels.length);
  const later = await app.inject({ method: 'POST', url: '/api/money/contracts', headers: headers(adminSession, true), payload: { customer_id: customerId, amount: '800', prepay: '0', salesperson_id: admin, contact_name: '甲', lines: [{ product_id: product, quantity: '1', unit_price: '800' }], request_key: randomUUID() } });
  assert.equal(later.statusCode, 201, later.body);
  const outsider = await app.inject({ method: 'POST', url: '/api/audit/decide', headers: headers(plannerSession, true), payload: { object_type: 'contract', object_id: later.json().contract.id, action: '通过' } });
  assert.equal(outsider.statusCode, 403, outsider.body);
  assert.match(outsider.json().error.message, /不是当前级审核人/);
});

test('权限点 403 和数据权限个人、团队', async () => {
  const role = await app.inject({ method: 'POST', url: '/api/system/roles', headers: headers(adminSession, true), payload: { name: '销售员', points: ['customer.list.view', 'customer.list.create'], scopes: { 'customer.list.view': 'self' } } });
  assert.equal(role.statusCode, 201, role.body);
  // WHY: Round11 API 合同要求创建团队必须传 leader_id（请选择团队主管），不是放松断言；适配必填校验。
  const team = await app.inject({ method: 'POST', url: '/api/system/teams', headers: headers(adminSession, true), payload: { name: '默认团队', leader_id: admin } });
  assert.equal(team.statusCode, 201, team.body);
  const sales = await app.inject({ method: 'POST', url: '/api/system/users', headers: headers(adminSession, true), payload: { username: 'sales.a', display_name: '销售甲', phone: '13800000001', password, custom_role_id: role.json().role.id, team_ids: [team.json().team.id] } });
  assert.equal(sales.statusCode, 201, sales.body);
  const other = await app.inject({ method: 'POST', url: '/api/system/users', headers: headers(adminSession, true), payload: { username: 'sales.b', display_name: '销售乙', phone: '13800000002', password, custom_role_id: role.json().role.id, team_ids: [team.json().team.id] } });
  assert.equal(other.statusCode, 201, other.body);
  const salesSession = await login('sales.a');
  const otherSession = await login('sales.b');
  const denied = await app.inject({ url: '/api/system/users', headers: headers(salesSession) });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.match(denied.json().error.message, /当前角色没有操作权限/);
  const mine = await app.inject({ method: 'POST', url: '/api/money/customers', headers: headers(salesSession, true), payload: { name: 'R7客户A1', contact_name: 'A1', request_key: randomUUID() } });
  assert.equal(mine.statusCode, 201, mine.body);
  const theirs = await app.inject({ method: 'POST', url: '/api/money/customers', headers: headers(otherSession, true), payload: { name: 'R7客户B1', contact_name: 'B1', request_key: randomUUID() } });
  assert.equal(theirs.statusCode, 201, theirs.body);
  const selfList = await app.inject({ url: '/api/money/customers', headers: headers(salesSession) });
  assert.equal(selfList.json().items.length, 1);
  const updated = await app.inject({ method: 'PATCH', url: `/api/system/roles/${role.json().role.id}`, headers: headers(adminSession, true), payload: { name: '销售员', version: 1, points: ['customer.list.view', 'customer.list.create'], scopes: { 'customer.list.view': 'team' } } });
  assert.equal(updated.statusCode, 200, updated.body);
  const teamSession = await login('sales.a');
  const teamList = await app.inject({ url: '/api/money/customers', headers: headers(teamSession) });
  assert.equal(teamList.json().items.length, 2);
  const hidden = await app.inject({ url: `/api/money/customers/${theirs.json().customer.id}`, headers: headers(teamSession) });
  assert.equal(hidden.statusCode, 200, hidden.body);
  const back = await app.inject({ method: 'PATCH', url: `/api/system/roles/${role.json().role.id}`, headers: headers(adminSession, true), payload: { name: '销售员', version: 2, points: ['customer.list.view', 'customer.list.create'], scopes: { 'customer.list.view': 'self' } } });
  assert.equal(back.statusCode, 200, back.body);
  const selfAgain = await login('sales.a');
  const blocked = await app.inject({ url: `/api/money/customers/${theirs.json().customer.id}`, headers: headers(selfAgain) });
  assert.equal(blocked.statusCode, 404, blocked.body);
  assert.match(blocked.json().error.message, /不存在或不可访问/);
});

test('操作日志写入，简拼能筛到本地计划员', async () => {
  const logs = await app.inject({ url: '/api/system/operation-logs?actor=bdjhy', headers: headers(adminSession) });
  assert.equal(logs.statusCode, 200, logs.body);
  const items = logs.json().items as { actor_name: string; content: string; action: string; client_name: string }[];
  assert.ok(items.some((item) => item.actor_name === '本地计划员' && item.content.includes('审核通过')));
  assert.ok(items.every((item) => item.actor_name === '本地计划员'));
  const all = await app.inject({ url: '/api/system/operation-logs', headers: headers(adminSession) });
  const rows = all.json().items as { content: string; action: string; client_name: string }[];
  assert.ok(rows.some((item) => item.action === '新增' && item.content.includes('新增客户') && item.client_name === '企业web端'));
  assert.ok(rows.some((item) => item.action === '修改' && item.content.includes('修改角色：销售员')));
});
