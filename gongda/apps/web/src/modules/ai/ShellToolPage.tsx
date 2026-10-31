import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Input, InputNumber, Space, Table, Typography, Upload, message } from 'antd';
import type { UploadFile } from 'antd/es/upload/interface';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, apiRequest, errorMessage } from '../../api';
import { useKgd } from '../../kgd/context';

type Widget =
  | { type: 'timer'; id?: string; props?: { modes?: Array<'stopwatch' | 'countdown'>; initial_seconds?: number; label?: string; work_minutes?: number; break_minutes?: number } }
  | { type: 'button'; id?: string; label: string; action: string }
  | { type: 'form'; id?: string; fields?: Array<{ name: string; label: string; input: 'number' | 'text'; default?: number | string }> }
  | { type: 'calculator'; id?: string; props?: { label?: string; preset?: 'basic' | 'qty_price'; initial_expr?: string } }
  | {
      type: 'table';
      id?: string;
      props?: {
        columns?: Array<{ key: string; label: string; input?: 'text' | 'number' }>;
        initial_rows?: Array<Record<string, string | number>>;
        persist?: 'none' | 'local';
      };
    }
  | {
      type: 'file_picker';
      id?: string;
      props?: { accept?: string; multiple?: boolean; label?: string; max_files?: number; max_mb?: number };
    };

type ToolSpec = {
  id: string;
  title: string;
  placement: 'sidebar' | 'chat_panel';
  ui: { layout: string; widgets: Widget[] };
  actions: Array<{ id: string; limits?: Record<string, unknown> }>;
};

type AppItem = {
  id: string;
  title: string;
  menu_label: string;
  menu_path: string;
  status: string;
  spec?: { kind?: string; tool?: ToolSpec; placement?: string };
};

function formatMs(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function operatorsOf(tool: ToolSpec) {
  const ops = new Set<string>();
  for (const w of tool.ui.widgets) ops.add(w.type);
  for (const a of tool.actions) ops.add(a.id);
  return Array.from(ops);
}

export function ShellToolPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { session } = useKgd();
  const pathname = location.pathname;
  const id = pathname.split('/ai/shell-tool/')[1]?.split(/[/?]/)[0] ?? '';
  const [app, setApp] = useState<AppItem | null>(null);
  const [mode, setMode] = useState<'stopwatch' | 'countdown'>('stopwatch');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [remain, setRemain] = useState(60_000);
  const [durationSec, setDurationSec] = useState(60);
  const [expr, setExpr] = useState('');
  const [calcValue, setCalcValue] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(0);
  const [rows, setRows] = useState<Array<Record<string, string | number> & { _key: string }>>([]);
  const [pdfFiles, setPdfFiles] = useState<UploadFile[]>([]);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfText, setPdfText] = useState('');
  const [downloads, setDownloads] = useState<Array<{ url: string; filename: string }>>([]);
  const tickRef = useRef<number | null>(null);
  const startedAt = useRef<number>(0);
  const baseElapsed = useRef(0);
  const baseRemain = useRef(60_000);

  const tool = app?.spec?.tool;

  useEffect(() => {
    if (!id) return;
    void apiRequest<{ item: AppItem }>(`/api/ai/ext-apps/${id}`)
      .then((data) => {
        setApp(data.item);
        const t = data.item.spec?.tool;
        const timer = t?.ui.widgets.find((w) => w.type === 'timer') as Extract<Widget, { type: 'timer' }> | undefined;
        const modes = timer?.props?.modes?.length ? timer.props.modes : ['stopwatch'];
        setMode(modes[0]);
        const workMin = Number(timer?.props?.work_minutes);
        const initSec =
          Number.isFinite(workMin) && workMin >= 1
            ? Math.floor(workMin) * 60
            : timer?.props?.initial_seconds
              ? Number(timer.props.initial_seconds)
              : modes[0] === 'countdown'
                ? 25 * 60
                : 60;
        const init = Math.max(1, initSec) * 1000;
        setRemain(init);
        baseRemain.current = init;
        setDurationSec(Math.round(init / 1000));
        const calc = t?.ui.widgets.find((w) => w.type === 'calculator') as Extract<Widget, { type: 'calculator' }> | undefined;
        if (calc?.props?.initial_expr) setExpr(calc.props.initial_expr);
        const table = t?.ui.widgets.find((w) => w.type === 'table') as Extract<Widget, { type: 'table' }> | undefined;
        if (table) {
          const initial = (table.props?.initial_rows || []).map((r, i) => ({ ...r, _key: `r${i}` }));
          setRows(initial);
        }
      })
      .catch((err) => message.error(errorMessage(err)));
  }, [id]);

  useEffect(() => {
    if (!running) {
      if (tickRef.current) window.clearInterval(tickRef.current);
      tickRef.current = null;
      return;
    }
    startedAt.current = Date.now();
    tickRef.current = window.setInterval(() => {
      const delta = Date.now() - startedAt.current;
      if (mode === 'stopwatch') setElapsed(baseElapsed.current + delta);
      else setRemain(Math.max(0, baseRemain.current - delta));
    }, 200);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [running, mode]);

  const display = useMemo(() => (mode === 'stopwatch' ? formatMs(elapsed) : formatMs(remain)), [mode, elapsed, remain]);

  async function runCalc() {
    try {
      const calc = tool?.ui.widgets.find((w) => w.type === 'calculator') as Extract<Widget, { type: 'calculator' }> | undefined;
      const body =
        calc?.props?.preset === 'qty_price'
          ? { qty, price }
          : { expr };
      const data = await apiRequest<{ value: number }>('/api/ai/shell-tools/calc/eval', {
        method: 'POST',
        body,
        csrfToken: session.csrf_token,
      });
      setCalcValue(data.value);
      message.success(`结果：${data.value}`);
    } catch (err) {
      message.error(errorMessage(err));
    }
  }

  async function runPdf(action: string) {
    const op = action.replace(/^pdf\./, '') as 'merge' | 'split' | 'to_images' | 'extract_text';
    const list = pdfFiles.map((f) => f.originFileObj).filter(Boolean) as File[];
    if (!list.length) {
      message.warning('请先选择 PDF');
      return;
    }
    setPdfBusy(true);
    setPdfText('');
    setDownloads([]);
    try {
      const fd = new FormData();
      for (const f of list) fd.append('files', f, f.name);
      const response = await fetch(`/api/ai/shell-tools/pdf/${op}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRF-Token': session.csrf_token },
        body: fd,
      });
      const payload = (await response.json().catch(() => null)) as {
        text?: string;
        downloads?: Array<{ url: string; filename: string }>;
        message?: string;
        error?: { code?: string; message?: string };
      } | null;
      if (!response.ok) {
        throw new ApiError(
          response.status,
          payload?.error?.code ?? `HTTP_${response.status}`,
          payload?.error?.message ?? 'PDF 处理失败',
        );
      }
      if (payload?.text) setPdfText(payload.text);
      setDownloads(payload?.downloads || []);
      message.success(payload?.message || '处理完成');
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setPdfBusy(false);
    }
  }

  function runAction(action: string) {
    if (action === 'timer.start') {
      if (mode === 'countdown' && remain <= 0) {
        baseRemain.current = durationSec * 1000;
        setRemain(baseRemain.current);
      }
      setRunning(true);
      return;
    }
    if (action === 'timer.pause') {
      if (mode === 'stopwatch') baseElapsed.current = elapsed;
      else baseRemain.current = remain;
      setRunning(false);
      return;
    }
    if (action === 'timer.reset') {
      setRunning(false);
      baseElapsed.current = 0;
      setElapsed(0);
      const init = durationSec * 1000;
      baseRemain.current = init;
      setRemain(init);
      return;
    }
    if (action === 'timer.set_duration') {
      const init = durationSec * 1000;
      baseRemain.current = init;
      setRemain(init);
      setRunning(false);
      return;
    }
    if (action === 'calc.eval') {
      void runCalc();
      return;
    }
    if (action === 'table.add_row') {
      const table = tool?.ui.widgets.find((w) => w.type === 'table') as Extract<Widget, { type: 'table' }> | undefined;
      const cols = table?.props?.columns || [];
      const row: Record<string, string | number> & { _key: string } = { _key: `r${Date.now()}` };
      for (const c of cols) row[c.key] = c.input === 'number' ? 0 : '';
      setRows((prev) => [...prev, row]);
      return;
    }
    if (action === 'table.delete_row') {
      setRows((prev) => prev.slice(0, -1));
      return;
    }
    if (action.startsWith('pdf.')) {
      void runPdf(action);
    }
  }

  if (!id) return <Card>缺少工具 id</Card>;
  if (!app) return <Card>加载中…</Card>;
  if (app.status !== 'enabled' || app.spec?.kind !== 'shell_tool' || !tool) {
    return (
      <Card title="壳内工具">
        <Typography.Paragraph>该工具未启用或不存在。</Typography.Paragraph>
        <Button onClick={() => navigate('/ai/ext-apps')}>返回扩展应用</Button>
      </Card>
    );
  }

  const timerWidget = tool.ui.widgets.find((w) => w.type === 'timer') as Extract<Widget, { type: 'timer' }> | undefined;
  const modes = timerWidget?.props?.modes?.length ? timerWidget.props.modes : timerWidget ? ['stopwatch'] : [];
  const ops = operatorsOf(tool);

  return (
    <div className="kgd-card sedric-ai-center" data-testid="sedric-shell-tool-page">
      <Card
        title={tool.title || app.title}
        extra={
          <Space>
            <Button onClick={() => navigate('/ai/ext-apps')}>扩展应用</Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Spec 驱动 · placement={tool.placement} · 主色 #4184F4 · 不写 MES
          <br />
          将使用的算子：{ops.join('、')}
        </Typography.Paragraph>

        {modes.length ? (
          <>
            {modes.length > 1 ? (
              <Space style={{ marginBottom: 12 }}>
                {modes.map((m) => (
                  <Button
                    key={m}
                    type={mode === m ? 'primary' : 'default'}
                    onClick={() => {
                      setRunning(false);
                      setMode(m as 'stopwatch' | 'countdown');
                    }}
                  >
                    {m === 'stopwatch' ? '正计时' : '倒计时'}
                  </Button>
                ))}
              </Space>
            ) : null}
            <div
              data-testid="sedric-shell-timer-display"
              style={{
                fontSize: 48,
                fontWeight: 600,
                color: '#4184F4',
                letterSpacing: 2,
                margin: '16px 0',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {display}
            </div>
          </>
        ) : null}

        {tool.ui.widgets.map((w, idx) => {
          if (w.type === 'calculator') {
            const qtyPrice = w.props?.preset === 'qty_price';
            return (
              <div key={w.id || idx} style={{ marginBottom: 16 }} data-testid="sedric-shell-calculator">
                <Typography.Text strong>{w.props?.label || '计算器'}</Typography.Text>
                {qtyPrice ? (
                  <Space style={{ display: 'flex', marginTop: 8 }}>
                    <span>
                      数量：
                      <InputNumber min={0} value={qty} onChange={(v) => setQty(Number(v) || 0)} />
                    </span>
                    <span>
                      单价：
                      <InputNumber min={0} value={price} onChange={(v) => setPrice(Number(v) || 0)} />
                    </span>
                  </Space>
                ) : (
                  <Input
                    style={{ marginTop: 8 }}
                    value={expr}
                    placeholder="例如 12*3+5% （禁任意 JS）"
                    onChange={(e) => setExpr(e.target.value)}
                  />
                )}
                {calcValue != null ? (
                  <div style={{ marginTop: 8, color: '#4184F4', fontSize: 28, fontWeight: 600 }}>{calcValue}</div>
                ) : null}
              </div>
            );
          }
          if (w.type === 'table') {
            const cols = (w.props?.columns || []).map((c) => ({
              title: c.label,
              dataIndex: c.key,
              key: c.key,
              render: (_: unknown, row: Record<string, string | number> & { _key: string }) =>
                c.input === 'number' ? (
                  <InputNumber
                    value={Number(row[c.key]) || 0}
                    onChange={(v) =>
                      setRows((prev) =>
                        prev.map((r) => (r._key === row._key ? { ...r, [c.key]: Number(v) || 0 } : r)),
                      )
                    }
                  />
                ) : (
                  <Input
                    value={String(row[c.key] ?? '')}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) => (r._key === row._key ? { ...r, [c.key]: e.target.value } : r)),
                      )
                    }
                  />
                ),
            }));
            cols.push({
              title: '操作',
              dataIndex: '_key',
              key: '_op',
              render: (_: unknown, row: Record<string, string | number> & { _key: string }) => (
                <Button
                  size="small"
                  danger
                  onClick={() => setRows((prev) => prev.filter((r) => r._key !== row._key))}
                >
                  删除
                </Button>
              ),
            } as never);
            return (
              <div key={w.id || idx} style={{ marginBottom: 16 }} data-testid="sedric-shell-table">
                <Table size="small" pagination={false} rowKey="_key" dataSource={rows} columns={cols as never} />
              </div>
            );
          }
          if (w.type === 'file_picker') {
            const acc = w.props?.accept || 'application/pdf';
            const isImage = /image\//i.test(acc) || String(acc).includes('image');
            const isPdf = /pdf/i.test(acc) && !isImage;
            const defaultLabel = isImage ? '选择图片' : isPdf ? '选择 PDF' : '选择文件';
            const hint = isImage
              ? `图片 jpeg/png/webp/gif · 上限约 ${w.props?.max_mb || 5}MB / ${w.props?.max_files || 1} 个 · 不写 MES`
              : isPdf
                ? `仅 PDF · 上限约 ${w.props?.max_mb || 20}MB / ${w.props?.max_files || 10} 个文件 · 不写 MES`
                : `上限约 ${w.props?.max_mb || 20}MB / ${w.props?.max_files || 10} 个文件 · 不写 MES`;
            return (
              <div key={w.id || idx} style={{ marginBottom: 16 }} data-testid="sedric-shell-file-picker">
                <Upload
                  multiple={w.props?.multiple !== false}
                  accept={acc}
                  beforeUpload={() => false}
                  fileList={pdfFiles}
                  onChange={({ fileList }) => setPdfFiles(fileList.slice(0, w.props?.max_files || 10))}
                >
                  <Button type="dashed">{w.props?.label || defaultLabel}</Button>
                </Upload>
                <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
                  {hint}
                </Typography.Text>
              </div>
            );
          }
          if (w.type === 'form') {
            const isDuration = (w.fields || []).some((f) => f.name === 'seconds');
            const isQtyPrice = (w.fields || []).some((f) => f.name === 'qty' || f.name === 'price');
            if (isQtyPrice) return null;
            return (
              <Space key={w.id || idx} style={{ marginBottom: 12 }}>
                {(w.fields || []).map((f) => (
                  <span key={f.name}>
                    {f.label}：
                    {isDuration ? (
                      <InputNumber min={1} max={86400} value={durationSec} onChange={(v) => setDurationSec(Number(v) || 60)} />
                    ) : f.input === 'number' ? (
                      <InputNumber />
                    ) : (
                      <Input style={{ width: 120 }} />
                    )}
                  </span>
                ))}
                {isDuration ? <Button onClick={() => runAction('timer.set_duration')}>应用秒数</Button> : null}
              </Space>
            );
          }
          if (w.type === 'button') {
            return (
              <Button
                key={w.id || idx}
                type={w.action === 'timer.start' || w.action === 'calc.eval' || w.action.startsWith('pdf.') ? 'primary' : 'default'}
                style={{ marginRight: 8, marginBottom: 8 }}
                loading={pdfBusy && w.action.startsWith('pdf.')}
                onClick={() => runAction(w.action)}
              >
                {w.label}
              </Button>
            );
          }
          return null;
        })}

        {downloads.length ? (
          <div style={{ marginTop: 12 }}>
            <Typography.Text strong>下载结果：</Typography.Text>
            <ul>
              {downloads.map((d) => (
                <li key={d.url}>
                  <a href={d.url} target="_blank" rel="noreferrer">
                    {d.filename}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {pdfText ? (
          <pre
            style={{
              marginTop: 12,
              maxHeight: 240,
              overflow: 'auto',
              background: '#f6f8fc',
              padding: 12,
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
            }}
          >
            {pdfText}
          </pre>
        ) : null}
      </Card>
    </div>
  );
}
