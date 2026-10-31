import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { frozenRouteVersionId, reusableSales, reusableWorkOrder } from '../../../scripts/sample-mainline.mjs';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database, app: FastifyInstance;
const persistPath=resolve(import.meta.dirname,'../../../.local/persistence-tests/value-'+randomUUID());
mkdirSync(dirname(persistPath),{recursive:true});
const ta = randomUUID(), tb = randomUUID();
const admin = randomUUID(), planner = randomUUID(), worker = randomUUID();
const unit = randomUUID();
const password = 'Mainline-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login, b: Login, p: Login, w: Login;
let loginSequence = 1;
const headers = (s: Login, write = false) => ({ cookie: s.cookie, ...(write ? { 'x-csrf-token': s.csrf } : {}) });
const code = (prefix: string) => prefix + '-' + randomUUID().slice(0, 8);
const key = () => randomUUID();

async function login(slug: string, name = 'line.admin') {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.' + (loginSequence++ % 200), payload: { tenant_slug: slug, username: name, password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  assert.ok(raw);
  return { cookie: (Array.isArray(raw) ? raw[0]! : raw).split(';')[0]!, csrf: response.json().csrf_token };
}
async function get(url: string, s = a, expected = 200) {
  const response = await app.inject({ url, headers: headers(s) });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function post(url: string, body: unknown, s = a, expected = 201) {
  const response = await app.inject({ method: 'POST', url, headers: headers(s, true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function patch(url: string, body: unknown, s = a, expected = 200) {
  const response = await app.inject({ method: 'PATCH', url, headers: headers(s, true), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function act(url: string, body: unknown, s = a, expected = 200) {
  return post(url, body, s, expected);
}

let fg: { id: string; code: string; name: string }, steel: { id: string }, caster: { id: string }, board: { id: string };
let routeVersionId = '', bomVersionId = '', bomId = '', customerId = '', firstProcess = '';

async function warehouse() {
  return (await post('/api/warehouses', { request_key: key(), code: code('WH'), name: '测试仓' })).warehouse as { id: string };
}
async function customer() {
  return (await post('/api/customers', { request_key: key(), code: code('CU'), name: '测试客户' })).customer as { id: string; version: number };
}
async function openSales(quantity: string, price = '40') {
  const created = await post('/api/sales-orders', { request_key: key(), customer_id: customerId, lines: [{ product_id: fg.id, quantity, unit_price: price }] });
  const submitted = await act('/api/sales-orders/' + created.order.id + '/actions', { action: 'submit', version: created.order.version });
  return (await act('/api/sales-orders/' + created.order.id + '/actions', { action: 'approve', version: submitted.order.version })).order;
}
async function makeWo(lineId: string, quantity: string, wh: string, extra: Record<string, unknown> = {}) {
  return (await post('/api/work-orders', { request_key: key(), sales_line_id: lineId, quantity, route_version_id: routeVersionId, bom_version_id: bomVersionId, warehouse_id: wh, ...extra })).work_order;
}
async function stockIn(wh: string, productId: string, quantity: string, reason = '期初入库，不是采购收货') {
  const created = await post('/api/stock-adjustments', { request_key: key(), warehouse_id: wh, product_id: productId, direction: 'in', quantity, reason });
  return (await act('/api/stock-adjustments/' + created.stock_adjustment.id + '/actions', { action: 'approve', version: created.stock_adjustment.version, request_key: key() })).stock_adjustment;
}
async function issue(wo: { id: string; warehouse_id: string; materials: { id: string; required_qty: string }[] }, lines?: { material_id: string; quantity: string }[]) {
  const created = await post('/api/material-issues', { request_key: key(), work_order_id: wo.id, warehouse_id: wo.warehouse_id, lines: lines ?? wo.materials.map((row) => ({ material_id: row.id, quantity: row.required_qty })) });
  return created.material_issue as { id: string; version: number; approval: string; posted: boolean };
}
async function approveIssue(row: { id: string; version: number }) {
  return (await act('/api/material-issues/' + row.id + '/actions', { action: 'approve', version: row.version, request_key: key() })).material_issue;
}
async function onHand(wh: string, productId: string) {
  const found = (await get('/api/stock/balances')).items.find((row: { warehouse_id: string; product_id: string; on_hand: string }) => row.warehouse_id === wh && row.product_id === productId);
  return found?.on_hand ?? '0.000000';
}
async function reload(id: string) {
  return (await get('/api/work-orders/' + id)).work_order;
}
async function reportGood(taskId: string, quantity: string, session = a, extra: Record<string, unknown> = {}) {
  const body = { request_key: key(), task_id: taskId, good_qty: quantity, defect_qty: '0', rework_qty: '0', scrap_qty: '0', ...extra };
  if (session === a && body.operator_id === undefined) body.operator_id = worker;
  return post('/api/production-reports', body, session);
}
async function approveReport(id: string, version = 1) {
  return (await act('/api/production-reports/' + id + '/actions', { action: 'approve', version, request_key: key() })).report;
}
async function member(id: string) {
  return (await get('/api/platform/members')).items.find((row: { id: string }) => row.id === id);
}
async function updateMember(id: string, extra: Record<string, unknown>) {
  const old = await member(id);
  return patch('/api/platform/members/' + id, { version: old.version, display_name: old.display_name, role: old.role, active: old.active, department_id: old.department_id, custom_role_id: old.custom_role_id, ...extra });
}

before(async () => {
  db = new Database({ mode: 'pglite',dataDir:persistPath });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    for (const [id, slug] of [[ta, 'line-a'], [tb, 'line-b']]) await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [id, slug, slug]);
    for (const [id, name] of [[admin, 'line.admin'], [planner, 'line.planner'], [worker, 'line.worker']]) await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [id, name, name, hash]);
    for (const tenant of [ta, tb]) await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'planner')", [ta, planner]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')", [ta, worker]);
    await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','个')", [unit, ta]);
  });
  app = await createApp(db, { localEventsWorker: false });
  a = await login('line-a'); b = await login('line-b'); p = await login('line-a', 'line.planner'); w = await login('line-a', 'line.worker');
  fg = (await post('/api/products', { code: code('FG'), name: '机架成品', unit_id: unit, attribute: 'manufactured' })).product;
  steel = (await post('/api/products', { code: code('ST'), name: '钢板', unit_id: unit, attribute: 'purchased' })).product;
  caster = (await post('/api/products', { code: code('CA'), name: '脚轮', unit_id: unit, attribute: 'purchased' })).product;
  board = (await post('/api/products', { code: code('BD'), name: '板材', unit_id: unit, attribute: 'purchased' })).product;
  const processes = [];
  for (const name of ['下料', '焊接', '打磨', '总检']) processes.push((await post('/api/processes', { code: code('GX'), name, description: '主线测试', standard_minutes: '2.5', reporter_ids: [worker] })).process);
  firstProcess = processes[0].id;
  const route = (await post('/api/routes', { code: code('RT'), name: '四序主线', description: '串行', steps: processes.map((row) => ({ process_id: row.id, auto_inbound: row.id === processes[3].id })) })).route;
  routeVersionId = route.current_version_id;
  const bom = (await post('/api/boms', { parent_product_id: fg.id, description: '50件样例', route_version_id: routeVersionId, items: [
    { component_product_id: steel.id, quantity: '1.03', loss_rate: '0', feeding_process_id: firstProcess },
    { component_product_id: caster.id, quantity: '2', loss_rate: '0' },
    { component_product_id: board.id, quantity: '1', loss_rate: '0' },
  ] })).bom;
  bomId = bom.id; bomVersionId = bom.current_version_id;
  customerId = (await customer()).id;
});
after(async () => { await app?.close(); await db?.close(); });


test('M1完整金额主线：采购865→工资200→成品1065→分批销售2000→分笔收付，重试与冲销不重记',async()=>{
 const wh=(await warehouse()).id;
 const sale=await openSales('50'),wo=await makeWo(sale.lines[0].id,'50',wh,{requires_fg_inspection:true,require_cost:true});
 const supplier=(await post('/api/suppliers',{request_key:key(),code:code('SU'),name:'M1供应商'})).supplier;
 const mrp=(await post('/api/mrp-batches',{request_key:key(),work_order_id:wo.id})).mrp_batch;
 assert.deepEqual(mrp.lines.map((l:{shortage_qty:string})=>l.shortage_qty).sort(),['100.000000','50.000000','51.500000']);
 assert.equal(mrp.kit_ratio,'0.000000');
 const prices:Record<string,string>={[steel.id]:'10',[caster.id]:'2',[board.id]:'3'};
 const po=(await post('/api/purchase-orders',{request_key:key(),supplier_id:supplier.id,order_date:'2026-10-04',due_date:'2026-10-05',lines:mrp.lines.map((l:{id:string;product_id:string;shortage_qty:string})=>({product_id:l.product_id,quantity:l.shortage_qty,unit_price:prices[l.product_id],requires_inspection:true,mrp_line_id:l.id}))})).purchase_order;
 await act('/api/purchase-orders/'+po.id+'/actions',{request_key:key(),action:'approve',version:po.version});
 // 同一缺口不能重复转单
 await post('/api/purchase-orders',{request_key:key(),supplier_id:supplier.id,order_date:'2026-10-04',due_date:'2026-10-05',lines:[{product_id:steel.id,quantity:'1',unit_price:'10',requires_inspection:true,mrp_line_id:mrp.lines.find((l:{product_id:string})=>l.product_id===steel.id).id}]},a,409);
 const receipt=(await post('/api/purchase-receipts',{request_key:key(),order_id:po.id,warehouse_id:wh,lines:po.lines.map((l:{id:string;quantity:string})=>({purchase_line_id:l.id,quantity:l.quantity}))})).purchase_receipt;
 const approveKey=key(),body={request_key:approveKey,action:'approve',version:receipt.version};
 await act('/api/purchase-receipts/'+receipt.id+'/actions',body);
 assert.equal((await act('/api/purchase-receipts/'+receipt.id+'/actions',body)).replayed,true);
 let balance=(await get('/api/stock/balances')).items.filter((r:{warehouse_id:string})=>r.warehouse_id===wh);
 assert.equal(balance.find((r:{product_code:string})=>r.product_code===fg.code),undefined);
 for(const l of balance){assert.equal(l.available_qty,'0.000000');assert.equal(l.on_hand,l.held_qty);}
 const pendingIssue=await issue(wo);
 assert.equal((await act('/api/material-issues/'+pendingIssue.id+'/actions',{request_key:key(),action:'approve',version:pendingIssue.version},a,409)).error.code,'INSUFFICIENT_AVAILABLE_STOCK');
 const heldMrp=(await post('/api/mrp-batches',{request_key:key(),work_order_id:wo.id})).mrp_batch;
 assert.equal(heldMrp.kit_ratio,'0.000000');assert.ok(heldMrp.lines.every((l:{shortage_qty:string})=>l.shortage_qty==='0.000000'));
 const checks=(await get('/api/incoming-inspections')).items;
 for(const qc of checks)await act('/api/incoming-inspections/'+qc.id+'/actions',{request_key:key(),action:'complete',version:qc.version,conclusion:'pass',sample_qty:'1',sample_good:'1',sample_defect:'0',released_qty:qc.quantity,blocked_qty:'0'});
 const after=(await get('/api/stock/balances')).items.filter((r:{warehouse_id:string})=>r.warehouse_id===wh);
 for(const l of after){assert.equal(l.available_qty,l.on_hand);assert.equal(l.held_qty,'0.000000');}
 const ready=(await post('/api/mrp-batches',{request_key:key(),work_order_id:wo.id})).mrp_batch;
 assert.equal(ready.kit_ratio,'1.000000');
 await act('/api/mrp-batches/'+ready.id+'/actions',{request_key:key(),action:'reserve',version:ready.version});
 await approveIssue(pendingIssue);
 const rules=[];
 const processes=(await get('/api/processes')).items;
 for(const proc of processes)rules.push((await post('/api/wage-rules',{request_key:key(),code:code('WG'),mode:'piece',rate:'1',process_ids:[proc.id],product_id:fg.id})).wage_rule);
 await act('/api/work-orders/'+wo.id+'/actions',{action:'start',version:(await reload(wo.id)).version});
 const reportIds=[];
 for(let index=0;index<4;index++){
  let current=await reload(wo.id);
  let task=current.tasks.find((t:{execution:string})=>t.execution==='running');
  if(!task){const next=current.tasks.find((t:{execution:string})=>t.execution==='not_started');current=(await act('/api/work-orders/'+wo.id+'/tasks/'+next.id+'/actions',{action:'start',version:next.version})).work_order;task=current.tasks.find((t:{id:string})=>t.id===next.id);}
  const rp=(await reportGood(task.id,'50')).report;
  assert.equal(rp.estimated_wage,'50.00');reportIds.push(rp.id);
  // 已提交报工仍使用原规则版本
  if(index===0){
   const rule=rules.find((r:{process_ids:string[]})=>r.process_ids.includes(task.process_id));
   await act('/api/wage-rules/'+rule.id+'/revisions',{request_key:key(),version:rule.version,reason:'测试新工价只影响后续提交',code:rule.code,mode:'piece',rate:'2',product_id:fg.id,process_ids:rule.process_ids});
  }
  await approveReport(rp.id,rp.version);
 }
 const output=await reload(wo.id);assert.equal(output.output_qty,'50.000000');assert.equal(output.cost_status,'priced');
 const qc=(await post('/api/inspections',{request_key:key(),work_order_id:wo.id,inspected_qty:'50',good_qty:'50',defect_qty:'0'})).inspection;
 await act('/api/inspections/'+qc.id+'/actions',{action:'complete',version:qc.version,conclusion:'pass',request_key:key()});
 const costs=(await get('/api/work-orders/'+wo.id+'/costs')).cost;
 assert.equal(costs.material_amount,'865.00');assert.equal(costs.labor_amount,'200.00');assert.equal(costs.total_amount,'1065.00');
 const fgReceipt=(await post('/api/fg-receipts',{request_key:key(),work_order_id:wo.id,quantity:'50'})).fg_receipt;
 await act('/api/fg-receipts/'+fgReceipt.id+'/actions',{request_key:key(),action:'approve',version:fgReceipt.version});
 const wages=(await get('/api/wages')).items;assert.equal(wages.length,4);
 const settlement=(await post('/api/wage-settlements',{request_key:key(),event_ids:wages.map((r:{id:string})=>r.id),reason:'M1工资结算'})).wage_settlement;
 await post('/api/wage-settlements',{request_key:key(),event_ids:[wages[0].id],reason:'重复结算'},a,409);
 const sh1=(await post('/api/shipments',{request_key:key(),sales_order_id:sale.id,warehouse_id:wh,lines:[{sales_line_id:sale.lines[0].id,quantity:'20'}]})).shipment;
 await act('/api/shipments/'+sh1.id+'/actions',{request_key:key(),action:'approve',version:sh1.version});
 const middle=await get('/api/financial-summary');assert.equal(middle.receivable,'800.00');assert.equal(middle.sales_cost,'426.00');assert.equal(middle.inventory_value,'639.00');
 const sh2=(await post('/api/shipments',{request_key:key(),sales_order_id:sale.id,warehouse_id:wh,lines:[{sales_line_id:sale.lines[0].id,quantity:'30'}]})).shipment;
 const approved=(await act('/api/shipments/'+sh2.id+'/actions',{request_key:key(),action:'approve',version:sh2.version})).shipment;
 const reverse={request_key:key(),action:'reverse',version:approved.version,reason:'M1更正'};
 await act('/api/shipments/'+sh2.id+'/actions',reverse);assert.equal((await act('/api/shipments/'+sh2.id+'/actions',reverse)).replayed,true);
 assert.equal((await get('/api/financial-summary')).inventory_value,'639.00');assert.equal((await get('/api/financial-summary')).receivable,'800.00');
 const sh3=(await post('/api/shipments',{request_key:key(),sales_order_id:sale.id,warehouse_id:wh,lines:[{sales_line_id:sale.lines[0].id,quantity:'30'}]})).shipment;
 const approved3=(await act('/api/shipments/'+sh3.id+'/actions',{request_key:key(),action:'approve',version:sh3.version})).shipment;
 const items=(await get('/api/open-items')).items.filter((r:{reversed:boolean})=>!r.reversed);
 async function payment(kind:string,party:string,amount:string,allocations:unknown[]){
  const pay=(await post('/api/payments',{request_key:key(),kind,party_id:party,amount,payment_date:'2026-10-04',method:'bank',allocations})).payment;
  const b={request_key:key(),action:'approve',version:pay.version};await act('/api/payments/'+pay.id+'/actions',b);assert.equal((await act('/api/payments/'+pay.id+'/actions',b)).replayed,true);return pay;
 }
 const ap=items.filter((r:{kind:string})=>r.kind==='payable');
 const steelAP=ap.find((r:{amount:string})=>r.amount==='515.00');
 await payment('payable',supplier.id,'515',[{open_item_id:steelAP.id,amount:'515'}]);assert.equal((await get('/api/financial-summary')).payable_outstanding,'350.00');
 await payment('payable',supplier.id,'350',ap.filter((r:{id:string})=>r.id!==steelAP.id).map((r:{id:string;amount:string})=>({open_item_id:r.id,amount:r.amount})));
 const ar=items.filter((r:{kind:string})=>r.kind==='receivable'),firstAR=ar.find((r:{amount:string})=>r.amount==='800.00'),lastAR=ar.find((r:{amount:string})=>r.amount==='1200.00');
 await payment('receivable',customerId,'800',[{open_item_id:firstAR.id,amount:'800'}]);assert.equal((await get('/api/financial-summary')).receivable_outstanding,'1200.00');
 const lastPay=await payment('receivable',customerId,'1200',[{open_item_id:lastAR.id,amount:'1200'}]);
 assert.equal((await act('/api/shipments/'+approved3.id+'/actions',{request_key:key(),action:'reverse',version:approved3.version,reason:'有收款不能直接冲销'},a,409)).error.code,'DOWNSTREAM_EXISTS');
 const final=await get('/api/financial-summary');
 assert.deepEqual([final.receivable,final.sales_cost,final.gross_profit,final.gross_margin_percent,final.wage,final.inventory_value,final.payable_outstanding,final.receivable_outstanding,final.process_good_qty,final.finished_receipt_qty],['2000.00','1065.00','935.00','46.75','200.00','0.00','0.00','0.00','200.000000','50.000000']);
 await act('/api/payments/'+lastPay.id+'/actions',{request_key:key(),action:'reverse',version:lastPay.version+1,reason:'测试款项冲销'});
 assert.equal((await get('/api/financial-summary')).receivable_outstanding,'1200.00');
 assert.equal((await get('/api/financial-summary')).receivable,'2000.00');
 assert.equal((await get('/api/wages')).items.length,4);
 await get('/api/wages',w,403);await get('/api/payments',w,403);assert.equal((await get('/api/purchase-orders/'+po.id,b,404)).error.code,'NOT_FOUND');
 await db.tenant({tenantId:tb,userId:admin},async sql=>assert.equal((await sql.query('SELECT id FROM wage_events')).rows.length,0));
 assert.equal((await get('/api/wage-settlements/'+settlement.id)).wage_settlement.state,'approved');
});

test('N1返工与追加物料守恒：100投入、90良10坏，返工6、报废4，新增投入4得到100净合格，操作110不当成产出',async()=>{
 const wh=(await warehouse()).id,sale=await openSales('100'),wo=await makeWo(sale.lines[0].id,'100',wh);
 for(const m of wo.materials)await stockIn(wh,m.product_id,m.required_qty);
 await approveIssue(await issue(wo));await act('/api/work-orders/'+wo.id+'/actions',{action:'start',version:(await reload(wo.id)).version});
 const first=(await reload(wo.id)).tasks[0],source=(await reportGood(first.id,'90',a,{defect_qty:'10',rework_qty:'6',scrap_qty:'4',defect_note:'N1分流'})).report;
 await approveReport(source.id,source.version);
 const repair=(await post('/api/rework-reports',{request_key:key(),source_report_id:source.id,operator_id:worker,good_qty:'6',defect_qty:'0',reason:'修复原6件不良'})).rework;
 await act('/api/rework-reports/'+repair.id+'/actions',{request_key:key(),action:'approve',version:repair.version});
 assert.equal((await reload(wo.id)).tasks[0].approved_good,'96.000000');
 await post('/api/rework-reports',{request_key:key(),source_report_id:source.id,operator_id:worker,good_qty:'1',defect_qty:'0',reason:'重复引用'},a,422);
 await post('/api/production-supplements',{request_key:key(),task_id:first.id,quantity:'5',reason:'超报废'},a,422);
 const supplement=(await post('/api/production-supplements',{request_key:key(),task_id:first.id,quantity:'4',reason:'以新料补足已报废4件'})).supplement;
 // 尚未审核领料不能扩大投入。
 assert.equal((await post('/api/production-reports',{request_key:key(),task_id:first.id,operator_id:worker,good_qty:'4',defect_qty:'0',rework_qty:'0',scrap_qty:'0',supplement_id:supplement.id},a,422)).error.code,'SUPPLEMENT_SOURCE_REQUIRED');
 for(const l of supplement.lines)await stockIn(wh,l.product_id,l.quantity);
 const approved=(await act('/api/production-supplements/'+supplement.id+'/actions',{request_key:key(),action:'approve',version:supplement.version})).supplement;
 const extra=(await reportGood(first.id,'4',a,{supplement_id:supplement.id})).report;await approveReport(extra.id,extra.version);
 const now=await reload(wo.id);assert.equal(now.tasks[0].approved_good,'100.000000');assert.equal(now.tasks[0].approved_scrap,'4.000000');
 const input=await db.tenant({tenantId:ta,userId:admin},async sql=>sql.query<{regular:string;repair:string}>("SELECT (SELECT sum(good_qty+defect_qty) FROM production_reports WHERE task_id=$1 AND approval='approved')::text AS regular,(SELECT sum(good_qty+defect_qty) FROM rework_reports WHERE task_id=$1 AND approval='approved')::text AS repair",[first.id]));
 assert.equal(input.rows[0]!.regular,'104.000000');assert.equal(input.rows[0]!.repair,'6.000000');
 await act('/api/production-supplements/'+approved.id+'/actions',{request_key:key(),action:'reverse',version:approved.version,reason:'已有补产报工'},a,409);
 await act('/api/production-reports/'+source.id+'/actions',{request_key:key(),action:'reverse',version:source.version+1,reason:'已有返工'},a,409);
});
test('来料部分放行、冻结、冲销重检、源款核销与陈旧算料批次均受真实来源限制',async()=>{
 const wh=(await warehouse()).id,supplier=(await post('/api/suppliers',{request_key:key(),code:code('IQ'),name:'部分放行供应商'})).supplier;
 const po=(await post('/api/purchase-orders',{request_key:key(),supplier_id:supplier.id,order_date:'2026-10-04',due_date:'2026-10-05',lines:[{product_id:steel.id,quantity:'10',unit_price:'3',requires_inspection:true}]})).purchase_order;
 await act('/api/purchase-orders/'+po.id+'/actions',{request_key:key(),action:'approve',version:po.version});
 const pr=(await post('/api/purchase-receipts',{request_key:key(),order_id:po.id,warehouse_id:wh,lines:[{purchase_line_id:po.lines[0].id,quantity:'10'}]})).purchase_receipt;
 const approved=(await act('/api/purchase-receipts/'+pr.id+'/actions',{request_key:key(),action:'approve',version:pr.version})).purchase_receipt;
 const qc=(await get('/api/incoming-inspections')).items.find((x:{receipt_line_id:string})=>x.receipt_line_id===pr.lines[0].id);
 const complete=(await act('/api/incoming-inspections/'+qc.id+'/actions',{request_key:key(),action:'complete',version:qc.version,conclusion:'partial',sample_qty:'2',sample_good:'1',sample_defect:'1',released_qty:'8',blocked_qty:'2',reason:'人工整批判定'})).incoming_inspection;
 let b=(await get('/api/stock/balances')).items.find((x:{warehouse_id:string})=>x.warehouse_id===wh);assert.equal(b.available_qty,'8.000000');assert.equal(b.blocked_qty,'2.000000');assert.equal(b.on_hand,'10.000000');
 await act('/api/purchase-receipts/'+pr.id+'/actions',{request_key:key(),action:'reverse',version:approved.version,reason:'仍有质检来源'},a,409);
 const reversed=(await act('/api/incoming-inspections/'+qc.id+'/actions',{request_key:key(),action:'reverse',version:complete.version,reason:'重检'})).incoming_inspection;
 b=(await get('/api/stock/balances')).items.find((x:{warehouse_id:string})=>x.warehouse_id===wh);assert.equal(b.held_qty,'10.000000');assert.equal(b.available_qty,'0.000000');
 const retry=(await act('/api/incoming-inspections/'+qc.id+'/actions',{request_key:key(),action:'reinspect',version:reversed.version,reason:'重新送检'})).incoming_inspection;assert.notEqual(retry.id,qc.id);
 await act('/api/purchase-receipts/'+pr.id+'/actions',{request_key:key(),action:'reverse',version:approved.version,reason:'撤销未放行收货'});
 assert.equal(await onHand(wh,steel.id),'0.000000');
 const sale=await openSales('1'),wo=await makeWo(sale.lines[0].id,'1',wh),mrp=(await post('/api/mrp-batches',{request_key:key(),work_order_id:wo.id})).mrp_batch;
 await stockIn(wh,steel.id,'1');
 assert.equal((await act('/api/mrp-batches/'+mrp.id+'/actions',{request_key:key(),action:'reserve',version:mrp.version},a,409)).error.code,'MRP_STALE');
});
test('工资规则拒绝冲突和零价无原因，计時半小时精确15元，权限与只追加保护覆盖新业务表',async()=>{
 await post('/api/wage-rules',{request_key:key(),code:code('DUP'),mode:'time',rate:'30',process_ids:[firstProcess],product_id:fg.id},a,409);
 await post('/api/wage-rules',{request_key:key(),code:code('ZERO'),mode:'piece',rate:'0',process_ids:[firstProcess]},a,422);
 const generic=(await post('/api/wage-rules',{request_key:key(),code:code('TIME'),mode:'time',rate:'30',process_ids:[firstProcess]})).wage_rule;
 const {freezeWage}=await import('../src/accounting.js');
 const priced=await db.tenant({tenantId:ta,userId:admin},sql=>freezeWage(sql,steel.id,firstProcess,'0',1800));
 assert.equal(priced.amount,'15.00');assert.equal(priced.rule_id,generic.id);
 await db.assertSecurityConfiguration();
 for(const name of ['stock_cost_events','reservation_consumptions','wage_rule_versions','wage_events','financial_events','supplement_materials'])await assert.rejects(db.tenant({tenantId:ta,userId:admin},sql=>sql.exec('DELETE FROM '+name)));
 await db.tenant({tenantId:tb,userId:admin},async sql=>{for(const name of ['production_supplements','rework_reports','stock_cost_events','open_items','financial_events'])assert.equal((await sql.query('SELECT id FROM '+name)).rows.length,0);});
});

test('工资重提保持冻结工价，后续新报工使用新规则；成品检验撤销后重新占用实际产出',async()=>{
 const wh=(await warehouse()).id,sale=await openSales('2'),wo=await makeWo(sale.lines[0].id,'2',wh);
 for(const m of wo.materials)await stockIn(wh,m.product_id,m.required_qty);
 await approveIssue(await issue(wo));await act('/api/work-orders/'+wo.id+'/actions',{action:'start',version:(await reload(wo.id)).version});
 const t=(await reload(wo.id)).tasks[0],report=(await reportGood(t.id,'1')).report;assert.equal(report.estimated_wage,'2.00');assert.equal(report.approval,'approved');
 const rejected=await act('/api/production-reports/'+report.id+'/actions',{action:'reject',version:report.version,reason:'修正后重提'},a,409);
 assert.equal(rejected.error.code,'STATE_TRANSITION');
 const rule=(await get('/api/wage-rules')).items.find((r:{product_id:string;process_ids:string[];active:boolean})=>r.product_id===fg.id&&r.process_ids.includes(firstProcess)&&r.active);
 await act('/api/wage-rules/'+rule.id+'/revisions',{request_key:key(),version:rule.version,reason:'工价变更',code:rule.code,mode:'piece',rate:'3',product_id:fg.id,process_ids:rule.process_ids});
 const kept=(await get('/api/production-reports?work_order_id='+wo.id)).items.find((r:{id:string})=>r.id===report.id);
 assert.equal(kept.estimated_wage,'2.00');assert.equal(kept.wage_snapshot.rule_version_id,report.wage_snapshot.rule_version_id);
 const fresh=(await reportGood(t.id,'1')).report;assert.equal(fresh.estimated_wage,'3.00');
 await approveReport(report.id,report.version);await approveReport(fresh.id,fresh.version);
 for(let index=1;index<4;index++){let current=await reload(wo.id);let running=current.tasks.find((row:{execution:string})=>row.execution==='running');if(!running){const next=current.tasks.find((row:{execution:string})=>row.execution==='not_started');current=(await act('/api/work-orders/'+wo.id+'/tasks/'+next.id+'/actions',{action:'start',version:next.version})).work_order;running=current.tasks.find((row:{id:string})=>row.id===next.id);}const rp=(await reportGood(running.id,'2')).report;await approveReport(rp.id,rp.version);}
 const qc=(await post('/api/inspections',{request_key:key(),work_order_id:wo.id,inspected_qty:'2',good_qty:'2',defect_qty:'0'})).inspection;
 const done=(await act('/api/inspections/'+qc.id+'/actions',{request_key:key(),action:'complete',version:qc.version,conclusion:'pass'})).inspection;
 await act('/api/inspections/'+qc.id+'/actions',{request_key:key(),action:'reverse',version:done.version,reason:'成品重检'});
 const retry=(await post('/api/inspections',{request_key:key(),work_order_id:wo.id,inspected_qty:'2',good_qty:'2',defect_qty:'0'})).inspection;
 await act('/api/inspections/'+retry.id+'/actions',{request_key:key(),action:'cancel',version:retry.version,reason:'撤销重复送检'});
});
test('任务绑定工价优先于后来改价，计时零数量报工走真实API、半小时15元且无成品数量',async()=>{
 const prod=(await post('/api/products',{code:code('TFG'),name:'计时测试件',unit_id:unit,attribute:'manufactured'})).product;
 const rt=(await post('/api/routes',{code:code('TRT'),name:'计时单序',description:'',steps:[{process_id:firstProcess,auto_inbound:true}]})).route;
 const bm=(await post('/api/boms',{parent_product_id:prod.id,description:'',route_version_id:rt.current_version_id,items:[{component_product_id:steel.id,quantity:'1',loss_rate:'0'}]})).bom;
 const wh=(await warehouse()).id,created=(await post('/api/sales-orders',{request_key:key(),customer_id:customerId,lines:[{product_id:prod.id,quantity:'1',unit_price:'40'}]})).order;
 const sent=(await act('/api/sales-orders/'+created.id+'/actions',{action:'submit',version:created.version})).order;
 const sale=(await act('/api/sales-orders/'+created.id+'/actions',{action:'approve',version:sent.version})).order;
 const wo=(await post('/api/work-orders',{request_key:key(),sales_line_id:sale.lines[0].id,quantity:'1',route_version_id:rt.current_version_id,bom_version_id:bm.current_version_id,warehouse_id:wh})).work_order;
 const rule=(await get('/api/wage-rules')).items.find((r:{product_id:null;mode:string;active:boolean})=>r.product_id===null&&r.mode==='time'&&r.active);
 const boundVersion=rule.lines[0].id;
 await act('/api/work-orders/'+wo.id+'/tasks/'+wo.tasks[0].id+'/wage-rule',{request_key:key(),version:wo.tasks[0].version,wage_rule_version_id:boundVersion,reason:'合同工价冻结'});
 await act('/api/wage-rules/'+rule.id+'/revisions',{request_key:key(),version:rule.version,reason:'后续改价',code:rule.code,mode:'time',rate:'60',process_ids:rule.process_ids});
 await stockIn(wh,steel.id,'1');await approveIssue(await issue(wo));await act('/api/work-orders/'+wo.id+'/actions',{action:'start',version:(await reload(wo.id)).version});
 const rp=(await reportGood(wo.tasks[0].id,'0',a,{effective_seconds:1800})).report;
 assert.equal(rp.estimated_wage,'15.00');assert.equal(rp.wage_snapshot.rule_version_id,boundVersion);
 await approveReport(rp.id,rp.version);assert.equal((await reload(wo.id)).output_qty,'0.000000');
 const second=(await reportGood(wo.tasks[0].id,'1',a,{effective_seconds:1800})).report;await approveReport(second.id,second.version);assert.equal((await reload(wo.id)).output_qty,'1.000000');
});
test('采购审核与金额流水同事务，审计失败整笔回滚；真实库存竞争不产生两笔成本',async()=>{
 const wh=(await warehouse()).id,supplier=(await post('/api/suppliers',{request_key:key(),code:code('RB'),name:'回滚测试'})).supplier;
 const po=(await post('/api/purchase-orders',{request_key:key(),supplier_id:supplier.id,order_date:'2026-10-04',due_date:'2026-10-05',lines:[{product_id:steel.id,quantity:'10',unit_price:'2',requires_inspection:false}]})).purchase_order;await act('/api/purchase-orders/'+po.id+'/actions',{request_key:key(),action:'approve',version:po.version});
 const pr=(await post('/api/purchase-receipts',{request_key:key(),order_id:po.id,warehouse_id:wh,lines:[{purchase_line_id:po.lines[0].id,quantity:'10'}]})).purchase_receipt;
 await db.admin(sql=>sql.exec("CREATE FUNCTION fail_purchase_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='purchase_receipt.action' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_purchase BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_purchase_audit();"));
 try{await act('/api/purchase-receipts/'+pr.id+'/actions',{request_key:key(),action:'approve',version:pr.version},a,500);assert.equal(await onHand(wh,steel.id),'0.000000');assert.equal((await get('/api/purchase-receipts/'+pr.id)).purchase_receipt.approval,'pending');await db.tenant({tenantId:ta,userId:admin},async sql=>{assert.equal((await sql.query('SELECT id FROM stock_cost_events WHERE source_id=$1',[pr.id])).rows.length,0);assert.equal((await sql.query('SELECT i.id FROM open_items i JOIN purchase_receipt_lines l ON l.id=i.source_id WHERE l.receipt_id=$1',[pr.id])).rows.length,0);});}
 finally{await db.admin(sql=>sql.exec('DROP TRIGGER fail_purchase ON audit_events; DROP FUNCTION fail_purchase_audit();'));}
 await act('/api/purchase-receipts/'+pr.id+'/actions',{request_key:key(),action:'approve',version:pr.version});
 const sales=[await openSales('8'),await openSales('8')],works=[];
 for(const sale of sales){const wo=await makeWo(sale.lines[0].id,'8',wh);works.push(wo);}
 const drafts=[];
 for(const wo of works)drafts.push(await issue(wo,[{material_id:wo.materials.find((m:{product_id:string})=>m.product_id===steel.id).id,quantity:'8'}]));
 const responses=await Promise.all(drafts.map(row=>app.inject({method:'POST',url:'/api/material-issues/'+row.id+'/actions',headers:headers(a,true),payload:{request_key:key(),action:'approve',version:row.version}})));
 assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,409]);assert.equal(await onHand(wh,steel.id),'2.000000');
 await db.tenant({tenantId:ta,userId:admin},async sql=>assert.equal((await sql.query<{n:string}>("SELECT sum(amount_cents)::text AS n FROM stock_cost_events WHERE warehouse_id=$1 AND source_type='material_issue' AND direction='out'",[wh])).rows[0]!.n,'1600'));
});

test('预收预付保留未分配余额，后补核销不会再次记收款，冲销逐条关联原分配事件',async()=>{
 const supplier=(await post('/api/suppliers',{request_key:key(),code:code('ADV'),name:'预付款测试'})).supplier,wh=(await warehouse()).id;
 const pay=(await post('/api/payments',{request_key:key(),kind:'payable',party_id:supplier.id,amount:'30',payment_date:'2026-10-04',method:'bank',allocations:[]})).payment;
 let current=(await act('/api/payments/'+pay.id+'/actions',{request_key:key(),action:'approve',version:pay.version})).payment;
 const before=await get('/api/financial-summary');
 const po=(await post('/api/purchase-orders',{request_key:key(),supplier_id:supplier.id,order_date:'2026-10-04',due_date:'2026-10-05',lines:[{product_id:steel.id,quantity:'2',unit_price:'10',requires_inspection:false}]})).purchase_order;await act('/api/purchase-orders/'+po.id+'/actions',{request_key:key(),action:'approve',version:po.version});
 const pr=(await post('/api/purchase-receipts',{request_key:key(),order_id:po.id,warehouse_id:wh,lines:[{purchase_line_id:po.lines[0].id,quantity:'2'}]})).purchase_receipt;await act('/api/purchase-receipts/'+pr.id+'/actions',{request_key:key(),action:'approve',version:pr.version});
 const item=(await get('/api/open-items')).items.find((x:{party_id:string})=>x.party_id===supplier.id);
 const b={request_key:key(),version:current.version,reason:'到货后核销第一笔',allocations:[{open_item_id:item.id,amount:'10'}]};
 current=(await act('/api/payments/'+pay.id+'/allocations',b)).payment;
 assert.equal((await act('/api/payments/'+pay.id+'/allocations',b)).replayed,true);
 current=(await act('/api/payments/'+pay.id+'/allocations',{request_key:key(),version:current.version,reason:'余款核销',allocations:[{open_item_id:item.id,amount:'10'}]})).payment;
 assert.equal((await get('/api/open-items')).items.find((x:{id:string})=>x.id===item.id).outstanding_amount,'0.00');
 assert.equal((await get('/api/financial-summary')).paid,before.paid);
 await act('/api/payments/'+pay.id+'/actions',{request_key:key(),action:'reverse',version:current.version,reason:'撤销预付款登记'});
 assert.equal((await get('/api/open-items')).items.find((x:{id:string})=>x.id===item.id).outstanding_amount,'20.00');
 await db.tenant({tenantId:ta,userId:admin},async sql=>{const rows=(await sql.query<{n:string;revs:string}>('SELECT sum(settled_cents)::text AS n,count(*) FILTER(WHERE reversal_of IS NOT NULL)::text AS revs FROM financial_events WHERE payment_id=$1',[pay.id])).rows[0]!;assert.equal(rows.n,'0');assert.equal(rows.revs,'2');});
});

test('历史未计价来源不能被空金额流水当作零成本、零工资或完整毛利',async()=>{
 // 模拟升级前已有的审核单据；不改写当前只追加账本或旧快照。
 const legacy=await db.tenant({tenantId:ta,userId:admin},async sql=>{
  const sh=(await sql.query<{id:string}>("INSERT INTO shipments(tenant_id,code,sales_order_id,warehouse_id,approval,created_by) SELECT tenant_id,$1,sales_order_id,warehouse_id,'approved',created_by FROM shipments WHERE approval='approved' LIMIT 1 RETURNING id",[code('OLD-SH')])).rows[0]!;
  await sql.query("INSERT INTO shipment_lines(tenant_id,shipment_id,sales_line_id,product_id,unit_id,quantity) SELECT tenant_id,$1,sales_line_id,product_id,unit_id,quantity FROM shipment_lines WHERE shipment_id=(SELECT id FROM shipments WHERE approval='approved' AND id<>$1 LIMIT 1)",[sh.id]);
  await sql.query("INSERT INTO production_reports(tenant_id,code,work_order_id,task_id,process_id,reporter_id,operator_id,good_qty,defect_qty,rework_qty,scrap_qty,approval) SELECT tenant_id,$1,work_order_id,task_id,process_id,reporter_id,operator_id,1,0,0,0,'approved' FROM production_reports LIMIT 1",[code('OLD-RP')]);
  return sh.id;
 });
 const totals=await get('/api/financial-summary');assert.equal(totals.unsourced_shipments,1);assert.equal(totals.unpriced_shipments,1);assert.equal(totals.receivable,null);assert.equal(totals.sales_cost,null);assert.equal(totals.gross_profit,null);assert.equal(totals.gross_margin_percent,null);assert.equal(totals.wage,null);assert.ok(totals.unpriced_wage_reports>0);assert.equal(totals.cost_status,'unpriced');
 assert.equal((await get('/api/shipments')).items.find((r:{id:string})=>r.id===legacy).approval,'approved');
});

test('文件数据库关闭重开并重新登录后，工资快照、采购来源、成本账和往来核销记录全部保留',async()=>{
 const before=await db.tenant({tenantId:ta,userId:admin},async sql=>{const counts:Record<string,number>={};for(const t of ['purchase_orders','purchase_receipts','incoming_inspections','stock_cost_events','mrp_batches','wage_rule_versions','wage_events','financial_events','production_supplements','rework_reports'])counts[t]=Number((await sql.query<{n:string}>('SELECT count(*)::text AS n FROM '+t)).rows[0]!.n);return counts;});
 await app.close();await db.close();db=new Database({mode:'pglite',dataDir:persistPath});await migrate(db);app=await createApp(db,{localEventsWorker:false});a=await login('line-a');
 for(const [t,n] of Object.entries(before))await db.tenant({tenantId:ta,userId:admin},async sql=>assert.equal(Number((await sql.query<{n:string}>('SELECT count(*)::text AS n FROM '+t)).rows[0]!.n),n,t));
 assert.ok((await get('/api/wages')).items.every((r:{display_name:string})=>r.display_name.length>0));
 await db.assertSecurityConfiguration();
});
