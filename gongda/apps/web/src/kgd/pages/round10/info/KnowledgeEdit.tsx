import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Form, Input, Select, Switch, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useRemote } from '../../../../masterTools';
import { AttachmentField, infoFileHref, RichEditor, uploadInfoFiles, useList, useR10 } from '../shared';
import type { PendingFile, Row, SavedFile } from '../shared';
import type { Category } from './KnowledgeList';

function idFrom(pathname: string, marker: string) {
  return pathname.includes(marker) ? pathname.split('/').pop() ?? '' : '';
}

export function KnowledgeEdit() {
  const { pathname } = useLocation();
  const editId = idFrom(pathname, '/knowledge/edit/');
  const detailId = idFrom(pathname, '/knowledge/detail/');
  if (detailId) return <KnowledgeDetail id={detailId} />;
  return <KnowledgeForm id={editId} />;
}

function KnowledgeForm({ id }: { id: string }) {
  const r10 = useR10();
  const navigate = useNavigate();
  const categories = useList<Category>('/api/knowledge/categories');
  const current = useRemote<{ article?: Row }>(id ? `/api/knowledge/articles/${id}` : null, r10.revision, r10.onExpired);
  const [saved, setSaved] = useState<SavedFile[]>([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [isPublic, setPublic] = useState(false);
  const [content, setContent] = useState('');
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const article = current.data?.article;
    if (!article || loaded) return;
    setTitle(article.title ?? ''); setCategory(article.category_id ?? ''); setTags(article.tags ?? []); setPublic(!!article.is_public); setContent(article.body_html ?? ''); setSaved(article.attachments ?? []); setLoaded(true);
  }, [current.data, loaded]);
  useEffect(() => {
    if (id || category) return;
    const fallback = (categories.data?.items ?? []).find((item) => item.is_default) ?? categories.data?.items[0];
    if (fallback) setCategory(fallback.id);
  }, [categories.data, category, id]);
  async function submit() {
    if (!title.trim()) { r10.message.warning('请填写标题'); return; }
    if (!category) { r10.message.warning('请选择分类'); return; }
    let uploaded: SavedFile[] = [];
    try { uploaded = await uploadInfoFiles(pending, r10.session.csrf_token); }
    catch (failure) { r10.message.error(failure instanceof Error ? failure.message : String(failure)); return; }
    const body = { title: title.trim(), category_id: category, tags, is_public: isPublic, body_html: content, attachment_ids: [...saved, ...uploaded].map((file) => file.id), ...(id ? { version: current.data?.article?.version } : {}) };
    const result = await r10.act(id ? `/api/knowledge/articles/${id}` : '/api/knowledge/articles', body, id ? 'PUT' : 'POST', '已提交');
    if (!result) return;
    navigate('/knowledge/list');
  }
  return <div className="kgd-card">
    <div className="kgd-toolbar" style={{ justifyContent: 'flex-end' }}><Button onClick={() => navigate(-1)}>返回</Button><Button type="primary" loading={r10.busy} onClick={() => void submit()}>提交</Button></div>
    <Form layout="vertical" style={{ maxWidth: 960 }}>
      <Form.Item label="标题" required><Input maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="请输入标题" /></Form.Item>
      <Form.Item label="分类" required><Select placeholder="请选择分类" value={category || undefined} options={(categories.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))} onChange={setCategory} /></Form.Item>
      <Form.Item label="标签">
        {tags.map((tag) => <Tag key={tag} closable onClose={() => setTags((list) => list.filter((item) => item !== tag))}>{tag}</Tag>)}
        {tagDraft === null ? <Tag style={{ borderStyle: 'dashed', cursor: 'pointer' }} onClick={() => setTagDraft('')}><PlusOutlined /> 新标签</Tag> : <Input size="small" autoFocus style={{ width: 120 }} value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} onBlur={() => { const text = tagDraft.trim(); if (text && !tags.includes(text)) setTags([...tags, text]); setTagDraft(null); }} onPressEnter={() => { const text = tagDraft.trim(); if (text && !tags.includes(text)) setTags([...tags, text]); setTagDraft(null); }} />}
      </Form.Item>
      <Form.Item label="是否公开" extra="公开后用户可通过产品二维码页面【常见问题】查看"><Switch checked={isPublic} checkedChildren="公开" unCheckedChildren="不公开" onChange={setPublic} /></Form.Item>
      <Form.Item label="附件"><AttachmentField pending={pending} onPending={setPending} saved={saved} onRemoveSaved={(fileId) => setSaved((list) => list.filter((file) => file.id !== fileId))} /></Form.Item>
      <Form.Item label="正文">{(!id || loaded) && <RichEditor value={content} onChange={setContent} />}</Form.Item>
    </Form>
  </div>;
}

function KnowledgeDetail({ id }: { id: string }) {
  const r10 = useR10();
  const navigate = useNavigate();
  const current = useRemote<{ article?: Row }>(`/api/knowledge/articles/${id}`, r10.revision, r10.onExpired);
  const article = current.data?.article;
  const files: SavedFile[] = article?.attachments ?? [];
  return <div className="kgd-card">
    <div className="kgd-toolbar" style={{ justifyContent: 'flex-end' }}><Button onClick={() => navigate('/knowledge/list')}>返回</Button><Button type="primary" onClick={() => navigate(`/knowledge/edit/${id}`)}>修改</Button></div>
    {current.error && <div className="kgd-banner">{current.error}</div>}
    {article && <article>
      <h1 style={{ fontSize: 22 }}>{article.title}</h1>
      <div className="kgd-muted" style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <span>分类：{article.category_name || '-'}</span>
        <span>标签：{(article.tags ?? []).join('、') || '-'}</span>
        <span>{article.public_text ?? (article.is_public ? '公开' : '不公开')}</span>
        <span>创建人：{article.creator_name || '-'}</span>
        <span>创建时间：{article.created_text ?? '-'}</span>
      </div>
      <div className="kgd-rich-view" style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12 }} dangerouslySetInnerHTML={{ __html: article.body_html || '' }} />
      <div style={{ marginTop: 16 }}><b>附件：</b>{files.length ? files.map((file) => <div key={file.id}><a href={infoFileHref(file.id)} target="_blank" rel="noreferrer">{file.filename}</a></div>) : '-'}</div>
    </article>}
  </div>;
}
