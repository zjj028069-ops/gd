-- S3 样例3：快递约件轻量应用记录表（增量；不删业务数据、不清库）
-- 回滚见 migrations/down/120_ai_lite_express.down.sql

CREATE TABLE IF NOT EXISTS ai_lite_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  app_id uuid NOT NULL REFERENCES ai_ext_apps(id),
  status text NOT NULL DEFAULT '待约' CHECK (status IN ('待约', '已寄', '异常')),
  sender_name text NOT NULL DEFAULT '',
  sender_customer_id uuid,
  stock_out_id uuid,
  stock_out_code text NOT NULL DEFAULT '',
  goods_summary text NOT NULL DEFAULT '',
  tracking_no text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS ai_lite_records_app_idx
  ON ai_lite_records (tenant_id, app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_lite_records_status_idx
  ON ai_lite_records (tenant_id, app_id, status);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ai_lite_records'] LOOP
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
