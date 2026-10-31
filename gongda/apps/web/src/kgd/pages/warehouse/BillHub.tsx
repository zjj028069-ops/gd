import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { App, Button, Dropdown, Modal } from 'antd';
import type { ReactNode } from 'react';
import { apiRequest, errorMessage } from '../../../api';
import { printDocs, type PrintDoc } from '../../print';
import { useRemote } from '../../../masterTools';
import { ListFrame } from '../../ListFrame';
import { useQueryState } from '../../kit';
import { SummaryBar } from '../money/shared';
import { configForPath } from './billConfigs';
import {
  DirectShipmentModal,
  ElseInModal,
  ElseOutModal,
  FgReceiptModal,
  MaterialIssueModal,
  OutsourceBillModal,
  ProdReturnModal,
  PurchaseReceiptModal,
  PurchaseReturnModal,
  SalesReturnModal,
  SemiFgModal,
  ShipmentModal,
  ShipmentReturnModal,
  StockTakingModal,
  TransferModal,
} from './BillForms';
import { AuditDetailModal } from '../audit/AuditDetailModal';
import { BatchAuditModal } from '../audit/BatchAuditModal';
import { auditChipOptions, useAuditCounts } from '../audit/auditChips';
import { AuditTag } from './shared';
import { useBillExtension } from '../../extensions/bind';
import { useWarehouseApi } from './useWarehouseApi';
import type { WhRec } from './useWarehouseApi';

type ModalKey =
  | 'receipt'
  | 'return'
  | 'shipment'
  | 'fg'
  | 'issue'
  | 'semi'
  | 'prodReturn'
  | 'salesReturn'
  | 'elseIn'
  | 'elseOut'
  | 'transfer'
  | 'taking'
  | 'direct'
  | 'shipmentReturn'
  | 'outIn'
  | 'outOut'
  | 'outReturn';

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}
const MOBILE_CARD_BILLS = new Set([
  '/purchase_stock_in_bill/list',
  '/produce_stock_in_bill/list',
  '/semi_finished_products_stock_in_bill/list',
  '/produce_return_materiel_bill/list',
  '/salesReturnOrder/list',
  '/else_stock_in_bill/list',
  '/sale_stock_out_bill/list',
  '/production_out_of_storage/list',
  '/purchase_return_bill/list',
  '/else_stock_out_bill/list',
]);
const headOf = (row: WhRec) => String(row._headId ?? String(row.id).split(':')[0]);
const deletable = (row: WhRec) => ['pending', 'draft'].includes(String(row.audit_status ?? '')) || ['pending', 'draft'].includes(String(row.approval ?? ''));

export function BillHub() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const { message } = App.useApp();
  const api = useWarehouseApi();
  const list = useQueryState();
  const config = configForPath(pathname);
  const billExt = useBillExtension(pathname);
  const orderId = search.get('order_id') ?? '';
  const query = [config.listQuery?.(list.query) ?? '', orderId ? `order_id=${encodeURIComponent(orderId)}` : ''].filter(Boolean).join('&');
  const url = config.listPath ? `${config.listPath}${query ? `?${query}` : ''}` : null;
  const remote = useRemote<{ items: WhRec[] }>(url, api.revision, api.onExpired);
  const billObject: Record<string, string> = {
  '/purchase_stock_in_bill/list': 'purchase_receipt',
  '/produce_stock_in_bill/list': 'fg_receipt',
  '/else_stock_in_bill/list': 'else_in',
  '/sale_stock_out_bill/list': 'sale_shipment',
  '/production_out_of_storage/list': 'material_issue',
  '/else_stock_out_bill/list': 'else_out',
  '/stock_allocate_bill/list': 'KCDB',
  '/purchase_return_bill/list': 'purchase_return',
  '/salesReturnOrder/list': 'sales_return',
  '/produce_return_materiel_bill/list': 'prod_return_mat',
  '/semi_finished_products_stock_in_bill/list': 'semi_fg_in',
};
const objectType = billObject[pathname] ?? '';
const [modal, setModal] = useState<ModalKey | null>(null);
const [selected, setSelected] = useState<string[]>([]);
const [auditId, setAuditId] = useState('');
const [batch, setBatch] = useState(false);
const counts = useAuditCounts(objectType || 'purchase_receipt', api.revision, api.onExpired);
const approver = useRemote<{ approver: boolean }>(objectType ? `/api/audit/approver?object_type=${objectType}` : null, api.revision, api.onExpired);
  const [modalSeed, setModalSeed] = useState<Record<string, unknown>>({});
  const [takingMode, setTakingMode] = useState<'custom' | 'full'>('custom');
  const [salesReturnMode, setSalesReturnMode] = useState<string>('contract');
  const rows = useMemo(() => {
    const items = remote.data?.items ?? [];
    const flat = config.flatten ? config.flatten(items) : items.map((item) => ({ ...item, id: String(item.id) }));
    return flat.filter((row: WhRec) => {
      if ((list.query.code ?? '') && !String(row.code ?? '').includes(list.query.code ?? '')) return false;
      const auditChip = list.chips.approval;
      if (auditChip && auditChip !== 'all' && String(row.audit_status ?? row.approval ?? 'exempt') !== auditChip) return false;
      const stateChip = list.chips.state;
      if (stateChip && stateChip !== 'all' && String(row.state ?? '') !== stateChip) return false;
      return true;
    });
  }, [config, remote.data, list.query, list.chips]);
  const summaryParts = config.summary?.(remote.data?.items ?? []) ?? [];
  function openAdd(mode?: string) {
    if (pathname === '/purchase_stock_in_bill/list') { setModalSeed({}); setModal('receipt'); return; }
    if (pathname === '/purchase_return_bill/list') { setModal('return'); return; }
    if (pathname === '/sale_stock_out_bill/list') {
      if (mode === 'direct') { setModal('direct'); return; }
      setModal('shipment'); return;
    }
    if (pathname === '/produce_stock_in_bill/list') {
      if (mode === 'outsource') { setModal('outIn'); return; }
      setModal('fg'); return;
    }
    if (pathname === '/production_out_of_storage/list') {
      if (mode === 'outsource') { setModal('outOut'); return; }
      setModal('issue'); return;
    }
    if (pathname === '/semi_finished_products_stock_in_bill/list') { setModal('semi'); return; }
    if (pathname === '/produce_return_materiel_bill/list') {
      if (mode === 'outsource') { setModal('outReturn'); return; }
      setModal('prodReturn'); return;
    }
    if (pathname === '/salesReturnOrder/list') {
      if (mode === 'shipment') { setModal('shipmentReturn'); return; }
      setSalesReturnMode(mode ?? 'contract');
      setModal('salesReturn'); return;
    }
    if (pathname === '/else_stock_in_bill/list') { setModal('elseIn'); return; }
    if (pathname === '/else_stock_out_bill/list') { setModal('elseOut'); return; }
    if (pathname === '/stock_allocate_bill/list') { setModal('transfer'); return; }
    if (pathname === '/stock_taking_bill/list') {
      setTakingMode(mode === 'full' ? 'full' : 'custom');
      setModal('taking'); return;
    }
  }
  const canAdd = [
    '/purchase_stock_in_bill/list', '/purchase_return_bill/list', '/sale_stock_out_bill/list', '/produce_stock_in_bill/list', '/production_out_of_storage/list',
    '/semi_finished_products_stock_in_bill/list', '/produce_return_materiel_bill/list', '/salesReturnOrder/list', '/else_stock_in_bill/list', '/else_stock_out_bill/list',
    '/stock_allocate_bill/list', '/stock_taking_bill/list',
  ].includes(pathname);
  const printColumns = config.columns.filter((column) => !['audit', 'auditDetail', 'actions'].includes(column.key));
  function billDoc(group: WhRec[]): PrintDoc {
    const first = group[0]!;
    const cell = (column: (typeof printColumns)[number], row: WhRec) => textOf(column.render ? column.render(row) : (row[column.key] as ReactNode));
    return {
      title: config.title,
      fields: printColumns.map((column) => [column.title, cell(column, first)]),
      ...(group.length > 1 ? { columns: printColumns.map((column) => column.title), rows: group.map((row) => printColumns.map((column) => cell(column, row))) } : {}),
    };
  }
  function groups(targets: WhRec[]) {
    const map = new Map<string, WhRec[]>();
    targets.forEach((row) => map.set(headOf(row), [...(map.get(headOf(row)) ?? []), row]));
    return [...map.entries()];
  }
  function printBills(targets: WhRec[]) {
    const docs = groups(targets).map(([head]) => billDoc(rows.filter((row) => headOf(row) === head)));
    if (docs.length && !printDocs(docs, config.title)) message.warning('浏览器拦截了打印窗口，请允许弹出窗口后重试。');
  }
  function removeBills(targets: WhRec[]) {
    const all = groups(targets);
    const allowed = all.filter(([, group]) => group.every(deletable));
    if (!allowed.length) { message.warning('只能删除待审核或草稿状态的单据'); return; }
    Modal.confirm({
      title: '删除单据', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      content: `将删除 ${allowed.length} 张待审核或草稿单据${all.length > allowed.length ? `，另有 ${all.length - allowed.length} 张已审核单据不能删除` : ''}。`,
      onOk: async () => {
        const failed: string[] = [];
        for (const [head, group] of allowed) {
          try { await apiRequest(`${config.listPath}/${head}`, { method: 'DELETE', csrfToken: api.session.csrf_token, body: { version: group[0]!.version } }); }
          catch (failure) { failed.push(`${String(group[0]!.code ?? head)}：${errorMessage(failure)}`); }
        }
        setSelected([]);
        api.onChanged();
        if (failed.length) Modal.warning({ title: '部分单据未删除', content: <div>{failed.map((item) => <div key={item}>{item}</div>)}</div> });
        else message.success('已删除');
      },
    });
  }
  const [sourceId, setSourceId] = useState('');
  useEffect(() => {
    const add = search.get('add');
    if (!add || !canAdd) return;
    setSourceId(search.get('work_order_id') ?? search.get('order_id') ?? '');
    openAdd(add === '1' ? undefined : add);
    const next = new URLSearchParams(search);
    ['add', 'work_order_id', 'order_id'].forEach((key) => next.delete(key));
    setSearch(next, { replace: true });
  }, []);
  const close = () => { setModal(null); setSourceId(''); };
  const addButton = !canAdd ? null : config.addDropdown
    ? <Dropdown menu={{ items: config.addDropdown.map((item) => ({ key: item.key, label: item.label, onClick: () => openAdd(item.key) })) }}><Button type="primary">+ 新增</Button></Dropdown>
    : <Button type="primary" onClick={() => openAdd()}>{config.addLabel ?? '+ 新增'}</Button>;
  const columns = config.columns.map((column) => {
    if (column.key === 'audit') return { ...column, render: (row: WhRec) => <AuditTag status={String(row.audit_status ?? row.approval ?? 'exempt')} /> };
    if (column.key === 'auditDetail') return { ...column, render: (row: WhRec) => <button type="button" className="kgd-link" onClick={() => setAuditId(String(row.id).split(':')[0])}>查看</button> };
    if (column.key === 'code' && pathname === '/produce_stock_in_bill/list') {
      return { ...column, render: (row: WhRec) => <button type="button" className="kgd-link" onClick={() => navigate(`/produce_stock_in_bill/detail/${String(row.id).split(':')[0]}`)}>{String(row.code ?? '')}</button> };
    }
    if (column.key === 'actions') return { ...column, render: (row: WhRec) => <span>
      <button type="button" className="kgd-link" onClick={() => printBills([row])}>打印</button>
      {deletable(row) && config.listPath && <> <button type="button" className="kgd-link" onClick={() => removeBills([row])}>删除</button></>}
    </span> };
    return column;
  });
  return <>
    <ListFrame pageKey={config.pageKey} showMobileCard={MOBILE_CARD_BILLS.has(pathname)} {...billExt.props} columns={columns} rows={rows} loading={remote.loading} error={remote.error}
      queryFields={config.queryFields} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      chips={[...(objectType ? [{ key: 'approval', label: '审核状态', options: auditChipOptions(counts.data) }] : []), ...(config.draftChips ?? [])]}
      rowSelection={{ selected, onChange: setSelected }}
      chipValue={list.chips} onChip={list.onChip}
      toolbar={<>{addButton}<Dropdown disabled={!selected.length} menu={{ items: [
        ...(approver.data?.approver ? [{ key: 'audit', label: '批量审核', onClick: () => setBatch(true) }] : []),
        { key: 'print', label: '批量打印', onClick: () => printBills(rows.filter((row) => selected.includes(String(row.id)))) },
        ...(config.listPath ? [{ key: 'delete', label: '批量删除', danger: true, onClick: () => removeBills(rows.filter((row) => selected.includes(String(row.id)))) }] : []),
      ] }}><Button disabled={!selected.length}>批量操作</Button></Dropdown></>}
      page={list.page} pageSize={30} total={rows.length} onPage={list.onPage}
      defaultVisible={config.defaultVisible}
      summary={config.noSummary ? undefined : (summaryParts.length ? <SummaryBar parts={summaryParts} /> : undefined)} />
    {billExt.dialog}
    {modal === 'receipt' && <PurchaseReceiptModal seed={modalSeed} onClose={() => setModal(null)} />}
    {modal === 'return' && <PurchaseReturnModal onClose={() => setModal(null)} />}
    {modal === 'shipment' && <ShipmentModal seed={modalSeed} onClose={() => setModal(null)} />}
    {modal === 'fg' && <FgReceiptModal workOrderId={sourceId || undefined} onClose={close} />}
    {modal === 'issue' && <MaterialIssueModal workOrderId={sourceId || undefined} onClose={close} />}
    {modal === 'semi' && <SemiFgModal onClose={() => setModal(null)} />}
    {modal === 'prodReturn' && <ProdReturnModal onClose={() => setModal(null)} />}
    {modal === 'salesReturn' && <SalesReturnModal mode={salesReturnMode} onClose={() => setModal(null)} />}
    {modal === 'elseIn' && <ElseInModal onClose={() => setModal(null)} />}
    {modal === 'elseOut' && <ElseOutModal onClose={() => setModal(null)} />}
    {modal === 'transfer' && <TransferModal onClose={() => setModal(null)} />}
    {modal === 'taking' && <StockTakingModal mode={takingMode} onClose={() => setModal(null)} />}
    {modal === 'direct' && <DirectShipmentModal onClose={() => setModal(null)} />}
    {modal === 'shipmentReturn' && <ShipmentReturnModal onClose={() => setModal(null)} />}
    {modal === 'outIn' && <OutsourceBillModal kind="in" orderId={sourceId || undefined} onClose={close} />}
    {modal === 'outOut' && <OutsourceBillModal kind="out" orderId={sourceId || undefined} onClose={close} />}
    {modal === 'outReturn' && <OutsourceBillModal kind="return" orderId={sourceId || undefined} onClose={close} />}
    {auditId && objectType && <AuditDetailModal objectType={objectType} objectId={auditId} onClose={() => setAuditId('')} />}
    {batch && objectType && <BatchAuditModal objectType={objectType} ids={[...new Set(selected.map((item) => item.split(':')[0]!))]} onClose={() => setBatch(false)} />}
  </>;
}
