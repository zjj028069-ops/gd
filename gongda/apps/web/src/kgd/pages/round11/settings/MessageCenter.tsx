import { useMemo, useState } from 'react';
import { Button, DatePicker, Modal, Tabs } from 'antd';
import { useRemote } from '../../../../masterTools';
import { useR10 } from '../../round10/shared';
import type { Row } from '../../round10/shared';
import dayjs from 'dayjs';

export function MessageCenterPage() {
  const r10 = useR10();
  const [category, setCategory] = useState('all');
  const [kind, setKind] = useState('all');
  const [read, setRead] = useState('unread');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sortOpen, setSortOpen] = useState(false);
  const query = useMemo(() => {
    const p = new URLSearchParams({ category, kind, read });
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString();
  }, [category, kind, read, from, to]);
  const remote = useRemote<{ categories: Row[]; items: Row[]; unread: number }>(`/api/messages/center?${query}`, r10.revision, r10.onExpired);
  const cats = remote.data?.categories ?? [];
  const [draftKeys, setDraftKeys] = useState<string[]>([]);
  return <div className="kgd-card" style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, minHeight: 520 }}>
    <aside style={{ borderRight: '1px solid #f0f0f0', paddingRight: 12 }}>
      {cats.map((cat) => <button key={String(cat.key)} className="kgd-link" style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 8, fontWeight: category === cat.key ? 600 : 400 }} onClick={() => setCategory(String(cat.key))}>
        <span>{cat.name}</span><span>{Number(cat.unread) || ''}</span>
      </button>)}
      <Button size="small" onClick={() => { setDraftKeys(cats.map((c) => String(c.key))); setSortOpen(true); }}>调整排序</Button>
      <div className="kgd-muted" style={{ marginTop: 12 }}>消息仅保留三个月</div>
    </aside>
    <section>
      <Tabs activeKey={kind} onChange={setKind} items={[{ key: 'all', label: '全部' }, { key: 'alarm', label: '报警' }, { key: 'todo', label: '待办' }, { key: 'notice', label: '通知' }]} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <Button type={read === 'unread' ? 'primary' : 'default'} onClick={() => setRead('unread')}>未读</Button>
        <Button type={read === 'read' ? 'primary' : 'default'} onClick={() => setRead('read')}>已读</Button>
        <DatePicker.RangePicker onChange={(values) => { setFrom(values?.[0] ? dayjs(values[0]).format('YYYY-MM-DD') : ''); setTo(values?.[1] ? dayjs(values[1]).format('YYYY-MM-DD') : ''); }} />
        <Button onClick={() => void r10.act('/api/system/messages/read-all', {})}>全部已读</Button>
        <Button onClick={() => void r10.act('/api/system/messages/clear', {})}>清空</Button>
      </div>
      <table className="data-table" style={{ width: '100%' }}><thead><tr><th>类型</th><th>标题</th><th>内容</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>
          {(remote.data?.items ?? []).map((item) => <tr key={String(item.id)}><td>{item.kind_text}</td><td>{item.title}</td><td>{item.body}</td><td>{item.read_text}</td><td>{item.created_text}</td></tr>)}
          {!remote.data?.items?.length && <tr><td colSpan={5}>暂无数据</td></tr>}
        </tbody>
      </table>
    </section>
    <Modal open={sortOpen} title="调整排序" onCancel={() => setSortOpen(false)} onOk={() => void r10.act('/api/messages/category-sort', { keys: draftKeys }, 'PUT').then((ok) => { if (ok) setSortOpen(false); })}>
      <p>拖动下方顺序（上移/下移）后确定保存。</p>
      {draftKeys.map((key, index) => {
        const name = cats.find((c) => c.key === key)?.name ?? key;
        return <div key={key} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <span style={{ flex: 1 }}>{name}</span>
          <Button size="small" disabled={index === 0} onClick={() => setDraftKeys((keys) => { const next = [...keys]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; })}>上移</Button>
          <Button size="small" disabled={index === draftKeys.length - 1} onClick={() => setDraftKeys((keys) => { const next = [...keys]; [next[index + 1], next[index]] = [next[index]!, next[index + 1]!]; return next; })}>下移</Button>
        </div>;
      })}
    </Modal>
  </div>;
}
