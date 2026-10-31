const SCALE = 8;
const BASE = 10n ** BigInt(SCALE);

export function parseMoney(value: string): bigint {
  const text = String(value ?? '').trim() || '0';
  if (!/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(text)) throw new Error('金额格式不正确，最多8位小数');
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
  if (den === 0n) throw new Error('金额计算公式除数不能为0');
  const sign = (num < 0n) !== (den < 0n) ? -1n : 1n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  return sign * ((n + d / 2n) / d);
}

function applyScale(value: bigint, scale: number) {
  const extra = SCALE - scale;
  if (extra <= 0) return value;
  const div = 10n ** BigInt(extra);
  const sign = value < 0n ? -1n : 1n;
  const v = value < 0n ? -value : value;
  return sign * ((v + div / 2n) / div) * div;
}

function evalExpr(input: string): bigint {
  const s = input.replace(/\s+/g, '');
  let i = 0;
  const number = () => {
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i] ?? '')) i++;
    if (start === i) throw new Error('金额计算公式不正确');
    return parseMoney(s.slice(start, i));
  };
  const factor = (): bigint => {
    if (s[i] === '(') { i++; const value = expr(); if (s[i] !== ')') throw new Error('金额计算公式不正确'); i++; return value; }
    if (s[i] === '+') { i++; return factor(); }
    if (s[i] === '-') { i++; return -factor(); }
    return number();
  };
  const term = (): bigint => {
    let value = factor();
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++]!;
      const right = factor();
      value = op === '*' ? divRound(value * right, BASE) : divRound(value * BASE, right);
    }
    return value;
  };
  const expr = (): bigint => {
    let value = term();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++]!;
      const right = term();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  const value = expr();
  if (i !== s.length) throw new Error('金额计算公式不正确');
  return value;
}

const placeholders: [string, 'price' | 'qty'][] = [
  ['${合同明细.单价}', 'price'], ['${合同报价明细.单价}', 'price'],
  ['${合同明细.销售数量}', 'qty'], ['${合同报价明细.销售数量}', 'qty'],
];

export function lineAmount(formula: string, price: string, qty: string, scale: number) {
  let expr = formula.trim();
  for (const [token, key] of placeholders) expr = expr.split(token).join(key === 'price' ? price : qty);
  if (expr.includes('${') || !/^[-+*/().\d\s]+$/.test(expr)) throw new Error('金额计算公式含有无法识别的字段');
  return formatMoney(applyScale(evalExpr(expr), scale));
}

export function netAmount(amount: string, fold: string, concession: string, scale: number) {
  const discount = parseMoney(fold || '10');
  if (discount < 0n || discount > parseMoney('10')) throw new Error('折扣须在0到10折之间');
  const net = applyScale(divRound(parseMoney(amount) * discount, parseMoney('10')), scale) - parseMoney(concession || '0');
  if (net < 0n) throw new Error('折后金额不能为负数');
  return formatMoney(net);
}

export function allocateSequential(debts: string[], total: string) {
  const cap = sumMoney(debts);
  if (cmpMoney(total, cap) > 0) throw new Error(`不可大于所选合同总欠款 ${formatMoney(parseMoney(cap))} 元`);
  let left = parseMoney(total);
  return debts.map((debt) => {
    const room = parseMoney(debt);
    const take = left < room ? left : room;
    left -= take;
    return formatMoney(take);
  });
}
