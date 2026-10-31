import { lazy, Suspense } from 'react';
import { Audit } from '../../Audit';
import { BusinessCompletion } from '../../BusinessCompletion';
import { ConfigurationSettings } from '../../ConfigurationSettings';
import { Notifications } from '../../EventSettings';
import { MasterData } from '../../MasterData';
import { PlatformSettings } from '../../PlatformSettings';
import { ProductionDesk } from '../../ProductionDesk';
import { Loading } from '../../shared';
import { useKgd } from '../context';
import type { LegacyKey } from '../menu';

const ExpensesReports = lazy(() => import('../../ExpensesReports').then((module) => ({ default: module.ExpensesReports })));
const WarehouseOperations = lazy(() => import('../../WarehouseOperations').then((module) => ({ default: module.WarehouseOperations })));

export function LegacyEmbed({ kind }: { kind: LegacyKey }) {
  const { session, revision, onExpired, onChanged, onSession } = useKgd();
  const props = { session, revision, onExpired, onChanged };
  return <div className="legacy-embed">
    {kind === 'expenses' && <Suspense fallback={<Loading />}><ExpensesReports {...props} /></Suspense>}
    {kind === 'stock-desk' && <ProductionDesk mode="stock" {...props} />}
    {kind === 'warehouse-ops' && <Suspense fallback={<Loading />}><WarehouseOperations {...props} /></Suspense>}
    {kind === 'business' && <BusinessCompletion {...props} />}
    {kind === 'notifications' && <Notifications {...props} />}
    {kind === 'platform' && <PlatformSettings {...props} onSession={onSession} />}
    {kind === 'audit' && <Audit session={session} revision={revision} onExpired={onExpired} />}
    {kind === 'configuration' && <ConfigurationSettings {...props} />}
    {kind === 'units' && <MasterData kind="units" {...props} />}
  </div>;
}
