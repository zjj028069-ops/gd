import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Cascader, DatePicker, Input, Modal, Select, Table, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { showError, useCommand, beijingTime } from '../../kit';
import { recordDoc } from '../../print';
import { lineAmount, netAmount, sumMoney } from './math';
import { pickByIds, requestKey } from '../../../requestKey';

const goodsLines: [string, string][] = [['商品编号', 'product_code'], ['商品名', 'product_name'], ['规格', 'specification'], ['单位', 'unit_name'], ['单价', 'unit_price'], ['数量', 'quantity'], ['折后金额', 'net_amount'], ['备注', 'note']];
export const contractDoc = (row: Rec) => recordDoc('合同订单', row, [['合同编号', 'code'], ['客户', 'customer_name'], ['合同金额', 'amount'], ['销售总数', 'qty'], ['预付款', 'prepay'], ['累计收款', 'received'], ['欠款', 'debt'], ['交货日期', 'delivery_date'], ['业务员', 'salesperson_name'], ['审核状态', 'approval_text'], ['创建人', 'creator_name'], ['备注', 'note']], { key: 'lines', columns: goodsLines });
export const quoteDoc = (row: Rec) => recordDoc('报价单', row, [['报价单号', 'code'], ['客户', 'customer_name'], ['报价金额', 'amount'], ['商品总数', 'qty'], ['报价日期', 'quoted_on'], ['有效期至', 'valid_until'], ['审核状态', 'approval_text'], ['创建人', 'creator_name'], ['备注', 'note']], { key: 'lines', columns: goodsLines });
export const expenseDoc = (row: Rec) => recordDoc('销售费用', row, [['客户', 'customer_name'], ['合同编号', 'contract_code'], ['支出日期', 'spent_on'], ['支出类别', 'category'], ['金额', 'amount'], ['审核', 'approval_text'], ['结算', 'settled_text'], ['创建人', 'creator_name'], ['备注', 'note']]);

export const codePlaceholder = '请填写，忽略将自动生成';
export const searchPlaceholder = '输入关键词，在查询结果中选中';
export const uploadText = '选择文件 Ctrl+v 粘贴或拖拽文件到此处';
export const contractAmountTip = '${合同明细.单价}*${合同明细.销售数量}，管理员可在客户设置-基础设置中自定义金额的计算公式。';
export const quoteAmountTip = '${合同报价明细.单价}*${合同报价明细.销售数量}，管理员可在客户设置-基础设置中自定义金额的计算公式。';
export const shipmentTip = '此处仅支持非合同商品的销售出库收款，若想合同收款请前往合同列表进行收款。';

export type Rec = { id: string; [key: string]: any };
export type DraftLine = {
  key: string; product_id: string; product_name: string; product_code: string; specification: string; unit_name: string; source: string;
  unit_price: string; quantity: string; discount: string; concession: string; note: string; stock: string;
  plan_code: string; plan_name: string; contract_id: string; contract_code: string; supplier_name: string;
};

export const regions = [
  { value: '北京市', label: '北京市', children: [{ value: '北京市', label: '北京市', children: [{ value: '朝阳区', label: '朝阳区' }, { value: '海淀区', label: '海淀区' }] }] },
  { value: '上海市', label: '上海市', children: [{ value: '上海市', label: '上海市', children: [{ value: '浦东新区', label: '浦东新区' }, { value: '闵行区', label: '闵行区' }] }] },
  { value: '江苏省', label: '江苏省', children: [{ value: '南京市', label: '南京市', children: [{ value: '玄武区', label: '玄武区' }, { value: '江宁区', label: '江宁区' }] }, { value: '苏州市', label: '苏州市', children: [{ value: '吴江区', label: '吴江区' }, { value: '工业园区', label: '工业园区' }, { value: '姑苏区', label: '姑苏区' }] }] },
  { value: '浙江省', label: '浙江省', children: [{ value: '杭州市', label: '杭州市', children: [{ value: '西湖区', label: '西湖区' }, { value: '滨江区', label: '滨江区' }] }] },
  { value: '广东省', label: '广东省', children: [{ value: '深圳市', label: '深圳市', children: [{ value: '南山区', label: '南山区' }, { value: '宝安区', label: '宝安区' }] }, { value: '广州市', label: '广州市', children: [{ value: '天河区', label: '天河区' }] }] },
  { value: '山东省', label: '山东省', children: [{ value: '青岛市', label: '青岛市', children: [{ value: '市南区', label: '市南区' }] }] },
  { value: '四川省', label: '四川省', children: [{ value: '成都市', label: '成都市', children: [{ value: '武侯区', label: '武侯区' }] }] },
];

export function useMoney() {
  const kgd = useKgd();
  const command = useCommand();
  return { ...kgd, ...command };
}

export function blankLine(partial: Record<string, unknown> = {}): DraftLine {
  return { key: requestKey(), product_id: '', product_name: '', product_code: '', specification: '', unit_name: '', source: '', unit_price: '0', quantity: '1', discount: '10', concession: '0', note: '', stock: '', plan_code: '', plan_name: '', contract_id: '', contract_code: '', supplier_name: '', ...partial } as DraftLine;
}

export function priced(line: DraftLine, formula: string, scale: number) {
  try {
    const amount = lineAmount(formula, line.unit_price || '0', line.quantity || '0', scale);
    return { amount, net: netAmount(amount, line.discount || '10', line.concession || '0', scale) };
  } catch (error) {
    return { amount: '0', net: '0', error: showError(error) };
  }
}

export function downloadBase64(filename: string, content: string) {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}

export function readFileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function FileDrop({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return <label style={{ display: 'block', border: '1px dashed #d9d9d9', padding: 12, textAlign: 'center', cursor: 'pointer' }}>
    {value || uploadText}
    <input type="file" hidden onChange={(event) => onChange(event.target.files?.[0]?.name ?? '')} />
  </label>;
}

export function RegionSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Cascader style={{ width: '100%' }} options={regions} value={value ? value.split('/') : []} placeholder="请选择地区" onChange={(next) => onChange((next ?? []).join('/'))} />;
}

type MemberSelectSingleProps = { revision: number; multiple?: false; value?: string; onChange: (id: string) => void };
type MemberSelectMultiProps = { revision: number; multiple: true; value?: string[]; onChange: (ids: string[]) => void };

export function MemberSelect(props: MemberSelectSingleProps | MemberSelectMultiProps) {
  const { onExpired } = useKgd();
  const remote = useRemote<{ items: { id: string; display_name: string }[] }>('/api/team-members', props.revision, onExpired);
  const options = (remote.data?.items ?? []).map((item) => ({ value: item.id, label: item.display_name }));
  if (props.multiple) {
    return <Select mode="multiple" showSearch optionFilterProp="label" allowClear style={{ width: '100%' }} placeholder={searchPlaceholder} value={props.value ?? []} options={options} onChange={(next) => props.onChange(next)} />;
  }
  return <Select showSearch optionFilterProp="label" allowClear style={{ width: '100%' }} placeholder={searchPlaceholder} value={props.value || undefined} options={options} onChange={(next) => props.onChange(next ?? '')} />;
}

export function SummaryBar({ parts }: { parts: [string, string][] }) {
  return <div className="kgd-summary">{parts.map(([label, value]) => <span key={label} style={label === '欠款' ? { color: '#f5222d' } : undefined}>【{label}】{value}{label.includes('金额') || label.includes('款') || label.includes('费用') || label === '累计收入' || label === '累计支出' || label === '累计付款' ? '元' : ''} </span>)}</div>;
}

export function AuditList({ rows }: { rows: Rec[] }) {
  if (!rows.length) return <div>暂无数据</div>;
  return <div>{rows.map((row) => <div key={row.id ?? `${row.created_at}${row.action}`}>{row.actor_name} {row.action_text} {beijingTime(row.created_at ?? '', '')} {row.opinion}</div>)}</div>;
}

export function openAudit(rows: Rec[]) {
  Modal.info({ title: '审核详情', content: <AuditList rows={rows} />, okText: '关闭' });
}

export function ProductPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (rows: Rec[]) => void }) {
  const { onExpired, revision } = useKgd();
  const [q, setQ] = useState('');
  const [made, setMade] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const products = useRemote<{ items: Rec[] }>(open ? `/api/products?page=1&page_size=100&q=${encodeURIComponent(q)}` : null, revision, onExpired);
  const stock = useRemote<{ items: Rec[] }>(open ? '/api/stock/balances' : null, revision, onExpired);
  const rows = useMemo(() => (products.data?.items ?? []).filter((item) => !made || item.attribute === 'manufactured').map((item) => ({ ...item, id: String(item.id), source: item.attribute === 'purchased' ? '外购' : '自产', stock: sumMoney((stock.data?.items ?? []).filter((row) => String(row.product_id) === String(item.id)).map((row) => String(row.available_qty ?? '0'))) })), [made, products.data, stock.data]);
  function confirm(event?: { stopPropagation?: () => void }) {
    event?.stopPropagation?.();
    onPick(pickByIds(rows, picked));
    setPicked([]);
    onClose();
  }
  return <Modal title="选择商品" open={open} width={860} okText="确 定" cancelText="取 消" onCancel={onClose} onOk={confirm}>
    <div className="kgd-toolbar">
      <Input style={{ width: 220 }} placeholder="商品" value={q} onChange={(event) => setQ(event.target.value)} />
      <label><input type="checkbox" checked={made} onChange={(event) => setMade(event.target.checked)} /> 只看自产</label>
    </div>
    <Table size="small" rowKey="id" pagination={{ pageSize: 10 }} rowSelection={{ preserveSelectedRowKeys: true, selectedRowKeys: picked, onChange: (keys) => setPicked(keys.map(String)) }} dataSource={rows} columns={[
      { title: '商品名', dataIndex: 'name' }, { title: '商品编号', dataIndex: 'code' }, { title: '商品图片', render: () => '' }, { title: '商品规格', dataIndex: 'specification' }, { title: '商品类别', dataIndex: 'category_name' }, { title: '单位', dataIndex: 'unit_name' }, { title: '来源', dataIndex: 'source' }, { title: '库存', dataIndex: 'stock' }, { title: '备注', dataIndex: 'remark' },
    ]} />
  </Modal>;
}

export function LineTable({ lines, onChange, formula, scale, tip, extra, mode, addLabel }: { lines: DraftLine[]; onChange: (lines: DraftLine[]) => void; formula: string; scale: number; tip: string; extra?: ReactNode; mode: 'sale' | 'plan' | 'purchase'; addLabel?: string }) {
  const [open, setOpen] = useState(false);
  function patch(key: string, field: keyof DraftLine, value: string) {
    onChange(lines.map((line) => line.key === key ? { ...line, [field]: value } : line));
  }
  const totals = lines.map((line) => priced(line, formula, scale));
  return <div>
    <div className="kgd-toolbar">
      <Button type="primary" onClick={() => setOpen(true)}>{addLabel ?? `+ 选择${mode === 'sale' ? '合同' : '采购'}商品`}</Button>
      {extra}
      <span className="spacer" style={{ flex: 1 }} />
      <Button danger onClick={() => onChange([])}>清空</Button>
    </div>
    <Table size="small" rowKey="key" pagination={false} dataSource={lines} columns={[
      { title: '序号', render: (_: unknown, __: DraftLine, index: number) => index + 1 },
      ...(mode === 'purchase' ? [{ title: '采购计划编号', dataIndex: 'plan_code' }, { title: '采购计划名称', dataIndex: 'plan_name' }] : []),
      { title: '商品名称', dataIndex: 'product_name' },
      ...(mode === 'purchase' ? [{ title: '合同编号', dataIndex: 'contract_code' }] : []),
      { title: '商品编号', dataIndex: 'product_code' }, { title: '规格', dataIndex: 'specification' }, { title: '商品图片', render: () => '' }, { title: '类别', render: () => '' },
      { title: '单价', render: (_: unknown, row: DraftLine) => <Input value={row.unit_price} onChange={(event) => patch(row.key, 'unit_price', event.target.value)} /> },
      { title: '单位', dataIndex: 'unit_name' },
      { title: <span>金额 <Tooltip title={tip}><span>ⓘ</span></Tooltip></span>, render: (_: unknown, __: DraftLine, index: number) => totals[index]?.amount },
      { title: mode === 'plan' ? '数量' : '销售数量', render: (_: unknown, row: DraftLine) => <Input value={row.quantity} onChange={(event) => patch(row.key, 'quantity', event.target.value)} /> },
      { title: '库存', dataIndex: 'stock' },
      ...(mode === 'plan' ? [] : [
        { title: '折扣', render: (_: unknown, row: DraftLine) => <Input value={row.discount} onChange={(event) => patch(row.key, 'discount', event.target.value)} /> },
        { title: '优惠金额', render: (_: unknown, row: DraftLine) => <Input value={row.concession} onChange={(event) => patch(row.key, 'concession', event.target.value)} /> },
        { title: mode === 'purchase' ? '优惠后金额' : '折后金额', render: (_: unknown, __: DraftLine, index: number) => totals[index]?.net },
      ]),
      { title: '备注', render: (_: unknown, row: DraftLine) => <Input value={row.note} onChange={(event) => patch(row.key, 'note', event.target.value)} /> },
      { title: '操作', render: (_: unknown, row: DraftLine) => <button className="kgd-link" onClick={() => onChange(lines.filter((line) => line.key !== row.key))}>删除</button> },
    ]} />
    <div>合计数量 {sumMoney(lines.map((line) => line.quantity || '0'))}　合计金额 {sumMoney(totals.map((item) => item.net || item.amount))}{totals.some((item) => item.error) ? `　${totals.find((item) => item.error)?.error}` : ''}</div>
    <ProductPicker open={open} onClose={() => setOpen(false)} onPick={(rows) => onChange([...lines, ...rows.map((row) => blankLine({ product_id: row.id, product_name: row.name, product_code: row.code, specification: row.specification, unit_name: row.unit_name, source: row.source, stock: row.stock, unit_price: '0' }))])} />
  </div>;
}

export function toPayload(lines: DraftLine[]) {
  return lines.map((line) => ({ product_id: line.product_id, unit_price: line.unit_price, quantity: line.quantity, discount: line.discount, concession: line.concession, note: line.note, plan_code: line.plan_code, plan_name: line.plan_name, contract_id: line.contract_id || null, contract_code: line.contract_code }));
}

export function DayField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <DatePicker style={{ width: '100%' }} placeholder="请选择日期" value={value ? dayjs(value) : null} onChange={(_, text) => onChange(typeof text === 'string' ? text : '')} />;
}
