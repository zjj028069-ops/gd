export type FlowRun = {
  text: string;
  field?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  color?: string;
  bg?: string;
};

export type FlowNode =
  | { id: string; type: 'paragraph'; align?: 'left' | 'center' | 'right'; runs: FlowRun[] }
  | { id: string; type: 'table'; source: '' | '出库明细' | '退货明细'; columns: string[] }
  | { id: string; type: 'image'; src: string };

export type FieldGroup = { title: string; kind: 'field' | 'table'; items: string[] };

export const OUTBOUND_COLUMNS = ['序号', '销售出库单号', '仓库', '合同编号', '出库日期', '发货人', '商品名', '商品编号', '商品规格', '销售单价', '销售单价(大写)', '销售金额', '销售金额(大写)', '数量', '单位', '备注', '商品.颜色描述'];
export const RETURN_COLUMNS = ['序号', '销售退货单号', '销售出库单号', '仓库', '退货日期', '商品名', '商品编号', '商品规格', '销售单价', '销售单价(大写)', '销售金额', '销售金额(大写)', '数量', '单位', '备注', '商品.颜色描述'];

export const STATEMENT_GROUPS: FieldGroup[] = [
  { title: '基础字段', kind: 'field', items: ['客户编号', '客户', '客户标签', '联系人', '联系电话', '地址', '负责人', '出库数', '已收款', '已收款(大写)', '欠款', '欠款(大写)', '出库金额', '出库金额(大写)', '退货金额', '退货金额(大写)', '合同数量', '商品数量', '未出库数', '合同金额', '合同金额(大写)', '未开票', '未开票(大写)', '累计开票', '累计开票(大写)'] },
  { title: '表格字段', kind: 'table', items: ['出库明细', '退货明细'] },
  { title: '出库明细', kind: 'field', items: OUTBOUND_COLUMNS },
  { title: '退货明细', kind: 'field', items: RETURN_COLUMNS },
  { title: '其他字段', kind: 'field', items: ['当前时间', '当前登录人姓名', '当前企业名称', '统计周期'] },
];

export type FlowContext = {
  values: Record<string, string>;
  tables: Record<string, Array<Record<string, string>>>;
};

type Loose = Record<string, unknown>;

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const UNITS = ['', '拾', '佰', '仟'];

function four(value: number) {
  let out = '';
  let zero = false;
  for (let index = 0; index < 4; index += 1) {
    const digit = Math.floor(value / 10 ** (3 - index)) % 10;
    if (digit === 0) zero = out.length > 0;
    else {
      if (zero) out += '零';
      zero = false;
      out += DIGITS[digit] + UNITS[3 - index];
    }
  }
  return out;
}

export function rmbUpper(value: string) {
  const raw = String(value ?? '').replace(/,/g, '').trim();
  if (!raw || raw === '-' || Number.isNaN(Number(raw))) return '';
  const negative = raw.startsWith('-');
  const abs = Math.abs(Number(raw));
  if (!Number.isFinite(abs)) return '';
  const cents = Math.round(abs * 100);
  if (cents === 0) return '零元整';
  const yuan = Math.floor(cents / 100);
  const jiao = Math.floor((cents % 100) / 10);
  const fen = cents % 10;
  const groups = [yuan % 10000, Math.floor(yuan / 10000) % 10000, Math.floor(yuan / 100000000) % 10000];
  let upper = '';
  let pending = false;
  for (let index = 2; index >= 0; index -= 1) {
    if (!groups[index]) {
      if (upper) pending = true;
      continue;
    }
    if (pending || (upper && groups[index] < 1000)) upper += '零';
    pending = false;
    upper += four(groups[index]) + ['', '万', '亿'][index];
  }
  let out = yuan ? `${upper}元` : '';
  if (!jiao && !fen) out += yuan ? '整' : '零元整';
  else {
    if (yuan && !jiao) out += '零';
    if (jiao) out += `${DIGITS[jiao]}角`;
    if (fen) out += `${DIGITS[fen]}分`;
  }
  return `${negative ? '负' : ''}${out}`;
}

function textOf(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  const text = String(value).trim();
  return text === '-' ? '' : text;
}

function sumAmount(rows: Array<Record<string, string>>, key: string) {
  const total = rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
  if (!rows.length) return '';
  return Number.isInteger(total) ? String(total) : String(Math.round(total * 100) / 100);
}

function nowText() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
}

function lineMap(row: Record<string, string>, index: number, kind: 'outbound' | 'return') {
  const price = textOf(row.unit_price);
  const amount = textOf(row.sale_amount);
  return {
    序号: String(index + 1),
    销售出库单号: textOf(row.shipment_code),
    销售退货单号: textOf(row.return_code),
    仓库: textOf(row.warehouse_name),
    合同编号: textOf(row.contract_code),
    出库日期: textOf(row.ship_date),
    退货日期: textOf(row.return_date),
    发货人: textOf(row.shipper_name),
    商品名: textOf(row.product_name),
    商品编号: textOf(row.product_code),
    商品规格: textOf(row.specification),
    销售单价: price,
    '销售单价(大写)': rmbUpper(price),
    销售金额: amount,
    '销售金额(大写)': rmbUpper(amount),
    数量: textOf(row.quantity),
    单位: textOf(row.unit_name),
    备注: textOf(row.note),
    '商品.颜色描述': textOf(row.color_desc),
    ...(kind === 'return' ? {} : {}),
  };
}

export function buildStatementContext(row: Loose, outbound: Array<Record<string, string>>, returns: Array<Record<string, string>>, extra: { period: string; user: string; company: string }): FlowContext {
  const received = textOf(row.received);
  const debt = textOf(row.debt);
  const outboundAmount = textOf(row.outbound_amount) || sumAmount(outbound, 'sale_amount');
  const returnAmount = textOf(row.return_amount) || sumAmount(returns, 'sale_amount');
  const amount = textOf(row.amount);
  const uninvoiced = textOf(row.uninvoiced);
  const invoiced = textOf(row.invoiced);
  const values: Record<string, string> = {
    客户编号: textOf(row.customer_code),
    客户: textOf(row.customer_name),
    客户标签: textOf(row.customer_tag) || textOf(row.tags),
    联系人: textOf(row.contact_name),
    联系电话: textOf(row.contact_phone),
    联系人电话: textOf(row.contact_phone),
    地址: textOf(row.address),
    负责人: textOf(row.owner_name),
    出库数: textOf(row.outbound_qty),
    已收款: received,
    '已收款(大写)': rmbUpper(received),
    欠款: debt,
    '欠款(大写)': rmbUpper(debt),
    出库金额: outboundAmount,
    '出库金额(大写)': rmbUpper(outboundAmount),
    退货金额: returnAmount,
    '退货金额(大写)': rmbUpper(returnAmount),
    合同数量: textOf(row.contract_count),
    商品数量: textOf(row.qty) || textOf(row.product_qty),
    未出库数: textOf(row.unoutbound_qty),
    合同金额: amount,
    '合同金额(大写)': rmbUpper(amount),
    未开票: uninvoiced,
    '未开票(大写)': rmbUpper(uninvoiced),
    累计开票: invoiced,
    '累计开票(大写)': rmbUpper(invoiced),
    当前时间: nowText(),
    当前登录人姓名: extra.user,
    当前企业名称: extra.company,
    统计周期: extra.period,
  };
  const outboundRows = outbound.map((item, index) => lineMap(item, index, 'outbound'));
  const returnRows = returns.map((item, index) => lineMap(item, index, 'return'));
  const first = outboundRows[0] ?? returnRows[0];
  if (first) {
    for (const [key, value] of Object.entries(first)) {
      if (!values[key]) values[key] = value;
    }
  }
  return { values, tables: { 出库明细: outboundRows, 退货明细: returnRows } };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function runHtml(run: FlowRun, values?: Record<string, string>) {
  const raw = run.field ? (values ? values[run.field] ?? '' : run.field) : run.text;
  let html = escapeHtml(raw);
  if (run.field && !values) html = `<span class="pf-chip" contenteditable="false" data-field="${escapeHtml(run.field)}">${html}</span>`;
  if (run.bold) html = `<b>${html}</b>`;
  if (run.italic) html = `<i>${html}</i>`;
  if (run.strike) html = `<s>${html}</s>`;
  if (run.color || run.bg) {
    const style = `${run.color ? `color:${run.color};` : ''}${run.bg ? `background-color:${run.bg};` : ''}`;
    html = `<span style="${style}">${html}</span>`;
  }
  return html;
}

export function editorHtml(nodes: FlowNode[]) {
  if (!nodes.length) return '<p><br></p>';
  return nodes.map((node) => {
    if (node.type === 'paragraph') {
      const align = node.align && node.align !== 'left' ? ` style="text-align:${node.align}"` : '';
      return `<p data-id="${escapeHtml(node.id)}"${align}>${node.runs.map((run) => runHtml(run)).join('') || '<br>'}</p>`;
    }
    if (node.type === 'image') return `<img data-id="${escapeHtml(node.id)}" class="pf-img" alt="" src="${escapeHtml(node.src)}" />`;
    const head = node.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
    return `<table class="pf-table" contenteditable="false" data-id="${escapeHtml(node.id)}" data-source="${escapeHtml(node.source)}"><thead><tr>${head}</tr></thead><tbody><tr><td colspan="${node.columns.length}">明细在预览中展开</td></tr></tbody></table>`;
  }).join('');
}

export function previewHtml(nodes: FlowNode[], ctx: FlowContext) {
  if (!nodes.length) return '';
  return nodes.map((node) => {
    if (node.type === 'paragraph') {
      const align = node.align && node.align !== 'left' ? ` style="text-align:${node.align}"` : '';
      return `<p${align}>${node.runs.map((run) => runHtml(run, ctx.values)).join('')}</p>`;
    }
    if (node.type === 'image') return `<img class="pf-img" alt="" src="${escapeHtml(node.src)}" />`;
    const rows = node.source ? ctx.tables[node.source] ?? [] : [ctx.values];
    const body = rows.length
      ? rows.map((row) => `<tr>${node.columns.map((column) => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${node.columns.length}">暂无数据</td></tr>`;
    return `<table class="pf-table"><thead><tr>${node.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  }).join('');
}

export function paperLabel(paper: 'A4' | 'A5') {
  return paper === 'A5' ? '纸张 A5 14.8cm*21cm' : '纸张 A4 21cm*29.7cm';
}

type BlockLike = { id: string; type: string; text?: string; field?: string; columns?: string[] };

export function blocksToFlow(blocks: BlockLike[]): FlowNode[] {
  return blocks.map((block) => {
    if (block.type === 'field' && block.field) return { id: block.id, type: 'paragraph', runs: [{ text: block.field, field: block.field }] };
    if (block.type === 'table') return { id: block.id, type: 'table', source: '', columns: block.columns ?? [] };
    return { id: block.id, type: 'paragraph', runs: [{ text: block.text || '文本' }] };
  });
}

const previewStyle = `
body { margin: 0; background: #f2f3f5; color: #222; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; }
.bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e6eb; padding: 10px 16px; display: flex; gap: 8px; align-items: center; }
.bar span { margin-right: auto; }
.bar small { color: #666; font-size: 12px; }
.bar button { background: #4184F4; color: #fff; border: 0; padding: 6px 18px; border-radius: 2px; cursor: pointer; }
.bar button.plain { background: #fff; color: #333; border: 1px solid #d9d9d9; }
.page { width: 210mm; min-height: 270mm; margin: 12px auto; background: #fff; padding: 12mm; }
.page p { margin: 0 0 8px; font-size: 14px; line-height: 1.7; }
.pf-table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 8px 0; }
.pf-table th, .pf-table td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
.pf-table th { background: #f5f5f5; }
.pf-img { max-width: 160px; }
.foot { margin-top: 16px; border-top: 1px dashed #ddd; padding-top: 8px; }
@media print { .bar { display: none; } body { background: #fff; } .page { margin: 0; width: auto; } }
`;

export function openFlowPrint(options: { paper: 'A4' | 'A5'; marginMm: number; flow: FlowNode[]; footer: FlowNode[]; title: string; ctx: FlowContext; note?: string }) {
  const win = window.open('', '_blank');
  if (!win) return false;
  const width = options.paper === 'A5' ? '148mm' : '210mm';
  const body = `${previewHtml(options.flow, options.ctx)}${options.footer.length ? `<div class="foot">${previewHtml(options.footer, options.ctx)}</div>` : ''}`;
  const note = options.note ? `<small>${escapeHtml(options.note)}</small>` : '';
  win.document.open();
  win.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title><style>${previewStyle}</style></head><body><div class="bar"><span>模板：${escapeHtml(options.title)}</span>${note}<button class="plain" onclick="window.close()">关闭</button><button onclick="window.print()">打印</button></div><section class="page" style="width:${width};padding:${options.marginMm}mm">${body}</section></body></html>`);
  win.document.close();
  win.focus();
  return true;
}
