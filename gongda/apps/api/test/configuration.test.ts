import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {Database} from '../src/database.js';
import {migrate} from '../src/migrations.js';
import {createApp} from '../src/app.js';
import {hashPassword} from '../src/passwords.js';
import {evaluateFormula} from '../src/formula.js';
let db:Database,app:FastifyInstance;
const tenantA=randomUUID(),tenantB=randomUUID(),admin=randomUUID(),planner=randomUUID(),worker=randomUUID(),foreign=randomUUID(),unit=randomUUID();
const password='Configuration-TestOnly-LongPassword!';
type Session={cookie:string;csrf:string};let a:Session,b:Session,p:Session,w:Session;
const headers=(session:Session,write=false)=>({cookie:session.cookie,...(write?{'x-csrf-token':session.csrf}:{})});
async function login(slug:string,username='config.admin'):Promise<Session>{const response=await app.inject({method:'POST',url:'/api/auth/login',payload:{tenant_slug:slug,username,password}});assert.equal(response.statusCode,200,response.body);const raw=response.headers['set-cookie'];return {cookie:(Array.isArray(raw)?raw[0]:raw)!.split(';')[0]!,csrf:response.json().csrf_token};}
async function request(method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:unknown,session=a,status=method==='POST'?201:200){const response=await app.inject({method,url,headers:headers(session,method!=='GET'),...(payload!==undefined?{payload}:{})});assert.equal(response.statusCode,status,response.body);return response.json();}
const get=(url:string,session=a,status=200)=>request('GET',url,undefined,session,status);
const post=(url:string,payload:unknown,session=a,status=201)=>request('POST',url,payload,session,status);
const makeProduct=(extra:Record<string,unknown>={},session=a,status=201)=>post('/api/products',{code:'PC-'+randomUUID().slice(0,8),name:'配置产品-'+randomUUID().slice(0,8),unit_id:unit,attribute:'purchased',...extra},session,status);
async function patchProduct(product:any,extra:Record<string,unknown>={},session=a,status=200){return request('PATCH','/api/products/'+product.id,{version:product.version,name:product.name,specification:product.specification,unit_id:product.unit_id,attribute:product.attribute,active:product.active,...extra},session,status);}
async function createRule(entity='product',extra:Record<string,unknown>={}){return (await post('/api/configuration/number-rules',{entity,prefix:'CF-',date_pattern:'none',reset_period:'never',padding:4,start:1,...extra})).rule;}
async function count(sqlText:string){return db.tenant({tenantId:tenantA,userId:admin},async sql=>(await sql.query<{count:string}>(sqlText)).rows[0]!.count);}
async function rejectAudit(work:()=>Promise<void>){await db.admin(sql=>sql.exec("CREATE FUNCTION reject_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$; CREATE TRIGGER reject_config_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_config_audit()"));try{await work();}finally{await db.admin(sql=>sql.exec('DROP TRIGGER reject_config_audit ON audit_events; DROP FUNCTION reject_config_audit()'));}}
let fieldSchema:any,fieldVersion:any,configuredProduct:any;
const fields=[
 {key:'batch',label:'批号',type:'text',required:true},
 {key:'length',label:'长度',type:'number',required:true},
 {key:'price',label:'单价',type:'number',required:true},
 {key:'material',label:'材质',type:'select',required:true,options:['钢','铝']},
 {key:'delivery',label:'交期',type:'date',required:false},
 {key:'approved',label:'已确认',type:'boolean',required:true},
 {key:'amount',label:'试算金额',type:'formula',required:true,expression:'length * price',variables:[{name:'length',unit:'米'},{name:'price',unit:'元/米'}]},
 {key:'secret',label:'管理员内部编号',type:'text',required:false,read_roles:['admin'],write_roles:['admin']},
];
const valueInput=(version=fieldVersion.id,extra:Record<string,unknown>={})=>({schema_version_id:version,values:{batch:'B20261004',length:'0.1',price:'0.2',material:'钢',approved:false,delivery:'2026-10-04',...extra}});
before(async()=>{
 db=new Database({mode:'pglite'});await migrate(db);const hash=await hashPassword(password);
 await db.admin(async sql=>{
  for(const [id,slug] of [[tenantA,'config-a'],[tenantB,'config-b']])await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)',[id,slug,slug]);
  for(const [id,name] of [[admin,'config.admin'],[planner,'config.planner'],[worker,'config.worker'],[foreign,'config.foreign']])await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)',[id,name,name,hash]);
  for(const tenant of [tenantA,tenantB])await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant,admin,'admin']);
  for(const [id,role] of [[planner,'planner'],[worker,'worker']])await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenantA,id,role]);
  await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenantB,foreign,'worker']);
  await sql.query('INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,$3,$4)',[unit,tenantA,'EA','个']);
 });app=await createApp(db);a=await login('config-a');b=await login('config-b');p=await login('config-a','config.planner');w=await login('config-a','config.worker');
});
after(async()=>{await app?.close();await db?.close();});

test('编号规则限制周期防重、企业唯一、版本冲突及仅授权成员取号',async()=>{
 await post('/api/configuration/number-rules',{entity:'product',prefix:'CF',date_pattern:'none',reset_period:'day',padding:4,start:1},a,422);
 await post('/api/configuration/number-rules',{entity:'product',prefix:'CF',date_pattern:'none',reset_period:'never',padding:2,start:100},a,422);
 const rule=await createRule();await createRule('unit',{prefix:'UN-',date_pattern:'yyyyMM',reset_period:'month'});
 await post('/api/configuration/number-rules',{entity:'product',prefix:'A',date_pattern:'none',reset_period:'never',padding:4,start:1},p,403);
 const first=await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'stable-request'},p);assert.equal(first.allocation.number,'CF-0001');assert.equal(first.allocation.sequence,'1');
 const replay=await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'stable-request'},p,200);assert.equal(replay.replayed,true);assert.equal(replay.allocation.id,first.allocation.id);
 await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'worker-request'},w,403);
 await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'foreign-request'},b,404);
 const updated=await request('PATCH','/api/configuration/number-rules/'+rule.id,{version:1,prefix:'C2-',date_pattern:'none',reset_period:'never',padding:4,start:1,active:false});assert.equal(updated.rule.version,2);
 await request('PATCH','/api/configuration/number-rules/'+rule.id,{version:1,prefix:'OLD-',date_pattern:'none',reset_period:'never',padding:4,start:1,active:true},a,409);
 await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'new-request'},a,422);
 const original=await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'stable-request'},a,200);assert.equal(original.allocation.number,'CF-0001');
});

test('事务取号同时请求不重号、不重复消费幂等请求；审计失败回滚流水',async()=>{
 const rule=await createRule('process',{prefix:'GX-'});
 const result=await Promise.all(Array.from({length:5},(_,i)=>post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'parallel-'+i})));assert.equal(new Set(result.map(r=>r.allocation.number)).size,5);
 const same=await Promise.all(Array.from({length:3},()=>app.inject({method:'POST',url:'/api/configuration/number-rules/'+rule.id+'/allocate',headers:headers(a,true),payload:{request_key:'same-request'}})));assert.equal(same.filter(r=>r.statusCode===201).length,1);assert.equal(new Set(same.map(r=>r.json().allocation.id)).size,1);
 await rejectAudit(async()=>{await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'rollback-request'},a,500);});
 const after=await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'rollback-request'});assert.equal(after.allocation.sequence,'7');
});

test('编号避免已有资料编码，流水耗尽不会消耗已失败请求',async()=>{
 const rule=await createRule('route',{prefix:'RT-',padding:1,start:9});const first=await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'last-value'});assert.equal(first.allocation.number,'RT-9');
 await post('/api/configuration/number-rules/'+rule.id+'/allocate',{request_key:'exhausted-request'},a,422);
 const productRule=(await get('/api/configuration/number-rules')).items.find((r:any)=>r.entity==='product');
 await makeProduct({code:'CF-0002'});await request('PATCH','/api/configuration/number-rules/'+productRule.id,{version:productRule.version,prefix:'CF-',date_pattern:'none',reset_period:'never',padding:4,start:1,active:true});
 await post('/api/configuration/number-rules/'+productRule.id+'/allocate',{request_key:'collision-request'},a,409);
 const counters=await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query<{next:string}>("SELECT next_value::text AS next FROM numbering_counters WHERE rule_id=$1 AND period='all'",[productRule.id]));assert.equal(counters.rows[0]!.next,'2');
});

test('六类扩展字段草稿不生效；发布版本强校验并保存十进制公式解释',async()=>{
 const created=await post('/api/configuration/field-schemas',{entity:'product',fields});fieldSchema=created.schema;fieldVersion=created.version;
 assert.equal(fieldSchema.current_version_id,null);assert.equal(fieldVersion.state,'draft');
 assert.equal((await get('/api/configuration/field-schemas/current?entity=product')).version,null);
 await get('/api/configuration/field-versions/'+fieldVersion.id,a,404);
 await makeProduct({extension:valueInput()},a,422);
 const published=await post('/api/configuration/field-schemas/'+fieldSchema.id+'/publish',{expected_version:fieldSchema.version,version_id:fieldVersion.id},a,200);fieldSchema=published.schema;
 const current=await get('/api/configuration/field-schemas/current?entity=product');assert.equal(current.version.state,'published');assert.equal(current.version.id,fieldVersion.id);
 const saved=await makeProduct({extension:valueInput(fieldVersion.id,{secret:'Private-7a29'})});configuredProduct=saved.product;
 assert.equal(configuredProduct.extension.values.length,'0.100000');assert.equal(configuredProduct.extension.values.price,'0.200000');assert.equal(configuredProduct.extension.values.amount,'0.020000');assert.equal(configuredProduct.extension.values.approved,false);
 const history=await get('/api/configuration/product-fields/'+configuredProduct.id);assert.equal(history.items[0].calculation_details.amount.engine_version,'decimal-rational-v1');assert.deepEqual(history.items[0].calculation_details.amount.exact_result,{numerator:'1',denominator:'50'});
 const workerFields=await get('/api/configuration/field-schemas/current',w);assert.ok(!workerFields.version.fields.some((f:any)=>f.key==='secret'));
 const workerProduct=(await get('/api/products?page_size=100',w)).items.find((item:any)=>item.id===configuredProduct.id);assert.equal(workerProduct.extension.values.secret,undefined);
 const workerHistory=await get('/api/configuration/product-fields/'+configuredProduct.id,w);assert.equal(workerHistory.items[0].values.secret,undefined);assert.ok(!JSON.stringify(workerHistory).includes('Private-7a29'));
});

test('必填、数据类型、日历日期、未知字段与手填公式失败均回滚产品和审计',async()=>{
 const beforeProducts=await count('SELECT count(*)::text AS count FROM products'),beforeValues=await count('SELECT count(*)::text AS count FROM product_field_values'),beforeAudits=await count('SELECT count(*)::text AS count FROM audit_events');
 await makeProduct({},a,422);
 for(const values of [{length:0.1},{material:'铜'},{delivery:'2026-02-30'},{approved:'false'},{amount:'999'},{unknown:'x'},{batch:''}])await makeProduct({extension:valueInput(fieldVersion.id,values)},a,422);
 assert.equal(await count('SELECT count(*)::text AS count FROM products'),beforeProducts);assert.equal(await count('SELECT count(*)::text AS count FROM product_field_values'),beforeValues);assert.equal(await count('SELECT count(*)::text AS count FROM audit_events'),beforeAudits);
});

test('未提交字段保留历史值，字段写权限独立于产品写权限，审计不泄漏私密值',async()=>{
 await patchProduct(configuredProduct,{extension:{schema_version_id:fieldVersion.id,values:{secret:'Unauthorized'}}},p,403);
 const updated=await patchProduct(configuredProduct,{name:'计划员更改名称'},p);configuredProduct=updated.product;assert.equal(configuredProduct.name,'计划员更改名称');assert.equal(configuredProduct.extension.values.secret,undefined);
 const adminProduct=(await get('/api/products?page_size=100')).items.find((item:any)=>item.id===configuredProduct.id);assert.equal(adminProduct.extension.values.secret,'Private-7a29');assert.equal(adminProduct.extension.revision,1);
 const audit=await get('/api/audit-events',p);assert.ok(!JSON.stringify(audit).includes('Private-7a29'));
});

test('扩展字段新发布保持旧版本历史；过期表单拒绝，发布和更新带版本冲突',async()=>{
 const revision2=await post('/api/configuration/field-schemas/'+fieldSchema.id+'/versions',{expected_version:fieldSchema.version,fields:[...fields,{key:'note',label:'备注',type:'text',required:false}]});fieldSchema=revision2.schema;
 await post('/api/configuration/field-schemas/'+fieldSchema.id+'/versions',{expected_version:fieldSchema.version-1,fields},a,409);
 await post('/api/configuration/field-schemas/'+fieldSchema.id+'/publish',{expected_version:fieldSchema.version-1,version_id:revision2.version.id},a,409);
 fieldSchema=(await post('/api/configuration/field-schemas/'+fieldSchema.id+'/publish',{expected_version:fieldSchema.version,version_id:revision2.version.id},a,200)).schema;
 await patchProduct(configuredProduct,{extension:valueInput(fieldVersion.id)},a,409);
 configuredProduct=(await patchProduct(configuredProduct,{extension:{schema_version_id:revision2.version.id,values:{note:'新增版本字段',length:'3'}}})).product;
 assert.equal(configuredProduct.extension.revision,2);assert.equal(configuredProduct.extension.values.amount,'0.600000');
 const old=await get('/api/configuration/field-versions/'+fieldVersion.id);assert.equal(old.version.revision,1);assert.equal(old.version.fields.length,fields.length);
 const history=await get('/api/configuration/product-fields/'+configuredProduct.id);assert.equal(history.items.length,2);assert.equal(history.items[1].values.amount,'0.020000');assert.equal(history.items[1].schema_version_id,fieldVersion.id);
 await post('/api/configuration/field-schemas/'+fieldSchema.id+'/publish',{expected_version:fieldSchema.version,version_id:fieldVersion.id},a,409);
});

test('扩展字段停用保留旧值及私密过滤；审计异常导致产品/字段整笔回滚',async()=>{
 const schemaVersion=fieldSchema.current_version_id;
 await rejectAudit(async()=>{await makeProduct({extension:valueInput(schemaVersion)},a,500);});
 const before=await get('/api/configuration/product-fields/'+configuredProduct.id);assert.equal(before.items.length,2);
 fieldSchema=(await request('PATCH','/api/configuration/field-schemas/'+fieldSchema.id,{version:fieldSchema.version,active:false})).schema;
 assert.equal((await get('/api/configuration/field-schemas/current')).version,null);
 await makeProduct({extension:valueInput(schemaVersion)},a,422);
 const workerProduct=(await get('/api/products?page_size=100',w)).items.find((item:any)=>item.id===configuredProduct.id);assert.equal(workerProduct.extension.values.secret,undefined);
 const saved=await makeProduct();assert.equal(saved.product.extension,null);
 fieldSchema=(await request('PATCH','/api/configuration/field-schemas/'+fieldSchema.id,{version:fieldSchema.version,active:true})).schema;
});

test('字段定义拒绝重复key、危险标识、公式未知/私密依赖；其他企业不可访问配置或产品字段',async()=>{
 for(const invalid of [[...fields,fields[0]],[{key:'constructor',label:'危险',type:'text',required:false}],[{key:'amount',label:'公式',type:'formula',required:false,expression:'missing*2',variables:[{name:'missing'}]}],[{key:'secret',label:'私密',type:'number',required:true,read_roles:['admin']},{key:'derived',label:'公开公式',type:'formula',required:true,expression:'secret*2',variables:[{name:'secret'}]}]])await post('/api/configuration/field-schemas/'+fieldSchema.id+'/versions',{expected_version:fieldSchema.version,fields:invalid},a,422);
 await get('/api/configuration/field-schemas/'+fieldSchema.id,b,404);await get('/api/configuration/field-versions/'+fieldVersion.id,b,404);await get('/api/configuration/product-fields/'+configuredProduct.id,b,404);
 await post('/api/configuration/field-schemas/'+fieldSchema.id+'/versions',{expected_version:fieldSchema.version,fields},p,403);
 const rows=await db.tenant({tenantId:tenantB,userId:admin},sql=>sql.query('SELECT id FROM extension_schema_versions WHERE id=$1',[fieldVersion.id]));assert.equal(rows.rows.length,0);
});

const viewConfig={columns:['code','name','ext:batch'],frozen_count:1,sort:[{field:'name',direction:'asc'}],card_fields:['name','ext:batch']};
let tenantView:any,personalWorker:any,originalWorkerHistory:string;
test('个人及企业默认视图持久化、冻结/排序配置、权限和版本隔离',async()=>{
 assert.equal((await get('/api/configuration/views/product/pc',w)).effective,null);
 tenantView=(await request('PUT','/api/configuration/views/product/pc',{scope:'tenant',expected_version:0,...viewConfig})).view;
 assert.equal(tenantView.version,1);assert.equal((await get('/api/configuration/views/product/pc',w)).effective.id,tenantView.id);
 personalWorker=(await request('PUT','/api/configuration/views/product/pc',{scope:'personal',expected_version:0,...viewConfig,columns:['name','code'],card_fields:['name']},w)).view;originalWorkerHistory=personalWorker.history_id;
 assert.equal((await get('/api/configuration/views/product/pc',w)).effective.id,personalWorker.id);
 await request('PUT','/api/configuration/views/product/pc',{scope:'tenant',expected_version:tenantView.version,...viewConfig},w,403);
 await request('PUT','/api/configuration/views/product/pc',{scope:'personal',expected_version:0,...viewConfig},w,409);
 await request('PUT','/api/configuration/views/product/mobile',{scope:'personal',expected_version:0,...viewConfig,columns:['ext:secret'],card_fields:['ext:secret']},w,403);
 await request('PUT','/api/configuration/views/product/mobile',{scope:'personal',expected_version:0,...viewConfig,frozen_count:4},w,422);
 assert.equal((await get('/api/configuration/views/product/pc',b)).effective,null);
});

test('应用到他人须显式选范围和覆盖策略；fill_missing保留个人偏好，replace保留可恢复历史',async()=>{
 const filled=await post('/api/configuration/views/apply',{view_id:tenantView.id,target_user_ids:[worker,planner],strategy:'fill_missing'},a,200);assert.deepEqual(filled.skipped,[worker]);assert.deepEqual(filled.applied,[planner]);
 assert.deepEqual((await get('/api/configuration/views/product/pc',w)).personal.configuration.columns,['name','code']);
 const replaced=await post('/api/configuration/views/apply',{view_id:tenantView.id,target_user_ids:[worker],strategy:'replace'},a,200);assert.deepEqual(replaced.applied,[worker]);personalWorker=(await get('/api/configuration/views/product/pc',w)).personal;assert.deepEqual(personalWorker.configuration.columns,viewConfig.columns);
 const history=await get('/api/configuration/views/'+personalWorker.id+'/history',w);assert.equal(history.items.length,2);assert.equal(history.items[1].id,originalWorkerHistory);
 personalWorker=(await post('/api/configuration/views/'+personalWorker.id+'/restore',{expected_version:personalWorker.version,history_id:originalWorkerHistory},w,200)).view;assert.equal(personalWorker.version,3);assert.deepEqual(personalWorker.configuration.columns,['name','code']);
 await post('/api/configuration/views/'+personalWorker.id+'/restore',{expected_version:2,history_id:originalWorkerHistory},w,409);
 await get('/api/configuration/views/'+personalWorker.id+'/history',p,403);
});

test('视图批量应用外企成员/审计失败整笔回滚，列配置不能提升字段权限',async()=>{
 const before=(await get('/api/configuration/views/product/pc',w)).personal.version;
 await post('/api/configuration/views/apply',{view_id:tenantView.id,target_user_ids:[worker,foreign],strategy:'replace'},a,422);
 assert.equal((await get('/api/configuration/views/product/pc',w)).personal.version,before);
 await rejectAudit(async()=>{await post('/api/configuration/views/apply',{view_id:tenantView.id,target_user_ids:[worker],strategy:'replace'},a,500);});
 assert.equal((await get('/api/configuration/views/product/pc',w)).personal.version,before);
 const privateView=(await request('PUT','/api/configuration/views/product/mobile',{scope:'tenant',expected_version:0,columns:['name','ext:secret'],frozen_count:1,sort:[{field:'ext:secret',direction:'asc'}],card_fields:['name','ext:secret']})).view;
 const visible=(await get('/api/configuration/views/product/mobile',w)).effective;assert.deepEqual(visible.configuration.columns,['name']);assert.deepEqual(visible.configuration.card_fields,['name']);assert.deepEqual(visible.configuration.sort,[]);
 await post('/api/configuration/views/apply',{view_id:privateView.id,target_user_ids:[worker],strategy:'replace'},a,200);assert.deepEqual((await get('/api/configuration/views/product/mobile',w)).effective.configuration.columns,['name']);
 await post('/api/configuration/views/apply',{view_id:tenantView.id,target_user_ids:[worker],strategy:'replace'},p,403);
});

test('十进制公式精确运算、变量单位与AST解释，没有浮点金额误差',async()=>{
 const result=await post('/api/configuration/formula-preview',{expression:'qty * rate',variables:[{name:'qty',unit:'件'},{name:'rate',unit:'元/件'}],values:{qty:'90',rate:'0.5'}},p,200);assert.equal(result.result,'45.000000');assert.equal(result.posted,false);assert.equal(result.inputs[0].unit,'件');assert.equal(result.ast.type,'binary');
 assert.equal(evaluateFormula('a*b',[{name:'a'},{name:'b'}],{a:'0.1',b:'0.2'}).result,'0.020000');
 assert.equal(evaluateFormula('a/3*3',[{name:'a'}],{a:'1'}).result,'1.000000');assert.deepEqual(evaluateFormula('1/3',[],{}).exact_result,{numerator:'1',denominator:'3'});
 assert.equal(evaluateFormula('hours*rate',[{name:'hours'},{name:'rate'}],{hours:'2.5',rate:'20'}).result,'50.000000');
 assert.equal(evaluateFormula('round(0.005,2)',[],{}).result,'0.010000');assert.equal(evaluateFormula('abs(-3)+min(1,2)+max(4,5)',[],{}).result,'9.000000');
 assert.equal(evaluateFormula('99999999999999.999999-99999999999999.999998',[],{}).result,'0.000001');
});

test('公式拒绝脚本、属性、未声明变量、过深/过大、除零、负金额与非文本数值',async()=>{
 const invalid=['globalThis.process','a.constructor','eval(1)','Function(1)','a**2','a;1','Math.max(1,2)','1/0','1/(a-a)','-1','99999999999999*99999999999999','('.repeat(25)+'1'+')'.repeat(25),Array.from({length:30},()=> '1').join('+')];
 for(const expression of invalid)await post('/api/configuration/formula-preview',{expression,variables:[{name:'a'}],values:{a:'1'}},a,422);
 await post('/api/configuration/formula-preview',{expression:'unknown',variables:[],values:{}},a,422);
 await post('/api/configuration/formula-preview',{expression:'a',variables:[{name:'a'}],values:{a:1}},a,400);
 await post('/api/configuration/formula-preview',{expression:'a',variables:[{name:'a'}],values:{a:'1',extra:'1'}},a,422);
 await post('/api/configuration/formula-preview',{expression:'a',variables:[{name:'a'},{name:'a'}],values:{a:'1'}},a,422);
});

test('配置表强制RLS、历史值与字段版本禁止运行角色覆盖',async()=>{
 const tables=['numbering_rules','numbering_counters','numbering_allocations','extension_schemas','extension_schema_versions','extension_schema_publications','product_field_values','user_views','user_view_history'];
 for(const table of tables){const leaked=await db.tenant({tenantId:tenantB,userId:admin},sql=>sql.query('SELECT * FROM '+table+' WHERE tenant_id=$1',[tenantA]));assert.equal(leaked.rows.length,0,table);}
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('UPDATE extension_schema_versions SET fields=$1::jsonb WHERE id=$2',[JSON.stringify(fields),fieldVersion.id])),/permission denied/);
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query('DELETE FROM product_field_values WHERE product_id=$1',[configuredProduct.id])),/permission denied/);
});

test('企业只读/过期状态阻止配置和个人偏好写入，仍可查询已保存配置',async()=>{
 await db.admin(sql=>sql.query("UPDATE tenant_service_limits SET state='read_only' WHERE tenant_id=$1",[tenantA]));
 await request('PUT','/api/configuration/views/product/pc',{scope:'personal',expected_version:personalWorker.version,...viewConfig},w,403);
 await post('/api/configuration/field-schemas/'+fieldSchema.id+'/versions',{expected_version:fieldSchema.version,fields},a,403);
 await get('/api/configuration/number-rules');await get('/api/configuration/views/product/pc',w);
 await db.admin(sql=>sql.query("UPDATE tenant_service_limits SET state='expired' WHERE tenant_id=$1",[tenantA]));
 await post('/api/configuration/number-rules',{entity:'bom',prefix:'BOM',date_pattern:'none',reset_period:'never',padding:4,start:1},a,403);
 await db.admin(sql=>sql.query("UPDATE tenant_service_limits SET state='active' WHERE tenant_id=$1",[tenantA]));
});

test('当前字段可读范围收紧同时限制旧产品值、历史值/计算解释与旧版本元数据',async()=>{
 const privateFields=fields.map(f=>f.key==='batch'||f.key==='price'||f.key==='amount'?{...f,read_roles:['admin'],write_roles:['admin']}:f);
 const draft=await post('/api/configuration/field-schemas/'+fieldSchema.id+'/versions',{expected_version:fieldSchema.version,fields:privateFields});fieldSchema=draft.schema;
 fieldSchema=(await post('/api/configuration/field-schemas/'+fieldSchema.id+'/publish',{expected_version:fieldSchema.version,version_id:draft.version.id},a,200)).schema;
 const product=(await get('/api/products?page_size=100',w)).items.find((item:any)=>item.id===configuredProduct.id);assert.equal(product.extension.values.price,undefined);assert.equal(product.extension.values.amount,undefined);assert.equal(product.extension.values.batch,undefined);
 const historical=await get('/api/configuration/product-fields/'+configuredProduct.id,w);for(const item of historical.items){assert.equal(item.values.price,undefined);assert.equal(item.calculation_details.amount,undefined);assert.equal(item.values.batch,undefined);}
 const oldDefinitions=await get('/api/configuration/field-versions/'+fieldVersion.id,w);assert.ok(!oldDefinitions.version.fields.some((f:any)=>['batch','price','amount'].includes(f.key)));
 const adminHistory=await get('/api/configuration/product-fields/'+configuredProduct.id);assert.equal(adminHistory.items.at(-1).values.price,'0.200000');
});

test('发布失败回滚方案指针及发布记录，草稿版本仍可后续正确发布',async()=>{
 const current=await get('/api/configuration/field-schemas/'+fieldSchema.id);const draft=await post('/api/configuration/field-schemas/'+fieldSchema.id+'/versions',{expected_version:fieldSchema.version,fields:current.versions.find((v:any)=>v.id===fieldSchema.current_version_id).fields});fieldSchema=draft.schema;
 await rejectAudit(async()=>{await post('/api/configuration/field-schemas/'+fieldSchema.id+'/publish',{expected_version:fieldSchema.version,version_id:draft.version.id},a,500);});
 const retained=await get('/api/configuration/field-schemas/'+fieldSchema.id);assert.equal(retained.schema.current_version_id,fieldSchema.current_version_id);assert.equal(retained.schema.version,fieldSchema.version);assert.equal(retained.versions.find((v:any)=>v.id===draft.version.id).state,'draft');
 fieldSchema=(await post('/api/configuration/field-schemas/'+fieldSchema.id+'/publish',{expected_version:fieldSchema.version,version_id:draft.version.id},a,200)).schema;
});

test('跨企复合引用及伪造tenant_id被数据库拒绝，配置接口不能绕过产品数据范围',async()=>{
 const other=await post('/api/configuration/field-schemas',{entity:'product',fields:[{key:'foreignNote',label:'其他企',type:'text',required:false}]},b);
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query("INSERT INTO product_field_values(tenant_id,product_id,schema_version_id,revision,values,created_by) VALUES($1,$2,$3,9,'{}'::jsonb,$4)",[tenantA,configuredProduct.id,other.version.id,admin])),/foreign key/);
 await assert.rejects(db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query("INSERT INTO numbering_rules(tenant_id,entity,prefix,date_pattern,reset_period,padding,start_value) VALUES($1,'bom','X','none','never',4,1)",[tenantB])),/row-level security/);
 const scopedRole=randomUUID();await db.admin(async sql=>{await sql.query("INSERT INTO tenant_roles(id,tenant_id,code,name,permissions,data_scope) VALUES($1,$2,'SELF_CONFIG','本人字段读取','[\"master.read\",\"configuration.read\"]'::jsonb,'self')",[scopedRole,tenantA]);await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name,custom_role_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,user_id) DO UPDATE SET custom_role_id=$4',[tenantA,worker,'本人配置员工',scopedRole]);});
 try{await get('/api/configuration/product-fields/'+configuredProduct.id,w,404);assert.ok(!(await get('/api/products?page_size=100',w)).items.some((item:any)=>item.id===configuredProduct.id));}
 finally{await db.admin(sql=>sql.query('UPDATE tenant_member_profiles SET custom_role_id=NULL WHERE tenant_id=$1 AND user_id=$2',[tenantA,worker]));}
});


test('历史公式被移除后仍按当前输入权限过滤，删除或改型输入不能泄露结果、解释或旧定义',async()=>{
 const publicFields=[{key:'reviewInput',label:'复核输入',type:'number',required:true},{key:'reviewDerived',label:'复核公式',type:'formula',required:true,expression:'reviewInput * 2',variables:[{name:'reviewInput'}]}];
 const publish=async(definitions:unknown[])=>{
  const draft=await post('/api/configuration/field-schemas/'+fieldSchema.id+'/versions',{expected_version:fieldSchema.version,fields:definitions});
  fieldSchema=(await post('/api/configuration/field-schemas/'+fieldSchema.id+'/publish',{expected_version:draft.schema.version,version_id:draft.version.id},a,200)).schema;
  return draft.version;
 };
 const initial=await publish(publicFields);
 const created=(await makeProduct({extension:{schema_version_id:initial.id,values:{reviewInput:'17'}}})).product;
 let visible=await get('/api/configuration/product-fields/'+created.id,w);
 assert.equal(visible.items[0].values.reviewDerived,'34.000000');assert.equal(visible.items[0].calculation_details.reviewDerived.inputs[0].value,'17.000000');
 await publish([{...publicFields[0],read_roles:['admin'],write_roles:['admin']}]);
 const workerProduct=(await get('/api/products?page_size=100',w)).items.find((item:any)=>item.id===created.id);
 assert.equal(workerProduct.extension.values.reviewInput,undefined);assert.equal(workerProduct.extension.values.reviewDerived,undefined);
 visible=await get('/api/configuration/product-fields/'+created.id,w);
 assert.equal(visible.items[0].values.reviewDerived,undefined);assert.equal(visible.items[0].calculation_details.reviewDerived,undefined);assert.ok(!JSON.stringify(visible).includes('17.000000'));
 const workerDefinitions=await get('/api/configuration/field-versions/'+initial.id,w);assert.ok(!workerDefinitions.version.fields.some((field:any)=>field.key==='reviewDerived'));
 const adminHistory=await get('/api/configuration/product-fields/'+created.id);assert.equal(adminHistory.items[0].values.reviewDerived,'34.000000');assert.equal(adminHistory.items[0].calculation_details.reviewDerived.inputs[0].value,'17.000000');
 await publish([{key:'reviewNote',label:'仅保留新字段',type:'text',required:false}]);
 for(const session of [a,w]){
  const history=await get('/api/configuration/product-fields/'+created.id,session);assert.equal(history.items[0].values.reviewDerived,undefined);assert.equal(history.items[0].calculation_details.reviewDerived,undefined);
  const definitions=await get('/api/configuration/field-versions/'+initial.id,session);assert.ok(!definitions.version.fields.some((field:any)=>field.key==='reviewDerived'));
 }
 await publish([{key:'reviewInput',label:'改为文本',type:'text',required:false}]);
 const changedType=await get('/api/configuration/product-fields/'+created.id,w);assert.equal(changedType.items[0].values.reviewDerived,undefined);assert.equal(changedType.items[0].calculation_details.reviewDerived,undefined);
 const stored=(await db.tenant({tenantId:tenantA,userId:admin},sql=>sql.query<{values:any;calculation_details:any}>('SELECT values,calculation_details FROM product_field_values WHERE product_id=$1',[created.id]))).rows;
 assert.equal(stored.length,1);assert.equal(stored[0]!.values.reviewDerived,'34.000000');assert.equal(stored[0]!.calculation_details.reviewDerived.inputs[0].value,'17.000000');
});

test('仅配置读取权限不能通过字段历史读取产品数据',async()=>{
 const roleId=randomUUID();
 await db.admin(async sql=>{
  await sql.query("INSERT INTO tenant_roles(id,tenant_id,code,name,permissions,data_scope) VALUES($1,$2,'CONFIG_ONLY_REVIEW','仅配置读取','[\"configuration.read\"]'::jsonb,'all')",[roleId,tenantA]);
  await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name,custom_role_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,user_id) DO UPDATE SET custom_role_id=$4',[tenantA,worker,'配置复核员工',roleId]);
 });
 try{
  await get('/api/configuration/field-schemas/current',w);await get('/api/products',w,403);await get('/api/configuration/product-fields/'+configuredProduct.id,w,403);
 }finally{await db.admin(sql=>sql.query('UPDATE tenant_member_profiles SET custom_role_id=NULL WHERE tenant_id=$1 AND user_id=$2',[tenantA,worker]));}
});
