import { SettingFrame, SettingSection, SwitchItem } from '../shared';
import { useSettingDraft } from './PurchaseSetting';

export function SupplierSetting() {
  const { r10, remote, draft, set, save } = useSettingDraft<{ supplier_duplicate_name: boolean; supplier_unique_phone: boolean; version?: number }>('/api/purchase/supplier-settings', { supplier_duplicate_name: false, supplier_unique_phone: true });
  return <SettingFrame onSave={() => void save()} saving={r10.busy}>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <SettingSection title="基础设置">
      <SwitchItem label="供应商重名检查" desc="开启后，新增或修改供应商时名称不能与已有供应商相同" value={draft.supplier_duplicate_name} onChange={(value) => set('supplier_duplicate_name', value)} />
      <SwitchItem label="供应商手机号不允许重复" desc="开启后，新增或修改供应商时手机号不能与已有供应商相同" value={draft.supplier_unique_phone} onChange={(value) => set('supplier_unique_phone', value)} />
    </SettingSection>
  </SettingFrame>;
}
