import { useEffect, useMemo, useState } from 'react'

import { api } from '../../api'
import { confirm, openBot, openDialog, toast, useStore } from '../../store'
import type { Avatar, BotDetail, McpServer, ModelPick, Skill } from '../../types'
import { NAME_RE, slugify } from '../../utils'
import { COLORS, SHAPES } from '../Avatar'
import { Icon } from '../icons'
import { Field, Modal, Spinner, Tabs, Toggle } from '../ui'
import { AvatarPicker } from './AvatarPicker'
import { McpEditor, SkillsManager, ToolToggles, TOOL_ORDER } from './Capabilities'
import { ModelPicker } from './ModelPicker'

type Tab = 'general' | 'look' | 'skills' | 'advanced'

function hashAvatar(name: string): Avatar {
  let h = 0
  for (const ch of name || 'bot') h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return { shape: SHAPES[h % SHAPES.length], color: COLORS[Math.floor(h / 7) % COLORS.length], image: null, custom: false }
}

const APPROVAL = [
  { id: 'inherit', label: '跟随全局设置' },
  { id: 'smart', label: '智能：只有危险命令才问我' },
  { id: 'always', label: '每条命令、每次写文件都问我' },
  { id: 'auto', label: '全自动：从不询问（小心）' }
]

export function BotDialog({ mode, bot, initialTab, section }: { mode: 'create' | 'edit'; bot?: string; initialTab?: string; section?: string | null }) {
  const bots = useStore(s => s.bots)
  const ui = useStore(s => s.ui)
  const close = () => openDialog(null)
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || 'general')
  const [detail, setDetail] = useState<BotDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [genBusy, setGenBusy] = useState(false)

  // form
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [help, setHelp] = useState('')
  const [avatar, setAvatar] = useState<Avatar>(hashAvatar(''))
  const [base, setBase] = useState('fresh')
  const [tools, setTools] = useState<Record<string, boolean>>(Object.fromEntries(TOOL_ORDER.map(t => [t, true])))
  const [model, setModel] = useState<ModelPick | null>(null)
  const [approval, setApproval] = useState('inherit')
  const [soul, setSoul] = useState('')
  const [soulDirty, setSoulDirty] = useState(false)
  const [mcpServers, setMcp] = useState<McpServer[]>([])
  const [disabled, setDisabled] = useState<string[]>([])
  const [catalog, setCatalog] = useState<Skill[]>([])
  const [pickSkills, setPickSkills] = useState<string[] | null>(null)
  const [sec, setSec] = useState<string | null>(section ?? null)
  const [kickoff, setKickoff] = useState(true)

  useEffect(() => {
    if (mode === 'edit' && bot) {
      void api.get<BotDetail>(`/api/bots/${bot}`).then(d => {
        setDetail(d)
        setName(d.name)
        setTitle(d.title)
        setDescription(d.description)
        setAvatar(d.avatar)
        setTools({ ...Object.fromEntries(TOOL_ORDER.map(t => [t, true])), ...d.tools })
        setModel(d.model)
        setApproval(d.approval || 'inherit')
        setSoul(d.soul)
        setMcp(d.mcp_servers || [])
        setDisabled(d.skills_disabled || [])
        setSec(d.section)
      })
    } else {
      void api.get<Skill[]>('/api/skills/bundled').then(c => {
        setCatalog(c)
        setPickSkills(c.map(s => s.id))
      })
    }
  }, [mode, bot])

  // Name follows the title until the user edits it; the face follows the name until customised.
  useEffect(() => {
    if (mode === 'create' && !nameTouched) setName(slugify(title))
  }, [title, nameTouched, mode])
  useEffect(() => {
    if (mode === 'create' && !avatar.custom) setAvatar(hashAvatar(name))
  }, [name, mode, avatar.custom])

  const nameError = useMemo(() => {
    if (!name) return '需要一个英文名称（用于 @提及）'
    if (!NAME_RE.test(name)) return '只能用小写字母、数字、- 和 _，以字母或数字开头'
    if (['user', 'all', 'everyone', 'you'].includes(name)) return '这是保留名称'
    if (bots[name] && (mode === 'create' || name !== bot)) return '此名称已被占用'
    return ''
  }, [name, bots, mode, bot])

  const generateSoul = async () => {
    setGenBusy(true)
    try {
      const r = await api.post('/api/soul/generate', { name, title, description, help_prompt: help, model })
      setSoul(r.soul)
      setSoulDirty(true)
      if (r.error) toast(r.error, 'error')
    } finally {
      setGenBusy(false)
    }
  }

  const submit = async () => {
    if (nameError) {
      setTab('general')
      return toast(nameError, 'error')
    }
    setBusy(true)
    try {
      if (mode === 'create') {
        const row = await api.post('/api/bots', {
          name,
          title: title.trim(),
          description: description.trim(),
          help_prompt: help.trim(),
          avatar,
          tools,
          model,
          approval,
          mcp_servers: mcpServers,
          soul: soulDirty ? soul : '',
          clone_from: base.startsWith('clone:') ? base.slice(6) : undefined,
          empty_skills: base === 'empty',
          skills: base === 'fresh' ? pickSkills : undefined,
          section: sec,
          kickoff
        })
        close()
        toast(`已创建 ${row.title || row.name}`, 'success')
        await openBot(row.name)
      } else if (bot) {
        let target = bot
        if (name !== bot) {
          const r = await api.post(`/api/bots/${bot}/rename`, { name })
          target = r.name
        }
        await api.patch(`/api/bots/${target}`, {
          title: title.trim(),
          description: description.trim(),
          avatar,
          tools,
          model,
          approval,
          mcp_servers: mcpServers,
          skills_disabled: disabled,
          section: sec
        })
        if (soulDirty) await api.put(`/api/bots/${target}/soul`, { soul })
        close()
        toast('已保存', 'success')
        if (target !== bot) await openBot(target)
      }
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'edit' && !detail) {
    return (
      <Modal onClose={close} title="编辑配置档案" width={720}>
        <Spinner />
      </Modal>
    )
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: '常规' },
    { id: 'look', label: '外观' },
    { id: 'skills', label: '能力' },
    { id: 'advanced', label: '高级' }
  ]

  return (
    <Modal
      className="bot-dialog tall"
      footer={
        <>
          {mode === 'edit' && bot && (
            <button
              className="btn danger-ghost"
              onClick={() =>
                confirm('删除机器人和它的配置档案？', `「${title || bot}」的人格、记忆、技能、聊天记录和定时任务都会被永久删除。`, '删除', async () => {
                  await api.del(`/api/bots/${bot}`)
                  close()
                })
              }
            >
              <Icon name="trash" size={14} /> 删除
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={close}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner size={12} /> : null}
            {mode === 'create' ? (busy ? '正在创建…' : '创建机器人') : '保存'}
          </button>
        </>
      }
      onClose={close}
      title={mode === 'create' ? '新建机器人' : `编辑 · ${detail?.title || bot}`}
      width={720}
    >
      {mode === 'create' && <p className="muted dialog-lead">拥有独立记忆、技能和聊天的具名队友，可以和你、也可以和其他机器人协作。</p>}
      <Tabs onChange={setTab} tabs={tabs} value={tab} />
      <div className="tab-body">
        {tab === 'general' && (
          <div className="form">
            <div className="grid2">
              <Field hint="界面上显示的名字，可以用中文" label="显示名称">
                <input autoFocus onChange={e => setTitle(e.target.value)} placeholder="例如：研究员小研" value={title} />
              </Field>
              <Field hint={nameError && (nameTouched || title || mode === 'edit') ? <span className="warn">{nameError}</span> : `大家用 @${name || 'name'} 来叫它`} label="名称（英文）">
                <input
                  onChange={e => {
                    setNameTouched(true)
                    setName(e.target.value.toLowerCase())
                  }}
                  placeholder="researcher"
                  value={name}
                />
              </Field>
            </div>
            <Field hint="其他机器人也会看到这段描述，用来决定什么事该找它" label="描述">
              <textarea onChange={e => setDescription(e.target.value)} placeholder="例如：负责搜集资料、核实事实、写调研报告" rows={2} value={description} />
            </Field>
            {mode === 'create' && (
              <>
                <Field hint="会写进它的人格设定（SOUL.md）。留空则根据名称和描述生成。" label="这个机器人应该帮你做什么？">
                  <textarea onChange={e => setHelp(e.target.value)} placeholder="例如：每天帮我看行业新闻，挑出值得关注的发给我" rows={2} value={help} />
                </Field>
                <Field label="从哪里开始">
                  <select onChange={e => setBase(e.target.value)} value={base}>
                    <option value="fresh">新配置档案（带内置技能）</option>
                    <option value="empty">创建空配置（跳过内置技能）</option>
                    {Object.values(bots).map(b => (
                      <option key={b.name} value={`clone:${b.name}`}>
                        从「{b.title || b.name}」克隆（人格、记忆、技能）
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <div className="grid2">
              <Field label="所在分区">
                <select onChange={e => setSec(e.target.value || null)} value={sec || ''}>
                  <option value="">未分类</option>
                  {ui.sections.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              {mode === 'create' && (
                <Field label="创建后">
                  <label className="check">
                    <input checked={kickoff} onChange={e => setKickoff(e.target.checked)} type="checkbox" /> 让它先做个自我介绍
                  </label>
                </Field>
              )}
            </div>
          </div>
        )}
        {tab === 'look' && <AvatarPicker name={name} onChange={setAvatar} value={avatar} />}
        {tab === 'skills' && (
          <div className="form">
            <div className="sub-title">工具</div>
            <ToolToggles onChange={setTools} value={tools} />
            <div className="sub-title">技能</div>
            {mode === 'edit' && bot ? (
              <SkillsManager bot={bot} disabled={disabled} onDisabled={setDisabled} />
            ) : base === 'fresh' ? (
              <div className="skills">
                {catalog.map(s => (
                  <label className="skill" key={s.id}>
                    <input
                      checked={!!pickSkills?.includes(s.id)}
                      onChange={e => setPickSkills(p => (e.target.checked ? [...(p || []), s.id] : (p || []).filter(x => x !== s.id)))}
                      type="checkbox"
                    />
                    <div className="skill-main">
                      <b>{s.name}</b>
                      <span>{s.description}</span>
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <div className="muted small">{base === 'empty' ? '已选择「创建空配置」，不会安装内置技能。' : '会复制被克隆机器人的全部技能。'}</div>
            )}
            <div className="sub-title">MCP 服务器</div>
            <McpEditor bot={mode === 'edit' ? bot || null : null} onChange={setMcp} value={mcpServers} />
          </div>
        )}
        {tab === 'advanced' && (
          <div className="form">
            <div className="sub-title">模型</div>
            <ModelPicker onChange={setModel} value={model} />
            <Field label="命令审批">
              <select onChange={e => setApproval(e.target.value)} value={approval}>
                {APPROVAL.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              hint={
                mode === 'create'
                  ? '可选。填写后会替换自动生成的人格。队友协作协议由系统自动注入，不用写在这里。'
                  : '它的身份和性格。队友协作协议由系统自动注入，不用写在这里。'
              }
              label={
                <span className="label-row">
                  SOUL.md（人格设定）
                  <button className="link" disabled={genBusy} onClick={() => void generateSoul()} type="button">
                    {genBusy ? '生成中…' : '✨ 用 AI 生成'}
                  </button>
                </span>
              }
            >
              <textarea
                className="mono"
                onChange={e => {
                  setSoul(e.target.value)
                  setSoulDirty(true)
                }}
                placeholder={'# 名字\n\n你是……'}
                rows={12}
                value={soul}
              />
            </Field>
            {mode === 'edit' && (
              <div className="kv muted small">
                <span>工作目录：</span>
                <code>{detail?.workspace}</code>
              </div>
            )}
            {mode === 'edit' && detail && detail.previous_names.length > 0 && <div className="muted small">曾用名：{detail.previous_names.join('、')}</div>}
          </div>
        )}
      </div>
    </Modal>
  )
}

export function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="tool-toggle">
      <div>
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}
