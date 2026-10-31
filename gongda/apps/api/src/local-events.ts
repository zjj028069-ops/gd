import type {FastifyInstance} from 'fastify';
import type {Database,TenantContext} from './database.js';
import {Problem,writeAudit,requireAllScope,type Services} from './services.js';
import {gateTenantWrite} from './assets.js';
export const eventActions={'member.created':'成员已创建','member.updated':'成员资料已变更','role.updated':'角色权限已变更','field_schema.published':'产品字段方案已发布','attachment.created':'附件已保存'} as const;
const uuid={type:'string',format:'uuid'};
export async function dispatchLocalEvents(db:Database,context:TenantContext){
 const ids=await db.tenant(context,async sql=>(await sql.query<{id:string}>("SELECT id FROM local_event_outbox WHERE state='pending' AND available_at<=now() ORDER BY created_at,id LIMIT 100")).rows);
 let delivered=0,failed=0;
 for(const {id} of ids){
  try{const done=await db.tenant(context,async sql=>{
   const event=(await sql.query<{id:string;action:keyof typeof eventActions;actor_name:string;entity_id:string;recipient_ids:string[]}>("SELECT * FROM local_event_outbox WHERE id=$1 AND state='pending' FOR UPDATE",[id])).rows[0];if(!event)return false;
   const active=new Set((await sql.query<{id:string}>('SELECT id FROM tenant_team_members')).rows.map(m=>m.id));
   for(const user of event.recipient_ids){if(active.has(user))await sql.query('INSERT INTO user_notifications(tenant_id,event_id,user_id,title,message) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,event_id,user_id) DO NOTHING',[context.tenantId,event.id,user,eventActions[event.action],event.actor_name+' · '+event.entity_id]);}
   await sql.query("UPDATE local_event_outbox SET state='delivered',delivered_at=now(),last_error=NULL WHERE id=$1",[event.id]);return true;
  });if(done)delivered++;}
  catch{failed++;await db.tenant(context,sql=>sql.query("UPDATE local_event_outbox SET attempts=attempts+1,last_error='DELIVERY_FAILED',available_at=now()+interval '30 seconds' WHERE id=$1 AND state='pending'",[id]));}
 }
 return {delivered,failed};
}
export function registerLocalEvents(app:FastifyInstance,s:Services,options:{worker?:boolean}={}){
 const {database:db,context,actor,authorize,requirePermission}=s;
 const config=requirePermission('configuration.manage');
 app.get('/api/events/rules',{preHandler:config},r=>db.tenant(context(r),async sql=>{requireAllScope(actor(r));return {items:(await sql.query('SELECT * FROM event_rules ORDER BY action')).rows,actions:Object.entries(eventActions).map(([key,name])=>({key,name}))};}));
 const props={action:{type:'string',enum:Object.keys(eventActions)},recipient_ids:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:uuid},active:{type:'boolean'},version:{type:'integer',minimum:1}};
 const validRecipients=async(sql:import('./database.js').Sql,ids:string[])=>{const current=new Set((await sql.query<{id:string}>('SELECT id FROM tenant_team_members')).rows.map(m=>m.id));if(ids.some(id=>!current.has(id)))throw new Problem(422,'INVALID_REFERENCE','通知接收人必须是当前企业启用成员');};
 app.post<{Body:{action:string;recipient_ids:string[]}}>('/api/events/rules',{preHandler:config,schema:{body:{type:'object',additionalProperties:false,required:['action','recipient_ids'],properties:{action:props.action,recipient_ids:props.recipient_ids}}}},async(r,reply)=>reply.code(201).send(await db.tenant(context(r),async sql=>{
  requireAllScope(actor(r));await gateTenantWrite(sql,context(r));await validRecipients(sql,r.body.recipient_ids);const rule=(await sql.query('INSERT INTO event_rules(tenant_id,action,recipient_ids) VALUES($1,$2,$3::jsonb) RETURNING *',[actor(r).tenant_id,r.body.action,JSON.stringify(r.body.recipient_ids)])).rows[0]!;await writeAudit(sql,actor(r),'event_rule.created','event_rule',String(rule.id),null,rule);return {rule};
 })));
 app.patch<{Params:{id:string};Body:{recipient_ids:string[];active:boolean;version:number}}>('/api/events/rules/:id',{preHandler:config,schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}},body:{type:'object',additionalProperties:false,required:['recipient_ids','active','version'],properties:{recipient_ids:props.recipient_ids,active:props.active,version:props.version}}}},r=>db.tenant(context(r),async sql=>{
  requireAllScope(actor(r));await gateTenantWrite(sql,context(r));await validRecipients(sql,r.body.recipient_ids);const before=(await sql.query('SELECT * FROM event_rules WHERE id=$1 FOR UPDATE',[r.params.id])).rows[0];if(!before)throw new Problem(404,'EVENT_RULE_NOT_FOUND','事件规则不存在');const rule=(await sql.query('UPDATE event_rules SET recipient_ids=$1::jsonb,active=$2,version=version+1 WHERE id=$3 AND version=$4 RETURNING *',[JSON.stringify(r.body.recipient_ids),r.body.active,r.params.id,r.body.version])).rows[0];if(!rule)throw new Problem(409,'VERSION_CONFLICT','事件规则已被修改，请刷新');await writeAudit(sql,actor(r),'event_rule.updated','event_rule',r.params.id,before,rule);return {rule};
 }));
 app.get('/api/events/outbox',{preHandler:config},r=>db.tenant(context(r),async sql=>{requireAllScope(actor(r));return {items:(await sql.query('SELECT id,action,entity_id,state,attempts,last_error,created_at,delivered_at FROM local_event_outbox ORDER BY created_at DESC LIMIT 100')).rows};}));
 app.post('/api/events/dispatch',{preHandler:config},r=>{requireAllScope(actor(r));return dispatchLocalEvents(db,context(r));});
 app.get('/api/notifications',{preHandler:authorize()},r=>db.tenant(context(r),async sql=>({items:(await sql.query('SELECT id,title,message,read_at,created_at FROM user_notifications WHERE user_id=$1 UNION ALL SELECT id,title,message,read_at,created_at FROM money_notices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[actor(r).user_id])).rows})));
 app.post<{Params:{id:string}}>('/api/notifications/:id/read',{preHandler:authorize(),schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}}}},r=>db.tenant(context(r),async sql=>{let notification=(await sql.query('UPDATE user_notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at',[r.params.id,actor(r).user_id])).rows[0];if(!notification)notification=(await sql.query('UPDATE money_notices SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at',[r.params.id,actor(r).user_id])).rows[0];if(!notification)throw new Problem(404,'NOTIFICATION_NOT_FOUND','通知不存在');return {notification};}));
 let busy=false;const tick=async()=>{if(busy)return;busy=true;try{const tenants=await db.auth(async sql=>(await sql.query<{tenant_id:string;user_id:string}>("SELECT DISTINCT ON(m.tenant_id) m.tenant_id,m.user_id FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.active AND t.active ORDER BY m.tenant_id,m.user_id")).rows);for(const t of tenants)await dispatchLocalEvents(db,{tenantId:t.tenant_id,userId:t.user_id});}catch(error){app.log.error({err:error},'本地事件投递暂未完成，保留队列等待重试');}finally{busy=false;}};
 let timer:ReturnType<typeof setInterval>|undefined;
 if(options.worker)app.addHook('onReady',async()=>{timer=setInterval(()=>{void tick();},10000);timer.unref();});
 app.addHook('onClose',async()=>{if(timer)clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,10));});
}
