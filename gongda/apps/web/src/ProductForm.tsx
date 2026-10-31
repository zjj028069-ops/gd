import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ApiError, apiRequest, canWriteProducts, errorMessage, hasPermission } from './api';
import type { Product, Session, Unit } from './api';
import { Notice, formatDate } from './shared';
import { ProductExtensions } from './ProductExtensions';
import type { ExtensionDraft } from './ProductExtensions';
import { useRemote } from './masterTools';
import { productSavePayload } from './domain/payloads';
import { requestKey } from './requestKey';

type Props = { session: Session; product?: Product; units: Unit[]; unitsLoading: boolean; unitsError: string; onClose: () => void; onSaved: (product: Product) => void; onExpired: () => void; onConflict: () => void };

export function ProductForm({ session, product, units, unitsLoading, unitsError, onClose, onSaved, onExpired, onConflict }: Props) {
  const writable = canWriteProducts(session);
  const [extension, setExtension] = useState<ExtensionDraft>(null);
  const [extensionLoading, setExtensionLoading] = useState(true);
  const [department, setDepartment] = useState(product?.department_id ?? session.department_id ?? '');
  const departments = useRemote<{ items: { id: string; name: string; active: boolean }[] }>(hasPermission(session, 'organization.manage') ? '/api/platform/departments' : null, 0, onExpired);
  const numbering = useRemote<{ items: { id: string; entity: string; prefix: string; active: boolean }[] }>(writable ? '/api/configuration/number-rules' : null, 0, onExpired);
  const [numberRule, setNumberRule] = useState('');
  const [numberingBusy, setNumberingBusy] = useState(false);
  const [numberRequest] = useState(() => requestKey());
  const [code, setCode] = useState(product?.code ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [specification, setSpecification] = useState(product?.specification ?? '');
  const [unitId, setUnitId] = useState(product?.unit_id ? String(product.unit_id) : '');
  const [attribute, setAttribute] = useState<Product['attribute']>(product?.attribute ?? 'manufactured');
  const [active, setActive] = useState(product?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const busy = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const initial = dialog.current?.querySelector<HTMLElement>('input:not(:disabled), button');
    initial?.focus();
    return () => { document.body.style.overflow = priorOverflow; };
  }, []);

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
    if (!elements.length) { event.preventDefault(); return; }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function allocateNumber() {
    if (!numberRule || numberingBusy || code) return;
    setNumberingBusy(true); setError('');
    try { const result = await apiRequest<{ allocation: { number: string } }>("/api/configuration/number-rules/" + numberRule + '/allocate', { method: 'POST', body: { request_key: numberRequest }, csrfToken: session.csrf_token }); setCode(result.allocation.number); }
    catch (failure) { if (failure instanceof ApiError && failure.status === 401) onExpired(); else setError(errorMessage(failure)); }
    finally { setNumberingBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!writable || busy.current || conflict || extensionLoading || numberingBusy) return;
    const unit = units.find((item) => String(item.id) === unitId);
    const selectedId = unit?.id ?? (product && String(product.unit_id) === unitId ? product.unit_id : undefined);
    if (!name.trim() || (!product && !code.trim()) || selectedId == null) {
      setError('请填写产品编号、名称，并选择计量单位。');
      return;
    }
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await apiRequest<{ product: Product }>(product ? `/api/products/${encodeURIComponent(String(product.id))}` : '/api/products', {
        method: product ? 'PATCH' : 'POST', body: productSavePayload({ existing: !!product, code, name, specification, unit_id: selectedId, attribute: attribute ?? 'manufactured', active, version: product?.version, extension, department_id: department, include_department: hasPermission(session, 'organization.manage') }), csrfToken: session.csrf_token,
      });
      if (!result.product || result.product.id === undefined) throw new Error('保存响应缺少产品数据，请刷新列表核对结果。');
      onSaved(result.product);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else {
        setError(errorMessage(failure));
        if (product && failure instanceof ApiError && failure.status === 409) {
          setConflict(true);
          onConflict();
        }
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  const currentUnitMissing = product && !units.some((unit) => String(unit.id) === String(product.unit_id));
  const blocked = saving || unitsLoading || !!unitsError || conflict || extensionLoading || numberingBusy;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="product-form-title" onKeyDown={keyboard}>
      <div className="modal-heading"><div><div className="eyebrow">{session.tenant.name}</div><h2 id="product-form-title">{product ? writable ? '编辑产品' : '产品详情' : '新增产品'}</h2></div><button className="icon-button" aria-label="关闭产品表单" disabled={saving} onClick={onClose}>×</button></div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {product && <div className="form-meta"><span className="monospace">版本 v{product.version}</span><span>创建于 {formatDate(product.created_at)}</span></div>}
          {error && <Notice>{error}</Notice>}
          {conflict && <Notice kind="info">产品可能已被其他人更新。请关闭表单并刷新后重新编辑；本次修改尚未确认写入。</Notice>}
          {unitsError && <Notice>{unitsError}</Notice>}
          <div className="form-grid">
            <label className="form-field"><span>产品编号 <i>*</i></span><input value={code} onChange={(event) => setCode(event.target.value)} required disabled={!!product || !writable || saving} autoComplete="off" placeholder="填写企业内唯一编号" />{product && <small>产品创建后编号不可在此修改。</small>}</label>
            <label className="form-field"><span>产品名称 <i>*</i></span><input value={name} onChange={(event) => setName(event.target.value)} required disabled={!writable || saving} autoComplete="off" placeholder="填写产品名称" /></label>
            <label className="form-field"><span>计量单位 <i>*</i></span><select value={unitId} onChange={(event) => setUnitId(event.target.value)} required disabled={!writable || saving || unitsLoading || !!unitsError}><option value="">{unitsLoading ? '正在读取单位…' : '请选择单位'}</option>{currentUnitMissing && <option value={String(product.unit_id)}>{product.unit_name}（当前单位）</option>}{units.map((unit) => <option value={String(unit.id)} key={unit.id}>{unit.name} · {unit.code}</option>)}</select></label>
            <label className="form-field"><span>产品属性 <i>*</i></span><select value={attribute ?? 'manufactured'} onChange={(event) => setAttribute(event.target.value as Product['attribute'])} disabled={!writable || saving}><option value="manufactured">制造件</option><option value="purchased">采购件</option></select></label>
            <label className="form-field form-field-wide"><span>规格说明</span><textarea value={specification} onChange={(event) => setSpecification(event.target.value)} disabled={!writable || saving} rows={3} placeholder="选填规格、型号或尺寸" /></label>
          </div>
          {!product && writable && (numbering.data?.items.some(row => row.entity === 'product' && row.active) ?? false) && <div className="settings-upload"><label className="form-field"><span>申请产品编号（可选）</span><select value={numberRule} disabled={saving || numberingBusy || !!code} onChange={event => setNumberRule(event.target.value)}><option value="">选择启用规则</option>{numbering.data?.items.filter(row => row.entity === 'product' && row.active).map(row => <option key={row.id} value={row.id}>{row.prefix}</option>)}</select></label><button type="button" className="button button-secondary" disabled={!numberRule || !!code || numberingBusy || saving} onClick={() => void allocateNumber()}>{numberingBusy ? '正在分配…' : '申请编号'}</button></div>}{hasPermission(session, 'organization.manage') && <label className="form-field settings-section"><span>产品所属部门</span><select value={department} disabled={!writable || saving || departments.loading} onChange={event => setDepartment(event.target.value)}><option value="">不归属部门</option>{departments.data?.items.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><small>部门范围角色仅能看到明确归属本人部门的产品。</small></label>}<ProductExtensions product={product} session={session} writable={writable} saving={saving} onExpired={onExpired} onDraft={setExtension} onLoading={setExtensionLoading} />{product && <label className="checkbox-field"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={!writable || saving} /><span>启用产品</span></label>}
          <p className="muted small">{writable ? '填写内容在提交保存成功后才会写入当前企业。' : '当前账号只查看产品，不能提交修改。'}</p>
        </div>
        <div className="modal-footer"><button className="button button-secondary" type="button" disabled={saving} onClick={onClose}>{writable ? conflict ? '关闭并重新查看' : '取消' : '关闭'}</button>{writable && <button className="button button-primary" type="submit" disabled={blocked}>{saving ? '正在提交…' : '保存产品'}</button>}</div>
      </form>
    </div>
  </div>;
}

