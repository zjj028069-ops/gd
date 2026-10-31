import { Modal, Tooltip } from 'antd';
import { beijingTime } from '../../kit';
import { useRemote } from '../../../masterTools';

type Approver = { name: string; action: string; remark: string; time: string | null };
type Level = { title: string; approvers: Approver[] };
const ignoreExpired = () => undefined;

export function AuditDetailModal({ objectType, objectId, onClose }: { objectType: string; objectId: string; onClose: () => void }) {
  const remote = useRemote<{ status: string; levels: Level[] }>(`/api/audit/detail?object_type=${objectType}&object_id=${objectId}`, 0, ignoreExpired);
  return <Modal title="审核进度" open onCancel={onClose} footer={null} width={720}>
    {(remote.data?.levels ?? []).map((level) => <div key={level.title} style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 8 }}>{level.title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {level.approvers.map((person) => {
          const mark = person.action === '通过' ? '✓' : person.action === '退回' ? '×' : '…';
          const color = person.action === '通过' ? '#52c41a' : person.action === '退回' ? '#f5222d' : '#fa8c16';
          return <Tooltip key={person.name + (person.time ?? '')} title={person.remark || '-'}>
            <div style={{ width: 72, textAlign: 'center' }}>
              <div style={{ width: 36, height: 36, borderRadius: 18, margin: '0 auto', background: color, color: '#fff', lineHeight: '36px' }}>{mark}</div>
              <div>{person.name || '-'}</div>
              <div style={{ color: '#888', fontSize: 12 }}>{person.time ? beijingTime(person.time, '') : '-'}</div>
            </div>
          </Tooltip>;
        })}
      </div>
    </div>)}
    {!remote.data?.levels.length && <div>暂无数据</div>}
  </Modal>;
}
