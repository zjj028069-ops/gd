import { Cascader, DatePicker, Input, InputNumber, Select, TimePicker } from 'antd';
import dayjs from 'dayjs';
import type { ExtField, ExtValues } from './useEntityExtensions';

export function ExtFieldInputs({ fields, values, onChange }: {
  fields: ExtField[];
  values: ExtValues;
  onChange: (next: ExtValues) => void;
}) {
  if (!fields.length) return null;
  function set(id: string, value: unknown) {
    onChange({ ...values, [id]: value });
  }
  return <>
    {fields.map((field) => {
      const type = field.type || field.field_type;
      const value = values[field.id];
      const label = <>{field.required ? <span style={{ color: 'red' }}>*</span> : null}{field.name}</>;
      if (type === '多行文本') {
        return <span key={field.id} style={{ display: 'contents' }}><span>{label}</span><Input.TextArea value={String(value ?? '')} onChange={(event) => set(field.id, event.target.value)} rows={3} /></span>;
      }
      if (type === '数字输入框') {
        return <span key={field.id} style={{ display: 'contents' }}><span>{label}</span><InputNumber style={{ width: '100%' }} value={value === '' || value == null ? null : Number(value)} onChange={(next) => set(field.id, next == null ? '' : String(next))} /></span>;
      }
      if (type === '单选下拉框') {
        return <span key={field.id} style={{ display: 'contents' }}><span>{label}</span><Select allowClear style={{ width: '100%' }} value={value ? String(value) : undefined} options={(field.options.choices ?? []).map((item) => ({ value: item, label: item }))} onChange={(next) => set(field.id, next ?? '')} /></span>;
      }
      if (type === '多选下拉框') {
        const selected = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
        return <span key={field.id} style={{ display: 'contents' }}><span>{label}</span><Select mode="multiple" style={{ width: '100%' }} value={selected} options={(field.options.choices ?? []).map((item) => ({ value: item, label: item }))} onChange={(next) => set(field.id, next)} /></span>;
      }
      if (type === '日期') {
        return <span key={field.id} style={{ display: 'contents' }}><span>{label}</span><DatePicker style={{ width: '100%' }} value={value ? dayjs(String(value)) : null} onChange={(next) => set(field.id, next ? next.format('YYYY-MM-DD') : '')} /></span>;
      }
      if (type === '时间') {
        return <span key={field.id} style={{ display: 'contents' }}><span>{label}</span><TimePicker style={{ width: '100%' }} value={value ? dayjs(String(value), 'HH:mm:ss') : null} onChange={(next) => set(field.id, next ? next.format('HH:mm:ss') : '')} /></span>;
      }
      if (type === '公式') {
        return <span key={field.id} style={{ display: 'contents' }}><span>{label}</span><Input readOnly value={String(value ?? field.options.formula ?? '')} prefix="fx" /></span>;
      }
      return <span key={field.id} style={{ display: 'contents' }}><span>{label}</span><Input value={String(value ?? '')} onChange={(event) => set(field.id, event.target.value)} placeholder={type} /></span>;
    })}
  </>;
}

export function AutofillCascader({ value, onChange, options }: {
  value?: string[];
  onChange: (path: string[] | undefined) => void;
  options: { value: string; label: string; children?: { value: string; label: string }[] }[];
}) {
  return <Cascader style={{ width: '100%' }} options={options} value={value} onChange={(next) => onChange(next?.map(String))} placeholder="请选择自动填充规则" allowClear changeOnSelect={false} />;
}
