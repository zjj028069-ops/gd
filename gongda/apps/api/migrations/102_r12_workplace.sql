-- Round 12 P0-A1: workplace full-page layout + todo visibility prefs

ALTER TABLE workplace_configs
  ADD COLUMN IF NOT EXISTS layout jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE workplace_configs
  ADD COLUMN IF NOT EXISTS todo_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
