// Bot 对话 / Bot 代操作 共用的数据层：会话、实时事件、发送、待确认事项。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';

import type { ChatFile } from './ui/Chat';
export type SbotMode = 'chat' | 'demo';
export type ToolCallLite = { id: string; name: string; arguments?: string };
export type Msg = {
  id: string; role: 'user' | 'assistant' | 'tool' | 'event'; content: string; at?: number;
  stream?: string; name?: string; kind?: string; files?: { name: string; size?: number }[]; tool_call_id?: string; reasoning?: string | null; tool_calls?: ToolCallLite[];
};
export type UiAction =
  | { type: 'look' }
  | { type: 'open'; menu: string }
  | { type: 'do'; steps: { do: 'click' | 'fill' | 'select' | 'check' | 'uncheck'; target: string; value?: string }[] };
export type Pending = { id: string; sid: string; kind: 'approval' | 'clarify' | 'ui'; title: string; detail?: string; choices: string[]; action?: UiAction | null; driver_tab?: string | null };

/** 当前浏览器标签页的编号（同一标签页刷新后不变）。界面动作只由发消息的那个标签页执行。 */
export const TAB_ID = (() => {
  try {
    const old = sessionStorage.getItem('sbot-tab');
    if (old) return old;
    const id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    sessionStorage.setItem('sbot-tab', id);
    return id;
  } catch { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
})();
export type Preview = { id: string; title: string; updated: number; preview: string; mode?: SbotMode; last_active?: number };
export type TurnState = { running: boolean; phase: string; queued?: number };
type SessionDetail = Preview & { messages: Msg[]; state: TurnState; pending: Pending[] };

export function useSbot(mode: SbotMode) {
  const { session, onExpired } = useKgd();
  const csrf = session.csrf_token;
  const [ready, setReady] = useState<boolean | null>(null);
  const [fatal, setFatal] = useState('');
  const [list, setList] = useState<Preview[]>([]);
  const [active, setActive] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [turn, setTurn] = useState<TurnState>({ running: false, phase: 'idle' });
  const [pending, setPending] = useState<Pending[]>([]);
  const [stream, setStream] = useState<{ id: string; text: string; reasoning: string } | null>(null);
  const [error, setError] = useState('');
  const [memoryRev, setMemoryRev] = useState(0);
  const activeRef = useRef('');

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) { onExpired(); return; }
    setError(errorMessage(e));
  }, [onExpired]);

  const open = useCallback(async (sid: string) => {
    activeRef.current = sid;
    setActive(sid);
    setStream(null);
    if (!sid) { setMessages([]); setTurn({ running: false, phase: 'idle' }); setPending([]); return; }
    try {
      const d = await apiRequest<SessionDetail>(`/api/sbot/sessions/${sid}`);
      if (activeRef.current !== sid) return;
      setMessages(d.messages);
      setTurn(d.state);
      setPending(d.pending);
    } catch (e) { fail(e); }
  }, [fail]);

  useEffect(() => {
    (async () => {
      try {
        const info = await apiRequest<{ ready: boolean }>('/api/sbot/info');
        setReady(info.ready);
        const data = await apiRequest<{ items: Preview[] }>('/api/sbot/sessions');
        const items = data.items.filter((s) => (s.mode ?? 'chat') === mode);
        setList(items);
        if (items[0]) await open(items[0].id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { onExpired(); return; }
        setFatal(errorMessage(e));
      }
    })();
  }, [mode, open, onExpired]);

  useEffect(() => {
    if (fatal) return;
    const es = new EventSource('/api/sbot/events');
    es.onmessage = (ev) => {
      let e: Record<string, unknown>;
      try { e = JSON.parse(ev.data); } catch { return; }
      const sid = e.sid as string | undefined;
      switch (e.type) {
        case 'message': {
          if (sid !== activeRef.current) return;
          const m = e.message as Msg;
          setMessages((old) => old.some((x) => x.id === m.id) ? old.map((x) => x.id === m.id ? m : x) : [...old, m]);
          if (m.stream) setStream((s) => (s && s.id === m.stream ? null : s));
          break;
        }
        case 'delta': {
          if (sid !== activeRef.current) return;
          const id = String(e.stream), text = String(e.text ?? ''), kind = e.kind;
          setStream((s) => {
            const cur = s && s.id === id ? s : { id, text: '', reasoning: '' };
            return kind === 'reasoning' ? { ...cur, reasoning: cur.reasoning + text } : { ...cur, text: cur.text + text };
          });
          break;
        }
        case 'turn':
          if (sid === activeRef.current) {
            setTurn({ running: !!e.running, phase: String(e.phase ?? 'idle'), queued: Number(e.queued ?? 0) });
            if (!e.running) setStream(null);
          }
          break;
        case 'pending':
          setPending(((e.items as Pending[]) ?? []).filter((p) => p.sid === activeRef.current));
          break;
        case 'mes_memory':
          setMemoryRev((v) => v + 1);
          break;
        case 'session_meta': {
          const s = e.session as Preview;
          setList((old) => old.some((x) => x.id === s.id) ? [{ ...s, mode }, ...old.filter((x) => x.id !== s.id)] : old);
          break;
        }
      }
    };
    return () => es.close();
  }, [fatal, mode]);

  const newChat = useCallback(async () => {
    setError('');
    try {
      const s = await apiRequest<Preview>('/api/sbot/sessions', { method: 'POST', body: { mode }, csrfToken: csrf });
      setList((old) => [s, ...old]);
      await open(s.id);
      return s.id;
    } catch (e) { fail(e); return ''; }
  }, [csrf, fail, mode, open]);

  // 读文件：在业务系统里读成文字（原文件不交给 Bot）
  const upload = useCallback(async (file: File): Promise<ChatFile> => {
    if (file.size > 10 * 1024 * 1024) throw new Error('超过 10MB');
    const form = new FormData();
    form.append('file', file, file.name);
    let res: Response;
    try { res = await fetch('/api/sbot/files', { method: 'POST', body: form, credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } }); }
    catch { throw new Error('网络错误，请重试'); }
    const data = await res.json().catch(() => null) as { file?: ChatFile; error?: { message?: string } } | null;
    if (!res.ok || !data?.file) throw new Error(data?.error?.message || '读取失败');
    return data.file;
  }, [csrf]);

  const send = useCallback(async (text: string, files?: ChatFile[]) => {
    const content = text.trim();
    if (!content && !files?.length) return false;
    setError('');
    try {
      let sid = activeRef.current;
      if (!sid) sid = await newChat();
      if (!sid) return false;
      const r = await apiRequest<TurnState>(`/api/sbot/sessions/${sid}/messages`, { method: 'POST', body: { text: content, tab: TAB_ID, ...(files?.length ? { files: files.map((f) => ({ name: f.name, text: f.text, size: f.size })) } : {}) }, csrfToken: csrf });
      setTurn((t) => ({ ...t, running: r.running ?? true }));
      return true;
    } catch (e) { fail(e); return false; }
  }, [csrf, fail, newChat]);

  const stop = useCallback(async () => {
    if (!activeRef.current) return;
    try { await apiRequest(`/api/sbot/sessions/${activeRef.current}/interrupt`, { method: 'POST', csrfToken: csrf }); } catch (e) { fail(e); }
  }, [csrf, fail]);

  const remove = useCallback(async (sid: string) => {
    try {
      await apiRequest(`/api/sbot/sessions/${sid}`, { method: 'DELETE', csrfToken: csrf });
      setList((old) => {
        const items = old.filter((x) => x.id !== sid);
        if (sid === activeRef.current) void open(items[0]?.id ?? '');
        return items;
      });
    } catch (e) { fail(e); }
  }, [csrf, fail, open]);

  const resolve = useCallback(async (p: Pending, body: { approve?: boolean; answer?: string; result?: string }) => {
    try {
      await apiRequest(`/api/sbot/pending/${p.id}`, { method: 'POST', body, csrfToken: csrf });
    } catch (e) {
      // 已经被处理（比如在另一个窗口点了、或回合已停止）：静默忽略
      if (!(e instanceof ApiError && e.status === 404)) fail(e);
    } finally {
      setPending((old) => old.filter((x) => x.id !== p.id));
    }
  }, [csrf, fail]);

  return { session, ready, fatal, list, active, messages, turn, pending, stream, error, setError, open, newChat, send, upload, stop, remove, resolve, memoryRev };
}
