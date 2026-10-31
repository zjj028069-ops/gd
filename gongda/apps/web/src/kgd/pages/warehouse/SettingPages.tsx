import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Input, InputNumber, Modal, Switch, Table } from 'antd';
import { useRemote } from '../../../masterTools';
import { showError } from '../../kit';
import { MemberSelect } from '../money/shared';
import { useWarehouseApi } from './useWarehouseApi';
import type { WhRec } from './useWarehouseApi';

export function StockSettingPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const api = useWarehouseApi();
  const remote = useRemote<{ settings: WhRec; io_types: WhRec[] }>('/api/warehouse/settings', api.revision, api.onExpired);
  const [draft, setDraft] = useState<WhRec | null>(null);
  const settings = (draft ?? remote.data?.settings ?? {}) as WhRec;
  const ioTypes = remote.data?.io_types ?? [];
  const inbound = useMemo(() => ioTypes.filter((t) => t.direction === 'in'), [ioTypes]);
  const outbound = useMemo(() => ioTypes.filter((t) => t.direction === 'out'), [ioTypes]);
  const [newIn, setNewIn] = useState('');
  const [newOut, setNewOut] = useState('');
  const [typeOpen, setTypeOpen] = useState(false);
  const [typeName, setTypeName] = useState('');
  const [typeErr, setTypeErr] = useState('');
  function patch(key: string, value: unknown) { setDraft((current) => ({ ...(remote.data?.settings ?? {}), ...(current ?? {}), [key]: value } as WhRec)); }
  async function save() {
    try {
      await api.send('/api/warehouse/settings', settings as Record<string, unknown>, 'PUT');
      message.success('已保存');
      setDraft(null);
    } catch (error) { message.error(showError(error)); }
  }
  async function addType(direction: 'in' | 'out', name: string) {
    if (!name.trim()) { message.error('请填写名称'); return; }
    try {
      await api.send('/api/warehouse/io-types', { direction, name });
      setNewIn(''); setNewOut('');
    } catch (error) { message.error(showError(error)); }
  }
  return <div className="kgd-card">
    <div className="kgd-toolbar"><Button onClick={() => navigate(-1)}>⮌ 返回</Button><Button type="primary" onClick={() => { setTypeName(''); setTypeErr(''); setTypeOpen(true); }}>新增</Button><Button type="primary" loading={api.busy} onClick={() => void save()}>保 存</Button></div>
    <div className="wh-setting-grid">
      <div className="wh-setting-card">
        <h3>基础设置</h3>
        <SettingRow label="成品入库允许入库数量大于加工单计划数" tip="开启后允许成品入库累计超过加工单计划数；关闭后，本加工单成品入库累计（含本次）大于计划数时将报错拦截。默认开启。"><Switch checked={!!settings.limit_fg_in} onChange={(v) => patch('limit_fg_in', v)} /></SettingRow>
        <SettingRow label="审核状态隐藏" tip="开启后，当出入库单据没有审核流程时，不展示审核状态。"><Switch checked={!!settings.hide_audit_status} onChange={(v) => patch('hide_audit_status', v)} /></SettingRow>
        <SettingRow label="销售出库单（合同出库）出库数量限制" tip="开启此功能，限制销售出库单的出库数量不能超过合同中的销售数量；关闭该功能，销售出库数不受限制。"><Switch checked={!!settings.limit_contract_out} onChange={(v) => patch('limit_contract_out', v)} /></SettingRow>
        <SettingRow label="采购入库数量限制" tip="开启此功能，限制采购入库单的入库数量不能超过采购数量；关闭该功能，采购入库数不受限制"><Switch checked={!!settings.limit_purchase_in} onChange={(v) => patch('limit_purchase_in', v)} /></SettingRow>
        <SettingRow label="退货单展示供应商更多信息" tip="开启后，创建退货单，选择供应商时，展示供应商的联系人、联系方式和地址。"><Switch checked={!!settings.return_supplier_detail} onChange={(v) => patch('return_supplier_detail', v)} /></SettingRow>
        <SettingRow label="仓库库存报警" tip="仓库库存超出库存阈值范围之外时，需要提醒下方人员（未设置提醒人则不提醒）。"><MemberSelect revision={api.revision} value={String((settings.alert_user_ids as string[] | undefined)?.[0] ?? '')} onChange={(id) => patch('alert_user_ids', id ? [id] : [])} /></SettingRow>
        <FormulaRow label="采购入库单明细金额计算公式" formulaKey="formula_purchase_in" scale={settings} patch={patch} defaultFormula="${明细.采购单价}*${明细.采购数量}" />
        <FormulaRow label="采购退货单明细金额计算公式" formulaKey="formula_purchase_return" scale={settings} patch={patch} defaultFormula="${明细.采购单价}*${明细.退货数量}" />
        <FormulaRow label="销售出库单明细金额计算公式" formulaKey="formula_sale_out" scale={settings} patch={patch} defaultFormula="${明细.销售单价}*${明细.销售数量}" />
        <FormulaRow label="销售退货单明细金额计算公式" formulaKey="formula_sale_return" scale={settings} patch={patch} defaultFormula="${明细.销售单价}*${明细.退货数量}" />
      </div>
      <div>
        <IoCard title="入库类型" rows={inbound} newName={newIn} onNewName={setNewIn} onAdd={() => void addType('in', newIn)} api={api} />
        <IoCard title="出库类型" rows={outbound} newName={newOut} onNewName={setNewOut} onAdd={() => void addType('out', newOut)} api={api} />
      </div>
    </div>
    <Modal title="新增出入库类型" open={typeOpen} onCancel={() => setTypeOpen(false)} okText="确定" cancelText="取消" onOk={() => {
      if (!typeName.trim()) { setTypeErr('请填写名称'); return; }
      setTypeErr('');
      void addType('in', typeName).then(() => setTypeOpen(false));
    }}>
      {typeErr ? <div className="kgd-banner kgd-field-error">{typeErr}</div> : null}
      <span className={typeErr ? 'kgd-field-error-label' : undefined}>名称</span>
      <Input className={typeErr ? 'kgd-field-error' : undefined} placeholder="请输入名称" value={typeName} onChange={(e) => { setTypeErr(''); setTypeName(e.target.value); }} />
    </Modal>
  </div>;
}

function SettingRow({ label, tip, children }: { label: string; tip: string; children: ReactNode }) {
  return <div style={{ marginBottom: 12 }}><div><b>{label}</b></div><div className="wh-form-tip">{tip}</div>{children}</div>;
}

function FormulaRow({ label, formulaKey, scale, patch, defaultFormula }: { label: string; formulaKey: string; scale: WhRec; patch: (k: string, v: unknown) => void; defaultFormula: string }) {
  return <div style={{ marginBottom: 12 }}>
    <div><b>{label}</b></div>
    <Input value={String(scale[formulaKey] ?? defaultFormula)} onChange={(e) => patch(formulaKey, e.target.value)} />
    <span>小数位数 </span><InputNumber min={0} max={8} value={Number(scale.amount_scale ?? 8)} onChange={(v) => patch('amount_scale', v ?? 8)} />
  </div>;
}

function IoCard({ title, rows, newName, onNewName, onAdd, api }: { title: string; rows: WhRec[]; newName: string; onNewName: (v: string) => void; onAdd: () => void; api: ReturnType<typeof useWarehouseApi> }) {
  const { message } = App.useApp();
  async function rename(row: WhRec) {
    const name = window.prompt('名称', String(row.name ?? ''));
    if (!name?.trim()) { message.error('请填写名称'); return; }
    try { await api.send(`/api/warehouse/io-types/${row.id}`, { name }, 'PATCH'); } catch (error) { message.error(showError(error)); }
  }
  async function remove(row: WhRec) {
    try { await api.send(`/api/warehouse/io-types/${row.id}`, {}, 'DELETE'); } catch (error) { message.error(showError(error)); }
  }
  return <div className="wh-setting-card" style={{ marginBottom: 16 }}>
    <h3>{title}</h3>
    <Table size="small" pagination={false} rowKey="id" dataSource={rows} columns={[
      { title: '排序', render: () => '≡' },
      { title: '名称', dataIndex: 'name' },
      { title: '操作', render: (_, row) => <span><button type="button" className="kgd-link" onClick={() => void rename(row)}>修改</button> <button type="button" className="kgd-link" onClick={() => void remove(row)}>删除</button></span> },
    ]} />
    <div className="kgd-toolbar"><Input placeholder="请输入名称" value={newName} onChange={(e) => onNewName(e.target.value)} /><Button onClick={onAdd}>添 加</Button></div>
  </div>;
}
