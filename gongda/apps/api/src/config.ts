import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const projectRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const mode = env.DB_MODE ?? (production ? 'postgres' : 'pglite');
  if (mode !== 'postgres' && mode !== 'pglite') throw new Error('DB_MODE必须是postgres或pglite');
  if (production && mode !== 'postgres') throw new Error('生产环境不能使用本地嵌入数据库');
  if (production && !env.PUBLIC_ORIGIN) throw new Error('生产环境需设置PUBLIC_ORIGIN');
  const trustedProxy = env.TRUST_PROXY_CIDRS?.split(',').map(value => value.trim()).filter(Boolean);
  if (production && !trustedProxy?.length) throw new Error('生产部署需配置TRUST_PROXY_CIDRS，禁止直接信任任意转发头');
  const origin = new URL(env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173').origin;
  if (production && !origin.startsWith('https://')) throw new Error('生产PUBLIC_ORIGIN必须使用https');
  // 手机等其他地址访问时额外放行的来源（逗号分隔），如局域网 http://192.168.0.8:5173；生产只能是 https
  const extraOrigins = (env.EXTRA_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin);
  if (production && extraOrigins.some((value) => !value.startsWith('https://'))) throw new Error('生产EXTRA_ORIGINS必须使用https');
  // 二维码里的手机访问地址（工人用手机扫码打开的网址前缀）；不填就用当前浏览器地址
  const mobileBase = env.MOBILE_BASE_URL ? new URL(env.MOBILE_BASE_URL).origin : '';
  const port = Number(env.PORT ?? 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT不合法');
  return { production, trustedProxy, mode: mode as 'pglite' | 'postgres', url: env.DATABASE_URL, dataDir: env.LOCAL_DB_DIR ?? resolve(projectRoot, '.local/database'), origin, extraOrigins, mobileBase, port, host: env.HOST ?? '127.0.0.1' };
}




