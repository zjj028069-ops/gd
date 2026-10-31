import { beijingTime } from '../../kit';
import { ListFrame } from '../../ListFrame';
import { useQueryState } from '../../kit';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';

type Log = { id: string; action: string; actor_name: string; content: string; client_name: string; created_at: string };

export function UserLogPage() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const q = list.query;
  const remote = useRemote<{ items: Log[] }>(`/api/system/operation-logs?actor=${encodeURIComponent(q.actor ?? '')}`, revision + Object.keys(q).length, onExpired);
  const rows = remote.data?.items ?? [];
  return <ListFrame pageKey="user-log" rows={rows} loading={remote.loading} error={remote.error}
    queryFields={[{ key: 'client', label: '操作端' }, { key: 'actor', label: '操作人' }, { key: 'action', label: '操作' }, { key: 'content', label: '操作内容' }, { key: 'from', label: '操作时间起', kind: 'date' }, { key: 'to', label: '操作时间止', kind: 'date' }]}
    queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
    columns={[
      { key: 'action', title: '操作', render: (row) => row.action },
      { key: 'content', title: '操作内容', render: (row) => row.content },
      { key: 'client', title: '操作端', render: (row) => row.client_name },
      { key: 'actor', title: '操作人', render: (row) => row.actor_name || '-' },
      { key: 'time', title: '操作时间', render: (row) => beijingTime(row.created_at, '') },
    ]} />;
}
