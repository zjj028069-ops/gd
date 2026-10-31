import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Form, Input, Select } from 'antd';
import { useRemote } from '../../../../masterTools';
import { AttachmentField, infoFileHref, RichEditor, uploadInfoFiles, useR10 } from '../shared';
import type { PendingFile, Row, SavedFile } from '../shared';

export function NoticeEdit() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/notice/detail/')) return <NoticeDetail id={pathname.split('/').pop() ?? ''} />;
  return <NoticeForm />;
}

function NoticeForm() {
  const r10 = useR10();
  const navigate = useNavigate();
  const options = useRemote<{ departments: Row[]; members: Row[] }>('/api/notices/scope-options', r10.revision, r10.onExpired);
  const [title, setTitle] = useState('');
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [pending, setPending] = useState<PendingFile[]>([]);
  async function submit() {
    if (!title.trim()) { r10.message.warning('请填写标题'); return; }
    if (!departmentIds.length && !userIds.length) { r10.message.warning('请选择通知范围'); return; }
    let uploaded: SavedFile[] = [];
    try { uploaded = await uploadInfoFiles(pending, r10.session.csrf_token); }
    catch (failure) { r10.message.error(failure instanceof Error ? failure.message : String(failure)); return; }
    const result = await r10.act('/api/notices', { title: title.trim(), department_ids: departmentIds, user_ids: userIds, body_html: content, attachment_ids: uploaded.map((file) => file.id) }, 'POST', '已发布');
    if (!result) return;
    navigate('/notice/list');
  }
  return <div className="kgd-card">
    <div className="kgd-toolbar" style={{ justifyContent: 'flex-end' }}><Button onClick={() => navigate(-1)}>返回</Button><Button type="primary" loading={r10.busy} onClick={() => void submit()}>提交</Button></div>
    <Form layout="vertical" style={{ maxWidth: 960 }}>
      <Form.Item label="标题" required><Input maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="请输入标题" /></Form.Item>
      <Form.Item label="通知范围" required>
        <div style={{ display: 'grid', gap: 8 }}>
          <Select mode="multiple" allowClear placeholder="选择部门" value={departmentIds} options={(options.data?.departments ?? []).map((item) => ({ value: String(item.id), label: String(item.name) }))} onChange={setDepartmentIds} optionFilterProp="label" />
          <Select mode="multiple" allowClear placeholder="选择人员" value={userIds} options={(options.data?.members ?? []).map((item) => ({ value: String(item.id), label: String(item.display_name) }))} onChange={setUserIds} optionFilterProp="label" />
        </div>
      </Form.Item>
      <Form.Item label="附件"><AttachmentField pending={pending} onPending={setPending} /></Form.Item>
      <Form.Item label="正文"><RichEditor value={content} onChange={setContent} /></Form.Item>
    </Form>
  </div>;
}

function NoticeDetail({ id }: { id: string }) {
  const r10 = useR10();
  const navigate = useNavigate();
  const current = useRemote<{ notice?: Row }>(`/api/notices/${id}`, 0, r10.onExpired);
  const notice = current.data?.notice;
  const files: SavedFile[] = notice?.attachments ?? [];
  return <div className="kgd-card">
    <div className="kgd-toolbar" style={{ justifyContent: 'flex-end' }}><Button onClick={() => navigate('/notice/list')}>返回</Button></div>
    {current.error && <div className="kgd-banner">{current.error}</div>}
    {notice && <article>
      <h1 style={{ fontSize: 22 }}>{notice.title}</h1>
      <div className="kgd-muted" style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <span>发布人：{notice.publisher_name || '-'}</span>
        <span>发布时间：{notice.published_text ?? '-'}</span>
        <span>通知范围：{notice.scope_text || '-'}</span>
      </div>
      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12 }} dangerouslySetInnerHTML={{ __html: notice.body_html || '' }} />
      <div style={{ marginTop: 16 }}><b>附件：</b>{files.length ? files.map((file) => <div key={file.id}><a href={infoFileHref(file.id)} target="_blank" rel="noreferrer">{file.filename}</a></div>) : '-'}</div>
    </article>}
  </div>;
}
