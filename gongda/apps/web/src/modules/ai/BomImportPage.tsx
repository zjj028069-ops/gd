import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import { InboxOutlined, RobotOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';
import './ai.css';

type BomField = 'code' | 'name' | 'spec' | 'unit' | 'quantity' | 'loss_rate' | '';
type ColumnMapping = Partial<Record<Exclude<BomField, ''>, string>>;
type PreviewRow = {
  index: number;
  cells: Record<string, string>;
  code: string;
  name: string;
  spec: string;
  unit: string;
  quantity: string;
  loss_rate: string;
  component_product_id: string | null;
  component_name: string | null;
  match: 'matched' | 'unmatched' | 'ambiguous' | 'skipped';
  warning?: string;
};
type ParseResult = {
  preview_id: string;
  columns: string[];
  mapping: ColumnMapping;
  rows: PreviewRow[];
  warnings: string[];
};
type ProductOption = { id: string; code: string; name: string; attribute: string | null };

const FIELD_LABELS: { key: Exclude<BomField, ''>; label: string }[] = [
  { key: 'code', label: '物料编码' },
  { key: 'name', label: '物料名称' },
  { key: 'spec', label: '规格' },
  { key: 'unit', label: '单位' },
  { key: 'quantity', label: '用量' },
  { key: 'loss_rate', label: '损耗率' },
];

const MATCH_TAG: Record<PreviewRow['match'], { color: string; text: string }> = {
  matched: { color: 'success', text: '已匹配' },
  unmatched: { color: 'error', text: '未匹配' },
  ambiguous: { color: 'warning', text: '多条匹配' },
  skipped: { color: 'default', text: '跳过' },
};

async function uploadParse(file: File, csrf: string): Promise<ParseResult> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/ai/bom/parse', {
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

export function BomImportPage() {
  const navigate = useNavigate();
  const { session, onExpired } = useKgd();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [productId, setProductId] = useState<string | undefined>();
  const [bomName, setBomName] = useState('');
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [schemeName, setSchemeName] = useState('');

  useEffect(() => {
    void apiRequest<{ items: ProductOption[] }>('/api/products?page=1&page_size=100&attribute=manufactured')
      .then((res) => setProducts((res.items ?? []).filter((p) => p.attribute === 'manufactured' || !p.attribute)))
      .catch((failure) => {
        if ((failure as { status?: number }).status === 401) onExpired();
      });
  }, [onExpired]);

  const columns = useMemo(() => {
    if (!preview) return [];
    return [
      { title: '#', dataIndex: 'index', width: 56 },
      { title: '编码', dataIndex: 'code', width: 120 },
      { title: '名称', dataIndex: 'name', width: 140, render: (_: string, row: PreviewRow) => row.name || row.component_name || '-' },
      { title: '规格', dataIndex: 'spec', width: 100 },
      { title: '单位', dataIndex: 'unit', width: 72 },
      { title: '用量', dataIndex: 'quantity', width: 80 },
      { title: '损耗率', dataIndex: 'loss_rate', width: 80 },
      {
        title: '匹配',
        dataIndex: 'match',
        width: 100,
        render: (match: PreviewRow['match']) => {
          const tag = MATCH_TAG[match];
          return <Tag color={tag.color}>{tag.text}</Tag>;
        },
      },
      { title: '说明', dataIndex: 'warning', ellipsis: true },
    ];
  }, [preview]);

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      const result = await uploadParse(file, session.csrf_token);
      setPreview(result);
      setMapping(result.mapping ?? {});
      setBomName(file.name.replace(/\.(xlsx|xls|csv|pdf)$/i, '') || 'AI导入BOM');
      message.success(`已解析 ${result.rows.length} 行（尚未写入物料清单）`);
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
    } finally {
      setBusy(false);
    }
    return false;
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const wrapped = await apiRequest<{
        kind: string;
        audit_id: string;
        data: { bom: { id: string; name: string }; items_count: number; warnings?: string[] };
      }>('/api/ai/writes/confirm', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: {
          kind: 'bom',
          preview_id: preview.preview_id,
          mapping,
          product_id: productId || null,
          name: bomName || undefined,
        },
      });
      const result = wrapped.data;
      message.success(`已写入物料清单「${result.bom.name}」，共 ${result.items_count} 行`);
      if (result.warnings?.length) message.warning(result.warnings.slice(0, 3).join('；'));
      setPreview(null);
      navigate(`/bom/edit/${result.bom.id}`);
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
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
        body: { kind: 'bom', preview_id: preview.preview_id },
      });
      setPreview(null);
      setMapping({});
      message.info('已取消预览，未写入任何物料清单');
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const saveScheme = async () => {
    if (!schemeName.trim()) {
      message.warning('请填写方案名称');
      return;
    }
    try {
      await apiRequest('/api/ai/bom/schemes', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: { name: schemeName.trim(), mapping },
      });
      message.success('映射方案已保存');
      setSchemeName('');
    } catch (failure) {
      message.error(errorMessage(failure));
    }
  };

  return (
    <div className="kgd-card sedric-ai-bom" data-testid="sedric-ai-bom">
      <div className="sedric-ai-bom-head">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/ai/center')}>返回 AI 中心</Button>
          <h2><RobotOutlined /> AI 导入 BOM</h2>
        </Space>
        <p className="muted">上传 Excel / CSV / PDF → 预览并调整列映射 → 确认后才写入物料清单。取消不会落库。</p>
      </div>

      {!preview && (
        <Card className="sedric-ai-bom-upload" data-testid="sedric-ai-bom-upload">
          <Upload.Dragger
            accept=".xlsx,.xls,.csv,.pdf,application/pdf"
            multiple={false}
            showUploadList={false}
            disabled={busy}
            beforeUpload={(file) => {
              void onUpload(file);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">点击或拖拽上传 Excel / CSV / PDF</p>
            <p className="ant-upload-hint">支持 Excel、CSV、PDF（含文字层）。列：物料编码、名称、规格、单位、用量、损耗率（中英表头均可）。解析阶段不写业务表。</p>
          </Upload.Dragger>
        </Card>
      )}

      {preview && (
        <>
          {!!preview.warnings?.length && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={preview.warnings.join('；')} />
          )}
          <Card title="列映射" size="small" className="sedric-ai-bom-mapping" data-testid="sedric-ai-bom-mapping">
            <Row gutter={[12, 12]}>
              {FIELD_LABELS.map((field) => (
                <Col xs={24} sm={12} md={8} key={field.key}>
                  <label className="sedric-ai-bom-field">
                    <span>{field.label}</span>
                    <Select
                      allowClear
                      placeholder="选择列"
                      value={mapping[field.key]}
                      options={preview.columns.map((col) => ({ value: col, label: col }))}
                      onChange={(value) => setMapping((cur) => ({ ...cur, [field.key]: value }))}
                      style={{ width: '100%' }}
                    />
                  </label>
                </Col>
              ))}
            </Row>
            <Space wrap style={{ marginTop: 12 }}>
              <Input
                placeholder="方案名称（可选保存）"
                value={schemeName}
                onChange={(e) => setSchemeName(e.target.value)}
                style={{ width: 200 }}
              />
              <Button onClick={() => void saveScheme()}>保存映射方案</Button>
            </Space>
          </Card>

          <Card title="写入目标" size="small" style={{ marginTop: 12 }}>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <label className="sedric-ai-bom-field">
                  <span>BOM 名称</span>
                  <Input value={bomName} onChange={(e) => setBomName(e.target.value)} />
                </label>
              </Col>
              <Col xs={24} md={12}>
                <label className="sedric-ai-bom-field">
                  <span>母件商品（可选，须为制造件）</span>
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder="不选则按名称创建独立 BOM"
                    value={productId}
                    onChange={(v) => setProductId(v)}
                    options={products.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
                    style={{ width: '100%' }}
                  />
                </label>
              </Col>
            </Row>
          </Card>

          <Card
            title={`预览（${preview.rows.length} 行）`}
            size="small"
            style={{ marginTop: 12 }}
            data-testid="sedric-ai-bom-preview"
            extra={
              <Space>
                <Button danger disabled={busy} data-testid="sedric-ai-bom-cancel" onClick={() => void cancel()}>
                  取消
                </Button>
                <Button type="primary" disabled={busy} data-testid="sedric-ai-bom-confirm" onClick={() => void confirm()}>
                  确认写入物料清单
                </Button>
              </Space>
            }
          >
            <Table
              size="small"
              rowKey={(row) => String(row.index)}
              dataSource={preview.rows}
              columns={columns}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 900 }}
            />
          </Card>
        </>
      )}
    </div>
  );
}
