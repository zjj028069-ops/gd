import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useParams } from 'react-router-dom';
import { App, Input } from 'antd';
import { apiRequest } from '../../../../api';
import { useRemote } from '../../../../masterTools';
import { useKgd } from '../../../context';
import { showError } from '../../../kit';
import { moduleLabel, moduleLibrary, normalizeDesign, ScreenModule, slotGrid } from './modules';
import type { ScreenDesign } from './modules';
import { ScreenPanel, Wings } from '../../progress/screenChrome';
import { screenLink } from './ScreenManage';

type ScreenRow = { id: string; menu_name: string; layout: string; module_kind: string; access_password: string; design?: ScreenDesign };

export function ScreenDesigner() {
  const { id = '' } = useParams();
  const { session, revision, onExpired } = useKgd();
  const { message } = App.useApp();
  const screens = useRemote<{ items: ScreenRow[] }>('/api/data-screens', revision, onExpired);
  const meta = useMemo(() => (screens.data?.items ?? []).find((item) => item.id === id), [id, screens.data]);
  const data = useRemote<Record<string, unknown>>(meta ? `/api/progress/screen-data/${meta.id}?pwd=${encodeURIComponent(meta.access_password ?? '')}` : null, revision, onExpired);
  const [title, setTitle] = useState('');
  const [slots, setSlots] = useState<string[]>([]);
  const [over, setOver] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!meta) return;
    const design = normalizeDesign(meta.design, meta.module_kind, meta.layout, meta.menu_name || '数字化生产监控平台');
    setTitle(design.title);
    setSlots(design.slots);
  }, [meta]);
  function startDrag(moduleKey: string, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const move = (ev: PointerEvent) => {
      const slot = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-slot]');
      setOver(slot ? Number((slot as HTMLElement).dataset.slot) : null);
    };
    const up = (ev: PointerEvent) => {
      const slot = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-slot]');
      if (slot) {
        const index = Number((slot as HTMLElement).dataset.slot);
        setSlots((current) => current.map((value, slotIndex) => slotIndex === index ? moduleKey : value));
      }
      setOver(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  async function save() {
    if (!meta) return;
    setSaving(true);
    try {
      await apiRequest(`/api/data-screens/${meta.id}/design`, {
        method: 'PUT',
        csrfToken: session.csrf_token,
        body: {
          title: title.trim() || meta.menu_name || '数字化生产监控平台',
          slots: slots.map((module, index) => ({ slot: index + 1, module })).filter((item) => item.module),
        },
      });
      message.success('已保存');
    } catch (failure) { message.error(showError(failure)); }
    finally { setSaving(false); }
  }
  if (screens.loading && !meta) return <div className="kgd-screen-pwd-gate">正在加载大屏…</div>;
  if (!meta) return <div className="kgd-screen-pwd-gate">大屏不存在</div>;
  const library = moduleLibrary[meta.module_kind] ?? moduleLibrary['生产模块']!;
  return <div className="kgd-screen-root">
    <header className="kgd-screen-header">
      <div className="kgd-screen-time">{meta.menu_name} · {meta.layout}</div>
      <div className="kgd-screen-title-wrap">
        <Wings />
        <Input variant="borderless" value={title} onChange={(event) => setTitle(event.target.value)} className="kgd-screen-title" style={{ color: '#f4fbff' }} aria-label="大屏标题" />
        <span className="kgd-screen-wing is-right" aria-hidden="true"><i /><i /><i /><i /></span>
      </div>
      <div className="kgd-screen-actions" style={{ gap: 8 }}>
        <button type="button" disabled={saving} onClick={() => void save()} style={{ width: 'auto', padding: '0 8px' }}>{saving ? '保存中…' : '保存'}</button>
        <button type="button" onClick={() => window.open(screenLink(meta), '_blank', 'noopener')} style={{ width: 'auto', padding: '0 8px' }}>预览</button>
      </div>
    </header>
    <div className="kgd-screen-body">
      <div className="kgd-screen-designer">
        <aside className="kgd-screen-lib" aria-label="面板库">
          <div className="kgd-screen-module-title"><span>面板库</span></div>
          {library.map((item) => <button key={item.key} type="button" className="kgd-screen-lib-item" data-module={item.key} onPointerDown={(event) => startDrag(item.key, event)}>{item.label}</button>)}
        </aside>
        <div className="kgd-screen-designer-grid" data-layout={meta.layout} style={slotGrid(meta.layout) as CSSProperties}>
          {slots.map((key, index) => <div key={index} className={`kgd-screen-slot ${over === index ? 'is-over' : ''}`} data-slot={index}>
            <ScreenPanel title={moduleLabel(key)} module={moduleLabel(key)}>
              <div className="sub" style={{ marginBottom: 6 }}>拖入面板库条目替换此格</div>
              <ScreenModule moduleKey={key} data={data.data ?? {}} />
            </ScreenPanel>
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}
