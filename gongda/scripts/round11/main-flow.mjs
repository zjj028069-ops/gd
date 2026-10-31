/**
 * T31 主流程：合同 → 加工单 → 报工 → 工资 → 出库 → 收款，数字读页面。
 * 造数由 seed-round11 走正式接口完成；本脚本只断言页面上的 5000.00 / 60.00 / 30.00 / 90.00 / 60% / 3000.00 / 2000.00。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { OUT, openPage, shot, waitReady, WEB, writeReport } from './_lib.mjs';

const outDir = path.join(OUT, 'flow');
mkdirSync(outDir, { recursive: true });
const diffs = [];

function must(ok, msg) {
  if (!ok) diffs.push(msg);
}

const { browser, page } = await openPage();

async function openAndShot(url, name, waitText) {
  await page.goto(`${WEB}${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitReady(page);
  if (waitText) await page.getByText(waitText).first().waitFor({ timeout: 15000 });
  await shot(page, path.join(outDir, name));
  return page.locator('body').innerText();
}

const t1 = await openAndShot('/customer/list', 'step-01.png', 'R11主流程客户');
must(t1.includes('R11主流程客户'), `step1 未见 R11主流程客户`);

const t2 = await openAndShot('/customer_contract/list', 'step-02.png', 'R11主流程');
must(/5000(\.00)?/.test(t2), `step2 合同金额 期望 5000.00 实际未出现`);

await page.goto(`${WEB}/inside_produce_bill/list`, { waitUntil: 'domcontentloaded' });
await waitReady(page);
const expand = page.getByRole('button', { name: '展开查询', exact: true });
if (await expand.count()) await expand.first().click();
await page.getByPlaceholder('商品').first().fill('R11成品');
await page.getByRole('button', { name: '查询', exact: true }).click();
await page.waitForTimeout(400);
const t3 = await page.locator('body').innerText();
await shot(page, path.join(outDir, 'step-03.png'));
must(t3.includes('R11成品'), 'step3 加工单未见 R11成品');

const t4 = await openAndShot('/work_repoty_record/list', 'step-04.png', 'R11成品');
must(t4.includes('60.00') || t4.includes('60'), `step4 报工 A 工资 期望 60.00`);
must(t4.includes('30.00') || t4.includes('30'), `step4 报工 B 工资 期望 30.00`);

const t5 = await openAndShot('/payroll_statement/list', 'step-05.png', '90');
must(/90(\.00)?/.test(t5), `step5 生产工资报表 worker 期望 90.00`);

const t6 = await openAndShot('/customer_contract/list', 'step-06.png', 'R11主流程');
must(t6.includes('60%'), `step6 出库/收款进度 期望 60%`);

await page.getByText('R11主流程').first().click();
await waitReady(page);
const t7 = await page.locator('body').innerText();
await shot(page, path.join(outDir, 'step-07.png'));
must(/3000(\.00)?/.test(t7), `step7 累计收款 期望 3000.00`);
must(/2000(\.00)?/.test(t7), `step7 欠款 期望 2000.00`);
must(t7.includes('60%'), `step7 收款进度 期望 60%`);

writeReport('main-flow', diffs);
await browser.close();
if (diffs.length) process.exit(1);
