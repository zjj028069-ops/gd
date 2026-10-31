/**
 * S3-A 本厂词典：别名 / 默认规则 / 纠错记忆。
 * 写库只经 preview → writes/confirm|cancel；主数据只存已有 ID 引用。
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from '../database.js';
import { Problem, type Actor } from '../services.js';
import { writeActionAudit } from './audit.js';

export type GlossaryKind = 'alias' | 'default_rule' | 'correction';
export type GlossaryTargetKind = 'material' | 'customer' | '';

export type GlossaryRow = {
  id: string;
  kind: GlossaryKind;
  phrase: string;
  target_kind: string;
  target_id: string | null;
  target_code: string;
  target_label: string;
  payload: Record<string, unknown>;
  note: string;
  created_at: string;
  updated_at: string;
};

export type GlossaryHit = {
  kind: GlossaryKind;
  phrase: string;
  target_kind: string;
  target_id: string | null;
  target_code: string;
  target_label: string;
  applied_to: 'product' | 'customer' | 'rule';
  detail: string;
};

type ConfirmCard = {
  title: string;
  summary: string;
  risk: string;
  actions: Array<'confirm' | 'cancel'>;
  target: 'glossary';
  plan?: false;
};

type Draft = {
  op: 'create' | 'update' | 'delete';
  id?: string;
  kind: GlossaryKind;
  phrase: string;
  target_kind: GlossaryTargetKind;
  target_id: string | null;
  target_code: string;
  target_label: string;
  payload: Record<string, unknown>;
  note: string;
  matched: boolean;
};

type GlossaryPreview = {
  id: string;
  tenant_id: string;
  actor_id: string;
  draft: Draft;
  card: ConfirmCard;
};

const previews = new Map<string, GlossaryPreview>();

const KIND_LABEL: Record<GlossaryKind, string> = {
  alias: '别名/叫法',
  default_rule: '默认规则',
  correction: '纠错记忆',
};

function norm(value: string) {
  return value.replace(/\s+/g, '').trim().toLowerCase();
}

function clip(value: string, max: number) {
  return value.trim().slice(0, max);
}

export function resetGlossaryForTests() {
  previews.clear();
}

export function peekGlossaryPreview(previewId: string, tenantId: string) {
  const row = previews.get(previewId);
  if (!row || row.tenant_id !== tenantId) return null;
  return row;
}

export function discardGlossaryPreview(previewId: string, tenantId: string) {
  const row = peekGlossaryPreview(previewId, tenantId);
  if (!row) throw new Problem(404, 'PREVIEW_NOT_FOUND', '词典预览已失效或不存在');
  previews.delete(previewId);
  return { ok: true as const };
}

export function parseGlossaryUtterance(raw: string):
  | { op: 'list' }
  | { op: 'delete'; phrase: string }
  | { op: 'create'; kind: 'alias'; phrase: string; targetKind: 'material' | 'customer'; targetQuery: string }
  | { op: 'create'; kind: 'default_rule'; phrase: string; taxIncluded: boolean }
  | { op: 'create'; kind: 'correction'; phrase: string; corrected: string }
  | null {
  const compact = raw.trim().replace(/\s+/g, '');
  if (!compact) return null;
  if (
    /^(本厂词典(有哪些|列表)?|词典有哪些|有哪些叫法|看看本厂词典|本厂有哪些叫法|词典列表|看看词典|打开词典|词典)$/.test(compact) ||
    (/本厂词典|词典|叫法/.test(compact) && /哪些|列表|看看|查看|打开|有啥|全部/.test(compact) && !/记成|删除|纠正|记作|等于/.test(compact))
  ) {
    return { op: 'list' };
  }
  const del = compact.match(/^(?:删除|去掉)(?:本厂)?词典(?:条目|里的)?[:：]?(.*)$/);
  if (del?.[1]) return { op: 'delete', phrase: del[1] };
  const material =
    compact.match(/^把(.+?)记成(?:物料|商品|产品)(.+)$/) ||
    compact.match(/^把(.+?)记作(?:物料|商品|产品)(.+)$/) ||
    compact.match(/^(.+?)[＝=](?:物料|商品|产品)(.+)$/) ||
    compact.match(/^记一下(.+?)是(?:物料|商品|产品)(.+)$/);
  if (material?.[1] && material[2]) {
    return { op: 'create', kind: 'alias', phrase: material[1], targetKind: 'material', targetQuery: material[2] };
  }
  const customer =
    compact.match(/^把(.+?)记成客户(.+)$/) ||
    compact.match(/^把(.+?)记作客户(.+)$/) ||
    compact.match(/^记一下(.+?)是客户(.+)$/);
  if (customer?.[1] && customer[2]) {
    return { op: 'create', kind: 'alias', phrase: customer[1], targetKind: 'customer', targetQuery: customer[2] };
  }
  const rule = compact.match(/^(.+?)默认(含税|不含税)$/);
  if (rule?.[1]) return { op: 'create', kind: 'default_rule', phrase: rule[1], taxIncluded: rule[2] === '含税' };
  const fix = compact.match(/^把(.+?)纠正为(.+)$/) || compact.match(/^(.+?)应该叫(.+)$/);
  if (fix?.[1] && fix[2]) return { op: 'create', kind: 'correction', phrase: fix[1], corrected: fix[2] };
  return null;
}

function phraseHits(value: string, phrase: string) {
  const left = norm(value);
  const right = norm(phrase);
  if (!left || !right) return false;
  if (left === right) return true;
  if (right.startsWith(left) && left.length >= 2) return true;
  if (left.startsWith(right) && right.length >= 2) return true;
  return false;
}

async function loadRows(sql: Sql): Promise<GlossaryRow[]> {
  return (
    await sql.query<GlossaryRow>(
      `SELECT id, kind, phrase, target_kind, target_id::text AS target_id, target_code, target_label,
              payload, note, created_at::text AS created_at, updated_at::text AS updated_at
       FROM ai_factory_glossary
       ORDER BY kind, phrase`,
    )
  ).rows.map((row) => ({
    ...row,
    payload: (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>,
  }));
}

export async function listGlossary(sql: Sql) {
  const items = await loadRows(sql);
  return { items, total: items.length };
}

async function findMaster(
  sql: Sql,
  targetKind: 'material' | 'customer',
  query: string,
  targetId?: string | null,
): Promise<{ id: string; code: string; name: string } | null> {
  if (targetId) {
    const table = targetKind === 'material' ? 'products' : 'customers';
    const extra = targetKind === 'material' ? ' AND active' : ' AND NOT in_sea';
    const row = (
      await sql.query<{ id: string; code: string; name: string }>(
        `SELECT id::text AS id, code, name FROM ${table} WHERE id=$1${extra}`,
        [targetId],
      )
    ).rows[0];
    if (row) return row;
  }
  const q = clip(query, 80);
  if (!q) return null;
  if (targetKind === 'material') {
    return (
      await sql.query<{ id: string; code: string; name: string }>(
        `SELECT id::text AS id, code, name FROM products
         WHERE active AND (code ILIKE $1 OR name ILIKE $1 OR code ILIKE $2 OR name ILIKE '%' || $2 || '%')
         ORDER BY CASE WHEN lower(code)=lower($1) THEN 0 WHEN lower(name)=lower($1) THEN 1 ELSE 2 END, code
         LIMIT 1`,
        [q, q],
      )
    ).rows[0] ?? null;
  }
  return (
    await sql.query<{ id: string; code: string; name: string }>(
      `SELECT id::text AS id, code, name FROM customers
       WHERE NOT in_sea AND (code ILIKE $1 OR name ILIKE $1 OR name ILIKE '%' || $1 || '%')
       ORDER BY CASE WHEN lower(code)=lower($1) THEN 0 WHEN lower(name)=lower($1) THEN 1 ELSE 2 END, code
       LIMIT 1`,
      [q],
    )
  ).rows[0] ?? null;
}

function cardOf(draft: Draft): ConfirmCard {
  const ref =
    draft.target_id
      ? `${draft.target_kind === 'customer' ? '客户' : '物料'} ${draft.target_code} ${draft.target_label}（只存引用 ${draft.target_id}）`
      : draft.kind === 'alias'
        ? '未匹配到已有主数据'
        : draft.target_label || '';
  const summary =
    draft.op === 'delete'
      ? `将删除词典条目「${draft.phrase}」（${KIND_LABEL[draft.kind]}）。`
      : `类型：${KIND_LABEL[draft.kind]}；叫法「${draft.phrase}」${ref ? ` → ${ref}` : ''}${draft.note ? `；备注 ${draft.note}` : ''}`;
  const risk = draft.kind === 'alias' && !draft.matched
    ? '未匹配到已有主数据。确认将失败且不写词典；取消不写库。'
    : '确认前不写库。取消不会改本厂词典。';
  return {
    title: draft.op === 'delete' ? '确认删除本厂词典条目' : draft.op === 'update' ? '确认更新本厂词典' : '确认写入本厂词典',
    summary,
    risk,
    actions: ['confirm', 'cancel'],
    target: 'glossary',
  };
}

async function draftFromUtterance(sql: Sql, parsed: Exclude<ReturnType<typeof parseGlossaryUtterance>, { op: 'list' } | null>): Promise<Draft> {
  if (parsed.op === 'delete') {
    const rows = await loadRows(sql);
    const row = rows.find((item) => phraseHits(item.phrase, parsed.phrase) || phraseHits(parsed.phrase, item.phrase));
    if (!row) throw new Problem(404, 'GLOSSARY_NOT_FOUND', `词典里没有「${parsed.phrase}」`);
    return {
      op: 'delete',
      id: row.id,
      kind: row.kind,
      phrase: row.phrase,
      target_kind: (row.target_kind === 'customer' || row.target_kind === 'material' ? row.target_kind : '') as GlossaryTargetKind,
      target_id: row.target_id,
      target_code: row.target_code,
      target_label: row.target_label,
      payload: row.payload,
      note: row.note,
      matched: true,
    };
  }
  if (parsed.kind === 'alias') {
    const master = await findMaster(sql, parsed.targetKind, parsed.targetQuery);
    return {
      op: 'create',
      kind: 'alias',
      phrase: clip(parsed.phrase, 80),
      target_kind: parsed.targetKind,
      target_id: master?.id ?? null,
      target_code: master?.code ?? '',
      target_label: master?.name ?? clip(parsed.targetQuery, 80),
      payload: {},
      note: '',
      matched: Boolean(master),
    };
  }
  if (parsed.kind === 'default_rule') {
    return {
      op: 'create',
      kind: 'default_rule',
      phrase: clip(parsed.phrase, 80),
      target_kind: '',
      target_id: null,
      target_code: '',
      target_label: parsed.taxIncluded ? '含税' : '不含税',
      payload: { tax_included: parsed.taxIncluded },
      note: '',
      matched: true,
    };
  }
  return {
    op: 'create',
    kind: 'correction',
    phrase: clip(parsed.phrase, 80),
    target_kind: '',
    target_id: null,
    target_code: '',
    target_label: clip(parsed.corrected, 80),
    payload: { corrected: clip(parsed.corrected, 80) },
    note: '',
    matched: true,
  };
}

function remember(actor: Actor, draft: Draft) {
  const card = cardOf(draft);
  const preview: GlossaryPreview = {
    id: randomUUID(),
    tenant_id: actor.tenant_id,
    actor_id: actor.user_id,
    draft,
    card,
  };
  previews.set(preview.id, preview);
  return { preview_id: preview.id, confirm_card: card, written: false as const, draft };
}

export async function previewGlossaryChat(sql: Sql, actor: Actor, text: string) {
  const parsed = parseGlossaryUtterance(text);
  if (!parsed) return { handled: false as const };
  if (parsed.op === 'list') {
    const listed = await listGlossary(sql);
    const lines = listed.items.length
      ? listed.items
          .map(
            (item, idx) =>
              `${idx + 1}. [${KIND_LABEL[item.kind]}] ${item.phrase}${item.target_label ? ` → ${item.target_code} ${item.target_label}` : ''}`,
          )
          .join('\n')
      : '本厂词典还是空的。可以说「把大板记成物料 LOCAL001」或「记一下大板是物料 LOCAL001」。';
    return {
      handled: true as const,
      mode: 'read' as const,
      domain: 'glossary' as const,
      text: `本厂词典共 ${listed.total} 条（可在 AI 智能体 → 本厂词典页回看/编辑）。\n${lines}`,
      items: listed.items,
      written: false as const,
    };
  }
  const draft = await draftFromUtterance(sql, parsed);
  const saved = remember(actor, draft);
  await writeActionAudit(sql, actor, {
    action: 'glossary.preview',
    preview_id: saved.preview_id,
    payload: { op: draft.op, phrase: draft.phrase, kind: draft.kind },
    result: 'preview',
    target_table: 'ai_factory_glossary',
    document_code: draft.phrase,
    meta: { matched: draft.matched },
  });
  return {
    handled: true as const,
    mode: 'preview' as const,
    domain: 'glossary' as const,
    text: saved.confirm_card.summary,
    ...saved,
  };
}

type StructuredBody = {
  op?: unknown;
  id?: unknown;
  kind?: unknown;
  phrase?: unknown;
  target_kind?: unknown;
  target_id?: unknown;
  target_query?: unknown;
  note?: unknown;
  payload?: unknown;
  corrected?: unknown;
  tax_included?: unknown;
};

export async function previewGlossaryStructured(sql: Sql, actor: Actor, body: StructuredBody) {
  const op = body.op === 'update' || body.op === 'delete' ? body.op : 'create';
  if (op === 'delete') {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) throw new Problem(422, 'ID_REQUIRED', '请指定要删除的词典条目');
    const rows = await loadRows(sql);
    const row = rows.find((item) => item.id === id);
    if (!row) throw new Problem(404, 'GLOSSARY_NOT_FOUND', '词典条目不存在');
    const saved = remember(actor, {
      op: 'delete',
      id: row.id,
      kind: row.kind,
      phrase: row.phrase,
      target_kind: (row.target_kind === 'customer' || row.target_kind === 'material' ? row.target_kind : '') as GlossaryTargetKind,
      target_id: row.target_id,
      target_code: row.target_code,
      target_label: row.target_label,
      payload: row.payload,
      note: row.note,
      matched: true,
    });
    return { ...saved, mode: 'preview' as const };
  }
  const kind: GlossaryKind =
    body.kind === 'default_rule' || body.kind === 'correction' || body.kind === 'alias' ? body.kind : 'alias';
  const phrase = clip(typeof body.phrase === 'string' ? body.phrase : '', 80);
  if (!phrase) throw new Problem(422, 'PHRASE_REQUIRED', '请填写叫法');
  const note = clip(typeof body.note === 'string' ? body.note : '', 200);
  const targetKind: GlossaryTargetKind =
    body.target_kind === 'customer' || body.target_kind === 'material' ? body.target_kind : '';
  let draft: Draft;
  if (kind === 'alias') {
    if (targetKind !== 'material' && targetKind !== 'customer') {
      throw new Problem(422, 'TARGET_KIND', '别名需要绑定物料或客户');
    }
    const targetId = typeof body.target_id === 'string' ? body.target_id.trim() : '';
    const targetQuery = typeof body.target_query === 'string' ? body.target_query : '';
    const master = await findMaster(sql, targetKind, targetQuery, targetId || null);
    draft = {
      op,
      id: op === 'update' && typeof body.id === 'string' ? body.id.trim() : undefined,
      kind,
      phrase,
      target_kind: targetKind,
      target_id: master?.id ?? null,
      target_code: master?.code ?? '',
      target_label: master?.name ?? '',
      payload: {},
      note,
      matched: Boolean(master),
    };
  } else if (kind === 'default_rule') {
    const tax = body.tax_included === true || body.tax_included === 'true' || (body.payload as { tax_included?: unknown } | undefined)?.tax_included === true;
    draft = {
      op,
      id: op === 'update' && typeof body.id === 'string' ? body.id.trim() : undefined,
      kind,
      phrase,
      target_kind: '',
      target_id: null,
      target_code: '',
      target_label: tax ? '含税' : '不含税',
      payload: { tax_included: tax },
      note,
      matched: true,
    };
  } else {
    const corrected = clip(
      typeof body.corrected === 'string'
        ? body.corrected
        : typeof (body.payload as { corrected?: unknown } | undefined)?.corrected === 'string'
          ? String((body.payload as { corrected?: unknown }).corrected)
          : '',
      80,
    );
    if (!corrected) throw new Problem(422, 'CORRECTED_REQUIRED', '请填写纠正后的写法');
    draft = {
      op,
      id: op === 'update' && typeof body.id === 'string' ? body.id.trim() : undefined,
      kind,
      phrase,
      target_kind: '',
      target_id: null,
      target_code: '',
      target_label: corrected,
      payload: { corrected },
      note,
      matched: true,
    };
  }
  const saved = remember(actor, draft);
  await writeActionAudit(sql, actor, {
    action: 'glossary.preview',
    preview_id: saved.preview_id,
    payload: { op: draft.op, phrase: draft.phrase, kind: draft.kind },
    result: 'preview',
    target_table: 'ai_factory_glossary',
    document_code: draft.phrase,
  });
  return { ...saved, mode: 'preview' as const };
}

export async function confirmGlossaryWrite(sql: Sql, actor: Actor, previewId: string) {
  const preview = peekGlossaryPreview(previewId, actor.tenant_id);
  if (!preview) throw new Problem(404, 'PREVIEW_NOT_FOUND', '词典预览已失效或不存在');
  const draft = preview.draft;
  if (draft.kind === 'alias' && draft.op !== 'delete' && !draft.target_id) {
    throw new Problem(422, 'MASTER_NOT_FOUND', '未匹配到已有主数据，不能写入词典别名');
  }
  let rowId = draft.id ?? '';
  if (draft.op === 'delete') {
    const gone = (
      await sql.query<{ id: string }>('DELETE FROM ai_factory_glossary WHERE id=$1 RETURNING id', [draft.id])
    ).rows[0];
    if (!gone) throw new Problem(404, 'GLOSSARY_NOT_FOUND', '词典条目不存在或已删除');
    rowId = gone.id;
  } else if (draft.op === 'update' && draft.id) {
    try {
      const updated = (
        await sql.query<{ id: string }>(
          `UPDATE ai_factory_glossary
           SET kind=$2, phrase=$3, target_kind=$4, target_id=$5, target_code=$6, target_label=$7,
               payload=$8::jsonb, note=$9, updated_at=now()
           WHERE id=$1
           RETURNING id`,
          [
            draft.id,
            draft.kind,
            draft.phrase,
            draft.target_kind,
            draft.target_id,
            draft.target_code,
            draft.target_label,
            JSON.stringify(draft.payload),
            draft.note,
          ],
        )
      ).rows[0];
      if (!updated) throw new Problem(404, 'GLOSSARY_NOT_FOUND', '词典条目不存在');
      rowId = updated.id;
    } catch (error) {
      if (String((error as { code?: string }).code) === '23505') throw new Problem(409, 'DUPLICATE', '同样的叫法已在词典中');
      throw error;
    }
  } else {
    try {
      const inserted = (
        await sql.query<{ id: string }>(
          `INSERT INTO ai_factory_glossary(
             tenant_id, kind, phrase, target_kind, target_id, target_code, target_label, payload, note, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
           RETURNING id`,
          [
            actor.tenant_id,
            draft.kind,
            draft.phrase,
            draft.target_kind,
            draft.target_id,
            draft.target_code,
            draft.target_label,
            JSON.stringify(draft.payload),
            draft.note,
            actor.user_id,
          ],
        )
      ).rows[0]!;
      rowId = inserted.id;
    } catch (error) {
      if (String((error as { code?: string }).code) === '23505') throw new Problem(409, 'DUPLICATE', '同样的叫法已在词典中');
      throw error;
    }
  }
  previews.delete(previewId);
  return {
    glossary_id: rowId,
    op: draft.op,
    phrase: draft.phrase,
    kind: draft.kind,
    target_id: draft.target_id,
    target_code: draft.target_code,
    target_label: draft.target_label,
    message:
      draft.op === 'delete'
        ? `已删除词典条目「${draft.phrase}」`
        : `已写入本厂词典「${draft.phrase}」`,
  };
}

/** S2 认型/落单：用词典替换物料或客户叫法，并套用默认规则。不写库。 */
export async function applyGlossaryToOrderFields(
  sql: Sql,
  fields: {
    customer_name: string;
    customer_code: string;
    customer_id: string | null;
    product_code: string;
    product_name: string;
    product_id: string | null;
    note: string;
  },
): Promise<GlossaryHit[]> {
  const rows = await loadRows(sql);
  const hits: GlossaryHit[] = [];
  const corrections = rows.filter((row) => row.kind === 'correction');
  for (const row of corrections) {
    const corrected = String(row.payload.corrected ?? row.target_label ?? '').trim();
    if (!corrected) continue;
    if (fields.product_name && phraseHits(fields.product_name, row.phrase)) {
      fields.product_name = corrected;
      hits.push({
        kind: 'correction',
        phrase: row.phrase,
        target_kind: row.target_kind,
        target_id: row.target_id,
        target_code: row.target_code,
        target_label: corrected,
        applied_to: 'product',
        detail: `纠错：${row.phrase} → ${corrected}`,
      });
    }
    if (fields.customer_name && phraseHits(fields.customer_name, row.phrase)) {
      fields.customer_name = corrected;
      hits.push({
        kind: 'correction',
        phrase: row.phrase,
        target_kind: row.target_kind,
        target_id: row.target_id,
        target_code: row.target_code,
        target_label: corrected,
        applied_to: 'customer',
        detail: `纠错：${row.phrase} → ${corrected}`,
      });
    }
  }
  const aliases = rows.filter((row) => row.kind === 'alias' && row.target_id);
  const productAlias = aliases.find(
    (row) =>
      row.target_kind === 'material' &&
      ((fields.product_name && phraseHits(fields.product_name, row.phrase)) ||
        (fields.product_code && phraseHits(fields.product_code, row.phrase))),
  );
  if (productAlias?.target_id) {
    const master = await findMaster(sql, 'material', productAlias.target_code, productAlias.target_id);
    if (master) {
      fields.product_id = master.id;
      hits.push({
        kind: 'alias',
        phrase: productAlias.phrase,
        target_kind: 'material',
        target_id: master.id,
        target_code: master.code,
        target_label: master.name,
        applied_to: 'product',
        detail: `别名「${productAlias.phrase}」→ 物料 ${master.code} ${master.name}`,
      });
    }
  }
  const customerAlias = aliases.find(
    (row) =>
      row.target_kind === 'customer' &&
      ((fields.customer_name && phraseHits(fields.customer_name, row.phrase)) ||
        (fields.customer_code && phraseHits(fields.customer_code, row.phrase))),
  );
  if (customerAlias?.target_id) {
    const master = await findMaster(sql, 'customer', customerAlias.target_code, customerAlias.target_id);
    if (master) {
      fields.customer_id = master.id;
      fields.customer_code = master.code;
      fields.customer_name = master.name;
      hits.push({
        kind: 'alias',
        phrase: customerAlias.phrase,
        target_kind: 'customer',
        target_id: master.id,
        target_code: master.code,
        target_label: master.name,
        applied_to: 'customer',
        detail: `别名「${customerAlias.phrase}」→ 客户 ${master.code} ${master.name}`,
      });
    }
  }
  const rules = rows.filter((row) => row.kind === 'default_rule');
  const rule = rules.find(
    (row) =>
      (fields.customer_name && phraseHits(fields.customer_name, row.phrase)) ||
      (fields.note && phraseHits(fields.note, row.phrase)),
  );
  if (rule) {
    const tax = rule.payload.tax_included === true;
    const label = tax ? '含税' : '不含税';
    if (!fields.note.includes(label)) fields.note = `${fields.note}【词典默认${label}】`.slice(0, 500);
    hits.push({
      kind: 'default_rule',
      phrase: rule.phrase,
      target_kind: '',
      target_id: null,
      target_code: '',
      target_label: label,
      applied_to: 'rule',
      detail: `默认规则「${rule.phrase}」→ ${label}`,
    });
  }
  return hits;
}
