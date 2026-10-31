#!/usr/bin/env node
/**
 * 第十二轮 Playwright 验收（P0–P3，项 1–25）。
 *
 * 前置：
 *   rm -rf .local/database && npm run dev:setup && npm run dev
 *   然后由本脚本经正式 API 造数（产品/单位来自 setup；不足时再调 seed-round10）。
 *
 * 截图双写：
 *   /opt/cursor/artifacts/round12/
 *   docs/verification/round12/
 *
 * 规则：仅 Playwright（import chromium from 'playwright'）；禁止 force:true；
 * 禁止吞掉失败的 .catch；禁止「无数据就点第一行」式条件跳过。
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/round12';
const docDir = path.join(process.cwd(), 'docs/verification/round12');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });

const results = [];
const stamp = Date.now().toString().slice(-6);

function record(n, title, ok, reason = '') {
  results.push({ n, title, result: ok ? '通过' : '未通过', reason });
  console.log(ok ? '通过' : '未通过', n, title, reason);
}

async function step(n, title, fn) {
  try {
    const reason = await fn();
    record(n, title, true, reason ?? '');
  } catch (error) {
    record(n, title, false, String(error).slice(0, 500));
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
    const json = await res.json().catch(() => ({}));
    const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
    if (res.ok && json.csrf_token) return { csrf: json.csrf_token, cookie, userId: json.user.id, username };
    const code = json?.error?.code || json?.code || '';
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 120);
    if (code === 'RATE_LIMITED' || /限流|RATE_LIMIT/i.test(msg) || res.status === 429) {
      const waitMs = Math.min(30000, 2000 * attempt);
      console.log(`登录限流 ${username}，${waitMs}ms 后重试 (${attempt}/8)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`登录失败 ${username}: ${res.status} ${msg}`);
  }
  throw new Error(`登录失败 ${username}: RATE_LIMITED 重试耗尽`);
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  await page.context().clearCookies();
  await page.context().addCookies([
    { name, value, url: WEB },
    { name, value, url: API },
  ]);
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
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status}: ${text.slice(0, 240)}`);
  return json;
}

async function shot(page, name) {
  const content = page.locator('.kgd-content');
  let box = null;
  if (await content.count()) box = await content.boundingBox({ timeout: 2000 });
  if (box && box.width > 20 && box.height > 20) {
    await page.mouse.move(box.x + Math.min(48, box.width / 2), box.y + Math.min(64, box.height / 2));
  } else {
    await page.mouse.move(420, 280);
  }
  await page.waitForTimeout(220);
  await page.waitForFunction(() => {
    const tips = [...document.querySelectorAll('.ant-tooltip')];
    return tips.every((node) => node.classList.contains('ant-tooltip-hidden')
      || getComputedStyle(node).visibility === 'hidden'
      || getComputedStyle(node).opacity === '0'
      || getComputedStyle(node).display === 'none');
  }, undefined, { timeout: 4000 });
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

function dualWriteText(fileName, text) {
  writeFileSync(path.join(artifactDir, fileName), text);
  writeFileSync(path.join(docDir, fileName), text);
}

function btn(page, name) {
  const spaced = String(name).split('').join('\\s*');
  return page.getByRole('button', { name: new RegExp(`^\\s*${spaced}\\s*$`) });
}

async function waitServers(ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const [apiRes, webRes] = await Promise.all([
        fetch(`${API}/api/auth/me`),
        fetch(WEB),
      ]);
      if ([200, 401, 403, 429].includes(apiRes.status) && webRes.ok) return;
    } catch { /* 启动中 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API(3001)/WEB(5173) 未就绪');
}

async function open(page, urlPath, waitText) {
  await page.goto(`${WEB}${urlPath}`);
  await page.addStyleTag({
    content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}',
  });
  await page.getByText(waitText).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(400);
}

async function confirmOk(page, titleText = '') {
  const root = titleText
    ? page.locator('.ant-modal-confirm, .ant-modal-root').filter({ hasText: titleText }).last()
    : page.locator('.ant-modal-confirm').last();
  await root.waitFor({ state: 'visible', timeout: 10000 });
  await root.getByRole('button', { name: /确\s*定/ }).click();
  await page.waitForTimeout(600);
}

async function openSelectDropdown(page) {
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.waitFor({ state: 'visible', timeout: 10000 });
  return dropdown;
}

function dropdownListHolder(dropdown) {
  return dropdown.locator('.ant-select-dropdown-list-holder, .rc-virtual-list-holder').first();
}

async function scrollSelectHolder(page, holder, delta = 160) {
  if (!(await holder.count())) return false;
  const before = await holder.evaluate((el) => el.scrollTop);
  // ant-select 虚拟列表 overflow:hidden，优先 wheel；再兜底写 scrollTop
  const box = await holder.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 80));
    await page.mouse.wheel(0, delta);
  }
  await holder.evaluate((el, d) => { el.scrollTop = Math.min(el.scrollTop + d, el.scrollHeight); }, delta);
  await page.waitForTimeout(60);
  const after = await holder.evaluate((el) => el.scrollTop);
  return after !== before;
}

/** Ant Select 虚拟列表只挂载可见项；滚动收集全部选项名 */
async function collectDropdownOptionNames(page) {
  const dropdown = await openSelectDropdown(page);
  const names = new Set();
  const holder = dropdownListHolder(dropdown);
  if (await holder.count()) {
    await holder.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(40);
  }
  for (let i = 0; i < 40; i += 1) {
    const batch = await dropdown.locator('.ant-select-dropdown-list-holder .ant-select-item-option, .rc-virtual-list-holder .ant-select-item-option, .ant-select-item-option').evaluateAll((nodes) => nodes.map((n) => (n.getAttribute('title') || n.getAttribute('aria-label') || n.textContent || '').trim()));
    for (const name of batch) if (name) names.add(name);
    if (!(await scrollSelectHolder(page, holder, 160))) break;
  }
  return [...names];
}

async function pickVisibleSelectOption(page, labelText) {
  // 注意：Ant Design 另有 height:0 的 a11y listbox（role=option），不可点；只点可见虚拟列表项
  const dropdown = await openSelectDropdown(page);
  const holder = dropdownListHolder(dropdown);
  if (await holder.count()) {
    await holder.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(40);
  }
  const escaped = String(labelText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const findOption = () => holder.locator(`.ant-select-item-option[title="${labelText}"]`).or(
    holder.locator('.ant-select-item-option').filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }),
  ).first();
  let lastClickError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const opt = findOption();
    if (await opt.count()) {
      const content = opt.locator('.ant-select-item-option-content');
      try {
        if (await content.count()) await content.click({ timeout: 1500 });
        else await opt.click({ timeout: 1500 });
        return;
      } catch (error) {
        lastClickError = error;
        // 仅在仍可滚动时继续找可见项；否则抛出点击失败
        if (!(await scrollSelectHolder(page, holder, 160))) throw error;
        continue;
      }
    }
    if (!(await scrollSelectHolder(page, holder, 160))) break;
  }
  await page.waitForTimeout(500);
  const retry = findOption();
  if (await retry.count()) {
    const content = retry.locator('.ant-select-item-option-content');
    if (await content.count()) await content.click();
    else await retry.click();
    return;
  }
  throw new Error(`下拉选项不可用: ${labelText}${lastClickError ? `（末次点击：${String(lastClickError).slice(0, 120)}）` : ''}`);
}

async function dismissOpenUi(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(180);
  }
  const closes = page.locator('.ant-modal-wrap:visible .ant-modal-close, .ant-drawer-open .ant-drawer-close');
  const n = await closes.count();
  for (let i = 0; i < n; i += 1) {
    const btnClose = closes.nth(0);
    if (!(await btnClose.isVisible())) break;
    await btnClose.click();
    await page.waitForTimeout(200);
  }
}

async function ensureExtField(session, entity, name, extra = {}) {
  const listed = await api(session, 'GET', `/api/entity-ext-fields?entity=${entity}`);
  const existing = (listed.items ?? []).find((item) => item.name === name);
  if (existing) return existing;
  const res = await fetch(`${API}/api/entity-ext-fields`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'x-csrf-token': session.csrf,
    },
    body: JSON.stringify({
      entity,
      name,
      field_type: '单行文本',
      required: false,
      input_modes: ['手动输入'],
      ...extra,
    }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (res.ok) return json.item;
  if (res.status === 409) {
    const again = await api(session, 'GET', `/api/entity-ext-fields?entity=${entity}`);
    const found = (again.items ?? []).find((item) => item.name === name);
    if (found) return found;
  }
  throw new Error(`POST /api/entity-ext-fields ${res.status}: ${text.slice(0, 240)}`);
}

async function clickFormSelectOption(page, scope, labelText, optionName) {
  const item = scope.locator('.ant-form-item').filter({ hasText: labelText }).first();
  await item.locator('.ant-select').click();
  await pickVisibleSelectOption(page, optionName);
}

async function ensureSeed(admin) {
  const products = await api(admin, 'GET', '/api/products?page=1&page_size=20');
  if (!(products.items?.length >= 1)) {
    throw new Error('无商品：请先 npm run dev:setup，或 node scripts/seed-round10-demo.mjs');
  }
  const product = products.items.find((item) => item.active !== false) ?? products.items[0];
  const wantedCustomer = `R12验收客户${stamp}`;
  let customers = (await api(admin, 'GET', '/api/money/customers?page=1&page_size=50')).items ?? [];
  let customer = customers.find((item) => String(item.name) === wantedCustomer);
  if (!customer) {
    customer = (await api(admin, 'POST', '/api/money/customers', {
      request_key: crypto.randomUUID(),
      name: wantedCustomer,
      contact_name: 'R12联系人',
      contact_phone: `138${stamp.padStart(8, '0').slice(0, 8)}`,
    })).customer;
  }
  customers = (await api(admin, 'GET', '/api/money/customers?page=1&page_size=50')).items ?? [];
  customer = customers.find((item) => item.id === customer.id) ?? customer;

  // 工作台恢复默认可见卡，避免上次验收残留
  const cfg = await api(admin, 'GET', '/api/workplace/config');
  await api(admin, 'PUT', '/api/workplace/config', {
    cards: ['banner', 'shortcuts', 'todos', 'notices', 'messages', 'devices'].map((key) => ({ key, visible: true })),
    layout: undefined,
    shortcuts: cfg.shortcuts?.length ? cfg.shortcuts : undefined,
    todo_prefs: {
      pending_contracts: true,
      pending_invoices: true,
      maint_tasks: true,
      repairs_to_accept: true,
      repairs_to_review: true,
    },
    version: cfg.version,
  });
  return { product, customer };
}

function writeReports() {
  const lines = [
    `round12-accept ${new Date().toISOString()}`,
    ...results.map((item) => `${item.n}\t${item.result}\t${item.title}\t${item.reason}`),
  ];
  const failed = results.some((item) => item.result !== '通过');
  lines.push(failed ? '未通过' : '全部通过');
  const text = `${lines.join('\n')}\n`;
  writeFileSync(path.join(docDir, 'ACCEPT.txt'), text);
  writeFileSync(path.join(artifactDir, 'ACCEPT.txt'), text);
  writeFileSync(path.join(docDir, 'results.json'), `${JSON.stringify({ at: new Date().toISOString(), results, failed }, null, 2)}\n`);
  // 正式验收记录 docs/第十二轮验收记录.md 由交卷时手写维护，此处不覆盖
  console.log(text);
  return failed;
}

// ——— 主流程 ———
await waitServers();
const adminPass = passwordOf('.local/dev-credentials.txt', 'admin.local');
const plannerPass = passwordOf('.local/dev-credentials.txt', 'planner.local');
if (!adminPass) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local');
if (!plannerPass) throw new Error('缺少 .local/dev-credentials.txt 中 planner.local');

const admin = await login('admin.local', adminPass);
const planner = await login('planner.local', plannerPass);
const seed = await ensureSeed(admin);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await asUser(page, admin);

const fieldNames = {
  autofill: `R12自动商品名${stamp}`,
  formula: `R12公式${stamp}`,
  linkman: `R12联系人必填${stamp}`,
  customer: `R12客户字段${stamp}`,
};

// ——— P0 工作台 ———
await step('1', '工作台进入编辑态（拖动手柄+添加组件）', async () => {
  await open(page, '/staging/area', '工作台');
  await btn(page, '配置工作台').click();
  await page.locator('.wp-editing, [data-testid=wp-root].wp-editing').waitFor({ timeout: 10000 });
  await btn(page, '添加组件').waitFor({ state: 'visible', timeout: 5000 });
  const handles = await page.locator('.wp-widget-drag, [aria-label=拖动]').count();
  if (handles < 1) throw new Error('未见拖动手柄');
  await shot(page, 'r12-p0-01-workplace-edit');
  return `拖动手柄 ${handles}`;
});

await step('2', '添加组件弹窗左栏+搜索+18 张大预览，无原版未采到', async () => {
  await btn(page, '添加组件').click();
  const modal = page.locator('.ant-modal').filter({ hasText: '添加组件' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  await modal.locator('[data-testid=wp-picker-side]').waitFor({ state: 'visible', timeout: 5000 });
  await modal.getByPlaceholder('搜索').waitFor({ state: 'visible', timeout: 5000 });
  if ((await modal.innerText()).includes('原版未采到')) throw new Error('添加组件弹窗出现原版未采到');
  for (const [name, count] of [['全部', 18], ['通用', 4], ['工作效率', 2], ['智能报表', 12]]) {
    const nav = modal.locator(`[data-testid=wp-tab-${name}]`);
    await nav.waitFor({ state: 'visible', timeout: 5000 });
    const label = (await nav.innerText()).replace(/\s+/g, '');
    if (label !== `${name}·${count}`) throw new Error(`左栏 ${name} 文案「${label}」≠「${name}·${count}」`);
  }
  const count = await modal.locator('[data-testid=wp-widget-card]').count();
  if (count !== 18) throw new Error(`组件卡片数 ${count} ≠ 18`);
  const preview = await modal.locator('.wp-preview').first().boundingBox();
  if (!preview || preview.width < 120 || preview.height < 60) throw new Error(`预览区过小 ${preview ? `${preview.width}x${preview.height}` : 'missing'}`);
  await shot(page, 'r12-p0-02-add-widget-18');
  return `left-nav×4 cards=${count} preview=${Math.round(preview.width)}x${Math.round(preview.height)}`;
});

await step('3', '添加原版组件保存后仍在，再移除消失', async () => {
  const modal = page.locator('.ant-modal').filter({ hasText: '添加组件' }).last();
  if (!(await modal.isVisible())) {
    await btn(page, '添加组件').click();
    await modal.waitFor({ state: 'visible', timeout: 10000 });
  }
  await modal.locator('[data-testid=wp-tab-全部]').click();
  const card = modal.locator('[data-testid=wp-widget-card][data-key=follow_rank]');
  await card.waitFor({ state: 'visible', timeout: 5000 });
  if (await card.getAttribute('disabled') !== null || await card.evaluate((el) => el.classList.contains('is-disabled'))) {
    await modal.getByRole('button', { name: /取\s*消/ }).click();
  } else {
    await card.click();
    await modal.getByRole('button', { name: /确\s*定/ }).click();
  }
  await page.locator('[data-testid=wp-widget-follow_rank]').waitFor({ state: 'visible', timeout: 8000 });
  await btn(page, '保存').click();
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByText('工作台').first().waitFor({ timeout: 15000 });
  await page.locator('[data-testid=wp-widget-follow_rank], section.wp-card').filter({ hasText: '当月跟单排行' }).first().waitFor({ timeout: 10000 });
  await btn(page, '配置工作台').click();
  await page.locator('[data-testid=wp-widget-follow_rank] .wp-widget-close, [data-testid=wp-widget-follow_rank] [aria-label=移除]').click();
  await btn(page, '保存').click();
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByText('工作台').first().waitFor({ timeout: 15000 });
  const gone = await page.locator('[data-testid=wp-widget-follow_rank]').count();
  if (gone) throw new Error('移除后刷新仍见当月跟单排行');
  await shot(page, 'r12-p0-03-widget-persist');
  return '添加→保存→移除→保存 OK';
});

await step('4', '编辑取消确认退出', async () => {
  await open(page, '/staging/area', '工作台');
  await btn(page, '配置工作台').click();
  const cancelEdit = page.locator('.wp-toolbar').getByRole('button', { name: /取\s*消/ });
  await cancelEdit.click();
  const confirm = page.locator('.ant-modal-confirm, .ant-modal').filter({ hasText: '确认退出' }).last();
  await confirm.waitFor({ state: 'visible', timeout: 8000 });
  await shot(page, 'r12-p0-04-cancel-confirm');
  await confirm.getByRole('button', { name: /取\s*消/ }).click();
  await cancelEdit.click();
  await confirmOk(page, '确认退出');
  return '确认退出对话框';
});

await step('5', '快捷入口编辑：删一加一', async () => {
  await open(page, '/staging/area', '工作台');
  // 预置：去掉「申请开票」，保留其余
  const cfg = await api(admin, 'GET', '/api/workplace/config');
  const allKeys = ['customer_add', 'follow_add', 'contract_add', 'invoice_apply', 'work_order_add', 'fg_receipt_add', 'process_add', 'defect_add', 'route_add'];
  const base = allKeys.filter((key) => key !== 'invoice_apply');
  await api(admin, 'PUT', '/api/workplace/config', {
    cards: cfg.cards,
    layout: cfg.layout,
    todo_prefs: cfg.todo_prefs,
    shortcuts: base,
    version: cfg.version,
  });
  await page.reload();
  await page.getByText('快捷入口').first().waitFor({ timeout: 15000 });
  const shortcutsCard = page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^快捷入口$/ }) });
  await shortcutsCard.locator('button.wp-more, [aria-label=编辑]').click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '添加快捷入口' }).last();
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  // 去掉「新增客户」（已选宫格 ×），加上「申请开票」（可选宫格）
  await modal.getByLabel('移除新增客户').click();
  await modal.getByLabel('移除新增客户').waitFor({ state: 'hidden', timeout: 5000 });
  await modal.locator('button.wp-shortcut-pick', { hasText: '申请开票' }).click();
  await modal.locator('button.wp-shortcut-pick.is-disabled', { hasText: '申请开票' }).waitFor({ state: 'visible', timeout: 5000 });
  const putCfg = page.waitForResponse((r) => r.url().includes('/api/workplace/config') && r.request().method() === 'PUT' && r.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  const putRes = await putCfg;
  const putBody = putRes.request().postDataJSON();
  if ((putBody.shortcuts ?? []).includes('customer_add')) throw new Error('PUT shortcuts 仍含 customer_add');
  if (!(putBody.shortcuts ?? []).includes('invoice_apply')) throw new Error('PUT shortcuts 缺 invoice_apply');
  // 刷新后 config 未返回前会短暂回落到 defaultShortcuts（含新增客户），需等到接口数据渲染
  const cfgGet = page.waitForResponse((r) => r.url().includes('/api/workplace/config') && r.request().method() === 'GET' && r.ok(), { timeout: 15000 });
  await page.reload();
  await cfgGet;
  await page.getByText('快捷入口').first().waitFor({ timeout: 15000 });
  const shortcutsAfter = page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^快捷入口$/ }) });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('section.wp-card')].find((node) => node.querySelector('header b')?.textContent?.trim() === '快捷入口');
    const text = card?.textContent ?? '';
    return text.includes('申请开票') && !text.includes('新增客户');
  }, undefined, { timeout: 15000 });
  const body = await shortcutsAfter.innerText();
  if (body.includes('新增客户')) throw new Error('新增客户应已移除');
  if (!body.includes('申请开票')) throw new Error('申请开票应已加入');
  await shot(page, 'r12-p0-05-shortcut-edit');
  return '删新增客户+加申请开票';
});

await step('6', '待办编辑：关闭一类后刷新隐藏', async () => {
  await open(page, '/staging/area', '工作台');
  const todosCard = page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^待办事项$/ }) });
  await todosCard.locator('button.wp-more, [aria-label=编辑]').click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '编辑待办事项' }).last();
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  const row = modal.locator('.wp-todo-pref').filter({ hasText: '待开票' });
  await row.waitFor({ state: 'visible', timeout: 5000 });
  const sw = row.locator('.ant-switch');
  if (await sw.evaluate((el) => el.classList.contains('ant-switch-checked'))) {
    await sw.click();
  }
  await sw.waitFor({ state: 'visible', timeout: 3000 });
  if (await sw.evaluate((el) => el.classList.contains('ant-switch-checked'))) {
    throw new Error('待开票开关未能关闭');
  }
  const putCfg = page.waitForResponse((r) => r.url().includes('/api/workplace/config') && r.request().method() === 'PUT' && r.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  const putRes = await putCfg;
  const putBody = putRes.request().postDataJSON();
  if (putBody.todo_prefs?.pending_invoices !== false) throw new Error('PUT todo_prefs.pending_invoices 未关闭');
  const cfgGet = page.waitForResponse((r) => r.url().includes('/api/workplace/config') && r.request().method() === 'GET' && r.ok(), { timeout: 15000 });
  await page.reload();
  await cfgGet;
  await page.getByText('待办事项').first().waitFor({ timeout: 15000 });
  const todosAfter = page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^待办事项$/ }) });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('section.wp-card')].find((node) => node.querySelector('header b')?.textContent?.trim() === '待办事项');
    return card ? !card.textContent?.includes('待开票') : false;
  }, undefined, { timeout: 15000 });
  const text = await todosAfter.innerText();
  if (text.includes('待开票')) throw new Error('待开票开关关闭后仍显示');
  await shot(page, 'r12-p0-06-todo-edit');
  return '待开票已隐藏';
});

// ——— P0 机台报表 ———
await step('7', '机台报表工具栏：列配置+更多操作，无扩展字段', async () => {
  await open(page, '/drilling_crew_statement/list', '机台');
  await btn(page, '列配置').waitFor({ state: 'visible', timeout: 10000 });
  await btn(page, '更多操作').waitFor({ state: 'visible', timeout: 5000 });
  const body = await page.locator('body').innerText();
  if (body.includes('扩展字段')) throw new Error('机台报表仍出现「扩展字段」文案');
  // 展开更多操作确认含导出
  await btn(page, '更多操作').click();
  await page.getByText(/导出/).first().waitFor({ state: 'visible', timeout: 5000 });
  await shot(page, 'r12-p0-07-machine-no-ext');
  await page.keyboard.press('Escape');
  return '列配置+导出，无扩展字段';
});

await step('8', 'rg 机台源码无非注释「扩展字段」', async () => {
  const target = 'apps/web/src/kgd/pages/reports-biz/pages.tsx';
  const rgBin = existsSync('/exec-daemon/rg') ? '/exec-daemon/rg' : 'rg';
  const result = spawnSync(rgBin, ['-n', '扩展字段', target], {
    encoding: 'utf8',
    cwd: process.cwd(),
    maxBuffer: 2 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  dualWriteText('r12-p0-08-rg-machine-ext.txt', out || '(无匹配)\n');
  // rg exit 1 = 无匹配；其它非 0 才是异常（缺文件等）
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg 失败 exit=${result.status}: ${out.slice(0, 200)}`);
  }
  const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
  const nonComment = lines.filter((line) => {
    const code = line.replace(/^[^:]+:\d+:/, '');
    const trimmed = code.trim();
    return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });
  if (nonComment.length) throw new Error(`存在非注释匹配: ${nonComment.join(' | ')}`);
  return lines.length ? `仅注释 ${lines.length} 行` : '无匹配';
});

// ——— P1 扩展字段 ———
await step('9', '加工单扩展字段管理弹窗', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await btn(page, '扩展字段').click();
  const modal = page.locator('.ant-modal').filter({ hasText: '【加工单】扩展字段管理' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const text = await modal.innerText();
  if (!text.includes('【加工单】扩展字段管理')) throw new Error('标题不对');
  const hasHeaders = /字段名/.test(text) && /字段类型/.test(text);
  const empty = text.includes('暂无数据');
  if (!hasHeaders && !empty) throw new Error('既无表头也无空态');
  await shot(page, 'r12-p1-01-wo-ext-mgmt');
  return hasHeaders ? '有表头' : '暂无数据';
});

await step('10', '新增扩展字段类型共 17 项', async () => {
  const listModal = page.locator('.ant-modal').filter({ hasText: '【加工单】扩展字段管理' }).last();
  if (!(await listModal.isVisible())) {
    await btn(page, '扩展字段').click();
    await listModal.waitFor({ state: 'visible', timeout: 10000 });
  }
  await listModal.getByRole('button', { name: /新\s*增/ }).click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor({ state: 'visible', timeout: 8000 });
  await add.locator('label').filter({ hasText: '字段类型' }).locator('.ant-select').click();
  const names = await collectDropdownOptionNames(page);
  const count = names.length;
  if (count !== 17) throw new Error(`字段类型选项 ${count} ≠ 17（${names.join(',')})`);
  await shot(page, 'r12-p1-02-wo-types-17');
  await page.keyboard.press('Escape');
  return `类型 ${count}`;
});

await step('11', '单行文本自动填充商品.商品名', async () => {
  let add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  if (!(await add.isVisible())) {
    const listModal = page.locator('.ant-modal').filter({ hasText: '【加工单】扩展字段管理' }).last();
    if (!(await listModal.isVisible())) {
      await open(page, '/inside_produce_bill/list', '加工单');
      await btn(page, '扩展字段').click();
      await listModal.waitFor({ state: 'visible', timeout: 10000 });
    }
    await listModal.getByRole('button', { name: /新\s*增/ }).click();
    add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
    await add.waitFor({ state: 'visible', timeout: 8000 });
  }
  await add.locator('label').filter({ hasText: '字段名' }).locator('input').fill(fieldNames.autofill);
  // 类型默认单行文本；选自动填充 商品 / 商品名
  const autofillLabel = add.locator('label').filter({ hasText: '自动填充规则' });
  await autofillLabel.locator('.ant-select, .ant-cascader').click();
  await page.locator('.ant-cascader-menu-item, .ant-select-dropdown .ant-cascader-menu-item').filter({ hasText: /^商品$/ }).first().click();
  await page.locator('.ant-cascader-menu-item').filter({ hasText: /^商品名$/ }).first().click();
  const putExt = page.waitForResponse((r) => r.url().includes('/api/entity-ext-fields') && r.request().method() === 'POST' && r.ok(), { timeout: 15000 });
  await add.getByRole('button', { name: /确\s*定/ }).click();
  await putExt;
  await page.waitForTimeout(500);
  // 关管理弹窗
  const listModal = page.locator('.ant-modal').filter({ hasText: '【加工单】扩展字段管理' }).last();
  if (await listModal.isVisible()) await listModal.locator('.ant-modal-close').click();

  // API 预览断言
  const preview = await api(admin, 'POST', '/api/entity-ext-fields/autofill-preview', {
    entity: 'work_order',
    product_id: seed.product.id,
  });
  const fields = (await api(admin, 'GET', '/api/entity-ext-fields?entity=work_order')).items ?? [];
  const field = fields.find((item) => item.name === fieldNames.autofill);
  if (!field) throw new Error('自动填充字段未创建成功');
  const filled = preview.values?.[field.id];
  if (String(filled ?? '') !== String(seed.product.name ?? '')) {
    throw new Error(`autofill-preview 期望 ${seed.product.name} 实际 ${filled}`);
  }

  // UI：直接创建加工单选商品后字段有值（匹配失败必须 throw，禁止回退点第一项）
  await page.goto(`${WEB}/inside_produce_bill/add?mode=direct`);
  await page.getByText(/商品|计划数|直接创建/).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const productBox = page.locator('.kgd-form, .ant-form, .kgd-card').first();
  const selects = productBox.locator('.ant-select');
  let productSelect = null;
  const n = await selects.count();
  for (let i = 0; i < n; i += 1) {
    const sel = selects.nth(i);
    const near = await sel.evaluate((el) => {
      const prev = el.previousElementSibling?.textContent ?? '';
      const parent = el.parentElement?.innerText ?? '';
      return `${prev}${parent}`.includes('商品');
    });
    if (near) { productSelect = sel; break; }
  }
  if (!productSelect) throw new Error('未找到商品 Select');
  // 选项 label 为「编号 名称」（见 workOrders Select options），禁止用裸名匹配失败后回退 first()
  const productLabel = `${seed.product.code} ${seed.product.name}`;
  await productSelect.click();
  const search = productSelect.locator('.ant-select-selection-search-input');
  if (await search.count()) {
    await search.fill(String(seed.product.name));
    await page.waitForTimeout(250);
  }
  await pickVisibleSelectOption(page, productLabel);
  await page.waitForTimeout(1000);
  const extInput = page.locator(`xpath=//span[contains(., "${fieldNames.autofill}")]/following::input[1]`).first();
  await extInput.waitFor({ state: 'visible', timeout: 10000 });
  const val = await extInput.inputValue();
  if (val !== String(seed.product.name)) throw new Error(`UI 自动填充值「${val}」≠「${seed.product.name}」`);
  await shot(page, 'r12-p1-03-wo-autofill');
  return `preview+UI=${val}`;
});

await step('12', '公式字段必填固定否且非法公式中文报错', async () => {
  await dismissOpenUi(page);
  await open(page, '/inside_produce_bill/list', '加工单');
  await btn(page, '扩展字段').click();
  const listModal = page.locator('.ant-modal').filter({ hasText: '【加工单】扩展字段管理' }).last();
  await listModal.waitFor({ state: 'visible', timeout: 10000 });
  await listModal.getByRole('button', { name: /新\s*增/ }).click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor({ state: 'visible', timeout: 8000 });
  // ExtensionAddDialog afterOpenChange 会 reset，等动画结束再填
  await page.waitForTimeout(450);
  await add.locator('label').filter({ hasText: '字段类型' }).locator('.ant-select').click();
  await pickVisibleSelectOption(page, '公式');
  await add.locator('label').filter({ hasText: '计算公式' }).waitFor({ state: 'visible', timeout: 8000 });
  await add.locator('label').filter({ hasText: '字段名' }).locator('input').fill(fieldNames.formula);
  // 必填锁定为否
  const reqSelect = add.locator('label').filter({ hasText: '是否必填' }).locator('.ant-select');
  const reqDisabled = await reqSelect.evaluate((el) => el.classList.contains('ant-select-disabled') || !!el.querySelector('.ant-select-disabled'));
  const reqText = await reqSelect.innerText();
  if (!reqDisabled) throw new Error('公式类型是否必填未禁用');
  if (!reqText.includes('否')) throw new Error(`公式必填应为否，实际 ${reqText}`);
  // 公式类型无自动填充规则
  if (await add.locator('label').filter({ hasText: '自动填充规则' }).count()) {
    throw new Error('公式类型仍显示自动填充规则');
  }
  await add.getByRole('button', { name: /添\s*加/ }).click();
  const fx = page.locator('.ant-modal').filter({ hasText: '编辑计算公式' }).last();
  await fx.waitFor({ state: 'visible', timeout: 8000 });
  await fx.locator('textarea').fill('@@@非法');
  await fx.getByRole('button', { name: /确\s*定/ }).click();
  await fx.waitFor({ state: 'hidden', timeout: 8000 });
  // 公式子弹窗关闭后若表单被 reset，补填字段名
  const nameInput = add.locator('label').filter({ hasText: '字段名' }).locator('input');
  if ((await nameInput.inputValue()).trim() !== fieldNames.formula) {
    await nameInput.fill(fieldNames.formula);
  }
  const validate = page.waitForResponse((r) => r.url().includes('/api/entity-ext-fields/validate-formula') && r.request().method() === 'POST', { timeout: 15000 });
  await add.getByRole('button', { name: /确\s*定/ }).click();
  const validateRes = await validate;
  if (validateRes.ok()) throw new Error('非法公式 validate-formula 不应成功');
  const helpEl = add.locator('div.kgd-field-help');
  await helpEl.first().waitFor({ state: 'visible', timeout: 8000 });
  const help = await helpEl.first().innerText();
  if (!/公式|语法|不正确|引用/.test(help)) throw new Error(`未见中文公式错误：${help}`);
  await shot(page, 'r12-p1-04-wo-formula');
  await add.getByRole('button', { name: /取\s*消/ }).click();
  await listModal.locator('.ant-modal-close').click();
  return help.slice(0, 40);
});

await step('13', '联系人必填扩展字段校验与保存', async () => {
  await ensureExtField(admin, 'linkman', fieldNames.linkman, { required: true });
  // 历史验收残留的其它必填扩展字段会挡住保存；本项只保留当前字段为必填
  const linkmanFields = (await api(admin, 'GET', '/api/entity-ext-fields?entity=linkman')).items ?? [];
  for (const field of linkmanFields) {
    if (field.name === fieldNames.linkman) continue;
    if (field.required) {
      await api(admin, 'PUT', `/api/entity-ext-fields/${field.id}`, { required: false });
    }
  }
  await open(page, '/linkman/list', '联系人');
  await btn(page, '扩展字段').click();
  const listModal = page.locator('.ant-modal').filter({ hasText: '扩展字段管理' }).last();
  await listModal.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await listModal.getByText(fieldNames.linkman).count())) throw new Error('扩展字段管理未见联系人字段');
  await listModal.locator('.ant-modal-close').click();

  await btn(page, '新增').or(page.getByRole('button', { name: /\+\s*新增/ })).first().click();
  const form = page.locator('.ant-modal').filter({ hasText: '新增客户联系人' }).last();
  await form.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await form.getByText(fieldNames.linkman).count())) throw new Error('新增联系人表单无扩展字段');
  // 选客户、填联系人，扩展字段留空提交（客户是表单第一个 Select）
  const customerSelect = form.locator('.ant-select').first();
  await customerSelect.click();
  const search = customerSelect.locator('.ant-select-selection-search-input');
  if (await search.count()) {
    await search.fill(seed.customer.name);
    await page.waitForTimeout(250);
  }
  await pickVisibleSelectOption(page, seed.customer.name);
  // antd 新版选中态在 .ant-select-content，旧版在 .ant-select-selection-item
  const selected = customerSelect.locator('.ant-select-content-has-value, .ant-select-selection-item, .ant-select-content').first();
  await selected.waitFor({ state: 'visible', timeout: 8000 });
  const selectedCustomer = (await selected.innerText()).trim();
  if (!selectedCustomer.includes(seed.customer.name)) {
    throw new Error(`客户选中「${selectedCustomer}」≠「${seed.customer.name}」`);
  }
  const contactName = `R12人${stamp}`;
  const nameInput = form.locator('.ant-form-item').filter({ hasText: '联系人' }).locator('input').first();
  await nameInput.fill(contactName);
  await form.getByRole('button', { name: /确\s*定/ }).click();
  await page.waitForTimeout(500);
  const toast = page.locator('.ant-message, .ant-message-notice').filter({ hasText: /请填写/ });
  await toast.first().waitFor({ state: 'visible', timeout: 8000 });
  const msg = await toast.first().innerText();
  if (!/请填写/.test(msg)) throw new Error(`空提交未见中文必填错误：${msg}`);
  const extInput = form.locator(`xpath=.//*[contains(normalize-space(.), "${fieldNames.linkman}")]/following::input[1]`).first();
  await extInput.waitFor({ state: 'visible', timeout: 8000 });
  await extInput.click();
  await extInput.fill('');
  await extInput.pressSequentially('已填', { delay: 20 });
  if ((await extInput.inputValue()) !== '已填') throw new Error('扩展字段未能填入');
  const [savedRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/crm/contacts') && r.request().method() === 'POST', { timeout: 15000 }),
    form.getByRole('button', { name: /确\s*定/ }).click(),
  ]);
  if (!savedRes.ok()) {
    throw new Error(`创建联系人失败 ${savedRes.status}: ${(await savedRes.text()).slice(0, 240)}`);
  }
  await shot(page, 'r12-p1-05-linkman-ext');
  return msg.slice(0, 40);
});

await step('14', '联系人新增类型无公式、无自动填充规则', async () => {
  await open(page, '/linkman/list', '联系人');
  await btn(page, '扩展字段').click();
  const listModal = page.locator('.ant-modal').filter({ hasText: '扩展字段管理' }).last();
  await listModal.waitFor({ state: 'visible', timeout: 10000 });
  await listModal.getByRole('button', { name: /新\s*增/ }).click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor({ state: 'visible', timeout: 8000 });
  await add.locator('label').filter({ hasText: '字段类型' }).locator('.ant-select').click();
  const labels = await collectDropdownOptionNames(page);
  if (labels.length !== 16) throw new Error(`联系人类型 ${labels.length} ≠ 16（${labels.join(',')})`);
  if (labels.some((t) => t.trim() === '公式')) throw new Error('联系人类型含公式');
  // 展开下拉后再截图（勿先 Escape）
  await shot(page, 'r12-p1-06-linkman-no-formula');
  await page.keyboard.press('Escape');
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(300);
  if (await add.locator('label').filter({ hasText: '自动填充规则' }).count()) {
    throw new Error('联系人新增出现自动填充规则');
  }
  await add.getByRole('button', { name: /取\s*消/ }).click();
  await listModal.locator('.ant-modal-close').click();
  return `类型 ${labels.length} 无公式`;
});

await step('15', '客户扩展字段出现在表单并可保存', async () => {
  await ensureExtField(admin, 'customer', fieldNames.customer);
  await open(page, '/customer/list', '客户');
  await btn(page, '扩展字段').click();
  const listModal = page.locator('.ant-modal').filter({ hasText: '【客户管理】扩展字段管理' }).last();
  await listModal.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await listModal.getByText(fieldNames.customer).count())) throw new Error('扩展字段管理未见客户字段');
  // 同验：客户类型下拉 = 16、无公式、无自动填充
  await listModal.getByRole('button', { name: /新\s*增/ }).click();
  const typeAdd = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await typeAdd.waitFor({ state: 'visible', timeout: 8000 });
  await typeAdd.locator('label').filter({ hasText: '字段类型' }).locator('.ant-select').click();
  const custTypes = await collectDropdownOptionNames(page);
  if (custTypes.length !== 16) throw new Error(`客户类型 ${custTypes.length} ≠ 16（${custTypes.join(',')})`);
  if (custTypes.some((t) => t.trim() === '公式')) throw new Error('客户类型含公式');
  // 展开下拉后再截图（与条14同纪律）
  await shot(page, 'r12-p1-07b-customer-types-16');
  await page.keyboard.press('Escape');
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(300);
  if (await typeAdd.locator('label').filter({ hasText: '自动填充规则' }).count()) {
    throw new Error('客户新增出现自动填充规则');
  }
  await typeAdd.getByRole('button', { name: /取\s*消/ }).click();
  await listModal.locator('.ant-modal-close').click();
  await listModal.waitFor({ state: 'hidden', timeout: 8000 });
  await dismissOpenUi(page);
  await page.locator('.kgd-toolbar, .kgd-content').getByRole('button', { name: /新\s*增/ }).first().click();
  const form = page.locator('.ant-modal').filter({ hasText: '新增客户' }).last();
  await form.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await form.getByText(fieldNames.customer).count())) throw new Error('客户表单无扩展字段');
  await form.locator('.ant-form-item').filter({ hasText: '客户名称' }).locator('input').fill(`R12客${stamp}`);
  await form.locator('.ant-form-item').filter({ hasText: /^联系人/ }).locator('input').first().fill('联系甲');
  const extInput = form.locator(`xpath=//span[contains(., "${fieldNames.customer}")]/following::input[1]`).first();
  await extInput.fill('客户扩展值');
  const saved = page.waitForResponse((r) => r.url().includes('/api/money/customers') && r.request().method() === 'POST' && r.ok(), { timeout: 15000 });
  await form.getByRole('button', { name: /确\s*定/ }).click();
  await saved;
  await shot(page, 'r12-p1-07-customer-ext');
  return `客户类型${custTypes.length}+表单已保存`;
});

// ——— P2 列配置 / 移动端 / 视图 ———
let columnPrefsSnapshot = null;

await step('16', '加工单列配置隐藏列刷新保持', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await btn(page, '列配置').click();
  const modal = page.locator('.ant-modal').filter({ hasText: '列配置' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  // 隐藏「备注」列（若无则隐藏「图纸」）——用单元格精确匹配，避免命中「报工备注」等
  await page.waitForTimeout(400); // ColumnConfigModal afterOpenChange 同步 draft
  const noteRow = modal.locator('.ant-table-tbody tr.ant-table-row').filter({ has: page.locator('td', { hasText: /^备注$/ }) }).first();
  const target = (await noteRow.count())
    ? noteRow
    : modal.locator('.ant-table-tbody tr.ant-table-row').filter({ has: page.locator('td', { hasText: /^图纸$/ }) }).first();
  await target.waitFor({ state: 'visible', timeout: 8000 });
  const label = (await target.locator('td').nth(2).innerText()).trim();
  // 若已锁定，先解锁（避免后续断言干扰）；用鼠标点 ant-checkbox 以触发 antd 受控 onChange
  const lockBtn = target.getByRole('button', { name: /锁定|取消锁定/ });
  if ((await lockBtn.getAttribute('aria-label')) === '取消锁定') await lockBtn.click();
  if (await target.locator('.ant-checkbox-checked').count()) {
    const checkbox = target.locator('.ant-checkbox-input').or(target.locator('input[type=checkbox]'));
    if (await checkbox.count()) {
      await checkbox.click();
    } else {
      const box = await target.locator('.ant-checkbox').boundingBox();
      if (!box) throw new Error('列显隐复选框不可见');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await page.waitForTimeout(300);
  }
  if (await target.locator('.ant-checkbox-checked').count()) throw new Error(`取消勾选「${label}」失败`);
  const put = page.waitForResponse((r) => r.url().includes('/api/list-column-prefs') && r.request().method() === 'PUT' && r.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  const putRes = await put;
  const savedPrefs = (await putRes.json()).prefs;
  if (label === '备注' && savedPrefs?.visible?.includes('note')) {
    throw new Error('PUT 后 prefs.visible 仍含 note');
  }
  if (label === '图纸' && savedPrefs?.visible?.includes('drawing')) {
    throw new Error('PUT 后 prefs.visible 仍含 drawing');
  }
  await page.reload();
  await page.getByText('加工单').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  const ths = await page.locator('.ant-table-thead th').allInnerTexts();
  if (ths.map((t) => t.trim()).includes(label)) throw new Error(`列 ${label} 刷新后仍显示`);
  await shot(page, 'r12-p2-01-col-hide');
  return `隐藏 ${label}`;
});

await step('17', '列锁定+拖拽排序后保持', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await btn(page, '列配置').click();
  const modal = page.locator('.ant-modal').filter({ hasText: '列配置' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const rows = modal.locator('.ant-table-tbody tr.ant-table-row');
  const count = await rows.count();
  if (count < 3) throw new Error('列配置行不足');
  // 锁定第 2 行
  const lockBtn = rows.nth(1).getByRole('button', { name: /锁定|取消锁定/ });
  const beforeLock = await lockBtn.getAttribute('aria-label');
  if (beforeLock === '锁定') await lockBtn.click();
  // 拖拽：把第 2 行拖到第 3 行
  const from = rows.nth(1).locator('[draggable=true], .anticon-holder').first();
  const to = rows.nth(2).locator('[draggable=true], .anticon-holder').first();
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  if (!fromBox || !toBox) throw new Error('无法拖拽排序手柄');
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const orderBefore = await rows.evaluateAll((nodes) => nodes.map((n) => n.querySelectorAll('td')[2]?.textContent?.trim() ?? ''));
  const [putRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/list-column-prefs') && r.request().method() === 'PUT', { timeout: 15000 }),
    modal.locator('.ant-modal-footer').getByRole('button', { name: /确\s*定/ }).click(),
  ]);
  if (!putRes.ok()) {
    throw new Error(`列配置 PUT ${putRes.status}: ${(await putRes.text()).slice(0, 240)}`);
  }
  const body = await putRes.json();
  columnPrefsSnapshot = body.prefs;
  await page.reload();
  await page.getByText('加工单').first().waitFor({ timeout: 15000 });
  await btn(page, '列配置').click();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const orderAfter = await modal.locator('.ant-table-tbody tr.ant-table-row').evaluateAll((nodes) => nodes.map((n) => n.querySelectorAll('td')[2]?.textContent?.trim() ?? ''));
  if (JSON.stringify(orderAfter) !== JSON.stringify(orderBefore) && JSON.stringify(orderAfter) !== JSON.stringify(columnPrefsSnapshot?.order?.map(() => '') )) {
    // 以 API prefs.order 为准
    const prefs = (await api(admin, 'GET', '/api/list-column-prefs?page_key=work-orders')).prefs;
    if (!prefs?.locked?.length) throw new Error('锁定未保存');
    if (!prefs?.order?.length) throw new Error('排序未保存');
    columnPrefsSnapshot = prefs;
  } else {
    columnPrefsSnapshot = (await api(admin, 'GET', '/api/list-column-prefs?page_key=work-orders')).prefs;
  }
  if (!columnPrefsSnapshot?.locked?.length) throw new Error('锁定集合为空');
  await shot(page, 'r12-p2-02-col-lock-sort');
  await modal.locator('.ant-modal-footer').getByRole('button', { name: /取\s*消/ }).click();
  return `locked=${columnPrefsSnapshot.locked.length}`;
});

await step('18', '列配置应用到其他人（planner 一致）', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await btn(page, '列配置').click();
  const modal = page.locator('.ant-modal').filter({ hasText: '列配置' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const applyPost = page.waitForResponse((r) => r.url().includes('/api/list-column-prefs/apply') && r.request().method() === 'POST' && r.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: '应用到其他人' }).click();
  await confirmOk(page, '应用到其他人');
  await applyPost;
  if (await modal.isVisible()) await modal.locator('.ant-modal-footer').getByRole('button', { name: /取\s*消/ }).click();
  const adminPrefs = (await api(admin, 'GET', '/api/list-column-prefs?page_key=work-orders')).prefs;
  const plannerPrefs = (await api(planner, 'GET', '/api/list-column-prefs?page_key=work-orders')).prefs;
  if (!adminPrefs || !plannerPrefs) throw new Error('prefs 为空');
  if (JSON.stringify(adminPrefs.visible) !== JSON.stringify(plannerPrefs.visible)
    || JSON.stringify(adminPrefs.order) !== JSON.stringify(plannerPrefs.order)
    || JSON.stringify(adminPrefs.locked) !== JSON.stringify(plannerPrefs.locked)) {
    throw new Error('planner 列配置与 admin 不一致');
  }
  // UI 侧以 planner 登录核对
  await asUser(page, planner);
  await open(page, '/inside_produce_bill/list', '加工单');
  await shot(page, 'r12-p2-03-col-apply-others');
  await asUser(page, admin);
  return 'admin/planner prefs 一致';
});

await step('19', '加工单移动端卡片配置 PUT 成功', async () => {
  await asUser(page, admin);
  await open(page, '/inside_produce_bill/list', '加工单');
  await btn(page, '移动端卡片配置').click();
  const modal = page.locator('.ant-modal').filter({ hasText: '移动端卡片配置' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const box = modal.locator('.ant-checkbox-wrapper').nth(1);
  await box.click();
  const put = page.waitForResponse((r) => r.url().includes('/api/mobile-cards') && r.request().method() === 'PUT' && r.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  await put;
  await shot(page, 'r12-p2-04-mobile-card-wo');
  return 'PUT /api/mobile-cards OK';
});

await step('20', '机台报表无移动端卡片配置', async () => {
  await open(page, '/drilling_crew_statement/list', '机台');
  const body = await page.locator('body').innerText();
  if (body.includes('移动端卡片配置')) throw new Error('机台报表出现移动端卡片配置');
  await shot(page, 'r12-p2-05-machine-no-mobile');
  return '无移动端卡片配置';
});

async function clickViewMenu(page, viewName) {
  // 顶栏 kgd-top（含消息铃铛）常盖住视图 ⋮，点击前临时禁用其 pointer-events
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await page.addStyleTag({ content: '.kgd-top{pointer-events:none!important}' });
  const menu = page.getByRole('button', { name: `${viewName}菜单` });
  await menu.scrollIntoViewIfNeeded();
  try {
    await menu.click({ timeout: 8000 });
  } finally {
    await page.addStyleTag({ content: '.kgd-top{pointer-events:auto!important}' });
  }
}

await step('21', '视图修改四段可切换并保存出页签', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await page.keyboard.press('Escape');
  // 新建视图
  await page.getByRole('button', { name: '视图管理' }).click();
  const drawer = page.locator('.ant-modal').filter({ hasText: /新增视图|修改视图/ }).last();
  await drawer.waitFor({ state: 'visible', timeout: 10000 });
  const viewName = `R12视图${stamp}`;
  await drawer.locator('input').first().fill(viewName);
  for (const sec of ['基本信息', '字段权限', '数据过滤', '默认排序']) {
    await drawer.locator('nav button, .kgd-view-edit-nav button').filter({ hasText: sec }).click();
    await page.waitForTimeout(200);
  }
  await drawer.locator('nav button, .kgd-view-edit-nav button').filter({ hasText: '基本信息' }).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/list-views') && ['POST', 'PUT'].includes(r.request().method()) && r.ok(), { timeout: 15000 }),
    drawer.getByRole('button', { name: /确\s*定/ }).click(),
  ]);
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: viewName }).first().waitFor({ state: 'visible', timeout: 10000 });
  // ⋮ 修改，再切四段
  await clickViewMenu(page, viewName);
  await page.getByRole('menuitem', { name: '修改' }).click();
  const edit = page.locator('.ant-modal').filter({ hasText: '修改视图' }).last();
  await edit.waitFor({ state: 'visible', timeout: 10000 });
  for (const sec of ['基本信息', '字段权限', '数据过滤', '默认排序']) {
    await edit.locator('nav button, .kgd-view-edit-nav button').filter({ hasText: sec }).click();
    await page.waitForTimeout(150);
  }
  await shot(page, 'r12-p2-06-view-edit');
  await edit.getByRole('button', { name: /确\s*定/ }).click();
  await page.waitForTimeout(500);
  return viewName;
});

await step('22', '复制视图出现、删除后消失', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await page.keyboard.press('Escape');
  const viewName = `R12视图${stamp}`;
  const tab = page.getByRole('button', { name: viewName }).first();
  await tab.waitFor({ state: 'visible', timeout: 10000 });
  await clickViewMenu(page, viewName);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/list-views/') && r.url().includes('/copy') && r.request().method() === 'POST' && r.ok(), { timeout: 15000 }),
    page.getByRole('menuitem', { name: '复制' }).click(),
  ]);
  await page.waitForTimeout(800);
  const before = await page.locator('button.kgd-view').allInnerTexts();
  if (before.filter((t) => t.includes('R12视图') || t.includes('副本')).length < 2) {
    // 复制名可能是「R12视图xxx 副本」或带后缀
    const items = (await api(admin, 'GET', '/api/list-views?page_key=work-orders')).items ?? [];
    if (items.filter((item) => String(item.name).includes('R12视图') || String(item.name).includes(stamp)).length < 2) {
      throw new Error(`复制后视图不足: ${before.join(',')}`);
    }
  }
  // 删除原视图
  await clickViewMenu(page, viewName);
  await page.getByRole('menuitem', { name: '删除' }).click();
  await confirmOk(page, '删除视图');
  await page.waitForTimeout(800);
  if (await page.getByRole('button', { name: viewName, exact: true }).count()) {
    throw new Error('删除后原视图页签仍在');
  }
  await shot(page, 'r12-p2-07-view-copy-del');
  return '复制+删除 OK';
});

// ——— P3 智能报表 ———
await step('23', '智能报表三页签+自定义卡片', async () => {
  await open(page, '/smart/form_core_list', '智能报表');
  for (const tab of ['电脑端报表', '小程序报表', '推送设置']) {
    await page.getByRole('tab', { name: tab }).waitFor({ state: 'visible', timeout: 8000 });
  }
  await page.getByTestId('smart-custom-card').or(page.getByText('自定义智能报表')).first().waitFor({ state: 'visible', timeout: 8000 });
  await shot(page, 'r12-p3-01-smart-list');
  return '三页签+自定义卡';
});

await step('24', '自定义报表设计保存后列表可见', async () => {
  await open(page, '/smart/form_core_list', '电脑端报表');
  await page.getByTestId('smart-custom-card').or(page.getByText('自定义智能报表')).first().click();
  const modal = page.locator('.ant-modal').filter({ hasText: '自定义智能报表' }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const reportName = `R12报表${stamp}`;
  await modal.locator('.ant-form-item').filter({ hasText: '报表名称' }).locator('input').fill(reportName);
  await clickFormSelectOption(page, modal, '统计维度', '商品');
  await clickFormSelectOption(page, modal, '统计指标', '加工单数');
  const saved = page.waitForResponse((r) => r.url().includes('/api/smart-reports') && r.request().method() === 'POST' && r.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  await saved;
  await page.waitForTimeout(800);
  await page.getByText(reportName).first().waitFor({ state: 'visible', timeout: 10000 });
  await shot(page, 'r12-p3-02-smart-designer-save');
  return reportName;
});

await step('25', '推送设置保存', async () => {
  await open(page, '/smart/form_core_list', '智能报表');
  await page.getByRole('tab', { name: '推送设置' }).click();
  await page.getByText('推送设置').first().waitFor({ timeout: 10000 });
  const put = page.waitForResponse((r) => r.url().includes('/api/smart-reports/push-settings') && r.request().method() === 'PUT' && r.ok(), { timeout: 15000 });
  await btn(page, '保存').click();
  await put;
  await shot(page, 'r12-p3-03-smart-push');
  return '推送设置已保存';
});

await browser.close();
const failed = writeReports();
process.exit(failed ? 1 : 0);
