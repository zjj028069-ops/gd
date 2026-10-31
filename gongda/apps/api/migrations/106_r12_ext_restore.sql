-- Round 12 扩展字段按原版恢复：在既有 entity_ext_* 上放开实体，不改 103 迁移正文。
-- 表已有 tenant_id、RLS、GRANT、policyNames（entity_ext_fields_tenant / entity_ext_values_tenant）。

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
  'craft', 'bom'
));
