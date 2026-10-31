import type { FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { gateTenantWrite } from './assets.js';
import { permit } from './business-common.js';
import { Problem, requireAllScope, type Actor, type Services } from './services.js';

export type Row = Record<string, unknown>;
type Work<T> = (sql: Sql, actor: Actor) => Promise<T>;

async function authenticate(services: Services, request: FastifyRequest) {
  const hook = services.authorize() as unknown as (request: FastifyRequest, reply: unknown, done: () => void) => Promise<void>;
  await hook(request, {}, () => undefined);
}

/** 任何已登录成员都可访问；写操作仍检查企业服务状态。 */
export async function member<T>(services: Services, request: FastifyRequest, write: boolean, work: Work<T>) {
  await authenticate(services, request);
  return services.database.tenant(services.context(request), async (sql) => {
    if (write) await gateTenantWrite(sql, services.context(request));
    return work(sql, services.actor(request));
  });
}

/** 需要全企业数据范围和指定权限；write=true 时先检查企业服务状态。 */
export async function guarded<T>(services: Services, request: FastifyRequest, permission: string, write: boolean, work: Work<T>) {
  await authenticate(services, request);
  return services.database.tenant(services.context(request), async (sql) => {
    const actor = services.actor(request);
    requireAllScope(actor);
    permit(actor, permission);
    if (write) await gateTenantWrite(sql, services.context(request));
    return work(sql, actor);
  });
}

export function text(value: unknown, max: number, label: string, required = false) {
  const raw = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
  if (required && !raw) throw new Problem(422, 'REQUIRED', `请填写${label}`);
  if (raw.length > max) throw new Problem(422, 'TOO_LONG', `${label}不能超过${max}个字`);
  return raw;
}

export function oneOf<T extends string>(value: unknown, options: readonly T[], label: string, fallback?: T): T {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw && fallback !== undefined) return fallback;
  if (!(options as readonly string[]).includes(raw)) throw new Problem(422, 'INVALID_OPTION', `${label}只能是${options.join('、')}`);
  return raw as T;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function idText(value: unknown, label: string, required = false) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    if (required) throw new Problem(422, 'REQUIRED', `请选择${label}`);
    return null;
  }
  if (!uuidPattern.test(raw)) throw new Problem(422, 'INVALID_REFERENCE', `${label}不存在或不属于当前企业`);
  return raw;
}

export function idList(value: unknown, label: string, max = 500) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Problem(422, 'INVALID_LIST', `${label}格式不正确`);
  if (value.length > max) throw new Problem(422, 'TOO_MANY', `${label}最多${max}个`);
  return [...new Set(value.map((item) => idText(item, label, true)!))];
}

export function textList(value: unknown, label: string, maxItems = 20, maxLength = 20) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Problem(422, 'INVALID_LIST', `${label}格式不正确`);
  if (value.length > maxItems) throw new Problem(422, 'TOO_MANY', `${label}最多${maxItems}个`);
  return [...new Set(value.map((item) => text(item, maxLength, label, true)))];
}

export function bool(value: unknown, fallback: boolean) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === '是' || value === 'true' || value === 1) return true;
  if (value === '否' || value === 'false' || value === 0) return false;
  throw new Problem(422, 'INVALID_BOOLEAN', '开关值格式不正确');
}

export function intIn(value: unknown, min: number, max: number, label: string, fallback?: number) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Problem(422, 'INVALID_NUMBER', `${label}须为${min}到${max}的整数`);
  return n;
}

export function decimalText(value: unknown, label: string, scale = 6, allowZero = true) {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!new RegExp(`^(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,${scale}})?$`).test(raw)) throw new Problem(422, 'NUMBER_FORMAT', `${label}须为非负数，最多${scale}位小数`);
  if (!allowZero && Number(raw) === 0) throw new Problem(422, 'NUMBER_FORMAT', `${label}必须大于0`);
  return raw;
}

export function dateText(value: unknown, label: string, required = false) {
  const raw = typeof value === 'string' ? value.trim().slice(0, 10) : '';
  if (!raw) {
    if (required) throw new Problem(422, 'REQUIRED', `请选择${label}`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw + 'T00:00:00Z'))) throw new Problem(422, 'INVALID_DATE', `${label}不是有效日期`);
  return raw;
}

export function timeText(value: unknown, label: string, required = false) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    if (required) throw new Problem(422, 'REQUIRED', `请选择${label}`);
    return null;
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw) ? raw.replace(' ', 'T') + (raw.length === 16 ? ':00' : '') + '+08:00' : raw;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Problem(422, 'INVALID_TIME', `${label}不是有效时间`);
  return parsed.toISOString();
}

export function pageOf(query: Row, fallbackSize = 30) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const size = Math.min(200, Math.max(1, Number.parseInt(String(query.page_size ?? fallbackSize), 10) || fallbackSize));
  return { page, size, offset: (page - 1) * size };
}

export function like(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? `%${raw.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
}

export const shanghaiTime = (column: string) => `to_char(${column} AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS')`;
export const shanghaiDate = (column: string) => `to_char(${column} AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')`;

export function numText(value: unknown) {
  const raw = String(value ?? '0');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  return raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
}

export async function pushMessage(sql: Sql, tenantId: string, userId: string, message: { kind: 'alarm' | 'todo' | 'notice' | 'follow' | 'bulletin'; title: string; body: string; objectType?: string; objectId?: string | null; docCode?: string; linkPath?: string; dedupeKey?: string }) {
  const inserted = await sql.query(
    `INSERT INTO kgd_messages(tenant_id,user_id,kind,title,body,object_type,object_id,doc_code,link_path,dedupe_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id,dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [tenantId, userId, message.kind, message.title.slice(0, 200), message.body.slice(0, 2000), message.objectType ?? '', message.objectId ?? null, message.docCode ?? '', message.linkPath ?? '', message.dedupeKey ?? null],
  );
  return inserted.rows.length > 0;
}

export async function counter(sql: Sql, tenantId: string, series: string) {
  return (await sql.query<{ value: number }>(
    `INSERT INTO r8_counters(tenant_id,series,value) VALUES($1,$2,1)
     ON CONFLICT (tenant_id,series) DO UPDATE SET value=r8_counters.value+1 RETURNING value`,
    [tenantId, series],
  )).rows[0]!.value;
}

/** 编号：前缀 + 年月日 + 3 位流水（按天重置）。 */
export async function dailyCode(sql: Sql, tenantId: string, prefix: string) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()).replace(/-/g, '');
  const value = await counter(sql, tenantId, `${prefix}:${day}`);
  return `${prefix}${day}${String(value).padStart(3, '0')}`;
}

export function requireVersion(row: { version?: unknown } | undefined, version: unknown, label: string) {
  if (!row) throw new Problem(404, 'NOT_FOUND', `${label}不存在`);
  if (version !== undefined && version !== null && Number(version) !== Number(row.version)) throw new Problem(409, 'VERSION_CONFLICT', `${label}已被修改，请刷新后重试`);
}
