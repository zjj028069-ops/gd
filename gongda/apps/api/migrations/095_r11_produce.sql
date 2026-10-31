ALTER TABLE production_projects ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '普通项目';
ALTER TABLE production_projects ADD COLUMN IF NOT EXISTS contract_id uuid;
ALTER TABLE production_projects ADD COLUMN IF NOT EXISTS contract_code text NOT NULL DEFAULT '';

CREATE TABLE produce_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE material_analysis_occupancy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  analysis_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  product_id uuid NOT NULL,
  qty numeric(20,6) NOT NULL,
  locked boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id)
);

CREATE TABLE process_inspectors (
  tenant_id uuid NOT NULL,
  process_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, process_id, user_id),
  FOREIGN KEY (tenant_id, process_id) REFERENCES processes(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE work_order_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_id uuid NOT NULL,
  quantities numeric(20,6)[] NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

INSERT INTO custom_code_rules(tenant_id, name, config, sort)
SELECT t.id, '溯源码编号', '{"elements":[{"type":"fixed","text":"","separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":7,"seq_start":1000000,"show_abbrev":false}'::jsonb, 81
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM custom_code_rules r WHERE r.tenant_id=t.id AND r.name='溯源码编号');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['produce_settings','material_analysis_occupancy','process_inspectors','work_order_splits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
