/**
 * Bot faces: a coloured body (one of a few shapes) with two eyes that blink,
 * look around while thinking and sway while working, plus three "typing" dots.
 * One shared animation clock paints every face on the page (ported from the
 * Hermes Bot Mode "math face").
 */
import { memo, useEffect, useRef } from 'react'

import type { Avatar as AvatarT, Mood } from './types'

export const SHAPES = ['circle', 'blob', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop', 'pebble']
export const COLORS = [
  '#8b5cf6', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316',
  '#ef4444', '#ec4899', '#a855f7', '#64748b', '#0f172a', '#7f1d1d', '#d6c7a1'
]
export const SHAPE_LABELS: Record<string, string> = {
  circle: '圆形', blob: '软糖', squircle: '圆角方', pill: '胶囊', triangle: '三角',
  hexagon: '六边形', cloud: '云朵', drop: '水滴', pebble: '鹅卵石'
}

type Pt = [number, number]
const CLOUD = 'M11 32 a7.5 7.5 0 0 1 -1 -14.9 A9.5 9.5 0 0 1 29 12.5 A7 7 0 0 1 30 32 Z'

function sampleRing(shape: string, steps = 52): Pt[] {
  const pts: Pt[] = []
  if (shape === 'drop') {
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2
      pts.push([20 + 15 * Math.sin(t) * Math.sin(t / 2), 3.5 + 33 * (1 - Math.cos(t)) / 2])
    }
    return pts
  }
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    let rx = 16.2
    let ry = 16.2
    if (shape === 'blob') {
      rx = ry = 16 + 1.7 * Math.sin(3 * a) + 0.7 * Math.cos(5 * a)
    } else if (shape === 'squircle') {
      const d = Math.pow(Math.abs(c) ** 5 + Math.abs(s) ** 5, 1 / 5) || 1
      rx = ry = 16.2 / d
    } else if (shape === 'pill') {
      const d = Math.pow(Math.abs(c) ** 8 + Math.abs(s / 0.72) ** 8, 1 / 8) || 1
      rx = ry = 16 / d
    } else if (shape === 'triangle') {
      const u = (a + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)
      const sector = (u / ((Math.PI * 2) / 3)) % 1
      rx = ry = 13.5 / Math.max(0.42, Math.cos((sector - 0.5) * 1.9))
    } else if (shape === 'hexagon') {
      const seg = Math.PI / 3
      rx = ry = (16.2 * Math.cos(seg / 2)) / Math.cos(a - seg * Math.round(a / seg))
    } else if (shape === 'pebble') {
      rx = 16.4 * (1.04 - 0.14 * Math.cos(2 * a))
      ry = 15.2 * (1.06 + 0.08 * Math.sin(2 * a))
    }
    pts.push([20 + rx * c, 20 + ry * s])
  }
  return pts
}

const ringCache = new Map<string, Pt[]>()
function ring(shape: string) {
  let r = ringCache.get(shape)
  if (!r) {
    r = sampleRing(shape)
    ringCache.set(shape, r)
  }
  return r
}

function project([x, y]: Pt, turn: number, tilt: number, roll: number): Pt {
  const dx = x - 20
  const dy = y - 20
  const r = (roll * Math.PI) / 180
  const xr = dx * Math.cos(r) - dy * Math.sin(r)
  const yr = dx * Math.sin(r) + dy * Math.cos(r)
  const sx = 0.74 + 0.26 * Math.abs(Math.cos((turn * Math.PI) / 180))
  const sy = 0.8 + 0.2 * Math.abs(Math.cos((tilt * Math.PI) / 180))
  return [20 + xr * sx, 20 + yr * sy]
}

function toPath(pts: Pt[]) {
  return 'M' + pts.map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('L') + 'Z'
}

interface Pose {
  turn: number
  tilt: number
  roll: number
  gazeX: number
  gazeY: number
  blink: boolean
  d0: number
  d1: number
  d2: number
}

function pose(mood: string, t: number, seed: number): Pose {
  t += seed
  const dots = (speed: number) => ({
    d0: 0.2 + 0.8 * Math.max(0, Math.sin(t * speed)),
    d1: 0.2 + 0.8 * Math.max(0, Math.sin(t * speed - 0.7)),
    d2: 0.2 + 0.8 * Math.max(0, Math.sin(t * speed - 1.4))
  })
  if (mood === 'think') {
    return {
      turn: -18 + Math.sin(t * 0.55) * 14,
      tilt: Math.sin(t * 0.48) * 12 + Math.sin(t * 1.35) * 3,
      roll: Math.sin(t * 0.95) * 10,
      gazeX: Math.sin(t * 0.7) * 3.6,
      gazeY: -2.2 + Math.sin(t * 0.4) * 2.2,
      blink: t % 1.45 > 1.26,
      ...dots(2.4)
    }
  }
  if (mood === 'work') {
    return {
      turn: -11 + Math.sin(t * 0.48) * 8,
      tilt: Math.sin(t * 0.42) * 8 + Math.sin(t * 1.1) * 1.6,
      roll: Math.sin(t * 0.75) * 4.2,
      gazeX: Math.sin(t * 0.55) * 3.6,
      gazeY: -1.6 + Math.sin(t * 0.38) * 2,
      blink: t % 1.45 > 1.26,
      ...dots(2.6)
    }
  }
  if (mood === 'wait') {
    return {
      turn: Math.sin(t * 0.8) * 6,
      tilt: Math.sin(t * 1.6) * 6,
      roll: 0,
      gazeX: Math.sin(t * 1.3) * 2.5,
      gazeY: -1.5,
      blink: t % 2.2 > 2.05,
      d0: 0.9,
      d1: 0.15,
      d2: 0.9
    }
  }
  return {
    turn: Math.sin(t * 0.5) * 1.5,
    tilt: Math.sin(t * 0.27),
    roll: Math.sin(t * 0.85) * 1.2,
    gazeX: 0,
    gazeY: 0,
    blink: t % 3.2 > 3.02,
    d0: 0,
    d1: 0,
    d2: 0
  }
}

// ── shared clock ─────────────────────────────────────────────────────────────

const faces = new Set<SVGSVGElement>()
const blend = new WeakMap<SVGSVGElement, { mood: string; since: number; from: Pose; last: Pose }>()
let raf = 0
let lastPaint = 0

function paint(svg: SVGSVGElement, t: number) {
  const mood = svg.dataset.mood || 'idle'
  const shape = svg.dataset.shape || 'circle'
  const seed = Number(svg.dataset.seed || 0)
  const target = pose(mood, t, seed)
  let st = blend.get(svg)
  if (!st) {
    st = { mood, since: t - 1, from: target, last: target }
    blend.set(svg, st)
  }
  if (st.mood !== mood) {
    st.mood = mood
    st.from = st.last
    st.since = t
  }
  const k = Math.min(1, (t - st.since) / 0.4)
  const e = 1 - (1 - k) ** 2
  const p: Pose = { ...target }
  for (const key of ['turn', 'tilt', 'roll', 'gazeX', 'gazeY', 'd0', 'd1', 'd2'] as const) {
    p[key] = st.from[key] + (target[key] - st.from[key]) * e
  }
  st.last = p
  const body = svg.querySelector('[data-body]')
  if (body && shape !== 'cloud') {
    body.setAttribute('d', toPath(ring(shape).map(pt => project(pt, p.turn, p.tilt, p.roll))))
  }
  const eyeY = (shape === 'cloud' ? 22 : shape === 'drop' ? 22 : 17.2) + p.gazeY
  const eyeL = 15.4 + p.gazeX
  const eyeR = 24.6 + p.gazeX
  const set = (sel: string, attrs: Record<string, number | string>) => {
    const el = svg.querySelector(sel)
    if (el) for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, String(v))
  }
  set('[data-el]', { cx: eyeL, cy: eyeY })
  set('[data-er]', { cx: eyeR, cy: eyeY })
  set('[data-hl]', { cx: eyeL - 0.6, cy: eyeY - 0.7 })
  set('[data-hr]', { cx: eyeR - 0.6, cy: eyeY - 0.7 })
  set('[data-open]', { opacity: p.blink ? 0 : 1 })
  set('[data-shut]', {
    d: `M${eyeL - 2.6} ${eyeY} L${eyeL + 2.6} ${eyeY} M${eyeR - 2.6} ${eyeY} L${eyeR + 2.6} ${eyeY}`,
    opacity: p.blink ? 1 : 0
  })
  svg.querySelectorAll('[data-dot]').forEach((d, i) => d.setAttribute('opacity', String([p.d0, p.d1, p.d2][i])))
  svg.style.transform = `rotate(${p.tilt.toFixed(2)}deg)`
}

function tick(now: number) {
  raf = requestAnimationFrame(tick)
  if (document.visibilityState !== 'visible') return
  const busy = [...faces].some(f => f.dataset.mood !== 'idle')
  // Idle faces only need ~12fps; busy ones get ~30fps.
  if (now - lastPaint < (busy ? 33 : 80)) return
  lastPaint = now
  const t = now / 1000
  faces.forEach(f => paint(f, t))
}

function register(svg: SVGSVGElement) {
  faces.add(svg)
  if (!raf) raf = requestAnimationFrame(tick)
  return () => {
    faces.delete(svg)
    if (!faces.size && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}

function isDark(hex: string) {
  const n = parseInt((hex || '#888888').slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110
}

function hashSeed(s: string) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (h % 1000) / 37
}

interface Props {
  avatar?: AvatarT | null
  name: string
  mood?: Mood
  size?: number
  still?: boolean
}

export const BotFace = memo(function BotFace({ avatar, name, mood = 'idle', size = 32, still }: Props) {
  const ref = useRef<SVGSVGElement>(null)
  const shape = avatar?.shape && SHAPES.includes(avatar.shape) ? avatar.shape : 'circle'
  const color = avatar?.color || '#8b5cf6'

  useEffect(() => {
    if (still || !ref.current) return
    return register(ref.current)
  }, [still, shape])

  if (avatar?.image) {
    return (
      <span className={`face-img mood-${mood}`} style={{ width: size, height: size }}>
        <img alt="" src={avatar.image} />
        {mood !== 'idle' && <i className="face-img-dot" />}
      </span>
    )
  }

  const eye = isDark(color) ? 'rgba(232,220,195,0.95)' : 'rgba(0,0,0,0.85)'
  const hl = isDark(color) ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)'
  const eyeY = shape === 'cloud' || shape === 'drop' ? 22 : 17.2
  const working = mood === 'work' || mood === 'think'
  return (
    <svg
      aria-hidden
      className="face"
      data-mood={mood}
      data-seed={hashSeed(name)}
      data-shape={shape}
      height={size}
      ref={ref}
      viewBox="0 0 40 44"
      width={size}
    >
      <path d={shape === 'cloud' ? CLOUD : toPath(ring(shape))} data-body fill={color} stroke="var(--face-edge)" strokeWidth={1} />
      <g data-open>
        <ellipse cx={15.4} cy={eyeY} data-el fill={eye} rx={2.2} ry={working ? 2.6 : 2.3} />
        <ellipse cx={24.6} cy={eyeY} data-er fill={eye} rx={2.2} ry={working ? 2.6 : 2.3} />
        <circle cx={14.8} cy={eyeY - 0.7} data-hl fill={hl} r={0.65} />
        <circle cx={24} cy={eyeY - 0.7} data-hr fill={hl} r={0.65} />
      </g>
      <path
        d={`M12.8 ${eyeY} L18 ${eyeY} M22 ${eyeY} L27.2 ${eyeY}`}
        data-shut
        fill="none"
        opacity={0}
        stroke={eye}
        strokeLinecap="round"
        strokeWidth={2}
      />
      <g>
        {[16.4, 20, 23.6].map(x => (
          <circle cx={x} cy={41.2} data-dot fill={color} key={x} opacity={0} r={1.15} />
        ))}
      </g>
    </svg>
  )
})

export function GroupFace({ image, members, avatars, size = 32 }: {
  image?: string | null
  members: string[]
  avatars: Record<string, AvatarT | undefined>
  size?: number
}) {
  if (image) {
    return (
      <span className="face-img" style={{ width: size, height: size, borderRadius: size * 0.3 }}>
        <img alt="" src={image} />
      </span>
    )
  }
  const shown = members.slice(0, 4)
  const cell = size / 2
  // Two members sit on the diagonal; one member fills the tile.
  const slots: (string | null)[] =
    shown.length === 1 ? [shown[0]] : shown.length === 2 ? [shown[0], null, null, shown[1]] : shown
  if (shown.length === 1) {
    return (
      <span className="group-face single" style={{ width: size, height: size }}>
        <BotFace avatar={avatars[shown[0]]} name={shown[0]} size={size * 0.78} still />
      </span>
    )
  }
  return (
    <span className="group-face" style={{ width: size, height: size }}>
      {slots.map((m, i) => (
        <span key={m || 'empty' + i} style={{ width: cell, height: cell }}>
          {m && <BotFace avatar={avatars[m]} name={m} size={cell * 0.92} still />}
        </span>
      ))}
    </span>
  )
}
