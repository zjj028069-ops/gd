import { useEffect, useMemo, useState } from 'react'

import { api } from '../../api'
import { confirm, openDialog, toast, useStore } from '../../store'
import type { CronJob } from '../../types'
import { cls, dateTime } from '../../utils'
import { Icon } from '../icons'
import { Field, Markdown, Modal, Spinner, Tabs } from '../ui'

type Mode = 'interval' | 'daily' | 'weekly' | 'weekdays' | 'once' | 'custom'
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function guessMode(job?: CronJob): Mode {
  if (!job) return 'daily'
  if (job.schedule.kind === 'interval') return 'interval'
  if (job.schedule.kind === 'once') return 'once'
  return 'custom'
}

export function CronDialog({ bot, jobId }: { bot: string; jobId?: string }) {
  const botRow = useStore(s => s.bots[bot])
  const close = () => openDialog(null)
  const [job, setJob] = useState<CronJob | undefined>()
  const [loaded, setLoaded] = useState(!jobId)
  const [tab, setTab] = useState<'edit' | 'history'>(jobId ? 'history' : 'edit')
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [mode, setMode] = useState<Mode>('daily')
  const [every, setEvery] = useState(30)
  const [unit, setUnit] = useState<'m' | 'h' | 'd'>('m')
  const [time, setTime] = useState('09:00')
  const [weekday, setWeekday] = useState(1)
  const [onceAt, setOnceAt] = useState(() => {
    const d = new Date(Date.now() + 3600_000)
    d.setSeconds(0, 0)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  })
  const [custom, setCustom] = useState('0 9 * * *')
  const [maxRuns, setMaxRuns] = useState<string>('')
  const [preview, setPreview] = useState<{ ok: boolean; text: string }>({ ok: true, text: '' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!jobId) return
    void api.get<CronJob[]>(`/api/bots/${bot}/cron`).then(jobs => {
      const j = jobs.find(x => x.id === jobId)
      setJob(j)
      if (j) {
        setName(j.name)
        setInstruction(j.instruction)
        setMode(guessMode(j))
        if (j.schedule.kind === 'interval') {
          const m = j.schedule.minutes || 30
          if (m % 1440 === 0) {
            setEvery(m / 1440)
            setUnit('d')
          } else if (m % 60 === 0) {
            setEvery(m / 60)
            setUnit('h')
          } else {
            setEvery(m)
            setUnit('m')
          }
        } else if (j.schedule.kind === 'cron') {
          setCustom(j.schedule.expr || j.schedule_text)
        }
        setMaxRuns(j.max_runs ? String(j.max_runs) : '')
      }
      setLoaded(true)
    })
  }, [bot, jobId])

  const schedule = useMemo(() => {
    const [h, m] = time.split(':').map(Number)
    switch (mode) {
      case 'interval':
        return `every ${every}${unit}`
      case 'daily':
        return `${m} ${h} * * *`
      case 'weekly':
        return `${m} ${h} * * ${weekday}`
      case 'weekdays':
        return `${m} ${h} * * 1-5`
      case 'once':
        return onceAt
      default:
        return custom
    }
  }, [mode, every, unit, time, weekday, onceAt, custom])

  useEffect(() => {
    const t = setTimeout(() => {
      void api.post('/api/cron/parse', { schedule }).then(r =>
        setPreview(r.ok ? { ok: true, text: `${r.schedule.display} · 下次执行：${dateTime(r.next_run)}` } : { ok: false, text: r.error })
      )
    }, 250)
    return () => clearTimeout(t)
  }, [schedule])

  const save = async () => {
    if (!instruction.trim()) return toast('请写下要做什么', 'error')
    setBusy(true)
    try {
      const body = { name: name.trim() || instruction.trim().slice(0, 20), instruction, schedule, max_runs: maxRuns ? Number(maxRuns) : null }
      if (job) await api.patch(`/api/bots/${bot}/cron/${job.id}`, body)
      else await api.post(`/api/bots/${bot}/cron`, body)
      toast(job ? '已保存' : '已创建定时任务', 'success')
      close()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) {
    return (
      <Modal onClose={close} title="定时任务">
        <Spinner />
      </Modal>
    )
  }

  return (
    <Modal
      footer={
        <>
          {job && (
            <>
              <button
                className="btn danger-ghost"
                onClick={() =>
                  confirm('删除定时任务？', `「${job.name}」会被删除。`, '删除', async () => {
                    await api.del(`/api/bots/${bot}/cron/${job.id}`)
                    close()
                  })
                }
              >
                <Icon name="trash" size={14} /> 删除
              </button>
              <button className="btn" onClick={() => void api.post(`/api/bots/${bot}/cron/${job.id}/run`).then(() => toast('已开始执行，结果会发到 Bot Chat', 'success'))}>
                <Icon name="play" size={13} /> 立即执行
              </button>
            </>
          )}
          <span className="spacer" />
          <button className="btn" onClick={close}>
            {tab === 'edit' ? '取消' : '关闭'}
          </button>
          {tab === 'edit' && (
            <button className="btn primary" disabled={busy || !preview.ok} onClick={() => void save()}>
              {job ? '保存' : '创建'}
            </button>
          )}
        </>
      }
      onClose={close}
      title={job ? `定时任务 · ${job.name}` : `新建定时任务 · ${botRow?.title || bot}`}
      width={640}
    >
      {job && (
        <Tabs
          onChange={setTab}
          tabs={[
            { id: 'history', label: `详情与历史（${job.history.length}）` },
            { id: 'edit', label: '编辑' }
          ]}
          value={tab}
        />
      )}
      <div className="tab-body">
        {tab === 'history' && job ? (
          <div className="form">
            <div className="kv-grid">
              <span>状态</span>
              <b>{job.running ? '正在执行' : job.enabled ? '运行中' : '已暂停'}</b>
              <span>计划</span>
              <b>{job.schedule.display}</b>
              <span>下次执行</span>
              <b>{job.enabled ? dateTime(job.next_run) : '—'}</b>
              <span>已执行</span>
              <b>
                {job.runs} 次{job.max_runs ? ` / 上限 ${job.max_runs} 次` : ''}
              </b>
            </div>
            <div className="sub-title">要做的事</div>
            <div className="instruction">{job.instruction}</div>
            <div className="sub-title">执行历史</div>
            {!job.history.length && <div className="muted small">还没有执行过</div>}
            {job.history.map((h, i) => (
              <details className={cls('history', h.status)} key={i} open={i === 0}>
                <summary>
                  <Icon name={h.status === 'ok' ? 'check' : 'alert'} size={13} /> {dateTime(h.at)}
                  {h.manual && <span className="tag">手动</span>}
                  <span className="muted small">{(h.duration / 1000).toFixed(1)} 秒</span>
                </summary>
                <Markdown text={h.output} />
              </details>
            ))}
          </div>
        ) : (
          <div className="form">
            <Field label="名称">
              <input onChange={e => setName(e.target.value)} placeholder="例如：早间新闻简报" value={name} />
            </Field>
            <Field hint="到点时机器人会在单独的会话里执行这段指令，并把结果发到它的 Bot Chat。写清楚要做什么、输出成什么样。" label="要做什么">
              <textarea onChange={e => setInstruction(e.target.value)} placeholder="例如：搜索今天 AI 行业的 5 条重要新闻，每条一句话总结并附链接。" rows={4} value={instruction} />
            </Field>
            <Field label="什么时候">
              <div className="sched-modes">
                {(
                  [
                    ['interval', '每隔'],
                    ['daily', '每天'],
                    ['weekdays', '工作日'],
                    ['weekly', '每周'],
                    ['once', '只执行一次'],
                    ['custom', 'Cron 表达式']
                  ] as [Mode, string][]
                ).map(([m, l]) => (
                  <button className={cls('pill', mode === m && 'on')} key={m} onClick={() => setMode(m)} type="button">
                    {l}
                  </button>
                ))}
              </div>
            </Field>
            <div className="sched-row">
              {mode === 'interval' && (
                <>
                  <span>每</span>
                  <input className="num" min={1} onChange={e => setEvery(Math.max(1, Number(e.target.value)))} type="number" value={every} />
                  <select onChange={e => setUnit(e.target.value as 'm')} value={unit}>
                    <option value="m">分钟</option>
                    <option value="h">小时</option>
                    <option value="d">天</option>
                  </select>
                </>
              )}
              {mode === 'weekly' && (
                <select onChange={e => setWeekday(Number(e.target.value))} value={weekday}>
                  {WEEK.map((w, i) => (
                    <option key={i} value={i}>
                      {w}
                    </option>
                  ))}
                </select>
              )}
              {(mode === 'daily' || mode === 'weekly' || mode === 'weekdays') && <input onChange={e => setTime(e.target.value)} type="time" value={time} />}
              {mode === 'once' && <input onChange={e => setOnceAt(e.target.value)} type="datetime-local" value={onceAt} />}
              {mode === 'custom' && <input className="mono" onChange={e => setCustom(e.target.value)} placeholder="分 时 日 月 周，例如 0 9 * * 1-5" value={custom} />}
            </div>
            <div className={cls('small', preview.ok ? 'ok' : 'warn')}>{preview.text}</div>
            {mode !== 'once' && (
              <Field hint="留空则一直执行" label="运行上限（次）">
                <input className="num" min={1} onChange={e => setMaxRuns(e.target.value)} placeholder="不限" type="number" value={maxRuns} />
              </Field>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
