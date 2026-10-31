import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { detectFactoryIntent, FACTORY_ACTION_PATHS } from '../src/ai/factory.js';

test('工厂助理意图路由：进度/钱/工资/三本账/拒写/开放', () => {
  assert.equal(detectFactoryIntent('今天生产进度怎么样'), 'progress');
  assert.equal(detectFactoryIntent('进度怎么样'), 'progress');
  assert.equal(detectFactoryIntent('产线忙不忙'), 'progress');
  assert.equal(detectFactoryIntent('有没有延期'), 'progress');
  assert.equal(detectFactoryIntent('在产多少'), 'progress');
  assert.equal(detectFactoryIntent('应收还有多少未收'), 'money');
  assert.equal(detectFactoryIntent('应收还有多少'), 'money');
  assert.equal(detectFactoryIntent('还欠多少钱'), 'money');
  assert.equal(detectFactoryIntent('客户欠我们多少'), 'money');
  assert.equal(detectFactoryIntent('催款情况'), 'money');
  assert.equal(detectFactoryIntent('超应收有没有'), 'money');
  assert.equal(detectFactoryIntent('工资待审多少'), 'wage');
  assert.equal(detectFactoryIntent('工资有没有待审'), 'wage');
  assert.equal(detectFactoryIntent('报工待审几笔'), 'wage');
  assert.equal(detectFactoryIntent('工资结了没'), 'wage');
  assert.equal(detectFactoryIntent('查一下三本账'), 'triple');
  assert.equal(detectFactoryIntent('三本账'), 'triple');
  assert.equal(detectFactoryIntent('厂长看板'), 'triple');
  assert.equal(detectFactoryIntent('今天有啥异常'), 'triple');
  assert.equal(detectFactoryIntent('帮我创建一张加工单'), 'refuse_write');
  assert.equal(detectFactoryIntent('怎么报工'), 'open');
  assert.equal(detectFactoryIntent('随便聊聊'), 'open');
  assert.equal(detectFactoryIntent('本周质量怎么样？'), 'open');
  assert.equal(detectFactoryIntent('今天厂里整体怎样'), 'open');
});

let db: Database;
let app: FastifyInstance;
type Login = { cookie: string; csrf: string };
let adminLogin: Login;
let workerLogin: Login;
const adminPassword = 'LocalTestOnly-AiFactory-Admin!';
const workerPassword = 'LocalTestOnly-AiFactory-Worker!';
const tenantId = randomUUID();
const adminId = randomUUID();
const workerId = randomUUID();

async function doLogin(username: string, password: string): Promise<Login> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { tenant_slug: 'ai-factory-demo', username, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(value);
  return { cookie: value.split(';')[0]!, csrf: response.json().csrf_token };
}

async function ask(login: Login, question: string) {
  return app.inject({
    method: 'POST',
    url: '/api/ai/factory/ask',
    headers: { cookie: login.cookie, 'x-csrf-token': login.csrf },
    payload: { question },
  });
}

async function businessCounts(sql: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, string>[] }> }) {
  const tables = ['work_orders', 'open_items', 'payments', 'wage_events', 'production_reports', 'shipments'];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const row = (await sql.query(`SELECT count(*)::text AS n FROM ${table}`)).rows[0];
    out[table] = Number(row?.n ?? '0');
  }
  return out;
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const adminHash = await hashPassword(adminPassword);
  const workerHash = await hashPassword(workerPassword);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenantId, 'ai-factory-demo', '工厂助理演示']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      adminId, 'factory.admin', '工厂管理员', adminHash,
    ]);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      workerId, 'factory.worker', '工厂工人', workerHash,
    ]);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenantId, adminId, 'admin']);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenantId, workerId, 'worker']);
  });
  app = await createApp(db);
  adminLogin = await doLogin('factory.admin', adminPassword);
  workerLogin = await doLogin('factory.worker', workerPassword);
});

after(async () => {
  await app?.close();
  await db?.close();
});

test('POST /api/ai/factory/ask 进度意图返回中文与卡片', async () => {
  const res = await ask(adminLogin, '今天生产进度怎么样');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.intent, 'progress');
  assert.match(body.answer, /[\u4e00-\u9fff]/);
  assert.match(body.answer, /加工单|在产|生产/);
  assert.ok(Array.isArray(body.cards));
  assert.equal(body.action_path, FACTORY_ACTION_PATHS.progress);
  assert.equal(body.action_label, '去处理');
});

test('POST /api/ai/factory/ask 钱意图返回库数字（可为0）', async () => {
  const res = await ask(adminLogin, '应收还有多少未收');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.intent, 'money');
  assert.match(body.answer, /应收|未收|已收/);
  assert.match(body.answer, /\d/);
  assert.ok(body.cards?.some((c: { title: string }) => /未收|应收/.test(c.title)));
  assert.equal(body.action_path, FACTORY_ACTION_PATHS.money);
});

test('POST /api/ai/factory/ask 查一下三本账一次返回三本 books', async () => {
  const res = await ask(adminLogin, '查一下三本账');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.intent, 'triple');
  assert.ok(Array.isArray(body.books));
  assert.equal(body.books.length, 3);
  assert.deepEqual(
    body.books.map((b: { intent: string }) => b.intent),
    ['progress', 'money', 'wage'],
  );
  assert.ok(body.books.every((b: { action_path: string }) => b.action_path && b.action_path.startsWith('/')));
  assert.match(body.answer, /三本账|进度|工资|核心结论/);
  assert.ok(typeof body.conclusion === 'string' && body.conclusion.length > 0);
  assert.ok(Array.isArray(body.anomalies));
  assert.ok(body.anomalies.length >= 1);
  assert.ok(body.anomalies.every((a: { action_path: string }) => a.action_path && a.action_path.startsWith('/')));
});

test('口语：今天有啥异常 / 厂长看板 走三本账并带 anomalies', async () => {
  for (const q of ['今天有啥异常', '厂长看板', '看看三本账']) {
    const res = await ask(adminLogin, q);
    assert.equal(res.statusCode, 200, `${q} => ${res.body}`);
    const body = res.json();
    assert.equal(body.intent, 'triple', q);
    assert.ok(Array.isArray(body.anomalies), q);
  }
});

test('口语：进度/应收/工资各至少 3 条', async () => {
  const cases: Array<[string, string]> = [
    ['产线忙不忙', 'progress'],
    ['有没有延期', 'progress'],
    ['在产多少', 'progress'],
    ['客户欠我们多少', 'money'],
    ['催款情况', 'money'],
    ['超应收有没有', 'money'],
    ['报工待审几笔', 'wage'],
    ['工资结了没', 'wage'],
    ['工资有没有待审', 'wage'],
  ];
  for (const [q, intent] of cases) {
    const res = await ask(adminLogin, q);
    assert.equal(res.statusCode, 200, `${q} => ${res.body}`);
    const body = res.json();
    assert.equal(body.intent, intent, q);
    assert.match(body.answer, /核心结论|详情|[一-鿿]/);
    assert.equal(body.action_label, '去处理');
    assert.ok(body.action_path && String(body.action_path).startsWith('/'));
  }
});

test('GET /api/ai/factory/briefing 返回晨报 stub 形状', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/ai/factory/briefing',
    headers: { cookie: adminLogin.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.push, 'reserved');
  assert.ok(body.supported?.includes('manual_triple'));
});

test('POST /api/ai/factory/ask 怎么报工走开放路径并给用法，不返回假工单数', async () => {
  const res = await ask(adminLogin, '怎么报工');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.intent, 'open');
  assert.match(body.answer, /报工|小助手|用法|工作台/);
  assert.doesNotMatch(body.answer, /共有\s*[1-9]\d*\s*张加工单/);
});

test('开放路径：本周质量怎么样 非罐头 guide', async () => {
  const res = await ask(adminLogin, '本周质量怎么样？');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.intent, 'open');
  assert.match(body.answer, /简报|质量|生产|往来|检验|质检/);
  assert.doesNotMatch(body.answer, /^我是工厂助理，只做只读汇总/);
});

test('开放路径：今天厂里整体怎样 返回简报', async () => {
  const res = await ask(adminLogin, '今天厂里整体怎样');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.intent, 'open');
  assert.match(body.answer, /简报|生产|往来|工资/);
});

test('POST /api/ai/factory/ask 拒绝写单据', async () => {
  const res = await ask(adminLogin, '帮我创建一张加工单');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.intent, 'refuse_write');
  assert.match(body.answer, /只读|不会创建|不写/);
});

test('无财务权限问应收返回 403 中文且不泄漏数字', async () => {
  const res = await ask(workerLogin, '应收还有多少未收');
  assert.equal(res.statusCode, 403, res.body);
  const body = res.json();
  assert.match(body.error?.message ?? '', /财务|权限/);
  assert.doesNotMatch(JSON.stringify(body), /"receivable"|未收合计/);
});

test('ask 前后业务表 count 不变，仅写 ai_action_log', async () => {
  const beforeCounts = await db.admin((sql) => businessCounts(sql));
  const logBefore = await db.admin(async (sql) =>
    Number((await sql.query('SELECT count(*)::text AS n FROM ai_action_log')).rows[0]!.n),
  );

  const res = await ask(adminLogin, '工资待审多少');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().intent, 'wage');

  const afterCounts = await db.admin((sql) => businessCounts(sql));
  const logAfter = await db.admin(async (sql) =>
    Number((await sql.query('SELECT count(*)::text AS n FROM ai_action_log')).rows[0]!.n),
  );

  assert.deepEqual(afterCounts, beforeCounts);
  assert.ok(logAfter > logBefore);
});
