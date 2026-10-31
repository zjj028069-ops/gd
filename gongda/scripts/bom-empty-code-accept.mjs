#!/usr/bin/env node
/**
 * BOM 空编号保存验收。
 * 前置：npm run dev:setup && npm run dev
 * 仅 Playwright。断言失败即退出，不改断言。
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/bom-empty-code';
mkdirSync(artifactDir, { recursive: true });

function passwordOf(username) {
  const text = readFileSync('.local/dev-credentials.txt', 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  if (!matched) throw new Error(`找不到账号 ${username} 的密码`);
  return matched[1];
}

function shanghaiDay() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const read = (type) => parts.find((part) => part.type === type).value;
  return read('year') + read('month') + read('day');
}

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
  });
  const json = await res.json().catch(() => ({}));
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token || !cookie) throw new Error(`登录失败 ${username}: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return { csrf: json.csrf_token, cookie };
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
}

async function shot(page, name) {
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('截图', file);
  return file;
}

async function productCatalog(session) {
  const res = await fetch(`${API}/api/products?page=1&page_size=100`, { headers: { cookie: session.cookie } });
  const json = await res.json();
  if (!res.ok) throw new Error(`读取商品失败 ${res.status}`);
  const items = json.items ?? [];
  if (!items.length) throw new Error('没有商品可供选择');
  return items.map((item) => ({ code: String(item.code ?? ''), name: String(item.name ?? ''), attribute: String(item.attribute ?? '') }));
}

async function assertNameOnly(page, select, products, title) {
  await select.click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-item-option').first().waitFor({ state: 'visible' });
  const texts = (await dropdown.locator('.ant-select-item-option').allInnerTexts()).map((text) => text.trim()).filter(Boolean);
  if (!texts.length) throw new Error(`${title}没有选项`);
  for (const text of texts) {
    const joined = products.some((item) => item.code && (text === `${item.code} ${item.name}` || text.startsWith(`${item.code} `)));
    if (joined) throw new Error(`${title}仍显示「编码 名称」：${text}`);
    if (!products.some((item) => item.name === text)) throw new Error(`${title}选项不是纯商品名：${text}`);
  }
  return { dropdown, texts };
}

async function assertShortSwitches(page, label) {
  const switches = page.locator('.kgd-form .ant-switch');
  const count = await switches.count();
  if (!count) throw new Error(`${label}没有开关`);
  const widths = [];
  for (let index = 0; index < count; index += 1) {
    const box = await switches.nth(index).boundingBox();
    if (!box) throw new Error(`${label}第 ${index + 1} 个开关不可见`);
    widths.push(Math.round(box.width));
    if (box.width < 36 || box.width > 64) throw new Error(`${label}开关被拉长或异常，宽度 ${Math.round(box.width)}px`);
  }
  return widths;
}

async function chooseProduct(page, products) {
  await page.getByRole('button', { name: '选择商品' }).click();
  const select = page.locator('.ant-table .ant-select').first();
  const { dropdown, texts } = await assertNameOnly(page, select, products, '商品名');
  await dropdown.locator('.ant-select-item-option').first().click();
  const shown = (await select.locator('.ant-select-content').innerText()).trim();
  if (shown !== texts[0]) throw new Error(`商品名列选中后不是纯商品名：${shown}`);
  if (products.some((item) => item.code && shown.startsWith(`${item.code} `))) throw new Error(`商品名列仍拼接编号：${shown}`);
  return shown;
}

async function saveBom(page, { code, name, products, checkChrome }) {
  await page.goto(`${WEB}/bom/add`, { waitUntil: 'networkidle' });
  const codeInput = page.getByPlaceholder('请填写，忽略将自动生成');
  await codeInput.waitFor();
  if (checkChrome) {
    const switchWidths = await assertShortSwitches(page, '设为默认BOM');
    const parent = page.locator('.kgd-form .ant-select').first();
    const made = products.filter((item) => item.attribute === 'manufactured');
    if (!made.length) throw new Error('没有自产商品可供「商品」下拉验收');
    await assertNameOnly(page, parent, made, '商品');
    await page.keyboard.press('Escape');
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    console.log('默认BOM开关宽度', switchWidths.join(','));
  }
  if (code) await codeInput.fill(code);
  else await codeInput.fill('');
  await page.locator('.kgd-form input.ant-input').nth(1).fill(name);
  await chooseProduct(page, products);
  await shot(page, code ? '02-manual-before-save' : '01-empty-before-save');
  if (checkChrome) await page.locator('.kgd-form').screenshot({ path: path.join(artifactDir, '06-form-switch-and-name.png') });
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await page.waitForURL(/\/bom\/list/, { timeout: 15000 });
  const banner = page.locator('.kgd-banner');
  if (await banner.count()) {
    const text = await banner.first().innerText();
    throw new Error(`保存后仍有黄条：${text}`);
  }
  await page.getByText(name).first().waitFor({ timeout: 10000 });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  const session = await login('admin.local', passwordOf('admin.local'));
  await asUser(page, session);
  const products = await productCatalog(session);
  const day = shanghaiDay();
  const emptyName = `空编号验收${Date.now().toString().slice(-6)}`;
  await saveBom(page, { name: emptyName, products, checkChrome: true });
  const row = page.locator('tr', { hasText: emptyName });
  await row.waitFor();
  const rowText = await row.innerText();
  if (rowText.includes('编号格式不正确')) throw new Error('列表出现编号格式不正确');
  const matched = rowText.match(/BOM\d{12}/);
  if (!matched) throw new Error(`列表未出现自动编号：${rowText}`);
  if (!matched[0].startsWith(`BOM${day}`)) throw new Error(`自动编号不是当天流水：${matched[0]}`);
  await shot(page, '03-empty-list');
  await row.getByRole('button', { name: /修\s*改/ }).click();
  await page.waitForURL(/\/bom\/edit\//);
  const codeInput = page.getByPlaceholder('请填写，忽略将自动生成');
  await page.waitForFunction((expected) => {
    const input = document.querySelector('input[placeholder="请填写，忽略将自动生成"]');
    return input instanceof HTMLInputElement && input.value === expected;
  }, matched[0], { timeout: 10000 });
  const detailCode = await codeInput.inputValue();
  if (detailCode !== matched[0]) throw new Error(`详情编号 ${detailCode} 与列表 ${matched[0]} 不一致`);
  await shot(page, '04-empty-detail');

  const manual = `手填${Date.now().toString().slice(-6)}`;
  const manualName = `手填编号验收${Date.now().toString().slice(-6)}`;
  await saveBom(page, { code: manual, name: manualName, products });
  const manualRow = page.locator('tr', { hasText: manualName });
  await manualRow.waitFor();
  const manualText = await manualRow.innerText();
  if (!manualText.includes(manual)) throw new Error(`手填编号未保留：${manualText}`);
  if (manualText.includes('编号格式不正确')) throw new Error('手填保存出现编号格式不正确');
  await shot(page, '05-manual-list');
  await page.goto(`${WEB}/setting/enterprise/setting`, { waitUntil: 'networkidle' });
  await page.getByText('生产模块').waitFor();
  const enterpriseWidths = await assertShortSwitches(page, '企业信息');
  await shot(page, '07-enterprise-switches');
  console.log('通过', { auto: matched[0], manual, enterpriseWidths });
} finally {
  await browser.close();
}
