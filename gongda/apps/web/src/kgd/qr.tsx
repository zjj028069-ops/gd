import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(text, { width: 220, margin: 1 }).then((url) => { if (alive) setSrc(url); });
    return () => { alive = false; };
  }, [text]);
  return src ? <img src={src} alt="二维码" width={220} height={220} /> : <span>正在生成二维码…</span>;
}

/** 二维码内容要先异步算出来（比如手机访问地址）时用；showText 时在下面显示网址 */
export function AsyncQr({ make, showText = false, size = 220 }: { make: () => Promise<string>; showText?: boolean; size?: number }) {
  const [text, setText] = useState('');
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    void make().then(async (value) => {
      const url = await QRCode.toDataURL(value, { width: size, margin: 1 });
      if (alive) { setText(value); setSrc(url); }
    });
    return () => { alive = false; };
    // make 每次渲染都是新函数，按生成结果去重即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!src) return <span>正在生成二维码…</span>;
  return <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
    <img src={src} alt="二维码" width={size} height={size} />
    {showText && <span style={{ fontSize: 12, color: '#888', wordBreak: 'break-all', maxWidth: size + 60 }}>{text}</span>}
  </span>;
}
