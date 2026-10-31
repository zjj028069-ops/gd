import { useMemo } from 'react';
import { useRemote } from '../../../masterTools';
import { ListFrame, type ListColumn } from '../../ListFrame';
import { formatDate } from '../../../shared';
import { useQueryState, when } from '../../kit';
import { qtyText } from '../../qty';
import { SummaryBar } from '../money/shared';
import { useWarehouseApi } from './useWarehouseApi';
import type { WhRec } from './useWarehouseApi';

const docTypeOptions = [
  { value: '', label: '全部' },
  { value: 'purchase_receipt', label: '采购入库' },
  { value: 'purchase_return', label: '采购退货' },
  { value: 'shipment', label: '销售出库' },
  { value: 'sales_return', label: '销售退货' },
  { value: 'fg_receipt', label: '成品入库' },
  { value: 'material_issue', label: '生产出库' },
  { value: 'transfer_bill', label: '调拨' },
  { value: 'stock_count', label: '盘点' },
  { value: 'else_in', label: '其他入库' },
  { value: 'else_out', label: '其他出库' },
  { value: 'adjustment', label: '其他入出库' },
];

export function LedgerPage() {
  const api = useWarehouseApi();
  const list = useQueryState();
  const qs = new URLSearchParams();
  const set = (key: string, value?: string) => { if (value) qs.set(key, value); };
  set('q', list.query.product);
  set('seq_no', list.query.seq);
  set('doc_code', list.query.doc);
  set('warehouse_id', list.query.warehouse_id);
  set('in_warehouse_id', list.query.in_warehouse_id);
  set('out_warehouse_id', list.query.out_warehouse_id);
  set('direction', list.query.direction);
  set('source_type', list.query.source_type);
  set('work_order_id', list.query.work_order);
  set('posted_from', list.query.from);
  set('posted_to', list.query.to);
  set('biz_from', list.query.biz_from);
  set('biz_to', list.query.biz_to);
  set('category_id', list.query.category_id);
  const ledger = useRemote<{ items: WhRec[]; summary?: { inbound_qty: string; outbound_qty: string } }>(`/api/warehouse/stock/ledger?${qs}`, api.revision, api.onExpired);
  const warehouses = useRemote<{ items: WhRec[] }>('/api/warehouse/warehouses', api.revision, api.onExpired);
  const categories = useRemote<{ items: WhRec[] }>('/api/products/categories?kind=goods', api.revision, api.onExpired);
  const whOptions = (warehouses.data?.items ?? []).filter((w) => w.active !== false).map((w) => ({ value: String(w.id), label: String(w.name ?? w.code) }));
  const catOptions = (categories.data?.items ?? []).map((c) => ({ value: String(c.id), label: String(c.name) }));
  const rows = ledger.data?.items ?? [];
  const columns: ListColumn<WhRec>[] = [
    { key: 'code', title: '流水编号', render: (row) => String(row.ledger_code ?? row.seq_no ?? '') },
    { key: 'doc', title: '出入库单号', render: (row) => row.doc_code ?? '' },
    { key: 'product', title: '商品', render: (row) => row.product_name },
    { key: 'pcode', title: '商品编号', render: (row) => row.product_code },
    { key: 'spec', title: '规格', render: (row) => row.product_spec ?? row.specification },
    { key: 'category', title: '商品类别', render: (row) => row.category_name },
    { key: 'image', title: '商品图片', render: () => '' },
    { key: 'kind', title: '类别', render: (row) => row.stock_kind ?? (row.direction === 'out' ? '出库' : '入库') },
    { key: 'stockType', title: '库存类型', render: (row) => row.stock_type ?? '' },
    { key: 'docType', title: '单据类型', render: (row) => row.doc_type },
    { key: 'order', title: '关联工单', render: (row) => row.work_order_code ?? '' },
    { key: 'qty', title: '数量', render: (row) => `${row.direction === 'out' ? '-' : ''}${qtyText(String(row.quantity ?? '0'))}` },
    { key: 'balance', title: '结余', render: (row) => qtyText(String(row.balance_after ?? '0')) },
    { key: 'cost', title: '成本单价(元)', render: (row) => row.cost_unit_price ?? '' },
    { key: 'costAmount', title: '成本金额(元)', render: (row) => row.cost_amount ?? '' },
    { key: 'sale', title: '销售单价(元)', render: (row) => row.sale_unit_price ?? '' },
    { key: 'saleAmount', title: '销售金额(元)', render: (row) => row.sale_amount ?? '' },
    { key: 'unit', title: '单位', render: (row) => row.unit_name },
    { key: 'inWh', title: '入库仓库', render: (row) => row.in_warehouse_name ?? (row.direction === 'in' ? row.warehouse_name : '') },
    { key: 'outWh', title: '出库仓库', render: (row) => row.out_warehouse_name ?? (row.direction === 'out' ? row.warehouse_name : '') },
    { key: 'actor', title: '操作人', render: (row) => row.operator_name ?? '' },
    { key: 'note', title: '备注', render: (row) => row.remark ?? '' },
    { key: 'bizDate', title: '出入库日期', render: (row) => formatDate(String(row.biz_date ?? '')) },
    { key: 'time', title: '操作时间', render: (row) => when(String(row.posted_at ?? '')) },
  ];
  const queryFields = useMemo(() => [
    { key: 'product', label: '商品', placeholder: '商品名/简拼/编号/规格' },
    { key: 'category_id', label: '商品类别', kind: 'select' as const, options: catOptions },
    { key: 'seq', label: '流水编号' },
    { key: 'doc', label: '出入库单号' },
    { key: 'in_warehouse_id', label: '入库仓库', kind: 'select' as const, options: whOptions },
    { key: 'out_warehouse_id', label: '出库仓库', kind: 'select' as const, options: whOptions },
    { key: 'warehouse_id', label: '仓库', kind: 'select' as const, options: whOptions },
    { key: 'direction', label: '类别', kind: 'select' as const, options: [{ value: '', label: '全部' }, { value: 'in', label: '入库' }, { value: 'out', label: '出库' }] },
    { key: 'source_type', label: '单据类型', kind: 'select' as const, options: docTypeOptions },
    { key: 'work_order', label: '关联工单' },
    { key: 'from', label: '开始时间', kind: 'date' as const },
    { key: 'to', label: '结束时间', kind: 'date' as const },
    { key: 'biz_from', label: '出入库日期起', kind: 'date' as const },
    { key: 'biz_to', label: '出入库日期止', kind: 'date' as const },
  ], [whOptions, catOptions]);
  return <ListFrame pageKey="stock-item-ledger" columns={columns} rows={rows} loading={ledger.loading} error={ledger.error} clientPaging={false}
    queryFields={queryFields}
    queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    page={list.page} pageSize={30} total={rows.length} onPage={list.onPage}
    summary={<SummaryBar parts={[['累计出库数量', qtyText(String(ledger.data?.summary?.outbound_qty ?? '0'))], ['累计入库数量', qtyText(String(ledger.data?.summary?.inbound_qty ?? '0'))]]} />} />;
}
