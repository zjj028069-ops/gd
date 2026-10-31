import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { contractDebt, subMoney, sumMoney } from './money-calc.js';
import { contractOutbound } from './warehouse-stock.js';
import { savePurchase } from './money.js';
import { costShareByWorkOrder } from './produce-extra.js';
import { q, qtyText, receivedQtySql } from './progress-calc.js';
import { historyPrices, purchaseSettings } from './purchase-settings.js';
import { num, periodRange, shanghaiToday } from './round8-kit.js';
import { Problem, type Actor, type Services } from './services.js';
import { dateText, guarded, idList, idText, like, oneOf, requireVersion, text, type Row } from './r10-kit.js';

const percent = (part: number, whole: number) => whole ? ((part / whole) * 100).toFixed(2) : '-';
const sourceOf = (row: Row) => String(row.source || (row.attribute === 'purchased' ? '外购' : row.attribute === 'outsourced' ? '外协加工' : '自产'));

function rangeOf(query: Row, fallback: string) {
  const from = dateText(query.from, '开始日期');
  const to = dateText(query.to, '结束日期');
  if (from && to) {
    if (from > to) throw new Problem(422, 'INVALID_RANGE', '开始日期不能晚于结束日期');
    return { from, to };
  }
  return periodRange(String(query.period || fallback));
}

function paged<T>(items: T[], query: Row) {
  if (query.page === undefined) return { total: items.length, items };
  const page = Math.max(1, Number.parseInt(String(query.page), 10) || 1);
  const size = Math.min(200, Math.max(1, Number.parseInt(String(query.page_size ?? 30), 10) || 30));
  return { total: items.length, page, page_size: size, items: items.slice((page - 1) * size, page * size) };
}

function filters() {
  const params: unknown[] = [];
  const where: string[] = ['true'];
  const add = (clause: (n: string) => string, value: unknown) => {
    if (value === null || value === undefined || value === '') return;
    params.push(value);
    where.push(clause(`$${params.length}`));
  };
  return { params, where, add, sql: () => where.join(' AND ') };
}

function monthShift(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** AI库存监控（规则预测，不接大模型）：期初 + 在途采购 + 未完工加工单 − 近三月出库 3:2:1 加权。 */
export async function aiInventory(sql: Sql, tenantId: string) {
  const month = shanghaiToday().slice(0, 7);
  const monthStart = `${month}-01`;
  const settings = await purchaseSettings(sql, tenantId);
  const products = (await sql.query<Row>(`SELECT p.id,p.code,p.name,coalesce(p.specification,'') AS specification,p.source,p.attribute,coalesce(c.name,'') AS category_name,
      p.stock_lower_warn::text AS lower_warn,p.stock_upper_warn::text AS upper_warn,p.default_supplier_id,
      coalesce((SELECT sum(CASE WHEN l.direction='in' THEN l.quantity ELSE -l.quantity END) FROM stock_ledger l WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND l.posted_at < ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')),0)::text AS opening,
      coalesce((SELECT sum(pl.quantity-pl.received_qty) FROM purchase_order_lines pl JOIN purchase_orders o ON o.tenant_id=pl.tenant_id AND o.id=pl.order_id WHERE pl.product_id=p.id AND o.lifecycle='open' AND o.approval IN ('pending','approved')),0)::text AS in_transit,
      coalesce((SELECT sum(greatest(w.plan_qty-${receivedQtySql('w.id')},0)) FROM work_orders w WHERE w.product_id=p.id AND w.execution NOT IN ('completed','cancelled')),0)::text AS wip,
      a.purchase_order_id,po.code AS purchase_order_code
    FROM products p LEFT JOIN product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
    LEFT JOIN ai_inventory_orders a ON a.tenant_id=p.tenant_id AND a.product_id=p.id AND a.period=$2
    LEFT JOIN purchase_orders po ON po.tenant_id=a.tenant_id AND po.id=a.purchase_order_id
    WHERE p.active ORDER BY p.code`, [monthStart, month])).rows;
  const firstMonth = monthShift(month, -6);
  const outs = (await sql.query<{ product_id: string; month: string; qty: string }>(`SELECT product_id,to_char(posted_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month,sum(quantity)::text AS qty
    FROM stock_ledger WHERE direction='out' AND posted_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND posted_at < ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') GROUP BY 1,2`, [`${firstMonth}-01`, monthStart])).rows;
  const outMap = new Map(outs.map((row) => [`${row.product_id}:${row.month}`, q(row.qty)]));
  const months = Array.from({ length: 6 }, (_, index) => monthShift(month, index - 6));
  const refillPercent = q(settings.refill_percent);
  const items = products.map((row) => {
    const out = (m: string) => outMap.get(`${row.id}:${m}`) ?? 0n;
    const [m1, m2, m3] = [out(monthShift(month, -1)), out(monthShift(month, -2)), out(monthShift(month, -3))];
    const forecastOut = (m1 * 3n + m2 * 2n + m3) / 6n;
    const opening = q(String(row.opening));
    const forecast = opening + q(String(row.in_transit)) + q(String(row.wip)) - forecastOut;
    const lower = row.lower_warn === null ? null : q(String(row.lower_warn));
    const upper = row.upper_warn === null ? null : q(String(row.upper_warn));
    const flags: string[] = [];
    if (lower !== null && forecast < lower) flags.push('low');
    if (upper !== null && forecast > upper) flags.push('high');
    if (m3 < m2 && m2 < m1) flags.push('rising');
    const basis = settings.refill_basis === 'upper' ? upper : lower;
    const target = basis === null ? null : (basis * refillPercent) / 100_000_000n;
    const advice = target !== null && target > forecast ? target - forecast : 0n;
    return {
      id: String(row.id), product_id: String(row.id), product_name: String(row.name), product_code: String(row.code), specification: String(row.specification), source: sourceOf(row), category_name: String(row.category_name),
      default_supplier_id: row.default_supplier_id, lower_warn: lower === null ? '-' : qtyText(lower), upper_warn: upper === null ? '-' : qtyText(upper),
      opening_qty: qtyText(opening), in_transit_qty: qtyText(q(String(row.in_transit))), wip_qty: qtyText(q(String(row.wip))), forecast_out_qty: qtyText(forecastOut),
      forecast_qty: qtyText(forecast), advice_qty: qtyText(advice), flags,
      purchase_order_id: row.purchase_order_id ?? null, purchase_order_code: row.purchase_order_code ?? '',
      monthly: [...months.map((m) => ({ month: m, out_qty: qtyText(out(m)) })), { month, out_qty: qtyText(forecastOut), forecast: true }],
    };
  });
  return { month, settings, items };
}

type InventoryItem = Awaited<ReturnType<typeof aiInventory>>['items'][number];

const smartSources = {
  work_orders: {
    label: '加工单',
    dimensions: { product: ['商品', "coalesce(w.product_snapshot->>'name','-')"], execution: ['生产状态', "CASE w.execution WHEN 'not_started' THEN '未开始' WHEN 'running' THEN '生产中' WHEN 'paused' THEN '已暂停' WHEN 'completed' THEN '已完成' ELSE '已取消' END"], project: ['项目', "coalesce(pj.name,'无项目')"], day: ['创建日期', "to_char(w.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')"] },
    metrics: { count: ['加工单数', 'count(*)'], plan_qty: ['计划数', 'sum(w.plan_qty)'] },
    from: 'FROM work_orders w LEFT JOIN production_projects pj ON pj.tenant_id=w.tenant_id AND pj.id=w.project_id',
    time: 'w.created_at',
  },
  production_reports: {
    label: '报工记录',
    dimensions: { process: ['工序', "coalesce(t.process_snapshot->>'name','-')"], operator: ['生产人员', "coalesce(op.display_name,'-')"], product: ['商品', "coalesce(w.product_snapshot->>'name','-')"], day: ['报工日期', "to_char(r.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')"] },
    metrics: { good_qty: ['良品数', 'sum(r.good_qty)'], defect_qty: ['不良品数', 'sum(r.defect_qty)'], report_qty: ['报工数', 'sum(r.good_qty+r.defect_qty)'], wage: ['工资(元)', "sum(coalesce((r.wage_snapshot->>'amount_cents')::numeric,0))/100"] },
    from: "FROM production_reports r JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id JOIN work_orders w ON w.tenant_id=r.tenant_id AND w.id=r.work_order_id LEFT JOIN tenant_team_members op ON op.id=r.operator_id",
    time: 'r.created_at',
    extra: "r.approval='approved'",
  },
  contracts: {
    label: '合同订单',
    dimensions: { customer: ['客户', "coalesce(cu.name,'-')"], salesperson: ['销售员', "coalesce(sp.display_name,'-')"], day: ['签订日期', "to_char(c.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')"] },
    metrics: { count: ['合同数', 'count(*)'], amount: ['合同金额', 'sum(c.amount)'], qty: ['销售数量', 'sum(c.qty)'] },
    from: 'FROM money_contracts c LEFT JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id LEFT JOIN tenant_team_members sp ON sp.id=c.salesperson_id',
    time: 'c.created_at',
    extra: "c.approval IN ('approved','exempt')",
  },
  stock_ledger: {
    label: '出入库流水',
    dimensions: { product: ['商品', "coalesce(p.name,'-')"], warehouse: ['仓库', "coalesce(wh.name,'-')"], direction: ['出入库', "CASE l.direction WHEN 'in' THEN '入库' ELSE '出库' END"], day: ['日期', "to_char(l.posted_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')"] },
    metrics: { in_qty: ['入库数量', "coalesce(sum(l.quantity) FILTER (WHERE l.direction='in'),0)"], out_qty: ['出库数量', "coalesce(sum(l.quantity) FILTER (WHERE l.direction='out'),0)"], count: ['流水笔数', 'count(*)'] },
    from: 'FROM stock_ledger l LEFT JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id LEFT JOIN warehouses wh ON wh.tenant_id=l.tenant_id AND wh.id=l.warehouse_id',
    time: 'l.posted_at',
  },
} as const satisfies Record<string, { label: string; dimensions: Record<string, readonly [string, string]>; metrics: Record<string, readonly [string, string]>; from: string; time: string; extra?: string }>;
type SmartSource = keyof typeof smartSources;
const smartPeriods = ['今天', '昨天', '本周', '本月', '本季度', '本年'] as const;
const briefKinds = ['sales', 'production', 'custom'] as const;
const briefCards = [
  { key: 'sales', title: '销售简报', description: '汇总本期合同额、收款、欠款和出库情况，掌握销售动态' },
  { key: 'production', title: '生产简报', description: '汇总本期加工单、完工、报工良品、不良率和工资，掌握生产进度' },
  { key: 'custom', title: '自定义智能报表', description: '自由选择数据源、维度和指标，生成专属报表' },
];
const outputMetricKeys = ['good_qty', 'defect_qty', 'report_qty', 'good_rate'] as const;
const wipMetricKeys = ['plan_qty', 'good_qty', 'defect_qty', 'pending_qty'] as const;
const salesStatKeys = ['contracts', 'qty', 'outbound', 'unoutbound', 'amount', 'received', 'debt', 'invoiced', 'uninvoiced', 'debt_count', 'clear_count', 'returned', 'refund'] as const;

function smartInput(body: Row) {
  const source = oneOf(body.source, Object.keys(smartSources) as SmartSource[], '数据源');
  const config = smartSources[source];
  const dimension = oneOf(body.dimension, Object.keys(config.dimensions), '维度');
  const metric = oneOf(body.metric, Object.keys(config.metrics), '指标');
  return { name: text(body.name, 60, '报表名称', true), source, dimension, metric, period: oneOf(body.period, smartPeriods, '统计时间', '本月') };
}

export async function runSmartReport(sql: Sql, report: { source: string; dimension: string; metric: string; period: string }, range = periodRange(report.period)) {
  const config = smartSources[report.source as SmartSource];
  if (!config) throw new Problem(422, 'INVALID_OPTION', '数据源不存在');
  const dimension = (config.dimensions as Record<string, readonly [string, string]>)[report.dimension];
  const metric = (config.metrics as Record<string, readonly [string, string]>)[report.metric];
  if (!dimension || !metric) throw new Problem(422, 'INVALID_OPTION', '维度或指标不存在');
  const extra = 'extra' in config ? ` AND ${config.extra}` : '';
  const rows = (await sql.query<{ label: string; value: string }>(`SELECT ${dimension[1]} AS label,(${metric[1]})::text AS value ${config.from}
    WHERE (${config.time} AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date${extra} GROUP BY 1 ORDER BY 2 DESC NULLS LAST,1 LIMIT 100`, [range.from, range.to])).rows;
  const items = rows.map((row) => ({ label: row.label, value: num(Number(row.value).toFixed(2).replace(/\.?0+$/, '') || '0') }));
  return { range, source_text: config.label, dimension_text: dimension[0], metric_text: metric[0], columns: [dimension[0], metric[0]], items, chart: { categories: items.map((item) => item.label), values: items.map((item) => Number(item.value)) } };
}

async function salesBrief(sql: Sql, range: { from: string; to: string }) {
  const between = "BETWEEN $1::date AND $2::date";
  const contract = (await sql.query<{ n: string; amount: string; qty: string }>(`SELECT count(*)::text AS n,coalesce(sum(amount),0)::text AS amount,coalesce(sum(qty),0)::text AS qty FROM money_contracts WHERE approval IN ('approved','exempt') AND (created_at AT TIME ZONE 'Asia/Shanghai')::date ${between}`, [range.from, range.to])).rows[0]!;
  const received = (await sql.query<{ n: string }>(`SELECT coalesce(sum(amount),0)::text AS n FROM money_cash WHERE direction='in' AND approval IN ('approved','exempt') AND (created_at AT TIME ZONE 'Asia/Shanghai')::date ${between}`, [range.from, range.to])).rows[0]!.n;
  const totals = (await sql.query<{ amount: string; received: string }>("SELECT coalesce((SELECT sum(amount) FROM money_contracts WHERE approval IN ('approved','exempt') AND lifecycle<>'terminated'),0)::text AS amount,coalesce((SELECT sum(m.amount) FROM money_cash m JOIN money_contracts c ON c.tenant_id=m.tenant_id AND c.id=m.contract_id WHERE m.direction='in' AND m.approval IN ('approved','exempt') AND c.approval IN ('approved','exempt') AND c.lifecycle<>'terminated'),0)::text AS received")).rows[0]!;
  const outbound = (await sql.query<{ n: string }>(`SELECT coalesce(sum(quantity),0)::text AS n FROM stock_ledger WHERE direction='out' AND source_type='shipment' AND (posted_at AT TIME ZONE 'Asia/Shanghai')::date ${between}`, [range.from, range.to])).rows[0]!.n;
  return {
    range, title: '销售简报',
    metrics: [
      { key: 'contracts', label: '合同数', value: contract.n },
      { key: 'amount', label: '合同额(元)', value: num(contract.amount) },
      { key: 'qty', label: '销售数量', value: num(contract.qty) },
      { key: 'received', label: '收款(元)', value: num(received) },
      { key: 'debt', label: '累计欠款(元)', value: contractDebt(num(totals.amount), num(totals.received)) },
      { key: 'outbound', label: '出库数量', value: num(outbound) },
    ],
    chart: await runSmartReport(sql, { source: 'contracts', dimension: 'customer', metric: 'amount', period: '' }, range),
  };
}

async function productionBrief(sql: Sql, range: { from: string; to: string }) {
  const between = "BETWEEN $1::date AND $2::date";
  const orders = (await sql.query<{ n: string; done: string }>(`SELECT count(*)::text AS n,count(*) FILTER (WHERE execution='completed')::text AS done FROM work_orders WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date ${between}`, [range.from, range.to])).rows[0]!;
  const reports = (await sql.query<{ good: string; defect: string; cents: string }>(`SELECT coalesce(sum(good_qty),0)::text AS good,coalesce(sum(defect_qty),0)::text AS defect,coalesce(sum(coalesce((wage_snapshot->>'amount_cents')::numeric,0)),0)::text AS cents FROM production_reports WHERE approval='approved' AND (created_at AT TIME ZONE 'Asia/Shanghai')::date ${between}`, [range.from, range.to])).rows[0]!;
  const good = Number(reports.good);
  const defect = Number(reports.defect);
  return {
    range, title: '生产简报',
    metrics: [
      { key: 'orders', label: '加工单数', value: orders.n },
      { key: 'completed', label: '完成数', value: orders.done },
      { key: 'good_qty', label: '报工良品数', value: num(reports.good) },
      { key: 'defect_qty', label: '不良品数', value: num(reports.defect) },
      { key: 'defect_rate', label: '不良率(%)', value: percent(defect, good + defect) },
      { key: 'wage', label: '工资(元)', value: (Number(reports.cents) / 100).toFixed(2) },
    ],
    chart: await runSmartReport(sql, { source: 'production_reports', dimension: 'process', metric: 'good_qty', period: '' }, range),
  };
}

async function reportPrefs(sql: Sql, tenantId: string) {
  await sql.query('INSERT INTO tenant_report_prefs(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId]);
  return (await sql.query<Row>('SELECT output_metrics,wip_metrics,wip_process_ids,sales_stat_items,push_settings,version FROM tenant_report_prefs')).rows[0]!;
}

function keyList<T extends string>(value: unknown, options: readonly T[], label: string) {
  if (!Array.isArray(value)) throw new Problem(422, 'INVALID_LIST', `${label}格式不正确`);
  return [...new Set(value.map((item) => oneOf(item, options, label)))];
}

function pushRows(value: unknown, memberIds: Set<string>) {
  if (!Array.isArray(value)) throw new Problem(422, 'INVALID_LIST', '推送设置格式不正确');
  const seen = new Set<string>();
  return value.map((raw) => {
    const row = (raw ?? {}) as Row;
    const kind = oneOf(row.kind, briefKinds, '简报');
    if (seen.has(kind)) throw new Problem(422, 'DUPLICATE_LINE', '同一个简报只能设置一行');
    seen.add(kind);
    const time = text(row.time, 5, '推送时间') || '09:00';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Problem(422, 'INVALID_TIME', '推送时间格式为HH:mm');
    const receivers = idList(row.receiver_ids, '接收人', 100);
    if (receivers.some((id) => !memberIds.has(id))) throw new Problem(422, 'INVALID_REFERENCE', '接收人不存在或已停用');
    return { kind, enabled: row.enabled === true, time, receiver_ids: receivers };
  });
}

export function registerReportExtra(app: FastifyInstance, services: Services) {
  const run = <T>(request: FastifyRequest, permission: string, write: boolean, work: (sql: Sql, actor: Actor) => Promise<T>) => guarded(services, request, permission, write, work);
  const query = (request: FastifyRequest) => (request.query ?? {}) as Row;
  const body = (request: FastifyRequest) => (request.body ?? {}) as Row;

  app.get('/api/reports/purchase-statement', (request) => run(request, 'procurement.read', false, async () => ({ views: [], message: '您没有可以查看的视图，请联系管理配置。' })));

  // AI库存监控
  app.get('/api/reports/ai-inventory', (request) => run(request, 'inventory.read', false, async (sql, actor) => {
    const qs = query(request);
    const result = await aiInventory(sql, actor.tenant_id);
    const has = (value: unknown, needle: unknown) => !needle || String(value).includes(String(needle).trim());
    const flag = qs.flag ? oneOf(qs.flag, ['low', 'high', 'rising'] as const, '建议类型') : null;
    const items = result.items.filter((item) => has(item.product_name, qs.product) && has(item.product_code, qs.code) && has(item.specification, qs.spec) && has(item.category_name, qs.category)
      && (!qs.source || item.source === qs.source)
      && (qs.purchase !== 'created' || item.purchase_order_code) && (qs.purchase !== 'none' || !item.purchase_order_code)
      && (qs.advice !== 'has' || q(item.advice_qty) > 0n) && (qs.advice !== 'none' || q(item.advice_qty) === 0n)
      && (!flag || item.flags.includes(flag)));
    const count = (key: string) => result.items.filter((item) => item.flags.includes(key)).length;
    return {
      month: result.month, hint: '提示：以下数据由AI大模型预测，因受多种因素影响，会存在误差，务必以实际生产情况为准来参考和使用(每月1号进行预测)。',
      refill: { basis: result.settings.refill_basis, percent: result.settings.refill_percent },
      summary: { low_count: count('low'), high_count: count('high'), rising_count: count('rising') },
      ...paged(items, qs),
    };
  }));
  /** 验收造数：写入历史库存流水（非生产环境）。 */
  app.post('/api/reports/ai-inventory/seed-flows', (request) => run(request, 'inventory.write', true, async (sql, actor) => {
    if (process.env.NODE_ENV === 'production') throw new Problem(403, 'FORBIDDEN', '生产环境不能写入验收流水');
    const input = body(request);
    const productId = idText(input.product_id, '商品', true)!;
    const warehouseId = idText(input.warehouse_id, '仓库', true)!;
    const product = (await sql.query<{ unit_id: string }>('SELECT unit_id FROM products WHERE id=$1', [productId])).rows[0];
    if (!product) throw new Problem(404, 'NOT_FOUND', '商品不存在');
    if (!(await sql.query('SELECT id FROM warehouses WHERE id=$1', [warehouseId])).rows[0]) throw new Problem(404, 'NOT_FOUND', '仓库不存在');
    const flows = Array.isArray(input.flows) ? input.flows as Row[] : [];
    if (!flows.length) throw new Problem(422, 'FLOWS_REQUIRED', '请提供流水');
    for (const flow of flows) {
      const direction = oneOf(String(flow.direction), ['in', 'out'] as const, '方向');
      const quantity = text(flow.quantity, 40, '数量', true);
      const postedAt = text(flow.posted_at, 40, '记账时间', true);
      await sql.query(`INSERT INTO stock_ledger(tenant_id,warehouse_id,product_id,unit_id,direction,quantity,source_type,source_id,event_key,posted_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6,'adjustment',gen_random_uuid(),$7,$8::timestamptz,$9)`,
      [actor.tenant_id, warehouseId, productId, product.unit_id, direction, quantity, crypto.randomUUID(), postedAt, actor.user_id]);
    }
    return { ok: true, count: flows.length };
  }));
  app.post('/api/reports/ai-inventory/purchase-orders', async (request, reply) => reply.code(201).send(await run(request, 'procurement.write', true, async (sql, actor) => {
    const ids = idList(body(request).product_ids, '商品', 200);
    if (!ids.length) throw new Problem(422, 'LINES_REQUIRED', '请先勾选商品');
    const result = await aiInventory(sql, actor.tenant_id);
    const byId = new Map(result.items.map((item) => [item.id, item]));
    const groups = new Map<string, InventoryItem[]>();
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) throw new Problem(422, 'INVALID_REFERENCE', '商品不存在、停用或不属于当前企业');
      if (item.purchase_order_code) throw new Problem(409, 'ALREADY_CREATED', `商品${item.product_name}本月已创建采购单${item.purchase_order_code}`);
      if (!item.default_supplier_id) throw new Problem(422, 'SUPPLIER_REQUIRED', `商品${item.product_name}未设置默认供应商`);
      if (q(item.advice_qty) <= 0n) throw new Problem(422, 'NO_ADVICE', `商品${item.product_name}无需备料`);
      const list = groups.get(String(item.default_supplier_id)) ?? [];
      list.push(item);
      groups.set(String(item.default_supplier_id), list);
    }
    const orders = [];
    for (const [supplierId, items] of groups) {
      const lines = [];
      for (const item of items) {
        const rule = result.settings.price_rule_mode === 'rule' ? (await sql.query<{ unit_price: string }>('SELECT unit_price::text FROM purchase_price_rules WHERE supplier_id=$1 AND product_id=$2', [supplierId, item.id])).rows[0]?.unit_price : undefined;
        const last = rule === undefined && result.settings.price_rule_mode !== 'none' ? (await historyPrices(sql, supplierId, item.id)).last_raw : null;
        lines.push({ product_id: item.id, quantity: item.advice_qty, unit_price: num(rule ?? last ?? '0') });
      }
      const order = await savePurchase(sql, actor, { supplier_id: supplierId, lines, note: `AI库存监控${result.month}备料` }) as Row;
      for (const item of items) await sql.query('INSERT INTO ai_inventory_orders(tenant_id,product_id,period,purchase_order_id) VALUES($1,$2,$3,$4)', [actor.tenant_id, item.id, result.month, order.id]);
      orders.push({ id: String(order.id), code: String(order.code), supplier_id: supplierId, product_ids: items.map((item) => item.id) });
    }
    return { orders };
  })));

  // 智能报表
  app.get('/api/smart-reports', (request) => run(request, 'production.read', false, async (sql) => {
    const items = (await sql.query<Row>(`SELECT s.id,s.name,s.source,s.dimension,s.metric,s.period,s.version,coalesce(m.display_name,'-') AS creator_name,to_char(s.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS created_text
      FROM smart_reports s LEFT JOIN tenant_team_members m ON m.id=s.created_by ORDER BY s.created_at DESC,s.id`)).rows.map((row) => {
      const config = smartSources[row.source as SmartSource];
      return { ...row, source_text: config?.label ?? '-', dimension_text: (config?.dimensions as Record<string, readonly [string, string]> | undefined)?.[String(row.dimension)]?.[0] ?? '-', metric_text: (config?.metrics as Record<string, readonly [string, string]> | undefined)?.[String(row.metric)]?.[0] ?? '-' };
    });
    const sources = Object.entries(smartSources).map(([key, config]) => ({ key, label: config.label, dimensions: Object.entries(config.dimensions).map(([value, item]) => ({ value, label: item[0] })), metrics: Object.entries(config.metrics).map(([value, item]) => ({ value, label: item[0] })) }));
    return { cards: briefCards, mini_cards: briefCards, items, total: items.length, sources, periods: smartPeriods };
  }));
  app.get<{ Params: { kind: string } }>('/api/smart-reports/brief/:kind', (request) => run(request, 'production.read', false, async (sql) => {
    const kind = oneOf(request.params.kind, ['sales', 'production'] as const, '简报');
    const range = rangeOf(query(request), '本月');
    return kind === 'sales' ? salesBrief(sql, range) : productionBrief(sql, range);
  }));
  app.get<{ Params: { id: string } }>('/api/smart-reports/:id/run', (request) => run(request, 'production.read', false, async (sql) => {
    const id = idText(request.params.id, '智能报表', true);
    const row = (await sql.query<{ id: string; name: string; source: string; dimension: string; metric: string; period: string }>('SELECT id,name,source,dimension,metric,period FROM smart_reports WHERE id=$1', [id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '智能报表不存在');
    const qs = query(request);
    const range = qs.period || (qs.from && qs.to) ? rangeOf(qs, row.period) : periodRange(row.period);
    return { report: row, ...(await runSmartReport(sql, row, range)) };
  }));
  app.post('/api/smart-reports/preview', (request) => run(request, 'production.read', false, async (sql) => {
    const input = smartInput({ ...body(request), name: body(request).name || '预览' });
    return runSmartReport(sql, input);
  }));
  app.post('/api/smart-reports', async (request, reply) => reply.code(201).send(await run(request, 'production.read', true, async (sql, actor) => {
    const input = smartInput(body(request));
    if ((await sql.query('SELECT 1 FROM smart_reports WHERE name=$1', [input.name])).rows[0]) throw new Problem(409, 'DUPLICATE_NAME', '报表名称已存在');
    const row = (await sql.query<{ id: string }>('INSERT INTO smart_reports(tenant_id,name,source,dimension,metric,period,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [actor.tenant_id, input.name, input.source, input.dimension, input.metric, input.period, actor.user_id])).rows[0]!;
    return { id: row.id };
  })));
  app.put<{ Params: { id: string } }>('/api/smart-reports/:id', (request) => run(request, 'production.read', true, async (sql) => {
    const id = idText(request.params.id, '智能报表', true);
    const input = smartInput(body(request));
    requireVersion((await sql.query<{ version: number }>('SELECT version FROM smart_reports WHERE id=$1 FOR UPDATE', [id])).rows[0], body(request).version, '智能报表');
    if ((await sql.query('SELECT 1 FROM smart_reports WHERE name=$1 AND id<>$2', [input.name, id])).rows[0]) throw new Problem(409, 'DUPLICATE_NAME', '报表名称已存在');
    await sql.query('UPDATE smart_reports SET name=$1,source=$2,dimension=$3,metric=$4,period=$5,version=version+1,updated_at=now() WHERE id=$6', [input.name, input.source, input.dimension, input.metric, input.period, id]);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/smart-reports/:id', (request) => run(request, 'production.read', true, async (sql) => {
    const id = idText(request.params.id, '智能报表', true);
    const deleted = await sql.query('DELETE FROM smart_reports WHERE id=$1 RETURNING id', [id]);
    if (!deleted.rows[0]) throw new Problem(404, 'NOT_FOUND', '智能报表不存在');
    return { ok: true };
  }));
  app.get('/api/smart-reports/push-settings', (request) => run(request, 'production.read', false, async (sql, actor) => {
    const prefs = await reportPrefs(sql, actor.tenant_id);
    const saved = Array.isArray(prefs.push_settings) ? prefs.push_settings as Row[] : [];
    const items = briefCards.map((card) => {
      const row = saved.find((item) => item.kind === card.key);
      return { kind: card.key, title: card.title, enabled: row?.enabled === true, time: String(row?.time ?? '09:00'), receiver_ids: Array.isArray(row?.receiver_ids) ? row!.receiver_ids : [] };
    });
    return { items, version: prefs.version, note: '推送设置仅保存，暂不实际推送' };
  }));
  app.put('/api/smart-reports/push-settings', (request) => run(request, 'production.read', true, async (sql, actor) => {
    const prefs = await reportPrefs(sql, actor.tenant_id);
    requireVersion(prefs as { version: unknown }, body(request).version, '推送设置');
    const members = new Set((await sql.query<{ id: string }>('SELECT id FROM tenant_team_members')).rows.map((row) => row.id));
    const items = pushRows(body(request).items, members);
    await sql.query('UPDATE tenant_report_prefs SET push_settings=$1::jsonb,version=version+1,updated_at=now()', [JSON.stringify(items)]);
    return { items };
  }));

  // 报表配置：产量报表指标、在制品指标/工序、销售对账单统计数值
  app.get('/api/report-prefs', (request) => run(request, 'production.read', false, async (sql, actor) => {
    const prefs = await reportPrefs(sql, actor.tenant_id);
    return { ...prefs, options: { output_metrics: outputMetricKeys, wip_metrics: wipMetricKeys, sales_stat_items: salesStatKeys } };
  }));
  app.put('/api/report-prefs', (request) => run(request, 'production.read', true, async (sql, actor) => {
    const prefs = await reportPrefs(sql, actor.tenant_id);
    const input = body(request);
    requireVersion(prefs as { version: unknown }, input.version, '报表配置');
    const output = input.output_metrics === undefined ? prefs.output_metrics : keyList(input.output_metrics, outputMetricKeys, '产量报表指标');
    const wip = input.wip_metrics === undefined ? prefs.wip_metrics : keyList(input.wip_metrics, wipMetricKeys, '在制品指标');
    const sales = input.sales_stat_items === undefined ? prefs.sales_stat_items : keyList(input.sales_stat_items, salesStatKeys, '统计数值');
    const processIds = input.wip_process_ids === undefined ? prefs.wip_process_ids as string[] : idList(input.wip_process_ids, '工序', 200);
    if (processIds.length && Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM processes WHERE id = ANY($1::uuid[])', [processIds])).rows[0]!.n) !== processIds.length) throw new Problem(422, 'INVALID_REFERENCE', '工序不存在或不属于当前企业');
    await sql.query('UPDATE tenant_report_prefs SET output_metrics=$1::jsonb,wip_metrics=$2::jsonb,sales_stat_items=$3::jsonb,wip_process_ids=$4::uuid[],version=version+1,updated_at=now()', [JSON.stringify(output), JSON.stringify(wip), JSON.stringify(sales), processIds]);
    return reportPrefs(sql, actor.tenant_id);
  }));

  // 质量报表（带筛选和汇总维度）
  app.get('/api/report-extra/purchase-tests', (request) => run(request, 'quality.read', false, async (sql) => {
    const qs = query(request);
    const range = rangeOf(qs, '本周');
    const dimension = oneOf(qs.dimension, ['product', 'supplier', 'product_supplier'] as const, '汇总维度', 'product');
    const f = filters();
    f.add((n) => `(t.created_at AT TIME ZONE 'Asia/Shanghai')::date >= ${n}::date`, range.from);
    f.add((n) => `(t.created_at AT TIME ZONE 'Asia/Shanghai')::date <= ${n}::date`, range.to);
    f.add((n) => `p.name ILIKE ${n}`, like(qs.name));
    f.add((n) => `p.code ILIKE ${n}`, like(qs.code));
    f.add((n) => `coalesce(p.specification,'') ILIKE ${n}`, like(qs.spec));
    f.add((n) => `s.name ILIKE ${n}`, like(qs.supplier));
    const productKey = dimension !== 'supplier';
    const supplierKey = dimension !== 'product';
    const rows = (await sql.query<Row>(`SELECT ${productKey ? "p.id AS product_id,coalesce(p.name,'未选商品') AS product_name,coalesce(p.code,'-') AS product_code,coalesce(nullif(p.specification,''),'-') AS specification,p.images->>0 AS product_image,coalesce(c.name,'-') AS category_name,coalesce(u.name,'-') AS unit_name," : ''}
        ${supplierKey ? "s.id AS supplier_id,s.name AS supplier_name," : ''}
        coalesce(sum((SELECT sum(l.quantity) FROM purchase_order_lines l WHERE l.order_id=t.purchase_order_id AND (t.product_id IS NULL OR l.product_id=t.product_id))),0)::text AS purchase_qty,
        sum(t.send_qty)::text AS send_qty,sum(t.tested_qty)::text AS tested_qty,sum(t.pass_qty)::text AS pass_qty,sum(t.fail_qty)::text AS fail_qty
      FROM r8_purchase_tests t JOIN purchase_orders o ON o.tenant_id=t.tenant_id AND o.id=t.purchase_order_id JOIN suppliers s ON s.tenant_id=o.tenant_id AND s.id=o.supplier_id
      LEFT JOIN products p ON p.tenant_id=t.tenant_id AND p.id=t.product_id LEFT JOIN product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
      WHERE ${f.sql()} GROUP BY ${[productKey ? 'p.id,p.name,p.code,p.specification,p.images,c.name,u.name' : '', supplierKey ? 's.id,s.name' : ''].filter(Boolean).join(',')} ORDER BY sum(t.fail_qty) DESC`, f.params)).rows;
    const items = rows.map((row, index) => ({ ...row, id: `${row.product_id ?? ''}:${row.supplier_id ?? ''}:${index}`, purchase_qty: num(row.purchase_qty), send_qty: num(row.send_qty), tested_qty: num(row.tested_qty), pass_qty: num(row.pass_qty), fail_qty: num(row.fail_qty), fail_rate: percent(Number(row.fail_qty), Number(row.tested_qty)) }));
    return { range, dimension, ...paged(items, qs) };
  }));
  app.get('/api/report-extra/spot-checks', (request) => run(request, 'quality.read', false, async (sql) => {
    const qs = query(request);
    const range = rangeOf(qs, '本周');
    const dimension = oneOf(qs.dimension, ['process', 'operator', 'product', 'operator_process'] as const, '汇总维度', 'process');
    const f = filters();
    f.add((n) => `(s.created_at AT TIME ZONE 'Asia/Shanghai')::date >= ${n}::date`, range.from);
    f.add((n) => `(s.created_at AT TIME ZONE 'Asia/Shanghai')::date <= ${n}::date`, range.to);
    f.add((n) => `pr.name ILIKE ${n}`, like(qs.process_name));
    f.add((n) => `s.operator_name ILIKE ${n}`, like(qs.operator_name));
    f.add((n) => `p.name ILIKE ${n}`, like(qs.product_name));
    const keys: Record<typeof dimension, string> = {
      process: "pr.id AS process_id,pr.name AS process_name,pr.code AS process_code,coalesce(nullif(s.shop_name,''),'-') AS shop_name,coalesce(nullif(s.line_name,''),'-') AS line_name",
      operator: "coalesce(nullif(s.operator_name,''),'-') AS operator_name",
      product: "coalesce(p.name,'-') AS product_name,coalesce(p.code,'-') AS product_code,coalesce(nullif(p.specification,''),'-') AS specification",
      operator_process: "coalesce(nullif(s.operator_name,''),'-') AS operator_name,pr.name AS process_name,pr.code AS process_code",
    };
    const groups: Record<typeof dimension, string> = { process: 'pr.id,pr.name,pr.code,4,5', operator: '1', product: '1,2,3', operator_process: '1,2,3' };
    const rows = (await sql.query<Row>(`SELECT ${keys[dimension]},sum(s.qty)::text AS qty,sum(s.good_qty)::text AS good_qty,sum(s.defect_qty)::text AS defect_qty
      FROM r8_spot_checks s JOIN processes pr ON pr.tenant_id=s.tenant_id AND pr.id=s.process_id LEFT JOIN products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
      WHERE ${f.sql()} GROUP BY ${groups[dimension]} ORDER BY sum(s.defect_qty) DESC`, f.params)).rows;
    const items = rows.map((row, index) => ({ ...row, id: String(index + 1), qty: num(row.qty), good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), defect_rate: percent(Number(row.defect_qty), Number(row.qty)) }));
    return { range, dimension, ...paged(items, qs) };
  }));
  app.get('/api/report-extra/scrap-rework', (request) => run(request, 'quality.read', false, async (sql) => {
    const qs = query(request);
    const range = rangeOf(qs, '本周');
    const dimension = oneOf(qs.dimension, ['product', 'process', 'product_process', 'machine', 'operator', 'inspector'] as const, '汇总维度', 'product');
    const f = filters();
    f.add((n) => `(coalesce(r.quality_at,r.created_at) AT TIME ZONE 'Asia/Shanghai')::date >= ${n}::date`, range.from);
    f.add((n) => `(coalesce(r.quality_at,r.created_at) AT TIME ZONE 'Asia/Shanghai')::date <= ${n}::date`, range.to);
    f.add((n) => `(w.product_snapshot->>'name') ILIKE ${n}`, like(qs.name));
    f.add((n) => `(w.product_snapshot->>'code') ILIKE ${n}`, like(qs.code));
    f.add((n) => `coalesce(w.product_snapshot->>'specification','') ILIKE ${n}`, like(qs.spec));
    f.add((n) => `coalesce(pc.name,'') ILIKE ${n}`, like(qs.category));
    const product = "coalesce(w.product_snapshot->>'name','-') AS product_name,coalesce(w.product_snapshot->>'code','-') AS product_code,coalesce(nullif(w.product_snapshot->>'specification',''),'-') AS specification,coalesce(pc.name,'-') AS category_name,coalesce(nullif(w.product_snapshot->>'unit_name',''),'-') AS unit_name";
    const process = "coalesce(t.process_snapshot->>'name','-') AS process_name,coalesce(t.process_snapshot->>'code','-') AS process_code";
    const keys: Record<typeof dimension, [string, string]> = {
      product: [product, '1,2,3,4,5'],
      process: [process, '1,2'],
      product_process: [`${product},${process}`, '1,2,3,4,5,6,7'],
      machine: ["coalesce(m.name,'未选机台') AS machine_name,coalesce(m.code,'-') AS machine_code", '1,2'],
      operator: ["coalesce(op.display_name,'-') AS operator_name", '1'],
      inspector: ["coalesce(qb.display_name,'-') AS inspector_name", '1'],
    };
    const rows = (await sql.query<Row>(`SELECT ${keys[dimension][0]},sum(r.good_qty+r.defect_qty)::text AS report_qty,sum(r.good_qty)::text AS good_qty,sum(r.defect_qty)::text AS defect_qty,sum(r.scrap_qty)::text AS scrap_qty,sum(r.rework_qty)::text AS rework_qty
      FROM production_reports r JOIN work_orders w ON w.tenant_id=r.tenant_id AND w.id=r.work_order_id JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      LEFT JOIN products p ON p.tenant_id=w.tenant_id AND p.id=w.product_id LEFT JOIN product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
      LEFT JOIN r8_machines m ON m.tenant_id=r.tenant_id AND m.id=r.machine_id LEFT JOIN tenant_team_members op ON op.id=r.operator_id LEFT JOIN tenant_team_members qb ON qb.id=r.quality_by
      WHERE r.approval='approved' AND r.quality_status='done' AND ${f.sql()} GROUP BY ${keys[dimension][1]} ORDER BY sum(r.scrap_qty+r.rework_qty) DESC`, f.params)).rows;
    const items = rows.map((row, index) => {
      const report = Number(row.report_qty) || 0;
      const defect = Number(row.defect_qty) || 0;
      return { ...row, id: String(index + 1), report_qty: num(row.report_qty), good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), scrap_qty: num(row.scrap_qty), rework_qty: num(row.rework_qty), scrap_rate: percent(Number(row.scrap_qty), report), rework_rate: percent(Number(row.rework_qty), report), scrap_of_defect: percent(Number(row.scrap_qty), defect), rework_of_defect: percent(Number(row.rework_qty), defect) };
    });
    return { range, dimension, ...paged(items, qs) };
  }));

  // 经营报表（带筛选）
  app.get('/api/report-extra/sales', (request) => run(request, 'sales.read', false, async (sql) => {
    const qs = query(request);
    const range = rangeOf(qs, '本月');
    const f = filters();
    f.add((n) => `(c.created_at AT TIME ZONE 'Asia/Shanghai')::date >= ${n}::date`, range.from);
    f.add((n) => `(c.created_at AT TIME ZONE 'Asia/Shanghai')::date <= ${n}::date`, range.to);
    f.add((n) => `cu.code ILIKE ${n}`, like(qs.customer_code));
    f.add((n) => `cu.name ILIKE ${n}`, like(qs.customer_name));
    f.add((n) => `cu.contact_name ILIKE ${n}`, like(qs.contact_name));
    f.add((n) => `cu.contact_phone ILIKE ${n}`, like(qs.contact_phone));
    f.add((n) => `cu.address ILIKE ${n}`, like(qs.address));
    if (qs.active) f.add((n) => `cu.active=${n}`, oneOf(qs.active, ['启用', '禁用'] as const, '状态') === '启用');
    f.add((n) => `${n}=ANY(cu.tags)`, text(qs.tag, 40, '客户标签') || null);
    f.add((n) => `cu.owner_id=${n}::uuid`, idText(qs.owner_id, '负责人'));
    const rows = (await sql.query<Row>(`SELECT cu.id,cu.code AS customer_code,cu.name AS customer_name,coalesce(nullif(cu.contact_name,''),'-') AS contact_name,coalesce(nullif(cu.contact_phone,''),'-') AS contact_phone,coalesce(nullif(cu.address,''),'-') AS address,
        CASE WHEN cu.active THEN '启用' ELSE '禁用' END AS enabled_text,array_to_string(cu.tags,'、') AS tags,coalesce(ow.display_name,'-') AS owner_name,
        count(c.id)::text AS contract_count,coalesce(sum(c.amount),0)::text AS amount,coalesce(sum(c.qty),0)::text AS qty,
        coalesce(sum((SELECT sum(m.amount) FROM money_cash m WHERE m.contract_id=c.id AND m.direction='in' AND m.approval IN ('approved','exempt'))),0)::text AS received,
        coalesce(sum((SELECT sum(i.amount) FROM money_invoices i WHERE i.contract_id=c.id AND i.status='done')),0)::text AS invoiced
      FROM money_contracts c JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id LEFT JOIN tenant_team_members ow ON ow.id=cu.owner_id
      WHERE c.approval IN ('approved','exempt') AND ${f.sql()} GROUP BY cu.id,ow.display_name ORDER BY cu.code`, f.params)).rows;
    let items = rows.map((row) => {
      const amount = num(row.amount);
      const received = num(row.received);
      const invoiced = num(row.invoiced);
      return { ...row, contract_count: Number(row.contract_count), amount, qty: num(row.qty), received, debt: contractDebt(amount, received), invoiced, uninvoiced: contractDebt(amount, invoiced) };
    });
    const debtCount = items.filter((item) => Number(item.debt) > 0).length;
    const clearCount = items.length - debtCount;
    if (qs.debt === '有欠款') items = items.filter((item) => Number(item.debt) > 0);
    if (qs.debt === '无欠款') items = items.filter((item) => Number(item.debt) <= 0);
    const sum = (key: 'amount' | 'received' | 'debt' | 'qty' | 'invoiced' | 'uninvoiced') => sumMoney(items.map((item) => String(item[key])));
    return { range, debt_count: debtCount, clear_count: clearCount, summary: { contracts: items.reduce((total, item) => total + item.contract_count, 0), qty: sum('qty'), amount: sum('amount'), received: sum('received'), debt: sum('debt'), invoiced: sum('invoiced'), uninvoiced: sum('uninvoiced') }, ...paged(items, qs) };
  }));
  app.get('/api/report-extra/contracts', (request) => run(request, 'sales.read', false, async (sql) => {
    const qs = query(request);
    const f = filters();
    if (qs.period || (qs.from && qs.to)) {
      const range = rangeOf(qs, '本月');
      f.add((n) => `(c.created_at AT TIME ZONE 'Asia/Shanghai')::date >= ${n}::date`, range.from);
      f.add((n) => `(c.created_at AT TIME ZONE 'Asia/Shanghai')::date <= ${n}::date`, range.to);
    }
    f.add((n) => `c.code ILIKE ${n}`, like(qs.code));
    f.add((n) => `cu.name ILIKE ${n}`, like(qs.customer_name));
    f.add((n) => `l.product_name ILIKE ${n}`, like(qs.product_name));
    f.add((n) => `l.product_code ILIKE ${n}`, like(qs.product_code));
    f.add((n) => `l.specification ILIKE ${n}`, like(qs.spec));
    f.add((n) => `c.salesperson_id=${n}::uuid`, idText(qs.salesperson_id, '销售员'));
    f.add((n) => `c.delivery_date >= ${n}::date`, dateText(qs.delivery_from, '交货日期'));
    f.add((n) => `c.delivery_date <= ${n}::date`, dateText(qs.delivery_to, '交货日期'));
    const rows = (await sql.query<Row>(`SELECT l.id,c.id AS contract_id,c.code,cu.name AS customer_name,cu.code AS customer_code,l.product_id,l.product_name,l.product_code,coalesce(nullif(l.specification,''),'-') AS specification,coalesce(nullif(l.unit_name,''),'-') AS unit_name,
        coalesce(nullif(l.source,''),'-') AS source,l.unit_price::text,l.quantity::text,l.discount::text,l.concession::text,l.amount::text,l.net_amount::text,coalesce(nullif(l.note,''),'-') AS note,
        coalesce(sp.display_name,'-') AS salesperson_name,to_char(c.delivery_date,'YYYY-MM-DD') AS delivery_date,to_char(c.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS created_text
      FROM money_contract_lines l JOIN money_contracts c ON c.tenant_id=l.tenant_id AND c.id=l.contract_id JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id LEFT JOIN tenant_team_members sp ON sp.id=c.salesperson_id
      WHERE c.approval IN ('approved','exempt') AND ${f.sql()} ORDER BY c.created_at DESC,l.line_no`, f.params)).rows;
    const shippedByLine = new Map<string, string>();
    for (const contractId of new Set(rows.map((row) => String(row.contract_id)))) {
      for (const line of (await contractOutbound(sql, contractId)).lines) shippedByLine.set(line.contract_line_id, line.shipped_qty);
    }
    const items = rows.map((row) => {
      const qty = q(String(row.quantity));
      const shipped = q(shippedByLine.get(String(row.id)) ?? '0');
      return { ...row, unit_price: num(row.unit_price), quantity: qtyText(qty), discount: num(row.discount), concession: num(row.concession), amount: num(row.amount), net_amount: num(row.net_amount), shipped_qty: qtyText(shipped), unshipped_qty: qtyText(qty > shipped ? qty - shipped : 0n) };
    });
    const total = (key: 'quantity' | 'shipped_qty' | 'unshipped_qty') => qtyText(items.reduce((acc, item) => acc + q(item[key]), 0n));
    const netAmount = sumMoney(items.map((item) => item.net_amount));
    const summary = { net_amount: netAmount, qty: total('quantity'), shipped: total('shipped_qty'), unshipped: total('unshipped_qty') };
    return { summary, summary_text: `【折后总金额】${summary.net_amount} 元【销售数量】${summary.qty}【已出库数量】${summary.shipped}【未出库数量】${summary.unshipped}`, ...paged(items, qs) };
  }));
  app.get('/api/report-extra/inventory', (request) => run(request, 'inventory.read', false, async (sql) => {
    const qs = query(request);
    const range = rangeOf(qs, '本年');
    const warehouseId = idText(qs.warehouse_id, '仓库');
    const f = filters();
    f.add((n) => `p.name ILIKE ${n}`, like(qs.name));
    f.add((n) => `p.code ILIKE ${n}`, like(qs.code));
    f.add((n) => `coalesce(p.specification,'') ILIKE ${n}`, like(qs.spec));
    f.add((n) => `coalesce(u.name,'') ILIKE ${n}`, like(qs.unit));
    f.add((n) => `coalesce(c.name,'') ILIKE ${n}`, like(qs.category));
    const params = [...f.params, range.from, range.to, warehouseId];
    const [from, to, wh] = [`$${params.length - 2}`, `$${params.length - 1}`, `$${params.length}`];
    const ledger = `stock_ledger l WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND (${wh}::uuid IS NULL OR l.warehouse_id=${wh}::uuid)`;
    const day = "(l.posted_at AT TIME ZONE 'Asia/Shanghai')::date";
    const rows = (await sql.query<Row>(`SELECT p.id,p.code,p.name,coalesce(nullif(p.specification,''),'-') AS specification,coalesce(u.name,'-') AS unit_name,coalesce(c.name,'-') AS category_name,p.source,p.attribute,coalesce(nullif(p.remark,''),'-') AS remark,
        coalesce((SELECT sum(b.on_hand) FROM stock_balances b WHERE b.tenant_id=p.tenant_id AND b.product_id=p.id AND (${wh}::uuid IS NULL OR b.warehouse_id=${wh}::uuid)),0)::text AS stock,
        coalesce((SELECT sum(CASE WHEN l.direction='in' THEN l.quantity ELSE -l.quantity END) FROM ${ledger} AND ${day} < ${from}::date),0)::text AS opening,
        coalesce((SELECT sum(l.quantity) FROM ${ledger} AND l.direction='in' AND ${day} BETWEEN ${from}::date AND ${to}::date),0)::text AS inbound,
        coalesce((SELECT sum(l.quantity) FROM ${ledger} AND l.direction='out' AND ${day} BETWEEN ${from}::date AND ${to}::date),0)::text AS outbound
      FROM products p LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id LEFT JOIN product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
      WHERE ${f.sql()} ORDER BY p.code`, params)).rows;
    const onlyFlow = qs.only_flow === undefined ? true : !['0', 'false', '否'].includes(String(qs.only_flow));
    const items = rows.map((row) => {
      const opening = q(String(row.opening));
      const inbound = q(String(row.inbound));
      const outbound = q(String(row.outbound));
      return { ...row, source: sourceOf(row), stock: qtyText(q(String(row.stock))), opening: qtyText(opening), inbound: qtyText(inbound), outbound: qtyText(outbound), closing: qtyText(opening + inbound - outbound) };
    }).filter((row) => !onlyFlow || q(row.inbound) > 0n || q(row.outbound) > 0n);
    return { range, only_flow: onlyFlow, ...paged(items, qs) };
  }));
  app.get('/api/report-extra/cost', (request) => run(request, 'production.read', false, async (sql) => {
    const qs = query(request);
    const f = filters();
    if (qs.period || (qs.from && qs.to)) {
      const range = rangeOf(qs, '本月');
      f.add((n) => `(w.created_at AT TIME ZONE 'Asia/Shanghai')::date >= ${n}::date`, range.from);
      f.add((n) => `(w.created_at AT TIME ZONE 'Asia/Shanghai')::date <= ${n}::date`, range.to);
    }
    f.add((n) => `w.code ILIKE ${n}`, like(qs.code));
    f.add((n) => `(w.product_snapshot->>'name') ILIKE ${n}`, like(qs.product_name));
    f.add((n) => `(w.product_snapshot->>'code') ILIKE ${n}`, like(qs.product_code));
    f.add((n) => `coalesce(w.product_snapshot->>'specification','') ILIKE ${n}`, like(qs.spec));
    f.add((n) => `(pj.code ILIKE ${n} OR pj.name ILIKE ${n})`, like(qs.project));
    f.add((n) => `w.project_id=${n}::uuid`, idText(qs.project_id, '项目'));
    if (qs.execution) f.add((n) => `w.execution=${n}`, oneOf(qs.execution, ['not_started', 'running', 'paused', 'completed', 'cancelled'] as const, '生产状态'));
    const rows = (await sql.query<Row>(`SELECT w.id,w.code,w.execution,coalesce(w.product_snapshot->>'name','') AS product_name,coalesce(w.product_snapshot->>'code','') AS product_code,coalesce(nullif(w.product_snapshot->>'specification',''),'-') AS specification,
        coalesce(nullif(w.product_snapshot->>'unit_name',''),'-') AS unit_name,coalesce(pc.name,'-') AS category_name,p.source,p.attribute,coalesce(p.sale_price,0)::text AS sale_price,w.plan_qty::text,
        coalesce(pj.code,'-') AS project_code,coalesce(pj.name,'-') AS project_name,to_char(w.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS created_text,
        coalesce((SELECT sum(t.approved_good) FROM work_order_tasks t WHERE t.work_order_id=w.id AND t.is_output),0)::text AS good_qty,
        coalesce((SELECT sum(r.good_qty+r.defect_qty) FROM production_reports r WHERE r.work_order_id=w.id AND r.approval='approved'),0)::text AS report_qty,
        coalesce((SELECT sum(r.effective_seconds) FROM production_reports r WHERE r.work_order_id=w.id AND r.approval='approved'),0)::text AS seconds,
        coalesce((SELECT sum((r.wage_snapshot->>'amount_cents')::numeric) FROM production_reports r WHERE r.work_order_id=w.id AND r.approval='approved' AND r.wage_snapshot->>'amount_cents' IS NOT NULL),0)::text AS labor_cents,
        coalesce((SELECT sum(il.quantity*coalesce(mp.cost_price,0)) FROM material_issue_lines il JOIN material_issues mi ON mi.tenant_id=il.tenant_id AND mi.id=il.issue_id JOIN products mp ON mp.tenant_id=il.tenant_id AND mp.id=il.product_id WHERE mi.work_order_id=w.id AND mi.approval='approved'),0)::text AS material,
        ${receivedQtySql('w.id')}::text AS received_qty
      FROM work_orders w LEFT JOIN products p ON p.tenant_id=w.tenant_id AND p.id=w.product_id LEFT JOIN product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
      LEFT JOIN production_projects pj ON pj.tenant_id=w.tenant_id AND pj.id=w.project_id
      WHERE ${f.sql()} ORDER BY w.created_at DESC,w.id`, f.params)).rows;
    const outsource = (await sql.query<{ work_order_id: string; fee: string }>("SELECT o.work_order_id,coalesce(sum(r.settle_amount) FILTER (WHERE r.settle_status='已结算'),0)::text AS fee FROM r8_out_orders o LEFT JOIN r8_os_receipts r ON r.tenant_id=o.tenant_id AND r.order_id=o.id WHERE o.work_order_id IS NOT NULL GROUP BY o.work_order_id")).rows;
    const outsourceMap = new Map(outsource.map((row) => [row.work_order_id, row.fee]));
    const shares = await costShareByWorkOrder(sql);
    const executionText: Record<string, string> = { not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
    const items: Row[] = rows.map((row) => {
      const labor = (Number(row.labor_cents) / 100).toFixed(2);
      const material = Number(row.material).toFixed(2);
      const outsourceFee = Number(outsourceMap.get(String(row.id)) ?? 0).toFixed(2);
      const share = Number(shares.get(String(row.id)) ?? 0).toFixed(2);
      const total = sumMoney([labor, material, outsourceFee, share]);
      const output = (Number(row.good_qty) * Number(row.sale_price)).toFixed(2);
      const plan = Number(row.plan_qty) || 0;
      const good = Number(row.good_qty) || 0;
      return {
        ...row, source: sourceOf(row), execution_text: executionText[String(row.execution)] ?? '-', plan_qty: num(row.plan_qty), good_qty: num(row.good_qty), report_qty: num(row.report_qty), received_qty: num(row.received_qty),
        hours: num((Number(row.seconds) / 3600).toFixed(2)), sale_price: num(row.sale_price), labor, material, outsource: outsourceFee, cost_share: share, total, output, profit: subMoney(output, total),
        unit_cost: good ? (Number(total) / good).toFixed(2) : '-', completion_rate: percent(good, plan), profit_rate: Number(output) ? percent(Number(output) - Number(total), Number(output)) : '-',
      };
    });
    if (!qs.project && !qs.project_id && !qs.execution && !qs.period && !(qs.from && qs.to)) {
      const loose = filters();
      loose.add((n) => `o.code ILIKE ${n}`, like(qs.code));
      loose.add((n) => `p.name ILIKE ${n}`, like(qs.product_name));
      loose.add((n) => `p.code ILIKE ${n}`, like(qs.product_code));
      loose.add((n) => `coalesce(p.specification,'') ILIKE ${n}`, like(qs.spec));
      const orphan = (await sql.query<Row>(`SELECT o.id,o.code,p.name AS product_name,p.code AS product_code,coalesce(nullif(p.specification,''),'-') AS specification,p.source,p.attribute,o.plan_qty::text,o.status AS execution_text,
          to_char(o.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS created_text,coalesce(sum(r.settle_amount) FILTER (WHERE r.settle_status='已结算'),0)::text AS fee
        FROM r8_out_orders o JOIN products p ON p.tenant_id=o.tenant_id AND p.id=o.product_id LEFT JOIN r8_os_receipts r ON r.tenant_id=o.tenant_id AND r.order_id=o.id
        WHERE o.work_order_id IS NULL AND ${loose.sql()} GROUP BY o.id,p.id ORDER BY o.created_at DESC`, loose.params)).rows;
      for (const row of orphan) {
        const fee = Number(row.fee).toFixed(2);
        items.push({ ...row, fee: undefined, source: sourceOf(row), project_code: '-', project_name: '-', plan_qty: num(row.plan_qty), good_qty: '0', report_qty: '0', received_qty: '0', hours: '0', sale_price: '0', labor: '0.00', material: '0.00', outsource: fee, cost_share: '0.00', total: fee, output: '0.00', profit: subMoney('0', fee), unit_cost: '-', completion_rate: '-', profit_rate: '-' });
      }
    }
    const sum = (key: 'labor' | 'material' | 'outsource' | 'cost_share' | 'total' | 'output' | 'profit') => sumMoney(items.map((item) => String(item[key])));
    const summary = { labor: sum('labor'), material: sum('material'), outsource: sum('outsource'), cost_share: sum('cost_share'), total: sum('total'), output: sum('output'), profit: sum('profit') };
    return { summary, summary_text: `【人工总费用】${summary.labor}元【材料总费用(估算)】${summary.material}元【外协总费用】${summary.outsource}元【成本分摊】${summary.cost_share}元【合计总成本】${summary.total}元【生产总值】${summary.output}元【毛利润】${summary.profit}元`, ...paged(items, qs) };
  }));
}
