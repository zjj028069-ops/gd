import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { upload } from '../api'
import { toast } from '../store'
import type { Attachment, Avatar } from '../types'
import { bytes, cls } from '../utils'
import { BotFace } from './Avatar'
import { Icon } from './icons'
import { Spinner } from './ui'

export interface Mentionable {
  name: string
  title: string
  avatar?: Avatar
  meta?: string
}

interface Props {
  placeholder: string
  running?: boolean
  queued?: number
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
  onStop?: () => void
  mentionables: Mentionable[]
  everyone?: boolean
  slash?: { cmd: string; desc: string }[]
  autoFocusKey?: string
  dropLabel?: string
}

interface Popover {
  kind: '@' | '/'
  start: number
  query: string
  index: number
}

export function Composer({ placeholder, running, queued, onSend, onStop, mentionables, everyone, slash, autoFocusKey, dropLabel }: Props) {
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [pop, setPop] = useState<Popover | null>(null)
  const [drag, setDrag] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileIn = useRef<HTMLInputElement>(null)
  const sending = useRef(false)

  useEffect(() => {
    ta.current?.focus()
  }, [autoFocusKey])

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
    el.style.overflowY = el.scrollHeight > 260 ? 'auto' : 'hidden'
  }, [text])

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploading(n => n + 1)
      try {
        const a = await upload(f)
        setAtts(prev => [...prev, a])
      } catch (e: any) {
        toast(e.message, 'error')
      } finally {
        setUploading(n => n - 1)
      }
    }
  }

  const options: { insert: string; label: string; meta: string; m?: Mentionable }[] = (() => {
    if (!pop) return []
    const q = pop.query.toLowerCase()
    if (pop.kind === '/') return (slash || []).filter(s => s.cmd.slice(1).startsWith(q)).map(s => ({ insert: s.cmd + ' ', label: s.cmd, meta: s.desc }))
    const list: { insert: string; label: string; meta: string; m?: Mentionable }[] = []
    if (everyone && ('all'.startsWith(q) || 'everyone'.startsWith(q) || '所有人'.startsWith(q))) {
      list.push({ insert: '@all ', label: '@all', meta: '房间里的所有机器人' })
    }
    for (const m of mentionables) {
      if (!q || m.name.startsWith(q) || m.title.toLowerCase().startsWith(q)) {
        list.push({ insert: `@${m.name} `, label: `@${m.name}`, meta: m.meta || m.title, m })
      }
    }
    return list.slice(0, 8)
  })()

  const detect = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const at = /(^|\s)@([\w一-鿿-]*)$/.exec(before)
    if (at) {
      setPop(p => ({ kind: '@', start: caret - at[2].length - 1, query: at[2], index: p?.kind === '@' ? p.index : 0 }))
      return
    }
    const sl = /^\/(\w*)$/.exec(before)
    if (sl && slash?.length) {
      setPop({ kind: '/', start: 0, query: sl[1], index: 0 })
      return
    }
    setPop(null)
  }

  const choose = (i: number) => {
    const opt = options[i]
    if (!opt || !pop || !ta.current) return
    const caret = ta.current.selectionStart
    const next = text.slice(0, pop.start) + opt.insert + text.slice(caret)
    setText(next)
    setPop(null)
    requestAnimationFrame(() => {
      const pos = pop.start + opt.insert.length
      ta.current?.setSelectionRange(pos, pos)
      ta.current?.focus()
    })
  }

  const send = async () => {
    const t = text.trim()
    if ((!t && !atts.length) || uploading || sending.current) return
    sending.current = true
    try {
      await onSend(t, atts)
      setText('')
      setAtts([])
      setPop(null)
    } catch (e: any) {
      toast(e.message || String(e), 'error')
    } finally {
      sending.current = false
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pop && options.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPop({ ...pop, index: (pop.index + 1) % options.length })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPop({ ...pop, index: (pop.index - 1 + options.length) % options.length })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        choose(pop.index)
        return
      }
      if (e.key === 'Escape') {
        setPop(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div
      className={cls('composer', drag && 'drag')}
      onDragLeave={() => setDrag(false)}
      onDragOver={e => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDrag(true)
        }
      }}
      onDrop={e => {
        if (e.dataTransfer.files.length) {
          e.preventDefault()
          setDrag(false)
          void addFiles(e.dataTransfer.files)
        }
      }}
    >
      {drag && <div className="composer-drop">{dropLabel || '松开即可附加文件'}</div>}
      {pop && options.length > 0 && (
        <div className="popover">
          {options.map((o, i) => (
            <button
              className={cls('pop-item', i === pop.index && 'on')}
              key={o.label}
              onMouseDown={e => {
                e.preventDefault()
                choose(i)
              }}
            >
              {o.m ? <BotFace avatar={o.m.avatar} name={o.m.name} size={20} still /> : <Icon name={pop.kind === '/' ? 'bolt' : 'users'} size={14} />}
              <span className="pop-label">{o.label}</span>
              <span className="pop-meta">{o.meta}</span>
            </button>
          ))}
        </div>
      )}
      {(atts.length > 0 || uploading > 0) && (
        <div className="att-row">
          {atts.map((a, i) => (
            <span className="att" key={a.file}>
              {a.kind === 'image' ? <img alt="" src={a.url} /> : <Icon name="clip" size={14} />}
              <span className="att-name">{a.name}</span>
              <span className="att-size">{bytes(a.size)}</span>
              <button onClick={() => setAtts(atts.filter((_, j) => j !== i))} title="移除附件">
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="att">
              <Spinner /> 上传中…
            </span>
          )}
        </div>
      )}
      <div className="composer-row">
        <button className="icon-btn" onClick={() => fileIn.current?.click()} title="附加文件">
          <Icon name="clip" size={18} />
        </button>
        <input
          hidden
          multiple
          onChange={e => {
            if (e.target.files) void addFiles(e.target.files)
            e.target.value = ''
          }}
          ref={fileIn}
          type="file"
        />
        <textarea
          onChange={e => {
            setText(e.target.value)
            detect(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={onKey}
          onPaste={e => {
            const files = Array.from(e.clipboardData.files)
            if (files.length) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
          placeholder={placeholder}
          ref={ta}
          rows={1}
          value={text}
        />
        {running && onStop && (
          <button className="icon-btn stop" onClick={onStop} title="停止">
            <Icon name="stop" size={16} />
          </button>
        )}
        <button className="send-btn" disabled={(!text.trim() && !atts.length) || uploading > 0} onClick={() => void send()} title="发送（Enter）">
          <Icon name="up" size={17} stroke={2.4} />
        </button>
      </div>
      {(running || !!queued) && (
        <div className="composer-hint">
          {queued ? `还有 ${queued} 条消息在排队，会在当前回合结束后依次处理` : '正在回复中… 现在发的消息会排队等待'}
        </div>
      )}
    </div>
  )
}
