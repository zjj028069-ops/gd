import { cmpQty, qty } from '../../qty';

export function floorPercent(done: string | number, total: string | number) {
  const d = typeof done === 'number' ? BigInt(done) : qty(String(done));
  const t = typeof total === 'number' ? BigInt(total) : qty(String(total));
  if (t === 0n) return 0;
  return Number((d * 100n) / t);
}

export function progressParts(done: string | number, total: string | number) {
  const pct = floorPercent(done, total);
  const full = pct >= 100 && cmpQty(String(done), String(total)) >= 0;
  return { pct: full ? 100 : Math.min(pct, 100), label: `${pct}% (${typeof done === 'number' ? done : done}/${typeof total === 'number' ? total : total})` };
}
