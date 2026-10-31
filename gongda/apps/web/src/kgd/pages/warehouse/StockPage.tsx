import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Drawer, Switch, Table } from 'antd';
import { useRemote } from '../../../masterTools';
import { ListFrame, type ListColumn } from '../../ListFrame';
import { sumYuan, useQueryState } from '../../kit';
import { cmpQty, moneyOf, qtyText } from '../../qty';
import { useWarehouseApi } from './useWarehouseApi';
import type { WhRec } from './useWarehouseApi';
import { SummaryBar } from '../money/shared';

type BalanceRow = WhRec;
type ProductRow = WhRec & { stock_lower_warn?: string | null; stock_upper_warn?: string | null };

function stockAlarm(onHand: string, product?: ProductRow): 'low' | 'high' | null {
  const low = String(product?.stock_lower_warn ?? '').trim();
  const high = String(product?.stock_upper_warn ?? '').trim();
  if (low && cmpQty(onHand, low) < 0) return 'low';
  if (high && cmpQty(onHand, high) > 0) return 'high';
  return null;
}

function StockQtyCell({ onHand, alarm }: { onHand: string; alarm: 'low' | 'high' | null }) {
  return <span>{qtyText(onHand)}{alarm === 'low' ? <span className="wh-stock-alarm">⚠下限</span> : null}{alarm === 'high' ? <span className="wh-stock-alarm high">⚠上限</span> : null}</span>;
}

export function StockPage() {
  const api = useWarehouseApi();
  const list = useQueryState();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'warehouse' | 'product'>('warehouse');
  const [onlyStock, setOnlyStock] = useState(true);
  const [distOpen, setDistOpen] = useState<BalanceRow | null>(null);
  const alarmTab = list.chips.alarm ?? 'all';
  const url = `/api/warehouse/stock/balances?view=${tab === 'product' ? 'product' : 'warehouse'}&only_positive=${onlyStock ? 'true' : 'false'}`;
  const balances = useRemote<{ items: BalanceRow[] }>(url, api.revision, api.onExpired);
  const products = useRemote<{ items: ProductRow[] }>('/api/products?page=1&page_size=500', api.revision, api.onExpired);
  const productOf = (id: string) => products.data?.items.find((p) => String(p.id) === id);
  const rows = useMemo(() => (balances.data?.items ?? []).map((row, index) => ({
    ...(row as BalanceRow),
    id: tab === 'product' ? String(row.product_id ?? index) : `${row.warehouse_id}:${row.product_id}`,
  } as BalanceRow)).filter((row) => {
    if ((list.query.product ?? '') && !`${row.product_name ?? ''}${row.product_code ?? ''}`.includes(list.query.product ?? '')) return false;
    if ((list.query.category ?? '') && !(productOf(String(row.product_id ?? ''))?.category_name ?? '').includes(list.query.category ?? '')) return false;
    if (tab === 'warehouse' && (list.query.warehouse ?? '') && !`${row.warehouse_code ?? ''}${row.warehouse_name ?? ''}`.includes(list.query.warehouse ?? '')) return false;
    if (tab === 'warehouse' && alarmTab !== 'all') {
      const alarm = stockAlarm(String(row.on_hand ?? '0'), productOf(String(row.product_id ?? '')));
      if (alarmTab === 'low' && alarm !== 'low') return false;
      if (alarmTab === 'high' && alarm !== 'high') return false;
    }
    return true;
  }), [balances.data, list.query, tab, alarmTab, products.data]);
  const totals = useMemo(() => {
    const qty = rows.reduce((n, row) => n + Number(row.on_hand ?? 0), 0);
    const costParts = rows.map((row) => moneyOf(String(row.on_hand ?? '0'), String(productOf(String(row.product_id ?? ''))?.cost_price ?? '0')));
    const saleParts = rows.map((row) => moneyOf(String(row.on_hand ?? '0'), String(productOf(String(row.product_id ?? ''))?.sale_price ?? '0')));
    return { qty: qtyText(String(qty)), cost: sumYuan(costParts), sale: sumYuan(saleParts) };
  }, [rows, products.data]);
  const warehouseCols: ListColumn<WhRec>[] = [
    { key: 'warehouse', title: '仓库', render: (row) => row.warehouse_code ?? row.warehouse_name },
    { key: 'product', title: '商品', render: (row) => <button type="button" className="kgd-link" onClick={() => navigate(`/goods/detail/${row.product_id}`)}>{String(row.product_name ?? '')}</button> },
    { key: 'code', title: '商品编号', render: (row) => row.product_code },
    { key: 'spec', title: '商品规格', render: (row) => productOf(String(row.product_id ?? ''))?.specification ?? '' },
    { key: 'image', title: '商品图片', render: () => '' },
    { key: 'category', title: '商品类别', render: (row) => productOf(String(row.product_id ?? ''))?.category_name ?? '' },
    { key: 'cost', title: '成本单价(元)', render: (row) => productOf(String(row.product_id ?? ''))?.cost_price ?? '' },
    { key: 'costAmount', title: '成本金额(元)', render: (row) => moneyOf(String(row.on_hand ?? '0'), String(productOf(String(row.product_id ?? ''))?.cost_price ?? '0')) },
    { key: 'sale', title: '销售单价(元)', render: (row) => productOf(String(row.product_id ?? ''))?.sale_price ?? '' },
    { key: 'saleAmount', title: '销售金额(元)', render: (row) => moneyOf(String(row.on_hand ?? '0'), String(productOf(String(row.product_id ?? ''))?.sale_price ?? '0')) },
    { key: 'onHand', title: '库存', render: (row) => <StockQtyCell onHand={String(row.on_hand ?? '0')} alarm={stockAlarm(String(row.on_hand ?? '0'), productOf(String(row.product_id ?? '')))} /> },
    { key: 'unit', title: '商品单位', render: (row) => productOf(String(row.product_id ?? ''))?.unit_name ?? '' },
    { key: 'source', title: '商品来源', render: (row) => { const a = productOf(String(row.product_id ?? ''))?.attribute; return a === 'manufactured' ? '自产' : a === 'purchased' ? '外购' : ''; } },
    { key: 'min', title: '下限警告值', render: (row) => productOf(String(row.product_id ?? ''))?.stock_lower_warn ?? '' },
    { key: 'max', title: '上限警告值', render: (row) => productOf(String(row.product_id ?? ''))?.stock_upper_warn ?? '' },
    { key: 'stale', title: '呆滞警告值', render: (row) => productOf(String(row.product_id ?? ''))?.stale_days ?? '' },
    { key: 'transit', title: '在途数', render: () => '' },
  ];
  const productCols: ListColumn<WhRec>[] = [
    { key: 'product', title: '商品', render: (row) => <button type="button" className="kgd-link" onClick={() => navigate(`/goods/detail/${row.product_id}`)}>{String(row.product_name ?? '')}</button> },
    { key: 'code', title: '商品编号', render: (row) => row.product_code },
    { key: 'spec', title: '商品规格', render: (row) => productOf(String(row.product_id ?? ''))?.specification ?? '' },
    { key: 'category', title: '商品类别', render: (row) => productOf(String(row.product_id ?? ''))?.category_name ?? '' },
    { key: 'unit', title: '商品单位', render: (row) => productOf(String(row.product_id ?? ''))?.unit_name ?? '' },
    { key: 'cost', title: '成本单价(元)', render: (row) => productOf(String(row.product_id ?? ''))?.cost_price ?? '' },
    { key: 'costAmount', title: '成本金额(元)', render: (row) => moneyOf(String(row.on_hand ?? '0'), String(productOf(String(row.product_id ?? ''))?.cost_price ?? '0')) },
    { key: 'sale', title: '销售单价(元)', render: (row) => productOf(String(row.product_id ?? ''))?.sale_price ?? '' },
    { key: 'saleAmount', title: '销售金额(元)', render: (row) => moneyOf(String(row.on_hand ?? '0'), String(productOf(String(row.product_id ?? ''))?.sale_price ?? '0')) },
    { key: 'source', title: '商品来源', render: (row) => { const a = productOf(String(row.product_id ?? ''))?.attribute; return a === 'manufactured' ? '自产' : a === 'purchased' ? '外购' : ''; } },
    { key: 'dist', title: '库存分布', render: (row) => <button type="button" className="kgd-link" onClick={() => setDistOpen(row)}>查看</button> },
    { key: 'occupy', title: '占用分布', render: (row) => <button type="button" className="kgd-link" onClick={() => setDistOpen(row)}>查看</button> },
    { key: 'onHand', title: '总库存', render: (row) => qtyText(String(row.on_hand ?? '0')) },
    { key: 'reserved', title: '占用库存', render: (row) => qtyText(String(row.reserved_qty ?? row.reserved ?? '0')) },
    { key: 'blocked', title: '锁定库存', render: (row) => qtyText(String(row.blocked_qty ?? '0')) },
    { key: 'available', title: '可用库存', render: (row) => qtyText(String(row.available_qty ?? '0')) },
    { key: 'transit', title: '在途数', render: () => '' },
    { key: 'pendingShip', title: '待发货数', render: () => '' },
    { key: 'pendingPick', title: '待领料数', render: () => '' },
  ];
  const columns = tab === 'product' ? productCols : warehouseCols;
  return <>
    <div className="wh-stock-tabs">
      <button type="button" className={tab === 'warehouse' ? 'on' : ''} onClick={() => setTab('warehouse')}>仓库库存</button>
      <button type="button" className={tab === 'product' ? 'on' : ''} onClick={() => setTab('product')}>商品库存</button>
      <label style={{ marginLeft: 16 }}><Switch checked={onlyStock} onChange={setOnlyStock} /> 只看有库存</label>
    </div>
    <ListFrame pageKey={`goods-stock-${tab}`} columns={columns} rows={rows} loading={balances.loading} error={balances.error}
      chips={tab === 'warehouse' ? [
        { key: 'alarm', label: '报警', options: [{ value: 'all', label: '全部' }, { value: 'low', label: '下限报警' }, { value: 'high', label: '上限报警' }] },
        { key: 'stale', label: '呆滞', missing: true, options: [{ value: 'all', label: '全部' }, { value: 'stale', label: '呆滞物料' }, { value: 'ok', label: '正常物料' }] },
        { key: 'source', label: '来源', options: [{ value: 'all', label: '全部' }, { value: 'manufactured', label: '自产' }, { value: 'purchased', label: '外购' }] },
      ] : [{ key: 'source', label: '来源', options: [{ value: 'all', label: '全部' }, { value: 'manufactured', label: '自产' }, { value: 'purchased', label: '外购' }] }]}
      chipValue={{ ...list.chips, alarm: alarmTab }} onChip={list.onChip}
      queryFields={[{ key: 'warehouse', label: '仓库', missing: tab === 'product' }, { key: 'product', label: '商品', placeholder: '商品名/简拼/编号/规格' }, { key: 'category', label: '商品类别' }]}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      applySpecColumns={tab === 'warehouse'}
      showMobileCard
      mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={{ list: columns.filter((column) => column.key !== 'actions').map((column) => ({ key: column.key, label: column.title })) }}
      summary={<SummaryBar parts={[['库存数量总计', totals.qty], ['总成本金额', totals.cost], ['总销售金额', totals.sale]]} />} />
    <Drawer open={!!distOpen} onClose={() => setDistOpen(null)} title="库存分布" width={420}>
      <Table size="small" pagination={false} rowKey="id" dataSource={rows.filter((r) => r.product_id === distOpen?.product_id)} columns={[{ title: '仓库', dataIndex: 'warehouse_code' }, { title: '数量', render: (_, row) => qtyText(String(row.on_hand ?? '0')) }]} />
    </Drawer>
  </>;
}
