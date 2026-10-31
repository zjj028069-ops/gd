import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'http://127.0.0.1:5183';
const OUT = path.resolve('strategy/module-compare-2026-10-14/shots');
fs.mkdirSync(OUT, { recursive: true });

const tenant = process.env.KGD_TENANT;
const user = process.env.KGD_USER;
const pass = process.env.KGD_PASS;

const pages = [
  { name: '01-workplace', path: '/staging/area' },
  { name: '02-customer-list', path: '/customer/list' },
  { name: '03-goods-list', path: '/goods/list' },
  { name: '04-bom-list', path: '/bom/list' },
  { name: '05-work-orders', path: '/inside_produce_bill/list' },
  { name: '06-purchase', path: '/purchase_order/list' },
  { name: '07-warehouse-stock', path: '/stock/list' },
  { name: '08-report-machine', path: '/drilling_crew_statement/list' },
  { name: '09-screen-manage', path: '/screen_management/list' },
  { name: '10-system-org', path: '/organization/list' },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await context.newPage();
page.setDefaultTimeout(25000);

const log = [];
function note(s) { console.log(s); log.push(s); }

try {
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  // fill login - try common selectors
  const inputs = await page.locator('input').all();
  note('login inputs count=' + inputs.length);
  // dump placeholders
  for (const inp of inputs) {
    const ph = await inp.getAttribute('placeholder');
    const name = await inp.getAttribute('name');
    const type = await inp.getAttribute('type');
    note(`input name=${name} type=${type} ph=${ph}`);
  }
  // Heuristic fill
  const tenantBox = page.locator('input[placeholder*="企业"], input[name*="tenant"], input[placeholder*="标识"]').first();
  const userBox = page.locator('input[placeholder*="账号"], input[placeholder*="用户"], input[name*="user"], input[type="text"]').first();
  const passBox = page.locator('input[type="password"]').first();
  if (await tenantBox.count()) await tenantBox.fill(tenant);
  // If multiple text inputs, fill carefully
  const textInputs = page.locator('input:not([type="password"]):not([type="hidden"])');
  const n = await textInputs.count();
  if (n >= 2) {
    await textInputs.nth(0).fill(tenant);
    await textInputs.nth(1).fill(user);
  } else if (n === 1) {
    await textInputs.nth(0).fill(user);
  }
  await passBox.fill(pass);
  await page.screenshot({ path: path.join(OUT, '00-login.png'), fullPage: false });
  // click login
  const btn = page.locator('button:has-text("登录"), button:has-text("登 录"), button[type="submit"]').first();
  await btn.click();
  await page.waitForTimeout(2000);
  // wait for navigation away from login
  try {
    await page.waitForURL(u => !String(u).includes('/login'), { timeout: 15000 });
  } catch (e) {
    note('login wait failed: ' + e.message);
    await page.screenshot({ path: path.join(OUT, '00-login-fail.png'), fullPage: false });
    const body = await page.locator('body').innerText().catch(()=> '');
    note('body snippet: ' + body.slice(0, 300));
  }
  note('after login url=' + page.url());
  await page.screenshot({ path: path.join(OUT, '00-after-login.png'), fullPage: false });

  for (const item of pages) {
    try {
      await page.goto(BASE + item.path, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
      const shot = path.join(OUT, item.name + '.png');
      await page.screenshot({ path: shot, fullPage: false });
      const title = await page.title();
      const h = await page.locator('h1,h2,h3,.kgd-page-title,.ant-breadcrumb').first().innerText().catch(()=> '');
      note(`OK ${item.name} url=${page.url()} title=${title} head=${h.slice(0,80)}`);
    } catch (e) {
      note(`FAIL ${item.name}: ${e.message}`);
      await page.screenshot({ path: path.join(OUT, item.name + '-fail.png'), fullPage: false }).catch(()=>{});
    }
  }

  // Try open a data screen if listed
  try {
    await page.goto(BASE + '/screen_management/list', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const row = page.locator('table tbody tr').first();
    if (await row.count()) {
      const previewBtn = page.locator('button:has-text("预览"), a:has-text("预览"), button:has-text("打开")').first();
      if (await previewBtn.count()) {
        const [popup] = await Promise.all([
          context.waitForEvent('page', { timeout: 8000 }).catch(()=>null),
          previewBtn.click(),
        ]);
        if (popup) {
          await popup.waitForLoadState('domcontentloaded');
          await popup.waitForTimeout(1500);
          await popup.screenshot({ path: path.join(OUT, '11-screen-preview.png'), fullPage: false });
          note('OK screen preview ' + popup.url());
          await popup.close();
        } else {
          await page.screenshot({ path: path.join(OUT, '11-screen-preview-same.png'), fullPage: false });
          note('screen preview same tab ' + page.url());
        }
      } else {
        note('no preview button on screen manage');
      }
    } else {
      note('no screen rows');
    }
  } catch (e) {
    note('screen preview fail: ' + e.message);
  }
} finally {
  fs.writeFileSync(path.join(OUT, 'shot-log.txt'), log.join('\n'), 'utf8');
  await browser.close();
}
