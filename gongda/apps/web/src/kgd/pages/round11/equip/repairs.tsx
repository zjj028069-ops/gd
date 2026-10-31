import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, Form, Input, Modal, Select, Steps, Tag } from 'antd';
import { AdvSearch, emptyVal, idFromLocation, mobileFieldsFrom, useEquipApi, useQueryState, useRemote, ListFrame, dash, StatusTag, type Rec } from './shared';

const statuses = ['全部', '待派单', '待接单', '处理中', '待审核', '审核退回', '已完成', '暂停', '取消'];

export function RepairOrderList() {
  const api = useEquipApi();
  const list = useQueryState();
  const navigate = useNavigate();
  const status = list.chips.status || '全部';
  const overtime = list.chips.overtime || '全部';
  const remote = useRemote<{ items: Rec[]; counts: Record<string, number> }>(`/api/equip/repairs?status=${encodeURIComponent(status)}&overtime=${encodeURIComponent(overtime)}`, api.revision, api.onExpired);
  const devices = useRemote<{ items: Rec[] }>('/api/equip/devices', api.revision, api.onExpired);
  const [adv, setAdv] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('add')) setOpen(true); }, []);
  const [form, setForm] = useState({ code: '', device_id: '', team_name: '默认团队', dispatch: '派单到人', handler_name: '', fault_type: '', description: '' });
  const [errs, setErrs] = useState<Record<string, boolean>>({});
  const counts = remote.data?.counts ?? {};
  const rows = useMemo(() => {
    const q = list.query.q;
    return (remote.data?.items ?? []).filter((row) => !q || [row.code, row.device_name, row.device_code, row.handler_name, row.description].some((v) => String(v ?? '').includes(q)));
  }, [remote.data, list.query]);

  function moreItems(row: Rec) {
    if (row.status === '处理中') return [{ key: 'pause', label: '暂停' }, { key: 'edit', label: '修改' }, { key: 'cancel', label: '取消' }, { key: 'del', label: '删除' }];
    if (row.status === '待审核') return [{ key: 'edit', label: '修改' }, { key: 'del', label: '删除' }];
    if (row.status === '待派单') return [{ key: 'dispatch', label: '派单' }, { key: 'edit', label: '修改' }, { key: 'cancel', label: '取消' }, { key: 'del', label: '删除' }];
    if (row.status === '审核退回') return [{ key: 'edit', label: '修改' }, { key: 'del', label: '删除' }];
    if (row.status === '已完成' || row.status === '取消') return [{ key: 'del', label: '删除' }];
    if (row.status === '暂停') return [{ key: 'resume', label: '继续' }, { key: 'edit', label: '修改' }, { key: 'cancel', label: '取消' }, { key: 'del', label: '删除' }];
    return [{ key: 'edit', label: '修改' }, { key: 'del', label: '删除' }];
  }

  async function onMore(row: Rec, key: string) {
    if (key === 'pause') await api.act(`/api/equip/repairs/${row.id}/actions`, { action: '暂停' });
    if (key === 'cancel') await api.act(`/api/equip/repairs/${row.id}/actions`, { action: '取消' });
    if (key === 'resume') await api.act(`/api/equip/repairs/${row.id}/actions`, { action: '继续' });
    if (key === 'del') api.modal.confirm({ title: '确定删除？', onOk: () => api.act(`/api/equip/repairs/${row.id}`, {}, 'DELETE') });
    if (key === 'dispatch') {
      const handler = form.handler_name || '本地管理员';
      await api.act(`/api/equip/repairs/${row.id}/actions`, { action: '派单', handler_name: handler });
    }
  }

  async function save() {
    const next = {
      device_id: !form.device_id,
      team_name: !form.team_name,
      handler_name: !form.handler_name.trim(),
      description: !form.description.trim(),
    };
    setErrs(next);
    if (next.device_id) { api.message.error('请选择维修设备'); return; }
    if (next.team_name) { api.message.error('请选择团队'); return; }
    if (next.handler_name) { api.message.error('请选择处理人'); return; }
    if (next.description) { api.message.error('请填写故障描述'); return; }
    const result = await api.act('/api/equip/repairs', form);
    if (result) setOpen(false);
  }

  const cols = [
    { key: 'code', title: '工单编号', render: (row: Rec) => <button className="kgd-link" onClick={() => navigate(`/device_order/detail/${row.id}`)}>{String(row.code)}</button> },
    { key: 'device', title: '设备名称', render: (row: Rec) => <button className="kgd-link" onClick={() => navigate(`/device/detail/${(devices.data?.items ?? []).find((d) => d.code === row.device_code)?.id || ''}`)}>{String(row.device_label || `${row.device_name}[${row.device_code}]`)}</button> },
    { key: 'handler', title: '处理人', render: (row: Rec) => dash(row.handler_name) },
    { key: 'team', title: '团队', render: (row: Rec) => dash(row.team_name) },
    { key: 'accept', title: '接单时间', render: (row: Rec) => dash(row.accept_at_text) },
    { key: 'finish', title: '处理时间', render: (row: Rec) => dash(row.finish_at_text) },
    { key: 'rdur', title: '维修总用时', render: (row: Rec) => dash(row.repair_duration) },
    { key: 'odur', title: '工单总用时', render: (row: Rec) => dash(row.order_duration) },
    { key: 'fault', title: '故障类别', render: (row: Rec) => dash(row.fault_type) },
    { key: 'desc', title: '故障描述', render: (row: Rec) => dash(row.description) },
    { key: 'abn', title: '维保异常项', render: (row: Rec) => <span className="kgd-link">{dash(row.abnormal_text)}</span> },
    { key: 'status', title: '状态', render: (row: Rec) => <StatusTag text={String(row.status)} /> },
    { key: 'sign', title: '签字状态', render: (row: Rec) => dash(row.sign_status) },
    { key: 'pause', title: '暂停原因', render: (row: Rec) => dash(row.pause_reason) },
    { key: 'cancel', title: '取消原因', render: (row: Rec) => dash(row.cancel_reason) },
    { key: 'reporter', title: '报修人', render: (row: Rec) => dash(row.reporter_name) },
    { key: 'auditor', title: '审核人', render: (row: Rec) => dash(row.auditor_name) },
    { key: 'audit_at', title: '审核时间', render: (row: Rec) => dash(row.audit_at_text) },
    { key: 'source', title: '来源', render: (row: Rec) => dash(row.source) },
    { key: 'solved', title: '是否解决问题', render: (row: Rec) => dash(row.solved_text) },
    { key: 'result', title: '处理结果', render: (row: Rec) => dash(row.result) },
    { key: 'created', title: '报修时间', render: (row: Rec) => dash(row.created_at_text || row.created_at) },
    { key: 'actions', title: '操作', width: 180, render: (row: Rec) => <>
      {row.status === '待接单' && <><button className="kgd-link" onClick={() => void api.act(`/api/equip/repairs/${row.id}/actions`, { action: '接单' })}>接单</button>{' '}</>}
      <Dropdown menu={{ items: moreItems(row).map((item) => ({ ...item, onClick: () => void onMore(row, item.key) })) }}><button className="kgd-link">更多</button></Dropdown>
    </> },
  ];

  return <>
    <ListFrame pageKey="device_order" rows={rows} loading={remote.loading} error={remote.error}
      chips={[
        { key: 'status', label: '状态视角', options: statuses.map((v) => ({ value: v, label: v === '全部' ? `全部(${counts['全部'] ?? 0})` : `${v}(${counts[v] ?? 0})` })) },
        { key: 'overtime', label: '超时视角', options: ['全部', '已超时', '未超时'].map((v) => ({ value: v, label: v === '全部' ? `全部(${counts['全部'] ?? 0})` : `${v}(${counts[v] ?? 0})` })) },
      ]} chipValue={{ status, overtime }} onChip={list.onChip}
      queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      queryNode={<div className="kgd-query-fields"><Input style={{ width: 240 }} placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(e) => list.onQuery('q', e.target.value)} onPressEnter={list.onSearch} /><Button type="link" onClick={() => setAdv((v) => !v)}>高级查询</Button></div>}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      toolbar={<><Button type="primary" onClick={() => { setOpen(true); setForm({ code: '', device_id: '', team_name: '默认团队', dispatch: '派单到人', handler_name: '', fault_type: '', description: '' }); setErrs({}); }}>新增</Button><AdvSearch open={adv} fields={['工单编号', '设备名称', '设备编号', '处理人', '团队', '接单时间', '处理时间', '报修人', '报修时间', '审核人', '审核时间', '设备类别', '车间', '产线', '故障类别', '故障描述', '签字状态']} onSearch={list.onSearch} onClear={list.onClear} onClose={() => setAdv(false)} /></>}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={mobileFieldsFrom(cols)}
      columns={cols} />
    <Modal title="新增维修工单" open={open} onCancel={() => setOpen(false)} footer={[
      <Button key="c" onClick={() => setOpen(false)}>关 闭</Button>,
      <Button key="s" type="primary" onClick={() => void save()}>保 存</Button>,
    ]} width={560}>
      <Form layout="vertical">
        <Form.Item label="工单编号"><Input placeholder="请填写，忽略将自动生成" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Form.Item>
        <Form.Item label="维修设备" required validateStatus={errs.device_id ? 'error' : undefined}>
          <div style={{ display: 'flex', gap: 8 }}>
            <Select style={{ flex: 1 }} status={errs.device_id ? 'error' : undefined} placeholder="点击选择设备" value={form.device_id || undefined} onChange={(v) => setForm({ ...form, device_id: v })} options={(devices.data?.items ?? []).map((d) => ({ value: String(d.id), label: String(d.name) }))} />
          </div>
        </Form.Item>
        <Form.Item label="团队" required><Select status={errs.team_name ? 'error' : undefined} value={form.team_name} onChange={(v) => setForm({ ...form, team_name: v })} options={[{ value: '默认团队', label: '默认团队' }]} /></Form.Item>
        <Form.Item label="派单方式"><Select value={form.dispatch} onChange={(v) => setForm({ ...form, dispatch: v })} options={[{ value: '派单到人', label: '派单到人' }]} /></Form.Item>
        <Form.Item label="处理人" required><Input status={errs.handler_name ? 'error' : undefined} placeholder="姓名/简拼" value={form.handler_name} onChange={(e) => setForm({ ...form, handler_name: e.target.value })} /></Form.Item>
        <Form.Item label="故障类别"><Input placeholder="+ 添加" value={form.fault_type} onChange={(e) => setForm({ ...form, fault_type: e.target.value })} /></Form.Item>
        <Form.Item label="故障描述" required><Input.TextArea status={errs.description ? 'error' : undefined} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Form.Item>
      </Form>
    </Modal>
  </>;
}

export function RepairOrderDetail() {
  const id = idFromLocation('/device_order/detail/');
  const api = useEquipApi();
  const navigate = useNavigate();
  const remote = useRemote<{ repair: Rec }>(id ? `/api/equip/repairs/${id}` : null, api.revision, api.onExpired);
  const [tab, setTab] = useState('维修进度');
  const [finishOpen, setFinishOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [result, setResult] = useState('');
  const [solved, setSolved] = useState('是');
  const [auditNote, setAuditNote] = useState('');
  const repair = remote.data?.repair;
  if (!repair && remote.loading) return <div className="kgd-card">加载中</div>;
  if (!repair) return <div className="kgd-card">{remote.error || '维修工单不存在'}</div>;
  const stepMap: Record<string, number> = { 待接单: 0, 待派单: 0, 处理中: 1, 待审核: 2, 审核退回: 2, 已完成: 3, 暂停: 1, 取消: 0 };
  const info: [string, ReactNode][] = [
    ['设备名称', <><span className="kgd-link">{String(repair.device_name)}</span> <span>{String(repair.device_code)}</span> <StatusTag text={String(repair.device_status || '')} /></>],
    ['故障类别', emptyVal(repair.fault_type)],
    ['故障描述', emptyVal(repair.description)],
    ['维保异常项', emptyVal(repair.abnormal_text)],
    ['状态', <StatusTag text={String(repair.status)} />],
    ['签字状态', <Tag>{emptyVal(repair.sign_status)}</Tag>],
    ['处理人', emptyVal(repair.handler_name)],
    ['团队', emptyVal(repair.team_name)],
    ['接单时间', emptyVal(repair.accept_at_text)],
    ['处理时间', emptyVal(repair.finish_at_text)],
    ['维修总用时', emptyVal(repair.repair_duration)],
    ['来源', emptyVal(repair.source)],
    ['报修人', emptyVal(repair.reporter_name)],
    ['报修时间', emptyVal(repair.created_at_text)],
    ['暂停原因', emptyVal(repair.pause_reason)],
    ['取消原因', emptyVal(repair.cancel_reason)],
    ['审核人', emptyVal(repair.auditor_name)],
    ['审核时间', emptyVal(repair.audit_at_text)],
    ['审核备注', emptyVal(repair.audit_note)],
  ];
  return <div className="kgd-card">
    <div className="kgd-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button onClick={() => navigate('/device_order/list')}>返回</Button>
      <Button danger onClick={() => api.modal.confirm({ title: '确定删除？', onOk: () => api.act(`/api/equip/repairs/${id}`, {}, 'DELETE').then(() => navigate('/device_order/list')) })}>删除</Button>
      {repair.status === '处理中' && <Button type="primary" onClick={() => setFinishOpen(true)}>完成维修</Button>}
      {repair.status === '待审核' && <><Button type="primary" onClick={() => setAuditOpen(true)}>审核通过</Button><Button onClick={() => void api.act(`/api/equip/repairs/${id}/actions`, { action: '审核退回', result: auditNote })}>审核退回</Button></>}
    </div>
    <div style={{ margin: '12px 0' }}>工单总用时: {String(repair.order_duration || '-')}</div>
    <Steps current={stepMap[String(repair.status)] ?? 0} items={[{ title: '待接单', description: '接单用时' }, { title: '处理中', description: '维修用时' }, { title: '待审核' }, { title: '已完成' }]} style={{ marginBottom: 16 }} />
    <h2>维修工单({String(repair.code)})</h2>
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16 }}>
      <dl className="kgd-detail-grid">{info.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {['维修进度', '回执'].map((t) => <button key={t} className={`kgd-view ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        {tab === '维修进度' && <div className="kgd-muted">
          <p>新增 · {emptyVal(repair.created_at_text)}</p>
          {repair.accepted_at ? <p>{String(repair.handler_name)} 接单 · {emptyVal(repair.accept_at_text)}</p> : null}
          {repair.finished_at ? <p>{String(repair.handler_name)} 完成维修工单 · {emptyVal(repair.finish_at_text)}</p> : null}
        </div>}
        {tab === '回执' && <div className="kgd-muted">暂无数据</div>}
      </div>
    </div>
    <Modal title="完成维修" open={finishOpen} onCancel={() => setFinishOpen(false)} okText="确定" cancelText="取消"
      onOk={() => void api.act(`/api/equip/repairs/${id}/actions`, { action: '完成维修', result }).then((r) => { if (r) setFinishOpen(false); })}>
      <Form layout="vertical">
        <Form.Item label="是否解决问题"><Select value={solved} onChange={setSolved} options={[{ value: '是', label: '是' }, { value: '否', label: '否' }]} /></Form.Item>
        <Form.Item label="处理结果"><Input.TextArea value={result} onChange={(e) => setResult(e.target.value)} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="审核" open={auditOpen} onCancel={() => setAuditOpen(false)} okText="审核通过" cancelText="取消"
      onOk={() => void api.act(`/api/equip/repairs/${id}/actions`, { action: '审核通过', result: auditNote }).then((r) => { if (r) setAuditOpen(false); })}>
      <Form layout="vertical"><Form.Item label="审核备注"><Input.TextArea value={auditNote} onChange={(e) => setAuditNote(e.target.value)} /></Form.Item></Form>
    </Modal>
  </div>;
}
