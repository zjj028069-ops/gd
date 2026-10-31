import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const outDir = path.join(process.cwd(), 'docs/verification/round5-polish2');
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const key = () => crypto.randomUUID();

async function loginApi() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  return { csrf: json.csrf_token, cookie };
}

async function api(session, method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
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
  if (!res.ok) throw new Error(`${method} ${urlPath} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function prepare() {
  const session = await loginApi();
  const products = await api(session, 'GET', '/api/products?page=1&page_size=50');
  const product = products.items?.find((p) => p.attribute === 'purchased') ?? products.items?.[0];
  const categories = await api(session, 'GET', '/api/products/categories?kind=goods');
  let category = categories.items?.find((c) => c.name === '标准件');
  if (!category) category = (await api(session, 'POST', '/api/products/categories', { kind: 'goods', name: '标准件' })).category;
  if (product && (product.specification?.includes('验收') || !product.category_id || product.specification !== 'Φ20×100')) {
    await api(session, 'PATCH', `/api/products/${product.id}`, {
      version: product.version, code: product.code, name: product.name, specification: 'Φ20×100',
      unit_id: product.unit_id, attribute: product.attribute, source: product.source ?? '外购',
      category_id: category.id, active: product.active !== false,
    }).catch((error) => console.warn('product patch', error.message));
  }
  const wh = (await api(session, 'GET', '/api/warehouse/warehouses')).items?.find((w) => w.name === '精工仓储');
  const customers = await api(session, 'GET', '/api/money/customers?q=R5');
  let customer = customers.items?.[0];
  if (!customer) customer = (await api(session, 'POST', '/api/money/customers', { request_key: key(), name: 'R5验收客户', contact_name: '袁', contact_phone: '13300000001', region: '北京市', address: '北京市' })).customer;

  async function ensureContract(name, qty, price, shipQty) {
    const listed = await api(session, 'GET', `/api/money/contracts?q=${encodeURIComponent(name)}`);
    let contract = listed.items?.find((c) => c.customer_name === name || c.note === name);
    if (!contract) {
      const createdCustomer = customers.items?.find((c) => c.name === name)
        ?? (await api(session, 'GET', `/api/money/customers?q=${encodeURIComponent(name)}`)).items?.[0]
        ?? (await api(session, 'POST', '/api/money/customers', { request_key: key(), name, contact_name: '联系人', contact_phone: `133${String(Date.now()).slice(-8)}`, region: '北京市', address: '北京市' })).customer;
      contract = (await api(session, 'POST', '/api/money/contracts', {
        request_key: key(), customer_id: createdCustomer.id, note: name, prepay: '0',
        lines: [{ product_id: product.id, quantity: String(qty), unit_price: String(price), discount: '10', concession: '0' }],
      })).contract;
    }
    if (contract.approval === 'pending') {
      contract = (await api(session, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version })).contract;
    }
    const ships = await api(session, 'GET', `/api/warehouse/shipments?contract_id=${contract.id}`);
    const shipped = (ships.items ?? []).reduce((n, s) => n + Number(s.lines?.[0]?.quantity ?? 0), 0);
    if (shipped < shipQty) {
      await api(session, 'POST', '/api/warehouse/misc-bills', {
        request_key: key(), bill_kind: 'else_in', warehouse_id: wh.id,
        lines: [{ product_id: product.id, quantity: String(shipQty), unit_price: '90' }],
      }).catch(() => {});
      await api(session, 'POST', '/api/warehouse/shipments', {
        request_key: key(), contract_id: contract.id, warehouse_id: wh.id,
        lines: [{ contract_line_id: contract.lines[0].id, quantity: String(shipQty - shipped) }],
      });
    }
    return contract;
  }

  const blue = await ensureContract('R5蓝条客户', 100, 100, 30);
  const green = await ensureContract('R5绿条客户', 100, 100, 100);
  const ret = await ensureContract('R5退货客户', 200, 90, 120);
  console.log(JSON.stringify({ blue: blue.code, green: green.code, ret: ret.code, product: product.code }));
  return { retCode: ret.code };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  console.log('saved', name);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const prepared = await prepare();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${base}/login`);
  await page.waitForSelector('input', { timeout: 15000 });
  const inputs = page.locator('input');
  await inputs.nth(0).fill('demo-a');
  await inputs.nth(1).fill('admin.local');
  await inputs.nth(2).fill(pass);
  await page.getByRole('button', { name: /登录工作空间/ }).click();
  await page.waitForTimeout(2500);

  await page.goto(`${base}/salesReturnOrder/list`);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: '+ 新增' }).click();
  await page.getByText('按合同退货', { exact: true }).click();
  await page.waitForTimeout(600);
  const modal = page.locator('.ant-modal');
  await modal.locator('.ant-select').nth(0).click();
  await page.locator('.ant-select-item-option').first().click();
  await modal.locator('.ant-select').nth(1).click();
  await page.locator('.ant-select-item-option', { hasText: prepared.retCode }).click();
  await page.waitForTimeout(500);
  await modal.getByRole('button', { name: '+ 选择合同商品' }).click();
  await modal.locator('input').last().fill('110');
  await modal.getByRole('button', { name: '确 定' }).click();
  await page.waitForTimeout(1500);
  await shot(page, '01-销售退货提交后');

  await page.goto(`${base}/customer_contract/list`);
  await page.waitForTimeout(1200);
  await shot(page, '02-合同出库进度-蓝条');
  await page.goto(`${base}/customer_contract/list`);
  await page.waitForTimeout(800);
  const table = page.locator('.ant-table-content').first();
  if (await table.count()) await table.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(400);
  await shot(page, '03-合同出库进度-绿条');

  await page.goto(`${base}/stock_item/list`);
  await page.waitForTimeout(1200);
  await shot(page, '04-出入库流水-类别与库存类型');
  await browser.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
