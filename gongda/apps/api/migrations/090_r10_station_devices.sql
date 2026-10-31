ALTER TABLE r8_stations ADD COLUMN IF NOT EXISTS device_ids uuid[] NOT NULL DEFAULT '{}';
