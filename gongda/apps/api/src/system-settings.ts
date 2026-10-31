import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { assertPoint } from './kgd-permissions.js';
import { Problem, type Actor, type Services } from './services.js';
import { bool, idList, idText, intIn, member, numText, pageOf, requireVersion, shanghaiTime, text, type Row } from './r10-kit.js';

type BasicSettings = { product_qr_repair: boolean; device_qr_repair: boolean; device_qr_patrol: boolean; map_hidden_user_ids: string[]; photo_watermark: boolean; version: number };
const basicColumns = 'product_qr_repair,device_qr_repair,device_qr_patrol,map_hidden_user_ids,photo_watermark,version';
const smsPackages = [
  { name: '2000条', sms_count: 2000, amount: '249.00' },
  { name: '5000条', sms_count: 5000, amount: '399.00' },
  { name: '10000条', sms_count: 10000, amount: '749.00' },
];

export async function basicSettings(sql: Sql, tenantId: string) {
  await sql.query('INSERT INTO basic_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId]);
  return (await sql.query<BasicSettings>(`SELECT ${basicColumns} FROM basic_settings`)).rows[0]!;
}

async function ensureWorkStatuses(sql: Sql, tenantId: string) {
  if ((await sql.query('SELECT 1 FROM work_statuses LIMIT 1')).rows[0]) return;
  await sql.query("INSERT INTO work_statuses(tenant_id,name,color,sort_no) VALUES($1,'忙碌','#f5222d',1),($1,'空闲','#52c41a',2) ON CONFLICT DO NOTHING", [tenantId]);
}

function color(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^#[0-9A-Fa-f]{6}$/.test(raw)) throw new Problem(422, 'COLOR', '颜色格式不正确');
  return raw;
}

export function registerSystemSettings(app: FastifyInstance, services: Services) {
  const read = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => member(services, request, false, work);
  const write = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => member(services, request, true, async (sql, actor) => { assertPoint(actor, 'system.setting'); return work(sql, actor); });

  app.get('/api/system/basics', (request) => read(request, async (sql, actor) => {
    const settings = await basicSettings(sql, actor.tenant_id);
    await ensureWorkStatuses(sql, actor.tenant_id);
    const hidden = (await sql.query('SELECT id,display_name FROM tenant_team_members WHERE id = ANY($1::uuid[]) ORDER BY display_name', [settings.map_hidden_user_ids])).rows;
    return { settings: { ...settings, map_hidden_users: hidden }, work_statuses: (await sql.query('SELECT id,name,color,sort_no FROM work_statuses ORDER BY sort_no,name')).rows };
  }));
  app.put('/api/system/basics', (request) => write(request, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const before = await basicSettings(sql, actor.tenant_id);
    requireVersion(before, body.version, '通用设置');
    const users = body.map_hidden_user_ids === undefined ? before.map_hidden_user_ids : idList(body.map_hidden_user_ids, '地图设置人员', 1000);
    if (users.length) {
      const found = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM tenant_team_members WHERE id = ANY($1::uuid[])', [users])).rows[0]!.n);
      if (found !== users.length) throw new Problem(422, 'INVALID_REFERENCE', '地图设置里有成员不存在或已停用');
    }
    const row = (await sql.query<BasicSettings>(`UPDATE basic_settings SET product_qr_repair=$1,device_qr_repair=$2,device_qr_patrol=$3,map_hidden_user_ids=$4,photo_watermark=$5,version=version+1,updated_at=now() RETURNING ${basicColumns}`, [
      bool(body.product_qr_repair, before.product_qr_repair), bool(body.device_qr_repair, before.device_qr_repair), bool(body.device_qr_patrol, before.device_qr_patrol), users, bool(body.photo_watermark, before.photo_watermark),
    ])).rows[0]!;
    return { settings: row };
  }));

  app.get('/api/work-statuses', (request) => read(request, async (sql, actor) => {
    await ensureWorkStatuses(sql, actor.tenant_id);
    return { items: (await sql.query('SELECT id,name,color,sort_no FROM work_statuses ORDER BY sort_no,name')).rows };
  }));
  app.post('/api/work-statuses', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const next = Number((await sql.query<{ n: string }>('SELECT coalesce(max(sort_no),0)+1 AS n FROM work_statuses')).rows[0]!.n);
    const row = (await sql.query<{ id: string }>('INSERT INTO work_statuses(tenant_id,name,color,sort_no) VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id,name) DO NOTHING RETURNING id', [actor.tenant_id, text(body.name, 20, '工作状态名称', true), color(body.color ?? '#1890ff'), intIn(body.sort_no, 0, 9999, '排序', next)])).rows[0];
    if (!row) throw new Problem(409, 'DUPLICATE', '工作状态名称已存在');
    return { id: row.id };
  })));
  app.put<{ Params: { id: string } }>('/api/work-statuses/:id', (request) => write(request, async (sql) => {
    const body = (request.body ?? {}) as Row;
    const id = idText(request.params.id, '工作状态', true);
    const before = (await sql.query<{ name: string; color: string; sort_no: number }>('SELECT name,color,sort_no FROM work_statuses WHERE id=$1', [id])).rows[0];
    if (!before) throw new Problem(404, 'NOT_FOUND', '工作状态不存在');
    const name = body.name === undefined ? before.name : text(body.name, 20, '工作状态名称', true);
    if ((await sql.query('SELECT 1 FROM work_statuses WHERE name=$1 AND id<>$2', [name, id])).rows[0]) throw new Problem(409, 'DUPLICATE', '工作状态名称已存在');
    await sql.query('UPDATE work_statuses SET name=$1,color=$2,sort_no=$3 WHERE id=$4', [name, body.color === undefined ? before.color : color(body.color), intIn(body.sort_no, 0, 9999, '排序', before.sort_no), id]);
    return { ok: true };
  }));
  app.post('/api/work-statuses/reorder', (request) => write(request, async (sql) => {
    const ids = idList(((request.body ?? {}) as Row).ids, '工作状态', 200);
    for (const [index, id] of ids.entries()) await sql.query('UPDATE work_statuses SET sort_no=$1 WHERE id=$2', [index + 1, id]);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/work-statuses/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM work_statuses WHERE id=$1 RETURNING id', [idText(request.params.id, '工作状态', true)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '工作状态不存在');
    return { ok: true };
  }));

  app.get('/api/system/sms', (request) => read(request, async (sql, actor) => {
    const query = (request.query ?? {}) as Row;
    await sql.query('INSERT INTO sms_accounts(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [actor.tenant_id]);
    const remaining = (await sql.query<{ remaining: number }>('SELECT remaining FROM sms_accounts')).rows[0]!.remaining;
    const rechargePage = pageOf({ page: query.recharge_page, page_size: query.recharge_page_size });
    const sendPage = pageOf({ page: query.send_page, page_size: query.send_page_size });
    const rechargeTotal = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM sms_recharges')).rows[0]!.n);
    const sendTotal = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM sms_send_logs')).rows[0]!.n);
    const recharges = (await sql.query<Row>(`SELECT id,package_name,amount::text,sms_count,${shanghaiTime('purchased_at')} AS purchased_text FROM sms_recharges ORDER BY purchased_at DESC,id LIMIT ${rechargePage.size} OFFSET ${rechargePage.offset}`)).rows
      .map((row) => ({ ...row, amount: Number(row.amount).toFixed(2) }));
    const sends = (await sql.query(`SELECT id,phone,content,${shanghaiTime('sent_at')} AS sent_text FROM sms_send_logs ORDER BY sent_at DESC,id LIMIT ${sendPage.size} OFFSET ${sendPage.offset}`)).rows;
    return {
      remaining, remaining_text: `短信剩余 ${remaining} 条`,
      packages: smsPackages.map((item) => ({ ...item, price_text: `¥${item.amount}`, purchasable: false })),
      recharges: { total: rechargeTotal, page: rechargePage.page, page_size: rechargePage.size, items: recharges },
      sends: { total: sendTotal, page: sendPage.page, page_size: sendPage.size, items: sends },
      count_text: numText(remaining),
    };
  }));

  /** Seed 用：补齐演示短信剩余/充值/发送记录（不接真实通道）。 */
  app.post('/api/system/sms/seed-demo', (request) => write(request, async (sql, actor) => {
    await sql.query('INSERT INTO sms_accounts(tenant_id,remaining) VALUES($1,100) ON CONFLICT (tenant_id) DO UPDATE SET remaining=GREATEST(sms_accounts.remaining,100),updated_at=now()', [actor.tenant_id]);
    const rechargeTotal = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM sms_recharges')).rows[0]!.n);
    if (rechargeTotal < 1) {
      await sql.query('INSERT INTO sms_recharges(tenant_id,package_name,amount,sms_count) VALUES($1,$2,$3,$4)', [actor.tenant_id, '2000条', '249.00', 2000]);
    }
    const sendTotal = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM sms_send_logs')).rows[0]!.n);
    for (let i = sendTotal; i < 3; i += 1) {
      await sql.query('INSERT INTO sms_send_logs(tenant_id,phone,content) VALUES($1,$2,$3)', [actor.tenant_id, `1380000${1000 + i}`, `R10演示短信${i + 1}`]);
    }
    const remaining = (await sql.query<{ remaining: number }>('SELECT remaining FROM sms_accounts')).rows[0]!.remaining;
    const recharges = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM sms_recharges')).rows[0]!.n);
    const sends = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM sms_send_logs')).rows[0]!.n);
    return { remaining, recharges, sends };
  }));
}
