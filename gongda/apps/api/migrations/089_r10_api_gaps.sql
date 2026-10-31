-- Round 10: 前端按钮依赖的字段与配置（089，不改动 001～088）

ALTER TABLE processes
  ADD COLUMN IF NOT EXISTS shop_id uuid,
  ADD COLUMN IF NOT EXISTS line_id uuid,
  ADD COLUMN IF NOT EXISTS report_unit_id uuid,
  ADD COLUMN IF NOT EXISTS unit_ratio numeric(20,6),
  ADD COLUMN IF NOT EXISTS need_outsource boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS task_timing boolean NOT NULL DEFAULT false;

ALTER TABLE bom_definitions
  ADD COLUMN IF NOT EXISTS code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';

ALTER TABLE work_order_tasks
  ADD COLUMN IF NOT EXISTS planned_start date,
  ADD COLUMN IF NOT EXISTS planned_end date,
  ADD COLUMN IF NOT EXISTS dispatch_operator_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS task_kind text NOT NULL DEFAULT 'production'
    CHECK (task_kind IN ('production','outsource','rework'));

ALTER TABLE production_reports
  ADD COLUMN IF NOT EXISTS report_type text NOT NULL DEFAULT 'production'
    CHECK (report_type IN ('production','rework'));

ALTER TABLE tenant_report_prefs
  ADD COLUMN IF NOT EXISTS batch_report_form jsonb NOT NULL DEFAULT '{"pc":[],"mobile":[]}'::jsonb;
