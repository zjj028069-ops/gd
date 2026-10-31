import type { FastifyInstance } from 'fastify';
import { Problem, type Services } from './services.js';
import { member, text, type Row } from './r10-kit.js';

type Block = {
  id: string;
  type: 'text' | 'field' | 'table';
  text?: string;
  field?: string;
  columns?: string[];
  x: number;
  y: number;
  w: number;
  h: number;
};

type FlowRun = { text: string; field?: string; bold?: boolean; italic?: boolean; strike?: boolean; color?: string; bg?: string };
type FlowNode =
  | { id: string; type: 'paragraph'; align?: 'left' | 'center' | 'right'; runs: FlowRun[] }
  | { id: string; type: 'table'; source: '' | '出库明细' | '退货明细'; columns: string[] }
  | { id: string; type: 'image'; src: string };

type Layout = {
  paper: 'A4' | 'A5';
  margin_mm: number;
  builtin: boolean;
  blocks: Block[];
  footer_on?: boolean;
  flow?: FlowNode[];
  footer?: FlowNode[];
};

type Spec = { systemName: string; fields: string[]; extra?: string[] };

const SALES_EXTRA = [
  '联系电话', '出库数', '已收款', '已收款(大写)', '欠款', '欠款(大写)', '出库金额', '出库金额(大写)', '退货金额', '退货金额(大写)',
  '合同数量', '商品数量', '未出库数', '合同金额', '合同金额(大写)', '未开票', '未开票(大写)', '累计开票', '累计开票(大写)',
  '序号', '销售出库单号', '仓库', '合同编号', '出库日期', '发货人', '商品名', '商品编号', '商品规格', '销售单价', '销售单价(大写)',
  '销售金额', '销售金额(大写)', '数量', '单位', '备注', '商品.颜色描述', '销售退货单号', '退货日期',
  '当前时间', '当前登录人姓名', '当前企业名称', '统计周期',
];

/** 字段名对齐各对象现有 printDocs 或列表列。系统模板名称用「对象打印模板」。 */
const CATALOG: Record<string, Spec> = {
  sales_statement: { systemName: '销售对账单打印模板', fields: ['客户编号', '客户', '客户标签', '联系人', '联系人电话', '地址', '负责人'], extra: SALES_EXTRA },
  contract_quotation: { systemName: '合同报价单打印模板', fields: ['报价单号', '客户', '联系人', '联系人电话', '地址', '审核状态', '报价状态'] },
  customer_contract: { systemName: '合同订单打印模板', fields: ['合同编号', '客户', '客户编号', '联系人', '关联项目', '销售费用(元)', '审核状态'] },
  selling_expense: { systemName: '销售费用打印模板', fields: ['客户', '合同编号', '支出日期', '支出类别', '金额', '备注', '创建人'] },
  production_project: { systemName: '项目管理打印模板', fields: ['项目编号', '项目名称', '项目类别', '项目状态', '关联合同', '工单数', '计划数'] },
  production_plan: { systemName: '生产计划打印模板', fields: ['计划编号', '计划名称', '物料分析状态', '加工投产进度', '外协投产进度', '采购进度', '交货日期'] },
  work_order: { systemName: '加工单打印模板', fields: ['加工单号', '商品', '计划数', '库存', '状态', '优先级', '工序进度详情', '交货日期'] },
  wage_slip: { systemName: '工资单打印模板', fields: ['加工单号', '商品名称', '计划数', '报工人', '工序', '单价', '良品数', '不良品数', '报工数', '工资(元)', '报工时间', '报工备注'] },
  production_task: { systemName: '生产任务打印模板', fields: ['工序', '商品名', '商品编号', '商品规格', '加工单', '任务类型', '工序编号'] },
  work_report: { systemName: '报工记录打印模板', fields: ['报工单号', '加工单号', '商品名', '商品编号', '工序名', '报工类型', '报工生产人员', '机台', '报工数量', '良品数', '不良品数', '不良品项', '计价方式', '工资单价', '工资(元)', '报工开始时间', '报工结束时间', '报工时长', '质检状态', '结算状态', '报工时间', '报工备注'] },
  full_inspection: { systemName: '全检打印模板', fields: ['商品编号', '商品名', '商品规格', '工序名', '工序编号', '报工单位', '车间', '产线'] },
  spot_check: { systemName: '抽检打印模板', fields: ['质检单号', '加工单号', '工序名', '工序编号', '商品编号', '商品', '商品规格'] },
  out_work_order: { systemName: '外协工单打印模板', fields: ['外协工单号', '计划数', '状态', '商品', '商品编号', '商品规格', '供应商'] },
  outsourcing_receipt: { systemName: '外协验收打印模板', fields: ['加工单/外协工单', '工序', '外协类型', '结算状态', '商品', '商品编号', '供应商'] },
  outsourcing_settlement: { systemName: '外协结算打印模板', fields: ['供应商', '联系人', '地址', '外协类型', '结算状态', '加工单号/外协工单号', '工序', '商品'] },
  inspection_record: { systemName: '维保记录打印模板', fields: ['维保计划', '设备', '设备规格', '设备编号', '设备类别', '核验状态', '签字状态'] },
  point_inspection: { systemName: '点检记录打印模板', fields: ['设备', '设备编号', '设备类别', '点检人', '团队', '维保内容', '正常项'] },
  device_order: { systemName: '维修工单打印模板', fields: ['工单编号', '设备名称', '处理人', '团队', '接单时间', '处理时间', '维修总用时'] },
  device: { systemName: '设备档案打印模板', fields: ['设备编号', '设备名称', '设备规格', '设备图片', '设备状态', '设备类别', '物料清单'] },
  device_qr: { systemName: '设备二维码打印模板', fields: ['二维码编号', '设备名称', '设备规格', '设备编号', '生成时间'] },
  purchase_plan: { systemName: '采购计划打印模板', fields: ['计划编号', '计划名称', '金额', '采购数量', '供应商', '采购进度', '交货日期'] },
  purchase_order: { systemName: '采购单打印模板', fields: ['采购单号', '生产计划编号', '供应商', '金额', '采购数量', '入库金额(元)', '退货金额(元)'] },
  material_test: { systemName: '采购检验单打印模板', fields: ['检验单号', '检验规范', '采购单号', '采购人', '商品名', '商品编号', '商品规格'] },
  purchase_stock_in: { systemName: '采购入库单打印模板', fields: ['采购入库单号', '采购单号', '入库类型', '入库仓库', '审核状态', '成本总额(元)', '入库日期'] },
  produce_stock_in: { systemName: '成品入库单打印模板', fields: ['入库单号', '入库类型', '入库仓库', '审核状态', '成本总额(元)', '入库日期', '备注'] },
  semi_stock_in: { systemName: '半成品入库单打印模板', fields: ['入库单号', '入库类型', '入库方式', '入库仓库', '成本总额(元)', '入库日期', '审核状态'] },
  produce_return: { systemName: '生产退料单打印模板', fields: ['生产退料单号', '加工单/外协工单', '操作方式', '入库类型', '仓库', '退料日期', '退料总数'] },
  sales_return: { systemName: '销售退货单打印模板', fields: ['销售退货单号', '合同', '客户', '联系人', '地址', '入库类型', '仓库', '退货日期'] },
  else_stock_in: { systemName: '其他入库单打印模板', fields: ['其他入库单号', '入库类型', '供应商', '仓库', '入库日期', '审核状态', '成本总额(元)'] },
  sale_stock_out: { systemName: '销售出库单打印模板', fields: ['销售出库单号', '仓库', '客户', '客户联系人', '出库类型', '出库方式', '出库日期'] },
  production_out: { systemName: '生产出库单打印模板', fields: ['生产出库单号', '加工单/外协工单', '工序', '操作方式', '仓库', '出库类型', '出库日期'] },
  purchase_return: { systemName: '采购退货单打印模板', fields: ['采购退货单号', '采购单号', '供应商', '出库类型', '仓库', '退货日期', '审核状态'] },
  else_stock_out: { systemName: '其他出库单打印模板', fields: ['其他出库单号', '出库类型', '仓库', '出库日期', '审核状态', '成本总额(元)', '销售总额(元)'] },
  stock_allocate: { systemName: '调拨单打印模板', fields: ['调拨单号', '发出仓库', '收入仓库', '调拨日期', '审核状态', '成本总额(元)', '销售总额(元)'] },
  stock_taking: { systemName: '库存盘点打印模板', fields: ['盘库单号', '盘点日期', '盘点人', '盘点仓库', '差异总数', '备注', '创建人'] },
  goods: { systemName: '商品打印模板', fields: ['商品名', '编号', '规格', '单位', '商品来源', '销售单价', '成本单价'] },
};

function specOf(objectKey: string) {
  const spec = CATALOG[objectKey];
  if (!spec) throw new Problem(422, 'UNKNOWN_OBJECT', '未知打印对象');
  return spec;
}

function allowedFields(spec: Spec) {
  return [...spec.fields, ...(spec.extra ?? [])];
}

function defaultLayout(spec: Spec): Layout {
  const title = spec.systemName.replace(/打印模板$/, '');
  const blocks: Block[] = [{ id: 'title', type: 'text', text: title, x: 12, y: 10, w: 186, h: 12 }];
  spec.fields.slice(0, 8).forEach((field, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    blocks.push({ id: `f${index}`, type: 'field', field, x: 12 + col * 96, y: 28 + row * 12, w: 90, h: 10 });
  });
  const tableTop = 28 + Math.ceil(Math.min(spec.fields.length, 8) / 2) * 12 + 8;
  blocks.push({ id: 'sheet', type: 'table', columns: spec.fields.slice(0, 4), x: 12, y: tableTop, w: 186, h: 48 });
  return { paper: 'A4', margin_mm: 12, builtin: true, blocks };
}

function num(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Problem(422, 'INVALID_LAYOUT', `${label}不正确`);
  return Math.round(value * 10) / 10;
}

function nodeId(value: unknown, seen: Set<string>) {
  const id = text(value, 40, '组件编号', true);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Problem(422, 'INVALID_LAYOUT', '组件编号格式不正确');
  if (seen.has(id)) throw new Problem(422, 'INVALID_LAYOUT', '组件编号重复');
  seen.add(id);
  return id;
}

function cssColor(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = text(value, 7, '颜色');
  if (!/^#[0-9a-f]{6}$/.test(raw)) throw new Problem(422, 'INVALID_LAYOUT', '颜色格式不正确');
  return raw;
}

function flowNodes(value: unknown, fields: Set<string>, seen: Set<string>, label: string): FlowNode[] {
  if (!Array.isArray(value)) throw new Problem(422, 'INVALID_LAYOUT', `${label}不正确`);
  if (value.length > 40) throw new Problem(422, 'INVALID_LAYOUT', `${label}组件过多`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Problem(422, 'INVALID_LAYOUT', `${label}第 ${index + 1} 个组件不正确`);
    const node = item as Row;
    const id = nodeId(node.id, seen);
    if (node.type === 'paragraph') {
      if (!Array.isArray(node.runs) || node.runs.length < 1 || node.runs.length > 40) throw new Problem(422, 'INVALID_LAYOUT', '段落内容不正确');
      const align = node.align === undefined || node.align === 'left' ? undefined : node.align === 'center' || node.align === 'right' ? node.align : null;
      if (align === null) throw new Problem(422, 'INVALID_LAYOUT', '段落对齐不正确');
      const runs = node.runs.map((run) => {
        if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Problem(422, 'INVALID_LAYOUT', '段落内容不正确');
        const raw = run as Row;
        const next: FlowRun = { text: text(raw.text, 500, '段落文字') };
        if (raw.field !== undefined && raw.field !== '') {
          const field = text(raw.field, 40, '业务字段', true);
          if (!fields.has(field)) throw new Problem(422, 'INVALID_LAYOUT', `业务字段「${field}」不属于该对象`);
          next.field = field;
          if (!next.text) next.text = field;
        }
        if (!next.text) throw new Problem(422, 'INVALID_LAYOUT', '段落内容不正确');
        if (raw.bold === true) next.bold = true;
        if (raw.italic === true) next.italic = true;
        if (raw.strike === true) next.strike = true;
        const color = cssColor(raw.color);
        const bg = cssColor(raw.bg);
        if (color) next.color = color;
        if (bg) next.bg = bg;
        return next;
      });
      return align ? { id, type: 'paragraph', align, runs } : { id, type: 'paragraph', runs };
    }
    if (node.type === 'table') {
      const source = node.source === undefined || node.source === '' ? '' : node.source === '出库明细' || node.source === '退货明细' ? node.source : null;
      if (source === null) throw new Problem(422, 'INVALID_LAYOUT', '表格来源不正确');
      if (!Array.isArray(node.columns) || node.columns.length < 1 || node.columns.length > 20) throw new Problem(422, 'INVALID_LAYOUT', '表格至少要有一列');
      const columns = [...new Set(node.columns.map((column) => text(column, 40, '表格列', true)))];
      if (columns.some((column) => !fields.has(column))) throw new Problem(422, 'INVALID_LAYOUT', '表格列必须来自该对象的业务字段');
      return { id, type: 'table', source, columns };
    }
    if (node.type === 'image') {
      const src = text(node.src, 160000, '图片', true);
      if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) throw new Problem(422, 'INVALID_LAYOUT', '图片格式不正确');
      return { id, type: 'image', src };
    }
    throw new Problem(422, 'INVALID_LAYOUT', `${label}第 ${index + 1} 个组件不正确`);
  });
}

function blocksFromFlow(nodes: FlowNode[], fields: Set<string>): Block[] {
  const blocks: Block[] = [];
  let y = 10;
  for (const node of nodes) {
    if (blocks.length >= 60) break;
    const top = Math.min(380, y);
    if (node.type === 'paragraph') {
      const only = node.runs.length === 1 ? node.runs[0] : undefined;
      if (only?.field) blocks.push({ id: node.id, type: 'field', field: only.field, x: 12, y: top, w: 90, h: 10 });
      else {
        const raw = node.runs.map((run) => run.text).join('').trim();
        if (!raw) continue;
        blocks.push({ id: node.id, type: 'text', text: raw.slice(0, 80), x: 12, y: top, w: 180, h: 10 });
      }
      y += 12;
    } else if (node.type === 'table') {
      const columns = node.columns.filter((column) => fields.has(column)).slice(0, 12);
      if (!columns.length) continue;
      blocks.push({ id: node.id, type: 'table', columns, x: 12, y: top, w: 186, h: 36 });
      y += 40;
    } else {
      blocks.push({ id: node.id, type: 'text', text: '[图片]', x: 12, y: top, w: 40, h: 16 });
      y += 18;
    }
  }
  return blocks;
}

function layoutOf(value: unknown, fields: string[]): Layout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Problem(422, 'INVALID_LAYOUT', '版式内容不正确');
  const raw = value as Row;
  if (raw.paper !== 'A4' && raw.paper !== 'A5') throw new Problem(422, 'INVALID_LAYOUT', '纸张只能是 A4 或 A5');
  const margin = Number(raw.margin_mm);
  if (!Number.isInteger(margin) || margin < 0 || margin > 40) throw new Problem(422, 'INVALID_LAYOUT', '页边距须为 0 到 40 的整数');
  if (Array.isArray(raw.flow)) {
    const allowed = new Set(fields);
    const seen = new Set<string>();
    const flow = flowNodes(raw.flow, allowed, seen, '画布');
    const footer = Array.isArray(raw.footer) ? flowNodes(raw.footer, allowed, seen, '表尾') : [];
    const blocks = blocksFromFlow([...flow, ...footer], allowed);
    if (!blocks.length) throw new Problem(422, 'INVALID_LAYOUT', '画布至少要有一个组件');
    return { paper: raw.paper, margin_mm: margin, builtin: false, footer_on: raw.footer_on === true, flow, footer, blocks };
  }
  if (!Array.isArray(raw.blocks) || raw.blocks.length < 1 || raw.blocks.length > 60) throw new Problem(422, 'INVALID_LAYOUT', '画布至少要有一个组件');
  const allowed = new Set(fields);
  const seen = new Set<string>();
  const blocks = raw.blocks.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Problem(422, 'INVALID_LAYOUT', `第 ${index + 1} 个组件不正确`);
    const block = item as Row;
    const id = text(block.id, 40, '组件编号', true);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Problem(422, 'INVALID_LAYOUT', '组件编号格式不正确');
    if (seen.has(id)) throw new Problem(422, 'INVALID_LAYOUT', '组件编号重复');
    seen.add(id);
    const type = block.type;
    if (type !== 'text' && type !== 'field' && type !== 'table') throw new Problem(422, 'INVALID_LAYOUT', '组件只能是文本、业务字段或表格');
    const next: Block = {
      id,
      type,
      x: num(block.x, '横坐标', 0, 400),
      y: num(block.y, '纵坐标', 0, 400),
      w: num(block.w, '宽度', 8, 400),
      h: num(block.h, '高度', 6, 400),
    };
    if (type === 'text') next.text = text(block.text, 80, '文本', true);
    if (type === 'field') {
      const field = text(block.field, 40, '业务字段', true);
      if (!allowed.has(field)) throw new Problem(422, 'INVALID_LAYOUT', `业务字段「${field}」不属于该对象`);
      next.field = field;
    }
    if (type === 'table') {
      if (!Array.isArray(block.columns) || block.columns.length < 1 || block.columns.length > 12) throw new Problem(422, 'INVALID_LAYOUT', '表格至少要有一列');
      const columns = block.columns.map((column) => text(column, 40, '表格列', true));
      if (columns.some((column) => !allowed.has(column))) throw new Problem(422, 'INVALID_LAYOUT', '表格列必须来自该对象的业务字段');
      next.columns = [...new Set(columns)];
    }
    return next;
  });
  return { paper: raw.paper, margin_mm: margin, builtin: false, blocks };
}

function asLayout(value: unknown): Layout {
  if (typeof value === 'string') return JSON.parse(value) as Layout;
  return value as Layout;
}

function present(row: { id: string; name: string; is_system: boolean; content: unknown }) {
  return { id: row.id, name: row.name, is_system: row.is_system, content: asLayout(row.content) };
}

async function namesOf(sql: { query: <T>(statement: string, params?: unknown[]) => Promise<{ rows: T[] }> }, objectKey: string) {
  const rows = (await sql.query<{ name: string }>('SELECT name FROM print_templates WHERE object_key=$1', [objectKey])).rows;
  return new Set(rows.map((row) => row.name));
}

function copyName(base: string, taken: Set<string>) {
  const suffix = '副本';
  let name = `${base}${suffix}`.slice(0, 40);
  let n = 2;
  while (taken.has(name)) {
    const tail = `${suffix}${n}`;
    name = `${base.slice(0, Math.max(1, 40 - tail.length))}${tail}`;
    n += 1;
  }
  return name;
}

export function registerPrintTemplates(app: FastifyInstance, services: Services) {
  app.get<{ Querystring: { object_key?: string } }>('/api/print-templates', (request) => member(services, request, false, async (sql, actor) => {
    const objectKey = text(request.query.object_key, 80, '打印对象', true);
    const spec = specOf(objectKey);
    const found = (await sql.query<{ id: string }>('SELECT id FROM print_templates WHERE object_key=$1 AND is_system', [objectKey])).rows[0];
    if (!found) {
      await sql.query(
        'INSERT INTO print_templates(tenant_id, object_key, name, is_system, content) VALUES($1,$2,$3,true,$4::jsonb)',
        [actor.tenant_id, objectKey, spec.systemName, JSON.stringify(defaultLayout(spec))],
      );
    }
    const items = (await sql.query<{ id: string; name: string; is_system: boolean; content: unknown }>('SELECT id, name, is_system, content FROM print_templates WHERE object_key=$1 ORDER BY is_system DESC, created_at ASC', [objectKey])).rows;
    return { object_key: objectKey, system_name: spec.systemName, palette: spec.fields, items: items.map(present) };
  }));

  app.post('/api/print-templates', async (request, reply) => reply.code(201).send(await member(services, request, true, async (sql, actor) => {
    const body = request.body as Row;
    const objectKey = text(body.object_key, 80, '打印对象', true);
    const spec = specOf(objectKey);
    const name = text(body.name, 40, '模板名称', true);
    const taken = await namesOf(sql, objectKey);
    if (taken.has(name)) throw new Problem(409, 'DUPLICATE', '本对象下已有同名模板');
    const content = layoutOf(body.content, allowedFields(spec));
    const row = (await sql.query<{ id: string; name: string; is_system: boolean; content: unknown }>(
      'INSERT INTO print_templates(tenant_id, object_key, name, is_system, content) VALUES($1,$2,$3,false,$4::jsonb) RETURNING id, name, is_system, content',
      [actor.tenant_id, objectKey, name, JSON.stringify(content)],
    )).rows[0]!;
    return present(row);
  })));

  app.post<{ Params: { id: string } }>('/api/print-templates/:id/copy', async (request, reply) => reply.code(201).send(await member(services, request, true, async (sql, actor) => {
    const source = (await sql.query<{ id: string; object_key: string; name: string; content: unknown }>('SELECT id, object_key, name, content FROM print_templates WHERE id=$1', [request.params.id])).rows[0];
    if (!source) throw new Problem(404, 'NOT_FOUND', '打印模板不存在');
    const spec = specOf(source.object_key);
    const body = (request.body ?? {}) as Row;
    const requested = text(body.name, 40, '模板名称');
    const taken = await namesOf(sql, source.object_key);
    const name = requested || copyName(source.name, taken);
    if (taken.has(name)) throw new Problem(409, 'DUPLICATE', '本对象下已有同名模板');
    const content = asLayout(source.content);
    content.builtin = false;
    const checked = layoutOf(content, allowedFields(spec));
    const row = (await sql.query<{ id: string; name: string; is_system: boolean; content: unknown }>(
      'INSERT INTO print_templates(tenant_id, object_key, name, is_system, content) VALUES($1,$2,$3,false,$4::jsonb) RETURNING id, name, is_system, content',
      [actor.tenant_id, source.object_key, name, JSON.stringify(checked)],
    )).rows[0]!;
    return present(row);
  })));

  app.patch<{ Params: { id: string } }>('/api/print-templates/:id', (request) => member(services, request, true, async (sql) => {
    const current = (await sql.query<{ id: string; object_key: string; name: string; is_system: boolean; content: unknown }>('SELECT id, object_key, name, is_system, content FROM print_templates WHERE id=$1', [request.params.id])).rows[0];
    if (!current) throw new Problem(404, 'NOT_FOUND', '打印模板不存在');
    if (current.is_system) throw new Problem(422, 'SYSTEM_READONLY', '系统模板不能修改');
    const spec = specOf(current.object_key);
    const body = request.body as Row;
    const name = body.name === undefined ? current.name : text(body.name, 40, '模板名称', true);
    if (name !== current.name) {
      const taken = await namesOf(sql, current.object_key);
      if (taken.has(name)) throw new Problem(409, 'DUPLICATE', '本对象下已有同名模板');
    }
    const content = body.content === undefined ? layoutOf({ ...asLayout(current.content), builtin: false }, allowedFields(spec)) : layoutOf(body.content, allowedFields(spec));
    const row = (await sql.query<{ id: string; name: string; is_system: boolean; content: unknown }>(
      'UPDATE print_templates SET name=$2, content=$3::jsonb, updated_at=now() WHERE id=$1 RETURNING id, name, is_system, content',
      [current.id, name, JSON.stringify(content)],
    )).rows[0]!;
    return present(row);
  }));

  app.delete<{ Params: { id: string } }>('/api/print-templates/:id', (request) => member(services, request, true, async (sql) => {
    const current = (await sql.query<{ id: string; is_system: boolean }>('SELECT id, is_system FROM print_templates WHERE id=$1', [request.params.id])).rows[0];
    if (!current) throw new Problem(404, 'NOT_FOUND', '打印模板不存在');
    if (current.is_system) throw new Problem(422, 'SYSTEM_READONLY', '系统模板不能删除');
    await sql.query('DELETE FROM print_templates WHERE id=$1', [current.id]);
    return { ok: true };
  }));
}
