-- Round 10: 训练中心（文档集、问答集、对话记录）。不接大模型，对话按问答集关键词匹配。

CREATE TABLE ai_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200 AND filename ~* '\.(pdf|doc|docx)$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  attachment_id uuid,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE ai_qa_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
  answer text NOT NULL CHECK (length(answer) BETWEEN 1 AND 3000),
  attachment_ids uuid[] NOT NULL DEFAULT '{}' CHECK (coalesce(array_length(attachment_ids, 1), 0) <= 9),
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE ai_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  source_qa_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id),
  FOREIGN KEY (tenant_id, source_qa_id) REFERENCES ai_qa_pairs(tenant_id, id) ON DELETE SET NULL (source_qa_id)
);
CREATE INDEX ai_chats_session_idx ON ai_chats(tenant_id, user_id, session_id, created_at);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ai_documents','ai_qa_pairs','ai_chats'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
