import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Modal,
  Radio,
  Space,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  FileImageOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';
import './ai.css';

type Mode = 'process_route_draft' | 'link_work_order';

type StepRow = {
  index: number;
  name: string;
  note: string;
  standard_minutes: string;
  auto_inbound: boolean;
  process_id: string | null;
  match: 'matched' | 'unmatched' | 'new';
};

type ParseResult = {
  preview_id: string;
  filename?: string;
  note?: string;
  template?: string;
  route_name: string;
  steps: StepRow[];
  warnings: string[];
};

const MATCH_TAG: Record<StepRow['match'], { color: string; text: string }> = {
  matched: { color: 'success', text: '已有工序' },
  unmatched: { color: 'warning', text: '待核对' },
  new: { color: 'processing', text: '将新建' },
};

async function uploadParse(file: File, csrf: string, note: string): Promise<ParseResult> {
  const form = new FormData();
  form.append('file', file);
  if (note.trim()) form.append('note', note.trim());
  const response = await fetch('/api/ai/drawing/parse', {
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

export function DrawingSplitPage() {
  const navigate = useNavigate();
  const { session, onExpired } = useKgd();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [routeName, setRouteName] = useState('');
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [mode, setMode] = useState<Mode>('process_route_draft');
  const [workOrderId, setWorkOrderId] = useState('');
  const [syncWorkOrder, setSyncWorkOrder] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const columns = useMemo(() => [
    { title: '#', dataIndex: 'index', width: 56 },
    {
      title: '工序名称',
      dataIndex: 'name',
      width: 160,
      render: (value: string, row: StepRow) => (
        <Input
          size="small"
          value={value}
          data-testid={`sedric-ai-draw-step-name-${row.index}`}
          onChange={(e) => {
            const next = e.target.value;
            setSteps((cur) => cur.map((r) => (r.index === row.index ? { ...r, name: next, match: 'new' } : r)));
          }}
        />
      ),
    },
    {
      title: '说明',
      dataIndex: 'note',
      width: 180,
      render: (value: string, row: StepRow) => (
        <Input
          size="small"
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setSteps((cur) => cur.map((r) => (r.index === row.index ? { ...r, note: next } : r)));
          }}
        />
      ),
    },
    {
      title: '标准工时(分)',
      dataIndex: 'standard_minutes',
      width: 120,
      render: (value: string, row: StepRow) => (
        <Input
          size="small"
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setSteps((cur) => cur.map((r) => (r.index === row.index ? { ...r, standard_minutes: next } : r)));
          }}
        />
      ),
    },
    {
      title: '自动入库',
      dataIndex: 'auto_inbound',
      width: 90,
      render: (value: boolean, row: StepRow) => (
        <Checkbox
          checked={value}
          onChange={(e) => {
            const checked = e.target.checked;
            setSteps((cur) => cur.map((r) => (r.index === row.index ? { ...r, auto_inbound: checked } : r)));
          }}
        />
      ),
    },
    {
      title: '匹配',
      dataIndex: 'match',
      width: 100,
      render: (match: StepRow['match']) => {
        const tag = MATCH_TAG[match] ?? MATCH_TAG.new;
        return <Tag color={tag.color}>{tag.text}</Tag>;
      },
    },
    {
      title: '',
      key: 'actions',
      width: 64,
      render: (_: unknown, row: StepRow) => (
        <Button
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          aria-label="删除工序"
          onClick={() => {
            setSteps((cur) => cur.filter((r) => r.index !== row.index).map((r, i) => ({ ...r, index: i + 1 })));
          }}
        />
      ),
    },
  ], []);

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      const result = await uploadParse(file, session.csrf_token, note);
      setPreview(result);
      setRouteName(result.route_name || '');
      setSteps(result.steps ?? []);
      setMode('process_route_draft');
      setWorkOrderId('');
      setSyncWorkOrder(false);
      setConfirmOpen(false);
      message.success(`已生成工序预览（尚未写入）${result.steps?.length ? `，${result.steps.length} 道` : ''}`);
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
    } finally {
      setBusy(false);
    }
    return false;
  };

  const addStep = () => {
    setSteps((cur) => [
      ...cur,
      {
        index: cur.length + 1,
        name: '',
        note: '',
        standard_minutes: '1',
        auto_inbound: false,
        process_id: null,
        match: 'new',
      },
    ]);
  };

  const askConfirm = () => {
    if (!preview) return;
    if (!steps.some((s) => s.name.trim())) {
      message.warning('请至少填写一道工序名称');
      return;
    }
    if (mode === 'link_work_order' && !workOrderId.trim()) {
      message.warning('关联工单请填写加工单 ID');
      return;
    }
    if (syncWorkOrder && mode === 'link_work_order') {
      setConfirmOpen(true);
      return;
    }
    void doConfirm(false);
  };

  const doConfirm = async (fromModal: boolean) => {
    if (!preview) return;
    if (syncWorkOrder && mode === 'link_work_order' && !fromModal) {
      setConfirmOpen(true);
      return;
    }
    setBusy(true);
    try {
      const wrapped = await apiRequest<{
        kind: string;
        audit_id: string;
        data: {
          mode: Mode;
          route: { id: string; code: string; name: string };
          route_version_id: string;
          sync_work_order?: boolean;
          warnings?: string[];
        };
      }>('/api/ai/writes/confirm', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: {
          kind: 'drawing',
          preview_id: preview.preview_id,
          mode,
          work_order_id: mode === 'link_work_order' ? workOrderId.trim() || undefined : undefined,
          sync_work_order: mode === 'link_work_order' ? syncWorkOrder : false,
          route_name: routeName,
          steps,
        },
      });
      const result = wrapped.data;
      message.success(
        result.sync_work_order
          ? `已写入工艺路线 ${result.route.code}，并同步加工单路线`
          : `已写入工艺路线草案 ${result.route.code}`,
      );
      if (result.warnings?.length) message.warning(result.warnings.join('；'));
      setPreview(null);
      setSteps([]);
      setRouteName('');
      setConfirmOpen(false);
      if (result.route?.id) navigate(`/process_routing/edit/${result.route.id}`);
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
      setConfirmOpen(false);
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
        body: { kind: 'drawing', preview_id: preview.preview_id },
      });
      setPreview(null);
      setSteps([]);
      setRouteName('');
      setConfirmOpen(false);
      message.info('已取消预览，未写入工艺路线或工单');
    } catch (failure) {
      if ((failure as { status?: number }).status === 401) onExpired();
      message.error(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kgd-card sedric-ai-draw" data-testid="sedric-ai-drawing">
      <div className="sedric-ai-draw-head">
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/ai/center')}>返回 AI 中心</Button>
          <h2><FileImageOutlined /> 图纸拆单</h2>
        </Space>
        <p className="muted">
          上传 PDF/图片 → 识别工序草案 → 人工确认 → 仅工艺路线草案，或关联已有工单。
          <strong>同步写工单须二次确认</strong>。确认前不落库。
        </p>
      </div>

      {!preview && (
        <Card className="sedric-ai-draw-upload" data-testid="sedric-ai-draw-upload">
          <label className="sedric-ai-draw-note">
            <span>可选文字说明（辅助选模板 / AI 识别）</span>
            <Input.TextArea
              rows={2}
              value={note}
              placeholder="例如：女装连衣裙缝制 / 机加轴件精加工"
              onChange={(e) => setNote(e.target.value)}
              data-testid="sedric-ai-draw-note"
            />
          </label>
          <Upload.Dragger
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif"
            multiple={false}
            showUploadList={false}
            disabled={busy}
            beforeUpload={(file) => {
              void onUpload(file);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon"><FileImageOutlined /></p>
            <p className="ant-upload-text">点击或拖拽上传图纸（PDF / 图片）</p>
            <p className="ant-upload-hint">无密钥时返回可编辑工序模板并提示核对；解析阶段不写业务表。</p>
          </Upload.Dragger>
        </Card>
      )}

      {preview && (
        <>
          {!!preview.warnings?.length && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={preview.warnings.join('；')} />
          )}

          <Card title="工艺路线名称" size="small" style={{ marginBottom: 12 }} data-testid="sedric-ai-draw-route-name">
            <Input value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder="工艺路线名称" />
          </Card>

          <Card
            title="工序草案（可改增删）"
            size="small"
            style={{ marginBottom: 12 }}
            data-testid="sedric-ai-draw-steps"
            extra={
              <Button size="small" icon={<PlusOutlined />} onClick={addStep} data-testid="sedric-ai-draw-add-step">
                增工序
              </Button>
            }
          >
            <Table
              size="small"
              rowKey="index"
              pagination={false}
              dataSource={steps}
              columns={columns}
              scroll={{ x: 860 }}
            />
          </Card>

          <Card title="写入方式" size="small" style={{ marginBottom: 12 }} data-testid="sedric-ai-draw-mode">
            <Radio.Group
              value={mode}
              onChange={(e) => {
                const next = e.target.value as Mode;
                setMode(next);
                if (next === 'process_route_draft') {
                  setSyncWorkOrder(false);
                }
              }}
              options={[
                { label: '仅工艺路线草案', value: 'process_route_draft' },
                { label: '关联已有工单', value: 'link_work_order' },
              ]}
            />
            {mode === 'link_work_order' && (
              <div className="sedric-ai-draw-link" style={{ marginTop: 12 }}>
                <label>
                  <span>加工单 ID</span>
                  <Input
                    value={workOrderId}
                    placeholder="work_order UUID"
                    onChange={(e) => setWorkOrderId(e.target.value)}
                    data-testid="sedric-ai-draw-wo-id"
                  />
                </label>
                <Checkbox
                  style={{ marginTop: 10 }}
                  checked={syncWorkOrder}
                  onChange={(e) => setSyncWorkOrder(e.target.checked)}
                  data-testid="sedric-ai-draw-sync"
                >
                  同步写工单路线（须二次确认）
                </Checkbox>
              </div>
            )}
          </Card>

          <div className="sedric-ai-draw-actions" data-testid="sedric-ai-draw-actions">
            <Space wrap>
              <Button
                type="primary"
                icon={<RobotOutlined />}
                disabled={busy}
                data-testid="sedric-ai-draw-confirm"
                onClick={() => askConfirm()}
              >
                {syncWorkOrder && mode === 'link_work_order' ? '确认并同步工单…' : '确认写入工艺路线'}
              </Button>
              <Button disabled={busy} data-testid="sedric-ai-draw-cancel" onClick={() => void cancel()}>
                取消预览
              </Button>
            </Space>
          </div>
        </>
      )}

      <Modal
        title="二次确认：同步写工单"
        open={confirmOpen}
        okText="确认同步写入"
        cancelText="返回修改"
        okButtonProps={{ danger: true, 'data-testid': 'sedric-ai-draw-sync-ok' } as never}
        onOk={() => void doConfirm(true)}
        onCancel={() => setConfirmOpen(false)}
        confirmLoading={busy}
        data-testid="sedric-ai-draw-sync-modal"
      >
        <p>
          将创建工艺路线草案，并把加工单 <code>{workOrderId.trim() || '（未填）'}</code> 的路线版本改绑到新草案。
          仅未开始的加工单可同步。是否继续？
        </p>
      </Modal>
    </div>
  );
}
