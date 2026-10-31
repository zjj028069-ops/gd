CREATE TABLE auto_stock_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  trigger_mode text NOT NULL DEFAULT '报工后',
  action_kind text NOT NULL CHECK (action_kind IN ('issue_bom','receipt_fg')),
  content_text text NOT NULL DEFAULT '',
  warehouse_id uuid,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE auto_stock_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id uuid,
  event_name text NOT NULL,
  report_id uuid,
  report_code text NOT NULL DEFAULT '',
  work_order_code text NOT NULL DEFAULT '',
  bill_code text NOT NULL DEFAULT '',
  result text NOT NULL CHECK (result IN ('成功','失败','提示')),
  fail_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX auto_stock_logs_report_event ON auto_stock_logs(tenant_id, report_id, event_id) WHERE report_id IS NOT NULL AND event_id IS NOT NULL AND result='成功';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['auto_stock_events','auto_stock_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
