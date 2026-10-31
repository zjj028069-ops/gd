-- BOM 明细：入库工序、成本单价。空值表示沿用商品成本单价、不指定入库工序。
ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS inbound_process_id uuid;
ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS cost_price numeric(24,8);
ALTER TABLE bom_items DROP CONSTRAINT IF EXISTS bom_items_inbound_process_fk;
ALTER TABLE bom_items ADD CONSTRAINT bom_items_inbound_process_fk FOREIGN KEY (tenant_id, inbound_process_id) REFERENCES processes (tenant_id, id);
ALTER TABLE bom_items DROP CONSTRAINT IF EXISTS bom_items_cost_price_check;
ALTER TABLE bom_items ADD CONSTRAINT bom_items_cost_price_check CHECK (cost_price IS NULL OR cost_price >= 0);
