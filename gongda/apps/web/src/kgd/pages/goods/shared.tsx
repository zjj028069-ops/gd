import { useEffect, useState } from 'react';
import { apiRequest, canWriteProducts } from '../../../api';
import type { Session } from '../../../api';
import { requestKey } from '../../../requestKey';

export const sourceOptions = ['自产', '外协加工', '外购'] as const;
export const hints = {
  commission: '百分比仅供快捷计算使用。佣金互算只认销售单价，请先填写销售单价。',
  source: '外购：外购成品或物料；自产：本厂生产；外协加工：委外加工。',
  stale: '在设置的天数内，该商品未产生流水信息，则视为呆滞物料（值为0时不进行统计）。',
  upper: '设置该商品在仓库中的默认库存上限的警告值。',
  lower: '设置该商品在仓库中的默认库存下限的警告值。',
};

export type Category = { id: string; parent_id: string | null; kind: string; name: string; sort: number };
export type CategoryNode = Category & { children: CategoryNode[] };
export type GoodsView = { id: string; name: string; category_name: string | null; sort: number; builtin: boolean; version: number };
export type CodeElement = { type: 'fixed' | 'date' | 'empty'; text?: string; date_format?: 'ymd' | 'ym' | 'y'; short_year?: boolean; separator?: '' | '-' };
export type CodeRule = { id: string; name: string; sort: number; version: number; config: { elements: CodeElement[]; seq_digits: number; seq_start: number; show_abbrev: boolean }; formula: string; preview: string };

export function buildTree(items: Category[]) {
  const nodes = items.map((item) => ({ ...item, children: [] as CategoryNode[] }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots: CategoryNode[] = [];
  nodes.forEach((node) => {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  return roots;
}

export function flattenTree(nodes: CategoryNode[], depth = 0): { node: CategoryNode; depth: number; index: number; count: number }[] {
  return nodes.flatMap((node, index) => [{ node, depth, index, count: nodes.length }, ...flattenTree(node.children, depth + 1)]);
}

let catalogOnce: Promise<void> | null = null;
export function ensureGoodsCatalog(session: Session) {
  if (!canWriteProducts(session)) return Promise.resolve();
  catalogOnce ??= apiRequest('/api/products/catalog-defaults', { method: 'POST', csrfToken: session.csrf_token, body: {} }).then(() => undefined).catch((error: unknown) => {
    catalogOnce = null;
    throw error;
  });
  return catalogOnce;
}

function elementValue(element: CodeElement, now: Date) {
  if (element.type === 'empty') return '';
  if (element.type === 'fixed') return element.text ?? '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const year = element.short_year ? read('year').slice(2) : read('year');
  if (element.date_format === 'y') return year;
  if (element.date_format === 'ym') return year + read('month');
  return year + read('month') + read('day');
}

export function ruleFormulaText(name: string, config: CodeRule['config']) {
  const parts: string[] = [];
  config.elements.forEach((element, index) => {
    if (element.type === 'fixed' && element.text) parts.push(element.text);
    if (element.type === 'date') parts.push(element.date_format === 'ym' ? '年月' : element.date_format === 'y' ? '年' : '年月日');
    if (index < 3 && element.separator === '-' && elementValue(config.elements[index + 1]!, new Date())) parts.push('-');
  });
  if (config.elements[3]?.separator === '-') parts.push('-');
  parts.push('流水号');
  return `${name}=${parts.join('+')}`;
}

export function rulePreviewText(config: CodeRule['config'], now = new Date()) {
  let body = '';
  for (let index = 0; index < 3; index += 1) {
    const element = config.elements[index]!;
    const value = elementValue(element, now);
    if (!value) continue;
    body += value;
    const next = elementValue(config.elements[index + 1]!, now);
    if (next && element.separator === '-') body += '-';
  }
  const last = config.elements[3]!;
  body += elementValue(last, now);
  const sequence = config.seq_start;
  const width = config.show_abbrev ? 0 : Math.max(config.seq_digits, String(sequence).length);
  const serial = config.show_abbrev ? String(sequence) : String(sequence).padStart(width, '0');
  return body + (last.separator === '-' ? '-' : '') + serial;
}

export function todayText() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function decimalInput(value: string, scale = 5) {
  const cleaned = value.replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  if (!rest.length) return whole ?? '';
  return `${whole ?? ''}.${rest.join('').slice(0, scale)}`;
}

function parseDecimal(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return { digits: BigInt((whole || '0') + fraction), scale: fraction.length };
}

/** 销售单价为空或 0 时不参与佣金互算。 */
export function positivePrice(value: string) {
  if (!value || value === '.') return false;
  const normalized = value.endsWith('.') ? value.slice(0, -1) : value;
  if (!normalized) return false;
  return !/^0+(?:\.0+)?$/.test(normalized);
}

export function mulPercent(price: string, percent: string) {
  if (!positivePrice(price) || !percent) return '';
  const left = parseDecimal(price);
  const right = parseDecimal(percent);
  const scale = left.scale + right.scale + 2;
  const digits = (left.digits * right.digits).toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, digits.length - scale).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

/** 佣金比例 = 佣金元 / 销售单价 × 100。销售单价为空或 0 时返回空串。 */
export function rateFromAmount(price: string, amount: string) {
  if (!positivePrice(price) || amount === '') return '';
  const yuan = parseDecimal(amount);
  const sale = parseDecimal(price);
  if (sale.digits === 0n) return '';
  const extra = 8;
  const numerator = yuan.digits * 100n * (10n ** BigInt(sale.scale + extra));
  const denominator = sale.digits * (10n ** BigInt(yuan.scale));
  const rounded = (numerator + denominator / 2n) / denominator;
  const text = rounded.toString().padStart(extra + 1, '0');
  const integer = text.slice(0, text.length - extra).replace(/^0+(?=\d)/, '');
  const fraction = text.slice(text.length - extra).replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

export function showMoney(value?: string | null) {
  return value ?? '';
}

export async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function allowedMime(file: File, image: boolean) {
  if (file.type === 'image/png' || file.type === 'image/jpeg') return file.type;
  if (!image && (file.type === 'application/pdf' || file.type === 'text/plain')) return file.type;
  return '';
}

export async function uploadAttachment(session: Session, productId: string, file: File, mime: string) {
  return apiRequest<{ attachment: { id: string; filename: string; mime: string } }>('/api/attachments', {
    method: 'POST',
    csrfToken: session.csrf_token,
    body: { resource_type: 'product', resource_id: productId, filename: file.name || '未命名', mime, content_base64: await fileBase64(file), request_key: requestKey() },
  });
}

export function AttachmentImage({ id, size = 36 }: { id: string; size?: number }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    let object = '';
    void fetch(`/api/attachments/${id}/content`, { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) return;
      object = URL.createObjectURL(await response.blob());
      if (alive) setUrl(object);
    });
    return () => { alive = false; if (object) URL.revokeObjectURL(object); };
  }, [id]);
  return url ? <img src={url} alt="" style={{ width: size, height: size, objectFit: 'cover' }} /> : null;
}

export async function qrBlob(text: string, lines: string[]) {
  const qr = await import('qrcode');
  const canvas = document.createElement('canvas');
  await qr.toCanvas(canvas, text, { margin: 1, width: 240 });
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height + lines.length * 22 + 12;
  const context = out.getContext('2d');
  if (!context) throw new Error('无法生成二维码');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, out.width, out.height);
  context.drawImage(canvas, 0, 0);
  context.fillStyle = '#222';
  context.font = '14px sans-serif';
  context.textAlign = 'center';
  lines.forEach((line, index) => context.fillText(line, out.width / 2, canvas.height + 20 + index * 22));
  return new Promise<Blob>((resolve) => out.toBlob((blob) => resolve(blob!), 'image/png'));
}
