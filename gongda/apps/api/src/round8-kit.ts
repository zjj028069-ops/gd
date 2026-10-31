import type { FastifyRequest } from 'fastify';
import type { Sql } from './database.js';
import { permit } from './business-common.js';
import { Problem, requireAllScope, type Actor, type Services } from './services.js';

export function num(value: unknown) {
  const text = String(value ?? '0');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0';
}

export function clean(value: unknown, max: number, label: string, required = false, kind: 'input' | 'select' = 'input') {
  const text = String(value ?? '').trim();
  if (required && !text) throw new Problem(422, 'REQUIRED', kind === 'select' ? `请选择${label}` : `请填写${label}`, labelField(label));
  if (text.length > max) throw new Problem(422, 'TOO_LONG', `${label}不能超过${max}个字`, labelField(label));
  return text;
}

function labelField(label: string) {
  const map: Record<string, string> = {
    工序: 'process_id', 采购单: 'purchase_order_id', 商品: 'product_id', 外协工单: 'outsource_order_id',
    维修设备: 'device_id', 责任部门: 'department_name', 问题分类: 'category', 会议形式: 'form',
    机台类别: 'category_id', 设备类别: 'category_id', 团队: 'team_name',
  };
  return map[label];
}

export function qtyOf(value: unknown, label = '数量') {
  const text = clean(value, 40, label, true);
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(text)) throw new Problem(422, 'QTY', `${label}格式不正确`);
  return text;
}

export async function serial(sql: Sql, tenantId: string, series: string, prefix: string) {
  const row = (await sql.query<{ value: number }>(
    `INSERT INTO r8_counters(tenant_id,series,value) VALUES($1,$2,1)
     ON CONFLICT (tenant_id,series) DO UPDATE SET value=r8_counters.value+1 RETURNING value`,
    [tenantId, series],
  )).rows[0]!;
  return `${prefix}${String(row.value).padStart(4, '0')}`;
}

export async function withTenant<T>(services: Services, request: FastifyRequest, permission: string, work: (sql: Sql, actor: Actor) => Promise<T>) {
  const hook = services.authorize() as unknown as (request: FastifyRequest, reply: unknown, done: () => void) => Promise<void>;
  await hook(request, {}, () => undefined);
  return services.database.tenant(services.context(request), async (sql) => {
    const actor = services.actor(request);
    requireAllScope(actor);
    permit(actor, permission);
    return work(sql, actor);
  });
}

export function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function shift(iso: string, days: number) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function periodRange(period: string) {
  const today = shanghaiToday();
  const [year, month, day] = today.split('-').map(Number);
  if (period === '昨天') { const d = shift(today, -1); return { from: d, to: d }; }
  if (period === '今天' || !period) return { from: today, to: today };
  if (period === '本周') {
    const weekday = new Date(`${today}T12:00:00+08:00`).getUTCDay();
    const monday = shift(today, -((weekday + 6) % 7));
    return { from: monday, to: today };
  }
  if (period === '本月') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (period === '本季度') {
    const q = Math.floor((month! - 1) / 3) * 3 + 1;
    return { from: `${year}-${String(q).padStart(2, '0')}-01`, to: today };
  }
  if (period === '本年') return { from: `${year}-01-01`, to: today };
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return { from: period, to: period };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

export function bodyOf(request: FastifyRequest) {
  return (request.body ?? {}) as Record<string, unknown>;
}

export function idOf(request: FastifyRequest) {
  return (request.params as { id: string }).id;
}
