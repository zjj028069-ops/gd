import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import 'antd/dist/reset.css';
import './styles.css';
import './kgd/kgd.css';

/** v1.0.56：嵌入聊天壳 iframe 时尽早 postMessage，避免壳层死等 Shell 挂载 */
(function notifyMesReadyEarly() {
  try {
    if (typeof window === 'undefined' || window.parent === window) return;
    const ping = () => {
      try {
        window.parent.postMessage({ type: 'sedric-mes-ready' }, window.location.origin);
      } catch {
        try {
          window.parent.postMessage({ type: 'sedric-mes-ready' }, '*');
        } catch {
          /* ignore */
        }
      }
    };
    ping();
    window.setTimeout(ping, 200);
    window.setTimeout(ping, 800);
    window.addEventListener('load', ping, { once: true });
  } catch {
    /* ignore */
  }
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
