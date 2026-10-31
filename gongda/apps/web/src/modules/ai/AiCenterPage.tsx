import { Button, Card, Col, Row } from 'antd';
import { AppstoreAddOutlined, BookOutlined, FileImageOutlined, FundProjectionScreenOutlined, RobotOutlined, TableOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { openSedricAssistant } from './AiShell';
import './ai.css';

export function AiCenterPage() {
  const navigate = useNavigate();
  return (
    <div className="kgd-card sedric-ai-center" data-testid="sedric-ai-center">
      <h2><RobotOutlined /> AI 中心</h2>
      <p>
        赛德瑞克 AI 能力入口（S0 可信执行底座）：客服答用法，工厂助理只读查数；BOM / 极速下单 / 图纸拆单 /
        名片联系人、本厂词典和一句话扩展统一走 <code>preview → /api/ai/writes/confirm|cancel</code>，确认前不写库，成败均记审计。
      </p>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card
            className="sedric-ai-entry-card"
            data-testid="sedric-ai-card-assistant"
            title={<span><RobotOutlined /> 赛德瑞克小助手</span>}
          >
            <ul>
              <li>全站右下角浮标，解答报工、销售订单、加工单等<strong>产品用法</strong>。</li>
              <li>支持快速/深度模式、推荐问题与历史会话。</li>
              <li><strong>不查</strong>真实工单数字，也<strong>不写</strong>业务单据。</li>
            </ul>
            <div className="actions">
              <Button type="primary" icon={<RobotOutlined />} onClick={() => openSedricAssistant()}>
                打开小助手
              </Button>
              <Button onClick={() => navigate('/digitalEmployees/manager/setting')}>前往训练中心</Button>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            className="sedric-ai-entry-card"
            data-testid="sedric-ai-card-factory"
            title={<span><FundProjectionScreenOutlined /> 工厂助理</span>}
          >
            <ul>
              <li>自然语言<strong>只读</strong>查 MES 汇总：进度、应收应付、工资。</li>
              <li>对标黑湖工厂助理；对齐老板三本账。</li>
              <li><strong>永不写单据</strong>；无权限返回中文说明且不泄漏数字。</li>
            </ul>
            <div className="actions">
              <Button
                type="primary"
                icon={<FundProjectionScreenOutlined />}
                data-testid="sedric-ai-open-factory"
                onClick={() => navigate('/ai/factory')}
              >
                打开工厂助理
              </Button>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            className="sedric-ai-entry-card"
            data-testid="sedric-ai-card-bom"
            title={<span><TableOutlined /> AI 导入 BOM</span>}
          >
            <ul>
              <li>上传 Excel/CSV，预览解析行后再写入物料清单。</li>
              <li>可调整列映射；确认前<strong>不写</strong>业务表，可随时取消。</li>
              <li>对标黑湖物料清单「AI 导入」。</li>
            </ul>
            <div className="actions">
              <Button
                type="primary"
                icon={<TableOutlined />}
                data-testid="sedric-ai-open-bom"
                onClick={() => navigate('/ai/bom')}
              >
                打开 AI 导入 BOM
              </Button>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            className="sedric-ai-entry-card"
            data-testid="sedric-ai-card-quick-order"
            title={<span><ThunderboltOutlined /> 极速下单</span>}
          >
            <ul>
              <li>上传单据图/PDF/Excel，列映射或手录后预览。</li>
              <li>确认生成<strong>加工单</strong>或<strong>销售单</strong>（默认加工单）；须二次确认。</li>
              <li>对标黑湖 <code>/dataflow</code>；本地次数计数。</li>
            </ul>
            <div className="actions">
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                data-testid="sedric-ai-open-quick-order"
                onClick={() => navigate('/ai/quick-order')}
              >
                打开极速下单
              </Button>
            </div>
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card
            className="sedric-ai-entry-card"
            data-testid="sedric-ai-card-drawing"
            title={<span><FileImageOutlined /> 图纸拆单</span>}
          >
            <ul>
              <li>上传 PDF/图片，识别<strong>工序草案</strong>后人工确认。</li>
              <li>可仅建工艺路线草案，或关联已有工单；<strong>同步写工单须二次确认</strong>。</li>
              <li>对标黑湖工艺智能体；确认前<strong>不写</strong>业务表。</li>
            </ul>
            <div className="actions">
              <Button
                type="primary"
                icon={<FileImageOutlined />}
                data-testid="sedric-ai-open-drawing"
                onClick={() => navigate('/ai/drawing-split')}
              >
                打开图纸拆单
              </Button>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            className="sedric-ai-entry-card"
            data-testid="sedric-ai-card-glossary"
            title={<span><BookOutlined /> 本厂词典</span>}
          >
            <ul>
              <li>记下本厂叫法、默认规则和纠错，例如「大板」对应某物料。</li>
              <li>聊天或本页都先出确认卡，取消不写库。</li>
              <li>只保存已有物料/客户 ID，不重建主数据。落单时会替换别名。</li>
            </ul>
            <div className="actions">
              <Button type="primary" icon={<BookOutlined />} data-testid="sedric-ai-open-glossary" onClick={() => navigate('/ai/glossary')}>
                打开本厂词典
              </Button>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            className="sedric-ai-entry-card"
            data-testid="sedric-ai-card-ext"
            title={<span><AppstoreAddOutlined /> 一句话扩展</span>}
          >
            <ul>
              <li>例如「给加工单加一个紧急度字段并进菜单」。</li>
              <li>先出方案预览，确认后写入系统内配置，可启用、停用、回退。</li>
              <li>不生成独立站点，字段挂在已有加工单上。</li>
            </ul>
            <div className="actions">
              <Button type="primary" icon={<AppstoreAddOutlined />} data-testid="sedric-ai-open-ext" onClick={() => navigate('/ai/ext-apps')}>
                打开扩展应用
              </Button>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
