/** 非安全上下文（http + 公网 IP）里 crypto.randomUUID 不存在。优先用它，否则用 getRandomValues 拼 UUID，再退回 Math.random。 */
export function uuid(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID();
    } catch {
      /* 部分环境调用时抛错，继续走下面的兜底 */
    }
  }
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') cryptoObj.getRandomValues(bytes);
  else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  const sixth = bytes[6] ?? 0;
  const eighth = bytes[8] ?? 0;
  bytes[6] = (sixth & 0x0f) | 0x40;
  bytes[8] = (eighth & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const requestKey = uuid;

/** 选中键和行 id 可能一边是 string、一边是 number，比较前统一成字符串。 */
export function pickByIds<T extends { id?: unknown }>(rows: readonly T[], keys: readonly unknown[]): T[] {
  const chosen = new Set(keys.map((key) => String(key)));
  return rows.filter((row) => chosen.has(String(row.id)));
}
