import { useMemo, useState } from 'react';
import { App, Button, Input, Modal, Select, Table } from 'antd';
import { apiRequest, errorMessage, hasPermission } from '../../api';
import { attachmentMime, attachmentSizeMessage, attachmentUploadPayload, reportCreatePayload, reportUpdatePayload } from '../../domain/payloads';
import { useRemote } from '../../masterTools';
import { useKgd } from '../context';
import { showError, useCommand } from '../kit';
import { qtyText } from '../qty';
import { modeWageText, nowShanghai, rateLabel, splitSpan, wageAmount, yuanLabel } from '../wage';
import { requestKey } from '../../requestKey';

export async function uploadReportFiles(reportId: string, files: File[], csrfToken: string) {
  const failed: string[] = [];
  for (const file of files) {
    const message = attachmentSizeMessage(file.size);
    const mime = attachmentMime(file);
    if (message || !mime) { failed.push(`${file.name}：${message || '附件需为 pdf、png、jpeg 或 txt'}`); continue; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    try {
      await apiRequest('/api/attachments', { method: 'POST', csrfToken, body: attachmentUploadPayload({ resource_type: 'production_report', resource_id: reportId, filename: file.name, mime, content_base64: btoa(binary), request_key: requestKey() }) });
    } catch (failure) { failed.push(`${file.name}：${errorMessage(failure)}`); }
  }
  return failed;
}

export type ReportTarget = {
  taskId: string;
  processName: string;
  pricingMode: string;
  wageRate: string | null;
  planQty?: string;
  workOrderCode?: string;
};

export type EditableReport = {
  id: string;
  version: number;
  processName: string;
  pricingMode: string;
  wageRate: string | null;
  operatorId: string;
  goodQty: string;
  defectQty: string;
  defectNote: string;
  note: string;
  effectiveSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
};

function localInput(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return text.replace(' ', 'T');
}

export function ReportDialog({ open, target, editing, onClose }: { open: boolean; target?: ReportTarget | null; editing?: EditableReport | null; onClose: () => void }) {
  const source = editing ?? null;
  const name = source?.processName || target?.processName || '';
  const mode = source?.pricingMode || target?.pricingMode || 'piece';
  const rate = source?.wageRate ?? target?.wageRate ?? null;
  const taskId = target?.taskId ?? '';
  return <Modal
    title={`报工 [${name}]`}
    open={open} onCancel={onClose} footer={null} width={920} destroyOnHidden>
    {open && (source || taskId) ? <ReportBody key={source?.id ?? taskId} taskId={taskId} mode={mode} rate={rate} processName={name} editing={source} onClose={onClose} /> : <p>请选择进行中的工序</p>}
    </Modal>;
}

function ReportBody({ taskId, mode, rate, processName, editing, onClose }: { taskId: string; mode: string; rate: string | null; processName: string; editing: EditableReport | null; onClose: () => void }) {
  const { session, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const members = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', 0, onExpired);
  const canProxy = hasPermission(session, 'production.approve');
  const [operator, setOperator] = useState(editing?.operatorId || String(session.user.id));
  const [good, setGood] = useState(editing ? qtyText(editing.goodQty) : '1');
  const [defect, setDefect] = useState(editing ? qtyText(editing.defectQty) : '0');
  const [note] = useState(editing?.defectNote ?? '');
  const [remark, setRemark] = useState(editing?.note ?? '');
  const [start, setStart] = useState(editing ? localInput(editing.startedAt) : nowShanghai());
  const [end, setEnd] = useState(editing ? localInput(editing.endedAt) : nowShanghai());
  const initial = editing ? { hours: String(Math.floor((editing.effectiveSeconds || 0) / 3600)), minutes: String(Math.floor(((editing.effectiveSeconds || 0) % 3600) / 60)) } : { hours: '0', minutes: '0' };
  const bench = useRemote<{ defect_items: { id: string; name: string }[]; machines: { id: string; name: string; code: string }[] }>('/api/report-workbench/options', 0, onExpired);
  const defects = { data: { items: bench.data?.defect_items ?? [] }, error: bench.error };
  const machines = { data: { items: (bench.data?.machines ?? []).map((item) => ({ ...item, enabled: true })) } };
  const [picked, setPicked] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [machineId, setMachineId] = useState('');
  const [hours, setHours] = useState(initial.hours);
  const [minutes, setMinutes] = useState(initial.minutes);
  const seconds = (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60;
  const wage = wageAmount(mode, rate, good || '0', seconds);
  function applyTimes(nextStart: string, nextEnd: string) {
    const span = splitSpan(nextStart, nextEnd);
    if (!span) return;
    setHours(span.hours);
    setMinutes(span.minutes);
  }
  function pickFiles(list: FileList | null) {
    const next = [...files, ...Array.from(list ?? [])];
    if (next.length > 9) command.setError('附件最多上传 9 个。');
    setFiles(next.slice(0, 9));
  }
  async function submit(complete: boolean) {
    try {
      const names = (defects.data?.items ?? []).filter((item) => picked.includes(item.id)).map((item) => item.name);
      const defectNote = names.length ? names.join('、') : note;
      let reportId = editing?.id ?? '';
      if (editing) {
        await command.send(`/api/production-reports/${editing.id}`, reportUpdatePayload({
          version: editing.version, good_qty: good || '0', defect_qty: defect || '0', effective_seconds: seconds,
          operator_id: canProxy ? operator : undefined, defect_note: defectNote, note: remark, started_at: start || null, ended_at: end || null,
        }), 'PATCH');
        message.success('报工成功');
      } else {
        const created = await command.send<{ report: { id: string } }>('/api/production-reports', reportCreatePayload({
          task_id: taskId, good_qty: good || '0', defect_qty: defect || '0', effective_seconds: seconds,
          operator_id: operator, include_operator: canProxy, defect_note: defectNote, note: remark,
          started_at: start || undefined, ended_at: end || undefined, complete_task: complete,
        }));
        reportId = created?.report.id ?? '';
        message.success('报工成功');
      }
      if (reportId && (machineId || picked.length)) await command.send('/api/quality/bindings', { report_id: reportId, machine_id: machineId, defect_item_ids: picked });
      const failed = reportId ? await uploadReportFiles(reportId, files, session.csrf_token) : [];
      if (failed.length) Modal.warning({ title: '报工已保存，部分附件未上传', content: <div>{failed.map((item) => <div key={item}>{item}</div>)}</div> });
      onClose();
    } catch (failure) { command.setError(showError(failure)); }
  }
  return <>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <div className="kgd-report">
      <div>
        <h3>报工信息</h3>
        <div className="kgd-form">
          <span>生产人员 *</span>
          <Select disabled={!canProxy} value={operator} onChange={setOperator} options={(members.data?.items ?? []).map((item) => ({ value: String(item.id), label: item.display_name }))} />
          <span>机台</span><Select allowClear placeholder="无" value={machineId || undefined} onChange={(value) => setMachineId(value ?? '')} options={(machines.data?.items ?? []).filter((item) => item.enabled).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
          <span>良品数</span><Input value={good} onChange={(event) => setGood(event.target.value)} />
          <span>不良品数</span><Input value={defect} onChange={(event) => setDefect(event.target.value)} />
          <span>不良品项</span><Select mode="multiple" placeholder="点击选择不良品项" value={picked} onChange={setPicked} options={(defects.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
          {note && !picked.length ? <><span>原不良说明</span><Input disabled value={note} /></> : null}
          <span>开始时间</span><Input type="datetime-local" value={start} onChange={(event) => { setStart(event.target.value); applyTimes(event.target.value, end); }} />
          <span>结束时间</span><Input type="datetime-local" value={end} onChange={(event) => { setEnd(event.target.value); applyTimes(start, event.target.value); }} />
          <span>报工时长</span><span><Input style={{ width: 72 }} value={hours} onChange={(event) => setHours(event.target.value)} /> 小时 <Input style={{ width: 72 }} value={minutes} onChange={(event) => setMinutes(event.target.value)} /> 分钟</span>
          <span>附件</span><span>
            <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.txt" disabled={files.length >= 9 || !hasPermission(session, 'attachments.write')} onChange={(event) => { pickFiles(event.target.files); event.target.value = ''; }} />
            {files.map((file, index) => <div key={`${file.name}${index}`}>{file.name} <Button type="link" size="small" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</Button></div>)}
            <span className="kgd-muted">最多 9 个</span>
          </span>
          <span>备注</span><Input value={remark} onChange={(event) => setRemark(event.target.value)} />
        </div>
      </div>
      <div className="kgd-wage-box">
        <h3>工资计算</h3>
        <Table size="small" pagination={false} rowKey="name" dataSource={[{ name: processName, mode: modeWageText(mode), rate: rateLabel(rate), wage: yuanLabel(wage) }]} columns={[
          { title: '工序', dataIndex: 'name' }, { title: '计价方式', dataIndex: 'mode' }, { title: '工资单价', dataIndex: 'rate' }, { title: '工资', dataIndex: 'wage' },
        ]} />
      </div>
    </div>
    <div className="kgd-actions" style={{ justifyContent: 'flex-end' }}>
      {editing ? <><Button onClick={onClose}>取 消</Button><Button type="primary" loading={command.busy} onClick={() => void submit(false)}>保 存</Button></> : <>
        <Button loading={command.busy} onClick={() => void submit(true)}>报工并完成</Button>
        <Button type="primary" loading={command.busy} onClick={() => void submit(false)}>仅报工</Button>
      </>}
    </div>
  </>;
}

export function ReportWorkbench() {
  const { revision, onExpired } = useKgd();
  const orders = useRemote<{ items: { id: string; code: string; tasks: { id: string; process_name: string; execution: string; pricing_mode?: string; wage_rate?: string | null; plan_qty: string }[]; product_snapshot?: { name?: string } }[] }>('/api/work-orders?reportable=1', revision, onExpired);
  const [orderId, setOrderId] = useState('');
  const [taskId, setTaskId] = useState('');
  const order = useMemo(() => orders.data?.items.find((item) => item.id === orderId), [orders.data, orderId]);
  const tasks = (order?.tasks ?? []).filter((task) => task.execution === 'running');
  const task = tasks.find((item) => item.id === taskId);
  return <div className="kgd-card">
    <h2>报工</h2>
    {orders.error && <div style={{ color: '#f5222d' }}>{orders.error}</div>}
    <div className="kgd-form">
      <span>加工单</span>
      <Select showSearch optionFilterProp="label" value={orderId || undefined} placeholder="选择可报工加工单" onChange={(value) => { setOrderId(value); setTaskId(''); }} options={(orders.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.product_snapshot?.name ?? ''}` }))} />
      <span>工序</span>
      <Select value={taskId || undefined} placeholder="选择工序" onChange={setTaskId} options={tasks.map((item) => ({ value: item.id, label: item.process_name }))} />
    </div>
    {task && <ReportDialog open target={{ taskId: task.id, processName: task.process_name, pricingMode: task.pricing_mode ?? 'piece', wageRate: task.wage_rate ?? null, planQty: task.plan_qty, workOrderCode: order?.code }} onClose={() => setTaskId('')} />}
  </div>;
}
