-- BOM 商品选填、一名商品多个 BOM、同一商品最多一个默认

ALTER TABLE bom_definitions ALTER COLUMN parent_product_id DROP NOT NULL;
ALTER TABLE bom_definitions DROP CONSTRAINT IF EXISTS bom_definitions_tenant_id_parent_product_id_key;
DROP INDEX IF EXISTS bom_definitions_tenant_id_parent_product_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS bom_definitions_one_default
  ON bom_definitions(tenant_id, parent_product_id)
  WHERE is_default AND parent_product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION require_complete_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE complete boolean;
BEGIN
 IF TG_TABLE_NAME='process_routes' THEN
  SELECT r.current_revision>0 AND EXISTS(SELECT 1 FROM route_versions v WHERE v.tenant_id=r.tenant_id AND v.route_id=r.id AND v.id=r.current_version_id AND v.revision=r.current_revision AND EXISTS(SELECT 1 FROM route_steps s WHERE s.tenant_id=v.tenant_id AND s.version_id=v.id))
  INTO complete FROM process_routes r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.id;
 ELSE
  IF NEW.name IS NULL OR length(btrim(NEW.name)) < 1 THEN
    RAISE EXCEPTION '请填写BOM名称' USING ERRCODE='23514';
  END IF;
  SELECT b.current_revision>0 AND EXISTS(SELECT 1 FROM bom_versions v WHERE v.tenant_id=b.tenant_id AND v.bom_id=b.id AND v.id=b.current_version_id AND v.revision=b.current_revision AND EXISTS(SELECT 1 FROM bom_items i WHERE i.tenant_id=v.tenant_id AND i.version_id=v.id))
  INTO complete FROM bom_definitions b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.id;
 END IF;
 IF complete IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Master record requires a complete current version' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;

