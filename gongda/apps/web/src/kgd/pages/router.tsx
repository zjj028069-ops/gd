import { Navigate, useLocation } from 'react-router-dom';
import { findMenuByPath } from '../menu';
import { BomEditorPage, BomList } from './catalogGoods';
import { CodeRules } from './goods/codeRules';
import { GoodsDetail } from './goods/detail';
import { GoodsList } from './goods/list';
import { CategoryBoard } from './goods/categories';
import { GoodsSettings } from './goods/settings';
import { ProcessList, RouteEditorPage, RouteList } from './catalogMasters';
import { LegacyEmbed } from './legacyEmbed';
import { PayrollStatement } from './payroll';
import { ReportWorkbenchPage } from './reportWorkbench';
import { BaseSetting, CashList, ExpenseList, InvoiceList } from './money/finance';
import { ContractDetail, ContractList } from './money/contracts';
import { CustomerList } from './money/customers';
import { QuotationList } from './money/quotations';
import { PayRecordList, PlanList, PurchaseDetail, PurchaseInvoiceList, PurchaseList, SupplierList } from './money/supply';
import { ReportList, TaskList } from './tasksReports';
import { WorkOrderAdd, WorkOrderDetail, WorkOrderList } from './workOrders';
import { resolveSystemPage } from './system/router';
import { resolveWarehousePage } from './warehouse/router';
import { progressRedirects, resolveProgressPage } from './progress/router';
import { resolveRound8Page } from './round8/router';
import { resolveRound10Page } from './round10/router';
import { resolveRound11Page } from './round11/router';

const warehouseRedirects: Record<string, string> = {
  '/stock/list': '/goods_stock/list',
  '/stock_flow/list': '/stock_item/list',
  '/warehouse/list': '/ware/list',
  '/stock_transfer/list': '/stock_allocate_bill/list',
  '/stock_check/list': '/stock_taking_bill/list',
  '/semi_stock_in_bill/list': '/semi_finished_products_stock_in_bill/list',
  '/produce_return_bill/list': '/produce_return_materiel_bill/list',
  '/sale_return_bill/list': '/salesReturnOrder/list',
  '/other_stock_in_bill/list': '/else_stock_in_bill/list',
  '/produce_stock_out_bill/list': '/production_out_of_storage/list',
  '/other_stock_out_bill/list': '/else_stock_out_bill/list',
};

const round10Redirects: Record<string, string> = {
  '/': '/staging/area',
  '/workplace': '/staging/area',
  '/staging': '/staging/area',
  '/customer_follow/list': '/follow/list',
  '/follow': '/follow/list',
  '/purchase/setting': '/setting/purchase/setting',
  '/purchase/supplier_setting': '/setting/supplier/setting',
  '/purchase/price_track': '/setting/purchasePriceTrack',
  '/ai/train': '/digitalEmployees/manager/setting',
  '/ai/order': '/digitalEmployees/manager/setting',
  '/knowledge': '/knowledge/list',
  '/notice': '/notice/list',
  '/contract/add': '/customer_contract/list?add=1',
  '/purchase_bill/add': '/purchase_order/list?add=1',
  '/contract/list': '/customer_contract/list',
  '/invoice/list': '/customer_invoice/list',
  '/maintenance_task/list': '/inspection_task/list',
  '/repair_order/list': '/device_order/list',
  '/purchase_bill/list': '/purchase_order/list',
  '/purchase_plan/list': '/produce_plan/list',
  '/process_component/list': '/process_additional_component/list',
  '/post_arrange/list': '/station/list',
  '/MaterialAnalysis/center': '/MaterialAnalysis/list',
  '/personal/center': '/account',
  '/craft_route/list': '/process_routing/list',
  '/setting/produce/dictionary/sys': '/setting/produce/dictionary',
};

export function KgdPage() {
  const { pathname, search } = useLocation();
  const redirect = round10Redirects[pathname] ?? warehouseRedirects[pathname] ?? progressRedirects[pathname];
  if (redirect) return <Navigate to={redirect.includes('?') || !search ? redirect : `${redirect}${search}`} replace />;
  const sys = resolveSystemPage(pathname); if (sys) return sys;
  const round11 = resolveRound11Page(pathname);
  if (round11) return round11;
  const round10 = resolveRound10Page(pathname);
  if (round10) return round10;
  const round8 = resolveRound8Page(pathname);
  if (round8) return round8;
  const progressPage = resolveProgressPage(pathname);
  if (progressPage) return progressPage;
  if (pathname.startsWith('/produce_report/workbench')) return <Navigate to="/work_report_workbench" replace />;
  if (pathname === '/work_report_workbench') return <ReportWorkbenchPage />;
  if (pathname === '/produce_task/list') return <Navigate to="/productionTask/list" replace />;
  if (pathname === '/produce_report/list') return <Navigate to="/work_repoty_record/list" replace />;
  if (pathname === '/report/wage') return <Navigate to="/payroll_statement/list" replace />;
  if (pathname === '/goods_category/list') return <div className="kgd-card"><CategoryBoard kind="goods" /></div>;
  if (pathname.startsWith('/inside_produce_bill/split/')) {
    const round11Split = resolveRound11Page(pathname);
    if (round11Split) return round11Split;
  }
  if (pathname.startsWith('/inside_produce_bill/add')) return <WorkOrderAdd />;
  if (pathname.startsWith('/inside_produce_bill/detail/')) return <WorkOrderDetail />;
  if (pathname.startsWith('/craft_route/add') || pathname.startsWith('/craft_route/edit/') || pathname.startsWith('/process_routing/add') || pathname.startsWith('/process_routing/edit/')) return <RouteEditorPage />;
  if (pathname.startsWith('/bom/add') || pathname.startsWith('/bom/edit/')) return <BomEditorPage />;
  const match = findMenuByPath(pathname);
  if (!match) return <Navigate to="/staging/area" replace />;
  if (pathname.startsWith('/goods/detail/')) return <GoodsDetail />;
  if (pathname.startsWith('/customer_contract/detail/')) return <ContractDetail />;
  if (pathname.startsWith('/purchase_order/detail/')) return <PurchaseDetail />;
  if (pathname.endsWith('/add')) {
    const list = pathname.replace(/\/add$/, '/list');
    const target = warehouseRedirects[list] ?? list;
    const params = new URLSearchParams(search);
    if (!params.has('add')) params.set('add', '1');
    return <Navigate to={`${target}?${params}`} replace />;
  }
  const node = match.chain[match.chain.length - 1];
  if (!node) return <Navigate to="/staging/area" replace />;
  if (node.status === 'legacy' && node.legacy) return <LegacyEmbed kind={node.legacy} />;
  if (node.path === '/inside_produce_bill/list') return <WorkOrderList />;
  if (node.path === '/productionTask/list') return <TaskList />;
  if (node.path === '/work_repoty_record/list') return <ReportList />;
  if (node.path === '/payroll_statement/list') return <PayrollStatement />;
  if (node.path === '/public_craft/list') return <ProcessList />;
  if (node.path === '/craft_route/list' || node.path === '/process_routing/list') return <RouteList />;
  if (node.path === '/goods/list') return <GoodsList />;
  if (node.path === '/setting/goods') return <GoodsSettings />;
  if (node.path === '/setting/customCodeRules') return <CodeRules />;
  if (node.path === '/bom/list') return <BomList />;
  const warehousePage = resolveWarehousePage(pathname);
  if (warehousePage) return warehousePage;
  if (node.path === '/customer/list') return <CustomerList />;
  if (node.path === '/contract_quotation_bill/list') return <QuotationList />;
  if (node.path === '/customer_contract/list') return <ContractList />;
  if (node.path === '/customer_financier/list') return <CashList />;
  if (node.path === '/customer_invoice/list') return <InvoiceList />;
  if (node.path === '/selling_expenses/list') return <ExpenseList />;
  if (node.path === '/customer/setting/base_setting') return <BaseSetting />;
  if (node.path === '/supplier/list') return <SupplierList />;
  if (node.path === '/produce_plan/list') return <PlanList />;
  if (node.path === '/purchase_order/list') return <PurchaseList />;
  if (node.path === '/purchase_pay_record/list') return <PayRecordList />;
  if (node.path === '/purchase_pay_invoice/list') return <PurchaseInvoiceList />;
  return <Navigate to="/staging/area" replace />;
}
