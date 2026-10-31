import { useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Input, Select } from 'antd';
import { useRemote } from '../../../../masterTools';
import { ListFrame, type ListColumn } from '../../../ListFrame';
import { showError, useCommand, useQueryState } from '../../../kit';
import { useKgd } from '../../../context';
import { App } from 'antd';
import { dash, StatusTag } from '../../round8/kit';

export function idFromLocation(prefix: string) {
  const { pathname } = useLocation();
  if (!pathname.startsWith(prefix)) return '';
  return pathname.slice(prefix.length).split('/')[0] ?? '';
}

export type Rec = Record<string, unknown> & { id: string };
export type { ListColumn, ReactNode };

export function emptyVal(v: unknown) {
  if (v === null || v === undefined || v === '') return '无';
  return String(v);
}

export function useEquipApi() {
  const { revision, onExpired } = useKgd();
  const { message, modal } = App.useApp();
  const command = useCommand();
  async function act<T = unknown>(url: string, body?: Record<string, unknown>, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST') {
    try {
      const result = await command.send(url, body ?? {}, method) as T;
      return result;
    } catch (error) {
      message.error(showError(error));
      return null;
    }
  }
  return { revision, onExpired, message, modal, command, act };
}

export function AdvSearch({ open, fields, onSearch, onClear, onClose }: { open: boolean; fields: string[]; onSearch: () => void; onClear: () => void; onClose?: () => void }) {
  const [rows, setRows] = useState([{ field: '', value: '' }]);
  if (!open) return null;
  return <div className="kgd-adv kgd-card" style={{ marginBottom: 8, padding: 12 }}>
    <div className="kgd-adv-field-list" style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 8 }}>{fields.join('、')}</div>
    {rows.map((row, index) => <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
      <Select popupClassName="kgd-adv-drop" style={{ width: 180 }} placeholder="输入关键词搜索" showSearch value={row.field || undefined} options={fields.map((f) => ({ value: f, label: f }))} onChange={(v) => setRows((cur) => cur.map((r, i) => i === index ? { ...r, field: v } : r))} />
      <Input style={{ width: 200 }} value={row.value} onChange={(e) => setRows((cur) => cur.map((r, i) => i === index ? { ...r, value: e.target.value } : r))} />
      <Button type="link" danger onClick={() => setRows((cur) => cur.filter((_, i) => i !== index))}>删除</Button>
      <label><input type="checkbox" /> 常用</label>
    </div>)}
    <div style={{ display: 'flex', gap: 8 }}>
      <Button type="link" onClick={() => setRows((cur) => [...cur, { field: '', value: '' }])}>+ 添加筛选条件</Button>
      <Button type="primary" onClick={() => { onSearch(); onClose?.(); }}>搜 索</Button>
      <Button onClick={() => { setRows([{ field: '', value: '' }]); onClear(); onClose?.(); }}>清空筛选值</Button>
    </div>
  </div>;
}

export function mobileFieldsFrom(cols: { key: string; title: string }[]) {
  return { list: cols.filter((c) => c.key !== 'actions').map((c) => ({ key: c.key, label: c.title })) };
}

export function redBorder(err: boolean): CSSProperties | undefined {
  return err ? { borderColor: '#ff4d4f' } : undefined;
}

export { useRemote, ListFrame, showError, useCommand, useQueryState, useKgd, dash, StatusTag, useState, App, Button };
