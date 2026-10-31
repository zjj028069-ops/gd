import { requestKey } from '../requestKey';
/** 旧页面与快工单页面共用的请求体。字段取舍与原组件内联对象一致。 */

export function newRequestKey() {
  return requestKey();
}

export function customerCreatePayload(code: string, name: string) {
  return { request_key: newRequestKey(), code: code.trim(), name: name.trim() };
}

export function salesOrderCreatePayload(input: {
  customer_id: string;
  lines: { product_id: string; quantity: string; unit_price: string }[];
  note?: string;
  promised_date?: string | null;
}) {
  return {
    request_key: newRequestKey(),
    customer_id: input.customer_id,
    lines: input.lines,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    ...(input.promised_date ? { promised_date: input.promised_date } : {}),
  };
}

export function documentActionPayload(action: string, version: number, reason = '') {
  return { action, version, request_key: newRequestKey(), ...(reason.trim() ? { reason: reason.trim() } : {}) };
}

/** 任务暂停/恢复沿用加工台：不带 request_key。 */
export function taskActionPayload(action: string, version: number, reason = '') {
  return { action, version, ...(reason.trim() ? { reason: reason.trim() } : {}) };
}

export function workOrderCreatePayload(input: {
  sales_line_id?: string;
  contract_line_id?: string;
  product_id?: string;
  quantity: string;
  route_version_id?: string;
  bom_version_id?: string;
  warehouse_id?: string;
  code?: string;
  requires_fg_inspection: boolean;
  require_cost: boolean;
  priority?: string;
  due_date?: string | null;
  planned_start?: string | null;
  planned_end?: string | null;
  note?: string;
  production_plan_line_id?: string;
  unit_ratios?: { sequence: number; unit_ratio: string }[];
  tasks?: { process_id: string; unit_ratio?: string; pricing_mode?: string; wage_rate?: string | null }[];
}) {
  return {
    request_key: newRequestKey(),
    quantity: input.quantity.trim(),
    requires_fg_inspection: input.requires_fg_inspection,
    require_cost: input.require_cost,
    ...(input.warehouse_id ? { warehouse_id: input.warehouse_id } : {}),
    ...(input.sales_line_id ? { sales_line_id: input.sales_line_id } : {}),
    ...(input.contract_line_id ? { contract_line_id: input.contract_line_id } : {}),
    ...(input.product_id ? { product_id: input.product_id } : {}),
    ...(input.route_version_id ? { route_version_id: input.route_version_id } : {}),
    ...(input.bom_version_id ? { bom_version_id: input.bom_version_id } : {}),
    ...(input.code !== undefined ? { code: input.code.trim() } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.due_date ? { due_date: input.due_date } : {}),
    ...(input.planned_start ? { planned_start: input.planned_start } : {}),
    ...(input.planned_end ? { planned_end: input.planned_end } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    ...(input.production_plan_line_id ? { production_plan_line_id: input.production_plan_line_id } : {}),
    ...(input.unit_ratios ? { unit_ratios: input.unit_ratios } : {}),
    ...(input.tasks ? { tasks: input.tasks } : {}),
  };
}

export function taskBatchPayload(action: 'start' | 'pause' | 'complete', taskIds: string[]) {
  return { request_key: newRequestKey(), action, task_ids: taskIds };
}

export function reportCreatePayload(input: {
  task_id: string;
  good_qty: string;
  defect_qty: string;
  effective_seconds: number;
  operator_id?: string;
  include_operator: boolean;
  defect_note?: string;
  note?: string;
  started_at?: string;
  ended_at?: string;
  complete_task?: boolean;
}) {
  return {
    request_key: newRequestKey(),
    task_id: input.task_id,
    good_qty: input.good_qty.trim() || '0',
    defect_qty: input.defect_qty.trim() || '0',
    rework_qty: '0',
    scrap_qty: '0',
    effective_seconds: input.effective_seconds,
    ...(input.include_operator && input.operator_id ? { operator_id: input.operator_id } : {}),
    ...(input.defect_note?.trim() ? { defect_note: input.defect_note.trim() } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    ...(input.started_at ? { started_at: input.started_at } : {}),
    ...(input.ended_at ? { ended_at: input.ended_at } : {}),
    ...(input.complete_task ? { complete_task: true } : {}),
  };
}

export function reportUpdatePayload(input: {
  version: number;
  good_qty: string;
  defect_qty: string;
  effective_seconds: number;
  operator_id?: string;
  defect_note?: string;
  note?: string;
  started_at?: string | null;
  ended_at?: string | null;
}) {
  return {
    version: input.version,
    good_qty: input.good_qty.trim() || '0',
    defect_qty: input.defect_qty.trim() || '0',
    effective_seconds: input.effective_seconds,
    defect_note: input.defect_note?.trim() ?? '',
    note: input.note?.trim() ?? '',
    ...(input.operator_id ? { operator_id: input.operator_id } : {}),
    ...(input.started_at !== undefined ? { started_at: input.started_at } : {}),
    ...(input.ended_at !== undefined ? { ended_at: input.ended_at } : {}),
  };
}

export function reportSettlementPayload(version: number, settled: boolean, note: string) {
  return { request_key: newRequestKey(), version, settled, note };
}

export function reportBatchSettlementPayload(reportIds: string[]) {
  return { request_key: newRequestKey(), report_ids: reportIds };
}

export function taskPricePayload(version: number, pricingMode: string, wageRate: string) {
  return { version, pricing_mode: pricingMode, wage_rate: wageRate.trim() ? wageRate.trim() : null };
}

export function deskReportPayload(input: {
  task_id: string;
  effective_seconds: number;
  good_qty: string;
  defect_qty: string;
  rework_qty: string;
  scrap_qty: string;
  defect_note?: string;
}) {
  return {
    request_key: newRequestKey(),
    task_id: input.task_id,
    effective_seconds: input.effective_seconds,
    good_qty: input.good_qty.trim(),
    defect_qty: input.defect_qty.trim(),
    rework_qty: input.rework_qty.trim(),
    scrap_qty: input.scrap_qty.trim(),
    ...(input.defect_note?.trim() ? { defect_note: input.defect_note.trim() } : {}),
  };
}

export function mobileReportPayload(input: {
  task_id: string;
  good_qty: string;
  defect_qty: string;
  rework_qty: string;
  scrap_qty: string;
  effective_seconds: number;
  defect_note?: string;
  supplement_id?: string;
  operator_id?: string;
  include_operator: boolean;
}) {
  return {
    request_key: newRequestKey(),
    task_id: input.task_id,
    good_qty: input.good_qty.trim(),
    defect_qty: input.defect_qty.trim(),
    rework_qty: input.rework_qty.trim(),
    scrap_qty: input.scrap_qty.trim(),
    effective_seconds: input.effective_seconds,
    ...(input.supplement_id ? { supplement_id: input.supplement_id } : {}),
    ...(input.defect_note?.trim() ? { defect_note: input.defect_note.trim() } : {}),
    ...(input.include_operator ? { operator_id: input.operator_id ?? '' } : {}),
  };
}

export function reportResubmitPayload(input: {
  version: number;
  good_qty: string;
  defect_qty: string;
  rework_qty: string;
  scrap_qty: string;
  reason: string;
  effective_seconds?: number;
  defect_note?: string;
}) {
  return {
    request_key: newRequestKey(),
    version: input.version,
    good_qty: input.good_qty.trim(),
    defect_qty: input.defect_qty.trim(),
    rework_qty: input.rework_qty.trim(),
    scrap_qty: input.scrap_qty.trim(),
    reason: input.reason.trim(),
    ...(input.effective_seconds !== undefined ? { effective_seconds: input.effective_seconds } : {}),
    ...(input.defect_note?.trim() ? { defect_note: input.defect_note.trim() } : {}),
  };
}

export function materialIssuePayload(workOrderId: string, warehouseId: string, lines: { material_id: string; quantity: string }[]) {
  return { request_key: newRequestKey(), work_order_id: workOrderId, warehouse_id: warehouseId, lines };
}

export function fgReceiptPayload(workOrderId: string, quantity: string) {
  return { request_key: newRequestKey(), work_order_id: workOrderId, quantity: quantity.trim() };
}

export function inspectionCreatePayload(workOrderId: string, inspectedQty: string, goodQty: string, defectQty: string) {
  return { request_key: newRequestKey(), work_order_id: workOrderId, inspected_qty: inspectedQty, good_qty: goodQty.trim(), defect_qty: defectQty.trim() };
}

export function inspectionCompletePayload(version: number, conclusion: 'pass' | 'fail') {
  return { action: 'complete', version, conclusion, request_key: newRequestKey() };
}

export function stockAdjustmentPayload(input: { warehouse_id: string; product_id: string; direction: 'in' | 'out'; quantity: string; reason: string }) {
  return { request_key: newRequestKey(), warehouse_id: input.warehouse_id, product_id: input.product_id, direction: input.direction, quantity: input.quantity.trim(), reason: input.reason.trim() };
}

export function shipmentPayload(salesOrderId: string, warehouseId: string, lines: { sales_line_id: string; quantity: string }[]) {
  return { request_key: newRequestKey(), sales_order_id: salesOrderId, warehouse_id: warehouseId, lines };
}

/** 与加工台原 addQty 相同，供检验送检数量拼接。 */
export function legacyAddQty(good: string, defect: string) {
  const [gw, gf = ''] = good.trim().split('.');
  const [dw, df = ''] = defect.trim().split('.');
  const scale = 1_000_000;
  const g = Number(gw) * scale + Number(gf.padEnd(6, '0').slice(0, 6) || '0');
  const d = Number(dw) * scale + Number(df.padEnd(6, '0').slice(0, 6) || '0');
  const total = g + d;
  return `${Math.floor(total / scale)}.${String(total % scale).padStart(6, '0')}`;
}

export function legacyRemaining(total: string, used: string) {
  const parse = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')); };
  const value = parse(total) - parse(used);
  return value <= 0n ? '0.000000' : `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
}

export function productSavePayload(input: {
  existing: boolean;
  code?: string;
  name: string;
  specification: string;
  unit_id: string | number;
  attribute: string;
  active?: boolean;
  version?: number;
  extension?: { schema_version_id: string; values: Record<string, unknown> } | null;
  department_id?: string | null;
  include_department: boolean;
}) {
  const body = input.existing
    ? { version: input.version, name: input.name.trim(), specification: input.specification.trim(), unit_id: input.unit_id, attribute: input.attribute, active: input.active }
    : { code: (input.code ?? '').trim(), name: input.name.trim(), specification: input.specification.trim(), unit_id: input.unit_id, attribute: input.attribute };
  return { ...body, ...(input.extension ? { extension: input.extension } : {}), ...(input.include_department ? { department_id: input.department_id || null } : {}) };
}

export function processFields(name: string, description: string, standardMinutes: string, reporterIds: string[], extra?: { pricing_mode?: string; wage_rate?: string | null; inspection_scheme?: string }) {
  return {
    name: name.trim(),
    description: description.trim(),
    standard_minutes: standardMinutes,
    reporter_ids: reporterIds,
    ...(extra?.pricing_mode ? { pricing_mode: extra.pricing_mode } : {}),
    ...(extra && 'wage_rate' in extra ? { wage_rate: extra.wage_rate ?? null } : {}),
    ...(extra?.inspection_scheme ? { inspection_scheme: extra.inspection_scheme } : {}),
  };
}

export function routeStepsPayload(steps: { process_id: string; auto_inbound: boolean }[]) {
  return steps.map(({ process_id, auto_inbound }) => ({ process_id, auto_inbound }));
}

export function routeSavePayload(input: { existing: boolean; code?: string; name: string; description: string; steps: { process_id: string; auto_inbound: boolean }[]; expected_version?: number }) {
  const fields = { name: input.name.trim(), description: input.description.trim(), steps: routeStepsPayload(input.steps) };
  return input.existing ? { ...fields, expected_version: input.expected_version } : { ...fields, code: (input.code ?? '').trim() };
}

export type BomLineDraft = { component_product_id: string; quantity: string; loss_rate: string; feeding_process_id: string; inbound_process_id?: string; cost_price?: string; auto_issue: boolean; child_mode: 'auto' | 'leaf' | 'version'; child_version_id: string };

export function bomSavePayload(input: { existing: boolean; parent?: string; name?: string; description: string; routeVersionId: string; lines: BomLineDraft[]; expected_version?: number }) {
  const items = input.lines.map((line) => ({
    component_product_id: line.component_product_id,
    quantity: line.quantity,
    loss_rate: line.loss_rate,
    feeding_process_id: line.feeding_process_id || null,
    inbound_process_id: line.inbound_process_id || null,
    cost_price: line.cost_price?.trim() ? line.cost_price.trim() : null,
    auto_issue: line.auto_issue,
    ...(line.child_mode === 'leaf' ? { component_bom_version_id: null } : line.child_mode === 'version' ? { component_bom_version_id: line.child_version_id } : {}),
  }));
  const fields = { name: (input.name ?? '').trim() || undefined, description: input.description.trim(), route_version_id: input.routeVersionId || null, items };
  return input.existing ? { ...fields, expected_version: input.expected_version } : { ...fields, ...(input.parent ? { parent_product_id: input.parent } : {}) };
}

export function validateBomDraft(input: { parent: string; name?: string; lines: BomLineDraft[]; routeVersionId: string; steps: { process_id: string }[] }) {
  if (input.name !== undefined && !input.name.trim()) return '请填写BOM名称';
  if (!input.lines.length) return '';
  const missing = input.lines.findIndex((line) => !line.component_product_id);
  if (missing >= 0) return `请选择第${missing + 1}行的组件`;
  if (input.parent && input.lines.some((line) => line.component_product_id === input.parent)) return '组件不能是商品本身';
  const decimalPattern = /^\d+(?:\.\d{1,6})?$/;
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index]!;
    if (!decimalPattern.test(line.quantity) || Number(line.quantity) <= 0) return `第${index + 1}行用量需大于0`;
    if (!/^\d+(?:\.\d{1,6})?$/.test(line.loss_rate)) return `第${index + 1}行损耗率最多6位小数`;
    if (Number(line.loss_rate) < 0 || Number(line.loss_rate) > 1) return `第${index + 1}行损耗率需在0到1之间`;
    if (line.quantity.includes('.') && line.quantity.split('.')[1]!.length > 6) return `第${index + 1}行用量最多6位小数`;
  }
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index]!;
    if (!line.auto_issue) continue;
    if (!input.routeVersionId) return '请选择绑定路线';
    if (!line.feeding_process_id) return `请选择第${index + 1}行的投料工序`;
    if (!input.steps.some((step) => step.process_id === line.feeding_process_id)) return `第${index + 1}行的投料工序不在绑定路线中`;
  }
  if (input.lines.some((line) => line.child_mode === 'version' && !line.child_version_id)) return '固定子BOM版本时必须选择具体版本；也可改为自动冻结或叶子不展开。';
  return '';
}

export function purchaseOrderFields(input: { supplier_id: string; order_date: string; due_date: string; note?: string; zero_price_reason?: string; lines: Record<string, unknown>[] }) {
  return {
    supplier_id: input.supplier_id,
    order_date: input.order_date,
    due_date: input.due_date,
    ...(input.note ? { note: input.note } : {}),
    ...(input.zero_price_reason ? { zero_price_reason: input.zero_price_reason } : {}),
    lines: input.lines,
  };
}

export function purchaseReceiptFields(orderId: string, warehouseId: string, lines: { purchase_line_id: string; quantity: string }[]) {
  return { order_id: orderId, warehouse_id: warehouseId, lines };
}

export function wageSettlementFields(eventIds: string[], reason: string) {
  return { event_ids: eventIds, reason };
}

export function attachmentUploadPayload(input: { resource_type: 'product' | 'process' | 'production_report'; resource_id: string; filename: string; mime: string; content_base64: string; request_key: string }) {
  return input;
}

export function attachmentMime(file: { type: string; name: string }) {
  const types: Record<string, string> = { 'application/pdf': 'application/pdf', 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'text/plain': 'text/plain' };
  return types[file.type] ?? (file.name.toLowerCase().endsWith('.txt') ? 'text/plain' : '');
}

export function attachmentSizeMessage(size: number) {
  if (size > 2 * 1048576 || size === 0) return '本轮附件需为非空文件，最大2 MiB。';
  return '';
}
