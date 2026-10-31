import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Select, Switch, Tooltip } from 'antd';
import { BoldOutlined, ItalicOutlined, OrderedListOutlined, PictureOutlined, QuestionCircleOutlined, UnderlineOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { apiRequest } from '../../../api';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { showError, useCommand } from '../../kit';
import { downloadCsv } from '../../wage';
import { requestKey } from '../../../requestKey';

export type Row = { id: string; [key: string]: any };
export type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export function useR10() {
  const kgd = useKgd();
  const command = useCommand();
  const { message, modal } = App.useApp();
  async function act<T = unknown>(path: string, body: Record<string, unknown> = {}, method: Method = 'POST', ok: string | false = '已保存') {
    try {
      const result = await command.send<T>(path, body, method);
      if (ok) message.success(ok);
      return (result ?? ({} as T));
    } catch (failure) {
      message.error(showError(failure));
      return undefined;
    }
  }
  function confirmDelete(title: string, onOk: () => unknown, content = '删除后无法恢复，确定删除？') {
    modal.confirm({ title, content, okText: '确定', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => onOk() as Promise<void> | void });
  }
  return { ...kgd, ...command, act, message, modal, confirmDelete };
}

export function useList<T = Row>(path: string | null) {
  const { revision, onExpired } = useKgd();
  return useRemote<{ items: T[]; total?: number; [key: string]: unknown }>(path, revision, onExpired);
}

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '' || value === 'all') return;
    search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function dash(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

export function fmtTime(value: unknown, withSeconds = true) {
  if (!value) return '-';
  const text = String(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const local = date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return withSeconds ? local : local.slice(0, 16);
}

export function fmtDate(value: unknown) {
  if (!value) return '-';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return fmtTime(text).slice(0, 10);
}

export function totalText(count: number) {
  return `共${count}条数据`;
}

export function exportRows<T>(filename: string, columns: { title: string; text: (row: T) => string }[], rows: T[]) {
  downloadCsv(filename, columns.map((column) => column.title), rows.map((row) => columns.map((column) => column.text(row))));
}

export function Hint({ text }: { text: string }) {
  return <Tooltip title={text}><QuestionCircleOutlined style={{ color: '#999', marginLeft: 4 }} /></Tooltip>;
}

export function SettingFrame({ title, onSave, saving, children, back = true }: { title?: string; onSave?: () => void; saving?: boolean; children: ReactNode; back?: boolean }) {
  const navigate = useNavigate();
  return <div className="kgd-card">
    <div className="kgd-toolbar" style={{ justifyContent: 'space-between' }}>
      <b style={{ fontSize: 16 }}>{title}</b>
      <span style={{ display: 'flex', gap: 8 }}>
        {back && <Button onClick={() => navigate(-1)}>返回</Button>}
        {onSave && <Button type="primary" loading={saving} onClick={onSave}>保存</Button>}
      </span>
    </div>
    {children}
  </div>;
}

export function SettingSection({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ marginBottom: 20 }}>
    <h3 style={{ borderLeft: '3px solid #4184F4', paddingLeft: 8, fontSize: 15, margin: '12px 0' }}>{title}</h3>
    {children}
  </section>;
}

export function SettingItem({ label, desc, children }: { label: string; desc?: ReactNode; children: ReactNode }) {
  return <div className="kgd-setting-item" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 12, padding: '10px 0', borderBottom: '1px solid #f0f0f0', alignItems: 'start' }}>
    <span>{label}</span>
    <div>{children}{desc && <div className="kgd-muted" style={{ marginTop: 4 }}>{desc}</div>}</div>
  </div>;
}

export function SwitchItem({ label, desc, value, onChange }: { label: string; desc?: ReactNode; value: boolean; onChange: (value: boolean) => void }) {
  return <SettingItem label={label} desc={desc}><Switch checked={value} onChange={onChange} /></SettingItem>;
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function RichEditor({ value, onChange, minHeight = 320 }: { value: string; onChange: (html: string) => void; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);
  useEffect(() => {
    if (!ref.current || seeded.current) return;
    if (value) { ref.current.innerHTML = value; seeded.current = true; }
  }, [value]);
  function exec(command: string, arg?: string) {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    onChange(ref.current?.innerHTML ?? '');
  }
  const tool = (title: string, node: ReactNode, run: () => void) => <button type="button" title={title} onMouseDown={(event) => event.preventDefault()} onClick={run}>{node}</button>;
  return <div className="kgd-rich">
    <div className="rich-tools" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: 4, border: '1px solid #d9d9d9', borderBottom: 0 }}>
      {tool('加粗', <BoldOutlined />, () => exec('bold'))}
      {tool('斜体', <ItalicOutlined />, () => exec('italic'))}
      {tool('下划线', <UnderlineOutlined />, () => exec('underline'))}
      {tool('有序', <OrderedListOutlined />, () => exec('insertOrderedList'))}
      {tool('无序', <UnorderedListOutlined />, () => exec('insertUnorderedList'))}
      {tool('图片', <PictureOutlined />, () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/png,image/jpeg';
        input.onchange = () => { const file = input.files?.[0]; if (file) void fileBase64(file).then((data) => exec('insertImage', `data:${file.type};base64,${data}`)); };
        input.click();
      })}
    </div>
    <div ref={ref} className="rich-body" style={{ minHeight }} contentEditable suppressContentEditableWarning data-placeholder="请输入内容" onInput={() => onChange(ref.current?.innerHTML ?? '')} />
  </div>;
}

export type PendingFile = { key: string; file: File };
export type SavedFile = { id: string; filename: string; mime?: string; byte_size?: number };

const allowedMime = new Set(['image/png', 'image/jpeg', 'application/pdf', 'text/plain']);

export function mimeOf(file: File) {
  if (allowedMime.has(file.type)) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.txt')) return 'text/plain';
  return '';
}

export const infoFileHref = (id: string) => `/api/info/files/${id}/content`;

export async function uploadInfoFiles(files: PendingFile[], csrfToken: string) {
  const saved: SavedFile[] = [];
  for (const item of files) {
    const mime = mimeOf(item.file);
    if (!mime) throw new Error(`附件「${item.file.name}」格式不支持，只支持 PNG、JPG、PDF、TXT`);
    if (item.file.size > 2 * 1024 * 1024) throw new Error(`附件「${item.file.name}」超过2MB`);
    const result = await apiRequest<{ file: SavedFile }>('/api/info/files', { method: 'POST', csrfToken, body: { filename: item.file.name, mime, content_base64: await fileBase64(item.file) } });
    saved.push(result.file);
  }
  return saved;
}

export function AttachmentField({ pending, onPending, saved = [], onRemoveSaved, max = 9, accept = '.png,.jpg,.jpeg,.pdf,.txt' }: { pending: PendingFile[]; onPending: (files: PendingFile[]) => void; saved?: SavedFile[]; onRemoveSaved?: (id: string) => void; max?: number; accept?: string }) {
  const { message } = App.useApp();
  const input = useRef<HTMLInputElement>(null);
  const count = pending.length + saved.length;
  function add(list: FileList | File[] | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    if (count + files.length > max) { message.warning(`附件最多${max}个`); return; }
    onPending([...pending, ...files.map((file) => ({ key: requestKey(), file }))]);
  }
  return <div>
    <div tabIndex={0} role="button" onClick={() => input.current?.click()} onPaste={(event) => add(event.clipboardData.files)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); add(event.dataTransfer.files); }} style={{ border: '1px dashed #d9d9d9', padding: 12, textAlign: 'center', cursor: 'pointer', color: '#666' }}>
      选择文件 Ctrl+v 粘贴或拖拽文件到此处
    </div>
    <input ref={input} type="file" hidden multiple accept={accept} onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
    {saved.map((file) => <div key={file.id} style={{ display: 'flex', gap: 8, marginTop: 4 }}><a href={infoFileHref(file.id)} target="_blank" rel="noreferrer">{file.filename}</a>{onRemoveSaved && <button type="button" className="kgd-link" onClick={() => onRemoveSaved(file.id)}>删除</button>}</div>)}
    {pending.map((item) => <div key={item.key} style={{ display: 'flex', gap: 8, marginTop: 4 }}><span>{item.file.name}</span><button type="button" className="kgd-link" onClick={() => onPending(pending.filter((file) => file.key !== item.key))}>移除</button></div>)}
  </div>;
}

export function MemberPick({ value, onChange, multiple, placeholder = '输入关键词，在查询结果中选中', style }: { value: string | string[]; onChange: (value: any) => void; multiple?: boolean; placeholder?: string; style?: React.CSSProperties }) {
  const members = useList<{ id: string; display_name: string }>('/api/team-members');
  const options = (members.data?.items ?? []).map((item) => ({ value: item.id, label: item.display_name }));
  return <Select mode={multiple ? 'multiple' : undefined} showSearch optionFilterProp="label" allowClear style={{ width: '100%', ...style }} placeholder={placeholder} value={multiple ? (value as string[]) : ((value as string) || undefined)} options={options} onChange={(next) => onChange(multiple ? (next ?? []) : (next ?? ''))} />;
}

export function memberNameMap(items: { id: string; display_name: string }[] | undefined) {
  return new Map((items ?? []).map((item) => [item.id, item.display_name]));
}

export function Counter({ value, max }: { value: string; max: number }) {
  return <div className="kgd-muted" style={{ textAlign: 'right' }}>{value.length}/{max}</div>;
}

export const sourceText: Record<string, string> = { manufactured: '自产', purchased: '外购', outsourced: '外协加工', out: '外协加工' };
export const sourceColor: Record<string, string> = { 自产: 'green', 外购: 'blue', 外协加工: 'purple' };
