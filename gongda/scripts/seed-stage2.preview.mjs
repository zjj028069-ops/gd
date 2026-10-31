import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { frozenRouteVersionId, reusableSales, reusableWorkOrder } from './sample-mainline.mjs';
const root=new URL('../',import.meta.url);
if(process.env.NODE_ENV==='production')throw new Error('仅允许本机开发验收');
const base=process.env.API_BASE??'http://127.0.0.1:3011';
const credentials=await readFile(new URL('.local/dev-credentials.txt',root),'utf8');
const match=credentials.match(/账号：admin\.local\r?\n密码：([^\r\n]+)/);
if(!match)throw new Error('先运行dev:setup生成本机凭据');
let cookie='',csrf='';
async function api(path,body){
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json','x-csrf-token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const result=await response.json();if(!response.ok){const error=new Error(path+': '+(result.error?.message??response.status));error.code=result.error?.code;throw error;}
 if(path==='/api/auth/login'){cookie=response.headers.get('set-cookie').split(';')[0];csrf=result.csrf_token;}
 return result;
}
async function seedMainline({parent,steel,caster,board,route,bom,worker}){
 const warehouse=(await api('/api/warehouses',{request_key:'s4-demo-warehouse',code:'S4-WH',name:'第四步验收仓'})).warehouse;
 const customer=(await api('/api/customers',{request_key:'s4-demo-customer',code:'S4-CU',name:'第四步验收客户'})).customer;
 async function stock(requestKey,product,quantity){
  const created=await api('/api/stock-adjustments',{request_key:requestKey,warehouse_id:warehouse.id,product_id:product.id,direction:'in',quantity,reason:'第四步样例期初，不是采购收货'});
  if(created.stock_adjustment.approval==='pending')await api('/api/stock-adjustments/'+created.stock_adjustment.id+'/actions',{action:'approve',version:created.stock_adjustment.version,request_key:requestKey+'-approve'});
 }
 await stock('s4-demo-steel',steel,'51.5');
 await stock('s4-demo-caster',caster,'100');
 await stock('s4-demo-board',board,'50');
 let sales=reusableSales((await api('/api/sales-orders')).items,parent.id);
 if(!sales){
  try{sales=(await api('/api/sales-orders',{request_key:'s4-demo-sales',customer_id:customer.id,lines:[{product_id:parent.id,quantity:'50',unit_price:'40'}]})).order;}
  catch(error){if(error.code!=='REQUEST_KEY_CONFLICT')throw error;sales=reusableSales((await api('/api/sales-orders')).items,parent.id);if(!sales)throw error;}
 }
 sales=(await api('/api/sales-orders/'+sales.id)).order;
 const line=()=>sales.lines.find((item)=>item.product_id===parent.id)??sales.lines[0];
 if(sales.lifecycle==='draft'&&['unsubmitted','rejected','withdrawn'].includes(sales.approval))sales=(await api('/api/sales-orders/'+sales.id+'/actions',{action:'submit',version:sales.version,request_key:'s4-demo-sales-submit'})).order;
 if(sales.approval==='pending')sales=(await api('/api/sales-orders/'+sales.id+'/actions',{action:'approve',version:sales.version,request_key:'s4-demo-sales-approve'})).order;
 let workOrder=reusableWorkOrder((await api('/api/work-orders')).items,line().id);
 if(workOrder)workOrder=(await api('/api/work-orders/'+workOrder.id)).work_order;
 else{
  const bomVersion=(await api('/api/bom-versions/'+bom.current_version_id)).version;
  const routeVersionId=frozenRouteVersionId(bomVersion,route.current_version_id);
  try{workOrder=(await api('/api/work-orders',{request_key:'s4-demo-work-order',sales_line_id:line().id,quantity:'50',route_version_id:routeVersionId,bom_version_id:bom.current_version_id,warehouse_id:warehouse.id})).work_order;}
  catch(error){
   if(error.code!=='REQUEST_KEY_CONFLICT')throw error;
   const again=reusableWorkOrder((await api('/api/work-orders')).items,line().id);
   if(!again)throw error;
   workOrder=(await api('/api/work-orders/'+again.id)).work_order;
  }
 }
 workOrder=(await api('/api/work-orders/'+workOrder.id)).work_order;
 const issue=await api('/api/material-issues',{request_key:'s4-demo-issue',work_order_id:workOrder.id,warehouse_id:warehouse.id,lines:workOrder.materials.map((item)=>({material_id:item.id,quantity:item.required_qty}))});
 if(issue.material_issue.approval==='pending')await api('/api/material-issues/'+issue.material_issue.id+'/actions',{action:'approve',version:issue.material_issue.version,request_key:'s4-demo-issue-approve'});
 workOrder=(await api('/api/work-orders/'+workOrder.id)).work_order;
 if(workOrder.execution==='not_started')workOrder=(await api('/api/work-orders/'+workOrder.id+'/actions',{action:'start',version:workOrder.version,request_key:'s4-demo-start'})).work_order;
 for(const task of workOrder.tasks){
  workOrder=(await api('/api/work-orders/'+workOrder.id)).work_order;
  const current=workOrder.tasks.find((item)=>item.sequence===task.sequence);
  if(!current||current.execution==='completed')continue;
  if(current.execution!=='running')throw new Error('样例工序没有按串行进入执行：'+current.sequence);
  const report=await api('/api/production-reports',{request_key:'s4-demo-report-'+current.sequence,task_id:current.id,operator_id:worker.id,good_qty:'50',defect_qty:'0',rework_qty:'0',scrap_qty:'0'});
  if(report.report.approval==='pending')await api('/api/production-reports/'+report.report.id+'/actions',{action:'approve',version:report.report.version,request_key:'s4-demo-report-approve-'+current.sequence});
 }
 workOrder=(await api('/api/work-orders/'+workOrder.id)).work_order;
 if(workOrder.received_qty==='0.000000'){
  const receipt=await api('/api/fg-receipts',{request_key:'s4-demo-fg',work_order_id:workOrder.id,quantity:'50'});
  if(receipt.fg_receipt.approval==='pending')await api('/api/fg-receipts/'+receipt.fg_receipt.id+'/actions',{action:'approve',version:receipt.fg_receipt.version,request_key:'s4-demo-fg-approve'});
 }
 sales=(await api('/api/sales-orders/'+sales.id)).order;
 if(line().shipped_qty==='0.000000'){
  const shipment=await api('/api/shipments',{request_key:'s4-demo-ship',sales_order_id:sales.id,warehouse_id:warehouse.id,lines:[{sales_line_id:line().id,quantity:'20'}]});
  if(shipment.shipment.approval==='pending')await api('/api/shipments/'+shipment.shipment.id+'/actions',{action:'approve',version:shipment.shipment.version,request_key:'s4-demo-ship-approve'});
 }
 const finished=(await api('/api/stock/balances')).items.find((row)=>row.warehouse_id===warehouse.id&&row.product_id===parent.id);
 return {sales:sales.code,workOrder:workOrder.code,finished:finished?.on_hand??'0.000000'};
}
try{
 await api('/api/auth/login',{tenant_slug:'demo-a',username:'admin.local',password:match[1]});
 const units=(await api('/api/units')).items;
 const members=(await api('/api/team-members')).items;
 const worker=members.find(m=>m.role==='worker');assert.ok(worker,'验收企业需要本地工人');
 async function product(code,name,unitCode,attribute){const found=(await api('/api/products?q='+encodeURIComponent(code)+'&page_size=100')).items.find(p=>p.code===code);if(found)return found;const unit=units.find(u=>u.code===unitCode&&u.active);assert.ok(unit);return (await api('/api/products',{code,name,unit_id:unit.id,attribute,specification:'第二步本地合成验收数据；不是参考站的业务记录'})).product;}
 const parent=await product('S2-FG','第二步验收餐车','EA','manufactured');
 const steel=await product('S2-STEEL','验收钢板','M','purchased');
 const caster=await product('S2-CASTER','验收脚轮','EA','purchased');
 const board=await product('S2-BOARD','验收密度板','SHEET','purchased');
 let processes=(await api('/api/processes')).items;
 const steps=[];
 for(const [code,name] of [['S2-CUT','下料'],['S2-LASER','激光'],['S2-BEND','折弯'],['S2-WELD','焊接'],['S2-QC','质检']]){let p=processes.find(p=>p.code===code);if(!p)p=(await api('/api/processes',{code,name,description:'本地验收工序；报工名单仅用于规则验证',standard_minutes:'0',reporter_ids:[worker.id]})).process;steps.push({process_id:p.id,auto_inbound:false,name});}
 let route=(await api('/api/routes')).items.find(r=>r.code==='S2-ROUTE');if(!route)route=(await api('/api/routes',{code:'S2-ROUTE',name:'第二步餐车五工序验收路线',description:'参照网页所见五工序顺序；本机新建版本，不宣称原工单曾用本版本',steps:steps.map(({name,...s})=>s)})).route;
 let bom=(await api('/api/boms')).items.find(b=>b.parent_product_id===parent.id);
 if(!bom)bom=(await api('/api/boms',{parent_product_id:parent.id,description:'用量1.03米、2个、1张；独立损耗率为0；自动领料关闭',route_version_id:route.current_version_id,items:[{component_product_id:steel.id,quantity:'1.03',loss_rate:'0',feeding_process_id:steps[0].process_id,auto_issue:false},{component_product_id:caster.id,quantity:'2',loss_rate:'0',feeding_process_id:steps[3].process_id,auto_issue:false},{component_product_id:board.id,quantity:'1',loss_rate:'0',feeding_process_id:steps[2].process_id,auto_issue:false}]})).bom;
 const result=await api('/api/boms/'+bom.id+'/explosion?quantity=50');
 const quantities=Object.fromEntries(result.requirements.map(r=>[r.product_id,r.quantity]));assert.equal(quantities[steel.id],'51.500000');assert.equal(quantities[caster.id],'100.000000');assert.equal(quantities[board.id],'50.000000');
 await writeFile(new URL('.local/stage2-sample.json',root),JSON.stringify({source:'本机合成样例，参照已确认BOM用量',parent_product_id:parent.id,bom_id:bom.id,route_id:route.id,explosion:result},null,2));
 const demo=await seedMainline({parent,steel,caster,board,route,bom,worker});
 console.log('第二步合成主数据已准备；50件用料验证为51.5米、100个、50张。');
 console.log(`第四步样例已落到 ${demo.sales} / ${demo.workOrder}，成品库存 ${demo.finished}，已分批发货 20。加工单冻结 BOM 已绑定的路线版本。重复执行复用已有 SO000001 / WO000001。`);
}finally{
 if(cookie)await api('/api/auth/logout',{}).catch(()=>{});
}
