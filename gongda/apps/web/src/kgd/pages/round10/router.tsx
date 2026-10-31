import type { ReactNode } from 'react';
import { TrainCenter } from './ai/TrainCenter';
import { AiCenterPage } from '../../../modules/ai/AiCenterPage';
import { FactoryAssistantPage } from '../../../modules/ai/FactoryAssistantPage';
import { BomImportPage } from '../../../modules/ai/BomImportPage';
import { QuickOrderPage } from '../../../modules/ai/QuickOrderPage';
import { DrawingSplitPage } from '../../../modules/ai/DrawingSplitPage';
import { GlossaryPage } from '../../../modules/ai/GlossaryPage';
import { ExtAppsPage } from '../../../modules/ai/ExtAppsPage';
import { ExtBoardPage } from '../../../modules/ai/ExtBoardPage';
import { LiteExpressPage } from '../../../modules/ai/LiteExpressPage';
import { ShellToolPage } from '../../../modules/ai/ShellToolPage';
import { CustomerFollowList } from './crm/CustomerFollowList';
import { KnowledgeEdit } from './info/KnowledgeEdit';
import { KnowledgeList } from './info/KnowledgeList';
import { NoticeEdit } from './info/NoticeEdit';
import { NoticeList } from './info/NoticeList';
import { CostShareList } from './produce/CostShareList';
import { MaterialAnalysisCenter } from './produce/MaterialAnalysisCenter';
import { PostList } from './produce/PostList';
import { ProcessComponentList } from './produce/ProcessComponentList';
import { ProjectList } from './produce/ProjectList';
import { TraceCodeList } from './produce/TraceCodeList';
import { AiInventoryPage } from './reports/AiInventoryPage';
import { PurchaseStatementPage } from './reports/PurchaseStatementPage';
import { SmartReportPage } from './reports/SmartReportPage';
import { ScreenManagementList } from './screens/ScreenManage';
import { BasicSetting } from './settings/BasicSetting';
import { PriceTrack } from './settings/PriceTrack';
import { PurchaseSetting } from './settings/PurchaseSetting';
import { SmsSetting } from './settings/SmsSetting';
import { SupplierSetting } from './settings/SupplierSetting';
import { WorkplacePage } from './workplace/WorkplacePage';

const exact: Record<string, () => ReactNode> = {
  '/staging/area': () => <WorkplacePage />,
  '/screen_management/list': () => <ScreenManagementList />,
  '/follow/list': () => <CustomerFollowList />,
  '/knowledge/list': () => <KnowledgeList />,
  '/knowledge/add': () => <KnowledgeEdit />,
  '/notice/list': () => <NoticeList />,
  '/notice/add': () => <NoticeEdit />,
  '/setting/purchase/setting': () => <PurchaseSetting />,
  '/setting/supplier/setting': () => <SupplierSetting />,
  '/setting/purchasePriceTrack': () => <PriceTrack />,
  '/setting/basics': () => <BasicSetting />,
  '/setting/sms': () => <SmsSetting />,
  '/purchase_statement': () => <PurchaseStatementPage />,
  '/ai_inventory/list': () => <AiInventoryPage />,
  '/smart/form_core_list': () => <SmartReportPage />,
  '/MaterialAnalysis/list': () => <MaterialAnalysisCenter />,
  '/MaterialAnalysis/center': () => <MaterialAnalysisCenter />,
  '/production_project/list': () => <ProjectList />,
  '/apportioned_cost/list': () => <CostShareList />,
  '/apportioned_cost/add': () => <CostShareList />,
  '/station/list': () => <PostList />,
  '/post_arrange/list': () => <PostList />,
  '/process_additional_component/list': () => <ProcessComponentList />,
  '/product_traceability/list': () => <TraceCodeList />,
  '/digitalEmployees/manager/setting': () => <TrainCenter />,
  '/ai/center': () => <AiCenterPage />,
  '/ai/factory': () => <FactoryAssistantPage />,
  '/ai/bom': () => <BomImportPage />,
  '/ai/quick-order': () => <QuickOrderPage />,
  '/ai/drawing-split': () => <DrawingSplitPage />,
  '/ai/glossary': () => <GlossaryPage />,
  '/ai/ext-apps': () => <ExtAppsPage />,
};

const prefixes: [string, () => ReactNode][] = [
  ['/ai/ext-board/', () => <ExtBoardPage />],
  ['/ai/lite/', () => <LiteExpressPage />],
  ['/ai/shell-tool/', () => <ShellToolPage />],
  ['/knowledge/edit/', () => <KnowledgeEdit />],
  ['/knowledge/detail/', () => <KnowledgeEdit />],
  ['/notice/detail/', () => <NoticeEdit />],
  ['/production_project/detail/', () => <ProjectList />],
  ['/apportioned_cost/edit/', () => <CostShareList />],
  ['/apportioned_cost/detail/', () => <CostShareList />],
];

export const round10Paths = Object.keys(exact);

export function resolveRound10Page(pathname: string): ReactNode | null {
  const page = exact[pathname];
  if (page) return page();
  const prefix = prefixes.find(([start]) => pathname.startsWith(start));
  return prefix ? prefix[1]() : null;
}
