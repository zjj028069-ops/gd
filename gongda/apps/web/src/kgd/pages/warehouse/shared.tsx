import type { ReactNode } from 'react';
import { Progress, Tag } from 'antd';
import type { WhRec } from './useWarehouseApi';

export const auditText: Record<string, string> = {
  exempt: '不需审核',
  pending: '待审',
  approved: '通过',
  rejected: '退回',
  withdrawn: '撤回',
};

export function AuditTag({ status }: { status?: string }) {
  const text = auditText[String(status ?? '')] ?? '-';
  const color = text === '不需审核' ? 'default' : text === '待审' ? 'gold' : text === '通过' ? 'green' : text === '退回' ? 'red' : undefined;
  return <Tag color={color}>{text}</Tag>;
}

export function ProgressCell({ progress, complete }: { progress?: string; complete?: boolean }) {
  const raw = !progress || progress === 'undefined' || progress === 'null' ? '0% (0/0)' : String(progress);
  const m = raw.match(/^([\d.]+)%/);
  const pct = m ? Number(m[1]) : 0;
  return <span className="wh-progress-cell"><Progress percent={pct} size="small" showInfo={false} strokeColor={complete || pct >= 100 ? '#52c41a' : '#1890ff'} /><span>{raw}</span></span>;
}

export function whName(row: WhRec, field: 'warehouse_id' | 'from_warehouse_id' | 'to_warehouse_id' = 'warehouse_id') {
  const nameKey = field === 'warehouse_id' ? 'warehouse_name' : field === 'from_warehouse_id' ? 'from_warehouse_name' : 'to_warehouse_name';
  const named = row[nameKey];
  if (named) return String(named);
  const id = row[field];
  return id ? String(id) : '';
}

export function flattenReceipts(items: WhRec[]) {
  const rows: WhRec[] = [];
  for (const head of items) {
    const lines = (head.lines as WhRec[] | undefined) ?? [{ id: head.id }];
    lines.forEach((line, index) => {
      rows.push({
        ...head,
        ...line,
        id: `${head.id}:${line.id ?? index}`,
        _headId: head.id,
        _lineId: line.id,
        _span: index === 0 ? lines.length : 0,
      });
    });
  }
  return rows;
}

export function spanCell(key: string, heads: Set<string>, render: (row: WhRec) => ReactNode): { render: (row: WhRec) => ReactNode; onCell?: (row: WhRec) => { rowSpan?: number } } {
  return {
    render: (row) => (row._span || !heads.has(key) ? render(row) : ''),
    onCell: heads.has(key) ? (row) => ({ rowSpan: Number(row._span ?? 1) }) : undefined,
  };
}

export function centsYuan(cents?: string | number | null) {
  if (cents == null || cents === '') return '0';
  const n = BigInt(String(cents).split('.')[0] ?? '0');
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function sumLinesQty(lines: WhRec[] | undefined, field = 'quantity') {
  return (lines ?? []).reduce((total, line) => {
    const q = String(line[field] ?? '0');
    return total + (Number(q) || 0);
  }, 0);
}
