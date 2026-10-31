-- 加工单可以不挂合同、不挂路线/BOM（直接创建 + 从工序中添加）
ALTER TABLE work_orders ALTER COLUMN sales_order_id DROP NOT NULL, ALTER COLUMN sales_line_id DROP NOT NULL,
  ALTER COLUMN route_version_id DROP NOT NULL, ALTER COLUMN bom_version_id DROP NOT NULL, ALTER COLUMN bom_revision DROP NOT NULL;
ALTER TABLE work_orders ADD COLUMN priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('none','urgent','normal','delayed')),
  ADD COLUMN due_date date, ADD COLUMN planned_start date, ADD COLUMN planned_end date,
  ADD COLUMN note text NOT NULL DEFAULT '' CHECK (length(note) <= 255);
ALTER TABLE work_order_tasks ALTER COLUMN route_step_id DROP NOT NULL;
-- 工序与任务上的计价方式、工资单价（任务是快照，可改）
ALTER TABLE processes ADD COLUMN pricing_mode text NOT NULL DEFAULT 'piece' CHECK (pricing_mode IN ('piece','time')),
  ADD COLUMN wage_rate numeric(21,7) CHECK (wage_rate >= 0),
  ADD COLUMN inspection_scheme text NOT NULL DEFAULT 'none' CHECK (inspection_scheme IN ('full','sample','none'));
ALTER TABLE work_order_tasks ADD COLUMN pricing_mode text NOT NULL DEFAULT 'piece' CHECK (pricing_mode IN ('piece','time')),
  ADD COLUMN wage_rate numeric(21,7) CHECK (wage_rate >= 0), ADD COLUMN inspection_scheme text NOT NULL DEFAULT 'none' CHECK (inspection_scheme IN ('full','sample','none')),
  ADD COLUMN started_at timestamptz, ADD COLUMN completed_at timestamptz,
  ADD COLUMN completion_source text NOT NULL DEFAULT 'none' CHECK (completion_source IN ('none','auto','manual'));

-- 报工：起止时间、质检状态、结算状态（结算以这里为唯一来源）
ALTER TABLE production_reports ADD COLUMN started_at timestamptz, ADD COLUMN ended_at timestamptz,
  ADD COLUMN quality_status text NOT NULL DEFAULT 'none' CHECK (quality_status IN ('pending','done','none')),
  ADD COLUMN settlement_status text NOT NULL DEFAULT 'unsettled' CHECK (settlement_status IN ('unsettled','settled')),
  ADD COLUMN settled_by uuid, ADD COLUMN settled_at timestamptz,
  ADD COLUMN settlement_note text NOT NULL DEFAULT '' CHECK (length(settlement_note) <= 255),
  ADD CONSTRAINT report_settled_by_fk FOREIGN KEY (tenant_id, settled_by) REFERENCES memberships(tenant_id, user_id);
-- 不良品项非必填。010 里这条是未命名 CHECK，012 删掉了 production_reports_check 后它仍在。
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  WHERE con.conrelid = 'production_reports'::regclass
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%defect_note%'
    AND pg_get_constraintdef(con.oid) NOT ILIKE '%length(defect_note)%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE production_reports DROP CONSTRAINT %I', cname);
  END IF;
END $$;
-- 已在旧结算单里结算的报工，回填为已结算
UPDATE production_reports r
SET settlement_status = 'settled',
    settled_by = src.created_by,
    settled_at = src.created_at,
    settlement_note = CASE WHEN src.reason <> '' THEN left(src.reason, 255) ELSE r.settlement_note END
FROM (
  SELECT DISTINCT ON (e.report_id) e.report_id, s.created_by, s.created_at, s.reason
  FROM wage_events e
  JOIN wage_settlement_lines l ON l.tenant_id = e.tenant_id AND l.wage_event_id = e.id
  JOIN wage_settlements s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id AND s.state = 'approved'
  WHERE e.reversal_of IS NULL
  ORDER BY e.report_id, s.created_at DESC
) src
WHERE r.id = src.report_id;
