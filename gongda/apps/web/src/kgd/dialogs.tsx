import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Cascader, Checkbox, Drawer, Empty, Input, Modal, Select, Space, Table, Tabs } from 'antd';
import { AlignLeftOutlined, ApartmentOutlined, CalendarOutlined, CameraOutlined, CarOutlined, CheckSquareOutlined, ClockCircleOutlined, DownSquareOutlined, EditOutlined, EnvironmentOutlined, FunctionOutlined, HolderOutlined, LockOutlined, MailOutlined, MenuOutlined, NumberOutlined, PaperClipOutlined, PhoneOutlined, PlusOutlined, ProfileOutlined, TagsOutlined, UnlockOutlined } from '@ant-design/icons';
import { apiRequest } from '../api';
import { useKgd } from './context';
import { showError } from './kit';
import type { ColumnPrefs } from './storage';

export type FieldOption = { key: string; label: string; missing?: boolean };

function move<T>(list: T[], from: number, to: number) {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

export function ColumnConfigModal({ open, columns, value, onCancel, onOk, onApplyOthers }: {
  open: boolean;
  columns: FieldOption[];
  value: ColumnPrefs;
  onCancel: () => void;
  onOk: (value: ColumnPrefs) => void;
  onApplyOthers?: (prefs: ColumnPrefs) => void;
}) {
  const [draft, setDraft] = useState(value);
  const dragFrom = useRef<number | null>(null);
  const ordered = useMemo(() => draft.order.map((key) => columns.find((column) => column.key === key)).filter((column): column is FieldOption => !!column), [columns, draft.order]);
  const selected = draft.visible.length;
  return <Modal title={`列配置(${selected}/50)`} open={open} width={640} onCancel={onCancel} afterOpenChange={(visible) => { if (visible) setDraft(value); }} destroyOnHidden footer={<Space><Button autoInsertSpace={false} onClick={onCancel}>取消</Button>{onApplyOthers && <Button type="primary" className="kgd-apply-others" onClick={() => onApplyOthers({ ...draft, visible: draft.visible.slice(0, 50) })}>应用到其他人</Button>}<Button autoInsertSpace={false} type="primary" onClick={() => onOk({ ...draft, visible: draft.visible.slice(0, 50) })}>确定</Button></Space>}>
    <Table size="small" pagination={false} rowKey="key" dataSource={ordered} scroll={{ y: 420 }} columns={[
      { title: <Checkbox checked={selected === ordered.length && ordered.length > 0} indeterminate={selected > 0 && selected < ordered.length} onChange={(event) => setDraft((current) => ({ ...current, visible: event.target.checked ? ordered.map((column) => column.key).slice(0, 50) : [] }))} />, width: 48, render: (_, row) => <Checkbox checked={draft.visible.includes(row.key)} disabled={!draft.visible.includes(row.key) && selected >= 50} onChange={(event) => setDraft((current) => ({ ...current, visible: event.target.checked ? [...current.visible, row.key] : current.visible.filter((key) => key !== row.key) }))} /> },
      { title: '锁定', width: 64, render: (_, row) => <Button type="text" aria-label={draft.locked.includes(row.key) ? '取消锁定' : '锁定'} icon={draft.locked.includes(row.key) ? <LockOutlined /> : <UnlockOutlined />} onClick={() => setDraft((current) => ({ ...current, locked: current.locked.includes(row.key) ? current.locked.filter((key) => key !== row.key) : [...current.locked, row.key] }))} /> },
      { title: '列名', dataIndex: 'label' },
      { title: '排序', width: 72, render: (_, __, index) => <span draggable onDragStart={() => { dragFrom.current = index; }} onDragOver={(event) => event.preventDefault()} onDrop={() => { const from = dragFrom.current; dragFrom.current = null; if (from !== null) setDraft((current) => ({ ...current, order: move(current.order, from, index) })); }} style={{ cursor: 'grab' }}><MenuOutlined /></span> },
    ]} />
  </Modal>;
}

export function QueryConfigDrawer({ open, fields, selected, onCancel, onOk }: { open: boolean; fields: FieldOption[]; selected: string[]; onCancel: () => void; onOk: (keys: string[]) => void }) {
  const [order, setOrder] = useState(fields.map((field) => field.key));
  const [checked, setChecked] = useState(selected);
  const [drag, setDrag] = useState<number | null>(null);
  const rows = order.map((key) => fields.find((field) => field.key === key)).filter((field): field is FieldOption => !!field);
  return <Drawer title="配置查询条件" open={open} onClose={onCancel} width={360} afterOpenChange={(visible) => { if (visible) { setOrder(fields.map((field) => field.key)); setChecked(selected); } }} extra={<Space><Button onClick={onCancel}>取消</Button><Button type="primary" onClick={() => onOk(order.filter((key) => checked.includes(key)))}>确定</Button></Space>}>
    {rows.filter((field) => !field.missing).map((field, index) => <div key={field.key} draggable onDragStart={() => setDrag(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (drag !== null) setOrder((current) => move(current, drag, index)); setDrag(null); }} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}>
      <HolderOutlined />
      <Checkbox checked={checked.includes(field.key)} onChange={(event) => setChecked((current) => event.target.checked ? [...current, field.key] : current.filter((key) => key !== field.key))}>{field.label}</Checkbox>
    </div>)}
  </Drawer>;
}

export function MobileCardModal({ open, tabs, fieldsByTab, value, onCancel, onOk }: {
  open: boolean;
  tabs: { key: string; label: string }[];
  fieldsByTab: Record<string, FieldOption[]>;
  value: Record<string, string[]>;
  onCancel: () => void;
  onOk: (value: Record<string, string[]>) => void;
}) {
  const [tab, setTab] = useState(tabs[0]?.key ?? '');
  const [draft, setDraft] = useState(value);
  const [drag, setDrag] = useState<number | null>(null);
  const fields = fieldsByTab[tab] ?? [];
  const selected = draft[tab] ?? [];
  const ordered = [...selected, ...fields.map((field) => field.key).filter((key) => !selected.includes(key))];
  return <Modal title="移动端卡片配置" open={open} width={860} onCancel={onCancel} afterOpenChange={(visible) => { if (visible) { setDraft(value); setTab(tabs[0]?.key ?? ''); } }} onOk={() => onOk(draft)} okText="确定" cancelText="取消" destroyOnHidden>
    <Tabs activeKey={tab} onChange={setTab} items={tabs.map((item) => ({ key: item.key, label: item.label }))} />
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ flex: 1 }}>
        {ordered.map((key, index) => {
          const field = fields.find((item) => item.key === key);
          if (!field) return null;
          return <div key={key} draggable onDragStart={() => setDrag(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (drag === null) return; const next = move(ordered, drag, index); setDraft((current) => ({ ...current, [tab]: next.filter((item) => (current[tab] ?? []).includes(item) || item === key && selected.includes(key)) })); setDrag(null); }} style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
            <HolderOutlined />
            <Checkbox checked={selected.includes(key)} onChange={(event) => setDraft((current) => ({ ...current, [tab]: event.target.checked ? [...(current[tab] ?? []), key] : (current[tab] ?? []).filter((item) => item !== key) }))}>{field.label}</Checkbox>
          </div>;
        })}
      </div>
      <div className="kgd-phone">
        <div className="kgd-muted">下方为非真实的样例数据，仅供预览。</div>
        <h4>样例单号</h4>
        {selected.map((key) => <div key={key}>{fields.find((field) => field.key === key)?.label ?? key}：样例</div>)}
      </div>
    </div>
  </Modal>;
}

export type ExtensionRow = { key: string; name: string; type: string; required: string; createdAt: string };

export type ExtensionTab = {
  key: string;
  label: string;
  rows: ExtensionRow[];
  canAdd?: boolean;
  onAdd?: () => void;
  onReorder?: (ids: string[]) => void | Promise<void>;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void | Promise<void>;
};

export function ExtensionModal({ open, objectName, title, rows, canAdd, onCancel, onAdd, onReorder, onEdit, onDelete, tabs }: {
  open: boolean;
  objectName: string;
  title?: string;
  rows: ExtensionRow[];
  canAdd: boolean;
  onCancel: () => void;
  onAdd?: () => void;
  onReorder?: (ids: string[]) => void | Promise<void>;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void | Promise<void>;
  tabs?: ExtensionTab[];
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [tabKey, setTabKey] = useState(tabs?.[0]?.key ?? '');
  const active = tabs?.find((item) => item.key === tabKey) ?? tabs?.[0];
  const shownRows = active ? active.rows : rows;
  const shownCanAdd = active ? active.canAdd !== false : canAdd;
  const shownAdd = active ? active.onAdd : onAdd;
  const shownReorder = active ? active.onReorder : onReorder;
  const shownEdit = active ? active.onEdit : onEdit;
  const shownDelete = active ? active.onDelete : onDelete;
  const [local, setLocal] = useState(shownRows);
  useEffect(() => { if (open) setLocal(shownRows); }, [open, shownRows]);
  function drop(index: number) {
    if (drag === null || !shownReorder) return;
    const next = move(local, drag, index);
    setLocal(next);
    setDrag(null);
    void shownReorder(next.map((row) => row.key));
  }
  const heading = title ?? `【${objectName}】扩展字段管理`;
  if (!/[\u4e00-\u9fa5]/.test(heading) || /【[A-Za-z0-9_-]*-list】/.test(heading)) return null;
  return <Modal title={heading} open={open} width={840} onCancel={onCancel} footer={null} destroyOnHidden>
    {tabs && tabs.length > 0 && <Tabs activeKey={active?.key} onChange={setTabKey} items={tabs.map((item) => ({ key: item.key, label: item.label }))} />}
    {shownCanAdd && <div style={{ marginBottom: 8 }}><Button type="primary" icon={<PlusOutlined />} onClick={shownAdd}>新增</Button></div>}
    <Table size="small" rowKey="key" pagination={false} dataSource={local} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" /> }} columns={[
      { title: '排序', width: 60, render: (_, __, index) => <span draggable={!!shownReorder} onDragStart={() => setDrag(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => drop(index)} style={{ cursor: shownReorder ? 'grab' : 'default' }}><HolderOutlined /></span> },
      { title: '字段名', dataIndex: 'name' },
      { title: '字段类型', dataIndex: 'type' },
      { title: '是否必填', dataIndex: 'required' },
      { title: '创建时间', dataIndex: 'createdAt' },
      { title: '操作', width: 120, render: (_, row) => (shownEdit || shownDelete) ? <>
        {shownEdit ? <Button type="link" onClick={() => shownEdit(row.key)}>修改</Button> : null}
        {shownDelete ? <Button type="link" danger onClick={() => void shownDelete(row.key)}>删除</Button> : null}
      </> : '—' },
    ]} />
  </Modal>;
}

export const ALL_FIELD_TYPES = ['单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间', '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '公式', '关联对象', '关联属性'] as const;
export const NO_FORMULA_TYPES = ALL_FIELD_TYPES.filter((item) => item !== '公式');
/** 客户列表扩展字段：原版 16 项，无公式，顺序固定。 */
export const CUSTOMER_FIELD_TYPES = ['单行文本', '多行文本', '数字输入框', '单选下拉框', '多选下拉框', '日期', '时间', '附件', '拍照/摄像', '电话', '邮箱', '快递单号', '定位', '签名', '关联对象', '关联属性'] as const;
const TYPE_ICON: Record<string, typeof AlignLeftOutlined> = {
  单行文本: AlignLeftOutlined, 多行文本: ProfileOutlined, 数字输入框: NumberOutlined, 单选下拉框: DownSquareOutlined, 多选下拉框: CheckSquareOutlined,
  日期: CalendarOutlined, 时间: ClockCircleOutlined, 附件: PaperClipOutlined, '拍照/摄像': CameraOutlined, 电话: PhoneOutlined, 邮箱: MailOutlined,
  快递单号: CarOutlined, 定位: EnvironmentOutlined, 签名: EditOutlined, 公式: FunctionOutlined, 关联对象: ApartmentOutlined, 关联属性: TagsOutlined,
};
function typeOption(item: string) {
  const Icon = TYPE_ICON[item];
  return { value: item, label: <span className="ext-type-option">{Icon ? <Icon /> : null}{item}</span> };
}
export const CRAFT_FIELD_TYPES = ALL_FIELD_TYPES.filter((item) => item !== '公式' && item !== '关联对象' && item !== '关联属性');
const FIXED_OPTIONAL = new Set(['公式', '关联对象', '关联属性']);
const REL_OBJECTS = ['客户', '供应商', '合同报价单', '合同', '加工单', '外协工单', '不良品项', '工序', '工艺路线', '商品', '产品', '设备', '用户', '采购单', '采购单明细'];
const REL_ATTR_OBJECTS = ['商品', '合同', '合同明细'];
const CONTRACT_REL_FIELDS = ['合同编号', '客户编号', '客户名称', '联系人', '客户地址', '审核状态', '业务员', '合同金额', '预付款', '累计收款', '累计支出', '已开票金额', '欠款', '交货日期', '备注', '审核人', '审核通过时间', '创建人', '创建时间'];

export type ExtensionAddMode = 'work_order' | 'linkman' | 'customer' | 'product' | 'standard' | 'craft' | 'bom';

export type ExtensionAddValue = {
  label: string;
  required: boolean;
  type: string;
  options: string;
  formula?: string;
  autofill?: { source: string; field: string } | null;
  input_modes?: string[];
  decimals?: number | null;
  biz_object?: string;
  display_field?: string;
  rel_object?: string;
  rel_field?: string;
};

export function ExtensionAddDialog({ open, onCancel, onOk, mode = 'product', title = '新增扩展字段', initial = null }: {
  open: boolean;
  onCancel: () => void;
  onOk: (value: ExtensionAddValue) => void;
  mode?: ExtensionAddMode;
  title?: string;
  initial?: Partial<ExtensionAddValue> | null;
}) {
  const { session } = useKgd();
  const types = mode === 'customer'
    ? [...CUSTOMER_FIELD_TYPES]
    : mode === 'craft'
      ? [...CRAFT_FIELD_TYPES]
      : (mode === 'work_order' || mode === 'product' || mode === 'bom' ? [...ALL_FIELD_TYPES] : [...NO_FORMULA_TYPES]);
  const showAutofill = mode === 'work_order';
  const [label, setLabel] = useState('');
  const [required, setRequired] = useState(false);
  const [type, setType] = useState('单行文本');
  const [options, setOptions] = useState('');
  const [formula, setFormula] = useState('');
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [inputModes, setInputModes] = useState<string[]>(['手动输入']);
  const [decimalsOn, setDecimalsOn] = useState(false);
  const [decimals, setDecimals] = useState('2');
  const [bizObject, setBizObject] = useState('');
  const [displayField, setDisplayField] = useState('');
  const [relObject, setRelObject] = useState('');
  const [relField, setRelField] = useState('');
  const [autofillPath, setAutofillPath] = useState<string[] | undefined>();
  const [autofillOptions, setAutofillOptions] = useState<{ value: string; label: string; children?: { value: string; label: string }[] }[]>([]);
  const [help, setHelp] = useState('');
  const requiredLocked = FIXED_OPTIONAL.has(type);

  useEffect(() => {
    if (!open || !showAutofill) return;
    void apiRequest<{ items: { value: string; label: string; children?: { value: string; label: string }[] }[] }>('/api/entity-ext-fields/autofill-options')
      .then((data) => setAutofillOptions(data.items ?? []))
      .catch(() => setAutofillOptions([]));
  }, [open, showAutofill]);

  const seedRef = useRef(initial);
  seedRef.current = initial;
  useEffect(() => {
    if (!open) return;
    const seed = seedRef.current;
    setLabel(seed?.label ?? '');
    setRequired(Boolean(seed?.required));
    setType(seed?.type || '单行文本');
    setOptions(seed?.options ?? '');
    setFormula(seed?.formula ?? '');
    setFormulaOpen(false);
    setInputModes(seed?.input_modes?.length ? seed.input_modes : ['手动输入']);
    setDecimalsOn(seed?.decimals != null);
    setDecimals(seed?.decimals != null ? String(seed.decimals) : '2');
    setBizObject(seed?.biz_object ?? '');
    setDisplayField(seed?.display_field ?? '');
    setRelObject(seed?.rel_object ?? '');
    setRelField(seed?.rel_field ?? '');
    setAutofillPath(seed?.autofill ? [seed.autofill.source, seed.autofill.field] : undefined);
    setHelp('');
  }, [open]);

  async function submit() {
    if (!label.trim()) { setHelp('请填写字段名'); return; }
    if ((type === '单选下拉框' || type === '多选下拉框') && !options.trim()) { setHelp('请填写下拉框数据'); return; }
    if (type === '公式') {
      if (!formula.trim()) { setHelp('请填写计算公式'); return; }
      try {
        await apiRequest('/api/entity-ext-fields/validate-formula', { method: 'POST', csrfToken: session.csrf_token, body: { formula } });
      } catch (failure) {
        setHelp(showError(failure));
        return;
      }
    }
    if (type === '关联对象' && (!bizObject || !displayField)) { setHelp('请选择业务对象和显示字段'); return; }
    if (type === '关联属性' && (!relObject || !relField)) { setHelp('请选择关联对象和关联字段'); return; }
    if (type === '单行文本' && !inputModes.length) { setHelp('请选择输入方式'); return; }
    setHelp('');
    onOk({
      label: label.trim(),
      required: requiredLocked ? false : required,
      type,
      options,
      formula: type === '公式' ? formula.trim() : undefined,
      autofill: showAutofill && type !== '公式' && autofillPath?.length === 2 ? { source: autofillPath[0]!, field: autofillPath[1]! } : null,
      input_modes: type === '单行文本' ? inputModes : undefined,
      decimals: type === '公式' && decimalsOn ? Number(decimals) : null,
      biz_object: type === '关联对象' ? bizObject : undefined,
      display_field: type === '关联对象' ? displayField : undefined,
      rel_object: type === '关联属性' ? relObject : undefined,
      rel_field: type === '关联属性' ? relField : undefined,
    });
  }

  return <>
    <Modal title={title} open={open} onCancel={onCancel} destroyOnHidden footer={<><Button onClick={onCancel}>取 消</Button><Button type="primary" onClick={() => void submit()}>确 定</Button></>}>
      <div className="kgd-query-fields" style={{ display: 'grid' }}>
        <label><span className="kgd-req">*</span>字段名<Input status={help && !label.trim() ? 'error' : undefined} value={label} onChange={(event) => { setHelp(''); setLabel(event.target.value); }} style={{ display: 'block', width: '100%', marginTop: 4 }} /></label>
        <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>是否必填
          <Select style={{ display: 'block', width: '100%', marginTop: 4 }} disabled={requiredLocked} value={requiredLocked ? 'no' : (required ? 'yes' : 'no')} onChange={(value) => setRequired(value === 'yes')} options={[{ value: 'yes', label: '是' }, { value: 'no', label: '否' }]} />
        </label>
        <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>字段类型
          <Select popupClassName="ext-type-popup" virtual={false} style={{ display: 'block', width: '100%', marginTop: 4 }} value={type} onChange={(value) => { setType(value); if (FIXED_OPTIONAL.has(value)) setRequired(false); setAutofillPath(undefined); }} options={types.map((item) => typeOption(item))} />
        </label>
        {type === '单行文本' && <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>输入方式
          <Checkbox.Group style={{ display: 'block', marginTop: 4 }} value={inputModes} options={[{ label: '手动输入', value: '手动输入' }, { label: '扫码输入', value: '扫码输入' }]} onChange={(value) => setInputModes(value.map(String))} />
        </label>}
        {(type === '单选下拉框' || type === '多选下拉框') && <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>下拉框数据<textarea value={options} placeholder="不同选项使用逗号隔开 比如： 男,女" onChange={(event) => setOptions(event.target.value)} style={{ display: 'block', width: '100%', marginTop: 4 }} /></label>}
        {type === '公式' && <>
          <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>计算公式
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <Input readOnly value={formula} prefix="fx" placeholder="点击添加编辑公式" />
              <Button onClick={() => setFormulaOpen(true)}>添加</Button>
            </div>
          </label>
          <label style={{ marginTop: 8 }}><Checkbox checked={decimalsOn} onChange={(event) => setDecimalsOn(event.target.checked)}>小数位数</Checkbox>
            {decimalsOn && <Input style={{ width: 80, marginLeft: 8 }} value={decimals} onChange={(event) => setDecimals(event.target.value)} />}
          </label>
        </>}
        {type === '关联对象' && <>
          <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>业务对象<Select style={{ display: 'block', width: '100%', marginTop: 4 }} value={bizObject || undefined} options={REL_OBJECTS.map((item) => ({ value: item, label: item }))} onChange={setBizObject} /></label>
          <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>显示字段<Select style={{ display: 'block', width: '100%', marginTop: 4 }} value={displayField || undefined} options={['名称', '编号'].map((item) => ({ value: item, label: item }))} onChange={setDisplayField} /></label>
        </>}
        {type === '关联属性' && <>
          <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>关联对象<Select style={{ display: 'block', width: '100%', marginTop: 4 }} value={relObject || undefined} options={REL_ATTR_OBJECTS.map((item) => ({ value: item, label: item }))} onChange={(value) => { setRelObject(value); setRelField(''); }} /></label>
          <label style={{ marginTop: 8 }}><span className="kgd-req">*</span>关联字段<Select style={{ display: 'block', width: '100%', marginTop: 4 }} value={relField || undefined} options={(relObject === '合同' ? CONTRACT_REL_FIELDS : ['编号', '名称', '规格']).map((item) => ({ value: item, label: item }))} onChange={setRelField} /></label>
        </>}
        {showAutofill && type !== '公式' && <label style={{ marginTop: 8 }}>自动填充规则
          <Cascader style={{ display: 'block', width: '100%', marginTop: 4 }} options={autofillOptions} value={autofillPath} onChange={(value) => setAutofillPath(value?.map(String))} placeholder="请选择" allowClear />
        </label>}
        {help ? <div className="kgd-field-help kgd-field-error kgd-banner">{help}</div> : null}
      </div>
    </Modal>
    <Modal title="编辑计算公式" open={formulaOpen} onCancel={() => setFormulaOpen(false)} onOk={() => setFormulaOpen(false)} okText="确定" cancelText="取消" width={720} destroyOnHidden>
      <div className="kgd-muted" style={{ marginBottom: 8 }}>字段引用语法：${'{对象.字段}'}，支持 CASE / TRUNC / ROUND / ROUNDUP / ROUNDDOWN</div>
      <Input.TextArea rows={8} maxLength={2000} showCount value={formula} onChange={(event) => setFormula(event.target.value)} placeholder="例如：${加工单.计划数}*${商品.销售单价}" />
    </Modal>
  </>;
}
