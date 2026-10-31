/**
 * 工作台 18 项重对齐造数。只走正式接口，失败即非 0 退出。
 * 前置：npm run dev:setup && npm run dev
 * 先跑 scripts/seed-screen-pixel.mjs（清残留设计屏并铺生产/设备底数）。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const seeded = spawnSync('node', ['scripts/seed-screen-pixel.mjs'], { stdio: 'inherit', cwd: process.cwd() });
if (seeded.status !== 0) {
  console.error('像素造数失败，工作台造数中止');
  process.exit(seeded.status ?? 1);
}

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
if (!pass) {
  console.error('未读到 admin.local 密码，请先 npm run dev:setup');
  process.exit(1);
}
const key = () => crypto.randomUUID();
const shanghaiDay = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() + offset * 86400000));

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${res.status} ${JSON.stringify(json).slice(0, 180)}`);
  return { csrf: json.csrf_token, cookie };
}

async function api(session, method, path, body) {
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
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function ensureProduct(session, unitId, spec) {
  const list = await api(session, 'GET', `/api/products?code=${encodeURIComponent(spec.code)}&page=1&page_size=5`);
  const found = (list.items ?? []).find((item) => item.code === spec.code);
  if (found) return found;
  return (await api(session, 'POST', '/api/products', {
    code: spec.code,
    name: spec.name,
    unit_id: unitId,
    attribute: 'purchased',
    stock_lower_warn: spec.lower ?? null,
    stock_upper_warn: spec.upper ?? null,
    stale_days: spec.stale_days ?? null,
  })).product;
}

async function onHand(session, code) {
  const bal = await api(session, 'GET', '/api/warehouse/stock/balances?view=product&only_positive=false');
  const row = (bal.items ?? []).find((item) => item.product_code === code);
  return Number(row?.on_hand ?? 0);
}

async function main() {
  const session = await login();
  const units = await api(session, 'GET', '/api/units');
  const unit = units.items?.[0];
  if (!unit?.id) throw new Error('没有计量单位');
  let warehouse = (await api(session, 'GET', '/api/warehouses')).items?.[0];
  if (!warehouse) warehouse = (await api(session, 'POST', '/api/warehouses', { request_key: key(), code: 'WP-WH', name: '工作台验收仓' })).warehouse;

  const low = await ensureProduct(session, unit.id, { code: 'WP-LOW', name: '工作台下限物料', lower: '20', upper: null });
  const high = await ensureProduct(session, unit.id, { code: 'WP-HIGH', name: '工作台上限物料', lower: null, upper: '10' });
  if (await onHand(session, 'WP-HIGH') <= 10) {
    await api(session, 'POST', '/api/warehouse/misc-bills', {
      request_key: key(),
      kind: 'else_in',
      warehouse_id: warehouse.id,
      note: '工作台上限入库',
      lines: [{ product_id: high.id, quantity: '30', unit_price: '1' }],
    });
  }
  if ((await onHand(session, 'WP-HIGH')) <= 10) throw new Error('上限物料入库后存量仍未超过上限');

  const customers = await api(session, 'GET', '/api/money/customers?q=WP-CUS');
  let customer = (customers.items ?? []).find((item) => item.code === 'WP-CUS');
  if (!customer) {
    customer = (await api(session, 'POST', '/api/money/customers', {
      request_key: key(),
      code: 'WP-CUS',
      name: '像素跟单客户',
      contact_name: '王工',
      contact_phone: '13800001111',
    })).customer;
  }
  const detail = customer.contacts ? customer : (await api(session, 'GET', `/api/money/customers/${customer.id}`)).customer;
  const contact = detail.contacts?.[0];
  if (!contact?.id) throw new Error('跟单客户没有联系人');
  const follows = await api(session, 'GET', '/api/customer-follows?keyword=像素跟单回访');
  if (!(follows.items ?? []).some((item) => item.content === '像素跟单回访')) {
    await api(session, 'POST', '/api/customer-follows', {
      customer_id: detail.id,
      contact_id: contact.id,
      follow_type: '电话',
      content: '像素跟单回访',
      next_at: `${shanghaiDay(1)} 10:00`,
    });
  }

  const contracts = await api(session, 'GET', '/api/money/contracts?q=工作台合同');
  let contract = (contracts.items ?? []).find((item) => item.note === '工作台合同');
  if (!contract) {
    contract = (await api(session, 'POST', '/api/money/contracts', {
      request_key: key(),
      customer_id: detail.id,
      prepay: '0',
      note: '工作台合同',
      lines: [{ product_id: low.id, quantity: '2', unit_price: '100', discount: '10', concession: '0' }],
    })).contract;
  }
  if (contract.approval === 'pending') {
    contract = (await api(session, 'POST', `/api/money/contracts/${contract.id}/actions`, { action: 'approve', version: contract.version, opinion: '通过' })).contract;
  }

  let categories = (await api(session, 'GET', '/api/equip/categories')).items ?? [];
  let category = categories.find((item) => item.name === '像素设备类');
  if (!category) category = await api(session, 'POST', '/api/equip/categories', { name: '像素设备类' });
  const categoryId = category.id;
  const devices = (await api(session, 'GET', '/api/equip/devices')).items ?? [];
  const devicePlan = [
    { code: 'WP-RUN', name: '像素运行设备', status: '运行中' },
    { code: 'WP-OK', name: '像素正常设备', status: '正常' },
    { code: 'WP-FIX', name: '像素维修设备', status: '维修中' },
  ];
  const deviceIds = [];
  for (const plan of devicePlan) {
    let row = devices.find((item) => item.code === plan.code);
    if (!row) {
      row = await api(session, 'POST', '/api/equip/devices', {
        code: plan.code, name: plan.name, status: plan.status, category_id: categoryId, owner_name: '管理员', spec: 'WP',
      });
    }
    deviceIds.push(row.id);
  }
  const contents = (await api(session, 'GET', '/api/equip/contents')).items ?? [];
  let content = contents.find((item) => item.title === '像素点检');
  if (!content) content = await api(session, 'POST', '/api/equip/contents', { title: '像素点检', items: [{ name: '外观', field_type: '文本' }] });
  const plans = (await api(session, 'GET', '/api/equip/plans')).items ?? [];
  if (!plans.some((item) => item.title === '像素维保计划')) {
    await api(session, 'POST', '/api/equip/plans', {
      title: '像素维保计划',
      category: '日常',
      device_ids: [deviceIds[0]],
      content_ids: [content.id],
      executor_name: '管理员',
      team_name: '默认团队',
    });
  }

  // 重置为默认可见布局（含库存预警 / 工单执行进度 / 设备概况）
  const cfg = await api(session, 'GET', '/api/workplace/config');
  const defaultKeys = ['tutorial', 'shortcuts', 'todos', 'features', 'notices', 'messages', 'devices', 'stock_alert', 'wo_progress'];
  await api(session, 'PUT', '/api/workplace/config', {
    cards: defaultKeys.map((item) => ({ key: item, visible: true })),
    layout: [],
    shortcuts: cfg.shortcuts,
    todo_prefs: cfg.todo_prefs,
    version: cfg.version,
  });

  const summary = await api(session, 'GET', '/api/workplace/summary');
  const widgets = summary.widgets ?? {};
  const catalog = (await api(session, 'GET', '/api/workplace/config')).card_catalog ?? [];
  const names = catalog.map((item) => item.name);
  const expected = [
    '快捷入口', '3天快速落地教程', '待办事项', '功能上新', '公告', '未读消息',
    '当月维保任务执行概况', '设备概况', '当月不良品分布', '库存预警', '服务工单走势',
    '当月销售业绩排行', '当月跟单排行', '当月产品产量', '呆滞预警', '生产状况统计',
    '工单执行进度', '本月备料建议',
  ];
  const wrong = ['今日报工概况', '工序进度', '合同概况', '跟单提醒', '维保提醒', '报工排行', '设备稼动'];
  const catCount = {
    通用: catalog.filter((item) => item.category === '通用').length,
    工作效率: catalog.filter((item) => item.category === '工作效率').length,
    智能报表: catalog.filter((item) => item.category === '智能报表').length,
  };

  const checks = [
    [catalog.length === 18, `catalog=${catalog.length}`],
    [expected.every((name) => names.includes(name)), `缺名 ${expected.filter((name) => !names.includes(name)).join(',') || '无'}`],
    [wrong.every((name) => !names.includes(name)), `错名残留 ${wrong.filter((name) => names.includes(name)).join(',') || '无'}`],
    [catCount.通用 === 4 && catCount.工作效率 === 2 && catCount.智能报表 === 12, `分类 ${JSON.stringify(catCount)}`],
    [Number(widgets.stock_alert?.lower) >= 1 && Number(widgets.stock_alert?.upper) >= 1, `库存 低${widgets.stock_alert?.lower} 高${widgets.stock_alert?.upper}`],
    [(widgets.wo_progress?.items ?? []).length >= 1 || Number(widgets.production_stats?.total) >= 1, `工单/生产 ${(widgets.wo_progress?.items ?? []).length}/${widgets.production_stats?.total}`],
    [Number(summary.devices?.total) >= 1, `设备 ${summary.devices?.total}`],
    [(widgets.follow_rank?.items ?? []).length >= 1, `跟单排行 ${(widgets.follow_rank?.items ?? []).length}`],
    [(widgets.sales_rank?.items ?? []).length >= 1, `销售排行 ${(widgets.sales_rank?.items ?? []).length}`],
    [Number(widgets.material_suggest?.count) >= 1, `备料 ${widgets.material_suggest?.count}`],
    [Number(widgets.maint_month?.total) >= 1, `维保当月 ${widgets.maint_month?.total}`],
  ];
  let failed = false;
  for (const [ok, actual] of checks) {
    console.log(`${ok ? '通过' : '未通过'}\t${actual}`);
    if (!ok) failed = true;
  }
  if (failed) throw new Error('工作台 18 项造数断言未通过');
  console.log('工作台 18 项重对齐造数完成');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
