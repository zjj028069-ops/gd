import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { decimal, formatDecimal } from './decimal.js';
import { gateTenantWrite } from './assets.js';
import { Problem, requireAllScope, writeAudit, type Actor, type Services } from './services.js';
import { permit } from './business-common.js';
import { floorPercent, processCountProgress, progressLabel, q, qtyText, ringPercent, taskOverdueSql, taskProgressFromTasks, workOrderOverdueSql } from './progress-calc.js';
import { workOrderView } from './production.js';
import { runMaterialAnalysis } from './material-analysis.js';

const uuid = { type: 'string', format: 'uuid' };
const requestKey = { type: 'string', minLength: 8, maxLength: 80, pattern: '^[A-Za-z0-9_.-]+$' };
const decimalField = { type: 'string', pattern: '^(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,6})?$' };
const dateField = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const object = (required: string[], properties: Record<string, unknown>, optional: string[] = []) => ({ type: 'object', additionalProperties: false, required, properties: Object.fromEntries([...required, ...optional].map((key) => [key, properties[key]])) });

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function serial(sql: Sql, tenantId: string, series: string, period: string, width: number) {
  await sql.query('INSERT INTO money_counters(tenant_id,series,period,next_value) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING', [tenantId, series, period]);
  const current = BigInt((await sql.query<{ n: string }>('SELECT next_value::text AS n FROM money_counters WHERE series=$1 AND period=$2 FOR UPDATE', [series, period])).rows[0]!.n);
  await sql.query('UPDATE money_counters SET next_value=$1 WHERE series=$2 AND period=$3', [(current + 1n).toString(), series, period]);
  return series + period + String(current).padStart(width, '0');
}

async function memberName(sql: Sql, id: string | null) {
  if (!id) return '';
  return String((await sql.query<{ display_name: string }>('SELECT display_name FROM tenant_team_members WHERE id=$1', [id])).rows[0]?.display_name ?? '');
}

function sourceKind(attribute: string) {
  if (attribute === 'purchased') return 'purchase';
  if (attribute === 'outsourced') return 'outsource';
  return 'self';
}

function sourceLabel(kind: string) {
  if (kind === 'purchase') return '外购';
  if (kind === 'outsource') return '外协加工';
  return '自产';
}

async function defaultBomForProduct(sql: Sql, productId: string) {
  return (await sql.query<{ id: string; code: string; name: string; current_version_id: string }>(
    `SELECT id, coalesce(nullif(code,''),'') AS code, coalesce(nullif(name,''),'') AS name, current_version_id
     FROM bom_definitions WHERE parent_product_id=$1 AND active
     ORDER BY is_default DESC, created_at DESC LIMIT 1`,
    [productId],
  )).rows[0] ?? null;
}

function bomLabelOf(bom: { code: string; name: string } | null | undefined) {
  if (!bom) return '无';
  const code = String(bom.code ?? '').trim();
  const name = String(bom.name ?? '').trim();
  if (code && name && code !== name) return `${code} ${name}`;
  return code || name || '无';
}

async function planProgress(sql: Sql, planId: string) {
  const demands = (await sql.query<{ kind: string; qty: string; released: string }>(
    `SELECT al.demand_kind AS kind, al.demand_qty::text AS qty, al.released_qty::text AS released
     FROM production_plan_analysis_lines al
     JOIN production_plan_analyses a ON a.tenant_id=al.tenant_id AND a.id=al.analysis_id
     WHERE a.plan_id=$1 AND a.status='active' AND al.demand_kind='process'`,
    [planId],
  )).rows;
  const processDemand = demands.reduce((sum, row) => sum + q(row.qty), 0n);
  const processReleased = demands.reduce((sum, row) => sum + q(row.released), 0n);
  if (!demands.length) {
    const analyzed = (await sql.query<{ n: string }>('SELECT analyzed::text AS n FROM production_plans WHERE id=$1', [planId])).rows[0];
    if (analyzed?.n === 'true') {
      const lines = (await sql.query<{ qty: string; released: string }>('SELECT plan_qty::text AS qty, released_qty::text AS released FROM production_plan_lines WHERE plan_id=$1', [planId])).rows;
      const selfLines = lines;
      const demand = selfLines.reduce((sum, line) => sum + q(line.qty), 0n);
      const released = selfLines.reduce((sum, line) => sum + q(line.released), 0n);
      return { process: { done: qtyText(released), total: qtyText(demand) }, outsource: { done: '0', total: '0' }, purchase: { done: '0', total: '0' } };
    }
  }
  const woReleased = q((await sql.query<{ n: string }>(
    `SELECT coalesce(sum(w.plan_qty),0)::text AS n FROM work_orders w
     JOIN production_plan_lines pl ON pl.tenant_id=w.tenant_id AND pl.id=w.production_plan_line_id
     WHERE pl.plan_id=$1 AND w.execution<>'cancelled'`,
    [planId],
  )).rows[0]!.n);
  const done = processDemand > 0n ? woReleased : processReleased;
  return {
    process: { done: qtyText(done), total: qtyText(processDemand) },
    outsource: { done: '0', total: '0' },
    purchase: { done: '0', total: '0' },
  };
}

async function presentPlan(sql: Sql, row: Record<string, unknown>) {
  const progress = await planProgress(sql, String(row.id));
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    analysis_status: row.analyzed ? 'analyzed' : 'pending',
    process_progress: progress.process,
    outsource_progress: progress.outsource,
    purchase_progress: progress.purchase,
    delivery_date: row.delivery_date,
    creator_name: await memberName(sql, String(row.created_by)),
    created_at: row.created_at,
    note: row.note,
    version: row.version,
  };
}

type TaskAgg = { effective_seconds: number; last_report_at: string | null };

async function taskAggregates(sql: Sql, taskIds: string[]) {
  const map = new Map<string, TaskAgg>();
  if (!taskIds.length) return map;
  const rows = (await sql.query<{ task_id: string; seconds: string; last_at: string | null }>(
    `SELECT task_id, coalesce(sum(effective_seconds),0)::text AS seconds, max(created_at)::text AS last_at
     FROM production_reports WHERE task_id=ANY($1::uuid[]) AND approval='approved' GROUP BY task_id`,
    [taskIds],
  )).rows;
  rows.forEach((row) => map.set(row.task_id, { effective_seconds: Number(row.seconds), last_report_at: row.last_at }));
  return map;
}

async function mapWorkOrderListItem(sql: Sql, order: Record<string, unknown>, tasks: Record<string, unknown>[], agg: Map<string, TaskAgg>, stock?: string) {
  const planQty = String(order.plan_qty);
  const received = String(order.received_qty ?? '0');
  const completed = tasks.filter((task) => task.execution === 'completed').length;
  const ring_tasks = tasks.map((task) => ({
    id: task.id,
    process_name: (task.process_snapshot as { name?: string })?.name ?? '',
    execution: task.execution,
    plan_qty: task.plan_qty,
    approved_good: task.approved_good,
    approved_defect: task.approved_defect,
    ring_percent: ringPercent(String(task.approved_good), String(task.plan_qty)),
    effective_seconds: agg.get(String(task.id))?.effective_seconds ?? 0,
    last_report_at: agg.get(String(task.id))?.last_report_at ?? null,
    planned_start: task.planned_start ?? null,
    planned_end: task.planned_end ?? null,
  }));
  const hours = tasks.reduce((sum, task) => sum + (agg.get(String(task.id))?.effective_seconds ?? 0), 0);
  const hoursText = hours ? `${Math.floor(hours / 3600)}小时${Math.floor((hours % 3600) / 60)}分钟` : '';
  const current = tasks.find((task) => task.execution !== 'completed' && task.execution !== 'cancelled');
  const output = tasks.find((task) => task.is_output);
  return {
    id: order.id,
    code: order.code,
    plan_qty: planQty,
    output_qty: output ? qtyText(q(String(output.approved_good)) / (q(String(output.unit_ratio)) || 1n)) : '0',
    received_qty: received,
    execution: order.execution,
    priority: order.priority,
    due_date: order.due_date,
    planned_start: order.planned_start,
    planned_end: order.planned_end,
    product_snapshot: order.product_snapshot,
    production_plan_id: order.production_plan_id,
    production_plan_code: order.production_plan_code ?? '',
    production_plan_name: order.production_plan_name ?? '',
    contract_id: order.contract_id ?? null,
    contract_line_id: order.contract_line_id ?? null,
    contract_code: order.contract_code ?? '',
    process_progress: { done: completed, total: tasks.length },
    task_progress: { done: qtyText(tasks.reduce((sum, task) => sum + q(String(task.approved_good)), 0n)), total: qtyText(tasks.reduce((sum, task) => sum + q(String(task.plan_qty)), 0n)) },
    inbound_progress: { done: qtyText(q(received)), total: qtyText(q(planQty)) },
    ring_tasks,
    current_process: current ? (current.process_snapshot as { name?: string })?.name ?? '' : '',
    issue_status: '—',
    stock_qty: stock ?? '',
    created_at: order.created_at,
    version: order.version,
    overdue: Boolean(order.is_overdue),
    order_paused: order.order_paused,
    schedule_no: Number(order.schedule_no ?? 0),
    parent_id: order.parent_id ?? null,
    project_id: order.project_id ?? null,
    project_code: order.project_code ?? '',
    project_name: order.project_name ?? '',
    started_at: order.started_at ?? null,
    completed_at: order.completed_at ?? null,
    pause_reason: order.execution === 'paused' ? String(order.close_reason || '') : '',
    cancel_reason: order.execution === 'cancelled' ? String(order.close_reason || '') : '',
    note: order.note ?? '',
    creator_name: await memberName(sql, order.created_by ? String(order.created_by) : null),
    hours_text: hoursText,
    issued_qty: String(order.issued_qty ?? '0'),
    fg_qty: String(order.received_qty ?? '0'),
    semi_qty: String(order.semi_qty ?? '0'),
    return_qty: String(order.return_qty ?? '0'),
    category_name: (order.product_snapshot as { category_name?: string })?.category_name ?? '',
  };
}

function periodRange(period: string) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const endOfMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
  if (period === 'prev_month') {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    return { start: `${py}-${pad(pm + 1)}-01 00`, end: `${py}-${pad(pm + 1)}-${pad(endOfMonth(py, pm))} 23` };
  }
  if (period === 'next_month') {
    const nm = m === 11 ? 0 : m + 1;
    const ny = m === 11 ? y + 1 : y;
    return { start: `${ny}-${pad(nm + 1)}-01 00`, end: `${ny}-${pad(nm + 1)}-${pad(endOfMonth(ny, nm))} 23` };
  }
  if (period === 'quarter') {
    const qm = Math.floor(m / 3) * 3;
    return { start: `${y}-${pad(qm + 1)}-01 00`, end: `${y}-${pad(qm + 3)}-${pad(endOfMonth(y, qm + 2))} 23` };
  }
  if (period === 'year') return { start: `${y}-01-01 00`, end: `${y}-12-31 23` };
  return { start: `${y}-${pad(m + 1)}-01 00`, end: `${y}-${pad(m + 1)}-${pad(endOfMonth(y, m))} 23` };
}

export function registerProgress(app: FastifyInstance, services: Services) {
  const { database, authorize, context, actor } = services;
  const guard = authorize();
  const run = <T>(request: Parameters<typeof context>[0], work: (sql: Sql, a: Actor) => Promise<T>) => database.tenant(context(request), async (sql) => { const a = actor(request); requireAllScope(a); await gateTenantWrite(sql, context(request)); return work(sql, a); });

  app.get('/api/production-plans', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const qy = request.query as Record<string, string>;
    const where = ['TRUE'];
    const params: unknown[] = [];
    const add = (text: string, value: unknown) => { params.push(value); where.push(text.replace('?', '$' + params.length)); };
    if (qy.code?.trim()) add('p.code ILIKE ?', '%' + qy.code.trim() + '%');
    if (qy.name?.trim()) add('p.name ILIKE ?', '%' + qy.name.trim() + '%');
    if (qy.analysis === 'analyzed') where.push('p.analyzed');
    if (qy.analysis === 'pending') where.push('NOT p.analyzed');
    if (qy.created_from) add('p.created_at::date >= ?::date', qy.created_from);
    if (qy.created_to) add('p.created_at::date <= ?::date', qy.created_to);
    const page = Math.max(1, Number(qy.page ?? '1'));
    const pageSize = Math.min(200, Number(qy.page_size ?? '30'));
    const filter = where.join(' AND ');
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM production_plans p WHERE ${filter}`, params)).rows[0]!.n);
    const rows = (await sql.query(`SELECT p.*, p.delivery_date::text FROM production_plans p WHERE ${filter} ORDER BY p.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)).rows;
    const items = await Promise.all(rows.map((row) => presentPlan(sql, row)));
    return { items, total, page, page_size: pageSize };
  }));

  app.get<{ Params: { id: string } }>('/api/production-plans/:id', { preHandler: guard, schema: { params: object(['id'], { id: uuid }) } }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const row = (await sql.query('SELECT *,delivery_date::text FROM production_plans WHERE id=$1', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '生产计划不存在');
    const plan = await presentPlan(sql, row);
    const lineRows = (await sql.query(
      `SELECT pl.*, pl.plan_qty::text, p.attribute FROM production_plan_lines pl JOIN products p ON p.tenant_id=pl.tenant_id AND p.id=pl.product_id WHERE pl.plan_id=$1 ORDER BY pl.line_no`,
      [request.params.id],
    )).rows;
    const lines = [];
    for (let index = 0; index < lineRows.length; index += 1) {
      const line = lineRows[index]!;
      const snap = (line.product_snapshot ?? {}) as { name?: string; code?: string; specification?: string; unit_name?: string; bom_id?: string; bom_code?: string; bom_label?: string };
      let bomId = snap.bom_id ?? null;
      let bomLabel = String(snap.bom_label ?? '').trim();
      if (!bomLabel || bomLabel === '无') {
        const bom = await defaultBomForProduct(sql, String(line.product_id));
        bomId = bom?.id ?? bomId;
        bomLabel = bomLabelOf(bom);
      }
      lines.push({
        id: line.id,
        sequence: line.line_no ?? index + 1,
        product_id: line.product_id,
        product_name: snap.name ?? '',
        product_code: snap.code ?? '',
        specification: snap.specification ?? '',
        contract_code: line.contract_code,
        customer_name: line.customer_name,
        source: sourceLabel(String(line.source_kind || '') || sourceKind(String(line.attribute ?? ''))),
        image_url: '',
        plan_qty: line.plan_qty,
        bom_id: bomId,
        bom_label: bomLabel || '无',
        unit_name: snap.unit_name || '无',
        note: String(line.note ?? '').trim() || '无',
      });
    }
    const analysisRows = (await sql.query(
      `SELECT a.*, a.created_at::text AS analyzed_at, al.plan_line_id
       FROM production_plan_analyses a
       LEFT JOIN production_plan_analysis_lines al ON al.tenant_id=a.tenant_id AND al.analysis_id=a.id AND al.demand_kind='process'
       WHERE a.plan_id=$1 ORDER BY a.created_at DESC`,
      [request.params.id],
    )).rows;
    const fallbackLineId = lines[0]?.id ?? null;
    const analysis_lines = [];
    for (const line of analysisRows) {
      analysis_lines.push({
        id: line.id,
        // 旧分析未写 analysis_lines 时回退到首条计划明细，避免「创建加工单」永久禁用
        plan_line_id: line.plan_line_id ?? fallbackLineId,
        plan_code: plan.code,
        plan_name: plan.name,
        status: line.status === 'void' ? '作废' : '有效',
        process_qty: qtyText(q(String(line.process_demand_qty))),
        outsource_qty: qtyText(q(String(line.outsource_demand_qty))),
        purchase_qty: qtyText(q(String(line.purchase_demand_qty))),
        note: '无',
        analyst_name: await memberName(sql, line.created_by ? String(line.created_by) : null) || '无',
        analyzed_at: line.analyzed_at,
        voided: line.status === 'void',
      });
    }
    const woIds = (await sql.query<{ id: string }>(
      `SELECT w.id FROM work_orders w JOIN production_plan_lines pl ON pl.tenant_id=w.tenant_id AND pl.id=w.production_plan_line_id WHERE pl.plan_id=$1 ORDER BY w.created_at DESC LIMIT 50`,
      [request.params.id],
    )).rows.map((item) => item.id);
    const work_orders = [];
    for (const id of woIds) {
      const view = (await workOrderView(sql, id)).work_order;
      const agg = await taskAggregates(sql, view.tasks.map((task) => task.id));
      work_orders.push(await mapWorkOrderListItem(sql, { ...view, production_plan_id: plan.id, production_plan_code: plan.code, production_plan_name: plan.name, received_qty: view.received_qty, is_overdue: false }, view.tasks, agg));
    }
    return { plan: { ...plan, lines, analysis_lines, work_orders } };
  }));

  app.post<{ Body: { request_key: string; name: string; code?: string; delivery_date?: string | null; note?: string; lines?: { product_id: string; plan_qty: string; contract_code?: string; customer_name?: string; source?: string; note?: string }[] } }>('/api/production-plans', { preHandler: guard }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const name = (request.body.name ?? '').trim();
    if (!name) throw new Problem(422, 'NAME_REQUIRED', '请填写计划名称', 'name');
    const code = (request.body.code ?? '').trim() || await serial(sql, a.tenant_id, 'JH', todayISO().replace(/-/g, ''), 3);
    const id = (await sql.query<{ id: string }>(
      'INSERT INTO production_plans(tenant_id,code,name,delivery_date,note,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [a.tenant_id, code, name, request.body.delivery_date ?? null, request.body.note ?? '', a.user_id],
    )).rows[0]!.id;
    const lines = request.body.lines ?? [];
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      const product = (await sql.query('SELECT p.*,u.name AS unit_name FROM products p JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id WHERE p.id=$1', [line.product_id])).rows[0];
      if (!product) throw new Problem(422, 'INVALID_REFERENCE', '商品不存在');
      const bom = await defaultBomForProduct(sql, String(line.product_id));
      const snapshot = { code: product.code, name: product.name, specification: product.specification, unit_name: product.unit_name, bom_id: bom?.id ?? null, bom_code: bom?.code ?? '', bom_label: bomLabelOf(bom) };
      await sql.query(
        'INSERT INTO production_plan_lines(tenant_id,plan_id,line_no,product_id,product_snapshot,contract_code,customer_name,source_kind,plan_qty,note) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
        [a.tenant_id, id, lineNo, line.product_id, JSON.stringify(snapshot), line.contract_code ?? '', line.customer_name ?? '', line.source ? (line.source === '外购' ? 'purchase' : line.source === '外协加工' ? 'outsource' : 'self') : sourceKind(String(product.attribute)), formatDecimal(decimal(line.plan_qty, { positive: true, label: '计划数', field: 'plan_qty' })), line.note ?? ''],
      );
    }
    return { plan: await presentPlan(sql, (await sql.query('SELECT *,delivery_date::text FROM production_plans WHERE id=$1', [id])).rows[0]!) };
  }));

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/production-plans/:id', { preHandler: guard }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const row = (await sql.query('SELECT * FROM production_plans WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '生产计划不存在');
    const name = (request.body.name as string | undefined)?.trim() || row.name;
    await sql.query('UPDATE production_plans SET name=$1,delivery_date=$2,note=$3,version=version+1,updated_at=now() WHERE id=$4', [name, request.body.delivery_date ?? row.delivery_date, request.body.note ?? row.note, request.params.id]);
    const lines = request.body.lines as { product_id: string; plan_qty: string; contract_code?: string; customer_name?: string; source?: string; note?: string }[] | undefined;
    if (lines) {
      await sql.query('DELETE FROM production_plan_lines WHERE plan_id=$1', [request.params.id]);
      let lineNo = 0;
      for (const line of lines) {
        lineNo += 1;
        const product = (await sql.query('SELECT p.*,u.name AS unit_name FROM products p JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id WHERE p.id=$1', [line.product_id])).rows[0];
        if (!product) throw new Problem(422, 'INVALID_REFERENCE', '商品不存在');
        const bom = await defaultBomForProduct(sql, String(line.product_id));
        const snapshot = { code: product.code, name: product.name, specification: product.specification, unit_name: product.unit_name, bom_id: bom?.id ?? null, bom_code: bom?.code ?? '', bom_label: bomLabelOf(bom) };
        await sql.query(
          'INSERT INTO production_plan_lines(tenant_id,plan_id,line_no,product_id,product_snapshot,contract_code,customer_name,source_kind,plan_qty,note) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
          [a.tenant_id, request.params.id, lineNo, line.product_id, JSON.stringify(snapshot), line.contract_code ?? '', line.customer_name ?? '', line.source ? (line.source === '外购' ? 'purchase' : line.source === '外协加工' ? 'outsource' : 'self') : sourceKind(String(product.attribute)), formatDecimal(decimal(line.plan_qty, { positive: true, label: '计划数', field: 'plan_qty' })), line.note ?? ''],
        );
      }
    }
    return { plan: await presentPlan(sql, (await sql.query('SELECT *,delivery_date::text FROM production_plans WHERE id=$1', [request.params.id])).rows[0]!) };
  }));

  app.delete<{ Params: { id: string } }>('/api/production-plans/:id', { preHandler: guard }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const linked = (await sql.query('SELECT w.id FROM work_orders w JOIN production_plan_lines pl ON pl.tenant_id=w.tenant_id AND pl.id=w.production_plan_line_id WHERE pl.plan_id=$1 LIMIT 1', [request.params.id])).rows[0];
    if (linked) throw new Problem(409, 'PLAN_HAS_WORK_ORDERS', '已经有加工单的生产计划不能删除');
    await sql.query('DELETE FROM production_plans WHERE id=$1', [request.params.id]);
    return { ok: true };
  }));

  app.get<{ Params: { id: string } }>('/api/production-plan-lines/:id/prefill', { preHandler: guard, schema: { params: object(['id'], { id: uuid }) } }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const line = (await sql.query(
      `SELECT pl.*, pl.plan_qty::text, p.attribute FROM production_plan_lines pl JOIN products p ON p.id=pl.product_id WHERE pl.id=$1`,
      [request.params.id],
    )).rows[0];
    if (!line) throw new Problem(404, 'NOT_FOUND', '计划行不存在');
    const released = q((await sql.query<{ n: string }>(
      'SELECT coalesce(sum(plan_qty),0)::text AS n FROM work_orders WHERE production_plan_line_id=$1 AND execution<>\'cancelled\'',
      [request.params.id],
    )).rows[0]!.n);
    const planQty = q(String(line.plan_qty));
    const remaining = planQty > released ? planQty - released : 0n;
    const bom = (await sql.query<{ id: string; current_version_id: string }>(
      'SELECT id,current_version_id FROM bom_definitions WHERE parent_product_id=$1 AND active ORDER BY is_default DESC, created_at DESC LIMIT 1',
      [line.product_id],
    )).rows[0];
    return {
      product_id: line.product_id,
      product_name: (line.product_snapshot as { name?: string })?.name ?? '',
      plan_qty: qtyText(planQty),
      remaining_qty: qtyText(remaining),
      bom_id: bom?.id ?? null,
      bom_version_id: bom?.current_version_id ?? null,
    };
  }));

  app.post<{ Params: { id: string } }>('/api/production-plans/:id/analyze', { preHandler: guard }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const plan = (await sql.query('SELECT * FROM production_plans WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!plan) throw new Problem(404, 'NOT_FOUND', '生产计划不存在');
    const existingActive = (await sql.query<{ id: string }>("SELECT id FROM production_plan_analyses WHERE plan_id=$1 AND status<>'void' ORDER BY created_at DESC LIMIT 1", [request.params.id])).rows[0];
    if (existingActive) {
      await sql.query('UPDATE production_plans SET analyzed=true,version=version+1,updated_at=now() WHERE id=$1', [request.params.id]);
      return { ok: true, analysis_id: existingActive.id, reused: true };
    }
    const result = await runMaterialAnalysis(sql, a, request.params.id, { stock_main: true, stock_mat: true, occupy: true, ceil: true, wip: true, inbound: true, occupy_out: true }, '');
    return { ok: true, analysis_id: result.analysis_id };
  }));

  app.post<{ Params: { id: string; lineId: string } }>('/api/production-plans/:id/analysis-lines/:lineId/void', { preHandler: guard }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    // lineId 实际是 production_plan_analyses.id；按 analysis_id 查是否已下达加工单。
    const released = (await sql.query(
      'SELECT w.id FROM work_orders w JOIN production_plan_analysis_lines al ON al.plan_line_id=w.production_plan_line_id WHERE al.analysis_id=$1 LIMIT 1',
      [request.params.lineId],
    )).rows[0];
    if (released) throw new Problem(409, 'HAS_WORK_ORDERS', '已经下达了加工单的不能作废');
    await sql.query("UPDATE production_plan_analyses SET status='void' WHERE id=$1", [request.params.lineId]);
    const stillActive = (await sql.query<{ n: string }>("SELECT count(*)::text AS n FROM production_plan_analyses WHERE plan_id=$1 AND status<>'void'", [request.params.id])).rows[0]!.n;
    if (Number(stillActive) === 0) {
      await sql.query('UPDATE production_plans SET analyzed=false,version=version+1 WHERE id=$1', [request.params.id]);
    } else {
      await sql.query('UPDATE production_plans SET version=version+1 WHERE id=$1', [request.params.id]);
    }
    return { ok: true };
  }));

  app.get('/api/progress/work-orders', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const qy = request.query as Record<string, string>;
    const where = ['TRUE'];
    const params: unknown[] = [];
    const add = (text: string, value: unknown) => { params.push(value); where.push(text.replace('?', '$' + params.length)); };
    if (qy.status) add('w.execution=?', qy.status);
    if (qy.priority) add('w.priority=?', qy.priority);
    if (qy.overdue === '1') where.push(workOrderOverdueSql('w'));
    if (qy.overdue === '0') where.push(`NOT ${workOrderOverdueSql('w')}`);
    if (qy.code?.trim()) add('w.code ILIKE ?', '%' + qy.code.trim() + '%');
    if (qy.plan?.trim()) { const needle = '%' + qy.plan.trim() + '%'; params.push(needle); where.push(`(pp.code ILIKE $${params.length} OR pp.name ILIKE $${params.length})`); }
    if (qy.product?.trim()) { params.push('%' + qy.product.trim() + '%'); where.push(`(w.product_snapshot->>'name' ILIKE $${params.length} OR w.product_snapshot->>'code' ILIKE $${params.length})`); }
    const filter = where.join(' AND ');
    const page = Math.max(1, Number(qy.page ?? '1'));
    const pageSize = Math.min(200, Number(qy.page_size ?? '10'));
    const from = `FROM work_orders w LEFT JOIN production_plan_lines pl ON pl.tenant_id=w.tenant_id AND pl.id=w.production_plan_line_id LEFT JOIN production_plans pp ON pp.tenant_id=pl.tenant_id AND pp.id=pl.plan_id LEFT JOIN money_contracts mc ON mc.tenant_id=w.tenant_id AND mc.id=w.contract_id LEFT JOIN production_projects pj ON pj.tenant_id=w.tenant_id AND pj.id=w.project_id`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from} WHERE ${filter}`, params)).rows[0]!.n);
    const orders = (await sql.query(
      `SELECT w.id,w.code,w.plan_qty::text,w.execution,w.priority,w.due_date::text,w.planned_start::text,w.planned_end::text,w.product_snapshot,w.version,w.order_paused,w.created_at,w.contract_id,w.contract_line_id,coalesce(mc.code,'') AS contract_code,
        pp.id AS production_plan_id, pp.code AS production_plan_code, pp.name AS production_plan_name,
        w.schedule_no, w.parent_id, w.project_id, coalesce(pj.code,'') AS project_code, coalesce(pj.name,'') AS project_name,
        w.started_at, w.completed_at, w.close_reason, w.note, w.created_by,
        (${workOrderOverdueSql('w')}) AS is_overdue,
        (SELECT coalesce(sum(quantity),0)::text FROM fg_receipts WHERE work_order_id=w.id AND approval='approved') AS received_qty,
        (SELECT coalesce(sum(mil.quantity),0)::text FROM material_issues mi JOIN material_issue_lines mil ON mil.issue_id=mi.id WHERE mi.work_order_id=w.id AND mi.approval='approved') AS issued_qty,
        '0'::text AS semi_qty, '0'::text AS return_qty
       ${from} WHERE ${filter} ORDER BY CASE WHEN w.schedule_no>0 THEN 0 ELSE 1 END, w.schedule_no, w.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    )).rows;
    const ids = orders.map((order) => order.id);
    const tasks = ids.length ? (await sql.query(
      `SELECT id,work_order_id,sequence,process_snapshot,execution,plan_qty::text,approved_good::text,approved_defect::text,unit_ratio::text,is_output,planned_start::text,planned_end::text FROM work_order_tasks WHERE work_order_id=ANY($1::uuid[]) ORDER BY sequence`,
      [ids],
    )).rows : [];
    const taskByWo = new Map<string, Record<string, unknown>[]>();
    tasks.forEach((task) => {
      const list = taskByWo.get(String(task.work_order_id)) ?? [];
      list.push(task);
      taskByWo.set(String(task.work_order_id), list);
    });
    const agg = await taskAggregates(sql, tasks.map((task) => String(task.id)));
    const items = await Promise.all(orders.map((order) => mapWorkOrderListItem(sql, order, taskByWo.get(String(order.id)) ?? [], agg)));
    const counts = (await sql.query<{ all: string; not_started: string; running: string; paused: string; completed: string; cancelled: string; overdue: string; on_time: string; urgent: string; normal: string; delayed: string }>(
      `SELECT count(*)::text AS all,
        count(*) FILTER (WHERE w.execution='not_started')::text AS not_started,
        count(*) FILTER (WHERE w.execution='running')::text AS running,
        count(*) FILTER (WHERE w.execution='paused')::text AS paused,
        count(*) FILTER (WHERE w.execution='completed')::text AS completed,
        count(*) FILTER (WHERE w.execution='cancelled')::text AS cancelled,
        count(*) FILTER (WHERE ${workOrderOverdueSql('w')})::text AS overdue,
        count(*) FILTER (WHERE NOT ${workOrderOverdueSql('w')})::text AS on_time,
        count(*) FILTER (WHERE w.priority='urgent')::text AS urgent,
        count(*) FILTER (WHERE w.priority='normal')::text AS normal,
        count(*) FILTER (WHERE w.priority='delayed')::text AS delayed
       FROM work_orders w`,
    )).rows[0]!;
    const summary = (await sql.query<{ plan: string; output: string }>(
      `SELECT coalesce(sum(w.plan_qty),0)::text AS plan,
        coalesce(sum(t.approved_good),0)::text AS output
       ${from}
       LEFT JOIN work_order_tasks t ON t.work_order_id=w.id AND t.is_output
       WHERE ${filter}`,
      params,
    )).rows[0]!;
    return {
      items,
      total,
      page,
      page_size: pageSize,
      counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
      summary: { plan_qty: summary.plan, output_qty: summary.output },
    };
  }));

  app.put<{ Body: { ids: string[] } }>('/api/work-orders/schedule', { preHandler: guard, schema: { body: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', items: uuid, minItems: 1 } } } } }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const ids = request.body.ids;
    for (let index = 0; index < ids.length; index += 1) {
      await sql.query('UPDATE work_orders SET schedule_no=$1,updated_at=now() WHERE id=$2 AND parent_id IS NULL', [index + 1, ids[index]]);
    }
    return { ok: true };
  }));

  app.patch<{ Params: { id: string }; Body: { version: number; planned_start?: string | null; planned_end?: string | null; due_date?: string | null; priority?: string; note?: string } }>('/api/work-orders/:id/plan-fields', { preHandler: guard }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const order = (await sql.query('SELECT * FROM work_orders WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!order) throw new Problem(404, 'WORK_ORDER_NOT_FOUND', '加工单不存在');
    if (Number(order.version) !== Number(request.body.version)) throw new Problem(409, 'VERSION_CONFLICT', '加工单已被修改，请刷新');
    await sql.query(
      'UPDATE work_orders SET planned_start=$1,planned_end=$2,due_date=$3,priority=$4,note=$5,version=version+1,updated_at=now() WHERE id=$6',
      [request.body.planned_start ?? order.planned_start, request.body.planned_end ?? order.planned_end, request.body.due_date ?? order.due_date, request.body.priority ?? order.priority, request.body.note ?? order.note, request.params.id],
    );
    return workOrderView(sql, request.params.id);
  }));

  app.get('/api/progress/scheduling', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const qy = request.query as Record<string, string>;
    const range = periodRange(qy.period ?? 'month');
    const startDate = range.start.slice(0, 10);
    const endDate = range.end.slice(0, 10);
    const where = ['w.planned_start IS NOT NULL', 'w.planned_end IS NOT NULL', 'w.planned_start <= $1::date', 'w.planned_end >= $2::date'];
    const params: unknown[] = [endDate, startDate];
    if (qy.keyword?.trim()) { params.push('%' + qy.keyword.trim() + '%'); where.push(`w.code ILIKE $${params.length}`); }
    if (qy.code?.trim()) { params.push('%' + qy.code.trim() + '%'); where.push(`w.code ILIKE $${params.length}`); }
    if (qy.product?.trim()) { params.push('%' + qy.product.trim() + '%'); where.push(`(coalesce(w.product_snapshot->>'name','') ILIKE $${params.length} OR coalesce(w.product_snapshot->>'code','') ILIKE $${params.length})`); }
    const filter = where.join(' AND ');
    const page = Math.max(1, Number(qy.page ?? '1'));
    const pageSize = Math.min(50, Number(qy.page_size ?? '10'));
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_orders w WHERE ${filter}`, params)).rows[0]!.n);
    const rows = (await sql.query(
      `SELECT w.id,w.code,w.planned_start::text,w.planned_end::text,w.priority,w.execution,w.product_snapshot,w.started_at,w.completed_at,w.plan_qty::text
       FROM work_orders w WHERE ${filter}
       ORDER BY CASE w.execution WHEN 'completed' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, w.planned_start
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    )).rows;
    const items = [];
    for (const row of rows) {
      const tasks = (await sql.query('SELECT * FROM work_order_tasks WHERE work_order_id=$1', [row.id])).rows;
      const good = tasks.reduce((sum, task) => sum + q(String(task.approved_good)), 0n);
      const plan = tasks.reduce((sum, task) => sum + q(String(task.plan_qty)), 0n);
      const pct = floorPercent(good, plan);
      const start = row.started_at ? new Date(String(row.started_at)).getTime() : null;
      const end = row.execution === 'completed' && row.completed_at ? new Date(String(row.completed_at)).getTime() : Date.now();
      const elapsed = start ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
      const current = tasks.find((task) => task.execution !== 'completed');
      items.push({
        id: row.id,
        code: row.code,
        planned_start: row.planned_start,
        planned_end: row.planned_end,
        priority: row.priority,
        product_name: (row.product_snapshot as { name?: string })?.name ?? '',
        product_code: (row.product_snapshot as { name?: string; code?: string })?.code ?? '',
        specification: (row.product_snapshot as { specification?: string })?.specification || '无',
        current_process: (current ? (current.process_snapshot as { name?: string })?.name : '') || '无',
        elapsed_seconds: elapsed,
        task_progress_pct: pct,
        execution: row.execution,
      });
    }
    const cards = (await sql.query<{ k: string; n: string }>(
      `SELECT w.execution AS k, count(*)::text AS n FROM work_orders w WHERE ${filter} GROUP BY w.execution`,
      params,
    )).rows;
    const cardMap: Record<string, number> = { not_started: 0, running: 0, completed: 0, paused: 0, cancelled: 0, overdue: 0 };
    cards.forEach((row) => { cardMap[row.k] = Number(row.n); });
    cardMap.overdue = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_orders w WHERE ${filter} AND ${workOrderOverdueSql('w')}`, params)).rows[0]!.n);
    const bar = (await sql.query<{ plan: string; output: string; received: string }>(
      `SELECT coalesce(sum(w.plan_qty),0)::text AS plan,
        coalesce(sum(t.approved_good),0)::text AS output,
        coalesce(sum(f.qty),0)::text AS received
       FROM work_orders w
       LEFT JOIN work_order_tasks t ON t.work_order_id=w.id AND t.is_output
       LEFT JOIN LATERAL (SELECT sum(quantity) AS qty FROM fg_receipts WHERE work_order_id=w.id AND approval='approved') f ON TRUE
       WHERE ${filter}`,
      params,
    )).rows[0]!;
    const quality = (await sql.query<{ good: string; bad: string }>(
      `SELECT coalesce(sum(t.approved_good),0)::text AS good, coalesce(sum(t.approved_defect),0)::text AS bad
       FROM work_orders w JOIN work_order_tasks t ON t.work_order_id=w.id WHERE ${filter}`,
      params,
    )).rows[0]!;
    const good = q(quality.good), bad = q(quality.bad);
    const totalQ = good + bad;
    const goodRate = totalQ === 0n ? 0 : Number((good * 10000n) / totalQ) / 100;
    const statusRows = (await sql.query<{ execution: string; n: string }>(`SELECT execution, count(*)::text AS n FROM work_orders w WHERE ${filter} GROUP BY execution`, params)).rows;
    return {
      items,
      total,
      cards: cardMap,
      charts: {
        status_pie: statusRows.map((row) => ({ name: ({ not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' } as Record<string, string>)[String(row.execution)] ?? String(row.execution), value: Number(row.n) })),
        bar: { plan_qty: qtyText(q(bar.plan)), output_qty: qtyText(q(bar.output)), received_qty: qtyText(q(bar.received)) },
        quality_pie: { good_rate: goodRate, defect_rate: totalQ === 0n ? 0 : 100 - goodRate },
      },
      range,
    };
  }));
}
