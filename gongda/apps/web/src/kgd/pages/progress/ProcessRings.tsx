import { Popover } from 'antd';
import type { ReactNode } from 'react';
import { qtyText } from '../../qty';
import { TaskHoverCard, type TaskRingData } from './TaskHoverCard';
import './progress.css';

export type RingTask = TaskRingData & {
  id: string;
  process_name: string;
  ring_percent: number;
};

function RingSvg({ percent }: { percent: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  const dash = (p / 100) * c;
  const color = p >= 100 ? '#52c41a' : p > 0 ? '#52c41a' : '#e8e8e8';
  return (
    <svg width="40" height="40" viewBox="0 0 40 40">
      <circle cx="20" cy="20" r={r} fill="none" stroke="#e8e8e8" strokeWidth="4" />
      {p > 0 && (
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeLinecap="round"
          transform="rotate(-90 20 20)"
        />
      )}
    </svg>
  );
}

function truncate(name: string) {
  return name.length > 8 ? `${name.slice(0, 7)}…` : name;
}

export function ProcessRings({ tasks, workOrderCode, extra, mode = 'percent' }: { tasks?: RingTask[] | null; workOrderCode?: string; extra?: (task: RingTask) => ReactNode; mode?: 'percent' | 'qty' }) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return <span className="kgd-muted">—</span>;
  return (
    <div className="kgd-process-rings">
      {list.map((task, index) => (
        <span key={task.id} style={{ display: 'contents' }}>
          {index > 0 && <span className="kgd-ring-connector" aria-hidden />}
          <Popover
            trigger="hover"
            placement="top"
            content={extra?.(task) ?? <TaskHoverCard task={task} workOrderCode={workOrderCode ?? ''} />}
          >
            <span className="kgd-ring-node">
              <span className="kgd-ring-wrap">
                <RingSvg percent={Number(task.ring_percent) || 0} />
                <span className="kgd-ring-pct">{mode === 'qty' ? qtyText(String(task.approved_good)) : `${Number(task.ring_percent) || 0}%`}</span>
              </span>
              <span className="kgd-ring-name" title={task.process_name}>{truncate(task.process_name)}</span>
            </span>
          </Popover>
        </span>
      ))}
    </div>
  );
}
