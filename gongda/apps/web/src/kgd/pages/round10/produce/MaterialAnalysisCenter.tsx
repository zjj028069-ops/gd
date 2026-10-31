import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Popover, Tag } from 'antd';
import { ListFrame } from '../../../ListFrame';
import type { QueryField } from '../../../ListFrame';
import { useQueryState } from '../../../kit';
import { dash, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';

const queryFields: QueryField[] = [
  { key: 'plan_code', label: '计划编号' },
  { key: 'plan_name', label: '计划名称' },
  { key: 'analyst', label: '分析人' },
  { key: 'status', label: '分析状态', kind: 'select', options: [{ value: '', label: '全部' }, { value: '有效', label: '有效' }, { value: '已作废', label: '已作废' }] },
  { key: 'from', label: '分析时间起', kind: 'date' },
  { key: 'to', label: '分析时间止', kind: 'date' },
];

function Codes({ qty, codes }: { qty: unknown; codes: unknown }) {
  const list = Array.isArray(codes) ? (codes as string[]) : [];
  const text = dash(qty);
  if (!list.length) return <span>{text}</span>;
  return <Popover trigger="click" content={<div style={{ display: 'grid', gap: 4 }}>{list.map((code) => <span key={code}>{code}</span>)}</div>}>
    <button type="button" className="kgd-link">{text}（{list.length}单）</button>
  </Popover>;
}

export function MaterialAnalysisCenter() {
  const r10 = useR10();
  const navigate = useNavigate();
  const list = useQueryState();
  const [detail, setDetail] = useState<Row | null>(null);
  const remote = useList<Row>(`/api/material-analysis${qs({ ...list.query, page: list.page, page_size: list.pageSize })}`);
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame<Row> pageKey="material_analysis" exportName="物料分析" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={queryFields} defaultQueryKeys={['plan_code', 'plan_name', 'analyst']} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} onApplyQuery={list.onApplyQuery}
      page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage} clientPaging={false}
      toolbar={<button className="kgd-link" onClick={() => navigate('/MaterialAnalysis/add')}>新增</button>}
      columns={[
        { key: 'plan_code', title: '计划编号', render: (row) => <button className="kgd-link" onClick={() => navigate(`/ProductionPlan/detail/${row.plan_id}`)}>{row.plan_code}</button> },
        { key: 'plan_name', title: '计划名称', render: (row) => dash(row.plan_name) },
        { key: 'status', title: '分析状态', render: (row) => row.status === 'void' ? <Tag>已作废</Tag> : <Tag color="green">有效</Tag> },
        { key: 'process', title: '加工单', render: (row) => <Codes qty={row.process_demand_qty} codes={row.work_orders} /> },
        { key: 'outsource', title: '外协工单', render: (row) => <Codes qty={row.outsource_demand_qty} codes={row.outsource_orders} /> },
        { key: 'purchase', title: '采购单', render: (row) => <Codes qty={row.purchase_demand_qty} codes={row.purchase_orders} /> },
        { key: 'note', title: '备注', render: (row) => dash(row.note) },
        { key: 'analyst', title: '分析人', render: (row) => dash(row.analyst_name) },
        { key: 'analyzed', title: '分析时间', width: 160, render: (row) => dash(row.analyzed_text) },
        { key: 'actions', title: '操作', width: 340, render: (row) => row.status === 'void' ? <button className="kgd-link" onClick={() => setDetail(row)}>详情</button> : <>
          <button className="kgd-link" onClick={() => navigate(`/ProductionPlan/detail/${row.plan_id}?tab=analysis`)}>创建加工单</button>{' '}
          <button className="kgd-link" onClick={() => navigate(`/OutWorkOrder/add?plan_analysis_id=${row.id}&qty=${encodeURIComponent(String(row.outsource_demand_qty ?? ''))}`)}>创建外协工单</button>{' '}
          <button className="kgd-link" onClick={() => navigate(`/purchase_order/list?add=1&plan_analysis_id=${row.id}`)}>创建采购单</button>{' '}
          <button className="kgd-link" onClick={() => setDetail(row)}>修改</button>{' '}
          <button className="kgd-link" onClick={() => setDetail(row)}>详情</button>{' '}
          <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('作废分析记录', () => r10.act(`/api/production-plans/${row.plan_id}/analysis-lines/${row.id}/void`, {}, 'POST', '已作废'), '作废后计划将回到未分析。已有加工单下达的不能作废。')}>作废</button>
        </> },
      ]} />
    <Modal title="需求数" open={!!detail} onCancel={() => setDetail(null)} footer={null}>
      {detail && <dl className="kgd-detail-grid">
        <div><dt>计划编号</dt><dd>{detail.plan_code}</dd></div>
        <div><dt>分析状态</dt><dd>{dash(detail.status_text)}</dd></div>
        <div><dt>加工需求</dt><dd>{dash(detail.process_demand_qty)}</dd></div>
        <div><dt>外协需求</dt><dd>{dash(detail.outsource_demand_qty)}</dd></div>
        <div><dt>采购需求</dt><dd>{dash(detail.purchase_demand_qty)}</dd></div>
        <div><dt>加工单</dt><dd>{(detail.work_orders as string[] | undefined)?.join('、') || '-'}</dd></div>
        <div><dt>外协工单</dt><dd>{(detail.outsource_orders as string[] | undefined)?.join('、') || '-'}</dd></div>
        <div><dt>采购单</dt><dd>{(detail.purchase_orders as string[] | undefined)?.join('、') || '-'}</dd></div>
      </dl>}
    </Modal>
  </>;
}
