import { useMemo, useState } from 'react';
import { Button, Input, Modal, Pagination, Select, Table, Tag } from 'antd';
import { EChart } from '../../progress/echarts';
import { dash, exportRows, sourceColor, sourceText, useList, useR10 } from '../shared';
import type { Row } from '../shared';
import { requestKey } from '../../../../requestKey';

type Flag = 'low' | 'high' | 'rising';
type Item = Row & { product_name: string; product_code?: string; specification?: string; source?: string; category_name?: string; opening_qty?: string; forecast_qty?: string; advice_qty?: string; purchase_order_code?: string; flags?: Flag[]; monthly?: { month: string; out_qty: string; forecast?: boolean }[] };

const emptyFilter = { product: '', code: '', spec: '', category: '', source: '', purchase: '', advice: '' };

export function AiInventoryPage() {
  const r10 = useR10();
  const remote = useList<Item>('/api/reports/ai-inventory');
  const [draft, setDraft] = useState(emptyFilter);
  const [filter, setFilter] = useState(emptyFilter);
  const [flag, setFlag] = useState<Flag | ''>('');
  const [expand, setExpand] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [trend, setTrend] = useState<Item[] | null>(null);
  const items = remote.data?.items ?? [];
  const summary = (remote.data?.summary ?? {}) as { low_count?: number; high_count?: number; rising_count?: number };
  const count = (key: Flag) => items.filter((item) => item.flags?.includes(key)).length;
  const rows = useMemo(() => items.filter((item) => {
    const source = sourceText[String(item.source)] ?? String(item.source ?? '');
    if (flag && !item.flags?.includes(flag)) return false;
    if (filter.product && !String(item.product_name).includes(filter.product)) return false;
    if (filter.code && !String(item.product_code ?? '').includes(filter.code)) return false;
    if (filter.spec && !String(item.specification ?? '').includes(filter.spec)) return false;
    if (filter.category && !String(item.category_name ?? '').includes(filter.category)) return false;
    if (filter.source && source !== filter.source) return false;
    if (filter.purchase === 'created' && !item.purchase_order_code) return false;
    if (filter.purchase === 'none' && item.purchase_order_code) return false;
    if (filter.advice === 'has' && !(Number(item.advice_qty ?? 0) > 0)) return false;
    if (filter.advice === 'none' && Number(item.advice_qty ?? 0) > 0) return false;
    return true;
  }), [filter, flag, items]);
  function search() { setFilter(draft); setPage(1); }
  function showFlag(next: Flag) { setFlag(next); setPage(1); window.setTimeout(() => document.getElementById('ai-detail')?.scrollIntoView({ behavior: 'smooth' }), 0); }
  async function batchCreate() {
    const chosen = items.filter((item) => selected.includes(item.id));
    if (!chosen.length) { r10.message.warning('请先勾选商品'); return; }
    if (chosen.some((item) => item.purchase_order_code)) { r10.message.warning('已创建采购单的商品不能重复创建'); return; }
    const result = await r10.act<{ orders?: { code: string }[] }>('/api/reports/ai-inventory/purchase-orders', { product_ids: chosen.map((item) => item.id), request_key: requestKey() }, 'POST', false);
    if (result) { r10.message.success(`已创建采购单：${(result.orders ?? []).map((order) => order.code).join('、') || chosen.length + '张'}`); setSelected([]); remote.reload(); }
  }
  const columns = [
    { title: '商品名', text: (row: Item) => dash(row.product_name) },
    { title: '编号', text: (row: Item) => dash(row.product_code) },
    { title: '规格', text: (row: Item) => dash(row.specification) },
    { title: '商品来源', text: (row: Item) => sourceText[String(row.source)] ?? dash(row.source) },
    { title: '商品类别', text: (row: Item) => dash(row.category_name) },
    { title: '期初库存', text: (row: Item) => dash(row.opening_qty) },
    { title: '预测库存', text: (row: Item) => dash(row.forecast_qty) },
    { title: '备料建议', text: (row: Item) => dash(row.advice_qty) },
    { title: '采购单', text: (row: Item) => row.purchase_order_code || '未创建' },
  ];
  return <>
    <div className="kgd-card">
      <h3 style={{ color: '#4184F4', margin: 0 }}>⁄ AI分析与建议</h3>
      <p style={{ color: '#4184F4' }}>提示：以下数据由AI大模型预测，因受多种因素影响，会存在误差，务必以实际生产情况为准来参考和使用(每月1号进行预测)。</p>
      <div style={{ background: '#f5faff', padding: 12, borderRadius: 4, lineHeight: 2.2 }}>
        <div>1.本月预计有 <b style={{ color: '#f5222d', fontSize: 18 }}>{summary.low_count ?? count('low')}</b> 种商品的库存量低于预期水平，为了保障供应链的稳定性，建议及时进行采购，补充库存。<button type="button" className="kgd-link" onClick={() => showFlag('low')}>查看详情&gt;&gt;</button></div>
        <div>2.本月预计有 <b style={{ color: '#f5222d', fontSize: 18 }}>{summary.high_count ?? count('high')}</b> 种商品的库存量超出预期，目前物料储备充足，暂无需额外备料。<button type="button" className="kgd-link" onClick={() => showFlag('high')}>查看详情&gt;&gt;</button></div>
        <div>3.所有的商品中有 <b style={{ color: '#f5222d', fontSize: 18 }}>{summary.rising_count ?? count('rising')}</b> 种商品的需求量最近两个月呈现出连续上升趋势，请关注市场动态，适时调整生产计划。<button type="button" className="kgd-link" onClick={() => showFlag('rising')}>查看详情&gt;&gt;</button></div>
      </div>
    </div>
    <div className="kgd-card" id="ai-detail">
      <h3 style={{ marginTop: 0 }}>数据明细{flag && <Tag closable color="orange" style={{ marginLeft: 8 }} onClose={() => setFlag('')}>{flag === 'low' ? '库存低于预期' : flag === 'high' ? '库存超出预期' : '需求连续上升'}</Tag>}</h3>
      <div className="kgd-query">
        <div className="kgd-query-fields">
          <span>商品</span><Input style={{ width: 180 }} allowClear placeholder="商品" value={draft.product} onChange={(event) => setDraft({ ...draft, product: event.target.value })} onPressEnter={search} />
          <span>商品编号</span><Input style={{ width: 180 }} allowClear placeholder="商品编号" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} onPressEnter={search} />
          <span>商品规格</span><Input style={{ width: 160 }} allowClear placeholder="商品规格" value={draft.spec} onChange={(event) => setDraft({ ...draft, spec: event.target.value })} />
          <span>商品类别</span><Input style={{ width: 160 }} allowClear placeholder="商品类别" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} />
          <span>商品来源</span><Select style={{ width: 140 }} allowClear placeholder="商品来源" value={draft.source || undefined} options={['自产', '外购', '外协加工'].map((value) => ({ value, label: value }))} onChange={(value) => setDraft({ ...draft, source: value ?? '' })} />
          <span>采购单</span><Select style={{ width: 140 }} allowClear placeholder="采购单" value={draft.purchase || undefined} options={[{ value: 'created', label: '已创建' }, { value: 'none', label: '未创建' }]} onChange={(value) => setDraft({ ...draft, purchase: value ?? '' })} />
          <span>备料建议</span><Select style={{ width: 140 }} allowClear placeholder="备料建议" value={draft.advice || undefined} options={[{ value: 'has', label: '需备料' }, { value: 'none', label: '无需备料' }]} onChange={(value) => setDraft({ ...draft, advice: value ?? '' })} />
        </div>
        <div className="kgd-toolbar" style={{ margin: 0 }}><Button type="primary" onClick={search}>查询</Button><Button onClick={() => { setDraft(emptyFilter); setFilter(emptyFilter); setFlag(''); }}>清空</Button></div>
      </div>
      <div style={{ textAlign: 'center' }}><Button size="small" shape="round" onClick={() => setExpand((value) => !value)}>{expand ? '收起 ︿' : '展开 ﹀'}</Button></div>
      <div className="kgd-toolbar">
        <Button type="link" disabled={!selected.length} loading={r10.busy} onClick={() => void batchCreate()}>批量创建采购单</Button>
        <Button type="link" disabled={!rows.length} onClick={() => setTrend(selected.length ? items.filter((item) => selected.includes(item.id)) : rows.slice(0, 10))}>查看库存预测图</Button>
        <Button type="link" onClick={() => exportRows('AI库存监控.csv', columns, rows)}>导出</Button>
      </div>
      {remote.error && <div className="kgd-banner">{remote.error}</div>}
      <Table<Item> size="small" rowKey="id" loading={remote.loading} pagination={false} dataSource={rows.slice((page - 1) * pageSize, page * pageSize)} scroll={{ x: 'max-content' }}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)), getCheckboxProps: (row) => ({ disabled: !!row.purchase_order_code }) }}
        columns={[
          { title: '商品名', render: (_, row) => row.product_name },
          { title: '编号', render: (_, row) => dash(row.product_code) },
          { title: '规格', render: (_, row) => dash(row.specification) },
          { title: '商品来源', render: (_, row) => { const text = sourceText[String(row.source)] ?? dash(row.source); return <Tag color={sourceColor[text]}>{text}</Tag>; } },
          { title: '商品类别', render: (_, row) => dash(row.category_name) },
          { title: '期初库存', render: (_, row) => dash(row.opening_qty) },
          { title: '预测库存', render: (_, row) => dash(row.forecast_qty) },
          { title: '备料建议', render: (_, row) => dash(row.advice_qty) },
          { title: '采购单', render: (_, row) => row.purchase_order_code ? <a href={`/purchase_order/detail/${row.purchase_order_id}`}>{row.purchase_order_code}</a> : '未创建' },
          { title: '趋势图', render: (_, row) => <button className="kgd-link" onClick={() => setTrend([row])}>查看</button> },
        ]} />
      <div className="kgd-foot"><span /><Pagination current={page} pageSize={pageSize} defaultPageSize={10} total={rows.length} showSizeChanger pageSizeOptions={[10, 20, 30, 50]} showTotal={(total) => `共${total}条数据`} onChange={(next, size) => { setPage(next); setPageSize(size ?? 10); }} /></div>
    </div>
    <Modal title="库存预测图" open={!!trend} footer={null} width={820} onCancel={() => setTrend(null)} destroyOnHidden>
      {trend && <TrendChart items={trend} />}
    </Modal>
  </>;
}

function TrendChart({ items }: { items: Item[] }) {
  const months = [...new Set(items.flatMap((item) => (item.monthly ?? []).map((point) => point.month)))].sort();
  if (!months.length) return <div className="kgd-muted">暂无出库数据</div>;
  return <EChart className="kgd-schedule-chart" option={{
    tooltip: { trigger: 'axis' },
    legend: { data: items.map((item) => item.product_name) },
    xAxis: { type: 'category', data: months },
    yAxis: { type: 'value', name: '出库数量' },
    series: items.map((item) => ({ type: 'line', name: item.product_name, data: months.map((month) => Number((item.monthly ?? []).find((point) => point.month === month)?.out_qty ?? 0)) })),
  }} />;
}
