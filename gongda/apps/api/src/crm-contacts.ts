import type { FastifyInstance } from 'fastify';
import { Problem, type Services } from './services.js';
import { bodyOf, clean, idOf, withTenant } from './round8-kit.js';

function shanghai(value: unknown) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(String(value))).replace('T', ' ');
}

export function registerCrmContacts(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'sales.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'sales.write', work);

  app.get('/api/crm/contacts', (request) => read(request, async (sql) => {
    const q = request.query as Record<string, string>;
    const items = (await sql.query<{ id: string; customer_id: string; customer_name: string; name: string; phone: string; is_default: boolean }>(
      `SELECT c.id,c.customer_id,cu.name AS customer_name,c.name,c.phone,c.is_default
       FROM money_contacts c JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id
       WHERE NOT cu.in_sea
       ORDER BY cu.name, c.is_default DESC, c.created_at`,
    )).rows.filter((row) => {
      const keyword = q.q ?? '';
      if (keyword && ![row.customer_name, row.name, row.phone].some((part) => part.includes(keyword))) return false;
      if (q.customer && !row.customer_name.includes(q.customer)) return false;
      if (q.name && !row.name.includes(q.name)) return false;
      if (q.phone && !row.phone.includes(q.phone)) return false;
      return true;
    });
    return { items: items.map((row) => ({ ...row, phone: row.phone || '-' })) };
  }));

  app.post('/api/crm/contacts', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const customerId = clean(body.customer_id, 80, '客户', true);
    const name = clean(body.name, 80, '联系人', true);
    const phone = clean(body.phone, 20, '联系人电话');
    if (!(await sql.query('SELECT id FROM customers WHERE id=$1 AND NOT in_sea', [customerId])).rows[0]) throw new Problem(422, 'CUSTOMER', '客户不存在');
    const hasDefault = (await sql.query('SELECT 1 FROM money_contacts WHERE customer_id=$1 AND is_default', [customerId])).rows[0];
    const id = (await sql.query<{ id: string }>('INSERT INTO money_contacts(tenant_id,customer_id,name,phone,is_default) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, customerId, name, phone, !hasDefault])).rows[0]!.id;
    return { id };
  })));

  app.patch('/api/crm/contacts/:id', (request) => write(request, async (sql) => {
    const body = bodyOf(request);
    const name = clean(body.name, 80, '联系人', true);
    const phone = clean(body.phone, 20, '联系人电话');
    const row = (await sql.query('UPDATE money_contacts SET name=$2, phone=$3 WHERE id=$1 RETURNING id', [idOf(request), name, phone])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '联系人不存在');
    return { ok: true };
  }));

  app.post('/api/crm/contacts/:id/default', (request) => write(request, async (sql) => {
    const current = (await sql.query<{ customer_id: string }>('SELECT customer_id FROM money_contacts WHERE id=$1', [idOf(request)])).rows[0];
    if (!current) throw new Problem(404, 'NOT_FOUND', '联系人不存在');
    await sql.query('UPDATE money_contacts SET is_default=false WHERE customer_id=$1', [current.customer_id]);
    await sql.query('UPDATE money_contacts SET is_default=true WHERE id=$1', [idOf(request)]);
    return { ok: true };
  }));

  app.delete('/api/crm/contacts/:id', (request) => write(request, async (sql) => {
    const current = (await sql.query<{ id: string; customer_id: string; is_default: boolean }>('SELECT id,customer_id,is_default FROM money_contacts WHERE id=$1', [idOf(request)])).rows[0];
    if (!current) throw new Problem(404, 'NOT_FOUND', '联系人不存在');
    const others = (await sql.query<{ id: string }>('SELECT id FROM money_contacts WHERE customer_id=$1 AND id<>$2 ORDER BY created_at,id', [current.customer_id, current.id])).rows;
    if (!others.length) throw new Problem(422, 'LAST', '客户至少保留一个联系人');
    await sql.query('DELETE FROM money_contacts WHERE id=$1', [current.id]);
    if (current.is_default) await sql.query('UPDATE money_contacts SET is_default=true WHERE id=$1', [others[0]!.id]);
    return { ok: true };
  }));

  app.get('/api/crm/sea', (request) => read(request, async (sql) => {
    const q = request.query as Record<string, string>;
    const items = (await sql.query<Record<string, unknown>>(
      `SELECT c.id,c.code,c.name,c.tags,c.contact_name,c.contact_phone,c.address,c.created_at,
              coalesce(u.display_name,'') AS creator_name
       FROM customers c LEFT JOIN tenant_team_members u ON u.id=c.owner_id
       WHERE c.in_sea ORDER BY c.created_at DESC`,
    )).rows.filter((row) => {
      const text = `${row.code}${row.name}${row.contact_name}${row.contact_phone}${row.address}${(row.tags as string[] | undefined)?.join('') ?? ''}`;
      if (q.q && !text.includes(q.q)) return false;
      return true;
    });
    return { items: items.map((row) => ({ ...row, tags: ((row.tags as string[]) ?? []).join('、') || '-', created_text: shanghai(row.created_at) })) };
  }));

  app.post('/api/crm/sea/:id/claim', (request) => write(request, async (sql, actor) => {
    const row = (await sql.query('UPDATE customers SET in_sea=false, owner_id=$2, version=version+1, updated_at=now() WHERE id=$1 AND in_sea RETURNING id,name', [idOf(request), actor.user_id])).rows[0];
    if (!row) throw new Problem(404, 'NOT_FOUND', '公海客户不存在');
    await sql.query('INSERT INTO customer_sea_logs(tenant_id,customer_id,action,actor_id) VALUES($1,$2,\'领用\',$3)', [actor.tenant_id, idOf(request), actor.user_id]);
    await sql.query('INSERT INTO money_logs(tenant_id,object_type,object_id,message,actor_name) VALUES($1,\'customer\',$2,\'领用成功\',$3)', [actor.tenant_id, idOf(request), actor.display_name]);
    return { ok: true, message: '领用成功' };
  }));

  app.get('/api/crm/price-rules', (request) => read(request, async (sql) => {
    const hist = (await sql.query<{ customer_id: string; product_id: string; unit_price: string; quantity: string }>(
      `SELECT c.customer_id, l.product_id, l.unit_price::text, l.quantity::text
       FROM money_contract_lines l JOIN money_contracts c ON c.tenant_id=l.tenant_id AND c.id=l.contract_id
       WHERE c.approval IN ('approved','exempt') ORDER BY c.created_at DESC`,
    )).rows;
    const withHist = [];
    for (const row of (await sql.query<Record<string, unknown>>(
      `SELECT r.id,r.customer_id,r.product_id,r.unit_price::text,r.created_at,cu.name AS customer_name,p.name AS product_name,p.code AS product_code,coalesce(p.specification,'') AS product_spec, coalesce(u.display_name,'') AS creator_name
       FROM sales_price_rules r JOIN customers cu ON cu.id=r.customer_id JOIN products p ON p.id=r.product_id LEFT JOIN tenant_team_members u ON u.id=r.created_by ORDER BY r.created_at DESC`,
    )).rows) {
      const lines = hist.filter((h) => h.customer_id === row.customer_id && h.product_id === row.product_id);
      const prices = lines.map((l) => Number(l.unit_price));
      const qtySum = lines.reduce((s, l) => s + Number(l.quantity), 0);
      const weighted = qtySum ? lines.reduce((s, l) => s + Number(l.unit_price) * Number(l.quantity), 0) / qtySum : 0;
      withHist.push({
        ...row,
        price: Number(row.unit_price).toFixed(2),
        last_price: prices[0] != null ? prices[0].toFixed(2) : '-',
        avg_price: prices.length ? weighted.toFixed(2) : '-',
        max_price: prices.length ? Math.max(...prices).toFixed(2) : '-',
        min_price: prices.length ? Math.min(...prices).toFixed(2) : '-',
        created_text: shanghai(row.created_at),
      });
    }
    return { items: withHist };
  }));

  app.post('/api/crm/price-rules', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const customerId = clean(body.customer_id, 80, '客户', true);
    const productId = clean(body.product_id, 80, '商品', true);
    const price = clean(body.unit_price, 40, '单价', true);
    if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,8})?$/.test(price)) throw new Problem(422, 'PRICE', '请填写单价');
    const dup = (await sql.query('SELECT id FROM sales_price_rules WHERE customer_id=$1 AND product_id=$2', [customerId, productId])).rows[0];
    if (dup) throw new Problem(422, 'DUP', '该客户的此商品已存在价格规则');
    const id = (await sql.query<{ id: string }>('INSERT INTO sales_price_rules(tenant_id,customer_id,product_id,unit_price,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id', [actor.tenant_id, customerId, productId, price, actor.user_id])).rows[0]!.id;
    return { id };
  })));

  app.delete('/api/crm/price-rules/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM sales_price_rules WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '价格规则不存在');
    return { ok: true };
  }));

  app.get('/api/crm/price-fill', (request) => read(request, async (sql) => {
    const row = (await sql.query<{ fill_mode: string }>('SELECT fill_mode FROM sales_price_fill_settings')).rows[0];
    return { fill_mode: row?.fill_mode ?? 'goods' };
  }));
  app.put('/api/crm/price-fill', (request) => write(request, async (sql, actor) => {
    const mode = clean(bodyOf(request).fill_mode, 20, '规则') || 'goods';
    if (!['track', 'last', 'goods'].includes(mode)) throw new Problem(422, 'MODE', '价格填写规则不正确');
    await sql.query('INSERT INTO sales_price_fill_settings(tenant_id,fill_mode) VALUES($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET fill_mode=$2, updated_at=now()', [actor.tenant_id, mode]);
    return { fill_mode: mode };
  }));

  app.get('/api/crm/suggest-price', (request) => read(request, async (sql) => {
    const q = request.query as { customer_id?: string; product_id?: string };
    if (!q.customer_id || !q.product_id) return { price: '' };
    const mode = (await sql.query<{ fill_mode: string }>('SELECT fill_mode FROM sales_price_fill_settings')).rows[0]?.fill_mode ?? 'goods';
    if (mode === 'track') {
      const row = (await sql.query<{ unit_price: string }>('SELECT unit_price::text FROM sales_price_rules WHERE customer_id=$1 AND product_id=$2', [q.customer_id, q.product_id])).rows[0];
      if (row) return { price: row.unit_price };
    }
    if (mode === 'last' || mode === 'track') {
      const last = (await sql.query<{ unit_price: string }>(`SELECT l.unit_price::text FROM money_contract_lines l JOIN money_contracts c ON c.id=l.contract_id
        WHERE c.customer_id=$1 AND l.product_id=$2 AND c.approval IN ('approved','exempt') ORDER BY c.created_at DESC LIMIT 1`, [q.customer_id, q.product_id])).rows[0];
      if (last) return { price: last.unit_price };
    }
    const goods = (await sql.query<{ sale_price: string }>('SELECT sale_price::text FROM products WHERE id=$1', [q.product_id])).rows[0];
    return { price: goods?.sale_price ?? '' };
  }));
}
