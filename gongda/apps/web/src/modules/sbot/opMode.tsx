// 操作模式：传统操作 / Bot 代操作（Bot 在真实界面上操作，用户看着）/ Bot 对话（全屏聊天）
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import './ui/sbx.css';
import './sbot.css';

export type OpMode = 'classic' | 'demo' | 'chat';
const KEY = 'sedric-op-mode';
const LAST_CLASSIC_KEY = 'sedric-last-classic-path';
const EVENT = 'sedric-op-mode';

function read(): 'classic' | 'demo' {
  try { return localStorage.getItem(KEY) === 'demo' ? 'demo' : 'classic'; } catch { return 'classic'; }
}

export function setDockMode(mode: 'classic' | 'demo') {
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** 代操作面板是否打开（传统页面上） */
export function useDockMode() {
  const [mode, setMode] = useState(read);
  useEffect(() => {
    const on = () => setMode(read());
    window.addEventListener(EVENT, on);
    window.addEventListener('storage', on);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener('storage', on); };
  }, []);
  return mode;
}

function classicPath(pathname: string, search: string) {
  return pathname.replace(/^\/mes(?=\/)/, '') + search;
}

const MODES: { value: OpMode; label: string; tip: string }[] = [
  { value: 'classic', label: '传统操作', tip: '自己点界面操作' },
  { value: 'demo', label: 'Bot 代操作', tip: 'Bot 在真实界面上替你操作，你看着' },
  { value: 'chat', label: 'Bot 对话', tip: '全屏聊天，Bot 直接调用系统完成' },
];

export function ModeSwitch() {
  const navigate = useNavigate();
  const location = useLocation();
  const dock = useDockMode();
  const current: OpMode = location.pathname.endsWith('/sbot') ? 'chat' : dock;
  return <div className="sbx sbot-mode-switch" data-sbot-ignore>
    <div className="side-filters">
      {MODES.map((m) => <button key={m.value} type="button" title={m.tip} className={m.value === current ? 'pill on' : 'pill'} onClick={() => change(m.value)}>{m.label}</button>)}
    </div>
  </div>;

  function change(v: OpMode) {
    if (v === current) return;
    if (v === 'chat') {
      try { sessionStorage.setItem(LAST_CLASSIC_KEY, classicPath(location.pathname, location.search)); } catch { /* ignore */ }
      navigate('/sbot');
      return;
    }
    setDockMode(v);
    if (current === 'chat') {
      let back = '/staging/area';
      try { back = sessionStorage.getItem(LAST_CLASSIC_KEY) || back; } catch { /* ignore */ }
      navigate(back.startsWith('/sbot') ? '/staging/area' : back);
    }
  }
}
