import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../api'
import { confirm, findBot, goHome, openBot, openDialog, openGroup, toast, useStore } from '../store'
import type { Attachment, GroupEntry } from '../types'
import { clock, cls } from '../utils'
import { BotFace, GroupFace } from './Avatar'
import { Composer } from './Composer'
import { Icon } from './icons'
import { PendingCard } from './Messages'
import { Markdown, useMenu } from './ui'

const MAIN = 'main'

const ACT: Record<string, { icon: string; label: string }> = {
  turn: { icon: 'brain', label: '开始思考' },
  reply: { icon: 'msg', label: '发言' },
  pass: { icon: 'right', label: '跳过' },
  failed: { icon: 'alert', label: '出错' },
  settled: { icon: 'check', label: '讨论结束' },
  capped: { icon: 'stop', label: '达到上限' },
  stopped: { icon: 'stop', label: '已停止' },
  hold: { icon: 'pause', label: '暂停/恢复' }
}

function highlight(text: string) {
  return text.replace(/(^|\s)@([\w一-鿿.-]+)/g, '$1**@$2**')
}

export function GroupView({ id, thread }: { id: string; thread: string | null }) {
  const room = useStore(s => s.rooms[id])
  const bots = useStore(s => s.bots)
  const pendingAll = useStore(s => s.pending)
  const userName = useStore(s => s.settings?.user_name) || '你'
  const [showActivity, setShowActivity] = useState(false)
  const menu = useMenu()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const threadScroller = useRef<HTMLDivElement>(null)

  const avatars = useMemo(() => Object.fromEntries(Object.values(bots).map(b => [b.name, b.avatar])), [bots])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
    const t = threadScroller.current
    if (t) t.scrollTop = t.scrollHeight
  })

  if (!room) return <div className="center-note">正在打开群聊…</div>

  const pending = pendingAll.filter(p => p.group_id === id)
  const main = room.log.filter(e => (e.thread || MAIN) === MAIN)
  const replies = new Map<string, GroupEntry[]>()
  for (const e of room.log) {
    if (e.thread && e.thread !== MAIN) replies.set(e.thread, [...(replies.get(e.thread) || []), e])
  }
  const mentionables = room.members
    .filter(m => bots[m])
    .map(m => ({ name: m, title: bots[m].title || m, avatar: bots[m].avatar, meta: bots[m].title || m }))
  const runningMain = room.running.includes(MAIN)
  const runningThread = thread ? room.running.includes(thread) : false

  const send = (t: string | null) => async (text: string, attachments: Attachment[]) => {
    stick.current = true
    await api.post(`/api/groups/${id}/messages`, { text, attachments, thread: t })
  }
  const stop = (t: string | null) => () => void api.post(`/api/groups/${id}/stop`, { thread: t })

  const speaking = (t: string) => {
    const m = room.active?.[t]
    if (!m) return null
    const b = bots[m]
    return (
      <div className="typing">
        <BotFace avatar={b?.avatar} mood={b?.status.mood === 'work' ? 'work' : 'think'} name={m} size={26} />
        <span>{b?.title || m} 正在发言…</span>
      </div>
    )
  }

  const entry = (e: GroupEntry, prev: GroupEntry | undefined, inThread = false) => {
    if (e.from.kind === 'system') {
      return (
        <div className="event" key={e.id}>
          <span>{e.text}</span>
        </div>
      )
    }
    const kids = inThread ? [] : replies.get(e.id) || []
    const actions = !inThread && (
      <button className="entry-action" onClick={() => void openGroup(id, e.id)} title="在讨论串中回复">
        <Icon name="thread" size={13} /> 回复
      </button>
    )
    const threadLink = kids.length > 0 && (
      <button className="thread-link" onClick={() => void openGroup(id, e.id)}>
        <span className="thread-faces">
          {[...new Set(kids.map(k => k.from.name))].slice(0, 3).map(n =>
            findBot(bots, n) ? <BotFace avatar={findBot(bots, n)!.avatar} key={n} name={n} size={16} still /> : <span className="me-dot" key={n} />
          )}
        </span>
        {kids.length} 条回复 · 最新 {clock(kids[kids.length - 1].at)}
      </button>
    )
    if (e.from.kind === 'user') {
      return (
        <div className="msg user" key={e.id}>
          <div className="bubble">
            {e.attachments?.length ? (
              <div className="msg-atts">
                {e.attachments.map(a =>
                  a.kind === 'image' ? <img alt="" key={a.file} src={a.url} /> : <span className="file-chip" key={a.file}><Icon name="clip" size={12} /> {a.name}</span>
                )}
              </div>
            ) : null}
            <div className="user-text">{e.text}</div>
          </div>
          <div className="msg-meta">
            {actions}
            {e.from.name || userName} · {clock(e.at)}
          </div>
          {threadLink}
        </div>
      )
    }
    const b = findBot(bots, e.from.name)
    const cont = prev && prev.from.kind === 'member' && prev.from.name === e.from.name && e.at - prev.at < 5 * 60_000
    return (
      <div className={cls('msg bot', cont && 'cont')} key={e.id}>
        <div className="msg-face">
          {!cont && (
            <button className="face-btn" onClick={() => b && void openBot(b.name)} title={`打开 ${b?.title || e.from.name} 的 Bot Chat`}>
              <BotFace avatar={b?.avatar} name={b?.name || e.from.name} size={28} still />
            </button>
          )}
        </div>
        <div className="msg-body">
          {!cont && (
            <div className="msg-head">
              <b>{b?.title || e.from.name}</b>
              <span className="handle">@{b?.name || e.from.name}</span>
              <span className="msg-time">{clock(e.at)}</span>
              {actions}
            </div>
          )}
          <div className="bot-bubble">
            <Markdown text={highlight(e.text)} />
          </div>
          {threadLink}
        </div>
      </div>
    )
  }

  const root = thread ? room.log.find(e => e.id === thread) : null
  const threadEntries = thread ? replies.get(thread) || [] : []
  const act = room.activity.slice(-50).reverse()

  const moreMenu = (e: React.MouseEvent) =>
    menu.open(e, [
      { label: '管理群聊…', icon: 'users', onClick: () => openDialog({ kind: 'manageGroup', id }) },
      {
        label: '压缩历史',
        icon: 'compress',
        onClick: async () => {
          const r = await api.post(`/api/groups/${id}/compress`)
          toast(`已压缩 ${r.sessions} 个成员会话`, 'success')
        }
      },
      {
        label: room.hold_detection ? '关闭「停止指令」检测' : '开启「停止指令」检测',
        icon: 'hand',
        onClick: () => void api.patch(`/api/groups/${id}`, { hold_detection: !room.hold_detection })
      },
      { divider: true, label: '' },
      {
        label: '解散群聊…',
        icon: 'trash',
        danger: true,
        onClick: () => confirm('解散群聊？', `「${room.name}」的聊天记录会被删除，成员机器人本身不受影响。`, '解散', async () => void (await api.del(`/api/groups/${id}`)))
      }
    ])

  return (
    <section className="chat group">
      <header className="chat-head">
        <button className="icon-btn back-btn" onClick={goHome} title="返回列表">
          <Icon name="left" size={18} />
        </button>
        <GroupFace avatars={avatars} image={room.image} members={room.members} size={36} />
        <div className="chat-title">
          <div className="chat-name">{room.name}</div>
          <div className="member-strip">
            {room.members.map(m => {
              const b = bots[m]
              const held = room.holds.includes(m)
              const active = Object.values(room.active || {}).includes(m)
              return (
                <button className={cls('member', held && 'held', active && 'active')} key={m} onClick={() => b && void openBot(m)} title={`${b?.title || m}${held ? '（已暂停）' : ''}`}>
                  <BotFace avatar={b?.avatar} mood={active ? 'think' : 'idle'} name={m} size={20} still={!active} />
                  {held && <Icon className="held-icon" name="pause" size={9} />}
                </button>
              )
            })}
          </div>
        </div>
        <button className={cls('icon-btn', showActivity && 'on')} onClick={() => setShowActivity(!showActivity)} title="显示房间活动">
          <Icon name="bolt" size={18} />
        </button>
        <button className="icon-btn" onClick={() => openDialog({ kind: 'manageGroup', id })} title="管理群聊">
          <Icon name="users" size={18} />
        </button>
        <button className="icon-btn" onClick={moreMenu} title="更多">
          <Icon name="more" size={18} />
        </button>
      </header>
      <div className="group-body">
        <div className="group-main">
          <div
            className="chat-scroll"
            onScroll={e => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            ref={scroller}
          >
            <div className="chat-inner">
              {!main.length ? (
                <div className="chat-empty">
                  <GroupFace avatars={avatars} image={room.image} members={room.members} size={80} />
                  <h2>{room.name}</h2>
                  <p>说点什么 — 群里的每个机器人都会听到。用 @名字 点名，@all 叫所有人；发「@名字 停」可以让它暂停。</p>
                </div>
              ) : (
                main.map((e, i) => entry(e, main[i - 1]))
              )}
              {speaking(MAIN)}
              {pending
                .filter(p => p.thread && p.thread !== MAIN && p.thread !== thread)
                .map(p => (
                  <button className="event waiting" key={'w' + p.id} onClick={() => void openGroup(id, p.thread!)}>
                    <Icon name="hand" size={13} /> 讨论串里 {p.bot_title} 在等你{p.kind === 'approval' ? '批准' : '回答'} · 打开
                  </button>
                ))}
              {pending.filter(p => (p.thread || MAIN) === MAIN).map(p => (
                <PendingCard compact key={p.id} p={p} />
              ))}
            </div>
          </div>
          {room.holds.length > 0 && (
            <div className="hold-banner">
              <Icon name="pause" size={13} /> 已暂停：{room.holds.map(m => bots[m]?.title || m).join('、')} — 提及它们，或发送 <code>@all resume</code> 恢复
            </div>
          )}
          <div className="chat-foot">
            <Composer
              autoFocusKey={id}
              dropLabel="松开以附加 — 每个回应的机器人都能看到"
              everyone
              mentionables={mentionables}
              onSend={send(null)}
              onStop={stop(MAIN)}
              placeholder="说点什么 — 这个群里的每个机器人都会听到。"
              running={runningMain}
            />
          </div>
        </div>
        {thread && root && (
          <aside className="thread-pane">
            <div className="pane-head">
              <Icon name="thread" size={15} /> <b>讨论串</b>
              <button className="icon-btn" onClick={() => void openGroup(id, null)} title="收起讨论串">
                <Icon name="x" />
              </button>
            </div>
            <div className="chat-scroll" ref={threadScroller}>
              <div className="chat-inner">
                {entry(root, undefined, true)}
                <div className="thread-sep">{threadEntries.length} 条回复</div>
                {threadEntries.map((e, i) => entry(e, threadEntries[i - 1], true))}
                {speaking(thread)}
                {pending.filter(p => p.thread === thread).map(p => (
                  <PendingCard compact key={p.id} p={p} />
                ))}
              </div>
            </div>
            <div className="chat-foot">
              <Composer
                autoFocusKey={thread}
                everyone
                mentionables={mentionables}
                onSend={send(thread)}
                onStop={stop(thread)}
                placeholder="在讨论串中回复…"
                running={runningThread}
              />
            </div>
          </aside>
        )}
        {showActivity && (
          <aside className="activity-pane">
            <div className="pane-head">
              <Icon name="bolt" size={15} /> <b>房间活动</b>
              <button className="icon-btn" onClick={() => setShowActivity(false)}>
                <Icon name="x" />
              </button>
            </div>
            <div className="activity-list">
              {!act.length && <div className="muted pad">本回合还没有活动。</div>}
              {act.map((a, i) => {
                const meta = ACT[a.kind] || { icon: 'more', label: a.kind }
                const b = a.member ? findBot(bots, a.member) : null
                return (
                  <div className={cls('act', a.kind)} key={i}>
                    <Icon name={meta.icon} size={13} />
                    <div>
                      <div>
                        {b ? <b>{b.title || a.member} </b> : null}
                        {meta.label}
                        {a.thread && a.thread !== MAIN && <span className="tag">讨论串</span>}
                        <span className="act-time">{clock(a.at)}</span>
                      </div>
                      {a.text && <div className="act-text">{a.text}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          </aside>
        )}
      </div>
      {menu.node}
    </section>
  )
}
