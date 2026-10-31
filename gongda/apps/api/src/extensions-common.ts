import type {FastifyInstance} from 'fastify';
import type {Sql} from './database.js';
import {Problem,requireAllScope,writeAudit,type Actor,type Services} from './services.js';
import {gateTenantWrite} from './assets.js';
import {digest,replay,finish,idParams,versionField,keyField,reasonField,shape,permit} from './business-common.js';
export type ExtensionRecord=Record<string,unknown>&{id:string;version:number};
export const actionShape=(actions:string[],extra:Record<string,unknown>={})=>shape(['action','version','request_key'],{action:{type:'string',enum:actions},version:versionField,request_key:keyField,reason:reasonField,...extra});
export function stateConflict(){return new Problem(409,'STATE_TRANSITION','当前状态不能执行该操作');}
export async function lockRow(sql:Sql,table:string,id:string,version:number){const row=(await sql.query<ExtensionRecord>('SELECT * FROM '+table+' WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new Problem(404,'NOT_FOUND','记录不存在或不属于当前企业');if(row.version!==version)throw new Problem(409,'VERSION_CONFLICT','记录已改变，请刷新后重试');return row;}
export async function businessZone(sql:Sql){return (await sql.query<{timezone:string}>('SELECT timezone FROM business_settings')).rows[0]?.timezone??'Asia/Shanghai';}
export function extensionRoutes(app:FastifyInstance,s:Services){
 const guard=s.authorize();
 function get(path:string,permission:string,fn:(sql:Sql,a:Actor,id:string,q:Record<string,string>)=>Promise<unknown>,querySchema?:unknown){app.get<{Params:{id?:string};Querystring:Record<string,string>}>(path,{preHandler:guard,schema:{...(path.includes(':id')?{params:idParams}:{}),...(querySchema?{querystring:querySchema}:{})}},r=>s.database.tenant(s.context(r),async sql=>{const a=s.actor(r);permit(a,permission);requireAllScope(a);return fn(sql,a,r.params.id??'',r.query);}));}
 function post<T extends {request_key:string}>(path:string,permission:string,schema:unknown,resource:string,command:string,view:(sql:Sql,id:string,a:Actor)=>Promise<unknown>,fn:(sql:Sql,a:Actor,b:T,id:string)=>Promise<string>,creation=true){
  app.post<{Body:T;Params:{id?:string}}>(path,{preHandler:guard,schema:{body:schema,...(path.includes(':id')?{params:idParams}:{})}},async(r,reply)=>s.database.tenant(s.context(r),async sql=>{
   const a=s.actor(r);permit(a,permission);requireAllScope(a);await gateTenantWrite(sql,s.context(r));const b=r.body as T,hash=digest({id:r.params.id??null,body:b});const prior=await replay(sql,command,b.request_key,hash);if(prior)return reply.code(200).send({replayed:true,[resource]:await view(sql,prior,a)});
   const before=r.params.id?await view(sql,r.params.id,a):null;const id=await fn(sql,a,b,r.params.id??'');const after=await view(sql,id,a);await finish(sql,a,command,b.request_key,hash,resource,id);await writeAudit(sql,a,command,resource,id,before,after);return reply.code(creation?201:200).send({replayed:false,[resource]:after});
  }));
 }
 return {get,post};
}
