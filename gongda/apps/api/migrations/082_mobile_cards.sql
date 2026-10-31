-- 移动端卡片配置，按企业保存。个人列配置仍在浏览器本地。
CREATE TABLE r9_mobile_cards (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  page_key text NOT NULL CHECK (length(page_key) BETWEEN 1 AND 80),
  tab_key text NOT NULL CHECK (length(tab_key) BETWEEN 1 AND 40),
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, page_key, tab_key)
);

ALTER TABLE r9_mobile_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE r9_mobile_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY r9_mobile_cards_tenant ON r9_mobile_cards TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON r9_mobile_cards TO gd_tenant;
