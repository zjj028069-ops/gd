import type { FastifyInstance } from 'fastify';
import { Problem, type Actor, type Services } from './services.js';
import type { Sql } from './database.js';
import { bodyOf, clean, idOf, num, periodRange, qtyOf, serial, withTenant } from './round8-kit.js';

const qcText: Record<string, string> = { pending: '待质检', done: '已质检', none: '不需质检' };

async function defectNames(sql: Sql, reportId: string) {
  const rows = (await sql.query<{ name: string }>('SELECT d.name FROM r8_report_defects l JOIN r8_defect_items d ON d.tenant_id=l.tenant_id AND d.id=l.defect_item_id WHERE l.report_id=$1 ORDER BY d.name', [reportId])).rows;
  return rows.map((row) => row.name);
}

async function replaceDefects(sql: Sql, actor: Actor, reportId: string, ids: string[], qtyById: Record<string, string> = {}) {
  const unique = [...new Set(ids)];
  if (unique.length) {
    const found = (await sql.query<{ id: string }>('SELECT id FROM r8_defect_items WHERE id = ANY($1::uuid[])', [unique])).rows;
    if (found.length !== unique.length) throw new Problem(422, 'DEFECT_ITEM', '不良品项不存在');
  }
  const report = (await sql.query<{ defect_qty: string }>('SELECT defect_qty::text FROM production_reports WHERE id=$1', [reportId])).rows[0];
  const sum = unique.reduce((total, id) => total + Number(qtyById[id] ?? '0'), 0);
  if (report && sum - Number(report.defect_qty) > 1e-9) throw new Problem(422, 'DEFECT_QTY', '不良品项数量之和不能超过不良品数');
  await sql.query('DELETE FROM r8_report_defects WHERE report_id=$1', [reportId]);
  for (const id of unique) await sql.query('INSERT INTO r8_report_defects(tenant_id,report_id,defect_item_id,qty) VALUES($1,$2,$3,$4)', [actor.tenant_id, reportId, id, qtyById[id] ?? '0']);
  const names = await defectNames(sql, reportId);
  if (names.length) await sql.query('UPDATE production_reports SET defect_note=$2 WHERE id=$1', [reportId, names.join('、').slice(0, 500)]);
  return names;
}

const trendIntervals = ['每小时', '每天', '每周', '每月'] as const;

function shiftIso(iso: string, days: number) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function mondayOf(iso: string) {
  const weekday = new Date(`${iso}T12:00:00+08:00`).getUTCDay();
  return shiftIso(iso, -((weekday + 6) % 7));
}

function addMonth(ym: string, count: number) {
  const [year, month] = ym.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1 + count, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daySpan(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function trendBuckets(from: string, to: string, interval: string) {
  const buckets: { key: string; label: string }[] = [];
  if (interval === '每小时') {
    const single = from === to;
    let day = from;
    while (day <= to) {
      for (let hour = 0; hour < 24; hour += 1) {
        const hh = String(hour).padStart(2, '0');
        buckets.push({ key: `${day} ${hh}:00`, label: single ? `${hh}:00` : `${day.slice(5)} ${hh}:00` });
      }
      day = shiftIso(day, 1);
    }
  } else if (interval === '每周') {
    let cursor = mondayOf(from);
    const end = mondayOf(to);
    while (cursor <= end) {
      buckets.push({ key: cursor, label: cursor.slice(5) });
      cursor = shiftIso(cursor, 7);
    }
  } else if (interval === '每月') {
    let cursor = from.slice(0, 7);
    const end = to.slice(0, 7);
    while (cursor <= end) {
      buckets.push({ key: cursor, label: cursor });
      cursor = addMonth(cursor, 1);
    }
  } else {
    let day = from;
    while (day <= to) {
      buckets.push({ key: day, label: day.slice(5) });
      day = shiftIso(day, 1);
    }
  }
  return buckets;
}

function bucketKeyOf(day: string, hour: string, interval: string) {
  if (interval === '每小时') return `${day} ${hour}:00`;
  if (interval === '每周') return mondayOf(day);
  if (interval === '每月') return day.slice(0, 7);
  return day;
}

function roundQty(value: number) {
  return Math.round(value * 1e6) / 1e6;
}

export function registerQuality(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'quality.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'quality.write', work);

  app.get('/api/quality/defects', (request) => read(request, async (sql) => ({ items: (await sql.query('SELECT id,code,name,created_at FROM r8_defect_items ORDER BY created_at DESC, code')).rows })));
  app.post('/api/quality/defects', async (request, reply) => {
    const body = bodyOf(request);
    const created = await write(request, async (sql, actor) => {
      const name = clean(body.name, 80, '不良品项名称', true);
      const code = clean(body.code, 64, '不良品项编号') || await serial(sql, actor.tenant_id, 'BL', 'BL');
      const id = (await sql.query<{ id: string }>('INSERT INTO r8_defect_items(tenant_id,code,name) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, code, name])).rows[0]!.id;
      return (await sql.query('SELECT id,code,name,created_at FROM r8_defect_items WHERE id=$1', [id])).rows[0];
    });
    return reply.code(201).send({ item: created });
  });
  app.patch('/api/quality/defects/:id', (request) => write(request, async (sql) => {
    const body = bodyOf(request);
    const name = clean(body.name, 80, '不良品项名称', true);
    const code = clean(body.code, 64, '不良品项编号');
    const row = (await sql.query('UPDATE r8_defect_items SET name=$2, code=CASE WHEN $3=\'\' THEN code ELSE $3 END WHERE id=$1 RETURNING id,code,name,created_at', [idOf(request), name, code])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '不良品项不存在');
    return { item: row };
  }));
  app.delete('/api/quality/defects/:id', (request) => write(request, async (sql) => {
    if ((await sql.query('SELECT 1 FROM r8_report_defects WHERE defect_item_id=$1 LIMIT 1', [idOf(request)])).rows[0]) throw new Problem(409, 'USED', '不良品项已被报工引用，不能删除');
    if (!(await sql.query('DELETE FROM r8_defect_items WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '不良品项不存在');
    return { ok: true };
  }));

  app.get('/api/quality/inspections', (request) => read(request, async (sql) => {
    const query = request.query as Record<string, string | undefined>;
    const rows = (await sql.query<Record<string, string>>(`SELECT r.id,r.code,r.good_qty::text,r.defect_qty::text,r.rework_qty::text,r.scrap_qty::text,r.quality_status,r.quality_note,r.quality_at,r.defect_note,r.rework_task_code,r.created_at,r.started_at,r.ended_at,r.settlement_status,r.effective_seconds,r.machine_id,
      w.code AS work_order_code, coalesce(w.product_snapshot->>'code','') AS product_code, coalesce(w.product_snapshot->>'name','') AS product_name, coalesce(w.product_snapshot->>'specification','') AS product_spec,
      coalesce(t.process_snapshot->>'name','') AS process_name, coalesce(t.process_snapshot->>'code','') AS process_code,
      coalesce(op.display_name,'') AS operator_name, coalesce(qb.display_name,'') AS quality_name, coalesce(m.name,'') AS machine_name
      FROM production_reports r
      JOIN work_orders w ON w.tenant_id=r.tenant_id AND w.id=r.work_order_id
      JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      LEFT JOIN tenant_team_members op ON op.id=r.operator_id
      LEFT JOIN tenant_team_members qb ON qb.id=r.quality_by
      LEFT JOIN r8_machines m ON m.tenant_id=r.tenant_id AND m.id=r.machine_id
      WHERE r.approval='approved' AND r.quality_status IN ('pending','done')
      ORDER BY r.created_at DESC LIMIT 500`)).rows;
    const items = await Promise.all(rows.map(async (row) => {
      const names = await defectNames(sql, String(row.id));
      return {
        ...row,
        good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), rework_qty: num(row.rework_qty), scrap_qty: num(row.scrap_qty),
        quality_text: qcText[String(row.quality_status)] ?? String(row.quality_status),
        rework_text: row.rework_task_code ? '是' : '否',
        defect_names: names.length ? names.join('、') : String(row.defect_note || ''),
        defect_item_ids: (await sql.query<{ id: string }>('SELECT defect_item_id AS id FROM r8_report_defects WHERE report_id=$1', [row.id])).rows.map((item) => item.id),
      };
    }));
    const counts = {
      pending: items.filter((item) => item.quality_text === '待质检').length,
      done: items.filter((item) => item.quality_text === '已质检').length,
      reworked: items.filter((item) => item.rework_text === '是').length,
      open: items.filter((item) => item.rework_text === '否').length,
    };
    const filtered = items.filter((item) => {
      if (query.status && query.status !== '全部' && item.quality_text !== query.status) return false;
      if (query.rework === '已返工' && item.rework_text !== '是') return false;
      if (query.rework === '未返工' && item.rework_text !== '否') return false;
      const view = item as unknown as Record<string, string>;
      if (query.q && !`${view.work_order_code}${view.product_name}${view.process_name}`.includes(query.q)) return false;
      return true;
    });
    return { items: filtered, counts, total: filtered.length };
  }));

  app.post('/api/quality/inspections/:id', (request) => write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const row = (await sql.query<{ id: string; settlement_status: string; defect_qty: string; rework_qty: string; scrap_qty: string; good_qty: string; work_order_id: string; wage_snapshot: unknown }>('SELECT id,settlement_status,defect_qty::text,rework_qty::text,scrap_qty::text,good_qty::text,work_order_id,wage_snapshot FROM production_reports WHERE id=$1 AND approval=\'approved\' FOR UPDATE', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '报工不存在');
    const quality = clean(body.quality_status, 20, '质检状态', true);
    if (!['已质检', '待质检'].includes(quality)) throw new Problem(422, 'QUALITY_STATUS', '质检状态只能是已质检或待质检');
    const note = clean(body.quality_note, 1000, '质检备注', true);
    const defect = qtyOf(body.defect_qty, '不良品数');
    const rework = qtyOf(body.rework_qty, '返工数');
    const scrap = qtyOf(body.scrap_qty, '报废数');
    if (Number(rework) + Number(scrap) > Number(defect) + 1e-9) throw new Problem(422, 'DISPOSITION', '返工数与报废数不能超过不良品数');
    const settled = row.settlement_status === 'settled';
    const qtyChanged = num(row.defect_qty) !== num(defect) || num(row.rework_qty) !== num(rework) || num(row.scrap_qty) !== num(scrap);
    if (settled && qtyChanged) throw new Problem(409, 'WAGE_SETTLED', '已结算工资不能改数量');
    const ids = Array.isArray(body.defect_item_ids) ? body.defect_item_ids.map(String) : [];
    if (Number(defect) > 0 && !ids.length && !String(row.wage_snapshot ?? '')) {
      /* 不良品项可后补，不拦截零项 */
    }
    if (!settled) await sql.query('UPDATE production_reports SET defect_qty=$2,rework_qty=$3,scrap_qty=$4 WHERE id=$1', [row.id, defect, rework, scrap]);
    await sql.query('UPDATE production_reports SET quality_status=$2,quality_note=$3,quality_by=$4,quality_at=now() WHERE id=$1', [row.id, quality === '已质检' ? 'done' : 'pending', note, actor.user_id]);
    const names = await replaceDefects(sql, actor, row.id, ids);
    let taskCode = (await sql.query<{ code: string }>('SELECT code FROM r8_rework_tasks WHERE report_id=$1', [row.id])).rows[0]?.code ?? '';
    if (!settled && Number(rework) > 0 && !taskCode) {
      taskCode = await serial(sql, actor.tenant_id, 'FG', 'FG');
      await sql.query('INSERT INTO r8_rework_tasks(tenant_id,code,report_id,work_order_id,qty) VALUES($1,$2,$3,$4,$5)', [actor.tenant_id, taskCode, row.id, row.work_order_id, rework]);
      await sql.query('UPDATE production_reports SET rework_task_code=$2 WHERE id=$1', [row.id, taskCode]);
      await sql.query('INSERT INTO r8_rectify(tenant_id,source,description,status,ref_code) VALUES($1,\'生产质检\',$2,\'待处理\',$3)', [actor.tenant_id, names.join('、') || note, taskCode]);
    }
    return { id: row.id, quality_text: quality, rework_task_code: taskCode || '-', defect_names: names.join('、'), wage_unchanged: true };
  }));

  app.post('/api/quality/bindings', (request) => withTenant(services, request, 'production.read', async (sql, actor) => {
    if (!actor.permissions.includes('quality.write') && !actor.permissions.includes('production.report')) throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
    const body = bodyOf(request);
    const reportId = clean(body.report_id, 80, '报工', true);
    const report = (await sql.query<{ id: string; operator_id: string; reporter_id: string }>('SELECT id,operator_id,reporter_id FROM production_reports WHERE id=$1', [reportId])).rows[0];
    if (!report) throw new Problem(404, 'NOT_FOUND', '报工不存在');
    const privileged = actor.permissions.includes('production.approve') || actor.permissions.includes('quality.write');
    if (!privileged && report.operator_id !== actor.user_id && report.reporter_id !== actor.user_id) throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
    const machineId = clean(body.machine_id, 80, '机台');
    if (machineId) {
      const machine = (await sql.query<{ enabled: boolean }>('SELECT enabled FROM r8_machines WHERE id=$1', [machineId])).rows[0];
      if (!machine) throw new Problem(422, 'MACHINE', '机台不存在');
      if (!machine.enabled) throw new Problem(422, 'MACHINE_DISABLED', '机台已禁用，不能选择');
      await sql.query('UPDATE production_reports SET machine_id=$2 WHERE id=$1', [reportId, machineId]);
    }
    const packed = Array.isArray(body.defect_items) ? body.defect_items as { id?: string; qty?: string | number }[] : [];
    const ids = packed.length ? packed.map((item) => String(item.id ?? '')) : (Array.isArray(body.defect_item_ids) ? body.defect_item_ids.map(String) : []);
    const qtyById = Object.fromEntries(packed.filter((item) => item.id).map((item) => [String(item.id), String(item.qty ?? '0')]));
    const names = await replaceDefects(sql, actor, reportId, ids, qtyById);
    const qtySum = (await sql.query<{ n: string }>('SELECT coalesce(sum(qty),0)::text AS n FROM r8_report_defects WHERE report_id=$1', [reportId])).rows[0]!.n;
    return { ok: true, defect_names: names.join('、'), defect_qty_sum: num(qtySum) };
  }));

  app.get('/api/quality/components', (request) => read(request, async (sql) => ({ items: (await sql.query('SELECT id,name,created_at FROM r8_qc_components ORDER BY name')).rows })));
  app.post('/api/quality/components', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const name = clean(bodyOf(request).name, 80, '质检附加组件', true);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_qc_components(tenant_id,name) VALUES($1,$2) RETURNING id', [actor.tenant_id, name])).rows[0]!.id;
    return { item: (await sql.query('SELECT id,name FROM r8_qc_components WHERE id=$1', [id])).rows[0] };
  })));

  app.get('/api/quality/spot-checks', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT s.id,s.code,s.qty::text,s.good_qty::text,s.defect_qty::text,s.note,s.scheme,s.shop_name,s.line_name,s.operator_name,s.quality_status,s.quality_at,s.created_at,
    p.code AS process_code,p.name AS process_name, coalesce(w.code,'') AS work_order_code, coalesce(g.code,'') AS product_code, coalesce(g.name,'') AS product_name, coalesce(g.specification,'') AS product_spec, coalesce(c.name,'') AS component_name, coalesce(u.display_name,'') AS creator_name
    FROM r8_spot_checks s JOIN processes p ON p.tenant_id=s.tenant_id AND p.id=s.process_id
    LEFT JOIN work_orders w ON w.tenant_id=s.tenant_id AND w.id=s.work_order_id
    LEFT JOIN products g ON g.tenant_id=s.tenant_id AND g.id=s.product_id
    LEFT JOIN r8_qc_components c ON c.tenant_id=s.tenant_id AND c.id=s.component_id
    LEFT JOIN tenant_team_members u ON u.id=s.created_by
    ORDER BY s.created_at DESC`)).rows.map((row) => ({ ...row, qty: num(row.qty), good_qty: num(row.good_qty), defect_qty: num(row.defect_qty) })) })));
  app.post('/api/quality/spot-checks', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const qty = qtyOf(body.qty, '抽检数量');
    if (Number(qty) <= 0) throw new Problem(422, 'QTY', '抽检数量必须大于0');
    const processId = clean(body.process_id, 80, '工序', true, 'select');
    if (!(await sql.query('SELECT id FROM processes WHERE id=$1', [processId])).rows[0]) throw new Problem(422, 'PROCESS', '工序不存在');
    const code = clean(body.code, 64, '质检单号') || await serial(sql, actor.tenant_id, 'CJ', 'CJ');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_spot_checks(tenant_id,code,qty,process_id,note,component_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [actor.tenant_id, code, qty, processId, clean(body.note, 500, '备注'), clean(body.component_id, 80, '组件') || null, actor.user_id])).rows[0]!.id;
    return { item: { id, code } };
  })));
  app.patch('/api/quality/spot-checks/:id', (request) => write(request, async (sql) => {
    const body = bodyOf(request);
    const good = qtyOf(body.good_qty ?? '0', '良品数');
    const defect = qtyOf(body.defect_qty ?? '0', '不良品数');
    const row = (await sql.query('UPDATE r8_spot_checks SET good_qty=$2, defect_qty=$3, quality_status=$4, quality_at=now() WHERE id=$1 RETURNING id', [idOf(request), good, defect, '已质检'])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '抽检单不存在');
    return { ok: true };
  }));
  app.post('/api/quality/spot-lines', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const spotId = clean(body.spot_id, 80, '抽检单', true);
    const componentId = clean(body.component_id, 80, '组件', true);
    if (!(await sql.query('SELECT id FROM r8_spot_checks WHERE id=$1', [spotId])).rows[0]) throw new Problem(422, 'SPOT', '抽检单不存在');
    if (!(await sql.query('SELECT id FROM r8_qc_components WHERE id=$1', [componentId])).rows[0]) throw new Problem(422, 'COMPONENT', '组件不存在');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_spot_lines(tenant_id,spot_id,component_id,item_name,result) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, spotId, componentId, clean(body.item_name, 80, '检查项', true), clean(body.result, 40, '结果') || '合格'])).rows[0]!.id;
    return { id };
  })));

  app.get('/api/quality/spot-lines', (request) => read(request, async (sql) => {
    const componentId = (request.query as { component_id?: string }).component_id ?? '';
    if (!componentId) return { items: [], hint: '请选择质检附加组件以查看明细数据' };
    const items = (await sql.query(`SELECT l.id,s.code,coalesce(w.code,'') AS work_order_code,p.name AS process_name,p.code AS process_code,s.qty::text,s.good_qty::text,s.defect_qty::text,s.quality_status,s.created_at,l.item_name,l.result
      FROM r8_spot_lines l JOIN r8_spot_checks s ON s.tenant_id=l.tenant_id AND s.id=l.spot_id JOIN processes p ON p.tenant_id=s.tenant_id AND p.id=s.process_id
      LEFT JOIN work_orders w ON w.tenant_id=s.tenant_id AND w.id=s.work_order_id
      WHERE l.component_id=$1 ORDER BY s.created_at DESC`, [componentId])).rows;
    return { items, hint: items.length ? '' : '请选择质检附加组件以查看明细数据' };
  }));

  app.get('/api/quality/specs', (request) => read(request, async (sql) => {
    const specs = (await sql.query<Record<string, unknown>>('SELECT s.id,s.name,s.note,s.created_at,coalesce(u.display_name,\'\') AS creator_name FROM r8_qc_specs s LEFT JOIN tenant_team_members u ON u.id=s.created_by ORDER BY s.created_at DESC')).rows;
    const items = [];
    for (const spec of specs) {
      const checks = (await sql.query('SELECT id,sort_no,name,description,field_type,required FROM r8_qc_spec_items WHERE spec_id=$1 ORDER BY sort_no,name', [spec.id])).rows;
      items.push({ ...spec, items: checks, item_text: checks.map((item) => item.name).join('、') });
    }
    return { items };
  }));
  app.post('/api/quality/specs', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const name = clean(body.name, 80, '检验规范', true);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_qc_specs(tenant_id,name,note,created_by) VALUES($1,$2,$3,$4) RETURNING id', [actor.tenant_id, name, clean(body.note, 255, '备注'), actor.user_id])).rows[0]!.id;
    const checks = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [];
    if (checks.length < 1) throw new Problem(422, 'ITEMS', '请至少新增一个检查项');
    let sort = 1;
    for (const item of checks) {
      const field = clean(item.field_type, 20, '字段类型') || '文本';
      if (!['文本', '数字', '是否', '单选'].includes(field)) throw new Problem(422, 'FIELD', '字段类型不正确');
      await sql.query('INSERT INTO r8_qc_spec_items(tenant_id,spec_id,sort_no,name,description,field_type,required) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.tenant_id, id, sort++, clean(item.name, 80, '检查项', true), clean(item.description, 255, '检查项说明'), field, Boolean(item.required)]);
    }
    return { id, name };
  })));

  app.get('/api/quality/purchase-tests', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT t.id,t.code,t.send_qty::text,t.tested_qty::text,t.pass_qty::text,t.fail_qty::text,t.finish_date,t.inspector_names,t.created_at,
    coalesce(s.name,'') AS spec_name, o.code AS purchase_code, coalesce(p.name,'') AS product_name, coalesce(p.code,'') AS product_code, coalesce(p.specification,'') AS product_spec,
    coalesce(su.name,'') AS supplier_name, coalesce(u.display_name,'') AS creator_name
    FROM r8_purchase_tests t JOIN purchase_orders o ON o.tenant_id=t.tenant_id AND o.id=t.purchase_order_id
    LEFT JOIN r8_qc_specs s ON s.tenant_id=t.tenant_id AND s.id=t.spec_id
    LEFT JOIN products p ON p.tenant_id=t.tenant_id AND p.id=t.product_id
    LEFT JOIN suppliers su ON su.tenant_id=o.tenant_id AND su.id=o.supplier_id
    LEFT JOIN tenant_team_members u ON u.id=t.created_by
    ORDER BY t.created_at DESC`)).rows.map((row) => {
      const send = Number(row.send_qty) || 0;
      const tested = Number(row.tested_qty) || 0;
      const pass = Number(row.pass_qty) || 0;
      const fail = Number(row.fail_qty) || 0;
      return { ...row, send_qty: num(row.send_qty), tested_qty: num(row.tested_qty), pass_qty: num(row.pass_qty), fail_qty: num(row.fail_qty), progress: send ? `${tested}/${num(row.send_qty)}` : '-', pass_rate: tested ? `${((pass / tested) * 100).toFixed(2)}` : '-' };
    }) })));
  app.post('/api/quality/purchase-tests', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const orderId = clean(body.purchase_order_id, 80, '采购单', true, 'select');
    if (!(await sql.query('SELECT id FROM purchase_orders WHERE id=$1', [orderId])).rows[0]) throw new Problem(422, 'PURCHASE', '采购单不存在');
    const code = clean(body.code, 64, '检验单号') || await serial(sql, actor.tenant_id, 'CG', 'CGJY');
    const specId = clean(body.spec_id, 80, '检验规范') || null;
    const productId = clean(body.product_id, 80, '商品') || null;
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_purchase_tests(tenant_id,code,purchase_order_id,spec_id,product_id,send_qty,finish_date,inspector_names,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [actor.tenant_id, code, orderId, specId, productId, qtyOf(body.send_qty ?? '0', '送检数量'), clean(body.finish_date, 10, '完成日期') || null, clean(body.inspector_names, 200, '检验人'), actor.user_id])).rows[0]!.id;
    return { id, code };
  })));
  app.patch('/api/quality/purchase-tests/:id', (request) => write(request, async (sql) => {
    const body = bodyOf(request);
    const pass = qtyOf(body.pass_qty ?? '0', '合格数');
    const fail = qtyOf(body.fail_qty ?? '0', '不合格数');
    const tested = String(Number(pass) + Number(fail));
    const row = (await sql.query('UPDATE r8_purchase_tests SET pass_qty=$2,fail_qty=$3,tested_qty=$4 WHERE id=$1 RETURNING id', [idOf(request), pass, fail, tested])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '采购检验单不存在');
    return { ok: true };
  }));
  app.get('/api/quality/purchase-lines', (request) => read(request, async (sql) => {
    const specId = (request.query as { spec_id?: string }).spec_id ?? '';
    if (!specId) return { items: [], hint: '请选择检验规范以查看明细数据' };
    const items = (await sql.query(`SELECT l.id,t.code,o.code AS purchase_code,coalesce(p.name,'') AS product_name,coalesce(p.code,'') AS product_code,t.pass_qty::text,t.fail_qty::text,i.name AS item_name,l.value
      FROM r8_purchase_test_lines l JOIN r8_purchase_tests t ON t.tenant_id=l.tenant_id AND t.id=l.test_id
      JOIN purchase_orders o ON o.tenant_id=t.tenant_id AND o.id=t.purchase_order_id
      JOIN r8_qc_spec_items i ON i.tenant_id=l.tenant_id AND i.id=l.spec_item_id
      LEFT JOIN products p ON p.tenant_id=t.tenant_id AND p.id=t.product_id
      WHERE i.spec_id=$1`, [specId])).rows;
    return { items, hint: '' };
  }));
  app.post('/api/quality/purchase-lines', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const testId = clean(body.test_id, 80, '采购检验单', true);
    const specItemId = clean(body.spec_item_id, 80, '检查项', true);
    if (!(await sql.query('SELECT id FROM r8_purchase_tests WHERE id=$1', [testId])).rows[0]) throw new Problem(422, 'TEST', '采购检验单不存在');
    if (!(await sql.query('SELECT id FROM r8_qc_spec_items WHERE id=$1', [specItemId])).rows[0]) throw new Problem(422, 'ITEM', '检查项不存在');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_purchase_test_lines(tenant_id,test_id,spec_item_id,value) VALUES($1,$2,$3,$4) RETURNING id', [actor.tenant_id, testId, specItemId, clean(body.value, 80, '巡检值') || 'OK'])).rows[0]!.id;
    return { id };
  })));

  app.get('/api/quality/reports/trend', (request) => read(request, async (sql) => {
    const query = request.query as { period?: string; from?: string; to?: string; interval?: string; defect_ids?: string };
    const period = String(query.period || '本月');
    const fromText = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from! : '';
    const toText = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to! : '';
    const explicit = !!(fromText && toText);
    let from = explicit ? fromText : periodRange(period).from;
    let to = explicit ? toText : periodRange(period).to;
    if (from > to) { const swap = from; from = to; to = swap; }
    const asked = trendIntervals.find((item) => item === query.interval);
    const interval = asked || (!explicit && (period === '今天' || period === '昨天') ? '每小时' : !explicit && period === '本年' ? '每月' : '每天');
    const span = daySpan(from, to) + 1;
    if (interval === '每小时' && span > 62) throw new Problem(422, 'RANGE', '按小时统计最多 62 天');
    if (interval === '每天' && span > 400) throw new Problem(422, 'RANGE', '按天统计最多 400 天');
    if (interval === '每周' && span > 800) throw new Problem(422, 'RANGE', '按周统计最多约两年');
    if (interval === '每月' && span > 3660) throw new Problem(422, 'RANGE', '按月统计最多约十年');
    const defectIds = [...new Set(String(query.defect_ids || '').split(',').map((item) => item.trim()).filter((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item)))];
    const buckets = trendBuckets(from, to, interval);
    const rows = (await sql.query<{ report_id: string; defect_qty: string; item_id: string; name: string; line_qty: string | null; day: string; hour: string }>(`SELECT r.id AS report_id, r.defect_qty::text AS defect_qty,
      coalesce(l.defect_item_id::text, '') AS item_id, coalesce(d.name, nullif(r.defect_note, ''), '未分类') AS name, l.qty::text AS line_qty,
      to_char(r.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day, to_char(r.created_at AT TIME ZONE 'Asia/Shanghai', 'HH24') AS hour
      FROM production_reports r
      LEFT JOIN r8_report_defects l ON l.tenant_id=r.tenant_id AND l.report_id=r.id
      LEFT JOIN r8_defect_items d ON d.tenant_id=l.tenant_id AND d.id=l.defect_item_id
      WHERE r.approval='approved' AND r.defect_qty>0 AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date`, [from, to])).rows;
    const byReport = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byReport.get(row.report_id) ?? [];
      list.push(row);
      byReport.set(row.report_id, list);
    }
    const index = new Map(buckets.map((bucket, position) => [bucket.key, position]));
    const groups = new Map<string, { id: string; name: string; points: number[] }>();
    const touch = (id: string, name: string) => {
      const key = id || `note:${name}`;
      let group = groups.get(key);
      if (!group) {
        group = { id, name, points: buckets.map(() => 0) };
        groups.set(key, group);
      }
      return group;
    };
    for (const list of byReport.values()) {
      const linked = list.filter((row) => row.item_id);
      const defect = Number(list[0]?.defect_qty) || 0;
      const lineSum = linked.reduce((sum, row) => sum + (Number(row.line_qty) || 0), 0);
      const counted = linked.length ? linked : list;
      for (const row of counted) {
        if (defectIds.length && !defectIds.includes(row.item_id)) continue;
        const qty = linked.length ? (lineSum > 0 ? Number(row.line_qty) || 0 : defect / linked.length) : defect;
        const slot = index.get(bucketKeyOf(row.day, row.hour, interval));
        if (slot === undefined || !qty) continue;
        const group = touch(row.item_id, row.name);
        group.points[slot] = (group.points[slot] ?? 0) + qty;
      }
    }
    if (defectIds.length) {
      const named = (await sql.query<{ id: string; name: string }>('SELECT id::text, name FROM r8_defect_items WHERE id = ANY($1::uuid[])', [defectIds])).rows;
      for (const item of named) if (!groups.has(item.id)) groups.set(item.id, { id: item.id, name: item.name, points: buckets.map(() => 0) });
    }
    const series = [...groups.values()].map((group) => ({ ...group, points: group.points.map(roundQty), total: roundQty(group.points.reduce((sum, value) => sum + value, 0)) }))
      .filter((group) => group.total > 0 || defectIds.includes(group.id))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));
    const grand = roundQty(series.reduce((sum, group) => sum + group.total, 0));
    const rateOf = (qty: number) => grand ? `${((qty / grand) * 100).toFixed(2)}%` : '-';
    const items = series.map((group) => ({ name: group.name, qty: num(group.total), rate: rateOf(group.total), points: group.points.map((value) => num(value)) }));
    const top = series.find((group) => group.total > 0);
    return {
      from, to, interval, buckets,
      series: series.map((group) => ({ id: group.id, name: group.name, points: group.points, qty: num(group.total), rate: rateOf(group.total) })),
      items,
      days: buckets.map((bucket) => bucket.key),
      total: num(grand),
      summary: top ? `【${top.name}】导致的不良品数为${num(top.total)}，占比${rateOf(top.total)}(${num(top.total)}/${num(grand)})，是出现频率最高的不良品项` : '当前周期没有不良品',
    };
  }));
  app.get('/api/quality/reports/pareto', (request) => read(request, async (sql) => {
    const range = periodRange(String((request.query as { period?: string }).period || '本年'));
    const rows = (await sql.query<{ process_code: string; process_name: string; report_qty: string; good_qty: string; defect_qty: string }>(`SELECT coalesce(t.process_snapshot->>'code','') AS process_code, coalesce(t.process_snapshot->>'name','未命名工序') AS process_name,
      sum(r.good_qty+r.defect_qty)::text AS report_qty, sum(r.good_qty)::text AS good_qty, sum(r.defect_qty)::text AS defect_qty
      FROM production_reports r JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      WHERE r.approval='approved' AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date
      GROUP BY 1,2 ORDER BY sum(r.defect_qty) DESC`, [range.from, range.to])).rows;
    const items = rows.map((row, index) => {
      const report = Number(row.report_qty) || 0;
      const defect = Number(row.defect_qty) || 0;
      return { seq: index + 1, process_code: row.process_code || '-', process_name: row.process_name, report_qty: num(row.report_qty), good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), rate: report ? `${((defect / report) * 100).toFixed(2)}%` : '-' };
    });
    return { items, summary: items.length ? `${items[0]!.process_name}不良品数最高，是优化重点` : '当前周期没有报工' };
  }));
  app.get('/api/quality/reports/defect-detail', (request) => read(request, async (sql) => {
    const range = periodRange(String((request.query as { period?: string }).period || '本月'));
    const items = (await sql.query(`SELECT r.id, coalesce(w.product_snapshot->>'code','') AS product_code, coalesce(w.product_snapshot->>'name','') AS product_name, w.code AS work_order_code,
      coalesce(t.process_snapshot->>'name','') AS process_name, r.good_qty::text, r.defect_qty::text, r.quality_at, coalesce(op.display_name,'') AS operator_name
      FROM production_reports r JOIN work_orders w ON w.tenant_id=r.tenant_id AND w.id=r.work_order_id JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      LEFT JOIN tenant_team_members op ON op.id=r.operator_id
      WHERE r.approval='approved' AND r.defect_qty>0 AND (r.created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1::date AND $2::date
      ORDER BY r.created_at DESC LIMIT 200`, [range.from, range.to])).rows.map((row, index) => ({ ...row, seq: index + 1, good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), rate: Number(row.good_qty) + Number(row.defect_qty) ? `${((Number(row.defect_qty) / (Number(row.good_qty) + Number(row.defect_qty))) * 100).toFixed(2)}%` : '-' }));
    return { items };
  }));
  app.get('/api/quality/reports/purchase', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT coalesce(p.name,'未选商品') AS product_name, coalesce(p.code,'-') AS product_code, sum(t.send_qty)::text AS send_qty, sum(t.tested_qty)::text AS tested_qty, sum(t.pass_qty)::text AS pass_qty, sum(t.fail_qty)::text AS fail_qty
    FROM r8_purchase_tests t LEFT JOIN products p ON p.tenant_id=t.tenant_id AND p.id=t.product_id GROUP BY 1,2`)).rows.map((row) => ({ ...row, send_qty: num(row.send_qty), tested_qty: num(row.tested_qty), pass_qty: num(row.pass_qty), fail_qty: num(row.fail_qty), fail_rate: Number(row.tested_qty) ? `${((Number(row.fail_qty) / Number(row.tested_qty)) * 100).toFixed(2)}` : '-' })) })));
  app.get('/api/quality/reports/spot', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT p.name AS process_name, p.code AS process_code, sum(s.qty)::text AS qty, sum(s.good_qty)::text AS good_qty, sum(s.defect_qty)::text AS defect_qty
    FROM r8_spot_checks s JOIN processes p ON p.tenant_id=s.tenant_id AND p.id=s.process_id GROUP BY p.name,p.code`)).rows.map((row) => ({ ...row, qty: num(row.qty), good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), rate: Number(row.qty) ? `${((Number(row.defect_qty) / Number(row.qty)) * 100).toFixed(2)}` : '-' })) })));
  app.get('/api/quality/reports/scrap', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT coalesce(w.product_snapshot->>'name','') AS product_name, coalesce(w.product_snapshot->>'code','') AS product_code, sum(r.good_qty+r.defect_qty)::text AS report_qty, sum(r.good_qty)::text AS good_qty, sum(r.defect_qty)::text AS defect_qty, sum(r.scrap_qty)::text AS scrap_qty, sum(r.rework_qty)::text AS rework_qty
    FROM production_reports r JOIN work_orders w ON w.tenant_id=r.tenant_id AND w.id=r.work_order_id
    WHERE r.approval='approved' AND r.quality_status='done' GROUP BY 1,2`)).rows.map((row) => {
      const report = Number(row.report_qty) || 0;
      const defect = Number(row.defect_qty) || 0;
      return { ...row, report_qty: num(row.report_qty), good_qty: num(row.good_qty), defect_qty: num(row.defect_qty), scrap_qty: num(row.scrap_qty), rework_qty: num(row.rework_qty), scrap_rate: report ? `${((Number(row.scrap_qty) / report) * 100).toFixed(2)}` : '-', rework_rate: report ? `${((Number(row.rework_qty) / report) * 100).toFixed(2)}` : '-', scrap_of_defect: defect ? `${((Number(row.scrap_qty) / defect) * 100).toFixed(2)}` : '-', rework_of_defect: defect ? `${((Number(row.rework_qty) / defect) * 100).toFixed(2)}` : '-' };
    }) })));
}
