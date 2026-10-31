// Bot 代操作：左侧停靠的聊天面板 + 在真实传统界面上操作的光标。
// 设计沿用 SEDRIC Bots（sbx.css）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Popconfirm } from 'antd';
import { TAB_ID, useSbot } from './useSbot';
import { MemoryPanel } from './MemoryPanel';
import { abortDriver, runUiAction, showCursor } from './driver';
import { setDockMode } from './opMode';
import { BotFace } from './ui/Avatar';
import { BOT_AVATAR, Composer, MessageList, Spinner, cls } from './ui/Chat';
import { Icon } from './ui/icons';
import type { Mood } from './ui/types';
import './ui/sbx.css';
import './sbot.css';

const SUGGESTIONS = ['帮我开一张加工单', '把最新那张加工单开始生产', '给最新的加工单报工 5 个良品', '带我看看加工单列表'];

export function DemoDock() {
  const navigate = useNavigate();
  const s = useSbot('demo');
  const [status, setStatus] = useState('');
  const [memOpen, setMemOpen] = useState(false);
  const [ask, setAsk] = useState<{ text: string; done: (ok: boolean) => void } | null>(null);
  const handled = useRef(new Set<string>());
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const askRef = useRef(ask);
  askRef.current = ask;

  // 面板渲染到 body 下单独的容器里（portal）。antd 弹窗打开时会把焦点锁在弹窗里；
  // 在这个容器上拦住焦点/键盘/鼠标事件不往外传（React 自己的监听也在这个容器上，不受影响），
  // 用户才能在面板里打字、点「允许」。
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.id = 'sbot-dock-host';
    return el;
  });
  // 用 layout effect：要在子组件量尺寸（输入框自动高度）之前把容器挂到页面上
  useLayoutEffect(() => {
    document.body.appendChild(host);
    document.body.classList.add('sbot-demo-on');
    const stop = (e: Event) => e.stopPropagation();
    const events = ['focusin', 'focusout', 'focus', 'blur', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress'];
    for (const t of events) host.addEventListener(t, stop);
    return () => {
      for (const t of events) host.removeEventListener(t, stop);
      host.remove();
      document.body.classList.remove('sbot-demo-on');
      abortDriver();
      showCursor(false);
    };
  }, [host]);

  const hooks = useRef({
    navigate: (path: string) => navigate(path),
    status: (t: string) => setStatus(t),
    confirm: (text: string) => new Promise<boolean>((resolve) => setAsk({ text, done: (ok) => { setAsk(null); resolve(ok); } })),
  });
  hooks.current.navigate = (path: string) => navigate(path);

  useEffect(() => {
    for (const p of s.pending) {
      if (p.kind !== 'ui' || !p.action || handled.current.has(p.id)) continue;
      // 只有发这条消息的标签页才执行界面动作；其他窗口只看进度
      if (p.driver_tab && p.driver_tab !== TAB_ID) continue;
      handled.current.add(p.id);
      void (async () => {
        const result = await runUiAction(p.action!, hooks.current);
        await s.resolve(p, { result });
      })();
    }
  }, [s.pending, s.resolve]);

  useEffect(() => {
    if (!s.turn.running) { showCursor(false); setStatus(''); askRef.current?.done(false); }
  }, [s.turn.running]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages, s.stream, s.pending, status, ask]);

  const stop = useCallback(() => { abortDriver(); askRef.current?.done(false); void s.stop(); }, [s]);

  const mood: Mood = ask ? 'wait' : s.turn.phase === 'work' || status ? 'work' : s.turn.running ? 'think' : 'idle';
  const visible = s.messages.filter((m) => m.role !== 'tool');
  const elsewhere = s.pending.some((p) => p.kind === 'ui' && p.driver_tab && p.driver_tab !== TAB_ID);
  const live = elsewhere
    ? <div className="typing"><BotFace avatar={BOT_AVATAR} mood="work" name="sedric" size={26} /><span>正在你发消息的那个窗口里操作…（在这里发一条消息，就会改到这个窗口操作）</span></div>
    : ask
    ? <div className="pending approval sbot-allow">
      <div className="pending-head"><Icon name="hand" size={15} /> Bot 要点击「{ask.text}」</div>
      <div className="pending-detail">这一步会提交到系统。请先看一眼右边页面上填的内容，没问题再允许。</div>
      <div className="pending-actions">
        <button className="btn danger-ghost" onClick={() => ask.done(false)}>先别点</button>
        <button className="btn primary" onClick={() => ask.done(true)}>允许点击</button>
      </div>
    </div>
    : status
      ? <div className="typing"><BotFace avatar={BOT_AVATAR} mood="work" name="sedric" size={26} /><span>{status}</span></div>
      : undefined;

  return createPortal(<div className="sbx sbot-dock" data-sbot-ignore>
    <section className="main sbot-dock-panel" ref={panel}>
      <header className="chat-head">
        <BotFace avatar={BOT_AVATAR} mood={mood} name="sedric" size={34} />
        <div className="chat-title">
          <div className="chat-name">Bot 代操作</div>
          <div className={cls('chat-status', ask && 'warn')}>{ask ? '等你允许' : status || (s.turn.running ? '正在处理…' : '在右边的真实界面上帮你操作')}</div>
        </div>
        <button className={cls('icon-btn', memOpen && 'on')} onClick={() => setMemOpen(!memOpen)} title="经验库：Bot 记住的坑和正确做法"><Icon name="brain" size={18} /></button>
        <button className="icon-btn" onClick={() => void s.newChat()} title="新对话"><Icon name="plus" size={18} /></button>
        {s.active ? <Popconfirm title="删除这个对话？" placement="bottomRight" zIndex={1300} onConfirm={() => { abortDriver(); void s.remove(s.active); }}>
          <button className="icon-btn" title="删除对话"><Icon name="trash" size={16} /></button>
        </Popconfirm> : null}
        <button className="icon-btn" onClick={() => { stop(); setDockMode('classic'); }} title="退出代操作"><Icon name="x" size={18} /></button>
      </header>
      {memOpen ? <MemoryPanel rev={s.memoryRev} onClose={() => setMemOpen(false)} /> : null}
      {s.list.length > 1 ? <div className="sbot-dock-tabs">
        {s.list.slice(0, 8).map((x) => <button key={x.id} className={cls('pill', x.id === s.active && 'on')} onClick={() => void s.open(x.id)} title={x.title}>{x.title || '新对话'}</button>)}
      </div> : null}
      <div className="chat-scroll" ref={scroller}>
        <div className="chat-inner">
          {s.fatal ? <div className="event error"><Icon name="alert" size={14} /><span>Bot 暂时不可用：{s.fatal}</span></div> : null}
          {s.ready === false ? <div className="notice"><Icon name="sparkle" size={14} /> 业务助手还没有配置大模型，请联系管理员。</div> : null}
          {!visible.length && !s.turn.running
            ? <div className="chat-empty">
              <BotFace avatar={BOT_AVATAR} name="sedric" size={72} />
              <h2>让 Bot 替你操作</h2>
              <p>说出你要办的事，Bot 会在右边的真实界面上一步步点给你看。删除类按钮它不会碰，提交前会先请你允许。也可以把图纸、BOM 表、下单表拖进来。</p>
              <div className="chips">{SUGGESTIONS.map((t) => <button className="chip" key={t} onClick={() => void s.send(t)}>{t}</button>)}</div>
            </div>
            : <MessageList messages={s.messages} running={s.turn.running} mood={mood} pending={s.pending} stream={s.stream}
              userName={s.session.user.display_name} onResolve={(p, body) => s.resolve(p, body)} extra={live} />}
          {s.error ? <div className="event error" onClick={() => s.setError('')}><Icon name="alert" size={14} /><span>{s.error}</span></div> : null}
        </div>
      </div>
      <div className="chat-foot">
        <Composer placeholder="说说要办什么…" running={s.turn.running} queued={s.turn.queued}
          disabled={!!s.fatal} onSend={s.send} onStop={stop} autoFocusKey={s.active} onUpload={s.upload} dropRef={panel} />
      </div>
    </section>
    {s.turn.running && !status && !ask ? <span className="sbot-dock-busy"><Spinner size={12} /></span> : null}
  </div>, host);
}
