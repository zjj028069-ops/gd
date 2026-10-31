import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../api'
import { confirm, goHome, loadBotSessions, openBot, openDialog, openGroup, promptText, toast, useStore } from '../store'
import type { Attachment } from '../types'
import { ago, cls } from '../utils'
import { BotFace } from './Avatar'
import { Composer } from './Composer'
import { Icon } from './icons'
import { MessageList } from './Messages'
import { useMenu } from './ui'

const STATUS: Record<string, string> = { think: '正在思考…', work: '正在执行工具…', wait: '等你回复…', idle: '' }
const SLASH = [
  { cmd: '/new', desc: '开一个新聊天' },
  { cmd: '/compress', desc: '压缩较早的对话，节省上下文' },
  { cmd: '/stop', desc: '停止当前回合' },
  { cmd: '/edit', desc: '编辑这个机器人' }
]

export function ChatView({ botName, sid }: { botName: string; sid: string }) {
  const bot = useStore(s => s.bots[botName])
  const session = useStore(s => s.sessions[sid])
  const stream = useStore(s => s.streams[sid])
  const allPending = useStore(s => s.pending)
  const bots = useStore(s => s.bots)
  const list = useStore(s => s.botSessions[botName])
  const rightOpen = useStore(s => s.rightOpen)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const menu = useMenu()
  const [switcher, setSwitcher] = useState(false)
  const pending = useMemo(() => allPending.filter(p => p.sid === sid), [allPending, sid])
  const elsewhere = useMemo(() => allPending.filter(p => p.bot === botName && p.sid !== sid), [allPending, botName, sid])
  const groups = useStore(s => s.groups)

  const mentionables = useMemo(
    () => Object.values(bots).filter(b => b.name !== botName).map(b => ({ name: b.name, title: b.title || b.name, avatar: b.avatar, meta: `机器人 · ${b.title || b.name}` })),
    [bots, botName]
  )

  useEffect(() => {
    stick.current = true
  }, [sid])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  if (!bot) return <div className="center-note">这个机器人不存在了</div>
  if (!session) return <div className="center-note">正在打开聊天…</div>

  const isBotChat = session.kind === 'botchat'
  const visible = session.messages.filter(m => m.role !== 'tool')

  const send = async (text: string, attachments: Attachment[]) => {
    if (text === '/new') {
      const s = await api.post(`/api/bots/${botName}/sessions`, {})
      await openBot(botName, s.id)
      return
    }
    if (text === '/edit') {
      openDialog({ kind: 'editBot', bot: botName })
      return
    }
    if (text === '/compress') {
      const r = await api.post(`/api/sessions/${sid}/compress`)
      toast(r.ok ? `已压缩 ${r.compressed} 条消息` : r.error, r.ok ? 'success' : 'info')
      return
    }
    stick.current = true
    await api.post(`/api/sessions/${sid}/messages`, { text, attachments })
  }

  const sessionMenu = (e: React.MouseEvent) =>
    menu.open(e, [
      ...(isBotChat
        ? []
        : [
            {
              label: '重命名…',
              icon: 'edit',
              onClick: () => promptText('重命名聊天', '标题', session.title, async t => void (await api.patch(`/api/sessions/${sid}`, { title: t })))
            }
          ]),
      { label: '压缩历史', icon: 'compress', onClick: () => void send('/compress', []) },
      { label: '编辑机器人…', icon: 'settings', onClick: () => openDialog({ kind: 'editBot', bot: botName }) },
      ...(isBotChat
        ? []
        : [
            { divider: true, label: '' },
            {
              label: '删除这个聊天',
              icon: 'trash',
              danger: true,
              onClick: () =>
                confirm('删除这个聊天？', '聊天记录会被永久删除。', '删除', async () => {
                  await api.del(`/api/sessions/${sid}`)
                  await openBot(botName)
                })
            }
          ])
    ])

  const others = (list || []).filter(s => s.id !== sid)

  return (
    <section className="chat">
      <header className="chat-head">
        <button className="icon-btn back-btn" onClick={goHome} title="返回列表">
          <Icon name="left" size={18} />
        </button>
        <BotFace avatar={bot.avatar} mood={bot.status.mood} name={bot.name} size={36} />
        <div className="chat-title">
          <div className="chat-name">
            {bot.title || bot.name} <span className="handle">@{bot.name}</span>
          </div>
          <div className={cls('chat-status', bot.status.attention && 'warn')}>
            {bot.status.attention?.text || STATUS[bot.status.mood] || bot.description || '在线'}
          </div>
        </div>
        <div className="switcher">
          <button
            className="switcher-btn"
            onClick={() => {
              setSwitcher(!switcher)
              if (!switcher) void loadBotSessions(botName)
            }}
          >
            <Icon name={isBotChat ? 'msg' : 'thread'} size={14} />
            <span>{isBotChat ? 'Bot Chat' : session.title}</span>
            <Icon name="down" size={12} />
          </button>
          {switcher && (
            <div className="switcher-pop" onMouseLeave={() => setSwitcher(false)}>
              {[...(list || [])].map(s => (
                <button
                  className={cls('switcher-item', s.id === sid && 'on')}
                  key={s.id}
                  onClick={() => {
                    setSwitcher(false)
                    void openBot(botName, s.id)
                  }}
                >
                  <Icon name={s.kind === 'botchat' ? 'msg' : 'thread'} size={13} />
                  <span className="sw-title">{s.kind === 'botchat' ? 'Bot Chat（固定）' : s.title}</span>
                  <span className="sw-time">{ago(s.last_active)}</span>
                </button>
              ))}
              {!others.length && !list?.length && <div className="switcher-empty">加载中…</div>}
              <button
                className="switcher-item new"
                onClick={async () => {
                  setSwitcher(false)
                  const s = await api.post(`/api/bots/${botName}/sessions`, {})
                  await openBot(botName, s.id)
                }}
              >
                <Icon name="plus" size={13} /> 新聊天
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn" onClick={sessionMenu} title="更多">
          <Icon name="more" size={18} />
        </button>
        <button className={cls('icon-btn', rightOpen && 'on')} onClick={() => useStore.setState({ rightOpen: !rightOpen })} title="侧栏：定时任务与资料">
          <Icon name="panel" size={18} />
        </button>
      </header>
      <div
        className="chat-scroll"
        onScroll={e => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        ref={scroller}
      >
        <div className="chat-inner">
          {session.summary && (
            <details className="summary-card">
              <summary>
                <Icon name="compress" size={13} /> 更早的对话已压缩为摘要
              </summary>
              <div className="summary-body">{session.summary}</div>
            </details>
          )}
          {!visible.length && !session.running ? (
            <div className="chat-empty">
              <BotFace avatar={bot.avatar} name={bot.name} size={88} />
              <h2>{bot.title || bot.name}</h2>
              <p>{bot.description || '说点什么开始吧。'}</p>
              <div className="chips">
                {['你好，介绍一下你自己吧！', '你能帮我做些什么？', '记住：我习惯用中文交流'].map(t => (
                  <button className="chip" key={t} onClick={() => void send(t, [])}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageList bot={bot} messages={session.messages} pending={pending} running={session.running} stream={stream} />
          )}
          {elsewhere.map(p => (
            <button
              className="event waiting"
              key={p.id}
              onClick={() => (p.group_id ? void openGroup(p.group_id, p.thread && p.thread !== 'main' ? p.thread : null) : void openBot(botName, p.sid))}
            >
              <Icon name="hand" size={13} />
              {p.group_id ? `群聊「${groups[p.group_id]?.name || ''}」里` : '另一个聊天里'}在等你{p.kind === 'approval' ? '批准' : '回答'} · 打开
            </button>
          ))}
        </div>
      </div>
      <div className="chat-foot">
        <Composer
          autoFocusKey={sid}
          mentionables={mentionables}
          onSend={send}
          onStop={() => void api.post(`/api/sessions/${sid}/interrupt`)}
          placeholder={`给 ${bot.title || bot.name} 发消息…（@队友 可以让它转交，/ 查看命令）`}
          queued={session.queued}
          running={session.running}
          slash={SLASH}
        />
      </div>
      {menu.node}
    </section>
  )
}
