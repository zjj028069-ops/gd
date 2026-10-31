import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem, type Actor, type Services } from './services.js';
import { noteOp } from './operation-log.js';

type SnapshotLevel = { level_no: number; sign_mode: 'and' | 'or'; approver_ids: string[] };
type Snapshot = { flow_id: string; name: string; allow_withdraw: boolean; levels: SnapshotLevel[] };
type Poster = (sql: Sql, actor: Actor, id: string) => Promise<void>;

const posters = new Map<string, Poster>();
export function registerPoster(objectType: string, poster: Poster) { posters.set(objectType, poster); }

type Doc = {
  name: string;
  codeLabel: string;
  table: string;
  code?: string;
  link: string;
  module: 'customer' | 'stock' | 'purchase';
  audit?: boolean;
  extra?: 'contract' | 'purchase_order' | 'cash';
};

export const auditCatalog: Record<string, Doc> = {
  quotation: { name: '合同报价单', codeLabel: '报价单号', table: 'money_quotations', code: 'code', link: '/contract_quotation_bill/list', module: 'customer' },
  contract: { name: '合同订单', codeLabel: '合同编号', table: 'money_contracts', code: 'code', link: '/customer_contract/list', module: 'customer', extra: 'contract' },
  cash: { name: '收支记录', codeLabel: '合同编号', table: 'money_cash', link: '/customer_financier/list', module: 'customer', extra: 'cash' },
  expense: { name: '销售费用', codeLabel: '销售费用', table: 'money_expenses', link: '/selling_expenses/list', module: 'customer' },
  purchase_receipt: { name: '采购入库单', codeLabel: '入库单号', table: 'purchase_receipts', code: 'code', link: '/purchase_stock_in_bill/list', module: 'stock', audit: true },
  fg_receipt: { name: '成品入库单', codeLabel: '入库单号', table: 'fg_receipts', code: 'code', link: '/produce_stock_in_bill/list', module: 'stock', audit: true },
  else_in: { name: '其他入库单', codeLabel: '入库单号', table: 'warehouse_misc_bills', code: 'code', link: '/else_stock_in_bill/list', module: 'stock', audit: true },
  sale_shipment: { name: '销售出库单', codeLabel: '出库单号', table: 'shipments', code: 'code', link: '/sale_stock_out_bill/list', module: 'stock', audit: true },
  material_issue: { name: '生产出库单', codeLabel: '出库单号', table: 'material_issues', code: 'code', link: '/production_out_of_storage/list', module: 'stock', audit: true },
  else_out: { name: '其他出库单', codeLabel: '出库单号', table: 'warehouse_misc_bills', code: 'code', link: '/else_stock_out_bill/list', module: 'stock', audit: true },
  KCDB: { name: '调拨单', codeLabel: '调拨单号', table: 'stock_transfer_bills', code: 'code', link: '/stock_allocate_bill/list', module: 'stock', audit: true },
  purchase_return: { name: '采购退货单', codeLabel: '退货单号', table: 'purchase_return_bills', code: 'code', link: '/purchase_return_bill/list', module: 'stock', audit: true },
  sales_return: { name: '销售退货单', codeLabel: '退货单号', table: 'warehouse_misc_bills', code: 'code', link: '/salesReturnOrder/list', module: 'stock', audit: true },
  prod_return_mat: { name: '生产退料单', codeLabel: '退料单号', table: 'warehouse_misc_bills', code: 'code', link: '/produce_return_materiel_bill/list', module: 'stock', audit: true },
  spare_apply: { name: '备件申请', codeLabel: '申请单号', table: '', link: '', module: 'stock' },
  semi_fg_in: { name: '半成品入库单', codeLabel: '入库单号', table: 'warehouse_misc_bills', code: 'code', link: '/semi_finished_products_stock_in_bill/list', module: 'stock', audit: true },
  purchase_plan: { name: '采购计划', codeLabel: '计划编号', table: 'money_purchase_plans', code: 'code', link: '/produce_plan/list', module: 'purchase' },
  purchase_order: { name: '采购单', codeLabel: '采购单号', table: 'purchase_orders', code: 'code', link: '/purchase_order/list', module: 'purchase', extra: 'purchase_order' },
  purchase_payment: { name: '采购付款记录', codeLabel: '付款记录', table: 'money_purchase_payments', link: '/purchase_pay_record/list', module: 'purchase' },
  purchase_invoice: { name: '采购发票', codeLabel: '发票', table: 'money_purchase_invoices', link: '/purchase_pay_invoice/list', module: 'purchase' },
};

const statusText: Record<string, string> = { pending: '待审', approved: '通过', rejected: '退回', withdrawn: '撤回', exempt: '不需审核', draft: '草稿' };
const tips: Record<string, string> = {
  customer: '此处可配置多种审核流程，配置的审核流程可用于合同报价单，合同订单，收支记录和销售费用。',
  stock: '此处可配置多种审核流程，配置的审核流程可用于仓库相关出入库单、调拨单和备件申请。',
  purchase: '此处可配置多种审核流程，配置的审核流程可用于采购计划、采购单、付款记录和发票管理。',
};

function docOf(objectType: string) {
  const doc = auditCatalog[objectType];
  if (!doc) throw new Problem(422, 'OBJECT', '审核对象不正确');
  return doc;
}

export async function auditRequired(sql: Sql, objectType: string) {
  if (!auditCatalog[objectType]?.table) return false;
  const row = (await sql.query(`SELECT f.id FROM audit_flows f
    JOIN audit_flow_objects o ON o.tenant_id=f.tenant_id AND o.flow_id=f.id
    WHERE o.object_type=$1 AND f.enabled
    AND EXISTS (SELECT 1 FROM audit_flow_levels l WHERE l.flow_id=f.id) LIMIT 1`, [objectType])).rows[0];
  return Boolean(row);
}

async function adminIds(sql: Sql) {
  const rows = (await sql.query<{ id: string }>("SELECT id FROM tenant_team_members WHERE role='admin'")).rows;
  if (!rows.length) throw new Problem(422, 'APPROVER', '没有可用的审核人');
  return rows.map((row) => row.id);
}

async function docCode(sql: Sql, objectType: string, objectId: string) {
  const doc = docOf(objectType);
  if (doc.extra === 'cash') {
    const row = (await sql.query<{ code: string | null }>('SELECT c.code FROM money_cash m LEFT JOIN money_contracts c ON c.tenant_id=m.tenant_id AND c.id=m.contract_id WHERE m.id=$1', [objectId])).rows[0];
    return row?.code || '收支记录';
  }
  if (!doc.table || !doc.code) return doc.name;
  const row = (await sql.query<{ code: string }>(`SELECT ${doc.code} AS code FROM ${doc.table} WHERE id=$1`, [objectId])).rows[0];
  return row?.code || doc.name;
}

async function loadSnapshot(sql: Sql, objectType: string): Promise<Snapshot | null> {
  const flow = (await sql.query<{ id: string; name: string; allow_withdraw: boolean }>(`SELECT f.id,f.name,f.allow_withdraw FROM audit_flows f
    JOIN audit_flow_objects o ON o.tenant_id=f.tenant_id AND o.flow_id=f.id
    WHERE o.object_type=$1 AND f.enabled LIMIT 1`, [objectType])).rows[0];
  if (!flow) return null;
  const levels = (await sql.query<{ level_no: number; sign_mode: 'and' | 'or'; approver_ids: string[] }>('SELECT level_no,sign_mode,approver_ids FROM audit_flow_levels WHERE flow_id=$1 ORDER BY level_no', [flow.id])).rows;
  if (!levels.length) return null;
  return { flow_id: flow.id, name: flow.name, allow_withdraw: flow.allow_withdraw, levels: levels.map((level) => ({ level_no: level.level_no, sign_mode: level.sign_mode, approver_ids: level.approver_ids })) };
}

async function writeTodos(sql: Sql, actor: Actor, objectType: string, objectId: string, level: SnapshotLevel) {
  const doc = docOf(objectType);
  const code = await docCode(sql, objectType, objectId);
  for (const userId of level.approver_ids) {
    await sql.query(`INSERT INTO kgd_messages(tenant_id,user_id,kind,title,body,object_type,object_id,doc_code,link_path,level_no)
      VALUES($1,$2,'todo',$3,$4,$5,$6,$7,$8,$9)`, [
      actor.tenant_id, userId, `${doc.name}审核`, `您有一个${doc.name}待审核，${doc.codeLabel}：${code}`, objectType, objectId, code, `${doc.link}?code=${encodeURIComponent(code)}`, level.level_no,
    ]);
  }
}

async function markLevelRead(sql: Sql, objectType: string, objectId: string, levelNo: number) {
  await sql.query("UPDATE kgd_messages SET read_at=now() WHERE object_type=$1 AND object_id=$2 AND kind='todo' AND level_no=$3 AND read_at IS NULL", [objectType, objectId, levelNo]);
}

async function notice(sql: Sql, actor: Actor, userId: string, objectType: string, objectId: string, result: string) {
  const doc = docOf(objectType);
  const code = await docCode(sql, objectType, objectId);
  const exists = (await sql.query('SELECT id FROM kgd_messages WHERE user_id=$1 AND kind=\'notice\' AND object_type=$2 AND object_id=$3 AND body LIKE $4 LIMIT 1', [userId, objectType, objectId, `%已${result}%`])).rows[0];
  if (exists) return;
  await sql.query(`INSERT INTO kgd_messages(tenant_id,user_id,kind,title,body,object_type,object_id,doc_code,link_path)
    VALUES($1,$2,'notice',$3,$4,$5,$6,$7,$8)`, [
    actor.tenant_id, userId, `${doc.name}审核`, `您的${doc.name}已${result}，${doc.codeLabel}：${code}`, objectType, objectId, code, `${doc.link}?code=${encodeURIComponent(code)}`,
  ]);
}

async function notifyOutcome(sql: Sql, actor: Actor, instanceId: string, submittedBy: string, objectType: string, objectId: string, result: string) {
  const ids = new Set<string>([submittedBy]);
  if (result === '通过') {
    const passers = (await sql.query<{ user_id: string }>("SELECT DISTINCT user_id FROM audit_actions WHERE instance_id=$1 AND action='通过'", [instanceId])).rows;
    for (const passer of passers) ids.add(passer.user_id);
  }
  for (const userId of ids) await notice(sql, actor, userId, objectType, objectId, result);
}

export async function syncFinalNotices(sql: Sql, actor: Actor) {
  const rows = (await sql.query<{ object_type: string; object_id: string; status: string; id: string; submitted_by: string }>(`
    SELECT i.id,i.object_type,i.object_id,i.status,i.submitted_by
    FROM audit_instances i
    WHERE i.status IN ('approved','rejected')
      AND (i.submitted_by=$1 OR EXISTS (SELECT 1 FROM audit_actions a WHERE a.instance_id=i.id AND a.user_id=$1 AND a.action='通过'))
  `, [actor.user_id])).rows;
  for (const row of rows) await notifyOutcome(sql, actor, row.id, row.submitted_by, row.object_type, row.object_id, row.status === 'approved' ? '通过' : '退回');
}

const stamped = new Set(['money_quotations', 'money_contracts', 'purchase_receipts', 'purchase_return_bills', 'shipments', 'fg_receipts', 'material_issues', 'stock_transfer_bills', 'warehouse_misc_bills']);
const versioned = new Set([...stamped, 'money_cash', 'money_expenses', 'money_purchase_plans', 'money_purchase_payments', 'purchase_orders']);

function touch(table: string) {
  return `${versioned.has(table) ? ',version=version+1' : ''}${stamped.has(table) ? ',updated_at=now()' : ''}`;
}

async function setDoc(sql: Sql, objectType: string, id: string, status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'exempt') {
  const doc = docOf(objectType);
  if (!doc.table) return;
  const extra = touch(doc.table);
  if (doc.extra === 'contract') {
    if (status === 'approved' || status === 'exempt') await sql.query(`UPDATE money_contracts SET approval=$1,lifecycle='performing',approved_at=COALESCE(approved_at,now())${extra} WHERE id=$2`, [status === 'exempt' ? 'exempt' : 'approved', id]);
    else if (status === 'pending') await sql.query(`UPDATE money_contracts SET approval='pending',lifecycle='inactive'${extra} WHERE id=$1`, [id]);
    else await sql.query(`UPDATE money_contracts SET approval=$1,lifecycle='inactive'${extra} WHERE id=$2`, [status, id]);
    return;
  }
  if (doc.extra === 'purchase_order') {
    if (status === 'exempt') await sql.query(`UPDATE purchase_orders SET approval='approved',money_audit='exempt'${extra} WHERE id=$1`, [id]);
    else if (status === 'approved') await sql.query(`UPDATE purchase_orders SET approval='approved',money_audit='approved'${extra} WHERE id=$1`, [id]);
    else await sql.query(`UPDATE purchase_orders SET approval=$1,money_audit=$1${extra} WHERE id=$2`, [status, id]);
    return;
  }
  if (doc.audit) {
    const approval = status === 'exempt' ? 'approved' : status;
    await sql.query(`UPDATE ${doc.table} SET approval=$1,audit_status=$2${extra} WHERE id=$3`, [approval, status === 'exempt' ? 'exempt' : status, id]);
    return;
  }
  await sql.query(`UPDATE ${doc.table} SET approval=$1${extra} WHERE id=$2`, [status === 'exempt' ? 'exempt' : status, id]);
}

export async function markAuditExempt(sql: Sql, table: string, id: string) {
  await sql.query(`UPDATE ${table} SET audit_status='exempt' WHERE id=$1`, [id]);
}

export async function startAudit(sql: Sql, actor: Actor, objectType: string, objectId: string) {
  const snapshot = await loadSnapshot(sql, objectType);
  if (!snapshot) return 'exempt' as const;
  const existing = (await sql.query("SELECT id FROM audit_instances WHERE object_type=$1 AND object_id=$2 AND status='pending'", [objectType, objectId])).rows[0];
  if (existing) return 'pending' as const;
  await sql.query(`INSERT INTO audit_instances(tenant_id,object_type,object_id,flow_snapshot,current_level,status,submitted_by)
    VALUES($1,$2,$3,$4::jsonb,1,'pending',$5)`, [actor.tenant_id, objectType, objectId, JSON.stringify(snapshot), actor.user_id]);
  const first = snapshot.levels[0];
  if (first) await writeTodos(sql, actor, objectType, objectId, first);
  return 'pending' as const;
}

export async function hasPendingInstance(sql: Sql, objectType: string, objectId: string) {
  return Boolean((await sql.query("SELECT id FROM audit_instances WHERE object_type=$1 AND object_id=$2 AND status='pending'", [objectType, objectId])).rows[0]);
}

async function finishApproved(sql: Sql, actor: Actor, objectType: string, objectId: string) {
  const poster = posters.get(objectType);
  if (poster) {
    await poster(sql, actor, objectId);
    const doc = docOf(objectType);
    if (doc.audit) await sql.query(`UPDATE ${doc.table} SET audit_status='approved' WHERE id=$1`, [objectId]);
  } else await setDoc(sql, objectType, objectId, 'approved');
}

export async function decideAudit(sql: Sql, actor: Actor, objectType: string, objectId: string, action: '通过' | '退回' | '撤回', remark = '', attachment = '') {
  const row = (await sql.query<{ id: string; flow_snapshot: Snapshot | string; current_level: number; submitted_by: string }>(
    "SELECT id,flow_snapshot,current_level,submitted_by FROM audit_instances WHERE object_type=$1 AND object_id=$2 AND status='pending' FOR UPDATE",
    [objectType, objectId],
  )).rows[0];
  if (!row) throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
  const snapshot = typeof row.flow_snapshot === 'string' ? JSON.parse(row.flow_snapshot) as Snapshot : row.flow_snapshot;
  const level = snapshot.levels.find((item) => item.level_no === row.current_level);
  if (!level) throw new Problem(409, 'STATE_TRANSITION', '当前状态不能执行此操作');
  const code = await docCode(sql, objectType, objectId);
  const doc = docOf(objectType);
  if (action === '撤回') {
    if (row.submitted_by !== actor.user_id) throw new Problem(403, 'FORBIDDEN', '不是当前级审核人');
    const acted = Number((await sql.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_actions WHERE instance_id=$1 AND action IN ('通过','退回')", [row.id])).rows[0]!.n);
    if (!snapshot.allow_withdraw || acted > 0 || row.current_level !== snapshot.levels[0]?.level_no) throw new Problem(409, 'STATE_TRANSITION', '单据无法进行撤回修改');
    await sql.query('INSERT INTO audit_actions(tenant_id,instance_id,level_no,user_id,action,attachment,remark) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.tenant_id, row.id, level.level_no, actor.user_id, action, attachment, remark]);
    await sql.query("UPDATE audit_instances SET status='withdrawn',updated_at=now() WHERE id=$1", [row.id]);
    await setDoc(sql, objectType, objectId, 'withdrawn');
    await markLevelRead(sql, objectType, objectId, level.level_no);
    return { status: 'withdrawn' as const, log: `${doc.name} ${code} 撤回` };
  }
  if (!level.approver_ids.includes(actor.user_id)) throw new Problem(403, 'FORBIDDEN', '不是当前级审核人');
  const doneByMe = (await sql.query('SELECT id FROM audit_actions WHERE instance_id=$1 AND level_no=$2 AND user_id=$3 AND action IN (\'通过\',\'退回\')', [row.id, level.level_no, actor.user_id])).rows[0];
  if (doneByMe) throw new Problem(409, 'STATE_TRANSITION', '您已审核过该级');
  await sql.query('INSERT INTO audit_actions(tenant_id,instance_id,level_no,user_id,action,attachment,remark) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.tenant_id, row.id, level.level_no, actor.user_id, action, attachment, remark]);
  if (action === '退回') {
    await sql.query("UPDATE audit_instances SET status='rejected',updated_at=now() WHERE id=$1", [row.id]);
    await setDoc(sql, objectType, objectId, 'rejected');
    await markLevelRead(sql, objectType, objectId, level.level_no);
    await notifyOutcome(sql, actor, row.id, row.submitted_by, objectType, objectId, '退回');
    return { status: 'rejected' as const, log: `${doc.name} ${code} 第${level.level_no}级审核退回` };
  }
  const passed = Number((await sql.query<{ n: string }>("SELECT count(DISTINCT user_id)::text AS n FROM audit_actions WHERE instance_id=$1 AND level_no=$2 AND action='通过'", [row.id, level.level_no])).rows[0]!.n);
  const levelDone = level.sign_mode === 'or' || passed >= level.approver_ids.length;
  if (!levelDone) {
    await sql.query("UPDATE kgd_messages SET read_at=now() WHERE object_type=$1 AND object_id=$2 AND kind='todo' AND level_no=$3 AND user_id=$4 AND read_at IS NULL", [objectType, objectId, level.level_no, actor.user_id]);
    return { status: 'pending' as const, log: `${doc.name} ${code} 第${level.level_no}级审核通过` };
  }
  await markLevelRead(sql, objectType, objectId, level.level_no);
  const next = snapshot.levels.find((item) => item.level_no === level.level_no + 1);
  if (next) {
    await sql.query('UPDATE audit_instances SET current_level=$1,updated_at=now() WHERE id=$2', [next.level_no, row.id]);
    await writeTodos(sql, actor, objectType, objectId, next);
    return { status: 'pending' as const, log: `${doc.name} ${code} 第${level.level_no}级审核通过` };
  }
  await sql.query("UPDATE audit_instances SET status='approved',updated_at=now() WHERE id=$1", [row.id]);
  await finishApproved(sql, actor, objectType, objectId);
  await notifyOutcome(sql, actor, row.id, row.submitted_by, objectType, objectId, '通过');
  return { status: 'approved' as const, log: `${doc.name} ${code} 第${level.level_no}级审核通过` };
}

export async function batchDecide(sql: Sql, actor: Actor, objectType: string, ids: string[], action: '通过' | '退回', remark = '', attachment = '') {
  const fails: string[] = [];
  let ok = 0;
  for (const id of ids) {
    let code = id.slice(0, 8);
    try { code = await docCode(sql, objectType, id); } catch { /* 单号读不到时用短 id */ }
    await sql.exec('SAVEPOINT audit_item');
    try {
      await decideAudit(sql, actor, objectType, id, action, remark, attachment);
      await sql.exec('RELEASE SAVEPOINT audit_item');
      ok += 1;
    } catch (error) {
      await sql.exec('ROLLBACK TO SAVEPOINT audit_item');
      const reason = error instanceof Problem ? error.message : '不是您当前可审核的单据';
      fails.push(reason.startsWith(code) ? reason : `${code}${reason}`);
    }
  }
  const message = fails.length ? `成功 ${ok} 条，失败 ${fails.length} 条：${fails.join('；')}` : `成功 ${ok} 条，失败 0 条`;
  return { message, success: ok, failed: fails.length };
}

export async function auditCounts(sql: Sql, objectType: string) {
  const doc = docOf(objectType);
  if (!doc.table) return { all: 0, pending: 0, approved: 0, rejected: 0, withdrawn: 0, exempt: 0, draft: 0 };
  const column = doc.audit ? 'audit_status' : 'approval';
  const rows = (await sql.query<{ s: string; n: number }>(`SELECT ${column} AS s, count(*)::int AS n FROM ${doc.table} GROUP BY 1`)).rows;
  const counts = { all: 0, pending: 0, approved: 0, rejected: 0, withdrawn: 0, exempt: 0, draft: 0 };
  for (const row of rows) {
    const key = row.s as keyof typeof counts;
    if (key in counts && key !== 'all') counts[key] = Number(row.n);
    counts.all += Number(row.n);
  }
  return counts;
}

export async function canWithdraw(sql: Sql, objectType: string, objectId: string, userId: string) {
  const row = (await sql.query<{ submitted_by: string; current_level: number; flow_snapshot: Snapshot | string; id: string }>(
    "SELECT id,submitted_by,current_level,flow_snapshot FROM audit_instances WHERE object_type=$1 AND object_id=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1",
    [objectType, objectId],
  )).rows[0];
  if (!row || row.submitted_by !== userId) return false;
  const snapshot = typeof row.flow_snapshot === 'string' ? JSON.parse(row.flow_snapshot) as Snapshot : row.flow_snapshot;
  if (!snapshot.allow_withdraw || row.current_level !== snapshot.levels[0]?.level_no) return false;
  const acted = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_actions WHERE instance_id=$1', [row.id])).rows[0]!.n);
  return acted === 0;
}

function assertAuditCaller(actor: Actor, objectType: string) {
  const doc = auditCatalog[objectType];
  if (!doc) throw new Problem(422, 'OBJECT', '审核对象不正确');
  if (actor.points !== null) {
    const ok = doc.module === 'stock' ? actor.points.includes('menu.warehouse.view')
      : doc.module === 'purchase' ? actor.points.some((point) => point.startsWith('menu.supply') || point.startsWith('purchase.'))
        : actor.points.some((point) => point.startsWith('customer.'));
    if (!ok) throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
    return;
  }
  const need = doc.module === 'stock' ? 'inventory.write' : doc.module === 'purchase' ? 'procurement.write' : 'sales.write';
  if (actor.role !== 'admin' && !actor.permissions.includes(need)) throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
}

export async function auditDetail(sql: Sql, objectType: string, objectId: string) {
  const row = (await sql.query<{ id: string; flow_snapshot: Snapshot | string; current_level: number; status: string; submitted_by: string }>(
    'SELECT id,flow_snapshot,current_level,status,submitted_by FROM audit_instances WHERE object_type=$1 AND object_id=$2 ORDER BY created_at DESC LIMIT 1',
    [objectType, objectId],
  )).rows[0];
  if (!row) return { status: '不需审核', allow_withdraw: false, current_level: 0, levels: [] as unknown[] };
  const snapshot = typeof row.flow_snapshot === 'string' ? JSON.parse(row.flow_snapshot) as Snapshot : row.flow_snapshot;
  const actions = (await sql.query<{ level_no: number; user_id: string; action: string; remark: string; created_at: string; display_name: string }>(
    'SELECT a.level_no,a.user_id,a.action,a.remark,a.created_at,COALESCE(m.display_name,\'\') AS display_name FROM audit_actions a LEFT JOIN tenant_team_members m ON m.id=a.user_id WHERE a.instance_id=$1 ORDER BY a.created_at',
    [row.id],
  )).rows;
  const names = new Map<string, string>();
  const ids = [...new Set(snapshot.levels.flatMap((level) => level.approver_ids))];
  if (ids.length) {
    const people = (await sql.query<{ id: string; display_name: string }>('SELECT id,display_name FROM tenant_team_members WHERE id = ANY($1::uuid[])', [ids])).rows;
    people.forEach((person) => names.set(person.id, person.display_name));
  }
  return {
    status: statusText[row.status] ?? row.status,
    allow_withdraw: snapshot.allow_withdraw,
    current_level: row.current_level,
    levels: snapshot.levels.map((level) => ({
      level_no: level.level_no,
      sign_mode: level.sign_mode,
      sign_text: level.sign_mode === 'and' ? '会签' : '或签',
      title: `${['一', '二', '三', '四', '五', '六', '七', '八', '九'][level.level_no - 1] ?? level.level_no}级审核 (${level.sign_mode === 'and' ? '会签' : '或签'})`,
      approvers: level.approver_ids.map((userId) => {
        const action = actions.find((item) => item.level_no === level.level_no && item.user_id === userId);
        return { user_id: userId, name: names.get(userId) || action?.display_name || '-', action: action?.action ?? '', remark: action?.remark ?? '', time: action?.created_at ?? null };
      }),
    })),
  };
}

async function readFlow(sql: Sql, id: string) {
  const flow = (await sql.query('SELECT * FROM audit_flows WHERE id=$1', [id])).rows[0] as { id: string; module: string; name: string; allow_withdraw: boolean; enabled: boolean; version: number } | undefined;
  if (!flow) throw new Problem(404, 'NOT_FOUND', '审核流程不存在');
  const objects = (await sql.query<{ object_type: string }>('SELECT object_type FROM audit_flow_objects WHERE flow_id=$1 ORDER BY object_type', [id])).rows.map((row) => row.object_type);
  const levels = (await sql.query('SELECT level_no,sign_mode,approver_ids FROM audit_flow_levels WHERE flow_id=$1 ORDER BY level_no', [id])).rows;
  return { ...flow, object_types: objects, object_type: objects[0] ?? '', object_text: objects.map((type) => auditCatalog[type]?.name ?? type).join('、') || '-', enabled_text: flow.enabled ? '启用' : '禁用', levels };
}

export async function createSimpleFlow(sql: Sql, actor: Actor, input: { name: string; objectType: string; enabled: boolean; allowWithdraw?: boolean }) {
  docOf(input.objectType);
  const id = (await sql.query<{ id: string }>('INSERT INTO audit_flows(tenant_id,module,name,allow_withdraw,enabled) VALUES($1,\'customer\',$2,$3,$4) RETURNING id', [actor.tenant_id, input.name, Boolean(input.allowWithdraw), input.enabled])).rows[0]!.id;
  await saveObjects(sql, actor, id, [input.objectType]);
  await saveLevels(sql, actor, id, [{ sign_mode: 'or', approver_ids: await adminIds(sql) }]);
  return legacyCustomerFlows(sql).then((items) => items.find((item) => item.id === id && item.object_type === input.objectType));
}

export async function patchSimpleFlow(sql: Sql, id: string, input: { name?: string; enabled?: boolean }) {
  const row = await sql.query('UPDATE audit_flows SET name=COALESCE($1,name),enabled=COALESCE($2,enabled),version=version+1,updated_at=now() WHERE id=$3 RETURNING id', [input.name ?? null, input.enabled === undefined ? null : input.enabled, id]);
  if (!row.rows[0]) throw new Problem(404, 'NOT_FOUND', '审核流程不存在');
  return (await legacyCustomerFlows(sql)).find((item) => item.id === id);
}

export async function copySimpleFlow(sql: Sql, actor: Actor, id: string) {
  const source = (await sql.query<{ module: string; name: string; allow_withdraw: boolean }>('SELECT module,name,allow_withdraw FROM audit_flows WHERE id=$1', [id])).rows[0];
  if (!source) throw new Problem(404, 'NOT_FOUND', '审核流程不存在');
  const created = (await sql.query<{ id: string }>('INSERT INTO audit_flows(tenant_id,module,name,allow_withdraw,enabled) VALUES($1,$2,$3,$4,false) RETURNING id', [actor.tenant_id, source.module, `${source.name} 副本`, source.allow_withdraw])).rows[0]!.id;
  const levels = (await sql.query<{ sign_mode: string; approver_ids: string[] }>('SELECT sign_mode,approver_ids FROM audit_flow_levels WHERE flow_id=$1 ORDER BY level_no', [id])).rows;
  await saveLevels(sql, actor, created, levels);
  return (await sql.query('SELECT id,name,enabled FROM audit_flows WHERE id=$1', [created])).rows[0];
}

export async function legacyCustomerFlows(sql: Sql) {
  const rows = (await sql.query<{ id: string; name: string; enabled: boolean; object_type: string }>('SELECT f.id,f.name,f.enabled,o.object_type FROM audit_flows f JOIN audit_flow_objects o ON o.tenant_id=f.tenant_id AND o.flow_id=f.id WHERE f.module=\'customer\' ORDER BY f.name')).rows;
  return rows.map((row) => ({ ...row, object_text: auditCatalog[row.object_type]?.name ?? row.object_type, enabled_text: row.enabled ? '启用' : '禁用' }));
}

type FlowBody = { name?: string; module?: string; enabled?: boolean; allow_withdraw?: boolean; object_types?: string[]; object_type?: string; levels?: { sign_mode?: string; approver_ids?: string[] }[] };

async function saveObjects(sql: Sql, actor: Actor, flowId: string, types: string[]) {
  if (!types.length) throw new Problem(422, 'OBJECT', '请选择审核对象', 'object_types');
  const taken = (await sql.query<{ object_type: string }>('SELECT object_type FROM audit_flow_objects WHERE object_type = ANY($1::text[]) AND flow_id<>$2', [types, flowId])).rows;
  if (taken.length) throw new Problem(422, 'OBJECT_TAKEN', '审核对象已被其他流程占用');
  await sql.query('DELETE FROM audit_flow_objects WHERE flow_id=$1', [flowId]);
  for (const objectType of types) {
    docOf(objectType);
    await sql.query('INSERT INTO audit_flow_objects(tenant_id,flow_id,object_type) VALUES($1,$2,$3)', [actor.tenant_id, flowId, objectType]);
  }
}

async function saveLevels(sql: Sql, actor: Actor, flowId: string, levels: { sign_mode?: string; approver_ids?: string[] }[]) {
  if (!levels.length) throw new Problem(422, 'LEVEL', '请至少配置一级审核');
  await sql.query('DELETE FROM audit_flow_levels WHERE flow_id=$1', [flowId]);
  for (const [index, level] of levels.entries()) {
    const ids = (level.approver_ids ?? []).map(String).filter(Boolean);
    if (!ids.length) throw new Problem(422, 'APPROVER', `请选择第${index + 1}级审核人`, `level_${index + 1}`);
    const sign = level.sign_mode === 'or' ? 'or' : 'and';
    await sql.query('INSERT INTO audit_flow_levels(tenant_id,flow_id,level_no,sign_mode,approver_ids) VALUES($1,$2,$3,$4,$5::uuid[])', [actor.tenant_id, flowId, index + 1, sign, ids]);
  }
}

export function registerAudit(app: FastifyInstance, services: Services) {
  const guard = services.authorize();
  const run = async (request: Parameters<typeof services.actor>[0], work: (sql: Sql, actor: Actor) => Promise<unknown>) => services.database.tenant(services.context(request), (sql) => work(sql, services.actor(request)));

  app.get('/api/audit/catalog', { preHandler: guard }, async (request) => run(request, async (sql) => {
    const module = String((request.query as { module?: string }).module ?? 'customer');
    const flowId = String((request.query as { flow_id?: string }).flow_id ?? '');
    const used = (await sql.query<{ object_type: string; flow_id: string }>('SELECT object_type,flow_id FROM audit_flow_objects')).rows;
    const objects = Object.entries(auditCatalog).filter(([, doc]) => doc.module === module).map(([type, doc]) => {
      const owner = used.find((row) => row.object_type === type);
      return { type, name: doc.name, occupied: Boolean(owner && owner.flow_id !== flowId) };
    });
    return { tip: tips[module] ?? '', objects };
  }));
  app.get('/api/audit/flows', { preHandler: guard }, async (request) => run(request, async (sql) => {
    const module = String((request.query as { module?: string }).module ?? '');
    const ids = (await sql.query<{ id: string }>(module ? 'SELECT id FROM audit_flows WHERE module=$1 ORDER BY name' : 'SELECT id FROM audit_flows ORDER BY name', module ? [module] : [])).rows;
    return { items: await Promise.all(ids.map((row) => readFlow(sql, row.id))), tip: tips[module] ?? '' };
  }));
  app.post('/api/audit/flows', { preHandler: guard }, async (request, reply) => {
    const body = request.body as FlowBody;
    const created = await run(request, async (sql, actor) => {
      const module = body.module === 'stock' || body.module === 'purchase' ? body.module : 'customer';
      const name = String(body.name ?? '').trim();
      if (!name) throw new Problem(422, 'REQUIRED', '审核流程名称不能为空');
      const id = (await sql.query<{ id: string }>('INSERT INTO audit_flows(tenant_id,module,name,allow_withdraw,enabled) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, module, name, Boolean(body.allow_withdraw), body.enabled !== false])).rows[0]!.id;
      const types = body.object_types ?? (body.object_type ? [String(body.object_type)] : []);
      await saveObjects(sql, actor, id, types);
      const levels = body.levels?.length ? body.levels : [{ sign_mode: 'or', approver_ids: await adminIds(sql) }];
      await saveLevels(sql, actor, id, levels);
      noteOp(request, `新增审核流程：${name}`);
      return readFlow(sql, id);
    });
    return reply.code(201).send({ flow: created });
  });
  app.patch<{ Params: { id: string } }>('/api/audit/flows/:id', { preHandler: guard }, async (request) => run(request, async (sql, actor) => {
    const body = request.body as FlowBody;
    const current = await readFlow(sql, request.params.id);
    const name = body.name ? String(body.name).trim() : current.name;
    await sql.query('UPDATE audit_flows SET name=$1,allow_withdraw=$2,enabled=$3,version=version+1,updated_at=now() WHERE id=$4', [name, body.allow_withdraw === undefined ? current.allow_withdraw : Boolean(body.allow_withdraw), body.enabled === undefined ? current.enabled : Boolean(body.enabled), current.id]);
    if (body.object_types || body.object_type) await saveObjects(sql, actor, current.id, body.object_types ?? [String(body.object_type)]);
    if (body.levels) await saveLevels(sql, actor, current.id, body.levels);
    noteOp(request, `修改审核流程：${name}`);
    return { flow: await readFlow(sql, current.id) };
  }));
  app.post<{ Params: { id: string } }>('/api/audit/flows/:id/copy', { preHandler: guard }, async (request) => run(request, async (sql, actor) => {
    const source = await readFlow(sql, request.params.id);
    const id = (await sql.query<{ id: string }>('INSERT INTO audit_flows(tenant_id,module,name,allow_withdraw,enabled) VALUES($1,$2,$3,$4,false) RETURNING id', [actor.tenant_id, source.module, `${source.name} 副本`, source.allow_withdraw])).rows[0]!.id;
    await saveLevels(sql, actor, id, source.levels as { sign_mode?: string; approver_ids?: string[] }[]);
    noteOp(request, `复制审核流程：${source.name} 副本`);
    return { flow: await readFlow(sql, id) };
  }));
  app.delete<{ Params: { id: string } }>('/api/audit/flows/:id', { preHandler: guard }, async (request) => run(request, async (sql) => {
    const current = await readFlow(sql, request.params.id);
    await sql.query('DELETE FROM audit_flows WHERE id=$1', [current.id]);
    noteOp(request, `删除审核流程：${current.name}`);
    return { ok: true };
  }));
  app.get('/api/audit/counts', { preHandler: guard }, async (request) => run(request, async (sql) => auditCounts(sql, String((request.query as { object_type?: string }).object_type ?? ''))));
  app.get('/api/audit/detail', { preHandler: guard }, async (request) => run(request, async (sql) => {
    const query = request.query as { object_type?: string; object_id?: string };
    return auditDetail(sql, String(query.object_type ?? ''), String(query.object_id ?? ''));
  }));
  app.get('/api/audit/approver', { preHandler: guard }, async (request) => run(request, async (sql, actor) => {
    const objectType = String((request.query as { object_type?: string }).object_type ?? '');
    const row = (await sql.query(`SELECT 1 FROM audit_flows f
      JOIN audit_flow_objects o ON o.flow_id=f.id
      JOIN audit_flow_levels l ON l.flow_id=f.id
      WHERE o.object_type=$1 AND f.enabled AND $2 = ANY(l.approver_ids) LIMIT 1`, [objectType, actor.user_id])).rows[0];
    return { approver: Boolean(row) };
  }));
  app.post('/api/audit/batch', { preHandler: guard }, async (request) => run(request, async (sql, actor) => {
    const body = request.body as { object_type?: string; ids?: string[]; action?: string; remark?: string; attachment?: string };
    assertAuditCaller(actor, String(body.object_type ?? ''));
    const action = body.action === '退回' || body.action === 'reject' ? '退回' : '通过';
    const result = await batchDecide(sql, actor, String(body.object_type ?? ''), (body.ids ?? []).map(String), action, String(body.remark ?? ''), String(body.attachment ?? ''));
    noteOp(request, result.message);
    return result;
  }));
  app.post('/api/audit/decide', { preHandler: guard }, async (request) => run(request, async (sql, actor) => {
    const body = request.body as { object_type?: string; object_id?: string; action?: string; remark?: string; attachment?: string };
    assertAuditCaller(actor, String(body.object_type ?? ''));
    const action = body.action === '退回' || body.action === 'reject' ? '退回' : body.action === '撤回' || body.action === 'withdraw' ? '撤回' : '通过';
    const result = await decideAudit(sql, actor, String(body.object_type ?? ''), String(body.object_id ?? ''), action, String(body.remark ?? ''), String(body.attachment ?? ''));
    noteOp(request, result.log);
    return result;
  }));
}
