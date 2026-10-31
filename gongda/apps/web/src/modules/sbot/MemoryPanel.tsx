// 企业经验库面板：Bot 操作时踩过的坑和正确做法。所有人可看，管理员可新增/修改/删除。
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';
import { Icon } from './ui/icons';
import { Spinner, clock } from './ui/Chat';

type Entry = { id: string; text: string; by: string; source: string; created: number; updated: number };

export function MemoryPanel({ onClose, rev }: { onClose: () => void; rev: number }) {
  const { session, onExpired } = useKgd();
  const csrf = session.csrf_token;
  const [items, setItems] = useState<Entry[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) { onExpired(); return; }
    setError(errorMessage(e));
  }, [onExpired]);

  const load = useCallback(async () => {
    try {
      const d = await apiRequest<{ items: Entry[]; can_edit: boolean }>('/api/sbot/memory');
      setItems(d.items);
      setCanEdit(d.can_edit);
    } catch (e) { fail(e); }
  }, [fail]);

  useEffect(() => { void load(); }, [load, rev]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); await load(); } catch (e) { fail(e); } finally { setBusy(false); }
  }

  return <div className="sbot-mem">
    <div className="sbot-mem-head">
      <Icon name="brain" size={18} />
      <div className="sbot-mem-title">
        <b>经验库</b>
        <span>Bot 在本企业操作时踩过的坑和正确做法，每次开工前都会先看。{canEdit ? '' : '只有管理员可以修改。'}</span>
      </div>
      <button className="icon-btn" onClick={onClose} title="关闭"><Icon name="x" size={18} /></button>
    </div>
    <div className="sbot-mem-list">
      {items === null ? <div className="sbot-mem-empty"><Spinner /> 加载中…</div> : null}
      {items && !items.length ? <div className="sbot-mem-empty">还没有经验。Bot 做任务时被系统拦下、走了弯路，做完会自动记在这里。</div> : null}
      {items?.map((m) => <div key={m.id} className="sbot-mem-item">
        {editing === m.id
          ? <>
            <textarea value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus />
            <div className="sbot-mem-actions">
              <button className="btn" disabled={busy} onClick={() => setEditing('')}>取消</button>
              <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => void run(async () => { await apiRequest(`/api/sbot/memory/${m.id}`, { method: 'PUT', body: { text: draft.trim() }, csrfToken: csrf }); setEditing(''); })}>保存</button>
            </div>
          </>
          : <>
            <div className="sbot-mem-text">{m.text}</div>
            <div className="sbot-mem-meta">
              <span>{m.by} · {clock(m.updated)}</span>
              {canEdit ? <span className="sbot-mem-ops">
                <button className="link" onClick={() => { setEditing(m.id); setDraft(m.text); }}>修改</button>
                <button className="link danger" disabled={busy} onClick={() => { if (window.confirm('删除这条经验？')) void run(() => apiRequest(`/api/sbot/memory/${m.id}`, { method: 'DELETE', csrfToken: csrf })); }}>删除</button>
              </span> : null}
            </div>
          </>}
      </div>)}
    </div>
    {error ? <div className="event error" onClick={() => setError('')}><Icon name="alert" size={14} /><span>{error}</span></div> : null}
    {canEdit ? <form className="sbot-mem-add" onSubmit={(e) => { e.preventDefault(); if (adding.trim()) void run(async () => { await apiRequest('/api/sbot/memory', { method: 'POST', body: { text: adding.trim() }, csrfToken: csrf }); setAdding(''); }); }}>
      <input value={adding} maxLength={300} onChange={(e) => setAdding(e.target.value)} placeholder="手动加一条，如：建 BOM 前商品要先有类别 → 先到商品列表补类别" />
      <button className="btn primary" disabled={busy || !adding.trim()}>添加</button>
    </form> : null}
  </div>;
}
