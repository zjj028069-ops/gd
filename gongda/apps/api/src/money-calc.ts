import { Problem } from './services.js';

const SCALE = 8;
const BASE = 10n ** BigInt(SCALE);

export function parseMoney(value: string, label = '金额'): bigint {
  const text = String(value ?? '').trim();
  if (!text) throw new Problem(400, 'MONEY_FORMAT', `请填写${label}`);
  if (!/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(text)) throw new Problem(400, 'MONEY_FORMAT', `${label}格式不正确，最多8位小数`);
  const neg = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const n = BigInt(whole || '0') * BASE + BigInt(frac.padEnd(SCALE, '0'));
  return neg ? -n : n;
}

export function formatMoney(value: bigint): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const whole = v / BASE;
  const frac = (v % BASE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const text = frac ? `${whole}.${frac}` : String(whole);
  return neg ? `-${text}` : text;
}

export function cmpMoney(a: string, b: string) {
  const d = parseMoney(a) - parseMoney(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export function addMoney(a: string, b: string) {
  return formatMoney(parseMoney(a) + parseMoney(b));
}

export function subMoney(a: string, b: string) {
  return formatMoney(parseMoney(a) - parseMoney(b));
}

export function sumMoney(values: string[]) {
  return formatMoney(values.reduce((total, value) => total + parseMoney(value || '0'), 0n));
}

function divRound(num: bigint, den: bigint) {
  if (den === 0n) throw new Problem(422, 'FORMULA', '金额计算公式除数不能为0');
  const sign = (num < 0n) !== (den < 0n) ? -1n : 1n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  return sign * ((n + d / 2n) / d);
}

function applyScale(value: bigint, scale: number) {
  if (!Number.isInteger(scale) || scale < 0 || scale > SCALE) throw new Problem(422, 'FORMULA', '小数位数须在0到8之间');
  const extra = SCALE - scale;
  if (extra <= 0) return value;
  const div = 10n ** BigInt(extra);
  const sign = value < 0n ? -1n : 1n;
  const v = value < 0n ? -value : value;
  return sign * ((v + div / 2n) / div) * div;
}

function evalExpr(input: string): bigint {
  const s = input.replace(/\s+/g, '');
  if (!s) throw new Problem(422, 'FORMULA', '金额计算公式不正确');
  let i = 0;
  const number = () => {
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i]!)) i++;
    if (start === i) throw new Problem(422, 'FORMULA', '金额计算公式不正确');
    return parseMoney(s.slice(start, i));
  };
  const factor = (): bigint => {
    if (s[i] === '(') {
      i++;
      const value = expr();
      if (s[i] !== ')') throw new Problem(422, 'FORMULA', '金额计算公式不正确');
      i++;
      return value;
    }
    if (s[i] === '+') { i++; return factor(); }
    if (s[i] === '-') { i++; return -factor(); }
    return number();
  };
  const term = () => {
    let value = factor();
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++]!;
      const right = factor();
      value = op === '*' ? divRound(value * right, BASE) : divRound(value * BASE, right);
    }
    return value;
  };
  const expr = () => {
    let value = term();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++]!;
      const right = term();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  const value = expr();
  if (i !== s.length) throw new Problem(422, 'FORMULA', '金额计算公式不正确');
  return value;
}

const placeholders: [string, 'price' | 'qty'][] = [
  ['${合同明细.单价}', 'price'],
  ['${合同报价明细.单价}', 'price'],
  ['${合同明细.销售数量}', 'qty'],
  ['${合同报价明细.销售数量}', 'qty'],
];

export function lineAmount(formula: string, price: string, qty: string, scale: number) {
  let expr = formula.trim();
  if (!expr) throw new Problem(422, 'FORMULA', '金额计算公式不能为空');
  for (const [token, key] of placeholders) expr = expr.split(token).join(key === 'price' ? price : qty);
  if (expr.includes('${')) throw new Problem(422, 'FORMULA', '金额计算公式含有无法识别的字段');
  if (!/^[-+*/().\d\s]+$/.test(expr)) throw new Problem(422, 'FORMULA', '金额计算公式含有无法识别的字段');
  return formatMoney(applyScale(evalExpr(expr), scale));
}

export function netAmount(amount: string, fold: string, concession: string, scale: number) {
  const gross = parseMoney(amount);
  const discount = parseMoney(fold || '10');
  if (discount < 0n || discount > parseMoney('10')) throw new Problem(422, 'DISCOUNT_RANGE', '折扣须在0到10折之间');
  const off = parseMoney(concession || '0');
  if (off < 0n) throw new Problem(422, 'CONCESSION_RANGE', '优惠金额不能为负数');
  const net = applyScale(divRound(gross * discount, parseMoney('10')), scale) - off;
  if (net < 0n) throw new Problem(422, 'NET_NEGATIVE', '折后金额不能为负数');
  return formatMoney(net);
}

export function countsReceipt(approval: string) {
  return approval === 'approved' || approval === 'exempt';
}

export function contractDebt(amount: string, received: string) {
  return subMoney(amount, received);
}

export function purchaseDebt(inbound: string, returned: string, paid: string) {
  return subMoney(subMoney(inbound, returned), paid);
}

export function progressText(part: string, whole: string) {
  const done = parseMoney(part || '0');
  const total = parseMoney(whole || '0');
  let percent = '0';
  if (total !== 0n) {
    const hundredths = (done * 10000n) / total;
    const neg = hundredths < 0n;
    const v = neg ? -hundredths : hundredths;
    const int = v / 100n;
    const frac = v % 100n;
    percent = `${neg ? '-' : ''}${frac === 0n ? int.toString() : `${int}.${frac.toString().padStart(2, '0')}`.replace(/0+$/, '')}`;
  }
  return `${percent}% (${formatMoney(done)}/${formatMoney(total)})`;
}

export function allocateSequential(debts: string[], total: string) {
  const cap = sumMoney(debts);
  if (cmpMoney(total, cap) > 0) throw new Problem(422, 'OVER_ALLOCATION', `不可大于所选合同总欠款 ${formatMoney(parseMoney(cap))} 元`);
  if (cmpMoney(total, '0') < 0) throw new Problem(422, 'OVER_ALLOCATION', '本次收款总额不能为负数');
  let left = total;
  return debts.map((debt) => {
    const take = cmpMoney(left, debt) <= 0 ? left : debt;
    left = subMoney(left, take);
    return take;
  });
}
