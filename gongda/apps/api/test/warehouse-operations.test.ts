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

let from:string,to:string,count:any,transfer:any;
async function transferAction(r:any,action:string,expected=200){return act('/api/warehouse-transfers/'+r.id+'/actions',{request_key:key(),version:r.version,action,reason:'调拨验证与来源更正'},a,expected);}
async function countAction(r:any,action:string,expected=200){return act('/api/stock-counts/'+r.id+'/actions',{request_key:key(),version:r.version,action,reason:'实盘差异已核对'},a,expected);}
async function stockValue(wh:string){return (await db.tenant({tenantId:ta,userId:admin},sql=>sql.query<{q:string;v:string|null}>('SELECT on_hand::text AS q,released_value_cents::text AS v FROM stock_balances WHERE warehouse_id=$1 AND product_id=$2',[wh,steel.id]))).rows[0];}
test('真实40件实盘50只补10件，调拨发出10在途100元，收仓继承原价不重复成本',async()=>{
 await db.assertSecurityConfiguration();from=(await warehouse()).id;to=(await warehouse()).id;
 const su=(await post('/api/suppliers',{request_key:key(),code:code('SU'),name:'仓储验收供货方'})).supplier;
 const po=(await post('/api/purchase-orders',{request_key:key(),supplier_id:su.id,order_date:'2026-10-05',due_date:'2026-10-06',lines:[{product_id:steel.id,quantity:'40',unit_price:'10',requires_inspection:false}]})).purchase_order;
 await act('/api/purchase-orders/'+po.id+'/actions',{request_key:key(),version:po.version,action:'approve'});
 const pr=(await post('/api/purchase-receipts',{request_key:key(),order_id:po.id,warehouse_id:from,lines:[{purchase_line_id:po.lines[0].id,quantity:'40'}]})).purchase_receipt;
 await act('/api/purchase-receipts/'+pr.id+'/actions',{request_key:key(),version:pr.version,action:'approve'});
 count=(await post('/api/stock-counts',{request_key:key(),warehouse_id:from,product_id:steel.id,actual_qty:'50',reason:'现场实盘50，书面批准盘盈10'})).count;
 assert.equal(count.book_qty,'40.000000');assert.equal(count.delta_qty,'10.000000');assert.equal(count.amount,'100.00');assert.equal((await stockValue(from))!.q,'40.000000');
 const body={request_key:key(),version:count.version,action:'approve'};count=(await act('/api/stock-counts/'+count.id+'/actions',body)).count;assert.equal((await act('/api/stock-counts/'+count.id+'/actions',body)).replayed,true);assert.deepEqual(await stockValue(from),{q:'50.000000',v:'50000'});
 transfer=(await post('/api/warehouse-transfers',{request_key:key(),from_warehouse_id:from,to_warehouse_id:to,product_id:steel.id,quantity:'10',reason:'调往装配仓'})).transfer;
 const dispatch={request_key:key(),version:transfer.version,action:'dispatch'};transfer=(await act('/api/warehouse-transfers/'+transfer.id+'/actions',dispatch)).transfer;assert.equal((await act('/api/warehouse-transfers/'+transfer.id+'/actions',dispatch)).replayed,true);
 assert.equal(transfer.state,'in_transit');assert.equal(transfer.amount,'100.00');assert.deepEqual(await stockValue(from),{q:'40.000000',v:'40000'});assert.equal(await stockValue(to),undefined);
 const transit=await get('/api/warehouse-transfers/in-transit/summary');assert.equal(transit.items[0].quantity,'10.000000');assert.equal(transit.items[0].amount,'100.00');
 const total=await get('/api/financial-summary');assert.equal(total.inventory_value,'400.00');assert.equal(total.in_transit_value,'100.00');assert.equal(total.inventory_including_transit_value,'500.00');
 const receive={request_key:key(),version:transfer.version,action:'receive'};transfer=(await act('/api/warehouse-transfers/'+transfer.id+'/actions',receive)).transfer;assert.equal((await act('/api/warehouse-transfers/'+transfer.id+'/actions',receive)).replayed,true);
 assert.equal(transfer.state,'received');assert.deepEqual(await stockValue(to),{q:'10.000000',v:'10000'});assert.equal((await get('/api/warehouse-transfers/in-transit/summary')).items.length,0);assert.equal(transfer.events.length,2);
});
test('后续出库阻止撤收，按顺序冲回准确恢复数量成本，重新调拨使用新事件不吞掉来源',async()=>{
 await transferAction(transfer,'reverse_dispatch',409);
 const adj=(await post('/api/stock-adjustments',{request_key:key(),warehouse_id:to,product_id:steel.id,direction:'out',quantity:'1',reason:'验收出库'})).stock_adjustment;
 const out=(await act('/api/stock-adjustments/'+adj.id+'/actions',{request_key:key(),version:adj.version,action:'approve'})).stock_adjustment;
 assert.ok(['DOWNSTREAM_EXISTS','INSUFFICIENT_STOCK'].includes((await transferAction(transfer,'reverse_receive',409)).error.code));assert.deepEqual(await stockValue(to),{q:'9.000000',v:'9000'});
 await act('/api/stock-adjustments/'+out.id+'/actions',{request_key:key(),version:out.version,action:'reverse',reason:'先处理下游调整'});
 transfer=(await transferAction(transfer,'reverse_receive')).transfer;assert.deepEqual(await stockValue(to),{q:'0.000000',v:'0'});assert.equal(transfer.state,'in_transit');
 transfer=(await transferAction(transfer,'reverse_dispatch')).transfer;assert.deepEqual(await stockValue(from),{q:'50.000000',v:'50000'});assert.equal(transfer.state,'pending');
 assert.equal(transfer.events.length,4);assert.equal(transfer.events.filter((e:any)=>e.reversal_of).length,2);
 transfer=(await transferAction(transfer,'dispatch')).transfer;transfer=(await transferAction(transfer,'receive')).transfer;assert.equal(transfer.events.length,6);assert.deepEqual(await stockValue(to),{q:'10.000000',v:'10000'});
});
test('盘亏准确计负数量并能冲销，库存变化使盘点过期；零差异不写实物流',async()=>{
 let c=(await post('/api/stock-counts',{request_key:key(),warehouse_id:to,product_id:steel.id,actual_qty:'8',reason:'实盘缺2'})).count;
 assert.equal(c.delta_qty,'-2.000000');c=(await countAction(c,'approve')).count;assert.deepEqual(await stockValue(to),{q:'8.000000',v:'8000'});c=(await countAction(c,'reverse')).count;assert.deepEqual(await stockValue(to),{q:'10.000000',v:'10000'});
 const stale=(await post('/api/stock-counts',{request_key:key(),warehouse_id:to,product_id:steel.id,actual_qty:'9',reason:'需再次核实'})).count;
 const other=(await post('/api/warehouse-transfers',{request_key:key(),from_warehouse_id:to,to_warehouse_id:from,product_id:steel.id,quantity:'1',reason:'库存版本变化'})).transfer;
 await transferAction(other,'dispatch');assert.equal((await countAction(stale,'approve',409)).error.code,'COUNT_STALE');assert.equal((await get('/api/stock-counts/'+stale.id)).document.events.length,0);
 let zero=(await post('/api/stock-counts',{request_key:key(),warehouse_id:to,product_id:steel.id,actual_qty:'9',reason:'账实相符'})).count;zero=(await countAction(zero,'approve')).count;assert.equal(zero.events.length,0);assert.equal(zero.amount,'0.00');
});
test('仓储权限与企业隔离、费用字段隐藏、明确盘盈估价、待检保护、失败回滚',async()=>{
 await get('/api/warehouse-transfers/'+transfer.id,b,404);await get('/api/warehouse-transfers',w,403);
 await post('/api/warehouse-transfers',{request_key:key(),from_warehouse_id:from,to_warehouse_id:from,product_id:steel.id,quantity:'1',reason:'相同仓库'},a,422);
 await post('/api/warehouse-transfers',{request_key:key(),from_warehouse_id:from,to_warehouse_id:to,product_id:steel.id,quantity:'0',reason:'无数量'},a,422);
 await post('/api/warehouse-transfers',{request_key:key(),from_warehouse_id:from,to_warehouse_id:to,product_id:steel.id,quantity:'1',reason:'其他企业仓库'},b,422);
 const empty=(await warehouse()).id;await post('/api/stock-counts',{request_key:key(),warehouse_id:empty,product_id:steel.id,actual_qty:'1',reason:'无成本盘盈'},a,422);
 let priced=(await post('/api/stock-counts',{request_key:key(),warehouse_id:empty,product_id:steel.id,actual_qty:'1',unit_price:'7.35',reason:'盘盈按授权估价7.35'})).count;assert.equal(priced.amount,'7.35');priced=(await countAction(priced,'approve')).count;
 const profile=await member(planner),role=(await post('/api/platform/roles',{code:code('ROLE'),name:'仓储只读无财务',permissions:['inventory.read','audit.read'],data_scope:'all'})).role;
 await updateMember(planner,{custom_role_id:role.id});p=await login('line-a','line.planner');
 const hidden=(await get('/api/warehouse-transfers/'+transfer.id,p)).document;assert.equal(hidden.amount,undefined);assert.equal(hidden.events[0].amount,undefined);
 assert.equal((await get('/api/stock-counts/'+priced.id,p)).document.unit_price,undefined);assert.ok((await get('/api/audit-events',p)).items.every((e:any)=>!['transfer','count'].includes(e.entity_type)));
 await updateMember(planner,{custom_role_id:profile.custom_role_id});
 const held=(await warehouse()).id;await db.admin(async sql=>{await sql.query('INSERT INTO stock_balances(tenant_id,warehouse_id,product_id,unit_id,on_hand,held_qty,held_value_cents) VALUES($1,$2,$3,$4,10,10,10000)',[ta,held,steel.id,unit]);});
 await post('/api/stock-counts',{request_key:key(),warehouse_id:held,product_id:steel.id,actual_qty:'9',reason:'待检实盘缺数'},a,409);
 const frozen=(await post('/api/warehouse-transfers',{request_key:key(),from_warehouse_id:held,to_warehouse_id:to,product_id:steel.id,quantity:'1',reason:'待检不得调拨'})).transfer;await transferAction(frozen,'dispatch',409);
 let failure=(await post('/api/warehouse-transfers',{request_key:key(),from_warehouse_id:from,to_warehouse_id:empty,product_id:steel.id,quantity:'1',reason:'回滚验证'})).transfer;const before=await stockValue(from);
 await db.admin(sql=>sql.exec("CREATE FUNCTION fail_transfer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='transfer.action' THEN RAISE EXCEPTION 'warehouse audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER transfer_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_transfer_audit()"));
 try{await transferAction(failure,'dispatch',500);}finally{await db.admin(sql=>sql.exec('DROP TRIGGER transfer_audit_fail ON audit_events; DROP FUNCTION fail_transfer_audit()'));}
 assert.deepEqual(await stockValue(from),before);failure=(await get('/api/warehouse-transfers/'+failure.id)).document;assert.equal(failure.state,'pending');assert.equal(failure.events.length,0);
});
test('两笔同时调拨不能透支可用量，保存重启后在途和来源保持，数量期间勾稽',async()=>{
 const availableQty=Number((await stockValue(to))!.q),docs=[];for(let i=0;i<2;i++)docs.push((await post('/api/warehouse-transfers',{request_key:key(),from_warehouse_id:to,to_warehouse_id:from,product_id:steel.id,quantity:String(availableQty-1),reason:'竞争调拨'})).transfer);
 const results=await Promise.all(docs.map(r=>app.inject({method:'POST',url:'/api/warehouse-transfers/'+r.id+'/actions',headers:headers(a,true),payload:{request_key:key(),version:r.version,action:'dispatch'}})));assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);assert.equal((await stockValue(to))!.q,'1.000000');
 const before=(await get('/api/warehouse-transfers/in-transit/summary')).items;
 await app.close();await db.close();db=new Database({mode:'pglite',dataDir:persistPath});await migrate(db);await db.assertSecurityConfiguration();app=await createApp(db,{localEventsWorker:false});a=await login('line-a');b=await login('line-b');
 assert.deepEqual((await get('/api/warehouse-transfers/in-transit/summary')).items,before);await get('/api/warehouse-transfers/'+transfer.id,b,404);
 const period=await get('/api/reports/stock?start=2026-01-01&end=2026-12-31');for(const r of period.items)assert.equal(Number(r.opening_qty)+Number(r.inbound_qty)-Number(r.outbound_qty),Number(r.closing_qty));
});

