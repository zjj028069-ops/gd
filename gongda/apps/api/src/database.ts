import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// git 不保存空目录：从仓库下载的数据库会缺这些 PostgreSQL 必需的空目录，启动前补上
const PG_EMPTY_DIRS = ['pg_commit_ts', 'pg_dynshmem', 'pg_logical/mappings', 'pg_logical/snapshots', 'pg_notify', 'pg_replslot', 'pg_serial', 'pg_snapshots', 'pg_stat', 'pg_stat_tmp', 'pg_tblspc', 'pg_twophase', 'pg_wal/archive_status', 'pg_wal/summaries'];
function ensurePgDirs(dataDir: string) {
  if (dataDir.includes('://') || !existsSync(join(dataDir, 'PG_VERSION'))) return;
  for (const dir of PG_EMPTY_DIRS) mkdirSync(join(dataDir, dir), { recursive: true });
}
import { Pool, type PoolClient } from 'pg';

const policyNames:Record<string,string>={products:'products_tenant',units:'units_tenant',audit_events:'audits_tenant',processes:'processes_tenant',process_reporters:'process_reporters_tenant',process_routes:'process_routes_tenant',route_versions:'route_versions_tenant',route_steps:'route_steps_tenant',bom_definitions:'bom_definitions_tenant',bom_versions:'bom_versions_tenant',bom_items:'bom_items_tenant'};
Object.assign(policyNames,Object.fromEntries(['audit_flows','audit_flow_objects','audit_flow_levels','audit_instances','audit_actions','kgd_messages','kgd_teams','kgd_team_members','kgd_operation_logs','kgd_enterprise_settings'].map(t=>[t,t+'_tenant'])));
Object.assign(policyNames,Object.fromEntries(['customer_sea_logs','sales_price_rules','sales_price_fill_settings','kgd_message_category_sorts','performance_pay_rows','performance_match_rules','performance_formulas','auto_stock_events','auto_stock_logs','produce_settings','material_analysis_occupancy','process_inspectors','work_order_splits','r8_qrcode_batches'].map(t=>[t,t+'_tenant'])));
Object.assign(policyNames,Object.fromEntries(['entity_ext_fields','entity_ext_values','workplace_configs','customer_follows','knowledge_categories','knowledge_articles','notices','notice_reads','purchase_settings','purchase_price_rules','basic_settings','work_statuses','sms_accounts','sms_recharges','sms_send_logs','smart_reports','tenant_report_prefs','list_views','list_column_prefs','ai_inventory_orders','production_projects','cost_shares','cost_share_lines','posts','process_components','process_component_fields','trace_codes','work_order_shares','ai_documents','ai_qa_pairs','ai_chats'].map(t=>[t,t+'_tenant'])));
Object.assign(policyNames,Object.fromEntries(['r8_counters','r8_defect_items','r8_report_defects','r8_rework_tasks','r8_qc_components','r8_spot_checks','r8_spot_lines','r8_qc_specs','r8_qc_spec_items','r8_purchase_tests','r8_purchase_test_lines','r8_os_contents','r8_os_content_items','r8_out_orders','r8_out_materials','r8_os_receipts','r8_os_checks','r8_shops','r8_lines','r8_machine_categories','r8_machine_statuses','r8_machines','r8_station_settings','r8_stations','r8_station_users','r8_lean_settings','r8_patrols','r8_rectify','r8_meetings','r8_agendas','r8_complaints','r8_lean_materials','r8_lean_designs','r8_iot_scenes','r8_iot_sensors','r8_iot_alarms','r8_equip_categories','r8_devices','r8_qrcodes','r8_maint_contents','r8_maint_items','r8_maint_plans','r8_maint_tasks','r8_maint_records','r8_pi_plans','r8_pi_records','r8_repairs','r8_equip_settings'].map(t=>[t,t+'_tenant'])));
Object.assign(policyNames,Object.fromEntries(['departments','workshops','production_lines','tenant_roles','tenant_member_profiles','tenant_onboard_requests','numbering_rules','numbering_counters','numbering_allocations','extension_schemas','extension_schema_versions','extension_schema_publications','product_field_values','user_views','user_view_history','tenant_service_limits','attachments','event_rules','local_event_outbox','user_notifications','customers','warehouses','document_counters','command_replays','sales_orders','sales_order_lines','work_orders','work_order_tasks','work_order_materials','production_reports','material_issues','material_issue_lines','fg_receipts','shipments','shipment_lines','stock_adjustments','inspections','stock_balances','stock_ledger','suppliers','purchase_orders','purchase_order_lines','purchase_receipts','purchase_receipt_lines','incoming_inspections','stock_cost_events','mrp_batches','mrp_lines','stock_reservations','reservation_consumptions','wage_rules','wage_rule_versions','wage_events','open_items','payments','payment_allocations','financial_events','wage_settlements','wage_settlement_lines','production_supplements','supplement_materials','rework_reports','business_settings','expense_documents','expense_cost_events','warehouse_transfers','stock_counts','product_categories','inspection_specs','goods_settings','custom_code_rules','custom_code_counters','goods_views','money_settings','money_tags','money_end_reasons','money_audit_flows','money_counters','money_contacts','money_addresses','money_quotations','money_quotation_lines','money_contracts','money_contract_lines','money_cash','money_invoices','money_expenses','money_audit_logs','money_terminations','money_logs','money_purchase_plans','money_purchase_plan_lines','money_purchase_line_meta','money_purchase_payments','money_purchase_invoices','money_purchase_returns','money_notices','stock_settings','stock_io_types','stock_audit_flows','stock_audit_logs','purchase_return_bills','purchase_return_lines','stock_transfer_bills','stock_transfer_lines','stock_taking_bills','stock_taking_lines','warehouse_misc_bills','warehouse_misc_bill_lines','warehouse_counters','production_plans','production_plan_lines','production_plan_analyses','production_plan_analysis_lines','data_screens'].map(t=>[t,t+'_tenant'])));
Object.assign(policyNames,{ai_action_log:'ai_action_log_tenant',ai_action_audit:'ai_action_audit_tenant',ai_factory_glossary:'ai_factory_glossary_tenant',ai_ext_apps:'ai_ext_apps_tenant'});
const tenantTables=Object.keys(policyNames);

export type Sql = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  exec(sql: string): Promise<void>;
};
export type TenantContext = { tenantId: string; userId: string };
export type DatabaseOptions = { mode: 'pglite' | 'postgres'; dataDir?: string; url?: string; production?: boolean };

export class Database {
  private embedded?: PGlite;
  private pool?: Pool;
  readonly mode: DatabaseOptions['mode'];
  constructor(options: DatabaseOptions) {
    this.mode = options.mode;
    if (options.production && options.mode !== 'postgres') throw new Error('生产环境必须使用独立PostgreSQL服务');
    if (options.mode === 'pglite') { if (options.dataDir) ensurePgDirs(options.dataDir); this.embedded = new PGlite(options.dataDir ?? 'memory://'); }
    else {
      if (!options.url) throw new Error('缺少DATABASE_URL');
      this.pool = new Pool({ connectionString: options.url, max: 10, ...(options.production ? { ssl: { rejectUnauthorized: true } } : {}) });
    }
  }
  private async transaction<T>(role: 'gd_auth' | 'gd_tenant' | 'gd_platform' | undefined, context: TenantContext | undefined, work: (sql: Sql) => Promise<T>): Promise<T> {
    const setup = async (sql: Sql) => {
      if (role) await sql.exec('SET LOCAL ROLE ' + role);
      if (context) await sql.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [context.tenantId, context.userId]);
    };
    if (this.embedded) return this.embedded.transaction(async (tx) => {
      const sql: Sql = {
        query: async <R>(statement: string, params: unknown[] = []) => {
          const result = await tx.query<R>(statement, params);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
        exec: async (statement) => { await tx.exec(statement); },
      };
      await setup(sql);
      return work(sql);
    });
    const client: PoolClient = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      const sql: Sql = {
        query: async <R>(statement: string, params: unknown[] = []) => {
          const result = await client.query(statement, params);
          return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
        },
        exec: async (statement) => { await client.query(statement); },
      };
      await setup(sql);
      const result = await work(sql);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  auth<T>(work: (sql: Sql) => Promise<T>) { return this.transaction('gd_auth', undefined, work); }
  tenant<T>(context: TenantContext, work: (sql: Sql) => Promise<T>) { return this.transaction('gd_tenant', context, work); }
  identity<T>(context:TenantContext,work:(sql:Sql)=>Promise<T>){return this.transaction('gd_platform',context,work);}
  admin<T>(work: (sql: Sql) => Promise<T>) { return this.transaction(undefined, undefined, work); }
  async assertSecurityConfiguration() {
    await this.admin(async (sql) => {
      const roles = (await sql.query<{ rolname:string; unsafe:boolean }>("SELECT rolname, rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin OR rolinherit OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS unsafe FROM pg_roles r WHERE rolname IN ('gd_auth','gd_tenant','gd_platform','gd_directory')")).rows;
      if (roles.length !== 4 || roles.some((role) => role.unsafe)) throw new Error('gd_auth/gd_tenant/gd_platform必须是无特权、不可登录且不继承其他角色的安全角色');
      const tables = (await sql.query<{ name:string; safe:boolean }>("SELECT c.relname AS name,c.relrowsecurity AND c.relforcerowsecurity AND o.rolname NOT IN ('gd_auth','gd_tenant','gd_platform') AS safe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles o ON o.oid=c.relowner WHERE n.nspname='public' AND c.relname  = ANY($1::text[])",[tenantTables])).rows;
      if (tables.length !== tenantTables.length || tables.some((table) => !table.safe)) throw new Error('业务表必须强制RLS且不得属于运行角色');
      const appendOnly = (await sql.query<{ unsafe: boolean }>("SELECT bool_or(has_any_column_privilege('gd_tenant',c.oid,'UPDATE') OR has_table_privilege('gd_tenant',c.oid,'DELETE') OR has_table_privilege('gd_tenant',c.oid,'TRUNCATE')) AS unsafe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])", [['stock_ledger','command_replays','stock_cost_events','reservation_consumptions','wage_rule_versions','wage_events','financial_events','supplement_materials','expense_cost_events']])).rows[0];
      if (appendOnly?.unsafe) throw new Error('库存流水与命令记录必须只追加，运行角色不得修改列、删除或清空');
      const policies = (await sql.query<{ tablename:string; policyname:string; roles:string[]; cmd:string; permissive:string; qual:string; with_check:string }>("SELECT tablename,policyname,roles,cmd,permissive,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename  = ANY($1::text[])",[tenantTables])).rows;
      const normalize = (value:string) => value.replace(/[\s()]/g,'').toLowerCase();
      const expected = normalize("tenant_id::text = nullif(current_setting('app.tenant_id'::text,true),''::text)");
      const memberView=(await sql.query<{definition:string;safe:boolean}>("SELECT pg_get_viewdef(c.oid,true) AS definition,c.reloptions @> ARRAY['security_barrier=true'] AND o.rolname NOT IN ('gd_auth','gd_tenant','gd_platform') AS safe FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='tenant_team_members' AND c.relkind='v' AND o.rolname='gd_directory'")).rows[0];
      const expectedView=normalize("SELECT u.id,u.display_name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id::text=NULLIF(current_setting('app.tenant_id'::text,true),''::text) AND m.active AND u.active;");
      const exposed=(await sql.query<{unsafe:boolean}>("SELECT bool_or(has_table_privilege('gd_tenant',c.oid,'SELECT')) AS unsafe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('users','memberships','tenants','sessions')")).rows[0];
      if(!memberView?.safe||normalize(memberView.definition)!==expectedView||exposed?.unsafe)throw new Error('企业成员视图或全局身份表授权不符合安全基线');
      const sealDefinitions:Record<string,{table:string;fn:string;type:number;deferred:boolean}>={
        route_steps_no_append:{table:'route_steps',fn:'prevent_saved_version_append',type:7,deferred:false},
        bom_items_no_append:{table:'bom_items',fn:'prevent_saved_version_append',type:7,deferred:false},
        route_version_complete:{table:'route_versions',fn:'require_complete_version',type:5,deferred:true},
        bom_version_complete:{table:'bom_versions',fn:'require_complete_version',type:5,deferred:true},
        route_header_complete:{table:'process_routes',fn:'require_complete_header',type:21,deferred:true},
        bom_header_complete:{table:'bom_definitions',fn:'require_complete_header',type:21,deferred:true},
        route_pointer_monotonic:{table:'process_routes',fn:'protect_version_pointer',type:19,deferred:false},
        bom_pointer_monotonic:{table:'bom_definitions',fn:'protect_version_pointer',type:19,deferred:false},
      };
      const seals=(await sql.query<{name:string;table:string;fn:string;type:number;deferred:boolean;safe:boolean}>("SELECT t.tgname AS name,c.relname AS table,p.proname AS fn,t.tgtype::integer AS type,t.tgdeferrable AND t.tginitdeferred AS deferred,t.tgenabled='O' AND t.tgqual IS NULL AND NOT p.prosecdef AND pn.nspname='public' AND owner.rolname NOT IN ('gd_auth','gd_tenant','gd_platform') AS safe FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_roles owner ON owner.oid=p.proowner WHERE n.nspname='public' AND t.tgname=ANY($1::text[]) AND NOT t.tgisinternal",[Object.keys(sealDefinitions)])).rows;
      if(seals.length!==8||seals.some(t=>{const expected=sealDefinitions[t.name];return !expected||!t.safe||t.table!==expected.table||t.fn!==expected.fn||t.type!==expected.type||t.deferred!==expected.deferred;}))throw new Error('历史版本封存触发器不符合安全基线');
      const identity=(await sql.query<{safe:boolean}>("SELECT c.relrowsecurity AND c.relforcerowsecurity AND o.rolname NOT IN ('gd_auth','gd_tenant','gd_platform') AND NOT has_column_privilege('gd_platform','users','password_hash','SELECT') AND NOT has_table_privilege('gd_platform','users','UPDATE') AND NOT has_table_privilege('gd_auth','memberships','UPDATE') AS safe FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid='public.memberships'::regclass")).rows[0];
      const membershipPolicies=(await sql.query<{policyname:string;roles:string[];cmd:string;qual:string;with_check:string}>("SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='memberships'")).rows;
      if(!identity?.safe||membershipPolicies.length!==3||!membershipPolicies.some(p=>p.policyname==='memberships_auth_read'&&p.roles.length===1&&p.roles[0]==='gd_auth'&&p.cmd==='SELECT'&&normalize(p.qual)==='true')||!membershipPolicies.some(p=>p.policyname==='memberships_platform_tenant'&&p.roles.length===1&&p.roles[0]==='gd_platform'&&p.cmd==='ALL'&&normalize(p.qual)===expected&&normalize(p.with_check)===expected))throw new Error('身份管理角色或企业成员隔离策略不符合安全基线');
      if(!membershipPolicies.some(p=>p.policyname==='memberships_directory_read'&&p.roles.length===1&&p.roles[0]==='gd_directory'&&p.cmd==='SELECT'&&normalize(p.qual)===expected))throw new Error('受限目录所有者的成员读取策略不符合基线');
      const eventTrigger=(await sql.query<{safe:boolean}>("SELECT t.tgenabled='O' AND t.tgtype=5 AND t.tgqual IS NULL AND p.proname='enqueue_local_audit_event' AND NOT p.prosecdef AND po.rolname NOT IN ('gd_auth','gd_tenant','gd_platform','gd_directory') AS safe FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_roles po ON po.oid=p.proowner WHERE t.tgname='audit_local_event' AND t.tgrelid='public.audit_events'::regclass AND NOT t.tgisinternal")).rows[0];
      if(!eventTrigger?.safe)throw new Error('本地审计事件队列触发器不符合可靠性基线');
      const names = policyNames;
      if (policies.length !== tenantTables.length || policies.some((policy) => names[policy.tablename] !== policy.policyname || policy.roles.length !== 1 || policy.roles[0] !== 'gd_tenant' || policy.cmd !== 'ALL' || policy.permissive !== 'PERMISSIVE' || normalize(policy.qual??'') !== expected || normalize(policy.with_check??'') !== expected)) {
        throw new Error('RLS策略与当前迁移基线不一致，拒绝启动');
      }
    });
  }

  async assertProductionRole() {
    await this.assertSecurityConfiguration();
    await this.admin(async (sql) => {
      const row = (await sql.query<{ unsafe: boolean }>("SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid AND c.relname  = ANY($1::text[])) AS unsafe FROM pg_roles r WHERE rolname = current_user",[[...tenantTables,'tenant_team_members','tenants','users','memberships','sessions','schema_migrations']])).rows[0];
      if (!row || row.unsafe) throw new Error('生产应用数据库账号不能是超级用户、BYPASSRLS或业务表所有者');
      const ownsFunction=(await sql.query<{owned:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace WHERE r.rolname=current_user AND n.nspname='public' AND p.proname IN ('prevent_saved_version_append','require_complete_version','protect_version_pointer','require_complete_header','enqueue_local_audit_event')) AS owned")).rows[0];
      if(ownsFunction?.owned)throw new Error('生产运行账号不能拥有历史版本封存函数');
      const grants = (await sql.query<{ auth: boolean; tenant: boolean; platform:boolean }>("SELECT pg_has_role(current_user,'gd_auth','MEMBER') AS auth, pg_has_role(current_user,'gd_tenant','MEMBER') AS tenant, pg_has_role(current_user,'gd_platform','MEMBER') AS platform")).rows[0];
      if (!grants?.auth || !grants.tenant || !grants.platform) throw new Error('应用账号缺少gd_auth/gd_tenant/gd_platform角色授权');
    });
  }
  async close() { if (this.embedded) await this.embedded.close(); else await this.pool!.end(); }
}






