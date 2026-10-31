/**
 * 第九轮验收数据（幂等）。前置：npm run dev:setup && npm run dev
 * 账号写入 .local/round9-credentials.txt（权限 0600）
 * 数字精确比较。连跑两次不新增合同、主链加工单、主链报工。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const rows = [];
let failed = false;

function num(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(String(value).replace(/,/g, ''));
}
function same(actual, expected) {
  return num(actual) === num(expected);
}
function step(name, ok, actual) {
  rows.push({ name, result: ok ? '通过' : '未通过', actual: String(actual) });
  if (!ok) failed = true;
  console.log(`${ok ? '通过' : '未通过'}\t${name}\t${actual}`);
}
function must(ok, name, actual) {
  step(name, ok, actual);
  if (!ok) throw new Error(`${name}：${actual}`);
}

function passwordOf(file, username) {
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${username} ${JSON.stringify(json).slice(0, 240)}`);
  return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name };
}
async function api(session, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie: session.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 500)}`);
  return json;
}
const key = () => crypto.randomUUID();

const devPass = {
  admin: passwordOf('.local/dev-credentials.txt', 'admin.local'),
  planner: passwordOf('.local/dev-credentials.txt', 'planner.local'),
  worker: passwordOf('.local/dev-credentials.txt', 'worker.local'),
};
if (!devPass.admin || !devPass.planner || !devPass.worker) throw new Error('缺少 .local/dev-credentials.txt 中的 admin.local / planner.local / worker.local');

const sessionFile = '.local/round9-sessions.json';
function readSessions() {
  if (!existsSync(sessionFile)) return {};
  try { return JSON.parse(readFileSync(sessionFile, 'utf8')); } catch { return {}; }
}
const savedSessions = readSessions();
async function sessionFor(username, password) {
  const saved = savedSessions[username];
  if (saved?.cookie && saved?.csrf && saved?.userId) {
    const probe = await fetch(`${API}/api/auth/me`, { headers: { cookie: saved.cookie } });
    if (probe.ok) return saved;
  }
  const fresh = await login(username, password);
  savedSessions[username] = fresh;
  writeFileSync(sessionFile, JSON.stringify(savedSessions), { mode: 0o600 });
  return fresh;
}
const admin = await sessionFor('admin.local', devPass.admin);
const planner = await sessionFor('planner.local', devPass.planner);
const worker = await sessionFor('worker.local', devPass.worker);
const sessions = new Map([[admin.userId, admin], [planner.userId, planner], [worker.userId, worker]]);
if (existsSync('.local/round7-credentials.txt')) {
  const extra = readFileSync('.local/round7-credentials.txt', 'utf8');
  for (const matched of extra.matchAll(/账号：(\S+)[\s\S]*?密码：(\S+)/g)) {
    try {
      const session = await login(matched[1], matched[2]);
      sessions.set(session.userId, session);
    } catch { /* 第七轮账号可能尚未创建 */ }
  }
}

const members = (await api(admin, 'GET', '/api/platform/members')).items ?? [];
let r9 = members.find((item) => item.username === 'r9.worker');
let r9Password = passwordOf('.local/round9-credentials.txt', 'r9.worker');
if (!r9) {
  r9Password = `R9w-${randomBytes(12).toString('base64url')}`;
  r9 = (await api(admin, 'POST', '/api/platform/members', { username: 'r9.worker', display_name: '回归工人', password: r9Password, role: 'worker' })).member;
  step('新建回归工人', true, 'r9.worker');
} else step('回归工人', r9.display_name === '回归工人', r9.display_name);
if (!r9Password) throw new Error('回归工人已存在，但 .local/round9-credentials.txt 没有密码');
mkdirSync('.local', { recursive: true });
const cred = `仅供本机开发验收。\n企业：demo-a\n账号：admin.local\n密码：${devPass.admin}\n账号：planner.local\n密码：${devPass.planner}\n账号：worker.local\n密码：${devPass.worker}\n账号：r9.worker\n姓名：回归工人\n密码：${r9Password}\n`;
writeFileSync('.local/round9-credentials.txt', cred, { mode: 0o600 });
chmodSync('.local/round9-credentials.txt', 0o600);
const r9Session = await sessionFor('r9.worker', r9Password);
sessions.set(r9Session.userId, r9Session);

const units = (await api(admin, 'GET', '/api/units')).items ?? [];
const unit = units.find((item) => item.name === '个') ?? units[0];
if (!unit) throw new Error('没有可用单位');

const products = (await api(admin, 'GET', '/api/products?page=1&page_size=100')).items ?? [];
async function ensureProduct(code, name, attribute) {
  const found = products.find((item) => item.name === name);
  if (found) return found;
  const created = (await api(admin, 'POST', '/api/products', { code, name, unit_id: unit.id, attribute })).product;
  products.push(created);
  return created;
}
const product = await ensureProduct('R9-GOOD', 'R9回归商品', 'manufactured');
const raw = await ensureProduct('R9-RAW', 'R9待审原料', 'purchased');

async function ensureProcess(code, name, rate, reporterIds) {
  // 理由：空库连跑时可能已有同编码不同名工序，只按 name 找会 POST 409；按 code 或 name 复用，不放宽验收数字。
  const list = (await api(admin, 'GET', '/api/processes')).items ?? [];
  let process = list.find((item) => item.name === name || item.code === code);
  if (!process) {
    process = (await api(admin, 'POST', '/api/processes', {
      code, name, standard_minutes: '1', reporter_ids: reporterIds, pricing_mode: 'piece', wage_rate: rate, inspection_scheme: 'none',
    })).process;
  } else {
    const sameReporters = reporterIds.length === process.reporter_ids.length && reporterIds.every((id) => process.reporter_ids.includes(id));
    if (!sameReporters || !same(process.wage_rate, rate) || process.pricing_mode !== 'piece') {
      process = (await api(admin, 'PATCH', `/api/processes/${process.id}`, {
        version: process.version, name, description: process.description ?? '', standard_minutes: process.standard_minutes || '1',
        reporter_ids: reporterIds, active: true, pricing_mode: 'piece', wage_rate: rate, inspection_scheme: 'none',
      })).process;
    }
  }
  return process;
}
const piece = await ensureProcess('R9-PIECE', 'R9计件', '10', [r9.userId ?? r9.id]);
const field = await ensureProcess('R9-FIELD', 'R9现场报工', '2', [worker.userId, admin.userId, planner.userId]);
step('工序单价', same(piece.wage_rate, 10) && same(field.wage_rate, 2), `计件 ${piece.wage_rate} / 现场 ${field.wage_rate}`);

const defectNames = ['松动', '异响', '划伤', '尺寸超差', '毛刺', '裂纹', '色差', '缺件', '螺纹不良'];
let defects = (await api(admin, 'GET', '/api/quality/defects')).items ?? [];
for (const name of defectNames) {
  if (!defects.some((item) => item.name === name)) defects.push((await api(admin, 'POST', '/api/quality/defects', { name })).item);
}
step('不良品项不少于8', defects.length >= 8, defects.length);

let categories = (await api(admin, 'GET', '/api/machines/categories')).items ?? [];
if (!categories.length) categories = [(await api(admin, 'POST', '/api/machines/categories', { name: 'R9机台类别' }))];
const categoryId = categories[0].id ?? categories[0];
let machines = (await api(admin, 'GET', '/api/machines?enabled=1')).items ?? [];
if (!machines.length) {
  await api(admin, 'POST', '/api/machines', { name: 'R9启用机台', status: '正常', category_id: typeof categoryId === 'string' ? categoryId : categories[0].id });
  machines = (await api(admin, 'GET', '/api/machines?enabled=1')).items ?? [];
}
step('启用机台不少于1', machines.length >= 1, machines.length);

const warehouses = (await api(admin, 'GET', '/api/warehouses')).items ?? [];
let warehouse = warehouses.find((item) => item.code === 'R9-WH');
if (!warehouse) warehouse = (await api(admin, 'POST', '/api/warehouses', { request_key: key(), code: 'R9-WH', name: 'R9回归仓' })).warehouse;

const customers = (await api(admin, 'GET', '/api/money/customers')).items ?? [];
let customer = customers.find((item) => item.name === 'R9回归客户');
if (!customer) customer = (await api(admin, 'POST', '/api/money/customers', { request_key: key(), name: 'R9回归客户', contact_name: '回归联系人', contact_phone: '13900009009' })).customer;

const flows = (await api(admin, 'GET', '/api/audit/flows?module=customer')).items ?? [];
let contractFlow = flows.find((item) => item.enabled && item.object_types?.includes('contract'));
let createdContractFlow = false;
if (!contractFlow) {
  contractFlow = (await api(admin, 'POST', '/api/audit/flows', {
    module: 'customer', name: 'R9合同审核', object_types: ['contract'], enabled: true, allow_withdraw: false,
    levels: [{ sign_mode: 'or', approver_ids: [planner.userId] }],
  })).flow;
  createdContractFlow = true;
}

async function refreshContract(id) {
  return (await api(admin, 'GET', `/api/money/contracts/${id}`)).contract;
}
async function approveContract(contract) {
  let current = contract;
  for (let i = 0; i < 8 && current.approval === 'pending'; i += 1) {
    const detail = await api(admin, 'GET', `/api/audit/detail?object_type=contract&object_id=${current.id}`);
    const level = (detail.levels ?? []).find((item) => item.level_no === detail.current_level);
    const pending = (level?.approvers ?? []).find((item) => !item.action);
    const actor = pending ? sessions.get(pending.user_id) : null;
    if (!actor) throw new Error(`没有合同审核人的登录会话：${pending?.name ?? '未知'}`);
    current = (await api(actor, 'POST', `/api/money/contracts/${current.id}/actions`, { action: 'approve', version: current.version, opinion: '通过' })).contract;
    current = await refreshContract(current.id);
  }
  return current;
}

const contractListRaw = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
// 幂等保护：多余「R9回归合同」尝试删除，避免反复 seed 增殖到几十条
{
  const all = contractListRaw.filter((item) => item.note === 'R9回归合同');
  const keep = all.find((item) => same(item.amount, 10000)) ?? all[0];
  for (const extra of all.filter((item) => item.id !== keep?.id)) {
    try {
      await api(admin, 'POST', `/api/money/contracts/${extra.id}/actions`, { action: 'delete', version: extra.version });
    } catch (error) {
      console.warn('清理多余R9合同跳过', String(error).slice(0, 120));
    }
  }
}
const contractList = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
let contract = contractList.find((item) => item.note === 'R9回归合同' && same(item.amount, 10000))
  ?? contractList.find((item) => item.customer_name === 'R9回归客户' && same(item.amount, 10000) && item.note === 'R9回归合同');
let contractCreated = false;
if (!contract) {
  contractCreated = true;
  contract = (await api(admin, 'POST', '/api/money/contracts', {
    request_key: key(), customer_id: customer.id, contact_name: '回归联系人', salesperson_id: admin.userId, prepay: '1000', note: 'R9回归合同',
    lines: [{ product_id: product.id, quantity: '100', unit_price: '100' }],
  })).contract;
  if (contract.approval === 'pending') contract = await approveContract(contract);
}
contract = await refreshContract(contract.id);
if (contractFlow?.name === 'R9合同审核') await api(admin, 'DELETE', `/api/audit/flows/${contractFlow.id}`);
const contractCount = ((await api(admin, 'GET', '/api/money/contracts')).items ?? []).filter((item) => item.note === 'R9回归合同' && same(item.amount, 10000)).length;
step('合同欠款9000', ['approved', 'exempt'].includes(contract.approval) && same(contract.debt, 9000) && contract.approval_text === '通过', `${contract.approval_text} 欠款 ${contract.debt}`);
step('合同审核状态', contract.approval_text === '通过', contract.approval_text);

const orders = (await api(admin, 'GET', '/api/work-orders')).items ?? [];
let main = orders.find((item) => item.code === 'R9-主链');
let mainCreated = false;
if (!main) {
  mainCreated = true;
  const lineId = contract.lines[0].id;
  main = (await api(admin, 'POST', '/api/work-orders', {
    request_key: key(), code: 'R9-主链', contract_line_id: lineId, quantity: '100', warehouse_id: warehouse.id, note: 'R9回归加工单', due_date: '2026-12-31',
    tasks: [{ process_id: piece.id, pricing_mode: 'piece', wage_rate: '10' }],
  })).work_order;
}
if (main.execution === 'not_started') {
  main = (await api(admin, 'POST', `/api/work-orders/${main.id}/actions`, { action: 'start', version: main.version, request_key: key() })).work_order;
}
step('合同创建加工单', main.code === 'R9-主链', main.contract_code || main.code);

const mainTask = main.tasks[0];
const reports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? [];
let pieceReport = reports.find((item) => item.task_id === mainTask.id && same(item.good_qty, 75) && item.approval === 'approved');
let reportCreated = false;
if (!pieceReport) {
  reportCreated = true;
  await api(r9Session, 'POST', '/api/production-reports', {
    request_key: key(), task_id: mainTask.id, good_qty: '75', defect_qty: '5', rework_qty: '0', scrap_qty: '0',
  });
}
const listed = (await api(admin, 'GET', `/api/production-reports?operator_id=${r9Session.userId}`)).items ?? [];
pieceReport = listed.find((item) => same(item.good_qty, 75) && same(item.defect_qty, 5));
const payroll = await api(admin, 'GET', '/api/payroll-statement?name=回归工人');
const person = (payroll.items ?? []).find((item) => item.name === '回归工人' || item.user_id === r9Session.userId);
const progress = (await api(admin, 'GET', '/api/progress/work-orders?code=R9-主链&page_size=20')).items ?? [];
const mainProgress = progress.find((item) => item.code === 'R9-主链');
step('报工工资750', pieceReport && same(pieceReport.estimated_wage, 750), pieceReport?.estimated_wage);
step('生产工资报表750', person && same(person.wage, 750), person?.wage);
step('任务进度75/100', mainProgress && same(mainProgress.task_progress.done, 75) && same(mainProgress.task_progress.total, 100), `${mainProgress?.task_progress?.done}/${mainProgress?.task_progress?.total}`);

async function driveAudit(objectType, id, versionGetter, actionPath) {
  let version = versionGetter();
  for (let i = 0; i < 8; i += 1) {
    const detail = await api(admin, 'GET', `/api/audit/detail?object_type=${objectType}&object_id=${id}`);
    if (detail.status !== '待审' && detail.status !== 'pending') return;
    const level = (detail.levels ?? []).find((item) => item.level_no === detail.current_level);
    const pending = (level?.approvers ?? []).find((item) => !item.action);
    const actor = pending ? sessions.get(pending.user_id) : null;
    if (!actor) throw new Error(`${objectType} 没有审核人会话`);
    const next = await api(actor, 'POST', actionPath, { request_key: key(), action: 'approve', version });
    const view = next.fg_receipt || next.shipment || next.purchase_receipt || next;
    version = view.version ?? version + 1;
    const again = await api(admin, 'GET', `/api/audit/detail?object_type=${objectType}&object_id=${id}`);
    if (again.status !== '待审' && again.status !== 'pending') return;
  }
}

const fgList = (await api(admin, 'GET', `/api/warehouse/fg-receipts?work_order_id=${main.id}`)).items ?? [];
const fgApproved = fgList.filter((item) => item.approval === 'approved').reduce((sum, item) => sum + num(item.quantity), 0);
if (fgApproved < 75) {
  // 第十二轮成品入库审核流会使新单待审。动作接口在 /api/fg-receipts，仓库前缀没有这条路由。
  // 有审核实例时走 /api/audit/decide。已有待审 75 则复用，避免再插一张。
  let created = fgList.find((item) => item.approval === 'pending' && same(item.quantity, 75));
  if (!created) {
    created = (await api(admin, 'POST', '/api/warehouse/fg-receipts', { request_key: key(), work_order_id: main.id, quantity: '75', warehouse_id: warehouse.id })).fg_receipt;
  }
  if (created.approval === 'pending' || created.audit_status === 'pending') {
    await api(admin, 'POST', '/api/audit/decide', { object_type: 'fg_receipt', object_id: created.id, action: '通过', remark: '通过' });
  }
}
const afterFg = (await api(admin, 'GET', '/api/progress/work-orders?code=R9-主链&page_size=20')).items.find((item) => item.code === 'R9-主链');
step('入库进度75/100', afterFg && same(afterFg.inbound_progress.done, 75) && same(afterFg.inbound_progress.total, 100), `${afterFg?.inbound_progress?.done}/${afterFg?.inbound_progress?.total}`);

const outbound = await api(admin, 'GET', `/api/warehouse/contracts/${contract.id}/outbound-summary`);
const shipped = num(outbound.lines?.[0]?.shipped_qty);
const line = contract.lines[0];
if (shipped < 50) {
  const balances = (await api(admin, 'GET', '/api/stock/balances')).items ?? [];
  const row = balances.find((b) => b.warehouse_id === warehouse.id && b.product_id === line.product_id);
  const avail = num(row?.available_qty ?? row?.on_hand ?? 0);
  if (avail < 50) {
    await api(admin, 'POST', '/api/warehouse/misc-bills', {
      request_key: key(), kind: 'else_in', warehouse_id: warehouse.id, note: 'R9出库补库存',
      lines: [{ product_id: line.product_id, quantity: '50', unit_price: '1' }],
    });
  }
  try {
    const ship = (await api(admin, 'POST', '/api/warehouse/shipments', {
      request_key: key(), contract_id: contract.id, warehouse_id: warehouse.id,
      lines: [{ contract_line_id: contract.lines[0].id, quantity: '50' }],
    })).shipment;
    if (ship.approval === 'pending' || ship.audit_status === 'pending') {
      await driveAudit('sale_shipment', ship.id, () => ship.version, `/api/warehouse/shipments/${ship.id}/actions`);
    }
  } catch (error) {
    const retry = await api(admin, 'GET', `/api/warehouse/contracts/${contract.id}/outbound-summary`);
    if (num(retry.lines?.[0]?.shipped_qty) < 50) throw error;
  }
}
const outboundAfter = await api(admin, 'GET', `/api/warehouse/contracts/${contract.id}/outbound-summary`);
const debtAfter = (await refreshContract(contract.id)).debt;
step('出库进度50/100', same(outboundAfter.lines?.[0]?.shipped_qty, 50) && same(outboundAfter.lines?.[0]?.order_qty, 100), `${outboundAfter.lines?.[0]?.shipped_qty}/${outboundAfter.lines?.[0]?.order_qty}`);
step('出库后欠款仍为9000', same(debtAfter, 9000), debtAfter);

const stockFlows = (await api(admin, 'GET', '/api/audit/flows?module=stock')).items ?? [];
if (!stockFlows.some((item) => item.enabled && item.object_types?.includes('purchase_receipt'))) {
  await api(admin, 'POST', '/api/audit/flows', {
    module: 'stock', name: 'R9采购入库', object_types: ['purchase_receipt'], enabled: true, allow_withdraw: false,
    levels: [{ sign_mode: 'or', approver_ids: [planner.userId] }],
  });
}
const suppliers = (await api(admin, 'GET', '/api/money/suppliers')).items ?? [];
let supplier = suppliers.find((item) => item.name === 'R9供应商');
if (!supplier) supplier = (await api(admin, 'POST', '/api/money/suppliers', { request_key: key(), name: 'R9供应商' })).supplier;
const purchases = (await api(admin, 'GET', '/api/money/purchase-orders')).items ?? [];
let purchase = purchases.find((item) => item.note === 'R9待审采购');
if (!purchase) {
  purchase = (await api(admin, 'POST', '/api/money/purchase-orders', {
    request_key: key(), supplier_id: supplier.id, note: 'R9待审采购', lines: [{ product_id: raw.id, quantity: '20', unit_price: '1' }],
  })).purchase_order;
}
if (purchase.approval === 'pending') {
  for (let i = 0; i < 8 && purchase.approval === 'pending'; i += 1) {
    const detail = await api(admin, 'GET', `/api/audit/detail?object_type=purchase_order&object_id=${purchase.id}`);
    const level = (detail.levels ?? []).find((item) => item.level_no === detail.current_level);
    const pendingUser = (level?.approvers ?? []).find((item) => !item.action);
    const actor = pendingUser ? sessions.get(pendingUser.user_id) : admin;
    if (!actor) throw new Error('采购单没有审核人会话');
    await api(actor, 'POST', '/api/audit/decide', { object_type: 'purchase_order', object_id: purchase.id, action: '通过', remark: '通过' });
    purchase = (await api(admin, 'GET', `/api/money/purchase-orders/${purchase.id}`)).purchase_order;
  }
}
const beforeBalances = await api(admin, 'GET', '/api/stock/balances');
const beforeHand = (beforeBalances.items ?? []).find((item) => item.product_id === raw.id && item.warehouse_id === warehouse.id)?.on_hand ?? '0';
const beforeLedger = ((await api(admin, 'GET', '/api/stock/ledger')).items ?? []).filter((item) => item.product_id === raw.id).length;
const receipts = (await api(admin, 'GET', '/api/warehouse/purchase-receipts')).items ?? [];
let pending = receipts.find((item) => item.note === 'R9待审+20');
if (!pending) {
  const lineId = purchase.lines?.[0]?.id ?? (await api(admin, 'GET', `/api/money/purchase-orders/${purchase.id}`)).purchase_order.lines[0].id;
  pending = (await api(admin, 'POST', '/api/warehouse/purchase-receipts', {
    request_key: key(), order_id: purchase.id, warehouse_id: warehouse.id, note: 'R9待审+20',
    lines: [{ purchase_line_id: lineId, quantity: '20' }],
  })).purchase_receipt;
}
must(pending?.approval === 'pending', '待审入库单存在', `状态 ${pending?.approval}`);
const afterHand = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((item) => item.product_id === raw.id && item.warehouse_id === warehouse.id)?.on_hand ?? '0';
const afterLedger = ((await api(admin, 'GET', '/api/stock/ledger')).items ?? []).filter((item) => item.product_id === raw.id).length;
step('待审入库不改库存', pending.approval === 'pending' && String(afterHand) === String(beforeHand) && afterLedger === beforeLedger, `状态 ${pending.approval} 库存 ${beforeHand}→${afterHand} 流水 ${beforeLedger}→${afterLedger}`);
// 其它轮 seed 可能给 R9-RAW 留下库存；验收要求待审仓 on_hand=0，用其它出库冲掉（官方 HTTP）
{
  const balances = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).filter((item) => item.product_id === raw.id && item.warehouse_id === warehouse.id && Number(item.on_hand) > 0);
  for (const bal of balances) {
    const qty = String(Number(bal.on_hand));
    await api(admin, 'POST', '/api/warehouse/misc-bills', {
      request_key: key(), kind: 'else_out', warehouse_id: warehouse.id, note: 'R9待审仓清零',
      lines: [{ product_id: raw.id, quantity: qty, unit_price: '1' }],
    });
  }
  const cleared = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((item) => item.product_id === raw.id && item.warehouse_id === warehouse.id)?.on_hand ?? '0';
  must(Number(cleared) === 0 && pending.approval === 'pending', '待审仓库存为0', `仓库存 ${cleared} 状态 ${pending.approval}`);
}

const fieldOrders = ((await api(admin, 'GET', '/api/work-orders')).items ?? []).filter((item) => String(item.code).startsWith('R9-现场'));
// 理由：现场报工工序不能做 is_output 尾道，否则报工触发 auto receipt_fg，验收改/删报工会被「人工成本已结转」锁死
let fieldOrder = fieldOrders.find((item) => {
  if (item.execution !== 'running') return false;
  const fieldTask = (item.tasks ?? []).find((task) => task.process_id === field.id || task.process_name === 'R9现场报工');
  if (!fieldTask || fieldTask.is_output) return false;
  return num(fieldTask.plan_qty) - num(fieldTask.approved_good) >= 10;
});
if (!fieldOrder) {
  const seq = fieldOrders.length + 1;
  const code = seq === 1 ? 'R9-现场' : `R9-现场-${seq}`;
  fieldOrder = (await api(admin, 'POST', '/api/work-orders', {
    request_key: key(), code, product_id: product.id, quantity: '50', warehouse_id: warehouse.id, note: 'R9现场验收', due_date: '2026-12-31', require_cost: false,
    tasks: [
      { process_id: field.id, pricing_mode: 'piece', wage_rate: '2' },
      { process_id: piece.id, pricing_mode: 'piece', wage_rate: '10' },
    ],
  })).work_order;
  fieldOrder = (await api(admin, 'POST', `/api/work-orders/${fieldOrder.id}/actions`, { action: 'start', version: fieldOrder.version, request_key: key() })).work_order;
}
const remain = num(fieldOrder.tasks[0].plan_qty) - num(fieldOrder.tasks[0].approved_good);
step('现场单剩余可报不少于10', remain >= 10, `${fieldOrder.code} 剩余 ${remain}`);

const censusPath = '.local/round9-census.json';
const census = { contracts: contractCount, mainOrders: ((await api(admin, 'GET', '/api/work-orders')).items ?? []).filter((item) => item.code === 'R9-主链').length, mainReports: ((await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? []).filter((item) => same(item.good_qty, 75) && item.approval === 'approved').length };
if (existsSync(censusPath)) {
  const previous = JSON.parse(readFileSync(censusPath, 'utf8'));
  const stable = previous.contracts === census.contracts && previous.mainOrders === census.mainOrders && previous.mainReports === census.mainReports;
  step('第二次不新增合同加工单报工', stable, `合同 ${previous.contracts}→${census.contracts} 加工单 ${previous.mainOrders}→${census.mainOrders} 报工 ${previous.mainReports}→${census.mainReports}`);
} else {
  step('首次造数', true, contractCreated || mainCreated || reportCreated ? '新建' : '已存在');
}
writeFileSync(censusPath, JSON.stringify(census));
step('主链标记', true, contractCreated || mainCreated || reportCreated ? '新建' : '已存在');

console.log('\n步骤\t结果\t实际值');
for (const row of rows) console.log(`${row.name}\t${row.result}\t${row.actual}`);
if (failed) process.exit(1);
