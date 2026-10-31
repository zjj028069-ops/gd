/**
 * 新增商品六项验收：单位唯一、佣金互算、来源加宽、附件预览、单位必填、来源说明。
 * 仅 Playwright。前置：API 3001 与 WEB 5173 已启动，.local/dev-credentials.txt 可用。
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = path.join(process.cwd(), 'docs/verification/goods-form-six');
const optDir = '/opt/cursor/artifacts/goods-form-six';
mkdirSync(artifactDir, { recursive: true });
mkdirSync(optDir, { recursive: true });

const shots = [];

function must(ok, message) {
  if (!ok) throw new Error(message);
}

function passwordOf(file, username) {
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.from(type);
  const body = Buffer.concat([head, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  head.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function solidPng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 3 + 1);
    raw[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[offset + 1 + x * 3] = rgb[0];
      raw[offset + 2 + x * 3] = rgb[1];
      raw[offset + 3 + x * 3] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
}

async function shot(page, name, { keepPointer = false } = {}) {
  if (!keepPointer) await page.mouse.move(8, 8);
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const bytes = readFileSync(file);
  writeFileSync(path.join(optDir, `${name}.png`), bytes);
  const md5 = createHash('md5').update(bytes).digest('hex');
  shots.push({ name, md5 });
  return md5;
}

async function inputValue(locator) {
  return locator.inputValue();
}

const pass = passwordOf('.local/dev-credentials.txt', 'admin.local');
must(pass, '缺少 .local/dev-credentials.txt 中 admin.local 密码');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  const session = await login('admin.local', pass);
  await asUser(page, session);
  await page.goto(`${WEB}/goods/list?add=1`, { waitUntil: 'networkidle', timeout: 60000 });
  const editor = page.locator('.goods-editor');
  await editor.getByText('新增商品', { exact: true }).waitFor({ timeout: 30000 });
  const save = editor.getByRole('button', { name: /保\s*存/ });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.goods-editor .ant-btn')].find((node) => /保\s*存/.test(node.textContent || ''));
    return !!button && !button.classList.contains('ant-btn-loading') && !button.hasAttribute('disabled');
  }, null, { timeout: 30000 });

  const unitLabel = editor.locator('.goods-field').filter({ has: page.locator('label', { hasText: /^(\s|\*)*单位/ }) }).first();
  const star = unitLabel.locator('.goods-star');
  await star.waitFor();
  must((await star.innerText()).trim() === '*', '单位标签缺少星号');
  const starColor = await star.evaluate((node) => getComputedStyle(node).color);
  must(starColor === 'rgb(255, 77, 79)', `单位星号不是红色：${starColor}`);

  const sale = page.getByRole('textbox', { name: '销售单价' });
  const source = editor.locator('.goods-source');
  await sale.waitFor();
  await source.waitFor();
  const saleBox = await sale.boundingBox();
  const sourceBox = await source.boundingBox();
  must(saleBox && sourceBox, '销售单价或商品来源无法测量');
  must(sourceBox.width >= saleBox.width, `商品来源宽度 ${sourceBox.width} 小于同列销售单价 ${saleBox.width}`);

  async function tipText(label) {
    await page.mouse.move(8, 8);
    await page.locator('.ant-tooltip-container').last().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
    await page.locator(`[aria-label="${label}"]`).hover();
    const tip = page.locator('.ant-tooltip-container').last();
    await tip.waitFor({ timeout: 5000 });
    return tip.innerText();
  }
  const sourceTipText = await tipText('商品来源说明');
  must(sourceTipText.includes('外购') && sourceTipText.includes('自产') && sourceTipText.includes('外协加工'), `来源说明缺少三种含义：${sourceTipText}`);
  const commissionTipText = await tipText('售后佣金说明');
  must(commissionTipText.includes('百分比仅供快捷计算使用') && commissionTipText.includes('佣金互算只认销售单价，请先填写销售单价。'), `售后佣金说明不完整：${commissionTipText}`);
  await shot(page, '06-commission-hint', { keepPointer: true });
  await page.mouse.move(8, 8);

  await source.click();
  const option = page.locator('.ant-select-item-option-content', { hasText: '外协加工' });
  await option.waitFor();
  const clipped = await option.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  must(!clipped, '外协加工在来源下拉里被截断');
  await shot(page, '01-star-source-width');
  await page.keyboard.press('Escape');

  const nameBox = editor.locator('.goods-field').filter({ has: page.locator('label', { hasText: '商品名' }) }).locator('input');
  await nameBox.fill('验收商品六项');
  await save.click();
  await editor.locator('.kgd-banner.kgd-field-error', { hasText: '请选择单位' }).waitFor({ timeout: 5000 });
  must(await editor.getByText('新增商品', { exact: true }).isVisible(), '未选单位时弹窗被关掉了');

  const yuan = page.getByRole('textbox', { name: '售后佣金元' });
  const percent = page.getByRole('textbox', { name: '售后佣金比例' });
  await sale.fill('10');
  await yuan.fill('5');
  await page.waitForFunction(() => {
    const node = document.querySelector('[aria-label="售后佣金比例"]');
    return node instanceof HTMLInputElement && node.value === '50';
  }, null, { timeout: 5000 });
  must(await inputValue(percent) === '50', `填 5 元后比例不是 50，实际 ${await inputValue(percent)}`);
  must(await inputValue(yuan) === '5', '佣金元被改掉');
  await shot(page, '02-commission-yuan-to-percent');

  await percent.fill('');
  await percent.fill('10');
  await page.waitForFunction(() => {
    const node = document.querySelector('[aria-label="售后佣金元"]');
    return node instanceof HTMLInputElement && node.value === '1';
  }, null, { timeout: 5000 });
  must(await inputValue(yuan) === '1', `填 10% 后金额不是 1，实际 ${await inputValue(yuan)}`);
  must(await inputValue(percent) === '10', '佣金比例被改掉');
  await shot(page, '03-commission-percent-to-yuan');

  await sale.fill('');
  await yuan.fill('8');
  must(await inputValue(percent) === '10', `销售单价为空时仍强算了比例：${await inputValue(percent)}`);
  await sale.fill('0');
  await percent.fill('20');
  must(await inputValue(yuan) === '8', `销售单价为 0 时仍强算了金额：${await inputValue(yuan)}`);
  must(await inputValue(percent) === '20', '比例输入没有保留');

  await editor.getByRole('button', { name: '管理单位' }).click();
  const unitBoard = page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: '单位管理' }) });
  await unitBoard.getByText('个', { exact: true }).waitFor({ timeout: 15000 });
  const beforeCount = await page.evaluate(async () => {
    const data = await fetch('/api/units', { credentials: 'same-origin' }).then((response) => response.json());
    return data.items.filter((item) => item.name === '个').length;
  });
  must(beforeCount === 1, `预期已有 1 个「个」，实际 ${beforeCount}`);
  await unitBoard.getByRole('button', { name: '+新增' }).click();
  const unitDraft = page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: '新增单位' }) });
  await unitDraft.locator('input').fill('个');
  await unitDraft.getByRole('button', { name: /确\s*定/ }).click();
  await unitDraft.getByText('该单位已存在').waitFor({ timeout: 5000 });
  await shot(page, '04-unit-duplicate');
  const afterCount = await page.evaluate(async () => {
    const data = await fetch('/api/units', { credentials: 'same-origin' }).then((response) => response.json());
    return data.items.filter((item) => item.name === '个').length;
  });
  must(afterCount === beforeCount, '重复单位被写入了');
  const apiDup = await page.evaluate(async () => {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((response) => response.json());
    const response = await fetch('/api/units', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf_token },
      body: JSON.stringify({ code: `DUP${Date.now().toString(36)}`, name: '个' }),
    });
    return { status: response.status, body: await response.json() };
  });
  must(apiDup.status === 409 && apiDup.body?.error?.message === '该单位已存在', `后端未拒绝重复单位 ${JSON.stringify(apiDup)}`);
  const still = await page.evaluate(async () => {
    const data = await fetch('/api/units', { credentials: 'same-origin' }).then((response) => response.json());
    return data.items.filter((item) => item.name === '个').length;
  });
  must(still === beforeCount, '后端重复提交把单位写进去了');

  await unitDraft.getByRole('button', { name: /取\s*消/ }).click();
  const meter = unitBoard.locator('tr').filter({ has: page.locator('td', { hasText: /^米$/ }) });
  await meter.getByRole('button', { name: /修\s*改/ }).click();
  const editDraft = page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: '修改单位' }) });
  await editDraft.locator('input').fill('个');
  await editDraft.getByRole('button', { name: /确\s*定/ }).click();
  await editDraft.getByText('该单位已存在').waitFor({ timeout: 5000 });
  must(await meter.getByText('米', { exact: true }).isVisible(), '修改重名后原单位名变了');
  await editDraft.getByRole('button', { name: /取\s*消/ }).click();
  await unitBoard.getByRole('button', { name: /确\s*定/ }).click();

  const fileRowTarget = editor.locator('.goods-block').filter({ hasText: '附件' });
  await fileRowTarget.scrollIntoViewIfNeeded();
  await page.locator('#goods-file-input').setInputFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: solidPng(160, 90, [65, 132, 244]),
  });
  const fileRow = editor.locator('.goods-file-row').filter({ hasText: 'sample.png' });
  await fileRow.waitFor();
  const actions = (await fileRow.locator('button').allTextContents()).map((text) => text.trim());
  const previewAt = actions.indexOf('预览');
  const deleteAt = actions.indexOf('删除');
  must(previewAt >= 0 && deleteAt >= 0 && previewAt < deleteAt, `附件操作顺序不对：${actions.join('|')}`);
  const previewBox = await fileRow.getByRole('button', { name: '预览' }).boundingBox();
  const deleteBox = await fileRow.getByRole('button', { name: '删除' }).boundingBox();
  must(previewBox && deleteBox && previewBox.x < deleteBox.x, '预览没有排在删除左侧');
  await fileRow.getByRole('button', { name: '预览' }).click();
  const previewImg = page.locator('.goods-preview-img');
  await previewImg.waitFor();
  const natural = await previewImg.evaluate((node) => node instanceof HTMLImageElement ? node.naturalWidth : 0);
  must(natural > 0, '预览图片没有显示出来');
  await shot(page, '05-attachment-preview');

  writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify({ ok: true, shots, sourceWidth: sourceBox.width, saleWidth: saleBox.width }, null, 2));
  writeFileSync(path.join(optDir, 'result.json'), JSON.stringify({ ok: true, shots, sourceWidth: sourceBox.width, saleWidth: saleBox.width }, null, 2));
  console.log(JSON.stringify({ ok: true, shots, sourceWidth: sourceBox.width, saleWidth: saleBox.width }));
} finally {
  await browser.close();
}
