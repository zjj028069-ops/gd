import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem,requireAllScope,writeAudit,type Actor,type Services } from './services.js';
import { gateTenantWrite } from './assets.js';
import { uuid,qtyField,rateField,cashField,keyField,versionField,reasonField,dateField,shortText,shape,idParams,qty,formatDecimal,rate,cents,money,lineCents,round,calendarDate,nextCode,permit,reason,digest,replay,finish,product,warehouse } from './business-common.js';
import { lockBalance,saveBalance,available,postStock,qualityTransfer,releaseReservations } from './inventory.js';
import { tradeSource,reverseTrade,workCosts } from './accounting.js';
type Row=Record<string,unknown>&{id:string;version:number};
const actionSchema=(actions:string[],extra:Record<string,unknown>={})=>shape(['action','version','request_key'],{action:{type:'string',enum:actions},version:versionField,request_key:keyField,reason:reasonField,...extra});
const array=(items:unknown)=>({type:'array',minItems:1,maxItems:100,items});
const missing=()=>new Problem(404,'NOT_FOUND','单据不存在或不属于当前企业');
const conflict=()=>new Problem(409,'STATE_TRANSITION','当前状态不能执行此操作');
const tables={supplier:'suppliers',purchase_order:'purchase_orders',purchase_receipt:'purchase_receipts',incoming_inspection:'incoming_inspections',mrp_batch:'mrp_batches',wage_rule:'wage_rules',payment:'payments',wage_settlement:'wage_settlements'} as const;
type Resource=keyof typeof tables;
async function view(sql:Sql,type:Resource,id:string){
 const table=tables[type],row=(await sql.query<Row>('SELECT * FROM '+table+' WHERE id=$1',[id])).rows[0];if(!row)throw missing();
 let lines:Record<string,unknown>[]|undefined;
 if(type==='purchase_order')lines=(await sql.query('SELECT *,quantity::text,received_qty::text,unit_price::text,amount_cents::text FROM purchase_order_lines WHERE order_id=$1 ORDER BY line_no',[id])).rows;
 if(type==='purchase_receipt')lines=(await sql.query('SELECT *,quantity::text,unit_price::text,amount_cents::text FROM purchase_receipt_lines WHERE receipt_id=$1 ORDER BY id',[id])).rows;
 if(type==='mrp_batch')lines=(await sql.query('SELECT l.*,l.required_qty::text,l.available_qty::text,l.shortage_qty::text,l.transferred_qty::text,p.name AS product_name FROM mrp_lines l JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id WHERE l.batch_id=$1 ORDER BY p.code',[id])).rows;
 let kitRatio: string|undefined;
 if(type==='mrp_batch'){
  kitRatio='1.000000';let minimum=1000000n;
  const inputs=row.inputs as {product_id:string;required_qty:string;issued_qty:string}[];
  for(const line of lines??[]){const input=inputs.find(x=>x.product_id===line.product_id);if(!input)throw new Problem(500,'MRP_SNAPSHOT_INVALID','算料快照不完整');const total=qty(input.required_qty);if(total<=0n)continue;const ready=qty(input.issued_qty)+qty(String(line.available_qty));const ratio=ready*1000000n/total;if(ratio<minimum)minimum=ratio;}
  kitRatio=formatDecimal(minimum<0n?0n:minimum);
 }
 if(type==='payment')lines=(await sql.query('SELECT *,amount_cents::text FROM payment_allocations WHERE payment_id=$1 ORDER BY id',[id])).rows;
 if(type==='wage_rule')lines=(await sql.query('SELECT *,rate::text FROM wage_rule_versions WHERE rule_id=$1 ORDER BY revision DESC',[id])).rows;
 if(type==='wage_settlement')lines=(await sql.query('SELECT l.*,e.amount_cents::text,e.worker_id,e.report_id FROM wage_settlement_lines l JOIN wage_events e ON e.tenant_id=l.tenant_id AND e.id=l.wage_event_id WHERE l.settlement_id=$1',[id])).rows;
 if(lines)lines=lines.map(l=>({...l,...(l.amount_cents!==undefined?{amount:money(BigInt(String(l.amount_cents)))}:{})}));
 return {...row,...(kitRatio!==undefined?{kit_ratio:kitRatio,kit_basis:'released_material_only'}:{}),...(lines?{lines}:{}),...(row.amount_cents!==undefined?{amount:money(BigInt(String(row.amount_cents)))}:{}),persisted:true};
}
async function locked(sql:Sql,type:Resource,id:string,version:number){const row=(await sql.query<Row>('SELECT * FROM '+tables[type]+' WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw missing();if(row.version!==version)throw new Problem(409,'VERSION_CONFLICT','数据已修改，请刷新后重试');return row;}
export function registerBusiness(app:FastifyInstance,s:Services){
 const guard=s.authorize();
 function get(path:string,permission:string,fn:(sql:Sql,a:Actor,id:string)=>Promise<unknown>){app.get<{Params:{id?:string}}>(path,{preHandler:guard,...(path.includes(':id')?{schema:{params:idParams}}:{})},r=>s.database.tenant(s.context(r),async sql=>{const a=s.actor(r);permit(a,permission);requireAllScope(a);return fn(sql,a,r.params.id??'');}));}
 function post<T extends {request_key:string}>(path:string,permission:string,schema:unknown,type:Resource,command:string,fn:(sql:Sql,a:Actor,b:T,id:string)=>Promise<string>,creation=true){
 app.post<{Body:T;Params:{id?:string}}>(path,{preHandler:guard,schema:{body:schema,...(path.includes(':id')?{params:idParams}:{})}},async(r,reply)=>s.database.tenant(s.context(r),async sql=>{
  const a=s.actor(r);permit(a,permission);requireAllScope(a);await gateTenantWrite(sql,s.context(r));
  const body=r.body as T,hash=digest({id:r.params.id??null,body}),cmd=command;
  const prior=await replay(sql,cmd,body.request_key,hash);if(prior)return reply.code(200).send({replayed:true,[type]:await view(sql,type,prior)});
  const before=r.params.id?await view(sql,type,r.params.id):null;
  const id=await fn(sql,a,body,r.params.id??'');const after=await view(sql,type,id);
  await finish(sql,a,cmd,body.request_key,hash,type,id);await writeAudit(sql,a,cmd,type,id,before,after);
  return reply.code(creation?201:200).send({replayed:false,[type]:after});
 }));}
 for(const [type,permission] of [['supplier','procurement.read'],['purchase_order','procurement.read'],['purchase_receipt','procurement.read'],['incoming_inspection','quality.read'],['mrp_batch','planning.read'],['wage_rule','payroll.read'],['payment','finance.read'],['wage_settlement','payroll.read']] as const){
  const path='/api/'+({supplier:'suppliers',purchase_order:'purchase-orders',purchase_receipt:'purchase-receipts',incoming_inspection:'incoming-inspections',mrp_batch:'mrp-batches',wage_rule:'wage-rules',payment:'payments',wage_settlement:'wage-settlements'}[type]);
  get(path,permission,async sql=>{const ids=(await sql.query<{id:string}>('SELECT id FROM '+tables[type]+' ORDER BY created_at DESC LIMIT 200')).rows;return {items:await Promise.all(ids.map(r=>view(sql,type,r.id))),limit:200};});
  get(path+'/:id',permission,async(sql,a,id)=>({[type]:await view(sql,type,id)}));
 }
 post<{request_key:string;code:string;name:string}>('/api/suppliers','procurement.write',shape(['request_key','code','name'],{request_key:keyField,code:shortText(64),name:shortText()}),'supplier','supplier.create',async(sql,a,b)=>(await sql.query<{id:string}>('INSERT INTO suppliers(tenant_id,code,name,created_by) VALUES($1,$2,$3,$4) RETURNING id',[a.tenant_id,b.code,b.name,a.user_id])).rows[0]!.id);
 post<{request_key:string;action:string;version:number}>('/api/suppliers/:id/actions','procurement.write',actionSchema(['activate','deactivate']),'supplier','supplier.action',async(sql,a,b,id)=>{await locked(sql,'supplier',id,b.version);await sql.query('UPDATE suppliers SET active=$1,version=version+1 WHERE id=$2',[b.action==='activate',id]);return id;},false);
 type Purchase={request_key:string;supplier_id:string;order_date:string;due_date:string;note?:string;zero_price_reason?:string;lines:{product_id:string;quantity:string;unit_price:string;requires_inspection:boolean;mrp_line_id?:string}[]};
 post<Purchase>('/api/purchase-orders','procurement.write',shape(['request_key','supplier_id','order_date','due_date','lines'],{request_key:keyField,supplier_id:uuid,order_date:dateField,due_date:dateField,note:{type:'string',maxLength:2000},zero_price_reason:reasonField,lines:array(shape(['product_id','quantity','unit_price','requires_inspection'],{product_id:uuid,quantity:qtyField,unit_price:rateField,requires_inspection:{type:'boolean'},mrp_line_id:uuid}))}),'purchase_order','purchase_order.create',async(sql,a,b)=>{
  calendarDate(b.order_date);calendarDate(b.due_date);if(b.due_date<b.order_date)throw new Problem(422,'DATE_ORDER','交期不能早于订单日期');
  if(!(await sql.query('SELECT id FROM suppliers WHERE id=$1 AND active',[b.supplier_id])).rows[0])throw new Problem(422,'INVALID_REFERENCE','供应商不存在或停用');
  if(new Set(b.lines.map(l=>l.product_id)).size!==b.lines.length)throw new Problem(422,'DUPLICATE_LINE','采购单不可重复产品');
  const id=(await sql.query<{id:string}>('INSERT INTO purchase_orders(tenant_id,code,supplier_id,order_date,due_date,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[a.tenant_id,await nextCode(sql,a,'PO'),b.supplier_id,b.order_date,b.due_date,b.note??'',a.user_id])).rows[0]!.id;
  for(const [index,l] of b.lines.entries()){
   const p=await product(sql,l.product_id),n=qty(l.quantity);if(n<=0n)throw new Problem(422,'QUANTITY_REQUIRED','采购数量必须大于零');
   if(rate(l.unit_price)===0n){permit(a,'procurement.approve');reason(b.zero_price_reason);}
   if(!l.requires_inspection)permit(a,'quality.write');
   if(l.mrp_line_id){
    const batch=(await sql.query<{work_order_version:number;version:number;inputs:{product_id:string;unit_id:string;warehouse_id:string;stock_version:number}[]}>('SELECT b.work_order_version,w.version,b.inputs FROM mrp_lines l JOIN mrp_batches b ON b.tenant_id=l.tenant_id AND b.id=l.batch_id JOIN work_orders w ON w.tenant_id=b.tenant_id AND w.id=b.work_order_id WHERE l.id=$1',[l.mrp_line_id])).rows[0];
    if(!batch||batch.work_order_version!==batch.version)throw new Problem(409,'MRP_STALE','加工单发生变化，请重新算料');
    for(const input of batch.inputs){const stock=(await sql.query<{version:number}>('SELECT version FROM stock_balances WHERE warehouse_id=$1 AND product_id=$2 AND unit_id=$3',[input.warehouse_id,input.product_id,input.unit_id])).rows[0];if(stock?.version!==input.stock_version)throw new Problem(409,'MRP_STALE','库存发生变化，请重新算料');}
    const m=(await sql.query<{product_id:string;shortage_qty:string;transferred_qty:string;state:string;execution:string}>('SELECT l.product_id,l.shortage_qty::text,l.transferred_qty::text,b.state,w.execution FROM mrp_lines l JOIN mrp_batches b ON b.tenant_id=l.tenant_id AND b.id=l.batch_id JOIN work_orders w ON w.tenant_id=b.tenant_id AND w.id=b.work_order_id WHERE l.id=$1 FOR UPDATE OF l',[l.mrp_line_id])).rows[0];if(!m||m.product_id!==p.id||m.state==='released'||m.execution==='cancelled'||qty(m.transferred_qty)+n>qty(m.shortage_qty))throw new Problem(409,'MRP_TRANSFER_EXCEEDS','算料来源失效或缺口已转单');await sql.query('UPDATE mrp_lines SET transferred_qty=transferred_qty+$1 WHERE id=$2',[formatDecimal(n),l.mrp_line_id]);}
   await sql.query('INSERT INTO purchase_order_lines(tenant_id,order_id,line_no,product_id,unit_id,quantity,unit_price,amount_cents,requires_inspection,product_snapshot,mrp_line_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[a.tenant_id,id,index+1,p.id,p.unit_id,formatDecimal(n),l.unit_price,lineCents(n,l.unit_price).toString(),l.requires_inspection,p,l.mrp_line_id??null]);
  }return id;
 });
 type Action={request_key:string;version:number;action:string;reason?:string};
 post<Action>('/api/purchase-orders/:id/actions','procurement.approve',actionSchema(['approve','reject','cancel','close']),'purchase_order','purchase_order.action',async(sql,a,b,id)=>{
  const r=await locked(sql,'purchase_order',id,b.version);if(r.lifecycle!=='open')throw conflict();
  if(b.action==='approve'||b.action==='reject'){if(r.approval!=='pending')throw conflict();if(b.action==='reject')reason(b.reason);await sql.query('UPDATE purchase_orders SET approval=$1,version=version+1 WHERE id=$2',[b.action==='approve'?'approved':'rejected',id]);}
  else{reason(b.reason);if((await sql.query("SELECT id FROM purchase_receipts WHERE order_id=$1 AND approval='pending' LIMIT 1",[id])).rows[0])throw new Problem(409,'DOWNSTREAM_EXISTS','先处理待审核收货单');if(b.action==='cancel'&&(await sql.query("SELECT id FROM purchase_receipts WHERE order_id=$1 AND approval='approved' LIMIT 1",[id])).rows[0])throw new Problem(409,'DOWNSTREAM_EXISTS','已收货采购单需先处理收货来源，不能直接取消');
   const lines=(await sql.query<{mrp_line_id:string|null;quantity:string;received_qty:string}>('SELECT mrp_line_id,quantity::text,received_qty::text FROM purchase_order_lines WHERE order_id=$1',[id])).rows;
   for(const l of lines)if(l.mrp_line_id)await sql.query('UPDATE mrp_lines SET transferred_qty=transferred_qty-$1 WHERE id=$2',[formatDecimal(qty(l.quantity)-qty(l.received_qty)),l.mrp_line_id]);
   await sql.query('UPDATE purchase_orders SET lifecycle=$1,version=version+1 WHERE id=$2',[b.action==='cancel'?'cancelled':'closed',id]);
  }return id;
 },false);
 type Receipt={request_key:string;order_id:string;warehouse_id:string;lines:{purchase_line_id:string;quantity:string}[]};
 post<Receipt>('/api/purchase-receipts','procurement.write',shape(['request_key','order_id','warehouse_id','lines'],{request_key:keyField,order_id:uuid,warehouse_id:uuid,lines:array(shape(['purchase_line_id','quantity'],{purchase_line_id:uuid,quantity:qtyField}))}),'purchase_receipt','purchase_receipt.create',async(sql,a,b)=>{
  await warehouse(sql,b.warehouse_id);const po=(await sql.query<Row>('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE',[b.order_id])).rows[0];if(!po||po.approval!=='approved'||po.lifecycle!=='open')throw new Problem(422,'PURCHASE_ORDER_REQUIRED','只能引用有效的已审核采购单');
  if(new Set(b.lines.map(l=>l.purchase_line_id)).size!==b.lines.length)throw new Problem(422,'DUPLICATE_LINE','收货来源不可重复');
  const id=(await sql.query<{id:string}>('INSERT INTO purchase_receipts(tenant_id,code,order_id,warehouse_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',[a.tenant_id,await nextCode(sql,a,'PR'),b.order_id,b.warehouse_id,a.user_id])).rows[0]!.id;
  for(const l of b.lines){
   const source=(await sql.query<{id:string;quantity:string;unit_price:string;amount_cents:string;product_id:string;unit_id:string;requires_inspection:boolean}>('SELECT *,quantity::text,unit_price::text,amount_cents::text FROM purchase_order_lines WHERE order_id=$1 AND id=$2 FOR UPDATE',[b.order_id,l.purchase_line_id])).rows[0];if(!source)throw new Problem(422,'INVALID_REFERENCE','收货明细必须属于本采购单');
   const used=(await sql.query<{n:string}>("SELECT coalesce(sum(l.quantity),0)::text AS n FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.tenant_id=l.tenant_id AND r.id=l.receipt_id WHERE l.purchase_line_id=$1 AND r.approval IN ('pending','approved')",[source.id])).rows[0]!.n,n=qty(l.quantity);
   if(n<=0n||qty(used)+n>qty(source.quantity))throw new Problem(422,'OVER_RECEIPT','收货数量超出未收货且未占用数量');
   const value=qty(used)+n===qty(source.quantity)?BigInt(source.amount_cents)-BigInt((await sql.query<{n:string}>("SELECT coalesce(sum(l.amount_cents),0)::text AS n FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.tenant_id=l.tenant_id AND r.id=l.receipt_id WHERE l.purchase_line_id=$1 AND r.approval IN ('pending','approved')",[source.id])).rows[0]!.n):lineCents(n,source.unit_price);
   await sql.query('INSERT INTO purchase_receipt_lines(tenant_id,receipt_id,purchase_line_id,product_id,unit_id,quantity,unit_price,amount_cents,requires_inspection) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[a.tenant_id,id,source.id,source.product_id,source.unit_id,formatDecimal(n),source.unit_price,value.toString(),source.requires_inspection]);
  }return id;
 });
 post<Action>('/api/purchase-receipts/:id/actions','procurement.approve',actionSchema(['approve','reject','reverse']),'purchase_receipt','purchase_receipt.action',async(sql,a,b,id)=>{
  const r=await locked(sql,'purchase_receipt',id,b.version);
  const po=(await sql.query<{supplier_id:string;approval:string;lifecycle:string}>('SELECT supplier_id,approval,lifecycle FROM purchase_orders WHERE id=$1 FOR UPDATE',[r.order_id])).rows[0]!;
  const lines=(await sql.query<{id:string;purchase_line_id:string;product_id:string;unit_id:string;quantity:string;amount_cents:string;requires_inspection:boolean}>('SELECT *,quantity::text,amount_cents::text FROM purchase_receipt_lines WHERE receipt_id=$1 ORDER BY product_id,id',[id])).rows;
  if(b.action==='approve'){
   if(r.approval!=='pending'||po.approval!=='approved'||po.lifecycle!=='open')throw conflict();
   for(const l of lines){
    await product(sql,l.product_id);await warehouse(sql,String(r.warehouse_id));
    await postStock(sql,a,{warehouseId:String(r.warehouse_id),productId:l.product_id,unitId:l.unit_id,direction:'in',quantity:qty(l.quantity),sourceType:'purchase_receipt',sourceId:id,eventKey:'purchase_receipt:'+l.id,quality:l.requires_inspection?'held':'released',valueCents:BigInt(l.amount_cents)});
    await tradeSource(sql,a,{kind:'payable',partyId:po.supplier_id,sourceType:'purchase_receipt',sourceId:l.id,eventKey:'purchase_receipt:'+l.id,amount:BigInt(l.amount_cents)});
    if(l.requires_inspection)await sql.query('INSERT INTO incoming_inspections(tenant_id,code,receipt_line_id,quantity,created_by) VALUES($1,$2,$3,$4,$5)',[a.tenant_id,await nextCode(sql,a,'IQC'),l.id,l.quantity,a.user_id]);
   }
  }else if(b.action==='reject'){if(r.approval!=='pending')throw conflict();reason(b.reason);}
  else{
   if(r.approval!=='approved'||po.lifecycle!=='open')throw conflict();reason(b.reason);
   for(const l of lines){
    if((await sql.query("SELECT id FROM incoming_inspections WHERE receipt_line_id=$1 AND state='completed' LIMIT 1",[l.id])).rows[0])throw new Problem(409,'DOWNSTREAM_EXISTS','先冲销该收货批次的检验放行');
    await reverseTrade(sql,a,'purchase_receipt:'+l.id);
    await postStock(sql,a,{warehouseId:String(r.warehouse_id),productId:l.product_id,unitId:l.unit_id,direction:'out',quantity:qty(l.quantity),sourceType:'purchase_receipt',sourceId:id,eventKey:'purchase_receipt_reverse:'+l.id,originalEventKey:'purchase_receipt:'+l.id});
    await sql.query("UPDATE incoming_inspections SET state='reversed',version=version+1 WHERE receipt_line_id=$1 AND state='pending'",[l.id]);
   }
  }
  await sql.query('UPDATE purchase_receipts SET approval=$1,version=version+1 WHERE id=$2',[{approve:'approved',reject:'rejected',reverse:'reversed'}[b.action],id]);
  for(const l of lines)await sql.query("UPDATE purchase_order_lines SET received_qty=(SELECT coalesce(sum(l.quantity),0) FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.tenant_id=l.tenant_id AND r.id=l.receipt_id WHERE l.purchase_line_id=$1 AND r.approval='approved') WHERE id=$1",[l.purchase_line_id]);
  return id;
 },false);
 type IQC=Action&{conclusion?:string;sample_qty?:string;sample_good?:string;sample_defect?:string;released_qty?:string;blocked_qty?:string};
 post<IQC>('/api/incoming-inspections/:id/actions','quality.write',actionSchema(['complete','reverse','reinspect'],{conclusion:{type:'string',enum:['pass','fail','partial']},sample_qty:qtyField,sample_good:qtyField,sample_defect:qtyField,released_qty:qtyField,blocked_qty:qtyField}),'incoming_inspection','incoming_inspection.action',async(sql,a,b,id)=>{
  const r=await locked(sql,'incoming_inspection',id,b.version),l=(await sql.query<{warehouse_id:string;product_id:string;unit_id:string;amount_cents:string;approval:string}>('SELECT r.warehouse_id,l.product_id,l.unit_id,l.amount_cents::text,r.approval FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.tenant_id=l.tenant_id AND r.id=l.receipt_id WHERE l.id=$1',[r.receipt_line_id])).rows[0]!;
  if(l.approval!=='approved')throw conflict();const n=qty(String(r.quantity));
  if(b.action==='reinspect'){
   if(r.state!=='reversed'||(await sql.query("SELECT id FROM incoming_inspections WHERE receipt_line_id=$1 AND state IN ('pending','completed')",[r.receipt_line_id])).rows[0])throw conflict();
   reason(b.reason);return (await sql.query<{id:string}>('INSERT INTO incoming_inspections(tenant_id,code,receipt_line_id,quantity,reason,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[a.tenant_id,await nextCode(sql,a,'IQC'),r.receipt_line_id,String(r.quantity),b.reason,a.user_id])).rows[0]!.id;
  }
  if(b.action==='complete'){
   if(r.state!=='pending')throw conflict();if(!b.conclusion||b.sample_qty===undefined||b.sample_good===undefined||b.sample_defect===undefined||b.released_qty===undefined||b.blocked_qty===undefined)throw new Problem(422,'QUALITY_FIELDS','需明确抽样结果、整批放行量与冻结量');
   const sample=qty(b.sample_qty),good=qty(b.sample_good),bad=qty(b.sample_defect),release=qty(b.released_qty),block=qty(b.blocked_qty);
   if(sample>n||good+bad!==sample||release+block!==n||(b.conclusion==='pass'&&block>0n)||(b.conclusion==='fail'&&release>0n)||(b.conclusion==='partial'&&(release===0n||block===0n)))throw new Problem(422,'QUALITY_QUANTITY','抽样与整批判定不一致');if(block>0n||sample===0n)reason(b.reason);
   await qualityTransfer(sql,a,{warehouseId:l.warehouse_id,productId:l.product_id,unitId:l.unit_id,quantity:n,value:BigInt(l.amount_cents),release,block,eventKey:'iqc:'+id,sourceId:id});
   await sql.query("UPDATE incoming_inspections SET state='completed',conclusion=$1,sample_qty=$2,sample_good=$3,sample_defect=$4,released_qty=$5,blocked_qty=$6,reason=$7,version=version+1 WHERE id=$8",[b.conclusion,b.sample_qty,b.sample_good,b.sample_defect,b.released_qty,b.blocked_qty,b.reason??'',id]);
  }else{
   if(r.state!=='completed')throw conflict();reason(b.reason);await qualityTransfer(sql,a,{warehouseId:l.warehouse_id,productId:l.product_id,unitId:l.unit_id,quantity:n,value:BigInt(l.amount_cents),release:qty(String(r.released_qty)),block:qty(String(r.blocked_qty)),eventKey:'iqc:'+id,sourceId:id,reverse:true});await sql.query("UPDATE incoming_inspections SET state='reversed',reason=$1,version=version+1 WHERE id=$2",[b.reason,id]);
  }return id;
 },false);

 post<{request_key:string;work_order_id:string}>('/api/mrp-batches','planning.write',shape(['request_key','work_order_id'],{request_key:keyField,work_order_id:uuid}),'mrp_batch','mrp_batch.create',async(sql,a,b)=>{
  const wo=(await sql.query<{id:string;version:number;bom_version_id:string;warehouse_id:string;execution:string}>('SELECT id,version,bom_version_id,warehouse_id,execution FROM work_orders WHERE id=$1 FOR UPDATE',[b.work_order_id])).rows[0];if(!wo||!['not_started','running'].includes(wo.execution))throw new Problem(422,'WORK_ORDER_REQUIRED','只能为未完成的加工单算料');
  const materials=(await sql.query<{id:string;product_id:string;unit_id:string;required_qty:string;issued_qty:string}>('SELECT *,required_qty::text,issued_qty::text FROM work_order_materials WHERE work_order_id=$1 ORDER BY product_id',[wo.id])).rows;
  const inputs:Record<string,unknown>[]=[];
  const id=(await sql.query<{id:string}>('INSERT INTO mrp_batches(tenant_id,code,work_order_id,work_order_version,bom_version_id,inputs,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[a.tenant_id,await nextCode(sql,a,'MRP'),wo.id,wo.version,wo.bom_version_id,JSON.stringify([]),a.user_id])).rows[0]!.id;
  for(const m of materials){
   const balance=await lockBalance(sql,a,wo.warehouse_id,m.product_id,m.unit_id);
   const version=(await sql.query<{version:number}>('SELECT version FROM stock_balances WHERE warehouse_id=$1 AND product_id=$2 AND unit_id=$3',[wo.warehouse_id,m.product_id,m.unit_id])).rows[0]!.version;
   const owned=qty((await sql.query<{n:string}>('SELECT coalesce(sum(remaining_qty),0)::text AS n FROM stock_reservations WHERE work_order_id=$1 AND product_id=$2 AND unit_id=$3 AND warehouse_id=$4',[wo.id,m.product_id,m.unit_id,wo.warehouse_id])).rows[0]!.n);
   const purchased=qty((await sql.query<{n:string}>("SELECT coalesce(sum(l.quantity-l.received_qty),0)::text AS n FROM purchase_order_lines l JOIN purchase_orders p ON p.tenant_id=l.tenant_id AND p.id=l.order_id JOIN mrp_lines ml ON ml.tenant_id=l.tenant_id AND ml.id=l.mrp_line_id JOIN mrp_batches mb ON mb.tenant_id=ml.tenant_id AND mb.id=ml.batch_id WHERE mb.work_order_id=$1 AND l.product_id=$2 AND p.lifecycle='open' AND p.approval<>'rejected'",[wo.id,m.product_id])).rows[0]!.n);
   const heldPurchase=qty((await sql.query<{n:string}>("SELECT coalesce(sum(i.quantity),0)::text AS n FROM incoming_inspections i JOIN purchase_receipt_lines rl ON rl.tenant_id=i.tenant_id AND rl.id=i.receipt_line_id JOIN purchase_receipts pr ON pr.tenant_id=rl.tenant_id AND pr.id=rl.receipt_id JOIN purchase_order_lines pl ON pl.tenant_id=rl.tenant_id AND pl.id=rl.purchase_line_id JOIN mrp_lines ml ON ml.tenant_id=pl.tenant_id AND ml.id=pl.mrp_line_id JOIN mrp_batches mb ON mb.tenant_id=ml.tenant_id AND mb.id=ml.batch_id WHERE mb.work_order_id=$1 AND rl.product_id=$2 AND pr.approval='approved' AND i.state='pending'",[wo.id,m.product_id])).rows[0]!.n);
   const required=qty(m.required_qty)-qty(m.issued_qty),ready=available(balance)+owned,shortage=required>ready+purchased+heldPurchase?required-ready-purchased-heldPurchase:0n;
   inputs.push({material_id:m.id,product_id:m.product_id,unit_id:m.unit_id,warehouse_id:wo.warehouse_id,stock_version:version,issued_qty:m.issued_qty,required_qty:m.required_qty,owned:formatDecimal(owned),open_purchase:formatDecimal(purchased),held_purchase:formatDecimal(heldPurchase)});
   await sql.query('INSERT INTO mrp_lines(tenant_id,batch_id,material_id,product_id,unit_id,required_qty,available_qty,shortage_qty) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[a.tenant_id,id,m.id,m.product_id,m.unit_id,formatDecimal(required),formatDecimal(ready),formatDecimal(shortage)]);
  }
  await sql.query('UPDATE mrp_batches SET inputs=$1 WHERE id=$2',[JSON.stringify(inputs),id]);return id;
 });
 post<Action>('/api/mrp-batches/:id/actions','planning.write',actionSchema(['reserve','release']),'mrp_batch','mrp_batch.action',async(sql,a,b,id)=>{
  const r=await locked(sql,'mrp_batch',id,b.version);
  const wo=(await sql.query<{id:string;version:number;execution:string}>('SELECT id,version,execution FROM work_orders WHERE id=$1 FOR UPDATE',[r.work_order_id])).rows[0]!;
  if(b.action==='release'){
   if(r.state==='released')throw conflict();reason(b.reason);
   const rows=(await sql.query<{id:string;warehouse_id:string;product_id:string;unit_id:string;remaining_qty:string}>('SELECT *,remaining_qty::text FROM stock_reservations WHERE batch_id=$1 AND remaining_qty>0 ORDER BY product_id,id FOR UPDATE',[id])).rows;
   for(const x of rows){const bal=await lockBalance(sql,a,x.warehouse_id,x.product_id,x.unit_id);bal.reserved_qty=formatDecimal(qty(bal.reserved_qty)-qty(x.remaining_qty));await saveBalance(sql,x.warehouse_id,x.product_id,x.unit_id,bal);await sql.query('UPDATE stock_reservations SET released_qty=released_qty+remaining_qty,remaining_qty=0 WHERE id=$1',[x.id]);}
  }else{
   if(r.state!=='calculated'||wo.version!==r.work_order_version||wo.execution==='cancelled')throw new Problem(409,'MRP_STALE','加工单或算料批次已变化，请重新算料');
   const inputs=r.inputs as {material_id:string;product_id:string;unit_id:string;warehouse_id:string;stock_version:number;issued_qty:string;required_qty:string;owned:string}[];
   for(const x of inputs){
    const bal=await lockBalance(sql,a,x.warehouse_id,x.product_id,x.unit_id),ver=(await sql.query<{version:number}>('SELECT version FROM stock_balances WHERE warehouse_id=$1 AND product_id=$2 AND unit_id=$3',[x.warehouse_id,x.product_id,x.unit_id])).rows[0]!.version;
    const m=(await sql.query<{issued_qty:string;required_qty:string}>('SELECT issued_qty::text,required_qty::text FROM work_order_materials WHERE id=$1',[x.material_id])).rows[0]!;
    if(ver!==x.stock_version||qty(m.issued_qty)!==qty(x.issued_qty)||qty(m.required_qty)!==qty(x.required_qty))throw new Problem(409,'MRP_STALE','库存或领料发生变化，请重新算料');
    const need=qty(m.required_qty)-qty(m.issued_qty)-qty(x.owned),amount=need>0n?(need<available(bal)?need:available(bal)):0n;
    if(amount>0n){await sql.query('INSERT INTO stock_reservations(tenant_id,batch_id,work_order_id,warehouse_id,product_id,unit_id,quantity,remaining_qty) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',[a.tenant_id,id,wo.id,x.warehouse_id,x.product_id,x.unit_id,formatDecimal(amount)]);bal.reserved_qty=formatDecimal(qty(bal.reserved_qty)+amount);await saveBalance(sql,x.warehouse_id,x.product_id,x.unit_id,bal);x.stock_version++;}
   }
   await sql.query('UPDATE mrp_batches SET inputs=$1 WHERE id=$2',[JSON.stringify(inputs),id]);
  }await sql.query('UPDATE mrp_batches SET state=$1,version=version+1 WHERE id=$2',[b.action==='reserve'?'reserved':'released',id]);return id;
 },false);
 type WageRule={request_key:string;code:string;mode:'piece'|'time';rate:string;process_ids:string[];product_id?:string;reason?:string;version?:number;active?:boolean};
 const wageSchema=shape(['request_key','code','mode','rate','process_ids'],{request_key:keyField,code:shortText(64),mode:{type:'string',enum:['piece','time']},rate:rateField,process_ids:array(uuid),product_id:uuid,reason:reasonField});
 async function wageDefinition(sql:Sql,a:Actor,b:WageRule,id?:string){
  if(new Set(b.process_ids).size!==b.process_ids.length)throw new Problem(422,'DUPLICATE_PROCESS','工序不可重复');
  const procs=(await sql.query('SELECT id FROM processes WHERE id=ANY($1::uuid[]) AND active',[b.process_ids])).rows;if(procs.length!==b.process_ids.length)throw new Problem(422,'INVALID_REFERENCE','工资规则工序不存在或停用');if(b.product_id)await product(sql,b.product_id);
  if(rate(b.rate)===0n)reason(b.reason);
  if((await sql.query('SELECT id FROM wage_rules WHERE active AND product_id IS NOT DISTINCT FROM $1::uuid AND process_ids && $2::uuid[] AND ($3::uuid IS NULL OR id<>$3) LIMIT 1',[b.product_id??null,b.process_ids,id??null])).rows[0])throw new Problem(409,'WAGE_RULE_CONFLICT','同一产品层级的工序只能有一条有效工资规则，计件与计时不能重复');
  if(!id)id=(await sql.query<{id:string}>('INSERT INTO wage_rules(tenant_id,code,product_id,process_ids,mode,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[a.tenant_id,b.code,b.product_id??null,b.process_ids,b.mode,a.user_id])).rows[0]!.id;
  else{reason(b.reason);await locked(sql,'wage_rule',id,b.version!);await sql.query('UPDATE wage_rules SET code=$1,product_id=$2,process_ids=$3,mode=$4,current_revision=current_revision+1,version=version+1 WHERE id=$5',[b.code,b.product_id??null,b.process_ids,b.mode,id]);}
  const rev=(await sql.query<{current_revision:number}>('SELECT current_revision FROM wage_rules WHERE id=$1',[id])).rows[0]!.current_revision;
  await sql.query('INSERT INTO wage_rule_versions(tenant_id,rule_id,revision,rate,product_id,process_ids,mode,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[a.tenant_id,id,rev,b.rate,b.product_id??null,b.process_ids,b.mode,a.user_id]);return id;
 }
 post<WageRule>('/api/wage-rules','payroll.manage',wageSchema,'wage_rule','wage_rule.create',(sql,a,b)=>wageDefinition(sql,a,b));
 post<WageRule>('/api/wage-rules/:id/revisions','payroll.manage',shape(['request_key','version','reason','code','mode','rate','process_ids'],{...wageSchema.properties,version:versionField}),'wage_rule','wage_rule.revise',(sql,a,b,id)=>wageDefinition(sql,a,b,id),false);
 post<Action>('/api/wage-rules/:id/actions','payroll.manage',actionSchema(['deactivate']),'wage_rule','wage_rule.action',async(sql,a,b,id)=>{await locked(sql,'wage_rule',id,b.version);reason(b.reason);await sql.query('UPDATE wage_rules SET active=false,version=version+1 WHERE id=$1',[id]);return id;},false);
 get('/api/wages','payroll.read',async sql=>({items:(await sql.query("SELECT e.id,e.report_id,r.code AS report_code,e.work_order_id,w.code AS work_order_code,e.worker_id,e.worker_name AS display_name,e.amount_cents::text,e.calculation_snapshot,e.reversal_of,e.posted_at,(r.settlement_status='settled') AS settled FROM wage_events e JOIN production_reports r ON r.tenant_id=e.tenant_id AND r.id=e.report_id JOIN work_orders w ON w.tenant_id=e.tenant_id AND w.id=e.work_order_id ORDER BY e.posted_at DESC LIMIT 500")).rows.map(r=>({...r,amount:money(BigInt(String(r.amount_cents)))})),limit:500}));
 post<{request_key:string;event_ids:string[];reason?:string}>('/api/wage-settlements','payroll.approve',shape(['request_key','event_ids'],{request_key:keyField,event_ids:array(uuid),reason:{type:'string',maxLength:500}}),'wage_settlement','wage_settlement.create',async(sql,a,b)=>{
  if(new Set(b.event_ids).size!==b.event_ids.length)throw new Problem(422,'DUPLICATE_LINE','工资事件不可重复');
  const note=(b.reason??'').trim();
  const id=(await sql.query<{id:string}>('INSERT INTO wage_settlements(tenant_id,code,reason,created_by) VALUES($1,$2,$3,$4) RETURNING id',[a.tenant_id,await nextCode(sql,a,'PAYROLL'),note,a.user_id])).rows[0]!.id;
  for(const event of b.event_ids){
   const e=(await sql.query<{id:string}>("SELECT e.id FROM wage_events e JOIN production_reports r ON r.tenant_id=e.tenant_id AND r.id=e.report_id WHERE e.id=$1 AND e.reversal_of IS NULL AND r.approval='approved' AND NOT EXISTS(SELECT 1 FROM wage_events rev WHERE rev.reversal_of=e.id)",[event])).rows[0];if(!e)throw new Problem(422,'INVALID_WAGE_SOURCE','只能结算尚未冲销的已审核工资来源');
   if((await sql.query("SELECT l.id FROM wage_settlement_lines l JOIN wage_settlements s ON s.tenant_id=l.tenant_id AND s.id=l.settlement_id WHERE l.wage_event_id=$1 AND s.state='approved'",[event])).rows[0])throw new Problem(409,'ALREADY_SETTLED','工资已结算，不能重复');
   await sql.query('INSERT INTO wage_settlement_lines(tenant_id,settlement_id,wage_event_id) VALUES($1,$2,$3)',[a.tenant_id,id,event]);
   await sql.query("UPDATE production_reports r SET settlement_status='settled',settled_by=$2,settled_at=now(),settlement_note=CASE WHEN $3<>'' THEN $3 ELSE r.settlement_note END FROM wage_events e WHERE e.id=$1 AND e.report_id=r.id AND r.settlement_status='unsettled'",[event,a.user_id,note]);
  }return id;
 });
 post<Action>('/api/wage-settlements/:id/actions','payroll.approve',actionSchema(['reverse']),'wage_settlement','wage_settlement.action',async(sql,a,b,id)=>{const r=await locked(sql,'wage_settlement',id,b.version);if(r.state!=='approved')throw conflict();reason(b.reason);await sql.query("UPDATE production_reports pr SET settlement_status='unsettled',settled_by=NULL,settled_at=NULL WHERE pr.id IN (SELECT e.report_id FROM wage_settlement_lines l JOIN wage_events e ON e.tenant_id=l.tenant_id AND e.id=l.wage_event_id WHERE l.settlement_id=$1) AND NOT EXISTS (SELECT 1 FROM wage_settlement_lines l2 JOIN wage_settlements s2 ON s2.tenant_id=l2.tenant_id AND s2.id=l2.settlement_id AND s2.state='approved' AND s2.id<>$1 JOIN wage_events e2 ON e2.tenant_id=l2.tenant_id AND e2.id=l2.wage_event_id WHERE e2.report_id=pr.id)",[id]);await sql.query("UPDATE wage_settlements SET state='reversed',reason=$1,version=version+1 WHERE id=$2",[b.reason,id]);return id;},false);
 get('/api/open-items','finance.read',async sql=>({items:(await sql.query("SELECT i.*,i.amount_cents::text,i.allocated_cents::text,coalesce(c.name,s.name) AS party_name FROM open_items i LEFT JOIN customers c ON i.kind='receivable' AND c.tenant_id=i.tenant_id AND c.id=i.party_id LEFT JOIN suppliers s ON i.kind='payable' AND s.tenant_id=i.tenant_id AND s.id=i.party_id ORDER BY i.created_at DESC LIMIT 500")).rows.map(r=>({...r,amount:money(BigInt(String(r.amount_cents))),allocated_amount:money(BigInt(String(r.allocated_cents))),outstanding_amount:money(r.reversed?0n:BigInt(String(r.amount_cents))-BigInt(String(r.allocated_cents)))})),limit:500}));
 type Payment={request_key:string;kind:'receivable'|'payable';party_id:string;amount:string;payment_date:string;method:string;reference?:string;allocations:{open_item_id:string;amount:string}[]};
 post<Payment>('/api/payments','finance.write',shape(['request_key','kind','party_id','amount','payment_date','method','allocations'],{request_key:keyField,kind:{type:'string',enum:['receivable','payable']},party_id:uuid,amount:cashField,payment_date:dateField,method:shortText(80),reference:{type:'string',maxLength:200},allocations:{type:'array',maxItems:100,items:shape(['open_item_id','amount'],{open_item_id:uuid,amount:cashField})}}),'payment','payment.create',async(sql,a,b)=>{
  calendarDate(b.payment_date);const amount=cents(b.amount);if(amount<=0n)throw new Problem(422,'AMOUNT_REQUIRED','收付款金额须大于零');
  if(!(await sql.query('SELECT id FROM '+(b.kind==='receivable'?'customers':'suppliers')+' WHERE id=$1 AND active',[b.party_id])).rows[0])throw new Problem(422,'INVALID_REFERENCE','往来对象不存在或停用');
  if(new Set(b.allocations.map(x=>x.open_item_id)).size!==b.allocations.length)throw new Problem(422,'DUPLICATE_LINE','同一往来来源不能重复核销');
  if(b.allocations.reduce((n,x)=>n+cents(x.amount),0n)>amount)throw new Problem(422,'OVER_ALLOCATION','核销总额不能超过本笔收付款');
  const id=(await sql.query<{id:string}>('INSERT INTO payments(tenant_id,code,kind,party_id,amount_cents,payment_date,method,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[a.tenant_id,await nextCode(sql,a,b.kind==='receivable'?'RC':'PC'),b.kind,b.party_id,amount.toString(),b.payment_date,b.method,b.reference??'',a.user_id])).rows[0]!.id;
  for(const x of b.allocations){const item=(await sql.query<{kind:string;party_id:string;reversed:boolean;amount_cents:string;allocated_cents:string}>('SELECT *,amount_cents::text,allocated_cents::text FROM open_items WHERE id=$1 FOR UPDATE',[x.open_item_id])).rows[0];const n=cents(x.amount);if(!item||item.reversed||item.kind!==b.kind||item.party_id!==b.party_id||n<=0n||n>BigInt(item.amount_cents)-BigInt(item.allocated_cents))throw new Problem(422,'INVALID_ALLOCATION','核销来源不匹配或超出未核销余额');await sql.query('INSERT INTO payment_allocations(tenant_id,payment_id,open_item_id,amount_cents) VALUES($1,$2,$3,$4)',[a.tenant_id,id,x.open_item_id,n.toString()]);}return id;
 });
 post<Action>('/api/payments/:id/actions','finance.approve',actionSchema(['approve','reject','reverse']),'payment','payment.action',async(sql,a,b,id)=>{
  const r=await locked(sql,'payment',id,b.version);if(b.action==='reverse'){if(r.approval!=='approved')throw conflict();reason(b.reason);}else{if(r.approval!=='pending')throw conflict();if(b.action==='reject')reason(b.reason);}
  const lines=(await sql.query<{id:string;open_item_id:string;amount_cents:string}>('SELECT *,amount_cents::text FROM payment_allocations WHERE payment_id=$1 ORDER BY open_item_id',[id])).rows;
  if(b.action!=='reject')for(const l of lines){
   const item=(await sql.query<{amount_cents:string;allocated_cents:string;reversed:boolean;kind:string;party_id:string}>('SELECT *,amount_cents::text,allocated_cents::text FROM open_items WHERE id=$1 FOR UPDATE',[l.open_item_id])).rows[0]!;
   const amount=BigInt(l.amount_cents),rev=b.action==='reverse';
   if(item.reversed||item.kind!==r.kind||item.party_id!==r.party_id||(!rev&&amount>BigInt(item.amount_cents)-BigInt(item.allocated_cents)))throw new Problem(409,'ALLOCATION_CONFLICT','往来余额已变化，请重新核销');
   if(rev){
    const events=(await sql.query<{id:string;settled_cents:string}>('SELECT id,settled_cents::text FROM financial_events WHERE payment_id=$1 AND open_item_id=$2 AND settled_cents>0 AND reversal_of IS NULL',[id,l.open_item_id])).rows;
    if(events.reduce((n,e)=>n+BigInt(e.settled_cents),0n)!==amount)throw new Problem(409,'ALLOCATION_CONFLICT','款项分配与事件不一致，需核对原记录');
    for(const e of events)await sql.query('INSERT INTO financial_events(tenant_id,open_item_id,payment_id,event_key,settled_cents,reversal_of,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[a.tenant_id,l.open_item_id,id,'payment_reverse:'+e.id,(-BigInt(e.settled_cents)).toString(),e.id,a.user_id]);
   }else await sql.query('INSERT INTO financial_events(tenant_id,open_item_id,payment_id,event_key,settled_cents,created_by) VALUES($1,$2,$3,$4,$5,$6)',[a.tenant_id,l.open_item_id,id,'payment:'+l.id,amount.toString(),a.user_id]);
   await sql.query('UPDATE open_items SET allocated_cents=allocated_cents+$1 WHERE id=$2',[(rev?-amount:amount).toString(),l.open_item_id]);
  }
  await sql.query('UPDATE payments SET approval=$1,version=version+1 WHERE id=$2',[{approve:'approved',reject:'rejected',reverse:'reversed'}[b.action],id]);return id;
 },false);
 get('/api/work-orders/:id/costs','finance.read',async(sql,a,id)=>{
  if(!(await sql.query('SELECT id FROM work_orders WHERE id=$1',[id])).rows[0])throw missing();
  const {material_cents,labor_cents,expense_cents,total_cents,...cost}=await workCosts(sql,id);
  const sources=(await sql.query("SELECT c.id,c.event_key,c.source_type,c.source_id,c.amount_cents::text,c.direction,c.reversal_of,c.posted_at FROM stock_cost_events c JOIN material_issues i ON c.source_type='material_issue' AND i.tenant_id=c.tenant_id AND i.id=c.source_id WHERE i.work_order_id=$1 UNION ALL SELECT c.id,c.event_key,c.source_type,c.source_id,c.amount_cents::text,c.direction,c.reversal_of,c.posted_at FROM stock_cost_events c JOIN production_supplements s ON c.source_type='supplement_issue' AND s.tenant_id=c.tenant_id AND s.id=c.source_id WHERE s.work_order_id=$1 ORDER BY posted_at",[id])).rows.map(r=>({...r,amount:r.amount_cents===null?null:money(BigInt(String(r.amount_cents)))}));
  const expenses=(await sql.query<{amount_cents:string}>('SELECT e.id,e.expense_id,d.code,d.category,e.event_key,e.amount_cents::text,e.reversal_of,e.allocation_snapshot,e.posted_at FROM expense_cost_events e JOIN expense_documents d ON d.tenant_id=e.tenant_id AND d.id=e.expense_id WHERE e.work_order_id=$1 ORDER BY e.posted_at,e.id',[id])).rows.map(r=>({...r,amount:money(BigInt(r.amount_cents))}));
  return {cost,sources,expenses};
 });
 get('/api/financial-summary','finance.read',async sql=>{
  const debts=(await sql.query<{kind:string;debt:string;settled:string}>("SELECT i.kind,coalesce(sum(e.debt_cents),0)::text AS debt,coalesce(sum(e.settled_cents),0)::text AS settled FROM financial_events e JOIN open_items i ON i.tenant_id=e.tenant_id AND i.id=e.open_item_id GROUP BY i.kind")).rows;
  const cash=(await sql.query<{kind:string;n:string}>("SELECT kind,coalesce(sum(amount_cents),0)::text AS n FROM payments WHERE approval='approved' GROUP BY kind")).rows;
  const costRows=(await sql.query<{amount_cents:string|null}>("SELECT c.amount_cents::text FROM stock_cost_events c JOIN shipments s ON s.tenant_id=c.tenant_id AND s.id=c.source_id WHERE c.source_type='shipment' AND c.direction='out' AND c.reversal_of IS NULL AND s.approval='approved'")).rows;
  const legacy=(await sql.query<{missing_cost:string;missing_trade:string}>("SELECT count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM stock_cost_events c WHERE c.tenant_id=s.tenant_id AND c.source_type='shipment' AND c.source_id=s.id AND c.direction='out' AND c.reversal_of IS NULL))::text AS missing_cost,count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM open_items i WHERE i.tenant_id=s.tenant_id AND i.source_type='shipment' AND i.source_id=s.id AND NOT i.reversed))::text AS missing_trade FROM shipments s WHERE s.approval='approved'")).rows[0]!;
  const missingTrade=Number(legacy.missing_trade),missingCost=Number(legacy.missing_cost);
  const revenue=BigInt(debts.find(r=>r.kind==='receivable')?.debt??'0'),costKnown=missingCost===0&&costRows.every(r=>r.amount_cents!==null),cost=costKnown?costRows.reduce((n,r)=>n+BigInt(r.amount_cents!),0n):null;
  const production=(await sql.query<{operation:string;output:string}>("SELECT ((SELECT coalesce(sum(good_qty),0) FROM production_reports WHERE approval='approved')+(SELECT coalesce(sum(good_qty),0) FROM rework_reports WHERE approval='approved'))::text AS operation,(SELECT coalesce(sum(quantity),0) FROM fg_receipts WHERE approval='approved')::text AS output")).rows[0]!;
  const operation=(await sql.query<{n:string}>("SELECT ((SELECT coalesce(sum(good_qty+defect_qty),0) FROM production_reports WHERE approval='approved')+(SELECT coalesce(sum(good_qty+defect_qty),0) FROM rework_reports WHERE approval='approved'))::text AS n")).rows[0]!.n;
  const unknownWages=Number((await sql.query<{n:string}>("SELECT ((SELECT count(*) FROM production_reports WHERE approval='approved' AND (wage_snapshot IS NULL OR wage_snapshot->>'status' IS DISTINCT FROM 'priced'))+(SELECT count(*) FROM rework_reports WHERE approval='approved' AND (wage_snapshot IS NULL OR wage_snapshot->>'status' IS DISTINCT FROM 'priced')))::text AS n")).rows[0]!.n);
  const wage=unknownWages>0?null:BigInt((await sql.query<{n:string}>('SELECT coalesce(sum(amount_cents),0)::text AS n FROM wage_events')).rows[0]!.n);
  const stock=(await sql.query<{unknown:string;value:string}>('SELECT count(*) FILTER(WHERE released_value_cents IS NULL AND on_hand>0)::text AS unknown,coalesce(sum(released_value_cents+held_value_cents+blocked_value_cents),0)::text AS value FROM stock_balances')).rows[0]!;
  const transit=(await sql.query<{unknown:string;value:string}>("SELECT count(*) FILTER(WHERE amount_cents IS NULL)::text AS unknown,coalesce(sum(amount_cents),0)::text AS value FROM warehouse_transfers WHERE state='in_transit'")).rows[0]!;
  return {receivable:missingTrade>0?null:money(revenue),registered_receivable:money(revenue),received:money(BigInt(cash.find(r=>r.kind==='receivable')?.n??'0')),allocated_received:money(BigInt(debts.find(r=>r.kind==='receivable')?.settled??'0')),unallocated_received:money(BigInt(cash.find(r=>r.kind==='receivable')?.n??'0')-BigInt(debts.find(r=>r.kind==='receivable')?.settled??'0')),receivable_outstanding:missingTrade>0?null:money(revenue-BigInt(debts.find(r=>r.kind==='receivable')?.settled??'0')),payable:money(BigInt(debts.find(r=>r.kind==='payable')?.debt??'0')),paid:money(BigInt(cash.find(r=>r.kind==='payable')?.n??'0')),allocated_paid:money(BigInt(debts.find(r=>r.kind==='payable')?.settled??'0')),unallocated_paid:money(BigInt(cash.find(r=>r.kind==='payable')?.n??'0')-BigInt(debts.find(r=>r.kind==='payable')?.settled??'0')),payable_outstanding:money(BigInt(debts.find(r=>r.kind==='payable')?.debt??'0')-BigInt(debts.find(r=>r.kind==='payable')?.settled??'0')),sales_cost:money(cost),gross_profit:cost===null||missingTrade>0?null:money(revenue-cost),gross_margin_percent:cost===null||missingTrade>0||revenue===0n?null:money(round((revenue-cost)*10000n,revenue)),wage:money(wage),inventory_value:Number(stock.unknown)>0?null:money(BigInt(stock.value)),in_transit_value:Number(transit.unknown)>0?null:money(BigInt(transit.value)),inventory_including_transit_value:Number(stock.unknown)+Number(transit.unknown)>0?null:money(BigInt(stock.value)+BigInt(transit.value)),unpriced_in_transit:Number(transit.unknown),unpriced_inventory_pools:Number(stock.unknown),process_good_qty:formatDecimal(qty(production.operation)),process_reported_qty:formatDecimal(qty(operation)),finished_receipt_qty:formatDecimal(qty(production.output)),unpriced_wage_reports:unknownWages,unsourced_shipments:missingTrade,unpriced_shipments:missingCost,cost_status:costKnown&&missingTrade===0?'priced':'unpriced'};
 });

 type Allocation={request_key:string;version:number;reason:string;allocations:{open_item_id:string;amount:string}[]};
 post<Allocation>('/api/payments/:id/allocations','finance.approve',shape(['request_key','version','reason','allocations'],{request_key:keyField,version:versionField,reason:reasonField,allocations:array(shape(['open_item_id','amount'],{open_item_id:uuid,amount:cashField}))}),'payment','payment.allocate',async(sql,a,b,id)=>{
  reason(b.reason);const p=await locked(sql,'payment',id,b.version);if(p.approval!=='approved')throw conflict();
  if(new Set(b.allocations.map(x=>x.open_item_id)).size!==b.allocations.length)throw new Problem(422,'DUPLICATE_LINE','来源不可重复');
  const used=BigInt((await sql.query<{n:string}>('SELECT coalesce(sum(amount_cents),0)::text AS n FROM payment_allocations WHERE payment_id=$1',[id])).rows[0]!.n);
  if(used+b.allocations.reduce((n,x)=>n+cents(x.amount),0n)>BigInt(String(p.amount_cents)))throw new Problem(422,'OVER_ALLOCATION','核销金额超出本笔收付款未分配金额');
  for(const x of b.allocations){
   const i=(await sql.query<{kind:string;party_id:string;amount_cents:string;allocated_cents:string;reversed:boolean}>('SELECT *,amount_cents::text,allocated_cents::text FROM open_items WHERE id=$1 FOR UPDATE',[x.open_item_id])).rows[0],n=cents(x.amount);
   if(!i||i.kind!==p.kind||i.party_id!==p.party_id||i.reversed||n<=0n||n>BigInt(i.amount_cents)-BigInt(i.allocated_cents))throw new Problem(422,'INVALID_ALLOCATION','来源不匹配或核销超量');
   await sql.query('INSERT INTO payment_allocations(tenant_id,payment_id,open_item_id,amount_cents) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,payment_id,open_item_id) DO UPDATE SET amount_cents=payment_allocations.amount_cents+EXCLUDED.amount_cents',[a.tenant_id,id,i?x.open_item_id:null,n.toString()]);
   await sql.query('INSERT INTO financial_events(tenant_id,open_item_id,payment_id,event_key,settled_cents,created_by) VALUES($1,$2,$3,$4,$5,$6)',[a.tenant_id,x.open_item_id,id,'payment_allocate:'+b.request_key+':'+x.open_item_id,n.toString(),a.user_id]);
   await sql.query('UPDATE open_items SET allocated_cents=allocated_cents+$1 WHERE id=$2',[n.toString(),x.open_item_id]);
  }await sql.query('UPDATE payments SET version=version+1 WHERE id=$1',[id]);return id;
 },false);
 get('/api/financial-parties','finance.read',async sql=>({items:(await sql.query("SELECT id,name,'receivable' AS kind FROM customers WHERE active UNION ALL SELECT id,name,'payable' AS kind FROM suppliers WHERE active ORDER BY name LIMIT 500")).rows,limit:500}));
}
