-- Round 5 polish 2: sales-return cash source, demo product spec and category.

ALTER TABLE money_cash DROP CONSTRAINT IF EXISTS money_cash_source_check;
ALTER TABLE money_cash ADD CONSTRAINT money_cash_source_check CHECK (source IN ('prepay', 'contract', 'shipment', 'sales_return'));

INSERT INTO product_categories(tenant_id, kind, name, sort)
SELECT t.id, 'goods', '标准件', 1
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM product_categories c
  WHERE c.tenant_id = t.id AND c.kind = 'goods' AND c.name = '标准件'
);

UPDATE products p
SET specification = CASE
      WHEN p.specification IN ('仅开发验收，不是参考系统业务数据', '第二步本地合成验收数据；不是参考站的业务记录') THEN 'Φ20×100'
      ELSE p.specification
    END,
    category_id = coalesce(
      p.category_id,
      (SELECT c.id FROM product_categories c WHERE c.tenant_id = p.tenant_id AND c.kind = 'goods' AND c.name = '标准件' LIMIT 1)
    )
WHERE p.specification IN ('仅开发验收，不是参考系统业务数据', '第二步本地合成验收数据；不是参考站的业务记录')
   OR p.category_id IS NULL;
