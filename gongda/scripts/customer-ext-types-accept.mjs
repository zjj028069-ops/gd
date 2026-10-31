/**
 * 客户列表扩展字段验收。只用 Playwright。
 * 打开【客户管理】扩展字段管理 → 断言 16 种中文类型顺序 → 新增单行文本落库 → API 可查 → 删除。
 * 前置：npm run dev:setup && npm run dev
 * 截图：docs/verification/customer-ext-types
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/customer-ext-types');
mkdirSync(outDir, { recursive: true });

const FIELD = `PW客户扩展${Date.now().toString().slice(-6)}`;
const TYPES = ['单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间', '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '关联对象', '关联属性'];
const COLUMNS = ['排序', '字段名', '字段类型', '是否必填', '创建时间', '操作'];

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

function shot(name) {
  return path.join(outDir, name);
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

async function cleanup(session) {
  const data = await api(session, 'GET', '/api/entity-ext-fields?entity=customer');
  for (const item of data.items ?? []) {
    if (String(item.name).startsWith('PW客户扩展')) await api(session, 'DELETE', `/api/entity-ext-fields/${item.id}`, {});
  }
}

async function headerTexts(dialog) {
  const cells = dialog.locator('.ant-table-thead th');
  await cells.first().waitFor({ timeout: 15000 });
  return (await cells.allTextContents()).map(pack);
}

async function collectTypes(page) {
  const popup = page.locator('.ext-type-popup');
  await popup.waitFor();
  const holder = popup.locator('.ant-select-dropdown-list-holder, .rc-virtual-list-holder');
  const seen = [];
  for (let i = 0; i < 40; i += 1) {
    const texts = (await popup.locator('.ant-select-item-option-content').allInnerTexts()).map(pack).filter(Boolean);
    for (const text of texts) if (!seen.includes(text)) seen.push(text);
    if (seen.length >= TYPES.length) break;
    if (!(await holder.count())) break;
    const moved = await holder.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollTop + 160, el.scrollHeight);
      return el.scrollTop !== before;
    });
    if (!moved && seen.length) break;
    await page.waitForTimeout(40);
  }
  return seen;
}

const pass = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!pass) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local 密码，请先 npm run dev:setup');
const admin = await login('admin.local', pass);
await cleanup(admin);
const beforeItems = (await api(admin, 'GET', '/api/entity-ext-fields?entity=customer')).items ?? [];
if (beforeItems.length) throw new Error(`客户扩展字段不是空表，拒绝在脏数据上验空态：${beforeItems.map((item) => item.name).join(' | ')}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await asUser(page, admin);
  await page.goto(`${WEB}/customer/list`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.locator('.kgd-toolbar').getByRole('button', { name: '扩展字段', exact: true }).waitFor({ timeout: 30000 });

  await page.locator('.kgd-toolbar').getByRole('button', { name: '扩展字段', exact: true }).click();
  const ext = page.getByRole('dialog', { name: '【客户管理】扩展字段管理' });
  await ext.waitFor();
  if (await page.locator('.ant-modal-confirm').count()) throw new Error('扩展字段打开成了 Modal.info 空壳');
  const title = pack(await ext.locator('.ant-modal-title').innerText());
  if (title !== '【客户管理】扩展字段管理') throw new Error(`标题不符：${title}`);
  const columns = await headerTexts(ext);
  if (columns.join('|') !== COLUMNS.join('|')) throw new Error(`列名不符。实际：${columns.join(' | ')}`);
  if (await ext.getByRole('button', { name: /新\s*增/ }).count() !== 1) throw new Error('扩展字段缺新增');
  if (await ext.locator('.ant-table').count() !== 1) throw new Error('扩展字段管理没有表格');
  if (await ext.locator('.ant-empty-description', { hasText: '暂无数据' }).count() < 1) throw new Error('空表未显示暂无数据');
  await page.screenshot({ path: shot('01-ext-empty.png') });

  await ext.getByRole('button', { name: /新\s*增/ }).click();
  const add = page.getByRole('dialog', { name: '新增扩展字段' });
  await add.waitFor();
  for (const label of ['字段名', '是否必填', '字段类型']) {
    if (await add.locator('label').filter({ hasText: label }).count() < 1) throw new Error(`新增弹窗缺少「${label}」`);
  }
  await add.locator('label').filter({ hasText: '字段类型' }).locator('.ant-select').click();
  const packedOptions = await collectTypes(page);
  if (packedOptions.join('|') !== TYPES.join('|')) {
    throw new Error(`字段类型顺序不符。\n期望：${TYPES.join(' | ')}\n实际：${packedOptions.join(' | ')}`);
  }
  if (packedOptions.some((text) => text === '公式')) throw new Error('客户扩展不应出现公式');
  if (packedOptions.some((text) => /^[A-Za-z0-9_./-]+$/.test(text))) throw new Error(`字段类型出现英文 key：${packedOptions.join(' | ')}`);
  await page.screenshot({ path: shot('02-types.png') });
  await page.locator('.ext-type-popup .ant-select-dropdown-list-holder, .ext-type-popup .rc-virtual-list-holder').evaluate((el) => {
    el.style.maxHeight = '640px';
    el.style.overflow = 'visible';
  });
  await page.locator('.ext-type-popup').screenshot({ path: shot('02-types-all.png') });
  await page.keyboard.press('Escape');
  await page.locator('.ext-type-popup').waitFor({ state: 'hidden' });

  await add.locator('input').first().fill(FIELD);
  await add.locator('.ant-select').nth(0).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^是$/ }).click();
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden' });
  const createdResp = page.waitForResponse((res) => res.url().includes('/api/entity-ext-fields') && res.request().method() === 'POST' && res.ok(), { timeout: 15000 });
  await add.getByRole('button', { name: /确\s*定/ }).click();
  const createdJson = await (await createdResp).json();
  await add.waitFor({ state: 'hidden' });
  await ext.getByText(FIELD, { exact: true }).waitFor();
  const row = ext.locator('.ant-table-tbody tr', { hasText: FIELD });
  const cells = (await row.locator('td').allInnerTexts()).map((text) => text.trim());
  if (!cells.includes(FIELD)) throw new Error(`列表未见字段名：${cells.join(' | ')}`);
  if (!cells.includes('单行文本')) throw new Error(`列表未见单行文本：${cells.join(' | ')}`);
  if (!cells.includes('是')) throw new Error(`必填未显示为是：${cells.join(' | ')}`);
  if (!cells.some((text) => /\d{4}-\d{2}-\d{2}/.test(text))) throw new Error(`创建时间未显示：${cells.join(' | ')}`);

  const saved = ((await api(admin, 'GET', '/api/entity-ext-fields?entity=customer')).items ?? []).find((item) => item.name === FIELD);
  if (!saved) throw new Error(`API 查不到「${FIELD}」`);
  if (saved.id !== createdJson.item?.id) throw new Error(`落库 id 与接口返回不一致：${saved.id} / ${createdJson.item?.id}`);
  if (saved.field_type !== '单行文本' || saved.required !== true) throw new Error(`落库内容不符：${JSON.stringify(saved)}`);
  await page.screenshot({ path: shot('03-row.png') });

  const deletedResp = page.waitForResponse((res) => res.url().includes(`/api/entity-ext-fields/${saved.id}`) && res.request().method() === 'DELETE' && res.ok(), { timeout: 15000 });
  await row.getByRole('button', { name: /删\s*除/ }).click();
  await deletedResp;
  await ext.getByText(FIELD, { exact: true }).waitFor({ state: 'hidden' });
  await ext.locator('.ant-empty-description', { hasText: '暂无数据' }).waitFor();
  const left = (await api(admin, 'GET', '/api/entity-ext-fields?entity=customer')).items ?? [];
  if (left.some((item) => item.id === saved.id || item.name === FIELD)) throw new Error('删除后 API 仍能查到该字段');
  await page.screenshot({ path: shot('04-deleted.png') });
  await ext.locator('.ant-modal-close').click();

  console.log(`customer-ext-types accept ok ${FIELD} ${saved.id}`);
} finally {
  await browser.close();
  await cleanup(admin);
}
