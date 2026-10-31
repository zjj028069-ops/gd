#!/usr/bin/env node
/**
 * 第十二轮 P0 空壳公共修复。Playwright only。
 * 空库经正式接口造数。禁止 force、禁止 .catch 吞断言、禁止没数据就选第一项。
 * 截图：docs/verification/round12-shell/ 与 /opt/cursor/artifacts/round12-shell/
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/round12-shell';
const docDir = path.join(process.cwd(), 'docs/verification/round12-shell');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });

const results = [];
const stamp = Date.now().toString().slice(-6);
const woCode = `R12S${stamp}`;
const contactName = `联系人R12${stamp}`;
const customerName = `客户R12${stamp}`;
const missKeyword = `ZZNOMATCH${stamp}`;

function record(n, title, ok, reason = '') {
  results.push({ n, title, result: ok ? '通过' : '未通过', reason });
  console.log(ok ? '通过' : '未通过', n, title, reason);
}

async function step(n, title, fn) {
  try {
    const reason = await fn();
    record(n, title, true, reason ?? '');
  } catch (error) {
    record(n, title, false, String(error).slice(0, 800));
  }
}

function passwordOf(file, username) {
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
    if (res.ok && json.csrf_token) return { csrf: json.csrf_token, cookie, userId: json.user.id, username };
    const code = json?.error?.code || json?.code || '';
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 160);
    if (code === 'RATE_LIMITED' || /限流|RATE_LIMIT/i.test(msg) || res.status === 429) {
      const waitMs = Math.min(30000, 2000 * attempt);
      console.log(`登录限流 ${username}，${waitMs}ms 后重试 (${attempt}/8)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`登录失败 ${username}: ${res.status} ${msg}`);
  }
  throw new Error(`登录失败 ${username}: 限流重试耗尽`);
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
  await page.addInitScript((token) => { window.sessionStorage.setItem('kgd-csrf', token); }, session.csrf);
}

async function api(session, method, pathName, body) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  if (text) json = JSON.parse(text);
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function shot(page, name) {
  await page.waitForTimeout(250);
  const p1 = path.join(artifactDir, `${name}.png`);
  const p2 = path.join(docDir, `${name}.png`);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.screenshot({ path: p1, fullPage: false });
      writeFileSync(p2, readFileSync(p1));
      console.log('saved', name);
      return;
    } catch (error) {
      lastErr = error;
      if (!/EAGAIN|EBUSY|resource temporarily unavailable/i.test(String(error))) throw error;
      await page.waitForTimeout(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

function exactBtn(page, name) {
  return page.getByRole('button', { name, exact: true });
}

async function expectCount(page, name, count) {
  const loc = exactBtn(page, name);
  const got = await loc.count();
  if (got !== count) throw new Error(`按钮「${name}」数量 ${got}，期望 ${count}`);
  return loc;
}

async function open(page, urlPath, waitText) {
  await page.goto(`${WEB}${urlPath}`);
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByText(waitText).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
}

async function closeDialog(page) {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  if (await cancel.count() === 1) await cancel.click();
  else await dialog.locator('.ant-modal-close').click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
}

async function waitServers(ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const [apiRes, webRes] = await Promise.all([fetch(`${API}/api/auth/me`), fetch(WEB)]);
      if ([200, 401, 403, 429].includes(apiRes.status) && webRes.ok) return;
    } catch (error) {
      if (!/fetch|ECONNREFUSED|network/i.test(String(error))) throw error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API(3001)/WEB(5173) 未就绪');
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function writeReport() {
  const lines = [
    '# 第十二轮 P0 空壳公共修复验收记录',
    '',
    `时间：${new Date().toISOString()}`,
    '',
    '| # | 标题 | 结果 | 说明 |',
    '|---|---|---|---|',
    ...results.map((row) => `| ${row.n} | ${row.title} | ${row.result} | ${String(row.reason).replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
    '',
  ];
  const text = lines.join('\n');
  writeFileSync(path.join(process.cwd(), 'docs/第十二轮P0空壳公共修复验收记录.md'), text);
  writeFileSync(path.join(docDir, 'accept-record.md'), text);
}

await waitServers();
const password = passwordOf('.local/dev-credentials.txt', 'admin.local');
if (!password) throw new Error('找不到 admin.local 凭据，造数中止');
const admin = await login('admin.local', password);

const products = await api(admin, 'GET', '/api/products?page=1&page_size=100');
const product = (products.items ?? []).find((item) => item.code === 'LOCAL001');
if (!product?.id) throw new Error('空库没有商品 LOCAL001，停止造数');

const warehouse = await api(admin, 'POST', '/api/warehouses', {
  request_key: randomUUID(),
  code: `WH${stamp}`,
  name: `验收仓${stamp}`,
});
if (!warehouse.warehouse?.id) throw new Error(`仓库创建失败：${JSON.stringify(warehouse).slice(0, 200)}`);

const processCreated = await api(admin, 'POST', '/api/processes', {
  code: `GX${stamp}`,
  name: `验收工序${stamp}`,
  standard_minutes: '1',
});
const processId = processCreated.process?.id;
if (!processId) throw new Error(`工序创建失败：${JSON.stringify(processCreated).slice(0, 200)}`);

const order = await api(admin, 'POST', '/api/work-orders', {
  request_key: randomUUID(),
  code: woCode,
  product_id: product.id,
  quantity: '1',
  requires_fg_inspection: false,
  require_cost: false,
  planned_start: todayShanghai(),
  planned_end: todayShanghai(),
  tasks: [{ process_id: processId }],
});
const createdCode = order.work_order?.code;
if (createdCode !== woCode) throw new Error(`加工单号不是指定的 ${woCode}，实际 ${createdCode ?? '空'}`);

const customer = await api(admin, 'POST', '/api/money/customers', {
  request_key: randomUUID(),
  code: `KH${stamp}`,
  name: customerName,
  contact_name: contactName,
  contact_phone: `138${stamp}00`,
});
if (!customer.customer?.id) throw new Error(`客户创建失败：${JSON.stringify(customer).slice(0, 200)}`);
if (customer.customer.contact_name !== contactName) throw new Error('客户联系人姓名与指定值不一致');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await asUser(page, admin);

await step('1', '盘点与默认 false', async () => {
  const file = path.join(docDir, 'mobile-inventory.md');
  const text = readFileSync(file, 'utf8');
  const src = readFileSync('apps/web/src/kgd/ListFrame.tsx', 'utf8');
  if (!src.includes('showMobileCard = false')) throw new Error('ListFrame 默认不是 false');
  if (!text.includes('showMobileCard = false')) throw new Error('盘点未写默认 false');
  if (!text.includes('**42**')) throw new Error('盘点未写 42');
  const rows = text.split('\n').filter((line) => line.startsWith('| /') && line.includes('| true'));
  if (rows.length !== 42) throw new Error(`盘点 true 行 ${rows.length}，不是 42`);
  const note = [
    'ListFrame 默认 showMobileCard = false',
    `盘点 true 行 ${rows.length}`,
    file,
  ].join('\n');
  writeFileSync(path.join(docDir, 'r12s-01-inventory.md'), note);
  writeFileSync(path.join(artifactDir, 'r12s-01-inventory.md'), note);
  return `true 行 ${rows.length}`;
});

await step('2', '加工单移动端打开态', async () => {
  await open(page, '/inside_produce_bill/list', '移动端卡片配置');
  const button = await expectCount(page, '移动端卡片配置', 1);
  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const title = (await dialog.locator('.ant-modal-title').innerText()).trim();
  if (title !== '移动端卡片配置') throw new Error(`标题 ${title}`);
  for (const tab of ['列表卡片', '详情卡片', '任务卡片', '进度分享']) {
    if (await dialog.getByRole('tab', { name: tab, exact: true }).count() !== 1) throw new Error(`缺少 Tab ${tab}`);
  }
  await shot(page, 'r12s-02-wo-mobile-open');
  await closeDialog(page);
  return title;
});

await step('3', '客户移动端打开态', async () => {
  await open(page, '/customer/list', '移动端卡片配置');
  const button = await expectCount(page, '移动端卡片配置', 1);
  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const title = (await dialog.locator('.ant-modal-title').innerText()).trim();
  if (title !== '移动端卡片配置') throw new Error(`标题 ${title}`);
  for (const tab of ['客户列表卡片', '客户详情卡片']) {
    if (await dialog.getByRole('tab', { name: tab, exact: true }).count() !== 1) throw new Error(`缺少 Tab ${tab}`);
  }
  await shot(page, 'r12s-03-customer-mobile-open');
  await closeDialog(page);
  return title;
});

await step('4', '联系人工具栏无移动端/操作记录/批量', async () => {
  await open(page, '/linkman/list', contactName);
  await expectCount(page, '移动端卡片配置', 0);
  await expectCount(page, '操作记录', 0);
  await expectCount(page, '批量操作', 0);
  await expectCount(page, '扩展字段', 1);
  await expectCount(page, '列配置', 1);
  if (await page.getByText('暂无操作记录').count() !== 0) throw new Error('出现暂无操作记录');
  await shot(page, 'r12s-04-linkman-toolbar');
  return '查询区与扩展字段、列配置可见';
});

await step('5', '销售对账无移动端与死按钮', async () => {
  await open(page, '/sales_statement', '销售对账单');
  await expectCount(page, '移动端卡片配置', 0);
  await expectCount(page, '管理打印模板', 1);
  await expectCount(page, '统计数值', 0);
  await expectCount(page, '出库明细', 0);
  await expectCount(page, '退货明细', 0);
  await shot(page, 'r12s-05-sales-recon-toolbar');
  return '管理打印模板已露出；统计数值与明细仍隐藏';
});

await step('6', '机台报表无扩展无移动端', async () => {
  await open(page, '/drilling_crew_statement/list', '机台报表');
  await expectCount(page, '扩展字段', 0);
  await expectCount(page, '移动端卡片配置', 0);
  await shot(page, 'r12s-06-machine-regression');
  return '回归保持关闭';
});

await step('7', '生产计划无移动端且批量仅一枚', async () => {
  await open(page, '/ProductionPlan/list', '批量操作');
  await expectCount(page, '移动端卡片配置', 0);
  const batch = await expectCount(page, '批量操作', 1);
  await batch.hover();
  await batch.click();
  for (const item of ['批量物料分析', '批量打印', '批量删除']) {
    const menuItem = page.getByRole('menuitem', { name: item, exact: true });
    await menuItem.waitFor({ state: 'visible', timeout: 8000 });
    if (await menuItem.count() !== 1) throw new Error(`缺少菜单 ${item}`);
  }
  await shot(page, 'r12s-07-plan-toolbar');
  await page.keyboard.press('Escape');
  return '一枚真批量';
});

await step('8', '加工单批量仅一枚且菜单非空', async () => {
  await open(page, '/inside_produce_bill/list', '批量操作');
  const batch = await expectCount(page, '批量操作', 1);
  await batch.hover();
  await batch.click();
  for (const item of ['批量开始', '批量打印']) {
    const menuItem = page.getByRole('menuitem', { name: item, exact: true });
    await menuItem.waitFor({ state: 'visible', timeout: 8000 });
    if (await menuItem.count() !== 1) throw new Error(`缺少菜单 ${item}`);
  }
  await shot(page, 'r12s-08-wo-single-batch');
  await page.keyboard.press('Escape');
  return '一枚';
});

await step('9', '操作记录不出现假窗', async () => {
  for (const url of ['/inside_produce_bill/list', '/linkman/list', '/production_project/list', '/MaterialAnalysis/list']) {
    await page.goto(`${WEB}${url}`);
    await page.getByRole('button', { name: '查询', exact: true }).waitFor({ timeout: 20000 });
    if (await exactBtn(page, '操作记录').count() !== 0) throw new Error(`${url} 仍有操作记录`);
    if (await exactBtn(page, '创建记录').count() !== 0) throw new Error(`${url} 仍有创建记录假钮`);
    if (await page.getByText('暂无操作记录').count() !== 0) throw new Error(`${url} 出现暂无操作记录`);
    if (await page.getByText('暂无创建记录').count() !== 0) throw new Error(`${url} 出现暂无创建记录`);
  }
  await shot(page, 'r12s-09-no-fake-oplog');
  return '四页均无假操作记录';
});

await step('10', '成本报表无批量', async () => {
  await open(page, '/produce_bill_cost', '成本报表');
  await expectCount(page, '批量操作', 0);
  await expectCount(page, '移动端卡片配置', 0);
  await shot(page, 'r12s-10-cost-batch');
  return '已隐藏';
});

await step('11', '加工单无导出打印假入口', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await expectCount(page, '导出/打印模板', 1);
  if (await page.getByText('请从更多操作导出').count() !== 0) throw new Error('仍有假导出提示');
  await shot(page, 'r12s-11-wo-export');
  return '导出/打印模板为真入口';
});

await step('12', '排产查询改变结果', async () => {
  const seen = [];
  const onRequest = (req) => {
    if (req.url().includes('/api/progress/scheduling')) seen.push(req.url());
  };
  page.on('request', onRequest);
  await open(page, '/ProductionScheduling/list', woCode);
  const before = seen.filter((url) => url.includes(missKeyword)).length;
  await page.getByPlaceholder('输入关键字查询').fill(missKeyword);
  await page.waitForTimeout(1200);
  if (seen.filter((url) => url.includes(missKeyword)).length !== before) throw new Error('未点查询就按关键字请求了');
  if (await page.getByText(woCode, { exact: true }).count() < 1) throw new Error('点查询前加工单号已消失');
  await exactBtn(page, '查询').click();
  await page.getByText('共 0 条数据').waitFor({ timeout: 15000 });
  if (await page.getByText(woCode, { exact: true }).count() !== 0) throw new Error('查询后加工单号仍在');
  const queried = seen.some((url) => url.includes(encodeURIComponent(missKeyword)) || url.includes(missKeyword));
  if (!queried) throw new Error('点击查询后没有带关键字的请求');
  await shot(page, 'r12s-12-sched-query');
  page.off('request', onRequest);
  return `${woCode} → 0 条`;
});

await step('13', '精益会议无议程空壳', async () => {
  await open(page, '/meeting/list', '新建会议');
  await expectCount(page, '会议议程字段', 0);
  if (await page.getByText('会议议程字段').count() !== 0) throw new Error('仍有会议议程字段文案');
  await shot(page, 'r12s-13-lean-agenda');
  return '按钮已隐藏';
});

await step('14', '产量报表无移动端', async () => {
  await open(page, '/output_statistics_report', '产量报表');
  await expectCount(page, '移动端卡片配置', 0);
  await shot(page, 'r12s-14-report-no-mobile');
  return '产量报表';
});

await step('15', '无 fields 不弹规格假窗', async () => {
  await open(page, '/inside_produce_bill/list', '排单');
  await exactBtn(page, '排单').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const title = (await dialog.locator('.ant-modal-title').innerText()).trim();
  if (title !== '加工单排单') throw new Error(`排单标题 ${title}`);
  if (await dialog.getByText('加工单排单只支持父加工单').count() !== 1) throw new Error('排单不是真弹窗');
  if (await dialog.locator('p.kgd-muted').count() !== 0) throw new Error('排单弹窗仍有规格空段落');
  const src = readFileSync('apps/web/src/kgd/ListFrame.tsx', 'utf8');
  if (src.includes('specDlg?.trigger}</p>') || src.includes('{specDlg?.trigger}</p>')) throw new Error('ListFrame 仍渲染 trigger 空段落');
  await shot(page, 'r12s-15-no-spec-shell');
  await closeDialog(page);
  await open(page, '/linkman/list', contactName);
  const row = page.locator('tr', { hasText: contactName });
  if (await row.count() !== 1) throw new Error(`联系人行数量 ${await row.count()}，拒绝猜测`);
  await row.getByRole('button', { name: '修改', exact: true }).click();
  const edit = page.getByRole('dialog');
  await edit.waitFor();
  const editTitle = (await edit.locator('.ant-modal-title').innerText()).trim();
  if (editTitle !== '修改客户联系人') throw new Error(`修改标题 ${editTitle}`);
  if (await edit.locator('input').count() < 1) throw new Error('修改弹窗没有输入框');
  if (await edit.locator('p.kgd-muted').count() !== 0) throw new Error('修改弹窗是规格空壳');
  await closeDialog(page);
  return '排单真弹窗；联系人修改进真表单';
});

await step('16', '源码扫描假操作记录与裸批量', async () => {
  const rg = spawnSync('rg', ['-n', '暂无操作记录|暂无创建记录', 'apps/web/src', 'apps/api/src'], { encoding: 'utf8' });
  const bare = spawnSync('rg', ['--pcre2', '-n', '<Button>批量操作</Button>(?!</Dropdown>)|<Button disabled>批量操作</Button>', 'apps/web/src'], { encoding: 'utf8' });
  const note = [
    `暂无操作记录/暂无创建记录 exit ${rg.status}`,
    rg.stdout || '(无匹配)',
    rg.stderr || '',
    `裸批量 exit ${bare.status}`,
    bare.stdout || '(无匹配)',
    bare.stderr || '',
  ].join('\n');
  writeFileSync(path.join(docDir, 'r12s-16-rg.txt'), note);
  writeFileSync(path.join(artifactDir, 'r12s-16-rg.txt'), note);
  if (rg.status === 0) throw new Error(`仍有假文案：${rg.stdout}`);
  if (bare.status === 0) throw new Error(`仍有裸批量：${bare.stdout}`);
  if (rg.status !== 1 || bare.status !== 1) throw new Error(`rg 异常 oplog=${rg.status} bare=${bare.status}`);
  return '业务路径为零';
});

await step('17', '白名单外三页无移动端', async () => {
  for (const [url, text] of [
    ['/contract_report', '合同报表'],
    ['/inventory_summary', '进销存'],
    ['/clock_in_report', '打卡'],
  ]) {
    await open(page, url, text);
    await expectCount(page, '移动端卡片配置', 0);
  }
  await shot(page, 'r12s-17-sample-no-mobile');
  return '合同报表、进销存、打卡';
});

await step('18', '禁 force/catch/选第一项，并跑 typecheck 与 build', async () => {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  if (/\.force\s*:/.test(src) || /force:\s*true/.test(src)) throw new Error('脚本含 force');
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/await step\('18'[\s\S]*$/m, '');
  if (/\.catch\s*\(/.test(withoutComments)) throw new Error('脚本含 .catch');
  if (withoutComments.includes(['选', '第一', '项'].join(''))) throw new Error('脚本含禁止的挑选措辞');
  const typecheck = spawnSync('npm', ['run', 'typecheck'], { encoding: 'utf8', timeout: 180000 });
  const build = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', timeout: 300000 });
  const note = [
    `typecheck exit ${typecheck.status}`,
    (typecheck.stdout ?? '').slice(-800),
    (typecheck.stderr ?? '').slice(-800),
    `build exit ${build.status}`,
    (build.stdout ?? '').slice(-800),
    (build.stderr ?? '').slice(-800),
  ].join('\n');
  const clean = note.replace(/\u0000/g, '');
  writeFileSync(path.join(docDir, 'r12s-18-ci.txt'), clean);
  writeFileSync(path.join(artifactDir, 'r12s-18-ci.txt'), clean);
  if (typecheck.status !== 0) throw new Error(`typecheck ${typecheck.status}`);
  if (build.status !== 0) throw new Error(`build ${build.status}`);
  return 'typecheck/build 通过';
});

await browser.close();
writeReport();
const failed = results.filter((row) => row.result !== '通过');
if (failed.length) {
  console.error('未通过', failed.map((row) => row.n).join(','));
  process.exit(1);
}
console.log('全部通过', results.length);
