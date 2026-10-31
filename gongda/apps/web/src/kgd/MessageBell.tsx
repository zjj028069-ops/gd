import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useRemote } from '../masterTools';
import { useKgd } from './context';

type Item = { id: string; kind: string; kind_text?: string; title: string; body: string; link_path: string; read_at: string | null };

export function MessageBell() {
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('all');
  const [read, setRead] = useState('unread');
  const remote = useRemote<{ items: Item[]; unread: number }>(`/api/system/messages?kind=${kind}&read=${read}`, revision, onExpired);
  const unread = remote.data?.unread ?? 0;
  return <span style={{ position: 'relative' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <Badge count={unread} size="small"><button aria-label="消息" onClick={() => navigate('/message/list')}><BellOutlined /></button></Badge>
    {open && <div className="kgd-msg-popover" style={{ position: 'absolute', right: 0, top: 28, zIndex: 50 }} role="dialog" aria-label="消息预览">
      <div>
        {[['all', '全部'], ['alarm', '报警'], ['todo', '待办'], ['notice', '通知']].map(([value, label]) => <Button key={value} type={kind === value ? 'link' : 'text'} onClick={() => setKind(value!)}>{label}</Button>)}
        <Button type={read === 'unread' ? 'link' : 'text'} onClick={() => setRead('unread')}>未读</Button>
        <Button type={read === 'read' ? 'link' : 'text'} onClick={() => setRead('read')}>已读</Button>
      </div>
      {(remote.data?.items ?? []).slice(0, 8).map((item) => <button key={item.id} className="kgd-link" style={{ display: 'block', textAlign: 'left' }} onClick={() => navigate(item.link_path || '/message/list')}>{item.title} {item.body}</button>)}
      {!remote.data?.items.length && <div>暂无数据</div>}
      <button className="kgd-link" onClick={() => navigate('/message/list')}>查看全部</button>
      <div style={{ color: '#888' }}>消息仅保留三个月</div>
    </div>}
  </span>;
}
