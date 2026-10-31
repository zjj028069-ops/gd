-- 第八轮外协。发料/入库/退料不在此过账，只记工单并跳转第五轮单据。

CREATE TABLE r8_os_contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, title),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_os_content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  content_id uuid NOT NULL,
  sort_no integer NOT NULL DEFAULT 1,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  field_type text NOT NULL DEFAULT '文本' CHECK (field_type IN ('文本','数字','是否','单选')),
  required boolean NOT NULL DEFAULT false,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 255),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, content_id) REFERENCES r8_os_contents(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE r8_out_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  product_id uuid NOT NULL,
  plan_qty numeric(20,6) NOT NULL CHECK (plan_qty > 0),
  supplier_id uuid,
  contact_name text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  unit_price numeric(20,8) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  due_date date,
  priority text NOT NULL DEFAULT '正常' CHECK (priority IN ('加急','正常','延期')),
  plan_start date,
  plan_end date,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  status text NOT NULL DEFAULT '未开始' CHECK (status IN ('未开始','生产中','已完成','已取消')),
  cancel_reason text NOT NULL DEFAULT '',
  pause_reason text NOT NULL DEFAULT '',
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_out_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_qty numeric(20,6) NOT NULL DEFAULT 1,
  note text NOT NULL DEFAULT '',
  sort_no integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES r8_out_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE r8_os_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  pass_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (pass_qty >= 0),
  fail_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (fail_qty >= 0),
  content_id uuid,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  settle_status text NOT NULL DEFAULT '未结算' CHECK (settle_status IN ('未结算','已结算')),
  settle_amount numeric(20,8) NOT NULL DEFAULT 0,
  settled_by uuid,
  settled_at timestamptz,
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES r8_out_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, content_id) REFERENCES r8_os_contents(tenant_id, id),
  FOREIGN KEY (tenant_id, accepted_by) REFERENCES memberships(tenant_id, user_id),
  CHECK (pass_qty + fail_qty > 0)
);

CREATE TABLE r8_os_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  item_name text NOT NULL,
  value text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES r8_os_receipts(tenant_id, id) ON DELETE CASCADE
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['r8_os_contents','r8_os_content_items','r8_out_orders','r8_out_materials','r8_os_receipts','r8_os_checks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
