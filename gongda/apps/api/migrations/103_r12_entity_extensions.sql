-- Round 12 P1: 加工单/联系人/客户扩展字段（独立于 product extension_schemas 版本链）

CREATE TABLE entity_ext_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity text NOT NULL CHECK (entity IN ('work_order', 'linkman', 'customer')),
  name text NOT NULL,
  field_type text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  sort_no int NOT NULL DEFAULT 0,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity, name)
);

CREATE TABLE entity_ext_values (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity text NOT NULL CHECK (entity IN ('work_order', 'linkman', 'customer')),
  record_id uuid NOT NULL,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity, record_id)
);

CREATE INDEX entity_ext_fields_entity_sort ON entity_ext_fields (tenant_id, entity, sort_no, created_at);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['entity_ext_fields', 'entity_ext_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))',
      t || '_tenant', t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
