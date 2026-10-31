-- 工作站报表要展示投诉产品、现场照片和会议关联问题。已有行用空串补齐。

ALTER TABLE r8_complaints
  ADD COLUMN product_name text NOT NULL DEFAULT '',
  ADD COLUMN photos text NOT NULL DEFAULT '';

ALTER TABLE r8_lean_materials
  ADD COLUMN photos text NOT NULL DEFAULT '',
  ADD COLUMN association text NOT NULL DEFAULT '';

ALTER TABLE r8_lean_designs
  ADD COLUMN photos text NOT NULL DEFAULT '',
  ADD COLUMN association text NOT NULL DEFAULT '';

ALTER TABLE r8_meetings
  ADD COLUMN related text NOT NULL DEFAULT '' CHECK (length(related) <= 255);
