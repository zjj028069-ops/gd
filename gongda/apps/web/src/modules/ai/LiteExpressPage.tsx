import { useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Input, Select, Space, Table, Tag } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';
import './ai.css';

type AppItem = {
  id: string;
  title: string;
  status: 'enabled' | 'disabled' | 'rolled_back';
  menu_label: string;
  menu_path: string;
  spec?: { kind?: string; statuses?: string[] };
};

type LiteRecord = {
  id: string;
  status: string;
  sender_name: string;
  sender_customer_id: string | null;
  stock_out_id: string | null;
  stock_out_code: string;
  goods_summary: string;
  tracking_no: string;
  created_at: string;
};

type Customer = { id: string; code: string; name: string };
type Shipment = {
  id: string;
  code: string;
  customer_name?: string;
  lines?: { product_name?: string; quantity?: string }[];
};

const STATUS_COLOR: Record<string, string> = { 待约: 'default', 已寄: 'success', 异常: 'error' };

export function LiteExpressPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { session } = useKgd();
  const id = pathname.split('/ai/lite/')[1]?.split(/[/?]/)[0] ?? '';
  const [app, setApp] = useState<AppItem | null>(null);
  const [items, setItems] = useState<LiteRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [form, setForm] = useState({
    sender_customer_id: '',
    sender_name: '',
    stock_out_id: '',
    stock_out_code: '',
    goods_summary: '',
  });
  const [trackingDraft, setTrackingDraft] = useState<Record<string, string>>({});

  async function reloadRecords(filter = statusFilter) {
    const q = filter ? `?status=${encodeURIComponent(filter)}` : '';
    const data = await apiRequest<{ items: LiteRecord[] }>(`/api/ai/lite-apps/${id}/records${q}`);
    setItems(data.items ?? []);
    const draft: Record<string, string> = {};
    for (const row of data.items ?? []) draft[row.id] = row.tracking_no || '';
    setTrackingDraft(draft);
  }

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const data = await apiRequest<{ item: AppItem }>(`/api/ai/ext-apps/${id}`);
        setApp(data.item);
        await reloadRecords('');
      } catch (failure) {
        setError(errorMessage(failure));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [cust, ship] = await Promise.all([
          apiRequest<{ items: Customer[] }>('/api/customers'),
          apiRequest<{ items: Shipment[] }>('/api/warehouse/shipments'),
        ]);
        setCustomers(cust.items ?? []);
        setShipments(ship.items ?? []);
      } catch (failure) {
        setError(errorMessage(failure));
      }
    })();
  }, [open]);

  const statusText = app?.status === 'enabled' ? '启用' : app?.status === 'disabled' ? '停用' : '已回退';

  const customerOptions = useMemo(
    () => customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` })),
    [customers],
  );
  const shipmentOptions = useMemo(
    () =>
      shipments.map((s) => ({
        value: s.id,
        label: `${s.code}${s.customer_name ? ` · ${s.customer_name}` : ''}`,
      })),
    [shipments],
  );

  function onPickCustomer(customerId: string) {
    const row = customers.find((c) => c.id === customerId);
    setForm((prev) => ({
      ...prev,
      sender_customer_id: customerId,
      sender_name: row?.name || prev.sender_name,
    }));
  }

  function onPickShipment(shipmentId: string) {
    const row = shipments.find((s) => s.id === shipmentId);
    const summary = (row?.lines ?? [])
      .map((line) => `${line.product_name || '货物'}×${line.quantity || '?'}`)
      .join('；')
      .slice(0, 500);
    setForm((prev) => ({
      ...prev,
      stock_out_id: shipmentId,
      stock_out_code: row?.code || '',
      goods_summary: summary || prev.goods_summary,
      sender_name: prev.sender_name || row?.customer_name || '',
    }));
  }

  async function createRecord() {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/ai/lite-apps/${id}/records`, {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: {
          sender_customer_id: form.sender_customer_id || undefined,
          sender_name: form.sender_name,
          stock_out_id: form.stock_out_id || undefined,
          stock_out_code: form.stock_out_code,
          goods_summary: form.goods_summary,
          status: '待约',
        },
      });
      setOpen(false);
      setForm({ sender_customer_id: '', sender_name: '', stock_out_id: '', stock_out_code: '', goods_summary: '' });
      await reloadRecords();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function saveTracking(recordId: string) {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/ai/lite-apps/${id}/records/${recordId}`, {
        method: 'PATCH',
        csrfToken: session.csrf_token,
        body: { tracking_no: trackingDraft[recordId] ?? '' },
      });
      await reloadRecords();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(recordId: string, status: string) {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/ai/lite-apps/${id}/records/${recordId}`, {
        method: 'PATCH',
        csrfToken: session.csrf_token,
        body: { status },
      });
      await reloadRecords();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kgd-card" data-testid="sedric-lite-express">
      <h2>{app?.title || '快递约件'}</h2>
      {error && <div className="kgd-banner">{error}</div>}
      {app && (
        <p>
          <Tag>{statusText}</Tag>
          {app.menu_label ? ` 侧栏「${app.menu_label}」` : ''}
          。寄件人从客户带、货物从出库单带；填运单号回写出库扩展值。无快递连接器时手工填运单号。
        </p>
      )}
      {app?.status === 'rolled_back' && <p data-testid="sedric-lite-restored">已回退，菜单与约件记录已清理。</p>}
      {app?.status === 'enabled' && (
        <>
          <Space wrap style={{ marginBottom: 12 }}>
            <Button type="primary" onClick={() => setOpen(true)} data-testid="sedric-lite-new">
              新建约件
            </Button>
            {['', '待约', '已寄', '异常'].map((key) => (
              <Button
                key={key || 'all'}
                type={statusFilter === key ? 'primary' : 'default'}
                onClick={() => {
                  setStatusFilter(key);
                  void reloadRecords(key).catch((failure) => setError(errorMessage(failure)));
                }}
              >
                {key || '全部'}
              </Button>
            ))}
          </Space>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={items}
            locale={{ emptyText: '还没有约件' }}
            columns={[
              {
                title: '状态',
                dataIndex: 'status',
                width: 120,
                render: (value: string, row) => (
                  <Select
                    size="small"
                    value={value}
                    style={{ width: 100 }}
                    options={['待约', '已寄', '异常'].map((s) => ({ value: s, label: s }))}
                    onChange={(next) => void changeStatus(row.id, next)}
                  />
                ),
              },
              { title: '寄件人', dataIndex: 'sender_name' },
              { title: '出库单', dataIndex: 'stock_out_code', render: (v: string) => v || '—' },
              { title: '货物摘要', dataIndex: 'goods_summary', ellipsis: true },
              {
                title: '运单号',
                width: 260,
                render: (_, row) => (
                  <Space>
                    <Input
                      size="small"
                      style={{ width: 140 }}
                      value={trackingDraft[row.id] ?? ''}
                      onChange={(e) => setTrackingDraft((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      placeholder="手工填运单号"
                      data-testid="sedric-lite-tracking"
                    />
                    <Button size="small" loading={busy} onClick={() => void saveTracking(row.id)}>
                      保存回写
                    </Button>
                  </Space>
                ),
              },
              {
                title: 'chip',
                width: 80,
                render: (_, row) => <Tag color={STATUS_COLOR[row.status] || 'default'}>{row.status}</Tag>,
              },
            ]}
          />
        </>
      )}
      <div style={{ marginTop: 16 }}>
        <Button onClick={() => navigate('/ai/ext-apps')}>返回扩展应用</Button>
      </div>
      <Drawer title="新建快递约件" open={open} onClose={() => setOpen(false)} width={420} destroyOnClose>
        <div className="kgd-form">
          <label>寄件人（客户）</label>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: '100%', marginBottom: 12 }}
            placeholder="选择客户"
            options={customerOptions}
            value={form.sender_customer_id || undefined}
            onChange={onPickCustomer}
          />
          <label>寄件人姓名</label>
          <Input
            style={{ marginBottom: 12 }}
            value={form.sender_name}
            onChange={(e) => setForm((prev) => ({ ...prev, sender_name: e.target.value }))}
          />
          <label>挂接出库单</label>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: '100%', marginBottom: 12 }}
            placeholder="选择销售出库单"
            options={shipmentOptions}
            value={form.stock_out_id || undefined}
            onChange={onPickShipment}
          />
          <label>货物摘要</label>
          <Input.TextArea
            rows={3}
            style={{ marginBottom: 16 }}
            value={form.goods_summary}
            onChange={(e) => setForm((prev) => ({ ...prev, goods_summary: e.target.value }))}
          />
          <Button type="primary" block loading={busy} onClick={() => void createRecord()} data-testid="sedric-lite-create">
            创建（状态：待约）
          </Button>
        </div>
      </Drawer>
    </div>
  );
}
