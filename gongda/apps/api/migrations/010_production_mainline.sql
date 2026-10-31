-- 第四步生产主线实账。001—009 不改。新表全部企业隔离。
-- 库存流水只追加；余额是可核对投影，且默认不允许负数。
-- 工资、应收应付、移动加权成本不在本迁移落账。

ALTER TABLE route_steps ADD CONSTRAINT route_steps_tenant_id_unique UNIQUE (tenant_id, id);
ALTER TABLE bom_items ADD CONSTRAINT bom_items_tenant_id_unique UNIQUE (tenant_id, id);

CREATE TABLE customers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64), name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);
CREATE TABLE warehouses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64), name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);
CREATE TABLE document_counters (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 doc_type text NOT NULL CHECK (doc_type IN ('SO','WO','RP','MI','FG','SH','AD','QC')),
 next_value bigint NOT NULL CHECK (next_value > 0),
 PRIMARY KEY (tenant_id, doc_type)
);
CREATE TABLE command_replays (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 command text NOT NULL CHECK (length(command) BETWEEN 1 AND 80),
 request_key text NOT NULL CHECK (length(request_key) BETWEEN 8 AND 80),
 payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
 resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 40),
 resource_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, command, request_key)
);
CREATE TABLE sales_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64), customer_id uuid NOT NULL,
 lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft','open','closed','cancelled')),
 approval text NOT NULL DEFAULT 'unsubmitted' CHECK (approval IN ('unsubmitted','pending','approved','rejected','withdrawn')),
 note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000), promised_date date,
 close_reason text NOT NULL DEFAULT '' CHECK (length(close_reason) <= 500),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
 FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
 FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE sales_order_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, order_id uuid NOT NULL,
 line_no integer NOT NULL CHECK (line_no > 0), product_id uuid NOT NULL, unit_id uuid NOT NULL,
 quantity numeric(20,6) NOT NULL CHECK (quantity > 0), unit_price numeric(20,6) NOT NULL CHECK (unit_price >= 0),
 extended_amount numeric(20,2) NOT NULL CHECK (extended_amount >= 0),
 scheduled_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (scheduled_qty >= 0),
 shipped_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (shipped_qty >= 0),
 product_snapshot jsonb NOT NULL,
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, order_id, line_no),
 FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id),
 CHECK (scheduled_qty <= quantity), CHECK (shipped_qty <= quantity)
);
CREATE TABLE work_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
 product_id uuid NOT NULL, unit_id uuid NOT NULL, plan_qty numeric(20,6) NOT NULL CHECK (plan_qty > 0),
 sales_order_id uuid NOT NULL, sales_line_id uuid NOT NULL,
 route_version_id uuid NOT NULL, bom_version_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 product_snapshot jsonb NOT NULL, route_name_snapshot text NOT NULL, bom_revision integer NOT NULL CHECK (bom_revision > 0),
 execution text NOT NULL DEFAULT 'not_started' CHECK (execution IN ('not_started','running','paused','completed','cancelled')),
 order_paused boolean NOT NULL DEFAULT false,
 requires_fg_inspection boolean NOT NULL DEFAULT false,
 close_reason text NOT NULL DEFAULT '' CHECK (length(close_reason) <= 500),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
 started_at timestamptz, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id),
 FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, sales_line_id) REFERENCES sales_order_lines(tenant_id, id),
 FOREIGN KEY (tenant_id, route_version_id) REFERENCES route_versions(tenant_id, id),
 FOREIGN KEY (tenant_id, bom_version_id) REFERENCES bom_versions(tenant_id, id),
 FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
 FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE work_order_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, work_order_id uuid NOT NULL,
 sequence integer NOT NULL CHECK (sequence > 0), route_step_id uuid NOT NULL, process_id uuid NOT NULL,
 process_snapshot jsonb NOT NULL, unit_ratio numeric(20,6) NOT NULL CHECK (unit_ratio > 0),
 plan_qty numeric(20,6) NOT NULL CHECK (plan_qty > 0), is_output boolean NOT NULL DEFAULT false,
 execution text NOT NULL DEFAULT 'not_started' CHECK (execution IN ('not_started','running','paused','completed','cancelled')),
 pause_source text NOT NULL DEFAULT 'none' CHECK (pause_source IN ('none','order','manual')),
 previous_execution text CHECK (previous_execution IS NULL OR previous_execution IN ('not_started','running')),
 approved_good numeric(20,6) NOT NULL DEFAULT 0 CHECK (approved_good >= 0),
 approved_defect numeric(20,6) NOT NULL DEFAULT 0 CHECK (approved_defect >= 0),
 approved_rework numeric(20,6) NOT NULL DEFAULT 0 CHECK (approved_rework >= 0),
 approved_scrap numeric(20,6) NOT NULL DEFAULT 0 CHECK (approved_scrap >= 0),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, work_order_id, sequence),
 FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, route_step_id) REFERENCES route_steps(tenant_id, id),
 FOREIGN KEY (tenant_id, process_id) REFERENCES processes(tenant_id, id)
);
CREATE TABLE work_order_materials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, work_order_id uuid NOT NULL,
 product_id uuid NOT NULL, unit_id uuid NOT NULL,
 required_qty numeric(20,6) NOT NULL CHECK (required_qty > 0),
 issued_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (issued_qty >= 0),
 feeding_process_id uuid, feeding_task_id uuid, feeding_ambiguous boolean NOT NULL DEFAULT false,
 component_snapshot jsonb NOT NULL, source_paths jsonb NOT NULL,
 UNIQUE (tenant_id, id),
 FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id),
 FOREIGN KEY (tenant_id, feeding_process_id) REFERENCES processes(tenant_id, id),
 FOREIGN KEY (tenant_id, feeding_task_id) REFERENCES work_order_tasks(tenant_id, id),
 CHECK (issued_qty <= required_qty)
);
CREATE TABLE production_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
 work_order_id uuid NOT NULL, task_id uuid NOT NULL, process_id uuid NOT NULL,
 reporter_id uuid NOT NULL, operator_id uuid NOT NULL,
 good_qty numeric(20,6) NOT NULL CHECK (good_qty >= 0),
 defect_qty numeric(20,6) NOT NULL CHECK (defect_qty >= 0),
 rework_qty numeric(20,6) NOT NULL CHECK (rework_qty >= 0),
 scrap_qty numeric(20,6) NOT NULL CHECK (scrap_qty >= 0),
 defect_note text NOT NULL DEFAULT '' CHECK (length(defect_note) <= 500),
 note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
 supplement boolean NOT NULL DEFAULT false,
 approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
 reject_reason text NOT NULL DEFAULT '' CHECK (length(reject_reason) <= 500),
 wage_status text NOT NULL DEFAULT 'unpriced' CHECK (wage_status = 'unpriced'),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
 FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, task_id) REFERENCES work_order_tasks(tenant_id, id),
 FOREIGN KEY (tenant_id, process_id) REFERENCES processes(tenant_id, id),
 FOREIGN KEY (tenant_id, reporter_id) REFERENCES memberships(tenant_id, user_id),
 FOREIGN KEY (tenant_id, operator_id) REFERENCES memberships(tenant_id, user_id),
 CHECK (good_qty + defect_qty > 0),
 CHECK (rework_qty + scrap_qty <= defect_qty),
 CHECK (defect_qty = 0 OR char_length(btrim(defect_note)) > 0)
);
CREATE TABLE material_issues (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
 work_order_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
 FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
 FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE material_issue_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, issue_id uuid NOT NULL,
 material_id uuid NOT NULL, product_id uuid NOT NULL, unit_id uuid NOT NULL,
 quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
 UNIQUE (tenant_id, id),
 FOREIGN KEY (tenant_id, issue_id) REFERENCES material_issues(tenant_id, id),
 FOREIGN KEY (tenant_id, material_id) REFERENCES work_order_materials(tenant_id, id),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);
CREATE TABLE fg_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
 work_order_id uuid NOT NULL, task_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 product_id uuid NOT NULL, unit_id uuid NOT NULL,
 quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
 approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
 FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, task_id) REFERENCES work_order_tasks(tenant_id, id),
 FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id),
 FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE shipments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
 sales_order_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
 FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
 FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE shipment_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, shipment_id uuid NOT NULL,
 sales_line_id uuid NOT NULL, product_id uuid NOT NULL, unit_id uuid NOT NULL,
 quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
 UNIQUE (tenant_id, id),
 FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id),
 FOREIGN KEY (tenant_id, sales_line_id) REFERENCES sales_order_lines(tenant_id, id),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);
CREATE TABLE stock_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
 warehouse_id uuid NOT NULL, product_id uuid NOT NULL, unit_id uuid NOT NULL,
 direction text NOT NULL CHECK (direction IN ('in','out')),
 quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
 reason text NOT NULL CHECK (char_length(btrim(reason)) > 0 AND length(reason) <= 500),
 approval text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending','approved','rejected','reversed')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
 FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id),
 FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE inspections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
 work_order_id uuid NOT NULL, inspected_qty numeric(20,6) NOT NULL CHECK (inspected_qty > 0),
 good_qty numeric(20,6) NOT NULL CHECK (good_qty >= 0), defect_qty numeric(20,6) NOT NULL CHECK (defect_qty >= 0),
 accepted_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0),
 conclusion text NOT NULL DEFAULT 'pending' CHECK (conclusion IN ('pending','pass','fail')),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed')),
 note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
 FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
 FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id),
 CHECK (good_qty + defect_qty = inspected_qty),
 CHECK (state <> 'completed' OR conclusion IN ('pass','fail')),
 CHECK (conclusion <> 'pass' OR accepted_qty = good_qty),
 CHECK (conclusion <> 'fail' OR accepted_qty = 0)
);
CREATE TABLE stock_balances (
 tenant_id uuid NOT NULL, warehouse_id uuid NOT NULL, product_id uuid NOT NULL, unit_id uuid NOT NULL,
 on_hand numeric(20,6) NOT NULL CHECK (on_hand >= 0),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, warehouse_id, product_id, unit_id),
 FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);
CREATE TABLE stock_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 warehouse_id uuid NOT NULL, product_id uuid NOT NULL, unit_id uuid NOT NULL,
 direction text NOT NULL CHECK (direction IN ('in','out')),
 quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
 source_type text NOT NULL CHECK (source_type IN ('adjustment','material_issue','fg_receipt','shipment')),
 source_id uuid NOT NULL, event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 120),
 reversal_of uuid, posted_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, event_key),
 FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
 FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
 FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id),
 FOREIGN KEY (tenant_id, reversal_of) REFERENCES stock_ledger(tenant_id, id),
 FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE INDEX stock_ledger_product_idx ON stock_ledger(tenant_id, product_id, posted_at, id);
CREATE INDEX work_orders_sales_line_idx ON work_orders(tenant_id, sales_line_id);
CREATE INDEX production_reports_task_idx ON production_reports(tenant_id, task_id, approval);

DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['customers','warehouses','document_counters','command_replays','sales_orders','sales_order_lines','work_orders','work_order_tasks','work_order_materials','production_reports','material_issues','material_issue_lines','fg_receipts','shipments','shipment_lines','stock_adjustments','inspections','stock_balances','stock_ledger'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),''''))', table_name || '_tenant', table_name);
 END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON customers, warehouses, document_counters, sales_orders, work_orders, work_order_tasks, work_order_materials, production_reports, material_issues, fg_receipts, shipments, stock_adjustments, inspections, stock_balances TO gd_tenant;
GRANT SELECT, INSERT, UPDATE ON sales_order_lines, material_issue_lines, shipment_lines TO gd_tenant;
GRANT SELECT, INSERT ON command_replays, stock_ledger TO gd_tenant;
