-- Backfill the five production screens (names match 051) for tenants created after 050/051,
-- drop the leftover menu name 大屏幕, and seed the same five rows for every new tenant.
-- Re-running db:migrate applies this file once; calling ensure_data_screen_presets is idempotent.

DELETE FROM data_screens a
WHERE a.preset_key <> ''
  AND a.id <> (
    SELECT b.id FROM data_screens b
    WHERE b.tenant_id = a.tenant_id AND b.preset_key = a.preset_key
    ORDER BY b.created_at, b.id
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS data_screens_tenant_preset_uidx
  ON data_screens (tenant_id, preset_key)
  WHERE preset_key <> '';

CREATE OR REPLACE FUNCTION ensure_data_screen_presets(p_tenant uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE data_screens s
  SET preset_key = v.preset_key,
      sort_no = CASE WHEN s.sort_no = 0 THEN v.sort_no ELSE s.sort_no END,
      updated_at = now()
  FROM (VALUES
    ('生产中控大屏', 1, 'control'),
    ('车间大屏', 2, 'workshop'),
    ('机台实时状态', 3, 'machine'),
    ('不良品统计大屏', 4, 'defect'),
    ('加工单生产进度', 5, 'wo-progress')
  ) AS v(menu_name, sort_no, preset_key)
  WHERE s.tenant_id = p_tenant
    AND btrim(s.menu_name) = v.menu_name
    AND s.preset_key = ''
    AND s.id = (
      SELECT s2.id FROM data_screens s2
      WHERE s2.tenant_id = p_tenant AND btrim(s2.menu_name) = v.menu_name AND s2.preset_key = ''
      ORDER BY s2.created_at, s2.id
      LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM data_screens x WHERE x.tenant_id = p_tenant AND x.preset_key = v.preset_key
    );

  INSERT INTO data_screens (tenant_id, menu_name, layout, module_kind, description, access_password, sort_no, preset_key)
  SELECT p_tenant, v.menu_name, v.layout, '生产模块', '-', '', v.sort_no, v.preset_key
  FROM (VALUES
    ('生产中控大屏', '默认', 1, 'control'),
    ('车间大屏', '四模块', 2, 'workshop'),
    ('机台实时状态', '单模块', 3, 'machine'),
    ('不良品统计大屏', '左右双模块', 4, 'defect'),
    ('加工单生产进度', '单模块', 5, 'wo-progress')
  ) AS v(menu_name, layout, sort_no, preset_key)
  ON CONFLICT (tenant_id, preset_key) WHERE preset_key <> ''
  DO UPDATE SET menu_name = EXCLUDED.menu_name, updated_at = now()
  WHERE data_screens.menu_name IS DISTINCT FROM EXCLUDED.menu_name;

  DELETE FROM data_screens s
  WHERE s.tenant_id = p_tenant
    AND s.preset_key = ''
    AND btrim(s.menu_name) IN ('生产中控大屏', '车间大屏', '机台实时状态', '不良品统计大屏', '加工单生产进度')
    AND EXISTS (
      SELECT 1 FROM data_screens k
      WHERE k.tenant_id = s.tenant_id AND k.preset_key <> '' AND btrim(k.menu_name) = btrim(s.menu_name)
    );

  DELETE FROM data_screens
  WHERE tenant_id = p_tenant AND btrim(menu_name) = '大屏幕';
END;
$$;

CREATE OR REPLACE FUNCTION tenants_seed_data_screens() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM ensure_data_screen_presets(NEW.id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION ensure_data_screen_presets(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenants_seed_data_screens() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_data_screen_presets(uuid) TO gd_platform;
GRANT EXECUTE ON FUNCTION tenants_seed_data_screens() TO gd_platform;

DROP TRIGGER IF EXISTS tenants_seed_data_screens ON tenants;
CREATE TRIGGER tenants_seed_data_screens
  AFTER INSERT ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION tenants_seed_data_screens();

SELECT ensure_data_screen_presets(id) FROM tenants;
