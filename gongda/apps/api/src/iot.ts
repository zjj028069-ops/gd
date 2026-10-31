import type { FastifyInstance } from 'fastify';
import { Problem, type Services } from './services.js';
import { bodyOf, clean, idOf, serial, withTenant } from './round8-kit.js';

export function registerIot(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);

  app.get('/api/iot/scenes', (request) => read(request, async (sql) => {
    const hide = (request.query as { hide_demo?: string }).hide_demo === '1';
    const items = (await sql.query('SELECT id,name,device_name,shop_name,line_name,status,alarm_level,demo,updated_at FROM r8_iot_scenes WHERE ($1::bool IS NOT TRUE OR NOT demo) ORDER BY created_at DESC', [hide])).rows;
    const all = (await sql.query<{ status: string; demo: boolean }>('SELECT status,demo FROM r8_iot_scenes')).rows;
    return { items, counts: { 全部: all.filter((row) => !hide || !row.demo).length, 报警中: all.filter((row) => row.status === '报警中' && (!hide || !row.demo)).length, 正常: all.filter((row) => row.status !== '报警中' && (!hide || !row.demo)).length }, demo_count: all.filter((row) => row.demo).length };
  }));
  app.post('/api/iot/scenes', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    if (body.ensure_demo === true) {
      await sql.query("UPDATE r8_iot_scenes SET demo=true WHERE position('演示' in name) > 0");
      return { ok: true };
    }
    const demo = body.demo === true;
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_iot_scenes(tenant_id,name,device_name,shop_name,line_name,demo) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [actor.tenant_id, clean(body.name, 80, '场景名', true), clean(body.device_name, 80, '关联设备'), clean(body.shop_name, 80, '车间'), clean(body.line_name, 80, '产线'), demo])).rows[0]!.id;
    const sensors = Array.isArray(body.sensors) ? body.sensors as Record<string, unknown>[] : [];
    for (const sensor of sensors) {
      const code = clean(sensor.code, 64, '编号') || await serial(sql, actor.tenant_id, 'CGQ', 'CGQ');
      await sql.query('INSERT INTO r8_iot_sensors(tenant_id,scene_id,kind,code,gateway,bind_status,point_name,interval_text) VALUES($1,$2,$3,$4,$5,\'已绑定\',$6,$7)', [actor.tenant_id, id, clean(sensor.kind, 40, '传感器类型'), code, clean(sensor.gateway, 40, '网关'), clean(sensor.point_name, 40, '点位名称'), clean(sensor.interval_text, 40, '采集间隔')]);
    }
    return { id };
  })));
  app.post('/api/iot/scenes/:id/clear-alarm', (request) => write(request, async (sql) => {
    const row = (await sql.query("UPDATE r8_iot_scenes SET status='正常',alarm_level='',updated_at=now() WHERE id=$1 AND status='报警中' RETURNING id", [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '没有需要消警的场景');
    return { ok: true };
  }));
  app.get('/api/iot/sensors', (request) => read(request, async (sql) => ({ items: (await sql.query(`SELECT s.id,s.kind,s.code,s.gateway,s.bind_status,s.point_name,s.interval_text,coalesce(c.name,'') AS scene_name FROM r8_iot_sensors s LEFT JOIN r8_iot_scenes c ON c.tenant_id=s.tenant_id AND c.id=s.scene_id ORDER BY s.created_at DESC`)).rows })));
  app.get('/api/iot/alarms', (request) => read(request, async (sql) => ({ items: (await sql.query('SELECT id,scene_name,shop_name,line_name,auto_name,level,sensor_value,notify_names,result,cleared_by,alarmed_at FROM r8_iot_alarms ORDER BY alarmed_at DESC')).rows })));
  app.post('/api/iot/alarms', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const sceneId = clean(body.scene_id, 80, '物联场景') || null;
    const scene = sceneId ? (await sql.query<{ id: string; name: string; shop_name: string; line_name: string }>('SELECT id,name,shop_name,line_name FROM r8_iot_scenes WHERE id=$1', [sceneId])).rows[0] : null;
    if (sceneId && !scene) throw new Problem(422, 'SCENE', '物联场景不存在');
    const sceneName = scene?.name ?? (clean(body.scene_name, 80, '场景名') || '物联场景');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_iot_alarms(tenant_id,scene_id,scene_name,shop_name,line_name,auto_name,level,sensor_value,notify_names,result,alarmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) RETURNING id', [actor.tenant_id, scene?.id ?? null, sceneName, scene?.shop_name ?? '', scene?.line_name ?? '', clean(body.auto_name, 40, '自动化') || '自动', clean(body.level, 20, '等级') || '一般', clean(body.sensor_value, 40, '传感值') || '-', actor.display_name, clean(body.result, 20, '结果') || '未处理'])).rows[0]!.id;
    return { id };
  })));
  app.get('/api/iot/dicts', (request) => read(request, async (sql) => ({ shops: (await sql.query('SELECT id,parent_id,name,sort_no FROM r8_shops ORDER BY sort_no,name')).rows, lines: (await sql.query('SELECT id,name,sort_no FROM r8_lines ORDER BY sort_no,name')).rows })));
}
