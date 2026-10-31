import type {FastifyInstance} from 'fastify';
import type {Sql} from './database.js';
import {Problem,type Actor,type Services} from './services.js';
import {shape,uuid,keyField,cashField,dateField,qtyField,reasonField,versionField,shortText,cents,money,qty,SCALE,calendarDate,digest,nextCode,reason} from './business-common.js';
import {extensionRoutes,actionShape,lockRow,businessZone,stateConflict} from './extensions-common.js';

type Target={work_order_id:string;weight?:string};
type Input={request_key:string;external_reference:string;category:string;period_start:string;period_end:string;amount:string;basis:'time'|'output'|'auto'|'manual';targets:Target[];reason:string};
type Source={id:string;code:string;version:number;product_id:string;unit_id:string;execution:string;reports:{id:string;version:number;kind:string;good_qty:string;effective_seconds:number;unit_ratio:string;is_output:boolean}[]};
type Allocation={work_order_id:string;work_order_code:string;weight:string;amount_cents:string;amount:string};
const targetsSchema={type:'array',minItems:1,maxItems:100,items:shape(['work_order_id'],{work_order_id:uuid,weight:qtyField})};
const inputSchema=shape(['request_key','external_reference','category','period_start','period_end','amount','basis','targets','reason'],{request_key:keyField,external_reference:shortText(200),category:shortText(100),period_start:dateField,period_end:dateField,amount:cashField,basis:{type:'string',enum:['time','output','auto','manual']},targets:targetsSchema,reason:reasonField});

// Integer cents, largest remainder, stable code ordering: even a one-cent bill is conserved.
export function allocateCents(amount:bigint,rows:{id:string;code:string;weight:bigint}[]):Allocation[]{
 const total=rows.reduce((n,r)=>n+r.weight,0n);if(amount<=0n||total<=0n)throw new Problem(422,'ZERO_DENOMINATOR','费用及分摊基数必须大于零');
 const values=rows.map(r=>({...r,value:amount*r.weight/total,remainder:amount*r.weight%total}));
 let left=amount-values.reduce((n,r)=>n+r.value,0n);
 const ordered=[...values].sort((a,b)=>a.remainder===b.remainder?a.code.localeCompare(b.code,'en'):a.remainder>b.remainder?-1:1);
 for(const r of ordered){if(left===0n)break;r.value++;left--;}
 return values.map(r=>({work_order_id:r.id,work_order_code:r.code,weight:r.weight.toString(),amount_cents:r.value.toString(),amount:money(r.value)!}));
}
async function lockTargets(sql:Sql,targets:Target[]){
 if(new Set(targets.map(t=>t.work_order_id)).size!==targets.length)throw new Problem(422,'DUPLICATE_TARGET','分摊加工单不可重复');
 for(const id of targets.map(t=>t.work_order_id).sort()){
  const r=(await sql.query<{execution:string}>('SELECT execution FROM work_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!r)throw new Problem(422,'INVALID_REFERENCE','加工单不存在或不属于当前企业');
  if(r.execution==='cancelled')throw new Problem(409,'CANCELLED_SOURCE','已取消的加工单不能分摊费用');
 }
}
async function guardReceipts(sql:Sql,targets:Target[]){
 if((await sql.query("SELECT id FROM fg_receipts WHERE work_order_id=ANY($1::uuid[]) AND approval='approved' LIMIT 1",[targets.map(t=>t.work_order_id)])).rows[0])throw new Problem(409,'DOWNSTREAM_EXISTS','费用已结转或目标工单已有成品入库，须先处理入库及其下游来源');
}
async function preview(sql:Sql,input:Omit<Input,'request_key'>){
 calendarDate(input.period_start);calendarDate(input.period_end);
 const days=(Date.parse(input.period_end)-Date.parse(input.period_start))/86400000;
 if(days<0||days>365)throw new Problem(422,'PERIOD_RANGE','结束日期应不早于开始日期，单次最多366天');
 reason(input.reason);const amount=cents(input.amount),zone=await businessZone(sql),sources:Source[]=[];
 await lockTargets(sql,input.targets);
 for(const target of [...input.targets].sort((a,b)=>a.work_order_id.localeCompare(b.work_order_id))){
  const wo=(await sql.query<Omit<Source,'reports'>>('SELECT id,code,version,product_id,unit_id,execution FROM work_orders WHERE id=$1',[target.work_order_id])).rows[0]!;
  const reports=(await sql.query<Source['reports'][number]>("SELECT r.id,r.version,'production' AS kind,r.good_qty::text,r.effective_seconds,t.unit_ratio::text,t.is_output FROM production_reports r JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.work_order_id=$1 AND r.approval='approved' AND (r.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date UNION ALL SELECT r.id,r.version,'rework' AS kind,r.good_qty::text,r.effective_seconds,t.unit_ratio::text,t.is_output FROM rework_reports r JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.work_order_id=$1 AND r.approval='approved' AND (r.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date ORDER BY kind,id",[wo.id,input.period_start,input.period_end,zone])).rows;
  sources.push({...wo,reports});
 }
 const time=sources.map(r=>r.reports.reduce((n,x)=>n+BigInt(x.effective_seconds),0n));
 const output=sources.map(r=>r.reports.filter(x=>x.is_output).reduce((n,x)=>n+qty(x.good_qty)*SCALE/qty(x.unit_ratio),0n));
 const basis=input.basis==='auto'?(time.some(n=>n>0n)?'time':'output'):input.basis;
 if(basis==='output'&&(new Set(sources.map(r=>r.product_id)).size>1||new Set(sources.map(r=>r.unit_id)).size>1))throw new Problem(422,'INCOMPARABLE_OUTPUT','不同产品或单位不能直接按产量分摊，请使用工时或填写人工权重');
 const rows=sources.map((r,i)=>{const target=input.targets.find(t=>t.work_order_id===r.id)!;if(basis==='manual'&&target.weight===undefined)throw new Problem(422,'WEIGHT_REQUIRED','人工分摊须为每个加工单填写权重');return {id:r.id,code:r.code,weight:basis==='time'?time[i]!:basis==='output'?output[i]!:qty(target.weight!)};});
 const allocations=allocateCents(amount,rows);
 const snapshot={engine:'expense-largest-remainder-v1',timezone:zone,period_start:input.period_start,period_end:input.period_end,requested_basis:input.basis,basis,amount_cents:amount.toString(),targets:input.targets,sources};
 return {source_snapshot:snapshot,source_hash:digest(snapshot),preview:{basis,timezone:zone,total_amount:money(amount),weight_scale:basis==='time'?'seconds':'1000000',allocations}};
}
async function view(sql:Sql,id:string){
 const row=(await sql.query<Record<string,unknown>&{amount_cents:string}>('SELECT *,amount_cents::text,period_start::text,period_end::text FROM expense_documents WHERE id=$1',[id])).rows[0];
 if(!row)throw new Problem(404,'NOT_FOUND','费用单不存在或不属于当前企业');
 const events=(await sql.query<{amount_cents:string}>('SELECT *,amount_cents::text FROM expense_cost_events WHERE expense_id=$1 ORDER BY posted_at,id',[id])).rows.map(r=>({...r,amount:money(BigInt(r.amount_cents))}));
 return {...row,amount:money(BigInt(row.amount_cents)),events,persisted:true};
}
export function registerExpenses(app:FastifyInstance,s:Services){
 const {get,post}=extensionRoutes(app,s);
 get('/api/business-calendar','configuration.read',async sql=>({timezone:await businessZone(sql),version:(await sql.query<{version:number}>('SELECT version FROM business_settings')).rows[0]?.version??1}));
 post<{request_key:string;version:number;timezone:string;reason:string}>('/api/business-calendar','configuration.manage',shape(['request_key','version','timezone','reason'],{request_key:keyField,version:versionField,timezone:shortText(100),reason:reasonField}),'calendar','calendar.update',async sql=>({timezone:await businessZone(sql),version:(await sql.query<{version:number}>('SELECT version FROM business_settings')).rows[0]?.version??1}),async(sql,a,b)=>{
  if(!(await sql.query('SELECT name FROM pg_timezone_names WHERE name=$1',[b.timezone])).rows[0])throw new Problem(422,'TIMEZONE_INVALID','请选择有效的IANA时区');reason(b.reason);
  await sql.query('INSERT INTO business_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[a.tenant_id]);
  const old=(await sql.query<{version:number}>('SELECT version FROM business_settings FOR UPDATE')).rows[0]!;
  if(old.version!==b.version)throw new Problem(409,'VERSION_CONFLICT','企业日历已变化');
  await sql.query('UPDATE business_settings SET timezone=$1,version=version+1,updated_at=now()',[b.timezone]);return a.tenant_id;
 },false);
 get('/api/expenses','finance.read',async sql=>{const ids=(await sql.query<{id:string}>('SELECT id FROM expense_documents ORDER BY created_at DESC,id LIMIT 200')).rows;return {items:await Promise.all(ids.map(r=>view(sql,r.id))),limit:200};});
 get('/api/expenses/:id','finance.read',async(sql,a,id)=>({expense:await view(sql,id)}));
 post<Input>('/api/expenses','finance.write',inputSchema,'expense','expense.create',view,async(sql,a,b)=>{
  if((await sql.query('SELECT id FROM expense_documents WHERE external_reference=$1',[b.external_reference])).rows[0])throw new Problem(409,'DUPLICATE_BILL','同一企业的费用凭证编号已登记，不可重复分摊');
  const p=await preview(sql,b);await guardReceipts(sql,b.targets);
  return (await sql.query<{id:string}>('INSERT INTO expense_documents(tenant_id,code,external_reference,category,period_start,period_end,amount_cents,basis,targets,source_snapshot,source_hash,preview,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14) RETURNING id',[a.tenant_id,await nextCode(sql,a,'EX'),b.external_reference,b.category,b.period_start,b.period_end,cents(b.amount).toString(),b.basis,JSON.stringify(b.targets),JSON.stringify(p.source_snapshot),p.source_hash,JSON.stringify(p.preview),b.reason,a.user_id])).rows[0]!.id;
 });
 type Action={request_key:string;version:number;action:string;reason?:string};
 post<Action>('/api/expenses/:id/actions','finance.approve',actionShape(['approve','reverse','cancel']),'expense','expense.action',view,async(sql,a,b,id)=>{
  const r=await lockRow(sql,'expense_documents',id,b.version),targets=r.targets as Target[];await lockTargets(sql,targets);
  if(b.action==='cancel'){if(!['pending','reversed'].includes(String(r.state)))throw stateConflict();reason(b.reason);await sql.query("UPDATE expense_documents SET state='cancelled',version=version+1,reason=$2,updated_at=now() WHERE id=$1",[id,b.reason]);return id;}
  await guardReceipts(sql,targets);
  if(b.action==='approve'){
   if(r.state!=='pending')throw stateConflict();
   const input={...r,amount:money(BigInt(String(r.amount_cents)))!,period_start:String(r.period_start).slice(0,10),period_end:String(r.period_end).slice(0,10)} as unknown as Input;
   // PGlite and pg expose DATE differently; the explicit text projection is canonical.
   const dates=(await sql.query<{period_start:string;period_end:string}>('SELECT period_start::text,period_end::text FROM expense_documents WHERE id=$1',[id])).rows[0]!;
   const current=await preview(sql,{...input,...dates});if(current.source_hash!==r.source_hash)throw new Problem(409,'EXPENSE_STALE','报工、工单或企业日历发生变化，请重新计算预览后确认');
   for(const line of current.preview.allocations)await sql.query('INSERT INTO expense_cost_events(tenant_id,expense_id,work_order_id,event_key,amount_cents,allocation_snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[a.tenant_id,id,line.work_order_id,'expense:'+id+':'+b.version+':'+line.work_order_id,line.amount_cents,JSON.stringify({...line,source_hash:r.source_hash,preview:current.preview}),a.user_id]);
   await sql.query("UPDATE expense_documents SET state='approved',version=version+1,updated_at=now() WHERE id=$1",[id]);
  }else{
   if(r.state!=='approved')throw stateConflict();reason(b.reason);
   const originals=(await sql.query<{id:string;work_order_id:string;amount_cents:string;allocation_snapshot:unknown}>('SELECT e.id,e.work_order_id,e.amount_cents::text,e.allocation_snapshot FROM expense_cost_events e WHERE e.expense_id=$1 AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM expense_cost_events x WHERE x.reversal_of=e.id)',[id])).rows;
   for(const e of originals)await sql.query('INSERT INTO expense_cost_events(tenant_id,expense_id,work_order_id,event_key,amount_cents,allocation_snapshot,reversal_of,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[a.tenant_id,id,e.work_order_id,'expense_reverse:'+e.id,(-BigInt(e.amount_cents)).toString(),JSON.stringify({original:e.allocation_snapshot,reason:b.reason}),e.id,a.user_id]);
   await sql.query("UPDATE expense_documents SET state='reversed',version=version+1,reason=$2,updated_at=now() WHERE id=$1",[id,b.reason]);
  }
  await sql.query('UPDATE work_orders SET version=version+1,updated_at=now() WHERE id=ANY($1::uuid[])',[targets.map(t=>t.work_order_id)]);return id;
 },false);
 post<{request_key:string;version:number;reason:string;targets?:Target[]}>('/api/expenses/:id/recalculate','finance.write',shape(['request_key','version','reason'],{request_key:keyField,version:versionField,reason:reasonField,targets:targetsSchema}),'expense','expense.recalculate',view,async(sql,a,b,id)=>{
  const r=await lockRow(sql,'expense_documents',id,b.version);if(!['pending','reversed'].includes(String(r.state)))throw stateConflict();reason(b.reason);
  const text=(await sql.query<{period_start:string;period_end:string}>('SELECT period_start::text,period_end::text FROM expense_documents WHERE id=$1',[id])).rows[0]!;
  const input={...r,...text,amount:money(BigInt(String(r.amount_cents)))!,targets:b.targets??r.targets,reason:b.reason} as unknown as Input;
  const p=await preview(sql,input);await guardReceipts(sql,input.targets);
  await sql.query("UPDATE expense_documents SET targets=$2::jsonb,source_snapshot=$3::jsonb,source_hash=$4,preview=$5::jsonb,reason=$6,state='pending',version=version+1,updated_at=now() WHERE id=$1",[id,JSON.stringify(input.targets),JSON.stringify(p.source_snapshot),p.source_hash,JSON.stringify(p.preview),b.reason]);return id;
 },false);
}
