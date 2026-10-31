/** 公网 MES 挂在 /app/；本地根路径预览无 basename */
export function getMesBasename(): string | undefined {
  try {
    const p = window.location.pathname;
    if (p === '/app' || p.startsWith('/app/')) return '/app';
  } catch {
    /* ignore */
  }
  const raw = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  if (raw && raw !== '/' && raw !== '.') return raw;
  return undefined;
}

/** 拼出带 basename 的绝对站内路径（给 window.open / 外链复制用） */
export function mesAbsPath(path: string): string {
  const base = getMesBasename() ?? '';
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
}
