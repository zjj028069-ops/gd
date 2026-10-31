ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS schedule_no integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS work_orders_schedule_no ON work_orders (tenant_id, schedule_no);
