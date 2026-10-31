-- 追加版本必须在提交时精确成为该主档的当前版本，防止伪造历史修订。
CREATE OR REPLACE FUNCTION require_complete_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved_revision integer; saved_id uuid;
BEGIN
 IF TG_TABLE_NAME='route_versions' THEN
  SELECT current_revision,current_version_id INTO saved_revision,saved_id FROM process_routes WHERE tenant_id=NEW.tenant_id AND id=NEW.route_id;
 ELSE
  SELECT current_revision,current_version_id INTO saved_revision,saved_id FROM bom_definitions WHERE tenant_id=NEW.tenant_id AND id=NEW.bom_id;
 END IF;
 IF saved_revision IS DISTINCT FROM NEW.revision OR saved_id IS DISTINCT FROM NEW.id THEN
  RAISE EXCEPTION 'New version must be saved as current in the same transaction' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
