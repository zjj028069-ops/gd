#!/usr/bin/env node
/**
 * S2 聊天一扔就落单冒烟（Playwright only）
 * - VERSION / 毛玻璃侧栏
 * - API：名片确认、订单确认/取消、风景追问、unknown 追问
 * - 聊天壳：确认卡截图；确认后打开合同列表（毛玻璃壳）
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_BASE ?? 'http://127.0.0.1:3011';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5183';
const SHELL = process.env.SHELL_BASE ?? 'http://127.0.0.1:5180';
const shotDir = path.join(root, 'docs/ai/shots');
mkdirSync(shotDir, { recursive: true });
const cardShot = path.join(shotDir, 'ai-s2-card-confirm.png');
const orderShot = path.join(shotDir, 'ai-s2-order-confirm.png');
const listShot = path.join(shotDir, 'ai-s2-contract-list.png');
const reportPath = path.join(shotDir, 'ai-s2-smoke-report.json');

function passwordOf(file, username) {
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}

function record(results, title, ok, reason = '') {
  results.push({ title, ok, reason });
  console.log(ok ? '通过' : '未通过', title, reason);
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
    if (res.ok && json.csrf_token) return { csrf: json.csrf_token, cookie };
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 160);
    if (res.status === 429 || /限流|RATE_LIMIT/i.test(msg)) {
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * attempt)));
      continue;
    }
    throw new Error(`登录失败: ${res.status} ${msg}`);
  }
  throw new Error('登录限流重试耗尽');
}

async function classify(session, text, filename) {
  const boundary = '----S2SmokeBoundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `${text}\r\n` +
    `--${boundary}--\r\n`;
  const res = await fetch(`${API}/api/ai/intake/classify`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  return { res, json: await res.json() };
}

async function main() {
  const results = [];
  const versionText = readFileSync(path.join(root, 'VERSION'), 'utf8');
  const shellVer = JSON.parse(readFileSync(path.join(root, 'chat-shell/version.json'), 'utf8'));
  record(results, 'VERSION 为 v1.0.26', /SEDRIC01 v1\.0\.26/.test(versionText), versionText.split('\n')[0]);
  record(
    results,
    'chat-shell/version.json 为 1.0.26 / ai-s2-chat-intake',
    shellVer.version === '1.0.26' && shellVer.feature === 'ai-s2-chat-intake',
    JSON.stringify(shellVer),
  );

  const credFile = path.join(root, '.local/dev-credentials.txt');
  const username = process.env.SMOKE_USER || 'admin.local';
  const password = process.env.SMOKE_PASS || passwordOf(credFile, username);
  if (!password) throw new Error('缺少登录密码');

  const health = await fetch(`${API}/health/live`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`API 未就绪: ${API}`);

  const session = await login(username, password);
  const hdr = {
    'content-type': 'application/json',
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };

  // —— 名片 ——
  const card = await classify(
    session,
    '姓名：冒烟名片人\n电话：13600136000\n公司：S2冒烟客户\n名片',
    '冒烟名片.txt',
  );
  record(
    results,
    '名片认型出确认卡且禁合同/加工单',
    card.res.ok &&
      card.json.kind === 'business_card' &&
      card.json.confirm_card &&
      Array.isArray(card.json.forbidden_writes),
    JSON.stringify(card.json).slice(0, 220),
  );
  const cardConfirm = await fetch(`${API}/api/ai/writes/confirm`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ kind: 'contact', preview_id: card.json.preview_id }),
  });
  const cardConfJson = await cardConfirm.json();
  record(
    results,
    '名片确认写入联系人且无合同',
    cardConfirm.ok &&
      cardConfJson.kind === 'contact' &&
      cardConfJson.data?.created_contract === false &&
      cardConfJson.audit_id,
    JSON.stringify(cardConfJson).slice(0, 220),
  );

  // —— 订单：取消不写 ——
  const orderText =
    '送货单\n客户名称：S2冒烟合同客户\n商品编码：LOCAL001\n数量：3\n单价：15\n备注：ai-s2-smoke';
  const order1 = await classify(session, orderText, '送货单-冒烟.txt');
  record(
    results,
    '订单认型出合同确认卡',
    order1.res.ok && order1.json.kind === 'order_doc' && order1.json.confirm_card?.target === 'contract',
    JSON.stringify(order1.json).slice(0, 240),
  );
  const cancelRes = await fetch(`${API}/api/ai/writes/cancel`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ kind: 'contract', preview_id: order1.json.preview_id }),
  });
  const cancelJson = await cancelRes.json();
  record(results, '订单取消不写库且记审计', cancelRes.ok && cancelJson.ok && cancelJson.audit_id, JSON.stringify(cancelJson).slice(0, 160));

  const order2 = await classify(session, orderText, '送货单-冒烟2.txt');
  const confirmOrder = await fetch(`${API}/api/ai/writes/confirm`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({
      kind: 'contract',
      preview_id: order2.json.preview_id,
      chain_work_order: false,
    }),
  });
  const orderConf = await confirmOrder.json();
  record(
    results,
    '订单确认后库内有合同+审计',
    confirmOrder.ok && orderConf.kind === 'contract' && orderConf.data?.contract_code && orderConf.audit_id,
    JSON.stringify(orderConf).slice(0, 240),
  );

  // —— 风景 / unknown ——
  const scenery = await classify(session, 'photo of lake', '西湖风景.jpg');
  record(
    results,
    '风景图追问不静默写库',
    scenery.res.ok && scenery.json.kind === 'other' && scenery.json.ask_id && scenery.json.ask,
    JSON.stringify(scenery.json).slice(0, 180),
  );
  const unknown = await classify(session, '\x00\x01bin', 'scan-001.bin');
  record(
    results,
    'unknown 追问不写库',
    unknown.res.ok && unknown.json.kind === 'unknown' && unknown.json.ask_id,
    JSON.stringify(unknown.json).slice(0, 160),
  );

  // —— S1 不误进 ——
  const askMoney = await fetch(`${API}/api/ai/factory/ask`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ question: '应收还有多少' }),
  }).then(async (r) => ({ ok: r.ok, json: await r.json() }));
  record(
    results,
    '问应收仍走厂长助理只读',
    askMoney.ok && askMoney.json.intent === 'money',
    JSON.stringify(askMoney.json).slice(0, 120),
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    // 侧栏基线
    const raw = session.cookie.split(';')[0];
    const eq = raw.indexOf('=');
    await page.context().addCookies([
      { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
      { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
      { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: SHELL },
    ]);
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.kgd-sidebar-primary').first().waitFor({ state: 'visible', timeout: 30000 });
    const labels = await page.locator('.kgd-sidebar-primary').allTextContents();
    const hasWorkbench =
      labels.some((t) => /工作台/.test(t)) && labels.some((t) => /生产管理|客户管理|仓库/.test(t));
    record(results, '现网毛玻璃侧栏 .kgd-sidebar-primary', hasWorkbench, labels.slice(0, 6).join('|'));

    // 聊天壳：名片确认卡
    await page.goto(`${SHELL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800);
    const needLogin =
      (await page.locator('#login-page:not([hidden])').isVisible().catch(() => false)) ||
      (await page.locator('#login-page').isVisible().catch(() => false));
    const composerReady = await page.locator('#composer-input').isVisible().catch(() => false);
    if (needLogin && !composerReady) {
      await page.locator('#login-tenant').fill('demo-a', { force: true });
      await page.locator('#login-username').fill(username, { force: true });
      await page.locator('#login-password').fill(password, { force: true });
      await page.locator('#btn-login').click({ force: true });
      await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 30000 });
    } else {
      await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 30000 });
    }
    await page.locator('#btn-attach').click();
    const fileInput = page.locator('#sedric-attach-input');
    await fileInput.setInputFiles({
      name: '冒烟名片-壳.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('姓名：壳测名片\n电话：13500135000\n公司：壳测客户\n名片', 'utf8'),
    });
    await page.getByTestId('sedric-ai-confirm-card').last().waitFor({ state: 'visible', timeout: 30000 });
    const cardKind = await page.getByTestId('sedric-ai-confirm-card').last().getAttribute('data-write-kind');
    record(results, '聊天壳名片确认卡', cardKind === 'contact', `kind=${cardKind}`);
    await page.screenshot({ path: cardShot, fullPage: false });

    // 订单确认卡
    await page.locator('#btn-attach').click();
    await fileInput.setInputFiles({
      name: '送货单-壳.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(orderText, 'utf8'),
    });
    await page
      .locator('[data-testid="sedric-ai-confirm-card"][data-write-kind="contract"]')
      .last()
      .waitFor({ state: 'visible', timeout: 30000 });
    record(results, '聊天壳订单合同确认卡', true, 'visible');
    await page.screenshot({ path: orderShot, fullPage: false });

    // 确认写入后打开合同列表
    await page
      .locator('[data-testid="sedric-ai-confirm-card"][data-write-kind="contract"]')
      .last()
      .getByTestId('sedric-confirm-write')
      .click();
    await page.waitForTimeout(1200);
    await page.goto(`${WEB}/customer_contract/list`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.kgd-sidebar-primary').first().waitFor({ state: 'visible', timeout: 30000 });
    const listText = await page.locator('body').innerText();
    const listOk =
      /合同|订单/.test(listText) &&
      (/S2冒烟合同客户|ai-s2-smoke|HT|暂无数据|列表/.test(listText) || (await page.locator('.kgd-sidebar-primary').count()) >= 3);
    record(results, '确认后合同列表页（毛玻璃壳）', listOk, listText.slice(0, 120));
    await page.screenshot({ path: listShot, fullPage: false });
  } finally {
    await browser.close();
  }

  const ok = results.every((r) => r.ok);
  const report = {
    ok,
    version: versionText.split('\n')[0],
    base: 'release/sedric-v1.0.23',
    feature: 'ai-s2-chat-intake',
    mock_boundary:
      '无 OCR：认型与字段抽取靠文件名/文本线索确定性规则；写库走真实 money_contacts / money_contracts + ai_action_audit',
    api: API,
    web: WEB,
    shell: SHELL,
    shots: { card: cardShot, order: orderShot, list: listShot },
    results,
    at: new Date().toISOString(),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(ok ? 'S2 冒烟通过' : 'S2 冒烟未通过', reportPath);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
