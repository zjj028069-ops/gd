import type { FastifyInstance } from 'fastify';
import type { Services } from './services.js';
import { Problem } from './services.js';
import { num, withTenant } from './round8-kit.js';

const todaySql = `(r.created_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date`;

export function registerReportWorkbench(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], permission: string, work: Parameters<typeof withTenant>[3]) => withTenant(services, request, permission, work);

  app.get('/api/report-workbench/today', (request) => read(request, 'production.read', async (sql, actor) => {
    const query = request.query as { page?: string; page_size?: string };
    const page = Math.max(1, Number(query.page ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.page_size ?? '30') || 30));
    const self = !actor.permissions.includes('production.approve');
    const params: unknown[] = [];
    let who = 'TRUE';
    if (self) { params.push(actor.user_id); who = `r.operator_id=$${params.length}`; }
    const where = `r.approval='approved' AND ${todaySql} AND ${who}`;
    const summary = (await sql.query<{ reports: string; good: string; defect: string }>(
      `SELECT count(*)::text AS reports, coalesce(sum(r.good_qty),0)::text AS good, coalesce(sum(r.defect_qty),0)::text AS defect
       FROM production_reports r WHERE ${where}`,
      params,
    )).rows[0]!;
    const total = Number(summary.reports);
    const rows = (await sql.query(
      `SELECT r.id,r.code,r.version,r.good_qty::text,r.defect_qty::text,r.created_at,r.operator_id,r.reporter_id,r.settlement_status,r.note,r.defect_note,r.effective_seconds,r.started_at,r.ended_at,r.task_id,r.work_order_id,r.machine_id,
        w.code AS work_order_code, coalesce(w.product_snapshot->>'name','') AS product_name,
        coalesce(t.process_snapshot->>'name','') AS process_name, t.pricing_mode, t.wage_rate::text AS wage_rate,
        coalesce((SELECT sum(qty)::text FROM r8_report_defects d WHERE d.report_id=r.id),'0') AS defect_qty_sum,
        coalesce(m.name,'') AS machine_name
       FROM production_reports r
       JOIN work_orders w ON w.tenant_id=r.tenant_id AND w.id=r.work_order_id
       JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
       LEFT JOIN r8_machines m ON m.tenant_id=r.tenant_id AND m.id=r.machine_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    )).rows;
    const good = num(summary.good);
    const defect = num(summary.defect);
    return {
      summary: { count: total, good_qty: good, defect_qty: defect, report_qty: num(Number(summary.good) + Number(summary.defect)) },
      items: rows.map((row) => ({ ...row, good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), defect_qty_sum: num(row.defect_qty_sum), wage_rate: row.wage_rate == null ? null : num(row.wage_rate) })),
      total, page, page_size: pageSize,
    };
  }));

  app.get('/api/report-workbench/options', (request) => read(request, 'production.report', async (sql, actor) => {
    const query = request.query as { work_order_id?: string; q?: string; task_id?: string };
    const approver = actor.permissions.includes('production.approve');
    const params: unknown[] = [];
    const where = ["w.execution='running'"];
    if (query.work_order_id) { params.push(query.work_order_id); where.push(`w.id=$${params.length}`); }
    if (query.q?.trim()) { params.push('%' + query.q.trim() + '%'); where.push(`(w.code ILIKE $${params.length} OR w.product_snapshot->>'name' ILIKE $${params.length})`); }
    if (!approver) { params.push(actor.user_id); where.push(`EXISTS (SELECT 1 FROM work_order_tasks t JOIN process_reporters r ON r.tenant_id=t.tenant_id AND r.process_id=t.process_id AND r.user_id=$${params.length} WHERE t.work_order_id=w.id AND t.execution IN ('running','not_started'))`); }
    else where.push(`EXISTS (SELECT 1 FROM work_order_tasks t WHERE t.work_order_id=w.id AND t.execution IN ('running','not_started'))`);
    const orders = (await sql.query(
      `SELECT w.id,w.code,w.plan_qty::text,w.execution,w.due_date::text,w.product_snapshot,w.version
       FROM work_orders w WHERE ${where.join(' AND ')} ORDER BY w.created_at DESC LIMIT 50`,
      params,
    )).rows;
    const orderIds = orders.map((row) => String(row.id));
    const taskParams: unknown[] = [orderIds];
    let taskWho = 'TRUE';
    if (!approver) { taskParams.push(actor.user_id); taskWho = `EXISTS (SELECT 1 FROM process_reporters r WHERE r.tenant_id=t.tenant_id AND r.process_id=t.process_id AND r.user_id=$${taskParams.length})`; }
    const tasks = orderIds.length ? (await sql.query(
      `SELECT t.id,t.work_order_id,t.sequence,t.execution,t.plan_qty::text,t.approved_good::text,t.pricing_mode,t.wage_rate::text,t.inspection_scheme,t.process_id,t.process_snapshot,t.version
       FROM work_order_tasks t
       WHERE t.work_order_id = ANY($1::uuid[]) AND t.execution IN ('running','not_started') AND ${taskWho}
       ORDER BY t.sequence`,
      taskParams,
    )).rows : [];
    const processIds = [...new Set(tasks.map((task) => String(task.process_id)))];
    const reporters = processIds.length ? (await sql.query<{ process_id: string; user_id: string; display_name: string }>(
      `SELECT r.process_id,r.user_id,m.display_name FROM process_reporters r JOIN tenant_team_members m ON m.id=r.user_id WHERE r.process_id = ANY($1::uuid[]) ORDER BY m.display_name`,
      [processIds],
    )).rows : [];
    const defects = (await sql.query('SELECT id,code,name FROM r8_defect_items ORDER BY created_at DESC, code')).rows;
    const machines = (await sql.query("SELECT id,code,name FROM r8_machines WHERE enabled ORDER BY code")).rows;
    return {
      work_orders: orders.map((row) => ({
        id: row.id, code: row.code, plan_qty: num(row.plan_qty), execution: row.execution, due_date: row.due_date, product_name: (row.product_snapshot as { name?: string })?.name ?? '', product_code: (row.product_snapshot as { code?: string })?.code ?? '',
      })),
      tasks: tasks.map((task) => ({
        id: task.id, work_order_id: task.work_order_id, sequence: task.sequence, execution: task.execution,
        process_name: (task.process_snapshot as { name?: string })?.name ?? '',
        plan_qty: num(task.plan_qty), approved_good: num(task.approved_good),
        remaining_qty: num(Math.max(0, Number(task.plan_qty) - Number(task.approved_good))),
        pricing_mode: task.pricing_mode, wage_rate: task.wage_rate == null ? null : num(task.wage_rate),
        inspection_scheme: task.inspection_scheme, process_id: task.process_id, version: task.version,
        reporters: reporters.filter((item) => item.process_id === task.process_id).map((item) => ({ id: item.user_id, name: item.display_name })),
      })),
      defect_items: defects,
      machines,
      self: { id: actor.user_id, name: actor.display_name },
      can_proxy: approver,
    };
  }));

  app.get('/api/report-workbench/extras', (request) => read(request, 'production.read', async (sql) => {
    const rows = (await sql.query(
      `SELECT r.id AS report_id, coalesce(m.name,'') AS machine_name, coalesce(sum(d.qty),0)::text AS defect_qty_sum, count(d.defect_item_id)::text AS defect_count
       FROM production_reports r
       LEFT JOIN r8_machines m ON m.tenant_id=r.tenant_id AND m.id=r.machine_id
       LEFT JOIN r8_report_defects d ON d.tenant_id=r.tenant_id AND d.report_id=r.id
       GROUP BY r.id, m.name
       ORDER BY max(r.created_at) DESC LIMIT 200`,
    )).rows;
    return { items: rows.map((row) => ({ ...row, defect_qty_sum: num(row.defect_qty_sum), defect_count: Number(row.defect_count) })) };
  }));

  app.get('/api/mobile-cards', (request) => read(request, 'production.read', async (sql) => {
    const page = String((request.query as { page_key?: string }).page_key ?? '');
    const rows = (await sql.query<{ page_key: string; tab_key: string; fields: string[]; version: number }>(
      page ? 'SELECT page_key,tab_key,fields,version FROM r9_mobile_cards WHERE page_key=$1 ORDER BY tab_key' : 'SELECT page_key,tab_key,fields,version FROM r9_mobile_cards ORDER BY page_key,tab_key',
      page ? [page] : [],
    )).rows;
    return { items: rows };
  }));

  app.put('/api/mobile-cards', (request) => read(request, 'production.read', async (sql, actor) => {
    if (actor.role !== 'admin') throw new Problem(403, 'FORBIDDEN', '只有管理员可以修改移动端卡片配置');
    const body = (request.body ?? {}) as { page_key?: string; tab_key?: string; fields?: string[]; version?: number };
    const pageKey = String(body.page_key ?? '').trim();
    const tabKey = String(body.tab_key ?? '').trim();
    if (!pageKey || !tabKey) throw new Problem(422, 'REQUIRED', '请选择卡片页签');
    const fields = Array.isArray(body.fields) ? body.fields.map(String).slice(0, 40) : [];
    const current = (await sql.query<{ version: number }>('SELECT version FROM r9_mobile_cards WHERE page_key=$1 AND tab_key=$2', [pageKey, tabKey])).rows[0];
    if (current && body.version !== undefined && Number(body.version) !== current.version) throw new Problem(409, 'VERSION_CONFLICT', '卡片配置已被修改，请刷新');
    await sql.query(
      `INSERT INTO r9_mobile_cards(tenant_id,page_key,tab_key,fields,updated_by) VALUES($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (tenant_id,page_key,tab_key) DO UPDATE SET fields=EXCLUDED.fields, version=r9_mobile_cards.version+1, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [actor.tenant_id, pageKey, tabKey, JSON.stringify(fields), actor.user_id],
    );
    const saved = (await sql.query('SELECT page_key,tab_key,fields,version FROM r9_mobile_cards WHERE page_key=$1 AND tab_key=$2', [pageKey, tabKey])).rows[0];
    return { item: saved };
  }));
}
