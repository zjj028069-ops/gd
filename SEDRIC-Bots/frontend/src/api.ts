import type { Attachment } from './types'

export class ApiError extends Error {}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let data: any = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    throw new ApiError((data && (data.error || data.detail)) || `请求失败（${res.status}）`)
  }
  return data as T
}

export const api = {
  get: <T = any>(url: string) => req<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => req<T>('POST', url, body),
  put: <T = any>(url: string, body: unknown) => req<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown) => req<T>('PATCH', url, body),
  del: <T = any>(url: string) => req<T>('DELETE', url)
}

export async function upload(file: File): Promise<Attachment> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/upload', { method: 'POST', body: fd })
  const data = await res.json()
  if (!res.ok) throw new ApiError(data?.error || '上传失败')
  return data
}

/** Downscale an image file to a square-ish data URL (for avatars / room pictures). */
export function imageToDataUrl(file: File, max = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * scale)
      c.height = Math.round(img.height * scale)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('无法读取图片'))
    img.src = url
  })
}
