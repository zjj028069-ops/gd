import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { MAX_ATTACHMENT_BYTES } from './assets.js';
import { assertPoint } from './kgd-permissions.js';
import { Problem, type Actor, type Services } from './services.js';
import { bool, idList, idText, intIn, like, member, pageOf, pushMessage, requireVersion, shanghaiTime, text, textList, type Row } from './r10-kit.js';

const fileMimes = ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'];

function canManage(actor: Actor) {
  try { assertPoint(actor, 'system.setting'); return true; } catch { return false; }
}
function requireManage(actor: Actor) {
  if (!canManage(actor)) throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
}

function html(value: unknown, label: string) {
  const raw = typeof value === 'string' ? value : '';
  if (raw.length > 200000) throw new Problem(422, 'TOO_LONG', `${label}内容过长`);
  return raw.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '');
}

export async function attachmentsOf(sql: Sql, ids: unknown) {
  const list = Array.isArray(ids) ? ids.map(String) : [];
  if (!list.length) return [];
  const rows = (await sql.query<{ id: string; filename: string; mime: string; byte_size: number }>('SELECT id,filename,mime,byte_size FROM attachments WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [list])).rows;
  return list.map((id) => rows.find((row) => row.id === id)).filter(Boolean);
}

export async function checkAttachments(sql: Sql, value: unknown, max = 9) {
  const ids = idList(value, '附件', max);
  if (!ids.length) return ids;
  const found = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM attachments WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [ids])).rows[0]!.n);
  if (found !== ids.length) throw new Problem(422, 'INVALID_REFERENCE', '附件不存在或已删除');
  return ids;
}

async function ensureDefaultCategory(sql: Sql, tenantId: string) {
  await sql.query("INSERT INTO knowledge_categories(tenant_id,name,sort_no,is_default) SELECT $1,'默认',1,true WHERE NOT EXISTS (SELECT 1 FROM knowledge_categories WHERE is_default)", [tenantId]);
}

async function visibleNoticeClause(sql: Sql, actor: Actor, start: number) {
  if (actor.role === 'admin') return { clause: 'true', params: [] as unknown[] };
  const dept = (await sql.query<{ department_id: string | null }>('SELECT department_id FROM tenant_member_profiles WHERE user_id=$1', [actor.user_id])).rows[0]?.department_id ?? null;
  const ancestors = dept ? (await sql.query<{ id: string }>(`WITH RECURSIVE up AS (SELECT id,parent_id FROM departments WHERE id=$1 UNION ALL SELECT d.id,d.parent_id FROM departments d JOIN up ON d.id=up.parent_id) SELECT id FROM up`, [dept])).rows.map((row) => row.id) : [];
  return {
    clause: `(n.published_by=$${start} OR $${start} = ANY(n.user_ids) OR n.department_ids && $${start + 1}::uuid[] OR (cardinality(n.user_ids)=0 AND cardinality(n.department_ids)=0))`,
    params: [actor.user_id, ancestors] as unknown[],
  };
}

async function noticeRecipients(sql: Sql, departmentIds: string[], userIds: string[]) {
  const fromDepartments = departmentIds.length ? (await sql.query<{ user_id: string }>(`WITH RECURSIVE down AS (SELECT id FROM departments WHERE id = ANY($1::uuid[]) UNION ALL SELECT d.id FROM departments d JOIN down ON d.parent_id=down.id)
    SELECT p.user_id FROM tenant_member_profiles p JOIN tenant_team_members m ON m.id=p.user_id WHERE p.department_id IN (SELECT id FROM down)`, [departmentIds])).rows.map((row) => row.user_id) : [];
  const direct = userIds.length ? (await sql.query<{ id: string }>('SELECT id FROM tenant_team_members WHERE id = ANY($1::uuid[])', [userIds])).rows.map((row) => row.id) : [];
  return [...new Set([...fromDepartments, ...direct])];
}

export async function latestNotices(sql: Sql, actor: Actor, limit = 5) {
  const scope = await visibleNoticeClause(sql, actor, 2);
  return (await sql.query(`SELECT n.id,n.title,${shanghaiTime('n.published_at')} AS published_text,EXISTS(SELECT 1 FROM notice_reads r WHERE r.notice_id=n.id AND r.user_id=$1) AS read
    FROM notices n WHERE ${scope.clause} ORDER BY n.published_at DESC LIMIT ${Math.max(1, Math.min(limit, 50))}`, [actor.user_id, ...scope.params])).rows;
}

export function registerInfoCenter(app: FastifyInstance, services: Services) {
  const read = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => member(services, request, false, work);
  const write = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => member(services, request, true, async (sql, actor) => { requireManage(actor); return work(sql, actor); });

  app.post('/api/info/files', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => reply.code(201).send(await member(services, request, true, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const filename = text(body.filename, 200, '文件名', true);
    if (/[\\/\u0000-\u001f]/.test(filename)) throw new Problem(422, 'FILENAME', '文件名不能包含路径或控制字符');
    const mime = String(body.mime ?? '');
    if (!fileMimes.includes(mime)) throw new Problem(422, 'MIME', '附件只支持 PNG、JPG、PDF、TXT');
    const content = String(body.content_base64 ?? '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Problem(422, 'CONTENT', '附件内容格式不正确');
    const bytes = Buffer.from(content, 'base64');
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Problem(422, 'FILE_SIZE', '单个附件不能超过2MB');
    const limits = (await sql.query<{ storage_used_bytes: string; storage_limit_bytes: string }>('SELECT storage_used_bytes::text,storage_limit_bytes::text FROM tenant_service_limits WHERE tenant_id=$1 FOR UPDATE', [actor.tenant_id])).rows[0];
    if (limits && BigInt(limits.storage_used_bytes) + BigInt(bytes.length) > BigInt(limits.storage_limit_bytes)) throw new Problem(409, 'STORAGE_QUOTA_EXCEEDED', '附件存储量已达本企业服务配额');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const row = (await sql.query<{ id: string }>('INSERT INTO attachments(tenant_id,filename,mime,byte_size,sha256,payload,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [actor.tenant_id, filename, mime, bytes.length, sha256, bytes, randomUUID()])).rows[0]!;
    await sql.query('UPDATE tenant_service_limits SET storage_used_bytes=storage_used_bytes+$1,updated_at=now() WHERE tenant_id=$2', [bytes.length, actor.tenant_id]);
    return { file: { id: row.id, filename, mime, byte_size: bytes.length } };
  })));
  app.get<{ Params: { id: string } }>('/api/info/files/:id/content', async (request, reply) => {
    const file = await read(request, async (sql) => {
      const row = (await sql.query<{ filename: string; mime: string; payload: Uint8Array }>('SELECT filename,mime,payload FROM attachments WHERE id=$1 AND product_id IS NULL AND process_id IS NULL AND active AND deleted_at IS NULL', [idText(request.params.id, '附件', true)])).rows[0];
      if (!row) throw new Problem(404, 'NOT_FOUND', '附件不存在或已删除');
      return row;
    });
    reply.header('Content-Type', file.mime).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`).header('X-Content-Type-Options', 'nosniff');
    return reply.send(Buffer.from(file.payload));
  });

  app.get('/api/knowledge/categories', (request) => read(request, async (sql, actor) => {
    await ensureDefaultCategory(sql, actor.tenant_id);
    const items = (await sql.query<Row>('SELECT c.id,c.name,c.sort_no,c.is_default,(SELECT count(*)::int FROM knowledge_articles a WHERE a.category_id=c.id) AS article_count FROM knowledge_categories c ORDER BY c.is_default DESC,c.sort_no,c.name')).rows;
    const total = items.reduce((sum, row) => sum + Number(row.article_count), 0);
    return { items, total, can_manage: canManage(actor) };
  }));
  app.post('/api/knowledge/categories', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const name = text(((request.body ?? {}) as Row).name, 40, '分类名称', true);
    const next = Number((await sql.query<{ n: string }>('SELECT coalesce(max(sort_no),0)+1 AS n FROM knowledge_categories')).rows[0]!.n);
    const row = (await sql.query<{ id: string }>('INSERT INTO knowledge_categories(tenant_id,name,sort_no) VALUES($1,$2,$3) ON CONFLICT (tenant_id,name) DO NOTHING RETURNING id', [actor.tenant_id, name, next])).rows[0];
    if (!row) throw new Problem(409, 'DUPLICATE', '分类名称已存在');
    return { id: row.id };
  })));
  app.put<{ Params: { id: string } }>('/api/knowledge/categories/:id', (request) => write(request, async (sql) => {
    const body = (request.body ?? {}) as Row;
    const id = idText(request.params.id, '分类', true);
    const before = (await sql.query<{ is_default: boolean; name: string; sort_no: number }>('SELECT is_default,name,sort_no FROM knowledge_categories WHERE id=$1', [id])).rows[0];
    if (!before) throw new Problem(404, 'NOT_FOUND', '分类不存在');
    const name = body.name === undefined ? before.name : text(body.name, 40, '分类名称', true);
    if (before.is_default && name !== before.name) throw new Problem(409, 'DEFAULT_CATEGORY', '默认分类不能改名');
    if ((await sql.query('SELECT 1 FROM knowledge_categories WHERE name=$1 AND id<>$2', [name, id])).rows[0]) throw new Problem(409, 'DUPLICATE', '分类名称已存在');
    await sql.query('UPDATE knowledge_categories SET name=$1,sort_no=$2 WHERE id=$3', [name, intIn(body.sort_no, 0, 9999, '排序', before.sort_no), id]);
    return { ok: true };
  }));
  app.post('/api/knowledge/categories/reorder', (request) => write(request, async (sql) => {
    const ids = idList(((request.body ?? {}) as Row).ids, '分类', 200);
    for (const [index, id] of ids.entries()) await sql.query('UPDATE knowledge_categories SET sort_no=$1 WHERE id=$2', [index + 1, id]);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/knowledge/categories/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '分类', true);
    const row = (await sql.query<{ is_default: boolean }>('SELECT is_default FROM knowledge_categories WHERE id=$1', [id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '分类不存在');
    if (row.is_default) throw new Problem(409, 'DEFAULT_CATEGORY', '默认分类不能删除');
    await sql.query('UPDATE knowledge_articles SET category_id=(SELECT id FROM knowledge_categories WHERE is_default),updated_at=now() WHERE category_id=$1', [id]);
    await sql.query('DELETE FROM knowledge_categories WHERE id=$1', [id]);
    return { ok: true };
  }));

  app.get('/api/knowledge/articles', (request) => read(request, async (sql, actor) => {
    await ensureDefaultCategory(sql, actor.tenant_id);
    const query = (request.query ?? {}) as Row;
    const { size, offset, page } = pageOf(query, 10);
    const params: unknown[] = [];
    const where = ['true'];
    const add = (clause: (n: string) => string, value: unknown) => { if (value === null || value === undefined || value === '') return; params.push(value); where.push(clause(`$${params.length}`)); };
    add((n) => `a.category_id=${n}::uuid`, idText(query.category_id, '分类'));
    add((n) => `(a.title ILIKE ${n} OR array_to_string(a.tags,',') ILIKE ${n})`, like(query.keyword));
    if (query.is_public === '公开' || query.is_public === 'true') where.push('a.is_public');
    if (query.is_public === '不公开' || query.is_public === 'false') where.push('NOT a.is_public');
    const from = `FROM knowledge_articles a JOIN knowledge_categories c ON c.tenant_id=a.tenant_id AND c.id=a.category_id LEFT JOIN tenant_team_members m ON m.id=a.created_by WHERE ${where.join(' AND ')}`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, params)).rows[0]!.n);
    const items = (await sql.query<Row>(`SELECT a.id,a.title,a.category_id,c.name AS category_name,a.tags,a.is_public,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('a.created_at')} AS created_text,a.version
      ${from} ORDER BY a.created_at DESC,a.id LIMIT ${size} OFFSET ${offset}`, params)).rows.map((row) => ({ ...row, public_text: row.is_public ? '公开' : '不公开' }));
    return { total, page, page_size: size, items, summary: `符合查询结果的共${total}条` };
  }));
  app.get<{ Params: { id: string } }>('/api/knowledge/articles/:id', (request) => read(request, async (sql) => {
    const row = (await sql.query<Row>(`SELECT a.*,c.name AS category_name,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('a.created_at')} AS created_text,${shanghaiTime('a.updated_at')} AS updated_text
      FROM knowledge_articles a JOIN knowledge_categories c ON c.tenant_id=a.tenant_id AND c.id=a.category_id LEFT JOIN tenant_team_members m ON m.id=a.created_by WHERE a.id=$1`, [idText(request.params.id, '知识', true)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '知识不存在');
    return { article: { ...row, public_text: row.is_public ? '公开' : '不公开', attachments: await attachmentsOf(sql, row.attachment_ids) } };
  }));
  const articleInput = async (sql: Sql, body: Row) => {
    const categoryId = idText(body.category_id, '分类', true);
    if (!(await sql.query('SELECT 1 FROM knowledge_categories WHERE id=$1', [categoryId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '分类不存在');
    return [text(body.title, 100, '标题', true), categoryId, textList(body.tags, '标签', 20, 20), bool(body.is_public, false), html(body.body_html, '正文'), await checkAttachments(sql, body.attachment_ids, 20)] as const;
  };
  app.post('/api/knowledge/articles', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const input = await articleInput(sql, (request.body ?? {}) as Row);
    const row = (await sql.query<{ id: string }>('INSERT INTO knowledge_articles(tenant_id,title,category_id,tags,is_public,body_html,attachment_ids,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [actor.tenant_id, ...input, actor.user_id])).rows[0]!;
    return { id: row.id };
  })));
  app.put<{ Params: { id: string } }>('/api/knowledge/articles/:id', (request) => write(request, async (sql) => {
    const body = (request.body ?? {}) as Row;
    const id = idText(request.params.id, '知识', true);
    requireVersion((await sql.query<{ version: number }>('SELECT version FROM knowledge_articles WHERE id=$1 FOR UPDATE', [id])).rows[0], body.version, '知识');
    const input = await articleInput(sql, body);
    await sql.query('UPDATE knowledge_articles SET title=$1,category_id=$2,tags=$3,is_public=$4,body_html=$5,attachment_ids=$6,version=version+1,updated_at=now() WHERE id=$7', [...input, id]);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/knowledge/articles/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM knowledge_articles WHERE id=$1 RETURNING id', [idText(request.params.id, '知识', true)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '知识不存在');
    return { ok: true };
  }));

  app.get('/api/notices/scope-options', (request) => read(request, async (sql) => ({
    departments: (await sql.query('SELECT id,name,parent_id FROM departments WHERE active ORDER BY name')).rows,
    members: (await sql.query('SELECT m.id,m.display_name,p.department_id FROM tenant_team_members m LEFT JOIN tenant_member_profiles p ON p.user_id=m.id ORDER BY m.display_name')).rows,
  })));
  app.get('/api/notices', (request) => read(request, async (sql, actor) => {
    const query = (request.query ?? {}) as Row;
    const { size, offset, page } = pageOf(query, 10);
    const scope = await visibleNoticeClause(sql, actor, 2);
    const params: unknown[] = [actor.user_id, ...scope.params];
    const where = [scope.clause];
    const tab = String(query.tab ?? 'all');
    if (tab === 'read' || tab === '已读') where.push('r.read_at IS NOT NULL');
    if (tab === 'unread' || tab === '未读') where.push('r.read_at IS NULL');
    const keyword = like(query.keyword);
    if (keyword) { params.push(keyword); where.push(`n.title ILIKE $${params.length}`); }
    const from = `FROM notices n LEFT JOIN notice_reads r ON r.tenant_id=n.tenant_id AND r.notice_id=n.id AND r.user_id=$1 LEFT JOIN tenant_team_members m ON m.id=n.published_by WHERE ${where.join(' AND ')}`;
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, params)).rows[0]!.n);
    const items = (await sql.query<Row>(`SELECT n.id,n.title,coalesce(m.display_name,'-') AS publisher_name,${shanghaiTime('n.published_at')} AS published_text,r.read_at IS NOT NULL AS read
      ${from} ORDER BY n.published_at DESC,n.id LIMIT ${size} OFFSET ${offset}`, params)).rows.map((row) => ({ ...row, read_text: row.read ? '已读' : '未读' }));
    return { total, page, page_size: size, items, summary: `符合查询结果的共${total}条`, can_manage: canManage(actor) };
  }));
  app.get('/api/notices/latest', (request) => read(request, async (sql, actor) => ({ items: await latestNotices(sql, actor, Number((request.query as Row).limit ?? 5) || 5) })));
  app.get<{ Params: { id: string } }>('/api/notices/:id', (request) => member(services, request, false, async (sql, actor) => {
    const id = idText(request.params.id, '通知公告', true);
    const scope = await visibleNoticeClause(sql, actor, 2);
    const row = (await sql.query<Row>(`SELECT n.*,coalesce(m.display_name,'-') AS publisher_name,${shanghaiTime('n.published_at')} AS published_text
      FROM notices n LEFT JOIN tenant_team_members m ON m.id=n.published_by WHERE n.id=$1 AND ${scope.clause}`, [id, ...scope.params])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '通知公告不存在或不在您的通知范围内');
    await sql.query('INSERT INTO notice_reads(tenant_id,notice_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [actor.tenant_id, id, actor.user_id]);
    await sql.query("UPDATE kgd_messages SET read_at=coalesce(read_at,now()) WHERE user_id=$1 AND object_type='notice' AND object_id=$2", [actor.user_id, id]);
    const departments = (await sql.query<{ name: string }>('SELECT name FROM departments WHERE id = ANY($1::uuid[]) ORDER BY name', [row.department_ids])).rows.map((item) => item.name);
    const users = (await sql.query<{ display_name: string }>('SELECT display_name FROM tenant_team_members WHERE id = ANY($1::uuid[]) ORDER BY display_name', [row.user_ids])).rows.map((item) => item.display_name);
    return { notice: { ...row, scope_text: [...departments, ...users].join('、') || '全部成员', attachments: await attachmentsOf(sql, row.attachment_ids) } };
  }));
  app.post('/api/notices', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const title = text(body.title, 100, '标题', true);
    const departmentIds = idList(body.department_ids, '通知部门', 200);
    const userIds = idList(body.user_ids, '通知人员', 1000);
    if (!departmentIds.length && !userIds.length) throw new Problem(422, 'REQUIRED', '请选择通知范围');
    const recipients = await noticeRecipients(sql, departmentIds, userIds);
    if (!recipients.length) throw new Problem(422, 'EMPTY_SCOPE', '通知范围内没有成员');
    const id = (await sql.query<{ id: string }>('INSERT INTO notices(tenant_id,title,department_ids,user_ids,body_html,attachment_ids,published_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [actor.tenant_id, title, departmentIds, userIds, html(body.body_html, '正文'), await checkAttachments(sql, body.attachment_ids, 20), actor.user_id])).rows[0]!.id;
    for (const userId of recipients) {
      await pushMessage(sql, actor.tenant_id, userId, { kind: 'bulletin', title: '通知公告', body: title, objectType: 'notice', objectId: id, linkPath: `/notice/detail/${id}`, dedupeKey: `notice:${id}:${userId}` });
    }
    return { id, recipients: recipients.length };
  })));
  app.delete<{ Params: { id: string } }>('/api/notices/:id', (request) => write(request, async (sql) => {
    const id = idText(request.params.id, '通知公告', true);
    if (!(await sql.query('DELETE FROM notices WHERE id=$1 RETURNING id', [id])).rows[0]) throw new Problem(404, 'NOT_FOUND', '通知公告不存在');
    await sql.query("DELETE FROM kgd_messages WHERE object_type='notice' AND object_id=$1", [id]);
    return { ok: true };
  }));
}
