import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { Problem, type Services } from '../services.js';
import { member } from '../r10-kit.js';
import { listActionAudit } from './audit.js';
import { assistantMeta, runAssistantChat, type ChatMessage, type ChatMode, type PageContext } from './assistant.js';
import {
  confirmBomImport,
  discardPreview,
  listSchemes,
  parseBomUpload,
  saveScheme,
} from './bom.js';
import { readAiConfig } from './config.js';
import {
  confirmDrawingSplit,
  discardDrawingPreview,
  parseDrawingUpload,
} from './drawing.js';
import {
  factoryBriefingMeta,
  factoryBriefingSubscribe,
  runFactoryAsk,
} from './factory.js';
import { classifyIntakeUpload, resolveIntakeAsk, type IntakeKind } from './intake.js';
import {
  confirmQuickOrder,
  discardQuickPreview,
  getQuota,
  parseQuickOrderUpload,
} from './quick-order.js';
import {
  cancelUnifiedWrite,
  confirmUnifiedWrite,
  recordWriteFailureAudit,
  type WriteConfirmBody,
} from './writes.js';
import { listGlossary, previewGlossaryChat, previewGlossaryStructured } from './glossary.js';
import { getExtApp, listExtApps, previewExtChat, previewExtStructured, resolveExtAsk } from './ext-app.js';
import { createLiteRecord, listLiteRecords, patchLiteRecord } from './lite-app.js';
import { runShellPdfOp, takeShellPdfDownload, type PdfOp } from './shell-tool-pdf.js';
import { extractImageFields } from './shell-tool-vision.js';
import { safeEvalExpression, shellOperatorHint } from './shell-tool.js';

type ChatBody = {
  messages?: ChatMessage[];
  mode?: string;
  context?: { path?: unknown; title?: unknown };
};

function parsePageContext(value: ChatBody['context']): PageContext | null {
  if (!value || typeof value !== 'object') return null;
  const path = typeof value.path === 'string' ? value.path.trim().slice(0, 200) : '';
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 200) : '';
  if (!path && !title) return null;
  return { path: path || undefined, title: title || undefined };
}

type FactoryAskBody = {
  question?: unknown;
  signal?: unknown;
};

function parseMode(value: unknown): ChatMode {
  return value === 'deep' ? 'deep' : 'quick';
}

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) throw new Problem(422, 'INVALID_MESSAGES', 'messages 必须是数组');
  if (value.length > 40) throw new Problem(422, 'TOO_MANY', '单次最多 40 条消息');
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Problem(422, 'INVALID_MESSAGES', '消息格式不正确');
    const row = item as { role?: unknown; content?: unknown };
    const role = row.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw new Problem(422, 'INVALID_ROLE', '消息角色只能是 user/assistant/system');
    }
    const content = typeof row.content === 'string' ? row.content.trim() : '';
    if (!content) throw new Problem(422, 'EMPTY_CONTENT', '消息内容不能为空');
    if (content.length > 4000) throw new Problem(422, 'TOO_LONG', '单条消息不能超过 4000 字');
    out.push({ role, content });
  }
  return out;
}

async function readUpload(request: FastifyRequest, label = '请上传 Excel / CSV / PDF') {
  const file = await request.file();
  if (!file) throw new Problem(422, 'FILE_REQUIRED', label);
  const filename = file.filename || 'upload.csv';
  const buffer = await file.toBuffer();
  if (!buffer.length) throw new Problem(422, 'EMPTY_FILE', '文件为空');
  if (buffer.length > 5 * 1024 * 1024) throw new Problem(422, 'FILE_TOO_LARGE', '文件不能超过 5MB');
  return { filename, buffer };
}

async function readDrawingUpload(request: FastifyRequest) {
  const parts = request.parts();
  let filename = '';
  let buffer: Buffer | null = null;
  let note = '';
  for await (const part of parts) {
    if (part.type === 'file') {
      if (buffer) throw new Problem(422, 'TOO_MANY_FILES', '一次只能上传一个文件');
      filename = part.filename || 'drawing.pdf';
      buffer = await part.toBuffer();
    } else {
      const field = part.fieldname || '';
      if (field === 'note' || field === 'description' || field === 'remark') {
        const value = String((part as { value?: unknown }).value ?? '').trim();
        if (value) note = value.slice(0, 2000);
      }
    }
  }
  if (!buffer) throw new Problem(422, 'FILE_REQUIRED', '请上传 PDF 或图片');
  if (!buffer.length) throw new Problem(422, 'EMPTY_FILE', '文件为空');
  if (buffer.length > 5 * 1024 * 1024) throw new Problem(422, 'FILE_TOO_LARGE', '文件不能超过 5MB');
  return { filename: filename || 'drawing.pdf', buffer, note };
}

async function readIntakeUpload(request: FastifyRequest) {
  const parts = request.parts();
  let filename = '';
  let buffer: Buffer | null = null;
  let note = '';
  let forceKind: IntakeKind | undefined;
  for await (const part of parts) {
    if (part.type === 'file') {
      if (buffer) throw new Problem(422, 'TOO_MANY_FILES', '一次只能上传一个文件');
      filename = part.filename || 'attachment.bin';
      buffer = await part.toBuffer();
    } else {
      const field = part.fieldname || '';
      const value = String((part as { value?: unknown }).value ?? '').trim();
      if ((field === 'note' || field === 'description' || field === 'remark') && value) {
        note = value.slice(0, 2000);
      }
      if (field === 'force_kind' || field === 'kind') {
        if (
          value === 'order_doc' ||
          value === 'business_card' ||
          value === 'other' ||
          value === 'unknown'
        ) {
          forceKind = value;
        }
      }
    }
  }
  if (!buffer) throw new Problem(422, 'FILE_REQUIRED', '请上传附件');
  if (!buffer.length) throw new Problem(422, 'EMPTY_FILE', '文件为空');
  if (buffer.length > 5 * 1024 * 1024) throw new Problem(422, 'FILE_TOO_LARGE', '文件不能超过 5MB');
  return { filename: filename || 'attachment.bin', buffer, note, forceKind };
}


async function readShellPdfFiles(request: FastifyRequest) {
  const parts = request.parts();
  const files: { filename: string; buffer: Buffer }[] = [];
  let opField = '';
  for await (const part of parts) {
    if (part.type === 'file') {
      if (files.length >= 10) throw new Problem(422, 'TOO_MANY_FILES', '最多 10 个 PDF');
      const filename = part.filename || `file-${files.length + 1}.pdf`;
      const buffer = await part.toBuffer();
      files.push({ filename, buffer });
    } else {
      const field = part.fieldname || '';
      const value = String((part as { value?: unknown }).value ?? '').trim();
      if (field === 'op' && value) opField = value;
    }
  }
  return { files, opField };
}

async function readShellVisionImage(request: FastifyRequest) {
  const parts = request.parts();
  let filename = '';
  let buffer: Buffer | null = null;
  let mime = '';
  for await (const part of parts) {
    if (part.type === 'file') {
      if (buffer) throw new Problem(422, 'TOO_MANY_FILES', '一次只能上传一张图片');
      filename = part.filename || 'image.png';
      mime = String((part as { mimetype?: string }).mimetype || '');
      buffer = await part.toBuffer();
    }
  }
  if (!buffer) throw new Problem(422, 'FILE_REQUIRED', '请上传图片');
  if (!buffer.length) throw new Problem(422, 'EMPTY_FILE', '图片为空');
  if (buffer.length > 5 * 1024 * 1024) throw new Problem(422, 'FILE_TOO_LARGE', '图片不能超过 5MB');
  return { filename: filename || 'image.png', buffer, mime };
}

export function registerAi(app: FastifyInstance, services: Services) {
  const read = <T>(request: FastifyRequest, work: () => Promise<T> | T) =>
    member(services, request, false, async () => work());

  app.get('/api/ai/assistant/meta', (request) => read(request, () => assistantMeta()));

  app.post('/api/ai/assistant/chat', async (request, reply) => {
    const result = await member(services, request, false, async () => {
      const body = (request.body ?? {}) as ChatBody;
      const messages = parseMessages(body.messages ?? []);
      const mode = parseMode(body.mode);
      const pageContext = parsePageContext(body.context);
      return runAssistantChat(messages, mode, readAiConfig(), pageContext);
    });
    return reply.send(result);
  });

  app.post('/api/ai/factory/ask', async (request, reply) => {
    const result = await member(services, request, false, async (sql, actor) => {
      const body = (request.body ?? {}) as FactoryAskBody;
      const question = typeof body.question === 'string' ? body.question : '';
      return runFactoryAsk(sql, actor, question, readAiConfig());
    });
    return reply.send(result);
  });

  /** S1：晨报/异常推送接口形状（stub，本冲刺不真正推送） */
  app.get('/api/ai/factory/briefing', (request) =>
    read(request, () => factoryBriefingMeta()),
  );

  app.post('/api/ai/factory/briefing/subscribe', async (request, reply) => {
    const result = await member(services, request, false, async () => {
      const body = (request.body ?? {}) as { channel?: unknown; cron?: unknown; topics?: unknown };
      return factoryBriefingSubscribe(body);
    });
    return reply.send(result);
  });

  /** S0：统一写库确认 / 取消（确认前不写；失败审计走独立事务，避免随业务回滚） */
  app.post('/api/ai/writes/confirm', async (request, reply) => {
    const body = (request.body ?? {}) as WriteConfirmBody;
    try {
      const result = await member(services, request, true, async (sql, actor) =>
        confirmUnifiedWrite(sql, actor, body),
      );
      return reply.code(201).send(result);
    } catch (error) {
      await member(services, request, false, async (sql, actor) =>
        recordWriteFailureAudit(sql, actor, 'write.confirm', body, error),
      ).catch(() => undefined);
      throw error;
    }
  });

  app.post('/api/ai/writes/cancel', async (request, reply) => {
    const body = (request.body ?? {}) as { preview_id?: unknown; kind?: unknown };
    try {
      const result = await member(services, request, false, async (sql, actor) =>
        cancelUnifiedWrite(sql, actor, body),
      );
      return reply.send(result);
    } catch (error) {
      await member(services, request, false, async (sql, actor) =>
        recordWriteFailureAudit(sql, actor, 'write.cancel', body, error),
      ).catch(() => undefined);
      throw error;
    }
  });

  app.get('/api/ai/writes/audit', async (request, reply) => {
    const result = await member(services, request, false, async (sql) => {
      const q = request.query as { preview_id?: string; limit?: string };
      const limit = q.limit ? Number(q.limit) : 50;
      const items = await listActionAudit(sql, {
        preview_id: typeof q.preview_id === 'string' ? q.preview_id : undefined,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      return { items };
    });
    return reply.send(result);
  });

  // parse 需要 multipart：与插件同封装
  void app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    });
    scoped.post('/api/ai/bom/parse', async (request, reply) => {
      const result = await member(services, request, false, async (sql, actor) => {
        const { filename, buffer } = await readUpload(request);
        return parseBomUpload(sql, actor, buffer, filename, readAiConfig());
      });
      return reply.send(result);
    });

    scoped.post('/api/ai/quick-order/parse', async (request, reply) => {
      const result = await member(services, request, false, async (sql, actor) => {
        const { filename, buffer } = await readUpload(request, '请上传单据图 / PDF / Excel');
        return parseQuickOrderUpload(sql, actor, buffer, filename, readAiConfig());
      });
      return reply.send(result);
    });

    scoped.post('/api/ai/drawing/parse', async (request, reply) => {
      const result = await member(services, request, false, async (sql, actor) => {
        const { filename, buffer, note } = await readDrawingUpload(request);
        return parseDrawingUpload(sql, actor, buffer, filename, note, readAiConfig());
      });
      return reply.send(result);
    });

    /** S0/S2：附件认型 */
    scoped.post('/api/ai/intake/classify', async (request, reply) => {
      const result = await member(services, request, false, async (sql, actor) => {
        const { filename, buffer, note, forceKind } = await readIntakeUpload(request);
        return classifyIntakeUpload(sql, actor, buffer, filename, note, forceKind);
      });
      return reply.send(result);
    });
  });

  /** S2：other/unknown 追问决议（禁止静默落单） */
  app.post('/api/ai/intake/resolve', async (request, reply) => {
    const result = await member(services, request, false, async (sql, actor) => {
      const body = (request.body ?? {}) as { ask_id?: unknown; option_id?: unknown };
      return resolveIntakeAsk(sql, actor, body);
    });
    return reply.send(result);
  });

  app.post('/api/ai/bom/confirm', async (request, reply) => {
    const result = await member(services, request, true, async (sql, actor) => {
      const body = (request.body ?? {}) as {
        preview_id?: unknown;
        mapping?: unknown;
        product_id?: unknown;
        name?: unknown;
      };
      return confirmBomImport(sql, actor, body);
    });
    return reply.code(201).send(result);
  });

  app.post('/api/ai/bom/cancel', async (request, reply) => {
    const result = await member(services, request, false, async (_sql, actor) => {
      const body = (request.body ?? {}) as { preview_id?: unknown };
      const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
      if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
      return discardPreview(previewId, actor.tenant_id);
    });
    return reply.send(result);
  });

  app.get('/api/ai/bom/schemes', async (request, reply) => {
    const result = await member(services, request, false, async (_sql, actor) => ({
      items: listSchemes(actor.tenant_id),
    }));
    return reply.send(result);
  });

  app.post('/api/ai/bom/schemes', async (request, reply) => {
    const result = await member(services, request, false, async (_sql, actor) => {
      const body = (request.body ?? {}) as { name?: unknown; mapping?: unknown };
      return saveScheme(actor.tenant_id, body.name, body.mapping);
    });
    return reply.code(201).send(result);
  });

  app.get('/api/ai/quick-order/quota', async (request, reply) => {
    const result = await member(services, request, false, async (_sql, actor) => getQuota(actor.tenant_id));
    return reply.send(result);
  });

  app.post('/api/ai/quick-order/confirm', async (request, reply) => {
    const result = await member(services, request, true, async (sql, actor) => {
      const body = (request.body ?? {}) as {
        preview_id?: unknown;
        target?: unknown;
        overrides?: unknown;
      };
      return confirmQuickOrder(sql, actor, body);
    });
    return reply.code(201).send(result);
  });

  app.post('/api/ai/quick-order/cancel', async (request, reply) => {
    const result = await member(services, request, false, async (_sql, actor) => {
      const body = (request.body ?? {}) as { preview_id?: unknown };
      const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
      if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
      return discardQuickPreview(previewId, actor.tenant_id);
    });
    return reply.send(result);
  });

  app.post('/api/ai/drawing/confirm', async (request, reply) => {
    const result = await member(services, request, true, async (sql, actor) => {
      const body = (request.body ?? {}) as {
        preview_id?: unknown;
        mode?: unknown;
        work_order_id?: unknown;
        sync_work_order?: unknown;
        steps?: unknown;
        route_name?: unknown;
      };
      return confirmDrawingSplit(sql, actor, body);
    });
    return reply.code(201).send(result);
  });

  /** S3：本厂词典 + 一句话扩展。聊天入口；确认前不写业务表。 */
  app.post('/api/ai/s3/chat', async (request, reply) => {
    const result = await member(services, request, false, async (sql, actor) => {
      const body = (request.body ?? {}) as { text?: unknown; question?: unknown };
      const text = typeof body.text === 'string' ? body.text : typeof body.question === 'string' ? body.question : '';
      const glossary = await previewGlossaryChat(sql, actor, text);
      if (glossary.handled) return glossary;
      const ext = await previewExtChat(sql, actor, text);
      if (ext.handled) return ext;
      return { handled: false as const };
    });
    return reply.send(result);
  });

  /** 一句话扩展多步确认（位置/属性） */
  app.post('/api/ai/ext/resolve', async (request, reply) => {
    const result = await member(services, request, false, async (sql, actor) => {
      const body = (request.body ?? {}) as { ask_id?: unknown; option_id?: unknown };
      return resolveExtAsk(sql, actor, body);
    });
    return reply.send(result);
  });

  app.get('/api/ai/glossary', async (request, reply) => {
    const result = await member(services, request, false, async (sql) => listGlossary(sql));
    return reply.send(result);
  });

  app.post('/api/ai/glossary/preview', async (request, reply) => {
    const result = await member(services, request, false, async (sql, actor) => {
      const body = (request.body ?? {}) as { text?: unknown };
      if (typeof body.text === 'string' && body.text.trim()) {
        const chat = await previewGlossaryChat(sql, actor, body.text);
        if (!chat.handled || chat.mode !== 'preview') {
          throw new Problem(422, 'UTTERANCE', '这句话不会改词典。查看词典请直接问「本厂词典有哪些」。');
        }
        return chat;
      }
      return previewGlossaryStructured(sql, actor, (request.body ?? {}) as Record<string, unknown>);
    });
    return reply.send(result);
  });

  app.get('/api/ai/ext-apps', async (request, reply) => {
    const result = await member(services, request, false, async (sql) => {
      const q = request.query as { status?: string };
      const status = q.status === 'enabled' || q.status === 'disabled' || q.status === 'rolled_back' ? q.status : undefined;
      return listExtApps(sql, status);
    });
    return reply.send(result);
  });

  app.get('/api/ai/ext-apps/:id', async (request, reply) => {
    const result = await member(services, request, false, async (sql) => {
      const id = (request.params as { id?: string }).id ?? '';
      return getExtApp(sql, id);
    });
    return reply.send(result);
  });

  app.post('/api/ai/ext-apps/preview', async (request, reply) => {
    const result = await member(services, request, false, async (sql, actor) =>
      previewExtStructured(sql, actor, (request.body ?? {}) as { text?: unknown; op?: unknown; id?: unknown }),
    );
    return reply.send(result);
  });


  app.get('/api/ai/lite-apps/:appId/records', async (request, reply) => {
    const result = await member(services, request, false, async (sql) => {
      const appId = (request.params as { appId?: string }).appId ?? '';
      const q = request.query as { status?: string };
      const status = typeof q.status === 'string' && q.status.trim() ? q.status.trim() : undefined;
      return listLiteRecords(sql, appId, status);
    });
    return reply.send(result);
  });

  app.post('/api/ai/lite-apps/:appId/records', async (request, reply) => {
    const result = await member(services, request, true, async (sql, actor) => {
      const appId = (request.params as { appId?: string }).appId ?? '';
      return createLiteRecord(sql, actor, appId, (request.body ?? {}) as Record<string, unknown>);
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/ai/lite-apps/:appId/records/:id', async (request, reply) => {
    const result = await member(services, request, true, async (sql, actor) => {
      const params = request.params as { appId?: string; id?: string };
      return patchLiteRecord(sql, actor, params.appId ?? '', params.id ?? '', (request.body ?? {}) as Record<string, unknown>);
    });
    return reply.send(result);
  });

  app.post('/api/ai/drawing/cancel', async (request, reply) => {
    const result = await member(services, request, false, async (_sql, actor) => {
      const body = (request.body ?? {}) as { preview_id?: unknown };
      const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
      if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
      return discardDrawingPreview(previewId, actor.tenant_id);
    });
    return reply.send(result);
  });


  // P1 壳内工具：PDF 算子（更大限额）+ 安全计算
  void app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 20 * 1024 * 1024, files: 10 },
    });
    scoped.post('/api/ai/shell-tools/pdf/:op', async (request, reply) => {
      const result = await member(services, request, false, async (sql, actor) => {
        const opRaw = String((request.params as { op?: string }).op || '');
        const allowed: PdfOp[] = ['merge', 'split', 'to_images', 'extract_text'];
        if (!allowed.includes(opRaw as PdfOp)) {
          throw new Problem(422, 'BAD_OP', `未知 PDF 算子：${opRaw}。${shellOperatorHint()}`);
        }
        const { files } = await readShellPdfFiles(request);
        return runShellPdfOp(sql, actor, opRaw as PdfOp, files);
      });
      return reply.send(result);
    });
  });

  app.get('/api/ai/shell-tools/pdf/download/:id', async (request, reply) => {
    const result = await member(services, request, false, async (_sql, actor) => {
      const id = (request.params as { id?: string }).id ?? '';
      return takeShellPdfDownload(actor.tenant_id, id);
    });
    reply.header('content-type', result.mime);
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
    return reply.send(result.buffer);
  });

  app.post('/api/ai/shell-tools/calc/eval', async (request, reply) => {
    const result = await member(services, request, false, async () => {
      const body = (request.body ?? {}) as { expr?: unknown; qty?: unknown; price?: unknown };
      let expr = typeof body.expr === 'string' ? body.expr.trim() : '';
      if (!expr && (body.qty != null || body.price != null)) {
        const qty = Number(body.qty);
        const price = Number(body.price);
        if (!Number.isFinite(qty) || !Number.isFinite(price)) {
          throw new Problem(422, 'CALC_INPUT', '数量/单价必须是数字');
        }
        expr = `${qty}*${price}`;
      }
      const out = safeEvalExpression(expr);
      if (!out.ok) throw new Problem(422, 'CALC_BAD', out.error);
      return { ok: true, expr, value: out.value, write_mes: false };
    });
    return reply.send(result);
  });

  // 识图抽字段：multipart 图片 → DeepSeek-flash → JSON fields（确认前不写 MES）
  void app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    });
    scoped.post('/api/ai/shell-tools/vision/extract', async (request, reply) => {
      try {
        const result = await member(services, request, false, async () => {
          const file = await readShellVisionImage(request);
          return extractImageFields(file);
        });
        return reply.send(result);
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string };
        if (e && typeof e.statusCode === 'number' && e.message) {
          throw new Problem(e.statusCode, e.code || 'VISION', e.message);
        }
        throw err;
      }
    });
  });

}
