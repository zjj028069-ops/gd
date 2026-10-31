import { create } from 'zustand'

import { api } from './api'
import type {
  Bot,
  Group,
  GroupSummary,
  Message,
  Pending,
  Session,
  SessionPreview,
  Settings,
  UiState,
  View
} from './types'

export interface Stream {
  stream: string
  text: string
  reasoning: string
}

export interface Toast {
  id: number
  text: string
  level: 'info' | 'error' | 'success'
  bot?: string
}

export type Dialog =
  | { kind: 'createBot'; section?: string | null }
  | { kind: 'editBot'; bot: string; tab?: string }
  | { kind: 'settings'; tab?: string }
  | { kind: 'createGroup'; members?: string[] }
  | { kind: 'manageGroup'; id: string }
  | { kind: 'cron'; bot: string; jobId?: string }
  | { kind: 'confirm'; title: string; body: string; danger?: boolean; action: string; onConfirm: () => void | Promise<void> }
  | { kind: 'prompt'; title: string; label: string; value: string; onSubmit: (v: string) => void | Promise<void> }

interface State {
  ready: boolean
  connected: boolean
  settings: Settings | null
  bots: Record<string, Bot>
  groups: Record<string, GroupSummary>
  ui: UiState
  pending: Pending[]
  toolLabels: Record<string, string>
  view: View
  sessions: Record<string, Session>
  botSessions: Record<string, SessionPreview[]>
  rooms: Record<string, Group>
  streams: Record<string, Stream>
  toasts: Toast[]
  dialog: Dialog | null
  /** Confirm / prompt boxes stack on top of whatever dialog is open. */
  overlay: Dialog | null
  rightOpen: boolean
  versions: Record<string, number>
  search: string
  filter: 'all' | 'bots' | 'groups'
  showHidden: boolean
}

export const useStore = create<State>(() => ({
  ready: false,
  connected: false,
  settings: null,
  bots: {},
  groups: {},
  ui: { sections: [], collapsed: [] },
  pending: [],
  toolLabels: {},
  view: { kind: 'home' },
  sessions: {},
  botSessions: {},
  rooms: {},
  streams: {},
  toasts: [],
  dialog: null,
  overlay: null,
  rightOpen: typeof window === 'undefined' || window.innerWidth > 1180,
  versions: {},
  search: '',
  filter: 'all',
  showHidden: false
}))

const set = useStore.setState
const get = useStore.getState

let toastSeq = 1

export function toast(text: string, level: Toast['level'] = 'info', bot?: string) {
  const id = toastSeq++
  set(s => ({ toasts: [...s.toasts, { id, text, level, bot }].slice(-5) }))
  setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), level === 'error' ? 7000 : 4000)
}

export function bump(key: string) {
  set(s => ({ versions: { ...s.versions, [key]: (s.versions[key] || 0) + 1 } }))
}

export function openDialog(d: Dialog | null) {
  set({ dialog: d })
}

export function confirm(title: string, body: string, action: string, onConfirm: () => void | Promise<void>, danger = true) {
  set({ overlay: { kind: 'confirm', title, body, action, onConfirm, danger } })
}

export function promptText(title: string, label: string, value: string, onSubmit: (v: string) => void | Promise<void>) {
  set({ overlay: { kind: 'prompt', title, label, value, onSubmit } })
}

export function closeOverlay() {
  set({ overlay: null })
}

export async function loadState() {
  const st = await api.get('/api/state')
  const bots: Record<string, Bot> = {}
  for (const b of st.bots) bots[b.name] = b
  const groups: Record<string, GroupSummary> = {}
  for (const g of st.groups) groups[g.id] = g
  set({ settings: st.settings, bots, groups, ui: st.ui, pending: st.pending, toolLabels: st.tool_labels, ready: true })
  applyTheme(st.settings?.theme)
  // Refresh whatever is on screen after a reconnect.
  const v = get().view
  if (v.kind === 'bot' && v.sid) void loadSession(v.sid)
  if (v.kind === 'group') void loadRoom(v.id)
}

export function applyTheme(theme?: string) {
  const t = theme || 'light'
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

export async function loadSession(sid: string) {
  const s = await api.get<Session>(`/api/sessions/${sid}`)
  set(st => ({ sessions: { ...st.sessions, [sid]: s } }))
  return s
}

export async function loadBotSessions(bot: string) {
  const list = await api.get<SessionPreview[]>(`/api/bots/${bot}/sessions`)
  set(st => ({ botSessions: { ...st.botSessions, [bot]: list } }))
}

export async function loadRoom(id: string) {
  const g = await api.get<Group>(`/api/groups/${id}`)
  set(st => ({ rooms: { ...st.rooms, [id]: g } }))
  return g
}

export async function openBot(bot: string, sid?: string | null) {
  let target = sid || null
  if (!target) {
    const s = await api.post<Session>(`/api/bots/${bot}/botchat`)
    set(st => ({ sessions: { ...st.sessions, [s.id]: s } }))
    target = s.id
  } else {
    await loadSession(target)
  }
  set({ view: { kind: 'bot', bot, sid: target } })
  void loadBotSessions(bot)
  void api.post(`/api/sessions/${target}/read`).catch(() => {})
}

export async function openGroup(id: string, thread: string | null = null) {
  set({ view: { kind: 'group', id, thread } })
  await loadRoom(id)
  void api.post(`/api/groups/${id}/read`).catch(() => {})
}

export function goHome() {
  set({ view: { kind: 'home' } })
}

// ── live events ──────────────────────────────────────────────────────────────

function patchSession(sid: string, fn: (s: Session) => Session) {
  const s = get().sessions[sid]
  if (s) set(st => ({ sessions: { ...st.sessions, [sid]: fn(s) } }))
}

function handle(ev: any) {
  switch (ev.type) {
    case 'hello':
      set({ connected: true })
      void loadState()
      break
    case 'bot':
      set(s => ({ bots: { ...s.bots, [ev.bot.name]: ev.bot } }))
      break
    case 'bot_removed': {
      set(s => {
        const bots = { ...s.bots }
        delete bots[ev.bot]
        const view = s.view.kind === 'bot' && s.view.bot === ev.bot ? ({ kind: 'home' } as View) : s.view
        return { bots, view }
      })
      break
    }
    case 'bot_status':
      set(s => (s.bots[ev.bot] ? { bots: { ...s.bots, [ev.bot]: { ...s.bots[ev.bot], status: ev.status } } } : {}))
      break
    case 'session_meta': {
      const p: SessionPreview = ev.session
      set(s => {
        const out: Partial<State> = {}
        const b = s.bots[ev.bot]
        if (b && p.kind === 'botchat') out.bots = { ...s.bots, [ev.bot]: { ...b, chat: p } }
        const list = s.botSessions[ev.bot]
        if (list && !p.hidden) {
          const others = list.filter(x => x.id !== p.id)
          out.botSessions = { ...s.botSessions, [ev.bot]: [p, ...others].sort(sortSessions) }
        }
        if (s.sessions[p.id]) out.sessions = { ...s.sessions, [p.id]: { ...s.sessions[p.id], ...p } }
        return out
      })
      break
    }
    case 'session_deleted':
      set(s => ({
        botSessions: { ...s.botSessions, [ev.bot]: (s.botSessions[ev.bot] || []).filter(x => x.id !== ev.sid) }
      }))
      break
    case 'message': {
      const m: Message = ev.message
      patchSession(ev.sid, s => (s.messages.some(x => x.id === m.id) ? s : { ...s, messages: [...s.messages, m] }))
      if (m.role === 'assistant' && m.stream) {
        const cur = get().streams[ev.sid]
        if (cur && cur.stream === m.stream) {
          set(st => {
            const streams = { ...st.streams }
            delete streams[ev.sid]
            return { streams }
          })
        }
      }
      // A bot's message arriving while you're looking at that chat counts as read.
      const v = get().view
      if (v.kind === 'bot' && v.sid === ev.sid && m.role === 'assistant' && document.visibilityState === 'visible') {
        void api.post(`/api/sessions/${ev.sid}/read`).catch(() => {})
      }
      break
    }
    case 'delta': {
      set(st => {
        const cur = st.streams[ev.sid]
        const base = cur && cur.stream === ev.stream ? cur : { stream: ev.stream, text: '', reasoning: '' }
        const next =
          ev.kind === 'reasoning' ? { ...base, reasoning: base.reasoning + ev.text } : { ...base, text: base.text + ev.text }
        return { streams: { ...st.streams, [ev.sid]: next } }
      })
      break
    }
    case 'turn':
      patchSession(ev.sid, s => ({ ...s, running: ev.running, queued: ev.queued, phase: ev.phase }))
      if (!ev.running) {
        set(st => {
          if (!st.streams[ev.sid]) return {}
          const streams = { ...st.streams }
          delete streams[ev.sid]
          return { streams }
        })
      }
      break
    case 'pending':
      set({ pending: ev.items })
      break
    case 'group':
      set(s => {
        const out: Partial<State> = { groups: { ...s.groups, [ev.id]: ev.summary } }
        if (s.rooms[ev.id]) out.rooms = { ...s.rooms, [ev.id]: { ...s.rooms[ev.id], ...ev.summary } }
        return out
      })
      break
    case 'group_entry': {
      set(s => {
        const r = s.rooms[ev.id]
        if (!r || r.log.some(e => e.id === ev.entry.id)) return {}
        return { rooms: { ...s.rooms, [ev.id]: { ...r, log: [...r.log, ev.entry] } } }
      })
      const v = get().view
      if (v.kind === 'group' && v.id === ev.id && ev.entry.from?.kind === 'member' && document.visibilityState === 'visible') {
        void api.post(`/api/groups/${ev.id}/read`).catch(() => {})
      }
      break
    }
    case 'group_activity':
      set(s => {
        const r = s.rooms[ev.id]
        if (!r) return {}
        return { rooms: { ...s.rooms, [ev.id]: { ...r, activity: [...r.activity, ev.activity].slice(-80) } } }
      })
      break
    case 'group_deleted':
      set(s => {
        const groups = { ...s.groups }
        delete groups[ev.id]
        const view = s.view.kind === 'group' && s.view.id === ev.id ? ({ kind: 'home' } as View) : s.view
        return { groups, view }
      })
      break
    case 'cron':
      bump('cron:' + ev.bot)
      break
    case 'bot_memory':
    case 'bot_skills':
      bump('detail:' + ev.bot)
      break
    case 'ui':
      set({ ui: ev.ui })
      break
    case 'settings':
      set({ settings: ev.settings })
      applyTheme(ev.settings?.theme)
      break
    case 'toast':
      toast(ev.text, ev.level)
      break
    case 'dm': {
      const bots = get().bots
      const from = bots[ev.sender]?.title || ev.sender
      const to = bots[ev.target]?.title || ev.target
      toast(ev.phase === 'sent' ? `${from} → ${to}：${ev.text}` : `${from} 回复了 ${to}`, 'info', ev.sender)
      break
    }
  }
}

function sortSessions(a: SessionPreview, b: SessionPreview) {
  if (a.kind === 'botchat') return -1
  if (b.kind === 'botchat') return 1
  return (b.last_active || 0) - (a.last_active || 0)
}

export function connect() {
  const es = new EventSource('/api/events')
  es.onmessage = e => {
    try {
      handle(JSON.parse(e.data))
    } catch (err) {
      console.error(err)
    }
  }
  es.onerror = () => set({ connected: false })
  return () => es.close()
}

/** A bot by its current or any previous name (log entries keep the name used at the time). */
export function findBot(bots: Record<string, Bot>, name?: string | null): Bot | undefined {
  if (!name) return undefined
  return bots[name] || Object.values(bots).find(b => b.previous_names?.includes(name))
}

export const selectors = {
  botTitle: (b?: Bot | null) => (b ? b.title || b.name : ''),
  pendingFor: (pending: Pending[], sid: string) => pending.filter(p => p.sid === sid)
}
