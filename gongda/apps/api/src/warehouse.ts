import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem, requireAllScope, type Actor, type Services } from './services.js';
import { extensionRoutes, lockRow, actionShape, stateConflict } from './extensions-common.js';
import { uuid, qtyField, keyField, shape, qty, formatDecimal, lineCents, permit, reason, product, warehouse, nextCode } from './business-common.js';
import { tradeSource, reverseTrade } from './accounting.js';
import { available, lockBalance, postStock } from './inventory.js';
import { contractOutbound, evalWarehouseCents, formulaDecimal, listStockLedger, loadStockSettings, purchaseStockSummary, warehouseSerial } from './warehouse-stock.js';
import { gateTenantWrite } from './assets.js';
import { auditRequired, decideAudit, hasPendingInstance, markAuditExempt, registerPoster, startAudit } from './audit-engine.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

function requirePositiveQty(lines: { quantity: string }[], message: string) {
  if (lines.some((line) => qty(line.quantity) <= 0n)) throw new Problem(422, 'QUANTITY', message);
}

async function stockAuditOn(sql: Sql, objectType: string) {
  return auditRequired(sql, objectType);
}

export async function postTransferBill(sql: Sql, a: Actor, id: string) {
  const bill = (await sql.query<{ from_warehouse_id: string; to_warehouse_id: string; code: string; approval: string }>('SELECT from_warehouse_id,to_warehouse_id,code,approval FROM stock_transfer_bills WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!bill || bill.approval === 'approved') return;
  const lines = (await sql.query<{ id: string; product_id: string; unit_id: string; quantity: string }>('SELECT id,product_id,unit_id,quantity::text FROM stock_transfer_lines WHERE bill_id=$1', [id])).rows;
  for (const line of lines) {
    await postStock(sql, a, { warehouseId: bill.from_warehouse_id, productId: line.product_id, unitId: line.unit_id, direction: 'out', quantity: qty(line.quantity), sourceType: 'transfer_bill', sourceId: id, eventKey: 'transfer_bill_out:' + line.id, ledger: { docCode: bill.code, ledgerKind: '调拨出库', outWh: bill.from_warehouse_id, inWh: bill.to_warehouse_id, bizDate: todayISO() } });
    await postStock(sql, a, { warehouseId: bill.to_warehouse_id, productId: line.product_id, unitId: line.unit_id, direction: 'in', quantity: qty(line.quantity), sourceType: 'transfer_bill', sourceId: id, eventKey: 'transfer_bill_in:' + line.id, ledger: { docCode: bill.code, ledgerKind: '调拨入库', outWh: bill.from_warehouse_id, inWh: bill.to_warehouse_id, bizDate: todayISO() } });
  }
  await sql.query("UPDATE stock_transfer_bills SET approval='approved',audit_status='approved',version=version+1,updated_at=now() WHERE id=$1", [id]);
}

async function tenantId(sql: Sql) {
  return String((await sql.query<{ id: string }>("SELECT nullif(current_setting('app.tenant_id',true),'')::text AS id")).rows[0]!.id);
}
async function ensureSettings(sql: Sql) {
  await sql.query('INSERT INTO stock_settings(tenant_id,limit_purchase_in,limit_contract_out,limit_fg_in) VALUES($1,false,false,true) ON CONFLICT DO NOTHING', [await tenantId(sql)]);
}

async function warehouseView(sql: Sql, id: string) {
  const row = (await sql.query('SELECT id,code,name,active,version,province,city,district,address,manager_ids,created_at,updated_at FROM warehouses WHERE id=$1', [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '仓库不存在');
  return row;
}

async function nextWarehouseCode(sql: Sql, tenantId: string) {
  return warehouseSerial(sql, tenantId, 'WH', '', 4);
}

async function receiptView(sql: Sql, id: string) {
  const head = (await sql.query(`SELECT r.*,w.name AS warehouse_name,o.code AS order_code,
    (SELECT coalesce(sum(l.amount_cents),0) FROM purchase_receipt_lines l WHERE l.receipt_id=r.id)::text AS amount_cents
    FROM purchase_receipts r
    LEFT JOIN warehouses w ON w.id=r.warehouse_id
    LEFT JOIN purchase_orders o ON o.id=r.order_id
    WHERE r.id=$1`, [id])).rows[0];
  if (!head) throw new Problem(404, 'NOT_FOUND', '采购入库单不存在');
  const lines = (await sql.query('SELECT l.*,l.quantity::text,l.unit_price::text,l.amount_cents::text,p.name AS product_name FROM purchase_receipt_lines l JOIN products p ON p.id=l.product_id WHERE l.receipt_id=$1 ORDER BY product_id,l.id', [id])).rows;
  return { ...head, lines };
}

async function returnView(sql: Sql, id: string) {
  const head = (await sql.query(`SELECT b.*,w.name AS warehouse_name,o.code AS order_code,s.name AS supplier_name,
    (SELECT coalesce(sum(l.amount_cents),0) FROM purchase_return_lines l WHERE l.bill_id=b.id)::text AS amount_cents
    FROM purchase_return_bills b
    JOIN warehouses w ON w.id=b.warehouse_id
    JOIN purchase_orders o ON o.id=b.order_id
    JOIN suppliers s ON s.id=o.supplier_id
    WHERE b.id=$1`, [id])).rows[0];
  if (!head) throw new Problem(404, 'NOT_FOUND', '采购退货单不存在');
  const lines = (await sql.query('SELECT l.*,l.quantity::text,l.unit_price::text,l.amount_cents::text,p.name AS product_name FROM purchase_return_lines l JOIN products p ON p.id=l.product_id WHERE l.bill_id=$1', [id])).rows;
  return { ...head, lines };
}

async function shipmentView(sql: Sql, id: string) {
  const head = (await sql.query(`SELECT s.*,w.name AS warehouse_name,c.name AS customer_name,mc.code AS contract_code,
    (SELECT coalesce(sum(l.amount_cents),0) FROM shipment_lines l WHERE l.shipment_id=s.id)::text AS amount_cents
    FROM shipments s
    LEFT JOIN warehouses w ON w.id=s.warehouse_id
    LEFT JOIN customers c ON c.id=s.customer_id
    LEFT JOIN money_contracts mc ON mc.id=s.contract_id
    WHERE s.id=$1`, [id])).rows[0];
  if (!head) throw new Problem(404, 'NOT_FOUND', '销售出库单不存在');
  const lines = (await sql.query('SELECT l.*,l.quantity::text,l.unit_price::text,l.amount_cents::text,l.cost_unit_price::text,l.cost_amount_cents::text,p.name AS product_name FROM shipment_lines l JOIN products p ON p.id=l.product_id WHERE l.shipment_id=$1', [id])).rows;
  return { ...head, lines };
}

async function transferView(sql: Sql, id: string) {
  const head = (await sql.query('SELECT * FROM stock_transfer_bills WHERE id=$1', [id])).rows[0];
  if (!head) throw new Problem(404, 'NOT_FOUND', '调拨单不存在');
  const lines = (await sql.query('SELECT *,quantity::text FROM stock_transfer_lines WHERE bill_id=$1', [id])).rows;
  return { ...head, lines };
}

async function takingView(sql: Sql, id: string) {
  const head = (await sql.query('SELECT * FROM stock_taking_bills WHERE id=$1', [id])).rows[0];
  if (!head) throw new Problem(404, 'NOT_FOUND', '盘点单不存在');
  const lines = (await sql.query('SELECT *,book_qty::text,actual_qty::text,diff_qty::text FROM stock_taking_lines WHERE bill_id=$1', [id])).rows;
  return { ...head, lines };
}

async function approveReceipt(sql: Sql, a: Actor, id: string) {
  const r = (await sql.query<{ warehouse_id: string; order_id: string | null; code: string; approval: string }>('SELECT warehouse_id,order_id,code,approval FROM purchase_receipts WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
  if (r.approval !== 'pending') throw stateConflict();
  const po = r.order_id ? (await sql.query<{ supplier_id: string; approval: string; lifecycle: string }>('SELECT supplier_id,approval,lifecycle FROM purchase_orders WHERE id=$1', [r.order_id])).rows[0] : null;
  if (po && (po.approval !== 'approved' || po.lifecycle !== 'open')) throw new Problem(422, 'PURCHASE_ORDER_REQUIRED', '采购单状态不允许入库');
  const lines = (await sql.query<{ id: string; purchase_line_id: string; product_id: string; unit_id: string; quantity: string; amount_cents: string; requires_inspection: boolean }>('SELECT id,purchase_line_id,product_id,unit_id,quantity::text,amount_cents::text,requires_inspection FROM purchase_receipt_lines WHERE receipt_id=$1', [id])).rows;
  for (const l of lines) {
    await postStock(sql, a, { warehouseId: String(r.warehouse_id), productId: l.product_id, unitId: l.unit_id, direction: 'in', quantity: qty(l.quantity), sourceType: 'purchase_receipt', sourceId: id, eventKey: 'purchase_receipt:' + l.id, quality: l.requires_inspection ? 'held' : 'released', valueCents: BigInt(l.amount_cents), ledger: { bizDate: todayISO(), docCode: r.code, ledgerKind: '采购入库' } });
    if (po?.supplier_id) await tradeSource(sql, a, { kind: 'payable', partyId: po.supplier_id, sourceType: 'purchase_receipt', sourceId: l.id, eventKey: 'purchase_receipt:' + l.id, amount: BigInt(l.amount_cents) });
    else if (po && BigInt(l.amount_cents) > 0n) throw new Problem(422, 'INVALID_REFERENCE', '采购单未指定供应商，无法入库产生应付');
    if (l.requires_inspection) await sql.query('INSERT INTO incoming_inspections(tenant_id,code,receipt_line_id,quantity,created_by) VALUES($1,$2,$3,$4,$5)', [a.tenant_id, await nextCode(sql, a, 'IQC'), l.id, l.quantity, a.user_id]);
  }
  await sql.query("UPDATE purchase_receipts SET approval='approved',audit_status='approved',version=version+1 WHERE id=$1", [id]);
  for (const l of lines) if (l.purchase_line_id) await sql.query("UPDATE purchase_order_lines SET received_qty=(SELECT coalesce(sum(l.quantity),0) FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.tenant_id=l.tenant_id AND r.id=l.receipt_id WHERE l.purchase_line_id=$1 AND r.approval='approved') WHERE id=$1", [l.purchase_line_id]);
}

async function approveReturn(sql: Sql, a: Actor, id: string) {
  const r = (await sql.query<{ warehouse_id: string; order_id: string; code: string; approval: string }>('SELECT warehouse_id,order_id,code,approval FROM purchase_return_bills WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
  if (r.approval !== 'pending') throw stateConflict();
  const lines = (await sql.query<{ id: string; product_id: string; unit_id: string; quantity: string; amount_cents: string }>('SELECT id,product_id,unit_id,quantity::text,amount_cents::text FROM purchase_return_lines WHERE bill_id=$1', [id])).rows;
  for (const l of lines) {
    await postStock(sql, a, { warehouseId: String(r.warehouse_id), productId: l.product_id, unitId: l.unit_id, direction: 'out', quantity: qty(l.quantity), sourceType: 'purchase_return', sourceId: id, eventKey: 'purchase_return:' + l.id, ledger: { bizDate: todayISO(), docCode: r.code, ledgerKind: '采购退货', costAmountCents: BigInt(l.amount_cents) } });
  }
  await sql.query("UPDATE purchase_return_bills SET approval='approved',audit_status='approved',version=version+1,updated_at=now() WHERE id=$1", [id]);
}

async function approveShipment(sql: Sql, a: Actor, id: string) {
  const r = (await sql.query<{ warehouse_id: string; code: string; approval: string; contract_id: string | null }>('SELECT warehouse_id,code,approval,contract_id FROM shipments WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
  if (r.approval !== 'pending') throw stateConflict();
  const lines = (await sql.query<{ id: string; product_id: string; unit_id: string; quantity: string; amount_cents: string; cost_amount_cents: string }>('SELECT id,product_id,unit_id,quantity::text,amount_cents::text,cost_amount_cents::text FROM shipment_lines WHERE shipment_id=$1', [id])).rows;
  for (const l of lines) {
    await postStock(sql, a, { warehouseId: String(r.warehouse_id), productId: l.product_id, unitId: l.unit_id, direction: 'out', quantity: qty(l.quantity), sourceType: 'shipment', sourceId: id, eventKey: 'shipment:' + l.id, ledger: { bizDate: todayISO(), docCode: r.code, ledgerKind: '销售出库', saleAmountCents: BigInt(l.amount_cents), costAmountCents: BigInt(l.cost_amount_cents) } });
  }
  await sql.query("UPDATE shipments SET approval='approved',audit_status='approved',version=version+1,updated_at=now() WHERE id=$1", [id]);
  if (r.contract_id) {
    const contractLines = (await sql.query<{ id: string }>('SELECT id FROM money_contract_lines WHERE contract_id=$1', [r.contract_id])).rows.map((x) => x.id);
    if (contractLines.length) await sql.query("UPDATE money_contract_lines l SET shipped_qty=(SELECT coalesce(sum(sl.quantity),0) FROM shipment_lines sl JOIN shipments s ON s.tenant_id=sl.tenant_id AND s.id=sl.shipment_id WHERE sl.contract_line_id=l.id AND s.approval='approved') WHERE l.id=ANY($1::uuid[])", [contractLines]);
  }
}

export function registerWarehouse(app: FastifyInstance, s: Services) {
  registerPoster('purchase_receipt', approveReceipt);
  registerPoster('purchase_return', approveReturn);
  registerPoster('sale_shipment', approveShipment);
  registerPoster('KCDB', postTransferBill);
  const { get, post } = extensionRoutes(app, s);
  const guard = s.authorize();

  get('/api/warehouse/warehouses', 'inventory.read', async (sql) => ({ items: (await sql.query('SELECT id,code,name,active,version,province,city,district,address,manager_ids FROM warehouses ORDER BY code LIMIT 300')).rows, limit: 300 }));
  app.post<{ Body: { request_key: string; code?: string; name: string; province: string; city: string; district: string; address: string; manager_ids?: string[] } }>('/api/warehouse/warehouses', { preHandler: guard }, async (request, reply) => s.database.tenant(s.context(request), async (sql) => {
    const a = s.actor(request); permit(a, 'inventory.write'); requireAllScope(a); await gateTenantWrite(sql, s.context(request));
    const b = request.body;
    const code = b.code?.trim() || await nextWarehouseCode(sql, a.tenant_id);
    const id = (await sql.query<{ id: string }>('INSERT INTO warehouses(tenant_id,code,name,province,city,district,address,manager_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid[]) RETURNING id', [a.tenant_id, code, b.name, b.province, b.city, b.district, b.address, b.manager_ids ?? []])).rows[0]!.id;
    return reply.code(201).send({ warehouse: await warehouseView(sql, id) });
  }));
  app.patch<{ Params: { id: string } }>('/api/warehouse/warehouses/:id', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    const a = s.actor(request); permit(a, 'inventory.write'); requireAllScope(a); await gateTenantWrite(sql, s.context(request));
    const row = (await sql.query<{ version: number }>('SELECT version FROM warehouses WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '仓库不存在');
    const b = request.body as Record<string, unknown>;
    await sql.query('UPDATE warehouses SET name=coalesce($2,name),active=coalesce($3,active),province=coalesce($4,province),city=coalesce($5,city),district=coalesce($6,district),address=coalesce($7,address),manager_ids=coalesce($8,manager_ids),version=version+1,updated_at=now() WHERE id=$1', [request.params.id, b.name, b.active, b.province, b.city, b.district, b.address, b.manager_ids]);
    return { warehouse: await warehouseView(sql, request.params.id) };
  }));
  app.delete<{ Params: { id: string } }>('/api/warehouse/warehouses/:id', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    const a = s.actor(request); permit(a, 'inventory.write'); requireAllScope(a); await gateTenantWrite(sql, s.context(request));
    const id = request.params.id;
    if ((await sql.query('SELECT id FROM stock_balances WHERE warehouse_id=$1 AND on_hand>0 LIMIT 1', [id])).rows[0]) throw new Problem(409, 'WAREHOUSE_HAS_STOCK', '已经有库存或流水的仓库不能删除');
    if ((await sql.query('SELECT id FROM stock_ledger WHERE warehouse_id=$1 LIMIT 1', [id])).rows[0]) throw new Problem(409, 'WAREHOUSE_HAS_STOCK', '已经有库存或流水的仓库不能删除');
    if (!(await sql.query('DELETE FROM warehouses WHERE id=$1 RETURNING id', [id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '仓库不存在');
    return { ok: true };
  }));

  get('/api/warehouse/settings', 'inventory.read', async (sql) => {
    await ensureSettings(sql);
    const settings = (await sql.query('SELECT * FROM stock_settings')).rows[0];
    const ioTypes = (await sql.query('SELECT * FROM stock_io_types ORDER BY direction,sort,name')).rows;
    return { settings, io_types: ioTypes };
  });
  app.put('/api/warehouse/settings', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'inventory.write');
    const b = request.body as Record<string, unknown>;
    await ensureSettings(sql);
    await sql.query('UPDATE stock_settings SET limit_purchase_in=coalesce($1,limit_purchase_in),limit_contract_out=coalesce($2,limit_contract_out),limit_fg_in=coalesce($3,limit_fg_in),alert_user_ids=coalesce($4,alert_user_ids),hide_audit_status=coalesce($5,hide_audit_status),allow_withdraw=coalesce($6,allow_withdraw),formula_purchase_in=coalesce($7,formula_purchase_in),formula_purchase_return=coalesce($8,formula_purchase_return),formula_sale_out=coalesce($9,formula_sale_out),formula_sale_return=coalesce($10,formula_sale_return),amount_scale=coalesce($11,amount_scale),version=version+1,updated_at=now()', [b.limit_purchase_in, b.limit_contract_out, b.limit_fg_in, b.alert_user_ids, b.hide_audit_status, b.allow_withdraw, b.formula_purchase_in, b.formula_purchase_return, b.formula_sale_out, b.formula_sale_return, b.amount_scale]);
    return { settings: (await sql.query('SELECT * FROM stock_settings')).rows[0] };
  }));

  app.post('/api/warehouse/io-types', { preHandler: guard }, async (request, reply) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'inventory.write');
    const b = request.body as { direction: string; name: string; sort?: number };
    const id = (await sql.query<{ id: string }>('INSERT INTO stock_io_types(tenant_id,direction,name,sort) VALUES($1,$2,$3,$4) RETURNING id', [s.actor(request).tenant_id, b.direction, b.name, b.sort ?? 0])).rows[0]!.id;
    return reply.code(201).send({ item: (await sql.query('SELECT * FROM stock_io_types WHERE id=$1', [id])).rows[0] });
  }));
  app.patch<{ Params: { id: string } }>('/api/warehouse/io-types/:id', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'inventory.write');
    const b = request.body as Record<string, unknown>;
    await sql.query('UPDATE stock_io_types SET name=coalesce($2,name),sort=coalesce($3,sort),active=coalesce($4,active),version=version+1 WHERE id=$1', [request.params.id, b.name, b.sort, b.active]);
    return { item: (await sql.query('SELECT * FROM stock_io_types WHERE id=$1', [request.params.id])).rows[0] };
  }));
  app.delete<{ Params: { id: string } }>('/api/warehouse/io-types/:id', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'inventory.write');
    await sql.query('DELETE FROM stock_io_types WHERE id=$1', [request.params.id]);
    return { ok: true };
  }));

  get('/api/warehouse/audit-flows', 'inventory.read', async (sql) => ({ items: (await sql.query('SELECT * FROM stock_audit_flows ORDER BY name')).rows }));
  app.post('/api/warehouse/audit-flows', { preHandler: guard }, async (request, reply) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'inventory.write');
    const b = request.body as Record<string, unknown>;
    const id = (await sql.query<{ id: string }>('INSERT INTO stock_audit_flows(tenant_id,name,object_type,enabled,allow_withdraw,approver_ids,sign_mode) VALUES($1,$2,$3,coalesce($4,true),coalesce($5,false),$6::uuid[],coalesce($7,\'or\')) RETURNING id', [s.actor(request).tenant_id, b.name, b.object_type, b.enabled, b.allow_withdraw, b.approver_ids ?? [], b.sign_mode])).rows[0]!.id;
    return reply.code(201).send({ flow: (await sql.query('SELECT * FROM stock_audit_flows WHERE id=$1', [id])).rows[0] });
  }));
  app.patch<{ Params: { id: string } }>('/api/warehouse/audit-flows/:id', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'inventory.write');
    const b = request.body as Record<string, unknown>;
    await sql.query('UPDATE stock_audit_flows SET name=coalesce($2,name),enabled=coalesce($3,enabled),allow_withdraw=coalesce($4,allow_withdraw),approver_ids=coalesce($5,approver_ids),sign_mode=coalesce($6,sign_mode),version=version+1 WHERE id=$1', [request.params.id, b.name, b.enabled, b.allow_withdraw, b.approver_ids, b.sign_mode]);
    return { flow: (await sql.query('SELECT * FROM stock_audit_flows WHERE id=$1', [request.params.id])).rows[0] };
  }));

  get('/api/warehouse/purchase-receipts/:id', 'procurement.read', async (sql, _a, id) => receiptView(sql, id));
  get('/api/warehouse/purchase-receipts', 'procurement.read', async (sql, _a, _id, q) => {
    const orderId = q.order_id;
    const rows = orderId
      ? (await sql.query('SELECT id FROM purchase_receipts WHERE order_id=$1 ORDER BY created_at DESC LIMIT 200', [orderId])).rows
      : (await sql.query('SELECT id FROM purchase_receipts ORDER BY created_at DESC LIMIT 200')).rows;
    return { items: await Promise.all(rows.map((r) => receiptView(sql, String(r.id)))), limit: 200 };
  });

  post<{ request_key: string; order_id?: string; warehouse_id: string; receipt_date?: string; inbound_type?: string; receiver_id?: string; note?: string; lines: { purchase_line_id: string; quantity: string }[] }>(
    '/api/warehouse/purchase-receipts', 'procurement.write',
    shape(['request_key', 'warehouse_id', 'lines'], { request_key: keyField, order_id: uuid, warehouse_id: uuid, receipt_date: { type: 'string' }, inbound_type: { type: 'string' }, receiver_id: uuid, note: { type: 'string' }, lines: { type: 'array', minItems: 1, items: shape(['purchase_line_id', 'quantity'], { purchase_line_id: uuid, quantity: qtyField }) } }),
    'purchase_receipt', 'warehouse.purchase_receipt.create', (sql, id) => receiptView(sql, id),
    async (sql, a, b) => {
      requirePositiveQty(b.lines, '入库数量必须大于0');
      const settings = await loadStockSettings(sql);
      await warehouse(sql, b.warehouse_id);
      const needsAudit = await stockAuditOn(sql, 'purchase_receipt');
      const approval = 'pending';
      const auditStatus = needsAudit ? 'pending' : 'exempt';
      const orderIds = new Set<string>();
      for (const l of b.lines) {
        const source = (await sql.query<{ order_id: string; quantity: string; unit_price: string; amount_cents: string; product_id: string; unit_id: string; requires_inspection: boolean }>('SELECT order_id,quantity::text,unit_price::text,amount_cents::text,product_id,unit_id,requires_inspection FROM purchase_order_lines WHERE id=$1', [l.purchase_line_id])).rows[0];
        if (!source) throw new Problem(422, 'INVALID_REFERENCE', '采购明细不存在');
        orderIds.add(source.order_id);
        if (b.order_id && source.order_id !== b.order_id) throw new Problem(422, 'INVALID_REFERENCE', '明细必须属于同一采购单');
        const usedIn = (await sql.query<{ n: string }>("SELECT coalesce(sum(l.quantity),0)::text AS n FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.id=l.receipt_id WHERE l.purchase_line_id=$1 AND r.approval IN ('pending','approved')", [l.purchase_line_id])).rows[0]!.n;
        const usedRet = (await sql.query<{ n: string }>("SELECT coalesce(sum(l.quantity),0)::text AS n FROM purchase_return_lines l JOIN purchase_return_bills r ON r.id=l.bill_id WHERE l.purchase_line_id=$1 AND r.approval IN ('pending','approved')", [l.purchase_line_id])).rows[0]!.n;
        const n = qty(l.quantity);
        // DB 约束 received_qty<=quantity，超采购数量必须拦截，避免过账 500（与 limit_purchase_in 开关无关）
        if (qty(usedIn) - qty(usedRet) + n > qty(source.quantity)) {
          const snap = (await sql.query<{ name: string }>('SELECT product_snapshot->>\'name\' AS name FROM purchase_order_lines WHERE id=$1', [l.purchase_line_id])).rows[0];
          throw new Problem(422, 'OVER_RECEIPT', `商品${snap?.name ?? ''}采购数量${source.quantity}，已入库${formatDecimal(qty(usedIn) - qty(usedRet))}，本次入库将超出限制`);
        }
      }
      const orderId = b.order_id ?? [...orderIds][0] ?? null;
      if (orderId) {
        const po = (await sql.query<{ approval: string; lifecycle: string }>('SELECT approval,lifecycle FROM purchase_orders WHERE id=$1', [orderId])).rows[0];
        if (po && (po.approval !== 'approved' || po.lifecycle !== 'open')) throw new Problem(422, 'PURCHASE_ORDER_REQUIRED', '采购单状态不允许入库');
      }
      const code = await warehouseSerial(sql, a.tenant_id, 'CGRK', todayISO().replace(/-/g, ''), 3);
      const id = (await sql.query<{ id: string }>('INSERT INTO purchase_receipts(tenant_id,code,order_id,warehouse_id,receipt_date,inbound_type,receiver_id,note,approval,audit_status,created_by) VALUES($1,$2,$3,$4,coalesce($5,current_date),$6,$7,$8,$9,$10,$11) RETURNING id', [a.tenant_id, code, orderId, b.warehouse_id, b.receipt_date ?? null, b.inbound_type ?? '', b.receiver_id ?? null, b.note ?? '', approval, auditStatus, a.user_id])).rows[0]!.id;
      for (const l of b.lines) {
        const source = (await sql.query<{ id: string; quantity: string; unit_price: string; amount_cents: string; product_id: string; unit_id: string; requires_inspection: boolean }>('SELECT id,quantity::text,unit_price::text,amount_cents::text,product_id,unit_id,requires_inspection FROM purchase_order_lines WHERE id=$1', [l.purchase_line_id])).rows[0]!;
        const amount = evalWarehouseCents('purchase_in', settings.formula_purchase_in, source.unit_price, l.quantity, settings.amount_scale);
        await sql.query('INSERT INTO purchase_receipt_lines(tenant_id,receipt_id,purchase_line_id,product_id,unit_id,quantity,unit_price,amount_cents,requires_inspection) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [a.tenant_id, id, source.id, source.product_id, source.unit_id, l.quantity, source.unit_price, amount.toString(), source.requires_inspection]);
      }
      if (!needsAudit) { await approveReceipt(sql, a, id); await markAuditExempt(sql, 'purchase_receipts', id); }
      else await startAudit(sql, a, 'purchase_receipt', id);
      return id;
    },
  );

  post<{ request_key: string; action: string; version: number; reason?: string }>('/api/warehouse/purchase-receipts/:id/actions', 'procurement.approve', actionShape(['approve', 'reject', 'withdraw']), 'purchase_receipt', 'warehouse.purchase_receipt.action', (sql, id) => receiptView(sql, id), async (sql, a, b, id) => {
    const r = await lockRow(sql, 'purchase_receipts', id, b.version);
    if (await hasPendingInstance(sql, 'purchase_receipt', id)) await decideAudit(sql, a, 'purchase_receipt', id, b.action === 'approve' ? '通过' : b.action === 'reject' ? '退回' : '撤回', b.reason ?? '', '');
    else if (b.action === 'approve') { permit(a, 'procurement.approve'); await approveReceipt(sql, a, id); }
    else if (b.action === 'reject') { permit(a, 'procurement.approve'); if (r.approval !== 'pending') throw stateConflict(); reason(b.reason); await sql.query("UPDATE purchase_receipts SET approval='rejected',audit_status='rejected',version=version+1 WHERE id=$1", [id]); }
    else { if (r.approval !== 'pending' || r.audit_status !== 'pending') throw stateConflict(); await sql.query("UPDATE purchase_receipts SET approval='pending',audit_status='withdrawn',version=version+1 WHERE id=$1", [id]); }
    return id;
  }, false);

  get('/api/warehouse/purchase-returns', 'procurement.read', async (sql, _a, _id, q) => {
    const rows = q.order_id
      ? (await sql.query('SELECT id FROM purchase_return_bills WHERE order_id=$1 ORDER BY created_at DESC', [q.order_id])).rows
      : (await sql.query('SELECT id FROM purchase_return_bills ORDER BY created_at DESC LIMIT 200')).rows;
    return { items: await Promise.all(rows.map((r) => returnView(sql, String(r.id)))) };
  });

  post<{ request_key: string; order_id: string; warehouse_id: string; return_date?: string; note?: string; lines: { purchase_line_id: string; quantity: string }[] }>(
    '/api/warehouse/purchase-returns', 'procurement.write',
    shape(['request_key', 'order_id', 'warehouse_id', 'lines'], { request_key: keyField, order_id: uuid, warehouse_id: uuid, return_date: { type: 'string' }, note: { type: 'string' }, lines: { type: 'array', minItems: 1, items: shape(['purchase_line_id', 'quantity'], { purchase_line_id: uuid, quantity: qtyField }) } }),
    'purchase_return', 'warehouse.purchase_return.create', (sql, id) => returnView(sql, id),
    async (sql, a, b) => {
      const settings = await loadStockSettings(sql);
      await warehouse(sql, b.warehouse_id);
      const needsAudit = await stockAuditOn(sql, 'purchase_return');
      const code = await warehouseSerial(sql, a.tenant_id, 'CGTH', todayISO().replace(/-/g, ''), 3);
      const id = (await sql.query<{ id: string }>('INSERT INTO purchase_return_bills(tenant_id,code,order_id,warehouse_id,return_date,note,approval,audit_status,created_by) VALUES($1,$2,$3,$4,coalesce($5,current_date),$6,$7,$8,$9) RETURNING id', [a.tenant_id, code, b.order_id, b.warehouse_id, b.return_date ?? null, b.note ?? '', 'pending', needsAudit ? 'pending' : 'exempt', a.user_id])).rows[0]!.id;
      for (const l of b.lines) {
        const source = (await sql.query<{ id: string; unit_price: string; product_id: string; unit_id: string }>('SELECT id,unit_price::text,product_id,unit_id FROM purchase_order_lines WHERE id=$1 AND order_id=$2', [l.purchase_line_id, b.order_id])).rows[0];
        if (!source) throw new Problem(422, 'INVALID_REFERENCE', '退货明细必须属于本采购单');
        const received = (await sql.query<{ n: string }>("SELECT coalesce(sum(l.quantity),0)::text AS n FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.id=l.receipt_id WHERE l.purchase_line_id=$1 AND r.approval='approved'", [source.id])).rows[0]!.n;
        const returned = (await sql.query<{ n: string }>("SELECT coalesce(sum(l.quantity),0)::text AS n FROM purchase_return_lines l JOIN purchase_return_bills r ON r.id=l.bill_id WHERE l.purchase_line_id=$1 AND r.approval IN ('pending','approved')", [source.id])).rows[0]!.n;
        const n = qty(l.quantity);
        if (qty(returned) + n > qty(received)) throw new Problem(422, 'OVER_RETURN', '退货数量不能超过已入库数量减已退货');
        const amount = evalWarehouseCents('purchase_return', settings.formula_purchase_return, source.unit_price, l.quantity, settings.amount_scale);
        await sql.query('INSERT INTO purchase_return_lines(tenant_id,bill_id,purchase_line_id,product_id,unit_id,quantity,unit_price,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [a.tenant_id, id, source.id, source.product_id, source.unit_id, l.quantity, source.unit_price, amount.toString()]);
      }
      if (!needsAudit) { await approveReturn(sql, a, id); await markAuditExempt(sql, 'purchase_return_bills', id); }
      else await startAudit(sql, a, 'purchase_return', id);
      return id;
    },
  );

  post<{ request_key: string; action: string; version: number }>('/api/warehouse/purchase-returns/:id/actions', 'procurement.approve', actionShape(['approve', 'reject']), 'purchase_return', 'warehouse.purchase_return.action', (sql, id) => returnView(sql, id), async (sql, a, b, id) => {
    await lockRow(sql, 'purchase_return_bills', id, b.version);
    if (await hasPendingInstance(sql, 'purchase_return', id)) await decideAudit(sql, a, 'purchase_return', id, b.action === 'approve' ? '通过' : '退回', '', '');
    else if (b.action === 'approve') { permit(a, 'procurement.approve'); await approveReturn(sql, a, id); }
    else { permit(a, 'procurement.approve'); await sql.query("UPDATE purchase_return_bills SET approval='rejected',audit_status='rejected',version=version+1 WHERE id=$1", [id]); }
    return id;
  }, false);

  get('/api/warehouse/shipments', 'inventory.read', async (sql, _a, _id, q) => {
    const rows = q.contract_id
      ? (await sql.query('SELECT id FROM shipments WHERE contract_id=$1 ORDER BY created_at DESC', [q.contract_id])).rows
      : (await sql.query('SELECT id FROM shipments ORDER BY created_at DESC LIMIT 200')).rows;
    return { items: await Promise.all(rows.map((r) => shipmentView(sql, String(r.id)))) };
  });

  post<{ request_key: string; contract_id?: string; customer_id?: string; warehouse_id: string; ship_date?: string; outbound_type?: string; outbound_mode?: string; shipper_id?: string; contact_name?: string; contact_phone?: string; ship_address?: string; note?: string; lines: { contract_line_id?: string; product_id?: string; quantity: string; unit_price?: string }[] }>(
    '/api/warehouse/shipments', 'inventory.write',
    shape(['request_key', 'warehouse_id', 'lines'], { request_key: keyField, contract_id: uuid, customer_id: uuid, warehouse_id: uuid, ship_date: { type: 'string' }, outbound_type: { type: 'string' }, outbound_mode: { type: 'string' }, shipper_id: uuid, contact_name: { type: 'string' }, contact_phone: { type: 'string' }, ship_address: { type: 'string' }, note: { type: 'string' }, lines: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['quantity'], properties: { contract_line_id: uuid, product_id: uuid, quantity: qtyField, unit_price: { type: 'string' } } } } }),
    'shipment', 'warehouse.shipment.create', (sql, id) => shipmentView(sql, id),
    async (sql, a, b) => {
      requirePositiveQty(b.lines, '出库数量必须大于0');
      const settings = await loadStockSettings(sql);
      await warehouse(sql, b.warehouse_id);
      const direct = (b.outbound_mode === '直接出库') || !b.contract_id;
      const needsAudit = await stockAuditOn(sql, 'sale_shipment');
      const code = await warehouseSerial(sql, a.tenant_id, 'HTCK', todayISO().replace(/-/g, ''), 3);
      let customerId: string | null = b.customer_id ?? null;
      let contractId: string | null = null;
      if (!direct) {
        const contract = (await sql.query<{ customer_id: string; approval: string }>('SELECT customer_id,approval FROM money_contracts WHERE id=$1', [b.contract_id])).rows[0];
        if (!contract || !['approved', 'exempt'].includes(contract.approval)) throw new Problem(422, 'INVALID_REFERENCE', '合同不存在或未审核');
        customerId = contract.customer_id;
        contractId = b.contract_id!;
      } else if (customerId) {
        if (!(await sql.query('SELECT id FROM customers WHERE id=$1', [customerId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '客户不存在');
      }
      const id = (await sql.query<{ id: string }>('INSERT INTO shipments(tenant_id,code,sales_order_id,customer_id,contract_id,warehouse_id,ship_date,outbound_type,outbound_mode,shipper_id,contact_name,contact_phone,ship_address,approval,audit_status,created_by) VALUES($1,$2,NULL,$3,$4,$5,coalesce($6,current_date),$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id', [a.tenant_id, code, customerId, contractId, b.warehouse_id, b.ship_date ?? null, b.outbound_type ?? '', b.outbound_mode ?? (direct ? '直接出库' : '合同出库'), b.shipper_id ?? null, b.contact_name ?? '', b.contact_phone ?? '', b.ship_address ?? '', 'pending', needsAudit ? 'pending' : 'exempt', a.user_id])).rows[0]!.id;
      for (const l of b.lines) {
        let productId: string;
        let contractLineId: string | null = null;
        let unitPriceSrc: string;
        if (!direct) {
          if (!l.contract_line_id) throw new Problem(422, 'REQUIRED', '请选择合同明细', 'contract_line_id');
          const source = (await sql.query<{ id: string; product_id: string; quantity: string; unit_price: string }>('SELECT id,product_id,quantity::text,unit_price::text FROM money_contract_lines WHERE id=$1 AND contract_id=$2', [l.contract_line_id, contractId])).rows[0];
          if (!source) throw new Problem(422, 'INVALID_REFERENCE', '合同明细不存在');
          productId = source.product_id;
          contractLineId = source.id;
          unitPriceSrc = l.unit_price ?? source.unit_price;
          const shipped = (await sql.query<{ n: string }>("SELECT coalesce(sum(sl.quantity),0)::text AS n FROM shipment_lines sl JOIN shipments s ON s.id=sl.shipment_id WHERE sl.contract_line_id=$1 AND s.approval IN ('pending','approved')", [source.id])).rows[0]!.n;
          const nCheck = qty(l.quantity);
          if (settings.limit_contract_out && qty(shipped) + nCheck > qty(source.quantity)) throw new Problem(422, 'OVER_SHIPMENT', '出库数量超过合同销售数量');
        } else {
          if (!l.product_id) throw new Problem(422, 'REQUIRED', '请选择出库商品', 'product_id');
          productId = l.product_id;
          unitPriceSrc = l.unit_price ?? '0';
        }
        const p = await product(sql, productId);
        const n = qty(l.quantity);
        const bal = await lockBalance(sql, a, b.warehouse_id, p.id, p.unit_id);
        if (n > available(bal)) throw new Problem(409, 'INSUFFICIENT_AVAILABLE_STOCK', '可用库存不足');
        const price = formulaDecimal(unitPriceSrc || '0');
        const amount = evalWarehouseCents('sale_out', settings.formula_sale_out, price, l.quantity, settings.amount_scale);
        const rateInput = (() => { const raw = String(unitPriceSrc || '0').trim() || '0'; return /^(?:0|[1-9]\d{0,13})(?:\.\d{1,7})?$/.test(raw) ? raw : '0'; })();
        const costAmount = lineCents(n, rateInput);
        await sql.query('INSERT INTO shipment_lines(tenant_id,shipment_id,sales_line_id,contract_line_id,product_id,unit_id,quantity,unit_price,amount_cents,cost_unit_price,cost_amount_cents) VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$7,$9)', [a.tenant_id, id, contractLineId, p.id, p.unit_id, l.quantity, price, amount.toString(), costAmount.toString()]);
      }
      if (!needsAudit) { await approveShipment(sql, a, id); await markAuditExempt(sql, 'shipments', id); }
      else await startAudit(sql, a, 'sale_shipment', id);
      return id;
    },
  );


  post<{ request_key: string; action: string; version: number }>('/api/warehouse/shipments/:id/actions', 'inventory.approve', actionShape(['approve', 'reject']), 'shipment', 'warehouse.shipment.action', (sql, id) => shipmentView(sql, id), async (sql, a, b, id) => {
    await lockRow(sql, 'shipments', id, b.version);
    if (await hasPendingInstance(sql, 'sale_shipment', id)) await decideAudit(sql, a, 'sale_shipment', id, b.action === 'approve' ? '通过' : '退回', '', '');
    else if (b.action === 'approve') { permit(a, 'inventory.approve'); await approveShipment(sql, a, id); }
    else { permit(a, 'inventory.approve'); await sql.query("UPDATE shipments SET approval='rejected',audit_status='rejected',version=version+1 WHERE id=$1", [id]); }
    return id;
  }, false);

  get('/api/warehouse/stock/ledger', 'inventory.read', async (sql, _a, _id, q) => listStockLedger(sql, q));

  app.get<{ Params: { id: string } }>('/api/warehouse/purchase-orders/:id/stock-summary', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'procurement.read');
    return purchaseStockSummary(sql, request.params.id);
  }));
  app.get<{ Params: { id: string } }>('/api/warehouse/contracts/:id/outbound-summary', { preHandler: guard }, (request) => s.database.tenant(s.context(request), async (sql) => {
    permit(s.actor(request), 'sales.read');
    return contractOutbound(sql, request.params.id);
  }));

  post<{ request_key: string; from_warehouse_id: string; to_warehouse_id: string; transfer_date?: string; note?: string; lines: { product_id: string; quantity: string }[] }>(
    '/api/warehouse/transfer-bills', 'inventory.write',
    shape(['request_key', 'from_warehouse_id', 'to_warehouse_id', 'lines'], { request_key: keyField, from_warehouse_id: uuid, to_warehouse_id: uuid, transfer_date: { type: 'string' }, note: { type: 'string' }, lines: { type: 'array', minItems: 1, items: shape(['product_id', 'quantity'], { product_id: uuid, quantity: qtyField }) } }),
    'transfer_bill', 'warehouse.transfer.create', (sql, id) => transferView(sql, id),
    async (sql, a, b) => {
      if (b.from_warehouse_id === b.to_warehouse_id) throw new Problem(422, 'SAME_WAREHOUSE', '发仓和收仓必须不同');
      await warehouse(sql, b.from_warehouse_id); await warehouse(sql, b.to_warehouse_id);
      const needsAudit = await stockAuditOn(sql, 'KCDB');
      const code = await warehouseSerial(sql, a.tenant_id, 'KCDB', todayISO().replace(/-/g, ''), 3);
      const id = (await sql.query<{ id: string }>('INSERT INTO stock_transfer_bills(tenant_id,code,from_warehouse_id,to_warehouse_id,transfer_date,note,approval,audit_status,created_by) VALUES($1,$2,$3,$4,coalesce($5,current_date),$6,$7,$8,$9) RETURNING id', [a.tenant_id, code, b.from_warehouse_id, b.to_warehouse_id, b.transfer_date ?? null, b.note ?? '', needsAudit ? 'pending' : 'approved', needsAudit ? 'pending' : 'exempt', a.user_id])).rows[0]!.id;
      for (const l of b.lines) {
        const p = await product(sql, l.product_id);
        const bal = await lockBalance(sql, a, b.from_warehouse_id, p.id, p.unit_id);
        if (qty(l.quantity) > available(bal)) throw new Problem(409, 'INSUFFICIENT_AVAILABLE_STOCK', '调拨数量超过可用库存');
        await sql.query('INSERT INTO stock_transfer_lines(tenant_id,bill_id,product_id,unit_id,quantity) VALUES($1,$2,$3,$4,$5)', [a.tenant_id, id, p.id, p.unit_id, l.quantity]);
        if (!needsAudit) {
          const lineId = (await sql.query<{ id: string }>('SELECT id FROM stock_transfer_lines WHERE bill_id=$1 AND product_id=$2', [id, p.id])).rows[0]!.id;
          await postStock(sql, a, { warehouseId: b.from_warehouse_id, productId: p.id, unitId: p.unit_id, direction: 'out', quantity: qty(l.quantity), sourceType: 'transfer_bill', sourceId: id, eventKey: 'transfer_bill_out:' + lineId, ledger: { docCode: code, ledgerKind: '调拨出库', outWh: b.from_warehouse_id, inWh: b.to_warehouse_id, bizDate: todayISO() } });
          await postStock(sql, a, { warehouseId: b.to_warehouse_id, productId: p.id, unitId: p.unit_id, direction: 'in', quantity: qty(l.quantity), sourceType: 'transfer_bill', sourceId: id, eventKey: 'transfer_bill_in:' + lineId, ledger: { docCode: code, ledgerKind: '调拨入库', outWh: b.from_warehouse_id, inWh: b.to_warehouse_id, bizDate: todayISO() } });
        }
      }
      if (needsAudit) await startAudit(sql, a, 'KCDB', id);
      return id;
    },
  );

  post<{ request_key: string; warehouse_id: string; mode?: string; taking_date?: string; taker_id?: string; note?: string; confirm?: boolean; lines: { product_id: string; actual_qty: string }[] }>(
    '/api/warehouse/stock-taking-bills', 'inventory.write',
    shape(['request_key', 'warehouse_id', 'lines'], { request_key: keyField, warehouse_id: uuid, mode: { type: 'string' }, taking_date: { type: 'string' }, taker_id: uuid, note: { type: 'string' }, confirm: { type: 'boolean' }, lines: { type: 'array', items: shape(['product_id', 'actual_qty'], { product_id: uuid, actual_qty: qtyField }) } }),
    'stock_taking', 'warehouse.taking.create', (sql, id) => takingView(sql, id),
    async (sql, a, b) => {
      await warehouse(sql, b.warehouse_id);
      const code = await warehouseSerial(sql, a.tenant_id, 'PK', todayISO().replace(/-/g, ''), 3);
      const state = b.confirm ? 'confirmed' : 'draft';
      if (!b.taker_id) throw new Problem(422, 'REQUIRED', '请选择盘点人', 'taker_id');
      const id = (await sql.query<{ id: string }>('INSERT INTO stock_taking_bills(tenant_id,code,warehouse_id,taking_date,taker_id,mode,note,state,approval,audit_status,created_by) VALUES($1,$2,$3,coalesce($4,current_date),$5,coalesce($6,\'custom\'),$7,$8,\'approved\',\'exempt\',$9) RETURNING id', [a.tenant_id, code, b.warehouse_id, b.taking_date ?? null, b.taker_id, b.mode ?? 'custom', b.note ?? '', state, a.user_id])).rows[0]!.id;
      let diffTotal = 0n;
      for (const l of b.lines) {
        const p = await product(sql, l.product_id);
        const bal = await lockBalance(sql, a, b.warehouse_id, p.id, p.unit_id);
        const book = qty(bal.on_hand);
        const actual = qty(l.actual_qty);
        const diff = actual - book;
        diffTotal += diff;
        await sql.query('INSERT INTO stock_taking_lines(tenant_id,bill_id,product_id,unit_id,book_qty,actual_qty,diff_qty) VALUES($1,$2,$3,$4,$5,$6,$7)', [a.tenant_id, id, p.id, p.unit_id, formatDecimal(book), formatDecimal(actual), formatDecimal(diff)]);
        if (b.confirm && diff !== 0n) {
          const lineId = (await sql.query<{ id: string }>('SELECT id FROM stock_taking_lines WHERE bill_id=$1 AND product_id=$2', [id, p.id])).rows[0]!.id;
          await postStock(sql, a, { warehouseId: b.warehouse_id, productId: p.id, unitId: p.unit_id, direction: diff > 0n ? 'in' : 'out', quantity: diff > 0n ? diff : -diff, sourceType: 'stock_count', sourceId: id, eventKey: 'stock_taking:' + lineId, ledger: { docCode: code, ledgerKind: '盘点', bizDate: todayISO() } });
        }
      }
      await sql.query('UPDATE stock_taking_bills SET diff_total=$2 WHERE id=$1', [id, formatDecimal(diffTotal)]);
      return id;
    },
  );
}
