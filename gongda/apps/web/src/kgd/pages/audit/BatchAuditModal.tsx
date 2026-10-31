import { useState } from 'react';
import { App, Button, Input, Modal, Radio } from 'antd';
import { apiRequest } from '../../../api';
import { useKgd } from '../../context';

export function BatchAuditModal({ objectType, ids, onClose }: { objectType: string; ids: string[]; onClose: () => void }) {
  const { message } = App.useApp();
  const { session, onChanged } = useKgd();
  const [status, setStatus] = useState<'通过' | '退回'>('通过');
  const [remark, setRemark] = useState('');
  const [attachment, setAttachment] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const result = await apiRequest<{ message: string }>('/api/audit/batch', { method: 'POST', csrfToken: session.csrf_token, body: { object_type: objectType, ids, action: status, remark, attachment } });
      message.success(result.message);
      onChanged();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '审核失败');
    } finally { setBusy(false); }
  }
  return <Modal title="批量审核" open onCancel={onClose} footer={<><Button onClick={onClose}>取消</Button><Button type="primary" loading={busy} onClick={() => void submit()}>确定</Button></>}>
    <div>审核状态</div>
    <div style={{ margin: '8px 0' }}><span style={{ color: '#f5222d' }}>*</span>状态 <Radio.Group value={status} onChange={(event) => setStatus(event.target.value)}><Radio value="通过">通过</Radio><Radio value="退回">退回</Radio></Radio.Group></div>
    <label style={{ display: 'block', border: '1px dashed #d9d9d9', padding: 16, marginBottom: 8 }}>
      选择文件 Ctrl+v 粘贴或拖拽文件到此处
      <input type="file" style={{ display: 'block', marginTop: 8 }} onChange={(event) => setAttachment(event.target.files?.[0]?.name ?? '')} />
      {attachment ? <div>{attachment}</div> : null}
    </label>
    <Input.TextArea maxLength={255} value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="备注" />
    <div style={{ textAlign: 'right', color: '#999' }}>{remark.length}/255</div>
  </Modal>;
}
