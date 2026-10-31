-- Round 5 polish: ledger sequence, legacy doc_code / ledger_kind backfill.

ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS seq_no bigint;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY posted_at, id) AS n
  FROM stock_ledger
)
UPDATE stock_ledger l SET seq_no = numbered.n FROM numbered WHERE l.id = numbered.id AND l.seq_no IS NULL;

UPDATE stock_ledger l SET doc_code = mi.code FROM material_issues mi
  WHERE l.source_type = 'material_issue' AND l.source_id = mi.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = fr.code FROM fg_receipts fr
  WHERE l.source_type = 'fg_receipt' AND l.source_id = fr.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = s.code FROM shipments s
  WHERE l.source_type = 'shipment' AND l.source_id = s.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = pr.code FROM purchase_receipts pr
  WHERE l.source_type = 'purchase_receipt' AND l.source_id = pr.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = pb.code FROM purchase_return_bills pb
  WHERE l.source_type = 'purchase_return' AND l.source_id = pb.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = sa.code FROM stock_adjustments sa
  WHERE l.source_type = 'adjustment' AND l.source_id = sa.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = wb.code FROM warehouse_misc_bills wb
  WHERE l.source_type IN ('else_in','else_out','semi_fg_in','sales_return','prod_return_mat')
    AND l.source_id = wb.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = tb.code FROM stock_transfer_bills tb
  WHERE l.source_type = 'transfer_bill' AND l.source_id = tb.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = tk.code FROM stock_taking_bills tk
  WHERE l.source_type = 'stock_count' AND l.source_id = tk.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = sc.code FROM stock_counts sc
  WHERE l.source_type = 'stock_count' AND l.source_id = sc.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = wt.code FROM warehouse_transfers wt
  WHERE l.source_type IN ('transfer_out','transfer_in') AND l.source_id = wt.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger l SET doc_code = ps.code FROM production_supplements ps
  WHERE l.source_type = 'supplement_issue' AND l.source_id = ps.id AND coalesce(l.doc_code, '') = '';

UPDATE stock_ledger SET ledger_kind = '生产出库' WHERE source_type = 'material_issue' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '成品入库' WHERE source_type = 'fg_receipt' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '销售出库' WHERE source_type = 'shipment' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '采购入库' WHERE source_type = 'purchase_receipt' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '采购退货' WHERE source_type = 'purchase_return' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '盘点' WHERE source_type = 'stock_count' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '调拨出库' WHERE source_type IN ('transfer_out','transfer_bill') AND direction = 'out' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '调拨入库' WHERE source_type IN ('transfer_in','transfer_bill') AND direction = 'in' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '其他入库' WHERE source_type = 'else_in' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '其他出库' WHERE source_type = 'else_out' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '半成品入库' WHERE source_type = 'semi_fg_in' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '销售退货' WHERE source_type = 'sales_return' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '生产退料' WHERE source_type = 'prod_return_mat' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '补投出库' WHERE source_type = 'supplement_issue' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '其他入库' WHERE source_type = 'adjustment' AND direction = 'in' AND coalesce(ledger_kind, '') = '';
UPDATE stock_ledger SET ledger_kind = '其他出库' WHERE source_type = 'adjustment' AND direction = 'out' AND coalesce(ledger_kind, '') = '';

CREATE OR REPLACE FUNCTION stock_ledger_assign_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seq_no IS NULL THEN
    SELECT coalesce(max(seq_no), 0) + 1 INTO NEW.seq_no FROM stock_ledger WHERE tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_ledger_seq_tr ON stock_ledger;
CREATE TRIGGER stock_ledger_seq_tr BEFORE INSERT ON stock_ledger FOR EACH ROW EXECUTE FUNCTION stock_ledger_assign_seq();
