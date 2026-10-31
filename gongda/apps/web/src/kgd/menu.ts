export type MenuStatus = 'rebuild' | 'legacy';
export type LegacyKey = 'expenses' | 'stock-desk' | 'warehouse-ops' | 'business' | 'notifications' | 'platform' | 'audit' | 'configuration' | 'units';

export type MenuNode = {
  key: string;
  label: string;
  path?: string;
  status?: MenuStatus;
  permission?: string | string[];
  allScope?: boolean;
  point?: string;
  reference?: string;
  legacy?: LegacyKey;
  screenId?: string;
  iconName?: 'gauge' | 'screen';
  moduleKind?: string;
  children?: MenuNode[];
};

export type PrimaryMenu = {
  key: string;
  label: string;
  icon: string;
  path?: string;
  status?: MenuStatus;
  permission?: string | string[];
  allScope?: boolean;
  point?: string;
  reference?: string;
  children?: MenuNode[];
};

const production = 'production.read';
const master = 'master.read';
const inventory = 'inventory.read';
const sales = 'sales.read';
const procurement = 'procurement.read';

export const primaryMenus: PrimaryMenu[] = [
  { key: 'workplace', label: '工作台', icon: 'appstore', children: [
    { key: 'workplace-home', label: '工作台', path: '/staging/area', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-1.md 第 1 节' },
  ] },
  { key: 'screen', label: '数据大屏', icon: 'dashboard', point: 'menu.screen.view', children: [
    { key: 'screen-manage', label: '大屏管理', path: '/screen_management/list', iconName: 'gauge', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-1.md 第 8 节', point: 'menu.screen.view' },
  ] },
  { key: 'report', label: '报表中心', icon: 'bar', point: 'menu.report.view', children: [
    { key: 'report-produce', label: '生产管理', point: 'menu.report.view', children: [
      { key: 'report-machine', label: '机台报表', path: '/drilling_crew_statement/list', status: 'rebuild', reference: 'docs/kgd-reference/progress/report-dashboard-capture.md 第 1.2 节', point: 'menu.report.view' },
      { key: 'report-output', label: '产量报表', path: '/output_statistics_report', status: 'rebuild', reference: 'docs/kgd-reference/progress/report-dashboard-capture.md 第 1.1 节', point: 'menu.report.view' },
      { key: 'report-wip', label: '在制品报表', path: '/articles_being_processed_report', status: 'rebuild', reference: 'docs/kgd-reference/progress/report-dashboard-capture.md 第 1.3 节', point: 'menu.report.view' },
      { key: 'report-clock', label: '工序打卡计时', path: '/clock_in_report', status: 'rebuild', reference: 'docs/kgd-reference/progress/report-dashboard-capture.md 第 1.4 节', point: 'menu.report.view' },
    ] },
    { key: 'report-quality', label: '质量管理', point: 'menu.report.view', children: [
      { key: 'report-defect-trend', label: '不良品趋势分析', path: '/waste_analysis', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md', point: 'menu.report.view' },
      { key: 'report-pareto', label: '不良品柏拉图', path: '/waste_key_analysis', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md', point: 'menu.report.view' },
      { key: 'report-defect-detail', label: '不良品项明细', path: '/waste_detail', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md', point: 'menu.report.view' },
      { key: 'report-iqc', label: '采购检验分析', path: '/material_test_report', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
      { key: 'report-sample', label: '生产抽检分析', path: '/spot_check_report', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
      { key: 'report-scrap', label: '报废返工统计', path: '/scrap_rework_statistics_report', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
    ] },
    { key: 'report-maint', label: '维保管理', point: 'menu.report.view', children: [
      { key: 'report-maint-analysis', label: '设备维修分析', path: '/device_maintenance_analysis', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-equip-report-capture.md', point: 'menu.report.view' },
      { key: 'report-maint-workload', label: '维修工作量统计', path: '/maintenance_workload_statistics', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-equip-report-capture.md', point: 'menu.report.view' },
      { key: 'report-maint-plan', label: '维保计划统计', path: '/maintenance_plan_statistics', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-equip-report-capture.md', point: 'menu.report.view' },
    ] },
    { key: 'report-biz', label: '经营报表', point: 'menu.report.view', children: [
      { key: 'report-purchase', label: '采购对账单', path: '/purchase_statement', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
      { key: 'report-sales', label: '销售对账单', path: '/sales_statement', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
      { key: 'report-contract', label: '合同报表', path: '/contract_report', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
      { key: 'report-cost', label: '成本报表', path: '/produce_bill_cost', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-equip-report-capture.md', point: 'menu.report.view' },
      { key: 'report-ai-stock', label: 'AI库存监控', path: '/ai_inventory/list', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
      { key: 'report-inventory', label: '进销存汇总', path: '/inventory_summary', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
    ] },
    { key: 'report-hr', label: '人力薪酬', point: 'menu.report.view', children: [
      { key: 'report-wage', label: '生产工资报表', path: '/payroll_statement/list', status: 'rebuild', permission: 'payroll.read', allScope: true, point: 'menu.report.view' },
    ] },
    { key: 'report-smart', label: '智能报表', path: '/smart/form_core_list', status: 'rebuild', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 11 节', point: 'menu.report.view' },
  ] },
  { key: 'customer', label: '客户管理', icon: 'team', point: 'customer.list.view', children: [
    { key: 'customer-list', label: '客户管理', path: '/customer/list', status: 'rebuild', permission: sales, allScope: true },
    { key: 'linkman', label: '客户联系人', path: '/linkman/list', status: 'rebuild', permission: sales, allScope: true, reference: 'docs/kgd-reference/round11/menu-capture-2026-10-06.md 第 1 节' },
    { key: 'follow', label: '客户跟单', path: '/follow/list', status: 'rebuild', permission: sales, allScope: true, reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 1 节' },
    { key: 'quote', label: '合同报价单', path: '/contract_quotation_bill/list', status: 'rebuild', permission: sales, allScope: true },
    { key: 'contract', label: '合同订单', path: '/customer_contract/list', status: 'rebuild', permission: sales, allScope: true },
    { key: 'cash', label: '收支记录', path: '/customer_financier/list', status: 'rebuild', permission: 'finance.read', allScope: true },
    { key: 'invoice', label: '发票管理', path: '/customer_invoice/list', status: 'rebuild', permission: sales, allScope: true },
    { key: 'sales-fee', label: '销售费用', path: '/selling_expenses/list', status: 'rebuild', permission: sales, allScope: true },
    { key: 'customer-sea', label: '客户公海', path: '/customer_sea/list', status: 'rebuild', permission: sales, allScope: true, reference: 'docs/kgd-reference/round11/menu-capture-2026-10-06.md 第 2 节' },
    { key: 'customer-setting', label: '客户设置', point: 'customer.list.view', children: [
      { key: 'customer-base', label: '基础设置', path: '/customer/setting/base_setting', status: 'rebuild', permission: sales, allScope: true },
      { key: 'customer-audit', label: '审核设置', path: '/customer/setting/audit_setting', status: 'rebuild', permission: sales, allScope: true },
      { key: 'sales-price', label: '销售价格追踪', path: '/customer/salesPriceTrack', status: 'rebuild', permission: sales, allScope: true, reference: 'docs/kgd-reference/round11/menu-capture-2026-10-06.md 第 3 节' },
    ] },
  ] },
  { key: 'lean', label: '精益生产', icon: 'thunder', point: 'menu.lean.view', children: [
    { key: 'lean-station', label: '精益生产工作站', path: '/LeanProductionReportChart/ReportChart', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md' },
    { key: 'lean-rectify', label: '整改中心', path: '/lean_production_todo/list', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md' },
    { key: 'lean-meeting', label: '精益会议', path: '/meeting/list', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md' },
    { key: 'lean-todo', label: '会议待办', path: '/meetingTodo/list', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md' },
    { key: 'lean-patrol', label: '现场巡查', path: '/onsite_inspection/list', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md' },
    { key: 'lean-setting', label: '精益生产设置', path: '/setting/lean_production', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md' },
  ] },
  { key: 'produce', label: '生产管理', icon: 'tool', point: 'menu.produce.view', children: [
    { key: 'project', label: '项目管理', path: '/production_project/list', status: 'rebuild', permission: production, allScope: true, reference: '原版未采到，按快工单通用列表样式推断', point: 'menu.produce.view' },
    { key: 'plan', label: '生产计划', permission: production, allScope: true, point: 'menu.produce.view', children: [
      { key: 'plan-mrp', label: '生产计划MRP', path: '/ProductionPlan/list', status: 'rebuild', permission: production, allScope: true, reference: 'docs/kgd-reference/progress/progress-capture.md 第 2 节', point: 'menu.produce.view' },
      { key: 'material-analysis', label: '物料分析', path: '/MaterialAnalysis/list', status: 'rebuild', permission: production, allScope: true, reference: '独立页原版未采到；列取 progress-capture 第 2 节', point: 'menu.produce.view' },
    ] },
    { key: 'work-order', label: '加工单', path: '/inside_produce_bill/list', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
    { key: 'schedule', label: '生产排产', path: '/ProductionScheduling/list', status: 'rebuild', permission: production, allScope: true, reference: 'docs/kgd-reference/progress/progress-capture.md 第 5 节', point: 'menu.produce.view' },
    { key: 'task', label: '生产任务', path: '/productionTask/list', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
    { key: 'work-report', label: '报工记录', path: '/work_repoty_record/list', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
    { key: 'quality', label: '质检中心', permission: 'quality.read', allScope: true, point: 'menu.produce.view', children: [
      { key: 'qc-full', label: '全检', path: '/work_quality_testing/list', status: 'rebuild', permission: 'quality.read', allScope: true, point: 'menu.produce.view' },
      { key: 'qc-spot', label: '抽检', path: '/spot_check/list', status: 'rebuild', permission: 'quality.read', allScope: true, point: 'menu.produce.view' },
      { key: 'qc-spot-line', label: '抽检明细', path: '/spot_check_item/list', status: 'rebuild', permission: 'quality.read', allScope: true, point: 'menu.produce.view' },
    ] },
    { key: 'outsource', label: '外协加工', permission: production, allScope: true, point: 'menu.produce.view', children: [
      { key: 'os-order', label: '外协工单', path: '/OutWorkOrder/list', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
      { key: 'os-receipt', label: '外协验收', path: '/outsourcing_receipt/list', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
      { key: 'os-settle', label: '外协结算', path: '/Outsourcing_settlement/list', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
      { key: 'os-content', label: '验收内容', path: '/outsourcing_content/list', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
    ] },
    { key: 'cost', label: '成本分摊', path: '/apportioned_cost/list', status: 'rebuild', permission: production, allScope: true, reference: '原版未采到；依据 ch3-capture-2 #26 与成本报表', point: 'menu.produce.view' },
    { key: 'machine', label: '机台管理', path: '/machine_platform/list', status: 'rebuild', permission: production, allScope: true, reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md', point: 'menu.produce.view' },
    { key: 'process', label: '工序管理', path: '/public_craft/list', status: 'rebuild', permission: master, allScope: true, point: 'menu.produce.view' },
    { key: 'post', label: '岗位安排', path: '/station/list', status: 'rebuild', permission: production, allScope: true, reference: '原版未采到，按快工单通用列表样式推断', point: 'menu.produce.view' },
    { key: 'defect', label: '不良品项', path: '/waste_item/list', status: 'rebuild', permission: production, allScope: true, reference: 'docs/kgd-reference/round8/round8-lean-qc-capture.md', point: 'menu.produce.view' },
    { key: 'route', label: '工艺路线', path: '/process_routing/list', status: 'rebuild', permission: master, allScope: true, point: 'menu.produce.view' },
    { key: 'extra', label: '工序附加组件', path: '/process_additional_component/list', status: 'rebuild', permission: master, allScope: true, reference: 'docs/kgd-reference/round10/field-config-capture.md 第 6 节', point: 'menu.produce.view' },
    { key: 'trace', label: '溯源码管理', path: '/product_traceability/list', status: 'rebuild', permission: production, allScope: true, reference: '原版列表未采到；依据 ch3-capture-2 #19、wage-capture', point: 'menu.produce.view' },
    { key: 'report-workbench', label: '报工工作台', path: '/work_report_workbench', status: 'rebuild', permission: production, allScope: true, reference: 'docs/kgd-reference/round9/report-dashboard-capture.md', point: 'menu.produce.view' },
    { key: 'produce-setting', label: '生产设置', permission: production, allScope: true, point: 'menu.produce.view', children: [
      { key: 'produce-dict-menu', label: '基础配置', path: '/setting/produce/dictionary', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
      { key: 'perf-pay', label: '绩效工资设置', path: '/setting/PerformancePay/list', status: 'rebuild', permission: production, allScope: true, reference: 'docs/kgd-reference/round11/wage-capture.md E2', point: 'menu.produce.view' },
      { key: 'auto-stock', label: '自动出入库设置', path: '/setting/auto_stock_manage', status: 'rebuild', permission: production, allScope: true, reference: 'docs/kgd-reference/round11/wage-capture.md E3', point: 'menu.produce.view' },
      { key: 'station', label: '工作站设置', path: '/setting/produce/station', status: 'rebuild', permission: production, allScope: true, point: 'menu.produce.view' },
    ] },
  ] },
  { key: 'device', label: '设备维保', icon: 'setting', point: 'menu.device.view', children: [
    { key: 'maint-center', label: '维保中心', point: 'menu.device.view', children: [
      { key: 'maint-plan', label: '维保计划', path: '/inspection_plan/list', status: 'rebuild' },
      { key: 'maint-task', label: '维保任务', path: '/inspection_task/list', status: 'rebuild' },
      { key: 'maint-record', label: '维保记录', path: '/inspection_record/list', status: 'rebuild' },
      { key: 'maint-break', label: '维保明细', path: '/inspection_breakdown/list', status: 'rebuild' },
      { key: 'maint-content', label: '维保内容', path: '/inspection_content/list', status: 'rebuild' },
    ] },
    { key: 'pi-center', label: '点检中心', point: 'menu.device.view', children: [
      { key: 'pi-plan', label: '点检计划', path: '/point_inspection_plan/list', status: 'rebuild' },
      { key: 'pi-record', label: '点检记录', path: '/point_inspection_record/list', status: 'rebuild' },
    ] },
    { key: 'repair-order', label: '维修工单', path: '/device_order/list', status: 'rebuild' },
    { key: 'device-manage', label: '设备管理', point: 'menu.device.view', children: [
      { key: 'device-archive', label: '设备档案', path: '/device/list', status: 'rebuild' },
      { key: 'device-qr', label: '设备二维码', path: '/device_qr_code/list', status: 'rebuild' },
    ] },
    { key: 'equip-setting', label: '维保设置', point: 'menu.device.view', children: [
      { key: 'equip-base', label: '基础设置', path: '/setting/inspection/setting', status: 'rebuild' },
    ] },
  ] },
  { key: 'supply', label: '供应/采购', icon: 'shopping', point: 'menu.supply.view', children: [
    { key: 'supplier', label: '供应商管理', path: '/supplier/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.supply.view' },
    { key: 'purchase', label: '采购', point: 'menu.supply.view', children: [
      { key: 'purchase-plan', label: '采购计划', path: '/produce_plan/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.supply.view' },
      { key: 'purchase-order', label: '采购单', path: '/purchase_order/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.supply.view' },
      { key: 'purchase-pay', label: '付款记录', path: '/purchase_pay_record/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.supply.view' },
      { key: 'purchase-invoice', label: '发票管理', path: '/purchase_pay_invoice/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.supply.view' },
    ] },
    { key: 'purchase-qc', label: '采购检验', permission: procurement, allScope: true, point: 'menu.supply.view', children: [
      { key: 'mt-list', label: '采购检验单', path: '/material_test/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.supply.view' },
      { key: 'mt-lines', label: '采购检验明细', path: '/material_test_item_list/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.supply.view' },
      { key: 'mt-spec', label: '检验规范', path: '/material_test_content/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.supply.view' },
    ] },
    { key: 'purchase-setting', label: '采购设置', point: 'menu.supply.view', children: [
      { key: 'purchase-audit', label: '审核设置', path: '/setting/supplier_purchase/audit_setting', status: 'rebuild', permission: procurement, allScope: true, point: 'purchase.setting.audit' },
      { key: 'purchase-base', label: '采购设置', path: '/setting/purchase/setting', status: 'rebuild', permission: procurement, allScope: true, point: 'purchase.setting.audit', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 2 节' },
      { key: 'supplier-setting', label: '供应商设置', path: '/setting/supplier/setting', status: 'rebuild', permission: procurement, allScope: true, point: 'purchase.setting.audit', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 3 节' },
      { key: 'purchase-price', label: '采购价格追踪', path: '/setting/purchasePriceTrack', status: 'rebuild', permission: procurement, allScope: true, point: 'purchase.setting.audit', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 4 节' },
    ] },
  ] },
  { key: 'warehouse', label: '仓库管理', icon: 'inbox', point: 'menu.warehouse.view', children: [
    { key: 'stock', label: '库存管理', path: '/goods_stock/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
    { key: 'in', label: '入库单', point: 'menu.warehouse.view', children: [
      { key: 'in-purchase', label: '采购入库单', path: '/purchase_stock_in_bill/list', status: 'rebuild', permission: procurement, allScope: true, point: 'menu.warehouse.view' },
      { key: 'in-fg', label: '成品入库单', path: '/produce_stock_in_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
      { key: 'in-semi', label: '半成品入库单', path: '/semi_finished_products_stock_in_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
      { key: 'in-return', label: '生产退料单', path: '/produce_return_materiel_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
      { key: 'in-sale-return', label: '销售退货单', path: '/salesReturnOrder/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
      { key: 'in-other', label: '其他入库单', path: '/else_stock_in_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
    ] },
    { key: 'out', label: '出库单', point: 'menu.warehouse.view', children: [
      { key: 'out-sale', label: '销售出库单', path: '/sale_stock_out_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
      { key: 'out-produce', label: '生产出库单', path: '/production_out_of_storage/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
      { key: 'out-purchase', label: '采购退货单', path: '/purchase_return_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
      { key: 'out-other', label: '其他出库单', path: '/else_stock_out_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
    ] },
    { key: 'transfer', label: '调拨单', path: '/stock_allocate_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
    { key: 'check', label: '库存盘点', path: '/stock_taking_bill/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
    { key: 'flow', label: '出入库流水', path: '/stock_item/list', status: 'rebuild', permission: inventory, allScope: true },
    { key: 'warehouse-list', label: '仓库管理', path: '/ware/list', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
    { key: 'wh-setting', label: '仓库设置', point: 'menu.warehouse.view', children: [
      { key: 'stock-setting', label: '基础设置', path: '/setting/stock/setting', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
      { key: 'stock-audit', label: '审核设置', path: '/setting/stock/audit_setting', status: 'rebuild', permission: inventory, allScope: true, point: 'menu.warehouse.view' },
    ] },
  ] },
  { key: 'iot', label: '智能设备', icon: 'api', point: 'menu.device-smart.view', children: [
    { key: 'iot-scene', label: '物联场景', path: '/device_iot/list', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-equip-report-capture.md' },
    { key: 'iot-sensor', label: '传感器', path: '/device_sensor/list', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-equip-report-capture.md' },
    { key: 'iot-alarm', label: '报警记录', path: '/alarm_record/list', status: 'rebuild', reference: 'docs/kgd-reference/round8/round8-equip-report-capture.md' },
    { key: 'iot-setting', label: '设置', point: 'menu.device-smart.view', children: [
      { key: 'iot-base', label: '基础设置', path: '/setting/smart_device/setting', status: 'rebuild' },
    ] },
  ] },
  { key: 'goods', label: '商品管理', icon: 'gold', point: 'menu.goods.view', children: [
    { key: 'goods-list', label: '商品列表', path: '/goods/list', status: 'rebuild', permission: master, point: 'menu.goods.view' },
    { key: 'bom', label: 'BOM管理', path: '/bom/list', status: 'rebuild', permission: master, allScope: true, point: 'menu.goods.view' },
    { key: 'goods-setting-group', label: '商品设置', point: 'menu.goods.view', children: [
      { key: 'goods-base', label: '基础设置', path: '/setting/goods', status: 'rebuild', permission: master, point: 'menu.goods.view' },
    ] },
  ] },
  { key: 'ai', label: 'AI智能体', icon: 'robot', point: 'menu.ai.view', children: [
    { key: 'ai-train', label: '训练中心', path: '/digitalEmployees/manager/setting', status: 'rebuild', point: 'menu.ai.view', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 5 节' },
    // v1.0.7：默认侧栏恢复六叶（训练中心 + 五叶 AI）；路由一直保留
    { key: 'ai-center', label: '赛德瑞克小助手', path: '/ai/center', status: 'rebuild', point: 'menu.ai.view', reference: 'docs/ai/SPEC.md' },
    { key: 'ai-factory', label: '工厂助理', path: '/ai/factory', status: 'rebuild', point: 'menu.ai.view', reference: 'docs/ai/SPEC.md' },
    { key: 'ai-bom', label: 'AI 导入 BOM', path: '/ai/bom', status: 'rebuild', point: 'menu.ai.view', reference: 'docs/ai/SPEC.md' },
    { key: 'ai-quick-order', label: '极速下单', path: '/ai/quick-order', status: 'rebuild', point: 'menu.ai.view', reference: 'docs/ai/SPEC.md' },
    { key: 'ai-drawing', label: '图纸拆单', path: '/ai/drawing-split', status: 'rebuild', point: 'menu.ai.view', reference: 'docs/ai/SPEC.md' },
    { key: 'ai-glossary', label: '本厂词典', path: '/ai/glossary', status: 'rebuild', point: 'menu.ai.view', reference: 'docs/ai/S3-验收说明.md' },
    { key: 'ai-ext-apps', label: '扩展应用', path: '/ai/ext-apps', status: 'rebuild', point: 'menu.ai.view', reference: 'docs/ai/S3-验收说明.md' },
  ] },
  { key: 'message', label: '消息中心', icon: 'bell', point: 'info.message.view', children: [
    { key: 'message-list', label: '消息列表', path: '/message/list', status: 'rebuild', point: 'info.message.view' },
  ] },
  { key: 'info', label: '信息管理', icon: 'notice', point: 'info.message.view', children: [
    { key: 'knowledge', label: '知识库', path: '/knowledge/list', status: 'rebuild', point: 'info.message.view', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 7 节' },
    { key: 'notice', label: '通知公告', path: '/notice/list', status: 'rebuild', point: 'info.message.view', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 8 节' },
  ] },
  { key: 'system', label: '系统管理', icon: 'control', point: 'system.', children: [
    { key: 'personal', label: '个人中心', path: '/account', status: 'rebuild' },
    { key: 'users', label: '用户管理', path: '/user/list', status: 'rebuild', point: 'system.account' },
    { key: 'roles', label: '角色管理', path: '/role/list', status: 'rebuild', point: 'system.account' },
    { key: 'teams', label: '团队管理', path: '/systemTeam/list', status: 'rebuild', point: 'system.team' },
    { key: 'departments', label: '部门管理', path: '/department/list', status: 'rebuild', point: 'system.account' },
    { key: 'audit', label: '操作日志', path: '/userLog', status: 'rebuild', point: 'system.log', permission: 'audit.read' },
    { key: 'settings', label: '系统设置', point: 'system.', children: [
      { key: 'basics', label: '通用设置', path: '/setting/basics', status: 'rebuild', point: 'system.setting', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 9 节' },
      { key: 'company', label: '企业信息设置', path: '/setting/enterprise/setting', status: 'rebuild', point: 'system.setting' },
      { key: 'sms', label: '短信设置', path: '/setting/sms', status: 'rebuild', point: 'system.setting', reference: 'docs/kgd-reference/round10/round10-capture-2.md 第 10 节' },
      { key: 'code-rules', label: '自定义编号规则', path: '/setting/customCodeRules', status: 'rebuild', permission: 'configuration.read', point: 'system.setting' },
    ] },
  ] },
];

export function walkMenus(nodes: MenuNode[], visit: (node: MenuNode, parents: MenuNode[]) => void, parents: MenuNode[] = []) {
  nodes.forEach((node) => {
    visit(node, parents);
    if (node.children) walkMenus(node.children, visit, [...parents, node]);
  });
}

export function findMenuByPath(pathname: string): { primary: PrimaryMenu; chain: MenuNode[] } | null {
  const aliases: [string, string][] = [
    ['/contract_project_edit', '/production_project/list'],
    ['/production_outsource_project', '/production_project/list'],
    ['/contract_project/', '/production_project/list'],
    ['/meeting/detail', '/meeting/list'],
    ['/OutWorkOrder/detail', '/OutWorkOrder/list'],
    ['/OutWorkOrder/edit', '/OutWorkOrder/list'],
    ['/craft_route/', '/process_routing/list'],
    ['/process_routing/add', '/process_routing/list'],
    ['/process_routing/edit', '/process_routing/list'],
  ];
  let path = pathname;
  for (const [from, to] of aliases) {
    if (path === from || path.startsWith(from)) path = to;
  }
  const box: { best: { primary: PrimaryMenu; chain: MenuNode[]; length: number } | null } = { best: null };
  for (const primary of primaryMenus) {
    const nodes: MenuNode[] = primary.path ? [{ key: primary.key, label: primary.label, path: primary.path, status: primary.status, reference: primary.reference }, ...(primary.children ?? [])] : (primary.children ?? []);
    walkMenus(nodes, (node, parents) => {
      if (!node.path) return;
      if (path === node.path || path.startsWith(`${node.path.replace(/\/list$/, '')}/`)) {
        const length = node.path.length;
        if (!box.best || length > box.best.length) box.best = { primary, chain: [...parents, node], length };
      }
    });
  }
  return box.best ? { primary: box.best.primary, chain: box.best.chain } : null;
}

export type ScreenMenuRow = { id: string; menu_name: string; sort_no?: number; module_kind?: string };

export function screenMenuNodes(rows: ScreenMenuRow[]): MenuNode[] {
  return [...rows].sort((a, b) => (a.sort_no ?? 0) - (b.sort_no ?? 0)).map((row) => ({ key: `screen-${row.id}`, label: row.menu_name, status: 'rebuild', screenId: row.id, iconName: 'screen' as const, moduleKind: row.module_kind }));
}

export function leafPaths(): string[] {
  const paths: string[] = [];
  primaryMenus.forEach((primary) => {
    if (primary.path) paths.push(primary.path);
    walkMenus(primary.children ?? [], (node) => { if (node.path && !node.children?.length) paths.push(node.path); });
  });
  return [...new Set(paths)];
}

/** v1.0.7：默认恢复 AI 六叶；保留开关钩子便于日后再收窄 */
const AI_EXTRA_KEYS = new Set(['ai-center', 'ai-factory', 'ai-bom', 'ai-quick-order', 'ai-drawing']);

export function showAiExtraMenus() {
  return true;
}

export function filterSidebarMenus(nodes: MenuNode[]): MenuNode[] {
  const extra = showAiExtraMenus();
  return nodes
    .filter((node) => extra || !AI_EXTRA_KEYS.has(node.key))
    .map((node) => (node.children?.length ? { ...node, children: filterSidebarMenus(node.children) } : node));
}
