import { moneyText, quantityText } from '../previewMath';
import { qty } from './qty';

const SCALE = 1_000_000n;

export const WAGE_FORMULA = 'case(${任务.计价方式}=="计件",${报工.良品数}*${报工.工资单价};${任务.计价方式}=="计时",${报工.报工时长}/3600*${报工.工资单价})';

export function modeText(mode: string | null | undefined) {
  return mode === 'piece' ? '计件' : mode === 'time' ? '计时' : '';
}

export function modeWageText(mode: string | null | undefined) {
  return mode === 'piece' ? '计件工资' : mode === 'time' ? '计时工资' : '';
}

export function inspectionText(scheme: string | null | undefined) {
  return scheme === 'full' ? '全检' : scheme === 'sample' ? '抽检' : scheme === 'none' ? '不需质检' : '';
}

export function qualityText(status: string | null | undefined) {
  return status === 'pending' ? '待质检' : status === 'done' ? '已质检' : status === 'none' ? '不需质检' : '';
}

export function priorityText(priority: string | null | undefined) {
  return priority === 'urgent' ? '加急' : priority === 'normal' ? '正常' : priority === 'delayed' ? '延期' : '无';
}

export function settlementText(status: string | null | undefined) {
  return status === 'settled' ? '已结算' : '未结算';
}

export function rateLabel(rate: string | null | undefined, unit?: string) {
  if (!rate) return '';
  const compact = rate.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return unit ? `${compact}元/${unit}` : `${compact}元`;
}

export function yuanLabel(amount: string | null | undefined) {
  if (!amount) return '';
  return `${amount.replace(/\.00$/, '')}元`;
}

export function moneyLabel(amount: string | null | undefined) {
  if (!amount) return '';
  return amount.replace(/\.00$/, '');
}

function rateUnits(value: string) {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,7})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole || '0') * 10_000_000n + BigInt(fraction.padEnd(7, '0').slice(0, 7));
}

function roundDiv(value: bigint, denominator: bigint) {
  return (value + denominator / 2n) / denominator;
}

/** 与后端 priceWage 相同：计件按良品，计时按秒，四舍五入到分。 */
export function wageAmount(mode: string, rateText: string | null | undefined, good: string, seconds: number) {
  if (!rateText) return '';
  const price = rateUnits(rateText);
  if (price === null) return '';
  try {
    const cents = mode === 'time'
      ? roundDiv(BigInt(Math.max(0, Math.floor(seconds))) * price, 360_000_000n)
      : roundDiv(qty(good || '0') * price, 100_000_000_000n);
    return moneyText(cents);
  } catch {
    return '';
  }
}

export function mulCeilText(left: string, right: string) {
  try {
    const product = qty(left || '0') * qty(right || '0');
    if (product <= 0n) return '0';
    return quantityText((product + SCALE - 1n) / SCALE, true);
  } catch {
    return '';
  }
}

export function nowShanghai() {
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  return text.replace(' ', 'T');
}

export function splitSpan(start: string, end: string) {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const minutes = Math.round((to - from) / 60000);
  return { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) };
}

export function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const cell = (value: string) => {
    let text = value ?? '';
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const body = [headers.map(cell).join(','), ...rows.map((row) => row.map((value) => cell(value ?? '')).join(','))].join('\r\n');
  const blob = new Blob([`\ufeff${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
