import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/passwords.js';
import { readConfig, projectRoot } from '../src/config.js';

let db:Database, app:FastifyInstance;
const tenantA=randomUUID(), tenantB=randomUUID(), unitA=randomUUID(), unitB=randomUUID();
const admin=randomUUID(), worker=randomUUID(), productA=randomUUID(), productB=randomUUID();
const password='LocalTestOnly-LongPassword!';
type Login={cookie:string;csrf:string};
let a:Login,b:Login,w:Login;
const headers=(login:Login,write=false)=>({cookie:login.cookie,...(write?{'x-csrf-token':login.csrf}:{})});
async function login(tenant:string,username='admin.test'):Promise<Login> {
  const response=await app.inject({method:'POST',url:'/api/auth/login',payload:{tenant_slug:tenant,username,password}});
  assert.equal(response.statusCode,200,response.body);
  const raw=response.headers['set-cookie'];
  const value=Array.isArray(raw)?raw[0]:raw;
  assert.ok(value?.includes('HttpOnly'));assert.ok(value.includes('SameSite=Lax'));
  return {cookie:value.split(';')[0]!,csrf:response.json().csrf_token};
}
before(async()=>{
  db=new Database({mode:'pglite'});
  await migrate(db);
  const hash=await hashPassword(password);
  await db.admin(async(sql)=>{
    for(const [id,slug] of [[tenantA,'test-a'],[tenantB,'test-b']]) await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)',[id,slug,slug]);
    for(const [id,username,name] of [[admin,'admin.test','测试管理员'],[worker,'worker.test','测试工人']]) await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)',[id,username,name,hash]);
    for(const tenant of [tenantA,tenantB]) await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant,admin,'admin']);
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenantA,worker,'worker']);
    for(const [id,tenant] of [[unitA,tenantA],[unitB,tenantB]]) await sql.query('INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,$3,$4)',[id,tenant,'EA','个']);
    for(const [id,tenant,unit] of [[productA,tenantA,unitA],[productB,tenantB,unitB]]) await sql.query('INSERT INTO products(id,tenant_id,code,name,unit_id,attribute) VALUES($1,$2,$3,$4,$5,$6)',[id,tenant,'SAME-CODE',tenant===tenantA?'企业A产品':'企业B产品',unit,'manufactured']);
  });
  app=await createApp(db);a=await login('test-a');b=await login('test-b');w=await login('test-a','worker.test');
});
after(async()=>{await app?.close();await db?.close();});

test('身份、成员关系和会话绑定，任意企业头不能切换企业',async()=>{
  const result=await app.inject({url:'/api/auth/me',headers:{...headers(a),'x-tenant-id':tenantB}});
  assert.equal(result.statusCode,200);assert.equal(result.json().tenant.id,tenantA);
  const invalid=await app.inject({method:'POST',url:'/api/auth/login',payload:{tenant_slug:'test-b',username:'worker.test',password}});
  assert.equal(invalid.statusCode,401);
});
test('匿名请求不能读取产品、单位和审计',async()=>{
  for(const url of ['/api/products','/api/units','/api/audit-events']) assert.equal((await app.inject({url})).statusCode,401);
});
test('同产品编码可存在两家企业，列表不混入另一企业',async()=>{
  const ar=(await app.inject({url:'/api/products',headers:headers(a)})).json();
  const br=(await app.inject({url:'/api/products',headers:headers(b)})).json();
  assert.equal(ar.total,1);assert.equal(br.total,1);
  assert.equal(ar.items[0].id,productA);assert.equal(br.items[0].id,productB);
});
test('数据库行级策略在缺少租户上下文时拒绝返回任何业务行',async()=>{
  await db.admin(async(sql)=>{
    await sql.exec('SET LOCAL ROLE gd_tenant');
    assert.equal((await sql.query('SELECT id FROM products')).rows.length,0);
  });
  await db.tenant({tenantId:tenantA,userId:admin},async(sql)=>{
    const rows=(await sql.query<{tenant_id:string}>('SELECT tenant_id FROM products')).rows;
    assert.ok(rows.length>0 && rows.every(row=>row.tenant_id===tenantA));
  });
});
test('数据库行级策略拒绝跨租户写入，即使SQL忘了过滤',async()=>{
  await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('INSERT INTO products(tenant_id,code,name,unit_id,attribute) VALUES($1,$2,$3,$4,$5)',[tenantB,'FORGED','越权产品',unitB,'purchased'])),/row-level security/i);
});
test('创建产品持久写入与审计一同提交，重复编码不多写审计',async()=>{
  const payload={code:'NEW-001',name:'真实写入',unit_id:unitA,attribute:'purchased'};
  const first=await app.inject({method:'POST',url:'/api/products',headers:headers(a,true),payload});
  assert.equal(first.statusCode,201,first.body);
  assert.equal((await app.inject({method:'POST',url:'/api/products',headers:headers(a,true),payload})).statusCode,409);
  const audit=(await app.inject({url:'/api/audit-events',headers:headers(a)})).json().items;
  assert.equal(audit.filter((event:{entity_id:string})=>event.entity_id===first.json().product.id).length,1);
  assert.equal(audit[0].after_data.name,'真实写入');
  assert.equal((await app.inject({url:'/api/audit-events',headers:headers(b)})).json().items.length,0);
});
test('伪造tenant_id字段、跨企业单位及缺失CSRF均拒绝',async()=>{
  const payload={code:'INVALID',name:'无效写入',unit_id:unitA,attribute:'purchased'};
  assert.equal((await app.inject({method:'POST',url:'/api/products',headers:headers(a,true),payload:{...payload,tenant_id:tenantB}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/products',headers:headers(a,true),payload:{...payload,unit_id:unitB}})).statusCode,422);
  assert.equal((await app.inject({method:'POST',url:'/api/products',headers:headers(a),payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/products',headers:{...headers(a,true),origin:'https://attacker.example'},payload})).statusCode,403);
});
test('只读工人不能改产品或读审计，概览不泄露审计计数',async()=>{
  assert.equal((await app.inject({url:'/api/products',headers:headers(w)})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/products',headers:headers(w,true),payload:{code:'WORKER',name:'工人写入',unit_id:unitA,attribute:'manufactured'}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/audit-events',headers:headers(w)})).statusCode,403);
  assert.equal((await app.inject({url:'/api/overview',headers:headers(w)})).json().audit_events,null);
});
test('另一企业产品ID无法修改；并发同版本只能成功一次',async()=>{
  const payload={version:1,name:'修改后',specification:'',unit_id:unitA,attribute:'manufactured',active:true};
  assert.equal((await app.inject({method:'PATCH',url:'/api/products/'+productB,headers:headers(a,true),payload})).statusCode,404);
  const results=await Promise.all([1,2].map(()=>app.inject({method:'PATCH',url:'/api/products/'+productA,headers:headers(a,true),payload})));
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
  const events=(await app.inject({url:'/api/audit-events',headers:headers(a)})).json().items.filter((e:{entity_id:string;action:string})=>e.entity_id===productA && e.action==='product.updated');
  assert.equal(events.length,1);assert.equal(events[0].before_data.version,1);assert.equal(events[0].after_data.version,2);
});
test('审计失败时产品新增一并回滚，不能半提交',async()=>{
  await db.admin(sql=>sql.exec("CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$; CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_test_audit()"));
  try {
    const result=await app.inject({method:'POST',url:'/api/products',headers:headers(a,true),payload:{code:'ROLLBACK-TEST',name:'必须回滚',unit_id:unitA,attribute:'manufactured'}});
    assert.equal(result.statusCode,500);
    const list=(await app.inject({url:'/api/products?q=ROLLBACK-TEST',headers:headers(a)})).json();
    assert.equal(list.total,0);
  }finally{await db.admin(sql=>sql.exec('DROP TRIGGER reject_test_audit ON audit_events; DROP FUNCTION reject_test_audit()'));}
});
test('成员停用立即失效，不依赖前端隐藏菜单',async()=>{
  await db.admin(sql=>sql.query('UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2',[tenantA,worker]));
  assert.equal((await app.inject({url:'/api/products',headers:headers(w)})).statusCode,401);
  await db.admin(sql=>sql.query('UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2',[tenantA,worker]));
});
test('退出登录使旧cookie失效',async()=>{
  const result=await app.inject({method:'POST',url:'/api/auth/logout',headers:headers(b,true)});
  assert.equal(result.statusCode,200);
  assert.equal((await app.inject({url:'/api/products',headers:headers(b)})).statusCode,401);
});
test('登录入口限流，错误报文不返回数据库细节',async()=>{
  for(let index=0;index<10;index++) await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.77',payload:{}});
  const response=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.77',payload:{}});
  assert.equal(response.statusCode,429);assert.equal(response.json().error.code,'RATE_LIMITED');
});
test('密码仅强哈希，格式损坏不接受；生产模式拒绝嵌入库',async()=>{
  const encoded=await hashPassword(password);
  assert.ok(!encoded.includes(password));
  assert.equal(await verifyPassword(password,encoded),true);
  assert.equal(await verifyPassword('wrong-password',encoded),false);
  assert.equal(await verifyPassword(password,'corrupted'),false);
  assert.throws(()=>new Database({mode:'pglite',production:true}),/生产/);
  assert.throws(()=>readConfig({NODE_ENV:'production',DB_MODE:'pglite'}),/生产/);
  assert.equal(resolve(projectRoot),resolve(process.cwd(),'../..'));
});
test('文件数据库重启后保留记录和迁移版本',async()=>{
  const testRoot=resolve(projectRoot,'.local/persistence-tests');
  await mkdir(testRoot,{recursive:true});
  const path=await mkdtemp(resolve(testRoot,'db-'));
  let persistent=new Database({mode:'pglite',dataDir:path});
  await migrate(persistent);
  const id=randomUUID();
  await persistent.admin(sql=>sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)',[id,'persist-test','持久化验收']));
  await persistent.close();
  persistent=new Database({mode:'pglite',dataDir:path});
  try{
    await migrate(persistent);
    const rows=await persistent.admin(sql=>sql.query('SELECT id FROM tenants WHERE id=$1',[id]));
    assert.equal(rows.rows.length,1);
    const migrations=await persistent.admin(sql=>sql.query('SELECT name FROM schema_migrations'));
    const migrationFiles=readdirSync(resolve(projectRoot,'apps/api/migrations')).filter((name)=>name.endsWith('.sql'));
    assert.equal(migrations.rows.length,migrationFiles.length);
  }finally{await persistent.close();}
});


test('不安全业务角色或放宽RLS的配置会阻止启动',async()=>{
  await db.admin(sql=>sql.exec('ALTER ROLE gd_tenant BYPASSRLS'));
  try { await assert.rejects(db.assertSecurityConfiguration(),/安全角色/); }
  finally { await db.admin(sql=>sql.exec('ALTER ROLE gd_tenant NOBYPASSRLS')); }
  await db.admin(sql=>sql.exec('ALTER TABLE products NO FORCE ROW LEVEL SECURITY'));
  try { await assert.rejects(db.assertSecurityConfiguration(),/强制RLS/); }
  finally { await db.admin(sql=>sql.exec('ALTER TABLE products FORCE ROW LEVEL SECURITY')); }
  await db.admin(sql=>sql.exec('ALTER POLICY products_tenant ON products USING (true) WITH CHECK (true)'));
  try { await assert.rejects(db.assertSecurityConfiguration(),/策略/); }
  finally { await db.admin(sql=>sql.exec("ALTER POLICY products_tenant ON products USING (tenant_id::text = nullif(current_setting('app.tenant_id',true),'')) WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id',true),''))")); }
  await db.assertSecurityConfiguration();
});
test('受信代理区分真实客户端，非受信地址不能伪造XFF绕过限流',async()=>{
  const proxied=await createApp(db,{trustedProxy:['127.0.0.1']});
  try {
    for(let index=0;index<10;index++) await proxied.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.1',headers:{'x-forwarded-for':'198.51.100.1'},payload:{}});
    const other=await proxied.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.1',headers:{'x-forwarded-for':'198.51.100.2'},payload:{tenant_slug:'test-a',username:'admin.test',password}});
    assert.equal(other.statusCode,200,other.body);
    for(let index=0;index<10;index++) await proxied.inject({method:'POST',url:'/api/auth/login',remoteAddress:'192.0.2.55',headers:{'x-forwarded-for':'198.51.100.3'},payload:{}});
    const spoofed=await proxied.inject({method:'POST',url:'/api/auth/login',remoteAddress:'192.0.2.55',headers:{'x-forwarded-for':'198.51.100.4'},payload:{}});
    assert.equal(spoofed.statusCode,429);
  }finally{await proxied.close();}
});
test('格式损坏JSON返回400而不误报服务器故障',async()=>{
  const response=await app.inject({method:'POST',url:'/api/auth/login',headers:{'content-type':'application/json'},payload:'{broken'});
  assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'INVALID_REQUEST');
});



test('成员视图必须过滤当前企业与启用身份，不能开放全局身份表读取',async()=>{
  await db.admin(sql=>sql.exec('ALTER VIEW tenant_team_members SET (security_barrier=false)'));
  try{await assert.rejects(db.assertSecurityConfiguration(),/成员视图/);}
  finally{await db.admin(sql=>sql.exec('ALTER VIEW tenant_team_members SET (security_barrier=true)'));}
  await db.admin(sql=>sql.exec('GRANT SELECT ON users TO gd_tenant'));
  try{await assert.rejects(db.assertSecurityConfiguration(),/全局身份/);}
  finally{await db.admin(sql=>sql.exec('REVOKE SELECT ON users FROM gd_tenant'));}
  const definition=await db.admin(async sql=>(await sql.query<{definition:string}>("SELECT pg_get_viewdef('tenant_team_members'::regclass,true) AS definition")).rows[0]!.definition);
  await db.admin(sql=>sql.exec('CREATE OR REPLACE VIEW tenant_team_members WITH (security_barrier=true) AS SELECT u.id,u.display_name,m.role FROM memberships m JOIN users u ON u.id=m.user_id'));
  try{await assert.rejects(db.assertSecurityConfiguration(),/成员视图/);}
  finally{await db.admin(sql=>sql.exec('CREATE OR REPLACE VIEW tenant_team_members WITH (security_barrier=true) AS '+definition));}
  await db.assertSecurityConfiguration();
});


test('封存触发器必须保持启用与延迟完整版本提交检查',async()=>{
  await db.admin(sql=>sql.exec('ALTER TABLE bom_items DISABLE TRIGGER bom_items_no_append'));
  try{await assert.rejects(db.assertSecurityConfiguration(),/封存触发器/);}
  finally{await db.admin(sql=>sql.exec('ALTER TABLE bom_items ENABLE TRIGGER bom_items_no_append'));}
  await db.assertSecurityConfiguration();
});


