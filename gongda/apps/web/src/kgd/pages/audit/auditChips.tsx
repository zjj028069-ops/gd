import { useRemote } from '../../../masterTools';

const labels = [
  ['all', '全部'],
  ['pending', '待审'],
  ['approved', '通过'],
  ['rejected', '退回'],
  ['withdrawn', '撤回'],
  ['exempt', '不需审核'],
] as const;

export function useAuditCounts(objectType: string, revision: number, onExpired: () => void) {
  return useRemote<{ all: number; pending: number; approved: number; rejected: number; withdrawn: number; exempt: number; draft: number }>(`/api/audit/counts?object_type=${objectType}`, revision, onExpired);
}

export function auditChipOptions(counts: { all?: number; pending?: number; approved?: number; rejected?: number; withdrawn?: number; exempt?: number; draft?: number } | null | undefined, draftLast = false) {
  const options: { value: string; label: string }[] = labels.map(([value, label]) => ({ value, label: `${label}(${counts?.[value] ?? 0})` }));
  if (draftLast) options.push({ value: 'draft', label: `草稿(${counts?.draft ?? 0})` });
  return options;
}
