-- BOM 编号规则与原版一致：BOM + 年月日 + 4 位流水（示例 BOM202610040001）。
-- 历史行 code 默认为空串，空编号不参与唯一约束。

INSERT INTO custom_code_rules (tenant_id, name, config, sort)
SELECT t.id,
  'BOM编号',
  '{"elements":[{"type":"fixed","text":"BOM","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":4,"seq_start":1,"show_abbrev":false}'::jsonb,
  44
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_code_rules r WHERE r.tenant_id = t.id AND r.name = 'BOM编号'
);

CREATE UNIQUE INDEX IF NOT EXISTS bom_definitions_code_uidx
  ON bom_definitions (tenant_id, code)
  WHERE code <> '';
