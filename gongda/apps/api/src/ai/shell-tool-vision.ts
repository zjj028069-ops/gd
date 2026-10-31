/**
 * 壳内识图抽字段：DeepSeek-flash vision → JSON fields
 * Key 仅服务端使用，不回前端。
 */
import { readAiConfig } from './config.js';

export type ExtractedField = { key: string; label: string; value: string };

export type VisionExtractResult = {
  ok: true;
  fields: ExtractedField[];
  raw_text?: string;
  model: string;
  write_mes: false;
};

function clip(value: string, max: number) {
  return String(value || '').trim().slice(0, max);
}

function guessMime(filename: string, fallback = 'image/png') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.png')) return 'image/png';
  return fallback;
}

function normalizeFields(raw: unknown): ExtractedField[] {
  const out: ExtractedField[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const label = clip(String(row.label || row.name || row.key || ''), 40);
    const keyRaw = clip(String(row.key || row.name || label || `f${out.length + 1}`), 40);
    const key = keyRaw.replace(/[^\u4e00-\u9fa5A-Za-z0-9_]/g, '_').slice(0, 40) || `f${out.length + 1}`;
    const value = clip(String(row.value ?? row.text ?? ''), 500);
    if (!label && !value) continue;
    out.push({ key, label: label || key, value });
  }
  return out;
}

function parseModelJson(content: string): { fields: ExtractedField[]; raw_text?: string } {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    return { fields: [], raw_text: clip(content, 2000) || undefined };
  }
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const fields = normalizeFields(parsed.fields);
    const raw_text = typeof parsed.raw_text === 'string' ? clip(parsed.raw_text, 4000) : undefined;
    if (!fields.length && raw_text) {
      // 退化：把整段文本放成一个字段
      return {
        fields: [{ key: 'raw_text', label: '识别文本', value: raw_text.slice(0, 500) }],
        raw_text,
      };
    }
    return { fields, raw_text };
  } catch {
    return { fields: [], raw_text: clip(content, 2000) || undefined };
  }
}

export async function extractImageFields(input: {
  buffer: Buffer;
  filename: string;
  mime?: string;
}): Promise<VisionExtractResult> {
  const config = readAiConfig();
  if (config.provider !== 'openai' || !config.apiKey) {
    throw Object.assign(new Error('识图未配置 AI_API_KEY'), { statusCode: 503, code: 'AI_OFF' });
  }
  if (!input.buffer?.length) {
    throw Object.assign(new Error('图片为空'), { statusCode: 422, code: 'EMPTY_FILE' });
  }
  if (input.buffer.length > 5 * 1024 * 1024) {
    throw Object.assign(new Error('图片不能超过 5MB'), { statusCode: 422, code: 'FILE_TOO_LARGE' });
  }
  const mime = (input.mime || guessMime(input.filename || 'image.png')).split(';')[0].trim();
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mime) && !/\.(png|jpe?g|webp|gif)$/i.test(input.filename || '')) {
    throw Object.assign(new Error('仅支持 PNG/JPEG/WebP/GIF'), { statusCode: 422, code: 'BAD_TYPE' });
  }
  const dataUrl = `data:${mime};base64,${input.buffer.toString('base64')}`;
  const system =
    '你是单据/图片字段提取器。只输出 JSON：{"fields":[{"key":"snake_or_cn","label":"中文名","value":"值"}],"raw_text":"可选全文"}。' +
    '从图片中尽量抽出可见字段（如客户、款号、数量、交期、单号、金额等）；没有则 fields 可空但给 raw_text。不要编造看不见的内容。';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.visionModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: `请提取图片「${clip(input.filename || 'image', 80)}」中的字段。` },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw Object.assign(new Error(`识图失败 HTTP ${response.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`), {
        statusCode: 502,
        code: 'VISION_HTTP',
      });
    }
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim() ?? '';
    const parsed = parseModelJson(content);
    return {
      ok: true,
      fields: parsed.fields,
      raw_text: parsed.raw_text,
      model: config.visionModel,
      write_mes: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
