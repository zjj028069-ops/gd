-- 主档在提交时也必须有非空、匹配且带明细的当前版本。
CREATE FUNCTION require_complete_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE complete boolean;
BEGIN
 IF TG_TABLE_NAME='process_routes' THEN
  SELECT r.current_revision>0 AND EXISTS(SELECT 1 FROM route_versions v WHERE v.tenant_id=r.tenant_id AND v.route_id=r.id AND v.id=r.current_version_id AND v.revision=r.current_revision AND EXISTS(SELECT 1 FROM route_steps s WHERE s.tenant_id=v.tenant_id AND s.version_id=v.id))
  INTO complete FROM process_routes r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.id;
 ELSE
  SELECT b.current_revision>0 AND EXISTS(SELECT 1 FROM bom_versions v WHERE v.tenant_id=b.tenant_id AND v.bom_id=b.id AND v.id=b.current_version_id AND v.revision=b.current_revision AND EXISTS(SELECT 1 FROM bom_items i WHERE i.tenant_id=v.tenant_id AND i.version_id=v.id))
  INTO complete FROM bom_definitions b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.id;
 END IF;
 IF complete IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Master record requires a complete current version' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER route_header_complete AFTER INSERT OR UPDATE ON process_routes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_header();
CREATE CONSTRAINT TRIGGER bom_header_complete AFTER INSERT OR UPDATE ON bom_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_header();
REVOKE ALL ON FUNCTION require_complete_header() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION require_complete_header() TO gd_tenant;
