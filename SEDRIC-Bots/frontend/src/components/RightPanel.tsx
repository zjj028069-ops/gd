import { useEffect, useState } from 'react'

import { api } from '../api'
import { confirm, openDialog, openGroup, toast, useStore } from '../store'
import type { BotDetail, CronJob } from '../types'
import { ago, cls, dateTime } from '../utils'
import { Icon } from './icons'
import { Spinner, Tabs, Toggle, useMenu } from './ui'

export function useBotDetail(bot: string) {
  const v = useStore(s => s.versions['detail:' + bot] || 0)
  const [detail, setDetail] = useState<BotDetail | null>(null)
  const reload = () => api.get<BotDetail>(`/api/bots/${bot}`).then(setDetail).catch(() => setDetail(null))
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot, v])
  return { detail, reload }
}

export function useJobs(bot: string) {
  const v = useStore(s => s.versions['cron:' + bot] || 0)
  const [jobs, setJobs] = useState<CronJob[] | null>(null)
  useEffect(() => {
    api.get<CronJob[]>(`/api/bots/${bot}/cron`).then(setJobs).catch(() => setJobs([]))
  }, [bot, v])
  return jobs
}

function Routines({ bot }: { bot: string }) {
  const jobs = useJobs(bot)
  const menu = useMenu()
  if (!jobs) return <div className="pad"><Spinner /></div>
  return (
    <div className="routines">
      <button className="btn block" onClick={() => openDialog({ kind: 'cron', bot })}>
        <Icon name="plus" size={14} /> 新建定时任务
      </button>
      {!jobs.length && (
        <div className="muted pad center">
          还没有定时任务。<br />
          可以在这里创建，也可以直接对机器人说「每天早上 9 点给我发一份新闻简报」。
        </div>
      )}
      {jobs.map(j => (
        <div className={cls('job', !j.enabled && 'off')} key={j.id} onClick={() => openDialog({ kind: 'cron', bot, jobId: j.id })}>
          <div className="job-top">
            <Icon name="clock" size={14} />
            <b className="job-name">{j.name}</b>
            <span onClick={e => e.stopPropagation()}>
              <Toggle checked={j.enabled} onChange={v => void api.patch(`/api/bots/${bot}/cron/${j.id}`, { enabled: v })} />
            </span>
          </div>
          <div className="job-sched">{j.schedule.display}</div>
          <div className="job-meta">
            {j.running ? (
              <span className="live"><Spinner size={10} /> 正在执行…</span>
            ) : j.enabled && j.next_run ? (
              <span>下次：{dateTime(j.next_run)}</span>
            ) : (
              <span>已暂停</span>
            )}
            {j.last_status && j.last_status !== 'running' && (
              <span className={cls('job-status', j.last_status)}>{j.last_status === 'ok' ? '上次成功' : '上次失败'} · {ago(j.last_run)}</span>
            )}
          </div>
          <button
            className="row-more"
            onClick={e =>
              menu.open(e, [
                { label: '立即执行', icon: 'play', onClick: () => void api.post(`/api/bots/${bot}/cron/${j.id}/run`).then(() => toast('已开始执行', 'success')) },
                { label: '编辑…', icon: 'edit', onClick: () => openDialog({ kind: 'cron', bot, jobId: j.id }) },
                { divider: true, label: '' },
                {
                  label: '删除',
                  icon: 'trash',
                  danger: true,
                  onClick: () => confirm('删除定时任务？', `「${j.name}」会被删除。`, '删除', async () => void (await api.del(`/api/bots/${bot}/cron/${j.id}`)))
                }
              ])
            }
          >
            <Icon name="more" />
          </button>
        </div>
      ))}
      {menu.node}
    </div>
  )
}

function MemoryList({ bot, target, entries, limit, onSave }: { bot: string; target: 'memory' | 'user'; entries: string[]; limit: number; onSave: () => void }) {
  const [adding, setAdding] = useState('')
  const used = entries.reduce((n, e) => n + e.length, 0)
  const save = async (next: string[]) => {
    await api.put(`/api/bots/${bot}/memory`, { [target]: next })
    onSave()
  }
  return (
    <div className="mem">
      <div className="mem-head">
        <b>{target === 'memory' ? '它的笔记' : '关于你'}</b>
        <span className={cls('mem-usage', used > limit && 'warn')}>
          {used}/{limit}
        </span>
      </div>
      <div className="meter">
        <i style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
      </div>
      {entries.map((e, i) => (
        <div className="mem-entry" key={i}>
          <span>{e}</span>
          <button className="icon-btn sm" onClick={() => void save(entries.filter((_, j) => j !== i))} title="删除这条">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      {!entries.length && <div className="muted small">（空）</div>}
      <form
        className="mem-add"
        onSubmit={e => {
          e.preventDefault()
          if (adding.trim()) void save([...entries, adding.trim()]).then(() => setAdding(''))
        }}
      >
        <input onChange={e => setAdding(e.target.value)} placeholder="添加一条…" value={adding} />
      </form>
    </div>
  )
}

function Profile({ bot }: { bot: string }) {
  const { detail, reload } = useBotDetail(bot)
  const settings = useStore(s => s.settings)
  const groups = useStore(s => s.groups)
  if (!detail) return <div className="pad"><Spinner /></div>
  const prov = settings?.providers.find(p => p.id === (detail.model?.provider || settings?.default_provider))
  const model = detail.model?.model || (detail.model?.provider ? '' : settings?.default_model)
  return (
    <div className="profile">
      <section>
        <div className="kv">
          <span>模型</span>
          <b>{detail.model?.provider || detail.model?.model ? `${prov?.name || detail.model?.provider} · ${model || '默认'}` : `继承默认（${prov?.name || ''} · ${settings?.default_model}）`}</b>
        </div>
        <div className="kv">
          <span>工作目录</span>
          <code className="path">{detail.workspace}</code>
        </div>
        <button className="btn block" onClick={() => openDialog({ kind: 'editBot', bot })}>
          <Icon name="edit" size={14} /> 编辑配置档案
        </button>
      </section>
      <section>
        <h4>长期记忆</h4>
        <MemoryList bot={bot} entries={detail.memory.memory} limit={detail.memory.limits.memory} onSave={reload} target="memory" />
        <MemoryList bot={bot} entries={detail.memory.user} limit={detail.memory.limits.user} onSave={reload} target="user" />
      </section>
      <section>
        <h4>
          技能 <span className="muted">{detail.skills.filter(s => s.enabled).length}</span>
        </h4>
        {detail.skills.map(s => (
          <div className={cls('skill-line', !s.enabled && 'off')} key={s.id} title={s.description}>
            <Icon name="sparkle" size={12} /> {s.name}
          </div>
        ))}
        {!detail.skills.length && <div className="muted small">没有技能</div>}
        <button className="link" onClick={() => openDialog({ kind: 'editBot', bot, tab: 'skills' })}>
          管理技能 →
        </button>
      </section>
      {detail.groups.length > 0 && (
        <section>
          <h4>所在群聊</h4>
          {detail.groups.map(g => (
            <button className="skill-line link-line" key={g} onClick={() => void openGroup(g)}>
              <Icon name="users" size={12} /> {groups[g]?.name || g}
            </button>
          ))}
        </section>
      )}
    </div>
  )
}

export function RightPanel({ bot }: { bot: string }) {
  const [tab, setTab] = useState<'routines' | 'profile'>('routines')
  return (
    <aside className="right">
      <button className="icon-btn right-close" onClick={() => useStore.setState({ rightOpen: false })} title="关闭侧栏">
        <Icon name="x" />
      </button>
      <Tabs
        onChange={setTab}
        tabs={[
          { id: 'routines', label: '定时任务' },
          { id: 'profile', label: '资料与记忆' }
        ]}
        value={tab}
      />
      <div className="right-body">{tab === 'routines' ? <Routines bot={bot} /> : <Profile bot={bot} />}</div>
    </aside>
  )
}
