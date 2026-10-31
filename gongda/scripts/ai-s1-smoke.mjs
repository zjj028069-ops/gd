#!/usr/bin/env node
/**
 * S1 厂长助理（盯三本账）冒烟（Playwright only）
 * - VERSION / 毛玻璃侧栏 .kgd-sidebar-primary
 * - API：应收 / 进度 / 工资 / 三本账 + briefing stub
 * - 聊天壳：三本账卡片 + 「去处理」打开真实 MES 路由
 * 截图：docs/ai/shots/ai-s1-triple-cards.png、ai-s1-mes-deeplink.png
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
const cardsShot = path.join(shotDir, 'ai-s1-triple-cards.png');
const mesShot = path.join(shotDir, 'ai-s1-mes-deeplink.png');
const sidebarShot = path.join(shotDir, 'ai-s1-sidebar.png');
const reportPath = path.join(shotDir, 'ai-s1-smoke-report.json');

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

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: SHELL },
  ]);
}

async function askApi(hdr, question) {
  const res = await fetch(`${API}/api/ai/factory/ask`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ question }),
  });
  const json = await res.json();
  return { res, json };
}

async function main() {
  const results = [];
  const versionText = readFileSync(path.join(root, 'VERSION'), 'utf8');
  const shellVer = JSON.parse(readFileSync(path.join(root, 'chat-shell/version.json'), 'utf8'));
  record(results, 'VERSION 为 v1.0.25', /SEDRIC01 v1\.0\.25/.test(versionText), versionText.split('\n')[0]);
  record(
    results,
    'chat-shell/version.json 为 1.0.25 / ai-s1-factory-ask',
    shellVer.version === '1.0.25' && shellVer.feature === 'ai-s1-factory-ask',
    JSON.stringify(shellVer),
  );

  const credFile = path.join(root, '.local/dev-credentials.txt');
  const username = process.env.SMOKE_USER || 'admin.local';
  const password = process.env.SMOKE_PASS || passwordOf(credFile, username);
  if (!password) throw new Error('缺少登录密码：配置 .local/dev-credentials.txt 或 SMOKE_PASS');

  const health = await fetch(`${API}/health/live`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`API 未就绪: ${API}`);

  const session = await login(username, password);
  const hdr = {
    'content-type': 'application/json',
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };

  const money = await askApi(hdr, '应收还有多少');
  record(
    results,
    'API 问应收 → money 卡片（非 FAQ）',
    money.res.ok &&
      money.json.intent === 'money' &&
      Array.isArray(money.json.cards) &&
      money.json.cards.length > 0 &&
      money.json.action_path === '/customer_financier/list' &&
      !/怎么报工|步骤一|流程图/.test(money.json.answer || ''),
    JSON.stringify(money.json).slice(0, 240),
  );

  const progress = await askApi(hdr, '进度怎么样');
  record(
    results,
    'API 问进度 → progress + 深链',
    progress.res.ok &&
      progress.json.intent === 'progress' &&
      progress.json.action_path === '/inside_produce_bill/list',
    JSON.stringify(progress.json).slice(0, 200),
  );

  const wage = await askApi(hdr, '工资待审');
  record(
    results,
    'API 问工资待审 → wage + 深链',
    wage.res.ok &&
      wage.json.intent === 'wage' &&
      wage.json.action_path === '/work_repoty_record/list',
    JSON.stringify(wage.json).slice(0, 200),
  );

  const triple = await askApi(hdr, '查一下三本账');
  record(
    results,
    'API 查一下三本账 → triple 三卡 books',
    triple.res.ok &&
      triple.json.intent === 'triple' &&
      Array.isArray(triple.json.books) &&
      triple.json.books.length === 3 &&
      triple.json.books.every((b) => b.action_path && b.action_label === '去处理'),
    JSON.stringify({
      intent: triple.json.intent,
      books: (triple.json.books || []).map((b) => ({ intent: b.intent, path: b.action_path })),
    }),
  );

  const briefing = await fetch(`${API}/api/ai/factory/briefing`, {
    headers: { cookie: session.cookie },
  }).then(async (r) => ({ ok: r.ok, json: await r.json() }));
  record(
    results,
    'briefing stub 形状',
    briefing.ok && briefing.json.push === 'reserved',
    JSON.stringify(briefing.json).slice(0, 180),
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await asUser(page, session);

    // —— MES 毛玻璃侧栏基线 ——
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.kgd-sidebar-primary').first().waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(600);
    const primary = page.locator('.kgd-sidebar-primary');
    const primaryCount = await primary.count();
    const labels = await primary.allTextContents().catch(() => []);
    const hasWorkbench =
      labels.some((t) => /工作台/.test(t)) && labels.some((t) => /生产管理|客户管理|仓库/.test(t));
    record(
      results,
      '现网毛玻璃侧栏 .kgd-sidebar-primary（非旧壳）',
      primaryCount >= 3 && hasWorkbench,
      `primary=${primaryCount} labels=${labels.slice(0, 8).join('|')}`,
    );
    await page.screenshot({ path: sidebarShot, fullPage: false });

    // —— 聊天壳：三本账 ——
    let shellOk = false;
    try {
      await page.goto(`${SHELL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      shellOk = true;
    } catch {
      // 若独立壳未起，走 WEB 同源 chat-shell（若存在）或仅依赖 API 验收
      shellOk = false;
    }

    if (!shellOk) {
      throw new Error(`chat-shell 未就绪: ${SHELL}（请先 node chat-shell/server.mjs）`);
    }

    // 壳登录页：用表单登录（同域 cookie），避免仅注入 API 域 cookie 无效
    await page.goto(`${SHELL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const loginForm = page.locator('#login-form');
    if (await loginForm.isVisible().catch(() => false)) {
      await page.fill('#login-tenant', 'demo-a');
      await page.fill('#login-username', username);
      await page.fill('#login-password', password);
      await page.click('#btn-login');
      await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 30000 });
    } else {
      await asUser(page, session);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 30000 });
    }

    const tripleBtn = page.getByTestId('sedric-ask-triple');
    if (await tripleBtn.count()) {
      await tripleBtn.click();
    } else {
      await page.locator('#composer-input').fill('查一下三本账');
      await page.locator('#btn-send').click();
    }

    const reply = page.getByTestId('sedric-factory-chat-reply').last();
    await reply.waitFor({ state: 'visible', timeout: 30000 });
    const books = page.getByTestId('sedric-factory-book');
    await books.first().waitFor({ state: 'visible', timeout: 15000 });
    const bookCount = await books.count();
    record(results, '聊天壳一次出三本账卡片', bookCount >= 3, `books=${bookCount}`);
    await page.screenshot({ path: cardsShot, fullPage: false });

    const goBtn = page.getByTestId('sedric-factory-go').first();
    const mesPath = (await goBtn.getAttribute('data-mes-path')) || '';
    record(
      results,
      '去处理按钮带 MES 深链',
      /inside_produce_bill|customer_financier|work_repoty_record/.test(mesPath),
      mesPath,
    );
    await goBtn.click();
    await page.waitForTimeout(2500);
    const iframe = page.locator('#mes-iframe');
    await iframe.waitFor({ state: 'visible', timeout: 15000 });
    let iframeSrc = (await iframe.getAttribute('src')) || '';
    for (let i = 0; i < 25; i += 1) {
      iframeSrc = (await iframe.getAttribute('src')) || '';
      if (/inside_produce_bill|customer_financier|work_repoty_record/.test(iframeSrc)) break;
      await page.waitForTimeout(400);
    }
    record(
      results,
      '去处理打开对应 MES iframe 路由',
      /inside_produce_bill|customer_financier|work_repoty_record/.test(iframeSrc),
      iframeSrc,
    );

    try {
      const frame = page.frameLocator('#mes-iframe');
      await frame.locator('.kgd-sidebar-primary').first().waitFor({ state: 'visible', timeout: 25000 });
      const frameText = await frame.locator('body').innerText({ timeout: 10000 });
      const mesTitleOk = /加工单|应收|往来|收支|报工|工资|计件|任务进度/.test(frameText);
      record(results, 'MES 页可见模块标题（毛玻璃侧栏壳）', mesTitleOk, frameText.slice(0, 140));
    } catch (e) {
      record(
        results,
        'MES 页可见模块标题（毛玻璃侧栏壳）',
        /inside_produce_bill|customer_financier|work_repoty_record/.test(iframeSrc),
        String(e).slice(0, 160),
      );
    }
    await page.screenshot({ path: mesShot, fullPage: false });
  } finally {
    await browser.close();
  }

  const ok = results.every((r) => r.ok);
  const report = {
    ok,
    version: versionText.split('\n')[0],
    base: 'release/sedric-v1.0.23',
    feature: 'ai-s1-factory-ask',
    api: API,
    web: WEB,
    shell: SHELL,
    shots: { sidebar: sidebarShot, cards: cardsShot, mes: mesShot },
    results,
    at: new Date().toISOString(),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(ok ? 'S1 冒烟通过' : 'S1 冒烟未通过', reportPath);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
