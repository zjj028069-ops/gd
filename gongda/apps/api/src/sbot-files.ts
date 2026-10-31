// Bot 模式的拖拽上传：在 MES 这边把文件读成文字，只把文字交给 Bot。
// 原文件不落盘、不转给 Bot，Bot 也拿不到任何文件路径。
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import * as XLSX from 'xlsx';
import { Problem } from './services.js';

const require = createRequire(import.meta.url);
// pdf-parse 是 CJS；和 ai/bom.ts 一样用 createRequire 引入
const pdfParse = require('pdf-parse') as (buf: Buffer, options?: { max?: number }) => Promise<{ text?: string; numpages?: number }>;

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT = 40_000;
const MAX_ROWS = 500;
const MAX_PAGES = 30;

export type FileText = { name: string; kind: 'pdf' | 'excel' | 'csv' | 'text'; size: number; text: string; truncated: boolean; summary: string };

const textExt = new Set(['txt', 'md', 'csv', 'json', 'tsv']);

function isPdf(buf: Buffer) { return buf.subarray(0, 5).toString('latin1') === '%PDF-'; }
function isZip(buf: Buffer) { return buf[0] === 0x50 && buf[1] === 0x4b; }
function isOle(buf: Buffer) { return buf.subarray(0, 4).toString('hex') === 'd0cf11e0'; }

function clip(text: string) {
  const clean = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > MAX_TEXT ? { text: clean.slice(0, MAX_TEXT), truncated: true } : { text: clean, truncated: false };
}

/** 把上传的文件读成文字。不认识/读不出文字的文件直接拒绝，给出能看懂的原因。 */
export async function extractFileText(filename: string, buffer: Buffer): Promise<FileText> {
  const name = (filename || '附件').replace(/[\r\n\t]/g, ' ').slice(-120);
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (!buffer.length) throw new Problem(422, 'FILE_EMPTY', `「${name}」是空文件`);
  if (buffer.length > MAX_FILE_BYTES) throw new Problem(413, 'FILE_TOO_LARGE', `「${name}」超过 10MB`);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) throw new Problem(415, 'FILE_IMAGE', `暂时读不了图片「${name}」，请上传 PDF 或 Excel`);
  if (['doc', 'docx', 'ppt', 'pptx'].includes(ext)) throw new Problem(415, 'FILE_OFFICE', `暂时读不了 Word/PPT「${name}」，请另存为 PDF 后再上传`);

  if (ext === 'pdf') {
    if (!isPdf(buffer)) throw new Problem(415, 'FILE_BAD', `「${name}」不是有效的 PDF`);
    let parsed: { text?: string; numpages?: number };
    try { parsed = await pdfParse(buffer, { max: MAX_PAGES }); } catch { throw new Problem(422, 'FILE_UNREADABLE', `「${name}」打不开，可能已损坏或加了密码`); }
    const body = clip(parsed.text ?? '');
    if (body.text.length < 10) throw new Problem(422, 'FILE_NO_TEXT', `「${name}」里没有可读的文字（可能是扫描件/图片），请上传带文字的 PDF 或 Excel`);
    const pages = parsed.numpages ?? 0;
    return { name, kind: 'pdf', size: buffer.length, ...body, truncated: body.truncated || pages > MAX_PAGES, summary: `PDF · ${pages} 页${pages > MAX_PAGES ? `（只读了前 ${MAX_PAGES} 页）` : ''}` };
  }

  if (['xlsx', 'xls', 'xlsm'].includes(ext)) {
    if (!(isZip(buffer) || isOle(buffer))) throw new Problem(415, 'FILE_BAD', `「${name}」不是有效的 Excel 文件`);
    let book: XLSX.WorkBook;
    try { book = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, sheetRows: MAX_ROWS + 1 }); }
    catch { throw new Problem(422, 'FILE_UNREADABLE', `「${name}」打不开，可能已损坏或加了密码`); }
    const parts: string[] = [];
    let rows = 0;
    for (const sheetName of book.SheetNames.slice(0, 10)) {
      const sheet = book.Sheets[sheetName];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
      if (!csv) continue;
      rows += csv.split('\n').length;
      parts.push(`## 工作表：${sheetName}\n${csv}`);
    }
    const body = clip(parts.join('\n\n'));
    if (!body.text) throw new Problem(422, 'FILE_NO_TEXT', `「${name}」里没有数据`);
    return { name, kind: 'excel', size: buffer.length, ...body, summary: `Excel · ${parts.length} 个工作表 · ${rows} 行` };
  }

  if (textExt.has(ext)) {
    const body = clip(buffer.toString('utf8'));
    if (!body.text) throw new Problem(422, 'FILE_NO_TEXT', `「${name}」是空的`);
    return { name, kind: ext === 'csv' || ext === 'tsv' ? 'csv' : 'text', size: buffer.length, ...body, summary: `${ext.toUpperCase()} · ${body.text.split('\n').length} 行` };
  }

  throw new Problem(415, 'FILE_TYPE', `不支持「${name}」这种文件，可以上传 PDF、Excel（xlsx/xls）、CSV 或 TXT`);
}

/** POST /api/sbot/files：读文件，返回文字（前端随下一条消息一起发给 Bot）。 */
export function registerSbotFiles(app: FastifyInstance, guard: ReturnType<import('./services.js').Services['authorize']>) {
  void app.register(async (scoped) => {
    await scoped.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 2 } });
    scoped.post('/api/sbot/files', { preHandler: guard, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
      const part = await request.file().catch(() => undefined);
      if (!part) throw new Problem(422, 'FILE_REQUIRED', '请选择要上传的文件');
      let buffer: Buffer;
      try { buffer = await part.toBuffer(); } catch { throw new Problem(413, 'FILE_TOO_LARGE', `「${part.filename}」超过 10MB`); }
      if (part.file.truncated) throw new Problem(413, 'FILE_TOO_LARGE', `「${part.filename}」超过 10MB`);
      return { file: await extractFileText(part.filename, buffer) };
    });
  });
}
