/**
 * 第十轮 seed 的数据库层清理（仅测试租户 demo-a）。
 * 只做历史测试数据清理（DELETE/解绑），造数一律走正式接口。
 */
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';

const dataDir = process.env.LOCAL_DB_DIR ?? path.resolve(process.cwd(), '.local/database');
const slug = process.env.SEED_TENANT_SLUG ?? 'demo-a';

export async function withDemoDb(work) {
  const db = new PGlite(dataDir);
  try {
    const tenants = await db.query('SELECT id, slug FROM tenants WHERE slug=$1', [slug]);
    const tenant = tenants.rows[0];
    if (!tenant) throw new Error(`找不到测试租户 ${slug}`);
    await db.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)", [tenant.id, '00000000-0000-0000-0000-000000000001']);
    return await work(db, tenant);
  } finally {
    await db.close?.();
  }
}

/** 清理多余测试合同：保留 note 为 R9回归合同 / R10待审合同 各至多 1 条，其余 R7/R9/R10 测试合同硬删（含收款） */
export async function cleanupTestContractsDb() {
  return withDemoDb(async (db, tenant) => {
    const tid = tenant.id;
    const all = await db.query(
      `SELECT c.id, c.code, c.note, cu.name AS customer_name, c.contact_name
       FROM money_contracts c
       LEFT JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id
       WHERE c.tenant_id=$1
       ORDER BY c.created_at`,
      [tid],
    );
    const keep = new Set();
    const r9 = all.rows.find((r) => r.note === 'R9回归合同') ?? all.rows.find((r) => /R9回归/.test(String(r.note || '')));
    const r10 = all.rows.find((r) => r.note === 'R10待审合同');
    if (r9) keep.add(r9.id);
    if (r10) keep.add(r10.id);
    const isTest = (r) => keep.has(r.id) ? false
      : /R7客户|R9回归|R10/.test(String(r.customer_name || ''))
        || /R7客户|R9回归|R10/.test(String(r.contact_name || ''))
        || /R9回归合同|R10待审合同|R7|R9|R10|未投产/.test(String(r.note || ''));
    const doomed = all.rows.filter((r) => !keep.has(r.id) && isTest(r));
    for (const note of ['R9回归合同', 'R10待审合同']) {
      const same = all.rows.filter((r) => r.note === note && !keep.has(r.id));
      doomed.push(...same);
    }
    const ids = [...new Set(doomed.map((r) => r.id))];
    for (const id of ids) {
      await db.query('UPDATE shipment_lines SET contract_line_id=NULL WHERE tenant_id=$1 AND contract_line_id IN (SELECT id FROM money_contract_lines WHERE tenant_id=$1 AND contract_id=$2)', [tid, id]);
      await db.query('UPDATE shipments SET contract_id=NULL WHERE tenant_id=$1 AND contract_id=$2', [tid, id]);
      await db.query('UPDATE work_orders SET contract_id=NULL WHERE tenant_id=$1 AND contract_id=$2', [tid, id]);
      await db.query('UPDATE money_quotations SET contract_id=NULL WHERE tenant_id=$1 AND contract_id=$2', [tid, id]);
      await db.query("UPDATE money_purchase_line_meta SET contract_id=NULL, contract_code='' WHERE tenant_id=$1 AND contract_id=$2", [tid, id]);
      await db.query('DELETE FROM money_cash WHERE tenant_id=$1 AND contract_id=$2', [tid, id]);
      await db.query('DELETE FROM money_invoices WHERE tenant_id=$1 AND contract_id=$2', [tid, id]);
      await db.query('DELETE FROM money_expenses WHERE tenant_id=$1 AND contract_id=$2', [tid, id]);
      await db.query('DELETE FROM money_terminations WHERE tenant_id=$1 AND contract_id=$2', [tid, id]);
      await db.query("DELETE FROM money_logs WHERE tenant_id=$1 AND object_type='contract' AND object_id=$2", [tid, id]);
      await db.query("DELETE FROM money_audit_logs WHERE tenant_id=$1 AND object_type='contract' AND object_id=$2", [tid, id]);
      await db.query('DELETE FROM money_contract_lines WHERE tenant_id=$1 AND contract_id=$2', [tid, id]);
      await db.query('DELETE FROM money_contracts WHERE tenant_id=$1 AND id=$2', [tid, id]);
    }
    const left = await db.query('SELECT count(*)::int AS n FROM money_contracts WHERE tenant_id=$1', [tid]);
    return { deleted: ids.length, remaining: left.rows[0]?.n ?? 0 };
  });
}

/** 删掉非保留名的旧生产计划及其物料分析，保证计划编号不重复 */
export async function cleanupStaleProductionPlansDb() {
  return withDemoDb(async (db, tenant) => {
    const tid = tenant.id;
    const plans = await db.query('SELECT id, code, name FROM production_plans WHERE tenant_id=$1 ORDER BY created_at', [tid]);
    const keepNames = new Set(['R10生产计划A', 'R10生产计划作废用', 'R10生产计划B']);
    const doomed = plans.rows.filter((p) => !keepNames.has(String(p.name)));
    const byName = new Map();
    for (const p of plans.rows.filter((row) => keepNames.has(String(row.name)))) {
      const list = byName.get(p.name) ?? [];
      list.push(p);
      byName.set(p.name, list);
    }
    for (const list of byName.values()) {
      for (const extra of list.slice(1)) doomed.push(extra);
    }
    const ids = [...new Set(doomed.map((p) => p.id))];
    for (const id of ids) {
      await db.query('DELETE FROM production_plan_analysis_lines WHERE tenant_id=$1 AND analysis_id IN (SELECT id FROM production_plan_analyses WHERE tenant_id=$1 AND plan_id=$2)', [tid, id]);
      await db.query('DELETE FROM production_plan_analyses WHERE tenant_id=$1 AND plan_id=$2', [tid, id]);
      await db.query('DELETE FROM production_plan_lines WHERE tenant_id=$1 AND plan_id=$2', [tid, id]);
      await db.query('DELETE FROM production_plans WHERE tenant_id=$1 AND id=$2', [tid, id]);
    }
    const analyses = await db.query(
      `SELECT a.id, a.plan_id, a.status, p.code AS plan_code
       FROM production_plan_analyses a
       JOIN production_plans p ON p.tenant_id=a.tenant_id AND p.id=a.plan_id
       WHERE a.tenant_id=$1
       ORDER BY a.created_at`,
      [tid],
    );
    const seenCode = new Map();
    for (const row of analyses.rows) {
      const code = String(row.plan_code);
      const prev = seenCode.get(code) ?? [];
      prev.push(row);
      seenCode.set(code, prev);
    }
    const dropAnalysis = [];
    for (const [, list] of seenCode) {
      if (list.length > 1) dropAnalysis.push(...list.slice(1).map((r) => r.id));
    }
    const seenActive = new Set();
    const seenVoid = new Set();
    for (const row of analyses.rows) {
      if (dropAnalysis.includes(row.id)) continue;
      if (row.status === 'void') {
        if (seenVoid.has(row.plan_id)) dropAnalysis.push(row.id);
        else seenVoid.add(row.plan_id);
      } else if (seenActive.has(row.plan_id)) dropAnalysis.push(row.id);
      else seenActive.add(row.plan_id);
    }
    for (const id of [...new Set(dropAnalysis)]) {
      await db.query('DELETE FROM production_plan_analysis_lines WHERE tenant_id=$1 AND analysis_id=$2', [tid, id]);
      await db.query('DELETE FROM production_plan_analyses WHERE tenant_id=$1 AND id=$2', [tid, id]);
    }
    return { deletedPlans: ids.length, deletedAnalyses: new Set(dropAnalysis).size };
  });
}

if (process.argv[1]?.endsWith('seed-db-cleanup.mjs')) {
  const a = await cleanupTestContractsDb();
  const b = await cleanupStaleProductionPlansDb();
  console.log(JSON.stringify({ contracts: a, plans: b }));
}
