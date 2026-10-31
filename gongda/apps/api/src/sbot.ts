// Bot 模式（SEDRIC Bots 业务助手）转发接口。
// 浏览器只和这里通信；这里先用 MES 自己的登录校验，再带着网关密钥和当前用户身份
// 转发给只在本机监听的 SEDRIC Bots 网关（/mes-gw/*）。Bot 调用 MES 时用的是该用户
// 自己的会话，所以权限和传统界面完全一致。
// 注意：这里与现有的 AI 小助手（ai/*）完全独立，互不影响。
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from './services.js';
import { MAX_TEXT, registerSbotFiles } from './sbot-files.js';

type Options = { cookieName: string; csrf: (request: FastifyRequest) => string };

const idParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z0-9]{4,40}$' } } };

export function registerSbot(app: FastifyInstance, services: Services, options: Options) {
  const base = (process.env.SBOT_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
  const token = process.env.SBOT_GATEWAY_TOKEN ?? '';
  const guard = services.authorize();

  const headersFor = (request: FastifyRequest): Record<string, string> => {
    const actor = services.actor(request);
    const session = request.cookies[options.cookieName] ?? '';
    return {
      'x-sbot-gateway': token,
      'x-sbot-owner': `${actor.tenant_id}:${actor.user_id}`,
      'x-sbot-mes-cookie': `${options.cookieName}=${session}`,
      'x-sbot-mes-csrf': options.csrf(request),
      'x-sbot-user-name': encodeURIComponent(actor.display_name ?? ''),
      'x-sbot-user-role': actor.role,
    };
  };

  const forward = async (request: FastifyRequest, reply: FastifyReply, method: string, path: string, body?: unknown) => {
    if (!token) return reply.code(503).send({ error: { code: 'SBOT_DISABLED', message: 'Bot 模式还没有启用，请联系管理员' } });
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { ...headersFor(request), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return reply.code(502).send({ error: { code: 'SBOT_UNAVAILABLE', message: 'Bot 服务没有启动或无法连接' } });
    }
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : 'Bot 服务返回错误';
      return reply.code(res.status).send({ error: { code: 'SBOT_ERROR', message: detail } });
    }
    return reply.send(data);
  };

  app.get('/api/sbot/info', { preHandler: guard }, (r, reply) => forward(r, reply, 'GET', '/mes-gw/info'));
  app.get('/api/sbot/sessions', { preHandler: guard }, (r, reply) => forward(r, reply, 'GET', '/mes-gw/sessions'));
  app.post<{ Body: { mode?: 'chat' | 'demo' } }>('/api/sbot/sessions', {
    preHandler: guard,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['chat', 'demo'] } } }] } },
  }, (r, reply) => forward(r, reply, 'POST', '/mes-gw/sessions', { mode: r.body?.mode ?? 'chat' }));
  app.get<{ Params: { id: string } }>('/api/sbot/sessions/:id', { preHandler: guard, schema: { params: idParam } }, (r, reply) => forward(r, reply, 'GET', `/mes-gw/sessions/${r.params.id}`));
  app.delete<{ Params: { id: string } }>('/api/sbot/sessions/:id', { preHandler: guard, schema: { params: idParam } }, (r, reply) => forward(r, reply, 'DELETE', `/mes-gw/sessions/${r.params.id}`));
  registerSbotFiles(app, guard);
  const fileItem = { type: 'object', additionalProperties: false, required: ['name', 'text'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, text: { type: 'string', minLength: 1, maxLength: MAX_TEXT }, size: { type: 'integer', minimum: 0, maximum: 20 * 1024 * 1024 } } };
  app.post<{ Params: { id: string }; Body: { text: string; tab?: string; files?: { name: string; text: string; size?: number }[] } }>('/api/sbot/sessions/:id/messages', {
    preHandler: guard,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    // tab：发消息的浏览器标签页编号，代操作的界面动作只交给这个标签页执行
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 0, maxLength: 2000 }, tab: { type: 'string', pattern: '^[a-z0-9]{6,40}$' }, files: { type: 'array', maxItems: 3, items: fileItem } } } },
    bodyLimit: 1024 * 1024,
  }, (r, reply) => forward(r, reply, 'POST', `/mes-gw/sessions/${r.params.id}/messages`, { text: r.body.text, tab: r.body.tab, files: r.body.files ?? [] }));
  app.post<{ Params: { id: string } }>('/api/sbot/sessions/:id/interrupt', { preHandler: guard, schema: { params: idParam } }, (r, reply) => forward(r, reply, 'POST', `/mes-gw/sessions/${r.params.id}/interrupt`, {}));
  app.post<{ Params: { id: string }; Body: { approve?: boolean; answer?: string; result?: string } }>('/api/sbot/pending/:id', {
    preHandler: guard,
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    // result：代操作模式下，浏览器执行完界面动作后回传的页面清单
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, properties: { approve: { type: 'boolean' }, answer: { type: 'string', maxLength: 500 }, result: { type: 'string', maxLength: 12000 } } } },
  }, (r, reply) => forward(r, reply, 'POST', `/mes-gw/pending/${r.params.id}`, r.body ?? {}));

  // 企业经验库：本企业所有人可看；新增/修改/删除只有管理员（网关按当前用户角色判断）
  const memText = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 300 } } };
  const memId = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^mem[a-z0-9]{4,40}$' } } };
  app.get('/api/sbot/memory', { preHandler: guard }, (r, reply) => forward(r, reply, 'GET', '/mes-gw/memory'));
  app.post<{ Body: { text: string } }>('/api/sbot/memory', { preHandler: guard, schema: { body: memText } }, (r, reply) => forward(r, reply, 'POST', '/mes-gw/memory', { text: r.body.text }));
  app.put<{ Params: { id: string }; Body: { text: string } }>('/api/sbot/memory/:id', { preHandler: guard, schema: { params: memId, body: memText } }, (r, reply) => forward(r, reply, 'PUT', `/mes-gw/memory/${r.params.id}`, { text: r.body.text }));
  app.delete<{ Params: { id: string } }>('/api/sbot/memory/:id', { preHandler: guard, schema: { params: memId } }, (r, reply) => forward(r, reply, 'DELETE', `/mes-gw/memory/${r.params.id}`));

  // 实时事件流（SSE）。只会收到当前用户自己会话的事件，网关那边已过滤。
  app.get('/api/sbot/events', { preHandler: guard }, async (request, reply) => {
    if (!token) return reply.code(503).send({ error: { code: 'SBOT_DISABLED', message: 'Bot 模式还没有启用' } });
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    let res: Response;
    try {
      res = await fetch(base + '/mes-gw/events', { headers: headersFor(request), signal: controller.signal });
    } catch {
      return reply.code(502).send({ error: { code: 'SBOT_UNAVAILABLE', message: 'Bot 服务没有启动或无法连接' } });
    }
    if (!res.ok || !res.body) return reply.code(res.status || 502).send({ error: { code: 'SBOT_ERROR', message: 'Bot 事件流不可用' } });
    reply.header('content-type', 'text/event-stream; charset=utf-8').header('cache-control', 'no-cache').header('x-accel-buffering', 'no');
    const stream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    stream.on('error', () => { /* client went away */ });
    return reply.send(stream);
  });
}
