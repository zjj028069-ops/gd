-- P0 壳内小工具 ToolSpec 运行时（增量；不删业务数据）
-- Spec 存 ai_ext_apps.spec（kind=shell_tool / tool / placement）；无新业务表。
-- 本 migration 仅登记能力版本，便于 schema_migrations 追溯。

DO $$ BEGIN
  -- no-op marker：确保可重复执行
  PERFORM 1;
END $$;
