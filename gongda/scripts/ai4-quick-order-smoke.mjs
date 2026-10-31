#!/usr/bin/env node
/**
 * AI-4 极速下单冒烟：登录 → AI 中心 → 极速下单 → 上传样例 → 预览 → 截图
 * 截图：docs/ai/shots/ai4-quick-order.png
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
const shotPath = path.join(shotDir, 'ai4-quick-order.png');
const reportPath = path.join(shotDir, 'ai4-smoke-report.json');
const samplePath = path.join(shotDir, 'ai4-sample.csv');

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
  const csv = '客户编码,客户名称,商品编码,商品名称,数量,单价,交货日期\nC-DEMO,演示客户,P-DEMO,演示成品,10,25.5,2026-10-31\n';
  writeFileSync(samplePath, csv, 'utf8');

  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'ai4-sample.csv');
  const parseRes = await fetch(`${API}/api/ai/quick-order/parse`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: form,
  });
  const parseJson = await parseRes.json();
  record('API parse 成功', parseRes.ok, parseRes.ok ? `rows=${parseJson.line_rows?.length}` : JSON.stringify(parseJson).slice(0, 160));
  const previewId = parseJson.preview_id;

  const cancelRes = await fetch(`${API}/api/ai/quick-order/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: JSON.stringify({ preview_id: previewId }),
  });
  record('API cancel 成功', cancelRes.ok);

  const quotaRes = await fetch(`${API}/api/ai/quick-order/quota`, {
    headers: { cookie: session.cookie },
  });
  record('API quota 可读', quotaRes.ok, quotaRes.ok ? JSON.stringify(await quotaRes.json()) : '');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await asUser(page, session);

  await page.goto(`${WEB}/ai/center`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-testid="sedric-ai-center"]', { timeout: 20000 });
  record('AI 中心可见', true);

  const card = page.locator('[data-testid="sedric-ai-card-quick-order"]');
  record('极速下单卡片可见', await card.count().then((n) => n > 0));
  await page.click('[data-testid="sedric-ai-open-quick-order"]');
  await page.waitForSelector('[data-testid="sedric-ai-quick-order"]', { timeout: 20000 });
  record('进入极速下单页', page.url().includes('/ai/quick-order'));

  // 用 API 再 parse 一次，前端通过上传控件
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(samplePath);
  await page.waitForSelector('[data-testid="sedric-ai-qo-lines"]', { timeout: 20000 });
  record('上传后出现预览明细', true);

  await page.screenshot({ path: shotPath, fullPage: true });
  record('截图已保存', existsSync(shotPath), shotPath);

  // 取消，避免留下 preview
  const cancelBtn = page.locator('[data-testid="sedric-ai-qo-cancel"]');
  if (await cancelBtn.count()) await cancelBtn.click();

  await browser.close();

  const ok = results.every((r) => r.ok);
  writeFileSync(reportPath, JSON.stringify({ ok, results, shotPath, at: new Date().toISOString() }, null, 2));
  if (!ok) {
    console.error('冒烟未全部通过');
    process.exit(1);
  }
  console.log('AI-4 冒烟通过', shotPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
