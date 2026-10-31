#!/usr/bin/env node
/**
 * AI-1 智能客服冒烟：登录 → 调拨单列表 → 开小助手 → 推荐问/深度分析「如何报工」→ 截图
 * 截图：docs/ai/shots/ai1-chat.png
 * 环境：API_BASE / WEB_BASE，默认预览 3011 / 5183
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_BASE ?? 'http://127.0.0.1:3011';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5183';
const shotDir = path.join(root, 'docs/ai/shots');
mkdirSync(shotDir, { recursive: true });
const shotPath = path.join(shotDir, 'ai1-chat.png');
const reportPath = path.join(shotDir, 'ai1-smoke-report.json');

function passwordOf(file, username) {
  if (!existsSync(file)) return '';
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
  ]);
}

const businessWritePosts = [];
const results = [];

function record(title, ok, reason = '') {
  results.push({ title, ok, reason });
  console.log(ok ? '通过' : '未通过', title, reason);
}

async function main() {
  const credFile = path.join(root, '.local/dev-credentials.txt');
  const username = 'admin.local';
  const password = passwordOf(credFile, username);
  if (!password) throw new Error('缺少 .local/dev-credentials.txt 中 admin.local 密码');

  const health = await fetch(`${API}/health/live`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`API 未就绪: ${API}`);

  const session = await login(username, password);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const url = req.url();
    if (!url.includes('/api/')) return;
    if (url.includes('/api/ai/assistant/chat')) return;
    if (url.includes('/api/auth/')) return;
    businessWritePosts.push(url);
  });

  try {
    await asUser(page, session);
    await page.goto(`${WEB}/stock_allocate_bill/list`, { waitUntil: 'networkidle', timeout: 60000 });
    const fab = page.getByTestId('sedric-ai-fab');
    await fab.waitFor({ state: 'visible', timeout: 20000 });
    record('调拨单页可见浮标', true);

    await fab.click();
    const panel = page.getByTestId('sedric-ai-panel');
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    const greeting = page.getByTestId('sedric-ai-greeting');
    await greeting.waitFor({ state: 'visible', timeout: 10000 });
    const suggest = page.getByTestId('sedric-ai-suggest').first();
    await suggest.waitFor({ state: 'visible', timeout: 10000 });
    record('点开有问候与推荐问', true, await greeting.innerText());

    await suggest.click();
    const reply = page.getByTestId('sedric-ai-reply').first();
    await reply.waitFor({ state: 'visible', timeout: 20000 });
    const replyText = (await reply.innerText()).trim();
    record('推荐问得非空中文', /[\u4e00-\u9fff]/.test(replyText) && replyText.length > 4, replyText.slice(0, 80));

    await page.locator('.sedric-ai-toolbar select').selectOption('deep');
    await page.getByTestId('sedric-ai-input').fill('如何报工');
    await page.getByTestId('sedric-ai-send').click();
    await page.waitForTimeout(500);
    await page.getByTestId('sedric-ai-reply').nth(1).waitFor({ state: 'visible', timeout: 20000 });
    const deepText = (await page.getByTestId('sedric-ai-reply').nth(1).innerText()).trim();
    record('深度分析问如何报工有回复', /[\u4e00-\u9fff]/.test(deepText) && deepText.length > 4, deepText.slice(0, 80));

    await page.screenshot({ path: shotPath, fullPage: false });
    record('截图落盘', existsSync(shotPath), shotPath);

    const badWrites = businessWritePosts.filter((u) => !u.includes('/api/ai/'));
    record('无业务写接口 POST（除 chat）', badWrites.length === 0, badWrites.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  writeFileSync(reportPath, JSON.stringify({ API, WEB, shotPath, businessWritePosts, results }, null, 2));
  if (failed.length) {
    console.error('冒烟失败', failed);
    process.exit(1);
  }
  console.log('AI-1 冒烟通过', shotPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
