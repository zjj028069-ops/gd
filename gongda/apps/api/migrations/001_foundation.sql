DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gd_auth') THEN
    CREATE ROLE gd_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gd_tenant') THEN
    CREATE ROLE gd_tenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO gd_auth, gd_tenant;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 80),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin','planner','worker')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,user_id)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  csrf_token text NOT NULL,
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,code)
);
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  specification text NOT NULL DEFAULT '' CHECK (length(specification) <= 500),
  unit_id uuid NOT NULL,
  attribute text NOT NULL CHECK (attribute IN ('manufactured','purchased')),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,code),
  FOREIGN KEY (tenant_id,unit_id) REFERENCES units(tenant_id,id)
);
CREATE INDEX products_tenant_created_idx ON products(tenant_id,created_at DESC);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_name text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_created_idx ON audit_events(tenant_id,created_at DESC);

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE units FORCE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY units_tenant ON units TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id',true),''));
CREATE POLICY products_tenant ON products TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id',true),''));
CREATE POLICY audits_tenant ON audit_events TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id',true),''));

GRANT SELECT ON tenants, users, memberships TO gd_auth;
GRANT SELECT, INSERT, DELETE ON sessions TO gd_auth;
GRANT SELECT ON units TO gd_tenant;
GRANT SELECT, INSERT, UPDATE ON products TO gd_tenant;
GRANT SELECT, INSERT ON audit_events TO gd_tenant;

