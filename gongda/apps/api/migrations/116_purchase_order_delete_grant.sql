-- 011 只授予 gd_tenant 对采购单及明细的 SELECT/INSERT/UPDATE。
-- 修改和删除都会先 DELETE 明细，42501 permission denied 会变成 500。
GRANT DELETE ON purchase_orders, purchase_order_lines TO gd_tenant;
