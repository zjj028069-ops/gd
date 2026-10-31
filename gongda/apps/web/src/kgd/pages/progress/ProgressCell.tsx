import { qtyText } from '../../qty';
import { floorPercent } from './progressUtils';
import './progress.css';

type Props = {
  done?: string | number | null;
  total?: string | number | null;
  /** 已格式化的进度文案，例如「70% (70/100)」，与仓库/合同列表共用同一组件 */
  progress?: string;
  complete?: boolean;
  className?: string;
  /** bar=条形；circle=百分比圆圈（加工单任务/工序进度对齐原版） */
  variant?: 'bar' | 'circle';
};

function RingSvg({ percent }: { percent: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const dash = (p / 100) * c;
  const color = p >= 100 ? '#52c41a' : p > 0 ? '#1890ff' : '#e8e8e8';
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
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

export function ProgressCell({ done, total, progress, complete, className, variant = 'bar' }: Props) {
  const parsed = progress?.match(/^(-?[\d.]+)%/);
  const dText = done == null || done === '' ? '0' : typeof done === 'number' ? String(done) : String(done);
  const tText = total == null || total === '' ? '0' : typeof total === 'number' ? String(total) : String(total);
  const pct = parsed ? Math.floor(Number(parsed[1])) : floorPercent(dText, tText);
  const safePct = Number.isFinite(pct) ? pct : 0;
  const isFull = complete || safePct >= 100;
  const isZero = safePct <= 0;
  const caption = progress ?? `${safePct}% (${qtyText(dText)}/${qtyText(tText)})`;
  const fillClass = isFull ? 'green' : isZero ? '' : 'blue';
  const captionClass = isFull ? 'green' : isZero ? '' : 'blue';
  if (variant === 'circle') {
    return (
      <div className={`kgd-progress-cell kgd-progress-circle ${className ?? ''}`}>
        <span className="kgd-ring-wrap">
          <RingSvg percent={safePct} />
          <span className="kgd-ring-pct">{safePct}%</span>
        </span>
        <div className={`kgd-progress-caption ${captionClass}`}>{caption}</div>
      </div>
    );
  }
  return (
    <div className={`kgd-progress-cell ${className ?? ''}`}>
      <div className="kgd-progress-track">
        {!isZero && <div className={`kgd-progress-fill ${fillClass}`} style={{ width: `${Math.min(safePct, 100)}%` }} />}
      </div>
      <div className={`kgd-progress-caption ${captionClass}`}>{caption}</div>
    </div>
  );
}
