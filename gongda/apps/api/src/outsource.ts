import type { FastifyInstance } from 'fastify';
import { Problem, type Services } from './services.js';
import { bodyOf, clean, idOf, num, qtyOf, serial, withTenant } from './round8-kit.js';

async function orderView(sql: Parameters<Parameters<typeof withTenant>[3]>[0], id: string) {
  const row = (await sql.query<Record<string, unknown>>(`SELECT o.*, o.plan_qty::text, o.unit_price::text, p.code AS product_code, p.name AS product_name, coalesce(p.specification,'') AS product_spec, coalesce(s.name,'') AS supplier_name, coalesce(u.display_name,'') AS creator_name
    FROM r8_out_orders o JOIN products p ON p.tenant_id=o.tenant_id AND p.id=o.product_id
    LEFT JOIN suppliers s ON s.tenant_id=o.tenant_id AND s.id=o.supplier_id
    LEFT JOIN tenant_team_members u ON u.id=o.created_by WHERE o.id=$1`, [id])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', '外协工单不存在');
  const sums = (await sql.query<{ pass: string; fail: string }>('SELECT coalesce(sum(pass_qty),0)::text AS pass, coalesce(sum(fail_qty),0)::text AS fail FROM r8_os_receipts WHERE order_id=$1', [id])).rows[0]!;
  const accepted = Number(sums.pass) + Number(sums.fail);
  const plan = Number(row.plan_qty) || 0;
  const materials = (await sql.query(`SELECT m.id,m.unit_qty::text,m.note,p.name AS product_name,p.code AS product_code,coalesce(p.specification,'') AS product_spec FROM r8_out_materials m JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id WHERE m.order_id=$1 ORDER BY m.sort_no`, [id])).rows;
  return {
    ...row,
    plan_qty: num(row.plan_qty),
    unit_price: num(row.unit_price),
    accept_qty: num(accepted),
    accept_progress: plan ? `${num(accepted)}/${num(plan)}` : '-',
    materials: materials.map((item) => ({ ...item, unit_qty: num(item.unit_qty) })),
    issue_path: '/production_out_of_storage/add',
    inbound_path: '/produce_stock_in_bill/add',
    return_path: '/produce_return_materiel_bill/add',
  };
}

export function registerOutsource(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);

  app.get('/api/outsource/contents', (request) => read(request, async (sql) => {
    const rows = (await sql.query(`SELECT c.id,c.title,c.note,c.created_at,coalesce(u.display_name,'') AS creator_name FROM r8_os_contents c LEFT JOIN tenant_team_members u ON u.id=c.created_by ORDER BY c.created_at DESC`)).rows;
    const items = [];
    for (const row of rows) {
      const checks = (await sql.query('SELECT id,sort_no,name,field_type,required,description FROM r8_os_content_items WHERE content_id=$1 ORDER BY sort_no', [row.id])).rows;
      items.push({ ...row, items: checks, item_count: checks.length });
    }
    return { items };
  }));
  app.post('/api/outsource/contents', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const title = clean(body.title, 80, '标题', true);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_os_contents(tenant_id,title,note,created_by) VALUES($1,$2,$3,$4) RETURNING id', [actor.tenant_id, title, clean(body.note, 255, '备注'), actor.user_id])).rows[0]!.id;
    const checks = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [];
    let sort = 1;
    for (const item of checks) {
      const field = clean(item.field_type, 20, '字段类型') || '文本';
      if (!['文本', '数字', '是否', '单选'].includes(field)) throw new Problem(422, 'FIELD', '字段类型不正确');
      await sql.query('INSERT INTO r8_os_content_items(tenant_id,content_id,sort_no,name,field_type,required,description) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.tenant_id, id, sort++, clean(item.name, 80, '检查项', true), field, Boolean(item.required), clean(item.description, 255, '检查项说明')]);
    }
    return { id, title };
  })));
  app.delete('/api/outsource/contents/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM r8_os_contents WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '验收内容不存在');
    return { ok: true };
  }));

  app.get('/api/outsource/orders', (request) => read(request, async (sql) => {
    const ids = (await sql.query<{ id: string }>('SELECT id FROM r8_out_orders ORDER BY created_at DESC')).rows;
    const items = [];
    for (const row of ids) items.push(await orderView(sql, row.id));
    const plan = items.reduce((sum, item) => sum + Number(item.plan_qty), 0);
    return { items, summary: { plan_qty: num(plan) } };
  }));
  app.get('/api/outsource/orders/:id', (request) => read(request, async (sql) => ({ order: await orderView(sql, idOf(request)) })));
  app.post('/api/outsource/orders', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const productId = clean(body.product_id, 80, '商品', true, 'select');
    const plan = qtyOf(body.plan_qty, '计划数');
    if (Number(plan) <= 0) throw new Problem(422, 'QTY', '计划数必须大于0');
    const priority = clean(body.priority, 10, '优先级') || '正常';
    if (!['加急', '正常', '延期'].includes(priority)) throw new Problem(422, 'PRIORITY', '优先级只能是加急、正常或延期');
    const code = clean(body.code, 64, '外协工单号') || await serial(sql, actor.tenant_id, 'WX', 'WX');
    const workOrderId = clean(body.work_order_id, 80, '加工单') || null;
    if (workOrderId) {
      const exists = (await sql.query('SELECT id FROM work_orders WHERE id=$1', [workOrderId])).rows[0];
      if (!exists) throw new Problem(404, 'NOT_FOUND', '加工单不存在');
    }
    const id = (await sql.query<{ id: string }>(`INSERT INTO r8_out_orders(tenant_id,code,product_id,plan_qty,supplier_id,contact_name,address,unit_price,due_date,priority,plan_start,plan_end,note,created_by,work_order_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [
      actor.tenant_id, code, productId, plan, clean(body.supplier_id, 80, '供应商') || null, clean(body.contact_name, 80, '联系人'), clean(body.address, 200, '地址'),
      clean(body.unit_price, 40, '外协单价') || '0', clean(body.due_date, 10, '交货日期') || null, priority, clean(body.plan_start, 10, '计划开始') || null, clean(body.plan_end, 10, '计划结束') || null, clean(body.note, 255, '备注'), actor.user_id, workOrderId,
    ])).rows[0]!.id;
    return { order: await orderView(sql, id) };
  })));
  app.patch('/api/outsource/orders/:id', (request) => write(request, async (sql) => {
    const body = bodyOf(request);
    const current = (await sql.query<{ status: string }>('SELECT status FROM r8_out_orders WHERE id=$1', [idOf(request)])).rows[0];
    if (!current) throw new Problem(404, 'NOT_FOUND', '外协工单不存在');
    if (current.status === '已取消') throw new Problem(409, 'STATE', '已取消的外协工单不能修改');
    const priority = clean(body.priority, 10, '优先级') || '正常';
    if (!['加急', '正常', '延期'].includes(priority)) throw new Problem(422, 'PRIORITY', '优先级只能是加急、正常或延期');
    await sql.query(`UPDATE r8_out_orders SET product_id=$2,plan_qty=$3,supplier_id=$4,contact_name=$5,address=$6,unit_price=$7,due_date=$8,priority=$9,plan_start=$10,plan_end=$11,note=$12 WHERE id=$1`, [
      idOf(request), clean(body.product_id, 80, '商品', true, 'select'), qtyOf(body.plan_qty, '计划数'), clean(body.supplier_id, 80, '供应商') || null, clean(body.contact_name, 80, '联系人'), clean(body.address, 200, '地址'),
      clean(body.unit_price, 40, '外协单价') || '0', clean(body.due_date, 10, '交货日期') || null, priority, clean(body.plan_start, 10, '计划开始') || null, clean(body.plan_end, 10, '计划结束') || null, clean(body.note, 255, '备注'),
    ]);
    return { order: await orderView(sql, idOf(request)) };
  }));
  app.post('/api/outsource/orders/:id/materials', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_out_materials(tenant_id,order_id,product_id,unit_qty,note) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, idOf(request), clean(body.product_id, 80, '商品', true, 'select'), qtyOf(body.unit_qty ?? '1', '单位用量'), clean(body.note, 200, '备注')])).rows[0]!.id;
    return { id };
  })));
  app.post('/api/outsource/orders/:id/actions', (request) => write(request, async (sql, actor) => {
    const action = clean(bodyOf(request).action, 20, '操作', true);
    const row = (await sql.query<{ id: string; status: string; product_id: string; plan_qty: string; supplier_id: string | null; contact_name: string; address: string; unit_price: string; priority: string; note: string }>('SELECT id,status,product_id,plan_qty::text,supplier_id,contact_name,address,unit_price::text,priority,note FROM r8_out_orders WHERE id=$1 FOR UPDATE', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '外协工单不存在');
    if (action === '开始') {
      if (row.status !== '未开始') throw new Problem(409, 'STATE', '只有未开始的外协工单可以开始');
      await sql.query("UPDATE r8_out_orders SET status='生产中',started_at=now() WHERE id=$1", [row.id]);
    } else if (action === '完成') {
      if (row.status !== '生产中') throw new Problem(409, 'STATE', '只有生产中的外协工单可以完成');
      await sql.query("UPDATE r8_out_orders SET status='已完成',finished_at=now() WHERE id=$1", [row.id]);
    } else if (action === '取消') {
      if (!['未开始', '生产中'].includes(row.status)) throw new Problem(409, 'STATE', '当前状态不能取消');
      await sql.query("UPDATE r8_out_orders SET status='已取消',cancel_reason=$2 WHERE id=$1", [row.id, clean(bodyOf(request).reason, 200, '取消原因', true)]);
    } else if (action === '复制') {
      const code = await serial(sql, actor.tenant_id, 'WX', 'WX');
      const id = (await sql.query<{ id: string }>('INSERT INTO r8_out_orders(tenant_id,code,product_id,plan_qty,supplier_id,contact_name,address,unit_price,priority,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [actor.tenant_id, code, row.product_id, row.plan_qty, row.supplier_id, row.contact_name, row.address, row.unit_price, row.priority, row.note, actor.user_id])).rows[0]!.id;
      await sql.query('INSERT INTO r8_out_materials(tenant_id,order_id,product_id,unit_qty,note,sort_no) SELECT tenant_id,$2,product_id,unit_qty,note,sort_no FROM r8_out_materials WHERE order_id=$1', [row.id, id]);
      return { order: await orderView(sql, id) };
    } else throw new Problem(422, 'ACTION', '不支持的操作');
    return { order: await orderView(sql, row.id) };
  }));

  app.get('/api/outsource/receipts', (request) => read(request, async (sql) => {
    const items = (await sql.query<Record<string, string>>(`SELECT r.id,r.pass_qty::text,r.fail_qty::text,r.note,r.settle_status,r.settle_amount::text,r.settled_at,r.accepted_at,o.code AS order_code,o.status AS order_status,o.unit_price::text,o.contact_name,o.address,
      p.name AS product_name,p.code AS product_code,coalesce(p.specification,'') AS product_spec,coalesce(s.name,'') AS supplier_name,coalesce(c.title,'') AS content_title,coalesce(u.display_name,'') AS inspector_name
      FROM r8_os_receipts r JOIN r8_out_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id
      JOIN products p ON p.tenant_id=o.tenant_id AND p.id=o.product_id
      LEFT JOIN suppliers s ON s.tenant_id=o.tenant_id AND s.id=o.supplier_id
      LEFT JOIN r8_os_contents c ON c.tenant_id=r.tenant_id AND c.id=r.content_id
      LEFT JOIN tenant_team_members u ON u.id=r.accepted_by
      ORDER BY r.accepted_at DESC`)).rows.map((row) => ({
      ...row,
      pass_qty: num(row.pass_qty), fail_qty: num(row.fail_qty), unit_price: num(row.unit_price), settle_amount: num(row.settle_amount),
      accept_qty: num(Number(row.pass_qty) + Number(row.fail_qty)),
      kind: '工单外协',
    } as Record<string, string>));
    const open = items.filter((item) => item.settle_status === '未结算');
    const recent = items.filter((item) => item.settle_status === '已结算' && item.settled_at && Date.now() - new Date(String(item.settled_at)).getTime() <= 30 * 86400000);
    return {
      items,
      cards: {
        unsettled_count: open.length,
        unsettled_amount: num(open.reduce((sum, item) => sum + Number(item.pass_qty) * Number(item.unit_price), 0)),
        recent_count: recent.length,
        recent_amount: num(recent.reduce((sum, item) => sum + Number(item.settle_amount), 0)),
      },
      summary: {
        accept: num(items.reduce((sum, item) => sum + Number(item.accept_qty), 0)),
        pass: num(items.reduce((sum, item) => sum + Number(item.pass_qty), 0)),
        fail: num(items.reduce((sum, item) => sum + Number(item.fail_qty), 0)),
      },
    };
  }));
  app.post('/api/outsource/receipts', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const order = (await sql.query<{ id: string; status: string; plan_qty: string }>('SELECT id,status,plan_qty::text FROM r8_out_orders WHERE id=$1 FOR UPDATE', [clean(body.order_id, 80, '外协工单', true, 'select')])).rows[0];
    if (!order) throw new Problem(422, 'ORDER', '外协工单不存在');
    if (!['生产中', '已完成'].includes(order.status)) throw new Problem(409, 'STATE', '外协工单开始后才能验收');
    const pass = qtyOf(body.pass_qty, '合格数量');
    const fail = qtyOf(body.fail_qty, '不合格数量');
    if (Number(pass) + Number(fail) <= 0) throw new Problem(422, 'QTY', '验收数量必须大于0');
    const used = Number((await sql.query<{ n: string }>('SELECT coalesce(sum(pass_qty+fail_qty),0)::text AS n FROM r8_os_receipts WHERE order_id=$1', [order.id])).rows[0]!.n);
    if (used + Number(pass) + Number(fail) > Number(order.plan_qty) + 1e-6) throw new Problem(422, 'OVER', '验收数量不能超过计划数');
    const id = (await sql.query<{ id: string }>('INSERT INTO r8_os_receipts(tenant_id,order_id,pass_qty,fail_qty,content_id,note,accepted_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [actor.tenant_id, order.id, pass, fail, clean(body.content_id, 80, '验收内容') || null, clean(body.note, 255, '备注'), actor.user_id])).rows[0]!.id;
    return { id };
  })));
  app.post('/api/outsource/receipts/:id/settle', (request) => write(request, async (sql, actor) => {
    const row = (await sql.query<{ id: string; settle_status: string; pass_qty: string; unit_price: string }>('SELECT r.id,r.settle_status,r.pass_qty::text,o.unit_price::text FROM r8_os_receipts r JOIN r8_out_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id WHERE r.id=$1 FOR UPDATE OF r', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '验收记录不存在');
    if (row.settle_status === '已结算') throw new Problem(409, 'STATE', '已经结算');
    const amount = num(Number(row.pass_qty) * Number(row.unit_price));
    await sql.query("UPDATE r8_os_receipts SET settle_status='已结算',settle_amount=$2,settled_by=$3,settled_at=now() WHERE id=$1", [row.id, amount, actor.user_id]);
    return { id: row.id, settle_status: '已结算', settle_amount: amount };
  }));
  app.delete('/api/outsource/receipts/:id', (request) => write(request, async (sql) => {
    const row = (await sql.query<{ settle_status: string }>('SELECT settle_status FROM r8_os_receipts WHERE id=$1', [idOf(request)])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '验收记录不存在');
    if (row.settle_status === '已结算') throw new Problem(409, 'STATE', '已结算只能打印');
    await sql.query('DELETE FROM r8_os_receipts WHERE id=$1', [idOf(request)]);
    return { ok: true };
  }));
}
