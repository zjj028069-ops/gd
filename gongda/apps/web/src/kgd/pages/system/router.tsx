import { AuditSettingPage } from '../audit/AuditSettingPage';
import { DepartmentPage } from './departments';
import { EnterprisePage } from './enterprise';
import { PersonalPage } from './personal';
import { RolePages } from './roles';
import { TeamPage } from './teams';
import { UserLogPage } from './userLog';
import { UserPages } from './users';

export function resolveSystemPage(pathname: string) {
  if (pathname === '/customer/setting/audit_setting') return <AuditSettingPage module="customer" />;
  if (pathname === '/setting/stock/audit_setting') return <AuditSettingPage module="stock" />;
  if (pathname === '/setting/supplier_purchase/audit_setting') return <AuditSettingPage module="purchase" />;
  if (pathname === '/personal/center' || pathname === '/account') return <PersonalPage />;
  if (pathname.startsWith('/user/')) return <UserPages />;
  if (pathname.startsWith('/role/')) return <RolePages />;
  if (pathname === '/department/list') return <DepartmentPage />;
  if (pathname === '/systemTeam/list') return <TeamPage />;
  if (pathname === '/userLog') return <UserLogPage />;
  if (pathname === '/setting/enterprise/setting') return <EnterprisePage />;
  return null;
}
