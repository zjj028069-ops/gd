/**
 * 第十二轮真实数据（幂等）。前置：rm -rf .local/database && npm run dev:setup && npm run dev
 * 账号写入 .local/round12-credentials.txt（权限 0600，勿提交）
 * 数字用 === 精确比较。连跑两次不新增合同、主链加工单、主链报工。
 *
 * 口径：预付款在提交时记一笔免审收款，计入累计收款。
 * 审核通过后 累计收款 1000、欠款 9000。
 * 回款 500 审过之后 累计收款 1500、欠款 8500。
 * 待审回款探针 1 元不计入累计收款，欠款仍为 8500。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';

const R12_QTY = 100;
const R12_PRICE = 100;
const R12_AMOUNT = 10000;
const R12_PREPAY = 1000;
const R12_DEBT_BEFORE_CASH = 9000;
const R12_RECEIVED_BEFORE_CASH = 1000;
const R12_RATE = 10;
const R12_GOOD = 75;
const R12_DEFECT = 5;
const R12_WAGE = '750.00';
const R12_FG = 75;
const R12_SHIP = 50;
const R12_CASH = 500;
const R12_RECEIVED_AFTER_CASH = '1500';
const R12_DEBT_AFTER_CASH = '8500';
const R12_RECEIVE_PROGRESS = '15% (1500/10000)';
const R12_OUTBOUND_PROGRESS = '50% (50/100)';
const R12_PRODUCE_PROGRESS = '100% (100/100)';
const R12_PO_QTY = 10;
const R12_PO_PRICE = 8;
const R12_PO_AMOUNT = '80';
const R12_PO_PAY = '30';
const R12_PO_PAID = '30';
const R12_PO_DEBT = '50';
const R12_PENDING_QTY = 20;
const R12_PROBE_CASH = '1';

const rows = [];
let failed = false;

function numeric(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const text = String(value).replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return NaN;
  return Number(text);
}
function exact(actual, expected) {
  return numeric(actual) === numeric(expected);
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
async function call(session, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  if (text) json = JSON.parse(text);
  return { status: res.status, json, text };
}
async function api(session, method, path, body) {
  const res = await call(session, method, path, body);
  if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${path} ${res.status}: ${res.text.slice(0, 500)}`);
  return res.json;
}
const key = () => crypto.randomUUID();

const devPass = {
  admin: passwordOf('.local/dev-credentials.txt', 'admin.local'),
  planner: passwordOf('.local/dev-credentials.txt', 'planner.local'),
  worker: passwordOf('.local/dev-credentials.txt', 'worker.local'),
};
if (!devPass.admin || !devPass.planner || !devPass.worker) throw new Error('缺少 .local/dev-credentials.txt 中的 admin.local / planner.local / worker.local');

const sessionFile = '.local/round12-sessions.json';
function readSessions() {
  if (!existsSync(sessionFile)) return {};
  return JSON.parse(readFileSync(sessionFile, 'utf8'));
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

async function ensureMember(username, displayName, role) {
  const members = (await api(admin, 'GET', '/api/platform/members')).items ?? [];
  let member = members.find((item) => item.username === username);
  let password = passwordOf('.local/round12-credentials.txt', username);
  if (!member) {
    password = `R12w-${randomBytes(12).toString('base64url')}`;
    const created = await api(admin, 'POST', '/api/platform/members', { username, display_name: displayName, password, role });
    member = created.member ?? created;
    step(`新建${displayName}`, member?.username === username, username);
  } else step(displayName, member.display_name === displayName, member.display_name);
  if (!password) throw new Error(`${username} 已存在，但 .local/round12-credentials.txt 没有密码`);
  const userId = member.userId ?? member.id;
  return { ...member, userId, password };
}

const r12 = await ensureMember('r12.worker', 'R12回归工人', 'worker');
const r12b = await ensureMember('r12b.worker', 'R12B工人', 'worker');
mkdirSync('.local', { recursive: true });
const cred = `仅供本机开发验收。\n企业：demo-a\n账号：admin.local\n密码：${devPass.admin}\n账号：planner.local\n密码：${devPass.planner}\n账号：worker.local\n密码：${devPass.worker}\n账号：r12.worker\n姓名：R12回归工人\n密码：${r12.password}\n账号：r12b.worker\n姓名：R12B工人\n密码：${r12b.password}\n`;
writeFileSync('.local/round12-credentials.txt', cred, { mode: 0o600 });
chmodSync('.local/round12-credentials.txt', 0o600);
const r12Session = await sessionFor('r12.worker', r12.password);
const r12bSession = await sessionFor('r12b.worker', r12b.password);
sessions.set(r12Session.userId, r12Session);
sessions.set(r12bSession.userId, r12bSession);

const units = (await api(admin, 'GET', '/api/units')).items ?? [];
const unit = units.find((item) => item.name === '个') ?? units[0];
if (!unit) throw new Error('没有可用单位');

async function ensureProduct(code, name, attribute) {
  const listed = (await api(admin, 'GET', `/api/products?page=1&page_size=100&code=${encodeURIComponent(code)}`)).items ?? [];
  const found = listed.find((item) => item.code === code || item.name === name);
  if (found) return found;
  return (await api(admin, 'POST', '/api/products', { code, name, unit_id: unit.id, attribute })).product;
}
const product = await ensureProduct('R12-GOOD', 'R12回归商品', 'manufactured');
const raw = await ensureProduct('R12-RAW', 'R12待审原料', 'purchased');

async function ensureProcess(code, name, rate, reporterIds) {
  const list = (await api(admin, 'GET', '/api/processes')).items ?? [];
  let process = list.find((item) => item.name === name || item.code === code);
  if (!process) {
    process = (await api(admin, 'POST', '/api/processes', {
      code, name, standard_minutes: '1', reporter_ids: reporterIds, pricing_mode: 'piece', wage_rate: String(rate), inspection_scheme: 'none',
    })).process;
  } else {
    const ids = process.reporter_ids ?? [];
    const sameReporters = reporterIds.length === ids.length && reporterIds.every((id) => ids.includes(id));
    if (!sameReporters || !exact(process.wage_rate, rate) || process.pricing_mode !== 'piece') {
      process = (await api(admin, 'PATCH', `/api/processes/${process.id}`, {
        version: process.version, name, description: process.description ?? '', standard_minutes: process.standard_minutes || '1',
        reporter_ids: reporterIds, active: true, pricing_mode: 'piece', wage_rate: String(rate), inspection_scheme: 'none',
      })).process;
    }
  }
  return process;
}
const piece = await ensureProcess('R12-PIECE', 'R12计件', R12_RATE, [r12.userId]);
const pieceB = await ensureProcess('R12B-PIECE', 'R12B计件', R12_RATE, [r12b.userId]);
must(exact(piece.wage_rate, R12_RATE) && exact(pieceB.wage_rate, R12_RATE), '工序单价10', `计件 ${piece.wage_rate} / B ${pieceB.wage_rate}`);

async function ensureRoute(code, name, processId) {
  const list = (await api(admin, 'GET', '/api/routes')).items ?? [];
  let route = list.find((item) => item.code === code || item.name === name);
  if (!route) {
    route = (await api(admin, 'POST', '/api/routes', {
      request_key: key(), code, name, steps: [{ process_id: processId, auto_inbound: false }],
    })).route;
  }
  const version = await api(admin, 'GET', `/api/route-versions/${route.current_version_id}`);
  const hit = (version.steps ?? []).some((step) => step.process_id === processId);
  must(hit, `工艺路线含${name}`, hit ? name : '缺少工序');
  return route;
}
await ensureRoute('R12-ROUTE', 'R12回归路线', piece.id);
await ensureRoute('R12B-ROUTE', 'R12B路线', pieceB.id);

const warehouses = (await api(admin, 'GET', '/api/warehouses')).items ?? [];
let warehouse = warehouses.find((item) => item.code === 'R12-WH');
if (!warehouse) warehouse = (await api(admin, 'POST', '/api/warehouses', { request_key: key(), code: 'R12-WH', name: 'R12回归仓' })).warehouse;

const customers = (await api(admin, 'GET', '/api/money/customers')).items ?? [];
let customer = customers.find((item) => item.name === 'R12回归客户');
if (!customer) customer = (await api(admin, 'POST', '/api/money/customers', { request_key: key(), name: 'R12回归客户', contact_name: '回归联系人', contact_phone: '13900012012' })).customer;

async function ensureFlow(module, name, objectType, approverIds) {
  const flows = (await api(admin, 'GET', `/api/audit/flows?module=${module}`)).items ?? [];
  const existing = flows.find((item) => item.enabled && (item.object_types ?? []).includes(objectType));
  if (existing) return existing;
  return await api(admin, 'POST', '/api/audit/flows', {
    module, name, object_types: [objectType], enabled: true, allow_withdraw: false,
    levels: [{ sign_mode: 'or', approver_ids: approverIds }],
  });
}
await ensureFlow('customer', 'R12合同审核', 'contract', [planner.userId]);
await ensureFlow('customer', 'R12收款审核', 'cash', [admin.userId]);
await ensureFlow('stock', 'R12成品入库审核', 'fg_receipt', [admin.userId]);
await ensureFlow('stock', 'R12销售出库审核', 'sale_shipment', [admin.userId]);
await ensureFlow('stock', 'R12采购入库审核', 'purchase_receipt', [planner.userId]);
await ensureFlow('purchase', 'R12采购单审核', 'purchase_order', [admin.userId]);
await ensureFlow('purchase', 'R12采购付款审核', 'purchase_payment', [admin.userId]);

async function approveUntil(objectType, id) {
  for (let i = 0; i < 8; i += 1) {
    const detail = await api(admin, 'GET', `/api/audit/detail?object_type=${objectType}&object_id=${id}`);
    if (detail.status !== '待审' && detail.status !== 'pending') return detail;
    const level = (detail.levels ?? []).find((item) => item.level_no === detail.current_level);
    const pending = (level?.approvers ?? []).find((item) => !item.action);
    const actor = pending ? sessions.get(pending.user_id) : null;
    if (!actor) throw new Error(`${objectType} 没有审核人会话：${pending?.name ?? '未知'}`);
    await api(actor, 'POST', '/api/audit/decide', { object_type: objectType, object_id: id, action: '通过', remark: '通过' });
  }
  throw new Error(`${objectType} ${id} 审核未完成`);
}

async function refreshContract(id) {
  return (await api(admin, 'GET', `/api/money/contracts/${id}`)).contract;
}

const contractList = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
let contract = contractList.find((item) => item.note === 'R12回归合同' && exact(item.amount, R12_AMOUNT));
let contractCreated = false;
if (!contract) {
  contractCreated = true;
  contract = (await api(admin, 'POST', '/api/money/contracts', {
    request_key: key(), customer_id: customer.id, contact_name: '回归联系人', salesperson_id: admin.userId,
    prepay: String(R12_PREPAY), note: 'R12回归合同',
    lines: [{ product_id: product.id, quantity: String(R12_QTY), unit_price: String(R12_PRICE) }],
  })).contract;
}
if (contract.approval === 'pending') await approveUntil('contract', contract.id);
contract = await refreshContract(contract.id);
const postedCash = ((await api(admin, 'GET', '/api/money/cash')).items ?? []).find((item) => item.note === 'R12回款' && item.contract_id === contract.id && (item.approval === 'approved' || item.approval === 'exempt'));
if (!postedCash) {
  must(contract.approval_text === '通过' && exact(contract.debt, R12_DEBT_BEFORE_CASH) && exact(contract.received, R12_RECEIVED_BEFORE_CASH) && exact(contract.amount, R12_AMOUNT), '合同审核通过欠款9000', `${contract.approval_text} 收款 ${contract.received} 欠款 ${contract.debt} 金额 ${contract.amount}`);
} else {
  must(contract.approval_text === '通过' && exact(contract.amount, R12_AMOUNT) && exact(contract.debt, R12_DEBT_AFTER_CASH) && contract.received === R12_RECEIVED_AFTER_CASH, '合同已通过且回款后欠款8500', `${contract.approval_text} 收款 ${contract.received} 欠款 ${contract.debt} 金额 ${contract.amount}`);
}

const orders = (await api(admin, 'GET', '/api/work-orders')).items ?? [];
let main = orders.find((item) => item.code === 'R12-主链');
let mainCreated = false;
if (!main) {
  mainCreated = true;
  const lineId = contract.lines[0].id;
  main = (await api(planner, 'POST', '/api/work-orders', {
    request_key: key(), code: 'R12-主链', contract_line_id: lineId, quantity: String(R12_QTY), warehouse_id: warehouse.id,
    note: 'R12回归加工单', due_date: '2026-12-31',
    tasks: [{ process_id: piece.id, pricing_mode: 'piece', wage_rate: String(R12_RATE) }],
  })).work_order;
}
if (main.execution === 'not_started') {
  main = (await api(planner, 'POST', `/api/work-orders/${main.id}/actions`, { action: 'start', version: main.version, request_key: key() })).work_order;
}
main = (await api(admin, 'GET', `/api/work-orders/${main.id}`)).work_order;
const mainTask = main.tasks[0];
must(main.code === 'R12-主链' && main.contract_id === contract.id && exact(main.plan_qty, R12_QTY) && exact(mainTask.wage_rate, R12_RATE), '合同创建加工单单价10计划100', `${main.contract_code || main.code} 计划 ${main.plan_qty} 单价 ${mainTask.wage_rate}`);
contract = await refreshContract(contract.id);
must(contract.lines[0].produce_progress === R12_PRODUCE_PROGRESS, '合同投产进度100/100', contract.lines[0].produce_progress);

const reports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? [];
let pieceReport = reports.find((item) => item.task_id === mainTask.id && exact(item.good_qty, R12_GOOD) && exact(item.defect_qty, R12_DEFECT) && item.approval === 'approved');
let reportCreated = false;
if (!pieceReport) {
  reportCreated = true;
  await api(r12Session, 'POST', '/api/production-reports', {
    request_key: key(), task_id: mainTask.id, good_qty: String(R12_GOOD), defect_qty: String(R12_DEFECT), rework_qty: '0', scrap_qty: '0', note: 'R12主链报工',
  });
}
const listed = (await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? [];
pieceReport = listed.find((item) => exact(item.good_qty, R12_GOOD) && exact(item.defect_qty, R12_DEFECT) && item.approval === 'approved');
must(pieceReport && pieceReport.estimated_wage === R12_WAGE, '报工工资750.00', pieceReport?.estimated_wage);
const payroll = await api(admin, 'GET', '/api/payroll-statement?name=R12回归工人');
const person = (payroll.items ?? []).find((item) => item.user_id === r12Session.userId);
must(person && person.wage === R12_WAGE, '生产工资报表750.00', person?.wage);
const progress = (await api(admin, 'GET', '/api/progress/work-orders?code=R12-主链&page_size=20')).items ?? [];
const mainProgress = progress.find((item) => item.code === 'R12-主链');
must(mainProgress && mainProgress.task_progress.done === '75' && mainProgress.task_progress.total === '100', '任务进度75/100', `${mainProgress?.task_progress?.done}/${mainProgress?.task_progress?.total}`);

const ownReports = (await api(r12Session, 'GET', '/api/production-reports')).items ?? [];
const ownPay = await api(r12Session, 'GET', '/api/payroll-statement');
must(ownReports.every((item) => item.operator_id === r12Session.userId) && ownReports.some((item) => item.id === pieceReport.id), '回归工人只能看到自己的报工', ownReports.map((item) => item.operator_id).join(','));
must((ownPay.items ?? []).every((item) => item.user_id === r12Session.userId) && (ownPay.items ?? []).some((item) => item.wage === R12_WAGE), '回归工人报表只有自己的750.00', (ownPay.items ?? []).map((item) => `${item.name}:${item.wage}`).join(','));
const otherReports = (await api(worker, 'GET', '/api/production-reports')).items ?? [];
const otherPay = await api(worker, 'GET', '/api/payroll-statement');
must(!otherReports.some((item) => item.id === pieceReport.id) && !(otherPay.items ?? []).some((item) => item.wage === R12_WAGE || item.user_id === r12Session.userId), '普通工人看不到回归工人工资', `报工 ${otherReports.length} 报表 ${(otherPay.items ?? []).map((item) => item.wage).join(',')}`);

if (pieceReport.settlement_status !== 'settled') {
  pieceReport = (await api(admin, 'POST', `/api/production-reports/${pieceReport.id}/settlement`, {
    request_key: key(), version: pieceReport.version, settled: true, note: 'R12结算',
  })).report;
}
must(pieceReport.settlement_status === 'settled' && pieceReport.estimated_wage === R12_WAGE, '报工已结算工资仍为750.00', `${pieceReport.settlement_status} ${pieceReport.estimated_wage}`);
const sheet = (await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? [];
const sheetSum = sheet.filter((item) => item.approval === 'approved').reduce((sum, item) => sum + numeric(item.estimated_wage), 0);
must(sheetSum === numeric(R12_WAGE), '加工单工资单合计750', sheetSum);

const fgList = (await api(admin, 'GET', `/api/warehouse/fg-receipts?work_order_id=${main.id}`)).items ?? [];
let fg = fgList.find((item) => exact(item.quantity, R12_FG));
if (!fg) {
  fg = (await api(admin, 'POST', '/api/warehouse/fg-receipts', {
    request_key: key(), work_order_id: main.id, quantity: String(R12_FG), warehouse_id: warehouse.id,
  })).fg_receipt;
}
if (fg.approval === 'pending' || fg.audit_status === 'pending') await approveUntil('fg_receipt', fg.id);
fg = ((await api(admin, 'GET', `/api/warehouse/fg-receipts?work_order_id=${main.id}`)).items ?? []).find((item) => exact(item.quantity, R12_FG));
must(fg && (fg.approval === 'approved' || fg.audit_status === 'approved'), '成品入库75已通过', `${fg?.approval}/${fg?.audit_status} 数量 ${fg?.quantity}`);
const afterFg = (await api(admin, 'GET', '/api/progress/work-orders?code=R12-主链&page_size=20')).items.find((item) => item.code === 'R12-主链');
must(afterFg && afterFg.inbound_progress.done === '75' && afterFg.inbound_progress.total === '100', '入库进度75/100', `${afterFg?.inbound_progress?.done}/${afterFg?.inbound_progress?.total}`);

const outbound = await api(admin, 'GET', `/api/warehouse/contracts/${contract.id}/outbound-summary`);
if (!exact(outbound.lines?.[0]?.shipped_qty, R12_SHIP)) {
  const ship = (await api(admin, 'POST', '/api/warehouse/shipments', {
    request_key: key(), contract_id: contract.id, warehouse_id: warehouse.id,
    lines: [{ contract_line_id: contract.lines[0].id, quantity: String(R12_SHIP) }],
  })).shipment;
  if (ship.approval === 'pending' || ship.audit_status === 'pending') await approveUntil('sale_shipment', ship.id);
}
const outboundAfter = await api(admin, 'GET', `/api/warehouse/contracts/${contract.id}/outbound-summary`);
must(outboundAfter.lines?.[0]?.shipped_qty !== undefined && numeric(outboundAfter.lines[0].shipped_qty) === numeric(R12_SHIP) && numeric(outboundAfter.lines[0].order_qty) === numeric(R12_QTY), '出库进度50/100', `${outboundAfter.lines?.[0]?.shipped_qty}/${outboundAfter.lines?.[0]?.order_qty}`);
contract = await refreshContract(contract.id);
if (!postedCash) {
  must(exact(contract.debt, R12_DEBT_BEFORE_CASH) && contract.outbound_progress === R12_OUTBOUND_PROGRESS, '出库后欠款仍为9000', `${contract.debt} ${contract.outbound_progress}`);
} else {
  must(contract.outbound_progress === R12_OUTBOUND_PROGRESS && contract.debt === R12_DEBT_AFTER_CASH, '出库进度50/100且回款后欠款8500', `${contract.debt} ${contract.outbound_progress}`);
}

const cashList = (await api(admin, 'GET', '/api/money/cash')).items ?? [];
let cash = cashList.find((item) => item.note === 'R12回款' && exact(item.amount, R12_CASH) && item.contract_id === contract.id);
if (!cash) {
  cash = (await api(admin, 'POST', `/api/money/contracts/${contract.id}/cash`, { direction: 'in', amount: String(R12_CASH), note: 'R12回款' })).cash;
}
if (cash.approval === 'pending') {
  const denied = await call(planner, 'POST', '/api/audit/decide', { object_type: 'cash', object_id: cash.id, action: '通过', remark: '越权' });
  must(denied.status === 403 && denied.json?.error?.code === 'FORBIDDEN' && denied.json?.error?.message === '不是当前级审核人', '计划员不能审核这笔回款', `${denied.status} ${denied.json?.error?.message ?? denied.text.slice(0, 120)}`);
  await approveUntil('cash', cash.id);
}
contract = await refreshContract(contract.id);
must(contract.received === R12_RECEIVED_AFTER_CASH && contract.debt === R12_DEBT_AFTER_CASH && contract.receive_progress === R12_RECEIVE_PROGRESS, '回款后累计收款1500欠款8500', `${contract.received} ${contract.debt} ${contract.receive_progress}`);

let probe = ((await api(admin, 'GET', '/api/money/cash')).items ?? []).find((item) => item.note === 'R12越权探针' && item.contract_id === contract.id);
if (!probe) probe = (await api(admin, 'POST', `/api/money/contracts/${contract.id}/cash`, { direction: 'in', amount: R12_PROBE_CASH, note: 'R12越权探针' })).cash;
must(probe.approval === 'pending', '越权探针保持待审', probe.approval);
const deniedProbe = await call(planner, 'POST', '/api/audit/decide', { object_type: 'cash', object_id: probe.id, action: '通过', remark: '越权' });
must(deniedProbe.status === 403 && deniedProbe.json?.error?.message === '不是当前级审核人', '计划员不能审无权收款', `${deniedProbe.status} ${deniedProbe.json?.error?.message ?? ''}`);
probe = ((await api(admin, 'GET', '/api/money/cash')).items ?? []).find((item) => item.id === probe.id);
contract = await refreshContract(contract.id);
must(probe.approval === 'pending' && contract.debt === R12_DEBT_AFTER_CASH && contract.received === R12_RECEIVED_AFTER_CASH, '待审回款不加累计收款', `${probe.approval} 收款 ${contract.received} 欠款 ${contract.debt}`);

const suppliers = (await api(admin, 'GET', '/api/money/suppliers')).items ?? [];
let supplier = suppliers.find((item) => item.name === 'R12供应商');
if (!supplier) supplier = (await api(admin, 'POST', '/api/money/suppliers', { request_key: key(), name: 'R12供应商' })).supplier;

async function ensurePurchase(note, quantity, price) {
  const purchases = (await api(admin, 'GET', '/api/money/purchase-orders')).items ?? [];
  let purchase = purchases.find((item) => item.note === note);
  if (!purchase) {
    purchase = (await api(admin, 'POST', '/api/money/purchase-orders', {
      request_key: key(), supplier_id: supplier.id, note,
      lines: [{ product_id: raw.id, quantity: String(quantity), unit_price: String(price) }],
    })).purchase_order;
  }
  if (purchase.approval === 'pending') await approveUntil('purchase_order', purchase.id);
  return (await api(admin, 'GET', `/api/money/purchase-orders/${purchase.id}`)).purchase_order;
}
const payOrder = await ensurePurchase('R12采购付款', R12_PO_QTY, R12_PO_PRICE);
must(payOrder.approval === 'approved' && payOrder.amount === R12_PO_AMOUNT, '采购单金额80', `${payOrder.approval_text ?? payOrder.approval} 金额 ${payOrder.amount}`);
const payReceipts = (await api(admin, 'GET', `/api/warehouse/purchase-receipts?order_id=${payOrder.id}`)).items ?? [];
let payReceipt = payReceipts.find((item) => item.note === 'R12采购入库');
if (!payReceipt) {
  payReceipt = (await api(admin, 'POST', '/api/warehouse/purchase-receipts', {
    request_key: key(), order_id: payOrder.id, warehouse_id: warehouse.id, note: 'R12采购入库',
    lines: [{ purchase_line_id: payOrder.lines[0].id, quantity: String(R12_PO_QTY) }],
  })).purchase_receipt;
}
if (payReceipt.approval === 'pending' || payReceipt.audit_status === 'pending') await approveUntil('purchase_receipt', payReceipt.id);
let paidOrder = (await api(admin, 'GET', `/api/money/purchase-orders/${payOrder.id}`)).purchase_order;
must(paidOrder.inbound_amount === R12_PO_AMOUNT, '采购入库后应付80', paidOrder.inbound_amount);
const payments = (await api(admin, 'GET', '/api/money/purchase-payments')).items ?? [];
let payment = payments.find((item) => item.note === 'R12采购付款' && item.order_id === payOrder.id && exact(item.amount, R12_PO_PAY));
if (!payment) {
  payment = (await api(admin, 'POST', `/api/money/purchase-orders/${payOrder.id}/pay`, { amount: R12_PO_PAY, note: 'R12采购付款' })).payment;
}
if (payment.approval === 'pending') await approveUntil('purchase_payment', payment.id);
paidOrder = (await api(admin, 'GET', `/api/money/purchase-orders/${payOrder.id}`)).purchase_order;
const paymentList = (await api(admin, 'GET', '/api/money/purchase-payments')).items ?? [];
payment = paymentList.find((item) => item.id === payment.id);
must(payment && (payment.approval === 'approved' || payment.approval === 'exempt') && paidOrder.paid === R12_PO_PAID && paidOrder.debt === R12_PO_DEBT, '采购已付30应付50', `付款 ${payment?.approval} 已付 ${paidOrder.paid} 应付 ${paidOrder.debt}`);

const pendingOrder = await ensurePurchase('R12待审采购', R12_PENDING_QTY, 1);
const beforeBalances = await api(admin, 'GET', '/api/stock/balances');
const beforeHand = (beforeBalances.items ?? []).find((item) => item.product_id === raw.id && item.warehouse_id === warehouse.id)?.on_hand ?? '0';
const beforeLedger = ((await api(admin, 'GET', '/api/stock/ledger')).items ?? []).filter((item) => item.product_id === raw.id).map((item) => item.id).join(',');
const receipts = (await api(admin, 'GET', '/api/warehouse/purchase-receipts')).items ?? [];
let pending = receipts.find((item) => item.note === 'R12待审+20');
if (!pending) {
  pending = (await api(admin, 'POST', '/api/warehouse/purchase-receipts', {
    request_key: key(), order_id: pendingOrder.id, warehouse_id: warehouse.id, note: 'R12待审+20',
    lines: [{ purchase_line_id: pendingOrder.lines[0].id, quantity: String(R12_PENDING_QTY) }],
  })).purchase_receipt;
}
const afterHand = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((item) => item.product_id === raw.id && item.warehouse_id === warehouse.id)?.on_hand ?? '0';
const afterLedger = ((await api(admin, 'GET', '/api/stock/ledger')).items ?? []).filter((item) => item.product_id === raw.id).map((item) => item.id).join(',');
must(pending.approval === 'pending' && afterHand === beforeHand && afterLedger === beforeLedger, '待审入库不改库存和流水', `状态 ${pending.approval} 库存 ${beforeHand}→${afterHand} 流水 ${beforeLedger === afterLedger ? '不变' : '已变'}`);

const contractCount = ((await api(admin, 'GET', '/api/money/contracts')).items ?? []).filter((item) => item.note === 'R12回归合同' && exact(item.amount, R12_AMOUNT)).length;
const mainOrders = ((await api(admin, 'GET', '/api/work-orders')).items ?? []).filter((item) => item.code === 'R12-主链').length;
const mainReports = ((await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? []).filter((item) => exact(item.good_qty, R12_GOOD) && item.approval === 'approved').length;
const censusPath = '.local/round12-census.json';
const census = { contracts: contractCount, mainOrders, mainReports };
if (existsSync(censusPath)) {
  const previous = JSON.parse(readFileSync(censusPath, 'utf8'));
  const stable = previous.contracts === census.contracts && previous.mainOrders === census.mainOrders && previous.mainReports === census.mainReports;
  must(stable, '第二次不新增合同加工单报工', `合同 ${previous.contracts}→${census.contracts} 加工单 ${previous.mainOrders}→${census.mainOrders} 报工 ${previous.mainReports}→${census.mainReports}`);
} else {
  step('首次造数', true, contractCreated || mainCreated || reportCreated ? '新建' : '已存在');
}
writeFileSync(censusPath, JSON.stringify(census));

console.log('\n步骤\t结果\t实际值');
for (const row of rows) console.log(`${row.name}\t${row.result}\t${row.actual}`);
if (failed) process.exit(1);
