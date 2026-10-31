import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {Database} from '../src/database.js';
import {migrate} from '../src/migrations.js';
import {createApp} from '../src/app.js';
import {hashPassword} from '../src/passwords.js';
let db:Database,app:FastifyInstance;
const ta=randomUUID(),tb=randomUUID(),tc=randomUUID(),admin=randomUUID(),planner=randomUUID(),worker=randomUUID(),other=randomUUID(),ua=randomUUID(),ub=randomUUID();
const password='Platform-TestsOnly-LongPassword!';
type Login={cookie:string;csrf:string};let a:Login,b:Login,p:Login,w:Login;
let loginSequence=1;
const h=(s:Login,write=false)=>({cookie:s.cookie,...(write?{'x-csrf-token':s.csrf}:{})});
const code=(prefix:string)=>prefix+'-'+randomUUID().slice(0,8);
async function login(slug:string,name='platform.admin',target=app,expected=200){
 const r=await target.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.'+loginSequence++,payload:{tenant_slug:slug,username:name,password}});assert.equal(r.statusCode,expected,r.body);
 if(expected!==200)return {cookie:'',csrf:''};const raw=r.headers['set-cookie'];assert.ok(raw);return {cookie:(Array.isArray(raw)?raw[0]!:raw).split(';')[0]!,csrf:r.json().csrf_token};
}
async function get(url:string,s=a,expected=200){const r=await app.inject({url,headers:h(s)});assert.equal(r.statusCode,expected,r.body);return r.json();}
async function post(url:string,body:unknown,s=a,expected=201){const r=await app.inject({method:'POST',url,headers:h(s,true),payload:body});assert.equal(r.statusCode,expected,r.body);return r.json();}
async function patch(url:string,body:unknown,s=a,expected=200){const r=await app.inject({method:'PATCH',url,headers:h(s,true),payload:body});assert.equal(r.statusCode,expected,r.body);return r.json();}
async function member(id:string,s=a){return (await get('/api/platform/members',s)).items.find((m:{id:string})=>m.id===id);}
async function updateMember(id:string,extra:Record<string,unknown>,s=a,expected=200){const old=await member(id,s);return patch('/api/platform/members/'+id,{version:old.version,display_name:old.display_name,role:old.role,active:old.active,department_id:old.department_id,custom_role_id:old.custom_role_id,...extra},s,expected);}
async function limits(extra:Record<string,unknown>={}){const old=(await get('/api/tenant-service')).service;return patch('/api/tenant-service',{version:old.version,state:'active',expires_at:null,seat_limit:100,product_limit:10000,storage_limit_bytes:104857600,...extra});}
async function role(perms:string[],scope='all'){return (await post('/api/platform/roles',{code:code('ROLE'),name:'测试角色',permissions:perms,data_scope:scope})).role;}
async function department(name='合成部门',parent_id:string|null=null,s=a){return (await post('/api/platform/departments',{code:code('DEP'),name,parent_id},s)).department;}
async function product(name='合成产品',extra:Record<string,unknown>={},s=a){return (await post('/api/products',{code:code('PRD'),name,unit_id:ua,attribute:'purchased',...extra},s)).product;}

before(async()=>{
 db=new Database({mode:'pglite'});await migrate(db);const hash=await hashPassword(password);
 await db.admin(async sql=>{
  for(const[id,slug]of[[ta,'platform-a'],[tb,'platform-b'],[tc,'platform-c']])await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)',[id,slug,slug]);
  for(const[id,name]of[[admin,'platform.admin'],[planner,'platform.planner'],[worker,'platform.worker'],[other,'platform.other']])await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)',[id,name,name,hash]);
  for(const tenant of[ta,tb])await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tenant,admin]);
  await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tc,other]);
  await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'planner')",[ta,planner]);
  for(const tenant of[ta,tb])await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')",[tenant,worker]);
  for(const[id,tenant]of[[ua,ta],[ub,tb]])await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','个')",[id,tenant]);
 });
 app=await createApp(db,{localEventsWorker:false});a=await login('platform-a');b=await login('platform-b');p=await login('platform-a','platform.planner');w=await login('platform-a','platform.worker');
});
after(async()=>{await app?.close();await db?.close();});

test('组织层级防循环、停用依赖和乐观版本；复合引用及列表/SQL均隔离企业',async()=>{
 const parent=await department('主部门'),child=await department('子部门',parent.id),foreign=await department('B部门',null,b);
 let r=await patch('/api/platform/departments/'+parent.id,{version:1,name:parent.name,active:true,parent_id:child.id},a,422);assert.equal(r.error.code,'DEPARTMENT_CYCLE');
 r=await patch('/api/platform/departments/'+parent.id,{version:1,name:parent.name,active:true,parent_id:parent.id},a,422);assert.equal(r.error.code,'DEPARTMENT_CYCLE');
 await post('/api/platform/workshops',{code:code('WS'),name:'跨企车间',department_id:foreign.id},a,422);
 const workshop=(await post('/api/platform/workshops',{code:code('WS'),name:'测试车间',department_id:parent.id})).workshop;
 const line=(await post('/api/platform/lines',{code:code('LN'),name:'测试产线',workshop_id:workshop.id})).line;
 await patch('/api/platform/departments/'+parent.id,{version:1,name:parent.name,active:false,parent_id:null},a,409);
 await patch('/api/platform/workshops/'+workshop.id,{version:1,name:workshop.name,active:false,department_id:parent.id},a,409);
 await patch('/api/platform/lines/'+line.id,{version:1,name:line.name,active:false,workshop_id:workshop.id});
 await patch('/api/platform/workshops/'+workshop.id,{version:1,name:workshop.name,active:false,department_id:parent.id});
 await patch('/api/platform/departments/'+child.id,{version:1,name:child.name,active:false,parent_id:parent.id});
 await patch('/api/platform/departments/'+parent.id,{version:1,name:parent.name,active:false,parent_id:null});
 await patch('/api/platform/departments/'+child.id,{version:1,name:'过期覆盖',active:true,parent_id:null},a,409);
 await post('/api/platform/workshops',{code:code('WS'),name:'停用上级',department_id:parent.id},a,422);
 const list=(await get('/api/platform/departments',b)).items;assert.ok(!list.some((x:{id:string})=>x.id===parent.id));
 await assert.rejects(db.tenant({tenantId:ta,userId:admin},sql=>sql.query('INSERT INTO workshops(tenant_id,code,name,department_id) VALUES($1,$2,$3,$4)',[ta,code('RAW'),'错企引用',foreign.id])),/foreign key/i);
});

test('企业成员别名不修改共享users或另企业，版本冲突及自己/最后管理员保护',async()=>{
 const old=await member(worker);const changed=(await updateMember(worker,{display_name:'企业A现场人员'})).member;assert.equal(changed.version,old.version+1);
 assert.equal((await get('/api/auth/me',w)).user.display_name,'企业A现场人员');
 const wb=await login('platform-b','platform.worker');assert.equal((await get('/api/auth/me',wb)).user.display_name,'platform.worker');assert.equal((await member(worker,b)).display_name,'platform.worker');
 const global=(await db.admin(sql=>sql.query<{display_name:string}>('SELECT display_name FROM users WHERE id=$1',[worker]))).rows[0]!;assert.equal(global.display_name,'platform.worker');
 await patch('/api/platform/members/'+worker,{version:old.version,display_name:'旧版本覆盖',role:'worker',active:true,department_id:null,custom_role_id:null},a,409);
 let r=await updateMember(admin,{active:false},a,409);assert.equal(r.error.code,'SELF_ADMIN_PROTECTION');
 const manager=await role(['organization.manage','master.read','configuration.read']);await updateMember(planner,{custom_role_id:manager.id});p=await login('platform-a','platform.planner');
 r=await updateMember(admin,{active:false},p,409);assert.equal(r.error.code,'LAST_ADMIN');
 await updateMember(planner,{custom_role_id:null});p=await login('platform-a','platform.planner');
});

test('创建与恢复成员均执行席位配额，停用立即注销旧cookie且恢复不复活，密码不入响应和审计',async()=>{
 const initial=(await get('/api/tenant-service')).service.seat_used;await limits({seat_limit:initial});
 const username=code('seat.user');const body={username,display_name:'本机席位测试',password,role:'worker'};
 const refused=await post('/api/platform/members',body,a,409);assert.equal(refused.error.code,'SEAT_QUOTA_EXCEEDED');
 assert.equal((await db.admin(sql=>sql.query('SELECT id FROM users WHERE username=$1',[username]))).rows.length,0);
 await limits({seat_limit:initial+1});const created=(await post('/api/platform/members',body)).member;
 assert.ok(!JSON.stringify(created).includes('password'));assert.ok(!JSON.stringify(created).includes(password));
 const audit=(await db.tenant({tenantId:ta,userId:admin},sql=>sql.query('SELECT before_data,after_data FROM audit_events WHERE entity_id=$1',[created.id]))).rows;assert.ok(!JSON.stringify(audit).includes(password));assert.ok(!JSON.stringify(audit).includes('password_hash'));
 const session=await login('platform-a',username);await updateMember(created.id,{active:false});await get('/api/auth/me',session,401);
 await limits({seat_limit:initial});const restore=await updateMember(created.id,{active:true},a,409);assert.equal(restore.error.code,'SEAT_QUOTA_EXCEEDED');assert.equal((await member(created.id)).active,false);
 await limits({seat_limit:initial+1});await updateMember(created.id,{active:true});await get('/api/auth/me',session,401);const fresh=await login('platform-a',username);await get('/api/auth/me',fresh);
 await limits();
});

test('成员审计失败回滚users/membership/profile，gd_platform不能跨企写成员或读密码/改users',async()=>{
 const username=code('rollback.user');const before=(await db.admin(sql=>sql.query('SELECT (SELECT count(*) FROM users)::text AS users,(SELECT count(*) FROM memberships)::text AS members,(SELECT count(*) FROM tenant_member_profiles)::text AS profiles'))).rows[0];
 await db.admin(sql=>sql.exec("CREATE FUNCTION reject_platform_member_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='member.created' THEN RAISE EXCEPTION 'injected member audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_platform_member_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_platform_member_audit()"));
 try{await post('/api/platform/members',{username,display_name:'必须回滚',password,role:'worker'},a,500);}finally{await db.admin(sql=>sql.exec('DROP TRIGGER reject_platform_member_audit ON audit_events; DROP FUNCTION reject_platform_member_audit()'));}
 const after=(await db.admin(sql=>sql.query('SELECT (SELECT count(*) FROM users)::text AS users,(SELECT count(*) FROM memberships)::text AS members,(SELECT count(*) FROM tenant_member_profiles)::text AS profiles'))).rows[0];assert.deepEqual(after,before);
 const hidden=await db.identity({tenantId:ta,userId:admin},sql=>sql.query('SELECT user_id FROM memberships WHERE tenant_id=$1',[tb]));assert.deepEqual(hidden.rows,[]);
 const changed=await db.identity({tenantId:ta,userId:admin},sql=>sql.query("UPDATE memberships SET role='worker' WHERE tenant_id=$1 AND user_id=$2 RETURNING user_id",[tb,admin]));assert.equal(changed.rows.length,0);
 await assert.rejects(db.identity({tenantId:ta,userId:admin},sql=>sql.query('SELECT password_hash FROM users')),/permission denied/i);
 await assert.rejects(db.identity({tenantId:ta,userId:admin},sql=>sql.query("UPDATE users SET display_name='tamper' WHERE id=$1",[worker])),/permission denied/i);
 await assert.rejects(db.identity({tenantId:ta,userId:admin},sql=>sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')",[tb,planner])),/row.level security/i);
 assert.equal((await member(admin,b)).role,'admin');
});

test('自定义角色可授权base worker维护主数据；能力撤销现有cookie立即生效并校验权限依赖',async()=>{
 await post('/api/platform/roles',{code:code('BAD'),name:'缺读取依赖',permissions:['master.write'],data_scope:'all'},a,422);
 await post('/api/platform/roles',{code:code('BAD'),name:'范围不支持',permissions:['master.read','configuration.read','master.write'],data_scope:'self'},a,422);
 const custom=await role(['master.read','configuration.read','master.write']);await updateMember(worker,{custom_role_id:custom.id});w=await login('platform-a','platform.worker');
 const own=await product('工人获得维护权限',{},w);assert.equal(own.created_by_id,worker);
 const forged=await post('/api/products',{code:code('FORGE'),name:'不能伪造作者',unit_id:ua,attribute:'purchased',created_by_id:admin},w,400);assert.equal(forged.error.code,'VALIDATION_ERROR');
 await patch('/api/platform/roles/'+custom.id,{version:1,name:custom.name,permissions:['master.read','configuration.read'],data_scope:'all',active:true});
 await post('/api/products',{code:code('NO'),name:'撤销后的写入',unit_id:ua,attribute:'purchased'},w,403);await get('/api/products',w);
 await patch('/api/platform/roles/'+custom.id,{version:2,name:custom.name,permissions:['master.read','configuration.read'],data_scope:'all',active:false});await get('/api/products',w,403);
 const configOnly=await role(['configuration.read']);await updateMember(worker,{custom_role_id:configOnly.id});w=await login('platform-a','platform.worker');
 await get('/api/products',w,403);await get('/api/configuration/product-fields/'+own.id,w,403);await get('/api/configuration/field-schemas',w);
 await updateMember(worker,{custom_role_id:null});w=await login('platform-a','platform.worker');
});

test('产品department/self范围贯穿搜索count/overview/附件，未接入工序/路线/BOM/预检/审计明确拒绝',async()=>{
 const da=await department('范围A'),dz=await department('范围Z');const pa=await product('部门A限定',{department_id:da.id}),pz=await product('部门Z隐藏',{department_id:dz.id}),ps=await product('本人限定',{department_id:dz.id});
 await db.tenant({tenantId:ta,userId:admin},sql=>sql.query('UPDATE products SET created_by_id=$1 WHERE id=$2',[worker,ps.id]));
 const file=(await post('/api/attachments',{resource_type:'product',resource_id:pz.id,filename:'范围.txt',mime:'text/plain',content_base64:Buffer.from('范围合成').toString('base64'),request_key:randomUUID()})).attachment;
 const scoped=await role(['master.read','configuration.read','attachments.read'],'department');await updateMember(worker,{custom_role_id:scoped.id,department_id:da.id});w=await login('platform-a','platform.worker');
 const list=await get('/api/products?page_size=100',w);assert.equal(list.total,1);assert.deepEqual(list.items.map((i:{id:string})=>i.id),[pa.id]);assert.equal((await get('/api/products?q='+encodeURIComponent(pz.code),w)).total,0);assert.equal((await get('/api/overview',w)).products,1);
 await get('/api/attachments/'+file.id+'/content',w,404);
 for(const url of['/api/processes','/api/routes','/api/boms','/api/design-preview/definitions','/api/audit-events','/api/tenant-service'])await get(url,w,403);
 await patch('/api/platform/roles/'+scoped.id,{version:1,name:scoped.name,permissions:['master.read','configuration.read','attachments.read'],data_scope:'self',active:true});
 const self=await get('/api/products?q='+encodeURIComponent(ps.code),w);assert.equal(self.total,1);assert.equal(self.items[0].id,ps.id);assert.equal((await get('/api/products?q='+encodeURIComponent(pa.code),w)).total,0);
 const expectedCount=Number((await db.tenant({tenantId:ta,userId:admin},sql=>sql.query<{n:string}>('SELECT count(*)::text AS n FROM products WHERE created_by_id=$1',[worker]))).rows[0]!.n);assert.equal((await get('/api/overview',w)).products,expectedCount);
 await updateMember(worker,{custom_role_id:null,department_id:null});w=await login('platform-a','platform.worker');
});

test('企业开通幂等且生产关闭，切换校验成员资格并旋转cookie/CSRF使旧session失效；只读拦组织与主数据写',async()=>{
 const body={slug:'stage3-'+randomUUID().slice(0,8),name:'本机开通测试',request_key:randomUUID()};const first=await post('/api/platform/tenants',body);const again=await post('/api/platform/tenants',body,a,200);assert.equal(again.tenant.id,first.tenant.id);assert.equal(again.replayed,true);await post('/api/platform/tenants',{...body,name:'另一企业'},a,409);
 const forbidden=await post('/api/auth/switch-tenant',{tenant_id:tc},a,403);assert.equal(forbidden.error.code,'TENANT_NOT_AUTHORIZED');await get('/api/auth/me',a);
 const old=a;const switched=await app.inject({method:'POST',url:'/api/auth/switch-tenant',headers:h(old,true),payload:{tenant_id:tb}});assert.equal(switched.statusCode,200,switched.body);assert.equal(switched.json().tenant.id,tb);assert.notEqual(switched.json().csrf_token,old.csrf);const raw=switched.headers['set-cookie'];assert.ok(raw);const next={cookie:(Array.isArray(raw)?raw[0]!:raw).split(';')[0]!,csrf:switched.json().csrf_token};assert.notEqual(next.cookie,old.cookie);await get('/api/auth/me',old,401);
 const wrongCsrf=await app.inject({method:'POST',url:'/api/auth/switch-tenant',headers:{cookie:next.cookie,'x-csrf-token':old.csrf},payload:{tenant_id:ta}});assert.equal(wrongCsrf.statusCode,403);assert.equal(wrongCsrf.json().error.code,'CSRF_REJECTED');a=await login('platform-a');
 await limits({state:'read_only'});const org=await post('/api/platform/departments',{code:code('READONLY'),name:'拒绝'},a,403);assert.equal(org.error.code,'SERVICE_READ_ONLY');await post('/api/units',{code:code('READONLY'),name:'拒绝'},a,403);await get('/api/products');await limits();
 const prod=await createApp(db,{production:true,origin:'https://platform.test',localEventsWorker:false});try{const session=await login('platform-a','platform.admin',prod);const r=await prod.inject({method:'POST',url:'/api/platform/tenants',headers:h(session,true),payload:{slug:'prod-'+randomUUID().slice(0,8),name:'不可自己开通',request_key:randomUUID()}});assert.equal(r.statusCode,403);assert.equal(r.json().error.code,'PLATFORM_ENROLLMENT_REQUIRED');}finally{await prod.close();}
});

test('受限目录owner/读取policy被放宽时启动安全guard拒绝，运行角色无目录成员资格和密码读取',async()=>{
 const counts=(await db.tenant({tenantId:ta,userId:admin},sql=>sql.query<{n:string}>('SELECT count(*)::text AS n FROM tenant_team_members'))).rows[0]!;assert.ok(Number(counts.n)>=3);
 const membership=(await db.admin(sql=>sql.query<{unsafe:boolean}>("SELECT pg_has_role('gd_auth','gd_directory','MEMBER') OR pg_has_role('gd_tenant','gd_directory','MEMBER') OR pg_has_role('gd_platform','gd_directory','MEMBER') OR has_column_privilege('gd_directory','users','password_hash','SELECT') AS unsafe"))).rows[0]!;assert.equal(membership.unsafe,false);
 await db.admin(sql=>sql.exec("ALTER POLICY memberships_directory_read ON memberships USING(true)"));try{await assert.rejects(db.assertSecurityConfiguration(),/目录所有者/);}finally{await db.admin(sql=>sql.exec("ALTER POLICY memberships_directory_read ON memberships USING(tenant_id::text=NULLIF(current_setting('app.tenant_id',true),''))"));}
 await db.admin(sql=>sql.exec("DO $$ BEGIN EXECUTE format('ALTER VIEW tenant_team_members OWNER TO %I',current_user); END $$;"));try{await assert.rejects(db.assertSecurityConfiguration(),/成员视图/);}finally{await db.admin(sql=>sql.exec('GRANT CREATE ON SCHEMA public TO gd_directory; ALTER VIEW tenant_team_members OWNER TO gd_directory; REVOKE CREATE ON SCHEMA public FROM gd_directory'));}
 await db.assertSecurityConfiguration();
});


test('产品部门归属调整独立于主数据维护权限，无组织权限不能改变部门可见范围',async()=>{
 const d=await department('组织管理专用部门');const productRow=await product('部门归属安全',{department_id:d.id});
 const beforeAudit=(await get('/api/audit-events')).items.length;
 await post('/api/products',{code:code('FORGED-DEP'),name:'绕权',unit_id:ua,attribute:'manufactured',department_id:d.id},p,403);
 await patch('/api/products/'+productRow.id,{version:productRow.version,name:productRow.name,specification:productRow.specification,unit_id:productRow.unit_id,attribute:productRow.attribute,active:true,department_id:null},p,403);
 const retained=(await get('/api/products?q='+encodeURIComponent(productRow.code))).items[0];assert.equal(retained.department_id,d.id);assert.equal(retained.version,productRow.version);assert.equal((await get('/api/audit-events')).items.length,beforeAudit);
 const updated=(await patch('/api/products/'+productRow.id,{version:productRow.version,name:productRow.name,specification:productRow.specification,unit_id:productRow.unit_id,attribute:productRow.attribute,active:true},p)).product;assert.equal(updated.department_id,d.id);
 const changed=(await patch('/api/products/'+productRow.id,{version:updated.version,name:productRow.name,specification:productRow.specification,unit_id:productRow.unit_id,attribute:productRow.attribute,active:true,department_id:null})).product;assert.equal(changed.department_id,null);
});
