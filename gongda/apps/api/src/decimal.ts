import { Problem } from './services.js';
export const SCALE=1_000_000n;
export const MAX=99_999_999_999_999_999_999n;
export function decimal(value:string,{positive=false,max=MAX,label='数量',field}:{positive?:boolean;max?:bigint;label?:string;field?:string}={}){
 if(typeof value!=='string'||!String(value).trim()) throw new Problem(400,'DECIMAL_FORMAT',`请填写${label}`,field);
 if(!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(value)) throw new Problem(400,'DECIMAL_FORMAT',`${label}最多 6 位小数`,field);
 const [whole,fraction='']=value.split('.');const n=BigInt(whole!)*SCALE+BigInt(fraction.padEnd(6,'0'));
 if(n>max||(positive&&n===0n)) throw new Problem(422,'DECIMAL_RANGE',`${label}超出允许范围`,field);
 return n;
}
export function formatDecimal(n:bigint){const sign=n<0n?'-':'',v=n<0n?-n:n;return `${sign}${v/SCALE}.${(v%SCALE).toString().padStart(6,'0')}`;}
export function multiplyUp(a:bigint,b:bigint){return (a*b+SCALE-1n)/SCALE;}
export function divideUp(a:bigint,b:bigint){return (a*SCALE+b-1n)/b;}
export function bounded(n:bigint){if(n>MAX)throw new Problem(422,'QUANTITY_OVERFLOW','展开结果超过数量上限');return n;}
