import { useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, errorMessage } from './api';
import type { MasterProps, Process, Route, RouteVersion, TeamMember } from './masterTypes';
import { useRemote } from './masterTools';
import { Loading, Notice } from './shared';
import { exactQuantity, quantityText, requirePreview } from './previewMath';
import type { PreviewResult } from './previewMath';
import { PreviewResultCard } from './BusinessDocuments';

type List<T> = { items: T[]; total?: number; limit?: number };
export function MobileReportPrototype({ session, revision, onExpired }: MasterProps) {
  const routes = useRemote<List<Route>>('/api/routes', revision, onExpired);
  const processes = useRemote<List<Process>>('/api/processes', revision, onExpired);
  const members = useRemote<List<TeamMember>>('/api/team-members', revision, onExpired);
  const [workId, setWorkId] = useState('');
  const [routeId, setRouteId] = useState('');
  const [sequence, setSequence] = useState('');
  const [reporterId, setReporterId] = useState('');
  const [good, setGood] = useState('50');
  const [bad, setBad] = useState('0');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [defect, setDefect] = useState('');
  const [note, setNote] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [imageName, setImageName] = useState('');
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const activeRoutes = routes.data?.items.filter(route => route.active) ?? [];
  const route = activeRoutes.find(item => String(item.id) === routeId);
  const version = useRemote<RouteVersion>(workId && route?.current_version_id ? `/api/route-versions/${route.current_version_id}` : null, revision, onExpired);
  const step = version.data?.steps.find(item => String(item.sequence) === sequence);
  const process = processes.data?.items.find(item => String(item.id) === step?.process_id && item.active);
  const reporters = members.data?.items.filter(item => process?.reporter_ids.includes(String(item.id))) ?? [];
  const errors = [routes.error, processes.error, members.error, version.error].filter(Boolean);
  useEffect(() => {
    if (workId && !routeId && activeRoutes.length) setRouteId(String((activeRoutes.find(item => item.code === 'S2-ROUTE') ?? activeRoutes[0]).id));
  }, [workId, routeId, routes.data]);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);
  const duration = start && end ? Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 60_000) : null;
  function clearResult() { setResult(null); setError(''); }
  function chooseWork(value: string) { setWorkId(value); setRouteId(''); setSequence(''); setReporterId(''); clearResult(); }
  function nextDraft() {
    setReporterId(''); setGood(''); setBad('0'); setStart(''); setEnd(''); setDefect(''); setNote(''); setImageUrl(''); setImageName('');
    if (photoInput.current) photoInput.current.value = '';
    clearResult();
  }
  function photo(file?: File) {
    clearResult();
    if (!file) { setImageUrl(''); setImageName(''); return; }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('本机图片预览仅支持5MB以内的PNG、JPEG、WebP或GIF。');
      if (photoInput.current) photoInput.current.value = '';
      return;
    }
    setImageUrl(URL.createObjectURL(file)); setImageName(file.name);
  }
  async function inspect(action = 'submit') {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      if (!workId || !version.data || !step) throw new Error('请按顺序选择模拟工单、真实路线与工序。');
      if (!process || !reporters.some(item => String(item.id) === reporterId)) throw new Error('请从该工序当前的本企业启用报工名单中选择人员。');
      const goodAmount = exactQuantity(good, '良品数量'), badAmount = exactQuantity(bad, '不良数量');
      if ((start && !end) || (!start && end)) throw new Error('起止时间须成对填写，或同时留空。');
      if (start && end && (duration === null || !Number.isFinite(duration) || duration <= 0)) throw new Error('结束时间须晚于开始时间，示例按整分钟显示。');
      const state = action === 'approve' ? result?.next_state ?? 'draft' : 'draft';
      const response = requirePreview(await apiRequest<PreviewResult>('/api/design-preview/transition', { method: 'POST', csrfToken: session.csrf_token, body: { domain: 'report', state, action, facts: { good_qty: quantityText(goodAmount), bad_qty: quantityText(badAmount), has_reverse_dependencies: false } } }));
      setResult(response);
    } catch (failure) {
      setResult(null);
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(errorMessage(failure));
    } finally { busyRef.current = false; setBusy(false); }
  }
  const ready = !!workId && !!version.data && !!step && !!process && reporters.some(item => String(item.id) === reporterId);
  return <>
    <div className="page-heading"><div><div className="eyebrow">第二步 / 手机交互设计</div><h1>手机报工原型</h1><p>工单→工序→人员联动选择，使用本企业真实主数据做数量与动作预检。</p></div><span className="badge badge-amber">模拟 · 不落账</span></div>
    <Notice kind="info">本页仍是预检原型，不保存报工。真实报工请使用“手机报工”。这里未连接微信身份、相机扫码或离线队列。照片只在本机预览；刷新或退出本页清空草稿。</Notice>
    {errors.map((message, index) => <Notice key={index}>{message}</Notice>)}
    {routes.loading || processes.loading || members.loading ? <Loading label="正在读取本企业路线、工序和人员…" /> : <div className="preview-layout preview-mobile">
      <section className="panel phone-prototype"><div className="phone-preview-bar"><span>工人报工</span><span className="badge badge-amber">本次模拟</span></div><button className="button button-secondary mock-scan" disabled={busy} onClick={() => chooseWork('S2-WO-MOBILE')}>模拟码进入 S2-WO-MOBILE</button>
        <div className="form-grid"><label className="form-field"><span>1. 模拟工单</span><select value={workId} disabled={busy} onChange={e => chooseWork(e.target.value)}><option value="">先选择模拟工单</option><option value="S2-WO-MOBILE">S2-WO-MOBILE · 合成计划50</option></select></label>
          <label className="form-field"><span>本企业启用路线</span><select value={routeId} disabled={busy || !workId} onChange={e => { setRouteId(e.target.value); setSequence(''); setReporterId(''); clearResult(); }}><option value="">选择真实路线</option>{activeRoutes.map(item => <option key={item.id} value={String(item.id)}>{item.code} · {item.name}</option>)}</select><small>{route ? `当前真实版本v${route.current_revision}，用于本次模拟选择` : '先选择工单后才能选择路线'}</small></label>
          <label className="form-field"><span>2. 冻结路线工序</span><select value={sequence} disabled={busy || !workId || !version.data || version.loading} onChange={e => { setSequence(e.target.value); setReporterId(''); clearResult(); }}><option value="">{version.loading ? '正在读取工序…' : '选择工序'}</option>{version.data?.steps.map(item => <option key={item.sequence} value={String(item.sequence)}>{item.sequence}. {item.process_code} · {item.process_name}</option>)}</select></label>
          <label className="form-field"><span>3. 报工人员</span><select value={reporterId} disabled={busy || !step || !reporters.length} onChange={e => { setReporterId(e.target.value); clearResult(); }}><option value="">选择工序当前报工名单</option>{reporters.map(item => <option key={item.id} value={String(item.id)}>{item.display_name}</option>)}</select><small>只列当前工序授权名单中仍在本企业启用的人员。</small></label>
          {step && !process && <Notice>所选工序当前已停用或不在已读取范围，不能继续本次选择。</Notice>}{step && process && reporters.length === 0 && <Notice>所选工序没有可选的本企业启用报工人员。</Notice>}
          <div className="phone-quantity-grid"><label className="form-field"><span>良品数量</span><input inputMode="decimal" value={good} disabled={busy || !ready} onChange={e => { setGood(e.target.value); clearResult(); }} /></label><label className="form-field"><span>不良数量</span><input inputMode="decimal" value={bad} disabled={busy || !ready} onChange={e => { setBad(e.target.value); clearResult(); }} /></label></div>
          <label className="form-field"><span>不良项说明（合成文本）</span><input value={defect} disabled={busy || !ready} maxLength={300} placeholder="例如：焊接缺陷；尚未接不良项目录" onChange={e => { setDefect(e.target.value); clearResult(); }} /></label>
          <label className="form-field"><span>开始时间（可选）</span><input type="datetime-local" value={start} disabled={busy || !ready} onChange={e => { setStart(e.target.value); clearResult(); }} /></label><label className="form-field"><span>结束时间（可选）</span><input type="datetime-local" value={end} disabled={busy || !ready} onChange={e => { setEnd(e.target.value); clearResult(); }} /><small>{duration !== null && duration > 0 ? `本机显示时长：${duration}分钟；未计薪` : '填写起止时间后显示本机时长'}</small></label>
          <label className="form-field"><span>备注</span><textarea rows={2} value={note} disabled={busy || !ready} maxLength={1000} onChange={e => { setNote(e.target.value); clearResult(); }} /></label><label className="form-field"><span>照片（本机预览）</span><input type="file" ref={photoInput} accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || !ready} onChange={e => photo(e.target.files?.[0])} /><small>支持5MB以内图片；不会上传。</small></label>{imageUrl && <figure className="local-photo"><img src={imageUrl} alt="本次草稿的本机照片预览" /><figcaption>{imageName}</figcaption></figure>}
        </div>{error && <Notice>{error}</Notice>}<p className="muted small">良0/不良10允许数量预检；两者均0会被拒绝。普通/强制派工、代报、超量和真实工序鉴权仍待实现与验证。</p><button className="button button-primary preview-submit" disabled={busy || !ready} onClick={() => void inspect()}>{busy ? '正在预检…' : '提交报工预检（不保存）'}</button>{result && <><PreviewResultCard result={result} />{result.allowed && result.next_state === 'pending' && session.role !== 'worker' && <button className="button button-secondary preview-submit" disabled={busy} onClick={() => void inspect('approve')}>管理角色：审核预检</button>}<button className="button button-secondary preview-submit" disabled={busy} onClick={nextDraft}>继续报工（清空草稿）</button></>}
      </section><section className="panel"><div className="panel-heading"><h2>本次模拟对象</h2><span className="badge badge-gray">无真实报工记录</span></div><dl className="detail-list"><div><dt>工单</dt><dd>{workId || '未选择'}</dd></div><div><dt>真实路线版本</dt><dd>{route ? `${route.code} / v${route.current_revision}` : '未选择'}</dd></div><div><dt>工序</dt><dd>{step ? `${step.sequence}. ${step.process_name}` : '未选择'}</dd></div><div><dt>报工人员</dt><dd>{reporters.find(item => String(item.id) === reporterId)?.display_name ?? '未选择'}</dd></div><div><dt>预计工资</dt><dd>未计算（工价规则尚未接入）</dd></div><div><dt>照片</dt><dd>{imageName ? '只在本机预览' : '无'}</dd></div></dl><div className="subsection"><h3>当前验证边界</h3><p className="muted small">选择框使用真实启用路线、路线快照工序及当前本企业报工名单，但请求仅发送良/不良和模型动作。服务尚未依据真实工单、派工或工序判定权限，不能把选择框过滤视为生产鉴权已验收。</p><p className="muted small">预检失败保留本次草稿，可修改后再试；这不证明断网队列、幂等提交或弱网恢复已运行。模拟码按钮不访问相机或解析二维码。</p></div></section>
    </div>}
  </>;
}
