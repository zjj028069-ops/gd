import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Alert, App, Button, Input, InputNumber, Modal, Radio, Select, Table, Tag } from 'antd';
import { apiRequest } from '../../api';
import { useKgd } from '../context';
import { StatementDesigner } from './statement-designer';
import { printDocs, printLayout, type LayoutBlock, type LayoutDoc, type PrintDoc } from './index';

type PrintLayout = LayoutDoc & { builtin?: boolean };
type TemplateItem = { id: string; name: string; is_system: boolean; content: PrintLayout };
type TemplateList = { palette: string[]; items: TemplateItem[]; system_name: string };

function failText(failure: unknown) {
  return failure instanceof Error ? failure.message : '操作失败';
}

function cloneLayout(layout: PrintLayout): PrintLayout {
  const next = JSON.parse(JSON.stringify(layout)) as PrintLayout;
  next.builtin = false;
  return next;
}

function newId() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function nextY(blocks: LayoutBlock[]) {
  return Math.min(240, blocks.reduce((max, block) => Math.max(max, block.y + block.h), 8) + 4);
}

async function loadTemplates(objectKey: string) {
  return apiRequest<TemplateList>(`/api/print-templates?object_key=${encodeURIComponent(objectKey)}`);
}

function useTemplates(objectKey: string, open: boolean) {
  const [data, setData] = useState<TemplateList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const list = await loadTemplates(objectKey);
        if (!alive) return;
        setData(list);
      } catch (failure) {
        if (!alive) return;
        setError(failText(failure));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [objectKey, open, tick]);
  return { data, error, loading, reload: () => setTick((value) => value + 1) };
}

function Designer({
  objectKey, palette, draft, onClose, onSaved,
}: {
  objectKey: string;
  palette: string[];
  draft: { id?: string; name: string; content: PrintLayout; readonly: boolean };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { session } = useKgd();
  const { message } = App.useApp();
  const [name, setName] = useState(draft.name);
  const [content, setContent] = useState<PrintLayout>(draft.content);
  const [selected, setSelected] = useState(draft.content.blocks[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pageW = content.paper === 'A5' ? 148 : 210;
  const pageH = content.paper === 'A5' ? 210 : 297;
  const width = 480;
  const scale = width / pageW;
  const current = content.blocks.find((block) => block.id === selected) ?? null;

  function patchBlock(id: string, patch: Partial<LayoutBlock>) {
    setContent((prev) => ({ ...prev, blocks: prev.blocks.map((block) => block.id === id ? { ...block, ...patch } : block) }));
  }
  function addBlock(block: LayoutBlock) {
    setContent((prev) => ({ ...prev, blocks: [...prev.blocks, block] }));
    setSelected(block.id);
  }
  function addField(field: string) {
    addBlock({ id: newId(), type: 'field', field, x: 12, y: nextY(content.blocks), w: 90, h: 10 });
  }
  function addText() {
    addBlock({ id: newId(), type: 'text', text: '文本', x: 12, y: nextY(content.blocks), w: 80, h: 10 });
  }
  function addTable() {
    addBlock({ id: newId(), type: 'table', columns: palette.slice(0, 4), x: 12, y: nextY(content.blocks), w: 180, h: 36 });
  }
  function removeBlock(id: string) {
    if (content.blocks.length <= 1) {
      message.error('画布至少保留一个组件');
      return;
    }
    setContent((prev) => ({ ...prev, blocks: prev.blocks.filter((block) => block.id !== id) }));
  }
  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      message.error('请填写模板名称');
      return;
    }
    if (!content.blocks.length) {
      message.error('画布至少要有一个组件');
      return;
    }
    setBusy(true);
    try {
      const body = { name: trimmed, content: { ...content, builtin: false } };
      if (draft.id) await apiRequest(`/api/print-templates/${draft.id}`, { method: 'PATCH', csrfToken: session.csrf_token, body });
      else await apiRequest('/api/print-templates', { method: 'POST', csrfToken: session.csrf_token, body: { object_key: objectKey, ...body } });
      message.success('已保存');
      onSaved();
    } catch (failure) {
      message.error(failText(failure));
    } finally {
      setBusy(false);
    }
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>, block: LayoutBlock) {
    setSelected(block.id);
    if (draft.readonly) return;
    const origin = { x: block.x, y: block.y, px: event.clientX, py: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - origin.px) / scale;
      const dy = (ev.clientY - origin.py) / scale;
      patchBlock(block.id, {
        x: Math.max(0, Math.min(pageW - block.w, Math.round((origin.x + dx) * 10) / 10)),
        y: Math.max(0, Math.min(pageH - block.h, Math.round((origin.y + dy) * 10) / 10)),
      });
    };
    const up = () => {
      event.currentTarget.removeEventListener('pointermove', move);
      event.currentTarget.removeEventListener('pointerup', up);
    };
    event.currentTarget.addEventListener('pointermove', move);
    event.currentTarget.addEventListener('pointerup', up);
  }

  return <Modal
    title={draft.readonly ? '预览打印模板' : '编辑打印模板'}
    open
    width="96vw"
    style={{ top: 12 }}
    onCancel={onClose}
    destroyOnHidden
    footer={draft.readonly
      ? <Button autoInsertSpace={false} onClick={onClose}>关闭</Button>
      : <>
        <Button autoInsertSpace={false} onClick={onClose}>取消</Button>
        <Button autoInsertSpace={false} type="primary" loading={busy} onClick={() => void save()}>保存</Button>
      </>}
  >
    <div className="print-note">设计器标题、图标与细项控件原版未采到。画布可排版业务字段、文本和表格，并可设置纸张与页边距。</div>
    <div className="print-designer-name">
      <span>模板名称</span>
      <Input aria-label="模板名称" value={name} disabled={draft.readonly} maxLength={40} placeholder="请输入模板名称" onChange={(event) => setName(event.target.value)} />
    </div>
    <div className="print-designer">
      <div className="print-palette">
        <b>业务字段</b>
        <div className="print-note">字段对齐该对象的打印字段</div>
        {palette.map((field) => <Button key={field} block disabled={draft.readonly} onClick={() => addField(field)}>{field}</Button>)}
        <Button block disabled={draft.readonly} onClick={addText}>添加文本</Button>
        <Button block disabled={draft.readonly} onClick={addTable}>添加表格</Button>
        <div className="print-note">组件面板文案原版未采到</div>
      </div>
      <div className="print-canvas-wrap">
        <div className="print-note">画布预览</div>
        <div
          ref={canvasRef}
          className="print-canvas"
          aria-label="画布预览"
          style={{ width, height: pageH * scale, padding: content.margin_mm * scale }}
        >
          {content.blocks.map((block) => <div
            key={block.id}
            className={`print-block${block.id === selected ? ' on' : ''}`}
            style={{ left: block.x * scale, top: block.y * scale, width: block.w * scale, height: block.h * scale }}
            onPointerDown={(event) => onPointerDown(event, block)}
          >
            {block.type === 'text' ? block.text : block.type === 'field' ? `字段：${block.field}` : `表格：${(block.columns ?? []).join('、')}`}
          </div>)}
        </div>
      </div>
      <div className="print-settings">
        <b>纸张</b>
        <Select disabled={draft.readonly} value={content.paper} options={[{ value: 'A4', label: 'A4' }, { value: 'A5', label: 'A5' }]} onChange={(paper: 'A4' | 'A5') => setContent((prev) => ({ ...prev, paper }))} />
        <b>页边距（毫米）</b>
        <InputNumber disabled={draft.readonly} min={0} max={40} precision={0} value={content.margin_mm} onChange={(value) => setContent((prev) => ({ ...prev, margin_mm: typeof value === 'number' ? value : prev.margin_mm }))} />
        <div className="print-note">纸张与页边距原版未采到</div>
        {current && <>
          <b>当前组件</b>
          {current.type === 'text' && <Input aria-label="文本内容" disabled={draft.readonly} value={current.text ?? ''} maxLength={80} onChange={(event) => patchBlock(current.id, { text: event.target.value })} />}
          {current.type === 'field' && <div>业务字段：{current.field}</div>}
          {current.type === 'table' && <div>表格列：{(current.columns ?? []).join('、')}</div>}
          {!draft.readonly && <Button danger autoInsertSpace={false} onClick={() => removeBlock(current.id)}>删除此组件</Button>}
        </>}
      </div>
    </div>
  </Modal>;
}

export function PrintTemplateButton({ objectKey, label }: { objectKey: string; label: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button onClick={() => setOpen(true)}>{label}</Button>
    {open && <PrintTemplateManager objectKey={objectKey} onClose={() => setOpen(false)} />}
  </>;
}

function PrintTemplateManager({ objectKey, onClose }: { objectKey: string; onClose: () => void }) {
  const { session } = useKgd();
  const { message, modal } = App.useApp();
  const { data, error, loading, reload } = useTemplates(objectKey, true);
  const [design, setDesign] = useState<{ id?: string; name: string; content: PrintLayout; readonly: boolean } | null>(null);

  async function copyTemplate(item: TemplateItem) {
    try {
      await apiRequest(`/api/print-templates/${item.id}/copy`, { method: 'POST', csrfToken: session.csrf_token, body: {} });
      message.success('已复制');
      reload();
    } catch (failure) {
      message.error(failText(failure));
    }
  }
  function removeTemplate(item: TemplateItem) {
    modal.confirm({
      title: '删除模板',
      content: `确定删除「${item.name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await apiRequest(`/api/print-templates/${item.id}`, { method: 'DELETE', csrfToken: session.csrf_token, body: {} });
        reload();
      },
    });
  }
  function createTemplate() {
    if (objectKey === 'sales_statement') {
      setDesign({ name: '', content: { paper: 'A4', margin_mm: 12, blocks: [], flow: [], footer: [], footer_on: false }, readonly: false });
      return;
    }
    const system = data?.items.find((item) => item.is_system);
    if (!system) {
      message.error(error || '系统模板尚未加载');
      return;
    }
    setDesign({ name: '', content: cloneLayout(system.content), readonly: false });
  }

  return <>
    <Modal title="管理自定义打印模板" open keyboard={!design} onCancel={() => { if (!design) onClose(); }} footer={null} width={780} destroyOnHidden>
      <div className="print-manage-bar"><Button type="link" className="print-create" aria-label="创建模板" onClick={createTemplate}>+ 创建模板</Button></div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} />}
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        pagination={false}
        dataSource={data?.items ?? []}
        columns={[
          { title: '序号', width: 72, render: (_value, _row, index) => index + 1 },
          { title: '模版名称', dataIndex: 'name', render: (name: string, row: TemplateItem) => <span>{name}{row.is_system ? <> <Tag color="blue">系统模板</Tag></> : null}</span> },
          { title: '操作', width: 160, render: (_value, row: TemplateItem) => row.is_system ? <>
            <Button type="link" autoInsertSpace={false} onClick={() => void copyTemplate(row)}>复制</Button>
            {objectKey !== 'sales_statement' && <Button type="link" autoInsertSpace={false} onClick={() => setDesign({ id: row.id, name: row.name, content: row.content, readonly: true })}>预览</Button>}
          </> : <>
            <Button type="link" autoInsertSpace={false} onClick={() => setDesign({ id: row.id, name: row.name, content: row.content, readonly: false })}>编辑</Button>
            <Button type="link" danger autoInsertSpace={false} onClick={() => removeTemplate(row)}>删除</Button>
          </> },
        ]}
      />
    </Modal>
    {design && objectKey === 'sales_statement' && <StatementDesigner
      objectKey={objectKey}
      draft={design}
      onClose={() => setDesign(null)}
      onSaved={() => { setDesign(null); reload(); }}
    />}
    {design && objectKey !== 'sales_statement' && data && <Designer
      objectKey={objectKey}
      palette={data.palette}
      draft={design}
      onClose={() => setDesign(null)}
      onSaved={() => { setDesign(null); reload(); }}
    />}
  </>;
}

export function PrintPickModal({
  objectKey, title, docs, onClose,
}: {
  objectKey: string;
  title: string;
  docs: PrintDoc[] | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const open = !!docs?.length;
  const { data, error, loading } = useTemplates(objectKey, open);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    const system = data?.items.find((item) => item.is_system);
    if (system) setSelected(system.id);
  }, [data]);
  function print() {
    const item = data?.items.find((row) => row.id === selected);
    if (!item || !docs?.length) {
      message.error(error || '请选择打印模板');
      return;
    }
    const ok = item.is_system && item.content.builtin
      ? printDocs(docs, docs[0]?.title ?? item.name)
      : printLayout(docs, item.content, item.name);
    if (!ok) message.warning('浏览器拦截了打印窗口，请允许弹出窗口后重试。');
    else onClose();
  }
  return <Modal
    title={title}
    open={open}
    width={640}
    centered
    onCancel={onClose}
    destroyOnHidden
    styles={{ body: { minHeight: 120 } }}
    footer={<Button type="primary" size="large" autoInsertSpace={false} disabled={loading || !selected} onClick={print}>打印</Button>}
  >
    {error && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} />}
    <Radio.Group value={selected} onChange={(event) => setSelected(event.target.value)} className="print-pick-list">
      {(data?.items ?? []).map((item) => <Radio key={item.id} value={item.id}>
        {item.name}{item.is_system ? <> <Tag color="blue">系统模板</Tag></> : null}
      </Radio>)}
    </Radio.Group>
  </Modal>;
}
