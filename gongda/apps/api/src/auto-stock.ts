import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem, type Actor, type Services } from './services.js';
import { bodyOf, clean, idOf, withTenant } from './round8-kit.js';
import { startAudit } from './audit-engine.js';
import { loadStockSettings, warehouseSerial } from './warehouse-stock.js';
import { approveFgReceipt, approveMaterialIssue, stockAuditOn } from './warehouse-extra.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

async function writeLog(sql: Sql, actor: Actor, row: {
  eventId?: string | null;
  eventName: string;
  reportId?: string | null;
  reportCode?: string;
  workOrderCode?: string;
  billCode?: string;
  result: '成功' | '失败' | '提示';
  failReason?: string;
}) {
  await sql.query(
    `INSERT INTO auto_stock_logs(tenant_id,event_id,event_name,report_id,report_code,work_order_code,bill_code,result,fail_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [actor.tenant_id, row.eventId ?? null, row.eventName, row.reportId ?? null, row.reportCode ?? '', row.workOrderCode ?? '', row.billCode ?? '', row.result, row.failReason ?? ''],
  );
}

export async function runAutoStock(sql: Sql, a: Actor, ctx: { reportId: string; taskId: string; workOrderId: string }) {
  try {
    await sql.query('SAVEPOINT auto_stock');
    const report = (await sql.query<{ id: string; code: string; good_qty: string }>('SELECT id,code,good_qty::text FROM production_reports WHERE id=$1', [ctx.reportId])).rows[0];
    const order = (await sql.query<{ id: string; code: string; product_id: string; warehouse_id: string; plan_qty: string }>('SELECT id,code,product_id,warehouse_id,plan_qty::text FROM work_orders WHERE id=$1', [ctx.workOrderId])).rows[0];
    const task = (await sql.query<{ id: string; is_output: boolean }>('SELECT id,is_output FROM work_order_tasks WHERE id=$1', [ctx.taskId])).rows[0];
    if (!report || !order || !task) { await sql.query('RELEASE SAVEPOINT auto_stock'); return; }
    const events = (await sql.query<{ id: string; name: string; action_kind: string; warehouse_id: string | null }>('SELECT id,name,action_kind,warehouse_id FROM auto_stock_events WHERE enabled')).rows;
    for (const event of events) {
      const done = (await sql.query("SELECT 1 FROM auto_stock_logs WHERE report_id=$1 AND event_id=$2 AND result='成功'", [report.id, event.id])).rows[0];
      if (done) continue;
      if (event.action_kind === 'issue_bom') {
        const mats = (await sql.query<{ id: string; product_id: string; unit_id: string; required_qty: string }>(
          'SELECT id,product_id,unit_id,required_qty::text FROM work_order_materials WHERE work_order_id=$1 AND feeding_task_id=$2',
          [order.id, task.id],
        )).rows;
        if (!mats.length) continue;
        try {
          const warehouseId = event.warehouse_id || order.warehouse_id;
          const code = await warehouseSerial(sql, a.tenant_id, 'SCCK', todayISO().replace(/-/g, ''), 3);
          const issueId = (await sql.query<{ id: string }>('INSERT INTO material_issues(tenant_id,code,work_order_id,warehouse_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id', [a.tenant_id, code, order.id, warehouseId, a.user_id])).rows[0]!.id;
          const plan = Number(order.plan_qty) || 1;
          for (const mat of mats) {
            const unitQty = Number(mat.required_qty) / plan;
            const quantity = String(Number(report.good_qty) * unitQty);
            await sql.query('INSERT INTO material_issue_lines(tenant_id,issue_id,material_id,product_id,unit_id,quantity) VALUES($1,$2,$3,$4,$5,$6)', [a.tenant_id, issueId, mat.id, mat.product_id, mat.unit_id, quantity]);
          }
          if (await stockAuditOn(sql, 'material_issue')) {
            await sql.query("UPDATE material_issues SET audit_status='pending' WHERE id=$1", [issueId]);
            await startAudit(sql, a, 'material_issue', issueId);
          } else {
            await approveMaterialIssue(sql, a, issueId);
          }
          await writeLog(sql, a, { eventId: event.id, eventName: event.name, reportId: report.id, reportCode: report.code, workOrderCode: order.code, billCode: code, result: '成功' });
        } catch (error) {
          await writeLog(sql, a, { eventId: event.id, eventName: event.name, reportId: report.id, reportCode: report.code, workOrderCode: order.code, result: '失败', failReason: String((error as Error)?.message ?? error).slice(0, 200) });
        }
      }
      if (event.action_kind === 'receipt_fg' && task.is_output) {
        try {
          const warehouseId = event.warehouse_id || order.warehouse_id;
          const product = (await sql.query<{ id: string; unit_id: string }>('SELECT id,unit_id FROM products WHERE id=$1', [order.product_id])).rows[0]!;
          const code = await warehouseSerial(sql, a.tenant_id, 'CPRK', todayISO().replace(/-/g, ''), 3);
          const receiptId = (await sql.query<{ id: string }>('INSERT INTO fg_receipts(tenant_id,code,work_order_id,task_id,warehouse_id,product_id,unit_id,quantity,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [a.tenant_id, code, order.id, task.id, warehouseId, product.id, product.unit_id, report.good_qty, a.user_id])).rows[0]!.id;
          const settings = await loadStockSettings(sql);
          if (await stockAuditOn(sql, 'fg_receipt')) {
            await sql.query("UPDATE fg_receipts SET audit_status='pending' WHERE id=$1", [receiptId]);
            await startAudit(sql, a, 'fg_receipt', receiptId);
          } else {
            await approveFgReceipt(sql, a, receiptId, settings);
          }
          await writeLog(sql, a, { eventId: event.id, eventName: event.name, reportId: report.id, reportCode: report.code, workOrderCode: order.code, billCode: code, result: '成功' });
        } catch (error) {
          await writeLog(sql, a, { eventId: event.id, eventName: event.name, reportId: report.id, reportCode: report.code, workOrderCode: order.code, result: '失败', failReason: String((error as Error)?.message ?? error).slice(0, 200) });
        }
      }
    }
    await sql.query('RELEASE SAVEPOINT auto_stock');
  } catch (error) {
    try { await sql.query('ROLLBACK TO SAVEPOINT auto_stock'); await sql.query('RELEASE SAVEPOINT auto_stock'); } catch { /* ignore */ }
    await writeLog(sql, a, { eventName: '自动出入库', reportId: ctx.reportId, result: '失败', failReason: String((error as Error)?.message ?? error).slice(0, 200) });
  }
}

export function registerAutoStock(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);
  app.get('/api/auto-stock/events', (request) => read(request, async (sql) => {
    const q = request.query as { q?: string; enabled?: string };
    let items = (await sql.query('SELECT * FROM auto_stock_events ORDER BY created_at DESC')).rows;
    if (q.q) items = items.filter((row) => String(row.name).includes(q.q!));
    if (q.enabled === '1') items = items.filter((row) => row.enabled);
    if (q.enabled === '0') items = items.filter((row) => !row.enabled);
    return { items };
  }));
  app.post('/api/auto-stock/events', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const kind = clean(body.action_kind, 40, '执行事件', true);
    if (!['issue_bom', 'receipt_fg'].includes(kind)) throw new Problem(422, 'KIND', '请从模板创建');
    const name = clean(body.name, 80, '事件名称', true);
    const id = (await sql.query<{ id: string }>('INSERT INTO auto_stock_events(tenant_id,name,action_kind,content_text,warehouse_id,enabled) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [
      actor.tenant_id, name, kind, clean(body.content_text, 200, '事件内容'), clean(body.warehouse_id, 80, '仓库') || null, body.enabled !== false,
    ])).rows[0]!.id;
    return { id };
  })));
  app.patch('/api/auto-stock/events/:id', (request) => write(request, async (sql) => {
    const body = bodyOf(request);
    if (body.enabled !== undefined) await sql.query('UPDATE auto_stock_events SET enabled=$2 WHERE id=$1', [idOf(request), Boolean(body.enabled)]);
    return { ok: true };
  }));
  app.get('/api/auto-stock/logs', (request) => read(request, async (sql) => ({ items: (await sql.query('SELECT * FROM auto_stock_logs ORDER BY created_at DESC LIMIT 200')).rows })));
}
