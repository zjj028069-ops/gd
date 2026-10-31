#!/usr/bin/env node
/**
 * 第十二轮：补采缺口闭环 + 剩余界面债。Playwright only。
 * 空库经正式接口造数。禁止 force、禁止 .catch 吞断言、禁止没数据就挑一条。
 * 截图：docs/verification/round12-debt/ 与 /opt/cursor/artifacts/round12-debt/
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/round12-debt';
const docDir = path.join(process.cwd(), 'docs/verification/round12-debt');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });

const startedAt = new Date();
const results = [];
const openShots = [];
const stamp = Date.now().toString().slice(-6);
const fieldName = `计划备注${stamp}`;
const fieldValue = `计划值${stamp}`;
const planName = `第十二轮计划${stamp}`;

function bj(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

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

async function shot(page, name, open = false) {
  await page.waitForTimeout(200);
  const p1 = path.join(artifactDir, `${name}.png`);
  const p2 = path.join(docDir, `${name}.png`);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.screenshot({ path: p1, fullPage: false });
      writeFileSync(p2, readFileSync(p1));
      if (open) openShots.push(name);
      console.log('saved', name, open ? 'open' : 'page');
      return;
    } catch (error) {
      lastErr = error;
      if (!/EAGAIN|EBUSY|resource temporarily unavailable/i.test(String(error))) throw error;
      await page.waitForTimeout(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

function btn(scope, name) {
  const body = [...name].map((ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch)).join('\\s*');
  return scope.getByRole('button', { name: new RegExp(`^\\s*${body}\\s*$`) });
}

function exactRe(label) {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

async function waitServers(ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const [apiRes, webRes] = await Promise.all([fetch(`${API}/api/auth/me`), fetch(WEB)]);
      if ([200, 401, 403, 429].includes(apiRes.status) && webRes.ok) return;
    } catch {
      /* 服务还在启动 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API(3001)/WEB(5173) 未就绪');
}

async function open(page, urlPath, waitText) {
  await page.goto(`${WEB}${urlPath}`);
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByText(waitText).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
  const alert = page.locator('.ant-alert-message');
  if (await alert.count()) throw new Error(`页面报错：${await alert.first().innerText()}`);
}

async function closeModals(page) {
  for (let i = 0; i < 6; i += 1) {
    const visible = page.locator('.ant-modal-wrap:visible, .ant-drawer-open');
    if (!(await visible.count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  const left = await page.locator('.ant-modal-wrap:visible, .ant-drawer-open').count();
  if (left) throw new Error(`仍有 ${left} 个浮层`);
}

async function expectTitle(page, title) {
  const modal = page.locator('.ant-modal').filter({ hasText: title }).last();
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  const heading = (await modal.locator('.ant-modal-title').innerText()).trim();
  if (heading !== title) throw new Error(`标题「${heading}」不等于「${title}」`);
  return modal;
}

async function clickExt(page) {
  const button = page.locator('.kgd-toolbar').getByRole('button', { name: /^扩展字段$/ });
  const count = await button.count();
  if (count !== 1) throw new Error(`扩展字段按钮数量 ${count}`);
  await button.click();
}

function assertCleanScript() {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  if (/\.force\s*:/.test(src) || /force:\s*true/.test(src)) throw new Error('脚本含 force');
  if (src.includes('.' + 'catch' + '(')) throw new Error('脚本含 .catch');
  if (src.includes(['选', '第一', '项'].join(''))) throw new Error('脚本含禁止的挑选措辞');
}

function md5File(file) {
  return createHash('md5').update(readFileSync(file)).digest('hex');
}

await step('1', '脚本自检无 force / catch 吞错', async () => {
  assertCleanScript();
  return '自检通过';
});

await step('2', '未回改 ListFrame 默认与客户地图', async () => {
  const diff = spawnSync('git', ['diff', '--name-only', '844596e'], { encoding: 'utf8' });
  if (diff.status !== 0) throw new Error(diff.stderr || `git diff ${diff.status}`);
  const names = diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const banned = names.filter((name) => name.endsWith('ListFrame.tsx') || name.endsWith('customers.tsx'));
  if (banned.length) throw new Error(`相对 844596e 改了禁改文件：${banned.join(', ')}`);
  const frame = readFileSync('apps/web/src/kgd/ListFrame.tsx', 'utf8');
  if (!frame.includes('showMobileCard = false')) throw new Error('showMobileCard 默认被改');
  if (!frame.includes('showOperationLog = false')) throw new Error('showOperationLog 默认被改');
  if (!frame.includes(String.raw`/[\u4e00-\u9fa5]/.test(extensionObject) && extensionCanAdd`)) throw new Error('扩展门禁被改');
  if (!frame.includes('if (!dlg?.fields?.length) return;')) throw new Error('openSpecDialog 护栏被改');
  const customers = readFileSync('apps/web/src/kgd/pages/money/customers.tsx', 'utf8');
  if (!customers.includes('地图视图') || !customers.includes('<p>客户地图视图</p>')) throw new Error('客户地图标记不在');
  const workplace = readFileSync('apps/web/src/kgd/pages/round10/workplace/WorkplacePage.tsx', 'utf8');
  const stubs = workplace.split('stub: true').length - 1;
  if (stubs !== 0) throw new Error(`工作台仍有 stub ${stubs}`);
  if (workplace.includes('占位组件')) throw new Error('工作台仍写着占位组件');
  for (const wrong of ['今日报工概况', '工序进度', '合同概况', '跟单提醒', '维保提醒', '报工排行', '设备稼动']) {
    if (workplace.includes(wrong)) throw new Error(`工作台仍有错名 ${wrong}`);
  }
  if (!workplace.includes('库存预警') || !workplace.includes('工单执行进度')) throw new Error('工作台缺少原版名');
  return `diff 不含 ListFrame/customers；错名清零，保留库存预警等原版名`;
});

await step('3', '补采文档齐', async () => {
  for (const file of ['remain-scan.md', '补采缺口.md', 'smart-report-notes.md']) {
    if (!existsSync(path.join(docDir, file))) throw new Error(`缺少 ${file}`);
  }
  const gaps = readFileSync(path.join(docDir, '补采缺口.md'), 'utf8');
  for (const id of ['GAP-01', 'GAP-02', 'GAP-03', 'GAP-04', 'GAP-05', 'GAP-06']) {
    if (!gaps.includes(id)) throw new Error(`补采缺口缺少 ${id}`);
  }
  const notes = readFileSync(path.join(docDir, 'smart-report-notes.md'), 'utf8');
  if (!notes.includes('设计器') || !notes.includes('小程序') || !notes.includes('推送')) throw new Error('智能报表笔记缺页签或设计器说明');
  const strategy = readFileSync('strategy/全站差异核实清单-2026-10-12.md', 'utf8');
  if (!strategy.includes('第十二轮补采与剩余界面债')) throw new Error('差异清单未追加修订段');
  return 'remain-scan、补采缺口、笔记、修订段都在';
});

await step('4', '服务就绪并登录', async () => {
  await waitServers();
  return '3001/5173 可访问';
});

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const credFile = path.join(process.cwd(), '.local/dev-credentials.txt');
const adminPassword = existsSync(credFile) ? passwordOf(credFile, 'admin.local') : '';
let admin = null;
await step('5', '管理员登录', async () => {
  if (!adminPassword) throw new Error('没有 .local/dev-credentials.txt 里的 admin.local');
  admin = await login('admin.local', adminPassword);
  await asUser(page, admin);
  return admin.username;
});

await step('6', '生产计划工具栏：有扩展、无移动端、有管理打印模板', async () => {
  await open(page, '/ProductionPlan/list', '计划编号');
  // antd 会在两个汉字的按钮文案中间插入空格，按字符间可有空白来匹配。
  for (const name of ['新增', '扩展字段', '列配置', '更多操作']) {
    const count = await btn(page, name).count();
    if (count !== 1) throw new Error(`「${name}」数量 ${count}`);
  }
  // 原版生产计划按钮没有「高级查询」。ListFrame 不再默认塞入，这里改成必须缺席。
  if (await btn(page, '高级查询').count() !== 0) throw new Error('生产计划不应出现高级查询');
  const batch = page.getByRole('button', { name: /^批量操作/ });
  if (await batch.count() !== 1) throw new Error(`批量操作 ${await batch.count()}`);
  if (await page.getByRole('button', { name: '移动端卡片配置' }).count()) throw new Error('出现移动端卡片配置');
  if (await btn(page, '管理打印模板').count() !== 1) throw new Error('管理打印模板应露出且只有一枚');
  if (await page.getByRole('button', { name: '操作记录' }).count()) throw new Error('出现操作记录');
  await shot(page, 'r12d-01-plan-toolbar', true);
  await batch.click();
  for (const label of ['批量物料分析', '批量打印', '批量删除']) {
    const item = page.getByRole('menuitem', { name: label });
    await item.waitFor({ state: 'visible', timeout: 5000 });
    if (await item.count() !== 1) throw new Error(`菜单「${label}」${await item.count()}`);
  }
  await shot(page, 'r12d-02-plan-batch', true);
  await page.keyboard.press('Escape');
  return '工具栏有扩展与管理打印模板，无移动端';
});

await step('7', '生产计划扩展字段可新增并重开仍在', async () => {
  await clickExt(page);
  const manager = await expectTitle(page, '【生产计划】扩展字段管理');
  if (await manager.getByRole('tab').count()) throw new Error('生产计划扩展出现了 Tab');
  await shot(page, 'r12d-03-plan-ext-manager', true);
  await btn(manager, '新增').click();
  const add = page.locator('.ant-modal').filter({ hasText: '新增扩展字段' }).last();
  await add.waitFor({ state: 'visible' });
  const typeText = (await add.locator('label').filter({ hasText: '字段类型' }).innerText()).replace(/\s/g, '');
  if (!typeText.includes('单行文本')) throw new Error(`字段类型「${typeText}」`);
  const reqText = (await add.locator('label').filter({ hasText: '是否必填' }).innerText()).replace(/\s/g, '');
  if (!reqText.includes('否')) throw new Error(`是否必填「${reqText}」`);
  const nameInput = add.locator('label').filter({ hasText: '字段名' }).locator('input');
  await nameInput.fill(fieldName);
  if (await nameInput.inputValue() !== fieldName) throw new Error('字段名未写入');
  await shot(page, 'r12d-04-plan-ext-add', true);
  await btn(add, '确定').click();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await add.isVisible())) break;
    if (await add.locator('.kgd-field-help').count()) throw new Error(await add.locator('.kgd-field-help').innerText());
    await page.waitForTimeout(200);
  }
  if (await add.isVisible()) throw new Error('新增扩展字段未关闭');
  await manager.getByText(fieldName, { exact: true }).waitFor();
  const heads = (await manager.locator('thead th').allInnerTexts()).map((item) => item.replace(/\s/g, ''));
  const reqIndex = heads.indexOf('是否必填');
  if (reqIndex < 0) throw new Error(`没有是否必填列 ${heads.join('|')}`);
  const row = manager.locator('.ant-table-row').filter({ hasText: fieldName });
  if (await row.count() !== 1) throw new Error(`字段行 ${await row.count()}`);
  const cell = (await row.locator('td').nth(reqIndex).innerText()).replace(/\s/g, '');
  if (cell !== '否') throw new Error(`是否必填「${cell}」`);
  await shot(page, 'r12d-05-plan-ext-saved', true);
  await closeModals(page);
  await clickExt(page);
  const again = await expectTitle(page, '【生产计划】扩展字段管理');
  if (await again.getByText(fieldName, { exact: true }).count() !== 1) throw new Error('重开后字段不在');
  await closeModals(page);
  return `${fieldName} 单行文本、非必填、重开仍在`;
});

await step('8', '扩展值随生产计划保存并可再打开', async () => {
  const products = await api(admin, 'GET', '/api/products?code=LOCAL001&page=1&page_size=20');
  const matched = (products.items ?? []).filter((item) => item.code === 'LOCAL001');
  if (matched.length !== 1) throw new Error(`LOCAL001 商品 ${matched.length} 条`);
  const created = await api(admin, 'POST', '/api/production-plans', {
    name: planName,
    lines: [{ product_id: matched[0].id, plan_qty: '1' }],
  });
  const planId = created.plan?.id;
  if (!planId) throw new Error(`创建计划无 id：${JSON.stringify(created).slice(0, 180)}`);
  const valuesReady = page.waitForResponse((res) => res.url().includes('/api/entity-ext-values') && res.request().method() === 'GET' && res.ok(), { timeout: 20000 });
  await page.goto(`${WEB}/ProductionPlan/add?id=${planId}`);
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn,.ant-back-top{display:none!important;pointer-events:none!important}' });
  await page.getByText('修改生产计划').first().waitFor({ timeout: 20000 });
  await valuesReady;
  await page.waitForFunction((name) => [...document.querySelectorAll('.kgd-form input')].some((el) => el instanceof HTMLInputElement && el.value === name), planName, { timeout: 15000 });
  const box = page.locator('.ext-fields');
  await box.waitFor({ timeout: 15000 });
  const fieldInput = page.locator('.ext-fields > span').filter({ hasText: exactRe(fieldName) }).locator('input');
  if (await fieldInput.count() !== 1) throw new Error(`「${fieldName}」输入 ${await fieldInput.count()}`);
  await fieldInput.fill(fieldValue);
  if (await fieldInput.inputValue() !== fieldValue) throw new Error('扩展值未写入');
  const saves = btn(page.locator('.kgd-actions'), '确定');
  if (await saves.count() !== 2) throw new Error(`保存按钮 ${await saves.count()}`);
  await saves.nth(0).click();
  await page.waitForURL(/\/ProductionPlan\/detail\//, { timeout: 15000 });
  const fields = await api(admin, 'GET', '/api/entity-ext-fields?entity=production_plan');
  const field = (fields.items ?? []).filter((item) => item.name === fieldName);
  if (field.length !== 1) throw new Error(`字段定义 ${field.length}`);
  const stored = await api(admin, 'GET', `/api/entity-ext-values?entity=production_plan&record_id=${planId}`);
  if (stored.values?.[field[0].id] !== fieldValue) throw new Error(`落库值「${JSON.stringify(stored.values ?? {}).slice(0, 240)}」字段 ${field[0].id}`);
  await open(page, `/ProductionPlan/add?id=${planId}`, '修改生产计划');
  await page.locator('.ext-fields').waitFor({ timeout: 15000 });
  await page.waitForFunction(({ name, expected }) => {
    const wrap = [...document.querySelectorAll('.ext-fields > span')].find((el) => (el.querySelector('span')?.textContent ?? '').trim() === name);
    const input = wrap?.querySelector('input');
    return input instanceof HTMLInputElement && input.value === expected;
  }, { name: fieldName, expected: fieldValue }, { timeout: 15000 });
  await shot(page, 'r12d-06-plan-editor-value', true);
  return `${planName} 扩展值已落库`;
});

await step('9', '采购检验分析无详情裸链', async () => {
  await open(page, '/material_test_report', '商品名');
  if (await btn(page, '详情').count()) throw new Error('仍有详情按钮');
  if (await page.getByRole('link', { name: /详\s*情/ }).count()) throw new Error('仍有详情链接');
  await shot(page, 'r12d-07-purchase-no-detail', true);
  return '采购检验分析无详情';
});

await step('10', '设备维修分析无设备详情', async () => {
  await open(page, '/device_maintenance_analysis', '总台数');
  if (await btn(page, '设备详情').count()) throw new Error('仍有设备详情');
  await shot(page, 'r12d-08-repair-no-device', true);
  return '设备维修分析无设备详情';
});

await step('11', '维修工作量无人员详情', async () => {
  await open(page, '/maintenance_workload_statistics', '人员数量');
  if (await btn(page, '人员详情').count()) throw new Error('仍有人员详情');
  await shot(page, 'r12d-09-workload-no-person', true);
  return '维修工作量无人员详情';
});

await step('12', '不良品项明细导出真实文件', async () => {
  await open(page, '/waste_detail', '产品编号');
  const button = btn(page, '导出');
  if (await button.count() !== 1) throw new Error(`导出按钮 ${await button.count()}`);
  await shot(page, 'r12d-10-waste-export', true);
  const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
  await button.click();
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  if (!filename.includes('不良品项明细')) throw new Error(`文件名「${filename}」`);
  return filename;
});

await step('13', '智能报表页签、推送与自定义弹窗', async () => {
  await open(page, '/smart/form_core_list', '电脑端报表');
  const active = () => page.locator('.ant-tabs-content-active');
  await active().getByRole('button', { name: /^销售简报/ }).waitFor();
  await active().getByRole('button', { name: /^生产简报/ }).waitFor();
  if (await page.getByText('服务简报').count()) throw new Error('出现服务简报');
  if (await page.getByText('进设计器').count()) throw new Error('出现进设计器');
  const custom = active().locator('[data-testid="smart-custom-card"]:visible');
  if (await custom.count() !== 1) throw new Error(`电脑端自定义卡 ${await custom.count()}`);
  await shot(page, 'r12d-11-smart-pc', true);
  await page.getByRole('tab', { name: '小程序报表' }).click();
  await active().getByRole('button', { name: /^销售简报/ }).waitFor();
  if (await active().locator('[data-testid="smart-custom-card"]:visible').count() !== 1) throw new Error('小程序没有自定义卡');
  if (await page.getByText('服务简报').count()) throw new Error('小程序出现服务简报');
  await shot(page, 'r12d-12-smart-mini', true);
  await page.getByRole('tab', { name: '推送设置' }).click();
  await page.getByText('是否推送', { exact: true }).waitFor();
  await page.getByText('推送时间', { exact: true }).waitFor();
  await page.getByText('推送设置仅保存，暂不实际推送').waitFor();
  if (await btn(page, '保存').count() !== 1) throw new Error('推送页没有唯一的保存');
  await shot(page, 'r12d-13-smart-push', true);
  await btn(page, '返回').click();
  await page.getByRole('tab', { name: '电脑端报表' }).waitFor();
  const customCard = page.locator('.ant-tabs-content-active [data-testid="smart-custom-card"]:visible');
  if (await customCard.count() !== 1) throw new Error(`回到电脑端后自定义卡 ${await customCard.count()}`);
  await customCard.click();
  const modal = await expectTitle(page, '自定义智能报表');
  for (const label of ['报表名称', '数据来源', '统计维度', '统计指标', '统计时间']) {
    if (!(await modal.getByText(label, { exact: true }).count())) throw new Error(`自定义弹窗缺 ${label}`);
  }
  if (await modal.getByText('进设计器').count()) throw new Error('自定义弹窗出现进设计器');
  await shot(page, 'r12d-14-smart-custom', true);
  await btn(modal, '取消').click();
  return '三页签与自定义弹窗一致，未进设计器';
});

await step('14', '列配置勾选、锁定、拖排、应用到其他人', async () => {
  await open(page, '/ProductionPlan/list', '计划编号');
  const config = page.getByRole('button', { name: exactRe('列配置') });
  if (await config.count() !== 1) throw new Error(`列配置 ${await config.count()}`);
  await config.click();
  const modal = page.locator('.ant-modal').filter({ hasText: '列配置' }).last();
  await modal.waitFor({ state: 'visible' });
  const heading = (await modal.locator('.ant-modal-title').innerText()).trim();
  if (!heading.startsWith('列配置(')) throw new Error(`标题「${heading}」`);
  const row = modal.locator('.ant-table-row').filter({ hasText: exactRe('计划名称') });
  if (await row.count() !== 1) throw new Error(`计划名称行 ${await row.count()}`);
  const box = row.getByRole('checkbox');
  if (await box.count() !== 1) throw new Error(`勾选 ${await box.count()}`);
  const before = await box.isChecked();
  await box.click();
  if (await box.isChecked() === before) throw new Error('勾选没有变化');
  const lock = row.getByRole('button', { name: '锁定' });
  if (await lock.count() !== 1) throw new Error(`锁定 ${await lock.count()}`);
  await lock.click();
  await row.getByRole('button', { name: '取消锁定' }).waitFor();
  const nameHandle = row.locator('[draggable="true"]');
  const codeRow = modal.locator('.ant-table-row').filter({ hasText: exactRe('计划编号') });
  if (await nameHandle.count() !== 1 || await codeRow.locator('[draggable="true"]').count() !== 1) throw new Error('拖排手柄不唯一');
  const beforeOrder = (await modal.locator('tbody tr td:nth-child(3)').allInnerTexts()).map((item) => item.trim());
  await nameHandle.dragTo(codeRow.locator('[draggable="true"]'));
  const afterOrder = (await modal.locator('tbody tr td:nth-child(3)').allInnerTexts()).map((item) => item.trim());
  if (beforeOrder.join('|') === afterOrder.join('|')) throw new Error(`拖排后顺序未变 ${afterOrder.join('|')}`);
  if (await btn(modal, '应用到其他人').count() !== 1) throw new Error('没有应用到其他人');
  await shot(page, 'r12d-15-column-config', true);
  await btn(modal, '取消').click();
  return `拖排 ${beforeOrder.join('>')} -> ${afterOrder.join('>')}`;
});

await step('15', '视图四段：基本信息、字段权限、数据过滤、默认排序', async () => {
  const manage = page.getByRole('button', { name: '视图管理' });
  if (await manage.count() !== 1) throw new Error(`视图管理 ${await manage.count()}`);
  await manage.click();
  const drawer = page.locator('.ant-modal').filter({ hasText: '新增视图' }).last();
  await drawer.waitFor({ state: 'visible' });
  const title = (await drawer.locator('.ant-modal-title').innerText()).trim();
  if (title !== '新增视图') throw new Error(`视图标题「${title}」`);
  for (const label of ['基本信息', '字段权限', '数据过滤', '默认排序']) {
    const section = drawer.getByRole('button', { name: exactRe(label) });
    if (await section.count() !== 1) throw new Error(`分段「${label}」${await section.count()}`);
    await section.click();
  }
  await drawer.getByText('默认排序', { exact: true }).waitFor();
  await shot(page, 'r12d-16-view-sections', true);
  await btn(drawer, '取消').click();
  return '四段都可打开';
});

await step('16', '生产计划查询条件抽屉', async () => {
  const query = page.getByRole('button', { name: '配置查询条件' });
  if (await query.count() !== 1) throw new Error(`配置查询条件 ${await query.count()}`);
  await query.click();
  const drawer = page.locator('.ant-drawer').filter({ hasText: '配置查询条件' });
  await drawer.waitFor({ state: 'visible' });
  const title = (await drawer.locator('.ant-drawer-title').innerText()).trim();
  if (title !== '配置查询条件') throw new Error(`抽屉标题「${title}」`);
  const planCode = drawer.getByRole('checkbox', { name: '计划编号' });
  if (await planCode.count() !== 1) throw new Error(`计划编号勾选 ${await planCode.count()}`);
  await shot(page, 'r12d-17-query-drawer', true);
  await btn(drawer, '取消').click();
  return '查询抽屉含计划编号';
});

await step('17', '设备档案与维保设置不露扩展字段', async () => {
  await open(page, '/device/list', '设备名称');
  if (await page.getByRole('button', { name: '扩展字段' }).count()) throw new Error('设备档案出现扩展字段');
  await shot(page, 'r12d-18-device-no-ext', true);
  await open(page, '/setting/inspection/setting', '基础设置');
  if (await page.getByRole('button', { name: '扩展字段' }).count()) throw new Error('维保设置出现扩展字段');
  await shot(page, 'r12d-19-setting-no-ext', true);
  return '两页都没有扩展字段';
});

await step('18', '快捷入口弹窗宫格', async () => {
  await open(page, '/staging/area', '配置工作台');
  const widget = page.locator('[data-testid="wp-widget-shortcuts"]');
  await widget.waitFor();
  const edit = widget.getByRole('button', { name: '编辑' });
  if (await edit.count() !== 1) throw new Error(`快捷入口编辑 ${await edit.count()}`);
  await edit.click();
  const item = page.getByRole('menuitem', { name: exactRe('编辑') });
  if (await item.count() !== 1) throw new Error(`编辑菜单 ${await item.count()}`);
  await item.click();
  const modal = await expectTitle(page, '添加快捷入口');
  await modal.getByText('已选快捷入口', { exact: true }).waitFor();
  await modal.getByText('可选快捷入口', { exact: true }).waitFor();
  const selected = modal.locator('[data-testid="shortcut-selected"] .wp-shortcut-tile');
  const picked = await selected.count();
  if (picked < 1) throw new Error('已选宫格为空');
  if (await modal.locator('[data-testid^="shortcut-optional-"]').count() < 1) throw new Error('可选分组不在');
  await shot(page, 'r12d-20-shortcuts', true);
  await btn(modal, '取消').click();
  return `已选 ${picked} 个`;
});

await step('19', '工作台按原版 18 项，错名清零', async () => {
  await btn(page, '配置工作台').click();
  await btn(page, '添加组件').waitFor();
  await btn(page, '添加组件').click();
  const modal = await expectTitle(page, '添加组件');
  const catalog = await modal.locator('[data-testid="wp-picker-grid"]').getAttribute('data-widget-count');
  if (catalog !== '18') throw new Error(`组件目录 ${catalog}`);
  const text = await modal.innerText();
  for (const wrong of ['今日报工概况', '工序进度', '合同概况', '跟单提醒', '维保提醒', '报工排行', '设备稼动']) {
    if (text.includes(wrong)) throw new Error(`添加组件仍有错名 ${wrong}`);
  }
  const card = modal.locator('[data-testid="wp-widget-card"][data-key="stock_alert"]');
  if (await card.count() !== 1) throw new Error(`库存预警卡片 ${await card.count()}`);
  await shot(page, 'r12d-21-widget-picker', true);
  const already = await card.evaluate((el) => el.classList.contains('is-disabled') || el.disabled);
  if (!already) {
    await card.click();
    await btn(modal, '确定').click();
  } else {
    await btn(modal, '取消').click();
  }
  const placed = page.locator('[data-testid="wp-widget-stock_alert"]');
  await placed.waitFor();
  await placed.scrollIntoViewIfNeeded();
  if (await placed.getByText('库存预警').count() < 1) throw new Error('看板上没有库存预警');
  if (await placed.getByText('占位组件').count()) throw new Error('库存预警仍是占位组件');
  await shot(page, 'r12d-22-widget-stub', true);
  return '目录 18，错名清零，库存预警可上墙';
});

await step('20', '客户地图按钮仍在且本轮不点开', async () => {
  await open(page, '/customer/list', '客户编号');
  const map = page.getByRole('button', { name: exactRe('地图视图') });
  if (await map.count() !== 1) throw new Error(`地图视图 ${await map.count()}`);
  if (await page.locator('.ant-modal').filter({ hasText: '客户地图视图' }).count()) throw new Error('地图弹窗已被打开');
  await shot(page, 'r12d-23-customer-map-button', true);
  return '地图视图按钮仍在，未点开';
});

await browser.close();

await step('21', '打开态至少 12 张且 MD5 互异，typecheck 与 build', async () => {
  if (openShots.length < 12) throw new Error(`打开态截图 ${openShots.length}：${openShots.join(',')}`);
  const hashes = new Map();
  for (const name of openShots) {
    const file = path.join(artifactDir, `${name}.png`);
    const hash = md5File(file);
    const dup = [...hashes.entries()].find(([, value]) => value === hash);
    if (dup) throw new Error(`${name} 与 ${dup[0]} MD5 相同 ${hash}`);
    const copy = md5File(path.join(docDir, `${name}.png`));
    if (copy !== hash) throw new Error(`${name} 两份截图不一致`);
    hashes.set(name, hash);
  }
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
  writeFileSync(path.join(docDir, 'r12d-ci.txt'), note);
  writeFileSync(path.join(artifactDir, 'r12d-ci.txt'), note);
  if (typecheck.status !== 0) throw new Error(`typecheck ${typecheck.status}\n${(typecheck.stderr || typecheck.stdout || '').slice(-500)}`);
  if (build.status !== 0) throw new Error(`build ${build.status}\n${(build.stderr || build.stdout || '').slice(-500)}`);
  return `打开态 ${openShots.length}；MD5 互异；typecheck/build 通过`;
});

const failed = results.filter((item) => item.result !== '通过');
const lines = [
  '# 第十二轮补采与剩余界面债验收记录',
  '',
  `- 开始（北京时间）：${bj(startedAt)}`,
  `- 结束（北京时间）：${bj()}`,
  `- 基线：HEAD 祖先含 844596e`,
  `- 脚本：scripts/round12-debt-accept.mjs`,
  `- 截图目录：docs/verification/round12-debt/`,
  `- 打开态截图 ${openShots.length}：${openShots.join('、')}`,
  `- 通过 ${results.length - failed.length} / ${results.length}`,
  '',
  '| # | 结果 | 说明 |',
  '|---|---|---|',
  ...results.map((item) => `| ${item.n} | ${item.result} | ${item.title} ${item.reason.replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
  '',
  '已恢复的原版入口：生产计划「管理打印模板」。仍隐藏：采购检验分析「详情」；设备维修分析「设备详情」；维修工作量「人员详情」；加工单详情工序/用料/父子单裸钮；甘特「今天」「列配置」；物联「添加」；精益未绑定查询、会议「修改」、巡查空文件框；若干页「列配置」假入口；设备打印/生成历史/查看二维码/详情修改；维修行打印与设备旁新增；维保空操作；点检无动作批量。',
  '',
  '补采缺口：`docs/verification/round12-debt/补采缺口.md`。未改客户地图，未臆造工作台指标与智能报表设计器，未回改 ListFrame 默认与扩展门禁，未合并，未开 CloudAgent。',
  '',
  '测试改动：`scripts/round12-debt-accept.mjs` 用 `btn()` 匹配按钮。antd 会在恰好两个汉字的按钮文案中间插入空格（新增、导出、确定），精确的 `^新增$` 对不上「新 增」。智能报表页签断言收在 `.ant-tabs-content-active`。扩展值在计划名称回填后再录入，避免初始空值覆盖刚输入的内容。',
  '',
];
writeFileSync(path.join(process.cwd(), 'docs/第十二轮补采与剩余界面债验收记录.md'), lines.join('\n'));
console.log(failed.length ? `未通过 ${failed.length}` : '全部通过');
process.exit(failed.length ? 1 : 0);
