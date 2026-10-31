import { Alert, Button, Space, Typography } from 'antd';

export type AiConfirmCardModel = {
  title: string;
  summary: string;
  risk: string;
};

type Props = {
  card: AiConfirmCardModel;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** 聊天与 MES AI 页共用的确认卡展示（协议字段对齐 /api/ai/intake + writes） */
export function AiConfirmCard({ card, busy, onConfirm, onCancel }: Props) {
  return (
    <div className="sedric-ai-confirm-card" data-testid="sedric-ai-confirm-card">
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {card.title}
      </Typography.Title>
      <Typography.Paragraph>{card.summary}</Typography.Paragraph>
      <Alert type="warning" showIcon message={card.risk || '确认前不写库'} style={{ marginBottom: 12 }} />
      <Space>
        <Button type="primary" loading={busy} data-testid="sedric-ai-confirm-write" onClick={onConfirm}>
          确认写入
        </Button>
        <Button disabled={busy} data-testid="sedric-ai-confirm-cancel" onClick={onCancel}>
          取消
        </Button>
      </Space>
    </div>
  );
}
