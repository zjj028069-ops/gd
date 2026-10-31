-- Round 7: permission points, org teams, messages, operation logs, enterprise settings.

ALTER TABLE tenant_roles ADD COLUMN kgd_points jsonb;
ALTER TABLE tenant_roles ADD COLUMN point_scopes jsonb;
ALTER TABLE tenant_member_profiles ADD COLUMN phone text NOT NULL DEFAULT '';
ALTER TABLE tenant_member_profiles ADD COLUMN is_virtual boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_member_profiles ADD COLUMN face_avatar_id uuid;
ALTER TABLE tenant_member_profiles ADD COLUMN user_points jsonb;
ALTER TABLE tenant_member_profiles ADD COLUMN user_point_scopes jsonb;

DO $$
DECLARE c name;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'attachments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%num_nonnulls%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE attachments DROP CONSTRAINT %I', c);
  END IF;
END $$;
ALTER TABLE attachments ADD CONSTRAINT attachments_owner_optional CHECK (num_nonnulls(product_id, process_id) <= 1);

CREATE TABLE kgd_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('alarm', 'todo', 'notice')),
  title text NOT NULL,
  body text NOT NULL,
  object_type text NOT NULL DEFAULT '',
  object_id uuid,
  doc_code text NOT NULL DEFAULT '',
  link_path text NOT NULL DEFAULT '',
  level_no integer,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE kgd_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parent_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  leader_id uuid,
  intro text NOT NULL DEFAULT '' CHECK (length(intro) <= 255),
  regions jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES kgd_teams(tenant_id, id),
  FOREIGN KEY (tenant_id, leader_id) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE kgd_team_members (
  tenant_id uuid NOT NULL,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, user_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES kgd_teams(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE kgd_operation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  action text NOT NULL,
  content text NOT NULL,
  client_name text NOT NULL DEFAULT '企业web端',
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE kgd_enterprise_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  name text NOT NULL DEFAULT '',
  produce_module boolean NOT NULL DEFAULT true,
  aftersales_module boolean NOT NULL DEFAULT false,
  device_module boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION kgd_set_password(uid uuid, hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE users SET password_hash = hash WHERE id = uid;
$$;
REVOKE ALL ON FUNCTION kgd_set_password(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kgd_set_password(uuid, text) TO gd_platform;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kgd_messages', 'kgd_teams', 'kgd_team_members', 'kgd_operation_logs', 'kgd_enterprise_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
