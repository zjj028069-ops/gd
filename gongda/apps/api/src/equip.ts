import type { FastifyInstance } from 'fastify';
import { Problem, type Services } from './services.js';
import { bodyOf, clean, idOf, serial, withTenant } from './round8-kit.js';

const repairStatus = ['待派单', '待接单', '处理中', '待审核', '审核退回', '已完成', '暂停', '取消'];

type Sql = { query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> };

function asIds(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function fmt(value: unknown) {
  if (!value) return '';
  const d = new Date(String(value));
  if (!Number.isFinite(d.getTime())) return String(value);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function remainDays(end: unknown) {
  if (!end) return '';
  const endMs = new Date(String(end)).setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (!Number.isFinite(endMs)) return '';
  return String(Math.ceil((endMs - today.getTime()) / 86400000));
}

function durText(from: unknown, to: unknown) {
  if (!from || !to) return '-';
  const a = new Date(String(from)).getTime();
  const b = new Date(String(to)).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '-';
  let sec = Math.floor((b - a) / 1000);
  const days = Math.floor(sec / 86400); sec -= days * 86400;
  const hours = Math.floor(sec / 3600); sec -= hours * 3600;
  const mins = Math.floor(sec / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}天`);
  if (hours || days) parts.push(`${hours}小时`);
  parts.push(`${mins}分钟`);
  return parts.join('');
}

function advancedOf(body: Record<string, unknown>) {
  return {
    exec_type: clean(body.exec_type, 40, '执行类型') || '个人执行',
    period_start: clean(body.period_start, 40, '计划开始'),
    period_end: clean(body.period_end, 40, '计划结束'),
    cycle_rule: clean(body.cycle_rule, 40, '循环周期') || clean(body.cycle_text, 40, '循环周期'),
    cycle_days: Number(body.cycle_days ?? 1) || 1,
    cycle_weekdays: asIds(body.cycle_weekdays),
    cycle_monthdays: asIds(body.cycle_monthdays),
    exec_mode: clean(body.exec_mode, 20, '执行时间') || '当天执行',
    time_spans: Array.isArray(body.time_spans) ? body.time_spans : [],
    remind_mode: clean(body.remind_mode, 20, '提醒时间') || '当天提醒',
    remind_minutes: Number(body.remind_minutes ?? 5) || 5,
    remind_people: asIds(body.remind_people).length ? asIds(body.remind_people) : ['执行人/执行团队'],
    sign_confirm: body.sign_confirm === true || body.sign_confirm === '开启' ? '开启' : '关闭',
    scan_verify: body.scan_verify === true || body.scan_verify === '开启' ? '开启' : '关闭',
    early_exec: body.early_exec === false || body.early_exec === '关闭' ? '关闭' : '开启',
    repeat_exec: body.repeat_exec === false || body.repeat_exec === '关闭' ? '关闭' : '开启',
    public_show: body.public_show === false || body.public_show === '关闭' ? '关闭' : '开启',
    device_contents: body.device_contents && typeof body.device_contents === 'object' ? body.device_contents : {},
  };
}

async function generateTasks(sql: Sql, tenantId: string, plan: { id: string; executor_name: string; team_name: string; device_ids: string[]; advanced: Record<string, unknown> }) {
  const start = String(plan.advanced.period_start || '');
  const end = String(plan.advanced.period_end || '');
  if (!start || !end) {
    await sql.query('INSERT INTO r8_maint_tasks(tenant_id,plan_id,task_date,time_span,executor_name,team_name,device_count) VALUES($1,$2,CURRENT_DATE,$3,$4,$5,$6)', [tenantId, plan.id, '', plan.executor_name, plan.team_name, plan.device_ids.length]);
    return;
  }
  const rule = String(plan.advanced.cycle_rule || '每几天执行');
  const every = Number(plan.advanced.cycle_days ?? 1) || 1;
  const weekdays = (plan.advanced.cycle_weekdays as string[] | undefined) ?? [];
  const monthdays = (plan.advanced.cycle_monthdays as string[] | undefined) ?? [];
  const spans = (plan.advanced.time_spans as { start?: string; end?: string }[] | undefined) ?? [];
  const spanText = spans.length ? spans.map((s) => `${s.start || ''}-${s.end || ''}`).join('，') : '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cursor = new Date(start); cursor.setHours(0, 0, 0, 0);
  const last = new Date(end); last.setHours(0, 0, 0, 0);
  let guard = 0;
  while (cursor <= last && guard++ < 400) {
    if (cursor >= today) {
      const dow = cursor.getDay();
      const day = cursor.getDate();
      let hit = false;
      if (rule === '每几天执行') {
        const base = new Date(start); base.setHours(0, 0, 0, 0);
        const diff = Math.round((cursor.getTime() - base.getTime()) / 86400000);
        hit = diff % every === 0;
      } else if (rule === '每周几执行') hit = !weekdays.length || weekdays.includes(String(dow)) || weekdays.some((w) => w.includes(['日', '一', '二', '三', '四', '五', '六'][dow] ?? ''));
      else if (rule === '每月的几号执行') hit = !monthdays.length || monthdays.includes(String(day));
      else hit = true;
      if (hit) {
        const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        await sql.query('INSERT INTO r8_maint_tasks(tenant_id,plan_id,task_date,time_span,executor_name,team_name,device_count) VALUES($1,$2,$3::date,$4,$5,$6,$7)', [tenantId, plan.id, iso, spanText, plan.executor_name, plan.team_name, plan.device_ids.length]);
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
}

async function nextQrCode(sql: Sql) {
  const row = (await sql.query<{ m: string | null }>("SELECT max(code) AS m FROM r8_qrcodes WHERE code ~ '^[0-9]{7}$'")).rows[0];
  const current = row?.m ? Number(row.m) : 1000000;
  return String(Math.max(1000000, current) + 1);
}

export function registerEquip(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);

  app.get('/api/equip/categories', (request) => read(request, async (sql) => ({ items: (await sql.query('SELECT id,parent_id,name,sort_no FROM r8_equip_categories ORDER BY sort_no,name')).rows })));
  app.post('/api/equip/categories', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => ({ id: (await sql.query<{ id: string }>('INSERT INTO r8_equip_categories(tenant_id,parent_id,name) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, clean(bodyOf(request).parent_id, 80, '上级') || null, clean(bodyOf(request).name, 80, '设备类别', true)])).rows[0]!.id }))));

  app.get('/api/equip/devices', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT d.id,d.code,d.name,d.spec,d.status,d.team_name,d.owner_name,d.shop_name,d.line_name,d.enabled,d.created_at,d.materials,coalesce(c.name,'') AS category_name,
    CASE WHEN EXISTS(SELECT 1 FROM r8_maint_plans p WHERE d.id = ANY(p.device_ids) AND p.enabled) THEN '有' ELSE '无' END AS plan_text,
    coalesce((SELECT q.code FROM r8_qrcodes q WHERE q.device_id=d.id ORDER BY q.created_at DESC LIMIT 1),'') AS qr_code,
    coalesce((SELECT u.display_name FROM tenant_team_members u WHERE u.id=d.created_by),'') AS creator_name,
    coalesce(jsonb_array_length(d.materials),0) AS material_count
    FROM r8_devices d LEFT JOIN r8_equip_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id ORDER BY d.created_at DESC`)).rows.map((row) => ({
    ...row,
    enabled_text: row.enabled ? '启用' : '禁用',
    material_text: Number(row.material_count) > 0 ? `管理(${row.material_count})` : '管理',
    created_at_text: fmt(row.created_at),
  })) })));
  app.post('/api/equip/devices', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const status = clean(body.status, 20, '设备状态', true, 'select');
    if (!['正常', '维修中', '运行中'].includes(status)) throw new Problem(422, 'STATUS', '设备状态只能是正常、维修中或运行中');
    const code = clean(body.code, 64, '设备编号') || await serial(sql, actor.tenant_id, 'SB', 'SB');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_devices(tenant_id,code,name,spec,status,category_id,team_name,owner_name,shop_name,line_name,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [actor.tenant_id, code, clean(body.name, 80, '设备名称', true), clean(body.spec, 80, '设备规格'), status, clean(body.category_id, 80, '设备类别', true, 'select'), clean(body.team_name, 80, '团队') || '默认团队', clean(body.owner_name, 80, '设备负责人', true), clean(body.shop_name, 80, '车间'), clean(body.line_name, 80, '产线'), actor.user_id])).rows[0]!.id;
    if (body.sync_machine === true || body.sync_machine === '是') {
      const category = (await sql.query<{ id: string }>('SELECT id FROM r8_machine_categories ORDER BY sort_no LIMIT 1')).rows[0];
      if (category) await sql.query('INSERT INTO r8_machines(tenant_id,code,name,spec,status,category_id,sync_device) VALUES($1,$2,$3,$4,$5,$6,true)', [actor.tenant_id, code, clean(body.name, 80, '设备名称', true), clean(body.spec, 80, '设备规格'), status, category.id]);
    }
    return { id, code };
  })));
  app.get('/api/equip/devices/:id', (request) => read(request, async (sql) => {
    const device = (await sql.query(`SELECT d.*,coalesce(c.name,'') AS category_name FROM r8_devices d LEFT JOIN r8_equip_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id WHERE d.id=$1`, [idOf(request)])).rows[0];
    if (!device) throw new Problem(404, 'NOT_FOUND', '设备不存在');
    const qr = (await sql.query('SELECT id,code,created_at FROM r8_qrcodes WHERE device_id=$1 ORDER BY created_at DESC LIMIT 1', [device.id])).rows[0];
    const creator = (await sql.query<{ display_name: string }>('SELECT display_name FROM tenant_team_members WHERE id=$1', [device.created_by])).rows[0];
    return {
      device: { ...device, creator_name: creator?.display_name || '', created_at_text: fmt(device.created_at), enabled_text: device.enabled ? '启用' : '禁用' },
      qr: qr ?? null,
      materials: Array.isArray(device.materials) ? device.materials : [],
      plans: (await sql.query('SELECT id,title,category,cycle_text,executor_name,team_name,enabled,created_at FROM r8_maint_plans WHERE $1 = ANY(device_ids) ORDER BY created_at DESC', [device.id])).rows,
      records: (await sql.query(`SELECT r.id,coalesce(p.title,'') AS plan_title,r.result,r.executor_name,r.team_name,r.executed_at FROM r8_maint_records r LEFT JOIN r8_maint_plans p ON p.id=r.plan_id WHERE r.device_id=$1 ORDER BY r.executed_at DESC`, [device.id])).rows,
      repairs: (await sql.query('SELECT id,code,status,description,handler_name,created_at FROM r8_repairs WHERE device_id=$1 ORDER BY created_at DESC', [device.id])).rows,
      pi_records: (await sql.query('SELECT id,content_name,inspector_name,normal_count,abnormal_count,checked_at FROM r8_pi_records WHERE device_id=$1 ORDER BY checked_at DESC', [device.id])).rows,
    };
  }));
  app.patch('/api/equip/devices/:id', (request) => write(request, async (sql) => {
    const body = bodyOf(request);
    if (body.enabled !== undefined) await sql.query('UPDATE r8_devices SET enabled=$2 WHERE id=$1', [idOf(request), Boolean(body.enabled)]);
    if (body.materials !== undefined) await sql.query('UPDATE r8_devices SET materials=$2::jsonb WHERE id=$1', [idOf(request), JSON.stringify(body.materials)]);
    return { ok: true };
  }));
  app.delete('/api/equip/devices/:id', (request) => write(request, async (sql) => {
    if ((await sql.query('SELECT id FROM r8_repairs WHERE device_id=$1 LIMIT 1', [idOf(request)])).rows[0]) throw new Problem(409, 'USED', '设备已有维修工单，不能删除');
    if (!(await sql.query('DELETE FROM r8_devices WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '设备不存在');
    return { ok: true };
  }));

  app.get('/api/equip/qrcodes', (request) => read(request, async (sql) => {
    const bind = (request.query as { bind?: string }).bind;
    const items = (await sql.query(`SELECT q.id,q.code,q.created_at,q.device_id,coalesce(d.name,'') AS device_name,coalesce(d.spec,'') AS device_spec,coalesce(d.code,'') AS device_code
      FROM r8_qrcodes q LEFT JOIN r8_devices d ON d.tenant_id=q.tenant_id AND d.id=q.device_id
      WHERE ($1::text IS NULL OR $1='全部' OR ($1='已绑定' AND q.device_id IS NOT NULL) OR ($1='未绑定' AND q.device_id IS NULL))
      ORDER BY q.created_at DESC`, [bind ?? null])).rows.map((row) => ({ ...row, created_at_text: fmt(row.created_at), bound: Boolean(row.device_id) }));
    return { items };
  }));
  app.post('/api/equip/qrcodes', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const count = Number(body.count ?? 0);
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Problem(422, 'COUNT', '请填写生成二维码数量');
    const mode = clean(body.mode, 20, '生成方式') || '生成Excel';
    const codes: string[] = [];
    let code = await nextQrCode(sql);
    for (let i = 0; i < count; i += 1) {
      await sql.query('INSERT INTO r8_qrcodes(tenant_id,code) VALUES($1,$2)', [actor.tenant_id, code]);
      codes.push(code);
      code = String(Number(code) + 1);
    }
    await sql.query('INSERT INTO r8_qrcode_batches(tenant_id,qty,created_by) VALUES($1,$2,$3)', [actor.tenant_id, count, actor.user_id]);
    return { codes, mode, range: codes.length ? `${codes[0]}-${codes[codes.length - 1]}` : '' };
  })));
  app.get('/api/equip/qrcodes/batches', (request) => read(request, async (sql) => ({
    items: (await sql.query(`SELECT b.id,b.qty,b.created_at,coalesce(u.display_name,'') AS creator_name FROM r8_qrcode_batches b LEFT JOIN tenant_team_members u ON u.id=b.created_by ORDER BY b.created_at DESC`)).rows.map((row) => ({ ...row, created_at_text: fmt(row.created_at) })),
  })));
  app.post('/api/equip/qrcodes/:id/bind', (request) => write(request, async (sql) => {
    const deviceId = clean(bodyOf(request).device_id, 80, '设备', true);
    await sql.query('UPDATE r8_qrcodes SET device_id=NULL WHERE device_id=$1', [deviceId]);
    const row = (await sql.query('UPDATE r8_qrcodes SET device_id=$2 WHERE id=$1 RETURNING id,code', [idOf(request), deviceId])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '二维码不存在');
    return { item: row };
  }));
  app.post('/api/equip/qrcodes/:id/unbind', (request) => write(request, async (sql) => {
    const row = (await sql.query('UPDATE r8_qrcodes SET device_id=NULL WHERE id=$1 RETURNING id,code', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '二维码不存在');
    return { item: row };
  }));
  app.delete('/api/equip/qrcodes/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_qrcodes WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '二维码不存在');
    return { ok: true };
  }));

  app.get('/api/equip/contents', (request) => read(request, async (sql) => {
    const rows = (await sql.query(`SELECT c.id,c.title,c.note,c.created_at,coalesce(u.display_name,'') AS creator_name FROM r8_maint_contents c LEFT JOIN tenant_team_members u ON u.id=c.created_by ORDER BY c.created_at DESC`)).rows;
    const items = [];
    for (const row of rows) {
      const checks = (await sql.query('SELECT id,sort_no,name,field_type,required,description FROM r8_maint_items WHERE content_id=$1 ORDER BY sort_no', [row.id])).rows;
      items.push({ ...row, items: checks, item_count: checks.length, created_at_text: fmt(row.created_at) });
    }
    return { items };
  }));
  app.post('/api/equip/contents', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_maint_contents(tenant_id,title,note,created_by) VALUES($1,$2,$3,$4) RETURNING id', [actor.tenant_id, clean(body.title, 80, '标题', true), clean(body.note, 255, '备注'), actor.user_id])).rows[0]!.id;
    const checks = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [];
    let sort = 1;
    for (const item of checks) await sql.query('INSERT INTO r8_maint_items(tenant_id,content_id,sort_no,name,field_type,required,description) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.tenant_id, id, sort++, clean(item.name, 80, '检查项', true), clean(item.field_type, 20, '字段类型') || '文本', Boolean(item.required), clean(item.description, 255, '检查项说明')]);
    return { id };
  })));
  app.post('/api/equip/contents/:id/copy', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const src = (await sql.query<{ title: string; note: string }>('SELECT title,note FROM r8_maint_contents WHERE id=$1', [idOf(request)])).rows[0];
    if (!src) throw new Problem(404, 'NOT_FOUND', '维保内容不存在');
    const title = `${src.title}-副本`.slice(0, 80);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_maint_contents(tenant_id,title,note,created_by) VALUES($1,$2,$3,$4) RETURNING id', [actor.tenant_id, title, src.note, actor.user_id])).rows[0]!.id;
    const checks = (await sql.query('SELECT sort_no,name,field_type,required,description FROM r8_maint_items WHERE content_id=$1 ORDER BY sort_no', [idOf(request)])).rows;
    for (const item of checks) await sql.query('INSERT INTO r8_maint_items(tenant_id,content_id,sort_no,name,field_type,required,description) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.tenant_id, id, item.sort_no, item.name, item.field_type, item.required, item.description]);
    return { id };
  })));
  app.delete('/api/equip/contents/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_maint_contents WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '维保内容不存在');
    return { ok: true };
  }));

  app.get('/api/equip/plans', (request) => read(request, async (sql) => {
    const plans = (await sql.query('SELECT id,title,category,device_ids,content_ids,executor_name,team_name,cycle_text,enabled,note,created_at,advanced FROM r8_maint_plans ORDER BY created_at DESC')).rows;
    const items = [];
    for (const plan of plans) {
      const ids = plan.device_ids as string[];
      const names = ids.length ? (await sql.query<{ id: string; name: string; code: string }>('SELECT id,name,code FROM r8_devices WHERE id = ANY($1::uuid[])', [ids])).rows : [];
      const adv = (plan.advanced && typeof plan.advanced === 'object' ? plan.advanced : {}) as Record<string, unknown>;
      const spans = Array.isArray(adv.time_spans) ? (adv.time_spans as { start?: string; end?: string }[]).map((s) => `${s.start || ''}-${s.end || ''}`).join('，') : '';
      items.push({
        ...plan,
        device_count: ids.length,
        device_text: names.length === 1 ? names[0]!.name : '',
        devices: names,
        period_text: adv.period_start && adv.period_end ? `${adv.period_start} ~ ${adv.period_end}` : '',
        remain_days: remainDays(adv.period_end),
        cycle_text: plan.cycle_text || String(adv.cycle_rule || ''),
        exec_time_text: spans || String(adv.exec_mode || ''),
        month_overview: '',
        enabled_text: plan.enabled ? '启用' : '禁用',
        created_at_text: fmt(plan.created_at),
      });
    }
    return { items };
  }));
  app.get('/api/equip/plans/:id', (request) => read(request, async (sql) => {
    const plan = (await sql.query('SELECT * FROM r8_maint_plans WHERE id=$1', [idOf(request)])).rows[0];
    if (!plan) throw new Problem(404, 'NOT_FOUND', '维保计划不存在');
    const adv = (plan.advanced && typeof plan.advanced === 'object' ? plan.advanced : {}) as Record<string, unknown>;
    const deviceIds = plan.device_ids as string[];
    const devices = deviceIds.length ? (await sql.query(`SELECT d.id,d.code,d.name,d.spec,coalesce(c.name,'') AS category_name FROM r8_devices d LEFT JOIN r8_equip_categories c ON c.id=d.category_id WHERE d.id = ANY($1::uuid[])`, [deviceIds])).rows : [];
    const contents = (plan.content_ids as string[]).length ? (await sql.query('SELECT id,title FROM r8_maint_contents WHERE id = ANY($1::uuid[])', [plan.content_ids])).rows : [];
    const contentMap = Object.fromEntries(contents.map((c) => [c.id, c.title]));
    const deviceContents = (adv.device_contents && typeof adv.device_contents === 'object' ? adv.device_contents : {}) as Record<string, string>;
    const deviceRows = [];
    for (const d of devices) {
      const cid = deviceContents[String(d.id)] || (plan.content_ids as string[])[0] || '';
      const recCount = (await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM r8_maint_records WHERE plan_id=$1 AND device_id=$2', [plan.id, d.id])).rows[0]?.n || '0';
      const checks = cid ? (await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM r8_maint_items WHERE content_id=$1', [cid])).rows[0]?.n || 0 : 0;
      deviceRows.push({ ...d, content_id: cid, content_title: contentMap[cid] || '', content_count: checks, record_count: Number(recCount) });
    }
    const tasks = (await sql.query('SELECT * FROM r8_maint_tasks WHERE plan_id=$1 ORDER BY task_date', [plan.id])).rows;
    const records = (await sql.query(`SELECT r.*,coalesce(d.name,'') AS device_name FROM r8_maint_records r LEFT JOIN r8_devices d ON d.id=r.device_id WHERE r.plan_id=$1 ORDER BY r.executed_at DESC`, [plan.id])).rows;
    const done = tasks.filter((t) => t.status === '已完成').length;
    const lastDone = records[0]?.executed_at;
    const spans = Array.isArray(adv.time_spans) ? (adv.time_spans as { start?: string; end?: string }[]).map((s) => `${s.start || ''}-${s.end || ''}`).join('，') : '';
    return {
      plan: {
        ...plan, advanced: adv,
        period_text: adv.period_start && adv.period_end ? `${adv.period_start} ~ ${adv.period_end}` : '无',
        remain_days: remainDays(adv.period_end),
        cycle_text: plan.cycle_text || String(adv.cycle_rule || '无'),
        exec_time_text: spans || String(adv.exec_mode || '无'),
        remind_cycle: adv.remind_mode === '提前提醒' ? `每${adv.remind_minutes || 5}分钟提醒一次` : '当天提醒',
        remind_people_text: (Array.isArray(adv.remind_people) ? adv.remind_people : ['执行人/执行团队']).join('、'),
        done_task_count: done || '无', last_done_at: lastDone ? fmt(lastDone) : '无', created_at_text: fmt(plan.created_at) || '无',
      },
      devices: deviceRows, tasks, records,
    };
  }));
  app.post('/api/equip/plans', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const title = clean(body.title, 80, '计划名称', true);
    const deviceIds = asIds(body.device_ids);
    const contentIds = asIds(body.content_ids);
    if (!deviceIds.length) throw new Problem(422, 'DEVICE', '请选择维保设备');
    if (!contentIds.length) throw new Problem(422, 'CONTENT', '请选择维保内容');
    const executor = clean(body.executor_name, 80, '执行人', true);
    const team = clean(body.team_name, 40, '团队') || '默认团队';
    const adv = advancedOf(body);
    const cycleText = clean(body.cycle_text, 40, '循环周期') || String(adv.cycle_rule || '');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_maint_plans(tenant_id,title,category,device_ids,content_ids,executor_name,team_name,cycle_text,note,advanced) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id', [actor.tenant_id, title, clean(body.category, 40, '计划分类'), deviceIds, contentIds, executor, team, cycleText, clean(body.note, 255, '备注'), JSON.stringify(adv)])).rows[0]!.id;
    await generateTasks(sql, actor.tenant_id, { id, executor_name: executor, team_name: team, device_ids: deviceIds, advanced: adv });
    return { id };
  })));
  app.patch('/api/equip/plans/:id', (request) => write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const plan = (await sql.query<{ id: string; device_ids: string[]; executor_name: string; team_name: string; advanced: Record<string, unknown>; enabled: boolean }>('SELECT id,device_ids,executor_name,team_name,advanced,enabled FROM r8_maint_plans WHERE id=$1', [idOf(request)])).rows[0];
    if (!plan) throw new Problem(404, 'NOT_FOUND', '维保计划不存在');
    if (body.enabled !== undefined) {
      await sql.query('UPDATE r8_maint_plans SET enabled=$2 WHERE id=$1', [idOf(request), Boolean(body.enabled)]);
      if (body.enabled && !plan.enabled) await generateTasks(sql, actor.tenant_id, { id: plan.id, executor_name: plan.executor_name, team_name: plan.team_name, device_ids: plan.device_ids, advanced: plan.advanced || {} });
    }
    if (body.postpone_end) {
      const end = clean(body.postpone_end, 40, '计划结束时间', true);
      const adv = { ...(plan.advanced || {}), period_end: end };
      await sql.query('UPDATE r8_maint_plans SET advanced=$2::jsonb WHERE id=$1', [idOf(request), JSON.stringify(adv)]);
      await generateTasks(sql, actor.tenant_id, { id: plan.id, executor_name: plan.executor_name, team_name: plan.team_name, device_ids: plan.device_ids, advanced: adv });
    }
    return { ok: true };
  }));
  app.delete('/api/equip/plans/:id', (request) => write(request, async (sql) => {
    await sql.query("DELETE FROM r8_maint_tasks WHERE plan_id=$1 AND status='未开始'", [idOf(request)]);
    if (!(await sql.query('DELETE FROM r8_maint_plans WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '维保计划不存在');
    return { ok: true };
  }));
  app.get('/api/equip/tasks', (request) => read(request, async (sql) => {
    const items = (await sql.query<{ status: string; task_date: string }>(`SELECT t.id,p.title AS plan_title,t.task_date,t.time_span,t.executor_name,t.team_name,t.status,t.device_count,t.sign_status
      FROM r8_maint_tasks t JOIN r8_maint_plans p ON p.tenant_id=t.tenant_id AND p.id=t.plan_id ORDER BY t.task_date DESC`)).rows.map((row) => ({ ...row, task_date_text: String(row.task_date).slice(0, 10), device_text: '' }));
    const counts = { status: { 全部: items.length, 未开始: 0, 进行中: 0, 已完成: 0, 未完成: 0 }, abnormal: { 全部: items.length, 逾期: 0, 漏执行: 0 }, date: { 全部: items.length, 昨天: 0, 今天: 0, 本周: 0, 本月: 0 } };
    const now = new Date(); const today = new Date(now); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const weekStart = new Date(today); weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    for (const item of items) {
      const st = String(item.status);
      if (st in counts.status) counts.status[st as keyof typeof counts.status] += 1;
      const d = new Date(String(item.task_date)); d.setHours(0, 0, 0, 0);
      if (d.getTime() === today.getTime()) counts.date['今天'] += 1;
      if (d.getTime() === yesterday.getTime()) counts.date['昨天'] += 1;
      if (d >= weekStart && d <= today) counts.date['本周'] += 1;
      if (d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear()) counts.date['本月'] += 1;
      if (st === '未完成') counts.abnormal['漏执行'] += 1;
    }
    return { items, counts };
  }));
  app.get('/api/equip/records', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT r.id,coalesce(p.title,'') AS plan_title,coalesce(d.name,'') AS device_name,coalesce(d.code,'') AS device_code,coalesce(d.spec,'') AS device_spec,coalesce(d.status,'') AS device_status,
      coalesce(c.name,'') AS category_name,coalesce(d.owner_name,'') AS owner_name,coalesce(d.shop_name,'') AS shop_name,coalesce(d.line_name,'') AS line_name,
      coalesce((SELECT q.code FROM r8_qrcodes q WHERE q.device_id=d.id ORDER BY q.created_at DESC LIMIT 1),'') AS qr_code,
      r.result,r.sign_status,r.executor_name,r.team_name,r.executed_at,coalesce(ct.title,'') AS content_title,r.content_id,
      coalesce((SELECT rp.code FROM r8_repairs rp WHERE rp.device_id=r.device_id AND rp.source='维保记录' ORDER BY rp.created_at DESC LIMIT 1),'') AS repair_code
      FROM r8_maint_records r LEFT JOIN r8_maint_plans p ON p.tenant_id=r.tenant_id AND p.id=r.plan_id LEFT JOIN r8_devices d ON d.tenant_id=r.tenant_id AND d.id=r.device_id
      LEFT JOIN r8_equip_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id LEFT JOIN r8_maint_contents ct ON ct.tenant_id=r.tenant_id AND ct.id=r.content_id
      ORDER BY r.executed_at DESC`)).rows.map((row) => ({ ...row, abnormal: row.result === '异常', executed_at_text: fmt(row.executed_at), materials_text: '管理', spare_text: '-', verify_status: '-', first_verify_at: '-' })) })));
  app.post('/api/equip/records', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const deviceId = clean(body.device_id, 80, '设备', true);
    if (!(await sql.query('SELECT id FROM r8_devices WHERE id=$1', [deviceId])).rows[0]) throw new Problem(422, 'DEVICE', '设备不存在');
    const taskId = clean(body.task_id, 80, '维保任务') || '';
    let planId = clean(body.plan_id, 80, '维保计划') || null;
    if (taskId) {
      const task = (await sql.query<{ plan_id: string }>('SELECT plan_id FROM r8_maint_tasks WHERE id=$1', [taskId])).rows[0];
      if (!task) throw new Problem(422, 'TASK', '维保任务不存在');
      planId = task.plan_id;
    }
    const contentId = clean(body.content_id, 80, '维保内容') || null;
    const result = clean(body.result, 20, '结果') || '正常';
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_maint_records(tenant_id,plan_id,device_id,content_id,result,executor_name,team_name,executed_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) RETURNING id', [actor.tenant_id, planId, deviceId, contentId, result, actor.display_name, clean(body.team_name, 40, '团队') || '默认团队'])).rows[0]!.id;
    if (taskId) await sql.query("UPDATE r8_maint_tasks SET status='已完成' WHERE id=$1", [taskId]);
    return { id };
  })));
  app.get('/api/equip/breakdowns', (request) => read(request, async (sql) => {
    const contentId = (request.query as { content_id?: string }).content_id ?? '';
    const base = `SELECT r.id,coalesce(p.title,'') AS plan_title,coalesce(c.name,'') AS category_name,coalesce(d.name,'') AS device_name,coalesce(d.code,'') AS device_code,coalesce(d.spec,'') AS device_spec,r.executor_name,r.team_name,r.executed_at,coalesce(ct.title,'') AS item_name,r.result
      FROM r8_maint_records r LEFT JOIN r8_maint_plans p ON p.tenant_id=r.tenant_id AND p.id=r.plan_id LEFT JOIN r8_devices d ON d.tenant_id=r.tenant_id AND d.id=r.device_id LEFT JOIN r8_equip_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id LEFT JOIN r8_maint_contents ct ON ct.tenant_id=r.tenant_id AND ct.id=r.content_id`;
    if (!contentId) {
      return { items: [], hint: '请选择维保内容以查看明细数据', check_items: [] };
    }
    const items = (await sql.query(`${base} WHERE r.content_id=$1 ORDER BY r.executed_at DESC`, [contentId])).rows.map((row) => ({ ...row, executed_at_text: fmt(row.executed_at) }));
    const checkItems = (await sql.query('SELECT id,name FROM r8_maint_items WHERE content_id=$1 ORDER BY sort_no', [contentId])).rows;
    return { items, hint: '', check_items: checkItems };
  }));

  app.get('/api/equip/pi-plans', (request) => read(request, async (sql) => {
    const enabled = (request.query as { enabled?: string }).enabled;
    const items = (await sql.query<{ enabled: boolean; last_at: string | null; created_at: string }>(`SELECT p.id,d.code AS device_code,d.name AS device_name,d.status,coalesce(c.name,'') AS category_name,p.executor_name,p.team_name,coalesce(t.title,'') AS content_title,p.content_id,p.enabled,p.last_at,p.created_at,
      coalesce((SELECT count(*) FROM r8_maint_items mi WHERE mi.content_id=p.content_id),0) AS content_count
      FROM r8_pi_plans p JOIN r8_devices d ON d.tenant_id=p.tenant_id AND d.id=p.device_id LEFT JOIN r8_equip_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id LEFT JOIN r8_maint_contents t ON t.tenant_id=p.tenant_id AND t.id=p.content_id ORDER BY p.created_at DESC`)).rows
      .map((row) => ({ ...row, enabled_text: row.enabled ? '启用' : '禁用', last_at_text: row.last_at ? fmt(row.last_at) : '-', created_at_text: fmt(row.created_at) }))
      .filter((row) => !enabled || enabled === '全部' || (enabled === '启用' && row.enabled) || (enabled === '禁用' && !row.enabled));
    return { items };
  }));
  app.post('/api/equip/pi-plans', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const rows = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [body];
    const ids: string[] = [];
    for (const row of rows) {
      const id = (await sql.query<{ id: string }>('INSERT INTO r8_pi_plans(tenant_id,device_id,content_id,executor_name,team_name) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, clean(row.device_id, 80, '设备', true), clean(row.content_id, 80, '维保内容') || null, clean(row.executor_name, 80, '执行人') || '', clean(row.team_name, 40, '团队') || '默认团队'])).rows[0]!.id;
      ids.push(id);
    }
    return { ids, id: ids[0] };
  })));
  app.patch('/api/equip/pi-plans/:id', (request) => write(request, async (sql) => {
    if (bodyOf(request).enabled !== undefined) await sql.query('UPDATE r8_pi_plans SET enabled=$2 WHERE id=$1', [idOf(request), Boolean(bodyOf(request).enabled)]);
    return { ok: true };
  }));
  app.delete('/api/equip/pi-plans/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_pi_plans WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '点检计划不存在');
    return { ok: true };
  }));
  app.get('/api/equip/pi-records', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT r.id,d.name AS device_name,d.code AS device_code,coalesce(c.name,'') AS category_name,r.inspector_name,r.team_name,r.content_name,r.normal_count,r.abnormal_count,r.checked_at
    FROM r8_pi_records r JOIN r8_devices d ON d.tenant_id=r.tenant_id AND d.id=r.device_id LEFT JOIN r8_equip_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id ORDER BY r.checked_at DESC`)).rows.map((row) => ({ ...row, abnormal: Number(row.abnormal_count) > 0, spare_text: '-', checked_at_text: fmt(row.checked_at) })) })));
  app.post('/api/equip/pi-records', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const deviceId = clean(body.device_id, 80, '设备', true);
    if (!(await sql.query('SELECT id FROM r8_devices WHERE id=$1', [deviceId])).rows[0]) throw new Problem(422, 'DEVICE', '设备不存在');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_pi_records(tenant_id,device_id,content_name,inspector_name,team_name,normal_count,abnormal_count,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) RETURNING id', [actor.tenant_id, deviceId, clean(body.content_name, 80, '维保内容') || '点检', actor.display_name, clean(body.team_name, 40, '团队') || '默认团队', Number(body.normal_count ?? 1) || 1, Number(body.abnormal_count ?? 0) || 0])).rows[0]!.id;
    return { id };
  })));
  app.delete('/api/equip/pi-records/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_pi_records WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '点检记录不存在');
    return { ok: true };
  }));

  app.get('/api/equip/repairs', (request) => read(request, async (sql, actor) => {
    const settings = (await sql.query<{ alarm_notify: Record<string, unknown> }>('SELECT alarm_notify FROM r8_equip_settings WHERE tenant_id=$1', [actor.tenant_id])).rows[0];
    const timeoutMin = Number((settings?.alarm_notify as { repair_timeout_minutes?: number } | undefined)?.repair_timeout_minutes ?? 0) || 0;
    const raw = (await sql.query<{ device_name: string; device_code: string; accepted_at: string | null; finished_at: string | null; status: string; created_at: string; result: string; overdue: boolean }>(`SELECT r.id,r.code,d.name AS device_name,d.code AS device_code,r.handler_name,r.team_name,r.accepted_at,r.finished_at,r.fault_type,r.description,r.status,r.sign_status,r.source,r.reporter_name,r.result,r.created_at,r.overdue
      FROM r8_repairs r JOIN r8_devices d ON d.tenant_id=r.tenant_id AND d.id=r.device_id ORDER BY r.created_at DESC`)).rows;
    const now = Date.now();
    const items = raw.map((row) => {
      const overdue = timeoutMin > 0 && row.status !== '已完成' && row.status !== '取消' && (now - new Date(String(row.created_at)).getTime()) > timeoutMin * 60000;
      return {
        ...row,
        device_label: `${row.device_name}[${row.device_code}]`,
        accept_at_text: row.accepted_at ? fmt(row.accepted_at) : '-',
        finish_at_text: row.finished_at ? fmt(row.finished_at) : '-',
        repair_duration: durText(row.accepted_at, row.finished_at || (row.status === '处理中' ? new Date() : null)),
        order_duration: durText(row.created_at, row.finished_at || new Date()),
        created_at_text: fmt(row.created_at),
        pause_reason: '-', cancel_reason: '-', auditor_name: '-', audit_at_text: '-', abnormal_text: '查看',
        solved_text: row.result ? '是' : '-', overdue: overdue || Boolean(row.overdue),
      };
    });
    const counts: Record<string, number> = { 全部: items.length };
    for (const status of repairStatus) counts[status] = items.filter((item) => item.status === status).length;
    counts['已超时'] = items.filter((item) => item.overdue).length;
    counts['未超时'] = items.filter((item) => !item.overdue).length;
    const status = (request.query as { status?: string }).status;
    const overtime = (request.query as { overtime?: string }).overtime;
    let filtered = items;
    if (status && status !== '全部') filtered = filtered.filter((item) => item.status === status);
    if (overtime === '已超时') filtered = filtered.filter((item) => item.overdue);
    if (overtime === '未超时') filtered = filtered.filter((item) => !item.overdue);
    return { items: filtered, counts };
  }));
  app.post('/api/equip/repairs', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const code = clean(body.code, 64, '工单编号') || await serial(sql, actor.tenant_id, 'WXGD', 'WXGD');
    const handler = clean(body.handler_name, 80, '处理人');
    const source = clean(body.source, 20, '来源') || '人工创建';
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_repairs(tenant_id,code,device_id,team_name,handler_name,fault_type,description,reporter_name,status,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [
      actor.tenant_id, code, clean(body.device_id, 80, '维修设备', true, 'select'), clean(body.team_name, 40, '团队', true, 'select'), handler,
      clean(body.fault_type, 40, '故障类别'), clean(body.description, 1000, '故障描述', true), actor.display_name, handler ? '待接单' : '待派单', source,
    ])).rows[0]!.id;
    return { id, code };
  })));
  app.get('/api/equip/repairs/:id', (request) => read(request, async (sql) => {
    const repair = (await sql.query(`SELECT r.*,d.name AS device_name,d.code AS device_code,d.status AS device_status FROM r8_repairs r JOIN r8_devices d ON d.tenant_id=r.tenant_id AND d.id=r.device_id WHERE r.id=$1`, [idOf(request)])).rows[0];
    if (!repair) throw new Problem(404, 'NOT_FOUND', '维修工单不存在');
    return {
      repair: {
        ...repair,
        accept_at_text: repair.accepted_at ? fmt(repair.accepted_at) : '无',
        finish_at_text: repair.finished_at ? fmt(repair.finished_at) : '无',
        repair_duration: durText(repair.accepted_at, repair.finished_at) === '-' ? '无' : durText(repair.accepted_at, repair.finished_at),
        order_duration: durText(repair.created_at, repair.finished_at || new Date()),
        created_at_text: fmt(repair.created_at) || '无',
        pause_reason: '无', cancel_reason: '无', auditor_name: '无', audit_at_text: '无', audit_note: '无', abnormal_text: '无',
        sign_status: repair.sign_status || '无',
      },
    };
  }));
  app.post('/api/equip/repairs/:id/actions', (request) => write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const action = clean(body.action, 20, '操作', true);
    const row = (await sql.query<{ status: string; device_id: string }>('SELECT status,device_id FROM r8_repairs WHERE id=$1', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '维修工单不存在');
    const settings = (await sql.query<{ repair_audit: boolean; status_follow_repair: boolean }>('SELECT repair_audit,status_follow_repair FROM r8_equip_settings WHERE tenant_id=$1', [actor.tenant_id])).rows[0];
    const audit = settings?.repair_audit !== false;
    let next = '';
    if (action === '接单') next = '处理中';
    else if (action === '完成' || action === '完成维修') next = audit ? '待审核' : '已完成';
    else if (action === '暂停') next = '暂停';
    else if (action === '取消') next = '取消';
    else if (action === '继续') next = '处理中';
    else if (action === '审核通过') next = '已完成';
    else if (action === '审核退回') next = '审核退回';
    else if (action === '派单') {
      next = '待接单';
      await sql.query('UPDATE r8_repairs SET handler_name=$2 WHERE id=$1', [idOf(request), clean(body.handler_name, 80, '处理人', true)]);
    } else throw new Problem(422, 'ACTION', '不支持的操作');
    await sql.query(`UPDATE r8_repairs SET status=$2, result=CASE WHEN $3<>'' THEN $3 ELSE result END,
      accepted_at=CASE WHEN $2='处理中' AND accepted_at IS NULL THEN now() ELSE accepted_at END,
      finished_at=CASE WHEN $2='已完成' THEN now() ELSE finished_at END WHERE id=$1`, [idOf(request), next, clean(body.result, 255, '处理结果')]);
    if (settings?.status_follow_repair) {
      if (next === '处理中') await sql.query("UPDATE r8_devices SET status='维修中' WHERE id=$1", [row.device_id]);
      if (next === '已完成') await sql.query("UPDATE r8_devices SET status='正常' WHERE id=$1", [row.device_id]);
    }
    return { status: next };
  }));
  app.delete('/api/equip/repairs/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_repairs WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '维修工单不存在');
    return { ok: true };
  }));

  app.get('/api/equip/settings', (request) => read(request, async (sql, actor) => {
    let row = (await sql.query('SELECT * FROM r8_equip_settings WHERE tenant_id=$1', [actor.tenant_id])).rows[0];
    if (!row) { await sql.query('INSERT INTO r8_equip_settings(tenant_id) VALUES($1)', [actor.tenant_id]); row = (await sql.query('SELECT * FROM r8_equip_settings WHERE tenant_id=$1', [actor.tenant_id])).rows[0]; }
    if (!row) throw new Problem(500, 'SETTINGS', '维保设置初始化失败');
    const alarm = (row.alarm_notify && typeof row.alarm_notify === 'object' ? row.alarm_notify : {}) as Record<string, unknown>;
    return {
      settings: {
        ...row,
        scan_dispatch_label: row.scan_dispatch === '报修时允许派单' ? '报修时，允许派单。' : '报修时，不允许派单。',
        alarm_notify: {
          task_timeout: alarm.task_timeout ?? [], task_miss: alarm.task_miss ?? [], record_abnormal: alarm.record_abnormal ?? [],
          repair_timeout_minutes: Number(alarm.repair_timeout_minutes ?? 0) || 0, repair_timeout: alarm.repair_timeout ?? [],
        },
      },
      categories: (await sql.query('SELECT id,parent_id,name,sort_no FROM r8_equip_categories ORDER BY sort_no,name')).rows,
      shops: (await sql.query('SELECT id,name,sort_no FROM r8_shops ORDER BY sort_no')).rows,
      lines: (await sql.query('SELECT id,name,sort_no FROM r8_lines ORDER BY sort_no')).rows,
      plan_categories: ['车床维保', '阀门维保', '叉车检查'],
      device_statuses: [{ name: '正常', kind: '完好', color: '绿' }, { name: '维修中', kind: '故障', color: '黄' }, { name: '运行中', kind: '完好', color: '蓝' }],
    };
  }));
  app.put('/api/equip/settings', (request) => write(request, async (sql, actor) => {
    const body = bodyOf(request);
    await sql.query('INSERT INTO r8_equip_settings(tenant_id) VALUES($1) ON CONFLICT (tenant_id) DO NOTHING', [actor.tenant_id]);
    let dispatch = clean(body.scan_dispatch, 40, '派单') || '不允许派单';
    if (dispatch.includes('允许派单') && !dispatch.includes('不')) dispatch = '报修时允许派单';
    else dispatch = '不允许派单';
    const alarm = body.alarm_notify && typeof body.alarm_notify === 'object' ? body.alarm_notify : {};
    await sql.query(`UPDATE r8_equip_settings SET export_repair_image=$2,export_record_image=$3,scan_login=$4,scan_dispatch=$5,scan_repair=$6,repair_audit=$7,all_spares=$8,hide_shop=$9,status_follow_repair=$10,default_result=$11,alarm_notify=$12::jsonb WHERE tenant_id=$1`, [
      actor.tenant_id, Boolean(body.export_repair_image), Boolean(body.export_record_image), Boolean(body.scan_login), dispatch,
      body.scan_repair !== false, body.repair_audit !== false, Boolean(body.all_spares), Boolean(body.hide_shop), Boolean(body.status_follow_repair),
      clean(body.default_result, 20, '默认结果') || '待定', JSON.stringify(alarm),
    ]);
    return { ok: true };
  }));
  app.post('/api/equip/shops', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const name = clean(bodyOf(request).name, 80, '分类名称', true);
    const sort = Number((await sql.query<{ n: string }>('SELECT coalesce(max(sort_no),0)+1 AS n FROM r8_shops')).rows[0]?.n || 1);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_shops(tenant_id,name,sort_no) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, name, sort])).rows[0]!.id;
    return { id };
  })));
  app.post('/api/equip/lines', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const name = clean(bodyOf(request).name, 80, '名称', true);
    const sort = Number((await sql.query<{ n: string }>('SELECT coalesce(max(sort_no),0)+1 AS n FROM r8_lines')).rows[0]?.n || 1);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_lines(tenant_id,name,sort_no) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, name, sort])).rows[0]!.id;
    return { id };
  })));

  app.get('/api/equip/reports/repair', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT team_name, count(DISTINCT device_id)::int AS devices, count(*)::int AS times FROM r8_repairs GROUP BY team_name`)).rows })));
  app.get('/api/equip/reports/workload', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT team_name, count(DISTINCT handler_name)::int AS people, count(*) FILTER (WHERE status='已完成')::int AS done, count(*)::int AS total FROM r8_repairs GROUP BY team_name`)).rows })));
  app.get('/api/equip/reports/plans', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT p.title,p.category,p.cycle_text,p.executor_name,cardinality(p.device_ids) AS device_count, count(t.id)::int AS should_times, count(t.id) FILTER (WHERE t.status='已完成')::int AS done_times FROM r8_maint_plans p LEFT JOIN r8_maint_tasks t ON t.plan_id=p.id GROUP BY p.id`)).rows.map((row) => ({ ...row, rate: row.should_times ? `${Math.round(Number(row.done_times) / Number(row.should_times) * 100)}` : '0' })) })));
}
