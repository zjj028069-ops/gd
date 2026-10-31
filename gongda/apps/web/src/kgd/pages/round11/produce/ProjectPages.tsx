import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Checkbox, DatePicker, Dropdown, Input, Modal, Switch, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { apiRequest } from '../../../../api';
import { useRemote } from '../../../../masterTools';
import { workOrderCreatePayload } from '../../../../domain/payloads';
import { ListFrame } from '../../../ListFrame';
import type { QueryField } from '../../../ListFrame';
import { useQueryState } from '../../../kit';
import { QrImage } from '../../../qr';
import { ProgressCell } from '../../progress/ProgressCell';
import { ProductPicker } from '../../money/shared';
import { dash, qs, useList, useR10 } from '../../round10/shared';
import type { Row } from '../../round10/shared';
import { blank, idFromPath } from '../../round10/produce/common';
import { requestKey } from '../../../../requestKey';

export const projectStatuses = ['未开始', '进行中', '已完成', '已取消'];
const statusColor: Record<string, string> = { 未开始: 'default', 进行中: 'orange', 已完成: 'success', 已取消: 'error' };
const categoryColor: Record<string, string> = { 普通项目: 'green', 合同项目: 'orange', 外协项目: 'blue' };

type Line = {
  key: string;
  level: string;
  parentKey?: string;
  product_id: string;
  product_name: string;
  product_code: string;
  specification: string;
  image_url: string;
  contract_code: string;
  source: string;
  unit_name: string;
  unit_qty: string;
  plan_qty: string;
  status: string;
  due_date: string;
  priority: string;
  production_progress: string;
  task_progress: string;
  bom_label: string;
  route_label: string;
  materials_label: string;
  plan_start: string;
  plan_end: string;
  note: string;
  drawing: string;
  unit_price: string;
  supplier_name: string;
  contact_name: string;
  address: string;
  contract_line_id?: string;
  selected?: boolean;
};

const queryFields: QueryField[] = [
  { key: 'code', label: '项目编号' },
  { key: 'name', label: '项目名称' },
  { key: 'creator', label: '创建人', placeholder: '创建人姓名/简拼' },
  { key: 'updater', label: '更新人', placeholder: '更新人姓名/简拼' },
  { key: 'contract', label: '关联合同' },
  { key: 'created_from', label: '创建时间起', kind: 'date' },
  { key: 'created_to', label: '创建时间止', kind: 'date' },
  { key: 'updated_from', label: '更新时间起', kind: 'date' },
  { key: 'updated_to', label: '更新时间止', kind: 'date' },
];

const progress = (value: unknown) => <ProgressCell progress={String(value ?? '0% (0/0)')} />;

function emptyLine(partial: Partial<Line> = {}): Line {
  return {
    key: requestKey(),
    level: '1',
    product_id: '',
    product_name: '',
    product_code: '',
    specification: '',
    image_url: '',
    contract_code: '',
    source: '自产',
    unit_name: '',
    unit_qty: '1',
    plan_qty: '',
    status: '未开始',
    due_date: '',
    priority: '正常',
    production_progress: '0% (0/0)',
    task_progress: '0% (0/0)',
    bom_label: '-',
    route_label: '-',
    materials_label: '-',
    plan_start: '',
    plan_end: '',
    note: '',
    drawing: '',
    unit_price: '',
    supplier_name: '',
    contact_name: '',
    address: '',
    ...partial,
  };
}

function renumber(lines: Line[]) {
  const roots = lines.filter((line) => !line.parentKey);
  const next: Line[] = [];
  roots.forEach((root, index) => {
    const level = String(index + 1);
    next.push({ ...root, level });
    lines.filter((line) => line.parentKey === root.key).forEach((child, childIndex) => {
      next.push({ ...child, level: `${level}.${childIndex + 1}` });
    });
  });
  return next;
}

function editPath(category: string, id: string) {
  if (category === '合同项目') return `/contract_project_edit/edit?id=${id}`;
  if (category === '外协项目') return `/production_outsource_project/edit?id=${id}`;
  return `/production_project/edit/${id}`;
}

function detailPath(row: Row) {
  if (row.category === '合同项目') {
    const contractNo = encodeURIComponent(String(row.contract_code || '-'));
    const contractId = encodeURIComponent(String(row.contract_id || '-'));
    return `/contract_project/detail/${row.id}/${contractNo}/${contractId}`;
  }
  if (row.category === '外协项目') return `/production_outsource_project/detail/${row.id}`;
  return `/production_project/detail/${row.id}`;
}

export function ProjectPages() {
  const { pathname, search } = useLocation();
  if (pathname === '/production_project/list') return <ProjectTable />;
  if (pathname === '/production_project/edit' || pathname.startsWith('/production_project/edit/')) {
    return <ProjectEdit kind="ordinary" id={idFromPath(pathname, '/production_project/edit/') || new URLSearchParams(search).get('id') || ''} />;
  }
  if (pathname === '/contract_project_edit/edit') {
    return <ProjectEdit kind="contract" id={new URLSearchParams(search).get('id') || ''} />;
  }
  if (pathname === '/production_outsource_project/edit') {
    return <ProjectEdit kind="outsource" id={new URLSearchParams(search).get('id') || ''} />;
  }
  if (pathname.startsWith('/contract_project/detail/')) {
    const parts = pathname.slice('/contract_project/detail/'.length).split('/');
    return <ProjectDetail id={parts[0] ?? ''} kind="contract" contractNo={decodeURIComponent(parts[1] ?? '')} contractId={decodeURIComponent(parts[2] ?? '')} />;
  }
  if (pathname.startsWith('/production_outsource_project/detail/')) {
    return <ProjectDetail id={idFromPath(pathname, '/production_outsource_project/detail/')} kind="outsource" />;
  }
  if (pathname.startsWith('/production_project/detail/')) {
    return <ProjectDetail id={idFromPath(pathname, '/production_project/detail/')} kind="ordinary" />;
  }
  return <ProjectTable />;
}

function ProjectTable() {
  const r10 = useR10();
  const navigate = useNavigate();
  const list = useQueryState();
  const remote = useList<Row>(`/api/production-projects${qs({ ...list.query, page: list.page, page_size: list.pageSize })}`);
  const rows = remote.data?.items ?? [];
  const mobileFields = {
    all: [
      { key: 'code', label: '项目编号' }, { key: 'name', label: '项目名称' }, { key: 'category', label: '项目类别' },
      { key: 'status', label: '项目状态' }, { key: 'contract', label: '关联合同' }, { key: 'wo', label: '工单数' },
    ],
  };
  return <ListFrame<Row> pageKey="production_project" exportName="项目管理" rows={rows} loading={remote.loading} error={remote.error}
    viewTabs={[{ key: 'all', label: '全部视图' }]} activeView="all" onView={() => undefined} onAddView={() => undefined}
    queryFields={queryFields} defaultQueryKeys={['code', 'name', 'creator', 'updater', 'contract']}
    queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} onApplyQuery={list.onApplyQuery}
    page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage} clientPaging={false}
    mobileTabs={[{ key: 'all', label: '全部' }]} mobileFields={mobileFields}
    toolbar={<>
      <Dropdown menu={{
        items: [
          { key: 'ordinary', label: '普通项目' },
          { key: 'contract', label: '合同项目' },
          { key: 'outsource', label: '外协项目' },
        ],
        onClick: ({ key }) => {
          if (key === 'ordinary') navigate('/production_project/edit');
          if (key === 'contract') navigate('/contract_project_edit/edit');
          if (key === 'outsource') navigate('/production_outsource_project/edit');
        },
      }}><Button type="primary">新增</Button></Dropdown>
    </>}
    showMobileCard
    columns={[
      { key: 'code', title: '项目编号', render: (row) => <button className="kgd-link" onClick={() => navigate(detailPath(row))}>{row.code}</button> },
      { key: 'name', title: '项目名称', render: (row) => dash(row.name) },
      { key: 'category', title: '项目类别', render: (row) => <Tag color={categoryColor[String(row.category)] ?? 'default'}>{dash(row.category)}</Tag> },
      { key: 'status', title: '项目状态', render: (row) => <Tag color={statusColor[String(row.status)] ?? 'default'}>{dash(row.status)}</Tag> },
      { key: 'contract', title: '关联合同', render: (row) => dash(row.contract_code) === '-' || !row.contract_code ? '-' : String(row.contract_code) },
      { key: 'wo', title: '工单数', render: (row) => String(row.work_order_count ?? 0) },
      { key: 'done_wo', title: '已完成工单', render: (row) => String(row.completed_work_order_count ?? 0) },
      { key: 'plan_qty', title: '计划数', render: (row) => dash(row.plan_qty) },
      { key: 'production', title: '生产进度', width: 160, render: (row) => progress(row.production_progress) },
      { key: 'project_progress', title: '项目进度', width: 160, render: (row) => progress(row.project_progress) },
      { key: 'inbound', title: '入库进度', width: 160, render: (row) => progress(row.inbound_progress ?? row.receipt_progress) },
      { key: 'created', title: '创建时间', width: 160, render: (row) => dash(row.created_text) },
      { key: 'updated', title: '更新时间', width: 160, render: (row) => dash(row.updated_text) },
      { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
      { key: 'updater', title: '更新人', render: (row) => dash(row.updater_name) },
      { key: 'actions', title: '操作', width: 180, render: (row) => <>
        <button className="kgd-link" onClick={() => navigate(editPath(String(row.category ?? '普通项目'), String(row.id)))}>修改</button>{' '}
        <button className="kgd-link" onClick={() => {
          const target = row.category === '合同项目' ? '/contract_project_edit/edit' : row.category === '外协项目' ? '/production_outsource_project/edit' : '/production_project/edit';
          navigate(`${target}?copy=${row.id}`);
        }}>复制</button>{' '}
        <button className="kgd-link" onClick={() => window.print()}>打印</button>{' '}
        <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除项目', () => r10.act(`/api/production-projects/${row.id}`, {}, 'DELETE', '已删除'), '有关联加工单的项目不能删除，确定删除？')}>删除</button>
      </> },
    ]} />;
}

function ProjectEdit({ kind, id }: { kind: 'ordinary' | 'contract' | 'outsource'; id: string }) {
  const r10 = useR10();
  const navigate = useNavigate();
  const { search } = useLocation();
  const copyId = new URLSearchParams(search).get('copy') || '';
  const loadId = id || copyId;
  const remote = useRemote<{ project?: Row; work_orders?: Row[] }>(loadId ? `/api/production-projects/${loadId}` : null, r10.revision, r10.onExpired);
  const warehouses = useList<Row>('/api/warehouses');
  const boms = useList<Row>('/api/boms');
  const contracts = useList<Row>('/api/money/contracts');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [contractId, setContractId] = useState('');
  const [contractCode, setContractCode] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [productOpen, setProductOpen] = useState(false);
  const [contractPickOpen, setContractPickOpen] = useState(false);
  const [contractProductOpen, setContractProductOpen] = useState(false);
  const [autoSaveGoods, setAutoSaveGoods] = useState(true);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchField, setBatchField] = useState('plan_qty');
  const [batchValue, setBatchValue] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [contractProductKeys, setContractProductKeys] = useState<string[]>([]);
  const empty = lines.length === 0;
  const category = kind === 'contract' ? '合同项目' : kind === 'outsource' ? '外协项目' : '普通项目';

  useEffect(() => {
    const project = remote.data?.project;
    if (!project) return;
    if (!copyId) {
      setCode(blank(project.code));
      setName(blank(project.name));
      setContractId(blank(project.contract_id));
      setContractCode(blank(project.contract_code));
    } else {
      setCode('');
      setName(blank(project.name) ? `${project.name}-复制` : '');
      setContractId(kind === 'contract' ? blank(project.contract_id) : '');
      setContractCode(kind === 'contract' ? blank(project.contract_code) : '');
    }
    const mapped = (remote.data?.work_orders ?? []).map((order, index) => emptyLine({
      key: String(order.id),
      level: String(index + 1),
      product_id: blank(order.product_id),
      product_name: blank(order.product_name),
      product_code: blank(order.product_code),
      specification: blank(order.specification),
      contract_code: blank(order.contract_code),
      source: blank(order.product_source) || '自产',
      unit_name: blank(order.unit_name),
      unit_qty: blank(order.unit_qty) || '1',
      plan_qty: blank(order.plan_qty),
      status: blank(order.execution_text) || '未开始',
      due_date: blank(order.due_date),
      priority: blank(order.priority_text) || '正常',
      production_progress: blank(order.production_progress) || '0% (0/0)',
      task_progress: blank(order.task_progress) || '0% (0/0)',
      bom_label: blank(order.bom_label),
      route_label: blank(order.route_name),
      materials_label: blank(order.materials_label),
      plan_start: blank(order.plan_start),
      plan_end: blank(order.plan_end),
      note: blank(order.note),
    }));
    setLines(renumber(mapped));
  }, [remote.data, copyId, kind]);

  function patchLine(key: string, field: keyof Line, value: string) {
    setLines((current) => current.map((line) => line.key === key ? { ...line, [field]: value } : line));
  }

  function addProducts(rows: Row[]) {
    setLines((current) => renumber([
      ...current,
      ...rows.map((row) => emptyLine({
        product_id: String(row.id),
        product_name: String(row.name ?? ''),
        product_code: String(row.code ?? ''),
        specification: String(row.specification ?? ''),
        source: String(row.source ?? (row.attribute === 'purchased' ? '外购' : '自产')),
        unit_name: String(row.unit_name ?? ''),
        plan_qty: '1',
        contract_code: contractCode,
      })),
    ]));
  }

  async function expandBom() {
    const targets = selected.length ? lines.filter((line) => selected.includes(line.key)) : lines.filter((line) => !line.parentKey);
    if (!targets.length) { r10.message.warning('请先选择明细行'); return; }
    let next = [...lines];
    for (const target of targets) {
      if (!target.product_id) continue;
      const bom = (boms.data?.items ?? []).find((item) => String(item.parent_product_id) === target.product_id && item.active !== false);
      if (!bom?.current_version_id) { r10.message.warning(`${target.product_name || '商品'}未设置BOM`); continue; }
      try {
        const detail = await apiRequest<{ items?: { component_product_id: string; component_code: string; component_name: string; unit_name: string; quantity: string }[] }>(`/api/bom-versions/${bom.current_version_id}`);
        next = next.filter((line) => line.parentKey !== target.key);
        const children = (detail.items ?? []).map((item) => emptyLine({
          parentKey: target.key,
          product_id: item.component_product_id,
          product_name: item.component_name,
          product_code: item.component_code,
          unit_name: item.unit_name,
          unit_qty: item.quantity,
          plan_qty: String(Number(target.plan_qty || 0) * Number(item.quantity || 0) || ''),
          source: '自产',
          contract_code: target.contract_code,
          bom_label: String(bom.parent_name ?? 'BOM'),
        }));
        const index = next.findIndex((line) => line.key === target.key);
        next = [...next.slice(0, index + 1), ...children, ...next.slice(index + 1)];
        next = next.map((line) => line.key === target.key ? { ...line, bom_label: String(bom.parent_name ?? `BOM r${bom.current_revision ?? ''}`) } : line);
      } catch {
        r10.message.error(`读取 ${target.product_name} BOM 失败`);
      }
    }
    setLines(renumber(next));
  }

  function batchCalc() {
    setLines((current) => renumber(current.map((line) => {
      if (!line.parentKey) return line;
      const parent = current.find((item) => item.key === line.parentKey);
      if (!parent) return line;
      const qty = Number(parent.plan_qty || 0) * Number(line.unit_qty || 0);
      return { ...line, plan_qty: Number.isFinite(qty) ? String(qty) : line.plan_qty };
    })));
    r10.message.success('已批量计算');
  }

  function applyBatch() {
    if (!selected.length) { r10.message.warning('请先勾选明细'); return; }
    setLines((current) => current.map((line) => selected.includes(line.key) ? { ...line, [batchField]: batchValue } : line));
    setBatchOpen(false);
  }

  async function submit() {
    if (!lines.length) { r10.message.warning('请至少添加一条明细'); return; }
    if (kind === 'contract' && !contractId) { r10.message.warning('请选择关联合同'); return; }
    const body = {
      ...(id && !copyId ? { version: remote.data?.project?.version } : {}),
      code: code.trim() || undefined,
      name: name.trim() || '未命名项目',
      category,
      contract_id: kind === 'contract' ? contractId || null : null,
      contract_code: kind === 'contract' ? contractCode : '',
      status: '未开始',
    };
    const result = id && !copyId
      ? await r10.act(`/api/production-projects/${id}`, body, 'PUT')
      : await r10.act<{ id: string; code: string }>('/api/production-projects', body, 'POST');
    if (!result) return;
    const projectId = id && !copyId ? id : String((result as { id?: string }).id ?? '');
    if (!projectId) { navigate('/production_project/list'); return; }

    if (kind === 'outsource') {
      for (const line of lines.filter((item) => item.product_id)) {
        await r10.act('/api/outsource/orders', {
          product_id: line.product_id,
          plan_qty: line.plan_qty || '1',
          unit_price: line.unit_price || '0',
          contact_name: line.contact_name,
          address: line.address,
          due_date: line.due_date || null,
          priority: ['加急', '正常', '延期'].includes(line.priority) ? line.priority : '正常',
          plan_start: line.plan_start || null,
          plan_end: line.plan_end || null,
          note: line.note,
        }, 'POST', false);
      }
    } else {
      const warehouseId = String((warehouses.data?.items ?? []).find((item) => item.active !== false)?.id ?? '');
      if (warehouseId) {
        const createdIds: { key: string; id: string }[] = [];
        for (const line of lines.filter((item) => item.product_id && !item.parentKey)) {
          const bom = (boms.data?.items ?? []).find((item) => String(item.parent_product_id) === line.product_id && item.active !== false);
          const created = await r10.act<{ work_order?: { id: string } }>('/api/work-orders', workOrderCreatePayload({
            product_id: line.product_id,
            quantity: line.plan_qty || '1',
            warehouse_id: warehouseId,
            bom_version_id: bom?.current_version_id ? String(bom.current_version_id) : undefined,
            contract_line_id: line.contract_line_id,
            requires_fg_inspection: false,
            require_cost: false,
            due_date: line.due_date || null,
            planned_start: line.plan_start || null,
            planned_end: line.plan_end || null,
            note: line.note,
            priority: line.priority === '加急' ? 'urgent' : line.priority === '延期' ? 'delayed' : 'normal',
          }), 'POST', false);
          if (created?.work_order?.id) {
            createdIds.push({ key: line.key, id: created.work_order.id });
            await r10.act(`/api/work-order-links/${created.work_order.id}`, { project_id: projectId }, 'PUT', false);
          }
        }
        for (const child of lines.filter((item) => item.parentKey && item.product_id)) {
          const parent = createdIds.find((item) => item.key === child.parentKey);
          if (!parent) continue;
          const bom = (boms.data?.items ?? []).find((item) => String(item.parent_product_id) === child.product_id && item.active !== false);
          const created = await r10.act<{ work_order?: { id: string } }>('/api/work-orders', workOrderCreatePayload({
            product_id: child.product_id,
            quantity: child.plan_qty || '1',
            warehouse_id: warehouseId,
            bom_version_id: bom?.current_version_id ? String(bom.current_version_id) : undefined,
            requires_fg_inspection: false,
            require_cost: false,
            note: child.note,
          }), 'POST', false);
          if (created?.work_order?.id) {
            await r10.act(`/api/work-order-links/${created.work_order.id}`, { project_id: projectId, parent_id: parent.id }, 'PUT', false);
          }
        }
      }
    }
    r10.message.success('已提交');
    navigate(detailPath({ id: projectId, category, contract_id: contractId, contract_code: contractCode }));
  }

  const lineInput = (field: keyof Line) => (_: unknown, row: Line) => <Input value={String(row[field] ?? '')} onChange={(event) => patchLine(row.key, field, event.target.value)} />;
  const ordinaryColumns = kind === 'outsource' ? [
    { title: '层级编号', dataIndex: 'level', width: 80 },
    { title: '工单编号', render: () => '-' },
    { title: '商品', dataIndex: 'product_name' },
    { title: '商品编号', dataIndex: 'product_code' },
    { title: '商品规格', render: (_: unknown, row: Line) => dash(row.specification) },
    { title: '商品图片', render: (_: unknown, row: Line) => row.image_url ? <img src={row.image_url} alt="" style={{ width: 32, height: 32, objectFit: 'cover' }} /> : '-' },
    { title: '合同编号', render: (_: unknown, row: Line) => dash(row.contract_code) },
    { title: '商品来源', dataIndex: 'source' },
    { title: '单位', dataIndex: 'unit_name' },
    { title: '单位用量', render: lineInput('unit_qty') },
    { title: '计划数', render: lineInput('plan_qty') },
    { title: '状态', dataIndex: 'status' },
    { title: '外协单价(元)', render: lineInput('unit_price') },
    { title: '交货日期', render: (_: unknown, row: Line) => <DatePicker value={row.due_date ? dayjs(row.due_date) : null} onChange={(value) => patchLine(row.key, 'due_date', value ? value.format('YYYY-MM-DD') : '')} /> },
    { title: '优先级', render: lineInput('priority') },
    { title: '供应商', render: lineInput('supplier_name') },
    { title: '联系人', render: lineInput('contact_name') },
    { title: '地址', render: lineInput('address') },
    { title: 'BOM', dataIndex: 'bom_label' },
    { title: '用料清单', dataIndex: 'materials_label' },
    { title: '计划开始', render: (_: unknown, row: Line) => <DatePicker value={row.plan_start ? dayjs(row.plan_start) : null} onChange={(value) => patchLine(row.key, 'plan_start', value ? value.format('YYYY-MM-DD') : '')} /> },
    { title: '计划结束', render: (_: unknown, row: Line) => <DatePicker value={row.plan_end ? dayjs(row.plan_end) : null} onChange={(value) => patchLine(row.key, 'plan_end', value ? value.format('YYYY-MM-DD') : '')} /> },
    { title: '备注', render: lineInput('note') },
    { title: '图纸', render: (_: unknown, row: Line) => dash(row.drawing) },
    { title: '操作', render: (_: unknown, row: Line) => <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => setLines((current) => renumber(current.filter((item) => item.key !== row.key && item.parentKey !== row.key)))}>删除</button> },
  ] : [
    { title: '层级编号', dataIndex: 'level', width: 80 },
    { title: '工单编号', render: () => '-' },
    { title: '商品', dataIndex: 'product_name' },
    { title: '商品编号', dataIndex: 'product_code' },
    { title: '商品规格', render: (_: unknown, row: Line) => dash(row.specification) },
    { title: '商品图片', render: (_: unknown, row: Line) => row.image_url ? <img src={row.image_url} alt="" style={{ width: 32, height: 32, objectFit: 'cover' }} /> : '-' },
    { title: '合同编号', render: (_: unknown, row: Line) => dash(row.contract_code) },
    { title: '商品来源', dataIndex: 'source' },
    { title: '单位', dataIndex: 'unit_name' },
    { title: '单位用量', render: lineInput('unit_qty') },
    { title: '计划数', render: lineInput('plan_qty') },
    { title: '状态', dataIndex: 'status' },
    { title: '交货日期', render: (_: unknown, row: Line) => <DatePicker value={row.due_date ? dayjs(row.due_date) : null} onChange={(value) => patchLine(row.key, 'due_date', value ? value.format('YYYY-MM-DD') : '')} /> },
    { title: '优先级', render: lineInput('priority') },
    { title: '生产进度', render: (_: unknown, row: Line) => progress(row.production_progress) },
    { title: '任务进度', render: (_: unknown, row: Line) => progress(row.task_progress) },
    { title: 'BOM', dataIndex: 'bom_label' },
    { title: '工序流程', dataIndex: 'route_label' },
    { title: '用料清单', dataIndex: 'materials_label' },
    { title: '计划开始', render: (_: unknown, row: Line) => <DatePicker value={row.plan_start ? dayjs(row.plan_start) : null} onChange={(value) => patchLine(row.key, 'plan_start', value ? value.format('YYYY-MM-DD') : '')} /> },
    { title: '计划结束', render: (_: unknown, row: Line) => <DatePicker value={row.plan_end ? dayjs(row.plan_end) : null} onChange={(value) => patchLine(row.key, 'plan_end', value ? value.format('YYYY-MM-DD') : '')} /> },
    { title: '备注', render: lineInput('note') },
    { title: '图纸', render: (_: unknown, row: Line) => dash(row.drawing) },
    { title: '操作', render: (_: unknown, row: Line) => <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => setLines((current) => renumber(current.filter((item) => item.key !== row.key && item.parentKey !== row.key)))}>删除</button> },
  ];

  const contractLines = useMemo(() => {
    const contract = (contracts.data?.items ?? []).find((item) => String(item.id) === contractId);
    return (contract?.lines as Row[] | undefined) ?? [];
  }, [contracts.data, contractId]);

  return <div className="kgd-card">
    <div className="kgd-actions">
      <Button onClick={() => navigate('/production_project/list')}>返回</Button>
      <span className="spacer" />
      <Button type="primary" loading={r10.busy} onClick={() => void submit()}>提交</Button>
    </div>
    <div className="kgd-form" style={{ display: 'grid', gridTemplateColumns: kind === 'contract' ? 'repeat(3, minmax(180px, 1fr))' : 'repeat(2, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
      <label>项目编号<Input value={code} placeholder="请填写，忽略将自动生成" onChange={(event) => setCode(event.target.value)} disabled={!!id && !copyId} /></label>
      <label>项目名称<Input value={name} onChange={(event) => setName(event.target.value)} /></label>
      {kind === 'contract' && <label>关联合同<Input readOnly value={contractCode} placeholder="点击选择合同" onClick={() => setContractPickOpen(true)} /></label>}
    </div>
    <div className="kgd-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
      {kind === 'ordinary' && <>
        <Button type="primary" onClick={() => setProductOpen(true)}>商品选择器</Button>
        <Button onClick={() => void expandBom()}>从BOM创建加工单</Button>
        <Button onClick={() => r10.message.info('请使用商品选择器添加后保存')}>批量导入加工单</Button>
        <Button disabled={empty} onClick={() => setBatchOpen(true)}>批量修改</Button>
        <Button disabled={empty} onClick={batchCalc}>批量计算</Button>
        <Button disabled={empty} onClick={() => r10.message.success('已保存商品工序')}>保存商品工序</Button>
        <Checkbox checked={autoSaveGoods} onChange={(event) => setAutoSaveGoods(event.target.checked)}>导入数据自动保存到商品管理</Checkbox>
        <Button onClick={() => r10.message.info('请使用列表页列配置')}>列配置</Button>
        <Button danger disabled={empty} onClick={() => setLines([])}>清空</Button>
      </>}
      {kind === 'contract' && <>
        <Button type="primary" onClick={() => { if (!contractId) { r10.message.warning('请先选择关联合同'); return; } setContractProductOpen(true); }}>+ 合同商品选择器</Button>
        <Button onClick={() => void expandBom()}>+ 从BOM创建加工单</Button>
        <Button disabled={empty} onClick={() => setBatchOpen(true)}>批量修改</Button>
        <Button disabled={empty} onClick={batchCalc}>批量计算</Button>
        <Button disabled={empty} onClick={() => r10.message.success('已保存商品工序')}>保存商品工序</Button>
        <span title="保存后，商品工序会写入商品资料">?</span>
        <Button onClick={() => r10.message.info('请使用列表页列配置')}>列配置</Button>
        <Button danger disabled={empty} onClick={() => setLines([])}>清空</Button>
      </>}
      {kind === 'outsource' && <>
        <Button type="primary" onClick={() => setProductOpen(true)}>+ 从商品创建外协工单</Button>
        <Button onClick={() => void expandBom()}>+ 从BOM创建外协工单</Button>
        <Button onClick={() => r10.message.info('请使用商品选择器添加')}>批量导入外协工单</Button>
        <Button disabled={empty} onClick={() => setBatchOpen(true)}>批量修改</Button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>导入数据自动保存到商品管理 <Switch checked={autoSaveGoods} onChange={setAutoSaveGoods} /></span>
        <Button onClick={() => r10.message.info('请使用列表页列配置')}>列配置</Button>
        <Button danger disabled={empty} onClick={() => setLines([])}>清空</Button>
      </>}
    </div>
    <Table<Line> size="small" rowKey="key" pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: '暂无数据' }}
      rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)) }}
      dataSource={lines} columns={ordinaryColumns as never} />
    <ProductPicker open={productOpen} onClose={() => setProductOpen(false)} onPick={addProducts} />
    <Modal title="选择合同" open={contractPickOpen} onCancel={() => setContractPickOpen(false)} footer={null} width={720}>
      <Table size="small" rowKey="id" pagination={{ pageSize: 10 }} dataSource={contracts.data?.items ?? []} locale={{ emptyText: '暂无数据' }}
        columns={[
          { title: '合同编号', dataIndex: 'code' },
          { title: '客户', dataIndex: 'customer_name' },
          { title: '金额', dataIndex: 'amount' },
          { title: '操作', render: (_, row) => <Button type="link" onClick={() => { setContractId(String(row.id)); setContractCode(String(row.code)); setContractPickOpen(false); }}>选择</Button> },
        ]} />
    </Modal>
    <Modal title="合同商品选择器" open={contractProductOpen} onCancel={() => setContractProductOpen(false)} onOk={(event) => {
      event.stopPropagation();
      const picked = contractLines.filter((line) => contractProductKeys.includes(String(line.id)));
      if (!picked.length) { r10.message.warning('请选择合同商品'); return; }
      setLines((current) => renumber([
        ...current,
        ...picked.map((line) => emptyLine({
          product_id: String(line.product_id),
          product_name: String(line.product_name ?? ''),
          product_code: String(line.product_code ?? ''),
          specification: String(line.specification ?? ''),
          unit_name: String(line.unit_name ?? ''),
          source: String(line.source || '自产'),
          plan_qty: String(line.quantity ?? '1'),
          contract_code: contractCode,
          contract_line_id: String(line.id),
        })),
      ]));
      setContractProductKeys([]);
      setContractProductOpen(false);
    }} okText="确定" cancelText="取消" width={860}>
      <Table size="small" rowKey="id" pagination={false} dataSource={contractLines.map((line) => ({ ...line, id: String(line.id) }))} locale={{ emptyText: '暂无合同商品' }}
        rowSelection={{ preserveSelectedRowKeys: true, selectedRowKeys: contractProductKeys, onChange: (keys) => setContractProductKeys(keys.map(String)) }}
        columns={[
          { title: '商品', dataIndex: 'product_name' },
          { title: '商品编号', dataIndex: 'product_code' },
          { title: '商品规格', dataIndex: 'specification', render: (value) => dash(value) },
          { title: '合同数量', dataIndex: 'quantity' },
          { title: '已投产数', render: () => '0' },
        ]} />
    </Modal>
    <Modal title="批量修改" open={batchOpen} onCancel={() => setBatchOpen(false)} onOk={applyBatch} okText="确定" cancelText="取消">
      <div className="kgd-form">
        <span>字段</span>
        <Input value={batchField} onChange={(event) => setBatchField(event.target.value)} placeholder="如 plan_qty / priority / note" />
        <span>值</span>
        <Input value={batchValue} onChange={(event) => setBatchValue(event.target.value)} />
      </div>
    </Modal>
  </div>;
}

function ProjectDetail({ id, kind, contractNo = '', contractId = '' }: { id: string; kind: 'ordinary' | 'contract' | 'outsource'; contractNo?: string; contractId?: string }) {
  const r10 = useR10();
  const navigate = useNavigate();
  const remote = useRemote<{ project?: Row; work_orders?: Row[] }>(id ? `/api/production-projects/${id}` : null, r10.revision, r10.onExpired);
  const project = remote.data?.project;
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [filters, setFilters] = useState<{ id: string; field: string; value: string; common: boolean }[]>([{ id: requestKey(), field: '', value: '', common: false }]);
  const [appliedFilters, setAppliedFilters] = useState<typeof filters>([]);

  const orders = useMemo(() => {
    let rows = remote.data?.work_orders ?? [];
    if (appliedKeyword.trim()) {
      const key = appliedKeyword.trim().toLowerCase();
      rows = rows.filter((row) => `${row.code}${row.product_name}${row.product_code}${row.specification}`.toLowerCase().includes(key));
    }
    for (const filter of appliedFilters) {
      if (!filter.field || !filter.value) continue;
      if (filter.field === '加工单状态') rows = rows.filter((row) => String(row.execution_text ?? '').includes(filter.value));
      if (filter.field === '计划数') rows = rows.filter((row) => String(row.plan_qty ?? '').includes(filter.value));
    }
    return rows;
  }, [remote.data, appliedKeyword, appliedFilters]);

  const hierarchy = useMemo(() => {
    const roots = orders.filter((row) => !row.parent_id);
    const map = new Map<string, string>();
    roots.forEach((root, index) => {
      map.set(String(root.id), String(index + 1));
      orders.filter((row) => row.parent_id === root.id).forEach((child, childIndex) => {
        map.set(String(child.id), `${index + 1}.${childIndex + 1}`);
      });
    });
    orders.forEach((row) => { if (!map.has(String(row.id))) map.set(String(row.id), String(map.size + 1)); });
    return map;
  }, [orders]);

  if (!project) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : remote.error || '项目不存在'}</div>;
  const shareUrl = `${window.location.origin}${detailPath(project)}`;

  return <div className="kgd-card">
    <div className="kgd-actions">
      <Button onClick={() => navigate('/production_project/list')}>返回</Button>
      <Button onClick={() => setShareOpen(true)}>分享项目进度</Button>
      <span className="spacer" />
    </div>
    <div className="kgd-form" style={{ display: 'grid', gridTemplateColumns: kind === 'contract' ? 'repeat(3, minmax(180px, 1fr))' : 'repeat(2, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
      <label>项目编号<Input disabled value={String(project.code ?? '')} style={{ background: '#f5f5f5' }} /></label>
      <label>项目名称<Input disabled value={String(project.name ?? '')} style={{ background: '#f5f5f5' }} /></label>
      {kind === 'contract' && <label>关联合同<Input disabled value={contractNo || String(project.contract_code || '')} style={{ background: '#f5f5f5' }} /></label>}
    </div>
    <div className="kgd-toolbar" style={{ position: 'relative', flexWrap: 'wrap', gap: 8 }}>
      <Input style={{ width: 220 }} allowClear placeholder="输入关键字查询" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => setAppliedKeyword(keyword)} />
      <Button type="primary" onClick={() => setAppliedKeyword(keyword)}>查 询</Button>
      <Button onClick={() => setAdvOpen((open) => !open)}>高级查询</Button>
      {advOpen && <div className="kgd-adv" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 20, background: '#fff', border: '1px solid #e8e8e8', boxShadow: '0 4px 12px rgba(0,0,0,.08)', padding: 12, width: 560 }}>
        <div className="kgd-adv-field-list" style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 8 }}>加工单状态、计划数</div>
        {filters.map((filter) => <div key={filter.id} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <Dropdown menu={{
            items: [{ key: '加工单状态', label: '加工单状态' }, { key: '计划数', label: '计划数' }],
            onClick: ({ key }) => setFilters((current) => current.map((item) => item.id === filter.id ? { ...item, field: String(key) } : item)),
          }}><Button style={{ width: 140 }}>{filter.field || '输入关键词搜索'}</Button></Dropdown>
          <Input disabled={!filter.field} value={filter.value} onChange={(event) => setFilters((current) => current.map((item) => item.id === filter.id ? { ...item, value: event.target.value } : item))} />
          <Button icon={<DeleteOutlined />} onClick={() => setFilters((current) => current.length === 1 ? current : current.filter((item) => item.id !== filter.id))} />
          <Checkbox checked={filter.common} onChange={(event) => setFilters((current) => current.map((item) => item.id === filter.id ? { ...item, common: event.target.checked } : item))}>常用</Checkbox>
        </div>)}
        <Button type="link" icon={<PlusOutlined />} onClick={() => setFilters((current) => [...current, { id: requestKey(), field: '', value: '', common: false }])}>+ 添加筛选条件</Button>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button type="primary" onClick={() => { setAppliedFilters(filters); setAdvOpen(false); }}>搜 索</Button>
          <Button onClick={() => { setFilters([{ id: requestKey(), field: '', value: '', common: false }]); setAppliedFilters([]); }}>清空筛选值</Button>
        </div>
      </div>}
    </div>
    <Table<Row> size="small" rowKey="id" pagination={{ pageSize: 30, showTotal: (count) => `共${count}条数据` }} scroll={{ x: 'max-content' }}
      locale={{ emptyText: '暂无数据' }} dataSource={orders}
      columns={[
        { title: '层级编号', render: (_, row) => hierarchy.get(String(row.id)) ?? '-' },
        { title: '工单编号', render: (_, row) => <button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.id}`)}>{row.code}</button> },
        { title: '商品', render: (_, row) => dash(row.product_name) },
        { title: '商品编号', render: (_, row) => dash(row.product_code) },
        { title: '商品规格', render: (_, row) => dash(row.specification) },
        { title: '商品图片', render: () => '-' },
        { title: '合同编号', render: (_, row) => dash(row.contract_code) },
        { title: '商品来源', render: (_, row) => dash(row.product_source) },
        { title: '单位', render: (_, row) => dash(row.unit_name) },
        { title: '单位用量', render: (_, row) => dash(row.unit_qty) },
        { title: '计划数', render: (_, row) => dash(row.plan_qty) },
        { title: '状态', render: (_, row) => dash(row.execution_text) },
        { title: '交货日期', render: (_, row) => dash(row.due_date) },
        { title: '优先级', render: (_, row) => dash(row.priority_text) },
        { title: '生产进度', width: 160, render: (_, row) => progress(row.production_progress ?? row.process_progress) },
        { title: '任务进度', width: 160, render: (_, row) => progress(row.task_progress) },
        { title: 'BOM', render: (_, row) => dash(row.bom_label) },
        { title: '工序流程', render: (_, row) => dash(row.route_name) },
        { title: '用料清单', render: (_, row) => dash(row.materials_label) },
        { title: '计划开始', render: (_, row) => dash(row.plan_start) },
        { title: '计划结束', render: (_, row) => dash(row.plan_end) },
        { title: '备注', render: (_, row) => dash(row.note) },
        { title: '图纸', render: () => '-' },
        { title: '操作', width: 160, render: (_, row) => <>
          <button className="kgd-link" onClick={() => navigate(`/inside_produce_bill/detail/${row.id}?tab=wage`)}>工资单</button>{' '}
          <button className="kgd-link" onClick={() => window.print()}>打印</button>{' '}
          <Dropdown menu={{ items: [{ key: 'detail', label: '详情' }, { key: 'remove', label: '移出项目', danger: true }], onClick: ({ key }) => {
            if (key === 'detail') navigate(`/inside_produce_bill/detail/${row.id}`);
            if (key === 'remove') void r10.act(`/api/work-order-links/${row.id}`, { project_id: null }, 'PUT', '已移出');
          } }}><button className="kgd-link">更多</button></Dropdown>
        </> },
      ]} />
    <Modal title="分享项目进度" open={shareOpen} onCancel={() => setShareOpen(false)} footer={null} width={420}>
      <div style={{ textAlign: 'center' }}>
        <QrImage text={shareUrl} />
        <p style={{ marginTop: 12 }}>扫描二维码查看生产进度</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <Button type="primary" onClick={() => r10.message.success('请使用手机扫描上方二维码分享')}>分享二维码</Button>
          <Button onClick={() => { void navigator.clipboard?.writeText(shareUrl).then(() => r10.message.success('已复制分享链接')); }}>分享链接</Button>
        </div>
        {contractId ? <p className="kgd-muted" style={{ marginTop: 8 }}>合同 {contractNo || project.contract_code}</p> : null}
      </div>
    </Modal>
  </div>;
}

export { ProjectPages as ProjectList };
