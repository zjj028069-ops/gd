import specMap from './pageSpec.generated.json' with { type: 'json' };

export type PageDialogSpec = {
  trigger: string;
  title: string;
  fields: { label: string; required: boolean | null }[];
};

export type PageSpec = {
  url: string;
  tab?: string | null;
  filters: string[];
  columns: string[];
  columns_mode: string | null;
  buttons: string[];
  row_actions: string[];
  page_size: string | null;
  adv_fields: string[];
  adv_buttons: string[];
  breadcrumb_tail: string | null;
  dialogs?: PageDialogSpec[];
};

const specs = specMap as Record<string, PageSpec>;

export function packText(value: string) {
  return String(value ?? '').replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').replace(/：/g, ':');
}

function specPath(url: string) {
  return String(url || '').replace(/[（(][^)）]*页签[)）]$/, '');
}

export function specForPath(pathname: string): PageSpec | undefined {
  const hits: PageSpec[] = [];
  for (const spec of Object.values(specs)) {
    const path = specPath(spec.url);
    const pattern = `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\:[A-Za-z_]+/g, '[^/]+')}$`;
    if (new RegExp(pattern).test(pathname)) hits.push(spec);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const exactNoTab = hits.find((item) => specPath(item.url) === pathname && !item.tab);
    if (exactNoTab) return exactNoTab;
    const exact = hits.find((item) => specPath(item.url) === pathname);
    if (exact) return exact;
    const noParam = hits.find((item) => !item.url.includes(':'));
    if (noParam) return noParam;
    return {
      ...hits[0],
      filters: [...new Set(hits.flatMap((item) => item.filters))],
      columns: [],
      columns_mode: null,
      adv_fields: [...new Set(hits.flatMap((item) => item.adv_fields))],
    };
  }
  return undefined;
}

export function alignListColumns<T extends { key: string; title: string }>(existing: T[], spec?: PageSpec | null): T[] {
  if (!spec?.columns?.length) return existing;
  const leftover = [...existing];
  const aligned = spec.columns.map((title, index) => {
    const packed = packText(title);
    const found = leftover.findIndex((column) => packText(column.title) === packed);
    if (found >= 0) return leftover.splice(found, 1)[0]!;
    return { key: `spec-${index}-${packed}`, title, render: () => '-' } as unknown as T;
  });
  if (spec.columns_mode === 'prefix') return [...aligned, ...leftover];
  return aligned;
}

export function extraQueryFields(existingLabels: string[], spec?: PageSpec | null) {
  if (!spec?.filters?.length) return [];
  const have = new Set(existingLabels.map(packText));
  return spec.filters.filter((label) => !have.has(packText(label))).map((label, index) => ({ key: `spec-filter-${index}`, label }));
}

export function dialogForTrigger(spec: PageSpec | undefined, trigger: string): PageDialogSpec | undefined {
  const packed = packText(trigger);
  return (spec?.dialogs ?? []).find((item) => packText(item.trigger) === packed)
    ?? (spec?.dialogs ?? []).find((item) => packText(item.trigger).includes(packed) || packed.includes(packText(item.trigger)));
}
