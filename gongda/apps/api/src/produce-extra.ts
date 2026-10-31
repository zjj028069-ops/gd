import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { allocateByRule } from './code-rules.js';
import { Problem, type Actor, type Services } from './services.js';
import { processCountProgress, progressLabel, q, qtyText, receivedQtySql } from './progress-calc.js';
import { dailyCode, dateText, decimalText, guarded, idList, idText, intIn, like, member, oneOf, pageOf, requireVersion, shanghaiDate, shanghaiTime, text, type Row } from './r10-kit.js';

const projectStatuses = ['未开始', '进行中', '已完成', '已取消'] as const;
const projectCategories = ['普通项目', '合同项目', '外协项目'] as const;
const expenseTypes = ['水电费', '房租', '折旧', '管理费用', '其他', '水费', '电费', '人工费用', '物料费用'] as const;
const shareMethods = ['按计划数', '按实际生产数', '按报工工时', '手工'] as const;
const shareMethodAliases: Record<string, (typeof shareMethods)[number]> = {
  按计划数分摊: '按计划数',
  按生产时长分摊: '按报工工时',
  按实际生产数分摊: '按实际生产数',
};
const componentFieldTypes = ['单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间', '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '公式'] as const;
const executionText: Record<string, string> = { not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
const TRACE_BASE = 999_999;

/** 按依据值把分摊金额（分）按比例拆到各行，按分取整，尾差放在最后一行。 */
export function allocateCents(totalCents: bigint, bases: bigint[]) {
  const sum = bases.reduce((acc, value) => acc + value, 0n);
  if (sum <= 0n) throw new Problem(422, 'ZERO_BASIS', '所选加工单的分摊依据合计为0，不能按比例分摊');
  const out = bases.map((value) => (totalCents * value) / sum);
  const used = out.reduce((acc, value) => acc + value, 0n);
  out[out.length - 1] = out[out.length - 1]! + (totalCents - used);
  return out;
}

function centsOf(value: string) {
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole ?? '0') * 100n + BigInt((frac + '00').slice(0, 2));
}
function moneyText(cents: bigint) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** 成本报表用：已分摊的成本分摊金额按加工单汇总（元，两位小数）。 */
export async function costShareByWorkOrder(sql: Sql) {
  const rows = (await sql.query<{ work_order_id: string; amount: string }>("SELECT l.work_order_id,sum(l.amount)::text AS amount FROM cost_share_lines l JOIN cost_shares s ON s.tenant_id=l.tenant_id AND s.id=l.share_id WHERE s.status='已分摊' GROUP BY l.work_order_id")).rows;
  return new Map(rows.map((row) => [row.work_order_id, row.amount]));
}

async function shareBases(sql: Sql, method: string, workOrderIds: string[], from: string, to: string) {
  const rows = (await sql.query<{ id: string; plan_qty: string; good: string; seconds: string }>(`SELECT w.id,w.plan_qty::text,
      coalesce((SELECT sum(r.good_qty) FROM production_reports r JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.work_order_id=w.id AND t.is_output AND r.approval='approved' AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date),0)::text AS good,
      coalesce((SELECT sum(r.effective_seconds) FROM production_reports r WHERE r.work_order_id=w.id AND r.approval='approved' AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date),0)::text AS seconds
    FROM work_orders w WHERE w.id = ANY($1::uuid[])`, [workOrderIds, from, to])).rows;
  if (rows.length !== workOrderIds.length) throw new Problem(422, 'INVALID_REFERENCE', '加工单不存在或不属于当前企业');
  const byId = new Map(rows.map((row) => [row.id, row]));
  return workOrderIds.map((id) => {
    const row = byId.get(id)!;
    const value = method === '按计划数' ? row.plan_qty : method === '按实际生产数' ? row.good : method === '按报工工时' ? String(Number(row.seconds) / 3600) : '0';
    return { id, basis: value };
  });
}

async function buildShareLines(sql: Sql, body: Row, amount: string, method: string, from: string, to: string) {
  const total = centsOf(amount);
  if (method === '手工') {
    const raw = Array.isArray(body.lines) ? body.lines as Row[] : [];
    if (!raw.length) throw new Problem(422, 'LINES_REQUIRED', '请选择要分摊的加工单');
    const ids = raw.map((line) => idText(line.work_order_id, '加工单', true)!);
    if (new Set(ids).size !== ids.length) throw new Problem(422, 'DUPLICATE_LINE', '同一张加工单只能出现一次');
    await shareBases(sql, '手工', ids, from, to);
    const cents = raw.map((line) => centsOf(decimalText(line.amount, '分摊金额', 2)));
    if (cents.reduce((acc, value) => acc + value, 0n) !== total) throw new Problem(422, 'AMOUNT_MISMATCH', '明细金额合计必须等于分摊金额');
    return ids.map((id, index) => ({ work_order_id: id, basis: '0', ratio: total ? (Number(cents[index]!) / Number(total)).toFixed(8) : '0', amount: moneyText(cents[index]!) }));
  }
  const ids = idList(body.work_order_ids ?? (Array.isArray(body.lines) ? (body.lines as Row[]).map((line) => line.work_order_id) : []), '加工单', 500);
  if (!ids.length) throw new Problem(422, 'LINES_REQUIRED', '请选择要分摊的加工单');
  const bases = await shareBases(sql, method, ids, from, to);
  const scaled = bases.map((item) => q(item.basis));
  const cents = allocateCents(total, scaled);
  const sum = scaled.reduce((acc, value) => acc + value, 0n);
  return bases.map((item, index) => ({ work_order_id: item.id, basis: qtyText(scaled[index]!), ratio: (Number(scaled[index]!) / Number(sum)).toFixed(8), amount: moneyText(cents[index]!) }));
}

async function wouldCycle(sql: Sql, id: string, parentId: string) {
  if (id === parentId) return true;
  const rows = (await sql.query<{ id: string }>('WITH RECURSIVE up AS (SELECT id,parent_id,1 AS depth FROM work_orders WHERE id=$1 UNION ALL SELECT w.id,w.parent_id,up.depth+1 FROM work_orders w JOIN up ON w.id=up.parent_id WHERE up.depth<100) SELECT id FROM up', [parentId])).rows;
  return rows.some((row) => row.id === id);
}

export async function setWorkOrderParent(sql: Sql, id: string, parentId: string | null) {
  if (parentId && await wouldCycle(sql, id, parentId)) throw new Problem(409, 'PARENT_CYCLE', '不能选择自己或自己的子单作为父单');
  const updated = await sql.query('UPDATE work_orders SET parent_id=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING id', [parentId, id]);
  if (!updated.rows[0]) throw new Problem(404, 'NOT_FOUND', '加工单不存在');
}

async function orderProgress(sql: Sql, ids: string[]) {
  if (!ids.length) return { process: progressLabel(0n, 0n), receipt: progressLabel(0n, 0n) };
  const tasks = (await sql.query<{ execution: string }>('SELECT t.execution FROM work_order_tasks t WHERE t.work_order_id = ANY($1::uuid[])', [ids])).rows;
  const receipt = (await sql.query<{ received: string; plan: string }>(`SELECT coalesce(sum(${receivedQtySql('w.id')}),0)::text AS received,coalesce(sum(w.plan_qty),0)::text AS plan FROM work_orders w WHERE w.id = ANY($1::uuid[])`, [ids])).rows[0]!;
  // 工序进度按完成工序数/总工序数（与加工单列表一致）；入库进度按入库数/计划数。
  return { process: processCountProgress(tasks), receipt: progressLabel(receipt.received, receipt.plan) };
}

async function workOrderRows(sql: Sql, where: string, params: unknown[]) {
  const rows = (await sql.query<Row>(`SELECT w.id,w.code,w.execution,w.plan_qty::text,w.parent_id,w.project_id,w.product_id,w.priority,w.note,
      coalesce(w.product_snapshot->>'name','') AS product_name,coalesce(w.product_snapshot->>'code','') AS product_code,
      coalesce(nullif(w.product_snapshot->>'specification',''),'-') AS specification,
      coalesce(nullif(w.product_snapshot->>'unit_name',''),'-') AS unit_name,
      coalesce(nullif(w.product_snapshot->>'source',''),'-') AS product_source,
      coalesce(w.route_name_snapshot,'-') AS route_name,
      CASE WHEN w.bom_revision IS NULL THEN '-' ELSE 'BOM r'||w.bom_revision::text END AS bom_label,
      coalesce(mc.code, so.code, '-') AS contract_code,
      to_char(w.due_date,'YYYY-MM-DD') AS due_date,
      to_char(w.planned_start,'YYYY-MM-DD') AS plan_start,
      to_char(w.planned_end,'YYYY-MM-DD') AS plan_end,
      ${shanghaiTime('w.created_at')} AS created_text
    FROM work_orders w
    LEFT JOIN money_contracts mc ON mc.tenant_id=w.tenant_id AND mc.id=w.contract_id
    LEFT JOIN sales_orders so ON so.tenant_id=w.tenant_id AND so.id=w.sales_order_id
    WHERE ${where} ORDER BY w.created_at ASC,w.id`, params)).rows;
  const out: Row[] = [];
  for (const row of rows) {
    const progress = await orderProgress(sql, [String(row.id)]);
    const tasks = (await sql.query<{ execution: string }>('SELECT execution FROM work_order_tasks WHERE work_order_id=$1', [row.id])).rows;
    const materials = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM work_order_materials WHERE work_order_id=$1', [row.id])).rows[0]?.n ?? '0');
    const priorityText: Record<string, string> = { none: '无', urgent: '加急', normal: '正常', delayed: '延期' };
    out.push({
      ...row,
      plan_qty: qtyText(q(String(row.plan_qty))),
      unit_qty: '1',
      execution_text: executionText[String(row.execution)] ?? '-',
      priority_text: priorityText[String(row.priority)] ?? dashText(row.priority),
      process_progress: progress.process,
      production_progress: progress.process,
      task_progress: processCountProgress(tasks),
      receipt_progress: progress.receipt,
      materials_count: materials,
      materials_label: materials ? `${materials}` : '-',
    });
  }
  return out;
}

function dashText(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

async function projectMetrics(sql: Sql, projectId: string) {
  const orders = (await sql.query<{ id: string; execution: string; plan_qty: string }>('SELECT id,execution,plan_qty::text FROM work_orders WHERE project_id=$1', [projectId])).rows;
  const ids = orders.map((item) => item.id);
  const progress = await orderProgress(sql, ids);
  const completed = orders.filter((item) => item.execution === 'completed').length;
  const planQty = orders.reduce((sum, item) => sum + q(item.plan_qty), 0n);
  return {
    work_order_count: orders.length,
    completed_work_order_count: completed,
    plan_qty: qtyText(planQty),
    production_progress: progress.process,
    project_progress: progressLabel(BigInt(completed), BigInt(orders.length)),
    inbound_progress: progress.receipt,
    process_progress: progress.process,
    receipt_progress: progress.receipt,
  };
}

export function registerProduceExtra(app: FastifyInstance, services: Services) {
  const read = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => guarded(services, request, 'production.read', false, work);
  const write = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => guarded(services, request, 'production.write', true, work);
  const body = (request: FastifyRequest) => (request.body ?? {}) as Row;
  const query = (request: FastifyRequest) => (request.query ?? {}) as Row;
  const filters = () => {
    const params: unknown[] = [];
    const where: string[] = ['true'];
    const add = (clause: (n: string) => string, value: unknown) => { if (value === null || value === undefined || value === '') return; params.push(value); where.push(clause(`$${params.length}`)); };
    return { params, where, add };
  };

  // 项目管理 P044/P045/P149/P150/P151
  app.get('/api/production-projects', (request) => read(request, async (sql) => {
    const qs = query(request);
    const { size, offset, page } = pageOf(qs);
    const f = filters();
    f.add((n) => `(p.code ILIKE ${n} OR p.name ILIKE ${n})`, like(qs.keyword));
    f.add((n) => `p.code ILIKE ${n}`, like(qs.code));
    f.add((n) => `p.name ILIKE ${n}`, like(qs.name));
    if (qs.status) f.add((n) => `p.status=${n}`, oneOf(qs.status, projectStatuses, '状态'));
    if (qs.category) f.add((n) => `p.category=${n}`, oneOf(qs.category, projectCategories, '项目类别'));
    f.add((n) => `p.customer_id=${n}::uuid`, idText(qs.customer_id, '客户'));
    f.add((n) => `p.owner_id=${n}::uuid`, idText(qs.owner_id, '负责人'));
    f.add((n) => `m.display_name ILIKE ${n}`, like(qs.creator ?? qs.creator_name));
    f.add((n) => `m.display_name ILIKE ${n}`, like(qs.updater ?? qs.updater_name));
    f.add((n) => `(p.contract_code ILIKE ${n} OR mc.code ILIKE ${n})`, like(qs.contract ?? qs.contract_code));
    f.add((n) => `(p.created_at AT TIME ZONE 'Asia/Shanghai')::date >= ${n}::date`, dateText(qs.created_from, '创建时间起'));
    f.add((n) => `(p.created_at AT TIME ZONE 'Asia/Shanghai')::date <= ${n}::date`, dateText(qs.created_to, '创建时间止'));
    f.add((n) => `(p.updated_at AT TIME ZONE 'Asia/Shanghai')::date >= ${n}::date`, dateText(qs.updated_from, '更新时间起'));
    f.add((n) => `(p.updated_at AT TIME ZONE 'Asia/Shanghai')::date <= ${n}::date`, dateText(qs.updated_to, '更新时间止'));
    const from = `FROM production_projects p
      LEFT JOIN customers c ON c.tenant_id=p.tenant_id AND c.id=p.customer_id
      LEFT JOIN tenant_team_members o ON o.id=p.owner_id
      LEFT JOIN tenant_team_members m ON m.id=p.created_by
      LEFT JOIN money_contracts mc ON mc.tenant_id=p.tenant_id AND mc.id=p.contract_id
      WHERE ${f.where.join(' AND ')}`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, f.params)).rows[0]!.n);
    const rows = (await sql.query<Row>(`SELECT p.id,p.code,p.name,p.category,p.contract_id,coalesce(nullif(p.contract_code,''),mc.code,'-') AS contract_code,
        p.customer_id,coalesce(c.name,'-') AS customer_name,p.owner_id,coalesce(o.display_name,'-') AS owner_name,
        coalesce(to_char(p.plan_start,'YYYY-MM-DD'),'-') AS plan_start,coalesce(to_char(p.plan_end,'YYYY-MM-DD'),'-') AS plan_end,
        p.status,coalesce(nullif(p.note,''),'-') AS note,
        coalesce(m.display_name,'-') AS creator_name,coalesce(m.display_name,'-') AS updater_name,
        ${shanghaiTime('p.created_at')} AS created_text,${shanghaiTime('p.updated_at')} AS updated_text,p.version
      ${from} ORDER BY p.created_at DESC,p.id LIMIT ${size} OFFSET ${offset}`, f.params)).rows;
    const items = [];
    for (const row of rows) {
      const metrics = await projectMetrics(sql, String(row.id));
      items.push({ ...row, ...metrics });
    }
    return { total, page, page_size: size, items, statuses: projectStatuses, categories: projectCategories };
  }));
  app.get<{ Params: { id: string } }>('/api/production-projects/:id', (request) => read(request, async (sql) => {
    const id = idText(request.params.id, '项目', true);
    const row = (await sql.query<Row>(`SELECT p.id,p.code,p.name,p.category,p.contract_id,coalesce(nullif(p.contract_code,''),mc.code,'') AS contract_code,
        p.customer_id,p.owner_id,p.status,p.note,p.version,p.created_by,
        to_char(p.plan_start,'YYYY-MM-DD') AS plan_start,to_char(p.plan_end,'YYYY-MM-DD') AS plan_end,
        coalesce(c.name,'-') AS customer_name,coalesce(o.display_name,'-') AS owner_name,
        coalesce(m.display_name,'-') AS creator_name,coalesce(m.display_name,'-') AS updater_name,
        ${shanghaiTime('p.created_at')} AS created_text,${shanghaiTime('p.updated_at')} AS updated_text
      FROM production_projects p
      LEFT JOIN customers c ON c.tenant_id=p.tenant_id AND c.id=p.customer_id
      LEFT JOIN tenant_team_members o ON o.id=p.owner_id
      LEFT JOIN tenant_team_members m ON m.id=p.created_by
      LEFT JOIN money_contracts mc ON mc.tenant_id=p.tenant_id AND mc.id=p.contract_id
      WHERE p.id=$1`, [id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '项目不存在');
    const orders = await workOrderRows(sql, 'w.project_id=$1', [id]);
    const metrics = await projectMetrics(sql, id!);
    return { project: { ...row, ...metrics }, work_orders: orders };
  }));
  const projectInput = async (sql: Sql, input: Row) => {
    const customerId = idText(input.customer_id, '客户');
    if (customerId && !(await sql.query('SELECT 1 FROM customers WHERE id=$1', [customerId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '客户不存在或不属于当前企业');
    const ownerId = idText(input.owner_id, '负责人');
    if (ownerId && !(await sql.query('SELECT 1 FROM tenant_team_members WHERE id=$1', [ownerId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '负责人不存在或已停用');
    const start = dateText(input.plan_start, '计划开始');
    const end = dateText(input.plan_end, '计划结束');
    if (start && end && start > end) throw new Problem(422, 'DATE_RANGE', '计划开始不能晚于计划结束');
    const category = oneOf(input.category, projectCategories, '项目类别', '普通项目');
    const contractId = idText(input.contract_id, '关联合同');
    let contractCode = text(input.contract_code, 64, '合同编号');
    if (contractId) {
      const contract = (await sql.query<{ code: string }>('SELECT code FROM money_contracts WHERE id=$1', [contractId])).rows[0];
      if (!contract) throw new Problem(422, 'INVALID_REFERENCE', '关联合同不存在');
      contractCode = contractCode || contract.code;
    }
    return {
      name: text(input.name, 100, '项目名称') || '未命名项目',
      customerId, ownerId, start, end,
      status: oneOf(input.status, projectStatuses, '状态', '未开始'),
      note: text(input.note, 255, '备注'),
      category, contractId, contractCode: contractCode || '',
    };
  };
  app.post('/api/production-projects', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const input = await projectInput(sql, body(request));
    const code = text(body(request).code, 64, '项目编号') || (await allocateByRule(sql, actor.tenant_id, '项目编号')) || await dailyCode(sql, actor.tenant_id, 'XM');
    if ((await sql.query('SELECT 1 FROM production_projects WHERE code=$1', [code])).rows[0]) throw new Problem(409, 'DUPLICATE', '项目编号已存在');
    const row = (await sql.query<{ id: string }>('INSERT INTO production_projects(tenant_id,code,name,customer_id,owner_id,plan_start,plan_end,status,note,created_by,category,contract_id,contract_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',
      [actor.tenant_id, code, input.name, input.customerId, input.ownerId, input.start, input.end, input.status, input.note, actor.user_id, input.category, input.contractId, input.contractCode])).rows[0]!;
    return { id: row.id, code, category: input.category };
  })));
  app.put<{ Params: { id: string } }>('/api/production-projects/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '项目', true);
    requireVersion((await sql.query<{ version: number }>('SELECT version FROM production_projects WHERE id=$1 FOR UPDATE', [id])).rows[0], body(request).version, '项目');
    const input = await projectInput(sql, body(request));
    await sql.query('UPDATE production_projects SET name=$1,customer_id=$2,owner_id=$3,plan_start=$4,plan_end=$5,status=$6,note=$7,category=$8,contract_id=$9,contract_code=$10,version=version+1,updated_at=now() WHERE id=$11',
      [input.name, input.customerId, input.ownerId, input.start, input.end, input.status, input.note, input.category, input.contractId, input.contractCode, id]);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/production-projects/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '项目', true);
    if ((await sql.query('SELECT 1 FROM work_orders WHERE project_id=$1 LIMIT 1', [id])).rows[0]) throw new Problem(409, 'PROJECT_IN_USE', '项目已关联加工单，不能删除');
    if (!(await sql.query('DELETE FROM production_projects WHERE id=$1 RETURNING id', [id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '项目不存在');
    return { ok: true };
  }));

  // 加工单的项目与父子关系
  app.put<{ Params: { id: string } }>('/api/work-order-links/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '加工单', true)!;
    const input = body(request);
    if (!(await sql.query('SELECT 1 FROM work_orders WHERE id=$1', [id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '加工单不存在');
    if ('project_id' in input) {
      const projectId = idText(input.project_id, '项目');
      if (projectId && !(await sql.query('SELECT 1 FROM production_projects WHERE id=$1', [projectId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '项目不存在');
      await sql.query('UPDATE work_orders SET project_id=$1,version=version+1,updated_at=now() WHERE id=$2', [projectId, id]);
    }
    if ('parent_id' in input) {
      const parentId = idText(input.parent_id, '父单');
      if (parentId && !(await sql.query('SELECT 1 FROM work_orders WHERE id=$1', [parentId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '父单不存在');
      await setWorkOrderParent(sql, id, parentId);
    }
    if ('child_ids' in input) {
      for (const childId of idList(input.child_ids, '子单', 200)) await setWorkOrderParent(sql, childId, id);
    }
    return { ok: true };
  }));
  app.get<{ Params: { id: string } }>('/api/work-order-links/:id/tree', (request) => read(request, async (sql) => {
    const id = idText(request.params.id, '加工单', true);
    const root = (await sql.query<{ id: string }>('WITH RECURSIVE up AS (SELECT id,parent_id,1 AS depth FROM work_orders WHERE id=$1 UNION ALL SELECT w.id,w.parent_id,up.depth+1 FROM work_orders w JOIN up ON w.id=up.parent_id WHERE up.depth<100) SELECT id FROM up WHERE parent_id IS NULL LIMIT 1', [id])).rows[0];
    if (!root) throw new Problem(404, 'NOT_FOUND', '加工单不存在');
    const ids = (await sql.query<{ id: string }>('WITH RECURSIVE down AS (SELECT id,1 AS depth FROM work_orders WHERE id=$1 UNION ALL SELECT w.id,down.depth+1 FROM work_orders w JOIN down ON w.parent_id=down.id WHERE down.depth<100) SELECT id FROM down', [root.id])).rows.map((row) => row.id);
    const rows = await workOrderRows(sql, 'w.id = ANY($1::uuid[])', [ids]);
    const build = (nodeId: string): Row => ({ ...rows.find((row) => row.id === nodeId)!, current: nodeId === id, children: rows.filter((row) => row.parent_id === nodeId).map((row) => build(String(row.id))) });
    return { tree: build(root.id) };
  }));

  // 成本分摊（原版未采到）
  app.get('/api/cost-shares', (request) => read(request, async (sql) => {
    const qs = query(request);
    const { size, offset, page } = pageOf(qs);
    const f = filters();
    f.add((n) => `(s.code ILIKE ${n} OR s.name ILIKE ${n})`, like(qs.keyword));
    if (qs.status) f.add((n) => `s.status=${n}`, oneOf(qs.status, ['草稿', '已分摊'] as const, '状态'));
    if (qs.expense_type) f.add((n) => `s.expense_type=${n}`, oneOf(qs.expense_type, expenseTypes, '费用类型'));
    f.add((n) => `s.period_end>=${n}::date`, dateText(qs.period_from, '期间起'));
    f.add((n) => `s.period_start<=${n}::date`, dateText(qs.period_to, '期间止'));
    const from = `FROM cost_shares s LEFT JOIN tenant_team_members m ON m.id=s.created_by WHERE ${f.where.join(' AND ')}`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, f.params)).rows[0]!.n);
    const items = (await sql.query<Row>(`SELECT s.id,s.code,s.name,s.expense_type,s.amount::text,to_char(s.period_start,'YYYY-MM-DD') AS period_start,to_char(s.period_end,'YYYY-MM-DD') AS period_end,s.method,s.status,coalesce(nullif(s.note,''),'-') AS note,
        (SELECT count(*)::int FROM cost_share_lines l WHERE l.share_id=s.id) AS line_count,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('s.created_at')} AS created_text,s.version
      ${from} ORDER BY s.created_at DESC,s.id LIMIT ${size} OFFSET ${offset}`, f.params)).rows;
    return { total, page, page_size: size, items, expense_types: expenseTypes, methods: shareMethods };
  }));
  app.get('/api/cost-shares/candidates', (request) => read(request, async (sql) => {
    const qs = query(request);
    const from = dateText(qs.period_start, '期间起', true)!;
    const to = dateText(qs.period_end, '期间止', true)!;
    const method = oneOf(shareMethodAliases[String(qs.method ?? '')] ?? qs.method, shareMethods, '分摊方式', '按计划数');
    const ids = (await sql.query<{ id: string }>(`SELECT w.id FROM work_orders w WHERE w.execution<>'cancelled' AND (
        (w.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date
        OR EXISTS (SELECT 1 FROM production_reports r WHERE r.work_order_id=w.id AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date)
        OR (coalesce(w.planned_start,w.planned_end) IS NOT NULL AND coalesce(w.planned_start,w.planned_end) <= $2::date AND coalesce(w.planned_end,w.planned_start) >= $1::date))
      ORDER BY w.created_at DESC LIMIT 500`, [from, to])).rows.map((row) => row.id);
    const bases = ids.length ? await shareBases(sql, method, ids, from, to) : [];
    const orders = await workOrderRows(sql, 'w.id = ANY($1::uuid[])', [ids]);
    return { items: orders.map((order) => ({ ...order, basis: qtyText(q(bases.find((item) => item.id === order.id)?.basis ?? '0')) })) };
  }));
  app.get<{ Params: { id: string } }>('/api/cost-shares/:id', (request) => read(request, async (sql) => {
    const id = idText(request.params.id, '成本分摊', true);
    const share = (await sql.query<Row>(`SELECT s.*,s.amount::text,to_char(s.period_start,'YYYY-MM-DD') AS period_start,to_char(s.period_end,'YYYY-MM-DD') AS period_end,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('s.created_at')} AS created_text
      FROM cost_shares s LEFT JOIN tenant_team_members m ON m.id=s.created_by WHERE s.id=$1`, [id])).rows[0];
    if (!share) throw new Problem(404, 'NOT_FOUND', '成本分摊不存在');
    const lines = (await sql.query<Row>(`SELECT l.id,l.line_no,l.work_order_id,w.code AS work_order_code,coalesce(w.product_snapshot->>'name','') AS product_name,coalesce(w.product_snapshot->>'code','') AS product_code,w.plan_qty::text,l.basis::text,l.ratio::text,l.amount::text
      FROM cost_share_lines l JOIN work_orders w ON w.tenant_id=l.tenant_id AND w.id=l.work_order_id WHERE l.share_id=$1 ORDER BY l.line_no`, [id])).rows
      .map((line) => ({ ...line, plan_qty: qtyText(q(String(line.plan_qty))), basis: qtyText(q(String(line.basis))), ratio: `${(Number(line.ratio) * 100).toFixed(2)}%` }));
    return { share, lines };
  }));
  const shareInput = async (sql: Sql, input: Row) => {
    const amount = decimalText(input.amount, '分摊金额', 2, false);
    const from = dateText(input.period_start, '期间起', true)!;
    const to = dateText(input.period_end, '期间止', true)!;
    if (from > to) throw new Problem(422, 'DATE_RANGE', '期间起不能晚于期间止');
    const method = oneOf(shareMethodAliases[String(input.method ?? '')] ?? input.method, shareMethods, '分摊方式');
    return { name: text(input.name, 100, '分摊名称', true), expenseType: oneOf(input.expense_type, expenseTypes, '费用类型'), amount, from, to, method, note: text(input.note, 255, '备注'), lines: await buildShareLines(sql, input, amount, method, from, to) };
  };
  const saveLines = async (sql: Sql, tenantId: string, shareId: string, lines: Awaited<ReturnType<typeof buildShareLines>>) => {
    await sql.query('DELETE FROM cost_share_lines WHERE share_id=$1', [shareId]);
    for (const [index, line] of lines.entries()) await sql.query('INSERT INTO cost_share_lines(tenant_id,share_id,line_no,work_order_id,basis,ratio,amount) VALUES($1,$2,$3,$4,$5,$6,$7)', [tenantId, shareId, index + 1, line.work_order_id, line.basis, line.ratio, line.amount]);
  };
  app.post('/api/cost-shares', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const input = await shareInput(sql, body(request));
    const code = (await allocateByRule(sql, actor.tenant_id, '成本分摊单号')) || await dailyCode(sql, actor.tenant_id, 'FT');
    const id = (await sql.query<{ id: string }>('INSERT INTO cost_shares(tenant_id,code,name,expense_type,amount,period_start,period_end,method,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [actor.tenant_id, code, input.name, input.expenseType, input.amount, input.from, input.to, input.method, input.note, actor.user_id])).rows[0]!.id;
    await saveLines(sql, actor.tenant_id, id, input.lines);
    return { id, code, lines: input.lines };
  })));
  app.post('/api/cost-shares/preview', (request) => read(request, async (sql) => {
    const input = await shareInput(sql, { ...body(request), name: body(request).name || '预览' });
    return { lines: input.lines };
  }));
  app.put<{ Params: { id: string } }>('/api/cost-shares/:id', (request) => write(request, async (sql, actor) => {
    const id = idText(request.params.id, '成本分摊', true)!;
    const before = (await sql.query<{ version: number; status: string }>('SELECT version,status FROM cost_shares WHERE id=$1 FOR UPDATE', [id])).rows[0];
    requireVersion(before, body(request).version, '成本分摊');
    if (before!.status === '已分摊') throw new Problem(409, 'SHARE_LOCKED', '已分摊的单据不能修改');
    const input = await shareInput(sql, body(request));
    await sql.query('UPDATE cost_shares SET name=$1,expense_type=$2,amount=$3,period_start=$4,period_end=$5,method=$6,note=$7,version=version+1,updated_at=now() WHERE id=$8', [input.name, input.expenseType, input.amount, input.from, input.to, input.method, input.note, id]);
    await saveLines(sql, actor.tenant_id, id, input.lines);
    return { ok: true, lines: input.lines };
  }));
  app.post<{ Params: { id: string } }>('/api/cost-shares/:id/share', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '成本分摊', true);
    const row = (await sql.query<{ status: string; amount: string }>('SELECT status,amount::text FROM cost_shares WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '成本分摊不存在');
    if (row.status === '已分摊') throw new Problem(409, 'SHARE_LOCKED', '该单据已分摊');
    const sum = (await sql.query<{ n: string; c: string }>('SELECT coalesce(sum(amount),0)::text AS n,count(*)::text AS c FROM cost_share_lines WHERE share_id=$1', [id])).rows[0]!;
    if (Number(sum.c) === 0) throw new Problem(422, 'LINES_REQUIRED', '没有分摊明细，不能分摊');
    if (centsOf(Number(sum.n).toFixed(2)) !== centsOf(Number(row.amount).toFixed(2))) throw new Problem(422, 'AMOUNT_MISMATCH', '明细金额合计必须等于分摊金额');
    await sql.query("UPDATE cost_shares SET status='已分摊',shared_at=now(),version=version+1,updated_at=now() WHERE id=$1", [id]);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/cost-shares/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '成本分摊', true);
    const row = (await sql.query<{ status: string }>('SELECT status FROM cost_shares WHERE id=$1', [id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '成本分摊不存在');
    if (row.status === '已分摊') throw new Problem(409, 'SHARE_LOCKED', '已分摊的单据不能删除');
    await sql.query('DELETE FROM cost_shares WHERE id=$1', [id]);
    return { ok: true };
  }));

  // 岗位安排（原版未采到）
  const postRows = async (sql: Sql, where: string, params: unknown[]) => (await sql.query<Row>(`SELECT p.id,p.name,p.shop_id,coalesce(s.name,'-') AS shop_name,p.line_id,coalesce(l.name,'-') AS line_name,p.process_ids,p.member_ids,coalesce(nullif(p.duty,''),'-') AS duty,coalesce(nullif(p.note,''),'-') AS note,
      (SELECT coalesce(string_agg(pr.name,'、' ORDER BY pr.name),'-') FROM processes pr WHERE pr.id = ANY(p.process_ids)) AS process_names,
      (SELECT coalesce(string_agg(m.display_name,'、' ORDER BY m.display_name),'-') FROM tenant_team_members m WHERE m.id = ANY(p.member_ids)) AS member_names,
      coalesce(c.display_name,'-') AS creator_name,${shanghaiTime('p.created_at')} AS created_text,p.version
    FROM posts p LEFT JOIN r8_shops s ON s.tenant_id=p.tenant_id AND s.id=p.shop_id LEFT JOIN r8_lines l ON l.tenant_id=p.tenant_id AND l.id=p.line_id LEFT JOIN tenant_team_members c ON c.id=p.created_by
    WHERE ${where} ORDER BY p.created_at DESC,p.id`, params)).rows;
  app.get('/api/posts', (request) => read(request, async (sql) => {
    const qs = query(request);
    const f = filters();
    f.add((n) => `p.name ILIKE ${n}`, like(qs.keyword ?? qs.name));
    f.add((n) => `p.shop_id=${n}::uuid`, idText(qs.shop_id, '车间'));
    f.add((n) => `p.line_id=${n}::uuid`, idText(qs.line_id, '产线'));
    f.add((n) => `${n}::uuid = ANY(p.process_ids)`, idText(qs.process_id, '工序'));
    const items = await postRows(sql, f.where.join(' AND '), f.params);
    const { size, offset, page } = pageOf(qs);
    return { total: items.length, page, page_size: size, items: items.slice(offset, offset + size) };
  }));
  app.get<{ Params: { id: string } }>('/api/posts/:id/members', (request) => read(request, async (sql) => {
    const post = (await sql.query<{ member_ids: string[] }>('SELECT member_ids FROM posts WHERE id=$1', [idText(request.params.id, '岗位', true)])).rows[0];
    if (!post) throw new Problem(404, 'NOT_FOUND', '岗位不存在');
    return { items: (await sql.query('SELECT id,display_name FROM tenant_team_members WHERE id = ANY($1::uuid[]) ORDER BY display_name', [post.member_ids])).rows };
  }));
  const postInput = async (sql: Sql, input: Row) => {
    const shopId = idText(input.shop_id, '车间');
    if (shopId && !(await sql.query('SELECT 1 FROM r8_shops WHERE id=$1', [shopId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '车间不存在');
    const lineId = idText(input.line_id, '产线');
    if (lineId && !(await sql.query('SELECT 1 FROM r8_lines WHERE id=$1', [lineId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '产线不存在');
    const processIds = idList(input.process_ids, '关联工序', 200);
    if (processIds.length && Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM processes WHERE id = ANY($1::uuid[])', [processIds])).rows[0]!.n) !== processIds.length) throw new Problem(422, 'INVALID_REFERENCE', '关联工序不存在');
    const memberIds = idList(input.member_ids, '在岗人员', 500);
    if (memberIds.length && Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM tenant_team_members WHERE id = ANY($1::uuid[])', [memberIds])).rows[0]!.n) !== memberIds.length) throw new Problem(422, 'INVALID_REFERENCE', '在岗人员不存在或已停用');
    return [text(input.name, 60, '岗位名称', true), shopId, lineId, processIds, memberIds, text(input.duty, 500, '岗位职责'), text(input.note, 255, '备注')] as const;
  };
  app.post('/api/posts', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const input = await postInput(sql, body(request));
    if ((await sql.query('SELECT 1 FROM posts WHERE name=$1', [input[0]])).rows[0]) throw new Problem(409, 'DUPLICATE', '岗位名称已存在');
    return { id: (await sql.query<{ id: string }>('INSERT INTO posts(tenant_id,name,shop_id,line_id,process_ids,member_ids,duty,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [actor.tenant_id, ...input, actor.user_id])).rows[0]!.id };
  })));
  app.put<{ Params: { id: string } }>('/api/posts/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '岗位', true);
    requireVersion((await sql.query<{ version: number }>('SELECT version FROM posts WHERE id=$1 FOR UPDATE', [id])).rows[0], body(request).version, '岗位');
    const input = await postInput(sql, body(request));
    if ((await sql.query('SELECT 1 FROM posts WHERE name=$1 AND id<>$2', [input[0], id])).rows[0]) throw new Problem(409, 'DUPLICATE', '岗位名称已存在');
    await sql.query('UPDATE posts SET name=$1,shop_id=$2,line_id=$3,process_ids=$4,member_ids=$5,duty=$6,note=$7,version=version+1,updated_at=now() WHERE id=$8', [...input, id]);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/posts/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM posts WHERE id=$1 RETURNING id', [idText(request.params.id, '岗位', true)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '岗位不存在');
    return { ok: true };
  }));

  app.get('/api/station-posts', (request) => read(request, async (sql) => {
    const qs = query(request);
    // 租户库无权读全局 memberships；角色/启停以 tenant_team_members + profiles 为准（与 /api/team-members 一致）。
    const members = (await sql.query<Row>(`SELECT m.id,coalesce(p.display_name,m.display_name) AS name,coalesce(d.name,'-') AS department,coalesce(tr.name,m.role,'-') AS role,'启用' AS status
      FROM tenant_team_members m
      LEFT JOIN tenant_member_profiles p ON p.user_id=m.id
      LEFT JOIN departments d ON d.id=p.department_id
      LEFT JOIN tenant_roles tr ON tr.id=p.custom_role_id
      ORDER BY name,m.id`)).rows;
    const produce = (await sql.query<{ user_id: string; names: string; ids: string }>('SELECT user_id,string_agg(pr.name,\'、\' ORDER BY pr.name) AS names,string_agg(pr.id::text,\',\' ORDER BY pr.name) AS ids FROM process_reporters r JOIN processes pr ON pr.id=r.process_id GROUP BY user_id')).rows;
    const inspect = (await sql.query<{ user_id: string; names: string; ids: string }>('SELECT user_id,string_agg(pr.name,\'、\' ORDER BY pr.name) AS names,string_agg(pr.id::text,\',\' ORDER BY pr.name) AS ids FROM process_inspectors i JOIN processes pr ON pr.id=i.process_id GROUP BY user_id')).rows;
    const produceMap = new Map(produce.map((row) => [row.user_id, row]));
    const inspectMap = new Map(inspect.map((row) => [row.user_id, row]));
    let items = members.map((row) => ({
      ...row,
      produce_names: produceMap.get(String(row.id))?.names ?? '-',
      inspect_names: inspectMap.get(String(row.id))?.names ?? '-',
      produce_ids: (produceMap.get(String(row.id))?.ids ?? '').split(',').filter(Boolean),
      inspect_ids: (inspectMap.get(String(row.id))?.ids ?? '').split(',').filter(Boolean),
    })) as Row[];
    if (qs.name) items = items.filter((row) => String(row.name ?? '').includes(String(qs.name)));
    return { total: items.length, items };
  }));
  app.put<{ Params: { id: string } }>('/api/station-posts/:id', (request) => write(request, async (sql, actor) => {
    const userId = idText(request.params.id, '人员', true);
    if (!(await sql.query('SELECT 1 FROM tenant_team_members WHERE id=$1', [userId])).rows[0]) throw new Problem(404, 'NOT_FOUND', '人员不存在');
    const produceIds = idList(body(request).produce_ids, '生产工序', 200);
    const inspectIds = idList(body(request).inspect_ids, '质检工序', 200);
    await sql.query('DELETE FROM process_reporters WHERE user_id=$1', [userId]);
    await sql.query('DELETE FROM process_inspectors WHERE user_id=$1', [userId]);
    for (const processId of produceIds) await sql.query('INSERT INTO process_reporters(tenant_id,process_id,user_id) VALUES($1,$2,$3)', [actor.tenant_id, processId, userId]);
    for (const processId of inspectIds) await sql.query('INSERT INTO process_inspectors(tenant_id,process_id,user_id) VALUES($1,$2,$3)', [actor.tenant_id, processId, userId]);
    return { ok: true };
  }));

  // 工序附加组件
  const componentList = async (sql: Sql, where: string, params: unknown[]) => {
    const rows = (await sql.query<Row>(`SELECT c.id,c.title,coalesce(nullif(c.note,''),'-') AS note,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('c.created_at')} AS created_text,c.version
      FROM process_components c LEFT JOIN tenant_team_members m ON m.id=c.created_by WHERE ${where} ORDER BY c.created_at DESC,c.id`, params)).rows;
    const items = [];
    for (const row of rows) {
      const fields = (await sql.query<Row>('SELECT id,sort_no,name,description,field_type,required,options,formula,decimals FROM process_component_fields WHERE component_id=$1 ORDER BY sort_no,name', [row.id])).rows.map((field): Row => ({ ...field, required_text: field.required ? '是' : '否' }));
      items.push({ ...row, fields, field_names: fields.map((field) => field.name).join('、') || '-' });
    }
    return items;
  };
  app.get('/api/process-components', (request) => read(request, async (sql) => {
    const qs = query(request);
    const f = filters();
    f.add((n) => `c.title ILIKE ${n}`, like(qs.keyword ?? qs.title));
    f.add((n) => `c.note ILIKE ${n}`, like(qs.note));
    f.add((n) => `c.created_by=${n}::uuid`, idText(qs.creator_id, '创建人'));
    const items = await componentList(sql, f.where.join(' AND '), f.params);
    const { size, offset, page } = pageOf(qs);
    return { total: items.length, page, page_size: size, items: items.slice(offset, offset + size), field_types: componentFieldTypes };
  }));
  app.get<{ Params: { id: string } }>('/api/process-components/:id', (request) => read(request, async (sql) => {
    const item = (await componentList(sql, 'c.id=$1', [idText(request.params.id, '工序附加组件', true)]))[0];
    if (!item) throw new Problem(404, 'NOT_FOUND', '工序附加组件不存在');
    return { component: item };
  }));
  const componentFields = (value: unknown) => {
    if (!Array.isArray(value)) return [];
    if (value.length > 50) throw new Problem(422, 'TOO_MANY', '字段最多50个');
    const names = new Set<string>();
    return (value as Row[]).map((raw, index) => {
      const name = text(raw.name, 40, '字段', true);
      if (names.has(name)) throw new Problem(422, 'DUPLICATE_FIELD', `字段「${name}」重复`);
      names.add(name);
      const type = oneOf(raw.field_type, componentFieldTypes, '字段类型');
      const formula = type === '公式' ? text(raw.formula, 500, '计算公式', true) : '';
      const options = type === '单选下拉框' || type === '多选下拉框' ? text(raw.options, 1000, '下拉框数据', true) : '';
      const decimals = type === '公式' && raw.decimals !== undefined && raw.decimals !== null && raw.decimals !== '' ? intIn(raw.decimals, 0, 8, '小数位数') : null;
      return { sort_no: intIn(raw.sort_no, 0, 9999, '排序', index + 1), name, description: text(raw.description, 255, '检查项说明'), field_type: type, required: type === '公式' ? false : raw.required === true || raw.required === '是', options, formula, decimals };
    });
  };
  const saveFields = async (sql: Sql, tenantId: string, componentId: string, fields: ReturnType<typeof componentFields>) => {
    await sql.query('DELETE FROM process_component_fields WHERE component_id=$1', [componentId]);
    for (const field of fields) await sql.query('INSERT INTO process_component_fields(tenant_id,component_id,sort_no,name,description,field_type,required,options,formula,decimals) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [tenantId, componentId, field.sort_no, field.name, field.description, field.field_type, field.required, field.options, field.formula, field.decimals]);
  };
  app.post('/api/process-components', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const title = text(body(request).title, 60, '标题', true);
    const fields = componentFields(body(request).fields);
    if ((await sql.query('SELECT 1 FROM process_components WHERE title=$1', [title])).rows[0]) throw new Problem(409, 'DUPLICATE', '组件标题已存在');
    const id = (await sql.query<{ id: string }>('INSERT INTO process_components(tenant_id,title,note,created_by) VALUES($1,$2,$3,$4) RETURNING id', [actor.tenant_id, title, text(body(request).note, 255, '备注'), actor.user_id])).rows[0]!.id;
    await saveFields(sql, actor.tenant_id, id, fields);
    return { id };
  })));
  app.put<{ Params: { id: string } }>('/api/process-components/:id', (request) => write(request, async (sql, actor) => {
    const id = idText(request.params.id, '工序附加组件', true)!;
    requireVersion((await sql.query<{ version: number }>('SELECT version FROM process_components WHERE id=$1 FOR UPDATE', [id])).rows[0], body(request).version, '工序附加组件');
    const title = text(body(request).title, 60, '标题', true);
    if ((await sql.query('SELECT 1 FROM process_components WHERE title=$1 AND id<>$2', [title, id])).rows[0]) throw new Problem(409, 'DUPLICATE', '组件标题已存在');
    const fields = componentFields(body(request).fields);
    await sql.query('UPDATE process_components SET title=$1,note=$2,version=version+1,updated_at=now() WHERE id=$3', [title, text(body(request).note, 255, '备注'), id]);
    await saveFields(sql, actor.tenant_id, id, fields);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/process-components/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '工序附加组件', true);
    const used = (await sql.query<{ name: string }>('SELECT name FROM processes WHERE report_component_id=$1 OR qc_component_id=$1 LIMIT 1', [id])).rows[0];
    if (used) throw new Problem(409, 'COMPONENT_IN_USE', `组件已被工序「${used.name}」引用，不能删除`);
    if ((await sql.query('SELECT 1 FROM work_order_tasks WHERE report_component_id=$1 OR qc_component_id=$1 LIMIT 1', [id])).rows[0]) throw new Problem(409, 'COMPONENT_IN_USE', '组件已被生产任务引用，不能删除');
    if (!(await sql.query('DELETE FROM process_components WHERE id=$1 RETURNING id', [id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '工序附加组件不存在');
    return { ok: true };
  }));
  app.put<{ Params: { id: string } }>('/api/process-components/bind/:id', (request) => write(request, async (sql) => {
    const processId = idText(request.params.id, '工序', true);
    const input = body(request);
    const reportId = idText(input.report_component_id, '报工附加组件');
    const qcId = idText(input.qc_component_id, '质检附加组件');
    for (const id of [reportId, qcId]) if (id && !(await sql.query('SELECT 1 FROM process_components WHERE id=$1', [id])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '工序附加组件不存在');
    if (!(await sql.query('UPDATE processes SET report_component_id=$1,qc_component_id=$2,updated_at=now() WHERE id=$3 RETURNING id', [reportId, qcId, processId])).rows[0]) throw new Problem(404, 'NOT_FOUND', '工序不存在');
    return { ok: true };
  }));

  // 溯源码管理（原版列表未采到）
  app.get('/api/trace-codes', (request) => read(request, async (sql) => {
    const qs = query(request);
    const { size, offset, page } = pageOf(qs);
    const f = filters();
    if (qs.code) f.add((n) => `t.code::text LIKE ${n}`, like(qs.code));
    f.add((n) => `(p.name ILIKE ${n} OR p.code ILIKE ${n})`, like(qs.product));
    f.add((n) => `w.code ILIKE ${n}`, like(qs.work_order_code));
    f.add((n) => `t.work_order_id=${n}::uuid`, idText(qs.work_order_id, '加工单'));
    if (qs.status) f.add((n) => `t.status=${n}`, oneOf(qs.status, ['未使用', '已使用', '作废'] as const, '状态'));
    const from = `FROM trace_codes t JOIN products p ON p.tenant_id=t.tenant_id AND p.id=t.product_id JOIN work_orders w ON w.tenant_id=t.tenant_id AND w.id=t.work_order_id LEFT JOIN tenant_team_members m ON m.id=t.created_by WHERE ${f.where.join(' AND ')}`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, f.params)).rows[0]!.n);
    const items = (await sql.query<Row>(`SELECT t.id,t.code::text,p.name AS product_name,p.code AS product_code,t.work_order_id,w.code AS work_order_code,t.qty::text,t.status,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('t.created_at')} AS created_text
      ${from} ORDER BY t.code DESC LIMIT ${size} OFFSET ${offset}`, f.params)).rows.map((row) => ({ ...row, qty: qtyText(q(String(row.qty))) }));
    return { total, page, page_size: size, items };
  }));
  app.post('/api/trace-codes/batch', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const input = body(request);
    const workOrderId = idText(input.work_order_id, '加工单', true);
    const order = (await sql.query<{ product_id: string }>('SELECT product_id FROM work_orders WHERE id=$1', [workOrderId])).rows[0];
    if (!order) throw new Problem(422, 'INVALID_REFERENCE', '加工单不存在');
    const count = intIn(input.count, 1, 500, '生成张数');
    const qty = decimalText(input.qty ?? '1', '每张数量', 6, false);
    const end = (await sql.query<{ value: number }>(`INSERT INTO r8_counters(tenant_id,series,value) VALUES($1,'TRACE',$2)
      ON CONFLICT (tenant_id,series) DO UPDATE SET value=r8_counters.value+$2 RETURNING value`, [actor.tenant_id, count])).rows[0]!.value;
    const codes: number[] = [];
    for (let n = end - count + 1; n <= end; n += 1) codes.push(TRACE_BASE + n);
    for (const code of codes) await sql.query('INSERT INTO trace_codes(tenant_id,code,product_id,work_order_id,qty,created_by) VALUES($1,$2,$3,$4,$5,$6)', [actor.tenant_id, code, order.product_id, workOrderId, qty, actor.user_id]);
    return { codes: codes.map(String), first: String(codes[0]), last: String(codes[codes.length - 1]) };
  })));
  app.post<{ Params: { id: string } }>('/api/trace-codes/:id/status', (request) => write(request, async (sql) => {
    const status = oneOf(body(request).status, ['已使用', '作废'] as const, '状态');
    const row = (await sql.query<{ status: string }>('SELECT status FROM trace_codes WHERE id=$1 FOR UPDATE', [idText(request.params.id, '溯源码', true)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '溯源码不存在');
    if (row.status === '作废') throw new Problem(409, 'TRACE_VOID', '溯源码已作废');
    await sql.query('UPDATE trace_codes SET status=$1 WHERE id=$2', [status, request.params.id]);
    return { ok: true };
  }));
  app.get<{ Params: { id: string } }>('/api/trace-codes/:id/detail', (request) => read(request, async (sql) => {
    const trace = (await sql.query<Row>(`SELECT t.id,t.code::text,t.qty::text,t.status,t.work_order_id,p.name AS product_name,p.code AS product_code,coalesce(nullif(p.specification,''),'-') AS specification,w.code AS work_order_code,w.execution,w.plan_qty::text
      FROM trace_codes t JOIN products p ON p.tenant_id=t.tenant_id AND p.id=t.product_id JOIN work_orders w ON w.tenant_id=t.tenant_id AND w.id=t.work_order_id WHERE t.id=$1`, [idText(request.params.id, '溯源码', true)])).rows[0];
    if (!trace) throw new Problem(404, 'NOT_FOUND', '溯源码不存在');
    const tasks = (await sql.query<Row>(`SELECT t.id,t.sequence,coalesce(t.process_snapshot->>'name','') AS process_name,t.execution,t.plan_qty::text,t.approved_good::text,t.approved_defect::text FROM work_order_tasks t WHERE t.work_order_id=$1 ORDER BY t.sequence`, [trace.work_order_id])).rows;
    const reports = (await sql.query<Row>(`SELECT r.task_id,r.code,coalesce(m.display_name,'-') AS operator_name,${shanghaiTime('r.created_at')} AS reported_text,r.good_qty::text,r.defect_qty::text,
        CASE r.quality_status WHEN 'done' THEN '已质检' WHEN 'pending' THEN '待质检' ELSE '不需质检' END AS quality_text,coalesce(${shanghaiTime('r.quality_at')},'-') AS quality_time
      FROM production_reports r LEFT JOIN tenant_team_members m ON m.id=r.operator_id WHERE r.work_order_id=$1 AND r.approval='approved' ORDER BY r.created_at`, [trace.work_order_id])).rows;
    const spots = (await sql.query<Row>(`SELECT s.code,s.qty::text,s.good_qty::text,s.defect_qty::text,s.quality_status,${shanghaiTime('s.created_at')} AS created_text FROM r8_spot_checks s WHERE s.work_order_id=$1 ORDER BY s.created_at`, [trace.work_order_id])).rows;
    const receipts = (await sql.query<Row>(`SELECT code,quantity::text,${shanghaiTime('created_at')} AS created_text FROM fg_receipts WHERE work_order_id=$1 AND approval='approved' ORDER BY created_at`, [trace.work_order_id])).rows;
    const qty = (value: unknown) => qtyText(q(String(value ?? '0')));
    return {
      trace: { ...trace, qty: qty(trace.qty), plan_qty: qty(trace.plan_qty), execution_text: executionText[String(trace.execution)] ?? '-' },
      processes: tasks.map((task) => ({ ...task, plan_qty: qty(task.plan_qty), approved_good: qty(task.approved_good), approved_defect: qty(task.approved_defect), execution_text: executionText[String(task.execution)] ?? '-', reports: reports.filter((report) => report.task_id === task.id).map((report) => ({ ...report, good_qty: qty(report.good_qty), defect_qty: qty(report.defect_qty) })) })),
      spot_checks: spots.map((spot) => ({ ...spot, qty: qty(spot.qty), good_qty: qty(spot.good_qty), defect_qty: qty(spot.defect_qty) })),
      receipts: receipts.map((receipt) => ({ ...receipt, quantity: qty(receipt.quantity) })),
    };
  }));
  app.get('/api/trace-codes/by-work-orders', (request) => read(request, async (sql) => {
    const ids = String(query(request).ids ?? '').split(',').filter(Boolean);
    const list = idList(ids, '加工单', 500);
    const rows = (await sql.query<{ work_order_id: string; codes: string; qty: string }>(`SELECT work_order_id,string_agg(code::text,',' ORDER BY code) AS codes,sum(qty)::text AS qty FROM trace_codes WHERE work_order_id = ANY($1::uuid[]) AND status<>'作废' GROUP BY work_order_id`, [list])).rows;
    return { items: rows.map((row) => ({ work_order_id: row.work_order_id, codes: row.codes, qty: qtyText(q(row.qty)) })) };
  }));

  // 物料分析（独立页原版未采到；列取生产计划详情「物料分析」页签）
  app.get('/api/material-analysis', (request) => read(request, async (sql) => {
    const qs = query(request);
    const { size, offset, page } = pageOf(qs);
    const f = filters();
    f.add((n) => `p.code ILIKE ${n}`, like(qs.plan_code));
    f.add((n) => `p.name ILIKE ${n}`, like(qs.plan_name));
    f.add((n) => `m.display_name ILIKE ${n}`, like(qs.analyst));
    f.add((n) => `(a.created_at AT TIME ZONE 'Asia/Shanghai')::date>=${n}::date`, dateText(qs.from, '分析时间起'));
    f.add((n) => `(a.created_at AT TIME ZONE 'Asia/Shanghai')::date<=${n}::date`, dateText(qs.to, '分析时间止'));
    if (qs.status === '有效') f.where.push("a.status='active'");
    if (qs.status === '已作废') f.where.push("a.status='void'");
    const from = `FROM production_plan_analyses a JOIN production_plans p ON p.tenant_id=a.tenant_id AND p.id=a.plan_id LEFT JOIN tenant_team_members m ON m.id=a.created_by WHERE ${f.where.join(' AND ')}`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, f.params)).rows[0]!.n);
    const rows = (await sql.query<Row>(`SELECT a.id,a.plan_id,p.code AS plan_code,p.name AS plan_name,a.line_no,a.status,coalesce(nullif(p.note,''),'-') AS note,coalesce(m.display_name,'-') AS analyst_name,${shanghaiTime('a.created_at')} AS analyzed_text,
        a.process_demand_qty::text,a.outsource_demand_qty::text,a.purchase_demand_qty::text,
        (SELECT coalesce(string_agg(w.code,',' ORDER BY w.code),'') FROM work_orders w JOIN production_plan_lines l ON l.tenant_id=w.tenant_id AND l.id=w.production_plan_line_id WHERE l.plan_id=a.plan_id AND w.created_at>=a.created_at) AS work_order_codes,
        (SELECT coalesce(string_agg(o.code,',' ORDER BY o.code),'') FROM r8_out_orders o WHERE o.plan_analysis_id=a.id) AS outsource_codes,
        (SELECT coalesce(string_agg(DISTINCT po.code,','),'') FROM money_purchase_line_meta mm JOIN purchase_orders po ON po.tenant_id=mm.tenant_id AND po.id=mm.order_id WHERE mm.plan_analysis_id=a.id) AS purchase_codes
      ${from} ORDER BY a.created_at DESC,a.id LIMIT ${size} OFFSET ${offset}`, f.params)).rows;
    const split = (value: unknown) => String(value ?? '').split(',').filter(Boolean);
    return {
      total, page, page_size: size,
      items: rows.map((row) => ({
        ...row, status_text: row.status === 'void' ? '已作废' : '有效',
        process_demand_qty: qtyText(q(String(row.process_demand_qty))), outsource_demand_qty: qtyText(q(String(row.outsource_demand_qty))), purchase_demand_qty: qtyText(q(String(row.purchase_demand_qty))),
        work_orders: split(row.work_order_codes), outsource_orders: split(row.outsource_codes), purchase_orders: split(row.purchase_codes),
        work_order_count: split(row.work_order_codes).length, outsource_count: split(row.outsource_codes).length, purchase_count: split(row.purchase_codes).length,
      })),
    };
  }));
  app.delete<{ Params: { id: string } }>('/api/material-analysis/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '物料分析', true);
    const row = (await sql.query<{ status: string; plan_id: string }>('SELECT status,plan_id FROM production_plan_analyses WHERE id=$1', [id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '物料分析不存在');
    if (row.status !== 'void') throw new Problem(409, 'NOT_VOID', '只能删除已作废的物料分析');
    await sql.query('DELETE FROM production_plan_analysis_lines WHERE analysis_id=$1', [id]);
    await sql.query('DELETE FROM production_plan_analyses WHERE id=$1', [id]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/material-analysis/:id/link', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '物料分析', true);
    const analysis = (await sql.query<{ status: string }>('SELECT status FROM production_plan_analyses WHERE id=$1', [id])).rows[0];
    if (!analysis) throw new Problem(404, 'NOT_FOUND', '物料分析不存在');
    if (analysis.status === 'void') throw new Problem(409, 'ANALYSIS_VOID', '物料分析已作废，不能关联单据');
    const kind = oneOf(body(request).kind, ['outsource', 'purchase'] as const, '单据类型');
    const orderId = idText(body(request).order_id, kind === 'outsource' ? '外协工单' : '采购单', true);
    const updated = kind === 'outsource'
      ? await sql.query('UPDATE r8_out_orders SET plan_analysis_id=$1 WHERE id=$2 RETURNING id', [id, orderId])
      : await sql.query('UPDATE money_purchase_line_meta SET plan_analysis_id=$1 WHERE order_id=$2 RETURNING line_id', [id, orderId]);
    if (!updated.rows[0]) throw new Problem(404, 'NOT_FOUND', kind === 'outsource' ? '外协工单不存在' : '采购单不存在');
    return { ok: true };
  }));
  app.get<{ Params: { id: string } }>('/api/production-plans/:id/linked-orders', (request) => read(request, async (sql) => {
    const planId = idText(request.params.id, '生产计划', true);
    const outsource = (await sql.query<Row>(`SELECT o.id,o.code,p.name AS product_name,p.code AS product_code,coalesce(nullif(p.specification,''),'-') AS specification,o.plan_qty::text,coalesce(s.name,'-') AS supplier_name,o.status,
        coalesce(to_char(o.due_date,'YYYY-MM-DD'),'-') AS due_date,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('o.created_at')} AS created_text
      FROM r8_out_orders o JOIN production_plan_analyses a ON a.tenant_id=o.tenant_id AND a.id=o.plan_analysis_id JOIN products p ON p.tenant_id=o.tenant_id AND p.id=o.product_id
      LEFT JOIN suppliers s ON s.tenant_id=o.tenant_id AND s.id=o.supplier_id LEFT JOIN tenant_team_members m ON m.id=o.created_by WHERE a.plan_id=$1 ORDER BY o.created_at DESC`, [planId])).rows
      .map((row) => ({ ...row, plan_qty: qtyText(q(String(row.plan_qty))) }));
    const purchase = (await sql.query<Row>(`SELECT DISTINCT ON (po.id) po.id,po.code,s.name AS supplier_name,to_char(po.order_date,'YYYY-MM-DD') AS order_date,to_char(po.due_date,'YYYY-MM-DD') AS due_date,po.approval,po.lifecycle,
        (SELECT sum(l.quantity) FROM purchase_order_lines l WHERE l.order_id=po.id)::text AS qty,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('po.created_at')} AS created_text
      FROM money_purchase_line_meta mm JOIN production_plan_analyses a ON a.tenant_id=mm.tenant_id AND a.id=mm.plan_analysis_id JOIN purchase_orders po ON po.tenant_id=mm.tenant_id AND po.id=mm.order_id
      JOIN suppliers s ON s.tenant_id=po.tenant_id AND s.id=po.supplier_id LEFT JOIN tenant_team_members m ON m.id=po.created_by WHERE a.plan_id=$1 ORDER BY po.id,po.created_at DESC`, [planId])).rows
      .map((row) => ({ ...row, qty: qtyText(q(String(row.qty ?? '0'))), approval_text: ({ pending: '待审', approved: '通过', rejected: '退回', withdrawn: '撤回' } as Record<string, string>)[String(row.approval)] ?? '-' }));
    return { outsource_orders: outsource, purchase_orders: purchase };
  }));

  // 加工单进度分享
  app.post('/api/work-order-shares', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const workOrderId = idText(body(request).work_order_id, '加工单', true);
    if (!(await sql.query('SELECT 1 FROM work_orders WHERE id=$1', [workOrderId])).rows[0]) throw new Problem(404, 'NOT_FOUND', '加工单不存在');
    const days = intIn(body(request).expires_days, 0, 3650, '有效天数', 0);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const token = [...randomBytes(32)].map((byte) => alphabet[byte % alphabet.length]).join('');
    const row = (await sql.query<{ id: string }>(`INSERT INTO work_order_shares(tenant_id,token,work_order_id,created_by,expires_at) VALUES($1,$2,$3,$4,CASE WHEN $5::integer>0 THEN now()+make_interval(days=>$5::integer) END) RETURNING id`, [actor.tenant_id, token, workOrderId, actor.user_id, days])).rows[0]!;
    await sql.query('INSERT INTO work_order_share_tokens(token,tenant_id,user_id) VALUES($1,$2,$3)', [token, actor.tenant_id, actor.user_id]);
    return { id: row.id, token, path: `/share/wo/${token}` };
  })));
  app.get('/api/work-order-shares', (request) => read(request, async (sql) => {
    const workOrderId = idText(query(request).work_order_id, '加工单', true);
    return { items: (await sql.query(`SELECT s.id,s.token,'/share/wo/'||s.token AS path,coalesce(${shanghaiTime('s.expires_at')},'-') AS expires_text,s.revoked_at IS NOT NULL AS revoked,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('s.created_at')} AS created_text
      FROM work_order_shares s LEFT JOIN tenant_team_members m ON m.id=s.created_by WHERE s.work_order_id=$1 ORDER BY s.created_at DESC`, [workOrderId])).rows };
  }));
  app.delete<{ Params: { id: string } }>('/api/work-order-shares/:id', (request) => write(request, async (sql) => {
    const row = (await sql.query<{ token: string }>('UPDATE work_order_shares SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING token', [idText(request.params.id, '分享链接', true)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '分享链接不存在');
    await sql.query('DELETE FROM work_order_share_tokens WHERE token=$1', [row.token]);
    return { ok: true };
  }));
  app.get<{ Params: { token: string } }>('/api/public/share/wo/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const token = String(request.params.token ?? '');
    const gone = () => new Problem(404, 'SHARE_EXPIRED', '链接已失效');
    if (!/^[A-Za-z0-9]{32}$/.test(token)) throw gone();
    const owner = await services.database.auth(async (sql) => (await sql.query<{ tenant_id: string; user_id: string }>('SELECT tenant_id,user_id FROM work_order_share_tokens WHERE token=$1', [token])).rows[0]);
    if (!owner) throw gone();
    return services.database.tenant({ tenantId: owner.tenant_id, userId: owner.user_id }, async (sql) => {
      const share = (await sql.query<{ work_order_id: string }>('SELECT work_order_id FROM work_order_shares WHERE token=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())', [token])).rows[0];
      if (!share) throw gone();
      const order = (await sql.query<Row>(`SELECT w.id,w.code,w.execution,w.plan_qty::text,coalesce(w.product_snapshot->>'name','') AS product_name,coalesce(w.product_snapshot->>'code','') AS product_code,
          coalesce(nullif(p.specification,''),'-') AS specification,coalesce(c.name,'-') AS category_name,p.images
        FROM work_orders w JOIN products p ON p.tenant_id=w.tenant_id AND p.id=w.product_id LEFT JOIN product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id WHERE w.id=$1`, [share.work_order_id])).rows[0];
      if (!order) throw gone();
      const tasks = (await sql.query<{ name: string; plan_qty: string; approved_good: string; execution: string }>("SELECT coalesce(process_snapshot->>'name','') AS name,plan_qty::text,approved_good::text,execution FROM work_order_tasks WHERE work_order_id=$1 ORDER BY sequence", [share.work_order_id])).rows;
      const received = (await sql.query<{ n: string }>(`SELECT ${receivedQtySql('$1::uuid')}::text AS n`, [share.work_order_id])).rows[0]!.n;
      const images = Array.isArray(order.images) ? order.images : [];
      return {
        work_order: {
          code: order.code, execution_text: executionText[String(order.execution)] ?? '-', product_name: order.product_name, product_code: order.product_code, specification: order.specification, category_name: order.category_name,
          product_image: images[0] ?? null, plan_qty: qtyText(q(String(order.plan_qty))), progress: progressLabel(received, String(order.plan_qty)),
          processes: tasks.map((task) => ({ name: task.name, execution_text: executionText[task.execution] ?? '-', progress: progressLabel(task.approved_good, task.plan_qty) })),
        },
      };
    });
  });

  // 列配置偏好（按用户、按页面）
  const prefsJson = (value: unknown) => {
    const raw = value && typeof value === 'object' ? value as Row : {};
    const asKeys = (item: unknown) => Array.isArray(item) ? item.map(String).filter(Boolean).slice(0, 80) : [];
    const prefs = { order: asKeys(raw.order), visible: asKeys(raw.visible).slice(0, 50), locked: asKeys(raw.locked) };
    const json = JSON.stringify(prefs);
    if (json.length > 20000) throw new Problem(422, 'TOO_LONG', '列配置内容过长');
    return { prefs, json };
  };
  app.get('/api/list-column-prefs', (request) => member(services, request, false, async (sql, actor) => {
    const pageKey = text(query(request).page_key, 80, '页面', true);
    const row = (await sql.query<{ prefs: unknown; version: number }>('SELECT prefs,version FROM list_column_prefs WHERE user_id=$1 AND page_key=$2', [actor.user_id, pageKey])).rows[0];
    return row ? { prefs: row.prefs, version: row.version } : { prefs: null, version: 0 };
  }));
  app.put('/api/list-column-prefs', (request) => member(services, request, true, async (sql, actor) => {
    const input = body(request);
    const pageKey = text(input.page_key, 80, '页面', true);
    const { prefs, json } = prefsJson(input.prefs);
    const before = (await sql.query<{ version: number }>('SELECT version FROM list_column_prefs WHERE user_id=$1 AND page_key=$2 FOR UPDATE', [actor.user_id, pageKey])).rows[0];
    if (before && input.version !== undefined) requireVersion(before, input.version, '列配置');
    await sql.query(
      `INSERT INTO list_column_prefs(tenant_id,user_id,page_key,prefs,version,updated_at) VALUES($1,$2,$3,$4::jsonb,1,now())
       ON CONFLICT (tenant_id,user_id,page_key) DO UPDATE SET prefs=EXCLUDED.prefs, version=list_column_prefs.version+1, updated_at=now()`,
      [actor.tenant_id, actor.user_id, pageKey, json],
    );
    const saved = (await sql.query<{ prefs: unknown; version: number }>('SELECT prefs,version FROM list_column_prefs WHERE user_id=$1 AND page_key=$2', [actor.user_id, pageKey])).rows[0]!;
    return { prefs: saved.prefs ?? prefs, version: saved.version };
  }));
  app.post('/api/list-column-prefs/apply', (request) => member(services, request, true, async (sql, actor) => {
    if (actor.role !== 'admin' && !actor.permissions.includes('configuration.manage')) throw new Problem(403, 'FORBIDDEN', '只有管理员可以应用到其他人');
    const input = body(request);
    const pageKey = text(input.page_key, 80, '页面', true);
    const { json } = prefsJson(input.prefs);
    // 租户角色无权读 memberships；与 /api/team-members 一致走 tenant_team_members
    const others = (await sql.query<{ id: string }>('SELECT id FROM tenant_team_members WHERE id<>$1', [actor.user_id])).rows;
    for (const row of others) {
      await sql.query(
        `INSERT INTO list_column_prefs(tenant_id,user_id,page_key,prefs,version,updated_at) VALUES($1,$2,$3,$4::jsonb,1,now())
         ON CONFLICT (tenant_id,user_id,page_key) DO UPDATE SET prefs=EXCLUDED.prefs, version=list_column_prefs.version+1, updated_at=now()`,
        [actor.tenant_id, row.id, pageKey, json],
      );
    }
    return { applied: others.map((row) => row.id), count: others.length };
  }));

  // 列表视图（按用户、按页面）
  const viewJson = (value: unknown, label: string, fallback: unknown) => {
    const data = value === undefined ? fallback : value;
    const json = JSON.stringify(data);
    if (json.length > 20000) throw new Problem(422, 'TOO_LONG', `${label}内容过长`);
    return json;
  };
  const viewSelect = `id,page_key,name,conditions,columns,sort,sort_no,icon,scope,field_permissions,filters,default_sort,version,${shanghaiDate('created_at')} AS created_text`;
  const viewIcons = ['#1f1f1f', '#4184F4', '#1890ff', '#fa8c16', '#f5222d', '#722ed1'] as const;
  const viewScopes = ['personal', 'team', 'all'] as const;
  const conditionsFromFilters = (filters: unknown, fallback: unknown) => {
    if (!Array.isArray(filters)) return fallback;
    const out: Record<string, string> = {};
    for (const item of filters) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Row;
      const field = String(row.field ?? '').trim();
      const value = String(row.value ?? '').trim();
      if (field && value) out[field] = value;
    }
    return out;
  };
  app.get('/api/list-views', (request) => member(services, request, false, async (sql, actor) => {
    const pageKey = text(query(request).page_key, 80, '页面', true);
    return { items: (await sql.query(`SELECT ${viewSelect} FROM list_views WHERE user_id=$1 AND page_key=$2 ORDER BY sort_no,created_at`, [actor.user_id, pageKey])).rows };
  }));
  app.post('/api/list-views', async (request, reply) => reply.code(201).send(await member(services, request, true, async (sql, actor) => {
    const input = body(request);
    const pageKey = text(input.page_key, 80, '页面', true);
    const name = text(input.name, 20, '视图名称', true);
    if ((await sql.query('SELECT 1 FROM list_views WHERE user_id=$1 AND page_key=$2 AND name=$3', [actor.user_id, pageKey, name])).rows[0]) throw new Problem(409, 'DUPLICATE', '视图名称已存在');
    const next = Number((await sql.query<{ n: string }>('SELECT coalesce(max(sort_no),0)+1 AS n FROM list_views WHERE user_id=$1 AND page_key=$2', [actor.user_id, pageKey])).rows[0]!.n);
    const icon = input.icon === undefined || input.icon === null || input.icon === '' ? null : oneOf(String(input.icon), viewIcons, '图标');
    const scope = oneOf(input.scope ?? 'personal', viewScopes, '使用范围', 'personal');
    const filters = input.filters === undefined ? [] : input.filters;
    const conditions = input.conditions === undefined ? conditionsFromFilters(filters, {}) : input.conditions;
    const defaultSort = input.default_sort === undefined ? (input.sort ?? {}) : input.default_sort;
    const row = (await sql.query<{ id: string }>(
      `INSERT INTO list_views(tenant_id,user_id,page_key,name,conditions,columns,sort,sort_no,icon,scope,field_permissions,filters,default_sort)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb) RETURNING id`,
      [actor.tenant_id, actor.user_id, pageKey, name, viewJson(conditions, '查询条件', {}), viewJson(input.columns, '列', []), viewJson(defaultSort, '排序', {}), next, icon, scope, viewJson(input.field_permissions, '字段权限', {}), viewJson(filters, '数据过滤', []), viewJson(defaultSort, '默认排序', {})],
    )).rows[0]!;
    return { id: row.id };
  })));
  app.put<{ Params: { id: string } }>('/api/list-views/:id', (request) => member(services, request, true, async (sql, actor) => {
    const id = idText(request.params.id, '视图', true);
    const input = body(request);
    const before = (await sql.query<{ page_key: string; name: string; conditions: unknown; columns: unknown; sort: unknown; icon: string | null; scope: string; field_permissions: unknown; filters: unknown; default_sort: unknown; version: number }>(
      'SELECT page_key,name,conditions,columns,sort,icon,scope,field_permissions,filters,default_sort,version FROM list_views WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, actor.user_id],
    )).rows[0];
    requireVersion(before, input.version, '视图');
    const name = input.name === undefined ? before!.name : text(input.name, 20, '视图名称', true);
    if ((await sql.query('SELECT 1 FROM list_views WHERE user_id=$1 AND page_key=$2 AND name=$3 AND id<>$4', [actor.user_id, before!.page_key, name, id])).rows[0]) throw new Problem(409, 'DUPLICATE', '视图名称已存在');
    const icon = input.icon === undefined ? before!.icon : (input.icon === null || input.icon === '' ? null : oneOf(String(input.icon), viewIcons, '图标'));
    const scope = input.scope === undefined ? before!.scope : oneOf(input.scope, viewScopes, '使用范围');
    const filters = input.filters === undefined ? before!.filters : input.filters;
    const conditions = input.conditions === undefined
      ? (input.filters === undefined ? before!.conditions : conditionsFromFilters(filters, before!.conditions))
      : input.conditions;
    const defaultSort = input.default_sort === undefined ? (input.sort === undefined ? before!.default_sort : input.sort) : input.default_sort;
    const sort = input.sort === undefined ? defaultSort : input.sort;
    await sql.query(
      `UPDATE list_views SET name=$1,conditions=$2::jsonb,columns=$3::jsonb,sort=$4::jsonb,icon=$5,scope=$6,
       field_permissions=$7::jsonb,filters=$8::jsonb,default_sort=$9::jsonb,version=version+1,updated_at=now() WHERE id=$10`,
      [name, viewJson(conditions, '查询条件', before!.conditions), viewJson(input.columns, '列', before!.columns), viewJson(sort, '排序', before!.sort),
        icon, scope, viewJson(input.field_permissions, '字段权限', before!.field_permissions), viewJson(filters, '数据过滤', before!.filters),
        viewJson(defaultSort, '默认排序', before!.default_sort), id],
    );
    return { ok: true };
  }));
  app.post('/api/list-views/reorder', (request) => member(services, request, true, async (sql, actor) => {
    const ids = idList(body(request).ids, '视图', 100);
    for (const [index, id] of ids.entries()) await sql.query('UPDATE list_views SET sort_no=$1 WHERE id=$2 AND user_id=$3', [index + 1, id, actor.user_id]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/list-views/:id/copy', async (request, reply) => reply.code(201).send(await member(services, request, true, async (sql, actor) => {
    const id = idText(request.params.id, '视图', true);
    const source = (await sql.query<{ page_key: string; name: string; conditions: unknown; columns: unknown; sort: unknown; icon: string | null; scope: string; field_permissions: unknown; filters: unknown; default_sort: unknown }>(
      'SELECT page_key,name,conditions,columns,sort,icon,scope,field_permissions,filters,default_sort FROM list_views WHERE id=$1 AND user_id=$2', [id, actor.user_id],
    )).rows[0];
    if (!source) throw new Problem(404, 'NOT_FOUND', '视图不存在');
    let name = `${source.name}-副本`.slice(0, 20);
    for (let index = 2; (await sql.query('SELECT 1 FROM list_views WHERE user_id=$1 AND page_key=$2 AND name=$3', [actor.user_id, source.page_key, name])).rows[0]; index += 1) {
      name = `${source.name}-副本${index}`.slice(0, 20);
    }
    const next = Number((await sql.query<{ n: string }>('SELECT coalesce(max(sort_no),0)+1 AS n FROM list_views WHERE user_id=$1 AND page_key=$2', [actor.user_id, source.page_key])).rows[0]!.n);
    const row = (await sql.query<{ id: string }>(
      `INSERT INTO list_views(tenant_id,user_id,page_key,name,conditions,columns,sort,sort_no,icon,scope,field_permissions,filters,default_sort)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb) RETURNING id`,
      [actor.tenant_id, actor.user_id, source.page_key, name, JSON.stringify(source.conditions ?? {}), JSON.stringify(source.columns ?? []), JSON.stringify(source.sort ?? {}), next,
        source.icon, source.scope || 'personal', JSON.stringify(source.field_permissions ?? {}), JSON.stringify(source.filters ?? []), JSON.stringify(source.default_sort ?? {})],
    )).rows[0]!;
    return { id: row.id, name };
  })));
  app.delete<{ Params: { id: string } }>('/api/list-views/:id', (request) => member(services, request, true, async (sql, actor) => {
    if (!(await sql.query('DELETE FROM list_views WHERE id=$1 AND user_id=$2 RETURNING id', [idText(request.params.id, '视图', true), actor.user_id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '视图不存在');
    return { ok: true };
  }));
}
