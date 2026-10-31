import { exactQuantity, moneyText, previewMoney, quantityText } from '../previewMath';

export function qty(value: string | null | undefined) {
  return exactQuantity((value ?? '').trim() || '0');
}

export function qtyText(value: string | null | undefined, compact = true) {
  try { return quantityText(qty(value), compact); } catch { return value || ''; }
}

export function sumQty(values: Array<string | null | undefined>) {
  return quantityText(values.reduce((total, value) => total + qty(value), 0n), true);
}

export function subQty(total: string, used: string) {
  const value = qty(total) - qty(used);
  return value <= 0n ? '0' : quantityText(value, true);
}

export function cmpQty(left: string, right: string) {
  const value = qty(left) - qty(right);
  return value === 0n ? 0 : value < 0n ? -1 : 1;
}

export function mulQty(left: string, right: string) {
  return quantityText((qty(left) * qty(right)) / 1_000_000n, true);
}

/** 生产出库：按加工单计划数折算套数对应的物料量（与 API qtyForSets 一致） */
export function qtyForSets(required: string, sets: string, plan: string) {
  const p = qty(plan);
  if (p === 0n) return '0';
  return quantityText((qty(required) * qty(sets)) / p, true);
}

export function moneyOf(quantity: string, unitPrice: string) {
  return moneyText(previewMoney(qty(quantity), qty(unitPrice)));
}

export function ratioLabel(done: string | number, total: string | number) {
  return `${done}/${total}`;
}

export function limitNote(loaded: number, total: number | undefined, limit: number) {
  if (total !== undefined && total > loaded) return `当前仅加载最近 ${limit} 条`;
  if (loaded >= limit) return `当前仅加载最近 ${limit} 条`;
  return undefined;
}
