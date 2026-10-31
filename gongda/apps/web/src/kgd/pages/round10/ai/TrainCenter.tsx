import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Form, Input, Modal, Pagination, Table, Tabs } from 'antd';
import { FileTextOutlined, RobotOutlined } from '@ant-design/icons';
import { apiRequest } from '../../../../api';
import { useRemote } from '../../../../masterTools';
import { AttachmentField, infoFileHref, qs, uploadInfoFiles, useList, useR10 } from '../shared';
import type { PendingFile, Row, SavedFile } from '../shared';
import { requestKey } from '../../../../requestKey';

type ChatItem = { id: string; role: 'user' | 'assistant'; content: string; source?: string | null };

export function TrainCenter() {
  const r10 = useR10();
  const [tab, setTab] = useState('qa');
  const intro = useRemote<{ welcome: string; intro: string[]; empty_documents: string }>('/api/ai-train/intro', r10.revision, r10.onExpired);
  const canManage = r10.session.role === 'admin' || (r10.session.points ?? []).includes('system.setting');
  return <div className="kgd-card" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 16 }}>
    <div>
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'intro', label: '功能介绍', children: <div style={{ lineHeight: 2 }}>
          <h3><RobotOutlined /> 训练中心</h3>
          {(intro.data?.intro ?? []).map((line) => <p key={line}>{line}</p>)}
        </div> },
        { key: 'docs', label: '文档集', children: <Documents canManage={canManage} emptyText={intro.data?.empty_documents ?? '您还没有录入文档，快去录入吧！'} /> },
        { key: 'qa', label: '问答集', children: <QaList canManage={canManage} /> },
      ]} />
    </div>
    <ChatPanel welcome={intro.data?.welcome ?? ''} />
  </div>;
}

function Documents({ canManage, emptyText }: { canManage: boolean; emptyText: string }) {
  const r10 = useR10();
  const input = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(1);
  const remote = useList<Row>(`/api/ai-train/documents${qs({ page, page_size: 10 })}`);
  const rows = remote.data?.items ?? [];
  async function upload(files: FileList | null) {
    const list = Array.from(files ?? []);
    for (const file of list) {
      if (!/\.(pdf|doc|docx)$/i.test(file.name)) { r10.message.warning('只能上传 Pdf、Doc、Docx 文件'); continue; }
      try {
        let attachmentId: string | undefined;
        if (/\.pdf$/i.test(file.name) && file.size <= 2 * 1024 * 1024) attachmentId = (await uploadInfoFiles([{ key: file.name, file }], r10.session.csrf_token))[0]?.id;
        await apiRequest('/api/ai-train/documents', { method: 'POST', csrfToken: r10.session.csrf_token, body: { filename: file.name, byte_size: file.size, attachment_id: attachmentId } });
      } catch (failure) { r10.message.error(failure instanceof Error ? failure.message : String(failure)); }
    }
    remote.reload();
  }
  const picker = <><Button type="primary" onClick={() => input.current?.click()}>录入文档</Button><input ref={input} type="file" hidden multiple accept=".pdf,.doc,.docx" onChange={(event) => { void upload(event.target.files); event.target.value = ''; }} /></>;
  if (!rows.length && !remote.loading) return <Empty image={<FileTextOutlined style={{ fontSize: 48, color: '#c9cdd4' }} />} description={emptyText}>{canManage && picker}</Empty>;
  return <>
    {canManage && <div className="kgd-toolbar">{picker}<span className="kgd-muted">支持 Pdf、Doc、Docx</span></div>}
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <Table size="small" rowKey="id" loading={remote.loading} pagination={false} dataSource={rows} columns={[
      { title: '文档名称', render: (_, row) => row.attachment_id ? <a href={infoFileHref(row.attachment_id)} target="_blank" rel="noreferrer">{row.filename}</a> : row.filename },
      { title: '大小', dataIndex: 'size_text' },
      { title: '上传人', dataIndex: 'uploader_name' },
      { title: '上传时间', dataIndex: 'created_text' },
      ...(canManage ? [{ title: '操作', width: 80, render: (_: unknown, row: Row) => <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除文档', () => r10.act(`/api/ai-train/documents/${row.id}`, {}, 'DELETE', '已删除'))}>删除</button> }] : []),
    ]} />
    <div className="kgd-foot"><span /><Pagination current={page} pageSize={10} total={Number(remote.data?.total ?? 0)} showTotal={(count) => `共${count}条数据`} onChange={setPage} /></div>
  </>;
}

function QaList({ canManage }: { canManage: boolean }) {
  const r10 = useR10();
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const remote = useList<Row>(`/api/ai-train/qa${qs({ keyword, page, page_size: 10 })}`);
  const rows = remote.data?.items ?? [];
  return <>
    <div className="kgd-toolbar">
      {canManage && <Button type="primary" onClick={() => setEdit('new')}>新增问答</Button>}
      <span className="spacer" />
      <Input style={{ width: 240 }} allowClear placeholder="问题/答案" value={draft} onChange={(event) => setDraft(event.target.value)} onPressEnter={() => { setKeyword(draft); setPage(1); }} />
      <Button type="primary" onClick={() => { setKeyword(draft); setPage(1); }}>查询</Button>
    </div>
    {remote.error && <div className="kgd-banner">{remote.error}</div>}
    <Table size="small" rowKey="id" loading={remote.loading} pagination={false} dataSource={rows} locale={{ emptyText: '暂无问答，请先录入问答集' }} columns={[
      { title: '问题', dataIndex: 'question', width: 240 },
      { title: '答案', render: (_, row) => <span style={{ whiteSpace: 'pre-wrap' }}>{row.answer}</span> },
      { title: '附件', width: 140, render: (_, row) => ((row.attachments ?? []) as SavedFile[]).length ? ((row.attachments ?? []) as SavedFile[]).map((file) => <div key={file.id}><a href={infoFileHref(file.id)} target="_blank" rel="noreferrer">{file.filename}</a></div>) : '-' },
      { title: '创建人', dataIndex: 'creator_name', width: 100 },
      { title: '创建时间', dataIndex: 'created_text', width: 160 },
      ...(canManage ? [{ title: '操作', width: 120, render: (_: unknown, row: Row) => <>
        <button className="kgd-link" onClick={() => setEdit(row)}>修改</button>{' '}
        <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除问答', () => r10.act(`/api/ai-train/qa/${row.id}`, {}, 'DELETE', '已删除'))}>删除</button>
      </> }] : []),
    ]} />
    <div className="kgd-foot"><span /><Pagination current={page} pageSize={10} total={Number(remote.data?.total ?? 0)} showTotal={(count) => `共${count}条数据`} onChange={setPage} /></div>
    {edit && <QaModal row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
  </>;
}

function QaModal({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const r10 = useR10();
  const [question, setQuestion] = useState<string>(row?.question ?? '');
  const [answer, setAnswer] = useState<string>(row?.answer ?? '');
  const [saved, setSaved] = useState<SavedFile[]>((row?.attachments ?? []) as SavedFile[]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  async function save() {
    if (!question.trim()) { r10.message.warning('请填写问题'); return; }
    if (!answer.trim()) { r10.message.warning('请填写答案'); return; }
    let uploaded: SavedFile[] = [];
    try { uploaded = await uploadInfoFiles(pending, r10.session.csrf_token); }
    catch (failure) { r10.message.error(failure instanceof Error ? failure.message : String(failure)); return; }
    const body = { question: question.trim(), answer: answer.trim(), attachment_ids: [...saved, ...uploaded].map((file) => file.id), ...(row ? { version: row.version } : {}) };
    const result = await r10.act(row ? `/api/ai-train/qa/${row.id}` : '/api/ai-train/qa', body, row ? 'PUT' : 'POST');
    if (result) onClose();
  }
  return <Modal title={row ? '修改问答' : '新增问答'} open onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消" confirmLoading={r10.busy} destroyOnHidden width={620}>
    <Form layout="vertical">
      <Form.Item label="问题" required><Input maxLength={300} value={question} onChange={(event) => setQuestion(event.target.value)} /></Form.Item>
      <Form.Item label="答案" required><Input.TextArea rows={6} maxLength={3000} showCount value={answer} onChange={(event) => setAnswer(event.target.value)} /></Form.Item>
      <Form.Item label="附件"><AttachmentField pending={pending} onPending={setPending} saved={saved} onRemoveSaved={(id) => setSaved((list) => list.filter((file) => file.id !== id))} /></Form.Item>
    </Form>
  </Modal>;
}

function ChatPanel({ welcome }: { welcome: string }) {
  const r10 = useR10();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [items]);
  async function restart() {
    try {
      const result = await apiRequest<{ session_id: string }>('/api/ai-train/chat/new', { method: 'POST', csrfToken: r10.session.csrf_token, body: {} });
      setSessionId(result.session_id);
      setItems([]);
    } catch (failure) { r10.message.error(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function send() {
    const text = question.trim();
    if (!text || sending) return;
    setSending(true);
    setItems((current) => [...current, { id: requestKey(), role: 'user', content: text }]);
    setQuestion('');
    try {
      const result = await apiRequest<{ session_id: string; answer: string; source: { label: string } | null }>('/api/ai-train/chat', { method: 'POST', csrfToken: r10.session.csrf_token, body: { session_id: sessionId ?? undefined, question: text } });
      setSessionId(result.session_id);
      setItems((current) => [...current, { id: requestKey(), role: 'assistant', content: result.answer, source: result.source?.label ?? null }]);
    } catch (failure) {
      r10.message.error(failure instanceof Error ? failure.message : String(failure));
    } finally { setSending(false); }
  }
  const bubble = (role: ChatItem['role']) => ({ maxWidth: '85%', padding: '8px 12px', borderRadius: 8, whiteSpace: 'pre-wrap' as const, background: role === 'user' ? '#4184F4' : '#f5f6f7', color: role === 'user' ? '#fff' : '#333', alignSelf: role === 'user' ? 'flex-end' : 'flex-start' });
  return <aside style={{ border: '1px solid #e5e6eb', borderRadius: 8, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)', minHeight: 480 }}>
    <header style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #f0f0f0' }}><b><RobotOutlined /> 智能助手</b><span style={{ flex: 1 }} /><Button size="small" onClick={() => void restart()}>开启新对话</Button></header>
    <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {welcome && <div style={bubble('assistant')}>{welcome}</div>}
      {items.map((item) => <div key={item.id} style={bubble(item.role)}>{item.content}{item.source && <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>{item.source}</div>}</div>)}
      <div ref={bottom} />
    </div>
    <footer style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #f0f0f0' }}>
      <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} maxLength={300} value={question} placeholder="请输入您的问题" onChange={(event) => setQuestion(event.target.value)} onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); void send(); } }} />
      <Button type="primary" loading={sending} onClick={() => void send()}>发送</Button>
    </footer>
  </aside>;
}
