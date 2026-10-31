import type { Sql } from './database.js';
import { allocateByRule, seriesRuleName } from './code-rules.js';
import { evaluateFormula } from './formula.js';
import { progressText, parseMoney, formatMoney } from './money-calc.js';
const moneyText = (cents: bigint) => formatMoney(parseMoney(money(cents) ?? '0'));
import { money, qty, formatDecimal } from './business-common.js';

export const EFFECTIVE_APPROVAL = "approval = 'approved'";

export function effectiveApprovalSql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `(${p}approval = 'approved')`;
}

export type StockSettings = {
  limit_purchase_in: boolean;
  limit_contract_out: boolean;
  limit_fg_in: boolean;
  amount_scale: number;
  formula_purchase_in: string;
  formula_purchase_return: string;
  formula_sale_out: string;
  formula_sale_return: string;
};

export async function loadStockSettings(sql: Sql): Promise<StockSettings> {
  const tenant = (await sql.query<{ id: string }>("SELECT nullif(current_setting('app.tenant_id',true),'')::text AS id")).rows[0]!.id;
  await sql.query('INSERT INTO stock_settings(tenant_id,limit_purchase_in,limit_contract_out,limit_fg_in) VALUES($1,false,false,true) ON CONFLICT DO NOTHING', [tenant]);
  const row = (await sql.query<StockSettings>('SELECT limit_purchase_in,limit_contract_out,limit_fg_in,amount_scale,formula_purchase_in,formula_purchase_return,formula_sale_out,formula_sale_return FROM stock_settings')).rows[0];
  if (!row) throw new Error('stock_settings missing');
  return row;
}

const zhVarMap: Record<string, Record<string, string>> = {
  purchase_in: { '明细.采购单价': 'unit_price', '明细.采购数量': 'quantity' },
  purchase_return: { '明细.采购单价': 'unit_price', '明细.退货数量': 'quantity' },
  sale_out: { '明细.销售单价': 'unit_price', '明细.销售数量': 'quantity' },
  sale_return: { '明细.销售单价': 'unit_price', '明细.退货数量': 'quantity' },
};

export function mapChineseFormula(expression: string, kind: keyof typeof zhVarMap) {
  const map = zhVarMap[kind];
  if (!map) return expression;
  let out = expression;
  for (const [zh, en] of Object.entries(map)) {
    out = out.split('${' + zh + '}').join(en);
    out = out.split(zh).join(en);
  }
  return out.replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, '$1');
}

export function formulaVariables(kind: keyof typeof zhVarMap) {
  const map = zhVarMap[kind];
  if (!map) return [];
  return Object.values(map).map((name) => ({ name }));
}

export function formulaDecimal(value: string) {
  const raw = String(value).trim();
  const m = raw.match(/^(-?(?:0|[1-9]\d*))(?:\.(\d*))?$/);
  if (!m) return raw;
  const frac = (m[2] ?? '').slice(0, 6);
  const normalized = frac ? `${m[1]}.${frac}` : m[1]!;
  return formatDecimal(qty(normalized));
}

export function evalWarehouseAmount(kind: keyof typeof zhVarMap, expression: string, unitPrice: string, quantity: string, scale: number) {
  const mapped = mapChineseFormula(expression, kind);
  const vars = formulaVariables(kind);
  const result = evaluateFormula(mapped, vars, { unit_price: formulaDecimal(unitPrice), quantity: formulaDecimal(quantity) });
  const raw = parseMoney(result.result);
  const factor = 10n ** BigInt(8 - scale);
  const rounded = scale >= 8 ? raw : ((raw + factor / 2n) / factor) * factor;
  return formatMoney(rounded);
}

export function evalWarehouseCents(kind: keyof typeof zhVarMap, expression: string, unitPrice: string, quantity: string, scale: number) {
  const amount = evalWarehouseAmount(kind, expression, unitPrice, quantity, scale);
  return (parseMoney(amount) * 100n) / 10n ** 8n;
}

export async function warehouseSerial(sql: Sql, tenantId: string, series: string, period: string, width: number) {
  if (seriesRuleName[series]) {
    const coded = await allocateByRule(sql, tenantId, seriesRuleName[series]);
    if (coded) return coded;
  }
  await sql.query('INSERT INTO warehouse_counters(tenant_id,series,period,next_value) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING', [tenantId, series, period]);
  const current = BigInt((await sql.query<{ n: string }>('SELECT next_value::text AS n FROM warehouse_counters WHERE tenant_id=$1 AND series=$2 AND period=$3 FOR UPDATE', [tenantId, series, period])).rows[0]!.n);
  await sql.query('UPDATE warehouse_counters SET next_value=$1 WHERE tenant_id=$2 AND series=$3 AND period=$4', [(current + 1n).toString(), tenantId, series, period]);
  return series + (period || '') + current.toString().padStart(width, '0');
}

export async function purchaseStockSummary(sql: Sql, orderId: string) {
  const eff = effectiveApprovalSql('r');
  const inboundCents = BigInt((await sql.query<{ n: string }>(`SELECT coalesce(sum(l.amount_cents),0)::text AS n FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.tenant_id=l.tenant_id AND r.id=l.receipt_id WHERE r.order_id=$1 AND ${eff}`, [orderId])).rows[0]!.n);
  const returnCents = BigInt((await sql.query<{ n: string }>(`SELECT coalesce(sum(l.amount_cents),0)::text AS n FROM purchase_return_lines l JOIN purchase_return_bills r ON r.tenant_id=l.tenant_id AND r.id=l.bill_id WHERE r.order_id=$1 AND ${eff}`, [orderId])).rows[0]!.n);
  const receiptCount = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM purchase_receipts r WHERE r.order_id=$1 AND ${eff}`, [orderId])).rows[0]!.n);
  const returnCount = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM purchase_return_bills r WHERE r.order_id=$1 AND ${eff}`, [orderId])).rows[0]!.n);
  const lines = (await sql.query<{ id: string; product_id: string; quantity: string; received_qty: string; product_snapshot: { name?: string } }>(
    'SELECT id,product_id,quantity::text,received_qty::text,product_snapshot FROM purchase_order_lines WHERE order_id=$1 ORDER BY line_no',
    [orderId],
  )).rows;
  const lineProgress = [];
  for (const line of lines) {
    const received = (await sql.query<{ n: string }>(`SELECT coalesce(sum(l.quantity),0)::text AS n FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.tenant_id=l.tenant_id AND r.id=l.receipt_id WHERE l.purchase_line_id=$1 AND ${eff}`, [line.id])).rows[0]!.n;
    const returned = (await sql.query<{ n: string }>(`SELECT coalesce(sum(l.quantity),0)::text AS n FROM purchase_return_lines l JOIN purchase_return_bills r ON r.tenant_id=l.tenant_id AND r.id=l.bill_id WHERE l.purchase_line_id=$1 AND ${eff}`, [line.id])).rows[0]!.n;
    const net = formatDecimal(qty(received) - qty(returned));
    lineProgress.push({
      purchase_line_id: line.id,
      product_id: line.product_id,
      product_name: line.product_snapshot?.name ?? '',
      order_qty: formatDecimal(qty(line.quantity)),
      received_qty: net,
      progress: progressText(net, formatDecimal(qty(line.quantity))),
    });
  }
  return {
    inbound_amount: moneyText(inboundCents),
    return_amount: moneyText(returnCents),
    receipt_count: receiptCount,
    return_count: returnCount,
    lines: lineProgress,
  };
}

export async function contractOutbound(sql: Sql, contractId: string) {
  const eff = effectiveApprovalSql('s');
  const lines = (await sql.query<{ id: string; product_id: string; quantity: string; product_name: string }>(
    'SELECT id,product_id,quantity::text,product_name FROM money_contract_lines WHERE contract_id=$1 ORDER BY line_no',
    [contractId],
  )).rows;
  const shipmentCount = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM shipments s WHERE s.contract_id=$1 AND ${eff}`, [contractId])).rows[0]!.n);
  const doneAt = (await sql.query<{ d: string | null }>(`SELECT max(s.ship_date)::text AS d FROM shipments s WHERE s.contract_id=$1 AND ${eff}`, [contractId])).rows[0]!.d;
  const lineProgress = [];
  for (const line of lines) {
    const shipped = (await sql.query<{ n: string }>(`SELECT coalesce(sum(sl.quantity),0)::text AS n FROM shipment_lines sl JOIN shipments s ON s.tenant_id=sl.tenant_id AND s.id=sl.shipment_id WHERE sl.contract_line_id=$1 AND ${eff}`, [line.id])).rows[0]!.n;
    const returned = (await sql.query<{ n: string }>(`SELECT coalesce(sum(l.quantity),0)::text AS n FROM warehouse_misc_bill_lines l JOIN warehouse_misc_bills b ON b.tenant_id=l.tenant_id AND b.id=l.bill_id WHERE b.contract_id=$1 AND b.bill_kind='sales_return' AND b.approval='approved' AND l.product_id=$2`, [contractId, line.product_id])).rows[0]!.n;
    const net = qty(shipped) - qty(returned);
    const netText = formatDecimal(net < 0n ? 0n : net);
    lineProgress.push({
      contract_line_id: line.id,
      product_id: line.product_id,
      product_name: line.product_name,
      order_qty: formatDecimal(qty(line.quantity)),
      shipped_qty: netText,
      progress: progressText(netText, formatDecimal(qty(line.quantity))),
      complete: net >= qty(line.quantity),
    });
  }
  const allComplete = lineProgress.length > 0 && lineProgress.every((l) => l.complete);
  return {
    shipment_count: shipmentCount,
    outbound_complete_date: allComplete ? doneAt : null,
    lines: lineProgress,
  };
}

export function resolveLedgerKind(sourceType: string, direction: string, ledgerKind?: string | null) {
  if (ledgerKind) return ledgerKind;
  if (sourceType === 'adjustment') return direction === 'in' ? '其他入库' : '其他出库';
  const map: Record<string, string> = {
    purchase_receipt: '采购入库',
    purchase_return: '采购退货',
    shipment: '销售出库',
    fg_receipt: '成品入库',
    material_issue: '生产出库',
    supplement_issue: '补投出库',
    stock_count: '盘点',
    transfer_bill: direction === 'in' ? '调拨入库' : '调拨出库',
    transfer_in: '调拨入库',
    transfer_out: '调拨出库',
    else_in: '其他入库',
    else_out: '其他出库',
    semi_fg_in: '半成品入库',
    sales_return: '销售退货',
    prod_return_mat: '生产退料',
  };
  return map[sourceType] ?? sourceType;
}

function centsDisplay(cents: string | null | undefined) {
  if (cents == null || cents === '') return '';
  const n = BigInt(String(cents).split('.')[0] ?? '0');
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export async function listStockLedger(sql: Sql, q: Record<string, string | undefined>) {
  const clauses = ['1=1'];
  const params: unknown[] = [];
  let i = 1;
  const bind = (value: unknown) => {
    params.push(value);
    return `$${i++}`;
  };
  if (q.warehouse_id) clauses.push(`l.warehouse_id=${bind(q.warehouse_id)}`);
  if (q.in_warehouse_id) clauses.push(`coalesce(l.in_warehouse_id,l.warehouse_id)=${bind(q.in_warehouse_id)}`);
  if (q.out_warehouse_id) clauses.push(`l.out_warehouse_id=${bind(q.out_warehouse_id)}`);
  if (q.product_id) clauses.push(`l.product_id=${bind(q.product_id)}`);
  if (q.source_type) clauses.push(`l.source_type=${bind(q.source_type)}`);
  if (q.direction) clauses.push(`l.direction=${bind(q.direction)}`);
  if (q.seq_no) clauses.push(`l.seq_no::text=${bind(q.seq_no)}`);
  if (q.doc_code) clauses.push(`position(lower(${bind(q.doc_code)}) in lower(coalesce(l.doc_code,'')))>0`);
  if (q.from) clauses.push(`l.biz_date>=${bind(q.from)}`);
  if (q.to) clauses.push(`l.biz_date<=${bind(q.to)}`);
  if (q.biz_from) clauses.push(`l.biz_date>=${bind(q.biz_from)}`);
  if (q.biz_to) clauses.push(`l.biz_date<=${bind(q.biz_to)}`);
  if (q.posted_from) clauses.push(`(l.posted_at AT TIME ZONE 'Asia/Shanghai')::date>=${bind(q.posted_from)}::date`);
  if (q.posted_to) clauses.push(`(l.posted_at AT TIME ZONE 'Asia/Shanghai')::date<=${bind(q.posted_to)}::date`);
  if (q.q) {
    const ref = bind(q.q);
    clauses.push(`(${ref}='' OR position(lower(${ref}) in lower(p.name||' '||p.code||' '||coalesce(p.specification,'')))>0)`);
  }
  if (q.category_id) {
    clauses.push(`p.category_id IN (WITH RECURSIVE tree AS (SELECT id FROM product_categories WHERE id=${bind(q.category_id)} UNION ALL SELECT c2.id FROM product_categories c2 JOIN tree t ON c2.parent_id=t.id) SELECT id FROM tree)`);
  }
  if (q.work_order_id) clauses.push(`l.work_order_id=${bind(q.work_order_id)}`);
  const where = clauses.join(' AND ');
  type Row = Record<string, unknown>;
  const rows = (await sql.query<Row>(
    `SELECT l.id,l.seq_no::text,l.warehouse_id,l.product_id,l.direction,l.quantity::text,l.balance_after::text,
      l.source_type,l.source_id,l.doc_code,l.ledger_kind,l.biz_date,l.posted_at,l.in_warehouse_id,l.out_warehouse_id,
      l.remark,l.reversal_of,l.work_order_id,l.created_by,
      l.cost_unit_price::text,l.cost_amount_cents::text,l.sale_unit_price::text,l.sale_amount_cents::text,
      p.name AS product_name,p.code AS product_code,p.specification AS product_spec,
      pc.name AS category_name,u.name AS unit_name,
      coalesce(nullif(p.source, ''), CASE p.attribute WHEN 'manufactured' THEN '自产' WHEN 'purchased' THEN '外购' WHEN 'outsourced' THEN '外协加工' ELSE '' END) AS stock_type,
      wh.name AS warehouse_name,wh_in.name AS in_warehouse_name,wh_out.name AS out_warehouse_name,
      m.display_name AS operator_name,wo.code AS work_order_code
     FROM stock_ledger l
     JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id
     LEFT JOIN product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
     JOIN units u ON u.tenant_id=l.tenant_id AND u.id=l.unit_id
     JOIN warehouses wh ON wh.tenant_id=l.tenant_id AND wh.id=l.warehouse_id
     LEFT JOIN warehouses wh_in ON wh_in.tenant_id=l.tenant_id AND wh_in.id=l.in_warehouse_id
     LEFT JOIN warehouses wh_out ON wh_out.tenant_id=l.tenant_id AND wh_out.id=l.out_warehouse_id
     LEFT JOIN tenant_team_members m ON m.id=l.created_by
     LEFT JOIN work_orders wo ON wo.tenant_id=l.tenant_id AND wo.id=l.work_order_id
     WHERE ${where}
     ORDER BY l.posted_at DESC,l.id DESC LIMIT 300`,
    params,
  )).rows;
  const inSum = (await sql.query<{ n: string }>(`SELECT coalesce(sum(l.quantity),0)::text AS n FROM stock_ledger l JOIN products p ON p.id=l.product_id WHERE l.direction='in' AND ${where}`, params)).rows[0]!.n;
  const outSum = (await sql.query<{ n: string }>(`SELECT coalesce(sum(l.quantity),0)::text AS n FROM stock_ledger l JOIN products p ON p.id=l.product_id WHERE l.direction='out' AND ${where}`, params)).rows[0]!.n;
  const items = rows.map((row) => {
    const direction = String(row.direction ?? 'in');
    const sourceType = String(row.source_type ?? '');
    return {
      ...row,
      quantity: formatDecimal(qty(String(row.quantity ?? '0'))),
      balance_after: formatDecimal(qty(String(row.balance_after ?? '0'))),
      ledger_code: row.seq_no != null ? String(row.seq_no) : String(row.id),
      doc_type: resolveLedgerKind(sourceType, direction, row.ledger_kind as string | null),
      stock_kind: direction === 'out' ? '出库' : '入库',
      cost_amount: centsDisplay(row.cost_amount_cents as string | null),
      sale_amount: centsDisplay(row.sale_amount_cents as string | null),
      cost_unit_price: row.cost_unit_price ? formatDecimal(qty(String(row.cost_unit_price))) : '',
      sale_unit_price: row.sale_unit_price ? formatDecimal(qty(String(row.sale_unit_price))) : '',
    };
  });
  return { items, summary: { inbound_qty: formatDecimal(qty(inSum)), outbound_qty: formatDecimal(qty(outSum)) }, limit: 300 };
}
