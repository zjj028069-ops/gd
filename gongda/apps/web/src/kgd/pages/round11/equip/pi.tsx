import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, Input, Modal, Select, Switch, Table } from 'antd';
import { AdvSearch, useEquipApi, useQueryState, useRemote, ListFrame, dash, StatusTag, type Rec } from './shared';

export function PiPlanList() {
  const api = useEquipApi();
  const list = useQueryState();
  const navigate = useNavigate();
  const enabled = list.chips.enabled || '启用';
  const remote = useRemote<{ items: Rec[] }>(`/api/equip/pi-plans?enabled=${encodeURIComponent(enabled)}`, api.revision, api.onExpired);
  const [adv, setAdv] = useState(false);
  const [tab, setTab] = useState('设备点检');
  const [selected, setSelected] = useState<string[]>([]);
  const rows = useMemo(() => {
    if (tab !== '设备点检') return [] as Rec[];
    const q = list.query.q;
    return (remote.data?.items ?? []).filter((row) => !q || [row.device_name, row.device_code, row.executor_name].some((v) => String(v ?? '').includes(q)));
  }, [remote.data, list.query, tab]);
  const cols = tab === '设备点检' ? [
    { key: 'code', title: '设备编号', render: (row: Rec) => dash(row.device_code) },
    { key: 'name', title: '设备名称', render: (row: Rec) => dash(row.device_name) },
    { key: 'status', title: '运行状态', render: (row: Rec) => <StatusTag text={String(row.status || '-')} /> },
    { key: 'category', title: '设备类别', render: (row: Rec) => dash(row.category_name) },
    { key: 'executor', title: '执行人/执行团队', render: (row: Rec) => dash(row.executor_name) },
    { key: 'team', title: '团队', render: (row: Rec) => dash(row.team_name) },
    { key: 'content', title: '维保内容', render: (row: Rec) => row.content_title ? <span className="kgd-link">{String(row.content_title)}({Number(row.content_count || 0)})</span> : '-' },
    { key: 'enabled', title: '启用/禁用', render: (row: Rec) => <Switch checked={Boolean(row.enabled)} onChange={(v) => void api.act(`/api/equip/pi-plans/${row.id}`, { enabled: v }, 'PATCH')} /> },
    { key: 'last', title: '上次点检时间', render: (row: Rec) => dash(row.last_at_text) },
    { key: 'created', title: '创建时间', render: (row: Rec) => dash(row.created_at_text) },
    { key: 'actions', title: '操作', render: (row: Rec) => <><button className="kgd-link" onClick={() => navigate(`/point_inspection_plan/add/1?id=${row.id}`)}>修改</button>{' '}<button className="kgd-link" onClick={() => api.modal.confirm({ title: '确定删除？', onOk: () => api.act(`/api/equip/pi-plans/${row.id}`, {}, 'DELETE') })}>删除</button></> },
  ] : [
    { key: 'customer', title: '客户', render: () => '-' }, { key: 'product', title: '产品', render: () => '-' }, { key: 'team', title: '团队', render: () => '-' },
    { key: 'code', title: '编号', render: () => '-' }, { key: 'category', title: '类别', render: () => '-' }, { key: 'qr', title: '产品二维码', render: () => '-' },
    { key: 'owner', title: '负责人', render: () => '-' }, { key: 'warranty', title: '质保日期', render: () => '-' }, { key: 'wstatus', title: '保修状态', render: () => '-' },
    { key: 'executor', title: '执行人/执行团队', render: () => '-' }, { key: 'content', title: '维保内容', render: () => '-' },
    { key: 'enabled', title: '启用/禁用', render: () => '-' }, { key: 'last', title: '上次点检时间', render: () => '-' }, { key: 'created', title: '创建时间', render: () => '-' },
    { key: 'actions', title: '操作', render: () => '-' },
  ];
  return <ListFrame pageKey="point_inspection_plan" rows={rows} loading={remote.loading} error={remote.error}
    viewTabs={[{ key: '设备点检', label: '设备点检' }, { key: '客户产品点检', label: '客户产品点检' }]} activeView={tab} onView={setTab}
    chips={[{ key: 'enabled', label: '是否启用', options: ['全部', '启用', '禁用'].map((v) => ({ value: v, label: v })) }]} chipValue={{ enabled }} onChip={list.onChip}
    queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    queryNode={<div className="kgd-query-fields"><Input style={{ width: 240 }} placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(e) => list.onQuery('q', e.target.value)} onPressEnter={list.onSearch} /><Button type="link" onClick={() => setAdv((v) => !v)}>高级查询</Button></div>}
    page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage} rowSelection={{ selected, onChange: setSelected }}
    toolbar={<><Button type="primary" onClick={() => navigate('/point_inspection_plan/add/1')}>新增</Button><AdvSearch open={adv} fields={['设备名称', '设备编号', '设备类别', '执行人/执行团队', '团队', '上次点检时间', '创建时间', '客户', '产品', '产品类别', '编号', '产品二维码', '产品负责人', '保修状态', '维保内容']} onSearch={() => { list.onSearch(); setAdv(false); }} onClear={list.onClear} onClose={() => setAdv(false)} /></>}
    moreItems={[{ key: 'import', label: '导入点检计划' }, { key: 'export_all', label: '导出(所有列)' }, { key: 'export_visible', label: '导出(显示列)' }]}
    applySpecColumns={tab === '设备点检'}
    columns={cols} />;
}

type PiLine = { id: string; code: string; name: string; category_name: string; team: string; executor: string; content_id: string; content_title: string };

export function PiPlanAdd() {
  const api = useEquipApi();
  const navigate = useNavigate();
  const devices = useRemote<{ items: Rec[] }>('/api/equip/devices', api.revision, api.onExpired);
  const contents = useRemote<{ items: Rec[] }>('/api/equip/contents', api.revision, api.onExpired);
  const [lines, setLines] = useState<PiLine[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [pickDevice, setPickDevice] = useState(false);
  const [pickSel, setPickSel] = useState<string[]>([]);
  const [pickContent, setPickContent] = useState(false);
  const [pickExec, setPickExec] = useState(false);
  const [exec, setExec] = useState('');
  const [team, setTeam] = useState('默认团队');

  async function create() {
    if (!lines.length) { api.message.error('请选择设备'); return; }
    const result = await api.act('/api/equip/pi-plans', { items: lines.map((l) => ({ device_id: l.id, content_id: l.content_id || null, executor_name: l.executor, team_name: l.team })) });
    if (result) navigate('/point_inspection_plan/list');
  }

  return <div className="kgd-card">
    <div className="kgd-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button onClick={() => navigate('/point_inspection_plan/list')}>返回</Button>
      <Button type="primary" onClick={() => { setPickDevice(true); setPickSel([]); }}>+ 选择设备</Button>
      <Button disabled={!selected.length} onClick={() => setPickContent(true)}>+ 批量设置维保内容</Button>
      <Button disabled={!selected.length} onClick={() => setPickExec(true)}>+ 批量设置执行人/执行团队</Button>
      <Button type="primary" onClick={() => void create()}>创建点检计划</Button>
    </div>
    <Table size="small" rowKey="id" locale={{ emptyText: '暂无数据' }} style={{ marginTop: 16 }}
      rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)) }}
      dataSource={lines} pagination={false}
      columns={[
        { title: '设备编号', dataIndex: 'code' }, { title: '设备名称', dataIndex: 'name' }, { title: '设备类别', dataIndex: 'category_name' },
        { title: '团队', dataIndex: 'team' }, { title: '执行人/执行团队', dataIndex: 'executor' },
        { title: '维保内容', dataIndex: 'content_title', render: (v) => dash(v) },
        { title: '操作', render: (_, row) => <button className="kgd-link" onClick={() => setLines((cur) => cur.filter((l) => l.id !== row.id))}>删除</button> },
      ]} />
    <Modal title="选择设备" open={pickDevice} width={800} onCancel={() => setPickDevice(false)} okText="确定" cancelText="取消"
      onOk={() => {
        const map = new Map(lines.map((l) => [l.id, l]));
        for (const d of devices.data?.items ?? []) {
          if (!pickSel.includes(String(d.id))) continue;
          if (!map.has(String(d.id))) map.set(String(d.id), { id: String(d.id), code: String(d.code), name: String(d.name), category_name: String(d.category_name || ''), team: '默认团队', executor: '', content_id: '', content_title: '' });
        }
        setLines([...map.values()]); setPickDevice(false);
      }}>
      <Table size="small" rowKey="id" rowSelection={{ selectedRowKeys: pickSel, onChange: (keys) => setPickSel(keys.map(String)) }}
        dataSource={devices.data?.items ?? []} pagination={{ pageSize: 10, showTotal: (n) => `共${n}条数据` }}
        columns={['设备编号', '设备名称', '设备规格', '设备状态', '设备类别', '车间', '产线', '负责人', '团队', '创建时间'].map((title, i) => {
          const keys = ['code', 'name', 'spec', 'status', 'category_name', 'shop_name', 'line_name', 'owner_name', 'team_name', 'created_at_text'];
          return { title, dataIndex: keys[i] };
        })} />
    </Modal>
    <Modal title="选择维保内容" open={pickContent} footer={null} onCancel={() => setPickContent(false)} width={720}>
      <Table size="small" rowKey="id" dataSource={contents.data?.items ?? []} pagination={{ pageSize: 10 }}
        onRow={(row) => ({ onClick: () => { setLines((cur) => cur.map((l) => selected.includes(l.id) ? { ...l, content_id: String(row.id), content_title: String(row.title) } : l)); setPickContent(false); } })}
        columns={[{ title: '标题', dataIndex: 'title' }, { title: '检查项', render: (_, row) => `查看(${row.item_count || 0})` }, { title: '备注', dataIndex: 'note' }, { title: '创建人', dataIndex: 'creator_name' }]} />
    </Modal>
    <Modal title="批量设置执行人/执行团队" open={pickExec} onCancel={() => setPickExec(false)} okText="确定" cancelText="取消"
      onOk={() => { setLines((cur) => cur.map((l) => selected.includes(l.id) ? { ...l, executor: exec, team } : l)); setPickExec(false); }}>
      <div className="kgd-form" style={{ display: 'grid', gap: 8 }}>
        <label>执行人/执行团队<br /><Input placeholder="姓名/简拼" value={exec} onChange={(e) => setExec(e.target.value)} /></label>
        <label>团队<br /><Select style={{ width: '100%' }} value={team} onChange={setTeam} options={[{ value: '默认团队', label: '默认团队' }]} /></label>
      </div>
    </Modal>
  </div>;
}

export function PiRecordList() {
  const api = useEquipApi();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[] }>('/api/equip/pi-records', api.revision, api.onExpired);
  const [adv, setAdv] = useState(false);
  const [tab, setTab] = useState('设备点检');
  const [selected, setSelected] = useState<string[]>([]);
  const time = list.chips.time || '全部';
  const check = list.chips.check || '全部';
  const all = remote.data?.items ?? [];
  const counts = {
    time: { 全部: all.length, 昨天: 0, 今天: 0, 本周: 0, 本月: 0 },
    check: { 全部: all.length, 异常: all.filter((r) => Number(r.abnormal_count) > 0).length, 正常: all.filter((r) => Number(r.abnormal_count) === 0 && Number(r.normal_count) > 0).length, 待定: 0 },
  };
  const rows = useMemo(() => {
    if (tab !== '设备点检') return [] as Rec[];
    return all.filter((row) => {
      if (check === '异常' && !(Number(row.abnormal_count) > 0)) return false;
      if (check === '正常' && Number(row.abnormal_count) > 0) return false;
      if (list.query.q && ![row.device_name, row.device_code, row.inspector_name].some((v) => String(v ?? '').includes(list.query.q))) return false;
      return true;
    });
  }, [all, check, list.query, tab]);
  const cols = tab === '设备点检' ? [
    { key: 'device', title: '设备', render: (row: Rec) => <>{dash(row.device_name)}{row.abnormal ? <span style={{ color: '#ff4d4f', marginLeft: 4 }}>▲</span> : null}</> },
    { key: 'code', title: '设备编号', render: (row: Rec) => dash(row.device_code) },
    { key: 'category', title: '设备类别', render: (row: Rec) => dash(row.category_name) },
    { key: 'inspector', title: '点检人', render: (row: Rec) => dash(row.inspector_name) },
    { key: 'team', title: '团队', render: (row: Rec) => dash(row.team_name) },
    { key: 'content', title: '维保内容', render: (row: Rec) => dash(row.content_name) },
    { key: 'spare', title: '备件使用', render: (row: Rec) => dash(row.spare_text) },
    { key: 'normal', title: '正常项', render: (row: Rec) => String(row.normal_count ?? 0) },
    { key: 'abnormal', title: '异常项', render: (row: Rec) => <span style={{ color: Number(row.abnormal_count) > 0 ? '#ff4d4f' : undefined }}>{String(row.abnormal_count ?? 0)}</span> },
    { key: 'time', title: '点检时间', render: (row: Rec) => dash(row.checked_at_text || row.checked_at) },
    { key: 'actions', title: '操作', render: (row: Rec) => <Dropdown menu={{ items: [{ key: 'del', label: '删除', onClick: () => void api.act(`/api/equip/pi-records/${row.id}`, {}, 'DELETE') }] }}><button className="kgd-link">更多</button></Dropdown> },
  ] : [
    { key: 'customer', title: '客户', render: () => '-' }, { key: 'product', title: '产品', render: () => '-' }, { key: 'team', title: '团队', render: () => '-' },
    { key: 'code', title: '编号', render: () => '-' }, { key: 'category', title: '类别', render: () => '-' }, { key: 'warranty', title: '保修状态', render: () => '-' },
    { key: 'inspector', title: '点检人', render: () => '-' }, { key: 'content', title: '维保内容', render: () => '-' }, { key: 'spare', title: '备件使用', render: () => '-' },
    { key: 'normal', title: '正常项', render: () => '0' }, { key: 'abnormal', title: '异常项', render: () => '0' },
    { key: 'time', title: '点检时间', render: () => '-' }, { key: 'actions', title: '操作', render: () => '-' },
  ];
  return <ListFrame pageKey="point_inspection_record" rows={rows} loading={remote.loading} error={remote.error}
    viewTabs={[{ key: '设备点检', label: '设备点检' }, { key: '客户产品点检', label: '客户产品点检' }]} activeView={tab} onView={setTab}
    chips={[
      { key: 'time', label: '点检时间', options: ['全部', '昨天', '今天', '本周', '本月'].map((v) => ({ value: v, label: `${v}(${counts.time[v as keyof typeof counts.time] ?? 0})` })) },
      { key: 'check', label: '检查项', options: ['全部', '异常', '正常', '待定'].map((v) => ({ value: v, label: `${v}(${counts.check[v as keyof typeof counts.check] ?? 0})` })) },
    ]} chipValue={{ time, check }} onChip={list.onChip}
    queryFields={[{ key: 'q', label: '关键字', placeholder: '输入关键字查询' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    queryNode={<div className="kgd-query-fields"><Input style={{ width: 240 }} placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(e) => list.onQuery('q', e.target.value)} onPressEnter={list.onSearch} /><Button type="link" onClick={() => setAdv((v) => !v)}>高级查询</Button></div>}
    page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage} rowSelection={{ selected, onChange: setSelected }}
    toolbar={<AdvSearch open={adv} fields={['设备名称', '设备编号', '设备类别', '点检人', '团队', '点检时间', '维保内容']} onSearch={list.onSearch} onClear={list.onClear} onClose={() => setAdv(false)} />}
    applySpecColumns={tab === '设备点检'}
    columns={cols} />;
}
