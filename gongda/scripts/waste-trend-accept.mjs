#!/usr/bin/env node
/**
 * 不良品趋势分析图表页验收。只走 Playwright，不改断言放水。
 * 前置：npm run dev:setup && npm run dev
 * 截图：/opt/cursor/artifacts/defect-trend/
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/defect-trend';
mkdirSync(artifactDir, { recursive: true });

const CHARTS = ['折线图', '面积图', '百分比面积图'];
const PERIODS = ['昨天', '今天', '本周', '本月', '本季度', '本年'];
const INTERVALS = ['每小时', '每天', '每周', '每月'];

function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function shiftIso(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function periodRange(period) {
  const today = shanghaiToday();
  const [year, month] = today.split('-').map(Number);
  if (period === '昨天') { const day = shiftIso(today, -1); return { from: day, to: day }; }
  if (period === '今天') return { from: today, to: today };
  if (period === '本周') {
    const weekday = new Date(`${today}T12:00:00+08:00`).getUTCDay();
    return { from: shiftIso(today, -((weekday + 6) % 7)), to: today };
  }
  if (period === '本季度') {
    const quarter = Math.floor((month - 1) / 3) * 3 + 1;
    return { from: `${year}-${String(quarter).padStart(2, '0')}-01`, to: today };
  }
  if (period === '本年') return { from: `${year}-01-01`, to: today };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

function dayCount(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function passwordOf(username) {
  const text = readFileSync(path.join(process.cwd(), '.local/dev-credentials.txt'), 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  if (!matched) throw new Error(`凭据里没有 ${username}`);
  return matched[1];
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
    if (res.ok && json.csrf_token && cookie) return { csrf: json.csrf_token, cookie };
    const code = json?.error?.code || '';
    if (code === 'RATE_LIMITED' || res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 2000 * attempt)));
      continue;
    }
    throw new Error(`登录失败 ${username}: ${res.status} ${JSON.stringify(json).slice(0, 180)}`);
  }
  throw new Error(`登录失败 ${username}: 限流重试耗尽`);
}

async function api(session, pathName) {
  const res = await fetch(`${API}${pathName}`, { headers: { cookie: session.cookie } });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`GET ${pathName} ${res.status}: ${text.slice(0, 240)}`);
  return json;
}

async function shot(page, name) {
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: name.endsWith('全页') });
  console.log('saved', file);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitServers() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const [apiRes, webRes] = await Promise.all([fetch(`${API}/api/auth/me`), fetch(WEB)]);
      if ([200, 401, 403, 429].includes(apiRes.status) && webRes.ok) return;
    } catch { /* 服务还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('API 或 Web 未在 120 秒内就绪');
}

async function assertChart(card, name) {
  await card.getByRole('button', { name, exact: true }).click();
  for (const item of CHARTS) {
    const pressed = await card.getByRole('button', { name: item, exact: true }).getAttribute('aria-pressed');
    const expectOn = item === name ? 'true' : 'false';
    assert(pressed === expectOn, `图表「${item}」按下状态 ${pressed}，当前应是「${name}」(${expectOn})`);
  }
  await card.locator(`.kgd-trend-plot[data-chart="${name === '折线图' ? 'line' : name === '面积图' ? 'area' : 'percent'}"]`).waitFor();
  const box = await card.locator('canvas').boundingBox();
  assert(box && box.width >= 280 && box.height >= 200, `图表画布尺寸异常 ${JSON.stringify(box)}`);
  await page.waitForTimeout(300);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await waitServers();
  const session = await login('admin.local', passwordOf('admin.local'));
  const month = periodRange('本月');
  const today = periodRange('今天');
  const year = periodRange('本年');
  const monthApi = await api(session, `/api/quality/reports/trend?period=${encodeURIComponent('本月')}`);
  const todayApi = await api(session, `/api/quality/reports/trend?period=${encodeURIComponent('今天')}`);
  const yearApi = await api(session, `/api/quality/reports/trend?period=${encodeURIComponent('本年')}`);
  assert(monthApi.from === month.from && monthApi.to === month.to, `本月区间 ${monthApi.from}~${monthApi.to}，期望 ${month.from}~${month.to}`);
  assert(monthApi.interval === '每天', `本月默认间隔应是每天，实际 ${monthApi.interval}`);
  assert(monthApi.buckets.length === dayCount(month.from, month.to), `本月桶数 ${monthApi.buckets.length}，天数 ${dayCount(month.from, month.to)}`);
  assert(todayApi.interval === '每小时' && todayApi.buckets.length === 24, `今天应按小时返回 24 个桶，实际 ${todayApi.interval} / ${todayApi.buckets?.length}`);
  assert(yearApi.interval === '每月' && yearApi.buckets.length === Number(shanghaiToday().slice(5, 7)), `本年应按月返回 ${Number(shanghaiToday().slice(5, 7))} 个桶，实际 ${yearApi.interval} / ${yearApi.buckets?.length}`);
  for (const payload of [monthApi, todayApi, yearApi]) {
    assert(Array.isArray(payload.series), '趋势接口缺少 series');
    assert(typeof payload.summary === 'string' && payload.summary.length > 0, '趋势接口缺少 summary');
    for (const item of payload.series) {
      assert(Array.isArray(item.points) && item.points.length === payload.buckets.length, `序列「${item.name}」点数 ${item.points?.length} 与桶数 ${payload.buckets.length} 不一致`);
    }
  }

  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
  await page.goto(`${WEB}/staging/area`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '报表中心' }).click();
  const sub = page.locator('.kgd-sub');
  await sub.getByRole('button', { name: '质量管理' }).click();
  await sub.getByRole('button', { name: '不良品趋势分析', exact: true }).click();
  await page.waitForURL('**/waste_analysis');
  await page.addStyleTag({ content: '.kgd-ai{display:none!important}' });

  const card = page.locator('.kgd-trend-card');
  await card.getByRole('heading', { name: '不良品趋势分析', exact: true }).waitFor();
  assert(await card.getByRole('heading', { name: '不良品趋势分析', exact: true }).count() === 1, '图卡标题「不良品趋势分析」不唯一或不在图卡内');
  const filter = page.locator('.kgd-trend-filter');
  for (const name of PERIODS) {
    assert(await filter.getByRole('button', { name, exact: true }).count() === 1, `缺少报工时间「${name}」`);
  }
  for (const name of CHARTS) {
    assert(await card.getByRole('button', { name, exact: true }).count() === 1, `缺少图表切换「${name}」`);
  }
  assert(await filter.locator('.ant-picker').count() === 2, '日期区间不是两个日期框');
  assert(await filter.getByRole('button', { name: '查询', exact: true }).count() === 1, '缺少查询按钮');
  assert(await filter.getByText('不良品项', { exact: true }).count() === 1, '缺少不良品项');
  assert(await filter.getByRole('button', { name: '选择不良品项', exact: true }).count() === 1, '缺少不良品项选择');
  await card.locator('canvas').waitFor();

  const inputs = filter.locator('.ant-picker input');
  assert(await inputs.nth(0).inputValue() === month.from, `开始日期不是本月 ${month.from}`);
  assert(await inputs.nth(1).inputValue() === month.to, `结束日期不是本月 ${month.to}`);
  assert((await filter.locator('.ant-select-content').innerText()).replace(/\s/g, '') === '每天', '默认时间间隔不是每天');

  await filter.locator('.ant-select').click();
  const dropdown = page.locator('.ant-select-dropdown');
  await dropdown.waitFor();
  for (const name of INTERVALS) {
    assert(await dropdown.locator('.ant-select-item-option').filter({ hasText: new RegExp(`^${name}$`) }).count() === 1, `时间间隔下拉缺少「${name}」`);
  }
  await page.keyboard.press('Escape');
  await dropdown.waitFor({ state: 'hidden' });

  await filter.getByRole('button', { name: '今天', exact: true }).click();
  await filter.locator('.ant-select-content', { hasText: '每小时' }).waitFor();
  assert(await inputs.nth(0).inputValue() === today.from && await inputs.nth(1).inputValue() === today.to, '今天快捷档没有把日期收成当天');
  await page.getByText(todayApi.summary).first().waitFor();

  await filter.getByRole('button', { name: '本月', exact: true }).click();
  await filter.locator('.ant-select-content', { hasText: '每天' }).waitFor();
  await page.getByRole('heading', { name: '智能分析报告', exact: true }).waitFor();
  await page.getByRole('heading', { name: '数据明细', exact: true }).waitFor();
  await page.getByRole('columnheader', { name: monthApi.buckets[0].key, exact: true }).waitFor();
  await page.getByText(monthApi.summary).first().waitFor();
  assert(await page.getByRole('button', { name: '导出', exact: true }).count() === 1, '数据明细缺少导出');
  for (const title of ['不良品项', '占比', '合计', monthApi.buckets[0].key, monthApi.buckets.at(-1).key]) {
    assert(await page.getByRole('columnheader', { name: title, exact: true }).count() >= 1, `明细缺少列「${title}」`);
  }

  await assertChart(card, '面积图');
  await shot(page, '不良品趋势分析-面积图');
  await assertChart(card, '百分比面积图');
  await shot(page, '不良品趋势分析-百分比面积图');
  await assertChart(card, '折线图');
  await shot(page, '不良品趋势分析-折线图');
  await shot(page, '不良品趋势分析-全页');
  console.log('通过 不良品趋势分析图表页');
} catch (error) {
  await page.screenshot({ path: path.join(artifactDir, '失败.png'), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
