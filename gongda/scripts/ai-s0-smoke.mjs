#!/usr/bin/env node
/**
 * S0 可信执行底座冒烟（Playwright only）
 * - 核对 VERSION / 侧栏 .kgd-sidebar-primary（现网毛玻璃，非旧 kgd-rail）
 * - API：名片认型 → cancel（确认前不写）→ confirm + 审计；工厂助理问应收
 * 截图：docs/ai/shots/ai-s0-sidebar.png、ai-s0-trust.png
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
const sidebarShot = path.join(shotDir, 'ai-s0-sidebar.png');
const trustShot = path.join(shotDir, 'ai-s0-trust.png');
const reportPath = path.join(shotDir, 'ai-s0-smoke-report.json');

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
  ]);
}

async function main() {
  const results = [];
  const versionText = readFileSync(path.join(root, 'VERSION'), 'utf8');
  const shellVer = JSON.parse(readFileSync(path.join(root, 'chat-shell/version.json'), 'utf8'));
  record(results, 'VERSION 为 v1.0.24', /SEDRIC01 v1\.0\.24/.test(versionText), versionText.split('\n')[0]);
  record(
    results,
    'chat-shell/version.json 为 1.0.24 / ai-s0-trust-base',
    shellVer.version === '1.0.24' && shellVer.feature === 'ai-s0-trust-base',
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

  // —— API：名片认型 + cancel（确认前不写）——
  const boundary = '----S0SmokeBoundary';
  const cardBody =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="smoke-名片.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `姓名：冒烟联系人\n电话：13700137000\n公司：演示客户\n名片\r\n` +
    `--${boundary}--\r\n`;
  const classifyRes = await fetch(`${API}/api/ai/intake/classify`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: cardBody,
  });
  const classifyJson = await classifyRes.json();
  record(
    results,
    '名片认型出确认卡且禁止落合同/加工单',
    classifyRes.ok &&
      classifyJson.kind === 'business_card' &&
      classifyJson.confirm_card &&
      Array.isArray(classifyJson.forbidden_writes) &&
      classifyJson.forbidden_writes.includes('money_contracts'),
    JSON.stringify(classifyJson).slice(0, 280),
  );

  const previewId = classifyJson.preview_id;
  const cancelRes = await fetch(`${API}/api/ai/writes/cancel`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ kind: 'contact', preview_id: previewId }),
  });
  const cancelJson = await cancelRes.json();
  record(
    results,
    'writes/cancel 记审计且 ok',
    Boolean(cancelRes.ok && cancelJson.ok && cancelJson.audit_id),
    JSON.stringify(cancelJson).slice(0, 200),
  );

  const failRes = await fetch(`${API}/api/ai/writes/confirm`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ kind: 'contact', preview_id: '00000000-0000-4000-8000-000000000099' }),
  });
  const auditAfterFail = await fetch(`${API}/api/ai/writes/audit?limit=20`, {
    headers: { cookie: session.cookie },
  }).then((r) => r.json());
  const hasFailed = (auditAfterFail.items || []).some(
    (row) => row.result === 'failed' && row.action === 'write.confirm',
  );
  record(results, 'writes/confirm 失败也记审计', failRes.status === 404 && hasFailed, `status=${failRes.status}`);

  const askRes = await fetch(`${API}/api/ai/factory/ask`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ question: '应收还有多少' }),
  });
  const askJson = await askRes.json();
  record(
    results,
    '工厂助理问应收只读',
    askRes.ok && askJson.intent === 'money' && /应收|未收|已收/.test(askJson.answer || ''),
    JSON.stringify(askJson).slice(0, 200),
  );

  // —— UI：毛玻璃侧栏 ——
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await asUser(page, session);
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // 等待毛玻璃侧栏就绪（基线壳可能仍有次要模块 500，不挡主导航）
    await page.locator('.kgd-sidebar-primary').first().waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(800);
    const primary = page.locator('.kgd-sidebar-primary');
    const primaryCount = await primary.count();
    const railAsMain = await page.locator('.kgd-rail').count();
    const labels = await primary.allTextContents().catch(() => []);
    const hasWorkbench = labels.some((t) => /工作台/.test(t)) && labels.some((t) => /生产管理|客户管理|仓库/.test(t));
    const baselineOk = primaryCount >= 3 && hasWorkbench;
    record(
      results,
      '现网毛玻璃侧栏 .kgd-sidebar-primary（非旧壳主导航）',
      baselineOk,
      `primary=${primaryCount} rail=${railAsMain} labels=${labels.slice(0, 8).join('|')}`,
    );
    if (!baselineOk) {
      record(results, '基线检查', false, '界面疑似旧壳，停止交卷');
    }
    await page.screenshot({ path: sidebarShot, fullPage: false });

    await page.goto(`${WEB}/ai/center`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.getByTestId('sedric-ai-center').waitFor({ state: 'visible', timeout: 20000 });
    const centerText = await page.locator('[data-testid="sedric-ai-center"]').innerText();
    record(
      results,
      'AI 中心提及统一 writes 协议',
      /writes\/confirm|确认前不写|可信执行|S0/.test(centerText),
      centerText.slice(0, 160),
    );
    await page.screenshot({ path: trustShot, fullPage: false });
  } finally {
    await browser.close();
  }

  const ok = results.every((r) => r.ok);
  const report = {
    ok,
    version: versionText.split('\n')[0],
    base: 'release/sedric-v1.0.23',
    feature: 'ai-s0-trust-base',
    api: API,
    web: WEB,
    shots: { sidebar: sidebarShot, trust: trustShot },
    results,
    at: new Date().toISOString(),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(ok ? 'S0 冒烟通过' : 'S0 冒烟未通过', reportPath);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
