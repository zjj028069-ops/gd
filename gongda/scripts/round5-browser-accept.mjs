import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/round5');
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('saved', name);
}

async function login(page) {
  await page.goto(`${base}/login`);
  await page.waitForSelector('input', { timeout: 15000 });
  const inputs = page.locator('input');
  await inputs.nth(0).fill('demo-a');
  await inputs.nth(1).fill('admin.local');
  await inputs.nth(2).fill(pass);
  await page.getByRole('button', { name: /登录工作空间/ }).click();
  await page.waitForURL(/inside_produce|goods_stock|purchase_order|ware/, { timeout: 45000 }).catch(() => page.waitForTimeout(3000));
}

async function openAddModal(page) {
  const add = page.getByRole('button', { name: '+ 新增' }).first();
  if (await add.count()) await add.click();
  else await page.locator('button', { hasText: '新增' }).first().click();
  await page.waitForTimeout(800);
}

async function main() {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(page);

  await page.goto(`${base}/ware/list`);
  await page.waitForTimeout(1000);
  await shot(page, 's01-仓库管理');

  await page.goto(`${base}/setting/stock/setting`);
  await page.waitForTimeout(1000);
  await shot(page, 's02-仓库基础设置');

  await page.goto(`${base}/purchase_stock_in_bill/list`);
  await page.waitForTimeout(1000);
  await shot(page, 's03-采购入库单列表');

  await page.goto(`${base}/purchase_order/list`);
  await page.waitForTimeout(1200);
  const inbound = page.locator('button.kgd-link', { hasText: /^入库\(/ }).first();
  if (await inbound.count()) {
    await inbound.click();
    await page.waitForTimeout(1000);
    await shot(page, 's06-采购入库弹窗');
    await page.keyboard.press('Escape');
  }

  await page.goto(`${base}/purchase_return_bill/list`);
  await openAddModal(page);
  await shot(page, 's07-采购退货弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/customer_contract/list`);
  await page.waitForTimeout(1200);
  const outbound = page.locator('button.kgd-link', { hasText: /^出库/ }).first();
  if (await outbound.count()) {
    await outbound.click();
    await page.waitForTimeout(1000);
    await shot(page, 's08-合同出库弹窗');
    await page.keyboard.press('Escape');
  }
  await shot(page, 's08b-合同列表出库进度');

  await page.goto(`${base}/produce_stock_in_bill/list`);
  await openAddModal(page);
  await shot(page, 's11a-成品入库弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/production_out_of_storage/list`);
  await openAddModal(page);
  await shot(page, 's11b-生产出库弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/semi_finished_products_stock_in_bill/list`);
  await openAddModal(page);
  await shot(page, 's12a-半成品入库弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/produce_return_materiel_bill/list`);
  await openAddModal(page);
  await shot(page, 's12b-生产退料弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/else_stock_in_bill/list`);
  await openAddModal(page);
  await shot(page, 's13a-其他入库弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/else_stock_out_bill/list`);
  await openAddModal(page);
  await shot(page, 's13b-其他出库弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/stock_allocate_bill/list`);
  await openAddModal(page);
  await shot(page, 's14-调拨弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/stock_taking_bill/list`);
  await openAddModal(page);
  await shot(page, 's15a-自定义盘库弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/salesReturnOrder/list`);
  await openAddModal(page);
  await shot(page, 's10-销售退货弹窗');
  await page.keyboard.press('Escape');

  await page.goto(`${base}/goods_stock/list`);
  await page.waitForTimeout(1000);
  await shot(page, 's16a-仓库库存');
  await page.getByRole('button', { name: '商品库存' }).click().catch(() => page.locator('.wh-stock-tabs button').nth(1).click());
  await page.waitForTimeout(600);
  await shot(page, 's16b-商品库存');
  await page.locator('.wh-stock-tabs button').filter({ hasText: '下限报警' }).click().catch(() => {});
  await page.waitForTimeout(600);
  await shot(page, 's16c-下限报警');

  await page.goto(`${base}/stock_item/list`);
  await page.waitForTimeout(1000);
  await shot(page, 's16d-出入库流水');

  await page.goto(`${base}/setting/stock/audit_setting`);
  await page.waitForTimeout(1000);
  await shot(page, 's17-审核设置');

  await page.goto(`${base}/customer_contract/list`);
  await page.waitForTimeout(1200);
  await shot(page, 'r04-合同欠款9000');

  await page.goto(`${base}/work_repoty_record/list`);
  await page.waitForTimeout(1200);
  await shot(page, 'r01-报工工资750');

  await browser.close();
  console.log('browser acceptance screenshots done');
}

main().catch((e) => { console.error(e); process.exit(1); });
