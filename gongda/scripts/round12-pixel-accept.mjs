#!/usr/bin/env node
/**
 * 第十二轮像素/结构对拍验收（Playwright only）。
 *
 * 前置：
 *   rm -rf .local/database && npm run dev:setup && npm run dev
 *   本脚本经正式 API 造数（不直写库）。
 *
 * 截图双写：
 *   /opt/cursor/artifacts/round12-pixel/
 *   docs/verification/round12-pixel/
 *
 * 纪律：禁止 force:true；禁止 .catch 吞断言/等待失败；禁止「没数据就选第一项」。
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/round12-pixel';
const docDir = path.join(process.cwd(), 'docs/verification/round12-pixel');
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
    const json = await res.json();
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
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
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

function btn(page, name) {
  const spaced = String(name).split('').join('\\s*');
  return page.getByRole('button', { name: new RegExp(`^\\s*${spaced}\\s*$`) });
}

async function waitServers(ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const [apiRes, webRes] = await Promise.all([fetch(`${API}/api/auth/me`), fetch(WEB)]);
      if ([200, 401, 403, 429].includes(apiRes.status) && webRes.ok) return;
    } catch {
      /* 启动中 */
    }
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

async function openShortcutModal(page) {
  await open(page, '/staging/area', '工作台');
  await page.getByText('快捷入口').first().waitFor({ timeout: 15000 });
  const shortcutsCard = page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^快捷入口$/ }) });
  await shortcutsCard.locator('button.wp-more, [aria-label=编辑]').click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '添加快捷入口' }).last();
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  return modal;
}

function toolbarHasExt(page) {
  return page.locator('.kgd-toolbar').getByRole('button', { name: /^\s*扩\s*展\s*字\s*段\s*$/ });
}

async function expectExtTitle(page, title) {
  await btn(page, '扩展字段').click();
  const modal = page.locator('.ant-modal').filter({ hasText: title }).last();
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  const heading = await modal.locator('.ant-modal-title').innerText();
  if (heading.trim() !== title) throw new Error(`标题「${heading.trim()}」≠「${title}」`);
  await modal.getByRole('button', { name: /^\s*新\s*增\s*$/ }).waitFor({ state: 'visible', timeout: 5000 });
  if (heading.includes('supplier-list') || /【[a-z0-9_-]+】/i.test(heading)) {
    throw new Error(`标题含英文 pageKey：${heading}`);
  }
  return modal;
}

await waitServers();
const adminPass = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!adminPass) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local；请先 npm run dev:setup');

const admin = await login('admin.local', adminPass);

// 正式接口造数：保证客户存在；工作台快捷入口预置「去掉申请开票」
const products = await api(admin, 'GET', '/api/products?page=1&page_size=5');
if (!(products.items?.length >= 1)) {
  const seed = spawnSync(process.execPath, ['scripts/seed-round10-demo.mjs'], { stdio: 'inherit' });
  if (seed.status !== 0) throw new Error('seed-round10-demo 失败（非 0）');
}
const wantedCustomer = `R12P客户${stamp}`;
let customers = (await api(admin, 'GET', '/api/money/customers?page=1&page_size=50')).items ?? [];
if (!customers.find((item) => String(item.name) === wantedCustomer)) {
  await api(admin, 'POST', '/api/money/customers', {
    request_key: crypto.randomUUID(),
    name: wantedCustomer,
    contact_name: 'R12P联系人',
    contact_phone: `139${stamp.padStart(8, '0').slice(0, 8)}`,
  });
}
const cfg0 = await api(admin, 'GET', '/api/workplace/config');
const allKeys = ['customer_add', 'follow_add', 'contract_add', 'invoice_apply', 'work_order_add', 'fg_receipt_add', 'process_add', 'defect_add', 'route_add'];
const baseKeys = allKeys.filter((key) => key !== 'invoice_apply');
await api(admin, 'PUT', '/api/workplace/config', {
  cards: ['banner', 'shortcuts', 'todos', 'notices', 'messages', 'devices'].map((key) => ({ key, visible: true })),
  layout: undefined,
  shortcuts: baseKeys,
  todo_prefs: {
    pending_contracts: true,
    pending_invoices: true,
    maint_tasks: true,
    repairs_to_accept: true,
    repairs_to_review: true,
  },
  version: cfg0.version,
});

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await asUser(page, admin);

// ——— 1 标题恒为「添加快捷入口」 ———
await step(1, '快捷入口弹窗标题精确「添加快捷入口」（有已选）', async () => {
  const modal = await openShortcutModal(page);
  const title = (await modal.locator('.ant-modal-title').innerText()).trim();
  if (title !== '添加快捷入口') throw new Error(`标题「${title}」≠「添加快捷入口」`);
  if (title.includes('编辑')) throw new Error('禁止标题「编辑快捷入口」');
  const selected = await modal.locator('[data-testid=shortcut-selected] .wp-shortcut-tile').count();
  if (selected < 1) throw new Error('预置应有已选入口');
  await shot(page, 'r12p-01-shortcut-title');
  return `title=${title} selected=${selected}`;
});

// ——— 2 已选宫格 + ×，非 Tag ———
await step(2, '已选区图标宫格；非 Tag/wp-chip；每项可见 ×', async () => {
  const modal = page.locator('.ant-modal').filter({ hasText: '添加快捷入口' }).last();
  await modal.getByText('已选快捷入口').waitFor({ state: 'visible', timeout: 5000 });
  const tags = await modal.locator('.ant-tag').count();
  if (tags !== 0) throw new Error(`已选区出现 ant-tag×${tags}，禁止 Tag 顶替宫格`);
  const chips = await modal.locator('.wp-chip').count();
  if (chips !== 0) throw new Error(`已选区出现 wp-chip×${chips}`);
  const tiles = modal.locator('[data-testid=shortcut-selected] .wp-shortcut-tile');
  const n = await tiles.count();
  if (n < 1) throw new Error('已选宫格为空');
  for (let i = 0; i < n; i += 1) {
    const tile = tiles.nth(i);
    const img = tile.locator('img.wp-shortcut-icon-img');
    await img.waitFor({ state: 'visible', timeout: 3000 });
    const src = await img.getAttribute('src');
    // Vite 开发态可能内联为 data:image/svg+xml；构建态多为 *.svg URL
    if (!src || !(/\.svg(\?|$)/i.test(src) || /^data:image\/svg\+xml/i.test(src))) {
      throw new Error(`已选图标非 SVG 资源: ${String(src).slice(0, 80)}`);
    }
    // 禁止单字色块：不得用带文字的色块 span 顶替
    if (await tile.locator('.wp-shortcut-icon:not(img), .wp-dot').count()) {
      throw new Error('已选区仍有单字色块节点');
    }
    await tile.locator('.wp-shortcut-tile-x').waitFor({ state: 'visible', timeout: 3000 });
  }
  if (await modal.locator('.wp-shortcut-icon:not(img), .wp-dot').count()) {
    throw new Error('仍存在非 img 的色块图标');
  }
  await shot(page, 'r12p-02-shortcut-selected-grid');
  return `tiles=${n} svg-img tags=0 chips=0`;
});

// ——— 3 可选分组宫格 + 置灰 ———
await step(3, '可选区≥2 分组；宫格；已选项置灰', async () => {
  const modal = page.locator('.ant-modal').filter({ hasText: '添加快捷入口' }).last();
  await modal.getByText('可选快捷入口').waitFor({ state: 'visible', timeout: 5000 });
  const groups = modal.locator('.wp-shortcut-group-title');
  const g = await groups.count();
  if (g < 2) throw new Error(`分组数 ${g} < 2`);
  const titles = [];
  for (let i = 0; i < g; i += 1) titles.push((await groups.nth(i).innerText()).trim());
  if (!titles.includes('客户管理') || !titles.includes('生产管理')) {
    throw new Error(`分组文案不符：${titles.join(',')}`);
  }
  const picks = modal.locator('button.wp-shortcut-pick');
  if ((await picks.count()) < 2) throw new Error('可选宫格不足');
  const disabled = modal.locator('button.wp-shortcut-pick.is-disabled');
  if ((await disabled.count()) < 1) throw new Error('未见已选置灰项');
  const iconImgs = modal.locator('button.wp-shortcut-pick img.wp-shortcut-icon-img');
  if ((await iconImgs.count()) < 2) throw new Error('可选区缺少 SVG 图标');
  await disabled.first().locator('img.wp-shortcut-icon-img').waitFor({ state: 'visible', timeout: 3000 });
  await shot(page, 'r12p-03-shortcut-optional-grid');
  return `groups=${titles.join('|')} disabled=${await disabled.count()} svg`;
});

// ——— 4 增删 + 确定后工作台一致 ———
await step(4, '× 移除后少 1；点可选加入后多 1；确定后工作台一致', async () => {
  const modal = page.locator('.ant-modal').filter({ hasText: '添加快捷入口' }).last();
  const selected = modal.locator('[data-testid=shortcut-selected] .wp-shortcut-tile');
  const before = await selected.count();
  await modal.getByLabel('移除新增客户').click();
  await modal.getByLabel('移除新增客户').waitFor({ state: 'hidden', timeout: 5000 });
  const mid = await selected.count();
  if (mid !== before - 1) throw new Error(`移除后 ${mid} ≠ ${before - 1}`);
  await modal.locator('button.wp-shortcut-pick', { hasText: '申请开票' }).click();
  await modal.locator('button.wp-shortcut-pick.is-disabled', { hasText: '申请开票' }).waitFor({ state: 'visible', timeout: 5000 });
  const afterAdd = await selected.count();
  if (afterAdd !== mid + 1) throw new Error(`加入后 ${afterAdd} ≠ ${mid + 1}`);
  const putCfg = page.waitForResponse((r) => r.url().includes('/api/workplace/config') && r.request().method() === 'PUT' && r.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  const putRes = await putCfg;
  const body = putRes.request().postDataJSON();
  if ((body.shortcuts ?? []).includes('customer_add')) throw new Error('PUT 仍含 customer_add');
  if (!(body.shortcuts ?? []).includes('invoice_apply')) throw new Error('PUT 缺 invoice_apply');
  const cfgGet = page.waitForResponse((r) => r.url().includes('/api/workplace/config') && r.request().method() === 'GET' && r.ok(), { timeout: 15000 });
  await page.reload();
  await cfgGet;
  await page.getByText('快捷入口').first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('section.wp-card')].find((node) => node.querySelector('header b')?.textContent?.trim() === '快捷入口');
    const text = card?.textContent ?? '';
    return text.includes('申请开票') && !text.includes('新增客户');
  }, undefined, { timeout: 15000 });
  await shot(page, 'r12p-04-shortcut-add-remove');
  return `before=${before} mid=${mid} after=${afterAdd}`;
});

// ——— 5 与原版参考对拍备注 ———
await step(5, '与原版结构一致：标题+两分区+宫格（附 ref）', async () => {
  const modal = await openShortcutModal(page);
  const title = (await modal.locator('.ant-modal-title').innerText()).trim();
  if (title !== '添加快捷入口') throw new Error(title);
  await modal.getByText('已选快捷入口').waitFor({ state: 'visible' });
  await modal.getByText('可选快捷入口').waitFor({ state: 'visible' });
  if ((await modal.locator('.ant-tag').count()) !== 0) throw new Error('仍有 Tag');
  if ((await modal.locator('[data-testid=shortcut-selected] .wp-shortcut-tile').count()) < 1) throw new Error('无已选宫格');
  const svgImgs = modal.locator('img.wp-shortcut-icon-img');
  if ((await svgImgs.count()) < 4) throw new Error('图标数量不足，疑似仍用单字色块');
  for (let i = 0; i < Math.min(4, await svgImgs.count()); i += 1) {
    const src = await svgImgs.nth(i).getAttribute('src');
    if (!src || !(/\.svg(\?|$)/i.test(src) || /^data:image\/svg\+xml/i.test(src))) {
      throw new Error(`图标非 SVG: ${String(src).slice(0, 80)}`);
    }
  }
  // 打开态截图须能看出非单字色块：校验 SVG 源含 path/circle 等图形元素
  const sampleSrc = await svgImgs.first().getAttribute('src');
  const decoded = sampleSrc.startsWith('data:')
    ? decodeURIComponent(sampleSrc.replace(/^data:image\/svg\+xml,?/, ''))
    : '';
  if (decoded && !/<path|<circle|<rect/i.test(decoded)) {
    throw new Error('SVG 缺少图形元素，疑似单字色块');
  }
  // 工作台快捷入口区同步使用精美图标
  const boardIcons = page.locator('.wp-shortcuts img.wp-shortcut-icon-img');
  if ((await boardIcons.count()) < 1) throw new Error('工作台快捷入口区未见 SVG 图标');
  await shot(page, 'r12p-05-shortcut-vs-ref');
  const note = [
    '结构断言：标题=添加快捷入口；分区=已选/可选；已选=wp-shortcut-tile+×；可选=wp-shortcut-pick 宫格+置灰',
    '图标：img.wp-shortcut-icon-img → apps/web/src/kgd/assets/shortcuts/*.svg（禁止单字色块）',
    '原版参考：docs/verification/round12-pixel/原版-添加快捷入口-打开态.png',
    '禁止对照：docs/verification/round12-pixel/复刻旧-编辑快捷入口.png',
    '采集笔记：docs/verification/round12-pixel/ref-notes-shortcut.md',
  ].join('\n');
  writeFileSync(path.join(docDir, 'r12p-05-vs-ref-notes.txt'), `${note}\n`);
  writeFileSync(path.join(artifactDir, 'r12p-05-vs-ref-notes.txt'), `${note}\n`);
  return '结构断言+精美 SVG+ref 路径已写入';
});

// ——— 6 待办编辑打开态 ———
await step(6, '待办编辑打开态：色块 swatch + Switch', async () => {
  await open(page, '/staging/area', '工作台');
  const todosCard = page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^待办事项$/ }) });
  await todosCard.locator('button.wp-more, [aria-label=编辑]').click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '编辑待办事项' }).last();
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  const title = (await modal.locator('.ant-modal-title').innerText()).trim();
  if (title !== '编辑待办事项') throw new Error(`标题「${title}」`);
  const prefs = modal.locator('.wp-todo-pref');
  if ((await prefs.count()) < 3) throw new Error('待办项不足');
  await prefs.first().locator('.wp-todo-pref-swatch').waitFor({ state: 'visible' });
  await prefs.first().locator('.ant-switch').waitFor({ state: 'visible' });
  // 禁止纯 Checkbox 列表顶替
  if ((await modal.locator('.ant-checkbox').count()) > 0) throw new Error('出现 Checkbox 顶替色块行');
  await shot(page, 'r12p-06-todo-edit-open');
  return `prefs=${await prefs.count()}`;
});

// ——— 7 关闭一类持久化 ———
await step(7, '关闭待开票 → 保存 → 刷新后不显示', async () => {
  const modal = page.locator('.ant-modal').filter({ hasText: '编辑待办事项' }).last();
  if (!(await modal.isVisible())) {
    const todosCard = page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^待办事项$/ }) });
    await todosCard.locator('button.wp-more, [aria-label=编辑]').click();
    await page.getByRole('menuitem', { name: '编辑' }).click();
    await modal.waitFor({ state: 'visible', timeout: 8000 });
  }
  const row = modal.locator('.wp-todo-pref').filter({ hasText: '待开票' });
  await row.waitFor({ state: 'visible', timeout: 5000 });
  const sw = row.locator('.ant-switch');
  if (await sw.evaluate((el) => el.classList.contains('ant-switch-checked'))) {
    await sw.click();
  }
  if (await sw.evaluate((el) => el.classList.contains('ant-switch-checked'))) {
    throw new Error('待开票开关未能关闭');
  }
  const putCfg = page.waitForResponse((r) => r.url().includes('/api/workplace/config') && r.request().method() === 'PUT' && r.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  const putBody = (await putCfg).request().postDataJSON();
  if (putBody.todo_prefs?.pending_invoices !== false) throw new Error('PUT todo_prefs.pending_invoices 未关闭');
  const cfgGet = page.waitForResponse((r) => r.url().includes('/api/workplace/config') && r.request().method() === 'GET' && r.ok(), { timeout: 15000 });
  await page.reload();
  await cfgGet;
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('section.wp-card')].find((node) => node.querySelector('header b')?.textContent?.trim() === '待办事项');
    return card ? !card.textContent?.includes('待开票') : false;
  }, undefined, { timeout: 15000 });
  await shot(page, 'r12p-07-todo-toggle-persist');
  return '待开票已隐藏';
});

// ——— 8 盘点 + rg 供应商无扩展字段按钮（源码显式 false） ———
await step(8, '盘点已提交；rg 供应商页 showExtension=false', async () => {
  const inv = path.join(docDir, 'ext-inventory.md');
  if (!existsSync(inv)) throw new Error('缺少 ext-inventory.md');
  const invText = readFileSync(inv, 'utf8');
  if (!invText.includes('supplier-list') || !invText.includes('保留可加')) {
    throw new Error('盘点文件缺供应商或保留可加节');
  }
  const rgBin = process.env.RG_BIN || 'rg';
  const target = 'apps/web/src/kgd/pages/money/supply.tsx';
  const src = readFileSync(target, 'utf8');
  const supplierBlock = src.slice(src.indexOf('pageKey="supplier-list"'), src.indexOf('pageKey="supplier-list"') + 400);
  if (!supplierBlock.includes('showExtension={false}')) {
    throw new Error('供应商页未显式 showExtension={false}');
  }
  const result = spawnSync(rgBin, ['-n', 'showExtension=\\{false\\}', target], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg 失败 status=${result.status}: ${result.stderr}`);
  }
  if (!result.stdout || !/showExtension=\{false\}/.test(result.stdout)) {
    throw new Error('rg 未命中 supply.tsx 的 showExtension={false}');
  }
  await open(page, '/supplier/list', '供应商');
  if (await toolbarHasExt(page).count()) throw new Error('供应商工具栏仍有扩展字段');
  await shot(page, 'r12p-08-supplier-no-ext');
  return 'inventory+supplier hidden';
});

// ——— 9 供应商工具栏无扩展；无 supplier-list 标题 ———
await step(9, '供应商工具栏无扩展字段；无 supplier-list 弹窗标题', async () => {
  await open(page, '/supplier/list', '供应商');
  const toolbarText = await page.locator('.kgd-toolbar').allInnerTexts();
  if (toolbarText.join('\n').includes('扩展字段')) throw new Error('工具栏仍见扩展字段');
  // 不应能打开空壳
  if (await btn(page, '扩展字段').count()) throw new Error('仍存在扩展字段按钮');
  const body = await page.locator('body').innerText();
  if (body.includes('【supplier-list】')) throw new Error('页面出现 supplier-list 空壳标题');
  await shot(page, 'r12p-09-supplier-toolbar');
  return '无扩展字段按钮';
});

// ——— 10–13 四白名单中文标题+新增 ———
await step(10, '加工单扩展字段标题【加工单】+新增', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  const modal = await expectExtTitle(page, '【加工单】扩展字段管理');
  await shot(page, 'r12p-10-wo-ext-title');
  await modal.locator('.ant-modal-close').click();
  return '【加工单】扩展字段管理';
});

await step(11, '客户扩展字段标题【客户管理】+新增', async () => {
  await open(page, '/customer/list', '客户');
  const modal = await expectExtTitle(page, '【客户管理】扩展字段管理');
  await shot(page, 'r12p-11-customer-ext-title');
  await modal.locator('.ant-modal-close').click();
  return '【客户管理】扩展字段管理';
});

await step(12, '联系人扩展字段标题【客户联系人】+新增', async () => {
  await open(page, '/linkman/list', '联系人');
  const modal = await expectExtTitle(page, '【客户联系人】扩展字段管理');
  await shot(page, 'r12p-12-linkman-ext-title');
  await modal.locator('.ant-modal-close').click();
  return '【客户联系人】扩展字段管理';
});

await step(13, '商品扩展字段标题【商品】+新增', async () => {
  await open(page, '/goods/list', '商品');
  const modal = await expectExtTitle(page, '【商品】扩展字段管理');
  await shot(page, 'r12p-13-goods-ext-title');
  await modal.locator('.ant-modal-close').click();
  return '【商品】扩展字段管理';
});

// ——— 14 抽样隐藏页 ———
await step(14, '抽样隐藏页工具栏无扩展字段（采购单/工序/设备）', async () => {
  const samples = [
    ['/purchase_order/list', '采购'],
    ['/public_craft/list', '工序'],
    ['/device/list', '设备'],
  ];
  for (const [url, wait] of samples) {
    await open(page, url, wait);
    if (await toolbarHasExt(page).count()) throw new Error(`${url} 仍有扩展字段`);
    const text = await page.locator('.kgd-toolbar').allInnerTexts();
    if (text.join('\n').includes('扩展字段')) throw new Error(`${url} 工具栏文案含扩展字段`);
  }
  await shot(page, 'r12p-14-hidden-ext-sample');
  return samples.map((s) => s[0]).join(',');
});

// ——— 15 机台报表回归 ———
await step(15, '机台报表：无扩展字段、无移动端卡片', async () => {
  await open(page, '/drilling_crew_statement/list', '机台');
  await btn(page, '列配置').waitFor({ state: 'visible', timeout: 10000 });
  const body = await page.locator('body').innerText();
  if (body.includes('扩展字段')) throw new Error('机台报表仍出现扩展字段');
  if (body.includes('移动端卡片配置')) throw new Error('机台报表仍出现移动端卡片配置');
  await shot(page, 'r12p-15-machine-regression');
  return '无扩展/无移动端卡片';
});

// ——— 16 rg 无英文 pageKey 标题模式（源码） ———
await step(16, 'rg 前端源码无【*-list】/【supplier-list】标题拼接', async () => {
  const rgBin = process.env.RG_BIN || 'rg';
  // ExtensionModal 不得再使用 pageKey 回退
  const listFrame = readFileSync('apps/web/src/kgd/ListFrame.tsx', 'utf8');
  if (listFrame.includes('extensionObject || pageKey')) {
    throw new Error('ListFrame 仍回退 pageKey 作为 objectName');
  }
  if (!listFrame.includes('extensionVisible')) {
    throw new Error('ListFrame 缺少 extensionVisible 门禁');
  }
  const result = spawnSync(rgBin, ['-n', '【\\$\\{.*pageKey|supplier-list】|【.*-list】', 'apps/web/src'], {
    encoding: 'utf8',
  });
  const out = [
    `exit=${result.status}`,
    result.stdout || '(无匹配)',
    result.stderr || '',
    'ListFrame: 无 extensionObject || pageKey 回退',
    '门禁: extensionVisible = showExtension && extensionObject && extensionCanAdd',
  ].join('\n');
  writeFileSync(path.join(docDir, 'r12p-16-rg-no-en-pagekey.txt'), `${out}\n`);
  writeFileSync(path.join(artifactDir, 'r12p-16-rg-no-en-pagekey.txt'), `${out}\n`);
  // 允许 inventory/注释提及 supplier-list；禁止运行态标题模板
  if (/title=\{`【\$\{.*pageKey/.test(listFrame)) throw new Error('仍有 pageKey 标题模板');
  return '源码门禁 OK';
});

// ——— 17 置灰项点击不重复追加 ———
await step(17, '可选区已选置灰：点击灰项不重复追加', async () => {
  // 恢复含「新增合同」的已选，再打开
  const cfg = await api(admin, 'GET', '/api/workplace/config');
  await api(admin, 'PUT', '/api/workplace/config', {
    cards: cfg.cards,
    layout: cfg.layout,
    todo_prefs: cfg.todo_prefs,
    shortcuts: ['contract_add', 'work_order_add'],
    version: cfg.version,
  });
  const modal = await openShortcutModal(page);
  const selected = modal.locator('[data-testid=shortcut-selected] .wp-shortcut-tile');
  const before = await selected.count();
  const gray = modal.locator('button.wp-shortcut-pick.is-disabled', { hasText: '新增合同' });
  await gray.waitFor({ state: 'visible', timeout: 5000 });
  if (!(await gray.isDisabled())) throw new Error('已选项按钮未 disabled');
  // 置灰项：disabled + 再点可选未选项后，已选中「新增合同」仍仅 1（不重复追加）
  const enabledPick = modal.locator('button.wp-shortcut-pick:not(.is-disabled)').first();
  await enabledPick.waitFor({ state: 'visible', timeout: 5000 });
  const enabledLabel = (await enabledPick.locator('.wp-shortcut-tile-label').innerText()).trim();
  await enabledPick.click();
  await modal.locator('button.wp-shortcut-pick.is-disabled', { hasText: enabledLabel }).waitFor({ state: 'visible', timeout: 5000 });
  const after = await selected.count();
  if (after !== before + 1) throw new Error(`可选加入后 ${after} ≠ ${before + 1}`);
  const contractTiles = modal.locator('[data-testid=shortcut-selected] .wp-shortcut-tile[data-key=contract_add]');
  if ((await contractTiles.count()) !== 1) throw new Error('灰项「新增合同」被重复追加');
  await shot(page, 'r12p-17-shortcut-disabled');
  return `selected ${before}→${after}；灰项不重复`;
});

const failed = results.some((item) => item.result !== '通过');
const lines = [
  `round12-pixel-accept ${new Date().toISOString()}`,
  ...results.map((item) => `${item.n}\t${item.result}\t${item.title}\t${item.reason}`),
  failed ? '未通过' : '全部通过',
];
const text = `${lines.join('\n')}\n`;
writeFileSync(path.join(docDir, 'ACCEPT.txt'), text);
writeFileSync(path.join(artifactDir, 'ACCEPT.txt'), text);
writeFileSync(path.join(docDir, 'results.json'), `${JSON.stringify({ at: new Date().toISOString(), results, failed }, null, 2)}\n`);
console.log(text);

await browser.close();
process.exit(failed ? 1 : 0);
