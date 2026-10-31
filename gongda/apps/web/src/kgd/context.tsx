import { createContext, useContext } from 'react';
import type { Session } from '../api';

export type KgdContextValue = {
  session: Session;
  revision: number;
  onExpired: () => void;
  onChanged: () => void;
  onSession: (session: Session) => void;
  onLogout: () => void;
  logoutBusy: boolean;
  logoutError: string;
};

const KgdContext = createContext<KgdContextValue | null>(null);

export function KgdProvider({ value, children }: { value: KgdContextValue; children: React.ReactNode }) {
  return <KgdContext.Provider value={value}>{children}</KgdContext.Provider>;
}

export function useKgd() {
  const value = useContext(KgdContext);
  if (!value) throw new Error('快工单外壳尚未就绪。');
  return value;
}
