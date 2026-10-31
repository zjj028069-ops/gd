-- Round 10: 智能报表、报表配置、列表视图、AI库存监控采购单回写

CREATE TABLE smart_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  source text NOT NULL CHECK (source IN ('work_orders','production_reports','contracts','stock_ledger')),
  dimension text NOT NULL CHECK (length(dimension) BETWEEN 1 AND 40),
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 40),
  period text NOT NULL DEFAULT '本月' CHECK (length(period) BETWEEN 1 AND 20),
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE tenant_report_prefs (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  output_metrics jsonb NOT NULL DEFAULT '["good_qty","defect_qty","report_qty","good_rate"]'::jsonb,
  wip_metrics jsonb NOT NULL DEFAULT '["plan_qty","good_qty","defect_qty","pending_qty"]'::jsonb,
  wip_process_ids uuid[] NOT NULL DEFAULT '{}',
  sales_stat_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  push_settings jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE list_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  page_key text NOT NULL CHECK (length(page_key) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 20),
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_no integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, page_key, name),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE ai_inventory_orders (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  purchase_order_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id, period),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders(tenant_id, id)
);

INSERT INTO tenant_report_prefs(tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['smart_reports','tenant_report_prefs','list_views','ai_inventory_orders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
