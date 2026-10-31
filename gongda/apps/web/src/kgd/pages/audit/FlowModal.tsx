import { useEffect, useState } from 'react';
import { App, Button, Modal, Radio, Select, Switch, Tooltip } from 'antd';
import { apiRequest } from '../../../api';
import { useKgd } from '../../context';

type Level = { sign_mode: 'and' | 'or'; approver_ids: string[] };
type User = { id: string; display_name: string };
type ObjectOption = { type: string; name: string; occupied: boolean };

export function FlowModal({ module, flow, onClose }: { module: string; flow: { id?: string; name?: string; allow_withdraw?: boolean; enabled?: boolean; object_types?: string[]; levels?: Level[]; version?: number } | null; onClose: () => void }) {
  const { message } = App.useApp();
  const { session, onChanged } = useKgd();
  const [name, setName] = useState(flow?.name ?? '');
  const [objects, setObjects] = useState<string[]>(flow?.object_types ?? []);
  const [allow, setAllow] = useState(Boolean(flow?.allow_withdraw));
  const [enabled, setEnabled] = useState(flow?.enabled !== false);
  const [levels, setLevels] = useState<Level[]>(flow?.levels?.length ? flow.levels.map((level) => ({ sign_mode: level.sign_mode, approver_ids: level.approver_ids })) : [{ sign_mode: 'and', approver_ids: [] }]);
  const [options, setOptions] = useState<ObjectOption[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    void apiRequest<{ objects: ObjectOption[] }>(`/api/audit/catalog?module=${module}&flow_id=${flow?.id ?? ''}`).then((data) => setOptions(data.objects)).catch(() => undefined);
    void apiRequest<{ items: { id: string; display_name: string }[] }>('/api/platform/members').then((data) => setUsers(data.items.map((item) => ({ id: item.id, display_name: item.display_name })))).catch(() => undefined);
  }, [module, flow?.id]);
  const available = options.filter((item) => !item.occupied || objects.includes(item.type));
  async function save() {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = '请填写审核流程名称';
    if (!objects.length) errors.object_types = '请选择审核对象';
    levels.forEach((level, index) => {
      if (!level.approver_ids.length) errors[`level_${index + 1}`] = `请选择第${index + 1}级审核人`;
    });
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      message.error(Object.values(errors)[0]);
      return;
    }
    const body = { name, module, allow_withdraw: allow, enabled, object_types: objects, levels };
    try {
      if (flow?.id) await apiRequest(`/api/audit/flows/${flow.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body });
      else await apiRequest('/api/audit/flows', { method: 'POST', csrfToken: session.csrf_token, body });
      message.success('已保存');
      onChanged();
      onClose();
    } catch (error) { message.error(error instanceof Error ? error.message : '保存失败'); }
  }
  return <Modal title={flow?.id ? '修改审核流程' : '新增审核流程'} open width={760} onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消">
    <div className="kgd-form">
      <span className={fieldErrors.name ? 'kgd-field-error-label' : undefined}>审核流程名称<em className="kgd-req"> *</em></span>
      <div className={fieldErrors.name ? 'kgd-field-error' : undefined}>
        <input value={name} onChange={(event) => setName(event.target.value)} />
        {fieldErrors.name ? <div className="kgd-field-help">{fieldErrors.name}</div> : null}
      </div>
      <span className={fieldErrors.object_types ? 'kgd-field-error-label' : undefined}>审核对象<em className="kgd-req"> *</em></span>
      <div className={fieldErrors.object_types ? 'kgd-field-error' : undefined}>
        <Select mode="multiple" listHeight={420} style={{ width: '100%' }} value={objects} onChange={setObjects} options={available.map((item) => ({ value: item.type, label: item.name }))} notFoundContent="暂无数据" />
        {fieldErrors.object_types ? <div className="kgd-field-help">{fieldErrors.object_types}</div> : null}
      </div>
      <span>允许撤回 <Tooltip title="开启后，单据支持在未审核前（未有审核数据的待审状态）进行撤回修改；关闭后，单据无法进行撤回修改。"><span>ⓘ</span></Tooltip></span>
      <Switch checked={allow} onChange={setAllow} />
      <span>启用/禁用</span><Switch checked={enabled} onChange={setEnabled} />
      {levels.map((level, index) => <span key={index} style={{ display: 'contents' }}>
        <span className={fieldErrors[`level_${index + 1}`] ? 'kgd-field-error-label' : undefined}>第{index + 1}级审核<em className="kgd-req"> *</em></span>
        <div className={fieldErrors[`level_${index + 1}`] ? 'kgd-field-error' : undefined}>
          <Radio.Group value={level.sign_mode} onChange={(event) => setLevels(levels.map((item, itemIndex) => itemIndex === index ? { ...item, sign_mode: event.target.value } : item))}>
            <Radio value="and">会签</Radio><Radio value="or">或签</Radio>
          </Radio.Group>
          <Select mode="multiple" style={{ minWidth: 240, marginLeft: 8 }} value={level.approver_ids} onChange={(approver_ids) => setLevels(levels.map((item, itemIndex) => itemIndex === index ? { ...item, approver_ids } : item))} options={users.map((user) => ({ value: user.id, label: user.display_name }))} />
          {index > 0 && <Button type="link" danger onClick={() => setLevels(levels.filter((_, itemIndex) => itemIndex !== index))}>⊖</Button>}
          {fieldErrors[`level_${index + 1}`] ? <div className="kgd-field-help">{fieldErrors[`level_${index + 1}`]}</div> : null}
        </div>
      </span>)}
      <span /><Button type="link" onClick={() => setLevels([...levels, { sign_mode: 'and', approver_ids: [] }])}>+ 点击添加多级审核</Button>
    </div>
  </Modal>;
}
