-- Round 7: default document-number rules matching the counters already in use.
-- CGJH (采购计划) and 加工单号 stay on their old counters.

INSERT INTO custom_code_rules (tenant_id, name, config, sort)
SELECT t.id, v.name, v.config::jsonb, v.sort
FROM tenants t
CROSS JOIN (VALUES
  ('客户编号', '{"elements":[{"type":"fixed","text":"KH","separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":4,"seq_start":1,"show_abbrev":false}', 10),
  ('报价单号', '{"elements":[{"type":"fixed","text":"BJ","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 11),
  ('合同编号', '{"elements":[{"type":"fixed","text":"HT","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 12),
  ('供应商编号', '{"elements":[{"type":"fixed","text":"GYS","separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":4,"seq_start":1,"show_abbrev":false}', 13),
  ('采购单号', '{"elements":[{"type":"fixed","text":"CG","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 14),
  ('仓库编号', '{"elements":[{"type":"fixed","text":"WH","separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":4,"seq_start":1,"show_abbrev":false}', 20),
  ('采购入库单号', '{"elements":[{"type":"fixed","text":"CGRK","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 21),
  ('采购退货单号', '{"elements":[{"type":"fixed","text":"CGTH","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 22),
  ('销售出库单号', '{"elements":[{"type":"fixed","text":"HTCK","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 23),
  ('调拨单号', '{"elements":[{"type":"fixed","text":"KCDB","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 24),
  ('盘点单号', '{"elements":[{"type":"fixed","text":"PK","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 25),
  ('成品入库单号', '{"elements":[{"type":"fixed","text":"CPRK","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 26),
  ('生产出库单号', '{"elements":[{"type":"fixed","text":"SCCK","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 27),
  ('其他入库单号', '{"elements":[{"type":"fixed","text":"QTRK","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 28),
  ('其他出库单号', '{"elements":[{"type":"fixed","text":"QTCK","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 29),
  ('半成品入库单号', '{"elements":[{"type":"fixed","text":"BCP","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 30),
  ('销售退货单号', '{"elements":[{"type":"fixed","text":"XSTH","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 31),
  ('生产退料单号', '{"elements":[{"type":"fixed","text":"SCTL","separator":""},{"type":"date","date_format":"ymd","short_year":false,"separator":""},{"type":"empty","separator":""},{"type":"empty","separator":""}],"seq_digits":3,"seq_start":1,"show_abbrev":false}', 32)
) AS v(name, config, sort)
WHERE NOT EXISTS (SELECT 1 FROM custom_code_rules r WHERE r.tenant_id = t.id AND r.name = v.name);

INSERT INTO custom_code_counters (tenant_id, rule_id, period_key, value)
SELECT c.tenant_id, r.id, CASE WHEN c.period = '' THEN 'all' ELSE c.period END, (c.next_value - 1)::integer
FROM money_counters c
JOIN custom_code_rules r ON r.tenant_id = c.tenant_id AND r.name = CASE c.series
  WHEN 'KH' THEN '客户编号' WHEN 'BJ' THEN '报价单号' WHEN 'HT' THEN '合同编号'
  WHEN 'GYS' THEN '供应商编号' WHEN 'CG' THEN '采购单号' ELSE NULL END
WHERE c.series IN ('KH', 'BJ', 'HT', 'GYS', 'CG') AND c.next_value > 1
ON CONFLICT DO NOTHING;

INSERT INTO custom_code_counters (tenant_id, rule_id, period_key, value)
SELECT c.tenant_id, r.id, CASE WHEN c.period = '' THEN 'all' ELSE c.period END, (c.next_value - 1)::integer
FROM warehouse_counters c
JOIN custom_code_rules r ON r.tenant_id = c.tenant_id AND r.name = CASE c.series
  WHEN 'WH' THEN '仓库编号' WHEN 'CGRK' THEN '采购入库单号' WHEN 'CGTH' THEN '采购退货单号'
  WHEN 'HTCK' THEN '销售出库单号' WHEN 'KCDB' THEN '调拨单号' WHEN 'PK' THEN '盘点单号'
  WHEN 'CPRK' THEN '成品入库单号' WHEN 'SCCK' THEN '生产出库单号' WHEN 'QTRK' THEN '其他入库单号'
  WHEN 'QTCK' THEN '其他出库单号' WHEN 'BCP' THEN '半成品入库单号' WHEN 'XSTH' THEN '销售退货单号'
  WHEN 'SCTL' THEN '生产退料单号' ELSE NULL END
WHERE c.series IN ('WH','CGRK','CGTH','HTCK','KCDB','PK','CPRK','SCCK','QTRK','QTCK','BCP','XSTH','SCTL') AND c.next_value > 1
ON CONFLICT DO NOTHING;
