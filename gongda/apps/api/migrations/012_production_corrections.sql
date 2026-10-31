-- Audited rework and additional physical input; never expand net finished quantity.
ALTER TABLE work_order_tasks ADD COLUMN wage_rule_version_id uuid;
ALTER TABLE work_order_tasks ADD CONSTRAINT task_wage_version_fk FOREIGN KEY(tenant_id,wage_rule_version_id) REFERENCES wage_rule_versions(tenant_id,id);
ALTER TABLE production_reports DROP CONSTRAINT production_reports_check;
ALTER TABLE production_reports ADD CONSTRAINT production_reports_nonempty CHECK(good_qty+defect_qty>0 OR effective_seconds>0);
CREATE TABLE production_supplements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,
 work_order_id uuid NOT NULL,task_id uuid NOT NULL,warehouse_id uuid NOT NULL,quantity numeric(20,6) NOT NULL CHECK(quantity>0),
 reason text NOT NULL CHECK(length(btrim(reason))>0),approval text NOT NULL DEFAULT 'pending' CHECK(approval IN ('pending','approved','rejected','reversed')),
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),version integer NOT NULL DEFAULT 1,UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),
 FOREIGN KEY(tenant_id,work_order_id) REFERENCES work_orders(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES work_order_tasks(tenant_id,id),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id));
CREATE TABLE supplement_materials(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),supplement_id uuid NOT NULL,material_id uuid NOT NULL,
 product_id uuid NOT NULL,unit_id uuid NOT NULL,quantity numeric(20,6) NOT NULL CHECK(quantity>0),UNIQUE(tenant_id,id),UNIQUE(tenant_id,supplement_id,material_id),
 FOREIGN KEY(tenant_id,supplement_id) REFERENCES production_supplements(tenant_id,id),FOREIGN KEY(tenant_id,material_id) REFERENCES work_order_materials(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id));
ALTER TABLE production_reports ADD COLUMN supplement_id uuid;
ALTER TABLE production_reports ADD CONSTRAINT report_supplement_fk FOREIGN KEY(tenant_id,supplement_id) REFERENCES production_supplements(tenant_id,id);
CREATE TABLE rework_reports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,
 source_report_id uuid NOT NULL,work_order_id uuid NOT NULL,task_id uuid NOT NULL,operator_id uuid NOT NULL,
 good_qty numeric(20,6) NOT NULL CHECK(good_qty>=0),defect_qty numeric(20,6) NOT NULL CHECK(defect_qty>=0),CHECK(good_qty+defect_qty>0),
 effective_seconds integer NOT NULL DEFAULT 0 CHECK(effective_seconds BETWEEN 0 AND 2678400),wage_snapshot jsonb NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>0),approval text NOT NULL DEFAULT 'pending' CHECK(approval IN ('pending','approved','rejected','reversed')),
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),version integer NOT NULL DEFAULT 1,UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),
 FOREIGN KEY(tenant_id,source_report_id) REFERENCES production_reports(tenant_id,id),FOREIGN KEY(tenant_id,work_order_id) REFERENCES work_orders(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES work_order_tasks(tenant_id,id),FOREIGN KEY(tenant_id,operator_id) REFERENCES memberships(tenant_id,user_id),FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id));
DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['production_supplements','supplement_materials','rework_reports'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO gd_tenant USING(tenant_id::text=nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK(tenant_id::text=nullif(current_setting(''app.tenant_id'',true),''''))',t||'_tenant',t);END LOOP; END $rls$;
GRANT SELECT,INSERT,UPDATE ON production_supplements,rework_reports TO gd_tenant;
GRANT SELECT,INSERT ON supplement_materials TO gd_tenant;
ALTER TABLE document_counters DROP CONSTRAINT document_counters_doc_type_check;
ALTER TABLE document_counters ADD CONSTRAINT document_counters_doc_type_check CHECK(doc_type IN ('SO','WO','RP','MI','FG','SH','AD','QC','PO','PR','IQC','MRP','PAYROLL','RC','PC','SP','RW'));

ALTER TABLE wage_events ADD COLUMN worker_name text NOT NULL DEFAULT '';
