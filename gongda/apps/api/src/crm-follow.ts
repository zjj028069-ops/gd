import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { Problem, type Actor, type Services } from './services.js';
import { guarded, idText, like, pageOf, pushMessage, requireVersion, shanghaiTime, text, timeText, oneOf, type Row } from './r10-kit.js';

const followTypes = ['上门', '电话', '网络'] as const;
const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function remindText(nextAt: Date) {
  const remind = new Date(nextAt.getTime() - 3600_000);
  const local = new Date(remind.getTime() + 8 * 3600_000);
  const day = local.toISOString().slice(0, 10);
  const hour = local.getUTCHours();
  return `将在${day} (${weekdays[local.getUTCDay()]}) ${hour < 12 ? '早上' : '下午'}${String(hour).padStart(2, '0')}点提醒您跟单`;
}

/** 到了提醒时间（下次跟单时间前 1 小时）给跟单人写一条消息，只发一次。 */
export async function syncFollowReminders(sql: Sql, actor: Pick<Actor, 'tenant_id'>) {
  const due = (await sql.query<{ id: string; follower_id: string; customer_name: string; contact_name: string; next_text: string; content: string; epoch: string }>(
    `SELECT f.id,f.follower_id,c.name AS customer_name,f.contact_name,${shanghaiTime('f.next_at')} AS next_text,f.content,extract(epoch FROM f.remind_at)::bigint::text AS epoch
     FROM customer_follows f JOIN customers c ON c.tenant_id=f.tenant_id AND c.id=f.customer_id
     WHERE NOT f.reminded AND f.remind_at<=now() ORDER BY f.remind_at LIMIT 200 FOR UPDATE OF f SKIP LOCKED`,
  )).rows;
  for (const row of due) {
    await pushMessage(sql, actor.tenant_id, row.follower_id, {
      kind: 'follow', title: '客户跟单提醒', body: `请于${row.next_text}跟进客户「${row.customer_name}」${row.contact_name ? `（联系人：${row.contact_name}）` : ''}：${row.content}`,
      objectType: 'customer_follow', objectId: row.id, linkPath: '/follow/list', dedupeKey: `follow:${row.id}:${row.epoch}`,
    });
    await sql.query('UPDATE customer_follows SET reminded=true WHERE id=$1', [row.id]);
  }
  return due.length;
}

async function followInput(sql: Sql, body: Row) {
  const customerId = idText(body.customer_id, '客户', true)!;
  const customer = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM customers WHERE id=$1', [customerId])).rows[0];
  if (!customer) throw new Problem(422, 'INVALID_REFERENCE', '客户不存在或不属于当前企业');
  const followType = oneOf(body.follow_type, followTypes, '跟单类型');
  const contactId = idText(body.contact_id, '联系人', true)!;
  const contact = (await sql.query<{ id: string; name: string; phone: string }>('SELECT id,name,phone FROM money_contacts WHERE id=$1 AND customer_id=$2', [contactId, customerId])).rows[0];
  if (!contact) throw new Problem(422, 'INVALID_REFERENCE', '联系人不属于所选客户');
  const content = text(body.content, 255, '跟单内容', true);
  const nextIso = timeText(body.next_at, '下次跟单时间', true)!;
  const nextAt = new Date(nextIso);
  return { customerId, followType, contact, content, nextAt };
}

export function registerCrmFollow(app: FastifyInstance, services: Services) {
  const read = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => guarded(services, request, 'sales.read', false, work);
  const write = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => guarded(services, request, 'sales.write', true, work);

  app.get('/api/customer-follows', (request) => read(request, async (sql, actor) => {
    await syncFollowReminders(sql, actor);
    const query = (request.query ?? {}) as Row;
    const { size, offset, page } = pageOf(query);
    const where: string[] = ['true'];
    const params: unknown[] = [];
    const add = (clause: (n: string) => string, value: unknown) => { if (value === null || value === undefined || value === '') return; params.push(value); where.push(clause(`$${params.length}`)); };
    const keyword = like(query.keyword);
    add((n) => `(f.contact_name ILIKE ${n} OR f.contact_phone ILIKE ${n} OR f.content ILIKE ${n} OR c.name ILIKE ${n} OR coalesce(m.display_name,'') ILIKE ${n})`, keyword);
    add((n) => `f.customer_id=${n}::uuid`, idText(query.customer_id, '客户'));
    if (query.follow_type) add((n) => `f.follow_type=${n}`, oneOf(query.follow_type, followTypes, '跟单类型'));
    add((n) => `f.follower_id=${n}::uuid`, idText(query.follower_id, '跟单人'));
    add((n) => `f.followed_at>=${n}::timestamptz`, timeText(query.followed_from, '跟单时间起'));
    add((n) => `f.followed_at<=${n}::timestamptz`, timeText(query.followed_to, '跟单时间止'));
    add((n) => `f.next_at>=${n}::timestamptz`, timeText(query.next_from, '下次跟单时间起'));
    add((n) => `f.next_at<=${n}::timestamptz`, timeText(query.next_to, '下次跟单时间止'));
    const from = `FROM customer_follows f JOIN customers c ON c.tenant_id=f.tenant_id AND c.id=f.customer_id LEFT JOIN tenant_team_members m ON m.id=f.follower_id WHERE ${where.join(' AND ')}`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, params)).rows[0]!.n);
    const rows = (await sql.query<Row>(`SELECT f.id,f.customer_id,c.name AS customer_name,f.contact_id,f.contact_name,f.contact_phone,f.follow_type,f.content,
      f.next_at,${shanghaiTime('f.next_at')} AS next_text,${shanghaiTime('f.followed_at')} AS followed_text,f.follower_id,coalesce(m.display_name,'-') AS follower_name,f.reminded,f.version
      ${from} ORDER BY f.followed_at DESC,f.id LIMIT ${size} OFFSET ${offset}`, params)).rows;
    return {
      total, page, page_size: size,
      items: rows.map((row) => ({ ...row, contact_name: row.contact_name || '-', contact_phone: row.contact_phone || '-', remind_text: remindText(new Date(String(row.next_at))), reminded_text: row.reminded ? '已提醒' : '未提醒' })),
    };
  }));

  app.get('/api/customer-follows/contacts', (request) => read(request, async (sql) => {
    const customerId = idText((request.query as Row).customer_id, '客户', true);
    return { items: (await sql.query('SELECT id,name,phone FROM money_contacts WHERE customer_id=$1 ORDER BY name', [customerId])).rows };
  }));

  app.get('/api/customer-follows/remind-preview', (request) => read(request, async () => {
    const nextIso = timeText((request.query as Row).next_at, '下次跟单时间', true)!;
    return { remind_text: remindText(new Date(nextIso)) };
  }));

  app.post('/api/customer-follows', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const input = await followInput(sql, (request.body ?? {}) as Row);
    const remindAt = new Date(input.nextAt.getTime() - 3600_000);
    const row = (await sql.query<{ id: string }>(`INSERT INTO customer_follows(tenant_id,customer_id,contact_id,contact_name,contact_phone,follow_type,content,next_at,remind_at,follower_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`, [actor.tenant_id, input.customerId, input.contact.id, input.contact.name, input.contact.phone, input.followType, input.content, input.nextAt.toISOString(), remindAt.toISOString(), actor.user_id])).rows[0]!;
    return { id: row.id, remind_text: remindText(input.nextAt) };
  })));

  app.put<{ Params: { id: string } }>('/api/customer-follows/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '客户跟单', true);
    const body = (request.body ?? {}) as Row;
    const before = (await sql.query<{ version: number; next_at: string }>('SELECT version,next_at FROM customer_follows WHERE id=$1 FOR UPDATE', [id])).rows[0];
    requireVersion(before, body.version, '客户跟单');
    const input = await followInput(sql, body);
    const remindAt = new Date(input.nextAt.getTime() - 3600_000);
    const rescheduled = new Date(String(before!.next_at)).getTime() !== input.nextAt.getTime();
    await sql.query(`UPDATE customer_follows SET customer_id=$1,contact_id=$2,contact_name=$3,contact_phone=$4,follow_type=$5,content=$6,next_at=$7,remind_at=$8,
      reminded=CASE WHEN $9 THEN false ELSE reminded END,version=version+1,updated_at=now() WHERE id=$10`,
    [input.customerId, input.contact.id, input.contact.name, input.contact.phone, input.followType, input.content, input.nextAt.toISOString(), remindAt.toISOString(), rescheduled, id]);
    return { ok: true, remind_text: remindText(input.nextAt) };
  }));

  app.delete<{ Params: { id: string } }>('/api/customer-follows/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '客户跟单', true);
    if (!(await sql.query('DELETE FROM customer_follows WHERE id=$1 RETURNING id', [id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '客户跟单不存在');
    return { ok: true };
  }));
}
