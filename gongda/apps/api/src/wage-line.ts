import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem, requireAllScope, writeAudit, type Actor, type Services } from './services.js';
import { gateTenantWrite } from './assets.js';
import { decimal, formatDecimal } from './decimal.js';
import { money, permit } from './business-common.js';
import { postWage, priceWage, type WageSnapshot } from './accounting.js';
import { evaluateWageFormula } from './performance-pay.js';
import { assertOperator, changeTaskExecution, refreshTaskQuantities, reportView } from './production.js';
import { taskOverdueSql } from './progress-calc.js';

const uuid = { type: 'string', format: 'uuid' };
const requestKey = { type: 'string', minLength: 8, maxLength: 80, pattern: '^[A-Za-z0-9_.-]+$' };
const decimalField = { type: 'string', pattern: '^(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,6})?$' };
const dateField = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const object = (required: string[], properties: Record<string, unknown>, optional: string[] = []) => ({ type: 'object', additionalProperties: false, required, properties: Object.fromEntries([...required, ...optional].map((key) => [key, properties[key]])) });

function shanghaiDateTime(value: string | null | undefined) {
  if (!value) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) return value;
  return value.replace(' ', 'T') + '+08:00';
}
async function beginCommand(sql: Sql, command: string, key: string, hash: string) {
  const existing = (await sql.query<{ resource_id: string; payload_hash: string }>('SELECT resource_id,payload_hash FROM command_replays WHERE command=$1 AND request_key=$2', [command, key])).rows[0];
  if (!existing) return null;
  if (existing.payload_hash !== hash) throw new Problem(409, 'REQUEST_KEY_CONFLICT', '同一请求标识不能用于不同内容');
  return existing.resource_id;
}
async function finishCommand(sql: Sql, tenantId: string, command: string, key: string, hash: string, resourceId: string) {
  await sql.query('INSERT INTO command_replays(tenant_id,command,request_key,payload_hash,resource_type,resource_id) VALUES($1,$2,$3,$4,$5,$6)', [tenantId, command, key, hash, 'wage_line', resourceId]);
}
const digest = async (value: unknown) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
};

const approved = "r.approval='approved'";
function centsOf(filter: string) {
  return `coalesce(sum((r.wage_snapshot->>'amount_cents')::numeric) FILTER (WHERE ${filter} AND r.wage_snapshot->>'status'='priced'),0)`;
}

export function registerWageLine(app: FastifyInstance, services: Services) {
  const { database, authorize, context, actor } = services;
  const guard = authorize();
  const run = <T>(request: Parameters<typeof context>[0], work: (sql: Sql, a: Actor) => Promise<T>) => database.tenant(context(request), async (sql) => { const a = actor(request); requireAllScope(a); await gateTenantWrite(sql, context(request)); return work(sql, a); });

  app.get<{ Querystring: { status?: string; task_type?: string; overdue?: string; work_order_code?: string; process?: string; product?: string; page?: string; page_size?: string } }>('/api/production-tasks', { preHandler: guard, schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['not_started', 'running', 'paused', 'completed'] }, task_type: { type: 'string', enum: ['all', 'production', 'outsource', 'rework'] }, overdue: { type: 'string', enum: ['0', '1', 'true'] }, work_order_code: { type: 'string', maxLength: 64 }, process: { type: 'string', maxLength: 200 }, product: { type: 'string', maxLength: 200 }, page: { type: 'string', pattern: '^[1-9]\\d{0,5}$' }, page_size: { type: 'string', pattern: '^[1-9]\\d{0,2}$' } } } } }, (request) => database.tenant(context(request), async (sql) => {
    const a = actor(request); permit(a, 'production.read'); requireAllScope(a);
    const q = request.query;
    const taskType = q.task_type ?? 'all';
    const where = ['TRUE'];
    const params: unknown[] = [];
    const add = (sqlText: string, value: unknown) => { params.push(value); where.push(sqlText.replace('$?', '$' + params.length)); };
    if (q.status) add('t.execution=$?', q.status);
    if (taskType === 'outsource') where.push("t.task_kind='outsource'");
    else if (taskType === 'rework') where.push("t.task_kind='rework'");
    else if (taskType === 'production') where.push("t.task_kind='production'");
    if (q.overdue === '1' || q.overdue === 'true') where.push(taskOverdueSql('w', 't'));
    if (q.overdue === '0') where.push(`NOT (${taskOverdueSql('w', 't')})`);
    if (q.work_order_code) add('w.code ILIKE $?', '%' + q.work_order_code.trim() + '%');
    if (q.process) { params.push('%' + q.process.trim() + '%'); where.push(`(t.process_snapshot->>'name' ILIKE $${params.length} OR t.process_snapshot->>'code' ILIKE $${params.length})`); }
    if (q.product) { params.push('%' + q.product.trim() + '%'); where.push(`(w.product_snapshot->>'name' ILIKE $${params.length} OR w.product_snapshot->>'code' ILIKE $${params.length})`); }
    const filter = where.join(' AND ');
    const page = Number(q.page ?? '1');
    const pageSize = q.page ? Math.min(Number(q.page_size ?? '30'), 200) : 200;
    const from = 'FROM work_order_tasks t JOIN work_orders w ON w.tenant_id=t.tenant_id AND w.id=t.work_order_id';
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from} WHERE ${filter}`, params)).rows[0]!.n);
    const overdueCase = `CASE WHEN ${taskOverdueSql('w', 't')} THEN GREATEST(0, ((now() AT TIME ZONE 'Asia/Shanghai')::date - COALESCE(w.planned_end, w.due_date))) ELSE 0 END`;
    const rows = (await sql.query(`SELECT t.id,t.work_order_id,w.code AS work_order_code,w.execution AS work_order_execution,w.order_paused,w.due_date::text,w.priority,w.product_snapshot,t.sequence,t.process_id,t.process_snapshot,t.execution,t.plan_qty::text,t.approved_good::text,t.approved_defect::text,t.pricing_mode,t.wage_rate::text,t.inspection_scheme,t.unit_ratio::text,t.version,t.started_at,t.completed_at,t.task_kind,t.dispatch_operator_ids, ${overdueCase} AS overdue_days ${from} WHERE ${filter} ORDER BY w.created_at DESC, t.sequence LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)).rows;
    const counts = (await sql.query<{ all: string; not_started: string; running: string; paused: string; completed: string; overdue: string; on_time: string }>(`SELECT count(*)::text AS all, count(*) FILTER (WHERE t.execution='not_started')::text AS not_started, count(*) FILTER (WHERE t.execution='running')::text AS running, count(*) FILTER (WHERE t.execution='paused')::text AS paused, count(*) FILTER (WHERE t.execution='completed')::text AS completed, count(*) FILTER (WHERE ${taskOverdueSql('w', 't')})::text AS overdue, count(*) FILTER (WHERE NOT (${taskOverdueSql('w', 't')}))::text AS on_time FROM work_order_tasks t JOIN work_orders w ON w.tenant_id=t.tenant_id AND w.id=t.work_order_id`)).rows[0]!;
    const totals = (await sql.query<{ seconds: string; plan: string; actual: string }>(`SELECT coalesce(sum(s.seconds),0)::text AS seconds, coalesce(sum(t.plan_qty),0)::text AS plan, coalesce(sum(t.approved_good),0)::text AS actual ${from} LEFT JOIN LATERAL (SELECT coalesce(sum(effective_seconds),0) AS seconds FROM production_reports pr WHERE pr.task_id=t.id AND pr.approval='approved') s ON TRUE WHERE ${filter}`, params)).rows[0]!;
    const outsourceCount = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from} WHERE t.task_kind='outsource'`)).rows[0]!.n);
    const reworkCount = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from} WHERE t.task_kind='rework'`)).rows[0]!.n);
    return {
      items: rows.map((row) => ({ ...row, task_type: String(row.task_kind ?? 'production'), dispatch_operator_ids: row.dispatch_operator_ids ?? [], overdue_days: Number(row.overdue_days) })),
      total, page, page_size: pageSize,
      counts: { all: Number(counts.all), production: Number(counts.all) - outsourceCount - reworkCount, outsource: outsourceCount, rework: reworkCount, not_started: Number(counts.not_started), running: Number(counts.running), paused: Number(counts.paused), completed: Number(counts.completed), overdue: Number(counts.overdue), on_time: Number(counts.on_time) },
      totals: { effective_seconds: Number(totals.seconds), plan_qty: totals.plan, actual_qty: totals.actual },
    };
  }));

  app.post<{ Body: { request_key: string; action: 'start' | 'pause' | 'complete'; task_ids: string[]; reason?: string } }>('/api/production-tasks/batch-actions', { preHandler: guard, schema: { body: object(['request_key', 'action', 'task_ids'], { request_key: requestKey, action: { type: 'string', enum: ['start', 'pause', 'complete'] }, task_ids: { type: 'array', minItems: 1, maxItems: 200, items: uuid }, reason: { type: 'string', maxLength: 500 } }, ['reason']) } }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const hash = await digest(request.body);
    const prior = await beginCommand(sql, 'task.batch', request.body.request_key, hash);
    if (prior) {
      const saved = (await sql.query<{ after_data: { succeeded: number; skipped: number; results: unknown[] } }>('SELECT after_data FROM audit_events WHERE action=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 1', ['task.batch', prior])).rows[0];
      return { replayed: true, ...(saved?.after_data ?? { succeeded: 0, skipped: 0, results: [] }) };
    }
    const results: { task_id: string; ok: boolean; message: string }[] = [];
    for (const taskId of request.body.task_ids) {
      await sql.query('SAVEPOINT task_batch');
      try {
        const row = (await sql.query<{ work_order_id: string }>('SELECT work_order_id FROM work_order_tasks WHERE id=$1', [taskId])).rows[0];
        if (!row) throw new Problem(404, 'TASK_NOT_FOUND', '生产任务不存在');
        await changeTaskExecution(sql, a, row.work_order_id, taskId, request.body.action);
        await sql.query('RELEASE SAVEPOINT task_batch');
        results.push({ task_id: taskId, ok: true, message: '' });
      } catch (error) {
        await sql.query('ROLLBACK TO SAVEPOINT task_batch');
        results.push({ task_id: taskId, ok: false, message: error instanceof Problem ? error.message : '操作失败' });
      }
    }
    const succeeded = results.filter((item) => item.ok).length;
    const body = { succeeded, skipped: results.length - succeeded, results };
    const id = randomUUID();
    await finishCommand(sql, a.tenant_id, 'task.batch', request.body.request_key, hash, id);
    await writeAudit(sql, a, 'task.batch', 'work_order_task', id, null, { ...body, request_key: request.body.request_key });
    return { replayed: false, ...body };
  }));

  app.patch<{ Params: { id: string }; Body: { version: number; operator_id?: string; good_qty: string; defect_qty: string; defect_note?: string; note?: string; effective_seconds?: number; started_at?: string | null; ended_at?: string | null } }>('/api/production-reports/:id', { preHandler: guard, schema: { params: object(['id'], { id: uuid }), body: object(['version', 'good_qty', 'defect_qty'], { version: { type: 'integer', minimum: 1 }, operator_id: uuid, good_qty: decimalField, defect_qty: decimalField, defect_note: { type: 'string', maxLength: 500 }, note: { type: 'string', maxLength: 2000 }, effective_seconds: { type: 'integer', minimum: 0, maximum: 2678400 }, started_at: { anyOf: [{ type: 'string', maxLength: 40 }, { type: 'null' }] }, ended_at: { anyOf: [{ type: 'string', maxLength: 40 }, { type: 'null' }] } }, ['operator_id', 'defect_note', 'note', 'effective_seconds', 'started_at', 'ended_at']) } }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.report');
    const report = (await sql.query<{ id: string; work_order_id: string; task_id: string; process_id: string; approval: string; version: number; settlement_status: string; wage_snapshot: WageSnapshot | null; operator_id: string }>('SELECT id,work_order_id,task_id,process_id,approval,version,settlement_status,wage_snapshot,operator_id FROM production_reports WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!report) throw new Problem(404, 'REPORT_NOT_FOUND', '报工不存在');
    if (report.version !== request.body.version) throw new Problem(409, 'VERSION_CONFLICT', '报工已被修改，请刷新');
    if (report.settlement_status === 'settled') throw new Problem(409, 'SETTLED', '已结算的报工记录不能修改或删除，请先改为未结算');
    if (report.approval !== 'approved') throw new Problem(409, 'STATE_TRANSITION', '只有已生效的报工可以修改');
    const order = (await sql.query<{ execution: string; product_id: string }>('SELECT execution,product_id FROM work_orders WHERE id=$1 FOR UPDATE', [report.work_order_id])).rows[0]!;
    if (order.execution === 'completed' || order.execution === 'cancelled') throw new Problem(409, 'DOWNSTREAM_EXISTS', '加工单已完工或取消，不能再改报工');
    const operatorId = request.body.operator_id ?? report.operator_id;
    await assertOperator(sql, a, report.process_id, operatorId);
    const seconds = request.body.effective_seconds ?? report.wage_snapshot?.effective_seconds ?? 0;
    const good = formatDecimal(decimal(request.body.good_qty));
    const defect = formatDecimal(decimal(request.body.defect_qty));
    if (decimal(good) + decimal(defect) <= 0n && !seconds) throw new Problem(422, 'EMPTY_REPORT', '良品与不良合计必须大于零，允许良品为零');
    const snap = report.wage_snapshot as (WageSnapshot & { performance_formula?: string; performance_params?: string[] }) | null;
    let next = snap;
    if (snap?.performance_formula) {
      const params = snap.performance_params ?? [];
      const amountText = evaluateWageFormula(snap.performance_formula, {
        '报工.良品数': good,
        '报工.不良品数': defect,
        '报工.报工数': String(Number(good) + Number(defect)),
        '报工.报工时长': seconds,
        '报工.工资单价': snap.rate ?? '0',
        '任务.计价方式': snap.mode === 'time' ? '计时' : '计件',
        '绩效.参数1': params[0] ?? '',
        '绩效.参数2': params[1] ?? '',
        '绩效.参数3': params[2] ?? '',
        '绩效.参数4': params[3] ?? '',
        '绩效.参数5': params[4] ?? '',
      });
      const cents = Math.round(Number(amountText) * 100);
      next = { ...snap, good_qty: good, effective_seconds: seconds, amount_cents: String(cents), amount: (cents / 100).toFixed(2), status: 'priced' };
    } else if (snap?.rate && snap.mode) {
      const amount = priceWage(snap.mode, snap.rate, good, seconds);
      next = { ...snap, good_qty: good, effective_seconds: seconds, amount_cents: amount.toString(), amount: money(amount), status: 'priced' };
    }
    await postWage(sql, a, report.id, true);
    await sql.query("UPDATE production_reports SET operator_id=$2,good_qty=$3,defect_qty=$4,defect_note=$5,note=$6,effective_seconds=$7,started_at=$8,ended_at=$9,wage_snapshot=$10,wage_status=$11,version=version+1,updated_at=now() WHERE id=$1", [report.id, operatorId, good, defect, (request.body.defect_note ?? '').trim(), request.body.note ?? '', seconds, shanghaiDateTime(request.body.started_at), shanghaiDateTime(request.body.ended_at), next, next?.status ?? 'unpriced']);
    await postWage(sql, a, report.id, false);
    await refreshTaskQuantities(sql, report.task_id);
    const body = await reportView(sql, report.id, a);
    await writeAudit(sql, a, 'report.updated', 'production_report', report.id, { version: report.version }, body.report);
    return body;
  }));

  app.post<{ Params: { id: string }; Body: { request_key: string; version: number; settled: boolean; note?: string } }>('/api/production-reports/:id/settlement', { preHandler: guard, schema: { params: object(['id'], { id: uuid }), body: object(['request_key', 'version', 'settled'], { request_key: requestKey, version: { type: 'integer', minimum: 1 }, settled: { type: 'boolean' }, note: { type: 'string', maxLength: 255 } }, ['note']) } }, (request) => run(request, async (sql, a) => {
    permit(a, 'payroll.approve');
    const hash = await digest({ id: request.params.id, ...request.body, note: request.body.note ?? '' });
    const prior = await beginCommand(sql, 'report.settle', request.body.request_key, hash);
    if (prior) return { replayed: true, ...(await reportView(sql, prior, a)) };
    const report = (await sql.query<{ id: string; version: number; approval: string }>('SELECT id,version,approval FROM production_reports WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!report) throw new Problem(404, 'REPORT_NOT_FOUND', '报工不存在');
    if (report.version !== request.body.version) throw new Problem(409, 'VERSION_CONFLICT', '报工已被修改，请刷新');
    if (report.approval !== 'approved') throw new Problem(409, 'STATE_TRANSITION', '只有已生效的报工可以结算');
    const note = (request.body.note ?? '').trim();
    if (request.body.settled) await sql.query("UPDATE production_reports SET settlement_status='settled',settled_by=$2,settled_at=now(),settlement_note=$3,version=version+1,updated_at=now() WHERE id=$1", [report.id, a.user_id, note]);
    else await sql.query("UPDATE production_reports SET settlement_status='unsettled',settled_by=NULL,settled_at=NULL,settlement_note=$2,version=version+1,updated_at=now() WHERE id=$1", [report.id, note]);
    await finishCommand(sql, a.tenant_id, 'report.settle', request.body.request_key, hash, report.id);
    const body = await reportView(sql, report.id, a);
    await writeAudit(sql, a, request.body.settled ? 'report.settled' : 'report.unsettled', 'production_report', report.id, null, body.report);
    return { replayed: false, ...body };
  }));

  app.post<{ Body: { request_key: string; report_ids: string[] } }>('/api/production-reports/batch-settlement', { preHandler: guard, schema: { body: object(['request_key', 'report_ids'], { request_key: requestKey, report_ids: { type: 'array', minItems: 1, maxItems: 200, items: uuid } }) } }, (request) => run(request, async (sql, a) => {
    permit(a, 'payroll.approve');
    const hash = await digest(request.body);
    const prior = await beginCommand(sql, 'report.batch_settle', request.body.request_key, hash);
    if (prior) {
      const saved = (await sql.query<{ after_data: { settled: number; skipped: number } }>('SELECT after_data FROM audit_events WHERE action=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 1', ['report.batch_settle', prior])).rows[0];
      return { replayed: true, ...(saved?.after_data ?? { settled: 0, skipped: 0 }) };
    }
    let settled = 0, skipped = 0;
    for (const id of request.body.report_ids) {
      const report = (await sql.query<{ id: string; approval: string; settlement_status: string }>('SELECT id,approval,settlement_status FROM production_reports WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!report || report.approval !== 'approved' || report.settlement_status === 'settled') { skipped += 1; continue; }
      await sql.query("UPDATE production_reports SET settlement_status='settled',settled_by=$2,settled_at=now(),version=version+1,updated_at=now() WHERE id=$1", [id, a.user_id]);
      settled += 1;
    }
    const body = { settled, skipped };
    const entity = randomUUID();
    await finishCommand(sql, a.tenant_id, 'report.batch_settle', request.body.request_key, hash, entity);
    await writeAudit(sql, a, 'report.batch_settle', 'production_report', entity, null, { ...body, request_key: request.body.request_key });
    return { replayed: false, ...body };
  }));

  const payrollWhere = (a: Actor, query: { name?: string; department_id?: string; quality_status?: string; report_from?: string; report_to?: string; settled_from?: string; settled_to?: string; user_id?: string }) => {
    const where = [approved];
    const params: unknown[] = [];
    const add = (text: string, value: unknown) => { params.push(value); where.push(text.replaceAll('$?', '$' + params.length)); };
    const userId = a.permissions.includes('payroll.read') ? query.user_id : a.user_id;
    if (!a.permissions.includes('payroll.read')) add('r.operator_id=$?', a.user_id);
    else if (userId) add('r.operator_id=$?', userId);
    if (query.name) add("(coalesce(mp.display_name, tm.display_name) ILIKE $?)", '%' + query.name.trim() + '%');
    if (query.department_id) add('mp.department_id=$?', query.department_id);
    if (query.quality_status) add('r.quality_status=$?', query.quality_status);
    if (query.report_from) add("((COALESCE(r.started_at,r.created_at) AT TIME ZONE 'Asia/Shanghai')::date >= $?::date)", query.report_from);
    if (query.report_to) add("((COALESCE(r.started_at,r.created_at) AT TIME ZONE 'Asia/Shanghai')::date <= $?::date)", query.report_to);
    if (query.settled_from) add("((r.settled_at AT TIME ZONE 'Asia/Shanghai')::date >= $?::date)", query.settled_from);
    if (query.settled_to) add("((r.settled_at AT TIME ZONE 'Asia/Shanghai')::date <= $?::date)", query.settled_to);
    return { where: where.join(' AND '), params };
  };
  const payrollFrom = "FROM production_reports r JOIN work_orders w ON w.tenant_id=r.tenant_id AND w.id=r.work_order_id LEFT JOIN tenant_team_members tm ON tm.id=r.operator_id LEFT JOIN tenant_member_profiles mp ON mp.tenant_id=r.tenant_id AND mp.user_id=r.operator_id LEFT JOIN departments d ON d.tenant_id=mp.tenant_id AND d.id=mp.department_id";

  app.get<{ Querystring: { name?: string; department_id?: string; quality_status?: string; report_from?: string; report_to?: string; settled_from?: string; settled_to?: string } }>('/api/payroll-statement', { preHandler: guard, schema: { querystring: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 200 }, department_id: uuid, quality_status: { type: 'string', enum: ['pending', 'done', 'none'] }, report_from: dateField, report_to: dateField, settled_from: dateField, settled_to: dateField } } } }, (request) => database.tenant(context(request), async (sql) => {
    const a = actor(request); permit(a, 'production.read'); requireAllScope(a);
    const built = payrollWhere(a, request.query);
    const rows = (await sql.query<{ user_id: string; name: string; department_name: string | null; settled_qty: string; settled_piece_cents: string; unsettled_qty: string; unsettled_piece_cents: string; report_qty: string; good_qty: string; defect_qty: string; wage_cents: string; settled_time_cents: string; unsettled_time_cents: string }>(`SELECT r.operator_id AS user_id, coalesce(mp.display_name, tm.display_name, '') AS name, d.name AS department_name, coalesce(sum(r.good_qty+r.defect_qty) FILTER (WHERE r.settlement_status='settled'),0)::text AS settled_qty, ${centsOf("r.settlement_status='settled' AND r.wage_snapshot->>'mode'='piece'")}::text AS settled_piece_cents, coalesce(sum(r.good_qty+r.defect_qty) FILTER (WHERE r.settlement_status='unsettled'),0)::text AS unsettled_qty, ${centsOf("r.settlement_status='unsettled' AND r.wage_snapshot->>'mode'='piece'")}::text AS unsettled_piece_cents, coalesce(sum(r.good_qty+r.defect_qty),0)::text AS report_qty, coalesce(sum(r.good_qty),0)::text AS good_qty, coalesce(sum(r.defect_qty),0)::text AS defect_qty, ${centsOf('TRUE')}::text AS wage_cents, ${centsOf("r.settlement_status='settled' AND r.wage_snapshot->>'mode'='time'")}::text AS settled_time_cents, ${centsOf("r.settlement_status='unsettled' AND r.wage_snapshot->>'mode'='time'")}::text AS unsettled_time_cents ${payrollFrom} WHERE ${built.where} GROUP BY r.operator_id, coalesce(mp.display_name, tm.display_name, ''), d.name ORDER BY name`, built.params)).rows;
    const moneyOf = (value: string) => money(BigInt(value.split('.')[0] ?? '0'));
    return { items: rows.map((row) => ({ ...row, settled_piece: moneyOf(row.settled_piece_cents), unsettled_piece: moneyOf(row.unsettled_piece_cents), settled_time: moneyOf(row.settled_time_cents), unsettled_time: moneyOf(row.unsettled_time_cents), wage: moneyOf(row.wage_cents) })) };
  }));

  app.get<{ Params: { userId: string }; Querystring: { report_from?: string; report_to?: string } }>('/api/payroll-statement/:userId/monthly', { preHandler: guard, schema: { params: object(['userId'], { userId: uuid }), querystring: { type: 'object', additionalProperties: false, properties: { report_from: dateField, report_to: dateField } } } }, (request) => database.tenant(context(request), async (sql) => {
    const a = actor(request); permit(a, 'production.read'); requireAllScope(a);
    if (!a.permissions.includes('payroll.read') && request.params.userId !== a.user_id) throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
    const built = payrollWhere(a, { ...request.query, user_id: request.params.userId });
    const rows = (await sql.query(`SELECT to_char(COALESCE(r.started_at,r.created_at) AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month, coalesce(sum(r.good_qty+r.defect_qty) FILTER (WHERE r.settlement_status='settled'),0)::text AS settled_qty, coalesce(sum(r.good_qty+r.defect_qty) FILTER (WHERE r.settlement_status='unsettled'),0)::text AS unsettled_qty, coalesce(sum(r.good_qty+r.defect_qty),0)::text AS report_qty, ${centsOf("r.settlement_status='settled' AND r.wage_snapshot->>'mode'='piece'")}::text AS settled_piece_cents, ${centsOf("r.settlement_status='unsettled' AND r.wage_snapshot->>'mode'='piece'")}::text AS unsettled_piece_cents, ${centsOf("r.settlement_status='settled' AND r.wage_snapshot->>'mode'='time'")}::text AS settled_time_cents, ${centsOf("r.settlement_status='unsettled' AND r.wage_snapshot->>'mode'='time'")}::text AS unsettled_time_cents, ${centsOf('TRUE')}::text AS wage_cents, coalesce(sum(r.good_qty),0)::text AS good_qty, coalesce(sum(r.defect_qty),0)::text AS defect_qty ${payrollFrom} WHERE ${built.where} GROUP BY 1 ORDER BY 1`, built.params)).rows as { month: string; settled_qty: string; unsettled_qty: string; report_qty: string; settled_piece_cents: string; unsettled_piece_cents: string; settled_time_cents: string; unsettled_time_cents: string; wage_cents: string; good_qty: string; defect_qty: string }[];
    const moneyOf = (value: string) => money(BigInt(value.split('.')[0] ?? '0'));
    const person = (await sql.query<{ name: string }>('SELECT coalesce(mp.display_name, tm.display_name) AS name FROM tenant_team_members tm LEFT JOIN tenant_member_profiles mp ON mp.user_id=tm.id WHERE tm.id=$1', [request.params.userId])).rows[0];
    return { user_id: request.params.userId, name: person?.name ?? '', items: rows.map((row) => ({ ...row, settled_piece: moneyOf(row.settled_piece_cents), unsettled_piece: moneyOf(row.unsettled_piece_cents), settled_time: moneyOf(row.settled_time_cents), unsettled_time: moneyOf(row.unsettled_time_cents), wage: moneyOf(row.wage_cents) })) };
  }));

  app.get<{ Params: { userId: string }; Querystring: { page?: string; page_size?: string; report_from?: string; report_to?: string; settled_from?: string; settled_to?: string; quality_status?: string } }>('/api/payroll-statement/:userId/details', { preHandler: guard, schema: { params: object(['userId'], { userId: uuid }), querystring: { type: 'object', additionalProperties: false, properties: { page: { type: 'string', pattern: '^[1-9]\\d{0,5}$' }, page_size: { type: 'string', pattern: '^[1-9]\\d{0,2}$' }, report_from: dateField, report_to: dateField, settled_from: dateField, settled_to: dateField, quality_status: { type: 'string', enum: ['pending', 'done', 'none'] } } } } }, (request) => database.tenant(context(request), async (sql) => {
    const a = actor(request); permit(a, 'production.read'); requireAllScope(a);
    if (!a.permissions.includes('payroll.read') && request.params.userId !== a.user_id) throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
    const built = payrollWhere(a, { ...request.query, user_id: request.params.userId });
    const page = Number(request.query.page ?? '1');
    const pageSize = Math.min(Number(request.query.page_size ?? '30'), 200);
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${payrollFrom} WHERE ${built.where}`, built.params)).rows[0]!.n);
    const rows = (await sql.query(`SELECT r.id,r.code,w.code AS work_order_code,w.product_snapshot->>'code' AS product_code,w.product_snapshot->>'name' AS product_name,coalesce(w.product_snapshot->>'unit_name','') AS unit_name,coalesce(p.specification,'') AS product_spec,t.process_snapshot->>'name' AS process_name,r.good_qty::text,r.defect_qty::text,(r.good_qty+r.defect_qty)::text AS report_qty,r.wage_snapshot,r.quality_status,r.settlement_status,r.effective_seconds,COALESCE(r.started_at,r.created_at) AS reported_at,r.note ${payrollFrom} JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id LEFT JOIN products p ON p.tenant_id=w.tenant_id AND p.id=w.product_id WHERE ${built.where} ORDER BY COALESCE(r.started_at,r.created_at) DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, built.params)).rows;
    return { items: rows.map((row) => { const snap = row.wage_snapshot as WageSnapshot | null; return { ...row, product_category: '', pricing_mode: snap?.mode ?? null, wage_rate: snap?.rate ?? null, wage: snap?.amount ?? null, unit_name: row.unit_name ?? '' }; }), total, page, page_size: pageSize };
  }));

  app.get('/api/production-tasks/batch-report-form', { preHandler: guard }, (request) => database.tenant(context(request), async (sql) => {
    permit(actor(request), 'production.read'); requireAllScope(actor(request));
    const row = (await sql.query<{ batch_report_form: { pc?: string[]; mobile?: string[] }; version: number }>('SELECT batch_report_form,version FROM tenant_report_prefs')).rows[0];
    const form = row?.batch_report_form ?? { pc: [], mobile: [] };
    return { pc: form.pc ?? [], mobile: form.mobile ?? [], version: row?.version ?? 1 };
  }));
  app.put<{ Body: { pc: string[]; mobile: string[]; version: number } }>('/api/production-tasks/batch-report-form', { preHandler: guard, schema: { body: object(['pc', 'mobile', 'version'], { pc: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 40 } }, mobile: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 40 } }, version: { type: 'integer', minimum: 1 } }) } }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const current = (await sql.query<{ version: number }>('SELECT version FROM tenant_report_prefs FOR UPDATE')).rows[0];
    if (!current || current.version !== request.body.version) throw new Problem(409, 'VERSION_CONFLICT', '设置已被修改，请刷新');
    await sql.query('UPDATE tenant_report_prefs SET batch_report_form=$1::jsonb,version=version+1,updated_at=now()', [JSON.stringify({ pc: request.body.pc, mobile: request.body.mobile })]);
    return { ok: true, version: current.version + 1 };
  }));
  app.post<{ Body: { task_ids: string[]; operator_ids: string[] } }>('/api/production-tasks/dispatch', { preHandler: guard, schema: { body: object(['task_ids', 'operator_ids'], { task_ids: { type: 'array', minItems: 1, maxItems: 200, items: uuid }, operator_ids: { type: 'array', minItems: 1, maxItems: 50, items: uuid } }) } }, (request) => run(request, async (sql, a) => {
    permit(a, 'production.write');
    const ops = request.body.operator_ids;
    const members = (await sql.query<{ id: string }>('SELECT id FROM tenant_team_members WHERE id=ANY($1::uuid[])', [ops])).rows;
    if (members.length !== ops.length) throw new Problem(422, 'INVALID_REFERENCE', '派工人员必须为本企业成员');
    for (const taskId of request.body.task_ids) {
      const task = (await sql.query<{ id: string; process_id: string }>('SELECT id,process_id FROM work_order_tasks WHERE id=$1', [taskId])).rows[0];
      if (!task) throw new Problem(404, 'TASK_NOT_FOUND', '生产任务不存在');
      for (const op of ops) await assertOperator(sql, a, task.process_id, op);
      await sql.query('UPDATE work_order_tasks SET dispatch_operator_ids=$1,version=version+1 WHERE id=$2', [ops, taskId]);
    }
    return { ok: true, count: request.body.task_ids.length };
  }));
}
