# AI-2 工厂助理 · 验收清单

## 范围

- AI 中心增加「工厂助理」卡片，独立页 `/ai/factory`
- `POST /api/ai/factory/ask`：规则意图路由 + 只读汇总（进度/钱/工资）
- 永不写业务单据；无权限 403 中文；写 `ai_action_log`
- 客服浮层可跳转工厂助理，问数不并进客服 chat

## 验收步骤

1. 登录后打开 `/ai/center`，可见「工厂助理」卡片并可进入。
2. 问「应收还有多少」→ 非空中文 + 库数字（空库可为 0）；问「怎么报工」→ 引导边界，不返回假工单数。
3. `node --import tsx --test apps/api/test/ai-factory.test.ts` 绿。
4. `node scripts/ai2-factory-smoke.mjs` 截图落 `docs/ai/shots/ai2-factory.png`。
5. 问答期除 `/api/ai/factory/ask`（及 session）外无业务写 POST。

## 不做

写单据、图表大屏、主动推送、AI-3～5、重建库改密码。
