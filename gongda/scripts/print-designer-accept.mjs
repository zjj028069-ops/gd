/**
 * 销售对账单打印模板设计器打开态验收。只用 Playwright。
 * 前置：npm run dev:setup && npm run dev
 * 截图：docs/verification/print-designer/shots
 * 禁止 force、禁止吞掉等待失败、禁止没数据就改点别的行。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/print-designer/shots');
mkdirSync(outDir, { recursive: true });

const CUSTOMER_CODE = 'R14PD';
const CUSTOMER_NAME = '设计器对账客户';
const NOTE = '设计器对账验收';
const TEMPLATE_NAME = '验收对账打印模板';
const CANVAS_TEXT = '对账抬头验收';
const FOOTER_TEXT = '表尾验收';
const BASIC = ['客户编号', '客户', '客户标签', '联系人', '联系电话', '地址', '负责人', '出库数', '已收款', '已收款(大写)', '欠款', '欠款(大写)', '出库金额', '出库金额(大写)', '退货金额', '退货金额(大写)', '合同数量', '商品数量', '未出库数', '合同金额', '合同金额(大写)', '未开票', '未开票(大写)', '累计开票', '累计开票(大写)'];
const OUTBOUND = ['序号', '销售出库单号', '仓库', '合同编号', '出库日期', '发货人', '商品名', '商品编号', '商品规格', '销售单价', '销售单价(大写)', '销售金额', '销售金额(大写)', '数量', '单位', '备注', '商品.颜色描述'];
const RETURNS = ['序号', '销售退货单号', '销售出库单号', '仓库', '退货日期', '商品名', '商品编号', '商品规格', '销售单价', '销售单价(大写)', '销售金额', '销售金额(大写)', '数量', '单位', '备注', '商品.颜色描述'];
const OTHER = ['当前时间', '当前登录人姓名', '当前企业名称', '统计周期'];

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
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
  return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name, tenant: json.tenant.name };
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

function approved(view) {
  return view && (view.approval === 'approved' || view.approval === 'exempt');
}

async function ensureStatement(admin) {
  const customers = (await api(admin, 'GET', '/api/money/customers')).items ?? [];
  let customer = customers.find((item) => item.code === CUSTOMER_CODE);
  if (!customer) {
    customer = (await api(admin, 'POST', '/api/money/customers', {
      request_key: randomUUID(), code: CUSTOMER_CODE, name: CUSTOMER_NAME, contact_name: '赵设计', contact_phone: '17900001414', address: '杭州市余杭区',
    })).customer;
  }
  if (customer.code !== CUSTOMER_CODE || customer.name !== CUSTOMER_NAME) throw new Error(`客户不是验收对象 ${customer.code} ${customer.name}`);
  const products = (await api(admin, 'GET', '/api/products?page=1&page_size=20')).items ?? [];
  const product = products[0];
  if (!product) throw new Error('没有可用商品');
  let warehouses = (await api(admin, 'GET', '/api/warehouse/warehouses')).items ?? [];
  let warehouse = warehouses.find((item) => item.name === '对账仓') ?? warehouses[0];
  if (!warehouse) {
    warehouse = (await api(admin, 'POST', '/api/warehouse/warehouses', {
      request_key: randomUUID(), code: 'WH-R14PD', name: '对账仓', province: '', city: '', district: '', address: '',
    })).warehouse;
  }
  const listed = (await api(admin, 'GET', '/api/money/contracts')).items ?? [];
  let brief = listed.find((item) => item.note === NOTE && (item.customer_id === customer.id || item.customer_name === CUSTOMER_NAME));
  let contract = brief ? (await api(admin, 'GET', `/api/money/contracts/${brief.id}`)).contract : null;
  if (!contract) {
    contract = (await api(admin, 'POST', '/api/money/contracts', {
      request_key: randomUUID(), customer_id: customer.id, contact_name: '赵设计', salesperson_id: admin.userId, prepay: '0', note: NOTE,
      lines: [{ product_id: product.id, quantity: '6', unit_price: '25' }],
    })).contract;
  }
  if (contract.approval === 'pending') {
    try {
      contract = (await api(admin, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version, opinion: '通过' })).contract;
    } catch {
      await api(admin, 'POST', '/api/audit/decide', { object_type: 'contract', object_id: contract.id, action: '通过', remark: '通过' });
      contract = (await api(admin, 'GET', `/api/money/contracts/${contract.id}`)).contract;
    }
  }
  if (!approved(contract)) throw new Error(`合同未审核通过：${contract.approval}`);
  const line = contract.lines?.[0];
  if (!line?.id) throw new Error('合同没有明细行');
  let outbound = await api(admin, 'GET', `/api/biz-reports/sales/${customer.id}/outbound?period=本月`);
  if (!outbound.items?.length) {
    await api(admin, 'POST', '/api/warehouse/misc-bills', {
      request_key: randomUUID(), kind: 'else_in', warehouse_id: warehouse.id, note: '设计器对账补库存',
      lines: [{ product_id: product.id, quantity: '6', unit_price: '25' }],
    });
    const created = (await api(admin, 'POST', '/api/warehouse/shipments', {
      request_key: randomUUID(), contract_id: contract.id, warehouse_id: warehouse.id,
      lines: [{ contract_line_id: line.id, quantity: '2', unit_price: '25' }],
    })).shipment;
    if (created.approval === 'pending' || created.audit_status === 'pending') {
      try {
        await api(admin, 'POST', `/api/warehouse/shipments/${created.id}/actions`, { request_key: randomUUID(), action: 'approve', version: created.version });
      } catch {
        await api(admin, 'POST', '/api/audit/decide', { object_type: 'sale_shipment', object_id: created.id, action: '通过', remark: '通过' });
      }
    }
    outbound = await api(admin, 'GET', `/api/biz-reports/sales/${customer.id}/outbound?period=本月`);
  }
  if (!outbound.items?.length) throw new Error('出库明细没有数据，不能验收预览');
  const sales = await api(admin, 'GET', '/api/biz-reports/sales?period=本月&debt=全部');
  const row = (sales.items ?? []).find((item) => item.customer_code === CUSTOMER_CODE);
  if (!row) throw new Error('本月销售对账单没有设计器对账客户');
  return { customer, outbound, row };
}

async function removeNamed(session) {
  const list = await api(session, 'GET', '/api/print-templates?object_key=sales_statement');
  for (const item of list.items ?? []) {
    if (item.is_system || item.name !== TEMPLATE_NAME) continue;
    await api(session, 'DELETE', `/api/print-templates/${item.id}`, {});
  }
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

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log('saved', name);
  return file;
}

function section(root, title) {
  return root.getByRole('heading', { name: title, exact: true }).locator('xpath=..');
}

const password = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!password) throw new Error('找不到 admin.local 凭据');
const admin = await login('admin.local', password);
const seeded = await ensureStatement(admin);
await removeNamed(admin);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shots = [];
try {
  await asUser(page, admin);
  await page.goto(`${WEB}/sales_statement`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByText('销售对账单').first().waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '管理打印模板', exact: true }).waitFor();
  shots.push(await shot(page, '01-sales-toolbar'));

  await page.getByRole('button', { name: '管理打印模板', exact: true }).click();
  const manage = page.getByRole('dialog', { name: '管理自定义打印模板' });
  await manage.waitFor({ timeout: 15000 });
  await manage.getByRole('button', { name: '创建模板', exact: true }).waitFor();
  await manage.getByRole('columnheader', { name: '序号' }).waitFor();
  await manage.getByRole('columnheader', { name: '模版名称' }).waitFor();
  await manage.getByRole('columnheader', { name: '操作' }).waitFor();
  const systemRow = manage.locator('.ant-table-row').filter({ hasText: '销售对账单打印模板' }).filter({ hasText: '系统模板' });
  await systemRow.waitFor();
  const systemText = (await systemRow.innerText()).replace(/\s+/g, '');
  if (!systemText.includes('复制')) throw new Error('系统模板没有复制');
  if (systemText.includes('预览')) throw new Error('销售对账单系统模板不应出现预览');
  if (!(await manage.locator('.print-create').innerText()).includes('+ 创建模板')) throw new Error('创建模板按钮文案不对');
  shots.push(await shot(page, '02-manage-templates'));

  await manage.getByRole('button', { name: '创建模板', exact: true }).click();
  const studio = page.getByRole('dialog', { name: '打印模板设计器' });
  await studio.waitFor({ timeout: 15000 });
  await studio.getByRole('button', { name: '返回', exact: true }).waitFor();
  await studio.getByPlaceholder('请输入模板名').waitFor();
  await studio.getByRole('switch', { name: '开启表尾' }).waitFor();
  await studio.getByText('纸张 A4 21cm*29.7cm', { exact: true }).waitFor();
  await studio.getByRole('button', { name: '保存模板', exact: true }).waitFor();
  await studio.getByRole('button', { name: '打印预览', exact: true }).waitFor();
  await studio.getByText('系统会随机选择一条销售对账单数据展示在下方的预览区域。').waitFor();
  await studio.getByLabel('段落画布').waitFor();
  await studio.getByLabel('A4预览').waitFor();
  await studio.getByLabel('输入字段名搜索').waitFor();
  for (const title of ['基础字段', '表格字段', '出库明细', '退货明细', '其他字段']) {
    await section(studio, title).waitFor();
  }
  for (const name of BASIC) await section(studio, '基础字段').getByRole('button', { name, exact: true }).waitFor();
  for (const name of ['出库明细', '退货明细']) await section(studio, '表格字段').getByRole('button', { name, exact: true }).waitFor();
  for (const name of OUTBOUND) await section(studio, '出库明细').getByRole('button', { name, exact: true }).waitFor();
  for (const name of RETURNS) await section(studio, '退货明细').getByRole('button', { name, exact: true }).waitFor();
  for (const name of OTHER) await section(studio, '其他字段').getByRole('button', { name, exact: true }).waitFor();
  await page.waitForFunction(() => {
    const code = document.querySelector('.print-a4')?.getAttribute('data-preview-code') ?? '';
    return code.length > 0;
  }, null, { timeout: 20000 });
  const previewCode = await studio.locator('.print-a4').getAttribute('data-preview-code');
  const previewName = await studio.locator('.print-a4').getAttribute('data-preview-name');
  const sales = await api(admin, 'GET', '/api/biz-reports/sales?period=本月&debt=全部');
  const picked = (sales.items ?? []).find((item) => item.customer_code === previewCode && item.customer_name === previewName);
  if (!picked) throw new Error(`预览没有对上本月对账单 ${previewCode} ${previewName}`);
  const emptySheet = await studio.locator('.print-a4').innerText();
  if (emptySheet.includes(CANVAS_TEXT)) throw new Error('空画布预览不该有抬头');
  shots.push(await shot(page, '03-designer-open'));

  await studio.getByRole('button', { name: '保存模板', exact: true }).click();
  await page.getByText('请填写模板名称').waitFor({ timeout: 8000 });
  await studio.getByPlaceholder('请输入模板名').fill(TEMPLATE_NAME);
  await studio.getByRole('button', { name: '保存模板', exact: true }).click();
  await page.getByText('画布至少要有一个组件').waitFor({ timeout: 8000 });
  if (await studio.count() !== 1) throw new Error('空画布保存后设计器被关掉了');

  const fieldSearch = studio.getByLabel('输入字段名搜索');
  await fieldSearch.fill('不存在的字段xyz');
  await studio.getByRole('heading', { name: '基础字段', exact: true }).waitFor({ state: 'hidden', timeout: 5000 });
  await studio.locator('.print-fields .ant-input-clear-icon').click();
  await section(studio, '基础字段').getByRole('button', { name: '客户编号', exact: true }).waitFor();

  await section(studio, '基础字段').getByRole('button', { name: '客户编号', exact: true }).click();
  await section(studio, '基础字段').getByRole('button', { name: '客户', exact: true }).click();
  await section(studio, '其他字段').getByRole('button', { name: '当前企业名称', exact: true }).click();
  await section(studio, '表格字段').getByRole('button', { name: '出库明细', exact: true }).click();
  const canvas = studio.getByLabel('段落画布');
  await canvas.click();
  await canvas.pressSequentially(CANVAS_TEXT);
  await canvas.evaluate((el, text) => {
    const node = [...el.querySelectorAll('p,h1,h2,h3')].map((block) => block.firstChild).find((child) => child && (child.textContent || '').includes(text));
    if (!node) throw new Error('画布里没有可加粗的文字');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, CANVAS_TEXT);
  await studio.getByRole('button', { name: '加粗', exact: true }).click();
  await studio.getByRole('switch', { name: '开启表尾' }).click();
  const footer = studio.getByLabel('表尾', { exact: true });
  await footer.waitFor();
  await footer.click();
  await footer.pressSequentially(FOOTER_TEXT);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pngPath = path.join('/tmp', 'print-designer-pixel.png');
  writeFileSync(pngPath, png);
  await studio.locator('.print-file').setInputFiles(pngPath);
  await canvas.locator('img').waitFor({ timeout: 8000 });

  await studio.getByRole('button', { name: '页面设置', exact: true }).click();
  const margin = page.getByLabel('页边距', { exact: true });
  await margin.waitFor();
  const up = page.getByRole('button', { name: '增大页边距', exact: true });
  for (let index = 0; index < 6; index += 1) await up.click();
  if ((await margin.inputValue()) !== '18') throw new Error(`页边距控件没有变成 18：${await margin.inputValue()}`);
  await studio.getByLabel('段落画布').click();

  const sheetText = await studio.locator('.print-a4').innerText();
  if (!sheetText.includes(previewCode)) throw new Error(`预览没有客户编号 ${previewCode}：${sheetText.slice(0, 300)}`);
  if (!sheetText.includes(previewName)) throw new Error(`预览没有客户名 ${previewName}：${sheetText.slice(0, 300)}`);
  if (!sheetText.includes(admin.tenant)) throw new Error(`预览没有企业名称：${sheetText.slice(0, 300)}`);
  if (!sheetText.includes(CANVAS_TEXT)) throw new Error('预览没有抬头文字');
  if (!sheetText.includes(FOOTER_TEXT)) throw new Error('预览没有表尾');
  if (!sheetText.includes('销售出库单号')) throw new Error('预览没有出库明细表头');
  const pickedOutbound = await api(admin, 'GET', `/api/biz-reports/sales/${picked.id}/outbound?period=本月`);
  const shipment = pickedOutbound.items?.[0]?.shipment_code;
  if (shipment && !sheetText.includes(shipment)) throw new Error(`预览没有出库单号 ${shipment}`);
  if (!shipment && !sheetText.includes('暂无数据')) throw new Error('没有出库数据时预览应显示暂无数据');
  const beforeZoom = Number(await studio.locator('.print-a4').evaluate((node) => getComputedStyle(node).zoom || '1'));
  await studio.getByRole('button', { name: '放大', exact: true }).click();
  const afterZoom = Number(await studio.locator('.print-a4').evaluate((node) => getComputedStyle(node).zoom || '1'));
  if (!(afterZoom > beforeZoom)) throw new Error(`放大没有生效 ${beforeZoom} -> ${afterZoom}`);
  shots.push(await shot(page, '04-designer-filled'));

  await studio.getByRole('button', { name: '保存模板', exact: true }).click();
  await studio.waitFor({ state: 'hidden', timeout: 15000 });
  const savedRow = manage.locator('.ant-table-row').filter({ hasText: TEMPLATE_NAME });
  await savedRow.waitFor({ timeout: 15000 });
  const savedText = await savedRow.innerText();
  if (!savedText.includes('编辑') || !savedText.includes('删除')) throw new Error('自定义模板没有编辑和删除');
  if (await page.locator('.print-studio').count() !== 0) throw new Error('保存后设计器仍盖在列表上');
  shots.push(await shot(page, '05-manage-saved'));

  const stored = await api(admin, 'GET', '/api/print-templates?object_key=sales_statement');
  const custom = (stored.items ?? []).find((item) => item.name === TEMPLATE_NAME);
  if (!custom) throw new Error('接口没有保存自定义模板');
  if (custom.is_system) throw new Error('自定义模板被标成系统模板');
  const content = custom.content ?? {};
  const flow = content.flow ?? [];
  const footerNodes = content.footer ?? [];
  const blob = JSON.stringify(content);
  if (!flow.length) throw new Error('保存的画布是空的');
  if (!blob.includes(CANVAS_TEXT)) throw new Error('保存内容没有抬头');
  if (!blob.includes(FOOTER_TEXT)) throw new Error('保存内容没有表尾');
  if (!blob.includes('"field":"客户编号"') && !blob.includes('"field": "客户编号"')) throw new Error(`保存内容没有客户编号字段：${blob.slice(0, 500)}`);
  if (!flow.some((node) => node.type === 'table' && node.source === '出库明细' && (node.columns ?? []).includes('销售出库单号'))) throw new Error('保存内容没有出库明细表');
  if (!flow.some((node) => node.type === 'image' && String(node.src || '').startsWith('data:image/png'))) throw new Error('保存内容没有图片');
  if (content.footer_on !== true) throw new Error('表尾开关没有落库');
  if (content.margin_mm !== 18) throw new Error(`页边距没有落库：${content.margin_mm}`);
  if (!Array.isArray(content.blocks) || content.blocks.length < 1) throw new Error('保存内容没有可打印组件');
  if (content.builtin === true) throw new Error('自定义模板仍是内置壳');
  const bold = flow.some((node) => node.type === 'paragraph' && (node.runs ?? []).some((run) => run.bold && String(run.text || '').includes(CANVAS_TEXT)));
  if (!bold) throw new Error(`加粗没有写进段落：${JSON.stringify(flow).slice(0, 700)}`);

  await savedRow.getByRole('button', { name: '编辑', exact: true }).click();
  await studio.waitFor({ timeout: 15000 });
  const again = await studio.getByLabel('段落画布').innerText();
  if (!again.includes(CANVAS_TEXT) || !again.includes('客户编号')) throw new Error(`重新打开没有原内容：${again.slice(0, 300)}`);
  if (!(await studio.getByLabel('表尾', { exact: true }).innerText()).includes(FOOTER_TEXT)) throw new Error('重新打开没有表尾');
  shots.push(await shot(page, '06-designer-reopen'));

  const popupPromise = page.waitForEvent('popup');
  await studio.getByRole('button', { name: '打印预览', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForSelector('.page');
  const popupText = await popup.locator('body').innerText();
  if (!popupText.includes(CANVAS_TEXT) || !popupText.includes(FOOTER_TEXT)) throw new Error(`打印预览缺少画布文字：${popupText.slice(0, 400)}`);
  if (!popupText.includes(previewName) || !popupText.includes(previewCode) || !popupText.includes(admin.tenant)) throw new Error(`打印预览缺少真实数据：${popupText.slice(0, 400)}`);
  if (!popupText.includes(`预览数据：${previewCode} ${previewName}`)) throw new Error(`打印预览顶栏没有抽中的对账单：${popupText.slice(0, 400)}`);
  if (!popupText.includes(TEMPLATE_NAME)) throw new Error('打印预览缺少模板名');
  shots.push(await popup.screenshot({ path: path.join(outDir, '07-print-preview.png') }).then(() => path.join(outDir, '07-print-preview.png')));
  console.log('saved 07-print-preview');
  await popup.close();
  await studio.getByRole('button', { name: '返回', exact: true }).click();
  await studio.waitFor({ state: 'hidden', timeout: 8000 });
  await manage.locator('.ant-modal-close').click();
  await manage.waitFor({ state: 'hidden', timeout: 8000 });

  let row = page.locator('.kgd-card .ant-table-tbody tr', { hasText: CUSTOMER_NAME }).first();
  for (let index = 0; index < 8 && !(await row.count()); index += 1) {
    const next = page.locator('.ant-pagination-next button, .ant-pagination-next');
    if (!(await next.count()) || await next.first().isDisabled()) break;
    await next.first().click();
    row = page.locator('.kgd-card .ant-table-tbody tr', { hasText: CUSTOMER_NAME }).first();
  }
  await row.waitFor({ timeout: 15000 });
  await row.getByRole('button', { name: '打印', exact: true }).click();
  const picker = page.getByRole('dialog', { name: `打印销售对账单${CUSTOMER_CODE}` });
  await picker.waitFor({ timeout: 15000 });
  await picker.getByText(TEMPLATE_NAME, { exact: true }).waitFor();
  await picker.locator('label').filter({ hasText: TEMPLATE_NAME }).click();
  const rowPopupPromise = page.waitForEvent('popup');
  await picker.getByRole('button', { name: '打印', exact: true }).click();
  const rowPopup = await rowPopupPromise;
  await rowPopup.waitForSelector('.page');
  const rowText = await rowPopup.locator('body').innerText();
  if (!rowText.includes(CANVAS_TEXT) || !rowText.includes(FOOTER_TEXT)) throw new Error(`行打印缺少画布文字：${rowText.slice(0, 400)}`);
  if (!rowText.includes(CUSTOMER_NAME) || !rowText.includes(CUSTOMER_CODE)) throw new Error(`行打印没有该客户：${rowText.slice(0, 400)}`);
  if (!rowText.includes(`打印客户：${CUSTOMER_CODE} ${CUSTOMER_NAME}`)) throw new Error(`行打印顶栏没有该客户：${rowText.slice(0, 400)}`);
  if (!rowText.includes(admin.tenant)) throw new Error('行打印没有企业名称');
  const ownShip = seeded.outbound.items[0].shipment_code;
  if (ownShip && !rowText.includes(ownShip)) throw new Error(`行打印没有出库单号 ${ownShip}：${rowText.slice(0, 400)}`);
  shots.push(await rowPopup.screenshot({ path: path.join(outDir, '08-row-print.png') }).then(() => path.join(outDir, '08-row-print.png')));
  console.log('saved 08-row-print');
  await rowPopup.close();
} finally {
  await browser.close();
}

const pngs = readdirSync(outDir).filter((name) => name.endsWith('.png')).sort();
const hashes = pngs.map((name) => createHash('md5').update(readFileSync(path.join(outDir, name))).digest('hex'));
const unique = new Set(hashes);
if (pngs.length < 8) throw new Error(`打开态截图 ${pngs.length} 张，不足 8`);
if (unique.size !== hashes.length) throw new Error(`MD5 重复 ${hashes.length - unique.size}`);
const record = [
  '# 打印模板设计器打开态验收记录',
  '',
  '- 基线：a51add8',
  '- 脚本：scripts/print-designer-accept.mjs',
  `- 客户：${CUSTOMER_CODE} ${CUSTOMER_NAME}`,
  `- 模板：${TEMPLATE_NAME}`,
  `- 打开态截图 ${pngs.length} 张，MD5 互异 ${unique.size}`,
  '',
  ...pngs.map((name, index) => `- ${name} ${hashes[index]}`),
  '',
].join('\n');
writeFileSync(path.join(process.cwd(), 'docs/verification/print-designer/验收记录.md'), record);
console.log(record);
console.log('通过');
