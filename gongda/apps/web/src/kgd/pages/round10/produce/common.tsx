import { Select } from 'antd';
import type { CSSProperties } from 'react';
import { useList } from '../shared';
import type { Row } from '../shared';

export function WorkOrderPick({ value, onChange, multiple, style, placeholder = '请选择加工单' }: { value: string | string[]; onChange: (value: any) => void; multiple?: boolean; style?: CSSProperties; placeholder?: string }) {
  const orders = useList<Row>('/api/progress/work-orders?page=1&page_size=200');
  const options = (orders.data?.items ?? []).map((item) => ({ value: String(item.id), label: `${item.code ?? ''} ${item.product_snapshot?.name ?? item.product_name ?? ''}`.trim() }));
  return <Select mode={multiple ? 'multiple' : undefined} allowClear showSearch optionFilterProp="label" style={{ width: '100%', ...style }} placeholder={placeholder} value={multiple ? (value as string[]) : ((value as string) || undefined)} options={options} onChange={(next) => onChange(multiple ? (next ?? []) : (next ?? ''))} />;
}

export function DictPick({ path, value, onChange, multiple, placeholder, labelKey = 'name', style }: { path: string; value: string | string[]; onChange: (value: any) => void; multiple?: boolean; placeholder?: string; labelKey?: string; style?: CSSProperties }) {
  const remote = useList<Row>(path);
  const options = (remote.data?.items ?? []).map((item) => ({ value: String(item.id), label: String(item[labelKey] ?? item.name ?? item.code ?? '') }));
  return <Select mode={multiple ? 'multiple' : undefined} allowClear showSearch optionFilterProp="label" style={{ width: '100%', ...style }} placeholder={placeholder ?? '请选择'} value={multiple ? (value as string[]) : ((value as string) || undefined)} options={options} onChange={(next) => onChange(multiple ? (next ?? []) : (next ?? ''))} />;
}

export function blank(value: unknown) {
  return value === null || value === undefined || value === '-' ? '' : String(value);
}

export function idFromPath(pathname: string, marker: string) {
  const index = pathname.indexOf(marker);
  return index < 0 ? '' : pathname.slice(index + marker.length).split(/[/?]/)[0] ?? '';
}
