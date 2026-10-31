import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Input, Modal, Select, Tag } from 'antd';
import { App } from 'antd';
import { apiRequest } from '../../../../api';
import { useRemote } from '../../../../masterTools';
import { ExtensionAddDialog } from '../../../dialogs';
import { ExtFieldInputs } from '../../../extensions/ExtFieldInputs';
import { useEntityExtensions } from '../../../extensions/useEntityExtensions';
import { ListFrame } from '../../../ListFrame';
import { showError, useQueryState } from '../../../kit';
import { useR10, dash } from '../../round10/shared';
import type { Row } from '../../round10/shared';

export function LinkmanList() {
  const r10 = useR10();
  const navigate = useNavigate();
  const list = useQueryState();
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const [addExt, setAddExt] = useState(false);
  const ext = useEntityExtensions('linkman');
  const remote = useRemote<{ items: Row[] }>(`/api/crm/contacts?q=${encodeURIComponent(list.query.q ?? '')}&customer=${encodeURIComponent(list.query.customer ?? '')}&name=${encodeURIComponent(list.query.name ?? '')}&phone=${encodeURIComponent(list.query.phone ?? '')}`, r10.revision, r10.onExpired);
  const rows = remote.data?.items ?? [];
  const baseColumns = [
    { key: 'customer', title: '客户', render: (row: Row) => <button className="kgd-link" style={{ color: '#4184F4' }} onClick={() => navigate(`/customer/detail/${row.customer_id}`)}>{row.customer_name}</button> },
    { key: 'name', title: '联系人', render: (row: Row) => <>{row.is_default && <Tag color="success">默认</Tag>}{row.name}</> },
    { key: 'phone', title: '联系人电话', render: (row: Row) => dash(row.phone) },
    { key: 'actions', title: '操作', width: 180, render: (row: Row) => <>
      {!row.is_default && <button className="kgd-link" onClick={() => void r10.act(`/api/crm/contacts/${row.id}/default`, {})}>设为默认</button>}{' '}
      <button className="kgd-link" onClick={() => setEdit(row)}>修改</button>{' '}
      <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除联系人', () => r10.act(`/api/crm/contacts/${row.id}`, {}, 'DELETE', '已删除'))}>删除</button>
    </> },
  ];
  const columns = [
    ...baseColumns.slice(0, -1),
    ...ext.fields.map((field) => ({ key: `ext:${field.id}`, title: field.name, render: () => '' })),
    baseColumns[baseColumns.length - 1]!,
  ];
  return <>
    <ListFrame pageKey="linkman" exportName="客户联系人" showMobileCard={false} showMore={false} showAdvancedSearch advancedWithQuery primaryTools hideQueryFields queryAlign="end" splitTools viewTabs={[]} rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'customer', label: '客户' }, { key: 'name', label: '联系人' }, { key: 'phone', label: '联系人电话' }]}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      queryNode={<Input style={{ width: 240 }} allowClear placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(event) => list.onQuery('q', event.target.value)} onPressEnter={list.onSearch} />}
      page={list.page} pageSize={30} total={rows.length} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => setEdit('new')}>+ 新增</Button>}
      columns={columns}
      extensionObject="客户联系人" extensionRows={ext.extensionRows} extensionCanAdd
      onExtensionAdd={() => setAddExt(true)}
      onExtensionReorder={(ids) => void ext.reorder(ids).catch((failure) => r10.message.error(showError(failure)))}
      onExtensionDelete={(id) => void ext.deleteField(id).catch((failure) => r10.message.error(showError(failure)))}
    />
    {edit && <LinkmanModal row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    <ExtensionAddDialog open={addExt} mode="linkman" onCancel={() => setAddExt(false)} onOk={(value) => {
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
      }).then(() => setAddExt(false)).catch((failure) => r10.message.error(showError(failure)));
    }} />
  </>;
}

function LinkmanModal({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const r10 = useR10();
  const customers = useRemote<{ items: Row[] }>('/api/money/customers', r10.revision, r10.onExpired);
  const ext = useEntityExtensions('linkman', row?.id);
  const [extValues, setExtValues] = useState<Record<string, unknown>>({});
  const [customerId, setCustomerId] = useState(String(row?.customer_id ?? ''));
  const [name, setName] = useState(String(row?.name ?? ''));
  const [phone, setPhone] = useState(String(row?.phone === '-' ? '' : row?.phone ?? ''));
  useEffect(() => { setExtValues(ext.values); }, [ext.values]);
  async function saveExt(recordId: string) {
    if (!ext.fields.length) return true;
    try {
      await apiRequest('/api/entity-ext-values', {
        method: 'PUT', csrfToken: r10.session.csrf_token,
        body: { entity: 'linkman', record_id: recordId, values: extValues },
      });
      return true;
    } catch (failure) {
      r10.message.error(`扩展字段未保存：${showError(failure)}`);
      return false;
    }
  }
  async function save() {
    if (!customerId) { r10.message.warning('请选择客户'); return; }
    if (!name.trim()) { r10.message.warning('请填写联系人'); return; }
    const extErr = ext.validateRequired(extValues);
    if (extErr) { r10.message.warning(extErr); return; }
    if (row) {
      const ok = await r10.act(`/api/crm/contacts/${row.id}`, { name, phone }, 'PATCH');
      if (!ok) return;
      await saveExt(row.id);
      onClose();
      return;
    }
    const created = await r10.act<{ id: string }>('/api/crm/contacts', { customer_id: customerId, name, phone }, 'POST');
    if (!created?.id) return;
    await saveExt(created.id);
    onClose();
  }
  return <Modal open title={row ? '修改客户联系人' : '新增客户联系人'} onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消">
    <Form layout="vertical">
      <Form.Item label={<><span style={{ color: 'red' }}>*</span>客户</>} required>
        <Select showSearch optionFilterProp="label" value={customerId || undefined} disabled={!!row} onChange={setCustomerId}
          options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: String(c.name) }))} />
      </Form.Item>
      <Form.Item label={<><span style={{ color: 'red' }}>*</span>联系人</>} required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Form.Item>
      <Form.Item label="联系人电话"><Input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} /></Form.Item>
      {ext.fields.length > 0 && <div className="kgd-form"><ExtFieldInputs fields={ext.fields} values={extValues} onChange={setExtValues} /></div>}
    </Form>
  </Modal>;
}

export function CustomerSeaList() {
  const r10 = useR10();
  const { message } = App.useApp();
  const list = useQueryState();
  const remote = useRemote<{ items: Row[] }>(`/api/crm/sea?q=${encodeURIComponent(list.query.q ?? '')}`, r10.revision, r10.onExpired);
  const rows = remote.data?.items ?? [];
  return <ListFrame pageKey="customer_sea" exportName="客户公海" showExtension={false} showMobileCard rows={rows} loading={remote.loading} error={remote.error}
    queryFields={[{ key: 'code', label: '客户编号' }, { key: 'name', label: '客户' }, { key: 'tag', label: '客户标签' }, { key: 'contact', label: '联系人' }, { key: 'phone', label: '联系人电话' }, { key: 'address', label: '地址' }]}
    defaultQueryKeys={['code', 'name', 'tag', 'contact', 'phone']} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    page={list.page} pageSize={30} total={rows.length} onPage={list.onPage}
    columns={[
      { key: 'code', title: '客户编号', render: (row) => row.code },
      { key: 'name', title: '客户', render: (row) => row.name },
      { key: 'tags', title: '客户标签', render: (row) => dash(row.tags) },
      { key: 'contact', title: '联系人', render: (row) => dash(row.contact_name) },
      { key: 'phone', title: '联系人电话', render: (row) => dash(row.contact_phone) },
      { key: 'address', title: '地址', render: (row) => dash(row.address) },
      { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
      { key: 'created', title: '创建时间', render: (row) => dash(row.created_text) },
      { key: 'actions', title: '操作', render: (row) => <button className="kgd-link" onClick={() => void r10.act(`/api/crm/sea/${row.id}/claim`, {}).then((res) => { if (res) message.success('领用成功'); })}>领用</button> },
    ]} />;
}

export function SalesPriceTrack() {
  const r10 = useR10();
  const list = useQueryState();
  const [open, setOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const remote = useRemote<{ items: Row[] }>('/api/crm/price-rules', r10.revision, r10.onExpired);
  const fill = useRemote<{ fill_mode: string }>('/api/crm/price-fill', r10.revision, r10.onExpired);
  const customers = useRemote<{ items: Row[] }>('/api/money/customers', r10.revision, r10.onExpired);
  const products = useRemote<{ items: Row[] }>('/api/products?page=1&page_size=200', r10.revision, r10.onExpired);
  const [customerId, setCustomerId] = useState('');
  const [productId, setProductId] = useState('');
  const [price, setPrice] = useState('');
  const [mode, setMode] = useState(fill.data?.fill_mode ?? 'goods');
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame pageKey="sales_price_track" exportName="销售价格追踪" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'q', label: '关键字' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={30} total={rows.length} onPage={list.onPage}
      toolbar={<>
        <Button type="primary" onClick={() => setOpen(true)}>+ 新增</Button>
        <Button onClick={() => { setMode(fill.data?.fill_mode ?? 'goods'); setRuleOpen(true); }}>价格规则</Button>
      </>}
      columns={[
        { key: 'customer', title: '客户', render: (row) => row.customer_name },
        { key: 'code', title: '商品编号', render: (row) => row.product_code },
        { key: 'name', title: '商品名', render: (row) => row.product_name },
        { key: 'spec', title: '商品规格', render: (row) => dash(row.product_spec) },
        { key: 'price', title: '单价', render: (row) => row.price },
        { key: 'last', title: '上一次的销售单价', render: (row) => row.last_price },
        { key: 'avg', title: '历史平均销售单价', render: (row) => row.avg_price },
        { key: 'max', title: '历史最高销售单价', render: (row) => row.max_price },
        { key: 'min', title: '历史最低销售单价', render: (row) => row.min_price },
        { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
        { key: 'created', title: '创建时间', render: (row) => dash(row.created_text) },
        { key: 'actions', title: '操作', render: (row) => <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除价格规则', () => r10.act(`/api/crm/price-rules/${row.id}`, {}, 'DELETE'))}>删除</button> },
      ]} />
    <Modal open={open} title="创建新价格规则" onCancel={() => setOpen(false)} onOk={() => void r10.act('/api/crm/price-rules', { customer_id: customerId, product_id: productId, unit_price: price }, 'POST').then((ok) => { if (ok) setOpen(false); })} okText="确定" cancelText="取消">
      <Form layout="vertical">
        <Form.Item label={<><span style={{ color: 'red' }}>*</span>客户</>}><Select showSearch optionFilterProp="label" value={customerId || undefined} onChange={setCustomerId} options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: String(c.name) }))} /></Form.Item>
        <Form.Item label={<><span style={{ color: 'red' }}>*</span>商品</>}><Select showSearch optionFilterProp="label" value={productId || undefined} onChange={setProductId} options={(products.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.name} ${p.code}` }))} /></Form.Item>
        <Form.Item label={<><span style={{ color: 'red' }}>*</span>单价</>}><Input value={price} onChange={(e) => setPrice(e.target.value)} /></Form.Item>
      </Form>
    </Modal>
    <Modal open={ruleOpen} title="价格填写规则" onCancel={() => setRuleOpen(false)} onOk={() => void r10.act('/api/crm/price-fill', { fill_mode: mode }, 'PUT').then((ok) => { if (ok) setRuleOpen(false); })} okText="确定" cancelText="取消">
      <Form layout="vertical">
      <Form.Item label="销售价格填写规则">
      <Select style={{ width: '100%' }} value={mode} onChange={setMode} options={[
        { value: 'track', label: '价格追踪表中的单价' },
        { value: 'last', label: '上次的销售单价' },
        { value: 'goods', label: '商品中的销售单价' },
      ]} />
      </Form.Item>
      </Form>
      <p className="kgd-muted" style={{ marginTop: 12 }}>新建、编辑合同订单和合同报价单时，选中客户与商品后按此规则带出明细单价，仍可手改。</p>
    </Modal>
  </>;
}
