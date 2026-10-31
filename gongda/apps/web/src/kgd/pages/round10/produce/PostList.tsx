import { useState } from 'react';
import { Button, Form, Input, Modal } from 'antd';
import { ListFrame } from '../../../ListFrame';
import type { QueryField } from '../../../ListFrame';
import { useQueryState } from '../../../kit';
import { dash, MemberPick, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';
import { blank, DictPick } from './common';

const options = (items: Row[] | undefined) => [{ value: '', label: '全部' }, ...(items ?? []).map((item) => ({ value: String(item.id), label: String(item.name ?? '') }))];

export function PostList() {
  const r10 = useR10();
  const list = useQueryState();
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const shops = useList<Row>('/api/machines/shops');
  const lines = useList<Row>('/api/machines/lines');
  const processes = useList<Row>('/api/processes');
  const queryFields: QueryField[] = [
    { key: 'name', label: '岗位名称' },
    { key: 'shop_id', label: '车间', kind: 'select', options: options(shops.data?.items) },
    { key: 'line_id', label: '产线', kind: 'select', options: options(lines.data?.items) },
    { key: 'process_id', label: '关联工序', kind: 'select', options: options(processes.data?.items) },
  ];
  const remote = useList<Row>(`/api/posts${qs({ ...list.query, page: list.page, page_size: list.pageSize })}`);
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame<Row> pageKey="post_arrange" exportName="岗位安排" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={queryFields} defaultQueryKeys={['name', 'shop_id', 'line_id']} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} onApplyQuery={list.onApplyQuery}
      page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage} clientPaging={false}
      toolbar={<Button type="primary" onClick={() => setEdit('new')}>新增</Button>}
      columns={[
        { key: 'name', title: '岗位名称', render: (row) => dash(row.name) },
        { key: 'shop', title: '车间', render: (row) => dash(row.shop_name) },
        { key: 'line', title: '产线', render: (row) => dash(row.line_name) },
        { key: 'processes', title: '关联工序', width: 220, render: (row) => dash(row.process_names) },
        { key: 'members', title: '在岗人员', width: 220, render: (row) => dash(row.member_names) },
        { key: 'duty', title: '岗位职责', width: 220, render: (row) => dash(row.duty) },
        { key: 'note', title: '备注', render: (row) => dash(row.note) },
        { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
        { key: 'created', title: '创建时间', width: 160, render: (row) => dash(row.created_text) },
        { key: 'actions', title: '操作', width: 120, render: (row) => <>
          <button className="kgd-link" onClick={() => setEdit(row)}>修改</button>{' '}
          <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除岗位', () => r10.act(`/api/posts/${row.id}`, {}, 'DELETE', '已删除'))}>删除</button>
        </> },
      ]} />
    {edit && <PostModal row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
  </>;
}

function PostModal({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const r10 = useR10();
  const [name, setName] = useState<string>(row?.name ?? '');
  const [shop, setShop] = useState<string>(row?.shop_id ?? '');
  const [line, setLine] = useState<string>(row?.line_id ?? '');
  const [processIds, setProcessIds] = useState<string[]>(row?.process_ids ?? []);
  const [memberIds, setMemberIds] = useState<string[]>(row?.member_ids ?? []);
  const [duty, setDuty] = useState<string>(blank(row?.duty));
  const [note, setNote] = useState<string>(blank(row?.note));
  async function save() {
    if (!name.trim()) { r10.message.warning('请填写岗位名称'); return; }
    const body = { name: name.trim(), shop_id: shop || null, line_id: line || null, process_ids: processIds, member_ids: memberIds, duty, note, ...(row ? { version: row.version } : {}) };
    const result = await r10.act(row ? `/api/posts/${row.id}` : '/api/posts', body, row ? 'PUT' : 'POST');
    if (result) onClose();
  }
  return <Modal title={row ? '修改岗位' : '新增岗位'} open onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消" confirmLoading={r10.busy} destroyOnHidden width={620}>
    <Form layout="vertical">
      <Form.Item label="岗位名称" required><Input maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></Form.Item>
      <div style={{ display: 'flex', gap: 12 }}>
        <Form.Item label="车间" style={{ flex: 1 }}><DictPick path="/api/machines/shops" value={shop} onChange={setShop} /></Form.Item>
        <Form.Item label="产线" style={{ flex: 1 }}><DictPick path="/api/machines/lines" value={line} onChange={setLine} /></Form.Item>
      </div>
      <Form.Item label="关联工序"><DictPick path="/api/processes" multiple value={processIds} onChange={setProcessIds} placeholder="请选择工序" /></Form.Item>
      <Form.Item label="在岗人员"><MemberPick multiple value={memberIds} onChange={setMemberIds} placeholder="请选择人员" /></Form.Item>
      <Form.Item label="岗位职责"><Input.TextArea rows={3} maxLength={500} showCount value={duty} onChange={(event) => setDuty(event.target.value)} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
    </Form>
  </Modal>;
}
