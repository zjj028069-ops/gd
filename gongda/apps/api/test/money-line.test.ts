import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { allocateSequential, contractDebt, lineAmount, netAmount, progressText, purchaseDebt, sumMoney } from '../src/money-calc.js';
import { xlsxBytes, xlsxRows } from '../src/xlsx-lite.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), other = randomUUID(), admin = randomUUID(), unit = randomUUID();
const password = 'Money-TestOnly-LongPassword!';
let session: { cookie: string; csrf: string };
const headers = (write = false) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });
const key = () => randomUUID();

async function login() {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: 'money-a', username: 'money.admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  session = { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0], csrf: response.json().csrf_token };
}
async function get(url: string, expected = 200) {
  const response = await app.inject({ url, headers: headers() });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function post(url: string, body: unknown, expected = 201) {
  const response = await app.inject({ method: 'POST', url, headers: headers(true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function put(url: string, body: unknown, expected = 200) {
  const response = await app.inject({ method: 'PUT', url, headers: headers(true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function patch(url: string, body: unknown, expected = 200) {
  const response = await app.inject({ method: 'PATCH', url, headers: headers(true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

let fg = '', part = '', buyer = '';

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'money-a', '钱线']);
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [other, 'money-b', '隔离']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'money.admin', '钱线管理员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [other, admin]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','个')", [unit, tenant]);
  });
  app = await createApp(db, { localEventsWorker: false });
  await login();
  fg = (await post('/api/products', { code: 'FG-M', name: '合同成品', unit_id: unit, attribute: 'manufactured' })).product.id;
  part = (await post('/api/products', { code: 'PT-M', name: '外购零件', unit_id: unit, attribute: 'purchased' })).product.id;
  buyer = (await get('/api/auth/me')).user.id;
  await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => {
    const names: Record<string, string> = { quotation: '合同报价单审核流程', contract: '合同审核流程', cash: '合同收支审核流程', expense: '销售费用审核流程' };
    for (const objectType of ['quotation', 'contract', 'cash', 'expense']) {
      const flow = (await sql.query<{ id: string }>('INSERT INTO audit_flows(tenant_id,module,name,allow_withdraw,enabled) VALUES($1,\'customer\',$2,$3,true) RETURNING id', [tenant, names[objectType], objectType === 'cash'])).rows[0]!;
      await sql.query('INSERT INTO audit_flow_objects(tenant_id,flow_id,object_type) VALUES($1,$2,$3)', [tenant, flow.id, objectType]);
      await sql.query('INSERT INTO audit_flow_levels(tenant_id,flow_id,level_no,sign_mode,approver_ids) VALUES($1,$2,1,\'or\',$3::uuid[])', [tenant, flow.id, [admin]]);
    }
  });
});
after(async () => { await app.close(); await db.close(); });

test('金额公式、折后金额、收款进度和采购欠款口径', () => {
  assert.equal(lineAmount('${合同明细.单价}*${合同明细.销售数量}', '100', '2', 8), '200');
  assert.equal(netAmount('200', '9', '0', 8), '180');
  assert.equal(netAmount('50', '10', '10', 8), '40');
  assert.equal(sumMoney(['180', '40']), '220');
  assert.equal(contractDebt('10000', '1000'), '9000');
  assert.equal(progressText('1000', '10000'), '10% (1000/10000)');
  assert.equal(progressText('2200', '72200'), '3.04% (2200/72200)');
  assert.equal(purchaseDebt('880569', '88045', '121212'), '671312');
  assert.deepEqual(allocateSequential(['6000', '4000'], '7000'), ['6000', '1000']);
  assert.throws(() => allocateSequential(['100'], '101'), /不可大于所选合同总欠款/);
});

test('xlsx 往返', () => {
  const rows = xlsxRows(xlsxBytes([['名称', '编号'], ['测试客户A', 'KH0001']]));
  assert.equal(rows[0]?.[0], '名称');
  assert.equal(rows[1]?.[1], 'KH0001');
});

test('客户编号、重名和手机号按设置生效', async () => {
  const first = await post('/api/money/customers', { request_key: key(), name: '测试客户A', contact_name: '测试客户A', contact_phone: '13800000001' });
  assert.match(first.customer.code, /^KH\d{4}$/);
  assert.equal(first.customer.contact_name, '测试客户A');
  const sameName = await post('/api/money/customers', { request_key: key(), name: '测试客户A', contact_name: '另一个人', contact_phone: '13800000002' });
  assert.equal(sameName.customer.name, '测试客户A');
  const dupPhone = await post('/api/money/customers', { request_key: key(), name: '另一个客户', contact_name: '甲', contact_phone: '13800000001' }, 409);
  assert.equal(dupPhone.error.message, '该手机号码已存在，无法录入');
  const current = await get('/api/money/settings');
  await put('/api/money/settings', { ...current.settings, duplicate_name: true, version: current.settings.version });
  const blocked = await post('/api/money/customers', { request_key: key(), name: '测试客户A', contact_name: '乙', contact_phone: '13800000003' }, 409);
  assert.equal(blocked.error.message, '已存在同名客户，无法录入');
  const again = await get('/api/money/settings');
  await put('/api/money/settings', { ...again.settings, duplicate_name: false, version: again.settings.version });
});

test('报价单自动计算后生成合同并带出明细', async () => {
  const customer = (await post('/api/money/customers', { request_key: key(), name: '报价客户', contact_name: '报价客户', contact_phone: '13800000011' })).customer;
  const quote = (await post('/api/money/quotations', { request_key: key(), customer_id: customer.id, contact_name: '报价客户', salesperson_id: buyer, lines: [{ product_id: fg, quantity: '2', unit_price: '100', discount: '9' }, { product_id: part, quantity: '1', unit_price: '50', discount: '10', concession: '10' }] })).quotation;
  assert.equal(quote.approval, 'pending');
  assert.equal(quote.lines[0].amount, '200');
  assert.equal(quote.lines[0].net_amount, '180');
  assert.equal(quote.lines[0].discount_text, '9折');
  assert.equal(quote.lines[1].amount, '50');
  assert.equal(quote.lines[1].net_amount, '40');
  assert.equal(quote.amount, '220');
  assert.equal(quote.qty, '3');
  const approved = (await post(`/api/money/quotations/${quote.id}/actions`, { action: 'approve', version: quote.version, opinion: '同意' }, 200)).quotation;
  const contract = (await post(`/api/money/quotations/${approved.id}/to-contract`, {}, 200)).contract;
  assert.equal(contract.lines.length, 2);
  assert.equal(contract.lines[0].net_amount, '180');
  assert.equal(contract.lines[1].net_amount, '40');
  assert.equal(contract.amount, '220');
  assert.equal((await get(`/api/money/quotations/${quote.id}`)).quotation.contract_text, '已创建');
});

test('合同预付款、审核收款、退回、关闭审核、超收拦截、支出不冲欠款', async () => {
  const customer = (await post('/api/money/customers', { request_key: key(), name: '合同客户', contact_name: '合同客户', contact_phone: '13800000021' })).customer;
  const created = (await post('/api/money/contracts', { request_key: key(), customer_id: customer.id, contact_name: '合同客户', salesperson_id: buyer, prepay: '1000', lines: [{ product_id: fg, quantity: '100', unit_price: '100', discount: '10' }] })).contract;
  assert.equal(created.amount, '10000');
  assert.equal(created.approval, 'pending');
  const approved = (await post(`/api/money/contracts/${created.id}/actions`, { action: 'approve', version: created.version, opinion: '通过' }, 200)).contract;
  assert.equal(approved.lifecycle, 'performing');
  assert.equal(approved.debt, '9000');
  assert.equal(approved.received, '1000');
  assert.equal(approved.receive_progress, '10% (1000/10000)');
  assert.equal(approved.spent, '0');
  const list = await get('/api/money/contracts?code=' + approved.code);
  assert.equal(list.summary.debt, '9000');
  assert.equal(list.summary.amount, '10000');
  const pending = (await post(`/api/money/contracts/${approved.id}/cash`, { direction: 'in', amount: '3000', note: '到账' }, 200)).cash;
  assert.equal(pending.approval, 'pending');
  assert.equal((await get(`/api/money/contracts/${approved.id}`)).contract.debt, '9000');
  const passed = (await post(`/api/money/cash/${pending.id}/actions`, { action: 'approve', opinion: '已核' }, 200)).cash;
  assert.equal(passed.approval_text, '通过');
  assert.equal(passed.can_edit, false);
  const after = (await get(`/api/money/contracts/${approved.id}`)).contract;
  assert.equal(after.debt, '6000');
  assert.equal(after.receive_progress, '40% (4000/10000)');
  const back = (await post(`/api/money/contracts/${approved.id}/cash`, { direction: 'in', amount: '100', note: '待退' }, 200)).cash;
  const rejected = (await post(`/api/money/cash/${back.id}/actions`, { action: 'reject', opinion: '金额不对' }, 200)).cash;
  assert.equal(rejected.can_edit, true);
  assert.equal((await get(`/api/money/contracts/${approved.id}`)).contract.debt, '6000');
  const withdrawn = (await post(`/api/money/contracts/${approved.id}/cash`, { direction: 'in', amount: '50' }, 200)).cash;
  await post(`/api/money/cash/${withdrawn.id}/actions`, { action: 'withdraw' }, 200);
  assert.equal((await get(`/api/money/contracts/${approved.id}`)).contract.received, '4000');
  const settings = await get('/api/money/settings');
  const flows = settings.audit_flows;
  const cashFlow = flows.find((item: { object_type: string }) => item.object_type === 'cash');
  await patch(`/api/money/audit-flows/${cashFlow.id}`, { enabled: false });
  const direct = (await post(`/api/money/contracts/${approved.id}/cash`, { direction: 'in', amount: '500', note: '免审' }, 200)).cash;
  assert.equal(direct.approval, 'exempt');
  assert.equal(direct.approval_text, '不需审核');
  assert.equal((await get(`/api/money/contracts/${approved.id}`)).contract.debt, '5500');
  await patch(`/api/money/audit-flows/${cashFlow.id}`, { enabled: true });
  const turned = await get('/api/money/settings');
  await put('/api/money/settings', { ...turned.settings, receipt_cap: true, version: turned.settings.version });
  const blocked = await post(`/api/money/contracts/${approved.id}/cash`, { direction: 'in', amount: '6000' }, 422);
  assert.equal(blocked.error.message, '收款金额不能超过欠款');
  const off = await get('/api/money/settings');
  await put('/api/money/settings', { ...off.settings, receipt_cap: false, version: off.settings.version });
  const spendCash = (await post(`/api/money/contracts/${approved.id}/cash`, { direction: 'out', amount: '500', note: '运费' }, 200)).cash;
  assert.equal(spendCash.approval, 'pending');
  assert.equal((await get(`/api/money/contracts/${approved.id}`)).contract.spent, '0');
  await post(`/api/money/cash/${spendCash.id}/actions`, { action: 'approve', opinion: '支出' }, 200);
  const spend = (await get(`/api/money/contracts/${approved.id}`)).contract;
  assert.equal(spend.spent, '500');
  assert.equal(spend.debt, '5500');
  const removed = await post(`/api/money/contracts/${approved.id}/actions`, { action: 'delete', version: spend.version }, 409);
  assert.equal(removed.error.message, '该合同已有收款，不能删除');
  // 任何额外参数（含历史上的 force）都不能绕过「已有收款不能删除」
  for (const body of [
    { action: 'delete', version: spend.version, force: true },
    { action: 'delete', version: spend.version, force: false },
    { action: 'delete', version: spend.version, hard: true },
    { action: 'delete', version: spend.version, cascade: true },
  ]) {
    const blocked = await post(`/api/money/contracts/${approved.id}/actions`, body, 409);
    assert.equal(blocked.error.code, 'CONTRACT_PAID');
    assert.equal(blocked.error.message, '该合同已有收款，不能删除');
  }
  assert.ok((await get(`/api/money/contracts/${approved.id}`)).contract.id);
});

test('批量收款按表格顺序分配', async () => {
  const customer = (await post('/api/money/customers', { request_key: key(), name: '批量客户', contact_name: '批量客户', contact_phone: '13800000031' })).customer;
  const make = async (qty: string) => {
    const created = (await post('/api/money/contracts', { request_key: key(), customer_id: customer.id, salesperson_id: buyer, lines: [{ product_id: part, quantity: qty, unit_price: '1' }] })).contract;
    return (await post(`/api/money/contracts/${created.id}/actions`, { action: 'approve', version: created.version }, 200)).contract;
  };
  const first = await make('60');
  const second = await make('40');
  const batch = await post('/api/money/contracts/batch-cash', { ids: [first.id, second.id], mode: 'auto', total: '70', note: '流水001' }, 200);
  assert.deepEqual(batch.allocations.map((item: { amount: string; debt_after: string }) => [item.amount, item.debt_after]), [['60', '0'], ['10', '30']]);
  const manual = await post('/api/money/contracts/batch-cash', { ids: [second.id], mode: 'manual', lines: [{ id: second.id, amount: '5' }] }, 200);
  assert.equal(manual.allocations[0].debt_after, '35');
  assert.equal((await get(`/api/money/contracts/${second.id}`)).contract.debt, '40');
  const pending = await get('/api/money/cash?approval=pending');
  for (const item of pending.items.filter((row: { contract_code: string }) => row.contract_code === second.code)) {
    await post(`/api/money/cash/${item.id}/actions`, { action: 'approve', opinion: '到账' }, 200);
  }
  assert.equal((await get(`/api/money/contracts/${second.id}`)).contract.debt, '25');
});

test('开票、销售费用和终止记录', async () => {
  const customer = (await post('/api/money/customers', { request_key: key(), name: '费用客户', contact_name: '费用客户', contact_phone: '13800000041' })).customer;
  const created = (await post('/api/money/contracts', { request_key: key(), customer_id: customer.id, salesperson_id: buyer, lines: [{ product_id: fg, quantity: '10', unit_price: '1000' }] })).contract;
  const contract = (await post(`/api/money/contracts/${created.id}/actions`, { action: 'approve', version: created.version }, 200)).contract;
  const invoice = (await post('/api/money/invoices', { contract_id: contract.id, amount: '4000', apply_note: '先开一部分' })).invoice;
  assert.equal(invoice.status_text, '待开票');
  const done = (await post(`/api/money/invoices/${invoice.id}/actions`, { action: 'finish', invoice_note: '已开' }, 200)).contract;
  assert.equal(done.invoiced, '4000');
  const expense = (await post('/api/money/expenses', { customer_id: customer.id, contract_id: contract.id, spent_on: '2026-10-05', category: '招待', amount: '300', note: '招待' })).expense;
  assert.equal(expense.approval, 'pending');
  const audited = (await post(`/api/money/expenses/${expense.id}/actions`, { action: 'approve', opinion: '同意' }, 200)).expense;
  const settled = (await post(`/api/money/expenses/${audited.id}/actions`, { action: 'settle' }, 200)).expense;
  assert.equal(settled.settled, true);
  const cards = await get('/api/money/expenses?q=费用客户');
  assert.equal(cards.cards.total, '300');
  assert.equal(cards.cards.approved, '300');
  assert.equal(cards.cards.settled, '300');
  const linked = (await get(`/api/money/contracts/${contract.id}`)).contract;
  assert.equal(linked.sales_fee, '300');
  assert.equal(linked.debt, '10000');
  const reason = (await post('/api/money/end-reasons', { name: '客户取消', sort: 1 })).reason;
  const ended = (await post(`/api/money/contracts/${contract.id}/actions`, { action: 'terminate', version: linked.version, reason_id: reason.id, note: '对方取消' }, 200)).contract;
  assert.equal(ended.lifecycle_text, '已终止');
  const detail = await get(`/api/money/contracts/${contract.id}`);
  assert.equal(detail.terminations[0].received_amount, '0');
  assert.equal(detail.terminations[0].debt_amount, '10000');
  assert.equal(detail.terminations[0].reason_name, '客户取消');
  assert.ok(Array.isArray(detail.work_orders));
  assert.ok(Array.isArray(detail.logs) && detail.logs.length > 0);
});

test('采购计划生成采购单，入库后付款、退货和开票按入库口径', async () => {
  const supplier = (await post('/api/money/suppliers', { request_key: key(), name: '吴江配件厂', contact_name: '王工', region: '江苏省/苏州市/吴江区', tags: ['配件供应商'] })).supplier;
  assert.match(supplier.code, /^GYS\d{4}$/);
  const plan = (await post('/api/money/purchase-plans', { request_key: key(), name: '十月计划', supplier_id: supplier.id, lines: [{ product_id: part, quantity: '10', unit_price: '100' }] })).plan;
  const order = (await post('/api/money/purchase-orders', { request_key: key(), supplier_id: supplier.id, lines: [{ product_id: part, quantity: '10', unit_price: '100', plan_code: plan.code, plan_name: plan.name }] })).purchase_order;
  assert.match(order.code, /^CG\d{11}$/);
  assert.equal(order.approval_text, '不需审核');
  assert.equal(order.amount, '1000');
  assert.equal(order.debt, '0');
  const warehouse = (await post('/api/warehouses', { request_key: key(), code: 'WH-M', name: '钱线仓' })).warehouse;
  const receipt = (await post('/api/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: warehouse.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '5' }] })).purchase_receipt;
  await post(`/api/purchase-receipts/${receipt.id}/actions`, { request_key: key(), action: 'approve', version: receipt.version }, 200);
  const received = (await get(`/api/money/purchase-orders/${order.id}`)).purchase_order;
  assert.equal(received.inbound_amount, '500');
  assert.equal(received.debt, '500');
  assert.equal(received.inbound_progress, '50% (5/10)');
  const paid = (await post(`/api/money/purchase-orders/${order.id}/pay`, { amount: '200', pay_date: '2026-10-05', note: '首笔' }, 200)).purchase_order;
  assert.equal(paid.paid, '200');
  assert.equal(paid.debt, '300');
  assert.equal(paid.pay_progress, '40% (200/500)');
  const payments = await get('/api/money/purchase-payments');
  assert.equal(payments.summary.amount, '200');
  assert.equal(payments.items.length, 1);
  await post('/api/warehouse/purchase-receipts', { request_key: key(), order_id: order.id, warehouse_id: warehouse.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '5' }] });
  await post('/api/warehouse/purchase-returns', { request_key: key(), order_id: order.id, warehouse_id: warehouse.id, lines: [{ purchase_line_id: order.lines[0].id, quantity: '1' }] });
  const returned = (await get(`/api/money/purchase-orders/${order.id}`)).purchase_order;
  assert.equal(returned.inbound_amount, '1000');
  assert.equal(returned.return_amount, '100');
  assert.equal(returned.debt, purchaseDebt('1000', '100', '200'));
  const invoiced = (await post(`/api/money/purchase-orders/${order.id}/invoice`, { amount: '100', invoice_date: '2026-10-05' }, 200)).purchase_order;
  assert.equal(invoiced.invoice_progress, '10% (100/1000)');
  const second = (await post('/api/money/purchase-orders', { request_key: key(), supplier_id: supplier.id, lines: [{ product_id: fg, quantity: '2', unit_price: '100' }] })).purchase_order;
  const warehouse2 = warehouse;
  const receipt2 = (await post('/api/purchase-receipts', { request_key: key(), order_id: second.id, warehouse_id: warehouse2.id, lines: [{ purchase_line_id: second.lines[0].id, quantity: '2' }] })).purchase_receipt;
  await post(`/api/purchase-receipts/${receipt2.id}/actions`, { request_key: key(), action: 'approve', version: receipt2.version }, 200);
  await post('/api/money/purchase-orders/batch-pay', { lines: [{ id: second.id, amount: '80' }], pay_date: '2026-10-05' }, 200);
  await post('/api/money/purchase-orders/batch-invoice', { lines: [{ id: second.id, amount: '40', invoice_date: '2026-10-05' }] }, 200);
  const again = (await get(`/api/money/purchase-orders/${second.id}`)).purchase_order;
  assert.equal(again.paid, '80');
  assert.equal(again.invoiced, '40');
  assert.equal(again.debt, '120');
  const summary = await get('/api/money/purchase-orders?code=' + order.code);
  assert.equal(summary.summary.inbound, '1000');
  assert.equal(summary.items[0].debt, summary.summary.debt);
});
