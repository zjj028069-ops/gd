import { useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Radio, Select } from 'antd';
import { ListFrame } from '../../../ListFrame';
import { useQueryState } from '../../../kit';
import { dash, fmtTime, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';
import { useRemote } from '../../../../masterTools';

export function PriceTrack() {
  const r10 = useR10();
  const list = useQueryState();
  const [advanced, setAdvanced] = useState(false);
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const q = list.query;
  const remote = useList<Row>(`/api/purchase/price-rules${qs({ keyword: q.q || q.product, supplier_id: q.supplier_id, page: list.page, page_size: list.pageSize })}`);
  const suppliers = useList<Row>('/api/money/suppliers');
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame<Row> pageKey="purchase_price_track" exportName="采购价格追踪" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} onApplyQuery={list.onApplyQuery}
      queryNode={<div className="kgd-query-fields">
        <Input style={{ width: 240 }} allowClear placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(event) => list.onQuery('q', event.target.value)} onPressEnter={list.onSearch} />
        <Button type="link" onClick={() => setAdvanced((value) => !value)}>高级查询</Button>
        {advanced && <>
          <Select style={{ width: 200 }} allowClear showSearch optionFilterProp="label" placeholder="供应商" value={list.draft.supplier_id || undefined} options={(suppliers.data?.items ?? []).map((item) => ({ value: item.id, label: String(item.name) }))} onChange={(value) => list.onQuery('supplier_id', value ?? '')} />
          <Input style={{ width: 200 }} allowClear placeholder="商品名/商品编号/商品规格" value={list.draft.product ?? ''} onChange={(event) => list.onQuery('product', event.target.value)} />
        </>}
      </div>}
      page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage}
      toolbar={<><Button type="primary" onClick={() => setEdit('new')}>新增</Button><Button onClick={() => setRuleOpen(true)}>价格规则</Button></>}
      columns={[
        { key: 'supplier', title: '供应商', width: 180, render: (row) => dash(row.supplier_name) },
        { key: 'code', title: '商品编号', render: (row) => dash(row.product_code) },
        { key: 'name', title: '商品名', render: (row) => dash(row.product_name) },
        { key: 'spec', title: '商品规格', render: (row) => dash(row.specification) },
        { key: 'price', title: '单价', render: (row) => dash(row.unit_price) },
        { key: 'last', title: '上一次的采购单价', render: (row) => dash(row.last_price) },
        { key: 'avg', title: '历史平均采购单价', render: (row) => dash(row.avg_price) },
        { key: 'max', title: '历史最高采购单价', render: (row) => dash(row.max_price) },
        { key: 'min', title: '历史最低采购单价', render: (row) => dash(row.min_price) },
        { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
        { key: 'created', title: '创建时间', width: 160, render: (row) => row.created_text ?? fmtTime(row.created_at) },
        { key: 'actions', title: '操作', width: 120, render: (row) => <>
          <button className="kgd-link" onClick={() => setEdit(row)}>修改</button>{' '}
          <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除价格规则', () => r10.act(`/api/purchase/price-rules/${row.id}`, {}, 'DELETE', '已删除'))}>删除</button>
        </> },
      ]} />
    {edit && <RuleModal row={edit === 'new' ? null : edit} suppliers={suppliers.data?.items ?? []} onClose={() => setEdit(null)} />}
    {ruleOpen && <PriceRuleModeModal onClose={() => setRuleOpen(false)} />}
  </>;
}

function RuleModal({ row, suppliers, onClose }: { row: Row | null; suppliers: Row[]; onClose: () => void }) {
  const r10 = useR10();
  const [supplier, setSupplier] = useState<string>(row?.supplier_id ?? '');
  const [product, setProduct] = useState<string>(row?.product_id ?? '');
  const [keyword, setKeyword] = useState('');
  const [price, setPrice] = useState<string>(row?.unit_price === undefined || row?.unit_price === '-' ? '' : String(row.unit_price));
  const products = useList<Row>(`/api/products${qs({ page: 1, page_size: 50, q: keyword })}`);
  const options = (products.data?.items ?? []).map((item) => ({ value: String(item.id), label: `${item.name}${item.code ? `（${item.code}）` : ''}` }));
  if (row && !options.some((item) => item.value === row.product_id)) options.unshift({ value: String(row.product_id), label: `${row.product_name}${row.product_code ? `（${row.product_code}）` : ''}` });
  async function save() {
    if (!supplier) { r10.message.warning('请选择供应商'); return; }
    if (!product) { r10.message.warning('请选择商品'); return; }
    if (!price || !/^\d+(\.\d{1,8})?$/.test(price)) { r10.message.warning('请填写正确的单价'); return; }
    const result = await r10.act(row ? `/api/purchase/price-rules/${row.id}` : '/api/purchase/price-rules', { supplier_id: supplier, product_id: product, unit_price: price }, row ? 'PUT' : 'POST');
    if (result) onClose();
  }
  return <Modal title={row ? '修改价格规则' : '创建新价格规则'} open onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消" confirmLoading={r10.busy} destroyOnHidden>
    <Form layout="vertical">
      <Form.Item label="供应商" required><Select showSearch disabled={!!row} optionFilterProp="label" placeholder="请选择供应商" value={supplier || undefined} options={suppliers.map((item) => ({ value: item.id, label: String(item.name) }))} onChange={setSupplier} /></Form.Item>
      <Form.Item label="商品" required><Select showSearch disabled={!!row} filterOption={false} onSearch={setKeyword} placeholder="请选择" value={product || undefined} options={options} onChange={setProduct} /></Form.Item>
      <Form.Item label="单价" required><InputNumber<string> style={{ width: '100%' }} min="0" stringMode value={price} onChange={(value) => setPrice(value === null ? '' : String(value))} /></Form.Item>
    </Form>
  </Modal>;
}

function PriceRuleModeModal({ onClose }: { onClose: () => void }) {
  const r10 = useR10();
  const remote = useRemote<{ mode: string; options: { value: string; label: string }[] }>('/api/purchase/price-rule-mode', r10.revision, r10.onExpired);
  const [mode, setMode] = useState<string | null>(null);
  const value = mode ?? remote.data?.mode ?? 'rule';
  const options = remote.data?.options ?? [{ value: 'rule', label: '价格规则单价' }, { value: 'last', label: '上一次采购单价' }, { value: 'none', label: '不自动带出' }];
  return <Modal title="价格规则" open onCancel={onClose} onOk={() => void r10.act('/api/purchase/price-rule-mode', { mode: value }, 'PUT').then((result) => { if (result) onClose(); })} okText="确定" cancelText="取消" confirmLoading={r10.busy}>
    <p>新建采购单选择供应商和商品后，默认单价取：</p>
    <Radio.Group style={{ display: 'grid', gap: 8 }} value={value} onChange={(event) => setMode(event.target.value)} options={options} />
  </Modal>;
}
