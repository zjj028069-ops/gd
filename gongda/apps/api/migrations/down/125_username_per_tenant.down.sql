DROP TRIGGER IF EXISTS memberships_username_unique ON memberships;
DROP FUNCTION IF EXISTS kgd_membership_username_unique();
DROP INDEX IF EXISTS users_username_idx;
-- 注意：如果已经有不同企业的同名账号，恢复全局唯一会失败，需要先改名
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
