-- Round 10: 采购设置、供应商设置、采购价格规则、通用设置、工作状态、短信

-- money_settings.duplicate_name/unique_phone 已用于客户设置，供应商开关单独存放在 purchase_settings
CREATE TABLE purchase_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  show_supplier_info boolean NOT NULL DEFAULT false,
  overdue_remind_days integer NOT NULL DEFAULT 0 CHECK (overdue_remind_days BETWEEN 0 AND 365),
  refill_basis text NOT NULL DEFAULT 'lower' CHECK (refill_basis IN ('lower','upper')),
  refill_percent numeric(7,2) NOT NULL DEFAULT 50 CHECK (refill_percent BETWEEN 0 AND 1000),
  hide_audit_status boolean NOT NULL DEFAULT false,
  auto_calc boolean NOT NULL DEFAULT true,
  amount_formula text NOT NULL DEFAULT '${明细.采购单价}*${明细.采购数量}' CHECK (length(amount_formula) BETWEEN 1 AND 500),
  amount_scale integer NOT NULL DEFAULT 8 CHECK (amount_scale BETWEEN 0 AND 8),
  inspect_overdue boolean NOT NULL DEFAULT false,
  supplier_duplicate_name boolean NOT NULL DEFAULT false,
  supplier_unique_phone boolean NOT NULL DEFAULT true,
  price_rule_mode text NOT NULL DEFAULT 'rule' CHECK (price_rule_mode IN ('rule','last','none')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  supplier_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_price numeric(21,7) NOT NULL CHECK (unit_price >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, supplier_id, product_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE basic_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  product_qr_repair boolean NOT NULL DEFAULT true,
  device_qr_repair boolean NOT NULL DEFAULT true,
  device_qr_patrol boolean NOT NULL DEFAULT true,
  map_hidden_user_ids uuid[] NOT NULL DEFAULT '{}',
  photo_watermark boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 20),
  color text NOT NULL DEFAULT '#1890ff' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_no integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE sms_accounts (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  remaining integer NOT NULL DEFAULT 100 CHECK (remaining >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sms_recharges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  package_name text NOT NULL CHECK (length(package_name) BETWEEN 1 AND 40),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  sms_count integer NOT NULL CHECK (sms_count > 0),
  purchased_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE sms_send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  phone text NOT NULL CHECK (length(phone) BETWEEN 1 AND 20),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

INSERT INTO purchase_settings(tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;
INSERT INTO basic_settings(tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;
INSERT INTO sms_accounts(tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;
INSERT INTO work_statuses(tenant_id, name, color, sort_no)
SELECT t.id, v.name, v.color, v.sort_no FROM tenants t
CROSS JOIN (VALUES ('忙碌', '#f5222d', 1), ('空闲', '#52c41a', 2)) AS v(name, color, sort_no)
ON CONFLICT DO NOTHING;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_settings','purchase_price_rules','basic_settings','work_statuses','sms_accounts','sms_recharges','sms_send_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
