import type { FastifyInstance } from 'fastify';
import { Problem, type Services } from './services.js';
import { bodyOf, clean, idOf, withTenant } from './round8-kit.js';

const categories = ['安全问题', '生产问题', '卫生问题', '整理问题', '整顿问题', '清扫问题', '清洁问题', '素养问题'];
const uuidText = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const trendNames = ['现场巡查', '生产质检', '售后反馈', '客户投诉', '设计问题', '物料问题'] as const;
const defaultBoardNames = ['热处理', '焊接', '硬化处理', '机械加工', '防腐处理', '铸造/锻造'];

function dayParam(value: unknown, label: string) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Problem(422, 'DATE', `${label}格式不正确`);
  const [year, month, day] = text.split('-').map(Number);
  const check = new Date(Date.UTC(year!, month! - 1, day!));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day) throw new Problem(422, 'DATE', `${label}不正确`);
  return text;
}

function shiftIso(iso: string, days: number) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}

function monthEnd(iso: string) {
  const [year, month] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function daysBetween(from: string, to: string) {
  const out: string[] = [];
  let cursor = from;
  while (cursor <= to && out.length < 400) {
    out.push(cursor);
    cursor = shiftIso(cursor, 1);
  }
  return out;
}

function weekStart(iso: string) {
  const weekday = new Date(`${iso}T12:00:00+08:00`).getUTCDay();
  return shiftIso(iso, -((weekday + 6) % 7));
}

function bucketKey(day: string, grain: string) {
  if (grain === '每月') return day.slice(0, 7);
  if (grain === '每周') return weekStart(day);
  return day;
}

function buildBuckets(start: string, end: string, grain: string) {
  const days = daysBetween(start, end);
  if (grain === '每月') {
    const keys: string[] = [];
    for (const day of days) {
      const key = day.slice(0, 7);
      if (keys.at(-1) !== key) keys.push(key);
    }
    return keys.map((key) => ({ key, label: key }));
  }
  if (grain === '每周') {
    const keys: string[] = [];
    for (const day of days) {
      const key = weekStart(day);
      if (!keys.includes(key)) keys.push(key);
    }
    return keys.map((key) => ({ key, label: key }));
  }
  return days.map((day) => ({ key: day, label: day }));
}

function tally(days: string[], buckets: { key: string }[], grain: string) {
  const index = new Map(buckets.map((bucket, at) => [bucket.key, at]));
  const points = buckets.map(() => 0);
  for (const day of days) {
    const at = index.get(bucketKey(day, grain));
    if (at !== undefined) points[at] = (points[at] ?? 0) + 1;
  }
  return points;
}

function uuidList(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter((item) => uuidText.test(item));
  const text = String(value ?? '').trim().replace(/^\{|\}$/g, '');
  if (!text) return [];
  return text.split(',').map((item) => item.trim().replace(/^"|"$/g, '')).filter((item) => uuidText.test(item));
}

function boardTitle(name: string) {
  return name.endsWith('黑榜') ? name : `${name}黑榜`;
}

function dateFilter(expr: string, from: string, to: string, params: unknown[]) {
  const parts: string[] = [];
  if (from) {
    params.push(from);
    parts.push(`(${expr} AT TIME ZONE 'Asia/Shanghai')::date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    parts.push(`(${expr} AT TIME ZONE 'Asia/Shanghai')::date <= $${params.length}::date`);
  }
  return parts.length ? `AND ${parts.join(' AND ')}` : '';
}

function nameFilter(column: string, names: string[], params: unknown[]) {
  if (!names.length) return '';
  params.push(names);
  return `AND ${column} = ANY($${params.length}::text[])`;
}

function idFilter(column: string, ids: string[], params: unknown[]) {
  if (!ids.length) return '';
  params.push(ids);
  return `AND ${column} = ANY($${params.length}::uuid[])`;
}

function associationText(ref: unknown, source: unknown) {
  const code = String(ref ?? '').trim();
  if (!code) return '';
  if (uuidText.test(code)) return String(source ?? '').trim();
  return code;
}

async function settings(sql: Parameters<Parameters<typeof withTenant>[3]>[0], tenantId: string) {
  let row = (await sql.query('SELECT * FROM r8_lean_settings WHERE tenant_id=$1', [tenantId])).rows[0];
  if (!row) {
    await sql.query('INSERT INTO r8_lean_settings(tenant_id) VALUES($1)', [tenantId]);
    row = (await sql.query('SELECT * FROM r8_lean_settings WHERE tenant_id=$1', [tenantId])).rows[0];
  }
  return row;
}

export function registerLean(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);

  app.get('/api/lean/settings', (request) => read(request, async (sql, actor) => ({ settings: await settings(sql, actor.tenant_id), departments: (await sql.query('SELECT id,name,parent_id FROM departments WHERE active ORDER BY name')).rows, processes: (await sql.query('SELECT id,name FROM processes WHERE active ORDER BY code LIMIT 100')).rows })));
  app.put('/api/lean/settings', (request) => write(request, async (sql, actor) => {
    await settings(sql, actor.tenant_id);
    const body = bodyOf(request);
    const minutes = Number(body.meeting_remind_minutes ?? 5);
    if (!Number.isInteger(minutes) || minutes < 5) throw new Problem(422, 'REMIND', '会议提醒须为大于等于5的整数分钟');
    const days = Number(body.agenda_warn_days ?? 0);
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new Problem(422, 'WARN', '议程预警天数须在0到365之间');
    const limit = Number(body.board_limit ?? 10);
    await sql.query(`UPDATE r8_lean_settings SET block_wage=$2,joint_duty=$3,board_process_ids=$4,board_limit=$5,department_ids=$6,daily_push=$7,daily_push_time=$8,agenda_warn_days=$9,meeting_remind_minutes=$10,updated_at=now() WHERE tenant_id=$1`, [
      actor.tenant_id, Boolean(body.block_wage), body.joint_duty !== false, Array.isArray(body.board_process_ids) ? body.board_process_ids : [], Math.min(10, Math.max(1, limit || 10)),
      Array.isArray(body.department_ids) ? body.department_ids : [], Boolean(body.daily_push), clean(body.daily_push_time, 8, '推送时间'), days, minutes,
    ]);
    return { settings: await settings(sql, actor.tenant_id), pushed: false };
  }));

  app.get('/api/lean/lookups', (request) => read(request, async (sql) => ({
    customers: (await sql.query(`SELECT id::text, name FROM customers WHERE active AND NOT in_sea ORDER BY name LIMIT 300`)).rows,
    contacts: (await sql.query(`SELECT id::text, customer_id::text, name, phone FROM money_contacts ORDER BY name LIMIT 800`)).rows,
    products: (await sql.query(`SELECT id::text, code, name FROM products WHERE active ORDER BY code LIMIT 300`)).rows,
    members: (await sql.query(`SELECT id::text, coalesce(display_name,'') AS display_name FROM tenant_team_members ORDER BY display_name LIMIT 300`)).rows,
  })));

  app.get('/api/lean/workstation', (request) => read(request, async (sql, actor) => {
    const query = request.query as { from?: string; to?: string; department_id?: string; grain?: string };
    let from = dayParam(query.from, '开始日期');
    let to = dayParam(query.to, '结束日期');
    if (from && to && from > to) { const swap = from; from = to; to = swap; }
    const grain = String(query.grain ?? '每天').trim() || '每天';
    if (!['每天', '每周', '每月'].includes(grain)) throw new Problem(422, 'GRAIN', '粒度只能是每天、每周或每月');
    const departmentId = String(query.department_id ?? '').trim();
    if (departmentId && !uuidText.test(departmentId)) throw new Problem(422, 'DEPARTMENT', '部门不正确');
    let deptIds: string[] = [];
    let deptNames: string[] = [];
    if (departmentId) {
      const scope = (await sql.query<{ id: string; name: string }>(`WITH RECURSIVE down AS (
        SELECT id, name FROM departments WHERE id=$1 AND active
        UNION ALL SELECT d.id, d.name FROM departments d JOIN down ON d.parent_id=down.id WHERE d.active
      ) SELECT id::text, name FROM down`, [departmentId])).rows;
      if (!scope.length) throw new Problem(422, 'DEPARTMENT', '部门不存在或已停用');
      deptIds = scope.map((row) => row.id);
      deptNames = scope.map((row) => row.name);
    }
    const chartFrom = monthStart(from || to || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()));
    const chartTo = monthEnd(to || from || chartFrom);
    const buckets = buildBuckets(chartFrom, chartTo < chartFrom ? chartFrom : chartTo, grain);
    async function days(text: string, params: unknown[]) {
      return (await sql.query<{ day: string }>(text, params)).rows.map((row) => String(row.day).slice(0, 10));
    }
    const patrolParams: unknown[] = [];
    const patrolDays = await days(`SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day FROM r8_patrols WHERE true ${dateFilter('created_at', chartFrom, chartTo, patrolParams)} ${nameFilter('department_name', deptNames, patrolParams)}`, patrolParams);
    const qualityParams: unknown[] = [];
    const qualityDays = await days(`SELECT (r.created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day
      FROM production_reports r
      LEFT JOIN tenant_member_profiles mp ON mp.tenant_id=r.tenant_id AND mp.user_id=r.operator_id
      LEFT JOIN departments d ON d.tenant_id=r.tenant_id AND d.id=mp.department_id
      WHERE r.approval='approved' AND r.defect_qty>0 ${dateFilter('r.created_at', chartFrom, chartTo, qualityParams)} ${idFilter('d.id', deptIds, qualityParams)}`, qualityParams);
    const afterParams: unknown[] = [];
    const afterDays = await days(`SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day FROM r8_rectify WHERE source='售后反馈' ${dateFilter('created_at', chartFrom, chartTo, afterParams)} ${nameFilter('department_name', deptNames, afterParams)}`, afterParams);
    const complaintParams: unknown[] = [];
    const complaintDays = await days(`SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day FROM r8_complaints WHERE true ${dateFilter('created_at', chartFrom, chartTo, complaintParams)} ${nameFilter('department_name', deptNames, complaintParams)}`, complaintParams);
    const designParams: unknown[] = [];
    const designDays = await days(`SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day FROM r8_lean_designs WHERE true ${dateFilter('created_at', chartFrom, chartTo, designParams)}`, designParams);
    const materialParams: unknown[] = [];
    const materialDays = await days(`SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day FROM r8_lean_materials WHERE true ${dateFilter('created_at', chartFrom, chartTo, materialParams)}`, materialParams);
    const series = [
      { name: trendNames[0], points: tally(patrolDays, buckets, grain) },
      { name: trendNames[1], points: tally(qualityDays, buckets, grain) },
      { name: trendNames[2], points: tally(afterDays, buckets, grain) },
      { name: trendNames[3], points: tally(complaintDays, buckets, grain) },
      { name: trendNames[4], points: tally(designDays, buckets, grain) },
      { name: trendNames[5], points: tally(materialDays, buckets, grain) },
    ];

    const qualityList: unknown[] = [];
    const qualitySql = `SELECT r.id::text, w.code AS work_order_code, coalesce(t.process_snapshot->>'name','') AS process_name, coalesce(op.display_name,'') AS owner_name, r.defect_qty::text AS defect_qty, CASE r.quality_status WHEN 'done' THEN '已质检' ELSE '待质检' END AS status, r.quality_note
      FROM production_reports r JOIN work_orders w ON w.tenant_id=r.tenant_id AND w.id=r.work_order_id JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      LEFT JOIN tenant_team_members op ON op.id=r.operator_id
      LEFT JOIN tenant_member_profiles mp ON mp.tenant_id=r.tenant_id AND mp.user_id=r.operator_id
      LEFT JOIN departments d ON d.tenant_id=r.tenant_id AND d.id=mp.department_id
      WHERE r.approval='approved' AND r.defect_qty>0 ${dateFilter('r.created_at', from, to, qualityList)} ${idFilter('d.id', deptIds, qualityList)}
      ORDER BY r.created_at DESC LIMIT 500`;
    const quality = (await sql.query(qualitySql, qualityList)).rows;

    const patrolList: unknown[] = [];
    const patrols = (await sql.query(`SELECT id::text, department_name, owner_names, category, status, description FROM r8_patrols WHERE true ${dateFilter('created_at', from, to, patrolList)} ${nameFilter('department_name', deptNames, patrolList)} ORDER BY created_at DESC LIMIT 500`, patrolList)).rows;

    const complaintList: unknown[] = [];
    const complaints = (await sql.query(`SELECT id::text, owner_names, department_name, product_name, content, photos, analysis, customer_name, contact_name, phone, status, created_at FROM r8_complaints WHERE true ${dateFilter('created_at', from, to, complaintList)} ${nameFilter('department_name', deptNames, complaintList)} ORDER BY created_at DESC LIMIT 500`, complaintList)).rows;

    const afterList: unknown[] = [];
    const aftersales = (await sql.query<{ ref_code: string; source: string }>(`SELECT id::text, ref_code, category AS fault_type, status, owner_names AS owner_name, '' AS process_name FROM r8_rectify WHERE source='售后反馈' ${dateFilter('created_at', from, to, afterList)} ${nameFilter('department_name', deptNames, afterList)} ORDER BY created_at DESC LIMIT 500`, afterList)).rows.map((row) => ({
      ...row,
      work_order_code: associationText(row.ref_code, '') === '售后反馈' ? '' : associationText(row.ref_code, ''),
    }));

    const materialList: unknown[] = [];
    const materials = (await sql.query(`SELECT id::text, product_name, description, photos, association, status, handler_name, created_at FROM r8_lean_materials WHERE true ${dateFilter('created_at', from, to, materialList)} ORDER BY created_at DESC LIMIT 500`, materialList)).rows;
    const designList: unknown[] = [];
    const designs = (await sql.query(`SELECT id::text, product_name, description, photos, association, status, handler_name, created_at FROM r8_lean_designs WHERE true ${dateFilter('created_at', from, to, designList)} ORDER BY created_at DESC LIMIT 500`, designList)).rows;

    const meetingList: unknown[] = [];
    const meetingRows = (await sql.query<{ id: string; agenda_count: string; done_count: string }>(`SELECT m.id::text, m.title, m.meet_at, m.form, m.member_names, m.place, m.related,
      (SELECT count(*)::text FROM r8_agendas a WHERE a.meeting_id=m.id) AS agenda_count,
      (SELECT count(*)::text FROM r8_agendas a WHERE a.meeting_id=m.id AND a.status='已落地') AS done_count
      FROM r8_meetings m WHERE true ${dateFilter('m.meet_at', from, to, meetingList)} ORDER BY m.meet_at DESC LIMIT 500`, meetingList)).rows;
    const meetings = meetingRows.map((row) => {
      const total = Number(row.agenda_count);
      const done = Number(row.done_count);
      return { ...row, progress: total ? `${Math.round(done / total * 100)}% (${done}/${total})` : '-', landed: total > 0 && done === total ? '已落地' : '未落地' };
    });

    const saved = await settings(sql, actor.tenant_id);
    if (!saved) throw new Problem(500, 'SETTINGS', '精益设置不存在');
    const configuredIds = uuidList(saved.board_process_ids);
    const processes = (await sql.query<{ id: string; name: string }>('SELECT id::text, name FROM processes WHERE active')).rows;
    const byId = new Map(processes.map((row) => [row.id, row.name]));
    const configured = configuredIds.map((id) => byId.get(id)).filter((name): name is string => !!name);
    const showProcessData = configured.length > 0;
    const processNames = showProcessData ? configured : defaultBoardNames;
    const rankParams: unknown[] = [];
    const ranks = (await sql.query<{ owner_name: string; process_name: string; n: number }>(`SELECT coalesce(op.display_name,'') AS owner_name, coalesce(t.process_snapshot->>'name','') AS process_name, count(*)::int AS n
      FROM production_reports r
      JOIN work_order_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      LEFT JOIN tenant_team_members op ON op.id=r.operator_id
      LEFT JOIN tenant_member_profiles mp ON mp.tenant_id=r.tenant_id AND mp.user_id=r.operator_id
      LEFT JOIN departments d ON d.tenant_id=r.tenant_id AND d.id=mp.department_id
      WHERE r.approval='approved' AND r.defect_qty>0 ${dateFilter('r.created_at', from, to, rankParams)} ${idFilter('d.id', deptIds, rankParams)}
      GROUP BY 1, 2`, rankParams)).rows;
    const limit = Math.min(10, Math.max(1, Number(saved.board_limit) || 10));
    function top(rows: { owner_name: string; n: number }[]) {
      const map = new Map<string, number>();
      for (const row of rows) {
        const name = row.owner_name || '未填责任人';
        map.set(name, (map.get(name) ?? 0) + Number(row.n));
      }
      return [...map.entries()].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).slice(0, limit).map(([name, count]) => ({ name, count }));
    }
    const boards = [
      { name: '质量黑榜', items: top(ranks) },
      ...processNames.map((name) => ({ name: boardTitle(name), items: showProcessData ? top(ranks.filter((row) => row.process_name === name)) : [] })),
    ];
    return { quality, patrols, complaints, materials, designs, meetings, aftersales, trend: { buckets, series }, boards };
  }));

  app.get('/api/lean/rectify', (request) => read(request, async (sql) => {
    const query = request.query as { source?: string; status?: string; category?: string };
    const rows = (await sql.query<Record<string, string>>('SELECT id,source,category,description,status,department_name,owner_names,ref_code,created_at FROM r8_rectify ORDER BY created_at DESC')).rows;
    const counts: Record<string, number> = { 现场巡查: 0, 生产质检: 0, 售后反馈: 0, 客户投诉: 0, 设计问题: 0, 物料问题: 0 };
    for (const row of rows) { const sourceName = String(row.source ?? ''); counts[sourceName] = (counts[sourceName] ?? 0) + 1; }
    const source = query.source || '现场巡查';
    const items = rows.filter((row) => row.source === source && (!query.status || query.status === '全部' || row.status === query.status) && (!query.category || query.category === '全部' || row.category === query.category)).map((row) => ({ ...row, ref_code: associationText(row.ref_code, row.source) }));
    const statusCounts = { 待处理: rows.filter((row) => row.source === source && row.status === '待处理').length, 已处理: rows.filter((row) => row.source === source && row.status === '已处理').length, 驳回: rows.filter((row) => row.source === source && row.status === '驳回').length };
    return { items, counts, statusCounts, categories };
  }));

  app.get('/api/lean/patrols', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT p.id,p.department_name,p.owner_names,p.category,p.description,p.status,p.created_at,coalesce(u.display_name,'') AS inspector_name FROM r8_patrols p LEFT JOIN tenant_team_members u ON u.id=p.inspector_id ORDER BY p.created_at DESC`)).rows, categories })));
  app.post('/api/lean/patrols', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const category = clean(body.category, 20, '问题分类', true, 'select');
    if (!categories.includes(category)) throw new Problem(422, 'CATEGORY', '问题分类不正确');
    const description = clean(body.description, 255, '问题描述', true);
    const department = clean(body.department_name, 80, '责任部门', true, 'select');
    const owners = clean(body.owner_names, 200, '责任人');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_patrols(tenant_id,inspector_id,department_name,owner_names,category,description) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [actor.tenant_id, actor.user_id, department, owners, category, description])).rows[0]!.id;
    await sql.query('INSERT INTO r8_rectify(tenant_id,source,category,description,department_name,owner_names,ref_code) VALUES($1,\'现场巡查\',$2,$3,$4,$5,\'现场巡查\')', [actor.tenant_id, category, description, department, owners]);
    return { id };
  })));
  app.delete('/api/lean/patrols/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_patrols WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '现场巡查不存在');
    return { ok: true };
  }));

  app.get('/api/lean/meetings', (request) => read(request, async (sql) => {
    const rows = (await sql.query(`SELECT m.id,m.title,m.content,m.meet_at,m.form,m.member_names,m.place,m.created_at,coalesce(u.display_name,'') AS creator_name FROM r8_meetings m LEFT JOIN tenant_team_members u ON u.id=m.created_by ORDER BY m.meet_at DESC`)).rows;
    const items = [];
    for (const row of rows) {
      const agendas = (await sql.query<{ status: string }>('SELECT status FROM r8_agendas WHERE meeting_id=$1', [row.id])).rows;
      const done = agendas.filter((item) => item.status === '已落地').length;
      items.push({ ...row, progress: agendas.length ? `${Math.round(done / agendas.length * 100)}% (${done}/${agendas.length})` : '-' });
    }
    return { items };
  }));
  app.post('/api/lean/meetings', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const form = clean(body.form, 20, '会议形式', true, 'select');
    if (!['线下会议', '线上会议'].includes(form)) throw new Problem(422, 'FORM', '会议形式只能是线下会议或线上会议');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_meetings(tenant_id,title,content,meet_at,form,member_names,place,created_by,related) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [actor.tenant_id, clean(body.title, 255, '会议主题', true), clean(body.content, 1000, '会议内容'), clean(body.meet_at, 40, '会议时间', true), form, clean(body.member_names, 200, '参会人员', true), clean(body.place, 255, '会议地点'), actor.user_id, clean(body.related, 255, '关联问题')])).rows[0]!.id;
    return { id };
  })));
  app.get('/api/lean/meetings/:id', (request) => read(request, async (sql) => {
    const meeting = (await sql.query('SELECT * FROM r8_meetings WHERE id=$1', [idOf(request)])).rows[0];
    if (!meeting) throw new Problem(404, 'NOT_FOUND', '会议不存在');
    const agendas = (await sql.query('SELECT * FROM r8_agendas WHERE meeting_id=$1 ORDER BY created_at', [idOf(request)])).rows;
    return { meeting, agendas };
  }));
  app.post('/api/lean/meetings/:id/agendas', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const status = clean(body.status, 20, '落地状态') || '待落地';
    if (!['待落地', '已落地'].includes(status)) throw new Problem(422, 'STATUS', '落地状态只能是待落地或已落地');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_agendas(tenant_id,meeting_id,description,analysis,owner_name,due_date,status,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [actor.tenant_id, idOf(request), clean(body.description, 1000, '问题描述', true), clean(body.analysis, 1000, '问题分析'), clean(body.owner_name, 80, '负责人'), clean(body.due_date, 10, '预计完成日期') || null, status, clean(body.detail, 1000, '落地详情')])).rows[0]!.id;
    return { id };
  })));
  app.delete('/api/lean/meetings/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_meetings WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '会议不存在');
    return { ok: true };
  }));
  app.get('/api/lean/todos', (request) => read(request, async (sql) => {
    const query = request.query as { status?: string; overdue?: string };
    const rows = (await sql.query<Record<string, string>>(`SELECT a.id,m.title,m.meet_at,m.member_names,m.place,a.description,a.analysis,a.owner_name,a.status,a.due_date,a.detail
      FROM r8_agendas a JOIN r8_meetings m ON m.tenant_id=a.tenant_id AND m.id=a.meeting_id ORDER BY a.due_date NULLS LAST`)).rows.map((row) => ({ ...row, overdue_text: row.due_date && String(row.due_date) < new Date().toISOString().slice(0, 10) && row.status !== '已落地' ? '已逾期' : '未逾期' } as Record<string, string>));
    const items = rows.filter((row) => (!query.status || query.status === '全部' || row.status === query.status) && (!query.overdue || query.overdue === '全部' || row.overdue_text === query.overdue));
    return { items, counts: { 待落地: rows.filter((row) => row.status === '待落地').length, 已落地: rows.filter((row) => row.status === '已落地').length, 未逾期: rows.filter((row) => row.overdue_text === '未逾期').length, 已逾期: rows.filter((row) => row.overdue_text === '已逾期').length } };
  }));

  app.post('/api/lean/complaints', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const content = clean(body.content, 1000, '投诉内容', true);
    const department = clean(body.department_name, 80, '责任部门');
    const owners = clean(body.owner_names, 200, '责任人');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_complaints(tenant_id,customer_name,contact_name,phone,content,analysis,department_name,owner_names,product_name,photos) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [actor.tenant_id, clean(body.customer_name, 80, '客户', true), clean(body.contact_name, 80, '联系人', true), clean(body.phone, 40, '联系人电话', true), content, clean(body.analysis, 1000, '问题分析'), department, owners, clean(body.product_name, 80, '产品'), clean(body.photos, 500, '现场照片')])).rows[0]!.id;
    await sql.query('INSERT INTO r8_rectify(tenant_id,source,description,department_name,owner_names,ref_code) VALUES($1,\'客户投诉\',$2,$3,$4,\'客户投诉\')', [actor.tenant_id, content, department, owners]);
    return { id };
  })));
  app.delete('/api/lean/complaints/:id', (request) => write(request, async (sql) => {
    const row = (await sql.query<{ id: string; content: string }>('DELETE FROM r8_complaints WHERE id=$1 RETURNING id, content', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '客户投诉不存在');
    await sql.query(`DELETE FROM r8_rectify WHERE id IN (SELECT id FROM r8_rectify WHERE source='客户投诉' AND description=$1 ORDER BY created_at DESC LIMIT 1)`, [row.content]);
    return { ok: true };
  }));
  app.post('/api/lean/materials', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const description = clean(body.description, 1000, '问题描述', true);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_lean_materials(tenant_id,product_name,description,reporter_name,photos,association) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [actor.tenant_id, clean(body.product_name, 80, '商品'), description, actor.display_name, clean(body.photos, 500, '现场照片'), clean(body.association, 80, '问题关联')])).rows[0]!.id;
    await sql.query('INSERT INTO r8_rectify(tenant_id,source,description,ref_code) VALUES($1,\'物料问题\',$2,\'物料问题\')', [actor.tenant_id, description]);
    return { id };
  })));
  app.delete('/api/lean/materials/:id', (request) => write(request, async (sql) => {
    const row = (await sql.query<{ id: string; description: string }>('DELETE FROM r8_lean_materials WHERE id=$1 RETURNING id, description', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '物料问题不存在');
    await sql.query(`DELETE FROM r8_rectify WHERE id IN (SELECT id FROM r8_rectify WHERE source='物料问题' AND description=$1 ORDER BY created_at DESC LIMIT 1)`, [row.description]);
    return { ok: true };
  }));
  app.post('/api/lean/designs', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const description = clean(body.description, 1000, '问题描述', true);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_lean_designs(tenant_id,product_name,description,reporter_name,photos,association) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [actor.tenant_id, clean(body.product_name, 80, '产品'), description, actor.display_name, clean(body.photos, 500, '现场照片'), clean(body.association, 80, '问题关联')])).rows[0]!.id;
    await sql.query('INSERT INTO r8_rectify(tenant_id,source,description,ref_code) VALUES($1,\'设计问题\',$2,\'设计问题\')', [actor.tenant_id, description]);
    return { id };
  })));
  app.delete('/api/lean/designs/:id', (request) => write(request, async (sql) => {
    const row = (await sql.query<{ id: string; description: string }>('DELETE FROM r8_lean_designs WHERE id=$1 RETURNING id, description', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '设计问题不存在');
    await sql.query(`DELETE FROM r8_rectify WHERE id IN (SELECT id FROM r8_rectify WHERE source='设计问题' AND description=$1 ORDER BY created_at DESC LIMIT 1)`, [row.description]);
    return { ok: true };
  }));
}
