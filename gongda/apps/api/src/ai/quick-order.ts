import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../database.js';
import { decimal, formatDecimal } from '../decimal.js';
import { Problem, writeAudit, type Actor } from '../services.js';
import { parseSpreadsheet } from './bom.js';
import { readAiConfig, type AiConfig } from './config.js';

export type QuickTarget = 'work_order' | 'sales_order';

export type OrderFieldKey =
  | 'customer_code'
  | 'customer_name'
  | 'product_code'
  | 'product_name'
  | 'quantity'
  | 'unit_price'
  | 'due_date'
  | 'promised_date'
  | 'note'
  | 'priority';

export type ColumnMapping = Partial<Record<OrderFieldKey, string>>;

export type LineRow = {
  index: number;
  cells: Record<string, string>;
  product_code: string;
  product_name: string;
  quantity: string;
  unit_price: string;
  product_id: string | null;
  product_label: string | null;
  match: 'matched' | 'unmatched' | 'ambiguous' | 'skipped';
  warning?: string;
};

export type OrderFields = {
  customer_code: string;
  customer_name: string;
  customer_id: string | null;
  product_code: string;
  product_name: string;
  product_id: string | null;
  quantity: string;
  unit_price: string;
  due_date: string;
  promised_date: string;
  note: string;
  priority: string;
};

export type QuickOrderPreview = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  filename: string;
  doc_type: string;
  columns: string[];
  mapping: ColumnMapping;
  fields: OrderFields;
  line_rows: LineRow[];
  warnings: string[];
};

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map<string, QuickOrderPreview>();

type QuotaState = { day: string; used: number };
const quotaByTenant = new Map<string, QuotaState>();

const FIELD_ALIASES: Record<OrderFieldKey, string[]> = {
  customer_code: ['客户编码', '客户编号', '客商编码', 'customer_code', 'customer_no', 'cust_code'],
  customer_name: ['客户名称', '客户', '客商', 'customer', 'customer_name', 'cust_name'],
  product_code: ['商品编码', '产品编码', '物料编码', '货号', '编码', '编号', 'code', 'sku', 'product_code', 'item_code'],
  product_name: ['商品名称', '产品名称', '物料名称', '品名', '名称', 'name', 'product_name', 'item_name'],
  quantity: ['数量', '下单数量', '计划数量', 'qty', 'quantity', 'plan_qty', '订量'],
  unit_price: ['单价', '含税单价', '售价', 'price', 'unit_price', 'sales_price'],
  due_date: ['交货日期', '交期', '完工日期', 'due_date', 'delivery_date'],
  promised_date: ['承诺交期', '约定交期', 'promised_date'],
  note: ['备注', '说明', 'note', 'remark', 'memo'],
  priority: ['优先级', '紧急度', 'priority'],
};

function shanghaiDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const v = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}

function shanghaiStamp(now = new Date()) {
  return shanghaiDay(now).replace(/-/g, '').slice(2);
}

function normalizeHeader(value: string) {
  return value.replace(/\s+/g, '').replace(/[：:]/g, '').toLowerCase();
}

export function guessOrderMapping(columns: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [OrderFieldKey, string[]][]) {
    const hit = columns.find((col) => {
      if (used.has(col)) return false;
      const norm = normalizeHeader(col);
      return aliases.some((alias) => {
        const a = normalizeHeader(alias);
        return a === norm || norm.includes(a);
      });
    });
    if (hit) {
      mapping[field] = hit;
      used.add(hit);
    }
  }
  return mapping;
}

function emptyFields(): OrderFields {
  return {
    customer_code: '',
    customer_name: '',
    customer_id: null,
    product_code: '',
    product_name: '',
    product_id: null,
    quantity: '',
    unit_price: '',
    due_date: '',
    promised_date: '',
    note: '',
    priority: 'none',
  };
}

function cellAt(columns: string[], row: string[], colName?: string) {
  if (!colName) return '';
  const i = columns.indexOf(colName);
  return i >= 0 ? (row[i] ?? '').trim() : '';
}

function applyLineMapping(columns: string[], dataRows: string[][], mapping: ColumnMapping): Omit<LineRow, 'product_id' | 'product_label' | 'match' | 'warning'>[] {
  return dataRows.map((row, index) => {
    const cells: Record<string, string> = {};
    columns.forEach((col, i) => {
      cells[col] = row[i] ?? '';
    });
    return {
      index: index + 1,
      cells,
      product_code: cellAt(columns, row, mapping.product_code),
      product_name: cellAt(columns, row, mapping.product_name),
      quantity: cellAt(columns, row, mapping.quantity) || '1',
      unit_price: cellAt(columns, row, mapping.unit_price) || '0',
    };
  });
}

async function matchProducts(sql: Sql, rows: ReturnType<typeof applyLineMapping>): Promise<LineRow[]> {
  const codes = [...new Set(rows.map((r) => r.product_code).filter(Boolean))];
  const byCode = new Map<string, { id: string; name: string; count: number }>();
  if (codes.length) {
    const found = (
      await sql.query<{ id: string; code: string; name: string; n: string }>(
        `SELECT id, code, name, count(*) OVER (PARTITION BY code)::text AS n
         FROM products
         WHERE active AND code = ANY($1::text[])`,
        [codes],
      )
    ).rows;
    for (const row of found) {
      if (!byCode.has(row.code)) byCode.set(row.code, { id: row.id, name: row.name, count: Number(row.n) });
    }
  }
  return rows.map((row) => {
    if (!row.product_code && !row.product_name) {
      return { ...row, product_id: null, product_label: null, match: 'skipped' as const, warning: '空行已跳过' };
    }
    if (!row.product_code) {
      return { ...row, product_id: null, product_label: null, match: 'unmatched' as const, warning: '缺少商品编码，请手录或改映射' };
    }
    const hit = byCode.get(row.product_code);
    if (!hit) {
      return { ...row, product_id: null, product_label: null, match: 'unmatched' as const, warning: `未找到商品 ${row.product_code}` };
    }
    if (hit.count > 1) {
      return { ...row, product_id: null, product_label: hit.name, match: 'ambiguous' as const, warning: `编码 ${row.product_code} 匹配到多个商品` };
    }
    return { ...row, product_id: hit.id, product_label: hit.name, match: 'matched' as const };
  });
}

async function matchCustomer(
  sql: Sql,
  fields: OrderFields,
): Promise<OrderFields> {
  if (fields.customer_id) return fields;
  if (fields.customer_code) {
    const rows = (
      await sql.query<{ id: string; name: string; n: string }>(
        `SELECT id, name, count(*) OVER (PARTITION BY code)::text AS n
         FROM customers WHERE active AND code=$1`,
        [fields.customer_code],
      )
    ).rows;
    if (rows.length === 1 && Number(rows[0]!.n) === 1) {
      return { ...fields, customer_id: rows[0]!.id, customer_name: fields.customer_name || rows[0]!.name };
    }
  }
  if (fields.customer_name) {
    const rows = (
      await sql.query<{ id: string; code: string }>(
        `SELECT id, code FROM customers WHERE active AND name=$1 LIMIT 3`,
        [fields.customer_name],
      )
    ).rows;
    if (rows.length === 1) {
      return { ...fields, customer_id: rows[0]!.id, customer_code: fields.customer_code || rows[0]!.code };
    }
  }
  return fields;
}

function purgeExpired() {
  const now = Date.now();
  for (const [id, preview] of previews) {
    if (now - preview.created_at > PREVIEW_TTL_MS) previews.delete(id);
  }
}

export function peekQuickPreview(previewId: string, tenantId: string): QuickOrderPreview | null {
  purgeExpired();
  const preview = previews.get(previewId);
  if (!preview || preview.tenant_id !== tenantId) return null;
  return preview;
}

export function getQuickPreview(previewId: string, tenantId: string): QuickOrderPreview {
  const preview = peekQuickPreview(previewId, tenantId);
  if (!preview) {
    throw new Problem(404, 'PREVIEW_NOT_FOUND', '预览已失效或不存在，请重新上传');
  }
  return preview;
}

export function discardQuickPreview(previewId: string, tenantId: string) {
  purgeExpired();
  const preview = previews.get(previewId);
  if (!preview || preview.tenant_id !== tenantId) {
    throw new Problem(404, 'PREVIEW_NOT_FOUND', '预览已失效或不存在');
  }
  previews.delete(previewId);
  return { ok: true as const };
}

/** 测试用：清空内存预览与配额计数。 */
export function resetQuickOrderForTests() {
  previews.clear();
  quotaByTenant.clear();
}

export type QuotaInfo = {
  used: number;
  limit: number;
  remaining: number;
  day: string;
  unlimited: boolean;
};

export function readQuotaConfig(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.AI_QUOTA_QUICK_ORDER_DAILY ?? env.AI_QUOTA_DAILY ?? '50').trim();
  const limit = Math.max(0, Number.parseInt(raw, 10) || 50);
  const disabled = (env.AI_QUOTA_DISABLED ?? '').trim() === '1' || limit <= 0;
  return { limit: disabled ? 0 : limit, unlimited: disabled };
}

export function getQuota(tenantId: string, env: NodeJS.ProcessEnv = process.env): QuotaInfo {
  const { limit, unlimited } = readQuotaConfig(env);
  const day = shanghaiDay();
  const state = quotaByTenant.get(tenantId);
  const used = state && state.day === day ? state.used : 0;
  if (unlimited) {
    return { used, limit: 0, remaining: 999999, day, unlimited: true };
  }
  return { used, limit, remaining: Math.max(0, limit - used), day, unlimited: false };
}

function consumeQuota(tenantId: string, env: NodeJS.ProcessEnv = process.env): QuotaInfo {
  const info = getQuota(tenantId, env);
  if (!info.unlimited && info.remaining <= 0) {
    throw new Problem(429, 'QUOTA_EXCEEDED', `今日极速下单次数已用尽（${info.limit} 次）`);
  }
  const day = shanghaiDay();
  const prev = quotaByTenant.get(tenantId);
  const used = prev && prev.day === day ? prev.used + 1 : 1;
  quotaByTenant.set(tenantId, { day, used });
  return getQuota(tenantId, env);
}

function detectDocType(filename: string): string {
  const lower = filename.toLowerCase();
  if (/\.(xlsx|xls|csv)$/.test(lower)) return 'spreadsheet';
  if (/\.pdf$/.test(lower)) return 'pdf';
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(lower)) return 'image';
  return 'unknown';
}

function isSpreadsheet(filename: string) {
  return /\.(xlsx|xls|csv)$/i.test(filename);
}

function buildFieldsFromFirstRow(mapping: ColumnMapping, columns: string[], first?: string[]): OrderFields {
  const fields = emptyFields();
  if (!first) return fields;
  fields.customer_code = cellAt(columns, first, mapping.customer_code);
  fields.customer_name = cellAt(columns, first, mapping.customer_name);
  fields.product_code = cellAt(columns, first, mapping.product_code);
  fields.product_name = cellAt(columns, first, mapping.product_name);
  fields.quantity = cellAt(columns, first, mapping.quantity);
  fields.unit_price = cellAt(columns, first, mapping.unit_price);
  fields.due_date = cellAt(columns, first, mapping.due_date);
  fields.promised_date = cellAt(columns, first, mapping.promised_date);
  fields.note = cellAt(columns, first, mapping.note);
  const priority = cellAt(columns, first, mapping.priority);
  fields.priority = priority || 'none';
  return fields;
}

function shellPreview(
  actor: Actor,
  filename: string,
  docType: string,
  warnings: string[],
): { preview_id: string; doc_type: string; fields: OrderFields; line_rows: LineRow[]; warnings: string[]; quota: QuotaInfo } {
  const preview: QuickOrderPreview = {
    id: randomUUID(),
    tenant_id: actor.tenant_id,
    actor_id: actor.user_id,
    created_at: Date.now(),
    filename,
    doc_type: docType,
    columns: [],
    mapping: {},
    fields: emptyFields(),
    line_rows: [
      {
        index: 1,
        cells: {},
        product_code: '',
        product_name: '',
        quantity: '1',
        unit_price: '0',
        product_id: null,
        product_label: null,
        match: 'unmatched',
        warning: '请手录商品与数量',
      },
    ],
    warnings,
  };
  purgeExpired();
  previews.set(preview.id, preview);
  return {
    preview_id: preview.id,
    doc_type: docType,
    fields: preview.fields,
    line_rows: preview.line_rows,
    warnings,
    quota: getQuota(actor.tenant_id),
  };
}

export async function parseQuickOrderUpload(
  sql: Sql,
  actor: Actor,
  buffer: Buffer,
  filename: string,
  _config: AiConfig = readAiConfig(),
) {
  const docType = detectDocType(filename);
  if (!isSpreadsheet(filename)) {
    return shellPreview(actor, filename, docType, [
      '图片/PDF 暂无自动抽取，请在预览中手录或粘贴关键字段后再确认',
      '确认前不会写入加工单或销售单',
    ]);
  }

  const { columns, matrix, warnings } = parseSpreadsheet(buffer, filename);
  const mapping = guessOrderMapping(columns);
  if (!mapping.product_code && !mapping.product_name) {
    warnings.push('未能识别商品编码/名称列，请在预览中手录或改映射');
  }
  if (!mapping.quantity) warnings.push('未能识别数量列，默认数量为 1');

  const drafted = applyLineMapping(columns, matrix, mapping);
  const line_rows = await matchProducts(sql, drafted);
  let fields = buildFieldsFromFirstRow(mapping, columns, matrix[0]);
  const firstMatched = line_rows.find((r) => r.match === 'matched');
  if (firstMatched) {
    fields.product_code = fields.product_code || firstMatched.product_code;
    fields.product_name = fields.product_name || firstMatched.product_name || firstMatched.product_label || '';
    fields.product_id = firstMatched.product_id;
    fields.quantity = fields.quantity || firstMatched.quantity;
    fields.unit_price = fields.unit_price || firstMatched.unit_price;
  }
  fields = await matchCustomer(sql, fields);
  if ((fields.customer_code || fields.customer_name) && !fields.customer_id) {
    warnings.push('未能匹配客户，生成销售单前请手选客户');
  }
  const unmatched = line_rows.filter((r) => r.match === 'unmatched' || r.match === 'ambiguous').length;
  if (unmatched) warnings.push(`${unmatched} 行未能精确匹配商品，确认前请核对`);

  const preview: QuickOrderPreview = {
    id: randomUUID(),
    tenant_id: actor.tenant_id,
    actor_id: actor.user_id,
    created_at: Date.now(),
    filename,
    doc_type: docType,
    columns,
    mapping,
    fields,
    line_rows,
    warnings,
  };
  purgeExpired();
  previews.set(preview.id, preview);
  return {
    preview_id: preview.id,
    doc_type: docType,
    fields,
    line_rows,
    warnings,
    mapping,
    columns,
    quota: getQuota(actor.tenant_id),
  };
}

function lineMoney(quantity: bigint, price: bigint) {
  const rounded = (quantity * price + 5_000_000_000n) / 10_000_000_000n;
  return `${rounded / 100n}.${(rounded % 100n).toString().padStart(2, '0')}`;
}

async function nextDocCode(sql: Sql, tenantId: string, docType: string, prefix: string) {
  await sql.query(
    'INSERT INTO document_counters(tenant_id,doc_type,next_value) VALUES($1,$2,1) ON CONFLICT(tenant_id,doc_type) DO NOTHING',
    [tenantId, docType],
  );
  const row = (await sql.query<{ n: string }>('SELECT next_value::text AS n FROM document_counters WHERE doc_type=$1 FOR UPDATE', [docType])).rows[0];
  if (!row) throw new Problem(500, 'NUMBER_FAILED', '单据编号未能生成');
  const sequence = BigInt(row.n);
  await sql.query('UPDATE document_counters SET next_value=$1 WHERE doc_type=$2', [(sequence + 1n).toString(), docType]);
  return prefix + sequence.toString().padStart(6, '0');
}

async function nextDirectWorkOrderCode(sql: Sql, tenantId: string) {
  const stamp = shanghaiStamp();
  const prefix = 'JG' + stamp + '-';
  await sql.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, 'work-order-direct:' + stamp]);
  const rows = (await sql.query<{ code: string }>('SELECT code FROM work_orders WHERE code LIKE $1', [prefix + '%'])).rows;
  const pattern = new RegExp('^' + prefix.replace(/-/g, '\\-') + '(\\d+)$');
  let max = 0;
  for (const row of rows) {
    const match = pattern.exec(row.code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = max + 1;
  const code = prefix + String(next);
  if (!Number.isSafeInteger(next) || code.length > 64) throw new Problem(422, 'NUMBER_EXHAUSTED', '本日加工单号已用完');
  return code;
}

async function activeProduct(sql: Sql, id: string) {
  const row = (
    await sql.query<{ id: string; code: string; name: string; unit_id: string; unit_name: string; attribute: string }>(
      `SELECT p.id,p.code,p.name,p.unit_id,u.name AS unit_name,p.attribute
       FROM products p JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
       WHERE p.id=$1 AND p.active AND u.active`,
      [id],
    )
  ).rows[0];
  if (!row) throw new Problem(422, 'INVALID_REFERENCE', '产品不存在、已停用或不属于当前企业');
  return row;
}

function applyOverrides(preview: QuickOrderPreview, overrides: Record<string, unknown> | undefined) {
  if (!overrides || typeof overrides !== 'object') return;
  const fields = { ...preview.fields };
  for (const key of [
    'customer_code',
    'customer_name',
    'customer_id',
    'product_code',
    'product_name',
    'product_id',
    'quantity',
    'unit_price',
    'due_date',
    'promised_date',
    'note',
    'priority',
  ] as const) {
    if (key in overrides) {
      const raw = overrides[key];
      if (key === 'customer_id' || key === 'product_id') {
        fields[key] = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
      } else if (typeof raw === 'string') {
        fields[key] = raw.trim();
      }
    }
  }
  preview.fields = fields;

  if (Array.isArray(overrides.line_rows)) {
    const edits = overrides.line_rows as Partial<LineRow>[];
    preview.line_rows = preview.line_rows.map((row) => {
      const edit = edits.find((e) => e.index === row.index) ?? edits[row.index - 1];
      if (!edit || typeof edit !== 'object') return row;
      return {
        ...row,
        product_code: typeof edit.product_code === 'string' ? edit.product_code.trim() : row.product_code,
        product_name: typeof edit.product_name === 'string' ? edit.product_name.trim() : row.product_name,
        quantity: typeof edit.quantity === 'string' ? edit.quantity.trim() || '1' : row.quantity,
        unit_price: typeof edit.unit_price === 'string' ? edit.unit_price.trim() || '0' : row.unit_price,
        product_id: typeof edit.product_id === 'string' && edit.product_id.trim() ? edit.product_id.trim() : row.product_id,
        match: typeof edit.product_id === 'string' && edit.product_id.trim() ? ('matched' as const) : row.match,
        warning: typeof edit.product_id === 'string' && edit.product_id.trim() ? undefined : row.warning,
      };
    });
  }
}

async function createSalesOrderFromPreview(
  sql: Sql,
  actor: Actor,
  preview: QuickOrderPreview,
  overrides: Record<string, unknown> | undefined,
) {
  const customerId =
    (typeof overrides?.customer_id === 'string' && overrides.customer_id.trim()) ||
    preview.fields.customer_id;
  if (!customerId) throw new Problem(422, 'CUSTOMER_REQUIRED', '生成销售单请先选择客户');
  if (!(await sql.query('SELECT id FROM customers WHERE id=$1 AND active', [customerId])).rows[0]) {
    throw new Problem(422, 'INVALID_REFERENCE', '客户不存在、已停用或不属于当前企业');
  }

  const lines: { product_id: string; quantity: string; unit_price: string }[] = [];
  for (const row of preview.line_rows) {
    if (row.match === 'skipped') continue;
    if (!row.product_id) continue;
    try {
      decimal(row.quantity, { positive: true, label: '数量' });
    } catch {
      continue;
    }
    const price = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(row.unit_price) ? row.unit_price : '0';
    lines.push({ product_id: row.product_id, quantity: row.quantity, unit_price: price });
  }
  if (!lines.length && preview.fields.product_id && preview.fields.quantity) {
    lines.push({
      product_id: preview.fields.product_id,
      quantity: preview.fields.quantity,
      unit_price: preview.fields.unit_price || '0',
    });
  }
  if (!lines.length) throw new Problem(422, 'NO_VALID_ROWS', '没有可写入的有效商品行，请核对预览');

  const ids = lines.map((l) => l.product_id);
  if (new Set(ids).size !== ids.length) {
    throw new Problem(422, 'DUPLICATE_LINE', '同一销售订单暂不重复同一产品');
  }

  const note = (preview.fields.note || `AI极速下单自 ${preview.filename}`).slice(0, 2000);
  const promised = preview.fields.promised_date || preview.fields.due_date || null;
  const code = await nextDocCode(sql, actor.tenant_id, 'SO', 'SO');
  const id = (
    await sql.query<{ id: string }>(
      'INSERT INTO sales_orders(tenant_id,code,customer_id,note,promised_date,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [actor.tenant_id, code, customerId, note, promised || null, actor.user_id],
    )
  ).rows[0]!.id;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const product = await activeProduct(sql, line.product_id);
    const quantity = decimal(line.quantity, { positive: true });
    const price = decimal(line.unit_price);
    await sql.query(
      'INSERT INTO sales_order_lines(tenant_id,order_id,line_no,product_id,unit_id,quantity,unit_price,extended_amount,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [
        actor.tenant_id,
        id,
        index + 1,
        product.id,
        product.unit_id,
        formatDecimal(quantity),
        formatDecimal(price),
        lineMoney(quantity, price),
        JSON.stringify(product),
      ],
    );
  }

  await writeAudit(sql, actor, 'sales_order.created', 'sales_order', id, null, {
    id,
    source: 'ai_quick_order',
    preview_id: preview.id,
  });
  return { target: 'sales_order' as const, id, code, lines_count: lines.length };
}

async function createWorkOrderFromPreview(
  sql: Sql,
  actor: Actor,
  preview: QuickOrderPreview,
  overrides: Record<string, unknown> | undefined,
) {
  const firstLine = preview.line_rows.find((r) => r.match === 'matched' && r.product_id) ?? preview.line_rows.find((r) => r.product_id);
  const productId =
    (typeof overrides?.product_id === 'string' && overrides.product_id.trim()) ||
    preview.fields.product_id ||
    firstLine?.product_id;
  if (!productId) throw new Problem(422, 'PRODUCT_REQUIRED', '生成加工单请先匹配或选择商品');

  const qtyRaw =
    (typeof overrides?.quantity === 'string' && overrides.quantity.trim()) ||
    preview.fields.quantity ||
    firstLine?.quantity ||
    '1';
  const quantity = decimal(qtyRaw, { positive: true });

  const warehouseId =
    (typeof overrides?.warehouse_id === 'string' && overrides.warehouse_id.trim()) ||
    (await sql.query<{ id: string }>('SELECT id FROM warehouses WHERE active ORDER BY created_at LIMIT 1')).rows[0]?.id;
  if (!warehouseId) throw new Problem(422, 'WAREHOUSE', '请先维护仓库');
  if (!(await sql.query('SELECT id FROM warehouses WHERE id=$1 AND active', [warehouseId])).rows[0]) {
    throw new Problem(422, 'INVALID_REFERENCE', '仓库不存在或已停用');
  }

  const processId =
    (typeof overrides?.process_id === 'string' && overrides.process_id.trim()) ||
    (
      await sql.query<{ id: string }>(
        'SELECT id FROM processes WHERE active ORDER BY created_at LIMIT 1',
      )
    ).rows[0]?.id;
  if (!processId) throw new Problem(422, 'PROCESS_REQUIRED', '请先维护至少一道工序，或在确认时指定 process_id');

  const proc = (
    await sql.query<{
      id: string;
      code: string;
      name: string;
      standard_minutes: string;
      pricing_mode: string;
      wage_rate: string | null;
      inspection_scheme: string;
      active: boolean;
      need_outsource: boolean;
      reporter_ids: string[];
    }>(
      `SELECT p.id,p.code,p.name,p.standard_minutes::text,p.pricing_mode,p.wage_rate::text,p.inspection_scheme,p.active,
              COALESCE(p.need_outsource,false) AS need_outsource,
              COALESCE((SELECT jsonb_agg(r.user_id ORDER BY r.user_id) FROM process_reporters r WHERE r.process_id=p.id),'[]'::jsonb) AS reporter_ids
       FROM processes p WHERE p.id=$1`,
      [processId],
    )
  ).rows[0];
  if (!proc?.active) throw new Problem(422, 'INACTIVE_REFERENCE', '工序不存在、已停用或不属于当前企业');

  const product = await activeProduct(sql, productId);
  const dueDate = preview.fields.due_date || null;
  const note = (preview.fields.note || `AI极速下单自 ${preview.filename}`).slice(0, 255);
  const priorityRaw = preview.fields.priority || 'none';
  const priority = ['none', 'urgent', 'normal', 'delayed'].includes(priorityRaw) ? priorityRaw : 'none';

  let id = '';
  let code = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    code = await nextDirectWorkOrderCode(sql, actor.tenant_id);
    await sql.query('SAVEPOINT ai_wo_code');
    try {
      id = (
        await sql.query<{ id: string }>(
          `INSERT INTO work_orders(
             tenant_id,code,product_id,unit_id,plan_qty,sales_order_id,sales_line_id,contract_id,contract_line_id,
             route_version_id,bom_version_id,warehouse_id,product_snapshot,route_name_snapshot,bom_revision,
             requires_fg_inspection,created_by,priority,due_date,planned_start,planned_end,note,production_plan_line_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
          [
            actor.tenant_id,
            code,
            product.id,
            product.unit_id,
            formatDecimal(quantity),
            null,
            null,
            null,
            null,
            null,
            null,
            warehouseId,
            JSON.stringify(product),
            '',
            null,
            false,
            actor.user_id,
            priority,
            dueDate,
            null,
            null,
            note,
            null,
          ],
        )
      ).rows[0]!.id;
      await sql.query('RELEASE SAVEPOINT ai_wo_code');
      break;
    } catch (error) {
      await sql.query('ROLLBACK TO SAVEPOINT ai_wo_code');
      const unique = typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
      if (!unique || attempt === 7) throw error;
    }
  }

  const taskKind = proc.need_outsource ? 'outsource' : 'production';
  await sql.query(
    `INSERT INTO work_order_tasks(
       tenant_id,work_order_id,sequence,route_step_id,process_id,process_snapshot,unit_ratio,plan_qty,is_output,
       pricing_mode,wage_rate,inspection_scheme,task_kind
     ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
    [
      actor.tenant_id,
      id,
      1,
      null,
      proc.id,
      JSON.stringify({
        code: proc.code,
        name: proc.name,
        standard_minutes: proc.standard_minutes,
        reporter_ids: proc.reporter_ids,
        auto_inbound: false,
      }),
      formatDecimal(decimal('1')),
      formatDecimal(quantity),
      true,
      proc.pricing_mode,
      proc.wage_rate,
      proc.inspection_scheme,
      taskKind,
    ],
  );

  await writeAudit(sql, actor, 'work_order.created', 'work_order', id, null, {
    id,
    source: 'ai_quick_order',
    preview_id: preview.id,
    plan_qty: formatDecimal(quantity),
  });
  return { target: 'work_order' as const, id, code, lines_count: 1 };
}

export async function confirmQuickOrder(
  sql: Sql,
  actor: Actor,
  body: {
    preview_id?: unknown;
    target?: unknown;
    overrides?: unknown;
  },
) {
  if (actor.role !== 'admin' && actor.role !== 'planner') {
    throw new Problem(403, 'FORBIDDEN', '当前角色不能极速下单写入单据');
  }
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const target: QuickTarget = body.target === 'sales_order' ? 'sales_order' : 'work_order';
  const preview = getQuickPreview(previewId, actor.tenant_id);
  const overrides =
    body.overrides && typeof body.overrides === 'object' ? (body.overrides as Record<string, unknown>) : undefined;
  applyOverrides(preview, overrides);

  // re-match customer if still missing
  preview.fields = await matchCustomer(sql, preview.fields);

  const created =
    target === 'sales_order'
      ? await createSalesOrderFromPreview(sql, actor, preview, overrides)
      : await createWorkOrderFromPreview(sql, actor, preview, overrides);

  const quota = consumeQuota(actor.tenant_id);

  await sql.query(
    `INSERT INTO ai_action_log(tenant_id, actor_id, actor_name, action, question_summary, intent, meta)
     VALUES ($1,$2,$3,'quick_order_confirm',$4,$5,$6::jsonb)`,
    [
      actor.tenant_id,
      actor.user_id,
      actor.display_name,
      `极速下单 ${preview.filename} → ${created.target} ${created.id}`.slice(0, 200),
      'quick_order',
      JSON.stringify({
        preview_id: preview.id,
        target: created.target,
        document_id: created.id,
        document_code: created.code,
        lines_count: created.lines_count,
        filename: preview.filename,
        quota_used: quota.used,
      }),
    ],
  );

  previews.delete(preview.id);
  return {
    ...created,
    document_id: created.id,
    document_code: created.code,
    quota,
  };
}

export function digestPayload(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
