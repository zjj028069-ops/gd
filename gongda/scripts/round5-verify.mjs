import { chromium } from 'playwright';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const base = 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/round5');
const creds = { user: 'admin.local', pass: 'A_hhejH-MwXdQOYxPsmJyKUEZKWoIpJyYmzdQwLm3b0' };

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('saved', file);
}

async function login(page) {
  await page.goto(base + '/login');
  const inputs = await page.locator('input').all();
  if (inputs.length >= 3) {
    await inputs[0].fill('demo-a');
    await inputs[1].fill(creds.user);
    await inputs[2].fill(creds.pass);
  }
  await page.getByRole('button', { name: /登录工作空间/ }).click();
  await page.waitForURL(/inside_produce|goods_stock|customer|ware/, { timeout: 45000 }).catch(() => page.waitForTimeout(3000));
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(page);

  await page.goto(base + '/ware/list');
  await page.waitForTimeout(1500);
  await shot(page, '01-warehouse-list');

  await page.goto(base + '/setting/stock/setting');
  await page.waitForTimeout(1500);
  await shot(page, '02-stock-setting');

  await page.goto(base + '/purchase_stock_in_bill/list');
  await page.waitForTimeout(1500);
  await shot(page, '03-purchase-receipt-list');

  await page.goto(base + '/goods_stock/list');
  await page.waitForTimeout(1500);
  await shot(page, '16-stock-mgmt');

  await page.goto(base + '/stock_item/list');
  await page.waitForTimeout(1500);
  await shot(page, '16-ledger');

  await page.goto(base + '/setting/stock/audit_setting');
  await page.waitForTimeout(1500);
  await shot(page, '17-audit-setting');

  await page.goto(base + '/purchase_order/list');
  await page.waitForTimeout(2000);
  await shot(page, '06-purchase-inbound-link');

  await page.goto(base + '/customer_contract/list');
  await page.waitForTimeout(2000);
  await shot(page, '08-contract-outbound-link');

  await browser.close();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
