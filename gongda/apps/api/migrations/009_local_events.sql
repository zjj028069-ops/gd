CREATE TABLE event_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),action text NOT NULL CHECK(action IN('member.created','member.updated','role.updated','field_schema.published','attachment.created')),
 recipient_ids jsonb NOT NULL CHECK(jsonb_typeof(recipient_ids)='array' AND jsonb_array_length(recipient_ids) BETWEEN 1 AND 100),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,action)
);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_tenant_id_unique UNIQUE(tenant_id,id);
CREATE TABLE local_event_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),rule_id uuid NOT NULL,source_audit_id uuid NOT NULL,action text NOT NULL,entity_id uuid NOT NULL,actor_name text NOT NULL,recipient_ids jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','delivered')),attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz,last_error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,rule_id,source_audit_id),FOREIGN KEY(tenant_id,rule_id) REFERENCES event_rules(tenant_id,id),FOREIGN KEY(tenant_id,source_audit_id) REFERENCES audit_events(tenant_id,id)
);
CREATE TABLE user_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),event_id uuid NOT NULL,user_id uuid NOT NULL,title text NOT NULL,message text NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,event_id,user_id),FOREIGN KEY(tenant_id,event_id) REFERENCES local_event_outbox(tenant_id,id),FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['event_rules','local_event_outbox','user_notifications'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING(tenant_id::text=NULLIF(current_setting(''app.tenant_id'',true),'''')) WITH CHECK(tenant_id::text=NULLIF(current_setting(''app.tenant_id'',true),''''))',tab||'_tenant',tab);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gd_tenant',tab);
 END LOOP;
END $$;
GRANT UPDATE(recipient_ids,active,version) ON event_rules TO gd_tenant;
GRANT UPDATE(state,attempts,available_at,delivered_at,last_error) ON local_event_outbox TO gd_tenant;
GRANT UPDATE(read_at) ON user_notifications TO gd_tenant;
CREATE INDEX local_event_pending ON local_event_outbox(tenant_id,state,available_at);
CREATE FUNCTION enqueue_local_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO local_event_outbox(tenant_id,rule_id,source_audit_id,action,entity_id,actor_name,recipient_ids)
 SELECT NEW.tenant_id,r.id,NEW.id,NEW.action,NEW.entity_id,NEW.actor_name,r.recipient_ids FROM event_rules r WHERE r.tenant_id=NEW.tenant_id AND r.action=NEW.action AND r.active;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enqueue_local_audit_event() FROM PUBLIC;
CREATE TRIGGER audit_local_event AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION enqueue_local_audit_event();
