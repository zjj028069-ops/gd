/**
 * 全面 UAT 第十三轮造数（幂等）。
 * 先跑第十二轮 seed（同一常量断言），再写前缀 UAT 的主链。
 * 前置：rm -rf .local/database && npm run dev:setup && npm run dev
 * 连跑两次不得新增 UAT 合同、主链加工单、主链报工。
 * 只走正式接口，失败非 0 退出。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

await import('./seed-round12-real.mjs');

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';

const UAT_QTY = 40;
const UAT_PRICE = 50;
const UAT_AMOUNT = 2000;
const UAT_PREPAY = 200;
const UAT_DEBT_BEFORE = 1800;
const UAT_RECEIVED_BEFORE = 200;
const UAT_RATE = 8;
const UAT_GOOD = 20;
const UAT_DEFECT = 2;
const UAT_WAGE = '160.00';
const UAT_FG = 20;
const UAT_SHIP = 10;
const UAT_CASH = 300;
const UAT_RECEIVED_AFTER = '500';
const UAT_DEBT_AFTER = '1500';
const UAT_RECEIVE_PROGRESS = '25% (500/2000)';
const UAT_OUTBOUND = '25% (10/40)';
const UAT_PRODUCE = '100% (40/40)';
const UAT_PO_QTY = 6;
const UAT_PO_PRICE = 5;
const UAT_PO_AMOUNT = '30';
const UAT_PO_PAY = '12';
const UAT_PO_PAID = '12';
const UAT_PO_DEBT = '18';
const UAT_PENDING_QTY = 4;
const UAT_PROBE_CASH = '2';
const UAT_EXT_QTY = 3;

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
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
    });
    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 12000));
      continue;
    }
    const json = await res.json();
    const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
    if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${username} ${JSON.stringify(json).slice(0, 240)}`);
    return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name };
  }
  throw new Error(`登录限流未恢复 ${username}`);
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
if (!devPass.admin || !devPass.planner || !devPass.worker) throw new Error('缺少 .local/dev-credentials.txt');

function readSessions(file) {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}
const sessionFile = '.local/uat-r13-sessions.json';
const savedSessions = { ...readSessions('.local/round12-sessions.json'), ...readSessions(sessionFile) };
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
  let password = passwordOf('.local/uat-r13-credentials.txt', username);
  if (!member) {
    password = `UATw-${randomBytes(12).toString('base64url')}`;
    const created = await api(admin, 'POST', '/api/platform/members', { username, display_name: displayName, password, role });
    member = created.member ?? created;
    step(`新建${displayName}`, member?.username === username, username);
  } else step(displayName, member.display_name === displayName, member.display_name);
  if (!password) throw new Error(`${username} 已存在，但 .local/uat-r13-credentials.txt 没有密码`);
  const userId = member.userId ?? member.id;
  return { ...member, userId, password };
}
const uat = await ensureMember('uat.worker', 'UAT回归工人', 'worker');
const uatb = await ensureMember('uatb.worker', 'UATB工人', 'worker');
mkdirSync('.local', { recursive: true });
const cred = `仅供本机开发验收。\n企业：demo-a\n账号：admin.local\n密码：${devPass.admin}\n账号：planner.local\n密码：${devPass.planner}\n账号：worker.local\n密码：${devPass.worker}\n账号：uat.worker\n姓名：UAT回归工人\n密码：${uat.password}\n账号：uatb.worker\n姓名：UATB工人\n密码：${uatb.password}\n`;
writeFileSync('.local/uat-r13-credentials.txt', cred, { mode: 0o600 });
chmodSync('.local/uat-r13-credentials.txt', 0o600);
const uatSession = await sessionFor('uat.worker', uat.password);
const uatbSession = await sessionFor('uatb.worker', uatb.password);
sessions.set(uatSession.userId, uatSession);
sessions.set(uatbSession.userId, uatbSession);

const units = (await api(admin, 'GET', '/api/units')).items ?? [];
const unit = units.find((item) => item.name === '个') ?? units[0];
if (!unit) throw new Error('没有可用单位');

async function ensureProduct(code, name, attribute) {
  const listed = (await api(admin, 'GET', `/api/products?page=1&page_size=100&code=${encodeURIComponent(code)}`)).items ?? [];
  const found = listed.find((item) => item.code === code || item.name === name);
  if (found) return found;
  return (await api(admin, 'POST', '/api/products', { code, name, unit_id: unit.id, attribute })).product;
}
const product = await ensureProduct('UAT-GOOD', 'UAT回归商品', 'manufactured');
const raw = await ensureProduct('UAT-RAW', 'UAT待审原料', 'purchased');
const printProduct = await ensureProduct('UATP-GOOD', 'UAT打印验收商品', 'manufactured');

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
const piece = await ensureProcess('UAT-PIECE', 'UAT计件', UAT_RATE, [uat.userId]);
const pieceB = await ensureProcess('UATB-PIECE', 'UATB计件', UAT_RATE, [uatb.userId]);
const printPiece = await ensureProcess('UATP-PIECE', 'UAT打印工序', 10, [admin.userId]);
must(exact(piece.wage_rate, UAT_RATE) && exact(pieceB.wage_rate, UAT_RATE), 'UAT工序单价8', `计件 ${piece.wage_rate} / B ${pieceB.wage_rate}`);

async function ensureRoute(code, name, processId) {
  const list = (await api(admin, 'GET', '/api/routes')).items ?? [];
  let route = list.find((item) => item.code === code || item.name === name);
  if (!route) {
    route = (await api(admin, 'POST', '/api/routes', {
      request_key: key(), code, name, steps: [{ process_id: processId, auto_inbound: false }],
    })).route;
  }
  const version = await api(admin, 'GET', `/api/route-versions/${route.current_version_id}`);
  const hit = (version.steps ?? []).some((item) => item.process_id === processId);
  must(hit, `工艺路线含${name}`, hit ? name : '缺少工序');
  return route;
}
await ensureRoute('UAT-ROUTE', 'UAT回归路线', piece.id);
await ensureRoute('UATB-ROUTE', 'UATB路线', pieceB.id);

const warehouses = (await api(admin, 'GET', '/api/warehouses')).items ?? [];
let warehouse = warehouses.find((item) => item.code === 'UAT-WH');
if (!warehouse) warehouse = (await api(admin, 'POST', '/api/warehouses', { request_key: key(), code: 'UAT-WH', name: 'UAT回归仓' })).warehouse;
let printWarehouse = warehouses.find((item) => item.code === 'UATP-WH');
if (!printWarehouse) printWarehouse = (await api(admin, 'POST', '/api/warehouses', { request_key: key(), code: 'UATP-WH', name: 'UAT打印仓' })).warehouse;

const customers = (await api(admin, 'GET', '/api/money/customers')).items ?? [];
let customer = customers.find((item) => item.name === 'UAT回归客户');
if (!customer) customer = (await api(admin, 'POST', '/api/money/customers', { request_key: key(), name: 'UAT回归客户', contact_name: 'UAT联系人', contact_phone: '13900013013' })).customer;

async function ensureFlow(module, name, objectType, approverIds) {
  const flows = (await api(admin, 'GET', `/api/audit/flows?module=${module}`)).items ?? [];
  const existing = flows.find((item) => item.enabled && (item.object_types ?? []).includes(objectType));
  if (existing) return existing;
  return await api(admin, 'POST', '/api/audit/flows', {
    module, name, object_types: [objectType], enabled: true, allow_withdraw: false,
    levels: [{ sign_mode: 'or', approver_ids: approverIds }],
  });
}
await ensureFlow('customer', 'UAT合同审核', 'contract', [planner.userId]);
await ensureFlow('customer', 'UAT收款审核', 'cash', [admin.userId]);
await ensureFlow('stock', 'UAT成品入库审核', 'fg_receipt', [admin.userId]);
await ensureFlow('stock', 'UAT销售出库审核', 'sale_shipment', [admin.userId]);
await ensureFlow('stock', 'UAT采购入库审核', 'purchase_receipt', [planner.userId]);
await ensureFlow('purchase', 'UAT采购单审核', 'purchase_order', [admin.userId]);
await ensureFlow('purchase', 'UAT采购付款审核', 'purchase_payment', [admin.userId]);

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
let contract = contractList.find((item) => item.note === 'UAT回归合同' && exact(item.amount, UAT_AMOUNT));
if (!contract) {
  contract = (await api(admin, 'POST', '/api/money/contracts', {
    request_key: key(), customer_id: customer.id, contact_name: 'UAT联系人', salesperson_id: admin.userId,
    prepay: String(UAT_PREPAY), note: 'UAT回归合同',
    lines: [{ product_id: product.id, quantity: String(UAT_QTY), unit_price: String(UAT_PRICE) }],
  })).contract;
}
if (contract.approval === 'pending') await approveUntil('contract', contract.id);
contract = await refreshContract(contract.id);
const postedCash = ((await api(admin, 'GET', '/api/money/cash')).items ?? []).find((item) => item.note === 'UAT回款' && item.contract_id === contract.id && (item.approval === 'approved' || item.approval === 'exempt'));
if (!postedCash) {
  must(contract.approval_text === '通过' && exact(contract.debt, UAT_DEBT_BEFORE) && exact(contract.received, UAT_RECEIVED_BEFORE) && exact(contract.amount, UAT_AMOUNT), 'UAT合同审核通过欠款1800', `${contract.approval_text} 收款 ${contract.received} 欠款 ${contract.debt} 金额 ${contract.amount}`);
} else {
  must(contract.approval_text === '通过' && exact(contract.amount, UAT_AMOUNT) && exact(contract.debt, UAT_DEBT_AFTER) && contract.received === UAT_RECEIVED_AFTER, 'UAT合同已通过且回款后欠款1500', `${contract.approval_text} 收款 ${contract.received} 欠款 ${contract.debt}`);
}

const orders = (await api(admin, 'GET', '/api/work-orders')).items ?? [];
let main = orders.find((item) => item.code === 'UAT-主链');
if (!main) {
  const lineId = contract.lines[0].id;
  main = (await api(planner, 'POST', '/api/work-orders', {
    request_key: key(), code: 'UAT-主链', contract_line_id: lineId, quantity: String(UAT_QTY), warehouse_id: warehouse.id,
    note: 'UAT回归加工单', due_date: '2026-12-31',
    tasks: [{ process_id: piece.id, pricing_mode: 'piece', wage_rate: String(UAT_RATE) }],
  })).work_order;
}
if (main.execution === 'not_started') {
  main = (await api(planner, 'POST', `/api/work-orders/${main.id}/actions`, { action: 'start', version: main.version, request_key: key() })).work_order;
}
main = (await api(admin, 'GET', `/api/work-orders/${main.id}`)).work_order;
const mainTask = main.tasks[0];
must(main.code === 'UAT-主链' && main.contract_id === contract.id && exact(main.plan_qty, UAT_QTY) && exact(mainTask.wage_rate, UAT_RATE), 'UAT加工单计划40单价8', `${main.code} 计划 ${main.plan_qty} 单价 ${mainTask.wage_rate}`);
contract = await refreshContract(contract.id);
must(contract.lines[0].produce_progress === UAT_PRODUCE, 'UAT投产进度40/40', contract.lines[0].produce_progress);

const reports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? [];
let pieceReport = reports.find((item) => item.task_id === mainTask.id && exact(item.good_qty, UAT_GOOD) && exact(item.defect_qty, UAT_DEFECT) && item.approval === 'approved');
if (!pieceReport) {
  await api(uatSession, 'POST', '/api/production-reports', {
    request_key: key(), task_id: mainTask.id, good_qty: String(UAT_GOOD), defect_qty: String(UAT_DEFECT), rework_qty: '0', scrap_qty: '0', note: 'UAT主链报工',
  });
}
const listed = (await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? [];
pieceReport = listed.find((item) => exact(item.good_qty, UAT_GOOD) && exact(item.defect_qty, UAT_DEFECT) && item.approval === 'approved');
must(pieceReport && pieceReport.estimated_wage === UAT_WAGE, 'UAT报工工资160.00', pieceReport?.estimated_wage);
const payroll = await api(admin, 'GET', '/api/payroll-statement?name=UAT回归工人');
const person = (payroll.items ?? []).find((item) => item.user_id === uatSession.userId);
must(person && person.wage === UAT_WAGE, 'UAT工资报表160.00', person?.wage);
const progress = (await api(admin, 'GET', '/api/progress/work-orders?code=UAT-主链&page_size=20')).items ?? [];
const mainProgress = progress.find((item) => item.code === 'UAT-主链');
must(mainProgress && mainProgress.task_progress.done === '20' && mainProgress.task_progress.total === '40', 'UAT任务进度20/40', `${mainProgress?.task_progress?.done}/${mainProgress?.task_progress?.total}`);

const ownReports = (await api(uatSession, 'GET', '/api/production-reports')).items ?? [];
const ownPay = await api(uatSession, 'GET', '/api/payroll-statement');
must(ownReports.every((item) => item.operator_id === uatSession.userId) && ownReports.some((item) => item.id === pieceReport.id), 'UAT工人只能看到自己的报工', ownReports.map((item) => item.operator_id).join(','));
must((ownPay.items ?? []).every((item) => item.user_id === uatSession.userId) && (ownPay.items ?? []).some((item) => item.wage === UAT_WAGE), 'UAT工人报表只有自己的160.00', (ownPay.items ?? []).map((item) => `${item.name}:${item.wage}`).join(','));
const otherReports = (await api(worker, 'GET', '/api/production-reports')).items ?? [];
const otherPay = await api(worker, 'GET', '/api/payroll-statement');
must(!otherReports.some((item) => item.id === pieceReport.id) && !(otherPay.items ?? []).some((item) => item.wage === UAT_WAGE || item.user_id === uatSession.userId), '普通工人看不到UAT工人工资', `报工 ${otherReports.length} 报表 ${(otherPay.items ?? []).map((item) => item.wage).join(',')}`);

if (pieceReport.settlement_status !== 'settled') {
  pieceReport = (await api(admin, 'POST', `/api/production-reports/${pieceReport.id}/settlement`, {
    request_key: key(), version: pieceReport.version, settled: true, note: 'UAT结算',
  })).report;
}
must(pieceReport.settlement_status === 'settled' && pieceReport.estimated_wage === UAT_WAGE, 'UAT报工已结算工资仍为160.00', `${pieceReport.settlement_status} ${pieceReport.estimated_wage}`);

const fgList = (await api(admin, 'GET', `/api/warehouse/fg-receipts?work_order_id=${main.id}`)).items ?? [];
let fg = fgList.find((item) => exact(item.quantity, UAT_FG));
if (!fg) {
  fg = (await api(admin, 'POST', '/api/warehouse/fg-receipts', {
    request_key: key(), work_order_id: main.id, quantity: String(UAT_FG), warehouse_id: warehouse.id,
  })).fg_receipt;
}
if (fg.approval === 'pending' || fg.audit_status === 'pending') await approveUntil('fg_receipt', fg.id);
fg = ((await api(admin, 'GET', `/api/warehouse/fg-receipts?work_order_id=${main.id}`)).items ?? []).find((item) => exact(item.quantity, UAT_FG));
must(fg && (fg.approval === 'approved' || fg.audit_status === 'approved'), 'UAT成品入库20已通过', `${fg?.approval}/${fg?.audit_status} 数量 ${fg?.quantity}`);
const goodLedger = ((await api(admin, 'GET', `/api/stock/ledger?product_id=${product.id}`)).items ?? []).filter((item) => item.product_id === product.id && item.warehouse_id === warehouse.id);
const fgIn = goodLedger.filter((item) => item.direction === 'in' && item.source_type === 'fg_receipt').reduce((sum, item) => sum + numeric(item.quantity), 0);
const shipOut = goodLedger.filter((item) => item.direction === 'out' && item.source_type === 'shipment').reduce((sum, item) => sum + numeric(item.quantity), 0);
must(fgIn === UAT_FG && (shipOut === 0 || shipOut === UAT_SHIP), 'UAT成品入库流水+20且出库仅为0或10', `入库 ${fgIn} 出库 ${shipOut}`);
const goodHand = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((item) => item.product_id === product.id && item.warehouse_id === warehouse.id)?.on_hand ?? '0';
must(exact(goodHand, fgIn - shipOut), 'UAT成品结余等于入库20减已出库', goodHand);
const afterFg = (await api(admin, 'GET', '/api/progress/work-orders?code=UAT-主链&page_size=20')).items.find((item) => item.code === 'UAT-主链');
must(afterFg && afterFg.inbound_progress.done === '20' && afterFg.inbound_progress.total === '40', 'UAT入库进度20/40', `${afterFg?.inbound_progress?.done}/${afterFg?.inbound_progress?.total}`);

const outbound = await api(admin, 'GET', `/api/warehouse/contracts/${contract.id}/outbound-summary`);
if (!exact(outbound.lines?.[0]?.shipped_qty, UAT_SHIP)) {
  const ship = (await api(admin, 'POST', '/api/warehouse/shipments', {
    request_key: key(), contract_id: contract.id, warehouse_id: warehouse.id,
    lines: [{ contract_line_id: contract.lines[0].id, quantity: String(UAT_SHIP) }],
  })).shipment;
  if (ship.approval === 'pending' || ship.audit_status === 'pending') await approveUntil('sale_shipment', ship.id);
}
const outboundAfter = await api(admin, 'GET', `/api/warehouse/contracts/${contract.id}/outbound-summary`);
must(exact(outboundAfter.lines?.[0]?.shipped_qty, UAT_SHIP) && exact(outboundAfter.lines?.[0]?.order_qty, UAT_QTY), 'UAT出库进度10/40', `${outboundAfter.lines?.[0]?.shipped_qty}/${outboundAfter.lines?.[0]?.order_qty}`);
contract = await refreshContract(contract.id);
if (!postedCash) {
  must(exact(contract.debt, UAT_DEBT_BEFORE) && contract.outbound_progress === UAT_OUTBOUND, 'UAT出库后欠款仍为1800', `${contract.debt} ${contract.outbound_progress}`);
} else {
  must(contract.outbound_progress === UAT_OUTBOUND && contract.debt === UAT_DEBT_AFTER, 'UAT出库进度25%且回款后欠款1500', `${contract.debt} ${contract.outbound_progress}`);
}

const cashList = (await api(admin, 'GET', '/api/money/cash')).items ?? [];
let cash = cashList.find((item) => item.note === 'UAT回款' && exact(item.amount, UAT_CASH) && item.contract_id === contract.id);
if (!cash) cash = (await api(admin, 'POST', `/api/money/contracts/${contract.id}/cash`, { direction: 'in', amount: String(UAT_CASH), note: 'UAT回款' })).cash;
if (cash.approval === 'pending') {
  const denied = await call(planner, 'POST', '/api/audit/decide', { object_type: 'cash', object_id: cash.id, action: '通过', remark: '越权' });
  must(denied.status === 403 && denied.json?.error?.message === '不是当前级审核人', '计划员不能审核UAT回款', `${denied.status} ${denied.json?.error?.message ?? denied.text.slice(0, 120)}`);
  await approveUntil('cash', cash.id);
}
contract = await refreshContract(contract.id);
must(contract.received === UAT_RECEIVED_AFTER && contract.debt === UAT_DEBT_AFTER && contract.receive_progress === UAT_RECEIVE_PROGRESS, 'UAT回款后累计收款500欠款1500', `${contract.received} ${contract.debt} ${contract.receive_progress}`);

let probe = ((await api(admin, 'GET', '/api/money/cash')).items ?? []).find((item) => item.note === 'UAT越权探针' && item.contract_id === contract.id);
if (!probe) probe = (await api(admin, 'POST', `/api/money/contracts/${contract.id}/cash`, { direction: 'in', amount: UAT_PROBE_CASH, note: 'UAT越权探针' })).cash;
must(probe.approval === 'pending', 'UAT越权探针保持待审', probe.approval);
const deniedProbe = await call(planner, 'POST', '/api/audit/decide', { object_type: 'cash', object_id: probe.id, action: '通过', remark: '越权' });
must(deniedProbe.status === 403 && deniedProbe.json?.error?.message === '不是当前级审核人', '计划员不能审UAT无权收款', `${deniedProbe.status} ${deniedProbe.json?.error?.message ?? ''}`);
probe = ((await api(admin, 'GET', '/api/money/cash')).items ?? []).find((item) => item.id === probe.id);
contract = await refreshContract(contract.id);
must(probe.approval === 'pending' && contract.debt === UAT_DEBT_AFTER && contract.received === UAT_RECEIVED_AFTER, 'UAT待审回款不加累计收款', `${probe.approval} 收款 ${contract.received} 欠款 ${contract.debt}`);

const suppliers = (await api(admin, 'GET', '/api/money/suppliers')).items ?? [];
let supplier = suppliers.find((item) => item.name === 'UAT供应商');
if (!supplier) supplier = (await api(admin, 'POST', '/api/money/suppliers', { request_key: key(), name: 'UAT供应商' })).supplier;

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
const payOrder = await ensurePurchase('UAT采购付款', UAT_PO_QTY, UAT_PO_PRICE);
must(payOrder.approval === 'approved' && payOrder.amount === UAT_PO_AMOUNT, 'UAT采购单金额30', `${payOrder.approval} 金额 ${payOrder.amount}`);
const payReceipts = (await api(admin, 'GET', `/api/warehouse/purchase-receipts?order_id=${payOrder.id}`)).items ?? [];
let payReceipt = payReceipts.find((item) => item.note === 'UAT采购入库');
if (!payReceipt) {
  payReceipt = (await api(admin, 'POST', '/api/warehouse/purchase-receipts', {
    request_key: key(), order_id: payOrder.id, warehouse_id: warehouse.id, note: 'UAT采购入库',
    lines: [{ purchase_line_id: payOrder.lines[0].id, quantity: String(UAT_PO_QTY) }],
  })).purchase_receipt;
}
if (payReceipt.approval === 'pending' || payReceipt.audit_status === 'pending') await approveUntil('purchase_receipt', payReceipt.id);
let paidOrder = (await api(admin, 'GET', `/api/money/purchase-orders/${payOrder.id}`)).purchase_order;
must(paidOrder.inbound_amount === UAT_PO_AMOUNT, 'UAT采购入库后应付30', paidOrder.inbound_amount);
const payments = (await api(admin, 'GET', '/api/money/purchase-payments')).items ?? [];
let payment = payments.find((item) => item.note === 'UAT采购付款' && item.order_id === payOrder.id && exact(item.amount, UAT_PO_PAY));
if (!payment) payment = (await api(admin, 'POST', `/api/money/purchase-orders/${payOrder.id}/pay`, { amount: UAT_PO_PAY, note: 'UAT采购付款' })).payment;
if (payment.approval === 'pending') await approveUntil('purchase_payment', payment.id);
paidOrder = (await api(admin, 'GET', `/api/money/purchase-orders/${payOrder.id}`)).purchase_order;
payment = ((await api(admin, 'GET', '/api/money/purchase-payments')).items ?? []).find((item) => item.id === payment.id);
must(payment && (payment.approval === 'approved' || payment.approval === 'exempt') && paidOrder.paid === UAT_PO_PAID && paidOrder.debt === UAT_PO_DEBT, 'UAT采购已付12应付18', `付款 ${payment?.approval} 已付 ${paidOrder.paid} 应付 ${paidOrder.debt}`);

const extOrder = await ensurePurchase('UAT扩展采购', UAT_EXT_QTY, 1);
must(extOrder.approval === 'approved' && exact(extOrder.amount, UAT_EXT_QTY), 'UAT扩展采购单金额3且未要求在seed入库', `${extOrder.approval} ${extOrder.amount}`);

const pendingOrder = await ensurePurchase('UAT待审采购', UAT_PENDING_QTY, 1);
const beforeBalances = await api(admin, 'GET', '/api/stock/balances');
const beforeHand = (beforeBalances.items ?? []).find((item) => item.product_id === raw.id && item.warehouse_id === warehouse.id)?.on_hand ?? '0';
const beforeLedger = ((await api(admin, 'GET', '/api/stock/ledger')).items ?? []).filter((item) => item.product_id === raw.id).map((item) => item.id).join(',');
const receipts = (await api(admin, 'GET', '/api/warehouse/purchase-receipts')).items ?? [];
let pending = receipts.find((item) => item.note === 'UAT待审+4');
if (!pending) {
  pending = (await api(admin, 'POST', '/api/warehouse/purchase-receipts', {
    request_key: key(), order_id: pendingOrder.id, warehouse_id: warehouse.id, note: 'UAT待审+4',
    lines: [{ purchase_line_id: pendingOrder.lines[0].id, quantity: String(UAT_PENDING_QTY) }],
  })).purchase_receipt;
}
const afterHand = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((item) => item.product_id === raw.id && item.warehouse_id === warehouse.id)?.on_hand ?? '0';
const afterLedger = ((await api(admin, 'GET', '/api/stock/ledger')).items ?? []).filter((item) => item.product_id === raw.id).map((item) => item.id).join(',');
must(pending.approval === 'pending' && afterHand === beforeHand && afterLedger === beforeLedger, 'UAT待审入库不改库存和流水', `状态 ${pending.approval} 库存 ${beforeHand}→${afterHand}`);
must(exact(afterHand, UAT_PO_QTY), 'UAT原料库存仍为已审入库6', afterHand);

let printOrder = ((await api(admin, 'GET', '/api/work-orders')).items ?? []).find((item) => item.code === 'UATP-打印');
if (!printOrder) {
  printOrder = (await api(admin, 'POST', '/api/work-orders', {
    request_key: key(), code: 'UATP-打印', product_id: printProduct.id, quantity: '10', warehouse_id: printWarehouse.id,
    note: 'UAT打印验收加工单', tasks: [{ process_id: printPiece.id, pricing_mode: 'piece', wage_rate: '10' }],
  })).work_order;
}
if (printOrder.execution === 'not_started') {
  printOrder = (await api(admin, 'POST', `/api/work-orders/${printOrder.id}/actions`, { action: 'start', version: printOrder.version, request_key: key() })).work_order;
}
printOrder = (await api(admin, 'GET', `/api/work-orders/${printOrder.id}`)).work_order;
const printTask = printOrder.tasks?.[0];
if (!printTask) throw new Error('UAT打印加工单没有工序');
const printReports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${printOrder.id}`)).items ?? [];
if (!printReports.some((item) => item.note === 'UAT打印验收报工')) {
  await api(admin, 'POST', '/api/production-reports', {
    request_key: key(), task_id: printTask.id, good_qty: '8', defect_qty: '1', rework_qty: '0', scrap_qty: '0', note: 'UAT打印验收报工',
  });
}
const printAgain = (await api(admin, 'GET', `/api/production-reports?work_order_id=${printOrder.id}`)).items ?? [];
must(printAgain.some((item) => item.note === 'UAT打印验收报工'), 'UAT打印报工已存在', printAgain.map((item) => item.note).join(','));

const contractCount = ((await api(admin, 'GET', '/api/money/contracts')).items ?? []).filter((item) => item.note === 'UAT回归合同' && exact(item.amount, UAT_AMOUNT)).length;
const mainOrders = ((await api(admin, 'GET', '/api/work-orders')).items ?? []).filter((item) => item.code === 'UAT-主链').length;
const mainReports = ((await api(admin, 'GET', `/api/production-reports?work_order_id=${main.id}`)).items ?? []).filter((item) => exact(item.good_qty, UAT_GOOD) && item.approval === 'approved').length;
const censusPath = '.local/uat-r13-census.json';
const census = { contracts: contractCount, mainOrders, mainReports };
if (existsSync(censusPath)) {
  const previous = JSON.parse(readFileSync(censusPath, 'utf8'));
  const stable = previous.contracts === census.contracts && previous.mainOrders === census.mainOrders && previous.mainReports === census.mainReports;
  must(stable, '第二次不新增UAT合同加工单报工', `合同 ${previous.contracts}→${census.contracts} 加工单 ${previous.mainOrders}→${census.mainOrders} 报工 ${previous.mainReports}→${census.mainReports}`);
} else step('UAT首次造数', true, '已写入');
writeFileSync(censusPath, JSON.stringify(census));

console.log('\n步骤\t结果\t实际值');
for (const row of rows) console.log(`${row.name}\t${row.result}\t${row.actual}`);
if (failed) process.exit(1);
