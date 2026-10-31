import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Database, type Sql } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

// 来源：缁禾PD00003当前BOM与50件历史领料相符，只证明用量样例。
// 损耗加成、版本快照、租户隔离是本项目已约定规则，不冒充原系统交易验收。
let db: Database;
let app: FastifyInstance;
const tenantA = randomUUID(), tenantB = randomUUID();
const admin = randomUUID(), planner = randomUUID(), worker = randomUUID();
const foreignMember = randomUUID(), inactiveMember = randomUUID(), disabledUser = randomUUID();
const unitA = randomUUID(), unitB = randomUUID();
const foreignProduct = randomUUID();
const password = 'MasterData-TestOnly-LongPassword!';
type Login = { cookie: string; csrf: string };
let a: Login, b: Login, w: Login, p: Login;
const headers = (session: Login, write = false) => ({ cookie: session.cookie, ...(write ? { 'x-csrf-token': session.csrf } : {}) });
const code = (prefix: string) => prefix + '-' + randomUUID().slice(0, 8);
async function login(slug: string, username = 'master.admin'): Promise<Login> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant_slug: slug, username, password } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers['set-cookie'];
  const cookie = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(cookie);
  return { cookie: cookie.split(';')[0]!, csrf: response.json().csrf_token };
}
async function post(url: string, payload: unknown, session = a, expected = 201) {
  const response = await app.inject({ method: 'POST', url, headers: headers(session, true), payload });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function get(url: string, session = a, expected = 200) {
  const response = await app.inject({ url, headers: headers(session) });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}
async function product(name: string, attribute = 'purchased') {
  return (await post('/api/products', { code: code('PD'), name, unit_id: unitA, attribute })).product;
}
async function process(name = '下料') {
  return (await post('/api/processes', { code: code('GX'), name, description: '测试工序', standard_minutes: '2.5', reporter_ids: [worker] })).process;
}
async function route(steps: { process_id: string; auto_inbound: boolean }[], name = '路线第一版') {
  return (await post('/api/routes', { code: code('RT'), name, description: '快照测试', steps })).route;
}
async function bom(parentId: string, items: unknown[], extra: Record<string, unknown> = {}) {
  return (await post('/api/boms', { parent_product_id: parentId, description: '测试BOM', items, ...extra })).bom;
}
async function auditFor(id: string) {
  return (await get('/api/audit-events')).items.filter((event: { entity_id: string }) => event.entity_id === id);
}
async function rejectAudit<T>(work: () => Promise<T>) {
  await db.admin(sql => sql.exec("CREATE FUNCTION reject_master_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$; CREATE TRIGGER reject_master_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_master_audit()"));
  try { return await work(); }
  finally { await db.admin(sql => sql.exec('DROP TRIGGER reject_master_audit ON audit_events; DROP FUNCTION reject_master_audit()')); }
}
async function getBomSnapshotForSql(sql: Sql, versionId: string) {
  return (await sql.query<{ parent_snapshot: unknown }>('SELECT parent_snapshot FROM bom_versions WHERE id=$1', [versionId])).rows[0]!.parent_snapshot;
}
function requirementsByProduct(result: { requirements: { product_id: string; quantity: string }[] }) {
  const entries = result.requirements.map(item => [item.product_id, item.quantity] as const);
  assert.equal(new Set(entries.map(([id]) => id)).size, entries.length, '同一叶物料必须合并为一行');
  return Object.fromEntries(entries);
}

before(async () => {
  db = new Database({ mode: 'pglite' });
  await migrate(db);
  const hash = await hashPassword(password);
  await db.admin(async sql => {
    for (const [id, slug] of [[tenantA, 'master-a'], [tenantB, 'master-b']]) {
      await sql.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [id, slug, slug]);
    }
    for (const [id, username] of [[admin, 'master.admin'], [planner, 'master.planner'], [worker, 'master.worker'], [foreignMember, 'master.foreign'], [inactiveMember, 'master.inactive'], [disabledUser, 'master.disabled']]) {
      await sql.query('INSERT INTO users(id,username,display_name,password_hash,active) VALUES($1,$2,$3,$4,$5)', [id, username, username, hash, id !== disabledUser]);
    }
    for (const tenant of [tenantA, tenantB]) await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenant, admin, 'admin']);
    for (const [id, role, active] of [[planner, 'planner', true], [worker, 'worker', true], [inactiveMember, 'worker', false], [disabledUser, 'worker', true]]) {
      await sql.query('INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,$3,$4)', [tenantA, id, role, active]);
    }
    await sql.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenantB, foreignMember, 'worker']);
    for (const [id, tenant] of [[unitA, tenantA], [unitB, tenantB]]) await sql.query('INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,$3,$4)', [id, tenant, 'EA', '个']);
    await sql.query('INSERT INTO products(id,tenant_id,code,name,unit_id,attribute) VALUES($1,$2,$3,$4,$5,$6)', [foreignProduct, tenantB, 'FOREIGN', '其他企业物料', unitB, 'manufactured']);
  });
  app = await createApp(db);
  a = await login('master-a'); b = await login('master-b');
  w = await login('master-a', 'master.worker'); p = await login('master-a', 'master.planner');
});
after(async () => { await app?.close(); await db?.close(); });

test('单位企业内编码唯一、可编辑版本及停用；旧版本不覆盖新修改', async () => {
  const unitCode = code('UN');
  const first = (await post('/api/units', { code: unitCode, name: '米' })).unit;
  assert.equal(first.version, 1);
  await post('/api/units', { code: unitCode, name: '重复米' }, a, 409);
  await post('/api/units', { code: unitCode, name: '企业B米' }, b);
  const result = await app.inject({ method: 'PATCH', url: '/api/units/' + first.id, headers: headers(a, true), payload: { version: 1, name: '长度米', active: false } });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().unit.version, 2); assert.equal(result.json().unit.active, false);
  const stale = await app.inject({ method: 'PATCH', url: '/api/units/' + first.id, headers: headers(a, true), payload: { version: 1, name: '过期覆盖', active: true } });
  assert.equal(stale.statusCode, 409);
  const saved = await db.tenant({ tenantId: tenantA, userId: admin }, sql => sql.query('SELECT name,version,active FROM units WHERE id=$1', [first.id]));
  assert.deepEqual(saved.rows[0], { name: '长度米', version: 2, active: false });
  assert.equal((await auditFor(first.id)).length, 2);
});

test('已启用产品引用的单位不能停用，跨企业单位ID不能修改', async () => {
  const local = (await post('/api/units', { code: code('USED'), name: '件' })).unit;
  await post('/api/products', { code: code('REFER'), name: '启用产品', unit_id: local.id, attribute: 'purchased' });
  const blocked = await app.inject({ method: 'PATCH', url: '/api/units/' + local.id, headers: headers(a, true), payload: { version: 1, name: '件', active: false } });
  assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().error.code, 'UNIT_IN_USE');
  assert.equal((await auditFor(local.id)).length, 1);
  const foreign = await app.inject({ method: 'PATCH', url: '/api/units/' + unitB, headers: headers(a, true), payload: { version: 1, name: '越权', active: false } });
  assert.equal(foreign.statusCode, 404);
});

test('工序允许空生产人员；停用/外企用户均不能加入', async () => {
  const members = (await get('/api/team-members')).items;
  assert.ok(members.some((member: { id: string }) => member.id === worker));
  for (const id of [foreignMember, inactiveMember, disabledUser]) assert.ok(!members.some((member: { id: string }) => member.id === id));
  const base = { code: code('BADGX'), name: '工序', standard_minutes: '0.1', reporter_ids: [worker] };
  // WHY: Round11 intentional API contract — masters.ts allows empty reporter_ids so craft forms can create a process then assign reporters later. Still assert 停用/外企 cannot be added.
  const empty = await post('/api/processes', { ...base, code: code('EMPTYGX'), reporter_ids: [] }, a, 201);
  assert.deepEqual(empty.process.reporter_ids, []);
  for (const id of [foreignMember, inactiveMember, disabledUser, randomUUID()]) await post('/api/processes', { ...base, code: code('BADGX'), reporter_ids: [id] }, a, 422);
  const valid = (await post('/api/processes', base, p)).process;
  assert.equal(valid.standard_minutes, '0.100000');
  assert.deepEqual(valid.reporter_ids, [worker]);
  await post('/api/processes', base, a, 409);
});

test('工序修改带版本校验，拒绝修改编码、跨企业ID与跨企业人员', async () => {
  const local = await process('原始下料');
  const payload = { version: 1, name: '新版下料', description: '新描述', standard_minutes: '3.25', reporter_ids: [worker, planner], active: true };
  const updated = await app.inject({ method: 'PATCH', url: '/api/processes/' + local.id, headers: headers(a, true), payload });
  assert.equal(updated.statusCode, 200, updated.body); assert.equal(updated.json().process.version, 2);
  assert.equal(updated.json().process.standard_minutes, '3.250000');
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/processes/' + local.id, headers: headers(a, true), payload })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/processes/' + local.id, headers: headers(a, true), payload: { ...payload, version: 2, code: 'RECODE' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/processes/' + local.id, headers: headers(a, true), payload: { ...payload, version: 2, reporter_ids: [foreignMember] } })).statusCode, 422);
  const other = (await post('/api/processes', { code: code('BX'), name: 'B工序', standard_minutes: '1', reporter_ids: [foreignMember] }, b)).process;
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/processes/' + other.id, headers: headers(a, true), payload })).statusCode, 404);
});

test('路线增版保留旧工序名称/授权/自动入库快照；冲突无第三版', async () => {
  const cutting = await process('旧下料名称');
  const welding = await process('焊接');
  const first = await route([{ process_id: cutting.id, auto_inbound: true }]);
  const frozen = await get('/api/route-versions/' + first.current_version_id);
  assert.equal(frozen.steps.length, 1);
  assert.match(JSON.stringify(frozen.steps), /旧下料名称/);
  assert.match(JSON.stringify(frozen.steps), new RegExp(worker));
  assert.equal(frozen.steps[0].auto_inbound, true);
  const edited = await app.inject({ method: 'PATCH', url: '/api/processes/' + cutting.id, headers: headers(a, true), payload: { version: 1, name: '已改下料名称', description: '', standard_minutes: '9', reporter_ids: [planner], active: true } });
  assert.equal(edited.statusCode, 200, edited.body);
  const input = { expected_version: 1, name: '路线第二版', description: '新路线', steps: [{ process_id: cutting.id, auto_inbound: false }, { process_id: welding.id, auto_inbound: true }] };
  const second = (await post('/api/routes/' + first.id + '/versions', input)).route;
  assert.equal(second.version, 2); assert.notEqual(second.current_version_id, first.current_version_id);
  assert.deepEqual(await get('/api/route-versions/' + first.current_version_id), frozen);
  const current = await get('/api/route-versions/' + second.current_version_id);
  assert.equal(current.steps.length, 2); assert.equal(current.steps[0].auto_inbound, false);
  assert.match(JSON.stringify(current.steps), /已改下料名称/);
  await post('/api/routes/' + first.id + '/versions', input, a, 409);
  assert.equal((await auditFor(first.id)).length, 2);
});

test('BOM50件展开与当前BOM历史领料样例一致，保留精确六位字符串', async () => {
  const parent = await product('三层焊接餐车', 'manufactured');
  const steel = await product('201钢板'); const caster = await product('脚轮'); const board = await product('密度板');
  const created = await bom(parent.id, [{ component_product_id: steel.id, quantity: '1.03' }, { component_product_id: caster.id, quantity: '2' }, { component_product_id: board.id, quantity: '1' }]);
  const result = await get('/api/boms/' + created.id + '/explosion?quantity=50&version_id=' + created.current_version_id);
  assert.deepEqual(requirementsByProduct(result), { [steel.id]: '51.500000', [caster.id]: '100.000000', [board.id]: '50.000000' });
});

test('BOM损耗按暂定加成策略、多层共同叶合并并固定子BOM版本', async () => {
  const leaf = await product('共同叶料'); const child = await product('子装配', 'manufactured'); const parent = await product('主装配', 'manufactured');
  const childBom = await bom(child.id, [{ component_product_id: leaf.id, quantity: '1.03' }]);
  const top = await bom(parent.id, [{ component_product_id: child.id, quantity: '2', component_bom_version_id: childBom.current_version_id }, { component_product_id: leaf.id, quantity: '3' }]);
  const old = await get('/api/boms/' + top.id + '/explosion?quantity=50');
  assert.deepEqual(requirementsByProduct(old), { [leaf.id]: '253.000000' });
  const revised = (await post('/api/boms/' + childBom.id + '/versions', { expected_version: 1, description: '', items: [{ component_product_id: leaf.id, quantity: '4' }] })).bom;
  assert.equal(revised.version, 2);
  assert.deepEqual(await get('/api/boms/' + top.id + '/explosion?quantity=50'), old);
  const lossParent = await product('损耗样例', 'manufactured');
  const withLoss = await bom(lossParent.id, [{ component_product_id: leaf.id, quantity: '0.2', loss_rate: '0.1' }]);
  assert.deepEqual(requirementsByProduct(await get('/api/boms/' + withLoss.id + '/explosion?quantity=3')), { [leaf.id]: '0.660000' });
});

test('BOM数量超出JavaScript安全小数区间仍不丢微量，拒绝非法数量', async () => {
  const parent = await product('大数量样例', 'manufactured'); const leaf = await product('微量材料');
  const created = await bom(parent.id, [{ component_product_id: leaf.id, quantity: '1' }]);
  assert.deepEqual(requirementsByProduct(await get('/api/boms/' + created.id + '/explosion?quantity=900719925474.099301')), { [leaf.id]: '900719925474.099301' });
  for (const quantity of ['-1', 'NaN', '0.0000001']) await get('/api/boms/' + created.id + '/explosion?quantity=' + quantity, a, 400);
  const zeroExpansion = await get('/api/boms/' + created.id + '/explosion?quantity=0', a, 422);
  assert.equal(zeroExpansion.error.code, 'DECIMAL_RANGE');
  const otherParent = await product('非法用量', 'manufactured');
  const zeroItem = await post('/api/boms', { parent_product_id: otherParent.id, items: [{ component_product_id: leaf.id, quantity: '0' }] }, a, 422);
  assert.equal(zeroItem.error.code, 'DECIMAL_RANGE');
  for (const quantity of ['-1', 'NaN', '1.0000001']) await post('/api/boms', { parent_product_id: otherParent.id, items: [{ component_product_id: leaf.id, quantity }] }, a, 400);
});

test('BOM同父可多主档、修改用乐观版本，旧物料/单位名称保持快照', async () => {
  const parent = await product('父产品旧名', 'manufactured'); const leaf = await product('材料旧名');
  const first = await bom(parent.id, [{ component_product_id: leaf.id, quantity: '1.03' }]);
  const frozen = await get('/api/bom-versions/' + first.current_version_id);
  assert.match(JSON.stringify(frozen), /材料旧名/);
  // WHY: Round11 migration 096_r11_forms.sql dropped UNIQUE(tenant,parent) so one product may have multiple BOMs; only is_default stays unique. Not relaxing — asserting the intentional multi-BOM contract while keeping optimistic version + snapshot checks.
  const sibling = await post('/api/boms', { parent_product_id: parent.id, name: '同父第二BOM', items: [{ component_product_id: leaf.id, quantity: '2' }] }, a, 201);
  assert.equal(sibling.bom.parent_product_id, parent.id);
  assert.notEqual(sibling.bom.id, first.id);
  const amended = await app.inject({ method: 'PATCH', url: '/api/products/' + leaf.id, headers: headers(a, true), payload: { version: 1, name: '材料新名', specification: '', unit_id: unitA, attribute: 'purchased', active: true } });
  assert.equal(amended.statusCode, 200, amended.body);
  const renamedParent = await app.inject({ method: 'PATCH', url: '/api/products/' + parent.id, headers: headers(a, true), payload: { version: 1, name: '父产品新名', specification: '', unit_id: unitA, attribute: 'manufactured', active: true } });
  assert.equal(renamedParent.statusCode, 200, renamedParent.body);
  const renamedUnit = await app.inject({ method: 'PATCH', url: '/api/units/' + unitA, headers: headers(a, true), payload: { version: 1, name: '新单位名称', active: true } });
  assert.equal(renamedUnit.statusCode, 200, renamedUnit.body);
  assert.deepEqual(await get('/api/bom-versions/' + first.current_version_id), frozen);
  const input = { expected_version: 1, description: '第二版', items: [{ component_product_id: leaf.id, quantity: '2' }] };
  const second = (await post('/api/boms/' + first.id + '/versions', input)).bom;
  assert.equal(second.version, 2);
  assert.deepEqual(await get('/api/bom-versions/' + first.current_version_id), frozen);
  assert.match(JSON.stringify(await get('/api/bom-versions/' + second.current_version_id)), /材料新名/);
  await post('/api/boms/' + first.id + '/versions', input, a, 409);
  assert.equal((await auditFor(first.id)).length, 2);
});

test('BOM直接自引用与跨版本父产品祖先重复返回BOM_CYCLE', async () => {
  const parent = await product('自引用产品', 'manufactured');
  const direct = await post('/api/boms', { parent_product_id: parent.id, items: [{ component_product_id: parent.id, quantity: '1' }] }, a, 422);
  assert.equal(direct.error.code, 'BOM_CYCLE');
  const leaf = await product('循环叶料'); const child = await product('循环B', 'manufactured'); const topProduct = await product('循环A', 'manufactured');
  const childBom = await bom(child.id, [{ component_product_id: leaf.id, quantity: '1' }]);
  const top = await bom(topProduct.id, [{ component_product_id: child.id, quantity: '1', component_bom_version_id: childBom.current_version_id }]);
  const cyclic = await post('/api/boms/' + childBom.id + '/versions', { expected_version: 1, items: [{ component_product_id: topProduct.id, quantity: '1', component_bom_version_id: top.current_version_id }] }, a, 422);
  assert.equal(cyclic.error.code, 'BOM_CYCLE');
  assert.equal((await auditFor(childBom.id)).length, 1);
});

test('BOM跨企业产品/版本/工序及投料路线不匹配均拒绝，失败无主档', async () => {
  const parent = await product('关联校验父', 'manufactured'); const leaf = await product('关联校验材料');
  const localProcess = await process(); const otherProcess = await process('其他工序');
  const localRoute = await route([{ process_id: localProcess.id, auto_inbound: false }]);
  const foreignProc = (await post('/api/processes', { code: code('FGX'), name: '外企工序', standard_minutes: '1', reporter_ids: [foreignMember] }, b)).process;
  const foreignRoute = (await post('/api/routes', { code: code('FRT'), name: '外企路线', steps: [{ process_id: foreignProc.id, auto_inbound: false }] }, b)).route;
  const foreignBom = (await post('/api/boms', { parent_product_id: foreignProduct, items: [{ component_product_id: (await post('/api/products', { code: code('FC'), name: '外企组件', unit_id: unitB, attribute: 'purchased' }, b)).product.id, quantity: '1' }] }, b)).bom;
  const base = { parent_product_id: parent.id, route_version_id: localRoute.current_version_id, items: [{ component_product_id: leaf.id, quantity: '1' }] };
  const invalid = [
    { ...base, parent_product_id: foreignProduct },
    { ...base, route_version_id: foreignRoute.current_version_id },
    { ...base, items: [{ component_product_id: foreignProduct, quantity: '1' }] },
    { ...base, items: [{ component_product_id: leaf.id, quantity: '1', component_bom_version_id: foreignBom.current_version_id }] },
    { ...base, items: [{ component_product_id: leaf.id, quantity: '1', feeding_process_id: foreignProc.id }] },
    { ...base, items: [{ component_product_id: leaf.id, quantity: '1', auto_issue: true }] },
    { ...base, items: [{ component_product_id: leaf.id, quantity: '1', feeding_process_id: otherProcess.id, auto_issue: true }] },
  ];
  for (const payload of invalid) await post('/api/boms', payload, a, 422);
  const accepted = await bom(parent.id, [{ component_product_id: leaf.id, quantity: '1', feeding_process_id: localProcess.id, auto_issue: true }], { route_version_id: localRoute.current_version_id });
  const detail = await get('/api/bom-versions/' + accepted.current_version_id);
  assert.equal(detail.items[0].auto_issue, true);
  await get('/api/route-versions/' + foreignRoute.current_version_id, a, 404);
  await get('/api/bom-versions/' + foreignBom.current_version_id, a, 404);
  await get('/api/boms/' + foreignBom.id + '/explosion?quantity=1', a, 404);
});

test('工人不能写基础资料；跨企业工序不能建路线；匿名不能读新主数据', async () => {
  const localProcess = await process(); const parent = await product('权限测试父', 'manufactured'); const leaf = await product('权限测试子');
  const inputs: [string, unknown][] = [
    ['/api/units', { code: code('WU'), name: '工人单位' }],
    ['/api/processes', { code: code('WG'), name: '工人工序', standard_minutes: '1', reporter_ids: [worker] }],
    ['/api/routes', { code: code('WR'), name: '工人路线', steps: [{ process_id: localProcess.id, auto_inbound: false }] }],
    ['/api/boms', { parent_product_id: parent.id, items: [{ component_product_id: leaf.id, quantity: '1' }] }],
  ];
  for (const [url, payload] of inputs) await post(url, payload, w, 403);
  const foreignProc = (await post('/api/processes', { code: code('FG'), name: '不可使用工序', standard_minutes: '1', reporter_ids: [foreignMember] }, b)).process;
  await post('/api/routes', { code: code('BADRT'), name: '越权路线', steps: [{ process_id: foreignProc.id, auto_inbound: false }] }, a, 422);
  for (const url of ['/api/units', '/api/processes', '/api/routes', '/api/boms', '/api/team-members']) assert.equal((await app.inject({ url })).statusCode, 401);
  for (const [url, payload] of inputs) await post(url, { ...(payload as object), tenant_id: tenantB }, a, 400);
});

test('审计失败回滚单位/工序/路线主档以及BOM新版本全部子项', async () => {
  const localProcess = await process(); const parent = await product('回滚父', 'manufactured'); const leaf = await product('回滚子');
  const first = await bom(parent.id, [{ component_product_id: leaf.id, quantity: '1' }]);
  const frozen = await get('/api/bom-versions/' + first.current_version_id);
  const failures = [
    { url: '/api/units', key: 'units', input: { code: code('FAILU'), name: '审计失败单位' } },
    { url: '/api/processes', key: 'processes', input: { code: code('FAILG'), name: '审计失败工序', standard_minutes: '1', reporter_ids: [worker] } },
    { url: '/api/routes', key: 'process_routes', input: { code: code('FAILR'), name: '审计失败路线', steps: [{ process_id: localProcess.id, auto_inbound: false }] } },
  ];
  for (const failure of failures) {
    await rejectAudit(async () => { await post(failure.url, failure.input, a, 500); });
    const rows = await db.tenant({ tenantId: tenantA, userId: admin }, sql => sql.query('SELECT id FROM ' + failure.key + ' WHERE code=$1', [failure.input.code]));
    assert.equal(rows.rows.length, 0, failure.key + '不能半提交');
  }
  await rejectAudit(async () => { await post('/api/boms/' + first.id + '/versions', { expected_version: 1, items: [{ component_product_id: leaf.id, quantity: '3' }] }, a, 500); });
  assert.deepEqual(await get('/api/bom-versions/' + first.current_version_id), frozen);
  assert.equal((await auditFor(first.id)).length, 1);
  // 重试相同expected_version仍成功，说明失败没有偷增父版本。
  const recovered = (await post('/api/boms/' + first.id + '/versions', { expected_version: 1, items: [{ component_product_id: leaf.id, quantity: '2' }] })).bom;
  assert.equal(recovered.version, 2);
});


test('两个相同路线版本请求仅生成一个新版本，另一个返回409', async () => {
  const gx = await process('版本竞争工序');
  const initial = await route([{ process_id: gx.id, auto_inbound: false }]);
  const payload = { expected_version: 1, name: '版本竞争新名称', description: '', steps: [{ process_id: gx.id, auto_inbound: true }] };
  const results = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/routes/' + initial.id + '/versions', headers: headers(a, true), payload })));
  assert.deepEqual(results.map(response => response.statusCode).sort(), [201, 409]);
  const success = results.find(response => response.statusCode === 201)!;
  assert.equal(success.json().route.version, 2);
  assert.equal((await auditFor(initial.id)).length, 2);
});


test('全部新增8表缺租户上下文返回零行，有上下文只返回本企业', async () => {
  const tables = ['processes', 'process_reporters', 'process_routes', 'route_versions', 'route_steps', 'bom_definitions', 'bom_versions', 'bom_items'];
  await db.admin(async sql => {
    await sql.exec('SET LOCAL ROLE gd_tenant');
    for (const table of tables) assert.equal((await sql.query('SELECT tenant_id FROM ' + table)).rows.length, 0, table + '缺上下文必须为空');
  });
  await db.tenant({ tenantId: tenantA, userId: admin }, async sql => {
    for (const table of tables) {
      const rows = (await sql.query<{ tenant_id: string }>('SELECT tenant_id FROM ' + table)).rows;
      assert.ok(rows.length > 0, table + '已有本企测试数据');
      assert.ok(rows.every(row => row.tenant_id === tenantA), table + '不能读取他企数据');
    }
  });
});

test('gd_tenant不能UPDATE或DELETE路线/BOM历史版本与子项', async () => {
  const ctx = { tenantId: tenantA, userId: admin };
  for (const table of ['route_versions', 'route_steps', 'bom_versions', 'bom_items']) {
    const own = await db.tenant(ctx, sql => sql.query<{ id: string }>('SELECT id FROM ' + table + ' LIMIT 1'));
    assert.ok(own.rows[0], table + '需要真实版本记录');
    const id = own.rows[0].id;
    await assert.rejects(db.tenant(ctx, sql => sql.query('UPDATE ' + table + ' SET tenant_id=tenant_id WHERE id=$1', [id])), { code: '42501' }, table + '不能修改');
    await assert.rejects(db.tenant(ctx, sql => sql.query('DELETE FROM ' + table + ' WHERE id=$1', [id])), { code: '42501' }, table + '不能删除');
  }
});

test('数据库直接跨企业写工序/路线/BOM子项由RLS、复合外键或封存拒绝', async () => {
  const ownProcess = await process('SQL本企工序');
  const ownRoute = await route([{ process_id: ownProcess.id, auto_inbound: false }]);
  const ownParent = await product('SQL本企父', 'manufactured'); const ownLeaf = await product('SQL本企子');
  const ownBom = await bom(ownParent.id, [{ component_product_id: ownLeaf.id, quantity: '1' }]);
  const otherProcess = (await post('/api/processes', { code: code('SQLB'), name: 'SQL外企工序', standard_minutes: '1', reporter_ids: [foreignMember] }, b)).process;
  const otherRoute = (await post('/api/routes', { code: code('SQLR'), name: 'SQL外企路线', steps: [{ process_id: otherProcess.id, auto_inbound: false }] }, b)).route;
  const otherParent = (await post('/api/products', { code: code('SQLP'), name: 'SQL外企父', unit_id: unitB, attribute: 'manufactured' }, b)).product;
  const otherLeaf = (await post('/api/products', { code: code('SQLC'), name: 'SQL外企子', unit_id: unitB, attribute: 'purchased' }, b)).product;
  const otherBom = (await post('/api/boms', { parent_product_id: otherParent.id, items: [{ component_product_id: otherLeaf.id, quantity: '1' }] }, b)).bom;
  const ctx = { tenantId: tenantA, userId: admin };
  const beforeA = await get('/api/bom-versions/' + ownBom.current_version_id);
  const beforeB = await get('/api/bom-versions/' + otherBom.current_version_id, b);
  const forbidden: [string, unknown[]][] = [
    ['INSERT INTO processes(tenant_id,code,name) VALUES($1,$2,$3)', [tenantB, code('FORGED'), '越权工序']],
    ['INSERT INTO process_routes(tenant_id,code,name) VALUES($1,$2,$3)', [tenantB, code('FORGED'), '越权路线']],
    ['INSERT INTO route_steps(tenant_id,version_id,sequence,process_id,auto_inbound,process_snapshot) VALUES($1,$2,99,$3,false,$4::jsonb)', [tenantB, otherRoute.current_version_id, otherProcess.id, '{}']],
    ['INSERT INTO bom_items(tenant_id,version_id,sequence,component_product_id,unit_id,quantity,component_snapshot) VALUES($1,$2,99,$3,$4,1,$5::jsonb)', [tenantB, otherBom.current_version_id, otherLeaf.id, unitB, '{}']],
  ];
  for (const [statement, params] of forbidden) await assert.rejects(db.tenant(ctx, sql => sql.query(statement, params)), { code: '42501' });
  const crossReferences: [string, unknown[]][] = [
    ['INSERT INTO process_reporters(tenant_id,process_id,user_id) VALUES($1,$2,$3)', [tenantA, ownProcess.id, foreignMember]],
    ['INSERT INTO route_steps(tenant_id,version_id,sequence,process_id,process_snapshot) VALUES($1,$2,99,$3,$4::jsonb)', [tenantA, ownRoute.current_version_id, otherProcess.id, '{}']],
    ['INSERT INTO route_steps(tenant_id,version_id,sequence,process_id,process_snapshot) VALUES($1,$2,99,$3,$4::jsonb)', [tenantA, otherRoute.current_version_id, ownProcess.id, '{}']],
    ['INSERT INTO bom_items(tenant_id,version_id,sequence,component_product_id,unit_id,quantity,component_snapshot) VALUES($1,$2,99,$3,$4,1,$5::jsonb)', [tenantA, ownBom.current_version_id, otherLeaf.id, unitA, '{}']],
    ['INSERT INTO bom_items(tenant_id,version_id,sequence,component_product_id,unit_id,quantity,component_snapshot) VALUES($1,$2,99,$3,$4,1,$5::jsonb)', [tenantA, ownBom.current_version_id, ownLeaf.id, unitB, '{}']],
    ['INSERT INTO bom_items(tenant_id,version_id,sequence,component_product_id,unit_id,quantity,component_snapshot) VALUES($1,$2,99,$3,$4,1,$5::jsonb)', [tenantA, otherBom.current_version_id, ownLeaf.id, unitA, '{}']],
  ];
  for (const [statement, params] of crossReferences) await assert.rejects(db.tenant(ctx, sql => sql.query(statement, params)), (error: unknown) => ['23503', '23514'].includes((error as { code: string }).code));
  // 未封存的新版本中，插入跨企业组件/工序仍由复合外键本身拒绝。
  await assert.rejects(db.tenant(ctx, async sql => {
    const version = (await sql.query<{ id: string }>('INSERT INTO route_versions(tenant_id,route_id,revision,name_snapshot) VALUES($1,$2,2,$3) RETURNING id', [tenantA, ownRoute.id, '未封存外键检验'])).rows[0]!;
    await sql.query('INSERT INTO route_steps(tenant_id,version_id,sequence,process_id,process_snapshot) VALUES($1,$2,1,$3,$4::jsonb)', [tenantA, version.id, otherProcess.id, '{}']);
  }), { code: '23503' });
  await assert.rejects(db.tenant(ctx, async sql => {
    const frozen = await getBomSnapshotForSql(sql, ownBom.current_version_id);
    const version = (await sql.query<{ id: string }>('INSERT INTO bom_versions(tenant_id,bom_id,revision,parent_snapshot) VALUES($1,$2,2,$3::jsonb) RETURNING id', [tenantA, ownBom.id, JSON.stringify(frozen)])).rows[0]!;
    await sql.query('INSERT INTO bom_items(tenant_id,version_id,sequence,component_product_id,unit_id,quantity,component_snapshot) VALUES($1,$2,1,$3,$4,1,$5::jsonb)', [tenantA, version.id, otherLeaf.id, unitA, '{}']);
  }), { code: '23503' });
  assert.deepEqual(await get('/api/bom-versions/' + ownBom.current_version_id), beforeA);
  assert.deepEqual(await get('/api/bom-versions/' + otherBom.current_version_id, b), beforeB);
});

test('父件改采购后不能追加BOM版本，旧快照可展开且改回制造后可重试', async () => {
  const parent = await product('属性变更父件', 'manufactured'); const leaf = await product('属性变更组件');
  const first = await bom(parent.id, [{ component_product_id: leaf.id, quantity: '1' }]);
  const frozen = await get('/api/bom-versions/' + first.current_version_id);
  const patch = async (version: number, attribute: string) => {
    const result = await app.inject({ method: 'PATCH', url: '/api/products/' + parent.id, headers: headers(a, true), payload: { version, name: '属性变更父件', specification: '', unit_id: unitA, attribute, active: true } });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().product;
  };
  assert.equal((await patch(1, 'purchased')).version, 2);
  const input = { expected_version: 1, items: [{ component_product_id: leaf.id, quantity: '2' }] };
  const rejected = await post('/api/boms/' + first.id + '/versions', input, a, 422);
  assert.equal(rejected.error.code, 'PARENT_NOT_MANUFACTURED');
  const unchanged = await get('/api/boms/' + first.id);
  assert.equal(unchanged.bom.version, 1); assert.equal(unchanged.versions.length, 1);
  assert.equal((await auditFor(first.id)).length, 1);
  assert.deepEqual(await get('/api/bom-versions/' + first.current_version_id), frozen);
  assert.deepEqual(requirementsByProduct(await get('/api/boms/' + first.id + '/explosion?quantity=50')), { [leaf.id]: '50.000000' });
  assert.equal((await patch(2, 'manufactured')).version, 3);
  const recovered = (await post('/api/boms/' + first.id + '/versions', input)).bom;
  assert.equal(recovered.version, 2); assert.notEqual(recovered.current_version_id, first.current_version_id);
  assert.deepEqual(await get('/api/bom-versions/' + first.current_version_id), frozen);
  assert.deepEqual(requirementsByProduct(await get('/api/boms/' + first.id + '/explosion?quantity=50')), { [leaf.id]: '100.000000' });
});

test('BOM十进制文本合同拒绝数值数量与数值损耗，避免JSON浮点提前丢精度', async () => {
  const parent = await product('数值型BOM输入父件', 'manufactured'); const leaf = await product('数值型BOM输入组件');
  for (const line of [
    { component_product_id: leaf.id, quantity: 0.1 },
    { component_product_id: leaf.id, quantity: '1', loss_rate: 0.1 },
  ]) {
    const result = await app.inject({ method: 'POST', url: '/api/boms', headers: headers(a, true), payload: { parent_product_id: parent.id, items: [line] } });
    assert.equal(result.statusCode, 400, result.body);
  }
  const boms = await get('/api/boms');
  assert.ok(!boms.items.some((item: { parent_product_id: string }) => item.parent_product_id === parent.id));
});

test('BOM同层微量用量和损耗合并精确乘积后只向上取六位一次', async () => {
  const parent = await product('微量损耗父件', 'manufactured'); const leaf = await product('微量损耗叶料');
  const created = await bom(parent.id, [{ component_product_id: leaf.id, quantity: '0.1', loss_rate: '0.1' }]);
  const expanded = await get('/api/boms/' + created.id + '/explosion?quantity=0.000001');
  assert.deepEqual(requirementsByProduct(expanded), { [leaf.id]: '0.000001' });
  assert.equal(expanded.rounding, 'ceil_6_each_level');
});

test('已提交路线与BOM修订不能补插子项，保存后的快照及算料保持不变', async () => {
  const selectedProcess = await process('封存路线工序');
  const savedRoute = await route([{ process_id: selectedProcess.id, auto_inbound: false }]);
  const parent = await product('封存BOM父件', 'manufactured'); const leaf = await product('封存BOM叶料');
  const savedBom = await bom(parent.id, [{ component_product_id: leaf.id, quantity: '1' }]);
  const routeBefore = await get('/api/route-versions/' + savedRoute.current_version_id);
  const bomBefore = await get('/api/bom-versions/' + savedBom.current_version_id);
  const explosionBefore = await get('/api/boms/' + savedBom.id + '/explosion?quantity=50');
  const ctx = { tenantId: tenantA, userId: admin };
  await assert.rejects(db.tenant(ctx, sql => sql.query('INSERT INTO route_steps(tenant_id,version_id,sequence,process_id,auto_inbound,process_snapshot) VALUES($1,$2,99,$3,false,$4::jsonb)', [tenantA, savedRoute.current_version_id, selectedProcess.id, JSON.stringify({ code: selectedProcess.code, name: selectedProcess.name, standard_minutes: selectedProcess.standard_minutes, reporter_ids: selectedProcess.reporter_ids })])));
  await assert.rejects(db.tenant(ctx, sql => sql.query('INSERT INTO bom_items(tenant_id,version_id,sequence,component_product_id,unit_id,quantity,component_snapshot) VALUES($1,$2,99,$3,$4,1,$5::jsonb)', [tenantA, savedBom.current_version_id, leaf.id, leaf.unit_id, JSON.stringify({ id: leaf.id, code: leaf.code, name: leaf.name, unit_id: leaf.unit_id, unit_name: leaf.unit_name, attribute: leaf.attribute, active: true })])));
  assert.deepEqual(await get('/api/route-versions/' + savedRoute.current_version_id), routeBefore);
  assert.deepEqual(await get('/api/bom-versions/' + savedBom.current_version_id), bomBefore);
  assert.deepEqual(await get('/api/boms/' + savedBom.id + '/explosion?quantity=50'), explosionBefore);
});

test('孤立版本不可提交，当前路线和BOM指针不能倒退以重新开放历史子项', async () => {
  const selectedProcess = await process('版本指针工序');
  const firstRoute = await route([{ process_id: selectedProcess.id, auto_inbound: false }]);
  const secondRoute = (await post('/api/routes/' + firstRoute.id + '/versions', { expected_version: 1, name: '版本指针第二版', steps: [{ process_id: selectedProcess.id, auto_inbound: true }] })).route;
  const parent = await product('版本指针BOM父件', 'manufactured'); const leaf = await product('版本指针BOM叶料');
  const firstBom = await bom(parent.id, [{ component_product_id: leaf.id, quantity: '1' }]);
  const secondBom = (await post('/api/boms/' + firstBom.id + '/versions', { expected_version: 1, items: [{ component_product_id: leaf.id, quantity: '2' }] })).bom;
  const firstBomView = await get('/api/bom-versions/' + firstBom.current_version_id);
  const routeBefore = await get('/api/routes/' + firstRoute.id);
  const bomBefore = await get('/api/boms/' + firstBom.id);
  const ctx = { tenantId: tenantA, userId: admin };
  await assert.rejects(db.tenant(ctx, sql => sql.query('INSERT INTO route_versions(tenant_id,route_id,revision,description,name_snapshot) VALUES($1,$2,99,$3,$4)', [tenantA, firstRoute.id, '', '未发布路线版本'])));
  await assert.rejects(db.tenant(ctx, sql => sql.query('INSERT INTO bom_versions(tenant_id,bom_id,revision,description,parent_snapshot) VALUES($1,$2,99,$3,$4::jsonb)', [tenantA, firstBom.id, '', JSON.stringify(firstBomView.version.parent_snapshot)])));
  await assert.rejects(db.tenant(ctx, sql => sql.query('UPDATE process_routes SET current_version_id=$1,current_revision=1 WHERE id=$2', [firstRoute.current_version_id, firstRoute.id])));
  await assert.rejects(db.tenant(ctx, sql => sql.query('UPDATE bom_definitions SET current_version_id=$1,current_revision=1 WHERE id=$2', [firstBom.current_version_id, firstBom.id])));
  assert.deepEqual(await get('/api/routes/' + firstRoute.id), routeBefore);
  assert.deepEqual(await get('/api/boms/' + firstBom.id), bomBefore);
  assert.equal(routeBefore.route.current_version_id, secondRoute.current_version_id);
  assert.equal(bomBefore.bom.current_version_id, secondBom.current_version_id);
});


test('子产品单位变化不能隐式把旧子BOM产出单位当成新单位；旧父BOM继续可展开', async () => {
  const alternateUnit = (await post('/api/units', { code: code('MET'), name: '米' })).unit;
  const child = await product('变更单位子装配', 'manufactured'); const leaf = await product('变更单位基础叶料');
  const childBom = await bom(child.id, [{ component_product_id: leaf.id, quantity: '1' }]);
  const oldParent = await product('变更单位历史父件', 'manufactured');
  const oldTop = await bom(oldParent.id, [{ component_product_id: child.id, quantity: '2' }]);
  const oldExpansion = await get('/api/boms/' + oldTop.id + '/explosion?quantity=3');
  const changed = await app.inject({ method: 'PATCH', url: '/api/products/' + child.id, headers: headers(a, true), payload: { version: 1, name: child.name, specification: '', unit_id: alternateUnit.id, attribute: 'manufactured', active: true } });
  assert.equal(changed.statusCode, 200, changed.body);
  const newParent = await product('变更单位新父件', 'manufactured');
  for (const extra of [{}, { component_bom_version_id: childBom.current_version_id }]) {
    const rejected = await post('/api/boms', { parent_product_id: newParent.id, items: [{ component_product_id: child.id, quantity: '2', ...extra }] }, a, 422);
    assert.equal(rejected.error.code, 'BOM_UNIT_MISMATCH');
  }
  assert.deepEqual(await get('/api/boms/' + oldTop.id + '/explosion?quantity=3'), oldExpansion);
  const newChild = (await post('/api/boms/' + childBom.id + '/versions', { expected_version: 1, items: [{ component_product_id: leaf.id, quantity: '1' }] })).bom;
  const compatible = await bom(newParent.id, [{ component_product_id: child.id, quantity: '2' }]);
  const version = await get('/api/bom-versions/' + compatible.current_version_id);
  assert.equal(version.items[0].component_bom_version_id, newChild.current_version_id);
  assert.equal(version.items[0].unit_id, alternateUnit.id);
  assert.deepEqual(requirementsByProduct(await get('/api/boms/' + compatible.id + '/explosion?quantity=3')), { [leaf.id]: '6.000000' });
  assert.deepEqual(await get('/api/boms/' + oldTop.id + '/explosion?quantity=3'), oldExpansion);
});


test('裸路线/BOM主档与伪造修订仍拒绝；空版本主档按 Round11 允许', async () => {
  // WHY: Round11 migration 101_r11_empty_master.sql allows empty route/BOM current versions so forms can create empty masters then fill steps/items. Bare headers and forged revision counters without a matching current_version_id still reject (23514).
  const parent = await product('空主档完整性BOM父件', 'manufactured');
  const ctx = { tenantId: tenantA, userId: admin };
  for (const mode of ['bare', 'forged'] as const) {
    await assert.rejects(db.tenant(ctx, async sql => {
      const header = (await sql.query<{ id: string }>('INSERT INTO process_routes(tenant_id,code,name,current_revision) VALUES($1,$2,$3,$4) RETURNING id', [tenantA, code('EMPTYRT'), '拒绝空路线主档', mode === 'forged' ? 1 : 0])).rows[0]!;
      if (mode !== 'bare') {
        await sql.query('INSERT INTO route_versions(tenant_id,route_id,revision,name_snapshot) VALUES($1,$2,1,$3)', [tenantA, header.id, '拒绝空路线版本']);
      }
    }), { code: '23514' });
    await assert.rejects(db.tenant(ctx, async sql => {
      const header = (await sql.query<{ id: string }>('INSERT INTO bom_definitions(tenant_id,parent_product_id,name,current_revision) VALUES($1,$2,$3,$4) RETURNING id', [tenantA, parent.id, '拒绝空BOM主档', mode === 'forged' ? 1 : 0])).rows[0]!;
      if (mode !== 'bare') {
        await sql.query('INSERT INTO bom_versions(tenant_id,bom_id,revision,parent_snapshot) VALUES($1,$2,1,$3::jsonb)', [tenantA, header.id, JSON.stringify({ id: parent.id, code: parent.code, name: parent.name, unit_id: parent.unit_id, unit_name: parent.unit_name, attribute: parent.attribute, active: true })]);
      }
    }), { code: '23514' });
  }
  const emptyRouteCode = code('OKRT');
  const emptyBomName = '允许空BOM版本-' + emptyRouteCode;
  await db.tenant(ctx, async sql => {
    const route = (await sql.query<{ id: string }>('INSERT INTO process_routes(tenant_id,code,name,current_revision) VALUES($1,$2,$3,0) RETURNING id', [tenantA, emptyRouteCode, '允许空路线版本'])).rows[0]!;
    const routeVersion = (await sql.query<{ id: string }>('INSERT INTO route_versions(tenant_id,route_id,revision,name_snapshot) VALUES($1,$2,1,$3) RETURNING id', [tenantA, route.id, '空路线版本'])).rows[0]!;
    await sql.query('UPDATE process_routes SET current_version_id=$1,current_revision=1 WHERE id=$2', [routeVersion.id, route.id]);
    const bomHeader = (await sql.query<{ id: string }>('INSERT INTO bom_definitions(tenant_id,parent_product_id,name,current_revision) VALUES($1,$2,$3,0) RETURNING id', [tenantA, parent.id, emptyBomName])).rows[0]!;
    const bomVersion = (await sql.query<{ id: string }>('INSERT INTO bom_versions(tenant_id,bom_id,revision,parent_snapshot) VALUES($1,$2,1,$3::jsonb) RETURNING id', [tenantA, bomHeader.id, JSON.stringify({ id: parent.id, code: parent.code, name: parent.name, unit_id: parent.unit_id, unit_name: parent.unit_name, attribute: parent.attribute, active: true })])).rows[0]!;
    await sql.query('UPDATE bom_definitions SET current_version_id=$1,current_revision=1 WHERE id=$2', [bomVersion.id, bomHeader.id]);
  });
  const routes = await get('/api/routes');
  const boms = await get('/api/boms');
  assert.ok(routes.items.some((item: { code: string; steps_count: number }) => item.code === emptyRouteCode && item.steps_count === 0));
  assert.ok(boms.items.some((item: { name: string; items_count: number }) => item.name === emptyBomName && item.items_count === 0));
});
