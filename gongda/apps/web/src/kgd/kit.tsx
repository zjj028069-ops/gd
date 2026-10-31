import { useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Input, Modal, Tag } from 'antd';
import { ApiError, apiRequest, errorMessage } from '../api';
import { CommandKeys } from '../commandKeys';
import { moneyText } from '../previewMath';
import { useKgd } from './context';
import { specForPath } from './pageSpec';

export function beijingTime(value: unknown, empty = '-') {
  if (value == null || value === '') return empty;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    const text = String(value);
    return text.includes('T') ? text.replace('T', ' ').slice(0, 19) : text;
  }
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date).replace('T', ' ');
}

export function useCommand() {
  const { session, onExpired, onChanged } = useKgd();
  const keys = useRef(new CommandKeys());
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  function setFieldError(field: string, msg: string) {
    setFieldErrors((current) => ({ ...current, [field]: msg }));
    setError(msg);
  }
  function clearFieldErrors() {
    setFieldErrors({});
  }
  async function send<T>(path: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST') {
    if (lock.current) return undefined;
    lock.current = true;
    setBusy(true);
    setError('');
    clearFieldErrors();
    const prepared = typeof body.request_key === 'string' ? keys.current.prepare(path, body) : body;
    try {
      const result = await apiRequest<T>(path, { method, csrfToken: session.csrf_token, body: prepared });
      if (typeof prepared.request_key === 'string') keys.current.complete(path, prepared);
      onChanged();
      return result;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      const message = errorMessage(failure);
      setError(message);
      if (failure instanceof ApiError && failure.field) setFieldErrors({ [failure.field]: message });
      throw failure instanceof Error ? failure : new Error(message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { send, busy, error, setError, fieldErrors, setFieldError, clearFieldErrors, session };
}

export function Req({ label, field, required = false, children, errors }: {
  label: string;
  field: string;
  required?: boolean;
  children: ReactNode;
  errors?: Record<string, string>;
}) {
  const message = errors?.[field] ?? '';
  return <>
    <span className={message ? 'kgd-field-error-label' : undefined}>{label}{required ? <em className="kgd-req"> *</em> : null}</span>
    <div className={message ? 'kgd-field-error' : undefined}>
      {children}
      {message ? <div className="kgd-field-help">{message}</div> : null}
    </div>
  </>;
}

export function askReason(title: string, onOk: (reason: string) => void) {
  let reason = '';
  Modal.confirm({
    title,
    content: <Input.TextArea autoFocus placeholder="请填写原因" onChange={(event) => { reason = event.target.value; }} />,
    okText: '确定',
    cancelText: '取消',
    onOk: () => {
      if (!reason.trim()) return Promise.reject(new Error('请填写原因'));
      onOk(reason.trim());
    },
  });
}

export function confirmText(title: string, content: string, onOk: () => void) {
  Modal.confirm({ title, content, okText: '确定', cancelText: '取消', onOk });
}

export function StatusTag({ text, tone }: { text: string; tone?: string }) {
  const color = tone === 'run' || text === '生产中' || text === '进行中' ? 'orange' : text === '已完成' || text === '启用' || text === '通过' || text === '履约中' ? 'green' : text === '已暂停' || text === '待审核' || text === '待审' ? 'gold' : undefined;
  return <Tag color={color}>{text}</Tag>;
}

export function when(value: string | null | undefined) {
  return value ? beijingTime(value, '') : '';
}

export function todayISO() {
  return new Date().toLocaleDateString('sv-SE');
}

export function overdue(date: string | null | undefined, done: boolean) {
  if (!date || done) return false;
  return date.slice(0, 10) < todayISO();
}

export function countdown(date: string | null | undefined) {
  if (!date) return '';
  const target = new Date(`${date.slice(0, 10)}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days = Math.round((target.getTime() - now.getTime()) / 86400000);
  return days >= 0 ? `${days}天` : `逾期${-days}天`;
}

export function centsOfYuan(value: string | null | undefined) {
  const text = (value ?? '0').trim() || '0';
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return 0n;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function sumYuan(values: Array<string | null | undefined>) {
  return moneyText(values.reduce((total, value) => total + centsOfYuan(value), 0n));
}

export function durationText(seconds: number) {
  if (!seconds) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}小时${minutes}分钟`;
}

export function showError(error: unknown) {
  return error instanceof Error ? error.message : errorMessage(error);
}

export function useQueryState(initialPageSize = 30) {
  const location = useLocation();
  const specSize = Number(String(specForPath(location.pathname)?.page_size ?? '').replace(/[^\d]/g, '')) || 0;
  const search = new URLSearchParams(location.search);
  const seeded = search.get('code') ?? '';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(specSize || initialPageSize);
  const [draft, setDraft] = useState<Record<string, string>>(seeded ? { code: seeded, q: seeded } : {});
  const [query, setQuery] = useState<Record<string, string>>(seeded ? { code: seeded, q: seeded } : {});
  const [chips, setChips] = useState<Record<string, string>>(() => Object.fromEntries([...search.entries()].filter(([key]) => key.startsWith('chip.')).map(([key, value]) => [key.slice(5), value])));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  return {
    page, pageSize, draft, query, chips,
    onQuery: (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value })),
    onChip: (key: string, value: string) => { setChips((current) => ({ ...current, [key]: value })); setPage(1); },
    onSearch: () => { setQuery({ ...draftRef.current }); setPage(1); },
    onClear: () => { setDraft({}); setQuery({}); setChips({}); setPage(1); },
    onApplyQuery: (next: Record<string, string>) => { setDraft({ ...next }); setQuery({ ...next }); setPage(1); },
    onPage: (next: number, size: number) => { setPage(next); setPageSize(size); },
  };
}
