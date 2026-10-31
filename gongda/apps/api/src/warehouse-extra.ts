import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem, type Actor, type Services } from './services.js';
import { extensionRoutes, lockRow, stateConflict } from './extensions-common.js';
import { uuid, qtyField, keyField, shape, qty, formatDecimal, lineCents, permit, product, warehouse } from './business-common.js';
import { gateTenantWrite } from './assets.js';
import { available, lockBalance, postStock } from './inventory.js';
import { evalWarehouseCents, formulaDecimal, loadStockSettings, warehouseSerial } from './warehouse-stock.js';
import { progressText } from './money-calc.js';
import { auditRequired, markAuditExempt, registerPoster, startAudit } from './audit-engine.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

const miscKinds = ['else_in', 'else_out', 'semi_fg_in', 'sales_return', 'prod_return_mat'] as const;
type MiscKind = (typeof miscKinds)[number];

const miscSeries: Record<MiscKind, string> = {
  else_in: 'QTRK',
  else_out: 'QTCK',
  semi_fg_in: 'BCP',
  sales_return: 'XSTH',
  prod_return_mat: 'SCTL',
};

const miscSource: Record<MiscKind, string> = {
  else_in: 'else_in',
  else_out: 'else_out',
  semi_fg_in: 'semi_fg_in',
  sales_return: 'sales_return',
  prod_return_mat: 'prod_return_mat',
};

const miscLedger: Record<MiscKind, string> = {
  else_in: '其他入库',
  else_out: '其他出库',
  semi_fg_in: '半成品入库',
  sales_return: '销售退货',
  prod_return_mat: '生产退料',
};

export async function stockAuditOn(sql: Sql, objectType: string) {
  return auditRequired(sql, objectType);
}

function thresholdQty(value: string | null | undefined) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function signedQty(value: string) {
  const raw = String(value).trim();
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  return qty(body) * (negative ? -1n : 1n);
}

function qtyForSets(required: string, sets: string, plan: string) {
  const p = qty(plan);
  if (p === 0n) return '0.000000';
  return formatDecimal((qty(required) * qty(sets)) / p);
}

function issuedProgress(required: string, issued: string) {
  return progressText(issued, required);
}

async function lockWorkOrderRow(sql: Sql, id: string) {
  const row = (await sql.query<{ id: string; code: string; product_id: string; plan_qty: string; warehouse_id: string; execution: string; requires_fg_inspection: boolean; product_snapshot: { name?: string } }>(
    'SELECT id,code,product_id,plan_qty::text,warehouse_id,execution,requires_fg_inspection,product_snapshot FROM work_orders WHERE id=$1 FOR UPDATE',
    [id],
  )).rows[0];
  if (!row) throw new Problem(404, 'WORK_ORDER_NOT_FOUND', '加工单不存在');
  return row;
}

async function outputTaskId(sql: Sql, workOrderId: string) {
  return (await sql.query<{ id: string }>('SELECT id FROM work_order_tasks WHERE work_order_id=$1 AND is_output LIMIT 1', [workOrderId])).rows[0]?.id ?? null;
}

async function recomputeIssued(sql: Sql, materialIds: string[]) {
  if (!materialIds.length) return;
  await sql.query("UPDATE work_order_materials m SET issued_qty=(SELECT coalesce(sum(l.quantity),0) FROM material_issue_lines l JOIN material_issues i ON i.tenant_id=l.tenant_id AND i.id=l.issue_id WHERE l.material_id=m.id AND i.approval='approved') WHERE m.id=ANY($1::uuid[])", [materialIds]);
}

export async function approveMaterialIssue(sql: Sql, a: Actor, issueId: string) {
  const issue = (await sql.query<{ id: string; work_order_id: string; warehouse_id: string; approval: string }>('SELECT id,work_order_id,warehouse_id,approval FROM material_issues WHERE id=$1 FOR UPDATE', [issueId])).rows[0]!;
  if (issue.approval !== 'pending') return;
  const order = await lockWorkOrderRow(sql, issue.work_order_id);
  if (order.execution === 'cancelled') throw new Problem(409, 'STATE_TRANSITION', '已取消加工单不能领料过账');
  const lines = (await sql.query<{ id: string; material_id: string; product_id: string; unit_id: string; quantity: string }>('SELECT id,material_id,product_id,unit_id,quantity::text FROM material_issue_lines WHERE issue_id=$1', [issueId])).rows;
  const code = (await sql.query<{ code: string }>('SELECT code FROM material_issues WHERE id=$1', [issueId])).rows[0]!.code;
  for (const line of lines) {
    const material = (await sql.query<{ required_qty: string; issued_qty: string }>('SELECT required_qty::text,issued_qty::text FROM work_order_materials WHERE id=$1 FOR UPDATE', [line.material_id])).rows[0]!;
    if (qty(material.issued_qty) + qty(line.quantity) > qty(material.required_qty)) throw new Problem(422, 'OVER_ISSUE', '领料不能超过冻结需求');
    await postStock(sql, a, {
      warehouseId: issue.warehouse_id, productId: line.product_id, unitId: line.unit_id, direction: 'out', quantity: qty(line.quantity),
      sourceType: 'material_issue', sourceId: issueId, eventKey: `material_issue:${line.id}`, workOrderId: issue.work_order_id,
      ledger: { bizDate: todayISO(), docCode: code, ledgerKind: '生产出库' },
    });
  }
  await sql.query("UPDATE material_issues SET approval='approved',version=version+1,updated_at=now() WHERE id=$1", [issueId]);
  await recomputeIssued(sql, lines.map((l) => l.material_id));
}


async function assertFgPlanCap(sql: Sql, settings: Awaited<ReturnType<typeof loadStockSettings>>, workOrderId: string, planQty: string, thisQty: string, excludeReceiptId?: string) {
  if (settings.limit_fg_in) return; // 开：允许超计划
  const exclude = excludeReceiptId ? ' AND id<>$2' : '';
  const params = excludeReceiptId ? [workOrderId, excludeReceiptId] : [workOrderId];
  const received = qty((await sql.query<{ n: string }>(`SELECT coalesce(sum(quantity),0)::text AS n FROM fg_receipts WHERE work_order_id=$1 AND approval IN ('pending','approved')${exclude}`, params)).rows[0]!.n);
  const next = received + qty(thisQty);
  const plan = qty(planQty);
  if (next > plan) {
    throw new Problem(422, 'OVER_RECEIPT', `成品入库不能超过加工单计划数（计划 ${formatDecimal(plan)}，已入库 ${formatDecimal(received)}，本次 ${formatDecimal(qty(thisQty))}）`);
  }
}

export async function approveFgReceipt(sql: Sql, a: Actor, receiptId: string, settings: Awaited<ReturnType<typeof loadStockSettings>>) {
  const receipt = (await sql.query<{ id: string; code: string; work_order_id: string; warehouse_id: string; product_id: string; unit_id: string; quantity: string; approval: string }>(
    'SELECT id,code,work_order_id,warehouse_id,product_id,unit_id,quantity::text,approval FROM fg_receipts WHERE id=$1 FOR UPDATE',
    [receiptId],
  )).rows[0]!;
  if (receipt.approval !== 'pending') return;
  const order = await lockWorkOrderRow(sql, receipt.work_order_id);
  if (order.execution === 'cancelled') throw new Problem(409, 'STATE_TRANSITION', '已取消加工单不能入库');
  await assertFgPlanCap(sql, settings, order.id, order.plan_qty, receipt.quantity, receiptId);
  const next = qty((await sql.query<{ n: string }>("SELECT coalesce(sum(quantity),0)::text AS n FROM fg_receipts WHERE work_order_id=$1 AND approval IN ('pending','approved') AND id<>$2", [order.id, receiptId])).rows[0]!.n) + qty(receipt.quantity);
  if (order.requires_fg_inspection) {
    const accepted = qty((await sql.query<{ n: string }>("SELECT coalesce(sum(accepted_qty),0)::text AS n FROM inspections WHERE work_order_id=$1 AND state='completed' AND conclusion='pass'", [order.id])).rows[0]!.n);
    if (accepted < next) throw new Problem(422, 'QUALITY_REQUIRED', '检验放行数量不足，不能过账成品入库');
  }
  await postStock(sql, a, {
    warehouseId: receipt.warehouse_id, productId: receipt.product_id, unitId: receipt.unit_id, direction: 'in', quantity: qty(receipt.quantity),
    sourceType: 'fg_receipt', sourceId: receiptId, eventKey: `fg_receipt:${receiptId}`,
    ledger: { bizDate: todayISO(), docCode: receipt.code, ledgerKind: '成品入库' },
  });
  await sql.query("UPDATE fg_receipts SET approval='approved',version=version+1,updated_at=now() WHERE id=$1", [receiptId]);
}

async function miscView(sql: Sql, id: string) {
  const head = (await sql.query(`SELECT b.*,w.name AS warehouse_name,mc.code AS contract_code,cu.name AS customer_name,wo.code AS work_order_code,
    (SELECT coalesce(sum(l.amount_cents),0) FROM warehouse_misc_bill_lines l WHERE l.bill_id=b.id)::text AS amount_cents,
    (SELECT coalesce(sum(l.quantity),0)::text FROM warehouse_misc_bill_lines l WHERE l.bill_id=b.id) AS quantity
    FROM warehouse_misc_bills b
    LEFT JOIN warehouses w ON w.id=b.warehouse_id
    LEFT JOIN money_contracts mc ON mc.id=b.contract_id
    LEFT JOIN customers cu ON cu.id=mc.customer_id
    LEFT JOIN work_orders wo ON wo.id=b.work_order_id
    WHERE b.id=$1`, [id])).rows[0];
  if (!head) throw new Problem(404, 'NOT_FOUND', '单据不存在');
  const lines = (await sql.query('SELECT l.*,l.quantity::text,l.unit_price::text,l.amount_cents::text,p.name AS product_name,p.code AS product_code,p.specification AS product_spec FROM warehouse_misc_bill_lines l JOIN products p ON p.id=l.product_id WHERE l.bill_id=$1 ORDER BY l.id', [id])).rows;
  return { ...head, lines };
}

async function transferListView(sql: Sql, id: string) {
  const head = (await sql.query('SELECT b.*,fw.name AS from_warehouse_name,tw.name AS to_warehouse_name FROM stock_transfer_bills b JOIN warehouses fw ON fw.id=b.from_warehouse_id JOIN warehouses tw ON tw.id=b.to_warehouse_id WHERE b.id=$1', [id])).rows[0];
  if (!head) throw new Problem(404, 'NOT_FOUND', '调拨单不存在');
  const lines = (await sql.query('SELECT *,quantity::text FROM stock_transfer_lines WHERE bill_id=$1', [id])).rows;
  return { ...head, lines };
}

async function takingView(sql: Sql, id: string) {
  const head = (await sql.query('SELECT b.*,w.name AS warehouse_name FROM stock_taking_bills b JOIN warehouses w ON w.id=b.warehouse_id WHERE b.id=$1', [id])).rows[0];
  if (!head) throw new Problem(404, 'NOT_FOUND', '盘点单不存在');
  const lines = (await sql.query('SELECT *,book_qty::text,actual_qty::text,diff_qty::text FROM stock_taking_lines WHERE bill_id=$1', [id])).rows;
  return { ...head, lines };
}

async function fgListView(sql: Sql, id: string) {
  const row = (await sql.query<{ id: string; code: string; work_order_id: string; warehouse_id: string; product_id: string; quantity: string; approval: string; created_at: string; work_order_code: string; product_name: string; warehouse_name: string }>(
    `SELECT f.id,f.code,f.work_order_id,f.warehouse_id,f.product_id,f.quantity::text,f.approval,f.version,f.created_at,
      w.code AS work_order_code,w.product_snapshot->>'name' AS product_name,h.name AS warehouse_name
     FROM fg_receipts f JOIN work_orders w ON w.id=f.work_order_id JOIN warehouses h ON h.id=f.warehouse_id WHERE f.id=$1`,
    [id],
  )).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '成品入库单不存在');
  return row;
}

async function approveMisc(sql: Sql, a: Actor, id: string) {
  const bill = (await sql.query<{ id: string; bill_kind: MiscKind; code: string; warehouse_id: string | null; approval: string; contract_id: string | null; work_order_id: string | null }>(
    'SELECT id,bill_kind,code,warehouse_id,approval,contract_id,work_order_id FROM warehouse_misc_bills WHERE id=$1 FOR UPDATE',
    [id],
  )).rows[0]!;
  if (bill.approval !== 'pending') return;
  if (!bill.warehouse_id) throw new Problem(422, 'WAREHOUSE_REQUIRED', '必须指定仓库');
  const lines = (await sql.query<{ id: string; product_id: string; unit_id: string; quantity: string; unit_price: string; amount_cents: string }>(
    'SELECT id,product_id,unit_id,quantity::text,unit_price::text,amount_cents::text FROM warehouse_misc_bill_lines WHERE bill_id=$1',
    [id],
  )).rows;
  const direction = bill.bill_kind === 'else_out' ? 'out' : 'in';
  for (const line of lines) {
    if (direction === 'out') {
      const p = await product(sql, line.product_id);
      const bal = await lockBalance(sql, a, bill.warehouse_id!, p.id, p.unit_id);
      if (qty(line.quantity) > available(bal)) throw new Problem(409, 'INSUFFICIENT_AVAILABLE_STOCK', '可用库存不足');
    }
    await postStock(sql, a, {
      warehouseId: bill.warehouse_id!, productId: line.product_id, unitId: line.unit_id, direction, quantity: qty(line.quantity),
      sourceType: miscSource[bill.bill_kind], sourceId: id, eventKey: `${miscSource[bill.bill_kind]}:${line.id}`,
      workOrderId: bill.work_order_id ?? undefined,
      ledger: {
        bizDate: todayISO(), docCode: bill.code, ledgerKind: miscLedger[bill.bill_kind],
        inWh: direction === 'in' ? bill.warehouse_id : null,
        outWh: direction === 'out' ? bill.warehouse_id : null,
        saleAmountCents: bill.bill_kind === 'else_in' || bill.bill_kind === 'sales_return' ? BigInt(line.amount_cents) : undefined,
        costAmountCents: direction === 'out' ? BigInt(line.amount_cents) : undefined,
      },
    });
  }
  await sql.query("UPDATE warehouse_misc_bills SET approval='approved',audit_status='approved',version=version+1,updated_at=now() WHERE id=$1", [id]);
  if (bill.bill_kind === 'sales_return' && bill.contract_id) {
    const totalFen = lines.reduce((sum, line) => sum + BigInt(line.amount_cents || '0'), 0n);
    if (totalFen > 0n) {
      const customer = (await sql.query<{ customer_id: string }>('SELECT customer_id FROM money_contracts WHERE id=$1', [bill.contract_id])).rows[0];
      if (customer) {
        const yuan = `${totalFen / 100n}.${(totalFen % 100n).toString().padStart(2, '0')}`;
        await sql.query(
          "INSERT INTO money_cash(tenant_id,contract_id,customer_id,direction,amount,note,approval,source,created_by) VALUES($1,$2,$3,'in',$4,'销售退货','exempt','sales_return',$5)",
          [a.tenant_id, bill.contract_id, customer.customer_id, yuan, a.user_id],
        );
      }
    }
  }
}

export async function maybeStockAlerts(sql: Sql, a: Actor) {
  const settings = (await sql.query<{ alert_user_ids: string[] }>('SELECT alert_user_ids FROM stock_settings')).rows[0];
  const users = settings?.alert_user_ids ?? [];
  if (!users.length) return;
  const today = todayISO();
  const rows = (await sql.query<{ product_id: string; product_code: string; product_name: string; on_hand: string; stock_lower_warn: string | null; stock_upper_warn: string | null }>(
    `SELECT b.product_id,p.code AS product_code,p.name AS product_name,sum(b.on_hand)::text AS on_hand,p.stock_lower_warn::text,p.stock_upper_warn::text
     FROM stock_balances b JOIN products p ON p.id=b.product_id
     GROUP BY b.product_id,p.code,p.name,p.stock_lower_warn,p.stock_upper_warn`,
  )).rows;
  let ruleId = (await sql.query<{ id: string }>("SELECT id FROM event_rules WHERE tenant_id=$1 AND action='member.created' AND active=false LIMIT 1", [a.tenant_id])).rows[0]?.id;
  if (!ruleId) {
    ruleId = (await sql.query<{ id: string }>("INSERT INTO event_rules(tenant_id,action,recipient_ids,active) VALUES($1,'member.created',$2::jsonb,false) RETURNING id", [a.tenant_id, JSON.stringify([users[0]])])).rows[0]!.id;
  }
  for (const row of rows) {
    const onHand = Number(row.on_hand);
    const lower = thresholdQty(row.stock_lower_warn);
    const upper = thresholdQty(row.stock_upper_warn);
    let title: string | null = null;
    if (lower !== null && onHand < lower) title = '库存下限报警';
    else if (upper !== null && onHand > upper) title = '库存上限报警';
    if (!title) continue;
    const message = `${row.product_code} ${row.product_name} 当前库存 ${row.on_hand}`;
    for (const userId of users) {
      const exists = (await sql.query('SELECT id FROM user_notifications n WHERE n.user_id=$1 AND n.title=$2 AND n.message LIKE $3 AND (n.created_at AT TIME ZONE \'Asia/Shanghai\')::date=$4::date LIMIT 1', [userId, title, `%${row.product_code}%`, today])).rows[0];
      if (exists) continue;
      const auditId = (await sql.query<{ id: string }>('INSERT INTO audit_events(tenant_id,actor_id,actor_name,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [a.tenant_id, a.user_id, '库存报警', 'stock.alert', 'product', row.product_id])).rows[0]!.id;
      const eventId = (await sql.query<{ id: string }>(
        "INSERT INTO local_event_outbox(tenant_id,rule_id,source_audit_id,action,entity_id,actor_name,recipient_ids,state,delivered_at) VALUES($1,$2,$3,'stock.alert',$4,'库存报警',$5::jsonb,'delivered',now()) RETURNING id",
        [a.tenant_id, ruleId, auditId, row.product_id, JSON.stringify([userId])],
      )).rows[0]!.id;
      await sql.query('INSERT INTO user_notifications(tenant_id,event_id,user_id,title,message) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [a.tenant_id, eventId, userId, title, message]);
    }
  }
}

export function registerWarehouseExtra(app: FastifyInstance, s: Services) {
  for (const kind of miscKinds) registerPoster(kind, approveMisc);
  registerPoster('fg_receipt', async (sql, actor, id) => { await approveFgReceipt(sql, actor, id, await loadStockSettings(sql)); });
  registerPoster('material_issue', approveMaterialIssue);
  const { get, post } = extensionRoutes(app, s);
  const guard = s.authorize();

  get('/api/warehouse/work-orders', 'inventory.read', async (sql, _a, _id, q) => {
    const forFg = String(q.for ?? q.purpose ?? '') === 'fg';
    const rows = (await sql.query<{ id: string; code: string; plan_qty: string; product_name: string; received_fg_qty: string; required_total: string; issued_total: string; created_at: string; warehouse_id: string | null }>(
      forFg
        ? `SELECT w.id,w.code,w.plan_qty::text,w.warehouse_id::text AS warehouse_id,w.product_snapshot->>'name' AS product_name,w.created_at,
            coalesce((SELECT sum(f.quantity) FROM fg_receipts f WHERE f.work_order_id=w.id AND f.approval IN ('approved','pending')),0)::text AS received_fg_qty,
            coalesce((SELECT sum(m.required_qty) FROM work_order_materials m WHERE m.work_order_id=w.id),0)::text AS required_total,
            coalesce((SELECT sum(m.issued_qty) FROM work_order_materials m WHERE m.work_order_id=w.id),0)::text AS issued_total
           FROM work_orders w
           WHERE w.execution <> 'cancelled'
           ORDER BY w.created_at DESC LIMIT 200`
        : `SELECT w.id,w.code,w.plan_qty::text,w.warehouse_id::text AS warehouse_id,w.product_snapshot->>'name' AS product_name,w.created_at,
            coalesce((SELECT sum(f.quantity) FROM fg_receipts f WHERE f.work_order_id=w.id AND f.approval IN ('approved','pending')),0)::text AS received_fg_qty,
            coalesce((SELECT sum(m.required_qty) FROM work_order_materials m WHERE m.work_order_id=w.id),0)::text AS required_total,
            coalesce((SELECT sum(m.issued_qty) FROM work_order_materials m WHERE m.work_order_id=w.id),0)::text AS issued_total
           FROM work_orders w
           WHERE EXISTS (SELECT 1 FROM work_order_materials m WHERE m.work_order_id=w.id)
             AND w.execution NOT IN ('completed','cancelled','paused')
           ORDER BY w.created_at DESC LIMIT 200`,
    )).rows;
    return {
      items: rows.map((r) => ({
        id: r.id,
        code: r.code,
        product_name: r.product_name,
        warehouse_id: r.warehouse_id,
        plan_qty: formatDecimal(qty(r.plan_qty)),
        received_fg_qty: formatDecimal(qty(r.received_fg_qty)),
        issued_progress: issuedProgress(r.required_total, r.issued_total),
        fg_progress: progressText(r.received_fg_qty, formatDecimal(qty(r.plan_qty))),
      })),
      limit: 200,
    };
  });

  get('/api/warehouse/work-orders/:id/bom-lines', 'inventory.read', async (sql, _a, id) => {
    const materials = (await sql.query<{ id: string; product_id: string; product_name: string; required_qty: string; issued_qty: string }>(
      `SELECT m.id,m.product_id,m.component_snapshot->>'name' AS product_name,m.required_qty::text,m.issued_qty::text
       FROM work_order_materials m WHERE m.work_order_id=$1 ORDER BY m.component_snapshot->>'code'`,
      [id],
    )).rows;
    return {
      items: materials.map((m) => ({
        material_id: m.id,
        product_id: m.product_id,
        product_name: m.product_name,
        required_qty: formatDecimal(qty(m.required_qty)),
        issued_qty: formatDecimal(qty(m.issued_qty)),
        outbound_progress: issuedProgress(m.required_qty, m.issued_qty),
      })),
    };
  });

async function materialIssueListView(sql: Sql, id: string) {
  const row = (await sql.query<{ id: string; code: string; work_order_id: string; warehouse_id: string; approval: string; audit_status: string; created_at: string; warehouse_name: string; work_order_code: string }>(
    `SELECT i.id,i.code,i.work_order_id,i.warehouse_id,i.approval,i.audit_status,i.created_at,w.name AS warehouse_name,wo.code AS work_order_code
     FROM material_issues i JOIN warehouses w ON w.id=i.warehouse_id JOIN work_orders wo ON wo.id=i.work_order_id WHERE i.id=$1`,
    [id],
  )).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '生产出库单不存在');
  const lines = (await sql.query('SELECT *,quantity::text FROM material_issue_lines WHERE issue_id=$1', [id])).rows;
  return { ...row, lines };
}

  get('/api/warehouse/material-issues', 'inventory.read', async (sql) => {
    const ids = (await sql.query<{ id: string }>('SELECT id FROM material_issues ORDER BY created_at DESC LIMIT 200')).rows;
    return { items: await Promise.all(ids.map((r) => materialIssueListView(sql, r.id))), limit: 200 };
  });

  get('/api/warehouse/fg-receipts', 'inventory.read', async (sql, _a, _id, q) => {
    const params: unknown[] = [];
    let clause = '';
    if (q.work_order_id) { clause = 'WHERE f.work_order_id=$1'; params.push(q.work_order_id); }
    const ids = (await sql.query<{ id: string }>(`SELECT f.id FROM fg_receipts f ${clause} ORDER BY f.created_at DESC LIMIT 200`, params)).rows;
    return { items: await Promise.all(ids.map((r) => fgListView(sql, r.id))), limit: 200 };
  });

  get('/api/warehouse/fg-receipts/:id', 'inventory.read', async (sql, _a, id) => fgListView(sql, id));

  post<{ request_key: string; work_order_id: string; quantity: string; warehouse_id?: string }>(
    '/api/warehouse/fg-receipts', 'inventory.write',
    shape(['request_key', 'work_order_id', 'quantity'], { request_key: keyField, work_order_id: uuid, quantity: qtyField, warehouse_id: uuid, receipt_date: { type: 'string' } }),
    'fg_receipt', 'warehouse.fg_receipt.create', (sql, id) => fgListView(sql, id),
    async (sql, a, b) => {
      const settings = await loadStockSettings(sql);
      const order = await lockWorkOrderRow(sql, b.work_order_id);
      if (order.execution === 'cancelled') throw new Problem(409, 'STATE_TRANSITION', '已取消加工单不能入库');
      const taskId = await outputTaskId(sql, order.id);
      if (!taskId) throw new Problem(422, 'OUTPUT_TASK_REQUIRED', '成品入库必须指向产出任务');
      const warehouseId = b.warehouse_id ?? order.warehouse_id;
      await warehouse(sql, warehouseId);
      const p = await product(sql, order.product_id);
      await assertFgPlanCap(sql, settings, order.id, order.plan_qty, b.quantity);
      const needsAudit = await stockAuditOn(sql, 'fg_receipt');
      const code = await warehouseSerial(sql, a.tenant_id, 'CPRK', todayISO().replace(/-/g, ''), 3);
      const id = (await sql.query<{ id: string }>(
        'INSERT INTO fg_receipts(tenant_id,code,work_order_id,task_id,warehouse_id,product_id,unit_id,quantity,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [a.tenant_id, code, order.id, taskId, warehouseId, p.id, p.unit_id, b.quantity, a.user_id],
      )).rows[0]!.id;
      if (needsAudit) await sql.query("UPDATE fg_receipts SET audit_status='pending' WHERE id=$1", [id]);
      if (!needsAudit) await approveFgReceipt(sql, a, id, settings);
      else await startAudit(sql, a, 'fg_receipt', id);
      return id;
    },
  );

  post<{ request_key: string; work_order_id: string; sets: string; incomplete_only?: boolean; warehouse_id?: string; issue_date?: string }>(
    '/api/warehouse/material-issues', 'inventory.write',
    shape(['request_key', 'work_order_id', 'sets'], { request_key: keyField, work_order_id: uuid, sets: qtyField, incomplete_only: { type: 'boolean' }, warehouse_id: uuid, issue_date: { type: 'string' } }),
    'material_issue', 'warehouse.material_issue.create', async (sql, id) => {
      const issue = (await sql.query('SELECT * FROM material_issues WHERE id=$1', [id])).rows[0];
      const lines = (await sql.query('SELECT *,quantity::text FROM material_issue_lines WHERE issue_id=$1', [id])).rows;
      return { ...issue, lines };
    },
    async (sql, a, b) => {
      const order = await lockWorkOrderRow(sql, b.work_order_id);
      if (order.execution === 'cancelled' || order.execution === 'completed') throw new Problem(409, 'STATE_TRANSITION', '已取消或已完工的加工单不能领料');
      const warehouseId = b.warehouse_id || order.warehouse_id;
      if (!warehouseId) throw new Problem(422, 'REQUIRED', '请选择仓库', 'warehouse_id');
      await warehouse(sql, warehouseId);
      const materials = (await sql.query<{ id: string; product_id: string; unit_id: string; required_qty: string; issued_qty: string }>(
        'SELECT id,product_id,unit_id,required_qty::text,issued_qty::text FROM work_order_materials WHERE work_order_id=$1 FOR UPDATE',
        [order.id],
      )).rows;
      const incompleteOnly = b.incomplete_only !== false;
      const lines = materials.filter((m) => !incompleteOnly || qty(m.issued_qty) < qty(m.required_qty)).map((m) => ({
        material: m,
        quantity: qtyForSets(m.required_qty, b.sets, order.plan_qty),
      })).filter((l) => qty(l.quantity) > 0n);
      if (!lines.length) throw new Problem(422, 'NO_LINES', '没有可出库的物料行');
      const needsAudit = await stockAuditOn(sql, 'material_issue');
      const id = (await sql.query<{ id: string }>(
        'INSERT INTO material_issues(tenant_id,code,work_order_id,warehouse_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [a.tenant_id, await warehouseSerial(sql, a.tenant_id, 'SCCK', todayISO().replace(/-/g, ''), 3), order.id, warehouseId, a.user_id],
      )).rows[0]!.id;
      for (const line of lines) {
        const pending = qty((await sql.query<{ n: string }>("SELECT coalesce(sum(l.quantity),0)::text AS n FROM material_issue_lines l JOIN material_issues i ON i.id=l.issue_id WHERE l.material_id=$1 AND i.approval='pending'", [line.material.id])).rows[0]!.n);
        if (qty(line.material.issued_qty) + pending + qty(line.quantity) > qty(line.material.required_qty)) throw new Problem(422, 'OVER_ISSUE', '领料不能超过冻结需求');
        await sql.query('INSERT INTO material_issue_lines(tenant_id,issue_id,material_id,product_id,unit_id,quantity) VALUES($1,$2,$3,$4,$5,$6)', [a.tenant_id, id, line.material.id, line.material.product_id, line.material.unit_id, line.quantity]);
      }
      if (needsAudit) await sql.query("UPDATE material_issues SET audit_status='pending' WHERE id=$1", [id]);
      if (!needsAudit) await approveMaterialIssue(sql, a, id);
      else await startAudit(sql, a, 'material_issue', id);
      return id;
    },
  );

  post<{ request_key: string; work_order_id: string; warehouse_id: string; lines: { material_id: string; quantity: string }[]; note?: string }>(
    '/api/warehouse/material-returns', 'inventory.write',
    shape(['request_key', 'work_order_id', 'warehouse_id', 'lines'], {
      request_key: keyField, work_order_id: uuid, warehouse_id: uuid, note: { type: 'string' }, return_date: { type: 'string' },
      lines: { type: 'array', minItems: 1, items: shape(['material_id', 'quantity'], { material_id: uuid, quantity: qtyField }) },
    }),
    'misc_bill', 'warehouse.material_return.create', (sql, id) => miscView(sql, id),
    async (sql, a, b) => {
      await warehouse(sql, b.warehouse_id);
      await lockWorkOrderRow(sql, b.work_order_id);
      const needsAudit = await stockAuditOn(sql, 'prod_return_mat');
      const code = await warehouseSerial(sql, a.tenant_id, miscSeries.prod_return_mat, todayISO().replace(/-/g, ''), 3);
      const id = (await sql.query<{ id: string }>(
        'INSERT INTO warehouse_misc_bills(tenant_id,bill_kind,code,warehouse_id,work_order_id,note,approval,audit_status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [a.tenant_id, 'prod_return_mat', code, b.warehouse_id, b.work_order_id, b.note ?? '', 'pending', needsAudit ? 'pending' : 'exempt', a.user_id],
      )).rows[0]!.id;
      for (const line of b.lines) {
        const material = (await sql.query<{ product_id: string; unit_id: string }>('SELECT product_id,unit_id FROM work_order_materials WHERE id=$1 AND work_order_id=$2', [line.material_id, b.work_order_id])).rows[0];
        if (!material) throw new Problem(422, 'INVALID_REFERENCE', '退料行不属于该加工单');
        const p = await product(sql, material.product_id);
        await sql.query('INSERT INTO warehouse_misc_bill_lines(tenant_id,bill_id,product_id,unit_id,quantity,unit_price,amount_cents) VALUES($1,$2,$3,$4,$5,0,0)', [a.tenant_id, id, p.id, p.unit_id, line.quantity]);
      }
      if (!needsAudit) { await approveMisc(sql, a, id); await markAuditExempt(sql, 'warehouse_misc_bills', id); }
      else await startAudit(sql, a, 'prod_return_mat', id);
      return id;
    },
  );

  get('/api/warehouse/misc-bills', 'inventory.read', async (sql, _a, _id, q) => {
    const kind = q.kind;
    if (kind && !miscKinds.includes(kind as MiscKind)) throw new Problem(422, 'INVALID_KIND', '单据类型无效');
    const params: unknown[] = [];
    let clause = '1=1';
    if (kind) { clause += ' AND bill_kind=$1'; params.push(kind); }
    const rows = (await sql.query(`SELECT id FROM warehouse_misc_bills WHERE ${clause} ORDER BY created_at DESC LIMIT 200`, params)).rows;
    return { items: await Promise.all(rows.map((r) => miscView(sql, String(r.id)))), limit: 200 };
  });

  get('/api/warehouse/misc-bills/:id', 'inventory.read', async (sql, _a, id) => ({ bill: await miscView(sql, id) }));

  post<{ request_key: string; kind?: MiscKind; bill_kind?: MiscKind; warehouse_id?: string; contract_id?: string; work_order_id?: string; note?: string; source_id?: string; lines: { product_id: string; quantity: string; unit_price?: string }[] }>(
    '/api/warehouse/misc-bills', 'inventory.write',
    shape(['request_key', 'lines'], {
      request_key: keyField, kind: { type: 'string' }, bill_kind: { type: 'string' }, warehouse_id: uuid, contract_id: uuid, work_order_id: uuid, note: { type: 'string' }, source_id: uuid, bill_date: { type: 'string' },
      lines: { type: 'array', minItems: 1, items: shape(['product_id', 'quantity'], { product_id: uuid, quantity: qtyField, unit_price: { type: 'string' } }) },
    }),
    'misc_bill', 'warehouse.misc_bill.create', (sql, id) => miscView(sql, id),
    async (sql, a, b) => {
      const kind = (b.kind ?? b.bill_kind) as MiscKind;
      if (!miscKinds.includes(kind)) throw new Problem(422, 'INVALID_KIND', '单据类型无效');
      const settings = await loadStockSettings(sql);
      if (b.source_id && kind === 'else_out') {
        const src = await miscView(sql, b.source_id) as Record<string, unknown> & { lines: { product_id: string; quantity: string; unit_price?: string }[] };
        if (String(src.bill_kind) !== 'else_out') throw new Problem(422, 'INVALID_REFERENCE', '只能复制其他出库单');
        b = { ...b, warehouse_id: b.warehouse_id ?? String(src.warehouse_id ?? ''), note: b.note ?? String(src.note ?? ''), lines: src.lines.map((l) => ({ product_id: String(l.product_id), quantity: String(l.quantity), unit_price: String(l.unit_price ?? '0') })) };
      }
      if (b.warehouse_id) await warehouse(sql, b.warehouse_id);
      const needsAudit = await stockAuditOn(sql, kind);
      const code = await warehouseSerial(sql, a.tenant_id, miscSeries[kind], todayISO().replace(/-/g, ''), 3);
      const id = (await sql.query<{ id: string }>(
        'INSERT INTO warehouse_misc_bills(tenant_id,bill_kind,code,warehouse_id,contract_id,work_order_id,note,approval,audit_status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
        [a.tenant_id, kind, code, b.warehouse_id ?? null, b.contract_id ?? null, b.work_order_id ?? null, b.note ?? '', 'pending', needsAudit ? 'pending' : 'exempt', a.user_id],
      )).rows[0]!.id;
      for (const line of b.lines) {
        const p = await product(sql, line.product_id);
        let unitPrice = line.unit_price ?? '0';
        let amount = 0n;
        if (kind === 'else_in' || kind === 'sales_return') {
          if (kind === 'sales_return' && b.contract_id) {
            const cl = (await sql.query<{ unit_price: string }>('SELECT unit_price::text FROM money_contract_lines WHERE contract_id=$1 AND product_id=$2 ORDER BY line_no LIMIT 1', [b.contract_id, p.id])).rows[0];
            if (cl) unitPrice = formulaDecimal(String(cl.unit_price));
            const shipped = (await sql.query<{ n: string }>(`SELECT coalesce(sum(sl.quantity),0)::text AS n FROM shipment_lines sl JOIN shipments s ON s.tenant_id=sl.tenant_id AND s.id=sl.shipment_id WHERE s.contract_id=$1 AND sl.product_id=$2 AND s.approval='approved'`, [b.contract_id, p.id])).rows[0]!.n;
            const returned = (await sql.query<{ n: string }>(`SELECT coalesce(sum(l.quantity),0)::text AS n FROM warehouse_misc_bill_lines l JOIN warehouse_misc_bills r ON r.tenant_id=l.tenant_id AND r.id=l.bill_id WHERE r.contract_id=$1 AND r.bill_kind='sales_return' AND l.product_id=$2 AND r.approval IN ('pending','approved') AND r.id<>$3`, [b.contract_id, p.id, id])).rows[0]!.n;
            if (qty(line.quantity) + qty(returned) > qty(shipped)) throw new Problem(422, 'OVER_RETURN', '退货数量不能超过已出库数量减已退货');
          }
          const formulaKind = kind === 'sales_return' ? 'sale_return' : 'sale_out';
          const formula = kind === 'sales_return' ? settings.formula_sale_return : settings.formula_sale_out;
          amount = evalWarehouseCents(formulaKind, formula, unitPrice, line.quantity, settings.amount_scale);
        } else {
          amount = lineCents(qty(line.quantity), unitPrice);
        }
        await sql.query('INSERT INTO warehouse_misc_bill_lines(tenant_id,bill_id,product_id,unit_id,quantity,unit_price,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7)', [a.tenant_id, id, p.id, p.unit_id, line.quantity, unitPrice, amount.toString()]);
      }
      if (!needsAudit) { await approveMisc(sql, a, id); await markAuditExempt(sql, 'warehouse_misc_bills', id); }
      else await startAudit(sql, a, kind, id);
      return id;
    },
  );

  app.patch<{ Params: { id: string } }>('/api/warehouse/misc-bills/:id', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'inventory.write');
    await gateTenantWrite(sql, s.context(request));
    const row = (await sql.query<{ version: number; approval: string }>('SELECT version,approval FROM warehouse_misc_bills WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '单据不存在');
    if (row.approval === 'approved') throw new Problem(409, 'LOCKED', '已生效单据不能修改');
    const b = request.body as { note?: string; warehouse_id?: string };
    await sql.query('UPDATE warehouse_misc_bills SET note=coalesce($2,note),warehouse_id=coalesce($3,warehouse_id),version=version+1,updated_at=now() WHERE id=$1', [request.params.id, b.note, b.warehouse_id]);
    return { bill: await miscView(sql, request.params.id) };
  }));

  app.delete<{ Params: { id: string } }>('/api/warehouse/misc-bills/:id', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'inventory.write');
    const row = (await sql.query<{ approval: string }>('SELECT approval FROM warehouse_misc_bills WHERE id=$1', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '单据不存在');
    if (row.approval === 'approved') throw new Problem(409, 'LOCKED', '已生效单据不能删除');
    await sql.query('DELETE FROM warehouse_misc_bill_lines WHERE bill_id=$1', [request.params.id]);
    await sql.query('DELETE FROM warehouse_misc_bills WHERE id=$1', [request.params.id]);
    return { ok: true };
  }));

  get('/api/warehouse/transfer-bills', 'inventory.read', async (sql) => {
    const rows = (await sql.query('SELECT id FROM stock_transfer_bills ORDER BY created_at DESC LIMIT 200')).rows;
    return { items: await Promise.all(rows.map((r) => transferListView(sql, String(r.id)))), limit: 200 };
  });

  get('/api/warehouse/stock-taking-bills', 'inventory.read', async (sql, _a, _id, q) => {
    const state = q.state;
    const rows = state
      ? (await sql.query('SELECT id FROM stock_taking_bills WHERE state=$1 ORDER BY created_at DESC LIMIT 200', [state])).rows
      : (await sql.query('SELECT id FROM stock_taking_bills ORDER BY created_at DESC LIMIT 200')).rows;
    return { items: await Promise.all(rows.map((r) => takingView(sql, String(r.id)))), limit: 200 };
  });

  app.post<{ Params: { id: string }; Body: { request_key: string; version: number } }>('/api/warehouse/stock-taking-bills/:id/confirm', { preHandler: guard }, async (request, reply) => s.database.tenant(s.context(request), async (sql) => {
    const a = s.actor(request);
    permit(a, 'inventory.write');
    await gateTenantWrite(sql, s.context(request));
    const bill = await lockRow(sql, 'stock_taking_bills', request.params.id, request.body.version);
    if (String(bill.state) !== 'draft') throw stateConflict();
    const lines = (await sql.query<{ id: string; product_id: string; unit_id: string; diff_qty: string }>('SELECT id,product_id,unit_id,diff_qty::text FROM stock_taking_lines WHERE bill_id=$1', [request.params.id])).rows;
    const code = String(bill.code);
    for (const line of lines) {
      const diff = signedQty(line.diff_qty);
      if (diff === 0n) continue;
      const p = await product(sql, line.product_id);
      await postStock(sql, a, {
        warehouseId: String(bill.warehouse_id), productId: p.id, unitId: p.unit_id,
        direction: diff > 0n ? 'in' : 'out', quantity: diff > 0n ? diff : -diff,
        sourceType: 'stock_count', sourceId: request.params.id, eventKey: 'stock_taking:' + line.id,
        ledger: { bizDate: todayISO(), docCode: code, ledgerKind: '盘点' },
      });
    }
    await sql.query("UPDATE stock_taking_bills SET state='confirmed',version=version+1,updated_at=now() WHERE id=$1", [request.params.id]);
    return reply.send({ stock_taking_bill: await takingView(sql, request.params.id) });
  }));

  get('/api/warehouse/stock/balances', 'inventory.read', async (sql, a, _id, q) => {
    await maybeStockAlerts(sql, a);
    const onlyPositive = q.only_positive !== 'false';
    const byProduct = q.view === 'product';
    const alarm = q.alarm;
    const baseSelect = `b.product_id,p.code AS product_code,p.name AS product_name,p.sale_price::text,p.cost_price::text,p.stock_lower_warn::text,p.stock_upper_warn::text`;
    if (byProduct) {
      const rows = (await sql.query(`SELECT ${baseSelect},sum(b.on_hand)::text AS on_hand,sum(b.held_qty)::text AS held_qty,sum(b.blocked_qty)::text AS blocked_qty,sum(b.reserved_qty)::text AS reserved_qty,sum(b.on_hand-b.held_qty-b.blocked_qty-b.reserved_qty)::text AS available_qty FROM stock_balances b JOIN products p ON p.id=b.product_id ${onlyPositive ? 'WHERE b.on_hand>0' : ''} GROUP BY b.product_id,p.code,p.name,p.sale_price,p.cost_price,p.stock_lower_warn,p.stock_upper_warn ORDER BY p.code`)).rows;
      const items = rows.map((row) => {
        const onHand = Number(row.on_hand);
        const lower = thresholdQty(String(row.stock_lower_warn ?? ''));
        const upper = thresholdQty(String(row.stock_upper_warn ?? ''));
        let alert_level: 'lower' | 'upper' | 'normal' = 'normal';
        if (lower !== null && onHand < lower) alert_level = 'lower';
        else if (upper !== null && onHand > upper) alert_level = 'upper';
        return { ...row, alert_level, min_stock: row.stock_lower_warn, max_stock: row.stock_upper_warn };
      }).filter((row) => {
        if (!alarm || alarm === 'all') return true;
        if (alarm === 'low') return row.alert_level === 'lower';
        if (alarm === 'high') return row.alert_level === 'upper';
        if (alarm === 'ok') return row.alert_level === 'normal';
        return true;
      });
      return { view: 'product', items };
    }
    const rows = (await sql.query(`SELECT b.warehouse_id,w.code AS warehouse_code,b.product_id,${baseSelect},b.on_hand::text,b.held_qty::text,b.blocked_qty::text,b.reserved_qty::text,(b.on_hand-b.held_qty-b.blocked_qty-b.reserved_qty)::text AS available_qty FROM stock_balances b JOIN warehouses w ON w.id=b.warehouse_id JOIN products p ON p.id=b.product_id ${onlyPositive ? 'WHERE b.on_hand>0' : ''} ORDER BY w.code,p.code LIMIT 500`)).rows;
    const items = rows.map((row) => {
      const onHand = Number(row.on_hand);
      const lower = thresholdQty(String(row.stock_lower_warn ?? ''));
      const upper = thresholdQty(String(row.stock_upper_warn ?? ''));
      let alert_level: 'lower' | 'upper' | 'normal' = 'normal';
      if (lower !== null && onHand < lower) alert_level = 'lower';
      else if (upper !== null && onHand > upper) alert_level = 'upper';
      return { ...row, alert_level, min_stock: row.stock_lower_warn, max_stock: row.stock_upper_warn };
    }).filter((row) => {
      if (!alarm || alarm === 'all') return true;
      if (alarm === 'low') return row.alert_level === 'lower';
      if (alarm === 'high') return row.alert_level === 'upper';
      if (alarm === 'ok') return row.alert_level === 'normal';
      return true;
    });
    return { view: 'warehouse', items, limit: 500 };
  });
}
