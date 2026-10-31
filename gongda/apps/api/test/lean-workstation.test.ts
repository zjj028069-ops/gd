import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

let db: Database, app: FastifyInstance;
const tenant = randomUUID(), admin = randomUUID();
const password = 'Lean-Workstation-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let session: Login;

const headers = (write = false) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });
async function call(method: string, url: string, body?: unknown, expected = 200) {
  const response = await app.inject({ method, url, headers: headers(method !== 'GET'), payload: body });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function shiftIso(iso: string, days: number) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async (sql) => {
    await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenant, 'lean-ws', '工作站']);
    await sql.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [admin, 'lean.ws', '工作站管理员', hash]);
    await sql.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, admin]);
  });
  app = await createApp(db, { localEventsWorker: false });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.41', payload: { tenant_slug: 'lean-ws', username: 'lean.ws', password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  session = { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, csrf: response.json().csrf_token };
});
after(async () => { await app?.close(); await db?.close(); });

test('工作站按日期、部门和黑榜工序返回整页数据', async () => {
  const parent = randomUUID();
  const child = randomUUID();
  const other = randomUUID();
  const processId = randomUUID();
  await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => {
    await sql.query('INSERT INTO departments(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [parent, tenant, 'BM-P', '生产管理部']);
    await sql.query('INSERT INTO departments(id,tenant_id,code,name,parent_id) VALUES($1,$2,$3,$4,$5)', [child, tenant, 'BM-C', '生产一部', parent]);
    await sql.query('INSERT INTO departments(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [other, tenant, 'BM-A', '售后部']);
    await sql.query('INSERT INTO processes(id,tenant_id,code,name,standard_minutes) VALUES($1,$2,$3,$4,1)', [processId, tenant, 'RCL', '热处理']);
  });

  const bare = await call('GET', '/api/lean/workstation?from=2026-02-10&to=2026-02-10&grain=每天');
  assert.deepEqual(bare.trend.series.map((item: { name: string }) => item.name), ['现场巡查', '生产质检', '售后反馈', '客户投诉', '设计问题', '物料问题']);
  assert.equal(bare.trend.buckets.length, 28);
  assert.equal(bare.trend.buckets[0].key, '2026-02-01');
  assert.equal(bare.trend.buckets.at(-1).key, '2026-02-28');
  for (const item of bare.trend.series) assert.equal(item.points.length, 28);
  assert.deepEqual(bare.boards.map((item: { name: string }) => item.name), ['质量黑榜', '热处理黑榜', '焊接黑榜', '硬化处理黑榜', '机械加工黑榜', '防腐处理黑榜', '铸造/锻造黑榜']);
  for (const board of bare.boards.slice(1)) assert.deepEqual(board.items, []);

  const months = await call('GET', '/api/lean/workstation?from=2026-02-10&to=2026-03-02&grain=每月');
  assert.deepEqual(months.trend.buckets.map((item: { key: string }) => item.key), ['2026-02', '2026-03']);
  assert.equal(months.trend.series[0].points.length, 2);

  const today = shanghaiToday();
  const yesterday = shiftIso(today, -1);
  const fresh = await call('POST', '/api/lean/patrols', { department_name: '生产一部', category: '生产问题', description: '今天的巡查' }, 201);
  const stale = await call('POST', '/api/lean/patrols', { department_name: '售后部', category: '卫生问题', description: '昨天的巡查' }, 201);
  await db.tenant({ tenantId: tenant, userId: admin }, async (sql) => {
    await sql.query(`UPDATE r8_patrols SET created_at = ($2::date + time '12:00') AT TIME ZONE 'Asia/Shanghai' WHERE id=$1`, [stale.id, yesterday]);
  });
  const todayRows = await call('GET', `/api/lean/workstation?from=${today}&to=${today}`);
  assert.ok(todayRows.patrols.some((row: { description: string }) => row.description === '今天的巡查'));
  assert.equal(todayRows.patrols.some((row: { description: string }) => row.description === '昨天的巡查'), false);
  const yesterdayRows = await call('GET', `/api/lean/workstation?from=${yesterday}&to=${yesterday}`);
  assert.ok(yesterdayRows.patrols.some((row: { description: string }) => row.description === '昨天的巡查'));
  assert.equal(yesterdayRows.patrols.some((row: { description: string }) => row.description === '今天的巡查'), false);

  const scoped = await call('GET', `/api/lean/workstation?from=${today}&to=${today}&department_id=${child}`);
  assert.ok(scoped.patrols.some((row: { description: string }) => row.description === '今天的巡查'));
  assert.equal(scoped.patrols.some((row: { description: string }) => row.description === '昨天的巡查'), false);
  const parentScope = await call('GET', `/api/lean/workstation?from=${today}&to=${today}&department_id=${parent}`);
  assert.ok(parentScope.patrols.some((row: { description: string }) => row.description === '今天的巡查'));

  const complaint = await call('POST', '/api/lean/complaints', { customer_name: '华北客户', contact_name: '周工', phone: '13800000000', content: '尺寸超差', analysis: '复测', department_name: '生产一部', owner_names: '工作站管理员', product_name: '阀体', photos: '现场.png' }, 201);
  const listed = await call('GET', `/api/lean/workstation?from=${today}&to=${today}&department_id=${child}`);
  const row = listed.complaints.find((item: { id: string }) => item.id === complaint.id);
  assert.ok(row);
  assert.equal(row.product_name, '阀体');
  assert.equal(row.photos, '现场.png');
  assert.equal(row.customer_name, '华北客户');
  assert.equal(row.phone, '13800000000');
  const hidden = await call('GET', `/api/lean/workstation?from=${today}&to=${today}&department_id=${other}`);
  assert.equal(hidden.complaints.some((item: { id: string }) => item.id === complaint.id), false);
  await call('DELETE', `/api/lean/complaints/${complaint.id}`);
  const gone = await call('GET', `/api/lean/workstation?from=${today}&to=${today}`);
  assert.equal(gone.complaints.some((item: { id: string }) => item.id === complaint.id), false);

  const design = await call('POST', '/api/lean/designs', { product_name: '泵壳', description: '图纸缺孔', photos: '设计.png' }, 201);
  const material = await call('POST', '/api/lean/materials', { product_name: '螺栓', description: '来料生锈', photos: '物料.png' }, 201);
  const issues = await call('GET', `/api/lean/workstation?from=${today}&to=${today}`);
  assert.equal(issues.designs.find((item: { id: string }) => item.id === design.id).description, '图纸缺孔');
  assert.equal(issues.materials.find((item: { id: string }) => item.id === material.id).photos, '物料.png');
  await call('DELETE', `/api/lean/designs/${design.id}`);
  await call('DELETE', `/api/lean/materials/${material.id}`);

  const meeting = await call('POST', '/api/lean/meetings', { title: '周例会', content: '质量', meet_at: `${today}T09:00`, form: '线下会议', member_names: '工作站管理员', place: '一楼', related: '阀体' }, 201);
  const openMeetings = await call('GET', `/api/lean/workstation?from=${today}&to=${today}`);
  const created = openMeetings.meetings.find((item: { id: string }) => item.id === meeting.id);
  assert.equal(created.landed, '未落地');
  assert.equal(created.progress, '-');
  assert.equal(created.related, '阀体');
  await call('POST', `/api/lean/meetings/${meeting.id}/agendas`, { description: '落地项', status: '已落地' }, 201);
  const landed = await call('GET', `/api/lean/workstation?from=${today}&to=${today}`);
  const done = landed.meetings.find((item: { id: string }) => item.id === meeting.id);
  assert.equal(done.landed, '已落地');
  assert.equal(done.progress, '100% (1/1)');

  await call('PUT', '/api/lean/settings', { block_wage: false, joint_duty: true, board_process_ids: [processId], board_limit: 10, department_ids: [], daily_push: false, daily_push_time: '', agenda_warn_days: 0, meeting_remind_minutes: 5 });
  const configured = await call('GET', '/api/lean/workstation?from=2026-02-10&to=2026-02-10');
  assert.deepEqual(configured.boards.map((item: { name: string }) => item.name), ['质量黑榜', '热处理黑榜']);

  assert.equal(fresh.id.length > 0, true);
});

test('工作站拒绝不合法的日期和粒度', async () => {
  await call('GET', '/api/lean/workstation?from=2026-02-31&to=2026-02-31', undefined, 422);
  await call('GET', '/api/lean/workstation?from=2026-02-01&to=2026-02-02&grain=每小时', undefined, 422);
  await call('GET', '/api/lean/workstation?department_id=not-a-uuid', undefined, 422);
});
