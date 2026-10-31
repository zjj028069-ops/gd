/**
 * 为 demo-a 准备第五轮浏览器验收数据（API 直写，可重复执行）。
 * 用法：先 `npm run dev` + `npm run db:migrate`，再 `node scripts/seed-round5-demo-a.mjs`
 */
import { readFileSync } from 'node:fs';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const creds = readFileSync('.local/dev-credentials.txt', 'utf8');
const pass = creds.match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  return { csrf: json.csrf_token, cookie };
}

async function api(session, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

const key = () => crypto.randomUUID();

async function ensureWorkOrder(session, whId, purchased, manufactured) {
  const wos = await api(session, 'GET', '/api/warehouse/work-orders');
  if (wos.items?.length) return wos.items[0];
  const boms = await api(session, 'GET', '/api/boms?page=1&page_size=20');
  const bom = boms.items?.find((b) => b.parent_product_id === manufactured.id) ?? boms.items?.[0];
  if (!bom?.current_version_id) return null;
  const routes = await api(session, 'GET', '/api/routes?page=1&page_size=20');
  const route = routes.items?.[0];
  if (!route?.current_version_id) return null;
  const wo = (await api(session, 'POST', '/api/work-orders', {
    request_key: key(),
    product_id: manufactured.id,
    quantity: '10',
    warehouse_id: whId,
    route_version_id: route.current_version_id,
    bom_version_id: bom.current_version_id,
  })).work_order;
  await api(session, 'POST', `/api/work-orders/${wo.id}/actions`, { action: 'start', version: wo.version }).catch(() => {});
  await api(session, 'POST', '/api/warehouse/misc-bills', {
    request_key: key(), bill_kind: 'else_in', warehouse_id: whId,
    lines: [{ product_id: purchased.id, quantity: '200', unit_price: '90' }],
  }).catch(() => {});
  return wo;
}

async function main() {
  const session = await login();
  const products = await api(session, 'GET', '/api/products?page=1&page_size=50');
  const purchased = products.items?.find((p) => p.attribute === 'purchased') ?? products.items?.[0];
  const manufactured = products.items?.find((p) => p.attribute === 'manufactured') ?? products.items?.[0];
  if (!purchased) throw new Error('缺少商品');

  let whA = (await api(session, 'GET', '/api/warehouse/warehouses')).items?.find((w) => w.name === '精工仓储');
  if (!whA) {
    whA = (await api(session, 'POST', '/api/warehouse/warehouses', {
      request_key: key(), name: '精工仓储', province: '重庆市', city: '重庆市', district: '铜梁区', address: '龙腾大道688号', manager_ids: [],
    })).warehouse;
  }
  let whB = (await api(session, 'GET', '/api/warehouse/warehouses')).items?.find((w) => w.name === '铁甲仓');
  if (!whB) {
    whB = (await api(session, 'POST', '/api/warehouse/warehouses', {
      request_key: key(), name: '铁甲仓', province: '重庆市', city: '重庆市', district: '渝北区', address: '铁甲路1号', manager_ids: [],
    })).warehouse;
  }

  const members = await api(session, 'GET', '/api/team-members');
  const adminId = members.items?.find((m) => m.display_name?.includes('管理员'))?.id ?? members.items?.[0]?.id;
  if (adminId) {
    await api(session, 'PATCH', `/api/warehouse/warehouses/${whA.id}`, { manager_ids: [adminId], version: whA.version }).catch(() => {});
    await api(session, 'PUT', '/api/warehouse/settings', { alert_user_ids: [adminId] });
  }

  const suppliers = await api(session, 'GET', '/api/money/suppliers?q=R5验收');
  let supplier = suppliers.items?.[0];
  if (!supplier) supplier = (await api(session, 'POST', '/api/money/suppliers', { request_key: key(), name: 'R5验收供应商', contact_name: '王工', region: '重庆市/铜梁区/城区', tags: [] })).supplier;

  const orders = await api(session, 'GET', '/api/money/purchase-orders?q=R5');
  let po = orders.items?.find((o) => o.supplier_name === 'R5验收供应商' && o.lines?.[0]?.quantity === '70');
  if (!po) {
    po = (await api(session, 'POST', '/api/money/purchase-orders', {
      supplier_id: supplier.id,
      order_date: '2026-10-05',
      lines: [{ product_id: purchased.id, quantity: '70', unit_price: '90' }],
    })).purchase_order;
    const lineId = po.lines[0].id;
    await api(session, 'POST', '/api/warehouse/purchase-receipts', { request_key: key(), warehouse_id: whA.id, lines: [{ purchase_line_id: lineId, quantity: '30' }] });
  }

  const customers = await api(session, 'GET', '/api/money/customers?q=R5验收');
  let customer = customers.items?.[0];
  if (!customer) customer = (await api(session, 'POST', '/api/money/customers', { request_key: key(), name: 'R5验收客户', contact_name: '袁', contact_phone: '13300000001', region: '北京市', address: '北京市' })).customer;

  const contracts = await api(session, 'GET', '/api/money/contracts?q=R5');
  let contract = contracts.items?.find((c) => c.customer_name?.includes('R5验收'));
  if (!contract) {
    contract = (await api(session, 'POST', '/api/money/contracts', {
      request_key: key(), customer_id: customer.id, prepay: '1000', tax_included: true,
      lines: [{ product_id: purchased.id, quantity: '100', unit_price: '100', discount: '10', concession: '0' }],
    })).contract;
  }
  if (contract.approval === 'pending') {
    contract = (await api(session, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version })).contract;
  }
  const cline = contract.lines[0].id;

  await api(session, 'PUT', '/api/warehouse/settings', { limit_contract_out: false });
  const ships = await api(session, 'GET', `/api/warehouse/shipments?contract_id=${contract.id}`);
  const shipped = ships.items?.reduce((n, s) => n + Number(s.lines?.[0]?.quantity ?? 0), 0) ?? 0;
  if (shipped < 30) {
    await api(session, 'POST', '/api/warehouse/misc-bills', {
      request_key: key(), bill_kind: 'else_in', warehouse_id: whA.id,
      lines: [{ product_id: purchased.id, quantity: '120', unit_price: '90' }],
    }).catch(() => {});
    await api(session, 'POST', '/api/warehouse/shipments', {
      request_key: key(), contract_id: contract.id, warehouse_id: whA.id,
      lines: [{ contract_line_id: cline, quantity: '30' }],
    });
  }
  if (shipped < 100) {
    await api(session, 'POST', '/api/warehouse/shipments', {
      request_key: key(), contract_id: contract.id, warehouse_id: whA.id,
      lines: [{ contract_line_id: cline, quantity: String(100 - Math.max(shipped, 30)) }],
    }).catch(() => {});
  }

  const transfers = await api(session, 'GET', '/api/warehouse/transfer-bills');
  if (!transfers.items?.some((t) => t.from_warehouse_id === whA.id && t.to_warehouse_id === whB.id)) {
    await api(session, 'POST', '/api/warehouse/transfer-bills', {
      request_key: key(), from_warehouse_id: whA.id, to_warehouse_id: whB.id, transfer_date: '2026-10-05',
      lines: [{ product_id: purchased.id, quantity: '20' }],
    }).catch(() => {});
  }

  await api(session, 'PATCH', `/api/products/${purchased.id}`, {
    version: purchased.version, stock_lower_warn: '500', active: purchased.active !== false,
    code: purchased.code, name: purchased.name, specification: purchased.specification ?? '', unit_id: purchased.unit_id,
    attribute: purchased.attribute, source: purchased.source ?? 'purchased',
  }).catch(() => {});

  const wo = await ensureWorkOrder(session, whA.id, purchased, manufactured);

  console.log(JSON.stringify({
    whA: whA.name, whB: whB.name, po: po.code, contract: contract.code,
    purchaseProgress: '30/70', contractProgress: '30+70/100', transfer: '20', workOrder: wo?.code ?? null,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
