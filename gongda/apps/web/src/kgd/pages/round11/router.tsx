import type { ReactNode } from 'react';
import { LinkmanList, CustomerSeaList, SalesPriceTrack } from './crm/pages';
import { MessageCenterPage } from './settings/MessageCenter';
import { AutoStockManage, PerformancePayEdit, PerformancePayList, PerformancePayRule } from './settings/PerformanceAutoStock';
import { StationPosts } from './produce/StationPosts';
import { WorkOrderAdd, WorkOrderDetail, WorkOrderList } from '../workOrders';
import { WorkOrderSplit } from './produce/WorkOrderSplit';
import { MaterialAnalysisAdd } from './produce/MaterialAnalysisAdd';
import { ProjectPages } from './produce/ProjectPages';
import {
  DeviceArchivePages, DeviceDetailPage, DeviceQrList, EquipSettingPage,
  MaintBreakdownList, MaintContentList, MaintPlanAdd, MaintPlanDetail, MaintPlanPages,
  MaintRecordList, MaintTaskList, PiPlanAdd, PiPlanList, PiRecordList, RepairOrderDetail, RepairOrderList,
} from './equip/pages';

const exact: Record<string, () => ReactNode> = {
  '/linkman/list': () => <LinkmanList />,
  '/customer_sea/list': () => <CustomerSeaList />,
  '/customer/salesPriceTrack': () => <SalesPriceTrack />,
  '/message/list': () => <MessageCenterPage />,
  '/setting/PerformancePay/list': () => <PerformancePayList />,
  '/setting/PerformancePay/edit': () => <PerformancePayEdit />,
  '/setting/PerformancePay/rule': () => <PerformancePayRule />,
  '/setting/auto_stock_manage': () => <AutoStockManage />,
  '/station/list': () => <StationPosts />,
  '/MaterialAnalysis/add': () => <MaterialAnalysisAdd />,
  '/inspection_plan/list': () => <MaintPlanPages />,
  '/inspection_plan/add/1': () => <MaintPlanAdd />,
  '/inspection_task/list': () => <MaintTaskList />,
  '/inspection_record/list': () => <MaintRecordList />,
  '/inspection_breakdown/list': () => <MaintBreakdownList />,
  '/inspection_content/list': () => <MaintContentList />,
  '/point_inspection_plan/list': () => <PiPlanList />,
  '/point_inspection_plan/add/1': () => <PiPlanAdd />,
  '/point_inspection_record/list': () => <PiRecordList />,
  '/device_order/list': () => <RepairOrderList />,
  '/device/list': () => <DeviceArchivePages />,
  '/device_qr_code/list': () => <DeviceQrList />,
  '/setting/inspection/setting': () => <EquipSettingPage />,
  '/production_project/list': () => <ProjectPages />,
  '/production_project/edit': () => <ProjectPages />,
  '/contract_project_edit/edit': () => <ProjectPages />,
  '/production_outsource_project/edit': () => <ProjectPages />,
};

const prefixes: [string, () => ReactNode][] = [
  ['/inspection_plan/detail/', () => <MaintPlanDetail />],
  ['/device_order/detail/', () => <RepairOrderDetail />],
  ['/device/detail/', () => <DeviceDetailPage />],
  ['/production_project/edit/', () => <ProjectPages />],
  ['/production_project/detail/', () => <ProjectPages />],
  ['/contract_project/detail/', () => <ProjectPages />],
  ['/production_outsource_project/detail/', () => <ProjectPages />],
];

export function resolveRound11Page(pathname: string): ReactNode | null {
  if (pathname.startsWith('/inside_produce_bill/split/')) return <WorkOrderSplit />;
  if (pathname.startsWith('/inside_produce_bill/add')) return <WorkOrderAdd />;
  if (pathname.startsWith('/inside_produce_bill/detail/')) return <WorkOrderDetail />;
  if (pathname === '/inside_produce_bill/list') return <WorkOrderList />;
  if (pathname.startsWith('/setting/PerformancePay/rule')) return <PerformancePayRule />;
  const page = exact[pathname];
  if (page) return page();
  const prefix = prefixes.find(([start]) => pathname.startsWith(start));
  return prefix ? prefix[1]() : null;
}
