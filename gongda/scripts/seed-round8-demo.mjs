/**
 * 第八轮验收数据（幂等）。前置：npm run dev:setup && npm run dev
 * 账号写入 .local/round8-credentials.txt
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
if (!pass) throw new Error('缺少 .local/dev-credentials.txt');

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant_slug: 'demo-a', username, password }) });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!json.csrf_token) throw new Error(`登录失败 ${JSON.stringify(json).slice(0, 240)}`);
  return { csrf: json.csrf_token, cookie, userId: json.user?.id };
}
async function api(session, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: session.cookie, ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}
const key = () => crypto.randomUUID();
const admin = await login('admin.local', pass);

const defectNames = ['松动', '异响', '划伤', '尺寸超差', '毛刺', '裂纹', '色差', '缺件'];
const defects = await api(admin, 'GET', '/api/quality/defects');
for (const name of defectNames) {
  if (!defects.items.some((item) => item.name === name)) defects.items.push((await api(admin, 'POST', '/api/quality/defects', { name })).item);
}

let categories = await api(admin, 'GET', '/api/machines/categories');
if (!categories.items.some((item) => item.name === '数控车床')) {
  const created = await api(admin, 'POST', '/api/machines/categories', { name: '数控车床' });
  categories.items.push({ id: created.id, name: '数控车床' });
}
let shops = await api(admin, 'GET', '/api/machines/shops');
if (!shops.items.some((item) => item.name === '精工车间')) shops.items.push(await api(admin, 'POST', '/api/machines/shops', { name: '精工车间' }));
let lines = await api(admin, 'GET', '/api/machines/lines');
if (!lines.items.some((item) => item.name === '车削')) lines.items.push(await api(admin, 'POST', '/api/machines/lines', { name: '车削' }));
const machines = await api(admin, 'GET', '/api/machines');
const statuses = ['正常', '维修中', '运行中', '正常', '运行中'];
for (let i = machines.items.length; i < 5; i += 1) {
  await api(admin, 'POST', '/api/machines', { name: `验收机台${i + 1}`, status: statuses[i], category_id: categories.items[0].id, shop_id: shops.items[0].id, line_id: lines.items[0].id, sync_device: i === 0 ? '是' : '否' });
}

const components = await api(admin, 'GET', '/api/quality/components');
if (!components.items.length) await api(admin, 'POST', '/api/quality/components', { name: '尺寸抽检' });
const specs = await api(admin, 'GET', '/api/quality/specs');
if (!specs.items.length) await api(admin, 'POST', '/api/quality/specs', { name: '来料检验规范', note: '第八轮', items: [{ name: '外观', field_type: '文本', required: true }, { name: '尺寸', field_type: '数字', required: true }] });

const contents = await api(admin, 'GET', '/api/outsource/contents');
for (const title of ['精度验证', '外观与结构检查']) {
  if (!contents.items.some((item) => item.title === title)) await api(admin, 'POST', '/api/outsource/contents', { title, items: [{ name: '检查项一', field_type: '文本', required: true }, { name: '检查项二', field_type: '是否', required: false }] });
}

const products = await api(admin, 'GET', '/api/products');
const product = products.items?.[0];
if (product) {
  const orders = await api(admin, 'GET', '/api/outsource/orders');
  const need = Math.max(0, 3 - orders.items.length);
  for (let i = 0; i < need; i += 1) {
    const created = await api(admin, 'POST', '/api/outsource/orders', { product_id: product.id, plan_qty: String(10 + i), unit_price: '100', priority: '正常' });
    if (i < 2) await api(admin, 'POST', `/api/outsource/orders/${created.order.id}/actions`, { action: '开始' });
  }
  const fresh = await api(admin, 'GET', '/api/outsource/orders');
  const running = fresh.items.find((item) => item.status === '生产中');
  const receipts = await api(admin, 'GET', '/api/outsource/receipts');
  if (running && receipts.items.length < 2) {
    const open = await api(admin, 'POST', '/api/outsource/receipts', { order_id: running.id, pass_qty: '2', fail_qty: '0' });
    await api(admin, 'POST', '/api/outsource/receipts', { order_id: running.id, pass_qty: '1', fail_qty: '0' });
    await api(admin, 'POST', `/api/outsource/receipts/${open.id}/settle`, {});
  }
}

const stations = await api(admin, 'GET', '/api/stations');
if (stations.items.length < 2 && admin.userId) {
  for (let i = stations.items.length; i < 2; i += 1) await api(admin, 'POST', '/api/stations', { name: `工作站${i + 1}`, shop_id: shops.items[0].id, line_id: lines.items[0].id, user_ids: [admin.userId] });
}

const leanSettings = await api(admin, 'GET', '/api/lean/settings');
if (!(leanSettings.departments ?? []).length) await api(admin, 'POST', '/api/system/departments', { name: '生产管理部' });
const patrols = await api(admin, 'GET', '/api/lean/patrols');
if (patrols.items.length < 2) {
  await api(admin, 'POST', '/api/lean/patrols', { department_name: '生产管理部', owner_names: '本地管理员', category: '生产问题', description: '现场油污' });
  await api(admin, 'POST', '/api/lean/patrols', { department_name: '生产管理部', owner_names: '本地管理员', category: '整顿问题', description: '工具未归位' });
}
const meetings = await api(admin, 'GET', '/api/lean/meetings');
if (meetings.items.length < 2) {
  const meeting = await api(admin, 'POST', '/api/lean/meetings', { title: '早会', content: '质量回顾', meet_at: '2026-10-06T09:00', form: '线下会议', member_names: '本地管理员', place: '会议室' });
  await api(admin, 'POST', `/api/lean/meetings/${meeting.id}/agendas`, { description: '整改油污', owner_name: '本地管理员', status: '待落地' });
  await api(admin, 'POST', '/api/lean/meetings', { title: '周会', content: '交付', meet_at: '2026-10-07T09:00', form: '线上会议', member_names: '本地管理员', place: '线上' });
}

const scenes = await api(admin, 'GET', '/api/iot/scenes');
for (const name of ['冲压演示', '焊接演示', '装配演示']) {
  if (!scenes.items.some((item) => item.name === name)) await api(admin, 'POST', '/api/iot/scenes', { name, device_name: name, demo: true });
}
await api(admin, 'POST', '/api/iot/scenes', { ensure_demo: true });

const devices = await api(admin, 'GET', '/api/equip/devices');
if (devices.items.length < 5) {
  let equipCategories = await api(admin, 'GET', '/api/equip/categories');
  if (!equipCategories.items.length) equipCategories = { items: [await api(admin, 'POST', '/api/equip/categories', { name: '机加工设备' })] };
  for (let i = devices.items.length; i < 5; i += 1) await api(admin, 'POST', '/api/equip/devices', { name: `验收设备${i + 1}`, owner_name: '本地管理员', category_id: equipCategories.items[0].id, status: i === 1 ? '维修中' : '正常' });
}
const deviceList = await api(admin, 'GET', '/api/equip/devices');
const repairs = await api(admin, 'GET', '/api/equip/repairs');
if (deviceList.items[0] && repairs.items.length < 2) {
  const created = await api(admin, 'POST', '/api/equip/repairs', { device_id: deviceList.items[0].id, team_name: '默认团队', handler_name: '本地管理员', description: '异响', fault_type: '机械故障' });
  await api(admin, 'POST', `/api/equip/repairs/${created.id}/actions`, { action: '接单' });
  if (deviceList.items[1]) await api(admin, 'POST', '/api/equip/repairs', { device_id: deviceList.items[1].id, team_name: '默认团队', handler_name: '本地管理员', description: '待接单故障', fault_type: '电气故障' });
}
const plans = await api(admin, 'GET', '/api/equip/plans');
if (plans.items.length < 2 && deviceList.items[0]) {
  let maint = await api(admin, 'GET', '/api/equip/contents');
  if (!maint.items.length) await api(admin, 'POST', '/api/equip/contents', { title: '日常保养', items: [{ name: '润滑', field_type: '是否', required: true }] });
  maint = await api(admin, 'GET', '/api/equip/contents');
  for (let i = plans.items.length; i < 2; i += 1) await api(admin, 'POST', '/api/equip/plans', { title: `月度保养${i + 1}`, category: '保养', device_ids: [deviceList.items[0].id], content_ids: [maint.items[0].id], executor_name: '本地管理员', cycle_text: '每月' });
}
const qrs = await api(admin, 'GET', '/api/equip/qrcodes');
if (!qrs.items.length) await api(admin, 'POST', '/api/equip/qrcodes', { count: 2 });

const payroll = await api(admin, 'GET', '/api/payroll-statement');
let wageOk = JSON.stringify(payroll).includes('750');
if (!wageOk && product) {
  const units = await api(admin, 'GET', '/api/units');
  const unitId = units.items?.[0]?.id ?? units[0]?.id;
  const process = await api(admin, 'POST', '/api/processes', { code: 'R8-WAGE', name: '第八轮计件', standard_minutes: '1', reporter_ids: [admin.userId], pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none' });
  const warehouses = await api(admin, 'GET', '/api/warehouses');
  const warehouse = warehouses.items?.[0] ?? warehouses.warehouses?.[0] ?? (await api(admin, 'POST', '/api/warehouses', { request_key: key(), code: 'R8-WH', name: '第八轮仓' })).warehouse;
  const order = await api(admin, 'POST', '/api/work-orders', { request_key: key(), code: '', product_id: product.id, quantity: '80', warehouse_id: warehouse.id, priority: 'normal', tasks: [{ process_id: process.process.id, pricing_mode: 'piece', wage_rate: '10' }] });
  let wo = order.work_order;
  if (wo.execution === 'not_started') wo = (await api(admin, 'POST', `/api/work-orders/${wo.id}/actions`, { action: 'start', version: wo.version })).work_order;
  const task = wo.tasks[0];
  await api(admin, 'POST', '/api/production-reports', { request_key: key(), task_id: task.id, good_qty: '75', defect_qty: '0', rework_qty: '0', scrap_qty: '0' });
  wageOk = JSON.stringify(await api(admin, 'GET', '/api/payroll-statement')).includes('750');
}

const processes = await api(admin, 'GET', '/api/processes');
let qcProcess = (processes.items ?? processes.processes ?? []).find((item) => item.code === 'R8-QC');
if (!qcProcess) {
  qcProcess = (await api(admin, 'POST', '/api/processes', { code: 'R8-QC', name: '第八轮全检', standard_minutes: '1', reporter_ids: [admin.userId], pricing_mode: 'piece', wage_rate: '0', inspection_scheme: 'full' })).process;
}
const inspections = await api(admin, 'GET', '/api/quality/inspections?status=全部&rework=全部');
const hasQcOrder = ((await api(admin, 'GET', '/api/work-orders')).items ?? []).some((item) => item.code === 'R8-QC');
if (!hasQcOrder && ((inspections.counts?.pending ?? 0) < 3 || (inspections.counts?.done ?? 0) < 3)) {
  const warehouses = await api(admin, 'GET', '/api/warehouses');
  const warehouse = warehouses.items?.[0] ?? warehouses.warehouses?.[0] ?? (await api(admin, 'POST', '/api/warehouses', { request_key: key(), code: 'R8-WH', name: '第八轮仓' })).warehouse;
  if (!product) throw new Error('缺少商品，无法造全检报工');
  const order = await api(admin, 'POST', '/api/work-orders', { request_key: key(), code: 'R8-QC', product_id: product.id, quantity: '30', warehouse_id: warehouse.id, priority: 'normal', tasks: [{ process_id: qcProcess.id, pricing_mode: 'piece', wage_rate: '0' }] });
  let wo = order.work_order;
  if (wo.execution === 'not_started') wo = (await api(admin, 'POST', `/api/work-orders/${wo.id}/actions`, { action: 'start', version: wo.version })).work_order;
  const task = wo.tasks[0];
  const defectIds = (await api(admin, 'GET', '/api/quality/defects')).items.slice(0, 2).map((item) => item.id);
  const machineId = (await api(admin, 'GET', '/api/machines?enabled=1')).items?.[0]?.id;
  for (let i = 0; i < 6; i += 1) {
    const report = await api(admin, 'POST', '/api/production-reports', { request_key: key(), task_id: task.id, good_qty: '1', defect_qty: '1', rework_qty: '0', scrap_qty: '0' });
    const reportId = report.report?.id ?? report.id;
    if (reportId) await api(admin, 'POST', '/api/quality/bindings', { report_id: reportId, machine_id: machineId, defect_item_ids: defectIds });
    if (i < 3 && reportId) await api(admin, 'POST', `/api/quality/inspections/${reportId}`, { quality_status: '已质检', quality_note: '尺寸合格', defect_qty: '1', rework_qty: '0', scrap_qty: '0', defect_item_ids: defectIds });
  }
}

const spots = await api(admin, 'GET', '/api/quality/spot-checks');
for (let i = spots.items.length; i < 2; i += 1) await api(admin, 'POST', '/api/quality/spot-checks', { process_id: qcProcess.id, qty: String(5 + i), note: '第八轮抽检' });

const tests = await api(admin, 'GET', '/api/quality/purchase-tests');
// 列表默认每页 30 条且按创建时间倒序；仅首页可见的 18/2 才算有效（旧单在末页不算）
const visiblePassFail = (tests.items ?? []).slice(0, 30).some((item) => String(item.pass_qty) === '18' && String(item.fail_qty) === '2');
if (!visiblePassFail && product) {
  const spec = (await api(admin, 'GET', '/api/quality/specs')).items[0];
  let suppliers = await api(admin, 'GET', '/api/money/suppliers');
  let supplier = (suppliers.items ?? []).find((item) => item.name === '第八轮供应商');
  if (!supplier) supplier = (await api(admin, 'POST', '/api/money/suppliers', { name: '第八轮供应商', contact_name: '采购员', contact_phone: '13800000022' })).supplier;
  const purchase = await api(admin, 'POST', '/api/money/purchase-orders', { supplier_id: supplier.id, buyer_id: admin.userId, note: '第八轮来料', lines: [{ product_id: product.id, quantity: '20', unit_price: '8' }], request_key: key() });
  const created = await api(admin, 'POST', '/api/quality/purchase-tests', { purchase_order_id: purchase.purchase_order.id, spec_id: spec?.id, product_id: product.id, send_qty: '20', inspector_names: '本地管理员' });
  await api(admin, 'PATCH', `/api/quality/purchase-tests/${created.id}`, { pass_qty: '18', fail_qty: '2' });
}

const stock = await api(admin, 'GET', '/api/biz-reports/inventory?period=本年&only_flow=1');
const localProduct = (await api(admin, 'GET', '/api/products?code=LOCAL001&page=1&page_size=20')).items?.find((item) => item.code === 'LOCAL001');
if (!localProduct) throw new Error('缺少商品 LOCAL001，无法造进销存期末');
const localRow = (stock.items ?? []).find((item) => item.code === 'LOCAL001');
if (!localRow || !(Number(localRow.closing) > 0 || Number(localRow.inbound) > 0)) {
  const warehouses = await api(admin, 'GET', '/api/warehouses');
  const warehouse = warehouses.items?.[0] ?? warehouses.warehouses?.[0] ?? (await api(admin, 'POST', '/api/warehouses', { request_key: key(), code: 'R8-WH', name: '第八轮仓' })).warehouse;
  await api(admin, 'POST', '/api/warehouse/misc-bills', { request_key: key(), kind: 'else_in', warehouse_id: warehouse.id, note: '第八轮进销存', lines: [{ product_id: localProduct.id, quantity: '12', unit_price: '5' }] });
}
const stockAfter = await api(admin, 'GET', '/api/biz-reports/inventory?period=本年&only_flow=1');
if (!(stockAfter.items ?? []).some((item) => item.code === 'LOCAL001' && (Number(item.closing) > 0 || Number(item.inbound) > 0))) {
  throw new Error('进销存汇总仍无 LOCAL001 期末/入库');
}

const moneyCustomers = await api(admin, 'GET', '/api/money/customers');
if (!(moneyCustomers.items ?? []).some((item) => item.name === '第八轮欠款客户') && product) {
  const customer = await api(admin, 'POST', '/api/money/customers', { request_key: key(), name: '第八轮欠款客户', contact_name: '联系人', contact_phone: '13800000021' });
  const created = await api(admin, 'POST', '/api/money/contracts', { request_key: key(), customer_id: customer.customer.id, contact_name: '联系人', salesperson_id: admin.userId, prepay: '1000', lines: [{ product_id: product.id, quantity: '100', unit_price: '100', discount: '10' }] });
  if (created.contract.approval === 'pending') await api(admin, 'POST', `/api/money/contracts/${created.contract.id}/actions`, { action: 'approve', version: created.contract.version, opinion: '通过' });
}
mkdirSync('.local', { recursive: true });
writeFileSync('.local/round8-credentials.txt', `企业：demo-a\n账号：admin.local\n密码：${pass}\n工资750已有：${wageOk ? '是' : '否，请沿用第六轮报工'}\n`);
console.log('round8 seed done', { defects: (await api(admin, 'GET', '/api/quality/defects')).items.length, wageOk });
