type ValidationError = { keyword?: string; instancePath?: string; params?: Record<string, unknown> };

const selectFields = new Set([
  'unit_id', 'attribute', 'department_id', 'warehouse_id', 'customer_id', 'product_id', 'supplier_id',
  'sales_line_id', 'route_version_id', 'bom_version_id', 'process_id', 'task_id', 'operator_id',
  'tenant_id', 'party_id', 'order_id', 'reporter_ids', 'action', 'direction', 'entity', 'scope',
  'work_order_id', 'contract_id', 'from_warehouse_id', 'to_warehouse_id', 'parent_product_id',
  'receiver_id', 'taker_id', 'salesperson_id', 'leader_id', 'object_type',
]);

const labels: Record<string, string> = {
  code: '编号', name: '名称', specification: '规格', unit_id: '单位', attribute: '商品来源', department_id: '部门',
  tenant_slug: '企业标识', username: '账号', password: '密码', tenant_id: '企业', version: '版本',
  request_key: '请求标识', quantity: '数量', sales_line_id: '合同商品', route_version_id: '工艺路线',
  bom_version_id: 'BOM', warehouse_id: '仓库', customer_id: '客户', product_id: '商品', supplier_id: '供应商',
  process_id: '工序', task_id: '生产任务', operator_id: '生产人员', action: '操作', reason: '原因', note: '备注',
  description: '说明', standard_minutes: '标准工时', reporter_ids: '生产人员', active: '启用状态', entity: '对象',
  prefix: '前缀', date_pattern: '日期格式', reset_period: '重置周期', padding: '补零位数', start: '起始流水',
  good_qty: '良品数', defect_qty: '不良品数', rework_qty: '返工数', scrap_qty: '报废数', page: '页码',
  page_size: '每页条数', direction: '方向', party_id: '往来单位', order_id: '单据', amount: '金额',
  order_date: '单据日期', due_date: '交货日期', promised_date: '交货日期', payment_date: '收付日期',
  unit_price: '单价', unit_ratio: '单位关系', sequence: '序号', display_name: '姓名', role: '角色',
  expected_version: '版本', scope: '范围',
  work_order_id: '加工单', contract_id: '合同', from_warehouse_id: '发出仓库', to_warehouse_id: '收入仓库',
  parent_product_id: '商品', steps: '工序', items: '组件', lines: '明细', receiver_id: '收货人',
  taker_id: '盘点人', salesperson_id: '业务员', leader_id: '团队主管', object_type: '审核对象',
};

function fieldOf(error: ValidationError) {
  if (error.keyword === 'required' && typeof error.params?.missingProperty === 'string') return error.params.missingProperty;
  const parts = (error.instancePath ?? '').split('/').filter((part) => part && !/^\d+$/.test(part));
  return parts.at(-1) ?? '';
}

function labelsFor(path: string) {
  const copy = { ...labels };
  if (path.startsWith('/api/products')) {
    copy.code = '商品编号';
    copy.name = '商品名';
  }
  if (path.startsWith('/api/work-orders')) {
    copy.code = '加工单号';
    copy.quantity = '计划数';
    copy.warehouse_id = '成品仓库';
  }
  if (path.startsWith('/api/processes')) {
    copy.code = '工序编号';
    copy.name = '工序名';
  }
  if (path.startsWith('/api/units')) {
    copy.code = '单位编号';
    copy.name = '单位';
  }
  return copy;
}

export function validationResult(path: string, validation: unknown): { message: string; field?: string } {
  const errors = Array.isArray(validation) ? validation as ValidationError[] : [];
  const first = errors[0];
  if (!first) return { message: '参数格式不正确，请检查必填项和字段范围' };
  if (first.keyword === 'additionalProperties') return { message: '请求包含不能提交的字段' };
  const field = fieldOf(first);
  const label = labelsFor(path.split('?')[0] ?? '')[field];
  if (!label) return { message: '提交内容有误，请检查后重试', ...(field ? { field } : {}) };
  if (first.keyword === 'minItems') return { message: `请至少添加一条${label}`, field };
  const choose = selectFields.has(field);
  if (first.keyword === 'required' || first.keyword === 'minLength' || (choose && (first.keyword === 'format' || first.keyword === 'type' || first.keyword === 'enum'))) {
    return { message: choose ? `请选择${label}` : `请填写${label}`, field };
  }
  if (first.keyword === 'enum') return { message: `请选择${label}`, field };
  if (first.keyword === 'maxLength') return { message: `${label}超出长度限制`, field };
  if (first.keyword === 'minimum' || first.keyword === 'maximum') return { message: `${label}超出允许范围`, field };
  return { message: `${label}格式不正确`, field };
}

export function validationMessage(path: string, validation: unknown) {
  return validationResult(path, validation).message;
}
