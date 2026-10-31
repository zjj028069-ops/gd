import type {FastifyInstance} from 'fastify';
import type {Sql} from './database.js';
import {Problem,type Services,type Actor} from './services.js';
import {uuid,qtyField,rateField,keyField,reasonField,shape,qty,formatDecimal,money,round,lineCents,nextCode,product,warehouse,reason,permit} from './business-common.js';
import {extensionRoutes,lockRow,actionShape,stateConflict} from './extensions-common.js';
import {lockBalance,available,released,postStock} from './inventory.js';
type Action={request_key:string;action:string;version:number;reason?:string};
async function view(sql:Sql,table:string,id:string,a:Actor){
 const r=table==='warehouse_transfers'?(await sql.query<Record<string,unknown>>('SELECT *,quantity::text FROM warehouse_transfers WHERE id=$1',[id])).rows[0]:(await sql.query<Record<string,unknown>>('SELECT *,book_qty::text,actual_qty::text,delta_qty::text,unit_price::text FROM stock_counts WHERE id=$1',[id])).rows[0];
 if(!r)throw new Problem(404,'NOT_FOUND','单据不存在或不属于当前企业');
 const readValue=a.permissions.includes('finance.read'),events=(await sql.query<Record<string,unknown>>('SELECT l.id,l.event_key,l.direction,l.quantity::text,l.source_type,l.reversal_of,l.posted_at,c.amount_cents::text FROM stock_ledger l LEFT JOIN stock_cost_events c ON c.tenant_id=l.tenant_id AND c.stock_ledger_id=l.id WHERE l.source_id=$1 ORDER BY l.posted_at,l.id',[id])).rows;
 const {amount_cents,stock_snapshot,unit_price,...publicRow}=r;
 return {...publicRow,...(readValue?{amount:amount_cents===null?null:money(BigInt(String(amount_cents))),stock_snapshot,unit_price}:{}),events:events.map(e=>{const {amount_cents,...rest}=e;return {...rest,...(readValue?{amount:amount_cents===null?null:money(BigInt(String(amount_cents)))}:{})};}),persisted:true};
}
async function validate(sql:Sql,r:Record<string,unknown>){await product(sql,String(r.product_id));for(const key of ['warehouse_id','from_warehouse_id','to_warehouse_id'])if(r[key])await warehouse(sql,String(r[key]));}
async function countPreview(sql:Sql,a:Actor,b:{warehouse_id:string;product_id:string;actual_qty:string;unit_price?:string;reason:string}){
 await warehouse(sql,b.warehouse_id);const p=await product(sql,b.product_id),balance=await lockBalance(sql,a,b.warehouse_id,p.id,p.unit_id);
 const version=(await sql.query<{version:number}>('SELECT version FROM stock_balances WHERE warehouse_id=$1 AND product_id=$2 AND unit_id=$3',[b.warehouse_id,p.id,p.unit_id])).rows[0]!.version;
 const actual=qty(b.actual_qty),book=qty(balance.on_hand),protectedQty=qty(balance.held_qty)+qty(balance.blocked_qty)+qty(balance.reserved_qty);
 if(actual<protectedQty)throw new Problem(409,'PROTECTED_STOCK','实盘数量不能低于待检、冻结及预占数量；先核对这些来源');
 const delta=actual-book;let value:bigint|null=0n;
 if(delta>0n){
  if(b.unit_price!==undefined){permit(a,'finance.approve');reason(b.reason);value=lineCents(delta,b.unit_price);}
  else if(released(balance)>0n&&balance.released_value_cents!==null)value=round(BigInt(balance.released_value_cents)*delta,released(balance));
  else throw new Problem(422,'COUNT_PRICE_REQUIRED','盘盈缺少可继承的成本，请由财务授权填写单价和依据');
 }else if(delta<0n)value=balance.released_value_cents===null?null:round(BigInt(balance.released_value_cents)*(-delta),released(balance));
 return {product:p,book_qty:formatDecimal(book),actual_qty:formatDecimal(actual),delta_qty:formatDecimal(delta),stock_version:version,stock_snapshot:balance,amount_cents:value?.toString()??null};
}
export function registerWarehouseOperations(app:FastifyInstance,s:Services){
 const {get,post}=extensionRoutes(app,s),transferView=(sql:Sql,id:string,a:Actor)=>view(sql,'warehouse_transfers',id,a),countView=(sql:Sql,id:string,a:Actor)=>view(sql,'stock_counts',id,a);
 for(const [path,table,fn] of [['/api/warehouse-transfers','warehouse_transfers',transferView],['/api/stock-counts','stock_counts',countView]] as const){get(path,'inventory.read',async(sql,a)=>({items:await Promise.all((await sql.query<{id:string}>('SELECT id FROM '+table+' ORDER BY created_at DESC,id LIMIT 200')).rows.map(r=>fn(sql,r.id,a))),limit:200}));get(path+'/:id','inventory.read',async(sql,a,id)=>({document:await fn(sql,id,a)}));}
 get('/api/warehouse-transfers/in-transit/summary','inventory.read',async(sql,a)=>{
  const rows=(await sql.query<Record<string,unknown>>("SELECT from_warehouse_id,to_warehouse_id,product_id,unit_id,product_snapshot->>'name' AS product_name,product_snapshot->>'unit_name' AS unit_name,sum(quantity)::text AS quantity,sum(amount_cents)::text AS value,count(*) FILTER(WHERE amount_cents IS NULL)::text AS unknown FROM warehouse_transfers WHERE state='in_transit' GROUP BY from_warehouse_id,to_warehouse_id,product_id,unit_id,product_snapshot->>'name',product_snapshot->>'unit_name'")).rows;
  return {items:rows.map(r=>{const {value,unknown,...rest}=r;return {...rest,...(a.permissions.includes('finance.read')?{amount:Number(unknown)>0?null:money(BigInt(String(value)))}:{})};}),quantity_grain:'按产品单位分组；在途不计入任何仓库可用量'};
 });
 post<{request_key:string;from_warehouse_id:string;to_warehouse_id:string;product_id:string;quantity:string;reason:string}>('/api/warehouse-transfers','inventory.write',shape(['request_key','from_warehouse_id','to_warehouse_id','product_id','quantity','reason'],{request_key:keyField,from_warehouse_id:uuid,to_warehouse_id:uuid,product_id:uuid,quantity:qtyField,reason:reasonField}),'transfer','transfer.create',transferView,async(sql,a,b)=>{
  if(b.from_warehouse_id===b.to_warehouse_id)throw new Problem(422,'SAME_WAREHOUSE','发仓和收仓必须不同');if(qty(b.quantity)<=0n)throw new Problem(422,'QUANTITY_REQUIRED','调拨数量必须大于零');reason(b.reason);
  await warehouse(sql,b.from_warehouse_id);await warehouse(sql,b.to_warehouse_id);const p=await product(sql,b.product_id);
  return (await sql.query<{id:string}>('INSERT INTO warehouse_transfers(tenant_id,code,from_warehouse_id,to_warehouse_id,product_id,unit_id,quantity,product_snapshot,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id',[a.tenant_id,await nextCode(sql,a,'TR'),b.from_warehouse_id,b.to_warehouse_id,p.id,p.unit_id,b.quantity,JSON.stringify(p),b.reason,a.user_id])).rows[0]!.id;
 });
 post<Action>('/api/warehouse-transfers/:id/actions','inventory.approve',actionShape(['dispatch','receive','reverse_receive','reverse_dispatch','cancel']),'transfer','transfer.action',transferView,async(sql,a,b,id)=>{
  const r=await lockRow(sql,'warehouse_transfers',id,b.version);if(b.action==='cancel'){if(r.state!=='pending')throw stateConflict();reason(b.reason);await sql.query("UPDATE warehouse_transfers SET state='cancelled',reason=$2,version=version+1,updated_at=now() WHERE id=$1",[id,b.reason]);return id;}
  if(b.action==='dispatch'||b.action==='receive')await validate(sql,r);else reason(b.reason);
  const core={productId:String(r.product_id),unitId:String(r.unit_id),quantity:qty(String(r.quantity)),sourceId:id};
  if(b.action==='dispatch'){
   if(r.state!=='pending')throw stateConflict();const event='transfer_dispatch:'+id+':'+r.version;
   await postStock(sql,a,{...core,warehouseId:String(r.from_warehouse_id),direction:'out',sourceType:'transfer_out',eventKey:event});
   const cost=(await sql.query<{amount_cents:string|null}>('SELECT amount_cents::text FROM stock_cost_events WHERE event_key=$1',[event])).rows[0]!;
   await sql.query("UPDATE warehouse_transfers SET state='in_transit',amount_cents=$2,dispatch_event_key=$3,receive_event_key=NULL,version=version+1,updated_at=now() WHERE id=$1",[id,cost.amount_cents,event]);
  }else if(b.action==='receive'){
   if(r.state!=='in_transit')throw stateConflict();const event='transfer_receive:'+id+':'+r.version;
   await postStock(sql,a,{...core,warehouseId:String(r.to_warehouse_id),direction:'in',sourceType:'transfer_in',eventKey:event,valueCents:r.amount_cents===null?null:BigInt(String(r.amount_cents))});
   await sql.query("UPDATE warehouse_transfers SET state='received',receive_event_key=$2,version=version+1,updated_at=now() WHERE id=$1",[id,event]);
  }else if(b.action==='reverse_receive'){
   if(r.state!=='received')throw stateConflict();await postStock(sql,a,{...core,warehouseId:String(r.to_warehouse_id),direction:'out',sourceType:'transfer_in',eventKey:'transfer_reverse_receive:'+id+':'+r.version,originalEventKey:String(r.receive_event_key)});
   await sql.query("UPDATE warehouse_transfers SET state='in_transit',reason=$2,version=version+1,updated_at=now() WHERE id=$1",[id,b.reason]);
  }else{
   if(r.state!=='in_transit')throw stateConflict();await postStock(sql,a,{...core,warehouseId:String(r.from_warehouse_id),direction:'in',sourceType:'transfer_out',eventKey:'transfer_reverse_dispatch:'+id+':'+r.version,originalEventKey:String(r.dispatch_event_key)});
   await sql.query("UPDATE warehouse_transfers SET state='pending',amount_cents=NULL,dispatch_event_key=NULL,receive_event_key=NULL,reason=$2,version=version+1,updated_at=now() WHERE id=$1",[id,b.reason]);
  }return id;
 },false);
 type Count={request_key:string;warehouse_id:string;product_id:string;actual_qty:string;unit_price?:string;reason:string};
 post<Count>('/api/stock-counts','inventory.write',shape(['request_key','warehouse_id','product_id','actual_qty','reason'],{request_key:keyField,warehouse_id:uuid,product_id:uuid,actual_qty:qtyField,unit_price:rateField,reason:reasonField}),'count','count.create',countView,async(sql,a,b)=>{
  reason(b.reason);const p=await countPreview(sql,a,b);
  return (await sql.query<{id:string}>('INSERT INTO stock_counts(tenant_id,code,warehouse_id,product_id,unit_id,product_snapshot,book_qty,actual_qty,delta_qty,stock_version,stock_snapshot,unit_price,amount_cents,reason,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15) RETURNING id',[a.tenant_id,await nextCode(sql,a,'CT'),b.warehouse_id,p.product.id,p.product.unit_id,JSON.stringify(p.product),p.book_qty,p.actual_qty,p.delta_qty,p.stock_version,JSON.stringify(p.stock_snapshot),b.unit_price??null,p.amount_cents,b.reason,a.user_id])).rows[0]!.id;
 });
 post<Action>('/api/stock-counts/:id/actions','inventory.approve',actionShape(['approve','reverse','cancel']),'count','count.action',countView,async(sql,a,b,id)=>{
  const r=await lockRow(sql,'stock_counts',id,b.version),delta=qty(String(r.actual_qty))-qty(String(r.book_qty));
  if(b.action==='cancel'){if(r.state!=='pending')throw stateConflict();reason(b.reason);await sql.query("UPDATE stock_counts SET state='cancelled',reason=$2,version=version+1,updated_at=now() WHERE id=$1",[id,b.reason]);return id;}
  const core={warehouseId:String(r.warehouse_id),productId:String(r.product_id),unitId:String(r.unit_id),quantity:delta<0n?-delta:delta,sourceId:id,sourceType:'stock_count'};
  if(b.action==='approve'){
   if(r.state!=='pending')throw stateConflict();await validate(sql,r);await lockBalance(sql,a,core.warehouseId,core.productId,core.unitId);
   const v=(await sql.query<{version:number}>('SELECT version FROM stock_balances WHERE warehouse_id=$1 AND product_id=$2 AND unit_id=$3',[core.warehouseId,core.productId,core.unitId])).rows[0]!.version;
   if(v!==r.stock_version)throw new Problem(409,'COUNT_STALE','盘点预览后库存、质量或预占已变化，请取消原单并重新盘点');
   const event='count:'+id;if(delta!==0n)await postStock(sql,a,{...core,direction:delta>0n?'in':'out',eventKey:event,valueCents:r.amount_cents===null?null:BigInt(String(r.amount_cents))});
   await sql.query("UPDATE stock_counts SET state='approved',stock_event_key=$2,version=version+1,updated_at=now() WHERE id=$1",[id,delta===0n?null:event]);
  }else{
   if(r.state!=='approved')throw stateConflict();reason(b.reason);
   if(delta!==0n)await postStock(sql,a,{...core,direction:delta>0n?'out':'in',eventKey:'count_reverse:'+id,originalEventKey:String(r.stock_event_key)});
   await sql.query("UPDATE stock_counts SET state='reversed',reason=$2,version=version+1,updated_at=now() WHERE id=$1",[id,b.reason]);
  }return id;
 },false);
}
