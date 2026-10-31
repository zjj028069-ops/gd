// 与 SEDRIC-Bots/frontend/src/types.ts 中的同名类型一致
export type Mood = 'idle' | 'think' | 'work' | 'wait'

export interface Avatar {
  shape: string
  color: string
  image?: string | null
  custom?: boolean
}
