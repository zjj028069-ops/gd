-- Round 12 P2-B1: per-user list column preferences
CREATE TABLE list_column_prefs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  page_key text NOT NULL CHECK (length(page_key) BETWEEN 1 AND 80),
  prefs jsonb NOT NULL DEFAULT '{"order":[],"visible":[],"locked":[]}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, page_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

ALTER TABLE list_column_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_column_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY list_column_prefs_tenant ON list_column_prefs TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON list_column_prefs TO gd_tenant;
