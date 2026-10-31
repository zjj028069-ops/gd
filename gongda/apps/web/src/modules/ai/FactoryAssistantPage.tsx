import { useMemo, useState } from 'react';
import { Button, Card, Input, Space, Table, Tag, message } from 'antd';
import { FundProjectionScreenOutlined, RobotOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';
import { openSedricAssistant } from './AiShell';
import './ai.css';

type CardItem = { title: string; value: string; hint?: string };
type AskResult = {
  answer: string;
  cards?: CardItem[];
  table?: { columns: string[]; rows: string[][] };
  intent?: string;
  citations?: { id: string; title: string }[];
};

const SUGGESTIONS = [
  '今天生产进度怎么样',
  '应收还有多少未收',
  '工资待审多少',
];

export function FactoryAssistantPage() {
  const { session, onExpired } = useKgd();
  const navigate = useNavigate();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [lastQ, setLastQ] = useState('');

  const tableData = useMemo(() => {
    if (!result?.table) return null;
    const { columns, rows } = result.table;
    return {
      columns: columns.map((title, index) => ({
        title,
        dataIndex: `c${index}`,
        key: `c${index}`,
      })),
      dataSource: rows.map((row, i) => {
        const item: Record<string, string | number> = { key: i };
        row.forEach((cell, j) => {
          item[`c${j}`] = cell;
        });
        return item;
      }),
    };
  }, [result]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setLastQ(q);
    setQuestion('');
    try {
      const payload = await apiRequest<AskResult>('/api/ai/factory/ask', {
        method: 'POST',
        csrfToken: session.csrf_token,
        body: { question: q },
      });
      setResult(payload);
    } catch (failure) {
      if (String(failure).includes('401') || (failure as { status?: number }).status === 401) onExpired();
      const status = (failure as { status?: number }).status;
      if (status === 403) {
        message.error(errorMessage(failure) || '当前角色没有权限查看该数据');
        setResult({
          answer: errorMessage(failure) || '当前角色没有权限查看该数据',
          intent: 'forbidden',
        });
      } else {
        message.error(errorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kgd-card sedric-factory" data-testid="sedric-factory-page">
      <div className="sedric-factory-head">
        <h2><FundProjectionScreenOutlined /> 工厂助理 · 只读问数</h2>
        <Space>
          <Button onClick={() => navigate('/ai/center')}>返回 AI 中心</Button>
          <Button icon={<RobotOutlined />} onClick={() => openSedricAssistant()}>打开小助手</Button>
        </Space>
      </div>
      <p className="sedric-factory-lead">
        用自然语言查询<strong>进度 / 应收应付 / 工资</strong>汇总。永不写单据；产品用法请用右下角小助手。
      </p>

      <div className="sedric-factory-suggest" data-testid="sedric-factory-suggest">
        {SUGGESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            className="sedric-ai-chip"
            data-testid="sedric-factory-chip"
            disabled={busy}
            onClick={() => void ask(q)}
          >
            {q}
          </button>
        ))}
      </div>

      <div className="sedric-factory-ask">
        <Input.TextArea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例如：应收还有多少未收"
          autoSize={{ minRows: 2, maxRows: 4 }}
          maxLength={500}
          data-testid="sedric-factory-input"
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              void ask(question);
            }
          }}
        />
        <Button
          type="primary"
          loading={busy}
          disabled={!question.trim()}
          data-testid="sedric-factory-send"
          onClick={() => void ask(question)}
        >
          提问
        </Button>
      </div>

      <div className="sedric-factory-result" data-testid="sedric-factory-result">
        {!result && <div className="muted">提问后，这里显示中文回答与汇总卡片/表格。</div>}
        {result && (
          <>
            {lastQ && <div className="sedric-factory-q">问：{lastQ}</div>}
            <div className="sedric-factory-a" data-testid="sedric-factory-answer">{result.answer}</div>
            {result.intent && <Tag color="blue">意图：{result.intent}</Tag>}
            {!!result.cards?.length && (
              <div className="sedric-factory-cards">
                {result.cards.map((card) => (
                  <Card key={card.title} size="small" title={card.title} className="sedric-factory-card">
                    <div className="value">{card.value}</div>
                    {card.hint && <div className="hint">{card.hint}</div>}
                  </Card>
                ))}
              </div>
            )}
            {tableData && (
              <Table
                size="small"
                pagination={false}
                columns={tableData.columns}
                dataSource={tableData.dataSource}
                style={{ marginTop: 12 }}
              />
            )}
            {!!result.citations?.length && (
              <div className="muted" style={{ marginTop: 8 }}>
                数据来源：{result.citations.map((c) => c.title).join('、')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
