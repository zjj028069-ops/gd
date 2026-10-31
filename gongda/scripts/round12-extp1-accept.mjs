#!/usr/bin/env node
/**
 * 第十二轮：扩展待补与 P1 清理。Playwright only。
 * 空库经正式接口造数。禁止 force、禁止 .catch 吞断言、禁止没数据就挑一条。
 * 截图：docs/verification/round12-extp1/ 与 /opt/cursor/artifacts/round12-extp1/
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/round12-extp1';
const docDir = path.join(process.cwd(), 'docs/verification/round12-extp1');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });

const startedAt = new Date();
const results = [];
const openShots = [];
const stamp = Date.now().toString().slice(-6);
const partName = `子件R12${stamp}`;
const customerName = `出库客户R12${stamp}`;
const warehouseName = `验收仓${stamp}`;
const purchaseCode = `CG${stamp}`;
const contractCode = `HT${stamp}`;
const woCode = `WO${stamp}`;
const saleField = `出库备注${stamp}`;
const returnField = `退货备注${stamp}`;
const issueField = `领料备注${stamp}`;
const prodField = `退料备注${stamp}`;
const salesField = `销退备注${stamp}`;
const saleValue = `出库值${stamp}`;
const returnValue = `退货值${stamp}`;
const issueValue = `领料值${stamp}`;
const prodValue = `退料值${stamp}`;
const salesValue = `销退值${stamp}`;

const STANDARD_TYPES = [
  '单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间',
  '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '关联对象', '关联属性',
];

function bj(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

function record(n, title, ok, reason = '') {
  results.push({ n, title, result: ok ? '通过' : '未通过', reason });
  console.log(ok ? '通过' : '未通过', n, title, reason);
}

async function step(n, title, fn) {
  try {
    const reason = await fn();
    record(n, title, true, reason ?? '');
  } catch (error) {
    record(n, title, false, String(error).slice(0, 800));
  }
}

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

async function login(username, password) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
    });
    const json = await res.json();
    const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
    if (res.ok && json.csrf_token) return { csrf: json.csrf_token, cookie, userId: json.user.id, username };
    const code = json?.error?.code || json?.code || '';
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 160);
    if (code === 'RATE_LIMITED' || /限流|RATE_LIMIT/i.test(msg) || res.status === 429) {
      const waitMs = Math.min(30000, 2000 * attempt);
      console.log(`登录限流 ${username}，${waitMs}ms 后重试 (${attempt}/8)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`登录失败 ${username}: ${res.status} ${msg}`);
  }
  throw new Error(`登录失败 ${username}: 限流重试耗尽`);
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
  await page.addInitScript((token) => { window.sessionStorage.setItem('kgd-csrf', token); }, session.csrf);
}

async function api(session, method, pathName, body) {
  const res = await fetch(`${API}${pathName}`, {
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
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function shot(page, name, open = false) {
  await page.waitForTimeout(200);
  const p1 = path.join(artifactDir, `${name}.png`);
  const p2 = path.join(docDir, `${name}.png`);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.screenshot({ path: p1, fullPage: false });
      writeFileSync(p2, readFileSync(p1));
      if (open) openShots.push(name);
      console.log('saved', name, open ? 'open' : 'page');
      return;
    } catch (error) {
      lastErr = error;
      if (!/EAGAIN|EBUSY|resource temporarily unavailable/i.test(String(error))) throw error;
      await page.waitForTimeout(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

function btn(scope, name) {
  const body = [...name].map((ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch)).join('\\s*');
  return scope.getByRole('button', { name: new RegExp(`^\\s*${body}\\s*$`) });
}

function exactRe(label) {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

async function waitServers(ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const [apiRes, webRes] = await Promise.all([fetch(`${API}/api/auth/me`), fetch(WEB)]);
      if ([200, 401, 403, 429].includes(apiRes.status) && webRes.ok) return;
    } catch {
      /* 服务还在启动 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API(3001)/WEB(5173) 未就绪');
}

async function open(page, urlPath, waitText) {
  await page.goto(`${WEB}${urlPath}`);
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByText(waitText).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
}

async function clickExt(page) {
  const button = page.locator('.kgd-toolbar').getByRole('button', { name: /^扩展字段$/ });
  const count = await button.count();
  if (count !== 1) throw new Error(`扩展字段按钮数量 ${count}，拒绝猜测`);
  await button.click();
}

async function expectTitle(page, title) {
  const modal = page.locator('.ant-modal').filter({ hasText: title }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const heading = (await modal.locator('.ant-modal-title').innerText()).trim();
  if (heading !== title) throw new Error(`标题「${heading}」不等于「${title}」`);
  if (/【[A-Za-z0-9_-]*-list】|[A-Za-z]+-[a-z]+/.test(heading)) throw new Error(`标题含英文 pageKey：${heading}`);
  const add = btn(modal, '新增');
  if (await add.count() !== 1) throw new Error('管理弹窗没有唯一的「新增」');
  return modal;
}

async function expectManager(page, title, shotName) {
  await clickExt(page);
  const modal = await expectTitle(page, title);
  if (await modal.getByRole('tab').count()) throw new Error(`${title} 出现了 Tab`);
  for (const col of ['排序', '字段名', '字段类型', '是否必填', '创建时间', '操作']) {
    if (!(await modal.getByText(col, { exact: true }).count())) throw new Error(`缺列 ${col}`);
  }
  await shot(page, shotName, true);
  return modal;
}

async function closeModals(page) {
  for (let i = 0; i < 6; i += 1) {
    const visible = page.locator('.ant-modal-wrap:visible');
    if (!(await visible.count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  const left = await page.locator('.ant-modal-wrap:visible').count();
  if (left) throw new Error(`仍有 ${left} 个弹窗`);
}

async function chooseExact(page, select, label) {
  await select.click();
  const option = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: exactRe(label) });
  const count = await option.count();
  if (count !== 1) throw new Error(`选项「${label}」匹配 ${count} 项`);
  await option.click();
}

async function selectByLabel(page, form, label, option) {
  const span = form.locator('.kgd-form').first().locator('span').filter({ hasText: exactRe(label) });
  const count = await span.count();
  if (count !== 1) throw new Error(`标签「${label}」匹配 ${count}`);
  const select = span.locator('xpath=following-sibling::div[contains(@class,"ant-select")][1]');
  if (await select.count() !== 1) throw new Error(`「${label}」下拉不唯一`);
  await chooseExact(page, select, option);
}

async function confirmTextField(page, add, name) {
  const nameInput = add.locator('label').filter({ hasText: '字段名' }).locator('input');
  await nameInput.click();
  await nameInput.fill(name);
  if (await nameInput.inputValue() !== name) throw new Error(`字段名未写入，当前「${await nameInput.inputValue()}」`);
  const required = add.locator('label').filter({ hasText: '是否必填' }).locator('.ant-select');
  await required.click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden):not(.ext-type-popup)');
  await dropdown.waitFor();
  if (await dropdown.count() !== 1) throw new Error(`必填下拉 ${await dropdown.count()}`);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await nameInput.click();
  const shown = (await required.locator('.ant-select-content').innerText()).replace(/\s/g, '');
  if (shown !== '是') throw new Error(`必填当前「${shown}」`);
  await btn(add, '确定').click();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await add.isVisible())) return;
    if (await add.locator('.kgd-field-help').count()) throw new Error(await add.locator('.kgd-field-help').innerText());
    await page.waitForTimeout(200);
  }
  throw new Error('新增扩展字段未关闭');
}

async function addRequiredField(page, route, waitText, title, fieldName) {
  await open(page, route, waitText);
  await clickExt(page);
  const list = await expectTitle(page, title);
  if (await list.getByRole('tab').count()) throw new Error(`${title} 出现了 Tab`);
  await btn(list, '新增').click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor({ state: 'visible' });
  await confirmTextField(page, add, fieldName);
  await list.getByText(fieldName, { exact: true }).waitFor();
  const heads = (await list.locator('thead th').allInnerTexts()).map((item) => item.replace(/\s/g, ''));
  const reqIndex = heads.indexOf('是否必填');
  if (reqIndex < 0) throw new Error(`没有是否必填列 ${heads.join('|')}`);
  const row = list.locator('.ant-table-row').filter({ hasText: fieldName });
  if (await row.count() !== 1) throw new Error(`字段行 ${await row.count()}`);
  const cell = (await row.locator('td').nth(reqIndex).innerText()).replace(/\s/g, '');
  if (cell !== '是') throw new Error(`是否必填「${cell}」`);
  await closeModals(page);
}

async function openPlainAdd(page, formTitle) {
  const button = page.locator('.kgd-toolbar').getByRole('button', { name: /^\s*\+\s*新增\s*$/ });
  if (await button.count() !== 1) throw new Error(`新增按钮 ${await button.count()}`);
  await button.click();
  const form = page.locator('.ant-modal').filter({ hasText: formTitle }).last();
  await form.waitFor();
  return form;
}

async function openMenuAdd(page, menu, formTitle) {
  const button = page.locator('.kgd-toolbar').getByRole('button', { name: /^\s*\+\s*新增\s*$/ });
  if (await button.count() !== 1) throw new Error(`新增按钮 ${await button.count()}`);
  await button.hover();
  const item = page.getByRole('menuitem', { name: menu, exact: true });
  await item.waitFor({ state: 'visible', timeout: 8000 });
  if (await item.count() !== 1) throw new Error(`菜单「${menu}」匹配 ${await item.count()}`);
  await item.click();
  const form = page.locator('.ant-modal').filter({ hasText: formTitle }).last();
  await form.waitFor();
  return form;
}

async function setQty(form, productName, value) {
  const row = form.locator('.ant-table-row').filter({ hasText: productName });
  if (await row.count() !== 1) throw new Error(`明细「${productName}」匹配 ${await row.count()}`);
  const input = row.locator('input');
  if (await input.count() !== 1) throw new Error(`数量框 ${await input.count()}`);
  await input.click();
  await input.fill(value);
  if (await input.inputValue() !== value) throw new Error(`数量未写入「${await input.inputValue()}」`);
}

async function requireThenSave(page, form, fieldName, value) {
  const block = form.locator('.ext-fields');
  await block.waitFor({ timeout: 10000 });
  const hosts = block.locator('span[style*="display"]');
  const count = await hosts.count();
  if (!count) throw new Error('表单没有扩展字段');
  let target = null;
  for (let i = 0; i < count; i += 1) {
    const host = hosts.nth(i);
    const label = (await host.innerText()).replace(/\s/g, '');
    const input = host.locator('input');
    if (label.includes(fieldName)) {
      if (!label.includes(`*${fieldName}`) && !label.startsWith('*')) throw new Error(`必填星号缺失「${label}」`);
      if (await input.count() !== 1) throw new Error(`目标扩展输入 ${await input.count()}`);
      target = input;
      continue;
    }
    if (!label.includes('*')) continue;
    if (await input.count() !== 1) throw new Error(`其他必填扩展「${label}」输入 ${await input.count()}`);
    await input.fill(`占位${stamp}`);
  }
  if (!target) throw new Error(`表单未见扩展字段 ${fieldName}`);
  await btn(form, '确定').click();
  await page.locator('.ant-message').getByText(`请填写${fieldName}`).waitFor({ timeout: 8000 });
  await target.click();
  await target.fill(value);
  if (await target.inputValue() !== value) throw new Error(`扩展值未写入「${await target.inputValue()}」`);
  await btn(form, '确定').click();
  await form.waitFor({ state: 'hidden', timeout: 20000 });
  await page.getByText('已保存').first().waitFor();
}

function freshId(before, after, label) {
  const prev = new Set((before.items ?? []).map((item) => item.id));
  const fresh = (after.items ?? []).filter((item) => item.id && !prev.has(item.id));
  if (fresh.length !== 1) throw new Error(`${label} 新增单据 ${fresh.length} 条`);
  return fresh[0].id;
}

async function assertStored(entity, recordId, fieldName, value) {
  const fields = await api(admin, 'GET', `/api/entity-ext-fields?entity=${entity}`);
  const field = (fields.items ?? []).find((item) => item.name === fieldName);
  if (!field?.id) throw new Error(`字段未落库 ${fieldName}`);
  if (field.required !== true && field.required !== '是') throw new Error(`字段不是必填 ${JSON.stringify(field.required)}`);
  const values = await api(admin, 'GET', `/api/entity-ext-values?entity=${entity}&record_id=${recordId}`);
  if (values.values?.[field.id] !== value) throw new Error(`值未落库 ${JSON.stringify(values.values)}`);
}

async function stillThere(page, route, waitText, title, fieldName) {
  await page.reload();
  await page.getByText(waitText).first().waitFor();
  await clickExt(page);
  const modal = await expectTitle(page, title);
  await modal.getByText(fieldName, { exact: true }).waitFor();
  await closeModals(page);
}

const credFile = path.join(process.cwd(), '.local/dev-credentials.txt');
if (!existsSync(credFile)) throw new Error('缺少 .local/dev-credentials.txt');
const password = passwordOf(credFile, 'admin.local');
if (!password) throw new Error('未读到 admin.local 密码');

await waitServers();
const admin = await login('admin.local', password);

const products = await api(admin, 'GET', '/api/products?page=1&page_size=100');
const product = (products.items ?? []).find((item) => item.code === 'LOCAL001');
if (!product?.id || !product.unit_id) throw new Error('空库没有商品 LOCAL001');
const productName = String(product.name);
const part = await api(admin, 'POST', '/api/products', { code: `P${stamp}`, name: partName, unit_id: product.unit_id, attribute: 'purchased' });
if (!part.product?.id) throw new Error(`造子件失败 ${JSON.stringify(part).slice(0, 200)}`);
const warehouse = await api(admin, 'POST', '/api/warehouse/warehouses', {
  request_key: crypto.randomUUID(), name: warehouseName, province: '上海', city: '上海', district: '浦东新区', address: '验收路1号',
});
if (!warehouse.warehouse?.id) throw new Error('建仓失败');
const supplier = await api(admin, 'POST', '/api/money/suppliers', { name: `供${stamp}` });
if (!supplier.supplier?.id) throw new Error('造供应商失败');
const purchase = await api(admin, 'POST', '/api/money/purchase-orders', {
  code: purchaseCode,
  supplier_id: supplier.supplier.id,
  lines: [
    { product_id: part.product.id, quantity: '20', unit_price: '1' },
    { product_id: product.id, quantity: '10', unit_price: '1' },
  ],
});
if (purchase.purchase_order?.approval !== 'approved' || purchase.purchase_order?.lifecycle !== 'open') {
  throw new Error(`采购单状态 ${purchase.purchase_order?.approval}/${purchase.purchase_order?.lifecycle}`);
}
const poLines = purchase.purchase_order.lines ?? [];
const partLine = poLines.find((line) => line.product_name === partName);
const fgLine = poLines.find((line) => line.product_name === productName);
if (!partLine?.id || !fgLine?.id) throw new Error(`采购明细不齐 ${poLines.map((line) => line.product_name).join(',')}`);
await api(admin, 'POST', '/api/warehouse/purchase-receipts', {
  request_key: crypto.randomUUID(),
  order_id: purchase.purchase_order.id,
  warehouse_id: warehouse.warehouse.id,
  lines: [
    { purchase_line_id: partLine.id, quantity: '20' },
    { purchase_line_id: fgLine.id, quantity: '10' },
  ],
});
const customer = await api(admin, 'POST', '/api/money/customers', { name: customerName, contact_name: '验收联系人', contact_phone: `139${stamp}00` });
if (!customer.customer?.id) throw new Error('造客户失败');
let contract = (await api(admin, 'POST', '/api/money/contracts', {
  code: contractCode,
  customer_id: customer.customer.id,
  contact_name: '验收联系人',
  lines: [{ product_id: product.id, quantity: '2', unit_price: '1' }],
})).contract;
if (!contract?.id) throw new Error('造合同失败');
if (!['approved', 'exempt'].includes(contract.approval)) {
  if (contract.approval !== 'pending') throw new Error(`合同审核状态 ${contract.approval}`);
  contract = (await api(admin, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version, opinion: '验收' })).contract;
}
if (!['approved', 'exempt'].includes(contract.approval)) throw new Error(`合同未审核 ${contract.approval}`);
if (contract.code !== contractCode) throw new Error(`合同号 ${contract.code}`);
const proc = await api(admin, 'POST', '/api/processes', { code: `GX${stamp}`, name: `装配${stamp}`, description: '验收', standard_minutes: '1', reporter_ids: [admin.userId] });
if (!proc.process?.id) throw new Error(`造工序失败 ${JSON.stringify(proc).slice(0, 200)}`);
const route = await api(admin, 'POST', '/api/routes', { code: `RT${stamp}`, name: `路线${stamp}`, description: '验收', steps: [{ process_id: proc.process.id, auto_inbound: false }] });
if (!route.route?.current_version_id) throw new Error(`路线没有 current_version_id ${JSON.stringify(route.route ?? {}).slice(0, 200)}`);
const bom = await api(admin, 'POST', '/api/boms', {
  parent_product_id: product.id,
  description: '验收',
  route_version_id: route.route.current_version_id,
  items: [{ component_product_id: part.product.id, quantity: '1', loss_rate: '0' }],
});
if (!bom.bom?.current_version_id) throw new Error(`BOM 没有 current_version_id ${JSON.stringify(bom.bom ?? {}).slice(0, 200)}`);
const wo = await api(admin, 'POST', '/api/work-orders', {
  request_key: crypto.randomUUID(),
  code: woCode,
  product_id: product.id,
  quantity: '2',
  route_version_id: route.route.current_version_id,
  bom_version_id: bom.bom.current_version_id,
  warehouse_id: warehouse.warehouse.id,
});
if (!wo.work_order?.id || wo.work_order.code !== woCode) throw new Error(`加工单 ${wo.work_order?.code ?? '无'}`);
const outOrder = await api(admin, 'POST', '/api/outsource/orders', { product_id: product.id, plan_qty: '1' });
if (!outOrder.order?.id || !outOrder.order.code) throw new Error('造外协工单失败');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await asUser(page, admin);

await step('1', '销售出库扩展管理打开态', async () => {
  await open(page, '/sale_stock_out_bill/list', '销售出库');
  await expectManager(page, '【销售出库单】扩展字段管理', 'r12x-01-sale-ext-open');
  await closeModals(page);
  return '单套';
});

await step('2', '采购退货扩展管理打开态', async () => {
  await open(page, '/purchase_return_bill/list', '采购退货');
  await expectManager(page, '【采购退货单】扩展字段管理', 'r12x-02-purchase-return-ext-open');
  await closeModals(page);
  return '单套';
});

await step('3', '生产出库扩展管理打开态且无 Tab', async () => {
  await open(page, '/production_out_of_storage/list', '生产出库');
  await expectManager(page, '【生产出库单】扩展字段管理', 'r12x-03-issue-ext-open');
  await closeModals(page);
  return '原版未采到/单套';
});

await step('4', '生产退料扩展管理打开态', async () => {
  await open(page, '/produce_return_materiel_bill/list', '生产退料');
  await expectManager(page, '【生产退料单】扩展字段管理', 'r12x-04-prod-return-ext-open');
  await closeModals(page);
  return '单套';
});

await step('5', '销售退货扩展管理打开态', async () => {
  await open(page, '/salesReturnOrder/list', '销售退货');
  await expectManager(page, '【销售退货单】扩展字段管理', 'r12x-05-sales-return-ext-open');
  await closeModals(page);
  return '单套';
});

await step('6', '销售出库类型 16 且无公式无自动填充', async () => {
  await open(page, '/sale_stock_out_bill/list', '销售出库');
  await clickExt(page);
  const list = await expectTitle(page, '【销售出库单】扩展字段管理');
  await btn(list, '新增').click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor();
  await add.locator('.ant-select').nth(1).click();
  const popup = page.locator('.ext-type-popup');
  await popup.waitFor();
  const labels = (await popup.locator('.ant-select-item-option-content').allTextContents()).map((item) => item.trim()).filter(Boolean);
  await shot(page, 'r12x-22-types-16', true);
  if (labels.length !== 16) throw new Error(`类型数 ${labels.length}：${labels.join('|')}`);
  for (const type of STANDARD_TYPES) if (!labels.includes(type)) throw new Error(`缺类型 ${type}`);
  if (labels.includes('公式')) throw new Error('出现公式');
  if ((await add.innerText()).includes('自动填充规则')) throw new Error('出现自动填充规则');
  await add.locator('.ant-modal-title').click();
  await confirmTextField(page, add, saleField);
  await list.getByText(saleField, { exact: true }).waitFor();
  await closeModals(page);
  return String(labels.length);
});

await step('7', '其余四页新增必填字段', async () => {
  await addRequiredField(page, '/purchase_return_bill/list', '采购退货', '【采购退货单】扩展字段管理', returnField);
  await addRequiredField(page, '/production_out_of_storage/list', '生产出库', '【生产出库单】扩展字段管理', issueField);
  await addRequiredField(page, '/produce_return_materiel_bill/list', '生产退料', '【生产退料单】扩展字段管理', prodField);
  await addRequiredField(page, '/salesReturnOrder/list', '销售退货', '【销售退货单】扩展字段管理', salesField);
  return '四页必填';
});

await step('8', '销售出库必填拦截并落库', async () => {
  const before = await api(admin, 'GET', '/api/warehouse/shipments');
  await open(page, '/sale_stock_out_bill/list', '销售出库');
  const form = await openMenuAdd(page, '合同出库', '新增销售出库单');
  await selectByLabel(page, form, '仓库 *', warehouseName);
  await selectByLabel(page, form, '合同单号 *', contractCode);
  await btn(form, '+ 选择合同商品').click();
  await setQty(form, productName, '1');
  await shot(page, 'r12x-06-sale-form', true);
  await requireThenSave(page, form, saleField, saleValue);
  const after = await api(admin, 'GET', '/api/warehouse/shipments');
  const id = freshId(before, after, '销售出库');
  await assertStored('sale_stock_out', id, saleField, saleValue);
  await stillThere(page, '/sale_stock_out_bill/list', '销售出库', '【销售出库单】扩展字段管理', saleField);
  return id;
});

await step('9', '采购退货必填拦截并落库', async () => {
  const before = await api(admin, 'GET', '/api/warehouse/purchase-returns');
  await open(page, '/purchase_return_bill/list', '采购退货');
  const form = await openPlainAdd(page, '新增采购退货单');
  await selectByLabel(page, form, '仓库 *', warehouseName);
  await selectByLabel(page, form, '采购单号 *', purchaseCode);
  await btn(form, '+ 选择退货商品').click();
  const picker = page.getByRole('dialog', { name: '选择退货商品' });
  await picker.waitFor();
  const row = picker.locator('.ant-table-row').filter({ hasText: partName });
  if (await row.count() !== 1) throw new Error(`退货商品「${partName}」匹配 ${await row.count()}`);
  await row.locator('.ant-checkbox').click();
  if (await row.locator('input.ant-checkbox-input').isChecked() !== true) throw new Error('退货商品未勾选');
  await btn(picker, '确定').click();
  await picker.waitFor({ state: 'hidden', timeout: 8000 });
  await setQty(form, partName, '1');
  await shot(page, 'r12x-07-purchase-return-form', true);
  await requireThenSave(page, form, returnField, returnValue);
  const after = await api(admin, 'GET', '/api/warehouse/purchase-returns');
  const id = freshId(before, after, '采购退货');
  await assertStored('purchase_return', id, returnField, returnValue);
  await stillThere(page, '/purchase_return_bill/list', '采购退货', '【采购退货单】扩展字段管理', returnField);
  return id;
});

await step('10', '生产出库必填拦截并落库', async () => {
  const before = await api(admin, 'GET', '/api/warehouse/material-issues');
  await open(page, '/production_out_of_storage/list', '生产出库');
  const form = await openMenuAdd(page, '加工单出库', '新增生产出库单');
  await selectByLabel(page, form, '仓库 *', warehouseName);
  await selectByLabel(page, form, '加工单号 *', woCode);
  await form.getByText(partName).first().waitFor();
  await shot(page, 'r12x-08-issue-form', true);
  await requireThenSave(page, form, issueField, issueValue);
  const after = await api(admin, 'GET', '/api/warehouse/material-issues');
  const id = freshId(before, after, '生产出库');
  await assertStored('material_issue', id, issueField, issueValue);
  await stillThere(page, '/production_out_of_storage/list', '生产出库', '【生产出库单】扩展字段管理', issueField);
  return id;
});

await step('11', '生产退料必填拦截并落库', async () => {
  const before = await api(admin, 'GET', '/api/warehouse/misc-bills?kind=prod_return_mat');
  await open(page, '/produce_return_materiel_bill/list', '生产退料');
  const form = await openMenuAdd(page, '加工单退料', '新增生产退料单');
  await selectByLabel(page, form, '仓库 *', warehouseName);
  await selectByLabel(page, form, '加工单 *', woCode);
  await setQty(form, partName, '1');
  await shot(page, 'r12x-09-prod-return-form', true);
  await requireThenSave(page, form, prodField, prodValue);
  const after = await api(admin, 'GET', '/api/warehouse/misc-bills?kind=prod_return_mat');
  const id = freshId(before, after, '生产退料');
  await assertStored('prod_return', id, prodField, prodValue);
  await stillThere(page, '/produce_return_materiel_bill/list', '生产退料', '【生产退料单】扩展字段管理', prodField);
  return id;
});

await step('12', '销售退货必填拦截并落库', async () => {
  const before = await api(admin, 'GET', '/api/warehouse/misc-bills?kind=sales_return');
  await open(page, '/salesReturnOrder/list', '销售退货');
  const form = await openMenuAdd(page, '按合同退货', '新增销售退货单');
  await selectByLabel(page, form, '仓库 *', warehouseName);
  await selectByLabel(page, form, '合同单号 *', contractCode);
  await btn(form, '+ 选择合同商品').click();
  await setQty(form, productName, '1');
  await shot(page, 'r12x-10-sales-return-form', true);
  await requireThenSave(page, form, salesField, salesValue);
  const after = await api(admin, 'GET', '/api/warehouse/misc-bills?kind=sales_return');
  const id = freshId(before, after, '销售退货');
  await assertStored('sales_return', id, salesField, salesValue);
  await stillThere(page, '/salesReturnOrder/list', '销售退货', '【销售退货单】扩展字段管理', salesField);
  return id;
});

await step('13', '加工单配置查询条件打开态', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  const gear = page.getByRole('button', { name: '配置查询条件' });
  if (await gear.count() !== 1) throw new Error(`配置查询条件按钮 ${await gear.count()}`);
  await gear.click();
  const drawer = page.locator('.ant-drawer').last();
  await drawer.waitFor();
  const title = (await drawer.locator('.ant-drawer-title').innerText()).trim();
  if (title !== '配置查询条件') throw new Error(`抽屉标题「${title}」`);
  for (const label of ['加工单号', '合同编号', '商品', '备注', '计划开始起', '计划开始止']) {
    if (!(await drawer.getByText(label, { exact: true }).count())) throw new Error(`缺条件 ${label}`);
  }
  if (await drawer.getByText('商品规格', { exact: true }).count()) throw new Error('商品规格未接线却出现在抽屉');
  const extra = (await drawer.locator('.ant-drawer-extra').innerText()).replace(/\s+/g, '');
  if (!extra.includes('取消') || !extra.includes('确定')) throw new Error(`抽屉操作区「${extra}」`);
  await shot(page, 'r12x-11-query-work-order', true);
  await btn(drawer.locator('.ant-drawer-extra'), '取消').click();
  await drawer.locator('.ant-drawer-content-wrapper-hidden').waitFor({ state: 'attached', timeout: 8000 });
  return '商品规格原版有、本轮未接线';
});

await step('14', '客户配置查询条件打开态', async () => {
  await open(page, '/customer/list', '客户');
  const gear = page.getByRole('button', { name: '配置查询条件' });
  if (await gear.count() !== 1) throw new Error(`配置查询条件按钮 ${await gear.count()}`);
  await gear.click();
  const drawer = page.locator('.ant-drawer').last();
  await drawer.waitFor();
  const title = (await drawer.locator('.ant-drawer-title').innerText()).trim();
  if (title !== '配置查询条件') throw new Error(`抽屉标题「${title}」`);
  for (const label of ['客户编号', '客户', '联系人', '地址']) {
    if (!(await drawer.getByText(label, { exact: true }).count())) throw new Error(`缺条件 ${label}`);
  }
  const extra = (await drawer.locator('.ant-drawer-extra').innerText()).replace(/\s+/g, '');
  if (!extra.includes('取消') || !extra.includes('确定')) throw new Error(`抽屉操作区「${extra}」`);
  await shot(page, 'r12x-12-query-customer', true);
  return '客户';
});

await step('15', '外协详情取消做实、打印做实、裸钮隐藏', async () => {
  await open(page, `/OutWorkOrder/detail/${outOrder.order.id}`, '外协工单详情');
  const bar = page.locator('.kgd-toolbar').first();
  for (const name of ['返回', '修改', '复制', '取消', '打印外协工单']) {
    if (await btn(bar, name).count() !== 1) throw new Error(`详情缺「${name}」`);
  }
  for (const name of ['删除', '分享外协工单进度', '撤回']) {
    if (await page.getByRole('button', { name }).count()) throw new Error(`仍可见「${name}」`);
  }
  await shot(page, 'r12x-13-outsource-toolbar', false);
  const popupPromise = page.waitForEvent('popup');
  await btn(bar, '打印外协工单').click();
  const popup = await popupPromise;
  await popup.locator('h1').waitFor();
  const heading = (await popup.locator('h1').innerText()).trim();
  if (heading !== '外协工单') throw new Error(`打印标题「${heading}」`);
  await popup.screenshot({ path: path.join(artifactDir, 'r12x-15-outsource-print.png') });
  writeFileSync(path.join(docDir, 'r12x-15-outsource-print.png'), readFileSync(path.join(artifactDir, 'r12x-15-outsource-print.png')));
  openShots.push('r12x-15-outsource-print');
  await popup.close();
  await btn(bar, '取消').click();
  const cancel = page.locator('.ant-modal').filter({ hasText: '取消外协工单' }).last();
  await cancel.waitFor();
  if ((await cancel.locator('.ant-modal-title').innerText()).trim() !== '取消外协工单') throw new Error('取消标题不对');
  await shot(page, 'r12x-14-outsource-cancel', true);
  await btn(cancel, '确定').click();
  await page.getByText('请填写取消原因').waitFor();
  await cancel.locator('input').fill(`验收取消${stamp}`);
  await btn(cancel, '确定').click();
  await page.getByText('已取消').first().waitFor();
  await page.reload();
  await page.getByText('外协工单详情').waitFor();
  await page.getByText('状态：已取消').waitFor();
  const detail = await api(admin, 'GET', `/api/outsource/orders/${outOrder.order.id}`);
  if (detail.order?.status !== '已取消') throw new Error(`状态 ${detail.order?.status}`);
  return detail.order.status;
});

await step('16', '外协列表打印在、更多隐藏', async () => {
  await open(page, '/OutWorkOrder/list', '外协工单号');
  if (await page.getByRole('button', { name: /^更多$/ }).count()) throw new Error('列表「更多」仍可见');
  const row = page.locator('.ant-table-row').filter({ hasText: outOrder.order.code });
  if (await row.count() !== 1) throw new Error(`外协行 ${await row.count()}`);
  if (await row.getByRole('button', { name: /^打印$/ }).count() !== 1) throw new Error('行内打印不唯一');
  const popupPromise = page.waitForEvent('popup');
  await row.getByRole('button', { name: /^打印$/ }).click();
  const popup = await popupPromise;
  await popup.locator('h1', { hasText: '外协工单' }).waitFor();
  await popup.close();
  return '更多已隐藏';
});

await step('17', '训练中心顶栏录入文档已隐藏', async () => {
  await open(page, '/digitalEmployees/manager/setting', '训练中心');
  if (await page.getByRole('button', { name: '录入文档' }).count()) throw new Error('默认页仍有录入文档');
  await page.getByRole('tab', { name: '文档集' }).click();
  const real = page.getByRole('button', { name: '录入文档' });
  if (await real.count() !== 1) throw new Error(`文档集录入文档 ${await real.count()}`);
  await shot(page, 'r12x-17-train-docs', false);
  return '顶栏已隐藏，文档集保留';
});

await step('18', '维保设置空壳隐藏且状态表仍在', async () => {
  await open(page, '/setting/inspection/setting', '设备状态');
  const statusCard = page.locator('.kgd-card').filter({ has: page.getByRole('heading', { name: '设备状态' }) });
  if (await statusCard.getByRole('button', { name: '添加' }).count()) throw new Error('设备状态添加仍在');
  if (await statusCard.getByText('修改', { exact: true }).count()) throw new Error('设备状态修改仍在');
  if (await statusCard.getByText('删除', { exact: true }).count()) throw new Error('设备状态删除仍在');
  await statusCard.getByText('正常', { exact: true }).waitFor();
  if (await page.getByRole('button', { name: '全部展开' }).count()) throw new Error('全部展开仍在');
  if (await page.getByRole('button', { name: '全部折叠' }).count()) throw new Error('全部折叠仍在');
  const planCard = page.locator('.kgd-card').filter({ hasText: '维保计划分类' });
  if (await planCard.count() !== 1) throw new Error(`维保计划分类卡片 ${await planCard.count()}`);
  if (await planCard.getByRole('button', { name: '新增' }).count()) throw new Error('维保计划分类新增仍在');
  const shop = page.locator('.kgd-card').filter({ hasText: '车间信息' });
  if (await shop.count() !== 1) throw new Error(`车间卡片 ${await shop.count()}`);
  if (await btn(shop, '新增').count() !== 1) throw new Error(`车间新增 ${await btn(shop, '新增').count()}`);
  await shot(page, 'r12x-16-equip-status', false);
  return '状态行仍在';
});

await step('19', '维保计划裸钮隐藏且选择设备可打开', async () => {
  await open(page, '/inspection_plan/add/1', '计划名称');
  if (await page.getByRole('button', { name: '+ 新增' }).count()) throw new Error('计划分类新增仍在');
  if (await page.getByRole('button', { name: '+新增' }).count()) throw new Error('+新增仍在');
  const title = page.locator('label').filter({ hasText: '计划名称' }).locator('input');
  await title.fill(`维保${stamp}`);
  const exec = page.locator('.ant-select').filter({ hasText: '个人执行' });
  if (await exec.count() !== 1) throw new Error(`执行类型 ${await exec.count()}`);
  await chooseExact(page, exec, '团队执行');
  await page.getByPlaceholder('开始时间', { exact: true }).click();
  const today = page.locator('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-cell-today');
  if (await today.count() < 1) throw new Error('日期面板没有今天');
  await today.first().click();
  const endCell = page.locator('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-cell-in-view').last();
  await endCell.click();
  await btn(page, '下一步').click();
  await page.getByRole('button', { name: '+ 选择设备' }).waitFor();
  await page.getByRole('button', { name: '+ 选择设备' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '选择设备' }).last();
  await modal.waitFor();
  if ((await modal.locator('.ant-modal-title').innerText()).trim() !== '选择设备') throw new Error('设备弹窗标题不对');
  for (const name of ['查询', '重置', '设置', '列']) {
    if (await modal.getByRole('button', { name: exactRe(name) }).count()) throw new Error(`设备弹窗仍有「${name}」`);
  }
  if (await modal.getByRole('button', { name: '+新增' }).count()) throw new Error('设备弹窗仍有+新增');
  await btn(modal, '确定').waitFor();
  await btn(modal, '取消').waitFor();
  await shot(page, 'r12x-18-plan-devices', true);
  return '选择设备';
});

await step('20', '采购入库双 Tab 回归且机台报表无扩展', async () => {
  await open(page, '/purchase_stock_in_bill/list', '采购入库');
  await clickExt(page);
  const modal = await expectTitle(page, '【采购入库单】扩展字段（主表/明细）');
  await modal.getByRole('tab', { name: '采购入库单扩展字段' }).waitFor();
  await modal.getByRole('tab', { name: '入库明细扩展字段' }).waitFor();
  await shot(page, 'r12x-19-purchase-in-tabs', true);
  await closeModals(page);
  await open(page, '/drilling_crew_statement/list', '机台编号');
  if (await page.getByRole('button', { name: '扩展字段' }).count()) throw new Error('机台报表出现扩展字段');
  if (await page.getByRole('button', { name: '移动端卡片配置' }).count()) throw new Error('机台报表出现移动端');
  return '采购入库仍双 Tab';
});

await step('21', '盘点、英文标题与打开态数量', async () => {
  const file = path.join(docDir, 'ext-inventory.md');
  const text = readFileSync(file, 'utf8');
  for (const needle of ['可加', '销售出库单', '采购退货单', '生产出库单', '生产退料单', '销售退货单', '原版未采到/单套', '机台报表']) {
    if (!text.includes(needle)) throw new Error(`盘点表缺少 ${needle}`);
  }
  const rg = spawnSync('rg', ['-n', '【[A-Za-z0-9_-]*-list】', 'apps/web/src'], { encoding: 'utf8' });
  if (rg.status === 0) throw new Error(`仍有英文 pageKey 标题\n${rg.stdout}`);
  if (rg.status !== 1) throw new Error(`rg 退出 ${rg.status} ${rg.stderr}`);
  if (openShots.length < 15) throw new Error(`打开态截图 ${openShots.length}：${openShots.join(',')}`);
  return `${openShots.length} 张打开态`;
});

await step('22', '禁 force 与 catch，并跑 typecheck 与 build', async () => {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  if (/\.force\s*:/.test(src) || /force:\s*true/.test(src)) throw new Error('脚本含 force');
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/await step\('22'[\s\S]*$/m, '');
  if (/\.catch\s*\(/.test(withoutComments)) throw new Error('脚本含 .catch');
  if (withoutComments.includes(['选', '第一', '项'].join(''))) throw new Error('脚本含禁止的挑选措辞');
  const typecheck = spawnSync('npm', ['run', 'typecheck'], { encoding: 'utf8', timeout: 180000 });
  const build = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', timeout: 300000 });
  const note = [
    `typecheck exit ${typecheck.status}`,
    (typecheck.stdout ?? '').slice(-800),
    (typecheck.stderr ?? '').slice(-800),
    `build exit ${build.status}`,
    (build.stdout ?? '').slice(-800),
    (build.stderr ?? '').slice(-800),
  ].join('\n');
  writeFileSync(path.join(docDir, 'r12x-20-ci.txt'), note);
  writeFileSync(path.join(artifactDir, 'r12x-20-ci.txt'), note);
  if (typecheck.status !== 0) throw new Error(`typecheck ${typecheck.status}`);
  if (build.status !== 0) throw new Error(`build ${build.status}`);
  return `打开态 ${openShots.length}；typecheck/build 通过`;
});

await browser.close();

const failed = results.filter((item) => item.result !== '通过');
const lines = [
  '# 第十二轮扩展待补与P1清理验收记录',
  '',
  `- 开始（北京时间）：${bj(startedAt)}`,
  `- 结束（北京时间）：${bj()}`,
  `- 脚本：scripts/round12-extp1-accept.mjs`,
  `- 截图目录：docs/verification/round12-extp1/`,
  `- 打开态截图 ${openShots.length}：${openShots.join('、')}`,
  `- 通过 ${results.length - failed.length} / ${results.length}`,
  '',
  '| # | 结果 | 说明 |',
  '|---|---|---|',
  ...results.map((item) => `| ${item.n} | ${item.result} | ${item.title} ${item.reason.replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
  '',
  '主从表：五页均为原版未采到/单套。商品规格：加工单查询原版有，本轮未接线。外协删除/分享/撤回/更多，以及验收与结算已结算行打印：原版有、本轮未做实，已隐藏。',
  '',
];
writeFileSync(path.join(process.cwd(), 'docs/第十二轮扩展待补与P1清理验收记录.md'), lines.join('\n'));
console.log(failed.length ? `未通过 ${failed.length}` : '全部通过');
process.exit(failed.length ? 1 : 0);
