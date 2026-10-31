#!/usr/bin/env node
/**
 * AI-3 BOM 导入冒烟：登录 → AI 中心 → 导入页 → 上传样例 → 预览 → 截图
 * 截图：docs/ai/shots/ai3-bom.png
 * 确认前除 parse 外不应有业务写 POST。
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
const shotPath = path.join(shotDir, 'ai3-bom.png');
const reportPath = path.join(shotDir, 'ai3-smoke-report.json');
const samplePath = path.join(shotDir, 'ai3-sample.csv');

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

  // 准备样例（若库无商品，仍应出预览行，匹配状态可为 unmatched）
  const csv = '物料编码,物料名称,规格,单位,用量\nDEMO-MAT-1,演示物料甲,规格A,个,2\nDEMO-MAT-2,演示物料乙,规格B,个,5\n';
  writeFileSync(samplePath, csv, 'utf8');

  // API：parse 不落库
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'ai3-sample.csv');
  const parseRes = await fetch(`${API}/api/ai/bom/parse`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: form,
  });
  const parseJson = await parseRes.json();
  record('API parse 成功', parseRes.ok, parseRes.ok ? `rows=${parseJson.rows?.length}` : JSON.stringify(parseJson).slice(0, 120));
  const previewId = parseJson.preview_id;

  const cancelRes = await fetch(`${API}/api/ai/bom/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: JSON.stringify({ preview_id: previewId }),
  });
  record('API cancel 成功', cancelRes.ok);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/')) {
      const url = req.url();
      const allow =
        url.includes('/api/ai/bom/parse') ||
        url.includes('/api/auth/') ||
        url.includes('/api/session');
      if (!allow && !url.includes('/api/ai/bom/confirm') && !url.includes('/api/ai/bom/cancel') && !url.includes('/api/ai/bom/schemes')) {
        // 预览阶段不应打业务写接口；读请求忽略。确认前我们只上传 parse。
        if (!/\/api\/(products|units|boms|ai\/assistant|ai\/factory)/.test(url) || req.method() === 'POST') {
          if (!url.includes('/api/products') && !url.includes('/api/ai/')) {
            businessWritePosts.push(url);
          } else if (url.includes('/api/boms') || url.includes('/api/work-orders')) {
            businessWritePosts.push(url);
          }
        }
      }
    }
  });

  await asUser(page, session);
  await page.goto(`${WEB}/ai/center`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="sedric-ai-card-bom"]', { timeout: 20000 });
  record('AI 中心可见 BOM 卡片', true);

  await page.click('[data-testid="sedric-ai-open-bom"]');
  await page.waitForSelector('[data-testid="sedric-ai-bom"]', { timeout: 20000 });
  record('进入导入页', true);

  // 用 input[type=file] 上传
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(samplePath);
  await page.waitForSelector('[data-testid="sedric-ai-bom-preview"]', { timeout: 20000 });
  record('上传后出现预览', true);

  await page.screenshot({ path: shotPath, fullPage: true });
  record('截图', existsSync(shotPath), shotPath);

  const prematureWrites = businessWritePosts.filter((u) => /\/api\/boms/.test(u));
  record('确认前无 BOM 业务写 POST', prematureWrites.length === 0, prematureWrites.join(',') || '无');

  await browser.close();

  const report = { ok: results.every((r) => r.ok), results, shotPath, at: new Date().toISOString() };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error('冒烟未全部通过');
    process.exit(1);
  }
  console.log('AI-3 冒烟完成', shotPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
