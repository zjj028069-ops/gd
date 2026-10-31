import type { FastifyInstance } from 'fastify';
import { bodyOf, withTenant } from './round8-kit.js';

const defaults = {
  process_price_formula: false,
  open_all_reporters: false,
  use_trace_code: false,
  auto_fill_child_wo: false,
};

export function registerProduceSettings(app: FastifyInstance, services: import('./services.js').Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);
  app.get('/api/produce/settings', (request) => read(request, async (sql) => {
    const row = (await sql.query<{ settings: Record<string, unknown>; version: number }>('SELECT settings,version FROM produce_settings')).rows[0];
    return { settings: { ...defaults, ...(row?.settings ?? {}) }, version: row?.version ?? 1 };
  }));
  app.put('/api/produce/settings', (request) => write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const settings = { ...defaults, ...(body as Record<string, unknown>) };
    delete (settings as { version?: unknown }).version;
    await sql.query('INSERT INTO produce_settings(tenant_id,settings,version) VALUES($1,$2::jsonb,1) ON CONFLICT (tenant_id) DO UPDATE SET settings=$2::jsonb, version=produce_settings.version+1, updated_at=now()', [actor.tenant_id, JSON.stringify(settings)]);
    return { settings };
  }));
}
