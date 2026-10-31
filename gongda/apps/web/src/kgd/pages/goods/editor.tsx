import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Input, Modal, Select, Tooltip, TreeSelect } from 'antd';
import { AlignCenterOutlined, AlignLeftOutlined, AlignRightOutlined, BoldOutlined, CodeOutlined, ItalicOutlined, OrderedListOutlined, PictureOutlined, QuestionCircleOutlined, SettingOutlined, StrikethroughOutlined, UnderlineOutlined, UnorderedListOutlined } from '@ant-design/icons';
import type { Product, Unit } from '../../../api';
import { apiRequest } from '../../../api';
import { ProductExtensions } from '../../../ProductExtensions';
import type { ExtensionDraft } from '../../../ProductExtensions';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { showError, useCommand } from '../../kit';
import { CategoryBoard } from './categories';
import { AttachmentImage, allowedMime, buildTree, decimalInput, fileBase64, hints, mulPercent, positivePrice, rateFromAmount, sourceOptions, uploadAttachment } from './shared';
import type { Category, CategoryNode } from './shared';

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return <div className="goods-field"><label>{required && <i className="goods-star">*</i>}{label}{hint && <Tooltip title={hint}><QuestionCircleOutlined aria-label={`${label}说明`} style={{ marginLeft: 4, color: '#999' }} /></Tooltip>}</label><div>{children}</div></div>;
}

function treeData(nodes: CategoryNode[]): { value: string; title: string; children?: { value: string; title: string }[] }[] {
  return nodes.map((node) => ({ value: node.id, title: node.name, children: node.children.length ? treeData(node.children) : undefined }));
}

export function GoodsEditor({ product, copying, onClose }: { product?: Product; copying?: boolean; onClose: () => void }) {
  const editing = product && !copying ? product : undefined;
  const { session, revision, onExpired } = useKgd();
  const command = useCommand();
  const categories = useRemote<{ items: Category[] }>('/api/products/categories?kind=goods', revision, onExpired);
  const units = useRemote<{ items: Unit[] }>('/api/units', revision, onExpired);
  const [code, setCode] = useState(copying ? '' : product?.code ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [categoryId, setCategoryId] = useState(product?.category_id ?? '');
  const [unitId, setUnitId] = useState(product?.unit_id ? String(product.unit_id) : '');
  const [sale, setSale] = useState(product?.sale_price ?? '');
  const [cost, setCost] = useState(product?.cost_price ?? '');
  const [amount, setAmount] = useState(product?.commission_amount ?? '');
  const [rate, setRate] = useState(product?.commission_rate ?? '');
  const [source, setSource] = useState(product?.source ?? '');
  const [spec, setSpec] = useState(product?.specification ?? '');
  const [inspectionId, setInspectionId] = useState(product?.inspection_spec_id ?? '');
  const [inspectionName, setInspectionName] = useState(product?.inspection_spec_name ?? '');
  const [specs, setSpecs] = useState<{ id: string; name: string }[]>([]);
  const [stale, setStale] = useState(product?.stale_days ?? '');
  const [upper, setUpper] = useState(product?.stock_upper_warn ?? '');
  const [lower, setLower] = useState(product?.stock_lower_warn ?? '');
  const [remark, setRemark] = useState(product?.remark ?? '');
  const [intro, setIntro] = useState(product?.intro_html ?? '');
  const [images, setImages] = useState<string[]>(copying ? [] : product?.images ?? []);
  const [files, setFiles] = useState<{ id: string; filename: string }[]>([]);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [unitOpen, setUnitOpen] = useState(false);
  const [unitQuery, setUnitQuery] = useState('');
  const [unitKeyword, setUnitKeyword] = useState('');
  const [unitDraft, setUnitDraft] = useState<{ id?: string; name: string; version?: number } | null>(null);
  const [unitErr, setUnitErr] = useState('');
  const [preview, setPreview] = useState<{ name: string; url: string; image: boolean; text?: string } | null>(null);
  const commissionAnchor = useRef<'amount' | 'rate' | ''>(product?.commission_rate ? 'rate' : product?.commission_amount ? 'amount' : '');
  const [dragId, setDragId] = useState('');
  const [extension, setExtension] = useState<ExtensionDraft>(null);
  const [extLoading, setExtLoading] = useState(true);
  const rich = useRef<HTMLDivElement>(null);
  const richReady = useRef(false);
  useEffect(() => {
    if (!editing) return;
    void apiRequest<{ items: { id: string; filename: string }[] }>(`/api/attachments?resource_type=product&resource_id=${editing.id}`).then((result) => {
      const ids = new Set([...(editing.images ?? []), ...(editing.attachments ?? [])]);
      setFiles(result.items.filter((item) => ids.has(item.id) && (editing.attachments ?? []).includes(item.id)));
    }).catch(() => undefined);
  }, [editing]);
  useEffect(() => {
    if (rich.current && !richReady.current) { rich.current.innerHTML = intro || ''; richReady.current = true; }
  }, [intro]);
  function applySale(next: string) {
    const value = decimalInput(next, 5);
    setSale(value);
    if (!positivePrice(value)) return;
    if (commissionAnchor.current === 'amount' && amount) setRate(rateFromAmount(value, amount));
    else if (rate) setAmount(mulPercent(value, rate));
    else if (amount) setRate(rateFromAmount(value, amount));
  }
  function applyAmount(next: string) {
    const value = decimalInput(next, 10);
    setAmount(value);
    if (value) commissionAnchor.current = 'amount';
    else if (commissionAnchor.current === 'amount') commissionAnchor.current = '';
    if (!positivePrice(sale)) return;
    setRate(value ? rateFromAmount(sale, value) : '');
  }
  function applyRate(next: string) {
    const value = decimalInput(next, 5);
    setRate(value);
    if (value) commissionAnchor.current = 'rate';
    else if (commissionAnchor.current === 'rate') commissionAnchor.current = '';
    if (!positivePrice(sale)) return;
    setAmount(value ? mulPercent(sale, value) : '');
  }
  async function searchSpecs(q: string) {
    const result = await apiRequest<{ items: { id: string; name: string }[] }>(`/api/products/inspection-specs?q=${encodeURIComponent(q)}`);
    setSpecs(result.items);
  }
  function takeFiles(list: FileList | File[], image: boolean) {
    const picked = [...list].filter((file) => allowedMime(file, image));
    if (image) setPendingImages((current) => [...current, ...picked]);
    else setPendingFiles((current) => [...current, ...picked]);
  }
  async function saveUnit() {
    const name = unitDraft?.name.trim() ?? '';
    if (!name) { setUnitErr('请填写单位'); command.setFieldError('unit_name', '请填写单位'); return; }
    const duplicated = (units.data?.items ?? []).some((item) => item.name.trim() === name && String(item.id) !== unitDraft?.id);
    if (duplicated) { setUnitErr('该单位已存在'); command.setError('该单位已存在'); return; }
    try {
      if (unitDraft?.id) await command.send(`/api/units/${unitDraft.id}`, { version: unitDraft.version, name, active: true }, 'PATCH');
      else await command.send('/api/units', { code: `U${Date.now().toString(36)}`, name });
      setUnitErr('');
      setUnitDraft(null);
    } catch (failure) {
      const message = showError(failure);
      setUnitErr(message);
      command.setError(message);
    }
  }
  function closePreview() {
    setPreview((current) => {
      if (current?.url.startsWith('blob:')) URL.revokeObjectURL(current.url);
      return null;
    });
  }
  async function openPreview(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const image = blob.type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
    if (image) { setPreview({ name, url, image: true }); return; }
    if (blob.type.startsWith('text/') || name.toLowerCase().endsWith('.txt')) {
      setPreview({ name, url, image: false, text: await blob.text() });
      return;
    }
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) setPreview({ name, url, image: false });
    else setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  async function removeUnit(id: string) {
    try { await command.send(`/api/units/${id}`, {}, 'DELETE'); } catch (failure) { command.setError(showError(failure)); }
  }
  async function reorderUnits(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ordered = [...(units.data?.items ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const from = ordered.findIndex((item) => String(item.id) === dragId);
    const to = ordered.findIndex((item) => String(item.id) === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved!);
    try { await command.send('/api/units/reorder', { ids: ordered.map((item) => String(item.id)) }); } catch (failure) { command.setError(showError(failure)); }
  }
  async function attach(productId: string, version: number, imageIds: string[], fileIds: string[]) {
    const uploadedImages = [...imageIds];
    const uploadedFiles = [...fileIds];
    for (const file of pendingImages) {
      const mime = allowedMime(file, true);
      if (!mime) continue;
      const saved = await uploadAttachment(session, productId, file, mime);
      uploadedImages.push(saved.attachment.id);
    }
    for (const file of pendingFiles) {
      const mime = allowedMime(file, false);
      if (!mime) continue;
      const saved = await uploadAttachment(session, productId, file, mime);
      uploadedFiles.push(saved.attachment.id);
    }
    if (!pendingImages.length && !pendingFiles.length && editing) return;
    await command.send(`/api/products/${productId}`, { version, name: name.trim(), active: editing?.active ?? true, images: uploadedImages, attachments: uploadedFiles }, 'PATCH');
  }
  async function save() {
    if (!name.trim()) { command.setFieldError('name', '请填写商品名'); return; }
    if (!unitId) { command.setFieldError('unit_id', '请选择单位'); return; }
    const html = rich.current?.innerHTML ?? intro;
    const body: Record<string, unknown> = {
      name: name.trim(), code: code.trim(), specification: spec, unit_id: unitId || null, category_id: categoryId || null,
      sale_price: sale || null, cost_price: cost || null, commission_amount: amount || null, commission_rate: rate || null,
      source: source || null, inspection_spec_id: inspectionId || null, stale_days: stale || null, stock_upper_warn: upper || null, stock_lower_warn: lower || null,
      remark, intro_html: html, ...(extension ? { extension } : {}),
    };
    try {
      if (editing) {
        const saved = await command.send<{ product: Product }>(`/api/products/${editing.id}`, { ...body, version: editing.version, active: editing.active, images, attachments: files.map((item) => item.id) }, 'PATCH');
        if (saved?.product && (pendingImages.length || pendingFiles.length)) await attach(String(saved.product.id), saved.product.version, saved.product.images ?? images, saved.product.attachments ?? files.map((item) => item.id));
      } else {
        const created = await command.send<{ product: Product }>('/api/products', body);
        if (created?.product && (pendingImages.length || pendingFiles.length)) await attach(String(created.product.id), created.product.version, [], []);
      }
      onClose();
    } catch (failure) { command.setError(showError(failure)); }
  }
  function exec(commandName: string, value?: string) {
    rich.current?.focus();
    document.execCommand(commandName, false, value);
    setIntro(rich.current?.innerHTML ?? '');
  }
  const unitRows = [...(units.data?.items ?? [])].filter((item) => item.active !== false).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).filter((item) => !unitKeyword || item.name.includes(unitKeyword));
  const specOptions = specs.some((item) => item.id === inspectionId) || !inspectionId ? specs : [{ id: inspectionId, name: inspectionName || inspectionId }, ...specs];
  return <Modal className="goods-editor" rootClassName="goods-editor-root" title={editing ? '修改商品' : '新增商品'} open width="100%" getContainer={() => document.querySelector('.kgd-main') ?? document.body} onCancel={onClose} onOk={() => void save()} confirmLoading={command.busy || extLoading} okText={editing ? '确 定' : '保 存'} cancelText="取 消" styles={{ body: { overflow: 'auto' } }}>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    {command.fieldErrors.name && <div className="kgd-banner kgd-field-error">{command.fieldErrors.name}</div>}
    {command.fieldErrors.unit_id && <div className="kgd-banner kgd-field-error">{command.fieldErrors.unit_id}</div>}
    <div className="goods-grid">
      <Field label="商品编号"><Input value={code} placeholder="请填写，忽略将自动生成" onChange={(event) => setCode(event.target.value)} /></Field>
      <Field label="商品名" required><div className={command.fieldErrors.name ? 'kgd-field-error' : undefined}><Input value={name} onChange={(event) => setName(event.target.value)} /></div></Field>
      <Field label="类别"><div className="goods-with-gear"><TreeSelect allowClear showSearch treeNodeFilterProp="title" placeholder="请选择" value={categoryId || undefined} treeData={treeData(buildTree(categories.data?.items ?? []))} onChange={(value) => setCategoryId(value ?? '')} /><Button aria-label="管理类别" icon={<SettingOutlined />} onClick={() => setCategoryOpen(true)} /></div></Field>
      <Field label="单位" required><div className={command.fieldErrors.unit_id ? 'kgd-field-error goods-with-gear' : 'goods-with-gear'}><Select allowClear showSearch optionFilterProp="label" placeholder="请选择" value={unitId || undefined} options={unitRows.map((item) => ({ value: String(item.id), label: item.name }))} onChange={(value) => setUnitId(value ?? '')} /><Button aria-label="管理单位" icon={<SettingOutlined />} onClick={() => setUnitOpen(true)} /></div></Field>
      <Field label="销售单价"><Input aria-label="销售单价" className="goods-num" value={sale} onChange={(event) => applySale(event.target.value)} /></Field>
      <Field label="成本单价"><Input className="goods-num" value={cost} onChange={(event) => setCost(decimalInput(event.target.value, 5))} /></Field>
      <Field label="售后佣金" hint={hints.commission}><div className="goods-pair"><Input aria-label="售后佣金元" className="goods-num" suffix="元" value={amount} onChange={(event) => applyAmount(event.target.value)} /><Input aria-label="售后佣金比例" className="goods-num" suffix="%" value={rate} onChange={(event) => applyRate(event.target.value)} /></div></Field>
      <Field label="商品来源" hint={hints.source}><Select className="goods-source" popupMatchSelectWidth style={{ width: '100%' }} allowClear placeholder="请选择" value={source || undefined} options={sourceOptions.map((item) => ({ value: item, label: item }))} onChange={(value) => setSource(value ?? '')} /></Field>
      <Field label="规格"><Input value={spec} onChange={(event) => setSpec(event.target.value)} /></Field>
      <Field label="检验规范"><Select allowClear showSearch filterOption={false} placeholder="输入关键词，在查询结果中选中" value={inspectionId || undefined} options={specOptions.map((item) => ({ value: item.id, label: item.name }))} notFoundContent="暂无数据" onSearch={(value) => void searchSpecs(value)} onFocus={() => void searchSpecs('')} onChange={(value, option) => { setInspectionId(value ?? ''); setInspectionName(!Array.isArray(option) && option ? String(option.label) : ''); }} /></Field>
      <Field label="呆滞警告值" hint={hints.stale}><Input className="goods-num" value={stale} onChange={(event) => setStale(decimalInput(event.target.value, 5))} /></Field>
      <Field label="库存上限警告值" hint={hints.upper}><Input className="goods-num" value={upper} onChange={(event) => setUpper(decimalInput(event.target.value, 5))} /></Field>
      <Field label="库存下限警告值" hint={hints.lower}><Input className="goods-num" value={lower} onChange={(event) => setLower(decimalInput(event.target.value, 5))} /></Field>
    </div>
    <div className="goods-block" onPaste={(event) => { const list = [...event.clipboardData.files]; if (list.length) { event.preventDefault(); takeFiles(list, true); } }}>
      <div>商品图片 <span className="kgd-muted">建议图片比例1:1</span></div>
      <div className="goods-upload" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); takeFiles(event.dataTransfer.files, true); }} onClick={() => document.getElementById('goods-image-input')?.click()}>上传图片<br />支持粘贴和拖拽上传</div>
      <input id="goods-image-input" hidden type="file" accept="image/png,image/jpeg" multiple onChange={(event) => { if (event.target.files) takeFiles(event.target.files, true); event.target.value = ''; }} />
      <div className="goods-thumbs">{images.map((id) => <div className="goods-thumb" key={id}><AttachmentImage id={id} size={72} /><button aria-label="删除图片" onClick={() => setImages((current) => current.filter((item) => item !== id))}>×</button></div>)}{pendingImages.map((file, index) => <div className="goods-thumb" key={`${file.name}${index}`}><img alt="" src={URL.createObjectURL(file)} /><button aria-label="删除图片" onClick={() => setPendingImages((current) => current.filter((_, item) => item !== index))}>×</button></div>)}</div>
    </div>
    <div className="goods-block" onPaste={(event) => { const list = [...event.clipboardData.files]; if (list.length) { event.preventDefault(); takeFiles(list, false); } }}>
      <div>附件</div>
      <div className="goods-upload" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); takeFiles(event.dataTransfer.files, false); }} onClick={() => document.getElementById('goods-file-input')?.click()}>选择文件<br />Ctrl+v 粘贴或拖拽文件到此处</div>
      <input id="goods-file-input" hidden type="file" multiple onChange={(event) => { if (event.target.files) takeFiles(event.target.files, false); event.target.value = ''; }} />
      <div>{files.map((file) => <div className="goods-file-row" key={file.id}><span className="goods-file-name">{file.filename}</span><span className="goods-file-ops"><button type="button" className="kgd-link" onClick={() => { void fetch(`/api/attachments/${file.id}/content`, { credentials: 'same-origin' }).then(async (response) => { if (!response.ok) { command.setError('附件无法预览'); return; } await openPreview(file.filename, await response.blob()); }); }}>预览</button><button type="button" className="kgd-link" onClick={() => setFiles((current) => current.filter((item) => item.id !== file.id))}>删除</button></span></div>)}{pendingFiles.map((file, index) => <div className="goods-file-row" key={`${file.name}${index}`}><span className="goods-file-name">{file.name}</span><span className="goods-file-ops"><button type="button" className="kgd-link" onClick={() => void openPreview(file.name, file)}>预览</button><button type="button" className="kgd-link" onClick={() => setPendingFiles((current) => current.filter((_, item) => item !== index))}>删除</button></span></div>)}</div>
    </div>
    <div className="goods-block"><div>备注</div><Input.TextArea value={remark} maxLength={255} showCount rows={3} onChange={(event) => setRemark(event.target.value)} /></div>
    <div className="goods-block">
      <div>商品简介</div>
      <div className="rich-toolbar">
        <button type="button" title="加粗" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('bold')}><BoldOutlined /></button>
        <button type="button" title="斜体" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('italic')}><ItalicOutlined /></button>
        <button type="button" title="下划线" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('underline')}><UnderlineOutlined /></button>
        <button type="button" title="删除线" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('strikeThrough')}><StrikethroughOutlined /></button>
        <button type="button" title="引用" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('formatBlock', 'blockquote')}>引用</button>
        <button type="button" title="代码块" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('formatBlock', 'pre')}><CodeOutlined /></button>
        <button type="button" title="H1" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('formatBlock', 'h1')}>H1</button>
        <button type="button" title="H2" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('formatBlock', 'h2')}>H2</button>
        <button type="button" title="有序" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('insertOrderedList')}><OrderedListOutlined /></button>
        <button type="button" title="无序" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('insertUnorderedList')}><UnorderedListOutlined /></button>
        <button type="button" title="下标" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('subscript')}>X₂</button>
        <button type="button" title="上标" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('superscript')}>X²</button>
        <button type="button" title="减少缩进" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('outdent')}>减少缩进</button>
        <button type="button" title="增加缩进" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('indent')}>增加缩进</button>
        <button type="button" title="文字方向" onMouseDown={(event) => event.preventDefault()} onClick={() => { const node = rich.current; if (node) node.dir = node.dir === 'rtl' ? 'ltr' : 'rtl'; }}>文字方向</button>
        <select title="字号" defaultValue="10px" onChange={(event) => exec('fontSize', event.target.value === '10px' ? '1' : event.target.value === '14px' ? '3' : '5')}><option>10px</option><option>14px</option><option>18px</option></select>
        <input title="文字颜色" type="color" onChange={(event) => exec('foreColor', event.target.value)} />
        <input title="背景色" type="color" onChange={(event) => exec('hiliteColor', event.target.value)} />
        <select title="字体" defaultValue="宋体" onChange={(event) => exec('fontName', event.target.value)}><option>宋体</option><option>黑体</option><option>微软雅黑</option></select>
        <button type="button" title="左对齐" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('justifyLeft')}><AlignLeftOutlined /></button>
        <button type="button" title="居中" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('justifyCenter')}><AlignCenterOutlined /></button>
        <button type="button" title="右对齐" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('justifyRight')}><AlignRightOutlined /></button>
        <button type="button" title="图片" onMouseDown={(event) => event.preventDefault()} onClick={() => { const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg'; input.onchange = () => { const file = input.files?.[0]; if (!file) return; void fileBase64(file).then((data) => exec('insertImage', `data:${file.type};base64,${data}`)); }; input.click(); }}><PictureOutlined /></button>
        <button type="button" title="清除格式" onMouseDown={(event) => event.preventDefault()} onClick={() => exec('removeFormat')}>清除格式</button>
      </div>
      <div ref={rich} className="rich-body" contentEditable data-placeholder="请输入内容" onInput={() => setIntro(rich.current?.innerHTML ?? '')} />
    </div>
    <ProductExtensions product={editing} session={session} writable saving={command.busy} onExpired={onExpired} onDraft={setExtension} onLoading={setExtLoading} />
    <Modal title="商品类别" open={categoryOpen} width={760} onCancel={() => setCategoryOpen(false)} onOk={() => setCategoryOpen(false)} okText="确定" cancelText="取消"><CategoryBoard kind="goods" /></Modal>
    <Modal title="单位管理" open={unitOpen} width={640} onCancel={() => setUnitOpen(false)} footer={<Button type="primary" onClick={() => setUnitOpen(false)}>确定</Button>}>
      {command.error && <div className="kgd-banner">{command.error}</div>}
      <div className="kgd-toolbar"><Input style={{ width: 180 }} placeholder="单位" value={unitQuery} onChange={(event) => setUnitQuery(event.target.value)} /><Button type="primary" onClick={() => setUnitKeyword(unitQuery)}>查询</Button><Button onClick={() => { setUnitQuery(''); setUnitKeyword(''); }}>清空</Button><Button type="primary" onClick={() => { setUnitErr(''); setUnitDraft({ name: '' }); }}>+新增</Button></div>
      <table style={{ width: '100%' }}><thead><tr><th style={{ textAlign: 'left' }}>排序</th><th style={{ textAlign: 'left' }}>单位</th><th style={{ textAlign: 'left' }}>操作</th></tr></thead><tbody>
        {unitRows.map((unit) => <tr key={String(unit.id)} draggable onDragStart={() => setDragId(String(unit.id))} onDragOver={(event) => event.preventDefault()} onDrop={() => void reorderUnits(String(unit.id))}><td>☰</td><td>{unit.name}</td><td><Button type="link" onClick={() => { setUnitErr(''); setUnitDraft({ id: String(unit.id), name: unit.name, version: unit.version }); }}>修改</Button><Button type="link" danger onClick={() => void removeUnit(String(unit.id))}>删除</Button></td></tr>)}
      </tbody></table>
    </Modal>
    <Modal title={unitDraft?.id ? '修改单位' : '新增单位'} open={!!unitDraft} onCancel={() => { setUnitErr(''); setUnitDraft(null); }} onOk={() => void saveUnit()} okText="确定" cancelText="取消" confirmLoading={command.busy}>{unitErr ? <div className="kgd-banner kgd-field-error">{unitErr}</div> : null}<Input placeholder="单位" value={unitDraft?.name ?? ''} onChange={(event) => setUnitDraft((current) => current ? { ...current, name: event.target.value } : current)} /></Modal>
    <Modal title={preview?.name || '预览'} open={!!preview} footer={null} onCancel={closePreview}>{preview?.image ? <img className="goods-preview-img" alt={preview.name} src={preview.url} /> : preview?.text != null ? <pre>{preview.text}</pre> : preview ? <a href={preview.url} target="_blank" rel="noreferrer">打开文件</a> : null}</Modal>
  </Modal>;
}
