-- Round 12 P2-B3: expand list_views for edit wizard
ALTER TABLE list_views
  ADD COLUMN IF NOT EXISTS icon text,
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS field_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS filters jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS default_sort jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE list_views ADD CONSTRAINT list_views_scope_check
    CHECK (scope IN ('personal', 'team', 'all'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
