import { createHash } from 'node:crypto';
import type { Sql } from '../database.js';
import type { Actor } from '../services.js';

export type AuditResult = 'ok' | 'cancelled' | 'failed' | 'preview';

export type AuditWriteInput = {
  action: string;
  preview_id?: string | null;
  payload?: unknown;
  payload_digest?: string;
  result: AuditResult;
  target_table?: string;
  document_code?: string;
  error_code?: string;
  error_message?: string;
  meta?: Record<string, unknown>;
};

/** 审计 meta 规范化：强制带上信任相关默认字段（可被调用方覆盖） */
export function normalizeAuditMeta(meta?: Record<string, unknown>) {
  return {
    network_default: false,
    arbitrary_code: false,
    preview_required: true,
    ...(meta ?? {}),
  };
}

export function digestPayload(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  return createHash('sha256').update(text).digest('hex').slice(0, 64);
}

export async function writeActionAudit(sql: Sql, actor: Actor, input: AuditWriteInput) {
  const digest = input.payload_digest || digestPayload(input.payload ?? input.meta ?? {});
  const row = (
    await sql.query<{ id: string; created_at: string }>(
      `INSERT INTO ai_action_audit(
         tenant_id, user_id, actor_name, action, preview_id, payload_digest,
         result, target_table, document_code, error_code, error_message, meta
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       RETURNING id, created_at`,
      [
        actor.tenant_id,
        actor.user_id,
        actor.display_name,
        input.action.slice(0, 80),
        input.preview_id ?? null,
        digest,
        input.result,
        (input.target_table ?? '').slice(0, 80),
        (input.document_code ?? '').slice(0, 80),
        (input.error_code ?? '').slice(0, 80),
        (input.error_message ?? '').slice(0, 500),
        JSON.stringify(normalizeAuditMeta(input.meta)),
      ],
    )
  ).rows[0]!;
  return row;
}

export async function listActionAudit(
  sql: Sql,
  opts: { preview_id?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.preview_id) {
    return (
      await sql.query(
        `SELECT id, user_id, actor_name, action, preview_id, payload_digest, result,
                target_table, document_code, error_code, error_message, meta, created_at
         FROM ai_action_audit
         WHERE preview_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [opts.preview_id, limit],
      )
    ).rows;
  }
  return (
    await sql.query(
      `SELECT id, user_id, actor_name, action, preview_id, payload_digest, result,
              target_table, document_code, error_code, error_message, meta, created_at
       FROM ai_action_audit
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    )
  ).rows;
}
