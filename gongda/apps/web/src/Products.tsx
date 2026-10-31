import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, apiRequest, canWriteProducts, errorMessage, hasPermission, isAbort } from './api';
import type { Product, Session, Unit } from './api';
import { ProductForm } from './ProductForm';
import { EmptyState, Loading, Notice, StatusBadge, formatDate } from './shared';
import { useRemote } from './masterTools';
import type { FieldVersion } from './ConfigurationSettings';
import { baseColumns, defaultColumns } from './ViewSettings';
import type { ViewResponse } from './ViewSettings';

const PAGE_SIZE = 20;
type Props = { session: Session; units: Unit[]; unitsLoading: boolean; unitsError: string; revision: number; onExpired: () => void; onChanged: () => void };
export function Products({ session, units, unitsLoading, unitsError, revision, onExpired, onChanged }: Props) {
  const [items, setItems] = useState<Product[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1);
  const [queryInput, setQueryInput] = useState(''); const [query, setQuery] = useState(''); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [success, setSuccess] = useState(''); const [refresh, setRefresh] = useState(0); const [form, setForm] = useState<{ product?: Product } | null>(null);
  const writable = canWriteProducts(session);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width:560px)').matches);
  useEffect(() => { const media = window.matchMedia('(max-width:560px)'); const changed = () => setNarrow(media.matches); media.addEventListener('change', changed); return () => media.removeEventListener('change', changed); }, []);
  const configReadable = hasPermission(session, 'configuration.read');
  const schema = useRemote<{ version: FieldVersion | null }>(configReadable ? '/api/configuration/field-schemas/current?entity=product' : null, revision, onExpired);
  const pc = useRemote<ViewResponse>(configReadable ? '/api/configuration/views/product/pc' : null, revision, onExpired);
  const mobile = useRemote<ViewResponse>(configReadable ? '/api/configuration/views/product/mobile' : null, revision, onExpired);
  const labels: Record<string, string> = { ...baseColumns, created_at: '创建时间', ...Object.fromEntries((schema.data?.version?.fields ?? []).map(field => [`ext:${field.key}`, field.label])) };
  const columns = pc.data?.effective?.configuration.columns ?? [...defaultColumns, 'created_at'];
  const cards = mobile.data?.effective?.configuration.card_fields ?? ['code', 'name', 'unit_name', 'active'];
  const sorts = (narrow ? mobile : pc).data?.effective?.configuration.sort ?? [];
  const sorted = [...items].sort((a, b) => {
    for (const sort of sorts) { const left = cellValue(a, sort.field); const right = cellValue(b, sort.field); const field = schema.data?.version?.fields.find(item => 'ext:' + item.key === sort.field); const numeric = sort.field === 'version' || field?.type === 'number' || field?.type === 'formula'; const order = numeric ? compareDecimal(left, right) : String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN', { numeric: true }); if (order) return sort.direction === 'desc' ? -order : order; }
    return 0;
  });
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    const params = new URLSearchParams({ q: query, page: String(page), page_size: String(PAGE_SIZE) });
    apiRequest<{ items: Product[]; total: number }>(`/api/products?${params}`, { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items) || typeof result.total !== 'number') throw new Error('产品数据格式无法识别。');
      setItems(result.items); setTotal(result.total);
    }).catch((failure: unknown) => { if (isAbort(failure)) return; if (failure instanceof ApiError && failure.status === 401) onExpired(); else { setItems([]); setTotal(0); setError(errorMessage(failure)); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, page, refresh, revision, onExpired]);
  function search(event: FormEvent) { event.preventDefault(); setPage(1); setQuery(queryInput.trim()); setRefresh(value => value + 1); }
  function saved(product: Product) { setForm(null); setSuccess(`产品“${product.name}”已保存，当前版本 ${product.version}。`); onChanged(); }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const frozen = Math.min(pc.data?.effective?.configuration.frozen_count ?? 0, columns.length);
  return <><div className="page-heading"><div><div className="eyebrow">基础档案 / 产品</div><h1>产品档案</h1><p>维护产品编号、规格、单位、属性与已发布扩展信息。</p></div>{writable ? <button className="button button-primary" disabled={unitsLoading || !!unitsError || units.length === 0} onClick={() => { setSuccess(''); setForm({}); }}>＋ 新增产品</button> : <span className="badge badge-gray">当前账号只读</span>}</div>
    {session.data_scope !== 'all' && <Notice kind="info">当前数据范围：{session.data_scope === 'department' ? '本人所属部门' : '本人创建'}。数量和记录由服务端按范围返回。</Notice>}{error && <Notice>{error}</Notice>}{success && <Notice kind="success"><div className="notice-row"><span>{success}</span><button className="icon-button" aria-label="关闭保存提示" onClick={() => setSuccess('')}>×</button></div></Notice>}
    {(pc.error || mobile.error || schema.error) && <Notice kind="info">部分显示配置读取未完成：{pc.error || mobile.error || schema.error}。当前使用基础列；服务端字段权限仍生效。</Notice>}{writable && unitsError && <Notice>单位档案读取失败：{unitsError}。暂不能创建或修改产品，请刷新工作空间重试。</Notice>}{writable && !unitsLoading && !unitsError && units.length === 0 && <Notice kind="info">当前企业没有可用计量单位，请先在“计量单位”页面创建或启用。</Notice>}
    <section className="panel table-panel"><div className="table-toolbar"><form className="search-form" onSubmit={search}><label className="sr-only" htmlFor="product-search">搜索产品</label><input id="product-search" type="search" value={queryInput} onChange={event => setQueryInput(event.target.value)} placeholder="搜索产品编号或名称" /><button className="button button-secondary" disabled={loading}>搜索</button></form><div className="toolbar-end"><span className="muted small">{loading ? '正在读取…' : `共 ${total} 个产品`}</span><button className="button button-quiet" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新</button></div></div>
      {loading ? <Loading /> : items.length === 0 ? <EmptyState title={error ? '产品读取未完成' : query ? '没有匹配的产品' : '当前范围还没有产品'} description={error ? '请重试连接，页面不使用示例数据。' : '调整查询或由有资格的成员维护产品。'} /> : <><div className="table-scroll product-pc-view"><table className="data-table configured-product-table" style={{ width: (columns.length + 1) * 160 }}><thead><tr>{columns.map((key, index) => <th key={key} className={index < frozen ? 'frozen-product-cell' : undefined} style={index < frozen ? { left: index * 160 } : undefined}>{labels[key] ?? key}</th>)}<th>操作</th></tr></thead><tbody>{sorted.map(product => <tr key={product.id}>{columns.map((key, index) => <td key={key} className={index < frozen ? 'frozen-product-cell' : undefined} style={index < frozen ? { left: index * 160 } : undefined}><ProductCell product={product} field={key} /></td>)}<td><button className="text-button" onClick={() => { setSuccess(''); setForm({ product }); }}>{writable ? '编辑' : '查看'}</button></td></tr>)}</tbody></table></div><div className="product-mobile-view">{sorted.map(product => <article className="product-mobile-card" key={product.id}>{cards.map(key => <div key={key}><span>{labels[key] ?? key}</span><strong><ProductCell product={product} field={key} /></strong></div>)}<button className="button button-secondary" onClick={() => { setSuccess(''); setForm({ product }); }}>{writable ? '编辑产品' : '查看产品'}</button></article>)}</div></>}
      {!loading && total > 0 && <div className="pagination"><span>每页 {PAGE_SIZE} 条 · 第 {page} / {pages} 页</span><div><button className="button button-secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><button className="button button-secondary" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</button></div></div>}
    </section>{sorts.length > 0 && <p className="muted small">显示配置排序用于本次返回的{items.length}条，跨页全量排序后续完善。</p>}{form && <ProductForm session={session} product={form.product} units={units} unitsLoading={unitsLoading} unitsError={unitsError} onClose={() => setForm(null)} onSaved={saved} onExpired={onExpired} onConflict={() => setRefresh(value => value + 1)} />}</>;
}
function cellValue(product: Product, key: string): unknown { if (key.startsWith('ext:')) return product.extension?.values[key.slice(4)]; return (product as unknown as Record<string, unknown>)[key]; }
function ProductCell({ product, field }: { product: Product; field: string }) { const value = cellValue(product, field); if (field === 'active') return <StatusBadge active={product.active} />; if (field === 'attribute') return <span className="badge badge-outline">{product.attribute === 'manufactured' ? '制造件' : '采购件'}</span>; if (field === 'created_at') return <>{formatDate(product.created_at)}</>; if (field === 'version') return <>v{product.version}</>; if (typeof value === 'boolean') return <>{value ? '是' : '否'}</>; return <span className={field === 'code' ? 'monospace product-code' : undefined}>{value === null || value === undefined || value === '' ? '—' : String(value)}</span>; }



function compareDecimal(left: unknown, right: unknown) { const parse = (value: unknown): bigint | null => { const text = String(value ?? ''); if (!/^-?[0-9]+(?:[.][0-9]{1,6})?$/u.test(text)) return null; const sign = text.startsWith('-') ? -1n : 1n; const [whole, fraction = ''] = text.replace('-', '').split('.'); return sign * (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))); }; const a = parse(left), b = parse(right); if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1; return a === b ? 0 : a < b ? -1 : 1; }


