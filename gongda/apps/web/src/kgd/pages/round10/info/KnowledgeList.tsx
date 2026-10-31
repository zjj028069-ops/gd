import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Modal, Pagination, Table, Tag } from 'antd';
import { HolderOutlined } from '@ant-design/icons';
import { fmtTime, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';

export type Category = { id: string; name: string; is_default?: boolean; article_count?: number; sort_no?: number };

export function KnowledgeList() {
  const r10 = useR10();
  const navigate = useNavigate();
  const [category, setCategory] = useState('all');
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [manage, setManage] = useState(false);
  const categories = useList<Category>('/api/knowledge/categories');
  const remote = useList<Row>(`/api/knowledge/articles${qs({ category_id: category, keyword, page, page_size: pageSize })}`);
  const rows = remote.data?.items ?? [];
  const total = remote.data?.total ?? rows.length;
  const cats = categories.data?.items ?? [];
  const allCount = Number(categories.data?.total ?? cats.reduce((sum, item) => sum + Number(item.article_count ?? 0), 0));
  const canWrite = categories.data?.can_manage === true;
  return <div className="kgd-card">
    <div className="kgd-toolbar">
      {canWrite && <Button type="primary" onClick={() => navigate('/knowledge/add')}>新增</Button>}
      {canWrite && <Button onClick={() => setManage(true)}>管理分类</Button>}
      <span style={{ flex: 1 }} />
      <Input style={{ width: 240 }} allowClear placeholder="标题/标签" value={draft} onChange={(event) => setDraft(event.target.value)} onPressEnter={() => { setKeyword(draft); setPage(1); }} />
      <Button type="primary" onClick={() => { setKeyword(draft); setPage(1); }}>查询</Button>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16 }}>
      <aside style={{ borderRight: '1px solid #f0f0f0' }}>
        {[{ id: 'all', name: '全部', article_count: allCount }, ...cats].map((item) => <button key={item.id} type="button" className={`kgd-sub-item ${category === item.id ? 'active' : ''}`} style={{ width: '100%', display: 'flex', justifyContent: 'space-between' }} onClick={() => { setCategory(item.id); setPage(1); }}><span>{item.name}</span><span className="kgd-muted">{item.article_count ?? 0}</span></button>)}
      </aside>
      <div>
        <div className="kgd-muted" style={{ marginBottom: 8 }}>符合查询结果的共{total}条</div>
        {(remote.error || categories.error) && <div className="kgd-banner">{remote.error || categories.error}</div>}
        <Table size="small" rowKey="id" loading={remote.loading} pagination={false} dataSource={rows} locale={{ emptyText: '暂无数据' }} columns={[
          { title: '标题', render: (_, row) => <button className="kgd-link" onClick={() => navigate(`/knowledge/detail/${row.id}`)}>{row.title}</button> },
          { title: '分类', render: (_, row) => row.category_name || '-' },
          { title: '标签', render: (_, row) => (row.tags ?? []).length ? (row.tags as string[]).map((tag) => <Tag key={tag}>{tag}</Tag>) : '-' },
          { title: '公开状态', render: (_, row) => row.is_public ? <Tag color="green">公开</Tag> : <Tag>不公开</Tag> },
          { title: '创建人', render: (_, row) => row.creator_name || '-' },
          { title: '创建时间', render: (_, row) => row.created_text ?? fmtTime(row.created_at) },
          { title: '操作', width: 160, render: (_, row) => <>
            <button className="kgd-link" onClick={() => navigate(`/knowledge/detail/${row.id}`)}>查看</button>{' '}
            {canWrite && <><button className="kgd-link" onClick={() => navigate(`/knowledge/edit/${row.id}`)}>修改</button>{' '}
            <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除知识', () => r10.act(`/api/knowledge/articles/${row.id}`, {}, 'DELETE', '已删除'))}>删除</button></>}
          </> },
        ]} />
        <div className="kgd-foot"><span /><Pagination current={page} pageSize={pageSize} total={total} showSizeChanger showQuickJumper pageSizeOptions={[10, 20, 30, 50]} showTotal={(count) => `共${count}条数据`} onChange={(next, size) => { setPage(next); setPageSize(size); }} /></div>
      </div>
    </div>
    {manage && <CategoryModal items={cats} onClose={() => setManage(false)} />}
  </div>;
}

function CategoryModal({ items, onClose }: { items: Category[]; onClose: () => void }) {
  const r10 = useR10();
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  async function save() {
    if (!editing?.name.trim()) { r10.message.warning('请填写分类名称'); return; }
    const result = await r10.act(editing.id ? `/api/knowledge/categories/${editing.id}` : '/api/knowledge/categories', { name: editing.name.trim() }, editing.id ? 'PUT' : 'POST');
    if (result) setEditing(null);
  }
  async function reorder(to: number) {
    if (drag === null || drag === to) return;
    const next = [...items];
    const [moved] = next.splice(drag, 1);
    next.splice(to, 0, moved!);
    setDrag(null);
    await r10.act('/api/knowledge/categories/reorder', { ids: next.map((item) => item.id) }, 'POST', false);
  }
  return <Modal title="管理分类" open onCancel={onClose} footer={<Button type="primary" onClick={onClose}>确定</Button>} width={560}>
    <div className="kgd-toolbar"><Button type="primary" onClick={() => setEditing({ name: '' })}>+新增分类</Button></div>
    <Table size="small" rowKey="id" pagination={false} dataSource={items} onRow={(_, index) => ({ draggable: true, onDragStart: () => setDrag(index ?? null), onDragOver: (event) => event.preventDefault(), onDrop: () => void reorder(index ?? 0) })} columns={[
      { title: '排序', width: 60, render: () => <HolderOutlined style={{ cursor: 'grab' }} /> },
      { title: '分类名称', dataIndex: 'name' },
      { title: '文章数', render: (_, row) => row.article_count ?? 0 },
      { title: '操作', width: 140, render: (_, row) => row.is_default ? <span className="kgd-muted">默认分类不能删除</span> : <>
        <button className="kgd-link" onClick={() => setEditing({ id: row.id, name: row.name })}>修改</button>{' '}
        <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除分类', () => r10.act(`/api/knowledge/categories/${row.id}`, {}, 'DELETE', '已删除'), '删除后该分类下的知识将移到「默认」分类，确定删除？')}>删除</button>
      </> },
    ]} />
    <Modal title={editing?.id ? '修改分类' : '新增分类'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => void save()} okText="确定" cancelText="取消" destroyOnHidden>
      <Input maxLength={30} placeholder="分类名称" value={editing?.name ?? ''} onChange={(event) => setEditing((current) => current ? { ...current, name: event.target.value } : current)} />
    </Modal>
  </Modal>;
}
