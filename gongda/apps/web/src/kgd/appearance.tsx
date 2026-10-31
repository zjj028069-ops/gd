import { useEffect, useState } from 'react';
import { Dropdown } from 'antd';

export type AppearancePreset = 'sky' | 'dusk' | 'graphite';

const STORAGE_KEY = 'kgd-appearance-theme';
const CUSTOM_KEY = 'kgd-appearance-tint';

export const APPEARANCE_PRESETS: { key: AppearancePreset; label: string; swatch: string }[] = [
  { key: 'sky', label: '浅蓝', swatch: 'linear-gradient(135deg,#6ab0e0,#4184F4)' },
  { key: 'dusk', label: '暮蓝', swatch: 'linear-gradient(135deg,#6b7fd7,#2a3a7a)' },
  { key: 'graphite', label: '石墨', swatch: 'linear-gradient(135deg,#8a9bb0,#3a4555)' },
];

export function applyStoredAppearance() {
  try {
    const theme = (localStorage.getItem(STORAGE_KEY) as AppearancePreset | null) || 'sky';
    document.documentElement.setAttribute('data-kgd-theme', theme);
    const tint = localStorage.getItem(CUSTOM_KEY);
    if (tint) document.documentElement.style.setProperty('--kgd-bg-tint', tint);
    else document.documentElement.style.removeProperty('--kgd-bg-tint');
  } catch {
    document.documentElement.setAttribute('data-kgd-theme', 'sky');
  }
}

export function setAppearancePreset(key: AppearancePreset) {
  try { localStorage.setItem(STORAGE_KEY, key); } catch { /* ignore */ }
  document.documentElement.setAttribute('data-kgd-theme', key);
}

export function setAppearanceTint(hex: string | null) {
  try {
    if (hex) localStorage.setItem(CUSTOM_KEY, hex);
    else localStorage.removeItem(CUSTOM_KEY);
  } catch { /* ignore */ }
  if (hex) document.documentElement.style.setProperty('--kgd-bg-tint', hex);
  else document.documentElement.style.removeProperty('--kgd-bg-tint');
}

export function readAppearancePreset(): AppearancePreset {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as AppearancePreset | null;
    if (v === 'sky' || v === 'dusk' || v === 'graphite') return v;
  } catch { /* ignore */ }
  return 'sky';
}

export function readAppearanceTint(): string {
  try { return localStorage.getItem(CUSTOM_KEY) || ''; } catch { return ''; }
}

/** 顶栏轻量外观切换：预设 + 主渐变色 */
export function AppearanceSwitcher() {
  const [preset, setPreset] = useState<AppearancePreset>(() => readAppearancePreset());
  const [tint, setTint] = useState(() => readAppearanceTint());
  useEffect(() => { applyStoredAppearance(); }, []);

  const items = [
    ...APPEARANCE_PRESETS.map((item) => ({
      key: item.key,
      label: (
        <span className="kgd-appearance-item">
          <i style={{ background: item.swatch }} />
          {item.label}
          {preset === item.key ? ' · 当前' : ''}
        </span>
      ),
    })),
    { type: 'divider' as const },
    {
      key: 'tint',
      label: (
        <label className="kgd-appearance-tint" onClick={(event) => event.stopPropagation()}>
          <span>主渐变色</span>
          <input
            type="color"
            value={tint || '#4184F4'}
            onChange={(event) => {
              const next = event.target.value;
              setTint(next);
              setAppearanceTint(next);
            }}
          />
          <button
            type="button"
            className="kgd-link"
            onClick={() => { setTint(''); setAppearanceTint(null); }}
          >
            重置
          </button>
        </label>
      ),
    },
  ];

  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key }) => {
          if (key === 'sky' || key === 'dusk' || key === 'graphite') {
            setPreset(key);
            setAppearancePreset(key);
          }
        },
      }}
      trigger={['click']}
    >
      <button type="button" className="kgd-appearance-btn" aria-label="外观主题" title="外观 / 渐变">
        <i style={{ background: APPEARANCE_PRESETS.find((item) => item.key === preset)?.swatch }} />
        外观
      </button>
    </Dropdown>
  );
}
