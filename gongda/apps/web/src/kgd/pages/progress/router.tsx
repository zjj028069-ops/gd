import './progress.css';
import { ProductionPlanDetail, ProductionPlanEditor, ProductionPlanList } from './productionPlans';
import { ClockReportPage, OutputReportPage, WipReportPage } from './reportCenter';
import { ProductionSchedulingPage } from './scheduling';

export const progressRedirects: Record<string, string> = {
  '/produce_schedule/list': '/ProductionScheduling/list',
  '/screen/manage': '/screen_management/list',
  '/screen/control': '/screen_management/list',
  '/screen/workshop': '/screen_management/list',
  '/screen/machine': '/screen_management/list',
  '/screen/defect': '/screen_management/list',
  '/screen/progress': '/screen_management/list',
  '/report/machine': '/drilling_crew_statement/list',
  '/report/clock': '/clock_in_report',
  '/report/output': '/output_statistics_report',
  '/report/wip': '/articles_being_processed_report',
  '/report/defect_trend': '/waste_analysis',
  '/report/pareto': '/waste_key_analysis',
  '/report/defect_detail': '/waste_detail',
  '/report/purchase_inspection': '/material_test_report',
  '/report/sample': '/spot_check_report',
  '/report/scrap': '/scrap_rework_statistics_report',
  '/report/purchase_statement': '/purchase_statement',
  '/report/sales_statement': '/sales_statement',
  '/report/contract': '/contract_report',
  '/report/cost': '/produce_bill_cost',
  '/report/ai_stock': '/ai_inventory/list',
  '/report/inventory_summary': '/inventory_summary',
  '/report/smart': '/smart/form_core_list',
  '/ai_inventory': '/ai_inventory/list',
  '/form_core': '/smart/form_core_list',
  '/smart': '/smart/form_core_list',
  '/project/list': '/production_project/list',
  '/cost_share/list': '/apportioned_cost/list',
  '/trace_code/list': '/product_traceability/list',
  '/post/list': '/station/list',
  '/post_arrange/list': '/station/list',
  '/MaterialAnalysis': '/MaterialAnalysis/list',
  '/MaterialAnalysis/center': '/MaterialAnalysis/list',
  '/report/wage': '/payroll_statement/list',
};

export function resolveProgressPage(pathname: string) {
  if (pathname === '/ProductionPlan/list') return <ProductionPlanList />;
  if (pathname.startsWith('/ProductionPlan/add')) return <ProductionPlanEditor />;
  if (pathname.startsWith('/ProductionPlan/detail/')) return <ProductionPlanDetail />;
  if (pathname === '/ProductionScheduling/list') return <ProductionSchedulingPage />;
  if (pathname === '/output_statistics_report') return <OutputReportPage />;
  if (pathname === '/articles_being_processed_report') return <WipReportPage />;
  if (pathname === '/clock_in_report') return <ClockReportPage />;
  return null;
}
