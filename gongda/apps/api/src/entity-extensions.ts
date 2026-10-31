import type { FastifyInstance } from 'fastify';
import { Problem, type Services } from './services.js';
import { bodyOf, clean, idOf, withTenant } from './round8-kit.js';
import type { Sql } from './database.js';

export const ENTITY_KINDS = [
  'work_order', 'linkman', 'customer',
  'supplier', 'purchase_plan', 'purchase_order',
  'purchase_stock_in', 'purchase_stock_in_line',
  'customer_contract', 'contract_quotation', 'customer_follow',
  'customer_financier', 'customer_invoice', 'selling_expense',
  'else_stock_in', 'else_stock_out',
  'stock_taking', 'stock_allocate',
  'fg_receipt', 'fg_receipt_line',
  'semi_fg',
  'sale_stock_out', 'purchase_return', 'material_issue', 'prod_return', 'sales_return',
  'craft', 'bom',
  'production_plan',
  'lean_meeting', 'meeting_agenda',
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

const WORK_ORDER_TYPES = [
  '单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间',
  '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '公式', '关联对象', '关联属性',
] as const;

const STANDARD_TYPES = WORK_ORDER_TYPES.filter((t) => t !== '公式');
/** 客户扩展：原版 16 项中文类型，无公式。顺序与新增下拉一致。 */
const CUSTOMER_TYPES = [
  '单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间',
  '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '关联对象', '关联属性',
] as const;
const CRAFT_TYPES = WORK_ORDER_TYPES.filter((t) => t !== '公式' && t !== '关联对象' && t !== '关联属性');

const FORMULA_ENTITIES = new Set<EntityKind>(['work_order', 'bom']);
const AUTOFILL_ENTITIES = new Set<EntityKind>(['work_order']);

const ENTITY_LABEL: Record<EntityKind, string> = {
  work_order: '加工单', linkman: '客户联系人', customer: '客户',
  supplier: '供应商', purchase_plan: '采购计划', purchase_order: '采购单',
  purchase_stock_in: '采购入库单', purchase_stock_in_line: '采购入库明细',
  customer_contract: '合同订单', contract_quotation: '合同报价单', customer_follow: '客户跟单',
  customer_financier: '收支记录', customer_invoice: '发票管理', selling_expense: '销售费用',
  else_stock_in: '其他入库单', else_stock_out: '其他出库单',
  stock_taking: '库存盘点', stock_allocate: '调拨单',
  fg_receipt: '成品入库单', fg_receipt_line: '成品入库明细',
  semi_fg: '半成品入库单',
  sale_stock_out: '销售出库单', purchase_return: '采购退货单', material_issue: '生产出库单',
  prod_return: '生产退料单', sales_return: '销售退货单',
  craft: '工序', bom: 'BOM',
  production_plan: '生产计划',
  lean_meeting: '精益会议', meeting_agenda: '会议议程',
};

const FIXED_OPTIONAL = new Set(['公式', '关联对象', '关联属性']);

const PRODUCT_AUTOFILL = [
  { key: 'code', label: '商品编号' }, { key: 'name', label: '商品名' }, { key: 'category_name', label: '类别' },
  { key: 'unit_name', label: '单位' }, { key: 'sale_price', label: '销售单价' }, { key: 'source', label: '商品来源' },
  { key: 'supplier_name', label: '默认供应商' }, { key: 'specification', label: '规格' },
  { key: 'attachments', label: '附件' }, { key: 'remark', label: '备注' },
];

const CONTRACT_AUTOFILL = [
  { key: 'code', label: '合同编号' }, { key: 'customer_code', label: '客户编号' }, { key: 'customer_name', label: '客户名称' },
  { key: 'contact_name', label: '联系人' }, { key: 'address', label: '客户地址' }, { key: 'approval', label: '审核状态' },
  { key: 'salesperson_name', label: '业务员' }, { key: 'amount', label: '合同金额' }, { key: 'prepay', label: '预付款' },
  { key: 'received_total', label: '累计收款' }, { key: 'expense_total', label: '累计支出' }, { key: 'invoiced_total', label: '已开票金额' },
  { key: 'arrears', label: '欠款' }, { key: 'delivery_date', label: '交货日期' }, { key: 'note', label: '备注' },
  { key: 'approver_name', label: '审核人' }, { key: 'approved_at', label: '审核通过时间' },
  { key: 'creator_name', label: '创建人' }, { key: 'created_at', label: '创建时间' },
];

const CONTRACT_LINE_AUTOFILL = [
  { key: 'product_name', label: '商品名' }, { key: 'product_code', label: '商品编号' }, { key: 'product_spec', label: '商品规格' },
  { key: 'product_category', label: '商品类别' }, { key: 'unit_price', label: '商品单价' }, { key: 'quantity', label: '销售数量' },
  { key: 'discount', label: '折扣' }, { key: 'discount_amount', label: '优惠金额' }, { key: 'line_amount', label: '折后金额' },
  { key: 'attachments', label: '附件' }, { key: 'note', label: '备注' },
];

const SOURCE_LABEL: Record<string, string> = { product: '商品', contract: '合同', contract_line: '合同明细' };

type FieldRow = {
  id: string; entity: EntityKind; name: string; field_type: string; required: boolean; sort_no: number;
  options: Record<string, unknown>; created_at: string; updated_at: string;
};

function entityOf(value: unknown): EntityKind {
  const text = String(value ?? '').trim();
  if ((ENTITY_KINDS as readonly string[]).includes(text)) return text as EntityKind;
  throw new Problem(422, 'ENTITY', '实体类型不正确');
}

function allowedTypes(entity: EntityKind): readonly string[] {
  if (entity === 'customer') return CUSTOMER_TYPES;
  if (FORMULA_ENTITIES.has(entity)) return WORK_ORDER_TYPES;
  if (entity === 'craft') return CRAFT_TYPES;
  return STANDARD_TYPES;
}

function valuePermission(entity: EntityKind, write: boolean) {
  if (entity === 'work_order' || entity === 'craft' || entity === 'bom' || entity === 'production_plan' || entity === 'lean_meeting' || entity === 'meeting_agenda') return write ? 'production.write' : 'production.read';
  if (entity === 'supplier' || entity === 'purchase_plan' || entity === 'purchase_order' || entity === 'purchase_stock_in' || entity === 'purchase_stock_in_line' || entity === 'purchase_return') {
    return write ? 'procurement.write' : 'procurement.read';
  }
  if (entity === 'else_stock_in' || entity === 'else_stock_out' || entity === 'stock_taking' || entity === 'stock_allocate' || entity === 'fg_receipt' || entity === 'fg_receipt_line' || entity === 'semi_fg' || entity === 'sale_stock_out' || entity === 'material_issue' || entity === 'prod_return' || entity === 'sales_return') {
    return write ? 'inventory.write' : 'inventory.read';
  }
  if (entity === 'customer_financier') return write ? 'finance.write' : 'finance.read';
  return write ? 'sales.write' : 'sales.read';
}

function shanghai(value: unknown) {
  if (!value) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(String(value))).replace('T', ' ');
}

function parseOptions(raw: unknown, fieldType: string, entity: EntityKind): Record<string, unknown> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const options: Record<string, unknown> = {};
  if (fieldType === '单选下拉框' || fieldType === '多选下拉框') {
    const choices = Array.isArray(src.choices)
      ? src.choices.map((item) => String(item).trim()).filter(Boolean)
      : String(src.choices_text ?? src.options ?? '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (!choices.length) throw new Problem(422, 'OPTIONS', '请填写下拉框数据');
    options.choices = choices;
  }
  if (fieldType === '单行文本') {
    const modes = Array.isArray(src.input_modes) ? src.input_modes.map(String) : ['手动输入'];
    options.input_modes = modes.length ? modes : ['手动输入'];
  }
  if (fieldType === '公式') {
    const formula = String(src.formula ?? '').trim();
    if (!formula) throw new Problem(422, 'FORMULA', '请填写计算公式');
    const check = validateExtFormula(formula);
    if (!check.ok) throw new Problem(422, 'FORMULA', check.message);
    options.formula = formula;
    if (src.decimals != null && src.decimals !== '') {
      const decimals = Number(src.decimals);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Problem(422, 'DECIMALS', '小数位数须为0至8的整数');
      options.decimals = decimals;
    }
  }
  if (fieldType === '关联对象') {
    options.biz_object = clean(src.biz_object, 40, '业务对象', true, 'select');
    options.display_field = clean(src.display_field, 40, '显示字段', true, 'select');
  }
  if (fieldType === '关联属性') {
    options.rel_object = clean(src.rel_object, 40, '关联对象', true, 'select');
    options.rel_field = clean(src.rel_field, 40, '关联字段', true, 'select');
  }
  if (AUTOFILL_ENTITIES.has(entity) && fieldType !== '公式' && src.autofill) {
    const autofill = src.autofill as { source?: string; field?: string };
    const source = String(autofill.source ?? '').trim();
    const field = String(autofill.field ?? '').trim();
    if (source && field) {
      if (!['product', 'contract', 'contract_line'].includes(source)) throw new Problem(422, 'AUTOFILL', '自动填充数据源不正确');
      options.autofill = { source, field };
    }
  }
  return options;
}

/** 加工单扩展公式：支持 ${对象.字段}、CASE/TRUNC/ROUND/ROUNDUP/ROUNDDOWN、比较与四则运算 */
export function validateExtFormula(expression: string): { ok: true } | { ok: false; message: string } {
  const text = expression.trim();
  if (!text) return { ok: false, message: '计算公式不能为空' };
  if (text.length > 2000) return { ok: false, message: '计算公式不能超过2000个字符' };
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2);
      if (end < 0) return { ok: false, message: '公式引用缺少右花括号' };
      const ref = text.slice(i + 2, end).trim();
      if (!ref || !/^[\u4e00-\u9fa5A-Za-z0-9_.]+$/.test(ref)) return { ok: false, message: '公式引用格式不正确，应为 ${对象.字段}' };
      i = end + 1;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth < 0) return { ok: false, message: '括号不匹配' };
    }
    i += 1;
  }
  if (depth !== 0) return { ok: false, message: '括号不匹配' };
  const stripped = text.replace(/\$\{[^}]+\}/g, '1');
  if (/[^\s0-9.+\-*/(),;'<>=!&|A-Za-z\u4e00-\u9fa5'"]/.test(stripped.replace(/CASE|TRUNC|ROUNDUP|ROUNDDOWN|ROUND/gi, ''))) {
    // allow Chinese labels only inside ${}; after strip should be operators/functions/numbers
  }
  const withoutRefs = text.replace(/\$\{[^}]+\}/g, '1');
  const tokens = withoutRefs.match(/[A-Za-z_]+/g) ?? [];
  const allowed = new Set(['CASE', 'TRUNC', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'AND', 'OR', 'TRUE', 'FALSE']);
  for (const token of tokens) {
    if (!allowed.has(token.toUpperCase())) return { ok: false, message: `不支持的函数或标识符：${token}` };
  }
  if (/[=<>!]=?|&&|\|\|/.test(withoutRefs) === false && /CASE/i.test(withoutRefs) === false) {
    // plain arithmetic ok
  }
  try {
    // light parse: replace CASE(...) with 1 and ensure remaining is numeric expression-ish
    const probe = withoutRefs
      .replace(/CASE\s*\([^)]*\)/gi, '1')
      .replace(/ROUND(?:UP|DOWN)?\s*\([^)]*\)/gi, '1')
      .replace(/TRUNC\s*\([^)]*\)/gi, '1')
      .replace(/True|False/gi, '1')
      .replace(/&&|\|\|/g, '+')
      .replace(/==|!=|>=|<=|>|</g, '+')
      .replace(/;/g, '+');
    if (!/^[\s0-9.+\-*/(),]+$/.test(probe)) return { ok: false, message: '公式语法不正确' };
  } catch {
    return { ok: false, message: '公式语法不正确' };
  }
  return { ok: true };
}

async function applyAutofill(sql: Sql, fields: FieldRow[], ctx: { product_id?: string; contract_id?: string; contract_line_id?: string }, values: Record<string, unknown>) {
  const next = { ...values };
  for (const field of fields) {
    const autofill = field.options?.autofill as { source?: string; field?: string } | undefined;
    if (!autofill?.source || !autofill.field) continue;
    const filled = await resolveAutofillValue(sql, autofill.source, autofill.field, ctx);
    if (filled !== undefined && filled !== null && filled !== '') next[field.id] = filled;
  }
  return next;
}

async function resolveAutofillValue(sql: Sql, source: string, field: string, ctx: { product_id?: string; contract_id?: string; contract_line_id?: string }) {
  if (source === 'product' && ctx.product_id) {
    const row = (await sql.query<Record<string, unknown>>(
      `SELECT p.code,p.name,c.name AS category_name,u.name AS unit_name,p.sale_price::text AS sale_price,
              coalesce(p.source,'') AS source,coalesce(s.name,'') AS supplier_name,coalesce(p.specification,'') AS specification,
              coalesce(p.attachments::text,'[]') AS attachments,coalesce(p.remark,'') AS remark
       FROM products p
       LEFT JOIN product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
       LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
       LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.default_supplier_id
       WHERE p.id=$1`,
      [ctx.product_id],
    )).rows[0];
    return row?.[field] ?? '';
  }
  if (source === 'contract' && ctx.contract_id) {
    const row = (await sql.query<Record<string, unknown>>(
      `SELECT ct.code,cu.code AS customer_code,cu.name AS customer_name,ct.contact_name,ct.address,ct.approval,
              coalesce(sp.display_name,'') AS salesperson_name,ct.amount::text AS amount,ct.prepay::text AS prepay,
              '' AS received_total,'' AS expense_total,'' AS invoiced_total,'' AS arrears,
              coalesce(ct.delivery_date::text,'') AS delivery_date,coalesce(ct.note,'') AS note,
              '' AS approver_name,coalesce(ct.approved_at::text,'') AS approved_at,
              coalesce(cr.display_name,'') AS creator_name,ct.created_at::text AS created_at
       FROM money_contracts ct
       JOIN customers cu ON cu.tenant_id=ct.tenant_id AND cu.id=ct.customer_id
       LEFT JOIN tenant_team_members sp ON sp.id=ct.salesperson_id
       LEFT JOIN tenant_team_members cr ON cr.id=ct.created_by
       WHERE ct.id=$1`,
      [ctx.contract_id],
    )).rows[0];
    return row?.[field] ?? '';
  }
  if (source === 'contract_line' && ctx.contract_line_id) {
    const row = (await sql.query<Record<string, unknown>>(
      `SELECT l.product_name,l.product_code,coalesce(nullif(l.specification,''),p.specification,'') AS product_spec,
              coalesce(c.name,'') AS product_category,
              l.unit_price::text AS unit_price,l.quantity::text AS quantity,
              coalesce(l.discount::text,'') AS discount,coalesce(l.concession::text,'') AS discount_amount,
              coalesce(l.net_amount::text,l.amount::text,'') AS line_amount,'' AS attachments,coalesce(l.note,'') AS note
       FROM money_contract_lines l
       LEFT JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id
       LEFT JOIN product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
       WHERE l.id=$1`,
      [ctx.contract_line_id],
    )).rows[0];
    return row?.[field] ?? '';
  }
  return '';
}

function shapeField(row: FieldRow) {
  return {
    id: row.id,
    key: row.id,
    entity: row.entity,
    name: row.name,
    type: row.field_type,
    field_type: row.field_type,
    required: row.required,
    required_text: row.required ? '是' : '否',
    sort_no: row.sort_no,
    options: row.options ?? {},
    created_at: row.created_at,
    createdAt: shanghai(row.created_at),
    updated_at: row.updated_at,
  };
}

async function listFields(sql: Sql, entity: EntityKind) {
  return (await sql.query<FieldRow>(
    'SELECT id,entity,name,field_type,required,sort_no,options,created_at,updated_at FROM entity_ext_fields WHERE entity=$1 ORDER BY sort_no,created_at,id',
    [entity],
  )).rows;
}

export function registerEntityExtensions(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'configuration.read', work);
  const manage = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'configuration.manage', work);
  const valueRead = (request: Parameters<typeof withTenant>[1], entity: EntityKind, work: Parameters<typeof withTenant>[3]) =>
    withTenant(services, request, valuePermission(entity, false), work);
  const valueWrite = (request: Parameters<typeof withTenant>[1], entity: EntityKind, work: Parameters<typeof withTenant>[3]) =>
    withTenant(services, request, valuePermission(entity, true), work);

  app.get('/api/entity-ext-fields/autofill-options', (request) => read(request, async () => ({
    items: [
      { value: 'product', label: SOURCE_LABEL.product, children: PRODUCT_AUTOFILL.map((item) => ({ value: item.key, label: item.label })) },
      { value: 'contract', label: SOURCE_LABEL.contract, children: CONTRACT_AUTOFILL.map((item) => ({ value: item.key, label: item.label })) },
      { value: 'contract_line', label: SOURCE_LABEL.contract_line, children: CONTRACT_LINE_AUTOFILL.map((item) => ({ value: item.key, label: item.label })) },
    ],
  })));

  app.post('/api/entity-ext-fields/validate-formula', (request) => read(request, async () => {
    const body = bodyOf(request);
    const formula = String(body.formula ?? body.expression ?? '').trim();
    const result = validateExtFormula(formula);
    if (!result.ok) throw new Problem(422, 'FORMULA', result.message);
    return { ok: true };
  }));

  app.put('/api/entity-ext-fields/reorder', (request) => manage(request, async (sql) => {
    const body = bodyOf(request);
    const entity = entityOf(body.entity);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length) throw new Problem(422, 'IDS', '请提供排序后的字段列表');
    const existing = await listFields(sql, entity);
    if (existing.length !== ids.length || ids.some((id) => !existing.find((row) => row.id === id))) {
      throw new Problem(422, 'IDS', '排序列表与现有字段不一致');
    }
    for (let index = 0; index < ids.length; index += 1) {
      await sql.query('UPDATE entity_ext_fields SET sort_no=$2, updated_at=now() WHERE id=$1', [ids[index], index + 1]);
    }
    return { items: (await listFields(sql, entity)).map(shapeField) };
  }));

  app.get('/api/entity-ext-fields', (request) => read(request, async (sql) => {
    const q = request.query as Record<string, string>;
    const entity = entityOf(q.entity);
    return { items: (await listFields(sql, entity)).map(shapeField) };
  }));

  app.post('/api/entity-ext-fields', async (request, reply) => reply.code(201).send(await manage(request, async (sql, actor) => {
    const body = bodyOf(request);
    const entity = entityOf(body.entity);
    const name = clean(body.name ?? body.label, 40, '字段名', true);
    const fieldType = clean(body.field_type ?? body.type, 20, '字段类型', true, 'select');
    if (!allowedTypes(entity).includes(fieldType)) throw new Problem(422, 'FIELD_TYPE', `${ENTITY_LABEL[entity]}不支持字段类型「${fieldType}」`);
    let required = body.required === true || body.required === '是' || body.required === 'yes';
    if (FIXED_OPTIONAL.has(fieldType)) required = false;
    if (!FORMULA_ENTITIES.has(entity) && fieldType === '公式') throw new Problem(422, 'FIELD_TYPE', '该实体不支持公式类型');
    const options = parseOptions(body.options ?? body, fieldType, entity);
    const maxSort = (await sql.query<{ n: number }>('SELECT coalesce(max(sort_no),0)::int AS n FROM entity_ext_fields WHERE entity=$1', [entity])).rows[0]?.n ?? 0;
    try {
      const row = (await sql.query<FieldRow>(
        `INSERT INTO entity_ext_fields(tenant_id,entity,name,field_type,required,sort_no,options)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
         RETURNING id,entity,name,field_type,required,sort_no,options,created_at,updated_at`,
        [actor.tenant_id, entity, name, fieldType, required, maxSort + 1, JSON.stringify(options)],
      )).rows[0]!;
      return { item: shapeField(row) };
    } catch (error) {
      if (String((error as { code?: string })?.code) === '23505') throw new Problem(409, 'DUPLICATE', '字段名已存在');
      throw error;
    }
  })));

  app.put('/api/entity-ext-fields/:id', (request) => manage(request, async (sql) => {
    const body = bodyOf(request);
    const current = (await sql.query<FieldRow>('SELECT id,entity,name,field_type,required,sort_no,options,created_at,updated_at FROM entity_ext_fields WHERE id=$1', [idOf(request)])).rows[0];
    if (!current) throw new Problem(404, 'NOT_FOUND', '扩展字段不存在');
    const name = body.name != null || body.label != null ? clean(body.name ?? body.label, 40, '字段名', true) : current.name;
    const fieldType = body.field_type != null || body.type != null
      ? clean(body.field_type ?? body.type, 20, '字段类型', true, 'select')
      : current.field_type;
    if (!allowedTypes(current.entity).includes(fieldType)) throw new Problem(422, 'FIELD_TYPE', '字段类型不正确');
    let required = body.required === undefined ? current.required : (body.required === true || body.required === '是' || body.required === 'yes');
    if (FIXED_OPTIONAL.has(fieldType)) required = false;
    const options = body.options != null || body.formula != null || body.autofill != null || body.choices != null || body.choices_text != null
      ? parseOptions({ ...current.options, ...body, ...(body.options && typeof body.options === 'object' ? body.options as object : {}) }, fieldType, current.entity)
      : current.options;
    try {
      const row = (await sql.query<FieldRow>(
        `UPDATE entity_ext_fields SET name=$2, field_type=$3, required=$4, options=$5::jsonb, updated_at=now()
         WHERE id=$1 RETURNING id,entity,name,field_type,required,sort_no,options,created_at,updated_at`,
        [current.id, name, fieldType, required, JSON.stringify(options)],
      )).rows[0]!;
      return { item: shapeField(row) };
    } catch (error) {
      if (String((error as { code?: string })?.code) === '23505') throw new Problem(409, 'DUPLICATE', '字段名已存在');
      throw error;
    }
  }));

  app.delete('/api/entity-ext-fields/:id', (request) => manage(request, async (sql) => {
    const row = (await sql.query('DELETE FROM entity_ext_fields WHERE id=$1 RETURNING id,entity', [idOf(request)])).rows[0] as { id: string; entity: EntityKind } | undefined;
    if (!row) throw new Problem(404, 'NOT_FOUND', '扩展字段不存在');
    return { ok: true };
  }));

  app.get('/api/entity-ext-values/batch', (request) => {
    const q = request.query as Record<string, string>;
    const entity = entityOf(q.entity);
    return valueRead(request, entity, async (sql, actor) => {
      const rows = (
        await sql.query<{ record_id: string; values: Record<string, unknown> }>(
          `SELECT record_id, values FROM entity_ext_values
           WHERE tenant_id=$1 AND entity=$2
           ORDER BY updated_at DESC
           LIMIT 5000`,
          [actor.tenant_id, entity],
        )
      ).rows;
      return {
        entity,
        items: rows.map((row) => ({ record_id: row.record_id, values: row.values ?? {} })),
      };
    });
  });

  app.get('/api/entity-ext-values', (request) => {
    const q = request.query as Record<string, string>;
    const entity = entityOf(q.entity);
    const recordId = clean(q.record_id, 80, '记录', true);
    return valueRead(request, entity, async (sql) => {
      const row = (await sql.query<{ values: Record<string, unknown> }>('SELECT values FROM entity_ext_values WHERE entity=$1 AND record_id=$2', [entity, recordId])).rows[0];
      return { entity, record_id: recordId, values: row?.values ?? {} };
    });
  });

  app.put('/api/entity-ext-values', (request) => {
    const body = bodyOf(request);
    const entity = entityOf(body.entity);
    return valueWrite(request, entity, async (sql, actor) => {
      const recordId = clean(body.record_id, 80, '记录', true);
      const fields = await listFields(sql, entity);
      let values = body.values && typeof body.values === 'object' && !Array.isArray(body.values)
        ? { ...(body.values as Record<string, unknown>) }
        : {};
      if (entity === 'work_order') {
        values = await applyAutofill(sql, fields, {
          product_id: body.product_id ? String(body.product_id) : undefined,
          contract_id: body.contract_id ? String(body.contract_id) : undefined,
          contract_line_id: body.contract_line_id ? String(body.contract_line_id) : undefined,
        }, values);
      }
      for (const field of fields) {
        if (!field.required) continue;
        const value = values[field.id];
        const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
        if (empty) throw new Problem(422, 'REQUIRED', `请填写${field.name}`, field.id);
      }
      await sql.query(
        `INSERT INTO entity_ext_values(tenant_id,entity,record_id,values,updated_at)
         VALUES($1,$2,$3,$4::jsonb,now())
         ON CONFLICT (tenant_id,entity,record_id) DO UPDATE SET values=excluded.values, updated_at=now()`,
        [actor.tenant_id, entity, recordId, JSON.stringify(values)],
      );
      return { entity, record_id: recordId, values };
    });
  });

  app.post('/api/entity-ext-fields/autofill-preview', (request) => read(request, async (sql) => {
    const body = bodyOf(request);
    const entity = entityOf(body.entity ?? 'work_order');
    if (entity !== 'work_order') return { values: {} };
    const fields = await listFields(sql, entity);
    const values = await applyAutofill(sql, fields, {
      product_id: body.product_id ? String(body.product_id) : undefined,
      contract_id: body.contract_id ? String(body.contract_id) : undefined,
      contract_line_id: body.contract_line_id ? String(body.contract_line_id) : undefined,
    }, {});
    return { values };
  }));
}
