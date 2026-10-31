import { useEffect, useState } from 'react'

import { api } from '../../api'
import { useStore } from '../../store'
import type { ModelPick } from '../../types'
import { Field } from '../ui'

/** Provider + model selection. `null` provider = inherit the global default. */
export function ModelPicker({ value, onChange, allowInherit = true }: { value: ModelPick | null; onChange: (v: ModelPick | null) => void; allowInherit?: boolean }) {
  const settings = useStore(s => s.settings)
  const providers = settings?.providers || []
  const pid = value?.provider || ''
  const prov = providers.find(p => p.id === pid)
  const [remote, setRemote] = useState<string[]>([])
  const [manual, setManual] = useState(false)

  useEffect(() => {
    setRemote([])
    if (!prov || prov.id === 'mock') return
    api
      .post('/api/providers/models', { id: prov.id, base_url: prov.base_url, api_key_env: prov.api_key_env })
      .then(r => r.ok && setRemote(r.models))
      .catch(() => {})
  }, [prov?.id])

  const models = [...new Set([...(prov?.models || []), ...remote])]
  const defaultProv = providers.find(p => p.id === settings?.default_provider)

  return (
    <div className="grid2">
      <Field label="提供商">
        <select
          onChange={e => {
            const v = e.target.value
            if (!v) onChange(null)
            else onChange({ provider: v, model: providers.find(p => p.id === v)?.models[0] || '' })
          }}
          value={pid}
        >
          {allowInherit && <option value="">继承默认（{defaultProv?.name || settings?.default_provider} · {settings?.default_model}）</option>}
          {providers.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        hint={
          pid && (
            <button className="link" onClick={() => setManual(!manual)} type="button">
              {manual ? '← 返回下拉选项' : '✏️ 手动输入…'}
            </button>
          )
        }
        label="模型"
      >
        {!pid ? (
          <input disabled value="（继承）" />
        ) : manual || !models.length ? (
          <input onChange={e => onChange({ provider: pid, model: e.target.value })} placeholder="例如：deepseek-chat" value={value?.model || ''} />
        ) : (
          <select onChange={e => onChange({ provider: pid, model: e.target.value })} value={value?.model || ''}>
            {!models.includes(value?.model || '') && value?.model && <option value={value.model}>{value.model}</option>}
            {models.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
      </Field>
    </div>
  )
}
