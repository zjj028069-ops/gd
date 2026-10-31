import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { runAssistantChat } from '../src/ai/assistant.js';
import {
  resetKnowledgeCache,
  searchKnowledge,
  shouldRefuseBusinessQuery,
  isOffTopicQuestion,
} from '../src/ai/knowledge.js';

const mockCfg = { provider: 'mock' as const, apiKey: null, openaiBase: '', openaiModel: '', quickOrderDailyLimit: 50, quotaDisabled: false };

test('知识库能命中报工 FAQ', () => {
  resetKnowledgeCache();
  const hit = searchKnowledge('如何报工');
  assert.ok(hit);
  assert.match(hit!.article.title, /报工/);
});

test('弱匹配不乱答：扩展字段不应误命中销售订单', () => {
  resetKnowledgeCache();
  const hit = searchKnowledge('扩展字段如何新增');
  if (hit) {
    assert.doesNotMatch(hit.article.title, /销售订单/);
    assert.match(hit.article.title, /扩展字段|字段/);
  }
  // 极弱问法「订单」可能命中销售，但「扩展字段」单独不应落到销售订单
  const weak = searchKnowledge('扩展字段');
  if (weak) assert.doesNotMatch(weak.article.title, /销售订单/);
});

test('新知识库可命中打印模板与盘点', () => {
  resetKnowledgeCache();
  const print = searchKnowledge('打印模板怎么设置');
  assert.ok(print);
  assert.match(print!.article.title, /打印/);
  const count = searchKnowledge('库存盘点怎么做');
  assert.ok(count);
  assert.match(count!.article.title, /盘点/);
});

test('业务查数问题应拒绝', () => {
  assert.equal(shouldRefuseBusinessQuery('这张工单进度到哪了'), true);
  assert.equal(shouldRefuseBusinessQuery('库存还有多少'), true);
  assert.equal(shouldRefuseBusinessQuery('如何报工'), false);
});

test('mock 聊天返回非空中文，深度模式仍可用', async () => {
  resetKnowledgeCache();
  const quick = await runAssistantChat([{ role: 'user', content: '如何报工' }], 'quick', mockCfg);
  assert.ok(quick.reply.length > 10);
  assert.match(quick.reply, /报工|工作台|生产/);
  const deep = await runAssistantChat([{ role: 'user', content: '如何报工' }], 'deep', mockCfg);
  assert.ok(deep.reply.length >= quick.reply.length - 5);
  assert.match(deep.reply, /深度|报工|步骤|入口/);
  const refused = await runAssistantChat([{ role: 'user', content: '查一下工单进度' }], 'quick', mockCfg);
  assert.match(refused.reply, /工厂助理|不会查/);
});

test('未命中开放路径：天气礼貌说明；扩展字段有用回答', async () => {
  resetKnowledgeCache();
  assert.equal(isOffTopicQuestion('今天天气怎样'), true);
  const weather = await runAssistantChat([{ role: 'user', content: '今天天气怎样' }], 'quick', mockCfg);
  assert.match(weather.reply, /产品助手|答不了|报工|订单/);
  assert.equal(weather.provider, 'mock-open');

  const ext = await runAssistantChat([{ role: 'user', content: '扩展字段如何新增' }], 'quick', mockCfg);
  assert.match(ext.reply, /扩展字段|列表|新增/);
  assert.doesNotMatch(ext.reply, /暂时没有在知识库里找到特别贴切/);
});

test('打印模板未仅回 FALLBACK', async () => {
  resetKnowledgeCache();
  const r = await runAssistantChat([{ role: 'user', content: '打印模板怎么设置' }], 'quick', mockCfg);
  assert.match(r.reply, /打印|模板/);
  assert.doesNotMatch(r.reply, /暂时没有在知识库里找到特别贴切/);
});

test('页面上下文问题：无 context 诚实说明；有 path 说明当前页', async () => {
  const bare = await runAssistantChat([{ role: 'user', content: '目前在那个界面?' }], 'quick', mockCfg);
  assert.match(bare.reply, /看不到|请告诉我/);
  assert.equal(bare.provider, 'mock-context');
  const withCtx = await runAssistantChat(
    [{ role: 'user', content: '目前在哪个界面' }],
    'quick',
    mockCfg,
    { path: '/transfers', title: '调拨单 | 赛德瑞克' },
  );
  assert.match(withCtx.reply, /调拨单|\/transfers/);
  assert.equal(withCtx.provider, 'mock-context');
});


let db: Database;
let app: FastifyInstance;
type Login = { cookie: string; csrf: string };
let login: Login;
const password = 'LocalTestOnly-AiAssistant!';
const tenantId = randomUUID();
const userId = randomUUID();

async function doLogin(): Promise<Login> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: 'ai-demo', username: 'ai.admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(value);
  return { cookie: value.split(';')[0]!, csrf: response.json().csrf_token };
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenantId, 'ai-demo', 'AI演示']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [userId, 'ai.admin', 'AI管理员', hash]);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenantId, userId, 'admin']);
  });
  app = await createApp(db);
  login = await doLogin();
});

after(async () => {
  await app?.close();
  await db?.close();
});

test('POST /api/ai/assistant/chat 需登录与 CSRF，mock 回复非空', async () => {
  const anon = await app.inject({ method: 'POST', url: '/api/ai/assistant/chat', payload: { messages: [{ role: 'user', content: '如何报工' }], mode: 'quick' } });
  assert.equal(anon.statusCode, 401);
  const noCsrf = await app.inject({
    method: 'POST',
    url: '/api/ai/assistant/chat',
    headers: { cookie: login.cookie },
    payload: { messages: [{ role: 'user', content: '如何报工' }], mode: 'quick' },
  });
  assert.equal(noCsrf.statusCode, 403);
  const ok = await app.inject({
    method: 'POST',
    url: '/api/ai/assistant/chat',
    headers: { cookie: login.cookie, 'x-csrf-token': login.csrf },
    payload: { messages: [{ role: 'user', content: '如何报工' }], mode: 'deep' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.ok(typeof body.reply === 'string' && body.reply.length > 5);
  assert.match(body.reply, /[\u4e00-\u9fff]/);
  const meta = await app.inject({ url: '/api/ai/assistant/meta', headers: { cookie: login.cookie } });
  assert.equal(meta.statusCode, 200);
  assert.equal(meta.json().name, '赛德瑞克小助手');
});
