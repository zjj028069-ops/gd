import type { Sql } from '../database.js';
import { Problem, type Actor } from '../services.js';
import { writeActionAudit, digestPayload } from './audit.js';
import { confirmBomImport, discardPreview, peekBomPreview } from './bom.js';
import { confirmDrawingSplit, discardDrawingPreview, peekDrawingPreview } from './drawing.js';
import {
  confirmAttachmentWrite,
  confirmContactWrite,
  discardAttachmentPreview,
  discardContactPreview,
  peekAttachmentPreview,
  peekContactPreview,
} from './intake.js';
import {
  confirmChainWorkOrderWrite,
  confirmContractWrite,
  discardChainWoPreview,
  discardContractPreview,
  peekChainWoPreview,
  peekContractPreview,
} from './intake-contract.js';
import { confirmQuickOrder, discardQuickPreview, peekQuickPreview } from './quick-order.js';
import { confirmGlossaryWrite, discardGlossaryPreview, peekGlossaryPreview } from './glossary.js';
import { confirmExtAppWrite, discardExtAppPreview, peekExtAppPreview } from './ext-app.js';

export type WriteKind =
  | 'bom'
  | 'quick_order'
  | 'drawing'
  | 'contact'
  | 'contract'
  | 'work_order_from_contract'
  | 'attachment'
  | 'glossary'
  | 'ext_app';

export type WriteConfirmBody = {
  preview_id?: unknown;
  kind?: unknown;
  // bom
  mapping?: unknown;
  product_id?: unknown;
  name?: unknown;
  // quick-order
  target?: unknown;
  overrides?: unknown;
  // drawing
  mode?: unknown;
  work_order_id?: unknown;
  sync_work_order?: unknown;
  steps?: unknown;
  route_name?: unknown;
  // contact
  customer_id?: unknown;
  supplier_id?: unknown;
  party_kind?: unknown;
  fields?: unknown;
  // contract
  chain_work_order?: unknown;
};

function asKind(value: unknown): WriteKind | undefined {
  if (
    value === 'bom' ||
    value === 'quick_order' ||
    value === 'drawing' ||
    value === 'contact' ||
    value === 'contract' ||
    value === 'work_order_from_contract' ||
    value === 'attachment' ||
    value === 'glossary' ||
    value === 'ext_app'
  ) {
    return value;
  }
  return undefined;
}

export const WRITE_KIND_LABELS: Record<WriteKind, string> = {
  bom: '物料清单导入',
  quick_order: '快捷开单',
  drawing: '图纸拆工艺',
  contact: '联系人/名片落库',
  contract: '合同落库',
  work_order_from_contract: '合同串加工单',
  attachment: '附件归档',
  glossary: '本厂词典',
  ext_app: '扩展/壳内工具启用',
};

/** 统一写确认的信任摘要（给审计 meta + API 回传） */
export function writeTrustMeta(kind: WriteKind, extra: Record<string, unknown> = {}) {
  return {
    kind,
    kind_label: WRITE_KIND_LABELS[kind],
    confirm_gate: true,
    preview_required: true,
    silent_write: false,
    network_default: false,
    arbitrary_code: false,
    trust_note: '须预览卡确认后才写库；默认禁止外网与任意代码执行',
    ...extra,
  };
}

export function resolveWriteKind(previewId: string, tenantId: string, hint?: WriteKind): WriteKind {
  if (hint) {
    const ok =
      (hint === 'bom' && peekBomPreview(previewId, tenantId)) ||
      (hint === 'quick_order' && peekQuickPreview(previewId, tenantId)) ||
      (hint === 'drawing' && peekDrawingPreview(previewId, tenantId)) ||
      (hint === 'contact' && peekContactPreview(previewId, tenantId)) ||
      (hint === 'contract' && peekContractPreview(previewId, tenantId)) ||
      (hint === 'work_order_from_contract' && peekChainWoPreview(previewId, tenantId)) ||
      (hint === 'attachment' && peekAttachmentPreview(previewId, tenantId)) ||
      (hint === 'glossary' && peekGlossaryPreview(previewId, tenantId)) ||
      (hint === 'ext_app' && peekExtAppPreview(previewId, tenantId));
    if (!ok) throw new Problem(404, 'PREVIEW_NOT_FOUND', '预览已失效或不存在，请重新上传');
    return hint;
  }
  if (peekBomPreview(previewId, tenantId)) return 'bom';
  if (peekQuickPreview(previewId, tenantId)) return 'quick_order';
  if (peekDrawingPreview(previewId, tenantId)) return 'drawing';
  if (peekContactPreview(previewId, tenantId)) return 'contact';
  if (peekContractPreview(previewId, tenantId)) return 'contract';
  if (peekChainWoPreview(previewId, tenantId)) return 'work_order_from_contract';
  if (peekAttachmentPreview(previewId, tenantId)) return 'attachment';
  if (peekGlossaryPreview(previewId, tenantId)) return 'glossary';
  if (peekExtAppPreview(previewId, tenantId)) return 'ext_app';
  throw new Problem(404, 'PREVIEW_NOT_FOUND', '预览已失效或不存在，请重新上传');
}

function targetTableOf(kind: WriteKind, data: Record<string, unknown> | null): string {
  if (!data) return '';
  if (kind === 'bom') return 'boms';
  if (kind === 'quick_order') {
    return data.target === 'sales_order' ? 'sales_orders' : 'work_orders';
  }
  if (kind === 'drawing') return 'process_routes';
  if (kind === 'contact') {
    return data.party_kind === 'supplier' ? 'suppliers' : 'money_contacts';
  }
  if (kind === 'contract') return 'money_contracts';
  if (kind === 'work_order_from_contract') return 'work_orders';
  if (kind === 'attachment') return 'attachments';
  if (kind === 'glossary') return 'ai_factory_glossary';
  if (kind === 'ext_app') return 'ai_ext_apps';
  return '';
}

function documentCodeOf(kind: WriteKind, data: Record<string, unknown> | null): string {
  if (!data) return '';
  if (kind === 'bom') return String((data.bom as { id?: string } | undefined)?.id ?? data.bom_version_id ?? '');
  if (kind === 'quick_order') return String(data.document_code ?? data.code ?? '');
  if (kind === 'drawing') {
    const route = data.route as { code?: string } | undefined;
    return String(route?.code ?? data.route_code ?? '');
  }
  if (kind === 'contact') return String(data.contact_id ?? data.supplier_code ?? data.customer_id ?? '');
  if (kind === 'contract') return String(data.contract_code ?? data.contract_id ?? '');
  if (kind === 'work_order_from_contract') return String(data.work_order_code ?? data.work_order_id ?? '');
  if (kind === 'attachment') return String(data.attachment_id ?? '');
  if (kind === 'glossary') return String(data.phrase ?? data.glossary_id ?? '');
  if (kind === 'ext_app') return String(data.title ?? data.app_id ?? '');
  return '';
}

/** 失败审计须在独立事务中调用（同事务会随业务失败一起回滚） */
export async function recordWriteFailureAudit(
  sql: Sql,
  actor: Actor,
  action: 'write.confirm' | 'write.cancel',
  body: WriteConfirmBody | { preview_id?: unknown; kind?: unknown },
  error: unknown,
) {
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  const kind = asKind(body.kind);
  const problem = error instanceof Problem ? error : null;
  return writeActionAudit(sql, actor, {
    action,
    preview_id: previewId || null,
    payload: body,
    result: 'failed',
    target_table: kind ?? '',
    error_code: problem?.code ?? 'ERROR',
    error_message: problem?.message ?? (error instanceof Error ? error.message : String(error)),
    meta: {
      kind: kind ?? null,
      kind_label: kind ? WRITE_KIND_LABELS[kind] : null,
      confirm_gate: true,
      network_default: false,
      status: problem?.status ?? 500,
      phase: 'failed',
    },
  });
}

export async function confirmUnifiedWrite(sql: Sql, actor: Actor, body: WriteConfirmBody) {
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const hint = asKind(body.kind);
  const kind = resolveWriteKind(previewId, actor.tenant_id, hint);
  let data: Record<string, unknown>;
  if (kind === 'bom') {
    data = (await confirmBomImport(sql, actor, body)) as unknown as Record<string, unknown>;
  } else if (kind === 'quick_order') {
    data = (await confirmQuickOrder(sql, actor, body)) as unknown as Record<string, unknown>;
  } else if (kind === 'drawing') {
    data = (await confirmDrawingSplit(sql, actor, body)) as unknown as Record<string, unknown>;
  } else if (kind === 'contract') {
    data = (await confirmContractWrite(sql, actor, body)) as unknown as Record<string, unknown>;
  } else if (kind === 'work_order_from_contract') {
    data = (await confirmChainWorkOrderWrite(sql, actor, body)) as unknown as Record<string, unknown>;
  } else if (kind === 'attachment') {
    data = (await confirmAttachmentWrite(sql, actor, body)) as unknown as Record<string, unknown>;
  } else if (kind === 'glossary') {
    data = (await confirmGlossaryWrite(sql, actor, previewId)) as unknown as Record<string, unknown>;
  } else if (kind === 'ext_app') {
    data = (await confirmExtAppWrite(sql, actor, previewId)) as unknown as Record<string, unknown>;
  } else {
    data = (await confirmContactWrite(sql, actor, body)) as unknown as Record<string, unknown>;
  }
  const audit = await writeActionAudit(sql, actor, {
    action: 'write.confirm',
    preview_id: previewId,
    payload: { kind, preview_id: previewId, digest_of: digestPayload(body) },
    result: 'ok',
    target_table: targetTableOf(kind, data),
    document_code: documentCodeOf(kind, data),
    meta: writeTrustMeta(kind, {
      result_keys: Object.keys(data),
      phase: 'confirm',
    }),
  });
  return {
    kind,
    kind_label: WRITE_KIND_LABELS[kind],
    preview_id: previewId,
    audit_id: audit.id,
    confirm_notice: `已确认写入「${WRITE_KIND_LABELS[kind]}」（审计 ${audit.id}）。默认不联网、不执行任意代码。`,
    data,
  };
}

export async function cancelUnifiedWrite(
  sql: Sql,
  actor: Actor,
  body: { preview_id?: unknown; kind?: unknown },
) {
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const hint = asKind(body.kind);
  const kind = resolveWriteKind(previewId, actor.tenant_id, hint);
  if (kind === 'bom') discardPreview(previewId, actor.tenant_id);
  else if (kind === 'quick_order') discardQuickPreview(previewId, actor.tenant_id);
  else if (kind === 'drawing') discardDrawingPreview(previewId, actor.tenant_id);
  else if (kind === 'contract') discardContractPreview(previewId, actor.tenant_id);
  else if (kind === 'work_order_from_contract') discardChainWoPreview(previewId, actor.tenant_id);
  else if (kind === 'attachment') discardAttachmentPreview(previewId, actor.tenant_id);
  else if (kind === 'glossary') discardGlossaryPreview(previewId, actor.tenant_id);
  else if (kind === 'ext_app') discardExtAppPreview(previewId, actor.tenant_id);
  else discardContactPreview(previewId, actor.tenant_id);

  const audit = await writeActionAudit(sql, actor, {
    action: 'write.cancel',
    preview_id: previewId,
    payload: { kind, preview_id: previewId },
    result: 'cancelled',
    target_table: kind,
    meta: writeTrustMeta(kind, { phase: 'cancel' }),
  });
  return {
    ok: true as const,
    kind,
    kind_label: WRITE_KIND_LABELS[kind],
    preview_id: previewId,
    audit_id: audit.id,
    confirm_notice: `已取消「${WRITE_KIND_LABELS[kind]}」，未写库。`,
  };
}
