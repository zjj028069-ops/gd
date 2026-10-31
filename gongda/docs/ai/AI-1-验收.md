# AI-1 智能客服 · 验收清单

## 范围

- 全站右下角可拖浮标「赛德瑞克小助手」
- 问候、两组推荐问题、快速/深度模式、输入、历史、新会话、收起
- mock FAQ；拒答业务查数；不写单据
- 菜单「AI 中心」→ 说明页 + 打开小助手

## 验收步骤

1. 登录后打开任意业务页（如调拨单 `/stock_allocate_bill/list`），可见浮标。
2. 点开有问候与推荐问；点推荐问得非空中文。
3. 切「深度分析」再问「如何报工」仍有回复。
4. `npm test -w @gongdan/api -- test/ai-assistant.test.ts` 绿；`npm run typecheck` 绿。
5. `node scripts/ai1-smoke.mjs` 截图落 `docs/ai/shots/ai1-chat.png`。
6. 冒烟期间网络无对业务写接口的 POST（除 `/api/ai/assistant/chat`）。

## 不做

AI-2～5；查工单数字；改开发账号密码；重建库。
