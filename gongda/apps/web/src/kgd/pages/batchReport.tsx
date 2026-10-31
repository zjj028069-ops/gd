import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Checkbox, Input, Modal, Select, Table, Tabs } from 'antd';
import { apiRequest, errorMessage, hasPermission } from '../../api';
import { reportCreatePayload } from '../../domain/payloads';
import { useRemote } from '../../masterTools';
import { useKgd } from '../context';
import { showError, useCommand } from '../kit';
import { ProgressCell } from './progress/ProgressCell';
import { nowShanghai, splitSpan } from '../wage';
import { uploadReportFiles } from './reportForm';

export type BatchTask = {
  id: string; work_order_id: string; work_order_code: string; work_order_execution: string; order_paused: boolean; execution: string; task_type?: string;
  plan_qty: string; approved_good: string; product_snapshot: { name?: string }; process_snapshot: { name?: string; reporter_ids?: string[] };
};

export const BATCH_FIELDS = [
  { key: 'product', label: '商品' }, { key: 'progress', label: '生产进度' }, { key: 'operator', label: '报工人' }, { key: 'good', label: '良品数' },
  { key: 'defect', label: '不良品数' }, { key: 'defectItems', label: '不良品项' }, { key: 'machine', label: '机台' }, { key: 'start', label: '开始时间' },
  { key: 'end', label: '结束时间' }, { key: 'duration', label: '报工时长' }, { key: 'files', label: '附件' }, { key: 'trace', label: '溯源码' },
];
const DEFAULT_FIELDS = ['product', 'operator', 'good', 'defect', 'defectItems', 'start', 'end', 'duration'];
const labelOf = (key: string) => BATCH_FIELDS.find((item) => item.key === key)?.label ?? key;
type FormConfig = { pc: string[]; mobile: string[]; version: number };

function useBatchForm() {
  const { revision, onExpired } = useKgd();
  const remote = useRemote<FormConfig>('/api/production-tasks/batch-report-form', revision, onExpired);
  return { pc: remote.data?.pc?.length ? remote.data.pc : DEFAULT_FIELDS, mobile: remote.data?.mobile?.length ? remote.data.mobile : DEFAULT_FIELDS, version: remote.data?.version ?? 0 };
}

export function reportBlock(task: BatchTask) {
  if (task.task_type === 'outsource') return '任务类型属于外协任务';
  if (task.work_order_execution === 'not_started') return '加工单处于未开始状态';
  if (task.work_order_execution === 'completed') return '加工单处于完成状态';
  if (task.execution === 'paused' || task.order_paused) return '任务处于暂停状态';
  if (task.execution === 'completed') return '任务处于完成状态';
  return null;
}

function FieldPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [search, setSearch] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const shown = BATCH_FIELDS.filter((item) => item.label.includes(search.trim()));
  return <>
    <div className="kgd-muted">展示的字段及排序：已选中字段需要在报工时进行填写，并进行对应规则校验。</div>
    <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
      <div style={{ flex: 1 }}>
        <Input placeholder="请输入" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div><Checkbox checked={value.length === BATCH_FIELDS.length} indeterminate={!!value.length && value.length < BATCH_FIELDS.length} onChange={(event) => onChange(event.target.checked ? [...value, ...BATCH_FIELDS.map((item) => item.key).filter((key) => !value.includes(key))] : [])}>全选</Checkbox></div>
        {shown.map((item) => <div key={item.key}><Checkbox checked={value.includes(item.key)} onChange={(event) => onChange(event.target.checked ? [...value, item.key] : value.filter((key) => key !== item.key))}>{item.label}</Checkbox></div>)}
      </div>
      <div style={{ flex: 1 }}>
        <div>已选字段展示：</div>
        {value.map((key, index) => <div key={key} draggable onDragStart={() => setDrag(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => {
          if (drag === null) return;
          const next = [...value];
          const [moved] = next.splice(drag, 1);
          next.splice(index, 0, moved!);
          onChange(next);
          setDrag(null);
        }} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px', border: '1px solid #f0f0f0', marginTop: 4, cursor: 'move' }}>
          <span>≡ {labelOf(key)}</span><Button type="link" size="small" onClick={() => onChange(value.filter((item) => item !== key))}>×</Button>
        </div>)}
      </div>
    </div>
  </>;
}

export function BatchReportFormDialog({ onClose }: { onClose: () => void }) {
  const config = useBatchForm();
  const command = useCommand();
  const [pc, setPc] = useState<string[] | null>(null);
  const [mobile, setMobile] = useState<string[] | null>(null);
  async function save() {
    try {
      await command.send('/api/production-tasks/batch-report-form', { pc: pc ?? config.pc, mobile: mobile ?? config.mobile, version: config.version }, 'PUT');
      onClose();
    } catch (failure) { command.setError(showError(failure)); }
  }
  return <Modal title="批量报工表单设计" open width={720} onCancel={onClose} onOk={() => void save()} confirmLoading={command.busy} okText="确 定" cancelText="取 消">
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <Tabs items={[
      { key: 'pc', label: '电脑端', children: <FieldPicker value={pc ?? config.pc} onChange={setPc} /> },
      { key: 'mobile', label: '移动端', children: <FieldPicker value={mobile ?? config.mobile} onChange={setMobile} /> },
    ]} />
  </Modal>;
}

type Draft = { taskId: string; operator: string; good: string; defect: string; defectItems: string[]; machine: string; start: string; end: string; hours: string; minutes: string; files: File[]; trace: string };

export function BatchReportDialog({ tasks, onClose }: { tasks: BatchTask[]; onClose: () => void }) {
  const { session, onExpired } = useKgd();
  const config = useBatchForm();
  const canProxy = hasPermission(session, 'production.approve');
  const members = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', 0, onExpired);
  const bench = useRemote<{ defect_items: { id: string; name: string }[]; machines: { id: string; name: string; code: string }[] }>('/api/report-workbench/options', 0, onExpired);
  const allowed = tasks.filter((task) => !reportBlock(task));
  const blocked = tasks.filter((task) => reportBlock(task));
  const [step, setStep] = useState<'check' | 'form'>('check');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>(() => allowed.map((task) => ({ taskId: task.id, operator: String(session.user.id), good: '', defect: '0', defectItems: [], machine: '', start: nowShanghai(), end: nowShanghai(), hours: '0', minutes: '0', files: [], trace: '' })));
  const patch = (taskId: string, next: Partial<Draft>) => setDrafts((current) => current.map((item) => {
    if (item.taskId !== taskId) return item;
    const merged = { ...item, ...next };
    if (next.start !== undefined || next.end !== undefined) {
      const span = splitSpan(merged.start, merged.end);
      if (span) { merged.hours = span.hours; merged.minutes = span.minutes; }
    }
    return merged;
  }));
  const taskOf = (id: string) => allowed.find((task) => task.id === id)!;
  async function submit() {
    if (config.pc.includes('good') && drafts.some((item) => !item.good.trim())) { setError('请填写每条任务的良品数。'); return; }
    setBusy(true); setError('');
    const results: string[] = [];
    let ok = 0;
    for (const draft of drafts) {
      const task = taskOf(draft.taskId);
      const label = `${task.work_order_code} ${task.process_snapshot.name ?? ''}`;
      try {
        const names = (bench.data?.defect_items ?? []).filter((item) => draft.defectItems.includes(item.id)).map((item) => item.name);
        const created = await apiRequest<{ report: { id: string } }>('/api/production-reports', { method: 'POST', csrfToken: session.csrf_token, body: reportCreatePayload({
          task_id: draft.taskId, good_qty: draft.good || '0', defect_qty: draft.defect || '0', effective_seconds: (Number(draft.hours) || 0) * 3600 + (Number(draft.minutes) || 0) * 60,
          operator_id: draft.operator, include_operator: canProxy, defect_note: names.join('、'), note: draft.trace.trim() ? `溯源码：${draft.trace.trim()}` : '',
          started_at: draft.start || undefined, ended_at: draft.end || undefined,
        }) });
        const reportId = created.report.id;
        if (draft.machine || draft.defectItems.length) await apiRequest('/api/quality/bindings', { method: 'POST', csrfToken: session.csrf_token, body: { report_id: reportId, machine_id: draft.machine, defect_item_ids: draft.defectItems } });
        const failed = draft.files.length ? await uploadReportFiles(reportId, draft.files, session.csrf_token) : [];
        failed.forEach((item) => results.push(`${label}：附件 ${item}`));
        ok += 1;
      } catch (failure) { results.push(`${label}：${errorMessage(failure)}`); }
    }
    setBusy(false);
    Modal.info({ title: `批量报工完成：成功 ${ok} 条，失败 ${drafts.length - ok} 条`, content: results.length ? <div>{results.map((item) => <div key={item}>{item}</div>)}</div> : null });
    onClose();
  }
  if (step === 'check') return <Modal title="请确认" open onCancel={onClose} okText="确 认" cancelText="取 消" okButtonProps={{ disabled: !allowed.length }} onOk={() => setStep('form')}>
    <p>{`已选择 ${tasks.length} 条生产任务， ${allowed.length} 条支持报工，${blocked.length} 条限制报工`}</p>
    {blocked.map((task) => <div key={task.id} className="kgd-muted">{`${task.work_order_code} ${task.process_snapshot.name ?? ''}：${reportBlock(task)}`}</div>)}
  </Modal>;
  const operators = (task: BatchTask) => {
    const ids = task.process_snapshot.reporter_ids ?? [];
    return (members.data?.items ?? []).filter((item) => !ids.length || ids.includes(String(item.id))).map((item) => ({ value: String(item.id), label: item.display_name }));
  };
  const render: Record<string, (draft: Draft) => ReactNode> = {
    product: (draft) => taskOf(draft.taskId).product_snapshot.name ?? '',
    progress: (draft) => <ProgressCell done={taskOf(draft.taskId).approved_good} total={taskOf(draft.taskId).plan_qty} />,
    operator: (draft) => <Select style={{ width: 120 }} disabled={!canProxy} value={draft.operator} onChange={(value) => patch(draft.taskId, { operator: value })} options={operators(taskOf(draft.taskId))} />,
    good: (draft) => <Input style={{ width: 80 }} value={draft.good} onChange={(event) => patch(draft.taskId, { good: event.target.value })} />,
    defect: (draft) => <Input style={{ width: 80 }} value={draft.defect} onChange={(event) => patch(draft.taskId, { defect: event.target.value })} />,
    defectItems: (draft) => <Select mode="multiple" style={{ width: 160 }} placeholder="点击选择不良品项" value={draft.defectItems} onChange={(value) => patch(draft.taskId, { defectItems: value })} options={(bench.data?.defect_items ?? []).map((item) => ({ value: item.id, label: item.name }))} />,
    machine: (draft) => <Select allowClear style={{ width: 140 }} placeholder="无" value={draft.machine || undefined} onChange={(value) => patch(draft.taskId, { machine: value ?? '' })} options={(bench.data?.machines ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />,
    start: (draft) => <Input type="datetime-local" value={draft.start} onChange={(event) => patch(draft.taskId, { start: event.target.value })} />,
    end: (draft) => <Input type="datetime-local" value={draft.end} onChange={(event) => patch(draft.taskId, { end: event.target.value })} />,
    duration: (draft) => <span style={{ whiteSpace: 'nowrap' }}><Input style={{ width: 56 }} value={draft.hours} onChange={(event) => patch(draft.taskId, { hours: event.target.value })} /> 小时 <Input style={{ width: 56 }} value={draft.minutes} onChange={(event) => patch(draft.taskId, { minutes: event.target.value })} /> 分钟</span>,
    files: (draft) => <span><input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.txt" onChange={(event) => { patch(draft.taskId, { files: [...draft.files, ...Array.from(event.target.files ?? [])].slice(0, 9) }); event.target.value = ''; }} />{draft.files.length ? `${draft.files.length} 个` : ''}</span>,
    trace: (draft) => <Input style={{ width: 140 }} value={draft.trace} onChange={(event) => patch(draft.taskId, { trace: event.target.value })} />,
  };
  return <Modal title="批量报工" open width={1200} onCancel={onClose} onOk={() => void submit()} confirmLoading={busy} okText="确 定" cancelText="取 消">
    {error && <div className="kgd-banner">{error}</div>}
    <Table size="small" pagination={false} rowKey="taskId" scroll={{ x: 'max-content' }} dataSource={drafts} columns={[
      { title: '加工单', render: (_, draft) => taskOf(draft.taskId).work_order_code },
      { title: '工序', render: (_, draft) => taskOf(draft.taskId).process_snapshot.name ?? '' },
      ...config.pc.filter((key) => render[key]).map((key) => ({ title: labelOf(key), key, render: (_: unknown, draft: Draft) => render[key]!(draft) })),
    ]} />
  </Modal>;
}

export function DispatchDialog({ tasks, onClose }: { tasks: BatchTask[]; onClose: () => void }) {
  const { onExpired } = useKgd();
  const command = useCommand();
  const members = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', 0, onExpired);
  const [picked, setPicked] = useState<string[]>([]);
  const shared = tasks.reduce<string[] | null>((acc, task) => {
    const ids = (task.process_snapshot.reporter_ids ?? []).map(String);
    return acc === null ? ids : acc.filter((id) => ids.includes(id));
  }, null) ?? [];
  async function save() {
    if (!picked.length) { command.setError('请选择生产派工人员。'); return; }
    try {
      await command.send('/api/production-tasks/dispatch', { task_ids: tasks.map((task) => task.id), operator_ids: picked });
      onClose();
    } catch (failure) { command.setError(showError(failure)); }
  }
  return <Modal title="批量派工" open onCancel={onClose} onOk={() => void save()} confirmLoading={command.busy} okText="确 定" cancelText="取 消">
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <p>{`已选择 ${tasks.length} 条生产任务，派工人员只能从各任务的生产人员中选择。`}</p>
    {shared.length ? <div className="kgd-form"><span>生产派工 *</span><Select mode="multiple" style={{ width: '100%' }} value={picked} onChange={setPicked} options={(members.data?.items ?? []).filter((item) => shared.includes(String(item.id))).map((item) => ({ value: String(item.id), label: item.display_name }))} /></div>
      : <p className="kgd-muted">所选任务没有共同的生产人员，请分开派工。</p>}
  </Modal>;
}
