-- 011 只授予 gd_tenant 对 suppliers 的 SELECT/INSERT/UPDATE。
-- DELETE 在执行前就被拒绝（42501 permission denied），接口变成 500。
-- 外键不会先于表权限生效，所以这次 500 不是级联或空引用。
GRANT DELETE ON suppliers TO gd_tenant;
