import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { ApiError, apiRequest, errorMessage, isAbort } from './api';
import type { Session } from './api';
import { Notice } from './shared';

export function useRemote<T>(path: string | null, revision: number, onExpired: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!path);
  const [retry, setRetry] = useState(0);
  const reload = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    setData(null); setError('');
    if (!path) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    apiRequest<T>(path, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((failure: unknown) => {
      if (isAbort(failure) || controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision, onExpired, retry]);
  return { data, error, loading, reload };
}

export function useMutation(session: Session, existing: boolean, onExpired: () => void, onSaved: () => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const busy = useRef(false);
  async function save(path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST') {
    if (busy.current || conflict) return;
    busy.current = true; setSaving(true); setError('');
    try {
      await apiRequest(path, { method, body, csrfToken: session.csrf_token });
      onSaved();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else { setError(errorMessage(failure)); if (existing && failure instanceof ApiError && failure.status === 409) setConflict(true); }
    } finally { busy.current = false; setSaving(false); }
  }
  return { saving, error, conflict, save, setError };
}

export function EditorShell({ title, tenant, onClose, saving = false, error = '', conflict = false, wide = false, children, onSubmit, submitLabel = '保存', submitDisabled = false }: { title: string; tenant: string; onClose: () => void; saving?: boolean; error?: string; conflict?: boolean; wide?: boolean; children: ReactNode; onSubmit?: (event: FormEvent) => void; submitLabel?: string; submitDisabled?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const priorOverflow = document.body.style.overflow;
    const priorFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    (dialog.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button'))?.focus();
    return () => { document.body.style.overflow = priorOverflow; priorFocus?.focus(); };
  }, []);
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
    const first = elements[0], last = elements[elements.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="modal-backdrop"><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={dialog} onKeyDown={keyboard}>
    <div className="modal-heading"><div><div className="eyebrow">{tenant}</div><h2>{title}</h2></div><button className="icon-button" aria-label="关闭" disabled={saving} onClick={onClose}>×</button></div>
    <form onSubmit={onSubmit ?? ((event) => event.preventDefault())}><div className="modal-body">{error && <Notice>{error}</Notice>}{conflict && <Notice kind="info">档案版本已变化，请关闭并重新打开最新数据。本次输入没有被确认保存。</Notice>}{children}</div><div className="modal-footer"><button className="button button-secondary" type="button" disabled={saving} onClick={onClose}>{onSubmit ? '取消' : '关闭'}</button>{onSubmit && <button className="button button-primary" type="submit" disabled={saving || conflict || submitDisabled}>{saving ? '正在提交…' : submitLabel}</button>}</div></form>
  </div></div>;
}