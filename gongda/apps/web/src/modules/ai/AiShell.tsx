import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { HistoryOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { apiRequest, errorMessage, isAbort as isAbortError } from '../../api';
import { useKgd } from '../../kgd/context';
import './ai.css';

type Mode = 'quick' | 'deep';
type ChatRole = 'user' | 'assistant';
type Citation = { id: string; title: string };
type Msg = { id: string; role: ChatRole; content: string; citations?: Citation[] };
type Session = { id: string; title: string; messages: Msg[]; updatedAt: number };
type Meta = {
  name: string;
  greeting: string;
  suggested_groups: { title: string; questions: string[] }[];
  modes: { id: Mode; label: string }[];
};

const STORAGE_KEY = 'sedric-ai-assistant-v1';
const OPEN_EVENT = 'sedric-ai-open';
/** 小助手聊天超时：无超时会导致「正在思考…」永久卡住 */
const CHAT_TIMEOUT_MS = 25_000;

function isPageContextQuestion(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  return /(目前|当前)?在(哪|那)个?(界面|页面|页)|当前(界面|页面)|我在哪(个|里)?(界面|页面)?|这是哪个(界面|页面)/.test(t);
}

function pageContextReply(pathname: string, title: string): string {
  const path = pathname || '/';
  const label = (title || '').replace(/\s*[|·\-].*$/, '').trim();
  if (label) {
    return `你当前大致在「${label}」页面（路由：${path}）。我只能根据前端路由判断，看不到弹窗或具体表格内容。若要查用法可直接问菜单操作；查进度/应收/工资请用「工厂助理」。`;
  }
  return `根据路由，你当前在 ${path}。我看不到屏幕上的弹窗细节。可告诉我菜单名，或问「如何报工」等用法；查数字请用「工厂助理」。`;
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Session[];
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions: Session[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, 20)));
}

export function openSedricAssistant() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function AiShell() {
  const { session, onExpired } = useKgd();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('quick');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions());
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id ?? '');
  const [pos, setPos] = useState({ right: 22, bottom: 22 });
  const drag = useRef<{ ox: number; oy: number; right: number; bottom: number; moved: boolean } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => sessions.find((item) => item.id === activeId) ?? null, [sessions, activeId]);
  const messages = active?.messages ?? [];

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open || meta) return;
    void apiRequest<Meta>('/api/ai/assistant/meta').then(setMeta).catch((failure) => {
      if (String(failure).includes('401') || (failure as { status?: number }).status === 401) onExpired();
      setError(errorMessage(failure));
    });
  }, [open, meta, onExpired]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, open, busy]);

  const persist = useCallback((next: Session[]) => {
    setSessions(next);
    saveSessions(next);
  }, []);

  const ensureSession = useCallback((): Session => {
    if (active) return active;
    const created: Session = { id: uid(), title: '新会话', messages: [], updatedAt: Date.now() };
    persist([created, ...sessions]);
    setActiveId(created.id);
    return created;
  }, [active, persist, sessions]);

  const newSession = () => {
    const created: Session = { id: uid(), title: '新会话', messages: [], updatedAt: Date.now() };
    persist([created, ...sessions]);
    setActiveId(created.id);
    setShowHistory(false);
    setError('');
  };

  const ask = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    if (/去工厂助理/.test(content)) {
      setOpen(false);
      navigate('/ai/factory');
      return;
    }
    setError('');
    setInput('');
    const current = ensureSession();
    const userMsg: Msg = { id: uid(), role: 'user', content };
    const draftMessages = [...current.messages, userMsg];
    const titled = current.title === '新会话' ? content.slice(0, 24) : current.title;
    const optimistic: Session = { ...current, title: titled, messages: draftMessages, updatedAt: Date.now() };
    persist([optimistic, ...sessions.filter((item) => item.id !== current.id)]);
    setActiveId(optimistic.id);

    // 「当前在哪个界面」本地直接答，不依赖接口，避免无超时 hang
    if (isPageContextQuestion(content)) {
      const bot: Msg = {
        id: uid(),
        role: 'assistant',
        content: pageContextReply(location.pathname, typeof document !== 'undefined' ? document.title : ''),
      };
      const done: Session = { ...optimistic, messages: [...draftMessages, bot], updatedAt: Date.now() };
      persist([done, ...sessions.filter((item) => item.id !== optimistic.id)]);
      return;
    }

    setBusy(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const payload = await apiRequest<{ reply: string; citations?: Citation[] }>('/api/ai/assistant/chat', {
        method: 'POST',
        csrfToken: session.csrf_token,
        signal: controller.signal,
        body: {
          mode,
          messages: draftMessages.map((item) => ({ role: item.role, content: item.content })),
          context: {
            path: location.pathname,
            title: typeof document !== 'undefined' ? document.title : '',
          },
        },
      });
      const bot: Msg = { id: uid(), role: 'assistant', content: payload.reply || '（空回复）', citations: payload.citations };
      const done: Session = { ...optimistic, messages: [...draftMessages, bot], updatedAt: Date.now() };
      persist([done, ...sessions.filter((item) => item.id !== optimistic.id)]);
    } catch (failure) {
      if (isAbortError(failure)) {
        setError('回答超时，请稍后重试。若持续无响应，请确认本机 API（3011）已启动。');
      } else {
        const status = (failure as { status?: number }).status;
        if (status === 401) onExpired();
        setError(errorMessage(failure));
      }
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
    }
  };

  const onFabPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { ox: event.clientX, oy: event.clientY, right: pos.right, bottom: pos.bottom, moved: false };
  };
  const onFabPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    const dx = event.clientX - drag.current.ox;
    const dy = event.clientY - drag.current.oy;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    const right = Math.min(Math.max(8, drag.current.right - dx), window.innerWidth - 60);
    const bottom = Math.min(Math.max(8, drag.current.bottom - dy), window.innerHeight - 60);
    setPos({ right, bottom });
  };
  const onFabPointerUp = () => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (!moved) setOpen((value) => !value);
  };

  const panelStyle = {
    right: Math.max(8, pos.right - 8),
    bottom: Math.max(70, pos.bottom + 60),
  } as const;

  const greeting = meta?.greeting ?? '你好！我是赛德瑞克小助手。';
  const groups = meta?.suggested_groups ?? [];

  return <>
    <button
      type="button"
      className={`sedric-ai-fab ${open ? 'is-open' : ''}`}
      style={{ right: pos.right, bottom: pos.bottom }}
      aria-label="赛德瑞克小助手"
      data-testid="sedric-ai-fab"
      onPointerDown={onFabPointerDown}
      onPointerMove={onFabPointerMove}
      onPointerUp={onFabPointerUp}
    >
      <RobotOutlined />
    </button>
    {open && <div className="sedric-ai-panel" style={panelStyle} ref={panelRef} data-testid="sedric-ai-panel" role="dialog" aria-label="赛德瑞克小助手">
      <div className="sedric-ai-head">
        <RobotOutlined />
        <h3>{meta?.name ?? '赛德瑞克小助手'}</h3>
        <button type="button" aria-label="历史" onClick={() => setShowHistory((v) => !v)}><HistoryOutlined /></button>
        <button type="button" aria-label="新会话" onClick={newSession}><PlusOutlined /></button>
        <button type="button" aria-label="收起" onClick={() => setOpen(false)}>收起</button>
      </div>
      <div className="sedric-ai-toolbar">
        <label>
          <span className="muted" style={{ marginRight: 6 }}>模式</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as Mode)} aria-label="回答模式">
            <option value="quick">快速回答</option>
            <option value="deep">深度分析</option>
          </select>
        </label>
        <span className="muted">{mode === 'deep' ? '适合分步说明' : '适合简明步骤'}</span>
      </div>
      <div className="sedric-ai-body" ref={bodyRef}>
        {!messages.length && <>
          <div className="sedric-ai-msg bot" data-testid="sedric-ai-greeting">{greeting}</div>
          <div className="sedric-ai-suggest">
            {groups.map((group) => <div key={group.title}>
              <h4>{group.title}</h4>
              {group.questions.map((q) => (
                <button key={q} type="button" className="sedric-ai-chip" data-testid="sedric-ai-suggest" onClick={() => void ask(q)}>{q}</button>
              ))}
            </div>)}
            <button type="button" className="sedric-ai-factory-link" data-testid="sedric-ai-goto-factory" onClick={() => { setOpen(false); navigate('/ai/factory'); }}>
              去工厂助理问进度 / 应收 / 工资
            </button>
          </div>
        </>}
        {messages.map((msg) => (
          <div key={msg.id} className={`sedric-ai-msg ${msg.role === 'user' ? 'user' : 'bot'}`} data-testid={msg.role === 'assistant' ? 'sedric-ai-reply' : undefined}>
            {msg.content}
            {!!msg.citations?.length && <div className="sedric-ai-cite">来源：{msg.citations.map((c) => c.title).join('、')}</div>}
          </div>
        ))}
        {busy && <div className="sedric-ai-msg bot">正在思考…</div>}
        {error && <div className="sedric-ai-msg bot" style={{ color: '#c0392b' }}>{error}</div>}
      </div>
      <div className="sedric-ai-foot">
        <textarea
          value={input}
          placeholder="输入你的问题，例如：如何报工"
          rows={1}
          data-testid="sedric-ai-input"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask(input);
            }
          }}
        />
        <button type="button" className="send" disabled={busy || !input.trim()} data-testid="sedric-ai-send" onClick={() => void ask(input)}>发送</button>
      </div>
      {showHistory && <div className="sedric-ai-history" data-testid="sedric-ai-history">
        <h4 style={{ marginTop: 0 }}>历史会话</h4>
        {!sessions.length && <p className="muted">暂无历史</p>}
        {sessions.map((item) => (
          <button key={item.id} type="button" onClick={() => { setActiveId(item.id); setShowHistory(false); }}>
            {item.title || '未命名'}
          </button>
        ))}
      </div>}
    </div>}
  </>;
}
