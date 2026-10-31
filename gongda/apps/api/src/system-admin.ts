import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { gateTenantWrite } from './assets.js';
import { hashPassword } from './passwords.js';
import { Problem, type Actor, type Services } from './services.js';
import { assertPoint, asScopes, asStringList, customerPoints, derivePermissions, permissionModules, type PointScope } from './kgd-permissions.js';
import { syncFinalNotices } from './audit-engine.js';
import { noteOp, searchOperationLogs } from './operation-log.js';
import { shanghaiTime } from './r10-kit.js';
import { syncFollowReminders } from './crm-follow.js';
import { syncPurchaseReminders } from './purchase-settings.js';

type Row = Record<string, unknown>;
const messageKindText: Record<string, string> = { alarm: '报警', todo: '待办', notice: '通知', follow: '客户跟单', bulletin: '通知公告' };

async function toTenant(sql: Sql) { await sql.exec('SET LOCAL ROLE gd_tenant'); }
async function toIdentity(sql: Sql) { await sql.exec('SET LOCAL ROLE gd_platform'); }

function text(value: unknown, max: number, label: string, required = false) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (required && !raw) throw new Problem(422, 'REQUIRED', `${label}不能为空`);
  if (raw.length > max) throw new Problem(422, 'TOO_LONG', `${label}不能超过${max}字`);
  return raw;
}

/** 用户单独勾选的权限点与范围；follow_role=true 时返回 null（跟随角色） */
function userPointsFromBody(body: Row): { points: string[]; scopes: Record<string, PointScope> } | null | undefined {
  if (body.follow_role === true) return null;
  if (!Array.isArray(body.user_points)) return undefined;
  const points = [...new Set(body.user_points.map(String))];
  if (points.length > 1000 || points.some((p) => !/^[a-zA-Z0-9_.:-]{1,80}$/.test(p))) throw new Problem(422, 'INVALID_POINTS', '权限设置格式不正确');
  // 只保留勾选了的权限点的范围（取消勾选后残留的范围不存）
  const scopes = Object.fromEntries(Object.entries(asScopes(body.user_scopes)).filter(([point]) => points.includes(point)));
  return { points, scopes };
}

const pointNames = new Map<string, string>();
for (const module of permissionModules) for (const group of module.groups) for (const point of group.points) {
  pointNames.set(point.code, group.name === module.name ? `${module.name}-${point.name}` : `${module.name}/${group.name}-${point.name}`);
}
const pointLabel = (code: string) => pointNames.get(code) ?? code;
const scopeRank: Record<string, number> = { self: 1, team: 2, all: 3 };
/** 企业管理员（或老式全权限账号）不受限制 */
function unrestricted(actor: Actor) { return actor.role === 'admin' || actor.points === null; }
/** 有「账号管理」权限但不是管理员的人：只能分配自己拥有的权限，范围也不能比自己大 */
function assertCanGrant(actor: Actor, points: string[], scopes: Record<string, PointScope> = {}) {
  if (unrestricted(actor)) return;
  const own = new Set(actor.points ?? []);
  const missing = points.filter((point) => !own.has(point));
  if (missing.length) throw new Problem(403, 'GRANT_EXCEEDS_OWN', `不能分配你自己没有的权限：${missing.slice(0, 3).map(pointLabel).join('、')}${missing.length > 3 ? ` 等${missing.length}项` : ''}`);
  // 没填范围的权限点按「全部」生效，所以要逐个点比较
  for (const point of points) {
    const scope = scopes[point] ?? 'all';
    const mine = actor.point_scopes[point] ?? 'all';
    if ((scopeRank[scope] ?? 3) > (scopeRank[mine] ?? 3)) throw new Problem(403, 'GRANT_EXCEEDS_OWN', `「${pointLabel(point)}」的数据范围不能比你自己的大`);
  }
}
async function rolePoints(sql: Sql, roleId: unknown) {
  const row = (await sql.query<{ kgd_points: unknown; point_scopes: unknown }>('SELECT kgd_points,point_scopes FROM tenant_roles WHERE id=$1', [roleId])).rows[0];
  return row ? { points: asStringList(row.kgd_points) ?? [], scopes: asScopes(row.point_scopes) } : null;
}

function logoOf(value: unknown) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new Problem(422, 'LOGO', '企业标志格式不正确');
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value.trim());
  if (!match) throw new Problem(422, 'LOGO', '企业标志需为 PNG、JPEG、WEBP 或 GIF');
  const payload = (match[2] ?? '').replace(/\s/g, '');
  const bytes = Buffer.from(payload, 'base64').length;
  if (!bytes || bytes > 300 * 1024) throw new Problem(422, 'LOGO', '企业标志不能超过 300KB');
  return `data:image/${match[1]};base64,${payload}`;
}

async function departmentPath(sql: Sql, id: string | null) {
  if (!id) return '-';
  const names: string[] = [];
  let current: string | null = id;
  for (let guard = 0; current && guard < 8; guard += 1) {
    const row: { name: string; parent_id: string | null } | undefined = (await sql.query<{ name: string; parent_id: string | null }>('SELECT name,parent_id FROM departments WHERE id=$1', [current])).rows[0];
    if (!row) break;
    names.unshift(row.name);
    current = row.parent_id;
  }
  return names.join('/') || '-';
}

async function assertDepartmentParent(sql: Sql, id: string | null, parent: string | null) {
  if (!parent) return;
  if (id && parent === id) throw new Problem(422, 'DEPARTMENT_CYCLE', '部门不能隶属于自己');
  const valid = (await sql.query('SELECT id FROM departments WHERE id=$1 AND active', [parent])).rows[0];
  if (!valid) throw new Problem(422, 'INVALID_REFERENCE', '上级部门不存在或已停用');
  if (!id) return;
  const cycle = (await sql.query('WITH RECURSIVE chain AS (SELECT id,parent_id FROM departments WHERE id=$1 UNION SELECT d.id,d.parent_id FROM departments d JOIN chain c ON d.id=c.parent_id) SELECT id FROM chain WHERE id=$2', [parent, id])).rows[0];
  if (cycle) throw new Problem(422, 'DEPARTMENT_CYCLE', '部门层级存在循环');
}

async function teamNames(sql: Sql, userId: string) {
  const rows = (await sql.query<{ name: string }>('SELECT t.name FROM kgd_team_members m JOIN kgd_teams t ON t.id=m.team_id WHERE m.user_id=$1 AND t.active ORDER BY t.name', [userId])).rows;
  return rows.length ? rows.map((row) => row.name).join('，') : '-';
}


const SYSTEM_ROLE_SEED: { code: string; name: string; points: string[] }[] = [
  { code: 'SYS_DEVICE', name: '设备维保人员', points: ['menu.device.view'] },
  { code: 'SYS_PROD_MGR', name: '生产主管', points: ['menu.produce.view', 'menu.report.view', 'menu.screen.view'] },
  { code: 'SYS_QC', name: '质检员', points: ['menu.produce.view'] },
  { code: 'SYS_WORKER', name: '生产工', points: ['menu.produce.view'] },
  { code: 'SYS_WH', name: '仓库管理员', points: ['menu.warehouse.view', 'menu.goods.view', 'menu.supply.view'] },
  { code: 'SYS_AS_MGR', name: '售后主管', points: ['menu.device.view', 'info.message.view'] },
  { code: 'SYS_FIN', name: '财务', points: ['customer.cash.view', 'customer.invoice.view', 'customer.expense.view', 'menu.report.view'] },
  { code: 'SYS_CS', name: '客服人员', points: ['customer.list.view', 'customer.list.follow', 'info.message.view', 'menu.ai.view'] },
  { code: 'SYS_AS_ENG', name: '售后工程师', points: ['menu.device.view'] },
  { code: 'SYS_ADMIN', name: '系统管理员', points: permissionModules.flatMap((mod) => mod.groups.flatMap((g) => g.points.map((p) => p.code))) },
];

async function ensureSystemRoles(sql: Sql, tenantId: string) {
  const existing = (await sql.query<{ name: string; code: string }>('SELECT name,code FROM tenant_roles')).rows;
  const names = new Set(existing.map((row) => row.name));
  const codes = new Set(existing.map((row) => row.code));
  for (const role of SYSTEM_ROLE_SEED) {
    if (names.has(role.name) || codes.has(role.code)) continue;
    await sql.query(
      "INSERT INTO tenant_roles(tenant_id,code,name,permissions,data_scope,kgd_points,point_scopes,active) VALUES($1,$2,$3,$4::jsonb,'all',$5::jsonb,$6::jsonb,true) ON CONFLICT (tenant_id,code) DO NOTHING",
      [tenantId, role.code, role.name, JSON.stringify(derivePermissions(role.points)), JSON.stringify(role.points), JSON.stringify({})],
    );
  }
}

export function registerSystemAdmin(app: FastifyInstance, services: Services) {
  const guard = services.authorize();
  const actor = (request: FastifyRequest) => services.actor(request);
  const run = (request: FastifyRequest, work: (sql: Sql, actor: Actor) => Promise<unknown>) => services.database.tenant(services.context(request), (sql) => work(sql, actor(request)));

  app.get('/api/system/permission-catalog', { preHandler: guard }, async () => ({ modules: permissionModules }));

  app.get('/api/public/brand', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const slug = typeof (request.query as { slug?: unknown }).slug === 'string' ? (request.query as { slug: string }).slug.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return { logo: '' };
    const tenant = await services.database.auth(async (sql) => (await sql.query<{ id: string }>('SELECT id FROM tenants WHERE slug=$1 AND active', [slug])).rows[0]);
    if (!tenant) return { logo: '' };
    const row = await services.database.tenant({ tenantId: tenant.id, userId: '00000000-0000-0000-0000-000000000000' }, async (sql) => (await sql.query<{ logo: string }>('SELECT logo FROM kgd_enterprise_settings')).rows[0]);
    return { logo: row?.logo?.startsWith('data:image/') ? row.logo : '' };
  });

  app.get('/api/system/enterprise', { preHandler: guard }, async (request) => run(request, async (sql) => {
    await sql.query('INSERT INTO kgd_enterprise_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [actor(request).tenant_id]);
    const settings = (await sql.query('SELECT name,logo,produce_module,aftersales_module,device_module,version FROM kgd_enterprise_settings')).rows[0];
    const limits = (await sql.query<{ expires_at: string | null; seat_limit: number }>('SELECT expires_at,seat_limit FROM tenant_service_limits')).rows[0];
    const used = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM tenant_team_members')).rows[0]!.n);
    return {
      enterprise: settings,
      expires_at: limits?.expires_at ?? null,
      expires_text: limits?.expires_at ? String(limits.expires_at).slice(0, 10) : '-',
      seats: { limit: limits?.seat_limit ?? 0, used, remaining: Math.max(0, (limits?.seat_limit ?? 0) - used), label: `生产席位 剩余：${Math.max(0, (limits?.seat_limit ?? 0) - used)}` },
    };
  }));
  app.put('/api/system/enterprise', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    if (!(current.role === 'admin' || (current.points === null ? current.permissions.includes('organization.manage') : current.points.includes('system.setting')))) {
      throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
    }
    const body = request.body as Row;
    const name = text(body.name, 80, '企业名称', true);
    const logo = logoOf(body.logo);
    await sql.query('INSERT INTO kgd_enterprise_settings(tenant_id,name) VALUES($1,$2) ON CONFLICT (tenant_id) DO NOTHING', [current.tenant_id, name]);
    const row = await sql.query('UPDATE kgd_enterprise_settings SET name=$1,logo=$2,produce_module=$3,aftersales_module=$4,device_module=$5,version=version+1,updated_at=now() WHERE version=$6 RETURNING name,logo,produce_module,aftersales_module,device_module,version', [
      name, logo, body.produce_module !== false, body.aftersales_module !== false, body.device_module !== false, Number(body.version ?? 1),
    ]);
    if (!row.rows[0]) throw new Problem(409, 'VERSION_CONFLICT', '企业信息已修改，请刷新');
    noteOp(request, `修改企业信息：${name}`);
    return { enterprise: row.rows[0] };
  }));

  app.get('/api/system/personal', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    const profile = (await sql.query<{ display_name: string; phone: string; department_id: string | null; face_avatar_id: string | null; custom_role_id: string | null }>('SELECT display_name,phone,department_id,face_avatar_id,custom_role_id FROM tenant_member_profiles WHERE user_id=$1', [current.user_id])).rows[0];
    const role = profile?.custom_role_id ? (await sql.query<{ name: string }>('SELECT name FROM tenant_roles WHERE id=$1', [profile.custom_role_id])).rows[0]?.name : (current.role === 'admin' ? '管理员' : '-');
    return { personal: { display_name: profile?.display_name ?? current.display_name, phone: profile?.phone || '-', department_id: profile?.department_id ?? null, department_path: await departmentPath(sql, profile?.department_id ?? null), face_avatar_id: profile?.face_avatar_id ?? null, username: '-', role_name: role || '-', team_names: await teamNames(sql, current.user_id) } };
  }));
  app.put('/api/system/personal', { preHandler: guard }, async (request) => {
    const body = request.body as Row;
    const current = actor(request);
    const display = body.display_name === undefined ? null : text(body.display_name, 80, '姓名', true);
    const phone = body.phone === undefined ? null : text(body.phone, 20, '手机');
    await services.database.tenant(services.context(request), async (sql) => {
      await sql.query('UPDATE tenant_member_profiles SET display_name=COALESCE($1,display_name),phone=COALESCE($2,phone),version=version+1,updated_at=now() WHERE user_id=$3', [display, phone, current.user_id]);
    });
    if (body.password) {
      const password = String(body.password);
      if (password.length < 6) throw new Problem(422, 'PASSWORD', '密码至少6位');
      const hash = await hashPassword(password);
      await services.database.identity(services.context(request), async (sql) => { await sql.query('SELECT kgd_set_password($1,$2)', [current.user_id, hash]); });
    }
    noteOp(request, '修改个人资料');
    return { ok: true };
  });

  app.get('/api/system/messages', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    await syncFinalNotices(sql, current);
    await syncFollowReminders(sql, current);
    await syncPurchaseReminders(sql, current);
    const query = request.query as Row;
    const rows = (await sql.query<Row>("SELECT * FROM kgd_messages WHERE user_id=$1 AND created_at>=now()-interval '3 months' ORDER BY created_at DESC LIMIT 300", [current.user_id])).rows;
    const items = rows.filter((row) => {
      if (query.kind && query.kind !== 'all' && row.kind !== query.kind) return false;
      if (query.read === 'unread' && row.read_at) return false;
      if (query.read === 'read' && !row.read_at) return false;
      if (query.code && !String(row.doc_code).includes(String(query.code)) && !String(row.body).includes(String(query.code))) return false;
      return true;
    }).map((row) => ({ ...row, kind_text: messageKindText[String(row.kind)] ?? '通知', read_text: row.read_at ? '已读' : '未读' }));
    return { items, unread: rows.filter((row) => !row.read_at).length };
  }));
  app.post<{ Params: { id: string } }>('/api/system/messages/:id/read', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    const read = (await sql.query<{ object_type: string; object_id: string | null }>('UPDATE kgd_messages SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING object_type,object_id', [request.params.id, current.user_id])).rows[0];
    if (read?.object_type === 'notice' && read.object_id) await sql.query('INSERT INTO notice_reads(tenant_id,notice_id,user_id) SELECT tenant_id,id,$2 FROM notices WHERE id=$1 ON CONFLICT DO NOTHING', [read.object_id, current.user_id]);
    return { ok: true };
  }));

  app.get('/api/system/operation-logs', { preHandler: guard }, async (request) => {
    assertPoint(actor(request), 'system.log');
    return searchOperationLogs(services, request);
  });

  app.get('/api/system/departments', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.account');
    const rows = (await sql.query<{ id: string; parent_id: string | null; code: string; name: string; active: boolean; created_text: string }>(`SELECT id,parent_id,code,name,active,${shanghaiTime('created_at')} AS created_text FROM departments WHERE active ORDER BY code`)).rows;
    const items = [];
    for (const row of rows) items.push({ ...row, path: await departmentPath(sql, row.id) });
    return { items };
  }));
  app.post('/api/system/departments', { preHandler: guard }, async (request, reply) => {
    const body = request.body as Row;
    const created = await run(request, async (sql, current) => {
      assertPoint(current, 'system.account');
      const name = text(body.name, 80, '部门名称', true);
      const parent = body.parent_id ? String(body.parent_id) : null;
      await assertDepartmentParent(sql, null, parent);
      const seq = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM departments')).rows[0]!.n) + 1;
      const code = `BM${String(seq).padStart(4, '0')}`;
      const id = (await sql.query<{ id: string }>('INSERT INTO departments(tenant_id,code,name,parent_id) VALUES($1,$2,$3,$4) RETURNING id', [current.tenant_id, code, name, parent])).rows[0]!.id;
      noteOp(request, `新增部门：${name}`);
      return { id, code, name, parent_id: parent, path: await departmentPath(sql, id) };
    });
    return reply.code(201).send({ department: created });
  });
  app.patch<{ Params: { id: string } }>('/api/system/departments/:id', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.account');
    const id = request.params.id;
    const body = request.body as Row;
    const name = text(body.name, 80, '部门名称', true);
    const parent = body.parent_id ? String(body.parent_id) : null;
    const before = (await sql.query<{ id: string }>('SELECT id FROM departments WHERE id=$1 AND active', [id])).rows[0];
    if (!before) throw new Problem(404, 'DEPARTMENT_NOT_FOUND', '部门不存在或已停用');
    await assertDepartmentParent(sql, id, parent);
    await sql.query('UPDATE departments SET name=$1,parent_id=$2,version=version+1,updated_at=now() WHERE id=$3', [name, parent, id]);
    noteOp(request, `修改部门：${name}`);
    return { department: { id, name, parent_id: parent, path: await departmentPath(sql, id) } };
  }));
  app.delete<{ Params: { id: string } }>('/api/system/departments/:id', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.account');
    const id = request.params.id;
    const blocked = (await sql.query('SELECT id FROM departments WHERE parent_id=$1 AND active UNION ALL SELECT user_id FROM tenant_member_profiles WHERE department_id=$1 LIMIT 1', [id])).rows[0];
    if (blocked) throw new Problem(409, 'DEPARTMENT_USED', '部门下还有用户或下级部门，不能删除');
    await sql.query('UPDATE departments SET active=false,version=version+1,updated_at=now() WHERE id=$1', [id]);
    noteOp(request, '删除部门');
    return { ok: true };
  }));

  app.get('/api/system/teams', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.team');
    const teams = (await sql.query('SELECT id,parent_id,name,leader_id,intro,regions,version FROM kgd_teams WHERE active ORDER BY name')).rows as Row[];
    const items = [];
    for (const team of teams) {
      const members = (await sql.query<{ user_id: string; display_name: string }>('SELECT m.user_id,COALESCE(p.display_name,\'\') AS display_name FROM kgd_team_members m LEFT JOIN tenant_member_profiles p ON p.user_id=m.user_id WHERE m.team_id=$1', [team.id])).rows;
      items.push({ ...team, member_ids: members.map((member) => member.user_id), member_names: members.map((member) => member.display_name).filter(Boolean).join('，') || '-', intro: team.intro || '-' });
    }
    return { items, tip: '未选上级团队默认为第一级团队。' };
  }));
  app.post('/api/system/teams', { preHandler: guard }, async (request, reply) => {
    const body = request.body as Row;
    const created = await run(request, async (sql, current) => {
      assertPoint(current, 'system.team');
      const name = text(body.name, 80, '团队名称', true);
      const intro = text(body.intro, 255, '简介');
      const leaderId = String(body.leader_id ?? '').trim();
      if (!leaderId) throw new Problem(422, 'REQUIRED', '请选择团队主管', 'leader_id');
      const id = (await sql.query<{ id: string }>('INSERT INTO kgd_teams(tenant_id,parent_id,name,leader_id,intro,regions) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id', [current.tenant_id, body.parent_id ?? null, name, leaderId, intro, JSON.stringify(body.regions ?? [])])).rows[0]!.id;
      for (const userId of Array.isArray(body.member_ids) ? body.member_ids.map(String) : []) {
        await sql.query('INSERT INTO kgd_team_members(tenant_id,team_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [current.tenant_id, id, userId]);
      }
      noteOp(request, `新增团队：${name}`);
      return { id };
    });
    return reply.code(201).send({ team: created });
  });
  app.patch<{ Params: { id: string } }>('/api/system/teams/:id', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.team');
    const body = request.body as Row;
    const name = text(body.name, 80, '团队名称', true);
    const intro = text(body.intro, 255, '简介');
    const row = await sql.query('UPDATE kgd_teams SET parent_id=$1,name=$2,leader_id=$3,intro=$4,regions=$5::jsonb,version=version+1,updated_at=now() WHERE id=$6 AND version=$7 RETURNING id', [body.parent_id ?? null, name, body.leader_id ?? null, intro, JSON.stringify(body.regions ?? []), request.params.id, Number(body.version)]);
    if (!row.rows[0]) throw new Problem(409, 'VERSION_CONFLICT', '团队已修改，请刷新');
    await sql.query('DELETE FROM kgd_team_members WHERE team_id=$1', [request.params.id]);
    for (const userId of Array.isArray(body.member_ids) ? body.member_ids.map(String) : []) {
      await sql.query('INSERT INTO kgd_team_members(tenant_id,team_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [current.tenant_id, request.params.id, userId]);
    }
    noteOp(request, `修改团队：${name}`);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/system/teams/:id', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.team');
    const child = (await sql.query('SELECT id FROM kgd_teams WHERE parent_id=$1 AND active LIMIT 1', [request.params.id])).rows[0];
    if (child) throw new Problem(409, 'TEAM_USED', '团队下还有下级团队，不能删除');
    await sql.query('UPDATE kgd_teams SET active=false,version=version+1,updated_at=now() WHERE id=$1', [request.params.id]);
    noteOp(request, '删除团队');
    return { ok: true };
  }));

  app.get('/api/system/roles', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.account');
    await ensureSystemRoles(sql, current.tenant_id);
    const rows = (await sql.query<{ id: string; name: string; code: string; kgd_points: unknown; point_scopes: unknown; active: boolean; version: number; created_at: string; user_count: number }>('SELECT r.id,r.name,r.code,r.kgd_points,r.point_scopes,r.active,r.version,r.created_at,(SELECT count(*)::int FROM tenant_member_profiles p WHERE p.custom_role_id=r.id) AS user_count FROM tenant_roles r WHERE r.active ORDER BY r.name')).rows;
    return { items: rows.map((row) => ({ ...row, points: asStringList(row.kgd_points) ?? [], scopes: asScopes(row.point_scopes), created_text: String(row.created_at).replace('T', ' ').slice(0, 19) })) };
  }));
  app.post('/api/system/roles', { preHandler: guard }, async (request, reply) => {
    const body = request.body as Row;
    const created = await run(request, async (sql, current) => {
      assertPoint(current, 'system.account');
      const name = text(body.name, 80, '角色名称', true);
      const points = Array.isArray(body.points) ? body.points.map(String) : [];
      const scopes = asScopes(body.scopes);
      assertCanGrant(current, points, scopes);
      const code = `R${Date.now().toString().slice(-8)}`;
      const id = (await sql.query<{ id: string }>('INSERT INTO tenant_roles(tenant_id,code,name,permissions,data_scope,kgd_points,point_scopes) VALUES($1,$2,$3,$4::jsonb,\'all\',$5::jsonb,$6::jsonb) RETURNING id', [current.tenant_id, code, name, JSON.stringify(derivePermissions(points)), JSON.stringify(points), JSON.stringify(scopes)])).rows[0]!.id;
      noteOp(request, `新增角色：${name}`);
      return { id, name, points, scopes };
    });
    return reply.code(201).send({ role: created });
  });
  app.patch<{ Params: { id: string } }>('/api/system/roles/:id', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.account');
    const body = request.body as Row;
    const name = text(body.name, 80, '角色名称', true);
    const points = Array.isArray(body.points) ? body.points.map(String) : [];
    const scopes = asScopes(body.scopes);
    assertCanGrant(current, points, scopes);
    const row = await sql.query('UPDATE tenant_roles SET name=$1,permissions=$2::jsonb,data_scope=\'all\',kgd_points=$3::jsonb,point_scopes=$4::jsonb,version=version+1,updated_at=now() WHERE id=$5 AND version=$6 RETURNING id', [name, JSON.stringify(derivePermissions(points)), JSON.stringify(points), JSON.stringify(scopes), request.params.id, Number(body.version)]);
    if (!row.rows[0]) throw new Problem(409, 'VERSION_CONFLICT', '角色已被修改，请刷新');
    noteOp(request, `修改角色：${name}`);
    return { ok: true };
  }));
  app.delete<{ Params: { id: string } }>('/api/system/roles/:id', { preHandler: guard }, async (request) => run(request, async (sql, current) => {
    assertPoint(current, 'system.account');
    const used = (await sql.query('SELECT user_id FROM tenant_member_profiles WHERE custom_role_id=$1 LIMIT 1', [request.params.id])).rows[0];
    if (used) throw new Problem(409, 'ROLE_USED', '该角色下还有用户，不能删除');
    await sql.query('UPDATE tenant_roles SET active=false,version=version+1,updated_at=now() WHERE id=$1', [request.params.id]);
    noteOp(request, '删除角色');
    return { ok: true };
  }));

  async function users(sql: Sql) {
    await toTenant(sql);
    const profiles = (await sql.query<Row>('SELECT user_id,display_name,phone,department_id,custom_role_id,is_virtual,user_points,user_point_scopes,version,updated_at FROM tenant_member_profiles')).rows;
    const roles = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM tenant_roles')).rows;
    const roleName = new Map(roles.map((role) => [role.id, role.name]));
    const map = new Map(profiles.map((profile) => [String(profile.user_id), profile]));
    await toIdentity(sql);
    const members = (await sql.query<{ id: string; username: string; display_name: string; role: string; active: boolean }>('SELECT u.id,u.username,u.display_name,m.role,m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id::text=current_setting(\'app.tenant_id\',true) ORDER BY u.username')).rows;
    await toTenant(sql);
    const items = [];
    for (const member of members) {
      const profile = map.get(member.id);
      items.push({
        id: member.id,
        username: member.username,
        display_name: profile?.display_name || member.display_name || '-',
        phone: profile?.phone || '-',
        role_name: profile?.custom_role_id ? roleName.get(String(profile.custom_role_id)) ?? '-' : (member.role === 'admin' ? '管理员' : '-'),
        custom_role_id: profile?.custom_role_id ?? null,
        department_id: profile?.department_id ?? null,
        department_path: await departmentPath(sql, profile?.department_id ? String(profile.department_id) : null),
        team_names: await teamNames(sql, member.id),
        team_ids: (await sql.query<{ team_id: string }>('SELECT team_id FROM kgd_team_members WHERE user_id=$1 ORDER BY team_id', [member.id])).rows.map((row) => row.team_id),
        active: member.active,
        status_text: member.active ? '启用' : '停用',
        user_type: profile?.is_virtual ? '虚拟用户' : '普通用户',
        seat_text: '生产',
        created_text: profile?.updated_at ? String(profile.updated_at).replace('T', ' ').slice(0, 19) : '-',
        is_virtual: Boolean(profile?.is_virtual),
        membership_role: member.role,
        version: profile?.version ?? 1,
        user_points: asStringList(profile?.user_points),
        user_scopes: asScopes(profile?.user_point_scopes),
      });
    }
    return items;
  }

  app.get('/api/system/users', { preHandler: guard }, async (request) => {
    assertPoint(actor(request), 'system.account');
    const enterprise = await services.database.tenant(services.context(request), async (inner) => {
      const limits = (await inner.query<{ seat_limit: number }>('SELECT seat_limit FROM tenant_service_limits')).rows[0];
      const used = Number((await inner.query<{ n: string }>('SELECT count(*)::text AS n FROM tenant_team_members')).rows[0]!.n);
      return { remaining: Math.max(0, (limits?.seat_limit ?? 0) - used) };
    });
    const items = await services.database.identity(services.context(request), async (sql) => users(sql));
    return { items, seat_label: `生产席位 剩余：${enterprise.remaining}`, customer_points: customerPoints() };
  });

  app.post('/api/system/users', { preHandler: guard }, async (request, reply) => {
    const body = request.body as Row;
    const current = actor(request);
    assertPoint(current, 'system.account');
    const username = text(body.username, 80, '账号', true);
    if (username.length < 3) throw new Problem(422, 'USERNAME', '账号至少3个字符（中文按字计算，如「顾哥」仅2字，请用至少3字）');
    const display = text(body.display_name, 80, '姓名', true);
    const password = String(body.password ?? '');
    if (password.length < 6) throw new Problem(422, 'PASSWORD', '密码至少6位');
    if (!body.custom_role_id) throw new Problem(422, 'REQUIRED', '角色不能为空');
    const hash = await hashPassword(password);
    try {
      const member = await services.database.identity(services.context(request), async (sql) => {
        await toTenant(sql);
        await gateTenantWrite(sql, services.context(request), 'seats');
        const role = (await sql.query<{ id: string }>('SELECT id FROM tenant_roles WHERE id=$1 AND active=true', [body.custom_role_id])).rows[0];
        if (!role) throw new Problem(422, 'INVALID_REFERENCE', '角色不存在或已停用');
        const chosen = userPointsFromBody(body);
        const granted = chosen ?? await rolePoints(sql, body.custom_role_id);
        if (granted) assertCanGrant(current, granted.points, granted.scopes);
        await toIdentity(sql);
        // 用户名只在本企业内唯一：别的企业有同名账号不影响，也不会让人知道别的企业有这个名字
        const existed = (await sql.query<{ id: string }>('SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.username=$2', [current.tenant_id, username])).rows[0];
        if (existed) throw new Problem(409, 'DUPLICATE', '账号已存在，请更换用户名');
        const user = (await sql.query<{ id: string }>('INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) RETURNING id', [username, display, hash])).rows[0]!;
        await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'planner')", [current.tenant_id, user.id]);
        await toTenant(sql);
        await sql.query('INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name,department_id,custom_role_id,phone,is_virtual) VALUES($1,$2,$3,$4,$5,$6,$7)', [current.tenant_id, user.id, display, body.department_id ?? null, body.custom_role_id, text(body.phone, 20, '手机'), Boolean(body.is_virtual)]);
        // 新增时勾选的权限也要保存（以前只存了角色，勾选的权限被丢掉）
        if (chosen) await sql.query('UPDATE tenant_member_profiles SET user_points=$1::jsonb,user_point_scopes=$2::jsonb WHERE user_id=$3', [JSON.stringify(chosen.points), JSON.stringify(chosen.scopes), user.id]);
        for (const teamId of Array.isArray(body.team_ids) ? body.team_ids.map(String) : []) {
          await sql.query('INSERT INTO kgd_team_members(tenant_id,team_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [current.tenant_id, teamId, user.id]);
        }
        noteOp(request, `新增用户：${display}`);
        return { id: user.id, username, display_name: display };
      });
      return reply.code(201).send({ user: member });
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505') throw new Problem(409, 'DUPLICATE', '账号已存在，请更换用户名');
      if (pg.code === '23514') throw new Problem(422, 'USERNAME', '账号至少3个字符（中文按字计算）');
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/system/users/:id', { preHandler: guard }, async (request) => {
    const body = request.body as Row;
    const current = actor(request);
    assertPoint(current, 'system.account');
    if (!/^[0-9a-fA-F-]{36}$/.test(request.params.id)) throw new Problem(404, 'USER_NOT_FOUND', '账号不存在');
    // 只能改本企业的账号（以前改密码不检查，能改到其他企业的人）
    const member = await services.database.identity(services.context(request), async (sql) => {
      await toIdentity(sql);
      return (await sql.query<{ role: string }>('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [current.tenant_id, request.params.id])).rows[0];
    });
    if (!member) throw new Problem(404, 'USER_NOT_FOUND', '账号不存在');
    const chosen = userPointsFromBody(body);
    if (!unrestricted(current)) {
      const touchesAccess = chosen !== undefined || body.custom_role_id !== undefined || body.active !== undefined || (body.password !== undefined && body.password !== null && body.password !== '');
      if (member.role === 'admin') throw new Problem(403, 'ADMIN_PROTECTED', '企业管理员的账号只能由管理员本人或其他管理员修改');
      if (request.params.id === current.user_id && touchesAccess) throw new Problem(403, 'SELF_EDIT', '不能修改自己的权限、角色、状态或密码（密码请在「个人中心」修改）');
      if (touchesAccess) {
        // 对方现有权限比自己大时，不能改他的密码/状态/权限（防止借重置密码接管更高权限的账号）
        const theirs = await services.database.tenant(services.context(request), async (sql) => {
          const row = (await sql.query<{ user_points: unknown; user_point_scopes: unknown; custom_role_id: string | null }>('SELECT user_points,user_point_scopes,custom_role_id FROM tenant_member_profiles WHERE user_id=$1', [request.params.id])).rows[0];
          const own = asStringList(row?.user_points);
          if (own) return { points: own, scopes: asScopes(row?.user_point_scopes) };
          return row?.custom_role_id ? await rolePoints(sql, row.custom_role_id) : null;
        });
        try { if (theirs) assertCanGrant(current, theirs.points, theirs.scopes); } catch { throw new Problem(403, 'TARGET_HIGHER', '这个账号的权限比你多，只能由管理员修改'); }
      }
    }
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      const password = String(body.password);
      if (password.length < 6) throw new Problem(422, 'PASSWORD', '密码至少6位');
      if (password.length > 128) throw new Problem(422, 'PASSWORD', '密码不能超过128位');
      // 同一个账号可能同时属于多个企业：在这里改密码会影响其他企业，不允许
      const tenantCount = await services.database.auth(async (sql) => Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM memberships WHERE user_id=$1', [request.params.id])).rows[0]!.n));
      if (tenantCount > 1) throw new Problem(409, 'SHARED_ACCOUNT', '这个账号同时属于其他企业，不能在这里改密码，请让本人在「个人中心」修改');
      const hash = await hashPassword(password);
      await services.database.identity(services.context(request), async (sql) => { await sql.query('SELECT kgd_set_password($1,$2)', [request.params.id, hash]); });
      // 改密码后旧的登录全部失效
      await services.database.auth((sql) => sql.query('DELETE FROM sessions WHERE user_id=$1', [request.params.id]));
    }
    await services.database.identity(services.context(request), async (sql) => {
      if (body.active === false) {
        await toIdentity(sql);
        await sql.query('UPDATE memberships SET active=false WHERE user_id=$1 AND tenant_id=$2', [request.params.id, current.tenant_id]);
        await sql.exec('SET LOCAL ROLE gd_auth');
        await sql.query('DELETE FROM sessions WHERE user_id=$1 AND tenant_id=$2', [request.params.id, current.tenant_id]);
      } else if (body.active === true) {
        await toIdentity(sql);
        await sql.query('UPDATE memberships SET active=true WHERE user_id=$1 AND tenant_id=$2', [request.params.id, current.tenant_id]);
      }
      await toTenant(sql);
      if (!unrestricted(current) && (chosen !== undefined || body.custom_role_id !== undefined)) {
        // 最终生效的权限：单独勾选的，否则是（新）角色的
        const roleId = body.custom_role_id ?? (await sql.query<{ custom_role_id: string | null }>('SELECT custom_role_id FROM tenant_member_profiles WHERE user_id=$1', [request.params.id])).rows[0]?.custom_role_id;
        const granted = chosen ?? (chosen === undefined && body.custom_role_id === undefined ? null : await rolePoints(sql, roleId));
        if (granted) assertCanGrant(current, granted.points, granted.scopes);
      }
      const points = chosen === undefined ? undefined : chosen === null ? null : chosen.points;
      const scopes = chosen === undefined ? undefined : chosen === null ? {} : chosen.scopes;
      await sql.query(`UPDATE tenant_member_profiles SET display_name=COALESCE($1,display_name),phone=COALESCE($2,phone),department_id=COALESCE($3,department_id),custom_role_id=COALESCE($4,custom_role_id),
        user_points=CASE WHEN $5::boolean THEN $6::jsonb ELSE user_points END,
        user_point_scopes=CASE WHEN $7::boolean THEN $8::jsonb ELSE user_point_scopes END,
        version=version+1,updated_at=now() WHERE user_id=$9`, [
        body.display_name ? text(body.display_name, 80, '姓名') : null,
        body.phone === undefined ? null : text(body.phone, 20, '手机'),
        body.department_id === undefined ? null : body.department_id,
        body.custom_role_id === undefined ? null : body.custom_role_id,
        points !== undefined, points === null ? null : JSON.stringify(points ?? []),
        scopes !== undefined, JSON.stringify(scopes ?? {}),
        request.params.id,
      ]);
      if (Array.isArray(body.team_ids)) {
        await sql.query('DELETE FROM kgd_team_members WHERE user_id=$1', [request.params.id]);
        for (const teamId of body.team_ids.map(String)) await sql.query('INSERT INTO kgd_team_members(tenant_id,team_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [current.tenant_id, teamId, request.params.id]);
      }
    });
    noteOp(request, body.active === false ? '停用用户' : '修改用户');
    return { ok: true };
  });
}
