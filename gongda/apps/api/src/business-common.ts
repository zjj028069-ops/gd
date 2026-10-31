import { createHash } from 'node:crypto';
import type { Sql } from './database.js';
import { decimal, formatDecimal, SCALE } from './decimal.js';
import { Problem, type Actor } from './services.js';
export const uuid = { type:'string',format:'uuid' };
export const qtyField = {type:'string',pattern:'^(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,6})?$'};
export const rateField = {type:'string',pattern:'^(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,7})?$'};
export const cashField = {type:'string',pattern:'^(?:0|[1-9]\\d{0,17})(?:\\.\\d{1,2})?$'};
export const keyField = {type:'string',minLength:8,maxLength:80,pattern:'^[A-Za-z0-9_.-]+$'};
export const versionField = {type:'integer',minimum:1};
export const reasonField = {type:'string',minLength:1,maxLength:500};
export const dateField = {type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'};
export const shortText = (max=200) => ({type:'string',minLength:1,maxLength:max,pattern:'^\\S(?:.*\\S)?$'});
export const shape=(required:string[],properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required,properties});
export const idParams=shape(['id'],{id:uuid});
export const qty=(value:string)=>decimal(value);
export {formatDecimal,SCALE};
export const permit=(a:Actor,p:string)=>{if(!a.permissions.includes(p))throw new Problem(403,'FORBIDDEN','当前角色没有操作权限');};
export function reason(value:string|undefined){const r=value?.trim();if(!r)throw new Problem(422,'REASON_REQUIRED','此操作必须填写原因');return r;}
function canonical(value:unknown):unknown{if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return value;}
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function rate(value:string){if(!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,7})?$/.test(value))throw new Problem(400,'RATE_FORMAT','单价须为非负十进制，最多7位小数');const [w,f='']=value.split('.');return BigInt(w!)*10_000_000n+BigInt(f.padEnd(7,'0'));}
export function cents(value:string){if(!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(value))throw new Problem(400,'MONEY_FORMAT','金额须为非负十进制，最多2位小数');const [w,f='']=value.split('.');return BigInt(w!)*100n+BigInt(f.padEnd(2,'0'));}
export function money(value:bigint|null){if(value===null)return null;const sign=value<0n?'-':'';const n=value<0n?-value:value;return sign+(n/100n)+'.'+(n%100n).toString().padStart(2,'0');}
export function round(n:bigint,d:bigint):bigint{if(d<=0n)throw new Problem(422,'ZERO_DENOMINATOR','计算分母须大于零');return n<0n?-round(-n,d):(n+d/2n)/d;}
export const lineCents=(quantity:bigint,price:string)=>round(quantity*rate(price),100_000_000_000n);
export function calendarDate(value:string){const [y,m,d]=value.split('-').map(Number),v=new Date(Date.UTC(y!,m!-1,d));if(v.getUTCFullYear()!==y||v.getUTCMonth()!==m!-1||v.getUTCDate()!==d)throw new Problem(422,'INVALID_DATE','日期不是有效公历日期');return value;}
export async function nextCode(sql:Sql,a:Actor,type:string){
 await sql.query('INSERT INTO document_counters(tenant_id,doc_type,next_value) VALUES($1,$2,1) ON CONFLICT(tenant_id,doc_type) DO NOTHING',[a.tenant_id,type]);
 const n=BigInt((await sql.query<{n:string}>('SELECT next_value::text AS n FROM document_counters WHERE doc_type=$1 FOR UPDATE',[type])).rows[0]!.n);
 await sql.query('UPDATE document_counters SET next_value=$1 WHERE doc_type=$2',[(n+1n).toString(),type]);return type+n.toString().padStart(6,'0');
}
export async function replay(sql:Sql,command:string,key:string,hash:string){const r=(await sql.query<{resource_id:string;payload_hash:string}>('SELECT resource_id,payload_hash FROM command_replays WHERE command=$1 AND request_key=$2',[command,key])).rows[0];if(r&&r.payload_hash!==hash)throw new Problem(409,'REQUEST_KEY_CONFLICT','同一请求标识不能用于不同内容');return r?.resource_id;}
export async function finish(sql:Sql,a:Actor,command:string,key:string,hash:string,type:string,id:string){await sql.query('INSERT INTO command_replays(tenant_id,command,request_key,payload_hash,resource_type,resource_id) VALUES($1,$2,$3,$4,$5,$6)',[a.tenant_id,command,key,hash,type,id]);}
export async function product(sql:Sql,id:string){const p=(await sql.query<{id:string;code:string;name:string;unit_id:string;unit_name:string}>('SELECT p.id,p.code,p.name,p.unit_id,u.name AS unit_name FROM products p JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id WHERE p.id=$1 AND p.active AND u.active',[id])).rows[0];if(!p)throw new Problem(422,'INVALID_REFERENCE','产品不存在、停用或不属于当前企业');return p;}
export async function warehouse(sql:Sql,id:string){if(!(await sql.query('SELECT id FROM warehouses WHERE id=$1 AND active',[id])).rows[0])throw new Problem(422,'INVALID_REFERENCE','仓库不存在、停用或不属于当前企业');}
