import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { assertPoint } from './kgd-permissions.js';
import { Problem, type Actor, type Services } from './services.js';
import { attachmentsOf, checkAttachments } from './info-center.js';
import { idText, intIn, like, member, pageOf, requireVersion, shanghaiTime, text, type Row } from './r10-kit.js';

const welcome = '嘿！这里是您的专属智能助手，我会根据训练中心录入的问答集为您解答问题，有什么可以帮您？';
const notFound = '暂未找到相关答案，请到问答集中补充';
const intro = [
  '训练中心用于给AI智能体录入企业自己的知识。',
  '文档集：上传 Pdf、Doc、Docx 文档，作为企业资料留存。',
  '问答集：录入常见问题和标准答案，对话时会按关键词匹配最相近的一条答案，并标出来源。',
];

function tokens(value: string) {
  const normalized = value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  const set = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) set.add(word);
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) set.add(run);
    for (let i = 0; i < run.length - 1; i += 1) set.add(run.slice(i, i + 2));
  }
  return set;
}

/** 按关键词（中文双字切分 + 英文数字词）给问答集打分，取覆盖率最高的一条。 */
export function bestAnswer(question: string, pairs: { id: string; question: string; answer: string }[]) {
  const asked = tokens(question);
  if (!asked.size) return null;
  let best: { id: string; question: string; answer: string; score: number } | null = null;
  for (const pair of pairs) {
    const known = tokens(pair.question);
    if (!known.size) continue;
    let hit = 0;
    for (const token of asked) if (known.has(token)) hit += 1;
    const exact = pair.question.replace(/\s+/g, '') === question.replace(/\s+/g, '') ? 1 : 0;
    const score = exact || (2 * hit) / (asked.size + known.size);
    if (!best || score > best.score) best = { ...pair, score };
  }
  return best && best.score >= 0.34 ? best : null;
}

export function registerAiTrain(app: FastifyInstance, services: Services) {
  const read = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => member(services, request, false, work);
  const manage = <T>(request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<T>) => member(services, request, true, async (sql, actor) => { assertPoint(actor, 'system.setting'); return work(sql, actor); });

  app.get('/api/ai-train/intro', (request) => read(request, async () => ({ welcome, intro, empty_documents: '您还没有录入文档，快去录入吧！' })));

  app.get('/api/ai-train/documents', (request) => read(request, async (sql) => {
    const { size, offset, page } = pageOf((request.query ?? {}) as Row);
    const total = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM ai_documents')).rows[0]!.n);
    const items = (await sql.query<Row>(`SELECT d.id,d.filename,d.byte_size,d.attachment_id,coalesce(m.display_name,'-') AS uploader_name,${shanghaiTime('d.created_at')} AS created_text
      FROM ai_documents d LEFT JOIN tenant_team_members m ON m.id=d.uploaded_by ORDER BY d.created_at DESC,d.id LIMIT ${size} OFFSET ${offset}`)).rows
      .map((row) => ({ ...row, size_text: Number(row.byte_size) >= 1048576 ? `${(Number(row.byte_size) / 1048576).toFixed(2)}MB` : `${Math.max(1, Math.round(Number(row.byte_size) / 1024))}KB` }));
    return { total, page, page_size: size, items };
  }));
  app.post('/api/ai-train/documents', async (request, reply) => reply.code(201).send(await manage(request, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const filename = text(body.filename, 200, '文件名', true);
    if (!/\.(pdf|doc|docx)$/i.test(filename)) throw new Problem(422, 'FILE_TYPE', '只能上传 Pdf、Doc、Docx 文件');
    const attachmentId = idText(body.attachment_id, '文件');
    let byteSize = intIn(body.byte_size, 1, 20 * 1024 * 1024, '文件大小', 0);
    if (attachmentId) {
      const file = (await sql.query<{ byte_size: number }>('SELECT byte_size FROM attachments WHERE id=$1 AND deleted_at IS NULL', [attachmentId])).rows[0];
      if (!file) throw new Problem(422, 'INVALID_REFERENCE', '文件不存在或已删除');
      byteSize = file.byte_size;
    }
    if (!byteSize) throw new Problem(422, 'FILE_SIZE', '文件大小不能为0');
    const row = (await sql.query<{ id: string }>('INSERT INTO ai_documents(tenant_id,filename,byte_size,attachment_id,uploaded_by) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, filename, byteSize, attachmentId, actor.user_id])).rows[0]!;
    return { id: row.id };
  })));
  app.delete<{ Params: { id: string } }>('/api/ai-train/documents/:id', (request) => manage(request, async (sql) => {
    if (!(await sql.query('DELETE FROM ai_documents WHERE id=$1 RETURNING id', [idText(request.params.id, '文档', true)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '文档不存在');
    return { ok: true };
  }));

  app.get('/api/ai-train/qa', (request) => read(request, async (sql) => {
    const query = (request.query ?? {}) as Row;
    const { size, offset, page } = pageOf(query);
    const keyword = like(query.keyword);
    const params = keyword ? [keyword] : [];
    const where = keyword ? 'WHERE (q.question ILIKE $1 OR q.answer ILIKE $1)' : '';
    const total = Number((await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM ai_qa_pairs q ${where}`, params)).rows[0]!.n);
    const rows = (await sql.query<Row>(`SELECT q.id,q.question,q.answer,q.attachment_ids,q.version,coalesce(m.display_name,'-') AS creator_name,${shanghaiTime('q.created_at')} AS created_text
      FROM ai_qa_pairs q LEFT JOIN tenant_team_members m ON m.id=q.created_by ${where} ORDER BY q.created_at DESC,q.id LIMIT ${size} OFFSET ${offset}`, params)).rows;
    const items = [];
    for (const row of rows) items.push({ ...row, attachments: await attachmentsOf(sql, row.attachment_ids) });
    return { total, page, page_size: size, items };
  }));
  const qaInput = async (sql: Sql, body: Row) => [text(body.question, 300, '问题', true), text(body.answer, 3000, '答案', true), await checkAttachments(sql, body.attachment_ids, 9)] as const;
  app.post('/api/ai-train/qa', async (request, reply) => reply.code(201).send(await manage(request, async (sql, actor) => {
    const input = await qaInput(sql, (request.body ?? {}) as Row);
    return { id: (await sql.query<{ id: string }>('INSERT INTO ai_qa_pairs(tenant_id,question,answer,attachment_ids,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, ...input, actor.user_id])).rows[0]!.id };
  })));
  app.put<{ Params: { id: string } }>('/api/ai-train/qa/:id', (request) => manage(request, async (sql) => {
    const body = (request.body ?? {}) as Row;
    const id = idText(request.params.id, '问答', true);
    requireVersion((await sql.query<{ version: number }>('SELECT version FROM ai_qa_pairs WHERE id=$1 FOR UPDATE', [id])).rows[0], body.version, '问答');
    await sql.query('UPDATE ai_qa_pairs SET question=$1,answer=$2,attachment_ids=$3,version=version+1,updated_at=now() WHERE id=$4', [...await qaInput(sql, body), id]);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/ai-train/qa/:id', (request) => manage(request, async (sql) => {
    if (!(await sql.query('DELETE FROM ai_qa_pairs WHERE id=$1 RETURNING id', [idText(request.params.id, '问答', true)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '问答不存在');
    return { ok: true };
  }));

  app.post('/api/ai-train/chat/new', (request) => read(request, async () => ({ session_id: randomUUID(), welcome })));
  app.get('/api/ai-train/chat', (request) => read(request, async (sql, actor) => {
    const sessionId = idText((request.query as Row).session_id, '对话');
    if (!sessionId) return { session_id: null, welcome, items: [] };
    const items = (await sql.query(`SELECT c.id,c.role,c.content,c.source_qa_id,q.question AS source_question,${shanghaiTime('c.created_at')} AS created_text
      FROM ai_chats c LEFT JOIN ai_qa_pairs q ON q.tenant_id=c.tenant_id AND q.id=c.source_qa_id WHERE c.user_id=$1 AND c.session_id=$2 ORDER BY c.created_at,c.role DESC`, [actor.user_id, sessionId])).rows;
    return { session_id: sessionId, welcome, items };
  }));
  app.post('/api/ai-train/chat', (request) => member(services, request, true, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const sessionId = idText(body.session_id, '对话') ?? randomUUID();
    const question = text(body.question, 300, '问题', true);
    const pairs = (await sql.query<{ id: string; question: string; answer: string }>('SELECT id,question,answer FROM ai_qa_pairs ORDER BY created_at')).rows;
    const match = bestAnswer(question, pairs);
    await sql.query("INSERT INTO ai_chats(tenant_id,user_id,session_id,role,content) VALUES($1,$2,$3,'user',$4)", [actor.tenant_id, actor.user_id, sessionId, question]);
    const answer = match ? match.answer : notFound;
    await sql.query("INSERT INTO ai_chats(tenant_id,user_id,session_id,role,content,source_qa_id) VALUES($1,$2,$3,'assistant',$4,$5)", [actor.tenant_id, actor.user_id, sessionId, answer, match?.id ?? null]);
    return { session_id: sessionId, answer, matched: Boolean(match), source: match ? { id: match.id, question: match.question, label: `来源：问答集「${match.question}」` } : null };
  }));
}
