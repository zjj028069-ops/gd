import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../api';
import { useKgd } from '../context';
import { beijingTime, showError } from '../kit';

export type ExtEntity =
  | 'work_order' | 'linkman' | 'customer'
  | 'supplier' | 'purchase_plan' | 'purchase_order'
  | 'purchase_stock_in' | 'purchase_stock_in_line'
  | 'customer_contract' | 'contract_quotation' | 'customer_follow'
  | 'customer_financier' | 'customer_invoice' | 'selling_expense'
  | 'else_stock_in' | 'else_stock_out'
  | 'stock_taking' | 'stock_allocate'
  | 'fg_receipt' | 'fg_receipt_line'
  | 'semi_fg'
  | 'sale_stock_out' | 'purchase_return' | 'material_issue' | 'prod_return' | 'sales_return'
  | 'craft' | 'bom'
  | 'production_plan'
  | 'lean_meeting' | 'meeting_agenda';

export type ExtField = {
  id: string;
  key: string;
  name: string;
  type: string;
  field_type: string;
  required: boolean;
  required_text: string;
  sort_no: number;
  options: {
    choices?: string[];
    formula?: string;
    autofill?: { source: string; field: string };
    input_modes?: string[];
    decimals?: number;
    biz_object?: string;
    display_field?: string;
    rel_object?: string;
    rel_field?: string;
    sedric_suppressed?: boolean;
    sedric_app_id?: string;
    list_filter?: {
      kind: 'presence';
      chip_key: string;
      label: string;
      has_label: string;
      none_label: string;
    };
  };
  created_at: string;
  createdAt: string;
};

export type ExtValues = Record<string, unknown>;

export async function putEntityExtValues(csrfToken: string, entity: ExtEntity, recordId: string, values: ExtValues) {
  if (!recordId) throw new Error('缺少记录ID');
  await apiRequest('/api/entity-ext-values', {
    method: 'PUT', csrfToken,
    body: { entity, record_id: recordId, values },
  });
}

export function useEntityExtensions(entity: ExtEntity | null, recordId?: string | null) {
  const { session, revision, onExpired } = useKgd();
  const [fields, setFields] = useState<ExtField[]>([]);
  const [values, setValues] = useState<ExtValues>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reloadFields = useCallback(async () => {
    if (!entity) { setFields([]); setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<{ items: ExtField[] }>(`/api/entity-ext-fields?entity=${entity}`);
      setFields((data.items ?? []).filter((item) => item.options?.sedric_suppressed !== true).map((item) => ({
        ...item,
        key: item.id,
        createdAt: item.createdAt || beijingTime(item.created_at, ''),
      })));
    } catch (failure) {
      if ((failure as { status?: number })?.status === 401) onExpired();
      setError(showError(failure));
    } finally {
      setLoading(false);
    }
  }, [entity, onExpired]);

  const reloadValues = useCallback(async () => {
    if (!entity || !recordId) { setValues({}); return; }
    try {
      const data = await apiRequest<{ values: ExtValues }>(`/api/entity-ext-values?entity=${entity}&record_id=${recordId}`);
      setValues(data.values ?? {});
    } catch (failure) {
      if ((failure as { status?: number })?.status === 401) onExpired();
      setError(showError(failure));
    }
  }, [entity, onExpired, recordId]);

  useEffect(() => { void reloadFields(); }, [reloadFields, revision]);
  useEffect(() => { void reloadValues(); }, [reloadValues, revision]);

  async function createField(payload: Record<string, unknown>) {
    if (!entity) throw new Error('未指定扩展对象');
    await apiRequest('/api/entity-ext-fields', { method: 'POST', csrfToken: session.csrf_token, body: { entity, ...payload } });
    await reloadFields();
  }

  async function updateField(id: string, payload: Record<string, unknown>) {
    await apiRequest(`/api/entity-ext-fields/${id}`, { method: 'PUT', csrfToken: session.csrf_token, body: payload });
    await reloadFields();
  }

  async function deleteField(id: string) {
    await apiRequest(`/api/entity-ext-fields/${id}`, { method: 'DELETE', csrfToken: session.csrf_token, body: {} });
    await reloadFields();
  }

  async function reorder(ids: string[]) {
    if (!entity) throw new Error('未指定扩展对象');
    await apiRequest('/api/entity-ext-fields/reorder', { method: 'PUT', csrfToken: session.csrf_token, body: { entity, ids } });
    await reloadFields();
  }

  async function saveValues(next: ExtValues, ctx?: { product_id?: string; contract_id?: string; contract_line_id?: string }) {
    if (!entity) throw new Error('未指定扩展对象');
    if (!recordId) throw new Error('缺少记录ID');
    const data = await apiRequest<{ values: ExtValues }>('/api/entity-ext-values', {
      method: 'PUT', csrfToken: session.csrf_token,
      body: { entity, record_id: recordId, values: next, ...ctx },
    });
    setValues(data.values ?? next);
    return data.values ?? next;
  }

  async function previewAutofill(ctx: { product_id?: string; contract_id?: string; contract_line_id?: string }) {
    const data = await apiRequest<{ values: ExtValues }>('/api/entity-ext-fields/autofill-preview', {
      method: 'POST', csrfToken: session.csrf_token,
      body: { entity, ...ctx },
    });
    return data.values ?? {};
  }

  function validateRequired(next: ExtValues = values) {
    for (const field of fields) {
      if (!field.required) continue;
      const value = next[field.id];
      const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
      if (empty) return `请填写${field.name}`;
    }
    return '';
  }

  const extensionRows = fields.map((field) => ({
    key: field.id,
    name: field.name,
    type: field.type || field.field_type,
    required: field.required_text || (field.required ? '是' : '否'),
    createdAt: field.createdAt || beijingTime(field.created_at, ''),
  }));

  return {
    fields, values, setValues, loading, error, extensionRows,
    reloadFields, reloadValues, createField, updateField, deleteField, reorder, saveValues, previewAutofill, validateRequired,
  };
}
