-- Keep executed 011 immutable; register newly supported document counters separately.
ALTER TABLE document_counters DROP CONSTRAINT document_counters_doc_type_check;
ALTER TABLE document_counters ADD CONSTRAINT document_counters_doc_type_check CHECK(doc_type IN ('SO','WO','RP','MI','FG','SH','AD','QC','PO','PR','IQC','MRP','PAYROLL','RC','PC','SP','RW'));