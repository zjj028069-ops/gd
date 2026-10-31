# AI-3 AI 导入 BOM · 验收清单

## 范围

- AI 中心「AI 导入 BOM」卡片 → `/ai/bom`
- 物料清单页工具栏「AI 导入」入口
- `POST /api/ai/bom/parse|confirm|cancel`；可选 schemes
- 解析 v0：规则表头映射；有 key 可辅助；落库以预览为准
- confirm 写 `ai_action_log`（含 bom_id / bom_version_id）
- 不做 AI-4/5；不改客服/工厂助理；不重建库改密码

## 验收步骤

1. 登录后打开 `/ai/center`，可见「AI 导入 BOM」并进入。
2. 上传样例 csv/xlsx → 得预览行；确认前 `bom_definitions` count 不变。
3. 点确认后 BOM 增加；取消后 preview 失效，再 confirm 失败。
4. `node --import tsx --test apps/api/test/ai-bom.test.ts` 绿；AI-1/AI-2 测仍绿。
5. `node scripts/ai3-bom-smoke.mjs` 截图落 `docs/ai/shots/ai3-bom.png`。

## 测命令

```bash
cd /Users/allen/SEDRIC01-preview
node --import tsx --test apps/api/test/ai-bom.test.ts
node --import tsx --test apps/api/test/ai-assistant.test.ts apps/api/test/ai-factory.test.ts
npm run typecheck -w @gongdan/api
node scripts/ai3-bom-smoke.mjs
```
