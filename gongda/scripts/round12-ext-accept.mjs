#!/usr/bin/env node
/**
 * 第十二轮：扩展字段按原版恢复。Playwright only。
 * 空库经正式接口造数。禁止 force、禁止 .catch 吞断言、禁止没数据就选第一项。
 * 截图：docs/verification/round12-ext/ 与 /opt/cursor/artifacts/round12-ext/
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/round12-ext';
const docDir = path.join(process.cwd(), 'docs/verification/round12-ext');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });

const startedAt = new Date();
const results = [];
const stamp = Date.now().toString().slice(-6);
const supplierName = `验收供应商R12${stamp}`;
const supplierValue = `供应商扩展已填${stamp}`;
const headField = `入库主表${stamp}`;
const lineField = `入库明细${stamp}`;
const headValue = `主表值${stamp}`;
const lineValue = `明细值${stamp}`;
const receiptNote = `验收入库${stamp}`;
const sortA = `排序甲${stamp}`;
const sortB = `排序乙${stamp}`;
const bomField = `BOM字段${stamp}`;
const supplierField = `供应商备注${stamp}`;

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
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function shot(page, name) {
  await page.waitForTimeout(200);
  const p1 = path.join(artifactDir, `${name}.png`);
  const p2 = path.join(docDir, `${name}.png`);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.screenshot({ path: p1, fullPage: false });
      writeFileSync(p2, readFileSync(p1));
      console.log('saved', name);
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
  if (/supplier-list|【[A-Za-z0-9_-]*-list】/.test(heading)) throw new Error(`标题含英文 pageKey：${heading}`);
  const add = btn(modal, '新增');
  if (await add.count() !== 1) throw new Error('管理弹窗没有唯一的「新增」');
  await add.waitFor();
  const body = await page.locator('body').innerText();
  if (body.includes('【supplier-list】') || body.includes('supplier-list】')) throw new Error('页面出现 supplier-list 标题');
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
  const option = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  const count = await option.count();
  if (count !== 1) throw new Error(`选项「${label}」匹配 ${count} 项`);
  await option.click();
}

async function openAddField(page, listTitle) {
  await clickExt(page);
  const list = await expectTitle(page, listTitle);
  await btn(list, '新增').click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor({ state: 'visible' });
  return { list, add };
}

async function typeLabels(page, add) {
  await add.locator('.ant-select').nth(1).click();
  const popup = page.locator('.ext-type-popup');
  await popup.waitFor();
  const labels = (await popup.locator('.ant-select-item-option-content').allTextContents()).map((item) => item.trim()).filter(Boolean);
  return labels;
}

async function confirmTextField(page, add, name) {
  await page.waitForTimeout(450);
  const nameInput = add.locator('label').filter({ hasText: '字段名' }).locator('input');
  await nameInput.click();
  await nameInput.pressSequentially(name, { delay: 15 });
  if (await nameInput.inputValue() !== name) throw new Error(`字段名未写入，当前「${await nameInput.inputValue()}」`);
  await btn(add, '确定').click();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await add.isVisible())) return;
    if (await add.locator('.kgd-field-help').count()) throw new Error(await add.locator('.kgd-field-help').innerText());
    await page.waitForTimeout(200);
  }
  throw new Error('新增扩展字段未关闭');
}

const credFile = path.join(process.cwd(), '.local/dev-credentials.txt');
if (!existsSync(credFile)) throw new Error('缺少 .local/dev-credentials.txt');
const password = passwordOf(credFile, 'admin.local');
if (!password) throw new Error('未读到 admin.local 密码');

await waitServers();
const admin = await login('admin.local', password);

const members = await api(admin, 'GET', '/api/team-members');
const adminMember = (members.items ?? []).find((item) => item.username === 'admin.local' || item.display_name === '本地管理员');
if (!adminMember || adminMember.display_name !== '本地管理员') {
  throw new Error(`收货人必须是「本地管理员」，实际 ${adminMember?.display_name ?? '无'}`);
}
const products = await api(admin, 'GET', '/api/products?page=1&page_size=100');
const product = (products.items ?? []).find((item) => item.code === 'LOCAL001');
if (!product) throw new Error('空库没有商品 LOCAL001，停止造数');
const productName = String(product.name);
const warehouse = await api(admin, 'POST', '/api/warehouse/warehouses', {
  request_key: crypto.randomUUID(),
  name: `验收仓R12${stamp}`,
  province: '上海',
  city: '上海',
  district: '浦东新区',
  address: '验收路1号',
});
if (!warehouse.warehouse?.id) throw new Error('建仓失败');
const supplier = await api(admin, 'POST', '/api/money/suppliers', { name: `造数供应商${stamp}` });
if (!supplier.supplier?.id) throw new Error('造数供应商失败');
const purchaseCode = `CGR12${stamp}`;
const purchase = await api(admin, 'POST', '/api/money/purchase-orders', {
  code: purchaseCode,
  supplier_id: supplier.supplier.id,
  lines: [{ product_id: product.id, quantity: '2', unit_price: '1' }],
});
if (purchase.purchase_order?.approval !== 'approved' || purchase.purchase_order?.lifecycle !== 'open') {
  throw new Error(`采购单状态不允许入库：${purchase.purchase_order?.approval}/${purchase.purchase_order?.lifecycle}`);
}
const purchaseLine = (purchase.purchase_order.lines ?? []).find((line) => line.product_name === productName);
if (!purchaseLine) throw new Error(`采购明细没有商品「${productName}」`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await asUser(page, admin);

await step('1', '供应商扩展字段打开态', async () => {
  await open(page, '/supplier/list', '供应商');
  await clickExt(page);
  const modal = await expectTitle(page, '【供应商】扩展字段管理');
  await modal.getByText('暂无数据').waitFor();
  for (const col of ['排序', '字段名', '字段类型', '是否必填', '创建时间', '操作']) {
    if (!(await modal.getByText(col, { exact: true }).count())) throw new Error(`缺列 ${col}`);
  }
  await shot(page, 'r12e-01-supplier-ext-open');
  await closeModals(page);
  return '【供应商】扩展字段管理';
});

await step('2', '供应商新增并落库后刷新仍在', async () => {
  await open(page, '/supplier/list', '供应商');
  const { list, add } = await openAddField(page, '【供应商】扩展字段管理');
  await confirmTextField(page, add, supplierField);
  await list.getByText(supplierField, { exact: true }).waitFor();
  await closeModals(page);
  await btn(page.locator('.kgd-toolbar'), '新增').click();
  const form = page.locator('.ant-modal').filter({ hasText: '新增供应商' }).last();
  await form.waitFor();
  if (!(await form.getByText(supplierField).count())) throw new Error('新增供应商表单没有扩展字段');
  const nameInput = form.locator('.ant-form-item').filter({ hasText: '供应商名称' }).locator('input');
  await nameInput.click();
  await nameInput.pressSequentially(supplierName, { delay: 10 });
  const extInput = form.locator('.ext-fields input');
  await extInput.click();
  await extInput.pressSequentially(supplierValue, { delay: 10 });
  await shot(page, 'r12e-02-supplier-ext-persist');
  await btn(form, '确定').click();
  await form.waitFor({ state: 'hidden', timeout: 15000 });
  await page.getByText('已保存').waitFor();
  await page.reload();
  await page.getByText('供应商').first().waitFor();
  const row = page.locator('.ant-table-row').filter({ hasText: supplierName });
  if (await row.count() !== 1) throw new Error(`供应商行匹配 ${await row.count()}`);
  await row.getByRole('button', { name: '修改' }).click();
  const edit = page.locator('.ant-modal').filter({ hasText: '修改供应商' }).last();
  await edit.waitFor();
  const value = await edit.locator('.ext-fields input').inputValue();
  if (value !== supplierValue) throw new Error(`刷新后扩展值「${value}」`);
  const listApi = await api(admin, 'GET', '/api/money/suppliers');
  const saved = (listApi.items ?? []).find((item) => item.name === supplierName);
  if (!saved?.id) throw new Error('接口未见新建供应商');
  const fields = await api(admin, 'GET', `/api/entity-ext-fields?entity=supplier`);
  const field = (fields.items ?? []).find((item) => item.name === supplierField);
  if (!field) throw new Error('字段未落库');
  const values = await api(admin, 'GET', `/api/entity-ext-values?entity=supplier&record_id=${saved.id}`);
  if (values.values?.[field.id] !== supplierValue) throw new Error(`值未落库 ${JSON.stringify(values.values)}`);
  await closeModals(page);
  return supplierValue;
});

await step('3', '供应商类型 16 且无公式无自动填充', async () => {
  await open(page, '/supplier/list', '供应商');
  const { add } = await openAddField(page, '【供应商】扩展字段管理');
  const labels = await typeLabels(page, add);
  await shot(page, 'r12e-03-supplier-types');
  await page.keyboard.press('Escape');
  const text = await add.innerText();
  if (labels.length !== 16) throw new Error(`类型数 ${labels.length}：${labels.join('|')}`);
  if (labels.includes('公式')) throw new Error('供应商出现公式');
  if (text.includes('自动填充规则')) throw new Error('供应商出现自动填充规则');
  await closeModals(page);
  return String(labels.length);
});

await step('4', '采购入库外层标题与两个 Tab', async () => {
  await open(page, '/purchase_stock_in_bill/list', '采购入库');
  await clickExt(page);
  const modal = await expectTitle(page, '【采购入库单】扩展字段（主表/明细）');
  await modal.getByRole('tab', { name: '采购入库单扩展字段' }).waitFor();
  await modal.getByRole('tab', { name: '入库明细扩展字段' }).waitFor();
  await shot(page, 'r12e-04-purchase-in-tabs');
  await closeModals(page);
  return '两 Tab';
});

await step('5', '采购入库主表新增字段', async () => {
  await open(page, '/purchase_stock_in_bill/list', '采购入库');
  await clickExt(page);
  const modal = await expectTitle(page, '【采购入库单】扩展字段（主表/明细）');
  await modal.getByRole('tab', { name: '采购入库单扩展字段' }).click();
  await modal.getByText('暂无数据').waitFor();
  for (const col of ['排序', '字段名', '字段类型', '是否必填', '创建时间', '操作']) {
    if (!(await modal.getByText(col, { exact: true }).count())) throw new Error(`缺列 ${col}`);
  }
  await btn(modal, '新增').click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor();
  await confirmTextField(page, add, headField);
  await modal.getByText(headField, { exact: true }).waitFor();
  await shot(page, 'r12e-05-purchase-in-header');
  await closeModals(page);
  return headField;
});

await step('6', '采购入库明细字段与主表隔离', async () => {
  await open(page, '/purchase_stock_in_bill/list', '采购入库');
  await clickExt(page);
  const modal = await expectTitle(page, '【采购入库单】扩展字段（主表/明细）');
  await modal.getByRole('tab', { name: '入库明细扩展字段' }).click();
  if (await modal.getByText(headField, { exact: true }).count()) throw new Error('明细 Tab 看见主表字段');
  await modal.getByText('暂无数据').waitFor();
  await btn(modal, '新增').click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor();
  await confirmTextField(page, add, lineField);
  await modal.getByText(lineField, { exact: true }).waitFor();
  await modal.getByRole('tab', { name: '采购入库单扩展字段' }).click();
  if (await modal.getByText(lineField, { exact: true }).count()) throw new Error('主表 Tab 看见明细字段');
  await modal.getByText(headField, { exact: true }).waitFor();
  await modal.getByRole('tab', { name: '入库明细扩展字段' }).click();
  await shot(page, 'r12e-06-purchase-in-line');
  await closeModals(page);
  return lineField;
});

await step('7', '采购入库单据主表与明细扩展落库', async () => {
  await open(page, '/purchase_stock_in_bill/list', '采购入库');
  await btn(page.locator('.kgd-toolbar'), '+ 新增').click();
  const form = page.locator('.ant-modal').filter({ hasText: '新增采购入库单' }).last();
  await form.waitFor();
  await chooseExact(page, form.locator('.ant-select').nth(0), `验收仓R12${stamp}`);
  await chooseExact(page, form.locator('.ant-select').nth(2), '本地管理员');
  await form.locator('textarea').first().fill(receiptNote);
  if (!(await form.getByText(headField).count())) throw new Error('主表单没有主表扩展字段');
  await form.locator('.ext-fields input').fill(headValue);
  await btn(form, '+ 选择采购入库商品').click();
  const picker = page.locator('.ant-modal').filter({ hasText: '选择采购单商品' }).last();
  await picker.waitFor();
  await picker.getByText(purchaseCode, { exact: true }).waitFor({ timeout: 15000 });
  const picked = picker.locator('.ant-table-row').filter({ hasText: productName }).filter({ hasText: purchaseCode });
  if (await picked.count() !== 1) throw new Error(`采购商品「${productName} / ${purchaseCode}」匹配 ${await picked.count()} 行`);
  await picked.getByRole('checkbox').click();
  await btn(picker, '确定').click();
  await picker.waitFor({ state: 'hidden' });
  const lineRow = form.locator('.ant-table-row').filter({ hasText: productName });
  if (await lineRow.count() !== 1) throw new Error('明细行未带回');
  if (!(await lineRow.getByText(lineField).count())) throw new Error('明细行没有明细扩展字段');
  await lineRow.locator('input').nth(0).fill('1');
  await lineRow.locator('.ext-line-fields input').fill(lineValue);
  await shot(page, 'r12e-07-purchase-in-form');
  await btn(form, '确定').click();
  await form.waitFor({ state: 'hidden', timeout: 20000 });
  await page.getByText('已保存').waitFor();
  const receipts = await api(admin, 'GET', '/api/warehouse/purchase-receipts');
  const receipt = (receipts.items ?? []).find((item) => item.note === receiptNote);
  if (!receipt?.id) throw new Error('未找到验收入库单');
  const line = (receipt.lines ?? []).find((item) => item.purchase_line_id === purchaseLine.id);
  if (!line?.id) throw new Error('入库明细 id 缺失');
  const headFields = await api(admin, 'GET', '/api/entity-ext-fields?entity=purchase_stock_in');
  const lineFields = await api(admin, 'GET', '/api/entity-ext-fields?entity=purchase_stock_in_line');
  const head = (headFields.items ?? []).find((item) => item.name === headField);
  const lineSchema = (lineFields.items ?? []).find((item) => item.name === lineField);
  if (!head || !lineSchema) throw new Error('主从 schema 缺失');
  if ((headFields.items ?? []).some((item) => item.name === lineField)) throw new Error('主表 schema 混入明细字段');
  if ((lineFields.items ?? []).some((item) => item.name === headField)) throw new Error('明细 schema 混入主表字段');
  const headValues = await api(admin, 'GET', `/api/entity-ext-values?entity=purchase_stock_in&record_id=${receipt.id}`);
  const lineValues = await api(admin, 'GET', `/api/entity-ext-values?entity=purchase_stock_in_line&record_id=${line.id}`);
  if (headValues.values?.[head.id] !== headValue) throw new Error(`主表值未落库 ${JSON.stringify(headValues.values)}`);
  if (lineValues.values?.[lineSchema.id] !== lineValue) throw new Error(`明细值未落库 ${JSON.stringify(lineValues.values)}`);
  return receipt.id;
});

await step('8', '加工单扩展字段标题回归', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await clickExt(page);
  await expectTitle(page, '【加工单】扩展字段管理');
  await shot(page, 'r12e-08-wo-ext');
  await closeModals(page);
  return '【加工单】扩展字段管理';
});

await step('9', '加工单类型 17 含公式', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  const { add } = await openAddField(page, '【加工单】扩展字段管理');
  const labels = await typeLabels(page, add);
  const text = await add.innerText();
  await shot(page, 'r12e-09-wo-types-17');
  await page.keyboard.press('Escape');
  if (labels.length !== 17) throw new Error(`类型数 ${labels.length}：${labels.join('|')}`);
  if (!labels.includes('公式')) throw new Error('加工单缺少公式');
  if (!text.includes('自动填充规则')) throw new Error('加工单缺少自动填充规则');
  await closeModals(page);
  return String(labels.length);
});

await step('10', '客户扩展字段标题', async () => {
  await open(page, '/customer/list', '客户');
  await clickExt(page);
  await expectTitle(page, '【客户管理】扩展字段管理');
  await shot(page, 'r12e-10-customer-ext');
  await closeModals(page);
  return '【客户管理】扩展字段管理';
});

await step('11', '联系人扩展字段标题', async () => {
  await open(page, '/linkman/list', '联系人');
  await clickExt(page);
  await expectTitle(page, '【客户联系人】扩展字段管理');
  await shot(page, 'r12e-11-linkman-ext');
  await closeModals(page);
  return '【客户联系人】扩展字段管理';
});

await step('12', '商品扩展字段标题', async () => {
  await open(page, '/goods/list', '商品');
  await clickExt(page);
  await expectTitle(page, '【商品】扩展字段管理');
  await shot(page, 'r12e-12-goods-ext');
  await closeModals(page);
  return '【商品】扩展字段管理';
});

await step('13', '源码与运行态无英文 pageKey 标题', async () => {
  const rg = spawnSync('rg', ['-n', '【\\$\\{.*pageKey|【supplier-list】|【[A-Za-z0-9_-]*-list】', 'apps/web/src'], { encoding: 'utf8' });
  const text = `${rg.stdout ?? ''}${rg.stderr ?? ''}`.trim();
  const file = path.join(docDir, 'r12e-13-rg-no-en-pagekey.txt');
  writeFileSync(file, text || '无匹配\n');
  writeFileSync(path.join(artifactDir, 'r12e-13-rg-no-en-pagekey.txt'), text || '无匹配\n');
  if (rg.status !== 0 && rg.status !== 1) throw new Error(`rg 失败 ${rg.status} ${text.slice(0, 300)}`);
  if (rg.status === 0 && text) throw new Error(`仍有英文标题拼接：\n${text.slice(0, 400)}`);
  await open(page, '/supplier/list', '供应商');
  const body = await page.locator('body').innerText();
  if (body.includes('【supplier-list】')) throw new Error('运行态出现 supplier-list 标题');
  return '无匹配';
});

await step('14', '机台报表无扩展字段', async () => {
  await open(page, '/drilling_crew_statement/list', '机台');
  const count = await page.locator('.kgd-toolbar').getByRole('button', { name: '扩展字段' }).count();
  if (count !== 0) throw new Error('机台报表仍有扩展字段');
  if (await page.getByRole('button', { name: '移动端卡片配置' }).count()) throw new Error('机台报表仍有移动端卡片');
  await shot(page, 'r12e-14-machine-no-ext');
  return '无按钮';
});

async function openChinese(page, url, waitText, title, file) {
  await open(page, url, waitText);
  await clickExt(page);
  await expectTitle(page, title);
  await shot(page, file);
  await closeModals(page);
}

await step('15', '合同订单扩展字段', async () => {
  await openChinese(page, '/customer_contract/list', '合同', '【合同订单】扩展字段管理', 'r12e-15-contract-ext');
  return '【合同订单】扩展字段管理';
});

await step('16', '合同报价单扩展字段', async () => {
  await openChinese(page, '/contract_quotation_bill/list', '报价', '【合同报价单】扩展字段管理', 'r12e-16-quotation-ext');
  return '【合同报价单】扩展字段管理';
});

await step('17', '客户跟单扩展字段', async () => {
  await openChinese(page, '/follow/list', '跟单', '【客户跟单】扩展字段管理', 'r12e-17-follow-ext-or-absent');
  return '【客户跟单】扩展字段管理';
});

await step('18', '其他入库、盘点、调拨、成品与半成品', async () => {
  await openChinese(page, '/else_stock_in_bill/list', '其他入库', '【其他入库单】扩展字段管理', 'r12e-18-wh-misc-ext');
  await open(page, '/stock_taking_bill/list', '盘点');
  await clickExt(page);
  await expectTitle(page, '【库存盘点】扩展字段管理');
  await closeModals(page);
  await open(page, '/stock_allocate_bill/list', '调拨');
  await clickExt(page);
  await expectTitle(page, '【调拨单】扩展字段管理');
  await closeModals(page);
  await open(page, '/else_stock_out_bill/list', '其他出库');
  await clickExt(page);
  const out = await expectTitle(page, '【其他出库单】扩展字段管理');
  if (await out.getByRole('tab', { name: '入库明细扩展字段' }).count()) throw new Error('其他出库被做成主从表');
  await closeModals(page);
  await open(page, '/produce_stock_in_bill/list', '成品入库');
  await clickExt(page);
  const fg = await expectTitle(page, '【成品入库单】扩展字段管理');
  await fg.getByRole('tab', { name: '成品入库单扩展字段' }).waitFor();
  await fg.getByRole('tab', { name: '入库明细扩展字段' }).waitFor();
  await closeModals(page);
  await open(page, '/semi_finished_products_stock_in_bill/list', '半成品');
  await clickExt(page);
  const semi = await expectTitle(page, '【半成品入库单】扩展字段管理');
  if (await semi.getByRole('tab').count()) throw new Error('半成品主从表原版未采到，不应出现 Tab');
  await closeModals(page);
  return '其他入库打开态；盘点/调拨/成品两 Tab/半成品单套';
});

await step('19', '工序 14 类型无公式无关联', async () => {
  await open(page, '/public_craft/list', '工序');
  const { add } = await openAddField(page, '【工序管理】扩展字段管理');
  const labels = await typeLabels(page, add);
  const text = await add.innerText();
  await shot(page, 'r12e-19-craft-ext');
  await page.keyboard.press('Escape');
  if (labels.length !== 14) throw new Error(`类型数 ${labels.length}：${labels.join('|')}`);
  for (const banned of ['公式', '关联对象', '关联属性']) {
    if (labels.includes(banned)) throw new Error(`工序出现 ${banned}`);
  }
  if (text.includes('自动填充规则')) throw new Error('工序出现自动填充');
  await closeModals(page);
  return String(labels.length);
});

await step('20', 'BOM 中文标题可新增落库（类型待原版确认）', async () => {
  await open(page, '/bom/list', 'BOM');
  const { list, add } = await openAddField(page, '【BOM管理】扩展字段管理');
  const labels = await typeLabels(page, add);
  await page.keyboard.press('Escape');
  const text = await add.innerText();
  if (text.includes('自动填充规则')) throw new Error('BOM 出现自动填充');
  if (labels.length !== 17 || !labels.includes('公式')) throw new Error(`BOM 按商品同构应为 17 含公式，实际 ${labels.length}`);
  await confirmTextField(page, add, bomField);
  await list.getByText(bomField, { exact: true }).waitFor();
  await shot(page, 'r12e-20-bom-ext');
  const fields = await api(admin, 'GET', '/api/entity-ext-fields?entity=bom');
  if (!(fields.items ?? []).some((item) => item.name === bomField)) throw new Error('BOM 字段未落库');
  await closeModals(page);
  return '17 待原版确认';
});

await step('21', '供应商排序与删除后刷新保持', async () => {
  await open(page, '/supplier/list', '供应商');
  await clickExt(page);
  let modal = await expectTitle(page, '【供应商】扩展字段管理');
  await btn(modal, '新增').click();
  let add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor();
  await confirmTextField(page, add, sortA);
  await btn(modal, '新增').click();
  add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor();
  await confirmTextField(page, add, sortB);
  const rowB = modal.locator('.ant-table-row').filter({ hasText: sortB });
  const rowA = modal.locator('.ant-table-row').filter({ hasText: sortA });
  await rowB.locator('[draggable="true"]').dragTo(rowA.locator('[draggable="true"]'));
  await page.waitForTimeout(500);
  await closeModals(page);
  await page.reload();
  await page.getByText('供应商').first().waitFor();
  await clickExt(page);
  modal = await expectTitle(page, '【供应商】扩展字段管理');
  const names = await modal.locator('.ant-table-row').allInnerTexts();
  const indexA = names.findIndex((item) => item.includes(sortA));
  const indexB = names.findIndex((item) => item.includes(sortB));
  if (indexA < 0 || indexB < 0 || indexB > indexA) throw new Error(`排序未保持：${names.join(' / ')}`);
  await btn(modal.locator('.ant-table-row').filter({ hasText: sortB }), '删除').click();
  await page.waitForTimeout(400);
  await closeModals(page);
  await page.reload();
  await page.getByText('供应商').first().waitFor();
  await clickExt(page);
  modal = await expectTitle(page, '【供应商】扩展字段管理');
  if (await modal.getByText(sortB, { exact: true }).count()) throw new Error('删除后刷新仍见排序乙');
  await modal.getByText(sortA, { exact: true }).waitFor();
  await shot(page, 'r12e-21-supplier-sort-del');
  await closeModals(page);
  return '乙在甲前，乙已删';
});

await step('22', '采购入库主从删除互不影响', async () => {
  await open(page, '/purchase_stock_in_bill/list', '采购入库');
  await clickExt(page);
  const modal = await expectTitle(page, '【采购入库单】扩展字段（主表/明细）');
  await modal.getByRole('tab', { name: '采购入库单扩展字段' }).click();
  await btn(modal.locator('.ant-table-row').filter({ hasText: headField }), '删除').click();
  await page.waitForTimeout(400);
  if (await modal.getByText(headField, { exact: true }).count()) throw new Error('主表字段未删除');
  await modal.getByRole('tab', { name: '入库明细扩展字段' }).click();
  await modal.getByText(lineField, { exact: true }).waitFor();
  await btn(modal.locator('.ant-table-row').filter({ hasText: lineField }), '删除').click();
  await page.waitForTimeout(400);
  await modal.getByRole('tab', { name: '采购入库单扩展字段' }).click();
  if (await modal.getByText(lineField, { exact: true }).count()) throw new Error('删除明细影响了主表');
  await shot(page, 'r12e-22-purchase-in-isolated');
  await closeModals(page);
  return '互不影响';
});

await step('23', '盘点表已提交口径', async () => {
  const file = path.join(docDir, 'ext-inventory.md');
  const text = readFileSync(file, 'utf8');
  for (const needle of ['可加', '供应商', '采购入库单', '原版未采到', '待补', '机台报表', 'BOM管理', '待原版确认']) {
    if (!text.includes(needle)) throw new Error(`盘点表缺少 ${needle}`);
  }
  return file;
});

await step('24', '禁 force/catch/选第一项，并跑 typecheck 与 build', async () => {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  if (/\.force\s*:/.test(src) || /force:\s*true/.test(src)) throw new Error('脚本含 force');
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/await step\('24'[\s\S]*$/m, '');
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
  writeFileSync(path.join(docDir, 'r12e-24-ci.txt'), note);
  writeFileSync(path.join(artifactDir, 'r12e-24-ci.txt'), note);
  if (typecheck.status !== 0) throw new Error(`typecheck ${typecheck.status}`);
  if (build.status !== 0) throw new Error(`build ${build.status}`);
  return 'typecheck/build 通过';
});

await browser.close();

const failed = results.filter((item) => item.result !== '通过');
const lines = [
  `# 第十二轮扩展字段恢复验收记录`,
  ``,
  `- 开始（北京时间）：${bj(startedAt)}`,
  `- 结束（北京时间）：${bj()}`,
  `- 脚本：scripts/round12-ext-accept.mjs`,
  `- 截图目录：docs/verification/round12-ext/`,
  `- 通过 ${results.length - failed.length} / ${results.length}`,
  ``,
  `| # | 结果 | 说明 |`,
  `|---|---|---|`,
  ...results.map((item) => `| ${item.n} | ${item.result} | ${item.title} ${item.reason.replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
  ``,
];
writeFileSync(path.join(process.cwd(), 'docs/第十二轮扩展字段恢复验收记录.md'), lines.join('\n'));
console.log(failed.length ? `未通过 ${failed.length}` : '全部通过');
process.exit(failed.length ? 1 : 0);
