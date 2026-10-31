import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { pendingApproverIds } from './kgd-permissions.js';
import { Problem, type Actor, type Services } from './services.js';
import { syncFollowReminders } from './crm-follow.js';
import { syncPurchaseReminders } from './purchase-settings.js';
import { latestNotices } from './info-center.js';
import { member, shanghaiTime, type Row } from './r10-kit.js';
import { floorPercent, q, qtyText } from './progress-calc.js';

/** 原版「添加组件」18 项。分类计数：全部 18 / 通用 4 / 工作效率 2 / 智能报表 12。 */
const cardCatalog = [
  { key: 'shortcuts', name: '快捷入口', category: '工作效率', stub: false },
  { key: 'tutorial', name: '3天快速落地教程', category: '通用', stub: false },
  { key: 'todos', name: '待办事项', category: '工作效率', stub: false },
  { key: 'features', name: '功能上新', category: '通用', stub: false },
  { key: 'notices', name: '公告', category: '通用', stub: false },
  { key: 'messages', name: '未读消息', category: '通用', stub: false },
  { key: 'maint_month', name: '当月维保任务执行概况', category: '智能报表', stub: false, uncaptured: true },
  { key: 'devices', name: '设备概况', category: '智能报表', stub: false },
  { key: 'defect_dist', name: '当月不良品分布', category: '智能报表', stub: false, uncaptured: true },
  { key: 'stock_alert', name: '库存预警', category: '智能报表', stub: false, uncaptured: true },
  { key: 'service_trend', name: '服务工单走势', category: '智能报表', stub: false },
  { key: 'sales_rank', name: '当月销售业绩排行', category: '智能报表', stub: false, uncaptured: true },
  { key: 'follow_rank', name: '当月跟单排行', category: '智能报表', stub: false, uncaptured: true },
  { key: 'product_output', name: '当月产品产量', category: '智能报表', stub: false, uncaptured: true },
  { key: 'sluggish_alert', name: '呆滞预警', category: '智能报表', stub: false, uncaptured: true },
  { key: 'production_stats', name: '生产状况统计', category: '智能报表', stub: false, uncaptured: true },
  { key: 'wo_progress', name: '工单执行进度', category: '智能报表', stub: false, uncaptured: true },
  { key: 'material_suggest', name: '本月备料建议', category: '智能报表', stub: false, uncaptured: true },
] as const;

type CardKey = (typeof cardCatalog)[number]['key'];

/** 错名 / 旧 key → 原版 key；映射到 null 表示丢弃。 */
const cardKeyMigrate: Record<string, CardKey | null> = {
  banner: 'tutorial',
  today_report: null,
  process_progress: 'wo_progress',
  contract_overview: null,
  follow_remind: 'follow_rank',
  maint_remind: 'maint_month',
  report_rank: null,
  device_oee: 'devices',
  sales_brief: 'sales_rank',
  production_brief: 'production_stats',
  service_brief: 'service_trend',
  custom_smart: null,
};

const shortcutCatalog = [
  { key: 'customer_add', name: '新增客户', group: '客户管理' },
  { key: 'follow_add', name: '快捷跟单', group: '客户管理' },
  { key: 'contract_add', name: '新增合同', group: '客户管理' },
  { key: 'invoice_apply', name: '申请开票', group: '客户管理' },
  { key: 'work_order_add', name: '创建加工单', group: '生产管理' },
  { key: 'fg_receipt_add', name: '成品入库', group: '生产管理' },
  { key: 'process_add', name: '新增工序', group: '生产管理' },
  { key: 'defect_add', name: '新增不良品项', group: '生产管理' },
  { key: 'route_add', name: '新增工艺路线', group: '生产管理' },
  { key: 'service_order_add', name: '创建服务工单', group: '服务工单' },
  { key: 'service_product_add', name: '新增产品', group: '服务工单' },
  { key: 'service_item_add', name: '新增服务项目', group: '服务工单' },
  { key: 'device_add', name: '新增设备', group: '维保管理' },
  { key: 'maint_plan_add', name: '创建维保计划', group: '维保管理' },
  { key: 'maint_content_add', name: '新增维保内容', group: '维保管理' },
  { key: 'repair_order_add', name: '创建维修工单', group: '维保管理' },
  { key: 'purchase_plan_add', name: '创建采购计划', group: '仓库管理' },
  { key: 'purchase_order_add', name: '创建采购单', group: '仓库管理' },
  { key: 'purchase_in_add', name: '采购入库', group: '仓库管理' },
  { key: 'other_in_add', name: '其他入库', group: '仓库管理' },
  { key: 'sale_out_add', name: '销售出库', group: '仓库管理' },
  { key: 'other_out_add', name: '其他出库', group: '仓库管理' },
  { key: 'transfer_add', name: '创建调拨单', group: '仓库管理' },
  { key: 'stock_check_add', name: '库存盘点', group: '仓库管理' },
  { key: 'goods_add', name: '新增商品', group: '其他' },
  { key: 'notice_publish', name: '发布公告', group: '其他' },
] as const;

const defaultShortcutKeys = ['customer_add', 'follow_add', 'contract_add', 'invoice_apply', 'work_order_add', 'fg_receipt_add', 'process_add', 'defect_add', 'route_add'] as const;

/** 与前端 shortcutMinH 同一公式：3 列九宫格完整可见。 */
function shortcutMinH(count: number) {
  const rows = Math.max(1, Math.ceil(Math.max(count, 1) / 3));
  const px = 72 + rows * 86;
  return Math.max(5, Math.ceil((px + 12) / 56));
}

const todoPrefKeys = ['pending_contracts', 'pending_invoices', 'maint_tasks', 'repairs_to_accept', 'repairs_to_review'] as const;

const defaultLayoutSizes: Record<CardKey, { w: number; h: number }> = {
  shortcuts: { w: 6, h: shortcutMinH(9) },
  tutorial: { w: 12, h: 2 },
  todos: { w: 6, h: 3 },
  features: { w: 6, h: 3 },
  notices: { w: 6, h: 3 },
  messages: { w: 6, h: 3 },
  maint_month: { w: 6, h: 4 },
  devices: { w: 6, h: 4 },
  defect_dist: { w: 6, h: 4 },
  stock_alert: { w: 6, h: 4 },
  service_trend: { w: 6, h: 4 },
  sales_rank: { w: 6, h: 4 },
  follow_rank: { w: 6, h: 4 },
  product_output: { w: 6, h: 4 },
  sluggish_alert: { w: 6, h: 4 },
  production_stats: { w: 6, h: 4 },
  wo_progress: { w: 6, h: 4 },
  material_suggest: { w: 6, h: 4 },
};

const defaultCardKeys: CardKey[] = ['tutorial', 'shortcuts', 'todos', 'features', 'notices', 'messages', 'devices', 'stock_alert', 'wo_progress'];
const defaultCards = defaultCardKeys.map((key) => ({ key, visible: true }));
const defaultShortcuts = defaultShortcutKeys.filter((key) => shortcutCatalog.some((item) => item.key === key));
const defaultTodoPrefs = Object.fromEntries(todoPrefKeys.map((key) => [key, true])) as Record<(typeof todoPrefKeys)[number], boolean>;
const catalogKeys = new Set<string>(cardCatalog.map((card) => card.key));

type LayoutItem = { key: string; x: number; y: number; w: number; h: number };

function resolveCardKey(raw: string): CardKey | null {
  if (catalogKeys.has(raw)) return raw as CardKey;
  if (Object.prototype.hasOwnProperty.call(cardKeyMigrate, raw)) return cardKeyMigrate[raw] ?? null;
  return null;
}

function defaultLayoutFor(keys: string[]): LayoutItem[] {
  let y = 0;
  let x = 0;
  let rowH = 0;
  const items: LayoutItem[] = [];
  for (const key of keys) {
    const size = defaultLayoutSizes[key as CardKey] ?? { w: 6, h: 3 };
    if (x + size.w > 12) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    items.push({ key, x, y, w: size.w, h: size.h });
    x += size.w;
    rowH = Math.max(rowH, size.h);
  }
  return items;
}

function normalizeCards(value: unknown, { strict = true }: { strict?: boolean } = {}) {
  if (!Array.isArray(value)) throw new Problem(422, 'CARDS', '工作台卡片配置格式不正确');
  const seen = new Set<string>();
  const cards: { key: string; visible: boolean }[] = [];
  for (const raw of value as Row[]) {
    const resolved = resolveCardKey(String(raw?.key ?? ''));
    if (!resolved) {
      if (strict && catalogKeys.has(String(raw?.key ?? ''))) continue;
      if (strict && !Object.prototype.hasOwnProperty.call(cardKeyMigrate, String(raw?.key ?? ''))) {
        throw new Problem(422, 'CARDS', '工作台卡片不存在');
      }
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    cards.push({ key: resolved, visible: raw.visible !== false });
  }
  for (const card of defaultCards) if (!seen.has(card.key)) cards.push({ ...card });
  return cards;
}

function normalizeShortcuts(value: unknown) {
  if (!Array.isArray(value)) throw new Problem(422, 'SHORTCUTS', '快捷入口配置格式不正确');
  const keys = new Set<string>(shortcutCatalog.map((item) => item.key));
  const list = [...new Set(value.map(String))];
  if (list.some((key) => !keys.has(key))) throw new Problem(422, 'SHORTCUTS', '快捷入口不存在');
  return list;
}

function normalizeLayout(value: unknown, cards: { key: string; visible: boolean }[], shortcutCount: number = defaultShortcutKeys.length): LayoutItem[] {
  const visibleKeys = cards.filter((card) => card.visible).map((card) => card.key);
  if (!Array.isArray(value) || !value.length) return defaultLayoutFor(visibleKeys);
  const seen = new Set<string>();
  const items: LayoutItem[] = [];
  for (const raw of value as Row[]) {
    const key = resolveCardKey(String(raw?.key ?? ''));
    if (!key || seen.has(key) || !visibleKeys.includes(key)) continue;
    seen.add(key);
    const fallback = defaultLayoutSizes[key] ?? { w: 6, h: 3 };
    // 快捷入口固定半栏。持久化成更宽时，三列 1fr 会把图标拉开。
    const maxW = key === 'shortcuts' ? 6 : 12;
    const w = Math.min(maxW, Math.max(2, Number(raw.w) || fallback.w));
    const floor = key === 'shortcuts' ? shortcutMinH(shortcutCount) : 1;
    const cap = key === 'shortcuts' ? Math.max(12, floor) : 12;
    const h = Math.min(cap, Math.max(floor, Number(raw.h) || fallback.h));
    const x = Math.min(12 - w, Math.max(0, Number(raw.x) || 0));
    const y = Math.max(0, Number(raw.y) || 0);
    items.push({ key, x, y, w, h });
  }
  for (const key of visibleKeys) {
    if (seen.has(key)) continue;
    const size = defaultLayoutSizes[key as CardKey] ?? { w: 6, h: 3 };
    const maxY = items.reduce((sum, item) => Math.max(sum, item.y + item.h), 0);
    items.push({ key, x: 0, y: maxY, w: size.w, h: size.h });
  }
  return items;
}

function normalizeTodoPrefs(value: unknown) {
  const prefs = { ...defaultTodoPrefs };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefs;
  const raw = value as Row;
  for (const key of todoPrefKeys) {
    if (raw[key] !== undefined) prefs[key] = raw[key] !== false;
  }
  return prefs;
}

async function readConfig(sql: Sql, actor: Actor) {
  const row = (await sql.query<{ cards: unknown; shortcuts: unknown; layout: unknown; todo_prefs: unknown; version: number }>(
    'SELECT cards,shortcuts,COALESCE(layout,\'[]\'::jsonb) AS layout,COALESCE(todo_prefs,\'{}\'::jsonb) AS todo_prefs,version FROM workplace_configs WHERE user_id=$1',
    [actor.user_id],
  )).rows[0];
  const cards = row && Array.isArray(row.cards) && row.cards.length ? normalizeCards(row.cards, { strict: false }) : defaultCards;
  const shortcuts = row && Array.isArray(row.shortcuts) && row.shortcuts.length ? normalizeShortcuts(row.shortcuts) : defaultShortcuts;
  const layout = normalizeLayout(row?.layout, cards, shortcuts.length);
  const todo_prefs = normalizeTodoPrefs(row?.todo_prefs);
  return {
    cards,
    shortcuts,
    layout,
    todo_prefs,
    version: row?.version ?? 0,
    card_catalog: cardCatalog,
    shortcut_catalog: shortcutCatalog,
  };
}

async function count(sql: Sql, statement: string, params: unknown[] = []) {
  return Number((await sql.query<{ n: string }>(statement, params)).rows[0]?.n ?? 0);
}

function qtyOf(value: string | null | undefined) {
  return qtyText(q(value ?? '0'));
}

function monthBoundsTs(column: string) {
  return `(${column} AT TIME ZONE 'Asia/Shanghai')::date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Shanghai')::date)::date
    AND (${column} AT TIME ZONE 'Asia/Shanghai')::date < (date_trunc('month', (now() AT TIME ZONE 'Asia/Shanghai')::date) + interval '1 month')::date`;
}

function monthBoundsDate(column: string) {
  return `${column} >= date_trunc('month', (now() AT TIME ZONE 'Asia/Shanghai')::date)::date
    AND ${column} < (date_trunc('month', (now() AT TIME ZONE 'Asia/Shanghai')::date) + interval '1 month')::date`;
}

/** 原版 18 项中的智能报表 / 有数卡汇总。错名 key 不再返回。 */
async function workplaceWidgets(sql: Sql, actor: Actor) {
  const can = (permission: string) => actor.permissions.includes(permission);
  const prod = can('production.read');
  const sales = can('sales.read');
  const inv = can('inventory.read');

  const maintRows = prod
    ? (await sql.query<{ status: string; n: string }>(
      `SELECT t.status, count(*)::text AS n
       FROM r8_maint_tasks t
       WHERE ${monthBoundsDate('t.task_date')}
       GROUP BY t.status`,
    )).rows
    : [];
  const maintOrder = ['未开始', '进行中', '已完成', '未完成'];
  for (const row of maintRows) if (!maintOrder.includes(row.status)) maintOrder.push(row.status);
  const maintMap = new Map(maintRows.map((row) => [row.status, Number(row.n)]));
  const maintItems = maintOrder.map((status) => ({ status, count: String(maintMap.get(status) ?? 0) }));
  const maintTotal = maintItems.reduce((sum, item) => sum + Number(item.count), 0);

  const defectRows = prod
    ? (await sql.query<{ name: string; qty: string }>(
      `SELECT coalesce(d.name, nullif(r.defect_note,''), '未分类') AS name, count(*)::text AS qty
       FROM production_reports r
       LEFT JOIN r8_report_defects l ON l.report_id=r.id
       LEFT JOIN r8_defect_items d ON d.tenant_id=l.tenant_id AND d.id=l.defect_item_id
       WHERE r.approval='approved' AND r.defect_qty>0 AND ${monthBoundsTs('r.created_at')}
       GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`,
    )).rows
    : [];
  const defectTotal = defectRows.reduce((sum, row) => sum + Number(row.qty), 0);
  const defectItems = defectRows.map((row) => ({
    name: row.name,
    qty: qtyOf(row.qty),
    rate: defectTotal ? `${((Number(row.qty) / defectTotal) * 100).toFixed(1)}%` : '0%',
  }));

  const stockRows = inv
    ? (await sql.query<{ code: string; name: string; on_hand: string; lower: string | null; upper: string | null }>(
      `SELECT p.code, p.name, coalesce(sum(b.on_hand),0)::text AS on_hand, p.stock_lower_warn::text AS lower, p.stock_upper_warn::text AS upper
       FROM products p
       LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id
       WHERE p.active AND (p.stock_lower_warn IS NOT NULL OR p.stock_upper_warn IS NOT NULL)
       GROUP BY p.id, p.code, p.name, p.stock_lower_warn, p.stock_upper_warn
       HAVING (p.stock_lower_warn IS NOT NULL AND coalesce(sum(b.on_hand),0) < p.stock_lower_warn)
          OR (p.stock_upper_warn IS NOT NULL AND coalesce(sum(b.on_hand),0) > p.stock_upper_warn)
       ORDER BY p.code LIMIT 8`,
    )).rows
    : [];
  const stockItems = stockRows.map((row) => ({
    code: row.code,
    name: row.name,
    on_hand: qtyOf(row.on_hand),
    state: row.lower !== null && Number(row.on_hand) < Number(row.lower) ? '低于下限' : '高于上限',
  }));

  const serviceDays = prod
    ? (await sql.query<{ day: string; created: string; done: string }>(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('month', (now() AT TIME ZONE 'Asia/Shanghai')::date)::date,
           ((date_trunc('month', (now() AT TIME ZONE 'Asia/Shanghai')::date) + interval '1 month')::date - 1),
           '1 day'::interval
         )::date AS day
       )
       SELECT to_char(d.day,'YYYY-MM-DD') AS day,
         coalesce((SELECT count(*) FROM r8_repairs r WHERE (r.created_at AT TIME ZONE 'Asia/Shanghai')::date = d.day),0)::text AS created,
         coalesce((SELECT count(*) FROM r8_repairs r WHERE r.status='已完成' AND (coalesce(r.finished_at, r.created_at) AT TIME ZONE 'Asia/Shanghai')::date = d.day),0)::text AS done
       FROM days d ORDER BY d.day`,
    )).rows
    : [];

  const salesRank = sales
    ? (await sql.query<{ name: string; amount: string; count: string }>(
      `SELECT coalesce(m.display_name,'未命名') AS name, coalesce(sum(c.amount),0)::text AS amount, count(*)::text AS count
       FROM money_contracts c
       LEFT JOIN tenant_team_members m ON m.id=c.salesperson_id
       WHERE c.approval IN ('approved','exempt') AND ${monthBoundsTs('c.created_at')}
       GROUP BY m.display_name
       ORDER BY sum(c.amount) DESC, count(*) DESC
       LIMIT 8`,
    )).rows.map((row) => ({ name: row.name, amount: qtyOf(row.amount), count: row.count }))
    : [];

  const followRank = sales
    ? (await sql.query<{ name: string; count: string }>(
      `SELECT coalesce(m.display_name,'未命名') AS name, count(*)::text AS count
       FROM customer_follows f
       LEFT JOIN tenant_team_members m ON m.id=f.follower_id
       WHERE ${monthBoundsTs('f.followed_at')}
       GROUP BY m.display_name
       ORDER BY count(*) DESC, m.display_name
       LIMIT 8`,
    )).rows.map((row) => ({ name: row.name, count: row.count }))
    : [];

  const outputRow = prod
    ? (await sql.query<{ orders: string; qty: string }>(
      `SELECT count(*)::text AS orders, coalesce(sum(plan_qty),0)::text AS qty
       FROM work_orders
       WHERE execution='completed' AND ${monthBoundsTs('coalesce(completed_at, updated_at)')}`,
    )).rows[0]!
    : { orders: '0', qty: '0' };
  const outputItems = prod
    ? (await sql.query<{ name: string; qty: string }>(
      `SELECT coalesce(product_snapshot->>'name','未命名') AS name, coalesce(sum(plan_qty),0)::text AS qty
       FROM work_orders
       WHERE execution='completed' AND ${monthBoundsTs('coalesce(completed_at, updated_at)')}
       GROUP BY 1 ORDER BY sum(plan_qty) DESC LIMIT 6`,
    )).rows.map((row) => ({ name: row.name, qty: qtyOf(row.qty) }))
    : [];

  const sluggishRows = inv
    ? (await sql.query<{ code: string; name: string; on_hand: string; stale_days: string; idle_days: string }>(
      `SELECT p.code, p.name, coalesce(sum(b.on_hand),0)::text AS on_hand, p.stale_days::text,
        coalesce((EXTRACT(DAY FROM (now() - max(l.posted_at))))::int, 9999)::text AS idle_days
       FROM products p
       LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id
       LEFT JOIN stock_ledger l ON l.tenant_id=p.tenant_id AND l.product_id=p.id
       WHERE p.active AND p.stale_days IS NOT NULL AND p.stale_days > 0
       GROUP BY p.id, p.code, p.name, p.stale_days
       HAVING coalesce(sum(b.on_hand),0) > 0
         AND coalesce((EXTRACT(DAY FROM (now() - max(l.posted_at))))::int, 9999) >= p.stale_days
       ORDER BY coalesce((EXTRACT(DAY FROM (now() - max(l.posted_at))))::int, 9999) DESC
       LIMIT 8`,
    )).rows
    : [];
  const sluggishItems = sluggishRows.map((row) => ({
    code: row.code,
    name: row.name,
    on_hand: qtyOf(row.on_hand),
    idle_days: row.idle_days,
    stale_days: row.stale_days,
  }));

  const prodStats = prod
    ? (await sql.query<{ execution: string; n: string }>(
      `SELECT execution, count(*)::text AS n FROM work_orders WHERE execution <> 'cancelled' GROUP BY execution`,
    )).rows
    : [];
  const execLabel: Record<string, string> = {
    not_started: '未开始', running: '进行中', paused: '已暂停', completed: '已完成',
  };
  const productionItems = prodStats.map((row) => ({
    status: execLabel[row.execution] ?? row.execution,
    count: row.n,
  }));

  const woItems = prod
    ? (await sql.query<{ code: string; name: string; plan_qty: string; good_qty: string; execution: string }>(
      `SELECT w.code, coalesce(w.product_snapshot->>'name','') AS name, w.plan_qty::text,
        coalesce((SELECT sum(r.good_qty) FROM production_reports r WHERE r.work_order_id=w.id AND r.approval='approved'),0)::text AS good_qty,
        w.execution
       FROM work_orders w
       WHERE w.execution IN ('not_started','running','paused')
       ORDER BY w.created_at DESC LIMIT 6`,
    )).rows.map((row) => ({
      code: row.code,
      name: row.name || '-',
      plan: qtyOf(row.plan_qty),
      good: qtyOf(row.good_qty),
      percent: floorPercent(q(row.good_qty), q(row.plan_qty)),
      status: execLabel[row.execution] ?? row.execution,
    }))
    : [];

  const materialRows = inv
    ? (await sql.query<{ code: string; name: string; on_hand: string; lower: string; advice: string }>(
      `SELECT p.code, p.name, coalesce(sum(b.on_hand),0)::text AS on_hand, p.stock_lower_warn::text AS lower,
        greatest(p.stock_lower_warn - coalesce(sum(b.on_hand),0), 0)::text AS advice
       FROM products p
       LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id
       WHERE p.active AND p.stock_lower_warn IS NOT NULL
       GROUP BY p.id, p.code, p.name, p.stock_lower_warn
       HAVING coalesce(sum(b.on_hand),0) < p.stock_lower_warn
       ORDER BY (p.stock_lower_warn - coalesce(sum(b.on_hand),0)) DESC
       LIMIT 8`,
    )).rows
    : [];
  const materialItems = materialRows.map((row) => ({
    code: row.code,
    name: row.name,
    on_hand: qtyOf(row.on_hand),
    lower: qtyOf(row.lower),
    advice: qtyOf(row.advice),
  }));

  const deviceRows = prod
    ? (await sql.query<{ status: string; n: string }>('SELECT status, count(*)::text AS n FROM r8_devices WHERE enabled GROUP BY status')).rows
    : [];
  const deviceMap = new Map(deviceRows.map((row) => [row.status, Number(row.n)]));
  const deviceOrder = ['运行中', '正常', '维修中'];
  for (const status of deviceRows.map((row) => row.status)) {
    if (!deviceOrder.includes(status)) deviceOrder.push(status);
  }
  const deviceItems = prod ? deviceOrder.map((status) => ({ status, count: String(deviceMap.get(status) ?? 0) })) : [];

  return {
    maint_month: {
      total: String(maintTotal),
      items: maintItems,
    },
    defect_dist: {
      total: qtyOf(String(defectTotal)),
      items: defectItems,
    },
    stock_alert: {
      lower: String(stockItems.filter((row) => row.state === '低于下限').length),
      upper: String(stockItems.filter((row) => row.state === '高于上限').length),
      items: stockItems,
    },
    service_trend: {
      days: serviceDays.map((row) => ({ day: row.day, created: row.created, done: row.done })),
      created: String(serviceDays.reduce((sum, row) => sum + Number(row.created), 0)),
      done: String(serviceDays.reduce((sum, row) => sum + Number(row.done), 0)),
    },
    sales_rank: { items: salesRank },
    follow_rank: { items: followRank },
    product_output: {
      orders: outputRow.orders,
      qty: qtyOf(outputRow.qty),
      items: outputItems,
    },
    sluggish_alert: {
      count: String(sluggishItems.length),
      items: sluggishItems,
    },
    production_stats: {
      total: String(productionItems.reduce((sum, item) => sum + Number(item.count), 0)),
      items: productionItems,
    },
    wo_progress: {
      count: String(woItems.length),
      items: woItems,
    },
    material_suggest: {
      count: String(materialItems.length),
      items: materialItems,
    },
    devices: {
      total: String(deviceItems.reduce((sum, row) => sum + Number(row.count), 0)),
      items: deviceItems,
    },
  };
}

export function registerWorkplace(app: FastifyInstance, services: Services) {
  app.get('/api/workplace/config', (request) => member(services, request, false, (sql, actor) => readConfig(sql, actor)));

  app.put('/api/workplace/config', (request) => member(services, request, true, async (sql, actor) => {
    const body = (request.body ?? {}) as Row;
    const before = await readConfig(sql, actor);
    if (body.version !== undefined && Number(body.version) !== before.version) throw new Problem(409, 'VERSION_CONFLICT', '工作台配置已在其他窗口修改，请刷新后重试');
    const cards = body.cards === undefined ? before.cards : normalizeCards(body.cards, { strict: true });
    const shortcuts = body.shortcuts === undefined ? before.shortcuts : normalizeShortcuts(body.shortcuts);
    const layout = body.layout === undefined ? normalizeLayout(before.layout, cards, shortcuts.length) : normalizeLayout(body.layout, cards, shortcuts.length);
    const todo_prefs = body.todo_prefs === undefined ? before.todo_prefs : normalizeTodoPrefs(body.todo_prefs);
    await sql.query(`INSERT INTO workplace_configs(tenant_id,user_id,cards,shortcuts,layout,todo_prefs) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)
      ON CONFLICT (tenant_id,user_id) DO UPDATE SET cards=excluded.cards,shortcuts=excluded.shortcuts,layout=excluded.layout,todo_prefs=excluded.todo_prefs,version=workplace_configs.version+1,updated_at=now()`,
    [actor.tenant_id, actor.user_id, JSON.stringify(cards), JSON.stringify(shortcuts), JSON.stringify(layout), JSON.stringify(todo_prefs)]);
    return readConfig(sql, actor);
  }));

  app.get('/api/workplace/summary', (request) => member(services, request, false, async (sql, actor) => {
    await syncFollowReminders(sql, actor);
    await syncPurchaseReminders(sql, actor);
    const can = (permission: string) => actor.permissions.includes(permission);
    let pendingContracts = 0;
    if (can('sales.read')) {
      if (actor.role === 'admin') pendingContracts = await count(sql, "SELECT count(*)::text AS n FROM money_contracts WHERE approval='pending'");
      else {
        const ids = [...await pendingApproverIds(sql, actor.user_id, 'contract')];
        pendingContracts = ids.length ? await count(sql, "SELECT count(*)::text AS n FROM money_contracts WHERE approval='pending' AND id = ANY($1::uuid[])", [ids]) : 0;
      }
    }
    const pendingInvoices = can('sales.read') ? await count(sql, "SELECT count(*)::text AS n FROM money_invoices WHERE status='pending'") : 0;
    const equip = can('production.read');
    const maintTasks = equip ? await count(sql, "SELECT count(*)::text AS n FROM r8_maint_tasks WHERE status IN ('未开始','进行中')") : 0;
    const repairsToAccept = equip ? await count(sql, "SELECT count(*)::text AS n FROM r8_repairs WHERE status='待接单'") : 0;
    const repairsToReview = equip ? await count(sql, "SELECT count(*)::text AS n FROM r8_repairs WHERE status='待审核'") : 0;
    const unread = (await sql.query(`SELECT id,kind,title,body,link_path,${shanghaiTime('created_at')} AS created_text FROM kgd_messages WHERE user_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 5`, [actor.user_id])).rows;
    const unreadTotal = await count(sql, 'SELECT count(*)::text AS n FROM kgd_messages WHERE user_id=$1 AND read_at IS NULL', [actor.user_id]);
    const notices = await latestNotices(sql, actor, 5);
    const devices = equip ? (await sql.query<{ status: string; n: string }>('SELECT status,count(*)::text AS n FROM r8_devices WHERE enabled GROUP BY status ORDER BY status')).rows.map((row) => ({ status: row.status, count: Number(row.n) })) : [];
    await sql.query('INSERT INTO kgd_enterprise_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [actor.tenant_id]);
    const modules = (await sql.query<{ produce_module: boolean; aftersales_module: boolean; device_module: boolean; version: number }>('SELECT produce_module,aftersales_module,device_module,version FROM kgd_enterprise_settings')).rows[0];
    return {
      todos: {
        customer: [
          { key: 'pending_contracts', name: '待审合同', count: pendingContracts, link: '/contract/list?approval=pending' },
          { key: 'pending_invoices', name: '待开票', count: pendingInvoices, link: '/invoice/list?status=pending' },
        ],
        equip: [
          { key: 'maint_tasks', name: '待执行维保任务', count: maintTasks, link: '/maintenance_task/list?status=未开始' },
          { key: 'repairs_to_accept', name: '待接单维修工单', count: repairsToAccept, link: '/repair_order/list?status=待接单' },
          { key: 'repairs_to_review', name: '待审核维修工单', count: repairsToReview, link: '/repair_order/list?status=待审核' },
        ],
      },
      notices, latest_notice: notices[0] ?? null,
      unread: { total: unreadTotal, items: unread },
      devices: { total: devices.reduce((sum, row) => sum + row.count, 0), items: devices },
      modules: modules ?? null,
      widgets: await workplaceWidgets(sql, actor),
    };
  }));
}
