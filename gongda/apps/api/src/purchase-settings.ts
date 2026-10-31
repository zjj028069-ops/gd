import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { Problem, type Actor, type Services } from './services.js';
import { bool, decimalText, guarded, idText, intIn, like, oneOf, pageOf, pushMessage, requireVersion, shanghaiTime, text, numText, type Row } from './r10-kit.js';

export type PurchaseSettings = {
  show_supplier_info: boolean; overdue_remind_days: number; refill_basis: 'lower' | 'upper'; refill_percent: string; hide_audit_status: boolean;
  auto_calc: boolean; amount_formula: string; amount_scale: number; inspect_overdue: boolean; supplier_duplicate_name: boolean; supplier_unique_phone: boolean;
  price_rule_mode: 'rule' | 'last' | 'none'; version: number;
};
const columns = 'show_supplier_info,overdue_remind_days,refill_basis,refill_percent::text,hide_audit_status,auto_calc,amount_formula,amount_scale,inspect_overdue,supplier_duplicate_name,supplier_unique_phone,price_rule_mode,version';
const modeText: Record<string, string> = { rule: '价格规则单价', last: '上一次采购单价', none: '不自动带出' };

export async function purchaseSettings(sql: Sql, tenantId: string) {
  await sql.query('INSERT INTO purchase_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId]);
  const row = (await sql.query<PurchaseSettings>(`SELECT ${columns} FROM purchase_settings`)).rows[0]!;
  return { ...row, refill_percent: numText(row.refill_percent) };
}

/** 供应商新增/修改时按供应商设置校验重名和手机号。 */
export async function assertSupplierUnique(sql: Sql, tenantId: string, id: string | null, name: string, phone: string) {
  const config = await purchaseSettings(sql, tenantId);
  if (config.supplier_duplicate_name && (await sql.query('SELECT 1 FROM suppliers WHERE name=$1 AND ($2::uuid IS NULL OR id<>$2::uuid) LIMIT 1', [name, id])).rows[0]) {
    throw new Problem(409, 'SUPPLIER_NAME_DUPLICATE', '供应商名称已存在');
  }
  if (config.supplier_unique_phone && phone && (await sql.query('SELECT 1 FROM suppliers WHERE contact_phone=$1 AND ($2::uuid IS NULL OR id<>$2::uuid) LIMIT 1', [phone, id])).rows[0]) {
    throw new Problem(409, 'SUPPLIER_PHONE_DUPLICATE', '供应商手机号已存在');
  }
}

function shanghaiNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

/** 采购即将逾期提醒：每天 9 点后首次拉取消息时补发，给创建人和采购人各写一条，同一天只发一次。 */
export async function syncPurchaseReminders(sql: Sql, actor: Pick<Actor, 'tenant_id'>) {
  const config = await purchaseSettings(sql, actor.tenant_id);
  if (config.overdue_remind_days <= 0) return 0;
  const now = shanghaiNow();
  if (now.hour < 9) return 0;
  const orders = (await sql.query<{ id: string; code: string; due: string; created_by: string; buyer_id: string | null }>(
    `SELECT o.id,o.code,to_char(o.due_date,'YYYY-MM-DD') AS due,o.created_by,o.buyer_id FROM purchase_orders o
     WHERE o.lifecycle='open' AND o.due_specified AND o.due_date BETWEEN $1::date AND $1::date + $2::integer`, [now.day, config.overdue_remind_days])).rows;
  const plans = (await sql.query<{ id: string; code: string; due: string; created_by: string }>(
    `SELECT p.id,p.code,to_char(p.delivery_date,'YYYY-MM-DD') AS due,p.created_by FROM money_purchase_plans p
     WHERE p.delivery_date BETWEEN $1::date AND $1::date + $2::integer`, [now.day, config.overdue_remind_days])).rows;
  let sent = 0;
  const notify = async (kind: string, id: string, code: string, due: string, users: (string | null)[], link: string) => {
    for (const userId of new Set(users.filter((value): value is string => Boolean(value)))) {
      const member = (await sql.query('SELECT 1 FROM tenant_team_members WHERE id=$1', [userId])).rows[0];
      if (!member) continue;
      if (await pushMessage(sql, actor.tenant_id, userId, { kind: 'notice', title: `${kind}即将逾期提醒`, body: `${kind}${code}将于${due}到交货日期，请及时跟进`, objectType: kind === '采购单' ? 'purchase_order' : 'purchase_plan', objectId: id, docCode: code, linkPath: link, dedupeKey: `purchase-due:${id}:${userId}:${now.day}` })) sent += 1;
    }
  };
  for (const row of orders) await notify('采购单', row.id, row.code, row.due, [row.created_by, row.buyer_id], '/purchase_bill/list');
  for (const row of plans) await notify('采购计划', row.id, row.code, row.due, [row.created_by], '/purchase_plan/list');
  return sent;
}

/** 历史采购价（只取已审采购单）。 */
export async function historyPrices(sql: Sql, supplierId: string, productId: string) {
  const row = (await sql.query<{ last: string | null; avg: string | null; max: string | null; min: string | null }>(
    `SELECT (SELECT l2.unit_price::text FROM purchase_order_lines l2 JOIN purchase_orders o2 ON o2.tenant_id=l2.tenant_id AND o2.id=l2.order_id
              WHERE o2.supplier_id=$1 AND l2.product_id=$2 AND o2.approval='approved' ORDER BY o2.order_date DESC,o2.created_at DESC,l2.line_no DESC LIMIT 1) AS last,
            round(avg(l.unit_price),7)::text AS avg, max(l.unit_price)::text AS max, min(l.unit_price)::text AS min
     FROM purchase_order_lines l JOIN purchase_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id
     WHERE o.supplier_id=$1 AND l.product_id=$2 AND o.approval='approved'`, [supplierId, productId])).rows[0];
  const show = (value: string | null | undefined) => (value === null || value === undefined ? '-' : numText(value));
  return { last_price: show(row?.last), avg_price: show(row?.avg), max_price: show(row?.max), min_price: show(row?.min), last_raw: row?.last ?? null };
}

export function registerPurchaseSettings(app: FastifyInstance, services: Services) {
  const read = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => guarded(services, request, 'procurement.read', false, work);
  const write = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => guarded(services, request, 'procurement.write', true, work);

  app.get('/api/purchase/settings', (request) => read(request, async (sql, actor) => ({ settings: await purchaseSettings(sql, actor.tenant_id) })));
  app.put('/api/purchase/settings', (request) => write(request, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const before = await purchaseSettings(sql, actor.tenant_id);
    requireVersion(before, body.version, '采购设置');
    const formula = text(body.amount_formula ?? before.amount_formula, 500, '计算公式', true);
    if (!formula.includes('${明细.采购单价}') && !formula.includes('${明细.采购数量}')) throw new Problem(422, 'FORMULA', '计算公式至少要引用采购单价或采购数量');
    const row = (await sql.query<PurchaseSettings>(`UPDATE purchase_settings SET show_supplier_info=$1,overdue_remind_days=$2,refill_basis=$3,refill_percent=$4,hide_audit_status=$5,auto_calc=$6,amount_formula=$7,amount_scale=$8,inspect_overdue=$9,version=version+1,updated_at=now() RETURNING ${columns}`, [
      bool(body.show_supplier_info, before.show_supplier_info), intIn(body.overdue_remind_days, 0, 365, '即将逾期提醒天数', before.overdue_remind_days),
      oneOf(body.refill_basis, ['lower', 'upper'] as const, '默认补至', before.refill_basis), decimalText(body.refill_percent ?? before.refill_percent, '补至百分比', 2),
      bool(body.hide_audit_status, before.hide_audit_status), bool(body.auto_calc, before.auto_calc), formula, intIn(body.amount_scale, 0, 8, '小数位数', before.amount_scale), bool(body.inspect_overdue, before.inspect_overdue),
    ])).rows[0]!;
    return { settings: { ...row, refill_percent: numText(row.refill_percent) } };
  }));

  app.get('/api/purchase/supplier-settings', (request) => read(request, async (sql, actor) => {
    const config = await purchaseSettings(sql, actor.tenant_id);
    return { settings: { supplier_duplicate_name: config.supplier_duplicate_name, supplier_unique_phone: config.supplier_unique_phone, version: config.version } };
  }));
  app.put('/api/purchase/supplier-settings', (request) => write(request, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const before = await purchaseSettings(sql, actor.tenant_id);
    requireVersion(before, body.version, '供应商设置');
    const row = (await sql.query('UPDATE purchase_settings SET supplier_duplicate_name=$1,supplier_unique_phone=$2,version=version+1,updated_at=now() RETURNING supplier_duplicate_name,supplier_unique_phone,version', [bool(body.supplier_duplicate_name, before.supplier_duplicate_name), bool(body.supplier_unique_phone, before.supplier_unique_phone)])).rows[0];
    return { settings: row };
  }));

  app.get('/api/purchase/supplier-info', (request) => read(request, async (sql, actor) => {
    const supplierId = idText((request.query as Row).supplier_id, '供应商', true);
    const config = await purchaseSettings(sql, actor.tenant_id);
    const row = (await sql.query<{ contact_name: string; contact_phone: string; region: string; address: string }>('SELECT contact_name,contact_phone,region,address FROM suppliers WHERE id=$1', [supplierId])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '供应商不存在');
    return { show: config.show_supplier_info, supplier: { contact_name: row.contact_name || '-', contact_phone: row.contact_phone || '-', address: [row.region, row.address].filter(Boolean).join(' ') || '-' } };
  }));

  app.get('/api/purchase/price-rules', (request) => read(request, async (sql) => {
    const query = (request.query ?? {}) as Row;
    const { size, offset, page } = pageOf(query);
    const params: unknown[] = [];
    const where = ['true'];
    const add = (clause: (n: string) => string, value: unknown) => { if (value === null || value === undefined || value === '') return; params.push(value); where.push(clause(`$${params.length}`)); };
    add((n) => `(s.name ILIKE ${n} OR p.code ILIKE ${n} OR p.name ILIKE ${n} OR p.specification ILIKE ${n})`, like(query.keyword));
    add((n) => `r.supplier_id=${n}::uuid`, idText(query.supplier_id, '供应商'));
    add((n) => `p.name ILIKE ${n}`, like(query.product_name));
    add((n) => `p.code ILIKE ${n}`, like(query.product_code));
    add((n) => `p.specification ILIKE ${n}`, like(query.specification));
    const from = `FROM purchase_price_rules r JOIN suppliers s ON s.tenant_id=r.tenant_id AND s.id=r.supplier_id JOIN products p ON p.tenant_id=r.tenant_id AND p.id=r.product_id LEFT JOIN tenant_team_members m ON m.id=r.created_by WHERE ${where.join(' AND ')}`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, params)).rows[0]!.n);
    const rows = (await sql.query<Row>(`SELECT r.id,r.supplier_id,s.name AS supplier_name,r.product_id,p.code AS product_code,p.name AS product_name,coalesce(nullif(p.specification,''),'-') AS specification,r.unit_price::text,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('r.created_at')} AS created_text
      ${from} ORDER BY r.created_at DESC,r.id LIMIT ${size} OFFSET ${offset}`, params)).rows;
    const items = [];
    for (const row of rows) {
      const history = await historyPrices(sql, String(row.supplier_id), String(row.product_id));
      items.push({ ...row, unit_price: numText(row.unit_price), last_price: history.last_price, avg_price: history.avg_price, max_price: history.max_price, min_price: history.min_price });
    }
    return { total, page, page_size: size, items };
  }));

  app.post('/api/purchase/price-rules', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const supplierId = idText(body.supplier_id, '供应商', true);
    const productId = idText(body.product_id, '商品', true);
    const price = decimalText(body.unit_price, '单价', 7);
    if (!(await sql.query('SELECT 1 FROM suppliers WHERE id=$1', [supplierId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '供应商不存在或不属于当前企业');
    if (!(await sql.query('SELECT 1 FROM products WHERE id=$1', [productId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '商品不存在或不属于当前企业');
    const row = (await sql.query<{ id: string }>('INSERT INTO purchase_price_rules(tenant_id,supplier_id,product_id,unit_price,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,supplier_id,product_id) DO NOTHING RETURNING id', [actor.tenant_id, supplierId, productId, price, actor.user_id])).rows[0];
    if (!row) throw new Problem(409, 'PRICE_RULE_DUPLICATE', '该供应商的这个商品已有价格规则，请直接修改');
    return { id: row.id };
  })));
  app.put<{ Params: { id: string } }>('/api/purchase/price-rules/:id', (request) => write(request, async (sql) => {
    const price = decimalText(((request.body ?? {}) as Row).unit_price, '单价', 7);
    if (!(await sql.query('UPDATE purchase_price_rules SET unit_price=$1,updated_at=now() WHERE id=$2 RETURNING id', [price, idText(request.params.id, '价格规则', true)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '价格规则不存在');
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/purchase/price-rules/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM purchase_price_rules WHERE id=$1 RETURNING id', [idText(request.params.id, '价格规则', true)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '价格规则不存在');
    return { ok: true };
  }));

  app.get('/api/purchase/price-rule-mode', (request) => read(request, async (sql, actor) => {
    const config = await purchaseSettings(sql, actor.tenant_id);
    return { mode: config.price_rule_mode, mode_text: modeText[config.price_rule_mode], options: Object.entries(modeText).map(([value, label]) => ({ value, label })), version: config.version };
  }));
  app.put('/api/purchase/price-rule-mode', (request) => write(request, async (sql, actor) => {
    await purchaseSettings(sql, actor.tenant_id);
    const mode = oneOf(((request.body ?? {}) as Row).mode, ['rule', 'last', 'none'] as const, '采购单默认单价');
    await sql.query('UPDATE purchase_settings SET price_rule_mode=$1,version=version+1,updated_at=now()', [mode]);
    return { mode, mode_text: modeText[mode] };
  }));

  /** 采购单新增选了供应商和商品后按价格规则带出单价。 */
  app.get('/api/purchase/default-price', (request) => read(request, async (sql, actor) => {
    const query = (request.query ?? {}) as Row;
    const supplierId = idText(query.supplier_id, '供应商', true)!;
    const productId = idText(query.product_id, '商品', true)!;
    const config = await purchaseSettings(sql, actor.tenant_id);
    if (config.price_rule_mode === 'none') return { unit_price: null, source: 'none' };
    if (config.price_rule_mode === 'rule') {
      const rule = (await sql.query<{ unit_price: string }>('SELECT unit_price::text FROM purchase_price_rules WHERE supplier_id=$1 AND product_id=$2', [supplierId, productId])).rows[0];
      if (rule) return { unit_price: numText(rule.unit_price), source: 'rule' };
    }
    const history = await historyPrices(sql, supplierId, productId);
    return history.last_raw === null ? { unit_price: null, source: 'none' } : { unit_price: numText(history.last_raw), source: 'last' };
  }));
}
