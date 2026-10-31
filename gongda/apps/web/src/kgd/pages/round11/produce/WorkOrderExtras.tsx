import { useMemo, useState } from 'react';
import type { MenuProps } from 'antd';
import { Button, Input, Modal, Table } from 'antd';
import type { NavigateFunction } from 'react-router-dom';
import { apiRequest } from '../../../../api';
import { AsyncQr } from '../../../qr';
import { workOrderMobileUrl } from '../../mobile/device';
import { useKgd } from '../../../context';
import { askReason, beijingTime, confirmText } from '../../../kit';
import { qtyText } from '../../../qty';
import { ProgressCell } from '../../progress/ProgressCell';
import type { ProgressWorkOrderRow } from '../../progress/workOrderColumns';

const execText: Record<string, string> = { not_started: '未开始', running: '生产中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

type MoreHandlers = {
  onParent: () => void;
  onChildren: () => void;
  onGantt: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
};

export function moreMenuItems(
  row: ProgressWorkOrderRow,
  act: (row: ProgressWorkOrderRow, action: string, reason?: string) => void,
  navigate: NavigateFunction,
  handlers: MoreHandlers,
): MenuProps['items'] {
  const status: MenuProps['items'] = [];
  if (row.execution === 'completed') {
    status.push({ key: 'running', label: '生产中', onClick: () => act(row, 'withdraw') });
    status.push({ key: 'cancel', label: '取消', onClick: () => askReason('取消加工单必须填写原因', (reason) => act(row, 'cancel', reason)) });
  } else if (row.execution === 'running') {
    status.push({ key: 'not_started', label: '未开始', onClick: () => act(row, 'withdraw') });
    status.push({ key: 'complete', label: '完成', onClick: () => act(row, 'complete') });
    status.push({ key: 'cancel', label: '取消', onClick: () => askReason('取消加工单必须填写原因', (reason) => act(row, 'cancel', reason)) });
    status.push({ key: 'pause', label: '暂停', onClick: () => askReason('暂停必须填写原因', (reason) => act(row, 'pause', reason)) });
  } else if (row.execution === 'paused') {
    status.push({ key: 'cancel', label: '取消', onClick: () => askReason('取消加工单必须填写原因', (reason) => act(row, 'cancel', reason)) });
    status.push({ key: 'resume', label: '继续', onClick: () => act(row, 'resume') });
  } else if (row.execution === 'not_started') {
    status.push({ key: 'start', label: '开始', onClick: () => act(row, 'start') });
    status.push({ key: 'complete', label: '完成', onClick: () => act(row, 'complete') });
    status.push({ key: 'cancel', label: '取消', onClick: () => askReason('取消加工单必须填写原因', (reason) => act(row, 'cancel', reason)) });
  }
  const crud: MenuProps['items'] = [
    { key: 'edit', label: '修改', onClick: handlers.onEdit },
    { key: 'copy', label: '复制', onClick: handlers.onCopy },
    { key: 'del', label: '删除', danger: true, onClick: handlers.onDelete },
  ];
  const family: MenuProps['items'] = [
    { key: 'parent', label: '选父单', onClick: handlers.onParent },
    { key: 'children', label: '选子单', onClick: handlers.onChildren },
  ];
  if (row.execution === 'not_started') family.push({ key: 'split', label: '拆单', onClick: () => navigate(`/inside_produce_bill/split/${row.id}`) });
  const gantt: MenuProps['items'] = [{ key: 'gantt', label: '甘特图', onClick: handlers.onGantt }];
  const parts = [status, crud, family, gantt].filter((part) => part && part.length);
  const items: MenuProps['items'] = [];
  parts.forEach((part, index) => {
    if (index) items.push({ type: 'divider' });
    items.push(...(part ?? []));
  });
  return items;
}

export function WorkOrderGanttModal({ row, onClose }: { row: ProgressWorkOrderRow | null; onClose: () => void }) {
  const days = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: 21 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, []);
  const months = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const monthLabel = days[0] ? `${months[days[0].getMonth()]} ${days[0].getFullYear()}` : '';
  const tasks = row?.ring_tasks ?? [];
  return <Modal title="加工单工序甘特图" open={!!row} onCancel={onClose} footer={null} width={1100} destroyOnHidden>
    <div style={{ display: 'flex', overflow: 'auto' }}>
      <table className="kgd-gantt"><thead>
        <tr><th rowSpan={2}>工序名称</th>{days.map((d, i) => i === 0 || d.getDate() === 1 ? <th key={d.toISOString()} colSpan={days.filter((x) => x.getMonth() === d.getMonth()).length}>{monthLabel}</th> : null)}</tr>
        <tr>{days.map((d) => <th key={d.toISOString()} className={[0, 6].includes(d.getDay()) ? 'kgd-gantt-weekend' : undefined}>{String(d.getDate()).padStart(2, '0')} {week[d.getDay()]}</th>)}</tr>
      </thead><tbody>
        {tasks.map((task) => {
          const start = task.planned_start ? new Date(String(task.planned_start).slice(0, 10)) : null;
          const end = task.planned_end ? new Date(String(task.planned_end).slice(0, 10)) : null;
          return <tr key={task.id}>
            <td>{task.process_name}</td>
            {days.map((d) => {
              const on = start && end && d >= start && d <= end;
              return <td key={d.toISOString()} className={[0, 6].includes(d.getDay()) ? 'kgd-gantt-weekend' : undefined} title={on ? `${task.process_name} ${task.planned_start}~${task.planned_end}` : undefined}>
                {on ? <div className="kgd-gantt-cell-bar" /> : null}
              </td>;
            })}
          </tr>;
        })}
      </tbody></table>
    </div>
  </Modal>;
}

export function WorkOrderScheduleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session, onChanged } = useKgd();
  const [rows, setRows] = useState<ProgressWorkOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    const data = await apiRequest<{ items: ProgressWorkOrderRow[] }>('/api/progress/work-orders?page=1&page_size=200');
    setRows((data.items ?? []).filter((row) => !row.parent_id && ['not_started', 'running', 'paused'].includes(row.execution)));
    setLoading(false);
  }
  return <Modal title="加工单排单" open={open} onCancel={onClose} footer={null} width={1100} afterOpenChange={(v) => { if (v) void load(); }}>
    <div className="kgd-toolbar" style={{ justifyContent: 'space-between' }}>
      <div className="kgd-muted">加工单排单只支持父加工单</div>
    </div>
    <Table<ProgressWorkOrderRow> size="small" rowKey="id" loading={loading} dataSource={rows} pagination={{ pageSize: 30, showTotal: (n) => `共${n}条数据` }}
      columns={[
        { title: '排单序号', render: (_, row) => row.schedule_no && row.schedule_no > 0 ? String(row.schedule_no) : '-' },
        { title: '加工单号', dataIndex: 'code' },
        { title: '商品编号', render: (_, row) => row.product_snapshot.code ?? '-' },
        { title: '商品', render: (_, row) => row.product_snapshot.name ?? '-' },
        { title: '商品规格', render: (_, row) => row.product_snapshot.specification ?? '-' },
        { title: '商品图片', render: () => '-' },
        { title: '计划数', render: (_, row) => qtyText(row.plan_qty) },
        { title: '状态', render: (_, row) => execText[row.execution] ?? row.execution },
        { title: '暂停原因', render: (_, row) => row.pause_reason || '-' },
        { title: '交货日期', render: (_, row) => row.due_date?.slice(0, 10) || '-' },
        { title: '优先级', render: (_, row) => row.priority || '-' },
        { title: '工序进度', render: (_, row) => <ProgressCell done={row.process_progress.done} total={row.process_progress.total} /> },
        { title: '备注', render: (_, row) => row.note || '-' },
        { title: '附件', render: () => '-' },
        { title: '计划开始', render: (_, row) => row.planned_start?.slice(0, 10) || '-' },
        { title: '计划结束', render: (_, row) => row.planned_end?.slice(0, 10) || '-' },
        { title: '创建人', render: (_, row) => row.creator_name || '-' },
        { title: '创建时间', render: (_, row) => row.created_at ? beijingTime(row.created_at) : '-' },
      ]}
      onRow={(_, index) => ({
        draggable: true,
        onDragStart: (event) => { event.dataTransfer.setData('text/plain', String(index)); },
        onDragOver: (event) => event.preventDefault(),
        onDrop: (event) => {
          event.preventDefault();
          const from = Number(event.dataTransfer.getData('text/plain'));
          const to = index ?? 0;
          const next = [...rows];
          const [moved] = next.splice(from, 1);
          if (!moved) return;
          next.splice(to, 0, moved);
          setRows(next);
          void apiRequest('/api/work-orders/schedule', { method: 'PUT', csrfToken: session.csrf_token, body: { ids: next.map((item) => item.id) } }).then(() => {
            Modal.success({ title: '排单成功', okText: '知道了' });
            onChanged();
          });
        },
      })}
    />
  </Modal>;
}

export function WorkOrderPickModal({ open, mode, currentId, onClose, onOk }: {
  open: boolean; mode: 'parent' | 'children'; currentId: string; onClose: () => void; onOk: (ids: string[]) => void;
}) {
  const [q, setQ] = useState({ code: '', name: '', productCode: '', spec: '' });
  const [rows, setRows] = useState<ProgressWorkOrderRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  async function search() {
    const data = await apiRequest<{ items: ProgressWorkOrderRow[] }>('/api/progress/work-orders?page=1&page_size=200');
    setRows((data.items ?? []).filter((row) => row.id !== currentId
      && (!q.code || row.code.includes(q.code))
      && (!q.name || (row.product_snapshot.name ?? '').includes(q.name))
      && (!q.productCode || (row.product_snapshot.code ?? '').includes(q.productCode))
      && (!q.spec || (row.product_snapshot.specification ?? '').includes(q.spec))));
  }
  return <Modal title="选择加工单" open={open} onCancel={onClose} okText="确定" cancelText="取消" width={1100}
    afterOpenChange={(v) => { if (v) { setSelected([]); void search(); } }}
    onOk={() => { if (!selected.length) { confirmText('请选择加工单', '请至少选择一张加工单', () => undefined); return; } onOk(selected); }}>
    <div className="kgd-toolbar">
      <Input placeholder="加工单号" value={q.code} onChange={(e) => setQ({ ...q, code: e.target.value })} style={{ width: 140 }} />
      <Input placeholder="商品名" value={q.name} onChange={(e) => setQ({ ...q, name: e.target.value })} style={{ width: 140 }} />
      <Input placeholder="商品编号" value={q.productCode} onChange={(e) => setQ({ ...q, productCode: e.target.value })} style={{ width: 140 }} />
      <Input placeholder="商品规格" value={q.spec} onChange={(e) => setQ({ ...q, spec: e.target.value })} style={{ width: 140 }} />
      <Button type="primary" onClick={() => void search()}>查询</Button>
    </div>
    <Table<ProgressWorkOrderRow> size="small" rowKey="id" dataSource={rows} pagination={{ pageSize: 10, showTotal: (n) => `共${n}条数据` }}
      rowSelection={{ type: mode === 'parent' ? 'radio' : 'checkbox', selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)) }}
      columns={[
        { title: '加工单号', dataIndex: 'code' }, { title: '合同编号', render: (_, row) => (row as ProgressWorkOrderRow & { contract_code?: string }).contract_code || '-' },
        { title: '业务员', render: () => '-' }, { title: '商品编号', render: (_, row) => row.product_snapshot.code ?? '-' },
        { title: '商品', render: (_, row) => row.product_snapshot.name ?? '-' }, { title: '商品规格', render: (_, row) => row.product_snapshot.specification ?? '-' },
        { title: '计划数', render: (_, row) => qtyText(row.plan_qty) }, { title: '库存', render: (_, row) => row.stock_qty || '-' },
        { title: '状态', render: (_, row) => execText[row.execution] ?? row.execution }, { title: '交货日期', render: (_, row) => row.due_date?.slice(0, 10) || '-' },
        { title: '优先级', render: (_, row) => row.priority || '-' }, { title: '工序流程', render: (_, row) => (row.ring_tasks ?? []).map((t) => t.process_name).join('→') || '-' },
        { title: '备注', render: (_, row) => row.note || '-' }, { title: '附件', render: () => '-' },
        { title: '计划开始', render: (_, row) => row.planned_start?.slice(0, 10) || '-' }, { title: '计划结束', render: (_, row) => row.planned_end?.slice(0, 10) || '-' },
        { title: '创建人', render: (_, row) => row.creator_name || '-' }, { title: '创建时间', render: (_, row) => row.created_at ? beijingTime(row.created_at) : '-' },
      ]} />
  </Modal>;
}

export function ShareProgressModal({ open, code, onClose }: { open: boolean; code: string; onClose: () => void }) {
  return <Modal title="分享加工单进度" open={open} onCancel={onClose} footer={null} width={420}>
    <div style={{ textAlign: 'center' }}>
      <AsyncQr key={code} make={() => workOrderMobileUrl(code)} />
      <p>扫描二维码查看生产进度</p>
      <div className="kgd-toolbar" style={{ justifyContent: 'center' }}>
        <Button onClick={() => {
          const canvas = document.querySelector('.ant-modal-body canvas, .ant-modal-body img') as HTMLImageElement | null;
          if (canvas?.src) {
            const a = document.createElement('a');
            a.href = canvas.src;
            a.download = `${code}-progress.png`;
            a.click();
          }
        }}>分享二维码</Button>
        <Button type="primary" onClick={() => { void workOrderMobileUrl(code).then((url) => navigator.clipboard.writeText(url)).then(() => Modal.success({ title: '复制成功', okText: '知道了' })); }}>分享链接</Button>
      </div>
    </div>
  </Modal>;
}
