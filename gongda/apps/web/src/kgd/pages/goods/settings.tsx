import { useEffect, useRef, useState } from 'react';
import { Button, Switch } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { showError, useCommand } from '../../kit';
import { CategoryBoard } from './categories';
import { ensureGoodsCatalog } from './shared';

type Settings = { duplicate_name_check: boolean; auto_fill_code: boolean; qr_login_required: boolean };

export function GoodsSettings() {
  const { session, revision, onExpired, onChanged } = useKgd();
  const command = useCommand();
  const remote = useRemote<{ settings: Settings }>('/api/products/settings', revision, onExpired);
  const [form, setForm] = useState<Settings | null>(null);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    void ensureGoodsCatalog(session).then(() => onChanged()).catch(() => undefined);
  }, [onChanged, session]);
  useEffect(() => { if (remote.data && !form) setForm(remote.data.settings); }, [form, remote.data]);
  async function save() {
    if (!form) return;
    try { await command.send('/api/products/settings', form, 'PUT'); } catch (failure) { command.setError(showError(failure)); }
  }
  const current = form ?? remote.data?.settings;
  return <div className="kgd-card">
    <h2 style={{ marginTop: 0 }}>基础设置</h2>
    {command.error && <div className="kgd-banner">{command.error}</div>}
    {current && <div className="kgd-form" style={{ maxWidth: 760 }}>
      <span>商品重名检查</span><span><Switch checked={current.duplicate_name_check} onChange={(duplicate_name_check) => setForm({ ...current, duplicate_name_check })} /> <span className="kgd-muted">商品是否需要重名检查</span></span>
      <span>商品编号自动填写</span><span><Switch checked={current.auto_fill_code} onChange={(auto_fill_code) => setForm({ ...current, auto_fill_code })} /> <span className="kgd-muted">开启后，商品编号为空时会自动填写</span></span>
      <span>扫描商品二维码查看商品信息需要登录</span><span><Switch checked={current.qr_login_required} onChange={(qr_login_required) => setForm({ ...current, qr_login_required })} /> <span className="kgd-muted">开启后，用户登录系统才能查看扫描商品二维码页面</span></span>
    </div>}
    <div className="kgd-toolbar"><Button type="primary" loading={command.busy} onClick={() => void save()}>保存</Button></div>
    <div className="goods-detail">
      <section><h3>商品类别</h3><CategoryBoard kind="goods" /></section>
      <section><h3>BOM配比类别</h3><CategoryBoard kind="bom" /></section>
    </div>
  </div>;
}
