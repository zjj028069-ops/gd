import { useEffect, useRef, useState } from 'react';
import { App, Button, Input, InputNumber, Popover, Select, Switch } from 'antd';
import { AlignLeftOutlined, BoldOutlined, HighlightOutlined, ItalicOutlined, PictureOutlined, RedoOutlined, SearchOutlined, SettingOutlined, StrikethroughOutlined, TableOutlined, UndoOutlined } from '@ant-design/icons';
import { apiRequest } from '../../api';
import { useKgd } from '../context';
import {
  OUTBOUND_COLUMNS, RETURN_COLUMNS, STATEMENT_GROUPS, blocksToFlow, buildStatementContext, editorHtml, openFlowPrint, paperLabel, previewHtml,
  type FlowContext, type FlowNode, type FlowRun,
} from './flow';
import type { LayoutBlock, LayoutDoc } from './index';

type Draft = { id?: string; name: string; content: LayoutDoc; readonly: boolean };
type Sample = { id: string; code: string; name: string; period: string; ctx: FlowContext };

function failText(failure: unknown) {
  return failure instanceof Error ? failure.message : '操作失败';
}

function newId() {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function cssColor(value: string) {
  const raw = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  const matched = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!matched) return undefined;
  const hex = (part: string) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0');
  return `#${hex(matched[1] ?? '0')}${hex(matched[2] ?? '0')}${hex(matched[3] ?? '0')}`;
}

function runsOf(root: HTMLElement): FlowRun[] {
  const runs: FlowRun[] = [];
  const walk = (node: Node, style: Omit<FlowRun, 'text'>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text) runs.push({ ...style, text });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.classList.contains('pf-chip')) {
      const field = node.dataset.field || node.textContent || '';
      if (field) runs.push({ ...style, text: field, field });
      return;
    }
    const next = { ...style };
    const tag = node.tagName;
    if (tag === 'B' || tag === 'STRONG' || node.style.fontWeight === 'bold' || Number(node.style.fontWeight) >= 600) next.bold = true;
    if (tag === 'I' || tag === 'EM' || node.style.fontStyle === 'italic') next.italic = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || node.style.textDecoration.includes('line-through')) next.strike = true;
    const color = cssColor(node.getAttribute('color') || node.style.color || '');
    const bg = cssColor(node.style.backgroundColor || '');
    if (color) next.color = color;
    if (bg && bg !== '#ffffff') next.bg = bg;
    for (const child of node.childNodes) walk(child, next);
  };
  for (const child of root.childNodes) walk(child, {});
  const merged: FlowRun[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.field && !run.field && prev.bold === run.bold && prev.italic === run.italic && prev.strike === run.strike && prev.color === run.color && prev.bg === run.bg) prev.text += run.text;
    else merged.push({ ...run });
  }
  return merged.filter((run) => run.text.trim() || run.field);
}

function readFlow(root: HTMLElement | null): FlowNode[] {
  if (!root) return [];
  const nodes: FlowNode[] = [];
  const visit = (el: HTMLElement) => {
    if (el.tagName === 'TABLE') {
      const columns = [...el.querySelectorAll('th')].map((cell) => (cell.textContent || '').trim()).filter(Boolean);
      const source = el.dataset.source === '出库明细' || el.dataset.source === '退货明细' ? el.dataset.source : '';
      if (columns.length) nodes.push({ id: el.dataset.id || newId(), type: 'table', source, columns });
      return;
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || '';
      if (src.startsWith('data:image/')) nodes.push({ id: el.dataset.id || newId(), type: 'image', src });
      return;
    }
    if (el.classList.contains('pf-chip')) {
      const field = el.dataset.field || '';
      if (field) nodes.push({ id: newId(), type: 'paragraph', runs: [{ text: field, field }] });
      return;
    }
    const block = ['P', 'H1', 'H2', 'H3', 'LI'].includes(el.tagName) || (el.tagName === 'DIV' && !el.querySelector('table, img'));
    if (block) {
      for (const image of el.querySelectorAll('img')) visit(image);
      const runs = runsOf(el);
      if (runs.length) {
        const align = el.style.textAlign === 'center' || el.style.textAlign === 'right' ? el.style.textAlign : undefined;
        nodes.push({ id: el.dataset.id || newId(), type: 'paragraph', ...(align ? { align } : {}), runs });
      }
      return;
    }
    let loose = '';
    const flush = () => {
      if (!loose.trim()) { loose = ''; return; }
      nodes.push({ id: newId(), type: 'paragraph', runs: [{ text: loose }] });
      loose = '';
    };
    for (const child of el.childNodes) {
      if (child instanceof HTMLElement) { flush(); visit(child); }
      else if (child.nodeType === Node.TEXT_NODE) loose += child.textContent || '';
    }
    flush();
  };
  for (const child of root.childNodes) {
    if (child instanceof HTMLElement) visit(child);
    else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) nodes.push({ id: newId(), type: 'paragraph', runs: [{ text: child.textContent }] });
  }
  return nodes;
}

function initialNodes(content: LayoutDoc): FlowNode[] {
  if (content.flow?.length) return content.flow;
  if (content.blocks?.length) return blocksToFlow(content.blocks as LayoutBlock[]);
  return [];
}

export function StatementDesigner({ objectKey, draft, onClose, onSaved }: { objectKey: string; draft: Draft; onClose: () => void; onSaved: () => void }) {
  const { session } = useKgd();
  const { message } = App.useApp();
  const editorRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const history = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const [name, setName] = useState(draft.name);
  const [paper, setPaper] = useState<'A4' | 'A5'>(draft.content.paper === 'A5' ? 'A5' : 'A4');
  const [margin, setMargin] = useState(draft.content.margin_mm ?? 12);
  const [footerOn, setFooterOn] = useState(draft.content.footer_on === true);
  const [query, setQuery] = useState('');
  const [find, setFind] = useState('');
  const [zoom, setZoom] = useState(0.72);
  const [flow, setFlow] = useState<FlowNode[]>(() => initialNodes(draft.content));
  const [footer, setFooter] = useState<FlowNode[]>(() => draft.content.footer ?? []);
  const [sample, setSample] = useState<Sample | null>(null);
  const [busy, setBusy] = useState(false);
  const [gear, setGear] = useState(false);
  const footerReady = useRef(false);

  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    root.innerHTML = editorHtml(initialNodes(draft.content));
    history.current = [root.innerHTML];
  }, [draft.content]);

  useEffect(() => {
    if (!footerRef.current || footerReady.current) return;
    footerRef.current.innerHTML = editorHtml(draft.content.footer ?? []);
    footerReady.current = true;
  }, [draft.content.footer]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const period of ['本月', '本季度', '本年']) {
        try {
          const list = await apiRequest<{ items: Array<Record<string, unknown>> }>(`/api/biz-reports/sales?period=${encodeURIComponent(period)}&debt=全部`);
          const items = list.items ?? [];
          if (!items.length) continue;
          const row = items[Math.floor(Math.random() * items.length)]!;
          const id = String(row.id ?? '');
          const [outbound, returns] = await Promise.all([
            apiRequest<{ items: Array<Record<string, string>> }>(`/api/biz-reports/sales/${encodeURIComponent(id)}/outbound?period=${encodeURIComponent(period)}`),
            apiRequest<{ items: Array<Record<string, string>> }>(`/api/biz-reports/sales/${encodeURIComponent(id)}/returns?period=${encodeURIComponent(period)}`),
          ]);
          if (!alive) return;
          setSample({
            id,
            code: String(row.customer_code ?? ''),
            name: String(row.customer_name ?? ''),
            period,
            ctx: buildStatementContext(row, outbound.items ?? [], returns.items ?? [], { period, user: session.user.display_name, company: session.tenant.name }),
          });
          return;
        } catch {
          if (!alive) return;
        }
      }
    })();
    return () => { alive = false; };
  }, [session.tenant.name, session.user.display_name]);

  function sync() {
    setFlow(readFlow(editorRef.current));
    if (footerOn) setFooter(readFlow(footerRef.current));
  }
  function remember() {
    const html = editorRef.current?.innerHTML ?? '';
    if (history.current[history.current.length - 1] === html) return;
    history.current.push(html);
    if (history.current.length > 50) history.current.shift();
    future.current = [];
  }
  function restore(html: string) {
    if (!editorRef.current) return;
    editorRef.current.innerHTML = html;
    sync();
  }
  function undo() {
    if (history.current.length < 2) return;
    const current = history.current.pop()!;
    future.current.push(current);
    restore(history.current[history.current.length - 1] ?? '<p><br></p>');
  }
  function redo() {
    const next = future.current.pop();
    if (!next || !editorRef.current) return;
    history.current.push(next);
    restore(next);
  }
  function focusEditor() {
    editorRef.current?.focus();
  }
  function command(name: string, value?: string) {
    if (draft.readonly) return;
    focusEditor();
    document.execCommand(name, false, value);
    remember();
    sync();
  }
  function insertHtml(html: string) {
    if (draft.readonly) return;
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    const selection = window.getSelection();
    const inside = !!selection && selection.rangeCount > 0 && root.contains(selection.anchorNode);
    if (!inside) {
      let paragraph = root.querySelector('p,h1,h2,h3');
      if (!(paragraph instanceof HTMLElement)) {
        paragraph = document.createElement('p');
        paragraph.innerHTML = '<br>';
        root.appendChild(paragraph);
      }
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    document.execCommand('insertHTML', false, html);
    remember();
    sync();
  }
  function insertField(field: string) {
    insertHtml(`<span class="pf-chip" contenteditable="false" data-field="${field}">${field}</span>`);
  }
  function insertTable(source: '' | '出库明细' | '退货明细') {
    const columns = source === '退货明细' ? RETURN_COLUMNS : source === '出库明细' ? OUTBOUND_COLUMNS : ['客户编号', '客户', '联系人'];
    const head = columns.map((column) => `<th>${column}</th>`).join('');
    insertHtml(`<table class="pf-table" contenteditable="false" data-id="${newId()}" data-source="${source}"><thead><tr>${head}</tr></thead><tbody><tr><td colspan="${columns.length}">明细在预览中展开</td></tr></tbody></table><p><br></p>`);
  }
  function onImage(file: File | undefined) {
    if (!file) return;
    if (file.size > 120000) {
      message.error('图片请小于 120KB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : '';
      if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(src)) {
        message.error('只支持 png、jpeg、gif、webp');
        return;
      }
      insertHtml(`<img data-id="${newId()}" class="pf-img" alt="" src="${src}" />`);
    };
    reader.readAsDataURL(file);
  }
  function findText() {
    const root = editorRef.current;
    const needle = find.trim();
    if (!root || !needle) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = (node.textContent || '').indexOf(needle);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        (node.parentElement)?.scrollIntoView({ block: 'nearest' });
        return;
      }
      node = walker.nextNode();
    }
    message.warning('没有找到');
  }
  function currentFlow() {
    const nextFlow = readFlow(editorRef.current);
    const nextFooter = footerOn ? readFlow(footerRef.current) : [];
    return { nextFlow, nextFooter };
  }
  function previewNow() {
    const { nextFlow, nextFooter } = currentFlow();
    if (!nextFlow.length && !nextFooter.length) {
      message.error('画布至少要有一个组件');
      return;
    }
    const ctx = sample?.ctx ?? { values: {}, tables: {} };
    const note = sample ? `预览数据：${sample.code} ${sample.name} · ${sample.period}` : '预览数据：暂无对账单';
    const ok = openFlowPrint({ paper, marginMm: margin, flow: nextFlow, footer: nextFooter, title: name.trim() || '销售对账单打印模板', ctx, note });
    if (!ok) message.warning('浏览器拦截了打印窗口，请允许弹出窗口后重试。');
  }
  async function save() {
    if (draft.readonly) return;
    const trimmed = name.trim();
    if (!trimmed) {
      message.error('请填写模板名称');
      return;
    }
    const { nextFlow, nextFooter } = currentFlow();
    if (!nextFlow.length && !nextFooter.length) {
      message.error('画布至少要有一个组件');
      return;
    }
    setBusy(true);
    try {
      const content = { paper, margin_mm: margin, footer_on: footerOn, flow: nextFlow, footer: nextFooter, blocks: [] as LayoutBlock[], builtin: false };
      if (draft.id) await apiRequest(`/api/print-templates/${draft.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body: { name: trimmed, content } });
      else await apiRequest('/api/print-templates', { method: 'POST', csrfToken: session.csrf_token, body: { object_key: objectKey, name: trimmed, content } });
      message.success('已保存');
      onSaved();
    } catch (failure) {
      message.error(failText(failure));
    } finally {
      setBusy(false);
    }
  }
  const ctx = sample?.ctx ?? { values: {}, tables: {} };
  const sheet = `${previewHtml(flow, ctx)}${footerOn && footer.length ? `<div class="pf-foot">${previewHtml(footer, ctx)}</div>` : ''}`;
  const keyword = query.trim();
  const groups = STATEMENT_GROUPS.map((group) => ({ ...group, items: keyword ? group.items.filter((item) => item.includes(keyword)) : group.items })).filter((group) => group.items.length);

  return <div className="print-studio" role="dialog" aria-label="打印模板设计器">
    <div className="print-studio-bar">
      <Button autoInsertSpace={false} onClick={onClose}>返回</Button>
      <Input aria-label="模板名称" className="print-studio-name" value={name} disabled={draft.readonly} maxLength={40} placeholder="请输入模板名" onChange={(event) => setName(event.target.value)} />
      <span className="print-studio-switch"><Switch aria-label="开启表尾" checked={footerOn} disabled={draft.readonly} onChange={setFooterOn} /><span>开启表尾</span></span>
      <Select aria-label="纸张" className="print-studio-paper" value={paper} disabled={draft.readonly} options={[{ value: 'A4', label: 'A4' }, { value: 'A5', label: 'A5' }]} onChange={(value: 'A4' | 'A5') => setPaper(value)} />
      <Popover open={gear} onOpenChange={setGear} trigger="click" content={<div className="print-margin"><span>页边距（毫米）</span><div className="print-margin-row"><Button aria-label="减小页边距" disabled={draft.readonly || margin <= 0} onClick={() => setMargin((value) => Math.max(0, value - 1))}>−</Button><InputNumber aria-label="页边距" min={0} max={40} precision={0} controls={false} value={margin} disabled={draft.readonly} onChange={(value) => setMargin(typeof value === 'number' ? value : margin)} /><Button aria-label="增大页边距" disabled={draft.readonly || margin >= 40} onClick={() => setMargin((value) => Math.min(40, value + 1))}>+</Button></div></div>}>
        <Button aria-label="页面设置" type="text" icon={<SettingOutlined />} />
      </Popover>
      {!draft.readonly && <Button autoInsertSpace={false} className="print-studio-save" loading={busy} onClick={() => void save()}>保存模板</Button>}
    </div>
    <div className="print-studio-body">
      <aside className="print-fields">
        <Input aria-label="输入字段名搜索" allowClear prefix={<SearchOutlined />} placeholder="输入字段名搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
        {groups.map((group) => <section key={group.title} className="print-field-sec">
          <h3>{group.title}</h3>
          <div className="print-chips">
            {group.items.map((item) => <button key={`${group.title}-${item}`} type="button" className="print-chip" disabled={draft.readonly} onMouseDown={(event) => event.preventDefault()} onClick={() => group.kind === 'table' ? insertTable(item === '退货明细' ? '退货明细' : '出库明细') : insertField(item)}>{item}</button>)}
          </div>
        </section>)}
      </aside>
      <div className="print-editor-col">
        <div className="print-toolbar">
          <Select aria-label="段落" defaultValue="p" style={{ width: 88 }} disabled={draft.readonly} options={[{ value: 'p', label: '段落' }, { value: 'h2', label: '标题' }, { value: 'h3', label: '副标题' }]} onChange={(value) => command('formatBlock', `<${value}>`)} />
          <Button aria-label="撤销" type="text" icon={<UndoOutlined />} disabled={draft.readonly} onClick={undo} />
          <Button aria-label="重做" type="text" icon={<RedoOutlined />} disabled={draft.readonly} onClick={redo} />
          <Button aria-label="加粗" type="text" icon={<BoldOutlined />} disabled={draft.readonly} onMouseDown={(event) => event.preventDefault()} onClick={() => command('bold')} />
          <Button aria-label="斜体" type="text" icon={<ItalicOutlined />} disabled={draft.readonly} onMouseDown={(event) => event.preventDefault()} onClick={() => command('italic')} />
          <label className="print-color" aria-label="字体颜色"><span>A</span><input aria-label="字体颜色值" type="color" disabled={draft.readonly} defaultValue="#222222" onChange={(event) => command('foreColor', event.target.value)} /></label>
          <label className="print-color" aria-label="突出显示"><HighlightOutlined /><input aria-label="突出显示颜色" type="color" disabled={draft.readonly} defaultValue="#fff59d" onChange={(event) => command('hiliteColor', event.target.value)} /></label>
          <Button aria-label="删除线" type="text" icon={<StrikethroughOutlined />} disabled={draft.readonly} onMouseDown={(event) => event.preventDefault()} onClick={() => command('strikeThrough')} />
          <Button aria-label="插入表格" type="text" icon={<TableOutlined />} disabled={draft.readonly} onClick={() => insertTable('')} />
          <Button aria-label="插入图片" type="text" icon={<PictureOutlined />} disabled={draft.readonly} onClick={() => fileRef.current?.click()} />
          <input ref={fileRef} className="print-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { onImage(event.target.files?.[0]); event.target.value = ''; }} />
          <Popover trigger="click" content={<div className="print-find"><Input aria-label="查找内容" value={find} placeholder="查找" onChange={(event) => setFind(event.target.value)} onPressEnter={findText} /><Button autoInsertSpace={false} onClick={findText}>查找</Button></div>}>
            <Button aria-label="查找" type="text" icon={<SearchOutlined />} />
          </Popover>
          <Select aria-label="对齐" defaultValue="left" style={{ width: 96 }} disabled={draft.readonly} suffixIcon={<AlignLeftOutlined />} options={[{ value: 'left', label: '左对齐' }, { value: 'center', label: '居中' }, { value: 'right', label: '右对齐' }]} onChange={(value) => command(value === 'center' ? 'justifyCenter' : value === 'right' ? 'justifyRight' : 'justifyLeft')} />
        </div>
        <div ref={editorRef} className="print-canvas-edit" aria-label="段落画布" contentEditable={!draft.readonly} suppressContentEditableWarning onInput={() => { remember(); sync(); }} />
        <div className="print-footer-edit" hidden={!footerOn}>
          <b>表尾</b>
          <div ref={footerRef} className="print-canvas-edit" aria-label="表尾" contentEditable={!draft.readonly} suppressContentEditableWarning onInput={() => setFooter(readFlow(footerRef.current))} />
        </div>
      </div>
      <aside className="print-preview-pane">
        <div className="print-preview-hd"><span>{paperLabel(paper)}</span><Button type="primary" autoInsertSpace={false} onClick={previewNow}>打印预览</Button></div>
        <p className="print-preview-note">系统会随机选择一条销售对账单数据展示在下方的预览区域。</p>
        <div className="print-sheet-wrap">
          <div className="print-a4" aria-label="A4预览" data-preview-id={sample?.id ?? ''} data-preview-code={sample?.code ?? ''} data-preview-name={sample?.name ?? ''} style={{ width: paper === 'A5' ? '148mm' : '210mm', minHeight: paper === 'A5' ? '210mm' : '297mm', padding: `${margin}mm`, zoom }}>
            <div dangerouslySetInnerHTML={{ __html: sheet }} />
          </div>
        </div>
        <div className="print-zoom">
          <button type="button" aria-label="重置缩放" onClick={() => setZoom(0.72)}>○</button>
          <button type="button" aria-label="放大" onClick={() => setZoom((value) => Math.min(1.4, Math.round((value + 0.1) * 10) / 10))}>+</button>
          <button type="button" aria-label="缩小" onClick={() => setZoom((value) => Math.max(0.4, Math.round((value - 0.1) * 10) / 10))}>−</button>
        </div>
      </aside>
    </div>
  </div>;
}
