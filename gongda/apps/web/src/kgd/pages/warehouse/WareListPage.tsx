import { useMemo, useState } from 'react';
import { App, Button, Dropdown, Form, Input, Modal, Switch } from 'antd';
import QRCode from 'qrcode';
import { QrImage } from '../../qr';
import { useRemote } from '../../../masterTools';
import { ListFrame, type ListColumn } from '../../ListFrame';
import { confirmText, showError, useQueryState, beijingTime } from '../../kit';
import { MemberSelect, RegionSelect } from '../money/shared';
import { useWarehouseApi } from './useWarehouseApi';
import type { WhRec } from './useWarehouseApi';
import { requestKey } from '../../../requestKey';

export function WareListPage() {
  const { message } = App.useApp();
  const api = useWarehouseApi();
  const list = useQueryState();
  const [open, setOpen] = useState<WhRec | null>(null);
  const [qr, setQr] = useState<WhRec | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const remote = useRemote<{ items: WhRec[] }>('/api/warehouse/warehouses', api.revision, api.onExpired);
  const members = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', api.revision, api.onExpired);
  const tab = list.chips.active ?? 'enabled';
  const rows = useMemo(() => (remote.data?.items ?? []).filter((row) => {
    if (tab === 'enabled' && row.active === false) return false;
    if (tab === 'disabled' && row.active !== false) return false;
    if ((list.query.name ?? '') && !String(row.name ?? '').includes(list.query.name ?? '')) return false;
    if ((list.query.manager ?? '') && !memberNames(row.manager_ids).includes(list.query.manager ?? '')) return false;
    if ((list.query.location ?? '') && ![row.province, row.city, row.district, row.address].filter(Boolean).join(' ').includes(list.query.location ?? '')) return false;
    return true;
  }).map((row): WhRec => ({ ...row, id: String(row.id) })), [remote.data, list.query, tab, members.data]);
  function memberNames(ids: unknown) { return (Array.isArray(ids) ? ids : []).map((id) => members.data?.items.find((m) => m.id === id)?.display_name ?? String(id)).join(','); }
  async function batch(active: boolean) {
    const targets = rows.filter((row) => chosen.includes(row.id) && (row.active !== false) !== active);
    const failed: string[] = [];
    for (const row of targets) {
      try { await api.send(`/api/warehouse/warehouses/${row.id}`, { active, version: row.version }, 'PATCH'); } catch (error) { failed.push(`${String(row.name)}：${showError(error)}`); }
    }
    setChosen([]);
    if (failed.length) Modal.warning({ title: '部分仓库未更新', content: <div>{failed.map((item) => <div key={item}>{item}</div>)}</div> });
    else message.success(`已${active ? '启用' : '禁用'} ${targets.length} 个仓库`);
  }
  async function downloadQr(row: WhRec) {
    const link = document.createElement('a');
    link.href = await QRCode.toDataURL(qrText(row), { width: 440, margin: 2 });
    link.download = `${String(row.name)}.png`;
    link.click();
  }
  async function remove(row: WhRec) {
    try {
      await api.send(`/api/warehouse/warehouses/${row.id}`, {}, 'DELETE');
      message.success('已删除');
    } catch (error) { message.error(showError(error)); }
  }
  async function toggle(row: WhRec, active: boolean) {
    try {
      await api.send(`/api/warehouse/warehouses/${row.id}`, { active, version: row.version }, 'PATCH');
      message.success('已更新');
    } catch (error) { message.error(showError(error)); }
  }
  const columns: ListColumn<WhRec>[] = [
    { key: 'name', title: '仓库名', render: (row) => row.name },
    { key: 'location', title: '仓库位置', render: (row) => <button type="button" className="kgd-link">📍 {[row.province, row.city, row.district, row.address].filter(Boolean).join(' ')}</button> },
    { key: 'managers', title: '管理员', render: (row) => memberNames(row.manager_ids) },
    { key: 'active', title: '状态', render: (row) => <Switch checked={row.active !== false} checkedChildren="启用" unCheckedChildren="禁用" onChange={(value) => void toggle(row, value)} /> },
    { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at ?? '', '') },
    { key: 'actions', title: '操作', width: 200, render: (row) => <span>
      <button type="button" className="kgd-link" onClick={() => setQr(row)}>查看二维码</button>
      <button type="button" className="kgd-link" onClick={() => setOpen(row)}>修改</button>
      <button type="button" className="kgd-link" onClick={() => confirmText('删除仓库', '已经有库存或流水的仓库不能删除', () => void remove(row))}>删除</button>
    </span> },
  ];
  return <>
    <ListFrame pageKey="ware-list" columns={columns} rows={rows} loading={remote.loading} error={remote.error}
      chips={[{ key: 'active', label: '状态', options: [{ value: 'all', label: '全部' }, { value: 'enabled', label: '⊙启用' }, { value: 'disabled', label: '⊘禁用' }] }]}
      chipValue={{ active: tab }} onChip={list.onChip}
      queryFields={[{ key: 'name', label: '仓库名' }, { key: 'manager', label: '管理员' }, { key: 'location', label: '仓库位置' }]}
      rowSelection={{ selected: chosen, onChange: setChosen }}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      toolbar={<><Button type="primary" onClick={() => setOpen({} as WhRec)}>新增</Button><Dropdown disabled={!chosen.length || api.busy} menu={{ items: [{ key: 'on', label: '批量启用' }, { key: 'off', label: '批量禁用' }], onClick: ({ key }) => void batch(key === 'on') }}><Button>批量操作</Button></Dropdown></>}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage} />
    {qr && <Modal title="查看二维码" open onCancel={() => setQr(null)} footer={<><Button onClick={() => setQr(null)}>关闭</Button><Button type="primary" onClick={() => void downloadQr(qr)}>下载二维码</Button></>}>
      <div style={{ textAlign: 'center' }}><QrImage text={qrText(qr)} /><div>{String(qr.name ?? '')}</div></div>
    </Modal>}
    {open && <WareModal row={open.id ? open : null} onClose={() => setOpen(null)} revision={api.revision} />}
  </>;
}

function qrText(row: WhRec) {
  return `${window.location.origin}/ware/list?warehouse_id=${encodeURIComponent(String(row.id))}`;
}

function WareModal({ row, onClose, revision }: { row: WhRec | null; onClose: () => void; revision: number }) {
  const { message } = App.useApp();
  const api = useWarehouseApi();
  const [name, setName] = useState(String(row?.name ?? ''));
  const [region, setRegion] = useState([row?.province, row?.city, row?.district].filter(Boolean).join('/'));
  const [address, setAddress] = useState(String(row?.address ?? ''));
  const [managers, setManagers] = useState<string[]>((row?.manager_ids as string[] | undefined) ?? []);
  async function save() {
    if (!name.trim()) { message.error('请填写仓库名'); return; }
    if (!managers.length) { message.error('请选择管理员'); return; }
    if (!region) { message.error('请选择仓库位置'); return; }
    const [province, city, district] = region.split('/');
    try {
      if (row?.id) await api.send(`/api/warehouse/warehouses/${row.id}`, { name, province, city, district, address, manager_ids: managers, version: row.version }, 'PATCH');
      else await api.send('/api/warehouse/warehouses', { request_key: requestKey(), name, province, city, district, address, manager_ids: managers });
      message.success('已保存');
      onClose();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title={row ? '修改仓库' : '新增仓库'} open onCancel={onClose} onOk={() => void save()} okText="确 定" cancelText="取 消" confirmLoading={api.busy}>
    <Form layout="vertical">
      <Form.Item label="仓库名" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Form.Item>
      <Form.Item label="管理员" required><MemberSelect multiple revision={revision} value={managers} onChange={setManagers} /></Form.Item>
      <Form.Item label="仓库位置" required><RegionSelect value={region} onChange={setRegion} /></Form.Item>
      <Form.Item label="详细地址"><Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="详细地址" /></Form.Item>
    </Form>
  </Modal>;
}
