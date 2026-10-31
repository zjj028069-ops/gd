/**
 * 销售对账单行操作验收。只用 Playwright。
 * 前置：npm run dev:setup && npm run dev
 * 截图：docs/verification/sales-statement-lines
 * 核对出库明细 / 退货明细 / 打印三个打开态的标题、汇总和列名。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/sales-statement-lines');
mkdirSync(outDir, { recursive: true });

const CUSTOMER_CODE = 'SS001';
const CUSTOMER_NAME = '对账行验收客户';
const NOTE = '对账行验收';

const outboundColumns = ['销售出库单号', '仓库', '合同编号', '审核状态', '出库日期', '发货人', '商品名', '商品编号', '商品规格', '销售单价(元)', '销售金额(元)', '数量', '单位', '备注', '颜色描述', '创建时间'];
const returnColumns = ['销售退货单号', '销售出库单号', '仓库', '退货日期', '商品名', '商品编号', '商品规格', '数量', '单位', '销售单价(元)', '销售金额(元)', '备注', '颜色描述'];

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

function shot(name) {
  return path.join(outDir, name);
}

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token || !cookie) throw new Error(`登录失败 ${username} ${JSON.stringify(json).slice(0, 240)}`);
  return { csrf: json.csrf_token, cookie, userId: json.user.id };
}

async function api(session, method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  if (text) json = JSON.parse(text);
  if (!res.ok) throw new Error(`${method} ${urlPath} ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
}

function approved(view) {
  return view && (view.approval === 'approved' || view.approval === 'exempt');
}

async function ensureLines(admin) {
  const customers = (await api(admin, 'GET', '/api/money/customers')).items ?? [];
  let customer = customers.find((item) => item.code === CUSTOMER_CODE) ?? customers.find((item) => item.name === CUSTOMER_NAME);
  if (!customer) {
    customer = (await api(admin, 'POST', '/api/money/customers', {
      request_key: randomUUID(), code: CUSTOMER_CODE, name: CUSTOMER_NAME, contact_name: '王德发', contact_phone: '17952986001', address: '青岛市城阳区',
    })).customer;
  }
  const products = (await api(admin, 'GET', '/api/products?page=1&page_size=20')).items ?? [];
  const product = products[0];
  if (!product) throw new Error('没有可用商品，无法做出库明细');
  let warehouses = (await api(admin, 'GET', '/api/warehouse/warehouses')).items ?? [];
  let warehouse = warehouses.find((item) => item.name === '对账仓') ?? warehouses[0];
  if (!warehouse) {
    warehouse = (await api(admin, 'POST', '/api/warehouse/warehouses', {
      request_key: randomUUID(), code: 'WH-SS', name: '对账仓', province: '', city: '', district: '', address: '',
    })).warehouse;
  }
  let outbound = await api(admin, 'GET', `/api/biz-reports/sales/${customer.id}/outbound?period=本月`);
  let returns = await api(admin, 'GET', `/api/biz-reports/sales/${customer.id}/returns?period=本月`);
  if (outbound.items?.length && returns.items?.length) return { customer, outbound, returns };

  const listed = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
  let brief = listed.find((item) => item.note === NOTE && (item.customer_id === customer.id || item.customer_name === CUSTOMER_NAME));
  let contract = brief ? (await api(admin, 'GET', `/api/money/contracts/${brief.id}`)).contract : null;
  if (!contract) {
    contract = (await api(admin, 'POST', '/api/money/contracts', {
      request_key: randomUUID(), customer_id: customer.id, contact_name: '王德发', salesperson_id: admin.userId, prepay: '0', note: NOTE,
      lines: [{ product_id: product.id, quantity: '10', unit_price: '10' }],
    })).contract;
  }
  if (contract.approval === 'pending') {
    try {
      contract = (await api(admin, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version, opinion: '通过' })).contract;
    } catch (error) {
      await api(admin, 'POST', '/api/audit/decide', { object_type: 'contract', object_id: contract.id, action: '通过', remark: '通过' });
      contract = (await api(admin, 'GET', `/api/money/contracts/${contract.id}`)).contract;
    }
  }
  if (!approved(contract)) throw new Error(`合同未审核通过：${contract.approval}`);
  const line = contract.lines?.[0];
  if (!line?.id) throw new Error('合同没有明细行');

  if (!outbound.items?.length) {
    await api(admin, 'POST', '/api/warehouse/misc-bills', {
      request_key: randomUUID(), kind: 'else_in', warehouse_id: warehouse.id, note: '对账行补库存',
      lines: [{ product_id: product.id, quantity: '5', unit_price: '10' }],
    });
    const created = (await api(admin, 'POST', '/api/warehouse/shipments', {
      request_key: randomUUID(), contract_id: contract.id, warehouse_id: warehouse.id,
      lines: [{ contract_line_id: line.id, quantity: '2', unit_price: '10' }],
    })).shipment;
    if (created.approval === 'pending' || created.audit_status === 'pending') {
      try {
        await api(admin, 'POST', `/api/warehouse/shipments/${created.id}/actions`, { request_key: randomUUID(), action: 'approve', version: created.version });
      } catch {
        await api(admin, 'POST', '/api/audit/decide', { object_type: 'sale_shipment', object_id: created.id, action: '通过', remark: '通过' });
      }
    }
  }
  returns = await api(admin, 'GET', `/api/biz-reports/sales/${customer.id}/returns?period=本月`);
  if (!returns.items?.length) {
    const created = (await api(admin, 'POST', '/api/warehouse/misc-bills', {
      request_key: randomUUID(), kind: 'sales_return', warehouse_id: warehouse.id, contract_id: contract.id, note: '对账行退货',
      lines: [{ product_id: product.id, quantity: '1', unit_price: '10' }],
    })).misc_bill;
    if (created?.approval === 'pending' || created?.audit_status === 'pending') {
      try {
        await api(admin, 'POST', '/api/audit/decide', { object_type: 'sales_return', object_id: created.id, action: '通过', remark: '通过' });
      } catch (error) {
        throw new Error(`销售退货未生效：${error instanceof Error ? error.message : error}`);
      }
    }
  }
  outbound = await api(admin, 'GET', `/api/biz-reports/sales/${customer.id}/outbound?period=本月`);
  returns = await api(admin, 'GET', `/api/biz-reports/sales/${customer.id}/returns?period=本月`);
  if (!outbound.items?.length) throw new Error(`出库明细接口没有数据 ${JSON.stringify(outbound).slice(0, 300)}`);
  if (!returns.items?.length) throw new Error(`退货明细接口没有数据 ${JSON.stringify(returns).slice(0, 300)}`);
  return { customer, outbound, returns };
}

function pack(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

async function headerTexts(page) {
  const cells = page.locator('.ant-modal-wrap:visible .ant-table-thead th, .ant-modal:visible .ant-table-thead th');
  await cells.first().waitFor({ timeout: 15000 });
  return (await cells.allTextContents()).map(pack);
}

function mustOrder(actual, expected, label) {
  let prev = -1;
  for (const name of expected) {
    const index = actual.findIndex((text) => text.includes(pack(name)));
    if (index < 0) throw new Error(`${label}缺少列「${name}」。实际表头：${actual.join(' | ')}`);
    if (index <= prev) throw new Error(`${label}列「${name}」顺序与原版不一致。实际表头：${actual.join(' | ')}`);
    prev = index;
  }
}

async function open(page) {
  await page.goto(`${WEB}/sales_statement`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByText('销售对账单').first().waitFor({ timeout: 20000 });
}

async function findRow(page) {
  for (let i = 0; i < 8; i += 1) {
    const row = page.locator('.ant-table-tbody tr', { hasText: CUSTOMER_NAME });
    if (await row.count()) return row.first();
    const next = page.locator('.ant-pagination-next button, .ant-pagination-next');
    if (!(await next.count()) || await next.first().isDisabled()) break;
    await next.first().click();
    await page.locator('.ant-table-tbody').waitFor();
  }
  throw new Error(`列表中找不到${CUSTOMER_NAME}`);
}

const pass = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!pass) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local 密码，请先 npm run dev:setup');
const admin = await login('admin.local', pass);
const seeded = await ensureLines(admin);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await asUser(page, admin);
  await open(page);
  const row = await findRow(page);
  const outboundBtn = row.getByRole('button', { name: '出库明细', exact: true });
  const returnBtn = row.getByRole('button', { name: '退货明细', exact: true });
  const printBtn = row.getByRole('button', { name: '打印', exact: true });
  await outboundBtn.waitFor();
  await returnBtn.waitFor();
  await printBtn.waitFor();
  await page.screenshot({ path: shot('01-list.png') });

  await outboundBtn.click();
  await page.locator('.ant-modal-title', { hasText: '出库明细列表' }).waitFor();
  mustOrder(await headerTexts(page), outboundColumns, '出库明细');
  const outboundBar = await page.locator('.stmt-line-sum').innerText();
  if (!outboundBar.includes('出库数量') || !outboundBar.includes('出库金额(元)')) throw new Error(`出库汇总文案不对：${outboundBar}`);
  if (!outboundBar.includes(String(seeded.outbound.summary.qty)) || !outboundBar.includes(String(seeded.outbound.summary.amount))) {
    throw new Error(`出库汇总数字不对：${outboundBar}，接口 ${seeded.outbound.summary.qty}/${seeded.outbound.summary.amount}`);
  }
  await page.locator('.ant-modal').getByText(seeded.outbound.items[0].shipment_code).waitFor();
  await page.locator('.ant-modal').getByRole('button', { name: '导出', exact: true }).waitFor();
  await page.locator('.ant-modal').getByRole('button', { name: '列配置', exact: true }).waitFor();
  await page.screenshot({ path: shot('02-outbound.png') });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.ant-modal').getByRole('button', { name: '导出', exact: true }).click(),
  ]);
  if (!download.suggestedFilename().includes('出库明细')) throw new Error(`导出文件名不对：${download.suggestedFilename()}`);
  await page.locator('.ant-modal').getByRole('button', { name: '列配置', exact: true }).click();
  await page.getByText(/列配置\(\d+\/50\)/).waitFor();
  if (!(await page.getByText('销售出库单号').count())) throw new Error('列配置里没有销售出库单号');
  await page.locator('.ant-modal').last().getByRole('button', { name: /取\s*消/ }).click();
  await page.locator('.ant-modal-close').last().click();
  await page.locator('.ant-modal-title', { hasText: '出库明细列表' }).waitFor({ state: 'hidden' });

  await returnBtn.click();
  await page.locator('.ant-modal-title', { hasText: '退货明细列表' }).waitFor();
  mustOrder(await headerTexts(page), returnColumns, '退货明细');
  const returnBar = await page.locator('.stmt-line-sum').innerText();
  if (!returnBar.includes('退货数量') || !returnBar.includes('退货金额(元)')) throw new Error(`退货汇总文案不对：${returnBar}`);
  if (!returnBar.includes(String(seeded.returns.summary.qty)) || !returnBar.includes(String(seeded.returns.summary.amount))) {
    throw new Error(`退货汇总数字不对：${returnBar}，接口 ${seeded.returns.summary.qty}/${seeded.returns.summary.amount}`);
  }
  await page.locator('.ant-modal').getByText(seeded.returns.items[0].return_code).waitFor();
  await page.screenshot({ path: shot('03-return.png') });
  await page.locator('.ant-modal-close').last().click();
  await page.locator('.ant-modal-title', { hasText: '退货明细列表' }).waitFor({ state: 'hidden' });

  await printBtn.click();
  const printTitle = `打印销售对账单${CUSTOMER_CODE}`;
  await page.locator('.ant-modal-title', { hasText: printTitle }).waitFor();
  await page.getByRole('button', { name: '自定义模板打印', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Excel模板打印', exact: true }).waitFor();
  await page.locator('.ant-modal').getByText('销售对账单打印模板').waitFor();
  await page.locator('.ant-modal').getByText('系统模板').waitFor();
  await page.locator('.ant-modal').getByRole('button', { name: '打印', exact: true }).waitFor();
  await page.screenshot({ path: shot('04-print.png') });
  await page.getByRole('button', { name: 'Excel模板打印', exact: true }).click();
  await page.locator('.stmt-print-empty', { hasText: '暂无数据' }).waitFor();
  await page.locator('.ant-modal-close').last().click();
  await page.locator('.ant-modal-title', { hasText: printTitle }).waitFor({ state: 'hidden' });
  console.log('销售对账单行操作验收通过', { code: CUSTOMER_CODE, outbound: seeded.outbound.summary, returns: seeded.returns.summary });
} finally {
  await browser.close();
}
