import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Input,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import { InboxOutlined, RobotOutlined, ArrowLeftOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';
import { useRemote } from '../../masterTools';
import './ai.css';

type Target = 'work_order' | 'sales_order';

type LineRow = {
  index: number;
  product_code: string;
  product_name: string;
  quantity: string;
  unit_price: string;
  product_id: string | null;
  product_label: string | null;
  match: 'matched' | 'unmatched' | 'ambiguous' | 'skipped';
  warning?: string;
};

type OrderFields = {
  customer_code: string;
  customer_name: string;
  customer_id: string | null;
  product_code: string;
  product_name: string;
  product_id: string | null;
  quantity: string;
  unit_price: string;
  due_date: string;
  promised_date: string;
  note: string;
  priority: string;
};

type CustomerItem = {
  id: string;
  code?: string | null;
  name?: string | null;
};

type ParseResult = {
  preview_id: string;
  doc_type?: string;
  fields: OrderFields;
  line_rows: LineRow[];
  warnings: string[];
  quota?: QuotaInfo;
};

type QuotaInfo = {
  used: number;
  limit: number;
  remaining: number;
  day: string;
  unlimited: boolean;
};

const MATCH_TAG: Record<LineRow['match'], { color: string; text: string }> = {
  matched: { color: 'success', text: '已匹配' },
  unmatched: { color: 'error', text: '未匹配' },
  ambiguous: { color: 'warning', text: '多条匹配' },
  skipped: { color: 'default', text: '跳过' },
};

const EMPTY_CUSTOMERS: CustomerItem[] = [];

async function uploadParse(file: File, csrf: string): Promise<ParseResult> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/ai/quick-order/parse', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-CSRF-Token': csrf },
    body: form,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, failure?.error?.code ?? `HTTP_${response.status}`, failure?.error?.message ?? '上传解析失败');
  }
  return payload as ParseResult;
}

export function QuickOrderPage() {
  const navigate = useNavigate();
  const { session, revision, onExpired } = useKgd();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [target, setTarget] = useState<Target>('work_order');
  const [fields, setFields] = useState<OrderFields | null>(null);
  const [rows, setRows] = useState<LineRow[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [confirming, setConfirming] = useState(false);

  const customersRemote = useRemote<{ items: CustomerItem[] }>(
    preview ? '/api/money/customers' : null,
    revision,
    onExpired,
  );
  const customerItems = customersRemote.data?.items ?? EMPTY_CUSTOMERS;
  const customerOptions = useMemo(
    () =>
      customerItems.map((item) => ({
        value: String(item.id),
        label: `${item.code ?? ''} ${item.name ?? ''}`.trim() || String(item.id),
        code: String(item.code ?? ''),
        name: String(item.name ?? ''),
      })),
    [customerItems],
  );

  // 解析已带 customer_id 时预选；仅有编码/名称无 id 时按 code 匹配主数据
  useEffect(() => {
    if (!customerItems.length) return;
    setFields((cur) => {
      if (!cur) return cur;
      if (cur.customer_id) {
        const found = customerItems.find((item) => String(item.id) === String(cur.customer_id));
        if (!found) return cur;
        const nextCode = String(found.code ?? cur.customer_code);
        const nextName = String(found.name ?? cur.customer_name);
        if (cur.customer_code === nextCode && cur.customer_name === nextName) return cur;
        return { ...cur, customer_code: nextCode, customer_name: nextName };
      }
      const code = (cur.customer_code || '').trim();
      if (!code) return cur;
      const byCode = customerItems.find(
        (item) => String(item.code ?? '').trim().toLowerCase() === code.toLowerCase(),
      );
      if (!byCode) return cur;
      return {
        ...cur,
        customer_id: String(byCode.id),
        customer_code: String(byCode.code ?? cur.customer_code),
        customer_name: String(byCode.name ?? cur.customer_name),
      };
    });
  }, [customerItems]);

  const loadQuota = async () => {
    try {
      const q = await apiRequest<QuotaInfo>('/api/ai/quick-order/quota');
      setQuota(q);
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
    }
  };

  useEffect(() => {
    void loadQuota();
  }, [onExpired]);

  const columns = useMemo(() => [
    { title: '#', dataIndex: 'index', width: 56 },
    {
      title: '商品编码',
      dataIndex: 'product_code',
      width: 140,
      render: (value: string, row: LineRow) => (
        <Input
          size="small"
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setRows((cur) => cur.map((r) => (r.index === row.index ? { ...r, product_code: next } : r)));
          }}
        />
      ),
    },
    {
      title: '商品名称',
      dataIndex: 'product_name',
      width: 160,
      render: (value: string, row: LineRow) => (
        <Input
          size="small"
          value={value || row.product_label || ''}
          onChange={(e) => {
            const next = e.target.value;
            setRows((cur) => cur.map((r) => (r.index === row.index ? { ...r, product_name: next } : r)));
          }}
        />
      ),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      width: 100,
      render: (value: string, row: LineRow) => (
        <Input
          size="small"
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setRows((cur) => cur.map((r) => (r.index === row.index ? { ...r, quantity: next } : r)));
          }}
        />
      ),
    },
    {
      title: '单价',
      dataIndex: 'unit_price',
      width: 100,
      render: (value: string, row: LineRow) => (
        <Input
          size="small"
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setRows((cur) => cur.map((r) => (r.index === row.index ? { ...r, unit_price: next } : r)));
          }}
        />
      ),
    },
    {
      title: '匹配',
      dataIndex: 'match',
      width: 100,
      render: (match: LineRow['match']) => {
        const tag = MATCH_TAG[match];
        return <Tag color={tag.color}>{tag.text}</Tag>;
      },
    },
    { title: '说明', dataIndex: 'warning', ellipsis: true },
  ], []);

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      const result = await uploadParse(file, session.csrf_token);
      setPreview(result);
      setFields(result.fields);
      setRows(result.line_rows ?? []);
      if (result.quota) setQuota(result.quota);
      setTarget('work_order');
      setConfirming(false);
      message.success(`已解析预览（尚未写入单据）${result.line_rows?.length ? `，${result.line_rows.length} 行` : ''}`);
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
    } finally {
      setBusy(false);
    }
    return false;
  };

  const doConfirm = async () => {
    if (!preview || !fields) return;
    setBusy(true);
    try {
      const wrapped = await apiRequest<{
        kind: string;
        audit_id: string;
        data: {
          target: Target;
          document_id: string;
          document_code: string;
          id?: string;
          code?: string;
          quota?: QuotaInfo;
        };
      }>('/api/ai/writes/confirm', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: {
          kind: 'quick_order',
          preview_id: preview.preview_id,
          target,
          overrides: {
            ...fields,
            line_rows: rows,
          },
        },
      });
      const result = wrapped.data;
      const code = result.document_code || result.code || '';
      const id = result.document_id || result.id || '';
      message.success(
        target === 'work_order'
          ? `已生成加工单 ${code || id}`
          : `已生成销售单 ${code || id}`,
      );
      if (result.quota) setQuota(result.quota);
      else void loadQuota();
      setPreview(null);
      setFields(null);
      setRows([]);
      setConfirming(false);
      if (target === 'work_order' && id) navigate(`/work_order/detail/${id}`);
      else if (target === 'sales_order' && id) navigate(`/sales_order/detail/${id}`);
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await apiRequest('/api/ai/writes/cancel', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: { kind: 'quick_order', preview_id: preview.preview_id },
      });
      setPreview(null);
      setFields(null);
      setRows([]);
      setConfirming(false);
      message.info('已取消预览，未写入任何单据');
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const quotaText = quota
    ? quota.unlimited
      ? `今日已用 ${quota.used} 次（不限）`
      : `今日剩余 ${quota.remaining} / ${quota.limit} 次`
    : '次数加载中…';

  return (
    <div className="kgd-card sedric-ai-qo" data-testid="sedric-ai-quick-order">
      <div className="sedric-ai-qo-head">
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/ai/center')}>返回 AI 中心</Button>
          <h2><ThunderboltOutlined /> 极速下单</h2>
          <Tag color="blue" data-testid="sedric-ai-qo-quota">{quotaText}</Tag>
        </Space>
        <p className="muted">上传单据图/PDF/Excel → 预览可改 → 二次确认后生成加工单或销售单（默认加工单）。确认前不落库。</p>
      </div>

      {!preview && (
        <Card className="sedric-ai-qo-upload" data-testid="sedric-ai-qo-upload">
          <Upload.Dragger
            accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp"
            multiple={false}
            showUploadList={false}
            disabled={busy}
            beforeUpload={(file) => {
              void onUpload(file);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">点击或拖拽上传单据（Excel / CSV / PDF / 图片）</p>
            <p className="ant-upload-hint">表格自动映射列；图片/PDF 可手录。解析阶段不写业务表。</p>
          </Upload.Dragger>
        </Card>
      )}

      {preview && fields && (
        <>
          {!!preview.warnings?.length && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={preview.warnings.join('；')} />
          )}

          <Card title="目标单据" size="small" style={{ marginBottom: 12 }} data-testid="sedric-ai-qo-target">
            <Radio.Group
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              options={[
                { label: '加工单（默认）', value: 'work_order' },
                { label: '销售单', value: 'sales_order' },
              ]}
            />
          </Card>

          <Card title="单据字段（可改）" size="small" style={{ marginBottom: 12 }} data-testid="sedric-ai-qo-fields">
            <div className="sedric-ai-qo-fields-grid">
              <label className="sedric-ai-qo-customer">
                <span>客户</span>
                <Select
                  showSearch
                  allowClear
                  optionFilterProp="label"
                  disabled={target === 'work_order'}
                  loading={customersRemote.loading}
                  placeholder={target === 'sales_order' ? '搜索并选择客户（主数据）' : '加工单可不填'}
                  value={fields.customer_id || undefined}
                  options={customerOptions}
                  onChange={(id, option) => {
                    if (!id) {
                      setFields({ ...fields, customer_id: null, customer_code: '', customer_name: '' });
                      return;
                    }
                    const opt = option as { code?: string; name?: string } | undefined;
                    const found = customerItems.find((item) => String(item.id) === String(id));
                    setFields({
                      ...fields,
                      customer_id: String(id),
                      customer_code: String(opt?.code ?? found?.code ?? ''),
                      customer_name: String(opt?.name ?? found?.name ?? ''),
                    });
                  }}
                  data-testid="sedric-ai-qo-customer"
                />
              </label>
              {target === 'sales_order' && (fields.customer_code || fields.customer_name) ? (
                <label>
                  <span>已选客户</span>
                  <Input
                    disabled
                    value={`${fields.customer_code || ''}${fields.customer_code && fields.customer_name ? ' · ' : ''}${fields.customer_name || ''}`}
                  />
                </label>
              ) : null}
              <label>
                <span>备注</span>
                <Input value={fields.note} onChange={(e) => setFields({ ...fields, note: e.target.value })} />
              </label>
              <label>
                <span>交期</span>
                <Input
                  value={fields.due_date || fields.promised_date}
                  placeholder="YYYY-MM-DD"
                  onChange={(e) => setFields({ ...fields, due_date: e.target.value, promised_date: e.target.value })}
                />
              </label>
            </div>
            {target === 'sales_order' && !fields.customer_id && (
              <Alert
                style={{ marginTop: 12 }}
                type="info"
                showIcon
                message="请从主数据选择客户后再确认生成销售单。"
              />
            )}
          </Card>

          <Card title="明细行（可改）" size="small" data-testid="sedric-ai-qo-lines">
            <Table
              size="small"
              rowKey="index"
              pagination={false}
              dataSource={rows}
              columns={columns}
              scroll={{ x: 800 }}
            />
          </Card>

          <div className="sedric-ai-qo-actions" data-testid="sedric-ai-qo-actions">
            <Space wrap>
              {!confirming ? (
                <Button
                  type="primary"
                  icon={<RobotOutlined />}
                  disabled={busy}
                  data-testid="sedric-ai-qo-confirm-ask"
                  onClick={() => setConfirming(true)}
                >
                  确认生成{target === 'work_order' ? '加工单' : '销售单'}
                </Button>
              ) : (
                <Button
                  type="primary"
                  danger
                  disabled={busy}
                  data-testid="sedric-ai-qo-confirm"
                  onClick={() => void doConfirm()}
                >
                  二次确认：立即写入
                </Button>
              )}
              <Button disabled={busy} data-testid="sedric-ai-qo-cancel" onClick={() => void cancel()}>
                取消预览
              </Button>
              {confirming && (
                <Button disabled={busy} onClick={() => setConfirming(false)}>返回修改</Button>
              )}
            </Space>
          </div>
        </>
      )}
    </div>
  );
}
