/** 原版带「管理打印模板」或「导出/打印模板」的列表。工资单页签不在列表规格里，由详情页单独挂按钮。 */
export type PrintPage = { path: string; objectKey: string; button: string };

export const PRINT_PAGES: PrintPage[] = [
  { path: '/sales_statement', objectKey: 'sales_statement', button: '管理打印模板' },
  { path: '/contract_quotation_bill/list', objectKey: 'contract_quotation', button: '管理打印模板' },
  { path: '/customer_contract/list', objectKey: 'customer_contract', button: '管理打印模板' },
  { path: '/selling_expenses/list', objectKey: 'selling_expense', button: '管理打印模板' },
  { path: '/production_project/list', objectKey: 'production_project', button: '管理打印模板' },
  { path: '/ProductionPlan/list', objectKey: 'production_plan', button: '管理打印模板' },
  { path: '/inside_produce_bill/list', objectKey: 'work_order', button: '导出/打印模板' },
  { path: '/productionTask/list', objectKey: 'production_task', button: '管理打印模板' },
  { path: '/work_repoty_record/list', objectKey: 'work_report', button: '管理打印模板' },
  { path: '/work_quality_testing/list', objectKey: 'full_inspection', button: '管理打印模板' },
  { path: '/spot_check/list', objectKey: 'spot_check', button: '管理打印模板' },
  { path: '/OutWorkOrder/list', objectKey: 'out_work_order', button: '管理打印模板' },
  { path: '/outsourcing_receipt/list', objectKey: 'outsourcing_receipt', button: '管理打印模板' },
  { path: '/Outsourcing_settlement/list', objectKey: 'outsourcing_settlement', button: '管理打印模板' },
  { path: '/inspection_record/list', objectKey: 'inspection_record', button: '管理打印模板' },
  { path: '/point_inspection_record/list', objectKey: 'point_inspection', button: '管理打印模板' },
  { path: '/device_order/list', objectKey: 'device_order', button: '管理打印模板' },
  { path: '/device/list', objectKey: 'device', button: '管理打印模板' },
  { path: '/device_qr_code/list', objectKey: 'device_qr', button: '管理打印模板' },
  { path: '/produce_plan/list', objectKey: 'purchase_plan', button: '管理打印模板' },
  { path: '/purchase_order/list', objectKey: 'purchase_order', button: '管理打印模板' },
  { path: '/material_test/list', objectKey: 'material_test', button: '管理打印模板' },
  { path: '/purchase_stock_in_bill/list', objectKey: 'purchase_stock_in', button: '管理打印模板' },
  { path: '/produce_stock_in_bill/list', objectKey: 'produce_stock_in', button: '管理打印模板' },
  { path: '/semi_finished_products_stock_in_bill/list', objectKey: 'semi_stock_in', button: '管理打印模板' },
  { path: '/produce_return_materiel_bill/list', objectKey: 'produce_return', button: '管理打印模板' },
  { path: '/salesReturnOrder/list', objectKey: 'sales_return', button: '管理打印模板' },
  { path: '/else_stock_in_bill/list', objectKey: 'else_stock_in', button: '管理打印模板' },
  { path: '/sale_stock_out_bill/list', objectKey: 'sale_stock_out', button: '管理打印模板' },
  { path: '/production_out_of_storage/list', objectKey: 'production_out', button: '管理打印模板' },
  { path: '/purchase_return_bill/list', objectKey: 'purchase_return', button: '管理打印模板' },
  { path: '/else_stock_out_bill/list', objectKey: 'else_stock_out', button: '管理打印模板' },
  { path: '/stock_allocate_bill/list', objectKey: 'stock_allocate', button: '管理打印模板' },
  { path: '/stock_taking_bill/list', objectKey: 'stock_taking', button: '管理打印模板' },
  { path: '/goods/list', objectKey: 'goods', button: '管理打印模板' },
];

function pack(value: string) {
  return value.replace(/\s+/g, '');
}

export function printEntryForPath(pathname: string, buttons: string[]) {
  const have = new Set(buttons.map(pack));
  return PRINT_PAGES.find((page) => page.path === pathname && have.has(pack(page.button))) ?? null;
}
