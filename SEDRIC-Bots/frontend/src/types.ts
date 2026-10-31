export type Mood = 'idle' | 'think' | 'work' | 'wait'

export interface Avatar {
  shape: string
  color: string
  image?: string | null
  custom?: boolean
}

export interface Attention {
  kind: string
  text: string
}

export interface BotStatus {
  mood: Mood
  attention: Attention | null
  pending: number
  running: string[]
}

export interface SessionPreview {
  id: string
  bot: string
  title: string
  kind: 'botchat' | 'chat' | 'group' | 'routine'
  hidden: boolean
  created: number
  updated: number
  last_active: number
  preview: string
  message_count: number
  unread: boolean
}

export interface McpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

export interface ModelPick {
  provider?: string
  model?: string
}

export interface Bot {
  name: string
  title: string
  description: string
  avatar: Avatar
  tools: Record<string, boolean>
  model: ModelPick | null
  approval: string
  mcp_servers: McpServer[]
  skills_disabled?: string[]
  pinned: boolean
  hidden: boolean
  section: string | null
  previous_names: string[]
  created: number
  status: BotStatus
  chat: SessionPreview | null
  routines: number
}

export interface Skill {
  id: string
  name: string
  description: string
  body: string
  enabled?: boolean
}

export interface BotDetail extends Bot {
  soul: string
  memory: { memory: string[]; user: string[]; limits: { memory: number; user: number } }
  skills: Skill[]
  sessions: SessionPreview[]
  workspace: string
  groups: string[]
}

export interface Attachment {
  kind: 'image' | 'file' | 'pdf'
  name: string
  file: string
  url: string
  mime: string
  size: number
  text?: string | null
}

export interface ToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'event'
  content: string
  at: number
  from?: { kind: string; name?: string; dm_reply?: boolean }
  attachments?: Attachment[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
  reasoning?: string
  kind?: string
  error_kind?: string
  meta?: { kind?: string; job_id?: string; job_name?: string; status?: string }
  model?: string
  stream?: string
}

export interface Session extends SessionPreview {
  messages: Message[]
  summary?: string | null
  running: boolean
  queued: number
  phase: string
}

export interface GroupEntry {
  id: string
  at: number
  from: { kind: 'user' | 'member' | 'system'; name: string }
  text: string
  thread: string
  attachments?: Attachment[]
}

export interface GroupActivity {
  at: number
  kind: string
  thread: string
  member: string | null
  text: string
}

export interface GroupSummary {
  id: string
  name: string
  image: string | null
  members: string[]
  created: number
  updated: number
  pinned: boolean
  section: string | null
  hold_detection: boolean
  holds: string[]
  last_active: number
  preview: string
  unread: boolean
  running: string[]
  active: Record<string, string>
}

export interface Group extends GroupSummary {
  log: GroupEntry[]
  activity: GroupActivity[]
}

export interface Pending {
  id: string
  kind: 'approval' | 'clarify'
  bot: string
  sid: string
  group_id?: string | null
  thread?: string | null
  title: string
  detail?: string
  choices?: string[]
  at: number
  bot_title: string
}

export interface Provider {
  id: string
  name: string
  base_url: string
  api_key_env: string
  models: string[]
  builtin?: boolean
  api_key_set?: boolean
  api_key_masked?: string
  env_key_found?: boolean
  api_key?: string
}

export interface Settings {
  providers: Provider[]
  default_provider: string
  default_model: string
  user_name: string
  approval_mode: string
  max_iterations: number
  context_chars: number
  theme: string
}

export interface Section {
  id: string
  name: string
}

export interface UiState {
  sections: Section[]
  collapsed: string[]
}

export interface CronHistory {
  at: number
  status: string
  output: string
  manual: boolean
  duration: number
}

export interface CronJob {
  id: string
  bot: string
  name: string
  instruction: string
  schedule: { kind: string; display: string; minutes?: number; expr?: string; run_at?: number }
  schedule_text: string
  enabled: boolean
  max_runs: number | null
  runs: number
  created: number
  next_run: number | null
  last_run: number | null
  last_status: string | null
  history: CronHistory[]
  running: boolean
}

export type View =
  | { kind: 'home' }
  | { kind: 'bot'; bot: string; sid: string | null }
  | { kind: 'group'; id: string; thread: string | null }
