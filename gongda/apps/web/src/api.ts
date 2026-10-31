export type EntityId = string | number;
export type UserRole = 'admin' | 'planner' | 'worker';

export interface Session {
  csrf_token: string;
  user: { id: EntityId; display_name: string };
  tenant: { id: EntityId; name: string; slug: string };
  role: UserRole;
  expires_at: string;
  permissions: string[];
  data_scope: 'all' | 'department' | 'self';
  department_id: string | null;
  points?: string[] | null;
  point_scopes?: Record<string, 'self' | 'team' | 'all'>;
}

export interface Unit {
  id: EntityId;
  code: string;
  name: string;
  active?: boolean;
  version?: number;
  sort?: number;
}

export interface Product {
  id: EntityId;
  code: string;
  name: string;
  specification: string | null;
  unit_id: EntityId | null;
  unit_name: string | null;
  attribute: 'manufactured' | 'purchased' | 'outsourced' | null;
  source?: '自产' | '外协加工' | '外购' | null;
  active: boolean;
  version: number;
  created_at: string;
  department_id?: string | null;
  created_by_id?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  sale_price?: string | null;
  cost_price?: string | null;
  outsource_price?: string | null;
  commission_amount?: string | null;
  commission_rate?: string | null;
  inspection_spec_id?: string | null;
  inspection_spec_name?: string | null;
  default_supplier_id?: string | null;
  supplier_name?: string | null;
  stale_days?: string | null;
  stock_upper_warn?: string | null;
  stock_lower_warn?: string | null;
  remark?: string | null;
  intro_html?: string | null;
  images?: string[];
  attachments?: string[];
  creator_name?: string | null;
  has_route?: boolean;
  extension?: { schema_version_id: string; revision: number; values: Record<string, unknown> } | null;
}

export interface AuditEvent {
  id: EntityId;
  action: string;
  entity_type: string;
  entity_id: EntityId | null;
  created_at: string;
  actor_name: string | null;
  before_data: unknown;
  after_data: unknown;
}

export interface OverviewData {
  products: number;
  units: number;
  audit_events: number | null;
  work_orders: number | null;
  stage: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly field?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('请求地址必须属于当前服务。');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.csrfToken) headers['X-CSRF-Token'] = options.csrfToken;
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务，请检查服务是否已启动后重试。');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = payload as { error?: { code?: string; message?: string; field?: string } } | null;
    if (!failure?.error?.message) console.warn('API request failed', response.status, path);
    throw new ApiError(
      response.status,
      failure?.error?.code ?? `HTTP_${response.status}`,
      failure?.error?.message ?? '网络或服务异常，请稍后重试',
      failure?.error?.field,
    );
  }
  if (payload === null && response.status !== 204) {
    throw new ApiError(response.status, 'INVALID_RESPONSE', '服务返回的数据格式无法识别。');
  }
  return payload as T;
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求未完成，请重试。';
}

export function hasPermission(session: Session, permission: string): boolean {
  return Array.isArray(session.permissions) && session.permissions.includes(permission);
}

export function hasPoint(session: Session, point: string): boolean {
  if (!Array.isArray(session.points)) return true;
  return session.points.includes(point);
}

export function canWriteProducts(session: Session): boolean {
  return hasPermission(session, 'master.write') && session.data_scope === 'all';
}

export function roleName(role: UserRole): string {
  return ({ admin: '企业管理员', planner: '计划员', worker: '员工' })[role] ?? role;
}




