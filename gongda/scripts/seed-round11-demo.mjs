/**
 * T33 第十一轮造数：先跑 seed-round10（正式接口），再按 §6 补 R11 体积数据。
 * 幂等：已有则复用；接口失败直接非 0 退出，不 catch 吞错。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loginUser, api as call } from './round11/_lib.mjs';

function must(ok, name, actual) {
  console.log(`${ok ? '通过' : '未通过'}\t${name}\t${actual}`);
  if (!ok) throw new Error(`${name}：${actual}`);
}
const key = () => crypto.randomUUID();

// KEEP_API：验收时 API 已在跑，禁止 seed-round10 withExclusiveDb pkill 打断会话/凭据。
const seedEnv = { ...process.env, ROUND11_KEEP_API: '1' };
const r10 = spawnSync('node', ['scripts/seed-round10-demo.mjs'], { stdio: 'inherit', cwd: process.cwd(), env: seedEnv });
must(r10.status === 0, '第十轮 seed 回归', r10.status ?? 'null');
// round6/7 验收依赖 CSFM-A 与 round7 凭据；seed-round10 链不跑这两步，这里补齐。
const r6 = spawnSync('node', ['scripts/seed-round6-demo-a.mjs'], { stdio: 'inherit', cwd: process.cwd(), env: seedEnv });
must(r6.status === 0, '第六轮 seed 回归', r6.status ?? 'null');
// 理由：r10/r6 连续登录易触发限流，给登录窗口冷却后再跑 r7
spawnSync('sleep', ['8'], { stdio: 'ignore' });
const r7 = spawnSync('node', ['scripts/seed-round7-demo-a.mjs'], { stdio: 'inherit', cwd: process.cwd(), env: seedEnv });
must(r7.status === 0, '第七轮 seed 回归', r7.status ?? 'null');

const admin = await loginUser('admin.local');
const worker = await loginUser('worker.local');
async function api(session, method, pathName, body) {
  return call(session, method, pathName, body);
}

/** T0：建单前把 admin 加进已启用审核流程，合同/出库/收款/其他入库才能由 seed 账号审过。 */
async function ensureAdminApproverOnAll() {
  for (const module of ['stock', 'customer', 'purchase']) {
    const flows = await api(admin, 'GET', `/api/audit/flows?module=${module}`);
    for (const flow of flows.items ?? []) {
      if (!flow?.id || flow.enabled === false) continue;
      const levels = (flow.levels ?? []).map((level) => ({
        sign_mode: level.sign_mode ?? 'or',
        approver_ids: [...new Set([...(level.approver_ids ?? []).map(String), String(admin.userId)])],
      }));
      if (!levels.length) continue;
      if (levels.every((level) => level.approver_ids.includes(String(admin.userId)))) continue;
      await api(admin, 'PATCH', `/api/audit/flows/${flow.id}`, {
        name: flow.name,
        enabled: true,
        allow_withdraw: Boolean(flow.allow_withdraw),
        object_types: flow.object_types ?? (flow.object_type ? [flow.object_type] : []),
        levels,
      });
    }
  }
}
await ensureAdminApproverOnAll();

const units = await api(admin, 'GET', '/api/units');
const unitId = units.items?.[0]?.id;
must(Boolean(unitId), '单位存在', unitId);
const warehouses = await api(admin, 'GET', '/api/warehouses');
const warehouse = warehouses.items?.[0];
must(Boolean(warehouse?.id), '仓库存在', warehouse?.id);

async function findOrCreate(listPath, pred, createPath, body, wrap) {
  const list = await api(admin, 'GET', listPath);
  const items = list.items ?? list.rows ?? [];
  const found = items.find(pred);
  if (found) return found;
  const created = await api(admin, 'POST', createPath, body);
  return wrap ? (created[wrap] ?? created) : (created.product ?? created.process ?? created.customer ?? created.work_order ?? created.id ? created : created);
}

const fg = await findOrCreate('/api/products?page=1&page_size=100', (p) => p.name === 'R11成品' || p.code === 'R11-FG', '/api/products', {
  code: 'R11-FG', name: 'R11成品', unit_id: unitId, attribute: 'manufactured',
}, 'product');
const raw = await findOrCreate('/api/products?page=1&page_size=100', (p) => p.name === 'R11原料' || p.code === 'R11-RM', '/api/products', {
  code: 'R11-RM', name: 'R11原料', unit_id: unitId, attribute: 'purchased',
}, 'product');

const procA = await findOrCreate('/api/processes', (p) => p.name === 'R11工序A' || p.code === 'R11-A', '/api/processes', {
  code: 'R11-A', name: 'R11工序A', standard_minutes: '1', reporter_ids: [worker.userId, admin.userId], pricing_mode: 'piece', wage_rate: '0.5', inspection_scheme: 'none',
}, 'process');
const procB = await findOrCreate('/api/processes', (p) => p.name === 'R11工序B' || p.code === 'R11-B', '/api/processes', {
  code: 'R11-B', name: 'R11工序B', standard_minutes: '1', reporter_ids: [worker.userId, admin.userId], pricing_mode: 'piece', wage_rate: '0.3', inspection_scheme: 'none',
}, 'process');

const routes = await api(admin, 'GET', '/api/routes');
let route = (routes.items ?? []).find((r) => r.code === 'R11-RT' || r.name === 'R11成品路线');
if (!route) {
  route = (await api(admin, 'POST', '/api/routes', {
    code: 'R11-RT', name: 'R11成品路线', request_key: key(),
    steps: [
      { process_id: procA.id, auto_inbound: false },
      { process_id: procB.id, auto_inbound: true },
    ],
  })).route;
}
must(Boolean(route?.current_version_id), 'R11路线版本', route?.current_version_id);

const perfRules = await api(admin, 'GET', '/api/performance-pay/match-rules');
if (!(perfRules.active ?? []).length) {
  await api(admin, 'PUT', '/api/performance-pay/match-rules', {
    status: 'draft', apply: true,
    rules: [
      { fields: ['工序.工序名', '商品.商品名称', '用户.姓名'] },
      { fields: ['工序.工序名', '工序.计价方式'] },
    ],
  });
}

const boms = await api(admin, 'GET', '/api/boms');
let bom = (boms.items ?? []).find((b) => b.parent_product_id === fg.id || b.name === 'R11成品BOM');
if (!bom) {
  bom = (await api(admin, 'POST', '/api/boms', {
    name: 'R11成品BOM', parent_product_id: fg.id, route_version_id: route.current_version_id,
    items: [{ component_product_id: raw.id, quantity: '2', loss_rate: '0', auto_issue: true, feeding_process_id: procA.id }],
  })).bom;
}
const bom2 = (boms.items ?? []).find((b) => b.name === 'R11成品BOM2');
if (!bom2) {
  await api(admin, 'POST', '/api/boms', {
    name: 'R11成品BOM2', parent_product_id: fg.id,
    items: [{ component_product_id: raw.id, quantity: '2', loss_rate: '0', auto_issue: false }],
  });
}
const nameless = (boms.items ?? []).find((b) => b.name === 'R11无商品BOM');
if (!nameless) {
  await api(admin, 'POST', '/api/boms', {
    name: 'R11无商品BOM',
    items: [{ component_product_id: raw.id, quantity: '1', loss_rate: '0', auto_issue: false }],
  });
}

const bal = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((row) => row.product_id === raw.id);
const onHand = Number(bal?.on_hand ?? 0);
if (onHand < 500) {
  const adj = await api(admin, 'POST', '/api/stock-adjustments', {
    request_key: key(), warehouse_id: warehouse.id, product_id: raw.id, direction: 'in', quantity: String(500 - onHand), reason: 'R11原料期初',
  });
  const doc = adj.stock_adjustment ?? adj;
  if (doc.approval === 'pending') await api(admin, 'POST', `/api/stock-adjustments/${doc.id}/actions`, { action: 'approve', version: doc.version, request_key: key() });
}

const cust = await findOrCreate('/api/money/customers?page=1&page_size=200', (c) => c.name === 'R11主流程客户', '/api/money/customers', {
  name: 'R11主流程客户', contact_name: '主流程联系人', contact_phone: '13800001100',
}, 'customer');

for (let i = 1; i <= 3; i += 1) {
  const name = `R11客户${i}`;
  const c = await findOrCreate('/api/money/customers?page=1&page_size=200', (row) => row.name === name, '/api/money/customers', {
    name, contact_name: `${name}联系人`, contact_phone: `1380000110${i}`,
  }, 'customer');
  const contacts = (await api(admin, 'GET', `/api/crm/contacts?customer=${encodeURIComponent(name)}`)).items ?? [];
  for (let n = contacts.filter((x) => x.customer_id === c.id).length; n < 2; n += 1) {
    await api(admin, 'POST', '/api/crm/contacts', { customer_id: c.id, name: `${name}联系人${n + 2}`, phone: `139000011${i}${n}` });
  }
}
for (let i = 1; i <= 3; i += 1) {
  const name = `R11公海客户${i}`;
  const c = await findOrCreate('/api/money/customers?sea=1', (row) => row.name === name, '/api/money/customers', {
    name, contact_name: `${name}联系人`, contact_phone: `1370000110${i}`,
  }, 'customer');
  if (!c.in_sea) await api(admin, 'POST', `/api/money/customers/${c.id}/sea`, {});
}

const rules = (await api(admin, 'GET', '/api/crm/price-rules')).items ?? [];
if (rules.length < 3) {
  for (let i = rules.length; i < 3; i += 1) {
    const customers = (await api(admin, 'GET', '/api/money/customers?page=1&page_size=50')).items ?? [];
    const c = customers.filter((row) => !row.in_sea)[i] ?? cust;
    try {
      await api(admin, 'POST', '/api/crm/price-rules', { customer_id: c.id, product_id: fg.id, unit_price: String(50 + i) });
    } catch (error) {
      if (!/已存在|DUP/.test(String(error))) throw error;
    }
  }
}

const perfs = (await api(admin, 'GET', '/api/performance-pay')).items ?? [];
if (!perfs.some((row) => row.process_name === 'R11工序A' && row.product_name === 'R11成品')) {
  await api(admin, 'POST', '/api/performance-pay', {
    process_name: 'R11工序A', pricing_mode: '计件', product_id: fg.id, product_name: 'R11成品', product_code: fg.code,
    product_spec: fg.specification || '', user_name: worker.name || '本地工人', wage_rate: '0.6', param1: '0',
  });
}
for (let i = perfs.length; i < 4; i += 1) {
  await api(admin, 'POST', '/api/performance-pay', {
    process_name: procA.name, pricing_mode: '计件', product_name: `R11绩效商品${i}`, wage_rate: (0.4 + i / 10).toFixed(1), param1: String(i),
  });
}

const events = (await api(admin, 'GET', '/api/auto-stock/events')).items ?? [];
if (!events.some((e) => e.action_kind === 'issue_bom')) {
  await api(admin, 'POST', '/api/auto-stock/events', { action_kind: 'issue_bom', name: '按用料清单出库', content_text: '根据用料清单的投料工序，自动出料', warehouse_id: warehouse.id, enabled: true });
}
if (!events.some((e) => e.action_kind === 'receipt_fg')) {
  await api(admin, 'POST', '/api/auto-stock/events', { action_kind: 'receipt_fg', name: '报工后自动入库', content_text: '末道工序报工时，成品自动入库', warehouse_id: warehouse.id, enabled: true });
}

let flowContract = ((await api(admin, 'GET', '/api/money/contracts?page=1&page_size=200')).items ?? [])
  .find((c) => c.note === 'R11主流程' || c.customer_name === 'R11主流程客户');
if (!flowContract) {
  flowContract = (await api(admin, 'POST', '/api/money/contracts', {
    request_key: key(), customer_id: cust.id, contact_name: '主流程联系人', salesperson_id: admin.userId,
    prepay: '0', submit: true, note: 'R11主流程',
    lines: [{ product_id: fg.id, quantity: '100', unit_price: '50', discount: '0' }],
  })).contract;
}
if (flowContract.approval === 'pending') {
  await api(admin, 'POST', `/api/money/contracts/${flowContract.id}/actions`, { action: 'approve', version: flowContract.version });
  flowContract = (await api(admin, 'GET', `/api/money/contracts/${flowContract.id}`)).contract ?? flowContract;
}

let flowWo = ((await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=200')).items ?? [])
  .find((w) => w.code === 'R11-FLOW' || (w.product_snapshot?.name === 'R11成品' && String(w.plan_qty) === '100'));
if (!flowWo) {
  const contractDetail = (await api(admin, 'GET', `/api/money/contracts/${flowContract.id}`)).contract ?? flowContract;
  const lineId = contractDetail.lines?.[0]?.id;
  flowWo = (await api(admin, 'POST', '/api/work-orders', {
    request_key: key(), code: 'R11-FLOW', product_id: fg.id, quantity: '100', warehouse_id: warehouse.id,
    ...(lineId ? { contract_line_id: lineId } : {}),
    route_version_id: route.current_version_id,
    bom_version_id: bom.current_version_id,
    tasks: [
      { process_id: procA.id, pricing_mode: 'piece', wage_rate: '0.5' },
      { process_id: procB.id, pricing_mode: 'piece', wage_rate: '0.3' },
    ],
  })).work_order;
}
const woDetail = await api(admin, 'GET', `/api/work-orders/${flowWo.id}`);
let wo = woDetail.work_order ?? woDetail;
if (wo.execution === 'not_started') {
  wo = (await api(admin, 'POST', `/api/work-orders/${wo.id}/actions`, { action: 'start', version: wo.version, request_key: key() })).work_order ?? wo;
}
const tasks = (wo.tasks ?? (await api(admin, 'GET', `/api/work-orders/${wo.id}`)).work_order.tasks) ?? [];
for (const task of tasks) {
  if (task.execution === 'not_started') {
    await api(admin, 'POST', `/api/work-orders/${wo.id}/tasks/${task.id}/actions`, { action: 'start', version: task.version });
  }
}
const fresh = (await api(admin, 'GET', `/api/work-orders/${wo.id}`)).work_order;
const reports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${wo.id}`)).items ?? [];
for (const task of fresh.tasks ?? []) {
  if (reports.some((r) => r.task_id === task.id && r.approval !== 'reversed')) continue;
  const created = await api(worker, 'POST', '/api/production-reports', {
    request_key: key(), task_id: task.id, good_qty: '100', defect_qty: '0', rework_qty: '0', scrap_qty: '0', operator_id: worker.userId,
  });
  const report = created.report ?? created;
  if (report.approval === 'pending') {
    await api(admin, 'POST', `/api/production-reports/${report.id}/actions`, { action: 'approve', version: report.version ?? 1, request_key: key() });
  }
}
if (fresh.execution === 'running') {
  try {
    await api(admin, 'POST', `/api/work-orders/${wo.id}/actions`, { action: 'complete', version: (await api(admin, 'GET', `/api/work-orders/${wo.id}`)).work_order.version, request_key: key() });
  } catch (error) {
    const now = (await api(admin, 'GET', `/api/work-orders/${wo.id}`)).work_order;
    if (now.execution !== 'completed') throw error;
  }
}

const detail = await api(admin, 'GET', `/api/money/contracts/${flowContract.id}`);
const contract = detail.contract ?? flowContract;
const outbound = await api(admin, 'GET', `/api/warehouse/contracts/${contract.id}/outbound-summary`);
const shipped = Number(outbound.lines?.[0]?.shipped_qty ?? 0);
if (shipped < 60) {
  const fgBal = ((await api(admin, 'GET', '/api/stock/balances')).items ?? []).find((row) => row.product_id === fg.id);
  const fgOnHand = Number(fgBal?.on_hand ?? fgBal?.available_qty ?? 0);
  if (fgOnHand < 60) {
    const misc = await api(admin, 'POST', '/api/warehouse/misc-bills', {
      request_key: key(), kind: 'else_in', warehouse_id: warehouse.id, note: 'R11成品补库存',
      lines: [{ product_id: fg.id, quantity: String(100 - fgOnHand), unit_price: '50' }],
    });
    const miscBill = misc.bill ?? misc;
    if (miscBill?.approval === 'pending' && miscBill.id) {
      await api(admin, 'POST', '/api/audit/batch', { object_type: 'else_in', ids: [miscBill.id], action: '通过', remark: 'R11成品入库' });
    }
  }
  const line = (detail.lines ?? contract.lines ?? [])[0];
  if (line) {
    const ship = (await api(admin, 'POST', '/api/warehouse/shipments', {
      request_key: key(), contract_id: contract.id, warehouse_id: warehouse.id,
      lines: [{ contract_line_id: line.id, quantity: '60' }],
    })).shipment;
    if (ship?.approval === 'pending' || ship?.audit_status === 'pending') {
      await api(admin, 'POST', `/api/warehouse/shipments/${ship.id}/actions`, { action: 'approve', version: ship.version, request_key: key() });
    }
  }
}

const cashList = await api(admin, 'GET', '/api/money/cash');
if (!(cashList.items ?? []).some((row) => Number(row.amount) === 3000 && (row.customer_id === cust.id || row.customer_name === 'R11主流程客户' || row.contract_id === contract.id))) {
  const createdCash = await api(admin, 'POST', `/api/money/contracts/${contract.id}/cash`, { direction: 'in', amount: '3000' });
  const cash = createdCash.cash ?? createdCash;
  if (cash?.approval === 'pending') {
    await api(admin, 'POST', `/api/money/cash/${cash.id}/actions`, { action: 'approve', version: cash.version, opinion: '通过' });
  }
}

for (let i = 1; i <= 4; i += 1) {
  const statuses = ['not_started', 'running', 'completed', 'paused'];
  const code = `R11-ST-${statuses[i - 1]}`;
  let row = ((await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=200')).items ?? []).find((w) => w.code === code);
  if (!row) {
    row = (await api(admin, 'POST', '/api/work-orders', {
      request_key: key(), code, product_id: fg.id, quantity: '10', warehouse_id: warehouse.id,
      planned_start: new Date().toISOString().slice(0, 10), planned_end: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10),
      tasks: [{ process_id: procA.id }, { process_id: procB.id }],
    })).work_order;
  }
  const d = (await api(admin, 'GET', `/api/work-orders/${row.id}`)).work_order;
  if (statuses[i - 1] !== 'not_started' && d.execution === 'not_started') {
    await api(admin, 'POST', `/api/work-orders/${d.id}/actions`, { action: 'start', version: d.version, request_key: key() });
  }
  const d2 = (await api(admin, 'GET', `/api/work-orders/${row.id}`)).work_order;
  if (statuses[i - 1] === 'paused' && d2.execution === 'running') {
    await api(admin, 'POST', `/api/work-orders/${d2.id}/actions`, { action: 'pause', version: d2.version, reason: 'R11暂停', request_key: key() });
  }
  if (statuses[i - 1] === 'completed' && d2.execution === 'running') {
    for (const task of d2.tasks ?? []) {
      if (task.execution === 'not_started') await api(admin, 'POST', `/api/work-orders/${d2.id}/tasks/${task.id}/actions`, { action: 'start', version: task.version });
      const t2 = (await api(admin, 'GET', `/api/work-orders/${d2.id}`)).work_order.tasks.find((t) => t.id === task.id);
      if (t2?.execution === 'running') await api(admin, 'POST', `/api/work-orders/${d2.id}/tasks/${t2.id}/actions`, { action: 'complete', version: t2.version });
    }
    const d3 = (await api(admin, 'GET', `/api/work-orders/${row.id}`)).work_order;
    if (d3.execution === 'running') await api(admin, 'POST', `/api/work-orders/${d3.id}/actions`, { action: 'complete', version: d3.version, request_key: key() });
  }
}

const parent = ((await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=200')).items ?? []).find((w) => w.code === 'R11-PARENT')
  ?? (await api(admin, 'POST', '/api/work-orders', { request_key: key(), code: 'R11-PARENT', product_id: fg.id, quantity: '20', warehouse_id: warehouse.id, tasks: [{ process_id: procA.id }] })).work_order;
for (const code of ['R11-CHILD-1', 'R11-CHILD-2']) {
  let child = ((await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=200')).items ?? []).find((w) => w.code === code);
  if (!child) child = (await api(admin, 'POST', '/api/work-orders', { request_key: key(), code, product_id: fg.id, quantity: '5', warehouse_id: warehouse.id, tasks: [{ process_id: procA.id }] })).work_order;
  await api(admin, 'PUT', `/api/work-order-links/${child.id}`, { parent_id: parent.id });
}

const split = ((await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=200')).items ?? []).find((w) => w.code === 'R11-SPLIT')
  ?? (await api(admin, 'POST', '/api/work-orders', { request_key: key(), code: 'R11-SPLIT', product_id: fg.id, quantity: '100', warehouse_id: warehouse.id, tasks: [{ process_id: procA.id }] })).work_order;
void split;

const cats = (await api(admin, 'GET', '/api/equip/categories')).items ?? [];
while (cats.length < 3) {
  cats.push(await api(admin, 'POST', '/api/equip/categories', { name: `R11设备类别${cats.length + 1}` }));
}
const devices = (await api(admin, 'GET', '/api/equip/devices')).items ?? [];
const statuses = ['正常', '维修中', '运行中'];
for (let i = devices.length; i < 10; i += 1) {
  await api(admin, 'POST', '/api/equip/devices', {
    name: `R11设备${i + 1}`, spec: '规格A', status: statuses[i % 3], category_id: (cats[i % cats.length]?.id), team_name: '默认团队', owner_name: admin.name || '本地管理员',
    sync_machine: i === 0 ? '是' : '否',
    materials: i < 2 ? [{ name: 'R11原料', code: 'R11-RM', spec: '', qty: '1', unit: '个' }] : [],
  });
}
const contents = (await api(admin, 'GET', '/api/equip/contents')).items ?? [];
for (let i = contents.length; i < 3; i += 1) {
  await api(admin, 'POST', '/api/equip/contents', {
    title: `R11维保内容${i + 1}`, remark: 'seed',
    items: [{ name: '检查项1' }, { name: '检查项2' }, { name: '检查项3' }],
  });
}
const contentId = ((await api(admin, 'GET', '/api/equip/contents')).items ?? [])[0]?.id;
const deviceIds = ((await api(admin, 'GET', '/api/equip/devices')).items ?? []).slice(0, 3).map((d) => d.id);
const plans = (await api(admin, 'GET', '/api/equip/plans')).items ?? [];
if (plans.length < 4 && contentId && deviceIds.length) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const end = new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10);
  for (let i = plans.length; i < 4; i += 1) {
    await api(admin, 'POST', '/api/equip/plans', {
      title: `R11维保计划${i + 1}`, category: '车床维保', device_ids: i === 0 ? deviceIds : [deviceIds[0]], content_ids: [contentId],
      executor_name: admin.name || '本地管理员', team_name: '默认团队', cycle_text: '每1天',
      period_start: today, period_end: end, cycle_rule: '每几天执行', cycle_days: 1,
      exec_mode: '当天执行', remind_mode: '当天提醒', remind_people: ['执行人/执行团队'],
    });
  }
}
const planId = ((await api(admin, 'GET', '/api/equip/plans')).items ?? [])[0]?.id;
const tasksEq = (await api(admin, 'GET', '/api/equip/tasks')).items ?? [];
if (tasksEq[0] && contentId) {
  const recs = (await api(admin, 'GET', '/api/equip/records')).items ?? [];
  for (let i = recs.length; i < 10; i += 1) {
    await api(admin, 'POST', '/api/equip/records', {
      task_id: tasksEq[i % tasksEq.length].id, device_id: deviceIds[i % deviceIds.length], content_id: contentId,
      items: [{ name: '检查项1', value: i % 3 === 0 ? '异常' : '正常', ok: i % 3 !== 0 }],
      result: i % 3 === 0 ? '异常' : '正常', sign_status: ['已签字', '未签字', '无需签字'][i % 3],
    });
  }
}
const pi = (await api(admin, 'GET', '/api/equip/pi-plans')).items ?? [];
if (pi.length < 4 && contentId && deviceIds.length) {
  for (const deviceId of deviceIds.slice(0, 2)) {
    await api(admin, 'POST', '/api/equip/pi-plans', {
      device_id: deviceId, content_id: contentId, executor_name: admin.name || '本地管理员', team_name: '默认团队',
    });
  }
}
const piRec = (await api(admin, 'GET', '/api/equip/pi-records')).items ?? [];
if (piRec.length < 6 && contentId) {
  for (let i = piRec.length; i < 6; i += 1) {
    await api(admin, 'POST', '/api/equip/pi-records', {
      device_id: deviceIds[i % deviceIds.length], content_id: contentId, inspector_name: admin.name || '本地管理员', team_name: '默认团队',
      content_name: 'R11维保内容1', normal_count: i === 0 ? 0 : 3, abnormal_count: i === 0 ? 1 : 0,
    });
  }
}
const repairs = (await api(admin, 'GET', '/api/equip/repairs')).items ?? [];
const repairStates = ['待派单', '待接单', '处理中', '待审核', '审核退回', '已完成', '暂停', '取消'];
async function driveRepair(id, actions) {
  for (const action of actions) {
    await api(admin, 'POST', `/api/equip/repairs/${id}/actions`, { action, reason: 'seed' });
  }
}
for (const st of repairStates) {
  if (repairs.some((r) => r.status === st)) continue;
  const created = await api(admin, 'POST', '/api/equip/repairs', {
    device_id: deviceIds[0], team_name: '默认团队', handler_name: st === '待派单' ? '' : (admin.name || '本地管理员'),
    description: `R11维修${st}`, source: st === '已完成' ? '维保记录' : '人工创建',
  });
  const id = created.id;
  if (!id) continue;
  if (st === '待派单' || st === '待接单') continue;
  if (st === '处理中') await driveRepair(id, ['接单']);
  else if (st === '待审核') await driveRepair(id, ['接单', '完成']);
  else if (st === '已完成') await driveRepair(id, ['接单', '完成', '审核通过']);
  else if (st === '审核退回') await driveRepair(id, ['接单', '完成', '审核退回']);
  else if (st === '暂停') await driveRepair(id, ['接单', '暂停']);
  else if (st === '取消') await driveRepair(id, ['取消']);
}
const qrs = (await api(admin, 'GET', '/api/equip/qrcodes')).items ?? [];
if (qrs.length < 15) {
  await api(admin, 'POST', '/api/equip/qrcodes', { count: 15 - qrs.length, mode: 'excel' });
}

const teams = (await api(admin, 'GET', '/api/system/teams')).items ?? [];
const dept = ((await api(admin, 'GET', '/api/system/departments')).items ?? [])[0];
const noticeList = (await api(admin, 'GET', '/api/notices')).items ?? [];
for (let i = noticeList.length; i < 12; i += 1) {
  await api(admin, 'POST', '/api/notices', {
    title: `R11公告${i + 1}`, body_html: `<p>R11消息${i + 1}</p>`, user_ids: [admin.userId, worker.userId], department_ids: dept ? [dept.id] : [],
  });
}

const projects = (await api(admin, 'GET', '/api/production-projects')).items ?? [];
async function ensureProject(name, category, extra = {}) {
  let row = projects.find((p) => p.name === name);
  if (!row) {
    const created = await api(admin, 'POST', '/api/production-projects', { name, category, ...extra });
    row = created.project ?? created;
    if (row) projects.push(row);
  }
  return row;
}
const pNormal = await ensureProject('R11普通项目', '普通项目');
const pContract = await ensureProject('R11合同项目', '合同项目', { contract_id: flowContract.id });
const pOut = await ensureProject('R11外协项目', '外协项目');
for (const proj of [pNormal, pContract, pOut]) {
  if (!proj?.id) continue;
  const detailP = await api(admin, 'GET', `/api/production-projects/${proj.id}`);
  const linked = detailP.work_orders ?? [];
  for (let i = linked.length; i < 2; i += 1) {
    const created = await api(admin, 'POST', '/api/work-orders', {
      request_key: key(), product_id: fg.id, quantity: '8', warehouse_id: warehouse.id, tasks: [{ process_id: procA.id }],
    });
    const w = created.work_order ?? created;
    await api(admin, 'PUT', `/api/work-order-links/${w.id}`, { project_id: proj.id });
  }
}

const traces = (await api(admin, 'GET', '/api/trace-codes')).items ?? [];
if (traces.length < 10) await api(admin, 'POST', '/api/trace-codes/batch', { work_order_id: wo.id, count: 10, qty: '1' });

const comps = (await api(admin, 'GET', '/api/process-components')).items ?? [];
if (comps.length < 2) {
  await api(admin, 'POST', '/api/process-components', {
    title: 'R11组件公式', note: '',
    fields: [{ name: '数字', field_type: '数字输入框', required: false }, { name: '结果', field_type: '公式', formula: '${数字}*2', decimals: 2, required: false }],
  });
  await api(admin, 'POST', '/api/process-components', { title: 'R11组件普通', note: '', fields: [{ name: '文本', field_type: '单行文本', required: false }] });
}

const schedIds = ((await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=200')).items ?? [])
  .filter((w) => !w.parent_id && ['not_started', 'running', 'paused'].includes(w.execution))
  .map((w) => w.id);
if (schedIds.length) await api(admin, 'PUT', '/api/work-orders/schedule', { ids: schedIds });

const deviceId = ((await api(admin, 'GET', '/api/equip/devices')).items ?? [])[0]?.id;
const repairId = ((await api(admin, 'GET', '/api/equip/repairs')).items ?? [])[0]?.id;
const meetingId = ((await api(admin, 'GET', '/api/lean/meetings')).items ?? [])[0]?.id;
const productionPlans = await api(admin, 'GET', '/api/production-plans');
const productionPlanId = (productionPlans.items ?? productionPlans.plans ?? [])[0]?.id;
const outsourceId = ((await api(admin, 'GET', '/api/outsource/orders')).items ?? [])[0]?.id;
const purchaseId = ((await api(admin, 'GET', '/api/money/purchase-orders')).items ?? [])[0]?.id;
const contractProject = pContract?.id ? ((await api(admin, 'GET', `/api/production-projects/${pContract.id}`)).project ?? pContract) : pContract;
mkdirSync('.local', { recursive: true });
writeFileSync('.local/round11-ids.json', JSON.stringify({
  id: wo.id,
  customer_id: cust.id,
  product_id: fg.id,
  work_order_id: wo.id,
  contract_id: contract.id,
  contractNo: contract.code,
  contractId: contract.id,
  project_id: pNormal?.id,
  contract_project_id: contractProject?.id,
  outsource_project_id: pOut?.id,
  plan_id: planId,
  device_id: deviceId,
  repair_id: repairId,
  inspection_plan_id: planId,
  inspection_plan: planId,
  meeting_id: meetingId,
  production_plan_id: productionPlanId,
  outsource_id: outsourceId,
  purchase_id: purchaseId,
}, null, 2));

const contactsN = ((await api(admin, 'GET', '/api/crm/contacts')).items ?? []).length;
const seaN = ((await api(admin, 'GET', '/api/crm/sea')).items ?? []).length;
const perfN = ((await api(admin, 'GET', '/api/performance-pay')).items ?? []).length;
const evN = ((await api(admin, 'GET', '/api/auto-stock/events')).items ?? []).length;
const devN = ((await api(admin, 'GET', '/api/equip/devices')).items ?? []).length;
must(contactsN >= 6, '联系人≥6', contactsN);
must(seaN >= 3, '公海≥3', seaN);
must(perfN >= 4, '绩效≥4', perfN);
must(evN >= 2, '自动出入库事件≥2', evN);
must(devN >= 10, '设备≥10', devN);
must(Boolean(planId && deviceId && repairId), '维保/设备/维修 id', `${planId}/${deviceId}/${repairId}`);
console.log('seed-round11 完成');
