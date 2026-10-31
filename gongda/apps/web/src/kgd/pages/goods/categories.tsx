import { useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { showError, useCommand } from '../../kit';
import { buildTree } from './shared';
import type { Category, CategoryNode } from './shared';

export function CategoryBoard({ kind }: { kind: 'goods' | 'bom' }) {
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const remote = useRemote<{ items: Category[] }>(`/api/products/categories?kind=${kind}`, revision, onExpired);
  const [expanded, setExpanded] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<{ parent: string | null; name: string; id?: string } | null>(null);
  const [catErr, setCatErr] = useState('');
  const items = remote.data?.items ?? [];
  const openIds = expanded ?? items.map((item) => item.id);
  const tree = buildTree(items);
  async function move(id: string, direction: 'up' | 'down') {
    try { await command.send(`/api/products/categories/${id}/move`, { direction }); } catch (failure) { command.setError(showError(failure)); }
  }
  async function remove(id: string) {
    Modal.confirm({ title: '删除类别', content: '确定删除该类别？', okText: '确定', cancelText: '取消', onOk: async () => { try { await command.send(`/api/products/categories/${id}`, {}, 'DELETE'); } catch (failure) { command.setError(showError(failure)); } } });
  }
  async function saveDraft() {
    if (!draft || !draft.name.trim()) { setCatErr('请填写类别名称'); command.setError('请填写类别名称'); return; }
    setCatErr('');
    try {
      if (draft.id) await command.send(`/api/products/categories/${draft.id}`, { name: draft.name.trim() }, 'PATCH');
      else await command.send('/api/products/categories', { kind, name: draft.name.trim(), parent_id: draft.parent });
      setDraft(null);
    } catch (failure) { command.setError(showError(failure)); }
  }
  function rows(nodes: CategoryNode[], depth: number) {
    return nodes.map((node, index) => <div key={node.id}>
      <div className="cat-row" style={{ paddingLeft: 8 + depth * 18 }}>
        <span>{node.children.length ? <button className="kgd-link" onClick={() => setExpanded(openIds.includes(node.id) ? openIds.filter((id) => id !== node.id) : [...openIds, node.id])}>{openIds.includes(node.id) ? '▾' : '▸'}</button> : <span className="kgd-dot">·</span>} {node.name}</span>
        <span className="ops">
          {index > 0 && <Button type="link" onClick={() => void move(node.id, 'up')}>上移</Button>}
          {index < nodes.length - 1 && <Button type="link" onClick={() => void move(node.id, 'down')}>下移</Button>}
          <Button type="link" onClick={() => setDraft({ parent: node.id, name: '' })}>新增</Button>
          <Button type="link" onClick={() => setDraft({ parent: node.parent_id, name: node.name, id: node.id })}>修改</Button>
          <Button type="link" danger onClick={() => remove(node.id)}>删除</Button>
        </span>
      </div>
      {openIds.includes(node.id) && rows(node.children, depth + 1)}
    </div>);
  }
  return <div>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <div className="kgd-toolbar">
      {/* 保留带 + 图标的「新增」；去掉纯文案重复按钮（现网叠了两处同一 handler） */}
      <Button type="primary" icon={<PlusOutlined />} onClick={() => { setCatErr(''); setDraft({ parent: null, name: '' }); }}>新增</Button>
      <Button onClick={() => setExpanded(items.map((item) => item.id))}>全部展开</Button>
      <Button onClick={() => setExpanded([])}>全部折叠</Button>
    </div>
    <div className="cat-row"><b>分类名称</b><b>操作</b></div>
    {rows(tree, 0)}
    {!items.length && <div className="kgd-muted">暂无数据</div>}
    <Modal title={draft?.id ? '修改类别' : '新增类别'} open={!!draft} onCancel={() => setDraft(null)} onOk={() => void saveDraft()} okText="确定" cancelText="取消" confirmLoading={command.busy}>
      {catErr ? <div className="kgd-banner kgd-field-error">{catErr}</div> : null}
      <span className={catErr ? 'kgd-field-error-label' : undefined}>类别名称</span>
      <Input placeholder="类别名称" className={catErr ? 'kgd-field-error' : undefined} value={draft?.name ?? ''} onChange={(event) => { setCatErr(''); setDraft((current) => current ? { ...current, name: event.target.value } : current); }} />
    </Modal>
  </div>;
}
