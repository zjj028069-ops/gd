-- S3 本厂词典 + 一句话扩展应用（增量；不删业务数据、不清库）
-- 回滚见 migrations/down/119_ai_s3_glossary_extapp.down.sql

CREATE TABLE IF NOT EXISTS ai_factory_glossary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('alias', 'default_rule', 'correction')),
  phrase text NOT NULL,
  target_kind text NOT NULL DEFAULT '',
  target_id uuid,
  target_code text NOT NULL DEFAULT '',
  target_label text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, phrase)
);

CREATE INDEX IF NOT EXISTS ai_factory_glossary_phrase_idx
  ON ai_factory_glossary (tenant_id, kind, phrase);

CREATE TABLE IF NOT EXISTS ai_ext_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  title text NOT NULL,
  utterance text NOT NULL DEFAULT '',
  entity text NOT NULL DEFAULT 'work_order',
  status text NOT NULL CHECK (status IN ('enabled', 'disabled', 'rolled_back')),
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  menu_label text NOT NULL DEFAULT '',
  menu_path text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS ai_ext_apps_status_idx
  ON ai_ext_apps (tenant_id, status, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ai_factory_glossary', 'ai_ext_apps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))',
      t || '_tenant', t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
