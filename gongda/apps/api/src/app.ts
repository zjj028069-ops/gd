import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Database } from './database.js';
import { Problem, defaultPermissions, productScope, type Actor } from './services.js';
import {registerLocalEvents} from './local-events.js';
import {registerPlatform} from './platform.js';
import {registerConfiguration} from './configuration.js';
import {registerAssets,gateTenantWrite} from './assets.js';
import { registerMasters } from './masters.js';
import { registerPreview } from './design-preview.js';
import { registerProduction } from './production.js';
import { registerWageLine } from './wage-line.js';
import { registerCorrections } from './production-corrections.js';
import { registerMoney } from './money.js';
import { registerBusiness } from './business.js';
import { registerExpenses } from './expenses.js';
import { registerReports } from './reports.js';
import { registerWarehouseOperations } from './warehouse-operations.js';
import { registerWarehouse } from './warehouse.js';
import { registerWarehouseExtra } from './warehouse-extra.js';
import { validationResult } from './validation-message.js';
import { registerGoods } from './goods.js';
import { registerProgress } from './progress.js';
import { registerScreens } from './screens.js';
import { registerReportCenter } from './report-center.js';
import { registerAudit } from './audit-engine.js';
import { registerSystemAdmin } from './system-admin.js';
import { registerOperationLog } from './operation-log.js';
import { registerQuality } from './quality.js';
import { registerOutsource } from './outsource.js';
import { registerMachineStation } from './machine-station.js';
import { registerReportBiz } from './report-biz.js';
import { registerLean } from './lean.js';
import { registerIot } from './iot.js';
import { registerEquip } from './equip.js';
import { registerReportWorkbench } from './report-workbench.js';
import { registerWorkplace } from './workplace.js';
import { registerCrmFollow } from './crm-follow.js';
import { registerInfoCenter } from './info-center.js';
import { registerPurchaseSettings } from './purchase-settings.js';
import { registerSystemSettings } from './system-settings.js';
import { registerReportExtra } from './report-extra.js';
import { registerProduceExtra } from './produce-extra.js';
import { registerAiTrain } from './ai-train.js';
import { registerSbot } from './sbot.js';
import { registerPlatformConsole } from './platform-console.js';
import { registerAi } from './ai/register.js';
import { registerCrmContacts } from './crm-contacts.js';
import { registerRound11Messages } from './round11-messages.js';
import { registerPerformancePay } from './performance-pay.js';
import { registerAutoStock } from './auto-stock.js';
import { registerProduceSettings } from './produce-settings.js';
import { registerMaterialAnalysis } from './material-analysis.js';
import { registerEntityExtensions } from './entity-extensions.js';
import { asScopes, asStringList, derivePermissions, loadTeamUserIds } from './kgd-permissions.js';
export { Problem } from './services.js';
import { hashPassword, verifyPassword, tokenHash, secretToken, safeEqual } from './passwords.js';

type Role = 'admin' | 'planner' | 'worker';
type Session = Actor & { token_hash: string; csrf_token: string; tenant_id: string; user_id: string; role: Role; tenant_name: string; tenant_slug: string; display_name: string; expires_at: string };
const unitId = { type: 'string', format: 'uuid' };
const sessionSelect = 'SELECT s.token_hash,s.csrf_token,s.tenant_id,s.user_id,s.expires_at,m.role,t.name AS tenant_name,t.slug AS tenant_slug,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND t.active AND m.active';
const publicSession = (session: Session) => ({
  csrf_token: session.csrf_token,
  user: { id: session.user_id, display_name: session.display_name },
  tenant: { id: session.tenant_id, name: session.tenant_name, slug: session.tenant_slug },
  role: session.role, permissions:session.permissions,data_scope:session.data_scope,department_id:session.department_id,points:session.points,point_scopes:session.point_scopes,expires_at: session.expires_at,
});
export async function createApp(database: Database, options: { production?: boolean; origin?: string; extraOrigins?: string[]; mobileBase?: string; logger?: boolean; trustedProxy?: string[]; localEventsWorker?:boolean } = {}) {
  await database.assertSecurityConfiguration();
  const production = options.production ?? false;
  const cookieName = production ? '__Host-gd_session' : 'gd_session';
  const origin = options.origin ?? 'http://127.0.0.1:5173';
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    trustProxy: options.trustedProxy ?? false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    logger: options.logger ? { level: 'info', redact: ['req.headers.authorization','req.headers.cookie','req.body.password','req.body.content_base64','res.headers.set-cookie'] } : false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const sessions = new WeakMap<FastifyRequest, Session>();
  const dummyHash = await hashPassword(secretToken());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store');
    if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.origin && request.headers.origin !== origin && !(options.extraOrigins ?? []).includes(request.headers.origin)) {
      // 理由：云端预览 / Cloudflare quick tunnel 的 Origin 不是 PUBLIC_ORIGIN；非生产放行本机与 *.trycloudflare.com
      const incoming = request.headers.origin;
      let allowed = false;
      if (!production) {
        try {
          const host = new URL(incoming).hostname;
          allowed = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.trycloudflare.com');
        } catch { /* 非法 Origin 仍拒绝 */ }
      }
      if (!allowed) throw new Problem(403,'ORIGIN_REJECTED','请求来源不被允许');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Problem) return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } });
    const knownError = error as { validation?: unknown; statusCode?: number; code?: string };
    if (knownError.validation) {
      const validated = validationResult(request.url, knownError.validation);
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: validated.message, ...(validated.field ? { field: validated.field } : {}) } });
    }
    const code = knownError.code;
    if (code === '23505') {
      const constraint = String((error as { constraint?: string }).constraint ?? '');
      const message = constraint.includes('users_username') ? '账号已存在，请更换用户名' : '本企业内已存在相同编码';
      return reply.code(409).send({ error: { code: 'DUPLICATE', message } });
    }
    if (code === '23514') {
      const constraint = String((error as { constraint?: string }).constraint ?? '');
      const message = constraint.includes('users_username') ? '账号至少3个字符（中文按字计算）' : '提交内容不符合数据约束';
      return reply.code(422).send({ error: { code: 'CHECK_VIOLATION', message } });
    }
    if (code === '23503') return reply.code(422).send({ error: { code: 'INVALID_REFERENCE', message: '关联资料不存在或不属于当前企业' } });
    if (knownError.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '操作频繁，请稍后重试' } });
    if (knownError.statusCode === 413) return reply.code(413).send({ error: { code: 'BODY_TOO_LARGE', message: '请求内容过大' } });
    if (knownError.statusCode === 400) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: '请求内容格式不正确' } });
    request.log.error({ err: error }, '请求处理失败');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务暂时无法处理请求' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
  const decorate = async (session:Session):Promise<Session> => database.tenant({tenantId:session.tenant_id,userId:session.user_id},async sql=>{
    const profile=(await sql.query<{display_name:string;department_id:string|null;custom_role_id:string|null;permissions:string[]|null;data_scope:Actor['data_scope']|null;active:boolean|null;kgd_points:unknown;point_scopes:unknown;user_points:unknown;user_point_scopes:unknown}>('SELECT p.display_name,p.department_id,p.custom_role_id,p.user_points,p.user_point_scopes,r.permissions,r.data_scope,r.active,r.kgd_points,r.point_scopes FROM tenant_member_profiles p LEFT JOIN tenant_roles r ON r.tenant_id=p.tenant_id AND r.id=p.custom_role_id WHERE p.user_id=$1',[session.user_id])).rows[0];
    const custom=session.role!=='admin'&&profile?.custom_role_id;
    const rolePoints=asStringList(profile?.kgd_points);
    const userPoints=asStringList(profile?.user_points);
    const points=custom&&profile?.active?(userPoints??rolePoints):null;
    const pointScopes=points?{...asScopes(profile?.point_scopes),...(userPoints?asScopes(profile?.user_point_scopes):{})}:{};
    const permissions=!custom?defaultPermissions(session.role):!profile?.active?[]:points?derivePermissions(points):profile?.permissions??[];
    const dataScope:Actor['data_scope']=!custom||points?'all':profile?.data_scope??'all';
    const teamUserIds=await loadTeamUserIds(sql,session.user_id);
    return {...session,display_name:profile?.display_name??session.display_name,department_id:profile?.department_id??null,permissions,data_scope:dataScope,points,point_scopes:pointScopes,team_user_ids:teamUserIds};
  });
  const authorize = (roles: Role[] = ['admin','planner','worker']) => async (request: FastifyRequest) => {
    const token = request.cookies[cookieName];
    if (!token || token.length > 100) throw new Problem(401,'UNAUTHENTICATED','请先登录');
    const raw = await database.auth(async (sql) => (await sql.query<Session>(sessionSelect,[tokenHash(token)])).rows[0]);
    if (!raw) throw new Problem(401,'UNAUTHENTICATED','登录已失效，请重新登录');
    const session=await decorate(raw),path=request.url.split('?')[0]!;
    const master=/^\/api\/(products|units|processes|routes|route-versions|boms|bom-versions|team-members)(\/|$)/.test(path);
    const business=/^\/api\/(customers|warehouses|sales-orders|work-orders|production-reports|production-tasks|payroll-statement|material-issues|fg-receipts|shipments|stock-adjustments|inspections|stock)(\/|$)/.test(path);
    const action=master?(['GET','HEAD'].includes(request.method)?'master.read':'master.write'):path==='/api/audit-events'?'audit.read':path==='/api/overview'||path.startsWith('/api/design-preview')?'master.read':null;
    if(action?!session.permissions.includes(action):!roles.includes(session.role))throw new Problem(403,'FORBIDDEN','当前角色没有操作权限');
    if(session.data_scope!=='all'&&(business||(master&&path!=='/api/products'&&!path.startsWith('/api/products/')&&path!=='/api/units'&&path!=='/api/team-members')||action==='master.write'||action==='audit.read'||path.startsWith('/api/design-preview')))throw new Problem(403,'DATA_SCOPE_UNSUPPORTED','当前功能尚需全企业数据范围');
    if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !safeEqual(csrf,session.csrf_token)) throw new Problem(403,'CSRF_REJECTED','操作校验失败，请刷新后重试');
    }
    sessions.set(request,session);
  };
  const requirePermission=(permission:string)=>async(request:FastifyRequest)=>{await authorize()(request);if(!sessions.get(request)!.permissions.includes(permission))throw new Problem(403,'FORBIDDEN','当前角色没有操作权限');};
  const context = (request: FastifyRequest) => {
    const session = sessions.get(request)!;
    return { tenantId: session.tenant_id, userId: session.user_id };
  };
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request,reply) => {
    try { await database.auth((sql) => sql.query('SELECT 1')); return { status: 'ok' }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  // 二维码里用的手机访问地址（不涉及任何业务数据）
  app.get('/api/mobile/config', async () => ({ base: options.mobileBase || null }));
  app.post<{ Body: { tenant_slug: string; username: string; password: string } }>('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type:'object', additionalProperties:false, required:['tenant_slug','username','password'], properties: {
      tenant_slug: { type:'string',pattern:'^[a-z0-9][a-z0-9-]{1,62}$' },
      username: { type:'string',minLength:3,maxLength:80 },
      password: { type:'string',minLength:1,maxLength:128 },
    } } },
  }, async (request,reply) => {
    const body = request.body;
    const user = await database.auth(async (sql) => (await sql.query<{ id:string; tenant_id:string; password_hash:string }>('SELECT u.id,u.password_hash,t.id AS tenant_id FROM users u JOIN memberships m ON m.user_id=u.id JOIN tenants t ON t.id=m.tenant_id WHERE u.username=$1 AND t.slug=$2 AND u.active AND m.active AND t.active',[body.username,body.tenant_slug])).rows[0]);
    const valid = await verifyPassword(body.password,user?.password_hash ?? dummyHash);
    if (!user || !valid) throw new Problem(401,'INVALID_CREDENTIALS','企业、账号或密码不正确');
    const token = secretToken(), csrf = secretToken();
    const session = await database.auth(async (sql) => {
      await sql.query('DELETE FROM sessions WHERE expires_at<=now()');
      await sql.query("INSERT INTO sessions(token_hash,csrf_token,user_id,tenant_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')",[tokenHash(token),csrf,user.id,user.tenant_id]);
      return (await sql.query<Session>(sessionSelect,[tokenHash(token)])).rows[0]!;
    });
    reply.setCookie(cookieName,token,{ path:'/', httpOnly:true, secure:production, sameSite:'lax', maxAge:8*3600 });
    return publicSession(await decorate(session));
  });
  app.get('/api/auth/me',{ preHandler:authorize() },async (request) => publicSession(sessions.get(request)!));
  app.post<{Body:{tenant_id:string}}>('/api/auth/switch-tenant',{preHandler:authorize(),schema:{body:{type:'object',additionalProperties:false,required:['tenant_id'],properties:{tenant_id:unitId}}}},async(request,reply)=>{
    const current=sessions.get(request)!,token=secretToken(),csrf=secretToken();
    const next=await database.auth(async sql=>{
      const own=(await sql.query('SELECT t.id FROM memberships m JOIN tenants t ON t.id=m.tenant_id JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.tenant_id=$2 AND m.active AND t.active AND u.active',[current.user_id,request.body.tenant_id])).rows[0];
      if(!own)throw new Problem(403,'TENANT_NOT_AUTHORIZED','没有该企业的有效成员资格');
      await sql.query('DELETE FROM sessions WHERE token_hash=$1',[current.token_hash]);
      await sql.query("INSERT INTO sessions(token_hash,csrf_token,user_id,tenant_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')",[tokenHash(token),csrf,current.user_id,request.body.tenant_id]);
      return (await sql.query<Session>(sessionSelect,[tokenHash(token)])).rows[0]!;
    });
    reply.setCookie(cookieName,token,{path:'/',httpOnly:true,secure:production,sameSite:'lax',maxAge:8*3600});return publicSession(await decorate(next));
  });
  app.post('/api/auth/logout',{ preHandler:authorize() },async (request,reply) => {
    await database.auth((sql) => sql.query('DELETE FROM sessions WHERE token_hash=$1',[sessions.get(request)!.token_hash]));
    reply.clearCookie(cookieName,{ path:'/', secure:production, httpOnly:true, sameSite:'lax' });
    return { ok:true };
  });

  app.get('/api/audit-events',{preHandler:authorize(['admin','planner'])},async (request) => database.tenant(context(request),async (sql) => {
    const a=sessions.get(request)!,hidden:string[]=[];
    if(!a.permissions.includes('organization.manage'))hidden.push('member','role','department','workshop','line','tenant');
    if(!a.permissions.includes('configuration.manage'))hidden.push('field_schema','number_rule','user_view','event_rule','calendar');
    if(!a.permissions.includes('tenant_service.manage'))hidden.push('tenant_service');
    if(!a.permissions.includes('payroll.read'))hidden.push('wage_rule','wage_settlement','rework_report');
    if(!a.permissions.includes('finance.read'))hidden.push('payment','expense','transfer','count');
    if(!a.permissions.includes('inventory.read'))hidden.push('transfer','count');
    if(!a.permissions.includes('procurement.read'))hidden.push('supplier','purchase_order','purchase_receipt');
    return {items:(await sql.query('SELECT id,action,entity_type,entity_id,actor_name,before_data,after_data,created_at FROM audit_events WHERE NOT(entity_type=ANY($1::text[])) ORDER BY created_at DESC,id LIMIT 100',[hidden])).rows};
  }));
  app.get('/api/overview',{preHandler:authorize()},async (request) => database.tenant(context(request),async (sql) => {
    const scope=productScope(sessions.get(request)!,'p');
    const counts=(await sql.query<{products:string;units:string}>('SELECT (SELECT count(*) FROM products p WHERE '+scope.clause+')::text AS products,(SELECT count(*) FROM units)::text AS units',scope.params)).rows[0]!;
    const auditEvents=!sessions.get(request)!.permissions.includes('audit.read')||sessions.get(request)!.data_scope!=='all' ? null : Number((await sql.query<{count:string}>('SELECT count(*)::text AS count FROM audit_events')).rows[0]!.count);
    const session=sessions.get(request)!;
    const workOrders=session.permissions.includes('production.read')&&session.data_scope==='all'?Number((await sql.query<{count:string}>('SELECT count(*)::text AS count FROM work_orders')).rows[0]!.count):null;
    return {products:Number(counts.products),units:Number(counts.units),audit_events:auditEvents,work_orders:workOrders,stage:'production_mainline'};
  }));
  const services = {database,authorize,requirePermission,context,actor:(request:FastifyRequest)=>sessions.get(request)!};
  registerLocalEvents(app,services,{worker:options.localEventsWorker});
  registerPlatform(app,services,{allowTenantCreation:!production});
  registerConfiguration(app,services);
  registerAssets(app,services,{allowServiceConfiguration:!production});
  registerMasters(app,services);
  registerPreview(app,services);
  registerProduction(app,services);
  registerWageLine(app,services);
  registerBusiness(app,services);
  registerExpenses(app,services);
  registerReports(app,services);
  registerWarehouseOperations(app,services);
  registerWarehouse(app,services);
  registerWarehouseExtra(app,services);
  registerCorrections(app,services);
  registerMoney(app,services);
  registerGoods(app,services);
  registerProgress(app,services);
  registerScreens(app,services);
  registerReportCenter(app,services);
  registerAudit(app,services);
  registerSystemAdmin(app,services);
  registerOperationLog(app,services);
  registerQuality(app,services);
  registerOutsource(app,services);
  registerMachineStation(app,services);
  registerReportBiz(app,services);
  registerLean(app,services);
  registerIot(app,services);
  registerEquip(app,services);
  registerReportWorkbench(app,services);
  registerWorkplace(app,services);
  registerCrmFollow(app,services);
  registerInfoCenter(app,services);
  registerPurchaseSettings(app,services);
  registerSystemSettings(app,services);
  registerReportExtra(app,services);
  registerProduceExtra(app,services);
  registerAiTrain(app,services);
  registerAi(app,services);
  registerSbot(app,services,{cookieName,csrf:(request)=>sessions.get(request)!.csrf_token});
  registerPlatformConsole(app,database,{production});
  registerCrmContacts(app,services);
  registerRound11Messages(app,services);
  registerPerformancePay(app,services);
  registerAutoStock(app,services);
  registerProduceSettings(app,services);
  registerMaterialAnalysis(app,services);
  registerEntityExtensions(app,services);
  return app;
}







