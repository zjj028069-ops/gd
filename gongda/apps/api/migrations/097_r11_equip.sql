ALTER TABLE r8_maint_plans ADD COLUMN IF NOT EXISTS plan_kind text NOT NULL DEFAULT '循环计划';
ALTER TABLE r8_maint_plans ADD COLUMN IF NOT EXISTS advanced jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE r8_maint_tasks ADD COLUMN IF NOT EXISTS time_span text NOT NULL DEFAULT '';
ALTER TABLE r8_devices ADD COLUMN IF NOT EXISTS materials jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE r8_devices ADD COLUMN IF NOT EXISTS status_color text NOT NULL DEFAULT '';
ALTER TABLE r8_devices ADD COLUMN IF NOT EXISTS status_kind text NOT NULL DEFAULT '';
ALTER TABLE r8_repairs ADD COLUMN IF NOT EXISTS assigned_to text NOT NULL DEFAULT '';
ALTER TABLE r8_repairs ADD COLUMN IF NOT EXISTS audit_status text NOT NULL DEFAULT '';
ALTER TABLE r8_repairs ADD COLUMN IF NOT EXISTS overdue boolean NOT NULL DEFAULT false;
ALTER TABLE r8_equip_settings ADD COLUMN IF NOT EXISTS alarm_notify jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE r8_qrcode_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  qty integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

DO $$ BEGIN
  ALTER TABLE r8_qrcode_batches ENABLE ROW LEVEL SECURITY;
  ALTER TABLE r8_qrcode_batches FORCE ROW LEVEL SECURITY;
  CREATE POLICY r8_qrcode_batches_tenant ON r8_qrcode_batches TO gd_tenant
    USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
  GRANT SELECT, INSERT, UPDATE, DELETE ON r8_qrcode_batches TO gd_tenant;
END $$;
