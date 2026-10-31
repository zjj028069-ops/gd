-- Round 7: multi-level audit flows. Old money/stock flow tables stay, but new code reads these.

CREATE TABLE audit_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  module text NOT NULL CHECK (module IN ('customer', 'stock', 'purchase')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  allow_withdraw boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE audit_flow_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  flow_id uuid NOT NULL,
  object_type text NOT NULL,
  UNIQUE (tenant_id, object_type),
  FOREIGN KEY (tenant_id, flow_id) REFERENCES audit_flows(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_flow_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  flow_id uuid NOT NULL,
  level_no integer NOT NULL CHECK (level_no > 0),
  sign_mode text NOT NULL CHECK (sign_mode IN ('and', 'or')),
  approver_ids uuid[] NOT NULL CHECK (cardinality(approver_ids) >= 1),
  UNIQUE (tenant_id, flow_id, level_no),
  FOREIGN KEY (tenant_id, flow_id) REFERENCES audit_flows(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  flow_snapshot jsonb NOT NULL,
  current_level integer NOT NULL DEFAULT 1 CHECK (current_level > 0),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  submitted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX audit_instances_one_pending ON audit_instances (tenant_id, object_type, object_id) WHERE status = 'pending';

CREATE TABLE audit_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  instance_id uuid NOT NULL,
  level_no integer NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('通过', '退回', '撤回')),
  attachment text NOT NULL DEFAULT '',
  remark text NOT NULL DEFAULT '' CHECK (length(remark) <= 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES audit_instances(tenant_id, id) ON DELETE CASCADE
);

-- Move the earliest enabled flow per object. Missing approvers become every active admin, or-sign.
INSERT INTO audit_flows (id, tenant_id, module, name, allow_withdraw, enabled, version, created_at)
SELECT id, tenant_id, module, name, allow_withdraw, enabled, version, created_at
FROM (
  SELECT id, tenant_id, 'customer'::text AS module, name, false AS allow_withdraw, enabled, version, now() AS created_at,
    row_number() OVER (PARTITION BY tenant_id, object_type ORDER BY enabled DESC, id) AS rn
  FROM money_audit_flows
) picked WHERE rn = 1;

INSERT INTO audit_flow_objects (tenant_id, flow_id, object_type)
SELECT tenant_id, id, object_type FROM (
  SELECT id, tenant_id, object_type, row_number() OVER (PARTITION BY tenant_id, object_type ORDER BY enabled DESC, id) AS rn
  FROM money_audit_flows
) picked WHERE rn = 1;

INSERT INTO audit_flows (id, tenant_id, module, name, allow_withdraw, enabled, version, created_at)
SELECT id, tenant_id, 'stock', name, allow_withdraw, enabled, version, created_at
FROM (
  SELECT id, tenant_id, name, allow_withdraw, enabled, version, created_at,
    row_number() OVER (PARTITION BY tenant_id, object_type ORDER BY enabled DESC, created_at, id) AS rn
  FROM stock_audit_flows
  WHERE NOT EXISTS (SELECT 1 FROM audit_flow_objects o WHERE o.tenant_id = stock_audit_flows.tenant_id AND o.object_type = stock_audit_flows.object_type)
) picked WHERE rn = 1;

INSERT INTO audit_flow_objects (tenant_id, flow_id, object_type)
SELECT tenant_id, id, CASE WHEN object_type = 'transfer' THEN 'KCDB' ELSE object_type END
FROM (
  SELECT id, tenant_id, object_type, row_number() OVER (PARTITION BY tenant_id, object_type ORDER BY enabled DESC, created_at, id) AS rn
  FROM stock_audit_flows
) picked WHERE rn = 1
AND NOT EXISTS (
  SELECT 1 FROM audit_flow_objects o WHERE o.tenant_id = picked.tenant_id AND o.object_type = CASE WHEN picked.object_type = 'transfer' THEN 'KCDB' ELSE picked.object_type END
);

INSERT INTO audit_flow_levels (tenant_id, flow_id, level_no, sign_mode, approver_ids)
SELECT f.tenant_id, f.id, 1, 'or', admins.ids
FROM audit_flows f
JOIN audit_flow_objects o ON o.tenant_id = f.tenant_id AND o.flow_id = f.id
LEFT JOIN stock_audit_flows s ON s.id = f.id
CROSS JOIN LATERAL (
  SELECT COALESCE(
    CASE WHEN s.approver_ids IS NOT NULL AND cardinality(s.approver_ids) >= 1 THEN s.approver_ids END,
    (SELECT array_agg(m.user_id) FROM memberships m WHERE m.tenant_id = f.tenant_id AND m.role = 'admin' AND m.active)
  ) AS ids
) admins
WHERE admins.ids IS NOT NULL AND cardinality(admins.ids) >= 1
AND NOT EXISTS (SELECT 1 FROM audit_flow_levels l WHERE l.flow_id = f.id);

UPDATE audit_flows f SET enabled = false
WHERE NOT EXISTS (SELECT 1 FROM audit_flow_levels l WHERE l.flow_id = f.id);

ALTER TABLE fg_receipts ADD COLUMN audit_status text NOT NULL DEFAULT 'exempt';
ALTER TABLE material_issues ADD COLUMN audit_status text NOT NULL DEFAULT 'exempt';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN (
        'purchase_orders'::regclass, 'purchase_receipts'::regclass, 'purchase_return_bills'::regclass,
        'shipments'::regclass, 'fg_receipts'::regclass, 'material_issues'::regclass,
        'stock_transfer_bills'::regclass, 'warehouse_misc_bills'::regclass
      )
      AND pg_get_constraintdef(c.oid) ILIKE '%approval%'
      AND pg_get_constraintdef(c.oid) NOT ILIKE '%audit_status%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_approval_check CHECK (approval IN ('pending', 'approved', 'rejected', 'withdrawn'));
ALTER TABLE purchase_receipts ADD CONSTRAINT purchase_receipts_approval_check CHECK (approval IN ('pending', 'approved', 'rejected', 'reversed', 'withdrawn'));
ALTER TABLE purchase_return_bills ADD CONSTRAINT purchase_return_bills_approval_check CHECK (approval IN ('pending', 'approved', 'rejected', 'reversed', 'withdrawn'));
ALTER TABLE shipments ADD CONSTRAINT shipments_approval_check CHECK (approval IN ('pending', 'approved', 'rejected', 'reversed', 'withdrawn'));
ALTER TABLE fg_receipts ADD CONSTRAINT fg_receipts_approval_check CHECK (approval IN ('pending', 'approved', 'rejected', 'reversed', 'withdrawn'));
ALTER TABLE material_issues ADD CONSTRAINT material_issues_approval_check CHECK (approval IN ('pending', 'approved', 'rejected', 'reversed', 'withdrawn'));
ALTER TABLE stock_transfer_bills ADD CONSTRAINT stock_transfer_bills_approval_check CHECK (approval IN ('pending', 'approved', 'rejected', 'reversed', 'withdrawn'));
ALTER TABLE warehouse_misc_bills ADD CONSTRAINT warehouse_misc_bills_approval_check CHECK (approval IN ('pending', 'approved', 'rejected', 'reversed', 'withdrawn'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_flows', 'audit_flow_objects', 'audit_flow_levels', 'audit_instances', 'audit_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
