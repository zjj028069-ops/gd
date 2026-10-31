import { useState } from 'react';
import { App, Button, DatePicker, Form, Input, Modal, Radio, Select } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import type { ListColumn } from '../../ListFrame';
import { showError, useCommand, useQueryState, beijingTime } from '../../kit';
import { downloadCsv } from '../../wage';
import { Bars, dash, StatusTag } from '../round8/kit';

export { DefectTrendPage } from './trend';

type Rec = Record<string, string> & { id: string; defect_item_ids?: string[] };

export function DefectList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/quality/defects', revision, onExpired);
  const [open, setOpen] = useState(() => !!new URLSearchParams(window.location.search).get('add'));
  const [editing, setEditing] = useState<Rec | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const rows = (remote.data?.items ?? []).filter((row) => !list.query.code || row.code.includes(list.query.code)).filter((row) => !list.query.name || row.name.includes(list.query.name));
  const columns: ListColumn<Rec>[] = [
    { key: 'code', title: '不良品项编号', render: (row) => row.code },
    { key: 'name', title: '不良品项名称', render: (row) => row.name },
    { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at, '') },
    { key: 'actions', title: '操作', width: 140, render: (row) => <span onClick={(event) => event.stopPropagation()}>
      <Button type="link" onClick={() => { setEditing(row); setCode(row.code); setName(row.name); setOpen(true); }}>修改</Button>
      <Button type="link" onClick={() => void command.send(`/api/quality/defects/${row.id}`, {}, 'DELETE').then(() => message.success('已删除')).catch((error) => message.error(showError(error)))}>删除</Button>
    </span> },
  ];
  async function save() {
    if (!name.trim()) { command.setFieldError('name', '请填写不良品项名称'); return; }
    try {
      if (editing) await command.send(`/api/quality/defects/${editing.id}`, { code, name }, 'PATCH');
      else await command.send('/api/quality/defects', { code, name });
      setOpen(false);
      message.success('已保存');
    } catch (error) { message.error(showError(error)); }
  }
  return <>
    <ListFrame pageKey="waste-item" columns={columns} rows={rows} loading={remote.loading} error={remote.error} queryFields={[{ key: 'code', label: '编号' }, { key: 'name', label: '名称' }, { key: 'from', label: '创建时间起', kind: 'date' }, { key: 'to', label: '创建时间止', kind: 'date' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => { setEditing(null); setCode(''); setName(''); setOpen(true); }}>新增</Button>}
      summary={<span>共{rows.length}条</span>} />
    <Modal title={editing ? '修改不良品项' : '新增不良品项'} open={open} onCancel={() => setOpen(false)} onOk={() => void save()} okText="确定" cancelText="取消" confirmLoading={command.busy}>
      <div className="kgd-form"><span>不良品项编号</span><Input placeholder="请填写，忽略将自动生产" value={code} onChange={(event) => setCode(event.target.value)} /><span>不良品项名称 *</span><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
    </Modal>
  </>;
}

export function FullInspection() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const status = list.chips.status || '全部';
  const rework = list.chips.rework || '全部';
  const remote = useRemote<{ items: Rec[]; counts: { pending: number; done: number; reworked: number; open: number } }>(`/api/quality/inspections?status=${encodeURIComponent(status)}&rework=${encodeURIComponent(rework)}`, revision, onExpired);
  const defects = useRemote<{ items: { id: string; name: string }[] }>('/api/quality/defects', revision, onExpired);
  const [row, setRow] = useState<Rec | null>(null);
  const [quality, setQuality] = useState('已质检');
  const [note, setNote] = useState('');
  const [defect, setDefect] = useState('0');
  const [reworkQty, setReworkQty] = useState('0');
  const [scrap, setScrap] = useState('0');
  const [picked, setPicked] = useState<string[]>([]);
  const counts = remote.data?.counts;
  const columns: ListColumn<Rec>[] = [
    { key: 'product_code', title: '商品编号', render: (item) => dash(item.product_code) },
    { key: 'product_name', title: '商品名', render: (item) => dash(item.product_name) },
    { key: 'spec', title: '商品规格', render: (item) => dash(item.product_spec) },
    { key: 'process', title: '工序名', render: (item) => dash(item.process_name) },
    { key: 'process_code', title: '工序编号', render: (item) => dash(item.process_code) },
    { key: 'order', title: '加工单', render: (item) => dash(item.work_order_code) },
    { key: 'good', title: '良品数', render: (item) => dash(item.good_qty) },
    { key: 'defect', title: '不良品数', render: (item) => dash(item.defect_qty) },
    { key: 'items', title: '不良品项', render: (item) => dash(item.defect_names) },
    { key: 'machine', title: '机台', render: (item) => dash(item.machine_name) },
    { key: 'operator', title: '生产人员', render: (item) => dash(item.operator_name) },
    { key: 'rework', title: '返工数', render: (item) => dash(item.rework_qty) },
    { key: 'scrap', title: '报废数', render: (item) => dash(item.scrap_qty) },
    { key: 'task', title: '返工任务', render: (item) => dash(item.rework_task_code) },
    // pages.json P058 无「操作」列；质检入口挂在状态列，避免 exact 对齐被 ListFrame 丢掉后验收点不到
    { key: 'status', title: '质检状态', render: (item) => <span><StatusTag text={item.quality_text} /><Button type="link" onClick={() => { setRow(item); setQuality(item.quality_text === '待质检' ? '已质检' : item.quality_text); setNote(item.quality_note || ''); setDefect(item.defect_qty || '0'); setReworkQty(item.rework_qty || '0'); setScrap(item.scrap_qty || '0'); setPicked(item.defect_item_ids ?? []); }}>质检</Button></span> },
    { key: 'reworked', title: '已返工', render: (item) => dash(item.rework_text) },
    { key: 'qnote', title: '质检备注', render: (item) => dash(item.quality_note) },
    { key: 'quser', title: '质检人', render: (item) => dash(item.quality_name) },
  ];
  async function submit() {
    if (!row) return;
    try {
      await command.send(`/api/quality/inspections/${row.id}`, { quality_status: quality, quality_note: note, defect_qty: defect, rework_qty: reworkQty, scrap_qty: scrap, defect_item_ids: picked });
      setRow(null);
      message.success('已提交');
    } catch (error) { message.error(showError(error)); }
  }
  return <>
    <ListFrame pageKey="full-qc" showMobileCard columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error}
      chips={[
        { key: 'status', label: '质检状态', options: [{ value: '全部', label: '全部' }, { value: '待质检', label: `待质检(${counts?.pending ?? 0})` }, { value: '已质检', label: `已质检(${counts?.done ?? 0})` }] },
        { key: 'rework', label: '返工状态', options: [{ value: '全部', label: '全部' }, { value: '已返工', label: `已返工(${counts?.reworked ?? 0})` }, { value: '未返工', label: `未返工(${counts?.open ?? 0})` }] },
      ]}
      chipValue={{ status, rework }} onChip={list.onChip}
      queryFields={[{ key: 'q', label: '加工单' }, { key: 'product', label: '商品' }, { key: 'process', label: '工序名' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} />
    <Modal title={`质检 [${row?.process_name ?? ''}]`} open={!!row} onCancel={() => setRow(null)} onOk={() => void submit()} okText="提交" cancelText="取消" confirmLoading={command.busy} width={720}>
      <div className="kgd-form">
        <span>生产人员 *</span><Input disabled value={row?.operator_name} />
        <span>机台</span><Input disabled value={dash(row?.machine_name)} />
        <span>良品数</span><Input disabled value={row?.good_qty} />
        <span>不良品数</span><Input value={defect} onChange={(event) => setDefect(event.target.value)} />
        <span>不良品项</span><Select mode="multiple" showSearch optionFilterProp="label" placeholder="点击选择不良品项" value={picked} onChange={setPicked} options={(defects.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
        <span>质检状态 *</span><Radio.Group value={quality} onChange={(event) => setQuality(event.target.value)} options={[{ value: '已质检', label: '已质检' }, { value: '待质检', label: '待质检' }]} />
        <span>质检备注 *</span><Input value={note} onChange={(event) => setNote(event.target.value)} />
        <span>不良品数 *</span><Input value={defect} onChange={(event) => setDefect(event.target.value)} />
        <span>返工数 *</span><Input value={reworkQty} onChange={(event) => setReworkQty(event.target.value)} placeholder="返工数量大于0，系统将自动创建返工任务" />
        <span>报废数 *</span><Input value={scrap} onChange={(event) => setScrap(event.target.value)} />
      </div>
    </Modal>
  </>;
}

export function SpotCheckList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/quality/spot-checks', revision, onExpired);
  const processes = useRemote<{ items: { id: string; name: string; code: string }[] }>('/api/processes', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [qty, setQty] = useState('');
  const [processId, setProcessId] = useState('');
  const [note, setNote] = useState('');
  const columns: ListColumn<Rec>[] = [
    { key: 'code', title: '质检单号', render: (row) => row.code },
    { key: 'order', title: '加工单号', render: (row) => dash(row.work_order_code) },
    { key: 'process', title: '工序名', render: (row) => dash(row.process_name) },
    { key: 'process_code', title: '工序编号', render: (row) => dash(row.process_code) },
    { key: 'product', title: '商品', render: (row) => dash(row.product_name) },
    { key: 'qty', title: '抽检数量', render: (row) => dash(row.qty) },
    { key: 'good', title: '良品数', render: (row) => dash(row.good_qty) },
    { key: 'defect', title: '不良品数', render: (row) => dash(row.defect_qty) },
    { key: 'status', title: '质检状态', render: (row) => <StatusTag text={row.quality_status} /> },
    { key: 'note', title: '备注', render: (row) => dash(row.note) },
    { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
  ];
  return <>
    <ListFrame pageKey="spot-check" showMobileCard columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'code', label: '质检单号' }, { key: 'process', label: '工序名' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>} />
    <Modal title="新增" open={open} onCancel={() => setOpen(false)} onOk={() => void command.send('/api/quality/spot-checks', { code, qty, process_id: processId, note }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))} okText="确定" cancelText="取消">
      <div className="kgd-form">
        <span>质检单号</span><Input placeholder="请填写，忽略将自动生成" value={code} onChange={(event) => setCode(event.target.value)} />
        <span>抽检数量 *</span><Input value={qty} onChange={(event) => setQty(event.target.value)} />
        <span>工序 *</span><Select showSearch optionFilterProp="label" placeholder="点击选择工序" value={processId || undefined} onChange={setProcessId} options={(processes.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
        <span>备注</span><Input value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
    </Modal>
  </>;
}

function labeledId(raw: string, options: { value: string }[]) {
  return options.some((item) => item.value === raw) ? raw : '';
}

export function SpotLineList() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const components = useRemote<{ items: { id: string; name: string }[] }>('/api/quality/components', revision, onExpired);
  const search = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const options = (components.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }));
  const componentId = list.query.component || search?.get('component') || '';
  const shown = labeledId(componentId, options) || labeledId(list.draft.component || '', options);
  const remote = useRemote<{ items: Rec[]; hint: string }>(componentId ? `/api/quality/spot-lines?component_id=${componentId}` : null, revision, onExpired);
  const columns: ListColumn<Rec>[] = ['质检单号', '加工单', '工序名', '工序编号', '抽检数量', '良品数', '不良品数', '质检状态', '创建时间'].map((title, index) => {
    const keys = ['code', 'work_order_code', 'process_name', 'process_code', 'qty', 'good_qty', 'defect_qty', 'quality_status', 'created_at'];
    return { key: keys[index]!, title, render: (row: Rec) => dash(row[keys[index]!]) };
  });
  return <ListFrame pageKey="spot-lines" columns={columns} rows={componentId ? (remote.data?.items ?? []) : []} loading={remote.loading} error={remote.error} emptyDescription={componentId ? '暂无数据' : '请选择质检附加组件以查看明细数据'}
    queryFields={[{ key: 'component', label: '质检附加组件', kind: 'select', options }]} queryValue={{ ...list.draft, ...(shown && !list.draft.component ? { component: shown } : {}) }} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={componentId ? (remote.data?.items.length ?? 0) : 0} onPage={list.onPage} />;
}

export function SpecList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/quality/specs', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<{ name: string; description: string; field_type: string; required: boolean }[]>([{ name: '', description: '', field_type: '文本', required: true }, { name: '', description: '', field_type: '数字', required: false }]);
  const columns: ListColumn<Rec>[] = [
    { key: 'name', title: '检验规范', render: (row) => row.name },
    { key: 'items', title: '检查项', render: (row) => dash(row.item_text) },
    { key: 'note', title: '备注', render: (row) => dash(row.note) },
    { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
    { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at, '') },
  ];
  return <>
    <ListFrame pageKey="qc-spec" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'name', label: '检验规范' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>} />
    <Modal title="新增检验规范" open={open} width={760} onCancel={() => setOpen(false)} okText="确定" cancelText="取消" confirmLoading={command.busy} onOk={() => {
      if (!name.trim()) { command.setFieldError('name', '请填写检验规范名称'); return; }
      void command.send('/api/quality/specs', { name, note, items: items.filter((item) => item.name.trim()) }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)));
    }}>
      <Form layout="vertical">
        <Form.Item label="检验规范" required validateStatus={command.fieldErrors.name ? 'error' : undefined} help={command.fieldErrors.name}><Input value={name} onChange={(event) => setName(event.target.value)} /></Form.Item>
        <Form.Item label="备注"><Input placeholder="备注" value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
        <Form.Item label="商品"><Input placeholder="商品" /></Form.Item>
      </Form>
      <p>删除检查项，将删除检验记录中对应字段的数据。</p>
      <Button onClick={() => setItems([...items, { name: '', description: '', field_type: '文本', required: false }])}>新增检查项</Button>
      {items.map((item, index) => <div key={index} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Input placeholder="检查项" value={item.name} onChange={(event) => setItems(items.map((current, i) => i === index ? { ...current, name: event.target.value } : current))} />
        <Input placeholder="检查项说明" value={item.description} onChange={(event) => setItems(items.map((current, i) => i === index ? { ...current, description: event.target.value } : current))} />
        <Select style={{ width: 100 }} value={item.field_type} onChange={(value) => setItems(items.map((current, i) => i === index ? { ...current, field_type: value } : current))} options={['文本', '数字', '是否', '单选'].map((value) => ({ value, label: value }))} />
      </div>)}
    </Modal>
  </>;
}

export function PurchaseTestList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/quality/purchase-tests', revision, onExpired);
  const orders = useRemote<{ items: { id: string; code: string }[] }>('/api/money/purchase-orders', revision, onExpired);
  const specs = useRemote<{ items: { id: string; name: string }[] }>('/api/quality/specs', revision, onExpired);
  const products = useRemote<{ items: { id: string; name: string; code: string }[] }>('/api/products', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [orderId, setOrderId] = useState('');
  const [specId, setSpecId] = useState('');
  const [productId, setProductId] = useState('');
  const [send, setSend] = useState('1');
  const [pass, setPass] = useState('');
  const [fail, setFail] = useState('');
  const [current, setCurrent] = useState('');
  const columns: ListColumn<Rec>[] = [
    { key: 'code', title: '检验单号', render: (row) => row.code },
    { key: 'spec', title: '检验规范', render: (row) => dash(row.spec_name) },
    { key: 'purchase', title: '采购单号', render: (row) => dash(row.purchase_code) },
    { key: 'product', title: '商品名', render: (row) => dash(row.product_name) },
    { key: 'product_code', title: '商品编号', render: (row) => dash(row.product_code) },
    { key: 'supplier', title: '供应商', render: (row) => dash(row.supplier_name) },
    { key: 'progress', title: '检验进度', render: (row) => dash(row.progress) },
    { key: 'send', title: '送检数量', render: (row) => dash(row.send_qty) },
    { key: 'pass', title: '合格数', render: (row) => dash(row.pass_qty) },
    { key: 'fail', title: '不合格数', render: (row) => dash(row.fail_qty) },
    { key: 'rate', title: '合格率(%)', render: (row) => dash(row.pass_rate) },
    { key: 'actions', title: '操作', render: (row) => <Button type="link" onClick={() => { setCurrent(row.id); setPass(row.pass_qty); setFail(row.fail_qty); }}>填写结果</Button> },
  ];
  return <>
    <ListFrame pageKey="purchase-test" showMobileCard columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'code', label: '检验单号' }, { key: 'purchase', label: '采购单号' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>} />
    <Modal title="新增检验单" open={open} onCancel={() => setOpen(false)} okText="提交" cancelText="关闭" onOk={() => void command.send('/api/quality/purchase-tests', { code, purchase_order_id: orderId, spec_id: specId, product_id: productId, send_qty: send }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <div className="kgd-form">
        <span>检验单号</span><Input placeholder="请填写，忽略将自动生成" value={code} onChange={(event) => setCode(event.target.value)} />
        <span>采购单 *</span><Select placeholder="点击选择采购单" value={orderId || undefined} onChange={setOrderId} options={(orders.data?.items ?? []).map((item) => ({ value: item.id, label: item.code }))} />
        <span>商品</span><Select allowClear placeholder="商品" value={productId || undefined} onChange={setProductId} options={(products.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
        <span>检验规范</span><Select allowClear value={specId || undefined} onChange={setSpecId} options={(specs.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} />
        <span>送检数量</span><Input value={send} onChange={(event) => setSend(event.target.value)} />
        <span>完成日期</span><DatePicker style={{ width: '100%' }} placeholder="完成日期" />
        <span>检验人</span><Input placeholder="检验人" />
      </div>
    </Modal>
    <Modal title="填写合格/不合格" open={!!current} onCancel={() => setCurrent('')} onOk={() => void command.send(`/api/quality/purchase-tests/${current}`, { pass_qty: pass || '0', fail_qty: fail || '0' }, 'PATCH').then(() => { setCurrent(''); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <Input style={{ marginBottom: 8 }} placeholder="合格数" value={pass} onChange={(event) => setPass(event.target.value)} />
      <Input placeholder="不合格数" value={fail} onChange={(event) => setFail(event.target.value)} />
    </Modal>
  </>;
}

export function PurchaseLineList() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const specs = useRemote<{ items: { id: string; name: string }[] }>('/api/quality/specs', revision, onExpired);
  const search = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const options = (specs.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }));
  const specId = list.query.spec || search?.get('spec') || '';
  const shown = labeledId(specId, options) || labeledId(list.draft.spec || '', options);
  const remote = useRemote<{ items: Rec[]; hint: string }>(specId ? `/api/quality/purchase-lines?spec_id=${specId}` : null, revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    { key: 'code', title: '检验单号', render: (row) => dash(row.code) },
    { key: 'purchase', title: '采购单号', render: (row) => dash(row.purchase_code) },
    { key: 'product', title: '商品名称', render: (row) => dash(row.product_name) },
    { key: 'item', title: '检查项', render: (row) => dash(row.item_name) },
    { key: 'pass', title: '合格数', render: (row) => dash(row.pass_qty) },
    { key: 'fail', title: '不合格数', render: (row) => dash(row.fail_qty) },
  ];
  return <ListFrame pageKey="purchase-lines" columns={columns} rows={specId ? (remote.data?.items ?? []) : []} loading={remote.loading} error={remote.error} emptyDescription={specId ? '暂无数据' : '请选择检验规范以查看明细数据'} queryFields={[{ key: 'spec', label: '检验规范', kind: 'select', options }]} queryValue={{ ...list.draft, ...(shown && !list.draft.spec ? { spec: shown } : {}) }} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={specId ? (remote.data?.items.length ?? 0) : 0} onPage={list.onPage} />;
}

function periodChips(value: string, onChange: (value: string) => void, names = ['昨天', '今天', '本周', '本月', '本季度', '本年']) {
  return <div className="kgd-chips"><b>统计时间</b>{names.map((item) => <button key={item} type="button" className={`kgd-chip ${value === item ? 'on' : ''}`} onClick={() => onChange(item)}>{item}</button>)}</div>;
}

export function QualityReport({ kind }: { kind: 'pareto' | 'detail' | 'purchase' | 'spot' | 'scrap' }) {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const [period, setPeriod] = useState(kind === 'pareto' ? '本年' : '本月');
  const path = { pareto: '/api/quality/reports/pareto', detail: '/api/quality/reports/defect-detail', purchase: '/api/quality/reports/purchase', spot: '/api/quality/reports/spot', scrap: '/api/quality/reports/scrap' }[kind];
  const remote = useRemote<{ items: Rec[]; summary?: string }>(`${path}?period=${encodeURIComponent(period)}`, revision, onExpired);
  const rows = remote.data?.items ?? [];
  const named: Record<string, [string, string][]> = {
    detail: [
      ['seq', '序号'], ['product_code', '产品编号'], ['product_name', '产品名称'], ['specification', '产品规格'], ['unit_name', '产品单位'],
      ['work_order_code', '加工单号'], ['plan_qty', '计划数'], ['wo_plan_start', '加工单计划开始'], ['wo_plan_end', '加工单计划结束'],
      ['process_name', '工序名称'], ['process_code', '工序编号'], ['unit_ratio', '单位关系'], ['task_status', '任务状态'],
      ['task_plan_start', '任务计划开始'], ['task_plan_end', '任务计划结束'], ['operator_name', '生产人员'], ['standard_minutes', '标准工时'],
      ['report_qty', '报工数'], ['good_qty', '良品数'], ['defect_qty', '不良品数'], ['rate', '不良品率'], ['quality_time', '质检时间'],
      ['report_unit', '单位'], ['report_start', '报工开始时间'], ['report_end', '报工结束时间'], ['report_duration', '报工时长'],
      ['pricing_mode', '计价方式'], ['wage_rate', '工资单价'], ['settlement_status', '结算状态'], ['settler_name', '结算人'],
    ],
    purchase: [
      ['product_name', '商品名'], ['product_code', '商品编号'], ['specification', '商品规格'], ['product_image', '商品图片'],
      ['category_name', '商品类别'], ['unit_name', '单位'], ['purchase_qty', '采购数量'], ['send_qty', '送检数量'],
      ['checked_qty', '已检数量'], ['pass_qty', '合格数'], ['fail_qty', '不合格数'], ['fail_rate', '不合格率(%)'],
    ],
    spot: [
      ['process_name', '工序名'], ['process_code', '工序编号'], ['shop_name', '车间'], ['line_name', '产线'],
      ['qty', '抽检数量'], ['good_qty', '良品数'], ['defect_qty', '不良品数'], ['rate', '不良品率(%)'],
    ],
    scrap: [
      ['product_name', '商品名'], ['product_code', '商品编号'], ['specification', '商品规格'], ['category_name', '类别'],
      ['report_qty', '报工数'], ['good_qty', '良品数'], ['defect_qty', '不良品数'], ['scrap_qty', '报废数'],
      ['scrap_rate', '报废率(%)'], ['scrap_of_defect', '报废占不良比(%)'], ['rework_qty', '返工数'],
      ['rework_rate', '返工率(%)'], ['rework_of_defect', '返工占不良比(%)'],
    ],
  };
  const filters: Record<string, { key: string; label: string }[]> = {
    pareto: [
      { key: 'product_code', label: '产品编号' }, { key: 'product_name', label: '产品名' },
      { key: 'process', label: '工序名' }, { key: 'defect_item', label: '不良品项' }, { key: 'operator', label: '生产人员' },
    ],
    detail: [],
    purchase: [{ key: 'product', label: '商品名' }, { key: 'product_code', label: '商品编号' }, { key: 'spec', label: '商品规格' }],
    spot: [{ key: 'process', label: '工序名' }],
    scrap: [{ key: 'product', label: '商品名' }, { key: 'product_code', label: '商品编号' }, { key: 'spec', label: '商品规格' }, { key: 'category', label: '类别' }],
  };
  const columns: ListColumn<Rec>[] = kind === 'pareto'
    ? [
      { key: 'seq', title: '序号', render: (row, index) => dash(row.seq || String((index ?? 0) + 1)) },
      { key: 'code', title: '工序编号', render: (row) => dash(row.process_code) },
      { key: 'name', title: '工序名称', render: (row) => dash(row.process_name) },
      { key: 'report', title: '报工数', render: (row) => dash(row.report_qty) },
      { key: 'good', title: '良品数', render: (row) => dash(row.good_qty) },
      { key: 'defect', title: '不良品数', render: (row) => dash(row.defect_qty) },
      { key: 'rate', title: '不良品率', render: (row) => dash(row.rate) },
    ]
    : (named[kind] ?? []).map(([key, title]) => ({
      key,
      title,
      render: (row: Rec, index?: number) => key === 'seq' ? dash(row.seq || String((index ?? 0) + 1)) : dash(row[key]),
    }));
  const exportNames = { pareto: '不良品柏拉图', detail: '不良品项明细', purchase: '采购检验分析', spot: '生产抽检分析', scrap: '报废返工统计' };
  return <div>
    {periodChips(period, setPeriod, kind === 'pareto' ? ['本周', '本月', '本季度', '本年'] : undefined)}
    {remote.data?.summary && <p>{remote.data.summary}</p>}
    {kind === 'pareto' && <Bars rows={rows.map((row) => ({ name: row.name || row.process_name, qty: row.qty || row.defect_qty }))} />}
    <ListFrame
      pageKey={`qc-report-${kind}`}
      exportName={exportNames[kind]}
      columns={columns}
      rows={rows}
      loading={remote.loading}
      error={remote.error}
      queryFields={filters[kind]}
      queryValue={list.draft}
      onQuery={list.onQuery}
      onSearch={list.onSearch}
      onClear={list.onClear}
      toolbar={kind === 'detail' ? <Button onClick={() => downloadCsv(`${exportNames.detail}.csv`, (named.detail ?? []).map(([, title]) => title), rows.map((row, index) => (named.detail ?? []).map(([key]) => key === 'seq' ? String(row.seq || index + 1) : String(row[key] ?? ''))))}>导出</Button> : undefined}
      page={list.page}
      pageSize={list.pageSize}
      total={rows.length}
      onPage={list.onPage}
    />
  </div>;
}
