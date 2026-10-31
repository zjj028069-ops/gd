/**
 * ListFrame 高级查询默认关闭 + 联系人工具栏对照 B7c。只用 Playwright。
 * 联系人：关键字 / 查询 / 高级查询 / 新增 / 扩展字段 / 列配置，没有「更多」「更多操作」。
 * 客户列表、销售对账、精益会议：工具栏不出现「高级查询」。
 * 前置：npm run dev:setup && npm run dev
 * 截图：docs/verification/listframe-adv-toolbar
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/listframe-adv-toolbar');
mkdirSync(outDir, { recursive: true });

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
  return { csrf: json.csrf_token, cookie };
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
  if (!res.ok) throw new Error(`${method} ${urlPath} ${res.status}: ${text.slice(0, 400)}`);
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

async function barLabels(page) {
  return page.locator('.kgd-card').first().evaluate(() => {
    const seen = new Set();
    const labels = [];
    for (const root of document.querySelectorAll('.kgd-query, .kgd-toolbar')) {
      for (const button of root.querySelectorAll('button')) {
        if (seen.has(button)) continue;
        seen.add(button);
        const text = (button.innerText || button.getAttribute('aria-label') || '').replace(/\s+/g, '');
        if (text) labels.push(text);
      }
    }
    return labels;
  });
}

function mustHave(labels, names, where) {
  for (const name of names) {
    if (!labels.some((text) => text.includes(name))) throw new Error(`${where} 缺少「${name}」。实际：${labels.join(' | ')}`);
  }
}

function mustLack(labels, names, where) {
  for (const name of names) {
    if (labels.some((text) => text === name || text.includes(name))) throw new Error(`${where} 多出「${name}」。实际：${labels.join(' | ')}`);
  }
}

function nameRe(name) {
  const body = [...name].map((ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch)).join('\\s*');
  return new RegExp(body);
}

async function openPage(page, urlPath, readyName) {
  await page.goto(`${WEB}${urlPath}`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  const ready = page.getByRole('button', { name: nameRe(readyName) }).first();
  try {
    await ready.waitFor({ timeout: 30000 });
  } catch (error) {
    const text = pack(await page.locator('body').innerText());
    throw new Error(`${urlPath} 等不到「${readyName}」。页面：${text.slice(0, 400)}`, { cause: error });
  }
  await page.locator('.kgd-toolbar').first().waitFor({ timeout: 15000 });
}

const pass = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!pass) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local 密码，请先 npm run dev:setup');
const admin = await login('admin.local', pass);
const stamp = Date.now().toString().slice(-6);
const contactName = `王验收${stamp}`;
await api(admin, 'POST', '/api/money/customers', {
  name: `联系人验收客户${stamp}`,
  contact_name: contactName,
  contact_phone: `13${String(Date.now()).slice(-9)}`,
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await asUser(page, admin);

  await openPage(page, '/linkman/list', '新增');
  const keyword = page.getByPlaceholder('输入关键字查询');
  await keyword.waitFor();
  const linkman = await barLabels(page);
  mustHave(linkman, ['查询', '高级查询', '+新增', '扩展字段', '列配置'], '联系人');
  mustLack(linkman, ['更多', '更多操作', '移动端卡片配置', '操作记录', '批量操作'], '联系人');
  const queryIndex = linkman.indexOf('查询');
  const advIndex = linkman.indexOf('高级查询');
  if (queryIndex < 0 || advIndex < queryIndex) throw new Error(`联系人查询行顺序不对：${linkman.join(' | ')}`);
  const queryText = pack(await page.locator('.kgd-query').innerText());
  if (!queryText.includes('高级查询')) throw new Error('高级查询不在查询行');
  const splitText = pack(await page.locator('.kgd-toolbar-split').innerText());
  if (splitText.includes('高级查询') || splitText.includes('更多')) throw new Error(`操作栏不该有高级查询或更多：${splitText}`);
  if (!splitText.includes('+新增') || !splitText.includes('扩展字段') || !splitText.includes('列配置')) {
    throw new Error(`操作栏缺新增/扩展字段/列配置：${splitText}`);
  }
  if (await page.locator('.kgd-views').count()) throw new Error('联系人原版没有视图页签');
  await page.getByText(contactName).waitFor();
  await page.screenshot({ path: shot('01-linkman-toolbar.png') });

  await page.locator('.kgd-query').getByRole('button', { name: /高\s*级\s*查\s*询/ }).click();
  const panel = page.locator('.kgd-adv');
  await panel.waitFor();
  const panelText = pack(await panel.innerText());
  for (const name of ['客户', '联系人', '联系人电话', '添加筛选条件', '搜索', '清空筛选值']) {
    if (!panelText.includes(name)) throw new Error(`高级查询面板缺「${name}」：${panelText}`);
  }
  await page.screenshot({ path: shot('02-linkman-adv.png') });
  await panel.getByRole('button', { name: /搜\s*索/ }).click();
  await panel.waitFor({ state: 'hidden' });

  const marker = `zz-no-linkman-${Date.now().toString().slice(-6)}`;
  await keyword.fill(marker);
  const filtered = page.waitForResponse((res) => res.url().includes('/api/crm/contacts') && res.url().includes(encodeURIComponent(marker)) && res.ok());
  await page.locator('.kgd-query').getByRole('button', { name: '查询', exact: true }).click();
  const filteredJson = await (await filtered).json();
  if ((filteredJson.items ?? []).length !== 0) throw new Error(`关键字未过滤：${JSON.stringify(filteredJson).slice(0, 200)}`);
  await page.locator('.ant-table .ant-empty-description').waitFor();
  const cleared = page.waitForResponse((res) => res.url().includes('/api/crm/contacts') && !res.url().includes(encodeURIComponent(marker)) && res.ok());
  await page.locator('.kgd-query').getByRole('button', { name: '清除查询条件', exact: true }).click();
  await cleared;
  await page.getByText(contactName).waitFor();

  await openPage(page, '/customer/list', '新增');
  const customer = await barLabels(page);
  mustHave(customer, ['新增', '扩展字段', '列配置', '更多操作'], '客户列表');
  mustLack(customer, ['高级查询'], '客户列表');
  await page.screenshot({ path: shot('03-customer-toolbar.png') });

  await openPage(page, '/sales_statement', '查询');
  const sales = await barLabels(page);
  mustHave(sales, ['查询', '列配置', '更多操作'], '销售对账');
  mustLack(sales, ['高级查询'], '销售对账');
  await page.screenshot({ path: shot('04-sales-toolbar.png') });

  await openPage(page, '/meeting/list', '新建会议');
  const meeting = await barLabels(page);
  mustHave(meeting, ['新建会议', '扩展字段', '会议议程字段', '列配置', '更多操作'], '精益会议');
  mustLack(meeting, ['高级查询'], '精益会议');
  const meetingBar = page.locator('.kgd-card > .kgd-toolbar');
  const meetingOrder = (await meetingBar.locator('button').allInnerTexts()).map(pack);
  let prev = -1;
  for (const name of ['新建会议', '扩展字段', '会议议程字段', '列配置', '更多操作']) {
    const index = meetingOrder.findIndex((text) => text.includes(name));
    if (index < 0 || index <= prev) throw new Error(`精益会议工具栏顺序不对：${meetingOrder.join(' | ')}`);
    prev = index;
  }
  await page.screenshot({ path: shot('05-meeting-toolbar.png') });

  console.log('通过 联系人/客户/销售对账/精益会议 工具栏');
} finally {
  await browser.close();
}
