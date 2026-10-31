import './warehouse.css';
import { BillHub } from './BillHub';
import { LedgerPage } from './LedgerPage';
import { StockPage } from './StockPage';
import { StockSettingPage } from './SettingPages';
import { WareListPage } from './WareListPage';
import { warehouseBillPaths } from './billConfigs';
import { FgReceiptDetail, PurchaseReceiptDetail } from './ReceiptDetail';

export function resolveWarehousePage(pathname: string) {
  if (pathname.startsWith('/purchase_stock_in_bill/detail/')) return <PurchaseReceiptDetail id={pathname.split('/detail/')[1]?.split(/[/?#]/)[0] ?? ''} />;
  if (pathname.startsWith('/produce_stock_in_bill/detail/')) return <FgReceiptDetail id={pathname.split('/detail/')[1]?.split(/[/?#]/)[0] ?? ''} />;
  if (pathname === '/goods_stock/list') return <StockPage />;
  if (pathname === '/stock_item/list') return <LedgerPage />;
  if (pathname === '/ware/list') return <WareListPage />;
  if (pathname === '/setting/stock/setting') return <StockSettingPage />;
  if (warehouseBillPaths.has(pathname)) return <BillHub />;
  return null;
}

export { PurchaseInboundLink, PurchaseReturnLink, ContractOutboundLink, PurchaseInboundDialog, PurchaseReturnDialog, ContractOutboundDialog } from './links';
