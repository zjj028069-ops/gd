import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {Database} from '../src/database.js';
import {migrate} from '../src/migrations.js';
import {createApp} from '../src/app.js';
import {hashPassword} from '../src/passwords.js';
let db:Database,app:FastifyInstance;
const ta=randomUUID(),tb=randomUUID(),admin=randomUUID(),worker=randomUUID(),second=randomUUID(),observer=randomUUID(),foreign=randomUUID(),inactive=randomUUID(),disabled=randomUUID();
const password='Events-TestsOnly-LongPassword!';
type Login={cookie:string;csrf:string};let a:Login,b:Login,w:Login,o:Login;
const h=(s:Login,write=false)=>({cookie:s.cookie,...(write?{'x-csrf-token':s.csrf}:{})});
async function login(slug:string,name='events.admin'){const r=await app.inject({method:'POST',url:'/api/auth/login',payload:{tenant_slug:slug,username:name,password}});assert.equal(r.statusCode,200,r.body);const raw=r.headers['set-cookie'];assert.ok(raw);return {cookie:(Array.isArray(raw)?raw[0]!:raw).split(';')[0]!,csrf:r.json().csrf_token};}
async function get(url:string,s=a,expected=200){const r=await app.inject({url,headers:h(s)});assert.equal(r.statusCode,expected,r.body);return r.json();}
async function post(url:string,body:unknown={},s=a,expected=201){const r=await app.inject({method:'POST',url,headers:h(s,true),payload:body});assert.equal(r.statusCode,expected,r.body);return r.json();}
async function patch(url:string,body:unknown,s=a,expected=200){const r=await app.inject({method:'PATCH',url,headers:h(s,true),payload:body});assert.equal(r.statusCode,expected,r.body);return r.json();}
async function createMember(){return (await post('/api/platform/members',{username:'events.new.'+randomUUID().slice(0,8),display_name:'事件合成成员',password,role:'worker'})).member;}
async function eventFor(entity:string){return (await db.tenant({tenantId:ta,userId:admin},sql=>sql.query<{id:string;recipient_ids:string[];state:string;attempts:number;last_error:string|null;source_audit_id:string}>('SELECT * FROM local_event_outbox WHERE entity_id=$1',[entity]))).rows[0]!;}
async function rule(){return (await get('/api/events/rules')).items.find((r:{action:string})=>r.action==='member.created');}
async function setRuleRecipients(ids:string[]){const old=await rule();return patch('/api/events/rules/'+old.id,{version:old.version,recipient_ids:ids,active:true});}
async function updateSecond(active:boolean){const old=(await get('/api/platform/members')).items.find((m:{id:string})=>m.id===second);return patch('/api/platform/members/'+second,{version:old.version,display_name:old.display_name,role:old.role,active,department_id:null,custom_role_id:null});}

before(async()=>{
 db=new Database({mode:'pglite'});await migrate(db);const hash=await hashPassword(password);
 await db.admin(async sql=>{
  for(const[id,slug]of[[ta,'events-a'],[tb,'events-b']])await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)',[id,slug,slug]);
  for(const[id,name]of[[admin,'events.admin'],[worker,'events.worker'],[second,'events.second'],[observer,'events.observer'],[foreign,'events.foreign'],[inactive,'events.inactive'],[disabled,'events.disabled']])await sql.query('INSERT INTO users(id,username,display_name,password_hash,active) VALUES($1,$2,$3,$4,$5)',[id,name,name,hash,id!==disabled]);
  for(const tenant of[ta,tb])await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tenant,admin]);
  for(const id of[worker,second,observer,inactive,disabled])await sql.query("INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'worker',$3)",[ta,id,id!==inactive]);
  await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')",[tb,foreign]);
 });
 app=await createApp(db,{localEventsWorker:false});a=await login('events-a');b=await login('events-b');w=await login('events-a','events.worker');o=await login('events-a','events.observer');
});
after(async()=>{await app?.close();await db?.close();});

test('本地事件只接收白名单与当前启用成员，企业隔离、权限和规则乐观版本均执行',async()=>{
 const invalid=await post('/api/events/rules',{action:'http.post',recipient_ids:[worker]},a,400);assert.equal(invalid.error.code,'VALIDATION_ERROR');
 await post('/api/events/rules',{action:'member.created',recipient_ids:[foreign]},a,422);await post('/api/events/rules',{action:'member.created',recipient_ids:[inactive]},a,422);await post('/api/events/rules',{action:'member.created',recipient_ids:[disabled]},a,422);
 await post('/api/events/rules',{action:'member.created',recipient_ids:[worker]},w,403);
 const created=(await post('/api/events/rules',{action:'member.created',recipient_ids:[worker,second]})).rule;assert.equal(created.version,1);
 const secondRule=await patch('/api/events/rules/'+created.id,{version:1,recipient_ids:[worker,second],active:true});assert.equal(secondRule.rule.version,2);
 await patch('/api/events/rules/'+created.id,{version:1,recipient_ids:[worker],active:true},a,409);
 assert.equal((await get('/api/events/rules',b)).items.length,0);await patch('/api/events/rules/'+created.id,{version:2,recipient_ids:[admin],active:true},b,404);
 await assert.rejects(db.tenant({tenantId:ta,userId:admin},sql=>sql.query("INSERT INTO event_rules(tenant_id,action,recipient_ids) VALUES($1,'role.updated',$2::jsonb)",[tb,JSON.stringify([admin])])),/row.level security/i);
});

test('审计提交原子生成接收人快照，竞争dispatch只投一次；停用接收人跳过，本人通知/read不受伪造用户或另企业影响',async()=>{
 const member=await createMember(),event=await eventFor(member.id);assert.ok(event);assert.deepEqual(event.recipient_ids,[worker,second]);assert.equal(event.state,'pending');
 const source=(await db.tenant({tenantId:ta,userId:admin},sql=>sql.query<{action:string}>('SELECT action FROM audit_events WHERE id=$1',[event.source_audit_id]))).rows[0]!;assert.equal(source.action,'member.created');
 await setRuleRecipients([admin]);assert.deepEqual((await eventFor(member.id)).recipient_ids,[worker,second]);
 await updateSecond(false);
 const dispatched=await Promise.all([post('/api/events/dispatch',{},a,200),post('/api/events/dispatch',{},a,200)]);assert.equal(dispatched.reduce((n,r)=>n+r.delivered,0),1);assert.equal(dispatched.reduce((n,r)=>n+r.failed,0),0);
 const rows=(await db.tenant({tenantId:ta,userId:admin},sql=>sql.query<{id:string;user_id:string}>('SELECT id,user_id FROM user_notifications WHERE event_id=$1',[event.id]))).rows;assert.equal(rows.length,1);assert.equal(rows[0]!.user_id,worker);
 const notifications=(await get('/api/notifications?user_id='+observer,w)).items;assert.equal(notifications.length,1);assert.equal(notifications[0].id,rows[0]!.id);assert.equal((await get('/api/notifications',o)).items.length,0);assert.equal((await get('/api/notifications',a)).items.length,0);assert.equal((await get('/api/notifications',b)).items.length,0);
 await post('/api/notifications/'+rows[0]!.id+'/read',{user_id:worker},a,404);await post('/api/notifications/'+rows[0]!.id+'/read',{},b,404);
 const read=await post('/api/notifications/'+rows[0]!.id+'/read',{},w,200);assert.ok(read.notification.read_at);const again=await post('/api/notifications/'+rows[0]!.id+'/read',{},w,200);assert.equal(again.notification.read_at,read.notification.read_at);
 const repeat=await post('/api/events/dispatch',{},a,200);assert.deepEqual(repeat,{delivered:0,failed:0});assert.equal((await eventFor(member.id)).state,'delivered');await updateSecond(true);await setRuleRecipients([worker,second]);
});

test('第二位接收人投递失败不会留下半份通知，保存attempt/error和延时，再试原事件恢复且不重复',async()=>{
 const member=await createMember(),event=await eventFor(member.id);assert.deepEqual(event.recipient_ids,[worker,second]);
 await db.admin(sql=>sql.exec(`CREATE FUNCTION reject_second_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${second}'::uuid THEN RAISE EXCEPTION 'injected second recipient failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_second_notification BEFORE INSERT ON user_notifications FOR EACH ROW EXECUTE FUNCTION reject_second_notification()`));
 try{
  const failed=await post('/api/events/dispatch',{},a,200);assert.deepEqual(failed,{delivered:0,failed:1});const kept=await eventFor(member.id);assert.equal(kept.state,'pending');assert.equal(kept.attempts,1);assert.equal(kept.last_error,'DELIVERY_FAILED');
  const rows=(await db.tenant({tenantId:ta,userId:admin},sql=>sql.query('SELECT id FROM user_notifications WHERE event_id=$1',[event.id]))).rows;assert.deepEqual(rows,[]);
  const notDue=await post('/api/events/dispatch',{},a,200);assert.deepEqual(notDue,{delivered:0,failed:0});assert.equal((await eventFor(member.id)).attempts,1);
 }finally{await db.admin(sql=>sql.exec('DROP TRIGGER reject_second_notification ON user_notifications; DROP FUNCTION reject_second_notification()'));}
 await db.tenant({tenantId:ta,userId:admin},sql=>sql.query('UPDATE local_event_outbox SET available_at=now() WHERE id=$1',[event.id]));
 const recovered=await post('/api/events/dispatch',{},a,200);assert.deepEqual(recovered,{delivered:1,failed:0});const delivered=await eventFor(member.id);assert.equal(delivered.state,'delivered');assert.equal(delivered.attempts,1);assert.equal(delivered.last_error,null);
 const rows=(await db.tenant({tenantId:ta,userId:admin},sql=>sql.query('SELECT user_id FROM user_notifications WHERE event_id=$1',[event.id]))).rows;assert.equal(rows.length,2);assert.equal(new Set(rows.map(x=>x.user_id)).size,2);assert.deepEqual(await post('/api/events/dispatch',{},a,200),{delivered:0,failed:0});
 await assert.rejects(db.tenant({tenantId:ta,userId:admin},sql=>sql.query('INSERT INTO user_notifications(tenant_id,event_id,user_id,title,message) VALUES($1,$2,$3,$4,$5)',[ta,event.id,foreign,'错企接收人','不能引用'])),/foreign key/i);
});

test('outbox写入失败回滚源成员、身份、审计和队列；只读拒绝规则写，消息不含密码或源数据快照',async()=>{
 const counts=()=>db.admin(sql=>sql.query('SELECT (SELECT count(*) FROM users)::text AS users,(SELECT count(*) FROM memberships)::text AS members,(SELECT count(*) FROM tenant_member_profiles)::text AS profiles,(SELECT count(*) FROM audit_events)::text AS audits,(SELECT count(*) FROM local_event_outbox)::text AS events'));
 const before=(await counts()).rows[0];const username='events.rollback.'+randomUUID().slice(0,8);
 await db.admin(sql=>sql.exec("CREATE FUNCTION reject_local_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected enqueue failure'; END $$; CREATE TRIGGER reject_local_outbox BEFORE INSERT ON local_event_outbox FOR EACH ROW EXECUTE FUNCTION reject_local_outbox()"));
 try{await post('/api/platform/members',{username,display_name:'全事务回滚',password,role:'worker'},a,500);}finally{await db.admin(sql=>sql.exec('DROP TRIGGER reject_local_outbox ON local_event_outbox; DROP FUNCTION reject_local_outbox()'));}
 assert.deepEqual((await counts()).rows[0],before);
 const notifications=(await get('/api/notifications',w)).items;assert.ok(!JSON.stringify(notifications).includes(password));assert.ok(!JSON.stringify(notifications).includes('password_hash'));assert.ok(!JSON.stringify(notifications).includes('after_data'));
 const old=(await get('/api/tenant-service')).service;
 await patch('/api/tenant-service',{version:old.version,state:'read_only',expires_at:null,seat_limit:100,product_limit:10000,storage_limit_bytes:104857600});
 const refused=await post('/api/events/rules',{action:'role.updated',recipient_ids:[worker]},a,403);assert.equal(refused.error.code,'SERVICE_READ_ONLY');
 const current=(await get('/api/tenant-service')).service;await patch('/api/tenant-service',{version:current.version,state:'active',expires_at:null,seat_limit:100,product_limit:10000,storage_limit_bytes:104857600});
});
