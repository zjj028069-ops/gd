/**
 * 第七轮浏览器验收数据（幂等）。
 * 前置：npm run dev:setup && npm run dev
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const salesPass = randomBytes(9).toString('base64url');

async function login(username, password) {
  // 理由：空库连跑 seed-round10/6 后紧接本脚本，登录限流会让 sales.b 等新账号直接 429；与 seed-round10 一致做退避重试，不放宽业务断言。
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
    });
    const json = await res.json().catch(() => ({}));
    const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
    if (json.csrf_token) return { csrf: json.csrf_token, cookie, userId: json.user?.id, name: json.user?.display_name };
    const code = json?.error?.code ?? '';
    const msg = json?.error?.message ?? '';
    if (code === 'RATE_LIMITED' || /限流|RATE_LIMIT/i.test(msg) || res.status === 429) {
      const waitMs = attempt * 2000;
      console.log(`登录限流 ${username}，${waitMs}ms 后重试 (${attempt}/8)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`登录失败 ${username} ${JSON.stringify(json).slice(0, 240)}`);
  }
  throw new Error(`登录失败 ${username}: RATE_LIMITED 重试耗尽`);
}
async function api(session, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 500)}`);
  return json;
}
const key = () => crypto.randomUUID();

const admin = await login('admin.local', pass);
const members = (await api(admin, 'GET', '/api/platform/members')).items ?? [];
const adminId = members.find((item) => item.username === 'admin.local' || item.display_name === '本地管理员')?.id ?? admin.userId;

const departments = [
  ['生产管理部', null],
  ['生产一部', '生产管理部'],
  ['质检一部', '生产管理部'],
  ['采销部', null],
  ['采购一部', '采销部'],
  ['销售一部', '采销部'],
  ['售后部', null],
  ['售后一部', '售后部'],
  ['维保一部', '售后部'],
  ['总经理办公室', null],
];
let deptRows = (await api(admin, 'GET', '/api/system/departments')).items ?? [];
for (const [name, parentName] of departments) {
  if (deptRows.some((item) => item.name === name)) continue;
  const parent = parentName ? deptRows.find((item) => item.name === parentName) : null;
  await api(admin, 'POST', '/api/system/departments', { name, parent_id: parent?.id ?? null });
  deptRows = (await api(admin, 'GET', '/api/system/departments')).items ?? [];
}
const salesDept = deptRows.find((item) => item.name === '销售一部');

const teamNames = ['默认团队', '维修保养部', '客服部', '售后维修部', '工单回访部', '工单审核部'];
let teams = (await api(admin, 'GET', '/api/system/teams')).items ?? [];
for (const name of teamNames) {
  if (teams.some((item) => item.name === name)) continue;
  await api(admin, 'POST', '/api/system/teams', { name, leader_id: adminId });
  teams = (await api(admin, 'GET', '/api/system/teams')).items ?? [];
}
const defaultTeam = teams.find((item) => item.name === '默认团队');

const catalog = (await api(admin, 'GET', '/api/system/permission-catalog')).modules ?? [];
const customer = catalog.find((item) => item.key === 'customer');
const customerPoints = customer.groups.flatMap((group) => group.points.map((point) => point.code));
const customerScopes = {};
for (const group of customer.groups) for (const point of group.points) if (point.scopes) customerScopes[point.code] = 'self';
const preset = ['系统管理员', '售后工程师', '客服人员', '财务', '售后主管', '仓库管理员', '生产工', '质检员', '生产主管', '设备维保人员'];
let roles = (await api(admin, 'GET', '/api/system/roles')).items ?? [];
for (const name of preset) {
  if (roles.some((item) => item.name === name)) continue;
  await api(admin, 'POST', '/api/system/roles', { name, points: name === '仓库管理员' ? ['menu.warehouse.view', 'system.account'] : ['menu.produce.view'], scopes: {} });
  roles = (await api(admin, 'GET', '/api/system/roles')).items ?? [];
}
let salesRole = roles.find((item) => item.name === '销售员');
if (!salesRole) {
  salesRole = (await api(admin, 'POST', '/api/system/roles', { name: '销售员', points: customerPoints, scopes: customerScopes })).role;
  roles = (await api(admin, 'GET', '/api/system/roles')).items ?? [];
  salesRole = roles.find((item) => item.name === '销售员');
}

let users = (await api(admin, 'GET', '/api/system/users')).items ?? [];
async function ensureUser(username, display) {
  const existing = users.find((item) => item.username === username);
  if (existing) {
    await api(admin, 'PATCH', `/api/system/users/${existing.id}`, { password: salesPass });
    return;
  }
  await api(admin, 'POST', '/api/system/users', {
    username, display_name: display, phone: username.endsWith('.a') ? '13800001001' : '13800001002', password: salesPass,
    custom_role_id: salesRole.id, department_id: salesDept?.id, team_ids: [defaultTeam.id], seat: 'produce',
  });
}
await ensureUser('sales.a', '销售甲');
await ensureUser('sales.b', '销售乙');

let known = salesPass;
try { known = readFileSync('.local/round7-credentials.txt', 'utf8').match(/密码：(\S+)/)?.[1] ?? salesPass; } catch { /* 首次运行 */ }
const salesA = await login('sales.a', known).catch(() => login('sales.a', salesPass));
const salesB = await login('sales.b', known).catch(() => login('sales.b', salesPass));

async function ensureCustomer(session, name) {
  const list = await api(session, 'GET', '/api/money/customers');
  if ((list.items ?? []).some((item) => item.name === name)) return;
  await api(session, 'POST', '/api/money/customers', { name, contact_name: name, request_key: key() });
}
for (const name of ['R7客户A1', 'R7客户A2', 'R7客户A3']) await ensureCustomer(salesA, name);
await ensureCustomer(salesB, 'R7客户B1');

const warehouses = (await api(admin, 'GET', '/api/warehouse/warehouses')).items ?? [];
let warehouse = warehouses.find((item) => item.name === 'R7仓库');
if (!warehouse) {
  warehouse = (await api(admin, 'POST', '/api/warehouse/warehouses', { request_key: key(), name: 'R7仓库', province: '山东省', city: '青岛市', district: '市南区', address: 'R7' })).warehouse ?? (await api(admin, 'GET', '/api/warehouse/warehouses')).items.find((item) => item.name === 'R7仓库');
}
const products = (await api(admin, 'GET', '/api/products?page=1&page_size=100')).items ?? [];
let product = products.find((item) => item.name === 'R7测试螺栓');
if (!product) {
  const unit = (await api(admin, 'GET', '/api/units')).items[0];
  product = (await api(admin, 'POST', '/api/products', { code: 'R7-BOLT', name: 'R7测试螺栓', unit_id: unit.id, attribute: 'purchased' })).product;
}
const stock = (await api(admin, 'GET', '/api/warehouse/misc-bills?kind=else_in')).items ?? [];
if (!stock.some((item) => String(item.note ?? '').includes('R7入库100'))) {
  await api(admin, 'POST', '/api/warehouse/misc-bills', { request_key: key(), kind: 'else_in', warehouse_id: warehouse.id, note: 'R7入库100', lines: [{ product_id: product.id, quantity: '100', unit_price: '1' }] });
}
const suppliers = (await api(admin, 'GET', '/api/money/suppliers')).items ?? [];
let supplier = suppliers.find((item) => item.name === 'R7供应商');
if (!supplier) supplier = (await api(admin, 'POST', '/api/money/suppliers', { name: 'R7供应商', contact_name: '供', request_key: key() })).supplier;
const orders = (await api(admin, 'GET', '/api/money/purchase-orders')).items ?? [];
if (!orders.some((item) => item.note === 'R7螺栓采购')) {
  await api(admin, 'POST', '/api/money/purchase-orders', { supplier_id: supplier.id, buyer_id: adminId, note: 'R7螺栓采购', lines: [{ product_id: product.id, quantity: '200', unit_price: '2' }], request_key: key() });
}

const flows = (await api(admin, 'GET', '/api/audit/flows?module=customer')).items ?? [];
async function ensureFlow(name, objectType, enabled) {
  if (flows.some((item) => item.name === name)) return;
  await api(admin, 'POST', '/api/audit/flows', { module: 'customer', name, object_types: [objectType], allow_withdraw: false, enabled, levels: [{ sign_mode: 'or', approver_ids: [adminId] }] });
}
await ensureFlow('合同报价单审核流程', 'quotation', true);
await ensureFlow('合同收支审核流程', 'cash', true);
await ensureFlow('销售费用审核流程', 'expense', false);
for (const flow of flows) {
  if (flow.object_types?.includes('contract')) await api(admin, 'DELETE', `/api/audit/flows/${flow.id}`);
}

mkdirSync('.local', { recursive: true });
writeFileSync('.local/round7-credentials.txt', `企业：demo-a\n账号：sales.a\n姓名：销售甲\n密码：${salesPass}\n账号：sales.b\n姓名：销售乙\n密码：${salesPass}\n`, { mode: 0o600 });
console.log('第七轮演示数据已准备。凭据写入 .local/round7-credentials.txt');
