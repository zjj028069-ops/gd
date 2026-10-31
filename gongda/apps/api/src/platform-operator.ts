// 创建平台管理员账号（平台后台 /platform 的登录账号，与企业账号无关）。
// 用法（gongda 目录）：npm run platform:operator -w @gongdan/api -- <账号> [显示名]
// 会生成随机初始密码并只显示一次；开发环境另外写入 .local/platform-credentials.txt。
// 账号已存在时会重置它的密码。
import { appendFile, mkdir } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { Database } from './database.js';
import { migrate } from './migrations.js';
import { hashPassword } from './passwords.js';
import { projectRoot, readConfig } from './config.js';

const [username, displayName] = process.argv.slice(2);
if (!username || !/^[a-zA-Z0-9_.@-]{3,80}$/.test(username)) {
  console.error('用法：npm run platform:operator -w @gongdan/api -- <账号（3-80 位字母数字._@-）> [显示名]');
  process.exit(1);
}
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const password = Array.from({ length: 14 }, () => chars[randomInt(chars.length)]).join('');
const config = readConfig();
const db = new Database({ mode: config.mode, url: config.url, dataDir: config.dataDir, production: config.production });
try {
  if (!config.production) await migrate(db);
  const hash = await hashPassword(password);
  const existed = await db.admin(async (sql) => {
    const row = (await sql.query<{ id: string }>('SELECT id FROM platform_operators WHERE username=$1', [username])).rows[0];
    if (row) {
      await sql.query('UPDATE platform_operators SET password_hash=$2,active=true WHERE id=$1', [row.id, hash]);
      await sql.query('DELETE FROM platform_sessions WHERE operator_id=$1', [row.id]);
      return true;
    }
    await sql.query('INSERT INTO platform_operators(username,display_name,password_hash) VALUES($1,$2,$3)', [username, displayName || username, hash]);
    return false;
  });
  console.log(`${existed ? '已重置' : '已创建'}平台管理员：${username}`);
  console.log(`初始密码：${password}`);
  console.log('登录地址：<系统地址>/platform');
  if (!config.production) {
    await mkdir(resolve(projectRoot, '.local'), { recursive: true });
    await appendFile(resolve(projectRoot, '.local/platform-credentials.txt'),
      `平台管理后台（/platform）\n账号：${username}\n密码：${password}\n时间：${new Date().toLocaleString()}\n\n`, { mode: 0o600 });
    console.log('（开发环境：已同时写入 .local/platform-credentials.txt）');
  }
} finally {
  await db.close();
}
