import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql, TenantContext } from './database.js';
import { Problem, writeAudit, assertProductScope, requireAllScope, type Actor, type Services } from './services.js';

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMITS = { state:'active', expires_at:null, seat_limit:100, product_limit:10000, storage_limit_bytes:100*1024*1024, storage_used_bytes:0, version:0 };
type LimitRow = {tenant_id:string;state:'active'|'read_only'|'expired';expires_at:string|null;seat_limit:number;product_limit:number;storage_limit_bytes:string|number;storage_used_bytes:string|number;version:number;updated_at?:string};
type Resource = 'product'|'process';
type Attachment = {id:string;tenant_id:string;product_id:string|null;process_id:string|null;filename:string;mime:string;byte_size:number;sha256:string;request_key:string;active:boolean;deleted_at:string|null;version:number;created_at:string;updated_at:string};
const uuid = { type:'string',format:'uuid' };
const idParams = {type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}};
const attachmentSelect = 'SELECT id,tenant_id,product_id,process_id,filename,mime,byte_size,sha256,request_key,active,deleted_at,version,created_at,updated_at FROM attachments';
const publicAttachment = (a:Attachment) => ({id:a.id,resource_type:a.product_id?'product':'process',resource_id:a.product_id??a.process_id,filename:a.filename,mime:a.mime,byte_size:a.byte_size,sha256:a.sha256,active:a.active,deleted_at:a.deleted_at,version:a.version,created_at:a.created_at,updated_at:a.updated_at});
const effectiveState = (row:Pick<LimitRow,'state'|'expires_at'>) => row.state==='expired'||(row.expires_at&&new Date(row.expires_at).getTime()<=Date.now())?'expired':row.state;

async function readLimits(sql:Sql,context:TenantContext,lock=false):Promise<LimitRow> {
  if(lock)await sql.query('INSERT INTO tenant_service_limits(tenant_id) VALUES($1) ON CONFLICT(tenant_id) DO NOTHING',[context.tenantId]);
  const row=(await sql.query<LimitRow>('SELECT * FROM tenant_service_limits WHERE tenant_id=$1'+(lock?' FOR UPDATE':''),[context.tenantId])).rows[0];
  return row??{tenant_id:context.tenantId,...DEFAULT_LIMITS} as LimitRow;
}
async function resourceCounts(sql:Sql) {
  const count=(await sql.query<{seat_used:string;product_used:string}>('SELECT (SELECT count(*) FROM tenant_team_members)::text AS seat_used,(SELECT count(*) FROM products)::text AS product_used')).rows[0]!;
  return {seat_used:Number(count.seat_used),product_used:Number(count.product_used)};
}
function rejectReadonly(row:LimitRow) {
  const state=effectiveState(row);
  if(state==='expired')throw new Problem(403,'SERVICE_EXPIRED','企业服务已到期，现有资料仍可读取；请联系服务管理员');
  if(state==='read_only')throw new Problem(403,'SERVICE_READ_ONLY','企业服务当前为只读，不能修改资料');
}
/** Call within the SAME tenant transaction before business mutation. FOR UPDATE serializes quota checks. */
export async function gateTenantWrite(sql:Sql,context:TenantContext,resource?:'products'|'seats') {
  const row=await readLimits(sql,context,true);
  rejectReadonly(row);
  if(resource){
    const counts=await resourceCounts(sql);
    if(resource==='products'&&counts.product_used>=row.product_limit)throw new Problem(409,'PRODUCT_QUOTA_EXCEEDED','产品数量已达本企业服务配额');
    if(resource==='seats'&&counts.seat_used>=row.seat_limit)throw new Problem(409,'SEAT_QUOTA_EXCEEDED','启用成员数量已达本企业席位配额');
  }
  return row;
}
async function validateResource(sql:Sql,actor:Actor,type:Resource,id:string,write=false) {
  if(type==='product')await assertProductScope(sql,actor,id);
  else if(actor.data_scope!=='all')throw new Problem(403,'RESOURCE_SCOPE_UNSUPPORTED','工序附件当前仅支持全部资料范围授权');
  const table=type==='product'?'products':'processes';
  const row=(await sql.query<{id:string}>('SELECT id FROM '+table+' WHERE id=$1'+(write?' AND active FOR KEY SHARE':''),[id])).rows[0];
  if(!row)throw new Problem(404,'ATTACHMENT_RESOURCE_NOT_FOUND','关联资料不存在或不可访问');
}
function decodeContent(base64:string,mime:string) {
  const paddingAt=base64.indexOf('=');
  if(!base64||base64.length>Math.ceil(MAX_ATTACHMENT_BYTES/3)*4||base64.length%4!==0||/[^A-Za-z0-9+/=]/.test(base64)||(paddingAt>=0&&(paddingAt<base64.length-2||!/^={1,2}$/.test(base64.slice(paddingAt)))))throw new Problem(400,'INVALID_ATTACHMENT_ENCODING','附件必须使用完整且规范的Base64编码');
  const bytes=Buffer.from(base64,'base64');
  if(bytes.length===0||bytes.length>MAX_ATTACHMENT_BYTES)throw new Problem(413,'ATTACHMENT_TOO_LARGE','附件内容必须在1字节至2MiB之间');
  if(bytes.toString('base64')!==base64)throw new Problem(400,'INVALID_ATTACHMENT_ENCODING','附件Base64编码不规范');
  let valid=false;
  if(mime==='image/png')valid=bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0&&BigInt(bytes.readUInt32BE(16))*BigInt(bytes.readUInt32BE(20))<=20000000n;
  if(mime==='image/jpeg')valid=bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217;
  if(mime==='application/pdf')valid=bytes.length>=12&&/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(bytes.toString('ascii',0,8))&&bytes.subarray(Math.max(0,bytes.length-1024)).includes(Buffer.from('%%EOF'));
  if(mime==='text/plain'){
    try{const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);valid=!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);}catch{valid=false;}
  }
  if(!valid)throw new Problem(422,'ATTACHMENT_TYPE_MISMATCH','附件内容与所选类型不匹配，或内容格式不安全');
  return bytes;
}
function validateFilename(filename:string){
 if(!filename.trim()||filename!==filename.trim()||/[\\/\u0000-\u001f\u007f]/.test(filename)||filename==='.'||filename==='..')throw new Problem(400,'INVALID_ATTACHMENT_FILENAME','附件名称不能包含路径、控制字符或首尾空格');
}
async function quotaView(sql:Sql,context:TenantContext,configurationAllowed:boolean){
 const row=await readLimits(sql,context);const counts=await resourceCounts(sql);
 return {...row,storage_limit_bytes:Number(row.storage_limit_bytes),storage_used_bytes:Number(row.storage_used_bytes),...counts,effective_state:effectiveState(row),configuration_allowed:configurationAllowed,storage_backend:'database',maximum_attachment_bytes:MAX_ATTACHMENT_BYTES,retained_deleted_bytes:true};
}
export function registerAssets(app:FastifyInstance,services:Services,options:{allowServiceConfiguration?:boolean}={}) {
 const {database,authorize,requirePermission,context,actor}=services;
 const configurationAllowed=options.allowServiceConfiguration===true;
 app.get('/api/tenant-service',{preHandler:authorize()},async request=>database.tenant(context(request),async sql=>{requireAllScope(actor(request));return {service:await quotaView(sql,context(request),configurationAllowed&&actor(request).role==='admin'&&actor(request).permissions.includes('tenant_service.manage'))};}));
 app.patch<{Body:{version:number;state:LimitRow['state'];expires_at:string|null;seat_limit:number;product_limit:number;storage_limit_bytes:number}}>('/api/tenant-service',{
  preHandler:[authorize(['admin']),requirePermission('tenant_service.manage')],schema:{body:{type:'object',additionalProperties:false,required:['version','state','expires_at','seat_limit','product_limit','storage_limit_bytes'],properties:{version:{type:'integer',minimum:0},state:{type:'string',enum:['active','read_only','expired']},expires_at:{anyOf:[{type:'string',format:'date-time'},{type:'null'}]},seat_limit:{type:'integer',minimum:1,maximum:100000},product_limit:{type:'integer',minimum:0,maximum:10000000},storage_limit_bytes:{type:'integer',minimum:0,maximum:1099511627776}}}}
 },async request=>{
  if(!configurationAllowed)throw new Problem(403,'SERVICE_CONFIGURATION_DISABLED','生产服务参数须由平台运营端设置，本企业不能自行修改套餐');
  return database.tenant(context(request),async sql=>{
   const before=await readLimits(sql,context(request),true);const b=request.body;
   // A missing configuration is exposed as version 0; its first write creates the standard row.
   const expected=b.version===0?1:b.version;
   if(before.version!==expected)throw new Problem(409,'VERSION_CONFLICT','服务参数已变化，请刷新后重试');
   await sql.query('UPDATE tenant_service_limits SET state=$1,expires_at=$2,seat_limit=$3,product_limit=$4,storage_limit_bytes=$5,version=version+1,updated_at=now() WHERE tenant_id=$6',[b.state,b.expires_at,b.seat_limit,b.product_limit,b.storage_limit_bytes,context(request).tenantId]);
   const service=await quotaView(sql,context(request),true);
   await writeAudit(sql,actor(request),'tenant_service.updated','tenant_service',context(request).tenantId,before,service);
   return {service};
  });
 });
 app.get<{Querystring:{resource_type:Resource;resource_id:string;include_deleted?:string}}>('/api/attachments',{
  preHandler:requirePermission('attachments.read'),schema:{querystring:{type:'object',additionalProperties:false,required:['resource_type','resource_id'],properties:{resource_type:{type:'string',enum:['product','process']},resource_id:uuid,include_deleted:{type:'string',enum:['true','false']}}}}
 },async request=>database.tenant(context(request),async sql=>{
  const q=request.query;await validateResource(sql,actor(request),q.resource_type,q.resource_id);
  const column=q.resource_type==='product'?'product_id':'process_id';
  const where=' WHERE '+column+'=$1'+(q.include_deleted==='true'?'':' AND deleted_at IS NULL');
  const total=Number((await sql.query<{total:string}>('SELECT count(*)::text AS total FROM attachments'+where,[q.resource_id])).rows[0]!.total);
  const rows=(await sql.query<Attachment>(attachmentSelect+where+' ORDER BY created_at DESC,id LIMIT 200',[q.resource_id])).rows;
  return {items:rows.map(publicAttachment),total,limit:200};
 }));
 app.post<{Body:{resource_type:Resource;resource_id:string;filename:string;mime:string;content_base64:string;request_key:string}}>('/api/attachments',{
  bodyLimit:3*1024*1024,preHandler:requirePermission('attachments.write'),schema:{body:{type:'object',additionalProperties:false,required:['resource_type','resource_id','filename','mime','content_base64','request_key'],properties:{resource_type:{type:'string',enum:['product','process']},resource_id:uuid,filename:{type:'string',minLength:1,maxLength:200},mime:{type:'string',enum:['image/png','image/jpeg','application/pdf','text/plain']},content_base64:{type:'string',minLength:1,maxLength:Math.ceil(MAX_ATTACHMENT_BYTES/3)*4},request_key:uuid}}}
 },async(request,reply)=>{
  const b=request.body;validateFilename(b.filename);const bytes=decodeContent(b.content_base64,b.mime);const sha256=createHash('sha256').update(bytes).digest('hex');
  const result=await database.tenant(context(request),async sql=>{
   const limits=await readLimits(sql,context(request),true);
   const existing=(await sql.query<Attachment>(attachmentSelect+' WHERE request_key=$1',[b.request_key])).rows[0];
   if(existing){
    await validateResource(sql,actor(request),b.resource_type,b.resource_id);
    if(existing.sha256!==sha256||existing.mime!==b.mime||existing.filename!==b.filename||(existing.product_id??existing.process_id)!==b.resource_id.toLowerCase()||(existing.product_id?'product':'process')!==b.resource_type)throw new Problem(409,'IDEMPOTENCY_CONFLICT','该请求标识已用于另一份附件，请更换请求标识');
    return {attachment:publicAttachment(existing),replayed:true};
   }
   rejectReadonly(limits);await validateResource(sql,actor(request),b.resource_type,b.resource_id,true);
   if(BigInt(limits.storage_used_bytes)+BigInt(bytes.length)>BigInt(limits.storage_limit_bytes))throw new Problem(409,'STORAGE_QUOTA_EXCEEDED','附件存储量已达本企业服务配额；停用和软删除的文件仍保留占用');
   const inserted=(await sql.query<{id:string}>('INSERT INTO attachments(tenant_id,product_id,process_id,filename,mime,byte_size,sha256,payload,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[context(request).tenantId,b.resource_type==='product'?b.resource_id:null,b.resource_type==='process'?b.resource_id:null,b.filename,b.mime,bytes.length,sha256,bytes,b.request_key])).rows[0]!;
   await sql.query('UPDATE tenant_service_limits SET storage_used_bytes=storage_used_bytes+$1,updated_at=now() WHERE tenant_id=$2',[bytes.length,context(request).tenantId]);
   const a=(await sql.query<Attachment>(attachmentSelect+' WHERE id=$1',[inserted.id])).rows[0]!;
   await writeAudit(sql,actor(request),'attachment.created','attachment',a.id,null,publicAttachment(a));
   return {attachment:publicAttachment(a),replayed:false};
  });
  return reply.code(result.replayed?200:201).send(result);
 });
 app.get<{Params:{id:string}}>('/api/attachments/:id/content',{preHandler:requirePermission('attachments.read'),schema:{params:idParams}},async(request,reply)=>{
  const result=await database.tenant(context(request),async sql=>{
   const row=(await sql.query<Attachment>(attachmentSelect+' WHERE id=$1',[request.params.id])).rows[0];
   if(!row)throw new Problem(404,'ATTACHMENT_NOT_FOUND','附件不存在或不可访问');
   await validateResource(sql,actor(request),row.product_id?'product':'process',(row.product_id??row.process_id)!);
   if(!row.active||row.deleted_at)throw new Problem(410,'ATTACHMENT_UNAVAILABLE','附件已停用或删除，保留记录不能直接下载');
   const content=(await sql.query<{payload:Uint8Array}>('SELECT payload FROM attachments WHERE id=$1 AND active AND deleted_at IS NULL',[row.id])).rows[0];
   if(!content)throw new Problem(410,'ATTACHMENT_UNAVAILABLE','附件已停用或删除，不能直接下载');
   return {...row,payload:content.payload};
  });
  const extension:Record<string,string>={'image/png':'png','image/jpeg':'jpg','application/pdf':'pdf','text/plain':'txt'};
  reply.header('Content-Type',result.mime).header('Content-Disposition',`attachment; filename="download.${extension[result.mime]}"; filename*=UTF-8''${encodeURIComponent(result.filename).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())}`).header('Content-Length',result.byte_size).header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store');
  return reply.send(Buffer.from(result.payload));
 });
 async function change(sql:Sql,request:FastifyRequest<{Params:{id:string};Body:{version:number;active?:boolean}}>,deleted:boolean){
  await gateTenantWrite(sql,context(request));
  const before=(await sql.query<Attachment>(attachmentSelect+' WHERE id=$1 FOR UPDATE',[request.params.id])).rows[0];
  if(!before)throw new Problem(404,'ATTACHMENT_NOT_FOUND','附件不存在或不可访问');
  if(before.deleted_at)throw new Problem(410,'ATTACHMENT_UNAVAILABLE','已删除的附件不能修改或重新启用');
  await validateResource(sql,actor(request),before.product_id?'product':'process',(before.product_id??before.process_id)!);
  if(before.version!==request.body.version)throw new Problem(409,'VERSION_CONFLICT','附件状态已被修改，请刷新后重试');
  await sql.query('UPDATE attachments SET active=$1,deleted_at=CASE WHEN $2 THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$3',[deleted?false:request.body.active,deleted,request.params.id]);
  const after=(await sql.query<Attachment>(attachmentSelect+' WHERE id=$1',[request.params.id])).rows[0]!;
  await writeAudit(sql,actor(request),deleted?'attachment.deleted':'attachment.updated','attachment',before.id,publicAttachment(before),publicAttachment(after));
  return {attachment:publicAttachment(after)};
 }
 app.patch<{Params:{id:string};Body:{version:number;active:boolean}}>('/api/attachments/:id',{
  preHandler:requirePermission('attachments.write'),schema:{params:idParams,body:{type:'object',additionalProperties:false,required:['version','active'],properties:{version:{type:'integer',minimum:1},active:{type:'boolean'}}}}
 },async request=>database.tenant(context(request),sql=>change(sql,request,false)));
 app.delete<{Params:{id:string};Body:{version:number}}>('/api/attachments/:id',{
  preHandler:requirePermission('attachments.write'),schema:{params:idParams,body:{type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}}}
 },async request=>database.tenant(context(request),sql=>change(sql,request,true)));
}






