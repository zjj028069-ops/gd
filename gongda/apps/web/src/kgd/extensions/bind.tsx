import { useEffect, useState } from 'react';
import { App } from 'antd';
import { ExtensionAddDialog } from '../dialogs';
import type { ExtensionAddMode, ExtensionAddValue, ExtensionTab } from '../dialogs';
import { showError } from '../kit';
import { ExtFieldInputs } from './ExtFieldInputs';
import { putEntityExtValues, useEntityExtensions } from './useEntityExtensions';
import type { ExtEntity, ExtValues } from './useEntityExtensions';

export type ExtUi = {
  object: string;
  title: string;
  mode: ExtensionAddMode;
};

export const EXT_UI: Record<ExtEntity, ExtUi> = {
  work_order: { object: '加工单', title: '【加工单】扩展字段管理', mode: 'work_order' },
  linkman: { object: '客户联系人', title: '【客户联系人】扩展字段管理', mode: 'linkman' },
  customer: { object: '客户管理', title: '【客户管理】扩展字段管理', mode: 'customer' },
  supplier: { object: '供应商', title: '【供应商】扩展字段管理', mode: 'standard' },
  purchase_plan: { object: '采购计划', title: '【采购计划】扩展字段管理', mode: 'standard' },
  purchase_order: { object: '采购单', title: '【采购单】扩展字段管理', mode: 'standard' },
  purchase_stock_in: { object: '采购入库单', title: '【采购入库单】扩展字段（主表/明细）', mode: 'standard' },
  purchase_stock_in_line: { object: '采购入库单', title: '【采购入库单】扩展字段（主表/明细）', mode: 'standard' },
  customer_contract: { object: '合同订单', title: '【合同订单】扩展字段管理', mode: 'standard' },
  contract_quotation: { object: '合同报价单', title: '【合同报价单】扩展字段管理', mode: 'standard' },
  customer_follow: { object: '客户跟单', title: '【客户跟单】扩展字段管理', mode: 'standard' },
  customer_financier: { object: '收支记录', title: '【收支记录】扩展字段管理', mode: 'standard' },
  customer_invoice: { object: '发票管理', title: '【发票管理】扩展字段管理', mode: 'standard' },
  selling_expense: { object: '销售费用', title: '【销售费用】扩展字段管理', mode: 'standard' },
  else_stock_in: { object: '其他入库单', title: '【其他入库单】扩展字段管理', mode: 'standard' },
  else_stock_out: { object: '其他出库单', title: '【其他出库单】扩展字段管理', mode: 'standard' },
  stock_taking: { object: '库存盘点', title: '【库存盘点】扩展字段管理', mode: 'standard' },
  stock_allocate: { object: '调拨单', title: '【调拨单】扩展字段管理', mode: 'standard' },
  fg_receipt: { object: '成品入库单', title: '【成品入库单】扩展字段管理', mode: 'standard' },
  fg_receipt_line: { object: '成品入库单', title: '【成品入库单】扩展字段管理', mode: 'standard' },
  semi_fg: { object: '半成品入库单', title: '【半成品入库单】扩展字段管理', mode: 'standard' },
  sale_stock_out: { object: '销售出库单', title: '【销售出库单】扩展字段管理', mode: 'standard' },
  purchase_return: { object: '采购退货单', title: '【采购退货单】扩展字段管理', mode: 'standard' },
  material_issue: { object: '生产出库单', title: '【生产出库单】扩展字段管理', mode: 'standard' },
  prod_return: { object: '生产退料单', title: '【生产退料单】扩展字段管理', mode: 'standard' },
  sales_return: { object: '销售退货单', title: '【销售退货单】扩展字段管理', mode: 'standard' },
  craft: { object: '工序管理', title: '【工序管理】扩展字段管理', mode: 'craft' },
  bom: { object: 'BOM管理', title: '【BOM管理】扩展字段管理', mode: 'bom' },
  production_plan: { object: '生产计划', title: '【生产计划】扩展字段管理', mode: 'standard' },
  lean_meeting: { object: '精益会议', title: '精益会议扩展字段管理', mode: 'standard' },
  meeting_agenda: { object: '会议议程', title: '会议议程字段管理', mode: 'standard' },
};

export function extFieldPayload(value: ExtensionAddValue) {
  return {
    name: value.label,
    required: value.required,
    field_type: value.type,
    options: {
      choices_text: value.options,
      formula: value.formula,
      autofill: value.autofill,
      input_modes: value.input_modes,
      decimals: value.decimals,
      biz_object: value.biz_object,
      display_field: value.display_field,
      rel_object: value.rel_object,
      rel_field: value.rel_field,
    },
  };
}

export function useExtList(entity: ExtEntity) {
  const { message } = App.useApp();
  const ext = useEntityExtensions(entity);
  const [add, setAdd] = useState(false);
  const ui = EXT_UI[entity];
  const props = {
    extensionObject: ui.object,
    extensionTitle: ui.title,
    extensionRows: ext.extensionRows,
    extensionCanAdd: true as const,
    onExtensionAdd: () => setAdd(true),
    onExtensionReorder: (ids: string[]) => { void ext.reorder(ids).catch((failure) => message.error(showError(failure))); },
    onExtensionDelete: (id: string) => { void ext.deleteField(id).catch((failure) => message.error(showError(failure))); },
  };
  const dialog = <ExtensionAddDialog open={add} mode={ui.mode} onCancel={() => setAdd(false)} onOk={(value) => {
    void ext.createField(extFieldPayload(value)).then(() => setAdd(false)).catch((failure) => message.error(showError(failure)));
  }} />;
  return { props, dialog, ext };
}

export function useExtForm(entity: ExtEntity, recordId?: string) {
  const ext = useEntityExtensions(entity, recordId);
  const [values, setValues] = useState<ExtValues>({});
  useEffect(() => { setValues(ext.values); }, [ext.values]);
  return {
    fields: ext.fields,
    values,
    setValues,
    node: ext.fields.length > 0 ? <div className="kgd-form ext-fields"><ExtFieldInputs fields={ext.fields} values={values} onChange={setValues} /></div> : null,
    error(next?: ExtValues) { return ext.validateRequired(next ?? values); },
    async persist(csrf: string, id: string) {
      if (!id || !ext.fields.length) return;
      await putEntityExtValues(csrf, entity, id, values);
    },
  };
}

export type BillExtSpec = {
  path: string;
  head: ExtEntity;
  line?: ExtEntity;
  headTab?: string;
  lineTab?: string;
};

export const BILL_EXT: BillExtSpec[] = [
  { path: '/purchase_stock_in_bill/list', head: 'purchase_stock_in', line: 'purchase_stock_in_line', headTab: '采购入库单扩展字段', lineTab: '入库明细扩展字段' },
  { path: '/produce_stock_in_bill/list', head: 'fg_receipt', line: 'fg_receipt_line', headTab: '成品入库单扩展字段', lineTab: '入库明细扩展字段' },
  { path: '/else_stock_in_bill/list', head: 'else_stock_in' },
  { path: '/else_stock_out_bill/list', head: 'else_stock_out' },
  { path: '/stock_taking_bill/list', head: 'stock_taking' },
  { path: '/stock_allocate_bill/list', head: 'stock_allocate' },
  { path: '/semi_finished_products_stock_in_bill/list', head: 'semi_fg' },
  { path: '/sale_stock_out_bill/list', head: 'sale_stock_out' },
  { path: '/purchase_return_bill/list', head: 'purchase_return' },
  { path: '/production_out_of_storage/list', head: 'material_issue' },
  { path: '/produce_return_materiel_bill/list', head: 'prod_return' },
  { path: '/salesReturnOrder/list', head: 'sales_return' },
];

export function useBillExtension(pathname: string) {
  const spec = BILL_EXT.find((item) => item.path === pathname) ?? null;
  const { message } = App.useApp();
  const head = useEntityExtensions(spec?.head ?? null);
  const line = useEntityExtensions(spec?.line ?? null);
  const [add, setAdd] = useState<ExtEntity | null>(null);
  const ui = spec ? EXT_UI[spec.head] : null;
  function bind(entity: ExtEntity, api: typeof head) {
    return {
      onReorder: (ids: string[]) => { void api.reorder(ids).catch((failure) => message.error(showError(failure))); },
      onDelete: (id: string) => { void api.deleteField(id).catch((failure) => message.error(showError(failure))); },
      onAdd: () => setAdd(entity),
    };
  }
  const tabs: ExtensionTab[] | undefined = spec?.line && spec.headTab && spec.lineTab ? [
    { key: 'head', label: spec.headTab, rows: head.extensionRows, ...bind(spec.head, head) },
    { key: 'line', label: spec.lineTab, rows: line.extensionRows, ...bind(spec.line, line) },
  ] : undefined;
  const headBind = spec ? bind(spec.head, head) : null;
  const props = spec && ui ? {
    extensionObject: ui.object,
    extensionTitle: ui.title,
    extensionRows: head.extensionRows,
    extensionTabs: tabs,
    extensionCanAdd: true as const,
    onExtensionAdd: headBind?.onAdd,
    onExtensionReorder: tabs ? undefined : headBind?.onReorder,
    onExtensionDelete: tabs ? undefined : headBind?.onDelete,
  } : {};
  const dialog = <ExtensionAddDialog open={!!add} mode={add ? EXT_UI[add].mode : 'standard'} onCancel={() => setAdd(null)} onOk={(value) => {
    const target = add === spec?.line ? line : head;
    void target.createField(extFieldPayload(value)).then(() => setAdd(null)).catch((failure) => message.error(showError(failure)));
  }} />;
  return { spec, props, dialog, head, line };
}
