export type PrintField = [label: string, value: string];

export type PrintDoc = {
  title: string;
  fields: PrintField[];
  columns?: string[];
  rows?: string[][];
  footer?: PrintField[];
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function cell(value: string | null | undefined) {
  const text = value === null || value === undefined || value === '' ? '-' : String(value);
  return escapeHtml(text);
}

function printedAt() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
}

function docHtml(doc: PrintDoc) {
  const fields = doc.fields.map(([label, value]) => `<div class="f"><b>${cell(label)}：</b><span>${cell(value)}</span></div>`).join('');
  const table = doc.columns?.length ? `<table><thead><tr>${doc.columns.map((column) => `<th>${cell(column)}</th>`).join('')}</tr></thead><tbody>${(doc.rows ?? []).length ? (doc.rows ?? []).map((row) => `<tr>${doc.columns!.map((_, index) => `<td>${cell(row[index])}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${doc.columns.length}" class="empty">暂无数据</td></tr>`}</tbody></table>` : '';
  const footer = (doc.footer ?? []).map(([label, value]) => `<div class="f"><b>${cell(label)}：</b><span>${cell(value)}</span></div>`).join('');
  return `<section class="page"><h1>${cell(doc.title)}</h1><div class="fields">${fields}</div>${table}<div class="fields foot">${footer}<div class="f"><b>打印时间：</b><span>${cell(printedAt())}</span></div></div></section>`;
}

const style = `
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; color: #222; margin: 0; background: #f2f3f5; }
.bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e6eb; padding: 10px 16px; display: flex; gap: 8px; justify-content: flex-end; }
.bar button { background: #4184F4; color: #fff; border: 0; padding: 6px 18px; border-radius: 2px; cursor: pointer; font-size: 14px; }
.bar button.plain { background: #fff; color: #333; border: 1px solid #d9d9d9; }
.page { width: 210mm; min-height: 270mm; margin: 12px auto; background: #fff; padding: 12mm; page-break-after: always; }
.page:last-child { page-break-after: auto; }
h1 { text-align: center; font-size: 20px; margin: 0 0 12px; }
.fields { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 12px; font-size: 12px; margin-bottom: 10px; }
.foot { margin-top: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
th { background: #f5f5f5; }
.empty { text-align: center; color: #999; }
@media print { body { background: #fff; } .bar { display: none; } .page { margin: 0; width: auto; min-height: auto; padding: 0; } }
`;

export function printDocs(docs: PrintDoc[], windowTitle = docs[0]?.title ?? '打印预览') {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${cell(windowTitle)}</title><style>${style}</style></head><body><div class="bar"><button class="plain" onclick="window.close()">关闭</button><button onclick="window.print()">打印</button></div>${docs.map(docHtml).join('')}</body></html>`);
  win.document.close();
  win.focus();
  return true;
}

export function printDoc(doc: PrintDoc) {
  return printDocs([doc]);
}

export type LayoutBlock = {
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

export type LayoutDoc = {
  paper: 'A4' | 'A5';
  margin_mm: number;
  blocks: LayoutBlock[];
  builtin?: boolean;
  footer_on?: boolean;
  flow?: import('./flow').FlowNode[];
  footer?: import('./flow').FlowNode[];
};

function fieldValue(doc: PrintDoc, label: string) {
  return doc.fields.find(([name]) => name === label)?.[1] ?? '';
}

function blockHtml(block: LayoutBlock, doc: PrintDoc) {
  const box = `left:${block.x}mm;top:${block.y}mm;width:${block.w}mm;height:${block.h}mm`;
  if (block.type === 'text') return `<div class="blk" style="${box}">${cell(block.text ?? '')}</div>`;
  if (block.type === 'field') return `<div class="blk" style="${box}"><b>${cell(block.field ?? '')}：</b><span>${cell(fieldValue(doc, block.field ?? ''))}</span></div>`;
  const columns = block.columns ?? [];
  const header = columns.map((column) => `<th>${cell(column)}</th>`).join('');
  const rows = doc.columns?.length && doc.rows?.length
    ? doc.rows.map((row) => `<tr>${columns.map((column) => `<td>${cell(row[doc.columns!.indexOf(column)] ?? '')}</td>`).join('')}</tr>`).join('')
    : `<tr>${columns.map((column) => `<td>${cell(fieldValue(doc, column))}</td>`).join('')}</tr>`;
  return `<div class="blk" style="${box}"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const layoutStyle = `
${style}
.bar { justify-content: space-between; align-items: center; }
.bar span { margin-right: auto; color: #333; font-size: 14px; }
.sheet { position: relative; }
.blk { position: absolute; overflow: hidden; font-size: 12px; }
`;

/** 按设计器保存的版式打印。系统默认模板仍走 printDocs。 */
export function printLayout(docs: PrintDoc[], layout: LayoutDoc, windowTitle = docs[0]?.title ?? '打印预览') {
  const win = window.open('', '_blank');
  if (!win) return false;
  const pageW = layout.paper === 'A5' ? 148 : 210;
  const pageH = layout.paper === 'A5' ? 210 : 297;
  const pages = docs.map((doc) => `<section class="page" style="width:${pageW}mm;min-height:${pageH}mm;padding:${layout.margin_mm}mm"><div class="sheet" style="height:${Math.max(40, pageH - layout.margin_mm * 2)}mm">${layout.blocks.map((block) => blockHtml(block, doc)).join('')}</div></section>`).join('');
  win.document.open();
  win.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${cell(windowTitle)}</title><style>${layoutStyle}</style></head><body><div class="bar"><span>模板：${cell(windowTitle)}</span><button class="plain" onclick="window.close()">关闭</button><button onclick="window.print()">打印</button></div>${pages}</body></html>`);
  win.document.close();
  win.focus();
  return true;
}

type Plain = Record<string, unknown>;
const textOf = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'object' ? '' : String(value);

/** 从列表行生成默认 A4 单据：表头字段取 [标签, 字段名]，明细取 row[linesKey]。 */
export function recordDoc(title: string, row: Plain, fields: [string, string][], lines?: { key: string; columns: [string, string][] }): PrintDoc {
  const items = lines && Array.isArray(row[lines.key]) ? row[lines.key] as Plain[] : [];
  return {
    title,
    fields: fields.map(([label, key]) => [label, textOf(row[key])]),
    ...(lines ? { columns: ['序号', ...lines.columns.map(([label]) => label)], rows: items.map((item, index) => [String(index + 1), ...lines.columns.map(([, key]) => textOf(item[key]))]) } : {}),
  };
}
