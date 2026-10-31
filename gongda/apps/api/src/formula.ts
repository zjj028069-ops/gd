import { Problem } from './services.js';

export const FORMULA_ENGINE_VERSION = 'decimal-rational-v1';
export type FormulaVariable = { name:string; unit?:string };
export type FormulaAst = { type:'number'; value:string } | { type:'variable'; name:string } | { type:'unary'; op:'+'|'-'; value:FormulaAst } | { type:'binary'; op:'+'|'-'|'*'|'/'; left:FormulaAst; right:FormulaAst } | { type:'call'; name:'abs'|'min'|'max'|'round'; args:FormulaAst[] };
type Fraction = { n:bigint; d:bigint };
const MAX_ABS=99_999_999_999_999_999_999n, SCALE=1_000_000n;
function fail(code:string,message:string):never {throw new Problem(422,code,message);}
const identifier=/^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const reserved=new Set(['constructor','prototype','__proto__','eval','Function','window','globalThis','process','require']);
function gcd(a:bigint,b:bigint):bigint { a=a<0n?-a:a; while(b){const next=a%b;a=b;b=next;}return a||1n; }
function fraction(n:bigint,d:bigint):Fraction {
 if(d===0n)fail('FORMULA_DIVISION_ZERO','公式除数不能为零');
 if(d<0n){n=-n;d=-d;} const common=gcd(n,d);n/=common;d/=common;
 if(n.toString().length>96||d.toString().length>96)fail('FORMULA_OVERFLOW','公式中间值超过可控十进制范围');
 return {n,d};
}
export function parseSignedDecimal(value:unknown):Fraction {
 if(typeof value!=='string'||!/^[-+]?(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(value))fail('DECIMAL_FORMAT','数值必须为最多14位整数、6位小数的十进制文本');
 const negative=value.startsWith('-'),[whole,decimal='']=value.replace(/^[-+]/,'').split('.');
 return fraction((BigInt(whole!)*SCALE+BigInt(decimal.padEnd(6,'0')))*(negative?-1n:1n),SCALE);
}
function roundScaled(value:Fraction,digits=6):bigint {
 const scale=10n**BigInt(digits),negative=value.n<0n,abs=negative?-value.n:value.n;
 const q=abs*scale/value.d,rem=abs*scale%value.d;
 return (q+(rem*2n>=value.d?1n:0n))*(negative?-1n:1n);
}
function fixed(value:Fraction):string {
 const n=roundScaled(value);if(n>MAX_ABS||n<-MAX_ABS)fail('FORMULA_OVERFLOW','公式结果超过20位、6位小数范围');
 const abs=n<0n?-n:n;return `${n<0n?'-':''}${abs/SCALE}.${(abs%SCALE).toString().padStart(6,'0')}`;
}
export function canonicalDecimal(value:unknown){return fixed(parseSignedDecimal(value));}
export function compileFormula(expression:unknown,variables:FormulaVariable[]):FormulaAst {
 if(typeof expression!=='string'||expression.length<1||expression.length>1000)fail('FORMULA_EXPRESSION','表达式长度须为1至1000字符');
 if(!Array.isArray(variables)||variables.length>30)fail('FORMULA_VARIABLES','公式最多声明30个变量');
 const names=new Set<string>();
 for(const v of variables){if(!v||typeof v.name!=='string'||!identifier.test(v.name)||reserved.has(v.name)||names.has(v.name)||v.unit!==undefined&&(typeof v.unit!=='string'||v.unit.length>40))fail('FORMULA_VARIABLES','变量名须唯一且合法，单位须为40字以内文本');names.add(v.name);}
 const tokens:{kind:'number'|'name'|'symbol';value:string}[]=[];
 let index=0;
 while(index<expression.length){
  const rest=expression.slice(index),spaces=/^\s+/.exec(rest);if(spaces){index+=spaces[0].length;continue;}
  const numeric=/^(?:0|[1-9]\d*)(?:\.\d+)?/.exec(rest),name=/^[A-Za-z][A-Za-z0-9_]*/.exec(rest);
  if(numeric){parseSignedDecimal(numeric[0]);tokens.push({kind:'number',value:numeric[0]});index+=numeric[0].length;}
  else if(name){tokens.push({kind:'name',value:name[0]});index+=name[0].length;}
  else if('+-*/(),'.includes(rest[0]!)){tokens.push({kind:'symbol',value:rest[0]!});index++;}
  else fail('FORMULA_TOKEN','表达式只允许十进制、变量、括号及白名单算术函数');
  if(tokens.length>256)fail('FORMULA_COMPLEXITY','表达式词元过多');
 }
 let cursor=0,nodes=0;
 const take=()=>tokens[cursor++];const peek=()=>tokens[cursor]?.value;
 const count=(node:FormulaAst)=>{if(++nodes>128)fail('FORMULA_COMPLEXITY','表达式节点过多');return node;};
 const parse=(minimum:number,depth:number):FormulaAst=>{
  if(depth>24)fail('FORMULA_COMPLEXITY','表达式嵌套过深');const token=take();if(!token)fail('FORMULA_SYNTAX','表达式不完整');let left:FormulaAst;
  if(token.kind==='number')left=count({type:'number',value:token.value});
  else if(token.value==='+'||token.value==='-')left=count({type:'unary',op:token.value,value:parse(30,depth+1)});
  else if(token.value==='('){left=parse(0,depth+1);if(take()?.value!==')')fail('FORMULA_SYNTAX','括号不匹配');}
  else if(token.kind==='name'){
   if(peek()==='('){
    if(!['abs','min','max','round'].includes(token.value))fail('FORMULA_FUNCTION','函数不在允许名单');take();const args:FormulaAst[]=[];
    if(peek()!==')'){do{args.push(parse(0,depth+1));if(peek()!==',')break;take();}while(true);}
    if(take()?.value!==')')fail('FORMULA_SYNTAX','函数括号不匹配');
    if(token.value==='abs'&&args.length!==1||['min','max'].includes(token.value)&&(args.length<2||args.length>10)||token.value==='round'&&(args.length!==2||args[1]?.type!=='number'||!/^\d$/.test(args[1].value)||Number(args[1].value)>6))fail('FORMULA_ARITY','abs须1个参数，min/max须2至10个，round精度须字面量0至6');
    left=count({type:'call',name:token.value as 'abs'|'min'|'max'|'round',args});
   }else{if(!names.has(token.value))fail('FORMULA_UNKNOWN_VARIABLE','表达式引用了未声明变量：'+token.value);left=count({type:'variable',name:token.value});}
  }else fail('FORMULA_SYNTAX','表达式语法不正确');
  while(true){const op=peek();const precedence=op==='+'||op==='-'?10:op==='*'||op==='/'?20:-1;if(precedence<minimum)break;take();left=count({type:'binary',op:op as '+'|'-'|'*'|'/',left,right:parse(precedence+1,depth+1)});}
  return left;
 };
 const ast=parse(0,0);if(cursor!==tokens.length)fail('FORMULA_SYNTAX','表达式有多余内容');
 const depth=(node:FormulaAst):number=>node.type==='binary'?1+Math.max(depth(node.left),depth(node.right)):node.type==='unary'?1+depth(node.value):node.type==='call'?1+Math.max(0,...node.args.map(depth)):1;
 if(depth(ast)>24)fail('FORMULA_COMPLEXITY','表达式树过深');return ast;
}
export function evaluateFormula(expression:string,variables:FormulaVariable[],values:Record<string,unknown>,options:{nonNegative?:boolean}={}) {
 const ast=compileFormula(expression,variables);
 if(!values||typeof values!=='object'||Array.isArray(values))fail('FORMULA_VALUES','公式变量值须为对象');
 const declared=new Set(variables.map(v=>v.name));if(Object.keys(values).some(name=>!declared.has(name)))fail('FORMULA_UNKNOWN_VARIABLE','变量值包含未声明变量');
 const parsed=new Map<string,Fraction>();const inputs=variables.map(v=>{if(!Object.hasOwn(values,v.name))fail('FORMULA_MISSING_VARIABLE','缺少变量值：'+v.name);const value=parseSignedDecimal(values[v.name]);parsed.set(v.name,value);return {name:v.name,unit:v.unit??'',value:fixed(value)};});
 const explain:string[]=[];
 const run=(node:FormulaAst):Fraction=>{
  if(node.type==='number')return parseSignedDecimal(node.value);
  if(node.type==='variable')return parsed.get(node.name)!;
  if(node.type==='unary'){const result=run(node.value);return node.op==='-'?fraction(-result.n,result.d):result;}
  if(node.type==='binary'){
   const a=run(node.left),b=run(node.right);const value=node.op==='+'?fraction(a.n*b.d+b.n*a.d,a.d*b.d):node.op==='-'?fraction(a.n*b.d-b.n*a.d,a.d*b.d):node.op==='*'?fraction(a.n*b.n,a.d*b.d):fraction(a.n*b.d,a.d*b.n);
   explain.push(`${a.n}/${a.d} ${node.op} ${b.n}/${b.d} = ${value.n}/${value.d}`);return value;
  }
  const args=node.args.map(run);if(node.name==='abs')return fraction(args[0]!.n<0n?-args[0]!.n:args[0]!.n,args[0]!.d);
  if(node.name==='round'){const digits=Number((node.args[1] as {value:string}).value);return fraction(roundScaled(args[0]!,digits),10n**BigInt(digits));}
  return args.reduce((a,b)=>{const cmp=a.n*b.d-b.n*a.d;return node.name==='min'?(cmp<0n?a:b):(cmp>0n?a:b);});
 };
 const result=run(ast);if(options.nonNegative!==false&&result.n<0n)fail('FORMULA_NEGATIVE','本次非负金额试算不能得到负结果');
 return {engine_version:FORMULA_ENGINE_VERSION,expression,ast,inputs,result:fixed(result),exact_result:{numerator:result.n.toString(),denominator:result.d.toString()},rounding:'最终六位小数四舍五入，负值远离零；运算中不舍入',explanation:explain,posted:false};
}
