import type {FastifyInstance} from 'fastify';
import type {Sql} from './database.js';
import {Problem,requireAllScope,writeAudit,type Actor,type Services} from './services.js';
import {gateTenantWrite} from './assets.js';
import {shape,idParams,uuid,qtyField,keyField,versionField,reasonField,qty,formatDecimal,round,permit,reason,digest,replay,finish,nextCode,warehouse} from './business-common.js';
import {postStock} from './inventory.js';
import {freezeWage,type WageSnapshot} from './accounting.js';
import {applyPerformance,matchPerformance} from './performance-pay.js';
import {refreshTaskQuantities,assertOperator} from './production.js';
type Task={id:string;work_order_id:string;process_id:string;product_id:string;warehouse_id:string;plan_qty:string;unit_ratio:string;execution:string;order_execution:string;sequence:number;wage_rule_version_id:string|null;pricing_mode:string;wage_rate:string|null};
async function task(sql:Sql,id:string){const t=(await sql.query<Task>('SELECT t.*,t.plan_qty::text,t.unit_ratio::text,w.product_id,w.warehouse_id,w.execution AS order_execution FROM work_order_tasks t JOIN work_orders w ON w.tenant_id=t.tenant_id AND w.id=t.work_order_id WHERE t.id=$1 FOR UPDATE OF t,w',[id])).rows[0];if(!t)throw new Problem(404,'TASK_NOT_FOUND','任务不存在');if(['cancelled','completed'].includes(t.order_execution))throw new Problem(409,'STATE_TRANSITION','已完工或取消加工单不能修改投入与返工');return t;}
export function registerCorrections(app:FastifyInstance,s:Services){
 const guard=s.authorize();const run=<T>(r:Parameters<Services['context']>[0],fn:(sql:Sql,a:Actor)=>Promise<T>)=>s.database.tenant(s.context(r),async sql=>{const a=s.actor(r);requireAllScope(a);await gateTenantWrite(sql,s.context(r));return fn(sql,a);});
 const views=async(sql:Sql,type:'supplement'|'rework',id:string,a:Actor)=>{
  const table=type==='supplement'?'production_supplements':'rework_reports',r=(await sql.query<Record<string,unknown>>('SELECT * FROM '+table+' WHERE id=$1',[id])).rows[0];if(!r)throw new Problem(404,'NOT_FOUND','单据不存在');
  if(type==='supplement')return {...r,lines:(await sql.query('SELECT *,quantity::text FROM supplement_materials WHERE supplement_id=$1',[id])).rows};
  const {wage_snapshot,...safe}=r;return {...safe,...(a.permissions.includes('payroll.read')||r.operator_id===a.user_id?{wage_snapshot}:{}),persisted:true};
 };
 for(const [path,type,table] of [['/api/production-supplements','supplement','production_supplements'],['/api/rework-reports','rework','rework_reports']] as const)app.get(path,{preHandler:guard},r=>s.database.tenant(s.context(r),async sql=>{const a=s.actor(r);permit(a,'production.read');requireAllScope(a);const ids=(await sql.query<{id:string}>('SELECT id FROM '+table+' ORDER BY created_at DESC LIMIT 200')).rows;return {items:await Promise.all(ids.map(x=>views(sql,type,x.id,a))),limit:200};}));
 app.post<{Body:{request_key:string;task_id:string;quantity:string;reason:string}}>('/api/production-supplements',{preHandler:guard,schema:{body:shape(['request_key','task_id','quantity','reason'],{request_key:keyField,task_id:uuid,quantity:qtyField,reason:reasonField})}},async(r,reply)=>run(r,async(sql,a)=>{
  permit(a,'production.approve');const b=r.body,h=digest(b),prior=await replay(sql,'supplement.create',b.request_key,h);if(prior)return {replayed:true,supplement:await views(sql,'supplement',prior,a)};reason(b.reason);const t=await task(sql,b.task_id);
  if(t.sequence!==(await sql.query<{sequence:number}>('SELECT min(sequence)::integer AS sequence FROM work_order_tasks WHERE work_order_id=$1',[t.work_order_id])).rows[0]!.sequence)throw new Problem(422,'SUPPLEMENT_FIRST_TASK','追加新物料仅允许从首道工序投入；后续工序按前道净合格量流转');
  if(t.execution!=='running')throw new Problem(409,'STATE_TRANSITION','首道任务必须仍在执行中才能追加投入');
  const n=qty(b.quantity);if(n<=0n)throw new Problem(422,'QUANTITY_REQUIRED','追加数量须大于零');
  const scrap=qty((await sql.query<{n:string}>("SELECT coalesce(sum(scrap_qty),0)::text AS n FROM production_reports WHERE task_id=$1 AND approval='approved'",[t.id])).rows[0]!.n);
  const used=qty((await sql.query<{n:string}>("SELECT coalesce(sum(quantity),0)::text AS n FROM production_supplements WHERE task_id=$1 AND approval IN ('pending','approved')",[t.id])).rows[0]!.n);
  if(used+n>scrap)throw new Problem(422,'SUPPLEMENT_EXCEEDS_LOSS','追加新投入只能补足已审核报废损失，不能占用待返工数量或扩大成品目标');
  const id=(await sql.query<{id:string}>('INSERT INTO production_supplements(tenant_id,code,work_order_id,task_id,warehouse_id,quantity,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[a.tenant_id,await nextCode(sql,a,'SP'),t.work_order_id,t.id,t.warehouse_id,formatDecimal(n),b.reason,a.user_id])).rows[0]!.id;
  const mats=(await sql.query<{id:string;product_id:string;unit_id:string;required_qty:string}>('SELECT id,product_id,unit_id,required_qty::text FROM work_order_materials WHERE work_order_id=$1 ORDER BY product_id',[t.work_order_id])).rows;
  for(const m of mats){const needed=(qty(m.required_qty)*n+qty(t.plan_qty)-1n)/qty(t.plan_qty);if(needed>0n)await sql.query('INSERT INTO supplement_materials(tenant_id,supplement_id,material_id,product_id,unit_id,quantity) VALUES($1,$2,$3,$4,$5,$6)',[a.tenant_id,id,m.id,m.product_id,m.unit_id,formatDecimal(needed)]);}
  await finish(sql,a,'supplement.create',b.request_key,h,'production_supplement',id);const v=await views(sql,'supplement',id,a);await writeAudit(sql,a,'supplement.create','production_supplement',id,null,v);return reply.code(201).send({supplement:v,replayed:false});
 }));
 app.post<{Body:{request_key:string;source_report_id:string;operator_id?:string;good_qty:string;defect_qty:string;effective_seconds?:number;reason:string}}>('/api/rework-reports',{preHandler:guard,schema:{body:shape(['request_key','source_report_id','good_qty','defect_qty','reason'],{request_key:keyField,source_report_id:uuid,operator_id:uuid,good_qty:qtyField,defect_qty:qtyField,effective_seconds:{type:'integer',minimum:0,maximum:2678400},reason:reasonField})}},async(r,reply)=>run(r,async(sql,a)=>{
  permit(a,'production.report');const b=r.body,h=digest(b),prior=await replay(sql,'rework.create',b.request_key,h);if(prior)return {replayed:true,rework:await views(sql,'rework',prior,a)};
  reason(b.reason);const source=(await sql.query<{id:string;task_id:string;approval:string;rework_qty:string}>('SELECT *,rework_qty::text FROM production_reports WHERE id=$1 FOR UPDATE',[b.source_report_id])).rows[0];if(!source||source.approval!=='approved')throw new Problem(422,'REWORK_SOURCE','返工必须引用已审核的不良处置来源');
  const t=await task(sql,source.task_id);if(t.execution!=='running'||t.order_execution!=='running')throw new Problem(409,'STATE_TRANSITION','只有执行中的源任务可提交返工结果');
  const n=qty(b.good_qty)+qty(b.defect_qty),used=qty((await sql.query<{n:string}>("SELECT coalesce(sum(good_qty+defect_qty),0)::text AS n FROM rework_reports WHERE source_report_id=$1 AND approval IN ('pending','approved')",[source.id])).rows[0]!.n);
  if(n<=0n||used+n>qty(source.rework_qty))throw new Problem(422,'OVER_REWORK','返工结果数量不能超过该来源尚未处理的返工量');
  const operator=b.operator_id??a.user_id;await assertOperator(sql,a,t.process_id,operator);
  const process=(await sql.query<{name:string;pricing_mode:string}>('SELECT name,pricing_mode FROM processes WHERE id=$1',[t.process_id])).rows[0];
  const product=(await sql.query<{name:string;code:string;specification:string}>('SELECT name,code,specification FROM products WHERE id=$1',[t.product_id])).rows[0];
  const operatorName=(await sql.query<{display_name:string}>('SELECT display_name FROM tenant_team_members WHERE id=$1',[operator])).rows[0]!.display_name;
  const perf=await matchPerformance(sql,{processName:process?.name??'',pricingMode:t.pricing_mode==='time'?'计时':'计件',productName:product?.name??'',productCode:product?.code??'',productSpec:product?.specification??'',userName:operatorName});
  const wage=await freezeWage(sql,t.product_id,t.process_id,b.good_qty,b.effective_seconds??0,t.wage_rule_version_id,perf?{mode:t.pricing_mode,rate:perf.wage_rate}:(t.wage_rate!=null?{mode:t.pricing_mode,rate:String(t.wage_rate)}:null));
  if(perf)applyPerformance(wage as Record<string,unknown>,perf,{good:b.good_qty,defect:b.defect_qty,total:String(Number(b.good_qty)+Number(b.defect_qty)),seconds:b.effective_seconds??0,pricingMode:t.pricing_mode});
  if(wage.mode==='time'&&!(b.effective_seconds??0))throw new Problem(422,'TIME_REQUIRED','计时返工必须填写有效工时');
  wage.worker_id=operator;wage.worker_name=operatorName;
  const id=(await sql.query<{id:string}>('INSERT INTO rework_reports(tenant_id,code,source_report_id,work_order_id,task_id,operator_id,good_qty,defect_qty,effective_seconds,wage_snapshot,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',[a.tenant_id,await nextCode(sql,a,'RW'),source.id,t.work_order_id,t.id,operator,b.good_qty,b.defect_qty,b.effective_seconds??0,wage,b.reason,a.user_id])).rows[0]!.id;
  await finish(sql,a,'rework.create',b.request_key,h,'rework_report',id);const v=await views(sql,'rework',id,a);await writeAudit(sql,a,'rework.create','rework_report',id,null,{...v,wage_snapshot:undefined});return reply.code(201).send({rework:v,replayed:false});
 }));
 for(const [path,type,table] of [['/api/production-supplements/:id/actions','supplement','production_supplements'],['/api/rework-reports/:id/actions','rework','rework_reports']] as const)app.post<{Params:{id:string};Body:{request_key:string;action:string;version:number;reason?:string}}>(path,{preHandler:guard,schema:{params:idParams,body:shape(['request_key','action','version'],{request_key:keyField,version:versionField,action:{type:'string',enum:['approve','reject','reverse']},reason:reasonField})}},r=>run(r,async(sql,a)=>{
  permit(a,'production.approve');if(type==='supplement')permit(a,'inventory.approve');const b=r.body,h=digest({id:r.params.id,...b}),cmd=type+'.'+b.action,prior=await replay(sql,cmd,b.request_key,h);if(prior)return {replayed:true,[type]:await views(sql,type,prior,a)};
  const doc=(await sql.query<{id:string;version:number;task_id:string;warehouse_id:string;source_report_id:string;operator_id:string;good_qty:string;defect_qty:string;approval:string;wage_snapshot:WageSnapshot}>('SELECT * FROM '+table+' WHERE id=$1 FOR UPDATE',[r.params.id])).rows[0];if(!doc)throw new Problem(404,'NOT_FOUND','单据不存在');if(doc.version!==b.version)throw new Problem(409,'VERSION_CONFLICT','单据已修改，请刷新');
  const t=await task(sql,doc.task_id);if(b.action==='reverse'){if(doc.approval!=='approved')throw new Problem(409,'STATE_TRANSITION','只有已审核单据能冲销');reason(b.reason);}else{if(doc.approval!=='pending')throw new Problem(409,'STATE_TRANSITION','只有待审核单据能审核或驳回');if(b.action==='reject')reason(b.reason);}
  if(b.action!=='reject'){
   if(type==='supplement'){
    if(b.action==='approve'){
     if(t.execution==='completed')throw new Problem(409,'STATE_TRANSITION','已完成任务不能新增物料投入');
     const loss=qty((await sql.query<{n:string}>("SELECT coalesce(sum(scrap_qty),0)::text AS n FROM production_reports WHERE task_id=$1 AND approval='approved'",[t.id])).rows[0]!.n);
     const total=qty((await sql.query<{n:string}>("SELECT coalesce(sum(quantity),0)::text AS n FROM production_supplements WHERE task_id=$1 AND approval IN ('pending','approved')",[t.id])).rows[0]!.n);if(total>loss)throw new Problem(409,'SUPPLEMENT_EXCEEDS_LOSS','报废来源已变化，不能审批追加投入');
    }
    if(b.action==='reverse'&&(await sql.query("SELECT id FROM production_reports WHERE supplement_id=$1 AND approval IN ('pending','approved')",[doc.id])).rows[0])throw new Problem(409,'DOWNSTREAM_EXISTS','追加投入已经有报工来源，请先处理这些报工');
    const lines=(await sql.query<{id:string;product_id:string;unit_id:string;quantity:string}>('SELECT *,quantity::text FROM supplement_materials WHERE supplement_id=$1 ORDER BY product_id',[doc.id])).rows;
    await warehouse(sql,doc.warehouse_id);
    for(const l of lines)await postStock(sql,a,{warehouseId:doc.warehouse_id,productId:l.product_id,unitId:l.unit_id,quantity:qty(l.quantity),direction:b.action==='approve'?'out':'in',sourceType:'supplement_issue',sourceId:doc.id,eventKey:(b.action==='approve'?'supplement_issue:':'supplement_issue_reverse:')+l.id,...(b.action==='reverse'?{originalEventKey:'supplement_issue:'+l.id}:{})});
   }else{
    const source=(await sql.query<{approval:string}>('SELECT approval FROM production_reports WHERE id=$1',[doc.source_report_id])).rows[0];if(source?.approval!=='approved')throw new Problem(409,'REWORK_SOURCE','源报工已经变化');
    if(b.action==='approve'){
     await assertOperator(sql,a,t.process_id,doc.operator_id);
     if(qty(doc.good_qty)+qty((await sql.query<{n:string}>("SELECT coalesce(sum(good_qty),0)::text AS n FROM production_reports WHERE task_id=$1 AND approval='approved'",[t.id])).rows[0]!.n)+qty((await sql.query<{n:string}>("SELECT coalesce(sum(good_qty),0)::text AS n FROM rework_reports WHERE task_id=$1 AND approval='approved'",[t.id])).rows[0]!.n)>qty(t.plan_qty))throw new Problem(422,'OVER_PLAN','返工后净合格数量超出计划');
     if(doc.wage_snapshot.status==='priced')await sql.query('INSERT INTO wage_events(tenant_id,report_id,work_order_id,worker_id,event_key,amount_cents,calculation_snapshot,created_by,worker_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[a.tenant_id,doc.source_report_id,t.work_order_id,doc.operator_id,'rework:'+doc.id,doc.wage_snapshot.amount_cents,doc.wage_snapshot,a.user_id,doc.wage_snapshot.worker_name??doc.operator_id]);
    }else{
     if((await sql.query("SELECT id FROM fg_receipts WHERE work_order_id=$1 AND approval IN ('pending','approved') UNION ALL SELECT r.id FROM production_reports r JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE t.work_order_id=$1 AND t.sequence>$2 AND r.approval IN ('pending','approved') LIMIT 1",[t.work_order_id,t.sequence])).rows[0])throw new Problem(409,'DOWNSTREAM_EXISTS','返工产出已有后续加工或入库，请先处理下游');
     const e=(await sql.query<{id:string;amount_cents:string}>('SELECT id,amount_cents::text FROM wage_events WHERE event_key=$1',['rework:'+doc.id])).rows[0];
     if(e){
      if((await sql.query("SELECT l.id FROM wage_settlement_lines l JOIN wage_settlements s ON s.tenant_id=l.tenant_id AND s.id=l.settlement_id WHERE l.wage_event_id=$1 AND s.state='approved'",[e.id])).rows[0])throw new Problem(409,'DOWNSTREAM_EXISTS','返工工资已结算，请先冲销结算');
      await sql.query('INSERT INTO wage_events(tenant_id,report_id,work_order_id,worker_id,event_key,amount_cents,calculation_snapshot,reversal_of,created_by,worker_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[a.tenant_id,doc.source_report_id,t.work_order_id,doc.operator_id,'rework_reverse:'+doc.id,(-BigInt(e.amount_cents)).toString(),doc.wage_snapshot,e.id,a.user_id,doc.wage_snapshot.worker_name??doc.operator_id]);
     }
    }
   }
  }
  await sql.query('UPDATE '+table+' SET approval=$1,version=version+1 WHERE id=$2',[{approve:'approved',reject:'rejected',reverse:'reversed'}[b.action],doc.id]);if(type==='rework')await refreshTaskQuantities(sql,t.id);
  await finish(sql,a,cmd,b.request_key,h,type,doc.id);const v=await views(sql,type,doc.id,a);await writeAudit(sql,a,cmd,type==='rework'?'rework_report':'production_supplement',doc.id,{approval:doc.approval},{...v,wage_snapshot:undefined,action_reason:b.reason??''});return {replayed:false,[type]:v};
 }));

 app.post<{Params:{id:string;taskId:string};Body:{request_key:string;version:number;wage_rule_version_id:string;reason:string}}>('/api/work-orders/:id/tasks/:taskId/wage-rule',{preHandler:guard,schema:{params:shape(['id','taskId'],{id:uuid,taskId:uuid}),body:shape(['request_key','version','wage_rule_version_id','reason'],{request_key:keyField,version:versionField,wage_rule_version_id:uuid,reason:reasonField})}},r=>run(r,async(sql,a)=>{
  permit(a,'payroll.manage');reason(r.body.reason);const hash=digest({id:r.params.id,task:r.params.taskId,...r.body}),prior=await replay(sql,'task.bind_wage',r.body.request_key,hash);if(prior)return {replayed:true,task_id:prior};
  const t=await task(sql,r.params.taskId);if(t.work_order_id!==r.params.id)throw new Problem(404,'TASK_NOT_FOUND','任务不属于该加工单');
  const version=(await sql.query<{version:number}>('SELECT version FROM work_order_tasks WHERE id=$1',[t.id])).rows[0]!.version;if(version!==r.body.version)throw new Problem(409,'VERSION_CONFLICT','任务已修改');
  if((await sql.query('SELECT id FROM production_reports WHERE task_id=$1 LIMIT 1',[t.id])).rows[0])throw new Problem(409,'WAGE_FROZEN','任务已有报工，不能更换工资规则快照');
  const v=(await sql.query<{product_id:string|null;process_ids:string[]}>('SELECT product_id,process_ids FROM wage_rule_versions WHERE id=$1',[r.body.wage_rule_version_id])).rows[0];if(!v||!v.process_ids.includes(t.process_id)||(v.product_id&&v.product_id!==t.product_id))throw new Problem(422,'WAGE_RULE_SCOPE','规则不适用于本产品或工序');
  await sql.query('UPDATE work_order_tasks SET wage_rule_version_id=$1,version=version+1 WHERE id=$2',[r.body.wage_rule_version_id,t.id]);await finish(sql,a,'task.bind_wage',r.body.request_key,hash,'task',t.id);await writeAudit(sql,a,'task.bind_wage','wage_rule',r.body.wage_rule_version_id,null,{task_id:t.id,work_order_id:t.work_order_id,reason:r.body.reason});return {replayed:false,task_id:t.id};
 }));
}
