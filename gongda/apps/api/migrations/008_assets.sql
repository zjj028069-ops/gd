CREATE TABLE tenant_service_limits (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','read_only','expired')),
  expires_at timestamptz,
  seat_limit integer NOT NULL DEFAULT 100 CHECK (seat_limit BETWEEN 1 AND 100000),
  product_limit integer NOT NULL DEFAULT 10000 CHECK (product_limit BETWEEN 0 AND 10000000),
  storage_limit_bytes bigint NOT NULL DEFAULT 104857600 CHECK (storage_limit_bytes BETWEEN 0 AND 1099511627776),
  storage_used_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tenant_service_limits(tenant_id) SELECT id FROM tenants;
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid,
  process_id uuid,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  mime text NOT NULL CHECK (mime IN ('image/png','image/jpeg','application/pdf','text/plain')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  payload bytea NOT NULL,
  request_key uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,request_key),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
  FOREIGN KEY(tenant_id,process_id) REFERENCES processes(tenant_id,id),
  CHECK (num_nonnulls(product_id,process_id)=1),
  CHECK (octet_length(payload)=byte_size),
  CHECK (deleted_at IS NULL OR NOT active)
);
CREATE INDEX attachments_product_idx ON attachments(tenant_id,product_id,created_at DESC);
CREATE INDEX attachments_process_idx ON attachments(tenant_id,process_id,created_at DESC);
ALTER TABLE tenant_service_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_service_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_service_limits_tenant ON tenant_service_limits TO gd_tenant
 USING(tenant_id::text=nullif(current_setting('app.tenant_id',true),''))
 WITH CHECK(tenant_id::text=nullif(current_setting('app.tenant_id',true),''));
CREATE POLICY attachments_tenant ON attachments TO gd_tenant
 USING(tenant_id::text=nullif(current_setting('app.tenant_id',true),''))
 WITH CHECK(tenant_id::text=nullif(current_setting('app.tenant_id',true),''));
GRANT SELECT,INSERT,UPDATE ON tenant_service_limits TO gd_tenant;
GRANT SELECT,INSERT ON attachments TO gd_tenant;
GRANT UPDATE(active,deleted_at,version,updated_at) ON attachments TO gd_tenant;
