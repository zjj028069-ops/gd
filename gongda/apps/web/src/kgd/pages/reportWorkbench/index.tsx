import { useEffect, useMemo, useState } from 'react';
import { CheckCircleFilled } from '@ant-design/icons';
import { Button, Input, Modal, Pagination, Select, Table, message } from 'antd';
import { reportCreatePayload } from '../../../domain/payloads';
import { documentActionPayload } from '../../../domain/payloads';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ColumnConfigModal } from '../../dialogs';
import { showError, useCommand } from '../../kit';
import { qtyText } from '../../qty';
import { modeWageText, nowShanghai, rateLabel, splitSpan, wageAmount, yuanLabel } from '../../wage';
import { ReportDialog, uploadReportFiles, type EditableReport } from '../reportForm';

type TodayItem = {
  id: string; code: string; version: number; good_qty: string; defect_qty: string; created_at: string;
  operator_id: string; settlement_status: string; note: string; defect_note: string; effective_seconds: number;
  started_at: string | null; ended_at: string | null; task_id: string; work_order_code: string; product_name: string;
  process_name: string; pricing_mode: string; wage_rate: string | null;
};
type Options = {
  work_orders: { id: string; code: string; product_name: string; due_date?: string | null }[];
  tasks: { id: string; work_order_id: string; process_name: string; execution: string; plan_qty: string; approved_good: string; remaining_qty: string; pricing_mode: string; wage_rate: string | null; reporters: { id: string; name: string }[] }[];
  defect_items: { id: string; name: string }[];
  machines: { id: string; code: string; name: string }[];
  self: { id: string; name: string };
  can_proxy: boolean;
};

export function ReportWorkbenchPage() {
  const { revision, onExpired, session } = useKgd();
  const command = useCommand();
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState(1);
  const [full, setFull] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [orderId, setOrderId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [operator, setOperator] = useState('');
  const [machineId, setMachineId] = useState('');
  const [good, setGood] = useState('0');
  const [defect, setDefect] = useState('0');
  const [picked, setPicked] = useState<{ id: string; qty: string }[]>([]);
  const [pickOpen, setPickOpen] = useState(false);
  const [start, setStart] = useState(nowShanghai());
  const [end, setEnd] = useState(nowShanghai());
  const [hours, setHours] = useState('0');
  const [minutes, setMinutes] = useState('0');
  const [files, setFiles] = useState<File[]>([]);
  const [remark, setRemark] = useState('');
  const [editing, setEditing] = useState<EditableReport | null>(null);
  const today = useRemote<{ summary: { count: number; good_qty: string; defect_qty: string; report_qty: string }; items: TodayItem[]; total: number }>(`/api/report-workbench/today?page=${page}&page_size=30`, revision + tick, onExpired);
  const options = useRemote<Options>(`/api/report-workbench/options?q=${encodeURIComponent(keyword)}${orderId ? `&work_order_id=${orderId}` : ''}`, revision + tick, onExpired);
  const orders = options.data?.work_orders ?? [];
  const tasks = (options.data?.tasks ?? []).filter((task) => !orderId || task.work_order_id === orderId);
  const task = tasks.find((item) => item.id === taskId);
  const canProxy = options.data?.can_proxy ?? false;
  const reporters = task?.reporters ?? [];
  const selfPerson = options.data?.self;
  const people = (canProxy ? reporters : selfPerson ? [selfPerson] : []).filter((item, index, list) => list.findIndex((row) => row.id === item.id) === index);
  const staff = selfPerson && !people.some((item) => item.id === selfPerson.id) ? [selfPerson, ...people] : people;
  useEffect(() => { if (!operator && options.data?.self.id) setOperator(options.data.self.id); }, [operator, options.data?.self.id]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') setFull(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const seconds = (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60;
  const wage = wageAmount(task?.pricing_mode ?? 'piece', task?.wage_rate, good || '0', seconds);
  const summary = today.data?.summary;
  function applyTimes(nextStart: string, nextEnd: string) {
    const span = splitSpan(nextStart, nextEnd);
    if (!span) return;
    setHours(span.hours);
    setMinutes(span.minutes);
  }
  function fillRemain() {
    if (!task) return;
    setGood(task.remaining_qty || '0');
  }
  function clearQty() {
    setGood('0'); setDefect('0'); setPicked([]); setRemark(''); setMachineId(''); setFiles([]);
  }
  async function submit(complete: boolean) {
    if (!orderId) { command.setError('请选择加工单'); return; }
    if (!task) { command.setError('请选择工序'); return; }
    if ((Number(good) || 0) <= 0 && (Number(defect) || 0) <= 0) { command.setError('良品与不良合计必须大于零'); return; }
    const defectSum = picked.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    if (defectSum - (Number(defect) || 0) > 1e-9) { command.setError('不良品项数量之和不能超过不良品数'); return; }
    try {
      const names = picked.map((item) => options.data?.defect_items.find((row) => row.id === item.id)?.name).filter(Boolean);
      const created = await command.send<{ report: { id: string } }>('/api/production-reports', reportCreatePayload({
        task_id: task.id, good_qty: good || '0', defect_qty: defect || '0', effective_seconds: seconds,
        operator_id: operator, include_operator: canProxy, defect_note: names.join('、'), note: remark,
        started_at: start || undefined, ended_at: end || undefined, complete_task: complete,
      }));
      const reportId = created?.report.id ?? '';
      if (reportId && (machineId || picked.length)) {
        try {
          await command.send('/api/quality/bindings', { report_id: reportId, machine_id: machineId, defect_item_ids: picked.map((item) => item.id), defect_items: picked });
        } catch (failure) { message.warning(showError(failure) || '报工已保存，不良品项/机台未保存，请到报工记录中修改'); }
      }
      const failedFiles = reportId && files.length ? await uploadReportFiles(reportId, files, session.csrf_token) : [];
      if (failedFiles.length) message.warning(`报工已保存，${failedFiles.length} 个附件未上传：${failedFiles.join('；')}`);
      setFiles([]);
      message.success('报工成功');
      clearQty();
      setTick((value) => value + 1);
    } catch (failure) { command.setError(showError(failure)); }
  }
  const columns = useMemo(() => [
    { title: '序号', width: 60, render: (_: unknown, __: TodayItem, index: number) => (page - 1) * 30 + index + 1 },
    { title: '加工单号', dataIndex: 'work_order_code' },
    { title: '商品名', dataIndex: 'product_name' },
    { title: '工序名', dataIndex: 'process_name' },
    { title: '良品数', dataIndex: 'good_qty', render: (value: string) => qtyText(value) },
    { title: '不良品数', dataIndex: 'defect_qty', render: (value: string) => qtyText(value) },
    { title: '报工时间', dataIndex: 'created_at', render: (value: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-' },
    { title: '操作', render: (_: unknown, row: TodayItem) => <span>
      <Button type="link" onClick={() => setEditing({ id: row.id, version: row.version, processName: row.process_name, pricingMode: row.pricing_mode, wageRate: row.wage_rate, operatorId: row.operator_id, goodQty: row.good_qty, defectQty: row.defect_qty, defectNote: row.defect_note, note: row.note ?? '', effectiveSeconds: row.effective_seconds ?? 0, startedAt: row.started_at, endedAt: row.ended_at })}>修改</Button>
      <Button type="link" disabled={row.settlement_status === 'settled'} onClick={() => {
        if (row.settlement_status === 'settled') { message.error('已结算的报工记录不能修改或删除，请先改为未结算'); return; }
        Modal.confirm({ title: '删除报工', content: '确认冲销这条报工？', okText: '确定', cancelText: '取消', onOk: async () => {
          try { await command.send(`/api/production-reports/${row.id}/actions`, documentActionPayload('reverse', row.version)); message.success('已删除'); setTick((value) => value + 1); }
          catch (failure) { message.error(showError(failure)); }
        } });
      }}>删除</Button>
    </span> },
  ], [command, page]);
  const todayCard = <section className={`kgd-card ${full ? 'kgd-workbench-full' : ''}`}>
    <div className="kgd-toolbar">
      <h2 style={{ margin: 0 }}><CheckCircleFilled style={{ color: '#4184F4', marginRight: 6 }} />今日报工</h2>
      <span><Button onClick={() => setFull((value) => !value)}>{full ? '退出全屏' : '全屏'}</Button> <Button onClick={() => setColumnsOpen(true)}>列配置</Button></span>
    </div>
    <div className="kgd-summary">报工数：<b className="kgd-red">{summary?.report_qty ?? '-'}</b> 良品数：<b className="kgd-red">{summary?.good_qty ?? '-'}</b> 不良品数：<b className="kgd-red">{summary?.defect_qty ?? '-'}</b></div>
    {today.error && <div className="kgd-banner">{today.error}</div>}
    <Table size="small" rowKey="id" loading={today.loading} pagination={false} dataSource={today.data?.items ?? []} columns={columns} locale={{ emptyText: today.loading ? '正在读取数据…' : '暂无数据' }} />
    <div className="kgd-foot"><span>共{today.data?.total ?? 0}条数据</span><Pagination current={page} pageSize={30} total={today.data?.total ?? 0} onChange={setPage} /></div>
    <ColumnConfigModal open={columnsOpen} columns={['序号', '加工单号', '商品名', '工序名', '良品数', '不良品数', '报工时间', '操作'].map((label) => ({ key: label, label }))} value={{ order: [], visible: [], locked: [] }} onCancel={() => setColumnsOpen(false)} onOk={() => setColumnsOpen(false)} />
  </section>;
  return <div className="kgd-workbench">
    <div className="kgd-workbench-left">{todayCard}</div>
    <div className="kgd-workbench-right">
      <section className="kgd-card">
        <h2>快速报工</h2>
        {command.error && <div className="kgd-banner">{command.error}</div>}
        <div className="kgd-form">
          <span>加工单 *</span>
          <Select showSearch filterOption={false} value={orderId || undefined} placeholder="输入关键词，在查询结果中选中" onSearch={setKeyword} onChange={(value) => { setOrderId(value); setTaskId(''); }} options={orders.map((item) => ({ value: item.id, label: `${item.code} ${item.product_name}` }))} />
          <span>工序 *</span>
          <Select value={taskId || undefined} placeholder="选择工序" onChange={setTaskId} options={tasks.map((item) => ({ value: item.id, label: item.process_name }))} />
          <span>生产人员 *</span>
          <Select disabled={!canProxy} value={operator || undefined} onChange={setOperator} options={staff.map((item) => ({ value: item.id, label: item.name }))} />
          <span>机台</span>
          <Select allowClear value={machineId || undefined} placeholder="选择机台" onChange={(value) => setMachineId(value ?? '')} options={(options.data?.machines ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
          <span>良品数</span><span><Input value={good} onChange={(event) => setGood(event.target.value)} style={{ width: 120 }} /> <Button onClick={fillRemain}>↑</Button></span>
          <span>不良品数</span><span><Input value={defect} onChange={(event) => setDefect(event.target.value)} style={{ width: 120 }} /> <Button onClick={fillRemain}>↑</Button></span>
          <span>不良品项</span>
          <button type="button" className="kgd-dash" onClick={() => setPickOpen(true)}>{picked.length ? picked.map((item) => `${options.data?.defect_items.find((row) => row.id === item.id)?.name ?? '-'} [${item.qty || '0'}]`).join('、') : '+ 点击选择不良品项'}</button>
          <span>开始时间</span><Input type="datetime-local" value={start} onChange={(event) => { setStart(event.target.value); applyTimes(event.target.value, end); }} />
          <span>结束时间</span><Input type="datetime-local" value={end} onChange={(event) => { setEnd(event.target.value); applyTimes(start, event.target.value); }} />
          <span>报工时长</span><span><Input style={{ width: 64 }} value={hours} onChange={(event) => setHours(event.target.value)} /> 小时 <Input style={{ width: 64 }} value={minutes} onChange={(event) => setMinutes(event.target.value)} /> 分钟</span>
          <span>附件</span><span>
            <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.txt" disabled={files.length >= 9} onChange={(event) => { const next = [...files, ...Array.from(event.target.files ?? [])]; if (next.length > 9) message.warning('附件最多上传 9 个'); setFiles(next.slice(0, 9)); event.target.value = ''; }} />
            {files.map((file, index) => <div key={`${file.name}${index}`}>{file.name} <Button type="link" size="small" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</Button></div>)}
          </span>
          <span>备注</span><Input value={remark} onChange={(event) => setRemark(event.target.value)} />
        </div>
        <div className="kgd-actions">
          <Button onClick={clearQty}>清 空</Button>
          <Button type="primary" loading={command.busy} onClick={() => void submit(false)}>报 工</Button>
          <Button loading={command.busy} onClick={() => void submit(true)}>报工并完成工序</Button>
        </div>
        <div className="kgd-wage-box">
          <h3>工资计算</h3>
          <Table size="small" pagination={false} rowKey="name" dataSource={[{ name: task?.process_name || '-', mode: modeWageText(task?.pricing_mode), rate: rateLabel(task?.wage_rate) || '-', wage: yuanLabel(wage) || '-' }]} columns={[
            { title: '工序', dataIndex: 'name' }, { title: '计价方式', dataIndex: 'mode' }, { title: '工资单价', dataIndex: 'rate' }, { title: '工资', dataIndex: 'wage' },
          ]} />
        </div>
      </section>
    </div>
    <Modal title="选择不良品项" open={pickOpen} onCancel={() => setPickOpen(false)} onOk={() => setPickOpen(false)} okText="确定" cancelText="取消">
      {(options.data?.defect_items ?? []).map((item) => {
        const current = picked.find((row) => row.id === item.id);
        return <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 36 }}>
          <label style={{ flex: 1 }}><input type="checkbox" checked={!!current} onChange={(event) => setPicked((rows) => event.target.checked ? [...rows, { id: item.id, qty: '1' }] : rows.filter((row) => row.id !== item.id))} /> {item.name}</label>
          {current && <Input style={{ width: 80 }} value={current.qty} onChange={(event) => setPicked((rows) => rows.map((row) => row.id === item.id ? { ...row, qty: event.target.value } : row))} />}
        </div>;
      })}
    </Modal>
    <ReportDialog open={!!editing} editing={editing} onClose={() => { setEditing(null); setTick((value) => value + 1); }} />
  </div>;
}
