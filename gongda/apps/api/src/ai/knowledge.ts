import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../config.js';

export type KbArticle = {
  id: string;
  title: string;
  body: string;
  keywords: string[];
};

export type KbHit = {
  article: KbArticle;
  score: number;
  tokenHits: number;
  titleHits: number;
};

const REFUSAL_HINT =
  '我是赛德瑞克小助手，主要解答产品用法。查询真实工单进度、应收应付或工资数字请到「AI 中心 → 工厂助理」提问；我这里不会查业务数据，也不会写单据。您可以问「如何报工」「如何创建销售订单」等操作问题。';

const REFUSAL_PATTERNS = [
  /工单.*(进度|到哪|完成了几|还差)/,
  /(查|看|问).*(进度|库存|余量|工资|发了多少|应收|应付)/,
  /(进度|库存|工资).*(多少|几|查|看)/,
  /这[单张].*(到哪|进度)/,
  /库存.*(有多少|还剩)/,
  /工资.*(发了|结算了|多少钱)/,
];

/** 明显与产品无关的闲聊/天气等 */
const OFFTOPIC_PATTERNS = [
  /天气|气温|下雨|下雪|台风|空气质量/,
  /讲个笑话|你是谁|聊[天天]|吃什么|几点了/,
  /股票|彩票|足球比分|星座运势/,
];

/** 置信命中：分数门槛 + 最少 token 命中，避免「扩展字段」误命中销售订单之类弱匹配 */
const MIN_SCORE = 0.18;
const MIN_TOKEN_HITS = 2;

export function shouldRefuseBusinessQuery(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  return REFUSAL_PATTERNS.some((re) => re.test(t));
}

export function isOffTopicQuestion(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  return OFFTOPIC_PATTERNS.some((re) => re.test(t));
}

export function refusalReply(): string {
  return REFUSAL_HINT;
}

export function offTopicReply(): string {
  return '我是赛德瑞克产品助手，答不了天气、闲聊这类问题。不过可以帮你看报工、销售订单、加工单、仓库、质检、打印模板等用法——直接问「如何报工」或打开推荐问题即可。';
}

function tokens(value: string) {
  const normalized = value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  const set = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) set.add(word);
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) set.add(run);
    for (let i = 0; i < run.length - 1; i += 1) set.add(run.slice(i, i + 2));
  }
  return set;
}

function parseArticle(filename: string, raw: string): KbArticle {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let title = filename.replace(/\.md$/i, '');
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (!title || title === filename.replace(/\.md$/i, '')) {
      const m = line.match(/^#\s+(.+)/);
      if (m) { title = m[1]!.trim(); continue; }
    }
    bodyLines.push(line);
  }
  const body = bodyLines.join('\n').trim();
  const keywords = [...tokens(`${title}\n${body}`)];
  return { id: filename, title, body, keywords };
}

let cache: KbArticle[] | null = null;

export function loadKnowledge(baseDir = join(projectRoot, 'docs/ai/kb')): KbArticle[] {
  if (cache) return cache;
  try {
    const files = readdirSync(baseDir).filter((name) => name.endsWith('.md')).sort();
    cache = files.map((name) => parseArticle(name, readFileSync(join(baseDir, name), 'utf8')));
  } catch {
    cache = [];
  }
  return cache;
}

/** 测试用：清空缓存以便换目录重载。 */
export function resetKnowledgeCache() {
  cache = null;
}

function scoreArticle(question: string, article: KbArticle): KbHit {
  const asked = tokens(question);
  const known = new Set(article.keywords);
  let tokenHits = 0;
  for (const token of asked) if (known.has(token)) tokenHits += 1;
  const titleHits = [...tokens(article.title)].filter((t) => asked.has(t)).length;
  const exact = article.title.replace(/\s+/g, '') === question.replace(/\s+/g, '') ? 1 : 0;
  const score = exact || (2 * tokenHits) / (asked.size + known.size) + titleHits * 0.08;
  return { article, score, tokenHits, titleHits };
}

/** 按相关度排序返回全部候选（含弱匹配），不做门槛过滤。 */
export function rankKnowledge(question: string, articles = loadKnowledge()): KbHit[] {
  const asked = tokens(question);
  if (!asked.size || !articles.length) return [];
  return articles
    .map((article) => scoreArticle(question, article))
    .sort((a, b) => b.score - a.score || b.tokenHits - a.tokenHits);
}

/**
 * 高置信检索：未达分数门槛或 token 命中不足视为未命中。
 * 标题强相关（titleHits>=2 且 score 尚可）也可放行。
 */
export function searchKnowledge(question: string, articles = loadKnowledge()): KbHit | null {
  const ranked = rankKnowledge(question, articles);
  const best = ranked[0];
  if (!best) return null;
  const confident =
    best.score >= MIN_SCORE &&
    (best.tokenHits >= MIN_TOKEN_HITS || best.titleHits >= 2 || best.score >= 0.45);
  return confident ? best : null;
}

/** 取前 N 篇相关文摘（可含弱匹配），用于开放回答参考。 */
export function searchKnowledgeTop(question: string, limit = 2, articles = loadKnowledge()): KbHit[] {
  return rankKnowledge(question, articles)
    .filter((h) => h.tokenHits >= 1 || h.titleHits >= 1 || h.score >= 0.05)
    .slice(0, Math.max(1, limit));
}

export const SUGGESTED_GROUPS: { title: string; questions: string[] }[] = [
  { title: '常用操作', questions: ['如何报工？', '如何创建销售订单？'] },
  { title: '生产与工资', questions: ['加工单怎么创建？', '报工后工资怎么看？'] },
  { title: '配置与质检', questions: ['打印模板怎么设置？', '扩展字段如何新增？', '质量检验怎么做？'] },
  { title: '查工厂数据', questions: ['去工厂助理问进度'] },
];

export const GREETING = '你好！我是赛德瑞克小助手。我可以帮你了解报工、销售订单、加工单、仓库、质检等产品用法。下面是一些推荐问题，也可以直接输入你的问题。';
