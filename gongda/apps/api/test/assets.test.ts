import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { gateTenantWrite, MAX_ATTACHMENT_BYTES } from '../src/assets.js';
let db:Database;let app:FastifyInstance;
const tenantA=randomUUID(),tenantB=randomUUID(),admin=randomUUID(),worker=randomUUID(),unitA=randomUUID(),unitB=randomUUID(),productA=randomUUID(),productB=randomUUID(),processA=randomUUID();
const password='Assets-TestOnly-LongPassword!';
type Login={cookie:string;csrf:string};let a:Login,b:Login,w:Login;
const headers=(s:Login,write=false)=>({cookie:s.cookie,...(write?{'x-csrf-token':s.csrf}:{})});
async function login(slug:string,username='assets.admin'){
 const response=await app.inject({method:'POST',url:'/api/auth/login',payload:{tenant_slug:slug,username,password}});
 assert.equal(response.statusCode,200,response.body);const cookie=response.headers['set-cookie'];assert.ok(cookie);
 return {cookie:(Array.isArray(cookie)?cookie[0]!:cookie).split(';')[0]!,csrf:response.json().csrf_token};
}
async function service(session=a){const r=await app.inject({url:'/api/tenant-service',headers:headers(session)});assert.equal(r.statusCode,200,r.body);return r.json().service;}
async function limits(change:Record<string,unknown>={},session=a){
 const old=await service(session);
 const r=await app.inject({method:'PATCH',url:'/api/tenant-service',headers:headers(session,true),payload:{version:old.version,state:'active',expires_at:null,seat_limit:100,product_limit:10000,storage_limit_bytes:100*1024*1024,...change}});
 assert.equal(r.statusCode,200,r.body);return r.json().service;
}
function payload(value='本机合成附件',extra:Record<string,unknown>={}){return {resource_type:'product',resource_id:productA,filename:'测试附件.txt',mime:'text/plain',content_base64:Buffer.from(value).toString('base64'),request_key:randomUUID(),...extra};}
async function upload(body:Record<string,unknown>,session=a,expected=201){const r=await app.inject({method:'POST',url:'/api/attachments',headers:headers(session,true),payload:body});assert.equal(r.statusCode,expected,r.body);return r.json();}
async function rawUsage(){return Number((await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query<{storage_used_bytes:string}>('SELECT storage_used_bytes FROM tenant_service_limits'))).rows[0]?.storage_used_bytes??0);}
async function audits(id:string){return (await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('SELECT id FROM audit_events WHERE entity_id=$1',[id]))).rows.length;}

before(async()=>{
 db=new Database({mode:'pglite'});await migrate(db);const hash=await hashPassword(password);
 await db.admin(async sql=>{
  for(const [id,slug]of[[tenantA,'assets-a'],[tenantB,'assets-b']])await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)',[id,slug,slug]);
  for(const[id,name]of[[admin,'assets.admin'],[worker,'assets.worker']])await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)',[id,name,name,hash]);
  for(const tenant of[tenantA,tenantB])await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tenant,admin]);
  await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'worker')",[tenantA,worker]);
  for(const[id,tenant]of[[unitA,tenantA],[unitB,tenantB]])await sql.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'EA','个')",[id,tenant]);
  for(const[id,tenant,unit]of[[productA,tenantA,unitA],[productB,tenantB,unitB]])await sql.query("INSERT INTO products(id,tenant_id,code,name,unit_id,attribute) VALUES($1,$2,'S3-ATTACH','合成测试产品',$3,'purchased')",[id,tenant,unit]);
  await sql.query("INSERT INTO processes(id,tenant_id,code,name) VALUES($1,$2,'ATTACH-CUT','附件工序')",[processA,tenantA]);
 });
 app=await createApp(db);a=await login('assets-a');b=await login('assets-b');w=await login('assets-a','assets.worker');
});
after(async()=>{await app?.close();await db?.close();});

test('附件真实字节保存、下载认证与内容哈希、响应强制attachment/nosniff，审计不含文件内容',async()=>{
 await limits();const body=payload('attachment\n合成文字');const {attachment}=await upload(body);
 const bytes=Buffer.from('attachment\n合成文字');assert.equal(attachment.byte_size,bytes.length);assert.equal(attachment.sha256,createHash('sha256').update(bytes).digest('hex'));
 const r=await app.inject({url:`/api/attachments/${attachment.id}/content`,headers:headers(w)});
 assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.rawPayload,bytes);assert.equal(r.headers['content-type'],'text/plain');assert.match(String(r.headers['content-disposition']),/^attachment;/);assert.equal(r.headers['x-content-type-options'],'nosniff');
 const unauth=await app.inject({url:`/api/attachments/${attachment.id}/content`});assert.equal(unauth.statusCode,401);
 const audit=(await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query<{after_data:unknown}>('SELECT after_data FROM audit_events WHERE entity_id=$1',[attachment.id]))).rows[0]!.after_data;
 assert.equal(await audits(attachment.id),1);assert.ok(!JSON.stringify(audit).includes(body.content_base64));
});

test('猜测其他企业资源/附件ID无内容；数据库复合FK和强制RLS拒绝跨企引用',async()=>{
 await limits();const {attachment}=await upload(payload('A的文件'));
 const foreignList=await app.inject({url:`/api/attachments?resource_type=product&resource_id=${productA}`,headers:headers(b)});assert.equal(foreignList.statusCode,404);
 const foreignRead=await app.inject({url:`/api/attachments/${attachment.id}/content`,headers:headers(b)});assert.equal(foreignRead.statusCode,404);
 await upload(payload('错企引用',{resource_id:productB}),a,404);
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('INSERT INTO attachments(tenant_id,product_id,filename,mime,byte_size,sha256,payload,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[tenantA,productB,'cross.txt','text/plain',1,'a'.repeat(64),Buffer.from('x'),randomUUID()])),/foreign key/i);
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('INSERT INTO tenant_service_limits(tenant_id) VALUES($1)',[tenantB])),/row.level security/i);
 const cross=(await db.tenant({tenantId:tenantB,userId:admin},sql=>sql.query('SELECT id FROM attachments WHERE id=$1',[attachment.id]))).rows;assert.deepEqual(cross,[]);
});

test('支持PNG/JPEG/PDF签名和UTF8文本，拒绝伪造类型、路径、非法Base64及二进制文本',async()=>{
 await limits();
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 await upload(payload('',{filename:'单像素.png',mime:'image/png',content_base64:png.toString('base64')}));
 await upload(payload('',{filename:'最小文件.jpg',mime:'image/jpeg',content_base64:Buffer.from([255,216,255,224,255,217]).toString('base64')}));
 await upload(payload('',{filename:'合成文件.pdf',mime:'application/pdf',content_base64:Buffer.from('%PDF-1.7\n合成样例\n%%EOF').toString('base64')}));
 for(const extra of[{mime:'image/png'},{mime:'application/pdf'},{filename:'../../escape.txt'},{filename:'x\\file.txt'},{filename:' x.txt'},{content_base64:'abc!'},{content_base64:'eA'},{content_base64:'eB=='},{content_base64:Buffer.from([0]).toString('base64')},{content_base64:Buffer.from([255]).toString('base64')}]){
  const r=await app.inject({method:'POST',url:'/api/attachments',headers:headers(a,true),payload:payload('plain',extra)});assert.ok([400,422].includes(r.statusCode),r.body);
 }
 await upload(payload('worker denied'),w,403);
});

test('2MiB字节上限与HTTP请求体上限均执行，不依赖前端检查',async()=>{
 await limits({storage_limit_bytes:20*1024*1024});
 const exact=Buffer.alloc(MAX_ATTACHMENT_BYTES,97);await upload(payload('',{filename:'2MiB.txt',content_base64:exact.toString('base64')}));
 const over=await app.inject({method:'POST',url:'/api/attachments',headers:headers(a,true),payload:payload('',{content_base64:Buffer.alloc(MAX_ATTACHMENT_BYTES+1,97).toString('base64')})});assert.equal(over.statusCode,413,over.body);
 const huge=await app.inject({method:'POST',url:'/api/attachments',headers:headers(a,true),payload:{...payload(''),content_base64:'a'.repeat(4*1024*1024)}});assert.equal(huge.statusCode,413,huge.body);
});

test('上传请求幂等并发重试只存一次且只占一次额度；冲突请求和软删重试不会复活',async()=>{
 await limits();const before=await rawUsage();const body=payload('retry once',{resource_id:productA.toUpperCase()});
 const results=await Promise.all([app.inject({method:'POST',url:'/api/attachments',headers:headers(a,true),payload:body}),app.inject({method:'POST',url:'/api/attachments',headers:headers(a,true),payload:body})]);
 assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,201]);const id=results[0]!.json().attachment.id;assert.equal(results[1]!.json().attachment.id,id);
 assert.equal(await rawUsage(),before+Buffer.byteLength('retry once'));assert.equal(await audits(id),1);
 await upload({...body,filename:'另一名称.txt'},a,409);await upload({...body,content_base64:Buffer.from('changed').toString('base64')},a,409);
 const deleted=await app.inject({method:'DELETE',url:'/api/attachments/'+id,headers:headers(a,true),payload:{version:1}});assert.equal(deleted.statusCode,200,deleted.body);
 const replay=await upload(body,a,200);assert.equal(replay.replayed,true);assert.ok(replay.attachment.deleted_at);assert.equal(replay.attachment.active,false);assert.equal(await rawUsage(),before+Buffer.byteLength('retry once'));
});

test('存储配额同行锁使竞争请求只成功一份；另一企业额度保持独立',async()=>{
 const used=await rawUsage();await limits({storage_limit_bytes:used+5});const bBefore=await service(b);
 const results=await Promise.all(['ABCDE','FGHIJ'].map(v=>app.inject({method:'POST',url:'/api/attachments',headers:headers(a,true),payload:payload(v)})));
 assert.deepEqual(results.map(r=>r.statusCode).sort(),[201,409]);const rejected=results.find(r=>r.statusCode===409)!;assert.equal(rejected.json().error.code,'STORAGE_QUOTA_EXCEEDED');assert.equal(await rawUsage(),used+5);
 const bAfter=await service(b);assert.equal(bAfter.storage_used_bytes,bBefore.storage_used_bytes);assert.equal(bAfter.storage_limit_bytes,bBefore.storage_limit_bytes);
});

test('服务只读/到期阻止新增与附件修改，历史下载继续；本机管理员可以恢复服务',async()=>{
 await limits();const body=payload('history retained');const {attachment}=await upload(body);
 await limits({state:'read_only'});await upload(payload('blocked'),a,403);
 const modify=await app.inject({method:'PATCH',url:'/api/attachments/'+attachment.id,headers:headers(a,true),payload:{version:1,active:false}});assert.equal(modify.statusCode,403);assert.equal(modify.json().error.code,'SERVICE_READ_ONLY');
 const read=await app.inject({url:'/api/attachments/'+attachment.id+'/content',headers:headers(a)});assert.equal(read.statusCode,200);
 const replay=await upload(body,a,200);assert.equal(replay.replayed,true);
 await limits({expires_at:'2020-01-01T00:00:00Z'});assert.equal((await service()).effective_state,'expired');
 const expired=await app.inject({method:'POST',url:'/api/attachments',headers:headers(a,true),payload:payload('blocked expired')});assert.equal(expired.statusCode,403);assert.equal(expired.json().error.code,'SERVICE_EXPIRED');
 await limits();assert.equal((await service()).effective_state,'active');await upload(payload('restored'));
});

test('停用/软删除保留真实原字节及占用，拒绝过期状态更新和复活，数据库不可硬删/改内容',async()=>{
 await limits();const {attachment}=await upload(payload('preserve original'));const used=await rawUsage();
 const inactive=await app.inject({method:'PATCH',url:'/api/attachments/'+attachment.id,headers:headers(a,true),payload:{version:1,active:false}});assert.equal(inactive.statusCode,200);assert.equal(inactive.json().attachment.version,2);
 let content=await app.inject({url:'/api/attachments/'+attachment.id+'/content',headers:headers(a)});assert.equal(content.statusCode,410);
 const stale=await app.inject({method:'PATCH',url:'/api/attachments/'+attachment.id,headers:headers(a,true),payload:{version:1,active:true}});assert.equal(stale.statusCode,409);
 const active=await app.inject({method:'PATCH',url:'/api/attachments/'+attachment.id,headers:headers(a,true),payload:{version:2,active:true}});assert.equal(active.statusCode,200);
 const deleted=await app.inject({method:'DELETE',url:'/api/attachments/'+attachment.id,headers:headers(a,true),payload:{version:3}});assert.equal(deleted.statusCode,200);assert.equal(deleted.json().attachment.version,4);
 const revive=await app.inject({method:'PATCH',url:'/api/attachments/'+attachment.id,headers:headers(a,true),payload:{version:4,active:true}});assert.equal(revive.statusCode,410);
 assert.equal(await rawUsage(),used);
 const raw=(await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query<{payload:Uint8Array}>('SELECT payload FROM attachments WHERE id=$1',[attachment.id]))).rows[0]!;assert.deepEqual(Buffer.from(raw.payload),Buffer.from('preserve original'));
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('DELETE FROM attachments WHERE id=$1',[attachment.id])),/permission denied/i);
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('UPDATE attachments SET payload=$1 WHERE id=$2',[Buffer.from('overwrite'),attachment.id])),/permission denied/i);
 assert.equal(await audits(attachment.id),4);
 const list=await app.inject({url:`/api/attachments?resource_type=product&resource_id=${productA}&include_deleted=true`,headers:headers(a)});assert.equal(list.statusCode,200);assert.ok(list.json().items.some((x:{id:string;deleted_at:string})=>x.id===attachment.id&&x.deleted_at));
});

test('存储、字节和审计在同一事务；审计写入失败不留附件和额度占用',async()=>{
 await limits();const before=await rawUsage();const body=payload('must roll back');
 await db.admin(sql=>sql.exec("CREATE FUNCTION reject_asset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_type='attachment' THEN RAISE EXCEPTION 'injected asset audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_asset_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_asset_audit()"));
 try{await upload(body,a,500);}finally{await db.admin(sql=>sql.exec('DROP TRIGGER reject_asset_audit ON audit_events; DROP FUNCTION reject_asset_audit()'));}
 assert.equal(await rawUsage(),before);const rows=(await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('SELECT id FROM attachments WHERE request_key=$1',[body.request_key]))).rows;assert.deepEqual(rows,[]);
});

test('服务参数乐观版本和管理员限制；席位/产品门禁计数准确且禁止自己提升生产套餐',async()=>{
 await limits({seat_limit:2,product_limit:1});const current=await service();assert.equal(current.seat_used,2);assert.equal(current.product_used,1);
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>gateTenantWrite(sql,{tenantId:tenantA,userId:admin},'products')),e=>(e as {code:string}).code==='PRODUCT_QUOTA_EXCEEDED');
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>gateTenantWrite(sql,{tenantId:tenantA,userId:admin},'seats')),e=>(e as {code:string}).code==='SEAT_QUOTA_EXCEEDED');
 const stale=await app.inject({method:'PATCH',url:'/api/tenant-service',headers:headers(a,true),payload:{version:current.version-1,state:'active',expires_at:null,seat_limit:100,product_limit:1000,storage_limit_bytes:1000}});assert.equal(stale.statusCode,409);
 const forbidden=await app.inject({method:'PATCH',url:'/api/tenant-service',headers:headers(w,true),payload:{version:current.version,state:'active',expires_at:null,seat_limit:100,product_limit:1000,storage_limit_bytes:1000}});assert.equal(forbidden.statusCode,403);
 await limits();
});

test('生产模式关闭企业自行调整套餐参数，历史读取仍可用',async()=>{
 const productionApp=await createApp(db,{production:true,origin:'https://stage3.test'});
 try{
  const logged=await productionApp.inject({method:'POST',url:'/api/auth/login',payload:{tenant_slug:'assets-a',username:'assets.admin',password}});assert.equal(logged.statusCode,200,logged.body);
  const raw=logged.headers['set-cookie'];assert.ok(raw);const session={cookie:(Array.isArray(raw)?raw[0]!:raw).split(';')[0]!,csrf:logged.json().csrf_token};
  const read=await productionApp.inject({url:'/api/tenant-service',headers:headers(session)});assert.equal(read.statusCode,200);assert.equal(read.json().service.configuration_allowed,false);
  const old=read.json().service;
  const change=await productionApp.inject({method:'PATCH',url:'/api/tenant-service',headers:headers(session,true),payload:{version:old.version,state:'active',expires_at:null,seat_limit:100000,product_limit:10000000,storage_limit_bytes:1099511627776}});
  assert.equal(change.statusCode,403,change.body);assert.equal(change.json().error.code,'SERVICE_CONFIGURATION_DISABLED');
 }finally{await productionApp.close();}
});

test('附件遵守产品本人范围与最新能力权限，工序范围未接入时拒绝绕过',async()=>{
 await limits();const {attachment}=await upload(payload('scope protected'));const roleId=randomUUID();
 await db.tenant({tenantId:tenantA,userId:admin},async sql=>{
  await sql.query("INSERT INTO tenant_roles(id,tenant_id,code,name,permissions,data_scope) VALUES($1,$2,$3,$4,$5::jsonb,'self')",[roleId,tenantA,'ATTACH-SELF','附件本人测试',JSON.stringify(['master.read','attachments.read','attachments.write'])]);
  await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name,custom_role_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,user_id) DO UPDATE SET custom_role_id=$4',[tenantA,worker,'附件范围工人',roleId]);
 });
 try{
  const hidden=await app.inject({url:'/api/attachments/'+attachment.id+'/content',headers:headers(w)});assert.equal(hidden.statusCode,404,hidden.body);
  await upload(payload('scope cannot upload'),w,404);
  const hiddenList=await app.inject({url:`/api/attachments?resource_type=product&resource_id=${productA}`,headers:headers(w)});assert.equal(hiddenList.statusCode,404);
  const process=await app.inject({url:`/api/attachments?resource_type=process&resource_id=${processA}`,headers:headers(w)});assert.equal(process.statusCode,403,process.body);
  await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('UPDATE products SET created_by_id=$1 WHERE id=$2',[worker,productA]));
  const allowed=await app.inject({url:'/api/attachments/'+attachment.id+'/content',headers:headers(w)});assert.equal(allowed.statusCode,200,allowed.body);
  await upload(payload('my product upload'),w);
  await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('UPDATE tenant_roles SET permissions=$1::jsonb WHERE id=$2',[JSON.stringify(['master.read']),roleId]));
  const revoked=await app.inject({url:'/api/attachments/'+attachment.id+'/content',headers:headers(w)});assert.equal(revoked.statusCode,403,revoked.body);
 }finally{
  await db.tenant({tenantId:tenantA,userId:admin},async sql=>{
   await sql.query('UPDATE tenant_member_profiles SET custom_role_id=NULL WHERE user_id=$1',[worker]);await sql.query('UPDATE products SET created_by_id=NULL WHERE id=$1',[productA]);
  });
 }
});

