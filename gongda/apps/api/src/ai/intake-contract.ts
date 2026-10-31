/**
 * S2：订单/送货单/报价等 → 合同预览 → writes/confirm 打穿 money_contracts
 * OCR 未接时用确定性文本解析（mock 边界见 docs/ai/S2-验收说明.md）
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../database.js';
import { Problem, type Actor } from '../services.js';
import { applyGlossaryToOrderFields, type GlossaryHit } from './glossary.js';

export type ContractLineDraft = {
  product_id: string;
  product_code: string;
  product_name: string;
  unit_name: string;
  unit_price: string;
  quantity: string;
  amount: string;
};

export type ContractFields = {
  customer_name: string;
  customer_code: string;
  customer_id: string | null;
  contact_name: string;
  contact_phone: string;
  product_code: string;
  product_name: string;
  product_id: string | null;
  quantity: string;
  unit_price: string;
  delivery_date: string;
  note: string;
};

export type ContractPreview = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  filename: string;
  kind: 'order_doc';
  fields: ContractFields;
  line: ContractLineDraft | null;
  attachment_bytes: Buffer;
  attachment_digest: string;
  warnings: string[];
  /** 串加工单默认关；确认合同后可另开二次确认预览 */
  chain_work_order_default: false;
};

export type ChainWoPreview = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  contract_id: string;
  contract_code: string;
  contract_line_id: string;
  product_id: string;
  unit_id: string;
  plan_qty: string;
  warehouse_id: string | null;
};

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const contractPreviews = new Map<string, ContractPreview>();
const chainPreviews = new Map<string, ChainWoPreview>();

function purge() {
  const now = Date.now();
  for (const [id, p] of contractPreviews) {
    if (now - p.created_at > PREVIEW_TTL_MS) contractPreviews.delete(id);
  }
  for (const [id, p] of chainPreviews) {
    if (now - p.created_at > PREVIEW_TTL_MS) chainPreviews.delete(id);
  }
}

export function peekContractPreview(previewId: string, tenantId: string): ContractPreview | null {
  purge();
  const p = contractPreviews.get(previewId);
  if (!p || p.tenant_id !== tenantId) return null;
  return p;
}

export function getContractPreview(previewId: string, tenantId: string): ContractPreview {
  const p = peekContractPreview(previewId, tenantId);
  if (!p) throw new Problem(404, 'PREVIEW_NOT_FOUND', '合同预览已失效或不存在，请重新上传');
  return p;
}

export function discardContractPreview(previewId: string, tenantId: string) {
  getContractPreview(previewId, tenantId);
  contractPreviews.delete(previewId);
  return { ok: true as const };
}

export function peekChainWoPreview(previewId: string, tenantId: string): ChainWoPreview | null {
  purge();
  const p = chainPreviews.get(previewId);
  if (!p || p.tenant_id !== tenantId) return null;
  return p;
}

export function discardChainWoPreview(previewId: string, tenantId: string) {
  const p = peekChainWoPreview(previewId, tenantId);
  if (!p) throw new Problem(404, 'PREVIEW_NOT_FOUND', '串加工单预览已失效');
  chainPreviews.delete(previewId);
  return { ok: true as const };
}

export function resetContractIntakeForTests() {
  contractPreviews.clear();
  chainPreviews.clear();
}

function digestBuffer(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 64);
}

/**
 * 附件抽字（最小可用）：PDF 走 pdf-parse；Excel 走 xlsx；纯文本/CSV 走 utf8；图片无 OCR。
 * 供 classify / 合同草稿字段共用。确认前仍不写库。
 */
export async function extractAttachmentText(
  buffer: Buffer,
  filename: string,
): Promise<{
  text: string;
  method: 'pdf-parse' | 'pypdf' | 'xlsx' | 'csv' | 'utf8' | 'utf8_binary_weak' | 'none';
}> {
  const name = filename || '';

  // Excel（package.json 已声明 xlsx；未安装则诚实回退 none）
  const isXlsx =
    /\.(xlsx|xls)$/i.test(name) ||
    (buffer.length >= 4 && buffer.subarray(0, 2).toString('utf8') === 'PK' && /\.(xlsx)$/i.test(name));
  if (isXlsx || /\.(xlsx|xls)$/i.test(name)) {
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const XLSX = require('xlsx') as {
        read: (data: Buffer, opts?: object) => { SheetNames: string[]; Sheets: Record<string, unknown> };
        utils: { sheet_to_csv: (sheet: unknown) => string };
      };
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames.slice(0, 3)) {
        const sheet = wb.Sheets[sheetName];
        if (!sheet) continue;
        const csv = String(XLSX.utils.sheet_to_csv(sheet) || '').trim();
        if (!csv) continue;
        // 表头+首行 →「字段：值」，便于 parseOrderDocFields
        const lines = csv.split(/\r?\n/).filter((l) => l.trim());
        const headers = (lines[0] || '').split(',').map((h) => h.trim());
        const values = (lines[1] || '').split(',').map((v) => v.trim());
        const labeled: string[] = [];
        for (let i = 0; i < headers.length; i += 1) {
          const h = headers[i];
          const v = values[i] || '';
          if (h && v) labeled.push(`${h}：${v}`);
        }
        parts.push([`# ${sheetName}`, ...labeled, csv].filter(Boolean).join('\n'));
      }
      const text = parts.join('\n\n').replace(/\u0000/g, ' ').trim().slice(0, 12000);
      if (text) return { text, method: 'xlsx' };
    } catch {
      // xlsx 未安装或解析失败 → 继续走下方弱路径
    }
  }

  // CSV
  if (/\.csv$/i.test(name)) {
    const slice = buffer.toString('utf8', 0, Math.min(buffer.length, 12000));
    const printable = slice.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
    if (printable) return { text: printable.slice(0, 12000), method: 'csv' };
  }

  const isPdf =
    /\.pdf$/i.test(name) ||
    (buffer.length >= 5 && buffer.subarray(0, 5).toString('utf8') === '%PDF-');
  if (isPdf) {
    const normalize = (value: string) =>
      value
        .replace(/\u0000/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .trim()
        .slice(0, 12000);

    // 1) pdf-parse（部分生成器 PDF 会 bad XRef，失败则回退）
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (buf: Buffer) => Promise<{ text?: string }>;
      const parsed = await pdfParse(buffer);
      const text = normalize(String(parsed?.text ?? ''));
      if (text) return { text, method: 'pdf-parse' };
    } catch {
      // continue
    }

    // 2) 本机 pypdf（reportlab 等现网常见生成器更稳）
    try {
      const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { spawn } = await import('node:child_process');
      const dir = await mkdtemp(join(tmpdir(), 'sedric-pdf-'));
      const pdfPath = join(dir, 'in.pdf');
      const outPath = join(dir, 'out.txt');
      await writeFile(pdfPath, buffer);
      const code = await new Promise<number>((resolve) => {
        const child = spawn(
          'python3',
          [
            '-c',
            'from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); t="\n".join((p.extract_text() or "") for p in r.pages); open(sys.argv[2],"w",encoding="utf-8").write(t)',
            pdfPath,
            outPath,
          ],
          { stdio: 'ignore' },
        );
        child.on('error', () => resolve(1));
        child.on('close', (c) => resolve(c ?? 1));
      });
      let text = '';
      if (code === 0) {
        try {
          text = normalize(await readFile(outPath, 'utf8'));
        } catch {
          text = '';
        }
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (text) return { text, method: 'pypdf' };
    } catch {
      // continue
    }

    // 3) 粗暴扫 PDF 字符串字面量（扫描件仍空）
    const raw = buffer.toString('latin1');
    const chunks: string[] = [];
    for (const m of raw.matchAll(/\((?:\\.|[^\\)]){2,200}\)/g)) {
      const inner = m[0].slice(1, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
      if (/[\u4e00-\u9fa5A-Za-z0-9]{2,}/.test(inner)) chunks.push(inner);
    }
    const weak = normalize(
      chunks
        .filter((c) => /[\u4e00-\u9fa5]/.test(c) || /customer|product|quantity|price|order|invoice|delivery|tel|phone|qty|sku/i.test(c))
        .join('\n'),
    );
    return weak ? { text: weak, method: 'utf8_binary_weak' } : { text: '', method: 'none' };
  }

  const looksImage = /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(name);
  if (looksImage) {
    return { text: '', method: 'none' };
  }

  // 文本 / csv / 未知：取前缀，过滤大量控制字符则标 weak
  const slice = buffer.toString('utf8', 0, Math.min(buffer.length, 12000));
  const printable = slice.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  const ctrlRatio = slice.length ? 1 - printable.length / slice.length : 1;
  if (!printable.trim()) return { text: '', method: 'none' };
  if (ctrlRatio > 0.3) return { text: printable.trim().slice(0, 8000), method: 'utf8_binary_weak' };
  return { text: printable.trim().slice(0, 12000), method: 'utf8' };
}

function pick(blob: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = blob.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return '';
}

/** 确定性文本解析（非 OCR） */
export function parseOrderDocFields(filename: string, note: string, textSnippet: string): ContractFields {
  const blob = `${filename}\n${note}\n${textSnippet}`;
  const customer_name =
    pick(blob, [
      /(?:客户名称|客户|买方|购货单位|Customer(?:\s*name)?)[:：\s]*([^\n，,]{2,60})/i,
      /([^\n]{2,40}(?:有限公司|股份|厂|贸易|科技))/,
    ]) || '聊天落单客户';
  const customer_code = pick(blob, [/(?:客户编码|客户编号)[:：\s]*([A-Za-z0-9\-]{2,32})/]);
  const contact_name = pick(blob, [/(?:联系人|收货人)[:：\s]*([^\n，,]{1,40})/]);
  const contact_phone =
    blob.match(/1[3-9]\d{9}/)?.[0] ||
    pick(blob, [/(?:电话|手机)[:：\s]*([0-9\-+\s]{7,20})/]).replace(/\s+/g, '');
  const product_code = pick(blob, [
    /(?:商品编码|产品编码|货号|物料编码|Product\s*code|SKU)[:：\s]*([A-Za-z0-9\-]{2,40})/i,
    /\b(LOCAL\d{3,}|P[-_]?\d{3,}|SKU[-_]?\w+)\b/i,
  ]);
  const product_name =
    pick(blob, [/(?:商品名称|产品名称|品名|物料)[:：\s]*([^\n，,]{2,80})/]) ||
    (product_code ? '' : '未命名商品');
  const quantity =
    pick(blob, [/(?:数量|下单数量|计划数量|qty|Quantity)[:：\s]*([0-9]+(?:\.[0-9]+)?)/i]) || '1';
  const unit_price =
    pick(blob, [/(?:单价|含税单价|售价|价格|Unit\s*price|Price)[:：\s]*([0-9]+(?:\.[0-9]+)?)/i]) || '0';
  const delivery_date = pick(blob, [
    /(?:交货日期|交期|交货日|Delivery(?:\s*date)?)[:：\s]*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
  ]).replace(/\//g, '-');
  const noteField = pick(blob, [/(?:备注|说明)[:：\s]*([^\n]{1,200})/]) || `来自聊天附件 ${filename}`;
  return {
    customer_name: customer_name.slice(0, 80),
    customer_code: customer_code.slice(0, 32),
    customer_id: null,
    contact_name: contact_name.slice(0, 80),
    contact_phone: contact_phone.slice(0, 40),
    product_code: product_code.slice(0, 40),
    product_name: product_name.slice(0, 80),
    product_id: null,
    quantity,
    unit_price,
    delivery_date,
    note: noteField.slice(0, 500),
  };
}

async function resolveCustomer(
  sql: Sql,
  fields: ContractFields,
): Promise<{ id: string; code: string; name: string; matched: boolean }> {
  if (fields.customer_id) {
    const row = (
      await sql.query<{ id: string; code: string; name: string }>(
        'SELECT id, code, name FROM customers WHERE id=$1 AND NOT in_sea',
        [fields.customer_id],
      )
    ).rows[0];
    if (row) return { ...row, matched: true };
  }
  if (fields.customer_code) {
    const row = (
      await sql.query<{ id: string; code: string; name: string }>(
        'SELECT id, code, name FROM customers WHERE code=$1 AND NOT in_sea',
        [fields.customer_code],
      )
    ).rows[0];
    if (row) return { ...row, matched: true };
  }
  if (fields.customer_name) {
    const row = (
      await sql.query<{ id: string; code: string; name: string }>(
        `SELECT id, code, name FROM customers
         WHERE NOT in_sea AND name ILIKE $1
         ORDER BY code LIMIT 1`,
        [fields.customer_name],
      )
    ).rows[0];
    if (row) return { ...row, matched: true };
  }
  return { id: '', code: fields.customer_code, name: fields.customer_name, matched: false };
}

async function resolveProduct(
  sql: Sql,
  fields: ContractFields,
): Promise<{ id: string; code: string; name: string; unit_id: string; unit_name: string } | null> {
  if (fields.product_id) {
    const row = (
      await sql.query<{ id: string; code: string; name: string; unit_id: string; unit_name: string }>(
        `SELECT p.id, p.code, p.name, p.unit_id, coalesce(u.name,'') AS unit_name
         FROM products p LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
         WHERE p.id=$1 AND p.active`,
        [fields.product_id],
      )
    ).rows[0];
    if (row) return row;
  }
  if (fields.product_code) {
    const row = (
      await sql.query<{ id: string; code: string; name: string; unit_id: string; unit_name: string }>(
        `SELECT p.id, p.code, p.name, p.unit_id, coalesce(u.name,'') AS unit_name
         FROM products p LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
         WHERE p.active AND p.code ILIKE $1
         ORDER BY p.code LIMIT 1`,
        [fields.product_code],
      )
    ).rows[0];
    if (row) return row;
  }
  if (fields.product_name) {
    const row = (
      await sql.query<{ id: string; code: string; name: string; unit_id: string; unit_name: string }>(
        `SELECT p.id, p.code, p.name, p.unit_id, coalesce(u.name,'') AS unit_name
         FROM products p LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
         WHERE p.active AND p.name ILIKE '%' || $1 || '%'
         ORDER BY p.code LIMIT 1`,
        [fields.product_name],
      )
    ).rows[0];
    if (row) return row;
  }
  // 兜底：取企业内任一启用商品（本地验收库常有 LOCAL001）
  const any = (
    await sql.query<{ id: string; code: string; name: string; unit_id: string; unit_name: string }>(
      `SELECT p.id, p.code, p.name, p.unit_id, coalesce(u.name,'') AS unit_name
       FROM products p LEFT JOIN units u ON u.tenant_id=p.tenant_id AND u.id=p.unit_id
       WHERE p.active ORDER BY p.code LIMIT 1`,
    )
  ).rows[0];
  return any ?? null;
}

function moneyMul(qty: string, price: string): string {
  const q = Number(qty);
  const p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return '0';
  return (Math.round(q * p * 100) / 100).toFixed(2);
}

async function nextContractCode(sql: Sql, tenantId: string): Promise<string> {
  const period = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await sql.query(
    'INSERT INTO money_counters(tenant_id,series,period,next_value) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING',
    [tenantId, 'HT', period],
  );
  const current = BigInt(
    (
      await sql.query<{ n: string }>(
        'SELECT next_value::text AS n FROM money_counters WHERE series=$1 AND period=$2 FOR UPDATE',
        ['HT', period],
      )
    ).rows[0]!.n,
  );
  await sql.query('UPDATE money_counters SET next_value=$1 WHERE series=$2 AND period=$3', [
    (current + 1n).toString(),
    'HT',
    period,
  ]);
  return `HT${period}${current.toString().padStart(3, '0')}`;
}

export async function buildOrderDocPreview(
  sql: Sql,
  actor: Actor,
  buffer: Buffer,
  filename: string,
  note: string,
): Promise<{
  kind: 'order_doc';
  confidence: number;
  reasons: string[];
  preview_id: string;
  confirm_card: {
    title: string;
    summary: string;
    risk: string;
    actions: Array<'confirm' | 'cancel'>;
    target: 'contract';
    fields: ContractFields;
    chain_work_order_default: false;
  };
  fields: ContractFields;
  line: ContractLineDraft | null;
  warnings: string[];
  forbidden_writes: string[];
  glossary_hits: GlossaryHit[];
}> {
  const extracted = await extractAttachmentText(buffer, filename);
  const fields = parseOrderDocFields(filename, note, extracted.text);
  const glossary_hits = await applyGlossaryToOrderFields(sql, fields);
  const customer = await resolveCustomer(sql, fields);
  const product = await resolveProduct(sql, fields);
  const warnings: string[] = glossary_hits.map((hit) => hit.detail);
  if (extracted.method === 'pdf-parse' || extracted.method === 'pypdf') {
    warnings.push(`已从 PDF 抽出 ${extracted.text.length} 字填入确认卡字段草稿（${extracted.method}）`);
  } else if (extracted.method === 'xlsx') {
    warnings.push(`已从 Excel 抽出 ${extracted.text.length} 字填入确认卡字段草稿（xlsx）`);
  } else if (extracted.method === 'csv') {
    warnings.push(`已从 CSV 抽出 ${extracted.text.length} 字填入确认卡字段草稿`);
  } else if (extracted.method === 'none' && /\.pdf$/i.test(filename)) {
    warnings.push('PDF 未抽出文字（可能是扫描件）；字段主要靠文件名/备注，请人工核对确认卡');
  } else if (extracted.method === 'none' && /\.(xlsx|xls)$/i.test(filename)) {
    warnings.push('Excel 未能解析（依赖未就绪或文件损坏）；请人工核对确认卡，或另存为 CSV/文字层 PDF');
  } else if (extracted.method === 'none') {
    warnings.push('附件几乎无文字可抽；请核对确认卡字段，或在备注里补客户/品名/数量');
  }
  if (!customer.matched) {
    warnings.push('未匹配到现有客户，确认后将按名称新建客户再建合同');
  } else {
    fields.customer_id = customer.id;
    fields.customer_code = customer.code;
    fields.customer_name = customer.name;
  }
  let line: ContractLineDraft | null = null;
  if (product) {
    fields.product_id = product.id;
    fields.product_code = product.code;
    fields.product_name = product.name || fields.product_name;
    const amount = moneyMul(fields.quantity, fields.unit_price);
    line = {
      product_id: product.id,
      product_code: product.code,
      product_name: product.name,
      unit_name: product.unit_name || '个',
      unit_price: fields.unit_price,
      quantity: fields.quantity,
      amount,
    };
  } else {
    warnings.push('企业内无可用商品，确认将失败；请先维护商品主数据');
  }

  const preview: ContractPreview = {
    id: randomUUID(),
    tenant_id: actor.tenant_id,
    actor_id: actor.user_id,
    created_at: Date.now(),
    filename,
    kind: 'order_doc',
    fields,
    line,
    attachment_bytes: buffer,
    attachment_digest: digestBuffer(buffer),
    warnings,
    chain_work_order_default: false,
  };
  contractPreviews.set(preview.id, preview);

  const summary = [
    `客户：${fields.customer_name}${customer.matched ? `（${customer.code}）` : '（将新建）'}`,
    line
      ? `明细：${line.product_name} × ${line.quantity} @ ${line.unit_price} = ¥${line.amount}`
      : '明细：缺少商品，无法落单',
    fields.delivery_date ? `交期：${fields.delivery_date}` : '',
    glossary_hits.length ? `词典：${glossary_hits.map((hit) => hit.detail).join('；')}` : '',
  ]
    .filter(Boolean)
    .join('；');

  return {
    kind: 'order_doc',
    confidence: 0.8,
    reasons: [
      '命中单据类关键词；已生成合同预览（确定性文本解析，非 OCR）',
      `抽字方式：${extracted.method}`,
    ],
    preview_id: preview.id,
    confirm_card: {
      title: '确认写入合同订单',
      summary,
      risk: '确认前不写库。串加工单默认关闭；若需要须在合同写入后再二次确认。',
      actions: ['confirm', 'cancel'],
      target: 'contract',
      fields,
      chain_work_order_default: false,
    },
    fields,
    line,
    warnings,
    glossary_hits,
    forbidden_writes: [],
  };
}

async function ensureCustomer(
  sql: Sql,
  actor: Actor,
  fields: ContractFields,
): Promise<{ id: string; code: string; name: string; created: boolean }> {
  const existing = await resolveCustomer(sql, fields);
  if (existing.matched) return { ...existing, created: false };
  const code =
    fields.customer_code ||
    `AI${Date.now().toString().slice(-8)}`;
  const id = (
    await sql.query<{ id: string }>(
      `INSERT INTO customers(tenant_id,code,name,contact_name,contact_phone,owner_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        actor.tenant_id,
        code,
        fields.customer_name || '聊天落单客户',
        fields.contact_name || '',
        fields.contact_phone || '',
        actor.user_id,
      ],
    )
  ).rows[0]!.id;
  return { id, code, name: fields.customer_name, created: true };
}

async function storeAttachment(
  sql: Sql,
  actor: Actor,
  filename: string,
  bytes: Buffer,
): Promise<string | null> {
  try {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const mime = /\.png$/i.test(filename)
      ? 'image/png'
      : /\.jpe?g$/i.test(filename)
        ? 'image/jpeg'
        : /\.pdf$/i.test(filename)
          ? 'application/pdf'
          : 'text/plain';
    const row = (
      await sql.query<{ id: string }>(
        `INSERT INTO attachments(tenant_id,filename,mime,byte_size,sha256,payload,request_key)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [actor.tenant_id, filename.slice(0, 200), mime, bytes.length, sha256, bytes, randomUUID()],
      )
    ).rows[0];
    await sql
      .query('UPDATE tenant_service_limits SET storage_used_bytes=storage_used_bytes+$1,updated_at=now() WHERE tenant_id=$2', [
        bytes.length,
        actor.tenant_id,
      ])
      .catch(() => undefined);
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export async function confirmContractWrite(
  sql: Sql,
  actor: Actor,
  body: {
    preview_id?: unknown;
    customer_id?: unknown;
    product_id?: unknown;
    chain_work_order?: unknown;
    fields?: unknown;
  },
) {
  if (actor.role !== 'admin' && actor.role !== 'planner') {
    throw new Problem(403, 'FORBIDDEN', '当前角色不能写入合同');
  }
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const preview = getContractPreview(previewId, actor.tenant_id);
  const fields = { ...preview.fields };
  if (typeof body.customer_id === 'string' && body.customer_id.trim()) {
    fields.customer_id = body.customer_id.trim();
  }
  if (typeof body.product_id === 'string' && body.product_id.trim()) {
    fields.product_id = body.product_id.trim();
  }

  const customer = await ensureCustomer(sql, actor, fields);
  const product = await resolveProduct(sql, fields);
  if (!product) throw new Problem(422, 'PRODUCT_REQUIRED', '找不到可用商品，无法创建合同明细');

  const qty = fields.quantity || '1';
  const price = fields.unit_price || '0';
  const amount = moneyMul(qty, price);
  const code = await nextContractCode(sql, actor.tenant_id);
  const delivery = fields.delivery_date || null;

  const contractId = (
    await sql.query<{ id: string }>(
      `INSERT INTO money_contracts(
         tenant_id,code,customer_id,contact_name,contact_phone,address,prepay,amount,qty,
         delivery_date,salesperson_id,tax_included,note,approval,lifecycle,created_by
       ) VALUES($1,$2,$3,$4,$5,'',0,$6,$7,$8,$9,false,$10,'draft','inactive',$11)
       RETURNING id`,
      [
        actor.tenant_id,
        code,
        customer.id,
        fields.contact_name || '',
        fields.contact_phone || '',
        amount,
        qty,
        delivery,
        actor.user_id,
        fields.note || `聊天落单 · ${preview.filename}`,
        actor.user_id,
      ],
    )
  ).rows[0]!.id;

  const lineId = (
    await sql.query<{ id: string }>(
      `INSERT INTO money_contract_lines(
         tenant_id,contract_id,line_no,product_id,product_name,product_code,specification,unit_name,source,
         unit_price,quantity,discount,concession,amount,net_amount,note
       ) VALUES($1,$2,1,$3,$4,$5,'',$6,'自产',$7,$8,10,0,$9,$9,$10)
       RETURNING id`,
      [
        actor.tenant_id,
        contractId,
        product.id,
        product.name,
        product.code,
        product.unit_name || '个',
        price,
        qty,
        amount,
        '',
      ],
    )
  ).rows[0]!.id;

  const attachmentId = await storeAttachment(sql, actor, preview.filename, preview.attachment_bytes);
  contractPreviews.delete(preview.id);

  // 串加工单默认关：仅当显式要求时生成「二次确认」预览，本步不写加工单
  const wantChain = body.chain_work_order === true;
  let chain_preview_id: string | null = null;
  let chain_confirm_card: Record<string, unknown> | null = null;
  if (wantChain) {
    const wh = (
      await sql.query<{ id: string }>('SELECT id FROM warehouses ORDER BY code LIMIT 1')
    ).rows[0];
    const chain: ChainWoPreview = {
      id: randomUUID(),
      tenant_id: actor.tenant_id,
      actor_id: actor.user_id,
      created_at: Date.now(),
      contract_id: contractId,
      contract_code: code,
      contract_line_id: lineId,
      product_id: product.id,
      unit_id: product.unit_id,
      plan_qty: qty,
      warehouse_id: wh?.id ?? null,
    };
    chainPreviews.set(chain.id, chain);
    chain_preview_id = chain.id;
    chain_confirm_card = {
      title: '二次确认：串加工单',
      summary: `将按合同 ${code} 明细创建加工单（数量 ${qty} · ${product.name}）。确认前不写加工单。`,
      risk: '此为第二次确认；取消则只保留合同，不创建加工单。',
      actions: ['confirm', 'cancel'],
      target: 'work_order_from_contract',
    };
  }

  return {
    kind: 'contract' as const,
    contract_id: contractId,
    contract_code: code,
    contract_line_id: lineId,
    customer_id: customer.id,
    customer_created: customer.created,
    product_id: product.id,
    amount,
    quantity: qty,
    attachment_id: attachmentId,
    created_work_order: false,
    chain_work_order_default: false,
    chain_preview_id,
    chain_confirm_card,
  };
}

export async function confirmChainWorkOrderWrite(
  sql: Sql,
  actor: Actor,
  body: { preview_id?: unknown },
) {
  if (actor.role !== 'admin' && actor.role !== 'planner') {
    throw new Problem(403, 'FORBIDDEN', '当前角色不能创建加工单');
  }
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const preview = peekChainWoPreview(previewId, actor.tenant_id);
  if (!preview) throw new Problem(404, 'PREVIEW_NOT_FOUND', '串加工单预览已失效');

  const product = (
    await sql.query<{ id: string; code: string; name: string; unit_id: string; specification: string | null }>(
      'SELECT id, code, name, unit_id, specification FROM products WHERE id=$1 AND active',
      [preview.product_id],
    )
  ).rows[0];
  if (!product) throw new Problem(422, 'PRODUCT_REQUIRED', '商品不存在');

  let warehouseId = preview.warehouse_id;
  if (!warehouseId) {
    warehouseId =
      (await sql.query<{ id: string }>('SELECT id FROM warehouses ORDER BY code LIMIT 1')).rows[0]?.id ?? null;
  }
  if (!warehouseId) throw new Problem(422, 'WAREHOUSE_REQUIRED', '没有可用仓库，无法串加工单');

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '').slice(2);
  const code = `WOAI${stamp}${Math.floor(Math.random() * 900 + 100)}`;
  const id = (
    await sql.query<{ id: string }>(
      `INSERT INTO work_orders(
         tenant_id,code,product_id,unit_id,plan_qty,sales_order_id,sales_line_id,contract_id,contract_line_id,
         route_version_id,bom_version_id,warehouse_id,product_snapshot,route_name_snapshot,bom_revision,
         requires_fg_inspection,created_by,priority,due_date,planned_start,planned_end,note,production_plan_line_id
       ) VALUES($1,$2,$3,$4,$5,null,null,$6,$7,null,null,$8,$9::jsonb,'',null,false,$10,'none',null,null,null,$11,null)
       RETURNING id`,
      [
        actor.tenant_id,
        code,
        product.id,
        product.unit_id,
        preview.plan_qty,
        preview.contract_id,
        preview.contract_line_id,
        warehouseId,
        JSON.stringify({
          id: product.id,
          code: product.code,
          name: product.name,
          specification: product.specification ?? '',
        }),
        actor.user_id,
        `聊天串加工单 · 合同 ${preview.contract_code}`,
      ],
    )
  ).rows[0]!.id;

  chainPreviews.delete(preview.id);
  return {
    kind: 'work_order_from_contract' as const,
    work_order_id: id,
    work_order_code: code,
    contract_id: preview.contract_id,
    contract_code: preview.contract_code,
  };
}
