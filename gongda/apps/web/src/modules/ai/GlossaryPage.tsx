import { useEffect, useState } from 'react';
import { Button, Input, Select, Space, Table, Tag } from 'antd';
import { BookOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';
import { AiConfirmCard, type AiConfirmCardModel } from './ConfirmCard';
import './ai.css';

type GlossaryItem = {
  id: string;
  kind: 'alias' | 'default_rule' | 'correction';
  phrase: string;
  target_kind: string;
  target_code: string;
  target_label: string;
  note: string;
};

const KIND_TEXT = { alias: '别名/叫法', default_rule: '默认规则', correction: '纠错记忆' };

export function GlossaryPage() {
  const navigate = useNavigate();
  const { session, onChanged } = useKgd();
  const [items, setItems] = useState<GlossaryItem[]>([]);
  const [kind, setKind] = useState<GlossaryItem['kind']>('alias');
  const [phrase, setPhrase] = useState('');
  const [targetKind, setTargetKind] = useState<'material' | 'customer'>('material');
  const [targetQuery, setTargetQuery] = useState('');
  const [note, setNote] = useState('');
  const [corrected, setCorrected] = useState('');
  const [taxIncluded, setTaxIncluded] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [card, setCard] = useState<AiConfirmCardModel | null>(null);
  const [previewId, setPreviewId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function reload() {
    const data = await apiRequest<{ items: GlossaryItem[] }>('/api/ai/glossary');
    setItems(data.items ?? []);
  }

  useEffect(() => {
    void reload().catch((failure) => setError(errorMessage(failure)));
  }, []);

  async function openPreview(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const data = await apiRequest<{ preview_id: string; confirm_card: AiConfirmCardModel; written: boolean }>(
        '/api/ai/glossary/preview',
        { method: 'POST', csrfToken: session.csrf_token, body },
      );
      if (data.written) throw new Error('预览接口不应写库');
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
    setError('');
    try {
      await apiRequest('/api/ai/writes/confirm', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: { kind: 'glossary', preview_id: previewId },
      });
      setCard(null);
      setPreviewId('');
      setEditing(null);
      setPhrase('');
      setNote('');
      onChanged();
      await reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!previewId) {
      setCard(null);
      return;
    }
    setBusy(true);
    try {
      await apiRequest('/api/ai/writes/cancel', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: { kind: 'glossary', preview_id: previewId },
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
    <div className="kgd-card sedric-ai-center" data-testid="sedric-glossary-page">
      <h2><BookOutlined /> 本厂词典</h2>
      <p>别名、默认规则和纠错记忆。绑定物料或客户时只保存已有主数据 ID。写入前先出确认卡。</p>
      {error && <div className="kgd-banner">{error}</div>}
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          value={kind}
          style={{ width: 140 }}
          onChange={(value) => setKind(value)}
          options={[
            { value: 'alias', label: '别名/叫法' },
            { value: 'default_rule', label: '默认规则' },
            { value: 'correction', label: '纠错记忆' },
          ]}
        />
        <Input style={{ width: 160 }} placeholder="叫法，如大板" value={phrase} onChange={(event) => setPhrase(event.target.value)} />
        {kind === 'alias' && (
          <>
            <Select
              value={targetKind}
              style={{ width: 100 }}
              onChange={(value) => setTargetKind(value)}
              options={[{ value: 'material', label: '物料' }, { value: 'customer', label: '客户' }]}
            />
            <Input style={{ width: 180 }} placeholder="已有编码或名称" value={targetQuery} onChange={(event) => setTargetQuery(event.target.value)} />
          </>
        )}
        {kind === 'default_rule' && (
          <Select
            value={taxIncluded ? 'yes' : 'no'}
            style={{ width: 120 }}
            onChange={(value) => setTaxIncluded(value === 'yes')}
            options={[{ value: 'yes', label: '默认含税' }, { value: 'no', label: '默认不含税' }]}
          />
        )}
        {kind === 'correction' && (
          <Input style={{ width: 180 }} placeholder="纠正为" value={corrected} onChange={(event) => setCorrected(event.target.value)} />
        )}
        <Input style={{ width: 160 }} placeholder="备注" value={note} onChange={(event) => setNote(event.target.value)} />
        <Button
          type="primary"
          loading={busy}
          data-testid="sedric-glossary-preview"
          onClick={() => void openPreview({
            op: editing ? 'update' : 'create',
            id: editing,
            kind,
            phrase,
            target_kind: targetKind,
            target_query: targetQuery,
            note,
            corrected,
            tax_included: taxIncluded,
          })}
        >
          生成确认卡
        </Button>
      </Space>
      {card && <AiConfirmCard card={card} busy={busy} onConfirm={() => void confirm()} onCancel={() => void cancel()} />}
      <div data-testid="sedric-glossary-list">
      <Table
        style={{ marginTop: 16 }}
        size="small"
        rowKey="id"
        dataSource={items}
        pagination={false}
        locale={{ emptyText: '词典还是空的' }}
        columns={[
          { title: '类型', dataIndex: 'kind', render: (value: GlossaryItem['kind']) => <Tag>{KIND_TEXT[value]}</Tag> },
          { title: '叫法', dataIndex: 'phrase', render: (value: string) => <span data-testid="sedric-glossary-phrase">{value}</span> },
          { title: '指向', render: (_, row) => [row.target_code, row.target_label].filter(Boolean).join(' ') || '—' },
          { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' },
          {
            title: '操作',
            render: (_, row) => (
              <Space>
                <Button
                  type="link"
                  onClick={() => {
                    setEditing(row.id);
                    setKind(row.kind);
                    setPhrase(row.phrase);
                    setNote(row.note);
                    if (row.target_kind === 'customer' || row.target_kind === 'material') setTargetKind(row.target_kind);
                    setTargetQuery(row.target_code || row.target_label);
                  }}
                >
                  编辑
                </Button>
                <Button type="link" danger data-testid="sedric-glossary-delete" onClick={() => void openPreview({ op: 'delete', id: row.id })}>
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />
      </div>
      <div className="actions" style={{ marginTop: 16 }}>
        <Button onClick={() => navigate('/ai/center')}>返回 AI 中心</Button>
      </div>
    </div>
  );
}
