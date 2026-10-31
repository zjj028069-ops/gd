-- 第八轮经营/质量/机台报表只读已有合同、库存流水、工资快照和外协结算，不新增事实表。
CREATE INDEX IF NOT EXISTS r8_reports_quality_idx ON production_reports (tenant_id, quality_status, created_at DESC);
CREATE INDEX IF NOT EXISTS r8_out_orders_status_idx ON r8_out_orders (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS r8_os_receipts_settle_idx ON r8_os_receipts (tenant_id, settle_status, settled_at DESC);
