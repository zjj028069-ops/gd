import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Progress, Result, Spin } from 'antd';
import { apiRequest } from '../../../../api';

type SharedProcess = { name: string; execution_text: string; progress: string };
type SharedOrder = {
  code: string; execution_text: string; product_name: string; product_code: string; specification: string; category_name: string;
  product_image: string | { url?: string; content_url?: string } | null; plan_qty: string; progress: string; processes: SharedProcess[];
};

function percentOf(label: string) {
  const match = label.match(/^(-?[\d.]+)%/);
  return match ? Math.max(0, Math.min(100, Math.floor(Number(match[1])))) : 0;
}

function imageUrl(image: SharedOrder['product_image']) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  return image.url ?? image.content_url ?? '';
}

export function ShareWorkOrderPage() {
  const { token = '' } = useParams();
  const [order, setOrder] = useState<SharedOrder | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!/^[A-Za-z0-9]{32}$/.test(token)) { setFailed(true); return; }
    apiRequest<{ work_order: SharedOrder }>(`/api/public/share/wo/${token}`).then((result) => { if (alive) setOrder(result.work_order); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [token]);
  if (failed) return <Result status="warning" title="链接已失效" subTitle="该分享链接不存在、已撤销或已过期，请联系分享人重新分享。" />;
  if (!order) return <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}><Spin /></div>;
  const image = imageUrl(order.product_image);
  const rows: [string, string][] = [
    ['加工单号', order.code], ['生产状态', order.execution_text], ['商品名称', order.product_name], ['商品编号', order.product_code],
    ['商品规格', order.specification], ['商品类别', order.category_name], ['计划数', order.plan_qty],
  ];
  const card = { background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 16 };
  return <div style={{ maxWidth: 640, margin: '0 auto', padding: 16, fontSize: 14 }}>
    <h2 style={{ textAlign: 'center' }}>加工单生产进度</h2>
    {image && <img src={image} alt={order.product_name} style={{ display: 'block', maxWidth: '100%', maxHeight: 240, margin: '0 auto 12px' }} />}
    <div style={card}>
      {rows.map(([label, value]) => <div key={label} style={{ display: 'flex', padding: '6px 0', borderBottom: '1px dashed #f0f0f0' }}><span style={{ width: 96, color: '#888' }}>{label}</span><span style={{ flex: 1 }}>{value || '-'}</span></div>)}
      <div style={{ padding: '10px 0' }}><span style={{ color: '#888' }}>生产进度</span><Progress percent={percentOf(order.progress)} format={() => order.progress} strokeColor="#4184F4" /></div>
    </div>
    <div style={{ ...card, marginTop: 12 }}>
      <b>工序进度</b>
      {order.processes.map((task, index) => <div key={`${task.name}-${index}`} style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{index + 1}. {task.name}</span><span style={{ color: '#888' }}>{task.execution_text}</span></div>
        <Progress percent={percentOf(task.progress)} format={() => task.progress} size="small" strokeColor="#4184F4" />
      </div>)}
      {!order.processes.length && <p style={{ color: '#888' }}>暂无工序</p>}
    </div>
  </div>;
}
