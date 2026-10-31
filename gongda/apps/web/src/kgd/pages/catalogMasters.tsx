import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Button, Dropdown, Input, Modal, Select, Switch, Table, Tabs, message } from 'antd';
import QRCode from 'qrcode';
import { apiRequest, canWriteProducts, hasPermission } from '../../api';
import { attachmentMime, attachmentSizeMessage, attachmentUploadPayload, processFields, routeSavePayload } from '../../domain/payloads';
import type { Process, Route, RouteStep } from '../../masterTypes';
import { idText } from '../../masterTypes';
import { useRemote } from '../../masterTools';
import { useKgd } from '../context';
import { ListFrame } from '../ListFrame';
import type { ListColumn } from '../ListFrame';
import { showError, StatusTag, useCommand, useQueryState } from '../kit';
import { QrImage } from '../qr';
import { useExtForm, useExtList } from '../extensions/bind';
import { DictPick } from './round10/produce/common';
import { quantityText } from '../../previewMath';
import { inspectionText, modeText, rateLabel } from '../wage';
import { qty } from '../qty';
import { requestKey } from '../../requestKey';

type Member = { id: string; display_name: string };

function partsOfMinutes(value: string) {
  try {
    const totalSeconds = (qty(value || '0') * 60n) / 1_000_000n;
    return { h: (totalSeconds / 3600n).toString(), m: ((totalSeconds % 3600n) / 60n).toString(), s: (totalSeconds % 60n).toString() };
  } catch { return { h: '0', m: '0', s: '0' }; }
}
function minutesFromParts(hours: string, minutes: string, seconds: string) {
  const total = qty(hours || '0') * 3600n + qty(minutes || '0') * 60n + qty(seconds || '0');
  return quantityText(total / 60n, false);
}

export function ProcessList() {
  const { revision, onExpired, session } = useKgd();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: Process[]; total: number; limit: number }>('/api/processes', revision, onExpired);
  const members = useRemote<{ items: Member[] }>('/api/team-members', revision, onExpired);
  const numbering = useRemote<{ items: { id: string; entity: string; active: boolean }[] }>(canWriteProducts(session) ? '/api/configuration/number-rules' : null, 0, onExpired);
  const [editing, setEditing] = useState<Process | null | undefined>(() => new URLSearchParams(window.location.search).get('add') === '1' ? null : undefined);
  const [activeTab, setActiveTab] = useState('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const [qr, setQr] = useState<Process | null>(null);
  const extList = useExtList('craft');
  // 理由：成员未加载完时勿把 reporter_ids 原样渲成 UUID（验收 #43 会扫 body）
  const name = (id: string) => members.data?.items.find((item) => String(item.id) === String(id))?.display_name ?? '';
  const rows = (remote.data?.items ?? []).filter((row) => {
    if (activeTab === 'on' && !row.active) return false;
    if (activeTab === 'off' && row.active) return false;
    if ((list.query.name ?? '') && !row.name.includes(list.query.name ?? '')) return false;
    if ((list.query.code ?? '') && !row.code.includes(list.query.code ?? '')) return false;
    return true;
  });
  const columns: ListColumn<Process>[] = [
    { key: 'name', title: '工序', render: (row) => row.name }, { key: 'code', title: '工序编号', render: (row) => row.code },
    { key: 'workshop', title: '车间', missing: true }, { key: 'line', title: '产线', missing: true },
    { key: 'mode', title: '计价方式', render: (row) => modeText(row.pricing_mode) },
    { key: 'rate', title: '工资单价', render: (row) => rateLabel(row.wage_rate) },
    { key: 'machine', title: '机台', missing: true },
    { key: 'reporters', title: '生产人员', render: (row) => row.reporter_ids.map(name).join('、') },
    { key: 'qcPeople', title: '质检人员', missing: true }, { key: 'defects', title: '不良品项', missing: true }, { key: 'unit', title: '报工单位', missing: true }, { key: 'ratio', title: '单位关系', missing: true },
    { key: 'minutes', title: '标准工时', render: (row) => `${row.standard_minutes} 分钟` },
    { key: 'clock', title: '生产任务计时', missing: true }, { key: 'scheme', title: '检验方案', render: (row) => inspectionText(row.inspection_scheme) }, { key: 'rework', title: '需返工/报废', missing: true }, { key: 'out', title: '需外协', missing: true },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={row.active ? '启用' : '禁用'} /> },
    { key: 'files', title: '附件', missing: true }, { key: 'extra', title: '报工附加组件', missing: true }, { key: 'qcExtra', title: '质检附加组件', missing: true },
    { key: 'note', title: '备注', render: (row) => row.description }, { key: 'creator', title: '创建人', missing: true }, { key: 'created', title: '创建时间', missing: true },
    { key: 'actions', title: '操作', width: 220, render: (row) => <>
      <Button type="link" onClick={() => setEditing(row)}>修改</Button>
      <Button type="link" onClick={() => setQr(row)}>查看二维码</Button>
      <Button type="link" disabled={!canWriteProducts(session) || command.busy} onClick={() => void toggle(row, !row.active)}>{row.active ? '禁用' : '启用'}</Button>
    </> },
  ];
  function toggle(row: Process, active: boolean) {
    return command.send(`/api/processes/${idText(row.id)}`, { ...processFields(row.name, row.description, row.standard_minutes, row.reporter_ids.map(idText), { pricing_mode: row.pricing_mode === 'time' ? 'time' : 'piece', wage_rate: row.wage_rate ?? null, inspection_scheme: row.inspection_scheme ?? 'none' }), version: row.version, active }, 'PATCH');
  }
  async function batch(active: boolean) {
    const targets = rows.filter((row) => chosen.includes(String(row.id)) && row.active !== active);
    if (!targets.length) { Modal.info({ title: '批量操作', content: '所选工序无需变更。' }); return; }
    const failed: string[] = [];
    for (const row of targets) {
      try { await toggle(row, active); } catch (failure) { failed.push(`${row.name}：${showError(failure)}`); }
    }
    setChosen([]);
    Modal.info({ title: active ? '批量启用' : '批量禁用', content: failed.length ? <div>{`成功 ${targets.length - failed.length} 条，失败 ${failed.length} 条`}{failed.map((item) => <div key={item}>{item}</div>)}</div> : `已处理 ${targets.length} 条工序。` });
  }
  async function downloadQr(row: Process) {
    const url = await QRCode.toDataURL(row.code, { width: 440, margin: 2 });
    const link = document.createElement('a');
    link.href = url; link.download = `${row.name}-${row.code}.png`; link.click();
  }
  return <>
    <ListFrame pageKey="processes" {...extList.props} columns={columns} rows={rows} loading={remote.loading} error={remote.error || command.error}
      viewTabs={[{ key: 'all', label: '全部' }, { key: 'on', label: '启用' }, { key: 'off', label: '禁用' }]} activeView={activeTab} onView={setActiveTab}
      chips={[{ key: 'status', label: '状态', options: [{ value: 'all', label: '全部' }, { value: 'on', label: '启用' }, { value: 'off', label: '禁用' }] }]} chipValue={{ status: activeTab }} onChip={(_, value) => setActiveTab(value)}
      queryFields={[{ key: 'name', label: '工序名' }, { key: 'code', label: '工序编号' }, { key: 'workshop', label: '车间', missing: true }, { key: 'line', label: '产线', missing: true }]}
      queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      rowSelection={{ selected: chosen, onChange: setChosen }}
      toolbar={<><Button type="primary" onClick={() => setEditing(null)}>新增</Button>{canWriteProducts(session) && <Dropdown disabled={!chosen.length || command.busy} menu={{ items: [{ key: 'on', label: '批量启用' }, { key: 'off', label: '批量禁用' }], onClick: ({ key }) => void batch(key === 'on') }}><Button>批量操作</Button></Dropdown>}</>}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      limitNote={remote.data && remote.data.total > remote.data.items.length ? `当前仅加载最近 ${remote.data.limit} 条` : undefined}
      showMobileCard mobileTabs={[{ key: 'list', label: '列表卡片' }]} mobileFields={{ list: columns.filter((column) => column.key !== 'actions').map((column) => ({ key: column.key, label: column.title, missing: column.missing })) }} />
    {extList.dialog}
    {editing !== undefined && <ProcessEditor row={editing ?? undefined} members={members.data?.items ?? []} auto={numbering.data?.items.some((item) => item.entity === 'process' && item.active) ?? false} ruleId={numbering.data?.items.find((item) => item.entity === 'process' && item.active)?.id} onClose={() => setEditing(undefined)} />}
    {qr && <Modal title="查看二维码" open onCancel={() => setQr(null)} footer={<><Button onClick={() => setQr(null)}>关闭</Button><Button type="primary" onClick={() => void downloadQr(qr)}>下载二维码</Button></>}>
      <div style={{ textAlign: 'center' }}><QrImage text={qr.code} /><div>{qr.name}</div><div className="kgd-muted">{qr.code}</div></div>
    </Modal>}
  </>;
}

function ProcessEditor({ row, members, auto, ruleId, onClose }: { row?: Process; members: Member[]; auto: boolean; ruleId?: string; onClose: () => void }) {
  const command = useCommand();
  const { session, revision, onExpired } = useKgd();
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [note, setNote] = useState(row?.description ?? '');
  const initial = partsOfMinutes(row?.standard_minutes ?? '0');
  const [hours, setHours] = useState(initial.h);
  const [minutes, setMinutes] = useState(initial.m);
  const [seconds, setSeconds] = useState(initial.s);
  const [reporters, setReporters] = useState<string[]>(row?.reporter_ids.map(idText) ?? []);
  const [pricingMode, setPricingMode] = useState(row?.pricing_mode === 'time' ? 'time' : 'piece');
  const [wageRate, setWageRate] = useState(row?.wage_rate ?? '');
  const [scheme, setScheme] = useState(row?.inspection_scheme ?? 'none');
  const [extras, setExtras] = useState<ProcessExtras>(emptyExtras);
  const [components, setComponents] = useState<{ report: string; qc: string }>({ report: '', qc: '' });
  const extForm = useExtForm('craft', row ? idText(row.id) : undefined);
  const units = useRemote<{ items: { id: string; name: string; active?: boolean }[] }>('/api/units', revision, onExpired);
  const componentList = useRemote<{ items: { id: string; title: string }[] }>('/api/process-components?page=1&page_size=200', revision, onExpired);
  useEffect(() => {
    if (!row) return;
    let alive = true;
    apiRequest<{ extras: ProcessExtras & { report_component_id?: string | null; qc_component_id?: string | null } }>(`/api/processes/${idText(row.id)}/extras`).then((body) => {
      if (!alive) return;
      const { report_component_id, qc_component_id, ...rest } = body.extras;
      setExtras({ ...emptyExtras, ...rest, unit_ratio: rest.unit_ratio ?? '' });
      setComponents({ report: report_component_id ?? '', qc: qc_component_id ?? '' });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [row]);
  const files = useRemote<{ items: { id: string }[] }>(row ? `/api/attachments?resource_type=process&resource_id=${encodeURIComponent(idText(row.id))}` : null, revision, onExpired);
  const fileInput = useRef<HTMLInputElement>(null);
  async function save() {
    command.clearFieldErrors();
    if (!name.trim()) { command.setFieldError('name', '请填写工序名'); return; }
    const extErr = extForm.error();
    if (extErr) { command.setError(extErr); return; }
    const standardMinutes = minutesFromParts(hours, minutes, seconds);
    const pricing = { pricing_mode: pricingMode, wage_rate: wageRate.trim() ? wageRate.trim() : null, inspection_scheme: scheme };
    try {
      let nextCode = code.trim();
      if (!row && !nextCode && auto && ruleId) {
        const allocated = await command.send<{ allocation: { number: string } }>(`/api/configuration/number-rules/${ruleId}/allocate`, { request_key: requestKey() });
        nextCode = allocated?.allocation.number ?? '';
      }
      if (!row && !nextCode) nextCode = `GX${Date.now().toString(36)}`;
      let processId = row ? idText(row.id) : '';
      if (row) await command.send(`/api/processes/${processId}`, { ...processFields(name, note, standardMinutes, reporters, pricing), version: row.version, active: row.active }, 'PATCH');
      else {
        const created = await command.send<{ process: Process }>('/api/processes', { ...processFields(name, note, standardMinutes, reporters, pricing), code: nextCode });
        processId = created?.process ? idText(created.process.id) : '';
      }
      if (processId) {
        await command.send(`/api/processes/${processId}/extras`, { shop_id: extras.shop_id || null, line_id: extras.line_id || null, report_unit_id: extras.report_unit_id || null, unit_ratio: extras.unit_ratio.trim() || null, need_outsource: extras.need_outsource, task_timing: extras.task_timing }, 'PUT');
        await command.send(`/api/process-components/bind/${processId}`, { report_component_id: components.report || null, qc_component_id: components.qc || null }, 'PUT');
        await extForm.persist(session.csrf_token, processId);
      }
      onClose();
    } catch (failure) { command.setError(showError(failure)); }
  }
  async function upload(file: File) {
    if (!row) return;
    const message = attachmentSizeMessage(file.size);
    const mime = attachmentMime(file);
    if (message || !mime) { command.setError(message || '附件仅支持 pdf、png、jpeg、txt'); return; }
    const content = await file.arrayBuffer();
    const bytes = new Uint8Array(content);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    await command.send('/api/attachments', attachmentUploadPayload({ resource_type: 'process', resource_id: idText(row.id), filename: file.name, mime, content_base64: btoa(binary), request_key: requestKey() }));
  }
  return <Modal title={row ? '修改工序' : '新增工序'} open width={760} onCancel={onClose} onOk={() => void save()} confirmLoading={command.busy} okText="确定" cancelText="取消">
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <div className="kgd-form">
      <span className={command.fieldErrors.name ? 'kgd-field-error-label' : undefined}>工序名<em className="kgd-req"> *</em></span><div className={command.fieldErrors.name ? 'kgd-field-error' : undefined}><Input value={name} onChange={(event) => setName(event.target.value)} />{command.fieldErrors.name ? <div className="kgd-field-help">{command.fieldErrors.name}</div> : null}</div>
      <span>工序编号</span><Input value={code} disabled={!!row} placeholder={auto ? '请填写，忽略将自动生成' : '请填写编号'} onChange={(event) => setCode(event.target.value)} />
      <span>车间</span><DictPick path="/api/machines/shops" value={extras.shop_id} placeholder="请选择车间" onChange={(value) => setExtras((current) => ({ ...current, shop_id: value ?? '' }))} />
      <span>产线</span><DictPick path="/api/machines/lines" value={extras.line_id} placeholder="请选择产线" onChange={(value) => setExtras((current) => ({ ...current, line_id: value ?? '' }))} />
      <span>报工单位</span><Select allowClear value={extras.report_unit_id || undefined} placeholder="请选择报工单位" onChange={(value) => setExtras((current) => ({ ...current, report_unit_id: value ?? '' }))} options={(units.data?.items ?? []).map((item) => ({ value: String(item.id), label: item.name }))} />
      <span>单位关系</span><Input value={extras.unit_ratio} placeholder="1 报工单位 = ? 商品单位" onChange={(event) => setExtras((current) => ({ ...current, unit_ratio: event.target.value }))} />
      <span>计价方式 *</span><Select value={pricingMode} onChange={setPricingMode} options={[{ value: 'piece', label: '计件' }, { value: 'time', label: '计时' }]} />
      <span>工资单价</span><Input value={wageRate} onChange={(event) => setWageRate(event.target.value)} />
      <span>标准工时</span><span><Input style={{ width: 72 }} value={hours} onChange={(event) => setHours(event.target.value)} /> 小时 <Input style={{ width: 72 }} value={minutes} onChange={(event) => setMinutes(event.target.value)} /> 分钟 <Input style={{ width: 72 }} value={seconds} onChange={(event) => setSeconds(event.target.value)} /> 秒</span>
      <span>附件</span><span>{row
        ? <div>
          <div role="button" tabIndex={0} onClick={() => !hasPermission(session, 'attachments.write') ? undefined : fileInput.current?.click()} onPaste={(event) => { const file = event.clipboardData.files[0]; if (file) void upload(file); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void upload(file); }} style={{ border: '1px dashed #d9d9d9', padding: 12, textAlign: 'center', cursor: hasPermission(session, 'attachments.write') ? 'pointer' : 'not-allowed', color: '#666' }}>选择文件 Ctrl+v 粘贴或拖拽文件到此处</div>
          <input ref={fileInput} type="file" hidden disabled={!hasPermission(session, 'attachments.write')} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
          <span>已有 {files.data?.items.length ?? 0}</span>
        </div>
        : '保存后再上传'}</span>
      <span>备注</span><Input value={note} onChange={(event) => setNote(event.target.value)} />
      {extForm.node}
    </div>
    <Tabs items={[
      { key: 'prod', label: '生产信息', children: <div className="kgd-form">
        <span>生产人员</span><Select mode="multiple" style={{ width: '100%' }} value={reporters} onChange={setReporters} options={members.map((item) => ({ value: String(item.id), label: item.display_name }))} placeholder="生产人员" />
        <span>报工附加组件</span><Select allowClear value={components.report || undefined} placeholder="请选择" onChange={(value) => setComponents((current) => ({ ...current, report: value ?? '' }))} options={(componentList.data?.items ?? []).map((item) => ({ value: String(item.id), label: item.title }))} />
      </div> },
      { key: 'qc', label: '质检信息', children: <div className="kgd-form">
        <span>检验方案</span><Select value={scheme} onChange={setScheme} options={[{ value: 'full', label: '全检' }, { value: 'sample', label: '抽检' }, { value: 'none', label: '不需质检' }]} />
        <span>质检附加组件</span><Select allowClear value={components.qc || undefined} placeholder="请选择" onChange={(value) => setComponents((current) => ({ ...current, qc: value ?? '' }))} options={(componentList.data?.items ?? []).map((item) => ({ value: String(item.id), label: item.title }))} />
      </div> },
      { key: 'out', label: '外协信息', children: <div className="kgd-form"><span>需外协</span><Switch checked={extras.need_outsource} onChange={(checked) => setExtras((current) => ({ ...current, need_outsource: checked }))} /></div> },
      { key: 'clock', label: '工序打卡设置', children: <div className="kgd-form"><span>生产任务计时</span><Switch checked={extras.task_timing} onChange={(checked) => setExtras((current) => ({ ...current, task_timing: checked }))} /></div> },
    ]} />
  </Modal>;
}

type ProcessExtras = { shop_id: string; line_id: string; report_unit_id: string; unit_ratio: string; need_outsource: boolean; task_timing: boolean };
const emptyExtras: ProcessExtras = { shop_id: '', line_id: '', report_unit_id: '', unit_ratio: '', need_outsource: false, task_timing: false };

export function RouteList() {
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const remote = useRemote<{ items: Route[]; total: number; limit: number }>('/api/routes', revision, onExpired);
  const list = useQueryState();
  const [tab, setTab] = useState('all');
  const [flows, setFlows] = useState<Record<string, string>>({});
  const rows = (remote.data?.items ?? []).filter((row) => (tab === 'on' ? row.active : tab === 'off' ? !row.active : true) && (!(list.query.code ?? '') || row.code.includes(list.query.code ?? '')) && (!(list.query.name ?? '') || row.name.includes(list.query.name ?? '')));
  async function loadFlow(row: Route) {
    const key = idText(row.id);
    if (flows[key]) return;
    try {
      if (!row.current_version_id) {
        setFlows((current) => ({ ...current, [key]: '（无工序）' }));
        return;
      }
      const detail = await apiRequest<{ steps?: { process_name: string }[] }>(`/api/route-versions/${row.current_version_id}`);
      const names = (detail.steps ?? []).map((step) => step.process_name).filter(Boolean);
      setFlows((current) => ({ ...current, [key]: names.length ? names.join('→') : '（无工序）' }));
    } catch (failure) {
      message.error(showError(failure));
    }
  }
  const columns: ListColumn<Route>[] = [
    { key: 'code', title: '编号', render: (row) => row.code }, { key: 'name', title: '名称', render: (row) => row.name },
    { key: 'count', title: '工序个数', render: (row) => String(row.steps_count) },
    { key: 'flow', title: '工序列表', render: (row) => flows[idText(row.id)] || <button className="kgd-link" onClick={() => void loadFlow(row)}>展开</button> },
    { key: 'status', title: '状态', render: (row) => <StatusTag text={row.active ? '启用' : '禁用'} /> },
    { key: 'actions', title: '操作', render: (row) => <Button type="link" onClick={() => navigate(`/craft_route/edit/${idText(row.id)}`)}>修改</Button> },
  ];
  return <ListFrame pageKey="routes" columns={columns} rows={rows} loading={remote.loading} error={remote.error}
    viewTabs={[{ key: 'all', label: '全部' }, { key: 'on', label: '启用' }, { key: 'off', label: '禁用' }]} activeView={tab} onView={setTab}
    queryFields={[{ key: 'code', label: '编号' }, { key: 'name', label: '名称' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
    toolbar={<><Button type="primary" onClick={() => navigate('/process_routing/add')}>新增</Button></>}
    page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage} showExtension={false}
    limitNote={remote.data && remote.data.total > remote.data.items.length ? `当前仅加载最近 ${remote.data.limit} 条` : undefined} />;
}

type StepDraft = { key: string; process_id: string; process_code: string; process_name: string; standard_minutes: string; reporters: string; auto_inbound: boolean };

export function RouteEditorPage() {
  const params = useParams();
  const { pathname } = useLocation();
  const craftPrefix = '/craft_route/edit/';
  const processPrefix = '/process_routing/edit/';
  const pathId = pathname.startsWith(craftPrefix)
    ? decodeURIComponent(pathname.slice(craftPrefix.length).split(/[/?#]/)[0] ?? '')
    : pathname.startsWith(processPrefix)
      ? decodeURIComponent(pathname.slice(processPrefix.length).split(/[/?#]/)[0] ?? '')
      : '';
  const id = params.id || pathId || undefined;
  const navigate = useNavigate();
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const processes = useRemote<{ items: Process[] }>('/api/processes', revision, onExpired);
  const routes = useRemote<{ items: Route[] }>('/api/routes', revision, onExpired);
  const boms = useRemote<{ items: { id: string; parent_name: string; current_version_id: string; active: boolean }[] }>('/api/boms', revision, onExpired);
  const detail = useRemote<{ route: Route; versions: { id: string }[] }>(id ? `/api/routes/${id}` : null, revision, onExpired);
  const version = useRemote<{ version: { revision: number }; steps: RouteStep[] }>(detail.data?.route.current_version_id ? `/api/route-versions/${detail.data.route.current_version_id}` : null, revision, onExpired);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [ready, setReady] = useState(!id);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    if (!id || !detail.data || !version.data || ready) return;
    setCode(detail.data.route.code); setName(detail.data.route.name);
    setSteps(version.data.steps.map((step) => ({ key: requestKey(), process_id: step.process_id, process_code: step.process_code, process_name: step.process_name, standard_minutes: step.standard_minutes, reporters: step.reporter_ids.join(','), auto_inbound: step.auto_inbound })));
    setReady(true);
  }, [detail.data, id, ready, version.data]);
  function addProcesses(ids: string[]) {
    const next = ids.map((processId) => processes.data?.items.find((item) => idText(item.id) === processId)).filter((item): item is Process => !!item).map((item) => ({ key: requestKey(), process_id: idText(item.id), process_code: item.code, process_name: item.name, standard_minutes: item.standard_minutes, reporters: item.reporter_ids.map(idText).join(','), auto_inbound: false }));
    setSteps((current) => [...current, ...next]);
  }
  async function copyRoute(routeId: string) {
    const route = routes.data?.items.find((item) => idText(item.id) === routeId);
    if (!route) return;
    const body = await apiRequest<{ steps: RouteStep[] }>(`/api/route-versions/${route.current_version_id}`);
    setSteps(body.steps.map((step) => ({ key: requestKey(), process_id: step.process_id, process_code: step.process_code, process_name: step.process_name, standard_minutes: step.standard_minutes, reporters: (step.reporter_ids ?? []).join(','), auto_inbound: step.auto_inbound })));
  }
  async function copyProductRoute(bomId: string) {
    const bom = boms.data?.items.find((item) => item.id === bomId);
    if (!bom) return;
    try {
      const version = await apiRequest<{ version: { route_version_id: string | null } }>(`/api/bom-versions/${bom.current_version_id}`);
      if (!version.version.route_version_id) { command.setError(`「${bom.parent_name}」未设置商品工序`); return; }
      const body = await apiRequest<{ steps: RouteStep[] }>(`/api/route-versions/${version.version.route_version_id}`);
      setSteps((current) => [...current, ...body.steps.map((step) => ({ key: requestKey(), process_id: step.process_id, process_code: step.process_code, process_name: step.process_name, standard_minutes: step.standard_minutes, reporters: (step.reporter_ids ?? []).join(','), auto_inbound: step.auto_inbound }))]);
    } catch (failure) { command.setError(showError(failure)); }
  }
  async function save() {
    command.clearFieldErrors();
    if (!name.trim()) { command.setFieldError('name', '请填写名称'); return; }
    const nextCode = code.trim() || `R${Date.now().toString(36)}`;
    try {
      const payload = routeSavePayload({ existing: !!id, code: nextCode, name, description: '', steps: steps.map((step) => ({ process_id: step.process_id, auto_inbound: step.auto_inbound })), expected_version: detail.data?.route.version });
      await command.send(id ? `/api/routes/${id}/versions` : '/api/routes', { ...payload, request_key: requestKey() });
      navigate('/process_routing/list');
    } catch (failure) { command.setError(showError(failure)); }
  }
  return <div className="kgd-card">
    <div className="kgd-actions"><Button onClick={() => navigate('/process_routing/list')}>返回</Button><Button type="primary" loading={command.busy} onClick={() => void save()}>{id ? '发布新版本' : '确定'}</Button><Button type="primary" loading={command.busy} onClick={() => void save()}>{id ? '发布新版本' : '保存'}</Button></div>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <div className="kgd-form"><span className={command.fieldErrors.code ? 'kgd-field-error-label' : undefined}>编号<em className="kgd-req"> *</em></span><div className={command.fieldErrors.code ? 'kgd-field-error' : undefined}><Input value={code} disabled={!!id} onChange={(event) => setCode(event.target.value)} />{command.fieldErrors.code ? <div className="kgd-field-help">{command.fieldErrors.code}</div> : null}</div><span className={command.fieldErrors.name ? 'kgd-field-error-label' : undefined}>名称<em className="kgd-req"> *</em></span><div className={command.fieldErrors.name ? 'kgd-field-error' : undefined}><Input value={name} onChange={(event) => setName(event.target.value)} />{command.fieldErrors.name ? <div className="kgd-field-help">{command.fieldErrors.name}</div> : null}</div></div>{command.fieldErrors.steps ? <div className="kgd-banner">{command.fieldErrors.steps}</div> : null}
    <div className="kgd-toolbar">
      <Select mode="multiple" style={{ minWidth: 220 }} placeholder="选择工序" onChange={(values) => { addProcesses(values); }} value={[]} options={(processes.data?.items ?? []).filter((item) => item.active).map((item) => ({ value: idText(item.id), label: `${item.code} ${item.name}` }))} />
      <Select style={{ minWidth: 180 }} placeholder="选择工艺路线" onChange={(value) => void copyRoute(value)} options={(routes.data?.items ?? []).map((item) => ({ value: idText(item.id), label: item.name }))} />
      <Select showSearch optionFilterProp="label" style={{ minWidth: 180 }} placeholder="选择商品工序" value={null} onChange={(value) => { if (value) void copyProductRoute(value); }} options={(boms.data?.items ?? []).filter((item) => item.active).map((item) => ({ value: item.id, label: item.parent_name }))} />
      <Button onClick={() => setSteps([])}>清空</Button>
    </div>
    <Table size="small" pagination={false} rowKey="key" dataSource={steps} columns={[
      { title: '序号', render: (_, __, index) => <span draggable onDragStart={() => setDrag(index ?? 0)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (drag === null || index === undefined) return; setSteps((current) => { const next = [...current]; const [item] = next.splice(drag, 1); next.splice(index, 0, item!); return next; }); setDrag(null); }}>{(index ?? 0) + 1}</span> },
      { title: '工序', dataIndex: 'process_name' }, { title: '工序编号', dataIndex: 'process_code' }, { title: '标准工时', dataIndex: 'standard_minutes' }, { title: '生产人员', dataIndex: 'reporters' },
      { title: '自动入库', render: (_, row) => <Switch checked={row.auto_inbound} onChange={(checked) => setSteps((current) => current.map((item) => item.key === row.key ? { ...item, auto_inbound: checked } : item))} /> },
      { title: '操作', render: (_, row) => <Button type="link" onClick={() => setSteps((current) => current.filter((item) => item.key !== row.key))}>删除</Button> },
    ]} />
  </div>;
}
