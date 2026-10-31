-- Round 5 warehouse: extended master data, inbound/outbound bills, settings, audit, transfers, counts, ledger balance.

ALTER TABLE warehouses
  ALTER COLUMN code DROP NOT NULL,
  ADD COLUMN province text NOT NULL DEFAULT '',
  ADD COLUMN city text NOT NULL DEFAULT '',
  ADD COLUMN district text NOT NULL DEFAULT '',
  ADD COLUMN address text NOT NULL DEFAULT '',
  ADD COLUMN manager_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE purchase_receipts
  ALTER COLUMN order_id DROP NOT NULL,
  ADD COLUMN receipt_date date NOT NULL DEFAULT (CURRENT_DATE),
  ADD COLUMN inbound_type text NOT NULL DEFAULT '',
  ADD COLUMN receiver_id uuid,
  ADD COLUMN note text NOT NULL DEFAULT '',
  ADD COLUMN audit_status text NOT NULL DEFAULT 'exempt'
    CHECK (audit_status IN ('pending','approved','rejected','withdrawn','exempt'));

ALTER TABLE shipments
  ALTER COLUMN sales_order_id DROP NOT NULL,
  ADD COLUMN customer_id uuid,
  ADD COLUMN contract_id uuid,
  ADD COLUMN outbound_type text NOT NULL DEFAULT '',
  ADD COLUMN outbound_mode text NOT NULL DEFAULT '',
  ADD COLUMN ship_date date NOT NULL DEFAULT (CURRENT_DATE),
  ADD COLUMN shipper_id uuid,
  ADD COLUMN contact_name text NOT NULL DEFAULT '',
  ADD COLUMN contact_phone text NOT NULL DEFAULT '',
  ADD COLUMN ship_address text NOT NULL DEFAULT '',
  ADD COLUMN audit_status text NOT NULL DEFAULT 'exempt'
    CHECK (audit_status IN ('pending','approved','rejected','withdrawn','exempt'));

ALTER TABLE shipment_lines
  ALTER COLUMN sales_line_id DROP NOT NULL,
  ADD COLUMN contract_line_id uuid,
  ADD COLUMN unit_price numeric(21,7) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  ADD COLUMN amount_cents numeric(30,0) NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  ADD COLUMN cost_unit_price numeric(21,7) NOT NULL DEFAULT 0 CHECK (cost_unit_price >= 0),
  ADD COLUMN cost_amount_cents numeric(30,0) NOT NULL DEFAULT 0 CHECK (cost_amount_cents >= 0);

ALTER TABLE stock_ledger
  ADD COLUMN balance_after numeric(20,6),
  ADD COLUMN biz_date date,
  ADD COLUMN doc_code text,
  ADD COLUMN ledger_kind text,
  ADD COLUMN work_order_id uuid,
  ADD COLUMN in_warehouse_id uuid,
  ADD COLUMN out_warehouse_id uuid,
  ADD COLUMN remark text NOT NULL DEFAULT '',
  ADD COLUMN sale_unit_price numeric(21,7),
  ADD COLUMN sale_amount_cents numeric(30,0),
  ADD COLUMN cost_unit_price numeric(21,7),
  ADD COLUMN cost_amount_cents numeric(30,0);

CREATE TABLE stock_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  limit_purchase_in boolean NOT NULL DEFAULT true,
  limit_contract_out boolean NOT NULL DEFAULT true,
  limit_fg_in boolean NOT NULL DEFAULT true,
  alert_user_ids uuid[] NOT NULL DEFAULT '{}',
  hide_audit_status boolean NOT NULL DEFAULT false,
  allow_withdraw boolean NOT NULL DEFAULT false,
  formula_purchase_in text NOT NULL DEFAULT '${明细.采购单价}*${明细.采购数量}',
  formula_purchase_return text NOT NULL DEFAULT '${明细.采购单价}*${明细.退货数量}',
  formula_sale_out text NOT NULL DEFAULT '${明细.销售单价}*${明细.销售数量}',
  formula_sale_return text NOT NULL DEFAULT '${明细.销售单价}*${明细.退货数量}',
  amount_scale integer NOT NULL DEFAULT 8 CHECK (amount_scale BETWEEN 0 AND 8),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_io_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, direction, name)
);

CREATE TABLE stock_audit_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  object_type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  allow_withdraw boolean NOT NULL DEFAULT false,
  approver_ids uuid[] NOT NULL DEFAULT '{}',
  sign_mode text NOT NULL DEFAULT 'or' CHECK (sign_mode IN ('or','and')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE stock_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  action text NOT NULL,
  actor_id uuid NOT NULL,
  opinion text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE purchase_return_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  order_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  return_date date NOT NULL DEFAULT (CURRENT_DATE),
  outbound_type text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
  audit_status text NOT NULL DEFAULT 'exempt' CHECK (audit_status IN ('pending','approved','rejected','withdrawn','exempt')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE purchase_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bill_id uuid NOT NULL,
  purchase_line_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_price numeric(21,7) NOT NULL CHECK (unit_price >= 0),
  amount_cents numeric(30,0) NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bill_id, purchase_line_id),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES purchase_return_bills(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_line_id) REFERENCES purchase_order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);

CREATE TABLE stock_transfer_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  from_warehouse_id uuid NOT NULL,
  to_warehouse_id uuid NOT NULL CHECK (to_warehouse_id <> from_warehouse_id),
  transfer_date date NOT NULL DEFAULT (CURRENT_DATE),
  note text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
  audit_status text NOT NULL DEFAULT 'exempt' CHECK (audit_status IN ('pending','approved','rejected','withdrawn','exempt')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, from_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, to_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bill_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  cost_unit_price numeric(21,7) NOT NULL DEFAULT 0,
  cost_amount_cents numeric(30,0) NOT NULL DEFAULT 0,
  sale_unit_price numeric(21,7) NOT NULL DEFAULT 0,
  sale_amount_cents numeric(30,0) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bill_id, product_id, unit_id),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES stock_transfer_bills(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);

CREATE TABLE stock_taking_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  warehouse_id uuid NOT NULL,
  taking_date date NOT NULL DEFAULT (CURRENT_DATE),
  mode text NOT NULL DEFAULT 'custom' CHECK (mode IN ('custom','full')),
  note text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','confirmed','cancelled')),
  diff_total numeric(20,6) NOT NULL DEFAULT 0,
  approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
  audit_status text NOT NULL DEFAULT 'exempt' CHECK (audit_status IN ('pending','approved','rejected','withdrawn','exempt')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE stock_taking_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bill_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  book_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (book_qty >= 0),
  actual_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (actual_qty >= 0),
  diff_qty numeric(20,6) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bill_id, product_id, unit_id),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES stock_taking_bills(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);

CREATE TABLE warehouse_misc_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bill_kind text NOT NULL CHECK (bill_kind IN ('semi_fg_in','sales_return','else_in','else_out','prod_return_mat')),
  code text NOT NULL,
  warehouse_id uuid,
  contract_id uuid,
  work_order_id uuid,
  note text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
  audit_status text NOT NULL DEFAULT 'exempt' CHECK (audit_status IN ('pending','approved','rejected','withdrawn','exempt')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE warehouse_misc_bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bill_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_price numeric(21,7) NOT NULL DEFAULT 0,
  amount_cents numeric(30,0) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES warehouse_misc_bills(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);

CREATE TABLE warehouse_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  series text NOT NULL,
  period text NOT NULL DEFAULT '',
  next_value bigint NOT NULL CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, series, period)
);

ALTER TABLE money_contract_lines ADD COLUMN IF NOT EXISTS shipped_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (shipped_qty >= 0);

ALTER TABLE shipment_lines
  ADD CONSTRAINT shipment_lines_contract_line_fk
  FOREIGN KEY (tenant_id, contract_line_id) REFERENCES money_contract_lines(tenant_id, id);

ALTER TABLE shipments
  ADD CONSTRAINT shipments_customer_fk
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  ADD CONSTRAINT shipments_contract_fk
  FOREIGN KEY (tenant_id, contract_id) REFERENCES money_contracts(tenant_id, id);

-- Migrate legacy money purchase returns into purchase return bills (one bill per legacy row).
INSERT INTO purchase_return_bills(tenant_id, code, order_id, warehouse_id, return_date, note, approval, audit_status, created_by, created_at, updated_at)
SELECT r.tenant_id,
  'CGTH-MIG-' || substr(r.id::text, 1, 8),
  r.order_id,
  coalesce((SELECT pr.warehouse_id FROM purchase_receipts pr WHERE pr.tenant_id = r.tenant_id AND pr.order_id = r.order_id AND pr.approval = 'approved' ORDER BY pr.created_at LIMIT 1),
           (SELECT w.id FROM warehouses w WHERE w.tenant_id = r.tenant_id AND w.active ORDER BY w.code LIMIT 1)),
  (r.created_at AT TIME ZONE 'Asia/Shanghai')::date,
  '迁移自钱线退货记录',
  'approved',
  'exempt',
  (SELECT o.created_by FROM purchase_orders o WHERE o.tenant_id = r.tenant_id AND o.id = r.order_id),
  r.created_at,
  r.created_at
FROM money_purchase_returns r
WHERE NOT EXISTS (
  SELECT 1 FROM purchase_return_bills b WHERE b.tenant_id = r.tenant_id AND b.code = 'CGTH-MIG-' || substr(r.id::text, 1, 8)
);

INSERT INTO purchase_return_lines(tenant_id, bill_id, purchase_line_id, product_id, unit_id, quantity, unit_price, amount_cents)
SELECT b.tenant_id, b.id, l.id, l.product_id, l.unit_id, 1, l.unit_price, round(r.amount * 100)::numeric(30,0)
FROM purchase_return_bills b
JOIN money_purchase_returns r ON r.tenant_id = b.tenant_id AND r.order_id = b.order_id AND b.code = 'CGTH-MIG-' || substr(r.id::text, 1, 8)
JOIN LATERAL (
  SELECT * FROM purchase_order_lines pl WHERE pl.tenant_id = b.tenant_id AND pl.order_id = b.order_id ORDER BY pl.line_no LIMIT 1
) l ON true;

-- Backfill stock_ledger.balance_after per warehouse x product ordered by posted_at, id.
WITH ordered AS (
  SELECT id,
    sum(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END)
      OVER (PARTITION BY tenant_id, warehouse_id, product_id, unit_id ORDER BY posted_at, id) AS bal
  FROM stock_ledger
)
UPDATE stock_ledger l SET balance_after = o.bal FROM ordered o WHERE l.id = o.id;

UPDATE stock_ledger SET biz_date = (posted_at AT TIME ZONE 'Asia/Shanghai')::date WHERE biz_date IS NULL;

ALTER TABLE document_counters DROP CONSTRAINT IF EXISTS document_counters_doc_type_check;
ALTER TABLE document_counters ADD CONSTRAINT document_counters_doc_type_check CHECK(doc_type IN (
  'SO','WO','RP','MI','FG','SH','AD','QC','PO','PR','IQC','MRP','PAYROLL','RC','PC','SP','RW','EX','TR','CT',
  'CGRK','CPRK','BCP','SCTL','XSTH','QTRK','HTCK','SCCK','CGTH','QTCK','KCDB','PK'
));

ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_type_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_type_check CHECK(source_type IN (
  'adjustment','material_issue','fg_receipt','shipment','purchase_receipt','supplement_issue',
  'transfer_out','transfer_in','stock_count','purchase_return','sales_return','else_in','else_out',
  'semi_fg_in','prod_return_mat','transfer_bill'
));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stock_settings','stock_io_types','stock_audit_flows','stock_audit_logs',
    'purchase_return_bills','purchase_return_lines','stock_transfer_bills','stock_transfer_lines',
    'stock_taking_bills','stock_taking_lines','warehouse_misc_bills','warehouse_misc_bill_lines','warehouse_counters'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),''''))', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON stock_settings, stock_io_types, stock_audit_flows, stock_audit_logs,
  purchase_return_bills, purchase_return_lines, stock_transfer_bills, stock_transfer_lines,
  stock_taking_bills, stock_taking_lines, warehouse_misc_bills, warehouse_misc_bill_lines, warehouse_counters TO gd_tenant;

INSERT INTO stock_io_types(tenant_id, direction, name, sort)
SELECT t.id, d.dir, d.name, d.sort
FROM tenants t
CROSS JOIN (VALUES
  ('in','采购入库',1),('in','成品入库',2),('in','半成品入库',3),('in','生产退料',4),('in','销售退货',5),('in','其他入库',6),
  ('out','销售出库',1),('out','生产出库',2),('out','采购退货',3),('out','其他出库',4)
) AS d(dir, name, sort)
ON CONFLICT DO NOTHING;

INSERT INTO stock_settings(tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;
