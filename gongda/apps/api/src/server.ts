import { Database } from './database.js';
import { migrate } from './migrations.js';
import { readConfig } from './config.js';
import { createApp } from './app.js';
const config = readConfig();
const database = new Database({ mode:config.mode,url:config.url,dataDir:config.dataDir,production:config.production });
if (config.production) await database.assertProductionRole();
else await migrate(database);
const app = await createApp(database,{production:config.production,origin:config.origin,extraOrigins:config.extraOrigins,mobileBase:config.mobileBase,trustedProxy:config.trustedProxy,logger:true,localEventsWorker:true});
app.addHook('onClose',async () => { await database.close(); });
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { void app.close().then(() => process.exit(0)); });
await app.listen({host:config.host,port:config.port});


