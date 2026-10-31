import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Modal, Radio, Select, Switch, Table, Upload } from 'antd';
import { AdvSearch, emptyVal, idFromLocation, mobileFieldsFrom, redBorder, useEquipApi, useQueryState, useRemote, ListFrame, dash, type Rec } from './shared';

const deviceFilters = [
  { key: 'code', label: '设备编号' }, { key: 'name', label: '设备名称' }, { key: 'spec', label: '设备规格' },
  { key: 'status', label: '设备状态', kind: 'select' as const, options: ['正常', '维修中', '运行中'].map((v) => ({ value: v, label: v })) }, { key: 'category', label: '设备类别' },
  { key: 'qr', label: '设备二维码' }, { key: 'owner', label: '设备负责人' }, { key: 'shop', label: '车间' },
  { key: 'line', label: '产线' }, { key: 'created_from', label: '创建时间起', kind: 'date' as const }, { key: 'created_to', label: '创建时间止', kind: 'date' as const },
];

export function DeviceArchiveList() {
  const api = useEquipApi();
  const list = useQueryState();
  const navigate = useNavigate();
  const remote = useRemote<{ items: Rec[] }>('/api/equip/devices', api.revision, api.onExpired);
  const cats = useRemote<{ items: Rec[] }>('/api/equip/categories', api.revision, api.onExpired);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('add')) setOpen(true); }, []);
  const [tried, setTried] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', spec: '', status: '正常', category_id: '', sync_machine: '否', team_name: '默认团队', owner_name: '', shop_name: '', line_name: '' });
  const [view, setView] = useState('all');
  const rows = useMemo(() => {
    const q = list.query;
    return (remote.data?.items ?? []).filter((row) => {
      if (q.code && !String(row.code ?? '').includes(q.code)) return false;
      if (q.name && !String(row.name ?? '').includes(q.name)) return false;
      if (q.spec && !String(row.spec ?? '').includes(q.spec)) return false;
      if (q.status && String(row.status) !== q.status) return false;
      if (q.category && !String(row.category_name ?? '').includes(q.category)) return false;
      if (q.owner && !String(row.owner_name ?? '').includes(q.owner)) return false;
      return true;
    });
  }, [remote.data, list.query]);
  function firstErr() {
    if (!form.name.trim()) return '请填写设备名称';
    if (!form.status) return '请选择设备状态';
    if (!form.category_id) return '请选择设备类别';
    if (!form.team_name.trim()) return '请选择团队';
    if (!form.owner_name.trim()) return '请选择设备负责人';
    return '';
  }
  const cols = [
    { key: 'code', title: '设备编号', render: (row: Rec) => dash(row.code) },
    { key: 'name', title: '设备名称', render: (row: Rec) => <button className="kgd-link" onClick={() => navigate(`/device/detail/${row.id}`)}>{String(row.name)}</button> },
    { key: 'spec', title: '设备规格', render: (row: Rec) => dash(row.spec) },
    { key: 'image', title: '设备图片', render: () => '-' },
    { key: 'status', title: '设备状态', render: (row: Rec) => dash(row.status) },
    { key: 'category', title: '设备类别', render: (row: Rec) => dash(row.category_name) },
    { key: 'bom', title: '物料清单', render: (row: Rec) => { const n = Number(row.material_count) || (Array.isArray(row.materials) ? (row.materials as unknown[]).length : 0); return n ? `管理(${n})` : '管理'; } },
    { key: 'qr', title: '设备二维码', render: (row: Rec) => <>{dash(row.qr_code)}{row.qr_code ? ' ✎' : ''}</> },
    { key: 'plan', title: '有无维保计划', render: (row: Rec) => dash(row.plan_text) },
    { key: 'owner', title: '设备负责人', render: (row: Rec) => dash(row.owner_name) },
    { key: 'team', title: '团队', render: (row: Rec) => dash(row.team_name) },
    { key: 'shop', title: '车间', render: (row: Rec) => dash(row.shop_name) },
    { key: 'line', title: '产线', render: (row: Rec) => dash(row.line_name) },
    { key: 'enabled', title: '启用/禁用', render: (row: Rec) => <Switch checked={Boolean(row.enabled !== false)} onChange={(v) => void api.act(`/api/equip/devices/${row.id}`, { enabled: v }, 'PATCH')} /> },
    { key: 'creator', title: '创建人', render: (row: Rec) => dash(row.creator_name) || '本地管理员' },
    { key: 'created', title: '创建时间', render: (row: Rec) => dash(row.created_at_text || row.created_at) },
    { key: 'actions', title: '操作', render: (row: Rec) => <>
      <button className="kgd-link" onClick={() => navigate(`/device/detail/${row.id}`)}>修改</button>{' '}
      <button className="kgd-link" onClick={() => api.modal.confirm({ title: '确定删除该设备？', onOk: () => api.act(`/api/equip/devices/${row.id}`, {}, 'DELETE') })}>删除</button>
    </> },
  ];
  return <>
    <ListFrame pageKey="device" rows={rows} loading={remote.loading} error={remote.error}
      viewTabs={[{ key: 'all', label: '全部视图' }]} activeView={view} onView={setView} onAddView={() => undefined}
      queryFields={deviceFilters} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      defaultQueryKeys={['code', 'name', 'spec', 'status', 'category']}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => { setOpen(true); setTried(false); }}>新增</Button>}
      moreItems={[{ key: 'import', label: '导入设备' }, { key: 'export_all', label: '导出(所有列)' }, { key: 'export_visible', label: '导出(显示列)' }, { key: 'upload', label: '批量上传文件' }]}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={mobileFieldsFrom(cols)} columns={cols} />
    <Modal title="新增维保设备" open={open} okText="提交" cancelText="取消" width={720} onCancel={() => setOpen(false)}
      onOk={() => {
        setTried(true);
        const err = firstErr();
        if (err) { api.message.error(err); return; }
        void api.act('/api/equip/devices', { ...form, sync_machine: form.sync_machine === '是' }).then((ok) => { if (ok) setOpen(false); });
      }}>
      <div className="kgd-form">
        <span>设备图片</span><Upload.Dragger accept="image/*" beforeUpload={() => false}><p>建议图片比例1:1，支持粘贴和拖拽</p></Upload.Dragger>
        <span>设备编号</span><Input placeholder="请填写，忽略将自动生成" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <span className={tried && !form.name ? 'kgd-field-error-label' : undefined}>设备名称 <em className="kgd-req">*</em></span>
        <Input style={redBorder(tried && !form.name)} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <span>设备规格</span><Input value={form.spec} onChange={(e) => setForm({ ...form, spec: e.target.value })} />
        <span className={tried && !form.status ? 'kgd-field-error-label' : undefined}>设备状态 <em className="kgd-req">*</em></span>
        <Select style={{ width: '100%', ...redBorder(tried && !form.status) }} value={form.status} onChange={(v) => setForm({ ...form, status: v })} options={['正常', '维修中', '运行中'].map((v) => ({ value: v, label: v }))} />
        <span className={tried && !form.category_id ? 'kgd-field-error-label' : undefined}>设备类别 <em className="kgd-req">*</em></span>
        <Select style={{ width: '100%' }} value={form.category_id || undefined} onChange={(v) => setForm({ ...form, category_id: v })} options={(cats.data?.items ?? []).map((c) => ({ value: String(c.id), label: String(c.name) }))} />
        <span>同步创建机台 <em className="kgd-req">*</em></span>
        <Radio.Group value={form.sync_machine} onChange={(e) => setForm({ ...form, sync_machine: e.target.value })}><Radio value="是">是</Radio><Radio value="否">否</Radio></Radio.Group>
        <span className={tried && !form.team_name ? 'kgd-field-error-label' : undefined}>团队 <em className="kgd-req">*</em></span>
        <Input value={form.team_name} onChange={(e) => setForm({ ...form, team_name: e.target.value })} />
        <span className={tried && !form.owner_name ? 'kgd-field-error-label' : undefined}>设备负责人 <em className="kgd-req">*</em></span>
        <Input placeholder="姓名/简拼" value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} />
        <span>车间</span><Input value={form.shop_name} onChange={(e) => setForm({ ...form, shop_name: e.target.value })} />
        <span>产线</span><Input value={form.line_name} onChange={(e) => setForm({ ...form, line_name: e.target.value })} />
      </div>
    </Modal>
  </>;
}

export function DeviceDetailPage() {
  const id = idFromLocation('/device/detail/');
  const api = useEquipApi();
  const navigate = useNavigate();
  const remote = useRemote<{ device: Rec; qr: Rec | null; plans: Rec[]; repairs: Rec[] }>(id ? `/api/equip/devices/${id}` : null, api.revision, api.onExpired);
  const d = remote.data?.device;
  const [tab, setTab] = useState('物料清单');
  if (!d) return <div className="kgd-card">{remote.loading ? '正在读取数据…' : '设备不存在'}</div>;
  const info: [string, ReactNode][] = [
    ['设备图片', '无'], ['设备状态', emptyVal(d.status)],
    ['设备二维码', emptyVal(remote.data?.qr?.code)],
    ['设备类别', emptyVal(d.category_name)],
    ['设备规格', emptyVal(d.spec)], ['设备负责人', emptyVal(d.owner_name)], ['团队', emptyVal(d.team_name)], ['车间', emptyVal(d.shop_name)], ['产线', emptyVal(d.line_name)],
    ['启用/禁用', <Switch checked={d.enabled !== false} />], ['创建人', '本地管理员'], ['创建时间', emptyVal(d.created_at_text || d.created_at)],
  ];
  return <div className="kgd-card">
    <div className="kgd-actions">
      <Button onClick={() => navigate('/device/list')}>返回</Button>
      <Button danger onClick={() => api.modal.confirm({ title: '确定删除该设备？', onOk: () => api.act(`/api/equip/devices/${id}`, {}, 'DELETE').then(() => navigate('/device/list')) })}>删除</Button>
    </div>
    <h3>{String(d.name)}({String(d.code)})</h3>
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24 }}>
      <dl className="kgd-detail-grid">{info.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <div>
        <div className="kgd-toolbar">{['物料清单', '维保计划', '维保记录', '维修工单', '点检记录', '日志'].map((name) => <Button key={name} type={tab === name ? 'primary' : 'default'} onClick={() => setTab(name)}>{name}</Button>)}</div>
        {tab === '物料清单' && <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={(Array.isArray(d.materials) ? d.materials as Rec[] : [])} columns={[
            { title: '序号', render: (_, __, i) => i + 1 }, { title: '物料名称', dataIndex: 'name' }, { title: '物料编号', dataIndex: 'code' },
            { title: '物料规格', dataIndex: 'spec' }, { title: '数量', dataIndex: 'qty' }, { title: '单位', dataIndex: 'unit' },
            { title: '可用库存', render: () => '-' }, { title: '当前库存', render: () => '-' }, { title: '备注', dataIndex: 'note' },
          ]} />}
        {tab === '维保计划' && <Table size="small" dataSource={remote.data?.plans ?? []} columns={[{ title: '计划名称', dataIndex: 'title' }, { title: '状态', dataIndex: 'status' }, { title: '循环周期', dataIndex: 'cycle_text' }]} />}
        {tab === '维保记录' && <Table size="small" dataSource={[]} columns={[{ title: '执行时间', dataIndex: 'executed_at' }, { title: '结果', dataIndex: 'result' }]} />}
        {tab === '维修工单' && <Table size="small" dataSource={remote.data?.repairs ?? []} columns={[{ title: '工单编号', dataIndex: 'code' }, { title: '状态', dataIndex: 'status' }, { title: '故障描述', dataIndex: 'description' }]} />}
        {tab === '点检记录' && <Table size="small" dataSource={[]} columns={[{ title: '点检时间', dataIndex: 'checked_at' }, { title: '点检人', dataIndex: 'inspector_name' }]} />}
        {tab === '日志' && <div className="kgd-muted">暂无数据</div>}
      </div>
    </div>
  </div>;
}

export function DeviceQrList() {
  const api = useEquipApi();
  const list = useQueryState();
  const bind = list.chips.bind || '全部';
  const remote = useRemote<{ items: Rec[] }>(`/api/equip/qrcodes?bind=${encodeURIComponent(bind)}`, api.revision, api.onExpired);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('生成Excel');
  const [count, setCount] = useState('');
  const [tried, setTried] = useState(false);
  const [adv, setAdv] = useState(false);
  const rows = remote.data?.items ?? [];
  const cols = [
    { key: 'code', title: '二维码编号', render: (row: Rec) => dash(row.code) },
    { key: 'device', title: '设备名称', render: (row: Rec) => dash(row.device_name) },
    { key: 'spec', title: '设备规格', render: (row: Rec) => dash(row.device_spec) },
    { key: 'dcode', title: '设备编号', render: (row: Rec) => dash(row.device_code) },
    { key: 'created', title: '生成时间', render: (row: Rec) => dash(row.created_at) },
    { key: 'actions', title: '操作', render: (row: Rec) => <>
      {row.device_name ? <button className="kgd-link" onClick={() => api.modal.confirm({ title: '确定解绑该二维码？', onOk: () => api.act(`/api/equip/qrcodes/${row.id}/unbind`, {}) })}>解绑</button> : null}{' '}
      <button className="kgd-link" onClick={() => api.modal.confirm({ title: '确定删除？', onOk: () => api.act(`/api/equip/qrcodes/${row.id}`, {}, 'DELETE') })}>删除</button>
    </> },
  ];
  return <>
    <ListFrame pageKey="device_qr" rows={rows} loading={remote.loading} error={remote.error}
      chips={[{ key: 'bind', label: '绑定二维码', options: ['全部', '已绑定', '未绑定'].map((v) => ({ value: v, label: v })) }]}
      chipValue={{ bind }} onChip={list.onChip}
      queryNode={<div className="kgd-query-fields"><Input style={{ width: 240 }} placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(e) => list.onQuery('q', e.target.value)} onPressEnter={list.onSearch} /><Button type="link" onClick={() => setAdv((v) => !v)}>高级查询</Button><AdvSearch open={adv} fields={['二维码编号', '设备名称', '设备编号', '设备规格', '生成时间']} onSearch={() => { list.onSearch(); setAdv(false); }} onClear={list.onClear} onClose={() => setAdv(false)} /></div>}
      queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => { setOpen(true); setTried(false); }}>生成</Button>}
      columns={cols} />
    <Modal title="生成设备二维码" open={open} okText="生成并下载二维码文件" cancelText="取消" onCancel={() => setOpen(false)}
      onOk={() => {
        setTried(true);
        if (!count.trim()) { api.message.error('请填写生成二维码数量'); return; }
        void api.act('/api/equip/qrcodes', { count: Number(count), mode }).then((ok) => { if (ok) setOpen(false); });
      }}>
      <div className="kgd-form">
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}><Radio.Button value="生成Excel">生成Excel</Radio.Button><Radio.Button value="生成图片">生成图片</Radio.Button></Radio.Group>
        <span className={tried && !count ? 'kgd-field-error-label ant-form-item-required' : 'ant-form-item-required'}>生成二维码数量</span>
        <Input style={redBorder(tried && !count)} value={count} onChange={(e) => setCount(e.target.value)} />
      </div>
    </Modal>
  </>;
}
