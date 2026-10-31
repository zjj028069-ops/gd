-- 回滚 S3 词典与扩展应用配置表（手动执行；migrate 不会自动跑 down/）
-- 不触碰加工单/客户/物料等业务表。扩展字段若已启用，回滚本表前应先在产品内「回退该扩展」。
--   psql "$DATABASE_URL" -f apps/api/migrations/down/119_ai_s3_glossary_extapp.down.sql
--   DELETE FROM schema_migrations WHERE name = '119_ai_s3_glossary_extapp.sql';

DROP POLICY IF EXISTS ai_ext_apps_tenant ON ai_ext_apps;
DROP TABLE IF EXISTS ai_ext_apps;
DROP POLICY IF EXISTS ai_factory_glossary_tenant ON ai_factory_glossary;
DROP TABLE IF EXISTS ai_factory_glossary;
