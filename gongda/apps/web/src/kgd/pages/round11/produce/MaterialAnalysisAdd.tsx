import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Radio, Select, Table } from 'antd';
import { useList, useR10 } from '../../round10/shared';
import type { Row } from '../../round10/shared';

const flags = [
  ['stock_main', '是否考虑主商品库存'],
  ['stock_mat', '是否考虑物料库存'],
  ['occupy', '是否考虑物料占用'],
  ['ceil', '是否考虑数量向上取整'],
  ['wip', '是否考虑在制商品'],
  ['inbound', '是否考虑在途商品'],
  ['occupy_out', '占用物料能否被其他单据出库'],
] as const;

export function MaterialAnalysisAdd() {
  const navigate = useNavigate();
  const r10 = useR10();
  const plans = useList<Row>('/api/production-plans?page_size=200');
  const [planId, setPlanId] = useState('');
  const [note, setNote] = useState('');
  const [values, setValues] = useState<Record<string, boolean>>(Object.fromEntries(flags.map(([key]) => [key, true])));
  const [error, setError] = useState('');
  async function start() {
    if (!planId) { setError('请选择生产计划'); return; }
    setError('');
    const result = await r10.act('/api/material-analyses', { plan_id: planId, note, ...values });
    if (result) navigate('/MaterialAnalysis/list');
  }
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => navigate(-1)}>返回</Button></div>
    <h3>基本信息</h3>
    <div className="kgd-form">
      <span>*生产计划</span>
      <Select status={error ? 'error' : undefined} value={planId || undefined} placeholder="请选择生产计划" style={{ minWidth: 280 }} onChange={setPlanId} options={(plans.data?.items ?? []).map((item) => ({ value: String(item.id), label: `${item.code} ${item.name}` }))} />
      {error && <div style={{ color: '#ff4d4f' }}>{error}</div>}
      <span>备注</span><Input maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} />
    </div>
    <h3>分析策略 <a href="https://doc.qly.ltd/%e5%88%86%e6%9e%90%e7%ad%96%e7%95%a5%e8%af%b4%e6%98%8e-2.html" target="_blank" rel="noreferrer">点击查看详细分析策略说明!</a></h3>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {flags.map(([key, label]) => <div key={key}>{label} <Radio.Group value={values[key] ? '是' : '否'} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value === '是' }))} options={[{ value: '是', label: '是' }, { value: '否', label: '否' }]} /></div>)}
    </div>
    <Table size="small" rowKey="id" pagination={false} dataSource={[]} locale={{ emptyText: '暂无数据' }} columns={[
      { title: '序号', dataIndex: 'seq' }, { title: '商品名', dataIndex: 'name' }, { title: '编号', dataIndex: 'code' }, { title: '规格', dataIndex: 'spec' }, { title: '合同编号', dataIndex: 'contract' }, { title: '客户名', dataIndex: 'customer' },
      { title: '商品来源', dataIndex: 'source' }, { title: '商品图片', dataIndex: 'image' }, { title: '计划数量', dataIndex: 'qty' }, { title: '商品BOM', dataIndex: 'bom' }, { title: '单位', dataIndex: 'unit' }, { title: '备注', dataIndex: 'note' },
    ]} />
    <div style={{ textAlign: 'center', marginTop: 24 }}><Button type="primary" onClick={() => void start()}>开始分析</Button></div>
  </div>;
}
