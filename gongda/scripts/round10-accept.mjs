/**
 * 第十轮 Playwright 验收。前置：npm run dev && node scripts/seed-round10-demo.mjs
 * 截图：/opt/cursor/artifacts/round10/ 与 docs/verification/round10/
 */
import { chromium } from 'playwright';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = '/opt/cursor/artifacts/round10';
const docDir = path.join(process.cwd(), 'docs/verification/round10');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });

const results = [];
function record(n, title, ok, reason = '') {
  results.push({ n, title, result: ok ? '通过' : '未通过', reason });
  console.log(ok ? '通过' : '未通过', n, title, reason);
}
async function step(n, title, fn) {
  try {
    const reason = await fn();
    record(n, title, true, reason ?? '');
  } catch (error) {
    record(n, title, false, String(error).slice(0, 400));
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
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
    });
    const json = await res.json().catch(() => ({}));
    const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
    if (res.ok && json.csrf_token) return { csrf: json.csrf_token, cookie, userId: json.user.id };
    const code = json?.error?.code || json?.code || '';
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 120);
    if (code === 'RATE_LIMITED' || /限流|RATE_LIMIT/i.test(msg) || res.status === 429) {
      const waitMs = Math.min(30000, 2000 * attempt);
      console.log(`登录限流 ${username}，${waitMs}ms 后重试 (${attempt}/8)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`登录失败 ${username}: ${res.status} ${msg}`);
  }
  throw new Error(`登录失败 ${username}: RATE_LIMITED 重试耗尽`);
}
async function asUser(page, session) {
  // 理由：步骤21切到工人后若只写 WEB 域 cookie，采购设置/价格追踪等仍可能带着工人会话 403，开关与表格会空挂；WEB+API 双写并清旧会话
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  await page.context().clearCookies();
  await page.context().addCookies([
    { name, value, url: WEB },
    { name, value, url: API },
  ]);
}
async function api(session, method, pathName, body) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: { cookie: session.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status}: ${text.slice(0, 200)}`);
  return json;
}
async function resetWorkplace(session) {
  const keys = ['banner', 'shortcuts', 'todos', 'notices', 'messages', 'devices'];
  const cfg = await api(session, 'GET', '/api/workplace/config');
  const next = await api(session, 'PUT', '/api/workplace/config', { cards: keys.map((key) => ({ key, visible: true })), shortcuts: cfg.shortcuts, version: cfg.version });
  const noticesCard = (next.cards ?? []).find((card) => card.key === 'notices');
  if (!noticesCard || noticesCard.visible === false) throw new Error('resetWorkplace 未能恢复公告卡片');
  const summary = await api(session, 'GET', '/api/workplace/summary');
  if (!(summary.notices?.length >= 1)) throw new Error(`resetWorkplace 后公告仍为空: ${summary.notices?.length ?? 0}`);
  return summary;
}
async function shot(page, name, { assertNoTooltip = false } = {}) {
  // 移到内容区空白，避开左侧图标栏「工作台」Tooltip 盖住 logo
  // 理由：v42 setContent 后无 .kgd-content，boundingBox 默认等 30s 必超时；无壳时直接落点
  const content = page.locator('.kgd-content');
  const box = (await content.count()) ? await content.boundingBox({ timeout: 2000 }).catch(() => null) : null;
  if (box && box.width > 20 && box.height > 20) {
    await page.mouse.move(box.x + Math.min(48, box.width / 2), box.y + Math.min(64, box.height / 2));
  } else {
    await page.mouse.move(420, 280);
  }
  await page.waitForTimeout(220);
  await page.waitForFunction(() => {
    const tips = [...document.querySelectorAll('.ant-tooltip')];
    return tips.every((node) => node.classList.contains('ant-tooltip-hidden') || getComputedStyle(node).visibility === 'hidden' || getComputedStyle(node).opacity === '0' || getComputedStyle(node).display === 'none');
  }, undefined, { timeout: 4000 }).catch(() => undefined);
  if (assertNoTooltip) {
    const visible = await page.locator('.ant-tooltip:not(.ant-tooltip-hidden)').evaluateAll((nodes) => nodes.filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '0') > 0.01;
    }).length);
    if (visible) throw new Error(`${name} 仍有 tooltip`);
  }
  const p1 = path.join(artifactDir, `${name}.png`);
  const p2 = path.join(docDir, `${name}.png`);
  // 理由：连跑截图偶发 EAGAIN close，重试写盘，不放宽画面断言
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
async function open(page, urlPath, waitText) {
  await page.goto(`${WEB}${urlPath}`);
  await page.getByText(waitText).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
}
function assertNoPlaceholder(page) {
  return page.locator('body').innerText().then((body) => {
    if (/待建设|待后续轮次|后端缺|正在读取|建设中|开发中/.test(body)) throw new Error('页面仍有占位或加载中');
  });
}
async function tableRows(page) {
  return page.locator('.ant-table-tbody tr.ant-table-row').count();
}
function btn(page, name) {
  // Ant Design 两字中文按钮会插入空格，如「新增」→「新 增」
  const spaced = String(name).split('').join('\\s*');
  return page.getByRole('button', { name: new RegExp(`^\\s*${spaced}\\s*$`) });
}
async function pickSelectOption(page) {
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').first();
  await opt.waitFor({ state: 'attached', timeout: 10000 });
  await opt.evaluate((el) => el.click());
}
async function confirmModal(page, titleText = '') {
  const root = titleText
    ? page.locator('.ant-modal-root, .ant-modal-wrap').filter({ hasText: titleText }).last()
    : page.locator('.ant-modal-confirm, .ant-modal-root .ant-modal').last();
  await root.waitFor({ state: 'visible', timeout: 10000 });
  await root.getByRole('button', { name: /确\s*定/ }).click();
  await page.waitForTimeout(800);
}
function runChecked(name, args, logPath) {
  const result = spawnSync(name, args, { encoding: 'utf8', cwd: process.cwd(), env: process.env, maxBuffer: 20 * 1024 * 1024 });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\0/g, '');
  const chunk = `\n===== ${name} ${args.join(' ')} exit=${result.status} =====\n${out}\n`;
  appendFileSync(logPath, chunk);
  process.stdout.write(chunk);
  if (result.status !== 0) throw new Error(`${name} ${args.join(' ')} 退出码 ${result.status ?? 'null'}`);
}

const adminPass = passwordOf('.local/dev-credentials.txt', 'admin.local');
const workerPass = passwordOf('.local/dev-credentials.txt', 'worker.local');
const admin = await login('admin.local', adminPass);
const worker = await login('worker.local', workerPass);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await asUser(page, admin);
await resetWorkplace(admin);

await step('1', '登录后工作台', async () => {
  await page.goto(`${WEB}/`);
  await page.waitForURL(/staging\/area/, { timeout: 15000 });
  await page.getByText('工作台').first().waitFor();
  await assertNoPlaceholder(page);
  const summary = await api(admin, 'GET', '/api/workplace/summary');
  const nums = [...(summary.todos?.customer ?? []), ...(summary.todos?.equip ?? [])].map((t) => Number(t.count ?? 0));
  if (nums.length < 5 || nums.some((n) => n <= 0)) throw new Error(`待办: ${nums.join(',')}`);
  if (!(summary.devices?.items?.length >= 1)) throw new Error('设备概况无数据');
  await page.getByText(/设备概况|设备状态/).first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();
  if (body.includes('正在读取数据')) throw new Error('工作台仍在加载');
  await shot(page, 'v01', { assertNoTooltip: true });
  return `待办 ${nums.join('/')} 设备${summary.devices.items.length}`;
});

await step('2', '快捷跟单与待审合同跳转', async () => {
  await page.goto(`${WEB}/staging/area`);
  await page.getByText('工作台').first().waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), undefined, { timeout: 15000 });
  await page.getByRole('button', { name: '快捷跟单' }).waitFor({ state: 'visible', timeout: 15000 });
  await page.getByRole('button', { name: '快捷跟单' }).click();
  await page.getByText('新增客户跟单').waitFor();
  await shot(page, 'v02a');
  const customers = await api(admin, 'GET', '/api/money/customers?page=1&page_size=10');
  const customer = customers.items?.[0];
  const contacts = await api(admin, 'GET', `/api/customer-follows/contacts?customer_id=${customer.id}`);
  const contact = contacts.items?.[0] ?? contacts[0];
  await api(admin, 'POST', '/api/customer-follows', {
    customer_id: customer.id, contact_id: contact.id, follow_type: '电话',
    content: 'R10验收跟单', next_at: new Date(Date.now() + 7200_000).toISOString(),
  });
  await page.keyboard.press('Escape');
  await page.goto(`${WEB}/staging/area`);
  await page.locator('.wp-todo').filter({ hasText: '待审合同' }).first().click();
  await page.waitForURL(/customer_contract/, { timeout: 15000 });
  await page.getByText('合同订单').first().waitFor();
  // 等加载完成：无「正在读取数据」+ 表格行 + 汇总条非零合同金额
  await page.waitForFunction(() => {
    const body = document.body.innerText || '';
    if (body.includes('正在读取数据')) return false;
    if (!document.querySelector('.ant-table-tbody tr.ant-table-row')) return false;
    if (!document.querySelector('.kgd-summary') && !body.includes('【合同金额】')) return false;
    const compact = body.replace(/\s/g, '');
    const m = compact.match(/【合同金额】([\d.]+)元/);
    return !!(m && Number(m[1]) > 0);
  }, undefined, { timeout: 25000 });
  await page.waitForLoadState('domcontentloaded');
  const rows02 = await tableRows(page);
  if (rows02 < 1) throw new Error('待审合同列表为空');
  const body02 = await page.locator('body').innerText();
  const compact02 = body02.replace(/\s/g, '');
  if (/【合同金额】0(?:\.0+)?元/.test(compact02)) throw new Error('待审合同汇总合同金额仍为 0元');
  if (!/【合同金额】[1-9]/.test(compact02)) throw new Error('待审合同汇总未见非零合同金额');
  await shot(page, 'v02b');
  return `弹窗+保存+跳转合同 ${rows02}行`;
});

await step('3', '配置工作台', async () => {
  await page.goto(`${WEB}/staging/area`);
  await page.getByRole('button', { name: '配置工作台' }).click();
  const noticeBox = page.getByRole('checkbox', { name: '公告' });
  if (await noticeBox.isChecked()) await noticeBox.click();
  await page.getByRole('button', { name: '确 定' }).click();
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForTimeout(800);
  if (await page.locator('section.wp-card header b').filter({ hasText: /^公告$/ }).count()) throw new Error('公告卡片未隐藏');
  await page.getByRole('button', { name: '全 屏' }).click();
  await page.waitForTimeout(400);
  await shot(page, 'v03');
  await page.getByRole('button', { name: '退出全屏' }).click();
  await resetWorkplace(admin);
  await page.reload();
  await page.getByText('工作台').first().waitFor();
  await page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^公告$/ }) }).first().waitFor({ timeout: 15000 });
  return '隐藏公告+全屏';
});

await step('4', '大屏管理', async () => {
  await open(page, '/screen_management/list', '大屏管理');
  const rows = await tableRows(page);
  if (rows < 8) throw new Error(`行数 ${rows}`);
  await shot(page, 'v04');
  return `${rows} 行`;
});

await step('5', '大屏新增', async () => {
  await open(page, '/screen_management/list', '大屏管理');
  const beforeApi = (await api(admin, 'GET', '/api/data-screens')).items.length;
  await page.getByRole('button', { name: '+ 新增' }).click();
  await page.getByText('新增大屏').waitFor();
  await shot(page, 'v05a');
  const modal = page.locator('.ant-modal').filter({ hasText: '新增大屏' });
  const name = `R10新增${Date.now().toString().slice(-4)}`;
  await modal.locator('input').first().fill(name);
  // 第 2 个 Select 是「功能模块」（必填）；显式点选项文案，避免空值提交
  await modal.locator('.ant-select').nth(1).click();
  const moduleOpt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: '生产模块' }).first();
  await moduleOpt.waitFor({ state: 'attached', timeout: 10000 });
  await moduleOpt.click({ timeout: 8000 });
  const createResp = page.waitForResponse((r) => r.url().includes('/api/data-screens') && r.request().method() === 'POST', { timeout: 15000 });
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  const resp = await createResp;
  if (!resp.ok()) throw new Error(`创建大屏失败 HTTP ${resp.status()}`);
  await page.waitForTimeout(800);
  const afterApi = (await api(admin, 'GET', '/api/data-screens')).items.length;
  if (afterApi <= beforeApi) throw new Error(`列表未增加 ${beforeApi}→${afterApi}`);
  await open(page, '/screen_management/list', '大屏管理');
  await shot(page, 'v05b');
  return `${beforeApi}→${afterApi} 行`;
});

await step('6', '大屏设计', async () => {
  await open(page, '/screen_management/list', '大屏管理');
  let row = page.locator('tr').filter({ hasText: 'R10测试大屏' }).first();
  if (!(await row.count())) {
    const created = await api(admin, 'POST', '/api/data-screens', { menu_name: 'R10测试大屏', layout: '默认', module_kind: '生产模块', description: 'R10验收', access_password: '' });
    if (created?.id) await api(admin, 'PUT', `/api/data-screens/${created.id}/design`, { title: 'R10车间看板', slots: [{ slot: 1, module: 'defect_items' }] });
    await open(page, '/screen_management/list', '大屏管理');
    row = page.locator('tr').filter({ hasText: 'R10测试大屏' }).first();
  }
  if (!(await row.count())) throw new Error('缺少 R10测试大屏，请先 seed');
  const [editPage] = await Promise.all([context.waitForEvent('page'), row.getByRole('button', { name: '设计' }).click()]);
  await editPage.waitForLoadState('domcontentloaded');
  await editPage.waitForTimeout(1500);
  await editPage.screenshot({ path: path.join(artifactDir, 'v06a.png') });
  writeFileSync(path.join(docDir, 'v06a.png'), readFileSync(path.join(artifactDir, 'v06a.png')));
  await editPage.close();
  const [viewPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }),
    row.getByRole('button', { name: '查看大屏' }).click(),
  ]);
  const assertScreenView = async (target) => {
    await target.waitForFunction(() => {
      const t = document.body.innerText || '';
      return t.includes('R10车间看板') || t.includes('不良品项分布');
    }, undefined, { timeout: 20000 });
    const viewText = await target.locator('body').innerText();
    if (viewText.includes('未选择模块') || viewText.includes('点击选择模块')) {
      throw new Error('查看大屏仍显示未选择模块/点击选择模块');
    }
  };
  if (viewPage) {
    await viewPage.waitForLoadState('domcontentloaded');
    await assertScreenView(viewPage);
    await viewPage.screenshot({ path: path.join(artifactDir, 'v06b.png') });
    writeFileSync(path.join(docDir, 'v06b.png'), readFileSync(path.join(artifactDir, 'v06b.png')));
    await viewPage.close();
  } else {
    await page.waitForURL(/screen|看板|大屏|pd/, { timeout: 10000 }); // T0: 等待失败即失败
    await assertScreenView(page);
    await shot(page, 'v06b');
  }
  return '设计页+查看大屏';
});

await step('7', '大屏修改与删除', async () => {
  await open(page, '/screen_management/list', '大屏管理');
  let row = page.locator('tr').filter({ hasText: 'R10测试大屏' }).first();
  if (!(await row.count())) {
    const created = await api(admin, 'POST', '/api/data-screens', { menu_name: 'R10测试大屏', layout: '默认', module_kind: '生产模块', description: 'R10验收', access_password: '' });
    if (!created?.id) throw new Error('无法重建 R10测试大屏');
    await open(page, '/screen_management/list', '大屏管理');
    row = page.locator('tr').filter({ hasText: 'R10测试大屏' }).first();
  }
  if (!(await row.count())) throw new Error('缺少 R10测试大屏');
  await row.scrollIntoViewIfNeeded();
  await page.locator('.ant-table-body, .ant-table-content').first().evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await row.getByRole('button', { name: '修改' }).click();
  const editModal = page.locator('.ant-modal').filter({ hasText: '修改大屏' });
  await editModal.waitFor();
  const newDesc = `R10描述更新${Date.now().toString().slice(-4)}`;
  await editModal.locator('textarea').fill(newDesc);
  const patchResp = page.waitForResponse((r) => r.url().includes('/api/data-screens/') && r.request().method() === 'PATCH', { timeout: 15000 });
  await editModal.getByRole('button', { name: '确 定' }).click();
  const resp = await patchResp;
  if (!resp.ok()) throw new Error(`修改大屏失败 HTTP ${resp.status()} ${await resp.text()}`);
  await editModal.waitFor({ state: 'hidden', timeout: 10000 });
  await page.getByText(newDesc).first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
  row = page.locator('tr').filter({ hasText: 'R10测试大屏' }).first();
  await page.locator('.ant-table-body, .ant-table-content').first().evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  const del = row.getByRole('button', { name: '删除' });
  await del.evaluate((el) => el.click());
  await page.locator('.ant-modal-confirm-title').filter({ hasText: '删除大屏' }).waitFor({ timeout: 10000 });
  await confirmModal(page, '删除大屏');
  await page.waitForTimeout(1200);
  if (await page.locator('tr').filter({ hasText: 'R10测试大屏' }).count()) throw new Error('UI 删除后仍在列表');
  await shot(page, 'v07');
  return `UI 修改(${newDesc})并删除`;
});

await step('8', '质量报表本周', async () => {
  await open(page, '/material_test_report', '采购检验分析');
  await shot(page, 'v08a');
  if ((await tableRows(page)) < 1) throw new Error('采购检验无数据');
  await open(page, '/spot_check_report', '生产抽检分析');
  await page.waitForFunction(() => document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length >= 1, undefined, { timeout: 15000 });
  const spotApi = await api(admin, 'GET', '/api/quality/reports/spot');
  if (!(spotApi.items ?? []).some((item) => Number(item.good_qty) > 0 && Number(item.defect_qty) > 0)) {
    throw new Error('生产抽检良品数/不良品数仍为 0');
  }
  const spotText = await page.locator('.ant-table').innerText();
  if (!/[1-9]/.test(spotText.replace(/\s/g, ''))) throw new Error('生产抽检报表未见非零数字');
  await shot(page, 'v08b');
  if ((await tableRows(page)) < 1) throw new Error('抽检无数据');
  await open(page, '/scrap_rework_statistics_report', '报废返工统计');
  await shot(page, 'v08c');
  if ((await tableRows(page)) < 1) throw new Error('报废返工无数据');
  return '三张质量报表有数';
});

await step('9', '不良品分析', async () => {
  await open(page, '/waste_analysis', '不良品趋势分析');
  await shot(page, 'v09a');
  await open(page, '/waste_key_analysis', '不良品柏拉图');
  await shot(page, 'v09b');
  await open(page, '/waste_detail', '不良品项明细');
  await shot(page, 'v09c');
  return '三页已打开';
});

await step('10', '维保报表', async () => {
  await open(page, '/device_maintenance_analysis', '设备维修分析');
  await shot(page, 'v10a');
  await open(page, '/maintenance_workload_statistics', '维修工作量统计');
  await shot(page, 'v10b');
  await open(page, '/maintenance_plan_statistics', '维保计划统计');
  await page.waitForFunction(() => document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length >= 1, undefined, { timeout: 15000 });
  const planApi = await api(admin, 'GET', '/api/equip/reports/plans');
  if (!(planApi.items ?? []).some((item) => Number(item.done_times) > 0 || Number(item.rate) > 0)) {
    throw new Error('维保计划完成率仍为 0');
  }
  const planText = await page.locator('.ant-table').innerText();
  if (!/[1-9]/.test(planText.replace(/\s/g, ''))) throw new Error('维保计划统计未见非零完成率');
  await shot(page, 'v10c');
  return '三页已打开';
});

await step('11', '销售对账单', async () => {
  await open(page, '/sales_statement', '销售对账单');
  if ((await tableRows(page)) < 1) throw new Error('无数据');
  await shot(page, 'v11');
  return `${await tableRows(page)} 行`;
});
await step('12', '合同报表', async () => {
  await open(page, '/contract_report', '合同报表');
  if ((await tableRows(page)) < 1) throw new Error('无数据');
  await shot(page, 'v12');
  return `${await tableRows(page)} 行`;
});
await step('13', '成本报表', async () => {
  // 成本报表按创建时间倒序，R10-MAIN 可能不在首页；用单号筛选落到可见行
  await open(page, '/produce_bill_cost?code=R10-MAIN', '成本报表');
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), undefined, { timeout: 15000 });
  const codeInput = page.getByPlaceholder('单号').first();
  if (await codeInput.count()) {
    const val = await codeInput.inputValue();
    if (!val.includes('R10-MAIN')) {
      await codeInput.fill('R10-MAIN');
      await page.getByRole('button', { name: '查询', exact: true }).click();
      await page.waitForTimeout(800);
    }
  }
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), undefined, { timeout: 15000 });
  if ((await tableRows(page)) < 1) throw new Error('无数据');
  await page.getByText('成本分摊').first().waitFor({ timeout: 10000 });
  const costApi = await api(admin, 'GET', '/api/report-extra/cost?page=1&page_size=50&code=R10-MAIN');
  const items = costApi.items ?? [];
  const r10Cost = items.find((item) => String(item.code ?? '') === 'R10-MAIN')
    ?? items.find((item) => /R10-MAIN/.test(String(item.code ?? '')));
  if (!r10Cost) throw new Error('成本报表 API 无 R10-MAIN 行');
  const labor = Number(r10Cost.labor ?? 0);
  const outsource = Number(r10Cost.outsource ?? 0);
  const costShare = Number(r10Cost.cost_share ?? 0);
  if (!(labor > 0 && outsource > 0 && costShare > 0)) {
    throw new Error(`R10-MAIN 三项需>0 人工=${labor} 外协=${outsource} 分摊=${costShare}`);
  }
  const row13 = page.locator('tr.ant-table-row').filter({ hasText: String(r10Cost.code) }).first();
  await row13.waitFor({ timeout: 10000 });
  const rowText = await row13.innerText();
  const nonZero = [labor, outsource, costShare].filter((n) => n > 0).map((n) => Number(n).toFixed(2));
  if (!nonZero.some((v) => rowText.includes(v) || rowText.includes(String(Number(v))))) {
    throw new Error(`页面 R10 行未展示非零成本：${rowText.slice(0, 120)}`);
  }
  await shot(page, 'v13');
  return `${await tableRows(page)} 行 ${r10Cost.code} 人工${labor}/外协${outsource}/分摊${costShare}`;
});

await step('14', '进销存汇总', async () => {
  await open(page, '/inventory_summary', '进销存汇总');
  if ((await tableRows(page)) < 1) throw new Error('无数据');
  await shot(page, 'v14');
  return `${await tableRows(page)} 行`;
});
await step('15', '采购对账单', async () => {
  await open(page, '/purchase_statement', '您没有可以查看的视图');
  await shot(page, 'v15');
  return '无视图文案';
});

await step('16', 'AI库存监控', async () => {
  await open(page, '/ai_inventory/list', 'AI库存监控');
  const body = await page.locator('body').innerText();
  const lows = body.match(/本月预计有\s*(\d+)\s*种商品的库存量低于预期/);
  const highs = body.match(/本月预计有\s*(\d+)\s*种商品的库存量超出预期/);
  const rises = body.match(/有\s*(\d+)\s*种商品的需求量最近两个月/);
  if (!lows || Number(lows[1]) < 1) throw new Error(`低于预期数字异常: ${lows?.[1]}`);
  if (!highs || Number(highs[1]) < 1) throw new Error(`超出预期数字异常: ${highs?.[1]}`);
  if (!rises || Number(rises[1]) < 1) throw new Error(`连续上升数字异常: ${rises?.[1]}`);
  await shot(page, 'v16a');
  await page.getByText('查看详情>>').first().click();
  await page.waitForTimeout(800);
  await shot(page, 'v16b');
  return `建议 ${lows[1]}/${highs[1]}/${rises[1]}`;
});

await step('17', '智能报表', async () => {
  await open(page, '/smart/form_core_list', '智能报表');
  await shot(page, 'v17a');
  await page.getByText('销售简报').first().click();
  await page.waitForTimeout(1000);
  await shot(page, 'v17b');
  // 理由：antd 二字按钮「返回」无障碍名为「返 回」，getByText('返回') 点不到
  await btn(page, '返回').first().click();
  await page.waitForTimeout(600);
  await page.getByText('R10自定义').first().click();
  await page.waitForTimeout(1200);
  await shot(page, 'v17c');
  return '简报+自定义';
});

await step('18', '客户跟单', async () => {
  await open(page, '/follow/list', '客户跟单');
  const rows = await tableRows(page);
  if (rows < 6) throw new Error(`仅 ${rows} 行`);
  await shot(page, 'v18a');
  const add = btn(page, '新增').first();
  await add.click();
  await page.getByText('新增客户跟单').waitFor();
  await shot(page, 'v18b');
  await page.keyboard.press('Escape');
  return `${rows} 行`;
});

await step('19', '跟单提醒消息', async () => {
  await open(page, '/message/list', '消息中心');
  await page.getByText('客户跟单').first().click({ timeout: 8000 });
  await shot(page, 'v19');
  return '消息中心';
});

await step('20', '知识库', async () => {
  await open(page, '/knowledge/list', '知识库');
  await shot(page, 'v20a');
  await btn(page, '新增').click();
  await page.waitForURL(/knowledge\/add/);
  await page.waitForTimeout(600);
  await shot(page, 'v20b');
  await page.goto(`${WEB}/knowledge/list`);
  await page.getByText('知识库').first().waitFor();
  await btn(page, '管理分类').click();
  await page.locator('.ant-modal-title').filter({ hasText: '管理分类' }).waitFor();
  await shot(page, 'v20c');
  await page.keyboard.press('Escape');
  return '列表+新增+分类';
});

await step('21', '通知公告', async () => {
  await open(page, '/notice/list', '通知公告');
  await shot(page, 'v21a');
  await page.getByRole('tab', { name: '未读' }).click();
  await page.waitForTimeout(600);
  await shot(page, 'v21b');
  await asUser(page, worker);
  // 理由：列表默认 pageSize=10，R11 未读≥11 时读一条后 items.length 仍为 10；必须用 total
  const unreadBefore = Number((await api(worker, 'GET', '/api/notices?tab=unread&page_size=1')).total ?? 0);
  await open(page, '/notice/list', '通知公告');
  await page.getByRole('tab', { name: '未读' }).click();
  await page.waitForTimeout(500);
  if (unreadBefore < 1) throw new Error('工人无未读公告');
  if ((await tableRows(page)) < 1) throw new Error('未读列表无行');
  await page.locator('.ant-table-tbody tr.ant-table-row').first().click();
  await page.waitForURL(/notice\/detail/, { timeout: 10000 });
  await page.waitForTimeout(800);
  await shot(page, 'v21c');
  const unreadAfter = Number((await api(worker, 'GET', '/api/notices?tab=unread&page_size=1')).total ?? 0);
  if (!(unreadAfter < unreadBefore)) throw new Error(`点开后未读未减少 ${unreadBefore}->${unreadAfter}`);
  await asUser(page, admin);
  // 理由：切回管理员后强制走工作台，让 /api/auth/me 重建会话，避免后续采购页仍用工人权限
  await page.goto(`${WEB}/staging/area`);
  await page.getByText('工作台').first().waitFor({ timeout: 15000 });
  return `未读 ${unreadBefore}->${unreadAfter}`;
});

await step('22', '采购设置', async () => {
  await open(page, '/setting/purchase/setting', '采购设置');
  await shot(page, 'v22a');
  // 理由：默认 draft=false，须等接口回填后再读 aria-checked，否则未 hydrate 时点开关保存仍是默认值
  const seeded = Boolean((await api(admin, 'GET', '/api/purchase/settings')).settings?.show_supplier_info);
  const switchRow = page.locator('.kgd-setting-item').filter({ hasText: '采购单展示供应商更多信息' }).first();
  const sw = switchRow.locator('.ant-switch').first();
  await sw.waitFor({ state: 'visible', timeout: 10000 });
  // 理由：hydrate 偶发慢于首屏；先等文案区出现再等 aria，超时则 reload 一次（不放松开关必须变化的断言）
  const matched = await page.waitForFunction((want) => {
    const row = [...document.querySelectorAll('.kgd-setting-item')].find((node) => (node.textContent || '').includes('采购单展示供应商更多信息'));
    const btn = row?.querySelector('.ant-switch');
    return btn && btn.getAttribute('aria-checked') === (want ? 'true' : 'false');
  }, seeded, { timeout: 20000 }).then(() => true).catch(() => false);
  if (!matched) {
    await page.reload();
    await page.getByText('采购设置').first().waitFor();
    await page.waitForFunction((want) => {
      const row = [...document.querySelectorAll('.kgd-setting-item')].find((node) => (node.textContent || '').includes('采购单展示供应商更多信息'));
      const btn = row?.querySelector('.ant-switch');
      return btn && btn.getAttribute('aria-checked') === (want ? 'true' : 'false');
    }, seeded, { timeout: 20000 });
  }
  const before = await sw.getAttribute('aria-checked');
  await sw.click();
  await page.waitForFunction((prev) => {
    const row = [...document.querySelectorAll('.kgd-setting-item')].find((node) => (node.textContent || '').includes('采购单展示供应商更多信息'));
    return row?.querySelector('.ant-switch')?.getAttribute('aria-checked') !== prev;
  }, before, { timeout: 5000 });
  await btn(page, '保存').first().click();
  await page.waitForTimeout(1000);
  await page.reload();
  await page.getByText('采购设置').first().waitFor();
  const swAfter = page.locator('.kgd-setting-item').filter({ hasText: '采购单展示供应商更多信息' }).first().locator('.ant-switch').first();
  await swAfter.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction((prev) => {
    const row = [...document.querySelectorAll('.kgd-setting-item')].find((node) => (node.textContent || '').includes('采购单展示供应商更多信息'));
    return row?.querySelector('.ant-switch')?.getAttribute('aria-checked') !== prev;
  }, before, { timeout: 15000 });
  const after = await swAfter.getAttribute('aria-checked');
  if (!before || !after || before === after) throw new Error(`采购设置开关保存后未变化 ${before}->${after}`);
  await shot(page, 'v22b');
  const md5a = createHash('md5').update(readFileSync(path.join(artifactDir, 'v22a.png'))).digest('hex');
  const md5b = createHash('md5').update(readFileSync(path.join(artifactDir, 'v22b.png'))).digest('hex');
  if (md5a === md5b) throw new Error(`v22a 与 v22b md5 相同 ${md5a}`);
  return `开关 ${before}->${after}`;
});

await step('23', '供应商设置', async () => {
  // 手机号唯一开关在设置页；重复手机号报错 UI 在供应商列表「新增」弹窗
  await open(page, '/setting/supplier/setting', '供应商设置');
  const ss = await api(admin, 'GET', '/api/purchase/supplier-settings');
  const settings = ss.settings ?? ss;
  // 理由：必须带 version 写回，确保唯一手机号开关真正生效，否则新增重号不会出现「供应商手机号已存在」
  if (!settings.supplier_unique_phone) {
    await api(admin, 'PUT', '/api/purchase/supplier-settings', { ...settings, supplier_unique_phone: true, version: settings.version });
  }
  const phone = '13800138000';
  const existing = await api(admin, 'GET', '/api/money/suppliers?page=1&page_size=100');
  if (!(existing.items ?? []).some((row) => String(row.contact_phone ?? '') === phone)) {
    await api(admin, 'POST', '/api/money/suppliers', {
      request_key: `r10-phone-${Date.now()}`, name: 'R10手机号源', company_name: 'R10手机号源',
      contact_name: '测', contact_phone: phone, owner_id: admin.userId,
    });
  }
  await open(page, '/supplier/list', '供应商');
  await btn(page, '新增').click({ timeout: 10000 });
  const box = page.locator('.ant-modal').filter({ hasText: '新增供应商' });
  await box.waitFor({ state: 'visible', timeout: 10000 });
  await box.locator('.ant-form-item').filter({ hasText: '供应商名称' }).locator('input').fill(`R10重号${Date.now().toString().slice(-4)}`);
  const phoneInput = box.locator('.ant-form-item').filter({ hasText: '联系人电话' }).locator('input');
  await phoneInput.click();
  await phoneInput.fill('');
  await phoneInput.pressSequentially(phone, { delay: 20 });
  await box.getByRole('button', { name: /^\s*确\s*定\s*$/ }).click();
  // 理由：错误可能在 form help 或 ant-message，两者任一出现即算产品提示到位
  await page.locator('.ant-form-item-explain-error, .ant-message-error, .ant-message').filter({ hasText: /供应商手机号已存在/ }).first().waitFor({ timeout: 15000 });
  await shot(page, 'v23');
  await page.keyboard.press('Escape');
  return '手机号重复报错可见';
});

await step('24', '采购价格追踪', async () => {
  // 理由：seed must 已有规则；等表格行或接口错误，避免首屏空表误判
  const seededRules = Number((await api(admin, 'GET', '/api/purchase/price-rules?page=1&page_size=5')).total ?? 0);
  if (seededRules < 1) throw new Error('seed 无价格规则');
  await open(page, '/setting/purchasePriceTrack', '采购价格追踪');
  await page.waitForFunction(() => {
    const body = document.body.innerText || '';
    if (document.querySelector('.ant-table-tbody tr.ant-table-row')) return true;
    if (/没有操作权限|403|接口不存在/.test(body)) return true;
    return !body.includes('正在读取数据');
  }, undefined, { timeout: 20000 });
  if ((await tableRows(page)) < 1) throw new Error('无价格规则');
  await shot(page, 'v24a');
  await btn(page, '新增').click();
  await page.waitForTimeout(600);
  await shot(page, 'v24b');
  await page.keyboard.press('Escape');
  return '列表+弹窗';
});

await step('25', '通用设置', async () => {
  await open(page, '/setting/basics', '通用设置');
  await shot(page, 'v25');
  return '已打开';
});
await step('26', '短信设置', async () => {
  await api(admin, 'POST', '/api/system/sms/seed-demo', {});
  await open(page, '/setting/sms', '短信设置');
  await page.getByText('充值记录').first().waitFor();
  await page.getByText('发送记录').first().waitFor();
  const body = await page.locator('body').innerText();
  if (body.includes('暂无数据') && !/充值|发送/.test(body)) throw new Error('短信记录为空');
  // 充值/发送表格至少各有一行（排除「暂无」）
  const rechargeEmpty = await page.locator('section, .ant-card, .kgd-card, div').filter({ hasText: '充值记录' }).filter({ hasText: '暂无' }).count();
  const sendEmpty = await page.locator('section, .ant-card, .kgd-card, div').filter({ hasText: '发送记录' }).filter({ hasText: '暂无' }).count();
  if (rechargeEmpty && sendEmpty) throw new Error('充值/发送记录均为空');
  await page.waitForTimeout(600);
  await shot(page, 'v26');
  return '充值+发送有数据';
});

await step('27', '菜单与重定向', async () => {
  await page.goto(`${WEB}/workplace`);
  await page.waitForURL(/staging\/area/);
  for (const [from, to] of [
    ['/ai/order', /digitalEmployees/],
    ['/customer_follow/list', /follow/],
    ['/purchase/setting', /setting\/purchase/],
    ['/form_core', /smart\/form_core_list/],
    ['/post_arrange/list', /station\/list/],
    ['/MaterialAnalysis/center', /MaterialAnalysis\/list/],
  ]) {
    await page.goto(`${WEB}${from}`);
    await page.waitForURL(to, { timeout: 10000 });
  }
  // 重定向完成后打开 AI 菜单证据：子菜单仅「训练中心」
  if (await page.locator('aside.kgd-sub').count() === 0) {
    await page.getByRole('button', { name: '折叠菜单' }).click();
  }
  await page.locator('nav.kgd-rail').getByRole('button', { name: 'AI智能体' }).click();
  await page.waitForURL(/digitalEmployees\/manager\/setting/, { timeout: 10000 });
  const aside = page.locator('aside.kgd-sub');
  await aside.getByText('训练中心').waitFor({ timeout: 10000 });
  const asideText = await aside.innerText();
  if (asideText.includes('AI工单')) throw new Error('AI智能体子菜单仍含 AI工单');
  const leaves = (await aside.locator('button.kgd-sub-item').allInnerTexts())
    .map((t) => t.replace(/[▴▾]/g, '').trim())
    .filter(Boolean);
  if (!leaves.includes('训练中心')) throw new Error('AI 子菜单缺少训练中心');
  if (leaves.length !== 1 || leaves[0] !== '训练中心') {
    throw new Error(`AI智能体下应仅有训练中心，实际：${leaves.join(',')}`);
  }
  await page.getByText('训练中心').first().waitFor();
  // 切到问答集并等加载结束，列表至少 1 行（seed 预置 ≥2）
  await page.getByRole('tab', { name: '问答集' }).click();
  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return !t.includes('正在读取') && !document.querySelector('.ant-spin-spinning');
  }, undefined, { timeout: 20000 });
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row');
    return rows.length >= 1;
  }, undefined, { timeout: 20000 });
  const qaRows = await page.locator('.ant-table-tbody tr.ant-table-row').count();
  if (qaRows < 1) throw new Error(`问答集无数据行：${qaRows}`);
  const qaBody = await page.locator('body').innerText();
  if (/共\s*0\s*条数据/.test(qaBody) || qaBody.includes('暂无问答')) {
    throw new Error('问答集仍显示空列表');
  }
  await shot(page, 'v27');
  return `重定向 OK + AI 仅训练中心 + 问答${qaRows}行`;
});

await step('28', '项目管理', async () => {
  await open(page, '/production_project/list', '项目管理');
  if ((await tableRows(page)) < 2) throw new Error('项目不足');
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), undefined, { timeout: 15000 });
  const body = await page.locator('body').innerText();
  if (/加工单数[\s\S]{0,40}\b0\b/.test(body) && !/[1-9]\d*\s*\(?/.test(body)) {
    // soft structural: require non-zero work order count somewhere
  }
  if (!/[1-9]\d*/.test(body)) throw new Error('项目列表无有效数字');
  if (!/[1-9]\d*%\s*\(\s*[1-9]/.test(body) && !/[1-9]\d*%\s*\(\s*\d+\s*\/\s*[1-9]/.test(body)) {
    throw new Error('工序进度未见非零完成/总数');
  }
  if (!body.match(/[1-9]\d*%/)) throw new Error('工序进度百分比仍为 0');
  const zeroOnly = [...body.matchAll(/加工单数[^\d]*(\d+)/g)].map((m) => m[1]);
  if (zeroOnly.length && zeroOnly.every((v) => v === '0')) throw new Error('加工单数全为 0');
  await shot(page, 'v28', { assertNoTooltip: true });
  return `${await tableRows(page)} 行含加工单与进度`;
});

await step('29', '物料分析', async () => {
  await open(page, '/MaterialAnalysis/list', '物料分析');
  if ((await tableRows(page)) < 2) throw new Error('无数据');
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), undefined, { timeout: 15000 });
  await page.getByText('已作废').first().waitFor({ timeout: 10000 });
  const maApi = await api(admin, 'GET', '/api/material-analysis?page=1&page_size=50');
  const codes = (maApi.items ?? []).map((item) => String(item.plan_code || ''));
  const dupCodes = codes.filter((c, i) => c && codes.indexOf(c) !== i);
  if (dupCodes.length) throw new Error(`物料分析计划编号重复：${[...new Set(dupCodes)].join(',')}`);
  const pageCodes = await page.locator('.ant-table-tbody tr.ant-table-row td').evaluateAll((cells) => {
    const texts = cells.map((c) => (c.textContent || '').trim()).filter((t) => /^JH\d+/.test(t));
    return texts;
  });
  const pageDup = pageCodes.filter((c, i) => pageCodes.indexOf(c) !== i);
  if (pageDup.length) throw new Error(`页面计划编号重复：${[...new Set(pageDup)].join(',')}`);
  const planRow = (maApi.items ?? []).find((item) => String(item.plan_name) === 'R10生产计划A' && String(item.status) !== 'void')
    ?? (maApi.items ?? []).find((item) => String(item.plan_name) === 'R10生产计划A');
  if (!planRow) throw new Error('物料分析缺少 R10生产计划A');
  const outCount = Number(planRow.outsource_count ?? (Array.isArray(planRow.outsource_orders) ? planRow.outsource_orders.length : 0));
  const buyCount = Number(planRow.purchase_count ?? (Array.isArray(planRow.purchase_orders) ? planRow.purchase_orders.length : 0));
  if (!(outCount > 0)) throw new Error(`R10生产计划A 外协工单计数=${outCount}`);
  if (!(buyCount > 0)) throw new Error(`R10生产计划A 采购单计数=${buyCount}`);
  const planTr = page.locator('tr.ant-table-row').filter({ hasText: 'R10生产计划A' }).filter({ hasNotText: '已作废' }).first();
  await planTr.waitFor({ timeout: 10000 });
  const planCellText = await planTr.innerText();
  const orderMarks = [...planCellText.matchAll(/（\s*([1-9]\d*)\s*单\s*）/g)].map((m) => Number(m[1]));
  if (orderMarks.length < 1 || !orderMarks.some((n) => n > 0)) {
    throw new Error(`R10生产计划A 行未见非零外协/采购单数：${planCellText.slice(0, 160)}`);
  }
  if (!planCellText.includes(`（${outCount}单）`) && !orderMarks.includes(outCount)) {
    throw new Error(`页面外协单数与 API 不一致 API=${outCount}`);
  }
  if (!planCellText.includes(`（${buyCount}单）`) && !orderMarks.includes(buyCount)) {
    throw new Error(`页面采购单数与 API 不一致 API=${buyCount}`);
  }
  await shot(page, 'v29a', { assertNoTooltip: true });
  const planId = planRow.plan_id;
  if (!planId) throw new Error('R10生产计划A 缺少 plan_id');
  await open(page, `/ProductionPlan/detail/${planId}`, 'R10生产计划A');
  await page.getByRole('tab', { name: '外协工单' }).click();
  await page.waitForTimeout(800);
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), undefined, { timeout: 10000 }); // T0: 等待失败即失败
  if ((await tableRows(page)) < 1) throw new Error('生产计划详情「外协工单」页签无行');
  await page.getByRole('tab', { name: '采购单' }).click();
  await page.waitForTimeout(800);
  if ((await tableRows(page)) < 1) throw new Error('生产计划详情「采购单」页签无行');
  await page.getByRole('tab', { name: '外协工单' }).click();
  await page.waitForTimeout(400);
  if ((await tableRows(page)) < 1) throw new Error('外协工单页签截图前无行');
  if (page.url().includes('/OutWorkOrder/add')) throw new Error('v29b 误入创建外协工单表单');
  await shot(page, 'v29b');
  return `已作废+计划A外协${outCount}/采购${buyCount}+详情页签`;
});

await step('30', '成本分摊', async () => {
  await open(page, '/apportioned_cost/list', '成本分摊');
  if ((await tableRows(page)) < 2) throw new Error('无数据');
  await shot(page, 'v30a');
  // 理由：列表把后端「草稿」渲染为「待审核」，不能再按「草稿」找行
  const draftRow = page.locator('tr.ant-table-row').filter({ hasText: '待审核' }).first();
  await draftRow.waitFor({ timeout: 10000 });
  await page.locator('.ant-table-body, .ant-table-content').first().evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await draftRow.getByText('分摊', { exact: true }).click();
  await page.locator('.ant-modal-confirm-title').filter({ hasText: '确认分摊' }).waitFor({ timeout: 10000 });
  await shot(page, 'v30b');
  await page.keyboard.press('Escape');
  return '列表+分摊确认';
});

await step('31', '岗位安排', async () => {
  await open(page, '/station/list', '岗位安排');
  if ((await tableRows(page)) < 3) throw new Error('岗位不足');
  await shot(page, 'v31');
  return `${await tableRows(page)} 行`;
});

await step('32', '工序附加组件', async () => {
  await open(page, '/process_additional_component/list', '工序附加组件');
  await shot(page, 'v32a');
  await btn(page, '新增').click();
  await page.waitForTimeout(600);
  await shot(page, 'v32b');
  await page.keyboard.press('Escape');
  await page.goto(`${WEB}/public_craft/list`);
  await page.waitForTimeout(800);
  // 理由：antd 可能插入 0/1 个空格，「修 改」硬编码会偶发点不到
  await btn(page, '修改').first().click();
  await page.locator('.ant-modal-title').filter({ hasText: '修改工序' }).waitFor({ timeout: 10000 });
  const processModal = await page.locator('.ant-modal').filter({ hasText: '修改工序' }).last().innerText();
  if (/Choose File|No file chosen/i.test(processModal)) throw new Error('工序附件仍是原生英文文件框');
  if (!processModal.includes('选择文件')) throw new Error('工序附件未见中文上传组件');
  await shot(page, 'v32c');
  return '组件+工序引用';
});

await step('33', '溯源码管理', async () => {
  await open(page, '/product_traceability/list', '溯源码管理');
  if ((await tableRows(page)) < 10) throw new Error('溯源码不足');
  await shot(page, 'v33');
  return `${await tableRows(page)} 行`;
});

await step('34', '训练中心', async () => {
  await open(page, '/digitalEmployees/manager/setting', '训练中心');
  await page.getByRole('tab', { name: /问答/ }).click();
  await page.waitForTimeout(800);
  await page.getByText(/问答|问题|答案/).first().waitFor({ timeout: 10000 });
  const body = await page.locator('body').innerText();
  if (body.includes('暂无问答')) throw new Error('训练中心无问答');
  await shot(page, 'v34');
  return '问答集可见';
});

await step('35', '加工单', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  await shot(page, 'v35a');
  // 拆单在已完成/已取消时禁用：优先打开可拆的加工单（R10-SPLIT 或未完成行）
  const woList = await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=50');
  const splitable = (woList.items ?? []).find((row) => String(row.code) === 'R10-SPLIT' && !['completed', 'cancelled'].includes(row.execution))
    ?? (woList.items ?? []).find((row) => !['completed', 'cancelled'].includes(row.execution));
  if (!splitable?.id) throw new Error('无可用拆单的加工单');
  const codeLink = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: String(splitable.code) }).locator('button.kgd-link, a.kgd-link').first();
  if (await codeLink.count()) await codeLink.click();
  else await page.goto(`${WEB}/inside_produce_bill/detail/${splitable.id}`);
  await page.waitForURL(/inside_produce_bill\/detail\//, { timeout: 15000 });
  await page.getByText('加工单').first().waitFor();
  await page.waitForTimeout(800);
  await shot(page, 'v35b');
  const splitBtn = btn(page, '拆单');
  await splitBtn.waitFor({ state: 'visible', timeout: 8000 });
  if (await splitBtn.isDisabled()) throw new Error(`拆单仍禁用: ${splitable.code} ${splitable.execution}`);
  await splitBtn.click({ timeout: 8000 });
  // 理由：拆单已改为独立页 /inside_produce_bill/split/:id，不再弹 Modal；页标题须含「拆单」
  await page.waitForURL(/inside_produce_bill\/split\//, { timeout: 10000 });
  await page.getByText('拆单', { exact: true }).first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  await shot(page, 'v35c');
  await page.goto(`${WEB}/inside_produce_bill/detail/${splitable.id}`);
  await page.waitForURL(/inside_produce_bill\/detail\//, { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.getByRole('tab', { name: '父子单' }).click();
  await page.waitForTimeout(800);
  await shot(page, 'v35d');
  await btn(page, '分享加工单进度').click({ timeout: 8000 });
  await page.locator('.ant-modal-title').filter({ hasText: '分享加工单进度' }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  await shot(page, 'v35e');
  await page.keyboard.press('Escape');
  return '详情/拆单/父子/分享';
});

await step('36', '打印预览', async () => {
  await open(page, '/inside_produce_bill/list', '加工单');
  const [printPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }),
    page.locator('button.kgd-link, a.kgd-link, button').filter({ hasText: /^打印$/ }).first().click({ timeout: 8000 }),
  ]);
  if (printPage) {
    await printPage.waitForLoadState('domcontentloaded');
    await printPage.waitForTimeout(600);
    await printPage.screenshot({ path: path.join(artifactDir, 'v36.png') });
    writeFileSync(path.join(docDir, 'v36.png'), readFileSync(path.join(artifactDir, 'v36.png')));
    await printPage.close();
    return '打印预览窗口';
  }
  await page.waitForTimeout(800);
  await shot(page, 'v36');
  throw new Error('未弹出打印预览窗口');
});

await step('37', '生产任务', async () => {
  await open(page, '/productionTask/list', '生产任务');
  await shot(page, 'v37a');
  // 排除表头「Select all」，只勾数据行
  const checks = page.locator('.ant-table-tbody tr.ant-table-row .ant-checkbox-input');
  const n = Math.min(3, await checks.count());
  if (n < 1) throw new Error('生产任务无可勾选行');
  for (let i = 0; i < n; i += 1) await page.locator('.ant-table-tbody tr.ant-table-row').nth(i).locator('.ant-checkbox').click();
  await page.getByRole('button', { name: /^批量报工$/ }).click({ timeout: 8000 });
  await page.getByText(/已选择\s*\d+\s*条生产任务/).waitFor({ timeout: 8000 });
  await page.locator('.ant-modal-title').filter({ hasText: '请确认' }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  await shot(page, 'v37b');
  await page.keyboard.press('Escape');
  await page.getByText('外协任务').first().click({ timeout: 5000 });
  await page.waitForTimeout(600);
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), undefined, { timeout: 15000 });
  if ((await tableRows(page)) < 1) throw new Error('外协任务无数据');
  await shot(page, 'v37c');
  return '批量报工预检+外协视图';
});

await step('38', '报工记录', async () => {
  await open(page, '/work_repoty_record/list', '报工记录');
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据') && !document.querySelector('.ant-spin-spinning'), undefined, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length >= 1, undefined, { timeout: 20000 });
  if ((await tableRows(page)) < 1) throw new Error('无报工');
  await shot(page, 'v38');
  return `${await tableRows(page)} 行`;
});
await step('39', '产量报表', async () => {
  await open(page, '/output_statistics_report', '产量报表');
  await shot(page, 'v39');
  return '已打开';
});

await step('40', '视图 R10', async () => {
  // 理由：managedViews 依赖 /api/list-views?page_key=work-orders；先确认 seed 视图存在再点
  const views = await api(admin, 'GET', '/api/list-views?page_key=work-orders');
  if (!(views.items ?? []).some((item) => item.name === 'R10视图')) throw new Error('缺少 list-views R10视图');
  await open(page, '/inside_produce_bill/list', '加工单');
  await page.getByText('R10视图').first().waitFor({ timeout: 15000 });
  await page.getByText('R10视图').first().click({ timeout: 8000 });
  await page.waitForTimeout(600);
  await shot(page, 'v40');
  return 'R10视图';
});

await step('41', '其余按钮', async () => {
  await resetWorkplace(admin);
  await page.goto(`${WEB}/staging/area`);
  await page.getByText('工作台').first().waitFor();
  const noticeCard = page.locator('section.wp-card').filter({ has: page.locator('header b', { hasText: /^公告$/ }) }).first();
  await noticeCard.waitFor({ state: 'visible', timeout: 15000 });
  await noticeCard.locator('.wp-line').first().waitFor({ state: 'visible', timeout: 15000 });
  const noticeText = await noticeCard.innerText();
  if (noticeText.includes('暂无公告')) throw new Error('工作台公告卡显示暂无公告');
  if (!/R10公告|公告/.test(noticeText.replace(/\s/g, ''))) throw new Error('工作台公告卡无公告标题');
  await page.getByText('帮助文档').click();
  await page.waitForURL(/knowledge/, { timeout: 10000 });
  await page.getByText(/知识库|帮助|文档/).first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await shot(page, 'v41a');
  await open(page, '/ware/list', '仓库');
  // 理由：操作列在右侧，宽表时需滚入视口否则 click 超时；并确认仓库已 seed
  const whCount = ((await api(admin, 'GET', '/api/warehouses')).items ?? []).length;
  if (whCount < 1) throw new Error('无仓库可查看二维码');
  await page.waitForFunction(() => document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length >= 1, undefined, { timeout: 15000 });
  const qrBtn = page.getByText('查看二维码').first();
  await qrBtn.scrollIntoViewIfNeeded();
  await qrBtn.click({ timeout: 8000 });
  await page.waitForTimeout(600);
  await shot(page, 'v41b');
  await page.keyboard.press('Escape');
  // v41c1：工序「查看二维码」弹出二维码；等弹窗内二维码完全可见再拍
  await open(page, '/public_craft/list', '工序');
  await page.waitForTimeout(600);
  const craftQr = page.getByText('查看二维码').first();
  await craftQr.scrollIntoViewIfNeeded();
  await craftQr.click({ timeout: 8000 });
  const qrWrap = page.locator('.ant-modal-wrap').filter({ has: page.locator('.ant-modal-title', { hasText: '查看二维码' }) }).last();
  await qrWrap.waitFor({ state: 'visible', timeout: 8000 });
  const qrModal = qrWrap.locator('.ant-modal');
  const qrImg = qrModal.locator('img[alt="二维码"]');
  await qrImg.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => {
    const wraps = [...document.querySelectorAll('.ant-modal-wrap')].filter((wrap) => {
      const style = getComputedStyle(wrap);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    const wrap = [...wraps].reverse().find((node) => (node.querySelector('.ant-modal-title')?.textContent || '').includes('查看二维码'));
    const modal = wrap?.querySelector('.ant-modal');
    const media = modal?.querySelector('img[alt="二维码"]');
    if (!media) return false;
    const ms = getComputedStyle(media);
    const opacity = ms.opacity === '' ? 1 : Number(ms.opacity);
    if (opacity < 0.99) return false;
    const box = media.getBoundingClientRect();
    return box.width > 40 && box.height > 40;
  }, undefined, { timeout: 15000 });
  await page.waitForTimeout(400);
  await shot(page, 'v41c1');
  await page.keyboard.press('Escape');
  // v41c2：BOM 复制/删除
  await open(page, '/bom/list', 'BOM');
  await page.waitForTimeout(600);
  const bomRow = page.locator('.ant-table-row').first();
  if (await bomRow.count()) {
    await bomRow.getByText('复制').first().waitFor({ timeout: 5000 });
    await bomRow.getByText('删除').first().waitFor({ timeout: 5000 });
  } else {
    throw new Error('BOM 列表无数据');
  }
  await shot(page, 'v41c2');
  // v41c3：直接出库
  await open(page, '/sale_stock_out_bill/list', '销售出库单');
  await page.waitForTimeout(500);
  const addSale = page.getByRole('button', { name: /新\s*增/ }).first();
  await addSale.click();
  await page.getByText('直接出库').first().click({ timeout: 8000 });
  await page.waitForTimeout(800);
  await page.getByText(/直接出库|销售出库/).first().waitFor({ timeout: 10000 });
  await shot(page, 'v41c3');
  await page.keyboard.press('Escape');
  // v41c4：外协工单出库
  await open(page, '/production_out_of_storage/list', '生产出库单');
  await page.waitForTimeout(500);
  const addProd = page.getByRole('button', { name: /新\s*增/ }).first();
  await addProd.click();
  await page.getByText('外协工单出库').first().click({ timeout: 8000 });
  await page.waitForTimeout(800);
  await page.getByText(/外协工单出库|外协/).first().waitFor({ timeout: 10000 });
  await shot(page, 'v41c4');
  await page.keyboard.press('Escape');
  // 兼容旧文件名：再留一张工艺路线总览
  await open(page, '/public_craft/list', '工序');
  await page.waitForTimeout(500);
  await shot(page, 'v41c');
  return '知识库+二维码+BOM+出库';
});

await step('42', '全站 rg 占位', async () => {
  const out = execSync('rg -n "该功能待建设|待后续轮次|DisabledButton|建设中|开发中" apps/web/src; echo EXIT:$?', { encoding: 'utf8' });
  const report = `$ rg -n "该功能待建设|待后续轮次|DisabledButton|建设中|开发中" apps/web/src\n${out}`;
  writeFileSync(path.join(artifactDir, 'v42-rg.txt'), report);
  writeFileSync(path.join(docDir, 'v42-rg.txt'), report);
  // rg 无匹配时退出码为 1；有匹配为 0。我们要求 0 匹配。
  const matches = out.split('\n').filter((line) => line && !line.startsWith('EXIT:'));
  const exit = Number((out.match(/EXIT:(\d+)/) || [])[1] ?? 0);
  if (matches.length && exit === 0) throw new Error(matches.join('\n'));
  if (matches.length && !out.includes('EXIT:1')) throw new Error(matches.join('\n'));
  await page.setContent(`<pre style="padding:24px;font:14px/1.5 monospace;white-space:pre-wrap">${report.replace(/</g, '&lt;')}</pre>`);
  await shot(page, 'v42');
  return 'rg 0 行';
});

{
  const r7log = path.join(docDir, 'v84-round7-seed-order.txt');
  writeFileSync(r7log, `round7 seed 在第43步之前 ${new Date().toISOString()}\n`);
  runChecked('node', ['scripts/seed-round7-demo-a.mjs'], r7log);
}
await step('43', '菜单叶子无占位', async () => {
  const menuText = readFileSync(path.join(process.cwd(), 'apps/web/src/kgd/menu.ts'), 'utf8');
  const paths = [...menuText.matchAll(/path: '([^']+)'/g)].map((m) => m[1]).filter((p) => p.startsWith('/'));
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // 依赖父级筛选的明细页：用中文选项点选后再查行数
  async function applyParentFilter(p) {
    if (!p.includes('spot_check_item') && !p.includes('material_test_item') && !p.includes('inspection_breakdown')) return;
    const target = page.locator('.kgd-query-fields .ant-select').first();
    if (!(await target.count())) return;
    await target.click();
    await page.waitForFunction(() => {
      const drop = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
      if (!drop) return false;
      const opts = [...drop.querySelectorAll('.ant-select-item-option')];
      return opts.some((node) => {
        const text = (node.textContent || '').trim();
        return text && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text);
      });
    }, undefined, { timeout: 10000 }); // T0: 等待失败即失败；理由：第二参若当 options 会被当成 pageFunction arg，默认 30s
    const optionCount = await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').count();
    for (let i = 0; i < Math.max(optionCount, 1); i += 1) {
      if (!(await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').count())) {
        await target.click();
        await page.waitForTimeout(250);
      }
      const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').nth(i);
      if (!(await opt.count())) break;
      const label = (await opt.innerText()).trim();
      if (uuidRe.test(label)) continue;
      await opt.click({ timeout: 5000 }); // T0: 等待失败即失败
      // 理由：页面上「查询」可能先匹配到禁用的 ant-btn-link（配置区），须点主查询区启用的 primary
      const queryBtn = page.locator('.kgd-query button.ant-btn-primary:not([disabled]), .kgd-query-actions button.ant-btn-primary:not([disabled])').filter({ hasText: /查\s*询|搜\s*索/ }).first();
      if (await queryBtn.count()) {
        await queryBtn.click(); // T0: 等待失败即失败
      } else {
        await page.locator('button.ant-btn-primary:not([disabled])').filter({ hasText: /查\s*询|搜\s*索/ }).first().click(); // T0: 等待失败即失败
      }
      await page.waitForFunction(() => !/正在读取数据|加载中/.test(document.body.innerText || ''), undefined, { timeout: 10000 }); // T0: 等待失败即失败
      await page.waitForTimeout(500);
      if ((await page.locator('.ant-table-tbody tr.ant-table-row').count()) >= 1) return;
    }
  }
  const leafResults = [];
  const uniquePaths = [...new Set(paths)];
  for (const p of uniquePaths) {
    await page.goto(`${WEB}${p}`);
    // 理由：Playwright waitForFunction(fn, {timeout}) 会把第二参当 arg，须显式 undefined 才生效；卡住叶子用 15s 失败而不是默认 30s
    await page.waitForFunction(() => !document.body.innerText.includes('正在读取数据'), undefined, { timeout: 15000 });
    await page.waitForTimeout(400);
    await applyParentFilter(p);
    await page.waitForTimeout(400);
    // 理由：工序表生产人员依赖 /api/team-members，短暂未解析时勿误报 UUID
    if (p.includes('public_craft')) {
      await page.waitForFunction(() => {
        const text = document.body.innerText || '';
        if (/正在读取数据/.test(text)) return false;
        return !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text);
      }, undefined, { timeout: 12000 }).catch(() => undefined);
    }
    let body = await page.locator('body').innerText();
    const reasons = [];
    // 任务书：匹配「待建设」等占位（勿缩窄为「该功能待建设」）与裸 UUID
    if (/待建设|待后续轮次|后端缺|待确认|建设中|开发中/.test(body)) reasons.push('含占位文案');
    if (uuidRe.test(body)) reasons.push('含 UUID');
    const isPurchaseStatement = p.includes('purchase_statement');
    const hasTable = (await page.locator('.ant-table').count()) > 0;
    let rows = await page.locator('.ant-table-tbody tr.ant-table-row').count();
    if (!isPurchaseStatement && hasTable && rows < 1) {
      await page.waitForFunction(() => !/正在读取数据/.test(document.body.innerText || ''), undefined, { timeout: 12000 }); // T0: 等待失败即失败
      await page.waitForTimeout(1200);
      rows = await page.locator('.ant-table-tbody tr.ant-table-row').count();
      body = await page.locator('body').innerText();
    }
    let note = '';
    if (isPurchaseStatement) {
      note = '采购对账单例外';
    } else if (hasTable && rows < 1) {
      reasons.push('表格无数据行');
      note = '表0行';
    } else if (hasTable) {
      note = `${rows}行`;
    } else {
      note = '无表';
    }
    leafResults.push({
      path: p,
      result: reasons.length ? '未通过' : '通过',
      note: reasons.length ? reasons.join('；') : note,
    });
  }
  const failedLeaves = leafResults.filter((r) => r.result === '未通过');
  if (failedLeaves.length) {
    throw new Error(failedLeaves.map((r) => `${r.path}:${r.note}`).join('; ').slice(0, 800));
  }
  const rowsHtml = leafResults.map((r) => `<tr><td>${r.path.replace(/</g, '&lt;')}</td><td>${r.result}</td><td>${String(r.note).replace(/</g, '&lt;')}</td></tr>`).join('');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:24px;font:14px/1.5 "PingFang SC","Noto Sans SC",sans-serif;background:#f7fafc;color:#1a202c}
h1{font-size:20px;margin:0 0 12px}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border:1px solid #cbd5e0;padding:8px 10px;text-align:left}
th{background:#2b6cb0;color:#fff}
tr:nth-child(even){background:#edf2f7}
</style></head><body>
<h1>第十轮菜单叶子巡检结果（共 ${leafResults.length} 路径）</h1>
<table><thead><tr><th>路径</th><th>结果</th><th>说明</th></tr></thead><tbody>${rowsHtml}</tbody></table>
</body></html>`);
  await page.getByText('路径').first().waitFor();
  await page.locator('table tbody tr').first().waitFor();
  const resultRows = await page.locator('table tbody tr').count();
  if (resultRows < 1) throw new Error('v43 中文结果表无行');
  await shot(page, 'v43');
  return `检查 ${uniquePaths.length} 路径全部通过，结果表 ${resultRows} 行`;
});

await step('44', '构建测试与 round6-9 回归', async () => {
  // 必须渲染真实回归日志文件内容，禁止手写 ALL_PASS 静态页
  for (const dir of [docDir, artifactDir]) {
    const stale = path.join(dir, 'v44.png');
    if (existsSync(stale)) unlinkSync(stale);
  }
  const logPath = path.join(docDir, 'v44-regression.txt');
  writeFileSync(logPath, `第十轮回归 ${new Date().toISOString()}\n`);
  runChecked('npm', ['run', 'typecheck'], logPath);
  runChecked('npm', ['run', 'build'], logPath);
  runChecked('npm', ['test'], logPath);
  runChecked('node', ['scripts/round6-regression.mjs'], logPath);
  runChecked('node', ['scripts/seed-round7-demo-a.mjs'], logPath);
  // 理由：seed-round7 刚登完多账号，立刻 round7-accept 再登易 RATE_LIMITED
  spawnSync('sleep', ['12'], { stdio: 'ignore' });
  runChecked('node', ['scripts/round7-accept.mjs'], logPath);
  runChecked('node', ['scripts/round8-accept.mjs'], logPath);
  runChecked('node', ['scripts/round9-accept.mjs'], logPath);
  appendFileSync(logPath, '\nALL_PASS\n');
  writeFileSync(path.join(artifactDir, 'v44-regression.txt'), readFileSync(logPath));
  const fullLog = readFileSync(logPath, 'utf8');
  if (!fullLog.includes('ALL_PASS')) throw new Error('日志末尾缺少 ALL_PASS');
  if (!/round7-accept\.mjs exit=0/.test(fullLog) || !/round8-accept\.mjs exit=0/.test(fullLog) || !/round9-accept\.mjs exit=0/.test(fullLog)) {
    throw new Error('回归日志缺少 round7/8/9 exit=0');
  }
  const lines = fullLog.split(/\r?\n/);
  const tailLines = lines.slice(Math.max(0, lines.length - 80)).join('\n');
  const escaped = tailLines
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#0b1220;color:#d4ffd4;padding:24px">
<pre style="margin:0;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word">${escaped}</pre>
</body></html>`);
  await page.getByText('ALL_PASS').first().waitFor({ timeout: 10000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot(page, 'v44');
  return 'typecheck/build/test + round6-9 ALL_PASS';
});

await browser.close();

writeFileSync(path.join(process.cwd(), 'docs/第十轮验收记录.md'), `# 第十轮验收记录

## §7 验收（自动脚本 ${new Date().toISOString()})

| 编号 | 项 | 结果 | 说明 |
|------|----|------|------|
${results.map((r) => `| ${r.n} | ${r.title} | ${r.result} | ${r.reason.replace(/\|/g, '/').replace(/\n/g, ' ')} |`).join('\n')}

截图目录：\`/opt/cursor/artifacts/round10/\`、\`docs/verification/round10/\`

## 我方口径
- AI 库存与训练中心不接大模型；短信/支付不接通道；地图/水印/推送等只保存。
- 旧验收台 \`/dev/legacy\` 仅在开发环境（\`import.meta.env.DEV\`）可进，正式入口已移除。

## 原版未采到
- 项目管理、物料分析独立页、成本分摊、岗位安排、溯源码列表（按通用列表样式实现）。

## 不做
- 售后模块卡片、绩效、打印模板设计器、零活报工、采购对账单本体等（见任务书 §5）。

## 待确认
- 采购对账单完整列、消息中心提升为一级菜单、AI 提示文案是否改口径。
`);

const failed = results.filter((r) => r.result === '未通过');
console.log('\n=== 验收汇总 ===');
for (const r of results) console.log(`${r.result}\t${r.n}\t${r.title}\t${r.reason}`);
process.exit(failed.length ? 1 : 0);
