import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Dropdown, Input, Modal, Select, Switch, Table } from 'antd';
import { apiRequest, type Product } from '../../api';
import { bomSavePayload, validateBomDraft } from '../../domain/payloads';
import type { BomLineDraft } from '../../domain/payloads';
import type { Bom, Explosion, Route } from '../../masterTypes';
import { idText } from '../../masterTypes';
import { useRemote } from '../../masterTools';
import { useKgd } from '../context';
import { ListFrame } from '../ListFrame';
import type { ListColumn } from '../ListFrame';
import { showError, StatusTag, useCommand, useQueryState, beijingTime } from '../kit';
import { useExtForm, useExtList } from '../extensions/bind';
import { dash } from './round10/shared';
import { qtyText } from '../qty';
import { requestKey } from '../../requestKey';
import { lineAmount, sumMoney } from './money/math';
import { ProductPicker } from './money/shared';
import type { Category } from './goods/shared';

type BomRow = Bom & {
  active?: boolean;
  code?: string | null;
  name?: string | null;
  category?: string | null;
  is_default?: boolean;
  note?: string | null;
  specification?: string | null;
  creator_name?: string | null;
  created_at?: string | null;
  child_names?: string | null;
};

type VersionItem = {
  component_product_id: string;
  component_code?: string;
  component_name?: string;
  unit_name?: string;
  quantity: string;
  loss_rate: string;
  feeding_process_id: string | null;
  inbound_process_id?: string | null;
  cost_price?: string | null;
  auto_issue: boolean;
  component_bom_version_id: string | null;
};

type EditorLine = BomLineDraft & {
  product_name?: string;
  product_code?: string;
  specification?: string;
  unit_name?: string;
  source?: string;
  product_cost?: string;
};

type PreviewNode = { key: string; label: string; children: PreviewNode[] };

function previewNodes(requirements: Explosion['requirements']): PreviewNode[] {
  const roots: PreviewNode[] = [];
  const index = new Map<string, PreviewNode>();
  for (const item of requirements) {
    for (const path of item.paths) {
      const parts = path.split(' → ').map((part) => part.trim()).filter(Boolean);
      let parentKey = '';
      parts.forEach((part, depth) => {
        const key = `${parentKey}/${part}`;
        const leaf = depth === parts.length - 1;
        let node = index.get(key);
        if (!node) {
          node = { key, label: leaf ? `${part} ${item.name}　展开用量 ${qtyText(item.quantity)} ${item.unit_name}` : part, children: [] };
          index.set(key, node);
          if (!parentKey) roots.push(node);
          else index.get(parentKey)?.children.push(node);
        } else if (leaf) node.label = `${part} ${item.name}　展开用量 ${qtyText(item.quantity)} ${item.unit_name}`;
        parentKey = key;
      });
    }
  }
  return roots;
}

function PreviewTree({ nodes }: { nodes: PreviewNode[] }) {
  return <ul style={{ margin: 0, paddingLeft: 18 }}>{nodes.map((node) => <li key={node.key}>{node.label}{node.children.length ? <PreviewTree nodes={node.children} /> : null}</li>)}</ul>;
}

export function BomStructureModal({ bom, onClose }: { bom: { id: string | number } | null; onClose: () => void }) {
  const { revision, onExpired } = useKgd();
  const explosion = useRemote<Explosion>(bom ? `/api/boms/${idText(bom.id)}/explosion?quantity=1` : null, revision, onExpired);
  const nodes = previewNodes(explosion.data?.requirements ?? []);
  return <Modal title="结构预览" open={!!bom} onCancel={onClose} footer={null} width={640}>
    {nodes.length ? <PreviewTree nodes={nodes} /> : <div>{explosion.error || (explosion.loading ? '正在读取数据…' : '暂无数据')}</div>}
  </Modal>;
}

function moneyMul(price: string, qty: string) {
  const left = price.trim();
  if (!left) return '';
  try { return lineAmount(`${left}*${qty.trim() || '0'}`, '0', '0', 6); } catch { return ''; }
}

function scaleCost(value: string) {
  const text = value.trim();
  if (!text) return '';
  try { return lineAmount(`${text}*1`, '0', '0', 6); } catch { return null; }
}

function sourceLabel(attribute: string | null | undefined) {
  if (attribute === 'purchased') return '外购';
  if (attribute === 'outsourced') return '外协';
  if (attribute === 'manufactured') return '自产';
  return attribute ?? '';
}

export function BomList() {
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const remote = useRemote<{ items: BomRow[]; total: number; limit: number }>('/api/boms', revision, onExpired);
  const [chosen, setChosen] = useState<string[]>([]);
  const list = useQueryState();
  const [tab, setTab] = useState('all');
  const [preview, setPreview] = useState<BomRow | null>(null);
  const extList = useExtList('bom');
  const items = remote.data?.items ?? [];
  const has = (value: string | null | undefined, key: string) => !(list.query[key] ?? '') || (value ?? '').includes(list.query[key] ?? '');
  const rows = items.filter((row) => {
    const day = (row.created_at ?? '').slice(0, 10);
    return (tab === 'on' ? row.active !== false : tab === 'off' ? row.active === false : true)
      && (!(list.query.product ?? '') || row.parent_name.includes(list.query.product ?? '') || row.parent_code.includes(list.query.product ?? ''))
      && has(row.code, 'bomCode') && has(row.name, 'bomName') && has(row.category, 'category') && has(row.creator_name, 'creator') && has(row.child_names, 'child')
      && (!(list.query.created_from ?? '') || (day && day >= (list.query.created_from ?? '')))
      && (!(list.query.created_to ?? '') || (day && day <= (list.query.created_to ?? '')));
  }).sort((left, right) => (right.created_at ?? '').localeCompare(left.created_at ?? '') || String(right.id).localeCompare(String(left.id)));
  function remove(targets: BomRow[]) {
    Modal.confirm({
      title: '删除BOM', content: targets.length > 1 ? `确定删除选中的 ${targets.length} 个BOM？已被加工单引用的BOM不能删除。` : `确定删除「${targets[0]?.name || targets[0]?.parent_name}」？已被加工单引用的BOM不能删除。`, okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        const failed: string[] = [];
        for (const row of targets) {
          try { await command.send(`/api/boms/${idText(row.id)}`, { version: row.version }, 'DELETE'); } catch (failure) { failed.push(`${row.parent_name}：${showError(failure)}`); }
        }
        setChosen([]);
        if (failed.length) Modal.warning({ title: '部分BOM未删除', content: <div>{failed.map((item) => <div key={item}>{item}</div>)}</div> });
      },
    });
  }
  const columns: ListColumn<BomRow>[] = [
    { key: 'code', title: 'BOM编号', render: (row) => dash(row.code) }, { key: 'name', title: 'BOM名称', render: (row) => dash(row.name) },
    { key: 'productCode', title: '商品编号', render: (row) => row.parent_code },
    { key: 'product', title: '商品', render: (row) => <button className="kgd-link" onClick={() => navigate(`/bom/edit/${idText(row.id)}`)}>{row.parent_name}</button> },
    { key: 'spec', title: '规格', render: (row) => dash(row.specification) }, { key: 'category', title: '类别', render: (row) => dash(row.category) },
    { key: 'default', title: '默认BOM', render: (row) => row.is_default ? '是' : '否' },
    { key: 'preview', title: '结构预览', render: (row) => <button className="kgd-link" onClick={() => setPreview(row)}>预览</button> },
    { key: 'status', title: '启用/禁用', render: (row) => <StatusTag text={row.active === false ? '禁用' : '启用'} /> },
    { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) }, { key: 'note', title: '备注', render: (row) => dash(row.note) },
    { key: 'version', title: '版本', render: (row) => `r${row.current_revision}` },
    { key: 'count', title: '明细数', render: (row) => String(row.items_count) },
    { key: 'created', title: '创建时间', render: (row) => dash(beijingTime(row.created_at, '')) },
    { key: 'actions', title: '操作', render: (row) => <><Button type="link" onClick={() => navigate(`/bom/edit/${idText(row.id)}`)}>修改</Button><Button type="link" onClick={() => navigate(`/bom/add?copy=${idText(row.id)}`)}>复制</Button><Button type="link" danger disabled={command.busy} onClick={() => remove([row])}>删除</Button></> },
  ];
  return <>
    <ListFrame pageKey="boms" {...extList.props} columns={columns} rows={rows} loading={remote.loading} error={remote.error || command.error}
      rowSelection={{ selected: chosen, onChange: setChosen }}
      viewTabs={[{ key: 'all', label: '全部' }, { key: 'on', label: '启用' }, { key: 'off', label: '禁用' }]} activeView={tab} onView={setTab}
      queryFields={[
        { key: 'bomCode', label: 'BOM编号' }, { key: 'bomName', label: 'BOM名称' }, { key: 'category', label: '类别' },
        { key: 'product', label: '商品' }, { key: 'child', label: '子商品' }, { key: 'creator', label: '创建人' },
        { key: 'created_from', label: '创建时间起', kind: 'date' }, { key: 'created_to', label: '创建时间止', kind: 'date' },
      ]}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      toolbar={<><Button type="primary" onClick={() => navigate('/bom/add')}>新增</Button><Dropdown disabled={!chosen.length || command.busy} menu={{ items: [{ key: 'delete', label: '批量删除', danger: true }], onClick: () => remove(rows.filter((row) => chosen.includes(String(row.id)))) }}><Button>批量操作</Button></Dropdown></>}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      limitNote={remote.data && remote.data.total > remote.data.items.length ? `当前仅加载最近 ${remote.data.limit} 条` : undefined} />
    {extList.dialog}
    <BomStructureModal bom={preview} onClose={() => setPreview(null)} />
  </>;
}

export function BomEditorPage() {
  const params = useParams();
  const { pathname } = useLocation();
  const pathId = pathname.startsWith('/bom/edit/') ? decodeURIComponent(pathname.slice('/bom/edit/'.length).split(/[/?#]/)[0] ?? '') : '';
  const id = params.id || pathId || undefined;
  const [search] = useSearchParams();
  const sourceId = id ?? search.get('copy') ?? undefined;
  const presetProduct = id ? '' : (search.get('product') ?? '');
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const products = useRemote<{ items: Product[] }>('/api/products?page=1&page_size=100', revision, onExpired);
  const preset = useRemote<{ product: Product }>(presetProduct ? `/api/products/${presetProduct}` : null, revision, onExpired);
  const routes = useRemote<{ items: Route[] }>('/api/routes', revision, onExpired);
  const boms = useRemote<{ items: BomRow[] }>('/api/boms', revision, onExpired);
  const categories = useRemote<{ items: Category[] }>('/api/products/categories?kind=bom', revision, onExpired);
  const detail = useRemote<{ bom: BomRow }>(sourceId ? `/api/boms/${sourceId}` : null, revision, onExpired);
  const version = useRemote<{ version: { description: string | null; route_version_id: string | null }; items: VersionItem[] }>(detail.data?.bom.current_version_id ? `/api/bom-versions/${detail.data.bom.current_version_id}` : null, revision, onExpired);
  const [parent, setParent] = useState('');
  const [routeId, setRouteId] = useState('');
  const [lines, setLines] = useState<EditorLine[]>([]);
  const [pickedLines, setPickedLines] = useState<string[]>([]);
  const [pickOpen, setPickOpen] = useState(false);
  const [ready, setReady] = useState(!sourceId);
  const [seeded, setSeeded] = useState(false);
  const [header, setHeader] = useState({ code: '', name: '', category: '', is_default: false, note: '' });
  const [childCosts, setChildCosts] = useState<Record<string, string>>({});
  const extForm = useExtForm('bom', id);
  const route = routes.data?.items.find((item) => item.id === routeId || item.current_version_id === routeId);
  const steps = useRemote<{ steps: { process_id: string; process_name: string }[] }>(route?.current_version_id ? `/api/route-versions/${route.current_version_id}` : null, revision, onExpired);
  const catalog = products.data?.items ?? [];
  function findProduct(productId: string) {
    if (preset.data?.product && String(preset.data.product.id) === productId) return preset.data.product;
    return catalog.find((item) => String(item.id) === productId);
  }
  useEffect(() => {
    if (!sourceId || !detail.data || !version.data || ready) return;
    const bom = detail.data.bom;
    if (id) setParent(bom.parent_product_id);
    setHeader({ code: id ? bom.code ?? '' : '', name: id ? bom.name ?? '' : `${bom.name || bom.parent_name}-复制`, category: bom.category ?? '', is_default: id ? !!bom.is_default : false, note: version.data.version.description ?? bom.note ?? '' });
    setRouteId(version.data.version.route_version_id ?? '');
    setLines(version.data.items.map((item) => ({
      component_product_id: item.component_product_id,
      quantity: item.quantity,
      loss_rate: item.loss_rate,
      feeding_process_id: item.feeding_process_id ?? '',
      inbound_process_id: item.inbound_process_id ?? '',
      cost_price: item.cost_price ?? '',
      auto_issue: item.auto_issue,
      child_mode: item.component_bom_version_id ? 'version' : 'leaf',
      child_version_id: item.component_bom_version_id ?? '',
      product_name: item.component_name,
      product_code: item.component_code,
      unit_name: item.unit_name,
    })));
    setReady(true);
  }, [detail.data, id, ready, sourceId, version.data]);
  useEffect(() => {
    if (sourceId || seeded || !presetProduct) return;
    setParent((current) => current || presetProduct);
    const product = preset.data?.product;
    if (!product) return;
    setHeader((current) => current.name ? current : { ...current, name: product.name });
    setSeeded(true);
  }, [preset.data, presetProduct, seeded, sourceId]);
  const versionKey = lines.filter((line) => line.child_mode === 'version' && line.child_version_id).map((line) => line.child_version_id).sort().join(',');
  useEffect(() => {
    const ids = versionKey ? versionKey.split(',') : [];
    if (!ids.length) return;
    let alive = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const versionId of ids) {
        try {
          const data = await apiRequest<{ items: { quantity: string; cost_price: string | null; component_product_id: string }[] }>(`/api/bom-versions/${versionId}`);
          next[versionId] = sumMoney((data.items ?? []).map((item) => moneyMul(item.cost_price?.trim() || findProduct(item.component_product_id)?.cost_price || '0', item.quantity) || '0'));
        } catch { next[versionId] = ''; }
      }
      if (alive) setChildCosts((current) => ({ ...current, ...next }));
    })();
    return () => { alive = false; };
  }, [versionKey, products.data, preset.data]);
  function shownCost(line: EditorLine) {
    if (line.child_mode === 'version' && line.child_version_id) return childCosts[line.child_version_id] || line.cost_price || '';
    return line.cost_price || '';
  }
  function patch(index: number, next: Partial<EditorLine>) {
    setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item));
  }
  function defaultVersion(productId: string) {
    const mine = (boms.data?.items ?? []).filter((item) => item.parent_product_id === productId && item.active !== false && item.current_version_id);
    return (mine.find((item) => item.is_default) ?? mine[0])?.current_version_id ?? '';
  }
  const amounts = lines.map((line) => moneyMul(shownCost(line), line.quantity) || '0');
  const costTotal = sumMoney(amounts);
  async function createChildBoms() {
    const indexes = pickedLines.map(Number).filter((index) => lines[index]);
    if (!indexes.length) { command.setError('请先勾选要创建BOM的物料'); return; }
    for (const index of indexes) {
      const line = lines[index]!;
      const product = findProduct(line.component_product_id);
      if (product && product.attribute !== 'manufactured') { command.setError('仅自产商品可以创建BOM'); return; }
      const name = product?.name || line.product_name || '';
      if (!name) { command.setError('请先选择商品'); return; }
      const saved = await command.send<{ bom: Bom }>('/api/boms', { parent_product_id: line.component_product_id, name, items: [], request_key: requestKey() });
      const created = saved?.bom;
      if (!created?.current_version_id) return;
      const hasDefault = (boms.data?.items ?? []).some((item) => item.parent_product_id === line.component_product_id && item.is_default);
      await command.send(`/api/boms/${idText(created.id)}/extras`, { name, is_default: !hasDefault }, 'PUT');
      patch(index, { child_mode: 'version', child_version_id: created.current_version_id, cost_price: '' });
    }
    setPickedLines([]);
  }
  async function save() {
    const pending = lines.some((line) => line.child_mode === 'version' && line.child_version_id && !(line.child_version_id in childCosts));
    if (pending) { command.setError('正在汇总引用BOM成本，请稍后再保存'); return; }
    const priced: EditorLine[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const cost = scaleCost(shownCost(line));
      if (cost === null) { command.setError(`第${index + 1}行成本单价格式不正确`); return; }
      priced.push({ ...line, cost_price: cost });
    }
    const message = validateBomDraft({ parent, name: header.name, lines: priced, routeVersionId: route?.current_version_id ?? '', steps: steps.data?.steps ?? [] });
    if (message) { command.setError(message); command.setFieldError('name', message); return; }
    const extErr = extForm.error();
    if (extErr) { command.setError(extErr); return; }
    try {
      const saved = await command.send<{ bom: Bom }>(id ? `/api/boms/${id}/versions` : '/api/boms', { ...bomSavePayload({ existing: !!id, parent, name: header.name, description: header.note, routeVersionId: route?.current_version_id ?? '', lines: priced, expected_version: detail.data?.bom.version }), request_key: requestKey() });
      const bomId = id ?? (saved?.bom ? idText(saved.bom.id) : '');
      if (bomId) {
        await command.send(`/api/boms/${bomId}/extras`, { code: header.code.trim() || null, name: header.name.trim() || null, category: header.category.trim() || null, is_default: header.is_default, note: header.note.trim() || null }, 'PUT');
        await extForm.persist(command.session.csrf_token, bomId);
      }
      navigate('/bom/list');
    } catch (failure) { command.setError(showError(failure)); }
  }
  const categoryOptions = (categories.data?.items ?? []).map((item) => ({ value: item.name, label: item.name }));
  if (header.category && !categoryOptions.some((item) => item.value === header.category)) categoryOptions.unshift({ value: header.category, label: header.category });
  const parentOptions = catalog.filter((item) => item.attribute === 'manufactured').map((item) => ({ value: String(item.id), label: item.name }));
  if (parent && !parentOptions.some((item) => item.value === parent)) parentOptions.unshift({ value: parent, label: findProduct(parent)?.name || parent });
  const stepOptions = (steps.data?.steps ?? []).map((step) => ({ value: step.process_id, label: step.process_name }));
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => navigate('/bom/list')}>返回</Button><Button type="primary" loading={command.busy} onClick={() => void save()}>{id ? '发布新版本' : '保存'}</Button></div>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <div className="kgd-form">
      <span>BOM编号</span><Input value={header.code} placeholder="请填写，忽略将自动生成" onChange={(event) => setHeader((current) => ({ ...current, code: event.target.value }))} />
      <span className={command.fieldErrors.name ? 'kgd-field-error-label' : undefined}>BOM名称 *</span><div className={command.fieldErrors.name ? 'kgd-field-error' : undefined}><Input value={header.name} onChange={(event) => setHeader((current) => ({ ...current, name: event.target.value }))} />{command.fieldErrors.name ? <div className="kgd-field-help">{command.fieldErrors.name}</div> : null}</div>
      <span>类别</span><Select allowClear showSearch optionFilterProp="label" value={header.category || undefined} placeholder="BOM配比类别" onChange={(value) => setHeader((current) => ({ ...current, category: value ?? '' }))} options={categoryOptions} />
      <span>商品</span><Select allowClear showSearch optionFilterProp="label" disabled={!!id} value={parent || undefined} onChange={(value) => setParent(value ?? '')} options={parentOptions} />
      <span>设为默认BOM</span><Switch checked={header.is_default} onChange={(checked) => setHeader((current) => ({ ...current, is_default: checked }))} />
      <span>备注</span><Input value={header.note} onChange={(event) => setHeader((current) => ({ ...current, note: event.target.value }))} />
      <span>成本总额</span><Input disabled value={costTotal} />
      <span>绑定路线</span><Select allowClear value={routeId || undefined} onChange={(value) => setRouteId(value ?? '')} options={(routes.data?.items ?? []).map((item) => ({ value: item.current_version_id, label: item.name }))} />
      {extForm.node}
    </div>
    <div className="kgd-toolbar">
      <Button type="primary" onClick={() => setPickOpen(true)}>选择商品</Button>
      <Button disabled={command.busy} onClick={() => void createChildBoms()}>创建BOM</Button>
      <Button onClick={() => { setLines([]); setPickedLines([]); }}>清空</Button>
    </div>
    <Table<EditorLine> size="small" pagination={false} scroll={{ x: 1500 }} rowKey={(_, index) => String(index)} dataSource={lines}
      rowSelection={{ selectedRowKeys: pickedLines, onChange: (keys) => setPickedLines(keys.map(String)) }}
      columns={[
        { title: '序号', width: 60, render: (_, __, index) => (index ?? 0) + 1 },
        { title: '商品名', render: (_, row) => row.product_name || findProduct(row.component_product_id)?.name || '' },
        { title: '编号', render: (_, row) => row.product_code || findProduct(row.component_product_id)?.code || '' },
        { title: '规格', render: (_, row) => row.specification || findProduct(row.component_product_id)?.specification || '' },
        { title: '商品来源', render: (_, row) => row.source || sourceLabel(findProduct(row.component_product_id)?.attribute) },
        { title: '投料工序', render: (_, row, index) => <Select allowClear style={{ width: 140 }} value={row.feeding_process_id || undefined} onChange={(value) => patch(index, { feeding_process_id: value ?? '' })} options={stepOptions} /> },
        { title: '入库工序', render: (_, row, index) => <Select allowClear style={{ width: 140 }} value={row.inbound_process_id || undefined} onChange={(value) => patch(index, { inbound_process_id: value ?? '' })} options={stepOptions} /> },
        { title: '单位用量 *', render: (_, row, index) => <Input value={row.quantity} onChange={(event) => patch(index, { quantity: event.target.value })} /> },
        { title: '损耗率', render: (_, row, index) => <Input value={row.loss_rate} onChange={(event) => patch(index, { loss_rate: event.target.value })} /> },
        { title: '成本单价', render: (_, row, index) => {
          const locked = row.child_mode === 'version' && !!row.child_version_id;
          return <Input disabled={locked} value={shownCost(row)} onChange={(event) => patch(index, { cost_price: event.target.value })} />;
        } },
        { title: '成本金额', render: (_, __, index) => amounts[index] || '' },
        { title: '单位', render: (_, row) => row.unit_name || findProduct(row.component_product_id)?.unit_name || '' },
        { title: '引用BOM', width: 180, render: (_, row, index) => {
          const refs = (boms.data?.items ?? []).filter((item) => item.parent_product_id === row.component_product_id && item.current_version_id);
          const options = refs.map((item) => ({ value: item.current_version_id, label: `${item.name || item.parent_name}${item.is_default ? '（默认）' : ''}` }));
          if (row.child_version_id && !options.some((item) => item.value === row.child_version_id)) options.unshift({ value: row.child_version_id, label: '已引用版本' });
          return <Select allowClear style={{ width: 160 }} value={row.child_mode === 'version' ? row.child_version_id || undefined : undefined} options={options} onChange={(value) => {
            const product = findProduct(row.component_product_id);
            patch(index, { child_mode: value ? 'version' : 'leaf', child_version_id: value ?? '', cost_price: value ? '' : (row.product_cost || product?.cost_price || '') });
          }} />;
        } },
        { title: '操作', render: (_, __, index) => <Button type="link" onClick={() => setLines((current) => current.filter((_, itemIndex) => itemIndex !== index))}>删除</Button> },
      ]} />
    <ProductPicker open={pickOpen} onClose={() => setPickOpen(false)} onPick={(rows) => {
      setLines((current) => [...current, ...rows.map((row) => {
        const productId = String(row.id);
        const versionId = defaultVersion(productId);
        const attribute = String(row.attribute ?? '');
        return {
          component_product_id: productId,
          quantity: '1',
          loss_rate: '0',
          feeding_process_id: '',
          inbound_process_id: '',
          cost_price: versionId ? '' : String(row.cost_price ?? ''),
          auto_issue: false,
          child_mode: versionId ? 'version' as const : 'leaf' as const,
          child_version_id: versionId,
          product_name: String(row.name ?? ''),
          product_code: String(row.code ?? ''),
          specification: String(row.specification ?? ''),
          unit_name: String(row.unit_name ?? ''),
          source: sourceLabel(attribute),
          product_cost: String(row.cost_price ?? ''),
        };
      })]);
    }} />
  </div>;
}
