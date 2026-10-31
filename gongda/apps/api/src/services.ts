import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Database, Sql, TenantContext } from './database.js';
export type Role = 'admin'|'planner'|'worker';
export type DataScope = 'all'|'department'|'self';
export type PointScope = 'self'|'team'|'all';
export type Actor = {tenant_id:string;user_id:string;display_name:string;role:Role;permissions:string[];data_scope:DataScope;department_id:string|null;points:string[]|null;point_scopes:Record<string,PointScope>;team_user_ids:string[]};
export const permissionCatalog = [
 ['master.read','读取主数据'],['master.write','维护主数据'],['audit.read','读取企业审计'],
 ['organization.manage','管理组织、成员和角色'],['configuration.read','读取配置'],['configuration.manage','管理编号、字段和视图配置'],
 ['attachments.read','读取附件'],['attachments.write','上传和停用附件'],['tenant_service.manage','管理本机服务配额'],
 ['sales.read','读取销售订单'],['sales.write','维护销售订单'],['sales.approve','审核销售订单'],
 ['production.read','读取工单与报工'],['production.write','下达和执行工单'],['production.approve','审核报工与代报'],['production.report','提交生产报工'],
 ['inventory.read','读取库存'],['inventory.write','开立库存单据'],['inventory.approve','审核并过账库存'],
 ['procurement.read','读取采购'],['procurement.write','开立采购与收货'],['procurement.approve','审核采购收货'],
 ['planning.read','读取算料'],['planning.write','算料与预占'],
 ['payroll.read','读取工资'],['payroll.manage','维护工价规则'],['payroll.approve','结算工资'],
 ['finance.read','读取成本与往来'],['finance.write','开立收付款'],['finance.approve','审核收付款'],
 ['quality.read','读取检验'],['quality.write','提交检验放行'],['quality.view','查看质检'],['outsource.view','查看外协'],['machine.view','查看机台'],
] as const;
const workerPermissions = ['master.read','configuration.read','attachments.read','production.read','production.report'];
export function defaultPermissions(role:Role):string[]{return permissionCatalog.map(p=>p[0]).filter(p=>role==='admin'||(role==='planner'?!['organization.manage','configuration.manage','tenant_service.manage'].includes(p):workerPermissions.includes(p)));}
export class Problem extends Error {
 constructor(readonly status:number,readonly code:string,message:string,readonly field?:string){super(message);}
}
export type Services = {
 database:Database;
 authorize:(roles?:Role[])=>preHandlerHookHandler;
 requirePermission:(permission:string)=>preHandlerHookHandler;
 context:(request:FastifyRequest)=>TenantContext;
 actor:(request:FastifyRequest)=>Actor;
};
export function requireAllScope(actor:Actor){if(actor.data_scope!=='all')throw new Problem(403,'DATA_SCOPE_UNSUPPORTED','当前功能需要全企业数据范围；部门或本人范围当前只接入产品及其附件');}
export function can(actor:Actor,point:string){return actor.points===null||actor.points.includes(point);}
export function scopeClause(actor:Actor,point:string,column:string,start=1){if(actor.points===null||(actor.point_scopes[point]??'all')==='all')return {clause:'true',params:[] as unknown[]};const scope=actor.point_scopes[point];if(scope==='self')return {clause:`${column}=$${start}`,params:[actor.user_id]};return {clause:`${column} = ANY($${start}::uuid[])`,params:[actor.team_user_ids]};}
export function productScope(actor:Actor,alias='p',start=1):{clause:string;params:unknown[]}{
 if(actor.data_scope==='all')return {clause:'true',params:[]};
 if(actor.data_scope==='self')return {clause:`${alias}.created_by_id=$${start}`,params:[actor.user_id]};
 return {clause:`${alias}.department_id=$${start} AND $${start}::uuid IS NOT NULL`,params:[actor.department_id]};
}
export async function assertProductScope(sql:Sql,actor:Actor,id:string){if(!actor.permissions.includes('master.read'))throw new Problem(403,'FORBIDDEN','当前角色不能读取产品资料');const scope=productScope(actor,'p',2);const row=(await sql.query('SELECT p.id FROM products p WHERE p.id=$1 AND '+scope.clause,[id,...scope.params])).rows[0];if(!row)throw new Problem(404,'PRODUCT_NOT_FOUND','产品不存在或不可访问');}
export async function writeAudit(sql:Sql,actor:Actor,action:string,entityType:string,id:string,before:unknown,after:unknown){
 if(entityType==='production_report'){const redact=(v:unknown)=>{if(!v||typeof v!=='object')return v;const {wage_snapshot,estimated_wage,...safe}=v as Record<string,unknown>;return safe;};before=redact(before);after=redact(after);}
 await sql.query('INSERT INTO audit_events(tenant_id,actor_id,actor_name,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',[actor.tenant_id,actor.user_id,actor.display_name,action,entityType,id,before==null?null:JSON.stringify(before),after==null?null:JSON.stringify(after)]);
}
