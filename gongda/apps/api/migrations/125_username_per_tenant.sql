-- 用户名改为「同一企业内唯一」（以前是全平台唯一：A 企业有「111」，B 企业就建不了「111」，
-- 还会让 B 企业知道别的企业有这个用户名）。
-- 登录本来就是「企业标识 + 用户名」一起查，所以不同企业的同名账号不会混。
-- 不新增数据库角色，不改任何表的 RLS 策略。

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);

-- 往企业里加成员时检查：这个企业里不能已有同名的另一个账号
CREATE OR REPLACE FUNCTION kgd_membership_username_unique() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text;
BEGIN
  SELECT username INTO v_name FROM users WHERE id = NEW.user_id;
  -- 同一企业同一用户名串行处理，防止并发时建出两个
  PERFORM pg_advisory_xact_lock(hashtext('kgd_username:' || NEW.tenant_id::text || ':' || v_name));
  IF EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = NEW.tenant_id AND u.username = v_name AND m.user_id <> NEW.user_id
  ) THEN
    RAISE EXCEPTION '账号已存在，请更换用户名' USING ERRCODE = '23505', CONSTRAINT = 'users_username_tenant';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION kgd_membership_username_unique() FROM PUBLIC;

DROP TRIGGER IF EXISTS memberships_username_unique ON memberships;
CREATE TRIGGER memberships_username_unique BEFORE INSERT OR UPDATE OF user_id, tenant_id ON memberships
  FOR EACH ROW EXECUTE FUNCTION kgd_membership_username_unique();
