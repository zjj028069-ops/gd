import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, Input, Modal, Select, TreeSelect } from 'antd';
import type { MenuProps } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { apiRequest, hasPermission } from '../../../api';
import type { Product } from '../../../api';
import { useRemote } from '../../../masterTools';
import { formatDate } from '../../../shared';
import { useKgd } from '../../context';
import { ExtensionAddDialog } from '../../dialogs';
import { ListFrame } from '../../ListFrame';
import type { ListColumn } from '../../ListFrame';
import { showError, StatusTag, useCommand, useQueryState } from '../../kit';
import { sumQty } from '../../qty';
import type { ColumnPrefs } from '../../storage';
import { downloadBlob, downloadWorkbook, readWorkbook } from '../../xlsx';
import { GoodsEditor } from './editor';
import type { PrintDoc } from '../../print';
import { PrintPickModal } from '../../print/templates';
import { AttachmentImage, allowedMime, buildTree, ensureGoodsCatalog, fileBase64, qrBlob, sourceOptions, todayText } from './shared';
import type { Category, CategoryNode, GoodsView } from './shared';
import { requestKey } from '../../../requestKey';

type Balance = { product_id: string; on_hand: string; available_qty: string };
type Schema = { id: string; version: number; entity: string };
type Field = { key: string; label: string; type: string; required: boolean; options?: string[]; read_roles: string[]; write_roles: string[] };

const goodsColumns = ['code', 'name', 'category', 'available', 'onHand', 'spec', 'inspect', 'image', 'unit', 'sale', 'cost', 'outsourcePrice', 'commission', 'commissionRate', 'source', 'bom', 'flow', 'supplier', 'files', 'note', 'status', 'stale', 'max', 'min', 'creator', 'created', 'actions'];
const exportHeads = ['商品编号', '商品名', '类别', '规格', '单位', '销售单价', '成本单价', '外协单价', '售后佣金(元)', '售后佣金比例', '商品来源', '供应商', '备注', '状态', '呆滞警告值', '库存上限警告值', '库存下限警告值', '创建人', '创建时间'];

function treeData(nodes: CategoryNode[]): { value: string; title: string; children?: ReturnType<typeof treeData> }[] {
  return nodes.map((node) => ({ value: node.id, title: node.name, children: node.children.length ? treeData(node.children) : undefined }));
}
function cells(row: Product) {
  return [row.code, row.name, row.category_name ?? '', row.specification ?? '', row.unit_name ?? '', row.sale_price ?? '', row.cost_price ?? '', row.outsource_price ?? '', row.commission_amount ?? '', row.commission_rate ?? '', row.source ?? '', row.supplier_name ?? '', row.remark ?? '', row.active ? '启用' : '禁用', row.stale_days ?? '', row.stock_upper_warn ?? '', row.stock_lower_warn ?? '', row.creator_name ?? '', formatDate(row.created_at)];
}

export function GoodsList() {
  const navigate = useNavigate();
  const { session, revision, onExpired, onChanged } = useKgd();
  const command = useCommand();
  const list = useQueryState();
  const [view, setView] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Product | null | undefined>(() => new URLSearchParams(window.location.search).get('add') === '1' ? null : undefined);
  const [copying, setCopying] = useState(false);
  const [addField, setAddField] = useState(false);
  const [qr, setQr] = useState<Product | null>(null);
  const [qrFlags, setQrFlags] = useState({ name: true, company: true, spec: false });
  const [qrUrl, setQrUrl] = useState('');
  const [batchEdit, setBatchEdit] = useState(false);
  const [batchSource, setBatchSource] = useState('');
  const [batchCategory, setBatchCategory] = useState('');
  const [viewAdmin, setViewAdmin] = useState(false);
  const [viewDraft, setViewDraft] = useState<{ id?: string; name: string; category_name: string; version?: number } | null>(null);
  const [dragView, setDragView] = useState('');
  const [prefs, setPrefs] = useState<ColumnPrefs | null>(null);
  const [seededDate, setSeededDate] = useState(false);
  const [unitOpen, setUnitOpen] = useState(false);
  const [printJob, setPrintJob] = useState<PrintDoc[] | null>(null);
  const [unitName, setUnitName] = useState('');
  const [unitErr, setUnitErr] = useState('');
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    void ensureGoodsCatalog(session).then(() => onChanged()).catch(() => undefined);
  }, [onChanged, session]);
  useEffect(() => { if (!seededDate) { list.onQuery('created_to', todayText()); setSeededDate(true); } }, [list, seededDate]);
  const viewId = view === 'all' ? '' : view;
  const params = new URLSearchParams({ page: String(list.page), page_size: String(list.pageSize) });
  const queryMap: Record<string, string> = { name: 'name', code: 'code', specification: 'specification', inspection: 'inspection', category_id: 'category_id', source: 'source', supplier: 'supplier', creator: 'creator', created_from: 'created_from', created_to: 'created_to', commission_min: 'commission_min', commission_max: 'commission_max', active: 'active' };
  Object.entries(queryMap).forEach(([from, to]) => { if (list.query[from]) params.set(to, list.query[from]); });
  if (viewId) params.set('view_id', viewId);
  const products = useRemote<{ items: Product[]; total: number }>(`/api/products?${params}`, revision, onExpired);
  const stock = useRemote<{ items: Balance[] }>('/api/stock/balances', revision, onExpired);
  const boms = useRemote<{ items: { id: string; parent_product_id: string }[] }>('/api/boms', revision, onExpired);
  const categories = useRemote<{ items: Category[] }>('/api/products/categories?kind=goods', revision, onExpired);
  const views = useRemote<{ items: GoodsView[] }>('/api/products/views', revision, onExpired);
  const schemas = useRemote<{ items: Schema[] }>('/api/configuration/field-schemas', revision, onExpired);
  const current = useRemote<{ version: { id: string; fields: Field[] } | null }>('/api/configuration/field-schemas/current?entity=product', revision, onExpired);
  const columnViews = useRemote<{ personal: { id: string; version: number; configuration: { columns: string[]; card_fields: string[] } } | null }>('/api/configuration/views/product/pc', revision, onExpired);
  const mobileViews = useRemote<{ personal: { version: number; configuration: { columns: string[]; card_fields: string[] } } | null }>('/api/configuration/views/product/mobile', revision, onExpired);
  const rows = products.data?.items ?? [];
  const stockOf = (id: string, key: 'on_hand' | 'available_qty') => sumQty((stock.data?.items ?? []).filter((item) => item.product_id === id).map((item) => item[key]));
  const tabs = [{ key: 'all', label: '全部视图' }, ...(views.data?.items ?? []).map((item) => ({ key: item.id, label: item.name }))];
  useEffect(() => {
    if (!qr) return;
    const lines = [qrFlags.name ? qr.name : '', qrFlags.company ? session.tenant.name : '', qrFlags.spec ? (qr.specification ?? '') : ''].filter(Boolean);
    let alive = true;
    void qrBlob(`${location.origin}/goods/detail/${qr.id}`, lines).then((blob) => { if (alive) setQrUrl(URL.createObjectURL(blob)); });
    return () => { alive = false; };
  }, [qr, qrFlags, session.tenant.name]);
  const columns: ListColumn<Product>[] = [
    { key: 'code', title: '商品编号', render: (row) => row.code, headerFilter: { valueOf: (row) => row.code ?? '' } },
    { key: 'name', title: '商品名', render: (row) => <button className="kgd-link" onClick={() => navigate(`/goods/detail/${row.id}`)}>{row.name}</button>, headerFilter: { valueOf: (row) => row.name ?? '' } },
    { key: 'category', title: '类别', render: (row) => row.category_name ?? '', headerFilter: { options: (categories.data?.items ?? []).map((item) => ({ value: item.name, label: item.name })), valueOf: (row) => row.category_name ?? '' } },
    { key: 'available', title: '可用库存', render: (row) => stockOf(String(row.id), 'available_qty'), headerFilter: { valueOf: (row) => String(stockOf(String(row.id), 'available_qty')) } },
    { key: 'onHand', title: '总库存', render: (row) => stockOf(String(row.id), 'on_hand'), headerFilter: { valueOf: (row) => String(stockOf(String(row.id), 'on_hand')) } },
    { key: 'spec', title: '规格', render: (row) => row.specification ?? '', headerFilter: { valueOf: (row) => row.specification ?? '' } },
    { key: 'inspect', title: '检验规范', render: (row) => row.inspection_spec_name ?? '', headerFilter: { valueOf: (row) => row.inspection_spec_name ?? '' } },
    { key: 'image', title: '商品图片', render: (row) => row.images?.[0] ? <AttachmentImage id={row.images[0]} /> : '', headerFilter: { options: [{ value: '有', label: '有' }, { value: '无', label: '无' }], valueOf: (row) => (row.images?.[0] ? '有' : '无') } },
    { key: 'unit', title: '单位', render: (row) => row.unit_name ?? '', headerFilter: { valueOf: (row) => row.unit_name ?? '' } },
    { key: 'sale', title: '销售单价', render: (row) => row.sale_price ?? '', headerFilter: { valueOf: (row) => String(row.sale_price ?? '') } },
    { key: 'cost', title: '成本单价', render: (row) => row.cost_price ?? '', headerFilter: { valueOf: (row) => String(row.cost_price ?? '') } },
    { key: 'outsourcePrice', title: '外协单价', render: (row) => row.outsource_price ?? '', headerFilter: { valueOf: (row) => String(row.outsource_price ?? '') } },
    { key: 'commission', title: '售后佣金(元)', render: (row) => row.commission_amount ?? '', headerFilter: { valueOf: (row) => String(row.commission_amount ?? '') } },
    { key: 'commissionRate', title: '售后佣金比例', render: (row) => row.commission_rate ?? '', headerFilter: { valueOf: (row) => String(row.commission_rate ?? '') } },
    { key: 'source', title: '商品来源', render: (row) => row.source ?? '', headerFilter: { options: sourceOptions.map((item) => ({ value: item, label: item })), valueOf: (row) => row.source ?? '' } },
    { key: 'bom', title: '商品BOM', render: (row) => { const bom = boms.data?.items.find((item) => item.parent_product_id === String(row.id)); return bom ? <button className="kgd-link" onClick={() => navigate(`/bom/edit/${bom.id}`)}>有</button> : '无'; }, headerFilter: { options: [{ value: '有', label: '有' }, { value: '无', label: '无' }], valueOf: (row) => (boms.data?.items.some((item) => item.parent_product_id === String(row.id)) ? '有' : '无') } },
    { key: 'flow', title: '工序流程', render: (row) => row.has_route ? '有' : '无', headerFilter: { options: [{ value: '有', label: '有' }, { value: '无', label: '无' }], valueOf: (row) => (row.has_route ? '有' : '无') } },
    { key: 'supplier', title: '供应商', render: (row) => row.supplier_name ?? '', headerFilter: { valueOf: (row) => row.supplier_name ?? '' } },
    { key: 'files', title: '附件', render: (row) => String(row.attachments?.length ?? 0), headerFilter: { valueOf: (row) => String(row.attachments?.length ?? 0) } },
    { key: 'note', title: '备注', render: (row) => row.remark ?? '', headerFilter: { valueOf: (row) => row.remark ?? '' } },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={row.active ? '启用' : '禁用'} />, headerFilter: { options: [{ value: '启用', label: '启用' }, { value: '禁用', label: '禁用' }], valueOf: (row) => (row.active ? '启用' : '禁用') } },
    { key: 'stale', title: '呆滞警告值', render: (row) => row.stale_days ?? '', headerFilter: { valueOf: (row) => String(row.stale_days ?? '') } },
    { key: 'max', title: '库存上限警告值', render: (row) => row.stock_upper_warn ?? '', headerFilter: { valueOf: (row) => String(row.stock_upper_warn ?? '') } },
    { key: 'min', title: '库存下限警告值', render: (row) => row.stock_lower_warn ?? '', headerFilter: { valueOf: (row) => String(row.stock_lower_warn ?? '') } },
    { key: 'creator', title: '创建人', render: (row) => row.creator_name ?? '', headerFilter: { valueOf: (row) => row.creator_name ?? '' } },
    { key: 'created', title: '创建时间', render: (row) => formatDate(row.created_at), headerFilter: { valueOf: (row) => formatDate(row.created_at) } },
    ...(current.data?.version?.fields ?? []).map((field) => ({ key: `ext:${field.key}`, title: field.label, render: (row: Product) => String(row.extension?.values[field.key] ?? ''), headerFilter: { valueOf: (row: Product) => String(row.extension?.values[field.key] ?? '') } })),
    { key: 'actions', title: '操作', width: 280, render: (row) => <>
      <Button type="link" onClick={() => { setQrFlags({ name: true, company: true, spec: false }); setQr(row); }}>查看二维码</Button>
      <Button type="link" onClick={() => { setCopying(false); setEditing(row); }}>修改</Button>
      <Button type="link" onClick={() => { setCopying(true); setEditing(row); }}>复制</Button>
      <Button type="link" onClick={() => printGoods([row])}>打印</Button>
      <Button type="link" danger onClick={() => Modal.confirm({ title: '删除商品', content: `确定删除 ${row.name}？`, okText: '确定', cancelText: '取消', onOk: () => command.send(`/api/products/${row.id}`, {}, 'DELETE').catch((failure) => command.setError(showError(failure))) })}>删除</Button>
    </> },
  ];
  const visibleKeys = (prefs?.visible ?? goodsColumns);
  function exportRows(onlyVisible: boolean) {
    const keys = onlyVisible ? columns.filter((column) => visibleKeys.includes(column.key) && column.key !== 'actions' && column.key !== 'image') : columns.filter((column) => column.key !== 'actions');
    const head = onlyVisible ? keys.map((column) => column.title) : exportHeads;
    const body = rows.map((row) => onlyVisible ? keys.map((column) => plain(row, column.key)) : cells(row));
    downloadWorkbook(onlyVisible ? '商品-显示列.xlsx' : '商品-所有列.xlsx', [head, ...body]);
  }
  function printGoods(targets: Product[]) {
    if (!targets.length) return;
    setPrintJob(targets.map((row) => ({ title: '商品', fields: [['商品名', row.name], ['编号', row.code], ['规格', row.specification ?? ''], ['单位', row.unit_name ?? ''], ['商品来源', String(row.source ?? '')], ['销售单价', String(row.sale_price ?? '')], ['成本单价', String(row.cost_price ?? '')]] })));
  }
  async function importProducts(file: File) {
    const table = await readWorkbook(file);
    const head = table[0] ?? [];
    const index = (title: string) => head.indexOf(title);
    for (const line of table.slice(1)) {
      const name = line[index('商品名')] ?? '';
      if (!name) continue;
      const categoryName = index('类别') >= 0 ? line[index('类别')] : '';
      const unitName = index('单位') >= 0 ? line[index('单位')] : '';
      await command.send('/api/products', {
        name, code: index('商品编号') >= 0 ? line[index('商品编号')] ?? '' : '', specification: index('规格') >= 0 ? line[index('规格')] ?? '' : '',
        sale_price: index('销售单价') >= 0 ? line[index('销售单价')] || null : null, cost_price: index('成本单价') >= 0 ? line[index('成本单价')] || null : null,
        source: index('商品来源') >= 0 ? line[index('商品来源')] || null : null, remark: index('备注') >= 0 ? line[index('备注')] ?? '' : '',
        category_id: categories.data?.items.find((item) => item.name === categoryName)?.id ?? null,
        unit_id: null,
        ...(unitName ? {} : {}),
      });
    }
  }
  async function saveView(next: ColumnPrefs) {
    setPrefs(next);
    const mapped = next.visible.filter((key) => ['code', 'name', 'specification', 'unit', 'source', 'status'].includes(key) || key.startsWith('ext:')).map((key) => key === 'unit' ? 'unit_name' : key === 'source' ? 'attribute' : key === 'status' ? 'active' : key === 'spec' ? 'specification' : key);
    await command.send('/api/configuration/views/product/pc', { scope: 'personal', expected_version: columnViews.data?.personal?.version ?? 0, columns: mapped.length ? mapped : ['code', 'name'], card_fields: columnViews.data?.personal?.configuration.card_fields ?? ['code', 'name'], frozen_count: next.locked.length, sort: [] }, 'PUT');
  }
  async function applyOthers() {
    const viewId = columnViews.data?.personal?.id;
    if (!viewId || !hasPermission(session, 'configuration.manage')) return;
    const members = await apiRequest<{ items: { id: string }[] }>('/api/team-members');
    const targets = members.items.map((item) => String(item.id)).filter((item) => item !== String(session.user.id));
    if (!targets.length) return;
    await command.send('/api/configuration/views/apply', { view_id: viewId, target_user_ids: targets, strategy: 'replace' });
  }
  async function createField(value: { label: string; required: boolean; type: string; options: string }) {
    const type = value.type === '数字输入框' ? 'number' : value.type === '单选下拉框' ? 'select' : value.type === '日期' ? 'date' : 'text';
    const key = `f${Date.now().toString(36)}`.slice(0, 32);
    const field: Field = { key, label: value.label, type, required: value.required, read_roles: ['admin', 'planner', 'worker'], write_roles: ['admin', 'planner'], ...(type === 'select' ? { options: value.options.split(/[,，]/).map((item) => item.trim()).filter(Boolean) } : {}) };
    const schema = schemas.data?.items.find((item) => item.entity === 'product');
    if (!schema) await command.send('/api/configuration/field-schemas', { entity: 'product', fields: [field] });
    else {
      const detail = await apiRequest<{ schema: { version: number }; versions: { id: string; state: string; fields: Field[] }[] }>(`/api/configuration/field-schemas/${schema.id}`);
      const published = detail.versions.find((item) => item.state === 'published');
      const created = await command.send<{ version: { id: string } }>(`/api/configuration/field-schemas/${schema.id}/versions`, { expected_version: detail.schema.version, fields: [...(published?.fields ?? []), field] });
      if (created?.version.id) await command.send(`/api/configuration/field-schemas/${schema.id}/publish`, { expected_version: detail.schema.version + 1, version_id: created.version.id });
    }
    setAddField(false);
  }
  async function runBatchEdit() {
    const targets = rows.filter((row) => selected.includes(String(row.id)));
    for (const row of targets) {
      await command.send(`/api/products/${row.id}`, { version: row.version, name: row.name, active: row.active, ...(batchSource ? { source: batchSource } : {}), ...(batchCategory ? { category_id: batchCategory } : {}) }, 'PATCH');
    }
    setBatchEdit(false);
    setSelected([]);
  }
  async function downloadCodes(targets: Product[]) {
    for (const row of targets) {
      const blob = await qrBlob(row.code, [row.name, session.tenant.name]);
      downloadBlob(`${row.code}.png`, blob);
    }
  }
  const batchItems: MenuProps['items'] = [
    { key: 'edit', label: '批量修改', disabled: !selected.length },
    { key: 'delete', label: '批量删除', disabled: !selected.length },
    { key: 'print', label: '批量打印', disabled: !selected.length },
    { key: 'qr', label: '批量下载商品码', disabled: !selected.length },
  ];
  const moreItems: MenuProps['items'] = [
    { key: 'import', label: '导入商品' },
    { key: 'import-process', label: '导入商品工序明细' },
    { key: 'export-all', label: '导出(所有列)' },
    { key: 'export-visible', label: '导出(显示列)' },
    { type: 'divider' },
    { key: 'upload', label: '批量上传文件' },
  ];
  return <>
    <div className="no-print"><ListFrame pageKey="goods" columns={columns} rows={rows} loading={products.loading} error={products.error || command.error} clientPaging={false} emptyDescription=""
      viewTabs={tabs} activeView={view} onView={setView}
      viewMenu={(tab) => tab.key === 'all' ? [{ key: 'edit', label: '修改' }, { key: 'copy', label: '复制' }, { key: 'delete', label: '删除', danger: true }] : [{ key: 'edit', label: '修改' }, { key: 'copy', label: '复制' }, { key: 'delete', label: '删除', danger: true }]}
      onViewAction={(tabKey, action) => {
        if (tabKey === 'all') return;
        const item = views.data?.items.find((viewItem) => viewItem.id === tabKey);
        if (!item) return;
        if (action === 'edit') setViewDraft({ id: item.id, name: item.name, category_name: item.category_name ?? '', version: item.version });
        if (action === 'copy') void command.send(`/api/products/views/${item.id}/copy`, {});
        if (action === 'delete') Modal.confirm({ title: '删除视图', content: `确定删除 ${item.name}？`, okText: '确定', cancelText: '取消', onOk: () => command.send(`/api/products/views/${item.id}`, {}, 'DELETE') });
      }}
      onAddView={() => setViewAdmin(true)}
      queryFields={[
        { key: 'name', label: '商品名' },
        { key: 'code', label: '商品编号' },
        { key: 'specification', label: '商品规格' },
        { key: 'inspection', label: '检验规范' },
        { key: 'category_id', label: '类别', kind: 'tree', treeData: treeData(buildTree(categories.data?.items ?? [])) },
        { key: 'source', label: '商品来源', kind: 'select', options: sourceOptions.map((item) => ({ value: item, label: item })) },
        { key: 'supplier', label: '供应商', placeholder: '姓名/简拼' },
        { key: 'creator', label: '创建人', placeholder: '姓名/简拼' },
        { key: 'created_from', label: '创建时间起', kind: 'date' },
        { key: 'created_to', label: '创建时间止', kind: 'date' },
        { key: 'commission_min', label: '售后佣金', placeholder: '最小' },
        { key: 'commission_max', label: '售后佣金最大', placeholder: '最大' },
        { key: 'active', label: '启用/禁用', kind: 'select', options: [{ value: '启用', label: '启用' }, { value: '禁用', label: '禁用' }] },
      ]} defaultQueryKeys={['name', 'code']}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      toolbar={<><Button type="primary" onClick={() => { setCopying(false); setEditing(null); }}>+ 新增</Button>
        <Button onClick={() => { setUnitName(''); setUnitErr(''); setUnitOpen(true); }}>单位</Button>
        <Dropdown menu={{ items: batchItems, onClick: ({ key }) => {
          const targets = rows.filter((row) => selected.includes(String(row.id)));
          if (key === 'edit') setBatchEdit(true);
          if (key === 'delete') Modal.confirm({ title: '批量删除', content: `确定删除选中的 ${targets.length} 个商品？`, okText: '确定', cancelText: '取消', onOk: () => command.send('/api/products/batch-delete', { ids: targets.map((row) => String(row.id)) }).then(() => setSelected([])) });
          if (key === 'print') printGoods(targets);
          if (key === 'qr') void downloadCodes(targets);
        } }}><Button disabled={!selected.length}>批量操作 <DownOutlined /></Button></Dropdown></>}
      beforeTools={<><Button type="primary" onClick={() => navigate('/public_craft/list')}>批量插入工序</Button><Button type="primary" onClick={() => navigate('/craft_route/list')}>商品工序管理</Button></>}
      moreItems={moreItems}
      page={list.page} pageSize={list.pageSize} total={products.data?.total ?? rows.length} onPage={list.onPage}
      rowSelection={{ selected, onChange: setSelected }}
      extensionObject="商品" extensionRows={(current.data?.version?.fields ?? []).map((field) => ({ key: field.key, name: field.label, type: field.type, required: field.required ? '是' : '否', createdAt: '' }))} extensionCanAdd onExtensionAdd={() => setAddField(true)}
      columnPrefs={prefs ?? undefined} onColumnPrefs={(next) => void saveView(next)} onApplyOthers={hasPermission(session, 'configuration.manage') ? () => void applyOthers() : undefined}
      onMore={(key) => {
        if (key === 'import') document.getElementById('goods-import-input')?.click();
        if (key === 'import-process') navigate('/public_craft/list');
        if (key === 'export-all') exportRows(false);
        if (key === 'export-visible') exportRows(true);
        if (key === 'upload') document.getElementById('goods-batch-file')?.click();
      }}
      onMobileCards={(next) => void command.send('/api/configuration/views/product/mobile', { scope: 'personal', expected_version: mobileViews.data?.personal?.version ?? 0, columns: next.scan ?? next.list ?? ['code', 'name'], card_fields: (next.list ?? ['code', 'name']).slice(0, 15), frozen_count: 0, sort: [] }, 'PUT')}
      showMobileCard defaultVisible={goodsColumns} mobileTabs={[{ key: 'list', label: '商品列表卡片' }, { key: 'scan', label: '商品扫码卡片' }]} mobileFields={{ list: columns.map((column) => ({ key: column.key, label: column.title })), scan: columns.slice(0, 6).map((column) => ({ key: column.key, label: column.title })) }} />
    </div>
    {editing !== undefined && <GoodsEditor product={editing ?? undefined} copying={copying} onClose={() => { setEditing(undefined); setCopying(false); }} />}
    <Modal title="新增单位" open={unitOpen} okText="确 定" cancelText="取 消" onCancel={() => setUnitOpen(false)} onOk={() => {
      if (!unitName.trim()) { setUnitErr('请填写单位'); return; }
      void command.send('/api/units', { code: `U${Date.now().toString(36)}`, name: unitName.trim() }).then(() => setUnitOpen(false)).catch((failure) => setUnitErr(showError(failure)));
    }}>
      {unitErr ? <div className="kgd-banner kgd-field-error">{unitErr}</div> : null}
      <span className={unitErr ? 'kgd-field-error-label' : undefined}>单位</span>
      <Input className={unitErr ? 'kgd-field-error' : undefined} placeholder="单位" value={unitName} onChange={(event) => setUnitName(event.target.value)} />
    </Modal>
    <ExtensionAddDialog open={addField} onCancel={() => setAddField(false)} onOk={(value) => {
      if (!value.label) { command.setError('请填写字段名'); return; }
      if ((value.type === '单选下拉框' || value.type === '多选下拉框') && !value.options.trim()) { command.setError('请填写下拉框数据'); return; }
      void createField(value);
    }} />
    <input id="goods-import-input" hidden type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProducts(file).catch((failure) => command.setError(showError(failure))); event.target.value = ''; }} />
    <input id="goods-batch-file" hidden type="file" multiple onChange={(event) => { void uploadToSelected(event.target.files, rows.filter((row) => selected.includes(String(row.id))), session, command).catch((failure) => command.setError(showError(failure))); event.target.value = ''; }} />
    <Modal title="查看二维码" open={!!qr} footer={null} onCancel={() => setQr(null)}>
      <div style={{ display: 'flex', gap: 24 }}>
        <div>{qrUrl && <img alt="商品二维码" src={qrUrl} width={240} />}</div>
        <div>
          <div><label><input type="checkbox" checked={qrFlags.name} onChange={(event) => setQrFlags((current) => ({ ...current, name: event.target.checked }))} /> 名称</label></div>
          <div><label><input type="checkbox" checked={qrFlags.company} onChange={(event) => setQrFlags((current) => ({ ...current, company: event.target.checked }))} /> 公司名称</label></div>
          <div><label><input type="checkbox" checked={qrFlags.spec} onChange={(event) => setQrFlags((current) => ({ ...current, spec: event.target.checked }))} /> 规格</label></div>
          <Button style={{ marginTop: 12 }} onClick={() => { if (!qrUrl || !qr) return; void fetch(qrUrl).then((response) => response.blob()).then((blob) => downloadBlob(`${qr.code}.png`, blob)); }}>下载</Button>
        </div>
      </div>
    </Modal>
    <Modal title="批量修改" open={batchEdit} okText="确定" cancelText="取消" onCancel={() => setBatchEdit(false)} onOk={() => void runBatchEdit()} confirmLoading={command.busy}>
      <div className="kgd-form"><span>商品来源</span><Select allowClear placeholder="请选择" value={batchSource || undefined} options={sourceOptions.map((item) => ({ value: item, label: item }))} onChange={(value) => setBatchSource(value ?? '')} /><span>类别</span><TreeSelect allowClear placeholder="请选择" value={batchCategory || undefined} treeData={treeData(buildTree(categories.data?.items ?? []))} onChange={(value) => setBatchCategory(value ?? '')} /></div>
    </Modal>
    <Modal title="视图管理" open={viewAdmin} width={720} onCancel={() => setViewAdmin(false)} footer={<Button type="primary" onClick={() => setViewAdmin(false)}>确定</Button>}>
      <div className="kgd-toolbar"><Button type="primary" onClick={() => setViewDraft({ name: '', category_name: '' })}>+创建视图</Button></div>
      <table style={{ width: '100%' }}><thead><tr><th>排序</th><th>视图名称</th><th>操作</th></tr></thead><tbody>
        {(views.data?.items ?? []).map((item) => <tr key={item.id} draggable onDragStart={() => setDragView(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => {
          const ordered = [...(views.data?.items ?? [])];
          const from = ordered.findIndex((row) => row.id === dragView);
          const to = ordered.findIndex((row) => row.id === item.id);
          if (from < 0 || to < 0) return;
          const [moved] = ordered.splice(from, 1);
          ordered.splice(to, 0, moved!);
          void command.send('/api/products/views/reorder', { ids: ordered.map((row) => row.id) });
        }}><td>☰</td><td>{item.name}</td><td>
          <Button type="link" onClick={() => void command.send(`/api/products/views/${item.id}/copy`, {})}>复制</Button>
          <Button type="link" onClick={() => setViewDraft({ id: item.id, name: item.name, category_name: item.category_name ?? '', version: item.version })}>修改</Button>
          <Button type="link" danger onClick={() => void command.send(`/api/products/views/${item.id}`, {}, 'DELETE')}>删除</Button>
        </td></tr>)}
      </tbody></table>
    </Modal>
    <Modal title={viewDraft?.id ? '修改视图' : '创建视图'} open={!!viewDraft} okText="确定" cancelText="取消" onCancel={() => setViewDraft(null)} onOk={() => {
      if (!viewDraft?.name.trim()) return;
      const done = viewDraft.id ? command.send(`/api/products/views/${viewDraft.id}`, { name: viewDraft.name.trim(), category_name: viewDraft.category_name || null, version: viewDraft.version }, 'PATCH') : command.send('/api/products/views', { name: viewDraft.name.trim(), category_name: viewDraft.category_name || null });
      void done.then(() => setViewDraft(null)).catch((failure) => command.setError(showError(failure)));
    }}>
      <div className="kgd-form"><span>视图名称</span><Input value={viewDraft?.name ?? ''} onChange={(event) => setViewDraft((current) => current ? { ...current, name: event.target.value } : current)} /><span>类别</span><Select allowClear value={viewDraft?.category_name || undefined} options={(categories.data?.items ?? []).map((item) => ({ value: item.name, label: item.name }))} onChange={(value) => setViewDraft((current) => current ? { ...current, category_name: value ?? '' } : current)} /></div>
    </Modal>
    <PrintPickModal objectKey="goods" title="打印商品" docs={printJob} onClose={() => setPrintJob(null)} />
  </>;
}

function plain(row: Product, key: string) {
  const map: Record<string, string> = { code: row.code, name: row.name, category: row.category_name ?? '', spec: row.specification ?? '', inspect: row.inspection_spec_name ?? '', unit: row.unit_name ?? '', sale: row.sale_price ?? '', cost: row.cost_price ?? '', outsourcePrice: row.outsource_price ?? '', commission: row.commission_amount ?? '', commissionRate: row.commission_rate ?? '', source: row.source ?? '', supplier: row.supplier_name ?? '', note: row.remark ?? '', status: row.active ? '启用' : '禁用', stale: row.stale_days ?? '', max: row.stock_upper_warn ?? '', min: row.stock_lower_warn ?? '', creator: row.creator_name ?? '', created: formatDate(row.created_at), bom: '', flow: row.has_route ? '有' : '无', files: String(row.attachments?.length ?? 0) };
  return map[key] ?? '';
}

async function uploadToSelected(list: FileList | null, products: Product[], session: { csrf_token: string }, command: { send: (path: string, body: Record<string, unknown>, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE') => Promise<unknown> }) {
  if (!list || !products.length) return;
  for (const product of products) {
    const ids = [...(product.attachments ?? [])];
    for (const file of [...list]) {
      const mime = allowedMime(file, false) || allowedMime(file, true);
      if (!mime) continue;
      const saved = await apiRequest<{ attachment: { id: string } }>('/api/attachments', { method: 'POST', csrfToken: session.csrf_token, body: { resource_type: 'product', resource_id: String(product.id), filename: file.name, mime, content_base64: await fileBase64(file), request_key: requestKey() } });
      ids.push(saved.attachment.id);
    }
    await command.send(`/api/products/${product.id}`, { version: product.version, name: product.name, active: product.active, attachments: ids }, 'PATCH');
  }
}

