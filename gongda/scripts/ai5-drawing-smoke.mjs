#!/usr/bin/env node
/**
 * AI-5 图纸拆单冒烟：登录 → AI 中心 → 图纸拆单 → 上传样例 → 预览 → 截图
 * 截图：docs/ai/shots/ai5-drawing.png
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
const shotPath = path.join(shotDir, 'ai5-drawing.png');
const reportPath = path.join(shotDir, 'ai5-smoke-report.json');
const samplePath = path.join(shotDir, 'ai5-sample.png');

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

  // 最小合法 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(samplePath, png);

  const form = new FormData();
  form.append('note', '女装成衣图纸');
  form.append('file', new Blob([png], { type: 'image/png' }), 'ai5-sample.png');
  const parseRes = await fetch(`${API}/api/ai/drawing/parse`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: form,
  });
  const parseJson = await parseRes.json();
  record('API parse 成功', parseRes.ok, parseRes.ok ? `steps=${parseJson.steps?.length}` : JSON.stringify(parseJson).slice(0, 160));
  const previewId = parseJson.preview_id;

  const cancelRes = await fetch(`${API}/api/ai/drawing/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: JSON.stringify({ preview_id: previewId }),
  });
  record('API cancel 成功', cancelRes.ok);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await asUser(page, session);

  await page.goto(`${WEB}/ai/center`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-testid="sedric-ai-center"]', { timeout: 20000 });
  record('AI 中心可见', true);

  const card = page.locator('[data-testid="sedric-ai-card-drawing"]');
  record('图纸拆单卡片可见', await card.count().then((n) => n > 0));
  await page.click('[data-testid="sedric-ai-open-drawing"]');
  await page.waitForSelector('[data-testid="sedric-ai-drawing"]', { timeout: 20000 });
  record('进入图纸拆单页', page.url().includes('/ai/drawing-split'));

  await page.fill('[data-testid="sedric-ai-draw-note"]', '女装成衣图纸');
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(samplePath);
  await page.waitForSelector('[data-testid="sedric-ai-draw-steps"]', { timeout: 20000 });
  record('上传后出现工序预览', true);

  await page.screenshot({ path: shotPath, fullPage: true });
  record('截图已保存', existsSync(shotPath), shotPath);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  writeFileSync(reportPath, JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  if (failed.length) {
    console.error('冒烟失败', failed);
    process.exit(1);
  }
  console.log('AI-5 图纸拆单冒烟通过', shotPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
