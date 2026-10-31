import { useMemo, useState } from 'react';
import { Button, DatePicker, Form, Input, Modal, Select } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useRemote } from '../../../../masterTools';
import { ListFrame } from '../../../ListFrame';
import { useExtForm, useExtList } from '../../../extensions/bind';
import { showError } from '../../../kit';
import { useQueryState } from '../../../kit';
import { CustomerModal } from '../../money/customers';
import { fmtTime, MemberPick, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';

export const followTypes = ['上门', '电话', '网络'];
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

export function defaultNextFollow(now = dayjs()) {
  const ceil = now.minute() === 0 && now.second() === 0 ? now.startOf('hour') : now.startOf('hour').add(1, 'hour');
  return ceil.add(1, 'hour');
}

export function remindText(next: Dayjs | null) {
  if (!next) return '';
  const remind = next.subtract(1, 'hour');
  const hour = remind.hour();
  return `将在${remind.format('YYYY-MM-DD')} (星期${weekdays[remind.day()]}) ${hour < 12 ? '早上' : '下午'}${String(hour).padStart(2, '0')}点提醒您跟单`;
}

export function CustomerFollowList() {
  const r10 = useR10();
  const list = useQueryState();
  const [keyword, setKeyword] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const extList = useExtList('customer_follow');
  const q = list.query;
  const remote = useList(`/api/customer-follows${qs({ keyword: q.q, page: list.page, page_size: list.pageSize, customer_id: q.customer_id, follow_type: q.follow_type, follower_id: q.follower_id, followed_from: q.followed_from, followed_to: q.followed_to, next_from: q.next_from, next_to: q.next_to })}`);
  const members = useList<{ id: string; display_name: string }>('/api/team-members');
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame<Row> pageKey="customer_follow" exportName="客户跟单" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={() => { setKeyword(''); list.onClear(); }} onApplyQuery={list.onApplyQuery}
      queryNode={<div className="kgd-query-fields">
        <Input style={{ width: 240 }} allowClear placeholder="输入关键字查询" value={keyword} onChange={(event) => { setKeyword(event.target.value); list.onQuery('q', event.target.value); }} onPressEnter={list.onSearch} />
        <Button type="link" onClick={() => setAdvanced((value) => !value)}>高级查询</Button>
        {advanced && <>
          <CustomerPick value={list.draft.customer_id ?? ''} onChange={(value) => list.onQuery('customer_id', value)} style={{ width: 200 }} placeholder="客户" />
          <Select style={{ width: 140 }} allowClear placeholder="跟单类型" value={list.draft.follow_type || undefined} options={followTypes.map((value) => ({ value, label: value }))} onChange={(value) => list.onQuery('follow_type', value ?? '')} />
          <MemberPick value={list.draft.follower_id ?? ''} onChange={(value) => list.onQuery('follower_id', value)} style={{ width: 160 }} placeholder="跟单人" />
          <DatePicker style={{ width: 150 }} placeholder="跟单时间起" value={list.draft.followed_from ? dayjs(list.draft.followed_from) : null} onChange={(value) => list.onQuery('followed_from', value ? value.format('YYYY-MM-DD') : '')} />
          <DatePicker style={{ width: 150 }} placeholder="跟单时间止" value={list.draft.followed_to ? dayjs(list.draft.followed_to) : null} onChange={(value) => list.onQuery('followed_to', value ? value.format('YYYY-MM-DD') : '')} />
          <DatePicker style={{ width: 150 }} placeholder="下次跟单时间起" value={list.draft.next_from ? dayjs(list.draft.next_from) : null} onChange={(value) => list.onQuery('next_from', value ? value.format('YYYY-MM-DD') : '')} />
          <DatePicker style={{ width: 150 }} placeholder="下次跟单时间止" value={list.draft.next_to ? dayjs(list.draft.next_to) : null} onChange={(value) => list.onQuery('next_to', value ? value.format('YYYY-MM-DD') : '')} />
        </>}
      </div>}
      {...extList.props}
      page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => setEdit('new')}>新增</Button>}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]}
      mobileFields={{ list: [{ key: 'contact', label: '联系人' }, { key: 'phone', label: '联系电话' }, { key: 'type', label: '跟单类型' }, { key: 'content', label: '跟单内容' }, { key: 'next', label: '下次跟单时间' }, { key: 'follower', label: '跟单人' }, { key: 'followed', label: '跟单时间' }, { key: 'customer', label: '客户' }] }}
      columns={[
        { key: 'contact', title: '联系人', render: (row) => row.contact_name || '-' },
        { key: 'phone', title: '联系电话', render: (row) => row.contact_phone || '-' },
        { key: 'type', title: '跟单类型', render: (row) => row.follow_type || '-' },
        { key: 'content', title: '跟单内容', width: 240, render: (row) => row.content || '-' },
        { key: 'next', title: '下次跟单时间', width: 160, render: (row) => row.next_text ?? fmtTime(row.next_at) },
        { key: 'follower', title: '跟单人', render: (row) => row.follower_name || members.data?.items.find((item) => item.id === row.follower_id)?.display_name || '-' },
        { key: 'followed', title: '跟单时间', width: 160, render: (row) => row.followed_text ?? fmtTime(row.followed_at) },
        { key: 'customer', title: '客户', width: 200, render: (row) => row.customer_name || '-' },
        { key: 'actions', title: '操作', width: 120, render: (row) => <>
          <button className="kgd-link" onClick={() => setEdit(row)}>修改</button>{' '}
          <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除客户跟单', () => r10.act(`/api/customer-follows/${row.id}`, {}, 'DELETE', '已删除').then(() => remote.reload()))}>删除</button>
        </> },
      ]} />
    {extList.dialog}
    {edit && <FollowModal row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); remote.reload(); }} />}
  </>;
}

export function CustomerPick({ value, onChange, style, placeholder = '输入关键词，在查询结果中选中' }: { value: string; onChange: (id: string) => void; style?: React.CSSProperties; placeholder?: string }) {
  const customers = useList<Row>('/api/money/customers');
  return <Select showSearch allowClear optionFilterProp="label" style={{ width: '100%', ...style }} placeholder={placeholder} value={value || undefined} options={(customers.data?.items ?? []).map((item) => ({ value: item.id, label: String(item.name ?? '') }))} onChange={(next) => onChange(next ?? '')} />;
}

export function FollowModal({ row, onClose, onSaved, customerId }: { row: Row | null; onClose: () => void; onSaved: () => void; customerId?: string }) {
  const r10 = useR10();
  const [customer, setCustomer] = useState<string>(row?.customer_id ?? customerId ?? '');
  const [type, setType] = useState<string>(row?.follow_type ?? '');
  const [contact, setContact] = useState<string>(row?.contact_id ?? '');
  const [content, setContent] = useState<string>(row?.content ?? '');
  const [next, setNext] = useState<Dayjs | null>(row?.next_at ? dayjs(row.next_at) : defaultNextFollow());
  const [customerOpen, setCustomerOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactForm, setContactForm] = useState({ name: '', phone: '' });
  const detail = useRemote<{ items: Row[] }>(customer ? `/api/customer-follows/contacts?customer_id=${customer}` : null, r10.revision, r10.onExpired);
  const contacts = useMemo(() => detail.data?.items ?? [], [detail.data]);
  const extForm = useExtForm('customer_follow', row?.id);
  async function save() {
    if (!customer) { r10.message.warning('请选择客户'); return; }
    if (!type) { r10.message.warning('请选择跟单类型'); return; }
    if (!contact) { r10.message.warning('请选择联系人'); return; }
    if (!content.trim()) { r10.message.warning('请填写跟单内容'); return; }
    if (!next) { r10.message.warning('请选择下次跟单时间'); return; }
    const extErr = extForm.error();
    if (extErr) { r10.message.warning(extErr); return; }
    const body = { customer_id: customer, follow_type: type, contact_id: contact, content: content.trim(), next_at: next.toISOString(), ...(row ? { version: row.version } : {}) };
    const result = await r10.act<{ id?: string }>(row ? `/api/customer-follows/${row.id}` : '/api/customer-follows', body, row ? 'PUT' : 'POST');
    const recordId = row?.id ?? result?.id ?? '';
    if (result && recordId) {
      try { await extForm.persist(r10.session.csrf_token, recordId); }
      catch (error) { r10.message.error(showError(error)); return; }
    }
    if (result) onSaved();
  }
  async function addContact() {
    if (!contactForm.name.trim()) { r10.message.warning('请填写联系人'); return; }
    const result = await r10.act<Row>(`/api/money/customers/${customer}/contacts`, { name: contactForm.name.trim(), phone: contactForm.phone.trim() });
    if (result) {
      const created = (result.contact as Row | undefined) ?? (((result.customer as Row | undefined)?.contacts ?? []) as Row[]).find((item) => item.name === contactForm.name.trim());
      if (created?.id) setContact(String(created.id));
      setContactOpen(false);
      setContactForm({ name: '', phone: '' });
      detail.reload();
    }
  }
  return <Modal title={row ? '修改客户跟单' : '新增客户跟单'} open onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消" confirmLoading={r10.busy} destroyOnHidden width={560}>
    <Form layout="vertical">
      <Form.Item label="客户" required><div style={{ display: 'flex', gap: 8 }}><CustomerPick value={customer} onChange={(id) => { setCustomer(id); setContact(''); }} /><Button onClick={() => setCustomerOpen(true)}>新增</Button></div></Form.Item>
      <Form.Item label="跟单类型" required><Select placeholder="请选择" value={type || undefined} options={followTypes.map((value) => ({ value, label: value }))} onChange={setType} /></Form.Item>
      <Form.Item label="联系人" required><div style={{ display: 'flex', gap: 8 }}><Select style={{ flex: 1 }} placeholder={customer ? '请选择' : '请先选择客户'} disabled={!customer} value={contact || undefined} options={contacts.map((item) => ({ value: item.id, label: item.phone ? `${item.name} ${item.phone}` : item.name }))} onChange={setContact} /><Button disabled={!customer} onClick={() => setContactOpen(true)}>新增</Button></div></Form.Item>
      <Form.Item label="跟单内容" required><Input.TextArea rows={4} maxLength={255} showCount value={content} onChange={(event) => setContent(event.target.value)} /></Form.Item>
      <Form.Item label="下次跟单时间" required extra={remindText(next)}><DatePicker style={{ width: '100%' }} showTime={{ format: 'HH' }} format="YYYY-MM-DD HH时" value={next} onChange={(value) => setNext(value ? value.minute(0).second(0) : null)} /></Form.Item>
      {extForm.node}
    </Form>
    {customerOpen && <CustomerModal row={null} tags={[]} onClose={() => setCustomerOpen(false)} onSaved={() => setCustomerOpen(false)} />}
    <Modal title="新增联系人" open={contactOpen} onCancel={() => setContactOpen(false)} onOk={() => void addContact()} okText="确定" cancelText="取消" destroyOnHidden>
      <Form layout="vertical">
        <Form.Item label="联系人" required><Input value={contactForm.name} onChange={(event) => setContactForm({ ...contactForm, name: event.target.value })} /></Form.Item>
        <Form.Item label="联系人电话"><Input value={contactForm.phone} onChange={(event) => setContactForm({ ...contactForm, phone: event.target.value })} /></Form.Item>
      </Form>
    </Modal>
  </Modal>;
}
