export const QUANTITY_SCALE = 1_000_000n;
const MAX_QUANTITY = 99_999_999_999_999n * QUANTITY_SCALE + 999_999n;

/** 本地预览使用同 API 一致的六位十进制文本，不把数量/单价转成浮点。 */
export function exactQuantity(value: string, label = '数量', positive = false): bigint {
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(value)) throw new Error(`${label}须为非负十进制数，最多14位整数、6位小数。`);
  const [integer, fraction = ''] = value.split('.');
  const result = BigInt(integer) * QUANTITY_SCALE + BigInt(fraction.padEnd(6, '0'));
  if (positive && result === 0n) throw new Error(`${label}须大于零。`);
  if (result > MAX_QUANTITY) throw new Error(`${label}超出支持范围。`);
  return result;
}
export function quantityText(value: bigint, compact = false): string {
  const negative = value < 0n;
  const amount = negative ? -value : value;
  const fraction = (amount % QUANTITY_SCALE).toString().padStart(6, '0');
  const result = `${negative ? '-' : ''}${amount / QUANTITY_SCALE}.${fraction}`;
  return compact ? result.replace(/\.?0+$/, '') : result;
}
/** 合成样例金额按累计数量×单价四舍五入到分；分批金额取累计差额以守恒。 */
export function previewMoney(quantity: bigint, unitPrice: bigint): bigint {
  if (quantity < 0n || unitPrice < 0n) throw new Error('预览金额不接受负数量或负单价。');
  const denominator = QUANTITY_SCALE * QUANTITY_SCALE;
  return (quantity * unitPrice * 100n + denominator / 2n) / denominator;
}
export function moneyText(cents: bigint): string {
  const negative = cents < 0n;
  const amount = negative ? -cents : cents;
  return `${negative ? '-' : ''}${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}
export type PreviewResult = {
  allowed: boolean; next_state: string; effects: string[];
  errors: { code: string; message: string }[]; posted: false; provisional: true;
};
export function requirePreview(result: PreviewResult): PreviewResult {
  if (result.posted !== false || result.provisional !== true) throw new Error('服务未返回预检标记，未采用本次结果。');
  return result;
}
