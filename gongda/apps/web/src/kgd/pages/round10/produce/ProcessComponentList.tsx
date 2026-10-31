import { useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Select, Switch, Table, Tag } from 'antd';
import { HolderOutlined } from '@ant-design/icons';
import { ListFrame } from '../../../ListFrame';
import { useQueryState } from '../../../kit';
import { dash, MemberPick, qs, useList, useR10 } from '../shared';
import type { Row } from '../shared';
import { requestKey } from '../../../../requestKey';

export const componentFieldTypes = ['单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间', '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '公式'];

type Field = { key: string; name: string; description: string; field_type: string; required: boolean; options: string; formula: string; decimals: number | null };

export function ProcessComponentList() {
  const r10 = useR10();
  const list = useQueryState();
  const [advanced, setAdvanced] = useState(false);
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const remote = useList<Row>(`/api/process-components${qs({ keyword: list.query.q || list.query.title, note: list.query.note, creator_id: list.query.creator_id, page: list.page, page_size: list.pageSize })}`);
  const rows = remote.data?.items ?? [];
  return <>
    <ListFrame<Row> pageKey="process_component" exportName="工序附加组件" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear} onApplyQuery={list.onApplyQuery}
      queryNode={<div className="kgd-query-fields">
        <Input style={{ width: 240 }} allowClear placeholder="输入关键字查询" value={list.draft.q ?? ''} onChange={(event) => list.onQuery('q', event.target.value)} onPressEnter={list.onSearch} />
        <Button type="link" onClick={() => setAdvanced((value) => !value)}>高级查询</Button>
        {advanced && <>
          <Input style={{ width: 180 }} allowClear placeholder="标题" value={list.draft.title ?? ''} onChange={(event) => list.onQuery('title', event.target.value)} />
          <Input style={{ width: 180 }} allowClear placeholder="备注" value={list.draft.note ?? ''} onChange={(event) => list.onQuery('note', event.target.value)} />
          <MemberPick style={{ width: 160 }} placeholder="创建人" value={list.draft.creator_id ?? ''} onChange={(value: string) => list.onQuery('creator_id', value ?? '')} />
          <Button type="primary" onClick={list.onSearch}>查询</Button>
        </>}
      </div>}
      page={list.page} pageSize={list.pageSize} total={Number(remote.data?.total ?? rows.length)} onPage={list.onPage} clientPaging={false}
      toolbar={<Button type="primary" onClick={() => setEdit('new')}>新增</Button>}
      columns={[
        { key: 'title', title: '标题', render: (row) => dash(row.title) },
        { key: 'fields', title: '字段', width: 320, render: (row) => ((row.fields ?? []) as Row[]).length ? ((row.fields ?? []) as Row[]).map((field) => <Tag key={field.id ?? field.name}>{field.name}</Tag>) : '-' },
        { key: 'note', title: '备注', render: (row) => dash(row.note) },
        { key: 'creator', title: '创建人', render: (row) => dash(row.creator_name) },
        { key: 'created', title: '创建时间', width: 160, render: (row) => dash(row.created_text) },
        { key: 'actions', title: '操作', width: 120, render: (row) => <>
          <button className="kgd-link" onClick={() => setEdit(row)}>修改</button>{' '}
          <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => r10.confirmDelete('删除工序附加组件', () => r10.act(`/api/process-components/${row.id}`, {}, 'DELETE', '已删除'), '已被工序引用的组件不能删除，确定删除？')}>删除</button>
        </> },
      ]} />
    {edit && <ComponentModal row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
  </>;
}

function toField(raw: Row): Field {
  return { key: String(raw.id ?? requestKey()), name: String(raw.name ?? ''), description: String(raw.description ?? ''), field_type: String(raw.field_type ?? '单行文本'), required: !!raw.required, options: String(raw.options ?? ''), formula: String(raw.formula ?? ''), decimals: raw.decimals === null || raw.decimals === undefined ? null : Number(raw.decimals) };
}

function ComponentModal({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const r10 = useR10();
  const [title, setTitle] = useState<string>(row?.title ?? '');
  const [note, setNote] = useState<string>(row?.note === '-' ? '' : row?.note ?? '');
  const [fields, setFields] = useState<Field[]>(((row?.fields ?? []) as Row[]).map(toField));
  const [fieldEdit, setFieldEdit] = useState<Field | 'new' | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  async function save() {
    if (!title.trim()) { r10.message.warning('请填写标题'); return; }
    const body = { title: title.trim(), note, fields: fields.map((field, index) => ({ sort_no: index + 1, name: field.name, description: field.description, field_type: field.field_type, required: field.required, options: field.options, formula: field.formula, decimals: field.decimals })), ...(row ? { version: row.version } : {}) };
    const result = await r10.act(row ? `/api/process-components/${row.id}` : '/api/process-components', body, row ? 'PUT' : 'POST');
    if (result) onClose();
  }
  function drop(to: number) {
    if (drag === null || drag === to) return;
    setFields((current) => { const next = [...current]; const [moved] = next.splice(drag, 1); next.splice(to, 0, moved!); return next; });
    setDrag(null);
  }
  return <Modal title={row ? '修改工序附加组件' : '新增工序附加组件'} open onCancel={onClose} onOk={() => void save()} okText="确定" cancelText="取消" confirmLoading={r10.busy} destroyOnHidden width={820}>
    <Form layout="vertical">
      <Form.Item label="标题" required><Input maxLength={60} value={title} onChange={(event) => setTitle(event.target.value)} /></Form.Item>
      <Form.Item label="备注"><Input.TextArea maxLength={255} showCount value={note} onChange={(event) => setNote(event.target.value)} /></Form.Item>
    </Form>
    <div className="kgd-toolbar"><b>添加字段</b><span className="spacer" /><Button type="primary" onClick={() => setFieldEdit('new')}>+ 添加字段</Button></div>
    <Table size="small" rowKey="key" pagination={false} dataSource={fields} locale={{ emptyText: '暂无数据' }} onRow={(_, index) => ({ draggable: true, onDragStart: () => setDrag(index ?? null), onDragOver: (event) => event.preventDefault(), onDrop: () => drop(index ?? 0) })} columns={[
      { title: '排序', width: 60, render: () => <HolderOutlined style={{ cursor: 'grab' }} /> },
      { title: '字段名', dataIndex: 'name' },
      { title: '检查项说明', render: (_, field) => field.description || '-' },
      { title: '字段类型', dataIndex: 'field_type' },
      { title: '是否必填', render: (_, field) => field.required ? '是' : '否' },
      { title: '操作', width: 110, render: (_, field) => <>
        <button className="kgd-link" onClick={() => setFieldEdit(field)}>修改</button>{' '}
        <button className="kgd-link" style={{ color: '#f5222d' }} onClick={() => setFields((current) => current.filter((item) => item.key !== field.key))}>删除</button>
      </> },
    ]} />
    {fieldEdit && <FieldModal field={fieldEdit === 'new' ? null : fieldEdit} others={fields} onCancel={() => setFieldEdit(null)} onOk={(next) => {
      setFields((current) => current.some((item) => item.key === next.key) ? current.map((item) => item.key === next.key ? next : item) : [...current, next]);
      setFieldEdit(null);
    }} />}
  </Modal>;
}

function FieldModal({ field, others, onCancel, onOk }: { field: Field | null; others: Field[]; onCancel: () => void; onOk: (field: Field) => void }) {
  const { message } = useR10();
  const [draft, setDraft] = useState<Field>(field ?? { key: requestKey(), name: '', description: '', field_type: '单行文本', required: false, options: '', formula: '', decimals: 2 });
  const set = <K extends keyof Field>(key: K, value: Field[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const numberFields = others.filter((item) => item.key !== draft.key && (item.field_type === '数字输入框' || item.field_type === '公式'));
  function ok() {
    const name = draft.name.trim();
    if (!name) { message.warning('请填写字段'); return; }
    if (others.some((item) => item.key !== draft.key && item.name === name)) { message.warning('字段名不能重复'); return; }
    if ((draft.field_type === '单选下拉框' || draft.field_type === '多选下拉框') && !draft.options.trim()) { message.warning('请填写下拉框数据'); return; }
    if (draft.field_type === '公式' && !draft.formula.trim()) { message.warning('请填写公式'); return; }
    onOk({ ...draft, name, required: draft.field_type === '公式' ? false : draft.required, decimals: draft.field_type === '公式' ? (draft.decimals ?? 2) : null });
  }
  return <Modal title={field ? '修改字段' : '新增字段'} open onCancel={onCancel} onOk={ok} okText="确定" cancelText="取消" destroyOnHidden>
    <Form layout="vertical">
      <Form.Item label="字段" required><Input maxLength={40} value={draft.name} onChange={(event) => set('name', event.target.value)} /></Form.Item>
      <Form.Item label="检查项说明"><Input.TextArea maxLength={255} showCount value={draft.description} onChange={(event) => set('description', event.target.value)} /></Form.Item>
      <Form.Item label="字段类型" required><Select value={draft.field_type} options={componentFieldTypes.map((value) => ({ value, label: value }))} onChange={(value) => set('field_type', value)} /></Form.Item>
      {draft.field_type !== '公式' && <Form.Item label="是否必填"><Switch checked={draft.required} onChange={(value) => set('required', value)} /></Form.Item>}
      {(draft.field_type === '单选下拉框' || draft.field_type === '多选下拉框') && <Form.Item label="下拉框数据" required><Input.TextArea value={draft.options} placeholder="不同选项使用逗号隔开 比如： 合格,不合格" onChange={(event) => set('options', event.target.value)} /></Form.Item>}
      {draft.field_type === '公式' && <>
        <Form.Item label="公式" required extra="点击下方字段插入，支持 + - * / 和括号">
          <Input.TextArea rows={3} value={draft.formula} onChange={(event) => set('formula', event.target.value)} placeholder="例如 ${长度}*${宽度}" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {numberFields.map((item) => <Tag key={item.key} style={{ cursor: 'pointer' }} onClick={() => set('formula', `${draft.formula}\${${item.name}}`)}>{item.name}</Tag>)}
            {['+', '-', '*', '/', '(', ')'].map((op) => <Tag key={op} style={{ cursor: 'pointer' }} onClick={() => set('formula', `${draft.formula}${op}`)}>{op}</Tag>)}
            {!numberFields.length && <span className="kgd-muted">先添加数字输入框字段，才能在公式中引用</span>}
          </div>
        </Form.Item>
        <Form.Item label="小数位数"><InputNumber min={0} max={8} precision={0} value={draft.decimals ?? 2} onChange={(value) => set('decimals', value === null ? 2 : Number(value))} /></Form.Item>
      </>}
    </Form>
  </Modal>;
}
