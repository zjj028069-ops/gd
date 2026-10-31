-- 盘点人提交并保存
ALTER TABLE stock_taking_bills ADD COLUMN IF NOT EXISTS taker_id uuid;
ALTER TABLE stock_taking_bills
  DROP CONSTRAINT IF EXISTS stock_taking_bills_taker_fk;
ALTER TABLE stock_taking_bills
  ADD CONSTRAINT stock_taking_bills_taker_fk
  FOREIGN KEY (tenant_id, taker_id) REFERENCES memberships(tenant_id, user_id);
