CREATE TABLE performance_pay_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  process_name text NOT NULL DEFAULT '',
  pricing_mode text NOT NULL DEFAULT '',
  product_id uuid,
  product_name text NOT NULL DEFAULT '',
  product_code text NOT NULL DEFAULT '',
  product_spec text NOT NULL DEFAULT '',
  user_name text NOT NULL DEFAULT '',
  wage_rate numeric(20,8) NOT NULL,
  std_output numeric(20,8),
  std_output_unit text NOT NULL DEFAULT '小时',
  std_hours numeric(20,8),
  param1 text NOT NULL DEFAULT '',
  param2 text NOT NULL DEFAULT '',
  param3 text NOT NULL DEFAULT '',
  param4 text NOT NULL DEFAULT '',
  param5 text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE performance_match_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL CHECK (status IN ('active','draft')),
  priority integer NOT NULL,
  fields text[] NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id)
);

CREATE TABLE performance_formulas (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  expression text NOT NULL,
  scale integer NOT NULL DEFAULT 2,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO custom_code_rules(tenant_id, name, config, sort)
SELECT t.id, '绩效工资设置编号', '{"elements":[{"type":"fixed","text":"JX","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}'::jsonb, 80
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM custom_code_rules r WHERE r.tenant_id=t.id AND r.name='绩效工资设置编号');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['performance_pay_rows','performance_match_rules','performance_formulas'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
