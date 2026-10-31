import type {FastifyInstance} from 'fastify';
import type {Sql} from './database.js';
import {Problem,writeAudit,requireAllScope,permissionCatalog,type Services,type Actor,type Role} from './services.js';
import {hashPassword} from './passwords.js';
import {gateTenantWrite} from './assets.js';
const uuid={type:'string',format:'uuid'};
const nullableId={anyOf:[uuid,{type:'null'}]};
const text=(max:number)=>({type:'string',minLength:1,maxLength:max,pattern:'^\\S(?:.*\\S)?$'});
const object=(required:string[],properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required,properties});
const params=object(['id'],{id:uuid});
const version={type:'integer',minimum:1};
const scopes={type:'string',enum:['all','department','self']};
const permissions={type:'array',maxItems:permissionCatalog.length,uniqueItems:true,items:{type:'string',enum:permissionCatalog.map(p=>p[0])}};
const ctx=(a:Actor)=>({tenantId:a.tenant_id,userId:a.user_id});
const toTenant=(sql:Sql)=>sql.exec('SET LOCAL ROLE gd_tenant');
const toIdentity=(sql:Sql)=>sql.exec('SET LOCAL ROLE gd_platform');
async function department(sql:Sql,id:string|null|undefined){if(id&&!(await sql.query('SELECT id FROM departments WHERE id=$1 AND active',[id])).rows[0])throw new Problem(422,'INVALID_REFERENCE','部门不存在、不属于本企业或已停用');}
async function customRole(sql:Sql,id:string|null|undefined,role:Role){if(role==='admin'&&id)throw new Problem(422,'ADMIN_ROLE_FIXED','管理员采用固定全企业管理权限，自定义角色请绑定计划员或员工');if(id&&!(await sql.query('SELECT id FROM tenant_roles WHERE id=$1 AND active',[id])).rows[0])throw new Problem(422,'INVALID_REFERENCE','角色不存在、不属于本企业或已停用');}
const businessPermissions=['sales.read','sales.write','sales.approve','production.read','production.write','production.approve','production.report','inventory.read','inventory.write','inventory.approve','quality.read','quality.write','procurement.read','procurement.write','procurement.approve','planning.read','planning.write','payroll.read','payroll.manage','payroll.approve','finance.read','finance.write','finance.approve'];
function roleScope(body:{permissions:string[];data_scope:string}){for(const [permission,needs] of [['master.write',['master.read','configuration.read']],['attachments.read',['master.read']],['attachments.write',['attachments.read','master.read']],['configuration.manage',['configuration.read']],['sales.write',['sales.read']],['sales.approve',['sales.read']],['production.write',['production.read']],['production.approve',['production.read']],['production.report',['production.read']],['inventory.write',['inventory.read']],['inventory.approve',['inventory.read']],['quality.write',['quality.read']],['procurement.write',['procurement.read']],['procurement.approve',['procurement.read']],['planning.write',['planning.read']],['payroll.manage',['payroll.read']],['payroll.approve',['payroll.read']],['finance.write',['finance.read']],['finance.approve',['finance.read']]] as const){if(body.permissions.includes(permission)&&needs.some(p=>!body.permissions.includes(p)))throw new Problem(422,'PERMISSION_DEPENDENCY','维护能力必须同时授予所需读取权限');}if(body.data_scope!=='all'&&body.permissions.some(p=>['master.write','audit.read','organization.manage','configuration.manage','tenant_service.manage',...businessPermissions].includes(p)))throw new Problem(422,'SCOPE_PERMISSION_MISMATCH','部门或本人范围目前支持产品读取和附件；销售、生产、库存和检验仍要求全企业范围');}
export function registerPlatform(app:FastifyInstance,s:Services,options:{allowTenantCreation?:boolean}={}){
 const {database:db,context,actor,requirePermission,authorize}=s;
 const manage=requirePermission('organization.manage');
 app.get('/api/platform/permissions',{preHandler:manage},async r=>{requireAllScope(actor(r));return {items:permissionCatalog.map(([key,name])=>({key,name}))};});
 for(const spec of [{url:'departments',table:'departments',key:'department',parent:'parent_id',parentTable:'departments',optional:true},{url:'workshops',table:'workshops',key:'workshop',parent:'department_id',parentTable:'departments',optional:false},{url:'lines',table:'production_lines',key:'line',parent:'workshop_id',parentTable:'workshops',optional:false}] as const){
  const parentProperty=spec.optional?nullableId:uuid;
  const properties={code:text(64),name:text(100),[spec.parent]:parentProperty};
  app.get('/api/platform/'+spec.url,{preHandler:manage},r=>db.tenant(context(r),async sql=>{requireAllScope(actor(r));return {items:(await sql.query(`SELECT id,code,name,${spec.parent},active,version,created_at,updated_at FROM ${spec.table} ORDER BY code LIMIT 1000`)).rows};}));
  const save=async(sql:Sql,a:Actor,id:string|undefined,b:Record<string,unknown>)=>{
   requireAllScope(a);await gateTenantWrite(sql,ctx(a));
   const before=id?(await sql.query(`SELECT * FROM ${spec.table} WHERE id=$1 FOR UPDATE`,[id])).rows[0]:null;
   if(id&&!before)throw new Problem(404,'ORGANIZATION_NOT_FOUND','组织资料不存在');
   if(id&&before!.version!==b.version)throw new Problem(409,'VERSION_CONFLICT','组织资料已被修改，请刷新');
   const parent=b[spec.parent]??null;
   if(parent){if(parent===id)throw new Problem(422,'DEPARTMENT_CYCLE','部门不能隶属于自己');const valid=(await sql.query(`SELECT id FROM ${spec.parentTable} WHERE id=$1 AND active FOR UPDATE`,[parent])).rows[0];if(!valid)throw new Problem(422,'INVALID_REFERENCE','上级组织不存在、不属于本企业或已停用');}
   if(spec.optional&&id&&parent){const cycle=(await sql.query('WITH RECURSIVE chain AS (SELECT id,parent_id FROM departments WHERE id=$1 UNION SELECT d.id,d.parent_id FROM departments d JOIN chain c ON d.id=c.parent_id) SELECT id FROM chain WHERE id=$2',[parent,id])).rows[0];if(cycle)throw new Problem(422,'DEPARTMENT_CYCLE','部门层级存在循环');}
   if(id&&b.active===false){
    let used=false;
    if(spec.table==='departments')used=!!(await sql.query('SELECT id FROM departments WHERE parent_id=$1 AND active UNION ALL SELECT id FROM workshops WHERE department_id=$1 AND active UNION ALL SELECT user_id AS id FROM tenant_member_profiles WHERE department_id=$1 LIMIT 1',[id])).rows[0];
    if(spec.table==='workshops')used=!!(await sql.query('SELECT id FROM production_lines WHERE workshop_id=$1 AND active LIMIT 1',[id])).rows[0];
    if(used)throw new Problem(409,'ORGANIZATION_IN_USE','组织仍有启用子组织或关联人员，请先调整');
   }
   const row=id?(await sql.query(`UPDATE ${spec.table} SET name=$1,${spec.parent}=$2,active=$3,version=version+1,updated_at=now() WHERE id=$4 RETURNING *`,[b.name,parent,b.active,id])).rows[0]:(await sql.query(`INSERT INTO ${spec.table}(tenant_id,code,name,${spec.parent}) VALUES($1,$2,$3,$4) RETURNING *`,[a.tenant_id,b.code,b.name,parent])).rows[0];
   await writeAudit(sql,a,spec.key+(id?'.updated':'.created'),spec.key,String(row!.id),before,row);return {[spec.key]:row};
  };
  app.post('/api/platform/'+spec.url,{preHandler:manage,schema:{body:object(spec.optional?['code','name']:['code','name',spec.parent],properties)}},async(r,reply)=>reply.code(201).send(await db.tenant(context(r),sql=>save(sql,actor(r),undefined,r.body as Record<string,unknown>))));
  app.patch<{Params:{id:string}}>('/api/platform/'+spec.url+'/:id',{preHandler:manage,schema:{params,body:object(['version','name','active',...(spec.optional?[]:[spec.parent])],{version,name:text(100),active:{type:'boolean'},[spec.parent]:parentProperty})}},r=>db.tenant(context(r),sql=>save(sql,actor(r),r.params.id,r.body as Record<string,unknown>)));
 }
 app.get('/api/platform/roles',{preHandler:manage},r=>db.tenant(context(r),async sql=>{requireAllScope(actor(r));return {items:(await sql.query('SELECT id,code,name,permissions,data_scope,active,version FROM tenant_roles ORDER BY code')).rows};}));
 type RoleBody={code:string;name:string;permissions:string[];data_scope:string};
 app.post<{Body:RoleBody}>('/api/platform/roles',{preHandler:manage,schema:{body:object(['code','name','permissions','data_scope'],{code:text(64),name:text(100),permissions,data_scope:scopes})}},async(r,reply)=>reply.code(201).send(await db.tenant(context(r),async sql=>{
  const a=actor(r);requireAllScope(a);await gateTenantWrite(sql,context(r));roleScope(r.body);const b=r.body;
  const role=(await sql.query('INSERT INTO tenant_roles(tenant_id,code,name,permissions,data_scope) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *',[a.tenant_id,b.code,b.name,JSON.stringify(b.permissions),b.data_scope])).rows[0]!;await writeAudit(sql,a,'role.created','role',String(role.id),null,role);return {role};
 })));
 app.patch<{Params:{id:string};Body:Omit<RoleBody,'code'>&{version:number;active:boolean}}>('/api/platform/roles/:id',{preHandler:manage,schema:{params,body:object(['version','name','permissions','data_scope','active'],{version,name:text(100),permissions,data_scope:scopes,active:{type:'boolean'}})}},r=>db.tenant(context(r),async sql=>{
  const a=actor(r);requireAllScope(a);await gateTenantWrite(sql,context(r));roleScope(r.body);const before=(await sql.query('SELECT * FROM tenant_roles WHERE id=$1 FOR UPDATE',[r.params.id])).rows[0];if(!before)throw new Problem(404,'ROLE_NOT_FOUND','角色不存在');
  const b=r.body;const role=(await sql.query('UPDATE tenant_roles SET name=$1,permissions=$2::jsonb,data_scope=$3,active=$4,version=version+1,updated_at=now() WHERE id=$5 AND version=$6 RETURNING *',[b.name,JSON.stringify(b.permissions),b.data_scope,b.active,r.params.id,b.version])).rows[0];if(!role)throw new Problem(409,'VERSION_CONFLICT','角色已被修改，请刷新');await writeAudit(sql,a,'role.updated','role',r.params.id,before,role);return {role};
 }));
 const getMembers=async(sql:Sql)=>{
  await toTenant(sql);const profiles=(await sql.query('SELECT * FROM tenant_member_profiles')).rows;const map=new Map(profiles.map(p=>[p.user_id,p]));await toIdentity(sql);
  return (await sql.query<{id:string;username:string;display_name:string;role:Role;active:boolean}>('SELECT u.id,u.username,u.display_name,m.role,m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id::text=current_setting(\'app.tenant_id\',true) ORDER BY u.username')).rows.map(u=>{const p=map.get(u.id);return {...u,display_name:p?.display_name??u.display_name,department_id:p?.department_id??null,custom_role_id:p?.custom_role_id??null,version:p?.version??1};});
 };
 app.get('/api/platform/members',{preHandler:manage},r=>db.identity(context(r),async sql=>{requireAllScope(actor(r));return {items:await getMembers(sql)};}));
 type MemberBody={username:string;display_name:string;password:string;role:Role;department_id?:string|null;custom_role_id?:string|null};
 const memberProps={display_name:text(100),role:{type:'string',enum:['admin','planner','worker']},department_id:nullableId,custom_role_id:nullableId};
 app.post<{Body:MemberBody}>('/api/platform/members',{preHandler:manage,schema:{body:object(['username','display_name','password','role'],{username:{type:'string',minLength:3,maxLength:80,pattern:'^[a-zA-Z0-9_.@-]+$'},password:{type:'string',minLength:12,maxLength:128},...memberProps})}},async(r,reply)=>{
  const password=await hashPassword(r.body.password);
  const member=await db.identity(context(r),async sql=>{
   const a=actor(r);requireAllScope(a);const b=r.body;await toTenant(sql);await gateTenantWrite(sql,context(r),'seats');await department(sql,b.department_id);await customRole(sql,b.custom_role_id,b.role);await toIdentity(sql);
   const u=(await sql.query<{id:string}>('INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) RETURNING id',[b.username,b.display_name,password])).rows[0]!;
   await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[a.tenant_id,u.id,b.role]);await toTenant(sql);
   await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name,department_id,custom_role_id) VALUES($1,$2,$3,$4,$5)',[a.tenant_id,u.id,b.display_name,b.department_id??null,b.custom_role_id??null]);
   const result={id:u.id,username:b.username,display_name:b.display_name,role:b.role,department_id:b.department_id??null,custom_role_id:b.custom_role_id??null,active:true,version:1};await writeAudit(sql,a,'member.created','member',u.id,null,result);return result;
  });return reply.code(201).send({member});
 });
 app.patch<{Params:{id:string};Body:{version:number;display_name:string;role:Role;active:boolean;department_id:string|null;custom_role_id:string|null}}>('/api/platform/members/:id',{preHandler:manage,schema:{params,body:object(['version','display_name','role','active','department_id','custom_role_id'],{version,...memberProps,active:{type:'boolean'}})}},r=>db.identity(context(r),async sql=>{
  const a=actor(r);requireAllScope(a);const b=r.body;await toTenant(sql);await gateTenantWrite(sql,context(r));await department(sql,b.department_id);await customRole(sql,b.custom_role_id,b.role);
  const all=await getMembers(sql);const before=all.find(m=>m.id===r.params.id);if(!before)throw new Problem(404,'MEMBER_NOT_FOUND','成员不存在');if(before.version!==b.version)throw new Problem(409,'VERSION_CONFLICT','成员已被修改，请刷新');
  if(a.user_id===before.id&&(!b.active||b.role!==before.role||b.custom_role_id!==before.custom_role_id))throw new Problem(409,'SELF_ADMIN_PROTECTION','不能停用或降权当前管理员，请由另一名管理员操作');
  if(before.active&&before.role==='admin'&&!before.custom_role_id&&(!b.active||b.role!=='admin'||b.custom_role_id)&&all.filter(m=>m.active&&m.role==='admin'&&!m.custom_role_id).length<=1)throw new Problem(409,'LAST_ADMIN','至少保留一名启用管理员');
  if(!before.active&&b.active){await toTenant(sql);await gateTenantWrite(sql,context(r),'seats');await toIdentity(sql);}
  await sql.query('UPDATE memberships SET role=$1,active=$2 WHERE user_id=$3 AND tenant_id=$4',[b.role,b.active,before.id,a.tenant_id]);
  if(!b.active||before.role!==b.role||before.custom_role_id!==b.custom_role_id){await sql.exec('SET LOCAL ROLE gd_auth');await sql.query('DELETE FROM sessions WHERE user_id=$1 AND tenant_id=$2',[before.id,a.tenant_id]);}
  await toTenant(sql);const member=(await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name,department_id,custom_role_id,version) VALUES($1,$2,$3,$4,$5,2) ON CONFLICT(tenant_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,department_id=EXCLUDED.department_id,custom_role_id=EXCLUDED.custom_role_id,version=tenant_member_profiles.version+1,updated_at=now() RETURNING *',[a.tenant_id,before.id,b.display_name,b.department_id,b.custom_role_id])).rows[0]!;
  const result={id:before.id,username:before.username,display_name:member.display_name,department_id:member.department_id,custom_role_id:member.custom_role_id,role:b.role,active:b.active,version:member.version};await writeAudit(sql,a,'member.updated','member',before.id,before,result);return {member:result};
 }));
 app.get('/api/platform/tenants',{preHandler:authorize()},r=>db.auth(async sql=>({items:(await sql.query('SELECT t.id,t.slug,t.name,m.role,t.id=$2 AS current FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.active AND t.active ORDER BY t.slug',[actor(r).user_id,actor(r).tenant_id])).rows,creation_enabled:!!options.allowTenantCreation,onboarding_allowed:!!options.allowTenantCreation})));
 app.post<{Body:{slug:string;name:string;request_key:string}}>('/api/platform/tenants',{preHandler:manage,schema:{body:object(['slug','name','request_key'],{slug:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{1,62}$'},name:text(100),request_key:{type:'string',minLength:8,maxLength:100,pattern:'^[a-zA-Z0-9_.-]+$'}})}},async(r,reply)=>{
  if(!options.allowTenantCreation)throw new Problem(403,'PLATFORM_ENROLLMENT_REQUIRED','生产企业开通需独立平台运营授权；当前接口仅本机演练');
  const result=await db.identity(context(r),async sql=>{
   const a=actor(r);requireAllScope(a);const b=r.body;await toTenant(sql);await gateTenantWrite(sql,context(r));
   const prior=(await sql.query<{new_tenant_id:string;slug:string;name:string}>('SELECT new_tenant_id,slug,name FROM tenant_onboard_requests WHERE request_key=$1',[b.request_key])).rows[0];
   if(prior){if(prior.slug!==b.slug||prior.name!==b.name)throw new Problem(409,'REQUEST_KEY_CONFLICT','同一请求标识不能用于不同企业');return {tenant:{id:prior.new_tenant_id,slug:prior.slug,name:prior.name},replayed:true};}
   await toIdentity(sql);const tenant=(await sql.query<{id:string;slug:string;name:string}>('INSERT INTO tenants(slug,name) VALUES($1,$2) RETURNING id,slug,name',[b.slug,b.name])).rows[0]!;
   await sql.query("SELECT set_config('app.tenant_id',$1,true)",[tenant.id]);await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tenant.id,a.user_id]);await toTenant(sql);
   await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name) VALUES($1,$2,$3)',[tenant.id,a.user_id,a.display_name]);await gateTenantWrite(sql,{tenantId:tenant.id,userId:a.user_id});
   await sql.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenant_id]);await sql.query('INSERT INTO tenant_onboard_requests(tenant_id,request_key,new_tenant_id,slug,name,created_by_id) VALUES($1,$2,$3,$4,$5,$6)',[a.tenant_id,b.request_key,tenant.id,b.slug,b.name,a.user_id]);await writeAudit(sql,a,'tenant.created','tenant',tenant.id,null,tenant);return {tenant,replayed:false};
  });return reply.code(result.replayed?200:201).send(result);
 });
}
