import type { FastifyInstance } from 'fastify';
import { Problem, type Services } from './services.js';
import { bodyOf, clean, withTenant } from './round8-kit.js';

const DEFAULT_CATS = [
  { key: 'all', name: '全部' },
  { key: 'bulletin', name: '通知公告' },
  { key: 'follow', name: '客户跟单' },
  { key: 'maint_plan', name: '维保计划' },
  { key: 'repair', name: '维修工单' },
  { key: 'contract', name: '合同订单' },
  { key: 'produce', name: '生产消息' },
  { key: 'warehouse', name: '仓库消息' },
  { key: 'service', name: '服务工单' },
  { key: 'feedback', name: '客户反馈' },
  { key: 'oa', name: '办公OA' },
];

export function registerRound11Messages(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'configuration.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'configuration.read', work);

  app.get('/api/messages/center', (request) => read(request, async (sql, actor) => {
    const q = request.query as { category?: string; kind?: string; read?: string; from?: string; to?: string };
    const sorts = (await sql.query<{ category_key: string; sort_no: number }>('SELECT category_key,sort_no FROM kgd_message_category_sorts WHERE user_id=$1', [actor.user_id])).rows;
    const order = new Map(sorts.map((row) => [row.category_key, row.sort_no]));
    const categories = [...DEFAULT_CATS].sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999) || DEFAULT_CATS.findIndex((c) => c.key === a.key) - DEFAULT_CATS.findIndex((c) => c.key === b.key));
    const unreadRows = (await sql.query<{ category_key: string; n: string }>("SELECT coalesce(nullif(category_key,''),kind) AS category_key, count(*)::text AS n FROM kgd_messages WHERE user_id=$1 AND read_at IS NULL AND created_at > now() - interval '3 months' GROUP BY 1", [actor.user_id])).rows;
    const unreadMap = Object.fromEntries(unreadRows.map((row) => [row.category_key, Number(row.n)]));
    const cats = categories.map((cat) => ({ ...cat, unread: cat.key === 'all' ? unreadRows.reduce((s, r) => s + Number(r.n), 0) : (unreadMap[cat.key] ?? 0) }));
    let sqlText = `SELECT id,kind,category_key,title,body,link_path,read_at,created_at FROM kgd_messages WHERE user_id=$1 AND created_at > now() - interval '3 months'`;
    const params: unknown[] = [actor.user_id];
    if (q.category && q.category !== 'all') { params.push(q.category); sqlText += ` AND (category_key=$${params.length} OR kind=$${params.length})`; }
    if (q.kind && q.kind !== 'all') { params.push(q.kind); sqlText += ` AND kind=$${params.length}`; }
    if (q.read === 'unread') sqlText += ' AND read_at IS NULL';
    if (q.read === 'read') sqlText += ' AND read_at IS NOT NULL';
    if (q.from) { params.push(q.from); sqlText += ` AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $${params.length}::date`; }
    if (q.to) { params.push(q.to); sqlText += ` AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $${params.length}::date`; }
    sqlText += ' ORDER BY created_at DESC LIMIT 200';
    const items = (await sql.query(sqlText, params)).rows.map((row) => ({
      ...row,
      kind_text: ({ alarm: '报警', todo: '待办', notice: '通知', follow: '客户跟单', bulletin: '通知公告' } as Record<string, string>)[String(row.kind)] ?? String(row.kind),
      read_text: row.read_at ? '已读' : '未读',
      created_text: String(row.created_at).replace('T', ' ').slice(0, 19),
    }));
    return { categories: cats, items, unread: cats.find((c) => c.key === 'all')?.unread ?? 0 };
  }));

  app.put('/api/messages/category-sort', (request) => write(request, async (sql, actor) => {
    const keys = Array.isArray(bodyOf(request).keys) ? (bodyOf(request).keys as string[]) : [];
    if (!keys.length) throw new Problem(422, 'KEYS', '请调整排序');
    await sql.query('DELETE FROM kgd_message_category_sorts WHERE user_id=$1', [actor.user_id]);
    let i = 1;
    for (const key of keys) {
      await sql.query('INSERT INTO kgd_message_category_sorts(tenant_id,user_id,category_key,sort_no) VALUES($1,$2,$3,$4)', [actor.tenant_id, actor.user_id, clean(key, 40, '分类'), i++]);
    }
    return { ok: true };
  }));

  app.post('/api/system/messages/read-all', (request) => write(request, async (sql, actor) => {
    await sql.query('UPDATE kgd_messages SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND read_at IS NULL', [actor.user_id]);
    return { ok: true };
  }));

  app.post('/api/system/messages/clear', (request) => write(request, async (sql, actor) => {
    await sql.query('DELETE FROM kgd_messages WHERE user_id=$1', [actor.user_id]);
    return { ok: true };
  }));
}
