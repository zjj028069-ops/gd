import { useMemo, useState } from 'react';
import { App, Button, Form, Input, Modal, Select } from 'antd';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import { useQueryState } from '../../kit';

type Dept = { id: string; name: string; code: string; path: string; parent_id: string | null; created_text?: string; children?: Dept[] };

function nestDepartments(items: Dept[]): Dept[] {
  const ids = new Set(items.map((item) => item.id));
  const grouped = new Map<string | null, Dept[]>();
  for (const item of items) {
    const parent = item.parent_id && ids.has(item.parent_id) ? item.parent_id : null;
    const bucket = grouped.get(parent) ?? [];
    bucket.push(item);
    grouped.set(parent, bucket);
  }
  const walk = (parent: string | null): Dept[] => (grouped.get(parent) ?? []).map((item) => {
    const children = walk(item.id);
    return children.length ? { ...item, children } : { ...item, children: undefined };
  });
  return walk(null);
}

function branchIds(nodes: Dept[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.children?.length) {
      ids.push(node.id);
      ids.push(...branchIds(node.children));
    }
  }
  return ids;
}

function blockedParentIds(items: Dept[], id: string) {
  const blocked = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (item.parent_id && blocked.has(item.parent_id) && !blocked.has(item.id)) {
        blocked.add(item.id);
        grew = true;
      }
    }
  }
  return blocked;
}

export function DepartmentPage() {
  const { session, revision, onChanged, onExpired } = useKgd();
  const { message } = App.useApp();
  const list = useQueryState();
  const remote = useRemote<{ items: Dept[] }>('/api/system/departments', revision, onExpired);
  const items = remote.data?.items ?? [];
  const tree = useMemo(() => nestDepartments(items), [items]);
  const branches = useMemo(() => branchIds(tree), [tree]);
  const [expanded, setExpanded] = useState<string[] | null>(null);
  const openIds = expanded ?? branches;
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Dept | null>(null);
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string | undefined>();
  function begin(parentId?: string, row?: Dept) {
    setEdit(row ?? null);
    setName(row?.name ?? '');
    setParent(row?.parent_id ?? parentId);
    setOpen(true);
  }
  async function add() {
    if (!name.trim()) { message.error('请填写部门名称'); return; }
    try {
      if (edit) await apiRequest(`/api/system/departments/${edit.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body: { name, parent_id: parent ?? null } });
      else await apiRequest('/api/system/departments', { method: 'POST', csrfToken: session.csrf_token, body: { name, parent_id: parent ?? null } });
      setOpen(false);
      message.success('已保存');
      onChanged();
    } catch (error) { message.error(error instanceof Error ? error.message : '保存失败'); }
  }
  async function remove(row: Dept) {
    try {
      await apiRequest(`/api/system/departments/${row.id}`, { method: 'DELETE', csrfToken: session.csrf_token });
      message.success('已删除');
      onChanged();
    } catch (error) { message.error(error instanceof Error ? error.message : '删除失败'); }
  }
  return <>
    <ListFrame pageKey="departments" rows={tree} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'name', label: '部门名称' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={list.pageSize} total={items.length} onPage={list.onPage}
      treeExpand={{ expandedRowKeys: openIds, onChange: (keys) => setExpanded(keys.map(String)) }}
      toolbar={<>
        <Button type="primary" onClick={() => begin()}>新增</Button>
        <Button onClick={() => setExpanded(null)}>全部展开</Button>
        <Button onClick={() => setExpanded([])}>全部折叠</Button>
      </>}
      columns={[
        { key: 'name', title: '部门名称', render: (row) => row.name },
        { key: 'created', title: '创建时间', render: (row) => row.created_text || '-' },
        { key: 'actions', title: '操作', render: (row) => <>
          <Button type="link" onClick={() => begin(row.id)}>新增下级部门</Button>
          <Button type="link" onClick={() => begin(undefined, row)}>修改</Button>
          <Button type="link" danger onClick={() => void remove(row)}>删除</Button>
        </> },
      ]} />
    <Modal title={edit ? '修改部门信息' : '新增部门信息'} open={open} onCancel={() => setOpen(false)} onOk={() => void add()} okText="确定" cancelText="取消">
      <Form layout="vertical">
        <Form.Item label="上级部门"><Select allowClear placeholder="上级部门" value={parent} onChange={setParent} options={items.filter((item) => !edit || !blockedParentIds(items, edit.id).has(item.id)).map((item) => ({ value: item.id, label: item.path }))} /></Form.Item>
        <Form.Item label="名称" required><Input value={name} onChange={(event) => setName(event.target.value)} /></Form.Item>
      </Form>
    </Modal>
  </>;
}
