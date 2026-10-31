import { useState } from 'react';
import { App, Button, Form, Input, Modal, Select } from 'antd';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { ListFrame } from '../../ListFrame';
import { useQueryState } from '../../kit';

type Team = { id: string; name: string; intro: string; version: number; member_ids: string[]; member_names: string; parent_id: string | null; leader_id: string | null; leader_name?: string; region?: string; created_text?: string };
type User = { id: string; display_name: string; department_path?: string; phone?: string; status_text?: string };

export function TeamPage() {
  const { session, revision, onChanged, onExpired } = useKgd();
  const { message } = App.useApp();
  const list = useQueryState();
  const remote = useRemote<{ items: Team[]; tip: string }>('/api/system/teams', revision, onExpired);
  const users = useRemote<{ items: User[] }>('/api/system/users', revision, onExpired);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Team | null>(null);
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string | undefined>();
  const [leader, setLeader] = useState<string | undefined>();
  const [intro, setIntro] = useState('');
  const [region, setRegion] = useState('');
  const [selected, setSelected] = useState<string | undefined>();
  const [adding, setAdding] = useState<string[]>([]);
  const [transferTo, setTransferTo] = useState<string | undefined>();
  const [moving, setMoving] = useState<string | undefined>();
  const [nameErr, setNameErr] = useState('');
  const teams = remote.data?.items ?? [];
  const tip = remote.data?.tip || '未选上级团队默认为第一级团队。';
  const current = teams.find((item) => item.id === selected);
  const userName = (id: string) => users.data?.items.find((item) => item.id === id);
  function begin(row?: Team | null, asChild?: boolean) {
    setEdit(row ?? null);
    setName(row && !asChild ? row.name : '');
    setParent(asChild && row ? row.id : (row?.parent_id ?? undefined));
    setLeader(row && !asChild ? row.leader_id ?? undefined : undefined);
    setIntro(row && !asChild ? (row.intro === '-' ? '' : row.intro) : '');
    setRegion(row && !asChild ? row.region ?? '' : '');
    setNameErr('');
    setOpen(true);
  }
  async function add() {
    if (!name.trim()) { setNameErr('请填写团队名称'); message.error('请填写团队名称'); return; }
    setNameErr('');
    if (!leader) { message.error('请选择团队主管'); return; }
    try {
      if (edit) {
        await apiRequest(`/api/system/teams/${edit.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body: { name, parent_id: parent ?? null, leader_id: leader, intro, version: edit.version, member_ids: edit.member_ids } });
      } else {
        const created = await apiRequest<{ team: { id: string } }>('/api/system/teams', { method: 'POST', csrfToken: session.csrf_token, body: { name, parent_id: parent ?? null, leader_id: leader, intro } });
        setSelected(created.team.id);
      }
      setOpen(false);
      message.success('已保存');
      onChanged();
    } catch (error) { message.error(error instanceof Error ? error.message : '保存失败'); }
  }
  async function saveMembers(team: Team, memberIds: string[]) {
    await apiRequest(`/api/system/teams/${team.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body: { name: team.name, parent_id: team.parent_id, leader_id: team.leader_id, intro: team.intro === '-' ? '' : team.intro, version: team.version, member_ids: memberIds } });
  }
  async function addMembers() {
    if (!current || !adding.length) return;
    await saveMembers(current, [...new Set([...current.member_ids, ...adding])]);
    setAdding([]);
    message.success('已加入');
    onChanged();
  }
  async function transfer(userId: string) {
    if (!current || !transferTo || transferTo === current.id) return;
    const target = teams.find((item) => item.id === transferTo);
    if (!target) return;
    await saveMembers(current, current.member_ids.filter((id) => id !== userId));
    const fresh = (await apiRequest<{ items: Team[] }>('/api/system/teams')).items.find((item) => item.id === target.id);
    if (!fresh) return;
    await saveMembers(fresh, [...new Set([...fresh.member_ids, userId])]);
    message.success('已转移');
    onChanged();
  }
  async function remove(row: Team) {
    try {
      await apiRequest(`/api/system/teams/${row.id}`, { method: 'DELETE', csrfToken: session.csrf_token });
      message.success('已删除');
      onChanged();
    } catch (error) { message.error(error instanceof Error ? error.message : '删除失败'); }
  }
  return <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16 }}>
    <ListFrame pageKey="teams" rows={teams} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'name', label: '团队名' }, { key: 'member', label: '团队人员' }, { key: 'leader', label: '主管' }, { key: 'address', label: '地址' }]}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={list.pageSize} total={teams.length} onPage={list.onPage}
      toolbar={<Button type="primary" onClick={() => begin()}>新增</Button>}
      onRow={(row) => setSelected(row.id)}
      columns={[
        { key: 'name', title: '团队名', render: (row) => row.name },
        { key: 'leader', title: '主管', render: (row) => row.leader_name || userName(row.leader_id ?? '')?.display_name || '-' },
        { key: 'members', title: '团队人员', render: (row) => row.member_names || '-' },
        { key: 'region', title: '地区', render: (row) => row.region || '-' },
        { key: 'intro', title: '团队描述', render: (row) => row.intro || '-' },
        { key: 'actions', title: '操作', render: (row) => <>
          <Button type="link" onClick={() => begin(row, true)}>添加下级</Button>
          <Button type="link" onClick={() => begin(row)}>修改</Button>
          <Button type="link" danger onClick={() => void remove(row)}>删除</Button>
        </> },
      ]} />
    <div className="kgd-card">
      <h3>{current ? current.name : '团队详情'}</h3>
      {current && <>
        <div style={{ marginBottom: 8 }}>新增团队人员</div>
        <Select mode="multiple" showSearch optionFilterProp="label" placeholder="选择人员" style={{ minWidth: 220, marginRight: 8 }} value={adding} onChange={setAdding} options={(users.data?.items ?? []).filter((item) => !current.member_ids.includes(item.id)).map((item) => ({ value: item.id, label: item.display_name }))} />
        <Button type="primary" onClick={() => void addMembers()}>加入</Button>
        <table className="ant-table" style={{ marginTop: 12, width: '100%' }}><tbody>
          {current.member_ids.map((id, index) => {
            const user = userName(id);
            return <tr key={id} className="ant-table-row"><td>{index + 1}</td><td>{user?.display_name ?? '-'}</td><td>{user?.department_path || '-'}</td><td>{user?.phone || '-'}</td><td>{user?.status_text || '-'}</td><td><Button type="link" onClick={() => setMoving(id)}>转移团队</Button></td></tr>;
          })}
        </tbody></table>
        <Modal title="转移团队" open={!!moving} onCancel={() => setMoving(undefined)} onOk={() => { if (moving) void transfer(moving).then(() => setMoving(undefined)); }} okText="确定" cancelText="取消">
          <Select style={{ width: '100%' }} placeholder="目标团队" value={transferTo} onChange={setTransferTo} options={teams.filter((item) => item.id !== current.id).map((item) => ({ value: item.id, label: item.name }))} />
        </Modal>
      </>}
    </div>
    <Modal title="新增团队" open={open} onCancel={() => setOpen(false)} onOk={() => void add()} okText="确定" cancelText="取消">
      <Form layout="vertical">
        <Form.Item label="上级团队" tooltip={tip}><Select allowClear placeholder="上级团队" value={parent} onChange={setParent} options={teams.map((item) => ({ value: item.id, label: item.name }))} /></Form.Item>
        <p className="kgd-muted">{tip}</p>
        <Form.Item label="团队名" required validateStatus={nameErr ? 'error' : undefined} help={nameErr || undefined}><Input placeholder="团队名称" className={nameErr ? 'kgd-field-error' : undefined} value={name} onChange={(event) => { setNameErr(''); setName(event.target.value); }} /></Form.Item>
        <Form.Item label="团队主管" required><Select placeholder="团队主管" value={leader} onChange={setLeader} options={(users.data?.items ?? []).map((item) => ({ value: item.id, label: item.display_name }))} /></Form.Item>
        <Form.Item label="团队介绍"><Input value={intro} onChange={(event) => setIntro(event.target.value)} /></Form.Item>
        <Form.Item label="负责区域"><Input value={region} onChange={(event) => setRegion(event.target.value)} /></Form.Item>
      </Form>
    </Modal>
  </div>;
}
