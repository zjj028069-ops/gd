import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Input, Switch } from 'antd';
import { apiRequest } from '../../../api';
import { useKgd } from '../../context';
import { setHiddenModules } from './modules';
import './enterprise-btn-align.css';

type Enterprise = { name: string; logo: string; produce_module: boolean; aftersales_module: boolean; device_module: boolean; version: number };

export function EnterprisePage() {
  const { session, onChanged } = useKgd();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<Enterprise | null>(null);
  const [expires, setExpires] = useState('-');
  useEffect(() => {
    void apiRequest<{ enterprise: Enterprise; expires_text: string }>('/api/system/enterprise').then((result) => {
      setData(result.enterprise);
      setExpires(result.expires_text);
      setHiddenModules(result.enterprise);
    }).catch(() => undefined);
  }, []);
  async function save() {
    if (!data?.name.trim()) { message.error('请填写企业名称'); return; }
    try {
      const result = await apiRequest<{ enterprise: Enterprise }>('/api/system/enterprise', { method: 'PUT', csrfToken: session.csrf_token, body: data });
      setData(result.enterprise);
      setHiddenModules(result.enterprise);
      message.success('已保存');
      onChanged();
    } catch (error) { message.error(error instanceof Error ? error.message : '保存失败'); }
  }
  function readLogo(file: File) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { message.error('请上传 PNG、JPEG、WEBP 或 GIF'); return; }
    if (file.size > 300 * 1024) { message.error('标志图片不能超过 300KB'); return; }
    const reader = new FileReader();
    reader.onload = () => setData((current) => current ? { ...current, logo: String(reader.result) } : current);
    reader.onerror = () => message.error('标志图片无法读取');
    reader.readAsDataURL(file);
  }
  if (!data) return <div className="kgd-card">加载中</div>;
  return <div className="kgd-card kgd-enterprise-page">
    <h1>企业信息</h1>
    <div className="kgd-form">
      <span>企业名称</span><Input value={data.name} onChange={(event) => setData({ ...data, name: event.target.value })} />
      <span>企业标志</span><div className="kgd-enterprise-logo-col">
        <div className="kgd-logo-field">{data.logo ? <img src={data.logo} alt="企业标志" /> : <i>赛</i>}<span>{data.logo ? '已使用自定义标志' : '未上传时显示默认标志'}</span></div>
        <input id="enterprise-logo" hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void readLogo(file); }} />
        <div className="kgd-enterprise-btn-row">
          <Button onClick={() => document.getElementById('enterprise-logo')?.click()}>上传标志</Button>
          {data.logo ? <Button onClick={() => setData({ ...data, logo: '' })}>恢复默认</Button> : null}
        </div>
      </div>
      <span>到期时间</span><span>{expires || '-'}</span>
      <span>生产模块</span><Switch checked={data.produce_module} onChange={(produce_module) => setData({ ...data, produce_module })} />
      <span>售后模块</span><Switch checked={data.aftersales_module} onChange={(aftersales_module) => setData({ ...data, aftersales_module })} />
      <span>设备维保模块</span><Switch checked={data.device_module} onChange={(device_module) => setData({ ...data, device_module })} />
      <span>其他设置</span>
      <div className="kgd-enterprise-btn-row">
        <Button onClick={() => navigate('/setting/sms')}>短信设置</Button>
      </div>
      <span aria-hidden="true" />
      <div className="kgd-actions kgd-enterprise-actions">
        <Button onClick={() => navigate(-1)}>返回</Button>
        <Button type="primary" onClick={() => void save()}>保 存</Button>
      </div>
    </div>
  </div>;
}
