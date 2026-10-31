export function cls(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

export function ago(ms?: number | null) {
  if (!ms) return ''
  const d = (Date.now() - ms) / 1000
  if (d < 60) return '刚刚'
  if (d < 3600) return `${Math.floor(d / 60)} 分钟`
  if (d < 86400) return `${Math.floor(d / 3600)} 小时`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天`
  return new Date(ms).toLocaleDateString()
}

export function clock(ms?: number | null) {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date()
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export function dateTime(ms?: number | null) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function prettyJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function slugify(text: string) {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return s
}
