import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

// 第二步预检是暂定状态规则演示，不能记作销售/报工/库存业务已经过账。
let db: Database;
let app: FastifyInstance;
const tenantA = randomUUID(), tenantB = randomUUID();
const admin = randomUUID(), worker = randomUUID();
const unitA = randomUUID(), productA = randomUUID(), unitB = randomUUID(), productB = randomUUID();
const password = 'DesignPreview-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login, b: Login, w: Login;
const headers = (session: Login, write = false) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });
type PreviewDefinition = {
  domain: string; label: string; initial_state: string;
  states: { value: string; label: string }[];
  actions: { value: string; label: string; from: string[]; to: string; roles: string[] }[];
  facts: { key: string; label: string; type: string; default: unknown; options?: unknown[] }[];
  provisional: boolean;
};
let definitions: PreviewDefinition[];
async function login(slug: string, username = 'preview.admin'): Promise<Login> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: slug, username, password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  const cookie = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(cookie);
  return { cookie: cookie.split(';')[0]!, csrf: response.json().csrf_token };
}
async function preview(domain: string, state: string, action: string, facts: Record<string, unknown>, session = a) {
  const response = await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(session, true), payload: { domain, state, action, facts } });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.posted, false); assert.equal(result.provisional, true);
  assert.equal(typeof result.allowed, 'boolean');
  assert.ok(Array.isArray(result.effects)); assert.ok(Array.isArray(result.errors));
  return result;
}
function definition(domain: string) {
  const found = definitions.find(item => item.domain === domain);
  assert.ok(found, domain + '状态定义缺失');
  return found;
}
function defaultFacts(domain: string) {
  return Object.fromEntries(definition(domain).facts.map(fact => [fact.key, fact.default]));
}
async function businessSnapshot() {
  return db.admin(async sql => {
    const tables = (await sql.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','tenants','users','memberships','sessions') ORDER BY tablename")).rows;
    const snapshot: Record<string, unknown> = {};
    for (const { tablename } of tables) {
      const quoted = '"' + tablename.replaceAll('"', '""') + '"';
      snapshot[tablename] = (await sql.query<{ data: unknown }>('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) AS data FROM ' + quoted + ' t')).rows[0]!.data;
    }
    return snapshot;
  });
}
before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async sql => {
    for (const [id, slug] of [[tenantA, 'preview-a'], [tenantB, 'preview-b']]) await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [id, slug, slug]);
    for (const [id, username] of [[admin, 'preview.admin'], [worker, 'preview.worker']]) await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [id, username, username, hash]);
    for (const tenant of [tenantA, tenantB]) await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenant, admin, 'admin']);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenantA, worker, 'worker']);
    for (const [id, tenant] of [[unitA, tenantA], [unitB, tenantB]]) await sql.query('INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [id, tenant, 'EA', '个']);
    for (const [id, tenant, unit] of [[productA, tenantA, unitA], [productB, tenantB, unitB]]) await sql.query('INSERT INTO products(id,tenant_id,code,name,unit_id,attribute) VALUES($1,$2,$3,$4,$5,$6)', [id, tenant, 'PREVIEW-PD', '预检不能改动的产品', unit, 'manufactured']);
  });
  app = await createApp(db); a = await login('preview-a'); b = await login('preview-b'); w = await login('preview-a', 'preview.worker');
  const response = await app.inject({ url: '/api/design-preview/definitions', headers: headers(a) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().posted, false);
  definitions = response.json().definitions;
});
after(async () => { await app?.close(); await db?.close(); });

test('四域定义给出完整状态/动作/角色与事实字段，并声明暂定且未过账', async () => {
  assert.deepEqual(definitions.map(item => item.domain).sort(), ['report', 'sales', 'stock_movement', 'work_order']);
  for (const item of definitions) {
    assert.ok(item.label); assert.equal(item.provisional, true);
    const states = item.states.map(state => state.value);
    assert.equal(new Set(states).size, states.length); assert.ok(states.includes(item.initial_state));
    assert.ok(item.actions.length > 0);
    assert.equal(new Set(item.actions.map(action => action.value)).size, item.actions.length);
    assert.equal(new Set(item.facts.map(fact => fact.key)).size, item.facts.length);
    for (const action of item.actions) {
      assert.ok(action.label); assert.ok(states.includes(action.to)); assert.ok(action.from.length > 0);
      assert.ok(action.from.every(state => states.includes(state)));
      assert.ok(action.roles.length > 0 && action.roles.every(role => ['admin', 'planner', 'worker'].includes(role)));
    }
    for (const fact of item.facts) assert.ok(fact.key && fact.label && fact.type && Object.hasOwn(fact, 'default'));
  }
});

test('匿名/缺CSRF/伪造来源不能调用预检，未知域或额外租户参数拒绝', async () => {
  const item = definition('sales'); const action = item.actions[0]!;
  const payload = { domain: item.domain, state: action.from[0], action: action.value, facts: defaultFacts(item.domain) };
  assert.equal((await app.inject({ url: '/api/design-preview/definitions' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/design-preview/transition', payload })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(a), payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: { ...headers(a, true), origin: 'https://attacker.example' }, payload })).statusCode, 403);
  for (const invalid of [{ ...payload, domain: 'unknown_domain' }, { ...payload, tenant_id: tenantB }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(a, true), payload: invalid })).statusCode, 400);
  }
});

test('未知状态、动作与事实字段返回400，不偷偷选择默认业务规则', async () => {
  for (const item of definitions) {
    const action = item.actions[0]!;
    const base = { domain: item.domain, state: action.from[0]!, action: action.value, facts: defaultFacts(item.domain) };
    for (const [payload, errorCode] of [
      [{ ...base, state: 'not_a_state' }, 'UNKNOWN_STATE'],
      [{ ...base, action: 'not_an_action' }, 'UNKNOWN_ACTION'],
      [{ ...base, facts: { ...base.facts, unknown_fact: true } }, 'UNKNOWN_FACT'],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(a, true), payload });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.code, errorCode);
    }
  }
});
test('所有域预检重复运行不新增或改动两企业主档、版本、子项及审计', async () => {
  const beforeSnapshot = await businessSnapshot();
  for (const session of [a, b]) {
    for (const item of definitions) {
      for (const action of item.actions) {
        for (let attempt = 0; attempt < 2; attempt++) await preview(item.domain, action.from[0]!, action.value, defaultFacts(item.domain), session);
      }
    }
  }
  assert.deepEqual(await businessSnapshot(), beforeSnapshot);
});


test('报工良0坏10可以提交待审；良0坏0不能产生空报工', async () => {
  const badOnly = await preview('report', 'draft', 'submit', { ...defaultFacts('report'), good_qty: '0', bad_qty: '10' }, w);
  assert.equal(badOnly.allowed, true); assert.equal(badOnly.next_state, 'pending'); assert.deepEqual(badOnly.errors, []);
  assert.ok(badOnly.effects.length > 0);
  const empty = await preview('report', 'draft', 'submit', { ...defaultFacts('report'), good_qty: '0', bad_qty: '0' }, w);
  assert.equal(empty.allowed, false); assert.equal(empty.next_state, 'draft'); assert.ok(empty.errors.some((error: { code: string }) => error.code === 'EMPTY_REPORT'));
  assert.deepEqual(empty.effects, []);
});

test('报工审批拒绝工人，即使数量有效；管理员批准与依赖冲销逐项检查', async () => {
  const facts = { ...defaultFacts('report'), good_qty: '10', bad_qty: '0' };
  const unauthorized = await preview('report', 'pending', 'approve', facts, w);
  assert.equal(unauthorized.allowed, false); assert.equal(unauthorized.next_state, 'pending');
  assert.ok(unauthorized.errors.some((error: { code: string }) => error.code === 'ROLE_REQUIRED'));
  const approved = await preview('report', 'pending', 'approve', facts);
  assert.equal(approved.allowed, true); assert.equal(approved.next_state, 'approved');
  const blocked = await preview('report', 'approved', 'reverse', { ...facts, has_reverse_dependencies: true });
  assert.equal(blocked.allowed, false); assert.ok(blocked.errors.some((error: { code: string }) => error.code === 'REVERSE_DEPENDENCIES'));
  assert.equal(blocked.next_state, 'approved'); assert.deepEqual(blocked.effects, []);
  const reversed = await preview('report', 'approved', 'reverse', { ...facts, has_reverse_dependencies: false });
  assert.equal(reversed.allowed, true); assert.equal(reversed.next_state, 'reversed');
});

test('出库可用10申请8或恰好10可批准；申请11不可负库存', async () => {
  const facts = { ...defaultFacts('stock_movement'), movement_kind: 'out', available_qty: '10' };
  for (const requested_qty of ['8', '10']) {
    const result = await preview('stock_movement', 'pending', 'approve', { ...facts, requested_qty });
    assert.equal(result.allowed, true); assert.equal(result.next_state, 'approved'); assert.deepEqual(result.errors, []);
  }
  const insufficient = await preview('stock_movement', 'pending', 'approve', { ...facts, requested_qty: '11' });
  assert.equal(insufficient.allowed, false); assert.equal(insufficient.next_state, 'pending');
  assert.ok(insufficient.errors.some((error: { code: string }) => error.code === 'INSUFFICIENT_STOCK')); assert.deepEqual(insufficient.effects, []);
});

test('需要检验的入库未通过不能批准；报工与库存冲销都受后续依赖约束', async () => {
  const facts = { ...defaultFacts('stock_movement'), movement_kind: 'in', requested_qty: '10', quality_required: true };
  const unchecked = await preview('stock_movement', 'pending', 'approve', { ...facts, quality_passed: false });
  assert.equal(unchecked.allowed, false); assert.ok(unchecked.errors.some((error: { code: string }) => error.code === 'QUALITY_REQUIRED'));
  const passed = await preview('stock_movement', 'pending', 'approve', { ...facts, quality_passed: true });
  assert.equal(passed.allowed, true); assert.equal(passed.next_state, 'approved');
  const blocked = await preview('stock_movement', 'approved', 'reverse', { ...facts, quality_passed: true, has_reverse_dependencies: true });
  assert.equal(blocked.allowed, false); assert.equal(blocked.next_state, 'approved');
  assert.ok(blocked.errors.some((error: { code: string }) => error.code === 'REVERSE_DEPENDENCIES'));
});

test('销售有效明细才能审核，全量履约才能关闭，有下游不能直接取消', async () => {
  const valid = { ...defaultFacts('sales'), line_count: 1, quantity_valid: true, ordered_qty: '100' };
  const approved = await preview('sales', 'draft', 'approve', valid);
  assert.equal(approved.allowed, true); assert.equal(approved.next_state, 'approved');
  const invalid = await preview('sales', 'draft', 'approve', { ...valid, line_count: 0 });
  assert.equal(invalid.allowed, false); assert.ok(invalid.errors.some((error: { code: string }) => error.code === 'ORDER_INCOMPLETE'));
  const partial = await preview('sales', 'approved', 'close', { ...valid, shipped_qty: '60' });
  assert.equal(partial.allowed, false); assert.ok(partial.errors.some((error: { code: string }) => error.code === 'UNSHIPPED_QUANTITY'));
  const closed = await preview('sales', 'approved', 'close', { ...valid, shipped_qty: '100' });
  assert.equal(closed.allowed, true); assert.equal(closed.next_state, 'closed');
  const dependent = await preview('sales', 'approved', 'cancel', { ...valid, has_downstream: true });
  assert.equal(dependent.allowed, false); assert.ok(dependent.errors.some((error: { code: string }) => error.code === 'DOWNSTREAM_EXISTS'));
});

test('工单开工需领料条件；完工同时检查良品、待审报工与质量', async () => {
  const base = { ...defaultFacts('work_order'), plan_qty: '50', good_qty: '50' };
  const blockedStart = await preview('work_order', 'planned', 'start', { ...base, materials_ready: false });
  assert.equal(blockedStart.allowed, false); assert.ok(blockedStart.errors.some((error: { code: string }) => error.code === 'MATERIALS_NOT_READY'));
  const started = await preview('work_order', 'planned', 'start', { ...base, materials_ready: true });
  assert.equal(started.allowed, true); assert.equal(started.next_state, 'running');
  const invalid = await preview('work_order', 'running', 'complete', { ...base, good_qty: '49', pending_reports: true, quality_passed: false });
  assert.equal(invalid.allowed, false); assert.equal(invalid.next_state, 'running');
  assert.deepEqual(invalid.errors.map((error: { code: string }) => error.code).sort(), ['GOOD_QUANTITY_INSUFFICIENT', 'PENDING_REPORTS', 'QUALITY_REQUIRED']);
  const completed = await preview('work_order', 'running', 'complete', { ...base, pending_reports: false, quality_passed: true });
  assert.equal(completed.allowed, true); assert.equal(completed.next_state, 'completed');
  const wrongState = await preview('work_order', 'planned', 'complete', { ...base, pending_reports: false, quality_passed: true });
  assert.equal(wrongState.allowed, false); assert.ok(wrongState.errors.some((error: { code: string }) => error.code === 'STATE_TRANSITION'));
});

test('事实值按真实类型校验，数量不接受浮点、NaN、负数与超精度文本', async () => {
  const payload = { domain: 'report', state: 'draft', action: 'submit', facts: { good_qty: '10', bad_qty: '0' } };
  for (const good_qty of [0.1, 'NaN', '-1', '0.0000001']) {
    const result = await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(a, true), payload: { ...payload, facts: { ...payload.facts, good_qty } } });
    assert.equal(result.statusCode, 400, result.body);
  }
  const sales = await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(a, true), payload: { domain: 'sales', state: 'draft', action: 'approve', facts: { ...defaultFacts('sales'), line_count: 1.5, quantity_valid: true, ordered_qty: '10' } } });
  assert.equal(sales.statusCode, 400);
  const stock = await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(a, true), payload: { domain: 'stock_movement', state: 'pending', action: 'approve', facts: { ...defaultFacts('stock_movement'), movement_kind: 'transfer', requested_qty: '10' } } });
  assert.equal(stock.statusCode, 400);
});

test('成功与失败的黄金预检均不改变真实数据与审计，重复调用仍未过账', async () => {
  const initial = await businessSnapshot();
  for (let attempt = 0; attempt < 2; attempt++) {
    await preview('report', 'draft', 'submit', { good_qty: '0', bad_qty: '10' }, w);
    await preview('report', 'pending', 'approve', { good_qty: '0', bad_qty: '10' });
    await preview('stock_movement', 'pending', 'approve', { movement_kind: 'out', available_qty: '10', requested_qty: '8' });
    await preview('stock_movement', 'pending', 'approve', { movement_kind: 'out', available_qty: '10', requested_qty: '11' });
  }
  assert.deepEqual(await businessSnapshot(), initial);
});

test('预检角色只能来自会话，伪造角色请求头或facts不能获得审批权', async () => {
  const payload = { domain: 'report', state: 'pending', action: 'approve', facts: { good_qty: '10', bad_qty: '0' } };
  const spoofedHeader = await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: { ...headers(w, true), 'x-role': 'admin' }, payload });
  assert.equal(spoofedHeader.statusCode, 200);
  assert.equal(spoofedHeader.json().allowed, false);
  assert.ok(spoofedHeader.json().errors.some((error: { code: string }) => error.code === 'ROLE_REQUIRED'));
  const spoofedFact = await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(w, true), payload: { ...payload, facts: { ...payload.facts, role: 'admin' } } });
  assert.equal(spoofedFact.statusCode, 400); assert.equal(spoofedFact.json().error.code, 'UNKNOWN_FACT');
});

test('库存方向枚举拒绝数组与对象，避免绕过负库存和入库检验预检', async () => {
  const initial = await businessSnapshot();
  for (const movement_kind of [['out'], ['in'], { value: 'out' }]) {
    const result = await app.inject({ method: 'POST', url: '/api/design-preview/transition', headers: headers(a, true), payload: {
      domain: 'stock_movement', state: 'pending', action: 'approve', facts: {
        movement_kind, available_qty: '0', requested_qty: '11', quality_required: true, quality_passed: false,
      },
    } });
    assert.equal(result.statusCode, 400, result.body);
    assert.equal(result.json().error.code, 'FACT_FORMAT');
  }
  assert.deepEqual(await businessSnapshot(), initial);
});
