import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Input, Modal, Select, Switch, Table } from 'antd';
import { useRemote } from '../../../../masterTools';
import { ListFrame } from '../../../ListFrame';
import { useQueryState, beijingTime } from '../../../kit';
import { useList, useR10, dash, qs } from '../../round10/shared';
import type { Row } from '../../round10/shared';

export function PerformancePayList() {
  const r10 = useR10();
  const navigate = useNavigate();
  const list = useQueryState();
  const remote = useList<Row>(`/api/performance-pay${qs(list.query)}`);
  const rows = remote.data?.items ?? [];
  const [ruleOpen, setRuleOpen] = useState(false);
  const [formulaOpen, setFormulaOpen] = useState(false);
  return <>
    <ListFrame pageKey="performance_pay" exportName="绩效工资" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'process', label: '工序' }, { key: 'product', label: '商品' }, { key: 'creator', label: '创建人' }]}
      defaultQueryKeys={['process', 'product', 'creator']} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={30} total={rows.length} onPage={list.onPage}
      toolbar={<>
        <Button type="primary" onClick={() => navigate('/setting/PerformancePay/edit')}>+ 新增</Button>
        <Button onClick={() => setRuleOpen(true)}>绩效工资匹配规则</Button>
        <Button onClick={() => setFormulaOpen(true)}>设置工资计算公式</Button>
      </>}
      columns={[
        { key: 'product', title: '商品', render: (row) => dash(row.product_name) },
        { key: 'code', title: '商品编号', render: (row) => dash(row.product_code) },
        { key: 'spec', title: '商品规格', render: (row) => dash(row.product_spec) },
        { key: 'process', title: '工序名', render: (row) => dash(row.process_name) },
        { key: 'mode', title: '计价方式', render: (row) => dash(row.pricing_mode) },
        { key: 'user', title: '姓名', render: (row) => dash(row.user_name) },
        { key: 'no', title: '编号', render: (row) => row.code },
        { key: 'rate', title: '工资单价(元)', render: (row) => String(row.wage_rate) },
        { key: 'actions', title: '操作', render: (row) => <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除', () => r10.act(`/api/performance-pay/${row.id}`, {}, 'DELETE'))}>删除</button> },
      ]} />
    {ruleOpen && <MatchRuleModal onClose={() => setRuleOpen(false)} />}
    {formulaOpen && <FormulaModal onClose={() => setFormulaOpen(false)} />}
  </>;
}

function MatchRuleModal({ onClose }: { onClose: () => void }) {
  const r10 = useR10();
  const remote = useRemote<{ active: Row[]; draft: Row[] }>('/api/performance-pay/match-rules', r10.revision, r10.onExpired);
  const fields = ['工序.工序名', '工序.计价方式', '商品.商品名称', '商品.商品规格', '商品.商品编号', '用户.姓名'];
  const [draft, setDraft] = useState<{ fields: string[] }[]>([{ fields: ['工序.工序名', '商品.商品名称', '用户.姓名'] }, { fields: ['工序.工序名', '工序.计价方式'] }]);
  return <Modal open width={720} title="绩效工资匹配规则" onCancel={onClose} footer={[
    <Button key="apply" type="primary" onClick={() => void r10.act('/api/performance-pay/match-rules', { status: 'draft', rules: draft, apply: true }, 'PUT').then((ok) => { if (ok) onClose(); })}>立即应用</Button>,
    <Button key="exit" onClick={onClose}>退 出</Button>,
  ]}>
    <p>报工时按优先级从高到低匹配，第一条完全命中的绩效行生效。当前正在使用 {remote.data?.active?.length ?? 0} 条规则。</p>
    {draft.map((rule, index) => <div key={index} style={{ border: '1px solid #f0f0f0', padding: 12, marginBottom: 8 }}>
      <div>优先级 {index + 1}</div>
      <Select mode="multiple" style={{ width: '100%' }} value={rule.fields} options={fields.map((f) => ({ value: f, label: f }))}
        onChange={(value) => setDraft((rows) => rows.map((row, i) => i === index ? { fields: value } : row))} />
    </div>)}
    <Button onClick={() => setDraft((rows) => [...rows, { fields: [] }])}>新增优先级</Button>
  </Modal>;
}

function FormulaModal({ onClose }: { onClose: () => void }) {
  const r10 = useR10();
  const remote = useRemote<{ expression: string }>('/api/performance-pay/formula', r10.revision, r10.onExpired);
  const [expression, setExpression] = useState('');
  const [scale, setScale] = useState('2');
  const current = expression || String(remote.data?.expression ?? '');
  return <Modal open width={720} title="设置工资计算公式" onCancel={onClose} onOk={() => void r10.act('/api/performance-pay/formula', { expression: current, scale: Number(scale || 2) }, 'PUT').then((ok) => { if (ok) onClose(); })}>
    <Form layout="vertical">
      <Form.Item label="计算公式" required><Input.TextArea rows={6} value={current} onChange={(e) => setExpression(e.target.value)} /></Form.Item>
      <Form.Item label="小数位数"><Input value={scale} onChange={(e) => setScale(e.target.value)} /></Form.Item>
    </Form>
  </Modal>;
}

export function PerformancePayRule() {
  const navigate = useNavigate();
  return <div className="kgd-card">
    <div className="kgd-toolbar kgd-actions">
      <Button onClick={() => navigate('/setting/PerformancePay/list')}>退 出</Button>
    </div>
    <h2>绩效工资匹配规则</h2>
    <p>报工时按优先级从高到低匹配，第一条完全命中的绩效行生效。</p>
  </div>;
}

export function PerformancePayEdit() {
  const r10 = useR10();
  const navigate = useNavigate();
  const processes = useList('/api/processes?page=1&page_size=200');
  const products = useList('/api/products?page=1&page_size=200');
  const [form, setForm] = useState<Record<string, string>>({ wage_rate: '', process_name: '', pricing_mode: '计件', product_id: '', user_name: '' });
  async function save() {
    if (!form.wage_rate) { r10.message.error('请填写工资单价(元)'); return; }
    const product = (products.data?.items ?? []).find((p) => p.id === form.product_id);
    const ok = await r10.act('/api/performance-pay', {
      ...form,
      product_name: product?.name ?? '',
      product_code: product?.code ?? '',
      product_spec: product?.specification ?? '',
    }, 'POST');
    if (ok) navigate('/setting/PerformancePay/list');
  }
  return <div className="kgd-card">
    <div className="kgd-toolbar"><Button onClick={() => navigate(-1)}>返回</Button><Button type="primary" onClick={() => void save()}>保存</Button></div>
    <Form layout="vertical" style={{ maxWidth: 640 }}>
      <Form.Item label="编号"><Input placeholder="请填写，忽略将自动生成" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Form.Item>
      <Form.Item label={<><span style={{ color: 'red' }}>*</span>工资单价(元)</>} required validateStatus={!form.wage_rate ? 'error' : undefined} help={!form.wage_rate ? '请填写工资单价(元)' : undefined}>
        <Input value={form.wage_rate} onChange={(e) => setForm({ ...form, wage_rate: e.target.value })} />
      </Form.Item>
      <Form.Item label="工序名"><Select allowClear value={form.process_name || undefined} onChange={(v) => setForm({ ...form, process_name: v })} options={(processes.data?.items ?? []).map((p) => ({ value: String(p.name), label: String(p.name) }))} /></Form.Item>
      <Form.Item label="计价方式"><Select value={form.pricing_mode} onChange={(v) => setForm({ ...form, pricing_mode: v })} options={[{ value: '计件', label: '计件' }, { value: '计时', label: '计时' }]} /></Form.Item>
      <Form.Item label="商品"><Select allowClear showSearch optionFilterProp="label" value={form.product_id || undefined} onChange={(v) => setForm({ ...form, product_id: v })} options={(products.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.name} ${p.code}` }))} /></Form.Item>
      <Form.Item label="姓名"><Input value={form.user_name} onChange={(e) => setForm({ ...form, user_name: e.target.value })} /></Form.Item>
    </Form>
  </div>;
}

export function AutoStockManage() {
  const r10 = useR10();
  const remote = useList('/api/auto-stock/events');
  const logs = useList('/api/auto-stock/logs');
  const [open, setOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame pageKey="auto_stock" exportName="自动出入库" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'q', label: '事件名称' }]} queryValue={{}} onQuery={() => undefined} onSearch={() => undefined} onClear={() => undefined}
      page={1} pageSize={30} total={rows.length} onPage={() => undefined}
      toolbar={<>
        <Button type="primary" onClick={() => setOpen(true)}>+ 新增</Button>
        <Button onClick={() => setLogOpen(true)}>执行日志</Button>
      </>}
      columns={[
        { key: 'name', title: '事件名称', render: (row) => row.name },
        { key: 'trigger', title: '触发方式', render: (row) => row.trigger_mode || '报工后' },
        { key: 'action', title: '执行事件', render: (row) => row.action_kind === 'issue_bom' ? '按用料清单出库' : '报工后自动入库' },
        { key: 'content', title: '事件内容', render: (row) => dash(row.content_text) },
        { key: 'enabled', title: '启用/禁用', render: (row) => <Switch checked={!!row.enabled} onChange={(enabled) => void r10.act(`/api/auto-stock/events/${row.id}`, { enabled }, 'PATCH')} /> },
      ]} />
    <Modal open={open} title="自定义事件模板" onCancel={() => setOpen(false)} footer={null} width={720}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div className="kgd-card"><h3>新建自定义事件</h3><Button onClick={() => r10.message.info('请从模板创建')}>点击使用 →</Button></div>
        <div className="kgd-card"><h3>按用料清单出库</h3><p>根据用料清单的投料工序，自动出料</p><Button type="primary" onClick={() => void r10.act('/api/auto-stock/events', { name: '按用料清单出库', action_kind: 'issue_bom', content_text: '报工后按用料出库' }, 'POST').then((ok) => { if (ok) setOpen(false); })}>点击使用 →</Button></div>
        <div className="kgd-card"><h3>报工后自动入库</h3><p>末道工序报工时，成品自动入库</p><Button type="primary" onClick={() => void r10.act('/api/auto-stock/events', { name: '报工后自动入库', action_kind: 'receipt_fg', content_text: '末道工序自动入库' }, 'POST').then((ok) => { if (ok) setOpen(false); })}>点击使用 →</Button></div>
      </div>
    </Modal>
    <Modal open={logOpen} title="执行日志" onCancel={() => setLogOpen(false)} footer={null} width={900}>
      <Table size="small" rowKey="id" dataSource={logs.data?.items ?? []} columns={[
        { title: '时间', dataIndex: 'created_at', render: (v) => beijingTime(v, '') },
        { title: '事件名称', dataIndex: 'event_name' },
        { title: '报工编号', dataIndex: 'report_code' },
        { title: '加工单号', dataIndex: 'work_order_code' },
        { title: '单据号', dataIndex: 'bill_code' },
        { title: '结果', dataIndex: 'result' },
        { title: '失败原因', dataIndex: 'fail_reason' },
      ]} />
    </Modal>
  </>;
}
