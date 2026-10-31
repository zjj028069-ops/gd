-- Round 12 扩展待补：销售出库、采购退货、生产出库、生产退料、销售退货。
-- 只放宽 entity CHECK。表、RLS、GRANT、policyNames 仍用 103。不改 106 正文。

DO $$
DECLARE c name;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'entity_ext_fields' AND con.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE entity_ext_fields DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'entity_ext_values' AND con.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE entity_ext_values DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE entity_ext_fields ADD CONSTRAINT entity_ext_fields_entity_check CHECK (entity IN (
  'work_order', 'linkman', 'customer',
  'supplier', 'purchase_plan', 'purchase_order',
  'purchase_stock_in', 'purchase_stock_in_line',
  'customer_contract', 'contract_quotation', 'customer_follow',
  'customer_financier', 'customer_invoice', 'selling_expense',
  'else_stock_in', 'else_stock_out',
  'stock_taking', 'stock_allocate',
  'fg_receipt', 'fg_receipt_line',
  'semi_fg',
  'sale_stock_out', 'purchase_return', 'material_issue', 'prod_return', 'sales_return',
  'craft', 'bom'
));

ALTER TABLE entity_ext_values ADD CONSTRAINT entity_ext_values_entity_check CHECK (entity IN (
  'work_order', 'linkman', 'customer',
  'supplier', 'purchase_plan', 'purchase_order',
  'purchase_stock_in', 'purchase_stock_in_line',
  'customer_contract', 'contract_quotation', 'customer_follow',
  'customer_financier', 'customer_invoice', 'selling_expense',
  'else_stock_in', 'else_stock_out',
  'stock_taking', 'stock_allocate',
  'fg_receipt', 'fg_receipt_line',
  'semi_fg',
  'sale_stock_out', 'purchase_return', 'material_issue', 'prod_return', 'sales_return',
  'craft', 'bom'
));
