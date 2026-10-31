-- 第八轮机台与工作站。同步创建设备先记布尔，设备行在维保表就绪后由接口写入。

CREATE TABLE r8_shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parent_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  sort_no integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES r8_shops(tenant_id, id)
);

CREATE TABLE r8_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  sort_no integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE r8_machine_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parent_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  sort_no integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES r8_machine_categories(tenant_id, id)
);

CREATE TABLE r8_machine_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (name IN ('正常','维修中','运行中')),
  kind text NOT NULL CHECK (kind IN ('完好','故障')),
  color text NOT NULL DEFAULT '',
  sort_no integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE r8_machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  spec text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('正常','维修中','运行中')),
  category_id uuid NOT NULL,
  sync_device boolean NOT NULL DEFAULT false,
  shop_id uuid,
  line_id uuid,
  hours_per_day numeric(8,2) NOT NULL DEFAULT 0,
  std_seconds integer NOT NULL DEFAULT 0,
  std_output numeric(20,6) NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, category_id) REFERENCES r8_machine_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, shop_id) REFERENCES r8_shops(tenant_id, id),
  FOREIGN KEY (tenant_id, line_id) REFERENCES r8_lines(tenant_id, id)
);

ALTER TABLE production_reports ADD COLUMN machine_id uuid;
ALTER TABLE production_reports
  ADD CONSTRAINT report_machine_fk FOREIGN KEY (tenant_id, machine_id) REFERENCES r8_machines(tenant_id, id);

CREATE TABLE r8_station_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  enterprise_code text NOT NULL DEFAULT '',
  password text NOT NULL DEFAULT ''
);

CREATE TABLE r8_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  shop_id uuid,
  line_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, shop_id) REFERENCES r8_shops(tenant_id, id),
  FOREIGN KEY (tenant_id, line_id) REFERENCES r8_lines(tenant_id, id)
);

CREATE TABLE r8_station_users (
  tenant_id uuid NOT NULL,
  station_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, station_id, user_id),
  FOREIGN KEY (tenant_id, station_id) REFERENCES r8_stations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['r8_shops','r8_lines','r8_machine_categories','r8_machine_statuses','r8_machines','r8_station_settings','r8_stations','r8_station_users'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
