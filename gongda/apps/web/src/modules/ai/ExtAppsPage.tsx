import { useEffect, useState } from 'react';
import { Button, Input, Space, Table, Tag } from 'antd';
import { AppstoreAddOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';
import { AiConfirmCard, type AiConfirmCardModel } from './ConfirmCard';
import './ai.css';

type ExtItem = {
  id: string;
  title: string;
  status: 'enabled' | 'disabled' | 'rolled_back';
  entity: string;
  menu_label: string;
  menu_path: string;
  utterance: string;
};

const STATUS_TEXT = { enabled: '启用', disabled: '停用', rolled_back: '已回退' };

export function ExtAppsPage() {
  const navigate = useNavigate();
  const { session, onChanged } = useKgd();
  const [items, setItems] = useState<ExtItem[]>([]);
  const [text, setText] = useState('给加工单加一个紧急度字段并进菜单');
  const [card, setCard] = useState<AiConfirmCardModel | null>(null);
  const [previewId, setPreviewId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function reload() {
    const data = await apiRequest<{ items: ExtItem[] }>('/api/ai/ext-apps');
    setItems(data.items ?? []);
  }

  useEffect(() => {
    void reload().catch((failure) => setError(errorMessage(failure)));
  }, []);

  async function openPreview(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const data = await apiRequest<{ preview_id: string; confirm_card: AiConfirmCardModel }>(
        '/api/ai/ext-apps/preview',
        { method: 'POST', csrfToken: session.csrf_token, body },
      );
      setPreviewId(data.preview_id);
      setCard(data.confirm_card);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!previewId) return;
    setBusy(true);
    try {
      await apiRequest('/api/ai/writes/confirm', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: { kind: 'ext_app', preview_id: previewId },
      });
      setCard(null);
      setPreviewId('');
      onChanged();
      await reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!previewId) return;
    setBusy(true);
    try {
      await apiRequest('/api/ai/writes/cancel', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: { kind: 'ext_app', preview_id: previewId },
      });
      setCard(null);
      setPreviewId('');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kgd-card sedric-ai-center" data-testid="sedric-ext-apps-page">
      <h2><AppstoreAddOutlined /> 扩展应用</h2>
      <p>一句话生成加工单等已有对象上的扩展字段、视图和菜单。确认后才写入配置，可启用、停用或回退。</p>
      {error && <div className="kgd-banner">{error}</div>}
      <Space wrap style={{ marginBottom: 12 }}>
        <Input style={{ width: 420 }} value={text} onChange={(event) => setText(event.target.value)} data-testid="sedric-ext-utterance" />
        <Button type="primary" loading={busy} data-testid="sedric-ext-preview" onClick={() => void openPreview({ text })}>
          生成方案预览
        </Button>
      </Space>
      {card && (
        <div data-testid="sedric-ext-plan-card">
          <AiConfirmCard card={card} busy={busy} onConfirm={() => void confirm()} onCancel={() => void cancel()} />
        </div>
      )}
      <Table
        style={{ marginTop: 16 }}
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={items}
        locale={{ emptyText: '还没有扩展应用' }}
        columns={[
          { title: '名称', dataIndex: 'title', render: (value: string, row) => <Button type="link" onClick={() => navigate(row.menu_path || `/ai/ext-board/${row.id}`)}>{value}</Button> },
          { title: '状态', dataIndex: 'status', render: (value: ExtItem['status']) => <Tag data-testid="sedric-ext-status">{STATUS_TEXT[value]}</Tag> },
          { title: '菜单', dataIndex: 'menu_label', render: (value: string) => value || '—' },
          { title: '原话', dataIndex: 'utterance', ellipsis: true },
          {
            title: '操作',
            render: (_, row) => (
              <Space>
                {row.status === 'disabled' && <Button type="link" onClick={() => void openPreview({ op: 'enable', id: row.id })}>启用</Button>}
                {row.status === 'enabled' && <Button type="link" onClick={() => void openPreview({ op: 'disable', id: row.id })}>停用</Button>}
                {row.status !== 'rolled_back' && (
                  <Button type="link" danger data-testid="sedric-ext-rollback" onClick={() => void openPreview({ op: 'rollback', id: row.id })}>
                    回退
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <div className="actions" style={{ marginTop: 16 }}>
        <Button onClick={() => navigate('/ai/center')}>返回 AI 中心</Button>
      </div>
    </div>
  );
}
