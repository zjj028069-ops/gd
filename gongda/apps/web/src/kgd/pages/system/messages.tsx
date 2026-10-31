import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Table } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { beijingTime } from '../../kit';

type Message = { id: string; kind_text: string; title: string; body: string; read_text: string; doc_code: string; created_at: string };

export function MessagePage() {
  const { search } = useLocation();
  const code = new URLSearchParams(search).get('code') ?? '';
  const { revision, onExpired } = useKgd();
  const [kind, setKind] = useState('all');
  const [read, setRead] = useState('all');
  const remote = useRemote<{ items: Message[] }>(`/api/system/messages?kind=${kind}&read=${read}&code=${encodeURIComponent(code)}`, revision, onExpired);
  return <div className="kgd-card">
    <div style={{ marginBottom: 12 }}>
      {[['all', '全部'], ['alarm', '报警'], ['todo', '待办'], ['notice', '通知']].map(([value, label]) => <Button key={value} type={kind === value ? 'primary' : 'default'} onClick={() => setKind(value!)}>{label}</Button>)}
      <Button type={read === 'unread' ? 'primary' : 'default'} onClick={() => setRead('unread')}>未读</Button>
      <Button type={read === 'read' ? 'primary' : 'default'} onClick={() => setRead('read')}>已读</Button>
    </div>
    <Table size="small" rowKey="id" dataSource={remote.data?.items ?? []} locale={{ emptyText: '暂无数据' }} pagination={{ pageSize: 30, showTotal: (count) => `共${count}条数据` }} columns={[
      { title: '类型', dataIndex: 'kind_text' },
      { title: '标题', dataIndex: 'title' },
      { title: '内容', dataIndex: 'body' },
      { title: '状态', dataIndex: 'read_text' },
      { title: '时间', dataIndex: 'created_at', render: (value: string) => beijingTime(value) },
    ]} />
    <div style={{ color: '#888', marginTop: 8 }}>消息仅保留三个月</div>
  </div>;
}
