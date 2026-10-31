import { useState } from 'react';
import { App, Button, Modal, Radio, Switch, Table } from 'antd';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { FlowModal } from './FlowModal';

const tips: Record<string, string> = {
  customer: '此处可配置多种审核流程，配置的审核流程可用于合同报价单，合同订单，收支记录和销售费用。',
  stock: '此处可配置多种审核流程，配置的审核流程可用于仓库相关出入库单、调拨单和备件申请。',
  purchase: '此处可配置多种审核流程，配置的审核流程可用于采购计划、采购单、付款记录和发票管理。',
};

type Flow = { id: string; name: string; object_text: string; enabled_text: string; allow_withdraw: boolean; enabled: boolean; object_types: string[]; levels: { sign_mode: 'and' | 'or'; approver_ids: string[] }[] };

export function AuditSettingPage({ module }: { module: 'customer' | 'stock' | 'purchase' }) {
  const { message } = App.useApp();
  const { session, revision, onChanged, onExpired } = useKgd();
  const remote = useRemote<{ items: Flow[]; tip?: string }>(`/api/audit/flows?module=${module}`, revision, onExpired);
  const [editing, setEditing] = useState<Flow | null | undefined>(undefined);
  const [segment, setSegment] = useState('all');
  async function copy(row: Flow) {
    await apiRequest(`/api/audit/flows/${row.id}/copy`, { method: 'POST', csrfToken: session.csrf_token, body: {} });
    message.success('已复制');
    onChanged();
  }
  function remove(row: Flow) {
    Modal.confirm({ title: '删除审核流程', content: `确定删除「${row.name}」？`, okText: '确定', cancelText: '取消', onOk: async () => {
      await apiRequest(`/api/audit/flows/${row.id}`, { method: 'DELETE', csrfToken: session.csrf_token });
      message.success('已删除');
      onChanged();
    } });
  }
  async function toggle(row: Flow, enabled: boolean) {
    await apiRequest(`/api/audit/flows/${row.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body: { name: row.name, enabled, allow_withdraw: row.allow_withdraw, object_types: row.object_types, levels: row.levels } });
    onChanged();
  }
  const items = (remote.data?.items ?? []).filter((row) => segment === 'all' || (segment === 'on' ? row.enabled : !row.enabled));
  return <div className="kgd-card">
    <p>{remote.data?.tip || tips[module]}</p>
    <div style={{ marginBottom: 12 }}>
      <Radio.Group value={segment} onChange={(event) => setSegment(event.target.value)}>
        <Radio.Button value="all">全部</Radio.Button>
        <Radio.Button value="on">启用</Radio.Button>
        <Radio.Button value="off">禁用</Radio.Button>
      </Radio.Group>
      <Button type="primary" style={{ background: '#52c41a', marginLeft: 12 }} onClick={() => setEditing(null)}>+新增</Button>
    </div>
    <Table size="small" rowKey="id" loading={remote.loading} dataSource={items} locale={{ emptyText: '暂无数据' }} pagination={{ pageSize: 30, showSizeChanger: true, showTotal: (count) => `共${count}条数据` }} columns={[
      { title: '审核流程名称', dataIndex: 'name' },
      { title: '审核对象', dataIndex: 'object_text', render: (value: string) => value || '-' },
      { title: '启用/禁用', render: (_: unknown, row: Flow) => <Switch checked={row.enabled} checkedChildren="启用" unCheckedChildren="禁用" onChange={(checked) => void toggle(row, checked)} /> },
      { title: '操作', render: (_: unknown, row: Flow) => <>
        <Button type="link" onClick={() => setEditing(row)}>修改</Button>
        <Button type="link" onClick={() => void copy(row)}>复制</Button>
        <Button type="link" danger onClick={() => void remove(row)}>删除</Button>
      </> },
    ]} />
    {editing !== undefined && <FlowModal module={module} flow={editing} onClose={() => setEditing(undefined)} />}
  </div>;
}
