import { Database } from './database.js';
import { readConfig } from './config.js';
import { migrate } from './migrations.js';
const config=readConfig();
if (config.mode==='postgres' && !process.env.DATABASE_ADMIN_URL) throw new Error('迁移必须提供独立DATABASE_ADMIN_URL，不能使用应用账号');
const database=new Database({mode:config.mode,dataDir:config.dataDir,url:process.env.DATABASE_ADMIN_URL});
try { await migrate(database); console.log('数据库迁移完成'); } finally { await database.close(); }

