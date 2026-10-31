import { useState } from 'react';
import { Form, Modal, Select } from 'antd';
import { ListFrame } from '../../../ListFrame';
import type { QueryField } from '../../../ListFrame';
import { useQueryState } from '../../../kit';
import { dash, qs, useList, useR10 } from '../../round10/shared';
import type { Row } from '../../round10/shared';

export function StationPosts() {
  const r10 = useR10();
  const list = useQueryState();
  const [edit, setEdit] = useState<Row | null>(null);
  const processes = useList<Row>('/api/processes');
  const queryFields: QueryField[] = [
    { key: 'name', label: '姓名' },
    { key: 'department', label: '部门' },
    { key: 'role', label: '角色' },
  ];
  const remote = useList<Row>(`/api/station-posts${qs({ ...list.query })}`);
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame<Row> pageKey="station_list" exportName="岗位安排" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={queryFields} defaultQueryKeys={['name']} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} onApplyQuery={list.onApplyQuery}
      page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage} clientPaging
      columns={[
        { key: 'name', title: '姓名', render: (row) => dash(row.name) },
        { key: 'department', title: '部门', render: (row) => dash(row.department) },
        { key: 'role', title: '角色', render: (row) => dash(row.role) },
        { key: 'status', title: '状态', render: (row) => dash(row.status) },
        { key: 'produce', title: '生产工序', render: (row) => dash(row.produce_names) },
        { key: 'inspect', title: '质检工序', render: (row) => dash(row.inspect_names) },
        { key: 'actions', title: '操作', render: (row) => <button className="kgd-link" onClick={() => setEdit(row)}>修改</button> },
      ]} />
    {edit && <Modal title="修改岗位安排" open onCancel={() => setEdit(null)} onOk={() => void r10.act(`/api/station-posts/${edit.id}`, { produce_ids: edit.produce_ids ?? [], inspect_ids: edit.inspect_ids ?? [] }, 'PUT').then((ok) => { if (ok) setEdit(null); })} okText="确定" cancelText="取消">
      <Form layout="vertical">
        <Form.Item label="生产工序"><Select mode="multiple" value={(edit.produce_ids as string[]) ?? []} onChange={(value) => setEdit({ ...edit, produce_ids: value })} options={(processes.data?.items ?? []).map((item) => ({ value: String(item.id), label: String(item.name) }))} /></Form.Item>
        <Form.Item label="质检工序"><Select mode="multiple" value={(edit.inspect_ids as string[]) ?? []} onChange={(value) => setEdit({ ...edit, inspect_ids: value })} options={(processes.data?.items ?? []).map((item) => ({ value: String(item.id), label: String(item.name) }))} /></Form.Item>
      </Form>
    </Modal>}
  </>;
}
