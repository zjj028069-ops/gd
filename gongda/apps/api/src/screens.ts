import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { gateTenantWrite } from './assets.js';
import { Problem, requireAllScope, type Actor, type Services } from './services.js';
import { permit } from './business-common.js';
import { q, qtyText, taskOverdueSql, workOrderOverdueSql } from './progress-calc.js';

const uuid = { type: 'string', format: 'uuid' };
const object = (required: string[], properties: Record<string, unknown>, optional: string[] = []) => ({ type: 'object', additionalProperties: false, required, properties: Object.fromEntries([...required, ...optional].map((key) => [key, properties[key]])) });
const passwordField = { type: 'string', maxLength: 16 };
const screenLayouts = ['默认', '四模块', '单模块', '左右双模块'];
const screenModuleKinds = ['生产模块', '设备维保模块', '仓库模块'];
const layoutSlots: Record<string, number> = { 默认: 6, 四模块: 4, 单模块: 1, 左右双模块: 2 };
const screenModuleLibrary: Record<string, { key: string; name: string }[]> = {
  生产模块: [
    { key: 'process_daily', name: '工序报工分析' }, { key: 'employee_rank', name: '员工报工排行' }, { key: 'cards', name: '指标卡' },
    { key: 'recent_reports', name: '实时报工数据' }, { key: 'defect_analysis', name: '不良品分析' }, { key: 'defect_items', name: '不良品项分布' },
    { key: 'work_orders', name: '工单执行进度' }, { key: 'task_progress', name: '任务执行进度' }, { key: 'employee_trend', name: '员工产能趋势' },
    { key: 'employee_defect', name: '人员不良品率' }, { key: 'people_stats', name: '人员生产统计' }, { key: 'machines', name: '机台状态详情' },
  ],
  设备维保模块: [
    { key: 'maint_completion', name: '维保任务完成率' }, { key: 'repair_status', name: '维修工单状态分布' },
    { key: 'device_status', name: '设备状态分布' }, { key: 'device_live', name: '设备实时状态表' },
  ],
  仓库模块: [
    { key: 'stock_warning', name: '库存预警' }, { key: 'stock_trend', name: '近30天出入库趋势' }, { key: 'warehouse_share', name: '仓库库存占比' },
  ],
};

async function equipModules(sql: Sql) {
  const tasks = (await sql.query<{ total: string; done: string }>("SELECT count(*)::text AS total,count(*) FILTER (WHERE status='已完成')::text AS done FROM r8_maint_tasks WHERE task_date >= (now() AT TIME ZONE 'Asia/Shanghai')::date - interval '29 days'")).rows[0]!;
  const total = Number(tasks.total);
  return {
    maint_completion: { total, done: Number(tasks.done), rate: total ? `${((Number(tasks.done) / total) * 100).toFixed(2)} %` : '0 %' },
    repair_status: (await sql.query<{ status: string; n: string }>('SELECT status,count(*)::text AS n FROM r8_repairs GROUP BY status ORDER BY status')).rows.map((row) => ({ name: row.status, value: Number(row.n) })),
    device_status: (await sql.query<{ status: string; n: string }>('SELECT status,count(*)::text AS n FROM r8_devices WHERE enabled GROUP BY status ORDER BY status')).rows.map((row) => ({ name: row.status, value: Number(row.n) })),
    device_live: (await sql.query("SELECT code,name,coalesce(nullif(spec,''),'-') AS spec,status,coalesce(nullif(owner_name,''),'-') AS owner_name,coalesce(nullif(shop_name,''),'-') AS shop_name FROM r8_devices WHERE enabled ORDER BY code LIMIT 50")).rows,
  };
}

async function warehouseModules(sql: Sql) {
  const warning = (await sql.query<{ code: string; name: string; on_hand: string; lower: string | null; upper: string | null }>(`SELECT p.code,p.name,coalesce(sum(b.on_hand),0)::text AS on_hand,p.stock_lower_warn::text AS lower,p.stock_upper_warn::text AS upper
    FROM products p LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id
    WHERE p.active AND (p.stock_lower_warn IS NOT NULL OR p.stock_upper_warn IS NOT NULL)
    GROUP BY p.id,p.code,p.name,p.stock_lower_warn,p.stock_upper_warn
    HAVING (p.stock_lower_warn IS NOT NULL AND coalesce(sum(b.on_hand),0) < p.stock_lower_warn) OR (p.stock_upper_warn IS NOT NULL AND coalesce(sum(b.on_hand),0) > p.stock_upper_warn)
    ORDER BY p.code LIMIT 50`)).rows.map((row) => ({ code: row.code, name: row.name, on_hand: qtyText(q(row.on_hand)), state: row.lower !== null && Number(row.on_hand) < Number(row.lower) ? '低于下限' : '高于上限' }));
  const trend = (await sql.query<{ day: string; inbound: string; outbound: string }>(`SELECT to_char(posted_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
      coalesce(sum(quantity) FILTER (WHERE direction='in'),0)::text AS inbound, coalesce(sum(quantity) FILTER (WHERE direction='out'),0)::text AS outbound
    FROM stock_ledger WHERE posted_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date - interval '29 days' GROUP BY 1 ORDER BY 1`)).rows.map((row) => ({ day: row.day, inbound: qtyText(q(row.inbound)), outbound: qtyText(q(row.outbound)) }));
  const share = (await sql.query<{ name: string; qty: string }>('SELECT w.name,coalesce(sum(b.on_hand),0)::text AS qty FROM warehouses w LEFT JOIN stock_balances b ON b.tenant_id=w.tenant_id AND b.warehouse_id=w.id WHERE w.active GROUP BY w.id,w.name ORDER BY w.name')).rows.map((row) => ({ name: row.name, value: qtyText(q(row.qty)) }));
  return { stock_warning: warning, stock_trend: trend, warehouse_share: share };
}

function shanghaiToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

async function machineRows(sql: Sql) {
  const rows = (await sql.query<{ code: string; name: string; specification: string; status: string; workshop: string; good_qty: string; total_qty: string }>(
    `SELECT m.code, m.name, coalesce(nullif(m.spec, ''), '-') AS specification, m.status,
      coalesce(nullif(s.name, ''), '-') AS workshop,
      coalesce(sum(r.good_qty) FILTER (WHERE r.approval='approved'), 0)::text AS good_qty,
      coalesce(sum(r.good_qty + r.defect_qty) FILTER (WHERE r.approval='approved'), 0)::text AS total_qty
     FROM r8_machines m
     LEFT JOIN r8_shops s ON s.tenant_id=m.tenant_id AND s.id=m.shop_id
     LEFT JOIN production_reports r ON r.tenant_id=m.tenant_id AND r.machine_id=m.id
     WHERE m.enabled
     GROUP BY m.id, m.code, m.name, m.spec, m.status, s.name
     ORDER BY m.code`,
  )).rows;
  return rows.map((row) => {
    const good = q(row.good_qty);
    const total = q(row.total_qty);
    const rate = total === 0n ? '-' : (Number((good * 10000n) / total) / 100).toFixed(2);
    const goodText = total === 0n ? '-' : qtyText(good);
    return {
      code: row.code, name: row.name, specification: row.specification, status: row.status, workshop: row.workshop,
      good_qty: goodText, good_rate: rate,
      机台编号: row.code, 机台名称: row.name, 机台规格: row.specification, 机台状态: row.status, 车间: row.workshop,
      良品数: goodText, '良品率(%)': rate,
    };
  });
}

async function screenCounts(sql: Sql) {
  const wo = (await sql.query<{ not_started: string; running: string; overdue: string; due_week: string; completed_today: string }>(
    `SELECT
      count(*) FILTER (WHERE execution='not_started')::text AS not_started,
      count(*) FILTER (WHERE execution='running')::text AS running,
      count(*) FILTER (WHERE ${workOrderOverdueSql('work_orders')})::text AS overdue,
      count(*) FILTER (WHERE due_date BETWEEN $1::date AND ($1::date + interval '7 days') AND execution NOT IN ('completed','cancelled'))::text AS due_week,
      count(*) FILTER (WHERE execution='completed' AND (completed_at AT TIME ZONE 'Asia/Shanghai')::date = $1::date)::text AS completed_today
     FROM work_orders`,
    [shanghaiToday()],
  )).rows[0]!;
  const taskOverdue = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_order_tasks t JOIN work_orders w ON w.id=t.work_order_id WHERE ${taskOverdueSql('w', 't')}`)).rows[0]!.n);
  const today = shanghaiToday();
  const report = (await sql.query<{ good: string; defect: string; yesterday_good: string; yesterday_defect: string }>(
    `SELECT
      coalesce(sum(good_qty+defect_qty) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date),0)::text AS good,
      coalesce(sum(defect_qty) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date),0)::text AS defect,
      coalesce(sum(good_qty+defect_qty) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date=($1::date - interval '1 day')),0)::text AS yesterday_good,
      coalesce(sum(defect_qty) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date=($1::date - interval '1 day')),0)::text AS yesterday_defect
     FROM production_reports WHERE approval='approved'`,
    [today],
  )).rows[0]!;
  const todayTotal = q(report.good);
  const todayDefect = q(report.defect);
  const defectRate = todayTotal === 0n ? '0 %' : `${(Number((todayDefect * 10000n) / todayTotal) / 100).toFixed(2)} %`;
  return {
    pending_orders: Number(wo.not_started),
    running_orders: Number(wo.running),
    completed_today: Number(wo.completed_today),
    today_reports: qtyText(todayTotal),
    today_defects: qtyText(todayDefect),
    today_defect_rate: defectRate,
    yesterday_reports: qtyText(q(report.yesterday_good)),
    yesterday_defects: qtyText(q(report.yesterday_defect)),
    due_week: Number(wo.due_week),
    overdue_orders: Number(wo.overdue),
    overdue_tasks: taskOverdue,
  };
}

export function registerScreens(app: FastifyInstance, services: Services) {
  const { database, authorize, context, actor } = services;
  const guard = authorize();
  const run = <T>(request: Parameters<typeof context>[0], work: (sql: Sql, a: Actor) => Promise<T>) => database.tenant(context(request), async (sql) => { const a = actor(request); requireAllScope(a); await gateTenantWrite(sql, context(request)); return work(sql, a); });

  app.get('/api/data-screens', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const rows = (await sql.query('SELECT id,menu_name,layout,module_kind,description,access_password,preset_key,sort_no,design,version FROM data_screens ORDER BY sort_no,created_at')).rows;
    return { items: rows.map((row, index) => ({ ...row, preset: row.preset_key, seq: index + 1, module_kind: row.module_kind ?? '生产模块', description: row.description || '-', password_text: row.access_password || '-' })), layouts: screenLayouts, module_kinds: screenModuleKinds, module_library: screenModuleLibrary };
  }));

  app.get<{ Params: { id: string } }>('/api/data-screens/:id', { preHandler: guard, schema: { params: object(['id'], { id: uuid }) } }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const row = (await sql.query('SELECT id,menu_name,layout,module_kind,description,access_password,preset_key,sort_no,design,version FROM data_screens WHERE id=$1', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '大屏不存在');
    return { screen: row, layouts: screenLayouts, module_kinds: screenModuleKinds, module_library: screenModuleLibrary, slots: layoutSlots[String(row.layout)] ?? 1 };
  }));

  app.post<{ Body: { menu_name: string; layout?: string; module_kind: string; description?: string; access_password?: string } }>('/api/data-screens', {
    preHandler: guard,
    schema: { body: object(['menu_name', 'module_kind'], { menu_name: { type: 'string', minLength: 1, maxLength: 80 }, layout: { type: 'string', enum: screenLayouts }, module_kind: { type: 'string', enum: screenModuleKinds }, description: { type: 'string', maxLength: 255 }, access_password: passwordField }, ['layout', 'description', 'access_password']) },
  }, async (request, reply) => reply.code(201).send(await run(request, async (sql, a) => {
    permit(a, 'production.write');
    const menuName = request.body.menu_name.trim();
    if (!menuName) throw new Problem(422, 'REQUIRED', '请填写菜单名');
    const next = Number((await sql.query<{ n: string }>('SELECT coalesce(max(sort_no),0)+1 AS n FROM data_screens')).rows[0]!.n);
    const row = (await sql.query<{ id: string }>(`INSERT INTO data_screens(tenant_id,menu_name,layout,module_kind,description,access_password,sort_no,preset_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,'') RETURNING id`, [a.tenant_id, menuName, request.body.layout ?? '默认', request.body.module_kind, request.body.description?.trim() || '-', request.body.access_password?.trim() ?? '', next])).rows[0]!;
    return { id: row.id };
  })));

  app.patch<{ Params: { id: string }; Body: { menu_name?: string; access_password?: string; description?: string; layout?: string; module_kind?: string; version?: number } }>('/api/data-screens/:id', {
    preHandler: guard,
    schema: { params: object(['id'], { id: uuid }), body: object([], { menu_name: { type: 'string', minLength: 1, maxLength: 80 }, access_password: passwordField, description: { type: 'string', maxLength: 255 }, layout: { type: 'string', enum: screenLayouts }, module_kind: { type: 'string', enum: screenModuleKinds }, version: { type: 'integer', minimum: 1 } }, ['menu_name', 'access_password', 'description', 'layout', 'module_kind', 'version']) },
  }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const body = request.body ?? {};
    const current = (await sql.query<{ version: number }>('SELECT version FROM data_screens WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!current) throw new Problem(404, 'NOT_FOUND', '大屏不存在');
    if (body.version !== undefined && body.version !== current.version) throw new Problem(409, 'VERSION_CONFLICT', '大屏已被修改，请刷新后重试');
    if (body.menu_name !== undefined && !body.menu_name.trim()) throw new Problem(422, 'REQUIRED', '请填写菜单名', 'menu_name');
    const updated = await sql.query('UPDATE data_screens SET menu_name=coalesce($1,menu_name),access_password=coalesce($2,access_password),description=coalesce($3,description),layout=coalesce($4,layout),module_kind=coalesce($5,module_kind),version=version+1,updated_at=now() WHERE id=$6 RETURNING id', [body.menu_name?.trim() || null, body.access_password === undefined ? null : body.access_password.trim(), body.description === undefined ? null : (body.description.trim() || '-'), body.layout ?? null, body.module_kind ?? null, request.params.id]);
    if (!updated.rows[0]) throw new Problem(404, 'NOT_FOUND', '大屏不存在');
    return { ok: true };
  }));

  app.delete<{ Params: { id: string } }>('/api/data-screens/:id', { preHandler: guard, schema: { params: object(['id'], { id: uuid }) } }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    if (!(await sql.query('DELETE FROM data_screens WHERE id=$1 RETURNING id', [request.params.id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '大屏不存在');
    return { ok: true };
  }));

  app.put<{ Params: { id: string }; Body: { title?: string; slots?: { slot: number; module: string }[]; version?: number } }>('/api/data-screens/:id/design', {
    preHandler: guard,
    schema: { params: object(['id'], { id: uuid }), body: object([], { title: { type: 'string', maxLength: 40 }, version: { type: 'integer', minimum: 1 }, slots: { type: 'array', maxItems: 16, items: object(['slot', 'module'], { slot: { type: 'integer', minimum: 1, maximum: 16 }, module: { type: 'string', minLength: 1, maxLength: 40 } }) } }, ['title', 'slots', 'version']) },
  }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const row = (await sql.query<{ layout: string; version: number }>('SELECT layout,version FROM data_screens WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '大屏不存在');
    if (request.body.version !== undefined && request.body.version !== row.version) throw new Problem(409, 'VERSION_CONFLICT', '大屏已被修改，请刷新后重试');
    const known = new Set(Object.values(screenModuleLibrary).flat().map((item) => item.key));
    const slots = request.body.slots ?? [];
    if (slots.some((item) => !known.has(item.module))) throw new Problem(422, 'UNKNOWN_MODULE', '所选模块不存在');
    if (new Set(slots.map((item) => item.slot)).size !== slots.length) throw new Problem(422, 'DUPLICATE_SLOT', '同一个槽位只能放一个模块');
    const design = { title: request.body.title?.trim() || '数字化生产监控平台', slots: [...slots].sort((x, y) => x.slot - y.slot) };
    await sql.query('UPDATE data_screens SET design=$1::jsonb,version=version+1,updated_at=now() WHERE id=$2', [JSON.stringify(design), request.params.id]);
    return { design };
  }));

  app.get<{ Params: { preset: string }; Querystring: { pwd?: string } }>('/api/progress/screen-data/:preset', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const preset = request.params.preset;
    const row = (await sql.query('SELECT * FROM data_screens WHERE preset_key=$1 OR id::text=$1 LIMIT 1', [preset])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '大屏不存在');
    const pwd = request.query.pwd ?? '';
    if (row.access_password && row.access_password !== pwd) throw new Problem(403, 'SCREEN_PASSWORD', '访问密码不正确');
    const cards = await screenCounts(sql);
    const recentReports = (await sql.query(
      `SELECT to_char(r.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS time, m.display_name AS operator_name, t.process_snapshot->>'name' AS process_name,
        w.product_snapshot->>'name' AS product_name, w.product_snapshot->>'code' AS product_code,
        r.good_qty::text AS good_qty, r.defect_qty::text AS defect_qty
       FROM production_reports r
       JOIN work_order_tasks t ON t.id=r.task_id
       JOIN work_orders w ON w.id=r.work_order_id
       JOIN tenant_team_members m ON m.id=r.operator_id
       WHERE r.approval='approved' ORDER BY r.created_at DESC LIMIT 30`,
    )).rows.map((row) => ({ ...row, good_qty: qtyText(q(String(row.good_qty))), defect_qty: qtyText(q(String(row.defect_qty))) }));
    const peopleStats = (await sql.query<{ name: string; today_qty: string; week_defect: string; month_defect: string }>(
      `SELECT m.display_name AS name,
        coalesce(sum(r.good_qty+r.defect_qty) FILTER (WHERE (r.created_at AT TIME ZONE 'Asia/Shanghai')::date = $1::date),0)::text AS today_qty,
        coalesce(sum(r.defect_qty) FILTER (WHERE (r.created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - interval '6 days')),0)::text AS week_defect,
        coalesce(sum(r.defect_qty) FILTER (WHERE date_trunc('month', r.created_at AT TIME ZONE 'Asia/Shanghai') = date_trunc('month', $1::date)),0)::text AS month_defect
       FROM production_reports r JOIN tenant_team_members m ON m.id=r.operator_id
       WHERE r.approval='approved' AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - interval '31 days')
       GROUP BY m.display_name`,
      [shanghaiToday()],
    )).rows.map((row) => ({ 姓名: row.name, 今日报工数: qtyText(q(row.today_qty)), 本周不良品数: qtyText(q(row.week_defect)), 本月不良品数: qtyText(q(row.month_defect)) }));
    const defectItems = (await sql.query(
      `SELECT defect_note AS name, sum(defect_qty)::text AS qty FROM production_reports
       WHERE approval='approved' AND created_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date - interval '29 days'
         AND defect_note <> '' GROUP BY defect_note ORDER BY sum(defect_qty) DESC LIMIT 20`,
    )).rows;
    const workOrders = (await sql.query(
      `SELECT w.code,w.product_snapshot,coalesce(p.specification,'') AS specification,w.plan_qty::text,w.priority,w.id,
        (SELECT json_agg(json_build_object('name',t.process_snapshot->>'name','good',t.approved_good::text,'plan',t.plan_qty::text,'execution',t.execution) ORDER BY t.sequence)
         FROM work_order_tasks t WHERE t.work_order_id=w.id) AS tasks
       FROM work_orders w
       LEFT JOIN products p ON p.tenant_id=w.tenant_id AND p.id=w.product_id
       WHERE w.execution IN ('not_started','running','paused')
       ORDER BY w.created_at DESC LIMIT 50`,
    )).rows;
    const employeeTrend = (await sql.query(
      `SELECT m.display_name AS name, r.created_at::date::text AS day, sum(r.good_qty+r.defect_qty)::text AS qty
       FROM production_reports r JOIN tenant_team_members m ON m.id=r.operator_id
       WHERE r.approval='approved' AND r.created_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date - interval '29 days'
       GROUP BY m.display_name, r.created_at::date ORDER BY day`,
    )).rows;
    const employeeDefect = (await sql.query(
      `SELECT m.display_name AS name,
        CASE WHEN sum(r.good_qty+r.defect_qty)=0 THEN 0 ELSE round(100.0*sum(r.defect_qty)/sum(r.good_qty+r.defect_qty),2) END AS rate
       FROM production_reports r JOIN tenant_team_members m ON m.id=r.operator_id
       WHERE r.approval='approved' AND r.created_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date - interval '29 days'
       GROUP BY m.display_name ORDER BY rate ASC`,
    )).rows;
    const taskProgress = (await sql.query(
      `SELECT w.code AS work_order_code, t.process_snapshot->>'name' AS process_name, m.display_name AS operator_name,
        t.plan_qty::text AS task_qty, t.approved_good::text AS good_qty, t.approved_defect::text AS defect_qty,
        (t.plan_qty - t.approved_good)::text AS pending_qty
       FROM work_order_tasks t
       JOIN work_orders w ON w.id=t.work_order_id
       LEFT JOIN tenant_team_members m ON m.id=(SELECT operator_id FROM production_reports WHERE task_id=t.id ORDER BY created_at DESC LIMIT 1)
       WHERE w.execution IN ('running','paused','not_started') ORDER BY w.created_at DESC LIMIT 40`,
    )).rows;
    const employeeRank = (await sql.query(
      `SELECT m.display_name AS name, sum(r.good_qty+r.defect_qty)::text AS qty
       FROM production_reports r JOIN tenant_team_members m ON m.id=r.operator_id
       WHERE r.approval='approved' AND r.created_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date - interval '29 days'
       GROUP BY m.display_name ORDER BY sum(r.good_qty+r.defect_qty) DESC LIMIT 20`,
    )).rows;
    const processDaily = (await sql.query(
      `SELECT r.created_at::date::text AS day, sum(r.good_qty+r.defect_qty)::text AS qty
       FROM production_reports r
       WHERE r.approval='approved' AND r.created_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date - interval '29 days'
       GROUP BY r.created_at::date ORDER BY day`,
    )).rows;
    const taskRows = taskProgress.map((row) => ({ ...row, task_qty: qtyText(q(String(row.task_qty))), good_qty: qtyText(q(String(row.good_qty))), defect_qty: qtyText(q(String(row.defect_qty))), pending_qty: qtyText(q(String(row.pending_qty))) }));
    const machines = await machineRows(sql);
    const payload = { cards, recent_reports: recentReports, defect_items: defectItems, work_orders: workOrders, employee_trend: employeeTrend, employee_defect: employeeDefect, task_progress: taskRows, employee_rank: employeeRank, process_daily: processDaily, people_stats: peopleStats, machines };
    const design = row.design && typeof row.design === 'object' && Array.isArray((row.design as { slots?: unknown }).slots) && (row.design as { slots: unknown[] }).slots.length ? row.design : null;
    const meta = { screen: { id: row.id, menu_name: row.menu_name, layout: row.layout, module_kind: row.module_kind }, design };
    if (row.module_kind === '设备维保模块') return { ...meta, ...await equipModules(sql) };
    if (row.module_kind === '仓库模块') return { ...meta, ...await warehouseModules(sql) };
    if (design) return { ...meta, ...payload, defect_analysis: defectItems };
    if (preset === 'workshop') return { cards, employee_rank: employeeRank, process_daily: processDaily, task_progress: taskRows, recent_reports: recentReports };
    if (preset === 'wo-progress') return { work_orders: workOrders };
    if (preset === 'defect') return { employee_defect: employeeDefect, defect_items: defectItems };
    if (preset === 'machine') return { machines };
    return payload;
  }));
}
