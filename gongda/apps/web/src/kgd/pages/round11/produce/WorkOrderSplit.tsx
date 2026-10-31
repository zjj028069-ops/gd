import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Input, Radio, Table } from 'antd';
import { useRemote } from '../../../../masterTools';
import { useR10 } from '../../round10/shared';

export function WorkOrderSplit() {
  const { pathname } = useLocation();
  const id = pathname.split('/inside_produce_bill/split/')[1]?.split(/[/?]/)[0] ?? '';
  const navigate = useNavigate();
  const r10 = useR10();
  const remote = useRemote<{ work_order?: { id: string; code: string; execution: string; plan_qty: string; version: number; product_snapshot?: { name?: string; code?: string; specification?: string } } }>(id ? `/api/work-orders/${id}` : null, r10.revision, r10.onExpired);
  const order = remote.data?.work_order;
  const [mode, setMode] = useState<'each' | 'count' | 'custom'>('each');
  const [each, setEach] = useState('');
  const [count, setCount] = useState('');
  const [custom, setCustom] = useState(['']);
  const plan = Number(order?.plan_qty ?? 0);
  const parts = useMemo(() => {
    if (mode === 'each') {
      const n = Number(each);
      if (!n || n <= 0) return [];
      const out: number[] = [];
      let left = plan;
      while (left > 0) {
        const take = Math.min(n, left);
        out.push(take);
        left -= take;
      }
      return out;
    }
    if (mode === 'count') {
      const n = Number(count);
      if (!n || n < 2) return [];
      const base = Math.floor(plan / n);
      const rest = plan - base * n;
      return Array.from({ length: n }, (_, index) => base + (index === n - 1 ? rest : 0));
    }
    return custom.map((item) => Number(item) || 0).filter((item) => item > 0);
  }, [mode, each, count, custom, plan]);
  const allocated = parts.reduce((sum, item) => sum + item, 0);
  async function submit() {
    if (allocated !== plan) { r10.message.warning('拆分数量合计必须等于原计划数'); return; }
    const result = await r10.act(`/api/work-orders/${order!.id}/split`, { quantities: parts.map(String), version: order!.version });
    if (result) navigate(`/inside_produce_bill/detail/${order!.id}`);
  }
  if (!order) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : '加工单不存在'}</div>;
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => navigate(-1)}>返回</Button></div>
    <h2>拆单</h2>
    <dl className="kgd-detail-grid">
      {([
        ['加工单', order.code],
        ['状态', order.execution],
        ['商品', order.product_snapshot?.name],
        ['商品编号', order.product_snapshot?.code],
        ['商品规格', order.product_snapshot?.specification],
        ['合同', '-'],
        ['项目编号', '-'],
        ['生产计划编号', '-'],
        ['生产计划名', '-'],
        ['计划数', order.plan_qty],
        ['BOM', '-'],
        ['工序', '-'],
      ] as [string, unknown][]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value ?? '-')}</dd></div>)}
    </dl>
    <p>原计划数：{plan}，已分配：{allocated}</p>
    <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)}>
      <Radio value="each">按每单计划数</Radio>
      <Radio value="count">按拆分单数</Radio>
      <Radio value="custom">自定义拆分</Radio>
    </Radio.Group>
    {mode === 'each' && <Input style={{ width: 160, marginLeft: 8 }} value={each} onChange={(event) => setEach(event.target.value)} placeholder="每单数量" />}
    {mode === 'count' && <Input style={{ width: 160, marginLeft: 8 }} value={count} onChange={(event) => setCount(event.target.value)} placeholder="拆分单数" />}
    {mode === 'custom' && <div>{custom.map((value, index) => <Input key={index} style={{ width: 120, margin: 4 }} value={value} onChange={(event) => setCustom((rows) => rows.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />)}<Button onClick={() => setCustom((rows) => [...rows, ''])}>加行</Button></div>}
    <Table size="small" pagination={false} dataSource={parts.map((qty, index) => ({ key: index, type: index === 0 ? '原加工单' : '新加工单', qty, name: order.product_snapshot?.name, code: order.product_snapshot?.code, spec: order.product_snapshot?.specification }))} columns={[
      { title: '序号', dataIndex: 'key', render: (v) => Number(v) + 1 },
      { title: '加工单类型', dataIndex: 'type' },
      { title: '计划数', dataIndex: 'qty' },
      { title: '商品', dataIndex: 'name' },
      { title: '商品编号', dataIndex: 'code' },
      { title: '商品规格', dataIndex: 'spec' },
      { title: '计划开始', render: () => '-' },
      { title: '计划结束', render: () => '-' },
      { title: '项目编号', render: () => '-' },
      { title: '生产计划编号', render: () => '-' },
      { title: '生产计划名', render: () => '-' },
      { title: '合同编号', render: () => '-' },
    ]} />
    <div className="kgd-actions"><Button type="primary" onClick={() => void submit()}>确认拆分</Button><Button type="primary" onClick={() => void submit()}>提交</Button></div>
  </div>;
}
