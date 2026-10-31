/** AI 模块配置：无 AI_API_KEY 时强制走 mock。 */
export type AiProvider = 'mock' | 'openai';

export type AiConfig = {
  provider: AiProvider;
  apiKey: string | null;
  openaiBase: string;
  openaiModel: string;
  /** 识图模型（DeepSeek-flash 等）；文本规划继续用 openaiModel */
  visionModel: string;
  /** 极速下单每日次数上限；0 或 AI_QUOTA_DISABLED=1 视为不限。 */
  quickOrderDailyLimit: number;
  quotaDisabled: boolean;
};

export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const raw = (env.AI_PROVIDER ?? 'mock').trim().toLowerCase();
  const apiKey = (env.AI_API_KEY ?? '').trim() || null;
  let provider: AiProvider = raw === 'openai' ? 'openai' : 'mock';
  if (provider === 'openai' && !apiKey) provider = 'mock';
  const quotaRaw = (env.AI_QUOTA_QUICK_ORDER_DAILY ?? env.AI_QUOTA_DAILY ?? '50').trim();
  const quickOrderDailyLimit = Math.max(0, Number.parseInt(quotaRaw, 10) || 50);
  const quotaDisabled = (env.AI_QUOTA_DISABLED ?? '').trim() === '1' || quickOrderDailyLimit <= 0;
  return {
    provider,
    apiKey,
    openaiBase: (env.AI_OPENAI_BASE ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    openaiModel: env.AI_OPENAI_MODEL ?? 'gpt-4o-mini',
    visionModel: (env.AI_VISION_MODEL ?? 'deepseek-flash').trim() || 'deepseek-flash',
    quickOrderDailyLimit: quotaDisabled ? 0 : quickOrderDailyLimit,
    quotaDisabled,
  };
}
