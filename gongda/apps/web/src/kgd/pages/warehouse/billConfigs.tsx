import type { ReactNode } from 'react';
import { beijingTime } from '../../kit';
import type { ListColumn, QueryField } from '../../ListFrame';
import { qtyText } from '../../qty';
import type { WhRec } from './useWarehouseApi';
import { centsYuan, flattenReceipts, spanCell, sumLinesQty, whName } from './shared';

export type BillConfig = {
  pageKey: string;
  title: string;
  listPath?: string;
  listQuery?: (q: Record<string, string>) => string;
  flatten?: (items: WhRec[]) => WhRec[];
  summary?: (items: WhRec[]) => [string, string][];
  queryFields: QueryField[];
  columns: ListColumn<WhRec>[];
  defaultVisible?: string[];
  addLabel?: string;
  addDropdown?: { key: string; label: string }[];
  pdaCard?: boolean;
  noSummary?: boolean;
  draftChips?: { key: string; label: string; options: { value: string; label: string }[] }[];
};

const receiptHead = new Set(['code', 'order', 'inbound_type', 'warehouse', 'audit', 'auditDetail', 'amount', 'date', 'note', 'receiver', 'creator', 'created', 'actions']);
const actionCol: ListColumn<WhRec> = { key: 'actions', title: '操作', width: 200, render: () => <span><button type="button" className="kgd-link">打印</button> <button type="button" className="kgd-link">修改</button> <button type="button" className="kgd-link">删除</button></span> };
const auditDetailCol: ListColumn<WhRec> = { key: 'auditDetail', title: '审核详情', render: () => <button type="button" className="kgd-link">查看</button> };
const whenCreated = (row: WhRec) => beijingTime(row.created_at ?? '', '');

function receiptSummary(qtyLabel: string, amountLabel: string) {
  return (items: WhRec[]): [string, string][] => {
    let qty = 0;
    let amount = 0n;
    items.forEach((head) => (head.lines as WhRec[] | undefined)?.forEach((line) => {
      qty += Number(line.quantity ?? 0);
      amount += BigInt(String(line.amount_cents ?? '0').split('.')[0] ?? '0');
    }));
    return [[qtyLabel, String(qty)], [amountLabel, centsYuan(amount.toString())]];
  };
}

function spanCol(key: string, title: string, heads: Set<string>, render: (row: WhRec) => ReactNode): ListColumn<WhRec> {
  return { key, title, ...spanCell(key, heads, render) };
}

export const billPathConfigs: Record<string, BillConfig> = {
  '/purchase_stock_in_bill/list': {
    pageKey: 'purchase-stock-in',
    title: '采购入库单',
    listPath: '/api/warehouse/purchase-receipts',
    flatten: flattenReceipts,
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '采购入库单号' }, { key: 'order', label: '采购单号' }, { key: 'warehouse', label: '入库仓库' }],
    defaultVisible: ['code', 'order', 'inbound_type', 'warehouse', 'audit', 'amount', 'date', 'receiver', 'actions'],
    summary: receiptSummary('入库总数', '总成本金额'),
    columns: [
      spanCol('code', '采购入库单号', receiptHead, (row) => <span className="kgd-link">{String(row.code ?? '')}</span>),
      spanCol('order', '采购单号', receiptHead, (row) => row.order_code ?? row.purchase_order_code ?? ''),
      { key: 'image', title: '商品图片', render: () => '' },
      spanCol('inbound_type', '入库类型', receiptHead, (row) => row.inbound_type),
      spanCol('warehouse', '入库仓库', receiptHead, (row) => row.warehouse_name ?? row.warehouse_id),
      spanCol('audit', '审核状态', receiptHead, (row) => row.audit_status),
      spanCol('auditDetail', '审核详情', receiptHead, () => <button type="button" className="kgd-link">查看</button>),
      spanCol('amount', '成本总额(元)', receiptHead, (row) => centsYuan(row.amount_cents)),
      spanCol('date', '入库日期', receiptHead, (row) => row.receipt_date),
      spanCol('note', '备注', receiptHead, (row) => row.note),
      spanCol('receiver', '收货人', receiptHead, () => ''),
      spanCol('creator', '创建人', receiptHead, () => ''),
      spanCol('created', '创建时间', receiptHead, whenCreated),
      spanCol('actions', '操作', receiptHead, () => <span><button type="button" className="kgd-link">打印</button> <button type="button" className="kgd-link">修改</button> <button type="button" className="kgd-link">删除</button></span>),
    ],
    addLabel: '+ 新增',
  },
  '/produce_stock_in_bill/list': {
    pageKey: 'produce-stock-in',
    title: '成品入库单',
    listPath: '/api/warehouse/fg-receipts',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '入库单号' }, { key: 'warehouse', label: '入库仓库' }],
    summary: (items) => [['入库总数', String(items.reduce((n, row) => n + Number(row.quantity ?? 0), 0))], ['总成本金额', '0']],
    defaultVisible: ['code', 'inbound_type', 'warehouse', 'audit', 'amount', 'date', 'actions'],
    addDropdown: [{ key: 'wo', label: '加工单入库' }, { key: 'outsource', label: '外协工单入库' }],
    columns: [
      { key: 'code', title: '入库单号', render: (row) => <span className="kgd-link">{row.code}</span> },
      { key: 'inbound_type', title: '入库类型', render: () => '普通入库' },
      { key: 'warehouse', title: '入库仓库', render: (row) => whName(row) },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status ?? '不需审核' },
      auditDetailCol,
      { key: 'amount', title: '成本总额(元)', render: () => '0' },
      { key: 'date', title: '入库日期', render: (row) => String(row.created_at ?? '').slice(0, 10) },
      { key: 'note', title: '备注', render: () => '' },
      { key: 'mode', title: '操作方式', render: () => '人工' },
      { key: 'report', title: '报工单据', render: () => '' },
      { key: 'amr', title: 'AMR运输详情', render: () => '' },
      { key: 'updater', title: '更新人', render: () => '' },
      { key: 'updated', title: '更新时间', render: () => '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
  },
  '/semi_finished_products_stock_in_bill/list': {
    pageKey: 'semi-finished-in',
    title: '半成品入库单',
    listPath: '/api/warehouse/misc-bills',
    listQuery: () => 'kind=semi_fg_in',
    queryFields: [{ key: 'code', label: '入库单号' }, { key: 'work_order', label: '加工单号' }, { key: 'warehouse', label: '入库仓库' }],
    summary: () => [['入库总数', '0'], ['总成本金额', '0']],
    defaultVisible: ['code', 'inbound_type', 'mode', 'warehouse', 'amount', 'date', 'audit', 'actions'],
    columns: [
      { key: 'code', title: '入库单号', render: (row) => row.code ?? '' },
      { key: 'inbound_type', title: '入库类型', render: () => '' },
      { key: 'mode', title: '入库方式', render: () => '' },
      { key: 'warehouse', title: '入库仓库', render: (row) => whName(row) },
      { key: 'amount', title: '成本总额(元)', render: () => '0' },
      { key: 'date', title: '入库日期', render: (row) => row.receipt_date ?? '' },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status ?? '不需审核' },
      auditDetailCol,
      { key: 'note', title: '备注', render: (row) => row.note ?? '' },
      { key: 'report', title: '报工单据', render: () => '' },
      { key: 'updater', title: '更新人', render: () => '' },
      { key: 'updated', title: '更新时间', render: () => '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
    addLabel: '+ 新增',
  },
  '/produce_return_materiel_bill/list': {
    pageKey: 'produce-return-mat',
    title: '生产退料单',
    listPath: '/api/warehouse/misc-bills',
    listQuery: () => 'kind=prod_return_mat',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '生产退料单号' }, { key: 'warehouse', label: '仓库' }],
    summary: () => [['退料总数', '0'], ['总成本金额', '0']],
    defaultVisible: ['code', 'work_order', 'warehouse', 'date', 'audit', 'actions'],
    addDropdown: [{ key: 'wo', label: '加工单退料' }, { key: 'outsource', label: '外协工单退料' }],
    columns: [
      { key: 'code', title: '生产退料单号', render: (row) => row.code ?? '' },
      { key: 'work_order', title: '加工单/外协工单', render: (row) => row.work_order_code ?? '' },
      { key: 'mode', title: '操作方式', render: () => '' },
      { key: 'inbound_type', title: '入库类型', render: () => '' },
      { key: 'warehouse', title: '仓库', render: (row) => whName(row) },
      { key: 'date', title: '退料日期', render: (row) => row.return_date ?? '' },
      { key: 'qty', title: '退料总数', render: (row) => qtyText(String(row.quantity ?? '0')) },
      { key: 'amount', title: '成本总额(元)', render: () => '0' },
      { key: 'product', title: '商品名', render: () => '' },
      { key: 'line_qty', title: '数量', render: () => '' },
      { key: 'unit', title: '单位', render: () => '' },
      { key: 'amr', title: 'AMR运输详情', render: () => '' },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status ?? '不需审核' },
      auditDetailCol,
      { key: 'note', title: '备注', render: (row) => row.note ?? '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
  },
  '/salesReturnOrder/list': {
    pageKey: 'sales-return',
    title: '销售退货单',
    listPath: '/api/warehouse/misc-bills',
    listQuery: () => 'kind=sales_return',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '销售退货单号' }, { key: 'warehouse', label: '仓库' }],
    summary: (items): [string, string][] => {
      let qty = 0;
      let fen = 0n;
      for (const head of items) {
        const lines = (head.lines as WhRec[] | undefined) ?? [];
        if (lines.length) {
          for (const line of lines) {
            qty += Number(line.quantity ?? 0);
            fen += BigInt(String(line.amount_cents ?? '0').split('.')[0] || '0');
          }
        } else {
          qty += Number(head.quantity ?? 0);
          fen += BigInt(String(head.amount_cents ?? '0').split('.')[0] || '0');
        }
      }
      return [['退货总数', String(qty)], ['总销售金额', `${centsYuan(fen.toString())}元`]];
    },
    defaultVisible: ['code', 'contract', 'customer', 'warehouse', 'date', 'qty', 'amount', 'audit', 'actions'],
    addDropdown: [{ key: 'contract', label: '按合同退货' }, { key: 'shipment', label: '按出库退货' }],
    columns: [
      { key: 'code', title: '销售退货单号', render: (row) => row.code ?? '' },
      { key: 'contract', title: '合同', render: (row) => row.contract_code ?? '' },
      { key: 'customer', title: '客户', render: (row) => row.customer_name ?? '' },
      { key: 'contact', title: '联系人', render: () => '' },
      { key: 'address', title: '地址', render: () => '' },
      { key: 'inbound_type', title: '入库类型', render: () => '' },
      { key: 'warehouse', title: '仓库', render: (row) => whName(row) },
      { key: 'date', title: '退货日期', render: (row) => row.return_date ?? '' },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status ?? '不需审核' },
      auditDetailCol,
      { key: 'qty', title: '退货总数', render: (row) => {
        const lines = row.lines as WhRec[] | undefined;
        const total = lines?.length ? lines.reduce((n, line) => n + Number(line.quantity ?? 0), 0) : Number(row.quantity ?? 0);
        return String(total);
      } },
      { key: 'amount', title: '销售总额（元）', render: (row) => centsYuan(row.amount_cents) },
      { key: 'ship_code', title: '销售出库单号', render: () => '' },
      { key: 'product', title: '商品', render: (row) => (row.lines as WhRec[] | undefined)?.[0]?.product_name ?? '' },
      { key: 'product_code', title: '商品编号', render: () => '' },
      { key: 'spec', title: '商品规格', render: () => '' },
      { key: 'line_qty', title: '数量', render: () => '' },
      { key: 'unit', title: '单位', render: () => '' },
      { key: 'price', title: '销售单价(元)', render: () => '' },
      { key: 'line_amount', title: '销售金额(元)', render: () => '' },
      { key: 'note', title: '备注', render: (row) => row.note ?? '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
  },
  '/else_stock_in_bill/list': {
    pageKey: 'else-stock-in',
    title: '其他入库单',
    listPath: '/api/warehouse/misc-bills',
    listQuery: () => 'kind=else_in',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '其他入库单号' }, { key: 'warehouse', label: '仓库' }],
    summary: (items): [string, string][] => [['入库总数', String(sumLinesQty(items as WhRec[], 'quantity'))], ['总成本金额', '0'], ['总销售金额', '0']],
    pdaCard: true,
    defaultVisible: ['code', 'inbound_type', 'warehouse', 'date', 'audit', 'amount', 'actions'],
    columns: [
      { key: 'code', title: '其他入库单号', render: (row) => row.code },
      { key: 'inbound_type', title: '入库类型', render: () => '' },
      { key: 'supplier', title: '供应商', render: () => '' },
      { key: 'warehouse', title: '仓库', render: (row) => whName(row) },
      { key: 'date', title: '入库日期', render: (row) => String(row.created_at ?? '').slice(0, 10) },
      { key: 'audit', title: '审核状态', render: (row) => row.approval ?? row.audit_status },
      auditDetailCol,
      { key: 'cost', title: '成本总额(元)', render: () => '0' },
      { key: 'sale', title: '销售总额(元)', render: () => '0' },
      { key: 'receiver', title: '收货人', render: () => '' },
      { key: 'note', title: '备注', render: (row) => row.reason ?? row.note },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
    addLabel: '+ 新增',
  },
  '/sale_stock_out_bill/list': {
    pageKey: 'sale-stock-out',
    title: '销售出库单',
    listPath: '/api/warehouse/shipments',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '销售出库单号' }, { key: 'contract', label: '合同编号' }],
    summary: () => [['出库总数', '0'], ['总销售金额', '0'], ['总成本金额', '0']],
    defaultVisible: ['code', 'warehouse', 'customer', 'mode', 'date', 'audit', 'actions'],
    addDropdown: [{ key: 'contract', label: '合同出库' }, { key: 'direct', label: '直接出库' }],
    columns: [
      { key: 'code', title: '销售出库单号', render: (row) => row.code },
      { key: 'warehouse', title: '仓库', render: (row) => whName(row) },
      { key: 'customer', title: '客户', render: (row) => row.customer_name },
      { key: 'contact', title: '客户联系人', render: (row) => row.contact_name },
      { key: 'address', title: '客户地址', render: (row) => row.ship_address },
      { key: 'outbound_type', title: '出库类型', render: (row) => row.outbound_type },
      { key: 'mode', title: '出库方式', render: (row) => row.outbound_mode || '合同出库' },
      { key: 'date', title: '出库日期', render: (row) => String(row.ship_date ?? '').slice(0, 10) || '-' },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status },
      auditDetailCol,
      { key: 'qty', title: '出库数量', render: (row) => qtyText(String(sumLinesQty(row.lines as WhRec[]))) },
      { key: 'cost', title: '成本总额(元)', render: () => '0' },
      { key: 'sale', title: '销售总额(元)', render: () => '0' },
      { key: 'contract', title: '合同编号', render: (row) => row.contract_code },
      { key: 'sales', title: '业务员', render: () => '' },
      { key: 'shipper', title: '发货人', render: () => '' },
      { key: 'note', title: '备注', render: (row) => row.note },
      { key: 'product', title: '商品名称', render: () => '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
  },
  '/production_out_of_storage/list': {
    pageKey: 'production-out',
    title: '生产出库单',
    listPath: '/api/warehouse/material-issues',
    queryFields: [{ key: 'code', label: '出库单号' }, { key: 'work_order', label: '加工单/外协工单' }, { key: 'warehouse', label: '仓库' }],
    summary: () => [['出库总数', '0'], ['总成本金额', '0']],
    addDropdown: [{ key: 'wo', label: '加工单出库' }, { key: 'outsource', label: '外协工单出库' }],
    columns: [
      { key: 'code', title: '生产出库单号', render: (row) => row.code },
      { key: 'work_order', title: '加工单/外协工单', render: (row) => row.work_order_code ?? '' },
      { key: 'process', title: '工序', render: () => '' },
      { key: 'mode', title: '操作方式', render: () => '' },
      { key: 'out_wo', title: '出库工单', render: () => '' },
      { key: 'warehouse', title: '仓库', render: (row) => whName(row) },
      { key: 'outbound_type', title: '出库类型', render: () => '' },
      { key: 'date', title: '出库日期', render: (row) => String(row.created_at ?? '').slice(0, 10) },
      { key: 'audit', title: '审核状态', render: (row) => row.approval },
      auditDetailCol,
      { key: 'report', title: '报工单据', render: () => '' },
      { key: 'amr', title: 'AMR运输详情', render: () => '' },
      { key: 'product', title: '商品名称', render: () => '' },
      { key: 'updater', title: '更新人', render: () => '' },
      { key: 'updated', title: '更新时间', render: () => '' },
      { key: 'note', title: '备注', render: () => '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
  },
  '/purchase_return_bill/list': {
    pageKey: 'purchase-return-bill',
    title: '采购退货单',
    listPath: '/api/warehouse/purchase-returns',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '采购退货单号' }, { key: 'order', label: '采购单号' }],
    summary: receiptSummary('退货总数', '总成本金额'),
    defaultVisible: ['code', 'order', 'supplier', 'warehouse', 'date', 'audit', 'actions'],
    columns: [
      { key: 'code', title: '采购退货单号', render: (row) => row.code },
      { key: 'order', title: '采购单号', render: (row) => row.order_code },
      { key: 'supplier', title: '供应商', render: (row) => row.supplier_name },
      { key: 'outbound_type', title: '出库类型', render: () => '' },
      { key: 'warehouse', title: '仓库', render: (row) => whName(row) },
      { key: 'date', title: '退货日期', render: (row) => row.return_date },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status },
      auditDetailCol,
      { key: 'note', title: '备注', render: (row) => row.note },
      { key: 'product', title: '商品名', render: () => '' },
      { key: 'product_note', title: '商品备注', render: () => '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
    addLabel: '+ 新增',
  },
  '/else_stock_out_bill/list': {
    pageKey: 'else-stock-out',
    title: '其他出库单',
    listPath: '/api/warehouse/misc-bills',
    listQuery: () => 'kind=else_out',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '其他出库单号' }, { key: 'warehouse', label: '仓库' }],
    summary: (items): [string, string][] => [['出库总数', String(sumLinesQty(items as WhRec[], 'quantity'))], ['总成本金额', '0'], ['总销售金额', '0']],
    pdaCard: true,
    defaultVisible: ['code', 'outbound_type', 'warehouse', 'date', 'audit', 'actions'],
    columns: [
      { key: 'code', title: '其他出库单号', render: (row) => row.code },
      { key: 'outbound_type', title: '出库类型', render: () => '' },
      { key: 'warehouse', title: '仓库', render: (row) => whName(row) },
      { key: 'date', title: '出库日期', render: (row) => String(row.created_at ?? '').slice(0, 10) },
      { key: 'audit', title: '审核状态', render: (row) => row.approval },
      auditDetailCol,
      { key: 'cost', title: '成本总额(元)', render: () => '0' },
      { key: 'sale', title: '销售总额(元)', render: () => '0' },
      { key: 'shipper', title: '发货人', render: () => '' },
      { key: 'note', title: '备注', render: (row) => row.reason },
      { key: 'category', title: '商品类别', render: () => '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      { key: 'actions', title: '操作', render: () => <span><button type="button" className="kgd-link">打印</button> <button type="button" className="kgd-link">修改</button> <button type="button" className="kgd-link">复制</button> <button type="button" className="kgd-link">删除</button></span> },
    ],
    addLabel: '+ 新增',
  },
  '/stock_allocate_bill/list': {
    pageKey: 'stock-allocate',
    title: '调拨单',
    listPath: '/api/warehouse/transfer-bills',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '调拨单号' }, { key: 'from', label: '发出仓库' }, { key: 'to', label: '收入仓库' }],
    noSummary: true,
    defaultVisible: ['code', 'from', 'to', 'date', 'audit', 'actions'],
    columns: [
      { key: 'code', title: '调拨单号', render: (row) => row.code ?? '' },
      { key: 'from', title: '发出仓库', render: (row) => whName(row, 'from_warehouse_id') },
      { key: 'to', title: '收入仓库', render: (row) => whName(row, 'to_warehouse_id') },
      { key: 'date', title: '调拨日期', render: (row) => row.transfer_date ?? '' },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status ?? '不需审核' },
      auditDetailCol,
      { key: 'transfer', title: '调拨人', render: () => '' },
      { key: 'note', title: '备注', render: (row) => row.note ?? '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
    addLabel: '+ 新增',
  },
  '/stock_taking_bill/list': {
    pageKey: 'stock-taking',
    title: '库存盘点',
    listPath: '/api/warehouse/stock-taking-bills',
    queryFields: [{ key: 'product', label: '商品' }, { key: 'code', label: '盘点单号' }, { key: 'warehouse', label: '盘点仓库' }],
    summary: () => [['差异总数', '0']],
    draftChips: [{ key: 'state', label: '状态', options: [{ value: 'all', label: '全部' }, { value: 'draft', label: '草稿' }] }],
    defaultVisible: ['code', 'warehouse', 'date', 'diff', 'audit', 'actions'],
    addDropdown: [{ key: 'custom', label: '自定义盘库' }, { key: 'full', label: '一键盘库' }],
    columns: [
      { key: 'code', title: '盘点单号', render: (row) => row.code ?? '' },
      { key: 'warehouse', title: '盘点仓库', render: (row) => whName(row) },
      { key: 'date', title: '盘点日期', render: (row) => row.taking_date ?? '' },
      { key: 'diff', title: '差异总数', render: (row) => row.diff_total ?? '0' },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status ?? '不需审核' },
      auditDetailCol,
      { key: 'taker', title: '盘点人', render: () => '' },
      { key: 'note', title: '备注', render: (row) => row.note ?? '' },
      { key: 'creator', title: '创建人', render: () => '' },
      { key: 'created', title: '创建时间', render: whenCreated },
      actionCol,
    ],
  },
};

export function defaultBillConfig(pathname: string): BillConfig {
  const title = pathname.split('/')[1]?.replace(/_/g, ' ') ?? '单据';
  return {
    pageKey: pathname.replace(/\//g, '-'),
    title,
    queryFields: [{ key: 'code', label: '单号' }, { key: 'warehouse', label: '仓库' }],
    columns: [
      { key: 'code', title: '单号', render: (row) => row.code ?? '' },
      { key: 'warehouse', title: '仓库', render: (row) => whName(row) },
      { key: 'audit', title: '审核状态', render: (row) => row.audit_status ?? '不需审核' },
      { key: 'created', title: '创建时间', render: (row) => String(row.created_at ?? '') },
      actionCol,
    ],
    addLabel: '+ 新增',
  };
}

export function configForPath(pathname: string): BillConfig {
  return billPathConfigs[pathname] ?? defaultBillConfig(pathname);
}

export const warehouseBillPaths = new Set([
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
  '/stock_allocate_bill/list',
  '/stock_taking_bill/list',
]);

export { receiptHead };
