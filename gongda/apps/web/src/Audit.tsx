import { useEffect, useState } from 'react';
import { ApiError, apiRequest, hasPermission, errorMessage, isAbort } from './api';
import type { AuditEvent, EntityId, Session } from './api';
import { EmptyState, Loading, Notice, formatDate } from './shared';

export function Audit({ session, revision, onExpired }: { session: Session; revision: number; onExpired: () => void }) {
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState<EntityId | null>(null);
  const allowed = hasPermission(session, 'audit.read');

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    apiRequest<{ items: AuditEvent[] }>('/api/audit-events', { signal: controller.signal })
      .then((result) => {
        if (!Array.isArray(result.items)) throw new Error('审计数据格式无法识别。');
        setItems(result.items);
      })
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        if (failure instanceof ApiError && failure.status === 401) onExpired();
        else { setItems([]); setError(errorMessage(failure)); }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [allowed, revision, refresh, onExpired]);

  if (!allowed) return <Notice kind="info">当前角色没有操作审计查看权限。</Notice>;
  return <>
    <div className="page-heading"><div><div className="eyebrow">工作空间 / 审计</div><h1>操作审计</h1><p>核对当前企业的操作人与数据变更。</p></div><button className="button button-secondary" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>刷新记录</button></div>
    {error && <Notice>{error}</Notice>}
    <section className="panel table-panel"><div className="table-toolbar"><strong>审计记录</strong><span className="muted small">{loading ? '正在读取…' : `本次返回 ${items.length} 条记录`}</span></div>
      {loading ? <Loading /> : !items.length ? <EmptyState title={error ? '记录读取未完成' : '当前没有审计记录'} description={error ? '可以刷新重试，页面不会用示例记录替代。' : '真实业务操作产生的记录将在此显示。'} /> : <div className="audit-list">
        {items.map((event) => <div className="audit-item" key={event.id}>
          <button className="audit-summary" onClick={() => setExpanded(expanded === event.id ? null : event.id)} aria-expanded={expanded === event.id}>
            <span className="audit-mark" aria-hidden="true">↗</span><span className="audit-main"><strong>{actionLabel(event.action)}</strong><span>{event.entity_type} · {event.entity_id ?? '—'}</span></span><span className="audit-actor">{event.actor_name || '未提供操作者'}</span><time>{formatDate(event.created_at)}</time><span aria-hidden="true">{expanded === event.id ? '−' : '+'}</span>
          </button>
          {expanded === event.id && <div className="audit-detail"><div className="audit-code"><span>记录编号：{event.id}</span><span>动作代码：{event.action}</span></div><div className="change-grid"><div><h3>变更前</h3><pre>{formatData(event.before_data)}</pre></div><div><h3>变更后</h3><pre>{formatData(event.after_data)}</pre></div></div></div>}
        </div>)}
      </div>}
    </section>
  </>;
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = { 'product.create': '创建产品', 'product.created': '创建产品', 'product.update': '修改产品', 'product.updated': '修改产品', 'auth.login': '账号登录', 'auth.logout': '账号退出' };
  return labels[action] ?? action;
}
function formatData(data: unknown): string {
  return data === null || data === undefined ? '无数据' : JSON.stringify(data, null, 2);
}

