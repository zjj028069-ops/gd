
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite('/opt/sedric01/.local/database');
await db.waitReady;
const rules = await db.query(`SELECT id::text, name, config::text, sort, version FROM custom_code_rules WHERE name='合同编号'`);
console.log('RULE', JSON.stringify(rules.rows, null, 2));
const ctrs = await db.query(`SELECT c.period_key, c.value, r.name FROM custom_code_counters c JOIN custom_code_rules r ON r.id=c.rule_id WHERE r.name='合同编号' ORDER BY c.period_key`);
console.log('COUNTERS', JSON.stringify(ctrs.rows, null, 2));
const mc = await db.query(`SELECT series, period, next_value FROM money_counters WHERE series='HT' ORDER BY period`);
console.log('MONEY_COUNTERS', JSON.stringify(mc.rows, null, 2));
const weird = await db.query(`SELECT code, id::text FROM money_contracts WHERE code NOT LIKE 'HT%' ORDER BY created_at`);
console.log('NON_HT', JSON.stringify(weird.rows));
const dups = await db.query(`SELECT code, count(*)::int AS n FROM money_contracts GROUP BY code HAVING count(*)>1`);
console.log('DUPS', JSON.stringify(dups.rows));
await db.close();
