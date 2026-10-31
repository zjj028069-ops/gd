-- 保存新版本的事务先写版本及子项，再推进主档当前版本。
-- 已成为当前/历史的版本不能再追加子项；每个新版本须在同一事务完成。
CREATE FUNCTION prevent_saved_version_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved_revision integer; target_revision integer;
BEGIN
 IF TG_TABLE_NAME='route_steps' THEN
  SELECT r.current_revision,v.revision INTO saved_revision,target_revision
  FROM route_versions v JOIN process_routes r ON r.tenant_id=v.tenant_id AND r.id=v.route_id
  WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.version_id;
 ELSE
  SELECT b.current_revision,v.revision INTO saved_revision,target_revision
  FROM bom_versions v JOIN bom_definitions b ON b.tenant_id=v.tenant_id AND b.id=v.bom_id
  WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.version_id;
 END IF;
 IF saved_revision>=target_revision THEN
  RAISE EXCEPTION 'Saved version contents are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER route_steps_no_append BEFORE INSERT ON route_steps FOR EACH ROW EXECUTE FUNCTION prevent_saved_version_append();
CREATE TRIGGER bom_items_no_append BEFORE INSERT ON bom_items FOR EACH ROW EXECUTE FUNCTION prevent_saved_version_append();

CREATE FUNCTION require_complete_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved_revision integer;
BEGIN
 IF TG_TABLE_NAME='route_versions' THEN
  SELECT current_revision INTO saved_revision FROM process_routes WHERE tenant_id=NEW.tenant_id AND id=NEW.route_id;
 ELSE
  SELECT current_revision INTO saved_revision FROM bom_definitions WHERE tenant_id=NEW.tenant_id AND id=NEW.bom_id;
 END IF;
 IF saved_revision IS NULL OR saved_revision<NEW.revision THEN
  RAISE EXCEPTION 'New version must be saved as current in the same transaction' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER route_version_complete AFTER INSERT ON route_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_version();
CREATE CONSTRAINT TRIGGER bom_version_complete AFTER INSERT ON bom_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_version();

CREATE FUNCTION protect_version_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_revision integer;
BEGIN
 IF NEW.current_revision<OLD.current_revision OR (NEW.current_revision=OLD.current_revision AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) THEN
  RAISE EXCEPTION 'Current version cannot move backwards or change without a new revision' USING ERRCODE='23514';
 END IF;
 IF NEW.current_revision>OLD.current_revision THEN
  IF TG_TABLE_NAME='process_routes' THEN
   SELECT revision INTO actual_revision FROM route_versions WHERE tenant_id=NEW.tenant_id AND route_id=NEW.id AND id=NEW.current_version_id;
  ELSE
   SELECT revision INTO actual_revision FROM bom_versions WHERE tenant_id=NEW.tenant_id AND bom_id=NEW.id AND id=NEW.current_version_id;
  END IF;
  IF actual_revision IS DISTINCT FROM NEW.current_revision THEN
   RAISE EXCEPTION 'Current version pointer and revision do not match' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER route_pointer_monotonic BEFORE UPDATE ON process_routes FOR EACH ROW EXECUTE FUNCTION protect_version_pointer();
CREATE TRIGGER bom_pointer_monotonic BEFORE UPDATE ON bom_definitions FOR EACH ROW EXECUTE FUNCTION protect_version_pointer();
REVOKE ALL ON FUNCTION prevent_saved_version_append(),require_complete_version(),protect_version_pointer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prevent_saved_version_append(),require_complete_version(),protect_version_pointer() TO gd_tenant;
