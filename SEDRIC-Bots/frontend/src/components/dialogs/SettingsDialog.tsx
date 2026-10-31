import { useState } from 'react'

import { api } from '../../api'
import { openDialog, toast, useStore } from '../../store'
import type { Provider, Settings } from '../../types'
import { cls } from '../../utils'
import { Icon } from '../icons'
import { Field, Modal, Spinner, Tabs } from '../ui'

const PRESETS: Omit<Provider, 'id'>[] = [
  { name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', api_key_env: 'DEEPSEEK_API_KEY', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { name: '通义千问（阿里云百炼）', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key_env: 'DASHSCOPE_API_KEY', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { name: 'Kimi（Moonshot）', base_url: 'https://api.moonshot.cn/v1', api_key_env: 'MOONSHOT_API_KEY', models: ['kimi-k2-0905-preview', 'moonshot-v1-32k'] },
  { name: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', api_key_env: 'ZHIPUAI_API_KEY', models: ['glm-4.6', 'glm-4-flash'] },
  { name: 'MiniMax', base_url: 'https://api.minimaxi.com/v1', api_key_env: 'MINIMAX_API_KEY', models: ['MiniMax-M2'] },
  { name: '硅基流动 SiliconFlow', base_url: 'https://api.siliconflow.cn/v1', api_key_env: 'SILICONFLOW_API_KEY', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'] },
  { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY', models: ['openrouter/auto'] },
  { name: 'OpenAI', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY', models: ['gpt-4o-mini', 'gpt-4o'] },
  { name: 'Ollama（本地）', base_url: 'http://127.0.0.1:11434/v1', api_key_env: '', models: ['qwen2.5:7b'] },
  { name: '自定义（OpenAI 兼容）', base_url: 'https://', api_key_env: '', models: [] }
]

type Draft = Provider & { api_key?: string; _new?: boolean }

function ProviderEditor({ p, onChange, onRemove }: { p: Draft; onChange: (p: Draft) => void; onRemove: () => void }) {
  const [fetching, setFetching] = useState(false)
  const [found, setFound] = useState<string[] | null>(null)
  const [err, setErr] = useState('')
  const [newModel, setNewModel] = useState('')
  const fetchModels = async () => {
    setFetching(true)
    setErr('')
    try {
      const r = await api.post('/api/providers/models', {
        id: p._new ? undefined : p.id,
        base_url: p.base_url,
        api_key: p.api_key ?? '__keep__',
        api_key_env: p.api_key_env
      })
      if (r.ok) setFound(r.models)
      else setErr(r.error)
    } finally {
      setFetching(false)
    }
  }
  return (
    <div className="provider">
      <div className="grid2">
        <Field label="名称">
          <input onChange={e => onChange({ ...p, name: e.target.value })} value={p.name} />
        </Field>
        <Field label="Base URL">
          <input onChange={e => onChange({ ...p, base_url: e.target.value })} placeholder="https://…/v1" value={p.base_url} />
        </Field>
      </div>
      <div className="grid2">
        <Field hint={p.api_key_set && p.api_key === undefined ? `已保存：${p.api_key_masked}（留空则不修改）` : 'Key 只保存在本机 data/settings.json'} label="API Key">
          <input onChange={e => onChange({ ...p, api_key: e.target.value })} placeholder={p.api_key_set ? '••••••••（不修改）' : 'sk-…'} type="password" value={p.api_key ?? ''} />
        </Field>
        <Field hint={p.api_key_env ? (p.env_key_found ? '✓ 已在环境变量里找到' : '没有 Key 时会读这个环境变量') : '可选'} label="或者从环境变量读取">
          <input onChange={e => onChange({ ...p, api_key_env: e.target.value })} placeholder="例如 DEEPSEEK_API_KEY" value={p.api_key_env} />
        </Field>
      </div>
      <Field label="模型">
        <div className="model-tags">
          {p.models.map(m => (
            <span className="tag" key={m}>
              {m}
              <button onClick={() => onChange({ ...p, models: p.models.filter(x => x !== m) })}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          <input
            className="tag-input"
            onChange={e => setNewModel(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && newModel.trim()) {
                e.preventDefault()
                onChange({ ...p, models: [...new Set([...p.models, newModel.trim()])] })
                setNewModel('')
              }
            }}
            placeholder="输入模型名回车添加"
            value={newModel}
          />
        </div>
      </Field>
      <div className="row-start">
        <button className="btn sm" disabled={fetching} onClick={() => void fetchModels()}>
          {fetching ? <Spinner size={11} /> : <Icon name="refresh" size={12} />} 测试连接并获取模型列表
        </button>
        <span className="spacer" />
        <button className="btn sm danger-ghost" onClick={onRemove}>
          <Icon name="trash" size={12} /> 移除
        </button>
      </div>
      {err && <div className="warn small">{err}</div>}
      {found && (
        <div className="found">
          <div className="small ok">✓ 连接成功，共 {found.length} 个模型（点击添加）：</div>
          <div className="model-tags">
            {found.slice(0, 80).map(m => (
              <button className={cls('tag', p.models.includes(m) && 'on')} key={m} onClick={() => onChange({ ...p, models: p.models.includes(m) ? p.models.filter(x => x !== m) : [...p.models, m] })}>
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function SettingsDialog({ initialTab }: { initialTab?: string }) {
  const settings = useStore(s => s.settings) as Settings
  const close = () => openDialog(null)
  const [tab, setTab] = useState<'models' | 'general' | 'about'>((initialTab as any) || 'models')
  const [providers, setProviders] = useState<Draft[]>(settings.providers.filter(p => !p.builtin).map(p => ({ ...p, api_key: undefined })))
  const [defProv, setDefProv] = useState(settings.default_provider)
  const [defModel, setDefModel] = useState(settings.default_model)
  const [userName, setUserName] = useState(settings.user_name)
  const [approval, setApproval] = useState(settings.approval_mode)
  const [maxIter, setMaxIter] = useState(settings.max_iterations)
  const [ctx, setCtx] = useState(settings.context_chars)
  const [theme, setTheme] = useState(settings.theme)
  const [open, setOpen] = useState<string | null>(providers[0]?.id || null)
  const [busy, setBusy] = useState(false)

  const allProviders = [settings.providers.find(p => p.id === 'mock')!, ...providers]
  const defModels = allProviders.find(p => p.id === defProv)?.models || []

  const add = (preset: Omit<Provider, 'id'>) => {
    const id = 'p' + Date.now().toString(36)
    setProviders(ps => [...ps, { ...preset, id, _new: true, api_key: '' }])
    setOpen(id)
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.put('/api/settings', {
        providers: providers.map(p => ({
          id: p.id,
          name: p.name,
          base_url: p.base_url,
          api_key: p.api_key === undefined || p.api_key === '' ? (p._new ? '' : '__keep__') : p.api_key,
          api_key_env: p.api_key_env,
          models: p.models
        })),
        default_provider: defProv,
        default_model: defModel,
        user_name: userName,
        approval_mode: approval,
        max_iterations: Number(maxIter) || 24,
        context_chars: Number(ctx) || 120000,
        theme
      })
      toast('设置已保存', 'success')
      close()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      className="tall"
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </>
      }
      onClose={close}
      title="设置"
      width={760}
    >
      <Tabs
        onChange={setTab}
        tabs={[
          { id: 'models', label: '模型' },
          { id: 'general', label: '通用' },
          { id: 'about', label: '关于' }
        ]}
        value={tab}
      />
      <div className="tab-body">
        {tab === 'models' && (
          <div className="form">
            <div className="sub-title">默认模型（机器人没有单独指定时使用）</div>
            <div className="grid2">
              <Field label="提供商">
                <select
                  onChange={e => {
                    setDefProv(e.target.value)
                    setDefModel(allProviders.find(p => p.id === e.target.value)?.models[0] || '')
                  }}
                  value={defProv}
                >
                  {allProviders.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="模型">
                {defModels.length ? (
                  <select onChange={e => setDefModel(e.target.value)} value={defModel}>
                    {!defModels.includes(defModel) && defModel && <option>{defModel}</option>}
                    {defModels.map(m => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input onChange={e => setDefModel(e.target.value)} value={defModel} />
                )}
              </Field>
            </div>
            <div className="sub-title">提供商（任何 OpenAI 兼容接口）</div>
            <div className="providers">
              <div className="provider-head static">
                <Icon name="sparkle" size={14} /> <b>演示模式</b>
                <span className="muted small">内置，不需要 Key。用固定规则模拟回复，可以体验所有功能。</span>
              </div>
              {providers.map((p, i) => (
                <div className={cls('provider-wrap', open === p.id && 'open')} key={p.id}>
                  <button className="provider-head" onClick={() => setOpen(open === p.id ? null : p.id)}>
                    <Icon className={cls('caret', open !== p.id && 'closed')} name="down" size={12} />
                    <b>{p.name}</b>
                    <span className="muted small">{p.base_url}</span>
                    <span className={cls('small', p.api_key_set || p.api_key || p.api_key_env ? 'ok' : 'warn')}>
                      {p.api_key_set || p.api_key
                        ? '已设置 Key'
                        : p.api_key_env
                          ? `读取环境变量 ${p.api_key_env}${p._new ? '' : p.env_key_found ? ' ✓' : '（未找到）'}`
                          : p.base_url.includes('127.0.0.1')
                            ? '本地'
                            : '未设置 Key'}
                    </span>
                  </button>
                  {open === p.id && (
                    <ProviderEditor
                      onChange={np => setProviders(providers.map((x, j) => (j === i ? np : x)))}
                      onRemove={() => setProviders(providers.filter((_, j) => j !== i))}
                      p={p}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="sub-title">添加提供商</div>
            <div className="preset-grid">
              {PRESETS.map(p => (
                <button className="preset" key={p.name} onClick={() => add(p)}>
                  <b>{p.name}</b>
                  <span>{p.base_url.replace(/^https?:\/\//, '')}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === 'general' && (
          <div className="form">
            <div className="grid2">
              <Field hint="机器人会这样称呼你" label="你的称呼">
                <input onChange={e => setUserName(e.target.value)} value={userName} />
              </Field>
              <Field label="主题">
                <select onChange={e => setTheme(e.target.value)} value={theme}>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                  <option value="system">跟随系统</option>
                </select>
              </Field>
            </div>
            <Field hint="每个机器人可以在「编辑 → 高级」里单独覆盖" label="命令审批（全局默认）">
              <select onChange={e => setApproval(e.target.value)} value={approval}>
                <option value="smart">智能：只有危险命令（删除、关机、改注册表、强推…）才问我</option>
                <option value="always">每条命令、每次写工作目录外的文件都问我</option>
                <option value="auto">全自动：从不询问（小心）</option>
              </select>
            </Field>
            <div className="grid2">
              <Field hint="一个回合里最多连续调用多少轮工具" label="单回合最大步数">
                <input min={4} onChange={e => setMaxIter(Number(e.target.value))} type="number" value={maxIter} />
              </Field>
              <Field hint="超过约 85% 时自动压缩较早的对话" label="上下文预算（字符）">
                <input min={20000} onChange={e => setCtx(Number(e.target.value))} step={10000} type="number" value={ctx} />
              </Field>
            </div>
          </div>
        )}
        {tab === 'about' && (
          <div className="form about">
            <p>
              <b>SEDRIC Bots</b> 参考了 Nous Research{' '}
              <a href="https://github.com/NousResearch/hermes-agent" rel="noreferrer" target="_blank">
                hermes-agent
              </a>{' '}
              桌面端「Bot Mode」重新实现：一个机器人 = 一个独立的智能体配置档案（人格、记忆、技能、聊天），机器人之间可以私信，也可以在群聊里按轮次协作，还能按计划自动执行任务。
            </p>
            <p className="muted small">参考的原项目采用 MIT 许可证。数据全部保存在本机的 data/ 目录。</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
