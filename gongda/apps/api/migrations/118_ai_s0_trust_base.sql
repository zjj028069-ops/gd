-- S0 可信执行底座：统一写库审计（可回滚见 migrations/down/118_ai_s0_trust_base.down.sql）
-- 字段对齐规格：user_id、action、preview_id、payload_digest、result、created_at；失败也记一条。

CREATE TABLE IF NOT EXISTS ai_action_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  actor_name text NOT NULL DEFAULT '',
  action text NOT NULL,
  preview_id text,
  payload_digest text NOT NULL DEFAULT '',
  result text NOT NULL CHECK (result IN ('ok', 'cancelled', 'failed', 'preview')),
  target_table text NOT NULL DEFAULT '',
  document_code text NOT NULL DEFAULT '',
  error_code text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT '',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS ai_action_audit_tenant_created_idx
  ON ai_action_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_action_audit_tenant_preview_idx
  ON ai_action_audit (tenant_id, preview_id)
  WHERE preview_id IS NOT NULL;

ALTER TABLE ai_action_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_action_audit_tenant ON ai_action_audit;
CREATE POLICY ai_action_audit_tenant ON ai_action_audit TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));

GRANT SELECT, INSERT ON ai_action_audit TO gd_tenant;
