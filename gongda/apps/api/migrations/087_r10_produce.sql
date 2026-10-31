-- Round 10: 项目管理、父子加工单、成本分摊、岗位安排、工序附加组件、溯源码、进度分享、物料分析回写

CREATE TABLE production_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  customer_id uuid,
  owner_id uuid,
  plan_start date,
  plan_end date,
  status text NOT NULL DEFAULT '未开始' CHECK (status IN ('未开始','进行中','已完成','已取消')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (plan_start IS NULL OR plan_end IS NULL OR plan_start <= plan_end),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES memberships(tenant_id, user_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

ALTER TABLE work_orders
  ADD COLUMN project_id uuid,
  ADD COLUMN parent_id uuid;
ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES production_projects(tenant_id, id),
  ADD CONSTRAINT work_orders_parent_fk FOREIGN KEY (tenant_id, parent_id) REFERENCES work_orders(tenant_id, id),
  ADD CONSTRAINT work_orders_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id);
CREATE INDEX work_orders_project_idx ON work_orders(tenant_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX work_orders_parent_idx ON work_orders(tenant_id, parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE cost_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  expense_type text NOT NULL CHECK (expense_type IN ('水电费','房租','折旧','管理费用','其他')),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  period_start date NOT NULL,
  period_end date NOT NULL,
  method text NOT NULL CHECK (method IN ('按计划数','按实际生产数','按报工工时','手工')),
  status text NOT NULL DEFAULT '草稿' CHECK (status IN ('草稿','已分摊')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  created_by uuid NOT NULL,
  shared_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (period_start <= period_end),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE cost_share_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  share_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  work_order_id uuid NOT NULL,
  basis numeric(20,6) NOT NULL DEFAULT 0 CHECK (basis >= 0),
  ratio numeric(12,8) NOT NULL DEFAULT 0 CHECK (ratio >= 0),
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, share_id, work_order_id),
  FOREIGN KEY (tenant_id, share_id) REFERENCES cost_shares(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id)
);

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  shop_id uuid,
  line_id uuid,
  process_ids uuid[] NOT NULL DEFAULT '{}',
  member_ids uuid[] NOT NULL DEFAULT '{}',
  duty text NOT NULL DEFAULT '' CHECK (length(duty) <= 500),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, shop_id) REFERENCES r8_shops(tenant_id, id),
  FOREIGN KEY (tenant_id, line_id) REFERENCES r8_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE process_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, title),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE process_component_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  component_id uuid NOT NULL,
  sort_no integer NOT NULL DEFAULT 1,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 255),
  field_type text NOT NULL CHECK (field_type IN ('单行文本','多行文本','数字输入框','单选下拉框','多选下拉框','日期','时间','附件','拍照/摄像','电话','邮箱','快递单号','定位','签名','公式')),
  required boolean NOT NULL DEFAULT false,
  options text NOT NULL DEFAULT '' CHECK (length(options) <= 1000),
  formula text NOT NULL DEFAULT '' CHECK (length(formula) <= 500),
  decimals integer CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 8),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, component_id, name),
  CHECK (field_type <> '公式' OR NOT required),
  FOREIGN KEY (tenant_id, component_id) REFERENCES process_components(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE processes
  ADD COLUMN report_component_id uuid,
  ADD COLUMN qc_component_id uuid;
ALTER TABLE processes
  ADD CONSTRAINT processes_report_component_fk FOREIGN KEY (tenant_id, report_component_id) REFERENCES process_components(tenant_id, id),
  ADD CONSTRAINT processes_qc_component_fk FOREIGN KEY (tenant_id, qc_component_id) REFERENCES process_components(tenant_id, id);
ALTER TABLE work_order_tasks
  ADD COLUMN report_component_id uuid,
  ADD COLUMN qc_component_id uuid;
ALTER TABLE work_order_tasks
  ADD CONSTRAINT work_order_tasks_report_component_fk FOREIGN KEY (tenant_id, report_component_id) REFERENCES process_components(tenant_id, id),
  ADD CONSTRAINT work_order_tasks_qc_component_fk FOREIGN KEY (tenant_id, qc_component_id) REFERENCES process_components(tenant_id, id);

CREATE TABLE trace_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code bigint NOT NULL CHECK (code >= 1000000),
  product_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  qty numeric(20,6) NOT NULL CHECK (qty > 0),
  status text NOT NULL DEFAULT '未使用' CHECK (status IN ('未使用','已使用','作废')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE INDEX trace_codes_work_order_idx ON trace_codes(tenant_id, work_order_id);

CREATE TABLE work_order_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  token text NOT NULL CHECK (token ~ '^[A-Za-z0-9]{32}$'),
  work_order_id uuid NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (token),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

-- 免登录分享页只能凭 token 找到企业：gd_auth 只读这张索引表，再以企业身份读取 work_order_shares
CREATE TABLE work_order_share_tokens (
  token text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9]{32}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_share_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_share_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY work_order_share_tokens_tenant_write ON work_order_share_tokens TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY work_order_share_tokens_auth_read ON work_order_share_tokens FOR SELECT TO gd_auth USING (true);
GRANT SELECT, INSERT, DELETE ON work_order_share_tokens TO gd_tenant;
GRANT SELECT ON work_order_share_tokens TO gd_auth;

ALTER TABLE r8_out_orders ADD COLUMN plan_analysis_id uuid;
ALTER TABLE r8_out_orders ADD CONSTRAINT r8_out_orders_plan_analysis_fk FOREIGN KEY (tenant_id, plan_analysis_id) REFERENCES production_plan_analyses(tenant_id, id);
-- 成本报表「外协费用」按加工单归集；未关联加工单的外协工单仍单独成行。
ALTER TABLE r8_out_orders ADD COLUMN work_order_id uuid;
ALTER TABLE r8_out_orders ADD CONSTRAINT r8_out_orders_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id);
CREATE INDEX r8_out_orders_work_order_idx ON r8_out_orders(tenant_id, work_order_id) WHERE work_order_id IS NOT NULL;
ALTER TABLE money_purchase_line_meta ADD COLUMN plan_analysis_id uuid;
ALTER TABLE money_purchase_line_meta ADD CONSTRAINT money_purchase_line_meta_plan_analysis_fk FOREIGN KEY (tenant_id, plan_analysis_id) REFERENCES production_plan_analyses(tenant_id, id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['production_projects','cost_shares','cost_share_lines','posts','process_components','process_component_fields','trace_codes','work_order_shares'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
