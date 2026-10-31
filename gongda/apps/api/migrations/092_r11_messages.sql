CREATE TABLE kgd_message_category_sorts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  category_key text NOT NULL,
  sort_no integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, user_id, category_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

ALTER TABLE kgd_messages DROP CONSTRAINT IF EXISTS kgd_messages_kind_check;
ALTER TABLE kgd_messages ADD CONSTRAINT kgd_messages_kind_check CHECK (kind IN (
  'alarm','todo','notice','follow','bulletin','maint_plan','repair','contract','produce','warehouse','service','feedback','oa'
));
ALTER TABLE kgd_messages ADD COLUMN IF NOT EXISTS category_key text NOT NULL DEFAULT 'notice';

DO $$ BEGIN
  ALTER TABLE kgd_message_category_sorts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE kgd_message_category_sorts FORCE ROW LEVEL SECURITY;
  CREATE POLICY kgd_message_category_sorts_tenant ON kgd_message_category_sorts TO gd_tenant
    USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
  GRANT SELECT, INSERT, UPDATE, DELETE ON kgd_message_category_sorts TO gd_tenant;
END $$;
