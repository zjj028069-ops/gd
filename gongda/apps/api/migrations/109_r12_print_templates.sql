-- 第十二轮：按业务对象隔离的打印模板。系统模板只读，自定义模板保存设计器版式。

CREATE TABLE print_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  is_system boolean NOT NULL DEFAULT false,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, object_key, name)
);

CREATE UNIQUE INDEX print_templates_one_system ON print_templates (tenant_id, object_key) WHERE is_system;
CREATE INDEX print_templates_object ON print_templates (tenant_id, object_key, is_system DESC, created_at);

ALTER TABLE print_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY print_templates_tenant ON print_templates TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON print_templates TO gd_tenant;
