/**
 * 样例3：快递约件轻量应用 · 记录 CRUD + 运单号回写出库扩展值
 */
import type { Sql } from '../database.js';
import { Problem, type Actor } from '../services.js';
import { writeActionAudit } from './audit.js';

const STATUSES = new Set(['待约', '已寄', '异常']);

type LiteRecord = {
  id: string;
  app_id: string;
  status: string;
  sender_name: string;
  sender_customer_id: string | null;
  stock_out_id: string | null;
  stock_out_code: string;
  goods_summary: string;
  tracking_no: string;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function clip(value: unknown, max: number) {
  return String(value ?? '').trim().slice(0, max);
}

async function assertLiteApp(sql: Sql, appId: string) {
  const row = (
    await sql.query<{ id: string; status: string; entity: string; spec: { kind?: string } | null; field_ids: unknown }>(
      `SELECT id::text AS id, status, entity, spec, field_ids FROM ai_ext_apps WHERE id=$1`,
      [appId],
    )
  ).rows[0];
  if (!row) throw new Problem(404, 'EXT_APP_NOT_FOUND', '快递约件应用不存在');
  const kind = row.spec && typeof row.spec === 'object' ? row.spec.kind : '';
  if (kind !== 'lite_express') throw new Problem(422, 'NOT_LITE', '该扩展不是快递约件应用');
  if (row.status === 'rolled_back') throw new Problem(409, 'ROLLED_BACK', '该扩展已回退');
  return row;
}

function shape(row: {
  id: string;
  app_id: string;
  status: string;
  sender_name: string;
  sender_customer_id: string | null;
  stock_out_id: string | null;
  stock_out_code: string;
  goods_summary: string;
  tracking_no: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}): LiteRecord {
  return {
    ...row,
    payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
  };
}

export async function listLiteRecords(sql: Sql, appId: string, status?: string) {
  await assertLiteApp(sql, appId);
  const rows = status
    ? (
        await sql.query(
          `SELECT id::text AS id, app_id::text AS app_id, status, sender_name,
                  sender_customer_id::text AS sender_customer_id,
                  stock_out_id::text AS stock_out_id, stock_out_code, goods_summary, tracking_no,
                  payload, created_at::text AS created_at, updated_at::text AS updated_at
           FROM ai_lite_records WHERE app_id=$1 AND status=$2
           ORDER BY created_at DESC LIMIT 500`,
          [appId, status],
        )
      ).rows
    : (
        await sql.query(
          `SELECT id::text AS id, app_id::text AS app_id, status, sender_name,
                  sender_customer_id::text AS sender_customer_id,
                  stock_out_id::text AS stock_out_id, stock_out_code, goods_summary, tracking_no,
                  payload, created_at::text AS created_at, updated_at::text AS updated_at
           FROM ai_lite_records WHERE app_id=$1
           ORDER BY created_at DESC LIMIT 500`,
          [appId],
        )
      ).rows;
  return { items: rows.map((row) => shape(row as Parameters<typeof shape>[0])), total: rows.length };
}

export async function createLiteRecord(
  sql: Sql,
  actor: Actor,
  appId: string,
  body: Record<string, unknown>,
) {
  const app = await assertLiteApp(sql, appId);
  if (app.status !== 'enabled') throw new Problem(409, 'NOT_ENABLED', '扩展未启用，不能新建约件');
  const senderName = clip(body.sender_name, 120);
  const senderCustomerId = typeof body.sender_customer_id === 'string' && body.sender_customer_id.trim()
    ? body.sender_customer_id.trim()
    : null;
  const stockOutId = typeof body.stock_out_id === 'string' && body.stock_out_id.trim()
    ? body.stock_out_id.trim()
    : null;
  const stockOutCode = clip(body.stock_out_code, 80);
  const goodsSummary = clip(body.goods_summary, 500);
  let status = clip(body.status, 10) || '待约';
  if (!STATUSES.has(status)) status = '待约';
  if (!senderName && !senderCustomerId) {
    throw new Problem(422, 'SENDER_REQUIRED', '请选择寄件人或填写寄件人姓名');
  }
  const id = (
    await sql.query<{ id: string }>(
      `INSERT INTO ai_lite_records(
         tenant_id, app_id, status, sender_name, sender_customer_id,
         stock_out_id, stock_out_code, goods_summary, tracking_no, payload, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'','{}'::jsonb,$9)
       RETURNING id::text AS id`,
      [
        actor.tenant_id,
        appId,
        status,
        senderName,
        senderCustomerId,
        stockOutId,
        stockOutCode,
        goodsSummary,
        actor.user_id,
      ],
    )
  ).rows[0]!.id;
  await writeActionAudit(sql, actor, {
    action: 'lite_express.create',
    payload: { app_id: appId, record_id: id, stock_out_id: stockOutId },
    result: 'ok',
    target_table: 'ai_lite_records',
    document_code: stockOutCode || id.slice(0, 8),
  });
  const listed = await listLiteRecords(sql, appId);
  const item = listed.items.find((row) => row.id === id)!;
  return { item };
}

async function upsertTrackingToShipment(
  sql: Sql,
  actor: Actor,
  appId: string,
  stockOutId: string,
  trackingNo: string,
  fieldIds: unknown,
) {
  const ids = Array.isArray(fieldIds) ? fieldIds.map(String) : [];
  let fieldId = ids[0] ?? '';
  if (!fieldId) {
    const byOpt = (
      await sql.query<{ id: string }>(
        `SELECT id::text AS id FROM entity_ext_fields
         WHERE entity='sale_stock_out' AND name='运单号'
           AND coalesce(options->>'sedric_app_id','')=$1
         LIMIT 1`,
        [appId],
      )
    ).rows[0];
    fieldId = byOpt?.id ?? '';
  }
  if (!fieldId) {
    const byName = (
      await sql.query<{ id: string }>(
        `SELECT id::text AS id FROM entity_ext_fields
         WHERE entity='sale_stock_out' AND name='运单号' LIMIT 1`,
      )
    ).rows[0];
    fieldId = byName?.id ?? '';
  }
  if (!fieldId) return { written: false as const, reason: 'no_tracking_field' as const };

  const existing = (
    await sql.query<{ values: Record<string, unknown> }>(
      `SELECT values FROM entity_ext_values WHERE entity='sale_stock_out' AND record_id=$1`,
      [stockOutId],
    )
  ).rows[0];
  const values = { ...(existing?.values ?? {}), [fieldId]: trackingNo };
  await sql.query(
    `INSERT INTO entity_ext_values(tenant_id,entity,record_id,values,updated_at)
     VALUES ($1,'sale_stock_out',$2,$3::jsonb,now())
     ON CONFLICT (tenant_id,entity,record_id) DO UPDATE SET values=excluded.values, updated_at=now()`,
    [actor.tenant_id, stockOutId, JSON.stringify(values)],
  );
  return { written: true as const, field_id: fieldId };
}

export async function patchLiteRecord(
  sql: Sql,
  actor: Actor,
  appId: string,
  recordId: string,
  body: Record<string, unknown>,
) {
  const app = await assertLiteApp(sql, appId);
  if (app.status !== 'enabled') throw new Problem(409, 'NOT_ENABLED', '扩展未启用');
  const current = (
    await sql.query<{
      id: string;
      status: string;
      sender_name: string;
      sender_customer_id: string | null;
      stock_out_id: string | null;
      stock_out_code: string;
      goods_summary: string;
      tracking_no: string;
    }>(
      `SELECT id::text AS id, status, sender_name,
              sender_customer_id::text AS sender_customer_id,
              stock_out_id::text AS stock_out_id, stock_out_code, goods_summary, tracking_no
       FROM ai_lite_records WHERE id=$1 AND app_id=$2`,
      [recordId, appId],
    )
  ).rows[0];
  if (!current) throw new Problem(404, 'RECORD_NOT_FOUND', '约件记录不存在');

  let status = current.status;
  if (typeof body.status === 'string' && body.status.trim()) {
    status = body.status.trim();
    if (!STATUSES.has(status)) throw new Problem(422, 'STATUS', '状态只能是待约/已寄/异常');
  }
  const senderName =
    body.sender_name !== undefined ? clip(body.sender_name, 120) : current.sender_name;
  const goodsSummary =
    body.goods_summary !== undefined ? clip(body.goods_summary, 500) : current.goods_summary;
  const trackingNo =
    body.tracking_no !== undefined ? clip(body.tracking_no, 80) : current.tracking_no;

  await sql.query(
    `UPDATE ai_lite_records
     SET status=$3, sender_name=$4, goods_summary=$5, tracking_no=$6, updated_at=now()
     WHERE id=$1 AND app_id=$2`,
    [recordId, appId, status, senderName, goodsSummary, trackingNo],
  );

  let extWrite: { written: boolean; field_id?: string; reason?: string } = { written: false };
  if (
    body.tracking_no !== undefined &&
    trackingNo &&
    current.stock_out_id
  ) {
    extWrite = await upsertTrackingToShipment(
      sql,
      actor,
      appId,
      current.stock_out_id,
      trackingNo,
      app.field_ids,
    );
  }

  await writeActionAudit(sql, actor, {
    action: 'lite_express.patch',
    payload: {
      app_id: appId,
      record_id: recordId,
      status,
      tracking_no: trackingNo,
      ext_write: extWrite,
    },
    result: 'ok',
    target_table: 'ai_lite_records',
    document_code: current.stock_out_code || recordId.slice(0, 8),
  });

  const listed = await listLiteRecords(sql, appId);
  const item = listed.items.find((row) => row.id === recordId)!;
  return { item, ext_write: extWrite };
}
