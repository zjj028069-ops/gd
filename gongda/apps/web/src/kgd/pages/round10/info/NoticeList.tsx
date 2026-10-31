import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Pagination, Table, Tabs, Tag } from 'antd';
import { fmtTime, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';

export function NoticeList() {
  const r10 = useR10();
  const navigate = useNavigate();
  const [tab, setTab] = useState('all');
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const remote = useList<Row>(`/api/notices${qs({ tab, keyword, page, page_size: pageSize })}`);
  const rows = remote.data?.items ?? [];
  const total = remote.data?.total ?? rows.length;
  const canWrite = remote.data?.can_manage === true;
  return <div className="kgd-card">
    <div className="kgd-toolbar">
      {canWrite && <Button type="primary" onClick={() => navigate('/notice/add')}>新增</Button>}
      <span style={{ flex: 1 }} />
      <Input style={{ width: 240 }} allowClear placeholder="标题" value={draft} onChange={(event) => setDraft(event.target.value)} onPressEnter={() => { setKeyword(draft); setPage(1); }} />
      <Button type="primary" onClick={() => { setKeyword(draft); setPage(1); }}>查询</Button>
    </div>
    <Tabs activeKey={tab} onChange={(key) => { setTab(key); setPage(1); }} items={[{ key: 'all', label: '全部' }, { key: 'read', label: '已读' }, { key: 'unread', label: '未读' }]} />
    <div className="kgd-muted" style={{ marginBottom: 8 }}>符合查询结果的共{total}条</div>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <Table size="small" rowKey="id" loading={remote.loading} pagination={false} dataSource={rows} locale={{ emptyText: '暂无数据' }} onRow={(row) => ({ onClick: () => navigate(`/notice/detail/${row.id}`), style: { cursor: 'pointer' } })} columns={[
      { title: '标题', render: (_, row) => <span style={{ fontWeight: row.read ? 400 : 600 }}>{row.title}</span> },
      { title: '发布人', render: (_, row) => row.publisher_name || '-' },
      { title: '发布时间', render: (_, row) => row.published_text ?? fmtTime(row.published_at) },
      { title: '状态', render: (_, row) => row.read ? <Tag>已读</Tag> : <Tag color="orange">未读</Tag> },
      ...(canWrite ? [{ title: '操作', width: 80, render: (_: unknown, row: Row) => <button className="kgd-link" style={{ color: '#f5222d' }} onClick={(event) => { event.stopPropagation(); r10.confirmDelete('删除通知公告', () => r10.act(`/api/notices/${row.id}`, {}, 'DELETE', '已删除')); }}>删除</button> }] : []),
    ]} />
    <div className="kgd-foot"><span /><Pagination current={page} pageSize={pageSize} total={total} showSizeChanger showQuickJumper pageSizeOptions={[10, 20, 30, 50]} showTotal={(count) => `共${count}条数据`} onChange={(next, size) => { setPage(next); setPageSize(size); }} /></div>
  </div>;
}
