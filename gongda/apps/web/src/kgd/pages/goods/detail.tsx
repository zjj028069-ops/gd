import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Empty, Switch, Table, Tabs, Tag } from 'antd';
import type { Product } from '../../../api';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { formatDate } from '../../../shared';
import { useKgd } from '../../context';
import { showError, useCommand } from '../../kit';
import { qtyText } from '../../qty';
import { downloadBlob } from '../../xlsx';
import { BomStructureModal } from '../catalogGoods';
import { lineAmount, sumMoney } from '../money/math';
import { GoodsEditor } from './editor';
import { AttachmentImage, qrBlob } from './shared';

const sourceText: Record<string, string> = { adjustment: '其他入出库', material_issue: '生产出库', supplement_issue: '补投出库', fg_receipt: '成品入库', shipment: '销售出库', purchase_receipt: '采购入库', transfer_out: '调拨出', transfer_in: '调拨入', stock_count: '盘点' };

type GoodsBom = {
  id: string;
  parent_product_id: string;
  parent_code: string;
  parent_name: string;
  active: boolean;
  current_version_id: string;
  version: number;
  code?: string | null;
  name?: string | null;
  category?: string | null;
  is_default?: boolean;
  note?: string | null;
  creator_name?: string | null;
  created_at?: string | null;
};

function BomCostTotal({ versionId }: { versionId: string }) {
  const { revision, onExpired } = useKgd();
  const remote = useRemote<{ items: { quantity: string; cost_price: string | null }[] }>(versionId ? `/api/bom-versions/${versionId}` : null, revision, onExpired);
  if (!remote.data) return <span />;
  const total = sumMoney((remote.data.items ?? []).map((item) => {
    try { return lineAmount(`${item.cost_price?.trim() || '0'}*${item.quantity}`, '0', '0', 6); } catch { return '0'; }
  }));
  return <span>{total}</span>;
}
const processColumns = ['工序', '工序编号', '车间', '产线', '计价方式', '工资单价', '生产人员', '质检人员', '不良品项', '单位', '单位关系', '标准工时', '机台', '生产任务计时', '检验方案', '需返工/报废', '需外协', '物料清单', '附件', '报工附加组件', '质检附加组件', '备注'];
const ledgerColumns = ['流水编号', '出入库单号', '商品', '商品编号', '规格', '类别', '库存类型', '单据类型', '数量', '结余', '成本单价(元)', '成本金额(元)', '销售单价(元)', '销售金额(元)', '单位', '入库仓库', '出库仓库', '操作人', '备注', '操作时间'];

export function GoodsDetail() {
  const { pathname } = useLocation();
  const id = pathname.match(/\/goods\/detail\/([^/]+)/)?.[1] ?? '';
  const navigate = useNavigate();
  const { session, revision, onExpired } = useKgd();
  const command = useCommand();
  const remote = useRemote<{ product: Product }>(id ? `/api/products/${id}` : null, revision, onExpired);
  const boms = useRemote<{ items: GoodsBom[] }>('/api/boms', revision, onExpired);
  const product = remote.data?.product;
  const productBoms = (boms.data?.items ?? []).filter((item) => item.parent_product_id === id);
  const bom = productBoms.find((item) => item.is_default) ?? productBoms[0];
  const version = useRemote<{ version: { route_version_id: string | null; description: string; created_at: string } }>(bom ? `/api/bom-versions/${bom.current_version_id}` : null, revision, onExpired);
  const route = useRemote<{ steps: { process_code: string; process_name: string; standard_minutes: string }[] }>(version.data?.version.route_version_id ? `/api/route-versions/${version.data.version.route_version_id}` : null, revision, onExpired);
  const ledger = useRemote<{ items: { id: string; warehouse_id: string; product_id: string; direction: 'in' | 'out'; quantity: string; source_type: string; source_id: string; posted_at: string }[] }>('/api/stock/ledger', revision, onExpired);
  const warehouses = useRemote<{ items: { id: string; name: string }[] }>('/api/warehouses', revision, onExpired);
  const docs = useRemote<{ items: { id: string; code: string }[] }>('/api/stock-adjustments', revision, onExpired);
  const [editing, setEditing] = useState(false);
  const [qrUrl, setQrUrl] = useState('');
  const [preview, setPreview] = useState<GoodsBom | null>(null);
  useEffect(() => {
    if (!product) return;
    let alive = true;
    void qrBlob(`${location.origin}/goods/detail/${product.id}`, [product.name, session.tenant.name]).then((blob) => { if (alive) setQrUrl(URL.createObjectURL(blob)); });
    return () => { alive = false; };
  }, [product, session.tenant.name]);
  if (!product) return <div className="kgd-card">{remote.error || '正在读取数据…'}</div>;
  const warehouse = (warehouseId: string) => warehouses.data?.items.find((item) => item.id === warehouseId)?.name ?? '';
  const flows = (ledger.data?.items ?? []).filter((item) => item.product_id === id);
  const kv: [string, ReactNode][] = [
    ['商品图片', product.images?.[0] ? <AttachmentImage id={product.images[0]} size={72} /> : ''],
    ['类别', product.category_name ?? ''],
    ['单位', product.unit_name ?? ''],
    ['销售单价', product.sale_price ?? ''],
    ['成本单价', product.cost_price ?? ''],
    ['外协单价', product.outsource_price || '无'],
    ['状态', <Switch checked={product.active} checkedChildren="启用" unCheckedChildren="禁用" onChange={(active) => void command.send(`/api/products/${product.id}`, { version: product.version, name: product.name, active }, 'PATCH').catch((failure) => command.setError(showError(failure)))} />],
    ['来源', product.source ? <Tag color="orange">{product.source}</Tag> : ''],
    ['商品二维码', qrUrl ? <span><img alt="商品二维码" src={qrUrl} width={96} /><Button type="link" onClick={() => void fetch(qrUrl).then((response) => response.blob()).then((blob) => downloadBlob(`${product.code}.png`, blob))}>下载</Button></span> : ''],
    ['规格', product.specification ?? ''],
    ['检验规范', product.inspection_spec_name ?? ''],
    ['供应商', product.supplier_name ?? ''],
    ['备注', product.remark ?? ''],
    ['附件', (product.attachments ?? []).length ? String(product.attachments?.length) : ''],
    ['呆滞警告值', product.stale_days ?? ''],
    ['库存上限警告值', product.stock_upper_warn ?? ''],
    ['库存下限警告值', product.stock_lower_warn ?? ''],
    ['创建人', product.creator_name ?? ''],
    ['创建时间', formatDate(product.created_at)],
  ];
  return <div className="kgd-card">
    <div className="kgd-actions no-print">
      <Button onClick={() => navigate('/goods/list')}>返回</Button>
      <Button type="primary" onClick={() => setEditing(true)}>修改</Button>
      <Button danger onClick={() => void command.send(`/api/products/${product.id}`, {}, 'DELETE').then(() => navigate('/goods/list')).catch((failure) => command.setError(showError(failure)))}>删除</Button>
    </div>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <h2 style={{ marginTop: 0 }}>{product.name}({product.code})</h2>
    <div className="goods-detail">
      <div>
        <div className="goods-kv">{kv.map(([label, value]) => <span key={label} style={{ display: 'contents' }}><b>{label}</b><span>{value}</span></span>)}</div>
        <div className="kgd-card" style={{ marginTop: 12, minHeight: 0 }}><h3>商品简介</h3>{product.intro_html ? <div dangerouslySetInnerHTML={{ __html: product.intro_html }} /> : <Empty description="暂无数据" />}</div>
      </div>
      <Tabs items={[
        { key: 'bom', label: '商品BOM', children: <>
          <div className="kgd-toolbar"><Button type="primary" onClick={() => navigate(`/bom/add?product=${id}`)}>新建BOM</Button></div>
          <Table<GoodsBom> size="small" rowKey="id" pagination={{ pageSize: 30, showTotal: (count) => `共${count}条数据` }} locale={{ emptyText: '暂无数据' }} dataSource={productBoms} columns={[
            { title: 'BOM编号', dataIndex: 'code', render: (value) => value || '' },
            { title: 'BOM名称', render: (_, row) => <span>{row.name || row.parent_name} {row.is_default ? <Tag color="green">默认</Tag> : null}</span> },
            { title: '成本总额(元)', render: (_, row) => <BomCostTotal versionId={row.current_version_id} /> },
            { title: '商品编号', dataIndex: 'parent_code' },
            { title: '商品', dataIndex: 'parent_name' },
            { title: '规格', render: () => product.specification ?? '' },
            { title: '类别', dataIndex: 'category', render: (value) => value || '' },
            { title: '结构预览', render: (_, row) => <Button type="link" onClick={() => setPreview(row)}>预览</Button> },
            { title: '启用/禁用', render: (_, row) => row.active === false ? '禁用' : '启用' },
            { title: '创建人', dataIndex: 'creator_name', render: (value) => value || '' },
            { title: '备注', dataIndex: 'note', render: (value) => value || '' },
            { title: '创建时间', dataIndex: 'created_at', render: (value) => value || '' },
            { title: '操作', render: (_, row) => <><Button type="link" onClick={() => navigate(`/bom/edit/${row.id}`)}>修改</Button><Button type="link" onClick={() => navigate(`/bom/add?copy=${row.id}`)}>复制</Button><Button type="link" danger onClick={() => void apiRequest(`/api/boms/${row.id}`, { method: 'DELETE', csrfToken: session.csrf_token, body: { version: row.version } }).catch((failure) => command.setError(showError(failure)))}>删除</Button></> },
          ]} />
          <BomStructureModal bom={preview} onClose={() => setPreview(null)} />
        </> },
        { key: 'route', label: '工序列表', children: <Table size="small" rowKey="process_code" pagination={{ pageSize: 30, showTotal: (count) => `共${count}条数据` }} locale={{ emptyText: '暂无数据' }} dataSource={route.data?.steps ?? []} columns={processColumns.map((title) => ({ title, render: (_: unknown, row: { process_name: string; process_code: string; standard_minutes: string }) => title === '工序' ? row.process_name : title === '工序编号' ? row.process_code : title === '标准工时' ? row.standard_minutes : '' }))} /> },
        { key: 'ledger', label: '出入库流水', children: <Table size="small" rowKey="id" scroll={{ x: 'max-content' }} pagination={{ pageSize: 30, showTotal: (count) => `共${count}条数据` }} locale={{ emptyText: '暂无数据' }} dataSource={flows} columns={ledgerColumns.map((title) => ({ title, render: (_: unknown, row: typeof flows[number]) => {
          if (title === '流水编号') return row.id.slice(0, 8);
          if (title === '出入库单号') return docs.data?.items.find((item) => item.id === row.source_id)?.code ?? '';
          if (title === '商品') return product.name;
          if (title === '商品编号') return product.code;
          if (title === '规格') return product.specification ?? '';
          if (title === '类别') return product.category_name ?? '';
          if (title === '库存类型') return row.direction === 'out' ? '出库' : '入库';
          if (title === '单据类型') return sourceText[row.source_type] ?? row.source_type;
          if (title === '数量') return `${row.direction === 'out' ? '-' : ''}${qtyText(row.quantity)}`;
          if (title === '单位') return product.unit_name ?? '';
          if (title === '入库仓库') return row.direction === 'in' ? warehouse(row.warehouse_id) : '';
          if (title === '出库仓库') return row.direction === 'out' ? warehouse(row.warehouse_id) : '';
          if (title === '操作时间') return formatDate(row.posted_at);
          return '';
        } }))} /> },
        { key: 'inspect', label: '检验规范', children: <Table size="small" rowKey="name" pagination={false} locale={{ emptyText: '暂无数据' }} dataSource={product.inspection_spec_name ? [{ name: product.inspection_spec_name }] : []} columns={[{ title: '检验规范', dataIndex: 'name' }, { title: '检查项', render: () => '' }, { title: '备注', render: () => '' }, { title: '操作', render: () => '' }]} /> },
      ]} />
    </div>
    {editing && <GoodsEditor product={product} onClose={() => setEditing(false)} />}
  </div>;
}
