import { useEffect, useRef, useState } from 'react';
import { App, Button, Checkbox, Input, Modal, Select, Space, Table, Tooltip } from 'antd';
import { FilterOutlined, InfoCircleOutlined, LockOutlined, ProfileOutlined, SortAscendingOutlined } from '@ant-design/icons';
import type { FieldOption } from './dialogs';
import { requestKey } from '../requestKey';

export type ViewFilterRow = { id: string; field: string; value: string };
export type ViewDefaultSort = { field?: string; direction?: 'asc' | 'desc' };
export type ViewEditValue = {
  id?: string;
  /** 内置「全部视图」。保存时写回同一条记录，不另开页签。 */
  builtin?: boolean;
  name: string;
  version?: number;
  icon?: string | null;
  /** 使用范围。空字符串表示未选择，界面保持空白。 */
  scope?: string;
  /** 快捷筛选原文。 */
  quick_filter?: string;
  quick_filters?: string[];
  field_permissions?: Record<string, boolean>;
  filters?: ViewFilterRow[];
  default_sort?: ViewDefaultSort;
  columns?: string[];
  conditions?: Record<string, string>;
};

export const VIEW_ICON_COLORS = ['#1f1f1f', '#4184F4', '#1890ff', '#fa8c16', '#f5222d'] as const;
export const DEFAULT_VIEW_ICON = VIEW_ICON_COLORS[0];

const SECTIONS = [
  { key: 'basic', label: '基本信息', icon: ProfileOutlined },
  { key: 'fields', label: '字段权限', icon: LockOutlined },
  { key: 'filters', label: '数据过滤', icon: FilterOutlined },
  { key: 'sort', label: '默认排序', icon: SortAscendingOutlined },
] as const;

const SCOPE_OPTIONS = [
  { value: 'personal', label: '仅自己' },
  { value: 'team', label: '本团队' },
  { value: 'all', label: '全企业' },
];

function filtersFromConditions(conditions?: Record<string, string>): ViewFilterRow[] {
  if (!conditions) return [];
  return Object.entries(conditions)
    .filter(([field, value]) => field && !field.startsWith('__') && value)
    .map(([field, value]) => ({ id: requestKey(), field, value }));
}

function ViewGlyph() {
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1" y="2" width="12" height="1.6" fill="currentColor" /><rect x="1" y="6.2" width="12" height="1.6" fill="currentColor" /><rect x="1" y="10.4" width="8" height="1.6" fill="currentColor" /></svg>;
}

export function ViewEditModal({ open, value, fields, fieldModule = '列表', onCancel, onOk }: {
  open: boolean;
  value: ViewEditValue | null;
  fields: FieldOption[];
  fieldModule?: string;
  onCancel: () => void;
  onOk: (next: ViewEditValue) => void;
}) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]['key']>('basic');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [draft, setDraft] = useState<ViewEditValue>({ name: '', scope: '', icon: DEFAULT_VIEW_ICON, quick_filter: '', field_permissions: {}, filters: [], default_sort: {} });
  const [nameError, setNameError] = useState(false);
  const nameInputRef = useRef<any>(null);
  const { message } = App.useApp();
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  useEffect(() => {
    if (!open || !value) return;
    const currentFields = fieldsRef.current;
    const permissions = value.field_permissions && Object.keys(value.field_permissions).length
      ? value.field_permissions
      : Object.fromEntries(currentFields.map((field) => [field.key, true]));
    setSection('basic');
    setPickerOpen(false);
    setNameError(false);
    setDraft({
      ...value,
      name: value.name ?? '',
      icon: value.icon || DEFAULT_VIEW_ICON,
      scope: value.scope || '',
      quick_filter: value.quick_filter ?? (value.quick_filters ?? []).join('、'),
      field_permissions: permissions,
      filters: (value.filters?.length ? value.filters : filtersFromConditions(value.conditions)).map((row) => ({ ...row, id: row.id || requestKey() })),
      default_sort: value.default_sort?.field ? value.default_sort : {},
    });
  }, [open, value]);

  function submit() {
    if (!draft.name.trim()) {
      setNameError(true);
      setSection('basic');
      message.warning('请填写视图名称');
      queueMicrotask(() => nameInputRef.current?.focus?.());
      return;
    }
    setNameError(false);
    const selected = fields.filter((field) => draft.field_permissions?.[field.key] !== false);
    onOk({
      ...draft,
      name: draft.name.trim(),
      quick_filter: (draft.quick_filter ?? '').trim(),
      filters: (draft.filters ?? []).filter((row) => row.field),
      conditions: Object.fromEntries((draft.filters ?? []).filter((row) => row.field && row.value).map((row) => [row.field, row.value])),
      columns: selected.map((field) => field.key),
      default_sort: draft.default_sort?.field ? { field: draft.default_sort.field, direction: draft.default_sort.direction || 'asc' } : {},
    });
  }

  const selectedFields = fields.filter((field) => draft.field_permissions?.[field.key] !== false);
  const sortOn = Boolean(draft.default_sort && (draft.default_sort.field !== undefined || draft.default_sort.direction));
  const heading = SECTIONS.find((item) => item.key === section)?.label ?? '基本信息';

  return <>
    <Modal
      className="kgd-view-modal"
      title={value?.id || value?.builtin ? '修改视图' : '新增视图'}
      open={open}
      width={760}
      onCancel={onCancel}
      destroyOnHidden
      footer={<Space><Button onClick={onCancel}>取消</Button><Button type="primary" onClick={submit}>确定</Button></Space>}
    >
      <div className="kgd-view-edit">
        <nav className="kgd-view-edit-nav">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            return <button key={item.key} type="button" aria-label={item.label} className={section === item.key ? 'on' : ''} onClick={() => setSection(item.key)}><Icon />{item.label}</button>;
          })}
        </nav>
        <div className="kgd-view-edit-body">
          <h3>{heading}</h3>
          {section === 'basic' && <div className="kgd-view-edit-form">
            <label><span className="kgd-view-label"><span className="req">*</span>视图名称</span>
              <div>
                <Input
                  ref={nameInputRef}
                  maxLength={20}
                  status={nameError ? 'error' : undefined}
                  value={draft.name}
                  placeholder="请输入视图名称"
                  onChange={(event) => {
                    const name = event.target.value;
                    setNameError(false);
                    setDraft((current) => ({ ...current, name }));
                  }}
                />
                {nameError && <div className="kgd-view-name-error" role="alert">请填写视图名称</div>}
              </div>
            </label>
            <label><span className="kgd-view-label">图标</span>
              <div className="kgd-view-icons">
                {VIEW_ICON_COLORS.map((color) => <button key={color} type="button" className={`kgd-view-icon ${draft.icon === color ? 'on' : ''}`} style={{ background: color }} aria-label={`图标${color}`} onClick={() => setDraft((current) => ({ ...current, icon: color }))}><ViewGlyph /></button>)}
              </div>
            </label>
            <label><span className="kgd-view-label">快捷筛选</span>
              <Input value={draft.quick_filter ?? ''} onChange={(event) => setDraft((current) => ({ ...current, quick_filter: event.target.value }))} />
            </label>
            <label><span className="kgd-view-label">使用范围</span>
              <Select
                allowClear
                style={{ width: '100%' }}
                suffixIcon={<Tooltip title="设置哪些人可以使用此视图"><InfoCircleOutlined /></Tooltip>}
                value={draft.scope || undefined}
                options={SCOPE_OPTIONS}
                onChange={(scope) => setDraft((current) => ({ ...current, scope: scope ?? '' }))}
              />
            </label>
          </div>}
          {section === 'fields' && <div className="kgd-view-fields">
            <p>设置此视图下用户在列表最多查看的字段</p>
            <Button onClick={() => { setPicked(selectedFields.map((field) => field.key)); setPickerOpen(true); }}>选择字段</Button>
            <Table size="small" pagination={false} rowKey="key" dataSource={selectedFields} columns={[
              { title: '模块名', width: 140, render: () => fieldModule },
              { title: '列名', dataIndex: 'label' },
            ]} />
          </div>}
          {section === 'filters' && <div>
            {(draft.filters ?? []).map((row) => <div key={row.id} className="kgd-view-filter-row">
              <Select style={{ width: 180 }} allowClear placeholder="选择字段" value={row.field || undefined} options={fields.map((field) => ({ value: field.key, label: field.label }))}
                onChange={(next) => setDraft((current) => ({ ...current, filters: (current.filters ?? []).map((item) => item.id === row.id ? { ...item, field: next ?? '' } : item) }))} />
              <Input style={{ width: 220 }} placeholder="筛选值" value={row.value} onChange={(event) => setDraft((current) => ({ ...current, filters: (current.filters ?? []).map((item) => item.id === row.id ? { ...item, value: event.target.value } : item) }))} />
              <Button type="link" danger onClick={() => setDraft((current) => ({ ...current, filters: (current.filters ?? []).filter((item) => item.id !== row.id) }))}>删除</Button>
            </div>)}
            <Button type="link" onClick={() => setDraft((current) => ({ ...current, filters: [...(current.filters ?? []), { id: requestKey(), field: '', value: '' }] }))}>添加筛选条件</Button>
          </div>}
          {section === 'sort' && <div>
            {sortOn && <div className="kgd-view-filter-row">
              <Select allowClear style={{ width: 220 }} placeholder="选择字段" value={draft.default_sort?.field || undefined}
                options={fields.map((field) => ({ value: field.key, label: field.label }))}
                onChange={(field) => setDraft((current) => ({ ...current, default_sort: field ? { field, direction: current.default_sort?.direction || 'asc' } : {} }))} />
              <Select style={{ width: 140 }} value={draft.default_sort?.direction || 'asc'}
                options={[{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }]}
                onChange={(direction) => setDraft((current) => ({ ...current, default_sort: { ...current.default_sort, direction } }))} />
              <Button type="link" danger onClick={() => setDraft((current) => ({ ...current, default_sort: {} }))}>删除</Button>
            </div>}
            {!sortOn && <Button type="link" onClick={() => setDraft((current) => ({ ...current, default_sort: { field: '', direction: 'asc' } }))}>添加排序条件</Button>}
          </div>}
        </div>
      </div>
    </Modal>
    <Modal title="选择字段" open={pickerOpen} onCancel={() => setPickerOpen(false)} okText="确定" cancelText="取消" destroyOnHidden
      onOk={() => {
        setDraft((current) => ({ ...current, field_permissions: Object.fromEntries(fields.map((field) => [field.key, picked.includes(field.key)])) }));
        setPickerOpen(false);
      }}>
      <Checkbox.Group
        value={picked}
        options={fields.map((field) => ({ value: field.key, label: field.label }))}
        onChange={(keys) => setPicked(keys.map(String))}
      />
    </Modal>
  </>;
}
