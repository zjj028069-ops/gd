/**
 * 客户列表：修改视图四段（B3）与列配置「应用到其他人」（B4）。
 * 只用 Playwright。打开态截图，并走保存 / 勾选 / 锁定 / 应用到其他人。
 * 前置：npm run dev:setup && npm run dev
 * 截图：docs/verification/customer-view-column
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/customer-view-column');
const artifactDir = '/opt/cursor/artifacts/customer-view-column';
mkdirSync(outDir, { recursive: true });
mkdirSync(artifactDir, { recursive: true });

const QUICK = `PW快捷${Date.now().toString().slice(-6)}`;
const COLUMN_ORDER = ['客户编号', '客户', '客户标签', '联系人', '联系人电话', '地址', '启用/禁用', '负责人', '创建人', '创建时间', '更新时间', '距离', '操作'];
const FIELD_ROWS = ['客户编号', '客户', '客户标签', '联系人', '联系人电话', '地址', '启用/禁用', '负责人', '创建人', '创建时间', '更新时间', '距离'];
const COLUMN_KEYS = ['code', 'name', 'tags', 'contact', 'phone', 'address', 'active', 'owner', 'creator', 'created', 'updated', 'distance', 'actions'];
const shots = [];

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

function pack(text) {
  return String(text ?? '').replace(/\s+/g, '');
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

async function shot(page, name) {
  const file = path.join(outDir, name);
  const artifact = path.join(artifactDir, name);
  await page.screenshot({ path: file, fullPage: false });
  writeFileSync(artifact, readFileSync(file));
  const hash = createHash('md5').update(readFileSync(file)).digest('hex');
  shots.push({ name, hash });
  console.log('shot', name, hash);
}

async function cleanupViews(session) {
  const data = await api(session, 'GET', '/api/list-views?page_key=customer-list');
  for (const item of data.items ?? []) {
    const builtin = item.conditions?.__builtin === '1';
    const mine = String(item.name).startsWith('PW') || /^全部视图-副本\d*$/.test(String(item.name));
    if (builtin || mine) await api(session, 'DELETE', `/api/list-views/${item.id}`, {});
  }
}

async function resetColumns(session) {
  const current = await api(session, 'GET', '/api/list-column-prefs?page_key=customer-list');
  await api(session, 'PUT', '/api/list-column-prefs', {
    page_key: 'customer-list',
    version: current.version || undefined,
    prefs: { order: COLUMN_KEYS, visible: COLUMN_KEYS, locked: [] },
  });
}

async function openCustomer(page) {
  const prefs = page.waitForResponse((response) => response.url().includes('/api/list-column-prefs') && response.ok(), { timeout: 30000 });
  await page.goto(`${WEB}/customer/list`, { waitUntil: 'domcontentloaded' });
  await prefs;
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByRole('button', { name: '列配置', exact: true }).waitFor({ timeout: 30000 });
}

async function openViewMenu(page) {
  await page.keyboard.press('Escape');
  await page.addStyleTag({ content: '.kgd-top{pointer-events:none!important}' });
  const menu = page.getByRole('button', { name: '全部视图菜单', exact: true });
  await menu.scrollIntoViewIfNeeded();
  await menu.click();
  await page.addStyleTag({ content: '.kgd-top{pointer-events:auto!important}' });
}

function viewModal(page) {
  return page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: '修改视图' }) }).last();
}

const pass = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!pass) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local 密码，请先 npm run dev:setup');
const admin = await login('admin.local', pass);
await cleanupViews(admin);
await resetColumns(admin);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await asUser(page, admin);
  await openCustomer(page);
  await openViewMenu(page);
  for (const label of ['修改', '复制', '删除']) {
    await page.getByRole('menuitem', { name: label, exact: true }).waitFor();
  }
  await page.getByRole('menuitem', { name: '修改', exact: true }).click();
  const modal = viewModal(page);
  await modal.waitFor({ state: 'visible' });
  const title = pack(await modal.locator('.ant-modal-title').innerText());
  if (title !== '修改视图') throw new Error(`标题「${title}」`);
  for (const label of ['基本信息', '字段权限', '数据过滤', '默认排序']) {
    const section = modal.getByRole('button', { name: label, exact: true });
    if (await section.count() !== 1) throw new Error(`分段「${label}」${await section.count()}`);
  }
  const name = await modal.locator('input').first().inputValue();
  if (name !== '全部视图') throw new Error(`视图名称「${name}」`);
  const icons = modal.locator('.kgd-view-icon');
  if (await icons.count() !== 5) throw new Error(`图标 ${await icons.count()}`);
  const selectedIcon = await icons.nth(0).getAttribute('class');
  if (!selectedIcon?.includes('on')) throw new Error('默认图标未选中黑底');
  const quick = modal.locator('label').filter({ hasText: '快捷筛选' }).locator('input');
  if ((await quick.inputValue()) !== '') throw new Error('快捷筛选不是空的');
  const scopeText = pack(await modal.locator('label').filter({ hasText: '使用范围' }).innerText());
  if (scopeText.includes('仅自己') || scopeText.includes('本团队') || scopeText.includes('全企业')) throw new Error(`使用范围已有选中值：${scopeText}`);
  await shot(page, '01-b3-basic.png');

  await modal.getByRole('button', { name: '字段权限', exact: true }).click();
  await modal.getByText('设置此视图下用户在列表最多查看的字段', { exact: true }).waitFor();
  await modal.getByRole('button', { name: '选择字段', exact: true }).waitFor();
  const heads = (await modal.locator('.ant-table-thead th').allInnerTexts()).map(pack);
  if (heads.join('|') !== '模块名|列名') throw new Error(`字段权限表头 ${heads.join('|')}`);
  const fieldNames = (await modal.locator('.ant-table-tbody tr td:nth-child(2)').allInnerTexts()).map(pack);
  if (fieldNames.join('|') !== FIELD_ROWS.join('|')) throw new Error(`字段权限列 ${fieldNames.join('|')}`);
  const modules = (await modal.locator('.ant-table-tbody tr td:nth-child(1)').allInnerTexts()).map(pack);
  if (modules.some((item) => item !== '客户')) throw new Error(`模块名 ${modules.join('|')}`);
  await shot(page, '02-b3-fields.png');
  await modal.getByRole('button', { name: '选择字段', exact: true }).click();
  const picker = page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: '选择字段' }) }).last();
  await picker.waitFor();
  const distance = picker.getByRole('checkbox', { name: '距离', exact: true });
  if (await distance.count() !== 1) throw new Error('选择字段里没有距离');
  await distance.click();
  const pickerButtons = (await picker.getByRole('button').allInnerTexts()).map(pack);
  if (!pickerButtons.some((text) => /^确定$/.test(text))) throw new Error(`选择字段按钮 ${pickerButtons.join('|')}`);
  await picker.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
  await picker.waitFor({ state: 'hidden' });
  const afterPick = (await modal.locator('.ant-table-tbody tr td:nth-child(2)').allInnerTexts()).map(pack);
  if (afterPick.includes('距离')) throw new Error('取消距离后表格仍在');
  await modal.getByRole('button', { name: '选择字段', exact: true }).click();
  await picker.waitFor();
  await picker.getByRole('checkbox', { name: '距离', exact: true }).click();
  await picker.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
  await picker.waitFor({ state: 'hidden' });

  await modal.getByRole('button', { name: '数据过滤', exact: true }).click();
  await modal.getByRole('button', { name: '添加筛选条件', exact: true }).click();
  const filterRow = modal.locator('.kgd-view-filter-row');
  if (await filterRow.count() !== 1) throw new Error(`筛选行 ${await filterRow.count()}`);
  await filterRow.getByRole('button', { name: '删除', exact: true }).click();
  if (await filterRow.count() !== 0) throw new Error('筛选条件没有删掉');
  await shot(page, '03-b3-filters.png');

  await modal.getByRole('button', { name: '默认排序', exact: true }).click();
  await modal.getByRole('button', { name: '添加排序条件', exact: true }).click();
  if (await modal.locator('.kgd-view-filter-row').count() !== 1) throw new Error('没有排序行');
  await modal.locator('.kgd-view-filter-row').getByRole('button', { name: '删除', exact: true }).click();
  await shot(page, '04-b3-sort.png');

  await modal.getByRole('button', { name: '基本信息', exact: true }).click();
  await quick.fill(QUICK);
  // 主色绿→蓝后，色板第二槽为赛德瑞克蓝 #4184F4（原 #05A67A）
  await modal.getByRole('button', { name: '图标#4184F4', exact: true }).click();
  const saved = page.waitForResponse((response) => response.url().includes('/api/list-views') && ['POST', 'PUT'].includes(response.request().method()) && response.ok(), { timeout: 15000 });
  await modal.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
  await saved;
  const stored = await api(admin, 'GET', '/api/list-views?page_key=customer-list');
  const builtin = (stored.items ?? []).find((item) => item.conditions?.__builtin === '1');
  if (!builtin) throw new Error('保存后没有全部视图记录');
  if (builtin.conditions?.__quick !== QUICK) throw new Error(`快捷筛选未落库 ${JSON.stringify(builtin.conditions)}`);
  if (builtin.icon !== '#4184F4') throw new Error(`图标未落库 ${builtin.icon}`);
  if (builtin.name !== '全部视图') throw new Error(`名称被改成 ${builtin.name}`);

  await openViewMenu(page);
  await page.getByRole('menuitem', { name: '修改', exact: true }).click();
  const again = viewModal(page);
  await again.waitFor();
  const quickAgain = await again.locator('label').filter({ hasText: '快捷筛选' }).locator('input').inputValue();
  if (quickAgain !== QUICK) throw new Error(`重新打开快捷筛选「${quickAgain}」`);
  const blueIcon = await again.getByRole('button', { name: '图标#4184F4', exact: true }).getAttribute('class');
  if (!blueIcon?.includes('on')) throw new Error('重新打开未选中蓝色图标');
  await again.locator('.ant-modal-footer').getByRole('button', { name: /取\s*消/ }).click();
  await again.waitFor({ state: 'hidden' });

  await openViewMenu(page);
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').last().getByRole('menuitem', { name: '复制', exact: true }).click();
  const copyTab = page.getByRole('button', { name: '全部视图-副本', exact: true });
  await copyTab.waitFor({ timeout: 15000 });
  await page.addStyleTag({ content: '.kgd-top{pointer-events:none!important}' });
  const copyMenu = page.getByRole('button', { name: '全部视图-副本菜单', exact: true });
  await copyMenu.scrollIntoViewIfNeeded();
  await copyMenu.click();
  const deleteItem = page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').last().getByRole('menuitem', { name: '删除', exact: true });
  await deleteItem.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await deleteItem.click();
  const confirm = page.locator('.ant-modal-confirm').filter({ hasText: '删除视图' }).last();
  await confirm.waitFor();
  await confirm.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
  await page.getByRole('button', { name: '全部视图-副本', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });

  await page.getByRole('button', { name: '列配置', exact: true }).click();
  const columns = page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: /^列配置\(\d+\/50\)$/ }) }).last();
  await columns.waitFor();
  const heading = pack(await columns.locator('.ant-modal-title').innerText());
  if (heading !== '列配置(13/50)') throw new Error(`列配置标题「${heading}」`);
  const columnHeads = (await columns.locator('.ant-table-thead th').allInnerTexts()).map(pack);
  if (!columnHeads.includes('锁定') || !columnHeads.includes('列名') || !columnHeads.includes('排序')) throw new Error(`列表头 ${columnHeads.join('|')}`);
  if (await columns.locator('.ant-table-thead').getByRole('checkbox').count() !== 1) throw new Error('表头没有勾选');
  const names = (await columns.locator('.ant-table-tbody tr.ant-table-row td:nth-child(3)').allInnerTexts()).map(pack);
  if (names.join('|') !== COLUMN_ORDER.join('|')) throw new Error(`列顺序 ${names.join('|')}`);
  const footer = columns.locator('.ant-modal-footer button');
  const footerText = (await footer.allInnerTexts()).map(pack);
  if (footerText.join('|') !== '取消|应用到其他人|确定') throw new Error(`底部按钮 ${footerText.join('|')}`);
  const apply = columns.getByRole('button', { name: '应用到其他人', exact: true });
  if (await apply.count() !== 1) throw new Error('没有应用到其他人');
  const applyClass = await apply.getAttribute('class');
  if (!applyClass?.includes('ant-btn-primary')) throw new Error(`应用到其他人不是蓝色主按钮 ${applyClass}`);
  const applyColor = await apply.evaluate((node) => getComputedStyle(node).backgroundColor);
  // 主色 #4184F4 → rgb(65, 132, 244)
  if (applyColor !== 'rgb(65, 132, 244)') throw new Error(`应用到其他人颜色 ${applyColor}`);
  await shot(page, '05-b4-columns.png');

  const distanceRow = columns.locator('.ant-table-row').filter({ hasText: '距离' });
  const box = distanceRow.getByRole('checkbox');
  if (!(await box.isChecked())) throw new Error('距离列默认未勾选');
  await box.click();
  if (await box.isChecked()) throw new Error('取消勾选没有生效');
  await box.click();
  if (!(await box.isChecked())) throw new Error('重新勾选没有生效');
  const lock = distanceRow.getByRole('button', { name: '锁定', exact: true });
  if (await lock.count() !== 1) throw new Error('没有锁定');
  await lock.click();
  await distanceRow.getByRole('button', { name: '取消锁定', exact: true }).waitFor();
  await distanceRow.getByRole('button', { name: '取消锁定', exact: true }).click();
  await distanceRow.getByRole('button', { name: '锁定', exact: true }).waitFor();

  const applied = page.waitForResponse((response) => response.url().includes('/api/list-column-prefs/apply') && response.request().method() === 'POST' && response.ok(), { timeout: 15000 });
  await apply.click();
  const ask = page.locator('.ant-modal-confirm').filter({ hasText: '应用到其他人' }).last();
  await ask.waitFor();
  const askText = pack(await ask.innerText());
  if (!askText.includes('确定将当前列配置应用到本企业其他用户')) throw new Error(`应用到其他人不是确认落库：${askText}`);
  if (!(await ask.getByRole('button', { name: /^\s*确\s*定\s*$/ }).count())) throw new Error('应用到其他人是空提示');
  await ask.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
  const applyRes = await applied;
  const applyBody = await applyRes.json();
  if (typeof applyBody.count !== 'number') throw new Error(`应用到其他人没有返回人数 ${JSON.stringify(applyBody)}`);
  await columns.locator('.ant-modal-footer').getByRole('button', { name: /取\s*消/ }).click();
  await columns.waitFor({ state: 'hidden' });

  await cleanupViews(admin);
  const hashes = new Set(shots.map((item) => item.hash));
  if (hashes.size !== shots.length) throw new Error(`截图 MD5 重复 ${shots.map((item) => item.hash).join(' ')}`);
  const record = [
    '# 客户列表修改视图与列配置验收',
    '',
    `- 快捷筛选落库：${QUICK}`,
    `- 图标落库：#4184F4`,
    `- 应用到其他人：${applyBody.count} 人`,
    '',
    ...shots.map((item) => `- ${item.name} ${item.hash}`),
    '',
  ].join('\n');
  writeFileSync(path.join(outDir, '验收记录.md'), record);
  writeFileSync(path.join(artifactDir, '验收记录.md'), record);
  console.log(record);
} finally {
  await browser.close();
}
