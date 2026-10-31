/**
 * 商品一句话加字段：接到 configuration 扩展方案（发布新版本）。
 * 与单据 entity_ext_fields 不同链路，但确认卡/审计仍走 ai_ext_apps。
 */
import type { Sql } from '../database.js';
import { Problem, type Actor, writeAudit } from '../services.js';
import { mapProductFieldType, productFieldKey } from './ext-nlu.js';

type FieldSchema = {
  id: string;
  entity: 'product';
  active: boolean;
  version: number;
  latest_revision: number;
  current_version_id: string | null;
  current_revision: number;
};

type ExtField = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'date' | 'boolean' | 'formula';
  required: boolean;
  options?: string[];
  /** 单行文本输入方式：手动输入 / 扫码输入（对齐 ExtensionAddDialog） */
  input_modes?: string[];
  read_roles: string[];
  write_roles: string[];
};

const schemaSelect =
  'SELECT id,entity,active,version,latest_revision,current_version_id,current_revision,created_at,updated_at FROM extension_schemas';
const fieldVersionSelect =
  "SELECT v.id,v.schema_id,v.revision,v.fields,v.created_at,p.published_at,CASE WHEN p.version_id IS NULL THEN 'draft' ELSE 'published' END AS state FROM extension_schema_versions v LEFT JOIN extension_schema_publications p ON p.tenant_id=v.tenant_id AND p.version_id=v.id";

const ROLES = ['admin', 'planner', 'worker'];

export async function appendAndPublishProductField(
  sql: Sql,
  actor: Actor,
  input: {
    label: string;
    fieldType: string;
    choices?: string[];
    required?: boolean;
    input_modes?: string[];
  },
): Promise<{ schema_id: string; version_id: string; field_key: string; previous_version_id: string | null }> {
  const label = input.label.trim().slice(0, 120);
  if (!label) throw new Problem(422, 'FIELD_NAME', '字段名不能为空');

  let schema = (
    await sql.query<FieldSchema>(`${schemaSelect} WHERE entity='product' FOR UPDATE`)
  ).rows[0];

  const key = productFieldKey(label);
  const type = mapProductFieldType(input.fieldType);
  const newField: ExtField = {
    key,
    label,
    type,
    required: Boolean(input.required),
    ...(type === 'select'
      ? { options: (input.choices && input.choices.length >= 2 ? input.choices : ['是', '否']).slice(0, 50) }
      : {}),
    ...(input.fieldType === '单行文本' && input.input_modes?.length
      ? { input_modes: input.input_modes.slice(0, 4) }
      : {}),
    read_roles: ROLES,
    write_roles: ['admin', 'planner'],
  };

  if (!schema) {
    schema = (
      await sql.query<FieldSchema>(
        `INSERT INTO extension_schemas(tenant_id, entity)
         VALUES ($1, 'product')
         RETURNING id,entity,active,version,latest_revision,current_version_id,current_revision`,
        [actor.tenant_id],
      )
    ).rows[0]!;
    const versionId = (
      await sql.query<{ id: string }>(
        `INSERT INTO extension_schema_versions(tenant_id, schema_id, revision, fields, created_by)
         VALUES ($1,$2,1,$3::jsonb,$4) RETURNING id`,
        [actor.tenant_id, schema.id, JSON.stringify([newField]), actor.user_id],
      )
    ).rows[0]!.id;
    await sql.query(
      `INSERT INTO extension_schema_publications(tenant_id, version_id, published_by) VALUES ($1,$2,$3)`,
      [actor.tenant_id, versionId, actor.user_id],
    );
    await sql.query(
      `UPDATE extension_schemas
       SET current_version_id=$1, current_revision=1, latest_revision=1, version=version+1, updated_at=now()
       WHERE id=$2`,
      [versionId, schema.id],
    );
    await writeAudit(sql, actor, 'field_schema.published', 'field_schema', schema.id, null, {
      via: 'ai_ext_app',
      field: newField,
    });
    return { schema_id: schema.id, version_id: versionId, field_key: key, previous_version_id: null };
  }

  const previousVersionId = schema.current_version_id;
  const currentFields: ExtField[] = previousVersionId
    ? ((
        await sql.query<{ fields: ExtField[] }>(`${fieldVersionSelect} WHERE v.id=$1`, [previousVersionId])
      ).rows[0]?.fields ?? [])
    : [];

  if (currentFields.some((f) => f.label === label || f.key === key)) {
    throw new Problem(409, 'FIELD_EXISTS', `商品扩展字段「${label}」已存在`);
  }

  const nextFields = [...currentFields, newField];
  const nextRevision = Number(schema.latest_revision || 0) + 1;
  const versionId = (
    await sql.query<{ id: string }>(
      `INSERT INTO extension_schema_versions(tenant_id, schema_id, revision, fields, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
      [actor.tenant_id, schema.id, nextRevision, JSON.stringify(nextFields), actor.user_id],
    )
  ).rows[0]!.id;
  await sql.query(
    `UPDATE extension_schemas
     SET version=version+1, latest_revision=$1, updated_at=now()
     WHERE id=$2`,
    [nextRevision, schema.id],
  );
  // 读取最新 version 号用于 publish 一致性：上面已 +1，再读
  const afterCreate = (await sql.query<FieldSchema>(`${schemaSelect} WHERE id=$1 FOR UPDATE`, [schema.id])).rows[0]!;
  await sql.query(
    `INSERT INTO extension_schema_publications(tenant_id, version_id, published_by) VALUES ($1,$2,$3)`,
    [actor.tenant_id, versionId, actor.user_id],
  );
  await sql.query(
    `UPDATE extension_schemas
     SET current_version_id=$1, current_revision=$2, version=version+1, updated_at=now()
     WHERE id=$3`,
    [versionId, nextRevision, schema.id],
  );
  await writeAudit(sql, actor, 'field_schema.published', 'field_schema', schema.id, afterCreate, {
    via: 'ai_ext_app',
    field: newField,
    previous_version_id: previousVersionId,
  });
  return {
    schema_id: schema.id,
    version_id: versionId,
    field_key: key,
    previous_version_id: previousVersionId,
  };
}

export async function rollbackProductFieldVersion(
  sql: Sql,
  actor: Actor,
  input: { schema_id: string; previous_version_id: string | null; field_key: string },
): Promise<void> {
  const schema = (
    await sql.query<FieldSchema>(`${schemaSelect} WHERE id=$1 FOR UPDATE`, [input.schema_id])
  ).rows[0];
  if (!schema) return;

  if (input.previous_version_id) {
    const prev = (
      await sql.query<{ id: string; revision: number; fields: ExtField[] }>(
        `${fieldVersionSelect} WHERE v.id=$1`,
        [input.previous_version_id],
      )
    ).rows[0];
    if (prev) {
      // 再发一版 = 去掉该字段的当前快照（避免直接改历史 published 行）
      const fields = (prev.fields || []).filter((f) => f.key !== input.field_key);
      const nextRevision = Number(schema.latest_revision || 0) + 1;
      const versionId = (
        await sql.query<{ id: string }>(
          `INSERT INTO extension_schema_versions(tenant_id, schema_id, revision, fields, created_by)
           VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
          [actor.tenant_id, schema.id, nextRevision, JSON.stringify(fields), actor.user_id],
        )
      ).rows[0]!.id;
      await sql.query(
        `UPDATE extension_schemas SET latest_revision=$1, version=version+1, updated_at=now() WHERE id=$2`,
        [nextRevision, schema.id],
      );
      await sql.query(
        `INSERT INTO extension_schema_publications(tenant_id, version_id, published_by) VALUES ($1,$2,$3)`,
        [actor.tenant_id, versionId, actor.user_id],
      );
      await sql.query(
        `UPDATE extension_schemas
         SET current_version_id=$1, current_revision=$2, version=version+1, updated_at=now()
         WHERE id=$3`,
        [versionId, nextRevision, schema.id],
      );
      await writeAudit(sql, actor, 'field_schema.published', 'field_schema', schema.id, schema, {
        via: 'ai_ext_app_rollback',
        restored_from: input.previous_version_id,
        removed_key: input.field_key,
      });
      return;
    }
  }

  // 无上一版：发布仅去掉该字段的当前版
  const current = schema.current_version_id
    ? (
        await sql.query<{ fields: ExtField[] }>(`${fieldVersionSelect} WHERE v.id=$1`, [schema.current_version_id])
      ).rows[0]
    : null;
  const fields = (current?.fields || []).filter((f) => f.key !== input.field_key);
  const nextRevision = Number(schema.latest_revision || 0) + 1;
  const versionId = (
    await sql.query<{ id: string }>(
      `INSERT INTO extension_schema_versions(tenant_id, schema_id, revision, fields, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
      [actor.tenant_id, schema.id, nextRevision, JSON.stringify(fields), actor.user_id],
    )
  ).rows[0]!.id;
  await sql.query(
    `UPDATE extension_schemas SET latest_revision=$1, version=version+1, updated_at=now() WHERE id=$2`,
    [nextRevision, schema.id],
  );
  await sql.query(
    `INSERT INTO extension_schema_publications(tenant_id, version_id, published_by) VALUES ($1,$2,$3)`,
    [actor.tenant_id, versionId, actor.user_id],
  );
  await sql.query(
    `UPDATE extension_schemas
     SET current_version_id=$1, current_revision=$2, version=version+1, updated_at=now()
     WHERE id=$3`,
    [versionId, nextRevision, schema.id],
  );
}
