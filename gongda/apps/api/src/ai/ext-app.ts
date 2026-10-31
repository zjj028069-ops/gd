/**
 * S3-B 一句话扩展应用：只写系统内配置（扩展字段 / 菜单 / 看板），可启用、停用、回退。
 * 不生成独立站点。业务对象优先复用加工单。
 * v1.0.34：加字段多步确认（位置 → 属性 → 写库预览）；拓展=扩展。
 * v1.0.36：列表加扩展字段改 guide-only（打开列表→演示点「扩展字段」→「新增」）；聊天不再出属性卡/写库预览。商品扩展与快递 lite 仍走写库。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../database.js';
import { Problem, type Actor } from '../services.js';
import { writeActionAudit } from './audit.js';
import {
  EXT_ENTITY_LABEL,
  parseExtUtterance as parseExtUtteranceRules,
  resolveExtUtterance,
  type ExtUtteranceParsed,
  type ListFilterSpec,
} from './ext-nlu.js';
import { appendAndPublishProductField, rollbackProductFieldVersion } from './product-ext-bridge.js';
import { summarizeToolSpec, type ToolSpec } from './shell-tool.js';

const ENTITY_LABEL = EXT_ENTITY_LABEL;

type FieldSpec = {
  name: string;
  field_type: string;
  choices?: string[];
  field_id?: string;
  required?: boolean;
  input_modes?: string[];
};


type AppSpec = {
  entity: string;
  fields: FieldSpec[];
  menu: boolean;
  view: { kind: 'form' | 'board' | 'lite'; title: string };
  utterance: string;
  list_filter?: ListFilterSpec;
  kind?: 'lite_express' | 'product_schema' | 'shell_tool';
  product_field_key?: string;
  product_schema_id?: string;
  product_previous_version_id?: string | null;
  template?: string;
  statuses?: string[];
  tool?: ToolSpec;
  placement?: 'sidebar' | 'chat_panel';
};

type AppRow = {
  id: string;
  code: string;
  title: string;
  utterance: string;
  entity: string;
  status: 'enabled' | 'disabled' | 'rolled_back';
  spec: AppSpec;
  field_ids: string[];
  menu_label: string;
  menu_path: string;
  created_at: string;
  updated_at: string;
};

type ConfirmCard = {
  title: string;
  summary: string;
  risk: string;
  actions: Array<'confirm' | 'cancel'>;
  target: 'ext_app';
  plan: true;
  /** 权限摘要：方案卡可见，强化「禁默认外网」 */
  permissions_summary?: string;
  /** 商用方案卡加厚：能做 / 不能做 / 算子 / 回退 */
  can_do?: string[];
  cannot_do?: string[];
  operators?: string[];
  rollback_hint?: string;
};

type Draft = {
  op: 'create' | 'create_lite' | 'create_shell_tool' | 'enable' | 'disable' | 'rollback';
  app_id?: string;
  spec: AppSpec;
  title: string;
  code: string;
  menu_label: string;
};

type ExtPreview = {
  id: string;
  tenant_id: string;
  draft: Draft;
  card: ConfirmCard;
};

const previews = new Map<string, ExtPreview>();

/** 常用字段类型（对齐 ExtensionAddDialog 常用项） */
const COMMON_FIELD_TYPES = [
  '单行文本',
  '多行文本',
  '数字输入框',
  '单选下拉框',
  '多选下拉框',
  '日期',
  '时间',
  '快递单号',
] as const;

type FieldAttrs = {
  name: string;
  required: boolean;
  field_type: string;
  choices?: string[];
  input_modes?: string[];
};

type ExtPendingStage = 'location' | 'attrs' | 'type_pick' | 'modes_pick' | 'choices_ask';

type ExtPending = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  stage: ExtPendingStage;
  utterance: string;
  draft: Draft;
  attrs: FieldAttrs;
};

const pendingExt = new Map<string, ExtPending>();
const PENDING_TTL_MS = 30 * 60 * 1000;

function purgePendingExt() {
  const now = Date.now();
  for (const [id, row] of pendingExt) {
    if (now - row.created_at > PENDING_TTL_MS) pendingExt.delete(id);
  }
}

export function resetExtAppsForTests() {
  previews.clear();
  pendingExt.clear();
}

export function peekExtAppPreview(previewId: string, tenantId: string) {
  const row = previews.get(previewId);
  if (!row || row.tenant_id !== tenantId) return null;
  return row;
}

export function discardExtAppPreview(previewId: string, tenantId: string) {
  const row = peekExtAppPreview(previewId, tenantId);
  if (!row) throw new Problem(404, 'PREVIEW_NOT_FOUND', '扩展方案预览已失效或不存在');
  previews.delete(previewId);
  return { ok: true as const };
}

function clip(value: string, max: number) {
  return value.trim().slice(0, max);
}

export type { ExtUtteranceParsed, ListFilterSpec } from './ext-nlu.js';
export { parseExtUtteranceRules as parseExtUtterance } from './ext-nlu.js';

function shape(row: {
  id: string;
  code: string;
  title: string;
  utterance: string;
  entity: string;
  status: AppRow['status'];
  spec: AppSpec | null;
  field_ids: unknown;
  menu_label: string;
  menu_path: string;
  created_at: string;
  updated_at: string;
}): AppRow {
  const ids = Array.isArray(row.field_ids) ? row.field_ids.map(String) : [];
  const spec = row.spec && typeof row.spec === 'object' ? row.spec : { entity: row.entity, fields: [], menu: false, view: { kind: 'form' as const, title: row.title }, utterance: row.utterance };
  return { ...row, spec, field_ids: ids };
}

async function loadApps(sql: Sql): Promise<AppRow[]> {
  const rows = (
    await sql.query<{
      id: string;
      code: string;
      title: string;
      utterance: string;
      entity: string;
      status: AppRow['status'];
      spec: AppSpec;
      field_ids: unknown;
      menu_label: string;
      menu_path: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id::text AS id, code, title, utterance, entity, status, spec, field_ids, menu_label, menu_path,
              created_at::text AS created_at, updated_at::text AS updated_at
       FROM ai_ext_apps
       ORDER BY created_at DESC`,
    )
  ).rows;
  return rows.map(shape);
}

export async function listExtApps(sql: Sql, status?: string) {
  const items = await loadApps(sql);
  const filtered = status ? items.filter((item) => item.status === status) : items;
  return {
    items: filtered.map((item) => ({
      ...item,
      menu_visible: item.status === 'enabled' && Boolean(item.menu_label),
    })),
    total: filtered.length,
  };
}

export async function getExtApp(sql: Sql, id: string) {
  const items = await loadApps(sql);
  const item = items.find((row) => row.id === id);
  if (!item) throw new Problem(404, 'EXT_APP_NOT_FOUND', '扩展应用不存在');
  return { item };
}

function codeOf(title: string) {
  const digest = createHash('sha256').update(title).digest('hex').slice(0, 10);
  return `ext_${digest}`;
}

function menuLabelOf(entity: string, fieldName: string, menu: boolean) {
  if (!menu) return '';
  return `${ENTITY_LABEL[entity] ?? '扩展'}·${fieldName}`;
}

function planSummary(draft: Draft) {
  const entityLabel = ENTITY_LABEL[draft.spec.entity] ?? draft.spec.entity;
  if (draft.op === 'create_shell_tool' && draft.spec.tool) {
    return summarizeToolSpec(draft.spec.tool);
  }
  if (draft.op === 'create_lite') {
    return [
      '将生成壳内应用「快递约件」（与计算器同一套：预览→确认→启用→回退；数据模型仍为 lite_express 特判，非 ToolSpec）',
      '能做：列表+新建约件；状态 待约/已寄/异常；寄件人从客户带；挂销售出库并带出货物摘要；手工填运单号回写出库「运单号」；侧栏与「我的工具」可见',
      '不能做：不调快递公司 API/不自动下单；不生成外挂独立站；不静默写合同/加工单/工资',
      '算子/能力：lite_express（记录 CRUD）+ sale_stock_out 运单号扩展字段回写',
      draft.menu_label ? `入口：「${draft.menu_label}」（MES 侧栏 + 聊天壳「我的工具」）` : '入口：不加入口',
      "回退：聊天说『回退该扩展』——约件记录、运单号字段与菜单一并清理，话术与壳内工具一致",
    ].join('；');
  }
  if (draft.op === 'create') {
    const fieldBits = draft.spec.fields.map((field) => {
      const choice = field.choices?.length ? `：${field.choices.join('/')}` : '';
      const req = field.required ? '必填' : '非必填';
      const modes =
        field.field_type === '单行文本' && field.input_modes?.length
          ? `，输入方式=${field.input_modes.join('+')}`
          : '';
      return `${field.name}（${field.field_type}${choice}，${req}${modes}）`;
    });
    const lf = draft.spec.list_filter;
    const listBit = lf
      ? `${entityLabel}列表增加筛选项：${lf.has_label}/${lf.none_label}`
      : '';
    const bits = [
      `对象：${entityLabel}（复用已有实体，不新建站点）`,
      fieldBits.length ? `扩展字段：${fieldBits.join('、')}` : '',
      draft.menu_label ? `菜单：生产管理侧栏增加「${draft.menu_label}」` : '菜单：不加侧栏入口',
      listBit,
      `视图：${draft.spec.view.kind === 'board' ? '看板' : '表单'}「${draft.spec.view.title}」`,
      '确认后状态为启用；可再停用或回退。',
      "回退：聊天说『回退该扩展』",
    ];
    return bits.filter(Boolean).join('；');
  }
  const verb = draft.op === 'rollback' ? '回退并删除该扩展字段与菜单' : draft.op === 'disable' ? '停用（字段与菜单先隐藏，配置保留）' : '重新启用';
  return `将对「${draft.title}」执行${verb}。回退：聊天说『回退该扩展』`;
}

function cardOf(draft: Draft): ConfirmCard {
  const isShell = draft.op === 'create_shell_tool';
  const isLite = draft.op === 'create_lite';
  const isSandbox = isShell && draft.spec.tool?.runtime === 'sandbox';
  const hasVision = isShell && (draft.spec.tool?.permissions as { vision?: boolean } | undefined)?.vision === true;
  const permissions_summary = isShell
    ? isSandbox
      ? '权限：由 DeepSeek 生成壳内沙箱工具；network=false；write_mes_entities=[]（默认不能写 MES）；只经 SedricBridge；可回退'
      : hasVision
        ? '权限：network=false；write_mes_entities=[]（确认前不写 MES）；vision 经宿主 DeepSeek-flash；可选复制字段；落进合同须走已有落单确认'
        : '权限：network=false（禁止默认外网）；write_mes_entities=[]（不写 MES 业务表）；禁止任意代码执行'
    : isLite
      ? '权限：沿用当前登录账号角色；确认前不写库；启用后可写 ai_lite_records 与出库运单号扩展值；启用/回退记审计；默认不调外网快递 API'
      : '权限：沿用当前登录账号角色；确认前不写库；启用/回退记审计';
  let title = '启用扩展方案预览';
  if (draft.op === 'create_shell_tool') title = '壳内工具方案预览';
  else if (draft.op === 'create_lite') title = '壳内约件方案预览';
  else if (draft.op === 'create') title = '扩展方案预览';
  else if (draft.op === 'rollback') title = '回退扩展方案预览';
  else if (draft.op === 'disable') title = '停用扩展方案预览';

  const shellPlacement = draft.spec.placement === 'sidebar' ? 'sidebar' : 'chat_panel';
  const openHint =
    shellPlacement === 'chat_panel'
      ? '聊天壳打开，不进 MES（「我的工具」浮层）'
      : 'MES 侧栏 +「我的工具」可打开';
  const can_do = isShell
    ? isSandbox
      ? [
          '由 DeepSeek 生成壳内沙箱工具（iframe + SedricBridge）',
          `默认不能写 MES；${openHint}；可一句话回退`,
        ]
      : hasVision
        ? [
            '选图片 → DeepSeek 识图抽字段 → 表格/表单可编辑',
            `确认前不写 MES；可选复制字段；${openHint}`,
          ]
        : [
            '按 Spec 在壳内生成小工具（计时/计算/表格/PDF/识图 等算子）',
            `${openHint}；可一句话回退`,
          ]
    : isLite
      ? [
          '壳内快递约件：列表 + 新建 + 状态机（待约/已寄/异常）',
          '寄件人从客户带、货物从出库单带；手工填运单号回写出库',
          '启用后出现在 MES 侧栏与聊天壳「我的工具」',
        ]
      : undefined;
  const cannot_do = isShell
    ? [
        '不静默写合同/加工单；iframe 内禁止任意 fetch MES',
        '缺算子时先尝试沙箱 codegen，仍失败才诚实说明；不掉说明书、不生成外挂站',
      ]
    : isLite
      ? [
          '不调快递公司 API、不自动下单',
          '不生成外挂独立站；不静默写合同/加工单/工资',
        ]
      : undefined;
  const operators = isShell && draft.spec.tool
    ? collectShellOps(draft.spec.tool)
    : isLite
      ? ['lite_express.records', 'sale_stock_out.ext:运单号']
      : undefined;
  const rollback_hint = "聊天说『回退该扩展』后入口消失（与壳内工具同一套话术）";

  return {
    title,
    summary: planSummary(draft),
    risk: isShell
      ? '确认前不写配置。壳内工具默认禁止外网与写 MES；取消不改任何东西。确认/回退均记审计，可一句话回退。'
      : isLite
        ? '确认前不写配置。启用后写入约件应用与运单号字段；取消不改任何东西。回退话术与计算器等壳内工具一致。无静默写合同/加工单/工资。'
        : '确认前不写配置。取消不会改字段、菜单或看板。启用与回退都会记入审计。无静默写合同/加工单/工资。',
    actions: ['confirm', 'cancel'],
    target: 'ext_app',
    plan: true,
    permissions_summary,
    can_do,
    cannot_do,
    operators,
    rollback_hint: isShell || isLite ? rollback_hint : undefined,
  };
}

function collectShellOps(tool: NonNullable<AppSpec['tool']>): string[] {
  try {
    const ops = new Set<string>();
    for (const w of tool.ui?.widgets || []) ops.add(String((w as { type?: string }).type || ''));
    for (const a of tool.actions || []) ops.add(String((a as { id?: string }).id || ''));
    return Array.from(ops).filter(Boolean);
  } catch {
    return [];
  }
}

function remember(actor: Actor, draft: Draft) {
  const card = cardOf(draft);
  const preview: ExtPreview = { id: randomUUID(), tenant_id: actor.tenant_id, draft, card };
  previews.set(preview.id, preview);
  return { preview_id: preview.id, confirm_card: card, written: false as const };
}

function matchApp(items: AppRow[], query: string) {
  const q = query.replace(/\s+/g, '');
  const pool = items.filter((item) => item.status !== 'rolled_back');
  if (!q) return pool[0] ?? null;
  return (
    pool.find((item) => item.title.includes(q) || q.includes(item.title) || item.menu_label.includes(q) || item.code.includes(q)) ??
    null
  );
}

async function draftFromParsed(
  sql: Sql,
  parsed: Exclude<ExtUtteranceParsed, { op: 'list' } | { op: 'not_ext' }>,
  utterance: string,
): Promise<Draft> {
  if (parsed.op === 'create_shell_tool') {
    const tool = parsed.tool;
    const title = tool.title || '壳内工具';
    // 与 shell-tool 默认对齐：缺省/chat_panel → 不进生产侧栏菜单
    const placement = tool.placement === 'sidebar' ? 'sidebar' : 'chat_panel';
    const spec: AppSpec = {
      entity: 'shell_tool',
      fields: [],
      menu: placement === 'sidebar', // chat_panel → menu:false，不进 MES 生产侧栏
      view: { kind: 'lite', title },
      utterance: clip(tool.utterance || utterance, 400),
      kind: 'shell_tool',
      tool,
      placement,
    };
    return {
      op: 'create_shell_tool',
      spec,
      title,
      code: codeOf(`shell_tool:${tool.id}`),
      // 「我的工具」轨仍用标题；MES 菜单仅 sidebar
      menu_label: title,
    };
  }
  if (parsed.op === 'create_lite') {
    const title = '快递约件';
    const spec: AppSpec = {
      entity: 'sale_stock_out',
      fields: [{ name: '运单号', field_type: '快递单号' }],
      menu: true,
      view: { kind: 'lite', title },
      utterance: clip(utterance, 400),
      kind: 'lite_express',
      template: parsed.template,
      statuses: ['待约', '已寄', '异常'],
    };
    return {
      op: 'create_lite',
      spec,
      title,
      code: codeOf(`lite:express_pickup`),
      // 产品口径：约件默认挂侧栏 +「我的工具」，与壳内工具统一入口
      menu_label: '快递约件',
    };
  }
  if (parsed.op === 'create') {
    const fieldName = clip(parsed.fieldName, 40);
    const title = `${ENTITY_LABEL[parsed.entity] ?? '扩展'}${fieldName}`;
    const listFilter =
      parsed.listFilter && typeof parsed.listFilter === 'object'
        ? parsed.listFilter
        : parsed.listFilter
          ? ({
              kind: 'presence' as const,
              chip_key: `ext_${fieldName}`,
              label: fieldName,
              has_label: fieldName.includes('备注') ? '有备注' : `有${fieldName}`,
              none_label: fieldName.includes('备注') ? '无备注' : `无${fieldName}`,
            } satisfies ListFilterSpec)
          : undefined;
    const isProduct = parsed.entity === 'product' || Boolean((parsed as { productSchema?: boolean }).productSchema);
    const spec: AppSpec = {
      entity: parsed.entity,
      fields: [{
        name: fieldName,
        field_type: parsed.fieldType,
        choices: parsed.choices,
        required: false,
        input_modes: parsed.fieldType === '单行文本' ? ['手动输入'] : undefined,
      }],
      menu: parsed.menu,
      view: { kind: parsed.board ? 'board' : 'form', title },
      utterance: clip(utterance, 400),
      ...(listFilter ? { list_filter: listFilter } : {}),
      ...(isProduct ? { kind: 'product_schema' as const } : {}),
    };
    return {
      op: 'create',
      spec,
      title,
      code: codeOf(`${parsed.entity}:${fieldName}`),
      menu_label: menuLabelOf(parsed.entity, fieldName, parsed.menu),
    };
  }
  const items = await loadApps(sql);
  const app = matchApp(items, parsed.query);
  if (!app) throw new Problem(404, 'EXT_APP_NOT_FOUND', '没有可操作的扩展应用');
  if (parsed.op === 'enable' && app.status === 'enabled') throw new Problem(409, 'ALREADY_ENABLED', '该扩展已是启用状态');
  if (parsed.op === 'disable' && app.status !== 'enabled') throw new Problem(409, 'NOT_ENABLED', '只有启用中的扩展可以停用');
  return { op: parsed.op, app_id: app.id, spec: app.spec, title: app.title, code: app.code, menu_label: app.menu_label };
}


function attrsFromDraft(draft: Draft): FieldAttrs {
  const field = draft.spec.fields[0];
  const field_type = field?.field_type || '单行文本';
  return {
    name: field?.name || draft.title,
    required: Boolean(field?.required),
    field_type,
    choices: field?.choices,
    input_modes:
      field_type === '单行文本'
        ? field?.input_modes?.length
          ? field.input_modes
          : ['手动输入']
        : undefined,
  };
}

function applyAttrsToDraft(draft: Draft, attrs: FieldAttrs): Draft {
  const fields: FieldSpec[] = [
    {
      name: clip(attrs.name, 40),
      field_type: attrs.field_type,
      choices: attrs.choices,
      required: attrs.required,
      input_modes: attrs.field_type === '单行文本' ? attrs.input_modes || ['手动输入'] : undefined,
    },
  ];
  const title = `${ENTITY_LABEL[draft.spec.entity] ?? '扩展'}${attrs.name}`;
  return {
    ...draft,
    title,
    code: codeOf(`${draft.spec.entity}:${attrs.name}`),
    menu_label: menuLabelOf(draft.spec.entity, attrs.name, draft.spec.menu),
    spec: {
      ...draft.spec,
      fields,
      view: { ...draft.spec.view, title },
    },
  };
}

function attrsSummary(attrs: FieldAttrs) {
  const modes =
    attrs.field_type === '单行文本'
      ? `；输入方式=${(attrs.input_modes || ['手动输入']).join('+')}`
      : '';
  const choices = attrs.choices?.length ? `；选项=${attrs.choices.join('/')}` : '';
  return `字段名=${attrs.name}；必填=${attrs.required ? '是' : '否'}；类型=${attrs.field_type}${modes}${choices}`;
}

function locationAskPayload(pending: ExtPending) {
  const label = ENTITY_LABEL[pending.draft.spec.entity] ?? pending.draft.spec.entity;
  const open = entityOpenPath(pending.draft.spec.entity);
  const question =
    `将在【${label}】列表工具栏的「扩展字段」里新增字段「${pending.attrs.name}」。` +
    `是在这个区域增加吗？（与 MES「扩展字段 → 新增扩展字段」同一入口）`;
  return {
    handled: true as const,
    mode: 'ask' as const,
    domain: 'ext_app' as const,
    written: false as const,
    ask_id: pending.id,
    ext_ask_kind: 'location' as const,
    text: question,
    ask: {
      question,
      options: [
        { id: 'yes_location', label: '是，继续' },
        { id: 'no_location', label: '不是' },
      ],
    },
    open_path: open.path,
    open_label: open.label,
    navigate_hint: true as const,
  };
}

function attrsAskPayload(pending: ExtPending) {
  const question =
    `请确认字段属性（与 MES 弹窗「新增扩展字段」一致）：${attrsSummary(pending.attrs)}。` +
    `可先在右侧列表点工具栏「扩展字段」对照；确认后才会出写库前预览。`;
  const options: Array<{ id: string; label: string }> = [
    { id: 'confirm_attrs', label: '按当前属性继续' },
    { id: 'toggle_required', label: pending.attrs.required ? '改为非必填' : '改为必填' },
    { id: 'pick_type', label: '改字段类型' },
  ];
  if (pending.attrs.field_type === '单行文本') {
    options.push({ id: 'pick_modes', label: '改输入方式' });
  }
  if (pending.attrs.field_type === '单选下拉框' || pending.attrs.field_type === '多选下拉框') {
    options.push({ id: 'choices_default', label: '选项用「是/否」' });
  }
  options.push({ id: 'cancel', label: '取消' });
  return {
    handled: true as const,
    mode: 'ask' as const,
    domain: 'ext_app' as const,
    written: false as const,
    ask_id: pending.id,
    ext_ask_kind: 'attrs' as const,
    text: question,
    ask: { question, options },
  };
}

function typePickAskPayload(pending: ExtPending) {
  const question = `请选择字段类型（当前：${pending.attrs.field_type}）`;
  return {
    handled: true as const,
    mode: 'ask' as const,
    domain: 'ext_app' as const,
    written: false as const,
    ask_id: pending.id,
    ext_ask_kind: 'type_pick' as const,
    text: question,
    ask: {
      question,
      options: [
        ...COMMON_FIELD_TYPES.map((t) => ({ id: `type:${t}`, label: t })),
        { id: 'back_attrs', label: '返回属性确认' },
      ],
    },
  };
}

function modesPickAskPayload(pending: ExtPending) {
  const question = `单行文本的输入方式？（当前：${(pending.attrs.input_modes || ['手动输入']).join('+')}）`;
  return {
    handled: true as const,
    mode: 'ask' as const,
    domain: 'ext_app' as const,
    written: false as const,
    ask_id: pending.id,
    ext_ask_kind: 'modes_pick' as const,
    text: question,
    ask: {
      question,
      options: [
        { id: 'modes:manual', label: '手动输入' },
        { id: 'modes:scan', label: '扫码输入' },
        { id: 'modes:both', label: '手动+扫码' },
        { id: 'back_attrs', label: '返回属性确认' },
      ],
    },
  };
}


/** 列表加字段：只打开入口 + 演示指引，不进入 location/attrs/写库多步 */
function guideOpenAddPayload(draft: Draft) {
  const entity = draft.spec.entity;
  const label = ENTITY_LABEL[entity] ?? entity;
  const open = entityExtListOpenPath(entity);
  const fieldName = clip(draft.spec.fields[0]?.name || '', 40);
  const suggest =
    fieldName && fieldName !== '字段'
      ? `建议字段名：${fieldName}。`
      : '';
  const guideText =
    `已打开【${label}】列表的「扩展字段」入口，请按演示点击工具栏「扩展字段」→ 弹窗里「新增」，` +
    `在 MES 弹窗自行填写字段名等并确定。${suggest}聊天侧不再代填属性、也不写库。`;
  return {
    handled: true as const,
    mode: 'guide' as const,
    domain: 'ext_app' as const,
    written: false as const,
    text: guideText,
    open_path: open.path,
    open_label: open.label,
    navigate_hint: true as const,
    demo_id: 'ext-field-add' as const,
    suggest_field_name: fieldName || undefined,
    entity,
    feature: 'ext-guide-open-add' as const,
  };
}

function startLocationPending(actor: Actor, draft: Draft, utterance: string) {
  purgePendingExt();
  const attrs = attrsFromDraft(draft);
  const id = randomUUID();
  const pending: ExtPending = {
    id,
    tenant_id: actor.tenant_id,
    actor_id: actor.user_id,
    created_at: Date.now(),
    stage: 'location',
    utterance: clip(utterance, 400),
    draft,
    attrs,
  };
  pendingExt.set(id, pending);
  return locationAskPayload(pending);
}

export async function previewExtChat(sql: Sql, actor: Actor, text: string) {
  const parsed = await resolveExtUtterance(text);
  if (!parsed) return { handled: false as const };
  if (parsed.op === 'not_ext') {
    return {
      handled: true as const,
      mode: 'read' as const,
      domain: 'ext_app' as const,
      text: parsed.reason || '这句话不像扩展需求。可以说「给合同加一个货源地字段」或「给商品列表加货源地」。',
      written: false as const,
    };
  }
  if (parsed.op === 'list') {
    const listed = await listExtApps(sql);
    const lines = listed.items.length
      ? listed.items.map((item) => `${item.title}（${item.status === 'enabled' ? '启用' : item.status === 'disabled' ? '停用' : '已回退'}）`).join('；')
      : '还没有扩展应用。可以说「给加工单加一个紧急度字段并进菜单」。';
    return {
      handled: true as const,
      mode: 'read' as const,
      domain: 'ext_app' as const,
      text: `扩展应用 ${listed.total} 个。${lines}`,
      items: listed.items,
      written: false as const,
    };
  }
  let draft;
  try {
    draft = await draftFromParsed(sql, parsed, text);
  } catch (error) {
    if (error instanceof Problem && error.code === 'EXT_APP_NOT_FOUND') {
      return {
        handled: true as const,
        mode: 'read' as const,
        domain: 'ext_app' as const,
        text: '当前没有可回退/启停的扩展应用。可以说「扩展应用有哪些」查看，或先说「给联系人加一个字段」生成方案。',
        written: false as const,
      };
    }
    throw error;
  }
  // 列表加字段：guide-only（打开列表→演示扩展字段→新增）；商品扩展仍走位置/属性/写库；lite/回退/启停仍出确认卡
  if (draft.op === 'create') {
    const isProduct = draft.spec.kind === 'product_schema' || draft.spec.entity === 'product';
    if (isProduct) {
      const ask = startLocationPending(actor, draft, text);
      await writeActionAudit(sql, actor, {
        action: 'ext_app.location_ask',
        preview_id: ask.ask_id,
        payload: { op: draft.op, title: draft.title, entity: draft.spec.entity },
        result: 'preview',
        target_table: 'ai_ext_apps',
        document_code: draft.code,
      });
      return ask;
    }
    const guide = guideOpenAddPayload(draft);
    await writeActionAudit(sql, actor, {
      action: 'ext_app.guide_open_add',
      preview_id: null,
      payload: {
        op: draft.op,
        title: draft.title,
        entity: draft.spec.entity,
        open_path: guide.open_path,
        demo_id: guide.demo_id,
        suggest_field_name: guide.suggest_field_name,
        feature: 'ext-guide-open-add',
      },
      result: 'preview',
      target_table: 'ai_ext_apps',
      document_code: draft.code,
    });
    return guide;
  }
  const saved = remember(actor, draft);
  await writeActionAudit(sql, actor, {
    action: 'ext_app.preview',
    preview_id: saved.preview_id,
    payload: { op: draft.op, title: draft.title },
    result: 'preview',
    target_table: 'ai_ext_apps',
    document_code: draft.code,
  });
  return { handled: true as const, mode: 'preview' as const, domain: 'ext_app' as const, text: saved.confirm_card.summary, ...saved };
}

/** 把按钮文案 / 别名归一成内部 option id，避免前端误传 label 或旧卡连点 */
function normalizeExtOptionId(raw: string, stage: ExtPendingStage): string {
  const s = raw.trim();
  if (!s) return s;
  const aliases: Record<string, string> = {
    yes_location: 'yes_location',
    '是，继续': 'yes_location',
    '是,继续': 'yes_location',
    '是继续': 'yes_location',
    是: 'yes_location',
    yes: 'yes_location',
    continue: 'yes_location',
    no_location: 'no_location',
    不是: 'no_location',
    否: 'no_location',
    no: 'no_location',
    confirm_attrs: 'confirm_attrs',
    '按当前属性继续': 'confirm_attrs',
    确认: 'confirm_attrs',
    toggle_required: 'toggle_required',
    改为必填: 'toggle_required',
    改为非必填: 'toggle_required',
    pick_type: 'pick_type',
    改字段类型: 'pick_type',
    pick_modes: 'pick_modes',
    改输入方式: 'pick_modes',
    choices_default: 'choices_default',
    '选项用「是/否」': 'choices_default',
    cancel: 'cancel',
    取消: 'cancel',
    back_attrs: 'back_attrs',
    返回属性确认: 'back_attrs',
  };
  if (aliases[s]) return aliases[s];
  // 属性卡阶段：把「是，继续」视作确认属性（用户常连点旧文案）
  if (stage !== 'location' && (s === '是，继续' || s === '是,继续' || s === '是继续')) {
    return 'confirm_attrs';
  }
  return s;
}

/** 多步确认决议：位置 → 属性 → 写库预览卡 */
export async function resolveExtAsk(
  sql: Sql,
  actor: Actor,
  body: { ask_id?: unknown; option_id?: unknown },
) {
  purgePendingExt();
  const askId = typeof body.ask_id === 'string' ? body.ask_id.trim() : '';
  const rawOptionId = typeof body.option_id === 'string' ? body.option_id.trim() : '';
  if (!askId) throw new Problem(422, 'ASK_REQUIRED', '请提供 ask_id');
  if (!rawOptionId) throw new Problem(422, 'OPTION_REQUIRED', '请选择选项');
  const pending = pendingExt.get(askId);
  if (!pending || pending.tenant_id !== actor.tenant_id) {
    throw new Problem(404, 'ASK_NOT_FOUND', '确认已失效，请重新说一句话');
  }
  const optionId = normalizeExtOptionId(rawOptionId, pending.stage);

  if (optionId === 'cancel' || optionId === 'no_location') {
    pendingExt.delete(askId);
    await writeActionAudit(sql, actor, {
      action: 'ext_app.ask_cancel',
      preview_id: askId,
      payload: { option_id: optionId, stage: pending.stage },
      result: 'cancelled',
      target_table: 'ai_ext_apps',
      document_code: pending.draft.code,
    });
    return {
      ok: true as const,
      action: 'cancel' as const,
      written: false as const,
      text:
        optionId === 'no_location'
          ? '好的，未在该「扩展字段」入口新增。若入口不对，请说明正确单据或重新描述。'
          : '已取消，未写入任何扩展配置。',
    };
  }

  if (optionId === 'yes_location') {
    // 幂等：已过位置确认时再点「是，继续」直接重回属性卡，避免旧卡连点报「无法识别该选项」
    if (pending.stage === 'location') {
      pending.stage = 'attrs';
      pending.created_at = Date.now();
    }
    const payload = attrsAskPayload(pending);
    const open = entityOpenPath(pending.draft.spec.entity);
    return {
      ...payload,
      open_path: open.path,
      open_label: open.label,
      navigate_hint: true as const,
      mes_guide: {
        kind: 'highlight_toolbar' as const,
        text: '扩展字段',
        hint: '请在列表工具栏点击「扩展字段」，与聊天里属性确认同一入口',
      },
    };
  }

  if (optionId === 'back_attrs') {
    pending.stage = 'attrs';
    pending.created_at = Date.now();
    return attrsAskPayload(pending);
  }

  if (optionId === 'toggle_required') {
    pending.attrs.required = !pending.attrs.required;
    pending.stage = 'attrs';
    pending.created_at = Date.now();
    return attrsAskPayload(pending);
  }

  if (optionId === 'pick_type') {
    pending.stage = 'type_pick';
    pending.created_at = Date.now();
    return typePickAskPayload(pending);
  }

  if (optionId === 'pick_modes') {
    pending.stage = 'modes_pick';
    pending.created_at = Date.now();
    return modesPickAskPayload(pending);
  }

  if (optionId === 'choices_default') {
    pending.attrs.choices = ['是', '否'];
    pending.stage = 'attrs';
    pending.created_at = Date.now();
    return attrsAskPayload(pending);
  }

  if (optionId.startsWith('type:')) {
    const fieldType = optionId.slice('type:'.length);
    if (!(COMMON_FIELD_TYPES as readonly string[]).includes(fieldType)) {
      throw new Problem(422, 'FIELD_TYPE', '不支持的字段类型');
    }
    pending.attrs.field_type = fieldType;
    if (fieldType === '单行文本') {
      pending.attrs.input_modes = pending.attrs.input_modes?.length ? pending.attrs.input_modes : ['手动输入'];
    } else {
      pending.attrs.input_modes = undefined;
    }
    if (fieldType === '单选下拉框' || fieldType === '多选下拉框') {
      if (!pending.attrs.choices || pending.attrs.choices.length < 2) {
        pending.attrs.choices = ['是', '否'];
      }
    } else {
      pending.attrs.choices = undefined;
    }
    pending.stage = 'attrs';
    pending.created_at = Date.now();
    return attrsAskPayload(pending);
  }

  if (optionId.startsWith('modes:')) {
    const key = optionId.slice('modes:'.length);
    if (key === 'manual') pending.attrs.input_modes = ['手动输入'];
    else if (key === 'scan') pending.attrs.input_modes = ['扫码输入'];
    else if (key === 'both') pending.attrs.input_modes = ['手动输入', '扫码输入'];
    else throw new Problem(422, 'INPUT_MODE', '不支持的输入方式');
    pending.stage = 'attrs';
    pending.created_at = Date.now();
    return attrsAskPayload(pending);
  }

  if (optionId === 'confirm_attrs') {
    if (!pending.attrs.name.trim()) throw new Problem(422, 'FIELD_NAME', '字段名不能为空');
    if (
      (pending.attrs.field_type === '单选下拉框' || pending.attrs.field_type === '多选下拉框') &&
      (!pending.attrs.choices || pending.attrs.choices.length < 2)
    ) {
      pending.attrs.choices = ['是', '否'];
    }
    if (pending.attrs.field_type === '单行文本' && !pending.attrs.input_modes?.length) {
      pending.attrs.input_modes = ['手动输入'];
    }
    const draft = applyAttrsToDraft(pending.draft, pending.attrs);
    pendingExt.delete(askId);
    const saved = remember(actor, draft);
    await writeActionAudit(sql, actor, {
      action: 'ext_app.preview',
      preview_id: saved.preview_id,
      payload: {
        op: draft.op,
        title: draft.title,
        attrs: pending.attrs,
        via: 'attrs_confirm',
      },
      result: 'preview',
      target_table: 'ai_ext_apps',
      document_code: draft.code,
    });
    return {
      handled: true as const,
      mode: 'preview' as const,
      domain: 'ext_app' as const,
      written: false as const,
      text: saved.confirm_card.summary,
      ...saved,
    };
  }

  throw new Problem(422, 'OPTION_UNKNOWN', `无法识别该选项（${rawOptionId} / stage=${pending.stage}）`);
}


export async function previewExtStructured(
  sql: Sql,
  actor: Actor,
  body: { text?: unknown; op?: unknown; id?: unknown },
) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text) {
    const parsed = await resolveExtUtterance(text);
    if (!parsed || parsed.op === 'list' || parsed.op === 'not_ext') {
      throw new Problem(422, 'UTTERANCE', '这句话还不能生成扩展方案');
    }
    const draft = await draftFromParsed(sql, parsed, text);
    const saved = remember(actor, draft);
    return { ...saved, mode: 'preview' as const };
  }
  const op = body.op === 'enable' || body.op === 'disable' || body.op === 'rollback' ? body.op : '';
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!op || !id) throw new Problem(422, 'EXT_PREVIEW', '请提供一句话，或指定扩展与操作');
  const items = await loadApps(sql);
  const app = items.find((item) => item.id === id);
  if (!app) throw new Problem(404, 'EXT_APP_NOT_FOUND', '扩展应用不存在');
  const draft: Draft = { op, app_id: app.id, spec: app.spec, title: app.title, code: app.code, menu_label: app.menu_label };
  const saved = remember(actor, draft);
  await writeActionAudit(sql, actor, {
    action: 'ext_app.preview',
    preview_id: saved.preview_id,
    payload: { op, id },
    result: 'preview',
    target_table: 'ai_ext_apps',
    document_code: app.code,
  });
  return { ...saved, mode: 'preview' as const };
}

async function setSuppressed(sql: Sql, fieldIds: string[], suppressed: boolean) {
  if (!fieldIds.length) return;
  await sql.query(
    `UPDATE entity_ext_fields
     SET options = coalesce(options,'{}'::jsonb) || $2::jsonb, updated_at=now()
     WHERE id = ANY($1::uuid[])`,
    [fieldIds, JSON.stringify({ sedric_suppressed: suppressed })],
  );
}


function entityOpenPath(entity: string): { path: string; label: string } {
  if (entity === 'customer_contract') return { path: '/customer_contract/list', label: '打开合同列表' };
  if (entity === 'work_order') return { path: '/inside_produce_bill/add?mode=direct', label: '打开新建加工单' };
  if (entity === 'sale_stock_out') return { path: '/sale_stock_out_bill/list', label: '打开销售出库列表' };
  if (entity === 'customer') return { path: '/customer/list', label: '打开客户列表' };
  if (entity === 'supplier') return { path: '/supplier/list', label: '打开供应商列表' };
  if (entity === 'craft') return { path: '/craft/list', label: '打开工序管理' };
  if (entity === 'bom') return { path: '/bom/list', label: '打开BOM列表' };
  if (entity === 'purchase_order') return { path: '/purchase_order/list', label: '打开采购单列表' };
  if (entity === 'production_plan') return { path: '/production_plan/list', label: '打开生产计划' };
  if (entity === 'linkman') return { path: '/linkman/list', label: '打开联系人列表' };
  if (entity === 'product') return { path: '/goods/list', label: '打开商品列表' };
  return { path: '/ai/ext-apps', label: '打开扩展应用' };
}

/** 列表「扩展字段」入口页（与写库后 aftercare 的新建页可能不同） */
function entityExtListOpenPath(entity: string): { path: string; label: string } {
  if (entity === 'work_order') return { path: '/inside_produce_bill/list', label: '打开加工单列表' };
  if (entity === 'craft') return { path: '/public_craft/list', label: '打开工序管理' };
  return entityOpenPath(entity);
}

function buildExtAfterCare(input: {
  op: Draft['op'];
  title: string;
  entity?: string;
  menu_label?: string;
  menu_path?: string;
  list_filter?: AppSpec['list_filter'];
  fields?: FieldSpec[];
  kind?: string;
  placement?: 'sidebar' | 'chat_panel';
}): {
  open_path: string;
  open_label: string;
  secondary_path?: string;
  secondary_label?: string;
  guide_lines: string[];
  shell_tool?: boolean;
  placement?: 'sidebar' | 'chat_panel';
} {
  if (input.op === 'rollback') {
    return {
      open_path: '/ai/ext-apps',
      open_label: '查看扩展应用',
      guide_lines: ['扩展已回退，对应字段/菜单已恢复。', '可在「AI智能体 → 扩展应用」核对列表。'],
    };
  }
  if (input.op === 'disable') {
    return {
      open_path: '/ai/ext-apps',
      open_label: '查看扩展应用',
      guide_lines: ['扩展已停用，字段与菜单暂时隐藏。', '需要时聊天说「启用该扩展」。'],
    };
  }
  if (input.op === 'create_shell_tool' || input.kind === 'shell_tool') {
    const path = input.menu_path || '';
    const placement = input.placement === 'sidebar' ? 'sidebar' : 'chat_panel';
    return {
      open_path: path || undefined,
      open_label: placement === 'chat_panel' ? '在聊天壳打开（不进 MES）' : `打开「${input.title}」`,
      guide_lines: [
        `1. 已按 Spec 生成壳内工具「${input.title}」（非预制开关）。`,
        placement === 'chat_panel'
          ? '2. 聊天壳打开，不进 MES：点「我的工具」浮层运行。'
          : '2. 点下方按钮或侧栏入口打开工具页运行。',
        '3. 不需要时聊天说「回退该扩展」，入口会消失。',
      ],
      shell_tool: true,
      placement,
    };
  }
  if (input.op === 'create_lite' || input.kind === 'lite_express') {
    const path = input.menu_path || '/ai/ext-apps';
    return {
      open_path: path,
      open_label: '打开快递约件',
      secondary_path: '/sale_stock_out_bill/list',
      secondary_label: '打开出库列表',
      guide_lines: [
        '1. 点下方「打开快递约件」，或在聊天壳左侧「我的工具」点「快递约件」（与计算器同一入口）。',
        '2. 新建约件：选择客户（寄件人）、挂销售出库单，货物摘要会带出。',
        '3. 填好运单号并保存，会回写到该出库单的「运单号」扩展字段。',
        '4. 状态可在 待约 / 已寄 / 异常 间切换；不需要时聊天说「回退该扩展」（话术与壳内工具一致）。',
      ],
    };
  }
  const entity = input.entity || 'work_order';
  const primary = entityOpenPath(entity);
  const fieldNames = (input.fields || []).map((f) => f.name).filter(Boolean);
  const fieldHint = fieldNames.length ? fieldNames.join('、') : '扩展字段';
  const lines: string[] = [];
  if (entity === 'customer_contract') {
    lines.push(`1. 点下方「${primary.label}」。`);
    lines.push(`2. 新建或点开已有合同，在表单中填写「${fieldHint}」并保存。`);
    if (input.list_filter) {
      lines.push(`3. 回到合同列表，用「${input.list_filter.has_label || '有备注'} / ${input.list_filter.none_label || '无备注'}」筛选核对。`);
      lines.push('4. 不需要时聊天说「回退该扩展」。');
    } else {
      lines.push('3. 不需要时聊天说「回退该扩展」。');
    }
  } else if (entity === 'work_order') {
    lines.push(`1. 点下方「${primary.label}」（或从侧栏「加工单」进入）。`);
    lines.push(`2. 在表单中填写「${fieldHint}」并保存。`);
    if (input.menu_label) lines.push(`3. 侧栏可看到「${input.menu_label}」入口。`);
    lines.push(`${input.menu_label ? '4' : '3'}. 不需要时聊天说「回退该扩展」。`);
  } else if (entity === 'product' || input.kind === 'product_schema') {
    lines.push(`1. 点下方「${primary.label}」。`);
    lines.push(`2. 新建或编辑商品，在「产品扩展信息」中填写「${fieldHint}」并保存。`);
    lines.push('3. 列表可按视图配置显示该扩展列（商品设置/视图）。');
    lines.push('4. 不需要时聊天说「回退该扩展」。');
  } else {
    lines.push(`1. 点下方「${primary.label}」核对「${fieldHint}」。`);
    lines.push('2. 不需要时聊天说「回退该扩展」。');
  }
  const care: {
    open_path: string;
    open_label: string;
    secondary_path?: string;
    secondary_label?: string;
    guide_lines: string[];
  } = {
    open_path: primary.path,
    open_label: primary.label,
    guide_lines: lines,
  };
  if (input.menu_path && input.menu_label) {
    care.secondary_path = input.menu_path;
    care.secondary_label = `打开「${input.menu_label}」`;
  }
  return care;
}

function withAfterCare<T extends Record<string, unknown>>(base: T, care: ReturnType<typeof buildExtAfterCare>): T & ReturnType<typeof buildExtAfterCare> {
  return { ...base, ...care };
}

export async function confirmExtAppWrite(sql: Sql, actor: Actor, previewId: string) {
  const preview = peekExtAppPreview(previewId, actor.tenant_id);
  if (!preview) throw new Problem(404, 'PREVIEW_NOT_FOUND', '扩展方案预览已失效或不存在');
  const draft = preview.draft;
  if (draft.op === 'create_shell_tool') {
    if (!draft.spec.tool) throw new Problem(422, 'TOOL_SPEC', '缺少 ToolSpec');
    const existing = (
      await sql.query<{ id: string; status: string }>('SELECT id::text AS id, status FROM ai_ext_apps WHERE code=$1', [
        draft.code,
      ])
    ).rows;
    if (existing.some((row) => row.status !== 'rolled_back')) {
      throw new Problem(409, 'DUPLICATE', '同名壳内工具已存在，请先回退或换个名字');
    }
    for (const old of existing) {
      await sql.query(
        `UPDATE ai_ext_apps SET code = code || '-rb-' || substr(id::text, 1, 8) WHERE id=$1`,
        [old.id],
      );
    }
    const placement = draft.spec.placement === 'sidebar' ? 'sidebar' : 'chat_panel';
    const appId = (
      await sql.query<{ id: string }>(
        `INSERT INTO ai_ext_apps(
           tenant_id, code, title, utterance, entity, status, spec, field_ids, menu_label, menu_path, created_by
         ) VALUES ($1,$2,$3,$4,'shell_tool','enabled',$5::jsonb,'[]'::jsonb,$6,$7,$8)
         RETURNING id::text AS id`,
        [
          actor.tenant_id,
          draft.code,
          draft.title,
          draft.spec.utterance,
          JSON.stringify({ ...draft.spec, kind: 'shell_tool', tool: draft.spec.tool, placement, menu: placement === 'sidebar' }),
          draft.menu_label || draft.title,
          '',
          actor.user_id,
        ],
      )
    ).rows[0]!.id;
    // sidebar 才挂 MES 路径；chat_panel 清空 menu_path，避免生产侧栏/iframe
    const menuPath = placement === 'sidebar' ? `/ai/shell-tool/${appId}` : '';
    const spec = { ...draft.spec, kind: 'shell_tool' as const, tool: draft.spec.tool, placement };
    await sql.query(
      `UPDATE ai_ext_apps SET menu_path=$2, spec=$3::jsonb, updated_at=now() WHERE id=$1`,
      [appId, menuPath, JSON.stringify(spec)],
    );
    await writeActionAudit(sql, actor, {
      action: 'shell_tool.confirm',
      preview_id: previewId,
      payload: { op: 'create_shell_tool', app_id: appId, tool_id: draft.spec.tool.id, title: draft.title },
      result: 'ok',
      target_table: 'ai_ext_apps',
      document_code: draft.code,
      meta: { capability: 'shell_tool', placement, widgets: draft.spec.tool.ui.widgets.map((w) => w.type) },
    });
    previews.delete(previewId);
    return withAfterCare(
      {
        app_id: appId,
        op: 'create_shell_tool' as const,
        status: 'enabled' as const,
        field_ids: [] as string[],
        menu_label: draft.menu_label || draft.title,
        menu_path: menuPath,
        title: draft.title,
        entity: 'shell_tool',
        kind: 'shell_tool',
        placement,
        tool: draft.spec.tool,
        message: `已启用壳内工具「${draft.title}」`,
      },
      buildExtAfterCare({
        op: 'create_shell_tool',
        title: draft.title,
        menu_label: draft.menu_label || draft.title,
        menu_path: menuPath,
        kind: 'shell_tool',
        placement,
      }),
    );
  }
  if (draft.op === 'create_lite') {
    const existing = (
      await sql.query<{ id: string; status: string }>('SELECT id::text AS id, status FROM ai_ext_apps WHERE code=$1', [
        draft.code,
      ])
    ).rows;
    if (existing.some((row) => row.status !== 'rolled_back')) {
      throw new Problem(409, 'DUPLICATE', '快递约件扩展已存在，请先回退');
    }
    for (const old of existing) {
      await sql.query(
        `UPDATE ai_ext_apps SET code = code || '-rb-' || substr(id::text, 1, 8) WHERE id=$1`,
        [old.id],
      );
    }
    const appId = (
      await sql.query<{ id: string }>(
        `INSERT INTO ai_ext_apps(
           tenant_id, code, title, utterance, entity, status, spec, field_ids, menu_label, menu_path, created_by
         ) VALUES ($1,$2,$3,$4,$5,'enabled',$6::jsonb,'[]'::jsonb,$7,$8,$9)
         RETURNING id::text AS id`,
        [
          actor.tenant_id,
          draft.code,
          draft.title,
          draft.spec.utterance,
          'sale_stock_out',
          JSON.stringify(draft.spec),
          draft.menu_label,
          '',
          actor.user_id,
        ],
      )
    ).rows[0]!.id;
    const menuPath = `/ai/lite/${appId}`;
    // 运单号扩展字段挂 sale_stock_out（不走 lite_app）
    let fieldId = '';
    const existedField = (
      await sql.query<{ id: string }>(
        `SELECT id::text AS id FROM entity_ext_fields
         WHERE entity='sale_stock_out' AND name='运单号' LIMIT 1`,
      )
    ).rows[0];
    if (existedField) {
      fieldId = existedField.id;
      await sql.query(
        `UPDATE entity_ext_fields
         SET options = coalesce(options,'{}'::jsonb) || $2::jsonb, updated_at=now()
         WHERE id=$1`,
        [fieldId, JSON.stringify({ sedric_app_id: appId, sedric_suppressed: false })],
      );
    } else {
      try {
        fieldId = (
          await sql.query<{ id: string }>(
            `INSERT INTO entity_ext_fields(tenant_id, entity, name, field_type, required, sort_no, options)
             VALUES ($1,'sale_stock_out','运单号','快递单号',false,200,$2::jsonb)
             RETURNING id::text AS id`,
            [
              actor.tenant_id,
              JSON.stringify({ sedric_app_id: appId, sedric_suppressed: false }),
            ],
          )
        ).rows[0]!.id;
      } catch (error) {
        if (String((error as { code?: string }).code) === '23505') {
          throw new Problem(409, 'DUPLICATE', '「运单号」字段已存在');
        }
        throw error;
      }
    }
    const fieldIds = fieldId ? [fieldId] : [];
    const createdFields = draft.spec.fields.map((field) =>
      field.name === '运单号' ? { ...field, field_id: fieldId } : field,
    );
    const spec = { ...draft.spec, fields: createdFields, kind: 'lite_express' as const };
    await sql.query(
      `UPDATE ai_ext_apps SET menu_path=$2, field_ids=$3::jsonb, spec=$4::jsonb, updated_at=now() WHERE id=$1`,
      [appId, menuPath, JSON.stringify(fieldIds), JSON.stringify(spec)],
    );
    previews.delete(previewId);
    return withAfterCare(
      {
        app_id: appId,
        op: 'create_lite' as const,
        status: 'enabled' as const,
        field_id: fieldId,
        field_ids: fieldIds,
        menu_label: draft.menu_label,
        menu_path: menuPath,
        title: draft.title,
        entity: 'sale_stock_out',
        message: `已启用壳内应用「${draft.title}」`,
      },
      buildExtAfterCare({
        op: 'create_lite',
        title: draft.title,
        menu_label: draft.menu_label,
        menu_path: menuPath,
        kind: 'lite_express',
      }),
    );
  }
  if (draft.op === 'create') {
    const fields = draft.spec.fields;
    if (!fields.length) throw new Problem(422, 'FIELD_REQUIRED', '方案里没有字段');
    
  if (draft.op === 'create' && (draft.spec.kind === 'product_schema' || draft.spec.entity === 'product')) {
    const field = draft.spec.fields[0];
    if (!field?.name) throw new Problem(422, 'FIELD', '缺少字段名');
    const published = await appendAndPublishProductField(sql, actor, {
      label: field.name,
      fieldType: field.field_type,
      choices: field.choices,
      required: Boolean(field.required),
      input_modes: field.input_modes,
    });
    const spec: AppSpec = {
      ...draft.spec,
      kind: 'product_schema',
      product_field_key: published.field_key,
      product_schema_id: published.schema_id,
      product_previous_version_id: published.previous_version_id,
    };
    const appId = (
      await sql.query<{ id: string }>(
        `INSERT INTO ai_ext_apps(
           tenant_id, code, title, utterance, entity, status, spec, field_ids, menu_label, menu_path, created_by
         ) VALUES ($1,$2,$3,$4,'product','enabled',$5::jsonb,'[]'::jsonb,'','',$6)
         RETURNING id::text AS id`,
        [
          actor.tenant_id,
          draft.code,
          draft.title,
          draft.spec.utterance,
          JSON.stringify(spec),
          actor.user_id,
        ],
      )
    ).rows[0]!.id;
    await writeActionAudit(sql, actor, {
      action: 'ext_app.confirm',
      preview_id: previewId,
      payload: { op: 'create', app_id: appId, product_field_key: published.field_key },
      result: 'ok',
      target_table: 'extension_schemas',
      document_code: draft.code,
    });
    // 审计成功后再丢预览，避免写库事务回滚后内存预览已没、前端连点只见「预览失效」
    previews.delete(previewId);
    return withAfterCare(
      {
        ok: true as const,
        app_id: appId,
        title: draft.title,
        written: true as const,
      },
      buildExtAfterCare({
        op: 'create',
        title: draft.title,
        entity: 'product',
        kind: 'product_schema',
        fields: draft.spec.fields,
      }),
    );
  }

  if (draft.spec.entity !== 'product' && !ENTITY_LABEL[draft.spec.entity]) throw new Problem(422, 'ENTITY', '该对象暂不能挂扩展字段');
  if (draft.spec.entity === 'product') throw new Problem(422, 'ENTITY', '商品扩展应走商品方案写入');
    const existing = (
      await sql.query<{ id: string; status: string }>('SELECT id::text AS id, status FROM ai_ext_apps WHERE code=$1', [
        draft.code,
      ])
    ).rows;
    if (existing.some((row) => row.status !== 'rolled_back')) {
      throw new Problem(409, 'DUPLICATE', '同名字段扩展已存在，请先回退');
    }
    for (const old of existing) {
      await sql.query(
        `UPDATE ai_ext_apps SET code = code || '-rb-' || substr(id::text, 1, 8) WHERE id=$1`,
        [old.id],
      );
    }
    const appId = (
      await sql.query<{ id: string }>(
        `INSERT INTO ai_ext_apps(
           tenant_id, code, title, utterance, entity, status, spec, field_ids, menu_label, menu_path, created_by
         ) VALUES ($1,$2,$3,$4,$5,'enabled',$6::jsonb,'[]'::jsonb,$7,$8,$9)
         RETURNING id::text AS id`,
        [
          actor.tenant_id,
          draft.code,
          draft.title,
          draft.spec.utterance,
          draft.spec.entity,
          JSON.stringify(draft.spec),
          draft.menu_label,
          '',
          actor.user_id,
        ],
      )
    ).rows[0]!.id;
    const menuPath = `/ai/ext-board/${appId}`;
    const createdFields: FieldSpec[] = [];
    const fieldIds: string[] = [];
    let sortNo = 100;
    for (const field of fields) {
      const options: Record<string, unknown> = {
        sedric_app_id: appId,
        sedric_suppressed: false,
      };
      if (field.choices?.length) options.choices = field.choices;
      if (field.input_modes?.length) options.input_modes = field.input_modes;
      if (draft.spec.list_filter) options.list_filter = draft.spec.list_filter;
      const required = Boolean(field.required);
      let fieldId = '';
      try {
        fieldId = (
          await sql.query<{ id: string }>(
            `INSERT INTO entity_ext_fields(tenant_id, entity, name, field_type, required, sort_no, options)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
             RETURNING id::text AS id`,
            [actor.tenant_id, draft.spec.entity, field.name, field.field_type, required, sortNo, JSON.stringify(options)],
          )
        ).rows[0]!.id;
      } catch (error) {
        if (String((error as { code?: string }).code) === '23505') {
          throw new Problem(409, 'DUPLICATE', `「${field.name}」字段已存在，请换个名字或先处理原字段`);
        }
        throw error;
      }
      sortNo += 1;
      fieldIds.push(fieldId);
      createdFields.push({ ...field, field_id: fieldId });
    }
    const spec = { ...draft.spec, fields: createdFields };
    await sql.query(
      `UPDATE ai_ext_apps SET menu_path=$2, field_ids=$3::jsonb, spec=$4::jsonb, updated_at=now() WHERE id=$1`,
      [appId, menuPath, JSON.stringify(fieldIds), JSON.stringify(spec)],
    );
    previews.delete(previewId);
    return withAfterCare(
      {
        app_id: appId,
        op: 'create' as const,
        status: 'enabled' as const,
        field_id: fieldIds[0] ?? '',
        field_ids: fieldIds,
        menu_label: draft.menu_label,
        menu_path: menuPath,
        title: draft.title,
        entity: draft.spec.entity,
        message: `已启用扩展「${draft.title}」`,
      },
      buildExtAfterCare({
        op: 'create',
        title: draft.title,
        entity: draft.spec.entity,
        menu_label: draft.menu_label,
        menu_path: draft.menu_label ? menuPath : '',
        list_filter: draft.spec.list_filter,
        fields: createdFields,
      }),
    );
  }
  const app = (await loadApps(sql)).find((item) => item.id === draft.app_id);
  if (!app) throw new Problem(404, 'EXT_APP_NOT_FOUND', '扩展应用不存在');
  if (app.status === 'rolled_back') throw new Problem(409, 'ROLLED_BACK', '该扩展已回退，请重新生成方案');
  if (draft.op === 'disable' && app.status !== 'enabled') throw new Problem(409, 'NOT_ENABLED', '只有启用中的扩展可以停用');
  if (draft.op === 'enable' && app.status === 'enabled') throw new Problem(409, 'ALREADY_ENABLED', '该扩展已是启用状态');
  if (draft.op === 'rollback') {
    const isLite = app.spec?.kind === 'lite_express';
    const isProduct = app.spec?.kind === 'product_schema' || app.entity === 'product';
    if (isLite) {
      await sql.query('DELETE FROM ai_lite_records WHERE app_id=$1', [app.id]);
    }
    if (isProduct && app.spec?.product_schema_id && app.spec?.product_field_key) {
      await rollbackProductFieldVersion(sql, actor, {
        schema_id: app.spec.product_schema_id,
        previous_version_id: app.spec.product_previous_version_id ?? null,
        field_key: app.spec.product_field_key,
      });
    } else if (app.field_ids.length) {
      await sql.query('DELETE FROM entity_ext_fields WHERE id = ANY($1::uuid[])', [app.field_ids]);
    }
    await sql.query(
      `UPDATE ai_ext_apps
       SET status='rolled_back', menu_label='', menu_path='', code = code || '-rb-' || substr(id::text, 1, 8), updated_at=now()
       WHERE id=$1`,
      [app.id],
    );
    previews.delete(previewId);
    return withAfterCare(
      {
        app_id: app.id,
        op: 'rollback' as const,
        status: 'rolled_back' as const,
        title: app.title,
        menu_label: '',
        menu_path: '',
        message: `已回退扩展「${app.title}」，字段与菜单已恢复`,
      },
      buildExtAfterCare({ op: 'rollback', title: app.title }),
    );
  }
  if (draft.op === 'disable') {
    await setSuppressed(sql, app.field_ids, true);
    await sql.query(`UPDATE ai_ext_apps SET status='disabled', updated_at=now() WHERE id=$1`, [app.id]);
    previews.delete(previewId);
    return withAfterCare(
      {
        app_id: app.id,
        op: 'disable' as const,
        status: 'disabled' as const,
        title: app.title,
        message: `已停用扩展「${app.title}」`,
      },
      buildExtAfterCare({ op: 'disable', title: app.title }),
    );
  }
  await setSuppressed(sql, app.field_ids, false);
  await sql.query(`UPDATE ai_ext_apps SET status='enabled', updated_at=now() WHERE id=$1`, [app.id]);
  previews.delete(previewId);
  return withAfterCare(
    {
      app_id: app.id,
      op: 'enable' as const,
      status: 'enabled' as const,
      title: app.title,
      menu_label: app.menu_label,
      menu_path: app.menu_path,
      entity: app.entity,
      message: `已启用扩展「${app.title}」`,
    },
    buildExtAfterCare({
      op: 'enable',
      title: app.title,
      entity: app.entity,
      menu_label: app.menu_label,
      menu_path: app.menu_path,
      list_filter: app.spec?.list_filter,
      fields: app.spec?.fields,
      kind: app.spec?.kind,
    }),
  );
}
