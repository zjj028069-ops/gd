import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const origin='http://127.0.0.1:3001';
const credentials=await readFile(new URL('../.local/dev-credentials.txt',import.meta.url),'utf8');
const match=credentials.match(/账号：admin\.local\r?\n密码：([^\r\n]+)/);if(!match)throw new Error('找不到本机管理员凭据');
const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenant_slug:'demo-a',username:'admin.local',password:match[1]})});if(!response.ok)throw new Error('本机API登录失败');
const session=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
async function api(path,method='GET',body){const r=await fetch(origin+path,{method,headers:{cookie,'x-csrf-token':session.csrf_token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const result=await r.json();if(!r.ok)throw new Error(path+': '+result.error?.message);return result;}
const result=await api('/api/products?q=S3PD00002&page_size=100&page=1');const product=result.items.find(p=>p.code==='S3PD00002');if(!product)throw new Error('请先在界面完成第三步合成产品S3PD00002验收；此脚本不会替换企业现有配置');
const text='第三步本机合成附件。\n用途：验证企业认证下载与事务存储；没有客户资料或原试用账号信息。\n产品：S3PD00002。\n';
await writeFile(new URL('../.local/stage3-sample.txt',import.meta.url),text,'utf8');
const list=await api('/api/attachments?resource_type=product&resource_id='+product.id+'&include_deleted=true');let attachment=list.items.find(a=>a.filename==='第三步合成验收附件.txt');if(!attachment){const upload=await api('/api/attachments','POST',{resource_type:'product',resource_id:product.id,filename:'第三步合成验收附件.txt',mime:'text/plain',content_base64:Buffer.from(text).toString('base64'),request_key:randomUUID()});attachment=upload.attachment;}
const file=await fetch(origin+'/api/attachments/'+attachment.id+'/content',{headers:{cookie}});if(!file.ok||await file.text()!==text)throw new Error('附件鉴权下载与原内容核验不一致');
const rules=await api('/api/events/rules');if(!rules.items.some(r=>r.action==='attachment.created'))await api('/api/events/rules','POST',{action:'attachment.created',recipient_ids:[session.user.id]});
// A second synthetic upload exercises the configured audit -> outbox -> notification chain.
const nextList=await api('/api/attachments?resource_type=product&resource_id='+product.id);if(!nextList.items.some(a=>a.filename==='第三步事件验收附件.txt'))await api('/api/attachments','POST',{resource_type:'product',resource_id:product.id,filename:'第三步事件验收附件.txt',mime:'text/plain',content_base64:Buffer.from('本机合成事件附件，无客户数据。').toString('base64'),request_key:randomUUID()});
const dispatch=await api('/api/events/dispatch','POST');const notes=await api('/api/notifications');
await writeFile(new URL('../docs/verification/第三步-本机附件事件HTTP.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),tenant_slug:'demo-a',synthetic_only:true,product_code:product.code,attachment_content_equal:true,attachment_bytes:attachment.byte_size,notification_count:notes.items.length,dispatch,posted_production_transactions:false},null,2));
console.log(JSON.stringify({attachment_content_equal:true,notification_count:notes.items.length,synthetic_only:true}));
