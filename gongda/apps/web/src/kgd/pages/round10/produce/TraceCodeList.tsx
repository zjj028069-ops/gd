import { useState } from 'react';
import { Button, Form, InputNumber, Modal, Select, Table, Tag } from 'antd';
import QRCode from 'qrcode';
import { useRemote } from '../../../../masterTools';
import { ListFrame } from '../../../ListFrame';
import type { QueryField } from '../../../ListFrame';
import { useQueryState } from '../../../kit';
import { QrImage } from '../../../qr';
import { dash, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';
import { WorkOrderPick } from './common';

const statusColor: Record<string, string> = { 未使用: 'blue', 已使用: 'green', 作废: 'default' };
const queryFields: QueryField[] = [
  { key: 'code', label: '溯源码编号' },
  { key: 'product', label: '商品' },
  { key: 'work_order_code', label: '加工单号' },
  { key: 'status', label: '状态', kind: 'select', options: [{ value: '', label: '全部' }, { value: '未使用', label: '未使用' }, { value: '已使用', label: '已使用' }, { value: '作废', label: '作废' }] },
];

export function TraceCodeList() {
  const r10 = useR10();
  const list = useQueryState();
  const [batchOpen, setBatchOpen] = useState(false);
  const [qr, setQr] = useState<Row | null>(null);
  const [trace, setTrace] = useState<Row | null>(null);
  const remote = useList<Row>(`/api/trace-codes${qs({ ...list.query, page: list.page, page_size: list.pageSize })}`);
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame<Row> pageKey="trace_code" showMobileCard exportName="溯源码管理" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={queryFields} defaultQueryKeys={['code', 'product', 'work_order_code', 'status']} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} onApplyQuery={list.onApplyQuery}
      page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage} clientPaging={false}
      toolbar={<Button type="primary" onClick={() => setBatchOpen(true)}>生成</Button>}
      columns={[
        { key: 'code', title: '溯源码编号', render: (row) => String(row.code) },
        { key: 'product', title: '商品', render: (row) => dash(row.product_name) },
        { key: 'product_code', title: '商品编号', render: (row) => dash(row.product_code) },
        { key: 'work_order', title: '加工单号', render: (row) => dash(row.work_order_code) },
        { key: 'qty', title: '数量', render: (row) => dash(row.qty) },
        { key: 'status', title: '状态', render: (row) => <Tag color={statusColor[row.status] ?? 'default'}>{row.status}</Tag> },
        { key: 'creator', title: '生成人', render: (row) => dash(row.creator_name) },
        { key: 'created', title: '生成时间', width: 160, render: (row) => dash(row.created_text) },
        { key: 'actions', title: '操作', width: 260, render: (row) => <>
          <button className="kgd-link" onClick={() => setQr(row)}>查看二维码</button>{' '}
          <button className="kgd-link" onClick={() => setTrace(row)}>溯源详情</button>{' '}
          {row.status === '未使用' && <button className="kgd-link" onClick={() => void r10.act(`/api/trace-codes/${row.id}/status`, { status: '已使用' }, 'POST', '已标记为已使用')}>标记已使用</button>}{' '}
          {row.status !== '作废' && <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('作废溯源码', () => r10.act(`/api/trace-codes/${row.id}/status`, { status: '作废' }, 'POST', '已作废'), '作废后该溯源码不能再使用，确定作废？')}>作废</button>}
        </> },
      ]} />
    {batchOpen && <BatchModal onClose={() => setBatchOpen(false)} />}
    {qr && <QrModal row={qr} onClose={() => setQr(null)} />}
    {trace && <TraceModal row={trace} onClose={() => setTrace(null)} />}
  </>;
}

function BatchModal({ onClose }: { onClose: () => void }) {
  const r10 = useR10();
  const [workOrder, setWorkOrder] = useState('');
  const [count, setCount] = useState<number>(1);
  const [qty, setQty] = useState<string>('1');
  async function save() {
    if (!workOrder) { r10.message.warning('请选择加工单'); return; }
    if (!(count >= 1 && count <= 500)) { r10.message.warning('张数需在1到500之间'); return; }
    if (!(Number(qty) > 0)) { r10.message.warning('请填写每张数量'); return; }
    const result = await r10.act<{ codes?: string[]; first?: string; last?: string }>('/api/trace-codes/batch', { work_order_id: workOrder, count, qty }, 'POST', false);
    if (result) { r10.message.success(`已生成${result.codes?.length ?? count}张溯源码${result.first ? `（${result.first}~${result.last}）` : ''}`); onClose(); }
  }
  return <Modal title="生成生产溯源二维码" open onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消" confirmLoading={r10.busy} destroyOnHidden>
    <Form layout="vertical">
      <Form.Item label="生成方式" required><Select value="按加工单生成" options={[{ value: '按加工单生成', label: '按加工单生成' }]} /></Form.Item>
      <Form.Item label="加工单" required><WorkOrderPick value={workOrder} onChange={setWorkOrder} /></Form.Item>
      <Form.Item label="生成二维码数量" required><InputNumber min={1} max={500} precision={0} style={{ width: '100%' }} value={count} onChange={(value) => setCount(Number(value ?? 1))} /></Form.Item>
      <Form.Item label="每张数量" required><InputNumber<string> stringMode min="0" style={{ width: '100%' }} value={qty} onChange={(value) => setQty(value ?? '')} /></Form.Item>
    </Form>
  </Modal>;
}

function QrModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const text = String(row.code);
  async function download() {
    const url = await QRCode.toDataURL(text, { width: 440, margin: 2 });
    const link = document.createElement('a');
    link.href = url;
    link.download = `溯源码-${text}.png`;
    link.click();
  }
  return <Modal title="查看二维码" open onCancel={onClose} footer={<><Button onClick={onClose}>关闭</Button><Button type="primary" onClick={() => void download()}>下载</Button></>}>
    <div style={{ display: 'grid', justifyItems: 'center', gap: 8 }}>
      <QrImage text={text} />
      <b>{text}</b>
      <span className="kgd-muted">{dash(row.product_name)} · {dash(row.work_order_code)}</span>
    </div>
  </Modal>;
}

function TraceModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const r10 = useR10();
  const remote = useRemote<{ trace?: Row; processes?: Row[]; spot_checks?: Row[]; receipts?: Row[] }>(`/api/trace-codes/${row.id}/detail`, r10.revision, r10.onExpired);
  const trace = remote.data?.trace;
  const reports: Row[] = (remote.data?.processes ?? []).flatMap((process) => ((process.reports ?? []) as Row[]).map((report): Row => ({ ...report, process_name: process.process_name })));
  return <Modal title="溯源详情" open onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={860}>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    {!trace && remote.loading && <p>正在读取数据…</p>}
    {trace && <>
      <dl className="kgd-detail-grid">
        <div><dt>溯源码编号</dt><dd>{String(row.code)}</dd></div>
        <div><dt>加工单号</dt><dd>{dash(trace.work_order_code)}</dd></div>
        <div><dt>商品</dt><dd>{dash(trace.product_name)}</dd></div>
        <div><dt>商品编号</dt><dd>{dash(trace.product_code)}</dd></div>
        <div><dt>规格</dt><dd>{dash(trace.specification)}</dd></div>
        <div><dt>数量</dt><dd>{dash(trace.qty)}</dd></div>
        <div><dt>生产状态</dt><dd>{dash(trace.execution_text)}</dd></div>
        <div><dt>计划数</dt><dd>{dash(trace.plan_qty)}</dd></div>
        <div><dt>成品入库</dt><dd>{(remote.data?.receipts ?? []).map((item) => `${item.code}(${item.quantity})`).join('、') || '-'}</dd></div>
      </dl>
      <h4>工序流程</h4>
      <Table size="small" rowKey={(item) => String(item.id)} pagination={false} dataSource={remote.data?.processes ?? []} locale={{ emptyText: '暂无数据' }} columns={[
        { title: '序号', width: 60, render: (_, __, index) => index + 1 },
        { title: '工序名', render: (_, item) => dash(item.process_name) },
        { title: '状态', render: (_, item) => dash(item.execution_text) },
        { title: '计划数', render: (_, item) => dash(item.plan_qty) },
        { title: '良品数', render: (_, item) => dash(item.approved_good) },
        { title: '不良品数', render: (_, item) => dash(item.approved_defect) },
      ]} />
      <h4 style={{ marginTop: 12 }}>报工记录</h4>
      <Table size="small" rowKey={(item) => String(item.code)} pagination={false} dataSource={reports} locale={{ emptyText: '暂无数据' }} columns={[
        { title: '工序名', render: (_, item) => dash(item.process_name) },
        { title: '报工单号', render: (_, item) => dash(item.code) },
        { title: '报工人', render: (_, item) => dash(item.operator_name) },
        { title: '报工时间', render: (_, item) => dash(item.reported_text) },
        { title: '良品数', render: (_, item) => dash(item.good_qty) },
        { title: '不良品数', render: (_, item) => dash(item.defect_qty) },
        { title: '质检', render: (_, item) => dash(item.quality_text) },
      ]} />
      {(remote.data?.spot_checks ?? []).length > 0 && <>
        <h4 style={{ marginTop: 12 }}>抽检记录</h4>
        <Table size="small" rowKey={(item) => String(item.code)} pagination={false} dataSource={remote.data?.spot_checks ?? []} columns={[
          { title: '抽检单号', render: (_, item) => dash(item.code) }, { title: '抽检数', render: (_, item) => dash(item.qty) },
          { title: '良品数', render: (_, item) => dash(item.good_qty) }, { title: '不良品数', render: (_, item) => dash(item.defect_qty) }, { title: '时间', render: (_, item) => dash(item.created_text) },
        ]} />
      </>}
    </>}
  </Modal>;
}
