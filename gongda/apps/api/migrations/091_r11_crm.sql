-- Round 11: 客户联系人默认、公海领用、销售价格追踪、扩展字段 entity

ALTER TABLE money_contacts ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE money_contacts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS money_contacts_one_default ON money_contacts(tenant_id, customer_id) WHERE is_default;

UPDATE money_contacts c SET is_default = true
WHERE c.id = (
  SELECT x.id FROM money_contacts x
  WHERE x.tenant_id = c.tenant_id AND x.customer_id = c.customer_id
  ORDER BY x.created_at, x.id LIMIT 1
);

CREATE TABLE customer_sea_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('放入公海','领用')),
  actor_id uuid NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE sales_price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_price numeric(20,8) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, customer_id, product_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships(tenant_id, user_id)
);

CREATE TABLE sales_price_fill_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  fill_mode text NOT NULL DEFAULT 'goods' CHECK (fill_mode IN ('track','last','goods')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE extension_schemas DROP CONSTRAINT IF EXISTS extension_schemas_entity_check;
ALTER TABLE extension_schemas ADD CONSTRAINT extension_schemas_entity_check CHECK (entity IN ('unit','product','process','route','bom','linkman'));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_sea_logs','sales_price_rules','sales_price_fill_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO gd_tenant', t);
  END LOOP;
END $$;
