import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem, requireAllScope, writeAudit, type Actor, type Services } from './services.js';
import { gateTenantWrite } from './assets.js';
import { calendarDate, digest, finish, formatDecimal, lineCents, money, permit, qty, replay } from './business-common.js';
import { addMoney, allocateSequential, cmpMoney, contractDebt, countsReceipt, formatMoney, lineAmount, netAmount, parseMoney, progressText, purchaseDebt, subMoney, sumMoney } from './money-calc.js';
import { auditRequired, canWithdraw, copySimpleFlow, createSimpleFlow, decideAudit, hasPendingInstance, legacyCustomerFlows, patchSimpleFlow, startAudit } from './audit-engine.js';
import { allocateByRule, seriesRuleName } from './code-rules.js';
import { assertPoint, inScope, pendingApproverIds } from './kgd-permissions.js';
import { noteOp } from './operation-log.js';
import { contractOutbound, purchaseStockSummary } from './warehouse-stock.js';
import { xlsxBytes, xlsxRows } from './xlsx-lite.js';
import { assertSupplierUnique } from './purchase-settings.js';

type Row = Record<string, unknown>;
const approvalText: Record<string, string> = { draft: '草稿', pending: '待审', approved: '通过', rejected: '退回', withdrawn: '撤回', exempt: '不需审核' };
const lifeText: Record<string, string> = { inactive: '未生效', performing: '履约中', done: '已完成', terminated: '已终止' };
const quoteText: Record<string, string> = { quoting: '报价中', success: '报价成功', failed: '报价失败' };
const objectText: Record<string, string> = { quotation: '合同报价单', contract: '合同订单', cash: '收支记录', expense: '销售费用' };
const flowName: Record<string, string> = { quotation: '合同报价单审核流程', contract: '合同审核流程', cash: '合同收支审核流程', expense: '销售费用审核流程' };

function shape<E extends object>(row: Row, extra: E): E & { [key: string]: any } {
  return Object.assign({}, row, extra);
}
async function supplierDeleteBlock(sql: Sql, id: string) {
  if ((await sql.query('SELECT 1 FROM purchase_orders WHERE supplier_id=$1 LIMIT 1', [id])).rows[0]) return '该供应商已有采购单，不能删除';
  if ((await sql.query('SELECT 1 FROM products WHERE default_supplier_id=$1 LIMIT 1', [id])).rows[0]) return '该供应商已被商品设为默认供应商，不能删除';
  if ((await sql.query('SELECT 1 FROM purchase_price_rules WHERE supplier_id=$1 LIMIT 1', [id])).rows[0]) return '该供应商已有采购价格规则，不能删除';
  if ((await sql.query('SELECT 1 FROM r8_out_orders WHERE supplier_id=$1 LIMIT 1', [id])).rows[0]) return '该供应商已有外协工单，不能删除';
  return '';
}
function textOf(value: unknown, max: number, label: string, required = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new Problem(422, 'REQUIRED', `${label}不能为空`);
  if (text.length > max) throw new Problem(422, 'TOO_LONG', `${label}不能超过${max}字`);
  return text;
}
function moneyOf(value: unknown, label: string, fallback = '0') {
  const raw = value === undefined || value === null || value === '' ? fallback : String(value).trim();
  const parsed = parseMoney(raw, label);
  if (parsed < 0n) throw new Problem(422, 'MONEY_FORMAT', `${label}不能为负数`);
  return formatMoney(parsed);
}
function positiveMoney(value: unknown, label: string) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) throw new Problem(422, 'REQUIRED', `请填写${label}`, 'amount');
  const amount = moneyOf(text, label);
  if (cmpMoney(amount, '0') <= 0) throw new Problem(422, 'MONEY_FORMAT', `${label}必须大于0`);
  return amount;
}
function dayOf(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  return calendarDate(String(value));
}
function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
function numText(value: unknown) {
  return formatMoney(parseMoney(String(value ?? '0')));
}
function dateText(value: unknown) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(value);
  const text = String(value);
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso?.[1]) return iso[1];
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(parsed);
  return text.slice(0, 10);
}

export function registerMoney(app: FastifyInstance, services: Services) {
  const guard = services.authorize();
  const run = <T>(request: Parameters<Services['context']>[0], permission: string, write: boolean, work: (sql: Sql, actor: Actor) => Promise<T>) => services.database.tenant(services.context(request), async (sql) => {
    const actor = services.actor(request);
    permit(actor, permission);
    requireAllScope(actor);
    if (write) await gateTenantWrite(sql, services.context(request));
    await ensure(sql, actor.tenant_id);
    return work(sql, actor);
  });

  app.get('/api/money/settings', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => ({ settings: await settings(sql), tags: await tags(sql, 'customer'), supplier_tags: await tags(sql, 'supplier'), end_reasons: await reasons(sql), audit_flows: await flows(sql) })));
  app.put('/api/money/settings', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const current = await settings(sql);
    const next = {
      duplicate_name: Boolean(body.duplicate_name),
      unique_phone: Boolean(body.unique_phone),
      auto_calc: Boolean(body.auto_calc),
      contract_formula: textOf(body.contract_formula, 200, '合同明细金额计算公式', true),
      contract_scale: scaleOf(body.contract_scale),
      quote_formula: textOf(body.quote_formula, 200, '合同报价单明细金额计算公式', true),
      quote_scale: scaleOf(body.quote_scale),
      phone_exact: Boolean(body.phone_exact),
      receipt_cap: Boolean(body.receipt_cap),
      delivery_remind_days: daysOf(body.delivery_remind_days),
      receipt_remind_days: daysOf(body.receipt_remind_days),
      remind_to: 'creator',
    };
    lineAmount(next.contract_formula, '1', '1', next.contract_scale);
    lineAmount(next.quote_formula, '1', '1', next.quote_scale);
    if (Number(current.version) !== Number(body.version)) throw new Problem(409, 'VERSION_CONFLICT', '设置已被修改，请刷新');
    await sql.query('UPDATE money_settings SET duplicate_name=$1,unique_phone=$2,auto_calc=$3,contract_formula=$4,contract_scale=$5,quote_formula=$6,quote_scale=$7,phone_exact=$8,receipt_cap=$9,delivery_remind_days=$10,receipt_remind_days=$11,remind_to=$12,version=version+1 WHERE tenant_id=$13', [next.duplicate_name, next.unique_phone, next.auto_calc, next.contract_formula, next.contract_scale, next.quote_formula, next.quote_scale, next.phone_exact, next.receipt_cap, next.delivery_remind_days, next.receipt_remind_days, next.remind_to, actor.tenant_id]);
    await writeAudit(sql, actor, 'money.settings', 'money_settings', actor.tenant_id, current, next);
    return { settings: await settings(sql) };
  }));

  app.get('/api/money/tags', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => ({ items: await tags(sql, kindOf((request.query as Row).kind)) })));
  app.post('/api/money/tags', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const kind = kindOf(body.kind);
    const name = textOf(body.name, 40, '名称', true);
    const sort = Number(body.sort ?? 1);
    const id = (await sql.query<{ id: string }>('INSERT INTO money_tags(tenant_id,kind,name,sort) VALUES($1,$2,$3,$4) RETURNING id', [actor.tenant_id, kind, name, sort])).rows[0]!.id;
    return { tag: (await sql.query('SELECT * FROM money_tags WHERE id=$1', [id])).rows[0] };
  })));
  app.patch<{ Params: { id: string } }>('/api/money/tags/:id', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql) => {
    const body = request.body as Row;
    const row = await sql.query('UPDATE money_tags SET name=$1,sort=$2 WHERE id=$3 RETURNING *', [textOf(body.name, 40, '名称', true), Number(body.sort ?? 1), request.params.id]);
    if (!row.rows[0]) throw new Problem(404, 'NOT_FOUND', '标签不存在');
    return { tag: row.rows[0] };
  }));
  app.delete<{ Params: { id: string } }>('/api/money/tags/:id', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql) => {
    const row = await sql.query('DELETE FROM money_tags WHERE id=$1 RETURNING id', [request.params.id]);
    if (!row.rows[0]) throw new Problem(404, 'NOT_FOUND', '标签不存在');
    return { ok: true };
  }));

  app.get('/api/money/end-reasons', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => ({ items: await reasons(sql) })));
  app.post('/api/money/end-reasons', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const id = (await sql.query<{ id: string }>('INSERT INTO money_end_reasons(tenant_id,name,sort) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, textOf(body.name, 40, '名称', true), Number(body.sort ?? 1)])).rows[0]!.id;
    return { reason: (await sql.query('SELECT * FROM money_end_reasons WHERE id=$1', [id])).rows[0] };
  })));
  app.patch<{ Params: { id: string } }>('/api/money/end-reasons/:id', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql) => {
    const body = request.body as Row;
    const row = await sql.query('UPDATE money_end_reasons SET name=$1,sort=$2 WHERE id=$3 RETURNING *', [textOf(body.name, 40, '名称', true), Number(body.sort ?? 1), request.params.id]);
    if (!row.rows[0]) throw new Problem(404, 'NOT_FOUND', '终止原因不存在');
    return { reason: row.rows[0] };
  }));
  app.delete<{ Params: { id: string } }>('/api/money/end-reasons/:id', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql) => {
    if (!(await sql.query('DELETE FROM money_end_reasons WHERE id=$1 RETURNING id', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '终止原因不存在');
    return { ok: true };
  }));

  app.get('/api/money/audit-flows', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => ({ items: await flows(sql) })));
  app.post('/api/money/audit-flows', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const flow = await createSimpleFlow(sql, actor, { name: textOf(body.name, 80, '审核流程名称', true), objectType: objectOf(body.object_type), enabled: Boolean(body.enabled) });
    return { flow };
  })));
  app.patch<{ Params: { id: string } }>('/api/money/audit-flows/:id', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql) => {
    const body = request.body as Row;
    const flow = await patchSimpleFlow(sql, request.params.id, { name: body.name ? textOf(body.name, 80, '审核流程名称', true) : undefined, enabled: body.enabled === undefined ? undefined : Boolean(body.enabled) });
    return { flow };
  }));
  app.post<{ Params: { id: string } }>('/api/money/audit-flows/:id/copy', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => ({ flow: await copySimpleFlow(sql, actor, request.params.id) })));
  app.delete<{ Params: { id: string } }>('/api/money/audit-flows/:id', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql) => {
    if (!(await sql.query('DELETE FROM audit_flows WHERE id=$1 RETURNING id', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '审核流程不存在');
    return { ok: true };
  }));

  app.get('/api/money/customers', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql, actor) => {
    const query = request.query as Row;
    const items = (await sql.query<Row>('SELECT * FROM customers ORDER BY created_at DESC LIMIT 500')).rows.filter((row) => !row.in_sea || query.sea === '1');
    const filtered = [];
    for (const row of items) {
      const view = await customerView(sql, String(row.id));
      const keyword = String(query.q ?? '');
      if (actor.points && !inScope(actor, view.owner_id ? String(view.owner_id) : null, 'customer.list.view')) continue;
      if (keyword && ![view.code, view.name, view.contact_name, view.contact_phone, view.address].some((part) => String(part).includes(keyword))) continue;
      if (query.code && !String(view.code).includes(String(query.code))) continue;
      if (query.name && !String(view.name).includes(String(query.name))) continue;
      if (query.phone && (await settings(sql)).phone_exact ? view.contact_phone !== query.phone : query.phone && !String(view.contact_phone).includes(String(query.phone))) continue;
      filtered.push(view);
    }
    return { items: filtered, limit: 500 };
  }));
  app.post('/api/money/customers', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const prior = await played(sql, actor, 'money.customer', body);
    if (prior) return { replayed: true, customer: await customerView(sql, prior) };
    const name = textOf(body.name, 200, '名称', true);
    const code = textOf(body.code, 64, '编号') || await serial(sql, actor.tenant_id, 'KH', '', 4);
    const phone = textOf(body.contact_phone, 40, '联系人电话');
    const contact = textOf(body.contact_name, 80, '联系人', true);
    await guardCustomer(sql, name, phone, null);
    const id = (await sql.query<{ id: string }>('INSERT INTO customers(tenant_id,code,name,contact_name,contact_phone,region,address,tags,owner_id,remark) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [actor.tenant_id, code, name, contact, phone, textOf(body.region, 80, '地区'), textOf(body.address, 200, '详细地址'), tagsOf(body.tags), actor.user_id, textOf(body.remark, 500, '备注')])).rows[0]!.id;
    await sql.query('INSERT INTO money_contacts(tenant_id,customer_id,name,phone) VALUES($1,$2,$3,$4)', [actor.tenant_id, id, contact, phone]);
    if (body.region || body.address) await sql.query('INSERT INTO money_addresses(tenant_id,customer_id,region,detail) VALUES($1,$2,$3,$4)', [actor.tenant_id, id, textOf(body.region, 80, '地区'), textOf(body.address, 200, '详细地址')]);
    await remember(sql, actor, 'money.customer', body, 'money_customer', id);
    const customer = await customerView(sql, id);
    noteOp(request, `新增客户：${customer.code} ${customer.name}`);
    return { replayed: false, customer };
  })));
  app.get<{ Params: { id: string } }>('/api/money/customers/:id', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql, actor) => {
    const view = await customerView(sql, request.params.id);
    if (actor.points && !inScope(actor, view.owner_id ? String(view.owner_id) : null, 'customer.list.view')) throw new Problem(404, 'NOT_FOUND', '不存在或不可访问');
    return { customer: view };
  }));
  app.patch<{ Params: { id: string } }>('/api/money/customers/:id', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql) => {
    const body = request.body as Row;
    const before = (await sql.query<Row>('SELECT * FROM customers WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!before) throw new Problem(404, 'NOT_FOUND', '客户不存在');
    if (Number(before.version) !== Number(body.version)) throw new Problem(409, 'VERSION_CONFLICT', '客户已被修改，请刷新');
    const name = textOf(body.name, 200, '名称', true);
    const phone = textOf(body.contact_phone, 40, '联系人电话');
    await guardCustomer(sql, name, phone, request.params.id);
    await sql.query('UPDATE customers SET name=$1,contact_name=$2,contact_phone=$3,region=$4,address=$5,tags=$6,remark=$7,active=$8,version=version+1,updated_at=now() WHERE id=$9', [name, textOf(body.contact_name, 80, '联系人', true), phone, textOf(body.region, 80, '地区'), textOf(body.address, 200, '详细地址'), tagsOf(body.tags), textOf(body.remark, 500, '备注'), body.active !== false, request.params.id]);
    return { customer: await customerView(sql, request.params.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/customers/:id/follow', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql) => {
    const row = await sql.query('UPDATE customers SET followed=NOT followed,version=version+1,updated_at=now() WHERE id=$1 RETURNING id', [request.params.id]);
    if (!row.rows[0]) throw new Problem(404, 'NOT_FOUND', '客户不存在');
    return { customer: await customerView(sql, request.params.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/customers/:id/sea', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const row = await sql.query('UPDATE customers SET in_sea=true,owner_id=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING id', [request.params.id]);
    if (!row.rows[0]) throw new Problem(404, 'NOT_FOUND', '客户不存在');
    await sql.query('INSERT INTO customer_sea_logs(tenant_id,customer_id,action,actor_id) VALUES($1,$2,\'放入公海\',$3)', [actor.tenant_id, request.params.id, actor.user_id]);
    return { customer: await customerView(sql, request.params.id) };
  }));
  app.delete<{ Params: { id: string } }>('/api/money/customers/:id', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    assertPoint(actor, 'customer.list.delete');
    if ((await sql.query('SELECT id FROM money_contracts WHERE customer_id=$1 LIMIT 1', [request.params.id])).rows[0]) throw new Problem(409, 'CUSTOMER_USED', '该客户已有合同，不能删除');
    await sql.query('DELETE FROM money_contacts WHERE customer_id=$1', [request.params.id]);
    await sql.query('DELETE FROM money_addresses WHERE customer_id=$1', [request.params.id]);
    if (!(await sql.query('DELETE FROM customers WHERE id=$1 RETURNING id', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '客户不存在');
    return { ok: true };
  }));
  app.get('/api/money/customers/export', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => {
    const items = (await sql.query<Row>("SELECT * FROM customers WHERE NOT in_sea ORDER BY code")).rows;
    const rows = [['名称', '编号', '地区', '详细地址', '客户标签', '联系人', '联系人电话'], ...items.map((row) => [String(row.name), String(row.code), String(row.region), String(row.address), (row.tags as string[]).join(','), String(row.contact_name), String(row.contact_phone)])];
    return { filename: '客户.xlsx', content_base64: xlsxBytes(rows).toString('base64') };
  }));
  app.post('/api/money/customers/import', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const bytes = Buffer.from(String(body.content_base64 ?? ''), 'base64');
    const rows = xlsxRows(bytes);
    const header = rows[0] ?? [];
    const index = (name: string) => header.indexOf(name);
    let created = 0;
    for (const row of rows.slice(1)) {
      const name = row[index('名称')]?.trim();
      if (!name) continue;
      const contact = row[index('联系人')]?.trim() || name;
      await guardCustomer(sql, name, row[index('联系人电话')]?.trim() ?? '', null);
      const code = row[index('编号')]?.trim() || await serial(sql, actor.tenant_id, 'KH', '', 4);
      const id = (await sql.query<{ id: string }>('INSERT INTO customers(tenant_id,code,name,contact_name,contact_phone,region,address,tags,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [actor.tenant_id, code, name, contact, row[index('联系人电话')]?.trim() ?? '', row[index('地区')]?.trim() ?? '', row[index('详细地址')]?.trim() ?? '', (row[index('客户标签')] ?? '').split(/[,，]/).map((item) => item.trim()).filter(Boolean), actor.user_id])).rows[0]!.id;
      await sql.query('INSERT INTO money_contacts(tenant_id,customer_id,name,phone) VALUES($1,$2,$3,$4)', [actor.tenant_id, id, contact, row[index('联系人电话')]?.trim() ?? '']);
      created++;
    }
    return { created };
  }));
  app.post<{ Params: { id: string } }>('/api/money/customers/:id/contacts', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    if (!(await sql.query('SELECT id FROM customers WHERE id=$1', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '客户不存在');
    const name = textOf(body.name, 80, '联系人', true);
    const phone = textOf(body.phone, 40, '联系人电话');
    await guardCustomer(sql, '', phone, request.params.id);
    await sql.query('INSERT INTO money_contacts(tenant_id,customer_id,name,phone) VALUES($1,$2,$3,$4)', [actor.tenant_id, request.params.id, name, phone]);
    return { customer: await customerView(sql, request.params.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/customers/:id/addresses', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    if (!(await sql.query('SELECT id FROM customers WHERE id=$1', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '客户不存在');
    await sql.query('INSERT INTO money_addresses(tenant_id,customer_id,region,detail) VALUES($1,$2,$3,$4)', [actor.tenant_id, request.params.id, textOf(body.region, 80, '地区'), textOf(body.detail, 200, '详细地址', true)]);
    return { customer: await customerView(sql, request.params.id) };
  }));

  app.get('/api/money/quotations', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => {
    const ids = (await sql.query<{ id: string }>('SELECT id FROM money_quotations ORDER BY created_at DESC LIMIT 200')).rows;
    const items = await Promise.all(ids.map((row) => quotationView(sql, row.id)));
    const query = request.query as Row;
    const filtered = items.filter((item) => (!query.approval || query.approval === 'all' || item.approval === query.approval) && (!query.contract || query.contract === 'all' || (query.contract === 'created' ? !!item.contract_id : !item.contract_id)) && (!query.quote_status || query.quote_status === 'all' || item.quote_status === query.quote_status) && (!query.signed || query.signed === 'all' || String(item.signed) === String(query.signed === 'yes')) && (!query.q || `${item.code}${item.customer_name}${item.contact_name}`.includes(String(query.q))));
    return { items: filtered, summary: { amount: sumMoney(filtered.map((item) => item.amount)), qty: sumMoney(filtered.map((item) => item.qty)) }, limit: 200 };
  }));
  app.post('/api/money/quotations', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const prior = await played(sql, actor, 'money.quotation', body);
    if (prior) return { replayed: true, quotation: await quotationView(sql, prior) };
    const id = await insertQuotation(sql, actor, body);
    await remember(sql, actor, 'money.quotation', body, 'money_quotation', id);
    return { replayed: false, quotation: await quotationView(sql, id) };
  })));
  app.get<{ Params: { id: string } }>('/api/money/quotations/:id', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => ({ quotation: await quotationView(sql, request.params.id) })));
  app.post<{ Params: { id: string } }>('/api/money/quotations/:id/actions', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const row = await lockQuotation(sql, request.params.id, Number(body.version));
    const action = String(body.action);
    if (action === 'approve' || action === 'reject') {
      if (row.approval !== 'pending') throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
      const opinion = action === 'reject' ? textOf(body.opinion ?? body.reason, 200, '审核意见', true) : textOf(body.opinion, 200, '审核意见');
      if (await hasPendingInstance(sql, 'quotation', String(row.id))) noteOp(request, (await decideAudit(sql, actor, 'quotation', String(row.id), action === 'approve' ? '通过' : '退回', opinion, '')).log);
      else await sql.query('UPDATE money_quotations SET approval=$1,version=version+1,updated_at=now() WHERE id=$2', [action === 'approve' ? 'approved' : 'rejected', row.id]);
      await audit(sql, actor, 'quotation', String(row.id), action, opinion);
    } else if (action === 'withdraw') {
      if (row.approval !== 'pending') throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
      if (await hasPendingInstance(sql, 'quotation', String(row.id))) noteOp(request, (await decideAudit(sql, actor, 'quotation', String(row.id), '撤回', '', '')).log);
      else await sql.query("UPDATE money_quotations SET approval='withdrawn',version=version+1,updated_at=now() WHERE id=$1", [row.id]);
      await audit(sql, actor, 'quotation', String(row.id), 'withdraw', '');
    } else if (action === 'sign') {
      await sql.query('UPDATE money_quotations SET signed=NOT signed,version=version+1,updated_at=now() WHERE id=$1', [row.id]);
    } else if (action === 'status') {
      const status = String(body.quote_status);
      if (!quoteText[status]) throw new Problem(422, 'STATUS', '报价状态不正确');
      await sql.query('UPDATE money_quotations SET quote_status=$1,version=version+1,updated_at=now() WHERE id=$2', [status, row.id]);
    } else if (action === 'submit') {
      if (!['draft', 'rejected', 'withdrawn'].includes(String(row.approval))) throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
      const approval = await auditOn(sql, 'quotation') ? 'pending' : 'exempt';
      await sql.query('UPDATE money_quotations SET approval=$1,version=version+1,updated_at=now() WHERE id=$2', [approval, row.id]);
      await engage(sql, actor, 'quotation', String(row.id), approval);
    } else if (action === 'delete') {
      if (row.contract_id) throw new Problem(409, 'QUOTATION_USED', '该报价单已创建合同，不能删除');
      await sql.query('DELETE FROM money_quotations WHERE id=$1', [row.id]);
      return { ok: true };
    } else throw new Problem(422, 'ACTION', '不支持的操作');
    return { quotation: await quotationView(sql, request.params.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/quotations/:id/copy', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const source = await quotationView(sql, request.params.id);
    const id = await insertQuotation(sql, actor, shape(source, { code: '', lines: source.lines, request_key: undefined }));
    return { quotation: await quotationView(sql, id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/quotations/:id/to-contract', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const quote = await quotationView(sql, request.params.id);
    if (!['approved', 'exempt'].includes(quote.approval)) throw new Problem(409, 'QUOTATION_STATE', '只能从已审核通过或不需审核的报价单生成合同');
    if (quote.contract_id) throw new Problem(409, 'QUOTATION_USED', '该报价单已创建合同');
    const id = await insertContract(sql, actor, { customer_id: quote.customer_id, contact_name: quote.contact_name, contact_phone: quote.contact_phone, address: quote.address, delivery_date: quote.delivery_date, salesperson_id: quote.salesperson_id, note: quote.note, lines: quote.lines, prepay: '0', submit: false, quotation_id: quote.id });
    await sql.query('UPDATE money_quotations SET contract_id=$1,version=version+1,updated_at=now() WHERE id=$2', [id, quote.id]);
    await log(sql, actor, 'contract', id, `由报价单${quote.code}生成`);
    return { contract: await contractView(sql, id) };
  }));

  app.get('/api/money/contracts', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql, actor) => {
    await remind(sql, actor);
    const ids = (await sql.query<{ id: string }>('SELECT id FROM money_contracts ORDER BY created_at DESC LIMIT 200')).rows;
    const items = await Promise.all(ids.map((row) => contractView(sql, row.id)));
    const query = request.query as Row;
    const filtered = items.filter((item) => (!query.approval || query.approval === 'all' || item.approval === query.approval) && (!query.lifecycle || query.lifecycle === 'all' || item.lifecycle === query.lifecycle) && (!query.code || item.code.includes(String(query.code))) && (!query.customer || item.customer_name.includes(String(query.customer)) || item.customer_code.includes(String(query.customer))) && (!query.q || `${item.code}${item.customer_name}${item.note}`.includes(String(query.q))));
    const counted = filtered.filter((item) => item.approval === 'approved' || item.approval === 'exempt');
    const visibleIds = actor.points ? await pendingApproverIds(sql, actor.user_id, 'contract') : null;
    const visible = filtered.filter((item) => !visibleIds || inScope(actor, String(item.salesperson_id ?? ''), 'customer.contract.view') || visibleIds.has(String(item.id)));
    // 欠款/已收等仍只计已通过；合同金额/预收按当前可见行汇总，避免待审筛选时汇总条全是 0 元
    const settledSummary = summaryOf(counted.filter((item) => visible.some((row) => row.id === item.id)));
    return {
      items: visible,
      summary: {
        ...settledSummary,
        amount: sumMoney(visible.map((item) => item.amount)),
        prepay: sumMoney(visible.map((item) => item.prepay)),
      },
      limit: 200,
    };
  }));
  app.post('/api/money/contracts', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const prior = await played(sql, actor, 'money.contract', body);
    if (prior) return { replayed: true, contract: await contractView(sql, prior) };
    const id = await insertContract(sql, actor, body);
    await remember(sql, actor, 'money.contract', body, 'money_contract', id);
    return { replayed: false, contract: await contractView(sql, id) };
  })));
  app.get<{ Params: { id: string } }>('/api/money/contracts/:id', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql, actor) => {
    const detail = await contractDetail(sql, request.params.id);
    if (actor.points) {
      const visible = await pendingApproverIds(sql, actor.user_id, 'contract');
      if (!inScope(actor, String(detail.contract.salesperson_id ?? ''), 'customer.contract.view') && !visible.has(request.params.id)) throw new Problem(404, 'NOT_FOUND', '不存在或不可访问');
    }
    return detail;
  }));
  app.post<{ Params: { id: string } }>('/api/money/contracts/:id/actions', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const row = await lockContract(sql, request.params.id, Number(body.version));
    const action = String(body.action);
    if (action === 'submit') {
      if (!['draft', 'rejected', 'withdrawn'].includes(String(row.approval))) throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
      await applySubmit(sql, actor, String(row.id));
    } else if (action === 'approve' || action === 'reject') {
      if (row.approval !== 'pending') throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
      const opinion = action === 'reject' ? textOf(body.opinion ?? body.reason, 200, '审核意见', true) : textOf(body.opinion, 200, '审核意见');
      if (await hasPendingInstance(sql, 'contract', String(row.id))) noteOp(request, (await decideAudit(sql, actor, 'contract', String(row.id), action === 'approve' ? '通过' : '退回', opinion, '')).log);
      else await sql.query("UPDATE money_contracts SET approval=$1,lifecycle=$2,approved_at=CASE WHEN $1='approved' THEN now() ELSE approved_at END,version=version+1,updated_at=now() WHERE id=$3", [action === 'approve' ? 'approved' : 'rejected', action === 'approve' ? 'performing' : 'inactive', row.id]);
      await audit(sql, actor, 'contract', String(row.id), action, opinion);
      await log(sql, actor, 'contract', String(row.id), action === 'approve' ? '审核通过' : `审核退回：${opinion}`);
    } else if (action === 'revise') {
      if (!['rejected', 'withdrawn'].includes(String(row.approval))) throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
      if (body.amount !== undefined) await sql.query('UPDATE money_contracts SET amount=$1 WHERE id=$2', [positiveMoney(body.amount, '合同金额'), row.id]);
      await applySubmit(sql, actor, String(row.id));
    } else if (action === 'complete') {
      if (row.lifecycle !== 'performing') throw new Problem(409, 'STATE_TRANSITION', '只有履约中的合同可以完成');
      await sql.query("UPDATE money_contracts SET lifecycle='done',completed_at=now(),version=version+1,updated_at=now() WHERE id=$1", [row.id]);
      await log(sql, actor, 'contract', String(row.id), '合同完成');
    } else if (action === 'terminate') {
      if (row.lifecycle !== 'performing') throw new Problem(409, 'STATE_TRANSITION', '只有履约中的合同可以终止');
      const reason = (await sql.query<Row>('SELECT name FROM money_end_reasons WHERE id=$1', [body.reason_id])).rows[0];
      if (!reason) throw new Problem(422, 'REASON_REQUIRED', '请选择终止原因');
      const view = await contractView(sql, String(row.id));
      await sql.query('INSERT INTO money_terminations(tenant_id,contract_id,reason_name,note,attachment,before_status,received_amount,debt_amount,operator_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [actor.tenant_id, row.id, reason.name, textOf(body.note, 500, '终止说明'), textOf(body.attachment, 200, '附件'), view.lifecycle_text, view.received, view.debt, actor.display_name]);
      await sql.query("UPDATE money_contracts SET lifecycle='terminated',version=version+1,updated_at=now() WHERE id=$1", [row.id]);
      await log(sql, actor, 'contract', String(row.id), `合同终止：${reason.name}`);
    } else if (action === 'copy') {
      const view = await contractView(sql, String(row.id));
      const id = await insertContract(sql, actor, { customer_id: view.customer_id, contact_name: view.contact_name, contact_phone: view.contact_phone, address: view.address, salesperson_id: view.salesperson_id, delivery_date: view.delivery_date, receipt_date: view.receipt_date, tax_included: view.tax_included, note: view.note, lines: view.lines, prepay: '0', submit: false });
      return { contract: await contractView(sql, id) };
    } else if (action === 'delete') {
      const received = await cashSum(sql, String(row.id), 'in', true);
      if (cmpMoney(received, '0') > 0) throw new Problem(409, 'CONTRACT_PAID', '该合同已有收款，不能删除');
      await sql.query('DELETE FROM money_cash WHERE contract_id=$1', [row.id]);
      await sql.query('DELETE FROM money_contracts WHERE id=$1', [row.id]);
      return { ok: true };
    } else throw new Problem(422, 'ACTION', '不支持的操作');
    return { contract: await contractView(sql, request.params.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/contracts/:id/cash', { preHandler: guard }, (request) => run(request, 'finance.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const contract = await contractView(sql, request.params.id);
    if (!['performing', 'inactive'].includes(contract.lifecycle) && contract.approval !== 'pending') throw new Problem(409, 'STATE_TRANSITION', '当前合同不能登记收支');
    const direction = body.direction === 'out' ? 'out' : 'in';
    const amount = positiveMoney(body.amount, '金额');
    if (direction === 'in') await guardReceipt(sql, contract, amount);
    const approval = await auditOn(sql, 'cash') ? 'pending' : 'exempt';
    const id = await insertCash(sql, actor, { contract_id: contract.id, customer_id: contract.customer_id, direction, amount, note: textOf(body.note, 255, '备注'), attachment: textOf(body.attachment, 200, '附件'), approval, source: 'contract' });
    await log(sql, actor, 'contract', contract.id, direction === 'in' ? `收款${amount}` : `支出${amount}`);
    return { cash: await cashView(sql, id), contract: await contractView(sql, contract.id) };
  }));
  app.post('/api/money/contracts/batch-cash', { preHandler: guard }, (request) => run(request, 'finance.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const contracts = [];
    for (const id of ids) contracts.push(await contractView(sql, id));
    const payable = contracts.filter((item) => cmpMoney(item.debt, '0') > 0);
    const debts = payable.map((item) => item.debt);
    const cap = sumMoney(debts);
    const mode = String(body.mode ?? 'auto');
    let amounts: string[];
    if (mode === 'clear') amounts = debts;
    else if (mode === 'manual') amounts = payable.map((item) => moneyOf((body.lines as Row[] | undefined)?.find((line) => line.id === item.id)?.amount, '本次收款'));
    else amounts = allocateSequential(debts, moneyOf(body.total, '本次收款总额'));
    if (cmpMoney(sumMoney(amounts), cap) > 0) throw new Problem(422, 'OVER_ALLOCATION', `不可大于所选合同总欠款 ${cap} 元`);
    const approval = await auditOn(sql, 'cash') ? 'pending' : 'exempt';
    const created = [];
    for (const [index, contract] of payable.entries()) {
      const amount = amounts[index] ?? '0';
      if (cmpMoney(amount, '0') <= 0) continue;
      if (cmpMoney(amount, contract.debt) > 0) throw new Problem(422, 'OVER_RECEIPT', '收款金额不能超过欠款');
      await guardReceipt(sql, contract, amount);
      created.push(await insertCash(sql, actor, { contract_id: contract.id, customer_id: contract.customer_id, direction: 'in', amount, note: textOf(body.note, 255, '备注'), attachment: '', approval, source: 'contract' }));
    }
    return { ids: created, allocations: payable.map((item, index) => ({ id: item.id, code: item.code, amount: amounts[index], debt_after: subMoney(item.debt, amounts[index] ?? '0') })) };
  }));
  app.post('/api/money/contracts/batch', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    if (body.action === 'approve') permit(actor, 'sales.approve');
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    for (const id of ids) {
      const row = (await sql.query<Row>('SELECT * FROM money_contracts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) continue;
      if (body.action === 'approve' && row.approval === 'pending') {
        if (await hasPendingInstance(sql, 'contract', id)) await decideAudit(sql, actor, 'contract', id, '通过', textOf(body.opinion, 200, '审核意见'), '');
        else await sql.query("UPDATE money_contracts SET approval='approved',lifecycle='performing',approved_at=now(),version=version+1 WHERE id=$1", [id]);
        await audit(sql, actor, 'contract', id, 'approve', textOf(body.opinion, 200, '审核意见'));
      } else if (body.action === 'delete') {
        const received = await cashSum(sql, id, 'in', true);
        if (cmpMoney(received, '0') > 0) throw new Problem(409, 'CONTRACT_PAID', '该合同已有收款，不能删除');
        await sql.query('DELETE FROM money_cash WHERE contract_id=$1', [id]);
        await sql.query('DELETE FROM money_contracts WHERE id=$1', [id]);
      }
    }
    return { ok: true };
  }));

  app.get('/api/money/cash', { preHandler: guard }, (request) => run(request, 'finance.read', false, async (sql) => {
    const ids = (await sql.query<{ id: string }>('SELECT id FROM money_cash ORDER BY created_at DESC LIMIT 300')).rows;
    const items = await Promise.all(ids.map((row) => cashView(sql, row.id)));
    const query = request.query as Row;
    const filtered = items.filter((item) => (!query.approval || query.approval === 'all' || item.approval === query.approval) && (!query.q || `${item.customer_name}${item.contract_code}${item.note}`.includes(String(query.q))));
    const income = sumMoney(filtered.filter((item) => item.direction === 'in' && countsReceipt(item.approval)).map((item) => item.amount));
    const spend = sumMoney(filtered.filter((item) => item.direction === 'out' && countsReceipt(item.approval)).map((item) => item.amount));
    return { items: filtered, summary: { income, spend }, limit: 300 };
  }));
  app.get('/api/money/shipment-lines', { preHandler: guard }, (request) => run(request, 'finance.read', false, async (sql) => shipmentLines(sql, String((request.query as Row).customer_id ?? ''))));
  app.post('/api/money/cash', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'finance.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const customerId = String(body.customer_id ?? '');
    if (!customerId) throw new Problem(422, 'REQUIRED', '请选择客户', 'customer_id');
    if (!(await sql.query('SELECT id FROM customers WHERE id=$1', [customerId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '客户不存在');
    const lines = Array.isArray(body.lines) ? body.lines as Row[] : [];
    if (!lines.length) throw new Problem(422, 'LINES_REQUIRED', '请填写本次收款', 'lines');
    const open = await shipmentLines(sql, customerId);
    let total = '0';
    const allocations = [];
    for (const line of lines) {
      const source = open.items.find((item) => item.id === line.shipment_line_id);
      if (!source) throw new Problem(422, 'INVALID_REFERENCE', '发货明细不存在或不属于非合同商品');
      const amount = positiveMoney(line.amount, '收款金额');
      if (cmpMoney(amount, source.debt) > 0) throw new Problem(422, 'OVER_RECEIPT', '收款金额不能超过欠款');
      total = addMoney(total, amount);
      allocations.push({ shipment_line_id: source.id, amount });
    }
    const approval = await auditOn(sql, 'cash') ? 'pending' : 'exempt';
    const id = (await sql.query<{ id: string }>('INSERT INTO money_cash(tenant_id,customer_id,direction,amount,note,attachment,approval,source,allocations,created_by) VALUES($1,$2,\'in\',$3,$4,$5,$6,\'shipment\',$7::jsonb,$8) RETURNING id', [actor.tenant_id, customerId, total, textOf(body.note, 255, '备注'), textOf(body.attachment, 200, '附件'), approval, JSON.stringify(allocations), actor.user_id])).rows[0]!.id;
    await engage(sql, actor, 'cash', id, approval);
    return { cash: await cashView(sql, id) };
  })));
  app.patch<{ Params: { id: string } }>('/api/money/cash/:id', { preHandler: guard }, (request) => run(request, 'finance.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const row = (await sql.query<Row>('SELECT * FROM money_cash WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '收支记录不存在');
    if (row.approval !== 'rejected') throw new Problem(409, 'STATE_TRANSITION', '只有退回的记录可以修改');
    const amount = positiveMoney(body.amount, '金额');
    if (row.contract_id && row.direction === 'in') await guardReceipt(sql, await contractView(sql, String(row.contract_id)), amount);
    const approval = await auditOn(sql, 'cash') ? 'pending' : 'exempt';
    await sql.query('UPDATE money_cash SET amount=$1,note=$2,attachment=$3,approval=$4,version=version+1 WHERE id=$5', [amount, textOf(body.note, 255, '备注'), textOf(body.attachment, 200, '附件'), approval, row.id]);
    await engage(sql, actor, 'cash', String(row.id), approval);
    return { cash: await cashView(sql, request.params.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/cash/:id/actions', { preHandler: guard }, (request) => run(request, 'finance.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const row = (await sql.query<Row>('SELECT * FROM money_cash WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '收支记录不存在');
    const action = String(body.action);
    if (action === 'delete') {
      if (['approved', 'exempt'].includes(String(row.approval))) throw new Problem(409, 'STATE_TRANSITION', '已生效的收支不能删除');
      await sql.query('DELETE FROM money_cash WHERE id=$1', [row.id]);
      return { ok: true };
    }
    if (row.approval !== 'pending') throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
    const opinion = action === 'reject' ? textOf(body.opinion ?? body.reason, 200, '审核意见', true) : textOf(body.opinion, 200, '审核意见');
    const mapped = action === 'approve' ? '通过' : action === 'reject' ? '退回' : action === 'withdraw' ? '撤回' : '';
    if (!mapped) throw new Problem(422, 'ACTION', '不支持的操作');
    if (await hasPendingInstance(sql, 'cash', String(row.id))) noteOp(request, (await decideAudit(sql, actor, 'cash', String(row.id), mapped, opinion, '')).log);
    else await sql.query('UPDATE money_cash SET approval=$1,version=version+1 WHERE id=$2', [mapped === '通过' ? 'approved' : mapped === '退回' ? 'rejected' : 'withdrawn', row.id]);
    await audit(sql, actor, 'cash', String(row.id), action, opinion);
    return { cash: await cashView(sql, request.params.id) };
  }));

  app.get('/api/money/invoices', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => {
    const items = await invoiceList(sql);
    const query = request.query as Row;
    const filtered = items.filter((item) => (!query.status || query.status === 'all' || item.status === query.status) && (!query.q || `${item.customer_name}${item.contract_code}`.includes(String(query.q))));
    return { items: filtered, summary: { amount: sumMoney(filtered.map((item) => item.amount)) } };
  }));
  app.post('/api/money/invoices', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const contract = await contractView(sql, String(body.contract_id ?? ''));
    const id = (await sql.query<{ id: string }>('INSERT INTO money_invoices(tenant_id,contract_id,customer_id,amount,apply_note,attachment,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [actor.tenant_id, contract.id, contract.customer_id, positiveMoney(body.amount, '开票金额'), textOf(body.apply_note, 200, '申请备注'), textOf(body.attachment, 200, '附件'), actor.user_id])).rows[0]!.id;
    await log(sql, actor, 'contract', contract.id, `申请开票${body.amount}`);
    return { invoice: (await invoiceList(sql)).find((item) => item.id === id) };
  })));
  app.post<{ Params: { id: string } }>('/api/money/invoices/:id/actions', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const row = (await sql.query<Row>('SELECT * FROM money_invoices WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '发票申请不存在');
    if (body.action === 'delete') {
      if (row.status !== 'pending') throw new Problem(409, 'STATE_TRANSITION', '已开票记录不能删除');
      await sql.query('DELETE FROM money_invoices WHERE id=$1', [row.id]);
      return { ok: true };
    }
    if (body.action !== 'finish') throw new Problem(422, 'ACTION', '不支持的操作');
    if (row.status !== 'pending') throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
    await sql.query("UPDATE money_invoices SET status='done',invoice_note=$1,invoiced_by=$2,invoiced_at=now() WHERE id=$3", [textOf(body.invoice_note, 200, '开票备注'), actor.user_id, row.id]);
    await log(sql, actor, 'contract', String(row.contract_id), '标记开票完毕');
    return { invoice: (await invoiceList(sql)).find((item) => item.id === request.params.id), contract: await contractView(sql, String(row.contract_id)) };
  }));

  app.get('/api/money/expenses', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql) => {
    const items = await expenseList(sql);
    const query = request.query as Row;
    const filtered = items.filter((item) => (!query.approval || query.approval === 'all' || item.approval === query.approval) && (!query.settled || query.settled === 'all' || (query.settled === 'yes' ? item.settled : !item.settled)) && (!query.q || `${item.customer_name}${item.contract_code}${item.category}`.includes(String(query.q))));
    const alive = filtered.filter((item) => !['rejected', 'withdrawn'].includes(item.approval));
    return { items: filtered, cards: { total: sumMoney(alive.map((item) => item.amount)), pending: sumMoney(alive.filter((item) => item.approval === 'pending').map((item) => item.amount)), approved: sumMoney(alive.filter((item) => countsReceipt(item.approval)).map((item) => item.amount)), unsettled: sumMoney(alive.filter((item) => !item.settled).map((item) => item.amount)), settled: sumMoney(alive.filter((item) => item.settled).map((item) => item.amount)) } };
  }));
  app.post('/api/money/expenses', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const customerId = String(body.customer_id ?? '');
    if (!customerId) throw new Problem(422, 'REQUIRED', '请选择客户', 'customer_id');
    if (!(await sql.query('SELECT id FROM customers WHERE id=$1', [customerId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '客户不存在');
    const category = String(body.category ?? '');
    if (!['差旅费', '招待', '赠礼', '回扣'].includes(category)) throw new Problem(422, 'CATEGORY', '支出类别不正确');
    let contractId: string | null = null;
    if (body.contract_id) {
      const contract = await contractView(sql, String(body.contract_id));
      if (contract.customer_id !== customerId) throw new Problem(422, 'INVALID_REFERENCE', '合同不属于该客户');
      contractId = contract.id;
    }
    const approval = await auditOn(sql, 'expense') ? 'pending' : 'exempt';
    const id = (await sql.query<{ id: string }>('INSERT INTO money_expenses(tenant_id,customer_id,contract_id,spent_on,category,amount,note,attachment,approval,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [actor.tenant_id, customerId, contractId, dayOf(body.spent_on) ?? todayISO(), category, positiveMoney(body.amount, '金额'), textOf(body.note, 255, '备注'), textOf(body.attachment, 200, '附件'), approval, actor.user_id])).rows[0]!.id;
    await engage(sql, actor, 'expense', id, approval);
    return { expense: (await expenseList(sql)).find((item) => item.id === id) };
  })));
  app.post<{ Params: { id: string } }>('/api/money/expenses/:id/actions', { preHandler: guard }, (request) => run(request, 'sales.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const row = (await sql.query<Row>('SELECT * FROM money_expenses WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '销售费用不存在');
    const action = String(body.action);
    if (action === 'approve' || action === 'reject') {
      if (row.approval !== 'pending') throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
      const opinion = action === 'reject' ? textOf(body.opinion ?? body.reason, 200, '审核意见', true) : textOf(body.opinion, 200, '审核意见');
      if (await hasPendingInstance(sql, 'expense', String(row.id))) noteOp(request, (await decideAudit(sql, actor, 'expense', String(row.id), action === 'approve' ? '通过' : '退回', opinion, '')).log);
      else await sql.query('UPDATE money_expenses SET approval=$1,version=version+1 WHERE id=$2', [action === 'approve' ? 'approved' : 'rejected', row.id]);
      await audit(sql, actor, 'expense', String(row.id), action, opinion);
    } else if (action === 'settle') {
      if (!countsReceipt(String(row.approval))) throw new Problem(409, 'STATE_TRANSITION', '审核通过后才能结算');
      await sql.query('UPDATE money_expenses SET settled=true,settle_attachment=$1,version=version+1 WHERE id=$2', [textOf(body.attachment, 200, '结算附件'), row.id]);
    } else if (action === 'delete') {
      if (row.approval !== 'pending' && row.approval !== 'rejected') throw new Problem(409, 'STATE_TRANSITION', '当前状态不能删除');
      await sql.query('DELETE FROM money_expenses WHERE id=$1', [row.id]);
      return { ok: true };
    } else throw new Problem(422, 'ACTION', '不支持的操作');
    return { expense: (await expenseList(sql)).find((item) => item.id === request.params.id) };
  }));

  app.get('/api/money/suppliers', { preHandler: guard }, (request) => run(request, 'procurement.read', false, async (sql) => ({ items: await supplierList(sql, request.query as Row) })));
  app.post('/api/money/suppliers', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'procurement.write', true, async (sql, actor) => ({ supplier: await saveSupplier(sql, actor, request.body as Row, null) }))));
  app.patch<{ Params: { id: string } }>('/api/money/suppliers/:id', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql, actor) => ({ supplier: await saveSupplier(sql, actor, request.body as Row, request.params.id) })));
  app.delete<{ Params: { id: string } }>('/api/money/suppliers/:id', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql) => {
    const blocked = await supplierDeleteBlock(sql, request.params.id);
    if (blocked) throw new Problem(409, 'SUPPLIER_USED', blocked);
    if (!(await sql.query('DELETE FROM suppliers WHERE id=$1 RETURNING id', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '供应商不存在');
    return { ok: true };
  }));
  app.get<{ Params: { id: string } }>('/api/money/suppliers/:id/products', { preHandler: guard }, (request) => run(request, 'procurement.read', false, async (sql) => ({ items: (await sql.query("SELECT DISTINCT p.id,p.code,p.name,p.specification,p.attribute FROM purchase_order_lines l JOIN purchase_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id WHERE o.supplier_id=$1 ORDER BY p.code", [request.params.id])).rows.map((row) => (shape(row, { source: row.attribute === 'purchased' ? '外购' : '自产' }))) })));

  app.get('/api/money/purchase-plans', { preHandler: guard }, (request) => run(request, 'procurement.read', false, async (sql) => ({ items: await planList(sql) })));
  app.post('/api/money/purchase-plans', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'procurement.write', true, async (sql, actor) => ({ plan: await savePlan(sql, actor, request.body as Row, null) }))));
  app.patch<{ Params: { id: string } }>('/api/money/purchase-plans/:id', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql, actor) => ({ plan: await savePlan(sql, actor, request.body as Row, request.params.id) })));
  app.delete<{ Params: { id: string } }>('/api/money/purchase-plans/:id', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql) => {
    if (!(await sql.query('DELETE FROM money_purchase_plans WHERE id=$1 RETURNING id', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '采购计划不存在');
    return { ok: true };
  }));

  app.get('/api/money/purchase-orders', { preHandler: guard }, (request) => run(request, 'procurement.read', false, async (sql) => {
    const items = await purchaseList(sql);
    const query = request.query as Row;
    const filtered = items.filter((item) => (!query.approval || query.approval === 'all' || item.approval === query.approval) && (!query.code || item.code.includes(String(query.code))) && (!query.supplier || item.supplier_name.includes(String(query.supplier))) && (!query.q || `${item.code}${item.supplier_name}${item.note}`.includes(String(query.q))) && (!query.overdue || query.overdue === 'all' || (query.overdue === 'yes' ? item.overdue_days > 0 : item.overdue_days === 0)));
    return { items: filtered, summary: { qty: sumMoney(filtered.map((item) => item.qty)), amount: sumMoney(filtered.map((item) => item.amount)), inbound: sumMoney(filtered.map((item) => item.inbound_amount)), returned: sumMoney(filtered.map((item) => item.return_amount)), debt: sumMoney(filtered.map((item) => item.debt)) } };
  }));
  app.post('/api/money/purchase-orders', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'procurement.write', true, async (sql, actor) => ({ purchase_order: await savePurchase(sql, actor, request.body as Row) }))));
  app.get<{ Params: { id: string } }>('/api/money/purchase-orders/:id', { preHandler: guard }, (request) => run(request, 'procurement.read', false, async (sql) => purchaseDetail(sql, request.params.id)));
  app.post<{ Params: { id: string } }>('/api/money/purchase-orders/:id/actions', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const order = await purchaseOne(sql, request.params.id);
    if (body.action === 'delete') {
      if (cmpMoney(order.paid, '0') > 0 || cmpMoney(order.inbound_amount, '0') > 0) throw new Problem(409, 'PURCHASE_USED', '已有收货或付款，不能删除');
      await sql.query('DELETE FROM money_purchase_line_meta WHERE order_id=$1', [order.id]);
      await sql.query('DELETE FROM purchase_order_lines WHERE order_id=$1', [order.id]);
      await sql.query('DELETE FROM purchase_orders WHERE id=$1', [order.id]);
      return { ok: true };
    }
    if (body.action === 'copy') return { purchase_order: await savePurchase(sql, actor, shape(order, { code: '', lines: order.lines })) };
    if (body.action === 'update') {
      if (cmpMoney(order.paid, '0') > 0 || cmpMoney(order.inbound_amount, '0') > 0) throw new Problem(409, 'PURCHASE_USED', '已有收货或付款，不能修改');
      if (Number(order.version) !== Number(body.version)) throw new Problem(409, 'VERSION_CONFLICT', '采购单已被修改，请刷新');
      await sql.query('DELETE FROM money_purchase_line_meta WHERE order_id=$1', [order.id]);
      await sql.query('DELETE FROM purchase_order_lines WHERE order_id=$1', [order.id]);
      return { purchase_order: await savePurchase(sql, actor, shape(body, { code: body.code || order.code, order_date: order.order_date }), String(order.id)) };
    }
    throw new Problem(422, 'ACTION', '不支持的操作');
  }));
  app.post<{ Params: { id: string } }>('/api/money/purchase-orders/:id/pay', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql, actor) => {
    const body = request.body as Row;
    if (body.order_id !== undefined && body.order_id !== null && String(body.order_id) !== request.params.id) throw new Problem(422, 'ORDER_MISMATCH', '付款采购单与选中行不一致');
    const id = await payOrder(sql, actor, request.params.id, body);
    return { payment: await paymentView(sql, id), purchase_order: await purchaseOne(sql, request.params.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/purchase-orders/:id/invoice', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql, actor) => {
    const id = await invoiceOrder(sql, actor, request.params.id, request.body as Row);
    return { invoice: (await purchaseInvoices(sql)).find((item) => item.id === id), purchase_order: await purchaseOne(sql, request.params.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/money/purchase-orders/:id/returns', { preHandler: guard }, () => {
    throw new Problem(410, 'GONE', '请使用仓库管理中的采购退货单');
  });
  app.post('/api/money/purchase-orders/batch-pay', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const lines = Array.isArray(body.lines) ? body.lines as Row[] : [];
    const ids = [];
    for (const line of lines) ids.push(await payOrder(sql, actor, String(line.id), shape(body, { amount: line.amount })));
    return { ids };
  }));
  app.post('/api/money/purchase-orders/batch-invoice', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql, actor) => {
    const lines = Array.isArray((request.body as Row).lines) ? (request.body as Row).lines as Row[] : [];
    const ids = [];
    for (const line of lines) ids.push(await invoiceOrder(sql, actor, String(line.id), line));
    return { ids };
  }));

  app.get('/api/money/purchase-payments', { preHandler: guard }, (request) => run(request, 'procurement.read', false, async (sql) => {
    const items = await paymentList(sql);
    return { items, summary: { amount: sumMoney(items.filter((item) => countsReceipt(item.approval)).map((item) => item.amount)) } };
  }));
  app.post<{ Params: { id: string } }>('/api/money/purchase-payments/:id/actions', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql) => {
    const row = (await sql.query<Row>('SELECT * FROM money_purchase_payments WHERE id=$1', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '付款记录不存在');
    if ((request.body as Row).action === 'delete') {
      await sql.query('DELETE FROM money_purchase_payments WHERE id=$1', [row.id]);
      return { ok: true };
    }
    const body = request.body as Row;
    await sql.query('UPDATE money_purchase_payments SET amount=$1,pay_date=$2,note=$3,version=version+1 WHERE id=$4', [positiveMoney(body.amount ?? row.amount, '付款金额'), dayOf(body.pay_date) ?? dateText(row.pay_date), textOf(body.note ?? row.note, 255, '备注'), row.id]);
    return { payment: await paymentView(sql, request.params.id) };
  }));
  app.get('/api/money/purchase-invoices', { preHandler: guard }, (request) => run(request, 'procurement.read', false, async (sql) => ({ items: await purchaseInvoices(sql) })));
  app.post<{ Params: { id: string } }>('/api/money/purchase-invoices/:id/actions', { preHandler: guard }, (request) => run(request, 'procurement.write', true, async (sql) => {
    if ((request.body as Row).action !== 'delete') throw new Problem(422, 'ACTION', '不支持的操作');
    if (!(await sql.query('DELETE FROM money_purchase_invoices WHERE id=$1 RETURNING id', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '采购发票不存在');
    return { ok: true };
  }));
  app.post('/api/money/purchase-invoices', { preHandler: guard }, async (request, reply) => reply.code(201).send(await run(request, 'procurement.write', true, async (sql, actor) => {
    const body = request.body as Row;
    const id = await invoiceOrder(sql, actor, String(body.order_id ?? ''), body);
    return { invoice: (await purchaseInvoices(sql)).find((item) => item.id === id) };
  })));
  app.get('/api/money/notices', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql, actor) => ({ items: (await sql.query('SELECT id,title,message,read_at,created_at FROM money_notices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [actor.user_id])).rows })));
  app.post('/api/money/reminders/run', { preHandler: guard }, (request) => run(request, 'sales.read', false, async (sql, actor) => remind(sql, actor)));
}

function scaleOf(value: unknown) {
  const scale = Number(value);
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) throw new Problem(422, 'SCALE', '小数位数须在0到8之间');
  return scale;
}
function daysOf(value: unknown) {
  const days = Number(value ?? 0);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new Problem(422, 'DAYS', '提醒天数不正确');
  return days;
}
function kindOf(value: unknown) {
  if (value !== 'customer' && value !== 'supplier') throw new Problem(422, 'KIND', '标签类型不正确');
  return value;
}
function objectOf(value: unknown) {
  const text = String(value ?? '');
  if (!objectText[text]) throw new Problem(422, 'OBJECT', '审核对象不正确');
  return text;
}
function tagsOf(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => textOf(item, 40, '标签')).filter(Boolean);
}
function presentFlow(row: Row) {
  return shape(row, { object_text: objectText[String(row.object_type)] ?? row.object_type, enabled_text: row.enabled ? '启用' : '禁用' });
}

async function ensure(sql: Sql, tenantId: string) {
  if (!(await sql.query('SELECT tenant_id FROM money_settings WHERE tenant_id=$1', [tenantId])).rows[0]) await sql.query('INSERT INTO money_settings(tenant_id) VALUES($1)', [tenantId]);
  if (!(await sql.query("SELECT id FROM money_tags WHERE kind='customer' LIMIT 1")).rows[0]) {
    await sql.query("INSERT INTO money_tags(tenant_id,kind,name,sort) VALUES($1,'customer','意向客户',1),($1,'customer','普通客户',2)", [tenantId]);
  }
  if (!(await sql.query("SELECT id FROM money_tags WHERE kind='supplier' LIMIT 1")).rows[0]) {
    const names = ['意向客户', '普通客户', '磨具供应商', '刀具供应商', '阀杆供应商', '芯片供应商', '配件供应商'];
    for (const [index, name] of names.entries()) await sql.query("INSERT INTO money_tags(tenant_id,kind,name,sort) VALUES($1,'supplier',$2,$3)", [tenantId, name, index + 1]);
  }
}
async function settings(sql: Sql) {
  return (await sql.query('SELECT * FROM money_settings')).rows[0]!;
}
async function tags(sql: Sql, kind: string) {
  return (await sql.query('SELECT * FROM money_tags WHERE kind=$1 ORDER BY sort,name', [kind])).rows;
}
async function reasons(sql: Sql) {
  return (await sql.query('SELECT * FROM money_end_reasons ORDER BY sort,name')).rows;
}
async function flows(sql: Sql) {
  return legacyCustomerFlows(sql);
}
async function auditOn(sql: Sql, objectType: string) {
  return auditRequired(sql, objectType);
}
async function serial(sql: Sql, tenantId: string, series: string, period: string, width: number) {
  if (series !== 'CGJH' && seriesRuleName[series]) {
    const coded = await allocateByRule(sql, tenantId, seriesRuleName[series]);
    if (coded) return coded;
  }
  await sql.query('INSERT INTO money_counters(tenant_id,series,period,next_value) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING', [tenantId, series, period]);
  const current = BigInt((await sql.query<{ n: string }>('SELECT next_value::text AS n FROM money_counters WHERE series=$1 AND period=$2 FOR UPDATE', [series, period])).rows[0]!.n);
  await sql.query('UPDATE money_counters SET next_value=$1 WHERE series=$2 AND period=$3', [(current + 1n).toString(), series, period]);
  const head = series === 'KH' || series === 'GYS' ? series : series + (period || todayISO().replace(/-/g, ''));
  return head + current.toString().padStart(width, '0');
}
async function engage(sql: Sql, actor: Actor, objectType: string, id: string, approval: string) {
  if (approval === 'pending') await startAudit(sql, actor, objectType, id);
}
async function memberName(sql: Sql, id: string | null) {
  if (!id) return '';
  return (await sql.query<{ display_name: string }>('SELECT display_name FROM tenant_team_members WHERE id=$1', [id])).rows[0]?.display_name ?? '';
}
async function loadProduct(sql: Sql, id: string) {
  const row = (await sql.query<Row>('SELECT p.id,p.code,p.name,p.specification,p.attribute,u.name AS unit_name FROM products p JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id WHERE p.id=$1 AND p.active', [id])).rows[0];
  if (!row) throw new Problem(422, 'INVALID_REFERENCE', '商品不存在、停用或不属于当前企业');
  return { product_id: String(row.id), product_code: String(row.code), product_name: String(row.name), specification: String(row.specification ?? ''), unit_name: String(row.unit_name), source: row.attribute === 'purchased' ? '外购' : '自产', unit_id: '' };
}
async function guardCustomer(sql: Sql, name: string, phone: string, id: string | null) {
  const config = await settings(sql);
  if (name && config.duplicate_name && (await sql.query('SELECT id FROM customers WHERE name=$1 AND id IS DISTINCT FROM $2 LIMIT 1', [name, id])).rows[0]) throw new Problem(409, 'DUPLICATE_NAME', '已存在同名客户，无法录入');
  if (phone && config.unique_phone && (await sql.query('SELECT id FROM customers WHERE contact_phone=$1 AND contact_phone<>\'\' AND id IS DISTINCT FROM $2 LIMIT 1', [phone, id])).rows[0]) throw new Problem(409, 'DUPLICATE_PHONE', '该手机号码已存在，无法录入');
}
async function customerView(sql: Sql, id: string) {
  if (!id) throw new Problem(422, 'REQUIRED', '请选择客户', 'customer_id');
  const row = (await sql.query<Row>('SELECT * FROM customers WHERE id=$1', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '客户不存在');
  return shape(row, { owner_name: await memberName(sql, row.owner_id ? String(row.owner_id) : null), contacts: (await sql.query('SELECT id,name,phone FROM money_contacts WHERE customer_id=$1 ORDER BY name', [id])).rows, addresses: (await sql.query('SELECT id,region,detail FROM money_addresses WHERE customer_id=$1', [id])).rows });
}
async function played(sql: Sql, actor: Actor, command: string, body: Row) {
  const key = typeof body.request_key === 'string' ? body.request_key : '';
  if (!key) return null;
  return await replay(sql, command, key, digest(body)) ?? null;
}
async function remember(sql: Sql, actor: Actor, command: string, body: Row, type: string, id: string) {
  const key = typeof body.request_key === 'string' ? body.request_key : '';
  if (key) await finish(sql, actor, command, key, digest(body), type, id);
}
async function audit(sql: Sql, actor: Actor, type: string, id: string, action: string, opinion: string) {
  await sql.query('INSERT INTO money_audit_logs(tenant_id,object_type,object_id,action,actor_name,opinion) VALUES($1,$2,$3,$4,$5,$6)', [actor.tenant_id, type, id, action, actor.display_name, opinion]);
}
async function log(sql: Sql, actor: Actor, type: string, id: string, message: string) {
  await sql.query('INSERT INTO money_logs(tenant_id,object_type,object_id,message,actor_name) VALUES($1,$2,$3,$4,$5)', [actor.tenant_id, type, id, message, actor.display_name]);
}
async function buildLines(sql: Sql, raw: unknown, formula: string, scale: number) {
  const lines = Array.isArray(raw) ? raw as Row[] : [];
  if (!lines.length) throw new Problem(422, 'LINES_REQUIRED', '请选择商品');
  const built = [];
  for (const [index, line] of lines.entries()) {
    const product = await loadProduct(sql, String(line.product_id ?? ''));
    const quantity = moneyOf(line.quantity, '数量');
    if (cmpMoney(quantity, '0') <= 0) throw new Problem(422, 'QUANTITY_REQUIRED', '数量必须大于零');
    const price = moneyOf(line.unit_price, '单价');
    const amount = lineAmount(formula, price, quantity, scale);
    const discount = moneyOf(line.discount ?? '10', '折扣');
    const concession = moneyOf(line.concession ?? '0', '优惠金额');
    const net = netAmount(amount, discount, concession, scale);
    built.push(shape(product, { line_no: index + 1, unit_price: price, quantity, discount, concession, amount, net_amount: net, note: textOf(line.note, 200, '备注') }));
  }
  return built;
}
async function insertQuotation(sql: Sql, actor: Actor, body: Row) {
  const config = await settings(sql);
  const customer = await customerView(sql, String(body.customer_id ?? ''));
  const contact = textOf(body.contact_name, 80, '联系人', true);
  const salesperson = String(body.salesperson_id ?? '');
  if (!salesperson) throw new Problem(422, 'REQUIRED', '请选择业务员', 'salesperson_id');
  if (!(await memberName(sql, salesperson))) throw new Problem(422, 'INVALID_REFERENCE', '业务员不存在');
  const lines = await buildLines(sql, body.lines, String(config.quote_formula), Number(config.quote_scale));
  const amount = config.auto_calc ? sumMoney(lines.map((line) => line.net_amount)) : positiveMoney(body.amount, '报价金额');
  const qty = sumMoney(lines.map((line) => line.quantity));
  const approval = body.submit === false ? 'draft' : await auditOn(sql, 'quotation') ? 'pending' : 'exempt';
  const code = textOf(body.code, 64, '报价单号') || await serial(sql, actor.tenant_id, 'BJ', todayISO().replace(/-/g, ''), 3);
  const id = (await sql.query<{ id: string }>('INSERT INTO money_quotations(tenant_id,code,customer_id,contact_name,contact_phone,address,amount,qty,delivery_date,quote_date,salesperson_id,note,approval,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id', [actor.tenant_id, code, customer.id, contact, textOf(body.contact_phone, 40, '联系人电话') || customer.contact_phone, textOf(body.address, 200, '客户地址') || customer.address, amount, qty, dayOf(body.delivery_date), dayOf(body.quote_date) ?? todayISO(), salesperson, textOf(body.note, 500, '备注'), approval, actor.user_id])).rows[0]!.id;
  for (const line of lines) await sql.query('INSERT INTO money_quotation_lines(tenant_id,quotation_id,line_no,product_id,product_name,product_code,specification,unit_name,source,unit_price,quantity,discount,concession,amount,net_amount,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)', [actor.tenant_id, id, line.line_no, line.product_id, line.product_name, line.product_code, line.specification, line.unit_name, line.source, line.unit_price, line.quantity, line.discount, line.concession, line.amount, line.net_amount, line.note]);
  await engage(sql, actor, 'quotation', id, approval);
  return id;
}
async function quotationView(sql: Sql, id: string) {
  const row = (await sql.query<Row>('SELECT q.*,c.name AS customer_name,c.code AS customer_code FROM money_quotations q JOIN customers c ON c.tenant_id=q.tenant_id AND c.id=q.customer_id WHERE q.id=$1', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '报价单不存在');
  const lines = (await sql.query<Row>('SELECT *,unit_price::text,quantity::text,discount::text,concession::text,amount::text,net_amount::text FROM money_quotation_lines WHERE quotation_id=$1 ORDER BY line_no', [id])).rows.map(presentLine);
  return shape(row, { amount: numText(row.amount), qty: numText(row.qty), delivery_date: dateText(row.delivery_date), quote_date: dateText(row.quote_date), approval_text: approvalText[String(row.approval)] ?? row.approval, quote_status_text: quoteText[String(row.quote_status)] ?? row.quote_status, signed_text: row.signed ? '已签字' : '未签字', contract_text: row.contract_id ? '已创建' : '未创建', salesperson_name: await memberName(sql, String(row.salesperson_id)), creator_name: await memberName(sql, String(row.created_by)), lines, audits: await audits(sql, 'quotation', id), can_withdraw: await canWithdraw(sql, 'quotation', id, String(row.created_by)) });
}
function presentLine(row: Row) {
  return shape(row, { unit_price: numText(row.unit_price), quantity: numText(row.quantity), discount: numText(row.discount), discount_text: `${numText(row.discount)}折`, concession: numText(row.concession), amount: numText(row.amount), net_amount: numText(row.net_amount) });
}
async function lockQuotation(sql: Sql, id: string, version: number) {
  const row = (await sql.query<Row>('SELECT * FROM money_quotations WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '报价单不存在');
  if (Number(row.version) !== version) throw new Problem(409, 'VERSION_CONFLICT', '数据已修改，请刷新后重试');
  return row;
}
async function allocateUniqueContractCode(sql: Sql, tenantId: string) {
  const period = todayISO().replace(/-/g, '');
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const code = await serial(sql, tenantId, 'HT', period, 3);
    if (!(await sql.query('SELECT 1 FROM money_contracts WHERE code=$1 LIMIT 1', [code])).rows[0]) return code;
  }
  throw new Problem(409, 'DUPLICATE', '自动编号冲突，请手动填写合同编号');
}
async function insertContract(sql: Sql, actor: Actor, body: Row) {
  const config = await settings(sql);
  const customer = await customerView(sql, String(body.customer_id ?? ''));
  const salesperson = String(body.salesperson_id ?? actor.user_id);
  if (!salesperson) throw new Problem(422, 'REQUIRED', '请选择业务员', 'salesperson_id');
  if (!(await memberName(sql, salesperson))) throw new Problem(422, 'INVALID_REFERENCE', '业务员不存在');
  const lines = await buildLines(sql, body.lines, String(config.contract_formula), Number(config.contract_scale));
  const amount = config.auto_calc ? sumMoney(lines.map((line) => line.net_amount)) : positiveMoney(body.amount, '合同金额');
  const qty = sumMoney(lines.map((line) => line.quantity));
  const prepay = moneyOf(body.prepay ?? '0', '预付款');
  if (config.receipt_cap && cmpMoney(prepay, amount) > 0) throw new Problem(422, 'OVER_RECEIPT', '收款金额不能超过欠款');
  const code = textOf(body.code, 64, '合同编号') || await allocateUniqueContractCode(sql, actor.tenant_id);
  const submit = body.submit !== false;
  const approval = submit ? await auditOn(sql, 'contract') ? 'pending' : 'exempt' : 'draft';
  const lifecycle = approval === 'exempt' ? 'performing' : 'inactive';
  const id = (await sql.query<{ id: string }>('INSERT INTO money_contracts(tenant_id,code,customer_id,contact_name,contact_phone,address,prepay,amount,qty,delivery_date,receipt_date,salesperson_id,tax_included,note,approval,lifecycle,approved_at,quotation_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,CASE WHEN $15=\'exempt\' THEN now() ELSE NULL END,$17,$18) RETURNING id', [actor.tenant_id, code, customer.id, textOf(body.contact_name, 80, '联系人'), textOf(body.contact_phone, 40, '联系人电话'), textOf(body.address, 200, '客户地址') || customer.address, prepay, amount, qty, dayOf(body.delivery_date), dayOf(body.receipt_date), salesperson, Boolean(body.tax_included), textOf(body.note, 500, '备注'), approval, lifecycle, body.quotation_id ?? null, actor.user_id])).rows[0]!.id;
  for (const line of lines) await sql.query('INSERT INTO money_contract_lines(tenant_id,contract_id,line_no,product_id,product_name,product_code,specification,unit_name,source,unit_price,quantity,discount,concession,amount,net_amount,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)', [actor.tenant_id, id, line.line_no, line.product_id, line.product_name, line.product_code, line.specification, line.unit_name, line.source, line.unit_price, line.quantity, line.discount, line.concession, line.amount, line.net_amount, line.note]);
  if (cmpMoney(prepay, '0') > 0 && submit) await insertCash(sql, actor, { contract_id: id, customer_id: customer.id, direction: 'in', amount: prepay, note: '预付款', attachment: '', approval: 'exempt', source: 'prepay' });
  await engage(sql, actor, 'contract', id, approval);
  await log(sql, actor, 'contract', id, submit ? '提交审核' : '存为草稿');
  return id;
}
async function applySubmit(sql: Sql, actor: Actor, id: string) {
  const view = await contractView(sql, id);
  const approval = await auditOn(sql, 'contract') ? 'pending' : 'exempt';
  await sql.query("UPDATE money_contracts SET approval=$1,lifecycle=$2,approved_at=CASE WHEN $1='exempt' THEN now() ELSE approved_at END,version=version+1,updated_at=now() WHERE id=$3", [approval, approval === 'exempt' ? 'performing' : 'inactive', id]);
  await engage(sql, actor, 'contract', id, approval);
  if (cmpMoney(view.prepay, '0') > 0 && !(await sql.query("SELECT id FROM money_cash WHERE contract_id=$1 AND source='prepay'", [id])).rows[0]) await insertCash(sql, actor, { contract_id: id, customer_id: view.customer_id, direction: 'in', amount: view.prepay, note: '预付款', attachment: '', approval: 'exempt', source: 'prepay' });
  await log(sql, actor, 'contract', id, '提交审核');
}
async function cashSum(sql: Sql, contractId: string, direction: string, includePending = false) {
  const approvals = includePending ? ['pending', 'approved', 'exempt'] : ['approved', 'exempt'];
  const value = (await sql.query<{ n: string }>('SELECT coalesce(sum(amount),0)::text AS n FROM money_cash WHERE contract_id=$1 AND direction=$2 AND approval = ANY($3::text[])', [contractId, direction, approvals])).rows[0]!.n;
  return numText(value);
}
async function contractView(sql: Sql, id: string) {
  if (!id) throw new Problem(422, 'REQUIRED', '请选择合同', 'contract_id');
  const row = (await sql.query<Row>('SELECT c.*,cu.name AS customer_name,cu.code AS customer_code FROM money_contracts c JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id WHERE c.id=$1', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '合同不存在');
  const lines = (await sql.query<Row>('SELECT *,unit_price::text,quantity::text,discount::text,concession::text,amount::text,net_amount::text FROM money_contract_lines WHERE contract_id=$1 ORDER BY line_no', [id])).rows.map(presentLine);
  for (const line of lines) {
    const scheduled = numText((await sql.query<{ n: string }>("SELECT coalesce(sum(plan_qty),0)::text AS n FROM work_orders WHERE contract_line_id=$1 AND execution<>'cancelled'", [line.id])).rows[0]!.n);
    line.scheduled_qty = scheduled;
    line.produce_progress = progressText(scheduled, String(line.quantity));
  }
  const amount = numText(row.amount);
  const received = await cashSum(sql, id, 'in');
  const spent = await cashSum(sql, id, 'out');
  const invoiced = numText((await sql.query<{ n: string }>("SELECT coalesce(sum(amount),0)::text AS n FROM money_invoices WHERE contract_id=$1 AND status='done'", [id])).rows[0]!.n);
  const salesFee = numText((await sql.query<{ n: string }>("SELECT coalesce(sum(amount),0)::text AS n FROM money_expenses WHERE contract_id=$1 AND approval IN ('approved','exempt')", [id])).rows[0]!.n);
  const debt = contractDebt(amount, received);
  const outbound = await contractOutbound(sql, id);
  const outboundQty = sumMoney(outbound.lines.map((line) => line.shipped_qty));
  const contractQty = sumMoney(outbound.lines.map((line) => line.order_qty));
  return shape(row, { amount, qty: numText(row.qty), prepay: numText(row.prepay), delivery_date: dateText(row.delivery_date), receipt_date: dateText(row.receipt_date), approval_text: approvalText[String(row.approval)] ?? row.approval, lifecycle_text: lifeText[String(row.lifecycle)] ?? row.lifecycle, salesperson_name: await memberName(sql, String(row.salesperson_id)), creator_name: await memberName(sql, String(row.created_by)), received, spent, invoiced, sales_fee: salesFee, debt, receive_progress: progressText(received, amount), outbound_progress: progressText(outboundQty, contractQty), shipment_count: outbound.shipment_count, outbound_complete_date: outbound.outbound_complete_date, lines, can_withdraw: await canWithdraw(sql, 'contract', id, String(row.created_by)) });
}
function summaryOf(items: { amount: string; prepay: string; received: string; spent: string; debt: string; sales_fee: string }[]) {
  return { amount: sumMoney(items.map((item) => item.amount)), prepay: sumMoney(items.map((item) => item.prepay)), received: sumMoney(items.map((item) => item.received)), spent: sumMoney(items.map((item) => item.spent)), debt: sumMoney(items.map((item) => item.debt)), sales_fee: sumMoney(items.map((item) => item.sales_fee)) };
}
async function lockContract(sql: Sql, id: string, version: number) {
  const row = (await sql.query<Row>('SELECT * FROM money_contracts WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '合同不存在');
  if (Number(row.version) !== version) throw new Problem(409, 'VERSION_CONFLICT', '数据已修改，请刷新后重试');
  return row;
}
async function guardReceipt(sql: Sql, contract: { amount: string; received: string; debt: string }, amount: string) {
  if (!(await settings(sql)).receipt_cap) return;
  if (cmpMoney(amount, contract.debt) > 0 || cmpMoney(addMoney(contract.received, amount), contract.amount) > 0) throw new Problem(422, 'OVER_RECEIPT', '收款金额不能超过欠款');
}
async function insertCash(sql: Sql, actor: Actor, input: { contract_id: string | null; customer_id: string; direction: string; amount: string; note: string; attachment: string; approval: string; source: string }) {
  const id = (await sql.query<{ id: string }>('INSERT INTO money_cash(tenant_id,contract_id,customer_id,direction,amount,note,attachment,approval,source,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [actor.tenant_id, input.contract_id, input.customer_id, input.direction, input.amount, input.note, input.attachment, input.approval, input.source, actor.user_id])).rows[0]!.id;
  await engage(sql, actor, 'cash', id, input.approval);
  return id;
}
async function cashView(sql: Sql, id: string) {
  const row = (await sql.query<Row>('SELECT k.*,c.name AS customer_name,ct.code AS contract_code FROM money_cash k JOIN customers c ON c.tenant_id=k.tenant_id AND c.id=k.customer_id LEFT JOIN money_contracts ct ON ct.tenant_id=k.tenant_id AND ct.id=k.contract_id WHERE k.id=$1', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '收支记录不存在');
  return shape(row, { amount: numText(row.amount), direction_text: row.direction === 'in' ? '收入' : '支出', approval_text: approvalText[String(row.approval)] ?? row.approval, can_edit: row.approval === 'rejected', creator_name: await memberName(sql, String(row.created_by)), audits: await audits(sql, 'cash', id) });
}
async function audits(sql: Sql, type: string, id: string) {
  return (await sql.query('SELECT action,actor_name,opinion,created_at FROM money_audit_logs WHERE object_type=$1 AND object_id=$2 ORDER BY created_at', [type, id])).rows.map((row) => (shape(row, { action_text: row.action === 'approve' ? '通过' : row.action === 'reject' ? '退回' : row.action === 'withdraw' ? '撤回' : row.action })));
}
async function contractDetail(sql: Sql, id: string) {
  const contract = await contractView(sql, id);
  const cash = (await sql.query<{ id: string }>('SELECT id FROM money_cash WHERE contract_id=$1 ORDER BY created_at', [id])).rows;
  const productIds = contract.lines.map((line) => line.product_id);
  const linked = (await sql.query('SELECT w.id,w.code,w.plan_qty::text,w.execution,w.created_at,p.name AS product_name,p.code AS product_code FROM work_orders w JOIN products p ON p.tenant_id=w.tenant_id AND p.id=w.product_id WHERE w.contract_id=$1 ORDER BY w.created_at DESC LIMIT 50', [id])).rows;
  const guessed = linked.length || !productIds.length ? [] : (await sql.query('SELECT w.id,w.code,w.plan_qty::text,w.execution,w.created_at,p.name AS product_name,p.code AS product_code FROM work_orders w JOIN products p ON p.tenant_id=w.tenant_id AND p.id=w.product_id JOIN sales_orders s ON s.tenant_id=w.tenant_id AND s.id=w.sales_order_id WHERE w.contract_id IS NULL AND s.customer_id=$1 AND w.product_id = ANY($2::uuid[]) ORDER BY w.created_at DESC LIMIT 50', [contract.customer_id, productIds])).rows;
  const workOrders = linked.length ? linked : guessed;
  const purchases = (await sql.query('SELECT DISTINCT o.id,o.code,s.name AS supplier_name,o.approval,o.created_at FROM purchase_orders o LEFT JOIN suppliers s ON s.tenant_id=o.tenant_id AND s.id=o.supplier_id JOIN money_purchase_line_meta m ON m.tenant_id=o.tenant_id AND m.order_id=o.id WHERE m.contract_id=$1', [id])).rows;
  const shipments = (await sql.query('SELECT sh.id,sh.code,sh.approval,sh.created_at,sh.ship_date FROM shipments sh WHERE sh.contract_id=$1 OR (sh.contract_id IS NULL AND sh.sales_order_id IN (SELECT id FROM sales_orders WHERE customer_id=$2)) ORDER BY sh.created_at DESC LIMIT 50', [id, contract.customer_id])).rows;
  return { contract, cash: await Promise.all(cash.map((row) => cashView(sql, row.id))), invoices: (await invoiceList(sql)).filter((item) => item.contract_id === id), expenses: (await expenseList(sql)).filter((item) => item.contract_id === id), terminations: (await sql.query('SELECT *,received_amount::text,debt_amount::text FROM money_terminations WHERE contract_id=$1 ORDER BY created_at', [id])).rows.map((row) => (shape(row, { received_amount: numText(row.received_amount), debt_amount: numText(row.debt_amount) }))), logs: (await sql.query('SELECT * FROM money_logs WHERE object_type=\'contract\' AND object_id=$1 ORDER BY created_at', [id])).rows, work_orders: workOrders, purchase_orders: purchases, shipments, projects: [] };
}
async function shipmentLines(sql: Sql, customerId: string) {
  if (!customerId) return { items: [], shipped: '-', received: '-', debt: '-' };
  const rows = (await sql.query<Row>(`SELECT sl.id,sh.code AS shipment_code,sh.created_at,sh.ship_date,p.name AS product_name,p.code AS product_code,p.specification,sl.quantity::text,u.name AS unit_name,sl.unit_price::text,sl.amount_cents::text
    FROM shipment_lines sl JOIN shipments sh ON sh.tenant_id=sl.tenant_id AND sh.id=sl.shipment_id
    JOIN products p ON p.tenant_id=sl.tenant_id AND p.id=sl.product_id
    JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
    WHERE sh.approval='approved' AND sh.customer_id=$1
    AND NOT EXISTS (SELECT 1 FROM money_contract_lines cl JOIN money_contracts c ON c.tenant_id=cl.tenant_id AND c.id=cl.contract_id WHERE c.customer_id=$1 AND cl.product_id=sl.product_id AND c.lifecycle<>'terminated')
    ORDER BY sh.created_at DESC LIMIT 100`, [customerId])).rows;
  const items = [];
  for (const row of rows) {
    const amount = money(BigInt(String(row.amount_cents))) ?? '0';
    const received = numText((await sql.query<{ n: string }>("SELECT coalesce(sum((item->>'amount')::numeric),0)::text AS n FROM money_cash k CROSS JOIN jsonb_array_elements(k.allocations) item WHERE k.customer_id=$1 AND k.approval IN ('approved','exempt') AND item->>'shipment_line_id'=$2", [customerId, row.id])).rows[0]!.n);
    items.push({ id: row.id, shipment_code: row.shipment_code, shipped_at: row.ship_date ?? row.created_at, product_name: row.product_name, product_code: row.product_code, specification: row.specification, quantity: numText(row.quantity), unit_name: row.unit_name, unit_price: numText(row.unit_price), amount, received, debt: contractDebt(amount, received) });
  }
  return { items, shipped: sumMoney(items.map((item) => item.amount)), received: sumMoney(items.map((item) => item.received)), debt: sumMoney(items.map((item) => item.debt)) };
}
async function invoiceList(sql: Sql) {
  const rows = (await sql.query<Row>('SELECT i.*,i.amount::text,c.name AS customer_name,ct.code AS contract_code,ct.amount::text AS contract_amount FROM money_invoices i JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id JOIN money_contracts ct ON ct.tenant_id=i.tenant_id AND ct.id=i.contract_id ORDER BY i.created_at DESC')).rows;
  const items = [];
  for (const row of rows) {
    const invoiced = numText((await sql.query<{ n: string }>("SELECT coalesce(sum(amount),0)::text AS n FROM money_invoices WHERE contract_id=$1 AND status='done'", [row.contract_id])).rows[0]!.n);
    items.push(shape(row, { amount: numText(row.amount), contract_amount: numText(row.contract_amount), invoiced_amount: invoiced, status_text: row.status === 'done' ? '开票完毕' : row.status === 'rejected' ? '退回' : '待开票', applicant_name: await memberName(sql, String(row.created_by)), invoicer_name: await memberName(sql, row.invoiced_by ? String(row.invoiced_by) : null) }));
  }
  return items;
}
async function expenseList(sql: Sql) {
  const rows = (await sql.query<Row>('SELECT e.*,e.amount::text,c.name AS customer_name,ct.code AS contract_code FROM money_expenses e JOIN customers c ON c.tenant_id=e.tenant_id AND c.id=e.customer_id LEFT JOIN money_contracts ct ON ct.tenant_id=e.tenant_id AND ct.id=e.contract_id ORDER BY e.created_at DESC')).rows;
  const items = [];
  for (const row of rows) items.push(shape(row, { amount: numText(row.amount), spent_on: dateText(row.spent_on), approval_text: approvalText[String(row.approval)] ?? row.approval, settled_text: row.settled ? '已结算' : '待结算', creator_name: await memberName(sql, String(row.created_by)), audits: await audits(sql, 'expense', String(row.id)) }));
  return items;
}
async function supplierList(sql: Sql, query: Row) {
  const rows = (await sql.query<Row>('SELECT * FROM suppliers ORDER BY created_at DESC LIMIT 300')).rows;
  const items = [];
  for (const row of rows) {
    const view = shape(row, { owner_name: await memberName(sql, row.owner_id ? String(row.owner_id) : null), creator_name: await memberName(sql, String(row.created_by)) });
    const keyword = String(query.q ?? '');
    if (keyword && ![view.code, view.name, view.company_name, view.contact_name, view.contact_phone].some((part) => String(part ?? '').includes(keyword))) continue;
    items.push(view);
  }
  return items;
}
async function saveSupplier(sql: Sql, actor: Actor, body: Row, id: string | null) {
  const name = textOf(body.name, 200, '供应商名称', true);
  const code = textOf(body.code, 64, '供应商编号') || await serial(sql, actor.tenant_id, 'GYS', '', 4);
  const fields = [code, name, textOf(body.company_name, 200, '企业名称'), textOf(body.credit_code, 40, '统一社会信用代码'), body.owner_id ? String(body.owner_id) : actor.user_id, textOf(body.contact_name, 80, '联系人'), textOf(body.contact_phone, 40, '联系人电话'), textOf(body.region, 80, '地区'), textOf(body.address, 200, '详细地址'), tagsOf(body.tags), textOf(body.level, 40, '级别'), textOf(body.remark, 500, '备注')];
  await assertSupplierUnique(sql, actor.tenant_id, id, name, String(fields[6]));
  if (!id) {
    const created = (await sql.query<{ id: string }>('INSERT INTO suppliers(tenant_id,code,name,company_name,credit_code,owner_id,contact_name,contact_phone,region,address,tags,level,remark,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id', [actor.tenant_id, ...fields, actor.user_id])).rows[0]!.id;
    return (await supplierList(sql, {})).find((item) => item.id === created);
  }
  const before = (await sql.query<Row>('SELECT * FROM suppliers WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!before) throw new Problem(404, 'NOT_FOUND', '供应商不存在');
  if (Number(before.version) !== Number(body.version)) throw new Problem(409, 'VERSION_CONFLICT', '供应商已被修改，请刷新');
  await sql.query('UPDATE suppliers SET code=$1,name=$2,company_name=$3,credit_code=$4,owner_id=$5,contact_name=$6,contact_phone=$7,region=$8,address=$9,tags=$10,level=$11,remark=$12,version=version+1 WHERE id=$13', [...fields, id]);
  return (await supplierList(sql, {})).find((item) => item.id === id);
}
async function planList(sql: Sql) {
  const rows = (await sql.query<Row>('SELECT p.*,p.amount::text,p.qty::text,s.name AS supplier_name FROM money_purchase_plans p LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id ORDER BY p.created_at DESC')).rows;
  const items = [];
  for (const row of rows) {
    const lines = (await sql.query<Row>('SELECT *,quantity::text,unit_price::text,amount::text FROM money_purchase_plan_lines WHERE plan_id=$1 ORDER BY line_no', [row.id])).rows.map((line) => (shape(line, { quantity: numText(line.quantity), unit_price: numText(line.unit_price), amount: numText(line.amount) })));
    const ordered = numText((await sql.query<{ n: string }>("SELECT coalesce(sum(l.quantity),0)::text AS n FROM money_purchase_line_meta m JOIN purchase_order_lines l ON l.tenant_id=m.tenant_id AND l.id=m.line_id WHERE m.plan_code=$1", [row.code])).rows[0]!.n);
    items.push(shape(row, { amount: numText(row.amount), qty: numText(row.qty), delivery_date: dateText(row.delivery_date), approval_text: approvalText[String(row.approval)] ?? '不需审核', creator_name: await memberName(sql, String(row.created_by)), purchase_progress: progressText(ordered, numText(row.qty)), lines, overdue_days: overdueDays(dateText(row.delivery_date), cmpMoney(ordered, numText(row.qty)) >= 0) }));
  }
  return items;
}
async function savePlan(sql: Sql, actor: Actor, body: Row, id: string | null) {
  const name = textOf(body.name, 80, '计划名称', true);
  const lines = await buildLines(sql, body.lines, '${合同明细.单价}*${合同明细.销售数量}', 8);
  const amount = sumMoney(lines.map((line) => line.amount));
  const qtyTotal = sumMoney(lines.map((line) => line.quantity));
  const supplierId = body.supplier_id ? String(body.supplier_id) : null;
  const supplierName = supplierId ? String((await sql.query<Row>('SELECT name FROM suppliers WHERE id=$1', [supplierId])).rows[0]?.name ?? '') : '';
  const code = textOf(body.code, 64, '计划编号') || await serial(sql, actor.tenant_id, 'CGJH', todayISO().replace(/-/g, ''), 3);
  const planId = id ?? (await sql.query<{ id: string }>('INSERT INTO money_purchase_plans(tenant_id,code,name,supplier_id,amount,qty,delivery_date,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [actor.tenant_id, code, name, supplierId, amount, qtyTotal, dayOf(body.delivery_date), textOf(body.note, 255, '备注'), actor.user_id])).rows[0]!.id;
  if (id) {
    await sql.query('UPDATE money_purchase_plans SET name=$1,supplier_id=$2,amount=$3,qty=$4,delivery_date=$5,note=$6,version=version+1 WHERE id=$7', [name, supplierId, amount, qtyTotal, dayOf(body.delivery_date), textOf(body.note, 255, '备注'), id]);
    await sql.query('DELETE FROM money_purchase_plan_lines WHERE plan_id=$1', [id]);
  }
  for (const line of lines) await sql.query('INSERT INTO money_purchase_plan_lines(tenant_id,plan_id,line_no,product_id,product_name,product_code,specification,unit_name,supplier_name,quantity,unit_price,amount,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [actor.tenant_id, planId, line.line_no, line.product_id, line.product_name, line.product_code, line.specification, line.unit_name, supplierName, line.quantity, line.unit_price, line.amount, line.note]);
  if (!id && await auditOn(sql, 'purchase_plan')) {
    await sql.query("UPDATE money_purchase_plans SET approval='pending' WHERE id=$1", [planId]);
    await engage(sql, actor, 'purchase_plan', planId, 'pending');
  }
  return (await planList(sql)).find((item) => item.id === planId);
}
function overdueDays(date: string | null, done: boolean) {
  if (!date || done) return 0;
  const today = todayISO();
  if (date >= today) return 0;
  return Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000);
}
async function purchaseList(sql: Sql) {
  const rows = (await sql.query<Row>('SELECT o.*,s.name AS supplier_name FROM purchase_orders o LEFT JOIN suppliers s ON s.tenant_id=o.tenant_id AND s.id=o.supplier_id ORDER BY o.created_at DESC LIMIT 200')).rows;
  const items = [];
  for (const row of rows) items.push(await presentPurchase(sql, row));
  return items;
}
async function purchaseOne(sql: Sql, id: string) {
  const row = (await sql.query<Row>('SELECT o.*,s.name AS supplier_name FROM purchase_orders o LEFT JOIN suppliers s ON s.tenant_id=o.tenant_id AND s.id=o.supplier_id WHERE o.id=$1', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '采购单不存在');
  return presentPurchase(sql, row);
}
async function presentPurchase(sql: Sql, row: Row) {
  const id = String(row.id);
  const lines = (await sql.query<Row>('SELECT l.*,l.quantity::text,l.received_qty::text,l.unit_price::text,l.amount_cents::text,m.plan_code,m.plan_name,m.contract_code,m.contract_id,m.discount::text AS discount,m.concession::text AS concession,m.net_amount::text AS net_amount,m.supplier_name FROM purchase_order_lines l LEFT JOIN money_purchase_line_meta m ON m.line_id=l.id WHERE l.order_id=$1 ORDER BY l.line_no', [id])).rows;
  const qtyTotal = sumMoney(lines.map((line) => numText(line.quantity)));
  const receivedQty = sumMoney(lines.map((line) => numText(line.received_qty)));
  const amount = sumMoney(lines.map((line) => lineAmount('${合同明细.单价}*${合同明细.销售数量}', numText(line.unit_price), numText(line.quantity), 8)));
  const stock = await purchaseStockSummary(sql, id);
  const inbound = stock.inbound_amount;
  const returned = stock.return_amount;
  const paid = numText((await sql.query<{ n: string }>("SELECT coalesce(sum(amount),0)::text AS n FROM money_purchase_payments WHERE order_id=$1 AND approval IN ('approved','exempt')", [id])).rows[0]!.n);
  const invoiced = numText((await sql.query<{ n: string }>('SELECT coalesce(sum(amount),0)::text AS n FROM money_purchase_invoices WHERE order_id=$1', [id])).rows[0]!.n);
  const debt = purchaseDebt(inbound, returned, paid);
  const receiptCount = stock.receipt_count;
  const returnCount = stock.return_count;
  const due = row.due_specified === false ? null : dateText(row.due_date);
  const base = cmpMoney(subMoney(inbound, returned), '0') > 0 ? subMoney(inbound, returned) : amount;
  return shape(row, { supplier_name: String(row.supplier_name ?? ''), amount, qty: qtyTotal, inbound_amount: inbound, return_amount: returned, paid, debt, invoiced,
    inbound_progress: progressText(receivedQty, qtyTotal), pay_progress: progressText(paid, base), invoice_progress: progressText(invoiced, amount),
    due_date: due, order_date: dateText(row.order_date), approval_text: row.money_audit === 'exempt' ? '不需审核' : approvalText[String(row.approval)] ?? row.approval,
    overdue_days: overdueDays(due, cmpMoney(receivedQty, qtyTotal) >= 0), receipt_count: receiptCount, return_count: returnCount,
    buyer_name: await memberName(sql, row.buyer_id ? String(row.buyer_id) : null), creator_name: await memberName(sql, String(row.created_by)),
    lines: lines.map((line) => {
    const quantity = numText(line.quantity);
    const price = numText(line.unit_price);
    const lineAmountText = lineAmount('${合同明细.单价}*${合同明细.销售数量}', price, quantity, 8);
    const received = numText(line.received_qty);
    return { ...line, quantity, received_qty: received, unit_price: price, amount: lineAmountText, discount: numText(line.discount ?? '10'), concession: numText(line.concession ?? '0'), net_amount: line.net_amount == null ? lineAmountText : numText(line.net_amount), product_name: (line.product_snapshot as Row | null)?.name ?? '', product_code: (line.product_snapshot as Row | null)?.code ?? '', specification: (line.product_snapshot as Row | null)?.specification ?? '', inbound_progress: progressText(received, quantity) };
  }),
  });
}
export async function savePurchase(sql: Sql, actor: Actor, body: Row, existingId?: string) {
  const supplierId = String(body.supplier_id ?? '').trim();
  let supplier: Row | null = null;
  if (supplierId) {
    supplier = (await sql.query<Row>('SELECT id,name,active FROM suppliers WHERE id=$1', [supplierId])).rows[0] ?? null;
    if (!supplier || supplier.active === false) throw new Problem(422, 'INVALID_REFERENCE', '供应商不存在或停用', 'supplier_id');
  }
  const rawLines = Array.isArray(body.lines) ? body.lines as Row[] : [];
  if (!rawLines.length) throw new Problem(422, 'LINES_REQUIRED', '请至少添加一条明细', 'lines');
  if (new Set(rawLines.map((line) => line.product_id)).size !== rawLines.length) throw new Problem(422, 'DUPLICATE_LINE', '采购单不可重复产品');
  const orderDate = dayOf(body.order_date) ?? todayISO();
  const due = dayOf(body.delivery_date);
  const code = textOf(body.code, 64, '采购单号') || await serial(sql, actor.tenant_id, 'CG', todayISO().replace(/-/g, ''), 3);
  const inspect = !actor.permissions.includes('quality.write');
  const needsPurchaseAudit = await auditOn(sql, 'purchase_order');
  const approval = needsPurchaseAudit ? 'pending' : 'approved';
  const moneyAudit = needsPurchaseAudit ? 'pending' : 'exempt';
  const header = [code, supplierId || null, orderDate, due ?? orderDate, textOf(body.note, 255, '备注'), body.buyer_id ? String(body.buyer_id) : null, Boolean(due)] as const;
  const id = existingId ?? (await sql.query<{ id: string }>('INSERT INTO purchase_orders(tenant_id,code,supplier_id,order_date,due_date,note,created_by,approval,buyer_id,money_audit,due_specified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [actor.tenant_id, header[0], header[1], header[2], header[3], header[4], actor.user_id, approval, header[5], moneyAudit, header[6]])).rows[0]!.id;
  if (existingId) await sql.query('UPDATE purchase_orders SET code=$1,supplier_id=$2,order_date=$3,due_date=$4,note=$5,buyer_id=$6,due_specified=$7,approval=$8,money_audit=$9,version=version+1 WHERE id=$10', [header[0], header[1], header[2], header[3], header[4], header[5], header[6], approval, moneyAudit, existingId]);
  for (const [index, line] of rawLines.entries()) {
    const product = (await sql.query<Row>('SELECT p.id,p.code,p.name,p.specification,p.unit_id,u.name AS unit_name FROM products p JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id WHERE p.id=$1 AND p.active', [line.product_id])).rows[0];
    if (!product) throw new Problem(422, 'INVALID_REFERENCE', '商品不存在、停用或不属于当前企业');
    const quantity = fitScale(moneyOf(line.quantity, '数量'), 6);
    const price = fitScale(moneyOf(line.unit_price, '单价'), 7);
    if (cmpMoney(quantity, '0') <= 0) throw new Problem(422, 'QUANTITY_REQUIRED', '采购数量必须大于零');
    const cents = lineCents(qty(quantity), price);
    const lineId = (await sql.query<{ id: string }>('INSERT INTO purchase_order_lines(tenant_id,order_id,line_no,product_id,unit_id,quantity,unit_price,amount_cents,requires_inspection,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id', [actor.tenant_id, id, index + 1, product.id, product.unit_id, formatDecimal(qty(quantity)), price, cents.toString(), inspect, JSON.stringify({ id: product.id, code: product.code, name: product.name, specification: product.specification, unit_name: product.unit_name })])).rows[0]!.id;
    const amount = lineAmount('${合同明细.单价}*${合同明细.销售数量}', price, quantity, 8);
    const net = netAmount(amount, moneyOf(line.discount ?? '10', '折扣'), moneyOf(line.concession ?? '0', '优惠金额'), 8);
    await sql.query('INSERT INTO money_purchase_line_meta(line_id,tenant_id,order_id,plan_code,plan_name,contract_id,contract_code,discount,concession,net_amount,supplier_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [lineId, actor.tenant_id, id, textOf(line.plan_code, 64, '计划编号'), textOf(line.plan_name, 80, '计划名称'), line.contract_id ?? null, textOf(line.contract_code, 64, '合同编号'), moneyOf(line.discount ?? '10', '折扣'), moneyOf(line.concession ?? '0', '优惠金额'), net, String(supplier?.name ?? '')]);
  }
  await engage(sql, actor, 'purchase_order', id, needsPurchaseAudit ? 'pending' : 'exempt');
  await log(sql, actor, 'purchase', id, `${existingId ? '修改' : '创建'}采购单${code}`);
  return purchaseOne(sql, id);
}
function fitScale(value: string, scale: number) {
  const [whole, frac = ''] = value.split('.');
  if (!frac) return whole ?? '0';
  const cut = frac.slice(0, scale).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole ?? '0';
}
async function payOrder(sql: Sql, actor: Actor, orderId: string, body: Row) {
  const order = await purchaseOne(sql, orderId);
  const amount = positiveMoney(body.amount, '付款金额');
  if (cmpMoney(order.debt, '0') <= 0) throw new Problem(422, 'NOTHING_TO_PAY', '待付款金额为0，不能付款');
  if (cmpMoney(amount, order.debt) > 0) throw new Problem(422, 'OVER_PAY', '付款金额不能超过待付款金额');
  const needsPayAudit = await auditOn(sql, 'purchase_payment');
  const payId = (await sql.query<{ id: string }>('INSERT INTO money_purchase_payments(tenant_id,order_id,supplier_id,amount,pay_date,note,attachment,approval,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [actor.tenant_id, orderId, order.supplier_id, amount, dayOf(body.pay_date) ?? todayISO(), textOf(body.note, 255, '备注'), textOf(body.attachment, 200, '附件'), needsPayAudit ? 'pending' : 'exempt', actor.user_id])).rows[0]!.id;
  await engage(sql, actor, 'purchase_payment', payId, needsPayAudit ? 'pending' : 'exempt');
  return payId;
}
async function invoiceOrder(sql: Sql, actor: Actor, orderId: string, body: Row) {
  const order = await purchaseOne(sql, orderId);
  const needsInvoiceAudit = await auditOn(sql, 'purchase_invoice');
  const invoiceId = (await sql.query<{ id: string }>('INSERT INTO money_purchase_invoices(tenant_id,order_id,supplier_id,amount,invoice_date,note,attachment,approval,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [actor.tenant_id, orderId, order.supplier_id, positiveMoney(body.amount, '发票金额'), dayOf(body.invoice_date) ?? todayISO(), textOf(body.note, 255, '备注'), textOf(body.attachment, 200, '附件'), needsInvoiceAudit ? 'pending' : 'exempt', actor.user_id])).rows[0]!.id;
  await engage(sql, actor, 'purchase_invoice', invoiceId, needsInvoiceAudit ? 'pending' : 'exempt');
  return invoiceId;
}
async function paymentView(sql: Sql, id: string) {
  const row = (await sql.query<Row>('SELECT p.*,p.amount::text,s.name AS supplier_name,o.code AS order_code FROM money_purchase_payments p JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id JOIN purchase_orders o ON o.tenant_id=p.tenant_id AND o.id=p.order_id WHERE p.id=$1', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '付款记录不存在');
  return shape(row, { amount: numText(row.amount), pay_date: dateText(row.pay_date), approval_text: approvalText[String(row.approval)] ?? row.approval, creator_name: await memberName(sql, String(row.created_by)) });
}
async function paymentList(sql: Sql) {
  const ids = (await sql.query<{ id: string }>('SELECT id FROM money_purchase_payments ORDER BY created_at DESC')).rows;
  return Promise.all(ids.map((row) => paymentView(sql, row.id)));
}
async function purchaseInvoices(sql: Sql) {
  const rows = (await sql.query<Row>('SELECT i.*,i.amount::text,s.name AS supplier_name,o.code AS order_code FROM money_purchase_invoices i JOIN suppliers s ON s.tenant_id=i.tenant_id AND s.id=i.supplier_id JOIN purchase_orders o ON o.tenant_id=i.tenant_id AND o.id=i.order_id ORDER BY i.created_at DESC')).rows;
  const items = [];
  for (const row of rows) items.push(shape(row, { amount: numText(row.amount), invoice_date: dateText(row.invoice_date), approval_text: approvalText[String(row.approval)] ?? '不需审核', creator_name: await memberName(sql, String(row.created_by)) }));
  return items;
}
async function purchaseDetail(sql: Sql, id: string) {
  const order = await purchaseOne(sql, id);
  return { purchase_order: order, payments: (await paymentList(sql)).filter((item) => item.order_id === id), invoices: (await purchaseInvoices(sql)).filter((item) => item.order_id === id), logs: (await sql.query('SELECT * FROM money_logs WHERE object_type=\'purchase\' AND object_id=$1 ORDER BY created_at', [id])).rows };
}
async function remind(sql: Sql, actor: Actor) {
  const config = await settings(sql);
  const today = todayISO();
  const rows = (await sql.query<Row>("SELECT id,code,delivery_date,receipt_date,created_by FROM money_contracts WHERE lifecycle='performing'")).rows;
  let created = 0;
  for (const row of rows) {
    const targets: [string | null, number, string][] = [[dateText(row.delivery_date), Number(config.delivery_remind_days), '交货'], [dateText(row.receipt_date), Number(config.receipt_remind_days), '收款']];
    for (const [date, days, label] of targets) {
      if (!date) continue;
      const left = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
      if (left < 0 || left > days) continue;
      const title = `合同订单${label}即将逾期提醒`;
      const message = `合同${row.code}将于${date}${label}${left === 0 ? '（当天）' : ''}`;
      const inserted = await sql.query('INSERT INTO money_notices(tenant_id,user_id,title,message,dedupe) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id', [actor.tenant_id, row.created_by, title, message, `${label}:${row.id}:${today}`]);
      if (inserted.rows[0]) created++;
    }
  }
  return { created };
}
