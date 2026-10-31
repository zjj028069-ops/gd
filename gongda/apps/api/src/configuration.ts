import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql } from './database.js';
import { Problem, writeAudit, assertProductScope, type Actor, type Role, type Services } from './services.js';
import { gateTenantWrite } from './assets.js';
import { compileFormula, evaluateFormula, canonicalDecimal, type FormulaVariable } from './formula.js';
export type ExtensionField={key:string;label:string;type:'text'|'number'|'select'|'date'|'boolean'|'formula';required:boolean;options?:string[];expression?:string;variables?:FormulaVariable[];read_roles:Role[];write_roles:Role[]};
export type ProductExtensionInput={schema_version_id:string;values:Record<string,unknown>};
type FieldSchema={id:string;entity:'product';active:boolean;version:number;latest_revision:number;current_version_id:string|null;current_revision:number};
type FieldVersion={id:string;schema_id:string;revision:number;fields:ExtensionField[];state:'draft'|'published';published_at:string|null};
type FieldValue={id:string;schema_version_id:string;revision:number;values:Record<string,unknown>;calculation_details:Record<string,unknown>};
type NumberRule={id:string;entity:string;prefix:string;date_pattern:string;reset_period:string;padding:number;start:string;active:boolean;version:number};
type ViewConfiguration={columns:string[];frozen_count:number;sort:{field:string;direction:'asc'|'desc'}[];card_fields:string[]};
type View={id:string;user_id:string|null;entity:string;surface:string;scope:'tenant'|'personal';version:number;history_id:string;configuration:ViewConfiguration};
const uuid={type:'string',format:'uuid'},versionNumber={type:'integer',minimum:1};
const paramsId={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}};
const roles:Role[]=['admin','planner','worker'];
const numberEntities=['unit','product','process','route','bom'];
const own=(object:unknown):object is Record<string,unknown>=>Boolean(object&&typeof object==='object'&&!Array.isArray(object));
const fieldsSchema={type:'array',minItems:1,maxItems:30,items:{type:'object',additionalProperties:false,required:['key','label','type','required'],properties:{
 key:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_]{0,31}$'},label:{type:'string',minLength:1,maxLength:120},type:{type:'string',enum:['text','number','select','date','boolean','formula']},required:{type:'boolean'},
 options:{type:'array',maxItems:100,minItems:1,uniqueItems:true,items:{type:'string',minLength:1,maxLength:200}},expression:{type:'string',minLength:1,maxLength:1000},
 variables:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_]{0,31}$'},unit:{type:'string',maxLength:40}}}},
 read_roles:{type:'array',minItems:1,maxItems:3,uniqueItems:true,items:{type:'string',enum:roles}},write_roles:{type:'array',minItems:1,maxItems:3,uniqueItems:true,items:{type:'string',enum:roles}},
}}};
export const productExtensionSchema={type:'object',additionalProperties:false,required:['schema_version_id','values'],properties:{schema_version_id:uuid,values:{type:'object',maxProperties:30}}};
const schemaSelect='SELECT id,entity,active,version,latest_revision,current_version_id,current_revision,created_at,updated_at FROM extension_schemas';
const fieldVersionSelect="SELECT v.id,v.schema_id,v.revision,v.fields,v.created_at,p.published_at,CASE WHEN p.version_id IS NULL THEN 'draft' ELSE 'published' END AS state FROM extension_schema_versions v LEFT JOIN extension_schema_publications p ON p.tenant_id=v.tenant_id AND p.version_id=v.id";
const numberRuleSelect='SELECT id,entity,prefix,date_pattern,reset_period,padding,start_value::text AS start,active,version,created_at,updated_at FROM numbering_rules';
const viewSelect='SELECT v.id,v.user_id,v.entity,v.surface,v.scope,v.version,h.id AS history_id,h.configuration FROM user_views v JOIN user_view_history h ON h.tenant_id=v.tenant_id AND h.view_id=v.id AND h.id=v.current_history_id';
const immutableNames=new Set(['constructor','prototype','__proto__','eval','Function','window','globalThis','process','require']);
function normalizeFields(input:unknown):ExtensionField[]{
 if(!Array.isArray(input)||input.length<1||input.length>30)throw new Problem(422,'FIELD_DEFINITION','须配置1至30个字段');
 const fields=input.map(raw=>{if(!own(raw)||typeof raw.key!=='string'||immutableNames.has(raw.key)||typeof raw.label!=='string'||!raw.label.trim())throw new Problem(422,'FIELD_DEFINITION','字段名和标签必须合法');return {...raw,read_roles:raw.read_roles??roles,write_roles:raw.write_roles??['admin','planner']} as ExtensionField;});
 if(new Set(fields.map(f=>f.key)).size!==fields.length)throw new Problem(422,'FIELD_DUPLICATE','同一版本不能有重复字段名');
 for(const f of fields){
  if(f.type==='select'&&!f.options?.length)throw new Problem(422,'FIELD_OPTIONS','单选字段须有选项');
  if(f.type!=='select'&&f.options!==undefined)throw new Problem(422,'FIELD_OPTIONS','仅单选字段可以配置选项');
  if(f.type!=='formula'&&(f.expression!==undefined||f.variables!==undefined))throw new Problem(422,'FIELD_FORMULA','仅公式字段可以配置表达式');
  if(f.type==='formula'){
   if(!f.expression||!Array.isArray(f.variables))throw new Problem(422,'FIELD_FORMULA','公式须声明表达式和变量');compileFormula(f.expression,f.variables);
   for(const variable of f.variables){const dependency=fields.find(field=>field.key===variable.name);if(!dependency||dependency.type!=='number')throw new Problem(422,'FIELD_FORMULA','公式变量只能引用同一版本的数值字段');if(f.read_roles.some(role=>!dependency.read_roles.includes(role)))throw new Problem(422,'FIELD_PERMISSION','公式可读范围不能超过变量字段可读范围');}
  }
 }
 return fields;
}
async function currentSchema(sql:Sql,lock=false){
 const schema=(await sql.query<FieldSchema>(schemaSelect+" WHERE entity='product'"+(lock?' FOR UPDATE':''))).rows[0]??null;
 const version=schema?.active&&schema.current_version_id?(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[schema.current_version_id])).rows[0]??null:null;
 return {schema,version};
}
async function latestProductValues(sql:Sql,id:string){return (await sql.query<FieldValue>('SELECT id,schema_version_id,revision,values,calculation_details FROM product_field_values WHERE product_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0]??null;}
function validateFieldValue(field:ExtensionField,value:unknown){
 if(value===undefined||value===null||typeof value==='string'&&!value.trim()){if(field.required)throw new Problem(422,'FIELD_REQUIRED','必填字段缺失：'+field.label);return undefined;}
 switch(field.type){
  case 'text':if(typeof value!=='string'||value.length>2000)throw new Problem(422,'FIELD_TYPE','文本字段须为2000字以内文本：'+field.label);return value;
  case 'number':return canonicalDecimal(value);
  case 'boolean':if(typeof value!=='boolean')throw new Problem(422,'FIELD_TYPE','布尔字段须为布尔值：'+field.label);return value;
  case 'select':if(typeof value!=='string'||!field.options?.includes(value))throw new Problem(422,'FIELD_OPTION','单选值不在配置范围：'+field.label);return value;
  case 'date':{
   if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'9999-12-31')throw new Problem(422,'FIELD_DATE','日期须为有效YYYY-MM-DD：'+field.label);
   const parsed=new Date(value+'T00:00:00Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)throw new Problem(422,'FIELD_DATE','日期须为有效YYYY-MM-DD：'+field.label);return value;
  }
  default:return undefined;
 }
}
function readableField(field:ExtensionField,snapshotFields:ExtensionField[],actor:Actor,currentFields?:ExtensionField[]){
 const current=currentFields?.find(candidate=>candidate.key===field.key);
 if(!field.read_roles.includes(actor.role)||current&&!current.read_roles.includes(actor.role))return false;
 if(field.type!=='formula')return true;
 // Historical results and explanations must not reveal an input whose current permission was withdrawn.
 return (field.variables??[]).every(variable=>{
  const historicalInput=snapshotFields.find(candidate=>candidate.key===variable.name);
  const currentInput=currentFields?.find(candidate=>candidate.key===variable.name);
  return historicalInput?.type==='number'&&historicalInput.read_roles.includes(actor.role)&&currentInput?.type==='number'&&currentInput.read_roles.includes(actor.role);
 });
}
function permittedValues(fields:ExtensionField[],values:Record<string,unknown>,actor:Actor,currentFields?:ExtensionField[]){const result:Record<string,unknown>={};for(const field of fields){if(readableField(field,fields,actor,currentFields)&&Object.hasOwn(values,field.key))result[field.key]=values[field.key];}return result;}
export async function attachProductFields<T extends {id:string}>(sql:Sql,products:T[],actor:Actor):Promise<(T&{extension:{schema_version_id:string;revision:number;values:Record<string,unknown>}|null})[]> {
 const current=await currentSchema(sql);const permissionVersion=current.version??(current.schema?.current_version_id?(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[current.schema.current_version_id])).rows[0]:null);const result=[];
 for(const product of products){const latest=await latestProductValues(sql,product.id);const snapshot=latest?(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[latest.schema_version_id])).rows[0]:null;result.push({...product,extension:latest&&snapshot?{schema_version_id:latest.schema_version_id,revision:latest.revision,values:permittedValues(snapshot.fields,latest.values,actor,permissionVersion?.fields)}:null});}return result;
}
export async function saveProductFields(sql:Sql,actor:Actor,productId:string,input?:ProductExtensionInput){
 const {schema,version}=await currentSchema(sql,true);const before=await latestProductValues(sql,productId);
 if(!schema?.active||!version){if(input)throw new Problem(422,'FIELD_SCHEMA_INACTIVE','当前没有启用并发布的产品字段版本');return before;}
 if(input&&input.schema_version_id!==version.id)throw new Problem(409,'FIELD_SCHEMA_CONFLICT','产品扩展字段版本已变化，请刷新表单');
 const old:Record<string,unknown>={...(before?.values??{})},submitted=input?.values??{};
 for(const key of Object.keys(submitted)){const field=version.fields.find(f=>f.key===key);if(!field)throw new Problem(422,'FIELD_UNKNOWN','扩展字段不在当前版本：'+key);if(field.type==='formula')throw new Problem(422,'FIELD_FORMULA_READONLY','公式结果只能由服务端生成');if(!field.write_roles.includes(actor.role))throw new Problem(403,'FIELD_FORBIDDEN','无权修改扩展字段：'+field.label);old[key]=submitted[key];}
 const values:Record<string,unknown>={},calculations:Record<string,unknown>={};
 for(const field of version.fields.filter(f=>f.type!=='formula')){const value=validateFieldValue(field.read_roles.includes(actor.role)?field:{...field,label:'当前版本的受限字段'},old[field.key]);if(value!==undefined)values[field.key]=value;}
 for(const field of version.fields.filter(f=>f.type==='formula')){
  const variableValues:Record<string,unknown>={};for(const variable of field.variables??[]){if(!Object.hasOwn(values,variable.name)){if(field.required)throw new Problem(422,'FIELD_REQUIRED','公式所需数值缺失：'+(field.read_roles.includes(actor.role)?field.label:'当前版本的受限字段'));continue;}variableValues[variable.name]=values[variable.name];}
  if(Object.keys(variableValues).length!==(field.variables??[]).length)continue;
  const calculation=evaluateFormula(field.expression!,field.variables!,variableValues,{nonNegative:false});values[field.key]=calculation.result;calculations[field.key]=calculation;
 }
 if(before?.schema_version_id===version.id&&isDeepStrictEqual(before.values,values))return before;
 const after=(await sql.query<FieldValue>('INSERT INTO product_field_values(tenant_id,product_id,schema_version_id,revision,values,calculation_details,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING id,schema_version_id,revision,values,calculation_details',[actor.tenant_id,productId,version.id,(before?.revision??0)+1,JSON.stringify(values),JSON.stringify(calculations),actor.user_id])).rows[0]!;
 await writeAudit(sql,actor,'product.fields.saved','product_fields',productId,before?{schema_version_id:before.schema_version_id,revision:before.revision}:null,{schema_version_id:after.schema_version_id,revision:after.revision});return after;
}
const numberProperties={entity:{type:'string',enum:numberEntities},prefix:{type:'string',maxLength:32,pattern:'^[A-Za-z0-9一-龥_-]*$'},date_pattern:{type:'string',enum:['none','yyyyMMdd','yyyyMM','yyyy']},reset_period:{type:'string',enum:['never','day','month','year']},padding:{type:'integer',minimum:1,maximum:12},start:{type:'integer',minimum:1,maximum:999999999999},active:{type:'boolean'}};
function checkNumberRule(b:{prefix:string;date_pattern:string;reset_period:string;padding:number;start:number}){
 if(String(b.start).length>b.padding)throw new Problem(422,'NUMBER_RANGE','起始流水位数超过补零位数');
 if(b.reset_period==='day'&&b.date_pattern!=='yyyyMMdd'||b.reset_period==='month'&&!['yyyyMM','yyyyMMdd'].includes(b.date_pattern)||b.reset_period==='year'&&b.date_pattern==='none')throw new Problem(422,'NUMBER_PERIOD','重置周期必须完整包含在日期格式中，避免周期内重复编号');
}
function serverDate(now=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);return ['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('');}
const safeViewFields=['code','name','specification','unit_name','attribute','active','version'];
async function allowedViewFields(sql:Sql,actor:Actor){const {version}=await currentSchema(sql);return new Set([...safeViewFields,...(version?.fields??[]).filter(f=>f.read_roles.includes(actor.role)).map(f=>'ext:'+f.key)]);}
function visibleView(view:View|null,allowed:Set<string>){if(!view)return null;return {...view,configuration:{...view.configuration,columns:view.configuration.columns.filter(f=>allowed.has(f)),card_fields:view.configuration.card_fields.filter(f=>allowed.has(f)),sort:view.configuration.sort.filter(s=>allowed.has(s.field)),frozen_count:Math.min(view.configuration.frozen_count,view.configuration.columns.filter(f=>allowed.has(f)).length)}};}
const viewProperties={scope:{type:'string',enum:['personal','tenant']},expected_version:{type:'integer',minimum:0},columns:{type:'array',minItems:1,maxItems:40,uniqueItems:true,items:{type:'string',minLength:1,maxLength:64}},frozen_count:{type:'integer',minimum:0,maximum:5},sort:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,required:['field','direction'],properties:{field:{type:'string',maxLength:64},direction:{type:'string',enum:['asc','desc']}}}},card_fields:{type:'array',minItems:1,maxItems:15,uniqueItems:true,items:{type:'string',maxLength:64}}};
async function checkView(sql:Sql,actor:Actor,config:ViewConfiguration){
 const allowed=await allowedViewFields(sql,actor);if([...config.columns,...config.card_fields,...config.sort.map(s=>s.field)].some(f=>!allowed.has(f)))throw new Problem(403,'VIEW_FIELD_FORBIDDEN','列表/手机卡片不能引用不存在或无权查看的字段');
 if(config.frozen_count>config.columns.length||new Set(config.sort.map(s=>s.field)).size!==config.sort.length)throw new Problem(422,'VIEW_CONFIGURATION','冻结列不能超过可见列，排序字段不能重复');
}
async function saveView(sql:Sql,actor:Actor,args:{scope:'tenant'|'personal';userId:string|null;entity:string;surface:string;expectedVersion:number;configuration:ViewConfiguration;source:'manual'|'admin_apply'|'restore'}){
 const before=(await sql.query<View>(viewSelect+' WHERE v.entity=$1 AND v.surface=$2 AND v.scope=$3 AND v.user_id IS NOT DISTINCT FROM $4::uuid FOR UPDATE OF v',[args.entity,args.surface,args.scope,args.userId])).rows[0]??null;
 if((before?.version??0)!==args.expectedVersion)throw new Problem(409,'VERSION_CONFLICT','列表配置已变化，请刷新后重试');
 const id=before?.id??randomUUID(),version=(before?.version??0)+1;
 if(!before)await sql.query('INSERT INTO user_views(id,tenant_id,user_id,entity,surface,scope) VALUES($1,$2,$3,$4,$5,$6)',[id,actor.tenant_id,args.userId,args.entity,args.surface,args.scope]);
 const history=(await sql.query<{id:string}>('INSERT INTO user_view_history(tenant_id,view_id,revision,configuration,created_by,source) VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING id',[actor.tenant_id,id,version,JSON.stringify(args.configuration),actor.user_id,args.source])).rows[0]!;
 await sql.query('UPDATE user_views SET current_history_id=$1,version=$2,updated_at=now() WHERE id=$3',[history.id,version,id]);const after=(await sql.query<View>(viewSelect+' WHERE v.id=$1',[id])).rows[0]!;
 await writeAudit(sql,actor,'view.'+args.source,'view',id,before,after);return after;
}
export function registerConfiguration(app:FastifyInstance,services:Services){
 const {database,requirePermission,context,actor}=services;
 const tenantWrite=<T>(request:FastifyRequest,work:(sql:Sql)=>Promise<T>)=>database.tenant(context(request),async sql=>{await gateTenantWrite(sql,context(request));return work(sql);});
 const read={preHandler:requirePermission('configuration.read')},admin={preHandler:requirePermission('configuration.manage')};
 app.get('/api/configuration/number-rules',read,async request=>database.tenant(context(request),async sql=>({items:(await sql.query<NumberRule>(numberRuleSelect+' ORDER BY entity')).rows})));
 app.post<{Body:{entity:string;prefix:string;date_pattern:string;reset_period:string;padding:number;start:number}}>('/api/configuration/number-rules',{...admin,schema:{body:{type:'object',additionalProperties:false,required:['entity','prefix','date_pattern','reset_period','padding','start'],properties:numberProperties}}},async(request,reply)=>{
  checkNumberRule(request.body);const rule=await tenantWrite(request,async sql=>{const b=request.body;const row=(await sql.query<{id:string}>('INSERT INTO numbering_rules(tenant_id,entity,prefix,date_pattern,reset_period,padding,start_value) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[actor(request).tenant_id,b.entity,b.prefix,b.date_pattern,b.reset_period,b.padding,b.start])).rows[0]!;const result=(await sql.query<NumberRule>(numberRuleSelect+' WHERE id=$1',[row.id])).rows[0]!;await writeAudit(sql,actor(request),'number_rule.created','number_rule',row.id,null,result);return result;});return reply.code(201).send({rule});
 });
 app.patch<{Params:{id:string};Body:{version:number;prefix:string;date_pattern:string;reset_period:string;padding:number;start:number;active:boolean}}>('/api/configuration/number-rules/:id',{...admin,schema:{params:paramsId,body:{type:'object',additionalProperties:false,required:['version','prefix','date_pattern','reset_period','padding','start','active'],properties:{version:versionNumber,prefix:numberProperties.prefix,date_pattern:numberProperties.date_pattern,reset_period:numberProperties.reset_period,padding:numberProperties.padding,start:numberProperties.start,active:numberProperties.active}}}},async request=>{
  checkNumberRule(request.body);return tenantWrite(request,async sql=>{const before=(await sql.query<NumberRule>(numberRuleSelect+' WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];if(!before)throw new Problem(404,'NUMBER_RULE_NOT_FOUND','编号规则不存在');const b=request.body;if(before.version!==b.version)throw new Problem(409,'VERSION_CONFLICT','编号规则已变化');await sql.query('UPDATE numbering_rules SET prefix=$1,date_pattern=$2,reset_period=$3,padding=$4,start_value=$5,active=$6,version=version+1,updated_at=now() WHERE id=$7',[b.prefix,b.date_pattern,b.reset_period,b.padding,b.start,b.active,before.id]);const rule=(await sql.query<NumberRule>(numberRuleSelect+' WHERE id=$1',[before.id])).rows[0]!;await writeAudit(sql,actor(request),'number_rule.updated','number_rule',rule.id,before,rule);return {rule};});
 });
 app.post<{Params:{id:string};Body:{request_key:string}}>('/api/configuration/number-rules/:id/allocate',{preHandler:requirePermission('master.write'),schema:{params:paramsId,body:{type:'object',additionalProperties:false,required:['request_key'],properties:{request_key:{type:'string',minLength:8,maxLength:80,pattern:'^[A-Za-z0-9_-]+$'}}}}},async(request,reply)=>{
  const result=await tenantWrite(request,async sql=>{
   const rule=(await sql.query<NumberRule>(numberRuleSelect+' WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];if(!rule)throw new Problem(404,'NUMBER_RULE_NOT_FOUND','编号规则不存在');
   const existing=(await sql.query('SELECT id,number,sequence::text AS sequence,period,rule_version,request_key,created_at FROM numbering_allocations WHERE rule_id=$1 AND request_key=$2',[rule.id,request.body.request_key])).rows[0];if(existing)return {allocation:existing,replayed:true};
   if(!rule.active)throw new Problem(422,'NUMBER_RULE_INACTIVE','编号规则已停用');
   const date=serverDate(),datePart=rule.date_pattern==='none'?'':date.slice(0,rule.date_pattern==='yyyy'?4:rule.date_pattern==='yyyyMM'?6:8),period=rule.reset_period==='never'?'all':date.slice(0,rule.reset_period==='year'?4:rule.reset_period==='month'?6:8);
   await sql.query('INSERT INTO numbering_counters(tenant_id,rule_id,period,next_value) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,rule_id,period) DO NOTHING',[actor(request).tenant_id,rule.id,period,rule.start]);
   const counter=(await sql.query<{next:string}>('SELECT next_value::text AS next FROM numbering_counters WHERE rule_id=$1 AND period=$2 FOR UPDATE',[rule.id,period])).rows[0]!;const sequence=BigInt(counter.next)<BigInt(rule.start)?BigInt(rule.start):BigInt(counter.next);
   if(sequence.toString().length>rule.padding)throw new Problem(422,'NUMBER_EXHAUSTED','本周期流水已用完，请增大位数');const number=rule.prefix+datePart+sequence.toString().padStart(rule.padding,'0');
   const table:Record<string,string>={unit:'units',product:'products',process:'processes',route:'process_routes'};
   if(table[rule.entity]&&(await sql.query('SELECT id FROM '+table[rule.entity]+' WHERE code=$1',[number])).rows.length)throw new Problem(409,'NUMBER_ALREADY_USED','生成编号已被资料使用，请调整起始流水');
   const allocation=(await sql.query<{id:string}>('INSERT INTO numbering_allocations(tenant_id,rule_id,entity,request_key,number,sequence,period,rule_version,rule_snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id,number,sequence::text AS sequence,period,rule_version,request_key,created_at',[actor(request).tenant_id,rule.id,rule.entity,request.body.request_key,number,sequence.toString(),period,rule.version,JSON.stringify(rule),actor(request).user_id])).rows[0]!;
   await sql.query('UPDATE numbering_counters SET next_value=$1 WHERE rule_id=$2 AND period=$3',[(sequence+1n).toString(),rule.id,period]);await writeAudit(sql,actor(request),'number.allocated','number_allocation',allocation.id,null,allocation);return {allocation,replayed:false};
  });return reply.code(result.replayed?200:201).send(result);
 });
 app.get('/api/configuration/field-schemas',read,async request=>database.tenant(context(request),async sql=>({items:(await sql.query(schemaSelect+' ORDER BY entity')).rows})));
 app.get<{Querystring:{entity?:string}}>('/api/configuration/field-schemas/current',{...read,schema:{querystring:{type:'object',additionalProperties:false,properties:{entity:{type:'string',enum:['product']}}}}},async request=>database.tenant(context(request),async sql=>{
  const result=await currentSchema(sql);if(result.version&&actor(request).role!=='admin')result.version={...result.version,fields:result.version.fields.filter(f=>f.read_roles.includes(actor(request).role))};return result;
 }));
 app.post<{Body:{entity:'product';fields:unknown}}>('/api/configuration/field-schemas',{...admin,schema:{body:{type:'object',additionalProperties:false,required:['entity','fields'],properties:{entity:{type:'string',enum:['product']},fields:fieldsSchema}}}},async(request,reply)=>{
  const fields=normalizeFields(request.body.fields);const result=await tenantWrite(request,async sql=>{const schema=(await sql.query<FieldSchema>('INSERT INTO extension_schemas(tenant_id,entity) VALUES($1,$2) RETURNING id,entity,active,version,latest_revision,current_version_id,current_revision',[actor(request).tenant_id,request.body.entity])).rows[0]!;const id=(await sql.query<{id:string}>('INSERT INTO extension_schema_versions(tenant_id,schema_id,revision,fields,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id',[actor(request).tenant_id,schema.id,JSON.stringify(fields),actor(request).user_id])).rows[0]!.id;const version=(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[id])).rows[0]!;await writeAudit(sql,actor(request),'field_schema.created','field_schema',schema.id,null,{schema,version});return {schema,version};});return reply.code(201).send(result);
 });
 app.get<{Params:{id:string}}>('/api/configuration/field-schemas/:id',{...admin,schema:{params:paramsId}},async request=>database.tenant(context(request),async sql=>{const schema=(await sql.query<FieldSchema>(schemaSelect+' WHERE id=$1',[request.params.id])).rows[0];if(!schema)throw new Problem(404,'FIELD_SCHEMA_NOT_FOUND','字段方案不存在');return {schema,versions:(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.schema_id=$1 ORDER BY v.revision DESC',[schema.id])).rows};}));
 app.get<{Params:{id:string}}>('/api/configuration/field-versions/:id',{...read,schema:{params:paramsId}},async request=>database.tenant(context(request),async sql=>{const version=(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[request.params.id])).rows[0];if(!version||version.state!=='published')throw new Problem(404,'FIELD_VERSION_NOT_FOUND','已发布字段版本不存在');const current=await currentSchema(sql);const permissionVersion=current.version??(current.schema?.current_version_id?(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[current.schema.current_version_id])).rows[0]:null);return {version:{...version,fields:version.fields.filter(f=>readableField(f,version.fields,actor(request),permissionVersion?.fields))}};}));
 app.post<{Params:{id:string};Body:{expected_version:number;fields:unknown}}>('/api/configuration/field-schemas/:id/versions',{...admin,schema:{params:paramsId,body:{type:'object',additionalProperties:false,required:['expected_version','fields'],properties:{expected_version:versionNumber,fields:fieldsSchema}}}},async(request,reply)=>{
  const fields=normalizeFields(request.body.fields);const result=await tenantWrite(request,async sql=>{const before=(await sql.query<FieldSchema>(schemaSelect+' WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];if(!before)throw new Problem(404,'FIELD_SCHEMA_NOT_FOUND','字段方案不存在');if(before.version!==request.body.expected_version)throw new Problem(409,'VERSION_CONFLICT','字段方案已变化');const id=(await sql.query<{id:string}>('INSERT INTO extension_schema_versions(tenant_id,schema_id,revision,fields,created_by) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id',[actor(request).tenant_id,before.id,before.latest_revision+1,JSON.stringify(fields),actor(request).user_id])).rows[0]!.id;await sql.query('UPDATE extension_schemas SET version=version+1,latest_revision=latest_revision+1,updated_at=now() WHERE id=$1',[before.id]);const schema=(await sql.query<FieldSchema>(schemaSelect+' WHERE id=$1',[before.id])).rows[0]!;const version=(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[id])).rows[0]!;await writeAudit(sql,actor(request),'field_schema.version.created','field_schema',before.id,before,{schema,version});return {schema,version};});return reply.code(201).send(result);
 });
 app.post<{Params:{id:string};Body:{expected_version:number;version_id:string}}>('/api/configuration/field-schemas/:id/publish',{...admin,schema:{params:paramsId,body:{type:'object',additionalProperties:false,required:['expected_version','version_id'],properties:{expected_version:versionNumber,version_id:uuid}}}},async request=>tenantWrite(request,async sql=>{
  const before=(await sql.query<FieldSchema>(schemaSelect+' WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];if(!before)throw new Problem(404,'FIELD_SCHEMA_NOT_FOUND','字段方案不存在');if(before.version!==request.body.expected_version)throw new Problem(409,'VERSION_CONFLICT','字段方案已变化');const version=(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1 AND v.schema_id=$2',[request.body.version_id,before.id])).rows[0];if(!version)throw new Problem(422,'FIELD_VERSION_NOT_FOUND','字段版本不属于此方案');if(version.state!=='draft'||version.revision<=before.current_revision)throw new Problem(409,'FIELD_VERSION_PUBLISHED','只能发布未发布且较新的版本');await sql.query('INSERT INTO extension_schema_publications(tenant_id,version_id,published_by) VALUES($1,$2,$3)',[actor(request).tenant_id,version.id,actor(request).user_id]);await sql.query('UPDATE extension_schemas SET current_version_id=$1,current_revision=$2,version=version+1,updated_at=now() WHERE id=$3',[version.id,version.revision,before.id]);const schema=(await sql.query<FieldSchema>(schemaSelect+' WHERE id=$1',[before.id])).rows[0]!;await writeAudit(sql,actor(request),'field_schema.published','field_schema',before.id,before,{schema,version});return {schema};
 }));
 app.patch<{Params:{id:string};Body:{version:number;active:boolean}}>('/api/configuration/field-schemas/:id',{...admin,schema:{params:paramsId,body:{type:'object',additionalProperties:false,required:['version','active'],properties:{version:versionNumber,active:{type:'boolean'}}}}},async request=>tenantWrite(request,async sql=>{
  const before=(await sql.query<FieldSchema>(schemaSelect+' WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];if(!before)throw new Problem(404,'FIELD_SCHEMA_NOT_FOUND','字段方案不存在');if(before.version!==request.body.version)throw new Problem(409,'VERSION_CONFLICT','字段方案已变化');await sql.query('UPDATE extension_schemas SET active=$1,version=version+1,updated_at=now() WHERE id=$2',[request.body.active,before.id]);const schema=(await sql.query<FieldSchema>(schemaSelect+' WHERE id=$1',[before.id])).rows[0]!;await writeAudit(sql,actor(request),'field_schema.active.changed','field_schema',before.id,before,schema);return {schema};
 }));
 app.get<{Params:{id:string}}>('/api/configuration/product-fields/:id',{...read,schema:{params:paramsId}},async request=>database.tenant(context(request),async sql=>{
  await assertProductScope(sql,actor(request),request.params.id);const rows=(await sql.query<FieldValue>('SELECT id,schema_version_id,revision,values,calculation_details,created_at FROM product_field_values WHERE product_id=$1 ORDER BY revision DESC',[request.params.id])).rows;
  const current=await currentSchema(sql);const permissionVersion=current.version??(current.schema?.current_version_id?(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[current.schema.current_version_id])).rows[0]:null);const items=[];
  for(const row of rows){const snapshot=(await sql.query<FieldVersion>(fieldVersionSelect+' WHERE v.id=$1',[row.schema_version_id])).rows[0]!;const values=permittedValues(snapshot.fields,row.values,actor(request),permissionVersion?.fields);const calculation_details=Object.fromEntries(Object.entries(row.calculation_details).filter(([key])=>Object.hasOwn(values,key)));items.push({...row,values,calculation_details});}return {items};
 }));
 app.post<{Body:{expression:string;variables:FormulaVariable[];values:Record<string,string>;non_negative?:boolean}}>('/api/configuration/formula-preview',{preHandler:requirePermission('master.write'),schema:{body:{type:'object',additionalProperties:false,required:['expression','variables','values'],properties:{expression:{type:'string',minLength:1,maxLength:1000},variables:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',maxLength:32},unit:{type:'string',maxLength:40}}}},values:{type:'object',maxProperties:30,additionalProperties:{type:'string',maxLength:24}},non_negative:{type:'boolean'}}}}},async request=>evaluateFormula(request.body.expression,request.body.variables,request.body.values,{nonNegative:request.body.non_negative!==false}));
 app.get<{Params:{entity:string;surface:string}}>('/api/configuration/views/:entity/:surface',{...read,schema:{params:{type:'object',additionalProperties:false,required:['entity','surface'],properties:{entity:{type:'string',enum:['product']},surface:{type:'string',enum:['pc','mobile']}}}}},async request=>database.tenant(context(request),async sql=>{
  const rows=(await sql.query<View>(viewSelect+" WHERE v.entity=$1 AND v.surface=$2 AND (v.scope='tenant' OR v.user_id=$3)",[request.params.entity,request.params.surface,actor(request).user_id])).rows;const allowed=await allowedViewFields(sql,actor(request));const personal=visibleView(rows.find(v=>v.scope==='personal')??null,allowed),tenant=visibleView(rows.find(v=>v.scope==='tenant')??null,allowed);return {personal,tenant,effective:personal??tenant};
 }));
 app.put<{Params:{entity:string;surface:string};Body:ViewConfiguration&{scope:'tenant'|'personal';expected_version:number}}>('/api/configuration/views/:entity/:surface',{...read,schema:{params:{type:'object',additionalProperties:false,required:['entity','surface'],properties:{entity:{type:'string',enum:['product']},surface:{type:'string',enum:['pc','mobile']}}},body:{type:'object',additionalProperties:false,required:['scope','expected_version','columns','frozen_count','sort','card_fields'],properties:viewProperties}}},async request=>tenantWrite(request,async sql=>{
  const b=request.body;if(b.scope==='tenant'&&!actor(request).permissions.includes('configuration.manage'))throw new Problem(403,'FORBIDDEN','只有管理员可以修改企业默认视图');const configuration={columns:b.columns,frozen_count:b.frozen_count,sort:b.sort,card_fields:b.card_fields};await checkView(sql,actor(request),configuration);const view=await saveView(sql,actor(request),{scope:b.scope,userId:b.scope==='personal'?actor(request).user_id:null,entity:request.params.entity,surface:request.params.surface,expectedVersion:b.expected_version,configuration,source:'manual'});return {view};
 }));
 app.post<{Body:{view_id:string;target_user_ids:string[];strategy:'fill_missing'|'replace'}}>('/api/configuration/views/apply',{...admin,schema:{body:{type:'object',additionalProperties:false,required:['view_id','target_user_ids','strategy'],properties:{view_id:uuid,target_user_ids:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:uuid},strategy:{type:'string',enum:['fill_missing','replace']}}}}},async request=>tenantWrite(request,async sql=>{
  const source=(await sql.query<View>(viewSelect+' WHERE v.id=$1',[request.body.view_id])).rows[0];if(!source)throw new Problem(404,'VIEW_NOT_FOUND','来源视图不存在');const applied:string[]=[],skipped:string[]=[];
  for(const id of [...request.body.target_user_ids].sort()){
   const member=(await sql.query<{id:string;role:Role}>('SELECT id,role FROM tenant_team_members WHERE id=$1',[id])).rows[0];if(!member)throw new Problem(422,'VIEW_TARGET','应用范围包含无效或非本企业成员');
   const targetActor={...actor(request),user_id:id,role:member.role};const allowed=await allowedViewFields(sql,targetActor),configuration=visibleView(source,allowed)!.configuration;
   if(configuration.columns.length===0||configuration.card_fields.length===0)throw new Problem(422,'VIEW_TARGET_FIELDS','目标成员没有来源视图中任何可见字段');
   const before=(await sql.query<View>(viewSelect+" WHERE v.entity=$1 AND v.surface=$2 AND v.scope='personal' AND v.user_id=$3 FOR UPDATE OF v",[source.entity,source.surface,id])).rows[0];if(before&&request.body.strategy==='fill_missing'){skipped.push(id);continue;}
   await saveView(sql,actor(request),{scope:'personal',userId:id,entity:source.entity,surface:source.surface,expectedVersion:before?.version??0,configuration,source:'admin_apply'});applied.push(id);
  }return {applied,skipped,strategy:request.body.strategy};
 }));
 app.get<{Params:{id:string}}>('/api/configuration/views/:id/history',{...read,schema:{params:paramsId}},async request=>database.tenant(context(request),async sql=>{
  const view=(await sql.query<View>(viewSelect+' WHERE v.id=$1',[request.params.id])).rows[0];if(!view)throw new Problem(404,'VIEW_NOT_FOUND','视图不存在');if(!actor(request).permissions.includes('configuration.manage')&&view.user_id!==actor(request).user_id&&view.scope!=='tenant')throw new Problem(403,'FORBIDDEN','无权查看他人的视图历史');const allowed=await allowedViewFields(sql,actor(request));const items=(await sql.query<{id:string;revision:number;configuration:ViewConfiguration}>('SELECT id,revision,configuration,source,created_at FROM user_view_history WHERE view_id=$1 ORDER BY revision DESC',[view.id])).rows.map(item=>({...item,configuration:visibleView({...view,configuration:item.configuration},allowed)!.configuration}));return {items};
 }));
 app.post<{Params:{id:string};Body:{expected_version:number;history_id:string}}>('/api/configuration/views/:id/restore',{...read,schema:{params:paramsId,body:{type:'object',additionalProperties:false,required:['expected_version','history_id'],properties:{expected_version:versionNumber,history_id:uuid}}}},async request=>tenantWrite(request,async sql=>{
  const view=(await sql.query<View>(viewSelect+' WHERE v.id=$1 FOR UPDATE OF v',[request.params.id])).rows[0];if(!view)throw new Problem(404,'VIEW_NOT_FOUND','视图不存在');if(!actor(request).permissions.includes('configuration.manage')&&(view.scope==='tenant'||view.user_id!==actor(request).user_id))throw new Problem(403,'FORBIDDEN','无权恢复此视图');const history=(await sql.query<{configuration:ViewConfiguration}>('SELECT configuration FROM user_view_history WHERE id=$1 AND view_id=$2',[request.body.history_id,view.id])).rows[0];if(!history)throw new Problem(422,'VIEW_HISTORY','历史配置不属于此视图');const allowed=await allowedViewFields(sql,actor(request)),configuration=visibleView({...view,configuration:history.configuration},allowed)!.configuration;await checkView(sql,actor(request),configuration);const restored=await saveView(sql,actor(request),{scope:view.scope,userId:view.user_id,entity:view.entity,surface:view.surface,expectedVersion:request.body.expected_version,configuration,source:'restore'});return {view:restored};
 }));
}
