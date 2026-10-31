import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { classifyAttachmentHints, resetIntakeForTests } from '../src/ai/intake.js';
import { resetBomPreviewsForTests } from '../src/ai/bom.js';
import { resetQuickOrderForTests } from '../src/ai/quick-order.js';
import { resetDrawingForTests } from '../src/ai/drawing.js';

test('认型规则：名片 / 单据 / 其他 / 未知', () => {
  assert.equal(classifyAttachmentHints({ filename: '张三名片.png' }).kind, 'business_card');
  assert.equal(classifyAttachmentHints({ filename: '送货单-0912.pdf' }).kind, 'order_doc');
  assert.equal(classifyAttachmentHints({ filename: '西湖风景.jpg' }).kind, 'other');
  assert.equal(classifyAttachmentHints({ filename: 'scan-001.bin' }).kind, 'unknown');
});

let db: Database;
let app: FastifyInstance;
type Login = { cookie: string; csrf: string };
let login: Login;
const password = 'LocalTestOnly-AiS0-Admin!';
const tenantId = randomUUID();
const userId = randomUUID();
let customerId = '';

async function doLogin(): Promise<Login> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { tenant_slug: 'ai-s0-demo', username: 's0.ai', password },
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

function multipart(text: string, filename: string, fields: Record<string, string> = {}) {
  const boundary = '----AiS0Boundary7MA4YWxk';
  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    body +=
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`;
  }
  body +=
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `${text}\r\n` +
    `--${boundary}--\r\n`;
  return {
    payload: body,
    headers: {
      ...headers(true),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

async function countContacts() {
  return db.admin(async (sql) => {
    const row = (
      await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM money_contacts WHERE tenant_id=$1', [
        tenantId,
      ])
    ).rows[0];
    return Number(row?.n ?? '0');
  });
}

async function countContracts() {
  return db.admin(async (sql) => {
    const row = (
      await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM money_contracts WHERE tenant_id=$1', [
        tenantId,
      ])
    ).rows[0];
    return Number(row?.n ?? '0');
  });
}

async function countAudit(previewId?: string) {
  return db.admin(async (sql) => {
    if (previewId) {
      const row = (
        await sql.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM ai_action_audit WHERE tenant_id=$1 AND preview_id=$2',
          [tenantId, previewId],
        )
      ).rows[0];
      return Number(row?.n ?? '0');
    }
    const row = (
      await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM ai_action_audit WHERE tenant_id=$1', [
        tenantId,
      ])
    ).rows[0];
    return Number(row?.n ?? '0');
  });
}

before(async () => {
  resetIntakeForTests();
  resetBomPreviewsForTests();
  resetQuickOrderForTests();
  resetDrawingForTests();
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenantId, 'ai-s0-demo', 'AI S0 演示']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      userId,
      's0.ai',
      'S0管理员',
      hash,
    ]);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [
      tenantId,
      userId,
      'admin',
    ]);
  });
  app = await createApp(db);
  login = await doLogin();

  const customerRes = await app.inject({
    method: 'POST',
    url: '/api/customers',
    headers: headers(true),
    payload: { request_key: `s0-cust-${randomUUID()}`, code: 'C-S0-01', name: '名片演示客户' },
  });
  assert.equal(customerRes.statusCode, 201, customerRes.body);
  customerId = customerRes.json().customer.id as string;
  assert.ok(customerId);
});

after(async () => {
  await app.close();
  await db.close();
});

test('名片认型出确认卡，确认前不写联系人/合同', async () => {
  const beforeContacts = await countContacts();
  const beforeContracts = await countContracts();
  const cardText =
    '姓名：李明\n电话：13800138000\n公司：名片演示客户有限公司\n职位：销售经理\n这是一张名片扫描件';
  const classified = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/classify',
    ...multipart(cardText, '李明名片.txt'),
  });
  assert.equal(classified.statusCode, 200, classified.body);
  const body = classified.json();
  assert.equal(body.kind, 'business_card');
  assert.ok(body.preview_id);
  assert.ok(body.confirm_card);
  assert.deepEqual(body.forbidden_writes, ['money_contracts', 'work_orders', 'sales_orders']);
  assert.equal(await countContacts(), beforeContacts, '确认前不应写联系人');
  assert.equal(await countContracts(), beforeContracts, '名片路径不得创建合同');
});

test('统一 writes/confirm 写入联系人并记审计；cancel 不写库也记审计', async () => {
  const cardText = '姓名：王芳\n手机：13900139000\n公司：名片演示客户\n名片';
  const classified = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/classify',
    ...multipart(cardText, '王芳-名片.txt'),
  });
  assert.equal(classified.statusCode, 200, classified.body);
  const previewId = classified.json().preview_id as string;
  const beforeContacts = await countContacts();
  const beforeContracts = await countContracts();

  const cancelled = await app.inject({
    method: 'POST',
    url: '/api/ai/writes/cancel',
    headers: headers(true),
    payload: { kind: 'contact', preview_id: previewId },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().ok, true);
  assert.ok(cancelled.json().audit_id);
  assert.equal(await countContacts(), beforeContacts);
  assert.ok((await countAudit(previewId)) >= 1);

  const classified2 = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/classify',
    ...multipart(cardText, '王芳-名片2.txt'),
  });
  const previewId2 = classified2.json().preview_id as string;
  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/ai/writes/confirm',
    headers: headers(true),
    payload: {
      kind: 'contact',
      preview_id: previewId2,
      customer_id: customerId,
      party_kind: 'customer',
    },
  });
  assert.equal(confirmed.statusCode, 201, confirmed.body);
  const conf = confirmed.json();
  assert.equal(conf.kind, 'contact');
  assert.ok(conf.audit_id);
  assert.equal(conf.data.created_contract, false);
  assert.equal(conf.data.created_work_order, false);
  assert.equal(await countContacts(), beforeContacts + 1);
  assert.equal(await countContracts(), beforeContracts);

  const auditList = await app.inject({
    url: `/api/ai/writes/audit?preview_id=${previewId2}`,
    headers: headers(),
  });
  assert.equal(auditList.statusCode, 200, auditList.body);
  const items = auditList.json().items as Array<{ result: string; action: string; preview_id: string }>;
  assert.ok(items.some((row) => row.action === 'write.confirm' && row.result === 'ok'));
});

test('writes/confirm 失败也记审计', async () => {
  const before = await countAudit();
  const failed = await app.inject({
    method: 'POST',
    url: '/api/ai/writes/confirm',
    headers: headers(true),
    payload: { kind: 'contact', preview_id: randomUUID() },
  });
  assert.equal(failed.statusCode, 404, failed.body);
  assert.ok((await countAudit()) > before);
});

test('聊天问应收可调工厂助理只读', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/ai/factory/ask',
    headers: headers(true),
    payload: { question: '应收还有多少' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.intent, 'money');
  assert.ok(/应收|未收|已收/.test(body.answer || ''));
});
