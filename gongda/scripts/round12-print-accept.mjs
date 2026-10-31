/**
 * 第十二轮打印模板验收。只用 Playwright。
 * 前置：npm run dev:setup && npm run dev
 * 截图：docs/verification/round12-print/shots
 * 禁止 force、禁止吞掉等待失败、禁止没数据就改点别的行。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/round12-print/shots');
mkdirSync(outDir, { recursive: true });

const PRODUCT_CODE = 'R12P-GOOD';
const PRODUCT_NAME = '打印验收商品';
const WO_CODE = 'R12P-打印';
const CUSTOM_NAME = '验收自定义报工模板';
const CUSTOM_TEXT = '验收自定义抬头';

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
  if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${username} ${JSON.stringify(json).slice(0, 240)}`);
  return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name };
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

async function ensurePrintData(admin) {
  const units = (await api(admin, 'GET', '/api/units')).items ?? [];
  const unit = units.find((item) => item.name === '个') ?? units[0];
  if (!unit) throw new Error('没有可用单位');
  const listed = (await api(admin, 'GET', `/api/products?page=1&page_size=100&code=${PRODUCT_CODE}`)).items ?? [];
  let product = listed.find((item) => item.code === PRODUCT_CODE);
  if (!product) {
    product = (await api(admin, 'POST', '/api/products', { code: PRODUCT_CODE, name: PRODUCT_NAME, unit_id: unit.id, attribute: 'manufactured' })).product;
  }
  if (product.name !== PRODUCT_NAME || product.code !== PRODUCT_CODE) throw new Error(`商品不是验收对象 ${product.code} ${product.name}`);
  const processes = (await api(admin, 'GET', '/api/processes')).items ?? [];
  let process = processes.find((item) => item.code === 'R12P-PIECE');
  if (!process) {
    process = (await api(admin, 'POST', '/api/processes', {
      code: 'R12P-PIECE', name: '打印验收工序', standard_minutes: '1', reporter_ids: [admin.userId],
      pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none',
    })).process;
  }
  const warehouses = (await api(admin, 'GET', '/api/warehouses')).items ?? [];
  let warehouse = warehouses.find((item) => item.code === 'R12P-WH');
  if (!warehouse) warehouse = (await api(admin, 'POST', '/api/warehouses', { request_key: randomUUID(), code: 'R12P-WH', name: '打印验收仓' })).warehouse;
  const orders = (await api(admin, 'GET', '/api/work-orders')).items ?? [];
  let order = orders.find((item) => item.code === WO_CODE);
  if (!order) {
    order = (await api(admin, 'POST', '/api/work-orders', {
      request_key: randomUUID(), code: WO_CODE, product_id: product.id, quantity: '10', warehouse_id: warehouse.id,
      note: '打印验收加工单', tasks: [{ process_id: process.id, pricing_mode: 'piece', wage_rate: '10' }],
    })).work_order;
  }
  if (order.execution === 'not_started') {
    order = (await api(admin, 'POST', `/api/work-orders/${order.id}/actions`, { action: 'start', version: order.version, request_key: randomUUID() })).work_order;
  }
  order = (await api(admin, 'GET', `/api/work-orders/${order.id}`)).work_order;
  const task = order.tasks?.[0];
  if (!task) throw new Error('加工单没有工序任务');
  const reports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${order.id}`)).items ?? [];
  if (!reports.length) {
    await api(admin, 'POST', '/api/production-reports', {
      request_key: randomUUID(), task_id: task.id, good_qty: '8', defect_qty: '1', rework_qty: '0', scrap_qty: '0', note: '打印验收报工',
    });
  }
  const again = (await api(admin, 'GET', `/api/production-reports?work_order_id=${order.id}`)).items ?? [];
  const report = again.find((item) => item.note === '打印验收报工');
  if (!report) throw new Error('没有备注为打印验收报工的报工记录');
  return { product, order, report };
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

async function open(page, urlPath, waitText) {
  await page.goto(`${WEB}${urlPath}`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByText(waitText, { exact: false }).first().waitFor({ timeout: 20000 });
}

async function waitPacked(page, want, count, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let got = 0;
  while (Date.now() < deadline) {
    got = await countPacked(page, want);
    if (got === count) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`按钮「${want}」数量 ${got}，期望 ${count}`);
}

async function countPacked(page, want) {
  return page.evaluate((name) => [...document.querySelectorAll('button, .ant-btn')].filter((node) => {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return (node.innerText || '').replace(/\s+/g, '') === name;
  }).length, want);
}

async function clickPacked(page, want, dialog) {
  const ok = await page.evaluate(({ name, dialog }) => {
    function shown(node) {
      let el = node;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        el = el.parentElement;
      }
      return true;
    }
    const nodes = [...document.querySelectorAll('button, .ant-btn')].filter((node) => shown(node) && (node.innerText || '').replace(/\s+/g, '') === name);
    const pool = dialog ? nodes.filter((node) => node.closest('.ant-modal')) : nodes.filter((node) => !node.closest('.ant-modal'));
    const hit = pool[0] || (dialog ? null : nodes[0]);
    if (!hit) return false;
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, { name: want, dialog });
  if (!ok) throw new Error(`找不到按钮 ${want}`);
}

async function clickRowButton(page, rowText, button) {
  const result = await page.evaluate(({ rowText, button }) => {
    const row = [...document.querySelectorAll('.ant-table-tbody tr')].find((tr) => (tr.innerText || '').includes(rowText));
    if (!row) return '没有这一行';
    const hit = [...row.querySelectorAll('button, .ant-btn')].find((node) => (node.innerText || '').replace(/\s+/g, '') === button);
    if (!hit) return '行内没有按钮';
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'ok';
  }, { rowText, button });
  if (result !== 'ok') throw new Error(`${rowText}：${result} ${button}`);
}

async function chooseTemplate(page, name) {
  const ok = await page.evaluate((name) => {
    const dialogs = [...document.querySelectorAll('.ant-modal-wrap')].filter((node) => getComputedStyle(node).display !== 'none');
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return false;
    const hit = [...dialog.querySelectorAll('label')].find((node) => {
      const text = (node.innerText || '').replace(/\s+/g, '');
      return text === name || text === `${name}系统模板`;
    });
    const input = hit?.querySelector('input');
    if (!input) return false;
    input.click();
    return true;
  }, name);
  if (!ok) throw new Error(`选不中模板 ${name}`);
}

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log('saved', name);
  return file;
}

async function shotDialog(dialog, name) {
  const file = path.join(outDir, `${name}.png`);
  await dialog.screenshot({ path: file });
  console.log('saved', name);
  return file;
}

async function waitOpaque(locator) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const opacity = await locator.evaluate((node) => getComputedStyle(node).opacity);
    if (opacity === '1') return;
    await locator.page().waitForTimeout(50);
  }
  throw new Error('弹窗没有完全显示');
}

async function removeNamedCustom(session, objectKey, name) {
  const list = await api(session, 'GET', `/api/print-templates?object_key=${encodeURIComponent(objectKey)}`);
  for (const item of list.items ?? []) {
    if (item.is_system || item.name !== name) continue;
    await api(session, 'DELETE', `/api/print-templates/${item.id}`, {});
  }
}

async function closeTop(page) {
  const close = page.locator('.ant-modal-wrap .ant-modal-close').last();
  await close.waitFor({ state: 'visible', timeout: 8000 });
  await close.click();
  await page.waitForTimeout(200);
}

const password = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!password) throw new Error('找不到 admin.local 凭据');
const admin = await login('admin.local', password);
const data = await ensurePrintData(admin);
if (data.order.code !== WO_CODE) throw new Error('加工单编号不对');
await removeNamedCustom(admin, 'work_report', CUSTOM_NAME);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shots = [];
try {
  await asUser(page, admin);

  await open(page, '/work_repoty_record/list', '报工记录');
  await waitPacked(page, '管理打印模板', 1);
  await page.getByText(WO_CODE).first().waitFor({ timeout: 15000 });
  shots.push(await shot(page, '01-report-toolbar'));

  await clickPacked(page, '管理打印模板', false);
  const manage = page.getByRole('dialog', { name: '管理自定义打印模板' });
  await manage.waitFor({ timeout: 15000 });
  await manage.locator('.ant-table-row').filter({ hasText: '系统模板' }).filter({ hasText: '报工记录打印模板' }).waitFor();
  await manage.getByText('系统模板').waitFor();
  await manage.getByRole('columnheader', { name: '序号' }).waitFor();
  await manage.getByRole('columnheader', { name: '模版名称' }).waitFor();
  await manage.getByRole('columnheader', { name: '操作' }).waitFor();
  await manage.getByRole('button', { name: '创建模板' }).waitFor();
  shots.push(await shot(page, '02-report-manage'));

  await clickPacked(page, '预览', true);
  const preview = page.getByRole('dialog', { name: '预览打印模板' });
  await preview.waitFor({ timeout: 15000 });
  await preview.getByLabel('画布预览').waitFor();
  if (await preview.getByRole('button', { name: '保存' }).count() !== 0) throw new Error('系统模板预览出现保存');
  shots.push(await shot(page, '03-report-system-preview-designer'));
  await closeTop(page);

  await clickPacked(page, '复制', true);
  await manage.getByText(/报工记录打印模板副本/).first().waitFor({ timeout: 15000 });
  shots.push(await shot(page, '04-report-copied'));

  await manage.getByRole('button', { name: '创建模板' }).click();
  const designer = page.getByRole('dialog', { name: '编辑打印模板' });
  await designer.waitFor({ timeout: 15000 });
  await designer.getByLabel('画布预览').waitFor();
  await designer.getByText('字段：商品名').waitFor();
  await designer.getByText('纸张', { exact: true }).waitFor();
  await designer.getByText('页边距（毫米）', { exact: true }).waitFor();
  shots.push(await shot(page, '05-designer-open'));
  await designer.getByLabel('模板名称').fill(CUSTOM_NAME);
  await designer.getByRole('button', { name: '添加文本', exact: true }).click();
  await designer.getByLabel('文本内容').fill(CUSTOM_TEXT);
  if ((await designer.getByLabel('文本内容').inputValue()) !== CUSTOM_TEXT) throw new Error('文本没有写进画布组件');
  shots.push(await shot(page, '06-designer-edited'));
  await designer.getByRole('button', { name: '保存', exact: true }).click();
  await designer.waitFor({ state: 'hidden', timeout: 15000 });
  if (await page.getByRole('dialog', { name: '编辑打印模板' }).count() !== 0) throw new Error('保存后设计器仍打开');
  if (await page.getByLabel('画布预览').count() !== 0) throw new Error('保存后仍能看到画布');
  if (await page.getByText('本对象下已有同名模板').count() !== 0) throw new Error('保存被同名模板挡住');
  await waitOpaque(manage);
  const savedRow = manage.locator('.ant-table-row').filter({ hasText: CUSTOM_NAME });
  await savedRow.waitFor({ timeout: 15000 });
  const savedText = await savedRow.innerText();
  if (!savedText.includes('编辑') || !savedText.includes('删除')) throw new Error('自定义行没有编辑和删除');
  if (await page.getByRole('dialog').count() !== 1) throw new Error('保存后仍叠着设计器');
  shots.push(await shot(page, '07-manage-saved-custom'));
  await closeTop(page);

  await clickRowButton(page, WO_CODE, '打印');
  const picker = page.getByRole('dialog', { name: '打印报工记录' });
  await picker.waitFor({ timeout: 15000 });
  await picker.locator('label').filter({ hasText: '系统模板' }).filter({ hasText: '报工记录打印模板' }).waitFor();
  await picker.getByText(CUSTOM_NAME, { exact: true }).waitFor();
  if (await page.getByText('本对象下已有同名模板').count() !== 0) throw new Error('选用窗出现同名错误');
  await waitOpaque(picker);
  shots.push(await shot(page, '08-report-picker'));
  await chooseTemplate(page, CUSTOM_NAME);
  const customPopupPromise = page.waitForEvent('popup');
  await clickPacked(page, '打印', true);
  const customPopup = await customPopupPromise;
  await customPopup.waitForSelector('.page');
  const customBody = await customPopup.locator('body').innerText();
  if (!customBody.includes(CUSTOM_TEXT)) throw new Error(`自定义预览缺少抬头：${customBody.slice(0, 400)}`);
  if (!customBody.includes(PRODUCT_NAME)) throw new Error(`自定义预览缺少商品名：${customBody.slice(0, 400)}`);
  if (!customBody.includes(CUSTOM_NAME)) throw new Error(`自定义预览缺少模板名：${customBody.slice(0, 400)}`);
  shots.push(await customPopup.screenshot({ path: path.join(outDir, '09-report-custom-preview.png') }).then(() => path.join(outDir, '09-report-custom-preview.png')));
  console.log('saved 09-report-custom-preview');
  await customPopup.close();

  await clickRowButton(page, WO_CODE, '打印');
  await picker.waitFor({ timeout: 15000 });
  await picker.getByText('报工记录打印模板').first().waitFor();
  await chooseTemplate(page, '报工记录打印模板');
  const systemPopupPromise = page.waitForEvent('popup');
  await clickPacked(page, '打印', true);
  const systemPopup = await systemPopupPromise;
  await systemPopup.waitForSelector('h1');
  const systemBody = await systemPopup.locator('body').innerText();
  if (!systemBody.includes('报工记录')) throw new Error(`系统预览缺少标题：${systemBody.slice(0, 400)}`);
  if (!systemBody.includes(PRODUCT_NAME)) throw new Error(`系统预览缺少商品名：${systemBody.slice(0, 400)}`);
  if (systemBody.includes(CUSTOM_TEXT)) throw new Error('系统模板预览混入了自定义抬头');
  shots.push(await systemPopup.screenshot({ path: path.join(outDir, '10-report-system-preview.png') }).then(() => path.join(outDir, '10-report-system-preview.png')));
  console.log('saved 10-report-system-preview');
  await systemPopup.close();

  await open(page, '/goods/list', '商品');
  await waitPacked(page, '管理打印模板', 1);
  await page.getByPlaceholder('商品名').first().fill(PRODUCT_NAME);
  await clickPacked(page, '查询', false);
  await page.getByText(PRODUCT_NAME).first().waitFor({ timeout: 15000 });
  await clickPacked(page, '管理打印模板', false);
  const goodsManage = page.getByRole('dialog', { name: '管理自定义打印模板' });
  await goodsManage.waitFor({ timeout: 15000 });
  await goodsManage.getByText('商品打印模板').waitFor();
  const goodsManageText = await goodsManage.innerText();
  if (goodsManageText.includes('报工记录打印模板')) throw new Error('商品管理壳混入了报工模板');
  shots.push(await shot(page, '11-goods-manage'));
  await closeTop(page);
  await clickRowButton(page, PRODUCT_NAME, '打印');
  const goodsPick = page.getByRole('dialog', { name: '打印商品' });
  await goodsPick.waitFor({ timeout: 15000 });
  await goodsPick.getByText('商品打印模板').waitFor();
  await goodsPick.getByText('系统模板').waitFor();
  await goodsPick.getByRole('button', { name: '打印', exact: true }).waitFor();
  await goodsPick.getByRole('radio').first().waitFor();
  const goodsFooter = await goodsPick.locator('.ant-modal-footer').innerText();
  if (!goodsFooter.replace(/\s+/g, '').includes('打印')) throw new Error('选模板弹窗没有打印按钮');
  await chooseTemplate(page, '商品打印模板');
  await waitOpaque(goodsPick);
  const goodsBox = await goodsPick.boundingBox();
  if (!goodsBox || goodsBox.height < 200) throw new Error(`选模板弹窗高度不够 ${goodsBox?.height ?? 0}`);
  shots.push(await shotDialog(goodsPick, '12-goods-picker'));
  const goodsPopupPromise = page.waitForEvent('popup');
  await clickPacked(page, '打印', true);
  const goodsPopup = await goodsPopupPromise;
  await goodsPopup.waitForSelector('h1');
  const goodsBody = await goodsPopup.locator('body').innerText();
  if (!goodsBody.includes('商品')) throw new Error(`商品预览缺少标题：${goodsBody.slice(0, 300)}`);
  if (!goodsBody.includes(PRODUCT_NAME)) throw new Error(`商品预览缺少商品名：${goodsBody.slice(0, 300)}`);
  if (!goodsBody.includes(PRODUCT_CODE)) throw new Error(`商品预览缺少编号：${goodsBody.slice(0, 300)}`);
  shots.push(await goodsPopup.screenshot({ path: path.join(outDir, '13-goods-preview.png') }).then(() => path.join(outDir, '13-goods-preview.png')));
  console.log('saved 13-goods-preview');
  await goodsPopup.close();

  await open(page, `/inside_produce_bill/detail/${data.order.id}?tab=wages`, '工资单');
  await page.getByRole('tab', { name: '工资单' }).click();
  await waitPacked(page, '管理工资单打印模板', 1);
  await waitPacked(page, '打印工资单', 1);
  await clickPacked(page, '管理工资单打印模板', false);
  const wageManage = page.getByRole('dialog', { name: '管理自定义打印模板' });
  await wageManage.waitFor({ timeout: 15000 });
  await wageManage.getByText('工资单打印模板').waitFor();
  if ((await wageManage.innerText()).includes('报工记录打印模板')) throw new Error('工资单壳混入了报工模板');
  shots.push(await shot(page, '14-wage-manage'));
  await closeTop(page);
  const wagePopupPromise = page.waitForEvent('popup');
  await clickPacked(page, '打印工资单', false);
  const wagePopup = await wagePopupPromise;
  await wagePopup.waitForSelector('h1');
  const wageBody = await wagePopup.locator('body').innerText();
  if (!wageBody.includes('工资单')) throw new Error(`工资单预览缺少标题：${wageBody.slice(0, 300)}`);
  if (!wageBody.includes(WO_CODE)) throw new Error(`工资单预览缺少加工单号：${wageBody.slice(0, 300)}`);
  shots.push(await wagePopup.screenshot({ path: path.join(outDir, '15-wage-preview.png') }).then(() => path.join(outDir, '15-wage-preview.png')));
  console.log('saved 15-wage-preview');
  await wagePopup.close();

  const others = [
    ['/sales_statement', '销售对账单', '管理打印模板', '销售对账单打印模板', '16-sales-manage'],
    ['/ProductionPlan/list', '生产计划', '管理打印模板', '生产计划打印模板', '17-plan-manage'],
    ['/purchase_stock_in_bill/list', '采购入库', '管理打印模板', '采购入库单打印模板', '18-purchase-in-manage'],
    ['/inside_produce_bill/list', '加工单', '导出/打印模板', '加工单打印模板', '19-wo-export-manage'],
    ['/device/list', '设备', '管理打印模板', '设备档案打印模板', '20-device-manage'],
    ['/OutWorkOrder/list', '外协', '管理打印模板', '外协工单打印模板', '21-outsource-manage'],
    ['/contract_quotation_bill/list', '报价', '管理打印模板', '合同报价单打印模板', '22-quote-manage'],
    ['/work_quality_testing/list', '全检', '管理打印模板', '全检打印模板', '23-qc-manage'],
  ];
  for (const [urlPath, waitText, button, templateName, file] of others) {
    await open(page, urlPath, waitText);
    await waitPacked(page, button, 1);
    if (await page.getByText('请从更多操作导出').count() !== 0) throw new Error(`${urlPath} 出现假导出提示`);
    await clickPacked(page, button, false);
    const dialog = page.getByRole('dialog', { name: '管理自定义打印模板' });
    await dialog.waitFor({ timeout: 15000 });
    await dialog.getByRole('button', { name: '创建模板' }).waitFor();
    await dialog.getByText(templateName).waitFor();
    await dialog.getByText('系统模板').waitFor();
    const text = await dialog.innerText();
    if (templateName !== '报工记录打印模板' && text.includes('报工记录打印模板')) throw new Error(`${urlPath} 壳没有按对象隔离`);
    shots.push(await shot(page, file));
    await closeTop(page);
  }
} finally {
  await browser.close();
}

const pngs = readdirSync(outDir).filter((name) => name.endsWith('.png')).sort();
const hashes = pngs.map((name) => createHash('md5').update(readFileSync(path.join(outDir, name))).digest('hex'));
const unique = new Set(hashes);
if (pngs.length < 12) throw new Error(`打开态截图 ${pngs.length} 张，不足 12`);
if (unique.size !== hashes.length) throw new Error(`MD5 重复 ${hashes.length - unique.size}`);
const record = [
  '# 第十二轮打印模板验收记录',
  '',
  `- 基线：含 f3d219a`,
  `- 脚本：scripts/round12-print-accept.mjs`,
  `- 加工单：${WO_CODE}`,
  `- 商品：${PRODUCT_CODE} ${PRODUCT_NAME}`,
  `- 自定义模板：${CUSTOM_NAME}`,
  `- 打开态截图 ${pngs.length} 张，MD5 互异 ${unique.size}`,
  '',
  ...pngs.map((name, index) => `- ${name} ${hashes[index]}`),
  '',
].join('\n');
writeFileSync(path.join(process.cwd(), 'docs/verification/round12-print/验收记录.md'), record);
console.log(record);
console.log('通过');
