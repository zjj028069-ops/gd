-- Backfill the five production screens for tenants created before 050 ran.

INSERT INTO data_screens (tenant_id, menu_name, layout, module_kind, description, access_password, sort_no, preset_key)
SELECT t.id, v.menu_name, v.layout, '生产模块', '-', v.pwd, v.sort_no, v.preset_key
FROM tenants t
CROSS JOIN (VALUES
  ('生产中控大屏', '默认', '8642', 1, 'control'),
  ('车间大屏', '四模块', '6334', 2, 'workshop'),
  ('机台实时状态', '单模块', '4650', 3, 'machine'),
  ('不良品统计大屏', '左右双模块', '3496', 4, 'defect'),
  ('加工单生产进度', '单模块', '1318', 5, 'wo-progress')
) AS v(menu_name, layout, pwd, sort_no, preset_key)
WHERE NOT EXISTS (SELECT 1 FROM data_screens s WHERE s.tenant_id = t.id AND s.preset_key = v.preset_key);
