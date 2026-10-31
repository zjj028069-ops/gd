-- Round 10: 客户跟单、知识库、通知公告

CREATE TABLE customer_follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL,
  contact_id uuid,
  contact_name text NOT NULL DEFAULT '' CHECK (length(contact_name) <= 80),
  contact_phone text NOT NULL DEFAULT '' CHECK (length(contact_phone) <= 40),
  follow_type text NOT NULL CHECK (follow_type IN ('上门','电话','网络')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 255),
  next_at timestamptz NOT NULL,
  remind_at timestamptz NOT NULL,
  reminded boolean NOT NULL DEFAULT false,
  follower_id uuid NOT NULL,
  followed_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES money_contacts(tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, follower_id) REFERENCES memberships(tenant_id, user_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);
CREATE INDEX customer_follows_remind_idx ON customer_follows(tenant_id, follower_id, remind_at) WHERE NOT reminded;

CREATE TABLE knowledge_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  sort_no integer NOT NULL DEFAULT 1,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE UNIQUE INDEX knowledge_categories_one_default ON knowledge_categories(tenant_id) WHERE is_default;

CREATE TABLE knowledge_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  category_id uuid NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  is_public boolean NOT NULL DEFAULT false,
  body_html text NOT NULL DEFAULT '' CHECK (length(body_html) <= 200000),
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES knowledge_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  department_ids uuid[] NOT NULL DEFAULT '{}',
  user_ids uuid[] NOT NULL DEFAULT '{}',
  body_html text NOT NULL DEFAULT '' CHECK (length(body_html) <= 200000),
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE notice_reads (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  notice_id uuid NOT NULL,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, notice_id, user_id),
  FOREIGN KEY (tenant_id, notice_id) REFERENCES notices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);

-- 消息中心新增「客户跟单」「通知公告」类别；dedupe_key 保证提醒类消息只发一次
ALTER TABLE kgd_messages DROP CONSTRAINT IF EXISTS kgd_messages_kind_check;
ALTER TABLE kgd_messages ADD CONSTRAINT kgd_messages_kind_check CHECK (kind IN ('alarm','todo','notice','follow','bulletin'));
ALTER TABLE kgd_messages ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX kgd_messages_dedupe ON kgd_messages(tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

INSERT INTO knowledge_categories(tenant_id, name, sort_no, is_default)
SELECT t.id, '默认', 1, true FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM knowledge_categories c WHERE c.tenant_id = t.id AND c.is_default);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_follows','knowledge_categories','knowledge_articles','notices','notice_reads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
