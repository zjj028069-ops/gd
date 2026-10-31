export type ColumnPrefs = { order: string[]; visible: string[]; locked: string[] };

function key(userId: string, pageKey: string, kind: string) {
  return `kgd:${userId}:${pageKey}:${kind}`;
}

export function loadJson<T>(storageKey: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

export function saveJson(storageKey: string, value: unknown) {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

export function columnStorageKey(userId: string, pageKey: string) { return key(userId, pageKey, 'columns'); }
export function queryStorageKey(userId: string, pageKey: string) { return key(userId, pageKey, 'query'); }
export function cardStorageKey(userId: string, pageKey: string, tab: string) { return key(userId, pageKey, `cards:${tab}`); }

export function mergeColumnPrefs(saved: ColumnPrefs | null, defaults: ColumnPrefs, allKeys: string[]): ColumnPrefs {
  if (!saved) return defaults;
  const known = new Set(allKeys);
  const order = [...saved.order.filter((item) => known.has(item)), ...allKeys.filter((item) => !saved.order.includes(item))];
  // Keep saved visibility, but turn on newly introduced default-visible columns the user never configured.
  const visible = new Set(saved.visible.filter((item) => known.has(item)));
  for (const key of defaults.visible) {
    if (!saved.order.includes(key)) visible.add(key);
  }
  return {
    order,
    visible: order.filter((key) => visible.has(key)),
    locked: [...new Set([...saved.locked, ...defaults.locked].filter((item) => known.has(item)))],
  };
}
