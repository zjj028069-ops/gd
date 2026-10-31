import { formatDecimal, SCALE } from './decimal.js';

export function q(value: string | null | undefined) {
  const text = (value ?? '').trim() || '0';
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [whole, frac = ''] = body.split('.');
  const digits = ((whole ?? '0').replace(/^0+/, '') || '0') + frac.padEnd(6, '0').slice(0, 6);
  return (neg ? -1n : 1n) * BigInt(digits);
}

export function qtyText(value: bigint) {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  if (frac === 0n) return `${neg ? '-' : ''}${whole}`;
  const fracText = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}.${fracText}`;
}

export function floorPercent(done: bigint, total: bigint) {
  if (total <= 0n) return 0;
  return Number((done * 100n) / total);
}

export function progressLabel(done: string | bigint, total: string | bigint) {
  const d = typeof done === 'bigint' ? done : q(done);
  const t = typeof total === 'bigint' ? total : q(total);
  const pct = floorPercent(d, t);
  return `${pct}% (${qtyText(d)}/${qtyText(t)})`;
}

export function ringPercent(good: string, plan: string) {
  const g = q(good);
  const p = q(plan);
  if (p <= 0n) return 0;
  const raw = (g * 100n) / p;
  return Number(raw > 100n ? 100n : raw);
}

export function processStepProgress(completed: number, total: number) {
  return progressLabel(BigInt(completed), BigInt(total));
}

export function taskProgressFromTasks(tasks: { plan_qty: string; approved_good: string }[]) {
  const plan = tasks.reduce((sum, task) => sum + q(task.plan_qty), 0n);
  const good = tasks.reduce((sum, task) => sum + q(task.approved_good), 0n);
  return progressLabel(good, plan);
}

export function processCountProgress(tasks: { execution: string }[]) {
  const total = tasks.length;
  const done = tasks.filter((task) => task.execution === 'completed').length;
  const pct = floorPercent(BigInt(done), BigInt(total));
  return `${pct}% (${done}/${total})`;
}

export const shanghaiTodaySql = "(now() AT TIME ZONE 'Asia/Shanghai')::date";

export function workOrderOverdueSql(alias = 'w') {
  return `(${alias}.execution NOT IN ('completed','cancelled') AND COALESCE(${alias}.planned_end, ${alias}.due_date) IS NOT NULL AND COALESCE(${alias}.planned_end, ${alias}.due_date) < ${shanghaiTodaySql})`;
}

export function taskOverdueSql(workAlias = 'w', taskAlias = 't') {
  return `(${taskAlias}.execution <> 'completed' AND ${workOrderOverdueSql(workAlias)})`;
}

export function receivedQtySql(workOrderIdExpr: string) {
  return `(SELECT coalesce(sum(quantity),0) FROM fg_receipts WHERE work_order_id=${workOrderIdExpr} AND approval='approved')`;
}

export function formatDecimalQty(value: bigint) {
  return formatDecimal(value);
}
