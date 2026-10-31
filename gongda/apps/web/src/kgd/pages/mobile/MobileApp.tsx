// 手机版：工人扫加工单二维码 → 登录 → 选工序报工；管理员看加工单、开工/暂停/完成、新建加工单。
// 权限和电脑版完全一致（同一套接口、同一个登录）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CommandKeys } from '../../../commandKeys';
import { documentActionPayload, reportCreatePayload } from '../../../domain/payloads';
import { apiRequest } from '../../../api';
import { requestKey } from '../../../requestKey';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { showError } from '../../kit';
import { modeWageText, nowShanghai, rateLabel, splitSpan, wageAmount, yuanLabel } from '../../wage';
import { setPrefersDesktop } from './device';
import './mobile.css';

type Options = {
  work_orders: { id: string; code: string; product_name: string; plan_qty: string; execution: string; due_date?: string | null }[];
  tasks: { id: string; work_order_id: string; process_name: string; execution: string; plan_qty: string; approved_good: string; remaining_qty: string; pricing_mode: string; wage_rate: string | null; reporters: { id: string; name: string }[] }[];
  defect_items: { id: string; name: string }[];
  machines: { id: string; code: string; name: string }[];
  self: { id: string; name: string };
  can_proxy: boolean;
};
type Today = { summary: { report_qty: string; good_qty: string; defect_qty: string }; items: { id: string; work_order_code: string; product_name: string; process_name: string; good_qty: string; defect_qty: string; created_at: string }[] };
type Cards = { items: { page_key: string; tab_key: string; fields: string[] }[] };
type Row = { id: string; code: string; plan_qty: string; output_qty?: string; execution: string; order_paused?: boolean; priority?: string; due_date?: string | null; product_snapshot: { name?: string; code?: string; specification?: string }; process_progress?: { done: number; total: number } | null; current_process?: string; overdue?: boolean; version?: number };
type ListPayload = { items: Row[]; total: number; counts: Record<string, number> };
type Task = { id: string; sequence: number; process_name: string; execution: string; plan_qty: string; approved_good: string; approved_defect: string; version: number; pause_reason?: string };
type Material = { id: string; product_code: string; product_name: string; unit_name: string; required_qty: string; issued_qty: string };
type Order = { id: string; code: string; plan_qty: string; execution: string; order_paused: boolean; version: number; product_snapshot: { code?: string; name?: string; specification?: string; unit_name?: string }; tasks: Task[]; materials: Material[]; output_qty: string; received_qty: string; priority?: string; due_date?: string | null; note?: string; close_reason?: string };
type Report = { id: string; code: string; task_id: string; good_qty: string; defect_qty: string; created_at: string; approval: string; operator_name?: string; process_name?: string };

const EXEC: Record<string, [string, string]> = {
  not_started: ['未开始', 'gray'], running: ['生产中', 'blue'], paused: ['已暂停', 'orange'], completed: ['已完成', 'green'], cancelled: ['已取消', 'gray'], closed: ['已关闭', 'gray'],
};
/** 数量去掉多余的 0：100.000000 → 100，1.500000 → 1.5 */
const fq = (v: string | number | null | undefined) => { if (v == null || v === '') return '-'; const n = Number(v); return Number.isFinite(n) ? String(+n.toFixed(6)) : String(v); };
const PRIORITY: Record<string, string> = { urgent: '加急', normal: '正常', delayed: '延期' };

function useAccess() {
  const { session } = useKgd();
  const p = session.permissions;
  return { read: p.includes('production.read'), write: p.includes('production.write'), report: p.includes('production.report') };
}

function useOptions(query: string, revision: number, enabled = true) {
  const { onExpired } = useKgd();
  return useRemote<Options>(enabled ? `/api/report-workbench/options${query}` : null, revision, onExpired);
}

function StatusTag({ execution, paused }: { execution: string; paused?: boolean }) {
  const [text, tone] = paused && execution === 'running' ? ['已暂停', 'orange'] : EXEC[execution] ?? [execution, 'gray'];
  return <span className={`m-tag ${tone}`}>{text}</span>;
}

function Bar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return <div className="m-bar"><i style={{ width: `${pct}%` }} /><span>{pct}%</span></div>;
}

function Head({ title, back }: { title: string; back?: boolean }) {
  const navigate = useNavigate();
  return <div className="m-head">
    {back && <button type="button" className="m-back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/m'))} aria-label="返回">‹</button>}
    <span>{title}</span>
  </div>;
}

const ICON: Record<string, string> = {
  report: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  orders: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h4',
  today: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
};
function TabIcon({ name }: { name: string }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[name]} /></svg>;
}

function Tabs() {
  const access = useAccess();
  const { pathname } = useLocation();
  const on = (prefix: string) => (pathname === prefix || pathname.startsWith(prefix + '/') ? 'on' : '');
  const reportOn = pathname.startsWith('/m/report') && !pathname.startsWith('/m/report/today') ? 'on' : '';
  return <nav className="m-tabs">
    {access.report && <Link className={reportOn} to="/m/report"><TabIcon name="report" />报工</Link>}
    {access.read && <Link className={on('/m/orders') || on('/m/order')} to="/m/orders"><TabIcon name="orders" />加工单</Link>}
    {access.report && <Link className={on('/m/report/today')} to="/m/report/today"><TabIcon name="today" />今日</Link>}
    <Link className={on('/m/me')} to="/m/me"><TabIcon name="me" />我的</Link>
  </nav>;
}

export function MobileApp() {
  const access = useAccess();
  const home = access.report ? '/m/report' : access.read ? '/m/orders' : '/m/me';
  const { pathname } = useLocation();
  // 换页时回到顶部（不然会停在上一页的滚动位置）
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return <div className="m-app">
    <Routes>
      <Route path="report" element={<Home />} />
      <Route path="report/order/:id" element={<PickTask />} />
      <Route path="report/task/:taskId" element={<ReportForm />} />
      <Route path="report/today" element={<TodayPage />} />
      <Route path="wo/:code" element={<ScanEntry />} />
      <Route path="progress/:code" element={<ScanEntry />} />
      <Route path="orders" element={<OrderList />} />
      <Route path="orders/new" element={<NewOrder />} />
      <Route path="order/:id" element={<OrderDetail />} />
      <Route path="me" element={<Me />} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  </div>;
}

// ── 扫码入口：/m/wo/加工单号 ──────────────────────────────────────────────
function ScanEntry() {
  const { code = '' } = useParams();
  const { revision, onExpired } = useKgd();
  const access = useAccess();
  const options = useOptions(`?q=${encodeURIComponent(code)}`, revision, access.report);
  const found = useRemote<ListPayload>(access.read ? `/api/progress/work-orders?code=${encodeURIComponent(code)}&page=1&page_size=5` : null, revision, onExpired);
  const exact = found.data?.items.find((row) => row.code === code);
  const reportable = options.data?.work_orders.find((row) => row.code === code);
  if (access.read && found.data) {
    if (exact) return <Navigate to={`/m/order/${exact.id}`} replace />;
  } else if (!access.read && options.data && reportable) {
    return <Navigate to={`/m/report/order/${reportable.id}`} replace />;
  }
  const loading = (access.read && found.loading) || (!access.read && access.report && options.loading);
  return <>
    <Head title={code || '扫码'} back />
    {loading ? <div className="m-empty">正在查找加工单 {code}…</div> : <div className="m-empty">
      <p className="m-big">没有找到你能处理的加工单 <b>{code}</b></p>
      <p>{access.report ? '可能是这张单还没开工、已经完工，或者里面没有分配给你的工序。请找班组长确认。' : '你的账号没有报工或查看加工单的权限，请找管理员开通。'}</p>
    </div>}
    <Tabs />
  </>;
}

// ── 报工（原有流程）────────────────────────────────────────────────────────
function Home() {
  const { revision, onExpired } = useKgd();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const options = useOptions(`?q=${encodeURIComponent(q)}`, revision);
  const cards = useRemote<Cards>('/api/mobile-cards?page_key=work-orders', revision, onExpired);
  const listFields = cards.data?.items.find((item) => item.tab_key === 'list')?.fields ?? ['code', 'product', 'plan', 'due'];
  const wo = params.get('wo');
  const task = params.get('task');
  const matched = options.data?.work_orders.find((item) => item.code === wo);
  if (wo && options.data && matched && task) return <Navigate to={`/m/report/task/${task}`} replace />;
  if (wo && options.data && matched) return <Navigate to={`/m/report/order/${matched.id}`} replace />;
  return <>
    <Head title="报工" />
    <div className="m-search"><input placeholder="搜加工单号 / 商品名" value={q} onChange={(event) => setQ(event.target.value)} /></div>
    <div className="m-tip">扫加工单上的二维码可以直接进到这张单</div>
    {wo && options.data && !matched && <div className="m-empty">该加工单暂无您可报工的工序</div>}
    {options.loading && !options.data && <div className="m-empty">正在加载…</div>}
    {!options.loading && !(options.data?.work_orders.length) && <div className="m-empty">暂无可报工的加工单</div>}
    {(options.data?.work_orders ?? []).map((item) => {
      const tasks = (options.data?.tasks ?? []).filter((row) => row.work_order_id === item.id);
      const done = tasks.filter((row) => row.execution === 'completed').length;
      return <Link key={item.id} to={`/m/report/order/${item.id}`} className="m-card-link">
        <article className="m-card">
          <h3>{item.code} <StatusTag execution={item.execution} /></h3>
          {listFields.includes('product') && <div className="m-sub">{item.product_name || '-'}</div>}
          <div className="m-row"><span>计划数 {fq(item.plan_qty)}</span><span>可报工序 {tasks.length - done}</span></div>
          {listFields.includes('due') && <div className="m-row"><span>交货日期 {item.due_date?.slice(0, 10) || '-'}</span></div>}
        </article>
      </Link>;
    })}
    <Tabs />
  </>;
}

function PickTask() {
  const { id = '' } = useParams();
  const { revision } = useKgd();
  const access = useAccess();
  const options = useOptions(`?work_order_id=${id}`, revision);
  const tasks = (options.data?.tasks ?? []).filter((item) => item.work_order_id === id);
  const order = options.data?.work_orders.find((item) => item.id === id);
  return <>
    <Head title={order?.code || '选择工序'} back />
    {order && <article className="m-card">
      <div className="m-sub">{order.product_name || '-'}</div>
      <div className="m-row"><span>计划数 {fq(order.plan_qty)}</span><span>交货 {order.due_date?.slice(0, 10) || '-'}</span></div>
      {access.read && <Link className="m-link" to={`/m/order/${id}`}>查看整张加工单 ›</Link>}
    </article>}
    <div className="m-section">选择要报工的工序</div>
    {options.data && !tasks.length && <div className="m-empty">该加工单暂无您可报工的工序</div>}
    {tasks.map((task) => <Link key={task.id} to={`/m/report/task/${task.id}`} className="m-card-link">
      <article className="m-card m-task">
        <div className="m-task-main">
          <h3>{task.process_name}</h3>
          <Bar done={Number(task.approved_good) || 0} total={Number(task.plan_qty) || 0} />
          <div className="m-row"><span>已报良品 {fq(task.approved_good)}/{fq(task.plan_qty)}</span><span>{modeWageText(task.pricing_mode) || ''} {rateLabel(task.wage_rate) || ''}</span></div>
        </div>
        <span className="m-go">报工 ›</span>
      </article>
    </Link>)}
    <Tabs />
  </>;
}

function ReportForm() {
  const { taskId = '' } = useParams();
  const { revision, session } = useKgd();
  const navigate = useNavigate();
  const options = useOptions('', revision);
  const task = (options.data?.tasks ?? []).find((item) => item.id === taskId);
  const order = options.data?.work_orders.find((item) => item.id === task?.work_order_id);
  const canProxy = options.data?.can_proxy ?? false;
  const [operator, setOperator] = useState(String(session.user.id));
  const [machineId, setMachineId] = useState('');
  const [good, setGood] = useState('1');
  const [defect, setDefect] = useState('0');
  const [picked, setPicked] = useState<{ id: string; qty: string }[]>([]);
  const [sheet, setSheet] = useState(false);
  const [start, setStart] = useState(nowShanghai());
  const [end, setEnd] = useState(nowShanghai());
  const [hours, setHours] = useState('0');
  const [minutes, setMinutes] = useState('0');
  const [remark, setRemark] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ code: string; good: string; defect: string; wage: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef(new CommandKeys());
  const reporters = task?.reporters ?? [];
  // 代报时，自己不在这道工序的生产人员里就默认选第一个人（不然下拉框显示的人和实际提交的人不一致）
  useEffect(() => {
    if (canProxy && reporters.length && !reporters.some((r) => r.id === operator)) setOperator(reporters[0]!.id);
  }, [canProxy, reporters, operator]);
  const seconds = (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60;
  const wage = wageAmount(task?.pricing_mode ?? 'piece', task?.wage_rate, good || '0', seconds);
  function applyTimes(nextStart: string, nextEnd: string) {
    const span = splitSpan(nextStart, nextEnd);
    if (!span) return;
    setHours(span.hours); setMinutes(span.minutes);
  }
  async function submit(complete: boolean) {
    if (!task || busy) return;
    if (canProxy && !reporters.some((r) => r.id === operator)) { setError('请选择生产人员'); return; }
    if (!(Number(good) >= 0) || !(Number(defect) >= 0)) { setError('数量要填数字'); return; }
    const defectSum = picked.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    if (defectSum - (Number(defect) || 0) > 1e-9) { setError('不良品项数量之和不能超过不良品数'); return; }
    setBusy(true); setError('');
    const names = picked.map((item) => options.data?.defect_items.find((row) => row.id === item.id)?.name).filter(Boolean).join('、');
    const body = keys.current.prepare('/api/production-reports', reportCreatePayload({
      task_id: task.id, good_qty: good || '0', defect_qty: defect || '0', effective_seconds: seconds,
      operator_id: String(operator), include_operator: canProxy, defect_note: names, note: remark,
      started_at: start || undefined, ended_at: end || undefined, complete_task: complete,
    }));
    try {
      const created = await apiRequest<{ report: { id: string; code: string; estimated_wage?: string | null } }>('/api/production-reports', { method: 'POST', csrfToken: session.csrf_token, body });
      keys.current.complete('/api/production-reports', body);
      if (machineId || picked.length) {
        try { await apiRequest('/api/quality/bindings', { method: 'POST', csrfToken: session.csrf_token, body: { report_id: created.report.id, machine_id: machineId, defect_item_ids: picked.map((item) => item.id), defect_items: picked } }); }
        catch { setError('报工已保存，不良品项/机台未保存，请到报工记录中修改'); }
      }
      setDone({ code: created.report.code, good: good || '0', defect: defect || '0', wage: yuanLabel(created.report.estimated_wage || wage) || `${wage || '0'}元` });
    } catch (failure) { setError(showError(failure)); }
    finally { setBusy(false); }
  }
  if (done) return <div className="m-ok">
    <div className="m-ok-icon">✓</div>
    <h2>报工成功</h2>
    <p>报工单号 {done.code}</p>
    <p>良品 {done.good} / 不良 {done.defect}</p>
    <p>预计工资 {done.wage.includes('元') ? done.wage : `${done.wage} 元`}</p>
    {error && <p className="m-red">{error}</p>}
    <div className="m-actions static">
      <button type="button" onClick={() => { setDone(null); setGood('1'); setDefect('0'); setPicked([]); setRemark(''); }}>继续报工</button>
      <button type="button" className="primary" onClick={() => navigate('/m/report/today')}>查看今日报工</button>
    </div>
    {order && <button type="button" className="m-link" onClick={() => navigate(`/m/report/order/${order.id}`)}>回到这张加工单</button>}
  </div>;
  if (options.data && !task) return <><Head title="报工" back /><div className="m-empty">该加工单暂无您可报工的工序</div><Tabs /></>;
  return <div className="m-form-page">
    <Head title="报工" back />
    <article className="m-card">
      <h3>{task?.process_name || '-'}</h3>
      <div className="m-sub">{order?.code || '-'} · {order?.product_name || '-'}</div>
      {task && <Bar done={Number(task.approved_good) || 0} total={Number(task.plan_qty) || 0} />}
    </article>
    {error && <div className="m-alert">{error}</div>}
    <label className="m-field"><span>生产人员 *</span>
      {canProxy
        ? (reporters.length
          ? <select value={operator} onChange={(event) => setOperator(event.target.value)}>{reporters.map((item) => <option key={item.id} value={item.id}>{item.name}{item.id === String(session.user.id) ? '（我）' : ''}</option>)}</select>
          : <div className="m-alert" style={{ margin: 0 }}>这道工序还没配生产人员，报不了工。请在电脑版「工序管理 → 修改 → 生产人员」里加人。</div>)
        : <input readOnly value={options.data?.self.name || session.user.display_name} />}
    </label>
    <div className="m-grid2">
      <label className="m-field"><span>良品数</span><Stepper value={good} onChange={setGood} /></label>
      <label className="m-field"><span>不良品数</span><Stepper value={defect} onChange={setDefect} /></label>
    </div>
    <div className="m-field"><span>不良品项</span><button type="button" className="m-picker" onClick={() => setSheet(true)}>{picked.length ? picked.map((item) => options.data?.defect_items.find((row) => row.id === item.id)?.name).join('、') : '点击选择（可不选）'}</button></div>
    <label className="m-field"><span>机台</span><select value={machineId} onChange={(event) => setMachineId(event.target.value)}><option value="">不选</option>{(options.data?.machines ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <details className="m-more">
      <summary>时间、备注（选填）</summary>
      <label className="m-field"><span>开始时间</span><input type="datetime-local" value={start} onChange={(event) => { setStart(event.target.value); applyTimes(event.target.value, end); }} /></label>
      <label className="m-field"><span>结束时间</span><input type="datetime-local" value={end} onChange={(event) => { setEnd(event.target.value); applyTimes(start, event.target.value); }} /></label>
      <div className="m-field"><span>报工时长</span><div className="m-inline"><input inputMode="decimal" value={hours} onChange={(event) => setHours(event.target.value)} /><em>小时</em><input inputMode="decimal" value={minutes} onChange={(event) => setMinutes(event.target.value)} /><em>分钟</em></div></div>
      <label className="m-field"><span>备注</span><textarea value={remark} onChange={(event) => setRemark(event.target.value)} /></label>
    </details>
    <article className="m-card">
      <div className="m-row"><span>计价方式</span><span>{modeWageText(task?.pricing_mode) || '-'}</span></div>
      <div className="m-row"><span>工资单价</span><span>{rateLabel(task?.wage_rate) || '-'}</span></div>
      <div className="m-row"><span>本次工资</span><b className="m-red">{yuanLabel(wage) || '-'}</b></div>
    </article>
    <div className="m-actions">
      <button type="button" disabled={busy} onClick={() => void submit(true)}>报工并完成工序</button>
      <button type="button" className="primary" disabled={busy} onClick={() => void submit(false)}>{busy ? '提交中…' : '提交报工'}</button>
    </div>
    {sheet && <div className="m-mask" onClick={() => setSheet(false)}><div className="m-sheet" onClick={(e) => e.stopPropagation()}>
      <h3>不良品项</h3>
      {!(options.data?.defect_items ?? []).length && <div className="m-empty">还没有设置不良品项</div>}
      {(options.data?.defect_items ?? []).map((item) => {
        const current = picked.find((row) => row.id === item.id);
        return <label key={item.id} className="m-row m-check"><span><input type="checkbox" checked={!!current} onChange={(event) => setPicked((rows) => event.target.checked ? [...rows, { id: item.id, qty: '1' }] : rows.filter((row) => row.id !== item.id))} /> {item.name}</span>{current && <input style={{ width: 72 }} inputMode="decimal" value={current.qty} onChange={(event) => setPicked((rows) => rows.map((row) => row.id === item.id ? { ...row, qty: event.target.value } : row))} />}</label>;
      })}
      <button type="button" className="m-btn primary block" onClick={() => setSheet(false)}>确定</button>
    </div></div>}
  </div>;
}

function Stepper({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const n = Number(value) || 0;
  return <div className="m-stepper">
    <button type="button" onClick={() => onChange(String(Math.max(0, n - 1)))}>−</button>
    <input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} />
    <button type="button" onClick={() => onChange(String(n + 1))}>+</button>
  </div>;
}

function TodayPage() {
  const { revision, onExpired } = useKgd();
  const today = useRemote<Today>('/api/report-workbench/today?page=1&page_size=30', revision, onExpired);
  const items = today.data?.items ?? [];
  return <>
    <Head title="今日报工" />
    <div className="m-stats">
      <div><b>{fq(today.data?.summary.report_qty)}</b><span>报工次数</span></div>
      <div><b>{fq(today.data?.summary.good_qty)}</b><span>良品</span></div>
      <div><b className="m-red">{fq(today.data?.summary.defect_qty)}</b><span>不良</span></div>
    </div>
    {!today.loading && !items.length && <div className="m-empty">今天还没有报工</div>}
    {items.map((item) => <article key={item.id} className="m-card">
      <h3>{item.work_order_code}</h3>
      <div className="m-sub">{item.product_name || '-'} · {item.process_name || '-'}</div>
      <div className="m-row"><span>良品 {fq(item.good_qty)}</span><span>不良 {fq(item.defect_qty)}</span><span>{item.created_at ? new Date(item.created_at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '-'}</span></div>
    </article>)}
    <Tabs />
  </>;
}

// ── 加工单（管理员 / 有查看权限的人）─────────────────────────────────────────
const CHIPS: [string, string][] = [['all', '全部'], ['running', '生产中'], ['not_started', '未开始'], ['paused', '已暂停'], ['completed', '已完成']];

function OrderList() {
  const { revision, onExpired } = useKgd();
  const access = useAccess();
  const [status, setStatus] = useState('running');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const path = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), page_size: '20' });
    if (status !== 'all') params.set('status', status);
    if (q.trim()) params.set(/^[A-Za-z]{1,4}\d/.test(q.trim()) ? 'code' : 'product', q.trim());
    return `/api/progress/work-orders?${params}`;
  }, [page, q, status]);
  const list = useRemote<ListPayload>(access.read ? path : null, revision, onExpired);
  if (!access.read) return <><Head title="加工单" /><div className="m-empty">你的账号没有查看加工单的权限</div><Tabs /></>;
  const counts = list.data?.counts ?? {};
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  return <>
    <Head title="加工单" />
    <div className="m-search"><input placeholder="搜加工单号 / 商品名" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} /></div>
    <div className="m-chips">{CHIPS.map(([key, label]) => <button key={key} type="button" className={status === key ? 'on' : ''} onClick={() => { setStatus(key); setPage(1); }}>{label}{counts[key] != null ? ` ${counts[key]}` : ''}</button>)}</div>
    {list.error && <div className="m-alert">{list.error}</div>}
    {list.loading && !list.data && <div className="m-empty">正在加载…</div>}
    {list.data && !rows.length && <div className="m-empty">没有符合条件的加工单</div>}
    {rows.map((row) => {
      const pp = row.process_progress;
      return <Link key={row.id} to={`/m/order/${row.id}`} className="m-card-link">
        <article className="m-card">
          <h3>{row.code} <StatusTag execution={row.execution} paused={row.order_paused} />{row.overdue && <span className="m-tag red">逾期</span>}{row.priority && PRIORITY[row.priority] && row.priority !== 'normal' && <span className="m-tag orange">{PRIORITY[row.priority]}</span>}</h3>
          <div className="m-sub">{row.product_snapshot?.name || '-'}{row.product_snapshot?.specification ? ` · ${row.product_snapshot.specification}` : ''}</div>
          <Bar done={Number(row.output_qty) || 0} total={Number(row.plan_qty) || 0} />
          <div className="m-row"><span>产出 {fq(row.output_qty)}/{fq(row.plan_qty)}</span><span>工序 {pp ? `${pp.done}/${pp.total}` : '-'}</span><span>交货 {row.due_date?.slice(5, 10) || '-'}</span></div>
          {row.current_process && <div className="m-row"><span>当前工序：{row.current_process}</span></div>}
        </article>
      </Link>;
    })}
    {total > page * 20 && <button type="button" className="m-btn block ghost" onClick={() => setPage(page + 1)}>下一页（共 {total} 张）</button>}
    {page > 1 && <button type="button" className="m-btn block ghost" onClick={() => setPage(page - 1)}>上一页</button>}
    {access.write && <Link to="/m/orders/new" className="m-fab" aria-label="新建加工单">＋</Link>}
    <Tabs />
  </>;
}

function OrderDetail() {
  const { id = '' } = useParams();
  const { revision, onExpired, session, onChanged } = useKgd();
  const access = useAccess();
  const navigate = useNavigate();
  const remote = useRemote<{ work_order: Order }>(id ? `/api/work-orders/${id}` : null, revision, onExpired);
  const options = useOptions(`?work_order_id=${id}`, revision, access.report);
  const reports = useRemote<{ items: Report[] }>(`/api/production-reports?work_order_id=${id}&page=1&page_size=20`, revision, onExpired);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ask, setAsk] = useState<{ action: string; title: string } | null>(null);
  const [tip, setTip] = useState<{ title: string; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const wo = remote.data?.work_order;
  const mine = new Set((options.data?.tasks ?? []).filter((t) => t.work_order_id === id).map((t) => t.id));
  async function act(action: string, why = '') {
    if (!wo || busy) return;
    setBusy(true); setError('');
    try {
      await apiRequest(`/api/work-orders/${wo.id}/actions`, { method: 'POST', csrfToken: session.csrf_token, body: documentActionPayload(action, wo.version ?? 0, why) });
      setAsk(null); setReason('');
      onChanged();
    } catch (failure) { setError(showError(failure)); }
    finally { setBusy(false); }
  }
  if (!wo) return <><Head title="加工单" back />{remote.loading ? <div className="m-empty">正在加载…</div> : <div className="m-empty">{remote.error || '加工单不存在'}</div>}<Tabs /></>;
  const done = wo.tasks.filter((t) => t.execution === 'completed').length;
  const finished = wo.execution === 'completed' || wo.execution === 'cancelled' || wo.execution === 'closed';
  const actions: [string, string, boolean][] = finished ? [] : [
    ...(wo.execution === 'not_started' ? [['start', '开工', true] as [string, string, boolean]] : []),
    ...(wo.execution === 'running' && !wo.order_paused ? [['pause', '暂停', false] as [string, string, boolean], ['complete', '完工', true] as [string, string, boolean]] : []),
    ...(wo.order_paused ? [['resume', '继续生产', true] as [string, string, boolean]] : []),
    ...(['not_started', 'running'].includes(wo.execution) ? [['cancel', '取消', false] as [string, string, boolean]] : []),
  ];
  const needsReason = (a: string) => a === 'cancel' || a === 'pause';
  return <div className={access.write && actions.length ? 'm-form-page' : ''}>
    <Head title={wo.code} back />
    <article className="m-card">
      <h3>{wo.product_snapshot.name || '-'} <StatusTag execution={wo.execution} paused={wo.order_paused} /></h3>
      <div className="m-sub">{wo.product_snapshot.code || ''}{wo.product_snapshot.specification ? ` · ${wo.product_snapshot.specification}` : ''}</div>
      <Bar done={Number(wo.output_qty) || 0} total={Number(wo.plan_qty) || 0} />
      <div className="m-kv">
        <div><span>计划数</span><b>{fq(wo.plan_qty)} {wo.product_snapshot.unit_name || ''}</b></div>
        <div><span>产出</span><b>{fq(wo.output_qty)}</b></div>
        <div><span>入库</span><b>{fq(wo.received_qty)}</b></div>
        <div><span>工序</span><b>{done}/{wo.tasks.length}</b></div>
        <div><span>交货日期</span><b>{wo.due_date?.slice(0, 10) || '-'}</b></div>
        <div><span>优先级</span><b>{PRIORITY[wo.priority ?? ''] || '-'}</b></div>
      </div>
      {wo.note && <div className="m-row"><span>备注：{wo.note}</span></div>}
      {wo.close_reason && <div className="m-row"><span>原因：{wo.close_reason}</span></div>}
    </article>
    {error && <div className="m-alert">{error}</div>}
    <div className="m-section">工序</div>
    {wo.tasks.map((task, i) => {
      const canReport = mine.has(task.id);
      return <article key={task.id} className="m-card m-task">
        <div className="m-task-main">
          <h3><em className="m-seq">{i + 1}</em>{task.process_name} <StatusTag execution={task.execution} /></h3>
          <Bar done={Number(task.approved_good) || 0} total={Number(task.plan_qty) || 0} />
          <div className="m-row"><span>良品 {fq(task.approved_good)}/{fq(task.plan_qty)}</span><span>不良 {fq(task.approved_defect)}</span></div>
        </div>
        {!['completed', 'cancelled'].includes(task.execution) && !finished && <button type="button" className={canReport ? 'm-go' : 'm-go off'}
          onClick={() => {
            if (canReport) { navigate(`/m/report/task/${task.id}`); return; }
            // 说清楚为什么不能报、怎么开通，而不是把按钮藏起来
            if (!access.report) setTip({ title: '你的账号没有报工权限', text: '请管理员在「系统管理 → 用户管理」给你的账号勾上「生产管理 → 报工」。' });
            else if (wo.execution === 'not_started') setTip({ title: '加工单还没开工', text: access.write ? '先点下面的「开工」，开工后就能报工。' : '请班组长先开工，开工后就能报工。' });
            else if (wo.order_paused) setTip({ title: '加工单已暂停', text: '继续生产后才能报工。' });
            else setTip({ title: `你不在「${task.process_name}」的生产人员里`, text: '只有这道工序的生产人员能报工。请管理员在电脑版「工序管理 → 修改 → 生产人员」里加上你；管理员账号也可以直接代报。' });
          }}>报工 ›</button>}
      </article>;
    })}
    {!!wo.materials.length && <>
      <div className="m-section">用料</div>
      <article className="m-card">{wo.materials.map((m) => <div className="m-row" key={m.id}><span>{m.product_name}</span><span>已领 {fq(m.issued_qty)}/{fq(m.required_qty)} {m.unit_name}</span></div>)}</article>
    </>}
    <div className="m-section">最近报工</div>
    {!(reports.data?.items ?? []).length ? <div className="m-empty small">还没有报工</div> : <article className="m-card">
      {(reports.data?.items ?? []).slice(0, 10).map((r) => <div className="m-row" key={r.id}>
        <span>{r.operator_name || r.code}{r.process_name ? ` · ${r.process_name}` : ''}</span><span>良 {fq(r.good_qty)} / 不良 {fq(r.defect_qty)}</span><span>{new Date(r.created_at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      </div>)}
    </article>}
    {access.write && actions.length > 0 && <div className="m-actions">
      {actions.map(([a, label, primary]) => <button key={a} type="button" disabled={busy} className={primary ? 'primary' : a === 'cancel' ? 'danger' : ''}
        onClick={() => (needsReason(a) ? setAsk({ action: a, title: label }) : void act(a))}>{label}</button>)}
    </div>}
    {!access.write || !actions.length ? <Tabs /> : null}
    {tip && <div className="m-mask" onClick={() => setTip(null)}><div className="m-sheet" onClick={(e) => e.stopPropagation()}>
      <h3>{tip.title}</h3>
      <p className="m-tip-text">{tip.text}</p>
      <button type="button" className="m-btn primary block" onClick={() => setTip(null)}>知道了</button>
    </div></div>}
    {ask && <div className="m-mask" onClick={() => setAsk(null)}><div className="m-sheet" onClick={(e) => e.stopPropagation()}>
      <h3>{ask.title}加工单 {wo.code}</h3>
      <label className="m-field"><span>原因{ask.action === 'cancel' ? '（必填）' : '（选填）'}</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="写一下原因" /></label>
      <div className="m-actions static">
        <button type="button" onClick={() => setAsk(null)}>算了</button>
        <button type="button" className={ask.action === 'cancel' ? 'danger' : 'primary'} disabled={busy || (ask.action === 'cancel' && !reason.trim())} onClick={() => void act(ask.action, reason)}>确定{ask.title}</button>
      </div>
    </div></div>}
  </div>;
}

type Product = { id: string; code: string; name: string; specification?: string | null; unit_name?: string };
type RouteRow = { id: string; name: string; current_version_id: string; active: boolean; steps_count?: number };
type Proc = { id: string; name: string; active?: boolean };

function NewOrder() {
  const { revision, onExpired, session, onChanged } = useKgd();
  const access = useAccess();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const [qty, setQty] = useState('');
  const [mode, setMode] = useState<'route' | 'steps'>('route');
  const [routeId, setRouteId] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [warehouse, setWarehouse] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState('normal');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(requestKey());
  const products = useRemote<{ items: Product[] }>(product ? null : `/api/products?page=1&page_size=20${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`, revision, onExpired);
  const routes = useRemote<{ items: RouteRow[] }>('/api/routes', revision, onExpired);
  const procs = useRemote<{ items: Proc[] }>('/api/processes', revision, onExpired);
  const warehouses = useRemote<{ items: { id: string; name: string; active?: boolean }[] }>('/api/warehouses', revision, onExpired);
  const activeRoutes = (routes.data?.items ?? []).filter((r) => r.active !== false);
  const activeProcs = (procs.data?.items ?? []).filter((p) => p.active !== false);
  const activeWarehouses = (warehouses.data?.items ?? []).filter((w) => w.active !== false);
  if (!access.write) return <><Head title="新建加工单" back /><div className="m-empty">你的账号没有新建加工单的权限</div><Tabs /></>;
  async function submit() {
    setError('');
    if (!product) { setError('请选择商品'); return; }
    if (!(Number(qty) > 0)) { setError('计划数要大于 0'); return; }
    const route = activeRoutes.find((r) => r.id === routeId);
    if (mode === 'route' && !route) { setError('请选择工艺路线，或改成「自己选工序」'); return; }
    if (mode === 'steps' && !steps.length) { setError('至少选一道工序'); return; }
    const wh = warehouse || activeWarehouses[0]?.id;
    const body: Record<string, unknown> = { request_key: key.current, product_id: product.id, quantity: String(Number(qty)), priority };
    if (mode === 'route') body.route_version_id = route!.current_version_id; else body.tasks = steps.map((process_id) => ({ process_id }));
    if (wh) body.warehouse_id = wh;
    if (due) body.due_date = due;
    if (note.trim()) body.note = note.trim();
    setBusy(true);
    try {
      const res = await apiRequest<{ work_order: { id: string } }>('/api/work-orders', { method: 'POST', csrfToken: session.csrf_token, body });
      onChanged();
      navigate(`/m/order/${res.work_order.id}`, { replace: true });
    } catch (failure) { setError(showError(failure)); key.current = requestKey(); }
    finally { setBusy(false); }
  }
  return <div className="m-form-page">
    <Head title="新建加工单" back />
    {error && <div className="m-alert">{error}</div>}
    <div className="m-field"><span>商品 *</span>
      {product
        ? <div className="m-picked"><div><b>{product.name}</b><small>{product.code}{product.specification ? ` · ${product.specification}` : ''}</small></div><button type="button" className="m-link" onClick={() => setProduct(null)}>换一个</button></div>
        : <>
          <input placeholder="搜商品名称 / 编号" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="m-options">
            {(products.data?.items ?? []).map((p) => <button key={p.id} type="button" onClick={() => setProduct(p)}><b>{p.name}</b><small>{p.code}{p.specification ? ` · ${p.specification}` : ''}</small></button>)}
            {products.data && !products.data.items.length && <div className="m-empty small">没有找到，先在电脑版里建商品</div>}
          </div>
        </>}
    </div>
    <label className="m-field"><span>计划数 *{product?.unit_name ? `（${product.unit_name}）` : ''}</span><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="例如 100" /></label>
    <div className="m-field"><span>工序 *</span>
      <div className="m-seg"><button type="button" className={mode === 'route' ? 'on' : ''} onClick={() => setMode('route')}>用工艺路线</button><button type="button" className={mode === 'steps' ? 'on' : ''} onClick={() => setMode('steps')}>自己选工序</button></div>
      {mode === 'route'
        ? <select value={routeId} onChange={(e) => setRouteId(e.target.value)}><option value="">请选择工艺路线</option>{activeRoutes.map((r) => <option key={r.id} value={r.id}>{r.name}{r.steps_count ? `（${r.steps_count} 道）` : ''}</option>)}</select>
        : <div className="m-steps">
          {activeProcs.map((p) => { const n = steps.indexOf(p.id); return <button key={p.id} type="button" className={n >= 0 ? 'on' : ''} onClick={() => setSteps((old) => (n >= 0 ? old.filter((x) => x !== p.id) : [...old, p.id]))}>{n >= 0 && <em>{n + 1}</em>}{p.name}</button>; })}
          {!activeProcs.length && <div className="m-empty small">还没有工序，先在电脑版里建</div>}
          <small className="m-hint">按点选的先后顺序排工序</small>
        </div>}
    </div>
    {activeWarehouses.length > 1 && <label className="m-field"><span>入库仓库</span><select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>{activeWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
    <div className="m-grid2">
      <label className="m-field"><span>交货日期</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      <label className="m-field"><span>优先级</span><select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="normal">正常</option><option value="urgent">加急</option><option value="delayed">延期</option></select></label>
    </div>
    <label className="m-field"><span>备注</span><textarea value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} /></label>
    <div className="m-actions"><button type="button" onClick={() => navigate(-1)}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => void submit()}>{busy ? '正在创建…' : '创建加工单'}</button></div>
  </div>;
}

// ── 我的 ──────────────────────────────────────────────────────────────────
function Me() {
  const { session, onLogout, logoutBusy, logoutError } = useKgd();
  const access = useAccess();
  // 只对企业管理员显示身份；其他人的「角色」是在角色管理里自定义的，这里拿不到名字，不显示底层成员类型免得误会
  const role = session.role === 'admin' ? ' · 管理员' : '';
  return <>
    <Head title="我的" />
    <article className="m-card m-me">
      <span className="m-avatar">{session.user.display_name.slice(0, 1)}</span>
      <div><b>{session.user.display_name}</b><small>{session.tenant.name}{role}</small></div>
    </article>
    <article className="m-card">
      <div className="m-row"><span>报工</span><span>{access.report ? '可以' : '没有权限'}</span></div>
      <div className="m-row"><span>查看加工单</span><span>{access.read ? '可以' : '没有权限'}</span></div>
      <div className="m-row"><span>开工 / 新建加工单</span><span>{access.write ? '可以' : '没有权限'}</span></div>
    </article>
    {logoutError && <div className="m-alert">{logoutError}</div>}
    <button type="button" className="m-btn block ghost" onClick={() => { setPrefersDesktop(true); window.location.href = '/'; }}>切换到电脑版</button>
    <button type="button" className="m-btn block danger" disabled={logoutBusy} onClick={onLogout}>{logoutBusy ? '正在退出…' : '退出登录'}</button>
    <Tabs />
  </>;
}
