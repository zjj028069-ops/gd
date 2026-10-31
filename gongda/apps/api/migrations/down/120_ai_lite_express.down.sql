-- 回滚样例3 快递约件记录表（手动执行；migrate 不会自动跑 down/）
--   先在产品内「回退该扩展」清 menu/字段，再执行本文件。
--   DELETE FROM schema_migrations WHERE name = '120_ai_lite_express.sql';

DROP POLICY IF EXISTS ai_lite_records_tenant ON ai_lite_records;
DROP TABLE IF EXISTS ai_lite_records;
