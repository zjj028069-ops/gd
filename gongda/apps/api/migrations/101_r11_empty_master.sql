-- F12/F13：工艺路线/BOM 允许空明细建档（名称必填仍由 API/触发器保证）
-- 原 require_complete_header 要求至少一条 step/item，与 minItems:0 冲突。

CREATE OR REPLACE FUNCTION require_complete_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE complete boolean;
BEGIN
 IF TG_TABLE_NAME='process_routes' THEN
  SELECT r.current_revision>0 AND EXISTS(
    SELECT 1 FROM route_versions v
    WHERE v.tenant_id=r.tenant_id AND v.route_id=r.id AND v.id=r.current_version_id AND v.revision=r.current_revision
  )
  INTO complete FROM process_routes r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.id;
 ELSE
  IF NEW.name IS NULL OR length(btrim(NEW.name)) < 1 THEN
    RAISE EXCEPTION '请填写BOM名称' USING ERRCODE='23514';
  END IF;
  SELECT b.current_revision>0 AND EXISTS(
    SELECT 1 FROM bom_versions v
    WHERE v.tenant_id=b.tenant_id AND v.bom_id=b.id AND v.id=b.current_version_id AND v.revision=b.current_revision
  )
  INTO complete FROM bom_definitions b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.id;
 END IF;
 IF complete IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Master record requires a complete current version' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
