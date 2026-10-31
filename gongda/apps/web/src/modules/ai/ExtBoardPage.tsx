import { useEffect, useState } from 'react';
import { Button, Tag } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiRequest, errorMessage } from '../../api';
import { ExtFieldInputs } from '../../kgd/extensions/ExtFieldInputs';
import { useEntityExtensions, type ExtEntity } from '../../kgd/extensions/useEntityExtensions';

type AppItem = {
  id: string;
  title: string;
  status: 'enabled' | 'disabled' | 'rolled_back';
  entity: string;
  menu_label: string;
  spec: { view?: { kind?: string; title?: string }; fields?: { name: string; field_type: string }[] };
};

const ENTITIES = new Set<ExtEntity>(['work_order', 'customer_contract', 'sale_stock_out']);

export function ExtBoardPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const id = pathname.split('/ai/ext-board/')[1]?.split(/[/?]/)[0] ?? '';
  const [app, setApp] = useState<AppItem | null>(null);
  const [error, setError] = useState('');
  const entity = app && ENTITIES.has(app.entity as ExtEntity) ? (app.entity as ExtEntity) : null;
  const ext = useEntityExtensions(app?.status === 'enabled' ? entity : null);
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!id) return;
    void apiRequest<{ item: AppItem }>(`/api/ai/ext-apps/${id}`)
      .then((data) => setApp(data.item))
      .catch((failure) => setError(errorMessage(failure)));
  }, [id]);

  const statusText = app?.status === 'enabled' ? '启用' : app?.status === 'disabled' ? '停用' : '已回退';
  return (
    <div className="kgd-card" data-testid="sedric-ext-board">
      <h2>{app?.spec.view?.title || app?.title || '扩展视图'}</h2>
      {error && <div className="kgd-banner">{error}</div>}
      {app && (
        <>
          <p>
            <Tag>{statusText}</Tag>
            {app.menu_label ? ` 菜单「${app.menu_label}」` : ''}
            。这是系统内配置，挂在已有{app.entity === 'work_order' ? '加工单' : '单据'}上。
          </p>
          {app.status === 'rolled_back' && <p data-testid="sedric-ext-restored">已回退，字段与菜单已恢复。</p>}
          {app.status === 'disabled' && <p>已停用，加工单上暂时不显示该字段。</p>}
          {app.status === 'enabled' && (
            <div className="kgd-form" data-testid="sedric-ext-board-fields">
              <ExtFieldInputs fields={ext.fields.filter((field) => field.options?.sedric_app_id === app.id || ext.fields.length === 1)} values={values} onChange={setValues} />
              {!ext.fields.length && <span>字段加载中或已隐藏</span>}
            </div>
          )}
        </>
      )}
      <div style={{ marginTop: 16 }}>
        <Button onClick={() => navigate('/inside_produce_bill/add?mode=direct')}>打开加工单表单</Button>
        <Button onClick={() => navigate('/ai/ext-apps')}>返回扩展应用</Button>
      </div>
    </div>
  );
}
