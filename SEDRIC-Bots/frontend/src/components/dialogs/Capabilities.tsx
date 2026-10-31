import { useEffect, useState } from 'react'

import { api } from '../../api'
import { confirm, toast, useStore } from '../../store'
import type { McpServer, Skill } from '../../types'
import { cls } from '../../utils'
import { Icon } from '../icons'
import { Field, Spinner, Toggle } from '../ui'

export const TOOL_ORDER = ['terminal', 'files', 'web', 'memory', 'skills', 'message_agent', 'cronjob', 'clarify', 'mcp']
const TOOL_HINT: Record<string, string> = {
  terminal: '在它的工作目录里执行命令（危险命令会先问你）',
  files: '读、写、修改、搜索文件',
  web: '联网搜索、打开网页',
  memory: '跨会话记住你和它学到的东西',
  skills: '加载和沉淀技能（SKILL.md）',
  message_agent: '给其他机器人发私信、转交任务',
  cronjob: '自己创建和管理定时任务',
  clarify: '信息不够时停下来问你',
  mcp: '使用下面配置的 MCP 服务器提供的工具'
}

export function ToolToggles({ value, onChange }: { value: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void }) {
  const labels = useStore(s => s.toolLabels)
  return (
    <div className="tool-grid">
      {TOOL_ORDER.map(t => (
        <div className="tool-toggle" key={t}>
          <div>
            <b>{labels[t] || t}</b>
            <span>{TOOL_HINT[t]}</span>
          </div>
          <Toggle checked={value[t] !== false} onChange={v => onChange({ ...value, [t]: v })} />
        </div>
      ))}
    </div>
  )
}

export function SkillEditor({ initial, onSave, onCancel }: { initial?: Skill; onSave: (s: { id: string; name: string; description: string; body: string }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name || '')
  const [desc, setDesc] = useState(initial?.description || '')
  const [body, setBody] = useState(initial?.body || '# 步骤\n\n1. \n2. \n')
  return (
    <div className="skill-editor">
      <div className="grid2">
        <Field label="名称">
          <input onChange={e => setName(e.target.value)} placeholder="例如：weekly-report" value={name} />
        </Field>
        <Field label="何时使用">
          <input onChange={e => setDesc(e.target.value)} placeholder="一句话说明什么情况下用它" value={desc} />
        </Field>
      </div>
      <Field label="内容（Markdown）">
        <textarea className="mono" onChange={e => setBody(e.target.value)} rows={10} value={body} />
      </Field>
      <div className="row-end">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button className="btn primary" disabled={!name.trim()} onClick={() => void onSave({ id: initial?.id || name, name, description: desc, body })}>
          保存技能
        </button>
      </div>
    </div>
  )
}

/** Skills of an existing bot: toggle, edit, delete, add, install from catalog / other bots. */
export function SkillsManager({ bot, disabled, onDisabled }: { bot: string; disabled: string[]; onDisabled: (d: string[]) => void }) {
  const bots = useStore(s => s.bots)
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [catalog, setCatalog] = useState<Skill[]>([])
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [from, setFrom] = useState('')
  const [fromSkills, setFromSkills] = useState<Skill[]>([])

  const reload = () => api.get(`/api/bots/${bot}`).then(d => setSkills(d.skills))
  useEffect(() => {
    void reload()
    void api.get<Skill[]>('/api/skills/bundled').then(setCatalog)
  }, [bot])
  useEffect(() => {
    if (!from) return setFromSkills([])
    void api.get(`/api/bots/${from}`).then(d => setFromSkills(d.skills))
  }, [from])

  if (!skills) return <Spinner />
  if (editing) {
    return (
      <SkillEditor
        initial={editing === 'new' ? undefined : editing}
        onCancel={() => setEditing(null)}
        onSave={async s => {
          await api.put(`/api/bots/${bot}/skills/${encodeURIComponent(s.id)}`, s)
          setEditing(null)
          await reload()
        }}
      />
    )
  }
  const have = new Set(skills.map(s => s.id))
  const installable = catalog.filter(c => !have.has(c.id))
  return (
    <div className="skills">
      {skills.map(s => (
        <div className={cls('skill', disabled.includes(s.id) && 'off')} key={s.id}>
          <Toggle
            checked={!disabled.includes(s.id)}
            onChange={v => onDisabled(v ? disabled.filter(x => x !== s.id) : [...disabled, s.id])}
          />
          <div className="skill-main">
            <b>{s.name}</b>
            <span>{s.description}</span>
          </div>
          <button className="icon-btn sm" onClick={() => api.get(`/api/bots/${bot}/skills/${s.id}`).then(setEditing)} title="编辑">
            <Icon name="edit" size={13} />
          </button>
          <button
            className="icon-btn sm"
            onClick={() =>
              confirm('删除技能？', `「${s.name}」会从这个机器人中删除。`, '删除', async () => {
                await api.del(`/api/bots/${bot}/skills/${s.id}`)
                await reload()
              })
            }
            title="删除"
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
      {!skills.length && <div className="muted small">还没有技能。机器人也会在完成复杂任务后自己沉淀技能。</div>}
      <div className="row-start">
        <button className="btn" onClick={() => setEditing('new')}>
          <Icon name="plus" size={13} /> 新建技能
        </button>
      </div>
      {installable.length > 0 && (
        <>
          <div className="sub-title">目录 · 内置技能</div>
          {installable.map(c => (
            <div className="skill catalog" key={c.id}>
              <div className="skill-main">
                <b>{c.name}</b>
                <span>{c.description}</span>
              </div>
              <button
                className="btn sm"
                onClick={async () => {
                  await api.post(`/api/bots/${bot}/skills/install`, { ids: [c.id] })
                  await reload()
                }}
              >
                安装
              </button>
            </div>
          ))}
        </>
      )}
      <div className="sub-title">从其他机器人复制技能</div>
      <select onChange={e => setFrom(e.target.value)} value={from}>
        <option value="">选择一个机器人…</option>
        {Object.values(bots)
          .filter(b => b.name !== bot)
          .map(b => (
            <option key={b.name} value={b.name}>
              {b.title || b.name}
            </option>
          ))}
      </select>
      {fromSkills.map(s => (
        <div className="skill catalog" key={s.id}>
          <div className="skill-main">
            <b>{s.name}</b>
            <span>{s.description}</span>
          </div>
          <button
            className="btn sm"
            disabled={have.has(s.id)}
            onClick={async () => {
              await api.post(`/api/bots/${bot}/skills/install`, { ids: [s.id], from_bot: from })
              await reload()
              toast('已复制', 'success')
            }}
          >
            {have.has(s.id) ? '已有' : '复制'}
          </button>
        </div>
      ))}
    </div>
  )
}

const MCP_PRESETS: { label: string; server: McpServer }[] = [
  { label: '文件系统', server: { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: true } },
  { label: '网页抓取 Fetch', server: { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], enabled: true } },
  { label: '记忆图谱', server: { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], enabled: true } },
  { label: '浏览器 Playwright', server: { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], enabled: true } }
]

export function McpEditor({ bot, value, onChange }: { bot: string | null; value: McpServer[]; onChange: (v: McpServer[]) => void }) {
  const [testing, setTesting] = useState<number | null>(null)
  const [results, setResults] = useState<Record<number, string>>({})
  const update = (i: number, patch: Partial<McpServer>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  return (
    <div className="mcp">
      {value.map((s, i) => {
        const http = s.url !== undefined
        return (
          <div className="mcp-server" key={i}>
            <div className="mcp-top">
              <Toggle checked={s.enabled !== false} onChange={v => update(i, { enabled: v })} />
              <input className="mcp-name" onChange={e => update(i, { name: e.target.value.replace(/[^\w-]/g, '') })} placeholder="名称" value={s.name} />
              <select onChange={e => update(i, e.target.value === 'http' ? { url: s.url || 'https://', command: undefined } : { url: undefined, command: s.command || '' })} value={http ? 'http' : 'stdio'}>
                <option value="stdio">本地命令（stdio）</option>
                <option value="http">远程 URL（HTTP）</option>
              </select>
              <button className="icon-btn sm" onClick={() => onChange(value.filter((_, j) => j !== i))} title="移除">
                <Icon name="trash" size={13} />
              </button>
            </div>
            {http ? (
              <>
                <input onChange={e => update(i, { url: e.target.value })} placeholder="https://example.com/mcp" value={s.url || ''} />
                <input
                  onChange={e => {
                    const [k, ...rest] = e.target.value.split(':')
                    update(i, { headers: k ? { [k.trim()]: rest.join(':').trim() } : {} })
                  }}
                  placeholder="可选请求头，例如 Authorization: Bearer xxx"
                  value={Object.entries(s.headers || {}).map(([k, v]) => `${k}: ${v}`)[0] || ''}
                />
              </>
            ) : (
              <>
                <div className="grid2">
                  <input onChange={e => update(i, { command: e.target.value })} placeholder="命令，例如 npx" value={s.command || ''} />
                  <input
                    onChange={e => update(i, { args: e.target.value.split(' ').filter(Boolean) })}
                    placeholder="参数（空格分隔）"
                    value={(s.args || []).join(' ')}
                  />
                </div>
                <input
                  onChange={e =>
                    update(i, {
                      env: Object.fromEntries(
                        e.target.value
                          .split(/[;,]/)
                          .map(p => p.split('='))
                          .filter(p => p[0]?.trim())
                          .map(p => [p[0].trim(), p.slice(1).join('=').trim()])
                      )
                    })
                  }
                  placeholder="环境变量（KEY=value; KEY2=value）"
                  value={Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('; ')}
                />
              </>
            )}
            {bot && (
              <div className="mcp-test">
                <button
                  className="btn sm"
                  disabled={testing === i}
                  onClick={async () => {
                    setTesting(i)
                    try {
                      const r = await api.post(`/api/bots/${bot}/mcp/test`, s)
                      setResults({ ...results, [i]: r.ok ? `✓ 连接成功，${r.tools.length} 个工具：${r.tools.map((t: any) => t.name).join('、')}` : `✗ ${r.error}` })
                    } finally {
                      setTesting(null)
                    }
                  }}
                >
                  {testing === i ? <Spinner size={11} /> : null} 测试连接
                </button>
                {results[i] && <span className={cls('small', results[i].startsWith('✓') ? 'ok' : 'warn')}>{results[i]}</span>}
              </div>
            )}
          </div>
        )
      })}
      <div className="row-start wrap">
        <button className="btn sm" onClick={() => onChange([...value, { name: `server${value.length + 1}`, command: '', args: [], enabled: true }])}>
          <Icon name="plus" size={12} /> 添加服务器
        </button>
        {MCP_PRESETS.map(p => (
          <button className="btn sm ghost" key={p.label} onClick={() => onChange([...value, { ...p.server }])}>
            + {p.label}
          </button>
        ))}
      </div>
      <div className="muted small">本地命令需要电脑上装有对应工具（如 Node.js 的 npx、Python 的 uvx）。</div>
    </div>
  )
}
