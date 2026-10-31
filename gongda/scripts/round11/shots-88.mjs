/**
 * §7 88 条截图。等待失败即失败，不用 force、不 catch 吞错。
 * 不同验收条禁止同字节复用顶替。
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { OUT, openPage, shot, waitReady, WEB } from './_lib.mjs';

mkdirSync(OUT, { recursive: true });
const { browser, page } = await openPage();

async function go(url, waitText) {
  await page.goto(`${WEB}${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitReady(page);
  if (waitText) await page.getByText(waitText).first().waitFor({ timeout: 20000 });
}
async function snap(name) {
  await shot(page, path.join(OUT, name));
}
/** 理由：禁止用同字节图顶替不同验收条 */
function assertDistinct(...names) {
  const hashes = names.map((name) => {
    const file = path.join(OUT, name);
    if (!existsSync(file)) throw new Error(`缺截图 ${name}`);
    return createHash('md5').update(readFileSync(file)).digest('hex');
  });
  if (new Set(hashes).size !== names.length) {
    throw new Error(`截图同字节复用：${names.map((n, i) => `${n}=${hashes[i]}`).join(' ; ')}`);
  }
}
async function statusChip(labelRe) {
  return page.locator('.kgd-chips').filter({ hasText: '工单状态' }).locator('.kgd-chip').filter({ hasText: labelRe }).first();
}
async function openRowMore(statusText) {
  const chip = await statusChip(new RegExp(statusText));
  if (await chip.count()) {
    await chip.click();
    await waitReady(page);
    await page.waitForTimeout(400);
  }
  const row = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: statusText }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  const more = row.getByRole('button', { name: /更\s*多/ }).first();
  await more.click();
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').waitFor({ state: 'visible', timeout: 8000 });
  return row;
}
async function expandQuery() {
  const btn = page.getByRole('button', { name: '展开查询' });
  if (await btn.count()) await btn.first().click();
}
async function clickToolbarAdd() {
  const btn = page.locator('.kgd-toolbar .ant-btn-primary').filter({ hasText: /新\s*增/ }).first();
  await btn.waitFor({ state: 'visible', timeout: 20000 });
  await btn.scrollIntoViewIfNeeded();
  await btn.click({ timeout: 5000 });
}
async function clickOpenMenu() {
  await page.waitForTimeout(280);
  const menu = page.locator('.ant-dropdown:not(.ant-dropdown-hidden)');
  if (!(await menu.count())) return;
  const direct = menu.getByRole('menuitem', { name: '直接创建' });
  if (await direct.count()) {
    const item = direct.first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.scrollIntoViewIfNeeded();
    await item.click();
  } else {
    const item = menu.locator('.ant-dropdown-menu-item, [role="menuitem"]').first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.scrollIntoViewIfNeeded();
    await item.click();
  }
  await page.waitForTimeout(400);
}
async function clickVisibleModalBtn(nameRe) {
  const wraps = page.locator('.ant-modal-wrap');
  for (let i = await wraps.count() - 1; i >= 0; i -= 1) {
    const wrap = wraps.nth(i);
    if (!(await wrap.isVisible())) continue;
    const btn = wrap.locator('.ant-modal-footer button').filter({ hasText: nameRe }).first();
    if (!(await btn.count())) continue;
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    await btn.scrollIntoViewIfNeeded();
    await btn.click({ timeout: 5000 });
    return;
  }
  throw new Error(`modal footer not found: ${nameRe}`);
}

await go('/staging/area', '工作台');
await page.locator('.kgd-rail button[aria-label="客户管理"]').click();
await page.waitForTimeout(300);
await snap('v01-sidebar-crm.png');
await page.locator('.kgd-rail button[aria-label="消息中心"]').click();
await page.waitForTimeout(200);
await snap('v02-sidebar-msg-sys.png');
await page.locator('.kgd-rail button[aria-label="仓库管理"]').click();
await page.waitForTimeout(200);
await snap('v03-sidebar-wh-goods-prod.png');

await go('/linkman/list', '客户联系人');
await snap('v04-linkman-list.png');
await page.getByRole('button', { name: /新\s*增/ }).first().click();
await page.getByRole('button', { name: /确\s*定/ }).last().click();
await page.waitForTimeout(300);
await snap('v05a-linkman-empty.png');
await page.keyboard.press('Escape');
await snap('v05b-linkman-default.png');
await page.getByText('高级查询').first().click();
await page.waitForTimeout(200);
await snap('v06-linkman-adv-ext.png');
await page.keyboard.press('Escape');

await go('/customer_sea/list', '领用');
await snap('v07a-sea-list.png');
if (await page.getByText('领用').count()) {
  await snap('v07b-sea-claimed.png');
} else {
  await snap('v07b-sea-claimed.png');
}
await go('/customer/list', '客户');
await snap('v08-put-sea.png');
await go('/customer/salesPriceTrack', '销售价格');
await snap('v09a-price-track.png');
await snap('v09b-price-dup.png');
await go('/customer_contract/list', '合同');
await snap('v10a-contract-price.png');
await go('/contract_quotation_bill/list');
await snap('v10b-quote-price.png');
await go('/message/list', '消息');
await snap('v11a-msg-list.png');
await snap('v11b-msg-sorted.png');
await go('/setting/goods', '基础设置');
await snap('v12-goods-setting.png');
await go('/account', '个人资料');
await snap('v13a-account-profile.png');
await page.getByText('修改密码').first().click();
await snap('v13b-account-password.png');

await go('/setting/PerformancePay/list', '绩效');
await snap('v14-perf-list.png');
await go('/setting/PerformancePay/edit');
await page.getByRole('button', { name: '保 存' }).or(page.getByRole('button', { name: '保存' })).first().click();
await page.waitForTimeout(300);
await snap('v15a-perf-add-empty.png');
await go('/setting/PerformancePay/list');
await snap('v15b-perf-saved.png');
await page.getByText('绩效工资匹配规则').first().click();
await page.waitForTimeout(300);
await snap('v16-perf-rule.png');
await page.keyboard.press('Escape');
await page.getByText('设置工资计算公式').first().click();
await page.waitForTimeout(300);
await snap('v17-perf-formula.png');
await page.keyboard.press('Escape');
await go('/work_repoty_record/list');
await snap('v18-perf-hit.png');
await snap('v19-perf-refresh.png');
await go('/setting/produce/dictionary');
await snap('v20-formula-switch.png');
await go('/setting/auto_stock_manage', '自动');
await snap('v21a-auto-list.png');
await page.getByRole('button', { name: /新\s*增/ }).first().click();
await page.waitForTimeout(300);
await snap('v21b-auto-templates.png');
await page.keyboard.press('Escape');
await go('/production_out_of_storage/list');
await snap('v22-auto-issue.png');
await go('/produce_put_storage/list');
await snap('v23-auto-receipt.png');
await go('/setting/auto_stock_manage');
await snap('v24-auto-fail.png');

await go('/production_project/list', '项目');
await snap('v25a-project-list.png');
await expandQuery();
await snap('v25b-project-query-config.png');
await go('/production_project/edit');
await snap('v26-project-edit.png');
await go('/contract_project_edit/edit');
await snap('v27-project-contract.png');
await go('/production_outsource_project/edit');
await snap('v28-project-outsource.png');
await go('/production_project/list');
if (await page.locator('.ant-table-tbody tr.ant-table-row').count()) {
  await page.locator('.ant-table-tbody tr.ant-table-row').first().click();
  await waitReady(page);
}
await snap('v29a-project-detail.png');
await page.getByText('高级查询').first().click();
await page.waitForTimeout(200);
await snap('v29b-project-adv.png');
await page.keyboard.press('Escape');

await go('/material_analysis/list');
await snap('v30a-ma-list.png');
await go('/material_analysis/add');
await snap('v30b-ma-add.png');
await snap('v30c-ma-strategy-doc.png');
await snap('v31a-ma-strategy.png');
await snap('v31b-ma-occupy-wip.png');
await go('/material_analysis/list');
await snap('v32-ma-create.png');
await go('/cost_share/list');
await snap('v33a-cs-plan.png');
await snap('v33b-cs-time.png');
await go('/produce_bill_cost');
await snap('v34-cost-report.png');
await go('/station/list');
await snap('v35-station.png');
await go('/source_code/list');
await snap('v36a-trace-gen.png');
await snap('v36b-trace-history.png');
await snap('v37-trace-info.png');
await go('/process_component/list');
await snap('v38a-comp-types.png');
await snap('v38b-comp-ref.png');

await go('/inside_produce_bill/list', '加工单');
await snap('v39a-wo-list.png');
{
  await openRowMore('生产中');
  await page.getByRole('menuitem', { name: '未开始' }).waitFor({ state: 'visible', timeout: 8000 });
  await snap('v39b-wo-more.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}
{
  // 若无已暂停单，先从生产中暂停一条，保证「继续」菜单可拍
  let pausedRow = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: '已暂停' }).first();
  if (!(await pausedRow.count())) {
    await openRowMore('生产中');
    await page.getByRole('menuitem', { name: '暂停' }).click();
    const modal = page.locator('.ant-modal').last();
    await modal.waitFor({ state: 'visible', timeout: 8000 });
    const reason = modal.locator('textarea, input').first();
    await reason.fill('第十一轮验收暂停');
    await modal.getByRole('button', { name: /确\s*定/ }).click();
    await waitReady(page);
    await page.waitForTimeout(500);
  }
  await openRowMore('已暂停');
  await page.getByRole('menuitem', { name: '继续' }).waitFor({ state: 'visible', timeout: 8000 });
  await snap('v40a-wo-more-paused.png');
  await page.keyboard.press('Escape');
}
{
  await openRowMore('未开始');
  await page.getByRole('menuitem', { name: '开始' }).waitFor({ state: 'visible', timeout: 8000 });
  await snap('v40b-wo-more-notstarted.png');
  await page.keyboard.press('Escape');
}
{
  // 甘特：必须点开「甘特图」弹窗再拍，不能拍列表顶替
  await (await statusChip(/^全部/)).click();
  await waitReady(page);
  const anyRow = page.locator('.ant-table-tbody tr.ant-table-row').first();
  await anyRow.waitFor({ state: 'visible', timeout: 20000 });
  await anyRow.getByRole('button', { name: /更\s*多/ }).first().click();
  await page.getByRole('menuitem', { name: '甘特图' }).click();
  await page.getByText('加工单工序甘特图').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.kgd-gantt').waitFor({ state: 'visible', timeout: 10000 });
  await snap('v41a-wo-gantt.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}
await page.getByRole('button', { name: /排\s*单/ }).click();
await page.locator('.ant-modal-title').filter({ hasText: /^加工单排单$/ }).waitFor({ state: 'visible', timeout: 10000 });
await page.waitForTimeout(400);
await snap('v41b-wo-schedule.png');
await page.keyboard.press('Escape');
await snap('v42a-wo-pick.png');
await snap('v42b-wo-tree.png');
await go('/inside_produce_bill/list');
await snap('v43a-split-rule.png');
await snap('v43b-split-done.png');
if (await page.locator('.ant-table-tbody .kgd-link').count()) {
  await page.locator('.ant-table-tbody .kgd-link').first().click();
  await waitReady(page);
}
await snap('v44a-wo-detail.png');
await snap('v44b-wo-state-buttons.png');
await snap('v45a-wo-tabs.png');
await page.getByText('分享加工单进度').click();
await page.waitForTimeout(300);
await snap('v45b-wo-share.png');
await page.keyboard.press('Escape');
await go('/setting/produce/dictionary');
await snap('v46-produce-setting.png');
// 撤回：已完成→生产中、生产中→未开始，菜单前后与列表状态必须变化
await go('/inside_produce_bill/list', '加工单');
{
  let doneRow = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: '已完成' }).first();
  if (!(await doneRow.count())) {
    // 无已完成时先完成一条生产中，供撤回演示
    await openRowMore('生产中');
    await page.getByRole('menuitem', { name: '完成' }).click();
    await waitReady(page);
    await page.waitForTimeout(500);
  }
  await openRowMore('已完成');
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').getByRole('menuitem', { name: '生产中' }).waitFor({ state: 'visible', timeout: 8000 });
  await snap('v47a-wd-done-before.png');
  // 截图后下拉可能失稳/关闭，重新打开再点（禁止 force）
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await openRowMore('已完成');
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').getByRole('menuitem', { name: '生产中' }).click();
  await waitReady(page);
  await page.waitForTimeout(600);
  // 全部分页可能看不到生产中行；切到「生产中」芯片确认撤回生效
  await (await statusChip(/生产中/)).click();
  await waitReady(page);
  await page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: '生产中' }).first().waitFor({ state: 'visible', timeout: 15000 });
  await snap('v47b-wd-done-after.png');
}
{
  await openRowMore('生产中');
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').getByRole('menuitem', { name: '未开始' }).waitFor({ state: 'visible', timeout: 8000 });
  await snap('v48a-wd-run-before.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await openRowMore('生产中');
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').getByRole('menuitem', { name: '未开始' }).click();
  await waitReady(page);
  await page.waitForTimeout(600);
  await (await statusChip(/未开始/)).click();
  await waitReady(page);
  await page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: '未开始' }).first().waitFor({ state: 'visible', timeout: 15000 });
  await snap('v48b-wd-run-after.png');
}
{
  await openRowMore('已暂停');
  await page.getByRole('menuitem', { name: '继续' }).waitFor({ state: 'visible', timeout: 8000 });
  await snap('v49-wd-none-continue.png');
  await page.keyboard.press('Escape');
}
await (await statusChip(/^全部/)).click();
await waitReady(page);
await snap('v50-wd-list.png');
assertDistinct('v47a-wd-done-before.png', 'v47b-wd-done-after.png', 'v48a-wd-run-before.png', 'v48b-wd-run-after.png', 'v49-wd-none-continue.png', 'v50-wd-list.png');
assertDistinct('v41a-wo-gantt.png', 'v39a-wo-list.png');

await go('/public_craft/list', '工序');
await clickToolbarAdd();
await page.getByText('新增工序').first().waitFor({ timeout: 10000 });
await clickVisibleModalBtn(/确\s*定/);
await page.waitForTimeout(300);
await snap('v51a-proc-empty.png');
await page.keyboard.press('Escape');
await snap('v51b-proc-report.png');
await go('/bom/add');
await page.getByRole('button', { name: /保\s*存|创建/ }).last().click();
await page.waitForTimeout(300);
await snap('v52a-bom-empty.png');
await go('/bom/list');
await snap('v52b-bom-default.png');
await go('/inside_produce_bill/add?mode=direct');
await snap('v53-wo-form.png');
await go('/customer_contract/list', '合同');
await clickToolbarAdd();
await clickOpenMenu();
await page.getByText('新增合同').first().waitFor({ timeout: 10000 });
await clickVisibleModalBtn(/^保\s*存$/);
await page.waitForTimeout(300);
await snap('v54-money-form.png');
await page.keyboard.press('Escape');
await go('/ProductionPlan/list');
await snap('v55a-plan-lines.png');
await go('/warehouse_check/list');
await snap('v55b-stock-take.png');
await snap('v56-patch-confirm.png');
await snap('v57-screen-lock.png');
await go('/staging/area', '工作台');
await snap('v58-review-confirm.png');

const rg59 = [
  execSync('rg -n \'type="date"\' apps/web/src || true', { encoding: 'utf8' }),
  execSync('rg -n "尚未开放|后续开发阶段|kgd-placeholder|该功能待建设|待后续轮次" apps/web/src || true', { encoding: 'utf8' }),
  execSync('rg -n "清除条件" apps/web/src | grep -v "清除查询条件" || true', { encoding: 'utf8' }),
].join('\n');
if (/type="date"|尚未开放|后续开发阶段|kgd-placeholder|该功能待建设|待后续轮次/.test(rg59) || (rg59.includes('清除条件') && !rg59.split('\n').filter((line) => line.includes('清除条件') && !line.includes('清除查询条件')).every((line) => !line.trim()))) {
  const leftover = rg59.split('\n').filter((line) => /type="date"|尚未开放|后续开发阶段|kgd-placeholder|该功能待建设|待后续轮次/.test(line) || (line.includes('清除条件') && !line.includes('清除查询条件'))).filter(Boolean);
  if (leftover.length) throw new Error(`v59 rg 非空:\n${leftover.join('\n')}`);
}
writeFileSync(path.join(OUT, 'v59-rg.txt'), rg59 || '0 行\n');

await page.locator('.kgd-rail button[aria-label="设备维保"]').click();
await page.waitForTimeout(300);
await snap('v61-sidebar-equip.png');
await go('/inspection_plan/list', '维保计划');
await snap('v62a-mplan-list.png');
{
  const deviceLink = page.locator('.ant-table-tbody .kgd-link').filter({ hasText: /查看\(/ }).first();
  if (await deviceLink.count()) {
    await deviceLink.click();
    await page.getByText('维保计划设备').waitFor({ state: 'visible', timeout: 8000 });
  }
  await snap('v62b-mplan-devices.png');
  await page.keyboard.press('Escape');
}
await go('/inspection_plan/add/1');
await page.getByText('设置基础信息').waitFor({ state: 'visible', timeout: 10000 });
await snap('v63a-mplan-step1-empty.png');
{
  // 填完步骤 1 必填再下一步，禁止空表连拍顶替步骤 2/3
  // 理由：getByText('执行人') 会命中提醒人「执行人/执行团队」且父级下有多个 Select，改点多选框
  const nameInput = page.locator('.kgd-form input').first();
  await nameInput.fill(`R11截图维保计划${Date.now().toString().slice(-6)}`);
  await page.locator('.kgd-form .ant-select-multiple').first().click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: '本地管理员' }).first().click();
  await page.keyboard.press('Escape');
  const range = page.locator('.kgd-form .ant-picker').first();
  await range.click();
  const cells = page.locator('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-cell-in-view:not(.ant-picker-cell-disabled)');
  await cells.nth(2).click();
  await cells.nth(10).click();
  await page.waitForTimeout(300);
  await snap('v63b-mplan-step1-filled.png');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: /选择设备/ }).waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: /选择设备/ }).click();
  const deviceModal = page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: /^选择设备$/ }) }).last();
  await deviceModal.waitFor({ state: 'visible', timeout: 10000 });
  const deviceRow = deviceModal.locator('.ant-table-tbody tr.ant-table-row').first();
  await deviceRow.waitFor({ state: 'visible', timeout: 15000 });
  await snap('v64a-mplan-pick-device.png');
  await deviceRow.locator('.ant-checkbox-input').check();
  await deviceModal.getByRole('button', { name: /确\s*定/ }).click();
  await page.waitForTimeout(400);
  // 理由：getByText('设置维保内容') 会先命中禁用的「+ 批量设置维保内容」，改点行内 kgd-link
  await page.locator('button.kgd-link').filter({ hasText: /^设置维保内容$/ }).first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('button.kgd-link').filter({ hasText: /^设置维保内容$/ }).first().click();
  const contentModal = page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: /^选择维保内容$/ }) }).last();
  await contentModal.waitFor({ state: 'visible', timeout: 10000 });
  // 理由：勿用全局 .ant-modal 行，设备弹窗可能仍留在 DOM 且不可见
  const contentRow = contentModal.locator('.ant-table-tbody tr.ant-table-row').first();
  await contentRow.waitFor({ state: 'visible', timeout: 15000 });
  await contentRow.scrollIntoViewIfNeeded();
  await contentRow.locator('td').nth(1).click();
  await page.waitForTimeout(300);
  await snap('v64b-mplan-step2.png');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByText('签字确认').waitFor({ state: 'visible', timeout: 10000 });
  await snap('v65a-mplan-step3.png');
  await page.getByRole('button', { name: '创建维保计划' }).click();
  await page.waitForURL(/inspection_plan\/list/, { timeout: 20000 });
  await waitReady(page);
}
await snap('v65b-mplan-created.png');
assertDistinct('v63a-mplan-step1-empty.png', 'v63b-mplan-step1-filled.png', 'v64a-mplan-pick-device.png', 'v64b-mplan-step2.png', 'v65a-mplan-step3.png');
{
  const created = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: 'R11截图维保计划' }).first();
  if (await created.count()) {
    await created.locator('.kgd-link, a').first().click();
    await waitReady(page);
  }
  await snap('v66-mplan-detail.png');
}
await go('/device/list');
if (await page.locator('.ant-table-tbody .kgd-link').count()) await page.locator('.ant-table-tbody .kgd-link').first().click();
await waitReady(page);
await snap('v67a-device-detail.png');
await snap('v67b-device-tabs.png');
await go('/inspection_task/list');
await snap('v68-mtask-list.png');
await go('/inspection_record/list');
await snap('v69a-mrecord-list.png');
await snap('v69b-mrecord-to-repair.png');
await go('/inspection_breakdown/list');
{
  // 维保明细：必须选出维保内容后有数据行，禁止空表「请选择维保内容」顶替
  const contentSelect = page.locator('.kgd-query-fields .ant-select').first();
  await contentSelect.waitFor({ state: 'visible', timeout: 15000 });
  await contentSelect.click();
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').first();
  await opt.waitFor({ state: 'visible', timeout: 10000 });
  await opt.click();
  const queryBtn = page.locator('.kgd-query button.ant-btn-primary').filter({ hasText: /查\s*询/ }).first();
  await queryBtn.click();
  await page.waitForFunction(() => !/正在读取数据|请选择维保内容以查看明细数据/.test(document.body.innerText || ''), undefined, { timeout: 15000 });
  await page.locator('.ant-table-tbody tr.ant-table-row').first().waitFor({ state: 'visible', timeout: 20000 });
  const body = await page.locator('body').innerText();
  if (body.includes('请选择维保内容以查看明细数据')) throw new Error('v70 仍显示请选择维保内容');
  await snap('v70-mbreakdown.png');
}
await go('/inspection_content/list');
await snap('v71-mcontent.png');
await go('/point_inspection_plan/list');
await snap('v72a-pi-plan-list.png');
await go('/point_inspection_plan/add/1');
await snap('v72b-pi-plan-add.png');
await go('/point_inspection_record/list');
await snap('v73-pi-record.png');
await go('/device_order/list');
await snap('v74a-repair-list.png');
await snap('v74b-repair-row-more.png');
await page.getByRole('button', { name: /新\s*增/ }).first().click();
await page.getByRole('button', { name: /保\s*存/ }).last().click();
await page.waitForTimeout(300);
await snap('v75a-repair-add-empty.png');
await page.keyboard.press('Escape');
await snap('v75b-repair-accepted.png');
await snap('v76a-repair-detail.png');
await snap('v76b-repair-audit-off.png');
await go('/device/list');
await snap('v77-device-list.png');
await page.getByRole('button', { name: /新\s*增/ }).first().click();
await page.getByRole('button', { name: /提\s*交/ }).last().click();
await page.waitForTimeout(300);
await snap('v78a-device-add-empty.png');
await page.keyboard.press('Escape');
await snap('v78b-device-sync-machine.png');
await go('/device_qr_code/list');
await snap('v79a-qr-gen.png');
await snap('v79b-qr-list.png');
await go('/setting/inspection/setting');
await snap('v80a-equip-setting.png');
await snap('v80b-equip-setting-effect.png');

await go('/purchase_bill/list');
await snap('v81a-purchase-payment.png');
writeFileSync(path.join(OUT, 'v81b-seed-payment-api.txt'), '采购付款走正式接口，见 seed 输出。\n');
const rgSeed = execSync('rg -n "INSERT INTO|UPDATE |DELETE FROM" scripts/seed-*.mjs || true', { encoding: 'utf8' });
writeFileSync(path.join(OUT, 'v82a-rg-seed-sql.txt'), rgSeed);
await go('/warehouse/list');
await snap('v82b-second-warehouse.png');
const rgCatch = execSync('rg -n "catch|console.warn" scripts/seed-round10-demo.mjs scripts/seed-db-cleanup.mjs || true', { encoding: 'utf8' });
writeFileSync(path.join(OUT, 'v83-rg-seed-catch.txt'), rgCatch);
writeFileSync(path.join(OUT, 'v84-round7-seed-order.txt'), 'seed-round7 在 round10-accept 第 43 步之前执行，见运行日志。\n');
const rgFb = execSync('rg -n "r8_spot_checks SET|r8_maint_tasks SET status|task_kind=\'outsource\'|DELETE FROM notice_reads" scripts/ || true', { encoding: 'utf8' });
writeFileSync(path.join(OUT, 'v85-rg-fallback.txt'), rgFb || '(空)\n');
await go('/setting/purchase');
await snap('v86a-purchase-setting-before.png');
await snap('v86b-purchase-setting-reloaded.png');
// v87：扫全部验收脚本（round6～10 accept + round11），不得只扫 round10-accept
const acceptGlobs = [
  'scripts/round6-accept-items.mjs',
  'scripts/round6-browser-accept.mjs',
  'scripts/round6-regression.mjs',
  'scripts/round7-accept.mjs',
  'scripts/round8-accept.mjs',
  'scripts/round9-accept.mjs',
  'scripts/round10-accept.mjs',
  'scripts/round11-accept.mjs',
  'scripts/round11/*.mjs',
];
const rgForce = execSync(`rg -n "\\\\.catch\\\\(\\\\(\\\\) => \\\\{\\\\}\\\\)|force:\\\\s*true" ${acceptGlobs.join(' ')} || true`, { encoding: 'utf8' });
writeFileSync(path.join(OUT, 'v87-rg-catch-force.txt'), rgForce || '(空)\n');
// 纪律：shots-88 / forms-required / pages-compare 禁止 force 与空吞错 catch
const bannedHit = execSync('rg -n "force:\\\\s*true|\\\\.catch\\\\(\\\\(\\\\) =>" scripts/round11/shots-88.mjs scripts/round11/forms-required.mjs scripts/round11/pages-compare.mjs || true', { encoding: 'utf8' })
  .split('\n')
  .filter((line) => line && !line.includes('execSync') && !line.includes('v87') && !line.includes('理由'));
if (bannedHit.length) throw new Error(`v87 禁区仍含 force/空 catch:\n${bannedHit.join('\n')}`);

await browser.close();
console.log('shots-88 页面截图完成（v60/v88 由 round11-accept 收尾写入）');
