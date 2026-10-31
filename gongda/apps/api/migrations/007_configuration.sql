CREATE TABLE numbering_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 entity text NOT NULL CHECK(entity IN ('unit','product','process','route','bom')),
 prefix text NOT NULL CHECK(length(prefix)<=32),date_pattern text NOT NULL CHECK(date_pattern IN ('none','yyyyMMdd','yyyyMM','yyyy')),
 reset_period text NOT NULL CHECK(reset_period IN ('never','day','month','year')),padding integer NOT NULL CHECK(padding BETWEEN 1 AND 12),
 start_value bigint NOT NULL CHECK(start_value BETWEEN 1 AND 999999999999),active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,entity)
);
CREATE TABLE numbering_counters (
 tenant_id uuid NOT NULL,rule_id uuid NOT NULL,period text NOT NULL CHECK(length(period)<=8),next_value bigint NOT NULL CHECK(next_value>0),
 PRIMARY KEY(tenant_id,rule_id,period),FOREIGN KEY(tenant_id,rule_id) REFERENCES numbering_rules(tenant_id,id)
);
CREATE TABLE numbering_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,rule_id uuid NOT NULL,entity text NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 80),number text NOT NULL CHECK(length(number)<=64),
 sequence bigint NOT NULL CHECK(sequence>0),period text NOT NULL,rule_version integer NOT NULL CHECK(rule_version>0),rule_snapshot jsonb NOT NULL,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,rule_id) REFERENCES numbering_rules(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,rule_id,request_key),UNIQUE(tenant_id,entity,number)
);
CREATE TABLE extension_schemas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),entity text NOT NULL CHECK(entity='product'),
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),latest_revision integer NOT NULL DEFAULT 1 CHECK(latest_revision>0),
 current_version_id uuid,current_revision integer NOT NULL DEFAULT 0 CHECK(current_revision>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,entity)
);
CREATE TABLE extension_schema_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,schema_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='array' AND jsonb_array_length(fields) BETWEEN 1 AND 30),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,schema_id) REFERENCES extension_schemas(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,schema_id,id),UNIQUE(tenant_id,schema_id,revision)
);
ALTER TABLE extension_schemas ADD FOREIGN KEY(tenant_id,id,current_version_id) REFERENCES extension_schema_versions(tenant_id,schema_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE extension_schema_publications (
 tenant_id uuid NOT NULL,version_id uuid NOT NULL,published_by uuid NOT NULL,published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version_id),FOREIGN KEY(tenant_id,version_id) REFERENCES extension_schema_versions(tenant_id,id),FOREIGN KEY(tenant_id,published_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE product_field_values (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,product_id uuid NOT NULL,schema_version_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),values jsonb NOT NULL CHECK(jsonb_typeof(values)='object'),calculation_details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,schema_version_id) REFERENCES extension_schema_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,product_id,revision)
);
CREATE TABLE user_views (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),user_id uuid,
 entity text NOT NULL CHECK(entity='product'),surface text NOT NULL CHECK(surface IN ('pc','mobile')),scope text NOT NULL CHECK(scope IN ('personal','tenant')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),current_history_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((scope='tenant' AND user_id IS NULL) OR (scope='personal' AND user_id IS NOT NULL)),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX user_views_tenant_unique ON user_views(tenant_id,entity,surface) WHERE scope='tenant';
CREATE UNIQUE INDEX user_views_personal_unique ON user_views(tenant_id,user_id,entity,surface) WHERE scope='personal';
CREATE TABLE user_view_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,view_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),created_by uuid NOT NULL,source text NOT NULL CHECK(source IN ('manual','admin_apply','restore')),
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,view_id) REFERENCES user_views(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,view_id,id),UNIQUE(tenant_id,view_id,revision)
);
ALTER TABLE user_views ADD FOREIGN KEY(tenant_id,id,current_history_id) REFERENCES user_view_history(tenant_id,view_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX product_fields_latest_idx ON product_field_values(tenant_id,product_id,revision DESC);
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['numbering_rules','numbering_counters','numbering_allocations','extension_schemas','extension_schema_versions','extension_schema_publications','product_field_values','user_views','user_view_history'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),''''))',table_name||'_tenant',table_name);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON numbering_rules,numbering_counters,extension_schemas,user_views TO gd_tenant;
GRANT SELECT,INSERT ON numbering_allocations,extension_schema_versions,extension_schema_publications,product_field_values,user_view_history TO gd_tenant;
