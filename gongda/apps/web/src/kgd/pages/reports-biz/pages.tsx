import { useState } from 'react';
import { Switch } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import type { ListColumn, QueryField } from '../../ListFrame';
import { useQueryState } from '../../kit';
import { dash, RedSummary, StatusTag } from '../round8/kit';
import { StatementLineModal, StatementPrintModal } from './statement-actions';

type Rec = Record<string, string | number> & { id: string };

function periodBar(value: string, onChange: (value: string) => void, names = ['昨天', '今天', '本周', '本月', '本季度', '本年']) {
  return <div className="kgd-chips"><b>统计时间</b>{names.map((item) => <button key={item} type="button" className={`kgd-chip ${value === item ? 'on' : ''}`} onClick={() => onChange(item)}>{item}</button>)}</div>;
}

function col(key: string, title: string, field?: string): ListColumn<Rec> {
  const source = field ?? key;
  return { key, title, render: (row) => dash(row[source]) };
}

export function SalesStatement() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const [period, setPeriod] = useState('本月');
  const [debt, setDebt] = useState('全部');
  const [line, setLine] = useState<{ kind: 'outbound' | 'return'; id: string } | null>(null);
  const [printRow, setPrintRow] = useState<Rec | null>(null);
  const remote = useRemote<{ items: Rec[]; summary: Record<string, string | number> }>(`/api/biz-reports/sales?period=${encodeURIComponent(period)}&debt=${encodeURIComponent(debt)}`, revision, onExpired);
  const summary = remote.data?.summary;
  const columns: ListColumn<Rec>[] = [
    col('customer_code', '客户编号'),
    col('customer_name', '客户'),
    col('tag', '客户标签', 'customer_tag'),
    col('contact_name', '联系人'),
    col('contact_phone', '联系人电话'),
    col('address', '地址'),
    { key: 'enabled', title: '启用/禁用', render: (row) => dash(row.enabled_text || row.enabled) },
    col('owner', '负责人', 'owner_name'),
    col('receive_progress', '收款进度'),
    col('outbound_progress', '出库进度'),
    col('contract_count', '合同数量'),
    col('product_qty', '商品总数', 'qty'),
    col('outbound_qty', '出库数'),
    col('unoutbound_qty', '未出库数'),
    col('return_qty', '退货数'),
    col('amount', '合同金额（元）'),
    col('received', '已收款（元）'),
    col('debt', '欠款（元）'),
    col('outbound_amount', '出库金额（元）'),
    col('return_amount', '退货金额（元）'),
    col('uninvoiced', '未开票（元）'),
    col('invoiced', '累计开票（元）'),
    {
      key: 'actions', title: '操作', width: 248,
      render: (row) => row?.id ? <span className="stmt-row-actions" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="kgd-link" onClick={() => setLine({ kind: 'outbound', id: String(row.id) })}>出库明细</button>
        <button type="button" className="kgd-link" onClick={() => setLine({ kind: 'return', id: String(row.id) })}>退货明细</button>
        <button type="button" className="kgd-link" onClick={() => setPrintRow(row)}>打印</button>
      </span> : null,
    },
  ];
  const queryFields: QueryField[] = [
    { key: 'customer_code', label: '客户编号' }, { key: 'customer', label: '客户名' },
    { key: 'contact', label: '联系人' }, { key: 'phone', label: '联系人电话' },
    { key: 'address', label: '地址' }, { key: 'enabled', label: '启用/禁用' },
    { key: 'tag', label: '客户标签' }, { key: 'owner', label: '负责人' },
  ];
  return <div>
    {periodBar(period, setPeriod)}
    <div className="kgd-chips"><b>是否欠款</b>{['全部', '有欠款', '无欠款'].map((item) => <button key={item} type="button" className={`kgd-chip ${debt === item ? 'on' : ''}`} onClick={() => setDebt(item)}>{item}{summary ? `(${item === '有欠款' ? summary.debt_count : item === '无欠款' ? summary.clear_count : Number(summary.debt_count) + Number(summary.clear_count)})` : ''}</button>)}</div>
    {summary && <RedSummary parts={[
      ['合同总数', summary.contracts ?? summary.contract_count ?? '-'],
      ['商品总数', summary.qty ?? summary.product_qty ?? '-'],
      ['出库数', summary.outbound ?? summary.outbound_qty ?? '-'],
      ['未出库数', summary.unoutbound ?? summary.unoutbound_qty ?? '-'],
      ['退货数', summary.return_qty ?? '-'],
      ['合同金额', summary.amount ?? '-'],
      ['已收款', summary.received ?? '-'],
      ['欠款金额', summary.debt ?? '-'],
      ['出库金额', summary.outbound_amount ?? '-'],
      ['退货金额', summary.return_amount ?? '-'],
      ['未开票', summary.uninvoiced ?? '-'],
      ['累计开票', summary.invoiced ?? '-'],
    ]} />}
    <ListFrame
      pageKey="sales-statement"
      exportName="销售对账单"
      columns={columns}
      rows={remote.data?.items ?? []}
      loading={remote.loading}
      error={remote.error}
      queryFields={queryFields}
      queryValue={list.draft}
      onQuery={list.onQuery}
      onSearch={list.onSearch}
      onClear={list.onClear}
      showMobileCard={false}
      showAdvancedSearch={false}
      page={list.page}
      pageSize={list.pageSize}
      total={remote.data?.items.length ?? 0}
      onPage={list.onPage}
    />
    {line && <StatementLineModal kind={line.kind} customerId={line.id} period={period} onClose={() => setLine(null)} />}
    {printRow && <StatementPrintModal row={printRow} period={period} onClose={() => setPrintRow(null)} />}
  </div>;
}

export function ContractReport() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[]; summary: Record<string, string> }>('/api/biz-reports/contracts', revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    col('code', '合同编号'),
    col('customer_name', '客户'),
    col('product_name', '商品'),
    col('product_code', '商品编号'),
    col('specification', '商品规格'),
    col('unit_name', '单位'),
    col('product_image', '商品图片'),
    col('category_name', '商品类别'),
    col('unit_price', '商品单价'),
    col('quantity', '销售数量'),
    col('discount', '折扣'),
    col('discount_amount', '优惠金额'),
    col('net_amount', '折后金额'),
    col('product_note', '商品备注'),
    col('product_attachment', '商品附件'),
    col('shipped_qty', '已出库数量'),
    col('unshipped_qty', '未出库数量'),
    col('delivery_date', '合同交货日期'),
    col('created_at', '创建时间'),
  ];
  const summary = remote.data?.summary;
  return <div>
    {summary && <RedSummary parts={[
      ['折后总金额', summary.net_amount ?? '-'],
      ['销售数量', summary.qty ?? '-'],
      ['已出库数量', summary.shipped ?? '-'],
      ['未出库数量', summary.unshipped ?? '-'],
    ]} />}
    <ListFrame
      pageKey="contract-report"
      exportName="合同报表"
      columns={columns}
      rows={remote.data?.items ?? []}
      loading={remote.loading}
      error={remote.error}
      queryFields={[
        { key: 'customer', label: '客户' }, { key: 'code', label: '合同编号' },
        { key: 'product', label: '商品名' }, { key: 'product_code', label: '商品编号' },
        { key: 'spec', label: '商品规格' }, { key: 'unit', label: '单位' },
        { key: 'category', label: '商品类别' },
        { key: 'created_from', label: '创建时间起', kind: 'date' }, { key: 'created_to', label: '创建时间止', kind: 'date' },
      ]}
      queryValue={list.draft}
      onQuery={list.onQuery}
      onSearch={list.onSearch}
      onClear={list.onClear}
      page={list.page}
      pageSize={list.pageSize}
      total={remote.data?.items.length ?? 0}
      onPage={list.onPage}
    />
  </div>;
}

export function CostReport() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const code = String(list.query.code ?? '').trim();
  const qs = new URLSearchParams({ page: String(list.page), page_size: String(list.pageSize) });
  if (code) qs.set('code', code);
  const remote = useRemote<{ items: Rec[]; summary: Record<string, string>; total?: number }>(`/api/report-extra/cost?${qs}`, revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    col('code', '加工单号'),
    col('project_code', '项目编号'),
    col('product_name', '商品'),
    col('product_code', '商品编号'),
    col('specification', '商品规格'),
    col('category_name', '商品类别'),
    col('product_image', '商品图片'),
    col('plan_code', '生产计划编号'),
    col('plan_name', '生产计划名称'),
    col('contract_code', '合同编号'),
    col('salesman', '业务员'),
    col('plan_qty', '计划数'),
    col('delivery_date', '交货日期'),
    col('priority', '优先级'),
    col('total_hours', '加工单总工时'),
    col('note', '备注'),
    col('attachment', '附件'),
    col('plan_start', '计划开始'),
    col('plan_end', '计划结束'),
    col('actual_qty', '实际生产数'),
    col('labor', '人工费用'),
    col('material', '材料费用(估算)'),
    col('outsource', '外协费用'),
    col('total', '合计成本'),
    col('output_value', '生产总值'),
    col('profit', '毛利润'),
    col('cost_share', '成本分摊金额'),
    col('creator_name', '创建人'),
    col('started_at', '开始时间'),
    col('completed_at', '完成时间'),
  ];
  const summary = remote.data?.summary;
  return <div>
    {summary && <RedSummary parts={[
      ['人工总费用', summary.labor ?? '-'],
      ['材料总费用(估算)', summary.material ?? '-'],
      ['外协总费用', summary.outsource ?? '-'],
      ['合计总成本', summary.total ?? '-'],
      ['生产总值', summary.output_value ?? '-'],
      ['毛利润', summary.profit ?? '-'],
    ]} />}
    <ListFrame
      pageKey="cost-report"
      exportName="成本报表"
      columns={columns}
      rows={remote.data?.items ?? []}
      loading={remote.loading}
      error={remote.error}
      queryFields={[
        { key: 'code', label: '加工单号' }, { key: 'plan', label: '生产计划' },
        { key: 'product', label: '商品' }, { key: 'category', label: '商品类别' },
        { key: 'contract', label: '合同编号' }, { key: 'project', label: '项目编号' },
        { key: 'delivery_from', label: '交货日期起', kind: 'date' }, { key: 'delivery_to', label: '交货日期止', kind: 'date' },
        { key: 'creator', label: '创建人' },
      ]}
      queryValue={list.draft}
      onQuery={list.onQuery}
      onSearch={list.onSearch}
      onClear={list.onClear}
      showMobileCard={false}
      page={list.page}
      pageSize={list.pageSize}
      total={Number(remote.data?.total ?? remote.data?.items?.length ?? 0)}
      onPage={list.onPage}
      clientPaging={false}
    />
  </div>;
}

export function InventorySummary() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const [period, setPeriod] = useState('本年');
  const [only, setOnly] = useState(true);
  const remote = useRemote<{ items: Rec[] }>(`/api/biz-reports/inventory?period=${encodeURIComponent(period)}&only_flow=${only ? '1' : '0'}`, revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    col('code', '商品编号'),
    col('name', '商品名'),
    col('specification', '商品规格'),
    col('category_name', '类别'),
    col('unit_name', '单位'),
    col('source', '商品来源'),
    col('note', '备注'),
    col('stock_qty', '库存数量'),
    col('opening', '期初数量'),
    col('inbound', '本期入库'),
    col('outbound', '本期出库'),
    col('closing', '期末数量'),
  ];
  return <div>
    {periodBar(period, setPeriod)}
    <div className="kgd-toolbar"><span>只看有流水</span><Switch checked={only} onChange={setOnly} /></div>
    <ListFrame
      pageKey="inventory-summary"
      exportName="进销存汇总"
      columns={columns}
      rows={remote.data?.items ?? []}
      loading={remote.loading}
      error={remote.error}
      queryFields={[
        { key: 'warehouse', label: '仓库' }, { key: 'product', label: '商品名' },
        { key: 'product_code', label: '商品编号' }, { key: 'spec', label: '商品规格' },
        { key: 'unit', label: '单位' }, { key: 'category', label: '商品类别' },
      ]}
      queryValue={list.draft}
      onQuery={list.onQuery}
      onSearch={list.onSearch}
      onClear={list.onClear}
      page={list.page}
      pageSize={list.pageSize}
      total={remote.data?.items.length ?? 0}
      onPage={list.onPage}
    />
  </div>;
}

export function MachineReport() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/biz-reports/machines', revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    col('code', '机台编号'),
    col('name', '机台名称'),
    col('spec', '机台规格'),
    { key: 'status', title: '机台状态', render: (row) => <StatusTag text={String(row.status ?? '-')} /> },
    col('category_name', '机台类别'),
    col('process_name', '生产工序'),
    col('shop_name', '车间'),
    col('line_name', '产线'),
    col('report_qty', '报工数'),
    col('good_qty', '良品数'),
    col('defect_qty', '不良品数'),
    col('good_rate', '良品率(%)'),
    col('standard_hours', '标准工作时长'),
    col('hours', '实际工作时长'),
    col('utilization', '稼动率(%)'),
    col('standard_efficiency', '标准效率'),
    col('actual_efficiency', '实际效率'),
    col('pass_rate', '达标率(%)'),
  ];
  return <ListFrame
    pageKey="machine-report"
    exportName="机台报表"
    columns={columns}
    rows={remote.data?.items ?? []}
    loading={remote.loading}
    error={remote.error}
    queryFields={[
      { key: 'name', label: '机台' }, { key: 'status', label: '机台状态' },
      { key: 'category', label: '机台类别' }, { key: 'shop', label: '车间' },
      { key: 'line', label: '产线' },
    ]}
    queryValue={list.draft}
    onQuery={list.onQuery}
    onSearch={list.onSearch}
    onClear={list.onClear}
    page={list.page}
    pageSize={list.pageSize}
    total={remote.data?.items.length ?? 0}
    onPage={list.onPage}
    showExtension={false}
    showMobileCard={false}
  />;
}
