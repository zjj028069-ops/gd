import type { FastifyInstance } from 'fastify';
import { formatDecimal, money, qty } from './business-common.js';
import { contractDebt, sumMoney } from './money-calc.js';
import { contractOutbound } from './warehouse-stock.js';
import type { Services } from './services.js';
import { num, periodRange, withTenant } from './round8-kit.js';

const customerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function centsYuan(value: string) {
  const whole = String(value ?? '0').trim().split('.')[0] || '0';
  if (!/^-?\d+$/.test(whole)) return '0';
  return num(money(BigInt(whole)) ?? '0');
}

function sumQtyText(values: string[]) {
  try {
    let total = 0n;
    for (const value of values) {
      const text = num(value || '0') || '0';
      const [whole, frac = ''] = text.split('.');
      total += qty(frac ? `${whole}.${frac.slice(0, 6)}` : (whole || '0'));
    }
    return num(formatDecimal(total));
  } catch {
    return num(values.reduce((sum, value) => sum + Number(value || 0), 0));
  }
}

type LineRow = {
  id: string;
  shipment_code: string;
  warehouse_name: string;
  contract_code: string;
  audit_status: string;
  ship_date: string;
  shipper_name: string;
  product_name: string;
  product_code: string;
  specification: string;
  unit_price: string;
  amount_cents: string;
  quantity: string;
  unit_name: string;
  note: string;
  created_at: string;
  return_code?: string;
  return_date?: string;
};

function lineOf(row: LineRow, kind: 'outbound' | 'return') {
  const shared = {
    id: row.id,
    shipment_code: row.shipment_code || '',
    warehouse_name: row.warehouse_name || '',
    product_name: row.product_name || '',
    product_code: row.product_code || '',
    specification: row.specification || '',
    unit_price: num(row.unit_price || '0'),
    sale_amount: centsYuan(row.amount_cents || '0'),
    quantity: num(row.quantity || '0'),
    unit_name: row.unit_name || '',
    note: row.note || '',
    color_desc: '',
  };
  if (kind === 'return') {
    return {
      ...shared,
      return_code: row.return_code || '',
      return_date: row.return_date || '',
    };
  }
  return {
    ...shared,
    contract_code: row.contract_code || '',
    audit_status: row.audit_status || '',
    ship_date: row.ship_date || '',
    shipper_name: row.shipper_name || '',
    created_at: row.created_at || '',
  };
}

function detailOf(rows: ReturnType<typeof lineOf>[]) {
  return {
    items: rows,
    summary: {
      qty: rows.length ? sumQtyText(rows.map((row) => row.quantity)) : '0',
      amount: rows.length ? sumMoney(rows.map((row) => row.sale_amount)) : '0',
    },
  };
}

export function registerReportBiz(app: FastifyInstance, services: Services) {
  app.get('/api/biz-reports/sales', (request) => withTenant(services, request, 'sales.read', async (sql) => {
    const query = request.query as { period?: string; debt?: string };
    const range = periodRange(query.period || '本月');
    const contracts = (await sql.query<{ id: string; customer_id: string; customer_code: string; customer_name: string; contact_name: string; contact_phone: string; address: string; active: boolean; amount: string; qty: string; approval: string }>(`SELECT c.id,c.customer_id,cu.code AS customer_code,cu.name AS customer_name,cu.contact_name,cu.contact_phone,cu.address,cu.active,c.amount::text,c.qty::text,c.approval
      FROM money_contracts c JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id
      WHERE c.approval IN ('approved','exempt') AND (c.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date`, [range.from, range.to])).rows;
    const grouped = new Map<string, { customer_code: string; customer_name: string; contact_name: string; contact_phone: string; address: string; active: boolean; amount: string[]; qty: string[]; received: string[]; invoiced: string[]; outbound: number; order_qty: number }>();
    for (const row of contracts) {
      const received = (await sql.query<{ n: string }>("SELECT coalesce(sum(amount),0)::text AS n FROM money_cash WHERE contract_id=$1 AND direction='in' AND approval IN ('approved','exempt')", [row.id])).rows[0]!.n;
      const invoiced = (await sql.query<{ n: string }>("SELECT coalesce(sum(amount),0)::text AS n FROM money_invoices WHERE contract_id=$1 AND status='done'", [row.id])).rows[0]!.n;
      let outbound = 0;
      try {
        const progress = await contractOutbound(sql, row.id);
        outbound = progress.lines.reduce((sum, line) => sum + Number(line.shipped_qty), 0);
      } catch { outbound = 0; }
      const bucket = grouped.get(row.customer_id) ?? { customer_code: row.customer_code, customer_name: row.customer_name, contact_name: row.contact_name, contact_phone: row.contact_phone, address: row.address, active: row.active, amount: [], qty: [], received: [], invoiced: [], outbound: 0, order_qty: 0 };
      bucket.amount.push(num(row.amount));
      bucket.qty.push(num(row.qty));
      bucket.received.push(num(received));
      bucket.invoiced.push(num(invoiced));
      bucket.outbound += outbound;
      bucket.order_qty += Number(row.qty) || 0;
      grouped.set(row.customer_id, bucket);
    }
    let items = [...grouped.entries()].map(([id, row]) => {
      const amount = sumMoney(row.amount);
      const received = sumMoney(row.received);
      const debt = contractDebt(amount, received);
      const qty = sumMoney(row.qty);
      return {
        id, customer_code: row.customer_code, customer_name: row.customer_name, contact_name: row.contact_name || '-', contact_phone: row.contact_phone || '-', address: row.address || '-',
        enabled_text: row.active ? '启用' : '禁用', contract_count: row.amount.length, qty, outbound_qty: num(row.outbound), unoutbound_qty: num(Math.max(row.order_qty - row.outbound, 0)),
        amount, received, debt, invoiced: sumMoney(row.invoiced), uninvoiced: contractDebt(amount, sumMoney(row.invoiced)),
      };
    });
    if (query.debt === '有欠款') items = items.filter((item) => Number(item.debt) > 0);
    if (query.debt === '无欠款') items = items.filter((item) => Number(item.debt) <= 0);
    const sum = (key: 'amount' | 'received' | 'debt' | 'qty' | 'outbound_qty' | 'unoutbound_qty' | 'invoiced' | 'uninvoiced') => num(items.reduce((total, item) => total + Number(item[key]), 0));
    return {
      range, items,
      summary: { contracts: items.reduce((total, item) => total + item.contract_count, 0), qty: sum('qty'), outbound: sum('outbound_qty'), unoutbound: sum('unoutbound_qty'), amount: sum('amount'), received: sum('received'), debt: sum('debt'), invoiced: sum('invoiced'), uninvoiced: sum('uninvoiced'), debt_count: items.filter((item) => Number(item.debt) > 0).length, clear_count: items.filter((item) => Number(item.debt) <= 0).length },
    };
  }));

  app.get<{ Params: { customerId: string } }>('/api/biz-reports/sales/:customerId/outbound', (request) => withTenant(services, request, 'sales.read', async (sql) => {
    const customerId = request.params.customerId;
    if (!customerIdPattern.test(customerId)) return detailOf([]);
    const range = periodRange((request.query as { period?: string }).period || '本月');
    const rows = (await sql.query<LineRow>(`SELECT sl.id::text, s.code AS shipment_code, coalesce(w.name,'') AS warehouse_name, coalesce(c.code,'') AS contract_code,
      s.audit_status, coalesce(to_char(s.ship_date,'YYYY-MM-DD'),'') AS ship_date, coalesce(mp.display_name,'') AS shipper_name,
      coalesce(nullif(cl.product_name,''), p.name, '') AS product_name, coalesce(nullif(cl.product_code,''), p.code, '') AS product_code,
      coalesce(nullif(cl.specification,''), p.specification, '') AS specification, sl.unit_price::text AS unit_price, sl.amount_cents::text AS amount_cents,
      sl.quantity::text AS quantity, coalesce(nullif(cl.unit_name,''), un.name, '') AS unit_name, coalesce(cl.note,'') AS note,
      coalesce(to_char(s.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS'),'') AS created_at
      FROM shipment_lines sl
      JOIN shipments s ON s.tenant_id=sl.tenant_id AND s.id=sl.shipment_id
      JOIN money_contracts c ON c.tenant_id=s.tenant_id AND c.id=s.contract_id
      LEFT JOIN money_contract_lines cl ON cl.tenant_id=sl.tenant_id AND cl.id=sl.contract_line_id
      LEFT JOIN warehouses w ON w.tenant_id=s.tenant_id AND w.id=s.warehouse_id
      LEFT JOIN tenant_member_profiles mp ON mp.tenant_id=s.tenant_id AND mp.user_id=s.shipper_id
      LEFT JOIN products p ON p.tenant_id=sl.tenant_id AND p.id=sl.product_id
      LEFT JOIN units un ON un.tenant_id=sl.tenant_id AND un.id=sl.unit_id
      WHERE c.customer_id=$1 AND s.approval='approved' AND c.approval IN ('approved','exempt')
        AND (c.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      ORDER BY s.ship_date DESC, s.code, sl.id
      LIMIT 500`, [customerId, range.from, range.to])).rows;
    return detailOf(rows.map((row) => lineOf(row, 'outbound')));
  }));

  app.get<{ Params: { customerId: string } }>('/api/biz-reports/sales/:customerId/returns', (request) => withTenant(services, request, 'sales.read', async (sql) => {
    const customerId = request.params.customerId;
    if (!customerIdPattern.test(customerId)) return detailOf([]);
    const range = periodRange((request.query as { period?: string }).period || '本月');
    // 销售退货单没有单独的退货日期，用单据创建日（上海时区）。
    const rows = (await sql.query<LineRow>(`SELECT l.id::text, '' AS shipment_code, b.code AS return_code, coalesce(w.name,'') AS warehouse_name,
      coalesce(to_char(b.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD'),'') AS return_date,
      coalesce(nullif(cl.product_name,''), p.name, '') AS product_name, coalesce(nullif(cl.product_code,''), p.code, '') AS product_code,
      coalesce(nullif(cl.specification,''), p.specification, '') AS specification, l.quantity::text AS quantity,
      coalesce(nullif(cl.unit_name,''), un.name, '') AS unit_name, l.unit_price::text AS unit_price, l.amount_cents::text AS amount_cents,
      coalesce(nullif(cl.note,''), b.note, '') AS note, '' AS created_at, '' AS contract_code, '' AS audit_status, '' AS ship_date, '' AS shipper_name
      FROM warehouse_misc_bill_lines l
      JOIN warehouse_misc_bills b ON b.tenant_id=l.tenant_id AND b.id=l.bill_id
      JOIN money_contracts c ON c.tenant_id=b.tenant_id AND c.id=b.contract_id
      LEFT JOIN LATERAL (
        SELECT product_name, product_code, specification, unit_name, note FROM money_contract_lines
        WHERE tenant_id=l.tenant_id AND contract_id=c.id AND product_id=l.product_id ORDER BY line_no LIMIT 1
      ) cl ON true
      LEFT JOIN warehouses w ON w.tenant_id=b.tenant_id AND w.id=b.warehouse_id
      LEFT JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id
      LEFT JOIN units un ON un.tenant_id=l.tenant_id AND un.id=l.unit_id
      WHERE b.bill_kind='sales_return' AND b.approval='approved' AND c.customer_id=$1 AND c.approval IN ('approved','exempt')
        AND (c.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      ORDER BY b.created_at DESC, b.code, l.id
      LIMIT 500`, [customerId, range.from, range.to])).rows;
    return detailOf(rows.map((row) => lineOf(row, 'return')));
  }));

  app.get('/api/biz-reports/contracts', (request) => withTenant(services, request, 'sales.read', async (sql) => {
    const rows = (await sql.query<{ id: string; code: string; customer_name: string; product_name: string; product_code: string; specification: string; unit_name: string; unit_price: string; quantity: string; discount: string; concession: string; net_amount: string; note: string; created_at: string; contract_id: string }>(`SELECT l.id,c.code,cu.name AS customer_name,l.product_name,l.product_code,l.specification,l.unit_name,l.unit_price::text,l.quantity::text,l.discount::text,l.concession::text,l.net_amount::text,l.note,c.created_at,c.id AS contract_id
      FROM money_contract_lines l JOIN money_contracts c ON c.tenant_id=l.tenant_id AND c.id=l.contract_id JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id
      WHERE c.approval IN ('approved','exempt') ORDER BY c.created_at DESC LIMIT 300`)).rows;
    const items = [];
    for (const row of rows) {
      let shipped = '0';
      try {
        const progress = await contractOutbound(sql, row.contract_id);
        const line = progress.lines.find((item) => item.product_name === row.product_name);
        shipped = line?.shipped_qty ?? '0';
      } catch { shipped = '0'; }
      const qty = Number(row.quantity) || 0;
      items.push({ ...row, unit_price: num(row.unit_price), quantity: num(row.quantity), discount: num(row.discount), concession: num(row.concession), net_amount: num(row.net_amount), shipped_qty: num(shipped), unshipped_qty: num(Math.max(qty - Number(shipped), 0)) });
    }
    return { items, summary: { net_amount: num(items.reduce((sum, item) => sum + Number(item.net_amount), 0)), qty: num(items.reduce((sum, item) => sum + Number(item.quantity), 0)), shipped: num(items.reduce((sum, item) => sum + Number(item.shipped_qty), 0)), unshipped: num(items.reduce((sum, item) => sum + Number(item.unshipped_qty), 0)) } };
  }));

  app.get('/api/biz-reports/cost', (request) => withTenant(services, request, 'production.read', async (sql) => {
    const orders = (await sql.query<{ id: string; code: string; product_name: string; product_code: string; plan_qty: string; labor_cents: string }>(`SELECT w.id,w.code,coalesce(w.product_snapshot->>'name','') AS product_name,coalesce(w.product_snapshot->>'code','') AS product_code,w.plan_qty::text,
      coalesce((SELECT sum((r.wage_snapshot->>'amount_cents')::numeric) FROM production_reports r WHERE r.work_order_id=w.id AND r.approval='approved' AND r.wage_snapshot->>'amount_cents' IS NOT NULL),0)::text AS labor_cents
      FROM work_orders w ORDER BY w.created_at DESC LIMIT 200`)).rows;
    const outsource = (await sql.query<{ id: string; code: string; product_name: string; product_code: string; plan_qty: string; fee: string }>(`SELECT o.id,o.code,p.name AS product_name,p.code AS product_code,o.plan_qty::text, coalesce(sum(r.settle_amount) FILTER (WHERE r.settle_status='已结算'),0)::text AS fee
      FROM r8_out_orders o JOIN products p ON p.tenant_id=o.tenant_id AND p.id=o.product_id LEFT JOIN r8_os_receipts r ON r.tenant_id=o.tenant_id AND r.order_id=o.id
      GROUP BY o.id,o.code,p.name,p.code,o.plan_qty`)).rows;
    const shares = (await sql.query<{ work_order_id: string; amount: string }>("SELECT l.work_order_id,sum(l.amount)::text AS amount FROM cost_share_lines l JOIN cost_shares s ON s.tenant_id=l.tenant_id AND s.id=l.share_id WHERE s.status='已分摊' GROUP BY l.work_order_id")).rows;
    const shareMap = new Map(shares.map((row) => [row.work_order_id, Number(row.amount)]));
    const items = [
      ...orders.map((row) => {
        const labor = num(Number(row.labor_cents) / 100);
        const costShare = num(shareMap.get(row.id) ?? 0);
        const total = num(Number(labor) + Number(costShare));
        return { id: row.id, code: row.code, product_name: row.product_name, product_code: row.product_code, plan_qty: num(row.plan_qty), labor, material: '0', outsource: '0', cost_share: costShare, total, output: '0', profit: num(0 - Number(total)) };
      }),
      ...outsource.map((row) => ({ id: row.id, code: row.code, product_name: row.product_name, product_code: row.product_code, plan_qty: num(row.plan_qty), labor: '0', material: '0', outsource: num(row.fee), cost_share: '0', total: num(row.fee), output: '0', profit: num(0 - Number(row.fee)) })),
    ];
    const sum = (key: 'labor' | 'material' | 'outsource' | 'cost_share' | 'total' | 'profit') => num(items.reduce((total, item) => total + Number(item[key] ?? 0), 0));
    return { items, summary: { labor: sum('labor'), material: sum('material'), outsource: sum('outsource'), cost_share: sum('cost_share'), total: sum('total'), output: '0', profit: sum('profit') } };
  }));

  app.get('/api/biz-reports/inventory', (request) => withTenant(services, request, 'inventory.read', async (sql) => {
    const query = request.query as { period?: string; only_flow?: string };
    const range = periodRange(query.period || '本年');
    const only = query.only_flow !== '0';
    const rows = (await sql.query<{ id: string; code: string; name: string; specification: string; unit_name: string; stock: string; opening: string; inbound: string; outbound: string }>(`SELECT p.id,p.code,p.name,coalesce(p.specification,'') AS specification,coalesce(u.name,'') AS unit_name,
      coalesce((SELECT sum(b.on_hand) FROM stock_balances b WHERE b.tenant_id=p.tenant_id AND b.product_id=p.id),0)::text AS stock,
      coalesce((SELECT sum(CASE WHEN l.direction='in' THEN l.quantity ELSE -l.quantity END) FROM stock_ledger l WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND (l.posted_at AT TIME ZONE 'Asia/Shanghai')::date < $1::date),0)::text AS opening,
      coalesce((SELECT sum(l.quantity) FROM stock_ledger l WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND l.direction='in' AND (l.posted_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date),0)::text AS inbound,
      coalesce((SELECT sum(l.quantity) FROM stock_ledger l WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND l.direction='out' AND (l.posted_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date),0)::text AS outbound
      FROM products p LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id`, [range.from, range.to])).rows;
    const items = rows.map((row) => {
      const closing = Number(row.opening) + Number(row.inbound) - Number(row.outbound);
      return { ...row, stock: num(row.stock), opening: num(row.opening), inbound: num(row.inbound), outbound: num(row.outbound), closing: num(closing), source: '自产' };
    }).filter((row) => !only || Number(row.inbound) > 0 || Number(row.outbound) > 0);
    return { range, items };
  }));

  app.get('/api/biz-reports/machines', (request) => withTenant(services, request, 'production.read', async (sql) => {
    const rows = (await sql.query<{ id: string; code: string; name: string; spec: string; status: string; category_name: string; shop_name: string; line_name: string; report_qty: string; good_qty: string; defect_qty: string; seconds: string }>(`SELECT m.id,m.code,m.name,m.spec,m.status,c.name AS category_name,coalesce(s.name,'') AS shop_name,coalesce(l.name,'') AS line_name,
      coalesce(sum(r.good_qty+r.defect_qty),0)::text AS report_qty, coalesce(sum(r.good_qty),0)::text AS good_qty, coalesce(sum(r.defect_qty),0)::text AS defect_qty, coalesce(sum(r.effective_seconds),0)::text AS seconds
      FROM r8_machines m JOIN r8_machine_categories c ON c.tenant_id=m.tenant_id AND c.id=m.category_id
      LEFT JOIN r8_shops s ON s.tenant_id=m.tenant_id AND s.id=m.shop_id
      LEFT JOIN r8_lines l ON l.tenant_id=m.tenant_id AND l.id=m.line_id
      LEFT JOIN production_reports r ON r.tenant_id=m.tenant_id AND r.machine_id=m.id AND r.approval='approved'
      GROUP BY m.id,m.code,m.name,m.spec,m.status,c.name,s.name,l.name
      ORDER BY m.code`)).rows;
    return { items: rows.map((row) => {
      const report = Number(row.report_qty) || 0;
      const good = Number(row.good_qty) || 0;
      const hours = Number(row.seconds) / 3600;
      return { ...row, spec: row.spec || '-', shop_name: row.shop_name || '-', line_name: row.line_name || '-', report_qty: num(row.report_qty), good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), good_rate: report ? `${((good / report) * 100).toFixed(2)}` : '-', hours: num(hours) };
    }) };
  }));
}
