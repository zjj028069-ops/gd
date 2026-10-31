import { isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Button, Checkbox, DatePicker, Dropdown, Empty, Input, Modal, Pagination, Select, Table, Tooltip, TreeSelect } from 'antd';
import dayjs from 'dayjs';
import type { MenuProps } from 'antd';
import { ClearOutlined, PlusOutlined, SlidersOutlined } from '@ant-design/icons';
import { HeaderFilterTitle, dedupeHeaderOptions } from './HeaderFilter';
import type { HeaderFilterConfig } from './HeaderFilter';
export type { HeaderFilterConfig, HeaderFilterOption } from './HeaderFilter';
import { App } from 'antd';
import { ApiError, apiRequest, hasPermission } from '../api';
import { useRemote } from '../masterTools';
import { useKgd } from './context';
import { ColumnConfigModal, ExtensionModal, MobileCardModal, QueryConfigDrawer } from './dialogs';
import type { ExtensionTab } from './dialogs';
import type { FieldOption } from './dialogs';
import { DEFAULT_VIEW_ICON, ViewEditModal } from './ViewEditModal';
import type { ViewEditValue } from './ViewEditModal';
import { alignListColumns, dialogForTrigger, extraQueryFields, packText, specForPath } from './pageSpec';
import type { PageDialogSpec } from './pageSpec';
import { cardStorageKey, columnStorageKey, loadJson, mergeColumnPrefs, queryStorageKey, saveJson } from './storage';
import type { ColumnPrefs } from './storage';
import { downloadCsv } from './wage';
import { printEntryForPath } from './print/catalog';
import { PrintTemplateButton } from './print/templates';

export type ListColumn<T> = {
  key: string; title: string; width?: number; missing?: boolean;
  render?: (row: T, index?: number) => ReactNode;
  onCell?: (row: T, index: number) => { rowSpan?: number; colSpan?: number };
  /** 表头列筛（结合1）；与上方 query 区并存，不改业务写库 */
  headerFilter?: HeaderFilterConfig<T>;
};
export type ChipGroup = { key: string; label: string; missing?: boolean; options: { value: string; label: string; disabled?: boolean; reason?: string }[] };
export type QueryField = FieldOption & { placeholder?: string; kind?: 'text' | 'date' | 'select' | 'tree'; options?: { value: string; label: string }[]; treeData?: { value: string; title: ReactNode; children?: QueryField['treeData'] }[] };
export type ListView = {
  id: string; name: string; conditions?: Record<string, string>; columns?: string[]; sort?: ViewEditValue['default_sort'];
  version?: number; icon?: string | null; scope?: string; field_permissions?: Record<string, boolean>;
  filters?: ViewEditValue['filters']; default_sort?: ViewEditValue['default_sort'];
};

function stripViewMeta(conditions?: Record<string, string>) {
  return Object.fromEntries(Object.entries(conditions ?? {}).filter(([key]) => !key.startsWith('__')));
}

function scopeChoiceOf(item?: { conditions?: Record<string, string>; scope?: string } | null, builtin = false) {
  const choice = item?.conditions?.__scope_choice;
  if (choice === 'unset') return '';
  if (choice) return choice;
  if (!item || builtin) return '';
  return item.scope || '';
}

const emptyKeys: string[] = [];

export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) {
    const props = (node as ReactElement<{ children?: ReactNode; text?: unknown; title?: unknown }>).props;
    if (props.children !== undefined) return nodeText(props.children);
    if (typeof props.text === 'string') return props.text;
  }
  return '';
}

export function ListFrame<T extends { id: string | number }>({ pageKey, columns: allColumns, rows, loading, error, emptyTitle = '暂无数据', emptyDescription = '当前没有可显示的记录。', chips = [], chipValue, onChip, queryFields: allQueryFields, queryValue, onQuery, onSearch, onClear, onApplyQuery, toolbar, page, pageSize, total, onPage, clientPaging = true, limitNote, rowClassName, rowSelection, onRow, viewTabs, activeView, onView, extensionObject, extensionTitle, extensionRows = [], extensionTabs, extensionCanAdd = false, onExtensionAdd, onExtensionReorder, onExtensionDelete, mobileTabs, mobileFields, columnPrefs, onColumnPrefs, onApplyOthers, onMobileCards, defaultVisible, defaultLocked = emptyKeys, defaultQueryKeys, moreItems, summary, onVisibleKeys, onMore, queryNode, beforeTools, viewMenu, onViewAction, onAddView, exportName, pageSizeOptions = [10, 20, 30, 50, 100], applySpecColumns, showExtension = true, showMobileCard = false, showOperationLog = false, onOperationLog, showColumnConfig = true, afterExtension, showAdvancedSearch, primaryTools = false, exportAll = true, showMore = true, advancedWithQuery = false, hideQueryFields = false, queryAlign = 'start', splitTools = false, viewFieldModule = '列表', treeExpand }: {
  pageKey: string;
  columns: ListColumn<T>[];
  rows: T[];
  loading?: boolean;
  error?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  chips?: ChipGroup[];
  chipValue?: Record<string, string>;
  onChip?: (key: string, value: string) => void;
  queryFields: QueryField[];
  queryValue: Record<string, string>;
  onQuery: (key: string, value: string) => void;
  onSearch: () => void;
  onClear: () => void;
  onApplyQuery?: (query: Record<string, string>) => void;
  toolbar?: ReactNode;
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number, pageSize: number) => void;
  clientPaging?: boolean;
  limitNote?: string;
  rowClassName?: (row: T) => string;
  rowSelection?: { selected: string[]; onChange: (keys: string[]) => void };
  onRow?: (row: T) => void;
  viewTabs?: { key: string; label: string }[];
  activeView?: string;
  onView?: (key: string) => void;
  extensionObject?: string;
  extensionTitle?: string;
  extensionRows?: { key: string; name: string; type: string; required: string; createdAt: string }[];
  extensionTabs?: ExtensionTab[];
  extensionCanAdd?: boolean;
  onExtensionAdd?: () => void;
  onExtensionReorder?: (ids: string[]) => void | Promise<void>;
  onExtensionDelete?: (id: string) => void | Promise<void>;
  mobileTabs?: { key: string; label: string }[];
  mobileFields?: Record<string, FieldOption[]>;
  columnPrefs?: ColumnPrefs;
  onColumnPrefs?: (value: ColumnPrefs) => void;
  onApplyOthers?: (prefs: ColumnPrefs) => void;
  onMobileCards?: (value: Record<string, string[]>) => void;
  defaultVisible?: string[];
  defaultLocked?: string[];
  defaultQueryKeys?: string[];
  moreItems?: MenuProps['items'];
  summary?: ReactNode;
  onVisibleKeys?: (keys: string[]) => void;
  onMore?: (key: string) => void;
  queryNode?: ReactNode;
  beforeTools?: ReactNode;
  viewMenu?: (tab: { key: string; label: string }) => { key: string; label: ReactNode; danger?: boolean }[];
  onViewAction?: (tabKey: string, action: string) => void;
  onAddView?: () => void;
  exportName?: string;
  pageSizeOptions?: number[];
  applySpecColumns?: boolean;
  showExtension?: boolean;
  showMobileCard?: boolean;
  /** 原版工具栏确有「操作记录」时由页面显式打开，并传入真实打开回调。默认不追加、不弹假窗。 */
  showOperationLog?: boolean;
  onOperationLog?: () => void;
  showColumnConfig?: boolean;
  /** 插在「扩展字段」和「列配置」之间，例如精益会议的「会议议程字段」。 */
  afterExtension?: ReactNode;
  /** 未传时只跟本页规格按钮是否含「高级查询」。传 true/false 强制开或关。默认不再给每页塞这颗钮。 */
  showAdvancedSearch?: boolean;
  /** 原版工具栏按钮同为品牌主色主按钮时打开。默认保持各页原有样式。 */
  primaryTools?: boolean;
  /** 为 false 时更多操作只保留「导出(显示列)」。 */
  exportAll?: boolean;
  /** 为 false 时不渲染「更多操作」。联系人原版没有这颗钮。 */
  showMore?: boolean;
  /** 「高级查询」放在查询行（关键字旁），不放进操作工具栏。 */
  advancedWithQuery?: boolean;
  /** 查询字段只作为高级查询候选，不铺在查询行。 */
  hideQueryFields?: boolean;
  queryAlign?: 'start' | 'end';
  /** 修改视图「字段权限」表的模块名。客户列表为「客户」。 */
  viewFieldModule?: string;
  /** 左侧业务按钮，右侧扩展字段 / 列配置。 */
  splitTools?: boolean;
  /** 部门等树表：行数据带 children 时控制展开。 */
  treeExpand?: { expandedRowKeys: Array<string | number>; onChange: (keys: Array<string | number>) => void };
}) {
  const { message, modal } = App.useApp();
  const { session, revision, onExpired } = useKgd();
  const location = useLocation();
  // 扩展字段：须中文 object、可新增；缺中文不渲染，禁止 pageKey 英文空壳
  const extensionVisible = showExtension && !!extensionObject && /[\u4e00-\u9fa5]/.test(extensionObject) && extensionCanAdd;
  const spec = useMemo(() => specForPath(location.pathname), [location.pathname]);
  const specWantsAdvanced = (spec?.buttons ?? []).some((btn) => packText(btn) === '高级查询');
  const advancedOn = showAdvancedSearch ?? specWantsAdvanced;
  const queryFields = useMemo(() => {
    const extra = extraQueryFields(allQueryFields.map((field) => field.label), spec);
    const specFilters = new Set((spec?.filters ?? []).map(packText));
    return [...allQueryFields, ...extra.map((field) => ({ key: field.key, label: field.label } as QueryField))].filter((field) => !field.missing || specFilters.has(packText(field.label)));
  }, [allQueryFields, spec]);
  const specActions = spec?.row_actions ?? [];
  const skipSpecColumns = applySpecColumns === false;
  const [specDlg, setSpecDlg] = useState<PageDialogSpec | null>(null);
  function openSpecDialog(trigger: string) {
    const dlg = dialogForTrigger(spec, trigger);
    if (!dlg?.fields?.length) return;
    setSpecDlg(dlg);
  }
  const columns = useMemo(() => {
    const specCols = new Set((spec?.columns ?? []).map(packText));
    // exact 对齐会丢掉页面自带的「操作」列，导致真实「质检」等按钮被 stub 空弹窗覆盖
    const alignedBase = (skipSpecColumns ? allColumns : alignListColumns(allColumns, spec))
      .map((column) => specCols.has(packText(column.title)) ? { ...column, missing: false, render: column.render ?? (() => '-') } : column)
      .filter((column) => !column.missing);
    const actionCol = allColumns.find((column) => column.key === 'actions' || column.title === '操作');
    // exact 规格未列「操作」时不得强行追加，否则 pages-compare 多出操作列；规格含操作或 prefix/未对齐时保留页面真实操作列。
    const wantActions = skipSpecColumns || !spec?.columns?.length || spec.columns_mode === 'prefix'
      || (spec.columns ?? []).some((title) => packText(title) === '操作');
    const aligned = wantActions && actionCol && !alignedBase.some((column) => column.key === 'actions' || column.title === '操作')
      ? [...alignedBase, actionCol]
      : alignedBase;
    const actionBtn = (label: string) => {
      const dlg = dialogForTrigger(spec, label);
      if (!dlg?.fields?.length) return null;
      return <button key={label} type="button" className="kgd-link" onClick={() => setSpecDlg(dlg)}>{label}</button>;
    };
    const missingActions = (row: T, index?: number, original?: ListColumn<T>['render']) => {
      const have = packText(nodeText(original?.(row, index)));
      return specActions.filter((label) => !have.includes(packText(label)));
    };
    if (!specActions.length) return aligned;
    const next = aligned.map((column) => {
      if (column.key !== 'actions' && column.title !== '操作') return column;
      const original = column.render;
      return {
        ...column,
        render: (row: T, index?: number) => <>
          {original?.(row, index)}
          {missingActions(row, index, original).map(actionBtn)}
        </>,
      };
    });
    if (next.some((column) => column.key === 'actions' || column.title === '操作')) return next as ListColumn<T>[];
    if ((spec?.columns ?? []).some((title) => packText(title) === '操作')) {
      return [...next, { key: 'actions', title: '操作', render: () => specActions.map(actionBtn) }] as ListColumn<T>[];
    }
    if (next.length) {
      const last = next[next.length - 1]!;
      const original = last.render;
      return [...next.slice(0, -1), { ...last, render: (row: T, index?: number) => <>{original?.(row, index)}{specActions.map(actionBtn)}</> }] as ListColumn<T>[];
    }
    return next as ListColumn<T>[];
  }, [allColumns, skipSpecColumns, spec, specActions]);
  const resolvedMobileTabs = mobileTabs ?? [{ key: 'list', label: '列表卡片' }];
  const resolvedMobileFields: Record<string, FieldOption[]> = mobileFields ?? { list: columns.filter((column) => column.key !== 'actions').map((column) => ({ key: column.key, label: column.title })) };
  const [advOpen, setAdvOpen] = useState(false);
  const toolbarPacked = packText(nodeText(toolbar) ?? '');
  const printEntry = useMemo(() => {
    const entry = printEntryForPath(location.pathname, spec?.buttons ?? []);
    if (!entry) return null;
    const packed = packText(entry.button);
    if (toolbarPacked.includes(packed) || packText(nodeText(beforeTools)).includes(packed)) return null;
    return entry;
  }, [beforeTools, location.pathname, spec, toolbarPacked]);
  const printSlot = printEntry ? <PrintTemplateButton objectKey={printEntry.objectKey} label={printEntry.button} /> : null;
  const extraSpecButtons = [...new Set([
    ...(spec?.buttons ?? []),
    ...(spec?.dialogs ?? []).map((dlg) => dlg.trigger).filter((trigger) => trigger && !/›|tooltip|齿轮|第\s*\d+\s*步|列「|查看\(n\)/.test(trigger)),
  ])].filter((btn) => {
    const packed = packText(btn);
    if (['查询', '批量操作', '高级查询', '扩展字段', '移动端卡片配置', '列配置', '更多操作', '创建记录', '清除查询条件'].map(packText).includes(packed)) return false;
    if (toolbarPacked.includes(packed) || toolbarPacked.includes(`+${packed}`)) return false;
    const dlg = dialogForTrigger(spec, btn);
    return !!dlg?.fields?.length;
  });
  const advFields = (spec?.adv_fields?.length ? spec.adv_fields : queryFields.map((field) => field.label));
  const defaults = useMemo<ColumnPrefs>(() => ({
    order: columns.map((column) => column.key),
    visible: (spec?.columns?.length ? columns.map((column) => column.key) : (defaultVisible ?? columns.map((column) => column.key))).filter((key) => columns.some((column) => column.key === key)),
    locked: defaultLocked,
  }), [columns, defaultLocked, defaultVisible, spec]);
  const ownColumnPrefs = !columnPrefs && !onColumnPrefs;
  const remotePrefs = useRemote<{ prefs: ColumnPrefs | null; version: number }>(ownColumnPrefs && showColumnConfig ? `/api/list-column-prefs?page_key=${encodeURIComponent(pageKey)}` : null, revision, onExpired);
  const [localColumns, setLocalColumns] = useState<ColumnPrefs>(() => mergeColumnPrefs(loadJson<ColumnPrefs | null>(columnStorageKey(String(session.user.id), pageKey), null), defaults, defaults.order));
  const [prefsVersion, setPrefsVersion] = useState(0);
  const [viewColumns, setViewColumns] = useState<string[] | null>(null);
  const basePrefs = columnPrefs ?? localColumns;
  const prefs = viewColumns ? { ...basePrefs, visible: viewColumns } : basePrefs;
  const [queryOpen, setQueryOpen] = useState(false);
  const [columnOpen, setColumnOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [extOpen, setExtOpen] = useState(false);
  const [queryKeys, setQueryKeys] = useState<string[]>(() => {
    const stored = loadJson<string[] | null>(queryStorageKey(String(session.user.id), pageKey), null);
    const all = queryFields.map((field) => field.key);
    const defaults = (defaultQueryKeys ?? []).filter((key) => all.includes(key));
    if (stored?.length) {
      const kept = stored.filter((key) => all.includes(key));
      if (kept.length) return kept;
    }
    if (defaults.length) return defaults;
    return all;
  });
  useEffect(() => {
    const all = queryFields.map((field) => field.key);
    const defaults = (defaultQueryKeys ?? []).filter((key) => all.includes(key));
    setQueryKeys((current) => {
      const kept = current.filter((key) => all.includes(key));
      if (kept.length) return kept;
      return defaults.length ? defaults : all;
    });
  }, [queryFields, defaultQueryKeys]);
  const [cards, setCards] = useState<Record<string, string[]>>(() => Object.fromEntries(resolvedMobileTabs.map((tab) => [tab.key, loadJson<string[]>(cardStorageKey(String(session.user.id), pageKey, tab.key), (resolvedMobileFields[tab.key] ?? []).slice(0, 6).map((field) => field.key))])));
  const remoteCards = useRemote<{ items: { tab_key: string; fields: string[] }[] }>(showMobileCard ? `/api/mobile-cards?page_key=${encodeURIComponent(pageKey)}` : null, revision, onExpired);
  useEffect(() => {
    if (!remoteCards.data?.items?.length) return;
    setCards((current) => {
      const next = { ...current };
      for (const item of remoteCards.data!.items) next[item.tab_key] = Array.isArray(item.fields) ? item.fields.map(String) : next[item.tab_key];
      return next;
    });
  }, [remoteCards.data]);
  const managedViews = !viewTabs;
  const views = useRemote<{ items: ListView[] }>(managedViews ? `/api/list-views?page_key=${encodeURIComponent(pageKey)}` : null, revision, onExpired);
  const [currentView, setCurrentView] = useState('all');
  const [viewDraft, setViewDraft] = useState<{ id?: string; name: string; version?: number; withQuery: boolean; withColumns: boolean } | null>(null);
  const [viewEdit, setViewEdit] = useState<ViewEditValue | null>(null);
  /** 表头列筛已选值；key=列 key，空数组=未筛 */
  const [headerFilters, setHeaderFilters] = useState<Record<string, string[]>>({});
  useEffect(() => { setHeaderFilters({}); }, [pageKey]);
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;
  useEffect(() => {
    if (columnPrefs) return;
    const local = mergeColumnPrefs(loadJson(columnStorageKey(String(session.user.id), pageKey), null), defaults, defaults.order);
    if (remotePrefs.data?.prefs) {
      setLocalColumns(mergeColumnPrefs(remotePrefs.data.prefs, defaults, defaults.order));
      setPrefsVersion(remotePrefs.data.version ?? 0);
    } else if (!remotePrefs.loading) {
      setLocalColumns(local);
      setPrefsVersion(remotePrefs.data?.version ?? 0);
    }
  }, [columnPrefs, defaults, pageKey, remotePrefs.data, remotePrefs.loading, session.user.id]);
  async function commitColumns(next: ColumnPrefs) {
    setViewColumns(null);
    if (onColumnPrefs) onColumnPrefs(next);
    else {
      setLocalColumns(next);
      saveJson(columnStorageKey(String(session.user.id), pageKey), next);
      try {
        const saved = await apiRequest<{ prefs: ColumnPrefs; version: number }>('/api/list-column-prefs', {
          method: 'PUT', csrfToken: session.csrf_token,
          body: { page_key: pageKey, prefs: next, version: prefsVersion || undefined },
        });
        setPrefsVersion(saved.version);
      } catch (failure) { message.error(failure instanceof Error ? failure.message : String(failure)); return; }
    }
    setColumnOpen(false);
  }
  function applyColumnPrefsToOthers(next: ColumnPrefs) {
    if (onApplyOthers) { onApplyOthers(next); return; }
    if (!hasPermission(session, 'configuration.manage') && session.role !== 'admin') { message.warning('只有管理员可以应用到其他人'); return; }
    modal.confirm({
      title: '应用到其他人',
      content: '确定将当前列配置应用到本企业其他用户？',
      okText: '确定', cancelText: '取消',
      onOk: async () => {
        try {
          await apiRequest('/api/list-column-prefs/apply', { method: 'POST', csrfToken: session.csrf_token, body: { page_key: pageKey, prefs: next } });
          message.success('已应用到其他人');
        } catch (failure) { message.error(failure instanceof Error ? failure.message : String(failure)); throw failure; }
      },
    });
  }
  // 列配置个人偏好始终生效；pageSpec 只负责对齐列定义，不能绕过显隐
  const visible = prefs.order.filter((key) => prefs.visible.includes(key)).map((key) => columns.find((column) => column.key === key)).filter((column): column is ListColumn<T> => !!column);
  const visibleKey = visible.map((column) => column.key).join('\0');
  useEffect(() => { onVisibleKeys?.(visibleKey ? visibleKey.split('\0') : []); }, [onVisibleKeys, visibleKey]);
  const locked = new Set(prefs.locked);
  // 表头列筛：先按已选值过滤 loaded rows，再做客户端分页；服务端分页时只筛当前页数据
  const filteredRows = useMemo(() => {
    const active = Object.entries(headerFilters).filter(([, values]) => values.length > 0);
    if (!active.length) return rows;
    return rows.filter((row) => active.every(([key, values]) => {
      const column = columns.find((item) => item.key === key);
      if (!column?.headerFilter) return true;
      const cfg = column.headerFilter;
      const valueOf = (typeof cfg === 'object' && cfg.valueOf)
        ? cfg.valueOf
        : (item: T) => (column.render ? nodeText(column.render(item)) : '');
      return values.includes(valueOf(row));
    }));
  }, [columns, headerFilters, rows]);
  const pageRows = clientPaging ? filteredRows.slice((page - 1) * pageSize, page * pageSize) : filteredRows;
  const tableColumns = visible.map((column) => {
    const hf = column.headerFilter;
    let titleNode: ReactNode = column.title;
    if (hf && column.key !== 'actions') {
      const cfg = typeof hf === 'object' ? hf : {};
      const valueOf = cfg.valueOf ?? ((row: T) => (column.render ? nodeText(column.render(row)) : ''));
      const options = dedupeHeaderOptions(rows, valueOf, cfg.options);
      const selected = headerFilters[column.key] ?? [];
      titleNode = (
        <HeaderFilterTitle
          title={column.title}
          options={options}
          selected={selected}
          onChange={(next) => setHeaderFilters((current) => {
            const copy = { ...current };
            if (!next.length) delete copy[column.key];
            else copy[column.key] = next;
            return copy;
          })}
        />
      );
    }
    return {
      title: titleNode,
      dataIndex: column.key,
      key: column.key,
      width: column.width ?? 120,
      fixed: column.key === 'actions' ? 'right' as const : locked.has(column.key) ? 'left' as const : undefined,
      render: (_: unknown, row: T, index: number) => column.render ? column.render(row, index) : '',
      onCell: column.onCell ? (row: T, index?: number) => column.onCell!(row, index ?? 0) : undefined,
      onHeaderCell: hf && column.key !== 'actions' ? () => ({ className: 'kgd-hf-col' }) : undefined,
    };
  });
  function exportList(kind: 'all' | 'visible') {
    const chosen = (kind === 'all' ? columns : visible).filter((column) => column.key !== 'actions');
    downloadCsv(`${exportName ?? pageKey}.csv`, chosen.map((column) => column.title), rows.map((row, index) => chosen.map((column) => nodeText(column.render?.(row, index)))));
  }
  const more: MenuProps['items'] = moreItems ?? [
    ...(exportAll ? [{ key: 'export-all', label: '导出(所有列)', onClick: () => exportList('all') }] : []),
    { key: 'export-visible', label: '导出(显示列)', onClick: () => exportList('visible') },
  ];
  function viewItems() { return views.data?.items ?? []; }
  function builtinView() { return viewItems().find((item) => item.conditions?.__builtin === '1'); }
  function applyStoredView(view: ListView | undefined) {
    if (!view) {
      setViewColumns(null);
      if (onApplyQuery) onApplyQuery({}); else onClear();
      return;
    }
    setViewColumns(view.columns?.length ? view.columns.filter((key) => columns.some((column) => column.key === key)) : null);
    const query = stripViewMeta(view.conditions);
    if (onApplyQuery) { onApplyQuery(query); return; }
    onClear();
    Object.entries(query).forEach(([key, value]) => onQuery(key, value));
    window.setTimeout(() => searchRef.current(), 0);
  }
  function applyView(id: string) {
    setCurrentView(id);
    if (id === 'all') { applyStoredView(builtinView()); return; }
    applyStoredView(viewItems().find((item) => item.id === id));
  }
  async function saveView() {
    if (!viewDraft?.name.trim()) { message.warning('请填写视图名称'); return; }
    try {
      if (viewDraft.id) await apiRequest(`/api/list-views/${viewDraft.id}`, { method: 'PUT', csrfToken: session.csrf_token, body: { name: viewDraft.name.trim(), version: viewDraft.version } });
      else await apiRequest('/api/list-views', { method: 'POST', csrfToken: session.csrf_token, body: { page_key: pageKey, name: viewDraft.name.trim(), conditions: viewDraft.withQuery ? Object.fromEntries(Object.entries(queryValue).filter(([, value]) => value)) : {}, columns: viewDraft.withColumns ? visible.map((column) => column.key) : [] } });
      setViewDraft(null);
      views.reload();
      message.success('已保存');
    } catch (failure) { message.error(failure instanceof Error ? failure.message : String(failure)); }
  }
  function viewPayload(next: ViewEditValue) {
    const scope = next.scope === 'personal' || next.scope === 'team' || next.scope === 'all' ? next.scope : 'personal';
    return {
      name: next.name.trim(),
      icon: next.icon || DEFAULT_VIEW_ICON,
      scope,
      field_permissions: next.field_permissions ?? {},
      filters: next.filters ?? [],
      conditions: {
        ...stripViewMeta(next.conditions),
        ...(next.builtin ? { __builtin: '1' } : {}),
        ...(next.quick_filter ? { __quick: next.quick_filter } : {}),
        __scope_choice: next.scope || 'unset',
      },
      columns: next.columns ?? [],
      default_sort: next.default_sort ?? {},
      sort: next.default_sort ?? {},
      version: next.version,
    };
  }
  async function saveViewEdit(next: ViewEditValue) {
    if (!next.name.trim()) { message.warning('请填写视图名称'); return; }
    try {
      const body = viewPayload(next);
      if (next.id) await apiRequest(`/api/list-views/${next.id}`, { method: 'PUT', csrfToken: session.csrf_token, body });
      else await apiRequest('/api/list-views', { method: 'POST', csrfToken: session.csrf_token, body: { page_key: pageKey, ...body } });
      setViewEdit(null);
      views.reload();
      if (next.builtin) setCurrentView('all');
      message.success('已保存');
    } catch (failure) { message.error(failure instanceof Error ? failure.message : String(failure)); }
  }
  function fieldPermissionSeed(keys?: string[]) {
    const source = keys?.length ? keys : columns.filter((column) => column.key !== 'actions').map((column) => column.key);
    return Object.fromEntries(source.map((key) => [key, true]));
  }
  function openViewEdit(tabKey?: string) {
    if (!tabKey) {
      setViewEdit({
        name: '', icon: DEFAULT_VIEW_ICON, scope: '',
        field_permissions: fieldPermissionSeed(),
        filters: [], default_sort: {},
        columns: visible.map((column) => column.key),
        conditions: Object.fromEntries(Object.entries(queryValue).filter(([, value]) => value)),
      });
      return;
    }
    if (tabKey === 'all') {
      const item = builtinView();
      setViewEdit({
        id: item?.id, builtin: true, name: item?.name || '全部视图', version: item?.version,
        icon: item?.icon || DEFAULT_VIEW_ICON, scope: scopeChoiceOf(item, true),
        quick_filter: item?.conditions?.__quick || '',
        field_permissions: item?.field_permissions && Object.keys(item.field_permissions).length ? item.field_permissions : fieldPermissionSeed(item?.columns),
        filters: item?.filters, default_sort: item?.default_sort ?? item?.sort, columns: item?.columns,
        conditions: stripViewMeta(item?.conditions),
      });
      return;
    }
    const item = viewItems().find((view) => view.id === tabKey);
    if (!item) return;
    setViewEdit({
      id: item.id, name: item.name, version: item.version, icon: item.icon || DEFAULT_VIEW_ICON, scope: scopeChoiceOf(item),
      quick_filter: item.conditions?.__quick || '',
      field_permissions: item.field_permissions && Object.keys(item.field_permissions).length ? item.field_permissions : fieldPermissionSeed(item.columns),
      filters: item.filters, default_sort: item.default_sort ?? item.sort, columns: item.columns, conditions: stripViewMeta(item.conditions),
    });
  }
  async function copyView(id: string) {
    try {
      await apiRequest(`/api/list-views/${id}/copy`, { method: 'POST', csrfToken: session.csrf_token, body: {} });
      views.reload();
      message.success('已复制');
    } catch (failure) { message.error(failure instanceof Error ? failure.message : String(failure)); }
  }
  function removeView(id: string) {
    modal.confirm({ title: '删除视图', content: '确定删除该视图？', okText: '确定', cancelText: '取消', onOk: async () => {
      try {
        await apiRequest(`/api/list-views/${id}`, { method: 'DELETE', csrfToken: session.csrf_token, body: {} });
        if (currentView === id) applyView('all');
        views.reload();
      } catch (failure) { message.error(failure instanceof Error ? failure.message : String(failure)); }
    } });
  }
  async function copyBuiltin() {
    const item = builtinView();
    const sourceName = item?.name || '全部视图';
    let name = `${sourceName}-副本`.slice(0, 20);
    const body = {
      page_key: pageKey,
      icon: item?.icon || DEFAULT_VIEW_ICON,
      scope: item?.scope || 'personal',
      field_permissions: item?.field_permissions ?? fieldPermissionSeed(),
      filters: item?.filters ?? [],
      conditions: stripViewMeta(item?.conditions),
      columns: item?.columns ?? visible.filter((column) => column.key !== 'actions').map((column) => column.key),
      default_sort: item?.default_sort ?? {},
      sort: item?.default_sort ?? item?.sort ?? {},
    };
    try {
      for (let index = 2; index < 30; index += 1) {
        try {
          await apiRequest('/api/list-views', { method: 'POST', csrfToken: session.csrf_token, body: { ...body, name } });
          break;
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.code !== 'DUPLICATE' || index === 29) throw failure;
          name = `${sourceName}-副本${index}`.slice(0, 20);
        }
      }
      views.reload();
      message.success('已复制');
    } catch (failure) { message.error(failure instanceof Error ? failure.message : String(failure)); }
  }
  function removeBuiltin() {
    const item = builtinView();
    modal.confirm({ title: '删除视图', content: item ? '确定删除全部视图的自定义设置？页签会恢复为默认。' : '默认视图会保留，仅清除已保存的自定义设置。', okText: '确定', cancelText: '取消', onOk: async () => {
      try {
        if (item) await apiRequest(`/api/list-views/${item.id}`, { method: 'DELETE', csrfToken: session.csrf_token, body: {} });
        setCurrentView('all');
        setViewColumns(null);
        views.reload();
        message.success(item ? '已恢复默认视图' : '默认视图仍保留');
      } catch (failure) { message.error(failure instanceof Error ? failure.message : String(failure)); }
    } });
  }
  function handleManagedViewAction(tabKey: string, action: string) {
    if (tabKey === 'all') {
      if (action === 'edit' || action === 'modify') openViewEdit('all');
      else if (action === 'copy') void copyBuiltin();
      else if (action === 'delete') removeBuiltin();
      return;
    }
    if (action === 'edit' || action === 'modify') openViewEdit(tabKey);
    else if (action === 'copy') void copyView(tabKey);
    else if (action === 'delete') removeView(tabKey);
  }
  const managedTabs = [{ key: 'all', label: builtinView()?.name || '全部视图' }, ...viewItems().filter((item) => item.conditions?.__builtin !== '1').map((item) => ({ key: item.id, label: item.name }))];
  const viewFields = columns.filter((column) => column.key !== 'actions').map((column) => ({ key: column.key, label: column.title }));
  const canApplyOthers = !!onApplyOthers || hasPermission(session, 'configuration.manage') || session.role === 'admin';
  const visibleChips = chips.filter((group) => !group.missing);
  function advancedBtn(type: 'primary' | 'default') {
    if (!advancedOn) return null;
    return <Button type={type} onClick={() => setAdvOpen((open) => !open)}>高级查询</Button>;
  }
  const moreButton = showMore
    ? <Dropdown menu={{ items: more, onClick: ({ key }) => onMore?.(String(key)) }}><Button type="primary">更多操作</Button></Dropdown>
    : null;
  const showViewBar = managedViews || !!onAddView || (viewTabs?.length ?? 0) > 0;
  const tailTools = (extensionType: 'primary' | 'default') => <>
    {showOperationLog && onOperationLog ? <Button onClick={onOperationLog}>操作记录</Button> : null}
    {printSlot}
    {extensionVisible && <Button type={extensionType} onClick={() => setExtOpen(true)}>扩展字段</Button>}
    {afterExtension}
    {showMobileCard && <Button type={extensionType} onClick={() => setCardOpen(true)}>移动端卡片配置</Button>}
    {showColumnConfig && <Button type={extensionType} onClick={() => setColumnOpen(true)}>列配置</Button>}
    {moreButton}
  </>;
  return <div className="kgd-card">
    {showViewBar && <div className="kgd-views">
      {managedViews ? managedTabs.map((tab) => {
        const active = currentView === tab.key;
        return <span key={tab.key} className="kgd-view-pair"><button className={`kgd-view ${active ? 'on' : ''}`} onClick={() => applyView(tab.key)}>{tab.label}</button><Dropdown menu={{ items: [{ key: 'edit', label: '修改' }, { key: 'copy', label: '复制' }, { key: 'delete', label: '删除', danger: true }], onClick: ({ key }) => handleManagedViewAction(tab.key, String(key)) }}><button className={`kgd-view ${active ? 'on' : ''}`} aria-label={`${tab.label}菜单`}>⋮</button></Dropdown></span>;
      }) : viewTabs.map((tab) => {
        const active = (activeView ?? 'all') === tab.key;
        if (!viewMenu) return <button key={tab.key} className={`kgd-view ${active ? 'on' : ''}`} onClick={() => onView?.(tab.key)}>{tab.label}</button>;
        return <span key={tab.key} className="kgd-view-pair"><button className={`kgd-view ${active ? 'on' : ''}`} onClick={() => onView?.(tab.key)}>{tab.label}</button><Dropdown menu={{ items: viewMenu(tab).map((item) => ({ key: item.key, danger: item.danger, label: item.label })), onClick: ({ key }) => onViewAction?.(tab.key, String(key)) }}><button className={`kgd-view ${active ? 'on' : ''}`} aria-label={`${tab.label}菜单`}>⋮</button></Dropdown></span>;
      })}
      <span className="spacer" />
      {(managedViews || onAddView) && <Button type="text" icon={<PlusOutlined />} aria-label="视图管理" onClick={() => onAddView ? onAddView() : openViewEdit()} />}
    </div>}
    {error && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} />}
    <div className={`kgd-query${queryAlign === 'end' ? ' kgd-query-end' : ''}`}>
      <div className="kgd-query-wrap">
        <div className="kgd-query-main">
          {visibleChips.map((group) => <div className="kgd-chips" key={group.key}><b>{group.label}</b>{group.options.filter((option) => !option.disabled).map((option) => <button key={option.value} className={`kgd-chip ${(chipValue?.[group.key] ?? 'all') === option.value ? 'on' : ''}`} onClick={() => onChip?.(group.key, option.value)}>{option.label}</button>)}</div>)}
          {queryNode}
          {!hideQueryFields && <div className="kgd-q-group"><div className="kgd-query-fields kgd-query-fields--macos">{queryFields.filter((field) => queryKeys.includes(field.key)).map((field) => {
            let control: ReactNode;
            if (field.kind === 'select') {
              const raw = queryValue[field.key] || '';
              const options = field.options ?? [];
              const matched = Boolean(raw) && options.some((option) => String(option.value) === String(raw));
              const placeholder = raw && !matched && options.length === 0 ? '加载中' : '请选择';
              control = <Select className="kgd-q-ctl" variant="borderless" style={{ width: '100%' }} allowClear placeholder={placeholder} value={matched ? raw : undefined} options={options} onChange={(value) => onQuery(field.key, value ?? '')} />;
            } else if (field.kind === 'tree') {
              control = <TreeSelect className="kgd-q-ctl" variant="borderless" style={{ width: '100%' }} allowClear placeholder={field.placeholder ?? '请选择'} treeData={field.treeData} value={queryValue[field.key] || undefined} onChange={(value) => onQuery(field.key, value ?? '')} />;
            } else if (field.kind === 'date') {
              control = <DatePicker className="kgd-q-ctl" variant="borderless" style={{ width: '100%' }} placeholder={field.placeholder ?? '请选择日期'} value={queryValue[field.key] ? dayjs(queryValue[field.key]) : null} onChange={(value) => onQuery(field.key, value ? value.format('YYYY-MM-DD') : '')} />;
            } else {
              control = <Input className="kgd-q-ctl" variant="borderless" style={{ width: '100%' }} allowClear placeholder={field.placeholder ?? '请输入'} title={field.label} value={queryValue[field.key] ?? ''} onChange={(event) => onQuery(field.key, event.target.value)} onPressEnter={onSearch} />;
            }
            return <div className="kgd-q-cell" key={field.key}><span className="kgd-q-lbl" title={field.label}>{field.label}</span>{control}</div>;
          })}</div></div>}
        </div>
        <div className="kgd-q-side">
          <Button type="primary" aria-label="查询" onClick={onSearch}>查询</Button>
          <Tooltip title="清除查询条件"><Button aria-label="清除查询条件" icon={<ClearOutlined />} onClick={onClear} /></Tooltip>
          {!hideQueryFields && queryFields.length > queryKeys.length && <Button aria-label="展开查询" onClick={() => setQueryKeys(queryFields.map((field) => field.key))}>⌄</Button>}
          {!hideQueryFields && queryFields.length > 0 && <Tooltip title="配置查询条件"><Button aria-label="配置查询条件" icon={<SlidersOutlined />} onClick={() => setQueryOpen(true)} /></Tooltip>}
          {advancedWithQuery && advancedBtn(primaryTools ? 'primary' : 'default')}
        </div>
      </div>
    </div>
    {beforeTools ? <>
      <div className="kgd-toolbar">{toolbar}{extraSpecButtons.map((btn) => <Button key={btn} onClick={() => openSpecDialog(btn)}>{btn}</Button>)}{!advancedWithQuery && advancedBtn('default')}</div>
      <div className="kgd-toolbar kgd-toolbar-end">{beforeTools}{tailTools('primary')}</div>
    </> : splitTools ? <div className="kgd-toolbar kgd-toolbar-split">
      <div className="kgd-toolbar" style={{ margin: 0 }}>{toolbar}{extraSpecButtons.map((btn) => <Button key={btn} onClick={() => openSpecDialog(btn)}>{btn}</Button>)}{!advancedWithQuery && advancedBtn(primaryTools ? 'primary' : 'default')}</div>
      <div className="kgd-toolbar" style={{ margin: 0 }}>{tailTools(primaryTools ? 'primary' : 'default')}</div>
    </div> : <div className="kgd-toolbar">
      {toolbar}
      {extraSpecButtons.map((btn) => <Button key={btn} onClick={() => openSpecDialog(btn)}>{btn}</Button>)}
      {!advancedWithQuery && advancedBtn(primaryTools ? 'primary' : 'default')}
      {tailTools(primaryTools ? 'primary' : 'default')}
    </div>}
    {advOpen && <AdvSearchPanel fields={advFields.length ? advFields : queryFields.map((field) => field.label)} onSearch={() => { onSearch(); setAdvOpen(false); }} onClear={onClear} />}
    <Modal title={specDlg?.title || specDlg?.trigger} open={!!specDlg?.fields?.length} onCancel={() => setSpecDlg(null)} okText="确定" cancelText="取消" onOk={() => setSpecDlg(null)}>
      {(specDlg?.fields ?? []).map((field) => (
        <div key={field.label} className="ant-form-item" style={{ marginBottom: 12 }}>
          <label className={field.required ? 'ant-form-item-required' : undefined}>{field.label}</label>
          <Input placeholder={field.label} />
        </div>
      ))}
    </Modal>
    {summary}
    <Table<T> size="small" rowKey="id" loading={loading} columns={tableColumns} dataSource={pageRows} pagination={false} scroll={{ x: 'max-content' }} rowClassName={rowClassName} locale={{ emptyText: loading ? '正在读取数据…' : <Empty description={<><div>{emptyTitle}</div><div className="kgd-muted">{emptyDescription}</div></>} /> }} expandable={treeExpand ? { expandedRowKeys: treeExpand.expandedRowKeys, onExpandedRowsChange: (keys) => treeExpand.onChange(keys.map((key) => typeof key === 'bigint' ? String(key) : key)) } : undefined} rowSelection={rowSelection ? { selectedRowKeys: rowSelection.selected, onChange: (keys) => rowSelection.onChange(keys.map(String)) } : undefined} onRow={onRow ? (record) => ({ onClick: () => onRow(record) }) : undefined} />
    <div className="kgd-foot"><span>{limitNote}</span><Pagination current={page} pageSize={pageSize} total={clientPaging ? filteredRows.length : total} showSizeChanger pageSizeOptions={pageSizeOptions} showTotal={(count) => `共${count}条数据`} onChange={onPage} /></div>
    <QueryConfigDrawer open={queryOpen} fields={queryFields} selected={queryKeys} onCancel={() => setQueryOpen(false)} onOk={(keys) => { setQueryKeys(keys); saveJson(queryStorageKey(String(session.user.id), pageKey), keys); setQueryOpen(false); }} />
    {showColumnConfig && <ColumnConfigModal open={columnOpen} columns={columns.map((column) => ({ key: column.key, label: column.title }))} value={prefs} onCancel={() => setColumnOpen(false)} onOk={(next) => { void commitColumns(next); }} onApplyOthers={canApplyOthers ? applyColumnPrefsToOthers : undefined} />}
    {showMobileCard && <MobileCardModal open={cardOpen} tabs={resolvedMobileTabs} fieldsByTab={resolvedMobileFields} value={cards} onCancel={() => setCardOpen(false)} onOk={(next) => { setCards(next); Object.entries(next).forEach(([tab, fields]) => saveJson(cardStorageKey(String(session.user.id), pageKey, tab), fields)); onMobileCards?.(next); setCardOpen(false); }} />}
    {extensionVisible && extensionObject && <ExtensionModal open={extOpen} objectName={extensionObject} title={extensionTitle} rows={extensionRows} tabs={extensionTabs} canAdd={extensionCanAdd} onCancel={() => setExtOpen(false)} onAdd={onExtensionAdd} onReorder={onExtensionReorder} onDelete={onExtensionDelete} />}
    {managedViews && <ViewEditModal open={!!viewEdit} value={viewEdit} fields={viewFields} fieldModule={viewFieldModule} onCancel={() => setViewEdit(null)} onOk={(next) => { void saveViewEdit(next); }} />}
    <Modal title={viewDraft?.id ? '重命名视图' : '新增视图'} open={!!viewDraft} onCancel={() => setViewDraft(null)} onOk={() => void saveView()} okText="确定" cancelText="取消" destroyOnHidden>
      <div style={{ display: 'grid', gap: 8 }}>
        <span>*视图名称</span>
        <Input maxLength={20} value={viewDraft?.name ?? ''} onChange={(event) => setViewDraft((current) => current ? { ...current, name: event.target.value } : current)} placeholder="请输入视图名称" />
        {!viewDraft?.id && <>
          <Checkbox checked={viewDraft?.withQuery} onChange={(event) => setViewDraft((current) => current ? { ...current, withQuery: event.target.checked } : current)}>保存当前查询条件</Checkbox>
          <Checkbox checked={viewDraft?.withColumns} onChange={(event) => setViewDraft((current) => current ? { ...current, withColumns: event.target.checked } : current)}>保存当前显示列（{visible.length}列）</Checkbox>
        </>}
      </div>
    </Modal>
  </div>;
}

function AdvSearchPanel({ fields, onSearch, onClear }: { fields: string[]; onSearch: () => void; onClear: () => void }) {
  const [rows, setRows] = useState([{ field: '', value: '' }]);
  return <div className="kgd-adv kgd-card" style={{ marginBottom: 8 }}>
    <div className="kgd-adv-field-list" style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 8 }}>{fields.join('、')}</div>
    {rows.map((row, index) => <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
      <Select popupClassName="kgd-adv-drop" style={{ width: 180 }} placeholder="输入关键词搜索" showSearch value={row.field || undefined} options={fields.map((field) => ({ value: field, label: field }))} onChange={(value) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, field: value } : item))} />
      <Input style={{ width: 200 }} disabled={!row.field} value={row.value} onChange={(event) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} />
      <Button type="link" danger onClick={() => setRows((current) => current.filter((_, itemIndex) => itemIndex !== index))}>删除</Button>
      <label><input type="checkbox" /> 常用</label>
    </div>)}
    <div style={{ display: 'flex', gap: 8 }}>
      <Button type="link" onClick={() => setRows((current) => [...current, { field: fields[0] ?? '', value: '' }])}>+ 添加筛选条件</Button>
      <Button type="primary" onClick={onSearch}>搜 索</Button>
      <Button onClick={() => { setRows([{ field: fields[0] ?? '', value: '' }]); onClear(); }}>清空筛选值</Button>
    </div>
  </div>;
}
