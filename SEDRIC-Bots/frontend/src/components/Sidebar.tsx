import { useMemo, useState, type DragEvent, type ReactNode } from 'react'

import { api } from '../api'
import { confirm, openBot, openDialog, openGroup, promptText, toast, useStore } from '../store'
import type { Bot, GroupSummary, Section } from '../types'
import { ago, cls } from '../utils'
import { BotFace, GroupFace } from './Avatar'
import { Icon } from './icons'
import { useMenu, type MenuItem } from './ui'

type Row = { kind: 'bot'; bot: Bot; at: number } | { kind: 'group'; group: GroupSummary; at: number }

const MOOD_TEXT: Record<string, string> = { think: '正在思考…', work: '正在执行…', wait: '等你回复…' }

function newId() {
  return 'sec' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

async function saveSections(sections: Section[]) {
  await api.put('/api/ui', { sections })
}

export function Sidebar() {
  const bots = useStore(s => s.bots)
  const groups = useStore(s => s.groups)
  const ui = useStore(s => s.ui)
  const view = useStore(s => s.view)
  const search = useStore(s => s.search)
  const filter = useStore(s => s.filter)
  const showHiddenPref = useStore(s => s.showHidden)
  const connected = useStore(s => s.connected)
  const settings = useStore(s => s.settings)
  const pending = useStore(s => s.pending)
  const menu = useMenu()
  const [dragOver, setDragOver] = useState<string | null>(null)

  const avatars = useMemo(() => Object.fromEntries(Object.values(bots).map(b => [b.name, b.avatar])), [bots])
  const q = search.trim().toLowerCase()

  const matchBot = (b: Bot) =>
    !q || b.name.includes(q) || (b.title || '').toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q)
  const matchGroup = (g: GroupSummary) =>
    !q || g.name.toLowerCase().includes(q) || g.members.some(m => m.includes(q) || (bots[m]?.title || '').toLowerCase().includes(q))

  const allBots = Object.values(bots)
  const hiddenCount = allBots.filter(b => b.hidden).length
  // Unhiding the last hidden bot must not strand you in an empty "hidden" view.
  const showHidden = showHiddenPref && hiddenCount > 0
  const visibleBots = allBots.filter(b => (showHidden ? b.hidden : !b.hidden) && matchBot(b) && filter !== 'groups')
  const visibleGroups = showHidden ? [] : Object.values(groups).filter(g => matchGroup(g) && filter !== 'bots')

  const rows: Row[] = [
    ...visibleBots.map(b => ({ kind: 'bot' as const, bot: b, at: b.chat?.last_active || b.created })),
    ...visibleGroups.map(g => ({ kind: 'group' as const, group: g, at: g.last_active || g.created }))
  ]
  const sectionIds = new Set(ui.sections.map(s => s.id))
  const secOf = (r: Row) => {
    const s = r.kind === 'bot' ? r.bot.section : r.group.section
    return s && sectionIds.has(s) ? s : null
  }
  const pinnedOf = (r: Row) => (r.kind === 'bot' ? r.bot.pinned : r.group.pinned)
  const byRecent = (a: Row, b: Row) => b.at - a.at
  const pinned = rows.filter(r => pinnedOf(r)).sort(byRecent)
  const rest = rows.filter(r => !pinnedOf(r))
  const sectioned = (id: string) => rest.filter(r => secOf(r) === id).sort(byRecent)
  const freeBots = rest.filter(r => r.kind === 'bot' && !secOf(r)).sort(byRecent)
  const freeGroups = rest.filter(r => r.kind === 'group' && !secOf(r)).sort(byRecent)

  const isActive = (r: Row) =>
    r.kind === 'bot' ? view.kind === 'bot' && view.bot === r.bot.name : view.kind === 'group' && view.id === r.group.id

  // ── actions ────────────────────────────────────────────────────────────────

  const moveTo = async (r: Row, section: string | null) => {
    if (r.kind === 'bot') await api.patch(`/api/bots/${r.bot.name}`, { section })
    else await api.patch(`/api/groups/${r.group.id}`, { section })
  }

  const newSection = (then?: (id: string) => void) =>
    promptText('新建分区', '分区名称（例如：客户、写作、研发）', '', async name => {
      if (!name.trim()) return
      const id = newId()
      await saveSections([...ui.sections, { id, name: name.trim() }])
      then?.(id)
    })

  const sectionMenu = (r: Row): MenuItem[] => [
    ...ui.sections.map(s => ({ label: s.name, icon: secOf(r) === s.id ? 'check' : undefined, onClick: () => void moveTo(r, s.id) })),
    ...(ui.sections.length ? [{ divider: true, label: '' }] : []),
    { label: '新建分区…', icon: 'plus', onClick: () => newSection(id => void moveTo(r, id)) },
    ...(secOf(r) ? [{ label: '移出分区', icon: 'x', onClick: () => void moveTo(r, null) }] : [])
  ]

  const botMenu = (b: Bot): MenuItem[] => [
    { label: '打开 Bot Chat', icon: 'msg', onClick: () => void openBot(b.name) },
    {
      label: '与此机器人开新聊天',
      icon: 'plus',
      onClick: async () => {
        const s = await api.post(`/api/bots/${b.name}/sessions`, {})
        await openBot(b.name, s.id)
      }
    },
    { label: '编辑…', icon: 'edit', onClick: () => openDialog({ kind: 'editBot', bot: b.name }) },
    { divider: true, label: '' },
    { label: b.pinned ? '取消置顶' : '置顶', icon: 'pin', onClick: () => void api.patch(`/api/bots/${b.name}`, { pinned: !b.pinned }) },
    { label: '移动到分区', icon: 'folder', sub: sectionMenu({ kind: 'bot', bot: b, at: 0 }) },
    { label: b.hidden ? '取消隐藏' : '隐藏', icon: b.hidden ? 'eye' : 'eyeOff', onClick: () => void api.patch(`/api/bots/${b.name}`, { hidden: !b.hidden }) },
    { label: '和它建群聊…', icon: 'users', onClick: () => openDialog({ kind: 'createGroup', members: [b.name] }) },
    {
      label: '复制',
      icon: 'copy',
      onClick: async () => {
        try {
          const nb = await api.post(`/api/bots/${b.name}/duplicate`)
          toast(`已复制为 ${nb.title || nb.name}`, 'success')
        } catch (e: any) {
          toast(e.message, 'error')
        }
      }
    },
    { divider: true, label: '' },
    {
      label: '删除…',
      icon: 'trash',
      danger: true,
      onClick: () =>
        confirm(
          '删除机器人和它的配置档案？',
          `「${b.title || b.name}」的人格、记忆、技能、聊天记录和定时任务都会被永久删除，并从所有群聊中移除。此操作无法撤销。`,
          '删除',
          async () => {
            await api.del(`/api/bots/${b.name}`)
            toast('已删除', 'success')
          }
        )
    }
  ]

  const groupMenu = (g: GroupSummary): MenuItem[] => [
    { label: '打开群聊', icon: 'users', onClick: () => void openGroup(g.id) },
    { label: '管理群聊…', icon: 'edit', onClick: () => openDialog({ kind: 'manageGroup', id: g.id }) },
    { divider: true, label: '' },
    { label: g.pinned ? '取消置顶' : '置顶', icon: 'pin', onClick: () => void api.patch(`/api/groups/${g.id}`, { pinned: !g.pinned }) },
    { label: '移动到分区', icon: 'folder', sub: sectionMenu({ kind: 'group', group: g, at: 0 }) },
    { divider: true, label: '' },
    {
      label: '解散…',
      icon: 'trash',
      danger: true,
      onClick: () =>
        confirm('解散群聊？', `「${g.name}」的聊天记录会被删除，成员机器人本身不受影响。`, '解散', async () => {
          await api.del(`/api/groups/${g.id}`)
        })
    }
  ]

  const secHeaderMenu = (s: Section, i: number): MenuItem[] => [
    {
      label: '重命名…',
      icon: 'edit',
      onClick: () =>
        promptText('重命名分区', '分区名称', s.name, async name => {
          if (name.trim()) await saveSections(ui.sections.map(x => (x.id === s.id ? { ...x, name: name.trim() } : x)))
        })
    },
    {
      label: '上移',
      disabled: i === 0,
      onClick: () => {
        const a = [...ui.sections]
        ;[a[i - 1], a[i]] = [a[i], a[i - 1]]
        void saveSections(a)
      }
    },
    {
      label: '下移',
      disabled: i === ui.sections.length - 1,
      onClick: () => {
        const a = [...ui.sections]
        ;[a[i + 1], a[i]] = [a[i], a[i + 1]]
        void saveSections(a)
      }
    },
    { divider: true, label: '' },
    {
      label: '删除分区',
      icon: 'trash',
      danger: true,
      onClick: () => void saveSections(ui.sections.filter(x => x.id !== s.id))
    }
  ]

  const toggleCollapse = (id: string) => {
    const c = ui.collapsed.includes(id) ? ui.collapsed.filter(x => x !== id) : [...ui.collapsed, id]
    useStore.setState({ ui: { ...ui, collapsed: c } })
    void api.put('/api/ui', { collapsed: c })
  }

  // ── drag & drop ─────────────────────────────────────────────────────────────

  const onDrop = (target: string | null) => async (e: DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const data = e.dataTransfer.getData('text/x-hb')
    if (!data) return
    const [kind, id] = data.split(':')
    if (kind === 'bot' && bots[id]) await api.patch(`/api/bots/${id}`, { section: target })
    if (kind === 'group' && groups[id]) await api.patch(`/api/groups/${id}`, { section: target })
  }
  const dropProps = (key: string, target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes('text/x-hb')) {
        e.preventDefault()
        setDragOver(key)
      }
    },
    onDragLeave: () => setDragOver(d => (d === key ? null : d)),
    onDrop: onDrop(target)
  })

  // ── rendering ───────────────────────────────────────────────────────────────

  const renderRow = (r: Row) => {
    if (r.kind === 'bot') {
      const b = r.bot
      const st = b.status
      const pend = pending.filter(p => p.bot === b.name && !p.group_id).length
      const sub = st.attention
        ? st.attention.text
        : MOOD_TEXT[st.mood] || (b.chat?.preview ? b.chat.preview.replace(/\s+/g, ' ') : b.description || '说点什么开始吧')
      return (
        <div
          className={cls('row', isActive(r) && 'active', b.hidden && 'dim')}
          draggable
          key={'b:' + b.name}
          onClick={() => void openBot(b.name)}
          onContextMenu={e => menu.open(e, botMenu(b))}
          onKeyDown={e => {
            if (e.key === 'Enter') void openBot(b.name)
            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              const r = e.currentTarget.getBoundingClientRect()
              menu.open({ clientX: r.left + 40, clientY: r.bottom, preventDefault: () => e.preventDefault() }, botMenu(b))
            }
          }}
          role="button"
          tabIndex={0}
          onDragStart={e => e.dataTransfer.setData('text/x-hb', 'bot:' + b.name)}
          title={`@${b.name}`}
        >
          <span className="row-face">
            <BotFace avatar={b.avatar} mood={st.mood} name={b.name} size={34} />
            {(st.attention || pend > 0) && <i className="badge-dot warn" />}
          </span>
          <span className="row-main">
            <span className="row-top">
              <span className="row-title">{b.title || b.name}</span>
              {b.pinned && <Icon className="row-pin" name="pin" size={11} />}
              {b.routines > 0 && (
                <span className="row-chip" title={`${b.routines} 个定时任务`}>
                  <Icon name="clock" size={10} />
                  {b.routines}
                </span>
              )}
              <span className="row-time">{st.mood !== 'idle' ? '' : ago(b.chat?.last_active)}</span>
            </span>
            <span className={cls('row-sub', st.attention && 'warn', st.mood !== 'idle' && 'live')}>{sub}</span>
          </span>
          {b.chat?.unread && st.mood === 'idle' && <i className="unread-dot" />}
          <button className="row-more" onClick={e => menu.open(e, botMenu(b))} title="更多">
            <Icon name="more" />
          </button>
        </div>
      )
    }
    const g = r.group
    const running = g.running.length > 0
    const needs = pending.some(p => p.group_id === g.id)
    const activeMember = Object.values(g.active || {})[0]
    return (
      <div
        className={cls('row', isActive(r) && 'active')}
        draggable
        key={'g:' + g.id}
        onClick={() => void openGroup(g.id)}
        onContextMenu={e => menu.open(e, groupMenu(g))}
        onKeyDown={e => {
          if (e.key === 'Enter') void openGroup(g.id)
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            const r = e.currentTarget.getBoundingClientRect()
            menu.open({ clientX: r.left + 40, clientY: r.bottom, preventDefault: () => e.preventDefault() }, groupMenu(g))
          }
        }}
        role="button"
        tabIndex={0}
        onDragStart={e => e.dataTransfer.setData('text/x-hb', 'group:' + g.id)}
      >
        <span className="row-face">
          <GroupFace avatars={avatars} image={g.image} members={g.members} size={34} />
          {needs && <i className="badge-dot warn" />}
        </span>
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">{g.name}</span>
            {g.pinned && <Icon className="row-pin" name="pin" size={11} />}
            <span className="row-chip">
              <Icon name="users" size={10} />
              {g.members.length}
            </span>
            <span className="row-time">{running ? '' : ago(g.last_active)}</span>
          </span>
          <span className={cls('row-sub', running && 'live', needs && 'warn')}>
            {needs
              ? '有机器人需要你输入'
              : running
                ? `${activeMember ? (bots[activeMember]?.title || activeMember) + ' ' : ''}正在发言…`
                : g.preview || '说点什么 — 群里的每个机器人都会听到'}
          </span>
        </span>
        {g.unread && !running && <i className="unread-dot" />}
        <button className="row-more" onClick={e => menu.open(e, groupMenu(g))} title="更多">
          <Icon name="more" />
        </button>
      </div>
    )
  }

  const block = (key: string, title: ReactNode, items: Row[], opts: { target?: string | null; menu?: MenuItem[]; always?: boolean } = {}) => {
    // Empty sections only show (as drop targets) in the unfiltered view.
    if (!items.length && (!opts.always || q || filter !== 'all')) return null
    const collapsed = ui.collapsed.includes(key)
    const droppable = opts.target !== undefined
    return (
      <div className={cls('block', dragOver === key && 'drop')} key={key} {...(droppable ? dropProps(key, opts.target ?? null) : {})}>
        <div
          className="block-head"
          onClick={() => toggleCollapse(key)}
          onContextMenu={opts.menu ? e => menu.open(e, opts.menu!) : undefined}
          onDoubleClick={opts.menu ? e => menu.open(e, opts.menu!) : undefined}
        >
          <Icon className={cls('caret', collapsed && 'closed')} name="down" size={12} />
          <span>{title}</span>
          <span className="block-count">{items.length}</span>
          {opts.menu && (
            <button className="block-more" onClick={e => menu.open(e, opts.menu!)}>
              <Icon name="more" size={14} />
            </button>
          )}
        </div>
        {!collapsed && (items.length ? items.map(renderRow) : <div className="block-empty">把机器人拖到这里</div>)}
      </div>
    )
  }

  const empty = !allBots.length

  return (
    <aside className="sidebar">
      <div className="side-head">
        <button className="brand" onClick={() => useStore.setState({ view: { kind: 'home' } })}>
          <img alt="" className="brand-mark" src="/icon.svg" />
          <span>SEDRIC Bots</span>
        </button>
        <button
          className="icon-btn"
          onClick={e =>
            menu.open(e, [
              { label: '新建机器人', icon: 'sparkle', onClick: () => openDialog({ kind: 'createBot' }) },
              { label: '新建群聊', icon: 'users', onClick: () => openDialog({ kind: 'createGroup' }) },
              { label: '新建分区', icon: 'folder', onClick: () => newSection() }
            ])
          }
          title="新建机器人或群聊"
        >
          <Icon name="plus" size={18} />
        </button>
      </div>
      <div className="side-search">
        <Icon name="search" size={14} />
        <input
          onChange={e => useStore.setState({ search: e.target.value })}
          placeholder="搜索机器人和群聊…"
          value={search}
        />
        {search && (
          <button className="icon-btn sm" onClick={() => useStore.setState({ search: '' })}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      <div className="side-filters">
        {(['all', 'bots', 'groups'] as const).map(f => (
          <button className={cls('pill', filter === f && 'on')} key={f} onClick={() => useStore.setState({ filter: f })}>
            {{ all: '全部', bots: '机器人', groups: '群聊' }[f]}
          </button>
        ))}
        {hiddenCount > 0 && (
          <button
            className={cls('pill', showHidden && 'on')}
            onClick={() => useStore.setState({ showHidden: !showHidden })}
            title="显示已隐藏的机器人"
          >
            <Icon name={showHidden ? 'eye' : 'eyeOff'} size={12} /> {hiddenCount}
          </button>
        )}
      </div>
      <div className="side-list">
        {empty ? (
          <div className="side-empty">
            <p>还没有机器人</p>
            <button className="btn primary" onClick={() => openDialog({ kind: 'createBot' })}>
              创建你的第一个机器人
            </button>
          </div>
        ) : showHidden ? (
          block('hidden', '已隐藏（它们仍会继续运行）', visibleBots.map(b => ({ kind: 'bot', bot: b, at: b.chat?.last_active || 0 })))
        ) : (
          <>
            {block('pinned', '已置顶', pinned)}
            {ui.sections.map((s, i) => block(s.id, s.name, sectioned(s.id), { target: s.id, menu: secHeaderMenu(s, i), always: true }))}
            {block('groups', '群聊', freeGroups, { target: null })}
            {block('bots', ui.sections.length ? '未分类' : '机器人', freeBots, { target: null, always: ui.sections.length > 0 })}
            {q && !rows.length && <div className="block-empty">没有匹配「{search}」的机器人或群聊</div>}
          </>
        )}
      </div>
      <div className="side-foot">
        <span className={cls('conn', connected ? 'ok' : 'bad')} title={connected ? '已连接' : '正在重连…'} />
        <span className="side-user">{settings?.user_name || '你'}</span>
        <button
          className="icon-btn"
          onClick={() => {
            const next = settings?.theme === 'dark' ? 'light' : 'dark'
            void api.put('/api/settings', { theme: next })
          }}
          title="切换深色/浅色"
        >
          <Icon name={settings?.theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="icon-btn" onClick={() => openDialog({ kind: 'settings' })} title="设置">
          <Icon name="settings" />
        </button>
      </div>
      {menu.node}
    </aside>
  )
}
