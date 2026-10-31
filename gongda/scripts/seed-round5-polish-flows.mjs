/**
 * 第五轮收尾验收：通过 API 执行关键业务后再由 round5-polish-verify.mjs 截图。
 */
import { readFileSync } from 'node:fs';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const creds = readFileSync('.local/dev-credentials.txt', 'utf8');
const pass = creds.match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const key = () => crypto.randomUUID();

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
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function main() {
  const session = await login();
  const wh = (await api(session, 'GET', '/api/warehouse/warehouses')).items?.find((w) => w.name === '精工仓储');
  const products = await api(session, 'GET', '/api/products?page=1&page_size=50');
  const purchased = products.items?.find((p) => p.attribute === 'purchased') ?? products.items?.[0];
  const contracts = await api(session, 'GET', '/api/money/contracts?q=R5');
  let contract = contracts.items?.[0];
  const customers = await api(session, 'GET', '/api/money/customers?q=R5');
  const customer = customers.items?.[0];
  if (!contract && customer) {
    contract = (await api(session, 'POST', '/api/money/contracts', {
      request_key: key(), customer_id: customer.id, prepay: '0',
      lines: [{ product_id: purchased.id, quantity: '100', unit_price: '90', discount: '10', concession: '0' }],
    })).contract;
    contract = (await api(session, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version })).contract;
  }
  const cline = contract?.lines?.[0]?.id;

  await api(session, 'POST', '/api/warehouse/misc-bills', {
    request_key: key(), bill_kind: 'else_in', warehouse_id: wh.id,
    lines: [{ product_id: purchased.id, quantity: '200', unit_price: '90' }],
  }).catch(() => {});

  await api(session, 'POST', '/api/warehouse/misc-bills', {
    request_key: key(), bill_kind: 'sales_return', warehouse_id: wh.id, contract_id: contract.id,
    lines: [{ product_id: purchased.id, quantity: '110', unit_price: '90' }],
  }).catch((e) => console.warn('sales return', e.message));

  const orders = await api(session, 'GET', '/api/money/purchase-orders?q=R5');
  const po = orders.items?.[0];
  if (po?.lines?.[0]) {
    await api(session, 'POST', '/api/warehouse/purchase-returns', {
      request_key: key(), order_id: po.id, warehouse_id: wh.id,
      lines: [{ purchase_line_id: po.lines[0].id, quantity: '5' }],
    }).catch((e) => console.warn('purchase return', e.message));
  }

  await api(session, 'PUT', '/api/warehouse/settings', { limit_fg_in: true });
  await api(session, 'PUT', '/api/warehouse/settings', { limit_fg_in: false });

  const taking = await api(session, 'POST', '/api/warehouse/stock-taking-bills', {
    request_key: key(), warehouse_id: wh.id, mode: 'custom', confirm: true,
    lines: [{ product_id: purchased.id, actual_qty: '50' }],
  }).catch((e) => console.warn('taking', e.message));

  await api(session, 'POST', '/api/warehouse/audit-flows', {
    name: '收尾采购入库审核', object_type: 'purchase_receipt', enabled: true, allow_withdraw: true, approver_ids: [], sign_mode: 'or',
  }).catch(() => {});

  const pendingReceipt = await api(session, 'POST', '/api/warehouse/purchase-receipts', {
    request_key: key(), warehouse_id: wh.id, order_id: po?.id,
    lines: [{ purchase_line_id: po?.lines?.[0]?.id, quantity: '1' }],
  }).catch((e) => ({ error: e.message }));

  console.log(JSON.stringify({ salesReturn: '110×90', purchaseReturn: po?.code, taking: taking?.id ?? taking, pendingReceipt: pendingReceipt?.id ?? pendingReceipt?.error }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
