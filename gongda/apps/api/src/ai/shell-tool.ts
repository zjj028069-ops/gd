/**
 * P1 壳内小工具 · ToolSpec schema / 校验 / 人话→Spec（LLM + 规则兜底）
 * 在 P0 timer/button/form 上加厚：calculator / table / file_picker + pdf.* / calc.eval
 * LLM 写的是 Spec，不是任意脚本；未知算子拒绝并提示白名单。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readAiConfig } from './config.js';

export const SHELL_WIDGET_WHITELIST = new Set([
  'timer',
  'button',
  'form',
  'calculator',
  'table',
  'file_picker',
  'field_result',
]);

export const SHELL_ACTION_WHITELIST = new Set([
  'timer.start',
  'timer.pause',
  'timer.reset',
  'timer.set_duration',
  'calc.eval',
  'table.add_row',
  'table.delete_row',
  'pdf.merge',
  'pdf.split',
  'pdf.to_images',
  'pdf.extract_text',
  'image.extract_fields',
  'fields.copy',
]);

/** 方案卡 / 拒识提示用 */
export const SHELL_OPERATOR_CATALOG = [
  { id: 'timer', kind: 'widget', label: '计时器（正计时/倒计时）' },
  { id: 'calculator', kind: 'widget', label: '计算器（安全表达式）' },
  { id: 'form', kind: 'widget', label: '表单输入' },
  { id: 'table', kind: 'widget', label: '本地表格（增删行）' },
  { id: 'file_picker', kind: 'widget', label: '文件选择（PDF/图片）' },
  { id: 'field_result', kind: 'widget', label: '识图字段结果（可编辑）' },
  { id: 'button', kind: 'widget', label: '按钮' },
  { id: 'timer.start', kind: 'action', label: '开始计时' },
  { id: 'timer.pause', kind: 'action', label: '暂停计时' },
  { id: 'timer.reset', kind: 'action', label: '复位计时' },
  { id: 'timer.set_duration', kind: 'action', label: '设置倒计时秒数' },
  { id: 'calc.eval', kind: 'action', label: '安全表达式计算' },
  { id: 'table.add_row', kind: 'action', label: '表格增行' },
  { id: 'table.delete_row', kind: 'action', label: '表格删行' },
  { id: 'pdf.merge', kind: 'action', label: 'PDF 合并' },
  { id: 'pdf.split', kind: 'action', label: 'PDF 拆页' },
  { id: 'pdf.to_images', kind: 'action', label: 'PDF 转图' },
  { id: 'pdf.extract_text', kind: 'action', label: 'PDF 抽文本' },
  { id: 'image.extract_fields', kind: 'action', label: '识图提取字段' },
  { id: 'fields.copy', kind: 'action', label: '复制字段（本地）' },
] as const;

export const PDF_DEFAULT_LIMITS = {
  max_mb: 20,
  max_files: 10,
  max_pages: 100,
} as const;

export type ShellWidget =
  | {
      type: 'timer';
      id?: string;
      props?: {
        modes?: Array<'stopwatch' | 'countdown'>;
        initial_seconds?: number;
        label?: string;
        /** 番茄/专注：工作分钟（优先于 initial_seconds） */
        work_minutes?: number;
        /** 番茄/专注：休息分钟 */
        break_minutes?: number;
      };
    }
  | {
      type: 'button';
      id?: string;
      label: string;
      action: string;
    }
  | {
      type: 'form';
      id?: string;
      fields?: Array<{ name: string; label: string; input: 'number' | 'text'; default?: number | string }>;
    }
  | {
      type: 'calculator';
      id?: string;
      props?: {
        label?: string;
        preset?: 'basic' | 'qty_price';
        initial_expr?: string;
      };
    }
  | {
      type: 'table';
      id?: string;
      props?: {
        columns?: Array<{ key: string; label: string; input?: 'text' | 'number' }>;
        initial_rows?: Array<Record<string, string | number>>;
        persist?: 'none' | 'local';
      };
    }
  | {
      type: 'file_picker';
      id?: string;
      props?: {
        accept?: string;
        multiple?: boolean;
        label?: string;
        max_files?: number;
        max_mb?: number;
      };
    }
  | {
      type: 'field_result';
      id?: string;
      props?: {
        label?: string;
        editable?: boolean;
      };
    };

export type SandboxedToolPayload = {
  kind: 'sandboxed_html';
  title?: string;
  permissions: { network: false; write_mes_entities: []; vision?: boolean };
  html: string;
  js: string;
};

export type ToolSpec = {
  id: string;
  title: string;
  placement: 'sidebar' | 'chat_panel';
  ui: {
    layout: 'single_page';
    widgets: ShellWidget[];
  };
  actions: Array<{ id: string; uses?: string; limits?: Record<string, unknown> }>;
  data: { persist: 'none' | 'local' | 'light_table'; table: null };
  permissions: { network: false; write_mes_entities: []; vision?: boolean };
  capability: 'shell_tool';
  source?: 'llm' | 'rules' | 'sandbox_codegen';
  utterance?: string;
  /** 校验时剔除的未知算子，给方案卡/拒识提示 */
  rejected_operators?: string[];
  /** spec=白名单算子；sandbox=DeepSeek 生成的壳内沙箱（经 Bridge） */
  runtime?: 'spec' | 'sandbox';
  sandbox?: SandboxedToolPayload;
};

export type ShellToolParsed = {
  op: 'create_shell_tool';
  capability: 'shell_tool';
  tool: ToolSpec;
  source: 'llm' | 'rules' | 'sandbox_codegen';
};

export type ValidateToolSpecResult =
  | { ok: true; tool: ToolSpec }
  | { ok: false; reason: string; rejected: string[]; allowed: string[] };

function clip(value: string, max: number) {
  return value.trim().slice(0, max);
}

function digestId(seed: string) {
  return `tool_${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

/**
 * 壳内小工具 · 软话题门（商用听懂，不绑死「做个」）
 * 与 chat-shell/app.js 的 looksLikeS3 壳内段语义对齐。
 * 话题词 + 宽生成动词 → 放行进 LLM/规则；说明书/加字段不抢。
 */
export const SHELL_TOPIC_RE =
  /(计算器|小算盘|算盘|工价.?算|用量.?算|正计时|倒计时|计时器|计时|秒表|节拍|时钟|钟|番茄(?:钟|时钟|工作法)?|专注钟|专注|PDF|pdf|合并.?PDF|PDF.?合并|拆.?PDF|PDF.?拆|转图|抽文本|提取文本|提取.?图片|图片.?字段|识图|OCR|ocr|扫描件|抽字段|提取字段|小工具|壳内工具|小应用|小程序|本地表|登记表|轻表|表格工具|表格|表单|登记)/;

/** 生成意图宾语（与宽动词搭配；比话题表更宽，含「工具/盘」等） */
export const SHELL_OBJECT_RE =
  /(工具|小应用|小程序|钟|时钟|计时|倒计时|秒表|盘|算盘|PDF|pdf|表格|表单|登记|计算器|计时器|番茄|专注|图片|扫描件|字段)/;

/** 宽生成动词：写/帮我写/弄/搞/来个/整… 适应不同用户聊天习惯 */
export const SHELL_GEN_VERB_RE =
  /(写|帮我写|帮.?写|帮我做|帮.?做|做|做个|做一个|弄|弄个|弄一个|搞|搞个|搞一个|生成|新建|创建|开发|来|来个|来一个|要|要个|要一个|给我|给我弄|给我搞|给我做|给我写|整|整一个|出|出一个|实现|搭|搭一个|加个|加一个)/;

/** Guide 说明书：「怎么/如何+操作」不进壳内工具 */
export function looksLikeGuideHowTo(raw: string): boolean {
  const t = String(raw || '').replace(/\s+/g, '');
  if (!t) return false;
  if (/(怎么|如何|怎样|咋样|咋|教我|说明书).{0,24}(报工|录入|工艺|操作|使用|打开|进入|查找|查询|导出|打印|登录|权限)/.test(t))
    return true;
  // 纯问法且无壳内话题 → 说明书
  if (/^(怎么|如何|怎样|咋)/.test(t) && !SHELL_TOPIC_RE.test(t) && !SHELL_OBJECT_RE.test(t)) return true;
  return false;
}

/** 字段扩展话术：实体+加字段/紧急度，不劫持为 shell_tool */
export function looksLikeFieldExtNotShell(raw: string): boolean {
  const t = String(raw || '').replace(/\s+/g, '');
  if (!t) return false;
  if (/(加|增加|新增|添加|要个|要一个|加个).{0,24}(字段|备注|标记|紧急度|交期备注|交货备注|加急标记)/.test(t))
    return true;
  if (
    /(加工单|工单|合同|出库|客户|供应商|工序|采购|BOM|商品|产品|列表|界面|联系人)/.test(t) &&
    /(加|增加|新增|添加).{0,16}(字段|备注|标记|紧急度|交期|筛选|过滤)/.test(t)
  )
    return true;
  return false;
}

/**
 * 极短「帮我写一个X / 写个X / 搞个Y」：X 不像字段扩展 → 进规划器
 * 例：帮我写一个番茄时钟、写个专注钟、搞个PDF合并
 */
export function looksLikeShortCreateTool(raw: string): boolean {
  const t = String(raw || '').replace(/\s+/g, '');
  if (!t || t.length > 36) return false;
  if (looksLikeGuideHowTo(t) || looksLikeFieldExtNotShell(t)) return false;
  if (/(字段|备注|标记|紧急度|交期|筛选|过滤|报工|工艺|录入)/.test(t)) return false;
  // 帮我写一个X / 写个X / 做一个X / 搞个X …
  return /^(帮我)?(写|做|弄|搞|来|整|出|生成|创建|开发|搭|给我)(一个|个|只|条)?[\u4e00-\u9fffA-Za-z0-9·\-_+]{1,24}$/.test(
    t,
  );
}

/** 软话题提示：硬门失败但仍含壳内话题、且不像 Guide/加字段 → 可尝试规划 */
export function softShellTopicHint(raw: string): boolean {
  const t = String(raw || '').replace(/\s+/g, '');
  if (!t) return false;
  if (looksLikeGuideHowTo(t) || looksLikeFieldExtNotShell(t)) return false;
  return SHELL_TOPIC_RE.test(t) || looksLikeShortCreateTool(t);
}

/**
 * 生成意图门（阶段 0 · intent-first）：不再依赖 SHELL_TOPIC 词表硬门 alone。
 * 与 chat-shell/app.js looksLikeS3 壳内段语义对齐。
 */
/** 识图 / 提取图片字段 / OCR / 扫描件抽字段 */
export function looksLikeImageExtractIntent(raw: string): boolean {
  const t = String(raw || '').replace(/\s+/g, '');
  if (!t) return false;
  if (looksLikeGuideHowTo(t) || looksLikeFieldExtNotShell(t)) return false;
  if (/(提取|抽取|识别|识图|OCR|ocr).{0,16}(图片|图像|照片|扫描|字段)/.test(t)) return true;
  if (/(图片|图像|照片|扫描件).{0,16}(字段|提取|抽取|识别|OCR|ocr)/.test(t)) return true;
  if (/(图片字段|扫描件抽|识图抽|抽字段工具|提取字段的工具)/.test(t)) return true;
  return false;
}

export function looksLikeShellToolIntent(raw: string): boolean {
  const t = String(raw || '').replace(/\s+/g, '');
  if (!t) return false;
  // 不抢 Guide / 字段扩展
  if (looksLikeGuideHowTo(t)) return false;
  if (looksLikeFieldExtNotShell(t)) return false;

  // 识图抽字段（可完全不碰 MES）
  if (looksLikeImageExtractIntent(t)) return true;

  // 宽生成动词 +（话题表 ∪ 宽宾语）
  if (SHELL_GEN_VERB_RE.test(t) && (SHELL_TOPIC_RE.test(t) || SHELL_OBJECT_RE.test(t))) return true;

  // 极短「帮我写一个X」
  if (looksLikeShortCreateTool(t)) return true;

  // PDF 动作词本身暗示要工具
  if (/(PDF|pdf)/.test(t) && /(合并|拆|转图|抽文本|提取文本|工具)/.test(t)) return true;

  // 计时器：带复位/暂停
  if (/(正计时|倒计时|计时器|秒表|时钟|番茄|专注)/.test(t) && /(带复位|暂停|复位)/.test(t)) return true;

  // 「写/做/弄一个…工具」泛化（排除字段）
  if (SHELL_GEN_VERB_RE.test(t) && /(工具|计时|小应用|小程序)/.test(t) && !/(字段|备注|标记)/.test(t))
    return true;

  // 仅话题词（无明确动词）也软放行，交给 LLM→规则（适应极简口语如「计算器」「番茄钟」）
  if (softShellTopicHint(t)) return true;

  return false;
}

function pdfLimitsFromText(compact: string): Record<string, number> {
  const limits = { ...PDF_DEFAULT_LIMITS };
  const mb = compact.match(/(\d+)\s*M[Bb]|(\d+)\s*兆/);
  if (mb) {
    const n = Number(mb[1] || mb[2]);
    if (Number.isFinite(n) && n >= 1 && n <= 50) limits.max_mb = n;
  }
  return limits;
}

function collectOperators(tool: ToolSpec): string[] {
  const ops = new Set<string>();
  for (const w of tool.ui.widgets) ops.add(w.type);
  for (const a of tool.actions) ops.add(a.id);
  return Array.from(ops);
}

function baseSpec(partial: {
  title: string;
  placement: 'sidebar' | 'chat_panel';
  widgets: ShellWidget[];
  utterance: string;
  source: 'llm' | 'rules';
  seed?: string;
  extraActions?: Array<{ id: string; uses?: string; limits?: Record<string, unknown> }>;
  persist?: 'none' | 'local';
}): ToolSpec {
  const actions = Array.from(
    new Set(
      partial.widgets
        .filter((w): w is Extract<ShellWidget, { type: 'button' }> => w.type === 'button')
        .map((w) => w.action)
        .filter((a) => SHELL_ACTION_WHITELIST.has(a)),
    ),
  ).map((id) => ({ id }));

  const hasTimer = partial.widgets.some((w) => w.type === 'timer');
  if (hasTimer) {
    for (const id of ['timer.start', 'timer.pause', 'timer.reset'] as const) {
      if (!actions.some((a) => a.id === id)) actions.push({ id });
    }
  }
  const hasCalc = partial.widgets.some((w) => w.type === 'calculator');
  if (hasCalc && !actions.some((a) => a.id === 'calc.eval')) {
    actions.push({ id: 'calc.eval' });
  }
  const hasTable = partial.widgets.some((w) => w.type === 'table');
  if (hasTable) {
    for (const id of ['table.add_row', 'table.delete_row'] as const) {
      if (!actions.some((a) => a.id === id)) actions.push({ id });
    }
  }
  for (const extra of partial.extraActions || []) {
    if (!SHELL_ACTION_WHITELIST.has(extra.id)) continue;
    if (!actions.some((a) => a.id === extra.id)) actions.push(extra);
  }

  const id = digestId(partial.seed || `${partial.title}:${JSON.stringify(partial.widgets)}`);
  return {
    id,
    title: clip(partial.title, 40),
    placement: partial.placement,
    ui: { layout: 'single_page', widgets: partial.widgets },
    actions,
    data: { persist: partial.persist || 'none', table: null },
    permissions: { network: false, write_mes_entities: [] },
    capability: 'shell_tool',
    source: partial.source,
    utterance: clip(partial.utterance, 400),
  };
}

/** 规则兜底：不同人话 → 不同 widgets/actions（含 P1 算子） */
export function planShellToolByRules(raw: string): ShellToolParsed | null {
  if (!looksLikeShellToolIntent(raw)) return null;
  const compact = raw.trim().replace(/\s+/g, '');
  // 默认聊天壳浮层；用户明确说「侧栏/生产侧栏」才挂 MES 侧栏
  let placement: 'sidebar' | 'chat_panel' = /(生产侧栏|MES侧栏|挂侧栏|侧栏)/.test(compact) && !/聊天|面板|对话里/.test(compact) ? 'sidebar' : 'chat_panel';

  // —— 识图提取图片字段（优先满足本句许愿；确认前不写 MES） ——
  if (looksLikeImageExtractIntent(compact) || (/(图片|扫描|识图|OCR|ocr)/.test(compact) && /(字段|提取|抽取)/.test(compact))) {
    const widgets: ShellWidget[] = [
      {
        type: 'file_picker',
        id: 'img_files',
        props: {
          accept: 'image/png,image/jpeg,image/webp,image/gif',
          multiple: false,
          label: '选择图片 / 扫描件',
          max_files: 1,
          max_mb: 5,
        },
      },
      {
        type: 'table',
        id: 'field_tbl',
        props: {
          columns: [
            { key: 'key', label: '字段键', input: 'text' },
            { key: 'label', label: '字段名', input: 'text' },
            { key: 'value', label: '值', input: 'text' },
          ],
          initial_rows: [],
          persist: 'none',
        },
      },
      { type: 'field_result', id: 'fields', props: { label: '提取结果', editable: true } },
      { type: 'button', id: 'btn_extract', label: '识图提取字段', action: 'image.extract_fields' },
      { type: 'button', id: 'btn_copy', label: '复制字段', action: 'fields.copy' },
    ];
    const seed = `image.extract_fields|${compact.slice(0, 80)}`;
    placement = 'chat_panel'; // 识图工具强制聊天壳，不进 MES
    const tool = baseSpec({
      title: '图片字段提取',
      placement,
      widgets,
      utterance: raw,
      source: 'rules',
      seed,
      extraActions: [{ id: 'image.extract_fields', uses: 'file.image' }, { id: 'fields.copy' }],
    });
    tool.permissions = { network: false, write_mes_entities: [], vision: true };
    return { op: 'create_shell_tool', capability: 'shell_tool', tool, source: 'rules' };
  }

  // —— PDF ——
  const wantPdf =
    /(PDF|pdf)/.test(compact) ||
    /合并.*页|拆页|转图|抽文本|提取文本/.test(compact);
  if (wantPdf && /(合并|拆|转图|抽文本|提取文本|工具|做|写|弄|搞|生成|来|要|给我|整|出|实现|搭)/.test(compact)) {
    const limits = pdfLimitsFromText(compact);
    const actions: Array<{ id: string; uses?: string; limits?: Record<string, unknown> }> = [];
    const wantMerge = /合并/.test(compact) || (!/拆|转图|抽文本|提取文本/.test(compact) && /PDF|pdf/.test(compact));
    const wantSplit = /拆/.test(compact);
    const wantImg = /转图|转图片|出图/.test(compact);
    const wantText = /抽文本|提取文本|读文字|OCR|ocr/.test(compact);
    if (wantMerge) actions.push({ id: 'pdf.merge', uses: 'file.pdf', limits });
    if (wantSplit) actions.push({ id: 'pdf.split', uses: 'file.pdf', limits });
    if (wantImg) actions.push({ id: 'pdf.to_images', uses: 'file.pdf', limits });
    if (wantText) actions.push({ id: 'pdf.extract_text', uses: 'file.pdf', limits });
    if (!actions.length) actions.push({ id: 'pdf.merge', uses: 'file.pdf', limits });

    const titleBits = actions.map((a) => a.id.replace('pdf.', '')).join('+');
    const title = `PDF工具（${titleBits}）`;
    const widgets: ShellWidget[] = [
      {
        type: 'file_picker',
        id: 'pdf_files',
        props: {
          accept: 'application/pdf',
          multiple: true,
          label: '选择 PDF',
          max_files: limits.max_files,
          max_mb: limits.max_mb,
        },
      },
    ];
    for (const a of actions) {
      const labels: Record<string, string> = {
        'pdf.merge': '合并 PDF',
        'pdf.split': '拆分 PDF',
        'pdf.to_images': '转图片',
        'pdf.extract_text': '提取文本',
      };
      widgets.push({
        type: 'button',
        id: `btn_${a.id.replace(/\./g, '_')}`,
        label: labels[a.id] || a.id,
        action: a.id,
      });
    }
    const seed = `pdf|${actions.map((a) => a.id).join(',')}|${compact.slice(0, 80)}`;
    const tool = baseSpec({
      title,
      placement,
      widgets,
      utterance: raw,
      source: 'rules',
      seed,
      extraActions: actions,
    });
    return { op: 'create_shell_tool', capability: 'shell_tool', tool, source: 'rules' };
  }

  // —— 计算器 / 工价小算盘 ——
  const wantCalc =
    /(计算器|小算盘|算盘)/.test(compact) ||
    (/(数量|单价|工价|用量)/.test(compact) && /(算|计算)/.test(compact));
  if (wantCalc) {
    const qtyPrice = /(数量|单价|工价|用量|件数)/.test(compact);
    const title = qtyPrice ? '工价小算盘' : '计算器';
    const widgets: ShellWidget[] = [
      {
        type: 'calculator',
        id: 'c1',
        props: {
          label: qtyPrice ? '数量×单价' : '计算器',
          preset: qtyPrice ? 'qty_price' : 'basic',
          initial_expr: qtyPrice ? '数量*单价' : '',
        },
      },
    ];
    if (qtyPrice) {
      widgets.push({
        type: 'form',
        id: 'qp',
        fields: [
          { name: 'qty', label: '数量', input: 'number', default: 1 },
          { name: 'price', label: '单价', input: 'number', default: 0 },
        ],
      });
      widgets.push({ type: 'button', id: 'btn_calc', label: '计算', action: 'calc.eval' });
    } else {
      widgets.push({ type: 'button', id: 'btn_calc', label: '计算', action: 'calc.eval' });
    }
    const seed = `calc|${qtyPrice ? 'qp' : 'basic'}|${compact.slice(0, 80)}`;
    const tool = baseSpec({ title, placement, widgets, utterance: raw, source: 'rules', seed });
    return { op: 'create_shell_tool', capability: 'shell_tool', tool, source: 'rules' };
  }

  // —— 本地表格 ——
  if (/(表格|登记表|轻表|本地表)/.test(compact) && /(做|加|生成|工具|壳内)/.test(compact)) {
    const widgets: ShellWidget[] = [
      {
        type: 'table',
        id: 'tbl1',
        props: {
          columns: [
            { key: 'name', label: '名称', input: 'text' },
            { key: 'qty', label: '数量', input: 'number' },
            { key: 'note', label: '备注', input: 'text' },
          ],
          initial_rows: [],
          persist: 'none',
        },
      },
      { type: 'button', id: 'btn_add', label: '增行', action: 'table.add_row' },
    ];
    const seed = `table|basic|${compact.slice(0, 80)}`;
    const tool = baseSpec({
      title: '本地登记表',
      placement,
      widgets,
      utterance: raw,
      source: 'rules',
      seed,
      persist: 'none',
    });
    return { op: 'create_shell_tool', capability: 'shell_tool', tool, source: 'rules' };
  }

  // —— 名→算子：番茄钟 / 专注钟 / 番茄工作法 → timer ——
  if (/(番茄(?:钟|时钟|工作法)?|专注钟|专注计时)/.test(compact)) {
    const workMatch = compact.match(/(\d+)\s*分/);
    const workMin = Math.max(1, Math.min(workMatch ? Number(workMatch[1]) : 25, 180));
    const breakMatch = compact.match(/休息\s*(\d+)|(\d+)\s*分.?休息/);
    const breakMin = Math.max(
      1,
      Math.min(breakMatch ? Number(breakMatch[1] || breakMatch[2]) : 5, 60),
    );
    const title = /专注/.test(compact) && !/番茄/.test(compact) ? '专注钟' : '番茄时钟';
    const widgets: ShellWidget[] = [
      {
        type: 'timer',
        id: 't1',
        props: {
          modes: ['countdown'],
          initial_seconds: workMin * 60,
          label: /专注/.test(compact) && !/番茄/.test(compact) ? '专注' : '番茄',
          work_minutes: workMin,
          break_minutes: breakMin,
        },
      },
      {
        type: 'form',
        id: 'duration',
        fields: [
          { name: 'seconds', label: '工作秒数', input: 'number', default: workMin * 60 },
        ],
      },
      { type: 'button', id: 'btn_start', label: '开始', action: 'timer.start' },
      { type: 'button', id: 'btn_pause', label: '暂停', action: 'timer.pause' },
      { type: 'button', id: 'btn_reset', label: '复位', action: 'timer.reset' },
    ];
    const seed = `pomodoro|${workMin}|${breakMin}|${compact.slice(0, 80)}`;
    const tool = baseSpec({ title, placement, widgets, utterance: raw, source: 'rules', seed });
    return { op: 'create_shell_tool', capability: 'shell_tool', tool, source: 'rules' };
  }

  // —— P0 计时（保留） ——
  const wantReset = /复位|重置|清零/.test(compact);
  const wantCountdown = /倒计时/.test(compact);
  const wantStopwatch = /正计时|秒表/.test(compact) || (/计时/.test(compact) && !wantCountdown);
  const wantBoth = wantCountdown && wantStopwatch;

  let title = '壳内计时工具';
  const widgets: ShellWidget[] = [];
  const timerId = 't1';

  if (wantBoth) {
    title = wantReset ? '正倒计时（含复位）' : '正倒计时工具';
    widgets.push({
      type: 'timer',
      id: timerId,
      props: { modes: ['stopwatch', 'countdown'], initial_seconds: 60, label: '计时' },
    });
  } else if (wantCountdown) {
    title = wantReset ? '倒计时（含复位）' : '倒计时工具';
    const minM = compact.match(/(\d+)\s*分钟/);
    const secM = compact.match(/(\d+)\s*秒/);
    const initSec = minM
      ? Math.max(1, Math.min(Number(minM[1]) * 60, 86400))
      : secM
        ? Math.max(1, Math.min(Number(secM[1]), 86400))
        : /分/.test(compact)
          ? 300
          : 60;
    widgets.push({
      type: 'timer',
      id: timerId,
      props: { modes: ['countdown'], initial_seconds: initSec, label: '倒计时' },
    });
    widgets.push({
      type: 'form',
      id: 'duration',
      fields: [{ name: 'seconds', label: '秒数', input: 'number', default: initSec }],
    });
  } else if (wantStopwatch || /计时|秒表|节拍|时钟|小工具|壳内工具|小应用/.test(compact)) {
    title = wantReset ? '正计时（含复位）' : '正计时工具';
    widgets.push({
      type: 'timer',
      id: timerId,
      props: { modes: ['stopwatch'], label: '正计时' },
    });
  } else {
    return null;
  }

  widgets.push({ type: 'button', id: 'btn_start', label: '开始', action: 'timer.start' });
  widgets.push({ type: 'button', id: 'btn_pause', label: '暂停', action: 'timer.pause' });
  if (wantReset || wantCountdown) {
    widgets.push({ type: 'button', id: 'btn_reset', label: '复位', action: 'timer.reset' });
  }

  const seed = `${title}|${JSON.stringify(widgets.map((w) => (w.type === 'timer' ? w.props?.modes : w.type === 'button' ? w.action : w.type)))}|${compact.slice(0, 80)}`;
  const tool = baseSpec({ title, placement, widgets, utterance: raw, source: 'rules', seed });
  return { op: 'create_shell_tool', capability: 'shell_tool', tool, source: 'rules' };
}

function parseWidget(item: unknown, rejected: string[]): ShellWidget | null {
  if (!item || typeof item !== 'object') return null;
  const w = item as Record<string, unknown>;
  const type = String(w.type || '');
  if (!SHELL_WIDGET_WHITELIST.has(type)) {
    if (type) rejected.push(type);
    return null;
  }
  if (type === 'timer') {
    const props = (w.props && typeof w.props === 'object' ? w.props : {}) as Record<string, unknown>;
    const modesRaw = Array.isArray(props.modes) ? props.modes.map(String) : ['stopwatch'];
    const modes = modesRaw.filter((m): m is 'stopwatch' | 'countdown' => m === 'stopwatch' || m === 'countdown');
    const workMinRaw = Number(props.work_minutes);
    const breakMinRaw = Number(props.break_minutes);
    const work_minutes =
      Number.isFinite(workMinRaw) && workMinRaw >= 1 && workMinRaw <= 180 ? Math.floor(workMinRaw) : undefined;
    const break_minutes =
      Number.isFinite(breakMinRaw) && breakMinRaw >= 1 && breakMinRaw <= 60 ? Math.floor(breakMinRaw) : undefined;
    const fallbackSec = work_minutes ? work_minutes * 60 : Number(props.initial_seconds) || 60;
    return {
      type: 'timer',
      id: clip(String(w.id || 't1'), 32) || 't1',
      props: {
        modes: modes.length ? modes : work_minutes ? ['countdown'] : ['stopwatch'],
        initial_seconds: Math.max(1, Math.min(fallbackSec, 86400)),
        label: clip(String(props.label || (work_minutes ? '番茄' : '计时')), 40),
        ...(work_minutes ? { work_minutes } : {}),
        ...(break_minutes ? { break_minutes } : {}),
      },
    };
  }
  if (type === 'button') {
    const action = String(w.action || '');
    if (!SHELL_ACTION_WHITELIST.has(action)) {
      if (action) rejected.push(action);
      return null;
    }
    return {
      type: 'button',
      id: clip(String(w.id || randomUUID().slice(0, 8)), 32),
      label: clip(String(w.label || '按钮'), 20),
      action,
    };
  }
  if (type === 'form') {
    const fieldsIn = Array.isArray(w.fields) ? w.fields : [];
    const fields = fieldsIn.slice(0, 8).map((f) => {
      const row = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      return {
        name: clip(String(row.name || 'field'), 32),
        label: clip(String(row.label || '字段'), 20),
        input: row.input === 'text' ? ('text' as const) : ('number' as const),
        default: typeof row.default === 'number' || typeof row.default === 'string' ? row.default : undefined,
      };
    });
    return { type: 'form', id: clip(String(w.id || 'form1'), 32), fields };
  }
  if (type === 'calculator') {
    const props = (w.props && typeof w.props === 'object' ? w.props : {}) as Record<string, unknown>;
    const preset = props.preset === 'qty_price' ? 'qty_price' : 'basic';
    return {
      type: 'calculator',
      id: clip(String(w.id || 'c1'), 32),
      props: {
        label: clip(String(props.label || (preset === 'qty_price' ? '数量×单价' : '计算器')), 40),
        preset,
        initial_expr: clip(String(props.initial_expr || ''), 80),
      },
    };
  }
  if (type === 'table') {
    const props = (w.props && typeof w.props === 'object' ? w.props : {}) as Record<string, unknown>;
    const colsIn = Array.isArray(props.columns) ? props.columns : [];
    const columns = colsIn.slice(0, 8).map((c, i) => {
      const row = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return {
        key: clip(String(row.key || `col${i + 1}`), 24),
        label: clip(String(row.label || `列${i + 1}`), 20),
        input: row.input === 'number' ? ('number' as const) : ('text' as const),
      };
    });
    if (!columns.length) {
      columns.push(
        { key: 'name', label: '名称', input: 'text' },
        { key: 'qty', label: '数量', input: 'number' },
      );
    }
    const rowsIn = Array.isArray(props.initial_rows) ? props.initial_rows : [];
    const initial_rows = rowsIn.slice(0, 50).map((r) => {
      const row = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      const out: Record<string, string | number> = {};
      for (const col of columns) {
        const v = row[col.key];
        if (typeof v === 'number') out[col.key] = v;
        else if (typeof v === 'string') out[col.key] = clip(v, 200);
        else out[col.key] = col.input === 'number' ? 0 : '';
      }
      return out;
    });
    return {
      type: 'table',
      id: clip(String(w.id || 'tbl1'), 32),
      props: {
        columns,
        initial_rows,
        persist: props.persist === 'local' ? 'local' : 'none',
      },
    };
  }
  if (type === 'file_picker') {
    const props = (w.props && typeof w.props === 'object' ? w.props : {}) as Record<string, unknown>;
    return {
      type: 'file_picker',
      id: clip(String(w.id || 'files'), 32),
      props: {
        accept: clip(String(props.accept || 'application/pdf'), 120) || 'application/pdf',
        multiple: props.multiple !== false,
        label: clip(String(props.label || '选择文件'), 40),
        max_files: Math.max(1, Math.min(Number(props.max_files) || PDF_DEFAULT_LIMITS.max_files, 20)),
        max_mb: Math.max(1, Math.min(Number(props.max_mb) || PDF_DEFAULT_LIMITS.max_mb, 50)),
      },
    };
  }
  if (type === 'field_result') {
    const props = (w.props && typeof w.props === 'object' ? w.props : {}) as Record<string, unknown>;
    return {
      type: 'field_result',
      id: clip(String(w.id || 'fields'), 32),
      props: {
        label: clip(String(props.label || '提取结果'), 40),
        editable: props.editable !== false,
      },
    };
  }
  return null;
}

export function validateToolSpecDetailed(input: unknown): ValidateToolSpecResult {
  const allowed = [
    ...Array.from(SHELL_WIDGET_WHITELIST),
    ...Array.from(SHELL_ACTION_WHITELIST),
  ];
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'ToolSpec 无效', rejected: [], allowed };
  }
  const raw = input as Record<string, unknown>;
  const title = clip(String(raw.title || '未命名工具'), 40);
  if (!title) return { ok: false, reason: '缺少标题', rejected: [], allowed };
  // 缺省 chat_panel；仅显式 sidebar 才挂侧栏
  const placement = raw.placement === 'sidebar' ? 'sidebar' : 'chat_panel';

  // 沙箱 runtime：经 validateSandboxedTool 后放入
  if (raw.runtime === 'sandbox' && raw.sandbox && typeof raw.sandbox === 'object') {
    const sbCheck = validateSandboxedTool(raw.sandbox);
    if (!sbCheck.ok) {
      return { ok: false, reason: sbCheck.reason, rejected: sbCheck.rejected, allowed };
    }
    const id = clip(String(raw.id || digestId(`sandbox:${title}:${sbCheck.sandbox.html.length}`)), 64);
    const tool: ToolSpec = {
      id: id.startsWith('tool_') ? id : `tool_${id}`,
      title,
      placement,
      ui: { layout: 'single_page', widgets: [] },
      actions: [],
      data: { persist: 'none', table: null },
      permissions: {
        network: false,
        write_mes_entities: [],
        vision: sbCheck.sandbox.permissions.vision === true,
      },
      capability: 'shell_tool',
      source: raw.source === 'sandbox_codegen' ? 'sandbox_codegen' : raw.source === 'llm' ? 'llm' : 'rules',
      utterance: typeof raw.utterance === 'string' ? clip(raw.utterance, 400) : undefined,
      runtime: 'sandbox',
      sandbox: sbCheck.sandbox,
    };
    return { ok: true, tool };
  }

  const ui = (raw.ui && typeof raw.ui === 'object' ? raw.ui : {}) as Record<string, unknown>;
  const widgetsIn = Array.isArray(ui.widgets) ? ui.widgets : [];
  const rejected: string[] = [];
  const widgets: ShellWidget[] = [];
  for (const item of widgetsIn.slice(0, 24)) {
    const parsed = parseWidget(item, rejected);
    if (parsed) widgets.push(parsed);
  }
  if (!widgets.length) {
    return {
      ok: false,
      reason: rejected.length
        ? `未知或空算子：${Array.from(new Set(rejected)).join('、')}。当前白名单：${Array.from(SHELL_WIDGET_WHITELIST).join('/')}`
        : '未包含可用 widget（timer/calculator/table/form/file_picker/field_result/button）',
      rejected: Array.from(new Set(rejected)),
      allowed,
    };
  }
  const hasRunnable = widgets.some(
    (w) =>
      w.type === 'timer' ||
      w.type === 'calculator' ||
      w.type === 'table' ||
      w.type === 'file_picker' ||
      w.type === 'field_result' ||
      w.type === 'button',
  );
  if (!hasRunnable) {
    return { ok: false, reason: '缺少可运行算子（timer/calculator/table/file_picker/field_result/button）', rejected, allowed };
  }

  const actionsIn = Array.isArray(raw.actions) ? raw.actions : [];
  const actions: ToolSpec['actions'] = [];
  for (const a of actionsIn) {
    const row = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const id = String(row.id || '');
    if (!id) continue;
    if (!SHELL_ACTION_WHITELIST.has(id)) {
      rejected.push(id);
      continue;
    }
    const limits =
      row.limits && typeof row.limits === 'object' ? (row.limits as Record<string, unknown>) : undefined;
    actions.push({
      id,
      uses: typeof row.uses === 'string' ? row.uses : undefined,
      limits,
    });
  }

  // 从 widgets 补齐缺省 actions
  for (const w of widgets) {
    if (w.type === 'button' && SHELL_ACTION_WHITELIST.has(w.action) && !actions.some((a) => a.id === w.action)) {
      actions.push({ id: w.action });
    }
    if (w.type === 'calculator' && !actions.some((a) => a.id === 'calc.eval')) actions.push({ id: 'calc.eval' });
    if (w.type === 'table') {
      for (const id of ['table.add_row', 'table.delete_row'] as const) {
        if (!actions.some((a) => a.id === id)) actions.push({ id });
      }
    }
    if (w.type === 'timer') {
      for (const id of ['timer.start', 'timer.pause', 'timer.reset'] as const) {
        if (!actions.some((a) => a.id === id)) actions.push({ id });
      }
    }
  }

  // PDF actions 默认带限额
  for (const a of actions) {
    if (a.id.startsWith('pdf.') && !a.limits) {
      a.limits = { ...PDF_DEFAULT_LIMITS };
      a.uses = a.uses || 'file.pdf';
    }
  }

  if (rejected.length && !widgets.length) {
    return {
      ok: false,
      reason: `未知算子已拒绝：${Array.from(new Set(rejected)).join('、')}`,
      rejected: Array.from(new Set(rejected)),
      allowed,
    };
  }

  const persistRaw =
    raw.data && typeof raw.data === 'object'
      ? String((raw.data as Record<string, unknown>).persist || 'none')
      : 'none';
  const persist: ToolSpec['data']['persist'] =
    persistRaw === 'local' ? 'local' : persistRaw === 'light_table' ? 'light_table' : 'none';

  const id = clip(String(raw.id || digestId(`${title}:${JSON.stringify(widgets)}`)), 64);
  const tool: ToolSpec = {
    id: id.startsWith('tool_') ? id : `tool_${id}`,
    title,
    placement,
    ui: { layout: 'single_page', widgets },
    actions: actions.length
      ? actions
      : widgets
          .filter((w): w is Extract<ShellWidget, { type: 'button' }> => w.type === 'button')
          .map((w) => ({ id: w.action })),
    data: { persist, table: null },
    permissions: {
      network: false,
      write_mes_entities: [],
      vision: actions.some((a) => a.id === 'image.extract_fields') || widgets.some((w) => w.type === 'field_result'),
    },
    capability: 'shell_tool',
    source: raw.source === 'sandbox_codegen' ? 'sandbox_codegen' : raw.source === 'llm' ? 'llm' : 'rules',
    utterance: typeof raw.utterance === 'string' ? clip(raw.utterance, 400) : undefined,
    rejected_operators: rejected.length ? Array.from(new Set(rejected)) : undefined,
    runtime: 'spec',
  };
  return { ok: true, tool };
}

export function validateToolSpec(input: unknown): ToolSpec | null {
  const r = validateToolSpecDetailed(input);
  return r.ok ? r.tool : null;
}

/**
 * 安全表达式求值：仅四则、括号、小数、百分号；禁止标识符 / 任意 JS。
 * 支持「数量×单价」场景下由调用方先把变量替换成数字再传入。
 */
export function safeEvalExpression(expr: string): { ok: true; value: number } | { ok: false; error: string } {
  let s = String(expr || '').trim();
  if (!s) return { ok: false, error: '表达式为空' };
  if (s.length > 120) return { ok: false, error: '表达式过长' };
  s = s.replace(/×/g, '*').replace(/÷/g, '/').replace(/＋/g, '+').replace(/－/g, '-');
  // 百分：12% → (12/100)
  s = s.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
  if (!/^[\d+\-*/().\s]+$/.test(s)) {
    return { ok: false, error: '仅允许数字与 + - * / ( ) 及百分号，禁止任意脚本' };
  }
  // 禁连续运算符滥用以外：用 Function 仍不安全，改用手写递归下降 / 或限制后 new Function 仅算术
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${s});`);
    const value = fn();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: '结果不是有效数字' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: '表达式无法计算' };
  }
}

async function planShellToolWithLlm(raw: string): Promise<ShellToolParsed | null> {
  const config = readAiConfig();
  if (config.provider !== 'openai' || !config.apiKey) return null;
  const system = [
    '你是赛德瑞克 MES「壳内小工具」规划器。把用户中文口语变成 ToolSpec JSON，不要解释。',
    '用户可用任意工具名；你必须映射到白名单算子，禁止自由 codegen / 任意脚本。',
    '可映射时只输出一个 JSON 对象，字段：ok,id,title,placement,ui,actions,data,permissions,capability（ok 可省略，默认 true）。',
    'capability 固定为 shell_tool；placement 只能是 sidebar 或 chat_panel（默认 chat_panel=聊天壳浮层不进 MES；仅用户明确要侧栏/生产侧栏时用 sidebar）。',
    'ui.layout 固定 single_page。',
    'ui.widgets.type 仅允许：timer|button|form|calculator|table|file_picker|field_result。',
    'button.action 与 actions[].id 仅允许：timer.start|timer.pause|timer.reset|timer.set_duration|calc.eval|table.add_row|table.delete_row|pdf.merge|pdf.split|pdf.to_images|pdf.extract_text|image.extract_fields|fields.copy。',
    '名→算子映射：番茄钟/番茄时钟/专注钟/番茄工作法 → timer（modes:[countdown]，label 番茄或专注，props.work_minutes=25、break_minutes=5，initial_seconds=work_minutes*60）；正计时/秒表→timer stopwatch；倒计时→timer countdown；计算器/小算盘→calculator；PDF合并/拆/转图/抽文本→file_picker+pdf.*；提取图片字段/识图/OCR/扫描件抽字段→file_picker(accept=image/*)+table+field_result+image.extract_fields（可加 fields.copy）；登记表/本地表→table。',
    'calculator.props.preset 可为 basic 或 qty_price（数量×单价）。',
    'PDF 类需求必须含 file_picker(accept=application/pdf) + 对应 pdf.* button/action；actions 带 uses=file.pdf 与 limits{max_mb:20,max_files:10,max_pages:100}。',
    'data.persist 默认 none（table 可用 local）；permissions.network 固定 false；permissions.write_mes_entities 固定 []。',
    '禁止任意脚本、禁止 mes.write、禁止网络。不同需求必须产出不同 widgets。',
    '若无法映射到白名单：不要发明算子，也不要当成说明书问答；只输出 JSON {"ok":false,"reason":"当前算子盖不住","needed":["用户要的能力"],"hint":"可用 timer/calculator/table/file_picker/field_result/pdf.*/image.extract_fields"}。',
    '用户可能说「写/帮我写/弄/搞/来/给我/整一个番茄时钟」「写个专注钟」「做一个25分钟倒计时」「搞一个能合并PDF的工具」等，一律进本规划器产出 ToolSpec 或 ok:false，禁止掉说明书兜底。',
    '「怎么报工」「如何录入工艺」不是壳内工具；「加工单加个紧急度」是字段扩展，本规划器不应处理。',
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
    const parsedJson = JSON.parse(match[0]) as Record<string, unknown>;
    if (parsedJson.ok === false) return null; // 上层 resolve 会给出「当前算子盖不住」
    const detailed = validateToolSpecDetailed({ ...parsedJson, source: 'llm', utterance: raw });
    if (!detailed.ok) return null;
    return { op: 'create_shell_tool', capability: 'shell_tool', tool: detailed.tool, source: 'llm' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 补齐按钮与缺省算子 */
export function enrichToolSpec(tool: ToolSpec, utterance = ''): ToolSpec {
  const text = `${utterance} ${tool.title} ${tool.utterance || ''}`;
  const widgets = tool.ui.widgets.slice();
  const hasTimer = widgets.some((w) => w.type === 'timer');
  const buttons = widgets.filter((w): w is Extract<ShellWidget, { type: 'button' }> => w.type === 'button');
  const actions = new Set(buttons.map((b) => b.action).concat(tool.actions.map((a) => a.id)));
  const wantReset = /复位|重置|清零|倒计时/.test(text);

  if (hasTimer) {
    if (!actions.has('timer.start')) {
      widgets.push({ type: 'button', id: 'btn_start', label: '开始', action: 'timer.start' });
      actions.add('timer.start');
    }
    if (!actions.has('timer.pause')) {
      widgets.push({ type: 'button', id: 'btn_pause', label: '暂停', action: 'timer.pause' });
      actions.add('timer.pause');
    }
    if (wantReset && !actions.has('timer.reset')) {
      widgets.push({ type: 'button', id: 'btn_reset', label: '复位', action: 'timer.reset' });
      actions.add('timer.reset');
    }
  }
  // 纠偏：口语含倒计时/番茄/专注钟时，强制 countdown，并写入分钟 props
  const forceCountdown =
    /倒计时|番茄(?:钟|时钟|工作法)?|专注钟|专注计时/.test(text) && hasTimer;
  if (forceCountdown) {
    const minM = text.replace(/\s+/g, '').match(/(\d+)\s*分钟/);
    const workMatch = text.replace(/\s+/g, '').match(/番茄|专注/)
      ? text.replace(/\s+/g, '').match(/(\d+)\s*分/)
      : minM;
    const workMin = workMatch ? Math.max(1, Math.min(Number(workMatch[1]), 180)) : /番茄|专注/.test(text) ? 25 : minM ? Number(minM[1]) : 0;
    const initSec = workMin >= 1 ? workMin * 60 : minM ? Number(minM[1]) * 60 : 60;
    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i];
      if (w.type !== 'timer') continue;
      const props = { ...(w.props || {}) } as NonNullable<Extract<ShellWidget, { type: 'timer' }>['props']>;
      props.modes = ['countdown'];
      props.initial_seconds = initSec;
      if (/番茄|专注/.test(text)) {
        props.work_minutes = workMin >= 1 ? workMin : 25;
        props.break_minutes = props.break_minutes || 5;
        props.label = /专注/.test(text) && !/番茄/.test(text) ? '专注' : '番茄';
      } else {
        props.label = props.label || '倒计时';
      }
      widgets[i] = { ...w, props };
    }
  }
  const hasCountdown = widgets.some(
    (w) => w.type === 'timer' && Array.isArray(w.props?.modes) && w.props!.modes!.includes('countdown'),
  );
  const hasForm = widgets.some((w) => w.type === 'form');
  if (hasCountdown && !hasForm) {
    widgets.push({
      type: 'form',
      id: 'duration',
      fields: [{ name: 'seconds', label: '秒数', input: 'number', default: 60 }],
    });
  }

  const hasCalc = widgets.some((w) => w.type === 'calculator');
  if (hasCalc) {
    actions.add('calc.eval');
    if (!buttons.some((b) => b.action === 'calc.eval')) {
      widgets.push({ type: 'button', id: 'btn_calc', label: '计算', action: 'calc.eval' });
    }
  }
  // 数量×单价：补 form
  const calcW = widgets.find((w): w is Extract<ShellWidget, { type: 'calculator' }> => w.type === 'calculator');
  if (calcW?.props?.preset === 'qty_price' && !widgets.some((w) => w.type === 'form')) {
    widgets.push({
      type: 'form',
      id: 'qp',
      fields: [
        { name: 'qty', label: '数量', input: 'number', default: 1 },
        { name: 'price', label: '单价', input: 'number', default: 0 },
      ],
    });
  }

  const hasTable = widgets.some((w) => w.type === 'table');
  if (hasTable && !actions.has('table.add_row')) {
    widgets.push({ type: 'button', id: 'btn_add', label: '增行', action: 'table.add_row' });
    actions.add('table.add_row');
  }

  const pdfActions = ['pdf.merge', 'pdf.split', 'pdf.to_images', 'pdf.extract_text'] as const;
  const hasPdfAction = pdfActions.some((id) => actions.has(id)) || /pdf\./i.test(JSON.stringify(tool.actions));
  const hasPicker = widgets.some((w) => w.type === 'file_picker');
  if (hasPdfAction && !hasPicker) {
    widgets.unshift({
      type: 'file_picker',
      id: 'pdf_files',
      props: {
        accept: 'application/pdf',
        multiple: true,
        label: '选择 PDF',
        max_files: PDF_DEFAULT_LIMITS.max_files,
        max_mb: PDF_DEFAULT_LIMITS.max_mb,
      },
    });
  }
  for (const id of pdfActions) {
    if (actions.has(id) && !buttons.some((b) => b.action === id)) {
      const labels: Record<string, string> = {
        'pdf.merge': '合并 PDF',
        'pdf.split': '拆分 PDF',
        'pdf.to_images': '转图片',
        'pdf.extract_text': '提取文本',
      };
      widgets.push({
        type: 'button',
        id: `btn_${id.replace(/\./g, '_')}`,
        label: labels[id],
        action: id,
      });
    }
  }

  // 识图抽字段：保证 picker(accept 图片) + table + extract 按钮
  const wantVision =
    actions.has('image.extract_fields') ||
    looksLikeImageExtractIntent(text) ||
    /image\.extract_fields|识图|图片字段|OCR|扫描件/.test(text);
  if (wantVision) {
    actions.add('image.extract_fields');
    if (!widgets.some((w) => w.type === 'file_picker')) {
      widgets.unshift({
        type: 'file_picker',
        id: 'img_files',
        props: {
          accept: 'image/png,image/jpeg,image/webp,image/gif',
          multiple: false,
          label: '选择图片 / 扫描件',
          max_files: 1,
          max_mb: 5,
        },
      });
    } else {
      for (let i = 0; i < widgets.length; i++) {
        const w = widgets[i];
        if (w.type !== 'file_picker') continue;
        const props = { ...(w.props || {}) };
        if (!props.accept || props.accept === 'application/pdf') {
          props.accept = 'image/png,image/jpeg,image/webp,image/gif';
          props.label = props.label || '选择图片 / 扫描件';
          props.multiple = false;
          props.max_mb = props.max_mb || 5;
        }
        widgets[i] = { ...w, props };
      }
    }
    if (!widgets.some((w) => w.type === 'table')) {
      widgets.push({
        type: 'table',
        id: 'field_tbl',
        props: {
          columns: [
            { key: 'key', label: '字段键', input: 'text' },
            { key: 'label', label: '字段名', input: 'text' },
            { key: 'value', label: '值', input: 'text' },
          ],
          initial_rows: [],
          persist: 'none',
        },
      });
    }
    if (!widgets.some((w) => w.type === 'field_result')) {
      widgets.push({ type: 'field_result', id: 'fields', props: { label: '提取结果', editable: true } });
    }
    if (!buttons.some((b) => b.action === 'image.extract_fields')) {
      widgets.push({ type: 'button', id: 'btn_extract', label: '识图提取字段', action: 'image.extract_fields' });
    }
    if (!buttons.some((b) => b.action === 'fields.copy') && !actions.has('fields.copy')) {
      widgets.push({ type: 'button', id: 'btn_copy', label: '复制字段', action: 'fields.copy' });
      actions.add('fields.copy');
    }
  }

  const actionList: ToolSpec['actions'] = [];
  for (const id of actions) {
    if (!SHELL_ACTION_WHITELIST.has(id)) continue;
    const prev = tool.actions.find((a) => a.id === id);
    if (id.startsWith('pdf.')) {
      actionList.push({
        id,
        uses: prev?.uses || 'file.pdf',
        limits: prev?.limits || { ...PDF_DEFAULT_LIMITS },
      });
    } else if (id === 'image.extract_fields') {
      actionList.push({ id, uses: prev?.uses || 'file.image', limits: prev?.limits || { max_mb: 5, max_files: 1 } });
    } else {
      actionList.push(prev || { id });
    }
  }

  const vision = wantVision || actionList.some((a) => a.id === 'image.extract_fields');
  return {
    ...tool,
    ui: { ...tool.ui, widgets },
    actions: actionList.length ? actionList : tool.actions,
    permissions: { network: false, write_mes_entities: [], vision: vision || tool.permissions?.vision === true },
    runtime: tool.runtime || 'spec',
  };
}

const SANDBOX_FORBIDDEN = [
  /fetch\s*\(/i,
  /XMLHttpRequest/i,
  /WebSocket/i,
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
  /document\.cookie/i,
  /\bparent\./,
  /\btop\./,
  /window\.parent/i,
  /window\.top/i,
  /import\s*\(/i,
  /Worker\s*\(/i,
];

export function validateSandboxedTool(
  input: unknown,
): { ok: true; sandbox: SandboxedToolPayload } | { ok: false; reason: string; rejected: string[] } {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: '沙箱工具无效', rejected: [] };
  }
  const raw = input as Record<string, unknown>;
  const html = String(raw.html || '');
  const js = String(raw.js || '');
  if (html.length > 80_000 || js.length > 80_000) {
    return { ok: false, reason: '沙箱代码过大', rejected: ['size'] };
  }
  const blob = `${html}\n${js}`;
  const rejected: string[] = [];
  for (const re of SANDBOX_FORBIDDEN) {
    if (re.test(blob)) rejected.push(String(re));
  }
  if (rejected.length) {
    return { ok: false, reason: `沙箱代码含禁止 API：${rejected.slice(0, 5).join('、')}`, rejected };
  }
  const permsIn =
    raw.permissions && typeof raw.permissions === 'object'
      ? (raw.permissions as Record<string, unknown>)
      : {};
  const sandbox: SandboxedToolPayload = {
    kind: 'sandboxed_html',
    title: clip(String(raw.title || ''), 40) || undefined,
    permissions: {
      network: false,
      write_mes_entities: [],
      vision: permsIn.vision === true,
    },
    html,
    js,
  };
  return { ok: true, sandbox };
}

/** DeepSeek 文本模型生成壳内沙箱工具（默认不写 MES；只经 SedricBridge） */
export async function planSandboxToolWithLlm(raw: string): Promise<ShellToolParsed | null> {
  const config = readAiConfig();
  if (config.provider !== 'openai' || !config.apiKey) return null;
  const system = [
    '你是赛德瑞克壳内沙箱工具生成器。用户要用自然语言做一个小工具，但白名单 Spec 盖不住。',
    '只输出一个 JSON：{"kind":"sandboxed_html","title":"...","permissions":{"network":false,"write_mes_entities":[],"vision":true|false},"html":"...","js":"..."}。',
    'html/js 运行在 iframe sandbox（allow-scripts，无 same-origin）。禁止 fetch/XMLHttpRequest/WebSocket/eval/Function/document.cookie/parent./top.。',
    '只能通过 window.SedricBridge 调宿主：pickFile({accept}), extractImageFields(fileMeta), showToast(msg), setTitle(title)。',
    'extractImageFields 入参为 {name,type,size,base64}（由 pickFile 返回）；返回 {fields:[{key,label,value}], raw_text?}。',
    '默认不能写 MES；permissions.write_mes_entities 必须 []；network 必须 false。',
    '若需求是识图/提取图片字段：vision=true，用 Bridge.pickFile + extractImageFields 展示可编辑结果。',
    'UI 简洁；可用主色 #4184F4；中文文案。不要静默写合同。',
  ].join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
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
        temperature: 0.2,
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
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const title = clip(String(parsed.title || '沙箱小工具'), 40);
    const detailed = validateToolSpecDetailed({
      title,
      placement: 'chat_panel',
      runtime: 'sandbox',
      sandbox: parsed,
      source: 'sandbox_codegen',
      utterance: raw,
      id: digestId(`sandbox:${title}:${raw.slice(0, 80)}`),
    });
    if (!detailed.ok) return null;
    return {
      op: 'create_shell_tool',
      capability: 'shell_tool',
      tool: detailed.tool,
      source: 'sandbox_codegen',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 商用入口：LLM 优先，规则兜底；失败再沙箱 codegen；名→算子明确词规则优先 */
export async function resolveShellToolUtterance(
  raw: string,
  opts?: { forceSoft?: boolean; allowSandbox?: boolean },
): Promise<ShellToolParsed | null> {
  const gated = looksLikeShellToolIntent(raw) || (opts?.forceSoft === true && softShellTopicHint(raw));
  if (!gated) return null;
  const compact = raw.trim().replace(/\s+/g, '');
  // 识图抽字段：规则优先，保证「写一个提取图片字段的工具」出方案卡
  if (looksLikeImageExtractIntent(compact)) {
    const visionRules = planShellToolByRules(raw);
    if (visionRules) {
      return { ...visionRules, tool: enrichToolSpec(visionRules.tool, raw) };
    }
  }
  const nameMapped =
    /(番茄(?:钟|时钟|工作法)?|专注钟|专注计时)/.test(compact) ||
    (/倒计时/.test(compact) && /\d+\s*分/.test(compact));
  if (nameMapped) {
    const rulesFirst = planShellToolByRules(raw) || (softShellTopicHint(raw) ? planShellToolByRulesSoft(raw) : null);
    if (rulesFirst) {
      return { ...rulesFirst, tool: enrichToolSpec(rulesFirst.tool, raw) };
    }
  }
  const llm = await planShellToolWithLlm(raw);
  if (llm) {
    const tool = enrichToolSpec(llm.tool, raw);
    return { ...llm, tool };
  }
  let rules = planShellToolByRules(raw);
  if (!rules && softShellTopicHint(raw)) {
    rules = planShellToolByRulesSoft(raw);
  }
  if (rules) {
    return { ...rules, tool: enrichToolSpec(rules.tool, raw) };
  }
  // Spec 仍失败：沙箱 codegen（DeepSeek 写壳内工具；默认不写 MES）
  if (opts?.allowSandbox !== false && looksLikeShellToolIntent(raw)) {
    const sandbox = await planSandboxToolWithLlm(raw);
    if (sandbox) return sandbox;
  }
  return null;
}


/** 软话题规则兜底：原话规则未命中时，用「做一个/写一个」前缀再走规则（适应极简口语） */
function planShellToolByRulesSoft(raw: string): ShellToolParsed | null {
  const compact = raw.trim().replace(/\s+/g, '');
  if (!softShellTopicHint(compact)) return null;
  // 避免前缀叠加过长；已含宽动词则直接失败返回
  if (SHELL_GEN_VERB_RE.test(compact) && (SHELL_TOPIC_RE.test(compact) || SHELL_OBJECT_RE.test(compact))) {
    // 已有动词+话题仍无 Spec：按名→算子再拼一次
    if (/(番茄|专注钟|番茄工作法)/.test(compact)) return planShellToolByRules(`帮我写一个番茄时钟`);
    if (/(PDF|pdf)/.test(compact)) return planShellToolByRules(`做一个能处理PDF的工具`);
    if (/(倒计时)/.test(compact)) return planShellToolByRules(`做一个25分钟倒计时`);
    if (/(正计时|计时器|秒表|时钟|专注)/.test(compact)) return planShellToolByRules(`做一个正计时`);
    if (/(计算器|小算盘|算盘)/.test(compact)) return planShellToolByRules(`写一个计算器`);
    if (/(表格|登记表|表单|登记)/.test(compact)) return planShellToolByRules(`做一个本地登记表`);
    if (looksLikeImageExtractIntent(compact)) return planShellToolByRules(`写一个提取图片字段的工具`);
  }
  return (
    planShellToolByRules(`做一个${compact}`) ||
    planShellToolByRules(`写一个${compact}`) ||
    null
  );
}

export function summarizeToolSpec(tool: ToolSpec): string {
  const ops = collectOperators(tool);
  const modes = tool.ui.widgets
    .filter((w): w is Extract<ShellWidget, { type: 'timer' }> => w.type === 'timer')
    .flatMap((w) => w.props?.modes || []);
  const buttons = tool.ui.widgets
    .filter((w): w is Extract<ShellWidget, { type: 'button' }> => w.type === 'button')
    .map((w) => `${w.label}→${w.action}`);
  const forms = tool.ui.widgets.filter((w) => w.type === 'form').length;
  const hasCalc = tool.ui.widgets.some((w) => w.type === 'calculator');
  const hasTable = tool.ui.widgets.some((w) => w.type === 'table');
  const pdfActs = tool.actions.filter((a) => a.id.startsWith('pdf.')).map((a) => a.id);
  const hasVision = tool.actions.some((a) => a.id === 'image.extract_fields') || tool.permissions?.vision === true;
  const isSandbox = tool.runtime === 'sandbox';
  const rejected = tool.rejected_operators?.length
    ? `已拒绝未知算子：${tool.rejected_operators.join('、')}`
    : '';
  const canDoBits = [
    `壳内运行「${tool.title}」`,
    tool.placement === 'sidebar' ? 'MES 侧栏 +「我的工具」可打开' : '聊天壳打开，不进 MES（「我的工具」浮层）',
    modes.length ? `计时：${Array.from(new Set(modes)).join('+')}` : '',
    hasCalc ? '安全计算器（禁任意 JS）' : '',
    hasTable ? '本地表格增删行' : '',
    pdfActs.length ? `PDF ${pdfActs.join('/')}` : '',
    hasVision ? 'DeepSeek 识图抽字段（可编辑结果；确认前不写 MES）' : '',
    isSandbox ? '由 DeepSeek 生成壳内沙箱工具（经 SedricBridge；可回退）' : '',
  ].filter(Boolean);
  return [
    isSandbox
      ? `将生成壳内沙箱工具「${tool.title}」（DeepSeek codegen-shell-safe，非任意脚本进主站）`
      : `将生成壳内工具「${tool.title}」（Spec 驱动，非预制开关）`,
    `能做：${canDoBits.join('；')}`,
    hasVision
      ? '不能做：不联网直连外站、不静默写 MES；可选「复制字段」；落进合同必须走已有落单确认（本期可不接落单）'
      : '不能做：不联网、不写 MES 业务表、不执行任意代码、不生成外挂站',
    `算子：${isSandbox ? 'runtime=sandbox' : ops.join('、') || '无'}`,
    `权限：network=false；write_mes_entities=[]${hasVision ? '；vision=true（经宿主 API）' : ''}`,
    buttons.length ? `按钮：${buttons.join('、')}` : '',
    forms ? `含表单字段组×${forms}` : '',
    rejected,
    "回退：聊天说『回退该扩展』后「我的工具」入口消失（与快递约件同一套话术）",
  ]
    .filter(Boolean)
    .join('；');
}

export function shellOperatorHint(): string {
  const widgets = SHELL_OPERATOR_CATALOG.filter((o) => o.kind === 'widget')
    .map((o) => o.id)
    .join('/');
  const actions = SHELL_OPERATOR_CATALOG.filter((o) => o.kind === 'action')
    .map((o) => o.id)
    .join('/');
  return (
    `当前可写算子：widgets=${widgets}；actions=${actions}。` +
    '也可许愿：识图抽字段 / 计时 / 计算 / PDF / 沙箱小工具。不能发明任意脚本进主站或 mes.write。'
  );
}
