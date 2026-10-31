-- 第八轮维保。无付费门控。计划按最小可保存：标题、设备、内容、执行人。

CREATE TABLE r8_equip_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parent_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  sort_no integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES r8_equip_categories(tenant_id, id)
);

CREATE TABLE r8_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  machine_id uuid,
  code text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  spec text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '正常' CHECK (status IN ('正常','维修中','运行中')),
  category_id uuid,
  team_name text NOT NULL DEFAULT '默认团队',
  owner_name text NOT NULL DEFAULT '',
  shop_name text NOT NULL DEFAULT '',
  line_name text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, category_id) REFERENCES r8_equip_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_qrcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, device_id) REFERENCES r8_devices(tenant_id, id)
);

CREATE TABLE r8_maint_contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 255),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, title),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_maint_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  content_id uuid NOT NULL,
  sort_no integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  field_type text NOT NULL DEFAULT '文本' CHECK (field_type IN ('文本','数字','是否','单选')),
  required boolean NOT NULL DEFAULT false,
  description text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, content_id) REFERENCES r8_maint_contents(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE r8_maint_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  category text NOT NULL DEFAULT '',
  device_ids uuid[] NOT NULL DEFAULT '{}',
  content_ids uuid[] NOT NULL DEFAULT '{}',
  executor_name text NOT NULL DEFAULT '',
  team_name text NOT NULL DEFAULT '默认团队',
  cycle_text text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE r8_maint_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL,
  task_date date NOT NULL,
  time_span text NOT NULL DEFAULT '',
  executor_name text NOT NULL DEFAULT '',
  team_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '未开始' CHECK (status IN ('未开始','进行中','已完成','未完成')),
  device_count integer NOT NULL DEFAULT 0,
  sign_status text NOT NULL DEFAULT '无需签字',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES r8_maint_plans(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE r8_maint_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid,
  device_id uuid,
  content_id uuid,
  result text NOT NULL DEFAULT '正常' CHECK (result IN ('异常','正常','待定')),
  sign_status text NOT NULL DEFAULT '未签字' CHECK (sign_status IN ('已签字','未签字','无需签字')),
  executor_name text NOT NULL DEFAULT '',
  team_name text NOT NULL DEFAULT '',
  executed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE r8_pi_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  device_id uuid NOT NULL,
  content_id uuid,
  executor_name text NOT NULL DEFAULT '',
  team_name text NOT NULL DEFAULT '默认团队',
  enabled boolean NOT NULL DEFAULT true,
  last_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES r8_devices(tenant_id, id)
);

CREATE TABLE r8_pi_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  device_id uuid NOT NULL,
  content_name text NOT NULL DEFAULT '',
  inspector_name text NOT NULL DEFAULT '',
  team_name text NOT NULL DEFAULT '',
  normal_count integer NOT NULL DEFAULT 0,
  abnormal_count integer NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES r8_devices(tenant_id, id)
);

CREATE TABLE r8_repairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  device_id uuid NOT NULL,
  team_name text NOT NULL DEFAULT '默认团队',
  handler_name text NOT NULL DEFAULT '',
  fault_type text NOT NULL DEFAULT '',
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT '待接单' CHECK (status IN ('待派单','待接单','处理中','待审核','审核退回','已完成','暂停','取消')),
  sign_status text NOT NULL DEFAULT '未签字',
  source text NOT NULL DEFAULT '人工创建' CHECK (source IN ('维保记录','人工创建')),
  reporter_name text NOT NULL DEFAULT '',
  accepted_at timestamptz,
  finished_at timestamptz,
  result text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, device_id) REFERENCES r8_devices(tenant_id, id)
);

CREATE TABLE r8_equip_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  export_repair_image boolean NOT NULL DEFAULT false,
  export_record_image boolean NOT NULL DEFAULT false,
  scan_login boolean NOT NULL DEFAULT false,
  scan_dispatch text NOT NULL DEFAULT '报修时允许派单' CHECK (scan_dispatch IN ('报修时允许派单','不允许派单')),
  scan_repair boolean NOT NULL DEFAULT true,
  repair_audit boolean NOT NULL DEFAULT true,
  all_spares boolean NOT NULL DEFAULT false,
  hide_shop boolean NOT NULL DEFAULT false,
  status_follow_repair boolean NOT NULL DEFAULT false,
  default_result text NOT NULL DEFAULT '待定'
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['r8_equip_categories','r8_devices','r8_qrcodes','r8_maint_contents','r8_maint_items','r8_maint_plans','r8_maint_tasks','r8_maint_records','r8_pi_plans','r8_pi_records','r8_repairs','r8_equip_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
