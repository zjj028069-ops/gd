#!/usr/bin/env node
/**
 * AI-2 工厂助理冒烟：登录 → AI 中心 → 工厂助理 → 点推荐问进度 → 截图
 * 截图：docs/ai/shots/ai2-factory.png
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
const shotPath = path.join(shotDir, 'ai2-factory.png');
const reportPath = path.join(shotDir, 'ai2-smoke-report.json');

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

  // API 直测
  const askMoney = await fetch(`${API}/api/ai/factory/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    },
    body: JSON.stringify({ question: '应收还有多少未收' }),
  });
  const moneyJson = await askMoney.json();
  record('API 问应收', askMoney.ok && /应收|未收|已收/.test(moneyJson.answer || ''), JSON.stringify(moneyJson).slice(0, 200));

  const askHowto = await fetch(`${API}/api/ai/factory/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    },
    body: JSON.stringify({ question: '怎么报工' }),
  });
  const howtoJson = await askHowto.json();
  record(
    'API 怎么报工引导',
    askHowto.ok && howtoJson.intent === 'guide' && !/共有\s*[1-9]\d*\s*张加工单/.test(howtoJson.answer || ''),
    JSON.stringify(howtoJson).slice(0, 200),
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const url = req.url();
    if (!url.includes('/api/')) return;
    if (url.includes('/api/ai/factory/ask')) return;
    if (url.includes('/api/ai/assistant/')) return;
    if (url.includes('/api/auth/')) return;
    businessWritePosts.push(url);
  });

  try {
    await asUser(page, session);
    await page.goto(`${WEB}/ai/center`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.getByTestId('sedric-ai-card-factory').waitFor({ state: 'visible', timeout: 20000 });
    record('AI 中心可见工厂助理卡片', true);

    await page.getByTestId('sedric-ai-open-factory').click();
    await page.getByTestId('sedric-factory-page').waitFor({ state: 'visible', timeout: 15000 });
    record('打开工厂助理页', true);

    const chip = page.getByTestId('sedric-factory-chip').filter({ hasText: '今天生产进度怎么样' });
    await chip.click();
    await page.getByTestId('sedric-factory-answer').waitFor({ state: 'visible', timeout: 20000 });
    const answer = await page.getByTestId('sedric-factory-answer').innerText();
    record('推荐问进度有回答', /[\u4e00-\u9fff]/.test(answer) && answer.length > 5, answer.slice(0, 120));

    await page.screenshot({ path: shotPath, fullPage: true });
    record('截图', existsSync(shotPath), shotPath);

    const noBizWrite = businessWritePosts.length === 0;
    record('问答期无业务写 POST', noBizWrite, businessWritePosts.slice(0, 5).join(',') || 'none');
  } finally {
    await browser.close();
  }

  const ok = results.every((r) => r.ok);
  writeFileSync(reportPath, JSON.stringify({ ok, results, shotPath, businessWritePosts }, null, 2));
  console.log(ok ? '全部通过' : '存在失败', reportPath);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
