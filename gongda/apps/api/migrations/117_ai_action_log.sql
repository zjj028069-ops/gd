-- AI 操作审计日志（仅日志，不碰业务数据）
CREATE TABLE IF NOT EXISTS ai_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL,
  actor_name text NOT NULL DEFAULT '',
  action text NOT NULL,
  question_summary text NOT NULL DEFAULT '',
  intent text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS ai_action_log_tenant_created_idx ON ai_action_log (tenant_id, created_at DESC);

ALTER TABLE ai_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_action_log_tenant ON ai_action_log;
CREATE POLICY ai_action_log_tenant ON ai_action_log TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));

GRANT SELECT, INSERT ON ai_action_log TO gd_tenant;
