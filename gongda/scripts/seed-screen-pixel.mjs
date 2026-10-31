/**
 * 数据大屏像素验收造数。只走正式接口，失败即非 0 退出。
 * 前置：npm run dev:setup && npm run dev
 */
import { readFileSync } from 'node:fs';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
if (!pass) {
  console.error('未读到 admin.local 密码，请先 npm run dev:setup');
  process.exit(1);
}
const key = () => crypto.randomUUID();
const day = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() + offset * 86400000));

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json().catch(() => ({}));
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${res.status} ${JSON.stringify(json).slice(0, 180)}`);
  return { csrf: json.csrf_token, cookie, userId: json.user?.id };
}

async function api(session, method, path, body, expect = 0) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok || (expect && res.status !== expect)) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function ensureProduct(session) {
  const list = await api(session, 'GET', '/api/products?page=1&page_size=100');
  let product = list.items?.find((item) => item.code === 'PX-VALVE');
  if (!product) {
    const units = await api(session, 'GET', '/api/units');
    const unit = units.items?.[0];
    if (!unit?.id) throw new Error('没有计量单位');
    product = (await api(session, 'POST', '/api/products', {
      code: 'PX-VALVE', name: '电动蒸汽二通阀', specification: 'MF15-2SGC-S.12', unit_id: unit.id, attribute: 'manufactured',
    })).product;
  }
  return product;
}

async function ensureProcesses(session, members) {
  const names = ['机械加工', '焊接', '热处理'];
  const existing = (await api(session, 'GET', '/api/processes')).items ?? [];
  const reporters = members.map((item) => item.id);
  const out = [];
  for (const name of names) {
    let proc = existing.find((item) => item.name === name);
    if (!proc) {
      proc = (await api(session, 'POST', '/api/processes', {
        code: `PX-${name.slice(0, 2)}`,
        name,
        standard_minutes: '10',
        reporter_ids: reporters,
        pricing_mode: 'piece',
        wage_rate: '0',
      })).process;
    } else {
      const ids = (proc.reporter_ids ?? []).map(String);
      if (reporters.some((id) => !ids.includes(id))) {
        proc = (await api(session, 'PATCH', `/api/processes/${proc.id}`, {
          version: proc.version,
          name: proc.name,
          description: proc.description ?? '',
          standard_minutes: String(proc.standard_minutes),
          reporter_ids: [...new Set([...ids, ...reporters])],
          active: proc.active !== false,
          pricing_mode: proc.pricing_mode ?? 'piece',
          wage_rate: proc.wage_rate,
          inspection_scheme: proc.inspection_scheme ?? 'none',
        })).process;
      }
    }
    out.push(proc);
  }
  return out;
}

async function ensureNamed(session, path, body, match) {
  const list = await api(session, 'GET', path);
  const found = (list.items ?? []).find(match);
  if (found) return found;
  return api(session, 'POST', path, body);
}

async function main() {
  const session = await login();
  const members = (await api(session, 'GET', '/api/team-members')).items ?? [];
  if (!members.length) throw new Error('企业没有成员，无法报工');
  const product = await ensureProduct(session);
  const processes = await ensureProcesses(session, members);
  let warehouse = (await api(session, 'GET', '/api/warehouses')).items?.[0];
  if (!warehouse) warehouse = (await api(session, 'POST', '/api/warehouses', { request_key: key(), code: 'PX-WH', name: '像素验收仓' })).warehouse;

  const shopJing = await ensureNamed(session, '/api/machines/shops', { name: '精工车间' }, (item) => item.name === '精工车间');
  const shopDuan = await ensureNamed(session, '/api/machines/shops', { name: '锻造车间' }, (item) => item.name === '锻造车间');
  const category = await ensureNamed(session, '/api/machines/categories', { name: '机加设备' }, (item) => item.name === '机加设备');
  const shopId = (row) => row.id ?? row.item?.id;
  const machinesPlan = [
    { code: 'PX-CNC', name: '数控车床', spec: 'Ø1000mm', status: '运行中', shop_id: shopId(shopJing) },
    { code: 'PX-MILL', name: '数控铣床', spec: '50~2000rpm', status: '正常', shop_id: shopId(shopDuan) },
    { code: 'PX-DRILL', name: '深孔钻床', spec: '20~1200rpm', status: '维修中', shop_id: shopId(shopDuan) },
    { code: 'PX-LATHE', name: '普通车床', spec: 'Ø500~Ø800mm', status: '正常', shop_id: shopId(shopJing) },
    { code: 'PX-SAW', name: '带锯床', spec: '100~3000rpm', status: '运行中', shop_id: shopId(shopDuan) },
  ];
  const machines = [];
  const currentMachines = (await api(session, 'GET', '/api/machines')).items ?? [];
  for (const plan of machinesPlan) {
    let row = currentMachines.find((item) => item.code === plan.code);
    if (!row) row = await api(session, 'POST', '/api/machines', { ...plan, category_id: category.id ?? category.item?.id, sync_device: false });
    machines.push({ ...plan, id: row.id });
  }

  async function ensureOrder(code, quantity, priority, due) {
    const listed = (await api(session, 'GET', `/api/progress/work-orders?code=${encodeURIComponent(code)}&page_size=5`)).items ?? [];
    let order = listed.find((item) => item.code === code);
    if (!order) {
      order = (await api(session, 'POST', '/api/work-orders', {
        request_key: key(),
        product_id: product.id,
        quantity,
        warehouse_id: warehouse.id,
        code,
        priority,
        due_date: due,
        tasks: processes.map((proc) => ({ process_id: proc.id, unit_ratio: '1', wage_rate: '0' })),
      })).work_order;
    }
    let view = (await api(session, 'GET', `/api/work-orders/${order.id}`)).work_order;
    view = (await api(session, 'PATCH', `/api/work-orders/${order.id}/plan-fields`, {
      version: view.version, priority, due_date: due, note: '像素大屏',
    })).work_order;
    return view;
  }

  const running = await ensureOrder('PX-WO-RUN', '200', 'urgent', day(-2));
  const waiting = await ensureOrder('PX-WO-WAIT', '100', 'none', day(3));
  let started = running;
  if (started.execution === 'not_started') {
    started = (await api(session, 'POST', `/api/work-orders/${running.id}/actions`, { action: 'start', version: running.version })).work_order;
  }
  const task = started.tasks?.[0];
  if (!task) throw new Error('进行中工单没有工序任务');
  const reported = (await api(session, 'GET', `/api/production-reports?task_id=${task.id}&page_size=50`)).items ?? [];
  if (!reported.length) {
    const notes = ['螺纹不良', '开裂起皱', '变形开裂', '烧伤裂纹', '孔位偏移', '氧化', '松动滑销', '毛刺飞边'];
    let index = 0;
    for (const member of members.slice(0, 3)) {
      for (const note of notes.slice(index, index + 2)) {
        const machine = machines[index % 2 === 0 ? 0 : 4];
        await api(session, 'POST', '/api/production-reports', {
          request_key: key(),
          task_id: task.id,
          operator_id: member.id,
          good_qty: String(12 + index * 3),
          defect_qty: String(1 + (index % 3)),
          rework_qty: '0',
          scrap_qty: '0',
          defect_note: note,
          machine_id: machine.id,
        });
        index += 1;
      }
    }
  }
  if (waiting.execution !== 'not_started' && waiting.execution !== 'running' && waiting.execution !== 'paused') {
    throw new Error(`待生产工单状态异常 ${waiting.execution}`);
  }

  let screens = (await api(session, 'GET', '/api/data-screens')).items ?? [];
  const presets = [
    ['生产中控大屏', '默认'],
    ['车间大屏', '四模块'],
    ['机台实时状态', '单模块'],
    ['不良品统计大屏', '左右双模块'],
    ['加工单生产进度', '单模块'],
  ];
  for (const [menu_name, layout] of presets) {
    if (!screens.some((item) => item.menu_name === menu_name)) {
      await api(session, 'POST', '/api/data-screens', { menu_name, layout, module_kind: '生产模块', description: '-', access_password: '' });
    }
  }
  screens = (await api(session, 'GET', '/api/data-screens')).items ?? [];
  for (const [name] of presets) {
    if (!screens.some((item) => item.menu_name === name)) throw new Error(`缺少预置大屏 ${name}`);
  }
  for (const item of screens.filter((row) => row.menu_name === '像素验收设计屏' || row.menu_name === '临时设计验收')) {
    await api(session, 'DELETE', `/api/data-screens/${item.id}`);
  }
  screens = (await api(session, 'GET', '/api/data-screens')).items ?? [];
  if (screens.some((item) => item.menu_name === '像素验收设计屏' || item.menu_name === '临时设计验收')) {
    throw new Error('验收临时大屏删除后仍在列表里');
  }
  const control = screens.find((item) => item.menu_name === '生产中控大屏');
  const machineScreen = screens.find((item) => item.menu_name === '机台实时状态');
  const controlData = await api(session, 'GET', `/api/progress/screen-data/${control.id}`);
  const machineData = await api(session, 'GET', `/api/progress/screen-data/${machineScreen.id}`);
  const checks = [
    [Array.isArray(machineData.machines) && machineData.machines.length >= 1, `机台 ${machineData.machines?.length ?? 0}`],
    [Array.isArray(controlData.work_orders) && controlData.work_orders.length >= 1, `工单 ${controlData.work_orders?.length ?? 0}`],
    [Array.isArray(controlData.employee_defect) && controlData.employee_defect.length >= 1, `人员不良 ${controlData.employee_defect?.length ?? 0}`],
    [Array.isArray(controlData.people_stats) && controlData.people_stats.length >= 1, `人员生产 ${controlData.people_stats?.length ?? 0}`],
    [Array.isArray(controlData.defect_items) && controlData.defect_items.length >= 1, `不良项 ${controlData.defect_items?.length ?? 0}`],
    [Array.isArray(controlData.recent_reports) && controlData.recent_reports.length >= 1, `报工 ${controlData.recent_reports?.length ?? 0}`],
    [!screens.some((item) => item.menu_name === '像素验收设计屏'), '无像素验收设计屏'],
  ];
  let failed = false;
  for (const [ok, actual] of checks) {
    console.log(`${ok ? '通过' : '未通过'}\t${actual}`);
    if (!ok) failed = true;
  }
  if (failed) throw new Error('大屏取数断言未通过');
  console.log('像素大屏造数完成');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
