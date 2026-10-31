import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem, type Actor, type Services } from './services.js';
import { bodyOf, clean, withTenant } from './round8-kit.js';
import { formatDecimal, SCALE } from './decimal.js';

/** 人读数量(JS number) → 库内 numeric 字符串；formatDecimal 入参为微单位 bigint，不可对裸 10 再套一次。 */
function storeHumanQty(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return formatDecimal(0n);
  return formatDecimal(BigInt(Math.round(n * Number(SCALE))));
}

type Flag = { stock_main: boolean; stock_mat: boolean; occupy: boolean; ceil: boolean; wip: boolean; inbound: boolean; occupy_out: boolean };

async function explode(sql: Sql, productId: string, qty: number, depth: number, acc: Map<string, { product_id: string; name: string; source: string; gross: number }>) {
  if (depth > 16) return;
  const bom = (await sql.query<{ current_version_id: string }>('SELECT current_version_id FROM bom_definitions WHERE parent_product_id=$1 AND active ORDER BY is_default DESC, created_at DESC LIMIT 1', [productId])).rows[0];
  if (!bom) return;
  const items = (await sql.query<{ component_product_id: string; quantity: string; name: string; attribute: string }>('SELECT i.component_product_id,i.quantity::text,p.name,p.attribute FROM bom_items i JOIN products p ON p.id=i.component_product_id WHERE i.version_id=$1', [bom.current_version_id])).rows;
  for (const item of items) {
    const need = qty * Number(item.quantity);
    const prev = acc.get(item.component_product_id) ?? { product_id: item.component_product_id, name: item.name, source: item.attribute === 'purchased' ? '外购' : item.attribute === 'outsourced' ? '外协加工' : '自产', gross: 0 };
    prev.gross += need;
    acc.set(item.component_product_id, prev);
    if (item.attribute !== 'purchased') await explode(sql, item.component_product_id, need, depth + 1, acc);
  }
}

async function available(sql: Sql, productId: string) {
  const row = (await sql.query<{ n: string }>('SELECT coalesce(sum(on_hand-held_qty-blocked_qty-reserved_qty),0)::text AS n FROM stock_balances WHERE product_id=$1', [productId])).rows[0];
  return Number(row?.n ?? 0);
}

export async function runMaterialAnalysis(sql: Sql, actor: Actor, planId: string, flags: Flag, note: string) {
  const plan = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM production_plans WHERE id=$1 FOR UPDATE', [planId])).rows[0];
  if (!plan) throw new Problem(404, 'NOT_FOUND', '生产计划不存在');
  const lines = (await sql.query<{ id: string; product_id: string; plan_qty: string; attribute: string; name: string }>('SELECT pl.id,pl.product_id,pl.plan_qty::text,p.attribute,p.name FROM production_plan_lines pl JOIN products p ON p.id=pl.product_id WHERE pl.plan_id=$1 ORDER BY pl.line_no', [planId])).rows;
  const acc = new Map<string, { product_id: string; name: string; source: string; gross: number }>();
  // 成品行自身也计入需求：自产→加工、外协→外协、外购→采购，否则仅 BOM 展开时成品行没有 analysis_line，创建加工单会因缺 plan_line_id 禁用
  const lineDemands = new Map<string, { process: number; outsource: number; purchase: number }>();
  for (const line of lines) {
    let qty = Number(line.plan_qty);
    if (flags.stock_main) qty = Math.max(0, qty - await available(sql, line.product_id));
    if (flags.ceil) qty = Math.ceil(qty);
    const bucket = line.attribute === 'purchased' ? 'purchase' : line.attribute === 'outsourced' ? 'outsource' : 'process';
    const current = lineDemands.get(line.id) ?? { process: 0, outsource: 0, purchase: 0 };
    current[bucket] += qty;
    lineDemands.set(line.id, current);
    await explode(sql, line.product_id, qty, 0, acc);
  }
  let process = 0, outsource = 0, purchase = 0;
  const details: Record<string, unknown>[] = [];
  for (const item of acc.values()) {
    let gross = item.gross;
    if (flags.ceil) gross = Math.ceil(gross);
    const stock = flags.stock_mat ? await available(sql, item.product_id) : 0;
    const occupyQty = flags.occupy
      ? Number((await sql.query<{ n: string }>('SELECT coalesce(sum(qty),0)::text AS n FROM material_analysis_occupancy o JOIN production_plan_analyses a ON a.id=o.analysis_id WHERE o.product_id=$1 AND a.plan_id<>$2 AND a.status<>\'void\'', [item.product_id, planId])).rows[0]?.n ?? 0)
      : 0;
    const wip = flags.wip ? Number((await sql.query<{ n: string }>("SELECT coalesce(sum(w.plan_qty - coalesce((SELECT sum(quantity) FROM fg_receipts r WHERE r.work_order_id=w.id AND r.approval='approved'),0)),0)::text AS n FROM work_orders w WHERE w.product_id=$1 AND w.execution NOT IN ('cancelled','completed')", [item.product_id])).rows[0]?.n ?? 0) : 0;
    const inbound = flags.inbound ? Number((await sql.query<{ n: string }>("SELECT coalesce(sum(l.quantity - coalesce((SELECT sum(rl.quantity) FROM purchase_receipt_lines rl WHERE rl.purchase_line_id=l.id),0)),0)::text AS n FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.order_id WHERE l.product_id=$1 AND o.lifecycle NOT IN ('cancelled','closed')", [item.product_id])).rows[0]?.n ?? 0) : 0;
    const net = Math.max(0, gross - stock - occupyQty - wip - inbound);
    if (item.source === '外购') purchase += net;
    else if (item.source === '外协加工') outsource += net;
    else process += net;
    details.push({ ...item, gross, stock, occupy: occupyQty, wip, inbound, net });
  }
  for (const demand of lineDemands.values()) {
    process += demand.process;
    outsource += demand.outsource;
    purchase += demand.purchase;
  }
  const analysisId = (await sql.query<{ id: string }>('INSERT INTO production_plan_analyses(tenant_id,plan_id,process_demand_qty,outsource_demand_qty,purchase_demand_qty,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [actor.tenant_id, planId, storeHumanQty(process), storeHumanQty(outsource), storeHumanQty(purchase), actor.user_id])).rows[0]!.id;
  for (const line of lines) {
    const demand = lineDemands.get(line.id) ?? { process: 0, outsource: 0, purchase: 0 };
    for (const [kind, qty] of [['process', demand.process], ['outsource', demand.outsource], ['purchase', demand.purchase]] as const) {
      if (Number(qty) <= 0) continue;
      await sql.query(
        'INSERT INTO production_plan_analysis_lines(tenant_id,analysis_id,plan_line_id,demand_kind,demand_qty) VALUES($1,$2,$3,$4,$5)',
        [actor.tenant_id, analysisId, line.id, kind, storeHumanQty(Number(qty))],
      );
    }
  }
  if (flags.occupy) {
    for (const item of details) {
      const net = Number(item.net);
      if (net > 0) await sql.query('INSERT INTO material_analysis_occupancy(tenant_id,analysis_id,plan_id,product_id,qty,locked) VALUES($1,$2,$3,$4,$5,$6)', [actor.tenant_id, analysisId, planId, item.product_id, net, !flags.occupy_out]);
    }
  }
  await sql.query('UPDATE production_plans SET analyzed=true,version=version+1,updated_at=now() WHERE id=$1', [planId]);
  return { analysis_id: analysisId, note, details, process, outsource, purchase };
}

export function registerMaterialAnalysis(app: FastifyInstance, services: Services) {
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);
  app.post('/api/material-analyses', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const planId = clean(body.plan_id, 80, '生产计划', true);
    const flags: Flag = {
      stock_main: body.stock_main !== false,
      stock_mat: body.stock_mat !== false,
      occupy: body.occupy !== false,
      ceil: body.ceil !== false,
      wip: body.wip !== false,
      inbound: body.inbound !== false,
      occupy_out: body.occupy_out !== false,
    };
    return runMaterialAnalysis(sql, actor, planId, flags, clean(body.note, 255, '备注'));
  })));
}
