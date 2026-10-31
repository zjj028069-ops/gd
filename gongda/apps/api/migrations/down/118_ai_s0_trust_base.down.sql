-- 回滚 S0 审计表（手动执行；migrate 不会自动跑 down/）
-- 用法示例（admin 连接）：
--   psql "$DATABASE_URL" -f apps/api/migrations/down/118_ai_s0_trust_base.down.sql
--   DELETE FROM schema_migrations WHERE name = '118_ai_s0_trust_base.sql';

DROP POLICY IF EXISTS ai_action_audit_tenant ON ai_action_audit;
DROP TABLE IF EXISTS ai_action_audit;
