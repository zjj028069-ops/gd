-- Round 5 warehouse fixes: wh-30 stock_settings defaults and basic io type seeds.

UPDATE stock_settings
SET limit_purchase_in = false,
    limit_contract_out = false,
    limit_fg_in = true
WHERE true;

INSERT INTO stock_io_types(tenant_id, direction, name, sort)
SELECT t.id, d.dir, d.name, d.sort
FROM tenants t
CROSS JOIN (VALUES
  ('in', '普通入库', 1),
  ('in', '核验入库', 2),
  ('out', '普通出库', 1),
  ('out', '销售出库', 2)
) AS d(dir, name, sort)
WHERE NOT EXISTS (
  SELECT 1 FROM stock_io_types s
  WHERE s.tenant_id = t.id AND s.direction = d.dir AND s.name = d.name
);
