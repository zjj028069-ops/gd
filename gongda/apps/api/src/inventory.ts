import {randomUUID} from 'node:crypto';
import type { Sql } from './database.js';
import { Problem, type Actor } from './services.js';
import { qty,formatDecimal,round } from './business-common.js';
import { receiptCost,shipmentTrade } from './accounting.js';
type Balance={on_hand:string;held_qty:string;blocked_qty:string;reserved_qty:string;released_value_cents:string|null;held_value_cents:string;blocked_value_cents:string;last_cost_event_id:string|null};
const fields='on_hand::text,held_qty::text,blocked_qty::text,reserved_qty::text,released_value_cents::text,held_value_cents::text,blocked_value_cents::text,last_cost_event_id';
export async function lockBalance(sql:Sql,a:Actor,w:string,p:string,u:string){
 await sql.query('INSERT INTO stock_balances(tenant_id,warehouse_id,product_id,unit_id,on_hand) VALUES($1,$2,$3,$4,0) ON CONFLICT(tenant_id,warehouse_id,product_id,unit_id) DO NOTHING',[a.tenant_id,w,p,u]);
 return (await sql.query<Balance>('SELECT '+fields+' FROM stock_balances WHERE warehouse_id=$1 AND product_id=$2 AND unit_id=$3 FOR UPDATE',[w,p,u])).rows[0]!;
}
export async function saveBalance(sql:Sql,w:string,p:string,u:string,b:Balance){
 await sql.query('UPDATE stock_balances SET on_hand=$1,held_qty=$2,blocked_qty=$3,reserved_qty=$4,released_value_cents=$5,held_value_cents=$6,blocked_value_cents=$7,last_cost_event_id=$8,version=version+1,updated_at=now() WHERE warehouse_id=$9 AND product_id=$10 AND unit_id=$11',[b.on_hand,b.held_qty,b.blocked_qty,b.reserved_qty,b.released_value_cents,b.held_value_cents,b.blocked_value_cents,b.last_cost_event_id,w,p,u]);
}
export const released=(b:Balance)=>qty(b.on_hand)-qty(b.held_qty)-qty(b.blocked_qty);
export const available=(b:Balance)=>released(b)-qty(b.reserved_qty);
export async function releaseReservations(sql:Sql,a:Actor,workOrderId:string){
 const rows=(await sql.query<{id:string;warehouse_id:string;product_id:string;unit_id:string;remaining_qty:string}>('SELECT id,warehouse_id,product_id,unit_id,remaining_qty::text FROM stock_reservations WHERE work_order_id=$1 AND remaining_qty>0 ORDER BY product_id,id FOR UPDATE',[workOrderId])).rows;
 for(const r of rows){const b=await lockBalance(sql,a,r.warehouse_id,r.product_id,r.unit_id);b.reserved_qty=formatDecimal(qty(b.reserved_qty)-qty(r.remaining_qty));await saveBalance(sql,r.warehouse_id,r.product_id,r.unit_id,b);await sql.query('UPDATE stock_reservations SET released_qty=released_qty+remaining_qty,remaining_qty=0 WHERE id=$1',[r.id]);}
}
export async function postStock(sql:Sql,a:Actor,i:{warehouseId:string;productId:string;unitId:string;direction:'in'|'out';quantity:bigint;sourceType:string;sourceId:string;eventKey:string;reversalOf?:string|null;originalEventKey?:string;quality?:'held'|'released';valueCents?:bigint|null;workOrderId?:string;ledger?:{bizDate?:string;docCode?:string;ledgerKind?:string;inWh?:string|null;outWh?:string|null;remark?:string;saleUnitPrice?:string|null;saleAmountCents?:bigint|null;costUnitPrice?:string|null;costAmountCents?:bigint|null}}){
 const old=(await sql.query<{id:string}>('SELECT id FROM stock_ledger WHERE event_key=$1',[i.eventKey])).rows[0];if(old)return old.id;
 if(i.quantity<=0n)throw new Problem(422,'QUANTITY_REQUIRED','库存事件数量必须大于零');
 let reversal=i.reversalOf??null;let original:{id:string;cost_id:string;amount_cents:string|null;before_data:Balance}|undefined;
 if(i.originalEventKey){
  const r=(await sql.query<{id:string;warehouse_id:string;product_id:string;unit_id:string;direction:string;quantity:string;source_type:string;source_id:string;cost_id:string;amount_cents:string|null;before_data:Balance}>('SELECT l.id,l.warehouse_id,l.product_id,l.unit_id,l.direction,l.quantity::text,l.source_type,l.source_id,c.id AS cost_id,c.amount_cents::text,c.before_data FROM stock_ledger l LEFT JOIN stock_cost_events c ON c.stock_ledger_id=l.id WHERE l.event_key=$1',[i.originalEventKey])).rows[0];
  if(!r||r.warehouse_id!==i.warehouseId||r.product_id!==i.productId||r.unit_id!==i.unitId||r.direction===i.direction||qty(r.quantity)!==i.quantity||r.source_type!==i.sourceType||r.source_id!==i.sourceId)throw new Problem(409,'REVERSAL_SOURCE_MISMATCH','冲销必须与同一源单的原库存事件一致');
  reversal=r.id;original=r;
 }
 const b=await lockBalance(sql,a,i.warehouseId,i.productId,i.unitId);const before={...b};let amount:bigint|null=null;
 const physical=i.direction==='in'?qty(b.on_hand)+i.quantity:qty(b.on_hand)-i.quantity;
 if(physical<0n)throw new Problem(409,'INSUFFICIENT_STOCK','默认不允许负库存，可用数量不足');
 if(original?.cost_id){
  if(b.last_cost_event_id!==original.cost_id)throw new Problem(409,'DOWNSTREAM_EXISTS','此库存已经发生后续成本或质量变动，请先按相反顺序撤销后续业务');
  if(i.sourceType==='shipment')await shipmentTrade(sql,a,i.originalEventKey!,true);
  const target={...original.before_data,reserved_qty:b.reserved_qty};
  if(released(target)<qty(target.reserved_qty))throw new Problem(409,'DOWNSTREAM_EXISTS','冲销后库存不足以满足已预占数量');
  Object.assign(b,target);amount=original.amount_cents===null?null:BigInt(original.amount_cents);
  // 消耗冲销释放原预占，不能悄悄重新锁定已经释放的算料批次。
  const uses=(await sql.query<{reservation_id:string;quantity:string}>('SELECT reservation_id,quantity::text FROM reservation_consumptions WHERE event_key=$1',[i.originalEventKey])).rows;
  for(const use of uses)await sql.query('UPDATE stock_reservations SET consumed_qty=consumed_qty-$1,released_qty=released_qty+$1 WHERE id=$2',[use.quantity,use.reservation_id]);
 }else{
  if(original)throw new Problem(409,'LEGACY_REVERSAL','历史库存没有金额快照，需要先完成成本迁移核对');
  if(i.direction==='in'){
   amount=i.valueCents!==undefined?i.valueCents:i.sourceType==='fg_receipt'?await receiptCost(sql,i.sourceId):null;
   if(i.quality==='held'){
    if(amount===null)throw new Problem(422,'PRICE_REQUIRED','待检采购必须有金额快照');
    b.held_qty=formatDecimal(qty(b.held_qty)+i.quantity);b.held_value_cents=(BigInt(b.held_value_cents)+amount).toString();
   }else b.released_value_cents=amount===null||(released(b)>0n&&b.released_value_cents===null)?null:((released(b)===0n?0n:BigInt(b.released_value_cents!))+amount).toString();
  }else{
   let workOrder=i.workOrderId;
   if(!workOrder&&i.sourceType==='material_issue')workOrder=(await sql.query<{work_order_id:string}>('SELECT work_order_id FROM material_issues WHERE id=$1',[i.sourceId])).rows[0]?.work_order_id;
   const own=workOrder?(await sql.query<{id:string;remaining_qty:string}>('SELECT id,remaining_qty::text FROM stock_reservations WHERE work_order_id=$1 AND warehouse_id=$2 AND product_id=$3 AND unit_id=$4 AND remaining_qty>0 ORDER BY id FOR UPDATE',[workOrder,i.warehouseId,i.productId,i.unitId])).rows:[];
   const owned=own.reduce((n,r)=>n+qty(r.remaining_qty),0n);
   if(i.quantity>available(b)+owned)throw new Problem(409,'INSUFFICIENT_AVAILABLE_STOCK','放行库存不足，待检、冻结及其他加工单预占库存不能领用或发货');
   let consume=i.quantity<owned?i.quantity:owned;
   b.reserved_qty=formatDecimal(qty(b.reserved_qty)-consume);
   for(const r of own){if(!consume)break;const used=consume<qty(r.remaining_qty)?consume:qty(r.remaining_qty);await sql.query('UPDATE stock_reservations SET remaining_qty=remaining_qty-$1,consumed_qty=consumed_qty+$1 WHERE id=$2',[formatDecimal(used),r.id]);await sql.query('INSERT INTO reservation_consumptions(tenant_id,reservation_id,event_key,quantity) VALUES($1,$2,$3,$4)',[a.tenant_id,r.id,i.eventKey,formatDecimal(used)]);consume-=used;}
   const total=released(b);amount=b.released_value_cents===null?null:round(BigInt(b.released_value_cents)*i.quantity,total);
   b.released_value_cents=total===i.quantity?'0':amount===null?null:(BigInt(b.released_value_cents!)-amount).toString();
   if(i.sourceType==='shipment')await shipmentTrade(sql,a,i.eventKey);
  }
  b.on_hand=formatDecimal(physical);
 }
 const meta=i.ledger??{};
 const ledger=(await sql.query<{id:string}>('INSERT INTO stock_ledger(tenant_id,warehouse_id,product_id,unit_id,direction,quantity,source_type,source_id,event_key,reversal_of,created_by,balance_after,biz_date,doc_code,ledger_kind,work_order_id,in_warehouse_id,out_warehouse_id,remark,sale_unit_price,sale_amount_cents,cost_unit_price,cost_amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id',[a.tenant_id,i.warehouseId,i.productId,i.unitId,i.direction,formatDecimal(i.quantity),i.sourceType,i.sourceId,i.eventKey,reversal,a.user_id,b.on_hand,meta.bizDate??null,meta.docCode??null,meta.ledgerKind??null,i.workOrderId??null,meta.inWh??null,meta.outWh??null,meta.remark??'',meta.saleUnitPrice??null,meta.saleAmountCents?.toString()??null,meta.costUnitPrice??null,meta.costAmountCents?.toString()??null])).rows[0]!;
 const costId=randomUUID();if(!original)b.last_cost_event_id=costId;
 const cost=(await sql.query<{id:string}>('INSERT INTO stock_cost_events(tenant_id,stock_ledger_id,warehouse_id,product_id,unit_id,event_key,source_type,source_id,amount_cents,direction,before_data,after_data,reversal_of,created_by,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id',[a.tenant_id,ledger.id,i.warehouseId,i.productId,i.unitId,i.eventKey,i.sourceType,i.sourceId,amount?.toString()??null,i.direction,before,b,original?.cost_id??null,a.user_id,costId])).rows[0]!;
 if(!original)b.last_cost_event_id=cost.id;await saveBalance(sql,i.warehouseId,i.productId,i.unitId,b);return ledger.id;
}
export async function qualityTransfer(sql:Sql,a:Actor,i:{warehouseId:string;productId:string;unitId:string;quantity:bigint;value:bigint;release:bigint;block:bigint;eventKey:string;sourceId:string;reverse?:boolean}){
 const b=await lockBalance(sql,a,i.warehouseId,i.productId,i.unitId);const before={...b};
 const original=(await sql.query<{id:string;before_data:Balance;amount_cents:string}>('SELECT id,before_data,amount_cents::text FROM stock_cost_events WHERE event_key=$1',[i.eventKey])).rows[0];
 if(i.reverse){
  if(!original||b.last_cost_event_id!==original.id)throw new Problem(409,'DOWNSTREAM_EXISTS','检验放行后已有领料、发货或成本变动，必须先撤销后续业务');
  if(released(original.before_data)<qty(b.reserved_qty))throw new Problem(409,'DOWNSTREAM_EXISTS','已经预占放行库存，先释放预占');
  Object.assign(b,original.before_data,{reserved_qty:b.reserved_qty});
 }else{
  if(original)return;
  const classified=i.release+i.block;if(classified!==i.quantity||classified>qty(b.held_qty))throw new Problem(422,'QUALITY_QUANTITY','本次判定必须完整分配该收货批次，放行与冻结数量之和必须等于送检量');
  const releaseValue=round(i.value*i.release,i.quantity),blockValue=i.value-releaseValue,previousReleased=released(b);
  b.held_qty=formatDecimal(qty(b.held_qty)-classified);b.held_value_cents=(BigInt(b.held_value_cents)-i.value).toString();
  b.released_value_cents=b.released_value_cents===null&&previousReleased>0n?null:((b.released_value_cents===null?0n:BigInt(b.released_value_cents))+releaseValue).toString();
  b.blocked_qty=formatDecimal(qty(b.blocked_qty)+i.block);b.blocked_value_cents=(BigInt(b.blocked_value_cents)+blockValue).toString();
 }
 const eventId=randomUUID();if(!i.reverse)b.last_cost_event_id=eventId;
 const event=(await sql.query<{id:string}>('INSERT INTO stock_cost_events(tenant_id,warehouse_id,product_id,unit_id,event_key,source_type,source_id,amount_cents,direction,before_data,after_data,reversal_of,created_by,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id',[a.tenant_id,i.warehouseId,i.productId,i.unitId,i.reverse?'reverse:'+i.eventKey:i.eventKey,'incoming_inspection',i.sourceId,i.value.toString(),'transfer',before,b,i.reverse?original!.id:null,a.user_id,eventId])).rows[0]!;
 if(!i.reverse)b.last_cost_event_id=event.id;await saveBalance(sql,i.warehouseId,i.productId,i.unitId,b);
}
