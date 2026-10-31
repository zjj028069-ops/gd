-- Round 6: production plans, material analysis records, data screens, work order plan line link.

CREATE TABLE production_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  analyzed boolean NOT NULL DEFAULT false,
  delivery_date date,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE production_plan_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  product_id uuid NOT NULL,
  product_snapshot jsonb NOT NULL,
  contract_id uuid,
  contract_code text NOT NULL DEFAULT '',
  customer_name text NOT NULL DEFAULT '',
  source_kind text NOT NULL DEFAULT '' CHECK (source_kind IN ('', 'self', 'outsource', 'purchase')),
  plan_qty numeric(20,6) NOT NULL CHECK (plan_qty > 0),
  released_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (released_qty >= 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, plan_id, line_no),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES production_plans(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE production_plan_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  line_no integer NOT NULL DEFAULT 1 CHECK (line_no > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  process_demand_qty numeric(20,6) NOT NULL DEFAULT 0,
  outsource_demand_qty numeric(20,6) NOT NULL DEFAULT 0,
  purchase_demand_qty numeric(20,6) NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES production_plans(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE production_plan_analysis_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  plan_line_id uuid NOT NULL,
  demand_kind text NOT NULL CHECK (demand_kind IN ('process', 'outsource', 'purchase')),
  demand_qty numeric(20,6) NOT NULL CHECK (demand_qty >= 0),
  released_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (released_qty >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, analysis_id, plan_line_id, demand_kind),
  FOREIGN KEY (tenant_id, analysis_id) REFERENCES production_plan_analyses(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plan_line_id) REFERENCES production_plan_lines(tenant_id, id)
);

ALTER TABLE work_orders
  ADD COLUMN production_plan_line_id uuid,
  ADD CONSTRAINT work_orders_plan_line_fk FOREIGN KEY (tenant_id, production_plan_line_id) REFERENCES production_plan_lines(tenant_id, id);

CREATE TABLE data_screens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  menu_name text NOT NULL CHECK (length(menu_name) BETWEEN 1 AND 80),
  layout text NOT NULL DEFAULT '默认',
  module_kind text NOT NULL DEFAULT '生产模块',
  description text NOT NULL DEFAULT '-',
  access_password text NOT NULL CHECK (length(access_password) BETWEEN 1 AND 16),
  sort_no integer NOT NULL DEFAULT 0,
  preset_key text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

INSERT INTO data_screens (tenant_id, menu_name, layout, module_kind, description, access_password, sort_no, preset_key)
SELECT t.id, v.menu_name, v.layout, '生产模块', '-', v.pwd, v.sort_no, v.preset_key
FROM tenants t
CROSS JOIN (VALUES
  ('生产中控大屏', '默认', '8642', 1, 'control'),
  ('车间大屏', '四模块', '6334', 2, 'workshop'),
  ('机台实时状态', '单模块', '4650', 3, 'machine'),
  ('不良品统计大屏', '左右双模块', '3496', 4, 'defect'),
  ('加工单生产进度', '单模块', '1318', 5, 'wo-progress')
) AS v(menu_name, layout, pwd, sort_no, preset_key)
WHERE NOT EXISTS (SELECT 1 FROM data_screens s WHERE s.tenant_id = t.id AND s.preset_key = v.preset_key);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['production_plans','production_plan_lines','production_plan_analyses','production_plan_analysis_lines','data_screens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),''''))', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON production_plans, production_plan_lines, production_plan_analyses, production_plan_analysis_lines, data_screens TO gd_tenant;
