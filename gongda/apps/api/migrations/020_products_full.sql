-- 商品模块与快工单对齐。016~019 留给并行的工资线，本文件从 020 起。
-- attribute 仍保留 manufactured/purchased/outsourced，供现有生产主线判断；source 才是页面上的商品来源。

ALTER TABLE products ALTER COLUMN unit_id DROP NOT NULL;
ALTER TABLE products ALTER COLUMN attribute DROP NOT NULL;
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'products'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%manufactured%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE products ADD CONSTRAINT products_attribute_check CHECK (attribute IS NULL OR attribute IN ('manufactured','purchased','outsourced'));

ALTER TABLE products
  ADD COLUMN source text,
  ADD COLUMN category_id uuid,
  ADD COLUMN sale_price numeric(24,8),
  ADD COLUMN cost_price numeric(24,8),
  ADD COLUMN outsource_price numeric(24,8),
  ADD COLUMN commission_amount numeric(24,8),
  ADD COLUMN commission_rate numeric(24,8),
  ADD COLUMN inspection_spec_id uuid,
  ADD COLUMN default_supplier_id uuid,
  ADD COLUMN stale_days numeric(24,8),
  ADD COLUMN stock_upper_warn numeric(24,8),
  ADD COLUMN stock_lower_warn numeric(24,8),
  ADD COLUMN remark text NOT NULL DEFAULT '' CHECK (length(remark) <= 255),
  ADD COLUMN intro_html text NOT NULL DEFAULT '',
  ADD COLUMN images jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE products ADD CONSTRAINT products_source_check CHECK (source IS NULL OR source IN ('自产','外协加工','外购'));
ALTER TABLE products ADD CONSTRAINT products_sale_price_check CHECK (sale_price IS NULL OR sale_price >= 0);
ALTER TABLE products ADD CONSTRAINT products_cost_price_check CHECK (cost_price IS NULL OR cost_price >= 0);
ALTER TABLE products ADD CONSTRAINT products_outsource_price_check CHECK (outsource_price IS NULL OR outsource_price >= 0);
ALTER TABLE products ADD CONSTRAINT products_commission_amount_check CHECK (commission_amount IS NULL OR commission_amount >= 0);
ALTER TABLE products ADD CONSTRAINT products_commission_rate_check CHECK (commission_rate IS NULL OR commission_rate >= 0);
ALTER TABLE products ADD CONSTRAINT products_stale_days_check CHECK (stale_days IS NULL OR stale_days >= 0);
ALTER TABLE products ADD CONSTRAINT products_stock_upper_check CHECK (stock_upper_warn IS NULL OR stock_upper_warn >= 0);
ALTER TABLE products ADD CONSTRAINT products_stock_lower_check CHECK (stock_lower_warn IS NULL OR stock_lower_warn >= 0);

CREATE FUNCTION product_source_from_attribute(attr text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE attr WHEN 'manufactured' THEN '自产' WHEN 'purchased' THEN '外购' WHEN 'outsourced' THEN '外协加工' ELSE NULL END
$$;
CREATE FUNCTION product_attribute_from_source(src text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE src WHEN '自产' THEN 'manufactured' WHEN '外购' THEN 'purchased' WHEN '外协加工' THEN 'outsourced' ELSE NULL END
$$;
UPDATE products SET source = product_source_from_attribute(attribute) WHERE source IS NULL AND attribute IS NOT NULL;

CREATE FUNCTION products_sync_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source IS NULL AND NEW.attribute IS NOT NULL THEN
    NEW.source := product_source_from_attribute(NEW.attribute);
  ELSIF NEW.attribute IS NULL AND NEW.source IS NOT NULL THEN
    NEW.attribute := product_attribute_from_source(NEW.source);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_sync_source BEFORE INSERT OR UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION products_sync_source();

CREATE TABLE product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('goods','bom')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  sort integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES product_categories(tenant_id, id)
);
CREATE UNIQUE INDEX product_categories_sibling_name ON product_categories (tenant_id, kind, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX product_categories_parent_idx ON product_categories(tenant_id, kind, parent_id, sort);

CREATE TABLE inspection_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  remark text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE goods_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  duplicate_name_check boolean NOT NULL DEFAULT true,
  auto_fill_code boolean NOT NULL DEFAULT true,
  qr_login_required boolean NOT NULL DEFAULT false
);

CREATE TABLE custom_code_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  config jsonb NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE custom_code_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rule_id uuid NOT NULL,
  period_key text NOT NULL,
  value integer NOT NULL CHECK (value > 0),
  PRIMARY KEY (tenant_id, rule_id, period_key),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES custom_code_rules(tenant_id, id)
);

CREATE TABLE goods_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  category_name text,
  sort integer NOT NULL DEFAULT 0,
  builtin boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

ALTER TABLE products
  ADD CONSTRAINT products_category_fk FOREIGN KEY (tenant_id, category_id) REFERENCES product_categories(tenant_id, id),
  ADD CONSTRAINT products_inspection_fk FOREIGN KEY (tenant_id, inspection_spec_id) REFERENCES inspection_specs(tenant_id, id),
  ADD CONSTRAINT products_supplier_fk FOREIGN KEY (tenant_id, default_supplier_id) REFERENCES suppliers(tenant_id, id);

ALTER TABLE units ADD COLUMN sort integer NOT NULL DEFAULT 0;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['product_categories','inspection_specs','goods_settings','custom_code_rules','custom_code_counters','goods_views'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO gd_tenant USING (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id::text = nullif(current_setting(''app.tenant_id'', true), ''''))', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON product_categories, inspection_specs, goods_settings, custom_code_rules, custom_code_counters, goods_views TO gd_tenant;
GRANT DELETE ON products TO gd_tenant;
GRANT DELETE ON units TO gd_tenant;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'product_field_values'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%products%' LOOP
    EXECUTE format('ALTER TABLE product_field_values DROP CONSTRAINT %I', r.conname);
  END LOOP;
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'attachments'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%products%' LOOP
    EXECUTE format('ALTER TABLE attachments DROP CONSTRAINT %I', r.conname);
  END LOOP;
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'attachments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%' LOOP
    EXECUTE format('ALTER TABLE attachments DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE product_field_values ADD FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE attachments ADD CONSTRAINT attachments_owner_present CHECK (num_nonnulls(product_id, process_id) = 1 OR (deleted_at IS NOT NULL AND product_id IS NULL));
ALTER TABLE attachments ADD FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE SET NULL (product_id);
