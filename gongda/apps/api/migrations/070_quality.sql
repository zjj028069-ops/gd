-- 第八轮质量管理：不良品项、全检回写、抽检、采购检验。不改报工过账函数。

ALTER TABLE production_reports
  ADD COLUMN quality_note text NOT NULL DEFAULT '' CHECK (length(quality_note) <= 1000),
  ADD COLUMN quality_by uuid,
  ADD COLUMN quality_at timestamptz,
  ADD COLUMN rework_task_code text NOT NULL DEFAULT '';
ALTER TABLE production_reports
  ADD CONSTRAINT report_quality_by_fk FOREIGN KEY (tenant_id, quality_by) REFERENCES memberships(tenant_id, user_id);

CREATE TABLE r8_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  series text NOT NULL,
  value integer NOT NULL CHECK (value > 0),
  PRIMARY KEY (tenant_id, series)
);

CREATE TABLE r8_defect_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, name)
);

CREATE TABLE r8_report_defects (
  tenant_id uuid NOT NULL,
  report_id uuid NOT NULL,
  defect_item_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, report_id, defect_item_id),
  FOREIGN KEY (tenant_id, report_id) REFERENCES production_reports(tenant_id, id),
  FOREIGN KEY (tenant_id, defect_item_id) REFERENCES r8_defect_items(tenant_id, id)
);

CREATE TABLE r8_rework_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  report_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  qty numeric(20,6) NOT NULL CHECK (qty > 0),
  status text NOT NULL DEFAULT '未开始' CHECK (status IN ('未开始','生产中','已完成')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, report_id) REFERENCES production_reports(tenant_id, id)
);

CREATE TABLE r8_qc_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE r8_spot_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  qty numeric(20,6) NOT NULL CHECK (qty > 0),
  process_id uuid NOT NULL,
  work_order_id uuid,
  product_id uuid,
  good_qty numeric(20,6) NOT NULL DEFAULT 0,
  defect_qty numeric(20,6) NOT NULL DEFAULT 0,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  scheme text NOT NULL DEFAULT '',
  component_id uuid,
  shop_name text NOT NULL DEFAULT '',
  line_name text NOT NULL DEFAULT '',
  operator_name text NOT NULL DEFAULT '',
  quality_status text NOT NULL DEFAULT '待质检' CHECK (quality_status IN ('待质检','已质检')),
  quality_by uuid,
  quality_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, process_id) REFERENCES processes(tenant_id, id),
  FOREIGN KEY (tenant_id, component_id) REFERENCES r8_qc_components(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_spot_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  spot_id uuid NOT NULL,
  component_id uuid NOT NULL,
  item_name text NOT NULL,
  result text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, spot_id) REFERENCES r8_spot_checks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, component_id) REFERENCES r8_qc_components(tenant_id, id)
);

CREATE TABLE r8_qc_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  product_ids uuid[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_qc_spec_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  spec_id uuid NOT NULL,
  sort_no integer NOT NULL DEFAULT 1,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 255),
  field_type text NOT NULL DEFAULT '文本' CHECK (field_type IN ('文本','数字','是否','单选')),
  required boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, spec_id) REFERENCES r8_qc_specs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE r8_purchase_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  purchase_order_id uuid NOT NULL,
  spec_id uuid,
  product_id uuid,
  send_qty numeric(20,6) NOT NULL DEFAULT 0,
  tested_qty numeric(20,6) NOT NULL DEFAULT 0,
  pass_qty numeric(20,6) NOT NULL DEFAULT 0,
  fail_qty numeric(20,6) NOT NULL DEFAULT 0,
  finish_date date,
  inspector_names text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, spec_id) REFERENCES r8_qc_specs(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_purchase_test_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  test_id uuid NOT NULL,
  spec_item_id uuid NOT NULL,
  value text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, test_id) REFERENCES r8_purchase_tests(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, spec_item_id) REFERENCES r8_qc_spec_items(tenant_id, id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['r8_counters','r8_defect_items','r8_report_defects','r8_rework_tasks','r8_qc_components','r8_spot_checks','r8_spot_lines','r8_qc_specs','r8_qc_spec_items','r8_purchase_tests','r8_purchase_test_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
