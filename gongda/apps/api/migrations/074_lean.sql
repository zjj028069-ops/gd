-- 第八轮精益。责任连带、日报推送、会议提醒只存设置，不发送。

CREATE TABLE r8_lean_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  block_wage boolean NOT NULL DEFAULT false,
  joint_duty boolean NOT NULL DEFAULT true,
  board_process_ids uuid[] NOT NULL DEFAULT '{}',
  board_limit integer NOT NULL DEFAULT 10 CHECK (board_limit BETWEEN 1 AND 10),
  department_ids uuid[] NOT NULL DEFAULT '{}',
  daily_push boolean NOT NULL DEFAULT false,
  daily_push_time text NOT NULL DEFAULT '',
  agenda_warn_days integer NOT NULL DEFAULT 0 CHECK (agenda_warn_days BETWEEN 0 AND 365),
  meeting_remind_minutes integer NOT NULL DEFAULT 5 CHECK (meeting_remind_minutes >= 5),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE r8_patrols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inspector_id uuid NOT NULL,
  department_name text NOT NULL DEFAULT '',
  owner_names text NOT NULL DEFAULT '',
  category text NOT NULL CHECK (category IN ('安全问题','生产问题','卫生问题','整理问题','整顿问题','清扫问题','清洁问题','素养问题')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 255),
  status text NOT NULL DEFAULT '未处理' CHECK (status IN ('未处理','待处理','已处理','驳回')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, inspector_id) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_rectify (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source text NOT NULL CHECK (source IN ('现场巡查','生产质检','售后反馈','客户投诉','设计问题','物料问题')),
  category text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '待处理' CHECK (status IN ('待处理','已处理','驳回')),
  department_name text NOT NULL DEFAULT '',
  owner_names text NOT NULL DEFAULT '',
  ref_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE r8_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  content text NOT NULL DEFAULT '' CHECK (length(content) <= 1000),
  meet_at timestamptz NOT NULL,
  form text NOT NULL CHECK (form IN ('线下会议','线上会议')),
  member_names text NOT NULL DEFAULT '',
  place text NOT NULL DEFAULT '' CHECK (length(place) <= 255),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE r8_agendas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  meeting_id uuid NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  analysis text NOT NULL DEFAULT '' CHECK (length(analysis) <= 1000),
  owner_name text NOT NULL DEFAULT '',
  due_date date,
  status text NOT NULL DEFAULT '待落地' CHECK (status IN ('待落地','已落地')),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES r8_meetings(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE r8_complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_name text NOT NULL,
  contact_name text NOT NULL,
  phone text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 1000),
  analysis text NOT NULL DEFAULT '',
  department_name text NOT NULL DEFAULT '',
  owner_names text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '待处理',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE r8_lean_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_name text NOT NULL DEFAULT '',
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT '待处理',
  handler_name text NOT NULL DEFAULT '',
  reporter_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE r8_lean_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_name text NOT NULL DEFAULT '',
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT '待处理',
  handler_name text NOT NULL DEFAULT '',
  reporter_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['r8_lean_settings','r8_patrols','r8_rectify','r8_meetings','r8_agendas','r8_complaints','r8_lean_materials','r8_lean_designs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
