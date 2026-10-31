import { useState } from 'react';
import type { FormEvent } from 'react';
import { canWriteProducts } from './api';
import { Loading, Notice } from './shared';
import type { Bom, BomVersion, MasterProps, Process, Route, RouteVersion } from './masterTypes';
import { idText } from './masterTypes';
import { EditorShell, useMutation, useRemote } from './masterTools';
import { BomEditor } from './BomForm';
import { routeSavePayload } from './domain/payloads';
import { requestKey } from './requestKey';
export type VersionFormProps = MasterProps & { kind: 'routes' | 'boms'; record?: Route | Bom; source?: RouteVersion | BomVersion; onClose: () => void; onSaved: () => void };
export function VersionForm(props: VersionFormProps) { return props.kind === 'routes' ? <RouteEditor {...props} /> : <BomEditor {...props} />; }

function RouteEditor({ record, source, session, revision, onExpired, onClose, onSaved }: VersionFormProps) {
  const route = record as Route | undefined;
  const original = source as RouteVersion | undefined;
  const processes = useRemote<{ items: Process[]; total: number; limit: number }>('/api/processes', revision, onExpired);
  const [code, setCode] = useState(route?.code ?? '');
  const [name, setName] = useState(route?.name ?? '');
  const [description, setDescription] = useState(original?.version.description ?? '');
  const [steps, setSteps] = useState(original?.steps.map((step) => ({ key: requestKey(), process_id: step.process_id, process_name: step.process_name, auto_inbound: step.auto_inbound })) ?? [{ key: requestKey(), process_id: '', process_name: '', auto_inbound: false }]);
  const mutation = useMutation(session, !!route, onExpired, onSaved);
  const writable = canWriteProducts(session);
  const disabled = !writable || mutation.saving;
  function move(index: number, direction: number) {
    setSteps((current) => { const result = [...current]; const next = index + direction; if (next < 0 || next >= result.length) return current; [result[index], result[next]] = [result[next], result[index]]; return result; });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!writable) return;
    if (!name.trim() || (!route && !code.trim()) || !steps.length || steps.some((step) => !step.process_id)) { mutation.setError('请填写编号、名称，并为每一步选择工序。'); return; }
    void mutation.save(route ? `/api/routes/${encodeURIComponent(idText(route.id))}/versions` : '/api/routes', routeSavePayload({ existing: !!route, code, name, description, steps, expected_version: route?.version }));
  }
  return <EditorShell title={route ? '工艺路线 · 新修订' : '新增工艺路线'} tenant={session.tenant.name} wide onClose={onClose} saving={mutation.saving} error={mutation.error} conflict={mutation.conflict} onSubmit={writable ? submit : undefined} submitLabel={route ? '保存为新版本' : '创建路线'} submitDisabled={processes.loading || !!processes.error}>
    <Notice kind="info">历史版本不会被覆盖。工序顺序、人员名单、标准时长等在提交时冻结；自动入库这里只保存配置。</Notice>
    {processes.error && <Notice>{processes.error}</Notice>}{processes.data && processes.data.total > processes.data.items.length && <Notice kind="info">可选工序本次{processes.data.items.length}条 / 总{processes.data.total}条，上限{processes.data.limit}；完整目录分页将在后续补齐。</Notice>}<div className="form-grid"><label className="form-field"><span>路线编号 *</span><input required value={code} onChange={(event) => setCode(event.target.value)} disabled={disabled || !!route} /></label><label className="form-field"><span>路线名称 *</span><input required value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} /></label><label className="form-field form-field-wide"><span>版本说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={disabled} rows={2} /></label></div>
    <section className="subsection"><div className="subsection-heading"><h3>工序顺序</h3><button className="button button-secondary" type="button" disabled={disabled} onClick={() => setSteps((current) => [...current, { key: requestKey(), process_id: '', process_name: '', auto_inbound: false }])}>＋ 添加工序</button></div>{processes.loading ? <Loading /> : steps.map((step, index) => <div className="route-step-editor" key={step.key}><span className="step-number">{index + 1}</span><label className="form-field"><span className="sr-only">第{index + 1}步工序</span><select required value={step.process_id} disabled={disabled} onChange={(event) => { const value = event.target.value; setSteps((current) => current.map((item) => item.key === step.key ? { ...item, process_id: value, process_name: processes.data?.items.find((process) => idText(process.id) === value)?.name ?? '' } : item)); }}><option value="">请选择工序</option>{step.process_id && !processes.data?.items.some((process) => idText(process.id) === step.process_id && process.active) && <option value={step.process_id}>{step.process_name}（原版本工序）</option>}{processes.data?.items.filter((process) => process.active).map((process) => <option value={idText(process.id)} key={process.id}>{process.code} · {process.name}</option>)}</select></label><label className="checkbox-field"><input type="checkbox" checked={step.auto_inbound} disabled={disabled} onChange={(event) => setSteps((current) => current.map((item) => item.key === step.key ? { ...item, auto_inbound: event.target.checked } : item))} />自动入库配置</label><div className="step-actions"><button type="button" className="button button-quiet" disabled={disabled || index === 0} onClick={() => move(index, -1)}>上移</button><button type="button" className="button button-quiet" disabled={disabled || index === steps.length - 1} onClick={() => move(index, 1)}>下移</button><button type="button" className="text-button danger-text" disabled={disabled} onClick={() => setSteps((current) => current.filter((item) => item.key !== step.key))}>移除</button></div></div>)}</section>
    {route && <p className="muted small">基于R{original?.version.revision}；档案并发版本 v{route.version}。保存后产生新的修订。</p>}
  </EditorShell>;
}
