ALTER TABLE units ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version>0),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE units ADD CHECK (length(code) BETWEEN 1 AND 64), ADD CHECK (length(name) BETWEEN 1 AND 200);
GRANT INSERT,UPDATE ON units TO gd_tenant;

CREATE VIEW tenant_team_members WITH (security_barrier=true) AS
SELECT u.id,u.display_name,m.role FROM memberships m JOIN users u ON u.id=m.user_id
WHERE m.tenant_id::text=nullif(current_setting('app.tenant_id',true),'') AND m.active AND u.active;
REVOKE ALL ON tenant_team_members FROM PUBLIC;
GRANT SELECT ON tenant_team_members TO gd_tenant;

CREATE TABLE processes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 64),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
 standard_minutes numeric(20,6) NOT NULL DEFAULT 0 CHECK(standard_minutes>=0),
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,code)
);
CREATE TABLE process_reporters (
 tenant_id uuid NOT NULL,process_id uuid NOT NULL,user_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,process_id,user_id),
 FOREIGN KEY(tenant_id,process_id) REFERENCES processes(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE process_routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 64),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 current_version_id uuid,current_revision integer NOT NULL DEFAULT 0 CHECK(current_revision>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,code)
);
CREATE TABLE route_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,route_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
 name_snapshot text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,route_id) REFERENCES process_routes(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,route_id,id),UNIQUE(tenant_id,route_id,revision)
);
ALTER TABLE process_routes ADD FOREIGN KEY(tenant_id,id,current_version_id) REFERENCES route_versions(tenant_id,route_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE route_steps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,version_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),process_id uuid NOT NULL,auto_inbound boolean NOT NULL DEFAULT false,
 process_snapshot jsonb NOT NULL,
 FOREIGN KEY(tenant_id,version_id) REFERENCES route_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,process_id) REFERENCES processes(tenant_id,id),UNIQUE(tenant_id,version_id,sequence)
);
CREATE TABLE bom_definitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,parent_product_id uuid NOT NULL,
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 current_version_id uuid,current_revision integer NOT NULL DEFAULT 0 CHECK(current_revision>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,parent_product_id) REFERENCES products(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,parent_product_id)
);
CREATE TABLE bom_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,bom_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
 parent_snapshot jsonb NOT NULL,route_version_id uuid,output_quantity numeric(20,6) NOT NULL DEFAULT 1 CHECK(output_quantity>0),
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,bom_id) REFERENCES bom_definitions(tenant_id,id),
 FOREIGN KEY(tenant_id,route_version_id) REFERENCES route_versions(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,bom_id,id),UNIQUE(tenant_id,bom_id,revision)
);
ALTER TABLE bom_definitions ADD FOREIGN KEY(tenant_id,id,current_version_id) REFERENCES bom_versions(tenant_id,bom_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE bom_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,version_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),component_product_id uuid NOT NULL,unit_id uuid NOT NULL,
 quantity numeric(20,6) NOT NULL CHECK(quantity>0),loss_rate numeric(7,6) NOT NULL DEFAULT 0 CHECK(loss_rate BETWEEN 0 AND 1),
 feeding_process_id uuid,auto_issue boolean NOT NULL DEFAULT false,component_bom_version_id uuid,
 component_snapshot jsonb NOT NULL,feeding_snapshot jsonb,
 FOREIGN KEY(tenant_id,version_id) REFERENCES bom_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,component_product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES units(tenant_id,id),
 FOREIGN KEY(tenant_id,feeding_process_id) REFERENCES processes(tenant_id,id),
 FOREIGN KEY(tenant_id,component_bom_version_id) REFERENCES bom_versions(tenant_id,id),
 CHECK(NOT auto_issue OR feeding_process_id IS NOT NULL),UNIQUE(tenant_id,version_id,sequence)
);
CREATE INDEX route_steps_version_idx ON route_steps(tenant_id,version_id);
CREATE INDEX bom_items_version_idx ON bom_items(tenant_id,version_id);
CREATE INDEX process_reporters_process_idx ON process_reporters(tenant_id,process_id);
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['processes','process_reporters','process_routes','route_versions','route_steps','bom_definitions','bom_versions','bom_items'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'',true),''''))',table_name||'_tenant',table_name);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON processes,process_routes,bom_definitions TO gd_tenant;
GRANT SELECT,INSERT,DELETE ON process_reporters TO gd_tenant;
GRANT SELECT,INSERT ON route_versions,route_steps,bom_versions,bom_items TO gd_tenant;
