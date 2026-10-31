-- 采购单供应商改选填（原版无 *）
ALTER TABLE purchase_orders ALTER COLUMN supplier_id DROP NOT NULL;
