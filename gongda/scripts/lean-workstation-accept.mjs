#!/usr/bin/env node
/**
 * 精益生产工作站报表页验收。只走 Playwright，不改断言放水。
 * 前置：npm run dev:setup && npm run dev
 * 截图：/opt/cursor/artifacts/lean-workstation/
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/lean-workstation';
mkdirSync(artifactDir, { recursive: true });

const PERIODS = ['昨天', '今天', '本周', '本月', '本季度', '本年'];
const TREND = ['现场巡查', '生产质检', '售后反馈', '客户投诉', '设计问题', '物料问题'];
const BOARDS = ['质量黑榜', '热处理黑榜', '焊接黑榜', '硬化处理黑榜', '机械加工黑榜', '防腐处理黑榜', '铸造/锻造黑榜'];

function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function passwordOf(username) {
  const text = readFileSync(path.join(process.cwd(), '.local/dev-credentials.txt'), 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  if (!matched) throw new Error(`凭据里没有 ${username}`);
  return matched[1];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function api(session, pathName, method = 'GET', body) {
  const write = method !== 'GET';
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: { cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status}: ${text.slice(0, 240)}`);
  return json;
}

async function shot(page, name) {
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: name.endsWith('全页') });
  console.log('saved', file);
}

async function shotBox(locator, name) {
  const file = path.join(artifactDir, `${name}.png`);
  await locator.screenshot({ path: file });
  console.log('saved', file);
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

async function assertCard(page, title, buttons, headers) {
  const card = page.getByRole('region', { name: title, exact: true });
  await card.waitFor();
  assert(await card.getByRole('heading', { name: title, exact: true }).count() === 1, `缺少卡片标题「${title}」`);
  for (const name of buttons) {
    assert(await card.getByRole('button', { name, exact: true }).count() === 1, `「${title}」缺少按钮「${name}」`);
  }
  for (const name of headers) {
    assert(await card.getByRole('columnheader', { name, exact: true }).count() === 1, `「${title}」缺少列「${name}」`);
  }
  const total = (await card.getByText(/共\d+条数据/).first().innerText()).replace(/\s/g, '');
  assert(/^共\d+条数据$/.test(total), `「${title}」分页文案不是共N条数据：${total}`);
  if (total === '共0条数据') {
    assert(await card.getByText('暂无数据', { exact: true }).count() >= 1, `「${title}」共0条时没有「暂无数据」`);
  }
  return card;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
const stamp = Date.now().toString().slice(-6);
const designText = `工作站验收设计${stamp}`;
const materialText = `工作站验收物料${stamp}`;
const meetingTitle = `工作站验收会议${stamp}`;
try {
  await waitServers();
  const session = await login('admin.local', passwordOf('admin.local'));
  const today = shanghaiToday();
  const report = await api(session, `/api/lean/workstation?from=${today}&to=${today}&grain=每天`);
  assert(Array.isArray(report.trend?.series), '趋势接口缺少 series');
  const seriesNames = report.trend.series.map((item) => item.name);
  assert(seriesNames.length === TREND.length && seriesNames.every((name, index) => name === TREND[index]), `趋势序列不是 ${TREND.join('、')}：${seriesNames.join('、')}`);
  for (const item of report.trend.series) {
    assert(item.points.length === report.trend.buckets.length, `序列「${item.name}」点数与桶数不一致`);
  }
  assert(report.trend.buckets[0]?.key?.endsWith('-01'), `每天粒度应从当月1日开始，实际 ${report.trend.buckets[0]?.key}`);
  assert(report.boards?.[0]?.name === '质量黑榜', '黑榜第一张不是质量黑榜');

  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
  await page.goto(`${WEB}/staging/area`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '精益生产', exact: true }).click();
  await page.locator('.kgd-sub').getByRole('button', { name: '精益生产工作站', exact: true }).click();
  await page.waitForURL('**/LeanProductionReportChart/ReportChart');
  await page.addStyleTag({ content: '.kgd-ai{display:none!important}' });
  await page.getByRole('heading', { name: '质量趋势图', exact: true }).waitFor();
  await page.locator('.kgd-top').getByText('报表', { exact: true }).waitFor();

  const filter = page.getByRole('region', { name: '统计筛选', exact: true });
  for (const name of PERIODS) {
    assert(await filter.getByRole('button', { name, exact: true }).count() === 1, `缺少统计周期「${name}」`);
  }
  assert(await filter.getByRole('button', { name: '今天', exact: true }).getAttribute('aria-pressed') === 'true', '默认统计周期不是今天');
  assert(await filter.getByRole('button', { name: '查询', exact: true }).count() === 1, '缺少查询');
  assert(await filter.getByRole('button', { name: '重置', exact: true }).count() === 1, '缺少重置');
  const dates = filter.locator('.ant-picker input');
  assert(await dates.count() === 2, '日期区间不是两个日期框');
  assert(await dates.nth(0).inputValue() === today, `开始日期不是今天 ${today}`);
  assert(await dates.nth(1).inputValue() === today, `结束日期不是今天 ${today}`);
  assert(await filter.getByRole('combobox', { name: '部门' }).count() === 1, '缺少部门级联');

  const chart = page.getByRole('region', { name: '质量趋势图', exact: true });
  assert((await chart.locator('.ant-select-content').innerText()).replace(/\s/g, '') === '每天', '趋势图默认粒度不是每天');
  await chart.locator('canvas').waitFor();
  const box = await chart.locator('canvas').boundingBox();
  assert(box && box.width >= 280 && box.height >= 200, `趋势图画布尺寸异常 ${JSON.stringify(box)}`);
  for (const name of TREND) {
    assert(await chart.locator('.lean-ws-legend').getByText(name, { exact: true }).count() === 1, `图例缺少「${name}」`);
  }
  await page.waitForLoadState('networkidle');
  await chart.getByLabel('粒度').click();
  const dropdown = page.locator('.ant-select-dropdown:visible');
  await dropdown.waitFor();
  for (const name of ['每天', '每周', '每月']) {
    const option = dropdown.locator('.ant-select-item-option-content', { hasText: new RegExp(`^${name}$`) });
    await option.waitFor();
    assert(await option.count() === 1, `粒度下拉缺少「${name}」：${await option.count()}`);
  }
  await page.keyboard.press('Escape');

  await assertCard(page, '质检问题', ['导出'], ['加工单', '工序名', '责任人', '不良品数', '状态', '质检备注']);
  await assertCard(page, '巡查问题', ['导出'], ['责任部门', '责任人', '问题分类', '状态', '问题描述']);
  const complaints = await assertCard(page, '客户投诉问题', ['新建投诉', '导出'], ['责任人', '责任部门', '产品', '投诉内容', '现场照片', '问题分析', '客户', '联系人', '联系电话', '状态', '创建时间', '操作']);
  await assertCard(page, '售后反馈问题', ['导出'], ['工单号', '故障类别', '生产工序', '状态', '责任人']);
  const designs = await assertCard(page, '设计问题', ['新增', '导出', '列配置'], ['产品', '问题描述', '现场照片', '问题关联', '处理状态', '处理人', '管理']);
  const materials = await assertCard(page, '物料问题', ['新增', '导出', '列配置'], ['商品', '问题描述', '现场照片', '问题关联', '处理状态', '处理人', '管理']);

  const board = page.getByRole('region', { name: '质量黑榜', exact: true });
  await board.getByRole('button', { name: '黑榜设置', exact: true }).waitFor();
  for (const name of report.boards.map((item) => item.name)) {
    assert(await board.getByRole('article', { name, exact: true }).count() === 1 || await board.locator('article', { hasText: name }).count() >= 1, `缺少黑榜「${name}」`);
    const card = board.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const items = report.boards.find((item) => item.name === name)?.items ?? [];
    if (!items.length) assert(await card.getByText('暂无数据', { exact: true }).count() >= 1, `「${name}」空态不是暂无数据`);
  }
  if (report.boards.length === BOARDS.length) {
    for (const name of BOARDS) {
      assert(await board.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) }).count() === 1, `默认黑榜缺少「${name}」`);
    }
  }

  const meetings = page.getByRole('region', { name: '精益生产会议', exact: true });
  await meetings.getByRole('button', { name: '发起会议', exact: true }).waitFor();
  for (const name of ['全部', '未落地', '已落地']) {
    assert(await meetings.getByRole('button', { name, exact: true }).count() === 1, `会议筛选缺少「${name}」`);
  }
  assert(await meetings.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed') === 'true', '会议筛选默认不是全部');
  for (const name of ['会议主题', '会议时间', '会议形式', '参会人员', '参会地点', '落实进度', '操作']) {
    assert(await meetings.getByRole('columnheader', { name, exact: true }).count() === 1, `会议缺少列「${name}」`);
  }
  const meetingTotal = (await meetings.getByText(/共\d+条数据/).first().innerText()).replace(/\s/g, '');
  if (meetingTotal === '共0条数据') assert(await meetings.getByText('暂无数据', { exact: true }).count() >= 1, '会议空态不是暂无数据');

  await shotBox(page.locator('.lean-ws-filter'), '筛选条');
  await shotBox(chart, '质量趋势图');
  await shot(page, '上半屏');
  await page.locator('.lean-ws-grid').first().scrollIntoViewIfNeeded();
  await shotBox(page.locator('.lean-ws-grid').first(), '四宫格');
  const complaintBody = complaints.locator('.ant-table-content, .ant-table-body').first();
  await complaintBody.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await shotBox(complaints, '客户投诉右侧列');
  await designs.scrollIntoViewIfNeeded();
  await shotBox(page.locator('.lean-ws-grid').nth(1), '设计与物料');
  await board.scrollIntoViewIfNeeded();
  await shotBox(board, '质量黑榜');
  await meetings.scrollIntoViewIfNeeded();
  await shotBox(meetings, '精益生产会议');

  await complaints.getByRole('button', { name: '新建投诉', exact: true }).click();
  const complaintDialog = page.getByRole('dialog', { name: '新建客户投诉' });
  await complaintDialog.waitFor();
  for (const name of ['产品', '客户', '联系人', '联系人电话', '投诉内容', '现场照片', '问题分析', '责任部门', '责任人']) {
    assert(await complaintDialog.getByText(name, { exact: true }).count() >= 1, `投诉弹窗缺少「${name}」`);
  }
  await complaintDialog.getByRole('button', { name: '取消', exact: true }).click();
  await complaintDialog.waitFor({ state: 'hidden' });

  await designs.getByRole('button', { name: '新增', exact: true }).click();
  const designDialog = page.getByRole('dialog', { name: '新增设计问题' });
  await designDialog.waitFor();
  await designDialog.getByLabel('设计问题描述').fill(designText);
  await designDialog.getByRole('button', { name: '确定', exact: true }).click();
  await designDialog.waitFor({ state: 'hidden' });
  await designs.getByText(designText, { exact: true }).waitFor();

  await materials.getByRole('button', { name: '新增', exact: true }).click();
  const materialDialog = page.getByRole('dialog', { name: '新增物料问题' });
  await materialDialog.waitFor();
  await materialDialog.getByRole('button', { name: '新增商品', exact: true }).click();
  const productDialog = page.getByRole('dialog', { name: '新增商品' });
  await productDialog.getByLabel('商品名称').waitFor();
  await productDialog.getByRole('button', { name: '取消', exact: true }).click();
  await productDialog.waitFor({ state: 'hidden' });
  await materialDialog.getByLabel('物料问题描述').fill(materialText);
  await materialDialog.getByRole('button', { name: '确定', exact: true }).click();
  await materialDialog.waitFor({ state: 'hidden' });
  await materials.getByText(materialText, { exact: true }).waitFor();

  await designs.getByRole('button', { name: '列配置', exact: true }).click();
  const columnDialog = page.getByRole('dialog', { name: /列配置/ });
  await columnDialog.waitFor();
  assert(await columnDialog.getByText('问题描述', { exact: true }).count() >= 1, '列配置里没有问题描述');
  await columnDialog.getByRole('button', { name: '取消', exact: true }).click();
  await columnDialog.waitFor({ state: 'hidden' });

  await meetings.getByRole('button', { name: '发起会议', exact: true }).click();
  const meetingDialog = page.getByRole('dialog', { name: '新增会议' });
  await meetingDialog.waitFor();
  for (const name of ['会议主题', '会议内容', '会议时间', '会议形式', '参会人员', '会议地点', '关联问题']) {
    assert(await meetingDialog.getByText(name, { exact: true }).count() >= 1, `会议弹窗缺少「${name}」`);
  }
  await meetingDialog.getByLabel('会议主题').fill(meetingTitle);
  await meetingDialog.getByLabel('会议时间').fill(`${today}T09:30`);
  await meetingDialog.getByLabel('参会人员').click();
  await page.keyboard.type('验收员');
  await page.keyboard.press('Enter');
  await meetingDialog.getByText('会议主题', { exact: true }).click();
  await meetingDialog.getByRole('button', { name: '确定', exact: true }).click();
  await meetingDialog.waitFor({ state: 'hidden' });
  await meetings.getByText(meetingTitle, { exact: true }).waitFor();
  await meetings.getByRole('button', { name: '未落地', exact: true }).click();
  await meetings.getByText(meetingTitle, { exact: true }).waitFor();
  await meetings.getByRole('button', { name: '已落地', exact: true }).click();
  assert(await meetings.getByText(meetingTitle, { exact: true }).count() === 0, '未落地会议出现在已落地筛选里');
  await meetings.getByRole('button', { name: '全部', exact: true }).click();

  const quality = page.getByRole('region', { name: '质检问题', exact: true });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    quality.getByRole('button', { name: '导出', exact: true }).click(),
  ]);
  assert(download.suggestedFilename() === '质检问题.csv', `导出文件名不是质检问题.csv：${download.suggestedFilename()}`);

  await board.getByRole('button', { name: '黑榜设置', exact: true }).click();
  const boardDialog = page.getByRole('dialog', { name: '黑榜设置' });
  await boardDialog.getByRole('button', { name: '前往精益生产设置', exact: true }).waitFor();
  const closeBoard = boardDialog.locator('.ant-modal-footer').getByRole('button', { name: '关闭', exact: true });
  assert(await closeBoard.count() === 1, '黑榜设置缺少关闭');
  await closeBoard.click();
  await boardDialog.waitFor({ state: 'hidden' });

  await page.addStyleTag({ content: '.kgd-main,.kgd-content{overflow:visible!important;height:auto!important}' });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('.kgd-main, .kgd-content').forEach((node) => { node.scrollTop = 0; });
  });
  await shot(page, '精益生产工作站-全页');

  const designRow = designs.locator('tr', { hasText: designText });
  await designRow.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await designs.getByText(designText, { exact: true }).waitFor({ state: 'hidden' });
  const materialRow = materials.locator('tr', { hasText: materialText });
  await materialRow.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await materials.getByText(materialText, { exact: true }).waitFor({ state: 'hidden' });
  const created = (await api(session, `/api/lean/workstation?from=${today}&to=${today}`)).meetings.find((item) => item.title === meetingTitle);
  assert(created?.id, '新建会议没有写进工作站');
  await api(session, `/api/lean/meetings/${created.id}`, 'DELETE');
  console.log('通过 精益生产工作站报表页');
} catch (error) {
  await page.screenshot({ path: path.join(artifactDir, '失败.png'), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
