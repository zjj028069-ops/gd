import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Modal, Table } from 'antd';
import { useRemote } from '../../../../masterTools';
import { ProgressCell } from '../shared';
import { PurchaseReceiptModal, PurchaseReturnModal, ShipmentModal } from '../BillForms';
import { useWarehouseApi } from '../useWarehouseApi';
import type { WhRec } from '../useWarehouseApi';

export function PurchaseInboundLink({ orderId, count }: { orderId: string; count?: number }) {
  const [open, setOpen] = useState(false);
  const label = `入库(${count ?? 0})`;
  return <>
    <button type="button" className="kgd-link" onClick={() => setOpen(true)}>{label}</button>
    {open && <PurchaseInboundDialog orderId={orderId} onClose={() => setOpen(false)} />}
  </>;
}

export function PurchaseReturnLink({ orderId, count }: { orderId: string; count?: number }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="kgd-link" onClick={() => setOpen(true)}>退货({count ?? 0})</button>
    {open && <PurchaseReturnDialog orderId={orderId} onClose={() => setOpen(false)} />}
  </>;
}

export function ContractOutboundLink({ contractId, count }: { contractId: string; count?: number }) {
  const [open, setOpen] = useState(false);
  const text = count ? `出库 (${count})` : '出库 (0)';
  return <>
    <button type="button" className="kgd-link" onClick={() => setOpen(true)}>{text}</button>
    {open && <ContractOutboundDialog contractId={contractId} onClose={() => setOpen(false)} />}
  </>;
}

export function PurchaseInboundDialog({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const api = useWarehouseApi();
  const navigate = useNavigate();
  const summary = useRemote<WhRec>(`/api/warehouse/purchase-orders/${orderId}/stock-summary`, api.revision, api.onExpired);
  const [create, setCreate] = useState(false);
  const lines = (summary.data?.lines as WhRec[] | undefined) ?? [];
  return <>
    <Modal title="采购入库" open width={860} onCancel={onClose} footer={null}>
      <div className="kgd-toolbar">
        <Button type="primary" onClick={() => setCreate(true)}>+ 新增入库</Button>
        <Button onClick={() => { navigate(`/purchase_stock_in_bill/list?order_id=${orderId}`); onClose(); }}>查看入库单</Button>
      </div>
      <Table size="small" rowKey="purchase_line_id" pagination={false} dataSource={lines} columns={[
        { title: '商品名称', dataIndex: 'product_name' },
        { title: '商品编号', render: () => '' },
        { title: '规格', render: () => '' },
        { title: '商品图片', render: () => '' },
        { title: '单位', render: () => '' },
        { title: '入库进度', render: (_, row) => <ProgressCell progress={String(row.progress ?? '')} /> },
      ]} />
    </Modal>
    {create && <PurchaseReceiptModal orderId={orderId} onClose={() => { setCreate(false); onClose(); }} />}
  </>;
}

export function PurchaseReturnDialog({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const api = useWarehouseApi();
  const order = useRemote<WhRec>(`/api/money/purchase-orders/${orderId}`, api.revision, api.onExpired);
  const purchase = order.data?.purchase_order as WhRec | undefined;
  const [create, setCreate] = useState(false);
  const receipts = useRemote<{ items: WhRec[] }>(`/api/warehouse/purchase-returns?order_id=${orderId}`, api.revision, api.onExpired);
  return <>
    <Modal title="采购退货" open width={960} onCancel={onClose} footer={null}>
      <div className="kgd-toolbar"><Button type="primary" onClick={() => setCreate(true)}>+ 新增退货</Button></div>
      <Table size="small" rowKey="id" pagination={false} dataSource={receipts.data?.items ?? []} locale={{ emptyText: '暂无数据' }} columns={[
        { title: '采购退货单号', dataIndex: 'code' },
        { title: '供应商', render: () => purchase?.supplier_name },
        { title: '仓库', render: (_, row) => String(row.warehouse_name ?? '') },
        { title: '退货日期', dataIndex: 'return_date' },
        { title: '审核状态', dataIndex: 'audit_status' },
      ]} />
    </Modal>
    {create && purchase && <PurchaseReturnModal orderId={orderId} orderLabel={`${purchase.code}/${purchase.supplier_name}`} supplierName={String(purchase.supplier_name ?? '')} onClose={() => { setCreate(false); onClose(); }} />}
  </>;
}

export function ContractOutboundDialog({ contractId, onClose }: { contractId: string; onClose: () => void }) {
  const api = useWarehouseApi();
  const navigate = useNavigate();
  const summary = useRemote<WhRec>(`/api/warehouse/contracts/${contractId}/outbound-summary`, api.revision, api.onExpired);
  const contract = useRemote<WhRec>(`/api/money/contracts/${contractId}`, api.revision, api.onExpired);
  const head = contract.data?.contract as WhRec | undefined;
  const [create, setCreate] = useState(false);
  const lines = (summary.data?.lines as WhRec[] | undefined) ?? [];
  return <>
    <Modal title="销售出库" open width={860} onCancel={onClose} footer={null}>
      <div className="kgd-toolbar">
        <Button type="primary" onClick={() => setCreate(true)}>+ 出库</Button>
        <Button onClick={() => { navigate(`/sale_stock_out_bill/list?contract_id=${contractId}`); onClose(); }}>查看出库单</Button>
      </div>
      <Table size="small" rowKey="contract_line_id" pagination={false} dataSource={lines} columns={[
        { title: '商品名', dataIndex: 'product_name' },
        { title: '商品编号', render: () => '' },
        { title: '规格', render: () => '' },
        { title: '商品图片', render: () => '' },
        { title: '单位', render: () => '' },
        { title: '出库进度', render: (_, row) => <ProgressCell progress={String(row.progress ?? '')} complete={!!row.complete} /> },
      ]} />
    </Modal>
    {create && head && <ShipmentModal contractId={contractId} seed={{ contract_id: contractId, customer_id: head.customer_id, contact_name: head.contact_name, contact_phone: head.contact_phone, address: head.address }} onClose={() => { setCreate(false); onClose(); }} />}
  </>;
}
