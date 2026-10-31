import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as XLSX from 'xlsx';
import type { Sql } from '../database.js';
import { createBomFromImport } from '../masters.js';
import { Problem, type Actor } from '../services.js';
import { readAiConfig, type AiConfig } from './config.js';

const require = createRequire(import.meta.url);
// pdf-parse 是 CJS；用 createRequire 兼容 ESM
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text?: string; numpages?: number }>;

export type BomField = 'code' | 'name' | 'spec' | 'unit' | 'quantity' | 'loss_rate' | 'ignore';

export type ColumnMapping = Partial<Record<BomField, string>>;

export type PreviewRow = {
  index: number;
  cells: Record<string, string>;
  code: string;
  name: string;
  spec: string;
  unit: string;
  quantity: string;
  loss_rate: string;
  component_product_id: string | null;
  component_name: string | null;
  match: 'matched' | 'unmatched' | 'ambiguous' | 'skipped';
  warning?: string;
};

export type BomPreview = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  filename: string;
  columns: string[];
  mapping: ColumnMapping;
  rows: PreviewRow[];
  warnings: string[];
};

export type MappingScheme = {
  id: string;
  tenant_id: string;
  name: string;
  mapping: ColumnMapping;
  created_at: number;
};

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map<string, BomPreview>();
const schemes = new Map<string, MappingScheme[]>();

const FIELD_ALIASES: Record<Exclude<BomField, 'ignore'>, string[]> = {
  code: ['物料编码', '物料编号', '商品编号', '产品编号', '料号', '编码', '编号', 'code', 'item_code', 'material_code', 'sku', 'part_no', 'part_number'],
  name: ['物料名称', '商品名称', '产品名称', '名称', '品名', 'name', 'material_name', 'item_name'],
  spec: ['规格', '规格型号', '型号', 'specification', 'spec'],
  unit: ['单位', '计量单位', 'unit', 'uom'],
  quantity: ['用量', '单位用量', '数量', '定额', 'qty', 'quantity', 'amount', '用量（单位）'],
  loss_rate: ['损耗率', '损耗', 'loss', 'loss_rate', 'scrap'],
};

function normalizeHeader(value: string) {
  return value.replace(/\s+/g, '').replace(/[：:]/g, '').toLowerCase();
}

export function guessMapping(columns: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [Exclude<BomField, 'ignore'>, string[]][]) {
    const hit = columns.find((col) => {
      if (used.has(col)) return false;
      const norm = normalizeHeader(col);
      return aliases.some((alias) => normalizeHeader(alias) === norm || norm.includes(normalizeHeader(alias)));
    });
    if (hit) {
      mapping[field] = hit;
      used.add(hit);
    }
  }
  return mapping;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    // avoid 1.0300000000000001
    return String(value);
  }
  return String(value).trim();
}


function splitPdfCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.includes('|')) {
    return trimmed
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
  }
  if (trimmed.includes('\t') || / {2,}/.test(trimmed) || /\u3000{2,}/.test(trimmed)) {
    return trimmed.split(/\t+| {2,}|\u3000+/).map((c) => c.trim()).filter(Boolean);
  }
  if (trimmed.includes(',') && !/\s/.test(trimmed.split(',')[0] ?? '')) {
    return trimmed.split(',').map((c) => c.trim());
  }
  // PDF 常见：单空格分列（表头多为词组无空格）
  return trimmed.split(/\s+/).map((c) => c.trim()).filter(Boolean);
}

function looksLikeHeader(cells: string[]): boolean {
  if (cells.length < 2) return false;
  const joined = cells.map((c) => normalizeHeader(c));
  let hits = 0;
  for (const aliases of Object.values(FIELD_ALIASES)) {
    if (
      aliases.some((alias) => {
        const a = normalizeHeader(alias);
        return joined.some((cell) => cell === a || cell.includes(a));
      })
    ) {
      hits += 1;
    }
  }
  return hits >= 2;
}

function matrixFromLines(lines: string[]): { columns: string[]; matrix: string[][]; warnings: string[] } | null {
  const warnings: string[] = [];
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length < 2) return null;

  let headerIdx = -1;
  let headerCells: string[] = [];
  for (let i = 0; i < Math.min(nonEmpty.length, 40); i += 1) {
    const cells = splitPdfCells(nonEmpty[i]!);
    if (looksLikeHeader(cells)) {
      headerIdx = i;
      headerCells = cells;
      break;
    }
  }
  if (headerIdx < 0) {
    // 兜底：取首行作表头，若列数>=2
    const first = splitPdfCells(nonEmpty[0]!);
    if (first.length < 2) return null;
    headerIdx = 0;
    headerCells = first;
    warnings.push('未能识别标准 BOM 表头，已按首行作为列名，请在预览中核对映射');
  }

  const columns: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < headerCells.length; i += 1) {
    let name = headerCells[i] || `列${i + 1}`;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) name = `${name}_${count}`;
    columns.push(name);
  }

  const matrix: string[][] = [];
  for (let i = headerIdx + 1; i < nonEmpty.length; i += 1) {
    const cells = splitPdfCells(nonEmpty[i]!);
    if (!cells.length) continue;
    // 跳过重复表头行
    if (looksLikeHeader(cells)) continue;
    const row = columns.map((_, j) => cells[j] ?? '');
    if (row.some((c) => c !== '')) matrix.push(row);
  }
  if (matrix.length < 1) return null;
  return { columns, matrix, warnings };
}

export async function parsePdfBom(
  buffer: Buffer,
  filename: string,
  config: AiConfig = readAiConfig(),
): Promise<{ columns: string[]; matrix: string[][]; warnings: string[] }> {
  const warnings: string[] = [];
  let text = '';
  try {
    const parsed = await pdfParse(buffer);
    text = (parsed.text ?? '').replace(/\r/g, '');
  } catch {
    throw new Problem(422, 'PARSE_FAILED', 'PDF 解析失败，请确认文件未加密且含可选中文字');
  }
  if (!text.trim()) {
    throw new Problem(422, 'EMPTY_PDF_TEXT', 'PDF 未提取到文字（可能是扫描件）。请导出带文字层的 PDF，或改用 Excel/CSV');
  }
  warnings.push('已从 PDF 抽取文字并尝试识别表格');

  const lines = text.split('\n');
  const heuristic = matrixFromLines(lines);
  if (heuristic) {
    return {
      columns: heuristic.columns,
      matrix: heuristic.matrix,
      warnings: [...warnings, ...heuristic.warnings],
    };
  }

  // AI 兜底：把截断文本交给模型抽成表
  if (config.provider === 'openai' && config.apiKey) {
    try {
      const snippet = text.slice(0, 6000);
      const response = await fetch(`${config.openaiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.openaiModel,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                '你是 BOM 表格抽取助手。从 PDF 文本中抽取物料表，只返回 JSON：{"columns":["列名",...],"rows":[["单元格",...],...]}。列优先：物料编码、名称、规格、单位、用量、损耗率。无法抽取则返回 {"columns":[],"rows":[]}。',
            },
            { role: 'user', content: `文件名：${filename}\n文本：\n${snippet}` },
          ],
        }),
      });
      if (response.ok) {
        const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
        const content = json.choices?.[0]?.message?.content?.trim() ?? '';
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { columns?: unknown; rows?: unknown };
          const columns = Array.isArray(parsed.columns)
            ? parsed.columns.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean)
            : [];
          const rowsRaw = Array.isArray(parsed.rows) ? parsed.rows : [];
          const matrix = rowsRaw
            .filter((row): row is unknown[] => Array.isArray(row))
            .map((row) => columns.map((_, i) => cellText(row[i])))
            .filter((row) => row.some((c) => c !== ''));
          if (columns.length >= 2 && matrix.length >= 1) {
            warnings.push('已用 AI 从 PDF 文本抽取表格，请人工核对');
            return { columns, matrix, warnings };
          }
        }
      }
    } catch {
      // fall through
    }
  }

  throw new Problem(
    422,
    'PDF_TABLE_NOT_FOUND',
    '未能从 PDF 识别出 BOM 表格。请确认含表头（物料编码/名称/用量等），或改用 Excel/CSV',
  );
}

export async function parseBomFile(
  buffer: Buffer,
  filename: string,
  config: AiConfig = readAiConfig(),
): Promise<{ columns: string[]; matrix: string[][]; warnings: string[] }> {
  const lower = filename.toLowerCase();
  if (/\.pdf$/.test(lower)) return parsePdfBom(buffer, filename, config);
  return parseSpreadsheet(buffer, filename);
}

export function parseSpreadsheet(buffer: Buffer, filename: string): { columns: string[]; matrix: string[][]; warnings: string[] } {
  const warnings: string[] = [];
  const lower = filename.toLowerCase();
  if (!/\.(xlsx|xls|csv)$/.test(lower)) {
    throw new Problem(422, 'UNSUPPORTED_FILE', '仅支持 xlsx / xls / csv / pdf（请用 parseBomFile）');
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: false, codepage: 65001 });
  } catch {
    throw new Problem(422, 'PARSE_FAILED', '表格解析失败，请检查文件格式');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Problem(422, 'EMPTY_SHEET', '表格为空');
  const sheet = workbook.Sheets[sheetName]!;
  const matrixRaw = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    defval: '',
    raw: false,
  }) as unknown[][];
  const matrix = matrixRaw
    .map((row) => (Array.isArray(row) ? row.map((cell) => cellText(cell)) : []))
    .filter((row) => row.some((cell) => cell !== ''));
  if (matrix.length < 2) throw new Problem(422, 'NO_DATA', '表格至少需要表头和一行数据');
  const headerRow = matrix[0]!;
  const columns: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i += 1) {
    let name = headerRow[i] || `列${i + 1}`;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) name = `${name}_${count}`;
    columns.push(name);
  }
  if (workbook.SheetNames.length > 1) warnings.push(`仅解析首个工作表「${sheetName}」`);
  return { columns, matrix: matrix.slice(1), warnings };
}

function applyMapping(columns: string[], dataRows: string[][], mapping: ColumnMapping): Omit<PreviewRow, 'component_product_id' | 'component_name' | 'match' | 'warning'>[] {
  const colIndex = (field: BomField) => {
    const name = mapping[field];
    if (!name) return -1;
    return columns.indexOf(name);
  };
  const idx = {
    code: colIndex('code'),
    name: colIndex('name'),
    spec: colIndex('spec'),
    unit: colIndex('unit'),
    quantity: colIndex('quantity'),
    loss_rate: colIndex('loss_rate'),
  };
  return dataRows.map((row, index) => {
    const cells: Record<string, string> = {};
    columns.forEach((col, i) => {
      cells[col] = row[i] ?? '';
    });
    const pick = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    return {
      index: index + 1,
      cells,
      code: pick(idx.code),
      name: pick(idx.name),
      spec: pick(idx.spec),
      unit: pick(idx.unit),
      quantity: pick(idx.quantity) || '1',
      loss_rate: pick(idx.loss_rate) || '0',
    };
  });
}

async function matchProducts(sql: Sql, rows: ReturnType<typeof applyMapping>): Promise<PreviewRow[]> {
  const codes = [...new Set(rows.map((r) => r.code).filter(Boolean))];
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
      const existing = byCode.get(row.code);
      if (!existing) byCode.set(row.code, { id: row.id, name: row.name, count: Number(row.n) });
    }
  }
  return rows.map((row) => {
    if (!row.code && !row.name) {
      return { ...row, component_product_id: null, component_name: null, match: 'skipped' as const, warning: '空行已跳过' };
    }
    if (!row.code) {
      return { ...row, component_product_id: null, component_name: null, match: 'unmatched' as const, warning: '缺少物料编码，无法匹配商品' };
    }
    const hit = byCode.get(row.code);
    if (!hit) {
      return { ...row, component_product_id: null, component_name: null, match: 'unmatched' as const, warning: `未找到编码 ${row.code}` };
    }
    if (hit.count > 1) {
      return { ...row, component_product_id: null, component_name: hit.name, match: 'ambiguous' as const, warning: `编码 ${row.code} 匹配到多个商品` };
    }
    return { ...row, component_product_id: hit.id, component_name: hit.name, match: 'matched' as const };
  });
}

function purgeExpired() {
  const now = Date.now();
  for (const [id, preview] of previews) {
    if (now - preview.created_at > PREVIEW_TTL_MS) previews.delete(id);
  }
}

export function peekBomPreview(previewId: string, tenantId: string): BomPreview | null {
  purgeExpired();
  const preview = previews.get(previewId);
  if (!preview || preview.tenant_id !== tenantId) return null;
  return preview;
}

export function getPreview(previewId: string, tenantId: string): BomPreview {
  const preview = peekBomPreview(previewId, tenantId);
  if (!preview) {
    throw new Problem(404, 'PREVIEW_NOT_FOUND', '预览已失效或不存在，请重新上传');
  }
  return preview;
}

export function discardPreview(previewId: string, tenantId: string) {
  purgeExpired();
  const preview = previews.get(previewId);
  if (!preview || preview.tenant_id !== tenantId) {
    throw new Problem(404, 'PREVIEW_NOT_FOUND', '预览已失效或不存在');
  }
  previews.delete(previewId);
  return { ok: true as const };
}

/** 测试用：清空内存预览（不影响业务表）。 */
export function resetBomPreviewsForTests() {
  previews.clear();
}

export async function buildBomPreview(
  sql: Sql,
  actor: Actor,
  buffer: Buffer,
  filename: string,
  mappingOverride?: ColumnMapping,
  config: AiConfig = readAiConfig(),
): Promise<{ preview_id: string; columns: string[]; mapping: ColumnMapping; rows: PreviewRow[]; warnings: string[] }> {
  const { columns, matrix, warnings } = await parseBomFile(buffer, filename, config);
  const mapping = { ...guessMapping(columns), ...(mappingOverride ?? {}) };
  if (!mapping.code && !mapping.name) {
    warnings.push('未能识别物料编码/名称列，请在预览中手动映射');
  }
  if (!mapping.quantity) warnings.push('未能识别用量列，默认用量为 1');
  const drafted = applyMapping(columns, matrix, mapping);
  const rows = await matchProducts(sql, drafted);
  const unmatched = rows.filter((r) => r.match === 'unmatched' || r.match === 'ambiguous').length;
  if (unmatched) warnings.push(`${unmatched} 行未能精确匹配商品，确认前请核对`);
  const preview: BomPreview = {
    id: randomUUID(),
    tenant_id: actor.tenant_id,
    actor_id: actor.user_id,
    created_at: Date.now(),
    filename,
    columns,
    mapping,
    rows,
    warnings,
  };
  purgeExpired();
  previews.set(preview.id, preview);
  return {
    preview_id: preview.id,
    columns,
    mapping,
    rows,
    warnings,
  };
}

function remapPreview(preview: BomPreview, mapping: ColumnMapping, matchedRows: PreviewRow[]) {
  preview.mapping = mapping;
  preview.rows = matchedRows;
}

export async function reapplyMapping(sql: Sql, preview: BomPreview, mapping: ColumnMapping) {
  const dataRows = preview.rows.map((row) => preview.columns.map((col) => row.cells[col] ?? ''));
  const drafted = applyMapping(preview.columns, dataRows, mapping);
  const rows = await matchProducts(sql, drafted);
  remapPreview(preview, mapping, rows);
  return preview;
}

async function maybeAssistMappingWithAi(
  columns: string[],
  config: AiConfig,
): Promise<ColumnMapping | null> {
  if (config.provider !== 'openai' || !config.apiKey) return null;
  try {
    const response = await fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              '你是 BOM 表格列映射助手。只返回 JSON，键只能是 code,name,spec,unit,quantity,loss_rate，值为给定列名之一。无法判断则省略该键。',
          },
          { role: 'user', content: `列名：${JSON.stringify(columns)}` },
        ],
      }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim() ?? '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, string>;
    const out: ColumnMapping = {};
    for (const key of ['code', 'name', 'spec', 'unit', 'quantity', 'loss_rate'] as BomField[]) {
      const value = parsed[key];
      if (typeof value === 'string' && columns.includes(value)) out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

export async function parseBomUpload(
  sql: Sql,
  actor: Actor,
  buffer: Buffer,
  filename: string,
  config: AiConfig = readAiConfig(),
) {
  const base = await buildBomPreview(sql, actor, buffer, filename, undefined, config);
  const assisted = await maybeAssistMappingWithAi(base.columns, config);
  if (assisted && Object.keys(assisted).length) {
    const preview = getPreview(base.preview_id, actor.tenant_id);
    const merged = { ...preview.mapping, ...assisted };
    await reapplyMapping(sql, preview, merged);
    return {
      preview_id: preview.id,
      columns: preview.columns,
      mapping: preview.mapping,
      rows: preview.rows,
      warnings: preview.warnings,
    };
  }
  return base;
}

function validQuantity(value: string) {
  return /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(value) && value !== '0' && !/^0\d/.test(value);
}

export async function confirmBomImport(
  sql: Sql,
  actor: Actor,
  body: {
    preview_id?: unknown;
    mapping?: unknown;
    product_id?: unknown;
    name?: unknown;
  },
) {
  if (actor.role !== 'admin' && actor.role !== 'planner') {
    throw new Problem(403, 'FORBIDDEN', '当前角色不能写入物料清单');
  }
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const preview = getPreview(previewId, actor.tenant_id);

  if (body.mapping && typeof body.mapping === 'object') {
    const mapping = body.mapping as ColumnMapping;
    await reapplyMapping(sql, preview, { ...preview.mapping, ...mapping });
  }

  const productId = typeof body.product_id === 'string' && body.product_id.trim() ? body.product_id.trim() : null;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : preview.filename.replace(/\.(xlsx|xls|csv|pdf)$/i, '') || 'AI导入BOM';

  const items: { component_product_id: string; quantity: string; loss_rate: string }[] = [];
  const lineWarnings: string[] = [];
  for (const row of preview.rows) {
    if (row.match === 'skipped') continue;
    if (row.match !== 'matched' || !row.component_product_id) {
      lineWarnings.push(`第 ${row.index} 行未匹配商品，已跳过`);
      continue;
    }
    if (!validQuantity(row.quantity)) {
      lineWarnings.push(`第 ${row.index} 行用量无效（${row.quantity || '空'}），已跳过`);
      continue;
    }
    const loss = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(row.loss_rate) ? row.loss_rate : '0';
    items.push({
      component_product_id: row.component_product_id,
      quantity: row.quantity,
      loss_rate: loss,
    });
  }
  if (!items.length) throw new Problem(422, 'NO_VALID_ROWS', '没有可写入的有效物料行，请调整映射或商品编码后重试');

  const created = await createBomFromImport(sql, actor, {
    parent_product_id: productId,
    name,
    description: `AI导入自 ${preview.filename}`,
    items,
  });

  await sql.query(
    `INSERT INTO ai_action_log(tenant_id, actor_id, actor_name, action, question_summary, intent, meta)
     VALUES ($1,$2,$3,'bom_import_confirm',$4,$5,$6::jsonb)`,
    [
      actor.tenant_id,
      actor.user_id,
      actor.display_name,
      `导入 ${preview.filename} → BOM ${created.bom.id}`.slice(0, 200),
      'bom_import',
      JSON.stringify({
        preview_id: preview.id,
        bom_id: created.bom.id,
        bom_version_id: created.version_id,
        items_count: items.length,
        skipped: lineWarnings.length,
        filename: preview.filename,
        product_id: productId,
      }),
    ],
  );

  previews.delete(preview.id);
  return {
    bom: created.bom,
    bom_version_id: created.version_id,
    items_count: items.length,
    warnings: lineWarnings,
  };
}

export function listSchemes(tenantId: string) {
  return (schemes.get(tenantId) ?? []).map(({ id, name, mapping, created_at }) => ({
    id,
    name,
    mapping,
    created_at,
  }));
}

export function saveScheme(tenantId: string, nameRaw: unknown, mappingRaw: unknown) {
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name) throw new Problem(422, 'NAME_REQUIRED', '请填写方案名称');
  if (name.length > 80) throw new Problem(422, 'TOO_LONG', '方案名称不能超过 80 字');
  if (!mappingRaw || typeof mappingRaw !== 'object') throw new Problem(422, 'MAPPING_REQUIRED', '请提供映射方案');
  const mapping = mappingRaw as ColumnMapping;
  const list = schemes.get(tenantId) ?? [];
  const item: MappingScheme = {
    id: randomUUID(),
    tenant_id: tenantId,
    name,
    mapping,
    created_at: Date.now(),
  };
  list.unshift(item);
  schemes.set(tenantId, list.slice(0, 30));
  return { id: item.id, name: item.name, mapping: item.mapping, created_at: item.created_at };
}
