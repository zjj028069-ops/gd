// Bot 对话（全屏）：版式与 SEDRIC Bots 一致（sbx.css 同步自 SEDRIC-Bots 的 styles.css）。
// 与右下角的 AI 小助手（modules/ai）是两套东西，互不影响。
import { useEffect, useRef, useState } from 'react';
import { Popconfirm } from 'antd';
import { useSbot } from './useSbot';
import { MemoryPanel } from './MemoryPanel';
import { ModeSwitch } from './opMode';
import { BotFace } from './ui/Avatar';
import { BOT_AVATAR, BOT_NAME, Composer, MessageList, clock, cls } from './ui/Chat';
import { Icon } from './ui/icons';
import type { Mood } from './ui/types';
import iconUrl from './ui/icon.svg';
import './ui/sbx.css';
import './sbot.css';

const SUGGESTIONS = ['帮我开一张加工单', '查一下最近的加工单', '把最新那张加工单的交货日期改到下周五', '月底工资怎么结算？'];

export function SbotPage() {
  const s = useSbot('chat');
  const [memOpen, setMemOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.messages, s.stream, s.pending]);

  const mood: Mood = s.pending.length ? 'wait' : s.turn.phase === 'work' ? 'work' : s.turn.running ? 'think' : 'idle';
  const visible = s.messages.filter((m) => m.role !== 'tool');
  const current = s.list.find((x) => x.id === s.active);

  return <div className="sbx sbot-full">
    <div className="app">
      <div aria-hidden className="wallpaper"><i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><i className="blob b4" /></div>
      <aside className="sbx-sidebar">
        <div className="side-head">
          <span className="sbx-brand"><img alt="" className="brand-mark" src={iconUrl} /><span>赛德瑞克 Bot</span></span>
          <button className="icon-btn" onClick={() => void s.newChat()} title="新对话"><Icon name="plus" size={18} /></button>
        </div>
        <div className="sbot-side-mode"><ModeSwitch /></div>
        <div className="side-list">
          {s.list.map((x) => <div key={x.id} role="button" tabIndex={0} className={cls('row', x.id === s.active && 'active')} onClick={() => void s.open(x.id)} onKeyDown={(e) => { if (e.key === 'Enter') void s.open(x.id); }}>
            <span className="row-face"><BotFace avatar={BOT_AVATAR} mood={x.id === s.active ? mood : 'idle'} name="sedric" size={34} still={x.id !== s.active} /></span>
            <span className="row-main">
              <span className="row-top"><span className="row-title">{x.title || '新对话'}</span><span className="row-time">{clock(x.last_active ?? x.updated)}</span></span>
              <span className="row-sub">{x.preview || '说点什么开始吧'}</span>
            </span>
            <Popconfirm title="删除这个对话？" onConfirm={(e) => { e?.stopPropagation(); void s.remove(x.id); }} onCancel={(e) => e?.stopPropagation()}>
              <button className="row-more" onClick={(e) => e.stopPropagation()} title="删除"><Icon name="trash" size={14} /></button>
            </Popconfirm>
          </div>)}
          {!s.list.length ? <div className="side-empty">还没有对话</div> : null}
        </div>
        <div className="side-foot">
          <span className={cls('conn', s.fatal ? 'bad' : 'ok')} />
          <span className="side-user">{s.session.user.display_name} · {s.session.tenant.name}</span>
        </div>
      </aside>
      <main className="main">
        <section className="chat" ref={panel}>
          <header className="chat-head">
            <BotFace avatar={BOT_AVATAR} mood={mood} name="sedric" size={36} />
            <div className="chat-title">
              <div className="chat-name">{BOT_NAME}</div>
              <div className={cls('chat-status', s.pending.length > 0 && 'warn')}>
                {s.pending.length ? '需要你确认' : s.turn.running ? (s.turn.phase === 'work' ? '正在操作系统…' : '正在思考…') : current?.title || '用聊天的方式操作赛德瑞克'}
              </div>
            </div>
            <button className={cls('icon-btn', memOpen && 'on')} onClick={() => setMemOpen(!memOpen)} title="经验库：Bot 记住的坑和正确做法"><Icon name="brain" size={18} /></button>
          </header>
          {memOpen ? <MemoryPanel rev={s.memoryRev} onClose={() => setMemOpen(false)} /> : null}
          <div className="chat-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            <div className="chat-inner">
              {s.fatal ? <div className="event error"><Icon name="alert" size={14} /><span>Bot 暂时不可用：{s.fatal}。可以先切回「传统操作」。</span></div> : null}
              {s.ready === false ? <div className="notice"><Icon name="sparkle" size={14} /> 业务助手还没有配置大模型，请联系管理员。</div> : null}
              {!visible.length && !s.turn.running
                ? <div className="chat-empty">
                  <BotFace avatar={BOT_AVATAR} name="sedric" size={88} />
                  <h2>{BOT_NAME}</h2>
                  <p>想在系统里做什么，直接告诉我。缺什么信息我会问你；所有改动都要你确认才提交，权限和你的账号一致。<br />也可以把工艺图纸、BOM 表、下单表（PDF / Excel）直接拖进来，我读完帮你建好。</p>
                  <div className="chips">{SUGGESTIONS.map((t) => <button className="chip" key={t} onClick={() => void s.send(t)} disabled={!!s.fatal}>{t}</button>)}</div>
                </div>
                : <MessageList messages={s.messages} running={s.turn.running} mood={mood} pending={s.pending} stream={s.stream}
                  userName={s.session.user.display_name} onResolve={(p, body) => s.resolve(p, body)} />}
              {s.error ? <div className="event error" onClick={() => s.setError('')}><Icon name="alert" size={14} /><span>{s.error}</span></div> : null}
            </div>
          </div>
          <div className="chat-foot">
            <Composer placeholder="例如：帮我开一张加工单，做 100 个 XX，下周五交货" running={s.turn.running} queued={s.turn.queued}
              disabled={!!s.fatal} onSend={s.send} onStop={() => void s.stop()} autoFocusKey={s.active} onUpload={s.upload} dropRef={panel} />
          </div>
        </section>
      </main>
    </div>
  </div>;
}
