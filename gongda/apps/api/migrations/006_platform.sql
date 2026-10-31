-- Stage 3: tenant organization and narrowly privileged membership administration.
CREATE ROLE gd_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO gd_platform;
GRANT SELECT(id,username,display_name,active), INSERT ON users TO gd_platform;
GRANT SELECT(id,slug,name,active), INSERT ON tenants TO gd_platform;
GRANT SELECT,INSERT,UPDATE ON memberships TO gd_platform;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_auth_read ON memberships FOR SELECT TO gd_auth USING(true);
CREATE POLICY memberships_platform_tenant ON memberships TO gd_platform USING(tenant_id::text=NULLIF(current_setting('app.tenant_id',true),'')) WITH CHECK(tenant_id::text=NULLIF(current_setting('app.tenant_id',true),''));
CREATE TABLE departments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,name text NOT NULL,
 parent_id uuid,active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),FOREIGN KEY(tenant_id,parent_id) REFERENCES departments(tenant_id,id),CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE TABLE workshops (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,name text NOT NULL,
 department_id uuid NOT NULL,active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),FOREIGN KEY(tenant_id,department_id) REFERENCES departments(tenant_id,id)
);
CREATE TABLE production_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,name text NOT NULL,
 workshop_id uuid NOT NULL,active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),FOREIGN KEY(tenant_id,workshop_id) REFERENCES workshops(tenant_id,id)
);
CREATE TABLE tenant_roles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,name text NOT NULL,permissions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(permissions)='array'),
 data_scope text NOT NULL CHECK(data_scope IN('all','department','self')),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,code)
);
CREATE TABLE tenant_member_profiles (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,display_name text NOT NULL,department_id uuid,custom_role_id uuid,version integer NOT NULL DEFAULT 1 CHECK(version>0),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,user_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),FOREIGN KEY(tenant_id,department_id) REFERENCES departments(tenant_id,id),FOREIGN KEY(tenant_id,custom_role_id) REFERENCES tenant_roles(tenant_id,id)
);
INSERT INTO tenant_member_profiles(tenant_id,user_id,display_name) SELECT m.tenant_id,m.user_id,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id;
CREATE TABLE tenant_onboard_requests (
 tenant_id uuid NOT NULL REFERENCES tenants(id),request_key text NOT NULL,new_tenant_id uuid NOT NULL REFERENCES tenants(id),slug text NOT NULL,name text NOT NULL,created_by_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,request_key)
);
ALTER TABLE products ADD COLUMN created_by_id uuid REFERENCES users(id), ADD COLUMN department_id uuid;
ALTER TABLE products ADD CONSTRAINT products_department_fk FOREIGN KEY(tenant_id,department_id) REFERENCES departments(tenant_id,id);
CREATE INDEX products_scope_owner ON products(tenant_id,created_by_id);
CREATE INDEX products_scope_department ON products(tenant_id,department_id);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['departments','workshops','production_lines','tenant_roles','tenant_member_profiles','tenant_onboard_requests'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING(tenant_id::text=NULLIF(current_setting(''app.tenant_id'',true),'''')) WITH CHECK(tenant_id::text=NULLIF(current_setting(''app.tenant_id'',true),''''))',tab||'_tenant',tab);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO gd_tenant',tab);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
-- View ownership is isolated from the migration owner and uses tenant RLS.
CREATE ROLE gd_directory NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO gd_directory;
GRANT SELECT(id,display_name,active) ON users TO gd_directory;
GRANT SELECT(tenant_id,user_id,role,active) ON memberships TO gd_directory;
CREATE POLICY memberships_directory_read ON memberships FOR SELECT TO gd_directory USING(tenant_id::text=NULLIF(current_setting('app.tenant_id',true),''));
GRANT CREATE ON SCHEMA public TO gd_directory;
ALTER VIEW tenant_team_members OWNER TO gd_directory;
REVOKE CREATE ON SCHEMA public FROM gd_directory;
