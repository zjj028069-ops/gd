import { useEffect, useState } from 'react';
import { Input, InputNumber, Radio, Space } from 'antd';
import { useRemote } from '../../../../masterTools';
import { SettingFrame, SettingItem, SettingSection, SwitchItem, useR10 } from '../shared';

export type PurchaseSettings = {
  show_supplier_info: boolean;
  overdue_remind_days: number;
  refill_basis: 'lower' | 'upper';
  refill_percent: string;
  hide_audit_status: boolean;
  auto_calc: boolean;
  amount_formula: string;
  amount_scale: number;
  inspect_overdue: boolean;
  version?: number;
};

export const purchaseDefaults: PurchaseSettings = {
  show_supplier_info: false,
  overdue_remind_days: 0,
  refill_basis: 'lower',
  refill_percent: '50',
  hide_audit_status: false,
  auto_calc: true,
  amount_formula: '${明细.采购单价}*${明细.采购数量}',
  amount_scale: 8,
  inspect_overdue: false,
};

export function useSettingDraft<T extends object>(path: string, defaults: T) {
  const r10 = useR10();
  const remote = useRemote<{ settings?: Partial<T> }>(path, r10.revision, r10.onExpired);
  const [draft, setDraft] = useState<T>(defaults);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (remote.data?.settings) {
      setDraft({ ...defaults, ...remote.data.settings });
      setHydrated(true);
    } else if (remote.error) {
      setHydrated(true);
    }
  }, [remote.data, remote.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof T>(key: K, value: T[K]) => setDraft((current) => ({ ...current, [key]: value }));
  async function save() {
    await r10.act(path, { ...(draft as Record<string, unknown>) }, 'PUT');
  }
  return { r10, remote, draft, set, save, hydrated };
}

export function usePurchaseSettings() {
  return useSettingDraft<PurchaseSettings>('/api/purchase/settings', purchaseDefaults);
}

export function PurchaseSetting() {
  const { r10, remote, draft, set, save, hydrated } = usePurchaseSettings();
  return <SettingFrame onSave={() => void save()} saving={r10.busy}>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    {!hydrated && !remote.error && <div className="kgd-muted">正在读取数据…</div>}
    <SettingSection title="基础设置">
      <SwitchItem label="采购单展示供应商更多信息" desc="开启后，创建采购单选择供应商时展示联系人、联系方式和地址" value={draft.show_supplier_info} onChange={(value) => set('show_supplier_info', value)} />
      <SettingItem label="采购即将逾期提醒" desc="采购计划/采购单交货日期前 N 天提醒创建人和采购人（每天9点，0不提醒）"><InputNumber min={0} max={365} precision={0} value={draft.overdue_remind_days} onChange={(value) => set('overdue_remind_days', Number(value ?? 0))} addonAfter="天" /></SettingItem>
      <SettingItem label="批量采购数-默认补至">
        <Space>
          <Radio.Group value={draft.refill_basis} onChange={(event) => set('refill_basis', event.target.value)} options={[{ value: 'lower', label: '下限警告值' }, { value: 'upper', label: '上限警告值' }]} />
          <InputNumber<string> min="0" max="1000" precision={2} stringMode value={draft.refill_percent} onChange={(value) => set('refill_percent', value === null ? '0' : String(value))} addonAfter="%" />
        </Space>
      </SettingItem>
      <SwitchItem label="审核状态隐藏" desc="开启后，采购单列表不显示审核状态" value={draft.hide_audit_status} onChange={(value) => set('hide_audit_status', value)} />
      <SwitchItem label="采购单支持自动计算" value={draft.auto_calc} onChange={(value) => set('auto_calc', value)} />
      <SettingItem label="采购单明细金额计算公式">
        <Space direction="vertical" style={{ width: '100%' }}>
          <span>计算公式 <Input style={{ width: 360 }} value={draft.amount_formula} onChange={(event) => set('amount_formula', event.target.value)} /></span>
          <span>小数位数 <InputNumber min={0} max={8} precision={0} value={draft.amount_scale} onChange={(value) => set('amount_scale', Number(value ?? 0))} /></span>
        </Space>
      </SettingItem>
      <SwitchItem label="采购检验单即将逾期设置" value={draft.inspect_overdue} onChange={(value) => set('inspect_overdue', value)} />
    </SettingSection>
  </SettingFrame>;
}
