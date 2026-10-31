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

let wo1:any,wo2:any,mainExpense:any,warehouseId:string;
const period={period_start:'2026-01-01',period_end:'2026-12-31'};
const input=(targets:unknown[],extra:Record<string,unknown>={})=>({request_key:key(),external_reference:code('BILL'),category:'厂房租金',...period,amount:'100',basis:'manual',targets,reason:'经批准按人工权重2:1分摊',...extra});
const expenseAct=async(e:any,action:string,extra:Record<string,unknown>={})=>(await act('/api/expenses/'+e.id+'/actions',{request_key:key(),version:e.version,action,...extra})).expense;

test('费用预览100元按2:1准确66.67/33.33，只在审批时过账并进入成品成本与毛利',async()=>{
 await db.assertSecurityConfiguration();warehouseId=(await warehouse()).id;
 const sale=await openSales('2','100');
 wo1=await makeWo(sale.lines[0].id,'1',warehouseId,{require_cost:true});wo2=await makeWo(sale.lines[0].id,'1',warehouseId,{require_cost:true});
 const supplier=(await post('/api/suppliers',{request_key:key(),code:code('SU'),name:'费用验收供应商'})).supplier;
 const po=(await post('/api/purchase-orders',{request_key:key(),supplier_id:supplier.id,order_date:'2026-10-05',due_date:'2026-10-06',lines:[{product_id:steel.id,quantity:'2.06',unit_price:'10',requires_inspection:false},{product_id:caster.id,quantity:'4',unit_price:'2',requires_inspection:false},{product_id:board.id,quantity:'2',unit_price:'3',requires_inspection:false}]})).purchase_order;
 await act('/api/purchase-orders/'+po.id+'/actions',{request_key:key(),version:po.version,action:'approve'});
 const pr=(await post('/api/purchase-receipts',{request_key:key(),order_id:po.id,warehouse_id:warehouseId,lines:po.lines.map((l:any)=>({purchase_line_id:l.id,quantity:l.quantity}))})).purchase_receipt;
 await act('/api/purchase-receipts/'+pr.id+'/actions',{request_key:key(),version:pr.version,action:'approve'});
 const procs=(await get('/api/processes')).items;
 for(const proc of procs)await post('/api/wage-rules',{request_key:key(),code:code('WG'),mode:'piece',rate:'1',process_ids:[proc.id],product_id:fg.id});
 for(const wo of [wo1,wo2]){
  await approveIssue(await issue(wo));await act('/api/work-orders/'+wo.id+'/actions',{version:(await reload(wo.id)).version,action:'start'});
  for(let i=0;i<4;i++){let current=await reload(wo.id);let task=current.tasks.find((t:any)=>t.execution==='running');if(!task){const next=current.tasks.find((t:any)=>t.execution==='not_started');current=(await act('/api/work-orders/'+wo.id+'/tasks/'+next.id+'/actions',{action:'start',version:next.version})).work_order;task=current.tasks.find((t:any)=>t.id===next.id);}const rp=(await reportGood(task.id,'1',a,{effective_seconds:60})).report;await approveReport(rp.id,rp.version);}
 }
 const body=input([{work_order_id:wo1.id,weight:'2'},{work_order_id:wo2.id,weight:'1'}]);
 mainExpense=(await post('/api/expenses',body)).expense;assert.equal(mainExpense.state,'pending');assert.equal(mainExpense.events.length,0);
 assert.equal(mainExpense.preview.allocations.find((l:any)=>l.work_order_id===wo1.id).amount,'66.67');assert.equal(mainExpense.preview.allocations.find((l:any)=>l.work_order_id===wo2.id).amount,'33.33');
 assert.equal((await post('/api/expenses',body,a,200)).replayed,true);
 await post('/api/expenses',{...body,request_key:key()},a,409);
 const approval={request_key:key(),version:mainExpense.version,action:'approve'};
 mainExpense=(await act('/api/expenses/'+mainExpense.id+'/actions',approval)).expense;
 assert.equal((await act('/api/expenses/'+mainExpense.id+'/actions',approval)).replayed,true);assert.equal(mainExpense.events.length,2);
 const cost=(await get('/api/work-orders/'+wo1.id+'/costs')).cost;assert.equal(cost.material_amount,'17.30');assert.equal(cost.labor_amount,'4.00');assert.equal(cost.expense_amount,'66.67');assert.equal(cost.total_amount,'87.97');
 const receipt=(await post('/api/fg-receipts',{request_key:key(),work_order_id:wo1.id,quantity:'1'})).fg_receipt;
 await act('/api/fg-receipts/'+receipt.id+'/actions',{request_key:key(),version:receipt.version,action:'approve'});
 const bal=(await db.tenant({tenantId:ta,userId:admin},sql=>sql.query<{value:string}>('SELECT released_value_cents::text AS value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2',[fg.id,warehouseId]))).rows[0]!;assert.equal(bal.value,'8797');
 const blocked=await act('/api/expenses/'+mainExpense.id+'/actions',{request_key:key(),version:mainExpense.version,action:'reverse',reason:'已入库不能直接改单'},a,409);assert.equal(blocked.error.code,'DOWNSTREAM_EXISTS');
 const shipment=(await post('/api/shipments',{request_key:key(),sales_order_id:sale.id,warehouse_id:warehouseId,lines:[{sales_line_id:sale.lines[0].id,quantity:'1'}]})).shipment;
 await act('/api/shipments/'+shipment.id+'/actions',{request_key:key(),version:shipment.version,action:'approve'});
 const reports=await get('/api/reports/financial?start=2026-01-01&end=2026-12-31');assert.equal(reports.summary.revenue,'100.00');assert.equal(reports.summary.cost_of_sales,'87.97');assert.equal(reports.summary.gross_profit,'12.03');
});

test('费用冲销保留反向来源，重算再批准不重计；零分母、错误日期和重复目标被拒绝',async()=>{
 let e=(await post('/api/expenses',input([{work_order_id:wo2.id,weight:'1'}],{amount:'0.01'}))).expense;
 e=await expenseAct(e,'approve');assert.equal(e.events[0].amount,'0.01');
 e=await expenseAct(e,'reverse',{reason:'凭证更正'});assert.equal(e.events.length,2);assert.equal(e.events[1].amount,'-0.01');assert.equal(e.events[1].reversal_of,e.events[0].id);
 assert.equal((await get('/api/work-orders/'+wo2.id+'/costs')).cost.expense_amount,'33.33');
 e=(await act('/api/expenses/'+e.id+'/recalculate',{request_key:key(),version:e.version,reason:'确认新快照'})).expense;
 e=await expenseAct(e,'approve');assert.equal(e.events.length,3);assert.equal((await get('/api/work-orders/'+wo2.id+'/costs')).cost.expense_amount,'33.34');
 await post('/api/expenses',input([{work_order_id:wo2.id,weight:'0'}]),a,422);
 await post('/api/expenses',input([{work_order_id:wo2.id,weight:'1'}],{amount:'0'}),a,422);
 await post('/api/expenses',input([{work_order_id:wo2.id}],{basis:'time',period_start:'2026-02-30',period_end:'2026-03-02'}),a,422);
 await post('/api/expenses',input([{work_order_id:wo2.id}],{basis:'time',period_start:'2027-01-01',period_end:'2027-01-02'}),a,422);
 const sale=await openSales('1'),fresh=await makeWo(sale.lines[0].id,'1',warehouseId);
 await post('/api/expenses',input([{work_order_id:fresh.id}],{basis:'auto'}),a,422);
 await post('/api/expenses',input([{work_order_id:wo2.id,weight:'1'},{work_order_id:wo2.id,weight:'1'}]),a,422);
});

test('来源版本变化须重算，过期审批、越权、跨企业与审计失败不会留下费用账',async()=>{
 const sale=await openSales('1'),wo=await makeWo(sale.lines[0].id,'1',warehouseId);
 let e=(await post('/api/expenses',input([{work_order_id:wo.id,weight:'1'}]))).expense;
 await db.admin(sql=>sql.query('UPDATE work_orders SET version=version+1 WHERE id=$1',[wo.id]));
 assert.equal((await act('/api/expenses/'+e.id+'/actions',{request_key:key(),version:e.version,action:'approve'},a,409)).error.code,'EXPENSE_STALE');
 assert.equal((await get('/api/expenses/'+e.id)).expense.events.length,0);
 e=(await act('/api/expenses/'+e.id+'/recalculate',{request_key:key(),version:e.version,reason:'工单状态变化后重新预览'})).expense;
 await get('/api/expenses/'+e.id,b,404);await get('/api/expenses',w,403);await get('/api/reports/financial?start=2026-01-01&end=2026-12-31',w,403);
 await post('/api/expenses',input([{work_order_id:wo.id,weight:'1'}]),w,403);
 await post('/api/expenses',input([{work_order_id:wo.id,weight:'1'}]),b,422);
 await db.admin(sql=>sql.exec("CREATE FUNCTION fail_expense_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='expense.action' THEN RAISE EXCEPTION 'expense audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER expense_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_expense_audit()"));
 try{await act('/api/expenses/'+e.id+'/actions',{request_key:key(),version:e.version,action:'approve'},a,500);}finally{await db.admin(sql=>sql.exec('DROP TRIGGER expense_audit_fail ON audit_events; DROP FUNCTION fail_expense_audit()'));}
 assert.equal((await get('/api/expenses/'+e.id)).expense.state,'pending');assert.equal((await get('/api/expenses/'+e.id)).expense.events.length,0);
 e=await expenseAct(e,'approve');
 await act('/api/expenses/'+e.id+'/actions',{request_key:key(),version:e.version-1,action:'reverse',reason:'旧版本'},a,409);
});

test('期间统计按产品工序粒度、按源账冲销，库存期初加进减出勾稽，导出防公式注入且遵守权限',async()=>{
 const production=await get('/api/reports/production?start=2026-01-01&end=2026-12-31&work_order_id='+wo1.id);assert.equal(production.items.length,4);
 assert.equal(production.items.filter((r:any)=>r.net_output_qty!==null).length,1);assert.equal(production.items.find((r:any)=>r.is_output).net_output_qty,'1.000000');
 assert.ok(production.items.every((r:any)=>r.yield_ratio==='1.000000'&&r.good_per_hour==='60.000000'));
 const wages=await get('/api/reports/wages?start=2026-01-01&end=2026-12-31&work_order_id='+wo1.id);assert.equal(wages.summary.total_amount,'4.00');assert.equal(wages.items.length,4);
 const stocks=await get('/api/reports/stock?start=2026-01-01&end=2026-12-31');
 for(const row of stocks.items){const parse=(x:string)=>Math.round(Number(x)*1000000);assert.equal(parse(row.opening_qty)+parse(row.inbound_qty)-parse(row.outbound_qty),parse(row.closing_qty));}
 const old=await get('/api/reports/stock?start=2025-01-01&end=2025-12-31');assert.equal(old.items.length,0);
 await get('/api/reports/production?start=2026-02-30&end=2026-03-01',a,422);await get('/api/reports/production?start=2026-01-01&end=2028-01-01',a,422);await get('/api/reports/production?start=2026-01-01&end=2026-12-31&work_order_id='+wo1.id,b,404);
 const csv=await app.inject({url:'/api/reports/wages/export?start=2026-01-01&end=2026-12-31',headers:headers(a)});assert.equal(csv.statusCode,200,csv.body);assert.match(String(csv.headers['content-type']),/text\/csv/);assert.match(csv.body,/expense|wage|金额|amount/);
 const denied=await app.inject({url:'/api/reports/wages/export?start=2026-01-01&end=2026-12-31',headers:headers(w)});assert.equal(denied.statusCode,403);
 const {reportCsv}=await import('../src/reports.js');const text=reportCsv({kind:'test',period:{start:'2026-01-01',end:'2026-01-02',timezone:'Asia/Shanghai',date_basis:'source'},items:[{name:'=HYPERLINK("evil")',negative:'-12.30',normal:'报价,表'}],summary:{},limit:1000,truncated:false});assert.match(text,/"'=HYPERLINK/);assert.match(text,/"'-12.30"/);assert.match(text,/"报价,表"/);
});

test('极小金额尾差不出现负数，费用基数按时区跨日并含计时零产量，业务日历受版本保护',async()=>{
 const {allocateCents}=await import('../src/expenses.js');const r=allocateCents(1n,Array.from({length:10},(_,i)=>({id:String(i),code:'WO'+i,weight:1n})));assert.equal(r.reduce((n,x)=>n+BigInt(x.amount_cents),0n),1n);assert.ok(r.every(x=>BigInt(x.amount_cents)>=0n));
 const calendar=await get('/api/business-calendar');assert.equal(calendar.timezone,'Asia/Shanghai');
 await post('/api/business-calendar',{request_key:key(),version:calendar.version,timezone:'Bogus/Timezone',reason:'无效时区'},a,422);
 const body={request_key:key(),version:calendar.version,timezone:'UTC',reason:'时区验收'};const saved=(await act('/api/business-calendar',body)).calendar;assert.equal(saved.version,calendar.version+1);assert.equal((await act('/api/business-calendar',body)).replayed,true);
 await act('/api/business-calendar',{...body,request_key:key()},a,409);
 const sh=(await act('/api/business-calendar',{request_key:key(),version:saved.version,timezone:'Asia/Shanghai',reason:'恢复日历'})).calendar;assert.equal(sh.timezone,'Asia/Shanghai');
 // 现有报工放在UTC前一日16:30，上海是次日00:30。日期按企业时区，时间源含零产量行。
 const report=(await get('/api/production-reports')).items.find((r:any)=>r.work_order_id===wo2.id);
 await db.admin(sql=>sql.query("UPDATE production_reports SET created_at='2026-10-04 16:30:00+00',effective_seconds=1800 WHERE id=$1",[report.id]));
 const ex=(await post('/api/expenses',input([{work_order_id:wo2.id}],{basis:'time',period_start:'2026-10-05',period_end:'2026-10-05',amount:'10'}))).expense;
 assert.ok(ex.source_snapshot.sources[0].reports.some((r:any)=>r.id===report.id));assert.equal(ex.preview.basis,'time');
 await db.admin(sql=>sql.query('UPDATE production_reports SET good_qty=0 WHERE id=$1',[report.id]));
 const zero=(await post('/api/expenses',input([{work_order_id:wo2.id}],{basis:'time',period_start:'2026-10-05',period_end:'2026-10-05',amount:'10'}))).expense;assert.equal(zero.preview.allocations[0].amount,'10.00');
 await db.admin(sql=>sql.query('UPDATE production_reports SET good_qty=1 WHERE id=$1',[report.id]));
});

test('自动按10与30小时分摊1000为250与750，零产量计时仍是有效费用基数',async()=>{
 const wh=(await warehouse()).id,sale=await openSales('2'),targets=[];
 const rule=(await get('/api/wage-rules')).items.find((r:any)=>r.product_id===fg.id&&r.process_ids.includes(firstProcess));
 await act('/api/wage-rules/'+rule.id+'/revisions',{request_key:key(),version:rule.version,code:rule.code,product_id:fg.id,process_ids:rule.process_ids,mode:'time',rate:'1',reason:'后续零产量计时费用基数验收，历史报工保持原价'});
 await stockIn(wh,steel.id,'2.06');await stockIn(wh,caster.id,'4');await stockIn(wh,board.id,'2');
 for(const seconds of [36000,108000]){
  const wo=await makeWo(sale.lines[0].id,'1',wh);await approveIssue(await issue(wo));await act('/api/work-orders/'+wo.id+'/actions',{version:(await reload(wo.id)).version,action:'start'});
  const task=(await reload(wo.id)).tasks.find((t:any)=>t.execution==='running'),rp=(await reportGood(task.id,'0',a,{effective_seconds:seconds})).report;await approveReport(rp.id,rp.version);targets.push({work_order_id:wo.id});
 }
 const e=(await post('/api/expenses',input(targets,{basis:'auto',amount:'1000',reason:'验收按批准有效工时分摊'}))).expense;assert.equal(e.preview.basis,'time');assert.equal(e.preview.allocations.find((r:any)=>r.work_order_id===targets[0]!.work_order_id).amount,'250.00');assert.equal(e.preview.allocations.find((r:any)=>r.work_order_id===targets[1]!.work_order_id).amount,'750.00');
 assert.ok(e.source_snapshot.sources.every((s:any)=>s.reports[0].good_qty==='0.000000'));
});

test('费用和期间账文件数据库重启后保持一致，成本账只追加，策略覆盖新增表',async()=>{
 const before=(await get('/api/expenses/'+mainExpense.id)).expense;
 await assert.rejects(db.tenant({tenantId:ta,userId:admin},sql=>sql.exec('UPDATE expense_cost_events SET amount_cents=0')),/permission denied/);
 await assert.rejects(db.admin(sql=>sql.exec('UPDATE expense_cost_events SET amount_cents=0')),/append only/);
 await app.close();await db.close();db=new Database({mode:'pglite',dataDir:persistPath});await migrate(db);await db.assertSecurityConfiguration();app=await createApp(db,{localEventsWorker:false});a=await login('line-a');b=await login('line-b');w=await login('line-a','line.worker');
 const restored=(await get('/api/expenses/'+mainExpense.id)).expense;assert.equal(restored.state,before.state);assert.deepEqual(restored.events.map((r:any)=>r.id),before.events.map((r:any)=>r.id));assert.equal(restored.source_hash,before.source_hash);
 assert.equal((await get('/api/reports/financial?start=2026-01-01&end=2026-12-31')).summary.gross_profit,'12.03');
 await get('/api/expenses/'+mainExpense.id,b,404);
});

test('历史发货缺金额来源时期间毛利不能冒充0，未计价报工也不混入完整工资合计',async()=>{
 const sale=await openSales('1');
 const legacy=(await post('/api/shipments',{request_key:key(),sales_order_id:sale.id,warehouse_id:warehouseId,lines:[{sales_line_id:sale.lines[0].id,quantity:'1'}]})).shipment;
 await db.admin(sql=>sql.query("UPDATE shipments SET approval='approved' WHERE id=$1",[legacy.id]));
 const f=await get('/api/reports/financial?start=2026-01-01&end=2026-12-31');assert.equal(f.summary.revenue,null);assert.equal(f.summary.cost_of_sales,null);assert.equal(f.summary.gross_profit,null);assert.equal(f.summary.unpriced_shipments,1);assert.equal(f.summary.missing_source_count,2);
 const original=(await get('/api/production-reports')).items.find((r:any)=>r.work_order_id===wo2.id);
 await db.admin(sql=>sql.query('UPDATE production_reports SET wage_snapshot=NULL WHERE id=$1',[original.id]));
 const wages=await get('/api/reports/wages?start=2026-01-01&end=2026-12-31&work_order_id='+wo2.id);assert.equal(wages.summary.total_amount,null);assert.ok(wages.summary.unpriced_reports>0);assert.equal(wages.summary.known_posted_amount,'4.00');
});


