import { useState } from 'react';
import { Table } from 'antd';
import { useRemote } from '../../../../masterTools';
import { qs, SettingFrame, SettingSection, useR10 } from '../shared';
import type { Row } from '../shared';

type Paged = { total: number; page: number; page_size: number; items: Row[] };
type SmsData = { remaining?: number; packages?: { name: string; sms_count: number; price_text: string }[]; recharges?: Paged; sends?: Paged };

export function SmsSetting() {
  const r10 = useR10();
  const [rechargePage, setRechargePage] = useState(1);
  const [sendPage, setSendPage] = useState(1);
  const remote = useRemote<SmsData>(`/api/system/sms${qs({ recharge_page: rechargePage, recharge_page_size: 30, send_page: sendPage, send_page_size: 30 })}`, r10.revision, r10.onExpired);
  const data = remote.data ?? {};
  const paging = (paged: Paged | undefined, onChange: (page: number) => void) => ({ current: paged?.page ?? 1, pageSize: 30, total: paged?.total ?? 0, showSizeChanger: false, showTotal: (count: number) => `共${count}条数据`, onChange });
  const packages = data.packages ?? [];
  return <SettingFrame>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <div style={{ fontSize: 16, margin: '8px 0 16px' }}>短信剩余 <b style={{ color: '#4184F4', fontSize: 22 }}>{data.remaining ?? 0}</b> 条</div>
    <SettingSection title="短信包">
      <div style={{ display: 'flex', gap: 16 }}>
        {packages.map((item) => <div key={item.name} style={{ border: '1px solid #e5e6eb', borderRadius: 4, padding: '16px 24px', minWidth: 180, textAlign: 'center', color: '#666', cursor: 'default' }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#333' }}>{item.name}</div>
          <div style={{ fontSize: 20, color: '#f5222d', marginTop: 6 }}>{item.price_text}</div>
        </div>)}
      </div>
    </SettingSection>
    <SettingSection title="充值记录">
      <Table size="small" rowKey="id" loading={remote.loading} dataSource={data.recharges?.items ?? []} pagination={paging(data.recharges, setRechargePage)} locale={{ emptyText: '暂无数据' }} columns={[
        { title: '套餐', render: (_, row) => row.package_name || `${row.sms_count}条` },
        { title: '金额', render: (_, row) => `¥${row.amount ?? '0.00'}` },
        { title: '短信条数', dataIndex: 'sms_count' },
        { title: '购买时间', render: (_, row) => row.purchased_text ?? '-' },
      ]} />
    </SettingSection>
    <SettingSection title="发送记录">
      <Table size="small" rowKey="id" loading={remote.loading} dataSource={data.sends?.items ?? []} pagination={paging(data.sends, setSendPage)} locale={{ emptyText: '暂无数据' }} columns={[
        { title: '发送手机号', dataIndex: 'phone' },
        { title: '短信内容', dataIndex: 'content' },
        { title: '发送时间', render: (_, row) => row.sent_text ?? '-' },
      ]} />
    </SettingSection>
  </SettingFrame>;
}
