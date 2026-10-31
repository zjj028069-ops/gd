import { useState } from 'react';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import type { FormEvent } from 'react';
import { errorMessage, hasPermission } from './api';
import type { EntityId } from './api';
import { useRemote } from './masterTools';
import { attachmentMime, attachmentSizeMessage, attachmentUploadPayload } from './domain/payloads';
import { EmptyState, Loading, Notice, StatusBadge, formatDate } from './shared';
import { SettingsTabs, WriteFeedback, useSettingsWrite } from './settingsTools';
import type { SettingsProps } from './settingsTools';
import { requestKey as createRequestKey } from './requestKey';

type Service = { state: 'active' | 'read_only' | 'expired'; expires_at: string | null; effective_state: string; seat_limit: number; product_limit: number; storage_limit_bytes: number; storage_used_bytes: number; seat_used: number; product_used: number; version: number; configuration_allowed: boolean };
type Attachment = { id: string; filename: string; mime: string; byte_size: number; sha256: string; resource_type: string; resource_id: string; active: boolean; deleted_at: string | null; version: number; created_at: string };
const bytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(2)} MiB` : `${value.toLocaleString('zh-CN')} B`;
export function AssetSettings(props: SettingsProps) {
  const [tab, setTab] = useState('files');
  const allScope = props.session.data_scope === 'all';
  const effectiveTab = allScope ? tab : 'files';
  return <><div className="page-heading"><div><div className="eyebrow">平台 / 文件与服务</div><h1>附件与服务额度</h1><p>企业文件按资源归属校验访问；席位、产品与存储额度由服务端执行。</p></div><span className="badge badge-teal">真实企业数据</span></div><SettingsTabs items={[{ key: 'files', label: '资源附件' }, ...(allScope ? [{ key: 'service', label: '服务与额度' }] : [])]} active={effectiveTab} onChange={setTab} />{effectiveTab === 'files' ? <Attachments {...props} /> : <TenantService {...props} />}</>;
}
function TenantService(props: SettingsProps) {
  const remote = useRemote<{ service: Service }>('/api/tenant-service', props.revision, props.onExpired);
  const service = remote.data?.service;
  return <>{remote.error && <Notice>{remote.error}</Notice>}{remote.loading ? <Loading /> : service && <><div className="metric-grid"><QuotaMetric label="企业席位" used={service.seat_used} limit={service.seat_limit} /><QuotaMetric label="产品档案" used={service.product_used} limit={service.product_limit} /><section className="metric-card"><div className="metric-label">附件存储</div><div className="metric-value metric-value-text">{bytes(service.storage_used_bytes)}</div><p>上限 {bytes(service.storage_limit_bytes)}</p></section><section className="metric-card"><div className="metric-label">当前服务状态</div><div className="metric-value metric-value-text">{{ active: '有效', read_only: '只读', expired: '已到期' }[service.effective_state] ?? service.effective_state}</div><p>{service.expires_at ? `到期：${formatDate(service.expires_at)}` : '未设置到期时间'}</p></section></div>{service.configuration_allowed && hasPermission(props.session, 'tenant_service.manage') ? <ServiceForm key={service.version} service={service} {...props} onReload={remote.reload} /> : <Notice kind="info">当前账号可以查询额度。服务状态和配额需要平台授权；正式部署不提供企业管理员自行改套餐的接口。</Notice>}</>}</>;
}
function QuotaMetric({ label, used, limit }: { label: string; used: number; limit: number }) { return <section className="metric-card"><div className="metric-label">{label}</div><div className="metric-value">{used}</div><p>上限 {limit.toLocaleString('zh-CN')}</p></section>; }
function ServiceForm({ service, onReload, ...props }: SettingsProps & { service: Service; onReload: () => void }) {
  const mutation = useSettingsWrite(props);
  const [state, setState] = useState(service.state);
  const [expires, setExpires] = useState(service.expires_at?.slice(0, 10) ?? '');
  const [seats, setSeats] = useState(String(service.seat_limit));
  const [products, setProducts] = useState(String(service.product_limit));
  const [storage, setStorage] = useState(String(service.storage_limit_bytes));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await mutation.write('/api/tenant-service', { version: service.version, state, expires_at: expires ? `${expires}T23:59:59+08:00` : null, seat_limit: Number(seats), product_limit: Number(products), storage_limit_bytes: Number(storage) }, 'PATCH');
    if (result) mutation.setSuccess('服务参数已保存。');
  }
  return <section className="panel"><div className="panel-heading"><h2>本机管理员服务参数</h2><span className="badge badge-amber">开发配置</span></div><Notice kind="info">此处用于本机测试配额、到期与只读策略，不是在线付费或正式运营开通。</Notice><WriteFeedback mutation={mutation} onReload={onReload} /><form onSubmit={submit}><div className="form-grid"><label className="form-field"><span>配置状态</span><select value={state} onChange={event => setState(event.target.value as Service['state'])}><option value="active">有效</option><option value="read_only">只读</option><option value="expired">已到期</option></select></label><label className="form-field"><span>到期日期（北京时间）</span><DatePicker value={expires ? dayjs(expires) : null} onChange={(v) => setExpires(v ? v.format('YYYY-MM-DD') : '')} /><small>留空表示本机测试未设到期日。</small></label><label className="form-field"><span>席位上限</span><input required type="number" min="1" max="100000" step="1" value={seats} onChange={event => setSeats(event.target.value)} /></label><label className="form-field"><span>产品上限</span><input required type="number" min="0" max="10000000" step="1" value={products} onChange={event => setProducts(event.target.value)} /></label><label className="form-field"><span>存储上限（字节）</span><input required type="number" min="0" max="1099511627776" step="1" value={storage} onChange={event => setStorage(event.target.value)} /></label></div><div className="settings-actions"><button className="button button-primary" disabled={mutation.saving || mutation.conflict}>保存服务参数</button></div></form></section>;
}
function Attachments(props: SettingsProps) {
  const [type, setType] = useState<'product' | 'process'>('product');
  const [resourceId, setResourceId] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [requestKey, setRequestKey] = useState(() => createRequestKey());
  const [inputKey, setInputKey] = useState(0);
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState('');
  const writable = hasPermission(props.session, 'attachments.write');
  const resources = useRemote<{ items: { id: EntityId; code: string; name: string }[]; total?: number }>(type === 'product' ? '/api/products?page_size=100&page=1' : '/api/processes', props.revision, props.onExpired);
  const remote = useRemote<{ items: Attachment[]; total: number; limit: number }>(resourceId ? `/api/attachments?resource_type=${type}&resource_id=${encodeURIComponent(resourceId)}&include_deleted=${deleted}` : null, props.revision, props.onExpired);
  const mutation = useSettingsWrite(props);
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || !resourceId) { mutation.setError('请先选择资源与文件。'); return; }
    const sizeMessage = attachmentSizeMessage(file.size);
    if (sizeMessage) { mutation.setError(sizeMessage); return; }
    const mime = attachmentMime(file);
    if (!mime) { mutation.setError('本轮支持PNG、JPEG、PDF或纯文本。'); return; }
    try {
      const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(new Error('读取本机文件失败。')); reader.readAsDataURL(file); });
      const result = await mutation.write<{ attachment: Attachment; replayed: boolean }>('/api/attachments', attachmentUploadPayload({ resource_type: type, resource_id: resourceId, filename: file.name, mime, content_base64: content, request_key: requestKey }));
      if (result) { setFile(null); setInputKey(value => value + 1); setRequestKey(createRequestKey()); mutation.setSuccess(`附件“${result.attachment.filename}”已保存${result.replayed ? '（重复请求已返回原记录）' : ''}。`); }
    } catch (failure) { mutation.setError(errorMessage(failure)); }
  }
  async function download(attachment: Attachment) {
    setDownloadError(''); setDownloading(attachment.id);
    try {
      const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}/content`, { credentials: 'same-origin' });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        if (response.status === 401) props.onExpired();
        throw new Error(result?.error?.message ?? `下载失败（${response.status}）`);
      }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = attachment.filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (failure) { setDownloadError(errorMessage(failure)); } finally { setDownloading(''); }
  }
  async function change(attachment: Attachment, remove = false) {
    const response = await mutation.write(`/api/attachments/${attachment.id}`, remove ? { version: attachment.version } : { version: attachment.version, active: !attachment.active }, remove ? 'DELETE' : 'PATCH');
    if (response) mutation.setSuccess(remove ? '附件已软删除；审计及存储计量保留。' : '附件启用状态已更新。');
  }
  return <><section className="panel settings-section"><div className="form-grid"><label className="form-field"><span>资源类型</span><select value={type} onChange={event => { setType(event.target.value as typeof type); setResourceId(''); mutation.reset(); }}><option value="product">产品</option>{props.session.data_scope === 'all' && hasPermission(props.session, 'master.read') && <option value="process">工序</option>}</select></label><label className="form-field"><span>所属资源</span><select value={resourceId} onChange={event => { setResourceId(event.target.value); mutation.reset(); }}><option value="">请选择本企业档案</option>{resources.data?.items.map(row => <option key={row.id} value={String(row.id)}>{row.code} · {row.name}</option>)}</select><small>产品本次最多读取100条；工序最多200条。</small></label></div>{resources.error && <Notice>{resources.error}</Notice>}{writable && <form className="settings-upload" onSubmit={upload}><label className="form-field"><span>上传附件（最大2 MiB）</span><input key={inputKey} type="file" accept=".png,.jpg,.jpeg,.pdf,.txt" disabled={mutation.saving || !resourceId} onChange={event => { setFile(event.target.files?.[0] ?? null); setRequestKey(createRequestKey()); mutation.reset(); }} /></label><button className="button button-primary" disabled={!file || !resourceId || mutation.saving || mutation.conflict}>{mutation.saving ? '正在保存…' : '上传到当前资源'}</button></form>}<label className="checkbox-field"><input type="checkbox" checked={deleted} onChange={event => setDeleted(event.target.checked)} />包含已删除记录</label><p className="muted small">文件内容经登录鉴权访问。停用或删除后无法下载；删除保留历史与占用量。工程图纸版本和大文件对象存储在后续阶段实现。</p></section><WriteFeedback mutation={mutation} onReload={remote.reload} />{downloadError && <Notice>{downloadError}</Notice>}{remote.error && <Notice>{remote.error}</Notice>}<section className="panel table-panel">{remote.loading ? <Loading /> : !remote.data?.items.length ? <EmptyState title={resourceId ? '此资源暂无附件' : '请选择所属资源'} description="附件列表读取真实存储，没有预置文件。" /> : <div className="table-scroll"><table className="data-table compact-table"><thead><tr><th>文件名 / SHA256</th><th>大小</th><th>状态</th><th>版本</th><th>上传时间</th><th>操作</th></tr></thead><tbody>{remote.data.items.map(row => <tr key={row.id}><td><strong className="cell-title">{row.filename}</strong><span className="cell-subtitle monospace">{row.sha256.slice(0, 16)}…</span></td><td>{bytes(row.byte_size)}</td><td>{row.deleted_at ? <span className="badge badge-gray">已删除</span> : <StatusBadge active={row.active} />}</td><td>v{row.version}</td><td>{formatDate(row.created_at)}</td><td className="settings-table-actions"><button className="text-button" disabled={!row.active || !!row.deleted_at || !!downloading} onClick={() => void download(row)}>{downloading === row.id ? '下载中…' : '下载'}</button>{writable && !row.deleted_at && <><button className="text-button" disabled={mutation.saving || mutation.conflict} onClick={() => void change(row)}>{row.active ? '停用' : '启用'}</button><button className="text-button danger-text" disabled={mutation.saving || mutation.conflict} onClick={() => void change(row, true)}>软删除</button></>}</td></tr>)}</tbody></table></div>}</section></>;
}



