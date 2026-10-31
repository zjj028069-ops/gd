/**
 * 表头筛选 · natural-v3（扁平字+蓝漏斗；仅已筛列 8px 抬起白胶囊）
 * 交互：点列头/漏斗 → 勾选菜单（含「全选」）；主色 #4184F4。
 * 仅 UI；不改业务写库。与上方方案 B query 区并存。
 * 待上云升 v1.0.66 header-filter-natural-v3（本地勿擅自 bump VERSION）。
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Checkbox, Dropdown } from 'antd';
import { FilterOutlined } from '@ant-design/icons';

/** 表头筛选项 */
export type HeaderFilterOption = { value: string; label: string };

/** 列上声明的表头筛配置；true = 开启并按当前行去重选项 */
export type HeaderFilterConfig<T> = boolean | {
  /** 显式选项（枚举/字典）；缺省则从当前 rows 去重 */
  options?: HeaderFilterOption[];
  /** 从行取筛选用的字符串；缺省由 ListFrame 用 render 纯文本补齐 */
  valueOf?: (row: T) => string;
};

/** 从当前数据去重生成选项（空值显示为「(空)」） */
export function dedupeHeaderOptions<T>(
  rows: T[],
  valueOf: (row: T) => string,
  preset?: HeaderFilterOption[],
): HeaderFilterOption[] {
  if (preset?.length) {
    const seen = new Set(preset.map((item) => item.value));
    const extra: HeaderFilterOption[] = [];
    rows.forEach((row) => {
      const value = valueOf(row);
      if (!seen.has(value)) {
        seen.add(value);
        extra.push({ value, label: value === '' ? '(空)' : value });
      }
    });
    return [...preset, ...extra];
  }
  const map = new Map<string, string>();
  rows.forEach((row) => {
    const value = valueOf(row);
    if (!map.has(value)) map.set(value, value === '' ? '(空)' : value);
  });
  return [...map.entries()].map(([value, label]) => ({ value, label }));
}

type HeaderFilterTitleProps = {
  title: string;
  options: HeaderFilterOption[];
  /** 已选值；空数组 = 未筛（等同全部） */
  selected: string[];
  onChange: (next: string[]) => void;
};

/**
 * 表头标题：
 * - idle（未筛）：扁平深灰文案 + 蓝漏斗，无白底胶囊
 * - active（已筛）：8px 抬起白胶囊，文案=单值标签或「已选N项」+ 蓝漏斗
 */
export function HeaderFilterTitle({ title, options, selected, onChange }: HeaderFilterTitleProps) {
  const [open, setOpen] = useState(false);
  const filtered = selected.length > 0;
  const summary = useMemo(() => {
    if (!filtered) return '';
    if (selected.length === 1) {
      const hit = options.find((item) => item.value === selected[0]);
      return hit?.label ?? selected[0];
    }
    return `已选${selected.length}项`;
  }, [filtered, options, selected]);

  const display = filtered ? summary : title;

  function pickAll() {
    onChange([]);
  }

  function toggleValue(value: string, checked: boolean) {
    if (checked) {
      const next = selected.includes(value) ? selected : [...selected, value];
      // 若勾满全部选项，视为「全选/未筛」
      if (options.length > 0 && next.length >= options.length) onChange([]);
      else onChange(next);
      return;
    }
    onChange(selected.filter((item) => item !== value));
  }

  const menu: ReactNode = (
    <div className="kgd-hf-menu" onClick={(event) => event.stopPropagation()}>
      <label className="kgd-hf-item">
        <Checkbox checked={!filtered} onChange={() => pickAll()} />
        <span>全选</span>
      </label>
      {options.map((option) => (
        <label className="kgd-hf-item" key={option.value || '__empty'}>
          <Checkbox
            checked={selected.includes(option.value)}
            onChange={(event) => toggleValue(option.value, event.target.checked)}
          />
          <span>{option.label}</span>
        </label>
      ))}
      {!options.length && <div className="kgd-hf-empty">暂无可筛选项</div>}
      {filtered && (
        <button type="button" className="kgd-hf-clear" onClick={() => pickAll()}>
          清除筛选
        </button>
      )}
    </div>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['click']}
      placement="bottomLeft"
      popupRender={() => menu}
      overlayClassName="kgd-hf-dropdown"
    >
      <button
        type="button"
        className={`kgd-hf-trigger${filtered ? ' is-active' : ' is-idle'}${open ? ' is-open' : ''}`}
        title={filtered ? `${title}：${summary}` : title}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="kgd-hf-text">{display}</span>
        <FilterOutlined className="kgd-hf-icon" />
      </button>
    </Dropdown>
  );
}
