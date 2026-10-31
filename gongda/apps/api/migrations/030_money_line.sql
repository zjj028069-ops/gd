-- 第四轮钱线。不改 products、工序、加工单、报工、工资表。
ALTER TABLE customers
  ADD COLUMN contact_name text NOT NULL DEFAULT '',
  ADD COLUMN contact_phone text NOT NULL DEFAULT '',
  ADD COLUMN region text NOT NULL DEFAULT '',
  ADD COLUMN address text NOT NULL DEFAULT '',
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN followed boolean NOT NULL DEFAULT false,
  ADD COLUMN owner_id uuid,
  ADD COLUMN in_sea boolean NOT NULL DEFAULT false,
  ADD COLUMN remark text NOT NULL DEFAULT '';

ALTER TABLE suppliers
  ADD COLUMN company_name text NOT NULL DEFAULT '',
  ADD COLUMN credit_code text NOT NULL DEFAULT '',
  ADD COLUMN contact_name text NOT NULL DEFAULT '',
  ADD COLUMN contact_phone text NOT NULL DEFAULT '',
  ADD COLUMN region text NOT NULL DEFAULT '',
  ADD COLUMN address text NOT NULL DEFAULT '',
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN level text NOT NULL DEFAULT '',
  ADD COLUMN remark text NOT NULL DEFAULT '',
  ADD COLUMN owner_id uuid;

ALTER TABLE purchase_orders
  ADD COLUMN buyer_id uuid,
  ADD COLUMN money_audit text NOT NULL DEFAULT '',
  ADD COLUMN due_specified boolean NOT NULL DEFAULT true;

CREATE TABLE money_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  duplicate_name boolean NOT NULL DEFAULT false,
  unique_phone boolean NOT NULL DEFAULT true,
  auto_calc boolean NOT NULL DEFAULT true,
  contract_formula text NOT NULL DEFAULT '${合同明细.单价}*${合同明细.销售数量}',
  contract_scale integer NOT NULL DEFAULT 8 CHECK (contract_scale BETWEEN 0 AND 8),
  quote_formula text NOT NULL DEFAULT '${合同报价明细.单价}*${合同报价明细.销售数量}',
  quote_scale integer NOT NULL DEFAULT 8 CHECK (quote_scale BETWEEN 0 AND 8),
  phone_exact boolean NOT NULL DEFAULT false,
  receipt_cap boolean NOT NULL DEFAULT false,
  delivery_remind_days integer NOT NULL DEFAULT 0 CHECK (delivery_remind_days BETWEEN 0 AND 365),
  receipt_remind_days integer NOT NULL DEFAULT 0 CHECK (receipt_remind_days BETWEEN 0 AND 365),
  remind_to text NOT NULL DEFAULT 'creator',
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE money_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('customer','supplier')), name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  sort integer NOT NULL DEFAULT 1, UNIQUE (tenant_id, id), UNIQUE (tenant_id, kind, name)
);

CREATE TABLE money_end_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40), sort integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);

CREATE TABLE money_audit_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  object_type text NOT NULL CHECK (object_type IN ('quotation','contract','cash','expense')),
  enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);

CREATE TABLE money_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id), series text NOT NULL, period text NOT NULL DEFAULT '',
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0), PRIMARY KEY (tenant_id, series, period)
);

CREATE TABLE money_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL, name text NOT NULL, phone text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE money_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL, region text NOT NULL DEFAULT '', detail text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE money_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL, customer_id uuid NOT NULL, contact_name text NOT NULL DEFAULT '', contact_phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '', amount numeric(20,8) NOT NULL DEFAULT 0, qty numeric(20,6) NOT NULL DEFAULT 0,
  delivery_date date, quote_date date NOT NULL, salesperson_id uuid NOT NULL, note text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('draft','pending','approved','rejected','withdrawn','exempt')),
  quote_status text NOT NULL DEFAULT 'quoting' CHECK (quote_status IN ('quoting','success','failed')),
  signed boolean NOT NULL DEFAULT false, contract_id uuid, version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE money_quotation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, quotation_id uuid NOT NULL,
  line_no integer NOT NULL, product_id uuid NOT NULL, product_name text NOT NULL, product_code text NOT NULL,
  specification text NOT NULL DEFAULT '', unit_name text NOT NULL DEFAULT '', source text NOT NULL DEFAULT '',
  unit_price numeric(20,8) NOT NULL, quantity numeric(20,6) NOT NULL, discount numeric(20,8) NOT NULL DEFAULT 10,
  concession numeric(20,8) NOT NULL DEFAULT 0, amount numeric(20,8) NOT NULL, net_amount numeric(20,8) NOT NULL,
  note text NOT NULL DEFAULT '', UNIQUE (tenant_id, id), UNIQUE (tenant_id, quotation_id, line_no),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES money_quotations(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE money_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL, customer_id uuid NOT NULL, contact_name text NOT NULL DEFAULT '', contact_phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '', prepay numeric(20,8) NOT NULL DEFAULT 0, amount numeric(20,8) NOT NULL DEFAULT 0,
  qty numeric(20,6) NOT NULL DEFAULT 0, delivery_date date, receipt_date date, salesperson_id uuid NOT NULL,
  tax_included boolean NOT NULL DEFAULT false, note text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'draft' CHECK (approval IN ('draft','pending','approved','rejected','withdrawn','exempt')),
  lifecycle text NOT NULL DEFAULT 'inactive' CHECK (lifecycle IN ('inactive','performing','done','terminated')),
  approved_at timestamptz, completed_at timestamptz, quotation_id uuid, version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE money_contract_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, contract_id uuid NOT NULL,
  line_no integer NOT NULL, product_id uuid NOT NULL, product_name text NOT NULL, product_code text NOT NULL,
  specification text NOT NULL DEFAULT '', unit_name text NOT NULL DEFAULT '', source text NOT NULL DEFAULT '',
  unit_price numeric(20,8) NOT NULL, quantity numeric(20,6) NOT NULL, discount numeric(20,8) NOT NULL DEFAULT 10,
  concession numeric(20,8) NOT NULL DEFAULT 0, amount numeric(20,8) NOT NULL, net_amount numeric(20,8) NOT NULL,
  note text NOT NULL DEFAULT '', UNIQUE (tenant_id, id), UNIQUE (tenant_id, contract_id, line_no),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES money_contracts(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE money_cash (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  contract_id uuid, customer_id uuid NOT NULL, direction text NOT NULL CHECK (direction IN ('in','out')),
  amount numeric(20,8) NOT NULL CHECK (amount > 0), note text NOT NULL DEFAULT '', attachment text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','withdrawn','exempt')),
  source text NOT NULL DEFAULT 'contract' CHECK (source IN ('prepay','contract','shipment')),
  allocations jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE money_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  contract_id uuid NOT NULL, customer_id uuid NOT NULL, amount numeric(20,8) NOT NULL CHECK (amount > 0),
  apply_note text NOT NULL DEFAULT '', attachment text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','rejected')),
  invoice_note text NOT NULL DEFAULT '', invoiced_by uuid, invoiced_at timestamptz,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, contract_id) REFERENCES money_contracts(tenant_id, id)
);

CREATE TABLE money_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL, contract_id uuid, spent_on date NOT NULL,
  category text NOT NULL CHECK (category IN ('差旅费','招待','赠礼','回扣')),
  amount numeric(20,8) NOT NULL CHECK (amount > 0), note text NOT NULL DEFAULT '', attachment text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','withdrawn','exempt')),
  settled boolean NOT NULL DEFAULT false, settle_attachment text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE money_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  object_type text NOT NULL, object_id uuid NOT NULL, action text NOT NULL,
  actor_name text NOT NULL, opinion text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE money_terminations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  contract_id uuid NOT NULL, reason_name text NOT NULL, note text NOT NULL DEFAULT '', attachment text NOT NULL DEFAULT '',
  before_status text NOT NULL, received_amount numeric(20,8) NOT NULL, debt_amount numeric(20,8) NOT NULL,
  operator_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, contract_id) REFERENCES money_contracts(tenant_id, id)
);

CREATE TABLE money_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  object_type text NOT NULL, object_id uuid NOT NULL, message text NOT NULL, actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id)
);

CREATE TABLE money_purchase_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL, name text NOT NULL, supplier_id uuid, amount numeric(20,8) NOT NULL DEFAULT 0,
  qty numeric(20,6) NOT NULL DEFAULT 0, delivery_date date, note text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'exempt', version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE money_purchase_plan_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, plan_id uuid NOT NULL,
  line_no integer NOT NULL, product_id uuid NOT NULL, product_name text NOT NULL, product_code text NOT NULL,
  specification text NOT NULL DEFAULT '', category text NOT NULL DEFAULT '', unit_name text NOT NULL DEFAULT '',
  supplier_name text NOT NULL DEFAULT '', quantity numeric(20,6) NOT NULL, unit_price numeric(20,8) NOT NULL,
  amount numeric(20,8) NOT NULL, note text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, plan_id, line_no),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES money_purchase_plans(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE money_purchase_line_meta (
  line_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), order_id uuid NOT NULL,
  plan_code text NOT NULL DEFAULT '', plan_name text NOT NULL DEFAULT '', contract_id uuid, contract_code text NOT NULL DEFAULT '',
  discount numeric(20,8) NOT NULL DEFAULT 10, concession numeric(20,8) NOT NULL DEFAULT 0, net_amount numeric(20,8) NOT NULL DEFAULT 0,
  supplier_name text NOT NULL DEFAULT '', UNIQUE (tenant_id, line_id)
);

CREATE TABLE money_purchase_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL, supplier_id uuid NOT NULL, amount numeric(20,8) NOT NULL CHECK (amount > 0),
  pay_date date NOT NULL, note text NOT NULL DEFAULT '', attachment text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'exempt', version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, order_id) REFERENCES purchase_orders(tenant_id, id)
);

CREATE TABLE money_purchase_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL, supplier_id uuid NOT NULL, amount numeric(20,8) NOT NULL CHECK (amount > 0),
  invoice_date date NOT NULL, note text NOT NULL DEFAULT '', attachment text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'exempt', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, order_id) REFERENCES purchase_orders(tenant_id, id)
);

CREATE TABLE money_purchase_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL, amount numeric(20,8) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase_orders(tenant_id, id)
);

CREATE TABLE money_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL, title text NOT NULL, message text NOT NULL, dedupe text NOT NULL,
  read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, user_id, dedupe)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['money_settings','money_tags','money_end_reasons','money_audit_flows','money_counters','money_contacts','money_addresses','money_quotations','money_quotation_lines','money_contracts','money_contract_lines','money_cash','money_invoices','money_expenses','money_audit_logs','money_terminations','money_logs','money_purchase_plans','money_purchase_plan_lines','money_purchase_line_meta','money_purchase_payments','money_purchase_invoices','money_purchase_returns','money_notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
