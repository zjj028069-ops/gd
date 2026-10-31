import { randomUUID } from 'node:crypto';
import type { Sql } from '../database.js';
import { createRouteFromImport } from '../masters.js';
import { Problem, type Actor } from '../services.js';
import { readAiConfig, type AiConfig } from './config.js';

export type DrawingStep = {
  index: number;
  name: string;
  note: string;
  standard_minutes: string;
  auto_inbound: boolean;
  process_id: string | null;
  match: 'matched' | 'unmatched' | 'new';
};

export type DrawingPreview = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  filename: string;
  note: string;
  template: 'garment' | 'machining' | 'custom';
  route_name: string;
  steps: DrawingStep[];
  warnings: string[];
};

export type ConfirmMode = 'process_route_draft' | 'link_work_order';

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map<string, DrawingPreview>();

const GARMENT_STEPS = ['裁剪', '缝制', '整烫', '质检', '包装'];
const MACHINING_STEPS = ['下料', '粗加工', '精加工', '热处理', '检验', '入库'];

function purgeExpired() {
  const now = Date.now();
  for (const [id, preview] of previews) {
    if (now - preview.created_at > PREVIEW_TTL_MS) previews.delete(id);
  }
}

export function peekDrawingPreview(previewId: string, tenantId: string): DrawingPreview | null {
  purgeExpired();
  const preview = previews.get(previewId);
  if (!preview || preview.tenant_id !== tenantId) return null;
  return preview;
}

export function getDrawingPreview(previewId: string, tenantId: string): DrawingPreview {
  const preview = peekDrawingPreview(previewId, tenantId);
  if (!preview) {
    throw new Problem(404, 'PREVIEW_NOT_FOUND', '预览已失效或不存在，请重新上传');
  }
  return preview;
}

export function discardDrawingPreview(previewId: string, tenantId: string) {
  purgeExpired();
  const preview = previews.get(previewId);
  if (!preview || preview.tenant_id !== tenantId) {
    throw new Problem(404, 'PREVIEW_NOT_FOUND', '预览已失效或不存在');
  }
  previews.delete(previewId);
  return { ok: true as const };
}

/** 测试用：清空内存预览。 */
export function resetDrawingForTests() {
  previews.clear();
}

function detectTemplate(note: string, filename: string): 'garment' | 'machining' {
  const text = `${note} ${filename}`.toLowerCase();
  if (/机加|车床|铣|钻|热处理|下料|精加工|粗加工|cnc|machin/.test(text)) return 'machining';
  if (/服装|裁剪|缝制|整烫|面料|成衣|garment|sewing/.test(text)) return 'garment';
  // 默认服装常见工序模板（可编辑）
  return 'garment';
}

function draftStepsFromNames(names: string[]): DrawingStep[] {
  return names.map((name, i) => ({
    index: i + 1,
    name,
    note: '',
    standard_minutes: '1',
    auto_inbound: i === names.length - 1,
    process_id: null,
    match: 'new' as const,
  }));
}

async function matchStepsToProcesses(sql: Sql, steps: DrawingStep[]): Promise<DrawingStep[]> {
  const names = [...new Set(steps.map((s) => s.name.trim()).filter(Boolean))];
  const byName = new Map<string, { id: string; count: number }>();
  if (names.length) {
    const found = (
      await sql.query<{ id: string; name: string; n: string }>(
        `SELECT id, name, count(*) OVER (PARTITION BY name)::text AS n
         FROM processes
         WHERE active AND name = ANY($1::text[])`,
        [names],
      )
    ).rows;
    for (const row of found) {
      if (!byName.has(row.name)) byName.set(row.name, { id: row.id, count: Number(row.n) });
    }
  }
  return steps.map((step) => {
    const name = step.name.trim();
    if (!name) return { ...step, process_id: null, match: 'unmatched' as const };
    const hit = byName.get(name);
    if (!hit) return { ...step, name, process_id: null, match: 'new' as const };
    if (hit.count > 1) return { ...step, name, process_id: null, match: 'unmatched' as const };
    return { ...step, name, process_id: hit.id, match: 'matched' as const };
  });
}

function assertSupportedFile(filename: string) {
  const lower = filename.toLowerCase();
  if (!/\.(pdf|png|jpe?g|webp|gif)$/.test(lower)) {
    throw new Problem(422, 'UNSUPPORTED_FILE', '仅支持 PDF / PNG / JPG / WEBP / GIF');
  }
}

async function maybeAssistStepsWithAi(
  note: string,
  filename: string,
  config: AiConfig,
): Promise<string[] | null> {
  if (config.provider !== 'openai' || !config.apiKey) return null;
  try {
    const response = await fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              '你是工艺路线助手。根据文件名与说明，返回 JSON：{"steps":["工序名",...]}。工序名用简体中文，3～12 道。无法判断则返回空数组。',
          },
          {
            role: 'user',
            content: `文件名：${filename}\n说明：${note || '（无）'}`,
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim() ?? '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { steps?: unknown };
    if (!Array.isArray(parsed.steps)) return null;
    const names = parsed.steps
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);
    return names.length ? names : null;
  } catch {
    return null;
  }
}

function normalizeStepInput(raw: unknown, index: number): DrawingStep {
  if (!raw || typeof raw !== 'object') {
    throw new Problem(422, 'INVALID_STEP', `第 ${index} 道工序格式不正确`);
  }
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!name) throw new Problem(422, 'STEP_NAME_REQUIRED', `第 ${index} 道工序名称不能为空`);
  if (name.length > 200) throw new Problem(422, 'TOO_LONG', `第 ${index} 道工序名称过长`);
  const note = typeof row.note === 'string' ? row.note.trim().slice(0, 500) : '';
  const minutesRaw = typeof row.standard_minutes === 'string' ? row.standard_minutes.trim() : '1';
  const standard_minutes = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(minutesRaw) ? minutesRaw : '1';
  const auto_inbound = row.auto_inbound === true;
  return {
    index,
    name,
    note,
    standard_minutes,
    auto_inbound,
    process_id: typeof row.process_id === 'string' ? row.process_id : null,
    match: 'new',
  };
}

export function applyStepOverrides(preview: DrawingPreview, stepsRaw: unknown) {
  if (!Array.isArray(stepsRaw)) throw new Problem(422, 'INVALID_STEPS', 'steps 必须是数组');
  if (!stepsRaw.length) throw new Problem(422, 'EMPTY_STEPS', '至少保留一道工序');
  if (stepsRaw.length > 100) throw new Problem(422, 'TOO_MANY', '工序不能超过 100 道');
  preview.steps = stepsRaw.map((item, i) => normalizeStepInput(item, i + 1));
  preview.template = 'custom';
}

export async function parseDrawingUpload(
  sql: Sql,
  actor: Actor,
  buffer: Buffer,
  filename: string,
  note = '',
  config: AiConfig = readAiConfig(),
) {
  assertSupportedFile(filename);
  if (!buffer.length) throw new Problem(422, 'EMPTY_FILE', '文件为空');
  if (buffer.length > 5 * 1024 * 1024) throw new Problem(422, 'FILE_TOO_LARGE', '文件不能超过 5MB');

  const warnings: string[] = [];
  warnings.push('请核对工序草案后再确认写入；解析阶段不写业务表');

  const template = detectTemplate(note, filename);
  let names = template === 'machining' ? [...MACHINING_STEPS] : [...GARMENT_STEPS];
  const assisted = await maybeAssistStepsWithAi(note, filename, config);
  if (assisted?.length) {
    names = assisted;
    warnings.push('已用 AI 辅助识别工序名，请人工核对');
  } else {
    warnings.push(
      template === 'machining'
        ? '无识别密钥或识别失败：已起稿机加常见工序模板'
        : '无识别密钥或识别失败：已起稿服装常见工序模板',
    );
  }

  const drafted = draftStepsFromNames(names);
  const steps = await matchStepsToProcesses(sql, drafted);
  const routeName =
    note.trim().slice(0, 80) ||
    filename.replace(/\.(pdf|png|jpe?g|webp|gif)$/i, '').slice(0, 80) ||
    'AI图纸拆单工艺路线';

  const preview: DrawingPreview = {
    id: randomUUID(),
    tenant_id: actor.tenant_id,
    actor_id: actor.user_id,
    created_at: Date.now(),
    filename,
    note: note.trim().slice(0, 2000),
    template: assisted?.length ? 'custom' : template,
    route_name: routeName,
    steps,
    warnings,
  };
  purgeExpired();
  previews.set(preview.id, preview);

  return {
    preview_id: preview.id,
    filename: preview.filename,
    note: preview.note,
    template: preview.template,
    route_name: preview.route_name,
    steps: preview.steps,
    warnings: preview.warnings,
  };
}

async function ensureProcessId(
  sql: Sql,
  actor: Actor,
  step: DrawingStep,
  createdCodes: Set<string>,
): Promise<string> {
  if (step.process_id) {
    const exists = (
      await sql.query<{ id: string }>('SELECT id FROM processes WHERE id=$1 AND active', [step.process_id])
    ).rows[0];
    if (exists) return exists.id;
  }
  const byName = (
    await sql.query<{ id: string }>(
      'SELECT id FROM processes WHERE active AND name=$1 ORDER BY created_at LIMIT 1',
      [step.name],
    )
  ).rows[0];
  if (byName) return byName.id;

  let code = `AI-GX-${Date.now().toString(36).slice(-6)}-${step.index}`.toUpperCase();
  let attempt = 0;
  while (createdCodes.has(code) || (await sql.query('SELECT id FROM processes WHERE code=$1', [code])).rows[0]) {
    attempt += 1;
    code = `AI-GX-${Date.now().toString(36).slice(-6)}${attempt}-${step.index}`.toUpperCase();
    if (attempt > 20) throw new Problem(409, 'DUPLICATE_CODE', '工序编码冲突，请重试');
  }
  createdCodes.add(code);
  const minutes = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(step.standard_minutes)
    ? step.standard_minutes
    : '1';
  const id = (
    await sql.query<{ id: string }>(
      `INSERT INTO processes(tenant_id,code,name,description,standard_minutes,pricing_mode,inspection_scheme)
       VALUES($1,$2,$3,$4,$5,'piece','none') RETURNING id`,
      [actor.tenant_id, code, step.name, step.note || 'AI图纸拆单自动建档', minutes],
    )
  ).rows[0]!.id;
  return id;
}

function shanghaiStamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const v = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${v('year').slice(2)}${v('month')}${v('day')}`;
}

export async function confirmDrawingSplit(
  sql: Sql,
  actor: Actor,
  body: {
    preview_id?: unknown;
    mode?: unknown;
    work_order_id?: unknown;
    sync_work_order?: unknown;
    steps?: unknown;
    route_name?: unknown;
  },
) {
  if (actor.role !== 'admin' && actor.role !== 'planner') {
    throw new Problem(403, 'FORBIDDEN', '当前角色不能写入工艺路线');
  }
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const preview = getDrawingPreview(previewId, actor.tenant_id);

  if (body.steps !== undefined) applyStepOverrides(preview, body.steps);
  if (typeof body.route_name === 'string' && body.route_name.trim()) {
    preview.route_name = body.route_name.trim().slice(0, 200);
  }

  const modeRaw = body.mode === 'link_work_order' ? 'link_work_order' : 'process_route_draft';
  const mode: ConfirmMode = modeRaw;
  const workOrderId =
    typeof body.work_order_id === 'string' && body.work_order_id.trim() ? body.work_order_id.trim() : null;
  const syncWorkOrder = body.sync_work_order === true;

  if (mode === 'link_work_order' && !workOrderId) {
    throw new Problem(422, 'WORK_ORDER_REQUIRED', '关联工单模式请提供 work_order_id');
  }
  if (syncWorkOrder && mode !== 'link_work_order') {
    throw new Problem(422, 'SYNC_REQUIRES_LINK', '同步写工单仅在关联工单模式下可用');
  }
  if (syncWorkOrder && !workOrderId) {
    throw new Problem(422, 'WORK_ORDER_REQUIRED', '同步写工单须提供 work_order_id');
  }

  let workOrder: { id: string; code: string; execution: string; route_version_id: string | null } | null = null;
  if (workOrderId) {
    workOrder = (
      await sql.query<{ id: string; code: string; execution: string; route_version_id: string | null }>(
        'SELECT id, code, execution, route_version_id FROM work_orders WHERE id=$1',
        [workOrderId],
      )
    ).rows[0] ?? null;
    if (!workOrder) throw new Problem(404, 'WORK_ORDER_NOT_FOUND', '加工单不存在或不属于本企业');
  }

  const validSteps = preview.steps.filter((s) => s.name.trim());
  if (!validSteps.length) throw new Problem(422, 'EMPTY_STEPS', '至少保留一道有效工序');

  // 重新匹配（覆盖编辑后的名称）
  const rematched = await matchStepsToProcesses(sql, validSteps.map((s, i) => ({ ...s, index: i + 1 })));
  const createdCodes = new Set<string>();
  const resolved: { process_id: string; auto_inbound: boolean }[] = [];
  for (const step of rematched) {
    const processId = await ensureProcessId(sql, actor, step, createdCodes);
    resolved.push({ process_id: processId, auto_inbound: step.auto_inbound });
  }

  const routeCode = `AI-RT-${shanghaiStamp()}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const created = await createRouteFromImport(sql, actor, {
    code: routeCode,
    name: preview.route_name || 'AI图纸拆单工艺路线',
    description: `AI图纸拆单自 ${preview.filename}${preview.note ? `；说明：${preview.note.slice(0, 200)}` : ''}`,
    steps: resolved,
  });

  const syncWarnings: string[] = [];
  let synced = false;
  if (syncWorkOrder && workOrder) {
    if (workOrder.execution !== 'not_started') {
      throw new Problem(
        422,
        'WORK_ORDER_STARTED',
        `加工单 ${workOrder.code} 已开始执行（${workOrder.execution}），不能同步改绑工艺路线`,
      );
    }
    await sql.query(
      `UPDATE work_orders
       SET route_version_id=$1, route_name_snapshot=$2, version=version+1, updated_at=now()
       WHERE id=$3`,
      [created.version_id, created.route.name, workOrder.id],
    );
    synced = true;
    syncWarnings.push(
      '已更新加工单路线版本指针；未重建任务明细（v0）。若需按新路线重下任务，请在加工单侧另行处理。',
    );
  } else if (mode === 'link_work_order' && workOrder && !syncWorkOrder) {
    syncWarnings.push(`已关联加工单 ${workOrder.code}（仅记录关联，未改写工单路线；勾选同步写工单并二次确认后才会改绑）`);
  }

  await sql.query(
    `INSERT INTO ai_action_log(tenant_id, actor_id, actor_name, action, question_summary, intent, meta)
     VALUES ($1,$2,$3,'drawing_split_confirm',$4,$5,$6::jsonb)`,
    [
      actor.tenant_id,
      actor.user_id,
      actor.display_name,
      `图纸拆单 ${preview.filename} → 路线 ${created.route.id}`.slice(0, 200),
      'drawing_split',
      JSON.stringify({
        preview_id: preview.id,
        mode,
        route_id: created.route.id,
        route_version_id: created.version_id,
        route_code: created.route.code,
        steps_count: resolved.length,
        filename: preview.filename,
        work_order_id: workOrder?.id ?? null,
        work_order_code: workOrder?.code ?? null,
        sync_work_order: synced,
      }),
    ],
  );

  previews.delete(preview.id);
  return {
    mode,
    route: created.route,
    route_version_id: created.version_id,
    steps_count: resolved.length,
    work_order_id: workOrder?.id ?? null,
    work_order_code: workOrder?.code ?? null,
    sync_work_order: synced,
    warnings: [...syncWarnings],
  };
}
