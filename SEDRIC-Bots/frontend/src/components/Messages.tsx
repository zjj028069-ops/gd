import { useState } from 'react'

import { api } from '../api'
import { findBot, openBot, openDialog, toast, useStore, type Stream } from '../store'
import type { Bot, Message, Pending, ToolCall } from '../types'
import { clock, cls, prettyJson } from '../utils'
import { BotFace } from './Avatar'
import { Icon } from './icons'
import { Markdown, Spinner } from './ui'

const DM_RE = /^Message from 🤖 (.+?) \(@([\w-]+)\): ?/
const REPLY_RE = /^\[message_agent 回执\] /

function parseArgs(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

const TOOL_ICON: Record<string, string> = {
  terminal: 'bolt', process: 'bolt', read_file: 'folder', write_file: 'edit', patch_file: 'edit', list_dir: 'folder',
  search_files: 'search', web_search: 'search', web_fetch: 'refresh', memory: 'brain', skill_view: 'sparkle',
  skill_manage: 'sparkle', message_agent: 'msg', cronjob: 'clock', clarify: 'hand'
}

export function toolSummary(name: string, raw: string) {
  const a = parseArgs(raw)
  switch (name) {
    case 'terminal':
      return `$ ${a.command || ''}`
    case 'process':
      return `后台进程 ${a.action || ''} ${a.process_id || ''}`
    case 'read_file':
      return `读取 ${a.path || ''}`
    case 'write_file':
      return `写入 ${a.path || ''}`
    case 'patch_file':
      return `修改 ${a.path || ''}`
    case 'list_dir':
      return `列出 ${a.path || '.'}`
    case 'search_files':
      return `搜索文件 ${a.pattern || a.glob || ''}`
    case 'web_search':
      return `搜索「${a.query || ''}」`
    case 'web_fetch':
      return `打开 ${a.url || ''}`
    case 'memory':
      return `${a.action === 'remove' ? '忘掉' : a.target === 'user' ? '记住（关于你）' : '记住'}：${a.content || a.old_text || ''}`
    case 'skill_view':
      return `加载技能「${a.name || ''}」`
    case 'skill_manage':
      return `${a.action === 'delete' ? '删除' : '保存'}技能「${a.name || ''}」`
    case 'message_agent':
      return `发消息给 @${a.target || ''}：${a.message || ''}`
    case 'cronjob':
      return `定时任务 · ${a.action || ''} ${a.name || a.job_id || ''} ${a.schedule || ''}`
    case 'clarify':
      return `问你：${a.question || ''}`
    default:
      if (name.startsWith('mcp_')) return `MCP · ${name.slice(4)}`
      return name
  }
}

function ToolCard({ call, result, running }: { call: ToolCall; result?: Message; running: boolean }) {
  const [open, setOpen] = useState(false)
  const name = call.function.name
  const isErr = !!result && /^\{"error"/.test(result.content || '')
  return (
    <div className={cls('tool', isErr && 'err', open && 'open')}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <Icon name={TOOL_ICON[name] || 'tool'} size={13} />
        <span className="tool-sum">{toolSummary(name, call.function.arguments)}</span>
        {running && !result ? <Spinner size={12} /> : isErr ? <Icon name="alert" size={13} /> : <Icon name="check" size={13} />}
        <Icon className={cls('caret', !open && 'closed')} name="down" size={12} />
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">参数</div>
          <pre>{prettyJson(call.function.arguments)}</pre>
          {result && (
            <>
              <div className="tool-label">结果</div>
              <pre>{prettyJson(result.content)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Reasoning({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className={cls('reasoning', open && 'open')}>
      <button onClick={() => setOpen(!open)}>
        <Icon name="brain" size={13} />
        {live ? '正在思考…' : '思考过程'}
        <Icon className={cls('caret', !open && 'closed')} name="down" size={12} />
      </button>
      {(open || live) && <div className={cls('reasoning-body', live && !open && 'tail')}>{live && !open ? text.slice(-280) : text}</div>}
    </div>
  )
}

function Attachments({ m }: { m: Message }) {
  if (!m.attachments?.length) return null
  return (
    <div className="msg-atts">
      {m.attachments.map(a =>
        a.kind === 'image' ? (
          <a href={a.url} key={a.file} rel="noreferrer" target="_blank">
            <img alt={a.name} src={a.url} />
          </a>
        ) : (
          <a className="file-chip" href={a.url} key={a.file} rel="noreferrer" target="_blank">
            <Icon name="clip" size={13} /> {a.name}
          </a>
        )
      )}
    </div>
  )
}

export function PendingCard({ p, compact }: { p: Pending; compact?: boolean }) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (body: object) => {
    setBusy(true)
    try {
      await api.post(`/api/pending/${p.id}`, body)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  if (p.kind === 'approval') {
    return (
      <div className="pending approval">
        <div className="pending-head">
          <Icon name="alert" size={15} /> {compact ? `${p.bot_title}：` : ''}需要你批准 · {p.title}
        </div>
        <pre className="pending-detail">{p.detail}</pre>
        <div className="pending-actions">
          <button className="btn danger-ghost" disabled={busy} onClick={() => void send({ approve: false })}>
            拒绝
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void send({ approve: true })}>
            批准执行
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="pending clarify">
      <div className="pending-head">
        <Icon name="hand" size={15} /> {compact ? `${p.bot_title} 问你：` : ''}
        {p.title}
      </div>
      {!!p.choices?.length && (
        <div className="pending-choices">
          {p.choices.map(c => (
            <button className="btn" disabled={busy} key={c} onClick={() => void send({ answer: c })}>
              {c}
            </button>
          ))}
        </div>
      )}
      <form
        className="pending-answer"
        onSubmit={e => {
          e.preventDefault()
          if (answer.trim()) void send({ answer: answer.trim() })
        }}
      >
        <input onChange={e => setAnswer(e.target.value)} placeholder="或者直接输入你的回答…" value={answer} />
        <button className="btn primary" disabled={busy || !answer.trim()}>
          回答
        </button>
      </form>
    </div>
  )
}

function ErrorEvent({ m }: { m: Message }) {
  const fix = ['config', 'auth', 'quota', 'network'].includes(m.error_kind || '')
  return (
    <div className="event error">
      <Icon name="alert" size={14} />
      <span>{m.content}</span>
      {fix && (
        <button className="link" onClick={() => openDialog({ kind: 'settings', tab: 'models' })}>
          去设置模型
        </button>
      )}
    </div>
  )
}

interface ListProps {
  bot: Bot
  messages: Message[]
  stream?: Stream
  running: boolean
  pending: Pending[]
}

export function MessageList({ bot, messages, stream, running, pending }: ListProps) {
  const bots = useStore(s => s.bots)
  const userName = useStore(s => s.settings?.user_name) || '你'
  const results = new Map<string, Message>()
  for (const m of messages) if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, m)

  const out: JSX.Element[] = []
  let lastSpeaker = ''
  for (const m of messages) {
    if (m.role === 'tool') continue
    if (m.role === 'event') {
      lastSpeaker = ''
      out.push(
        m.kind === 'error' ? (
          <ErrorEvent key={m.id} m={m} />
        ) : (
          <div className={cls('event', m.kind)} key={m.id}>
            <span>{m.content}</span>
          </div>
        )
      )
      continue
    }
    if (m.role === 'user') {
      const from = m.from || { kind: 'user' }
      if (from.kind === 'bot' && from.name) {
        const peer = findBot(bots, from.name)
        const reply = REPLY_RE.test(m.content)
        const body = reply ? m.content.replace(REPLY_RE, '').replace(/^.*?\n/, '') : m.content.replace(DM_RE, '')
        lastSpeaker = ''
        out.push(
          <div className={cls('dm-card', reply && 'reply')} key={m.id}>
            <div className="dm-head">
              <button className="dm-who" onClick={() => peer && void openBot(peer.name)}>
                <BotFace avatar={peer?.avatar} name={peer?.name || from.name} size={20} still />
                <b>{peer?.title || from.name}</b>
              </button>
              <span>{reply ? '回复了你之前的消息' : '给你发来消息'}</span>
              <span className="msg-time">{clock(m.at)}</span>
            </div>
            <Markdown text={body} />
          </div>
        )
        continue
      }
      if (from.kind === 'routine' || from.kind === 'group') {
        lastSpeaker = ''
        out.push(
          <div className="event routine" key={m.id}>
            <Icon name={from.kind === 'routine' ? 'clock' : 'users'} size={13} />
            <span>{from.kind === 'routine' ? `定时任务「${from.name}」触发` : `群聊「${from.name}」的新消息`}</span>
            <details>
              <summary>查看输入</summary>
              <pre>{m.content}</pre>
            </details>
          </div>
        )
        continue
      }
      lastSpeaker = 'user'
      out.push(
        <div className="msg user" key={m.id}>
          <div className="bubble">
            <Attachments m={m} />
            {m.content && <div className="user-text">{m.content}</div>}
          </div>
          <div className="msg-meta">
            {userName} · {clock(m.at)}
          </div>
        </div>
      )
      continue
    }
    // assistant
    const routine = m.meta?.kind === 'routine'
    const showHead = lastSpeaker !== 'bot' || routine
    lastSpeaker = 'bot'
    out.push(
      <div className={cls('msg bot', !showHead && 'cont', routine && 'routine')} key={m.id}>
        <div className="msg-face">{showHead && <BotFace avatar={bot.avatar} name={bot.name} size={28} still />}</div>
        <div className="msg-body">
          {showHead && (
            <div className="msg-head">
              <b>{bot.title || bot.name}</b>
              {routine && (
                <span className="tag">
                  <Icon name="clock" size={11} /> 定时任务「{m.meta?.job_name}」
                </span>
              )}
              <span className="msg-time">{clock(m.at)}</span>
            </div>
          )}
          {m.reasoning && <Reasoning text={m.reasoning} />}
          {m.content && (
            <div className="bot-bubble">
              <Markdown text={m.content} />
            </div>
          )}
          {m.tool_calls?.map(c => <ToolCard call={c} key={c.id} result={results.get(c.id)} running={running} />)}
        </div>
      </div>
    )
  }

  const live = running && stream && (stream.text || stream.reasoning)
  return (
    <>
      {out}
      {live && (
        <div className={cls('msg bot', lastSpeaker === 'bot' && 'cont')}>
          <div className="msg-face">{lastSpeaker !== 'bot' && <BotFace avatar={bot.avatar} mood="think" name={bot.name} size={28} still />}</div>
          <div className="msg-body">
            {lastSpeaker !== 'bot' && (
              <div className="msg-head">
                <b>{bot.title || bot.name}</b>
              </div>
            )}
            {stream!.reasoning && <Reasoning live={!stream!.text} text={stream!.reasoning} />}
            {stream!.text && (
              <div className="bot-bubble">
                <Markdown text={stream!.text + ' ▍'} />
              </div>
            )}
          </div>
        </div>
      )}
      {running && !live && !pending.length && (
        <div className="typing">
          <BotFace avatar={bot.avatar} mood={bot.status.mood === 'work' ? 'work' : 'think'} name={bot.name} size={26} />
          <span>{bot.status.mood === 'work' ? '正在执行工具…' : `${bot.title || bot.name} 正在思考…`}</span>
        </div>
      )}
      {pending.map(p => (
        <PendingCard key={p.id} p={p} />
      ))}
    </>
  )
}
