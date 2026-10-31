import { readAiConfig, type AiConfig } from './config.js';
import {
  GREETING,
  SUGGESTED_GROUPS,
  isOffTopicQuestion,
  loadKnowledge,
  refusalReply,
  searchKnowledge,
  searchKnowledgeTop,
  shouldRefuseBusinessQuery,
  type KbArticle,
  type KbHit,
} from './knowledge.js';

export type ChatMode = 'quick' | 'deep';
export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export type ChatResult = {
  reply: string;
  citations?: { id: string; title: string }[];
  mode: ChatMode;
  provider: string;
};

export type PageContext = {
  path?: string;
  title?: string;
};

function isPageContextQuestion(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  return /(目前|当前)?在(哪|那)个?(界面|页面|页)|当前(界面|页面)|我在哪(个|里)?(界面|页面)?|这是哪个(界面|页面)/.test(t);
}

function pageContextReply(question: string, context?: PageContext | null): string {
  const path = (context?.path ?? '').trim();
  const title = (context?.title ?? '').replace(/\s*[|·\-].*$/, '').trim();
  if (path || title) {
    const where = title ? `「${title}」` : path;
    const route = path ? `（路由：${path}）` : '';
    return `你当前大致在${where}页面${route}。我只能根据前端传来的路由判断，看不到弹窗或表格细节。查用法可直接问操作步骤；查进度/应收/工资请用「工厂助理」。`;
  }
  return '我这边看不到你浏览器当前打开的页面。请告诉我菜单名或地址栏路径，或问「如何报工」等用法；查真实数字请到「工厂助理」。';
}

const OPENAI_TIMEOUT_MS = 12_000;


function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item?.role === 'user' && item.content.trim()) return item.content.trim();
  }
  return '';
}

function formatArticle(article: KbArticle, mode: ChatMode, uncertain = false): string {
  const body = article.body.replace(/^#+\s+/gm, '').trim();
  const parts = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const short = parts.slice(0, 3).join('\n\n');
  const preface = uncertain
    ? `不确定是否完全对应你的问题，以下是最接近的说明「${article.title}」供参考：\n\n`
    : '';
  if (mode === 'quick') {
    return `${preface}【${article.title}】\n\n${short || body}`;
  }
  return `${preface}【${article.title}】（深度说明）\n\n${body}\n\n——\n如需继续，可问相关菜单路径，或切换到「快速回答」获取精简步骤。`;
}

function catalogHint(articles: KbArticle[]): string {
  const titles = articles.slice(0, 8).map((a) => `「${a.title}」`).join('、');
  return `知识库里暂时没有特别贴切的一篇。你可以试着问：${titles || '「如何报工」「加工单怎么创建」'}；或打开菜单「AI 中心」查看功能说明。也可直接描述你要做的操作（如打印模板、扩展字段、库存盘点）。`;
}

function softOpenReply(question: string, mode: ChatMode): ChatResult {
  if (isOffTopicQuestion(question)) {
    return { reply: offTopicFromKb(), mode, provider: 'mock-open' };
  }
  const soft = searchKnowledgeTop(question, 2);
  if (soft.length) {
    const primary = soft[0]!;
    const parts = [formatArticle(primary.article, mode, true)];
    if (soft[1] && soft[1].article.id !== primary.article.id) {
      parts.push(`另外也可能相关：【${soft[1].article.title}】`);
    }
    return {
      reply: parts.join('\n\n'),
      citations: soft.map((h) => ({ id: h.article.id, title: h.article.title })),
      mode,
      provider: 'mock-open',
    };
  }
  const all = loadKnowledge();
  return { reply: catalogHint(all), mode, provider: 'mock-open' };
}

function offTopicFromKb(): string {
  return '我是赛德瑞克产品助手，答不了天气、闲聊这类问题。不过可以帮你看报工、销售订单、加工单、仓库、质检、打印模板等用法——直接问「如何报工」或打开推荐问题即可。';
}

async function openaiReply(
  question: string,
  mode: ChatMode,
  hits: KbHit[],
  config: AiConfig,
): Promise<string> {
  const refs = hits
    .slice(0, 3)
    .map((h, i) => `参考${i + 1}「${h.article.title}」：\n${h.article.body.slice(0, 2200)}`)
    .join('\n\n');
  const system = [
    '你是赛德瑞克小助手，只回答赛德瑞克/快工单类 MES 产品的操作用法。',
    '绝不编造本厂实时数字（工单进度、库存、工资、应收应付）；若用户要查真实业务数据，引导其使用「工厂助理」。',
    '绝不声称已创建或修改单据。用中文简洁回答。',
    '对明显无关问题（如天气、闲聊）礼貌说明超出产品助手范围，并提示可问报工/订单/仓库等用法。',
    refs
      ? `以下知识库文摘仅供参考（可能不完全对应，请勿生搬硬套未提及的菜单）：\n${refs}`
      : '知识库未命中高置信文章；请结合赛德瑞克常见模块（报工、合同订单、加工单、仓库、质检、打印模板、扩展字段）给出尽量有用的操作指引，并注明若菜单名不确定请用户对照侧栏。',
    mode === 'deep' ? '请给出分步说明与注意事项。' : '请控制在 220 字内。',
  ].join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
      }),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError') throw new Error('openai_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`openai_http_${response.status}:${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('openai_empty');
  return content;
}

export async function runAssistantChat(
  messages: ChatMessage[],
  mode: ChatMode,
  config: AiConfig = readAiConfig(),
  pageContext?: PageContext | null,
): Promise<ChatResult> {
  loadKnowledge();
  const question = lastUserText(messages);
  if (!question) {
    return { reply: GREETING, mode, provider: config.provider };
  }
  if (isPageContextQuestion(question)) {
    return {
      reply: pageContextReply(question, pageContext),
      mode,
      provider: 'mock-context',
    };
  }
  if (shouldRefuseBusinessQuery(question)) {
    return { reply: refusalReply(), mode, provider: config.provider };
  }

  const hit = searchKnowledge(question);
  const softHits = hit ? [hit] : searchKnowledgeTop(question, 3);

  // 有 openai+key：即使知识库未命中也开放问答
  if (config.provider === 'openai' && config.apiKey) {
    try {
      const reply = await openaiReply(question, mode, softHits, config);
      return {
        reply,
        citations: softHits.length
          ? softHits.slice(0, 2).map((h) => ({ id: h.article.id, title: h.article.title }))
          : undefined,
        mode,
        provider: 'openai',
      };
    } catch {
      // 外呼失败回落 mock，保证预览可验收
    }
  }

  if (hit) {
    return {
      reply: formatArticle(hit.article, mode, false),
      citations: [{ id: hit.article.id, title: hit.article.title }],
      mode,
      provider: 'mock',
    };
  }

  // mock 无 key：开放路径，不再只丢三句推荐
  return softOpenReply(question, mode);
}

export function assistantMeta() {
  const config = readAiConfig();
  return {
    name: '赛德瑞克小助手',
    greeting: GREETING,
    suggested_groups: SUGGESTED_GROUPS,
    modes: [
      { id: 'quick', label: '快速回答' },
      { id: 'deep', label: '深度分析' },
    ],
    provider: config.provider,
    capabilities: {
      chat: true,
      business_query: false,
      write_documents: false,
    },
  };
}
