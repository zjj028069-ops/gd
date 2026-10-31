-- 加工单挂合同订单行。可空，旧销售订单路径继续只读兼容。
ALTER TABLE work_orders
  ADD COLUMN contract_id uuid,
  ADD COLUMN contract_line_id uuid;

ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_contract_fk FOREIGN KEY (tenant_id, contract_id) REFERENCES money_contracts(tenant_id, id),
  ADD CONSTRAINT work_orders_contract_line_fk FOREIGN KEY (tenant_id, contract_line_id) REFERENCES money_contract_lines(tenant_id, id);

CREATE INDEX work_orders_contract_idx ON work_orders (tenant_id, contract_id);
CREATE INDEX work_orders_contract_line_idx ON work_orders (tenant_id, contract_line_id);
