import type { Sql } from './database.js';
import { Problem, type Actor } from './services.js';
import { qty, rate, round, lineCents, money } from './business-common.js';

export type WageSnapshot={status:'priced'|'unpriced';mode?:string;rule_id?:string;rule_version_id?:string;rate?:string;good_qty:string;effective_seconds:number;amount_cents:string|null;amount:string|null;engine_version:string;reason?:string;worker_name?:string;worker_id?:string};
export type TaskPrice={mode:string;rate:string|null};
export function priceWage(mode:string,price:string,good:string,seconds:number){
 return mode==='time'?round(BigInt(seconds)*rate(price),360_000_000n):lineCents(qty(good),price);
}
export async function freezeWage(sql:Sql,productId:string,processId:string,good:string,seconds:number,bound?:string|null,taskPrice?:TaskPrice|null):Promise<WageSnapshot>{
 const base={good_qty:good,effective_seconds:seconds,engine_version:'wage-decimal-v1'};
 if(taskPrice&&taskPrice.rate!==null&&taskPrice.rate!==undefined){
  const amount=priceWage(taskPrice.mode,taskPrice.rate,good,seconds);
  return {...base,status:'priced',mode:taskPrice.mode,rate:taskPrice.rate,amount_cents:amount.toString(),amount:money(amount)};
 }
 const candidates=(await sql.query<{id:string;version_id:string;product_id:string|null;rate:string;mode:string}>('SELECT r.id,v.id AS version_id,r.product_id,v.rate::text,v.mode FROM wage_rules r JOIN wage_rule_versions v ON v.tenant_id=r.tenant_id AND v.rule_id=r.id AND v.revision=r.current_revision WHERE r.active AND $1=ANY(r.process_ids) AND (r.product_id=$2 OR r.product_id IS NULL)',[processId,productId])).rows;
 if(bound){const version=(await sql.query<{id:string;rule_id:string;product_id:string|null;rate:string;mode:string;process_ids:string[]}>('SELECT *,rate::text FROM wage_rule_versions WHERE id=$1',[bound])).rows[0];if(!version||!version.process_ids.includes(processId)||(version.product_id&&version.product_id!==productId))throw new Problem(422,'WAGE_RULE_SCOPE','任务工价快照与产品或工序不匹配');candidates.splice(0,candidates.length,{id:version.rule_id,version_id:version.id,product_id:version.product_id,rate:version.rate,mode:version.mode});}
 const specific=candidates.filter(r=>r.product_id===productId),matches=specific.length?specific:candidates;
 if(matches.length>1)throw new Problem(409,'WAGE_RULE_CONFLICT','同层工价规则重叠，请先消除冲突');
 const chosen=matches[0];
 if(!chosen)return {...base,status:'unpriced',amount_cents:null,amount:null,reason:'没有适用的工价规则'};
 const amount=priceWage(chosen.mode,chosen.rate,good,seconds);
 return {...base,status:'priced',rule_id:chosen.id,rule_version_id:chosen.version_id,mode:chosen.mode,rate:chosen.rate,amount_cents:amount.toString(),amount:money(amount)};
}
export async function wageView(sql:Sql,id:string,a:Actor){
 const row=(await sql.query<{wage_status:string;wage_snapshot:WageSnapshot|null;operator_id:string}>('SELECT wage_status,wage_snapshot,operator_id FROM production_reports WHERE id=$1',[id])).rows[0];
 if(!row)return {};
 const own=row.operator_id===a.user_id,read=own||a.permissions.includes('payroll.read');
 return read?{wage_status:row.wage_status,estimated_wage:row.wage_snapshot?.amount??null,wage_snapshot:row.wage_snapshot}:{wage_status:row.wage_status,estimated_wage:null};
}
export async function postWage(sql:Sql,a:Actor,id:string,reverse=false){
 const r=(await sql.query<{work_order_id:string;operator_id:string;wage_snapshot:WageSnapshot|null;settlement_status:string;version:number}>('SELECT work_order_id,operator_id,wage_snapshot,settlement_status,version FROM production_reports WHERE id=$1',[id])).rows[0]!;
 if(r.settlement_status==='settled')throw new Problem(409,'SETTLED','已结算的报工记录不能修改或删除，请先改为未结算');
 const positive=r.version<=1?'wage:'+id:'wage:'+id+':v'+r.version;
 const negative=r.version<=1?'wage_reverse:'+id:'wage_reverse:'+id+':v'+r.version;
 if(reverse){
  if((await sql.query('SELECT id FROM wage_events WHERE event_key=$1',[negative])).rows[0])return;
  const original=(await sql.query<{id:string;amount_cents:string;calculation_snapshot:WageSnapshot}>('SELECT id,amount_cents::text,calculation_snapshot FROM wage_events WHERE event_key=$1',[positive])).rows[0];
  if(!original)return;
  if((await sql.query("SELECT id FROM fg_receipts WHERE work_order_id=$1 AND approval='approved' LIMIT 1",[r.work_order_id])).rows[0])throw new Problem(409,'DOWNSTREAM_EXISTS','人工成本已经结转成品，须先处理入库成本');
  await sql.query('INSERT INTO wage_events(tenant_id,report_id,work_order_id,worker_id,event_key,amount_cents,calculation_snapshot,reversal_of,created_by,worker_name) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)',[a.tenant_id,id,r.work_order_id,r.operator_id,negative,(-BigInt(original.amount_cents)).toString(),JSON.stringify(original.calculation_snapshot),original.id,a.user_id,original.calculation_snapshot.worker_name??r.operator_id]);
 }else if(r.wage_snapshot?.status==='priced'){
  if((await sql.query('SELECT id FROM wage_events WHERE event_key=$1',[positive])).rows[0])return;
  await sql.query('INSERT INTO wage_events(tenant_id,report_id,work_order_id,worker_id,event_key,amount_cents,calculation_snapshot,created_by,worker_name) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',[a.tenant_id,id,r.work_order_id,r.operator_id,positive,r.wage_snapshot.amount_cents,JSON.stringify(r.wage_snapshot),a.user_id,r.wage_snapshot.worker_name??r.operator_id]);
 }
}
export async function workCosts(sql:Sql,id:string){
 const materials=(await sql.query<{amount_cents:string|null}>("SELECT e.amount_cents::text FROM stock_cost_events e JOIN material_issues i ON i.tenant_id=e.tenant_id AND i.id=e.source_id WHERE i.work_order_id=$1 AND i.approval='approved' AND e.source_type='material_issue' AND e.direction='out' AND e.reversal_of IS NULL",[id])).rows;
 materials.push(...(await sql.query<{amount_cents:string|null}>("SELECT e.amount_cents::text FROM stock_cost_events e JOIN production_supplements s ON s.tenant_id=e.tenant_id AND s.id=e.source_id WHERE s.work_order_id=$1 AND s.approval='approved' AND e.source_type='supplement_issue' AND e.direction='out' AND e.reversal_of IS NULL",[id])).rows);
 const reports=(await sql.query<{wage_snapshot:WageSnapshot|null}>("SELECT wage_snapshot FROM production_reports WHERE work_order_id=$1 AND approval='approved'",[id])).rows;
 reports.push(...(await sql.query<{wage_snapshot:WageSnapshot|null}>("SELECT wage_snapshot FROM rework_reports WHERE work_order_id=$1 AND approval='approved'",[id])).rows);
 const wages=(await sql.query<{amount_cents:string}>('SELECT amount_cents::text FROM wage_events WHERE work_order_id=$1',[id])).rows;
 const expected=Number((await sql.query<{n:string}>("SELECT ((SELECT count(*) FROM material_issue_lines l JOIN material_issues i ON i.tenant_id=l.tenant_id AND i.id=l.issue_id WHERE i.work_order_id=$1 AND i.approval='approved')+(SELECT count(*) FROM supplement_materials l JOIN production_supplements s ON s.tenant_id=l.tenant_id AND s.id=l.supplement_id WHERE s.work_order_id=$1 AND s.approval='approved'))::text AS n",[id])).rows[0]!.n);
 const missingMaterial=materials.length===0||materials.length!==expected||materials.some(r=>r.amount_cents===null);
 const missingWage=reports.length===0||reports.some(r=>r.wage_snapshot?.status!=='priced');
 const material=missingMaterial?null:materials.reduce((n,r)=>n+BigInt(r.amount_cents!),0n),labor=missingWage?null:wages.reduce((n,r)=>n+BigInt(r.amount_cents),0n);
 const expenseRows=(await sql.query<{amount_cents:string}>('SELECT amount_cents::text FROM expense_cost_events WHERE work_order_id=$1',[id])).rows;
 const expense=expenseRows.reduce((n,r)=>n+BigInt(r.amount_cents),0n),total=material===null||labor===null?null:material+labor+expense;
 return {material_cents:material,labor_cents:labor,expense_cents:expense,total_cents:total,material_amount:money(material),labor_amount:money(labor),expense_amount:money(expense),total_amount:money(total),cost_status:total===null?'unpriced':'priced',wage_status:missingWage?'unpriced':'priced',source_count:materials.length+wages.length+expenseRows.length};
}
export async function receiptCost(sql:Sql,id:string){
 const r=(await sql.query<{work_order_id:string;quantity:string;plan_qty:string;cost_required:boolean}>('SELECT f.work_order_id,f.quantity::text,w.plan_qty::text,w.cost_required FROM fg_receipts f JOIN work_orders w ON w.tenant_id=f.tenant_id AND w.id=f.work_order_id WHERE f.id=$1',[id])).rows[0]!;
 const costs=await workCosts(sql,r.work_order_id);
 if(costs.total_cents===null){if(r.cost_required)throw new Problem(422,'COST_INCOMPLETE','材料或工资未计价，不能以零成本结转');return null;}
 const received=(await sql.query<{quantity:string;amount_cents:string|null}>("SELECT f.quantity::text,e.amount_cents::text FROM fg_receipts f JOIN stock_cost_events e ON e.tenant_id=f.tenant_id AND e.source_id=f.id AND e.source_type='fg_receipt' AND e.reversal_of IS NULL WHERE f.work_order_id=$1 AND f.approval='approved' AND f.id<>$2",[r.work_order_id,id])).rows;
 if(received.some(x=>x.amount_cents===null))throw new Problem(409,'COST_INCOMPLETE','该工单已有未计价结转，先处理历史来源');
 const usedQ=received.reduce((n,x)=>n+qty(x.quantity),0n),usedV=received.reduce((n,x)=>n+BigInt(x.amount_cents!),0n),current=qty(r.quantity),plan=qty(r.plan_qty);
 if(usedQ+current===plan)return costs.total_cents-usedV;
 return round(costs.total_cents*current,plan);
}
export async function tradeSource(sql:Sql,a:Actor,input:{kind:string;partyId:string;sourceType:string;sourceId:string;eventKey:string;amount:bigint}){
 const old=(await sql.query<{id:string}>('SELECT id FROM open_items WHERE event_key=$1',[input.eventKey])).rows[0];if(old)return old.id;
 const item=(await sql.query<{id:string}>('INSERT INTO open_items(tenant_id,kind,party_id,source_type,source_id,event_key,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[a.tenant_id,input.kind,input.partyId,input.sourceType,input.sourceId,input.eventKey,input.amount.toString()])).rows[0]!;
 await sql.query('INSERT INTO financial_events(tenant_id,open_item_id,event_key,debt_cents,created_by) VALUES($1,$2,$3,$4,$5)',[a.tenant_id,item.id,'debt:'+input.eventKey,input.amount.toString(),a.user_id]);return item.id;
}
export async function reverseTrade(sql:Sql,a:Actor,eventKey:string){
 const item=(await sql.query<{id:string;allocated_cents:string;amount_cents:string;reversed:boolean}>('SELECT id,allocated_cents::text,amount_cents::text,reversed FROM open_items WHERE event_key=$1 FOR UPDATE',[eventKey])).rows[0];
 if(!item||item.reversed)return;
 if(BigInt(item.allocated_cents)>0n)throw new Problem(409,'DOWNSTREAM_EXISTS','源款项已有收付分配，先冲销分配或款项');
 const original=(await sql.query<{id:string}>('SELECT id FROM financial_events WHERE event_key=$1',['debt:'+eventKey])).rows[0]!;
 await sql.query('INSERT INTO financial_events(tenant_id,open_item_id,event_key,debt_cents,reversal_of,created_by) VALUES($1,$2,$3,$4,$5,$6)',[a.tenant_id,item.id,'debt_reverse:'+eventKey,(-BigInt(item.amount_cents)).toString(),original.id,a.user_id]);
 await sql.query('UPDATE open_items SET reversed=true WHERE id=$1',[item.id]);
}
export async function shipmentTrade(sql:Sql,a:Actor,eventKey:string,reverse=false){
 const lineId=eventKey.split(':')[1]!;
 if(reverse)return reverseTrade(sql,a,'shipment:'+lineId);
  const line=(await sql.query<{shipment_id:string;quantity:string;unit_price:string;amount_cents:string|null;customer_id:string}>('SELECT l.shipment_id,l.quantity::text,CASE WHEN l.contract_line_id IS NOT NULL THEN l.unit_price ELSE s.unit_price END::text AS unit_price,l.amount_cents::text,coalesce(sh.customer_id,o.customer_id) AS customer_id FROM shipment_lines l JOIN shipments sh ON sh.tenant_id=l.tenant_id AND sh.id=l.shipment_id LEFT JOIN sales_order_lines s ON s.tenant_id=l.tenant_id AND s.id=l.sales_line_id LEFT JOIN sales_orders o ON o.tenant_id=s.tenant_id AND o.id=sh.sales_order_id WHERE l.id=$1',[lineId])).rows[0]!;
  if(!line?.customer_id)throw new Problem(422,'INVALID_REFERENCE','销售出库缺少客户');
  const cents=line.amount_cents===null?null:BigInt(line.amount_cents);
  const amount=cents!==null&&cents>0n?cents:lineCents(qty(line.quantity),line.unit_price);
  return tradeSource(sql,a,{kind:'receivable',partyId:line.customer_id,sourceType:'shipment',sourceId:line.shipment_id,eventKey:'shipment:'+lineId,amount});
}
