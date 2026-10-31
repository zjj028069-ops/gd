import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import {
  classifyAttachmentHints,
  resetIntakeForTests,
} from '../src/ai/intake.js';
import { parseOrderDocFields, resetContractIntakeForTests } from '../src/ai/intake-contract.js';

test('S2 认型分流：名片/订单/风景/未知', () => {
  assert.equal(classifyAttachmentHints({ filename: '张三名片.png' }).kind, 'business_card');
  assert.equal(classifyAttachmentHints({ filename: '送货单-0912.pdf' }).kind, 'order_doc');
  assert.equal(classifyAttachmentHints({ filename: '西湖风景.jpg' }).kind, 'other');
  assert.equal(classifyAttachmentHints({ filename: 'scan-001.bin' }).kind, 'unknown');
});

test('S2 订单文本解析抽客户与数量', () => {
  const f = parseOrderDocFields(
    '订单.txt',
    '',
    '客户名称：苏州演示厂\n商品编码：LOCAL001\n数量：12\n单价：8.5\n这是送货单',
  );
  assert.match(f.customer_name, /苏州演示厂/);
  assert.equal(f.product_code, 'LOCAL001');
  assert.equal(f.quantity, '12');
  assert.equal(f.unit_price, '8.5');
});

let db: Database;
let app: FastifyInstance;
type Login = { cookie: string; csrf: string };
let login: Login;
const password = 'LocalTestOnly-AiS2-Admin!';
const tenantId = randomUUID();
const userId = randomUUID();
let productId = '';
let unitId = '';

async function doLogin(): Promise<Login> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { tenant_slug: 'ai-s2-demo', username: 's2.ai', password },
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
  const boundary = '----AiS2Boundary7MA4YWxk';
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

async function countTable(table: string) {
  return db.admin(async (sql) => {
    const row = (
      await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE tenant_id=$1`, [
        tenantId,
      ])
    ).rows[0];
    return Number(row?.n ?? '0');
  });
}

before(async () => {
  resetIntakeForTests();
  resetContractIntakeForTests();
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenantId, 'ai-s2-demo', 'AI S2 演示']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      userId,
      's2.ai',
      'S2管理员',
      hash,
    ]);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [
      tenantId,
      userId,
      'admin',
    ]);
    unitId = (
      await sql.query<{ id: string }>(
        `INSERT INTO units(tenant_id,code,name) VALUES($1,'EA','个') RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    productId = (
      await sql.query<{ id: string }>(
        `INSERT INTO products(tenant_id,code,name,unit_id,active,attribute)
         VALUES($1,'LOCAL001','本地验收样例产品',$2,true,'manufactured') RETURNING id`,
        [tenantId, unitId],
      )
    ).rows[0]!.id;
    await sql.query(`INSERT INTO warehouses(tenant_id,code,name) VALUES($1,'WH1','一号仓')`, [tenantId]);
  });
  app = await createApp(db);
  login = await doLogin();
  assert.ok(productId);
});

after(async () => {
  await app.close();
  await db.close();
});

test('名片 → 确认卡；确认后有联系人/附件；无新合同/加工单', async () => {
  const beforeContacts = await countTable('money_contacts');
  const beforeContracts = await countTable('money_contracts');
  const beforeWo = await countTable('work_orders');
  const cardText = '姓名：赵名片\n电话：13700137001\n公司：S2名片客户\n名片';
  const classified = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/classify',
    ...multipart(cardText, '赵名片.txt'),
  });
  assert.equal(classified.statusCode, 200, classified.body);
  const body = classified.json();
  assert.equal(body.kind, 'business_card');
  assert.ok(body.preview_id);
  assert.ok(body.confirm_card);
  assert.equal(await countTable('money_contacts'), beforeContacts);

  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/ai/writes/confirm',
    headers: headers(true),
    payload: { kind: 'contact', preview_id: body.preview_id },
  });
  assert.equal(confirmed.statusCode, 201, confirmed.body);
  const conf = confirmed.json();
  assert.equal(conf.kind, 'contact');
  assert.ok(conf.audit_id);
  assert.equal(conf.data.created_contract, false);
  assert.equal(conf.data.created_work_order, false);
  assert.equal(await countTable('money_contacts'), beforeContacts + 1);
  assert.equal(await countTable('money_contracts'), beforeContracts);
  assert.equal(await countTable('work_orders'), beforeWo);
  assert.ok(conf.data.attachment_id, '原图应挂附件');
});

test('订单 → 合同预览；取消不写；确认后有单据+审计', async () => {
  const beforeContracts = await countTable('money_contracts');
  const orderText =
    '送货单\n客户名称：S2合同客户甲\n商品编码：LOCAL001\n数量：5\n单价：10\n备注：聊天落单验收';
  const classified = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/classify',
    ...multipart(orderText, '送货单-S2.txt'),
  });
  assert.equal(classified.statusCode, 200, classified.body);
  const body = classified.json();
  assert.equal(body.kind, 'order_doc');
  assert.ok(body.preview_id);
  assert.equal(body.confirm_card?.target, 'contract');
  assert.equal(await countTable('money_contracts'), beforeContracts, '确认前不写合同');

  const cancelled = await app.inject({
    method: 'POST',
    url: '/api/ai/writes/cancel',
    headers: headers(true),
    payload: { kind: 'contract', preview_id: body.preview_id },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().ok, true);
  assert.ok(cancelled.json().audit_id);
  assert.equal(await countTable('money_contracts'), beforeContracts);

  const classified2 = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/classify',
    ...multipart(orderText, '送货单-S2b.txt'),
  });
  const previewId2 = classified2.json().preview_id as string;
  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/ai/writes/confirm',
    headers: headers(true),
    payload: { kind: 'contract', preview_id: previewId2, chain_work_order: false },
  });
  assert.equal(confirmed.statusCode, 201, confirmed.body);
  const conf = confirmed.json();
  assert.equal(conf.kind, 'contract');
  assert.ok(conf.audit_id);
  assert.ok(conf.data.contract_code);
  assert.equal(conf.data.created_work_order, false);
  assert.equal(await countTable('money_contracts'), beforeContracts + 1);

  // 不双写：同一 preview 再确认应失败
  const again = await app.inject({
    method: 'POST',
    url: '/api/ai/writes/confirm',
    headers: headers(true),
    payload: { kind: 'contract', preview_id: previewId2 },
  });
  assert.equal(again.statusCode, 404, again.body);
  assert.equal(await countTable('money_contracts'), beforeContracts + 1);
});

test('风景图 → 追问，不静默写库', async () => {
  const beforeContracts = await countTable('money_contracts');
  const beforeContacts = await countTable('money_contacts');
  const beforeAtt = await countTable('attachments');
  const classified = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/classify',
    ...multipart('blue sky photo', '西湖风景.jpg'),
  });
  assert.equal(classified.statusCode, 200, classified.body);
  const body = classified.json();
  assert.equal(body.kind, 'other');
  assert.ok(body.ask_id);
  assert.ok(body.ask?.options?.length);
  assert.equal(await countTable('money_contracts'), beforeContracts);
  assert.equal(await countTable('money_contacts'), beforeContacts);

  const ignored = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/resolve',
    headers: headers(true),
    payload: { ask_id: body.ask_id, option_id: 'ignore' },
  });
  assert.equal(ignored.statusCode, 200, ignored.body);
  assert.equal(ignored.json().wrote, false);
  assert.equal(await countTable('attachments'), beforeAtt);
});

test('unknown → 追问，不写库', async () => {
  const beforeContracts = await countTable('money_contracts');
  const classified = await app.inject({
    method: 'POST',
    url: '/api/ai/intake/classify',
    ...multipart('\x00\x01\x02binary', 'scan-001.bin'),
  });
  assert.equal(classified.statusCode, 200, classified.body);
  const body = classified.json();
  assert.equal(body.kind, 'unknown');
  assert.ok(body.ask_id);
  assert.equal(await countTable('money_contracts'), beforeContracts);
});

test('问应收仍走厂长助理只读，不误进落单', async () => {
  const beforeContracts = await countTable('money_contracts');
  const res = await app.inject({
    method: 'POST',
    url: '/api/ai/factory/ask',
    headers: headers(true),
    payload: { question: '应收还有多少' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().intent, 'money');
  assert.equal(await countTable('money_contracts'), beforeContracts);
});
