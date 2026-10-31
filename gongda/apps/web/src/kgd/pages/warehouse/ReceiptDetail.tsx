import { useNavigate } from 'react-router-dom';
import { Button, Table } from 'antd';
import { useRemote } from '../../../masterTools';
import { useWarehouseApi, type WhRec } from './useWarehouseApi';

export function PurchaseReceiptDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const api = useWarehouseApi();
  const remote = useRemote<WhRec>(id ? `/api/warehouse/purchase-receipts/${id}` : null, api.revision, api.onExpired);
  const row = remote.data;
  if (!row?.id) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : remote.error || '暂无数据'}</div>;
  const lines = (row.lines as WhRec[] | undefined) ?? [];
  return <div className="kgd-card">
    <div className="kgd-toolbar"><Button onClick={() => navigate(-1)}>返回</Button></div>
    <h3>采购入库单({String(row.code ?? '')})</h3>
    <dl className="kgd-detail-grid">
      {[['采购入库单号', row.code], ['采购单号', row.order_code], ['入库日期', row.receipt_date], ['审核状态', row.audit_status], ['仓库', row.warehouse_name || row.warehouse_id], ['备注', row.note]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{String(value ?? '')}</dd></div>)}
    </dl>
    <Table size="small" rowKey="id" pagination={false} dataSource={lines} locale={{ emptyText: '暂无数据' }} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '数量', dataIndex: 'quantity' },
      { title: '单价', dataIndex: 'unit_price' },
    ]} />
  </div>;
}

export function FgReceiptDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const api = useWarehouseApi();
  const remote = useRemote<WhRec>(id ? `/api/warehouse/fg-receipts/${id}` : null, api.revision, api.onExpired);
  const row = remote.data;
  if (!row?.id) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : remote.error || '暂无数据'}</div>;
  const approvalText: Record<string, string> = { pending: '待审核', approved: '已审核', rejected: '已驳回', reversed: '已冲销', exempt: '不需审核' };
  const status = String(row.audit_status ?? row.approval ?? '');
  return <div className="kgd-card">
    <div className="kgd-toolbar"><Button onClick={() => navigate('/produce_stock_in_bill/list')}>返回</Button></div>
    <h3>成品入库单({String(row.code ?? '')})</h3>
    <dl className="kgd-detail-grid">
      {[
        ['入库单号', row.code],
        ['加工单号', row.work_order_code],
        ['入库仓库', row.warehouse_name || row.warehouse_id],
        ['商品', row.product_name],
        ['入库数量', row.quantity],
        ['审核状态', approvalText[status] ?? status],
        ['入库日期', String(row.created_at ?? '').slice(0, 10)],
        ['创建时间', row.created_at],
      ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{String(value ?? '')}</dd></div>)}
    </dl>
    <Table size="small" rowKey="id" pagination={false} dataSource={[{ id: row.id, product_name: row.product_name, quantity: row.quantity }]} locale={{ emptyText: '暂无数据' }} columns={[
      { title: '商品名称', dataIndex: 'product_name' },
      { title: '入库数量', dataIndex: 'quantity' },
    ]} />
  </div>;
}

