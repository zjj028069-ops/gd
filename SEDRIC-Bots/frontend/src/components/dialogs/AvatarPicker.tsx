import { useRef } from 'react'

import { imageToDataUrl } from '../../api'
import { toast } from '../../store'
import type { Avatar, Mood } from '../../types'
import { cls } from '../../utils'
import { BotFace, COLORS, SHAPE_LABELS, SHAPES } from '../Avatar'
import { Icon } from '../icons'

export function AvatarPicker({ value, name, onChange }: { value: Avatar; name: string; onChange: (a: Avatar) => void }) {
  const file = useRef<HTMLInputElement>(null)
  const moods: Mood[] = ['idle', 'think', 'work']
  return (
    <div className="avatar-picker">
      <div className="ap-preview">
        {moods.map(m => (
          <div key={m}>
            <BotFace avatar={value} mood={m} name={name || 'bot'} size={64} />
            <span>{{ idle: '空闲', think: '思考', work: '干活' }[m as 'idle']}</span>
          </div>
        ))}
      </div>
      {value.image ? (
        <div className="ap-row">
          <button className="btn" onClick={() => onChange({ ...value, image: null, custom: true })}>
            <Icon name="x" size={14} /> 移除图片，改用形状头像
          </button>
        </div>
      ) : (
        <>
          <div className="ap-label">形状</div>
          <div className="ap-shapes">
            {SHAPES.map(s => (
              <button className={cls('ap-shape', value.shape === s && 'on')} key={s} onClick={() => onChange({ ...value, shape: s, custom: true })} title={SHAPE_LABELS[s]}>
                <BotFace avatar={{ ...value, shape: s, image: null }} name={name} size={36} still />
              </button>
            ))}
          </div>
          <div className="ap-label">颜色</div>
          <div className="ap-colors">
            {COLORS.map(c => (
              <button className={cls('swatch', value.color === c && 'on')} key={c} onClick={() => onChange({ ...value, color: c, custom: true })} style={{ background: c }} />
            ))}
            <label className="swatch custom" title="自定义颜色">
              <input onChange={e => onChange({ ...value, color: e.target.value, custom: true })} type="color" value={value.color} />
            </label>
          </div>
        </>
      )}
      <div className="ap-row">
        <button
          className="btn"
          onClick={() =>
            onChange({
              shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
              color: COLORS[Math.floor(Math.random() * COLORS.length)],
              image: null,
              custom: true
            })
          }
        >
          <Icon name="dice" size={14} /> 随机
        </button>
        <button className="btn" onClick={() => file.current?.click()}>
          <Icon name="upload" size={14} /> 上传图片
        </button>
        <input
          accept="image/*"
          hidden
          onChange={async e => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            if (f.size > 15 * 1024 * 1024) return toast('图片过大（最大 15MB）', 'error')
            try {
              onChange({ ...value, image: await imageToDataUrl(f, 256), custom: true })
            } catch (err: any) {
              toast(err.message, 'error')
            }
          }}
          ref={file}
          type="file"
        />
      </div>
    </div>
  )
}
