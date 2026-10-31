import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { App, Button, Input, Steps } from 'antd';
import { LockOutlined, MobileOutlined, UserOutlined } from '@ant-design/icons';
import { apiRequest } from '../../../api';
import { useKgd } from '../../context';
import './personal-macos-a.css';

type TabKey = 'profile' | 'phone' | 'password';

const NAV: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: 'profile', label: '个人资料', icon: <UserOutlined /> },
  { key: 'phone', label: '更换手机', icon: <MobileOutlined /> },
  { key: 'password', label: '修改密码', icon: <LockOutlined /> },
];

export function PersonalPage() {
  const { session, onChanged } = useKgd();
  const { message } = App.useApp();
  const [tab, setTab] = useState<TabKey>('profile');
  const [name, setName] = useState(session.user.display_name);
  const [phone, setPhone] = useState('');
  const [phoneStep, setPhoneStep] = useState(0);
  const [oldPhone, setOldPhone] = useState('');
  const [nextPhone, setNextPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');

  useEffect(() => {
    void apiRequest<{ personal: { display_name: string; phone: string } }>('/api/system/personal').then((data) => {
      setName(data.personal.display_name);
      setPhone(data.personal.phone === '-' ? '' : data.personal.phone);
      setOldPhone(data.personal.phone === '-' ? '' : data.personal.phone);
    }).catch(() => undefined);
  }, []);

  async function save(body: Record<string, unknown>) {
    await apiRequest('/api/system/personal', { method: 'PUT', csrfToken: session.csrf_token, body });
    message.success('已保存');
    onChanged();
  }

  const avatarChar = Array.from(name.trim() || session.user.display_name || '用')[0] || '用';
  const boundPhone = (oldPhone || phone || '').trim();
  const hasBoundPhone = Boolean(boundPhone && boundPhone !== '-');

  return (
    <div className="kgd-settings-macos">
      <div className="ssm-shell" role="tablist" aria-label="个人中心">
        <aside className="ssm-aside">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`ssm-nav-item${tab === item.key ? ' on' : ''}`}
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </aside>

        <section className="ssm-main" role="tabpanel">
          {tab === 'profile' && (
            <>
              <div className="ssm-avatar-block">
                <span className="ssm-avatar" aria-hidden>{avatarChar}</span>
                <button
                  type="button"
                  className="ssm-avatar-action"
                  onClick={() => message.info('头像更换即将开放')}
                >
                  点击更换头像
                </button>
              </div>
              <div className="ssm-inset">
                <div className="ssm-field">
                  <label className="ssm-label">姓名<span className="req">*</span></label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} allowClear />
                </div>
              </div>
              <div className="ssm-actions">
                <Button type="primary" className="ssm-btn-primary" onClick={() => void save({ display_name: name })}>
                  保存
                </Button>
              </div>
            </>
          )}

          {tab === 'phone' && (
            <>
              <Steps
                className="ssm-steps"
                current={phoneStep}
                size="small"
                items={[{ title: '验证原手机号' }, { title: '绑定新手机号' }]}
              />
              {phoneStep === 0 ? (
                <>
                  <div className="ssm-inset">
                    <div className="ssm-field">
                      <label className="ssm-label">原手机号<span className="req">*</span></label>
                      <Input
                        value={hasBoundPhone ? boundPhone : '未绑定'}
                        readOnly={!hasBoundPhone}
                        className={hasBoundPhone ? undefined : 'ssm-phone-unbound'}
                        style={hasBoundPhone ? undefined : { color: '#8E8E93', cursor: 'default' }}
                        onChange={(e) => {
                          if (hasBoundPhone) setOldPhone(e.target.value);
                        }}
                      />
                    </div>
                  </div>
                  <div className="ssm-actions">
                    <Button className="ssm-btn-ghost" onClick={() => message.success('验证码已发送')}>
                      获取验证码
                    </Button>
                    <Button type="primary" className="ssm-btn-primary" onClick={() => setPhoneStep(1)}>
                      下一步
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="ssm-inset">
                    <div className="ssm-field">
                      <label className="ssm-label">新手机号<span className="req">*</span></label>
                      <Input value={nextPhone} onChange={(e) => setNextPhone(e.target.value)} />
                    </div>
                    <div className="ssm-field">
                      <label className="ssm-label">验证码</label>
                      <Input value={phoneCode} onChange={(e) => setPhoneCode(e.target.value)} />
                    </div>
                  </div>
                  <div className="ssm-actions">
                    <Button className="ssm-btn-ghost" onClick={() => setPhoneStep(0)}>
                      上一步
                    </Button>
                    <Button
                      type="primary"
                      className="ssm-btn-primary"
                      onClick={() => void save({ phone: nextPhone }).then(() => { setPhoneStep(0); setPhone(nextPhone); })}
                    >
                      确定
                    </Button>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'password' && (
            <>
              <div className="ssm-inset">
                <div className="ssm-field">
                  <label className="ssm-label">原密码<span className="req">*</span></label>
                  <Input.Password value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
                </div>
                <div className="ssm-field">
                  <label className="ssm-label">新密码<span className="req">*</span></label>
                  <Input.Password value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <div className="ssm-field">
                  <label className="ssm-label">重复新密码<span className="req">*</span></label>
                  <Input.Password value={again} onChange={(e) => setAgain(e.target.value)} />
                </div>
              </div>
              <div className="ssm-actions">
                <Button
                  type="primary"
                  className="ssm-btn-primary"
                  onClick={() => {
                    if (password !== again) { message.error('两次输入的新密码不一致'); return; }
                    void save({ old_password: oldPassword, password });
                  }}
                >
                  保存
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
