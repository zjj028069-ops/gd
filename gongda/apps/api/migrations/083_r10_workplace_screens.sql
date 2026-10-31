-- Round 10: workplace config + data screens enhancements

CREATE TABLE workplace_configs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  shortcuts jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

ALTER TABLE data_screens
  DROP CONSTRAINT IF EXISTS data_screens_access_password_check;
ALTER TABLE data_screens
  ADD CONSTRAINT data_screens_access_password_check CHECK (length(access_password) <= 16);
ALTER TABLE data_screens
  ALTER COLUMN access_password SET DEFAULT '';
UPDATE data_screens SET access_password = '' WHERE access_password IN ('8642','6334','4650','3496','1318');

ALTER TABLE data_screens ADD COLUMN IF NOT EXISTS design jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO data_screens (tenant_id, menu_name, layout, module_kind, description, access_password, sort_no, preset_key)
SELECT t.id, v.menu_name, v.layout, v.module_kind, '-', '', v.sort_no, v.preset_key
FROM tenants t
CROSS JOIN (VALUES
  ('维保大屏', '默认', '设备维保模块', 6, 'maint-default'),
  ('设备实时状态', '左右双模块', '设备维保模块', 7, 'device-live')
) AS v(menu_name, layout, module_kind, sort_no, preset_key)
WHERE NOT EXISTS (SELECT 1 FROM data_screens s WHERE s.tenant_id = t.id AND s.preset_key = v.preset_key);

ALTER TABLE workplace_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplace_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY workplace_configs_tenant ON workplace_configs TO gd_tenant
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON workplace_configs TO gd_tenant;
