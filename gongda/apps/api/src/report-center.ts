import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { requireAllScope, type Services } from './services.js';
import { permit } from './business-common.js';
import { q, qtyText } from './progress-calc.js';

function periodDates(period: string) {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const end = new Date(y, m + 1, 0).getDate();
  if (period === '昨天' || period === 'yesterday') {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    const ds = d.toISOString().slice(0, 10);
    return { start: ds, end: ds };
  }
  if (period === '今天' || period === 'today') return { start: today.toISOString().slice(0, 10), end: today.toISOString().slice(0, 10) };
  if (period === '本周') {
    const day = today.getDay() || 7;
    const monday = new Date(today); monday.setDate(today.getDate() - day + 1);
    return { start: monday.toISOString().slice(0, 10), end: today.toISOString().slice(0, 10) };
  }
  if (period === '本季度') {
    const qm = Math.floor(m / 3) * 3;
    return { start: `${y}-${pad(qm + 1)}-01`, end: today.toISOString().slice(0, 10) };
  }
  if (period === '本年') return { start: `${y}-01-01`, end: `${y}-12-31` };
  return { start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(end)}` };
}

export function registerReportCenter(app: FastifyInstance, services: Services) {
  const { database, authorize, context, actor } = services;
  const guard = authorize();

  app.get('/api/progress/reports/output', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const qy = request.query as Record<string, string>;
    const range = periodDates(qy.period ?? '本月');
    const dimension = qy.dimension ?? 'product';
    const onlyOutput = dimension === 'product';
    const rows = (await sql.query(
      `SELECT w.product_snapshot, t.process_snapshot, w.code AS work_order_code, r.good_qty::text, r.defect_qty::text, r.created_at::date::text AS day, t.is_output
       FROM production_reports r
       JOIN work_order_tasks t ON t.id=r.task_id
       JOIN work_orders w ON w.id=r.work_order_id
       WHERE r.approval='approved' AND r.created_at::date BETWEEN $1::date AND $2::date
       ${onlyOutput ? 'AND t.is_output' : ''}`,
      [range.start, range.end],
    )).rows;
    type Key = string;
    const bucket = new Map<Key, { id: string; product_name: string; product_code: string; specification: string; unit_name: string; source: string; category: string; note: string; stock: string; work_order_code?: string; process_name?: string; good: bigint; defect: bigint; days: Map<string, { good: bigint; defect: bigint }> }>();
    for (const row of rows) {
      const snap = row.product_snapshot as { name?: string; code?: string; specification?: string; unit_name?: string };
      const proc = row.process_snapshot as { name?: string };
      const key = dimension.includes('process') ? `${snap.code}:${proc.name}:${row.work_order_code}` : dimension.includes('work_order') ? `${snap.code}:${row.work_order_code}` : String(snap.code);
      const current = bucket.get(key) ?? {
        id: key,
        product_name: snap.name ?? '',
        product_code: snap.code ?? '',
        specification: snap.specification || '无',
        unit_name: snap.unit_name || '无',
        source: '自产',
        category: '无',
        note: '无',
        stock: '0',
        work_order_code: dimension.includes('work_order') ? String(row.work_order_code) : undefined,
        process_name: dimension.includes('工序') || dimension.includes('process') ? proc.name : proc.name && dimension.includes('process') ? proc.name : dimension === 'product + 工序' ? proc.name : undefined,
        good: 0n,
        defect: 0n,
        days: new Map(),
      };
      if (dimension === 'product + 工序' || dimension === 'product + 加工单 + 工序') current.process_name = proc.name;
      if (dimension.includes('work_order')) current.work_order_code = String(row.work_order_code);
      const day = String(row.day);
      const dayRow = current.days.get(day) ?? { good: 0n, defect: 0n };
      dayRow.good += q(String(row.good_qty));
      dayRow.defect += q(String(row.defect_qty));
      current.days.set(day, dayRow);
      current.good += q(String(row.good_qty));
      current.defect += q(String(row.defect_qty));
      bucket.set(key, current);
    }
    const dayColumns = [...new Set(rows.map((row) => String(row.day)))].sort();
    const items = [...bucket.values()].map((row) => {
      const flat: Record<string, string> = {
        id: row.id,
        product_name: row.product_name,
        product_code: row.product_code,
        specification: row.specification,
        unit_name: row.unit_name,
        source: row.source,
        category: row.category,
        note: row.note,
        stock: row.stock,
        total_good: qtyText(row.good),
        total_defect: qtyText(row.defect),
      };
      if (row.work_order_code) flat.work_order_code = row.work_order_code;
      if (row.process_name) flat.process_name = row.process_name;
      dayColumns.forEach((day) => {
        const cell = row.days.get(day) ?? { good: 0n, defect: 0n };
        flat[`${day}_good`] = qtyText(cell.good);
        flat[`${day}_defect`] = qtyText(cell.defect);
      });
      return flat;
    });
    const columns = dayColumns;
    const totals: Record<string, string> = { total_good: qtyText(items.reduce((sum, row) => sum + q(row.total_good), 0n)) };
    return { items, columns, totals, range };
  }));

  app.get('/api/progress/reports/wip', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const qy = request.query as Record<string, string>;
    const range = periodDates(qy.period ?? '本月');
    const rows = (await sql.query(
      `SELECT w.code,w.execution,w.priority,w.product_snapshot,w.plan_qty::text,w.created_at,
        coalesce(sum(t.approved_good),0)::text AS good_qty,
        coalesce(sum(t.approved_defect),0)::text AS defect_qty
       FROM work_orders w
       LEFT JOIN work_order_tasks t ON t.work_order_id=w.id
       WHERE w.created_at::date BETWEEN $1::date AND $2::date
       GROUP BY w.id ORDER BY w.created_at DESC`,
      [range.start, range.end],
    )).rows;
    const execText: Record<string, string> = { not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
    const priorityText: Record<string, string> = { urgent: '加急', normal: '正常', delayed: '延期', none: '无' };
    const items = rows.map((row) => {
      const good = q(String(row.good_qty));
      const plan = q(String(row.plan_qty));
      const execution = String(row.execution ?? '');
      return {
        id: row.code,
        code: row.code,
        work_order_code: row.code,
        execution,
        status_text: execText[execution] ?? '未开始',
        product_name: (row.product_snapshot as { name?: string })?.name ?? '',
        product_code: (row.product_snapshot as { code?: string })?.code ?? '',
        specification: (row.product_snapshot as { specification?: string })?.specification || '无',
        priority: row.priority,
        priority_text: priorityText[String(row.priority ?? '')] ?? '无',
        plan_qty: qtyText(q(String(row.plan_qty))),
        good_qty: qtyText(good),
        defect_qty: qtyText(q(String(row.defect_qty))),
        pending_qty: qtyText(plan > good ? plan - good : 0n),
      };
    });
    const summary = {
      plan_qty: qtyText(items.reduce((sum, row) => sum + q(String(row.plan_qty)), 0n)),
      good_qty: qtyText(items.reduce((sum, row) => sum + q(String(row.good_qty)), 0n)),
      defect_qty: qtyText(items.reduce((sum, row) => sum + q(String(row.defect_qty)), 0n)),
      pending_qty: qtyText(items.reduce((sum, row) => sum + q(String(row.pending_qty)), 0n)),
    };
    return { items, summary };
  }));

  app.get('/api/progress/reports/clock', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const qy = request.query as Record<string, string>;
    const range = periodDates(qy.period ?? '本月');
    const rows = (await sql.query(
      `SELECT w.code AS work_order_code, coalesce(pp.code,'') AS project_code, coalesce(pp.name,'') AS project_name,
        coalesce(pl.code,'') AS plan_code, coalesce(pl.name,'') AS plan_name,
        t.process_snapshot->>'name' AS process_name,
        to_char(r.started_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS clock_text,
        to_char(r.ended_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS next_clock_text,
        CASE WHEN r.effective_seconds>0 THEN '计时' ELSE '报工' END AS clock_type,
        CASE WHEN lead(r.started_at) OVER (PARTITION BY r.task_id ORDER BY r.created_at) IS NOT NULL THEN '计时' ELSE '-' END AS next_clock_type,
        CASE WHEN r.effective_seconds>0 THEN '计时区间' ELSE '报工区间' END AS range_type,
        CASE WHEN r.effective_seconds>0 THEN concat(floor(r.effective_seconds/3600), '小时', floor((r.effective_seconds%3600)/60), '分') ELSE '-' END AS duration_text,
        m.display_name AS operator_name
       FROM production_reports r
       JOIN work_order_tasks t ON t.id=r.task_id
       JOIN work_orders w ON w.id=r.work_order_id
       LEFT JOIN production_projects pp ON pp.id=w.project_id
       LEFT JOIN production_plan_lines pll ON pll.id=w.production_plan_line_id
       LEFT JOIN production_plans pl ON pl.id=pll.plan_id
       JOIN tenant_team_members m ON m.id=r.operator_id
       WHERE r.approval='approved' AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date
       ORDER BY r.created_at DESC LIMIT 200`,
      [range.start, range.end],
    )).rows;
    return { items: rows, total: rows.length, page: 1, page_size: 30 };
  }));
}
