-- v1.0.51 hide-tutorial-default-modules
-- 三模块默认开通；现网已有企业一并打开（不重建库、不改密码）
ALTER TABLE kgd_enterprise_settings
  ALTER COLUMN aftersales_module SET DEFAULT true,
  ALTER COLUMN produce_module SET DEFAULT true,
  ALTER COLUMN device_module SET DEFAULT true;

UPDATE kgd_enterprise_settings
SET aftersales_module = true,
    produce_module = true,
    device_module = true,
    updated_at = now()
WHERE aftersales_module IS DISTINCT FROM true
   OR produce_module IS DISTINCT FROM true
   OR device_module IS DISTINCT FROM true;
