import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const api = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const outDir = path.join(process.cwd(), 'docs/verification/round5-polish');
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

async function main() {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(page);

  await page.goto(`${base}/salesReturnOrder/list`);
  await page.waitForTimeout(1200);
  await shot(page, '01-销售退货列表-提交后');

  await page.goto(`${base}/purchase_order/list`);
  await page.waitForTimeout(1200);
  await shot(page, '02-采购单-退货金额欠款');

  await page.goto(`${base}/customer_contract/list`);
  await page.waitForTimeout(1200);
  await shot(page, '03-合同列表-出库进度');

  await page.goto(`${base}/setting/stock/setting`);
  await page.waitForTimeout(800);
  await shot(page, '04-成品入库数量限制');

  await page.goto(`${base}/stock_taking_bill/list`);
  await page.waitForTimeout(800);
  await shot(page, '05-盘点确定后');

  await page.goto(`${base}/setting/stock/audit_setting`);
  await page.waitForTimeout(800);
  await shot(page, '06-采购入库审核');

  await page.goto(`${base}/stock_item/list`);
  await page.waitForTimeout(1200);
  await shot(page, '07-出入库流水');

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
