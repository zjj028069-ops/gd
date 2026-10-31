import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Modal, Pagination, Table } from 'antd';
import { hasPermission } from '../../api';
import { useRemote } from '../../masterTools';
import { useKgd } from '../context';
import { ColumnConfigModal } from '../dialogs';
import { ListFrame } from '../ListFrame';
import type { ListColumn } from '../ListFrame';
import { useQueryState } from '../kit';
import { qtyText } from '../qty';
import { columnStorageKey, loadJson, mergeColumnPrefs, saveJson } from '../storage';
import type { ColumnPrefs } from '../storage';
import { downloadCsv, modeText, moneyLabel, qualityText, rateLabel, settlementText } from '../wage';

type Person = {
  user_id: string; name: string; department_name: string | null;
  settled_qty: string; unsettled_qty: string; settled_piece: string; unsettled_piece: string;
  settled_time: string; unsettled_time: string; report_qty: string; good_qty: string; defect_qty: string; wage: string;
};
type MonthRow = {
  id: string; month: string; settled_qty: string; unsettled_qty: string; report_qty: string;
  settled_piece: string; unsettled_piece: string; settled_time: string; unsettled_time: string;
  good_qty: string; defect_qty: string; wage: string;
};
type Detail = {
  id: string; work_order_code: string; product_code: string | null; product_name: string | null; product_spec: string; product_category: string;
  good_qty: string; pricing_mode: string | null; wage_rate: string | null; wage: string | null; quality_status: string; settlement_status: string; unit_name?: string;
};

function cellText<T>(column: ListColumn<T>, row: T) {
  const node = column.render?.(row);
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return '';
}

function Sheet<T extends { id: string }>({ pageKey, columns, rows, loading, page, pageSize, total, onPage }: {
  pageKey: string; columns: ListColumn<T>[]; rows: T[]; loading?: boolean; page: number; pageSize: number; total: number; onPage?: (page: number, pageSize: number) => void;
}) {
  const { session } = useKgd();
  const defaults = useMemo<ColumnPrefs>(() => ({ order: columns.map((column) => column.key), visible: columns.map((column) => column.key), locked: [] }), [columns]);
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => mergeColumnPrefs(loadJson<ColumnPrefs | null>(columnStorageKey(String(session.user.id), pageKey), null), defaults, defaults.order));
  const [open, setOpen] = useState(false);
  const visible = prefs.order.filter((key) => prefs.visible.includes(key)).map((key) => columns.find((column) => column.key === key)).filter((column): column is ListColumn<T> => !!column);
  return <>
    <div className="kgd-toolbar">
      <Button onClick={() => downloadCsv(`${pageKey}.csv`, visible.map((column) => column.title), rows.map((row) => visible.map((column) => cellText(column, row))))}>导出</Button>
      <Button onClick={() => setOpen(true)}>列配置</Button>
    </div>
    <Table<T> size="small" rowKey="id" loading={loading} pagination={false} scroll={{ x: 'max-content' }} dataSource={rows} columns={visible.map((column) => ({ title: column.title, key: column.key, render: (_: unknown, row: T) => column.render?.(row) as ReactNode }))} />
    {onPage && <div className="kgd-foot"><span /><Pagination current={page} pageSize={pageSize} total={total} showSizeChanger pageSizeOptions={[20, 30, 50]} showTotal={(count) => `共 ${count} 条`} onChange={onPage} /></div>}
    <ColumnConfigModal open={open} columns={columns.map((column) => ({ key: column.key, label: column.title }))} value={prefs} onCancel={() => setOpen(false)} onOk={(next) => { setPrefs(next); saveJson(columnStorageKey(String(session.user.id), pageKey), next); setOpen(false); }} />
  </>;
}

export function PayrollStatement() {
  const { session, revision, onExpired } = useKgd();
  const list = useQueryState();
  const [visibleKeys, setVisibleKeys] = useState<string[]>([]);
  const [person, setPerson] = useState<Person | null>(null);
  const [detail, setDetail] = useState<Person | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [detailSize, setDetailSize] = useState(30);
  const canDept = hasPermission(session, 'organization.manage');
  const departments = useRemote<{ items: { id: string; name: string }[] }>(canDept ? '/api/platform/departments' : null, revision, onExpired);
  const filters = useMemo(() => {
    const params = new URLSearchParams();
    const date = (key: string, value: string | undefined) => { if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) params.set(key, value); };
    if (list.query.name) params.set('name', list.query.name);
    if (list.query.department) params.set('department_id', list.query.department);
    if (list.query.quality) params.set('quality_status', list.query.quality);
    date('report_from', list.query.report_from);
    date('report_to', list.query.report_to);
    date('settled_from', list.query.settled_from);
    date('settled_to', list.query.settled_to);
    return params;
  }, [list.query.department, list.query.name, list.query.quality, list.query.report_from, list.query.report_to, list.query.settled_from, list.query.settled_to]);
  const remote = useRemote<{ items: Person[] }>(`/api/payroll-statement?${filters.toString()}`, revision, onExpired);
  const monthly = useRemote<{ name: string; items: Omit<MonthRow, 'id'>[] }>(person ? `/api/payroll-statement/${person.user_id}/monthly?${new URLSearchParams([...filters].filter(([key]) => key === 'report_from' || key === 'report_to')).toString()}` : null, revision, onExpired);
  // details API rejects unknown query keys (additionalProperties:false); only forward filters it accepts.
  const detailQuery = new URLSearchParams([...filters].filter(([key]) => ['report_from', 'report_to', 'settled_from', 'settled_to', 'quality_status'].includes(key)));
  detailQuery.set('page', String(detailPage));
  detailQuery.set('page_size', String(detailSize));
  const details = useRemote<{ items: Detail[]; total: number }>(detail ? `/api/payroll-statement/${detail.user_id}/details?${detailQuery.toString()}` : null, revision, onExpired);
  const rows = (remote.data?.items ?? []).map((row) => ({ ...row, id: row.user_id }));
  const columns: ListColumn<Person & { id: string }>[] = [
    { key: 'name', title: '姓名', render: (row) => row.name },
    { key: 'department', title: '部门', render: (row) => row.department_name ?? '' },
    { key: 'unsettledQty', title: '未结算报工数', render: (row) => qtyText(row.unsettled_qty) },
    { key: 'settledQty', title: '已结算报工数', render: (row) => qtyText(row.settled_qty) },
    { key: 'unsettledPiece', title: '未结算工资(计件)', render: (row) => moneyLabel(row.unsettled_piece) },
    { key: 'settledPiece', title: '已结算工资(计件)', render: (row) => moneyLabel(row.settled_piece) },
    { key: 'reportQty', title: '报工总数', render: (row) => qtyText(row.report_qty) },
    { key: 'good', title: '良品数', render: (row) => qtyText(row.good_qty) },
    { key: 'defect', title: '不良品数', render: (row) => qtyText(row.defect_qty) },
    { key: 'taskQty', title: '任务报工数', render: (row) => qtyText(row.report_qty) },
    { key: 'oddJobQty', title: '零活报工数', render: () => '-' },
    { key: 'wage', title: '工资(元)', render: (row) => moneyLabel(row.wage) },
    { key: 'actions', title: '操作', width: 200, render: (row) => <span onClick={(event) => event.stopPropagation()}>
      <Button type="link" onClick={() => { setDetailPage(1); setDetail(row); }}>报工详情</Button>
      <Button type="link" onClick={() => setPerson(row)}>个人工资报表</Button>
    </span> },
  ];
  const monthColumns: ListColumn<MonthRow>[] = [
    { key: 'month', title: '月份', render: (row) => row.month },
    { key: 'unsettledQty', title: '未结算报工数', render: (row) => qtyText(row.unsettled_qty) },
    { key: 'settledQty', title: '已结算报工数', render: (row) => qtyText(row.settled_qty) },
    { key: 'unsettledPiece', title: '未结算工资(计件)', render: (row) => moneyLabel(row.unsettled_piece) },
    { key: 'settledPiece', title: '已结算工资(计件)', render: (row) => moneyLabel(row.settled_piece) },
    { key: 'unsettledTime', title: '未结算工资(计时)', render: (row) => moneyLabel(row.unsettled_time) },
    { key: 'settledTime', title: '已结算工资(计时)', render: (row) => moneyLabel(row.settled_time) },
    { key: 'reportQty', title: '报工总数', render: (row) => qtyText(row.report_qty) },
    { key: 'good', title: '良品数', render: (row) => qtyText(row.good_qty) },
    { key: 'defect', title: '不良品数', render: (row) => qtyText(row.defect_qty) },
    { key: 'wage', title: '工资(元)', render: (row) => moneyLabel(row.wage) },
  ];
  const detailColumns: ListColumn<Detail>[] = [
    { key: 'order', title: '加工单号', render: (row) => row.work_order_code },
    { key: 'productCode', title: '商品编号', render: (row) => row.product_code ?? '' },
    { key: 'productName', title: '商品名', render: (row) => row.product_name ?? '' },
    { key: 'spec', title: '商品规格', render: (row) => row.product_spec },
    { key: 'category', title: '商品类别', render: (row) => row.product_category },
    { key: 'good', title: '良品数', render: (row) => qtyText(row.good_qty) },
    { key: 'mode', title: '计价方式', render: (row) => modeText(row.pricing_mode) },
    { key: 'rate', title: '工资单价', render: (row) => rateLabel(row.wage_rate, row.unit_name) || '-' },
    { key: 'wage', title: '工资(元)', render: (row) => moneyLabel(row.wage) },
    { key: 'qc', title: '质检状态', render: (row) => qualityText(row.quality_status) },
    { key: 'settle', title: '结算状态', render: (row) => settlementText(row.settlement_status) },
  ];
  function exportRows(keys: string[]) {
    const chosen = columns.filter((column) => keys.includes(column.key) && column.key !== 'actions');
    downloadCsv('生产工资报表.csv', chosen.map((column) => column.title), rows.map((row) => chosen.map((column) => cellText(column, row))));
  }
  return <div className="kgd-payroll-ink">
    <ListFrame pageKey="payroll" columns={columns} rows={rows} loading={remote.loading} error={remote.error} onVisibleKeys={setVisibleKeys}
      queryFields={[
        { key: 'name', label: '姓名', placeholder: '姓名' },
        { key: 'department', label: '部门', kind: 'select', missing: !canDept, options: (departments.data?.items ?? []).map((item) => ({ value: item.id, label: item.name })) },
        { key: 'quality', label: '质检状态', kind: 'select', options: [{ value: 'pending', label: '待质检' }, { value: 'done', label: '已质检' }, { value: 'none', label: '不需质检' }] },
        { key: 'report_from', label: '报工时间起', kind: 'date' },
        { key: 'report_to', label: '报工时间止', kind: 'date' },
        { key: 'settled_from', label: '结算时间起', kind: 'date' },
        { key: 'settled_to', label: '结算时间止', kind: 'date' },
        { key: 'start_from', label: '报工开始时间起', kind: 'date' },
        { key: 'start_to', label: '报工开始时间止', kind: 'date' },
        { key: 'end_from', label: '报工结束时间起', kind: 'date' },
        { key: 'end_to', label: '报工结束时间止', kind: 'date' },
      ]}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      moreItems={[{ key: 'shown', label: '导出(显示列)', onClick: () => exportRows(visibleKeys.length ? visibleKeys : columns.map((column) => column.key)) }]}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      defaultQueryKeys={['name', 'department', 'quality', 'report_from', 'report_to', 'settled_from', 'settled_to']}
      defaultVisible={['name', 'department', 'unsettledQty', 'settledQty', 'unsettledPiece', 'settledPiece', 'reportQty', 'good', 'defect', 'taskQty', 'oddJobQty', 'wage', 'actions']} />
    <Modal title={`${person?.name ?? monthly.data?.name ?? ''}-工资报表`} open={!!person} width={960} footer={null} onCancel={() => setPerson(null)} destroyOnHidden>
      <Sheet pageKey="payroll-monthly" columns={monthColumns} rows={(monthly.data?.items ?? []).map((row) => ({ ...row, id: row.month }))} loading={monthly.loading} page={1} pageSize={50} total={monthly.data?.items.length ?? 0} />
    </Modal>
    <Modal title={`${detail?.name ?? ''}-报工详情`} open={!!detail} width={1040} footer={null} onCancel={() => setDetail(null)} destroyOnHidden>
      <Sheet pageKey="payroll-details" columns={detailColumns} rows={details.data?.items ?? []} loading={details.loading} page={detailPage} pageSize={detailSize} total={details.data?.total ?? 0} onPage={(page, size) => { setDetailPage(page); setDetailSize(size); }} />
    </Modal>
  </div>;
}
