import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from './database.js';
import { migrate } from './migrations.js';
import { hashPassword, secretToken } from './passwords.js';
import { readConfig, projectRoot } from './config.js';
const config=readConfig();
if (config.production || config.mode!=='pglite') throw new Error('本地验收初始化仅允许开发环境的嵌入数据库，禁止用于企业生产库');
const db=new Database({mode:'pglite',dataDir:config.dataDir});
try {
  await migrate(db);
  const existing=await db.admin(async (sql) => Number((await sql.query<{count:string}>('SELECT count(*)::text AS count FROM users')).rows[0]!.count));
  if (existing>0) { console.log('本地库已初始化，不覆盖现有数据。凭据文件位于 .local/dev-credentials.txt'); }
  else {
    const identities=await Promise.all(['admin','planner','worker'].map(async (role) => {
      const password=secretToken();
      return {id:randomUUID(),role,username:role+'.local',name:role==='admin'?'本地管理员':role==='planner'?'本地计划员':'本地工人',password,hash:await hashPassword(password)};
    }));
    const tenants=[{id:randomUUID(),slug:'demo-a',name:'本地验收企业A'},{id:randomUUID(),slug:'demo-b',name:'本地验收企业B'}];
    await db.admin(async (sql) => {
      for (const user of identities) await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)',[user.id,user.username,user.name,user.hash]);
      for (const tenant of tenants) {
        await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)',[tenant.id,tenant.slug,tenant.name]);
        for (const user of identities) await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant.id,user.id,user.role]);
        const unitIds=[];
        for (const unit of [{code:'EA',name:'个'},{code:'M',name:'米'},{code:'SHEET',name:'张'}]) {
          const id=randomUUID();unitIds.push(id);
          await sql.query('INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,$3,$4)',[id,tenant.id,unit.code,unit.name]);
        }
        await sql.query('INSERT INTO products(tenant_id,code,name,specification,unit_id,attribute) VALUES($1,$2,$3,$4,$5,$6)',[tenant.id,'LOCAL001','本地验收样例产品-'+tenant.slug,'Φ20×100',unitIds[0],'manufactured']);
      }
    });
    await mkdir(resolve(projectRoot,'.local'),{recursive:true});
    const output=['仅供本机开发验收，禁止用于生产或公开分享。','企业标识：demo-a 或 demo-b',''];
    for (const identity of identities) output.push('账号：'+identity.username,'密码：'+identity.password,'角色：'+identity.role,'');
    await writeFile(resolve(projectRoot,'.local/dev-credentials.txt'),output.join('\n'),{mode:0o600});
    console.log('本地两家验收企业已初始化。随机凭据写入 .local/dev-credentials.txt；未向日志输出密码。');
  }
} finally { await db.close(); }

