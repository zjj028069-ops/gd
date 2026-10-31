import type { FastifyInstance } from 'fastify';
import { Problem, type Actor, type Services } from './services.js';
import type { Sql } from './database.js';
import { bodyOf, clean, idOf, num, serial, withTenant } from './round8-kit.js';

const machineStatus = ['正常', '维修中', '运行中'];

async function ensureDevice(sql: Sql, actor: Actor, machine: { id: string; code: string; name: string; spec: string; status: string; category_name: string }) {
  if ((await sql.query('SELECT id FROM r8_devices WHERE machine_id=$1', [machine.id])).rows[0]) return;
  let category = (await sql.query<{ id: string }>('SELECT id FROM r8_equip_categories WHERE name=$1', [machine.category_name || '机台同步'])).rows[0];
  if (!category) {
    category = (await sql.query<{ id: string }>('INSERT INTO r8_equip_categories(tenant_id,name) VALUES($1,$2) RETURNING id', [actor.tenant_id, machine.category_name || '机台同步'])).rows[0];
  }
  const code = await serial(sql, actor.tenant_id, 'SB', 'SB');
  await sql.query('INSERT INTO r8_devices(tenant_id,machine_id,code,name,spec,status,category_id,owner_name,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [actor.tenant_id, machine.id, code, machine.name, machine.spec, machine.status, category?.id ?? null, actor.display_name, actor.user_id]);
}

function efficiency(seconds: number, output: number) {
  if (!seconds || !output) return '-';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${num(output)}/${hours}小时${minutes}分钟`;
}

export function registerMachineStation(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);

  app.get('/api/machines/shops', (request) => read(request, async (sql) => ({ items: (await sql.query('SELECT id,parent_id,name,sort_no FROM r8_shops ORDER BY sort_no,name')).rows })));
  app.post('/api/machines/shops', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_shops(tenant_id,parent_id,name) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, clean(body.parent_id, 80, '上级') || null, clean(body.name, 80, '分类名称', true)])).rows[0]!.id;
    return { id };
  })));
  app.patch('/api/machines/shops/:id', (request) => write(request, async (sql) => {
    const row = (await sql.query('UPDATE r8_shops SET name=$2 WHERE id=$1 RETURNING id,name', [idOf(request), clean(bodyOf(request).name, 80, '分类名称', true)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '车间不存在');
    return { item: row };
  }));
  app.delete('/api/machines/shops/:id', (request) => write(request, async (sql) => {
    if ((await sql.query('SELECT id FROM r8_shops WHERE parent_id=$1 LIMIT 1', [idOf(request)])).rows[0]) throw new Problem(409, 'USED', '请先删除下级车间');
    if (!(await sql.query('DELETE FROM r8_shops WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '车间不存在');
    return { ok: true };
  }));

  app.get('/api/machines/lines', (request) => read(request, async (sql) => ({ items: (await sql.query('SELECT id,name,sort_no FROM r8_lines ORDER BY sort_no,name')).rows })));
  app.post('/api/machines/lines', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const name = clean(bodyOf(request).name, 80, '名称', true);
    const sort = Number((await sql.query<{ n: string }>('SELECT coalesce(max(sort_no),0)+1 AS n FROM r8_lines')).rows[0]!.n);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_lines(tenant_id,name,sort_no) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, name, sort])).rows[0]!.id;
    return { id, name };
  })));
  app.delete('/api/machines/lines/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_lines WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '产线不存在');
    return { ok: true };
  }));

  app.get('/api/machines/categories', (request) => read(request, async (sql) => ({ items: (await sql.query('SELECT id,parent_id,name,sort_no FROM r8_machine_categories ORDER BY sort_no,name')).rows })));
  app.post('/api/machines/categories', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_machine_categories(tenant_id,parent_id,name) VALUES($1,$2,$3) RETURNING id', [actor.tenant_id, clean(body.parent_id, 80, '上级') || null, clean(body.name, 80, '机台类别', true)])).rows[0]!.id;
    return { id };
  })));
  app.delete('/api/machines/categories/:id', (request) => write(request, async (sql) => {
    if ((await sql.query('SELECT id FROM r8_machines WHERE category_id=$1 LIMIT 1', [idOf(request)])).rows[0]) throw new Problem(409, 'USED', '类别下还有机台，不能删除');
    if (!(await sql.query('DELETE FROM r8_machine_categories WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '机台类别不存在');
    return { ok: true };
  }));

  app.get('/api/machines/statuses', (request) => read(request, async (sql, actor) => {
    if (!(await sql.query('SELECT id FROM r8_machine_statuses LIMIT 1')).rows[0]) {
      await sql.query("INSERT INTO r8_machine_statuses(tenant_id,name,kind,color,sort_no) VALUES ($1,'正常','完好','#52c41a',1),($1,'维修中','故障','#fa8c16',2),($1,'运行中','完好','#1677ff',3)", [actor.tenant_id]);
    }
    return { items: (await sql.query('SELECT id,name,kind,color,sort_no FROM r8_machine_statuses ORDER BY sort_no')).rows };
  }));

  app.get('/api/machines', (request) => read(request, async (sql) => {
    const enabled = (request.query as { enabled?: string }).enabled;
    const rows = (await sql.query<Record<string, unknown>>(`SELECT m.id,m.code,m.name,m.spec,m.status,m.sync_device,m.hours_per_day::text,m.std_seconds,m.std_output::text,m.enabled,m.created_at,
      c.name AS category_name, coalesce(s.name,'') AS shop_name, coalesce(l.name,'') AS line_name
      FROM r8_machines m JOIN r8_machine_categories c ON c.tenant_id=m.tenant_id AND c.id=m.category_id
      LEFT JOIN r8_shops s ON s.tenant_id=m.tenant_id AND s.id=m.shop_id
      LEFT JOIN r8_lines l ON l.tenant_id=m.tenant_id AND l.id=m.line_id
      WHERE ($1::text IS NULL OR ($1='1' AND m.enabled) OR ($1='0' AND NOT m.enabled))
      ORDER BY m.created_at DESC`, [enabled ?? null])).rows;
    return { items: rows.map((row) => ({ ...row, hours_per_day: num(row.hours_per_day), std_output: num(row.std_output), hours_text: Number(row.hours_per_day) ? `${num(row.hours_per_day)} 小时/天` : '-', efficiency_text: efficiency(Number(row.std_seconds), Number(row.std_output)), enabled_text: row.enabled ? '启用' : '禁用' })) };
  }));
  app.post('/api/machines', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const status = clean(body.status, 20, '机台状态', true, 'select');
    if (!machineStatus.includes(status)) throw new Problem(422, 'STATUS', '机台状态只能是正常、维修中或运行中');
    const categoryId = clean(body.category_id, 80, '机台类别', true, 'select');
    const category = (await sql.query<{ name: string }>('SELECT name FROM r8_machine_categories WHERE id=$1', [categoryId])).rows[0];
    if (!category) throw new Problem(422, 'CATEGORY', '机台类别不存在');
    const code = clean(body.code, 64, '机台编号') || await serial(sql, actor.tenant_id, 'JT', 'JT');
    const name = clean(body.name, 80, '机台名称', true);
    const spec = clean(body.spec, 80, '机台规格');
    const sync = body.sync_device === true || body.sync_device === '是';
    const id = (await sql.query<{ id: string }>(`INSERT INTO r8_machines(tenant_id,code,name,spec,status,category_id,sync_device,shop_id,line_id,hours_per_day,std_seconds,std_output)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [
      actor.tenant_id, code, name, spec, status, categoryId, sync, clean(body.shop_id, 80, '车间') || null, clean(body.line_id, 80, '产线') || null,
      Number(body.hours_per_day ?? 0) || 0, Number(body.std_seconds ?? 0) || 0, Number(body.std_output ?? 0) || 0,
    ])).rows[0]!.id;
    if (sync) await ensureDevice(sql, actor, { id, code, name, spec, status, category_name: category.name });
    return { id, code, status };
  })));
  app.patch('/api/machines/:id', (request) => write(request, async (sql) => {
    const body = bodyOf(request);
    const current = (await sql.query('SELECT id FROM r8_machines WHERE id=$1', [idOf(request)])).rows[0];
    if (!current) throw new Problem(404, 'NOT_FOUND', '机台不存在');
    if (body.enabled !== undefined) await sql.query('UPDATE r8_machines SET enabled=$2 WHERE id=$1', [idOf(request), Boolean(body.enabled)]);
    if (body.status) {
      const status = clean(body.status, 20, '机台状态', true, 'select');
      if (!machineStatus.includes(status)) throw new Problem(422, 'STATUS', '机台状态只能是正常、维修中或运行中');
      await sql.query('UPDATE r8_machines SET status=$2 WHERE id=$1', [idOf(request), status]);
    }
    if (body.name) await sql.query('UPDATE r8_machines SET name=$2,spec=$3 WHERE id=$1', [idOf(request), clean(body.name, 80, '机台名称', true), clean(body.spec, 80, '机台规格')]);
    return { ok: true };
  }));
  app.delete('/api/machines/:id', (request) => write(request, async (sql) => {
    if ((await sql.query('SELECT id FROM production_reports WHERE machine_id=$1 LIMIT 1', [idOf(request)])).rows[0]) throw new Problem(409, 'USED', '机台已有报工，不能删除');
    if (!(await sql.query('DELETE FROM r8_machines WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '机台不存在');
    return { ok: true };
  }));

  app.get('/api/stations/settings', (request) => read(request, async (sql, actor) => {
    const row = (await sql.query('SELECT enterprise_code,password FROM r8_station_settings WHERE tenant_id=$1', [actor.tenant_id])).rows[0];
    return { enterprise_code: row?.enterprise_code ?? '', password: row?.password ?? '' };
  }));
  app.put('/api/stations/settings', (request) => write(request, async (sql, actor) => {
    const body = bodyOf(request);
    await sql.query(`INSERT INTO r8_station_settings(tenant_id,enterprise_code,password) VALUES($1,$2,$3)
      ON CONFLICT (tenant_id) DO UPDATE SET enterprise_code=$2,password=$3`, [actor.tenant_id, clean(body.enterprise_code, 80, '企业编号'), clean(body.password, 80, '激活密码')]);
    return { ok: true };
  }));
  app.get('/api/stations', (request) => read(request, async (sql) => {
    const rows = (await sql.query(`SELECT s.id,s.name,s.device_ids,coalesce(sh.name,'') AS shop_name,coalesce(l.name,'') AS line_name FROM r8_stations s
      LEFT JOIN r8_shops sh ON sh.tenant_id=s.tenant_id AND sh.id=s.shop_id
      LEFT JOIN r8_lines l ON l.tenant_id=s.tenant_id AND l.id=s.line_id ORDER BY s.created_at DESC`)).rows;
    const items = [];
    for (const row of rows) {
      const users = (await sql.query<{ display_name: string; id: string }>('SELECT u.id,u.display_name FROM r8_station_users su JOIN tenant_team_members u ON u.id=su.user_id WHERE su.station_id=$1 ORDER BY u.display_name', [row.id])).rows;
      const deviceIds = Array.isArray(row.device_ids) ? row.device_ids as string[] : [];
      const devices = deviceIds.length
        ? (await sql.query<{ name: string }>('SELECT name FROM r8_devices WHERE id = ANY($1::uuid[]) ORDER BY name', [deviceIds])).rows
        : [];
      items.push({ ...row, device_ids: deviceIds, user_ids: users.map((user) => user.id), workers: users.map((user) => user.display_name).join('、'), devices: devices.map((item) => item.name).join('、') });
    }
    return { items };
  }));
  app.post('/api/stations', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const name = clean(body.name, 80, '工作站名称', true);
    const userIds = Array.isArray(body.user_ids) ? body.user_ids.map(String) : [];
    const deviceIds = Array.isArray(body.device_ids) ? body.device_ids.map(String) : [];
    if (!userIds.length) throw new Problem(422, 'WORKER', '请选择工作人员');
    if (deviceIds.length) {
      const found = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM r8_devices WHERE id = ANY($1::uuid[])', [deviceIds])).rows[0]?.n ?? 0);
      if (found !== deviceIds.length) throw new Problem(422, 'DEVICE', '维保设备不存在');
    }
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_stations(tenant_id,name,shop_id,line_id,device_ids) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, name, clean(body.shop_id, 80, '车间') || null, clean(body.line_id, 80, '产线') || null, deviceIds])).rows[0]!.id;
    for (const userId of userIds) {
      if (!(await sql.query('SELECT id FROM tenant_team_members WHERE id=$1', [userId])).rows[0]) throw new Problem(422, 'USER', '工作人员不存在');
      await sql.query('INSERT INTO r8_station_users(tenant_id,station_id,user_id) VALUES($1,$2,$3)', [actor.tenant_id, id, userId]);
    }
    return { id, name };
  })));
  app.delete('/api/stations/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_stations WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '工作站不存在');
    return { ok: true };
  }));
}
