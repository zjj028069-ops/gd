-- 不良品项每项数量。默认 0，旧绑定仍然有效。
ALTER TABLE r8_report_defects
  ADD COLUMN qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (qty >= 0);
