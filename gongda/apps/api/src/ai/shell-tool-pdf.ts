/**
 * P1 壳内小工具 · PDF 动作算子（鉴权由 register 层 member 保证）
 * 默认不写 MES；临时结果 TTL 清理；类型仅 PDF。
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Problem, type Actor } from '../services.js';
import type { Sql } from '../database.js';
import { writeActionAudit } from './audit.js';
import { PDF_DEFAULT_LIMITS } from './shell-tool.js';

export type PdfOp = 'merge' | 'split' | 'to_images' | 'extract_text';

export type PdfFileIn = { filename: string; buffer: Buffer };

type StoredResult = {
  id: string;
  tenant_id: string;
  created_at: number;
  expires_at: number;
  filename: string;
  mime: string;
  buffer: Buffer;
  meta?: Record<string, unknown>;
};

const results = new Map<string, StoredResult>();
const TTL_MS = 15 * 60 * 1000;
const MAX_MB = PDF_DEFAULT_LIMITS.max_mb;
const MAX_FILES = PDF_DEFAULT_LIMITS.max_files;
const MAX_PAGES = PDF_DEFAULT_LIMITS.max_pages;
const MAX_BYTES = MAX_MB * 1024 * 1024;

function scriptPath(): string {
  return '/opt/sedric01/apps/api/scripts/shell_pdf_ops.py';
}

function sweep() {
  const now = Date.now();
  for (const [id, row] of results) {
    if (row.expires_at <= now) results.delete(id);
  }
}

function assertPdf(file: PdfFileIn) {
  const name = String(file.filename || '').toLowerCase();
  if (!name.endsWith('.pdf')) {
    throw new Problem(422, 'PDF_TYPE', `仅允许 PDF 文件：${file.filename}`);
  }
  if (!file.buffer?.length) throw new Problem(422, 'EMPTY_FILE', '文件为空');
  if (file.buffer.length > MAX_BYTES) {
    throw new Problem(422, 'FILE_TOO_LARGE', `单文件不能超过 ${MAX_MB}MB`);
  }
  const head = file.buffer.subarray(0, 5).toString('utf8');
  if (!head.startsWith('%PDF')) {
    throw new Problem(422, 'PDF_TYPE', `不是合法 PDF：${file.filename}`);
  }
}

function runPython(payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [scriptPath()], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      py.kill('SIGKILL');
      reject(new Problem(504, 'PDF_TIMEOUT', 'PDF 处理超时'));
    }, 60_000);
    py.stdout.on('data', (c) => {
      stdout += String(c);
    });
    py.stderr.on('data', (c) => {
      stderr += String(c);
    });
    py.on('error', (err) => {
      clearTimeout(timer);
      reject(new Problem(500, 'PDF_SPAWN', `无法启动 PDF 助手：${err.message}`));
    });
    py.on('close', (code) => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(stdout || '{}') as Record<string, unknown>;
        if (!json.ok) {
          reject(
            new Problem(
              422,
              String(json.code || 'PDF_ERROR'),
              String(json.error || stderr || 'PDF 处理失败'),
            ),
          );
          return;
        }
        resolve(json);
      } catch (e) {
        reject(
          new Problem(
            500,
            'PDF_PARSE',
            `PDF 助手输出异常 (code=${code}): ${(stderr || stdout || String(e)).slice(0, 300)}`,
          ),
        );
      }
    });
    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });
}

function store(
  tenantId: string,
  filename: string,
  mime: string,
  buffer: Buffer,
  meta?: Record<string, unknown>,
): StoredResult {
  sweep();
  const id = randomUUID();
  const row: StoredResult = {
    id,
    tenant_id: tenantId,
    created_at: Date.now(),
    expires_at: Date.now() + TTL_MS,
    filename,
    mime,
    buffer,
    meta,
  };
  results.set(id, row);
  return row;
}

function b64ToBuf(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

export async function runShellPdfOp(sql: Sql, actor: Actor, op: PdfOp, files: PdfFileIn[]) {
  if (!files.length) throw new Problem(422, 'FILE_REQUIRED', '请上传 PDF');
  if (files.length > MAX_FILES) {
    throw new Problem(422, 'TOO_MANY_FILES', `最多 ${MAX_FILES} 个文件`);
  }
  const total = files.reduce((n, f) => n + (f.buffer?.length || 0), 0);
  if (total > MAX_BYTES * 2) {
    throw new Problem(422, 'FILE_TOO_LARGE', `合计大小超限（约 ${MAX_MB}MB×2）`);
  }
  for (const f of files) assertPdf(f);

  if (op === 'split' || op === 'to_images') {
    if (files.length !== 1) throw new Problem(422, 'TOO_MANY_FILES', '该动作一次只能 1 个 PDF');
  }
  if (op === 'merge' && files.length < 2) {
    throw new Problem(422, 'NEED_MORE', '合并至少需要 2 个 PDF');
  }

  const payload = {
    op,
    max_pages: MAX_PAGES,
    files: files.map((f) => ({
      filename: f.filename,
      bytes_b64: f.buffer.toString('base64'),
    })),
  };
  const result = await runPython(payload);

  const downloads: Array<{ id: string; filename: string; mime: string; size: number; url: string }> = [];
  let text: string | undefined;

  if (op === 'extract_text') {
    text = String(result.text || '');
    const buf = Buffer.from(text, 'utf8');
    const row = store(actor.tenant_id, 'extracted.txt', 'text/plain; charset=utf-8', buf, {
      pages: result.pages,
    });
    downloads.push({
      id: row.id,
      filename: row.filename,
      mime: row.mime,
      size: row.buffer.length,
      url: `/api/ai/shell-tools/pdf/download/${row.id}`,
    });
  } else if (op === 'merge') {
    const buf = b64ToBuf(String(result.bytes_b64 || ''));
    const row = store(actor.tenant_id, String(result.filename || 'merged.pdf'), 'application/pdf', buf, {
      pages: result.pages,
    });
    downloads.push({
      id: row.id,
      filename: row.filename,
      mime: row.mime,
      size: row.buffer.length,
      url: `/api/ai/shell-tools/pdf/download/${row.id}`,
    });
  } else {
    const parts = Array.isArray(result.parts) ? result.parts : [];
    for (const part of parts) {
      const p = part as Record<string, unknown>;
      const buf = b64ToBuf(String(p.bytes_b64 || ''));
      const mime = String(p.mime || (op === 'to_images' ? 'image/png' : 'application/pdf'));
      const row = store(actor.tenant_id, String(p.filename || 'part.bin'), mime, buf, {
        page: p.page,
      });
      downloads.push({
        id: row.id,
        filename: row.filename,
        mime: row.mime,
        size: row.buffer.length,
        url: `/api/ai/shell-tools/pdf/download/${row.id}`,
      });
    }
  }

  try {
    await writeActionAudit(sql, actor, {
      action: `shell_tool.pdf.${op}`.slice(0, 80),
      payload: {
        op: `pdf.${op}`,
        files: files.map((f) => f.filename),
        downloads: downloads.map((d) => d.id),
      },
      result: 'ok',
      meta: { capability: 'shell_tool', pages: result.pages, write_mes: false },
    });
  } catch {
    // 审计失败不阻断
  }

  return {
    op: `pdf.${op}`,
    pages: result.pages,
    downloads,
    text,
    limits: { max_mb: MAX_MB, max_files: MAX_FILES, max_pages: MAX_PAGES },
    write_mes: false,
    message: '处理完成，请下载结果（临时文件约 15 分钟后清理）',
  };
}

export function takeShellPdfDownload(tenantId: string, id: string): StoredResult {
  sweep();
  const row = results.get(id);
  if (!row || row.tenant_id !== tenantId) {
    throw new Problem(404, 'NOT_FOUND', '下载不存在或已过期');
  }
  if (row.expires_at <= Date.now()) {
    results.delete(id);
    throw new Problem(404, 'EXPIRED', '下载已过期');
  }
  return row;
}

export function shellPdfDigest(files: PdfFileIn[]) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.filename);
    h.update(f.buffer.subarray(0, Math.min(64, f.buffer.length)));
  }
  return h.digest('hex').slice(0, 16);
}

export async function ensurePdfScriptInstalled(content: string) {
  const dest = scriptPath();
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
  await fs.chmod(dest, 0o755);
}
