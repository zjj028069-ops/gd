import type { FastifyInstance } from 'fastify';
import { Problem, type Role, type Services } from './services.js';
import { decimal, SCALE } from './decimal.js';
type Fact={key:string;label:string;type:'boolean'|'decimal'|'integer'|'enum';default:unknown;options?:string[]};
type Action={value:string;label:string;from:string[];to:string;roles:Role[]};
type Definition={domain:string;label:string;initial_state:string;states:{value:string;label:string}[];actions:Action[];facts:Fact[];provisional:true};
const managers:Role[]=['admin','planner'];const everyone:Role[]=['admin','planner','worker'];
const bool=(key:string,label:string,value=false):Fact=>({key,label,type:'boolean',default:value});
const qty=(key:string,label:string,value='0'):Fact=>({key,label,type:'decimal',default:value});
const action=(value:string,label:string,from:string[],to:string,roles:Role[]=managers):Action=>({value,label,from,to,roles});
const states=(entries:[string,string][])=>entries.map(([value,label])=>({value,label}));
export const definitions:Definition[]=[
 {domain:'sales',label:'销售订单',initial_state:'draft',provisional:true,
  states:states([['draft','草稿'],['approved','已审核'],['closed','已关闭'],['cancelled','已取消']]),
  actions:[action('approve','审核',['draft'],'approved'),action('close','完成关闭',['approved'],'closed'),action('cancel','取消',['draft','approved'],'cancelled')],
  facts:[{key:'line_count',label:'有效订单明细数',type:'integer',default:0},bool('quantity_valid','产品、单位、数量与价格均有效'),qty('ordered_qty','订单数量'),qty('shipped_qty','已确认发货数量'),bool('has_downstream','已存在生产、发货或结算引用')]},
 {domain:'work_order',label:'生产工单',initial_state:'planned',provisional:true,
  states:states([['planned','待开始'],['running','进行中'],['paused','已暂停'],['completed','已完成'],['cancelled','已取消']]),
  actions:[action('start','开工',['planned'],'running'),action('pause','暂停',['running'],'paused'),action('resume','恢复',['paused'],'running'),action('complete','完成',['running','paused'],'completed'),action('cancel','取消',['planned','paused'],'cancelled')],
  facts:[bool('materials_ready','必要领料条件已满足'),bool('pending_reports','存在未审核报工'),qty('plan_qty','计划数量'),qty('good_qty','可完工良品数量'),bool('quality_passed','完工质检条件已满足'),bool('has_downstream','已存在报工、库存或成本引用')]},
 {domain:'report',label:'生产报工',initial_state:'draft',provisional:true,
  states:states([['draft','草稿'],['pending','待审核'],['approved','已审核'],['rejected','已驳回'],['reversed','已冲销']]),
  actions:[action('submit','提交报工',['draft'],'pending',everyone),action('approve','审核报工',['pending'],'approved'),action('reject','驳回报工',['pending'],'rejected'),action('resubmit','重新提交',['rejected'],'pending',everyone),action('reverse','冲销报工',['approved'],'reversed')],
  facts:[qty('good_qty','良品数量'),qty('bad_qty','不良数量'),bool('has_reverse_dependencies','存在需先冲销的后续领料、入库、工资或结算引用')]},
 {domain:'stock_movement',label:'库存单据',initial_state:'draft',provisional:true,
  states:states([['draft','草稿'],['pending','待审核'],['approved','已审核'],['rejected','已驳回'],['reversed','已冲销']]),
  actions:[action('submit','提交库存单',['draft'],'pending'),action('approve','审核库存单',['pending'],'approved'),action('reject','驳回库存单',['pending'],'rejected'),action('resubmit','重新提交',['rejected'],'pending'),action('reverse','冲销库存单',['approved'],'reversed')],
  facts:[{key:'movement_kind',label:'库存方向',type:'enum',options:['in','out'],default:'out'},qty('available_qty','当前可用数量'),qty('requested_qty','单据数量'),bool('quality_required','该入库单要求检验'),bool('quality_passed','检验已通过'),bool('has_reverse_dependencies','存在需先冲销的后续库存或结算引用')]},
];
export function previewTransition(input:{domain:string;state:string;action:string;facts:Record<string,unknown>},role:Role){
 const def=definitions.find(d=>d.domain===input.domain);if(!def)throw new Problem(400,'UNKNOWN_DOMAIN','未知业务类型');
 if(!def.states.some(s=>s.value===input.state))throw new Problem(400,'UNKNOWN_STATE','未知业务状态');
 const rule=def.actions.find(a=>a.value===input.action);if(!rule)throw new Problem(400,'UNKNOWN_ACTION','未知业务动作');
 const facts:Record<string,unknown>={};
 if(Object.keys(input.facts).some(key=>!def.facts.some(f=>f.key===key)))throw new Problem(400,'UNKNOWN_FACT','预检参数包含未知字段');
 for(const field of def.facts){const v=Object.hasOwn(input.facts,field.key)?input.facts[field.key]:field.default;
  if(field.type==='boolean'&&typeof v!=='boolean'||field.type==='integer'&&(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>10000)||field.type==='enum'&&(typeof v!=='string'||!field.options?.includes(v)))throw new Problem(400,'FACT_FORMAT','预检条件格式不正确');
  if(field.type==='decimal'){if(typeof v!=='string')throw new Problem(400,'FACT_FORMAT','数量须为十进制文本');decimal(v);}
  facts[field.key]=v;
 }
 const errors:{code:string;message:string}[]=[];const check=(ok:boolean,code:string,message:string)=>{if(!ok)errors.push({code,message});};
 check(rule.roles.includes(role),'ROLE_REQUIRED','当前角色不能执行此业务动作');
 check(rule.from.includes(input.state),'STATE_TRANSITION','当前状态不能执行此动作');
 const n=(key:string)=>decimal(facts[key] as string);
 const effects:string[]=[];
 if(input.domain==='sales'){
  if(input.action==='approve'){check(Number(facts.line_count)>0&&facts.quantity_valid===true&&n('ordered_qty')>0n,'ORDER_INCOMPLETE','订单须有有效明细且数量、价格和单位检查通过');effects.push('未来提交时生成订单审核记录，保留价格与明细快照');}
  if(input.action==='close'){check(n('ordered_qty')>0n&&n('shipped_qty')>=n('ordered_qty'),'UNSHIPPED_QUANTITY','仍有未发货数量，不能按全部履约关闭');effects.push('未来提交时关闭订单；排产与履约进度分别保留');}
  if(input.action==='cancel'){check(facts.has_downstream===false,'DOWNSTREAM_EXISTS','先处理后续生产、发货或结算引用');effects.push('未来提交时取消订单并记录原因');}
 }
 if(input.domain==='work_order'){
  if(input.action==='start'||input.action==='resume'){check(facts.materials_ready===true,'MATERIALS_NOT_READY','按当前暂定规则，需要满足必要领料条件');effects.push('未来提交时记录工单开始或恢复时间');}
  if(input.action==='complete'){check(n('plan_qty')>0n&&n('good_qty')>=n('plan_qty'),'GOOD_QUANTITY_INSUFFICIENT','可完工良品数量未达到计划');check(facts.pending_reports===false,'PENDING_REPORTS','存在未审核报工');check(facts.quality_passed===true,'QUALITY_REQUIRED','完工检验条件尚未满足');effects.push('未来提交时记录完工；入库数量由选定入库策略另行计算');}
  if(input.action==='cancel'){check(facts.has_downstream===false,'DOWNSTREAM_EXISTS','先处理已存在的报工、库存或成本引用');effects.push('未来提交时取消工单，保留路线与BOM快照');}
  if(input.action==='pause')effects.push('未来提交时暂停工单并记录原因；既有报工与库存保留');
 }
 if(input.domain==='report'){
  if(['submit','resubmit','approve'].includes(input.action))check(n('good_qty')+n('bad_qty')>0n,'EMPTY_REPORT','良品与不良合计必须大于零，允许良品为零');
  if(input.action==='submit')effects.push('未来首次提交时冻结计件/计时规则与单价快照');
  if(input.action==='resubmit')effects.push('未来重新提交保留原首次提交的计价快照');
  if(input.action==='approve')effects.push('未来审核时按配置触发数量、工资、领料与入库处理，每个事件须可幂等重试');
  if(input.action==='reject')effects.push('未来驳回保留报工数量与原计价快照，尚不产生确认库存/工资');
  if(input.action==='reverse'){check(facts.has_reverse_dependencies===false,'REVERSE_DEPENDENCIES','须先冲销后续依赖记录');effects.push('未来以反向事件冲销确认数量、库存与工资，保留原始记录');}
 }
 if(input.domain==='stock_movement'){
  if(['submit','resubmit','approve'].includes(input.action))check(n('requested_qty')>0n,'EMPTY_MOVEMENT','库存单据数量须大于零');
  if(input.action==='approve'){if(facts.movement_kind==='out')check(n('available_qty')>=n('requested_qty'),'INSUFFICIENT_STOCK','默认不允许负库存，可用数量不足');if(facts.movement_kind==='in'&&facts.quality_required===true)check(facts.quality_passed===true,'QUALITY_REQUIRED','该入库单要求检验通过');effects.push('未来审核时在同一事务内更新库存余额、台账与来源关系');}
  if(input.action==='reverse'){check(facts.has_reverse_dependencies===false,'REVERSE_DEPENDENCIES','须先冲销后续依赖记录');effects.push('未来创建反向库存事件，不能删除已确认台账');}
  if(['submit','resubmit'].includes(input.action))effects.push('未来提交进入待审核，不先改变确认库存余额');
  if(input.action==='reject')effects.push('未来驳回待审核库存单，保留单据历史');
 }
 return {allowed:errors.length===0,next_state:errors.length?input.state:rule.to,effects:errors.length?[]:effects,errors,posted:false,provisional:true};
}
export function registerPreview(app:FastifyInstance,s:Services){
 app.get('/api/design-preview/definitions',{preHandler:s.authorize()},async()=>({definitions,posted:false}));
 app.post<{Body:{domain:string;state:string;action:string;facts:Record<string,unknown>}}>('/api/design-preview/transition',{
  preHandler:s.authorize(),schema:{body:{type:'object',additionalProperties:false,required:['domain','state','action','facts'],properties:{domain:{type:'string',maxLength:30},state:{type:'string',maxLength:30},action:{type:'string',maxLength:30},facts:{type:'object',maxProperties:20}}}},
 },async r=>previewTransition(r.body,s.actor(r).role));
}


