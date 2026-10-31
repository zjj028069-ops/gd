import { useRef, useState } from 'react'

import { api, imageToDataUrl } from '../../api'
import { confirm, openDialog, openGroup, toast, useStore } from '../../store'
import { cls } from '../../utils'
import { BotFace, GroupFace } from '../Avatar'
import { Icon } from '../icons'
import { Field, Modal, Toggle } from '../ui'

export function GroupDialog({ mode, id, members: initialMembers }: { mode: 'create' | 'manage'; id?: string; members?: string[] }) {
  const bots = useStore(s => s.bots)
  const room = useStore(s => (id ? s.groups[id] : undefined))
  const close = () => openDialog(null)
  const [name, setName] = useState(room?.name || '')
  const [image, setImage] = useState<string | null>(room?.image || null)
  const [members, setMembers] = useState<string[]>(room?.members || initialMembers || [])
  const [holdDetection, setHold] = useState(room?.hold_detection ?? true)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const avatars = Object.fromEntries(Object.values(bots).map(b => [b.name, b.avatar]))

  const list = Object.values(bots).filter(b => !q || b.name.includes(q.toLowerCase()) || (b.title || '').toLowerCase().includes(q.toLowerCase()))

  const submit = async () => {
    if (!members.length) return toast('至少选择一个机器人', 'error')
    setBusy(true)
    try {
      const auto = name.trim() || members.map(m => bots[m]?.title || m).slice(0, 3).join('、') + (members.length > 3 ? ' 等' : '')
      if (mode === 'create') {
        const g = await api.post('/api/groups', { name: auto, members, image })
        close()
        await openGroup(g.id)
      } else if (id) {
        await api.patch(`/api/groups/${id}`, { name: auto, members, image, hold_detection: holdDetection })
        close()
      }
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      footer={
        <>
          {mode === 'manage' && id && (
            <button
              className="btn danger-ghost"
              onClick={() =>
                confirm('解散群聊？', '聊天记录会被删除，成员机器人本身不受影响。', '解散', async () => {
                  await api.del(`/api/groups/${id}`)
                  close()
                })
              }
            >
              <Icon name="trash" size={14} /> 解散
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={close}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !members.length} onClick={() => void submit()}>
            {mode === 'create' ? '创建群聊' : '保存'}
          </button>
        </>
      }
      onClose={close}
      title={mode === 'create' ? '新建群聊' : '管理群聊'}
      width={600}
    >
      <p className="muted dialog-lead">一个机器人可以加入多个群聊。群里每次你发言，被 @ 的机器人（或没 @ 时所有人）会按顺序轮流回应，没话说的会自动跳过。</p>
      <div className="form">
        <div className="group-top">
          <button className="group-pic" onClick={() => file.current?.click()} title="设置群聊图片">
            <GroupFace avatars={avatars} image={image} members={members} size={56} />
            <span>更换</span>
          </button>
          <input
            accept="image/*"
            hidden
            onChange={async e => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) setImage(await imageToDataUrl(f, 256))
            }}
            ref={file}
            type="file"
          />
          <Field label="群聊名称">
            <input autoFocus onChange={e => setName(e.target.value)} placeholder="留空则用成员名字" value={name} />
          </Field>
          {image && (
            <button className="link" onClick={() => setImage(null)}>
              移除图片
            </button>
          )}
        </div>
        <Field label={`成员（已选 ${members.length}）`}>
          <input onChange={e => setQ(e.target.value)} placeholder="搜索要添加的机器人…" value={q} />
        </Field>
        <div className="member-pick">
          {list.map(b => {
            const on = members.includes(b.name)
            return (
              <button className={cls('pick', on && 'on')} key={b.name} onClick={() => setMembers(ms => (ms.includes(b.name) ? ms.filter(m => m !== b.name) : [...ms, b.name]))}>
                <BotFace avatar={b.avatar} name={b.name} size={30} still />
                <span className="pick-main">
                  <b>{b.title || b.name}</b>
                  <span>@{b.name}</span>
                </span>
                <span className="pick-check">{on && <Icon name="check" size={14} />}</span>
              </button>
            )
          })}
        </div>
        {mode === 'manage' && (
          <div className="tool-toggle">
            <div>
              <b>检测停止指令</b>
              <span>允许用「@某某 停」让指定成员暂停，直到再次提及它或发送 @all resume</span>
            </div>
            <Toggle checked={holdDetection} onChange={setHold} />
          </div>
        )}
      </div>
    </Modal>
  )
}
