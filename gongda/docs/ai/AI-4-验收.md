# AI-4 极速下单 · 验收清单

## 范围

- AI 中心「极速下单」卡片 → `/ai/quick-order`
- 菜单：AI 中心 → 极速下单
- `POST /api/ai/quick-order/parse|confirm|cancel`；`GET /api/ai/quick-order/quota`
- 解析 v0：Excel/CSV 规则表头映射；图片/PDF 返回可编辑空壳+警告
- confirm 写加工单（默认）或销售单；写 `ai_action_log`；本地 `AI_QUOTA_*` 次数
- 前端二次确认按钮；确认前不落库
- 不做 AI-5；不改 AI-1～3；不重建库改密码

## 验收步骤

1. 登录后打开 `/ai/center`，可见「极速下单」并进入。
2. 上传样例 csv/xlsx → 得预览；确认前加工单/销售单 count 不变。
3. 二次确认后对应单据增加；取消后 preview 失效，再 confirm 失败。
4. `node --import tsx --test apps/api/test/ai-quick-order.test.ts` 绿；AI-1～3 测仍绿。
5. `node scripts/ai4-quick-order-smoke.mjs` 截图落 `docs/ai/shots/ai4-quick-order.png`。

## 测命令

```bash
cd /Users/allen/SEDRIC01-preview
node --import tsx --test apps/api/test/ai-quick-order.test.ts
node --import tsx --test apps/api/test/ai-assistant.test.ts apps/api/test/ai-factory.test.ts apps/api/test/ai-bom.test.ts
npm run typecheck -w @gongdan/api
npm run typecheck -w @gongdan/web
node scripts/ai4-quick-order-smoke.mjs
```

## 配置

- `AI_QUOTA_QUICK_ORDER_DAILY` 或 `AI_QUOTA_DAILY`（默认 50）
- `AI_QUOTA_DISABLED=1` 不限制次数
