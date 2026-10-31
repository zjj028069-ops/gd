import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cls } from '../utils'
import { Icon } from './icons'

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
  className
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}) {
  const backdrop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Only the top-most modal reacts, so Esc on a confirm box keeps the dialog under it.
      const all = document.querySelectorAll('.modal-backdrop')
      if (all[all.length - 1] === backdrop.current) onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()} ref={backdrop}>
      <div className={cls('modal', className)} role="dialog" style={{ width }}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export interface MenuItem {
  label: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  divider?: boolean
  sub?: MenuItem[]
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y])
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    setTimeout(() => window.addEventListener('mousedown', close), 0)
    window.addEventListener('keydown', k)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', k)
    }
  }, [onClose])
  return createPortal(
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.divider ? (
          <div className="menu-divider" key={i} />
        ) : it.sub ? (
          <div className="menu-item has-sub" key={i}>
            {it.icon && <Icon name={it.icon} size={14} />}
            <span>{it.label}</span>
            <Icon className="menu-caret" name="right" size={12} />
            <div className="menu sub">
              {it.sub.map((s, j) =>
                s.divider ? (
                  <div className="menu-divider" key={j} />
                ) : (
                  <button
                    className={cls('menu-item', s.danger && 'danger')}
                    disabled={s.disabled}
                    key={j}
                    onClick={() => {
                      onClose()
                      s.onClick?.()
                    }}
                  >
                    {s.icon && <Icon name={s.icon} size={14} />}
                    <span>{s.label}</span>
                  </button>
                )
              )}
            </div>
          </div>
        ) : (
          <button
            className={cls('menu-item', it.danger && 'danger')}
            disabled={it.disabled}
            key={i}
            onClick={() => {
              onClose()
              it.onClick?.()
            }}
          >
            {it.icon && <Icon name={it.icon} size={14} />}
            <span>{it.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}

export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const open = (e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) => {
    e.preventDefault?.()
    e.stopPropagation?.()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  const node = menu ? <Menu items={menu.items} onClose={() => setMenu(null)} x={menu.x} y={menu.y} /> : null
  return { open, node }
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        components={{
          a: ({ node: _n, ...props }) => <a {...props} rel="noreferrer" target="_blank" />,
          pre: ({ node: _n, children, ...props }) => <CodeBlock {...props}>{children}</CodeBlock>
        }}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ children, ...props }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="code-wrap">
      <button
        className="code-copy"
        onClick={() => {
          void navigator.clipboard.writeText(ref.current?.innerText || '')
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  )
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      aria-pressed={checked}
      className={cls('toggle', checked && 'on')}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span />
    </button>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map(t => (
        <button className={cls('tab', value === t.id && 'active')} key={t.id} onClick={() => onChange(t.id)} type="button">
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}
