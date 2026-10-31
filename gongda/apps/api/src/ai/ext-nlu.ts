/**
 * 一句话扩展 · 商用听懂层
 * 路径：意图识别 →（有 Key 则 LLM 结构化 JSON）→ 白名单校验 → 规则兜底
 * 样例句只是验收夹具，不是话术天花板。
 * 「拓展」与「扩展」等价（回退/停用/启用/列表均同义）。
 */
import { createHash } from 'node:crypto';
import { readAiConfig } from './config.js';
import {
  looksLikeShellToolIntent,
  softShellTopicHint,
  planShellToolByRules,
  resolveShellToolUtterance,
  shellOperatorHint,
  type ShellToolParsed,
  type ToolSpec,
} from './shell-tool.js';
export type { ToolSpec, ShellToolParsed };

export const EXT_ENTITY_LABEL: Record<string, string> = {
  work_order: '加工单',
  customer_contract: '合同',
  sale_stock_out: '销售出库单',
  customer: '客户',
  supplier: '供应商',
  craft: '工序',
  bom: 'BOM',
  purchase_order: '采购单',
  production_plan: '生产计划',
  linkman: '客户联系人',
  product: '商品',
};

/** 口语里「扩展」「拓展」等价 */
export const EXT_WORD_RE = '(?:扩展|拓展)';

/** 快递约件 / 约件工具：优先于壳内 ToolSpec，避免「做个快递约件」被算子盖不住吞掉 */
export function looksLikeLiteExpressIntent(raw: string): boolean {
  const t = String(raw || '').replace(/\s+/g, '');
  if (!t) return false;
  if (/(快递约件|约快递|快递上门)/.test(t)) return true;
  if (/(做|加|新建|生成|要|写|弄|搞|来|整).{0,10}(快递约件|约件|快递)/.test(t)) return true;
  if (/(约件工具|快递.*工具|工具.*约件|工具.*快递)/.test(t)) return true;
  return false;
}

export type ListFilterSpec = {
  kind: 'presence';
  chip_key: string;
  label: string;
  has_label: string;
  none_label: string;
};

export type ExtUtteranceParsed =
  | { op: 'list' }
  | { op: 'rollback' | 'disable' | 'enable'; query: string }
  | { op: 'not_ext'; reason: string }
  | {
      op: 'create_lite';
      template: 'express_pickup';
      menu: boolean;
      source?: 'llm' | 'rules';
    }
  | {
      op: 'create_shell_tool';
      capability: 'shell_tool';
      tool: ToolSpec;
      source?: 'llm' | 'rules';
    }
  | {
      op: 'create';
      entity: string;
      fieldName: string;
      fieldType: string;
      choices?: string[];
      menu: boolean;
      board: boolean;
      listFilter?: boolean | ListFilterSpec;
      productSchema?: boolean;
      source?: 'llm' | 'rules';
    };

const FIELD_TYPES = new Set(['单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间', '快递单号']);

function clip(value: string, max: number) {
  return value.trim().slice(0, max);
}

function presenceFilter(fieldName: string): ListFilterSpec {
  const short = fieldName.replace(/备注$/, '') || fieldName;
  return {
    kind: 'presence',
    chip_key: `ext_${fieldName}`,
    label: fieldName,
    has_label: fieldName.includes('备注') ? '有备注' : `有${short}`,
    none_label: fieldName.includes('备注') ? '无备注' : `无${short}`,
  };
}

/** 聊天壳入口：宽意图，不绑死样例句；扩展/拓展等价 */
export function looksLikeExtIntent(raw: string): boolean {
  const t = String(raw || '').replace(/\s+/g, '');
  if (!t) return false;
  if (new RegExp(`回退(该|这个)?${EXT_WORD_RE}|停用(该|这个)?${EXT_WORD_RE}|启用(该|这个)?${EXT_WORD_RE}|${EXT_WORD_RE}应用有哪些|有哪些${EXT_WORD_RE}`).test(t))
    return true;
  if (looksLikeShellToolIntent(t)) return true;
  if (looksLikeLiteExpressIntent(t)) return true;
  if (/(加|增加|新增|添加|要个|要一个|加个|做个|做一个|生成|来个).{0,30}(字段|备注|标记|筛选|侧栏|菜单|看板)/.test(t)) return true;
  if (/字段名称/.test(t) && /(加|增加|新增|添加)/.test(t)) return true;
  if (
    /(加工单|工单|合同|出库|客户|供应商|工序|采购|BOM|商品|产品|列表|界面|联系人)/.test(t) &&
    /(加|增加|新增|添加|要个|筛选|过滤)/.test(t)
  )
    return true;
  if (/(紧急度|加急标记|交期备注|交货备注)/.test(t)) return true;
  return false;
}

function resolveEntity(compact: string): string | null {
  if (/(商品|产品)/.test(compact) && !/(加工单|工单|合同|出库|客户|供应商|工序|采购)/.test(compact)) return 'product';
  if (/出库/.test(compact)) return 'sale_stock_out';
  if (/客户联系人|联系人/.test(compact) && !/合同/.test(compact)) return 'linkman';
  if (/供应商/.test(compact)) return 'supplier';
  if (/客户/.test(compact) && !/合同/.test(compact)) return 'customer';
  if (/工序/.test(compact)) return 'craft';
  if (/BOM|物料清单/i.test(compact)) return 'bom';
  if (/采购单|采购/.test(compact)) return 'purchase_order';
  if (/生产计划/.test(compact)) return 'production_plan';
  if (/合同/.test(compact) || (/订单/.test(compact) && !/出库|采购/.test(compact))) return 'customer_contract';
  if (/加工单|工单/.test(compact)) return 'work_order';
  return null;
}

function extractFieldName(compact: string): string | null {
  const named =
    compact.match(/字段名称?[为是叫：:]\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,24})/) ||
    compact.match(/(?:名称|名叫|叫名)[为是叫：:]\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,24})/) ||
    compact.match(/[「『""]([\u4e00-\u9fa5A-Za-z0-9_]{1,24})[」』""]/);
  if (named?.[1]) return named[1];

  const afterAdd = compact.match(
    /(?:加|增加|新增|添加|要个|要一个|加个|做个|做一个|来个)(?:一个|个)?([\u4e00-\u9fa5A-Za-z0-9_]{1,24})(?:字段|备注|标记)?/,
  );
  if (afterAdd?.[1] && !/列表|界面|单据|扩展|拓展|侧栏|菜单/.test(afterAdd[1])) {
    let name = afterAdd[1].replace(/(字段|备注|标记)$/, '');
    if (name) return name;
  }

  const marked = compact.match(/([\u4e00-\u9fa5A-Za-z0-9]{1,24})字段/);
  if (marked?.[1]) {
    let name = marked[1].replace(/^.*(?:增加|新增|添加一个|添加|加一个|加个|加|要一个|要个)/, '');
    name = name.replace(/^(?:一个|个)/, '');
    if (name && !/列表|界面|单据|扩展|拓展/.test(name)) return name;
  }
  return null;
}

function inferType(compact: string, fieldName: string): { fieldType: string; choices?: string[] } {
  if (/下拉|单选|标记|紧急度|加急/.test(compact) || /紧急度|加急标记/.test(fieldName)) {
    if (/紧急度|加急/.test(fieldName) || /紧急度|加急标记|特急/.test(compact)) {
      return { fieldType: '单选下拉框', choices: ['普通', '加急', '特急'] };
    }
    const afterSelect = compact.match(
      /下拉[：:]?([一-龥A-Za-z0-9_]{1,16})(?:\/|、|，|,)([一-龥A-Za-z0-9_]{1,16})(?:(?:\/|、|，|,)([一-龥A-Za-z0-9_]{1,16}))?/,
    );
    if (afterSelect) {
      const choices = [afterSelect[1], afterSelect[2], afterSelect[3]].filter(Boolean) as string[];
      if (choices.length >= 2) return { fieldType: '单选下拉框', choices };
    }
    const slashOnly = compact.match(
      /([一-龥A-Za-z0-9_]{1,12})\/([一-龥A-Za-z0-9_]{1,12})(?:\/([一-龥A-Za-z0-9_]{1,12}))?/,
    );
    if (slashOnly && !/http/.test(compact)) {
      const choices = [slashOnly[1], slashOnly[2], slashOnly[3]].filter(Boolean) as string[];
      if (choices.every((c) => c.length <= 8) && choices.length >= 2) {
        return { fieldType: '单选下拉框', choices };
      }
    }
    return { fieldType: '单选下拉框', choices: ['是', '否'] };
  }
  if (/数字|数量|金额|额度/.test(compact) || /额度|数量|金额/.test(fieldName)) return { fieldType: '数字输入框' };
  if (/日期|交期|交货日/.test(compact) && !/备注/.test(fieldName)) return { fieldType: '日期' };
  if (/多行|长文本/.test(compact)) return { fieldType: '多行文本' };
  return { fieldType: '单行文本' };
}

/** 规则兜底：开放字段名 + 多实体；扩展/拓展等价 */
export function parseExtUtteranceRules(raw: string): ExtUtteranceParsed | null {
  const compact = raw.trim().replace(/\s+/g, '');
  if (!compact) return null;
  if (new RegExp(`${EXT_WORD_RE}应用有哪些|有哪些${EXT_WORD_RE}|${EXT_WORD_RE}列表|${EXT_WORD_RE}应用列表`).test(compact))
    return { op: 'list' };
  const rollback = compact.match(new RegExp(`^回退(?:该|这个)?${EXT_WORD_RE}(?:应用)?(.*)$`));
  if (rollback) return { op: 'rollback', query: rollback[1] ?? '' };
  const disable = compact.match(new RegExp(`^停用(?:该|这个)?${EXT_WORD_RE}(?:应用)?(.*)$`));
  if (disable) return { op: 'disable', query: disable[1] ?? '' };
  const enable = compact.match(new RegExp(`^启用(?:该|这个)?${EXT_WORD_RE}(?:应用)?(.*)$`));
  if (enable) return { op: 'enable', query: enable[1] ?? '' };

  if (looksLikeLiteExpressIntent(compact)) {
    return { op: 'create_lite', template: 'express_pickup', menu: true, source: 'rules' };
  }

  const shell = planShellToolByRules(raw);
  if (shell) return shell;

  const addHit = /(加|增加|新增|添加|要个|要一个|加个|做个|做一个|生成|来个)/.test(compact);
  const urgencyHit = /(紧急度|加急标记|加急|特急|紧急)/.test(compact);
  const noteHit = /(交期备注|交货备注)/.test(compact);
  const literalField = /字段|备注|标记|下拉|筛选/.test(compact);
  if (!addHit && !urgencyHit && !noteHit) return null;
  if (!urgencyHit && !noteHit && !literalField && !/筛选|过滤|侧栏|菜单|下拉/.test(compact)) {
    if (!(addHit && resolveEntity(compact) && extractFieldName(compact))) return null;
  }

  let entity = resolveEntity(compact);
  if (!entity) {
    if (urgencyHit) entity = 'work_order';
    else if (noteHit) entity = 'customer_contract';
    else return null;
  }

  let fieldName = '';
  let fieldType = '单行文本';
  let choices: string[] | undefined;

  if (urgencyHit && (!extractFieldName(compact) || /紧急|加急|特急/.test(extractFieldName(compact) || ''))) {
    fieldName = '紧急度';
    fieldType = '单选下拉框';
    choices = ['普通', '加急', '特急'];
  } else if (noteHit && !(extractFieldName(compact) && !/交期|交货|备注/.test(extractFieldName(compact) || ''))) {
    fieldName = '交期备注';
    fieldType = '单行文本';
  } else {
    fieldName = extractFieldName(compact) || '';
    if (!fieldName) return null;
    const inferred = inferType(compact, fieldName);
    fieldType = inferred.fieldType;
    choices = inferred.choices;
  }

  const wantListFilter = /(筛选|过滤|有无|列表能)/.test(compact);
  const menu =
    /侧栏|菜单|进菜单/.test(compact) || /加急标记/.test(compact) || (urgencyHit && /侧栏/.test(compact));

  return {
    op: 'create',
    entity,
    fieldName: clip(fieldName, 40),
    fieldType,
    choices,
    menu: Boolean(menu),
    board: /看板|视图/.test(compact),
    listFilter: wantListFilter ? presenceFilter(fieldName) : undefined,
    productSchema: entity === 'product',
    source: 'rules',
  };
}

type LlmPlan = {
  intent?: string;
  entity?: string;
  fieldName?: string;
  fieldType?: string;
  choices?: string[];
  menu?: boolean;
  board?: boolean;
  listFilter?: boolean;
  liteTemplate?: string | null;
  reason?: string;
};

function validateLlmPlan(plan: LlmPlan): ExtUtteranceParsed | null {
  const intent = String(plan.intent || '').trim();
  if (intent === 'list') return { op: 'list' };
  if (intent === 'rollback' || intent === 'disable' || intent === 'enable') {
    return { op: intent, query: String(plan.reason || '') };
  }
  if (intent === 'not_ext') return { op: 'not_ext', reason: clip(String(plan.reason || '不像扩展需求'), 200) };
  if (intent === 'create_lite' || plan.liteTemplate === 'express_pickup') {
    return { op: 'create_lite', template: 'express_pickup', menu: plan.menu !== false, source: 'llm' };
  }
  if (intent !== 'create_field' && intent !== 'create') return null;

  const entity = String(plan.entity || '').trim();
  if (!EXT_ENTITY_LABEL[entity]) return null;
  const fieldName = clip(String(plan.fieldName || ''), 40);
  if (!fieldName) return null;
  let fieldType = String(plan.fieldType || '单行文本');
  if (!FIELD_TYPES.has(fieldType)) fieldType = '单行文本';
  const choices = Array.isArray(plan.choices)
    ? plan.choices.map((c) => String(c).trim()).filter(Boolean).slice(0, 20)
    : undefined;
  if (fieldType === '单选下拉框' && (!choices || choices.length < 2)) {
    return {
      op: 'create',
      entity,
      fieldName,
      fieldType,
      choices: choices && choices.length ? choices : ['是', '否'],
      menu: Boolean(plan.menu),
      board: Boolean(plan.board),
      listFilter: plan.listFilter ? presenceFilter(fieldName) : undefined,
      productSchema: entity === 'product',
      source: 'llm',
    };
  }
  return {
    op: 'create',
    entity,
    fieldName,
    fieldType,
    choices,
    menu: Boolean(plan.menu),
    board: Boolean(plan.board),
    listFilter: plan.listFilter ? presenceFilter(fieldName) : undefined,
    productSchema: entity === 'product',
    source: 'llm',
  };
}

async function parseExtWithLlm(raw: string): Promise<ExtUtteranceParsed | null> {
  const config = readAiConfig();
  if (config.provider !== 'openai' || !config.apiKey) return null;

  const entities = Object.entries(EXT_ENTITY_LABEL)
    .map(([k, v]) => `${k}=${v}`)
    .join('，');
  const system = [
    '你是赛德瑞克 MES「一句话生成扩展」解析器。把用户中文口语变成 JSON，不要解释。',
    '只输出一个 JSON 对象，字段：intent, entity, fieldName, fieldType, choices, menu, board, listFilter, liteTemplate, reason。',
    'intent 枚举：create_field | create_lite | list | rollback | disable | enable | not_ext',
    `entity 只能是：${entities}`,
    'fieldType 中文：单行文本/多行文本/数字输入框/单选下拉框/多选下拉框/日期/时间/快递单号',
    '商品/产品用 entity=product（走商品扩展方案）；加工单=work_order；合同=customer_contract；联系人=linkman。',
    '「拓展」与「扩展」完全同义：回退该拓展 / 回退这个扩展 / 有哪些拓展 → 对应 rollback / list。',
    '快递约件类 → intent=create_lite, liteTemplate=express_pickup。',
    '计时器/计算器/PDF/本地表/壳内小工具类不要用本解析器（另有 shell_tool 规划器）；若误入则 intent=not_ext。',
    '明显不是扩展（闲聊、查进度、问用法）→ intent=not_ext 并写 reason。',
    'menu/board/listFilter 为 boolean；不确定则 false。',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: raw.slice(0, 500) },
        ],
      }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim() ?? '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const plan = JSON.parse(match[0]) as LlmPlan;
    return validateLlmPlan(plan);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 同步规则入口（测试/兼容） */
export function parseExtUtterance(raw: string): ExtUtteranceParsed | null {
  return parseExtUtteranceRules(raw);
}

/** 商用入口：LLM 优先，规则兜底；控制类（含拓展）优先走规则 */
export async function resolveExtUtterance(raw: string): Promise<ExtUtteranceParsed | null> {
  const compact = raw.trim();
  if (!compact) return null;
  const flat = compact.replace(/\s+/g, '');
  if (
    new RegExp(`^(回退|停用|启用|${EXT_WORD_RE}应用有哪些|有哪些${EXT_WORD_RE})`).test(flat)
  ) {
    return parseExtUtteranceRules(raw);
  }
  // 快递约件优先：与壳内工具同一套预览→确认→回退，但数据模型仍为 lite_express
  if (looksLikeLiteExpressIntent(compact)) {
    return { op: 'create_lite', template: 'express_pickup', menu: true, source: 'rules' };
  }
  // 壳内小工具：capability=shell_tool，独立 LLM→Spec + 规则兜底（优先于字段扩展）
  // 硬门失败但含软话题词时也尝试（forceSoft），避免前端放行后服务端仍丢弃
  // 生成意图明确但拼不出 Spec → 诚实「当前算子盖不住」，禁止掉说明书
  if (looksLikeShellToolIntent(compact) || softShellTopicHint(compact)) {
    // 顺序：现有 Spec →（resolve 内）识图规则 / LLM Spec → 沙箱 codegen → 仍失败才诚实说明
    const shell = await resolveShellToolUtterance(raw, {
      forceSoft: !looksLikeShellToolIntent(compact),
      allowSandbox: true,
    });
    if (shell) return shell;
    const short = compact.replace(/\s+/g, '').slice(0, 40);
    return {
      op: 'not_ext' as const,
      reason:
        `暂时还写不出「${short}」。${shellOperatorHint()} ` +
        '可以许愿：识图抽字段 / 计时 / 计算 / PDF / 沙箱小工具。不会甩说明书，也不会静默写 MES。',
    };
  }
  const llm = await parseExtWithLlm(raw);
  if (llm && llm.op !== 'not_ext') return llm;
  const rules = parseExtUtteranceRules(raw);
  if (rules) return rules;
  if (llm?.op === 'not_ext') return llm;
  return null;
}

export function productFieldKey(label: string): string {
  const hash = createHash('md5').update(label).digest('hex').slice(0, 10);
  return `f${hash}`;
}

export function mapProductFieldType(fieldType: string): 'text' | 'number' | 'select' | 'date' | 'boolean' {
  if (fieldType.includes('数字')) return 'number';
  if (fieldType.includes('单选') || fieldType.includes('多选')) return 'select';
  if (fieldType.includes('日期')) return 'date';
  return 'text';
}
