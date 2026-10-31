import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, InputNumber, Radio, Select, Switch, Table } from 'antd';
import { useEquipApi, useRemote, type Rec } from './shared';

type Settings = {
  export_repair_image?: boolean;
  export_record_image?: boolean;
  scan_login?: boolean;
  scan_dispatch?: string;
  scan_dispatch_label?: string;
  scan_repair?: boolean;
  repair_audit?: boolean;
  all_spares?: boolean;
  hide_shop?: boolean;
  status_follow_repair?: boolean;
  default_result?: string;
  alarm_notify?: { task_timeout?: string[]; task_miss?: string[]; record_abnormal?: string[]; repair_timeout_minutes?: number; repair_timeout?: string[] };
};

function SwitchRow({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
    <div><div>{label}</div><div className="kgd-muted">{desc}</div></div>
    <Switch checked={checked} onChange={onChange} />
  </div>;
}

function TreeTable({ title, rows, onAdd }: { title: string; rows: Rec[]; onAdd?: () => void }) {
  return <div className="kgd-card" style={{ marginBottom: 16 }}>
    <h3>{title}</h3>
    {onAdd ? <div style={{ marginBottom: 8 }}><Button type="primary" onClick={onAdd}>新增</Button></div> : null}
    <Table size="small" rowKey="id" pagination={false} dataSource={rows}
      columns={[{ title: '分类名称', dataIndex: 'name' }]} />
  </div>;
}

export function EquipSettingPage() {
  const api = useEquipApi();
  const navigate = useNavigate();
  const remote = useRemote<{ settings: Settings; categories: Rec[]; shops: Rec[]; lines: Rec[]; device_statuses: Rec[]; plan_categories: string[] }>('/api/equip/settings', api.revision, api.onExpired);
  const saved = remote.data?.settings;
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => { if (saved) setForm({ ...saved, alarm_notify: { repair_timeout_minutes: 0, ...(saved.alarm_notify || {}) } }); }, [saved]);
  if (!form) return <div className="kgd-card">{remote.error || '加载中'}</div>;
  const alarm = form.alarm_notify || {};
  const dispatch = form.scan_dispatch_label || (form.scan_dispatch === '报修时允许派单' ? '报修时，允许派单。' : '报修时，不允许派单。');

  async function save() {
    const ok = await api.act('/api/equip/settings', { ...form, scan_dispatch: dispatch, alarm_notify: alarm }, 'PUT');
    if (ok) api.message.success('已保存');
  }

  return <div>
    <div className="kgd-actions" style={{ marginBottom: 12 }}><Button onClick={() => navigate(-1)}>返回</Button><Button type="primary" onClick={() => void save()}>保 存</Button></div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div>
        <div className="kgd-card" style={{ marginBottom: 16 }}>
          <h3>基础设置</h3>
          <SwitchRow label="导出维修工单时，是否导出图片" desc="导出维修工单时，是否导出图片" checked={Boolean(form.export_repair_image)} onChange={(v) => setForm({ ...form, export_repair_image: v })} />
          <SwitchRow label="导出维保计划执行记录时，是否导出图片" desc="导出维保计划执行记录时，是否导出图片" checked={Boolean(form.export_record_image)} onChange={(v) => setForm({ ...form, export_record_image: v })} />
          <div style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div><div>扫描设备二维码查看设备信息</div><div className="kgd-muted">扫码后需要登录</div></div>
              <Switch checked={Boolean(form.scan_login)} onChange={(v) => setForm({ ...form, scan_login: v })} />
            </div>
            <Radio.Group style={{ marginTop: 8 }} value={dispatch} onChange={(e) => setForm({ ...form, scan_dispatch_label: e.target.value })}
              options={[{ value: '报修时，允许派单。', label: '报修时，允许派单。' }, { value: '报修时，不允许派单。', label: '报修时，不允许派单。' }]} />
          </div>
          <SwitchRow label="扫码设备二维码允许报修" desc="开启后，允许用户该页面进行报修，关闭后，隐藏该页面得报修入口" checked={form.scan_repair !== false} onChange={(v) => setForm({ ...form, scan_repair: v })} />
          <SwitchRow label="维修工单审核流程，是否审核" desc="维修工单审核流程，是否审核" checked={form.repair_audit !== false} onChange={(v) => setForm({ ...form, repair_audit: v })} />
          <SwitchRow label="维保允许选用所有备件" desc="开启后，允许选用所有备件；关闭只允许选用设备物料清单或商品一级BOM。" checked={Boolean(form.all_spares)} onChange={(v) => setForm({ ...form, all_spares: v })} />
          <SwitchRow label="维保设备隐藏车间产线信息" desc="维保设备隐藏车间产线信息" checked={Boolean(form.hide_shop)} onChange={(v) => setForm({ ...form, hide_shop: v })} />
          <SwitchRow label="设备状态自动跟随维修工单变化" desc="开启该功能后，设备的状态自动跟随维修工单变化，维修工单中无法手动修改" checked={Boolean(form.status_follow_repair)} onChange={(v) => setForm({ ...form, status_follow_repair: v })} />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '12px 0' }}>
            <div><div>维保任务/点检任务默认执行结果设置</div><div className="kgd-muted">维保任务/点检任务的未执行时默认执行结果为</div></div>
            <Select style={{ width: 120 }} value={form.default_result || '待定'} onChange={(v) => setForm({ ...form, default_result: v })} options={['待定', '正常', '异常'].map((v) => ({ value: v, label: v }))} />
          </div>
          <Button type="primary" onClick={() => void save()}>保 存</Button>
        </div>
        <div className="kgd-card">
          <h3>报警通知</h3>
          <div style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
            <div>维保任务超时</div>
            <div className="kgd-muted">维保任务超时后需要提醒下方人员（未设置提醒人则不提醒）。</div>
            <Select mode="tags" style={{ width: '100%', marginTop: 8 }} placeholder="提醒人" value={alarm.task_timeout as string[] | undefined} onChange={(v) => setForm({ ...form, alarm_notify: { ...alarm, task_timeout: v } })} />
          </div>
          <div style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
            <div>维保任务漏执行</div>
            <div className="kgd-muted">维保任务漏执行后需要提醒下方人员（未设置提醒人则不提醒）。</div>
            <Select mode="tags" style={{ width: '100%', marginTop: 8 }} placeholder="提醒人" value={alarm.task_miss as string[] | undefined} onChange={(v) => setForm({ ...form, alarm_notify: { ...alarm, task_miss: v } })} />
          </div>
          <div style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
            <div>维保记录异常</div>
            <Select mode="tags" style={{ width: '100%', marginTop: 8 }} placeholder="提醒人" value={alarm.record_abnormal as string[] | undefined} onChange={(v) => setForm({ ...form, alarm_notify: { ...alarm, record_abnormal: v } })} />
          </div>
          <div style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
            <div>维修工单超时设置</div>
            <div>派单 <InputNumber min={0} value={Number(alarm.repair_timeout_minutes ?? 0)} onChange={(v) => setForm({ ...form, alarm_notify: { ...alarm, repair_timeout_minutes: Number(v) || 0 } })} /> 分钟后未完成视为超时(0不限制)</div>
          </div>
          <div style={{ padding: '12px 0' }}>
            <div>维修工单超时</div>
            <Select mode="tags" style={{ width: '100%', marginTop: 8 }} placeholder="提醒人" value={alarm.repair_timeout as string[] | undefined} onChange={(v) => setForm({ ...form, alarm_notify: { ...alarm, repair_timeout: v } })} />
          </div>
          <Button type="primary" onClick={() => void save()}>保 存</Button>
        </div>
      </div>
      <div>
        <TreeTable title="车间信息" rows={remote.data?.shops ?? []} onAdd={() => { const name = window.prompt('分类名称'); if (name) void api.act('/api/equip/shops', { name }); }} />
        <div className="kgd-card" style={{ marginBottom: 16 }}>
          <h3>设备状态</h3>
          <Table size="small" rowKey="name" pagination={false} dataSource={remote.data?.device_statuses ?? []}
            columns={[{ title: '排序', render: (_, __, i) => i + 1 }, { title: '名称', dataIndex: 'name' }, { title: '状态类型', dataIndex: 'kind' }, { title: '颜色', dataIndex: 'color' }]} />
        </div>
        <div className="kgd-card" style={{ marginBottom: 16 }}>
          <h3>工序产线</h3>
          <Button type="primary" style={{ marginBottom: 8 }} onClick={() => { const name = window.prompt('名称'); if (name) void api.act('/api/equip/lines', { name }); }}>添加</Button>
          <Table size="small" rowKey="id" pagination={false} dataSource={remote.data?.lines ?? []}
            columns={[{ title: '排序', dataIndex: 'sort_no' }, { title: '名称', dataIndex: 'name' }]} />
        </div>
        <TreeTable title="设备类别" rows={remote.data?.categories ?? []} onAdd={() => { const name = window.prompt('分类名称'); if (name) void api.act('/api/equip/categories', { name }); }} />
        <TreeTable title="维保计划分类" rows={(remote.data?.plan_categories ?? []).map((name, i) => ({ id: String(i), name }))} />
      </div>
    </div>
  </div>;
}
