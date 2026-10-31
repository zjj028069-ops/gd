import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, Empty, Input, Modal, Switch } from 'antd';
import { AppstoreOutlined, BarChartOutlined, CloseOutlined, CustomerServiceOutlined, DeploymentUnitOutlined, EditOutlined, HolderOutlined, MoreOutlined, ReloadOutlined, RocketOutlined, SearchOutlined, ShoppingOutlined, ToolOutlined } from '@ant-design/icons';
import { apiRequest } from '../../../../api';
import { useRemote } from '../../../../masterTools';
import { EChart } from '../../progress/echarts';
import { FollowModal } from '../crm/CustomerFollowList';
import { fmtTime, useR10 } from '../shared';
import iconCustomerAdd from '../../../assets/shortcuts/customer_add.svg';
import iconFollowAdd from '../../../assets/shortcuts/follow_add.svg';
import iconContractAdd from '../../../assets/shortcuts/contract_add.svg';
import iconInvoiceApply from '../../../assets/shortcuts/invoice_apply.svg';
import iconWorkOrderAdd from '../../../assets/shortcuts/work_order_add.svg';
import iconFgReceiptAdd from '../../../assets/shortcuts/fg_receipt_add.svg';
import iconProcessAdd from '../../../assets/shortcuts/process_add.svg';
import iconDefectAdd from '../../../assets/shortcuts/defect_add.svg';
import iconRouteAdd from '../../../assets/shortcuts/route_add.svg';
import iconServiceOrderAdd from '../../../assets/shortcuts/service_order_add.svg';
import iconServiceProductAdd from '../../../assets/shortcuts/service_product_add.svg';
import iconServiceItemAdd from '../../../assets/shortcuts/service_item_add.svg';
import iconDeviceAdd from '../../../assets/shortcuts/device_add.svg';
import iconMaintPlanAdd from '../../../assets/shortcuts/maint_plan_add.svg';
import iconMaintContentAdd from '../../../assets/shortcuts/maint_content_add.svg';
import iconRepairOrderAdd from '../../../assets/shortcuts/repair_order_add.svg';
import iconPurchasePlanAdd from '../../../assets/shortcuts/purchase_plan_add.svg';
import iconPurchaseOrderAdd from '../../../assets/shortcuts/purchase_order_add.svg';
import iconPurchaseInAdd from '../../../assets/shortcuts/purchase_in_add.svg';
import iconOtherInAdd from '../../../assets/shortcuts/other_in_add.svg';
import iconSaleOutAdd from '../../../assets/shortcuts/sale_out_add.svg';
import iconOtherOutAdd from '../../../assets/shortcuts/other_out_add.svg';
import iconTransferAdd from '../../../assets/shortcuts/transfer_add.svg';
import iconStockCheckAdd from '../../../assets/shortcuts/stock_check_add.svg';
import iconGoodsAdd from '../../../assets/shortcuts/goods_add.svg';
import iconNoticePublish from '../../../assets/shortcuts/notice_publish.svg';
import './workplace.css';
import { AppearanceSwitcher } from '../../../appearance';

type TodoItem = { key: string; name: string; count: number; link?: string };
type NoticeBrief = { id: string; title: string; published_at?: string; published_text?: string; created_text?: string };
type RankItem = { name: string; amount?: string; count?: string; qty?: string };
type WorkWidgets = {
  maint_month?: { total: string; items: { status: string; count: string }[] };
  defect_dist?: { total: string; items: { name: string; qty: string; rate: string }[] };
  stock_alert?: { lower: string; upper: string; items: { code: string; name: string; on_hand: string; state: string }[] };
  service_trend?: { days: { day: string; created: string; done: string }[]; created: string; done: string };
  sales_rank?: { items: RankItem[] };
  follow_rank?: { items: RankItem[] };
  product_output?: { orders: string; qty: string; items: { name: string; qty: string }[] };
  sluggish_alert?: { count: string; items: { code: string; name: string; on_hand: string; idle_days: string; stale_days: string }[] };
  production_stats?: { total: string; items: { status: string; count: string }[] };
  wo_progress?: { count: string; items: { code: string; name: string; plan: string; good: string; percent: number; status: string }[] };
  material_suggest?: { count: string; items: { code: string; name: string; on_hand: string; lower: string; advice: string }[] };
  devices?: { total: string; items: { status: string; count: string }[] };
};
type Summary = {
  todos?: { customer?: TodoItem[]; equip?: TodoItem[] };
  notices?: NoticeBrief[];
  latest_notice?: NoticeBrief | null;
  unread?: { total: number; items: { id: string; title?: string; body?: string; link_path?: string; created_text?: string }[] };
  devices?: { total: number; items: { status: string; count: number }[] };
  widgets?: WorkWidgets;
};

type WidgetCategory = '通用' | '工作效率' | '智能报表';
type CardKey =
  | 'shortcuts' | 'tutorial' | 'todos' | 'features' | 'notices' | 'messages'
  | 'maint_month' | 'devices' | 'defect_dist' | 'stock_alert' | 'service_trend'
  | 'sales_rank' | 'follow_rank' | 'product_output' | 'sluggish_alert'
  | 'production_stats' | 'wo_progress' | 'material_suggest';

type CardPref = { key: CardKey; visible: boolean };
type LayoutItem = { key: CardKey; x: number; y: number; w: number; h: number };
type TodoPrefs = Record<string, boolean>;
type Config = { cards?: CardPref[]; shortcuts?: string[]; layout?: LayoutItem[]; todo_prefs?: TodoPrefs; version?: number };
type Enterprise = { aftersales_module?: boolean; produce_module?: boolean; device_module?: boolean; [key: string]: unknown };

type WidgetMeta = { key: CardKey; name: string; category: WidgetCategory; uncaptured?: boolean; desc?: string };

const COLS = 12;
const ROW_H = 56;
/** 快捷入口与待办并排，占半栏。更宽时 1fr 会把九宫格拉稀。 */
const SHORTCUT_MAX_W = 6;

/** 快捷入口固定 3 列。高度按行数取整，保证九宫格不被卡片裁切。 */
export function shortcutMinH(count: number) {
  const rows = Math.max(1, Math.ceil(Math.max(count, 1) / 3));
  const px = 72 + rows * 86;
  return Math.max(5, Math.ceil((px + 12) / ROW_H));
}

/** 待办：按可见分组数保证两行磁贴不被卡片底边裁成一条边。 */
export function todoMinH(groupCount: number) {
  const groups = Math.max(1, groupCount);
  const px = 56 + groups * 92;
  return Math.max(4, Math.ceil((px + 12) / ROW_H));
}

const LAYOUT_H_CAP = 12; // 与 api normalizeLayout 上限一致（未改 api / 未 pm2）

const KEY_MIGRATE: Record<string, CardKey | null> = {
  banner: null,  // v1.0.51 hide tutorial/banner
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

export const widgetCatalog: WidgetMeta[] = [
  { key: 'shortcuts', name: '快捷入口', category: '工作效率', desc: '能够快速地打开常用功能，提高工作效率。' },
  { key: 'todos', name: '待办事项', category: '工作效率', desc: '提醒员工需要完成的工作任务，帮助员工合理安排时间，以达成工作目标。' },
  { key: 'features', name: '功能上新', category: '通用', desc: '了解赛德瑞科的最新功能' },
  { key: 'notices', name: '公告', category: '通用', desc: '在公司内部传递重要的信息，让员工及时了解相关情况。' },
  { key: 'messages', name: '未读消息', category: '通用', desc: '提高组织内部的沟通效率，让员工及时了解工作任务、工作计划等，从而提高工作效率。' },
  { key: 'maint_month', name: '当月维保任务执行概况', category: '智能报表', uncaptured: true, desc: '当月维保任务执行的概况。' },
  { key: 'devices', name: '设备概况', category: '智能报表', desc: '不同状态的设备数量及其占比。' },
  { key: 'defect_dist', name: '当月不良品分布', category: '智能报表', uncaptured: true, desc: '当月不良品项的产生数量及其占比。' },
  { key: 'stock_alert', name: '库存预警', category: '智能报表', uncaptured: true, desc: '库存数量超出报警线范围的商品种类数量。' },
  { key: 'service_trend', name: '服务工单走势', category: '智能报表', desc: '当月每日新增服务工单数量和完成服务工单数量，并展示其变化趋势。' },
  { key: 'sales_rank', name: '当月销售业绩排行', category: '智能报表', uncaptured: true, desc: '当月销售人员的销售额排行（统计范围为当月创建并审核通过的合同）' },
  { key: 'follow_rank', name: '当月跟单排行', category: '智能报表', uncaptured: true, desc: '当月销售人员的跟单数量排行。' },
  { key: 'product_output', name: '当月产品产量', category: '智能报表', uncaptured: true, desc: '当月加工完成的产品数量（统计范围为当月完成的加工单）' },
  { key: 'sluggish_alert', name: '呆滞预警', category: '智能报表', uncaptured: true, desc: '呆滞预警' },
  { key: 'production_stats', name: '生产状况统计', category: '智能报表', uncaptured: true, desc: '生产状况统计' },
  { key: 'wo_progress', name: '工单执行进度', category: '智能报表', uncaptured: true, desc: '工单执行进度' },
  { key: 'material_suggest', name: '本月备料建议', category: '智能报表', uncaptured: true, desc: '本月备料建议' },
];

const knownKeys = new Set(widgetCatalog.map((item) => item.key));

const defaultSizes: Record<CardKey, { w: number; h: number }> = {
  shortcuts: { w: 6, h: shortcutMinH(9) },
  tutorial: { w: 12, h: 2 },
  todos: { w: 6, h: 5 },
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

const defaultCardKeys: CardKey[] = ['shortcuts', 'todos', 'features', 'notices', 'messages', 'devices', 'stock_alert', 'wo_progress'];
const defaultCards: CardPref[] = defaultCardKeys.map((key) => ({ key, visible: true }));

const todoLinks: Record<string, string> = {
  pending_contracts: '/customer_contract/list?chip.approval=pending',
  pending_invoices: '/customer_invoice/list?chip.status=pending',
  maint_tasks: '/inspection_task/list?status=未开始',
  repairs_to_accept: '/device_order/list?status=待接单',
  repairs_to_review: '/device_order/list?status=待审核',
};

const todoMeta: { key: string; name: string; group: string; color: string }[] = [
  { key: 'pending_contracts', name: '待审合同', group: '客户管理', color: '#4184F4' },
  { key: 'pending_invoices', name: '待开票', group: '客户管理', color: '#1890ff' },
  { key: 'maint_tasks', name: '待执行维保任务', group: '维保管理', color: '#fa8c16' },
  { key: 'repairs_to_accept', name: '待接单维修工单', group: '维保管理', color: '#eb2f96' },
  { key: 'repairs_to_review', name: '待审核维修工单', group: '维保管理', color: '#722ed1' },
];

const defaultTodoPrefs: TodoPrefs = Object.fromEntries(todoMeta.map((item) => [item.key, true]));

export const shortcutCatalog: { key: string; label: string; group: string; to?: string; icon: string }[] = [
  { key: 'customer_add', label: '新增客户', group: '客户管理', to: '/customer/list?add=1', icon: iconCustomerAdd },
  { key: 'follow_add', label: '快捷跟单', group: '客户管理', icon: iconFollowAdd },
  { key: 'contract_add', label: '新增合同', group: '客户管理', to: '/customer_contract/list?add=1', icon: iconContractAdd },
  { key: 'invoice_apply', label: '申请开票', group: '客户管理', to: '/customer_invoice/list?add=1', icon: iconInvoiceApply },
  { key: 'work_order_add', label: '创建加工单', group: '生产管理', to: '/inside_produce_bill/add?mode=direct', icon: iconWorkOrderAdd },
  { key: 'fg_receipt_add', label: '成品入库', group: '生产管理', to: '/produce_stock_in_bill/list?add=wo', icon: iconFgReceiptAdd },
  { key: 'process_add', label: '新增工序', group: '生产管理', to: '/public_craft/list?add=1', icon: iconProcessAdd },
  { key: 'defect_add', label: '新增不良品项', group: '生产管理', to: '/waste_item/list?add=1', icon: iconDefectAdd },
  { key: 'route_add', label: '新增工艺路线', group: '生产管理', to: '/craft_route/add', icon: iconRouteAdd },
  { key: 'service_order_add', label: '创建服务工单', group: '服务工单', to: '/service_order/list?add=1', icon: iconServiceOrderAdd },
  { key: 'service_product_add', label: '新增产品', group: '服务工单', to: '/service_product/list?add=1', icon: iconServiceProductAdd },
  { key: 'service_item_add', label: '新增服务项目', group: '服务工单', to: '/service_item/list?add=1', icon: iconServiceItemAdd },
  { key: 'device_add', label: '新增设备', group: '维保管理', to: '/device/list?add=1', icon: iconDeviceAdd },
  { key: 'maint_plan_add', label: '创建维保计划', group: '维保管理', to: '/inspection_plan/add/1', icon: iconMaintPlanAdd },
  { key: 'maint_content_add', label: '新增维保内容', group: '维保管理', to: '/inspection_content/list?add=1', icon: iconMaintContentAdd },
  { key: 'repair_order_add', label: '创建维修工单', group: '维保管理', to: '/device_order/list?add=1', icon: iconRepairOrderAdd },
  { key: 'purchase_plan_add', label: '创建采购计划', group: '仓库管理', to: '/produce_plan/list?add=1', icon: iconPurchasePlanAdd },
  { key: 'purchase_order_add', label: '创建采购单', group: '仓库管理', to: '/purchase_order/list?add=1', icon: iconPurchaseOrderAdd },
  { key: 'purchase_in_add', label: '采购入库', group: '仓库管理', to: '/purchase_stock_in_bill/list?add=1', icon: iconPurchaseInAdd },
  { key: 'other_in_add', label: '其他入库', group: '仓库管理', to: '/else_stock_in_bill/list?add=1', icon: iconOtherInAdd },
  { key: 'sale_out_add', label: '销售出库', group: '仓库管理', to: '/sale_stock_out_bill/list?add=1', icon: iconSaleOutAdd },
  { key: 'other_out_add', label: '其他出库', group: '仓库管理', to: '/else_stock_out_bill/list?add=1', icon: iconOtherOutAdd },
  { key: 'transfer_add', label: '创建调拨单', group: '仓库管理', to: '/stock_allocate_bill/list?add=1', icon: iconTransferAdd },
  { key: 'stock_check_add', label: '库存盘点', group: '仓库管理', to: '/stock_taking_bill/list?add=1', icon: iconStockCheckAdd },
  { key: 'goods_add', label: '新增商品', group: '其他', to: '/goods/list?add=1', icon: iconGoodsAdd },
  { key: 'notice_publish', label: '发布公告', group: '其他', to: '/notice/add', icon: iconNoticePublish },
];
const defaultShortcutKeys = ['customer_add', 'follow_add', 'contract_add', 'invoice_apply', 'work_order_add', 'fg_receipt_add', 'process_add', 'defect_add', 'route_add'];
const defaultShortcuts = defaultShortcutKeys.filter((key) => shortcutCatalog.some((item) => item.key === key));

function resolveKey(raw: string): CardKey | null {
  if (raw === 'tutorial') return null; // v1.0.51 hide tutorial
  if (knownKeys.has(raw as CardKey)) return raw as CardKey;
  if (Object.prototype.hasOwnProperty.call(KEY_MIGRATE, raw)) return KEY_MIGRATE[raw] ?? null;
  return null;
}

function ShortcutIcon({ label, icon }: { label: string; icon: string }) {
  return <img className="wp-shortcut-icon-img" src={icon} alt="" width={44} height={44} data-shortcut-icon={label} draggable={false} />;
}

function packLayout(keys: CardKey[]): LayoutItem[] {
  let y = 0;
  let x = 0;
  let rowH = 0;
  const items: LayoutItem[] = [];
  for (const key of keys) {
    const size = defaultSizes[key];
    if (x + size.w > COLS) {
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

function mergeCards(saved: CardPref[] | undefined): CardPref[] {
  const list: CardPref[] = [];
  const seen = new Set<CardKey>();
  for (const item of saved ?? []) {
    const key = resolveKey(String(item.key));
    // v1.0.51：隐藏「3天快速落地教程」——旧 layout/cards 一律剔除
    if (!key || key === 'tutorial' || seen.has(key)) continue;
    seen.add(key);
    list.push({ key, visible: item.visible !== false });
  }
  if (!list.length) return defaultCards.map((item) => ({ ...item }));
  return [...list, ...defaultCards.filter((item) => !seen.has(item.key))];
}


/** v1.0.53：仅去掉顶部连续空行（剔除 tutorial 后的顶空档），不压缩用户卡片间空隙，绝不改 h。 */
function compactLayout(items: LayoutItem[]): LayoutItem[] {
  if (!items.length) return items;
  const minY = items.reduce((sum, item) => Math.min(sum, item.y), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(minY) || minY <= 0) return items;
  return items.map((item) => ({ ...item, y: item.y - minY }));
}

/** 保存/读回时把重叠卡下推，避免拉伸后压住下方卡。 */
function resolveOverlaps(items: LayoutItem[]): LayoutItem[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: LayoutItem[] = [];
  for (const item of sorted) {
    let y = item.y;
    for (let guard = 0; guard < 64; guard += 1) {
      const hit = placed.find((other) => !(item.x + item.w <= other.x || other.x + other.w <= item.x || y + item.h <= other.y || other.y + other.h <= y));
      if (!hit) break;
      y = hit.y + hit.h;
    }
    placed.push({ ...item, y });
  }
  return placed;
}

function mergeLayout(saved: LayoutItem[] | undefined, cards: CardPref[]): LayoutItem[] {
  const visible = cards.filter((card) => card.visible).map((card) => card.key);
  if (!saved?.length) return packLayout(visible);
  const byKey = new Map<CardKey, LayoutItem>();
  for (const item of saved) {
    const key = resolveKey(String(item.key));
    if (!key || !visible.includes(key) || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  const items: LayoutItem[] = [];
  for (const key of visible) {
    const existing = byKey.get(key);
    if (existing) {
      const w = Math.min(key === 'shortcuts' ? SHORTCUT_MAX_W : COLS, Math.max(2, Number(existing.w) || defaultSizes[key].w));
      const xCap = key === 'shortcuts' ? COLS - w : COLS - 2;
      items.push({
        key,
        x: Math.min(xCap, Math.max(0, Number(existing.x) || 0)),
        y: Math.max(0, Number(existing.y) || 0),
        w,
        h: Math.min(LAYOUT_H_CAP, Math.max(key === 'shortcuts' ? shortcutMinH(defaultShortcuts.length) : (key === 'todos' ? todoMinH(2) : 1), Number(existing.h) || defaultSizes[key].h)),
      });
    }
  }
  for (const key of visible) {
    if (items.some((item) => item.key === key)) continue;
    const size = defaultSizes[key];
    const maxY = items.reduce((sum, item) => Math.max(sum, item.y + item.h), 0);
    items.push({ key, x: 0, y: maxY, w: size.w, h: size.h });
  }
  // v1.0.53：只去掉顶部空行；再解消重叠，且不改用户 h
  return resolveOverlaps(compactLayout(items));
}

function mergeTodoPrefs(saved: TodoPrefs | undefined): TodoPrefs {
  return { ...defaultTodoPrefs, ...(saved ?? {}) };
}

function findFreeSlot(layout: LayoutItem[], w: number, h: number): { x: number; y: number } {
  const maxY = layout.reduce((sum, item) => Math.max(sum, item.y + item.h), 0) + 8;
  for (let y = 0; y <= maxY; y += 1) {
    for (let x = 0; x <= COLS - w; x += 1) {
      const overlaps = layout.some((item) => !(x + w <= item.x || item.x + item.w <= x || y + h <= item.y || item.y + item.h <= y));
      if (!overlaps) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

export function WorkplacePage() {
  const r10 = useR10();
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  const summary = useRemote<Summary>(`/api/workplace/summary?tick=${tick}`, r10.revision, r10.onExpired);
  const config = useRemote<Config>('/api/workplace/config', r10.revision, r10.onExpired);
  const enterprise = useRemote<{ enterprise?: Enterprise }>('/api/system/enterprise', r10.revision, r10.onExpired);
  const noticeFallback = useRemote<{ items?: NoticeBrief[] }>('/api/notices/latest?limit=5', r10.revision, r10.onExpired);

  const [editing, setEditing] = useState(false);
  const [draftCards, setDraftCards] = useState<CardPref[]>([]);
  const [draftLayout, setDraftLayout] = useState<LayoutItem[]>([]);
  const [draftTodos, setDraftTodos] = useState<TodoPrefs>(defaultTodoPrefs);
  /** 刚保存成功时暂存 layout，避免 setEditing(false) 后 reload 完成前闪回旧尺寸 */
  const [committedLayout, setCommittedLayout] = useState<LayoutItem[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [todoEditOpen, setTodoEditOpen] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const savedCards = useMemo(() => mergeCards(config.data?.cards), [config.data]);
  const savedLayout = useMemo(() => {
    const merged = mergeLayout(config.data?.layout, savedCards);
    return committedLayout ?? merged;
  }, [config.data, savedCards, committedLayout]);
  const savedTodos = useMemo(() => mergeTodoPrefs(config.data?.todo_prefs), [config.data]);
  const shortcuts = config.data?.shortcuts?.length ? config.data.shortcuts : defaultShortcuts;

  const shortcutCount = shortcuts.filter((key) => shortcutCatalog.some((entry) => entry.key === key)).length;
  const todoPrefs = editing ? draftTodos : savedTodos;
  const todoGroupCount = Math.max(
    1,
    ['客户管理', '维保管理'].filter((group) => todoMeta.some((item) => item.group === group && todoPrefs[item.key] !== false)).length,
  );
  const layout = (editing ? draftLayout : savedLayout).map((item) => {
    if (item.key === 'shortcuts') return { ...item, h: Math.max(item.h, shortcutMinH(shortcutCount)) };
    if (item.key === 'todos') return { ...item, h: Math.max(item.h, todoMinH(todoGroupCount)) };
    return item;
  });

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!committedLayout || !config.data?.layout) return;
    // 服务端 layout 已读回后放下本地暂存
    setCommittedLayout(null);
  }, [config.data?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onWorkplaceAction(ev: Event) {
      const detail = (ev as CustomEvent<{ action?: string }>).detail;
      const action = detail?.action;
      if (action === 'fullscreen') {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void root.current?.requestFullscreen?.();
      } else if (action === 'refresh') {
        setTick((value) => value + 1);
        config.reload();
        enterprise.reload();
      } else if (action === 'configure') {
        enterEdit();
      }
    }
    window.addEventListener('sedric-workplace-action', onWorkplaceAction as EventListener);
    return () => window.removeEventListener('sedric-workplace-action', onWorkplaceAction as EventListener);
  }, [config, enterprise]);

  function enterEdit() {
    setDraftCards(savedCards.map((item) => ({ ...item })));
    setDraftLayout(savedLayout.map((item) => ({ ...item })));
    setDraftTodos({ ...savedTodos });
    setEditing(true);
  }

  function requestCancel() {
    r10.modal.confirm({
      title: '确认退出',
      content: '退出后未保存的修改将丢失，确定退出？',
      okText: '确定',
      cancelText: '取消',
      onOk: () => {
        setEditing(false);
        setAddOpen(false);
      },
    });
  }

  async function saveWorkspace() {
    // 显式用 draftLayout（含用户拖拽/拉伸），解消重叠后再落库；避免误用旧 savedLayout
    const toSave = resolveOverlaps(draftLayout.map((item) => {
      if (item.key === 'shortcuts') return { ...item, h: Math.max(item.h, shortcutMinH(shortcutCount)) };
      if (item.key === 'todos') return { ...item, h: Math.max(item.h, todoMinH(todoGroupCount)) };
      return {
        ...item,
        h: Math.min(LAYOUT_H_CAP, Math.max(1, Number(item.h) || 1)),
        w: Math.min(COLS, Math.max(2, Number(item.w) || 2)),
        x: Math.max(0, Number(item.x) || 0),
        y: Math.max(0, Number(item.y) || 0),
      };
    }));
    const result = await r10.act('/api/workplace/config', {
      cards: draftCards,
      layout: toSave,
      todo_prefs: draftTodos,
      shortcuts,
      version: config.data?.version,
    }, 'PUT');
    if (result) {
      setDraftLayout(toSave);
      setCommittedLayout(toSave);
      setEditing(false);
      setAddOpen(false);
      config.reload();
    }
  }

  async function savePartial(next: Partial<Config>) {
    const result = await r10.act('/api/workplace/config', {
      cards: next.cards ?? savedCards,
      layout: next.layout ?? layout,
      todo_prefs: next.todo_prefs ?? savedTodos,
      shortcuts: next.shortcuts ?? shortcuts,
      version: config.data?.version,
    }, 'PUT');
    if (result) {
      config.reload();
      setShortcutOpen(false);
      setTodoEditOpen(false);
    }
  }

  async function toggleModule(key: 'aftersales_module' | 'produce_module' | 'device_module', value: boolean) {
    const current = enterprise.data?.enterprise;
    if (!current) return;
    try {
      await apiRequest('/api/system/enterprise', { method: 'PUT', csrfToken: r10.session.csrf_token, body: { ...current, [key]: value } });
      r10.message.success(value ? '已开启' : '已关闭');
      enterprise.reload();
      r10.onChanged();
    } catch (failure) { r10.message.error(failure instanceof Error ? failure.message : String(failure)); }
  }

  function openShortcut(key: string) {
    const item = shortcutCatalog.find((entry) => entry.key === key);
    if (!item) return;
    if (key === 'follow_add') setFollowOpen(true);
    else if (item.to) navigate(item.to);
  }

  function removeWidget(key: CardKey) {
    setDraftCards((current) => current.map((item) => item.key === key ? { ...item, visible: false } : item));
    setDraftLayout((current) => current.filter((item) => item.key !== key));
  }

  function addWidget(key: CardKey) {
    const size = defaultSizes[key];
    setDraftCards((current) => {
      const exists = current.some((item) => item.key === key);
      if (exists) return current.map((item) => item.key === key ? { ...item, visible: true } : item);
      return [...current, { key, visible: true }];
    });
    setDraftLayout((current) => {
      if (current.some((item) => item.key === key)) return current;
      const slot = findFreeSlot(current, size.w, size.h);
      return [...current, { key, ...slot, w: size.w, h: size.h }];
    });
    setAddOpen(false);
  }

  function updateLayoutItem(key: CardKey, patch: Partial<LayoutItem>) {
    setDraftLayout((current) => current.map((item) => {
      if (item.key !== key) return item;
      const next = { ...item, ...patch };
      next.w = Math.min(item.key === 'shortcuts' ? SHORTCUT_MAX_W : COLS, Math.max(2, next.w));
      next.h = Math.min(LAYOUT_H_CAP, Math.max(item.key === 'shortcuts' ? shortcutMinH(shortcutCount) : (item.key === 'todos' ? todoMinH(todoGroupCount) : 1), next.h));
      next.x = Math.min(COLS - next.w, Math.max(0, next.x));
      next.y = Math.max(0, next.y);
      return next;
    }));
  }

  const todos = summary.data?.todos ?? {};
  const notices = (summary.data?.notices?.length ? summary.data.notices : noticeFallback.data?.items) ?? [];
  const noticesSettled = Boolean(summary.data) || Boolean(noticeFallback.data) || (!summary.loading && !noticeFallback.loading);
  const messages = summary.data?.unread?.items ?? [];
  const devices = summary.data?.devices?.items ?? [];
  const deviceKey = devices.map((item) => `${item.status}:${item.count}`).join('|') || 'empty';
  const deviceOption = useMemo(() => ({
    tooltip: { trigger: 'item' as const },
    legend: { orient: 'vertical' as const, right: 10, top: 'middle' },
    series: [{ type: 'pie' as const, radius: ['45%', '70%'], center: ['40%', '50%'], data: devices.map((item) => ({ name: item.status, value: Number(item.count) })) }],
  }), [deviceKey]);
  const ent = enterprise.data?.enterprise ?? {};
  const latest = summary.data?.latest_notice ?? notices[0];
  const widgets = summary.data?.widgets;
  const trendDays = widgets?.service_trend?.days ?? [];
  const trendKey = trendDays.map((item) => `${item.day}:${item.created}:${item.done}`).join('|') || 'empty';
  const trendOption = useMemo(() => ({
    tooltip: { trigger: 'axis' as const },
    legend: { data: ['新增', '完成'] },
    grid: { left: 40, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category' as const, data: trendDays.map((item) => item.day.slice(5)) },
    yAxis: { type: 'value' as const, minInterval: 1 },
    series: [
      { name: '新增', type: 'line' as const, data: trendDays.map((item) => Number(item.created)) },
      { name: '完成', type: 'line' as const, data: trendDays.map((item) => Number(item.done)) },
    ],
  }), [trendKey]);

  const filterTodos = (items: TodoItem[] | undefined) => (items ?? []).filter((item) => todoPrefs[item.key] !== false);
  const todoGroup = (title: string, items: TodoItem[] | undefined) => {
    const list = filterTodos(items);
    return list.length ? <div className="wp-todo-group"><span className="kgd-muted">{title}</span>
      <div className="wp-todo-tiles">{list.map((item) => <Todo key={item.key} label={item.name} value={item.count} onClick={() => navigate(todoLinks[item.key] ?? item.link ?? '/staging/area')} />)}</div>
    </div> : null;
  };

  function cardTitle(name: string, uncaptured?: boolean) {
    if (!uncaptured) return <b>{name}</b>;
    return <span className="wp-card-head-tags"><b>{name}</b><span className="wp-stub-tag">原版未采到</span></span>;
  }
  function metricGrid(items: { key: string; label: string; value: string }[]) {
    return <div className="wp-brief-grid" data-testid="wp-metrics">{items.map((item) => <div key={item.key} className="wp-brief-item" data-metric={item.key}><div className="kgd-muted">{item.label}</div><b>{item.value}</b></div>)}</div>;
  }
  function lineList(rows: { key: string; primary: string; secondary?: string; extra?: string }[]) {
    return <div className="wp-mini-list" data-testid="wp-lines">{rows.map((row, index) => <div key={row.key} data-line={index}><span>{row.primary}</span><span className="kgd-muted">{row.secondary}</span>{row.extra ? <b>{row.extra}</b> : null}</div>)}</div>;
  }
  function bizEmpty(text: string) {
    return <div className="wp-biz-empty" data-testid="wp-empty">{text}</div>;
  }

  const blocks: Record<CardKey, ReactNode> = {
    tutorial: <div className="wp-banner" key="tutorial">
      <div className="wp-banner-title"><b>3天</b><span>快速落地教程</span></div>
      {([['aftersales_module', '快售后', '提供专业售后服务解决方案', <CustomerServiceOutlined key="a" />], ['produce_module', '快生产', '迈出数字化工厂第一步', <DeploymentUnitOutlined key="p" />], ['device_module', '快维保', '专业的互联网维保平台', <ToolOutlined key="d" />]] as const).map(([key, title, desc, icon]) => <div className="wp-module" key={key}>
        <div className="wp-module-icon">{icon}</div>
        <div><b>{title}</b><div className="kgd-muted">{desc}</div><div style={{ marginTop: 6 }}>开启功能 <Switch size="small" checked={ent[key] !== false} onChange={(value) => void toggleModule(key, value)} disabled={editing} /></div></div>
      </div>)}
    </div>,
    shortcuts: <section className="wp-card wp-shortcuts-card" key="shortcuts">
      <header><b>快捷入口</b>{!editing && <DropdownEdit label="编辑" onEdit={() => setShortcutOpen(true)} onRefresh={() => { setTick((value) => value + 1); config.reload(); }} />}</header>
      <div className="wp-shortcuts" data-shortcut-count={shortcutCount}>{shortcuts.map((key) => { const item = shortcutCatalog.find((entry) => entry.key === key); return item ? <button type="button" key={key} data-key={key} onClick={() => !editing && openShortcut(key)}><ShortcutIcon label={item.label} icon={item.icon} />{item.label}</button> : null; })}</div>
    </section>,
    todos: <section className="wp-card" key="todos">
      <header><b>待办事项</b>{!editing && <DropdownEdit label="编辑" onEdit={() => setTodoEditOpen(true)} />}</header>
      {todoGroup('客户管理', todos.customer)}
      {todoGroup('维保管理', todos.equip)}
      {!filterTodos(todos.customer).length && !filterTodos(todos.equip).length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办" />}
    </section>,
    features: <section className="wp-card" key="features">
      <header><b>功能上新</b></header>
      {latest ? <div className="wp-news"><div>{latest.title}</div><button type="button" className="kgd-link" onClick={() => navigate(`/notice/detail/${latest.id}`)}>点击查看详情&gt;</button></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={noticesSettled ? '暂无功能上新' : ''} />}
    </section>,
    notices: <section className="wp-card" key="notices" data-testid="wp-notices">
      <header><b>公告</b><button type="button" className="kgd-link" onClick={() => navigate('/notice/list')}>更多 &gt;</button></header>
      {!noticesSettled ? null : notices.length ? notices.slice(0, 5).map((item) => <div key={item.id} className="wp-line" onClick={() => navigate(`/notice/detail/${item.id}`)}><span>{item.title}</span><span className="kgd-muted">{(item.published_text ?? fmtTime(item.published_at)).slice(0, 10)}</span></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公告" />}
    </section>,
    messages: <section className="wp-card" key="messages">
      <header><b>未读消息</b><button type="button" className="kgd-link" onClick={() => navigate('/message/list')}>点击进入消息中心 &gt;</button></header>
      {messages.length ? messages.slice(0, 5).map((item) => <div key={item.id} className="wp-line" onClick={() => navigate(item.link_path || '/message/list')}><span>{item.title || item.body}</span><span className="kgd-muted">{(item.created_text ?? '').slice(5, 16)}</span></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无未读消息" />}
    </section>,
    maint_month: <section className="wp-card wp-fit" key="maint_month">
      <header>{cardTitle('当月维保任务执行概况', true)}<span className="kgd-muted">共 {widgets?.maint_month?.total ?? '0'} 项</span></header>
      {widgets?.maint_month?.items?.some((item) => Number(item.count) > 0)
        ? metricGrid(widgets.maint_month.items.map((item) => ({ key: item.status, label: item.status, value: item.count })))
        : bizEmpty('当月暂无维保任务')}
    </section>,
    devices: <section className="wp-card" key="devices">
      <header><b>设备概况</b><span className="kgd-muted">共 {summary.data?.devices?.total ?? devices.reduce((sum, item) => sum + Number(item.count), 0)} 台</span></header>
      {devices.length ? <EChart key={deviceKey} className="wp-chart" option={deviceOption} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无设备" />}
    </section>,
    defect_dist: <section className="wp-card wp-fit" key="defect_dist">
      <header>{cardTitle('当月不良品分布', true)}<span className="kgd-muted">共 {widgets?.defect_dist?.total ?? '0'}</span></header>
      {widgets?.defect_dist?.items?.length
        ? lineList(widgets.defect_dist.items.map((item) => ({ key: item.name, primary: item.name, secondary: item.rate, extra: item.qty })))
        : bizEmpty('当月暂无不良品')}
    </section>,
    stock_alert: <section className="wp-card wp-fit" key="stock_alert">
      <header>{cardTitle('库存预警', true)}</header>
      <div className="wp-stock-pair" data-testid="wp-stock-pair">
        <div className="wp-stock-box is-upper" data-metric="upper"><b>{widgets?.stock_alert?.upper ?? '0'}<small>种</small></b><span>高于上限</span></div>
        <div className="wp-stock-box is-lower" data-metric="lower"><b>{widgets?.stock_alert?.lower ?? '0'}<small>种</small></b><span>低于下限</span></div>
      </div>
      {widgets?.stock_alert?.items?.length
        ? lineList(widgets.stock_alert.items.map((item) => ({ key: item.code, primary: item.name, secondary: item.state, extra: item.on_hand })))
        : bizEmpty('暂无库存预警')}
    </section>,
    service_trend: <section className="wp-card" key="service_trend">
      <header><b>服务工单走势</b><span className="kgd-muted">新增 {widgets?.service_trend?.created ?? '0'} / 完成 {widgets?.service_trend?.done ?? '0'}</span></header>
      {trendDays.some((item) => Number(item.created) > 0 || Number(item.done) > 0)
        ? <EChart key={trendKey} className="wp-chart" option={trendOption} />
        : bizEmpty('当月暂无服务工单')}
    </section>,
    sales_rank: <section className="wp-card wp-fit" key="sales_rank">
      <header>{cardTitle('当月销售业绩排行', true)}</header>
      {widgets?.sales_rank?.items?.length
        ? lineList(widgets.sales_rank.items.map((item, index) => ({ key: item.name, primary: `${index + 1}. ${item.name}`, secondary: `${item.count ?? 0} 单`, extra: item.amount })))
        : bizEmpty('当月暂无销售业绩')}
    </section>,
    follow_rank: <section className="wp-card wp-fit" key="follow_rank">
      <header>{cardTitle('当月跟单排行', true)}</header>
      {widgets?.follow_rank?.items?.length
        ? lineList(widgets.follow_rank.items.map((item, index) => ({ key: item.name, primary: `${index + 1}. ${item.name}`, extra: item.count })))
        : bizEmpty('当月暂无跟单')}
    </section>,
    product_output: <section className="wp-card wp-fit" key="product_output">
      <header>{cardTitle('当月产品产量', true)}</header>
      {metricGrid([
        { key: 'orders', label: '完工单数', value: widgets?.product_output?.orders ?? '0' },
        { key: 'qty', label: '产量', value: widgets?.product_output?.qty ?? '0' },
      ])}
      {widgets?.product_output?.items?.length
        ? lineList(widgets.product_output.items.map((item) => ({ key: item.name, primary: item.name, extra: item.qty })))
        : bizEmpty('当月暂无完工产量')}
    </section>,
    sluggish_alert: <section className="wp-card wp-fit" key="sluggish_alert">
      <header>{cardTitle('呆滞预警', true)}<span className="kgd-muted">{widgets?.sluggish_alert?.count ?? '0'} 种</span></header>
      {widgets?.sluggish_alert?.items?.length
        ? lineList(widgets.sluggish_alert.items.map((item) => ({ key: item.code, primary: item.name, secondary: `闲置${item.idle_days}天`, extra: item.on_hand })))
        : bizEmpty('暂无呆滞预警')}
    </section>,
    production_stats: <section className="wp-card wp-fit" key="production_stats">
      <header>{cardTitle('生产状况统计', true)}<span className="kgd-muted">共 {widgets?.production_stats?.total ?? '0'}</span></header>
      {widgets?.production_stats?.items?.length
        ? metricGrid(widgets.production_stats.items.map((item) => ({ key: item.status, label: item.status, value: item.count })))
        : bizEmpty('暂无生产状况')}
    </section>,
    wo_progress: <section className="wp-card wp-fit" key="wo_progress">
      <header>{cardTitle('工单执行进度', true)}</header>
      {widgets?.wo_progress?.items?.length
        ? lineList(widgets.wo_progress.items.map((item) => ({ key: item.code, primary: item.code, secondary: item.name, extra: `${item.percent}%` })))
        : bizEmpty('暂无在制工单')}
    </section>,
    material_suggest: <section className="wp-card wp-fit" key="material_suggest">
      <header>{cardTitle('本月备料建议', true)}<span className="kgd-muted">{widgets?.material_suggest?.count ?? '0'} 种</span></header>
      {widgets?.material_suggest?.items?.length
        ? lineList(widgets.material_suggest.items.map((item) => ({ key: item.code, primary: item.name, secondary: `建议${item.advice}`, extra: item.on_hand })))
        : bizEmpty('本月暂无备料建议')}
    </section>,
  };

  const boardH = Math.max(8, layout.reduce((sum, item) => Math.max(sum, item.y + item.h), 0) + (editing ? 2 : 0));

  return <div ref={root} className={`wp-root ${fullscreen ? 'wp-full' : ''} ${editing ? 'wp-editing' : ''}`} data-testid="wp-root">
    {editing ? (
    <div className="wp-toolbar">
        <Button onClick={() => setAddOpen(true)}>添加组件</Button>
        <Button type="primary" onClick={() => void saveWorkspace()}>保存</Button>
        <Button onClick={requestCancel}>取消</Button>
    </div>
    ) : null}
    {summary.error && <div className="kgd-banner">{summary.error}</div>}
    <div className="wp-canvas-shell" data-testid="wp-canvas-shell">
      <div className="wp-board" style={{ height: boardH * ROW_H }} data-testid="wp-board">
        {layout.map((item) => <WidgetShell
          key={item.key}
          item={item}
          editing={editing}
          onRemove={() => removeWidget(item.key)}
          onMove={(x, y) => updateLayoutItem(item.key, { x, y })}
          onResize={(w, h) => updateLayoutItem(item.key, { w, h })}
        >{blocks[item.key]}</WidgetShell>)}
      </div>
    </div>
    {addOpen && <AddWidgetModal
      placed={new Set(layout.map((item) => item.key))}
      onCancel={() => setAddOpen(false)}
      onPick={addWidget}
    />}
    {shortcutOpen && <ShortcutModal value={shortcuts} onCancel={() => setShortcutOpen(false)} onOk={(next) => void savePartial({ shortcuts: next })} />}
    {todoEditOpen && <TodoEditModal value={savedTodos} onCancel={() => setTodoEditOpen(false)} onOk={(next) => void savePartial({ todo_prefs: next })} />}
    {followOpen && <FollowModal row={null} onClose={() => setFollowOpen(false)} onSaved={() => { setFollowOpen(false); setTick((value) => value + 1); }} />}
  </div>;
}

function DropdownEdit({ label, onEdit, onRefresh }: { label: string; onEdit: () => void; onRefresh?: () => void }) {
  const items = [
    { key: 'edit', label: <span data-testid="wp-menu-edit">{label}</span>, icon: <span aria-hidden><EditOutlined /></span> },
    ...(onRefresh ? [{ key: 'refresh', label: <span data-testid="wp-menu-refresh">刷新</span>, icon: <span aria-hidden><ReloadOutlined /></span> }] : []),
  ];
  return <Dropdown
    menu={{
      items,
      onClick: ({ key }) => {
        if (key === 'edit') onEdit();
        if (key === 'refresh') onRefresh?.();
      },
    }}
    trigger={['click']}
  >
    <Button type="text" size="small" className="wp-more" icon={<MoreOutlined />} aria-label={label} />
  </Dropdown>;
}

function Todo({ label, value, onClick }: { label: string; value?: number; onClick: () => void }) {
  return <button type="button" className="wp-todo" onClick={onClick}><b>{value ?? 0}</b><span>{label}</span></button>;
}

function WidgetShell({ item, editing, children, onRemove, onMove, onResize }: {
  item: LayoutItem;
  editing: boolean;
  children: ReactNode;
  onRemove: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number; colW: number } | null>(null);

  function onPointerDown(kind: 'move' | 'resize', event: ReactPointerEvent) {
    if (!editing || !shell.current?.parentElement) return;
    event.preventDefault();
    event.stopPropagation();
    const board = shell.current.parentElement.getBoundingClientRect();
    const colW = board.width / COLS;
    drag.current = { kind, startX: event.clientX, startY: event.clientY, origX: item.x, origY: item.y, origW: item.w, origH: item.h, colW };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent) {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (state.kind === 'move') {
      onMove(
        Math.min(COLS - item.w, Math.max(0, state.origX + Math.round(dx / state.colW))),
        Math.max(0, state.origY + Math.round(dy / ROW_H)),
      );
    } else {
      onResize(
        Math.min(COLS - item.x, Math.max(2, state.origW + Math.round(dx / state.colW))),
        Math.max(1, state.origH + Math.round(dy / ROW_H)),
      );
    }
  }

  function onPointerUp() { drag.current = null; }

  return <div
    ref={shell}
    className={`wp-widget ${editing ? 'wp-widget-edit' : ''}`}
    data-testid={`wp-widget-${item.key}`}
    style={{
      left: `calc(${item.x} * 100% / ${COLS})`,
      top: item.y * ROW_H,
      width: `calc(${item.w} * 100% / ${COLS} - 12px)`,
      height: item.h * ROW_H - 12,
    }}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
  >
    {editing && <>
      <button type="button" className="wp-widget-drag" aria-label="拖动" onPointerDown={(event) => onPointerDown('move', event)}><HolderOutlined /></button>
      <button type="button" className="wp-widget-close" aria-label="移除" onClick={onRemove}><CloseOutlined /></button>
      <button type="button" className="wp-widget-resize" aria-label="调整大小" onPointerDown={(event) => onPointerDown('resize', event)} />
    </>}
    <div className="wp-widget-body">{children}</div>
  </div>;
}

const pickerNav = [
  { key: '全部' as const, icon: <AppstoreOutlined />, tint: '#1677ff' },
  { key: '通用' as const, icon: <ShoppingOutlined />, tint: '#fa8c16' },
  { key: '工作效率' as const, icon: <RocketOutlined />, tint: '#722ed1' },
  { key: '智能报表' as const, icon: <BarChartOutlined />, tint: '#4184F4' },
];

function WidgetPreview({ item }: { item: WidgetMeta }) {
  if (item.key === 'shortcuts') {
    return <div className="wp-preview wp-preview-shortcuts" aria-hidden>{['#ff6b6b', '#4c6ef5', '#51cf66', '#9775fa', '#be4bdb', '#20c997'].map((color) => <i key={color} style={{ background: color }} />)}</div>;
  }
  if (item.key === 'tutorial') {
    return <div className="wp-preview wp-preview-tutorial" aria-hidden>{['#4c6ef5', '#fab005', '#20c997'].map((color) => <span key={color}><i style={{ background: color }} /><b /></span>)}</div>;
  }
  if (item.key === 'todos') {
    return <div className="wp-preview wp-preview-todos" aria-hidden>{['#9775fa', '#4c6ef5', '#20c997'].map((color) => <span key={color}><i style={{ background: color }} /><b /><b /></span>)}</div>;
  }
  return <div className="wp-preview wp-preview-generic" aria-hidden><i /><i /><i /></div>;
}

function AddWidgetModal({ placed, onCancel, onPick }: { placed: Set<CardKey>; onCancel: () => void; onPick: (key: CardKey) => void }) {
  const [tab, setTab] = useState<'全部' | WidgetCategory>('全部');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CardKey | null>(null);
  const counts = {
    全部: widgetCatalog.length,
    通用: widgetCatalog.filter((item) => item.category === '通用').length,
    工作效率: widgetCatalog.filter((item) => item.category === '工作效率').length,
    智能报表: widgetCatalog.filter((item) => item.category === '智能报表').length,
  };
  const keyword = query.trim();
  const canConfirm = Boolean(selected && !placed.has(selected));
  return <Modal
    title="添加组件"
    open
    onCancel={onCancel}
    okText="确定"
    cancelText="取消"
    okButtonProps={{ disabled: !canConfirm }}
    onOk={() => { if (selected && !placed.has(selected)) onPick(selected); }}
    width={960}
    className="wp-widget-modal"
  >
    <div className="wp-picker-shell">
      <aside className="wp-picker-side" data-testid="wp-picker-side">
        <Input
          allowClear
          className="wp-picker-search"
          data-testid="wp-picker-search"
          placeholder="搜索"
          prefix={<SearchOutlined />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="wp-picker-nav">
          {pickerNav.map((item) => <button
            type="button"
            key={item.key}
            data-testid={`wp-tab-${item.key}`}
            className={`wp-picker-nav-btn ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            <span className="wp-picker-nav-icon" style={{ color: item.tint }}>{item.icon}</span>
            <span>{item.key} · {counts[item.key]}</span>
          </button>)}
        </div>
      </aside>
      <div className="wp-picker-main">
        <div className="wp-picker-heading" data-testid="wp-picker-heading">{tab}</div>
        <div className="wp-picker-grid" data-testid="wp-picker-grid" data-widget-count={widgetCatalog.length}>
          {widgetCatalog.map((item) => {
            const disabled = placed.has(item.key);
            const hidden = (tab !== '全部' && item.category !== tab) || (keyword !== '' && !`${item.name}${item.desc ?? ''}`.includes(keyword));
            return <button
              type="button"
              key={item.key}
              data-testid="wp-widget-card"
              data-key={item.key}
              data-category={item.category}
              data-name={item.name}
              className={`wp-picker-card ${selected === item.key ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''}`}
              style={hidden ? { display: 'none' } : undefined}
              disabled={disabled}
              onClick={() => setSelected(item.key)}
            >
              <WidgetPreview item={item} />
              <span className="wp-picker-copy">
                <b>{item.name}</b>
                {item.desc && <span className="kgd-muted">{item.desc}</span>}
              </span>
              {disabled && <span className="wp-picker-used">已添加</span>}
            </button>;
          })}
        </div>
      </div>
    </div>
  </Modal>;
}

function ShortcutModal({ value, onCancel, onOk }: { value: string[]; onCancel: () => void; onOk: (keys: string[]) => void }) {
  const [draft, setDraft] = useState(value);
  const groups = [...new Set(shortcutCatalog.map((item) => item.group))];
  function remove(key: string) { setDraft((current) => current.filter((item) => item !== key)); }
  function add(key: string) { setDraft((current) => current.includes(key) ? current : [...current, key]); }
  return <Modal title="添加快捷入口" open onCancel={onCancel} onOk={() => onOk(shortcutCatalog.map((item) => item.key).filter((key) => draft.includes(key)))} okText="确定" cancelText="取消" width={720} className="wp-shortcut-modal">
    <div className="wp-shortcut-section">
      <div className="wp-shortcut-section-title">已选快捷入口</div>
      <div className="wp-shortcut-selected-grid" data-testid="shortcut-selected">
        {draft.length ? draft.map((key) => {
          const item = shortcutCatalog.find((entry) => entry.key === key);
          return item ? <div key={key} className="wp-shortcut-tile" data-key={key}>
            <button type="button" className="wp-shortcut-tile-x" aria-label={`移除${item.label}`} onClick={() => remove(key)}>×</button>
            <ShortcutIcon label={item.label} icon={item.icon} />
            <span className="wp-shortcut-tile-label">{item.label}</span>
          </div> : null;
        }) : <span className="kgd-muted">点击下方分组添加入口</span>}
      </div>
    </div>
    <div className="wp-shortcut-section">
      <div className="wp-shortcut-section-title">可选快捷入口</div>
      <div className="wp-shortcut-scroll" data-testid="shortcut-optional-scroll">
        {groups.map((group) => <div key={group} className="wp-shortcut-group">
          <div className="wp-shortcut-group-title">{group}</div>
          <div className="wp-shortcut-group-items" data-testid={`shortcut-optional-${group}`}>
            {shortcutCatalog.filter((item) => item.group === group).map((item) => {
              const selected = draft.includes(item.key);
              return <button type="button" key={item.key} className={`wp-shortcut-pick ${selected ? 'is-disabled' : ''}`} disabled={selected} aria-disabled={selected} data-key={item.key} data-to={item.to ?? ''} onClick={() => { if (!selected) add(item.key); }}>
                <ShortcutIcon label={item.label} icon={item.icon} />
                <span className="wp-shortcut-tile-label">{item.label}</span>
              </button>;
            })}
          </div>
        </div>)}
      </div>
    </div>
  </Modal>;
}

function TodoEditModal({ value, onCancel, onOk }: { value: TodoPrefs; onCancel: () => void; onOk: (prefs: TodoPrefs) => void }) {
  const [draft, setDraft] = useState({ ...defaultTodoPrefs, ...value });
  return <Modal title="编辑待办事项" open onCancel={onCancel} onOk={() => onOk(draft)} okText="确定" cancelText="取消" width={520}>
    <p className="kgd-muted">选择要在待办卡片中显示的事项类型。</p>
    <div className="wp-todo-prefs">
      {todoMeta.map((item) => <label key={item.key} className="wp-todo-pref" style={{ borderColor: item.color }}>
        <span className="wp-todo-pref-swatch" style={{ background: item.color }} />
        <span className="wp-todo-pref-text"><b>{item.name}</b><span className="kgd-muted">{item.group}</span></span>
        <Switch checked={draft[item.key] !== false} onChange={(checked) => setDraft((current) => ({ ...current, [item.key]: checked }))} />
      </label>)}
    </div>
  </Modal>;
}
