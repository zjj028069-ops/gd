import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
const BASE='http://127.0.0.1:5183';
const OUT=path.resolve('strategy/module-compare-2026-10-14/shots');
const tenant=process.env.KGD_TENANT, user=process.env.KGD_USER, pass=process.env.KGD_PASS;
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.goto(BASE+'/login',{waitUntil:'networkidle'});
const textInputs=page.locator('input:not([type="password"]):not([type="hidden"])');
await textInputs.nth(0).fill(tenant); await textInputs.nth(1).fill(user);
await page.locator('input[type="password"]').fill(pass);
await page.locator('button:has-text("登录")').click();
await page.waitForURL(u=>!String(u).includes('/login'),{timeout:15000});
const extra=[
  {name:'10e-user-list', path:'/user/list'},
  {name:'10f-enterprise', path:'/setting/enterprise/setting'},
  {name:'10g-roles', path:'/role/list'},
  {name:'13b-scheduling', path:'/produce_schedule/list'},
  {name:'14-customer-sea', path:'/customer_sea/list'},
  {name:'15-linkman', path:'/linkman/list'},
];
// discover scheduling from menu if needed
for (const item of extra) {
  await page.goto(BASE+item.path,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForTimeout(1200);
  await page.screenshot({path:path.join(OUT,item.name+'.png')});
  console.log(item.name, page.url());
}
// toolbar texts for key pages
for (const p of ['/customer/list','/linkman/list','/inside_produce_bill/list','/ProductionPlan/list','/sales_statement']) {
  await page.goto(BASE+p,{waitUntil:'networkidle'});
  await page.waitForTimeout(800);
  const texts=await page.locator('.kgd-toolbar button, .kgd-toolbar-end button, .ant-btn').allTextContents();
  console.log('TOOLBAR', p, texts.map(t=>t.trim()).filter(Boolean).slice(0,25));
}
await browser.close();
