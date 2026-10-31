import { useEffect, useState } from 'react'

import { BotFace, GroupFace } from './components/Avatar'
import { ChatView } from './components/ChatView'
import { BotDialog } from './components/dialogs/BotDialog'
import { CronDialog } from './components/dialogs/CronDialog'
import { GroupDialog } from './components/dialogs/GroupDialog'
import { SettingsDialog } from './components/dialogs/SettingsDialog'
import { GroupView } from './components/GroupView'
import { Icon } from './components/icons'
import { PendingCard } from './components/Messages'
import { RightPanel } from './components/RightPanel'
import { Sidebar } from './components/Sidebar'
import { Field, Modal, Spinner } from './components/ui'
import { closeOverlay, connect, openBot, openDialog, openGroup, toast, useStore } from './store'
import { ago, cls } from './utils'

function Home() {
  const bots = useStore(s => s.bots)
  const groups = useStore(s => s.groups)
  const pending = useStore(s => s.pending)
  const settings = useStore(s => s.settings)
  const avatars = Object.fromEntries(Object.values(bots).map(b => [b.name, b.avatar]))
  const usingMock = settings?.default_provider === 'mock'
  const list = Object.values(bots)
    .filter(b => !b.hidden)
    .sort((a, b) => (b.chat?.last_active || b.created) - (a.chat?.last_active || a.created))
  return (
    <section className="home">
      <div className="home-inner">
        <div className="hero-mark">
          <img alt="SEDRIC Bots" className="brand-mark xl" src="/icon.svg" />
        </div>
        <h1 className="logo">SEDRIC Bots</h1>
        <p className="tagline">一个机器人就是一个独立的智能体：自己的人格、记忆、技能和聊天。它们能互相发消息，能在群里协作，也能按时自动干活。</p>
        {usingMock && (
          <div className="notice">
            <Icon name="sparkle" size={16} />
            <span>现在是<b>演示模式</b>：机器人用固定规则模拟回复。配置一个真实模型后，它们才能真正思考。</span>
            <button className="btn primary sm" onClick={() => openDialog({ kind: 'settings', tab: 'models' })}>
              配置模型
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <div className="home-block">
            <h3>需要你处理</h3>
            {pending.map(p => (
              <div className="home-pending" key={p.id}>
                <PendingCard compact p={p} />
                <button className="link" onClick={() => (p.group_id ? void openGroup(p.group_id) : void openBot(p.bot, p.sid))}>
                  去看看 →
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="home-actions">
          <button className="action" onClick={() => openDialog({ kind: 'createBot' })}>
            <Icon name="sparkle" size={20} />
            <b>新建机器人</b>
            <span>给它起名字、定人格、配技能</span>
          </button>
          <button className="action" onClick={() => openDialog({ kind: 'createGroup' })}>
            <Icon name="users" size={20} />
            <b>新建群聊</b>
            <span>把几个机器人拉到一起讨论</span>
          </button>
          <button className="action" onClick={() => openDialog({ kind: 'settings' })}>
            <Icon name="settings" size={20} />
            <b>设置</b>
            <span>模型提供商、审批策略</span>
          </button>
        </div>
        <div className="home-block">
          <h3>机器人</h3>
          <div className="card-grid">
            {list.map(b => (
              <button className="bot-card" key={b.name} onClick={() => void openBot(b.name)}>
                <BotFace avatar={b.avatar} mood={b.status.mood} name={b.name} size={48} />
                <b>{b.title || b.name}</b>
                <span className="handle">@{b.name}</span>
                <p>{b.description || '—'}</p>
                <span className="muted small">{b.chat?.last_active ? (ago(b.chat.last_active) === '刚刚' ? '刚刚活跃' : `${ago(b.chat.last_active)}前活跃`) : '还没聊过'}</span>
              </button>
            ))}
          </div>
        </div>
        {Object.keys(groups).length > 0 && (
          <div className="home-block">
            <h3>群聊</h3>
            <div className="card-grid">
              {Object.values(groups).map(g => (
                <button className="bot-card" key={g.id} onClick={() => void openGroup(g.id)}>
                  <GroupFace avatars={avatars} image={g.image} members={g.members} size={48} />
                  <b>{g.name}</b>
                  <span className="handle">{g.members.length} 个成员</span>
                  <p>{g.preview || '还没有消息'}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function ConfirmDialog() {
  const d = useStore(s => s.overlay)
  const [busy, setBusy] = useState(false)
  if (!d || d.kind !== 'confirm') return null
  const close = closeOverlay
  return (
    <Modal
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            取消
          </button>
          <button
            className={cls('btn', d.danger ? 'danger' : 'primary')}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await d.onConfirm()
                close()
              } catch (e: any) {
                toast(e.message, 'error')
              } finally {
                setBusy(false)
              }
            }}
          >
            {d.action}
          </button>
        </>
      }
      onClose={close}
      title={d.title}
      width={440}
    >
      <p>{d.body}</p>
    </Modal>
  )
}

function PromptDialog() {
  const d = useStore(s => s.overlay)
  const [value, setValue] = useState(d && d.kind === 'prompt' ? d.value : '')
  if (!d || d.kind !== 'prompt') return null
  const close = closeOverlay
  const submit = async () => {
    try {
      await d.onSubmit(value)
      close()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <Modal
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()}>
            确定
          </button>
        </>
      }
      onClose={close}
      title={d.title}
      width={420}
    >
      <Field label={d.label}>
        <input autoFocus onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && void submit()} value={value} />
      </Field>
    </Modal>
  )
}

function Dialogs() {
  const d = useStore(s => s.dialog)
  if (!d) return null
  switch (d.kind) {
    case 'createBot':
      return <BotDialog mode="create" section={d.section} />
    case 'editBot':
      return <BotDialog bot={d.bot} initialTab={d.tab} key={d.bot} mode="edit" />
    case 'settings':
      return <SettingsDialog initialTab={d.tab} />
    case 'createGroup':
      return <GroupDialog members={d.members} mode="create" />
    case 'manageGroup':
      return <GroupDialog id={d.id} key={d.id} mode="manage" />
    case 'cron':
      return <CronDialog bot={d.bot} jobId={d.jobId} key={d.jobId || 'new'} />
    default:
      return null
  }
}

function Overlay() {
  const o = useStore(s => s.overlay)
  if (!o) return null
  if (o.kind === 'prompt') return <PromptDialog key={o.title + o.value} />
  return o.kind === 'confirm' ? <ConfirmDialog /> : null
}

function Toasts() {
  const toasts = useStore(s => s.toasts)
  const bots = useStore(s => s.bots)
  return (
    <div className="toasts">
      {toasts.map(t => (
        <div className={cls('toast', t.level)} key={t.id}>
          {t.bot && bots[t.bot] ? <BotFace avatar={bots[t.bot].avatar} name={t.bot} size={18} still /> : <Icon name={t.level === 'error' ? 'alert' : t.level === 'success' ? 'check' : 'msg'} size={14} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const ready = useStore(s => s.ready)
  const view = useStore(s => s.view)
  const rightOpen = useStore(s => s.rightOpen)
  const pendingCount = useStore(s => s.pending.length)
  const attention = useStore(s => Object.values(s.bots).some(b => b.status.attention))

  useEffect(() => connect(), [])
  useEffect(() => {
    document.title = pendingCount ? `(${pendingCount}) SEDRIC Bots` : attention ? '⚠ SEDRIC Bots' : 'SEDRIC Bots'
  }, [pendingCount, attention])

  if (!ready) {
    return (
      <div className="boot">
        <Spinner size={22} />
        <span>正在连接 SEDRIC Bots…</span>
      </div>
    )
  }

  return (
    <div className="app" data-view={view.kind}>
      <div aria-hidden className="wallpaper">
        <i className="blob b1" />
        <i className="blob b2" />
        <i className="blob b3" />
        <i className="blob b4" />
      </div>
      <Sidebar />
      <main className="main">
        {view.kind === 'home' && <Home />}
        {view.kind === 'bot' && view.sid && <ChatView botName={view.bot} key={view.sid} sid={view.sid} />}
        {view.kind === 'group' && <GroupView id={view.id} key={view.id} thread={view.thread} />}
      </main>
      {view.kind === 'bot' && rightOpen && <RightPanel bot={view.bot} key={view.bot} />}
      <Dialogs />
      <Overlay />
      <Toasts />
    </div>
  )
}
