import type { Sql } from './database.js';
import { Problem } from './services.js';

export type Element = { type: 'fixed' | 'date' | 'empty'; text?: string; date_format?: 'ymd' | 'ym' | 'y'; short_year?: boolean; separator?: '' | '-' };
export type RuleConfig = { elements: Element[]; seq_digits: number; seq_start: number; show_abbrev: boolean };

const fixedText = /^[A-Za-z0-9]{0,9}$/;

export function shanghaiParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)!.value;
  return { year: read('year'), month: read('month'), day: read('day') };
}

function elementText(element: Element, now: Date) {
  if (element.type === 'empty') return '';
  if (element.type === 'fixed') return element.text ?? '';
  const date = shanghaiParts(now);
  const year = element.short_year ? date.year.slice(2) : date.year;
  if (element.date_format === 'y') return year;
  if (element.date_format === 'ym') return year + date.month;
  return year + date.month + date.day;
}

export function renderCode(config: RuleConfig, sequence: number, now = new Date()) {
  let body = '';
  for (let index = 0; index < 3; index += 1) {
    const element = config.elements[index]!;
    const value = elementText(element, now);
    if (!value) continue;
    body += value;
    const next = elementText(config.elements[index + 1]!, now);
    if (next && element.separator === '-') body += '-';
  }
  const last = config.elements[3]!;
  body += elementText(last, now);
  const width = config.show_abbrev ? 0 : Math.max(config.seq_digits, String(sequence).length);
  const serial = config.show_abbrev ? String(sequence) : String(sequence).padStart(width, '0');
  return body + (last.separator === '-' ? '-' : '') + serial;
}

export function ruleFormula(name: string, config: RuleConfig) {
  const parts: string[] = [];
  config.elements.forEach((element, index) => {
    if (element.type === 'fixed' && element.text) parts.push(element.text);
    if (element.type === 'date') parts.push(element.date_format === 'ym' ? '年月' : element.date_format === 'y' ? '年' : '年月日');
    if (index < 3 && element.separator === '-' && elementText(config.elements[index + 1]!, new Date())) parts.push('-');
  });
  if (config.elements[3]?.separator === '-') parts.push('-');
  parts.push('流水号');
  return `${name}=${parts.join('+')}`;
}

export function periodKey(config: RuleConfig, now = new Date()) {
  const date = config.elements.find((element) => element.type === 'date');
  return date ? elementText(date, now) : 'all';
}

export function parseConfig(input: unknown): RuleConfig {
  if (!input || typeof input !== 'object') throw new Problem(422, 'CODE_RULE', '编号规则不正确');
  const raw = input as RuleConfig;
  if (!Array.isArray(raw.elements) || raw.elements.length !== 4) throw new Problem(422, 'CODE_RULE', '编号规则需要4个元素');
  let dates = 0;
  const elements = raw.elements.map((element, index) => {
    const type = element?.type;
    if (type !== 'fixed' && type !== 'date' && type !== 'empty') throw new Problem(422, 'CODE_RULE', `元素${index + 1}类型不正确`);
    if (type === 'date') dates += 1;
    const text = String(element.text ?? '');
    if (type === 'fixed' && !fixedText.test(text)) throw new Problem(422, 'CODE_RULE', '元素文本限制为数字和英文，不得超过9位。');
    const dateFormat = element.date_format === 'ym' || element.date_format === 'y' ? element.date_format : 'ymd' as const;
    const separator = element.separator === '-' ? '-' as const : '' as const;
    return { type, text, date_format: dateFormat, short_year: Boolean(element.short_year), separator };
  });
  if (dates > 1) throw new Problem(422, 'CODE_RULE', '只能有一个日期元素');
  for (let index = 0; index < 3; index += 1) {
    if (elements[index + 1]!.type === 'empty') elements[index]!.separator = '';
  }
  const seqDigits = Number(raw.seq_digits);
  const seqStart = Number(raw.seq_start);
  if (!Number.isInteger(seqDigits) || seqDigits < 1 || seqDigits > 9) throw new Problem(422, 'CODE_RULE', '流水号位数不正确');
  if (!Number.isInteger(seqStart) || seqStart < 1 || String(seqStart).length > seqDigits) throw new Problem(422, 'CODE_RULE', '起始流水号不正确');
  return { elements, seq_digits: seqDigits, seq_start: seqStart, show_abbrev: Boolean(raw.show_abbrev) };
}

export function storedConfig(value: unknown): RuleConfig {
  if (typeof value === 'string') return parseConfig(JSON.parse(value));
  return parseConfig(value);
}

const documentRules: { name: string; config: RuleConfig; sort: number }[] = [
  ['客户编号', 'KH', '', 4, 10],
  ['报价单号', 'BJ', 'date', 3, 11],
  ['合同编号', 'HT', 'date', 3, 12],
  ['供应商编号', 'GYS', '', 4, 13],
  ['采购单号', 'CG', 'date', 3, 14],
  ['仓库编号', 'WH', '', 4, 20],
  ['采购入库单号', 'CGRK', 'date', 3, 21],
  ['采购退货单号', 'CGTH', 'date', 3, 22],
  ['销售出库单号', 'HTCK', 'date', 3, 23],
  ['调拨单号', 'KCDB', 'date', 3, 24],
  ['盘点单号', 'PK', 'date', 3, 25],
  ['成品入库单号', 'CPRK', 'date', 3, 26],
  ['生产出库单号', 'SCCK', 'date', 3, 27],
  ['其他入库单号', 'QTRK', 'date', 3, 28],
  ['其他出库单号', 'QTCK', 'date', 3, 29],
  ['半成品入库单号', 'BCP', 'date', 3, 30],
  ['销售退货单号', 'XSTH', 'date', 3, 31],
  ['生产退料单号', 'SCTL', 'date', 3, 32],
  ['BOM编号', 'BOM', 'date', 4, 44],
].map(([name, prefix, kind, digits, sort]) => ({
  name: String(name),
  sort: Number(sort),
  config: {
    elements: [
      { type: 'fixed', text: String(prefix), separator: '' },
      kind === 'date' ? { type: 'date', date_format: 'ymd', short_year: false, separator: '' } : { type: 'empty', separator: '' },
      { type: 'empty', separator: '' },
      { type: 'empty', separator: '' },
    ] as Element[],
    seq_digits: Number(digits),
    seq_start: 1,
    show_abbrev: false,
  },
}));

export const seriesRuleName: Record<string, string> = {
  KH: '客户编号', BJ: '报价单号', HT: '合同编号', GYS: '供应商编号', CG: '采购单号',
  WH: '仓库编号', CGRK: '采购入库单号', CGTH: '采购退货单号', HTCK: '销售出库单号', KCDB: '调拨单号',
  PK: '盘点单号', CPRK: '成品入库单号', SCCK: '生产出库单号', QTRK: '其他入库单号', QTCK: '其他出库单号',
  BCP: '半成品入库单号', XSTH: '销售退货单号', SCTL: '生产退料单号',
};

export async function ensureDocumentRules(sql: Sql, tenantId: string) {
  for (const rule of documentRules) {
    await sql.query('INSERT INTO custom_code_rules(tenant_id,name,config,sort) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT (tenant_id,name) DO NOTHING', [tenantId, rule.name, JSON.stringify(rule.config), rule.sort]);
  }
}

export async function allocateByRule(sql: Sql, tenantId: string, name: string) {
  await ensureDocumentRules(sql, tenantId);
  const rule = (await sql.query<{ id: string; config: unknown }>('SELECT id,config FROM custom_code_rules WHERE name=$1 FOR UPDATE', [name])).rows[0];
  if (!rule) return null;
  const config = storedConfig(rule.config);
  const period = periodKey(config);
  const row = (await sql.query<{ value: number }>(`INSERT INTO custom_code_counters(tenant_id,rule_id,period_key,value) VALUES($1,$2,$3,$4)
    ON CONFLICT (tenant_id,rule_id,period_key) DO UPDATE SET value=custom_code_counters.value+1 RETURNING value`, [tenantId, rule.id, period, config.seq_start])).rows[0]!;
  return renderCode(config, row.value);
}
