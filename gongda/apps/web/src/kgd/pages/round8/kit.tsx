import type { ReactNode } from 'react';
import { Tag } from 'antd';

const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function dash(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  const text = String(value).replace(new RegExp(uuidText.source, 'gi'), '').trim();
  return text || '-';
}

/** 关联列：可读标题原样显示；整段 uuid 改为中文来源名；没有则「-」。 */
export function linkText(ref: unknown, source?: unknown) {
  const code = ref === null || ref === undefined ? '' : String(ref).trim();
  if (code && !uuidText.test(code)) return code;
  if (!code) return '-';
  const name = source === null || source === undefined ? '' : String(source).trim();
  if (name && !uuidText.test(name)) return name;
  return '-';
}

export function StatusTag({ text }: { text: string }) {
  const color = text === '运行中' || text === '在线' ? 'blue'
    : text === '正常' || text === '已质检' || text === '已完成' || text === '已结算' || text === '已处理' || text === '已落地' || text === '启用' ? 'green'
      : text === '维修中' || text === '生产中' || text === '待质检' || text === '待处理' || text === '未结算' || text === '报警中' || text === '待接单' || text === '处理中' ? 'orange'
        : undefined;
  return <Tag color={color}>{dash(text)}</Tag>;
}

export function RedSummary({ parts }: { parts: [string, string | number][] }) {
  return <div className="kgd-summary">{parts.map(([label, value]) => <span key={label}>【{label}】{value}</span>)}</div>;
}

export function Bars({ rows }: { rows: { name: string; qty: string }[] }) {
  const max = Math.max(1, ...rows.map((row) => Number(row.qty) || 0));
  return <div style={{ margin: '8px 0 12px' }}>{rows.map((row) => <div key={row.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
    <span style={{ width: 120 }}>{row.name}</span>
    <span style={{ display: 'inline-block', height: 14, width: `${Math.max(8, (Number(row.qty) / max) * 280)}px`, background: '#1677ff' }} />
    <b>{row.qty}</b>
  </div>)}</div>;
}

export function field(label: string, node: ReactNode, required = false) {
  return <label key={label} className="form-field" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}><span>{required ? `*${label}` : label}</span>{node}</label>;
}
