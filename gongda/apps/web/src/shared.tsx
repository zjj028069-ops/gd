import type { ReactNode } from 'react';

export function Loading({ label = '正在读取数据…' }: { label?: string }) {
  return <div className="loading-state" role="status"><span className="spinner" />{label}</div>;
}

export function Notice({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'info' | 'success' }) {
  return <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden="true">▤</div><strong>{title}</strong><p>{description}</p></div>;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function StatusBadge({ active }: { active: boolean }) {
  return <span className={`badge ${active ? 'badge-green' : 'badge-gray'}`}>{active ? '启用' : '停用'}</span>;
}
