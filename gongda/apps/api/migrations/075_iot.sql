-- 第八轮物联。无真实硬件，演示场景可隐藏。

CREATE TABLE r8_iot_scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  device_name text NOT NULL DEFAULT '',
  shop_name text NOT NULL DEFAULT '',
  line_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '正常' CHECK (status IN ('正常','报警中','在线','离线')),
  alarm_level text NOT NULL DEFAULT '',
  demo boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE r8_iot_sensors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scene_id uuid,
  kind text NOT NULL DEFAULT '',
  code text NOT NULL,
  gateway text NOT NULL DEFAULT '',
  bind_status text NOT NULL DEFAULT '未绑定' CHECK (bind_status IN ('已绑定','未绑定')),
  point_name text NOT NULL DEFAULT '',
  interval_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, scene_id) REFERENCES r8_iot_scenes(tenant_id, id)
);

CREATE TABLE r8_iot_alarms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scene_id uuid,
  scene_name text NOT NULL DEFAULT '',
  shop_name text NOT NULL DEFAULT '',
  line_name text NOT NULL DEFAULT '',
  auto_name text NOT NULL DEFAULT '',
  level text NOT NULL DEFAULT '',
  sensor_value text NOT NULL DEFAULT '',
  notify_names text NOT NULL DEFAULT '',
  result text NOT NULL DEFAULT '',
  cleared_by text NOT NULL DEFAULT '',
  alarmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['r8_iot_scenes','r8_iot_sensors','r8_iot_alarms'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
