/**
 * 精益会议议程字段 / 扩展字段验收。只用 Playwright。
 * 前置：npm run dev:setup && npm run dev
 * 截图：docs/verification/meeting-agenda-fields
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/meeting-agenda-fields');
mkdirSync(outDir, { recursive: true });

const FIELD = 'PW议程验收';
const FIELD_EDITED = 'PW议程验收改';
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
  for (const entity of ['meeting_agenda', 'lean_meeting']) {
    const data = await api(session, 'GET', `/api/entity-ext-fields?entity=${entity}`);
    for (const item of data.items ?? []) {
      if (String(item.name).startsWith('PW议程')) await api(session, 'DELETE', `/api/entity-ext-fields/${item.id}`, {});
    }
  }
}

async function headerTexts(dialog) {
  const cells = dialog.locator('.ant-table-thead th');
  await cells.first().waitFor({ timeout: 15000 });
  return (await cells.allTextContents()).map(pack);
}

function mustColumns(actual, label) {
  if (actual.join('|') !== COLUMNS.join('|')) throw new Error(`${label}列名不符。实际：${actual.join(' | ')}`);
}

const pass = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!pass) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local 密码，请先 npm run dev:setup');
const admin = await login('admin.local', pass);
await cleanup(admin);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await asUser(page, admin);
  await page.goto(`${WEB}/meeting/list`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByRole('button', { name: '新建会议', exact: true }).waitFor({ timeout: 20000 });

  const bar = page.locator('.kgd-card > .kgd-toolbar');
  const labels = (await bar.locator('button').allInnerTexts()).map(pack);
  const expected = ['新建会议', '扩展字段', '会议议程字段', '列配置', '更多操作'];
  let prev = -1;
  for (const name of expected) {
    const index = labels.findIndex((text) => text.includes(name));
    if (index < 0) throw new Error(`工具栏缺少「${name}」。实际：${labels.join(' | ')}`);
    if (index <= prev) throw new Error(`工具栏「${name}」顺序不对。实际：${labels.join(' | ')}`);
    prev = index;
  }
  if (labels.some((text) => text.includes('高级查询'))) throw new Error(`工具栏多出高级查询：${labels.join(' | ')}`);
  await bar.getByRole('button', { name: '更多操作', exact: true }).click();
  const menu = page.locator('.ant-dropdown:visible');
  await menu.waitFor();
  const menuText = pack(await menu.innerText());
  if (!menuText.includes('导出(显示列)')) throw new Error(`更多操作缺少导出(显示列)：${menuText}`);
  if (menuText.includes('导出(所有列)')) throw new Error(`更多操作多出导出(所有列)：${menuText}`);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: shot('01-list.png'), fullPage: true });

  await bar.getByRole('button', { name: '扩展字段', exact: true }).click();
  const ext = page.getByRole('dialog', { name: '精益会议扩展字段管理' });
  await ext.waitFor();
  mustColumns(await headerTexts(ext), '扩展字段');
  if (await ext.getByRole('button', { name: /新\s*增/ }).count() !== 1) throw new Error('扩展字段缺新增');
  if (await ext.locator('.ant-empty-description', { hasText: '暂无数据' }).count() < 1) throw new Error('扩展字段空表未显示暂无数据');
  await page.screenshot({ path: shot('04-extension.png') });
  await ext.locator('.ant-modal-close').click();
  await ext.waitFor({ state: 'hidden' });

  await bar.getByRole('button', { name: '会议议程字段', exact: true }).click();
  const agenda = page.getByRole('dialog', { name: '会议议程字段管理' });
  await agenda.waitFor();
  mustColumns(await headerTexts(agenda), '会议议程字段');
  if (await agenda.locator('.ant-empty-description', { hasText: '暂无数据' }).count() < 1) throw new Error('议程字段空表未显示暂无数据');
  await page.screenshot({ path: shot('02-agenda-empty.png') });

  await agenda.getByRole('button', { name: /新\s*增/ }).click();
  const add = page.getByRole('dialog', { name: '新增议程字段' });
  await add.waitFor();
  await add.locator('input').first().fill(FIELD);
  await add.locator('.ant-select').nth(0).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^是$/ }).click();
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden' });
  await add.locator('.ant-select').nth(1).click();
  const typePopup = page.locator('.ext-type-popup');
  await typePopup.getByText('单行文本', { exact: true }).waitFor();
  const options = await typePopup.locator('.ant-select-item-option').allInnerTexts();
  const packedOptions = options.map(pack);
  for (const type of TYPES) {
    if (!packedOptions.some((text) => text.includes(type))) throw new Error(`字段类型缺少「${type}」。实际：${packedOptions.join(' | ')}`);
  }
  if (packedOptions.some((text) => text === '公式')) throw new Error('议程字段不应出现公式类型');
  await page.keyboard.press('Escape');
  await typePopup.waitFor({ state: 'hidden' });
  await add.getByRole('button', { name: /确\s*定/ }).click();
  await add.waitFor({ state: 'hidden' });
  await agenda.getByText(FIELD, { exact: true }).waitFor();
  if (await agenda.getByText('是', { exact: true }).count() < 1) throw new Error('必填未显示为是');
  if (await agenda.getByText('单行文本', { exact: true }).count() < 1) throw new Error('类型未显示为单行文本');

  const created = (await api(admin, 'GET', '/api/entity-ext-fields?entity=meeting_agenda')).items ?? [];
  const saved = created.find((item) => item.name === FIELD);
  if (!saved) throw new Error(`落库后查不到「${FIELD}」：${JSON.stringify(created)}`);
  if (saved.field_type !== '单行文本' || saved.required !== true) throw new Error(`落库内容不符：${JSON.stringify(saved)}`);
  await page.screenshot({ path: shot('03-agenda-row.png') });

  await agenda.getByRole('button', { name: /修\s*改/ }).click();
  const edit = page.getByRole('dialog', { name: '修改议程字段' });
  await edit.waitFor();
  const nameInput = edit.locator('input').first();
  if (await nameInput.inputValue() !== FIELD) throw new Error('修改弹窗没有带回字段名');
  await nameInput.fill(FIELD_EDITED);
  await edit.getByRole('button', { name: /确\s*定/ }).click();
  await edit.waitFor({ state: 'hidden' });
  await agenda.getByText(FIELD_EDITED, { exact: true }).waitFor();
  const edited = ((await api(admin, 'GET', '/api/entity-ext-fields?entity=meeting_agenda')).items ?? []).find((item) => item.id === saved.id);
  if (!edited || edited.name !== FIELD_EDITED) throw new Error(`修改未落库：${JSON.stringify(edited)}`);

  await agenda.getByRole('button', { name: /删\s*除/ }).click();
  await agenda.getByText(FIELD_EDITED, { exact: true }).waitFor({ state: 'hidden' });
  await agenda.locator('.ant-empty-description', { hasText: '暂无数据' }).waitFor();
  const left = (await api(admin, 'GET', '/api/entity-ext-fields?entity=meeting_agenda')).items ?? [];
  if (left.some((item) => item.id === saved.id)) throw new Error('删除后库里仍有该字段');
  await page.screenshot({ path: shot('02-agenda-empty.png') });
  await agenda.locator('.ant-modal-close').click();

  console.log('meeting-agenda-fields accept ok');
} finally {
  await browser.close();
  await cleanup(admin);
}
