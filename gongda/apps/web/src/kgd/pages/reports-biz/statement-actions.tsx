import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Modal, Radio, Table, Tag } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ColumnConfigModal } from '../../dialogs';
import { dash } from '../round8/kit';
import { auditText, AuditTag } from '../warehouse/shared';
import { printDocs, printLayout, type LayoutDoc, type PrintDoc } from '../../print';
import { buildStatementContext, openFlowPrint } from '../../print/flow';
import { downloadCsv } from '../../wage';
import type { ColumnPrefs } from '../../storage';

export type StatementRow = {
  id: string;
  customer_code?: string | number;
  customer_name?: string | number;
  customer_tag?: string | number;
  contact_name?: string | number;
  contact_phone?: string | number;
  address?: string | number;
  owner_name?: string | number;
};

type Line = Record<string, string> & { id: string };
type Detail = { items: Line[]; summary: { qty: string; amount: string } };
type Col = { key: string; title: string };
type TemplateItem = { id: string; name: string; is_system: boolean; content: LayoutDoc & { builtin?: boolean } };
type TemplateList = { items: TemplateItem[]; system_name: string };

const outboundColumns: Col[] = [
  { key: 'shipment_code', title: '销售出库单号' },
  { key: 'warehouse_name', title: '仓库' },
  { key: 'contract_code', title: '合同编号' },
  { key: 'audit_status', title: '审核状态' },
  { key: 'ship_date', title: '出库日期' },
  { key: 'shipper_name', title: '发货人' },
  { key: 'product_name', title: '商品名' },
  { key: 'product_code', title: '商品编号' },
  { key: 'specification', title: '商品规格' },
  { key: 'unit_price', title: '销售单价(元)' },
  { key: 'sale_amount', title: '销售金额(元)' },
  { key: 'quantity', title: '数量' },
  { key: 'unit_name', title: '单位' },
  { key: 'note', title: '备注' },
  { key: 'color_desc', title: '颜色描述' },
  { key: 'created_at', title: '创建时间' },
];

const returnColumns: Col[] = [
  { key: 'return_code', title: '销售退货单号' },
  { key: 'shipment_code', title: '销售出库单号' },
  { key: 'warehouse_name', title: '仓库' },
  { key: 'return_date', title: '退货日期' },
  { key: 'product_name', title: '商品名' },
  { key: 'product_code', title: '商品编号' },
  { key: 'specification', title: '商品规格' },
  { key: 'quantity', title: '数量' },
  { key: 'unit_name', title: '单位' },
  { key: 'unit_price', title: '销售单价(元)' },
  { key: 'sale_amount', title: '销售金额(元)' },
  { key: 'note', title: '备注' },
  { key: 'color_desc', title: '颜色描述' },
];

function textOf(value: string | number | undefined) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function cellText(row: Line, key: string) {
  if (key === 'audit_status') return auditText[String(row.audit_status ?? '')] ?? dash(row.audit_status);
  return dash(row[key]);
}

function defaultPrefs(columns: Col[]): ColumnPrefs {
  return { order: columns.map((column) => column.key), visible: columns.map((column) => column.key), locked: [] };
}

export function StatementLineModal({
  kind, customerId, period, onClose,
}: {
  kind: 'outbound' | 'return';
  customerId: string;
  period: string;
  onClose: () => void;
}) {
  const { revision, onExpired } = useKgd();
  const columns = kind === 'outbound' ? outboundColumns : returnColumns;
  const title = kind === 'outbound' ? '出库明细列表' : '退货明细列表';
  const qtyLabel = kind === 'outbound' ? '出库数量' : '退货数量';
  const amountLabel = kind === 'outbound' ? '出库金额(元)' : '退货金额(元)';
  const path = customerId
    ? `/api/biz-reports/sales/${encodeURIComponent(customerId)}/${kind === 'outbound' ? 'outbound' : 'returns'}?period=${encodeURIComponent(period)}`
    : null;
  const remote = useRemote<Detail>(path, revision, onExpired);
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => defaultPrefs(columns));
  const [columnOpen, setColumnOpen] = useState(false);
  const visible = useMemo(
    () => prefs.order.map((key) => columns.find((column) => column.key === key)).filter((column): column is Col => !!column && prefs.visible.includes(column.key)),
    [columns, prefs],
  );
  const items = remote.data?.items ?? [];
  const summary = remote.data?.summary;
  function exportVisible() {
    downloadCsv(`${title}.csv`, visible.map((column) => column.title), items.map((row) => visible.map((column) => cellText(row, column.key))));
  }
  return <>
    <Modal title={title} open width={1080} onCancel={onClose} footer={null} destroyOnHidden styles={{ body: { minHeight: 280 } }}>
      <div className="stmt-line-bar">
        <Button type="primary" autoInsertSpace={false} onClick={exportVisible}>导出</Button>
        <span className="stmt-line-sum">{qtyLabel}：<b>{summary?.qty ?? (remote.loading ? '' : '0')}</b><span className="gap" />{amountLabel}：<b>{summary?.amount ?? (remote.loading ? '' : '0')}</b></span>
        <span className="spacer" />
        <Button type="text" aria-label="列配置" icon={<SettingOutlined />} onClick={() => setColumnOpen(true)}>列配置</Button>
      </div>
      {remote.error && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={remote.error} />}
      <Table<Line>
        size="small"
        rowKey="id"
        loading={remote.loading}
        dataSource={items}
        pagination={{ pageSize: 30, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => `共${count}条数据` }}
        scroll={{ x: 'max-content', y: 360 }}
        locale={{ emptyText: remote.loading ? '正在读取数据…' : '暂无数据' }}
        columns={visible.map((column) => ({
          title: column.title,
          dataIndex: column.key,
          key: column.key,
          width: column.key === 'audit_status' ? 110 : 140,
          render: (_value: unknown, row: Line) => column.key === 'audit_status'
            ? <AuditTag status={row.audit_status} />
            : dash(row[column.key]),
        }))}
      />
    </Modal>
    <ColumnConfigModal
      open={columnOpen}
      columns={columns.map((column) => ({ key: column.key, label: column.title }))}
      value={prefs}
      onCancel={() => setColumnOpen(false)}
      onOk={(next) => { setPrefs(next); setColumnOpen(false); }}
    />
  </>;
}

function statementDoc(row: StatementRow): PrintDoc {
  const code = textOf(row.customer_code);
  return {
    title: `打印销售对账单${code}`,
    fields: [
      ['客户编号', textOf(row.customer_code)],
      ['客户', textOf(row.customer_name)],
      ['客户标签', textOf(row.customer_tag)],
      ['联系人', textOf(row.contact_name)],
      ['联系人电话', textOf(row.contact_phone)],
      ['地址', textOf(row.address)],
      ['负责人', textOf(row.owner_name)],
    ],
  };
}

export function StatementPrintModal({ row, period, onClose }: { row: StatementRow; period: string; onClose: () => void }) {
  const { session } = useKgd();
  const { message } = App.useApp();
  const [tab, setTab] = useState<'custom' | 'excel'>('custom');
  const [data, setData] = useState<TemplateList | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const code = textOf(row.customer_code);
  const title = `打印销售对账单${code}`;
  useEffect(() => {
    let alive = true;
    void apiRequest<TemplateList>('/api/print-templates?object_key=sales_statement').then((list) => {
      if (!alive) return;
      setData(list);
      const system = list.items.find((item) => item.is_system);
      if (system) setSelected(system.id);
    }).catch((failure: unknown) => {
      if (alive) setError(failure instanceof Error ? failure.message : '打印模板加载失败');
    });
    return () => { alive = false; };
  }, []);
  async function printNow() {
    if (tab !== 'custom') {
      message.error('请选择打印模板');
      return;
    }
    const item = data?.items.find((template) => template.id === selected);
    if (!item) {
      message.error(error || '请选择打印模板');
      return;
    }
    if (item.content.flow?.length) {
      try {
        const [outbound, returns] = await Promise.all([
          apiRequest<{ items: Array<Record<string, string>> }>(`/api/biz-reports/sales/${encodeURIComponent(String(row.id))}/outbound?period=${encodeURIComponent(period)}`),
          apiRequest<{ items: Array<Record<string, string>> }>(`/api/biz-reports/sales/${encodeURIComponent(String(row.id))}/returns?period=${encodeURIComponent(period)}`),
        ]);
        const customerName = textOf(row.customer_name);
        const ok = openFlowPrint({
          paper: item.content.paper,
          marginMm: item.content.margin_mm,
          flow: item.content.flow,
          footer: item.content.footer_on ? item.content.footer ?? [] : [],
          title: item.name,
          note: `打印客户：${code} ${customerName} · ${period}`,
          ctx: buildStatementContext(row, outbound.items ?? [], returns.items ?? [], { period, user: session.user.display_name, company: session.tenant.name }),
        });
        if (!ok) message.warning('浏览器拦截了打印窗口，请允许弹出窗口后重试。');
        else onClose();
      } catch (failure) {
        message.error(failure instanceof Error ? failure.message : '打印数据加载失败');
      }
      return;
    }
    const doc = statementDoc(row);
    const ok = item.is_system && item.content.builtin
      ? printDocs([doc], doc.title)
      : printLayout([doc], item.content, item.name);
    if (!ok) message.warning('浏览器拦截了打印窗口，请允许弹出窗口后重试。');
    else onClose();
  }
  return <Modal title={title} open width={560} centered onCancel={onClose} footer={null} destroyOnHidden>
    <div className="stmt-print-tabs">
      <button type="button" className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>自定义模板打印</button>
      <button type="button" className={tab === 'excel' ? 'on' : ''} onClick={() => setTab('excel')}>Excel模板打印</button>
    </div>
    {error && tab === 'custom' && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} />}
    <div className="stmt-print-body">
      {tab === 'custom' ? <Radio.Group value={selected} onChange={(event) => setSelected(event.target.value)} className="print-pick-list">
        {(data?.items ?? []).map((item) => <Radio key={item.id} value={item.id}>
          {item.name}{item.is_system ? <> <Tag color="blue">系统模板</Tag></> : null}
        </Radio>)}
      </Radio.Group> : <div className="stmt-print-empty">暂无数据</div>}
    </div>
    <div className="stmt-print-foot"><Button type="primary" autoInsertSpace={false} onClick={printNow}>打印</Button></div>
  </Modal>;
}
