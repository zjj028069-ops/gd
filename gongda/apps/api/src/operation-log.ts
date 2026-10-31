import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pinyin } from 'pinyin-pro';
import type { Services } from './services.js';

const notes = new WeakMap<FastifyRequest, string>();
export function noteOp(request: FastifyRequest, content: string) { notes.set(request, content); }

function matchesName(name: string, query: string) {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  if (name.toLowerCase().includes(text)) return true;
  const initials = pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' }).join('');
  const full = pinyin(name, { toneType: 'none', type: 'array' }).join('');
  return initials.includes(text) || full.includes(text);
}

function template(method: string, path: string) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return '';
  if (path.startsWith('/api/auth/')) return '';
  if (path.includes('/customers') && method === 'POST') return '新增客户';
  if (path.includes('/customers') && method === 'PATCH') return '修改客户';
  if (path.includes('/customers') && method === 'DELETE') return '删除客户';
  if (path.includes('/audit/flows') && method === 'POST' && path.endsWith('/copy')) return '复制审核流程';
  if (path.includes('/audit/flows') && method === 'POST') return '新增审核流程';
  if (path.includes('/audit/flows') && method === 'PATCH') return '修改审核流程';
  if (path.includes('/audit/flows') && method === 'DELETE') return '删除审核流程';
  if (path.includes('/system/roles') && method === 'POST') return '新增角色';
  if (path.includes('/system/roles') && method === 'PATCH') return '修改角色';
  if (path.includes('/system/users') && method === 'POST') return '新增用户';
  if (path.includes('/system/users') && method === 'PATCH') return '修改用户';
  return '';
}

export function registerOperationLog(app: FastifyInstance, services: Services) {
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    if (reply.statusCode >= 400) return;
    const path = request.url.split('?')[0] ?? '';
    const content = notes.get(request) || template(request.method, path);
    if (!content) return;
    let actor;
    try { actor = services.actor(request); } catch { return; }
    if (!actor?.tenant_id) return;
    const verb = content.startsWith('新增') ? '新增' : content.startsWith('修改') ? '修改' : content.startsWith('删除') ? '删除' : content.includes('撤回') ? '撤回' : content.includes('审核') ? '审核' : request.method === 'DELETE' ? '删除' : request.method === 'POST' ? '新增' : '修改';
    try {
      await services.database.tenant({ tenantId: actor.tenant_id, userId: actor.user_id }, (sql) => sql.query(
        'INSERT INTO kgd_operation_logs(tenant_id,action,content,client_name,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,$6)',
        [actor.tenant_id, verb, content, '企业web端', actor.user_id, actor.display_name],
      ));
    } catch { /* 日志失败不影响业务 */ }
  });
}

export async function searchOperationLogs(services: Services, request: FastifyRequest) {
  const query = request.query as { q?: string; actor?: string };
  const actor = services.actor(request);
  return services.database.tenant(services.context(request), async (sql) => {
    const rows = (await sql.query<{ id: string; action: string; content: string; client_name: string; actor_name: string; created_at: string }>(
      'SELECT id,action,content,client_name,actor_name,created_at FROM kgd_operation_logs ORDER BY created_at DESC LIMIT 500',
    )).rows;
    const actorQuery = String(query.actor ?? query.q ?? '');
    const items = rows.filter((row) => matchesName(row.actor_name, actorQuery) && (query.q ? row.content.includes(String(query.q)) || matchesName(row.actor_name, String(query.q)) : true));
    return { items, actor: actor.display_name };
  });
}
