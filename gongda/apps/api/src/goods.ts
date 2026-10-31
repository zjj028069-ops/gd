import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { gateTenantWrite } from './assets.js';
import { attachProductFields, saveProductFields, type ProductExtensionInput } from './configuration.js';
import { allocateByRule, parseConfig, renderCode, ruleFormula, storedConfig, type Element, type RuleConfig } from './code-rules.js';
import { Problem, assertProductScope, productScope, writeAudit, type Actor, type Services } from './services.js';

const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { anyOf: [uuid, { type: 'null' }] };
const priceText = { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 32 }] };
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };

type Settings = { duplicate_name_check: boolean; auto_fill_code: boolean; qr_login_required: boolean };
type GoodsBody = {
  code?: string;
  name?: string;
  specification?: string;
  unit_id?: string | null;
  attribute?: string | null;
  source?: string | null;
  active?: boolean;
  version?: number;
  department_id?: string | null;
  category_id?: string | null;
  sale_price?: string | null;
  cost_price?: string | null;
  outsource_price?: string | null;
  commission_amount?: string | null;
  commission_rate?: string | null;
  inspection_spec_id?: string | null;
  default_supplier_id?: string | null;
  stale_days?: string | null;
  stock_upper_warn?: string | null;
  stock_lower_warn?: string | null;
  remark?: string;
  intro_html?: string;
  images?: string[];
  attachments?: string[];
  extension?: ProductExtensionInput;
};

const sourceOfAttribute: Record<string, string> = { manufactured: '自产', purchased: '外购', outsourced: '外协加工' };
const attributeOfSource: Record<string, string> = { 自产: 'manufactured', 外购: 'purchased', 外协加工: 'outsourced' };

const productSelect = `SELECT p.created_by_id,p.department_id,p.id,p.code,p.name,p.specification,p.unit_id,u.name AS unit_name,p.attribute,p.source,p.active,p.version,p.created_at,p.updated_at,
 p.category_id,c.name AS category_name,p.sale_price::text AS sale_price,p.cost_price::text AS cost_price,p.outsource_price::text AS outsource_price,
 p.commission_amount::text AS commission_amount,p.commission_rate::text AS commission_rate,p.inspection_spec_id,i.name AS inspection_spec_name,
 p.default_supplier_id,s.name AS supplier_name,p.stale_days::text AS stale_days,p.stock_upper_warn::text AS stock_upper_warn,p.stock_lower_warn::text AS stock_lower_warn,
 p.remark,p.intro_html,p.images,p.attachments,m.display_name AS creator_name,
 EXISTS(SELECT 1 FROM bom_definitions b JOIN bom_versions v ON v.tenant_id=b.tenant_id AND v.id=b.current_version_id WHERE b.tenant_id=p.tenant_id AND b.parent_product_id=p.id AND v.route_version_id IS NOT NULL) AS has_route
 FROM products p
 LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
 LEFT JOIN product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
 LEFT JOIN inspection_specs i ON i.tenant_id=p.tenant_id AND i.id=p.inspection_spec_id
 LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.default_supplier_id
 LEFT JOIN tenant_team_members m ON m.id=p.created_by_id`;

function trimNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}
function asIds(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
  }
  return [];
}
function presentProduct<T extends Record<string, unknown>>(row: T) {
  const numeric = ['sale_price', 'cost_price', 'outsource_price', 'commission_amount', 'commission_rate', 'stale_days', 'stock_upper_warn', 'stock_lower_warn'] as const;
  const next: Record<string, unknown> = { ...row, images: asIds(row.images), attachments: asIds(row.attachments) };
  for (const key of numeric) next[key] = trimNumber(row[key]);
  return next;
}
function requireName(name: unknown) {
  const text = String(name ?? '').trim();
  if (!text) throw new Problem(422, 'NAME_REQUIRED', '请填写商品名');
  if (text.length > 200) throw new Problem(422, 'NAME_LENGTH', '商品名不能超过200字');
  return text;
}
function cleanCode(code: unknown) {
  const text = String(code ?? '').trim();
  if (text.length > 64) throw new Problem(422, 'CODE_LENGTH', '商品编号不能超过64字');
  return text;
}
function money(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,10})?$/.test(text)) throw new Problem(422, 'INVALID_NUMBER', `${label}格式不正确`);
  return text;
}
function sanitizeHtml(html: string) {
  return html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '').replace(/javascript:/gi, '');
}
function resolveOrigin(body: GoodsBody, previous?: { source: string | null; attribute: string | null }) {
  const hasSource = Object.prototype.hasOwnProperty.call(body, 'source');
  const hasAttribute = Object.prototype.hasOwnProperty.call(body, 'attribute');
  let source = hasSource ? (body.source || null) : previous?.source ?? null;
  let attribute = hasAttribute ? (body.attribute || null) : previous?.attribute ?? null;
  if (hasSource) {
    if (source && !attributeOfSource[source]) throw new Problem(422, 'INVALID_SOURCE', '商品来源不正确');
    attribute = source ? attributeOfSource[source]! : null;
  } else if (hasAttribute) {
    if (attribute && !sourceOfAttribute[attribute]) throw new Problem(422, 'INVALID_SOURCE', '商品来源不正确');
    source = attribute ? sourceOfAttribute[attribute]! : null;
  }
  return { source, attribute };
}
function defaultRule(prefix: string): RuleConfig {
  return {
    elements: [
      { type: 'fixed', text: prefix, separator: '' },
      { type: 'date', date_format: 'ymd', short_year: false, separator: '' },
      { type: 'empty', separator: '' },
      { type: 'empty', separator: '' },
    ],
    seq_digits: 4,
    seq_start: 1,
    show_abbrev: false,
  };
}
export { renderCode, ruleFormula, parseConfig };
async function ensureRuntime(sql: Sql, tenantId: string) {
  await sql.query('INSERT INTO goods_settings(tenant_id) VALUES($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
  for (const rule of [{ name: '商品编号', prefix: 'SP', sort: 1 }, { name: '加工单号', prefix: 'JG', sort: 2 }]) {
    await sql.query('INSERT INTO custom_code_rules(tenant_id,name,config,sort) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT (tenant_id,name) DO NOTHING', [tenantId, rule.name, JSON.stringify(defaultRule(rule.prefix)), rule.sort]);
  }
}
async function ensureCatalog(sql: Sql, tenantId: string) {
  await ensureRuntime(sql, tenantId);
  const categories = (await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM product_categories')).rows[0]!.n;
  if (categories === '0') {
    for (const kind of ['goods', 'bom']) {
      let sort = 1;
      for (const name of ['外协加工', '半成品', '包材配件', '成品', '毛坯']) {
        try {
          await sql.query('INSERT INTO product_categories(tenant_id,kind,name,sort) VALUES($1,$2,$3,$4)', [tenantId, kind, name, sort]);
        } catch (error) {
          if ((error as { code?: string }).code !== '23505') throw error;
        }
        sort += 1;
      }
    }
  }
  const units: [string, string][] = [['TAI', '台'], ['GE', '个'], ['CI', '次'], ['PCS', 'PCS'], ['KG', 'KG'], ['TAO', '套'], ['T', 'T'], ['ZHI', '支']];
  for (const [code, name] of units) {
    await sql.query(`INSERT INTO units(tenant_id,code,name,sort)
      SELECT $1,$2,$3,COALESCE((SELECT max(sort) FROM units),0)+1
      WHERE NOT EXISTS (SELECT 1 FROM units WHERE name=$3 OR code=$2)`, [tenantId, code, name]);
  }
  const views = (await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM goods_views')).rows[0]!.n;
  if (views === '0') {
    const seeded = [['成品', '成品'], ['半成品', '半成品'], ['原材料', '原材料']];
    for (let index = 0; index < seeded.length; index += 1) {
      await sql.query('INSERT INTO goods_views(tenant_id,name,category_name,sort,builtin) VALUES($1,$2,$3,$4,true)', [tenantId, seeded[index]![0], seeded[index]![1], index + 1]);
    }
  }
}
async function readSettings(sql: Sql, tenantId: string) {
  await ensureRuntime(sql, tenantId);
  return (await sql.query<Settings>('SELECT duplicate_name_check, auto_fill_code, qr_login_required FROM goods_settings FOR UPDATE')).rows[0]!;
}
async function allocateCode(sql: Sql, tenantId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = await allocateByRule(sql, tenantId, '商品编号');
    if (!code) throw new Problem(422, 'CODE_RULE_MISSING', '请先配置商品编号规则');
    const used = (await sql.query('SELECT id FROM products WHERE code=$1', [code])).rows[0];
    if (!used) return code;
  }
  throw new Problem(409, 'DUPLICATE_CODE', '商品编号已存在');
}
async function assertUnit(sql: Sql, id: string | null) {
  if (!id) return;
  if (!(await sql.query('SELECT id FROM units WHERE id=$1 AND active FOR UPDATE', [id])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '单位不存在或不属于当前企业');
}
async function assertOptional(sql: Sql, id: string | null, table: string, message: string, extra = '') {
  if (!id) return;
  if (!(await sql.query(`SELECT id FROM ${table} WHERE id=$1 ${extra}`, [id])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', message);
}
async function assertFiles(sql: Sql, productId: string | null, ids: string[] | undefined, label: string) {
  if (!ids) return [];
  if (ids.length > 30) throw new Problem(422, 'TOO_MANY_FILES', `${label}不能超过30个`);
  if (new Set(ids).size !== ids.length) throw new Problem(422, 'DUPLICATE_FILE', `${label}不能重复`);
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Problem(422, 'INVALID_FILE', `${label}不正确`);
    if (productId && !(await sql.query('SELECT id FROM attachments WHERE id=$1 AND product_id=$2 AND deleted_at IS NULL', [id, productId])).rows[0]) throw new Problem(422, 'INVALID_FILE', `${label}不存在或不属于该商品`);
  }
  if (!productId && ids.length) throw new Problem(422, 'INVALID_FILE', '请先保存商品再上传文件');
  return ids;
}
function textField(body: GoodsBody, key: 'remark', previous: string, limit: number, label: string) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return previous;
  const text = String(body[key] ?? '');
  if (text.length > limit) throw new Problem(422, 'TEXT_LENGTH', `${label}不能超过${limit}字`);
  return text;
}
async function loadProduct(sql: Sql, actor: Actor, id: string) {
  await assertProductScope(sql, actor, id);
  const row = (await sql.query<Record<string, unknown>>(productSelect + ' WHERE p.id=$1', [id])).rows[0];
  if (!row) throw new Problem(404, 'PRODUCT_NOT_FOUND', '产品不存在');
  return presentProduct(row);
}
async function writeProductAudit(sql: Sql, actor: Actor, action: string, id: string, before: unknown, after: unknown) {
  const summary = (value: unknown) => {
    if (!value || typeof value !== 'object') return value;
    const row = value as Record<string, unknown>;
    const extension = row.extension as Record<string, unknown> | null | undefined;
    return { ...row, extension: extension ? { schema_version_id: extension.schema_version_id, revision: extension.revision } : null };
  };
  await sql.query('INSERT INTO audit_events(tenant_id,actor_id,actor_name,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)', [actor.tenant_id, actor.user_id, actor.display_name, action, 'product', id, before ? JSON.stringify(summary(before)) : null, after ? JSON.stringify(summary(after)) : null]);
}
function duplicateCode(error: unknown): never {
  const known = error as { code?: string; constraint?: string };
  if (known.code === '23505' && String(known.constraint ?? '').includes('code')) throw new Problem(409, 'DUPLICATE_CODE', '商品编号已存在');
  if (known.code === '23503') throw new Problem(409, 'PRODUCT_IN_USE', '商品已被引用，不能删除');
  throw error;
}
const productProperties = {
  code: { type: 'string', maxLength: 64 },
  name: { type: 'string', maxLength: 200 },
  specification: { type: 'string', maxLength: 500 },
  unit_id: nullableUuid,
  attribute: { anyOf: [{ type: 'string', enum: ['manufactured', 'purchased', 'outsourced'] }, { type: 'null' }] },
  source: { anyOf: [{ type: 'string', enum: ['自产', '外协加工', '外购'] }, { type: 'null' }] },
  active: { type: 'boolean' },
  department_id: nullableUuid,
  category_id: nullableUuid,
  sale_price: priceText,
  cost_price: priceText,
  outsource_price: priceText,
  commission_amount: priceText,
  commission_rate: priceText,
  inspection_spec_id: nullableUuid,
  default_supplier_id: nullableUuid,
  stale_days: priceText,
  stock_upper_warn: priceText,
  stock_lower_warn: priceText,
  remark: { type: 'string', maxLength: 255 },
  intro_html: { type: 'string', maxLength: 50000 },
  images: { type: 'array', maxItems: 30, items: uuid },
  attachments: { type: 'array', maxItems: 30, items: uuid },
  extension: { type: 'object', additionalProperties: false, required: ['schema_version_id', 'values'], properties: { schema_version_id: uuid, values: { type: 'object', maxProperties: 30 } } },
};

export function registerGoods(app: FastifyInstance, services: Services) {
  const { database, authorize, requirePermission, context, actor } = services;
  const write = authorize(['admin', 'planner']);
  const read = authorize();

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/products', {
    preHandler: read,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      q: { type: 'string', maxLength: 100 }, page: { type: 'string', pattern: '^[1-9]\\d{0,5}$' }, page_size: { type: 'string', pattern: '^[1-9]\\d{0,2}$' },
      name: { type: 'string', maxLength: 100 }, code: { type: 'string', maxLength: 64 }, specification: { type: 'string', maxLength: 100 },
      inspection: { type: 'string', maxLength: 100 }, category_id: uuid, source: { type: 'string', maxLength: 20 }, supplier: { type: 'string', maxLength: 100 },
      creator: { type: 'string', maxLength: 100 }, created_from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, created_to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      commission_min: { type: 'string', maxLength: 32 }, commission_max: { type: 'string', maxLength: 32 }, active: { type: 'string', maxLength: 10 }, view_id: uuid,
    } } },
  }, async (request) => database.tenant(context(request), async (sql) => {
    const query = request.query;
    const page = Number(query.page ?? '1');
    const pageSize = Number(query.page_size ?? '20');
    if (page > 100000 || pageSize > 100) throw new Problem(400, 'PAGINATION_RANGE', '分页参数超出允许范围');
    const params: unknown[] = [];
    const clauses: string[] = [];
    const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const q = query.q ?? '';
    const qRef = bind(q);
    clauses.push(`(${qRef}='' OR position(lower(${qRef}) in lower(p.code||' '||p.name))>0)`);
    if (query.name) clauses.push(`position(lower(${bind(query.name)}) in lower(p.name))>0`);
    if (query.code) clauses.push(`position(lower(${bind(query.code)}) in lower(p.code))>0`);
    if (query.specification) clauses.push(`position(lower(${bind(query.specification)}) in lower(p.specification))>0`);
    if (query.inspection) clauses.push(`position(lower(${bind(query.inspection)}) in lower(coalesce(i.name,'')))>0`);
    if (query.source) clauses.push(`p.source=${bind(query.source)}`);
    if (query.supplier) clauses.push(`position(lower(${bind(query.supplier)}) in lower(coalesce(s.name,'')))>0`);
    if (query.creator) clauses.push(`position(lower(${bind(query.creator)}) in lower(coalesce(m.display_name,'')))>0`);
    if (query.created_from) clauses.push(`(p.created_at AT TIME ZONE 'Asia/Shanghai')::date>=${bind(query.created_from)}::date`);
    if (query.created_to) clauses.push(`(p.created_at AT TIME ZONE 'Asia/Shanghai')::date<=${bind(query.created_to)}::date`);
    if (query.commission_min) clauses.push(`p.commission_amount>=${bind(money(query.commission_min, '售后佣金'))}::numeric`);
    if (query.commission_max) clauses.push(`p.commission_amount<=${bind(money(query.commission_max, '售后佣金'))}::numeric`);
    if (query.active === '启用') clauses.push('p.active');
    if (query.active === '禁用') clauses.push('NOT p.active');
    if (query.category_id) clauses.push(`p.category_id IN (WITH RECURSIVE tree AS (SELECT id FROM product_categories WHERE id=${bind(query.category_id)} UNION ALL SELECT c2.id FROM product_categories c2 JOIN tree t ON c2.parent_id=t.id) SELECT id FROM tree)`);
    if (query.view_id) {
      const view = (await sql.query<{ category_name: string | null }>('SELECT category_name FROM goods_views WHERE id=$1', [query.view_id])).rows[0];
      if (!view) throw new Problem(404, 'VIEW_NOT_FOUND', '视图不存在');
      if (view.category_name) clauses.push(`p.category_id IN (WITH RECURSIVE tree AS (SELECT id FROM product_categories WHERE kind='goods' AND name=${bind(view.category_name)} UNION ALL SELECT c2.id FROM product_categories c2 JOIN tree t ON c2.parent_id=t.id) SELECT id FROM tree)`);
    }
    const scope = productScope(actor(request), 'p', params.length + 1);
    clauses.push(scope.clause);
    params.push(...scope.params);
    const where = ' WHERE ' + clauses.join(' AND ');
    const total = Number((await sql.query<{ total: string }>(`SELECT count(*)::text AS total FROM products p LEFT JOIN inspection_specs i ON i.tenant_id=p.tenant_id AND i.id=p.inspection_spec_id LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.default_supplier_id LEFT JOIN tenant_team_members m ON m.id=p.created_by_id${where}`, params)).rows[0]!.total);
    const limit = bind(pageSize);
    const offset = bind((page - 1) * pageSize);
    const items = (await sql.query<Record<string, unknown>>(productSelect + where + ` ORDER BY p.created_at DESC,p.id LIMIT ${limit} OFFSET ${offset}`, params)).rows.map(presentProduct);
    return { items: await attachProductFields(sql, items as { id: string }[], actor(request)), total };
  }));

  app.get('/api/products/settings', { preHandler: read }, async (request) => database.tenant(context(request), async (sql) => ({ settings: await readSettings(sql, actor(request).tenant_id) })));
  app.put<{ Body: Settings }>('/api/products/settings', { preHandler: write, schema: { body: { type: 'object', additionalProperties: false, required: ['duplicate_name_check', 'auto_fill_code', 'qr_login_required'], properties: { duplicate_name_check: { type: 'boolean' }, auto_fill_code: { type: 'boolean' }, qr_login_required: { type: 'boolean' } } } } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    await ensureRuntime(sql, actor(request).tenant_id);
    const body = request.body;
    await sql.query('UPDATE goods_settings SET duplicate_name_check=$1, auto_fill_code=$2, qr_login_required=$3', [body.duplicate_name_check, body.auto_fill_code, body.qr_login_required]);
    return { settings: body };
  }));
  app.post('/api/products/catalog-defaults', { preHandler: write }, async (request) => database.tenant(context(request), async (sql) => {
    await ensureCatalog(sql, actor(request).tenant_id);
    return { ok: true };
  }));

  app.get<{ Querystring: { kind?: string } }>('/api/products/categories', { preHandler: read, schema: { querystring: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['goods', 'bom'] } } } } }, async (request) => database.tenant(context(request), async (sql) => ({ items: (await sql.query('SELECT id,parent_id,kind,name,sort FROM product_categories WHERE kind=$1 ORDER BY sort,name', [request.query.kind ?? 'goods'])).rows })));
  app.post<{ Body: { kind?: string; name: string; parent_id?: string | null } }>('/api/products/categories', { preHandler: write, schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { kind: { type: 'string', enum: ['goods', 'bom'] }, name: { type: 'string', minLength: 1, maxLength: 100 }, parent_id: nullableUuid } } } }, async (request, reply) => {
    const row = await database.tenant(context(request), async (sql) => {
      await gateTenantWrite(sql, context(request));
      const kind = request.body.kind ?? 'goods';
      const name = request.body.name.trim();
      if (!name) throw new Problem(422, 'NAME_REQUIRED', '请填写类别名称');
      if (request.body.parent_id && !(await sql.query('SELECT id FROM product_categories WHERE id=$1 AND kind=$2', [request.body.parent_id, kind])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '上级类别不存在');
      const sort = Number((await sql.query<{ n: string }>('SELECT COALESCE(max(sort),0)+1 AS n FROM product_categories WHERE kind=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid', [kind, request.body.parent_id ?? null])).rows[0]!.n);
      try {
        return (await sql.query('INSERT INTO product_categories(tenant_id,parent_id,kind,name,sort) VALUES($1,$2,$3,$4,$5) RETURNING id,parent_id,kind,name,sort', [actor(request).tenant_id, request.body.parent_id ?? null, kind, name, sort])).rows[0];
      } catch (error) {
        const known = error as { code?: string };
        if (known.code === '23505') throw new Problem(409, 'DUPLICATE_CATEGORY', '同级类别名称已存在');
        throw error;
      }
    });
    return reply.code(201).send({ category: row });
  });
  app.patch<{ Params: { id: string }; Body: { name: string } }>('/api/products/categories/:id', { preHandler: write, schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    const name = request.body.name.trim();
    if (!name) throw new Problem(422, 'NAME_REQUIRED', '请填写类别名称');
    try {
      const updated = await sql.query('UPDATE product_categories SET name=$1 WHERE id=$2 RETURNING id,parent_id,kind,name,sort', [name, request.params.id]);
      if (!updated.rows[0]) throw new Problem(404, 'CATEGORY_NOT_FOUND', '类别不存在');
      return { category: updated.rows[0] };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new Problem(409, 'DUPLICATE_CATEGORY', '同级类别名称已存在');
      throw error;
    }
  }));
  app.delete<{ Params: { id: string } }>('/api/products/categories/:id', { preHandler: write, schema: { params: idParams } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    if ((await sql.query('SELECT id FROM product_categories WHERE parent_id=$1 LIMIT 1', [request.params.id])).rows[0]) throw new Problem(409, 'CATEGORY_IN_USE', '请先删除下级类别');
    if ((await sql.query('SELECT id FROM products WHERE category_id=$1 LIMIT 1', [request.params.id])).rows[0]) throw new Problem(409, 'CATEGORY_IN_USE', '类别已被商品引用，不能删除');
    const removed = await sql.query('DELETE FROM product_categories WHERE id=$1 RETURNING id', [request.params.id]);
    if (!removed.rows[0]) throw new Problem(404, 'CATEGORY_NOT_FOUND', '类别不存在');
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: { direction: 'up' | 'down' } }>('/api/products/categories/:id/move', { preHandler: write, schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['direction'], properties: { direction: { type: 'string', enum: ['up', 'down'] } } } } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    const current = (await sql.query<{ id: string; parent_id: string | null; kind: string; sort: number }>('SELECT id,parent_id,kind,sort FROM product_categories WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0];
    if (!current) throw new Problem(404, 'CATEGORY_NOT_FOUND', '类别不存在');
    const siblings = (await sql.query<{ id: string; sort: number }>('SELECT id,sort FROM product_categories WHERE kind=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid ORDER BY sort,name FOR UPDATE', [current.kind, current.parent_id])).rows;
    const index = siblings.findIndex((item) => item.id === current.id);
    const swap = siblings[index + (request.body.direction === 'up' ? -1 : 1)];
    if (swap) {
      await sql.query('UPDATE product_categories SET sort=$1 WHERE id=$2', [swap.sort, current.id]);
      await sql.query('UPDATE product_categories SET sort=$1 WHERE id=$2', [current.sort, swap.id]);
    }
    return { ok: true };
  }));

  app.get<{ Querystring: { q?: string } }>('/api/products/inspection-specs', { preHandler: read, schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 100 } } } } }, async (request) => database.tenant(context(request), async (sql) => ({ items: (await sql.query('SELECT id,name,remark FROM inspection_specs WHERE ($1=\'\' OR position(lower($1) in lower(name))>0) ORDER BY name LIMIT 20', [request.query.q ?? ''])).rows })));

  app.get('/api/products/views', { preHandler: read }, async (request) => database.tenant(context(request), async (sql) => ({ items: (await sql.query('SELECT id,name,category_name,sort,builtin,version FROM goods_views ORDER BY sort,name')).rows })));
  app.post<{ Body: { name: string; category_name?: string | null } }>('/api/products/views', { preHandler: write, schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, category_name: { anyOf: [{ type: 'string', maxLength: 100 }, { type: 'null' }] } } } } }, async (request, reply) => {
    const view = await database.tenant(context(request), async (sql) => {
      await gateTenantWrite(sql, context(request));
      const name = request.body.name.trim();
      if (!name) throw new Problem(422, 'NAME_REQUIRED', '请填写视图名称');
      const sort = Number((await sql.query<{ n: string }>('SELECT COALESCE(max(sort),0)+1 AS n FROM goods_views')).rows[0]!.n);
      try { return (await sql.query('INSERT INTO goods_views(tenant_id,name,category_name,sort) VALUES($1,$2,$3,$4) RETURNING id,name,category_name,sort,builtin,version', [actor(request).tenant_id, name, request.body.category_name || null, sort])).rows[0]; }
      catch (error) { if ((error as { code?: string }).code === '23505') throw new Problem(409, 'DUPLICATE_VIEW', '视图名称已存在'); throw error; }
    });
    return reply.code(201).send({ view });
  });
  app.patch<{ Params: { id: string }; Body: { name: string; category_name?: string | null; version: number } }>('/api/products/views/:id', { preHandler: write, schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['name', 'version'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, category_name: { anyOf: [{ type: 'string', maxLength: 100 }, { type: 'null' }] }, version: { type: 'integer', minimum: 1 } } } } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    const name = request.body.name.trim();
    try {
      const updated = await sql.query('UPDATE goods_views SET name=$1, category_name=$2, version=version+1 WHERE id=$3 AND version=$4 RETURNING id,name,category_name,sort,builtin,version', [name, request.body.category_name || null, request.params.id, request.body.version]);
      if (!updated.rows[0]) throw new Problem(409, 'VERSION_CONFLICT', '视图已更新，请刷新');
      return { view: updated.rows[0] };
    } catch (error) { if ((error as { code?: string }).code === '23505') throw new Problem(409, 'DUPLICATE_VIEW', '视图名称已存在'); throw error; }
  }));
  app.delete<{ Params: { id: string } }>('/api/products/views/:id', { preHandler: write, schema: { params: idParams } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    const removed = await sql.query('DELETE FROM goods_views WHERE id=$1 RETURNING id', [request.params.id]);
    if (!removed.rows[0]) throw new Problem(404, 'VIEW_NOT_FOUND', '视图不存在');
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/products/views/:id/copy', { preHandler: write, schema: { params: idParams } }, async (request, reply) => {
    const view = await database.tenant(context(request), async (sql) => {
      await gateTenantWrite(sql, context(request));
      const source = (await sql.query<{ name: string; category_name: string | null }>('SELECT name,category_name FROM goods_views WHERE id=$1', [request.params.id])).rows[0];
      if (!source) throw new Problem(404, 'VIEW_NOT_FOUND', '视图不存在');
      const sort = Number((await sql.query<{ n: string }>('SELECT COALESCE(max(sort),0)+1 AS n FROM goods_views')).rows[0]!.n);
      let name = source.name + '-副本';
      for (let index = 2; (await sql.query('SELECT id FROM goods_views WHERE name=$1', [name])).rows[0]; index += 1) name = `${source.name}-副本${index}`;
      return (await sql.query('INSERT INTO goods_views(tenant_id,name,category_name,sort) VALUES($1,$2,$3,$4) RETURNING id,name,category_name,sort,builtin,version', [actor(request).tenant_id, name, source.category_name, sort])).rows[0];
    });
    return reply.code(201).send({ view });
  });
  app.post<{ Body: { ids: string[] } }>('/api/products/views/reorder', { preHandler: write, schema: { body: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', maxItems: 100, items: uuid } } } } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    for (let index = 0; index < request.body.ids.length; index += 1) await sql.query('UPDATE goods_views SET sort=$1 WHERE id=$2', [index + 1, request.body.ids[index]]);
    return { ok: true };
  }));

  app.get<{ Params: { id: string } }>('/api/products/:id', { preHandler: read, schema: { params: idParams } }, async (request) => database.tenant(context(request), async (sql) => {
    const product = await loadProduct(sql, actor(request), request.params.id);
    return { product: (await attachProductFields(sql, [product as { id: string }], actor(request)))[0] };
  }));

  app.post<{ Body: GoodsBody }>('/api/products', { preHandler: write, schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: productProperties } } }, async (request, reply) => {
    const product = await database.tenant(context(request), async (sql) => {
      const body = request.body;
      const session = actor(request);
      if (body.department_id !== undefined && !session.permissions.includes('organization.manage')) throw new Problem(403, 'DEPARTMENT_ASSIGNMENT_FORBIDDEN', '调整产品部门归属需要组织管理权限');
      await gateTenantWrite(sql, context(request), 'products');
      const settings = await readSettings(sql, session.tenant_id);
      const name = requireName(body.name);
      let code = cleanCode(body.code);
      if (!code) {
        if (!settings.auto_fill_code) throw new Problem(422, 'CODE_REQUIRED', '请填写商品编号');
        code = await allocateCode(sql, session.tenant_id);
      }
      if (settings.duplicate_name_check && (await sql.query('SELECT id FROM products WHERE name=$1', [name])).rows[0]) throw new Problem(409, 'DUPLICATE_NAME', '商品名已存在');
      if ((await sql.query('SELECT id FROM products WHERE code=$1', [code])).rows[0]) throw new Problem(409, 'DUPLICATE_CODE', '商品编号已存在');
      const specification = String(body.specification ?? '').trim();
      if (specification.length > 500) throw new Problem(422, 'SPEC_LENGTH', '规格不能超过500字');
      const origin = resolveOrigin(body);
      await assertUnit(sql, body.unit_id ?? null);
      await assertOptional(sql, body.category_id ?? null, 'product_categories', '类别不存在', "AND kind='goods'");
      await assertOptional(sql, body.inspection_spec_id ?? null, 'inspection_specs', '检验规范不存在');
      await assertOptional(sql, body.default_supplier_id ?? null, 'suppliers', '供应商不存在', 'AND active');
      const departmentId = body.department_id === undefined ? session.department_id : body.department_id;
      if (departmentId && !(await sql.query('SELECT id FROM departments WHERE id=$1 AND active', [departmentId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '所属部门不存在或已停用');
      const remark = textField(body, 'remark', '', 255, '备注');
      const intro = sanitizeHtml(String(body.intro_html ?? ''));
      if (intro.length > 50000) throw new Problem(422, 'TEXT_LENGTH', '商品简介过长');
      await assertFiles(sql, null, body.images, '商品图片');
      await assertFiles(sql, null, body.attachments, '附件');
      try {
        const inserted = (await sql.query<{ id: string }>(`INSERT INTO products(tenant_id,code,name,specification,unit_id,attribute,source,created_by_id,department_id,category_id,sale_price,cost_price,outsource_price,commission_amount,commission_rate,inspection_spec_id,default_supplier_id,stale_days,stock_upper_warn,stock_lower_warn,remark,intro_html)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`, [
          session.tenant_id, code, name, specification, body.unit_id ?? null, origin.attribute, origin.source, session.user_id, departmentId, body.category_id ?? null,
          money(body.sale_price, '销售单价'), money(body.cost_price, '成本单价'), money(body.outsource_price, '外协单价'), money(body.commission_amount, '售后佣金'), money(body.commission_rate, '售后佣金'),
          body.inspection_spec_id ?? null, body.default_supplier_id ?? null, money(body.stale_days, '呆滞警告值'), money(body.stock_upper_warn, '库存上限警告值'), money(body.stock_lower_warn, '库存下限警告值'), remark, intro,
        ])).rows[0]!;
        await saveProductFields(sql, session, inserted.id, body.extension);
        const after = (await attachProductFields(sql, [await loadProduct(sql, session, inserted.id) as { id: string }], session))[0];
        await writeProductAudit(sql, session, 'product.created', inserted.id, null, after);
        return after;
      } catch (error) { duplicateCode(error); }
    });
    return reply.code(201).send({ product });
  });

  app.patch<{ Params: { id: string }; Body: GoodsBody }>('/api/products/:id', {
    preHandler: write,
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['version', 'name', 'active'], properties: { ...productProperties, version: { type: 'integer', minimum: 1 } } } },
  }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    const session = actor(request);
    const before = (await attachProductFields(sql, [await loadProduct(sql, session, request.params.id) as { id: string }], session))[0] as Record<string, unknown>;
    const body = request.body;
    if (body.department_id !== undefined && !session.permissions.includes('organization.manage')) throw new Problem(403, 'DEPARTMENT_ASSIGNMENT_FORBIDDEN', '调整产品部门归属需要组织管理权限');
    const settings = await readSettings(sql, session.tenant_id);
    const name = requireName(body.name);
    if (settings.duplicate_name_check && (await sql.query('SELECT id FROM products WHERE name=$1 AND id<>$2', [name, request.params.id])).rows[0]) throw new Problem(409, 'DUPLICATE_NAME', '商品名已存在');
    const code = Object.prototype.hasOwnProperty.call(body, 'code') ? cleanCode(body.code) : String(before.code);
    if (!code) throw new Problem(422, 'CODE_REQUIRED', '请填写商品编号');
    if (code !== before.code && (await sql.query('SELECT id FROM products WHERE code=$1 AND id<>$2', [code, request.params.id])).rows[0]) throw new Problem(409, 'DUPLICATE_CODE', '商品编号已存在');
    const specification = Object.prototype.hasOwnProperty.call(body, 'specification') ? String(body.specification ?? '').trim() : String(before.specification ?? '');
    if (specification.length > 500) throw new Problem(422, 'SPEC_LENGTH', '规格不能超过500字');
    const origin = resolveOrigin(body, { source: (before.source as string | null) ?? null, attribute: (before.attribute as string | null) ?? null });
    const unitId = Object.prototype.hasOwnProperty.call(body, 'unit_id') ? body.unit_id ?? null : (before.unit_id as string | null);
    await assertUnit(sql, unitId);
    const categoryId = Object.prototype.hasOwnProperty.call(body, 'category_id') ? body.category_id ?? null : (before.category_id as string | null);
    const inspectionId = Object.prototype.hasOwnProperty.call(body, 'inspection_spec_id') ? body.inspection_spec_id ?? null : (before.inspection_spec_id as string | null);
    const supplierId = Object.prototype.hasOwnProperty.call(body, 'default_supplier_id') ? body.default_supplier_id ?? null : (before.default_supplier_id as string | null);
    await assertOptional(sql, categoryId, 'product_categories', '类别不存在', "AND kind='goods'");
    await assertOptional(sql, inspectionId, 'inspection_specs', '检验规范不存在');
    await assertOptional(sql, supplierId, 'suppliers', '供应商不存在', 'AND active');
    const departmentId = body.department_id === undefined ? before.department_id : body.department_id;
    if (departmentId && !(await sql.query('SELECT id FROM departments WHERE id=$1 AND active', [departmentId])).rows[0]) throw new Problem(422, 'INVALID_REFERENCE', '所属部门不存在或已停用');
    const remark = textField(body, 'remark', String(before.remark ?? ''), 255, '备注');
    const intro = Object.prototype.hasOwnProperty.call(body, 'intro_html') ? sanitizeHtml(String(body.intro_html ?? '')) : String(before.intro_html ?? '');
    const images = Object.prototype.hasOwnProperty.call(body, 'images') ? await assertFiles(sql, request.params.id, body.images, '商品图片') : asIds(before.images);
    const attachments = Object.prototype.hasOwnProperty.call(body, 'attachments') ? await assertFiles(sql, request.params.id, body.attachments, '附件') : asIds(before.attachments);
    const pickMoney = (key: 'sale_price' | 'cost_price' | 'outsource_price' | 'commission_amount' | 'commission_rate' | 'stale_days' | 'stock_upper_warn' | 'stock_lower_warn', label: string) => Object.prototype.hasOwnProperty.call(body, key) ? money(body[key], label) : (before[key] as string | null);
    try {
      const updated = await sql.query(`UPDATE products SET code=$1,name=$2,specification=$3,unit_id=$4,attribute=$5,source=$6,active=$7,category_id=$8,sale_price=$9,cost_price=$10,outsource_price=$11,commission_amount=$12,commission_rate=$13,inspection_spec_id=$14,default_supplier_id=$15,stale_days=$16,stock_upper_warn=$17,stock_lower_warn=$18,remark=$19,intro_html=$20,images=$21::jsonb,attachments=$22::jsonb,department_id=$23,version=version+1,updated_at=now() WHERE id=$24 AND version=$25 RETURNING id`, [
        code, name, specification, unitId, origin.attribute, origin.source, body.active, categoryId,
        pickMoney('sale_price', '销售单价'), pickMoney('cost_price', '成本单价'), pickMoney('outsource_price', '外协单价'), pickMoney('commission_amount', '售后佣金'), pickMoney('commission_rate', '售后佣金'),
        inspectionId, supplierId, pickMoney('stale_days', '呆滞警告值'), pickMoney('stock_upper_warn', '库存上限警告值'), pickMoney('stock_lower_warn', '库存下限警告值'),
        remark, intro, JSON.stringify(images), JSON.stringify(attachments), departmentId, request.params.id, body.version,
      ]);
      if (!updated.rows[0]) throw new Problem(409, 'VERSION_CONFLICT', '该资料已被其他人修改，请刷新后重试');
      await saveProductFields(sql, session, request.params.id, body.extension);
      const after = (await attachProductFields(sql, [await loadProduct(sql, session, request.params.id) as { id: string }], session))[0];
      await writeProductAudit(sql, session, 'product.updated', request.params.id, before, after);
      return { product: after };
    } catch (error) { duplicateCode(error); }
  }));

  async function removeProduct(sql: Sql, session: Actor, id: string) {
    const before = await loadProduct(sql, session, id);
    try {
      await sql.query('UPDATE attachments SET active=false, deleted_at=now(), version=version+1, updated_at=now() WHERE product_id=$1 AND deleted_at IS NULL', [id]);
      const removed = await sql.query('DELETE FROM products WHERE id=$1 RETURNING id', [id]);
      if (!removed.rows[0]) throw new Problem(404, 'PRODUCT_NOT_FOUND', '产品不存在');
      await writeProductAudit(sql, session, 'product.deleted', id, before, null);
    } catch (error) { duplicateCode(error); }
  }
  app.delete<{ Params: { id: string } }>('/api/products/:id', { preHandler: write, schema: { params: idParams } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    await removeProduct(sql, actor(request), request.params.id);
    return { ok: true };
  }));
  app.post<{ Body: { ids: string[] } }>('/api/products/batch-delete', { preHandler: write, schema: { body: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', minItems: 1, maxItems: 100, items: uuid } } } } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    for (const id of request.body.ids) await removeProduct(sql, actor(request), id);
    return { ok: true };
  }));

  app.get('/api/configuration/custom-code-rules', { preHandler: requirePermission('configuration.read') }, async (request) => database.tenant(context(request), async (sql) => {
    await ensureRuntime(sql, actor(request).tenant_id);
    const items = (await sql.query<{ id: string; name: string; config: unknown; sort: number; version: number }>('SELECT id,name,config,sort,version FROM custom_code_rules ORDER BY sort,name')).rows.map((row) => {
      const config = storedConfig(row.config);
      return { id: row.id, name: row.name, sort: row.sort, version: row.version, config, formula: ruleFormula(row.name, config), preview: renderCode(config, config.seq_start) };
    });
    return { items };
  }));
  app.patch<{ Params: { id: string }; Body: { version: number; config: RuleConfig } }>('/api/configuration/custom-code-rules/:id', { preHandler: requirePermission('configuration.manage'), schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['version', 'config'], properties: { version: { type: 'integer', minimum: 1 }, config: { type: 'object' } } } } }, async (request) => database.tenant(context(request), async (sql) => {
    await gateTenantWrite(sql, context(request));
    const existing = (await sql.query<{ config: unknown }>('SELECT config FROM custom_code_rules WHERE id=$1', [request.params.id])).rows[0];
    if (!existing) throw new Problem(404, 'NOT_FOUND', '编号规则不存在');
    const previous = storedConfig(existing.config);
    const config = parseConfig(request.body.config);
    const updated = await sql.query<{ id: string; name: string; version: number }>('UPDATE custom_code_rules SET config=$1::jsonb, version=version+1 WHERE id=$2 AND version=$3 RETURNING id,name,version', [JSON.stringify(config), request.params.id, request.body.version]);
    if (!updated.rows[0]) throw new Problem(409, 'VERSION_CONFLICT', '编号规则已更新，请刷新');
    const structure = (item: RuleConfig) => JSON.stringify({ elements: item.elements, seq_digits: item.seq_digits, seq_start: item.seq_start });
    if (structure(previous) !== structure(config)) await sql.query('DELETE FROM custom_code_counters WHERE rule_id=$1', [request.params.id]);
    const row = updated.rows[0];
    return { rule: { ...row, config, formula: ruleFormula(row.name, config), preview: renderCode(config, config.seq_start) } };
  }));
}
