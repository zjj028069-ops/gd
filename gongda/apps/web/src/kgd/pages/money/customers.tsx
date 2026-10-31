import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Dropdown, Form, Input, Modal, Select } from 'antd';
import { hasPoint } from '../../../api';
import { useKgd } from '../../context';
import { App } from 'antd';
import { apiRequest } from '../../../api';
import { ExtensionAddDialog } from '../../dialogs';
import { ExtFieldInputs } from '../../extensions/ExtFieldInputs';
import { useEntityExtensions } from '../../extensions/useEntityExtensions';
import { useRemote } from '../../../masterTools';
import { ListFrame } from '../../ListFrame';
import { confirmText, showError, StatusTag, useQueryState, beijingTime } from '../../kit';
import { downloadBase64, readFileBase64, type Rec, RegionSelect, useMoney } from './shared';
import { requestKey } from '../../../requestKey';

export function CustomerList() {
  const { pathname } = useLocation();
  const detailId = pathname.startsWith('/customer/detail/') ? pathname.split('/').pop() ?? '' : '';
  const { message } = App.useApp();
  const money = useMoney();
  const { session } = useKgd();
  const detail = useRemote<{ customer?: Rec; error?: string }>(detailId ? `/api/money/customers/${detailId}` : null, money.revision, money.onExpired);
  const query = useQueryState();
  const [open, setOpen] = useState<Rec | true | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [addExt, setAddExt] = useState(false);
  const ext = useEntityExtensions('customer');
  const location = useLocation();
  useEffect(() => { if (new URLSearchParams(location.search).get('add')) setOpen(true); }, [location.search]);
  const remote = useRemote<{ items: Rec[] }>('/api/money/customers', money.revision, money.onExpired);
  const settings = useRemote<{ tags: Rec[] }>('/api/money/settings', money.revision, money.onExpired);
  const rows = (remote.data?.items ?? []).filter((row) => {
    const q = query.query;
    const text = `${row.code}${row.name}${row.contact_name}${row.contact_phone}${row.address}${row.owner_name}`;
    if (q.code && !String(row.code).includes(q.code)) return false;
    if (q.name && !String(row.name).includes(q.name)) return false;
    if (q.tag && !(row.tags ?? []).includes(q.tag)) return false;
    if (q.contact && !String(row.contact_name).includes(q.contact)) return false;
    if (q.owner && !String(row.owner_name).includes(q.owner)) return false;
    if (q.address && !String(row.address).includes(q.address) && !String(row.region).includes(q.address)) return false;
    if (q.phone && !String(row.contact_phone).includes(q.phone)) return false;
    if (q.active === 'yes' && row.active === false) return false;
    if (q.active === 'no' && row.active !== false) return false;
    if (q.followed === 'yes' && !row.followed) return false;
    if (q.followed === 'no' && row.followed) return false;
    if (q.q && !text.includes(q.q)) return false;
    return true;
  });
  async function act(path: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') {
    try { await money.send(path, body, method); message.success('已保存'); }
    catch (error) { message.error(showError(error)); }
  }
  if (detailId) {
    const customer = (detail.data as { customer?: Rec } | undefined)?.customer;
    return <div className="kgd-card">{detail.error ? detail.error : customer ? <h1>{String(customer.name ?? '')}</h1> : '加载中'}</div>;
  }
  const baseColumns = [
    { key: 'code', title: '客户编号', render: (row: Rec) => row.code },
    { key: 'name', title: '客户', render: (row: Rec) => <><button className="kgd-heart" onClick={() => act(`/api/money/customers/${row.id}/follow`, {})}>{row.followed ? '♥' : '♡'}</button><button className="kgd-link">{row.name}</button></> },
    { key: 'tags', title: '客户标签', render: (row: Rec) => (row.tags ?? []).join('、') },
    { key: 'contact', title: '联系人', render: (row: Rec) => row.contact_name },
    { key: 'phone', title: '联系人电话', render: (row: Rec) => row.contact_phone },
    { key: 'address', title: '地址', render: (row: Rec) => [row.region, row.address].filter(Boolean).join(' ') },
    { key: 'active', title: '启用/禁用', render: (row: Rec) => <StatusTag text={row.active === false ? '禁用' : '启用'} /> },
    { key: 'owner', title: '负责人', render: (row: Rec) => row.owner_name },
    { key: 'creator', title: '创建人', render: (row: Rec) => row.owner_name },
    { key: 'created', title: '创建时间', render: (row: Rec) => beijingTime(row.created_at ?? '', '') },
    { key: 'updated', title: '更新时间', render: (row: Rec) => beijingTime(row.updated_at ?? '', '') },
    { key: 'distance', title: '距离', render: () => '' },
    { key: 'actions', title: '操作', width: 140, render: (row: Rec) => <span onClick={(event) => event.stopPropagation()}><button className="kgd-link" onClick={() => setOpen(row)}>修改</button> <Dropdown menu={{ items: [
      { key: 'sea', label: '放入公海', onClick: () => confirmText('放入公海', '确定将该客户放入公海？', () => void act(`/api/money/customers/${row.id}/sea`, {})) },
      ...(hasPoint(session, 'customer.list.delete') ? [{ key: 'delete', label: '删除', onClick: () => confirmText('删除客户', '确定删除该客户？', () => void act(`/api/money/customers/${row.id}`, {}, 'DELETE')) }] : []),
    ] }}><button className="kgd-link">更多</button></Dropdown></span> },
  ];
  const customerColumns = [
    ...baseColumns.slice(0, -1),
    ...ext.fields.map((field) => ({ key: `ext:${field.id}`, title: field.name, render: () => '' })),
    baseColumns[baseColumns.length - 1]!,
  ];
  const customerCardFields = Object.fromEntries(['list', 'detail'].map((key) => [key, customerColumns.filter((column) => column.key !== 'actions').map((column) => ({ key: column.key, label: column.title }))]));
  return <>
    <ListFrame pageKey="customer-list" showAdvancedSearch={false} rows={rows} loading={remote.loading} error={remote.error || money.error} queryFields={[
      { key: 'code', label: '客户编号' }, { key: 'name', label: '客户' }, { key: 'tag', label: '客户标签' }, { key: 'contact', label: '联系人' }, { key: 'owner', label: '负责人' }, { key: 'address', label: '地址' }, { key: 'phone', label: '联系人电话' }, { key: 'active', label: '是否启用' }, { key: 'followed', label: '是否关注' },
    ]} queryValue={query.draft} onQuery={query.onQuery} onSearch={query.onSearch} onClear={query.onClear} page={query.page} pageSize={query.pageSize} total={rows.length} onPage={query.onPage}
      toolbar={<>
        <Button type="primary" onClick={() => setOpen(true)}>新增</Button>
        <Button onClick={() => setMapOpen(true)}>地图视图</Button>
      </>}
      moreItems={[{ key: 'import', label: '导入客户', onClick: () => document.getElementById('customer-import')?.click() }, { key: 'export', label: '导出(所有列)', onClick: () => exportCustomers() }]}
      columns={customerColumns}
      extensionObject="客户管理" extensionTitle="【客户管理】扩展字段管理" extensionRows={ext.extensionRows} extensionCanAdd
      onExtensionAdd={() => setAddExt(true)}
      onExtensionReorder={(ids) => void ext.reorder(ids).catch((failure) => message.error(showError(failure)))}
      onExtensionDelete={(id) => void ext.deleteField(id).catch((failure) => message.error(showError(failure)))}
      viewFieldModule="客户"
      showMobileCard mobileTabs={[{ key: 'list', label: '客户列表卡片' }, { key: 'detail', label: '客户详情卡片' }]}
      mobileFields={customerCardFields}
      onMobileCards={(next) => { Object.entries(next).forEach(([tab, fields]) => { void money.send('/api/mobile-cards', { page_key: 'customer-list', tab_key: tab, fields }, 'PUT'); }); }}
    />
    <input id="customer-import" type="file" accept=".xlsx" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCustomers(file); event.target.value = ''; }} />
    {open && <CustomerModal row={open === true ? null : open} tags={settings.data?.tags ?? []} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); message.success('已保存'); }} />}
    <ExtensionAddDialog open={addExt} mode="customer" onCancel={() => setAddExt(false)} onOk={(value) => {
      void ext.createField({
        name: value.label, required: value.required, field_type: value.type,
        options: {
          choices_text: value.options,
          input_modes: value.input_modes,
          decimals: value.decimals,
          biz_object: value.biz_object,
          display_field: value.display_field,
          rel_object: value.rel_object,
          rel_field: value.rel_field,
        },
      }).then(() => setAddExt(false)).catch((failure) => message.error(showError(failure)));
    }} />
    <Modal title="地图视图" open={mapOpen} onCancel={() => setMapOpen(false)} footer={null} width={720}>
      <p>客户地图视图</p>
    </Modal>
  </>;

  async function exportCustomers() {
    try {
      const file = await apiRequest<{ filename: string; content_base64: string }>('/api/money/customers/export');
      if (!file) return;
      downloadBase64(String(file.filename), String(file.content_base64));
    } catch (error) { message.error(showError(error)); }
  }
  async function importCustomers(file: File) {
    try {
      const content_base64 = await readFileBase64(file);
      await money.send('/api/money/customers/import', { content_base64 });
      message.success('已导入');
    } catch (error) { message.error(showError(error)); }
  }
}

export function CustomerModal({ row, tags, onClose, onSaved }: { row: Rec | null; tags: Rec[]; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp();
  const money = useMoney();
  const ext = useEntityExtensions('customer', row?.id);
  const [extValues, setExtValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [region, setRegion] = useState(row?.region ?? '');
  const [address, setAddress] = useState(row?.address ?? '');
  const [picked, setPicked] = useState<string[]>(row?.tags ?? []);
  const [contact, setContact] = useState(row?.contact_name ?? '');
  const [phone, setPhone] = useState(row?.contact_phone ?? '');
  const [tried, setTried] = useState(false);
  useEffect(() => { setExtValues(ext.values); }, [ext.values]);
  async function save() {
    setTried(true);
    if (!name.trim()) { message.error('请填写客户名称'); return; }
    if (!contact.trim()) { message.error('请填写联系人'); return; }
    const extErr = ext.validateRequired(extValues);
    if (extErr) { message.warning(extErr); return; }
    const body = { request_key: requestKey(), name, code, region, address, tags: picked, contact_name: contact, contact_phone: phone, version: row?.version };
    try {
      const result = await money.send<{ customer: Rec }>(row ? `/api/money/customers/${row.id}` : '/api/money/customers', body, row ? 'PATCH' : 'POST');
      const recordId = row?.id ?? result?.customer?.id;
      if (recordId && ext.fields.length) {
        try {
          await apiRequest('/api/entity-ext-values', {
            method: 'PUT', csrfToken: money.session.csrf_token,
            body: { entity: 'customer', record_id: recordId, values: extValues },
          });
        } catch (error) { message.error(`扩展字段未保存：${showError(error)}`); }
      }
      onSaved();
    } catch (error) { message.error(showError(error)); }
  }
  return <Modal title={row ? '修改客户' : '新增客户'} open onCancel={onClose} onOk={save} okText="确定" cancelText="取消" confirmLoading={money.busy}>
    <Form layout="vertical">
      <h4>基础信息</h4>
      <Form.Item label="客户名称" required validateStatus={tried && !name.trim() ? 'error' : undefined} help={tried && !name.trim() ? '请填写客户名称' : undefined}><Input status={tried && !name.trim() ? 'error' : undefined} value={name} onChange={(event) => setName(event.target.value)} /></Form.Item>
      <Form.Item label="编号"><Input value={code} placeholder="请填写，忽略将自动生成" onChange={(event) => setCode(event.target.value)} /></Form.Item>
      <Form.Item label="地区"><RegionSelect value={region} onChange={setRegion} /></Form.Item>
      <Form.Item label="详细地址"><Input value={address} onChange={(event) => setAddress(event.target.value)} /></Form.Item>
      <Form.Item label="客户标签"><Select mode="multiple" value={picked} options={tags.map((tag) => ({ value: tag.name, label: tag.name }))} onChange={setPicked} /></Form.Item>
      <h4>首要联系人</h4>
      <Form.Item label="联系人" required><Input value={contact} onChange={(event) => setContact(event.target.value)} addonAfter={<button type="button" className="kgd-link" onClick={() => setContact(name)}>同客户名</button>} /></Form.Item>
      <Form.Item label="联系人电话"><Input value={phone} onChange={(event) => setPhone(event.target.value)} /></Form.Item>
      {ext.fields.length > 0 && <div className="kgd-form"><ExtFieldInputs fields={ext.fields} values={extValues} onChange={setExtValues} /></div>}
    </Form>
  </Modal>;
}
