-- Two-stage transfer custody and versioned physical stock counts.
CREATE TABLE warehouse_transfers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,
 from_warehouse_id uuid NOT NULL,to_warehouse_id uuid NOT NULL CHECK(to_warehouse_id<>from_warehouse_id),
 product_id uuid NOT NULL,unit_id uuid NOT NULL,quantity numeric(20,6) NOT NULL CHECK(quantity>0),product_snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','in_transit','received','cancelled')),amount_cents numeric(30,0),
 dispatch_event_key text,receive_event_key text,reason text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),FOREIGN KEY(tenant_id,from_warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,to_warehouse_id) REFERENCES warehouses(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id));
CREATE TABLE stock_counts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,
 warehouse_id uuid NOT NULL,product_id uuid NOT NULL,unit_id uuid NOT NULL,product_snapshot jsonb NOT NULL,
 book_qty numeric(20,6) NOT NULL CHECK(book_qty>=0),actual_qty numeric(20,6) NOT NULL CHECK(actual_qty>=0),delta_qty numeric(20,6) NOT NULL,
 stock_version integer NOT NULL,stock_snapshot jsonb NOT NULL,unit_price numeric(21,7),amount_cents numeric(30,0),stock_event_key text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','reversed','cancelled')),reason text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),CHECK(actual_qty-book_qty=delta_qty),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id));
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['warehouse_transfers','stock_counts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text=nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK(tenant_id::text=nullif(current_setting(''app.tenant_id'',true),''''))',t||'_tenant',t);
END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON warehouse_transfers,stock_counts TO gd_tenant;
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_type_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_type_check CHECK(source_type IN ('adjustment','material_issue','fg_receipt','shipment','purchase_receipt','supplement_issue','transfer_out','transfer_in','stock_count'));
ALTER TABLE document_counters DROP CONSTRAINT document_counters_doc_type_check;
ALTER TABLE document_counters ADD CONSTRAINT document_counters_doc_type_check CHECK(doc_type IN ('SO','WO','RP','MI','FG','SH','AD','QC','PO','PR','IQC','MRP','PAYROLL','RC','PC','SP','RW','EX','TR','CT'));
