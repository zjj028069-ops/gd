import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
const cost = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, cost, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return 'scrypt:131072:8:1:' + salt + ':' + key.toString('hex');
}
export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split(':');
  if (parts.length !== 6 || parts.slice(0,4).join(':') !== 'scrypt:131072:8:1' || !/^[a-f0-9]{32}$/.test(parts[4]!) || !/^[a-f0-9]{128}$/.test(parts[5]!)) return false;
  const key = await derive(password, parts[4]!);
  return timingSafeEqual(key, Buffer.from(parts[5]!, 'hex'));
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const secretToken = () => randomBytes(32).toString('base64url');
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

