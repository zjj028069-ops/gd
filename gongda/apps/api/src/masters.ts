import {gateTenantWrite} from './assets.js';
import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { allocateByRule } from './code-rules.js';
import { dailyCode } from './r10-kit.js';
import { Problem, writeAudit, type Services } from './services.js';
import { decimal, formatDecimal, SCALE, bounded } from './decimal.js';

const uuid={type:'string',format:'uuid'};
const text=(max:number)=>({type:'string',minLength:1,maxLength:max,pattern:'^\\S(?:.*\\S)?$'});
const description={type:'string',maxLength:2000};
const decimalField={type:'string',pattern:'^(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,6})?$'};
const idParams={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}};
const object=(required:string[],properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required,properties});
const reporterIds={type:'array',minItems:0,maxItems:200,uniqueItems:true,items:uuid};
const stepSchema=object(['process_id','auto_inbound'],{process_id:uuid,auto_inbound:{type:'boolean'}});
const routeProperties={name:text(200),description,steps:{type:'array',minItems:0,maxItems:100,items:stepSchema}};
const nullableUuid={anyOf:[uuid,{type:'null'}]};
const nullableText=(max:number)=>({anyOf:[{type:'string',maxLength:max},{type:'null'}]});
const itemSchema=object(['component_product_id','quantity'],{component_product_id:uuid,quantity:decimalField,loss_rate:decimalField,feeding_process_id:nullableUuid,inbound_process_id:nullableUuid,cost_price:{anyOf:[decimalField,{type:'null'}]},auto_issue:{type:'boolean'},component_bom_version_id:nullableUuid});
const bomProperties={description,route_version_id:nullableUuid,items:{type:'array',minItems:0,maxItems:200,items:itemSchema}};
const unitProperties={name:text(200),active:{type:'boolean'},version:{type:'integer',minimum:1}};
type Unit={id:string;code:string;name:string;active:boolean;version:number;sort:number};
type Process={id:string;code:string;name:string;description:string;standard_minutes:string;reporter_ids:string[];pricing_mode:string;wage_rate:string|null;inspection_scheme:string;active:boolean;version:number};
type Route={id:string;code:string;name:string;active:boolean;version:number;current_version_id:string;current_revision:number;steps_count:number};
type Bom={id:string;parent_product_id:string;parent_code:string;parent_name:string;active:boolean;version:number;current_version_id:string;current_revision:number;items_count:number};
type ProductSnapshot={id:string;code:string;name:string;unit_id:string;unit_name:string;attribute:string;active:boolean};
type StepInput={process_id:string;auto_inbound:boolean};
type RouteInput={name:string;description?:string;steps:StepInput[]};
type ItemInput={component_product_id:string;quantity:string;loss_rate?:string;feeding_process_id?:string|null;inbound_process_id?:string|null;cost_price?:string|null;auto_issue?:boolean;component_bom_version_id?:string|null};
type BomInput={description?:string;route_version_id?:string|null;items:ItemInput[]};
type BomItem={id:string;sequence:number;component_product_id:string;component_code:string;component_name:string;unit_id:string;unit_name:string;quantity:string;loss_rate:string;feeding_process_id:string|null;feeding_process_name:string|null;inbound_process_id:string|null;cost_price:string|null;auto_issue:boolean;component_bom_version_id:string|null};
const unitSelect='SELECT id,code,name,active,version,sort,created_at,updated_at FROM units';
const processSelect="SELECT p.id,p.code,p.name,p.description,p.standard_minutes::text,p.pricing_mode,p.wage_rate::text,p.inspection_scheme,p.active,p.version,COALESCE((SELECT jsonb_agg(r.user_id ORDER BY r.user_id) FROM process_reporters r WHERE r.process_id=p.id AND r.tenant_id=p.tenant_id),'[]'::jsonb) AS reporter_ids FROM processes p";
const routeSelect='SELECT r.id,r.code,r.name,r.active,r.version,r.current_version_id,r.current_revision,(SELECT count(*)::integer FROM route_steps s WHERE s.tenant_id=r.tenant_id AND s.version_id=r.current_version_id) AS steps_count FROM process_routes r';
const bomSelect='SELECT b.id,b.parent_product_id,coalesce(p.code,\'\') AS parent_code,coalesce(p.name,\'\') AS parent_name,b.code,b.name,b.category,b.is_default,b.note,coalesce(nullif(p.specification,\'\'),\'-\') AS specification,\'-\' AS creator_name,to_char(b.created_at AT TIME ZONE \'Asia/Shanghai\',\'YYYY-MM-DD HH24:MI:SS\') AS created_at,b.active,b.version,b.current_version_id,b.current_revision,(SELECT count(*)::integer FROM bom_items i WHERE i.tenant_id=b.tenant_id AND i.version_id=b.current_version_id) AS items_count,(SELECT string_agg(coalesce(i.component_snapshot->>\'name\',\'\'),\' \') FROM bom_items i WHERE i.tenant_id=b.tenant_id AND i.version_id=b.current_version_id) AS child_names FROM bom_definitions b LEFT JOIN products p ON p.tenant_id=b.tenant_id AND p.id=b.parent_product_id';
const getUnit=async(sql:Sql,id:string)=>(await sql.query<Unit>(unitSelect+' WHERE id=$1',[id])).rows[0];
const getProcess=async(sql:Sql,id:string)=>(await sql.query<Process>(processSelect+' WHERE p.id=$1',[id])).rows[0];
const getRoute=async(sql:Sql,id:string)=>(await sql.query<Route>(routeSelect+' WHERE r.id=$1',[id])).rows[0];
const getBom=async(sql:Sql,id:string)=>(await sql.query<Bom>(bomSelect+' WHERE b.id=$1',[id])).rows[0];
async function memberCheck(sql:Sql,ids:string[]){
 const rows=(await sql.query<{id:string}>('SELECT id FROM tenant_team_members WHERE id=ANY($1::uuid[])',[ids])).rows;
 if(rows.length!==ids.length)throw new Problem(422,'INVALID_REPORTER','报工名单必须全部为本企业启用成员');
}
async function productSnapshot(sql:Sql,id:string){
 const p=(await sql.query<ProductSnapshot>('SELECT p.id,p.code,p.name,p.unit_id,u.name AS unit_name,p.attribute,p.active FROM products p JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id WHERE p.id=$1 AND u.active',[id])).rows[0];
 if(!p?.active)throw new Problem(422,'INVALID_REFERENCE','产品不存在、不属于本企业或产品/单位已停用');return p;
}
async function routeVersion(sql:Sql,id:string){
 const version=(await sql.query<{id:string;revision:number;description:string;name_snapshot:string;created_at:string;route_id:string}>('SELECT id,route_id,revision,description,name_snapshot,created_at FROM route_versions WHERE id=$1',[id])).rows[0];
 if(!version)throw new Problem(404,'ROUTE_VERSION_NOT_FOUND','路线版本不存在');
 const steps=(await sql.query<{sequence:number;process_id:string;process_code:string;process_name:string;standard_minutes:string;reporter_ids:string[];auto_inbound:boolean}>("SELECT sequence,process_id,process_snapshot->>'code' AS process_code,process_snapshot->>'name' AS process_name,process_snapshot->>'standard_minutes' AS standard_minutes,process_snapshot->'reporter_ids' AS reporter_ids,auto_inbound FROM route_steps WHERE version_id=$1 ORDER BY sequence",[id])).rows;
 return {version,steps};
}
async function bomVersion(sql:Sql,id:string){
 const version=(await sql.query<{id:string;bom_id:string;revision:number;description:string;parent_snapshot:ProductSnapshot;route_version_id:string|null;output_quantity:string;created_at:string}>('SELECT id,bom_id,revision,description,parent_snapshot,route_version_id,output_quantity::text,created_at FROM bom_versions WHERE id=$1',[id])).rows[0];
 if(!version)throw new Problem(404,'BOM_VERSION_NOT_FOUND','BOM版本不存在');
 const items=(await sql.query<BomItem>("SELECT id,sequence,component_product_id,unit_id,component_snapshot->>'code' AS component_code,component_snapshot->>'name' AS component_name,component_snapshot->>'unit_name' AS unit_name,quantity::text,loss_rate::text,feeding_process_id,feeding_snapshot->>'name' AS feeding_process_name,inbound_process_id,cost_price::text,auto_issue,component_bom_version_id FROM bom_items WHERE version_id=$1 ORDER BY sequence",[id])).rows;
 return {version,items};
}
async function saveRouteVersion(sql:Sql,tenant:string,id:string,revision:number,b:RouteInput){
 const snapshots:Process[]=[];
 for(const step of b.steps){const p=await getProcess(sql,step.process_id);if(!p?.active)throw new Problem(422,'INVALID_REFERENCE','工序不存在、不属于本企业或已停用');if(p.reporter_ids.length)await memberCheck(sql,p.reporter_ids);snapshots.push(p);}
 const v=(await sql.query<{id:string}>('INSERT INTO route_versions(tenant_id,route_id,revision,description,name_snapshot) VALUES($1,$2,$3,$4,$5) RETURNING id',[tenant,id,revision,b.description??'',b.name])).rows[0]!;
 for(let index=0;index<b.steps.length;index++){const step=b.steps[index]!;const p=snapshots[index]!;await sql.query('INSERT INTO route_steps(tenant_id,version_id,sequence,process_id,auto_inbound,process_snapshot) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[tenant,v.id,index+1,p.id,step.auto_inbound,JSON.stringify({code:p.code,name:p.name,standard_minutes:p.standard_minutes,reporter_ids:p.reporter_ids})]);}
 await sql.query('UPDATE process_routes SET current_version_id=$1,current_revision=$2,name=$3,updated_at=now() WHERE id=$4',[v.id,revision,b.name,id]);return v.id;
}
async function checkChild(sql:Sql,parent:string,component:string,versionId:string,expectedUnit:string,ancestry:string[],counter:{value:number}){
 if(++counter.value>10000||ancestry.length>32)throw new Problem(422,'BOM_COMPLEXITY','BOM层级或节点过多');
 if(ancestry.includes(component))throw new Problem(422,'BOM_CYCLE','BOM存在产品循环引用');
 const data=await bomVersion(sql,versionId);
 if(data.version.parent_snapshot.id!==component)throw new Problem(422,'INVALID_REFERENCE','子BOM版本与组件产品不匹配');
 if(data.version.parent_snapshot.unit_id!==expectedUnit)throw new Problem(422,'BOM_UNIT_MISMATCH','子BOM产出单位与组件单位不同，当前不作单位换算，请保存一致的新子版本');
 const next=[...ancestry,component];
 for(const item of data.items){if(next.includes(item.component_product_id)||item.component_product_id===parent)throw new Problem(422,'BOM_CYCLE','BOM存在产品循环引用');if(item.component_bom_version_id)await checkChild(sql,parent,item.component_product_id,item.component_bom_version_id,item.unit_id,next,counter);}
}
async function saveBomVersion(sql:Sql,tenant:string,id:string,revision:number,parent:ProductSnapshot,b:BomInput){
 let routeSteps:{process_id:string;process_name:string;process_code:string}[]=[];
 if(b.route_version_id){const own=(await sql.query('SELECT id FROM route_versions WHERE id=$1',[b.route_version_id])).rows[0];if(!own)throw new Problem(422,'INVALID_REFERENCE','路线版本不存在或不属于本企业');routeSteps=(await routeVersion(sql,b.route_version_id)).steps;}
 const prepared: {input:ItemInput;product:ProductSnapshot;quantity:string;loss:string;child:string|null;feeding:unknown;cost:string|null}[]=[];
 const counter={value:0};
 for(const item of b.items){
  const component=await productSnapshot(sql,item.component_product_id);
  if(component.id===parent.id)throw new Problem(422,'BOM_CYCLE','产品不能作为自己的BOM组件');
  const quantity=formatDecimal(decimal(item.quantity,{positive:true}));const loss=formatDecimal(decimal(item.loss_rate??'0',{max:SCALE}));
  let child=item.component_bom_version_id;
  if(child===undefined)child=component.attribute==='manufactured'?(await sql.query<{current_version_id:string}>('SELECT current_version_id FROM bom_definitions WHERE parent_product_id=$1 AND active ORDER BY is_default DESC, created_at DESC LIMIT 1',[component.id])).rows[0]?.current_version_id??null:null;
  if(child){const exists=(await sql.query('SELECT id FROM bom_versions WHERE id=$1',[child])).rows[0];if(!exists)throw new Problem(422,'INVALID_REFERENCE','子BOM版本不存在或不属于本企业');await checkChild(sql,parent.id,component.id,child,component.unit_id,[parent.id],counter);}
  let feeding:unknown=null;
  if(item.feeding_process_id){const p=await getProcess(sql,item.feeding_process_id);if(!p?.active)throw new Problem(422,'INVALID_REFERENCE','投料工序不存在或已停用');const frozen=routeSteps.find(s=>s.process_id===p.id);if(b.route_version_id&&!frozen)throw new Problem(422,'FEEDING_PROCESS_MISMATCH','投料工序不属于所选路线版本');feeding=frozen?{id:p.id,code:frozen.process_code,name:frozen.process_name}:{id:p.id,code:p.code,name:p.name};}
  if(item.auto_issue&&(!item.feeding_process_id||!b.route_version_id))throw new Problem(422,'AUTO_ISSUE_CONFIGURATION','自动领料必须绑定路线版本和其中的投料工序');
  if(item.inbound_process_id){const inbound=await getProcess(sql,item.inbound_process_id);if(!inbound?.active)throw new Problem(422,'INVALID_REFERENCE','入库工序不存在或已停用');if(b.route_version_id&&!routeSteps.find(s=>s.process_id===inbound.id))throw new Problem(422,'INBOUND_PROCESS_MISMATCH','入库工序不属于所选路线版本');}
  const cost=typeof item.cost_price==='string'&&item.cost_price?formatDecimal(decimal(item.cost_price,{label:'成本单价'})):null;
  prepared.push({input:item,product:component,quantity,loss,child:child??null,feeding,cost});
 }
 const v=(await sql.query<{id:string}>('INSERT INTO bom_versions(tenant_id,bom_id,revision,description,parent_snapshot,route_version_id) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id',[tenant,id,revision,b.description??'',JSON.stringify(parent),b.route_version_id??null])).rows[0]!;
 for(let index=0;index<prepared.length;index++){const p=prepared[index]!;await sql.query('INSERT INTO bom_items(tenant_id,version_id,sequence,component_product_id,unit_id,quantity,loss_rate,feeding_process_id,auto_issue,component_bom_version_id,component_snapshot,feeding_snapshot,inbound_process_id,cost_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)',[tenant,v.id,index+1,p.product.id,p.product.unit_id,p.quantity,p.loss,p.input.feeding_process_id??null,p.input.auto_issue??false,p.child,JSON.stringify(p.product),p.feeding?JSON.stringify(p.feeding):null,p.input.inbound_process_id??null,p.cost]);}
 await sql.query('UPDATE bom_definitions SET current_version_id=$1,current_revision=$2,updated_at=now() WHERE id=$3',[v.id,revision,id]);return v.id;
}
/** 原版 BOM 编号：BOM+年月日+4 位流水。规则未配置时退回同源 dailyCode。 */
async function allocateBomCode(sql:Sql,tenantId:string,bomId:string){
 for(let attempt=0;attempt<50;attempt++){
  const issued=(await allocateByRule(sql,tenantId,'BOM编号'))||await dailyCode(sql,tenantId,'BOM');
  if(!(await sql.query('SELECT id FROM bom_definitions WHERE code=$1 AND id<>$2',[issued,bomId])).rows[0])return issued;
 }
 throw new Problem(409,'DUPLICATE_CODE','BOM编号已存在');
}
async function explosion(sql:Sql,versionId:string,quantity:string){
 const amount=decimal(quantity,{positive:true});const requirements=new Map<string,{product_id:string;code:string;name:string;unit_name:string;amount:bigint;paths:string[]}>();const cache=new Map<string,Awaited<ReturnType<typeof bomVersion>>>();let nodes=0;
 const visit=async(id:string,qty:bigint,ancestry:string[],path:string[])=>{
  if(++nodes>10000||ancestry.length>32)throw new Problem(422,'BOM_COMPLEXITY','BOM层级或节点过多');
  let data=cache.get(id);if(!data){data=await bomVersion(sql,id);cache.set(id,data);}
  const parent=data.version.parent_snapshot;
  if(ancestry.includes(parent.id))throw new Problem(422,'BOM_CYCLE','BOM存在产品循环引用');
  const next=[...ancestry,parent.id];const rootPath=[...path,parent.code];const denominator=SCALE*decimal(data.version.output_quantity,{positive:true});
  for(const item of data.items){if(++nodes>10000)throw new Problem(422,'BOM_COMPLEXITY','BOM节点过多');if(next.includes(item.component_product_id))throw new Problem(422,'BOM_CYCLE','BOM存在产品循环引用');const numerator=qty*decimal(item.quantity,{positive:true})*(SCALE+decimal(item.loss_rate,{max:SCALE}));const needed=bounded((numerator+denominator-1n)/denominator);
   if(item.component_bom_version_id)await visit(item.component_bom_version_id,needed,next,rootPath);
   else{const key=item.component_product_id+':'+item.unit_id;const current=requirements.get(key);const linePath=[...rootPath,item.component_code].join(' → ');if(current){current.amount=bounded(current.amount+needed);current.paths.push(linePath);}else requirements.set(key,{product_id:item.component_product_id,code:item.component_code,name:item.component_name,unit_name:item.unit_name,amount:needed,paths:[linePath]});}
  }
 };
 await visit(versionId,amount,[],[]);
 return {version_id:versionId,quantity:formatDecimal(amount),requirements:[...requirements.values()].map(({amount,...row})=>({...row,quantity:formatDecimal(amount)})).sort((a,b)=>a.code.localeCompare(b.code)),warnings:[],rounding:'ceil_6_each_level',posted:false};
}
async function assertUnitNameUnique(sql:Sql,name:string,exceptId?:string){
 const duplicated=(await sql.query('SELECT id FROM units WHERE btrim(name)=$1 AND ($2::uuid IS NULL OR id<>$2::uuid) LIMIT 1',[name.trim(),exceptId??null])).rows[0];
 if(duplicated)throw new Problem(409,'DUPLICATE_UNIT','该单位已存在');
}
export function registerMasters(app:FastifyInstance,s:Services){
 const {database:db,authorize,context,actor}=s;const write=authorize(['admin','planner']);
 app.get('/api/team-members',{preHandler:authorize()},r=>db.tenant(context(r),async sql=>({items:(await sql.query(`SELECT t.id,coalesce(p.display_name,t.display_name) AS display_name,t.role FROM tenant_team_members t LEFT JOIN tenant_member_profiles p ON p.tenant_id=$1 AND p.user_id=t.id WHERE ($2='all' OR ($2='self' AND t.id=$3) OR ($2='department' AND p.department_id=$4 AND $4::uuid IS NOT NULL)) ORDER BY display_name,t.id`,[actor(r).tenant_id,actor(r).data_scope,actor(r).user_id,actor(r).department_id])).rows})));
 app.get('/api/units',{preHandler:authorize()},r=>db.tenant(context(r),async sql=>({items:(await sql.query(unitSelect+' ORDER BY sort,code')).rows})));
 app.post<{Body:{code:string;name:string}}>('/api/units',{preHandler:write,schema:{body:object(['code','name'],{code:text(64),name:text(200)})}},async(r,reply)=>{const unit=await db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const a=actor(r);await assertUnitNameUnique(sql,r.body.name);const row=(await sql.query<{id:string}>('INSERT INTO units(tenant_id,code,name,sort) SELECT $1,$2,$3,COALESCE((SELECT max(sort) FROM units),0)+1 RETURNING id',[a.tenant_id,r.body.code,r.body.name])).rows[0]!;const after=await getUnit(sql,row.id);await writeAudit(sql,a,'unit.created','unit',row.id,null,after);return after;});return reply.code(201).send({unit});});
 app.post<{Body:{ids:string[]}}>('/api/units/reorder',{preHandler:write,schema:{body:object(['ids'],{ids:{type:'array',maxItems:500,items:uuid}})}},async r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));for(let index=0;index<r.body.ids.length;index++)await sql.query('UPDATE units SET sort=$1 WHERE id=$2',[index+1,r.body.ids[index]]);return {ok:true};}));
 app.delete<{Params:{id:string}}>('/api/units/:id',{preHandler:write,schema:{params:idParams}},async r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));if((await sql.query('SELECT id FROM products WHERE unit_id=$1 LIMIT 1',[r.params.id])).rows[0])throw new Problem(409,'UNIT_IN_USE','单位已被商品引用，不能删除');const removed=await sql.query('DELETE FROM units WHERE id=$1 RETURNING id',[r.params.id]);if(!removed.rows[0])throw new Problem(404,'UNIT_NOT_FOUND','单位不存在');await writeAudit(sql,actor(r),'unit.deleted','unit',r.params.id,null,null);return {ok:true};}));
 app.patch<{Params:{id:string};Body:{version:number;name:string;active:boolean}}>('/api/units/:id',{preHandler:write,schema:{params:idParams,body:object(['version','name','active'],unitProperties)}},r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));
  const b=r.body;await sql.query('SELECT id FROM units WHERE id=$1 FOR UPDATE',[r.params.id]);const before=await getUnit(sql,r.params.id);if(!before)throw new Problem(404,'UNIT_NOT_FOUND','单位不存在');await assertUnitNameUnique(sql,b.name,r.params.id);
  if(!b.active&&(await sql.query('SELECT id FROM products WHERE unit_id=$1 AND active LIMIT 1',[r.params.id])).rows[0])throw new Problem(409,'UNIT_IN_USE','启用产品仍在使用此单位，不能停用');
  const update=await sql.query('UPDATE units SET name=$1,active=$2,version=version+1,updated_at=now() WHERE id=$3 AND version=$4 RETURNING id',[b.name,b.active,r.params.id,b.version]);if(!update.rows[0])throw new Problem(409,'VERSION_CONFLICT','单位已被修改，请刷新');const after=await getUnit(sql,r.params.id);await writeAudit(sql,actor(r),'unit.updated','unit',r.params.id,before,after);return {unit:after};
 }));
 const processProperties={code:text(64),name:text(200),description,standard_minutes:decimalField,reporter_ids:reporterIds,active:{type:'boolean'},version:{type:'integer',minimum:1}};
 app.get('/api/processes',{preHandler:authorize()},r=>db.tenant(context(r),async sql=>({items:(await sql.query(processSelect+' ORDER BY p.code LIMIT 200')).rows,total:Number((await sql.query<{n:string}>('SELECT count(*)::text AS n FROM processes')).rows[0]!.n),limit:200})));
 const wageRate={anyOf:[{type:'string',pattern:'^(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,7})?$'},{type:'null'}]};
 const pricingMode={type:'string',enum:['piece','time']};const inspectionScheme={type:'string',enum:['full','sample','none']};
 app.post<{Body:{code?:string;name:string;description?:string;standard_minutes:string;reporter_ids?:string[];pricing_mode?:'piece'|'time';wage_rate?:string|null;inspection_scheme?:'full'|'sample'|'none'}}>('/api/processes',{preHandler:write,schema:{body:object(['name','standard_minutes'],{code:processProperties.code,name:processProperties.name,description,standard_minutes:decimalField,reporter_ids:reporterIds,pricing_mode:pricingMode,wage_rate:wageRate,inspection_scheme:inspectionScheme})}},async(r,reply)=>{
  const process=await db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const b=r.body,a=actor(r);const reporters=b.reporter_ids??[];if(reporters.length)await memberCheck(sql,reporters);const minutes=formatDecimal(decimal(b.standard_minutes));const code=b.code?.trim()||`GX${Date.now().toString().slice(-10)}`;const id=(await sql.query<{id:string}>('INSERT INTO processes(tenant_id,code,name,description,standard_minutes,pricing_mode,wage_rate,inspection_scheme) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[a.tenant_id,code,b.name,b.description??'',minutes,b.pricing_mode??'piece',b.wage_rate??null,b.inspection_scheme??'none'])).rows[0]!.id;for(const user of reporters)await sql.query('INSERT INTO process_reporters(tenant_id,process_id,user_id) VALUES($1,$2,$3)',[a.tenant_id,id,user]);const after=await getProcess(sql,id);await writeAudit(sql,a,'process.created','process',id,null,after);return after;});return reply.code(201).send({process});
 });
 app.patch<{Params:{id:string};Body:{version:number;name:string;description:string;standard_minutes:string;reporter_ids:string[];active:boolean;pricing_mode?:'piece'|'time';wage_rate?:string|null;inspection_scheme?:'full'|'sample'|'none'}}>('/api/processes/:id',{preHandler:write,schema:{params:idParams,body:object(['version','name','description','standard_minutes','reporter_ids','active'],{version:processProperties.version,name:processProperties.name,description,standard_minutes:decimalField,reporter_ids:reporterIds,active:{type:'boolean'},pricing_mode:pricingMode,wage_rate:wageRate,inspection_scheme:inspectionScheme})}},r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));
  const before=await getProcess(sql,r.params.id);if(!before)throw new Problem(404,'PROCESS_NOT_FOUND','工序不存在');const b=r.body,a=actor(r);await memberCheck(sql,b.reporter_ids);const minutes=formatDecimal(decimal(b.standard_minutes));const updated=await sql.query('UPDATE processes SET name=$1,description=$2,standard_minutes=$3,active=$4,pricing_mode=$5,wage_rate=$6,inspection_scheme=$7,version=version+1,updated_at=now() WHERE id=$8 AND version=$9 RETURNING id',[b.name,b.description,minutes,b.active,b.pricing_mode??before.pricing_mode,b.wage_rate===undefined?before.wage_rate:b.wage_rate,b.inspection_scheme??before.inspection_scheme,r.params.id,b.version]);if(!updated.rows[0])throw new Problem(409,'VERSION_CONFLICT','工序已被修改，请刷新');await sql.query('DELETE FROM process_reporters WHERE process_id=$1',[r.params.id]);for(const user of b.reporter_ids)await sql.query('INSERT INTO process_reporters(tenant_id,process_id,user_id) VALUES($1,$2,$3)',[a.tenant_id,r.params.id,user]);const after=await getProcess(sql,r.params.id);await writeAudit(sql,a,'process.updated','process',r.params.id,before,after);return {process:after};
 }));
 app.get('/api/routes',{preHandler:authorize()},r=>db.tenant(context(r),async sql=>({items:(await sql.query(routeSelect+' ORDER BY r.code LIMIT 200')).rows,total:Number((await sql.query<{n:string}>('SELECT count(*)::text AS n FROM process_routes')).rows[0]!.n),limit:200})));
 app.get<{Params:{id:string}}>('/api/routes/:id',{preHandler:authorize(),schema:{params:idParams}},r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const route=await getRoute(sql,r.params.id);if(!route)throw new Problem(404,'ROUTE_NOT_FOUND','工艺路线不存在');return {route,versions:(await sql.query('SELECT id,revision,description,name_snapshot,created_at FROM route_versions WHERE route_id=$1 ORDER BY revision DESC',[route.id])).rows};}));
 app.get<{Params:{id:string}}>('/api/route-versions/:id',{preHandler:authorize(),schema:{params:idParams}},r=>db.tenant(context(r),sql=>routeVersion(sql,r.params.id)));
 app.post<{Body:RouteInput&{code:string;request_key?:string}}>('/api/routes',{preHandler:write,schema:{body:object(['code','name','steps'],{code:text(64),request_key:{type:'string',minLength:8,maxLength:80},...routeProperties})}},async(r,reply)=>{const route=await db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const a=actor(r);const id=(await sql.query<{id:string}>('INSERT INTO process_routes(tenant_id,code,name) VALUES($1,$2,$3) RETURNING id',[a.tenant_id,r.body.code,r.body.name])).rows[0]!.id;const v=await saveRouteVersion(sql,a.tenant_id,id,1,r.body);const after=await getRoute(sql,id);await writeAudit(sql,a,'route.created','route',id,null,{route:after,...await routeVersion(sql,v)});return after;});return reply.code(201).send({route});});
 app.post<{Params:{id:string};Body:RouteInput&{expected_version:number;request_key?:string}}>('/api/routes/:id/versions',{preHandler:write,schema:{params:idParams,body:object(['expected_version','name','steps'],{expected_version:{type:'integer',minimum:1},request_key:{type:'string',minLength:8,maxLength:80},...routeProperties})}},async(r,reply)=>{const route=await db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));await sql.query('SELECT id FROM process_routes WHERE id=$1 FOR UPDATE',[r.params.id]);const before=await getRoute(sql,r.params.id);if(!before)throw new Problem(404,'ROUTE_NOT_FOUND','工艺路线不存在');if(before.version!==r.body.expected_version)throw new Problem(409,'VERSION_CONFLICT','工艺路线已更新，请刷新');const a=actor(r);const v=await saveRouteVersion(sql,a.tenant_id,before.id,before.current_revision+1,r.body);await sql.query('UPDATE process_routes SET version=version+1 WHERE id=$1',[before.id]);const after=await getRoute(sql,before.id);await writeAudit(sql,a,'route.version_created','route',before.id,before,{route:after,...await routeVersion(sql,v)});return after;});return reply.code(201).send({route});});
 app.get('/api/boms',{preHandler:authorize()},r=>db.tenant(context(r),async sql=>({items:(await sql.query(bomSelect+' ORDER BY b.created_at DESC, b.id DESC LIMIT 200')).rows,total:Number((await sql.query<{n:string}>('SELECT count(*)::text AS n FROM bom_definitions')).rows[0]!.n),limit:200})));
 app.get<{Params:{id:string}}>('/api/boms/:id',{preHandler:authorize(),schema:{params:idParams}},r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const bom=await getBom(sql,r.params.id);if(!bom)throw new Problem(404,'BOM_NOT_FOUND','BOM不存在');return {bom,versions:(await sql.query('SELECT id,revision,description,route_version_id,created_at FROM bom_versions WHERE bom_id=$1 ORDER BY revision DESC',[bom.id])).rows};}));
 app.get<{Params:{id:string}}>('/api/bom-versions/:id',{preHandler:authorize(),schema:{params:idParams}},r=>db.tenant(context(r),sql=>bomVersion(sql,r.params.id)));
 app.post<{Body:BomInput&{parent_product_id?:string|null;name?:string;request_key?:string}}>('/api/boms',{preHandler:write,schema:{body:object(['items'],{parent_product_id:nullableUuid,name:{type:'string',maxLength:100},request_key:{type:'string',minLength:8,maxLength:80},...bomProperties})}},async(r,reply)=>{const bom=await db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const a=actor(r);const parentId=r.body.parent_product_id||null;let parent:ProductSnapshot;if(parentId){parent=await productSnapshot(sql,parentId);if(parent.attribute!=='manufactured')throw new Problem(422,'PARENT_NOT_MANUFACTURED','当前设计仅制造产品可建立BOM');}else{const unit=(await sql.query<{id:string;name:string}>('SELECT id,name FROM units ORDER BY sort LIMIT 1')).rows[0];if(!unit)throw new Problem(422,'UNIT','请先维护单位');parent={id:'00000000-0000-0000-0000-000000000000',code:'',name:r.body.name?.trim()||'BOM',unit_id:unit.id,unit_name:unit.name,attribute:'manufactured',active:true};}const bomName=(r.body.name??parent.name).trim();if(!bomName)throw new Problem(422,'NAME','请填写BOM名称');const id=(await sql.query<{id:string}>('INSERT INTO bom_definitions(tenant_id,parent_product_id,name) VALUES($1,$2,$3) RETURNING id',[a.tenant_id,parentId,bomName])).rows[0]!.id;const v=await saveBomVersion(sql,a.tenant_id,id,1,parent,r.body);const after=await getBom(sql,id);await writeAudit(sql,a,'bom.created','bom',id,null,{bom:after,...await bomVersion(sql,v)});return after;});return reply.code(201).send({bom});});
 app.post<{Params:{id:string};Body:BomInput&{expected_version:number}}>('/api/boms/:id/versions',{preHandler:write,schema:{params:idParams,body:object(['expected_version','items'],{expected_version:{type:'integer',minimum:1},...bomProperties})}},async(r,reply)=>{const bom=await db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));await sql.query('SELECT id FROM bom_definitions WHERE id=$1 FOR UPDATE',[r.params.id]);const before=await getBom(sql,r.params.id);if(!before)throw new Problem(404,'BOM_NOT_FOUND','BOM不存在');if(before.version!==r.body.expected_version)throw new Problem(409,'VERSION_CONFLICT','BOM已更新，请刷新');const a=actor(r),parent=await productSnapshot(sql,before.parent_product_id);if(parent.attribute!=='manufactured')throw new Problem(422,'PARENT_NOT_MANUFACTURED','当前设计仅制造产品可建立BOM');const v=await saveBomVersion(sql,a.tenant_id,before.id,before.current_revision+1,parent,r.body);await sql.query('UPDATE bom_definitions SET version=version+1 WHERE id=$1',[before.id]);const after=await getBom(sql,before.id);await writeAudit(sql,a,'bom.version_created','bom',before.id,before,{bom:after,...await bomVersion(sql,v)});return after;});return reply.code(201).send({bom});});
 app.get<{Params:{id:string};Querystring:{quantity:string;version_id?:string}}>('/api/boms/:id/explosion',{preHandler:authorize(),schema:{params:idParams,querystring:object(['quantity'],{quantity:decimalField,version_id:uuid})}},r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const bom=await getBom(sql,r.params.id);if(!bom)throw new Problem(404,'BOM_NOT_FOUND','BOM不存在');const id=r.query.version_id??bom.current_version_id;const own=(await sql.query('SELECT id FROM bom_versions WHERE id=$1 AND bom_id=$2',[id,bom.id])).rows[0];if(!own)throw new Problem(404,'BOM_VERSION_NOT_FOUND','BOM版本不存在');return explosion(sql,id,r.query.quantity);}));
 app.put<{Params:{id:string};Body:{code?:string|null;name?:string|null;category?:string|null;is_default?:boolean;note?:string|null}}>('/api/boms/:id/extras',{preHandler:write,schema:{params:idParams,body:object([],{code:nullableText(64),name:nullableText(100),category:nullableText(40),is_default:{type:'boolean'},note:nullableText(255)})}},r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const current=(await sql.query<{id:string;code:string}>('SELECT id,code FROM bom_definitions WHERE id=$1 FOR UPDATE',[r.params.id])).rows[0];if(!current)throw new Problem(404,'BOM_NOT_FOUND','BOM不存在');const b=r.body;let code:string|null=null;if(Object.prototype.hasOwnProperty.call(b,'code')){const requested=typeof b.code==='string'?b.code.trim():'';if(!requested)code=await allocateBomCode(sql,actor(r).tenant_id,r.params.id);else{if((await sql.query('SELECT id FROM bom_definitions WHERE code=$1 AND id<>$2',[requested,r.params.id])).rows[0])throw new Problem(409,'DUPLICATE_CODE','BOM编号已存在');code=requested;}}const head=(await sql.query<{parent_product_id:string;active:boolean}>('SELECT parent_product_id,active FROM bom_definitions WHERE id=$1',[r.params.id])).rows[0]!;if(b.is_default===true&&head.active===false)throw new Problem(422,'BOM_DEFAULT','禁用的BOM不能设为默认');await sql.query('UPDATE bom_definitions SET code=coalesce($1,code),name=coalesce($2,name),category=coalesce($3,category),is_default=coalesce($4,is_default),note=coalesce($5,note),version=version+1,updated_at=now() WHERE id=$6',[code,b.name??null,b.category??null,b.is_default??null,b.note??null,r.params.id]);if(b.is_default===true)await sql.query('UPDATE bom_definitions SET is_default=false,version=version+1 WHERE parent_product_id=$1 AND id<>$2 AND is_default',[head.parent_product_id,r.params.id]);const only=(await sql.query<{n:string}>('SELECT count(*)::text AS n FROM bom_definitions WHERE parent_product_id=$1 AND active',[head.parent_product_id])).rows[0]!;if(only.n==='1')await sql.query('UPDATE bom_definitions SET is_default=true WHERE id=$1 AND active',[r.params.id]);const saved=(await sql.query<{code:string}>('SELECT code FROM bom_definitions WHERE id=$1',[r.params.id])).rows[0]!;return {ok:true,code:saved.code};}));
 app.delete<{Params:{id:string};Body:{version:number}}>('/api/boms/:id',{preHandler:write,schema:{params:idParams,body:object(['version'],{version:{type:'integer',minimum:1}})}},r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const before=await getBom(sql,r.params.id);if(!before)throw new Problem(404,'BOM_NOT_FOUND','BOM不存在');if(before.version!==r.body.version)throw new Problem(409,'VERSION_CONFLICT','BOM已更新，请刷新');if((await sql.query('SELECT 1 FROM work_orders WHERE bom_version_id IN (SELECT id FROM bom_versions WHERE bom_id=$1) LIMIT 1',[r.params.id])).rows[0])throw new Problem(409,'BOM_IN_USE','加工单已引用此BOM，不能删除');await sql.query('DELETE FROM bom_items WHERE version_id IN (SELECT id FROM bom_versions WHERE bom_id=$1)',[r.params.id]);await sql.query('DELETE FROM bom_versions WHERE bom_id=$1',[r.params.id]);await sql.query('DELETE FROM bom_definitions WHERE id=$1',[r.params.id]);await writeAudit(sql,actor(r),'bom.deleted','bom',r.params.id,before,null);return {ok:true};}));
 app.get<{Params:{id:string}}>('/api/processes/:id/extras',{preHandler:authorize(),schema:{params:idParams}},r=>db.tenant(context(r),async sql=>{const row=(await sql.query('SELECT shop_id,line_id,report_unit_id,unit_ratio::text,need_outsource,task_timing,report_component_id,qc_component_id FROM processes WHERE id=$1',[r.params.id])).rows[0];if(!row)throw new Problem(404,'PROCESS_NOT_FOUND','工序不存在');return {extras:row};}));
 app.put<{Params:{id:string};Body:{shop_id?:string|null;line_id?:string|null;report_unit_id?:string|null;unit_ratio?:string|null;need_outsource?:boolean;task_timing?:boolean}}>('/api/processes/:id/extras',{preHandler:write,schema:{params:idParams,body:object([],{shop_id:nullableUuid,line_id:nullableUuid,report_unit_id:nullableUuid,unit_ratio:{anyOf:[decimalField,{type:'null'}]},need_outsource:{type:'boolean'},task_timing:{type:'boolean'}})}},r=>db.tenant(context(r),async sql=>{if(r.method!=='GET')await gateTenantWrite(sql,context(r));const b=r.body;await sql.query('UPDATE processes SET shop_id=$1,line_id=$2,report_unit_id=$3,unit_ratio=$4,need_outsource=coalesce($5,need_outsource),task_timing=coalesce($6,task_timing),version=version+1,updated_at=now() WHERE id=$7',[b.shop_id??null,b.line_id??null,b.report_unit_id??null,b.unit_ratio??null,b.need_outsource??null,b.task_timing??null,r.params.id]);return {ok:true};}));
}





export async function createBomFromImport(
  sql: Sql,
  actor: Actor,
  input: {
    parent_product_id?: string | null;
    name?: string;
    description?: string;
    items: { component_product_id: string; quantity: string; loss_rate?: string }[];
  },
): Promise<{ bom: Bom; version_id: string }> {
  if (!input.items.length) throw new Problem(422, 'EMPTY_ITEMS', '至少需要一行有效物料');
  const parentId = input.parent_product_id || null;
  let parent: ProductSnapshot;
  if (parentId) {
    parent = await productSnapshot(sql, parentId);
    if (parent.attribute !== 'manufactured') throw new Problem(422, 'PARENT_NOT_MANUFACTURED', '当前设计仅制造产品可建立BOM');
  } else {
    const unit = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM units ORDER BY sort LIMIT 1')).rows[0];
    if (!unit) throw new Problem(422, 'UNIT', '请先维护单位');
    parent = {
      id: '00000000-0000-0000-0000-000000000000',
      code: '',
      name: (input.name ?? '').trim() || 'AI导入BOM',
      unit_id: unit.id,
      unit_name: unit.name,
      attribute: 'manufactured',
      active: true,
    };
  }
  const bomName = (input.name ?? parent.name).trim() || 'AI导入BOM';
  const id = (await sql.query<{ id: string }>('INSERT INTO bom_definitions(tenant_id,parent_product_id,name) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, parentId, bomName])).rows[0]!.id;
  const versionId = await saveBomVersion(sql, actor.tenant_id, id, 1, parent, {
    description: input.description ?? 'AI导入',
    items: input.items.map((item) => ({
      component_product_id: item.component_product_id,
      quantity: item.quantity,
      loss_rate: item.loss_rate ?? '0',
    })),
  });
  const after = await getBom(sql, id);
  if (!after) throw new Problem(500, 'BOM_CREATE_FAILED', 'BOM 创建失败');
  await writeAudit(sql, actor, 'bom.created', 'bom', id, null, { bom: after, ...(await bomVersion(sql, versionId)), source: 'ai_import' });
  return { bom: after, version_id: versionId };
}


export async function createRouteFromImport(
  sql: Sql,
  actor: Actor,
  input: {
    code: string;
    name: string;
    description?: string;
    steps: { process_id: string; auto_inbound?: boolean }[];
  },
): Promise<{ route: Route; version_id: string }> {
  const name = input.name.trim();
  if (!name) throw new Problem(422, 'NAME_REQUIRED', '请填写工艺路线名称');
  const code = input.code.trim();
  if (!code) throw new Problem(422, 'CODE_REQUIRED', '请填写工艺路线编号');
  if ((await sql.query('SELECT id FROM process_routes WHERE code=$1', [code])).rows[0]) {
    throw new Problem(409, 'DUPLICATE_CODE', '工艺路线编号已存在');
  }
  const id = (
    await sql.query<{ id: string }>('INSERT INTO process_routes(tenant_id,code,name) VALUES($1,$2,$3) RETURNING id', [
      actor.tenant_id,
      code,
      name,
    ])
  ).rows[0]!.id;
  const versionId = await saveRouteVersion(sql, actor.tenant_id, id, 1, {
    name,
    description: input.description ?? 'AI图纸拆单',
    steps: input.steps.map((s) => ({ process_id: s.process_id, auto_inbound: s.auto_inbound ?? false })),
  });
  const after = await getRoute(sql, id);
  if (!after) throw new Problem(500, 'ROUTE_CREATE_FAILED', '工艺路线创建失败');
  await writeAudit(sql, actor, 'route.created', 'route', id, null, {
    route: after,
    ...(await routeVersion(sql, versionId)),
    source: 'ai_drawing_split',
  });
  return { route: after, version_id: versionId };
}

