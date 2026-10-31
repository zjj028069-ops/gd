import type { Session } from './api';
import type { FormEvent } from 'react';
import { useRef, useState } from 'react';
import { ApiError, apiRequest, errorMessage } from './api';
import { Notice } from './shared';

export type SettingsProps = { session: Session; revision: number; onExpired: () => void; onChanged: () => void };
export function useSettingsWrite({ session, onExpired, onChanged }: SettingsProps) {
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  async function write<T>(path: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST'): Promise<T | null> {
    if (busy.current || conflict) return null;
    busy.current = true; setSaving(true); setError(''); setSuccess('');
    try {
      const response = await apiRequest<T>(path, { body, method, csrfToken: session.csrf_token });
      onChanged();
      return response;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else {
        setError(failure instanceof ApiError && failure.status === 403 ? `当前账号不能执行此操作：${errorMessage(failure)}` : errorMessage(failure));
        if (failure instanceof ApiError && failure.status === 409) setConflict(true);
      }
      return null;
    } finally { busy.current = false; setSaving(false); }
  }
  function reset() { setConflict(false); setError(''); setSuccess(''); }
  return { write, saving, error, success, conflict, setError, setSuccess, reset };
}
export function WriteFeedback({ mutation, onReload }: { mutation: ReturnType<typeof useSettingsWrite>; onReload: () => void }) {
  return <>{mutation.error && <Notice>{mutation.error}</Notice>}{mutation.success && <Notice kind="success">{mutation.success}</Notice>}{mutation.conflict && <Notice kind="info"><span>记录版本或约束发生冲突。当前输入已保留，请重新读取后核对再提交。</span><button className="text-button" type="button" onClick={() => { mutation.reset(); onReload(); }}>重新读取</button></Notice>}</>;
}
export function SettingsTabs({ items, active, onChange }: { items: { key: string; label: string }[]; active: string; onChange: (key: string) => void }) {
  return <div className="settings-tabs" role="tablist">{items.map(item => <button role="tab" aria-selected={active === item.key} className={`button ${active === item.key ? 'button-primary' : 'button-secondary'}`} key={item.key} onClick={() => onChange(item.key)}>{item.label}</button>)}</div>;
}
export function prevent(event: FormEvent) { event.preventDefault(); }
