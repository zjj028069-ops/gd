import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { App, Button, Input, Modal, Select, Switch } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ExtensionAddDialog, ExtensionModal } from '../../dialogs';
import { extFieldPayload } from '../../extensions/bind';
import { useEntityExtensions } from '../../extensions/useEntityExtensions';
import { ListFrame } from '../../ListFrame';
import type { ListColumn } from '../../ListFrame';
import { showError, useCommand, useQueryState, beijingTime } from '../../kit';
import { dash, linkText, StatusTag } from '../round8/kit';
import { LeanWorkstation } from './workstation';

export { LeanWorkstation };

type Rec = Record<string, string> & { id: string };

export function RectifyCenter() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const source = list.chips.source || '现场巡查';
  const status = list.chips.status || '全部';
  const remote = useRemote<{ items: Rec[]; counts: Record<string, number>; statusCounts: Record<string, number> }>(`/api/lean/rectify?source=${encodeURIComponent(source)}&status=${encodeURIComponent(status)}`, revision, onExpired);
  const counts = remote.data?.counts ?? {};
  const statusCounts = remote.data?.statusCounts ?? {};
  const columns: ListColumn<Rec>[] = [
    { key: 'dept', title: '责任部门', render: (row) => dash(row.department_name) },
    { key: 'owner', title: '责任人', render: (row) => dash(row.owner_names) },
    { key: 'category', title: '问题分类', render: (row) => dash(row.category) },
    { key: 'desc', title: '问题描述', render: (row) => dash(row.description) },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={row.status} /> },
    { key: 'ref', title: '关联', render: (row) => linkText(row.ref_code, row.source) },
  ];
  return <ListFrame pageKey="rectify" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error}
    viewTabs={['现场巡查', '生产质检', '售后反馈', '客户投诉', '设计问题', '物料问题'].map((item) => ({ key: item, label: `${item}(${counts[item] ?? 0})` }))} activeView={source} onView={(key) => list.onChip('source', key)}
    chips={[{ key: 'status', label: '处理状态', options: [{ value: '全部', label: '全部' }, { value: '待处理', label: `待处理(${statusCounts['待处理'] ?? 0})` }, { value: '已处理', label: `已处理(${statusCounts['已处理'] ?? 0})` }, { value: '驳回', label: `驳回(${statusCounts['驳回'] ?? 0})` }] }]}
    chipValue={{ status }} onChip={list.onChip}
    queryFields={[{ key: 'q', label: '问题描述' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} />;
}

export function MeetingList() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const navigate = useNavigate();
  const remote = useRemote<{ items: Rec[] }>('/api/lean/meetings', revision, onExpired);
  const ext = useEntityExtensions('lean_meeting');
  const agenda = useEntityExtensions('meeting_agenda');
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Rec | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [time, setTime] = useState('');
  const [form, setForm] = useState('线下会议');
  const [members, setMembers] = useState('');
  const [place, setPlace] = useState('');
  const [related, setRelated] = useState('');
  const [addExt, setAddExt] = useState(false);
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [agendaAdd, setAgendaAdd] = useState(false);
  const [agendaEditId, setAgendaEditId] = useState('');
  const agendaEdit = agenda.fields.find((field) => field.id === agendaEditId) ?? null;
  function fill(row?: Rec | null) {
    setEdit(row ?? null);
    setTitle(row?.title ?? '');
    setContent(row?.content ?? '');
    setTime(String(row?.meet_at ?? '').slice(0, 16));
    setForm(row?.form || '线下会议');
    setMembers(row?.member_names ?? '');
    setPlace(row?.place ?? '');
    setOpen(true);
  }
  function saveAgenda(value: Parameters<typeof extFieldPayload>[0], id?: string) {
    const job = id ? agenda.updateField(id, extFieldPayload(value)) : agenda.createField(extFieldPayload(value));
    void job.then(() => { setAgendaAdd(false); setAgendaEditId(''); message.success('已保存'); }).catch((error) => message.error(showError(error)));
  }
  const columns: ListColumn<Rec>[] = [
    { key: 'title', title: '会议主题', render: (row) => <Button type="link" onClick={() => navigate(`/meeting/detail/${row.id}`)}>{row.title}</Button> },
    { key: 'content', title: '会议内容', render: (row) => dash(row.content) },
    { key: 'time', title: '会议时间', render: (row) => dash(row.meet_at) },
    { key: 'form', title: '会议形式', render: (row) => dash(row.form) },
    { key: 'members', title: '参会人员', render: (row) => dash(row.member_names) },
    { key: 'place', title: '会议地点', render: (row) => dash(row.place) },
    { key: 'progress', title: '落地进度', render: (row) => dash(row.progress) },
    { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
    { key: 'created', title: '创建时间', render: (row) => beijingTime(row.created_at, '') },
    { key: 'actions', title: '操作', render: (row) => <>
      <Button type="link" onClick={() => fill(row)}>修改</Button>
      <Button type="link" onClick={() => void command.send(`/api/lean/meetings/${row.id}`, {}, 'DELETE').then(() => message.success('已删除')).catch((error) => message.error(showError(error)))}>删除</Button>
    </> },
  ];
  return <>
    <ListFrame pageKey="meetings" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'members', label: '参会人员' }, { key: 'title', label: '会议主题' }, { key: 'from', label: '会议时间起', kind: 'date' }, { key: 'to', label: '会议时间止', kind: 'date' }, { key: 'creator', label: '创建人' }, { key: 'created_from', label: '创建时间起', kind: 'date' }, { key: 'created_to', label: '创建时间止', kind: 'date' }]}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage}
      showAdvancedSearch={false} primaryTools exportAll={false}
      toolbar={<Button type="primary" onClick={() => fill()}>新建会议</Button>}
      extensionObject="精益会议" extensionTitle="精益会议扩展字段管理" extensionRows={ext.extensionRows} extensionCanAdd
      onExtensionAdd={() => setAddExt(true)}
      onExtensionReorder={(ids) => { void ext.reorder(ids).catch((error) => message.error(showError(error))); }}
      onExtensionDelete={(id) => { void ext.deleteField(id).then(() => message.success('已删除')).catch((error) => message.error(showError(error))); }}
      afterExtension={<Button type="primary" onClick={() => setAgendaOpen(true)}>会议议程字段</Button>} />
    <ExtensionAddDialog open={addExt} mode="standard" onCancel={() => setAddExt(false)} onOk={(value) => {
      void ext.createField(extFieldPayload(value)).then(() => { setAddExt(false); message.success('已保存'); }).catch((error) => message.error(showError(error)));
    }} />
    <ExtensionModal open={agendaOpen} objectName="会议议程" title="会议议程字段管理" rows={agenda.extensionRows} canAdd
      onCancel={() => setAgendaOpen(false)} onAdd={() => { setAgendaEditId(''); setAgendaAdd(true); }}
      onEdit={(id) => { setAgendaAdd(false); setAgendaEditId(id); }}
      onReorder={(ids) => { void agenda.reorder(ids).catch((error) => message.error(showError(error))); }}
      onDelete={(id) => { void agenda.deleteField(id).then(() => message.success('已删除')).catch((error) => message.error(showError(error))); }} />
    <ExtensionAddDialog open={agendaAdd || !!agendaEdit} mode="standard" title={agendaEdit ? '修改议程字段' : '新增议程字段'}
      initial={agendaEdit ? {
        label: agendaEdit.name,
        required: agendaEdit.required,
        type: agendaEdit.field_type,
        options: (agendaEdit.options.choices ?? []).join(','),
        input_modes: agendaEdit.options.input_modes,
        biz_object: agendaEdit.options.biz_object,
        display_field: agendaEdit.options.display_field,
        rel_object: agendaEdit.options.rel_object,
        rel_field: agendaEdit.options.rel_field,
      } : null}
      onCancel={() => { setAgendaAdd(false); setAgendaEditId(''); }}
      onOk={(value) => saveAgenda(value, agendaEdit?.id)} />
    <Modal title="新增会议" open={open} okText="确定" cancelText="取消" onCancel={() => setOpen(false)} onOk={() => void command.send(edit ? `/api/lean/meetings/${edit.id}` : '/api/lean/meetings', { title, content, meet_at: time, form, member_names: members, place }, edit ? 'PATCH' : 'POST').then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <div className="kgd-form">
        <span>会议主题 *</span><Input value={title} onChange={(event) => setTitle(event.target.value)} />
        <span>会议内容</span><Input.TextArea value={content} onChange={(event) => setContent(event.target.value)} />
        <span>会议时间 *</span><Input type="datetime-local" value={time} onChange={(event) => setTime(event.target.value)} />
        <span>会议形式 *</span><Select value={form} onChange={setForm} options={['线下会议', '线上会议'].map((item) => ({ value: item, label: item }))} />
        <span>参会人员 *</span><Input value={members} onChange={(event) => setMembers(event.target.value)} />
        <span>会议地点</span><Input value={place} onChange={(event) => setPlace(event.target.value)} />
        <span>关联问题</span><Input value={related} onChange={(event) => setRelated(event.target.value)} />
      </div>
    </Modal>
  </>;
}

export function MeetingDetail() {
  const { pathname } = useLocation();
  const id = pathname.split('/').pop() ?? '';
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const remote = useRemote<{ items: Rec[] }>('/api/lean/meetings', revision, onExpired);
  const row = remote.data?.items.find((item) => item.id === id);
  return <div className="kgd-card">
    <div className="kgd-toolbar">
      <Button onClick={() => navigate('/meeting/list')}>返回</Button>
      <Button danger onClick={() => void command.send(`/api/lean/meetings/${id}`, {}, 'DELETE').then(() => { message.success('已删除'); navigate('/meeting/list'); }).catch((error) => message.error(showError(error)))}>删除</Button>
    </div>
    {row ? <div className="kgd-detail-grid">
      <dt>会议主题</dt><dd>{dash(row.title)}</dd>
      <dt>会议内容</dt><dd>{dash(row.content)}</dd>
      <dt>会议时间</dt><dd>{dash(row.meet_at)}</dd>
      <dt>会议形式</dt><dd>{dash(row.form)}</dd>
      <dt>参会人员</dt><dd>{dash(row.member_names)}</dd>
      <dt>会议地点</dt><dd>{dash(row.place)}</dd>
    </div> : <p>{remote.error || '加载中'}</p>}
  </div>;
}

export function MeetingTodo() {
  const { revision, onExpired } = useKgd();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[]; counts: Record<string, number> }>('/api/lean/todos', revision, onExpired);
  const columns: ListColumn<Rec>[] = [
    { key: 'title', title: '会议主题', render: (row) => dash(row.title) },
    { key: 'time', title: '会议时间', render: (row) => dash(row.meet_at) },
    { key: 'members', title: '参会人员', render: (row) => dash(row.member_names) },
    { key: 'place', title: '会议地点', render: (row) => dash(row.place) },
    { key: 'desc', title: '问题描述', render: (row) => dash(row.description) },
    { key: 'owner', title: '负责人', render: (row) => dash(row.owner_name) },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={row.status} /> },
    { key: 'due', title: '预计完成日期', render: (row) => dash(row.due_date) },
    { key: 'over', title: '逾期', render: (row) => dash(row.overdue_text) },
  ];
  return <ListFrame pageKey="meeting-todo" columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'q', label: '会议主题' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} />;
}

export function PatrolList() {
  const { revision, onExpired, session } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Rec[]; categories: string[] }>('/api/lean/patrols', revision, onExpired);
  const settings = useRemote<{ departments: { id: string; name: string }[] }>('/api/lean/settings', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [department, setDepartment] = useState('');
  const [owners, setOwners] = useState('');
  const [category, setCategory] = useState('生产问题');
  const [description, setDescription] = useState('');
  const columns: ListColumn<Rec>[] = [
    { key: 'dept', title: '责任部门', render: (row) => dash(row.department_name) },
    { key: 'owner', title: '责任人', render: (row) => dash(row.owner_names) },
    { key: 'category', title: '问题分类', render: (row) => dash(row.category) },
    { key: 'desc', title: '问题描述', render: (row) => dash(row.description) },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={row.status || '未处理'} /> },
    { key: 'inspector', title: '巡查人', render: (row) => dash(row.inspector_name) },
    { key: 'time', title: '巡查时间', render: (row) => beijingTime(row.created_at, '') },
    { key: 'actions', title: '操作', render: (row) => <Button type="link" onClick={() => void command.send(`/api/lean/patrols/${row.id}`, {}, 'DELETE').then(() => message.success('已删除')).catch((error) => message.error(showError(error)))}>删除</Button> },
  ];
  return <>
    <ListFrame pageKey="patrols" showMobileCard columns={columns} rows={remote.data?.items ?? []} loading={remote.loading} error={remote.error} queryFields={[{ key: 'dept', label: '责任部门' }, { key: 'category', label: '问题分类' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} page={list.page} pageSize={list.pageSize} total={remote.data?.items.length ?? 0} onPage={list.onPage} toolbar={<Button type="primary" onClick={() => setOpen(true)}>新增</Button>} />
    <Modal title="现场巡查" open={open} okText="确定" cancelText="取消" onCancel={() => setOpen(false)} onOk={() => void command.send('/api/lean/patrols', { department_name: department, owner_names: owners, category, description }).then(() => { setOpen(false); message.success('已保存'); }).catch((error) => message.error(showError(error)))}>
      <div className="kgd-form">
        <span>巡查人员 *</span><Input disabled value={session.user.display_name} />
        <span>责任部门 *</span><Select value={department || undefined} onChange={setDepartment} options={(settings.data?.departments ?? []).map((item) => ({ value: item.name, label: item.name }))} />
        <span>责任人</span><Input value={owners} onChange={(event) => setOwners(event.target.value)} />
        <span>问题分类 *</span><Select value={category} onChange={setCategory} options={(remote.data?.categories ?? ['安全问题', '生产问题']).map((item) => ({ value: item, label: item }))} />
        <span>问题描述 *</span><Input.TextArea maxLength={255} placeholder="问题描述" value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
    </Modal>
  </>;
}

export function LeanSetting() {
  const { revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const command = useCommand();
  const remote = useRemote<{ settings: Record<string, unknown>; departments: { id: string; name: string }[]; processes: { id: string; name: string }[] }>('/api/lean/settings', revision, onExpired);
  const saved = remote.data?.settings;
  const [block, setBlock] = useState<boolean | null>(null);
  const [joint, setJoint] = useState<boolean | null>(null);
  const [daily, setDaily] = useState<boolean | null>(null);
  const [minutes, setMinutes] = useState('');
  const [days, setDays] = useState('');
  if (!saved) return <div className="kgd-card"><p>{remote.error || '加载中'}</p></div>;
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => history.back()}>返回</Button></div>
    <h2>精益生产设置</h2>
    <p>精益生产工资结算设置 <Switch checked={block ?? Boolean(saved.block_wage)} onChange={setBlock} /> 开启后，有未完成的质量分析时，不允许结算工资；关闭时不受影响。</p>
    <p>精益生产责任连带设置 <Switch checked={joint ?? saved.joint_duty !== false} onChange={setJoint} /> 开启责任连带时，责任人所在部门的所有人都需要填写质量分析；关闭时，仅责任人需要填写质量分析。</p>
    <p>精益生产日报推送设置 <Switch checked={daily ?? Boolean(saved.daily_push)} onChange={setDaily} /> 开启后只保存设置，不进行推送。</p>
    <p>距离预计完成日期前 <Input style={{ width: 80 }} value={days || String(saved.agenda_warn_days ?? 0)} onChange={(event) => setDays(event.target.value)} /> 天发送到期预警。</p>
    <p>距离会议开始前 <Input style={{ width: 80 }} placeholder="请输入大于等于5的正整数" value={minutes || String(saved.meeting_remind_minutes ?? 5)} onChange={(event) => setMinutes(event.target.value)} /> 分钟发送会议提醒。</p>
    <p>参与部门：{(remote.data?.departments ?? []).map((item) => item.name).join('、') || '-'}</p>
    <p>黑榜工序：{(remote.data?.processes ?? []).slice(0, 6).map((item) => item.name).join('、') || '-'}</p>
    <Button type="primary" onClick={() => void command.send('/api/lean/settings', { block_wage: block ?? Boolean(saved.block_wage), joint_duty: joint ?? saved.joint_duty !== false, daily_push: daily ?? Boolean(saved.daily_push), meeting_remind_minutes: Number(minutes || saved.meeting_remind_minutes || 5), agenda_warn_days: Number(days || saved.agenda_warn_days || 0), board_limit: saved.board_limit ?? 10 }, 'PUT').then(() => message.success('已保存')).catch((error) => message.error(showError(error)))}>保存</Button>
  </div>;
}
