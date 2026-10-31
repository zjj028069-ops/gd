// 平台管理后台接口（/api/platform-admin/*）：管理所有企业。
// 与企业账号完全分开：独立的平台账号、独立 Cookie、独立 CSRF。
// 数据库访问只用系统已有的三个运行角色，按企业逐个操作，不绕过任何企业的行级隔离：
//   gd_auth     —— 平台账号/会话/日志、读企业和成员清单、踢会话、启停企业（受控函数）
//   gd_platform —— 建企业、建账号、改成员状态、重置密码（kgd_set_password）
//   gd_tenant   —— 进入「某一个」企业的上下文，读写它的服务期限与配额、初始化资料
// 平台后台只看企业概况（人数、配额、用量），不读取任何企业的业务数据。
import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database, Sql } from './database.js';
import { Problem } from './services.js';
import { hashPassword, safeEqual, secretToken, tokenHash, verifyPassword } from './passwords.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const SESSION_HOURS = 8;
type Operator = { id: string; username: string; display_name: string; csrf_token: string };
type Limits = { state: 'active' | 'read_only' | 'expired'; expires_at: string | null; seat_limit: number; product_limit: number; storage_limit_bytes: string | number; storage_used_bytes: string | number };

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
const memberParams = { type: 'object', additionalProperties: false, required: ['id', 'uid'], properties: { id: uuid, uid: uuid } } as const;
const username = { type: 'string', minLength: 3, maxLength: 80, pattern: '^[a-zA-Z0-9_.@-]+$' } as const;
const displayName = { type: 'string', minLength: 1, maxLength: 100 } as const;
const role = { type: 'string', enum: ['admin', 'planner', 'worker'] } as const;
const limitProps = {
  state: { type: 'string', enum: ['active', 'read_only', 'expired'] },
  expires_at: { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] },
  seat_limit: { type: 'integer', minimum: 1, maximum: 100000 },
  product_limit: { type: 'integer', minimum: 0, maximum: 10000000 },
  storage_limit_mb: { type: 'integer', minimum: 0, maximum: 1048576 },
} as const;

/** 人能抄写的随机初始密码（去掉易混淆字符） */
function readablePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[randomInt(chars.length)];
  return out;
}

function effectiveState(row: Pick<Limits, 'state' | 'expires_at'>) {
  return row.state === 'expired' || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) ? 'expired' : row.state;
}

/** 进入某一个企业的上下文（gd_tenant 角色 + 该企业的行级隔离） */
const inTenant = <T>(db: Database, tenantId: string, work: (sql: Sql) => Promise<T>) => db.tenant({ tenantId, userId: NIL }, work);

export function registerPlatformConsole(app: FastifyInstance, db: Database, options: { production: boolean }) {
  const cookieName = options.production ? '__Host-gd_platform' : 'gd_platform';
  const operators = new WeakMap<FastifyRequest, Operator>();

  const guard = async (request: FastifyRequest) => {
    const token = request.cookies[cookieName];
    if (!token || token.length > 100) throw new Problem(401, 'PLATFORM_UNAUTHENTICATED', '请先登录平台管理后台');
    const op = await db.auth(async (sql) => (await sql.query<Operator>(
      'SELECT o.id,o.username,o.display_name,s.csrf_token FROM platform_sessions s JOIN platform_operators o ON o.id=s.operator_id WHERE s.token_hash=$1 AND s.expires_at>now() AND o.active',
      [tokenHash(token)])).rows[0]);
    if (!op) throw new Problem(401, 'PLATFORM_UNAUTHENTICATED', '平台登录已失效，请重新登录');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !safeEqual(csrf, op.csrf_token)) throw new Problem(403, 'CSRF_REJECTED', '操作校验失败，请刷新后重试');
    }
    operators.set(request, op);
  };
  const me = (r: FastifyRequest) => operators.get(r)!;

  const audit = (op: Operator, action: string, tenant: { id: string; name: string } | null, detail: Record<string, unknown> = {}) =>
    db.auth((sql) => sql.query('INSERT INTO platform_audit(operator_id,operator_name,action,tenant_id,tenant_name,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [op.id, op.display_name, action, tenant?.id ?? null, tenant?.name ?? null, JSON.stringify(detail)]));

  const tenantRow = async (id: string) => {
    const t = await db.auth(async (sql) => (await sql.query<{ id: string; slug: string; name: string; active: boolean }>('SELECT id,slug,name,active FROM tenants WHERE id=$1', [id])).rows[0]);
    if (!t) throw new Problem(404, 'TENANT_NOT_FOUND', '企业不存在');
    return t;
  };

  const usage = (tenantId: string) => inTenant(db, tenantId, async (sql) => {
    const l = (await sql.query<Limits & { expires_day: string | null }>("SELECT state,expires_at,to_char(expires_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS expires_day,seat_limit,product_limit,storage_limit_bytes,storage_used_bytes FROM tenant_service_limits WHERE tenant_id=$1", [tenantId])).rows[0];
    const c = (await sql.query<{ products: string; seats: string }>('SELECT (SELECT count(*) FROM products)::text AS products,(SELECT count(*) FROM tenant_team_members)::text AS seats')).rows[0]!;
    const limits = l ?? { state: 'active', expires_at: null, seat_limit: 100, product_limit: 10000, storage_limit_bytes: 100 * 1024 * 1024, storage_used_bytes: 0 };
    return {
      state: limits.state, effective_state: effectiveState(limits), expires_at: l?.expires_day ?? null,
      seat_limit: Number(limits.seat_limit), seat_used: Number(c.seats), product_limit: Number(limits.product_limit), product_used: Number(c.products),
      storage_limit_mb: Math.round(Number(limits.storage_limit_bytes) / 1048576), storage_used_mb: Math.round(Number(limits.storage_used_bytes) / 1048576 * 10) / 10,
    };
  });

  const writeLimits = (sql: Sql, tenantId: string, b: { state?: string; expires_at?: string | null; seat_limit?: number; product_limit?: number; storage_limit_mb?: number }) =>
    sql.query(`INSERT INTO tenant_service_limits(tenant_id,state,expires_at,seat_limit,product_limit,storage_limit_bytes) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(tenant_id) DO UPDATE SET state=EXCLUDED.state,expires_at=EXCLUDED.expires_at,seat_limit=EXCLUDED.seat_limit,product_limit=EXCLUDED.product_limit,
      storage_limit_bytes=EXCLUDED.storage_limit_bytes,version=tenant_service_limits.version+1,updated_at=now()`,
    [tenantId, b.state ?? 'active', b.expires_at ? b.expires_at + 'T23:59:59+08:00' : null, b.seat_limit ?? 100, b.product_limit ?? 10000, (b.storage_limit_mb ?? 100) * 1048576]);

  /** 账号只属于这一个企业时才允许平台改它的密码（全局账号可能同时属于多个企业） */
  const soleMember = async (tenantId: string, userId: string) => {
    const rows = await db.auth(async (sql) => (await sql.query<{ tenant_id: string }>('SELECT tenant_id FROM memberships WHERE user_id=$1', [userId])).rows);
    if (!rows.some((r) => r.tenant_id === tenantId)) throw new Problem(404, 'MEMBER_NOT_FOUND', '该账号不属于这个企业');
    return rows.length === 1;
  };

  // ── 登录 ───────────────────────────────────────────────────────────────
  const dummy = hashPassword(secretToken());
  app.post<{ Body: { username: string; password: string } }>('/api/platform-admin/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username, password: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request, reply) => {
    const row = await db.auth(async (sql) => (await sql.query<{ id: string; display_name: string; password_hash: string; active: boolean }>(
      'SELECT id,display_name,password_hash,active FROM platform_operators WHERE username=$1', [request.body.username])).rows[0]);
    const ok = await verifyPassword(request.body.password, row?.password_hash ?? await dummy);
    if (!row || !ok || !row.active) throw new Problem(401, 'INVALID_CREDENTIALS', '平台账号或密码不正确');
    const token = secretToken(), csrf = secretToken();
    await db.auth(async (sql) => {
      await sql.query('DELETE FROM platform_sessions WHERE expires_at<=now()');
      await sql.query(`INSERT INTO platform_sessions(token_hash,csrf_token,operator_id,expires_at) VALUES($1,$2,$3,now()+interval '${SESSION_HOURS} hours')`, [tokenHash(token), csrf, row.id]);
      await sql.query('UPDATE platform_operators SET last_login_at=now() WHERE id=$1', [row.id]);
    });
    reply.setCookie(cookieName, token, { path: '/', httpOnly: true, secure: options.production, sameSite: 'strict', maxAge: SESSION_HOURS * 3600 });
    await audit({ id: row.id, username: request.body.username, display_name: row.display_name, csrf_token: '' }, 'login', null);
    return { operator: { username: request.body.username, display_name: row.display_name }, csrf_token: csrf };
  });
  app.get('/api/platform-admin/me', { preHandler: guard }, async (r) => ({ operator: { username: me(r).username, display_name: me(r).display_name }, csrf_token: me(r).csrf_token }));
  app.post('/api/platform-admin/logout', { preHandler: guard }, async (r, reply: FastifyReply) => {
    const token = r.cookies[cookieName]!;
    await db.auth((sql) => sql.query('DELETE FROM platform_sessions WHERE token_hash=$1', [tokenHash(token)]));
    reply.clearCookie(cookieName, { path: '/', secure: options.production, httpOnly: true, sameSite: 'strict' });
    return { ok: true };
  });

  // ── 企业 ───────────────────────────────────────────────────────────────
  app.get('/api/platform-admin/tenants', { preHandler: guard }, async () => {
    const rows = await db.auth(async (sql) => (await sql.query<{ id: string; slug: string; name: string; active: boolean; created_at: string; members: number; admins: string[] }>(
      `SELECT t.id,t.slug,t.name,t.active,t.created_at,
         (SELECT count(*)::int FROM memberships m WHERE m.tenant_id=t.id) AS members,
         COALESCE((SELECT json_agg(u.username ORDER BY u.username) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t.id AND m.role='admin' AND m.active AND u.active),'[]'::json) AS admins
       FROM tenants t ORDER BY t.created_at`)).rows);
    const items = [];
    for (const t of rows) items.push({ ...t, ...(await usage(t.id)) });
    return { items };
  });

  app.post<{ Body: { name: string; slug: string; admin_username: string; admin_name: string; state?: string; expires_at?: string | null; seat_limit?: number; product_limit?: number; storage_limit_mb?: number } }>('/api/platform-admin/tenants', {
    preHandler: guard,
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'slug', 'admin_username', 'admin_name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 }, slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' },
      admin_username: username, admin_name: displayName, ...limitProps,
    } } },
  }, async (request, reply) => {
    const b = request.body;
    const password = readablePassword();
    const hash = await hashPassword(password);
    const created = await db.identity({ tenantId: NIL, userId: NIL }, async (sql) => {
      if ((await sql.query('SELECT 1 FROM tenants WHERE slug=$1', [b.slug])).rows[0]) throw new Problem(409, 'SLUG_TAKEN', `企业标识「${b.slug}」已被使用`);
      // 新企业里还没有任何账号，用户名只需在企业内唯一，不用查别的企业
      const tenant = (await sql.query<{ id: string; slug: string; name: string }>('INSERT INTO tenants(slug,name) VALUES($1,$2) RETURNING id,slug,name', [b.slug, b.name])).rows[0]!;
      await sql.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
      const user = (await sql.query<{ id: string }>('INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) RETURNING id', [b.admin_username, b.admin_name, hash])).rows[0]!;
      await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant.id, user.id]);
      // 以下是企业自己的数据：切到企业角色，在这个企业的隔离范围内初始化
      await sql.query("SELECT set_config('app.user_id',$1,true)", [user.id]);
      await sql.exec('SET LOCAL ROLE gd_tenant');
      await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name) VALUES($1,$2,$3)', [tenant.id, user.id, b.admin_name]);
      await writeLimits(sql, tenant.id, b);
      for (const [code, name] of [['EA', '个'], ['PCS', '件'], ['KG', '千克'], ['M', '米']]) {
        await sql.query('INSERT INTO units(tenant_id,code,name) VALUES($1,$2,$3)', [tenant.id, code, name]);
      }
      return tenant;
    });
    await audit(me(request), 'tenant.create', created, { admin_username: b.admin_username, expires_at: b.expires_at ?? null, seat_limit: b.seat_limit ?? 100 });
    return reply.code(201).send({ tenant: created, admin: { username: b.admin_username, password } });
  });

  app.patch<{ Params: { id: string }; Body: { active: boolean } }>('/api/platform-admin/tenants/:id', {
    preHandler: guard,
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['active'], properties: { active: { type: 'boolean' } } } },
  }, async (request) => {
    const t = await tenantRow(request.params.id);
    await db.auth(async (sql) => {
      await sql.query('SELECT platform_set_tenant_active($1,$2)', [t.id, request.body.active]);
      if (!request.body.active) await sql.query('DELETE FROM sessions WHERE tenant_id=$1', [t.id]); // 停用即刻下线
    });
    await audit(me(request), request.body.active ? 'tenant.enable' : 'tenant.disable', t);
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { state: string; expires_at: string | null; seat_limit: number; product_limit: number; storage_limit_mb: number } }>('/api/platform-admin/tenants/:id/limits', {
    preHandler: guard,
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['state', 'expires_at', 'seat_limit', 'product_limit', 'storage_limit_mb'], properties: limitProps } },
  }, async (request) => {
    const t = await tenantRow(request.params.id);
    const before = await usage(t.id);
    await inTenant(db, t.id, (sql) => writeLimits(sql, t.id, request.body));
    const after = await usage(t.id);
    await audit(me(request), 'tenant.limits', t, { before: { state: before.state, expires_at: before.expires_at, seat_limit: before.seat_limit, product_limit: before.product_limit, storage_limit_mb: before.storage_limit_mb }, after: request.body });
    return after;
  });

  // ── 企业成员 ───────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/platform-admin/tenants/:id/members', { preHandler: guard, schema: { params: idParams } }, async (request) => {
    await tenantRow(request.params.id);
    return { items: await db.auth(async (sql) => (await sql.query(
      `SELECT u.id,u.username,u.display_name,u.active AS user_active,m.role,m.active,
         (SELECT count(*)::int FROM memberships x WHERE x.user_id=u.id) AS tenant_count
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY (m.role='admin') DESC,u.username`, [request.params.id])).rows) };
  });

  app.post<{ Params: { id: string }; Body: { username: string; display_name: string; role: 'admin' | 'planner' | 'worker' } }>('/api/platform-admin/tenants/:id/members', {
    preHandler: guard,
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['username', 'display_name', 'role'], properties: { username, display_name: displayName, role } } },
  }, async (request, reply) => {
    const t = await tenantRow(request.params.id);
    const b = request.body;
    const password = readablePassword();
    const hash = await hashPassword(password);
    await db.identity({ tenantId: t.id, userId: NIL }, async (sql) => {
      // 用户名只在本企业内唯一（别的企业有同名账号不影响）
      if ((await sql.query('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.username=$2', [t.id, b.username])).rows[0]) throw new Problem(409, 'USERNAME_TAKEN', `账号「${b.username}」已存在，请换一个`);
      const user = (await sql.query<{ id: string }>('INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) RETURNING id', [b.username, b.display_name, hash])).rows[0]!;
      await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [t.id, user.id, b.role]);
      await sql.exec('SET LOCAL ROLE gd_tenant');
      await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name) VALUES($1,$2,$3)', [t.id, user.id, b.display_name]);
    });
    await audit(me(request), 'member.create', t, { username: b.username, role: b.role });
    return reply.code(201).send({ username: b.username, password });
  });

  app.post<{ Params: { id: string; uid: string } }>('/api/platform-admin/tenants/:id/members/:uid/reset-password', { preHandler: guard, schema: { params: memberParams } }, async (request) => {
    const t = await tenantRow(request.params.id);
    if (!(await soleMember(t.id, request.params.uid))) throw new Problem(409, 'SHARED_ACCOUNT', '该账号同时属于其他企业，为避免影响其他企业，不能在这里重置密码');
    const password = readablePassword();
    const hash = await hashPassword(password);
    const name = await db.identity({ tenantId: t.id, userId: NIL }, async (sql) => {
      const row = (await sql.query<{ username: string }>('SELECT u.username FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2', [t.id, request.params.uid])).rows[0];
      if (!row) throw new Problem(404, 'MEMBER_NOT_FOUND', '该账号不属于这个企业');
      await sql.query('SELECT kgd_set_password($1,$2)', [request.params.uid, hash]);
      return row.username;
    });
    await db.auth((sql) => sql.query('DELETE FROM sessions WHERE user_id=$1', [request.params.uid])); // 旧登录全部失效
    await audit(me(request), 'member.reset_password', t, { username: name });
    return { username: name, password };
  });

  app.patch<{ Params: { id: string; uid: string }; Body: { active?: boolean; role?: 'admin' | 'planner' | 'worker' } }>('/api/platform-admin/tenants/:id/members/:uid', {
    preHandler: guard,
    schema: { params: memberParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { active: { type: 'boolean' }, role } } },
  }, async (request) => {
    const t = await tenantRow(request.params.id);
    const b = request.body;
    const name = await db.identity({ tenantId: t.id, userId: NIL }, async (sql) => {
      const row = (await sql.query<{ username: string; role: string; active: boolean }>('SELECT u.username,m.role,m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2', [t.id, request.params.uid])).rows[0];
      if (!row) throw new Problem(404, 'MEMBER_NOT_FOUND', '该账号不属于这个企业');
      // 不能让企业失去最后一个可用的管理员（停用他，或把他改成别的角色）
      const losesAdmin = row.role === 'admin' && row.active && (b.active === false || (b.role !== undefined && b.role !== 'admin'));
      if (losesAdmin) {
        const others = (await sql.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id<>$2 AND m.role='admin' AND m.active AND u.active", [t.id, request.params.uid])).rows[0]!.n;
        if (!others) throw new Problem(409, 'LAST_ADMIN', '这是企业唯一的管理员，停用或改角色后企业里就没人能管理了。请先再添加一个管理员');
      }
      if (b.active !== undefined) await sql.query('UPDATE memberships SET active=$3 WHERE tenant_id=$1 AND user_id=$2', [t.id, request.params.uid, b.active]);
      if (b.role) await sql.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [t.id, request.params.uid, b.role]);
      return row.username;
    });
    if (b.active === false || b.role) await db.auth((sql) => sql.query('DELETE FROM sessions WHERE user_id=$1 AND tenant_id=$2', [request.params.uid, t.id]));
    await audit(me(request), b.active === false ? 'member.disable' : b.active === true ? 'member.enable' : 'member.role', t, { username: name, ...b });
    return { ok: true };
  });

  // ── 平台操作日志 ───────────────────────────────────────────────────────
  app.get<{ Querystring: { tenant_id?: string } }>('/api/platform-admin/audit', {
    preHandler: guard,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { tenant_id: uuid } } },
  }, async (request) => ({ items: await db.auth(async (sql) => (await sql.query(
    `SELECT id::text,operator_name,action,tenant_id,tenant_name,detail,created_at FROM platform_audit ${request.query.tenant_id ? 'WHERE tenant_id=$1' : ''} ORDER BY created_at DESC,id DESC LIMIT 200`,
    request.query.tenant_id ? [request.query.tenant_id] : [])).rows) }));
}
