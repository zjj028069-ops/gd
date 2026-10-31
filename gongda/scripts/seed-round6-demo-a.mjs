/**
 * 第六轮浏览器验收数据（幂等，可重复执行）。
 * 前置：npm run dev:setup && npm run db:migrate && npm run dev
 */
import { readFileSync } from 'node:fs';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
const key = () => crypto.randomUUID();

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  return { csrf: json.csrf_token, cookie, userId: json.user?.id };
}

async function api(session, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function ensureProduct(session, code, name) {
  const list = await api(session, 'GET', '/api/products?page=1&page_size=100');
  let product = list.items?.find((p) => p.code === code);
  if (!product) {
    const units = await api(session, 'GET', '/api/units');
    const unit = units.items?.[0];
    product = (await api(session, 'POST', '/api/products', {
      code, name, unit_id: unit.id, attribute: 'manufactured',
    })).product;
  }
  return product;
}

async function ensureProcesses(session, names, userId) {
  const existing = (await api(session, 'GET', '/api/processes')).items ?? [];
  const members = (await api(session, 'GET', '/api/team-members')).items ?? [];
  const reporter = members.find((m) => m.display_name?.includes('王文丽'))?.id ?? members[0]?.id;
  const reporters = [...new Set([reporter, userId].filter(Boolean).map(String))];
  const out = [];
  for (const name of names) {
    let proc = existing.find((p) => p.name === name);
    if (!proc) {
      proc = (await api(session, 'POST', '/api/processes', {
        code: `P6-${name.slice(0, 2)}`,
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


async function main() {
  const session = await login();
  const product = await ensureProduct(session, 'CSFM-A', '测试阀门A');
  const processes = (await ensureProcesses(session, ['下料', '焊接', '喷涂'], session.userId)).sort((a, b) => ['下料', '焊接', '喷涂'].indexOf(a.name) - ['下料', '焊接', '喷涂'].indexOf(b.name));
  let wh = (await api(session, 'GET', '/api/warehouses')).items?.[0];
  if (!wh) {
    wh = (await api(session, 'POST', '/api/warehouses', { request_key: key(), code: 'WH-R6', name: '验收仓' })).warehouse;
  }

  let plan = (await api(session, 'GET', '/api/production-plans?page=1&page_size=50')).items?.find((p) => p.name === '十月阀门计划');
  if (!plan) {
    plan = (await api(session, 'POST', '/api/production-plans', { request_key: key(), name: '十月阀门计划' })).plan;
    await api(session, 'PATCH', `/api/production-plans/${plan.id}`, {
      lines: [{ product_id: product.id, plan_qty: '100', contract_code: 'HT-DEMO', customer_name: '演示客户' }],
    });
    await api(session, 'POST', `/api/production-plans/${plan.id}/analyze`, {});
  }

  const plans = await api(session, 'GET', `/api/production-plans/${plan.id}`);
  const planLineId = plans.plan?.lines?.[0]?.id;
  const analysisLine = plans.plan?.analysis_lines?.[0];

  const createWo = async (qty, label) => {
    const existing = (await api(session, 'GET', `/api/progress/work-orders?code=${encodeURIComponent(label)}&page_size=5`)).items?.[0];
    if (existing) return existing;
    const body = await api(session, 'POST', '/api/work-orders', {
      request_key: key(),
      product_id: product.id,
      quantity: qty,
      warehouse_id: wh.id,
      code: label,
      ...(planLineId ? { production_plan_line_id: planLineId } : {}),
      tasks: processes.map((p) => ({ process_id: p.id, unit_ratio: '1', wage_rate: '0' })),
    });
    return body.work_order;
  };

  const woA = await createWo('100', 'JG-R6-A');
  let woAView = (await api(session, 'GET', `/api/work-orders/${woA.id}`)).work_order;
  if (woAView.execution === 'not_started') {
    woAView = (await api(session, 'POST', `/api/work-orders/${woA.id}/actions`, { action: 'start', version: woAView.version })).work_order;
  }
  const firstTask = woAView.tasks?.[0];
  const reported = (await api(session, 'GET', `/api/production-reports?task_id=${firstTask.id}`)).items?.length;
  if (firstTask && !reported) {
    await api(session, 'POST', '/api/production-reports', {
      request_key: key(),
      task_id: firstTask.id,
      good_qty: '100',
      defect_qty: '0',
      rework_qty: '0',
      scrap_qty: '0',
    });
  }

  const woB = await createWo('50', 'JG-R6-B');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const woBView = (await api(session, 'GET', `/api/work-orders/${woB.id}`)).work_order;
  await api(session, 'PATCH', `/api/work-orders/${woB.id}/plan-fields`, {
    version: woBView.version,
    planned_end: yesterday,
    priority: 'urgent',
    due_date: tomorrow,
  });

  console.log('seed-round6-demo-a 完成', { planId: plan.id, planLineId, analysisLineId: analysisLine?.id, woA: woA.code, woB: woB.code });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
