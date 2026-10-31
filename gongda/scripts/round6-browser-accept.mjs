import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const base = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const outDir = path.join(process.cwd(), 'docs/verification/round6');
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('saved', name);
}

async function login(page) {
  await page.goto(`${base}/login`);
  await page.waitForSelector('input', { timeout: 20000 });
  const inputs = page.locator('input');
  await inputs.nth(0).fill('demo-a');
  await inputs.nth(1).fill('admin.local');
  await inputs.nth(2).fill(pass);
  await page.getByRole('button', { name: /登录工作空间/ }).click();
  await page.waitForURL(/inside_produce|ProductionPlan|goods_stock/, { timeout: 60000 }).catch(() => page.waitForTimeout(4000));
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(page);

  await page.goto(`${base}/ProductionPlan/list`);
  await page.waitForTimeout(1200);
  await shot(page, 'v01-production-plan-list');

  await page.goto(`${base}/inside_produce_bill/list`);
  await page.waitForTimeout(1500);
  await shot(page, 'v04-work-order-list');

  await page.goto(`${base}/productionTask/list`);
  await page.waitForTimeout(1200);
  await shot(page, 'v12-production-tasks');

  await page.goto(`${base}/ProductionScheduling/list`);
  await page.waitForTimeout(1500);
  await shot(page, 'v13-scheduling');

  await page.goto(`${base}/output_statistics_report`);
  await page.waitForTimeout(1200);
  await shot(page, 'v14-output-report');

  await page.goto(`${base}/articles_being_processed_report`);
  await page.waitForTimeout(1200);
  await shot(page, 'v15-wip-report');

  await page.goto(`${base}/screen_management/list`);
  await page.waitForTimeout(1200);
  await shot(page, 'v17-screen-manage');

  await page.goto(`${base}/work_repoty_record/list`);
  await page.waitForTimeout(1500);
  await shot(page, 'r01-wage-750-regression');

  await page.goto(`${base}/customer_contract/list`);
  await page.waitForTimeout(1500);
  await shot(page, 'r02-contract-debt-9000');

  await browser.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
