import { useEffect, useState } from 'react';
import { ApiError, apiRequest, errorMessage, isAbort } from './api';
import type { OverviewData, Session } from './api';
import { Loading, Notice } from './shared';

export function Overview({ session, revision, onExpired }: { session: Session; revision: number; onExpired: () => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [readAt, setReadAt] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setData(null);
    apiRequest<OverviewData>('/api/overview', { signal: controller.signal })
      .then((result) => {
        if (typeof result.products !== 'number' || typeof result.units !== 'number') {
          throw new Error('概览数据格式无法识别。');
        }
        setData(result);
        setReadAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      })
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        if (failure instanceof ApiError && failure.status === 401) onExpired();
        else setError(errorMessage(failure));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, refresh, onExpired]);

  return <>
    <div className="page-heading"><div><div className="eyebrow">工作空间 / 概览</div><h1>企业概览</h1><p>查看当前企业的基础档案和审计记录。</p></div><button className="button button-secondary" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>刷新数据</button></div>
    {error && <Notice>{error}</Notice>}
    {loading ? <Loading /> : data && <>
      <div className="metric-grid">
        <Metric label="产品档案" value={data.products.toLocaleString('zh-CN')} detail="当前企业产品总数" icon="▣" />
        <Metric label="计量单位" value={data.units.toLocaleString('zh-CN')} detail="企业单位档案总数（含停用）" icon="◈" />
        <Metric label="操作审计" value={data.audit_events === null ? '受权限限制' : data.audit_events.toLocaleString('zh-CN')} detail={data.audit_events === null ? '当前授权范围不读取审计记录' : '服务返回的审计记录总数'} icon="≡" />
        <Metric label="加工单" value={data.work_orders === null ? '受权限限制' : data.work_orders.toLocaleString('zh-CN')} detail={data.work_orders === null ? '当前授权范围不读取加工单' : '当前企业加工单总数'} icon="▤" />
        <Metric label="交付阶段" value={data.stage === 'production_mainline' ? '生产主线' : ['foundation', 'master_data', 'platform', 'saas_configuration'].includes(data.stage) ? 'SaaS与企业配置' : String(data.stage)} detail="生产主线 · 费用报表 · 调拨盘点" icon="◇" />
      </div>
      <div className="overview-grid">
        <section className="panel"><div className="panel-heading"><h2>当前企业</h2><span className="badge badge-green">已登录</span></div><dl className="detail-list"><div><dt>企业名称</dt><dd>{session.tenant.name}</dd></div><div><dt>企业标识</dt><dd className="monospace">{session.tenant.slug}</dd></div><div><dt>当前账号</dt><dd>{session.user.display_name}</dd></div><div><dt>数据读取时间</dt><dd>{readAt}</dd></div></dl></section>
        <section className="panel"><div className="panel-heading"><h2>本阶段范围</h2><span className="badge badge-teal">阶段五 · 生产主线</span></div><p className="panel-copy">销售、采购收货、来料检验、加工报工和库存已接入真实单据。审核后计入数量、工资、工单成本和应收应付；金额来源缺失时显示未计价。</p><div className="scope-list"><span>销售订单</span><span>冻结路线与 BOM</span><span>报工与库存</span><span>分批发货</span><span>采购与检验</span><span>工资成本与收付款</span></div><p className="muted small">费用分摊、期间报表、两段仓间调拨和盘点差异确认已加入实际操作。退料退货、检验规范、人员协作、委外、批次追溯和高级排程继续推进。</p></section>
      </div>
    </>}
  </>;
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: string }) {
  return <section className="metric-card"><div className="metric-label">{label}<span className="metric-icon" aria-hidden="true">{icon}</span></div><div className={`metric-value ${value.length > 5 ? 'metric-value-text' : ''}`}>{value}</div><p>{detail}</p></section>;
}

