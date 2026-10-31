import { useState } from 'react';
import { Button, Checkbox, Input, InputNumber, Modal, Select, Tooltip } from 'antd';
import { useRemote } from '../../../masterTools';
import { useKgd } from '../../context';
import { showError, useCommand, useQueryState } from '../../kit';
import { ListFrame } from '../../ListFrame';
import { ruleFormulaText, rulePreviewText } from './shared';
import type { CodeElement, CodeRule } from './shared';

const dateTypes = [{ value: 'fixed', label: '固定文本' }, { value: 'date', label: '提交日期' }, { value: 'empty', label: '空值' }];

export function CodeRules() {
  const { revision, onExpired } = useKgd();
  const command = useCommand();
  const list = useQueryState();
  const remote = useRemote<{ items: CodeRule[] }>('/api/configuration/custom-code-rules', revision, onExpired);
  const [editing, setEditing] = useState<CodeRule | null>(null);
  const [config, setConfig] = useState<CodeRule['config'] | null>(null);
  function open(rule: CodeRule) {
    setEditing(rule);
    setConfig(structuredClone(rule.config));
  }
  function patchElement(index: number, next: Partial<CodeElement>) {
    setConfig((current) => current ? { ...current, elements: current.elements.map((element, item) => item === index ? { ...element, ...next } : element) } : current);
  }
  async function submit() {
    if (!editing || !config) return;
    try {
      await command.send(`/api/configuration/custom-code-rules/${editing.id}`, { version: editing.version, config }, 'PATCH');
      setEditing(null);
    } catch (failure) { command.setError(showError(failure)); }
  }
  const rows = remote.data?.items ?? [];
  return <div className="kgd-card">
    {command.error && <div className="kgd-banner">{command.error}</div>}
    <ListFrame pageKey="code-rules" rows={rows} loading={remote.loading} error={remote.error}
      queryFields={[{ key: 'name', label: '编号名称' }]} queryValue={list.draft} onQuery={list.onQuery} onSearch={list.onSearch} onClear={list.onClear}
      page={list.page} pageSize={list.pageSize} total={rows.length} onPage={list.onPage}
      columns={[
        { key: 'seq', title: '编号', render: (_row, index) => (index ?? 0) + 1 },
        { key: 'name', title: '编号名称', render: (row) => row.name },
        { key: 'formula', title: '编号规则', render: (row) => row.formula.split('=').slice(1).join('=') },
        { key: 'preview', title: '编号预览', render: (row) => row.preview },
        { key: 'actions', title: '操作', render: (row) => <Button type="link" onClick={() => open(row)}>修改</Button> },
      ]} />
    <Modal title="编辑编号规则" open={!!editing && !!config} width={760} onCancel={() => setEditing(null)} footer={<><Button onClick={() => setEditing(null)}>关闭</Button><Button type="primary" loading={command.busy} onClick={() => void submit()}>提交</Button></>} destroyOnHidden>
      {editing && config && <div className="kgd-form">
        <span>编号名称</span><Input value={editing.name} disabled />
        {config.elements.map((element, index) => <span key={index} style={{ display: 'contents' }}>
          <span>元素{index + 1}</span>
          <div className="goods-pair">
            <Select style={{ width: 140 }} value={element.type} options={dateTypes} onChange={(type) => patchElement(index, { type })} />
            {element.type === 'fixed' && <Tooltip title="元素文本限制为数字和英文，不得超过9位。"><Input placeholder="固定文本" maxLength={9} value={element.text ?? ''} onChange={(event) => patchElement(index, { text: event.target.value })} /></Tooltip>}
            {element.type === 'date' && <>
              <Select style={{ width: 120 }} value={element.date_format ?? 'ymd'} options={[{ value: 'ymd', label: '年月日' }, { value: 'ym', label: '年月' }, { value: 'y', label: '年' }]} onChange={(date_format) => patchElement(index, { date_format })} />
              <Checkbox checked={!!element.short_year} onChange={(event) => patchElement(index, { short_year: event.target.checked })}>显示短年份</Checkbox>
            </>}
            <Select style={{ width: 100 }} disabled={index < 3 && config.elements[index + 1]?.type === 'empty'} value={element.separator ?? ''} options={[{ value: '', label: '空' }, { value: '-', label: '-' }]} onChange={(separator) => patchElement(index, { separator })} />
          </div>
        </span>)}
        <span>流水号</span><span><Tooltip title="最高9位，流水号超限时位数自动提升1位"><InputNumber min={1} max={9} value={config.seq_digits} onChange={(seq_digits) => setConfig({ ...config, seq_digits: Number(seq_digits ?? 1) })} /></Tooltip> 位</span>
        <span>起始流水号</span><InputNumber min={1} value={config.seq_start} onChange={(seq_start) => setConfig({ ...config, seq_start: Number(seq_start ?? 1) })} />
        <span /><Tooltip title="选中后，流水号禁用补零；未选中时，流水号通过0自动补上缺失位数"><Checkbox checked={config.show_abbrev} onChange={(event) => setConfig({ ...config, show_abbrev: event.target.checked })}>显示简写</Checkbox></Tooltip>
        <span className="wide">{ruleFormulaText(editing.name, config)}</span>
        <span>编号预览</span><span>{rulePreviewText(config)}</span>
      </div>}
    </Modal>
  </div>;
}
