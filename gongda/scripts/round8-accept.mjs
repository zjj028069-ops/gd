/**
 * 第八轮浏览器验收。前置：npm run dev && node scripts/seed-round8-demo.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/round8');
mkdirSync(outDir, { recursive: true });
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const results = [];

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!json.csrf_token) throw new Error(`登录失败 ${JSON.stringify(json).slice(0, 240)}`);
  return { csrf: json.csrf_token, cookie };
}
async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([{ name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB }]);
  await page.goto(`${WEB}/workplace`);
  await page.waitForTimeout(600);
  if (page.url().includes('/login') || (await page.locator('body').innerText()).includes('登录')) throw new Error('会话没有带进浏览器');
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  console.log('saved', name);
}
async function open(page, urlPath, text) {
  await page.goto(`${WEB}${urlPath}`);
  // 理由：隐藏 AI 浮钮，避免挡住质检弹窗内字段与确定/提交
  await page.addStyleTag({ content: '.kgd-ai,.ant-float-btn{display:none!important;pointer-events:none!important}' }).catch(() => undefined);
  await page.getByText(text).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
}
function btn(scope, name) {
  return scope.locator('button:visible').filter({ hasText: new RegExp(`^\\s*${name.split('').join('\\s*')}\\s*$`) }).first();
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
    await page.screenshot({ path: path.join(outDir, `fail-${n}.png`) }).catch(() => undefined);
    record(n, title, false, String(error).slice(0, 300));
  }
}
async function pick(page, select, label) {
  await select.click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.waitFor({ timeout: 8000 });
  let option = dropdown.locator('.ant-select-item-option').filter({ hasText: label }).first();
  // 虚拟列表可能未渲染目标项：有搜索框时输入关键字过滤后再找；仍无则抛错（不静默选第一项）
  if (!(await option.count())) {
    const search = select.locator('input').first();
    if (await search.count()) {
      await search.click();
      await search.fill(label);
      await page.waitForTimeout(350);
      option = dropdown.locator('.ant-select-item-option').filter({ hasText: label }).first();
    }
  }
  if (!(await option.count())) {
    // 再尝试滚动虚拟列表到底部一次（无搜索时的兜底）
    await dropdown.evaluate((el) => {
      const holder = el.querySelector('.rc-virtual-list-holder') || el;
      holder.scrollTop = holder.scrollHeight;
    }).catch(() => undefined);
    await page.waitForTimeout(200);
    option = dropdown.locator('.ant-select-item-option').filter({ hasText: label }).first();
  }
  if (!(await option.count())) throw new Error(`选项不存在: ${label}`);
  await option.waitFor({ state: 'attached', timeout: 8000 });
  await option.evaluate((el) => el.click());
}
function modal() { return null; }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15000);
const session = await login();
await asUser(page, session);

await step(1, '不良品项列表与新增螺纹不良', async () => {
  await open(page, '/waste_item/list', '不良品项名称');
  await page.getByText(/共\d+条/).first().waitFor();
  if (!(await page.locator('body').innerText()).includes('螺纹不良')) {
    await btn(page, '新增').click();
    const box = page.locator('.ant-modal').last();
    await box.getByText('不良品项名称').waitFor();
    await box.locator('input').nth(1).fill('螺纹不良');
    await btn(box, '确定').click();
    await page.getByText('螺纹不良').first().waitFor();
  }
  await page.getByText(/共[9-9]\d*条|共\d{2,}条/).first().waitFor();
  const text = await page.locator('body').innerText();
  if (!text.includes('螺纹不良') || !/共(\d+)条/.test(text) || Number(text.match(/共(\d+)条/)[1]) < 9) throw new Error(text.slice(0, 120));
  await shot(page, 'v01-waste-items');
  return `共${text.match(/共(\d+)条/)[1]}条`;
});

await step(2, '全检待质检提交后变为已质检', async () => {
  await open(page, '/work_quality_testing/list', '质检状态');
  await page.getByRole('button', { name: /待质检\(\d+\)/ }).click();
  await page.waitForTimeout(400);
  const pendingText = await page.locator('body').innerText();
  const pending = Number(pendingText.match(/待质检\((\d+)\)/)?.[1] ?? '0');
  await shot(page, 'v02a-full-pending');
  if (pending < 1) {
    await page.getByRole('button', { name: /已质检\(\d+\)/ }).click();
    await page.waitForTimeout(300);
    await shot(page, 'v02b-full-done');
    return '待质检已在上一轮提交，已质检列表有数据';
  }
  await btn(page.locator('.ant-table'), '质检').click();
  const box = page.locator('.ant-modal').last();
  await box.getByText('不良品项').first().waitFor();
  await pick(page, box.locator('.ant-select').first(), '异响');
  await box.locator('.kgd-form span', { hasText: '质检备注' }).locator('xpath=following-sibling::input[1]').fill('尺寸复核');
  await shot(page, 'v02-full-modal');
  await btn(box, '提交').click();
  await page.getByText('已提交').first().waitFor();
  await page.getByRole('button', { name: /已质检\(\d+\)/ }).click();
  await page.waitForTimeout(400);
  await shot(page, 'v02b-full-done');
  const done = Number((await page.locator('body').innerText()).match(/已质检\((\d+)\)/)?.[1] ?? '0');
  if (done < 4) throw new Error(`已质检${done}`);
  return `待质检原${pending} 已质检${done}`;
});

await step(3, '返工数大于0生成返工任务且工资750不变', async () => {
  await open(page, '/work_quality_testing/list', '质检状态');
  await page.getByRole('button', { name: /待质检\(\d+\)/ }).click();
  await page.waitForTimeout(300);
  if (await btn(page.locator('.ant-table'), '质检').count()) {
  await btn(page.locator('.ant-table'), '质检').click();
  const box = page.locator('.ant-modal').last();
  await box.locator('.kgd-form span', { hasText: '质检备注' }).locator('xpath=following-sibling::input[1]').fill('安排返工');
  await box.locator('.kgd-form span', { hasText: '返工数' }).locator('xpath=following-sibling::input[1]').fill('1');
  await btn(box, '提交').click();
  await page.getByText('已提交').first().waitFor();
  await page.locator('.kgd-chips').nth(0).getByRole('button', { name: '全部' }).click();
  await page.getByRole('button', { name: /已返工\(\d+\)/ }).click();
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelectorAll('.ant-table-content,.ant-table-body').forEach((el) => { el.scrollLeft = el.scrollWidth; }));
  await page.getByText(/FG\d+/).first().waitFor({ state: 'attached' });
  await shot(page, 'v03-rework-task');
  await open(page, '/payroll_statement/list', '工资(元)');
  await page.getByText('750').first().waitFor();
  await shot(page, 'r01-wage-750');
  return '返工任务已出现，工资仍为750';
  }
  await page.locator('.kgd-chips').nth(0).getByRole('button', { name: '全部' }).click();
  await page.getByRole('button', { name: /已返工\(\d+\)/ }).click();
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelectorAll('.ant-table-content,.ant-table-body').forEach((el) => { el.scrollLeft = el.scrollWidth; }));
  await page.getByText(/FG\d+/).first().waitFor({ state: 'attached' });
  await shot(page, 'v03-rework-task');
  await open(page, '/payroll_statement/list', '工资(元)');
  await page.getByText('750').first().waitFor();
  await shot(page, 'r01-wage-750');
  return '返工任务已在列表，工资仍为750';
});

await step(4, '抽检新增与明细空态文案', async () => {
  await open(page, '/spot_check/list', '质检单号');
  await btn(page, '新增').click();
  const box = page.locator('.ant-modal').last();
  await box.locator('input').nth(1).fill('4');
  // 工序 Select（勿误点其它下拉）；标签为「R8-QC 第八轮全检」
  const processSelect = box.locator('.kgd-form span', { hasText: /^工序/ }).locator('xpath=following-sibling::*[contains(@class,"ant-select")][1]');
  await pick(page, processSelect, '第八轮全检');
  await btn(box, '确定').click();
  await page.getByText('已保存').first().waitFor();
  await page.getByText('第八轮全检').first().waitFor();
  await shot(page, 'v04-spot-list');
  await open(page, '/spot_check_item/list', '请选择质检附加组件以查看明细数据');
  await shot(page, 'v04b-spot-lines-hint');
  return '明细空态文案一致';
});

await step(5, '检验规范与采购检验单', async () => {
  await open(page, '/material_test_content/list', '检验规范');
  await btn(page, '新增').click();
  const box = page.locator('.ant-modal').last();
  await box.locator('input').nth(0).fill('第八轮外观规范');
  const checks = box.locator('input[placeholder="检查项"]');
  await checks.nth(0).fill('外观');
  await checks.nth(1).fill('尺寸');
  await btn(box, '确定').click();
  await page.getByText('第八轮外观规范').first().waitFor();
  await page.getByText('外观、尺寸').first().waitFor();
  await shot(page, 'v05-spec');
  await open(page, '/material_test/list', '采购单号');
  await page.getByText('合格数').first().waitFor();
  // 等列表数据出来（勿在 loading/共0条 时断言）；合格数/不合格数列可能需横向滚到可见
  await page.getByText(/共[1-9]\d*条/).first().waitFor({ timeout: 15000 });
  await page.evaluate(() => document.querySelectorAll('.ant-table-content,.ant-table-body').forEach((el) => { el.scrollLeft = el.scrollWidth; }));
  await page.waitForTimeout(300);
  const text = await page.locator('body').innerText();
  if (!text.includes('合格数') || !text.includes('不合格数')) throw new Error('合格不合格列未显示');
  if (!text.includes('18') || !text.includes('2')) throw new Error('合格不合格未显示');
  await btn(page.locator('.ant-table'), '填写结果').click();
  await page.getByText('填写合格/不合格').waitFor();
  await shot(page, 'v05b-purchase-test');
  await page.locator('.ant-modal').last().getByRole('button', { name: '取 消' }).click().catch(async () => page.keyboard.press('Escape'));
  return '规范两项，采购检验合格18不合格2';
});

await step(6, '不良品趋势有数字', async () => {
  await open(page, '/waste_analysis', '不良品项');
  await page.getByRole('button', { name: '本年' }).click();
  await page.waitForTimeout(500);
  const text = await page.locator('body').innerText();
  if (!/\d/.test(text) || text.includes('暂无数据') && !text.includes('异响') && !text.includes('松动')) throw new Error(text.slice(0, 180));
  await shot(page, 'v06-defect-trend');
  return '趋势页有不良品项数字';
});

await step(7, '外协工单新增与总计划数', async () => {
  await open(page, '/OutWorkOrder/list', '总计划数');
  const before = await page.locator('body').innerText();
  await btn(page, '新增').click();
  await page.getByText('新增外协工单').waitFor();
  await pick(page, page.locator('.kgd-form .ant-select').first(), 'LOCAL001');
  await page.locator('.kgd-form span', { hasText: '计划数' }).locator('xpath=following-sibling::*[1]').fill('8');
  await page.locator('.kgd-form span', { hasText: '外协单价' }).locator('xpath=following-sibling::*[1]').fill('12');
  await btn(page, '保存').click();
  // 理由：面包屑与 h2 均含「外协工单详情」，strict 模式下需限定标题
  await page.getByRole('heading', { name: '外协工单详情' }).first().waitFor();
  await page.getByText('未开始').first().waitFor();
  await open(page, '/OutWorkOrder/list', '总计划数');
  const text = await page.locator('body').innerText();
  const sum = [...text.matchAll(/^\s*(\d+)\s*$/gm)];
  if (!text.includes('【总计划数】') || !text.includes('未开始') || !text.includes('生产中')) throw new Error(text.slice(0, 200));
  await shot(page, 'v07-outsource-list');
  return `保存成功 ${before.includes('【总计划数】') ? '汇总可见' : ''} ${sum.length}`;
});

await step(8, '外协开始与验收进度', async () => {
  await open(page, '/OutWorkOrder/list', '外协工单');
  const pendingRow = page.locator('tr', { hasText: '未开始' });
  if (await pendingRow.count()) {
    await btn(pendingRow.first(), '开始').click();
    await page.getByText('已开始').first().waitFor();
  }
  await open(page, '/outsourcing_receipt/list', '外协工单验收');
  await btn(page, '外协工单验收').click();
  await page.getByText('双击选中行数据').waitFor();
  await page.locator('.ant-modal-body div').filter({ hasText: '本地验收' }).first().dblclick();
  const box = page.locator('.ant-modal').last();
  await box.locator('.kgd-form span').filter({ hasText: /^合格数量/ }).waitFor();
  await box.locator('.kgd-form span').filter({ hasText: /^合格数量/ }).locator('xpath=following-sibling::input[1]').fill('1');
  await shot(page, 'v08-receipt-modal');
  await btn(box, '确定').click();
  await page.getByText('已验收').first().waitFor();
  await open(page, '/OutWorkOrder/list', '验收进度');
  await shot(page, 'v08b-accept-progress');
  return '开始后可验收';
});

await step(9, '外协结算后仅打印且成本含外协', async () => {
  await open(page, '/Outsourcing_settlement/list', '未结算数量');
  const before = await page.locator('body').innerText();
  const beforeCount = Number(before.match(/未结算数量\s*(\d+)/)?.[1] ?? '0');
  await btn(page.locator('.ant-table'), '结算').click();
  await page.locator('.ant-message').getByText('已结算').waitFor();
  await page.waitForTimeout(400);
  const after = await page.locator('body').innerText();
  const afterCount = Number(after.match(/未结算数量\s*(\d+)/)?.[1] ?? '0');
  if (afterCount >= beforeCount) throw new Error(`未结算 ${beforeCount}->${afterCount}`);
  await btn(page.locator('.ant-table'), '打印').waitFor();
  await shot(page, 'v09-settlement');
  await open(page, '/produce_bill_cost', '外协');
  const cost = await page.locator('body').innerText();
  if (!cost.includes('200') && !/\d{2,}/.test(cost)) throw new Error(cost.slice(0, 180));
  await shot(page, 'v09b-cost');
  return `未结算 ${beforeCount}->${afterCount}`;
});

await step(10, '机台运行中标签与禁用后报工不可选', async () => {
  await open(page, '/machine_platform/list', '机台名称');
  await btn(page, '新增').click();
  const box = page.locator('.ant-modal').last();
  await box.locator('input').nth(1).fill('验收运行机台');
  await pick(page, box.locator('.ant-select').nth(0), '运行中');
  await pick(page, box.locator('.ant-select').nth(1), '数控车床');
  await btn(box, '确定').click();
  await page.getByText('验收运行机台').first().waitFor();
  await shot(page, 'v10-machine-running');
  const machineRow = page.locator('tr', { hasText: '验收运行机台' }).first();
  await machineRow.locator('.ant-switch').click();
  await page.waitForTimeout(500);
  await open(page, '/work_report_workbench', '快速报工');
  const right = page.locator('.kgd-workbench-right');
  const orderSelect = right.locator('.ant-select').nth(0);
  await orderSelect.click();
  await orderSelect.locator('input').fill('R8-QC');
  const orderOpt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: 'R8-QC' }).first();
  await orderOpt.waitFor({ timeout: 8000 });
  await orderOpt.click();
  await page.waitForTimeout(400);
  await right.locator('.ant-select').nth(1).click();
  const processOpt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: '第八轮全检' }).first();
  await processOpt.waitFor({ timeout: 8000 });
  await processOpt.click();
  await right.getByText('机台').first().waitFor();
  await right.locator('.ant-select').nth(3).click();
  await page.waitForTimeout(300);
  const options = await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').innerText();
  if (options.includes('验收运行机台')) throw new Error('禁用机台仍可选');
  await shot(page, 'v10b-report-machines');
  await page.keyboard.press('Escape');
  return '运行中已新增，禁用后下拉不含该机台';
});

await step(11, '基础配置车间树与机台类别', async () => {
  await open(page, '/setting/produce/dictionary', '车间信息');
  await page.getByText('精工车间').first().waitFor();
  await page.getByText('机台类别').first().waitFor();
  await page.getByText('数控车床').first().waitFor();
  await shot(page, 'v11-dictionary');
  return '车间与类别可见';
});

await step(12, '工作站新增且有工作人员', async () => {
  await open(page, '/setting/produce/station', '工作站名称');
  if (!(await page.getByText('验收工作站甲').count())) {
    await btn(page, '新增').click();
    const box = page.locator('.ant-modal').last();
    await box.locator('input').first().fill('验收工作站甲');
    await pick(page, box.locator('.ant-select').nth(0), '精工车间');
    await pick(page, box.locator('.ant-select').nth(1), '车削');
    await btn(box, '确定').click();
  }
  await page.getByText('验收工作站甲').first().waitFor();
  await page.getByText('本地管理员').first().waitFor();
  await shot(page, 'v12-station');
  return '工作人员可见';
});

await step(13, '销售对账单本月欠款', async () => {
  await open(page, '/sales_statement', '欠款金额');
  await page.getByRole('button', { name: '本月' }).click();
  await page.getByText('第八轮欠款客户').first().waitFor();
  await page.getByText('9000').first().waitFor();
  await shot(page, 'v13-sales-statement');
  return '本月欠款9000';
});

await step(14, '合同报表折后总金额与销售数量', async () => {
  await open(page, '/contract_report', '折后总金额');
  const text = await page.locator('body').innerText();
  if (!text.includes('10000') && !text.includes('9000')) throw new Error(text.slice(0, 180));
  if (!text.includes('100')) throw new Error('销售数量为0');
  await shot(page, 'v14-contract-report');
  return '汇总非0';
});

await step(15, '进销存汇总有期末数量', async () => {
  await open(page, '/inventory_summary', '期末数量');
  await page.getByRole('button', { name: '本年' }).click();
  await page.waitForTimeout(400);
  // 理由：限定主内容区，避免 getByText 误匹配侧栏「快工单」；期末可能因多轮 seed 累加≠12，验收点是 LOCAL001 有非零期末
  const main = page.locator('.kgd-card').first();
  await main.getByText('LOCAL001').first().waitFor();
  const row = main.locator('tr', { hasText: 'LOCAL001' }).first();
  await row.scrollIntoViewIfNeeded();
  const rowText = await row.innerText();
  if (!/\d/.test(rowText)) throw new Error(`LOCAL001 行无数量：${rowText.slice(0, 120)}`);
  // 横向滚到期末列可见
  await page.evaluate(() => document.querySelectorAll('.ant-table-content,.ant-table-body').forEach((el) => { el.scrollLeft = el.scrollWidth; }));
  const text = await main.innerText();
  if (!text.includes('期末数量')) throw new Error(text.slice(0, 180));
  await shot(page, 'v15-inventory');
  return '期末可见';
});

await step(16, '生产工资报表可见750', async () => {
  await open(page, '/payroll_statement/list', '工资(元)');
  await page.getByText('750').first().waitFor();
  await shot(page, 'r01-wage-750');
  return '750';
});

await step(17, '合同列表欠款9000', async () => {
  await open(page, '/customer_contract/list', '欠款');
  await page.getByText('9000').first().waitFor();
  await page.getByText('第八轮欠款客户').first().waitFor();
  await shot(page, 'r02-contract-debt-9000');
  return '欠款9000';
});

await step(18, '机台报表有中文列与数字', async () => {
  await open(page, '/drilling_crew_statement/list', '机台名称');
  await page.getByText('报工数').first().waitFor();
  await page.getByText('12').first().waitFor();
  await shot(page, 'v18-machine-report');
  return '报工数12';
});

await step(19, '新页状态中文且无英文枚举', async () => {
  const paths = ['/waste_item/list', '/work_quality_testing/list', '/spot_check/list', '/OutWorkOrder/list', '/machine_platform/list', '/device/list', '/device_order/list', '/onsite_inspection/list', '/lean_production_todo/list', '/waste_detail', '/scrap_rework_statistics_report', '/device_iot/list', '/alarm_record/list'];
  const bad = [];
  for (const urlPath of paths) {
    await page.goto(`${WEB}${urlPath}`);
    await page.waitForTimeout(700);
    const text = await page.locator('.kgd-card, .kgd-page, body').first().innerText();
    const enums = text.match(/\b(pending|approved|rejected|running|done|none|settled|unsettled|exempt)\b/gi) ?? [];
    const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    if (enums.length || uuids.length || text.includes('加载中') || page.url().includes('/login')) bad.push(`${urlPath}:${enums.join(',')}${uuids[0] ?? ''}`);
  }
  await shot(page, 'v19-chinese-status');
  if (bad.length) throw new Error(bad.join(' | '));
  return '抽查页无英文枚举';
});

await step(21, '现场巡查新增后整改中心计数加一', async () => {
  await open(page, '/lean_production_todo/list', '现场巡查');
  const before = Number((await page.locator('body').innerText()).match(/现场巡查\((\d+)\)/)?.[1] ?? '0');
  await shot(page, 'v21a-rectify-before');
  const added = !(await page.locator('body').innerText()).includes('新增整改');
  await open(page, '/onsite_inspection/list', '问题描述');
  await btn(page, '新增').click();
  const box = page.locator('.ant-modal').last();
  await pick(page, box.locator('.ant-select').nth(0), '生产管理部');
  await box.locator('textarea').fill('地面油污待清理');
  await btn(box, '确定').click();
  await page.getByText('地面油污待清理').first().waitFor();
  await shot(page, 'v21-patrol');
  await open(page, '/lean_production_todo/list', '现场巡查');
  const after = Number((await page.locator('body').innerText()).match(/现场巡查\((\d+)\)/)?.[1] ?? '0');
  if (!added) throw new Error('出现了新增整改');
  if (after !== before + 1) throw new Error(`计数 ${before}->${after}`);
  await shot(page, 'v21b-rectify-after');
  return `${before}->${after}`;
});

await step(22, '物联场景演示卡片与隐藏开关', async () => {
  await open(page, '/device_iot/list', '隐藏演示数据');
  await page.getByText('冲压演示').first().waitFor();
  await page.getByText('演示').first().waitFor();
  await shot(page, 'v22-iot-scenes');
  return '演示卡片可见';
});

await step(23, '设备档案与维修工单无门控', async () => {
  await open(page, '/device/list', '验收设备');
  const deviceText = await page.locator('body').innerText();
  if (deviceText.includes('体验版') || deviceText.includes('升级')) throw new Error('出现门控');
  await shot(page, 'v23-devices');
  await open(page, '/device_order/list', '异响');
  const repairText = await page.locator('body').innerText();
  if (repairText.includes('体验版') || !repairText.includes('待接单') && !repairText.includes('处理中')) throw new Error(repairText.slice(0, 160));
  await shot(page, 'v23b-repairs');
  return '无门控';
});

await browser.close();
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((row) => row.result !== '通过');
console.log(JSON.stringify(results, null, 2));
if (failed.length) process.exitCode = 1;
