-- 平台管理后台：独立的平台账号、会话、操作日志（与企业账号完全分开）
-- 安全要点：
--  * 三张表不对任何运行角色开放写业务数据的权限；只给登录角色 gd_auth 最小权限
--  * 平台日志只能追加（不授予 UPDATE/DELETE）
--  * 不新增数据库角色，不改动任何企业表的 RLS 策略（启动自检基线不变）
--  * 企业的启停只通过受控函数改 tenants.active 这一列

CREATE TABLE platform_operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9_.@-]{3,80}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE platform_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  csrf_token text NOT NULL,
  operator_id uuid NOT NULL REFERENCES platform_operators(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_sessions_expiry_idx ON platform_sessions(expires_at);

CREATE TABLE platform_audit (
  id bigserial PRIMARY KEY,
  operator_id uuid REFERENCES platform_operators(id),
  operator_name text NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 60),
  tenant_id uuid REFERENCES tenants(id),
  tenant_name text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_created_idx ON platform_audit(created_at DESC);
CREATE INDEX platform_audit_tenant_idx ON platform_audit(tenant_id, created_at DESC);

REVOKE ALL ON platform_operators, platform_sessions, platform_audit FROM PUBLIC;
REVOKE ALL ON SEQUENCE platform_audit_id_seq FROM PUBLIC;
GRANT SELECT ON platform_operators TO gd_auth;
GRANT UPDATE(last_login_at) ON platform_operators TO gd_auth;
GRANT SELECT, INSERT, DELETE ON platform_sessions TO gd_auth;
GRANT SELECT, INSERT ON platform_audit TO gd_auth;
GRANT USAGE ON SEQUENCE platform_audit_id_seq TO gd_auth;

-- 启用/停用企业：只改 active 一列；返回是否找到该企业
CREATE OR REPLACE FUNCTION platform_set_tenant_active(p_tenant uuid, p_active boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE tenants SET active = p_active WHERE id = p_tenant;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION platform_set_tenant_active(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_set_tenant_active(uuid, boolean) TO gd_auth;
