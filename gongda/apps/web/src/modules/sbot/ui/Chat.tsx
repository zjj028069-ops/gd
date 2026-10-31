// 聊天组件：移植自 SEDRIC-Bots/frontend/src/components/{Messages,Composer,ui}.tsx，
// 结构和 class 保持一致，样式来自 sbx.css（同步自 SEDRIC Bots 的设计）。
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BotFace } from './Avatar';
import { Icon } from './icons';
import type { Avatar, Mood } from './types';
import type { Msg, Pending, ToolCallLite } from '../useSbot';

export const BOT_AVATAR: Avatar = { shape: 'squircle', color: '#4184F4', image: null, custom: true };
export const BOT_NAME = '赛德瑞克业务助手';

export function cls(...parts: Array<string | false | null | undefined>) { return parts.filter(Boolean).join(' '); }

export function clock(ms?: number | null) {
  if (!ms) return '';
  const d = new Date(ms), today = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function prettyJson(raw: string) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function args(raw?: string): Record<string, any> {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Markdown({ text }: { text: string }) {
  return <div className="md">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _n, ...props }) => <a {...props} rel="noreferrer" target="_blank" /> }}>{text}</ReactMarkdown>
  </div>;
}

const STEP_VERB: Record<string, string> = { click: '点', fill: '填', select: '选', check: '勾选', uncheck: '取消勾选' };

export function toolSummary(name: string, raw?: string) {
  const a = args(raw);
  switch (name) {
    case 'mes_search_products': return `查商品「${a.keyword || '全部'}」`;
    case 'mes_list_processes': return `查工序${a.keyword ? `「${a.keyword}」` : ''}`;
    case 'mes_list_routes': return '查工艺路线';
    case 'mes_list_boms': return '查 BOM';
    case 'mes_list_warehouses': return '查仓库';
    case 'mes_list_customers': return '查客户';
    case 'mes_list_team_members': return '查成员';
    case 'mes_list_work_orders': return `查加工单${a.keyword ? `「${a.keyword}」` : ''}`;
    case 'mes_get_work_order': return '看加工单详情';
    case 'mes_create_work_order': return `创建加工单 · 计划数 ${a.quantity ?? ''}`;
    case 'mes_update_work_order': return '修改加工单';
    case 'mes_work_order_action': return `加工单 · ${({ start: '开始', pause: '暂停', resume: '恢复', complete: '完成', cancel: '取消' } as Record<string, string>)[a.action] ?? a.action}`;
    case 'mes_create_process': return `新建工序「${a.name || ''}」`;
    case 'mes_create_warehouse': return `新建仓库「${a.name || ''}」`;
    case 'mes_create_customer': return `新建客户「${a.name || ''}」`;
    case 'mes_report_production': return `报工 · 良品 ${a.good_qty ?? ''}`;
    case 'mes_search_manual': return `查说明书「${a.query || ''}」`;
    case 'mes_check_ready': return a.task === 'report' ? '检查报工前置条件' : '检查开单前置资料';
    case 'mes_memory': return `${a.action === 'update' ? '改正经验' : '记住经验'}：${a.text || ''}`;
    case 'ui_look': return '看页面';
    case 'ui_open': return `打开菜单「${a.menu || ''}」`;
    case 'ui_do': return (Array.isArray(a.steps) ? a.steps : []).map((s: any) => `${STEP_VERB[s.do] ?? s.do}「${s.target}」${s.value ? `=${s.value}` : ''}`).join('，') || '操作页面';
    case 'clarify': return `问你：${a.question || ''}`;
    default: return name;
  }
}

const TOOL_ICON: Record<string, string> = { clarify: 'hand', mes_search_manual: 'search', ui_look: 'eye', ui_open: 'folder', ui_do: 'bolt' };

function ToolCard({ call, result, running }: { call: ToolCallLite; result?: Msg; running: boolean }) {
  const [open, setOpen] = useState(false);
  const isErr = !!result && /^\{"error"/.test(result.content || '');
  const write = /create|update|action|report/.test(call.name);
  return <div className={cls('tool', isErr && 'err', open && 'open')}>
    <button className="tool-head" onClick={() => setOpen(!open)}>
      <Icon name={TOOL_ICON[call.name] || (write ? 'edit' : 'search')} size={13} />
      <span className="tool-sum">{toolSummary(call.name, call.arguments)}</span>
      {running && !result ? <Spinner size={12} /> : isErr ? <Icon name="alert" size={13} /> : <Icon name="check" size={13} />}
      <Icon className={cls('caret', !open && 'closed')} name="down" size={12} />
    </button>
    {open && <div className="tool-body">
      <div className="tool-label">参数</div>
      <pre>{prettyJson(call.arguments || '{}')}</pre>
      {result && <><div className="tool-label">结果</div><pre>{prettyJson(result.content)}</pre></>}
    </div>}
  </div>;
}

function Reasoning({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return <div className={cls('reasoning', open && 'open')}>
    <button onClick={() => setOpen(!open)}>
      <Icon name="brain" size={13} />{live ? '正在思考…' : '思考过程'}
      <Icon className={cls('caret', !open && 'closed')} name="down" size={12} />
    </button>
    {(open || live) && <div className={cls('reasoning-body', live && !open && 'tail')}>{live && !open ? text.slice(-280) : text}</div>}
  </div>;
}

export function PendingCard({ p, onResolve }: { p: Pending; onResolve: (body: { approve?: boolean; answer?: string }) => Promise<void> }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (body: { approve?: boolean; answer?: string }) => { setBusy(true); try { await onResolve(body); } finally { setBusy(false); } };
  if (p.kind === 'approval') {
    return <div className="pending approval">
      <div className="pending-head"><Icon name="alert" size={15} /> 请确认 · {p.title}</div>
      <pre className="pending-detail">{p.detail}</pre>
      <div className="pending-actions">
        <button className="btn danger-ghost" disabled={busy} onClick={() => void send({ approve: false })}>不对，取消</button>
        <button className="btn primary" disabled={busy} onClick={() => void send({ approve: true })}>确认提交</button>
      </div>
    </div>;
  }
  return <div className="pending clarify">
    <div className="pending-head"><Icon name="hand" size={15} /> {p.title}</div>
    {!!p.choices?.length && <div className="pending-choices">
      {p.choices.map((c) => <button className="btn" disabled={busy} key={c} onClick={() => void send({ answer: c })}>{c}</button>)}
    </div>}
    <form className="pending-answer" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) void send({ answer: answer.trim() }); }}>
      <input onChange={(e) => setAnswer(e.target.value)} placeholder="或者直接输入你的回答…" value={answer} />
      <button className="btn primary" disabled={busy || !answer.trim()}>回答</button>
    </form>
  </div>;
}

type ListProps = {
  messages: Msg[]; running: boolean; mood: Mood; pending: Pending[];
  stream: { text: string; reasoning: string } | null; userName: string;
  onResolve: (p: Pending, body: { approve?: boolean; answer?: string }) => Promise<void>;
  extra?: ReactNode;
};

export function MessageList({ messages, running, mood, pending, stream, userName, onResolve, extra }: ListProps) {
  const results = new Map<string, Msg>();
  for (const m of messages) if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, m);
  const out: ReactNode[] = [];
  let last = '';
  for (const m of messages) {
    if (m.role === 'tool') continue;
    if (m.role === 'event') {
      last = '';
      const ok = m.kind === 'approval' && m.content.startsWith('✅');
      out.push(<div className={cls('event', m.kind, m.kind === 'error' && 'error')} key={m.id}>
        {m.kind === 'error' ? <Icon name="alert" size={14} /> : ok ? <Icon name="check" size={13} /> : m.kind === 'memory' ? <Icon name="brain" size={13} /> : null}
        <span>{m.kind === 'approval' ? m.content.split('\n')[0] : m.content}</span>
      </div>);
      continue;
    }
    if (m.role === 'user') {
      last = 'user';
      out.push(<div className="msg user" key={m.id}>
        <div className="bubble">
          {!!m.files?.length && <div className="msg-files">{m.files.map((f, i) => <span className="file-chip" key={i}><Icon name="clip" size={13} /> {f.name}</span>)}</div>}
          {m.content && <div className="user-text">{m.content}</div>}
        </div>
        <div className="msg-meta">{userName} · {clock(m.at)}</div>
      </div>);
      continue;
    }
    const head = last !== 'bot';
    last = 'bot';
    out.push(<div className={cls('msg bot', !head && 'cont')} key={m.id}>
      <div className="msg-face">{head && <BotFace avatar={BOT_AVATAR} name="sedric" size={28} still />}</div>
      <div className="msg-body">
        {head && <div className="msg-head"><b>{BOT_NAME}</b><span className="msg-time">{clock(m.at)}</span></div>}
        {m.reasoning && <Reasoning text={m.reasoning} />}
        {m.content?.trim() && <div className="bot-bubble"><Markdown text={m.content} /></div>}
        {m.tool_calls?.map((c) => <ToolCard call={c} key={c.id} result={results.get(c.id)} running={running} />)}
      </div>
    </div>);
  }
  const live = running && stream && (stream.text || stream.reasoning);
  const cards = pending.filter((p) => p.kind !== 'ui');
  return <>
    {out}
    {live && <div className={cls('msg bot', last === 'bot' && 'cont')}>
      <div className="msg-face">{last !== 'bot' && <BotFace avatar={BOT_AVATAR} mood="think" name="sedric" size={28} still />}</div>
      <div className="msg-body">
        {last !== 'bot' && <div className="msg-head"><b>{BOT_NAME}</b></div>}
        {stream!.reasoning && <Reasoning live={!stream!.text} text={stream!.reasoning} />}
        {stream!.text && <div className="bot-bubble"><Markdown text={stream!.text + ' ▍'} /></div>}
      </div>
    </div>}
    {extra}
    {running && !live && !cards.length && !extra && <div className="typing">
      <BotFace avatar={BOT_AVATAR} mood={mood === 'work' ? 'work' : 'think'} name="sedric" size={26} />
      <span>{mood === 'work' ? '正在执行…' : `${BOT_NAME} 正在思考…`}</span>
    </div>}
    {cards.map((p) => <PendingCard key={p.id} p={p} onResolve={(body) => onResolve(p, body)} />)}
  </>;
}

export type ChatFile = { name: string; kind: string; size: number; text: string; truncated: boolean; summary: string };
type Att = { key: string; name: string; size: number; state: 'reading' | 'ready' | 'error'; file?: ChatFile; error?: string };
const MAX_FILES = 3;
const ACCEPT = '.pdf,.xlsx,.xls,.xlsm,.csv,.txt,.md,.tsv,.json';

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Composer({ placeholder, running, queued, disabled, onSend, onStop, autoFocusKey, onUpload, dropRef }: {
  placeholder: string; running: boolean; queued?: number; disabled?: boolean; autoFocusKey?: string;
  onSend: (text: string, files?: ChatFile[]) => Promise<boolean>; onStop: () => void;
  /** 读文件（在业务系统里读成文字）；不传就不显示附件功能 */
  onUpload?: (file: File) => Promise<ChatFile>;
  /** 拖到这个区域（比如整个聊天面板）里松手也算上传 */
  dropRef?: RefObject<HTMLElement | null>;
}) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Att[]>([]);
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const attsRef = useRef<Att[]>([]);
  attsRef.current = atts;
  useEffect(() => { ta.current?.focus(); }, [autoFocusKey]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    if (!text) { el.style.height = ''; return; } // 空的时候交给 CSS（单行），不按占位文字撑高
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [text]);
  const addFiles = (list: FileList | File[]) => {
    if (!onUpload || disabled) return;
    const all = Array.from(list);
    const room = Math.max(MAX_FILES - attsRef.current.filter((a) => a.state !== 'error').length, 0);
    const picked = all.slice(0, room);
    const extra = all.length - picked.length;
    const rows: Att[] = picked.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, size: f.size, state: 'reading' }));
    const notice: Att[] = extra > 0 ? [{ key: `${Date.now()}-limit`, name: `一次最多 ${MAX_FILES} 个文件`, size: 0, state: 'error', error: `多出的 ${extra} 个没有加上` }] : [];
    setAtts((old) => [...old, ...rows, ...notice]);
    picked.forEach((f, i) => {
      const key = rows[i]!.key;
      onUpload(f)
        .then((file) => setAtts((old) => old.map((a) => a.key === key ? { ...a, state: 'ready', file } : a)))
        .catch((e: unknown) => setAtts((old) => old.map((a) => a.key === key ? { ...a, state: 'error', error: e instanceof Error ? e.message : '读取失败' } : a)));
    });
  };
  const addRef = useRef(addFiles);
  addRef.current = addFiles;
  useEffect(() => {
    const el = dropRef?.current;
    if (!el || !onUpload) return;
    let depth = 0;
    const isFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => { if (!isFiles(e)) return; e.preventDefault(); depth += 1; setDrag(true); };
    const over = (e: DragEvent) => { if (isFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } };
    const leave = (e: DragEvent) => { if (!isFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDrag(false); };
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault(); e.stopPropagation(); depth = 0; setDrag(false);
      if (e.dataTransfer?.files.length) addRef.current(e.dataTransfer.files);
    };
    el.addEventListener('dragenter', enter); el.addEventListener('dragover', over); el.addEventListener('dragleave', leave); el.addEventListener('drop', drop);
    return () => { el.removeEventListener('dragenter', enter); el.removeEventListener('dragover', over); el.removeEventListener('dragleave', leave); el.removeEventListener('drop', drop); };
  }, [dropRef, onUpload]);
  const ready = atts.filter((a) => a.state === 'ready' && a.file).map((a) => a.file!);
  const reading = atts.some((a) => a.state === 'reading');
  const canSend = !disabled && !reading && (!!text.trim() || ready.length > 0);
  const send = async () => {
    const t = text.trim();
    if (!canSend) return;
    const keep = atts;
    setText(''); setAtts([]);
    if (!(await onSend(t, ready.length ? ready : undefined))) { setText(t); setAtts(keep); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };
  const local = !!onUpload && !dropRef;
  return <div className={cls('composer', drag && 'drag')}
    onDragOver={(e) => { if (local && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
    onDragLeave={() => { if (local) setDrag(false); }}
    onDrop={(e) => { if (local && e.dataTransfer.files.length) { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); } }}>
    {drag && <div className="composer-drop">松开即可上传（PDF / Excel / CSV / TXT）</div>}
    {atts.length > 0 && <div className="att-row">
      {atts.map((a) => <span className={cls('att', a.state === 'error' && 'att-bad')} key={a.key} title={a.error || a.file?.summary || a.name}>
        {a.state === 'reading' ? <Spinner size={12} /> : a.state === 'error' ? <Icon name="alert" size={13} /> : <Icon name="clip" size={14} />}
        <span className="att-name">{a.name}</span>
        <span className="att-size">{a.state === 'reading' ? '读取中…' : a.state === 'error' ? (a.error || '读取失败') : `${a.file?.summary || bytes(a.size)}${a.file?.truncated ? ' · 太长已截取' : ''}`}</span>
        <button onClick={() => setAtts((old) => old.filter((x) => x.key !== a.key))} title="移除"><Icon name="x" size={12} /></button>
      </span>)}
    </div>}
    <div className="composer-row">
      {onUpload && <button className="icon-btn" disabled={disabled || ready.length + (reading ? 1 : 0) >= MAX_FILES} onClick={() => fileIn.current?.click()} title="上传文件（也可以直接拖进来）"><Icon name="clip" size={18} /></button>}
      {onUpload && <input accept={ACCEPT} hidden multiple onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} ref={fileIn} type="file" />}
      <textarea disabled={disabled} maxLength={2000} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        onPaste={(e) => { if (onUpload && e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
        placeholder={placeholder} ref={ta} rows={1} value={text} />
      {running && <button className="icon-btn stop" onClick={onStop} title="停止"><Icon name="stop" size={16} /></button>}
      <button className="send-btn" disabled={!canSend} onClick={() => void send()} title="发送（Enter）"><Icon name="up" size={17} stroke={2.4} /></button>
    </div>
    {(running || !!queued) && <div className="composer-hint">{queued ? `还有 ${queued} 条消息在排队` : '正在处理中… 现在发的消息会排队等待'}</div>}
  </div>;
}
