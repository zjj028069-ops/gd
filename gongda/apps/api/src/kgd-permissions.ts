import type { Sql } from './database.js';
import { Problem, type Actor } from './services.js';

export type PointScope = 'self' | 'team' | 'all';
type Point = { code: string; name: string; scopes?: PointScope[] };
type Group = { name: string; points: Point[] };
type Module = { key: string; name: string; groups: Group[] };

const view = (code: string, name = '查看', scopes?: PointScope[]): Point => ({ code, name, ...(scopes ? { scopes } : {}) });
const scopes3: PointScope[] = ['self', 'team', 'all'];
const scopes2: PointScope[] = ['team', 'all'];

export const permissionModules: Module[] = [
  { key: 'report', name: '报表中心', groups: [{ name: '报表中心', points: [view('menu.report.view')] }] },
  { key: 'customer', name: '客户管理', groups: [
    { name: '客户列表', points: [
      view('customer.list.view', '查看', scopes3), view('customer.list.create', '新增'), view('customer.list.update', '编辑', scopes3), view('customer.list.delete', '删除', scopes3),
      view('customer.list.import', '导入'), view('customer.list.export', '导出'), view('customer.list.transfer', '转移', scopes2), view('customer.list.toggle', '启用停用'),
      view('customer.list.follow', '跟进'), view('customer.list.sea', '放入公海'), view('customer.list.viewmgr', '查看负责人'), view('customer.list.detail', '详情'), view('customer.list.share', '共享', scopes2),
    ] },
    { name: '合同报价单', points: [view('customer.quote.view', '查看', scopes3), view('customer.quote.create', '新增'), view('customer.quote.update', '编辑', scopes3), view('customer.quote.delete', '删除'), view('customer.quote.export', '导出'), view('customer.quote.amount', '查看报价金额')] },
    { name: '合同订单', points: [view('customer.contract.view', '查看', scopes3), view('customer.contract.detail', '详情'), view('customer.contract.create', '新增'), view('customer.contract.update', '编辑', scopes3), view('customer.contract.delete', '删除'), view('customer.contract.export', '导出'), view('customer.contract.viewmgr', '查看负责人'), view('customer.contract.receipt_date', '收款日期'), view('customer.contract.complete', '完成'), view('customer.contract.terminate', '终止'), view('customer.contract.undo', '撤回'), view('customer.contract.amount', '查看金额')] },
    { name: '收支记录', points: [view('customer.cash.view', '查看'), view('customer.cash.update', '编辑'), view('customer.cash.delete', '删除'), view('customer.cash.in', '收款'), view('customer.cash.out', '支出'), view('customer.cash.export', '导出')] },
    { name: '发票管理', points: [view('customer.invoice.view', '查看'), view('customer.invoice.apply', '申请'), view('customer.invoice.issue', '开票')] },
    { name: '销售费用', points: [view('customer.expense.view', '查看'), view('customer.expense.manage', '管理'), view('customer.expense.delete', '删除'), view('customer.expense.settle', '结算'), view('customer.expense.export', '导出')] },
    { name: '客户设置', points: [view('customer.setting.base', '基础设置'), view('customer.setting.audit', '审核设置'), view('customer.setting.price', '价格设置')] },
  ] },
  { key: 'screen', name: '数据大屏', groups: [{ name: '数据大屏', points: [view('menu.screen.view')] }] },
  { key: 'lean', name: '精益生产', groups: [{ name: '精益生产', points: [view('menu.lean.view')] }] },
  { key: 'produce', name: '生产管理', groups: [{ name: '生产管理', points: [view('menu.produce.view'), view('produce.report', '报工（只给工人勾这个即可；勾「生产管理」的人还能代报、审核报工）')] }] },
  { key: 'device-smart', name: '智能设备', groups: [{ name: '智能设备', points: [view('menu.device-smart.view')] }] },
  { key: 'device', name: '设备维保', groups: [{ name: '设备维保', points: [view('menu.device.view')] }] },
  { key: 'goods', name: '商品管理', groups: [{ name: '商品管理', points: [view('menu.goods.view')] }] },
  { key: 'warehouse', name: '仓库管理', groups: [{ name: '仓库管理', points: [view('menu.warehouse.view')] }] },
  { key: 'ai', name: 'AI智能体', groups: [{ name: 'AI智能体', points: [view('menu.ai.view')] }] },
  { key: 'message', name: '消息中心', groups: [{ name: '消息中心', points: [view('info.message.view', '查看')] }] },
  { key: 'info', name: '信息管理', groups: [{ name: '知识库与公告', points: [view('info.message.view', '查看')] }] },
  { key: 'system', name: '系统管理', groups: [{ name: '系统管理', points: [
    view('system.setting', '系统设置'), view('system.account', '账号管理'), view('system.extension', '扩展'), view('system.mobile', '移动端'), view('system.log', '操作日志'),
    view('system.wipe', '清空数据'), view('system.team', '团队'), view('system.export_user', '导出用户'), view('system.template', '模板'),
    view('system.columns', '列设置', ['self', 'all']), view('system.voice', '语音', ['self', 'all']),
  ] }] },
  { key: 'supply', name: '供应/采购', groups: [
    { name: '采购', points: [view('menu.supply.view'), view('purchase.setting.audit', '审核设置')] },
  ] },
];

const allPoints = permissionModules.flatMap((item) => item.groups.flatMap((group) => group.points.map((point) => point.code)));

export function customerPoints() {
  return allPoints.filter((code) => code.startsWith('customer.'));
}

export function derivePermissions(points: string[]) {
  const has = (prefix: string) => points.some((code) => code.startsWith(prefix));
  const write = (prefix: string) => points.some((code) => code.startsWith(prefix) && /(create|update|delete|manage|in|out|settle|issue|apply|import|transfer|toggle)$/.test(code));
  const permissions = new Set<string>();
  if (has('customer.') || has('menu.customer')) permissions.add('sales.read');
  if (write('customer.') || points.includes('customer.cash.in') || points.includes('customer.cash.out') || points.includes('customer.expense.manage')) {
    permissions.add('sales.write');
    permissions.add('sales.approve');
  }
  if (has('customer.cash') || has('customer.expense') || has('customer.invoice')) {
    permissions.add('finance.read');
    permissions.add('finance.write');
    permissions.add('finance.approve');
  }
  if (has('menu.warehouse') || has('menu.goods')) {
    permissions.add('inventory.read');
    permissions.add('inventory.write');
    permissions.add('inventory.approve');
    permissions.add('master.read');
  }
  if (has('menu.supply') || has('purchase.')) {
    permissions.add('procurement.read');
    permissions.add('procurement.write');
    permissions.add('procurement.approve');
  }
  // 报工：工人只需要这一项（能看加工单、给分配到自己的工序报工，不能开工/取消/新建）
  if (points.includes('produce.report')) {
    permissions.add('production.read');
    permissions.add('production.report');
  }
  if (has('menu.produce')) {
    permissions.add('production.read');
    permissions.add('production.write');
    // 以前漏了：有生产管理权限却报不了工
    permissions.add('production.report');
    // 生产管理可以替工人代报（同一项权限也包括审核/撤销报工、超计划补产）
    permissions.add('production.approve');
    // 开了生产菜单查看即可看企业报工列表（与原版一致）；若角色已带更细工资 point 则不重复强加
    const hasFinePayroll = points.some((code) => code.startsWith('payroll.') && code !== 'payroll.read');
    if (!hasFinePayroll) permissions.add('payroll.read');
  }
  if (points.includes('system.account') || points.includes('system.setting') || points.includes('system.team')) permissions.add('organization.manage');
  if (points.includes('system.log')) permissions.add('audit.read');
  if (points.includes('system.setting')) {
    permissions.add('configuration.read');
    permissions.add('configuration.manage');
  }
  if (points.includes('info.message.view')) permissions.add('configuration.read');
  return [...permissions];
}

export function asStringList(value: unknown): string[] | null {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.map(String) : null;
}

export function asScopes(value: unknown): Record<string, PointScope> {
  if (value == null) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const scopes: Record<string, PointScope> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (item === 'self' || item === 'team' || item === 'all') scopes[key] = item;
  }
  return scopes;
}

export function assertPoint(actor: Actor, point: string) {
  if (actor.points === null) {
    if (point.startsWith('system.') || point === 'info.message.view') {
      const need = point === 'system.log' ? 'audit.read' : point === 'info.message.view' ? 'configuration.read' : 'organization.manage';
      if (point === 'info.message.view') return;
      if (!actor.permissions.includes(need) && actor.role !== 'admin') throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
    }
    return;
  }
  if (!actor.points.includes(point)) throw new Problem(403, 'FORBIDDEN', '当前角色没有操作权限');
}

export function scopeOf(actor: Actor, point: string): PointScope {
  if (actor.points === null) return 'all';
  return actor.point_scopes[point] ?? 'all';
}

export function inScope(actor: Actor, ownerId: string | null | undefined, point: string) {
  const scope = scopeOf(actor, point);
  if (scope === 'all') return true;
  if (!ownerId) return false;
  if (scope === 'self') return ownerId === actor.user_id;
  return actor.team_user_ids.includes(ownerId);
}

export async function loadTeamUserIds(sql: Sql, userId: string) {
  const rows = (await sql.query<{ user_id: string }>(`WITH RECURSIVE mine AS (
    SELECT team_id FROM kgd_team_members WHERE user_id=$1
    UNION
    SELECT t.id FROM kgd_teams t JOIN mine m ON t.parent_id = m.team_id WHERE t.active
  ) SELECT DISTINCT user_id FROM kgd_team_members WHERE team_id IN (SELECT team_id FROM mine)`, [userId])).rows;
  return [...new Set([userId, ...rows.map((row) => row.user_id)])];
}

export async function isFlowApprover(sql: Sql, userId: string, objectType: string) {
  const row = (await sql.query(`SELECT 1 FROM audit_flows f
    JOIN audit_flow_objects o ON o.tenant_id=f.tenant_id AND o.flow_id=f.id
    JOIN audit_flow_levels l ON l.tenant_id=f.tenant_id AND l.flow_id=f.id
    WHERE o.object_type=$1 AND f.enabled AND $2 = ANY(l.approver_ids) LIMIT 1`, [objectType, userId])).rows[0];
  return Boolean(row);
}

export async function pendingApproverIds(sql: Sql, userId: string, objectType: string) {
  const rows = (await sql.query<{ object_id: string }>(`SELECT i.object_id FROM audit_instances i
    WHERE i.object_type=$1 AND i.status='pending'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(i.flow_snapshot->'levels') level
      WHERE level->'approver_ids' ? $2
    )`, [objectType, userId])).rows;
  return new Set(rows.map((row) => row.object_id));
}
