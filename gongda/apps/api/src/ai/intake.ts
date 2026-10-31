import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../database.js';
import { Problem, type Actor } from '../services.js';
import { writeActionAudit } from './audit.js';
import {
  buildOrderDocPreview,
  extractAttachmentText,
  resetContractIntakeForTests,
} from './intake-contract.js';

/** 附件认型（S0 骨架 + S2 合同打穿；OCR 未接时用确定性 mock） */
export type IntakeKind = 'order_doc' | 'business_card' | 'other' | 'unknown';

export type ContactFields = {
  name: string;
  phone: string;
  company: string;
  title: string;
  email: string;
  party_kind: 'customer' | 'supplier';
};

export type ContactMatch = {
  id: string;
  code: string;
  name: string;
  kind: 'customer' | 'supplier';
};

export type ContactPreview = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  filename: string;
  kind: 'business_card';
  fields: ContactFields;
  matches: ContactMatch[];
  attachment_digest: string;
  attachment_bytes?: Buffer;
  warnings: string[];
};

export type ConfirmCard = {
  title: string;
  summary: string;
  risk: string;
  actions: Array<'confirm' | 'cancel'>;
  target: 'contact' | 'contract' | 'work_order_from_contract' | 'attachment';
  fields?: ContactFields;
  matches?: ContactMatch[];
};

type PendingAsk = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  filename: string;
  note: string;
  buffer: Buffer;
  kind: 'other' | 'unknown';
};

type AttachmentOnlyPreview = {
  id: string;
  tenant_id: string;
  actor_id: string;
  created_at: number;
  filename: string;
  buffer: Buffer;
  digest: string;
};

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const contactPreviews = new Map<string, ContactPreview>();
const pendingAsks = new Map<string, PendingAsk>();
const attachmentOnlyPreviews = new Map<string, AttachmentOnlyPreview>();

function purgeExpired() {
  const now = Date.now();
  for (const [id, preview] of contactPreviews) {
    if (now - preview.created_at > PREVIEW_TTL_MS) contactPreviews.delete(id);
  }
  for (const [id, ask] of pendingAsks) {
    if (now - ask.created_at > PREVIEW_TTL_MS) pendingAsks.delete(id);
  }
  for (const [id, preview] of attachmentOnlyPreviews) {
    if (now - preview.created_at > PREVIEW_TTL_MS) attachmentOnlyPreviews.delete(id);
  }
}

export function peekContactPreview(previewId: string, tenantId: string): ContactPreview | null {
  purgeExpired();
  const preview = contactPreviews.get(previewId);
  if (!preview || preview.tenant_id !== tenantId) return null;
  return preview;
}

export function getContactPreview(previewId: string, tenantId: string): ContactPreview {
  const preview = peekContactPreview(previewId, tenantId);
  if (!preview) throw new Problem(404, 'PREVIEW_NOT_FOUND', '联系人预览已失效或不存在，请重新上传');
  return preview;
}

export function discardContactPreview(previewId: string, tenantId: string) {
  const preview = getContactPreview(previewId, tenantId);
  contactPreviews.delete(preview.id);
  return { ok: true as const };
}

export function resetIntakeForTests() {
  contactPreviews.clear();
  pendingAsks.clear();
  attachmentOnlyPreviews.clear();
  resetContractIntakeForTests();
}

function digestBuffer(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 64);
}

/** 规则认型：文件名/提示词/弱文本线索；置信度低时返回 unknown/other 并要求追问。 */
export function classifyAttachmentHints(input: {
  filename: string;
  note?: string;
  textSnippet?: string;
}): { kind: IntakeKind; confidence: number; reasons: string[] } {
  const blob = `${input.filename} ${input.note ?? ''} ${input.textSnippet ?? ''}`.toLowerCase();
  const reasons: string[] = [];

  // 单据优先：避免 PDF 元数据 /Title 等把订单误判成名片
  const spreadsheetName = /\.(xlsx|xls|csv)$/i.test(input.filename);
  const orderHit =
    /订单|送货单|送货|出货|报价|合同|发货单|采购单|销售单|加工单|发票|对账单|\border\b|invoice|quotation|\bdelivery\b/.test(
      blob,
    ) ||
    (spreadsheetName &&
      (/客户|数量|单价|金额|品名|货号|交期|qty|price|sku|amount|customer/i.test(blob) ||
        Boolean((input.textSnippet ?? '').trim())));
  const cardHit =
    /名片|name\s*card|business\s*card|vcard|\.vcf|微信/.test(blob) ||
    /(?:职位|职务|Title)\s*[:：]/.test(blob) ||
    (/(?:电话|手机|Tel|Mobile)\s*[:：]/.test(blob) && /[\u4e00-\u9fa5]{2,4}/.test(blob)) ||
    (/先生|女士|经理|总监/.test(blob) && /1[3-9]\d{9}/.test(blob));
  if (orderHit && !/名片|business\s*card|vcard/.test(blob)) {
    reasons.push('命中单据类关键词');
    return { kind: 'order_doc', confidence: 0.78, reasons };
  }
  if (cardHit) {
    reasons.push('命中名片关键词或电话+称谓线索');
    return { kind: 'business_card', confidence: /名片|business\s*card|vcard/.test(blob) ? 0.86 : 0.62, reasons };
  }
  if (orderHit) {
    reasons.push('命中单据类关键词');
    return { kind: 'order_doc', confidence: 0.78, reasons };
  }

  const otherHit = /风景|自拍|表情|截图|壁纸|旅游|美食|猫|狗|meme|wallpaper|selfie/.test(blob);
  if (otherHit) {
    reasons.push('命中非单据场景词');
    return { kind: 'other', confidence: 0.7, reasons };
  }

  // 纯图片且无名片/单据线索 → 先当「其他」追问，禁止静默落单（风景图场景）
  const looksImage = /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(input.filename);
  const hasUsefulText = Boolean((input.textSnippet ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, 40));
  if (looksImage && !hasUsefulText) {
    reasons.push('图片附件缺少可解析文字，先追问用途（可能是风景/截图）');
    return { kind: 'other', confidence: 0.55, reasons };
  }

  reasons.push('线索不足，需人工选择用途');
  return { kind: 'unknown', confidence: 0.35, reasons };
}

function extractCardFields(filename: string, note: string, textSnippet: string): ContactFields {
  const blob = `${filename}\n${note}\n${textSnippet}`;
  const phone =
    blob.match(/1[3-9]\d{9}/)?.[0] ||
    blob.match(/(?:电话|手机|Tel|Mobile)[:：\s]*([0-9\-+\s]{7,20})/i)?.[1]?.replace(/\s+/g, '') ||
    '';
  const email = blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const company =
    blob.match(/(?:公司|企业|单位)[:：\s]*([^\n，,。]{2,40})/)?.[1]?.trim() ||
    blob.match(/([^\n]{2,30}(?:有限公司|股份|厂|贸易|科技))/)?.[1]?.trim() ||
    '';
  const name =
    blob.match(/(?:姓名|联系人|Name)[:：\s]*([^\n，,：:]{1,20}?)(?:\s*(?:电话|手机|Tel|职位|职务|公司)|$)/i)?.[1]?.trim() ||
    blob.match(/([\u4e00-\u9fa5]{2,4})\s*(?:先生|女士|经理|总监)/)?.[1] ||
    (filename.replace(/\.[a-z0-9]+$/i, '').includes('名片') ? '名片联系人' : '') ||
    '未知联系人';
  const title = blob.match(/(?:职位|职务|Title)[:：\s]*([^\n，,]{1,30})/i)?.[1]?.trim() || '';
  const party_kind: ContactFields['party_kind'] = /供应|采购|vendor|supplier/.test(blob)
    ? 'supplier'
    : 'customer';
  return { name: name.slice(0, 40), phone: phone.slice(0, 20), company: company.slice(0, 80), title: title.slice(0, 40), email: email.slice(0, 80), party_kind };
}

async function findMatches(sql: Sql, fields: ContactFields): Promise<ContactMatch[]> {
  const matches: ContactMatch[] = [];
  if (fields.party_kind === 'supplier') {
    const rows = (
      await sql.query<{ id: string; code: string; name: string }>(
        `SELECT id, code, name FROM suppliers
         WHERE ($1 <> '' AND (contact_phone = $1 OR contact_phone LIKE '%' || $1 || '%'))
            OR ($2 <> '' AND (name ILIKE '%' || $2 || '%' OR company_name ILIKE '%' || $2 || '%'))
         ORDER BY code LIMIT 5`,
        [fields.phone, fields.company || fields.name],
      )
    ).rows;
    for (const row of rows) matches.push({ ...row, kind: 'supplier' });
  } else {
    const rows = (
      await sql.query<{ id: string; code: string; name: string }>(
        `SELECT id, code, name FROM customers
         WHERE NOT in_sea AND (
           ($1 <> '' AND (contact_phone = $1 OR contact_phone LIKE '%' || $1 || '%'))
           OR ($2 <> '' AND name ILIKE '%' || $2 || '%')
         )
         ORDER BY code LIMIT 5`,
        [fields.phone, fields.company || fields.name],
      )
    ).rows;
    for (const row of rows) matches.push({ ...row, kind: 'customer' });
  }
  return matches;
}

function buildConfirmCard(preview: ContactPreview): ConfirmCard {
  const f = preview.fields;
  const matchText = preview.matches.length
    ? `匹配到 ${preview.matches.length} 个${f.party_kind === 'supplier' ? '供应商' : '客户'}：${preview.matches
        .map((m) => m.name)
        .join('、')}`
    : `未匹配到现有${f.party_kind === 'supplier' ? '供应商' : '客户'}，确认后将挂到选定对象或提示建档`;
  return {
    title: '确认写入联系人（名片）',
    summary: `${f.name}${f.phone ? ` · ${f.phone}` : ''}${f.company ? ` · ${f.company}` : ''}。${matchText}`,
    risk: '确认前不写库；已尝试匹配客户/供应商主数据。名片只建/更新联系人，绝不创建合同或加工单。',
    actions: ['confirm', 'cancel'],
    target: 'contact',
    fields: f,
    matches: preview.matches,
  };
}

export async function classifyIntakeUpload(
  sql: Sql,
  actor: Actor,
  buffer: Buffer,
  filename: string,
  note = '',
  forceKind?: IntakeKind,
) {
  const extracted = await extractAttachmentText(buffer, filename);
  const textSnippet = extracted.text;
  const guessed = forceKind
    ? { kind: forceKind, confidence: 0.99, reasons: ['调用方指定类型'] }
    : classifyAttachmentHints({ filename, note, textSnippet });

  await writeActionAudit(sql, actor, {
    action: 'intake.classify',
    result: 'preview',
    payload: { filename, note, kind: guessed.kind },
    meta: {
      filename,
      kind: guessed.kind,
      confidence: guessed.confidence,
      reasons: guessed.reasons,
      bytes: buffer.length,
      extract_method: extracted.method,
      extract_chars: textSnippet.length,
    },
  });

  if (guessed.kind === 'business_card') {
    const fields = extractCardFields(filename, note, textSnippet);
    const matches = await findMatches(sql, fields);
    const preview: ContactPreview = {
      id: randomUUID(),
      tenant_id: actor.tenant_id,
      actor_id: actor.user_id,
      created_at: Date.now(),
      filename,
      kind: 'business_card',
      fields,
      matches,
      attachment_digest: digestBuffer(buffer),
      attachment_bytes: buffer,
      warnings: [
        ...(guessed.confidence < 0.7 ? ['认型置信度偏低，请核对字段后再确认'] : []),
        ...(extracted.method === 'none' || extracted.method === 'utf8_binary_weak'
          ? ['附件几乎抽不到文字（若是扫描件/照片需靠文件名或备注；OCR 未接）']
          : []),
      ],
    };
    contactPreviews.set(preview.id, preview);
    const card = buildConfirmCard(preview);
    return {
      kind: 'business_card' as const,
      confidence: guessed.confidence,
      reasons: guessed.reasons,
      preview_id: preview.id,
      confirm_card: card,
      fields,
      matches,
      warnings: preview.warnings,
      // 明确禁止落合同/加工单
      forbidden_writes: ['money_contracts', 'work_orders', 'sales_orders'],
    };
  }

  if (guessed.kind === 'order_doc') {
    const built = await buildOrderDocPreview(sql, actor, buffer, filename, note);
    return { ...built, confidence: guessed.confidence, reasons: [...guessed.reasons, ...built.reasons] };
  }

  if (guessed.kind === 'other' || guessed.kind === 'unknown') {
    const askId = randomUUID();
    pendingAsks.set(askId, {
      id: askId,
      tenant_id: actor.tenant_id,
      actor_id: actor.user_id,
      created_at: Date.now(),
      filename,
      note,
      buffer,
      kind: guessed.kind,
    });
    const ask =
      guessed.kind === 'other'
        ? {
            question: '这看起来像风景图或非业务附件，不是订单/名片。要怎么处理？（确认前不写库）',
            options: [
              { id: 'keep_attachment', label: '存为附件' },
              { id: 'ignore', label: '忽略' },
              { id: 'force_business_card', label: '当作名片（联系人）' },
              { id: 'force_order_doc', label: '强制当单据' },
            ],
          }
        : {
            question: '无法识别附件类型，请选择用途（不会自动写库）',
            options: [
              { id: 'force_business_card', label: '当作名片（联系人）' },
              { id: 'force_order_doc', label: '当作订单/单据' },
              { id: 'keep_attachment', label: '存为附件' },
              { id: 'ignore', label: '忽略' },
            ],
          };
    return {
      kind: guessed.kind,
      confidence: guessed.confidence,
      reasons: guessed.reasons,
      ask_id: askId,
      ask,
      warnings: ['禁止静默落单'],
    };
  }

  return {
    kind: 'unknown' as const,
    confidence: guessed.confidence,
    reasons: guessed.reasons,
    ask: {
      question: '无法识别附件类型，请选择用途（不会自动写库）',
      options: [
        { id: 'force_business_card', label: '当作名片（联系人）' },
        { id: 'force_order_doc', label: '当作订单/单据' },
        { id: 'ignore', label: '忽略' },
      ],
    },
    warnings: ['禁止静默落单'],
  };
}

/** 对 other/unknown 的追问选项做决议；不会静默写库 */
export async function resolveIntakeAsk(
  sql: Sql,
  actor: Actor,
  body: { ask_id?: unknown; option_id?: unknown },
) {
  purgeExpired();
  const askId = typeof body.ask_id === 'string' ? body.ask_id.trim() : '';
  const optionId = typeof body.option_id === 'string' ? body.option_id.trim() : '';
  if (!askId) throw new Problem(422, 'ASK_REQUIRED', '请提供 ask_id');
  if (!optionId) throw new Problem(422, 'OPTION_REQUIRED', '请选择处理方式');
  const pending = pendingAsks.get(askId);
  if (!pending || pending.tenant_id !== actor.tenant_id) {
    throw new Problem(404, 'ASK_NOT_FOUND', '追问已失效，请重新上传附件');
  }
  pendingAsks.delete(askId);

  if (optionId === 'ignore') {
    await writeActionAudit(sql, actor, {
      action: 'intake.resolve',
      result: 'cancelled',
      payload: { ask_id: askId, option_id: optionId },
      meta: { filename: pending.filename },
    });
    return { ok: true as const, action: 'ignore' as const, wrote: false };
  }

  if (optionId === 'keep_attachment') {
    // 存附件也须确认卡，禁止静默写库
    const previewId = randomUUID();
    const digest = digestBuffer(pending.buffer);
    attachmentOnlyPreviews.set(previewId, {
      id: previewId,
      tenant_id: actor.tenant_id,
      actor_id: actor.user_id,
      created_at: Date.now(),
      filename: pending.filename,
      buffer: pending.buffer,
      digest,
    });
    return {
      ok: true as const,
      action: 'keep_attachment' as const,
      wrote: false,
      preview_id: previewId,
      confirm_card: {
        title: '确认存为附件',
        summary: `文件「${pending.filename}」将存入企业附件库，不创建合同/联系人/加工单。`,
        risk: '确认前不写库。',
        actions: ['confirm', 'cancel'] as Array<'confirm' | 'cancel'>,
        target: 'attachment' as const,
      },
    };
  }

  if (optionId === 'force_business_card') {
    return classifyIntakeUpload(sql, actor, pending.buffer, pending.filename, pending.note, 'business_card');
  }
  if (optionId === 'force_order_doc') {
    return classifyIntakeUpload(sql, actor, pending.buffer, pending.filename, pending.note, 'order_doc');
  }
  throw new Problem(422, 'OPTION_UNKNOWN', `不支持的选项：${optionId}`);
}

export function peekAttachmentPreview(previewId: string, tenantId: string): AttachmentOnlyPreview | null {
  purgeExpired();
  const p = attachmentOnlyPreviews.get(previewId);
  if (!p || p.tenant_id !== tenantId) return null;
  if (Date.now() - p.created_at > PREVIEW_TTL_MS) {
    attachmentOnlyPreviews.delete(previewId);
    return null;
  }
  return p;
}

export function discardAttachmentPreview(previewId: string, tenantId: string) {
  const p = peekAttachmentPreview(previewId, tenantId);
  if (!p) throw new Problem(404, 'PREVIEW_NOT_FOUND', '附件预览已失效');
  attachmentOnlyPreviews.delete(previewId);
  contactPreviews.delete(previewId);
  return { ok: true as const };
}

export async function confirmAttachmentWrite(
  sql: Sql,
  actor: Actor,
  body: { preview_id?: unknown },
) {
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const preview = peekAttachmentPreview(previewId, actor.tenant_id);
  if (!preview) throw new Problem(404, 'PREVIEW_NOT_FOUND', '附件预览已失效');
  const mime = /\.png$/i.test(preview.filename)
    ? 'image/png'
    : /\.jpe?g$/i.test(preview.filename)
      ? 'image/jpeg'
      : /\.pdf$/i.test(preview.filename)
        ? 'application/pdf'
        : 'text/plain';
  const sha256 = createHash('sha256').update(preview.buffer).digest('hex');
  const row = (
    await sql.query<{ id: string }>(
      `INSERT INTO attachments(tenant_id,filename,mime,byte_size,sha256,payload,request_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        actor.tenant_id,
        preview.filename.slice(0, 200),
        mime,
        preview.buffer.length,
        sha256,
        preview.buffer,
        randomUUID(),
      ],
    )
  ).rows[0]!;
  await sql
    .query(
      'UPDATE tenant_service_limits SET storage_used_bytes=storage_used_bytes+$1,updated_at=now() WHERE tenant_id=$2',
      [preview.buffer.length, actor.tenant_id],
    )
    .catch(() => undefined);
  attachmentOnlyPreviews.delete(previewId);
  contactPreviews.delete(previewId);
  return {
    kind: 'attachment' as const,
    attachment_id: row.id,
    filename: preview.filename,
    created_contract: false,
    created_work_order: false,
  };
}

export async function confirmContactWrite(
  sql: Sql,
  actor: Actor,
  body: {
    preview_id?: unknown;
    customer_id?: unknown;
    supplier_id?: unknown;
    party_kind?: unknown;
    fields?: unknown;
  },
) {
  if (actor.role !== 'admin' && actor.role !== 'planner') {
    throw new Problem(403, 'FORBIDDEN', '当前角色不能写入联系人');
  }
  const previewId = typeof body.preview_id === 'string' ? body.preview_id.trim() : '';
  if (!previewId) throw new Problem(422, 'PREVIEW_REQUIRED', '请提供 preview_id');
  const preview = getContactPreview(previewId, actor.tenant_id);

  const fields = { ...preview.fields };
  if (body.fields && typeof body.fields === 'object') {
    const raw = body.fields as Partial<ContactFields>;
    if (typeof raw.name === 'string' && raw.name.trim()) fields.name = raw.name.trim().slice(0, 40);
    if (typeof raw.phone === 'string') fields.phone = raw.phone.trim().slice(0, 20);
    if (typeof raw.company === 'string') fields.company = raw.company.trim().slice(0, 80);
    if (typeof raw.title === 'string') fields.title = raw.title.trim().slice(0, 40);
    if (typeof raw.email === 'string') fields.email = raw.email.trim().slice(0, 80);
    if (raw.party_kind === 'customer' || raw.party_kind === 'supplier') fields.party_kind = raw.party_kind;
  }
  if (body.party_kind === 'customer' || body.party_kind === 'supplier') {
    fields.party_kind = body.party_kind;
  }
  if (!fields.name) throw new Problem(422, 'NAME_REQUIRED', '联系人姓名不能为空');

  // 名片路径绝不创建合同/加工单
  if (fields.party_kind === 'supplier') {
    const supplierId =
      (typeof body.supplier_id === 'string' && body.supplier_id.trim()) ||
      preview.matches.find((m) => m.kind === 'supplier')?.id ||
      '';
    if (!supplierId) throw new Problem(422, 'SUPPLIER_REQUIRED', '请选择要挂靠的供应商后再确认');
    const row = (
      await sql.query<{ id: string; code: string }>(
        `UPDATE suppliers
         SET contact_name=$2, contact_phone=$3, version=version+1
         WHERE id=$1
         RETURNING id, code`,
        [supplierId, fields.name, fields.phone],
      )
    ).rows[0];
    if (!row) throw new Problem(404, 'SUPPLIER_NOT_FOUND', '供应商不存在');
    contactPreviews.delete(preview.id);
    return {
      kind: 'contact' as const,
      party_kind: 'supplier' as const,
      supplier_id: row.id,
      supplier_code: row.code,
      contact_name: fields.name,
      contact_phone: fields.phone,
      created_contract: false,
      created_work_order: false,
    };
  }

  let customerId =
    (typeof body.customer_id === 'string' && body.customer_id.trim()) ||
    preview.matches.find((m) => m.kind === 'customer')?.id ||
    '';
  let customerCreated = false;
  if (!customerId) {
    // S2：无匹配时新建客户再建联系人（仍禁止落合同/加工单）
    const code = `AIC${Date.now().toString().slice(-8)}`;
    const name = fields.company || fields.name || '名片客户';
    customerId = (
      await sql.query<{ id: string }>(
        `INSERT INTO customers(tenant_id,code,name,contact_name,contact_phone,owner_id)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [actor.tenant_id, code, name, fields.name, fields.phone, actor.user_id],
      )
    ).rows[0]!.id;
    customerCreated = true;
  } else if (!(await sql.query('SELECT id FROM customers WHERE id=$1 AND NOT in_sea', [customerId])).rows[0]) {
    throw new Problem(422, 'CUSTOMER', '客户不存在');
  }
  const hasDefault = (await sql.query('SELECT 1 FROM money_contacts WHERE customer_id=$1 AND is_default', [customerId]))
    .rows[0];
  const id = (
    await sql.query<{ id: string }>(
      'INSERT INTO money_contacts(tenant_id,customer_id,name,phone,is_default) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [actor.tenant_id, customerId, fields.name, fields.phone, !hasDefault],
    )
  ).rows[0]!.id;
  await sql.query(
    `UPDATE customers SET contact_name=CASE WHEN contact_name='' THEN $2 ELSE contact_name END,
       contact_phone=CASE WHEN contact_phone='' THEN $3 ELSE contact_phone END,
       updated_at=now()
     WHERE id=$1`,
    [customerId, fields.name, fields.phone],
  );
  // 原图挂附件（尽力而为，失败不挡联系人写入）
  let attachment_id: string | null = null;
  if (preview.attachment_bytes?.length) {
    try {
      const sha256 = createHash('sha256').update(preview.attachment_bytes).digest('hex');
      const mime = /\.png$/i.test(preview.filename)
        ? 'image/png'
        : /\.jpe?g$/i.test(preview.filename)
          ? 'image/jpeg'
          : 'text/plain';
      attachment_id = (
        await sql.query<{ id: string }>(
          `INSERT INTO attachments(tenant_id,filename,mime,byte_size,sha256,payload,request_key)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            actor.tenant_id,
            preview.filename.slice(0, 200),
            mime,
            preview.attachment_bytes.length,
            sha256,
            preview.attachment_bytes,
            randomUUID(),
          ],
        )
      ).rows[0]!.id;
    } catch {
      attachment_id = null;
    }
  }
  contactPreviews.delete(preview.id);
  return {
    kind: 'contact' as const,
    party_kind: 'customer' as const,
    contact_id: id,
    customer_id: customerId,
    customer_created: customerCreated,
    contact_name: fields.name,
    contact_phone: fields.phone,
    attachment_id,
    created_contract: false,
    created_work_order: false,
  };
}
