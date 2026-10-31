import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
const BASE='http://127.0.0.1:5183';
const OUT=path.resolve('strategy/module-compare-2026-10-14/shots');
const tenant=process.env.KGD_TENANT, user=process.env.KGD_USER, pass=process.env.KGD_PASS;
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},locale:'zh-CN'});
const page=await context.newPage();
page.setDefaultTimeout(25000);
await page.goto(BASE+'/login',{waitUntil:'networkidle'});
const textInputs=page.locator('input:not([type="password"]):not([type="hidden"])');
await textInputs.nth(0).fill(tenant);
await textInputs.nth(1).fill(user);
await page.locator('input[type="password"]').fill(pass);
await page.locator('button:has-text("登录")').click();
await page.waitForURL(u=>!String(u).includes('/login'),{timeout:15000});

const extra=[
  {name:'10b-system-users', path:'/account/list'},
  {name:'10c-system-enterprise', path:'/setting/enterprise'},
  {name:'10d-audit-flow', path:'/audit_process/list'},
  {name:'12-lean-meeting', path:'/meeting/list'},
  {name:'13-scheduling', path:'/production_scheduling'},
];
for (const item of extra) {
  try {
    await page.goto(BASE+item.path,{waitUntil:'networkidle',timeout:30000});
    await page.waitForTimeout(1000);
    await page.screenshot({path:path.join(OUT,item.name+'.png')});
    console.log('OK', item.name, page.url());
  } catch(e) { console.log('FAIL', item.name, e.message); }
}

// customer map modal
await page.goto(BASE+'/customer/list',{waitUntil:'networkidle'});
await page.waitForTimeout(800);
const mapBtn=page.locator('button:has-text("地图视图")');
if (await mapBtn.count()) {
  await mapBtn.click();
  await page.waitForTimeout(500);
  await page.screenshot({path:path.join(OUT,'02b-customer-map-modal.png')});
  console.log('OK map modal');
  await page.keyboard.press('Escape');
}

// screen manage - click 设计 or row link / open screen
await page.goto(BASE+'/screen_management/list',{waitUntil:'networkidle'});
await page.waitForTimeout(1000);
const design=page.locator('button:has-text("设计"), a:has-text("设计")').first();
const view=page.locator('button:has-text("查看"), a:has-text("查看"), button:has-text("预览")').first();
console.log('design count', await design.count(), 'view', await view.count());
// list row text
const rows=await page.locator('table tbody tr').allTextContents();
console.log('screen rows', rows.slice(0,8).map(t=>t.replace(/\s+/g,' ').slice(0,80)));
await page.screenshot({path:path.join(OUT,'09b-screen-manage-detail.png')});

// Try open screen via API-known path pattern /_screen/pd/:id
const apiScreens=await page.evaluate(async()=>{
  const r=await fetch('/api/data-screens');
  return {status:r.status, body:await r.text()};
});
console.log('data-screens', apiScreens.status, apiScreens.body.slice(0,400));
let screens=[];
try { screens=JSON.parse(apiScreens.body).items||JSON.parse(apiScreens.body)||[]; } catch{}
if (!Array.isArray(screens) && screens.items) screens=screens.items;
if (Array.isArray(screens) && screens[0]) {
  const id=screens[0].id;
  const name=screens[0].menu_name||screens[0].name;
  console.log('open screen', name, id);
  const [popup]=await Promise.all([
    context.waitForEvent('page',{timeout:10000}).catch(()=>null),
    page.evaluate((id)=>{ window.open('/_screen/pd/'+id,'_blank'); }, id),
  ]);
  const target=popup||page;
  if (popup) { await popup.waitForLoadState('domcontentloaded'); await popup.waitForTimeout(2000); await popup.screenshot({path:path.join(OUT,'11-control-screen.png')}); console.log('OK popup', popup.url()); await popup.close(); }
  else { await page.goto(BASE+'/_screen/pd/'+id,{waitUntil:'networkidle'}); await page.waitForTimeout(2000); await page.screenshot({path:path.join(OUT,'11-control-screen.png')}); console.log('OK same', page.url()); }
}

await browser.close();
