import { useNavigate } from 'react-router-dom';
import { Button } from 'antd';
import { durationText, StatusTag, when } from '../../kit';
import { qtyText } from '../../qty';
import './progress.css';

const taskText: Record<string, string> = { not_started: '未开始', running: '进行中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };

export type TaskRingData = {
  process_name: string;
  execution: string;
  plan_qty: string;
  approved_good: string;
  approved_defect: string;
  effective_seconds?: number;
  last_report_at?: string | null;
  planned_start?: string | null;
  planned_end?: string | null;
};

export function TaskHoverCard({ task, workOrderCode }: { task: TaskRingData; workOrderCode: string }) {
  const navigate = useNavigate();
  return (
    <div className="kgd-task-hover-card">
      <h4>
        {task.process_name}{' '}
        <StatusTag text={taskText[task.execution] ?? task.execution} />
      </h4>
      <dl>
        <dt>生产进度</dt>
        <dd>{qtyText(task.approved_good)}/{qtyText(task.plan_qty)}</dd>
        <dt>计划生产数</dt>
        <dd>{qtyText(task.plan_qty)}</dd>
        <dt>已报工良品总数</dt>
        <dd className="good">{qtyText(task.approved_good)}</dd>
        <dt>已报工不良品数</dt>
        <dd className="bad">{qtyText(task.approved_defect)}</dd>
        <dt>工序时长</dt>
        <dd>{durationText(task.effective_seconds ?? 0) || '0'}</dd>
        <dt>最近报工时间</dt>
        <dd>{task.last_report_at ? when(task.last_report_at) : '无'}</dd>
      </dl>
      <Button
        type="link"
        size="small"
        onClick={() => navigate(`/work_repoty_record/list?work_order_code=${encodeURIComponent(workOrderCode)}&process=${encodeURIComponent(task.process_name)}`)}
      >
        查看报工
      </Button>
    </div>
  );
}
