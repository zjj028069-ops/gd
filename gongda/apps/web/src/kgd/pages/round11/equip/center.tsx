import { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Select, Table } from 'antd';
import { AdvSearch, mobileFieldsFrom, useEquipApi, useQueryState, useRemote, ListFrame, dash, StatusTag, type Rec } from './shared';

function chipOpts(labels: string[], counts?: Record<string, number>) {
  return labels.map((label) => ({ value: label, label: `${label}(${counts?.[label] ?? 0})` }));
}

export function MaintTaskList() {
  const api = useEquipApi();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[]; counts: { status: Record<string, number>; abnormal: Record<string, number>; date: Record<string, number> } }>('/api/equip/tasks', api.revision, api.onExpired);
  const [adv, setAdv] = useState(false);
  const [tab, setTab] = useState('设备维保');
  const status = list.chips.status || '未开始';
  const abnormal = list.chips.abnormal || '全部';
  const date = list.chips.date || '今天';
  const counts = remote.data?.counts;
  const rows = useMemo(() => {
    if (tab !== '设备维保') return [] as Rec[];
    return (remote.data?.items ?? []).filter((row) => {
      if (status !== '全部' && row.status !== status) return false;
      if (abnormal === '漏执行' && row.status !== '未完成') return false;
      if (list.query.q) {
        const q = list.query.q;
        if (![row.plan_title, row.executor_name, row.team_name].some((v) => String(v ?? '').includes(q))) return false;
      }
      return true;
    });
  }, [remote.data, status, abnormal, list.query, tab]);
  const cols = [
    { key: 'plan', title: '维保计划', render: (row: Rec) => dash(row.plan_title) },
    { key: 'date', title: '任务日期', render: (row: Rec) => dash(row.task_date_text || row.task_date) },
    { key: 'span', title: '任务时间段', render: (row: Rec) => dash(row.time_span) },
    { key: 'executor', title: '执行人/执行团队', render: (row: Rec) => dash(row.executor_name) },
    { key: 'team', title: '团队', render: (row: Rec) => dash(row.team_name) },
    { key: 'status', title: '状态', render: (row: Rec) => <StatusTag text={String(row.status)} /> },
    { key: 'device', title: '设备', render: (row: Rec) => dash(row.device_text) },
    { key: 'device_count', title: '设备数', render: (row: Rec) => String(row.device_count ?? 0) },
    { key: 'sign', title: '签字状态', render: (row: Rec) => dash(row.sign_status) },
  ];
  return <ListFrame pageKey="inspection_task" rows={rows} loading={remote.loading} error={remote.error}
    viewTabs={[{ key: '设备维保', label: '设备维保' }, { key: '客户产品维保', label: '客户产品维保' }]} activeView={tab} onView={setTab}
    chips={[
      { key: 'status', label: '状态视角', options: chipOpts(['全部', '未开始', '进行中', '已完成', '未完成'], counts?.status) },
      { key: 'abnormal', label: '异常视角', options: chipOpts(['全部', '逾期', '漏执行'], { 全部: counts?.abnormal?.全部 ?? 0, 逾期: counts?.abnormal?.逾期 ?? 0, 漏执行: counts?.abnormal?.漏执行 ?? 0 }) },
      { key: 'date', label: '任务日期', options: chipOpts(['全部', '昨天', '今天', '本周', '本月'], counts?.date) },
    ]} chipValue={{ status, abnormal, date }} onChip={list.onChip}
    queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    queryNode={<div className="kgd-query-fields"><Input style={{ width: 240 }} placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(e) => list.onQuery('q', e.target.value)} onPressEnter={list.onSearch} /><Button type="link" onClick={() => setAdv((v) => !v)}>高级查询</Button></div>}
    page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
    rowSelection={{ selected: [], onChange: () => undefined }}
    showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={mobileFieldsFrom(cols)} columns={cols}
    toolbar={<AdvSearch open={adv} fields={['维保计划', '执行人/执行团队', '团队', '任务日期']} onSearch={list.onSearch} onClear={list.onClear} onClose={() => setAdv(false)} />}
  />;
}

export function MaintRecordList() {
  const api = useEquipApi();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/equip/records', api.revision, api.onExpired);
  const devices = useRemote<{ items: Rec[] }>('/api/equip/devices', api.revision, api.onExpired);
  const [adv, setAdv] = useState(false);
  const [tab, setTab] = useState('设备维保');
  const [repair, setRepair] = useState<Rec | null>(null);
  const [form, setForm] = useState({ device_id: '', team_name: '默认团队', handler_name: '', description: '' });
  const time = list.chips.time || '全部';
  const check = list.chips.check || '全部';
  const sign = list.chips.sign || '全部';
  const all = remote.data?.items ?? [];
  const counts = {
    time: { 全部: all.length, 昨天: 0, 今天: 0, 本周: 0, 本月: 0 },
    check: { 全部: all.length, 异常: all.filter((r) => r.result === '异常').length, 正常: all.filter((r) => r.result === '正常').length, 待定: all.filter((r) => r.result === '待定').length },
    sign: { 全部: all.length, 已签字: all.filter((r) => r.sign_status === '已签字').length, 未签字: all.filter((r) => r.sign_status === '未签字').length, 无需签字: all.filter((r) => r.sign_status === '无需签字').length },
  };
  const rows = useMemo(() => {
    if (tab !== '设备维保') return [] as Rec[];
    return all.filter((row) => {
      if (check !== '全部' && row.result !== check) return false;
      if (sign !== '全部' && row.sign_status !== sign) return false;
      if (list.query.q) {
        const q = list.query.q;
        if (![row.plan_title, row.device_name, row.device_code].some((v) => String(v ?? '').includes(q))) return false;
      }
      return true;
    });
  }, [all, check, sign, list.query, tab]);
  const cols = [
    { key: 'plan', title: '维保计划', render: (row: Rec) => <>{dash(row.plan_title)}{row.abnormal ? <span style={{ color: '#ff4d4f', marginLeft: 4 }}>▲</span> : null}</> },
    { key: 'device', title: '设备', render: (row: Rec) => dash(row.device_name) },
    { key: 'spec', title: '设备规格', render: (row: Rec) => dash(row.device_spec) },
    { key: 'code', title: '设备编号', render: (row: Rec) => dash(row.device_code) },
    { key: 'category', title: '设备类别', render: (row: Rec) => dash(row.category_name) },
    { key: 'verify', title: '核验状态', render: (row: Rec) => dash(row.verify_status) },
    { key: 'sign', title: '签字状态', render: (row: Rec) => dash(row.sign_status) },
    { key: 'dstatus', title: '设备状态', render: (row: Rec) => <StatusTag text={String(row.device_status || '-')} /> },
    { key: 'materials', title: '物料清单', render: () => <span className="kgd-link">管理</span> },
    { key: 'qr', title: '设备二维码', render: (row: Rec) => dash(row.qr_code) },
    { key: 'owner', title: '设备负责人', render: (row: Rec) => dash(row.owner_name) },
    { key: 'shop', title: '车间', render: (row: Rec) => dash(row.shop_name) },
    { key: 'line', title: '产线', render: (row: Rec) => dash(row.line_name) },
    { key: 'executor', title: '执行人', render: (row: Rec) => dash(row.executor_name) },
    { key: 'team', title: '执行团队', render: (row: Rec) => dash(row.team_name) },
    { key: 'time', title: '执行时间', render: (row: Rec) => dash(row.executed_at_text || row.executed_at) },
    { key: 'content', title: '维保内容', render: (row: Rec) => dash(row.content_title) },
    { key: 'spare', title: '备件使用', render: (row: Rec) => dash(row.spare_text) },
    { key: 'repair', title: '维修工单', render: (row: Rec) => dash(row.repair_code) },
    { key: 'first', title: '首次核验时间', render: (row: Rec) => dash(row.first_verify_at) },
    { key: 'actions', title: '操作', width: 180, render: (row: Rec) => row.abnormal
      ? <button className="kgd-link" onClick={() => { setRepair(row); setForm({ device_id: String((devices.data?.items ?? []).find((d) => d.name === row.device_name)?.id || ''), team_name: '默认团队', handler_name: '', description: `异常：${row.plan_title}` }); }}>转维修工单</button>
      : '-' },
  ];
  return <>
    <ListFrame pageKey="inspection_record" rows={rows} loading={remote.loading} error={remote.error}
      viewTabs={[{ key: '设备维保', label: '设备维保' }, { key: '客户产品维保', label: '客户产品维保' }]} activeView={tab} onView={setTab}
      chips={[
        { key: 'time', label: '执行时间', options: ['全部', '昨天', '今天', '本周', '本月'].map((v) => ({ value: v, label: `${v}(${counts.time[v as keyof typeof counts.time] ?? 0})` })) },
        { key: 'check', label: '检查项', options: ['全部', '异常', '正常', '待定'].map((v) => ({ value: v, label: `${v}(${counts.check[v as keyof typeof counts.check] ?? 0})` })) },
        { key: 'sign', label: '签字状态', options: ['全部', '已签字', '未签字', '无需签字'].map((v) => ({ value: v, label: `${v}(${counts.sign[v as keyof typeof counts.sign] ?? 0})` })) },
      ]} chipValue={{ time, check, sign }} onChip={list.onChip}
      queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      queryNode={<div className="kgd-query-fields"><Input style={{ width: 240 }} placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(e) => list.onQuery('q', e.target.value)} onPressEnter={list.onSearch} /><Button type="link" onClick={() => setAdv((v) => !v)}>高级查询</Button></div>}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage} rowSelection={{ selected: [], onChange: () => undefined }}
      toolbar={<AdvSearch open={adv} fields={['维保计划', '设备', '执行人']} onSearch={list.onSearch} onClear={list.onClear} onClose={() => setAdv(false)} />}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={mobileFieldsFrom(cols)} columns={cols} />
    <Modal title="新增维修工单" open={!!repair} okText="保 存" cancelText="关 闭" onCancel={() => setRepair(null)}
      onOk={() => void api.act('/api/equip/repairs', { ...form, source: '维保记录' }).then((r) => { if (r) setRepair(null); })}>
      <Form layout="vertical">
        <Form.Item label="维修设备" required><Select value={form.device_id || undefined} onChange={(v) => setForm({ ...form, device_id: v })} options={(devices.data?.items ?? []).map((d) => ({ value: String(d.id), label: String(d.name) }))} placeholder="点击选择设备" /></Form.Item>
        <Form.Item label="团队" required><Select value={form.team_name} onChange={(v) => setForm({ ...form, team_name: v })} options={[{ value: '默认团队', label: '默认团队' }]} /></Form.Item>
        <Form.Item label="处理人" required><Input placeholder="姓名/简拼" value={form.handler_name} onChange={(e) => setForm({ ...form, handler_name: e.target.value })} /></Form.Item>
        <Form.Item label="故障描述" required><Input.TextArea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Form.Item>
      </Form>
    </Modal>
  </>;
}

export function MaintBreakdownList() {
  const api = useEquipApi();
  const list = useQueryState();
  const contents = useRemote<{ items: Rec[] }>('/api/equip/contents', api.revision, api.onExpired);
  const contentId = list.query.content || '';
  const remote = useRemote<{ items: Rec[]; hint: string; check_items: { id: string; name: string }[] }>(contentId ? `/api/equip/breakdowns?content_id=${contentId}` : null, api.revision, api.onExpired);
  const [adv, setAdv] = useState(false);
  const [tab, setTab] = useState('设备维保');
  // 理由：原先 onSearch 在 !query.content 时被置空函数，选完维保内容后点「查询」无法提交 draft→query，明细永远 0 行
  const hasDraftContent = Boolean(list.draft.content);
  const checkCols = (remote.data?.check_items ?? []).map((item) => ({ key: item.id, title: item.name, render: (row: Rec) => dash(row.result) }));
  const cols = [
    { key: 'plan', title: '维保计划', render: (row: Rec) => dash(row.plan_title) },
    { key: 'category', title: '设备类别', render: (row: Rec) => dash(row.category_name) },
    { key: 'device', title: '设备', render: (row: Rec) => dash(row.device_name) },
    { key: 'code', title: '设备编号', render: (row: Rec) => dash(row.device_code) },
    { key: 'spec', title: '设备规格', render: (row: Rec) => dash(row.device_spec) },
    { key: 'executor', title: '执行人', render: (row: Rec) => dash(row.executor_name) },
    { key: 'team', title: '团队', render: (row: Rec) => dash(row.team_name) },
    { key: 'time', title: '执行时间', render: (row: Rec) => dash(row.executed_at_text || row.executed_at) },
    ...checkCols,
  ];
  return <ListFrame pageKey="inspection_breakdown" rows={tab === '设备维保' && contentId ? (remote.data?.items ?? []) : []} loading={remote.loading} error={remote.error}
    emptyTitle={contentId ? '暂无数据' : '请选择维保内容以查看明细数据'} emptyDescription={contentId ? '当前没有可显示的记录。' : '请选择维保内容以查看明细数据'}
    viewTabs={[{ key: '设备维保', label: '设备维保' }, { key: '客户产品维保', label: '客户产品维保' }]} activeView={tab} onView={setTab}
    chips={[{ key: 'time', label: '执行时间', options: ['全部', '昨天', '今天', '本周', '本月'].map((v) => ({ value: v, label: v })) }]} chipValue={{ time: list.chips.time || '全部' }} onChip={list.onChip}
    queryFields={[{ key: 'content', label: '维保内容', kind: 'select', options: (contents.data?.items ?? []).map((c) => ({ value: String(c.id), label: String(c.title) })) }, { key: 'q', label: '关键字', placeholder: '输入关键字查询' }]}
    queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    queryNode={<div className="kgd-query-fields">
      <Select style={{ width: 200 }} placeholder="维保内容" allowClear value={list.draft.content || undefined} options={(contents.data?.items ?? []).map((c) => ({ value: String(c.id), label: String(c.title) }))} onChange={(v) => list.onQuery('content', v ?? '')} />
      <Input style={{ width: 200 }} placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(e) => list.onQuery('q', e.target.value)} disabled={!hasDraftContent && !contentId} />
      <Button type="link" disabled={!hasDraftContent && !contentId} onClick={() => setAdv((v) => !v)}>高级查询</Button>
    </div>}
    page={list.page} pageSize={list.pageSize} total={contentId ? (remote.data?.items.length ?? 0) : 0} onPage={list.onPage}
    columns={cols} toolbar={<AdvSearch open={adv && Boolean(contentId || hasDraftContent)} fields={['维保计划', '设备']} onSearch={list.onSearch} onClear={list.onClear} onClose={() => setAdv(false)} />} />;
}

export function MaintContentList() {
  const api = useEquipApi();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/equip/contents', api.revision, api.onExpired);
  const [adv, setAdv] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('add')) setOpen(true); }, []);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<{ name: string; field_type: string; required: boolean; description: string }[]>([]);
  const rows = useMemo(() => (remote.data?.items ?? []).filter((row) => !list.query.q || String(row.title).includes(list.query.q)), [remote.data, list.query]);
  const cols = [
    { key: 'title', title: '标题', render: (row: Rec) => dash(row.title) },
    { key: 'items', title: '检查项', render: (row: Rec) => String(row.item_count || 0) },
    { key: 'note', title: '备注', render: (row: Rec) => dash(row.note) },
    { key: 'creator', title: '创建人', render: (row: Rec) => dash(row.creator_name) },
    { key: 'created', title: '创建时间', render: (row: Rec) => dash(row.created_at_text || row.created_at) },
    { key: 'actions', title: '操作', render: (row: Rec) => <>
      <button className="kgd-link" onClick={() => void api.act(`/api/equip/contents/${row.id}/copy`, {})}>复制</button>{' '}
      <button className="kgd-link" onClick={() => api.modal.confirm({ title: '确定删除？', onOk: () => api.act(`/api/equip/contents/${row.id}`, {}, 'DELETE') })}>删除</button>
    </> },
  ];
  return <>
    <ListFrame pageKey="inspection_content" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      queryNode={<div className="kgd-query-fields"><Input style={{ width: 240 }} placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(e) => list.onQuery('q', e.target.value)} onPressEnter={list.onSearch} /><Button type="link" onClick={() => setAdv((v) => !v)}>高级查询</Button></div>}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      toolbar={<><Button type="primary" onClick={() => { setOpen(true); setTitle(''); setNote(''); setItems([]); }}>新增</Button><AdvSearch open={adv} fields={['标题', '创建人']} onSearch={list.onSearch} onClear={list.onClear} onClose={() => setAdv(false)} /></>}
      columns={cols} />
    <Modal title="新增维保内容" open={open} okText="确定" cancelText="取消" width={720} onCancel={() => setOpen(false)}
      onOk={() => void api.act('/api/equip/contents', { title, note, items }).then((r) => { if (r) setOpen(false); })}>
      <Form layout="vertical">
        <Form.Item label="标题" required><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Form.Item>
        <Form.Item label="备注"><Input.TextArea maxLength={255} showCount value={note} onChange={(e) => setNote(e.target.value)} /></Form.Item>
      </Form>
      <p className="kgd-muted">删除检查项，将删除维保记录中对应字段的数据。</p>
      <Button type="link" onClick={() => setItems((cur) => [...cur, { name: '', field_type: '文本', required: false, description: '' }])}>新增检查项</Button>
      <Table size="small" rowKey={(_, i) => String(i)} dataSource={items} pagination={false}
        columns={[
          { title: '排序', render: (_, __, i) => i + 1 },
          { title: '检查项', render: (_, row, i) => <Input value={row.name} onChange={(e) => setItems((cur) => cur.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))} /> },
          { title: '字段类型', render: (_, row, i) => <Select value={row.field_type} style={{ width: 100 }} options={['文本', '数字', '是否', '单选'].map((v) => ({ value: v, label: v }))} onChange={(v) => setItems((cur) => cur.map((x, idx) => idx === i ? { ...x, field_type: v } : x))} /> },
          { title: '是否必填', render: (_, row, i) => <Select value={row.required ? '是' : '否'} style={{ width: 80 }} options={[{ value: '是', label: '是' }, { value: '否', label: '否' }]} onChange={(v) => setItems((cur) => cur.map((x, idx) => idx === i ? { ...x, required: v === '是' } : x))} /> },
          { title: '检查项说明', render: (_, row, i) => <Input value={row.description} onChange={(e) => setItems((cur) => cur.map((x, idx) => idx === i ? { ...x, description: e.target.value } : x))} /> },
          { title: '操作', render: (_, __, i) => <button className="kgd-link" onClick={() => setItems((cur) => cur.filter((_, idx) => idx !== i))}>删除</button> },
        ]} />
    </Modal>
  </>;
}
