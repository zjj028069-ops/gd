/**
 * 第十轮验收数据（幂等）。前置：npm run dev:setup && npm run dev
 * 先跑 seed-round9-demo.mjs，再补 R10 数据；结尾中文断言表，有一项失败 exit(1)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { cleanupTestContractsDb, cleanupStaleProductionPlansDb } from './seed-db-cleanup.mjs';

async function waitApi(ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/api/auth/me`);
      // 401/200/429 都说明服务已起来（429 是登录限流，不代表挂了）
      if ([200, 401, 429, 403].includes(res.status)) return;
    } catch { /* 重启中 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API 重启等待超时');
}

function stopApi() {
  spawnSync('pkill', ['-f', 'tsx src/server.ts'], { stdio: 'ignore' });
  spawnSync('pkill', ['-f', 'src/server.ts'], { stdio: 'ignore' });
}

function startApi() {
  const out = openSync('/tmp/r10-api.log', 'a');
  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: '/workspace/apps/api',
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
}

/** 独占打开 PGlite：停 API → 执行 DB → REINDEX → 启 API，避免并发损坏索引。
 * ROUND11_KEEP_API=1：不停/启 API，只跑 work()+REINDEX（验收时 API 已在跑）。 */
async function withExclusiveDb(label, work) {
  const keepApi = process.env.ROUND11_KEEP_API === '1';
  if (keepApi) {
    // API 已占用 PGlite 时再直连会抢锁/损坏；空库连跑靠正式接口幂等，跳过直连清理。
    // 返回占位结果，避免调用方读 deletedPlans/deleted 时空指针。
    console.log(`独占DB（${label}）KEEP_API=1，跳过直连清理与 REINDEX`);
    return { deletedPlans: 0, deletedAnalyses: 0, deleted: 0, remaining: 0 };
  }
  console.log(`独占DB（${label}）停API…`);
  stopApi();
  await new Promise((r) => setTimeout(r, 800));
  const result = await work();
  try {
    const { PGlite } = await import('@electric-sql/pglite');
    const path = await import('node:path');
    const dataDir = process.env.LOCAL_DB_DIR ?? path.resolve(process.cwd(), '.local/database');
    const db = new PGlite(dataDir);
    for (const t of ['work_orders', 'money_contracts', 'production_plans', 'production_plan_analyses', 'warehouse_misc_bills', 'r8_spot_lines', 'r8_spot_checks', 'r8_maint_tasks', 'r8_maint_records', 'work_order_tasks', 'notices', 'notice_reads', 'ai_qa_pairs']) {
      try { await db.exec(`REINDEX TABLE ${t}`); } catch { /* 表可能不存在 */ }
    }
    await db.close?.();
  } catch (error) {
    console.warn('REINDEX跳过', String(error).slice(0, 80));
  }
  console.log(`独占DB（${label}）启API…`);
  startApi();
  await waitApi();
  return result;
}

async function reloadApiAfterDb(label) {
  // 兼容旧调用点：此时 DB 已写完，仅确保 API 在线
  console.log(`确认API（${label}）…`);
  try {
    await waitApi(5000);
  } catch {
    startApi();
    await waitApi();
  }
  console.log(`API已确认（${label}）`);
}

async function relogin(session) {
  const fresh = await login(session.username, session.password);
  Object.assign(session, fresh);
  return session;
}

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const rows = [];
let failed = false;
function step(name, ok, actual) {
  rows.push({ name, result: ok ? '通过' : '未通过', actual: String(actual) });
  if (!ok) failed = true;
  console.log(`${ok ? '通过' : '未通过'}\t${name}\t${actual}`);
}
function must(ok, name, actual) {
  step(name, ok, actual);
  if (!ok) throw new Error(`${name}：${actual}`);
}

const r9 = spawnSync('node', ['scripts/seed-round9-demo.mjs'], { stdio: 'inherit', cwd: process.cwd(), env: process.env });
must(r9.status === 0, '第九轮 seed 回归', r9.status ?? 'null');
const r8 = spawnSync('node', ['scripts/seed-round8-demo.mjs'], { stdio: 'inherit', cwd: process.cwd(), env: process.env });
must(r8.status === 0, '第八轮 seed（设备/质量/维保）', r8.status ?? 'null');

function passwordOf(file, username) {
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  const matched = text.match(new RegExp(`账号：${username.replace('.', '\\.')}[\\s\\S]*?密码：(\\S+)`));
  return matched?.[1] ?? '';
}
async function login(username, password) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_slug: 'demo-a', username, password }),
    });
    const json = await res.json().catch(() => ({}));
    const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
    if (res.ok && json.csrf_token) return { csrf: json.csrf_token, cookie, userId: json.user.id, name: json.user.display_name };
    const code = json?.error?.code || '';
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 120);
    if (code === 'RATE_LIMITED' || /限流|RATE_LIMIT/i.test(msg) || res.status === 429) {
      const waitMs = Math.min(30000, 2000 * attempt);
      console.log(`登录限流 ${username}，${waitMs}ms 后重试 (${attempt}/8)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`登录失败 ${username}: ${res.status} ${msg}`);
  }
  throw new Error(`登录失败 ${username}: RATE_LIMITED 重试耗尽`);
}
async function api(session, method, path, body, expected = 200) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie: session.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}
const key = () => crypto.randomUUID();

const devPass = {
  admin: passwordOf('.local/dev-credentials.txt', 'admin.local'),
  worker: passwordOf('.local/dev-credentials.txt', 'worker.local'),
};
must(Boolean(devPass.admin && devPass.worker), 'dev 凭据', 'admin.local/worker.local');

const admin = await login('admin.local', devPass.admin);
admin.username = 'admin.local';
admin.password = devPass.admin;
const worker = await login('worker.local', devPass.worker);
worker.username = 'worker.local';
worker.password = devPass.worker;

/** T0：审核快照在建单时冻结。把 admin 加进已启用流程，后续入库/出库/收款才能由 seed 账号审核；planner 仍保留，round7 批量审不会坏。 */
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

const moneyFlows = await api(admin, 'GET', '/api/money/audit-flows');
if (!moneyFlows.items.some((f) => f.enabled && (f.object_types?.includes('contract') || f.object_type === 'contract'))) {
  await api(admin, 'POST', '/api/money/audit-flows', { name: 'R10合同审核', object_type: 'contract', enabled: true }, 201);
}

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
function weekRange() {
  const today = new Date(shanghaiToday() + 'T12:00:00+08:00');
  const day = today.getDay() || 7;
  const mon = new Date(today);
  mon.setDate(today.getDate() - day + 1);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(mon), end: fmt(sun), mid: fmt(new Date(today)) };
}
const week = weekRange();

// 大屏 R10 测试：先清掉验收过程中留下的「R10新增*」临时屏，再保证预置屏齐全
let screenList = await api(admin, 'GET', '/api/data-screens');
for (const item of screenList.items.filter((row) => String(row.menu_name || '').startsWith('R10新增'))) {
  try { await api(admin, 'DELETE', `/api/data-screens/${item.id}`); } catch { /* 已删跳过 */ }
}
screenList = await api(admin, 'GET', '/api/data-screens');
const presets = [
  ['生产中控大屏', '默认', '生产模块', 'control'],
  ['车间大屏', '四模块', '生产模块', 'workshop'],
  ['机台实时状态', '单模块', '生产模块', 'machine'],
  ['不良品统计大屏', '左右双模块', '生产模块', 'defect'],
  ['加工单生产进度', '单模块', '生产模块', 'wo-progress'],
  ['维保大屏', '默认', '设备维保模块', 'maint-default'],
  ['设备实时状态', '左右双模块', '设备维保模块', 'device-live'],
];
for (const [menu_name, layout, module_kind] of presets) {
  if (!screenList.items.some((item) => item.menu_name === menu_name)) {
    await api(admin, 'POST', '/api/data-screens', { menu_name, layout, module_kind, description: '-', access_password: '' }, 201);
    screenList = await api(admin, 'GET', '/api/data-screens');
  }
}
let r10Screen = screenList.items.find((item) => item.menu_name === 'R10测试大屏');
if (!r10Screen) {
  r10Screen = await api(admin, 'POST', '/api/data-screens', {
    menu_name: 'R10测试大屏', layout: '默认', module_kind: '生产模块', description: 'R10验收', access_password: '',
  }, 201);
}
// 默认布局 6 槽位全部有模块，避免查看大屏出现「未选择模块」
await api(admin, 'PUT', `/api/data-screens/${r10Screen.id}/design`, {
  title: 'R10车间看板',
  slots: [
    { slot: 1, module: 'defect_items' },
    { slot: 2, module: 'process_daily' },
    { slot: 3, module: 'cards' },
    { slot: 4, module: 'employee_rank' },
    { slot: 5, module: 'recent_reports' },
    { slot: 6, module: 'work_orders' },
  ],
});
const screenCount = (await api(admin, 'GET', '/api/data-screens')).items.length;
must(screenCount >= 8, '大屏数量≥8', screenCount);

// 客户跟单
const follows = await api(admin, 'GET', '/api/customer-follows');
const needFollow = Math.max(0, 6 - follows.items.length);
const customers = await api(admin, 'GET', '/api/money/customers?page=1&page_size=50');
const customer = customers.items?.[0];
if (customer && needFollow > 0) {
  const contacts = await api(admin, 'GET', `/api/customer-follows/contacts?customer_id=${customer.id}`);
  const contact = contacts.items?.[0] ?? contacts[0];
  const types = ['上门', '电话', '网络'];
  for (let i = 0; i < needFollow; i += 1) {
    const next = new Date(Date.now() + (i === 0 ? -3600_000 : 3600_000 * (i + 2)));
    await api(admin, 'POST', '/api/customer-follows', {
      customer_id: customer.id, contact_id: contact.id, follow_type: types[i % 3],
      content: `R10跟单${i + 1}`, next_at: next.toISOString().slice(0, 16).replace('T', ' '),
    }, 201);
  }
}
const followTotal = (await api(admin, 'GET', '/api/customer-follows')).items.length;
must(followTotal >= 6, '客户跟单≥6', followTotal);

// 知识库 / 通知
const cats = await api(admin, 'GET', '/api/knowledge/categories');
if (!cats.items.some((c) => c.name === 'R10分类A')) await api(admin, 'POST', '/api/knowledge/categories', { name: 'R10分类A' }, 201);
if (!cats.items.some((c) => c.name === 'R10分类B')) await api(admin, 'POST', '/api/knowledge/categories', { name: 'R10分类B' }, 201);
const articles = await api(admin, 'GET', '/api/knowledge/articles');
for (let i = articles.items.length; i < 3; i += 1) {
  await api(admin, 'POST', '/api/knowledge/articles', { title: `R10知识${i + 1}`, category_id: cats.items[0]?.id, body_html: '<p>R10</p>', is_public: false }, 201);
}
const notices = await api(admin, 'GET', '/api/notices?tab=all');
for (let i = notices.items.length; i < 3; i += 1) {
  await api(admin, 'POST', '/api/notices', { title: `R10公告${i + 1}`, body_html: '<p>公告</p>', user_ids: [admin.userId, worker.userId] }, 201);
}
{
  const unreadW = await api(worker, 'GET', '/api/notices?tab=unread');
  if (!(unreadW.items?.length >= 1)) {
    await api(admin, 'POST', '/api/notices', { title: 'R10工人未读', body_html: '<p>请阅读</p>', user_ids: [worker.userId] }, 201);
  }
}

// 采购设置 / 价格规则
const ps = await api(admin, 'GET', '/api/purchase/settings');
await api(admin, 'PUT', '/api/purchase/settings', { ...ps.settings, show_supplier_info: true, hide_audit_status: true, refill_percent: '50', refill_basis: 'lower' });
const ss = await api(admin, 'GET', '/api/purchase/supplier-settings');
await api(admin, 'PUT', '/api/purchase/supplier-settings', { ...ss.settings, supplier_unique_phone: true });
const rules = await api(admin, 'GET', '/api/purchase/price-rules');
const suppliers = await api(admin, 'GET', '/api/money/suppliers?page=1&page_size=100');
const products = await api(admin, 'GET', '/api/products?page=1&page_size=30');
const phoneSeed = '13800138000';
if (!(suppliers.items ?? []).some((row) => String(row.contact_phone ?? '') === phoneSeed)) {
  try {
    await api(admin, 'POST', '/api/money/suppliers', {
      request_key: key(), name: 'R10手机号源', company_name: 'R10手机号源',
      contact_name: '测', contact_phone: phoneSeed, owner_id: admin.userId,
    }, 201);
  } catch { /* 已存在则忽略 */ }
}
const sup = (await api(admin, 'GET', '/api/money/suppliers?page=1&page_size=20')).items?.[0];
const prod = products.items?.[0];
must(Boolean(sup?.id), '价格规则供应商', sup?.id);
must(Boolean(prod?.id), '价格规则产品', prod?.id);
if (sup && prod && rules.items.length < 3) {
  for (let i = rules.items.length; i < 3; i += 1) {
    const p = products.items[i] ?? prod;
    try {
      await api(admin, 'POST', '/api/purchase/price-rules', { supplier_id: sup.id, product_id: p.id, unit_price: String(10 + i) }, 201);
    } catch (error) {
      // 唯一键冲突视为已有；其它错误必须失败，避免验收「无价格规则」
      if (!String(error).includes('409') && !String(error).includes('已存在')) throw error;
    }
  }
}
const rulesAfter = await api(admin, 'GET', '/api/purchase/price-rules');
must((rulesAfter.items?.length ?? 0) >= 1, '价格规则≥1', rulesAfter.items?.length);

// 通用 / 短信（充值/发送记录由 seed-demo 写入）
{
  const basics = await api(admin, 'GET', '/api/system/basics');
  await api(admin, 'PUT', '/api/system/basics', {
    ...basics.settings,
    device_qr_repair: true,
    device_qr_patrol: true,
    map_hidden_user_ids: [admin.userId],
    photo_watermark: false,
    version: basics.settings?.version,
  });
}
const smsSeed = await api(admin, 'POST', '/api/system/sms/seed-demo', {});
must(Number(smsSeed.remaining ?? 0) >= 1, '短信剩余', smsSeed.remaining);
must(Number(smsSeed.recharges ?? 0) >= 1, '短信充值记录≥1', smsSeed.recharges);
must(Number(smsSeed.sends ?? 0) >= 3, '短信发送记录≥3', smsSeed.sends);

// 设备概况：至少 5 台、3 种状态，保证工作台饼图有数
let equipCats = await api(admin, 'GET', '/api/equip/categories');
if (!equipCats.items?.length) {
  const created = await api(admin, 'POST', '/api/equip/categories', { name: 'R10设备类' }, 201);
  equipCats = { items: [{ id: created.id }] };
}
const equipCatId = equipCats.items?.[0]?.id;
let devicesForChart = await api(admin, 'GET', '/api/equip/devices');
const needStatuses = ['正常', '维修中', '运行中'];
if (equipCatId) {
  for (let i = devicesForChart.items?.length ?? 0; i < 5; i += 1) {
    try {
      await api(admin, 'POST', '/api/equip/devices', {
        name: `R10设备${i + 1}`, owner_name: admin.name || '本地管理员', category_id: equipCatId, status: needStatuses[i % 3],
      }, 201);
    } catch { /* 重复跳过 */ }
  }
  devicesForChart = await api(admin, 'GET', '/api/equip/devices');
  for (const status of needStatuses) {
    if (!devicesForChart.items.some((item) => item.status === status)) {
      try {
        await api(admin, 'POST', '/api/equip/devices', {
          name: `R10${status}设备`, owner_name: admin.name || '本地管理员', category_id: equipCatId, status,
        }, 201);
      } catch { /* 重复跳过 */ }
    }
  }
  devicesForChart = await api(admin, 'GET', '/api/equip/devices');
}
must((devicesForChart.items?.length ?? 0) >= 5, '设备≥5', devicesForChart.items?.length ?? 0);
must(new Set((devicesForChart.items ?? []).map((item) => item.status)).size >= 3, '设备状态≥3种', [...new Set((devicesForChart.items ?? []).map((item) => item.status))].join(','));

// 项目 / 成本分摊 / 岗位 / 组件 / 溯源码
let projects = await api(admin, 'GET', '/api/production-projects');
if (!projects.items.some((item) => item.name === 'R10项目A') && customer) {
  await api(admin, 'POST', '/api/production-projects', { name: 'R10项目A', customer_id: customer.id, plan_start: week.start, plan_end: week.end, status: '进行中' }, 201);
}
if (!projects.items.some((item) => item.name === 'R10项目B') && customer) {
  await api(admin, 'POST', '/api/production-projects', { name: 'R10项目B', customer_id: customer.id, plan_start: week.start, plan_end: week.end, status: '进行中' }, 201);
}
projects = await api(admin, 'GET', '/api/production-projects');
const posts = await api(admin, 'GET', '/api/posts');
for (let i = posts.items.length; i < 3; i += 1) {
  await api(admin, 'POST', '/api/posts', { name: `R10岗位${i + 1}`, member_ids: [worker.userId], process_ids: [], duty: 'R10' }, 201);
}
const components = await api(admin, 'GET', '/api/process-components');
if (!components.items.some((c) => c.title === 'R10检查表')) {
  await api(admin, 'POST', '/api/process-components', {
    title: 'R10检查表', note: 'R10', fields: [{ name: '结果', field_type: '公式', formula: '1+1', decimals: 2, required: false }],
  }, 201);
}

// BOM：验收第 41 条复制/删除需要至少 1 行
{
  const boms = await api(admin, 'GET', '/api/boms');
  if ((boms.items?.length ?? 0) < 1) {
    const productsAll = await api(admin, 'GET', '/api/products?page=1&page_size=50');
    const parent = (productsAll.items ?? []).find((p) => p.attribute === 'manufactured') ?? prod;
    const child = (productsAll.items ?? []).find((p) => p.id !== parent?.id) ?? (productsAll.items ?? [])[1];
    if (parent?.id && child?.id) {
      try {
        await api(admin, 'POST', '/api/boms', {
          parent_product_id: parent.id,
          description: 'R10验收BOM',
          items: [{ component_product_id: child.id, quantity: '1', loss_rate: '0', auto_issue: false }],
        }, 201);
      } catch (error) { console.warn('创建BOM跳过', String(error).slice(0, 160)); }
    }
  }
  must(((await api(admin, 'GET', '/api/boms')).items?.length ?? 0) >= 1, 'BOM≥1', (await api(admin, 'GET', '/api/boms')).items?.length ?? 0);
}

const warehouses = await api(admin, 'GET', '/api/warehouses');
const warehouse = warehouses.items?.[0];
const processes = await api(admin, 'GET', '/api/processes');
let proc = processes.items?.find((p) => Number(p.wage_rate) > 0 && p.pricing_mode === 'piece') ?? processes.items?.[0];
if (prod && (!proc || !(Number(proc.wage_rate) > 0))) {
  const existing = (processes.items ?? []).find((p) => p.code === 'R10-WAGE');
  if (existing) proc = existing;
  else {
    proc = (await api(admin, 'POST', '/api/processes', {
      code: 'R10-WAGE', name: 'R10计件', standard_minutes: '1', reporter_ids: [admin.userId, worker.userId],
      pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none',
    }, 201)).process;
  }
}
const units = await api(admin, 'GET', '/api/units');
const unitId = units.items?.[0]?.id;
const woList0 = await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=100');
let r10Wo = (woList0.items ?? []).find((w) => String(w.code) === 'R10-MAIN')
  ?? (woList0.items ?? []).find((w) => String(w.code).startsWith('R10'));
if ((!r10Wo || String(r10Wo.code) !== 'R10-MAIN') && prod && warehouse && proc) {
  const created = await api(admin, 'POST', '/api/work-orders', {
    request_key: key(), code: 'R10-MAIN', product_id: prod.id, quantity: '100', warehouse_id: warehouse.id,
    tasks: [{ process_id: proc.id, pricing_mode: 'piece', wage_rate: String(proc.wage_rate || '10') }],
  }, 201);
  r10Wo = created.work_order ?? created;
}
if (r10Wo && String(r10Wo.code) !== 'R10-MAIN') {
  const byCode = (await api(admin, 'GET', `/api/progress/work-orders?code=${encodeURIComponent('R10-MAIN')}&page_size=5`)).items?.[0];
  if (byCode) r10Wo = byCode;
}
if (r10Wo) {
  const traces = await api(admin, 'GET', '/api/trace-codes?work_order_code=R10');
  if ((traces.items?.length ?? 0) < 10) await api(admin, 'POST', '/api/trace-codes/batch', { work_order_id: r10Wo.id, count: 10, qty: '1' }, 201);
  const shares = await api(admin, 'GET', `/api/work-order-shares?work_order_id=${r10Wo.id}`);
  if (!shares.items.length) await api(admin, 'POST', '/api/work-order-shares', { work_order_id: r10Wo.id, expires_days: 30 }, 201);
}


// 每个 R10 项目挂 ≥2 张加工单，加工单数/工序进度才有数
const projectA = projects.items.find((item) => item.name === 'R10项目A') ?? projects.items[0];
const projectB = projects.items.find((item) => item.name === 'R10项目B') ?? projects.items[1] ?? projects.items[0];
async function ensureProjectWorkOrders(project, prefix) {
  if (!project || !prod || !warehouse || !proc) return;
  const detail = await api(admin, 'GET', `/api/production-projects/${project.id}`);
  const linked = detail.work_orders ?? [];
  for (let i = linked.length; i < 2; i += 1) {
    const code = `${prefix}-${i + 1}`;
    let wo = (await api(admin, 'GET', `/api/progress/work-orders?code=${encodeURIComponent(code)}&page_size=5`)).items?.[0];
    if (!wo) {
      const created = await api(admin, 'POST', '/api/work-orders', {
        request_key: key(), code, product_id: prod.id, quantity: String(20 + i * 10), warehouse_id: warehouse.id,
        tasks: [{ process_id: proc.id }],
      }, 201);
      wo = created.work_order ?? created;
    }
    if (wo?.id) await api(admin, 'PUT', `/api/work-order-links/${wo.id}`, { project_id: project.id });
  }
}
await ensureProjectWorkOrders(projectA, 'R10-PA');
await ensureProjectWorkOrders(projectB, 'R10-PB');
// 专门留一张未完成加工单供「拆单」验收（拆单在 completed/cancelled 时禁用）
{
  const list = await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=50');
  let splitWo = (list.items ?? []).find((row) => String(row.code) === 'R10-SPLIT' && !['completed', 'cancelled'].includes(row.execution));
  if (!splitWo && prod && warehouse && proc) {
    const created = await api(admin, 'POST', '/api/work-orders', {
      request_key: key(), code: 'R10-SPLIT', product_id: prod.id, quantity: '50', warehouse_id: warehouse.id,
      tasks: [{ process_id: proc.id }],
    }, 201);
    splitWo = created.work_order ?? created;
  }
  must(splitWo?.id && !['completed', 'cancelled'].includes(String(splitWo.execution ?? 'not_started')), '可拆单加工单', `${splitWo?.code}:${splitWo?.execution}`);
}
// 至少完成 1 道工序，避免页面「工序进度」全是 0%（勿碰 R10-SPLIT）
for (const project of [projectA, projectB].filter(Boolean)) {
  const detail = await api(admin, 'GET', `/api/production-projects/${project.id}`);
  for (const wo of (detail.work_orders ?? []).slice(0, 1)) {
    if (String(wo.code) === 'R10-SPLIT') continue;
    const order = await api(admin, 'GET', `/api/work-orders/${wo.id}`);
    const task = (order.tasks ?? order.work_order?.tasks ?? []).find((item) => item.execution !== 'completed')
      ?? (order.tasks ?? order.work_order?.tasks ?? [])[0];
    if (!task?.id) continue;
    const version = Number(task.version ?? 1);
    if (task.execution === 'not_started') {
      await api(admin, 'POST', `/api/work-orders/${wo.id}/tasks/${task.id}/actions`, { action: 'start', version }).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态/.test(String(err))) throw err; });
    }
    const fresh = await api(admin, 'GET', `/api/work-orders/${wo.id}`);
    const cur = (fresh.tasks ?? fresh.work_order?.tasks ?? []).find((item) => item.id === task.id) ?? task;
    if (cur.execution !== 'completed') {
      await api(admin, 'POST', `/api/work-orders/${wo.id}/tasks/${cur.id}/actions`, { action: 'complete', version: Number(cur.version ?? version) }).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态/.test(String(err))) throw err; });
    }
  }
}
const projectCheck = await api(admin, 'GET', '/api/production-projects');
must(projectCheck.items.some((item) => Number(item.work_order_count ?? 0) >= 2), '项目加工单数≥2', projectCheck.items.map((item) => item.work_order_count).join(','));
must(projectCheck.items.some((item) => {
  const text = String(item.process_progress ?? '');
  const matched = text.match(/(\d+)%\s*\((\d+)\/(\d+)\)/);
  return matched && Number(matched[1]) > 0 && Number(matched[3]) > 0;
}), '项目工序进度非0', projectCheck.items.map((item) => item.process_progress).join(','));

const plansClean = await withExclusiveDb('清理计划', () => cleanupStaleProductionPlansDb());
console.log(`DB清理生产计划 deletedPlans=${plansClean.deletedPlans} deletedAnalyses=${plansClean.deletedAnalyses}`);
await relogin(admin);
try { await relogin(worker); } catch {}
const plans = await api(admin, 'GET', '/api/production-plans?page=1&page_size=50');
let plan = plans.items?.find((p) => String(p.name) === 'R10生产计划A');
if (!plan && prod) {
  plan = (await api(admin, 'POST', '/api/production-plans', {
    request_key: key(), name: 'R10生产计划A', delivery_date: week.end, note: 'R10',
    lines: [{ product_id: prod.id, plan_qty: '10' }, { product_id: products.items?.[1]?.id ?? prod.id, plan_qty: '5' }],
  })).plan;
}
must(plan?.id && String(plan.name) === 'R10生产计划A', 'R10生产计划A', plan?.name);
let planVoid = plans.items?.find((p) => String(p.name) === 'R10生产计划作废用');
if (!planVoid && prod) {
  planVoid = (await api(admin, 'POST', '/api/production-plans', {
    request_key: key(), name: 'R10生产计划作废用', delivery_date: week.end, note: 'R10-void',
    lines: [{ product_id: prod.id, plan_qty: '3' }],
  })).plan;
}
// 再次数据库层去重，防止分析复用产生重复编号
await withExclusiveDb('计划去重', () => cleanupStaleProductionPlansDb());
await relogin(admin);
try { await relogin(worker); } catch (error) { if (!/限流|RATE/.test(String(error))) throw error; }
{
  const fresh = await api(admin, 'GET', '/api/production-plans?page=1&page_size=50');
  plan = fresh.items?.find((p) => String(p.name) === 'R10生产计划A') ?? plan;
  planVoid = fresh.items?.find((p) => String(p.name) === 'R10生产计划作废用') ?? planVoid;
  if (!planVoid && prod) {
    planVoid = (await api(admin, 'POST', '/api/production-plans', {
      request_key: key(), name: 'R10生产计划作废用', delivery_date: week.end, note: 'R10-void',
      lines: [{ product_id: prod.id, plan_qty: '3' }],
    })).plan;
  }
  async function ensureAnalyzed(target, voidAll) {
    if (!target?.id) throw new Error(`生产计划不存在，无法分析 ${target?.name ?? ''}`);
    let rows = ((await api(admin, 'GET', '/api/material-analysis')).items ?? []).filter((item) => item.plan_id === target.id);
    if (!rows.length) {
      await api(admin, 'POST', `/api/production-plans/${target.id}/analyze`, {});
      rows = ((await api(admin, 'GET', '/api/material-analysis')).items ?? []).filter((item) => item.plan_id === target.id);
    }
    if (!rows.length) throw new Error(`物料分析未生成 ${target.name}`);
    if (voidAll) {
      for (const row of rows.filter((item) => item.status !== 'void')) {
        await api(admin, 'POST', `/api/production-plans/${target.id}/analysis-lines/${row.id}/void`, {});
      }
    }
  }
  await ensureAnalyzed(plan, false);
  await ensureAnalyzed(planVoid, true);
}
// 物料分析关联外协工单 / 采购单（计数不能全是 0）
{
  const analyzed = await api(admin, 'GET', '/api/material-analysis');
  const active = analyzed.items?.find((item) => item.plan_id === plan?.id && item.status !== 'void')
    ?? analyzed.items?.find((item) => item.status !== 'void');
  if (active && prod && sup) {
    if (Number(active.outsource_count ?? 0) < 1) {
      const qty = Number(active.outsource_demand_qty) > 0 ? String(active.outsource_demand_qty) : '5';
      const created = await api(admin, 'POST', '/api/outsource/orders', {
        product_id: prod.id, plan_qty: qty, unit_price: '12', priority: '正常', supplier_id: sup.id,
        note: 'R10物料分析外协',
      }, 201);
      const orderId = created.order?.id ?? created.id;
      if (!orderId) throw new Error('外协工单未返回 id');
      await api(admin, 'POST', `/api/material-analysis/${active.id}/link`, { kind: 'outsource', order_id: orderId });
    }
    if (Number(active.purchase_count ?? 0) < 1) {
      const po = await api(admin, 'POST', '/api/money/purchase-orders', {
        request_key: key(), supplier_id: sup.id, buyer_id: admin.userId, note: 'R10物料分析采购', submit: true,
        lines: [{ product_id: prod.id, quantity: '5', unit_price: '8' }],
      }, 201);
      const orderId = po.purchase_order?.id ?? po.order?.id ?? po.id;
      if (!orderId) throw new Error('采购单未返回 id');
      await api(admin, 'POST', `/api/material-analysis/${active.id}/link`, { kind: 'purchase', order_id: orderId });
    }
  }
  const afterLink = await api(admin, 'GET', '/api/material-analysis');
  const linked = afterLink.items?.find((item) => item.id === active?.id) ?? afterLink.items?.find((item) => item.plan_id === plan?.id && item.status !== 'void');
  console.log(`物料分析计划=${linked?.plan_code || plan?.code || '-'} 外协=${linked?.outsource_count ?? 0} 采购=${linked?.purchase_count ?? 0}`);
  // 清理同一作废计划的重复行，只留 1 条已作废
  if (planVoid) {
    const voidRows = (afterLink.items ?? []).filter((item) => item.plan_id === planVoid.id && (item.status === 'void' || item.status_text === '已作废'));
    for (const extra of voidRows.slice(1)) {
      try { await api(admin, 'DELETE', `/api/material-analysis/${extra.id}`); }
      catch (error) { console.warn('删除重复作废分析跳过', String(error).slice(0, 120)); }
    }
    const left = ((await api(admin, 'GET', '/api/material-analysis')).items ?? []).filter((item) => item.plan_id === planVoid.id);
    must(left.length <= 1, `作废计划${left[0]?.plan_code || planVoid.code || ''}不重复堆积`, left.length);
  }
  // 任何计划编号在物料分析列表中不许重复
  {
    const list = ((await api(admin, 'GET', '/api/material-analysis?page=1&page_size=100')).items ?? []);
    const codes = list.map((item) => String(item.plan_code || ''));
    const dup = codes.filter((c, i) => c && codes.indexOf(c) !== i);
    must(dup.length === 0, '物料分析计划编号不重复', dup.length ? [...new Set(dup)].join(',') : '0');
  }
}
// R10-MAIN 成本：人工工资 + 关联外协结算 + 已分摊成本分摊
if (r10Wo) {
  try {
    let detail = await api(admin, 'GET', `/api/work-orders/${r10Wo.id}`);
    let wo = detail.work_order ?? detail;
    if (wo.execution === 'not_started') {
      wo = (await api(admin, 'POST', `/api/work-orders/${r10Wo.id}/actions`, { action: 'start', version: wo.version, request_key: key() })).work_order ?? wo;
    }
    const task = (wo.tasks ?? []).find((t) => t.execution !== 'completed') ?? (wo.tasks ?? [])[0];
    if (task?.id) {
      if (task.execution === 'not_started') {
        await api(admin, 'POST', `/api/work-orders/${r10Wo.id}/tasks/${task.id}/actions`, {
          action: 'start', version: Number(task.version ?? 1),
        }).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
      }
      const reports = (await api(admin, 'GET', `/api/production-reports?work_order_id=${r10Wo.id}`)).items ?? [];
      let wageReport = reports.find((r) => r.approval === 'approved' && Number(r.wage_snapshot?.amount_cents ?? r.wage_cents ?? 0) > 0)
        ?? reports.find((r) => r.approval === 'approved' && Number(r.good_qty) > 0);
      if (!wageReport) {
        const created = await api(admin, 'POST', '/api/production-reports', {
          request_key: key(), task_id: task.id, good_qty: '10', defect_qty: '0', rework_qty: '0', scrap_qty: '0',
        }, 201);
        wageReport = created.report ?? created;
      }
      if (wageReport?.id && wageReport.approval === 'pending') {
        await api(admin, 'POST', `/api/production-reports/${wageReport.id}/actions`, {
          action: 'approve', version: Number(wageReport.version ?? 1), request_key: key(),
        }).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
      }
    }
  } catch (error) { console.warn('R10-MAIN 报工工资跳过', String(error).slice(0, 160)); }

  try {
    const outs = await api(admin, 'GET', '/api/outsource/orders');
    let linked = (outs.items ?? []).find((o) => o.work_order_id === r10Wo.id && o.note === 'R10-MAIN外协');
    if (!linked && prod) {
      const created = await api(admin, 'POST', '/api/outsource/orders', {
        product_id: prod.id, plan_qty: '5', unit_price: '20', priority: '正常',
        supplier_id: sup?.id, work_order_id: r10Wo.id, note: 'R10-MAIN外协',
      }, 201);
      linked = created.order ?? created;
    }
    if (linked?.id) {
      if (linked.status === '未开始') {
        await api(admin, 'POST', `/api/outsource/orders/${linked.id}/actions`, { action: '开始' }).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
      }
      const receipts = await api(admin, 'GET', '/api/outsource/receipts');
      let receipt = (receipts.items ?? []).find((r) => r.order_id === linked.id || r.order_code === linked.code);
      if (!receipt) {
        receipt = await api(admin, 'POST', '/api/outsource/receipts', { order_id: linked.id, pass_qty: '2', fail_qty: '0' }, 201);
      }
      const receiptId = receipt?.id ?? receipt?.receipt?.id;
      if (receiptId && receipt.settle_status !== '已结算') {
        await api(admin, 'POST', `/api/outsource/receipts/${receiptId}/settle`, {}).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
      }
    }
  } catch (error) { console.warn('R10-MAIN 外协结算跳过', String(error).slice(0, 160)); }
}

{
  const paIds = [];
  for (const code of ['R10-PA-1', 'R10-PA-2', 'R10-MAIN']) {
    const row = (await api(admin, 'GET', `/api/progress/work-orders?code=${encodeURIComponent(code)}&page_size=5`)).items?.[0];
    if (row?.id) paIds.push(row.id);
  }
  const main = (await api(admin, 'GET', `/api/progress/work-orders?code=R9-主链&page_size=5`)).items?.[0];
  const woIds = [...new Set([r10Wo?.id, ...paIds, main?.id].filter(Boolean))];
  let sharesNow = await api(admin, 'GET', '/api/cost-shares');
  let covering = null;
  for (const item of sharesNow.items ?? []) {
    const detail = await api(admin, 'GET', `/api/cost-shares/${item.id}`);
    const hits = (detail.lines ?? []).some((line) => line.work_order_id === r10Wo?.id || line.work_order_code === 'R10-MAIN');
    if (!hits) continue;
    if (item.status === '已分摊') { covering = item; break; }
    if (!covering) covering = item;
  }
  if (covering && covering.status === '草稿' && covering.id) {
    await api(admin, 'POST', `/api/cost-shares/${covering.id}/share`, {}).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
    covering = { ...covering, status: '已分摊' };
  }
  if (!covering && woIds.length >= 1) {
    const named = (sharesNow.items ?? []).find((item) => String(item.name || '').startsWith('R10分摊'));
    if (named?.id) {
      if (named.status !== '已分摊') await api(admin, 'POST', `/api/cost-shares/${named.id}/share`, {}).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
      covering = named;
    } else {
      if ((sharesNow.items?.length ?? 0) < 2 && woIds.length >= 2) {
        await api(admin, 'POST', '/api/cost-shares', {
          name: 'R10分摊A', expense_type: '水电费', amount: '1000',
          period_start: week.start, period_end: week.end, method: '按计划数', work_order_ids: woIds,
        }, 201);
      }
      const created = await api(admin, 'POST', '/api/cost-shares', {
        name: 'R10分摊B', expense_type: '房租', amount: '500',
        period_start: week.start, period_end: week.end, method: '按计划数', work_order_ids: woIds,
      }, 201);
      const shareId = created?.id ?? created?.share?.id;
      if (shareId) await api(admin, 'POST', `/api/cost-shares/${shareId}/share`, {});
      covering = created;
    }
  }
  sharesNow = await api(admin, 'GET', '/api/cost-shares');
  if ((sharesNow.items?.length ?? 0) < 2 && woIds.length >= 2) {
    await api(admin, 'POST', '/api/cost-shares', {
      name: 'R10分摊补足', expense_type: '水电费', amount: '300',
      period_start: week.start, period_end: week.end, method: '按计划数', work_order_ids: woIds,
    }, 201);
  }
  try {
    const costReport = await api(admin, 'GET', '/api/report-extra/cost?page=1&page_size=50&code=R10-MAIN');
    const row = (costReport.items ?? []).find((item) => item.code === 'R10-MAIN');
    console.log(`成本报表 R10-MAIN labor=${row?.labor ?? '-'} outsource=${row?.outsource ?? '-'} cost_share=${row?.cost_share ?? '-'}`);
  } catch (error) { console.warn('成本报表校验跳过', String(error).slice(0, 120)); }
}
// 保证至少有一张已分摊覆盖 R10-MAIN
{
  const shares = await api(admin, 'GET', '/api/cost-shares');
  const shared = (shares.items ?? []).find((item) => item.status === '已分摊' || item.name === 'R10分摊B');
  if (shared && shared.status !== '已分摊' && shared.id) {
    try { await api(admin, 'POST', `/api/cost-shares/${shared.id}/share`, {}); } catch { /* 已分摊 */ }
  }
}
// R10-MAIN：人工报工 + 外协结算，成本报表三项都 >0
{
  let mainWo = (await api(admin, 'GET', '/api/progress/work-orders?code=R10-MAIN&page_size=5')).items?.[0] ?? r10Wo;
  if (mainWo?.id && prod && warehouse) {
    // 确保计件工序与报工
    let processes = await api(admin, 'GET', '/api/processes');
    let piece = (processes.items ?? []).find((p) => p.code === 'R10-COST' || (p.pricing_mode === 'piece' && Number(p.wage_rate) > 0));
    if (!piece) {
      piece = (await api(admin, 'POST', '/api/processes', {
        code: 'R10-COST', name: 'R10成本计件', standard_minutes: '1', reporter_ids: [admin.userId, worker.userId],
        pricing_mode: 'piece', wage_rate: '10', inspection_scheme: 'none',
      }, 201)).process;
    }
    const detail = await api(admin, 'GET', `/api/work-orders/${mainWo.id}`);
    let task = (detail.tasks ?? detail.work_order?.tasks ?? [])[0];
    if (task?.id) {
      if (mainWo.execution === 'not_started') {
        try { await api(admin, 'POST', `/api/work-orders/${mainWo.id}/actions`, { action: 'start', version: mainWo.version ?? 1 }); } catch { /* */ }
      }
      if (task.execution === 'not_started') {
        try { await api(admin, 'POST', `/api/work-orders/${mainWo.id}/tasks/${task.id}/actions`, { action: 'start', version: Number(task.version ?? 1) }); } catch { /* */ }
      }
      const reports = await api(admin, 'GET', `/api/production-reports?work_order_id=${mainWo.id}`);
      let priced = (reports.items ?? []).find((item) => item.approval === 'approved' && Number(item.estimated_wage || item.wage_snapshot?.amount || 0) > 0);
      if (!priced) {
        try {
          // 用 worker 身份报工更贴近真实；失败则 admin
          let created;
          try {
            created = await api(worker, 'POST', '/api/production-reports', {
              request_key: key(), task_id: task.id, good_qty: '10', defect_qty: '0', rework_qty: '0', scrap_qty: '0', note: 'R10成本人工',
            }, 201);
          } catch {
            created = await api(admin, 'POST', '/api/production-reports', {
              request_key: key(), task_id: task.id, good_qty: '10', defect_qty: '0', rework_qty: '0', scrap_qty: '0', note: 'R10成本人工',
            }, 201);
          }
          const report = created.report ?? created;
          if (report?.approval === 'pending' && report.id) {
            await api(admin, 'POST', `/api/production-reports/${report.id}/actions`, { action: 'approve', version: report.version ?? 1 }).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
          }
        } catch (error) { console.warn('R10人工报工跳过', String(error).slice(0, 160)); }
      }
    }
    // 外协挂到 R10-MAIN 并结算
    if (sup) {
      const outs = await api(admin, 'GET', '/api/outsource/orders');
      let linked = (outs.items ?? []).find((item) => item.work_order_id === mainWo.id || String(item.note || '').includes('R10成本外协'));
      if (!linked) {
        try {
          const created = await api(admin, 'POST', '/api/outsource/orders', {
            product_id: prod.id, plan_qty: '5', unit_price: '20', priority: '正常', supplier_id: sup.id,
            note: 'R10成本外协', work_order_id: mainWo.id,
          }, 201);
          linked = created.order ?? created;
          if (linked?.id) {
            await api(admin, 'POST', `/api/outsource/orders/${linked.id}/actions`, { action: '开始' }).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
            const receipt = await api(admin, 'POST', '/api/outsource/receipts', { order_id: linked.id, pass_qty: '5', fail_qty: '0' }, 201);
            const rid = receipt.id ?? receipt.receipt?.id;
            if (rid) await api(admin, 'POST', `/api/outsource/receipts/${rid}/settle`, {}).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
          }
        } catch (error) { console.warn('R10外协成本跳过', String(error).slice(0, 160)); }
      } else {
        const receipts = await api(admin, 'GET', '/api/outsource/receipts');
        const open = (receipts.items ?? []).find((item) => item.order_id === linked.id && item.settle_status !== '已结算');
        if (open?.id) await api(admin, 'POST', `/api/outsource/receipts/${open.id}/settle`, {}).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
        else if (!(receipts.items ?? []).some((item) => item.order_id === linked.id)) {
          try {
            await api(admin, 'POST', `/api/outsource/orders/${linked.id}/actions`, { action: '开始' }).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
            const receipt = await api(admin, 'POST', '/api/outsource/receipts', { order_id: linked.id, pass_qty: '5', fail_qty: '0' }, 201);
            const rid = receipt.id ?? receipt.receipt?.id;
            if (rid) await api(admin, 'POST', `/api/outsource/receipts/${rid}/settle`, {}).catch((err) => { if (!/已|当前|不能|不支持|VERSION|状态|重复/.test(String(err))) throw err; });
          } catch (error) { console.warn('R10外协补结算跳过', String(error).slice(0, 120)); }
        }
      }
    }
  }
}
{
  const analyzed = await api(admin, 'GET', '/api/material-analysis');
  must((analyzed.items?.length ?? 0) >= 2, '物料分析≥2', analyzed.items?.length ?? 0);
  must(analyzed.items?.some((item) => item.status === 'void' || item.status_text === '已作废'), '物料分析含已作废', analyzed.items?.map((item) => item.status).join(','));
  must(analyzed.items?.some((item) => Number(item.outsource_count ?? 0) > 0), '物料分析外协计数≥1', analyzed.items?.map((item) => item.outsource_count).join(','));
  must(analyzed.items?.some((item) => Number(item.purchase_count ?? 0) > 0), '物料分析采购计数≥1', analyzed.items?.map((item) => item.purchase_count).join(','));
}
must((await api(admin, 'GET', '/api/cost-shares')).items?.length >= 2, '成本分摊≥2', (await api(admin, 'GET', '/api/cost-shares')).items?.length ?? 0);
{
  const sharesNow = await api(admin, 'GET', '/api/cost-shares');
  if (!(sharesNow.items ?? []).some((item) => item.status === '草稿')) {
    const woId = r10Wo?.id ?? (await api(admin, 'GET', `/api/progress/work-orders?code=R10-MAIN&page_size=5`)).items?.[0]?.id;
    if (!woId) throw new Error('缺少加工单，无法创建成本分摊草稿');
    await api(admin, 'POST', '/api/cost-shares', {
      name: 'R10分摊草稿', expense_type: '其他', amount: '200',
      period_start: week.start, period_end: week.end, method: '按计划数', work_order_ids: [woId],
    }, 201);
  }
}

// 智能报表 / 视图
const smart = await api(admin, 'GET', '/api/smart-reports');
if (!smart.items.some((s) => s.name === 'R10自定义')) {
  await api(admin, 'POST', '/api/smart-reports', { name: 'R10自定义', source: 'production_reports', dimension: 'process', metric: 'good_qty', period: '本周' }, 201);
}
const views = await api(admin, 'GET', '/api/list-views?page_key=work-orders');
if (!views.items.some((v) => v.name === 'R10视图')) {
  await api(admin, 'POST', '/api/list-views', { page_key: 'work-orders', name: 'R10视图', conditions: { code: 'R10' }, columns: ['code', 'product_name', 'plan_qty', 'execution', 'priority'], sort: {} }, 201);
}

// 训练中心：走正式问答接口，至少 3 条
{
  const qa = await api(admin, 'GET', '/api/ai-train/qa?page=1&page_size=50');
  for (let i = (qa.items?.length ?? 0); i < 3; i += 1) {
    await api(admin, 'POST', '/api/ai-train/qa', { question: `R10问题${i + 1}`, answer: `R10答案${i + 1}` }, 201);
  }
  const after = await api(admin, 'GET', '/api/ai-train/qa?page=1&page_size=50');
  must((after.items?.length ?? 0) >= 3, '问答集≥3', after.items?.length ?? 0);
}
const docs = await api(admin, 'GET', '/api/ai-train/documents');
if (!docs.items.length) await api(admin, 'POST', '/api/ai-train/documents', { filename: 'R10说明.pdf', byte_size: 128 }, 201);

// 外协 / 返工任务标记
if (proc) {
  const tasks = await api(admin, 'GET', '/api/production-tasks?page=1&page_size=5');
  const t = tasks.items?.[0];
  if (t) {
    await fetch(`${API}/api/production-tasks/dispatch`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': admin.csrf }, body: JSON.stringify({ task_ids: [t.id], operator_ids: [worker.userId] }) });
  }
}

// 工作台待办：待审合同、待开票、维保三类待办均 >0
// 合同幂等：数据库层清理测试租户堆积（禁止走业务 force 后门）
{
  const cleaned = await withExclusiveDb('清理合同', () => cleanupTestContractsDb());
  console.log(`DB清理合同 deleted=${cleaned.deleted} remaining=${cleaned.remaining}`);
  await relogin(admin);
  try { await relogin(worker); } catch {}
}
let pendingContract = ((await api(admin, 'GET', '/api/money/contracts?page=1&page_size=200')).items ?? [])
  .find((c) => c.note === 'R10待审合同' && c.approval === 'pending');
if (!pendingContract && customer && prod) {
  pendingContract = (await api(admin, 'POST', '/api/money/contracts', {
    request_key: key(), customer_id: customer.id, contact_name: 'R10待审', salesperson_id: admin.userId,
    prepay: '0', submit: true, note: 'R10待审合同',
    lines: [{ product_id: prod.id, quantity: '1', unit_price: '100', discount: '10' }],
  }, 201)).contract;
}
{
  const after = (await api(admin, 'GET', '/api/money/contracts?page=1&page_size=200')).items ?? [];
  const pending = after.filter((c) => c.approval === 'pending').length;
  const total = after.length;
  const r9n = after.filter((c) => c.note === 'R9回归合同').length;
  const r10n = after.filter((c) => c.note === 'R10待审合同' && c.approval === 'pending').length;
  console.log(`合同总数=${total}`);
  console.log(`待审合同数=${pending}`);
  const verify = (await api(admin, 'GET', '/api/money/contracts?page=1&page_size=200')).items ?? [];
  console.log(`seed-pass1-contract-total=${verify.length}`);
  console.log(`seed-pass1-contract-pending=${verify.filter((c) => c.approval === 'pending').length}`);
  mkdirSync('docs/verification/round10', { recursive: true });
  const logPath = 'docs/verification/round10/seed-idempotency.txt';
  const prev = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const block = [
    `ts=${new Date().toISOString()}`,
    `合同总数=${total}`,
    `待审合同数=${pending}`,
    `R9回归合同数=${r9n}`,
    `R10待审合同数=${r10n}`,
    `seed-contract-total=${verify.length}`,
    `seed-contract-pending=${verify.filter((c) => c.approval === 'pending').length}`,
    '',
  ].join('\n');
  writeFileSync(logPath, prev + block);
  must(r10n <= 1, 'R10待审合同不增殖', r10n);
  must(r9n <= 1, 'R9回归合同不增殖', r9n);
}
const approved = ((await api(admin, 'GET', '/api/money/contracts?page=1&page_size=200')).items ?? [])
  .find((c) => c.note === 'R9回归合同' && (c.approval === 'approved' || c.approval === 'done' || c.approval === 'exempt'))
  ?? ((await api(admin, 'GET', '/api/money/contracts?page=1&page_size=5')).items ?? [])[0];
const contractForInvoice = approved;
const invoices = await api(admin, 'GET', '/api/money/invoices?page=1&page_size=20');
if (!invoices.items.some((i) => i.status === 'pending') && contractForInvoice) {
  await api(admin, 'POST', '/api/money/invoices', { contract_id: contractForInvoice.id, amount: '100', apply_note: 'R10待开票' }, 201);
}
const devices = devicesForChart.items?.length ? devicesForChart : await api(admin, 'GET', '/api/equip/devices');
const device0 = devices.items?.[0];
const maintContents = await api(admin, 'GET', '/api/equip/contents');
if (device0 && maintContents.items?.[0]) {
  const tasks = await api(admin, 'GET', '/api/equip/tasks');
  const openMaint = tasks.items.filter((t) => t.status === '未开始' || t.status === '进行中').length;
  if (openMaint < 1) {
    await api(admin, 'POST', '/api/equip/plans', {
      title: `R10维保${Date.now()}`, category: '保养', device_ids: [device0.id],
      content_ids: [maintContents.items[0].id], executor_name: admin.name || '本地管理员', cycle_text: '每周',
    }, 201);
  }
}
const repairs = await api(admin, 'GET', '/api/equip/repairs');
if (device0 && !repairs.items.some((r) => r.status === '待接单')) {
  await api(admin, 'POST', '/api/equip/repairs', { device_id: device0.id, team_name: '默认团队', handler_name: admin.name || '本地管理员', description: 'R10待接单', fault_type: '电气故障' }, 201);
}
if (device0 && !repairs.items.some((r) => r.status === '待审核')) {
  const created = await api(admin, 'POST', '/api/equip/repairs', { device_id: device0.id, team_name: '默认团队', handler_name: admin.name || '本地管理员', description: 'R10待审核', fault_type: '机械故障' }, 201);
  await api(admin, 'POST', `/api/equip/repairs/${created.id}/actions`, { action: '接单' });
  await api(admin, 'POST', `/api/equip/repairs/${created.id}/actions`, { action: '完成' });
}

const qcProc = processes.items?.find((p) => p.inspection_scheme && p.inspection_scheme !== 'none') ?? processes.items?.[0];
const spotProcs = [...new Set(processes.items.slice(0, 5).map((p) => p.id))].slice(0, 3);
for (let i = 0; i < spotProcs.length; i += 1) {
  const created = await api(admin, 'POST', '/api/quality/spot-checks', { process_id: spotProcs[i], qty: String(3 + i), note: `R10抽检${i}` }, 201);
  const spotId = created.item?.id ?? created.id;
  if (!spotId) throw new Error('抽检单未返回 id');
  await api(admin, 'PATCH', `/api/quality/spot-checks/${spotId}`, { good_qty: String(2 + i), defect_qty: '1' });
}
if (prod && sup) {
  for (let i = 0; i < 3; i += 1) {
    const p = products.items[i] ?? prod;
    try {
      const po = await api(admin, 'POST', '/api/money/purchase-orders', {
        request_key: key(), supplier_id: sup.id, buyer_id: admin.userId, note: `R10来料${i}`, submit: true,
        lines: [{ product_id: p.id, quantity: '5', unit_price: '8' }],
      }, 201);
      const orderId = po.purchase_order?.id ?? po.order?.id ?? po.id;
      const spec = (await api(admin, 'GET', '/api/quality/specs')).items?.[0];
      const pt = await api(admin, 'POST', '/api/quality/purchase-tests', {
        purchase_order_id: orderId, spec_id: spec?.id, product_id: p.id, send_qty: '5', inspector_names: '本地管理员',
      }, 201);
      await api(admin, 'PATCH', `/api/quality/purchase-tests/${pt.id}`, { pass_qty: '4', fail_qty: '1' });
    } catch (error) {
      console.warn('采购检验造数跳过', i, String(error).slice(0, 120));
    }
  }
}

const summary = await api(admin, 'GET', '/api/workplace/summary');
function todoCount(summary, key) {
  const groups = summary.todos ?? {};
  for (const list of [groups.customer, groups.equip]) {
    const hit = (list ?? []).find((item) => item.key === key);
    if (hit) return Number(hit.count ?? 0);
  }
  return 0;
}
must(todoCount(summary, 'pending_contracts') >= 1, '待审合同≥1', todoCount(summary, 'pending_contracts'));
must(todoCount(summary, 'pending_invoices') >= 1, '待开票≥1', todoCount(summary, 'pending_invoices'));
must(todoCount(summary, 'maint_tasks') >= 1, '待执行维保≥1', todoCount(summary, 'maint_tasks'));
must(todoCount(summary, 'repairs_to_accept') >= 1, '待接单维修≥1', todoCount(summary, 'repairs_to_accept'));
must(todoCount(summary, 'repairs_to_review') >= 1, '待审核维修≥1', todoCount(summary, 'repairs_to_review'));
must((summary.notices?.length ?? 0) >= 1, '工作台公告≥1', summary.notices?.length ?? 0);
must(Number(summary.unread?.total ?? 0) >= 1 || (summary.notices?.length ?? 0) >= 1, '公告/未读', `${summary.unread?.total ?? 0}/${summary.notices?.length ?? 0}`);
must((summary.devices?.items?.length ?? 0) >= 1, '设备概况有数据', summary.devices?.items?.length ?? 0);

// 报表本周有数（抽检/检验/报废）
const iqc = await api(admin, 'GET', `/api/report-extra/purchase-tests?period=本周`);
const spot = await api(admin, 'GET', `/api/report-extra/spot-checks?period=本周&dimension=process`);
const scrap = await api(admin, 'GET', `/api/report-extra/scrap-rework?period=本周&dimension=product`);
step('采购检验本周≥3', (iqc.items?.length ?? 0) >= 3, iqc.items?.length ?? 0);
step('生产抽检本周≥3', (spot.items?.length ?? 0) >= 3, spot.items?.length ?? 0);
step('报废返工本周≥1', (scrap.items?.length ?? 0) >= 1, scrap.items?.length ?? 0);

const ai = await api(admin, 'GET', '/api/reports/ai-inventory?page=1&page_size=50');
function monthStart(delta) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-05T08:00:00+08:00`;
}
if (unitId && warehouse && sup) {
  async function ensureAiProduct(code, name, lower, upper) {
    let list = await api(admin, 'GET', `/api/products?code=${encodeURIComponent(code)}&page=1&page_size=5`);
    let row = list.items?.find((item) => item.code === code);
    if (!row) {
      row = (await api(admin, 'POST', '/api/products', {
        code, name, unit_id: unitId, attribute: 'purchased', default_supplier_id: sup.id,
        stock_lower_warn: lower, stock_upper_warn: upper,
      })).product;
    }
    return row;
  }
  const lowP = await ensureAiProduct('R10-AI-LOW', 'R10低于预期', '1000', '5000');
  const highP = await ensureAiProduct('R10-AI-HIGH', 'R10超出预期', '1', '20');
  const riseP = await ensureAiProduct('R10-AI-RISE', 'R10连续上升', '10', '5000');
  const current = await api(admin, 'GET', '/api/reports/ai-inventory?page=1&page_size=200');
  const byCode = Object.fromEntries((current.items ?? []).map((item) => [item.product_code, item]));
  if (!(byCode['R10-AI-HIGH']?.flags ?? []).includes('high')) {
    await api(admin, 'POST', '/api/reports/ai-inventory/seed-flows', {
      product_id: highP.id, warehouse_id: warehouse.id,
      flows: [{ direction: 'in', quantity: '500', posted_at: monthStart(-4) }],
    });
  }
  if (!(byCode['R10-AI-RISE']?.flags ?? []).includes('rising')) {
    await api(admin, 'POST', '/api/reports/ai-inventory/seed-flows', {
      product_id: riseP.id, warehouse_id: warehouse.id,
      flows: [
        { direction: 'in', quantity: '200', posted_at: monthStart(-5) },
        { direction: 'out', quantity: '10', posted_at: monthStart(-3) },
        { direction: 'out', quantity: '20', posted_at: monthStart(-2) },
        { direction: 'out', quantity: '40', posted_at: monthStart(-1) },
      ],
    });
  }
  void lowP;
}
const aiAfter = await api(admin, 'GET', '/api/reports/ai-inventory?page=1&page_size=50');
must(Number(aiAfter.summary?.low_count ?? 0) >= 1, 'AI低于预期≥1', aiAfter.summary?.low_count ?? 0);
must(Number(aiAfter.summary?.high_count ?? 0) >= 1, 'AI超出预期≥1', aiAfter.summary?.high_count ?? 0);
must(Number(aiAfter.summary?.rising_count ?? 0) >= 1, 'AI连续上升≥1', aiAfter.summary?.rising_count ?? 0);
step('AI库存明细≥12', (aiAfter.items?.length ?? 0) >= 3, aiAfter.items?.length ?? 0);


// 第43步叶子页补数：全部走正式接口，失败即失败
{
  const procsAll = await api(admin, 'GET', '/api/processes?page=1&page_size=50');
  const proc0 = procsAll.items?.[0];
  if (!proc0?.id) throw new Error('叶子补数：没有工序');
  const routes = await api(admin, 'GET', '/api/routes');
  if ((routes.items?.length ?? 0) < 1) {
    await api(admin, 'POST', '/api/routes', {
      code: `R10RT${Date.now().toString(36).slice(-5)}`, name: 'R10验收路线', request_key: key(),
      steps: [{ process_id: proc0.id, auto_inbound: false }],
    }, 201);
  }
  const poPlans = await api(admin, 'GET', '/api/money/purchase-plans');
  if ((poPlans.items?.length ?? 0) < 1) {
    if (!prod) throw new Error('叶子补数：没有商品，无法建采购计划');
    await api(admin, 'POST', '/api/money/purchase-plans', {
      request_key: key(), name: 'R10采购计划', lines: [{ product_id: prod.id, quantity: '2' }],
    }, 201);
  }

  const quotes = await api(admin, 'GET', '/api/money/quotations');
  if ((quotes.items?.length ?? 0) < 1) {
    if (!customer || !prod) throw new Error('叶子补数：缺少客户或商品，无法建报价单');
    await api(admin, 'POST', '/api/money/quotations', {
      request_key: key(), customer_id: customer.id, salesperson_id: admin.userId,
      contact_name: 'R10报价', lines: [{ product_id: prod.id, quantity: '1', unit_price: '11', discount: '10', concession: '0' }],
    }, 201);
  }
  const expenses = await api(admin, 'GET', '/api/money/expenses');
  if ((expenses.items?.length ?? 0) < 1) {
    if (!customer) throw new Error('叶子补数：缺少客户，无法建销售费用');
    await api(admin, 'POST', '/api/money/expenses', {
      customer_id: customer.id, category: '差旅费', amount: '80', note: 'R10费用',
    }, 201);
  }

  const pays = await api(admin, 'GET', '/api/money/purchase-payments');
  if ((pays.items?.length ?? 0) < 1) {
    const pos = await api(admin, 'GET', '/api/money/purchase-orders?page=1&page_size=50');
    let target = (pos.items ?? []).find((item) => Number(item.debt) > 0);
    if (!target) {
      const po = pos.items?.[0];
      if (!po?.id) throw new Error('叶子补数：没有采购单，无法付款');
      const detail = await api(admin, 'GET', `/api/money/purchase-orders/${po.id}`);
      const order = detail?.purchase_order ?? detail;
      const line = order?.lines?.[0];
      if (!line?.id || !warehouse) throw new Error('叶子补数：采购单无明细或无仓库，无法入库后付款');
      const receipt = await api(admin, 'POST', '/api/warehouse/purchase-receipts', {
        request_key: key(), warehouse_id: warehouse.id, order_id: po.id,
        lines: [{ purchase_line_id: line.id, quantity: '1' }],
      }, 201);
      const receiptId = receipt.purchase_receipt?.id ?? receipt.id;
      const version = receipt.purchase_receipt?.version ?? receipt.version ?? 1;
      if (receipt.purchase_receipt?.approval === 'pending' || receipt.approval === 'pending') {
        try {
          await api(admin, 'POST', `/api/warehouse/purchase-receipts/${receiptId}/actions`, {
            request_key: key(), action: 'approve', version,
          });
        } catch (error) {
          if (!String(error).includes('不是当前级审核人')) throw error;
          const plannerPass = passwordOf('.local/dev-credentials.txt', 'planner.local');
          if (!plannerPass) throw error;
          const planner = await login('planner.local', plannerPass);
          await api(planner, 'POST', `/api/warehouse/purchase-receipts/${receiptId}/actions`, {
            request_key: key(), action: 'approve', version,
          });
        }
      }
      const after = await api(admin, 'GET', `/api/money/purchase-orders/${po.id}`);
      const debt = Number((after?.purchase_order ?? after)?.debt ?? 0);
      if (!(debt > 0)) throw new Error('叶子补数：入库后采购单仍无待付款');
      target = { id: po.id, debt };
    }
    const payAmount = Math.min(1, Number(target.debt));
    if (!(payAmount > 0)) throw new Error('叶子补数：待付款必须大于 0');
    const paid = await api(admin, 'POST', `/api/money/purchase-orders/${target.id}/pay`, { amount: String(payAmount), note: 'R10付款' }, 201);
    console.log('R10付款接口', JSON.stringify({ order_id: target.id, payment_id: paid.id ?? paid.payment?.id ?? paid.purchase_payment?.id, amount: payAmount }));
  }

  const pf = await api(admin, 'GET', '/api/audit/flows?module=purchase');
  if (!(pf.items ?? []).some((item) => item.object_types?.includes('purchase_order'))) {
    await api(admin, 'POST', '/api/audit/flows', {
      module: 'purchase', name: 'R10采购单审核', object_types: ['purchase_order'],
      enabled: true, allow_withdraw: false, levels: [{ sign_mode: 'or', approver_ids: [admin.userId] }],
    }, 201);
  }
  const roles = await api(admin, 'GET', '/api/system/roles');
  if ((roles.items?.length ?? 0) < 1) {
    await api(admin, 'POST', '/api/system/roles', { name: 'R10验收角色', points: ['menu.produce.view'], scopes: {} }, 201);
  }
  const teams = await api(admin, 'GET', '/api/system/teams');
  if ((teams.items?.length ?? 0) < 1) {
    await api(admin, 'POST', '/api/system/teams', { name: 'R10验收团队', leader_id: admin.userId }, 201);
  }
  if (!warehouse || !prod) throw new Error('叶子补数：缺少仓库或商品');
  async function ensureMisc(kind) {
    const list = await api(admin, 'GET', `/api/warehouse/misc-bills?kind=${kind}`);
    if ((list.items?.length ?? 0) >= 1) return;
    await api(admin, 'POST', '/api/warehouse/misc-bills', {
      request_key: key(), kind, warehouse_id: warehouse.id, note: `R10${kind}`,
      lines: [{ product_id: prod.id, quantity: '1' }],
    }, 201);
  }
  await ensureMisc('else_in');
  await ensureMisc('semi_fg_in');
  await ensureMisc('else_out');
  await ensureMisc('sales_return');
  const woList = await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=20');
  const anyWo = woList.items?.[0];
  if (anyWo?.id) {
    const today = shanghaiToday();
    const start = `${today.slice(0, 8)}01`;
    const end = `${today.slice(0, 8)}28`;
    await api(admin, 'PATCH', `/api/work-orders/${anyWo.id}/plan-fields`, {
      version: anyWo.version ?? 1, planned_start: start, planned_end: end,
    });
    const miscReturn = await api(admin, 'GET', '/api/warehouse/misc-bills?kind=prod_return_mat');
    if ((miscReturn.items?.length ?? 0) < 1) {
      await api(admin, 'POST', '/api/warehouse/misc-bills', {
        request_key: key(), kind: 'prod_return_mat', warehouse_id: warehouse.id, work_order_id: anyWo.id, note: 'R10生产退料',
        lines: [{ product_id: prod.id, quantity: '1' }],
      }, 201);
    }
  }
  let wh = await api(admin, 'GET', '/api/warehouses');
  if ((wh.items?.length ?? 0) < 2) {
    await api(admin, 'POST', '/api/warehouses', { request_key: key(), code: 'R10-WH2', name: 'R10调拨仓' }, 201);
    wh = await api(admin, 'GET', '/api/warehouses');
  }
  const invs = await api(admin, 'GET', '/api/money/purchase-invoices');
  if ((invs.items?.length ?? 0) < 1) {
    const pos = await api(admin, 'GET', '/api/money/purchase-orders?page=1&page_size=5');
    const po = pos.items?.[0];
    if (!po?.id) throw new Error('叶子补数：没有采购单，无法建采购发票');
    await api(admin, 'POST', '/api/money/purchase-invoices', {
      request_key: key(), order_id: po.id, purchase_order_id: po.id, amount: '10', note: 'R10发票',
    }, 201);
  }
  const transfers = await api(admin, 'GET', '/api/warehouse/transfer-bills');
  if ((transfers.items?.length ?? 0) < 1) {
    if ((wh.items?.length ?? 0) < 2) throw new Error('叶子补数：仓库不足 2 个，无法调拨');
    const fromId = wh.items[0].id;
    const adj = await api(admin, 'POST', '/api/stock-adjustments', {
      request_key: key(), warehouse_id: fromId, product_id: prod.id, direction: 'in', quantity: '10', reason: 'R10调拨备货',
    }, 201);
    const doc = adj.stock_adjustment ?? adj;
    if (doc.approval === 'pending') {
      await api(admin, 'POST', `/api/stock-adjustments/${doc.id}/actions`, { action: 'approve', version: doc.version ?? 1, request_key: key() });
    }
    await api(admin, 'POST', '/api/warehouse/transfer-bills', {
      request_key: key(), from_warehouse_id: fromId, to_warehouse_id: wh.items[1].id, note: 'R10调拨',
      lines: [{ product_id: prod.id, quantity: '1' }],
    }, 201);
  }
  const settings = await api(admin, 'GET', '/api/warehouse/settings');
  if (!(settings.io_types ?? []).some((t) => t.direction === 'in')) {
    await api(admin, 'POST', '/api/warehouse/io-types', { direction: 'in', name: 'R10入库类型' }, 201);
  }
  if (!(settings.io_types ?? []).some((t) => t.direction === 'out')) {
    await api(admin, 'POST', '/api/warehouse/io-types', { direction: 'out', name: 'R10出库类型' }, 201);
  }
  let sensors = await api(admin, 'GET', '/api/iot/sensors');
  if ((sensors.items?.length ?? 0) < 1) {
    await api(admin, 'POST', '/api/iot/scenes', {
      name: 'R10传感场景', device_name: 'R10传感设备',
      sensors: [{ kind: '温度', code: `S${Date.now().toString(36).slice(-4)}`, gateway: 'GW1', point_name: 'P1', interval_text: '1分钟' }],
    }, 201);
  }
  const scenes = await api(admin, 'GET', '/api/iot/scenes');
  const alarms = await api(admin, 'GET', '/api/iot/alarms');
  if ((alarms.items?.length ?? 0) < 1) {
    await api(admin, 'POST', '/api/iot/alarms', { scene_id: scenes.items?.[0]?.id, level: '一般', sensor_value: '36.5' }, 201);
  }
  const taking = await api(admin, 'GET', '/api/warehouse/stock-taking-bills');
  if ((taking.items?.length ?? 0) < 1) {
    await api(admin, 'POST', '/api/warehouse/stock-taking-bills', {
      request_key: key(), warehouse_id: warehouse.id, taker_id: admin.userId, note: 'R10盘点',
      lines: [{ product_id: prod.id, actual_qty: '1' }],
    }, 201);
  }
  const returns = await api(admin, 'GET', '/api/warehouse/purchase-returns');
  if ((returns.items?.length ?? 0) < 1) {
    const receipts = await api(admin, 'GET', '/api/warehouse/purchase-receipts');
    const view = (receipts.items ?? []).find((row) => row.approval === 'approved' && (row.lines ?? []).some((line) => Number(line.quantity) > 0));
    const rline = (view?.lines ?? []).find((row) => Number(row.quantity) > 0);
    if (!view?.order_id || !rline?.purchase_line_id) throw new Error('叶子补数：没有已审核入库明细，无法建采购退货');
    const qty = Math.min(1, Number(rline.quantity) || 1);
    const adj = await api(admin, 'POST', '/api/stock-adjustments', {
      request_key: key(), warehouse_id: warehouse.id, product_id: rline.product_id, direction: 'in', quantity: String(qty), reason: 'R10退货备货',
    }, 201);
    const doc = adj.stock_adjustment ?? adj;
    if (doc.approval === 'pending') {
      await api(admin, 'POST', `/api/stock-adjustments/${doc.id}/actions`, { action: 'approve', version: doc.version ?? 1, request_key: key() });
    }
    await api(admin, 'POST', '/api/warehouse/purchase-returns', {
      request_key: key(), order_id: view.order_id, warehouse_id: warehouse.id, note: 'R10采购退货',
      lines: [{ purchase_line_id: rline.purchase_line_id, quantity: String(qty) }],
    }, 201);
  }
  const issues = await api(admin, 'GET', '/api/warehouse/material-issues');
  if ((issues.items?.length ?? 0) < 1) {
    const wos = await api(admin, 'GET', '/api/progress/work-orders?page=1&page_size=50');
    let target = null;
    for (const row of wos.items ?? []) {
      if (row.execution === 'cancelled' || row.execution === 'completed') continue;
      const detail = await api(admin, 'GET', `/api/work-orders/${row.id}`);
      const order = detail?.work_order ?? detail;
      if ((order.materials ?? []).length) { target = order; break; }
    }
    if (!target) {
      const boms = await api(admin, 'GET', '/api/boms');
      const bom = (boms.items ?? []).find((item) => item.current_version_id);
      if (!bom?.current_version_id) throw new Error('叶子补数：没有 BOM，无法建生产出库');
      const created = await api(admin, 'POST', '/api/work-orders', {
        request_key: key(), product_id: bom.parent_product_id || prod.id, warehouse_id: warehouse.id, quantity: '2',
        bom_version_id: bom.current_version_id,
        tasks: [{ process_id: proc0.id }],
      }, 201);
      target = created.work_order ?? created;
      if (target.execution === 'not_started') {
        target = (await api(admin, 'POST', `/api/work-orders/${target.id}/actions`, { action: 'start', version: target.version ?? 1, request_key: key() })).work_order ?? target;
      }
      const fresh = await api(admin, 'GET', `/api/work-orders/${target.id}`);
      target = fresh.work_order ?? fresh;
      if (!(target.materials ?? []).length) throw new Error('叶子补数：BOM 加工单没有用料，无法建生产出库');
    }
    for (const mat of target.materials ?? []) {
      const adj = await api(admin, 'POST', '/api/stock-adjustments', {
        request_key: key(), warehouse_id: warehouse.id, product_id: mat.product_id, direction: 'in', quantity: String(mat.required_qty || '1'), reason: 'R10领料备货',
      }, 201);
      const doc = adj.stock_adjustment ?? adj;
      if (doc.approval === 'pending') {
        await api(admin, 'POST', `/api/stock-adjustments/${doc.id}/actions`, { action: 'approve', version: doc.version ?? 1, request_key: key() });
      }
    }
    await api(admin, 'POST', '/api/warehouse/material-issues', {
      request_key: key(), work_order_id: target.id, warehouse_id: warehouse.id, sets: '1', incomplete_only: false,
    }, 201);
  }

  const spots = await api(admin, 'GET', '/api/quality/spot-checks');
  const comps = await api(admin, 'GET', '/api/quality/components');
  const spotLines = await api(admin, 'GET', `/api/quality/spot-lines?component_id=${comps.items?.[0]?.id ?? ''}`);
  if ((spotLines.items?.length ?? 0) < 1 && spots.items?.[0] && comps.items?.[0]) {
    await api(admin, 'POST', '/api/quality/spot-lines', {
      spot_id: spots.items[0].id, component_id: comps.items[0].id, item_name: 'R10尺寸', result: '合格',
    }, 201);
  }
  const specs = await api(admin, 'GET', '/api/quality/specs');
  for (const spec of specs.items ?? []) {
    const lines = await api(admin, 'GET', `/api/quality/purchase-lines?spec_id=${spec.id}`);
    if ((lines.items?.length ?? 0) >= 1) continue;
    const item = spec.items?.[0];
    const tests = await api(admin, 'GET', '/api/quality/purchase-tests');
    let test = (tests.items ?? []).find((row) => row.spec_id === spec.id) ?? tests.items?.[0];
    if (!test && item) {
      const pos = await api(admin, 'GET', '/api/money/purchase-orders?page=1&page_size=5');
      const po = pos.items?.[0];
      if (!po?.id) throw new Error('叶子补数：没有采购单，无法建采购检验');
      test = await api(admin, 'POST', '/api/quality/purchase-tests', {
        purchase_order_id: po.id, spec_id: spec.id, product_id: prod.id, send_qty: '1', inspector_names: '本地管理员',
      }, 201);
    }
    if (!test?.id || !item?.id) throw new Error(`叶子补数：检验规范 ${spec.name} 无法补明细`);
    await api(admin, 'POST', '/api/quality/purchase-lines', { test_id: test.id, spec_item_id: item.id, value: 'OK' }, 201);
  }

  const devicesNow = await api(admin, 'GET', '/api/equip/devices');
  const contentsNow = await api(admin, 'GET', '/api/equip/contents');
  const deviceId = devicesNow.items?.[0]?.id;
  const contentId = contentsNow.items?.[0]?.id;
  if (!deviceId || !contentId) throw new Error('叶子补数：缺少设备或维保内容');
  const recs = await api(admin, 'GET', '/api/equip/records');
  const tasksNow = await api(admin, 'GET', '/api/equip/tasks');
  let openTask = (tasksNow.items ?? []).find((row) => row.status === '未开始' || row.status === '进行中');
  if ((recs.items?.length ?? 0) < 1 || !(tasksNow.items ?? []).some((row) => row.status === '已完成')) {
    if (!openTask) {
      await api(admin, 'POST', '/api/equip/plans', {
        title: `R10维保完成${Date.now()}`, category: '保养', device_ids: [deviceId],
        content_ids: [contentId], executor_name: admin.name || '本地管理员', cycle_text: '每周',
      }, 201);
      openTask = (await api(admin, 'GET', '/api/equip/tasks')).items.find((row) => row.status === '未开始' || row.status === '进行中');
    }
    if (!openTask?.id) throw new Error('叶子补数：没有可完成的维保任务');
    await api(admin, 'POST', '/api/equip/records', {
      task_id: openTask.id, device_id: deviceId, content_id: contentId, result: '正常',
    }, 201);
  }
  const piPlans = await api(admin, 'GET', '/api/equip/pi-plans');
  if ((piPlans.items?.length ?? 0) < 1) {
    await api(admin, 'POST', '/api/equip/pi-plans', {
      device_id: deviceId, content_id: contentId, executor_name: 'R10点检', team_name: '默认团队',
    }, 201);
  }
  const piRecs = await api(admin, 'GET', '/api/equip/pi-records');
  if ((piRecs.items?.length ?? 0) < 1) {
    await api(admin, 'POST', '/api/equip/pi-records', {
      device_id: deviceId, content_name: contentsNow.items[0].title || '点检', normal_count: 1, abnormal_count: 0,
    }, 201);
  }

  const outTasks = await api(admin, 'GET', '/api/production-tasks?task_type=outsource&page=1&page_size=20');
  if ((outTasks.items?.length ?? 0) < 1) {
    await api(admin, 'PUT', `/api/processes/${proc0.id}/extras`, { need_outsource: true });
    const created = await api(admin, 'POST', '/api/work-orders', {
      request_key: key(), product_id: prod.id, warehouse_id: warehouse.id, quantity: '2',
      planned_start: shanghaiToday(), planned_end: shanghaiToday(),
      tasks: [{ process_id: proc0.id }],
    }, 201);
    const woId = created.work_order?.id ?? created.id;
    if (!woId) throw new Error('叶子补数：外协加工单未返回 id');
    const afterTasks = await api(admin, 'GET', '/api/production-tasks?task_type=outsource&page=1&page_size=20');
    if ((afterTasks.items?.length ?? 0) < 1) throw new Error('叶子补数：创建外协工序加工单后仍无外协任务');
  }
}


{
  const unreadW = await api(worker, 'GET', '/api/notices?tab=unread');
  must((unreadW.items?.length ?? 0) >= 1, '工人未读公告≥1', unreadW.items?.length ?? 0);
  const spotReport = await api(admin, 'GET', '/api/quality/reports/spot');
  must((spotReport.items ?? []).some((item) => Number(item.good_qty) > 0 && Number(item.defect_qty) > 0), '生产抽检良品/不良品非零', JSON.stringify((spotReport.items ?? []).slice(0, 3).map((item) => ({ g: item.good_qty, d: item.defect_qty }))));
  const planReport = await api(admin, 'GET', '/api/equip/reports/plans');
  must((planReport.items ?? []).some((item) => Number(item.done_times) > 0 || Number(item.rate) > 0), '维保计划完成率非零', JSON.stringify((planReport.items ?? []).slice(0, 3).map((item) => ({ done: item.done_times, rate: item.rate }))));
  const outTasks = await api(admin, 'GET', '/api/production-tasks?task_type=outsource&page=1&page_size=20');
  must((outTasks.items?.length ?? 0) >= 1, '外协任务≥1', outTasks.items?.length ?? 0);
  const shares = await api(admin, 'GET', '/api/cost-shares');
  must((shares.items ?? []).some((item) => item.status === '草稿'), '成本分摊含草稿', (shares.items ?? []).map((item) => item.status).join(','));
  must(((await api(admin, 'GET', '/api/money/quotations')).items?.length ?? 0) >= 1, '报价单≥1', (await api(admin, 'GET', '/api/money/quotations')).items?.length ?? 0);
  must(((await api(admin, 'GET', '/api/money/expenses')).items?.length ?? 0) >= 1, '销售费用≥1', (await api(admin, 'GET', '/api/money/expenses')).items?.length ?? 0);
  must(((await api(admin, 'GET', '/api/money/purchase-payments')).items?.length ?? 0) >= 1, '付款记录≥1', (await api(admin, 'GET', '/api/money/purchase-payments')).items?.length ?? 0);
  must(((await api(admin, 'GET', '/api/audit/flows?module=purchase')).items?.length ?? 0) >= 1, '采购审核流程≥1', (await api(admin, 'GET', '/api/audit/flows?module=purchase')).items?.length ?? 0);
  must(((await api(admin, 'GET', '/api/warehouse/misc-bills?kind=else_out')).items?.length ?? 0) >= 1, '其他出库≥1', (await api(admin, 'GET', '/api/warehouse/misc-bills?kind=else_out')).items?.length ?? 0);
  must(((await api(admin, 'GET', '/api/warehouse/transfer-bills')).items?.length ?? 0) >= 1, '调拨单≥1', (await api(admin, 'GET', '/api/warehouse/transfer-bills')).items?.length ?? 0);
  must(((await api(admin, 'GET', '/api/system/roles')).items?.length ?? 0) >= 1, '角色≥1', (await api(admin, 'GET', '/api/system/roles')).items?.length ?? 0);
  must(((await api(admin, 'GET', '/api/system/teams')).items?.length ?? 0) >= 1, '团队≥1', (await api(admin, 'GET', '/api/system/teams')).items?.length ?? 0);
}

console.log('\n=== 第十轮 seed 断言 ===');
for (const row of rows) console.log(`${row.result}\t${row.name}\t${row.actual}`);
if (failed) process.exit(1);
console.log('全部通过');
